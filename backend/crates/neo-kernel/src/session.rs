//! A persistent agent Session: its transcript, idempotent deliveries, and turn lifecycle.
//!
//! The Session owns the [`Journal`]; a [`Driver`] owns the runtime process and only runs the model. A delivery is
//! durable once its entry is flushed to the journal, before the runtime sees it, and stays pending until the runtime
//! reports that it took it into a step. Whatever is pending when a runtime process starts again is submitted again.

use crate::journal::{Entry, Journal};
use crate::types::{Block, BoxFut, Deliver, KernelEvent, KernelJob, Message, Role};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc};

/// What a runtime process reports to its Session.
#[derive(Clone, Debug, PartialEq)]
pub enum DriverEvent {
    /// The runtime began working.
    Running,
    /// The runtime went quiet; with `awaiting_async`, background jobs it runs will wake it.
    Idle {
        /// Background jobs still run.
        awaiting_async: bool,
    },
    /// The runtime retries a failed model request.
    Retry,
    /// The runtime took the submission with this id into a step.
    Taken(String),
    /// The model or a tool said something.
    Message(Message),
    /// The runtime's own session id, which resumes its context after a restart.
    SessionId(String),
    /// The runtime process ended; `awaited` when background jobs were running in it.
    Exited {
        /// Why, when it failed.
        error: Option<String>,
        /// Background jobs were lost with it.
        awaited: bool,
    },
}

/// A runtime process that runs the model for one Session.
pub trait Driver: Send + Sync {
    /// The kernel's name, under which its session id is recorded.
    fn kernel(&self) -> &'static str;
    /// Pre-warm the runtime process without starting a turn, resuming `resume` when known.
    fn warm<'a>(&'a self, _resume: Option<String>) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    /// Hand the runtime a user message, starting its process if none runs (resuming `resume`).
    fn submit<'a>(&'a self, id: &'a str, content: &'a [Block], deliver: Deliver, resume: Option<String>) -> BoxFut<'a, Result<(), String>>;
    /// Cancel the running turn.
    fn interrupt(&self) -> BoxFut<'_, ()>;
    /// The background jobs the runtime runs.
    fn jobs(&self) -> BoxFut<'_, Vec<KernelJob>>;
    /// Let these jobs finish without waking the Session.
    fn acknowledge<'a>(&'a self, ids: &'a [String]) -> BoxFut<'a, ()>;
    /// Cancel a background job; false when it is unknown.
    fn cancel<'a>(&'a self, id: &'a str) -> BoxFut<'a, bool>;
    /// Use another model, or thinking level, from the next turn.
    fn set_model<'a>(&'a self, model: Option<&'a str>, thinking: Option<&'a str>) -> BoxFut<'a, ()>;
    /// The runtime's process id, the root of what it runs.
    fn pid(&self) -> Option<u32>;
    /// End the runtime process and everything it runs.
    fn close(&self) -> BoxFut<'_, ()>;
}

/// How a delivery reaches the model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// It asks for a turn after the running one.
    Queue,
    /// It asks for a turn, joining the running one at its next tool boundary.
    Steer,
    /// It waits for the next turn something else starts.
    Inject,
}

/// How a delivery shows in the transcript.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Presentation {
    /// People see it.
    pub display: bool,
    /// It is from a person rather than the agent.
    pub from_user: bool,
    /// The chat source, such as `web-panel`.
    pub source: Option<String>,
    /// Attached files, as name and media type.
    pub attachments: Vec<(String, String)>,
}

#[derive(Default)]
struct State {
    disposed: bool,
    in_turn: bool,
    /// Deliveries that asked for a turn since the last turn ended.
    submitted: usize,
    /// Submissions the runtime has not taken into a step: their id and the entries each carries.
    outstanding: Vec<(String, Vec<String>)>,
}

/// One persistent agent Session.
pub struct Session {
    journal: Arc<Journal>,
    driver: Arc<dyn Driver>,
    state: Mutex<State>,
    events: broadcast::Sender<KernelEvent>,
    /// Serializes submissions, so deliveries reach the runtime in the order they were appended.
    submitting: tokio::sync::Mutex<()>,
}

fn details(request_id: &str, presentation: &Presentation, input_ids: &[String]) -> Value {
    let mut details = json!({ "requestId": request_id });
    if !input_ids.is_empty() {
        details["inputIds"] = json!(input_ids);
    }
    if let Some(source) = &presentation.source {
        details["source"] = json!(source);
    }
    if !presentation.attachments.is_empty() {
        details["attachments"] = presentation.attachments.iter().map(|(name, media_type)| json!({"name": name, "mediaType": media_type})).collect();
    }
    details
}

