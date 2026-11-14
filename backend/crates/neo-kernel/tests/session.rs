//! The kernel-neutral Session: idempotent deliveries, pending context, turn lifecycle and runtime exits.

use neo_kernel::journal::Journal;
use neo_kernel::session::{Driver, DriverEvent, Mode, Presentation, Session};
use neo_kernel::types::{text_of, uuid, Block, BoxFut, Deliver, KernelEvent, KernelJob, Message, Role};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

/// A submission the fake runtime received: its id, text, delivery and the runtime session to resume.
type Submission = (String, String, Deliver, Option<String>);

#[derive(Default)]
struct FakeDriver {
    submitted: Mutex<Vec<Submission>>,
    fail: Mutex<Option<String>>,
    closed: Mutex<bool>,
}

impl Driver for FakeDriver {
    fn kernel(&self) -> &'static str {
        "fake"
    }
    fn submit<'a>(&'a self, id: &'a str, content: &'a [Block], deliver: Deliver, resume: Option<String>) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            if let Some(error) = self.fail.lock().unwrap().take() {
                return Err(error);
            }
            self.submitted.lock().unwrap().push((id.to_string(), text_of(content), deliver, resume));
            Ok(())
        })
    }
    fn interrupt(&self) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
    fn jobs(&self) -> BoxFut<'_, Vec<KernelJob>> {
        Box::pin(async { Vec::new() })
    }
    fn acknowledge<'a>(&'a self, _ids: &'a [String]) -> BoxFut<'a, ()> {
        Box::pin(async {})
    }
    fn cancel<'a>(&'a self, _id: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async { false })
    }
    fn set_model<'a>(&'a self, _model: Option<&'a str>, _thinking: Option<&'a str>) -> BoxFut<'a, ()> {
        Box::pin(async {})
    }
    fn pid(&self) -> Option<u32> {
        None
    }
    fn close(&self) -> BoxFut<'_, ()> {
        Box::pin(async {
            *self.closed.lock().unwrap() = true;
        })
    }
}

