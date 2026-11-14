//! The store itself: schema versioning, transactions, key-value records, working sets, timelines, receipts and effect rows.

use neo_core::model::*;
use neo_core::ports::{MessageKind, OutboundMessage, ReplyStatus, Repositories};
use neo_store::{DropReason, Place, Settled, Store, StoreError, SCHEMA_VERSION};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

/// A directory under the system temp directory, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let unique = format!("neo-store-{name}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst));
        let path = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }
    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn trigger(id: &str, thread: &str, at: &str) -> Trigger {
    Trigger {
        id: id.into(),
        source: "chat".into(),
        threads: vec![ThreadRef { source: "chat".into(), id: thread.into() }],
        actor: ActorRef { source: "chat".into(), id: "web:local".into() },
        human: true,
        addressed: Some(Addressed::Direct),
        at: at.into(),
        text: format!("message {id}"),
        channel: None,
        url: None,
        meta: Json::new(),
    }
}

fn thread(id: &str) -> Thread {
    Thread {
        key: format!("chat:{id}"),
        reference: ThreadRef { source: "chat".into(), id: id.into() },
        created_at: "2026-01-01T00:00:00.000Z".into(),
        last_at: None,
        subscriptions: vec![],
        context: vec![],
        correlated: vec![],
        pending: vec![],
        evaluating: None,
        expired: None,
        meta: Json::new(),
    }
}

fn ticket(id: &str) -> Ticket {
    Ticket {
        id: id.into(),
        title: format!("Ticket {id}"),
        decision_id: "d".into(),
        mandate: Mandate {
            strength: Strength::Explicit,
            policy_version: "v1".into(),
            basis: MandateBasis::via(BasisVia::Addressed { addressed: Addressed::Direct }),
            actor: ActorRef { source: "chat".into(), id: "web:local".into() },
            scope: "small".into(),
        },
        channels: vec![],
        ended: None,
        attention: None,
        assignments: vec![],
        inputs: vec![],
        undelivered: vec![],
        answers: vec![],
        digest: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: "2026-01-01T00:00:00.000Z".into(),
        origin: Origin { trigger_id: "g".into(), trigger_ids: vec!["g".into()] },
        execution: None,
        delivery: None,
    }
}

fn assignment(state: AssignmentState) -> Assignment {
    Assignment {
        id: "a".into(),
        state,
        created_at: "t".into(),
        started_at: None,
        ended_at: None,
        ended_reason: None,
        report: None,
        delivered_at: None,
        idle_at: None,
    }
}

fn message(id: &str, ticket_id: Option<&str>, conversation: &str) -> OutboundMessage {
    OutboundMessage {
        id: id.into(),
        channel: ChannelRef { source: "chat".into(), thread: conversation.into(), address: Default::default() },
        text: format!("text {id}"),
        kind: MessageKind::Reply,
        ticket_id: ticket_id.map(str::to_string),
    }
}

// schema

#[test]
fn keeps_state_across_reopening_and_restricts_the_file() {
    let dir = TempDir::new("reopen");
    let path = dir.file("state/orchestrator.sqlite");
    {
        let store = Store::open(&path).unwrap();
        store.save_ticket(&ticket("t1"));
        store.set("master-id", &"orchestrator-1".to_string());
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.ticket("t1").map(|t| t.title), Some("Ticket t1".into()));
    assert_eq!(store.get::<String>("master-id").as_deref(), Some("orchestrator-1"));
    assert_eq!(store.get::<i64>("schema"), Some(SCHEMA_VERSION));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    }
}

#[test]
fn refuses_a_database_of_another_schema_version_and_leaves_it_untouched() {
    let dir = TempDir::new("schema");
    let path = dir.file("orchestrator.sqlite");
    {
        // What the TypeScript version left behind: schema 1.
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES ('schema', '1'); INSERT INTO kv VALUES ('master-id', '\"old\"')").unwrap();
    }
    let error = Store::open(&path).err().expect("an old database is refused");
    assert!(matches!(error, StoreError::Schema(1)));
    let text = error.to_string();
    assert!(text.contains("schema 1") && text.contains("not migrated") && text.contains("new empty data directory"), "{text}");
    let db = rusqlite::Connection::open(&path).unwrap();
    let tables: i64 = db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'", [], |row| row.get(0)).unwrap();
    assert_eq!(tables, 1);
}

// transactions

