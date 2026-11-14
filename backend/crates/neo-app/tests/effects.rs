//! The effect queue's dispatcher and the Outbox built on it.

use neo_app::effects::{Effects, Failure, Handler, Options, DELIVERY, LAUNCH, RELAY, REPLY};
use neo_app::health::HealthBoard;
use neo_app::outbox::{Channels, Outbox, Sent};
use neo_core::model::ChannelRef;
use neo_core::ports::{MessageKind, OutboundMessage, Outbox as OutboxPort, ReplyStatus};
use neo_store::{DropReason, Store};
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

struct Fixture {
    store: Arc<Store>,
    board: HealthBoard,
    clock: Arc<AtomicI64>,
    effects: Arc<Effects>,
}

fn fixture() -> Fixture {
    let store = Arc::new(Store::memory());
    let board = HealthBoard::new();
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let now = clock.clone();
    let effects = Effects::with_clock(store.clone(), board.clone(), Arc::new(move || now.load(Ordering::SeqCst)));
    Fixture { store, board, clock, effects }
}

impl Fixture {
    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }
    fn health(&self, kind: &str) -> (String, String) {
        let health = self.board.get(&format!("effects:{kind}")).expect("the kind reports its health");
        (health.state.to_string(), health.detail)
    }
}

/// A handler that records what it ran and fails as the test scripts.
#[derive(Default)]
struct Recorder {
    ran: Mutex<Vec<(String, Value)>>,
    outcomes: Mutex<Vec<Result<(), Failure>>>,
}

impl Recorder {
    fn handler(self: &Arc<Self>) -> Handler {
        let recorder = self.clone();
        Arc::new(move |payload, key| {
            let recorder = recorder.clone();
            Box::pin(async move {
                recorder.ran.lock().unwrap().push((key, payload));
                let mut outcomes = recorder.outcomes.lock().unwrap();
                if outcomes.is_empty() {
                    Ok(())
                } else {
                    outcomes.remove(0)
                }
            })
        })
    }
    fn keys(&self) -> Vec<String> {
        self.ran.lock().unwrap().iter().map(|(key, _)| key.clone()).collect()
    }
    fn fail(&self, outcomes: Vec<Result<(), Failure>>) {
        *self.outcomes.lock().unwrap() = outcomes;
    }
}

#[tokio::test]
async fn runs_a_queued_effect_once_after_start_and_removes_it() {
    let f = fixture();
    let recorder = Arc::new(Recorder::default());
    f.effects.handle(RELAY, recorder.handler(), Options::default());
    f.effects.enqueue(RELAY, "r1", &json!({"text": "hello"}));
    // Nothing runs before start, such as while setup is incomplete.
    f.effects.idle(None).await;
    assert!(recorder.keys().is_empty() && f.effects.pending(RELAY, Some("r1")));
    f.effects.start();
    f.effects.idle(Some(RELAY)).await;
    assert_eq!(*recorder.ran.lock().unwrap(), vec![("r1".to_string(), json!({"text": "hello"}))]);
    assert!(!f.effects.pending(RELAY, None));
    assert_eq!(f.health(RELAY), ("ready".into(), "Nothing waiting".into()));
    f.effects.idle(None).await;
    assert_eq!(recorder.keys().len(), 1);
}

#[tokio::test]
async fn queues_an_effect_with_its_transaction_or_not_at_all() {
    let f = fixture();
    let recorder = Arc::new(Recorder::default());
    f.effects.handle(RELAY, recorder.handler(), Options::default());
    f.effects.start();
    let failed: Result<(), ()> = f.store.atomic(|| {
        f.effects.enqueue(RELAY, "rolled-back", &json!({}));
        Err(())
    });
    assert!(failed.is_err());
    let committed: Result<(), ()> = f.store.atomic(|| {
        f.effects.enqueue(RELAY, "kept", &json!({}));
        Ok(())
    });
    assert!(committed.is_ok());
    f.effects.idle(None).await;
    assert_eq!(recorder.keys(), vec!["kept"]);
}