struct Fixture {
    dir: PathBuf,
    session: Arc<Session>,
    driver: Arc<FakeDriver>,
    runtime: mpsc::UnboundedSender<DriverEvent>,
    events: broadcast::Receiver<KernelEvent>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn open(journal: Journal, dir: PathBuf) -> Fixture {
    let driver = Arc::new(FakeDriver::default());
    let (runtime, events) = mpsc::unbounded_channel();
    let session = Session::new(Arc::new(journal), driver.clone(), events);
    let events = session.subscribe();
    Fixture { dir, session, driver, runtime, events }
}

fn fixture() -> Fixture {
    let dir = std::env::temp_dir().join(format!("neo-session-{}-{}", std::process::id(), uuid()));
    let journal = Journal::create(&dir, Path::new("/work")).unwrap();
    open(journal, dir)
}

impl Fixture {
    fn submissions(&self) -> Vec<Submission> {
        self.driver.submitted.lock().unwrap().clone()
    }
    fn texts(&self) -> Vec<String> {
        self.submissions().into_iter().map(|(_, text, _, _)| text).collect()
    }
    async fn next(&mut self) -> KernelEvent {
        tokio::time::timeout(Duration::from_secs(5), self.events.recv()).await.expect("an event arrives").unwrap()
    }
    /// The runtime reports something, and the Session has handled it once this returns.
    async fn report(&mut self, event: DriverEvent) {
        self.runtime.send(event).unwrap();
        self.settle().await;
    }
    async fn settle(&self) {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    fn quiet(&mut self) -> bool {
        matches!(self.events.try_recv(), Err(broadcast::error::TryRecvError::Empty))
    }
    async fn send(&self, request_id: &str, text: &str, mode: Mode) -> Result<(), String> {
        self.session.send(request_id, vec![Block::text(text)], mode, &Presentation::default(), &[]).await
    }
}

fn said(text: &str, stop: &str) -> Message {
    Message { role: Role::Assistant, content: vec![Block::text(text)], stop_reason: Some(stop.into()) }
}

#[tokio::test]
async fn delivers_a_message_once_however_often_it_is_sent() {
    let mut f = fixture();
    f.send("r1", "candidate 1", Mode::Steer).await.unwrap();
    assert_eq!(f.next().await, KernelEvent::AgentStart);
    assert!(f.session.is_streaming() && f.session.has_admitted_submission());
    assert_eq!(
        f.submissions().iter().map(|(_, text, deliver, resume)| (text.as_str(), *deliver, resume.clone())).collect::<Vec<_>>(),
        vec![("candidate 1", Deliver::Steer, None)]
    );
    // The same request again changes nothing: the runtime already has it.
    f.send("r1", "candidate 1 (again)", Mode::Steer).await.unwrap();
    assert_eq!(f.submissions().len(), 1);
    assert_eq!(f.session.journal().len(), 1);
    let id = f.submissions()[0].0.clone();
    f.report(DriverEvent::Taken(id)).await;
    assert_eq!(f.next().await, KernelEvent::Taken { request_ids: vec!["r1".into()] });
    assert!(f.session.journal().pending().is_empty());
    // And once the runtime took it, sending it again does not show it to the model a second time.
    f.send("r1", "candidate 1", Mode::Queue).await.unwrap();
    assert_eq!(f.submissions().len(), 1);
}

#[tokio::test]
async fn shows_the_model_an_injected_notice_with_the_next_message_that_asks_for_a_turn() {
    let mut f = fixture();
    f.send("n1", "notice: settings changed", Mode::Inject).await.unwrap();
    f.session
        .append(
            "chat:1",
            vec![Block::text("see this picture"), Block::Image { mime_type: "image/png".into(), data: "AAAA".into() }],
            &Presentation { display: true, from_user: true, source: Some("web-panel".into()), attachments: vec![("a.png".into(), "image/png".into())] },
            true,
        )
        .unwrap();
    f.session
        .append(
            "chat:2",
            vec![Block::text("plain chat, not for the model")],
            &Presentation { display: true, from_user: true, source: Some("web-panel".into()), ..Default::default() },
            false,
        )
        .unwrap();
    assert!(f.submissions().is_empty() && !f.session.is_streaming() && f.quiet());
    f.send("r1", "candidate", Mode::Queue).await.unwrap();
    assert_eq!(f.texts(), vec!["notice: settings changed\n\nsee this picture\ncandidate"]);
    assert_eq!(f.submissions()[0].2, Deliver::FollowUp);
    let id = f.submissions()[0].0.clone();
    f.report(DriverEvent::Taken(id)).await;
    assert_eq!(f.next().await, KernelEvent::AgentStart);
    assert_eq!(f.next().await, KernelEvent::Taken { request_ids: vec!["n1".into(), "chat:1".into(), "r1".into()] });
    assert!(f.session.journal().pending().is_empty());
    // The chat entries carry what the transcript shows.
    let chat = f.session.journal().chat();
    assert_eq!(chat.iter().map(|entry| entry.request_id().unwrap().to_string()).collect::<Vec<_>>(), vec!["chat:1", "chat:2"]);
    let stored = serde_json::to_value(&chat[0]).unwrap();
    assert_eq!(stored["details"]["attachments"], serde_json::json!([{"name": "a.png", "mediaType": "image/png"}]));
    assert_eq!((stored["attribution"].as_str(), stored["display"].as_bool()), (Some("user"), Some(true)));
    // Appending the same chat message again is a no-op.
    f.session.append("chat:2", vec![Block::text("different")], &Presentation::default(), false).unwrap();
    assert_eq!(f.session.journal().len(), 4);
}

#[tokio::test]
async fn runs_a_turn_from_its_first_message_to_the_runtime_going_quiet() {
    let mut f = fixture();
    f.send("r1", "go", Mode::Queue).await.unwrap();
    assert_eq!(f.next().await, KernelEvent::AgentStart);
    // The runtime goes idle before it took the message: the turn does not end, the message runs next.
    f.report(DriverEvent::Idle { awaiting_async: false }).await;
    assert!(f.quiet() && f.session.is_streaming());
    let id = f.submissions()[0].0.clone();
    f.report(DriverEvent::Taken(id)).await;
    f.report(DriverEvent::Running).await;
    f.report(DriverEvent::Message(said("Working", "toolUse"))).await;
    f.report(DriverEvent::Retry).await;
    f.report(DriverEvent::Message(Message { role: Role::ToolResult, content: vec![Block::text("ok")], stop_reason: None })).await;
    f.report(DriverEvent::Message(said("Done", "stop"))).await;
    f.report(DriverEvent::Idle { awaiting_async: true }).await;
    let mut seen = Vec::new();
    while let Ok(event) = f.events.try_recv() {
        seen.push(event);
    }
    assert_eq!(seen.len(), 6);
    assert!(matches!(seen[0], KernelEvent::Taken { .. }) && seen[2] == KernelEvent::Retry);
    assert_eq!(seen[5], KernelEvent::AgentEnd { terminal: false, awaiting_async: true });
    assert!(!f.session.is_streaming() && !f.session.has_admitted_submission());
    assert_eq!(f.session.journal().last_assistant_text().as_deref(), Some("Done"));
    // A background job wakes the runtime, which then finishes for good.
    f.report(DriverEvent::Running).await;
    f.report(DriverEvent::Idle { awaiting_async: false }).await;
    assert_eq!(f.next().await, KernelEvent::AgentStart);
    assert_eq!(f.next().await, KernelEvent::AgentEnd { terminal: true, awaiting_async: false });
    // Quiet again while idle is not a second end.
    f.report(DriverEvent::Idle { awaiting_async: false }).await;
    assert!(f.quiet());
}

#[tokio::test]
async fn records_the_runtimes_session_id_and_resumes_it_on_the_next_submission() {
    let mut f = fixture();
    f.report(DriverEvent::SessionId("rt-1".into())).await;
    f.send("r1", "go", Mode::Queue).await.unwrap();
    assert_eq!(f.submissions()[0].3.as_deref(), Some("rt-1"));
    assert_eq!(f.session.journal().kernel_session("fake").as_deref(), Some("rt-1"));
}

#[tokio::test]
async fn tells_whoever_waits_when_the_runtime_exits_and_submits_what_it_had_not_taken_again() {
    let mut f = fixture();
    // Idle with nothing running: an exit is silent.
    f.report(DriverEvent::Exited { error: None, awaited: false }).await;
    assert!(f.quiet() && f.session.journal().is_empty());
    f.send("r1", "go", Mode::Queue).await.unwrap();
    assert_eq!(f.next().await, KernelEvent::AgentStart);
    f.report(DriverEvent::Exited { error: Some("the runtime crashed".into()), awaited: false }).await;
    assert_eq!(f.next().await, KernelEvent::Message(said("the runtime crashed", "error")));
    assert_eq!(f.next().await, KernelEvent::AgentEnd { terminal: true, awaiting_async: false });
    assert_eq!(f.session.journal().last_stop_reason().as_deref(), Some("error"));
    // The delivery is still pending, and sending it again hands it to a new runtime process.
    assert_eq!(f.session.journal().pending().len(), 1);
    f.send("r1", "go", Mode::Queue).await.unwrap();
    assert_eq!(f.texts(), vec!["go", "go"]);
    // Background jobs lost with the runtime are reported even when no turn ran.
    let id = f.submissions()[1].0.clone();
    f.report(DriverEvent::Taken(id)).await;
    f.report(DriverEvent::Idle { awaiting_async: true }).await;
    while f.events.try_recv().is_ok() {}
    f.report(DriverEvent::Exited { error: None, awaited: true }).await;
    assert_eq!(f.next().await, KernelEvent::Message(said("The fake runtime ended unexpectedly", "error")));
    assert_eq!(f.next().await, KernelEvent::AgentEnd { terminal: true, awaiting_async: false });
}

#[tokio::test]
async fn keeps_a_delivery_pending_when_the_runtime_refuses_it_and_delivers_it_on_the_retry() {
    let f = fixture();
    *f.driver.fail.lock().unwrap() = Some("cannot start the runtime".into());
    assert_eq!(f.send("r1", "go", Mode::Queue).await, Err("cannot start the runtime".into()));
    assert!(f.submissions().is_empty());
    assert!(f.session.journal().has_request("r1") && f.session.journal().pending().len() == 1);
    f.send("r1", "go", Mode::Queue).await.unwrap();
    assert_eq!(f.texts(), vec!["go"]);
    f.session.resubmit().await.unwrap();
    assert_eq!(f.submissions().len(), 1, "what the runtime already has is not submitted twice");
}

#[tokio::test]
async fn submits_what_a_restart_left_pending_with_the_first_message_after_it() {
    let f = fixture();
    f.send("r1", "before the crash", Mode::Queue).await.unwrap();
    f.send("n1", "a notice", Mode::Inject).await.unwrap();
    let path = f.session.journal().path().to_path_buf();
    let dir = f.dir.clone();
    std::mem::forget(f);
    // The host restarts: the runtime never confirmed the delivery, so the reopened Session still owes it to the model.
    let restarted = open(Journal::open(&path).unwrap(), dir);
    assert!(restarted.submissions().is_empty());
    restarted.send("r1", "before the crash", Mode::Queue).await.unwrap();
    assert_eq!(restarted.texts(), vec!["before the crash\n\na notice"]);
    assert_eq!(restarted.session.journal().len(), 2);
}

#[tokio::test]
async fn refuses_everything_once_disposed_and_closes_the_runtime() {
    let mut f = fixture();
    f.send("r1", "go", Mode::Queue).await.unwrap();
    f.session.dispose().await;
    assert!(*f.driver.closed.lock().unwrap());
    assert!(f.session.is_disposed() && !f.session.is_streaming());
    assert!(f.send("r2", "more", Mode::Queue).await.is_err());
    assert!(f.session.append("c", vec![Block::text("x")], &Presentation::default(), false).is_err());
    while f.events.try_recv().is_ok() {}
    f.report(DriverEvent::Message(said("late", "stop"))).await;
    assert!(f.quiet());
    assert_eq!(f.session.journal().len(), 1);
}