#[test]
fn rolls_back_a_nested_transaction_alone_and_everything_with_the_outer_one() {
    let store = Store::memory();
    let outcome: Result<(), &str> = store.atomic(|| {
        store.set("a", &1);
        let inner: Result<(), &str> = store.atomic(|| {
            store.set("b", &2);
            Err("inner failed")
        });
        assert_eq!(inner, Err("inner failed"));
        assert_eq!((store.get::<i64>("a"), store.get::<i64>("b")), (Some(1), None));
        Ok(())
    });
    assert_eq!(outcome, Ok(()));
    assert_eq!((store.get::<i64>("a"), store.get::<i64>("b")), (Some(1), None));
    let failed: Result<(), &str> = store.atomic(|| {
        store.set("a", &10);
        let _: Result<(), &str> = store.atomic(|| {
            store.set("c", &3);
            Ok(())
        });
        Err("outer failed")
    });
    assert_eq!(failed, Err("outer failed"));
    assert_eq!((store.get::<i64>("a"), store.get::<i64>("c")), (Some(1), None));
}

#[test]
fn rolls_back_when_the_work_panics_and_stays_usable() {
    let store = Arc::new(Store::memory());
    let inside = store.clone();
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _: Result<(), ()> = inside.atomic(|| {
            inside.set("a", &1);
            panic!("boom");
        });
    }));
    assert!(panicked.is_err());
    assert_eq!(store.get::<i64>("a"), None);
    store.set("a", &2);
    assert_eq!(store.get::<i64>("a"), Some(2));
}

#[test]
fn runs_post_commit_actions_only_after_the_outermost_commit_and_never_after_a_rollback() {
    let store = Store::memory();
    let ran = Arc::new(AtomicUsize::new(0));
    let bump = |by: usize| {
        let ran = ran.clone();
        move || {
            ran.fetch_add(by, Ordering::SeqCst);
        }
    };
    store.after_commit(bump(1));
    assert_eq!(ran.load(Ordering::SeqCst), 1);
    let _: Result<(), ()> = store.atomic(|| {
        store.after_commit(bump(10));
        let _: Result<(), ()> = store.atomic(|| {
            store.after_commit(bump(100));
            Ok(())
        });
        let _: Result<(), ()> = store.atomic(|| {
            store.after_commit(bump(1000));
            Err(())
        });
        assert_eq!(ran.load(Ordering::SeqCst), 1);
        Ok(())
    });
    assert_eq!(ran.load(Ordering::SeqCst), 111);
    let _: Result<(), ()> = store.atomic(|| {
        store.after_commit(bump(10_000));
        Err(())
    });
    assert_eq!(ran.load(Ordering::SeqCst), 111);
}

#[test]
fn keeps_other_threads_out_of_a_transaction_until_it_ends() {
    let store = Arc::new(Store::memory());
    let (started, wait_started) = mpsc::channel();
    let (finish, wait_finish) = mpsc::channel::<()>();
    let owner = store.clone();
    let transaction = std::thread::spawn(move || {
        let _: Result<(), ()> = owner.atomic(|| {
            owner.set("draft", &1);
            started.send(()).unwrap();
            wait_finish.recv().unwrap();
            Err(())
        });
    });
    wait_started.recv().unwrap();
    let (wrote, wait_wrote) = mpsc::channel();
    let other = store.clone();
    let writer = std::thread::spawn(move || {
        // Neither sees the uncommitted draft nor joins the transaction that is about to roll back.
        let seen = other.get::<i64>("draft");
        other.set("kept", &2);
        wrote.send(seen).unwrap();
    });
    assert!(wait_wrote.recv_timeout(Duration::from_millis(150)).is_err(), "the other thread waits for the transaction");
    finish.send(()).unwrap();
    assert_eq!(wait_wrote.recv_timeout(Duration::from_secs(5)).unwrap(), None);
    transaction.join().unwrap();
    writer.join().unwrap();
    assert_eq!((store.get::<i64>("draft"), store.get::<i64>("kept")), (None, Some(2)));
}

// key-value records

#[test]
fn reads_writes_deletes_and_lists_typed_records_by_prefix() {
    let store = Store::memory();
    assert_eq!(store.get::<String>("missing"), None);
    store.set("session-file:worker-1", &"a.jsonl".to_string());
    store.set("session-file:worker-2", &"b.jsonl".to_string());
    store.set("session-file_other", &"c".to_string());
    store.set("session-file:worker-1", &"a2.jsonl".to_string());
    assert_eq!(store.get::<String>("session-file:worker-1").as_deref(), Some("a2.jsonl"));
    assert_eq!(store.keys("session-file:"), vec!["session-file:worker-1", "session-file:worker-2"]);
    // LIKE wildcards in a prefix match themselves only.
    store.set("a%b:1", &1);
    store.set("axb:1", &1);
    assert_eq!(store.keys("a%b:"), vec!["a%b:1"]);
    store.delete("session-file:worker-2");
    assert_eq!(store.keys("session-file:"), vec!["session-file:worker-1"]);
}