#[tokio::test]
async fn retries_a_failure_with_growing_delays_and_reports_the_kind_failing_after_three() {
    let f = fixture();
    let recorder = Arc::new(Recorder::default());
    recorder.fail((0..5).map(|n| Err(Failure::Error(format!("offline {n}")))).collect());
    f.effects.handle(DELIVERY, recorder.handler(), Options { retry: (1_000, 3_000), ..Options::default() });
    f.effects.start();
    f.effects.enqueue(DELIVERY, "t1", &json!({}));
    f.effects.idle(None).await;
    assert_eq!(recorder.keys().len(), 1);
    // Not due again yet.
    f.advance(999);
    f.effects.idle(None).await;
    assert_eq!(recorder.keys().len(), 1);
    // 1 s, then 2 s, then capped at 3 s.
    for (wait, attempts) in [(1, 2), (2_000, 3), (2_999, 3), (1, 4)] {
        f.advance(wait);
        f.effects.idle(None).await;
        assert_eq!(recorder.keys().len(), attempts, "after waiting {wait} ms more");
    }
    let (state, detail) = f.health(DELIVERY);
    assert_eq!(state, "error");
    assert!(detail.starts_with("1 waiting since ") && detail.ends_with("the last failure: offline 3"), "{detail}");
    assert_eq!(f.store.effect_attempts(DELIVERY, "t1"), Some(4));
    // Queued again, it starts over at once and its success clears the failure.
    recorder.fail(vec![]);
    f.effects.enqueue(DELIVERY, "t1", &json!({"again": true}));
    f.effects.idle(None).await;
    assert_eq!(recorder.ran.lock().unwrap().last().unwrap().1, json!({"again": true}));
    assert_eq!(f.health(DELIVERY).0, "ready");
    assert!(!f.effects.pending(DELIVERY, None));
}

#[tokio::test]
async fn reschedules_an_effect_that_cannot_run_now_without_counting_a_failure() {
    let f = fixture();
    let recorder = Arc::new(Recorder::default());
    recorder.fail((0..10).map(|_| Err(Failure::Later("every worker slot is taken".into()))).collect());
    f.effects.handle(LAUNCH, recorder.handler(), Options { retry: (1_000, 60_000), quiet: true, ..Options::default() });
    f.effects.start();
    f.effects.enqueue(LAUNCH, "a1", &json!({}));
    for round in 1..=6 {
        f.effects.idle(None).await;
        assert_eq!(recorder.keys().len(), round);
        // Always the initial delay: waiting is not failing.
        f.advance(1_000);
    }
    assert_eq!(f.store.effect_attempts(LAUNCH, "a1"), Some(0));
    assert_eq!(f.health(LAUNCH).0, "ready");
}

#[tokio::test]
async fn keeps_a_quiet_kind_ready_however_often_it_fails() {
    let f = fixture();
    let recorder = Arc::new(Recorder::default());
    recorder.fail((0..5).map(|_| Err(Failure::Error("the ticket shows this".into()))).collect());
    f.effects.handle(DELIVERY, recorder.handler(), Options { retry: (10, 10), quiet: true, ..Options::default() });
    f.effects.start();
    f.effects.enqueue(DELIVERY, "t1", &json!({}));
    for _ in 0..4 {
        f.effects.idle(None).await;
        f.advance(10);
    }
    assert_eq!(f.store.effect_attempts(DELIVERY, "t1"), Some(4));
    assert_eq!(f.health(DELIVERY).0, "ready");
}

/// A handler whose effects wait until the test lets them finish.
struct Gate {
    entered: AtomicUsize,
    most: AtomicUsize,
    active: AtomicUsize,
    open: Notify,
    started: Mutex<Vec<String>>,
}