impl Session {
    /// A Session over its transcript and runtime; `events` is what the runtime reports.
    pub fn new(journal: Arc<Journal>, driver: Arc<dyn Driver>, mut events: mpsc::UnboundedReceiver<DriverEvent>) -> Arc<Session> {
        let (sender, _) = broadcast::channel(256);
        let session = Arc::new(Session { journal, driver, state: Mutex::new(State::default()), events: sender, submitting: tokio::sync::Mutex::new(()) });
        let weak = Arc::downgrade(&session);
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                let Some(session) = weak.upgrade() else { break };
                session.handle(event);
            }
        });
        session
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn emit(&self, event: KernelEvent) {
        let _ = self.events.send(event);
    }

    /// The Session's transcript.
    pub fn journal(&self) -> &Arc<Journal> {
        &self.journal
    }
    /// The Session's runtime.
    pub fn driver(&self) -> &Arc<dyn Driver> {
        &self.driver
    }
    /// What the Session reports from now on.
    pub fn subscribe(&self) -> broadcast::Receiver<KernelEvent> {
        self.events.subscribe()
    }
    /// A turn is running.
    pub fn is_streaming(&self) -> bool {
        self.state().in_turn
    }
    /// The Session was disposed and takes nothing more.
    pub fn is_disposed(&self) -> bool {
        self.state().disposed
    }
    /// A delivery asked for a turn that has not ended yet.
    pub fn has_admitted_submission(&self) -> bool {
        self.state().submitted > 0
    }

    fn start_turn(&self) {
        let started = {
            let mut state = self.state();
            !std::mem::replace(&mut state.in_turn, true)
        };
        if started {
            self.emit(KernelEvent::AgentStart);
        }
    }
    fn end_turn(&self, awaiting_async: bool) {
        {
            let mut state = self.state();
            if !state.in_turn {
                return;
            }
            state.in_turn = false;
            state.submitted = 0;
        }
        self.emit(KernelEvent::AgentEnd { terminal: !awaiting_async, awaiting_async });
    }
    fn record(&self, message: Message) {
        self.journal.append_message(message.clone());
        self.emit(KernelEvent::Message(message));
    }

    fn handle(&self, event: DriverEvent) {
        if self.is_disposed() {
            return;
        }
        match event {
            DriverEvent::Running => self.start_turn(),
            DriverEvent::Idle { awaiting_async } => {
                // A message submitted as this turn ended runs next, without an end in between.
                if self.state().outstanding.is_empty() {
                    self.end_turn(awaiting_async);
                }
            }
            DriverEvent::Retry => self.emit(KernelEvent::Retry),
            DriverEvent::Taken(id) => {
                let taken = {
                    let mut state = self.state();
                    let index = state.outstanding.iter().position(|(known, _)| *known == id).or(if state.outstanding.is_empty() { None } else { Some(0) });
                    index.map(|index| state.outstanding.remove(index).1)
                };
                let Some(entry_ids) = taken else { return };
                self.journal.mark_taken(&entry_ids);
                let request_ids = self.journal.request_ids_for(&entry_ids);
                self.start_turn();
                self.emit(KernelEvent::Taken { request_ids });
            }
            DriverEvent::Message(message) => {
                if message.role == Role::Assistant {
                    self.start_turn();
                }
                self.record(message);
            }
            DriverEvent::SessionId(id) => self.journal.set_kernel_session(self.driver.kernel(), &id),
            DriverEvent::Exited { error, awaited } => {
                // What the runtime had not taken stays pending in the journal, and the next submission carries it.
                let waiting = {
                    let mut state = self.state();
                    state.outstanding.clear();
                    state.in_turn || state.submitted > 0
                };
                // Idle with nothing running: the next message simply resumes. Otherwise whoever waits must hear.
                if !waiting && !awaited {
                    return;
                }
                let text = error.unwrap_or_else(|| format!("The {} runtime ended unexpectedly", self.driver.kernel()));
                self.record(Message { role: Role::Assistant, content: vec![Block::text(text)], stop_reason: Some("error".into()) });
                self.state().in_turn = true;
                self.end_turn(false);
            }
        }
    }

    /// Append a visible message without asking for a turn, even while the agent is busy; with `show_model`, the model
    /// is shown it on its next turn. A request id appended before is not appended again.
    pub fn append(&self, request_id: &str, content: Vec<Block>, presentation: &Presentation, show_model: bool) -> Result<(), String> {
        if self.is_disposed() {
            return Err("The session was disposed".into());
        }
        if !self.journal.has_request(request_id) {
            let attribution = if presentation.from_user { "user" } else { "agent" };
            self.journal.append_custom(
                content,
                presentation.display,
                Some(details(request_id, presentation, &[])),
                Some(attribution),
                show_model.then_some(false),
            );
        }
        self.journal.flush().map_err(|error| format!("The session transcript cannot be written: {error}"))
    }

    /// Pre-warm the underlying runtime process without starting a turn.
    pub async fn warm(&self) -> Result<(), String> {
        if self.is_disposed() {
            return Ok(());
        }
        let resume = self.journal.kernel_session(self.driver.kernel());
        self.driver.warm(resume).await
    }

    /// Deliver a message to the model, once per request id. It is durable when this returns: a crash after that loses
    /// nothing, and sending the same request again only makes sure the runtime has it.
    pub async fn send(&self, request_id: &str, content: Vec<Block>, mode: Mode, presentation: &Presentation, input_ids: &[String]) -> Result<(), String> {
        if self.is_disposed() {
            return Err("The session was disposed".into());
        }
        let known = self.journal.request(request_id);
        if known.is_none() {
            let attribution = if presentation.from_user { "user" } else { "agent" };
            self.journal.append_custom(
                content,
                presentation.display,
                Some(details(request_id, presentation, input_ids)),
                Some(attribution),
                Some(mode != Mode::Inject),
            );
        }
        let journal = Arc::clone(&self.journal);
        tokio::task::spawn_blocking(move || journal.flush())
            .await
            .map_err(|error| format!("The session transcript cannot be written: {error}"))?
            .map_err(|error| format!("The session transcript cannot be written: {error}"))?;
        if mode == Mode::Inject {
            return Ok(());
        }
        if known.is_none() {
            self.state().submitted += 1;
            self.start_turn();
        } else if !known.as_ref().is_some_and(|entry| self.journal.is_pending(entry.id())) {
            return Ok(());
        }
        self.submit(if mode == Mode::Steer { Deliver::Steer } else { Deliver::FollowUp }).await
    }

    /// Hand the runtime every pending delivery it does not have yet, as one message, when one of them asks for a turn.
    async fn submit(&self, deliver: Deliver) -> Result<(), String> {
        let _order = self.submitting.lock().await;
        if self.is_disposed() {
            return Err("The session was disposed".into());
        }
        let id = crate::types::uuid();
        let fresh: Vec<Entry> = {
            let mut state = self.state();
            let pending = self.journal.pending();
            let fresh: Vec<_> =
                pending.into_iter().filter(|pending| !state.outstanding.iter().any(|(_, ids)| ids.iter().any(|id| id == pending.entry.id()))).collect();
            if !fresh.iter().any(|pending| pending.trigger) {
                return Ok(());
            }
            state.outstanding.push((id.clone(), fresh.iter().map(|pending| pending.entry.id().to_string()).collect()));
            fresh.into_iter().map(|pending| pending.entry).collect()
        };
        let mut content: Vec<Block> = Vec::new();
        for entry in &fresh {
            let Entry::CustomMessage { content: blocks, .. } = entry else { continue };
            for block in blocks {
                match (content.last_mut(), block) {
                    // Deliveries read as paragraphs of one message.
                    (Some(Block::Text { text: last }), Block::Text { text }) => {
                        last.push_str("\n\n");
                        last.push_str(text);
                    }
                    _ => content.push(block.clone()),
                }
            }
        }
        let resume = self.journal.kernel_session(self.driver.kernel());
        let submitted = self.driver.submit(&id, &content, deliver, resume).await;
        if submitted.is_err() {
            self.state().outstanding.retain(|(known, _)| *known != id);
        }
        submitted
    }

    /// Make sure the runtime has what is pending, such as after it exited with deliveries it had not taken.
    pub async fn resubmit(&self) -> Result<(), String> {
        self.submit(Deliver::FollowUp).await
    }

    /// Refuse new work at once; [`Session::dispose`] ends the runtime.
    pub fn begin_dispose(&self) {
        self.state().disposed = true;
    }

    /// End the Session's runtime and make its transcript durable.
    pub async fn dispose(&self) {
        self.begin_dispose();
        self.driver.close().await;
        self.state().in_turn = false;
        let journal = Arc::clone(&self.journal);
        let _ = tokio::task::spawn_blocking(move || journal.flush()).await;
    }
}