// working sets

#[test]
fn lists_open_and_active_tickets_newest_first_from_their_stored_state() {
    let store = Store::memory();
    let mut idle = ticket("idle");
    idle.assignments = vec![assignment(AssignmentState::Ended)];
    let mut running = ticket("running");
    running.assignments = vec![assignment(AssignmentState::Ended), assignment(AssignmentState::Running)];
    let mut waiting = ticket("waiting");
    waiting.ended = Some(Ended { at: "t".into(), by: TicketEndBy::Executor, outcome: TicketOutcome::Completed, reason: None });
    waiting.undelivered = vec!["i1".into()];
    let mut over = ticket("over");
    over.ended = Some(Ended { at: "t".into(), by: TicketEndBy::Human, outcome: TicketOutcome::Stopped, reason: None });
    over.assignments = vec![assignment(AssignmentState::Ended)];
    for each in [&idle, &running, &waiting, &over] {
        store.save_ticket(each);
    }
    let names = |tickets: Vec<Ticket>| tickets.into_iter().map(|t| t.id).collect::<Vec<_>>();
    assert_eq!(names(store.tickets()), vec!["over", "waiting", "running", "idle"]);
    assert_eq!(names(store.open_tickets()), vec!["running", "idle"]);
    assert_eq!(names(store.active_tickets()), vec!["waiting", "running"]);
    // Saving again keeps a ticket's place and moves it between sets.
    running.assignments[1].state = AssignmentState::Ended;
    store.save_ticket(&running);
    assert_eq!(names(store.active_tickets()), vec!["waiting"]);
    assert_eq!(names(store.tickets()), vec!["over", "waiting", "running", "idle"]);
}

#[test]
fn lists_active_and_subscribed_threads_and_patches_their_metadata() {
    let store = Store::memory();
    let quiet = thread("quiet");
    let mut queued = thread("queued");
    queued.pending = vec!["g1".into()];
    let mut followed = thread("followed");
    followed.subscriptions = vec!["t1".into()];
    for each in [&quiet, &queued, &followed] {
        store.save_thread(each);
    }
    let keys = |threads: Vec<Thread>| threads.into_iter().map(|t| t.key).collect::<Vec<_>>();
    assert_eq!(keys(store.threads()), vec!["chat:quiet", "chat:queued", "chat:followed"]);
    assert_eq!(keys(store.active_threads()), vec!["chat:queued"]);
    assert_eq!(keys(store.subscribed_threads(None)), vec!["chat:followed"]);
    assert_eq!(keys(store.subscribed_threads(Some("chat"))), vec!["chat:followed"]);
    assert!(store.subscribed_threads(Some("other")).is_empty());
    store.patch_thread_meta("chat:quiet", &[("label", Some("Quiet".into())), ("gone", None)]);
    assert_eq!(store.thread("chat:quiet").unwrap().meta.get("label"), Some(&"Quiet".into()));
    store.patch_thread_meta("chat:quiet", &[("label", None)]);
    assert!(store.thread("chat:quiet").unwrap().meta.is_empty());
    store.patch_thread_meta("chat:missing", &[("label", Some("x".into()))]);
    assert!(store.thread("chat:missing").is_none());
}

// timelines