fn gated() -> (Arc<Gate>, Handler) {
    let gate = Arc::new(Gate {
        entered: AtomicUsize::new(0),
        most: AtomicUsize::new(0),
        active: AtomicUsize::new(0),
        open: Notify::new(),
        started: Mutex::new(Vec::new()),
    });
    let inside = gate.clone();
    let handler: Handler = Arc::new(move |_, key| {
        let gate = inside.clone();
        Box::pin(async move {
            gate.started.lock().unwrap().push(key);
            gate.entered.fetch_add(1, Ordering::SeqCst);
            let active = gate.active.fetch_add(1, Ordering::SeqCst) + 1;
            gate.most.fetch_max(active, Ordering::SeqCst);
            gate.open.notified().await;
            gate.active.fetch_sub(1, Ordering::SeqCst);
            Ok(())
        })
    });
    (gate, handler)
}

async fn until(what: &str, condition: impl Fn() -> bool) {
    for _ in 0..500 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting until {what}");
}

#[tokio::test]
async fn runs_as_many_at_once_as_the_kind_allows_and_holds_it_at_zero() {
    let f = fixture();
    let (gate, handler) = gated();
    let limit = Arc::new(AtomicUsize::new(0));
    let allowed = limit.clone();
    f.effects.handle(LAUNCH, handler, Options { limit: Arc::new(move || allowed.load(Ordering::SeqCst)), ..Options::default() });
    f.effects.start();
    for key in ["a", "b", "c", "d"] {
        f.effects.enqueue(LAUNCH, key, &json!({}));
    }
    // Held, such as while processing is paused: idle resolves because nothing can start.
    f.effects.idle(None).await;
    assert_eq!(gate.entered.load(Ordering::SeqCst), 0);
    limit.store(2, Ordering::SeqCst);
    f.effects.kick();
    until("two run", || gate.entered.load(Ordering::SeqCst) == 2).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(*gate.started.lock().unwrap(), vec!["a", "b"]);
    // Each one that finishes makes room for the next, in queue order.
    gate.open.notify_one();
    until("a third runs", || gate.entered.load(Ordering::SeqCst) == 3).await;
    for _ in 0..3 {
        gate.open.notify_one();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    f.effects.idle(None).await;
    assert_eq!(*gate.started.lock().unwrap(), vec!["a", "b", "c", "d"]);
    assert_eq!(gate.most.load(Ordering::SeqCst), 2);
    assert!(!f.effects.pending(LAUNCH, None));
}

#[tokio::test]
async fn runs_an_ordered_kind_one_at_a_time_behind_its_oldest_row() {
    let f = fixture();
    let recorder = Arc::new(Recorder::default());
    recorder.fail(vec![Err(Failure::Error("the first fails".into()))]);
    f.effects.handle(RELAY, recorder.handler(), Options { ordered: true, limit: Arc::new(|| 8), retry: (1_000, 1_000), ..Options::default() });
    f.effects.start();
    for key in ["r1", "r2", "r3"] {
        f.effects.enqueue(RELAY, key, &json!({}));
    }
    f.effects.idle(None).await;
    // The failed head holds the later rows back until it is due and succeeds.
    assert_eq!(recorder.keys(), vec!["r1"]);
    f.advance(1_000);
    f.effects.idle(None).await;
    assert_eq!(recorder.keys(), vec!["r1", "r1", "r2", "r3"]);
}

#[tokio::test]
async fn drops_a_cancelled_effect_and_leaves_the_rest_for_the_next_start_when_drained() {
    let f = fixture();
    let (gate, handler) = gated();
    f.effects.handle(LAUNCH, handler, Options::default());
    f.effects.start();
    for key in ["a", "b", "c"] {
        f.effects.enqueue(LAUNCH, key, &json!({}));
    }
    until("the first runs", || gate.entered.load(Ordering::SeqCst) == 1).await;
    f.effects.cancel(LAUNCH, "b");
    let draining = {
        let effects = f.effects.clone();
        tokio::spawn(async move { effects.drain().await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!draining.is_finished(), "drain waits for the running effect");
    gate.open.notify_one();
    draining.await.unwrap();
    // Nothing new started; what waited is still queued.
    assert_eq!(*gate.started.lock().unwrap(), vec!["a"]);
    assert!(f.effects.pending(LAUNCH, Some("c")) && !f.effects.pending(LAUNCH, Some("b")) && !f.effects.pending(LAUNCH, Some("a")));
    // A new queue over the same store, as after a restart, continues after the highest position given out.
    let again = Effects::new(f.store.clone(), f.board.clone());
    let recorder = Arc::new(Recorder::default());
    again.handle(LAUNCH, recorder.handler(), Options::default());
    again.enqueue(LAUNCH, "d", &json!({}));
    again.start();
    again.idle(None).await;
    assert_eq!(recorder.keys(), vec!["c", "d"]);
}

#[tokio::test]
async fn counts_a_handler_that_panics_as_a_failure() {
    let f = fixture();
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    f.effects.handle(
        RELAY,
        Arc::new(move |_, _| {
            let calls = counted.clone();
            Box::pin(async move {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    panic!("boom");
                }
                Ok(())
            })
        }),
        Options { retry: (10, 10), ..Options::default() },
    );
    f.effects.start();
    f.effects.enqueue(RELAY, "r1", &json!({}));
    f.effects.idle(None).await;
    assert_eq!(f.store.effect_attempts(RELAY, "r1"), Some(1));
    f.advance(10);
    f.effects.idle(None).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(!f.effects.pending(RELAY, None));
}

// the Outbox

#[derive(Default)]
struct FakeChannels {
    off: AtomicBool,
    ignored: AtomicBool,
    results: Mutex<Vec<Result<Sent, String>>>,
    /// How many more sends of a message id fail.
    failing: Mutex<std::collections::HashMap<String, usize>>,
    sent: Mutex<Vec<String>>,
}

impl Channels for FakeChannels {
    fn enabled(&self, _source: &str) -> bool {
        !self.off.load(Ordering::SeqCst)
    }
    fn allowed(&self, _channel: &ChannelRef) -> bool {
        !self.ignored.load(Ordering::SeqCst)
    }
    fn send(&self, message: OutboundMessage) -> Pin<Box<dyn Future<Output = Result<Sent, String>> + Send + '_>> {
        Box::pin(async move {
            if let Some(left) = self.failing.lock().unwrap().get_mut(&message.id).filter(|left| **left > 0) {
                *left -= 1;
                return Err("the network is down".to_string());
            }
            let mut results = self.results.lock().unwrap();
            let result = if results.is_empty() { Ok(Sent::Sent) } else { results.remove(0) };
            if result == Ok(Sent::Sent) {
                self.sent.lock().unwrap().push(message.id);
            }
            result
        })
    }
}

fn message(id: &str, ticket: Option<&str>) -> OutboundMessage {
    OutboundMessage {
        id: id.into(),
        channel: ChannelRef { source: "chat".into(), thread: "web:main".into(), address: Default::default() },
        text: format!("text {id}"),
        kind: MessageKind::Reply,
        ticket_id: ticket.map(str::to_string),
    }
}

struct Box_ {
    f: Fixture,
    channels: Arc<FakeChannels>,
    paused: Arc<AtomicBool>,
    outbox: Arc<Outbox>,
}

fn outbox() -> Box_ {
    let f = fixture();
    let channels = Arc::new(FakeChannels::default());
    let paused = Arc::new(AtomicBool::new(false));
    let held = paused.clone();
    let outbox = Outbox::new(f.store.clone(), f.effects.clone(), channels.clone(), Arc::new(move || held.load(Ordering::SeqCst)));
    f.effects.start();
    Box_ { f, channels, paused, outbox }
}

#[tokio::test]
async fn sends_each_message_once_in_the_order_they_were_queued() {
    let b = outbox();
    for id in ["m1", "m2", "m1", "m3"] {
        b.outbox.send(message(id, Some("t1")));
    }
    assert_eq!(b.outbox.status("m1"), Some(ReplyStatus::Pending));
    b.outbox.sent().await;
    assert_eq!(*b.channels.sent.lock().unwrap(), vec!["m1", "m2", "m3"]);
    assert_eq!(b.outbox.status("m3"), Some(ReplyStatus::Sent));
    // A message id that went out is never sent again.
    b.outbox.send(message("m1", Some("t1")));
    b.outbox.sent().await;
    assert_eq!(b.channels.sent.lock().unwrap().len(), 3);
    assert_eq!(b.outbox.status("unknown"), None);
}

#[tokio::test]
async fn holds_messages_while_paused_or_while_the_source_is_off_and_sends_them_after() {
    let b = outbox();
    b.paused.store(true, Ordering::SeqCst);
    b.outbox.send(message("m1", None));
    b.outbox.sent().await;
    assert!(b.channels.sent.lock().unwrap().is_empty());
    b.paused.store(false, Ordering::SeqCst);
    b.channels.off.store(true, Ordering::SeqCst);
    b.outbox.sent().await;
    assert!(b.channels.sent.lock().unwrap().is_empty());
    assert_eq!(b.f.store.effect_attempts(REPLY, "m1"), Some(0), "waiting for the Source is not a failure");
    b.channels.off.store(false, Ordering::SeqCst);
    b.f.advance(5_000);
    b.outbox.sent().await;
    assert_eq!(*b.channels.sent.lock().unwrap(), vec!["m1"]);
}

#[tokio::test]
async fn drops_a_message_whose_conversation_is_gone_or_no_longer_listened_to() {
    let b = outbox();
    *b.channels.results.lock().unwrap() = vec![Ok(Sent::Gone)];
    b.outbox.send(message("gone", None));
    b.outbox.sent().await;
    let dropped = b.f.store.receipt("gone").unwrap();
    assert_eq!((dropped.status, dropped.dropped.map(|d| d.reason)), (ReplyStatus::Dropped, Some(DropReason::ChannelGone)));
    b.channels.ignored.store(true, Ordering::SeqCst);
    b.outbox.send(message("ignored", None));
    b.outbox.sent().await;
    assert_eq!(b.f.store.receipt("ignored").unwrap().dropped.map(|d| d.reason), Some(DropReason::ChannelIgnored));
    assert!(b.channels.sent.lock().unwrap().is_empty() && !b.f.effects.pending(REPLY, None));
}

#[tokio::test]
async fn retries_a_failed_send_and_lets_a_later_message_pass_once_it_keeps_failing() {
    let b = outbox();
    b.channels.failing.lock().unwrap().insert("m1".into(), 3);
    b.outbox.send(message("m1", Some("t1")));
    b.outbox.send(message("m2", Some("t1")));
    b.outbox.send(message("other", Some("t2")));
    b.outbox.sent().await;
    // The other ticket's message is not held back; the same ticket's later one is.
    assert_eq!(*b.channels.sent.lock().unwrap(), vec!["other"]);
    for wait in [5_000, 10_000] {
        b.f.advance(wait);
        b.outbox.sent().await;
    }
    assert_eq!(b.f.store.effect_attempts(REPLY, "m1"), Some(3));
    assert_eq!(b.f.health(REPLY).0, "error");
    // After three failures in a row the later message went ahead at once.
    assert_eq!(*b.channels.sent.lock().unwrap(), vec!["other", "m2"]);
    // And the first still goes out when it can.
    b.f.advance(20_000);
    b.outbox.sent().await;
    assert_eq!(*b.channels.sent.lock().unwrap(), vec!["other", "m2", "m1"]);
    assert_eq!(b.f.health(REPLY).0, "ready");
}

#[tokio::test]
async fn withdraws_a_message_that_has_not_gone_out() {
    let b = outbox();
    b.paused.store(true, Ordering::SeqCst);
    b.outbox.send(message("m1", None));
    b.outbox.withdraw("m1");
    assert_eq!(b.outbox.status("m1"), None);
    assert!(!b.f.effects.pending(REPLY, Some("m1")));
    b.paused.store(false, Ordering::SeqCst);
    b.outbox.send(message("m2", None));
    b.outbox.sent().await;
    // One that went out stays.
    b.outbox.withdraw("m2");
    assert_eq!(b.outbox.status("m2"), Some(ReplyStatus::Sent));
    assert_eq!(*b.channels.sent.lock().unwrap(), vec!["m2"]);
}