#[test]
fn pages_a_threads_triggers_by_time_then_id_and_finds_neighbours() {
    let store = Store::memory();
    let at = |second: u32| format!("2026-01-01T00:00:{second:02}.000Z");
    for (id, second) in [("c", 3), ("a", 1), ("b2", 2), ("b1", 2), ("d", 4)] {
        store.save_trigger(&trigger(id, "t1", &at(second)));
    }
    let mut robot = trigger("robot", "t1", &at(0));
    robot.human = false;
    store.save_trigger(&robot);
    store.save_trigger(&trigger("x", "other", &at(9)));
    let ids = |triggers: Vec<Trigger>| triggers.into_iter().map(|t| t.id).collect::<Vec<_>>();
    assert_eq!(ids(store.thread_triggers("chat:t1", 50, None, false)), vec!["robot", "a", "b1", "b2", "c", "d"]);
    assert_eq!(ids(store.thread_triggers("chat:t1", 2, None, false)), vec!["c", "d"]);
    let place = Place { at: at(2), id: "b2".into() };
    assert_eq!(ids(store.thread_triggers("chat:t1", 50, Some(&place), false)), vec!["robot", "a", "b1"]);
    assert_eq!(ids(store.thread_triggers("chat:t1", 2, Some(&place), true)), vec!["b1", "b2"]);
    let (before, after) = store.neighbours("chat:t1", &place);
    assert_eq!((before.map(|t| t.id), after.map(|t| t.id)), (Some("b1".into()), Some("c".into())));
    let (first_before, _) = store.neighbours("chat:t1", &Place { at: at(0), id: "robot".into() });
    assert!(first_before.is_none());
    assert_eq!(store.first_trigger("chat:t1", false).map(|t| t.id), Some("robot".into()));
    assert_eq!(store.first_trigger("chat:t1", true).map(|t| t.id), Some("a".into()));
    // Newest first, by arrival for equal times.
    assert_eq!(ids(store.thread_page("chat:t1", 0, 3)), vec!["d", "c", "b1"]);
    assert_eq!(ids(store.thread_page("chat:t1", 3, 3)), vec!["b2", "a", "robot"]);
    assert_eq!(ids(store.recent_triggers(0, 2)), vec!["x", "robot"]);
}

#[test]
fn reindexes_a_trigger_saved_again_and_searches_by_id_message_id_and_text() {
    let store = Store::memory();
    let mut moved = trigger("g1", "t1", "2026-01-01T00:00:01.000Z");
    moved.text = "Fix the 100% broken_link".into();
    moved.meta.insert("messageId".into(), "web:abc".into());
    store.save_trigger(&moved);
    moved.threads = vec![ThreadRef { source: "chat".into(), id: "t2".into() }];
    store.save_trigger(&moved);
    assert!(store.thread_triggers("chat:t1", 10, None, false).is_empty());
    assert_eq!(store.thread_triggers("chat:t2", 10, None, false).len(), 1);
    store.save_trigger(&trigger("g2", "t1", "2026-01-01T00:00:02.000Z"));
    let found = |query: &str| store.search_triggers(query, 10).into_iter().map(|t| t.id).collect::<Vec<_>>();
    assert_eq!(found("g1"), vec!["g1"]);
    assert_eq!(found("web:abc"), vec!["g1"]);
    assert_eq!(found("message"), vec!["g2"]);
    // Wildcards in the query are literal.
    assert_eq!(found("100%"), vec!["g1"]);
    assert_eq!(found("broken_link"), vec!["g1"]);
    assert!(found("brokenXlink").is_empty() && found("%").len() == 1);
}

#[test]
fn stores_decisions_by_thread_in_order_and_filters_them_by_kind() {
    let store = Store::memory();
    let decision = |id: &str, thread: &str, kind: DecisionKind| Decision {
        id: id.into(),
        eval_id: format!("e-{id}"),
        thread_key: thread.into(),
        trigger_ids: vec![],
        policy_version: "v1".into(),
        at: "t".into(),
        kind,
        reason: vec![],
        strength: Strength::Explicit,
        ticket_id: None,
        mandate: None,
        audit: None,
        dismissed: false,
    };
    store.save_decision(&decision("d1", "chat:a", DecisionKind::Ignore));
    store.save_decision(&decision("d2", "chat:b", DecisionKind::Unavailable));
    store.save_decision(&decision("d3", "chat:a", DecisionKind::Accept));
    let ids = |decisions: Vec<Decision>| decisions.into_iter().map(|d| d.id).collect::<Vec<_>>();
    assert_eq!(ids(store.decisions_by_thread("chat:a")), vec!["d1", "d3"]);
    assert_eq!(ids(store.recent_decisions(0, 2)), vec!["d3", "d2"]);
    assert_eq!(ids(store.decisions_of_kinds(&["unavailable", "accept"], 10)), vec!["d3", "d2"]);
    assert!(store.decisions_of_kinds(&["stop"], 10).is_empty());
}

// receipts

#[test]
fn records_a_message_once_and_settles_or_withdraws_it() {
    let store = Store::memory();
    let first = message("m1", Some("t1"), "c1");
    assert!(store.add_receipt(&first));
    let mut again = first.clone();
    again.text = "another text".into();
    assert!(!store.add_receipt(&again));
    let receipt = store.receipt("m1").unwrap();
    assert_eq!((receipt.message.text.as_str(), receipt.status), ("text m1", ReplyStatus::Pending));
    assert!(receipt.queued_at.is_some());
    assert_eq!(store.waiting_receipts().len(), 1);
    store.settle_receipt(&first, Settled::Sent);
    assert_eq!(store.reply_status("m1"), Some(ReplyStatus::Sent));
    assert!(!store.withdraw_receipt("m1"), "a message that went out cannot be withdrawn");
    assert!(store.waiting_receipts().is_empty());
    // A message withdrawn while it was being sent still leaves a receipt, so its id is never queued again.
    let racing = message("m2", Some("t1"), "c1");
    store.add_receipt(&racing);
    assert!(store.withdraw_receipt("m2"));
    assert_eq!(store.reply_status("m2"), None);
    store.settle_receipt(&racing, Settled::Sent);
    assert_eq!(store.reply_status("m2"), Some(ReplyStatus::Sent));
    assert!(!store.add_receipt(&racing));
}

#[test]
fn records_dropped_messages_with_their_reason() {
    let store = Store::memory();
    for id in ["m1", "m2"] {
        store.add_receipt(&message(id, None, "c1"));
    }
    store.settle_receipt(&message("m1", None, "c1"), Settled::Dropped(DropReason::ChannelGone));
    let dropped = store.receipt("m1").unwrap();
    assert_eq!(dropped.status, ReplyStatus::Dropped);
    assert_eq!(dropped.dropped.as_ref().map(|d| d.reason), Some(DropReason::ChannelGone));
    assert_eq!(store.dropped_replies(10).into_iter().map(|r| r.message.id).collect::<Vec<_>>(), vec!["m1"]);
    assert_eq!(store.dropped_since("2000-01-01T00:00:00.000Z"), 1);
    assert_eq!(store.dropped_since("2999-01-01T00:00:00.000Z"), 0);
    let stored = serde_json::to_value(&dropped).unwrap();
    assert_eq!(stored["dropped"]["reason"], "channelGone");
}

#[test]
fn holds_a_tickets_later_message_to_a_conversation_behind_an_earlier_one_until_it_keeps_failing() {
    let store = Store::memory();
    store.add_receipt(&message("m1", Some("t1"), "c1"));
    store.add_receipt(&message("m2", Some("t1"), "c1"));
    store.add_receipt(&message("other-conversation", Some("t1"), "c2"));
    store.add_receipt(&message("other-ticket", Some("t2"), "c1"));
    store.add_receipt(&message("no-ticket", None, "c1"));
    assert!(!store.receipt_behind("m1", 3));
    assert!(store.receipt_behind("m2", 3));
    for free in ["other-conversation", "other-ticket", "no-ticket"] {
        assert!(!store.receipt_behind(free, 3), "{free} waits behind nothing");
    }
    // Once the earlier one failed three times in a row, the later one goes ahead.
    store.effect_enqueue("reply", "m1", "{}", 1, 0);
    let row = store.effect_head("reply").unwrap();
    for attempt in 0..3 {
        assert!(store.receipt_behind("m2", 3), "after {attempt} failures");
        store.effect_failed("reply", &row, "offline", 0);
    }
    assert!(!store.receipt_behind("m2", 3));
    let failing = store.failing_replies();
    assert_eq!(failing.len(), 1);
    assert_eq!((failing[0].receipt.message.id.as_str(), failing[0].attempts, failing[0].error.as_str()), ("m1", 3, "offline"));
    // Or once it went out.
    store.settle_receipt(&message("m1", Some("t1"), "c1"), Settled::Sent);
    assert!(!store.receipt_behind("m2", 1_000));
}

#[test]
fn tells_whether_a_ticket_was_replied_to_since_a_time() {
    let store = Store::memory();
    assert!(!store.replied_since("t1", "2000-01-01T00:00:00.000Z"));
    let mut ack = message("ack", Some("t1"), "c1");
    ack.kind = MessageKind::Acknowledgement;
    store.add_receipt(&ack);
    assert!(!store.replied_since("t1", "2000-01-01T00:00:00.000Z"), "an acknowledgement is not a reply");
    store.add_receipt(&message("m1", Some("t1"), "c1"));
    assert!(store.replied_since("t1", "2000-01-01T00:00:00.000Z"));
    assert!(!store.replied_since("t1", "2999-01-01T00:00:00.000Z"));
    assert!(!store.replied_since("t2", "2000-01-01T00:00:00.000Z"));
}

// effect rows

#[test]
fn coalesces_an_effect_queued_again_keeping_its_place_and_starting_over() {
    let store = Store::memory();
    assert_eq!(store.effect_max_seq(), 0);
    store.effect_enqueue("delivery", "t1", r#"{"n":1}"#, 1, 1_000);
    store.effect_enqueue("delivery", "t2", r#"{"n":2}"#, 2, 1_000);
    let first = store.effect_head("delivery").unwrap();
    store.effect_failed("delivery", &first, "busy", 5_000);
    assert_eq!(store.effect_attempts("delivery", "t1"), Some(1));
    store.effect_enqueue("delivery", "t1", r#"{"n":3}"#, 3, 2_000);
    let replaced = store.effect_head("delivery").unwrap();
    assert_eq!(
        (replaced.key.as_str(), replaced.value.as_str(), replaced.seq, replaced.generation, replaced.attempts, replaced.due),
        ("t1", r#"{"n":3}"#, 1, 1, 0, 2_000)
    );
    assert_eq!(store.effect_max_seq(), 2);
    // The attempt that ran the old payload does not delete or change the new one.
    store.effect_done("delivery", &first);
    store.effect_failed("delivery", &first, "late", 9_000);
    store.effect_later("delivery", &first, 9_000);
    assert_eq!(store.effect_head("delivery"), Some(replaced.clone()));
    store.effect_done("delivery", &replaced);
    assert_eq!(store.effect_head("delivery").map(|row| row.key), Some("t2".into()));
}

#[test]
fn selects_due_rows_in_queue_order_and_reschedules_them() {
    let store = Store::memory();
    for (seq, key) in [(1, "a"), (2, "b"), (3, "c")] {
        store.effect_enqueue("launch", key, "{}", seq, 1_000);
    }
    store.effect_enqueue("relay", "r", "{}", 4, 1_000);
    let keys = |rows: Vec<neo_store::effects::EffectRow>| rows.into_iter().map(|row| row.key).collect::<Vec<_>>();
    assert!(store.effect_due("launch", 999, 16).is_empty());
    assert_eq!(keys(store.effect_due("launch", 1_000, 16)), vec!["a", "b", "c"]);
    assert_eq!(keys(store.effect_due("launch", 1_000, 2)), vec!["a", "b"]);
    let a = store.effect_head("launch").unwrap();
    store.effect_later("launch", &a, 3_000);
    assert_eq!(keys(store.effect_due("launch", 1_000, 16)), vec!["b", "c"]);
    // An ordered kind still waits behind its oldest row, due or not.
    assert_eq!(store.effect_head("launch").map(|row| (row.key, row.attempts, row.due)), Some(("a".into(), 0, 3_000)));
    assert!(store.effect_pending("launch", None) && store.effect_pending("launch", Some("b")) && !store.effect_pending("launch", Some("z")));
    store.effect_cancel("launch", "b");
    assert!(!store.effect_pending("launch", Some("b")));
    assert!(!store.effect_pending("sidecar", None));
}

#[test]
fn summarizes_a_kinds_queue_for_its_health() {
    let store = Store::memory();
    let empty = store.effect_summary("reply");
    assert_eq!((empty.waiting, empty.since, empty.attempts, empty.error), (0, None, 0, None));
    store.effect_enqueue("reply", "m1", "{}", 1, 1_767_225_600_000);
    store.effect_enqueue("reply", "m2", "{}", 2, 1_767_225_660_000);
    let row = store.effect_head("reply").unwrap();
    store.effect_failed("reply", &row, &"x".repeat(2_000), 0);
    store.effect_failed("reply", &row, "the channel is offline", 0);
    let summary = store.effect_summary("reply");
    assert_eq!((summary.waiting, summary.attempts), (2, 2));
    assert_eq!(summary.since.as_deref(), Some("2026-01-01T00:00:00.000Z"));
    assert_eq!(summary.error.as_deref(), Some("the channel is offline"));
}

#[test]
fn queues_an_effect_and_its_state_change_together_or_not_at_all() {
    let store = Store::memory();
    let failed: Result<(), ()> = store.atomic(|| {
        store.save_ticket(&ticket("t1"));
        store.add_receipt(&message("m1", Some("t1"), "c1"));
        store.effect_enqueue("reply", "m1", "{}", 1, 0);
        Err(())
    });
    assert!(failed.is_err());
    assert!(store.ticket("t1").is_none() && store.receipt("m1").is_none() && !store.effect_pending("reply", None));
}
