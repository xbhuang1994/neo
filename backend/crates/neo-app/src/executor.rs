//! The Executor: one persistent worker Session and one directory per ticket. It launches Assignments, hands Inputs to
//! running workers, bounds how many work at once, and reports each worker's turns to the Engine.

use crate::app::App;
use crate::cards::{batch_line, capped, input_message, input_resource, mandate_instructions, worker_trigger_message, ASSIGNMENT_CHARS, RETRIED};
use crate::effects::Failure;
use crate::health::Health;
use crate::kernels::SessionRole;
use crate::notices::result_relay;
use crate::prompts::{environment, TicketPlace};
use crate::sessions::{worker_session_id, Loaded};
use neo_core::assignments::WorkerReport;
use neo_core::errors::UserError;
use neo_core::ids::key;
use neo_core::model::{Assignment, AssignmentState, Execution, ReportState, Ticket, TicketInput};
use neo_core::ports::{Accept, Repositories};
use neo_kernel::session::{Mode, Presentation};
use neo_kernel::types::{Block, JobKind, KernelEvent};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

const PREPARE_TIMEOUT: Duration = Duration::from_secs(600);

/// Why a worker's slot is reserved before its turn starts.
#[derive(Clone, Copy, PartialEq, Eq)]
enum By {
    Launch,
    Wake,
    Person,
}

#[derive(Default)]
struct Inner {
    /// Tickets whose worker is in a turn, or has background work that will wake it.
    running: HashSet<String>,
    /// Tickets whose launch or delivery is under way, with why.
    starting: HashMap<String, By>,
    /// Tickets whose worker was sent a message that starts a turn, until that turn is seen to start: the slot stays
    /// taken in between.
    awaiting: HashSet<String>,
    /// Tickets that ended on their worker's own final report: its Session closes once that turn is over.
    unload_after_end: HashSet<String>,
    /// Shell jobs a worker left to a person at a handoff, by ticket: they run until the Assignment ends and wake no one.
    left: HashMap<String, HashSet<String>>,
    stopping: HashSet<String>,
    wake_seq: u64,
}

/// The Executor's in-memory state.
#[derive(Default)]
pub struct ExecutorState {
    inner: Mutex<Inner>,
    stopped: Notify,
}

/// A background job of a ticket's worker, for views and the Watchdog.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerJob {
    /// The runtime's id for it.
    pub id: String,
    /// `bash`, `task` or `eval`.
    #[serde(rename = "type")]
    pub kind: JobKind,
    /// Its first line, as it shows.
    pub label: String,
    /// When it started.
    pub started_at: String,
    /// How long it has run.
    pub elapsed_seconds: i64,
    /// Its latest progress.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<String>,
    /// The command line of a shell job.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The process ids the runtime reports for it.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pids: Vec<u32>,
}

fn valid_name(name: &str) -> bool {
    let mut words = name.split('-');
    let first = words.next().unwrap_or("");
    let rest: Vec<&str> = words.collect();
    name.len() <= 32
        && !first.is_empty()
        && first.bytes().all(|b| b.is_ascii_lowercase())
        && rest.len() <= 3
        && rest.iter().all(|word| !word.is_empty() && word.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

/// What a worktree name must be, in words for the model.
pub const WORKTREE_NAME_RULE: &str = "Use 1–4 short English words in lowercase kebab-case (first word letters only, no leading digits), at most 32 characters";

/// Whether a ticket's requested short name is 1–4 lowercase kebab-case words of at most 32 characters.
pub fn valid_worktree_name(name: &str) -> bool {
    valid_name(name)
}

fn from_person(input: &TicketInput) -> bool {
    matches!(input, TicketInput::Trigger { human: true, context: false, .. } | TicketInput::Text { .. })
}

/// Whether the running Assignment's last word hands the ticket to a person: blocked or failed without a newer human
/// message, or ready or a question with no Input since.
fn handed_off(ticket: &Ticket) -> bool {
    let Some(assignment) = ticket.running() else { return false };
    let Some(report) = &assignment.report else { return false };
    if matches!(report.state, ReportState::Blocked | ReportState::Failed) {
        return ticket.waits_for_person();
    }
    let quiet = assignment.delivered_at.as_ref().is_none_or(|delivered| delivered < &report.at);
    quiet && (report.state == ReportState::Ready || ticket.attention.is_some())
}

fn user(error: UserError) -> String {
    error.message
}

impl App {
    fn exec(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.executor.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn max_workers(&self) -> usize {
        self.settings().executor.max_workers as usize
    }

    /// How many more Assignments may launch now: the worker limit less the workers in a turn and those being woken.
    pub(crate) fn launch_room(&self) -> usize {
        let inner = self.exec();
        // A launch under way is one of the launch effects the queue already counts.
        let mut busy: HashSet<&String> = inner.running.iter().chain(inner.awaiting.iter()).collect();
        busy.extend(inner.starting.iter().filter(|(_, by)| **by != By::Launch).map(|(ticket, _)| ticket));
        self.max_workers().saturating_sub(busy.len())
    }
    /// Reserve a worker slot before a turn starts; a person's message may take one slot beyond the limit.
    fn reserve(&self, ticket_id: &str, by: By) -> Result<(), Failure> {
        let max = self.max_workers();
        let mut inner = self.exec();
        if inner.starting.contains_key(ticket_id) {
            return Ok(());
        }
        let mut used: HashSet<&String> = inner.running.iter().chain(inner.awaiting.iter()).collect();
        used.extend(inner.starting.keys());
        if used.len() >= max + usize::from(by == By::Person) {
            return Err(Failure::Later("No worker slot is free".into()));
        }
        inner.starting.insert(ticket_id.to_string(), by);
        Ok(())
    }
    fn free(&self, ticket_id: &str) {
        self.exec().starting.remove(ticket_id);
    }

    /// Send a worker a message that asks for a turn, keeping its slot taken from before the send until the turn is
    /// seen to start, so no other worker is admitted in between.
    async fn send_to_worker(&self, loaded: &Loaded, ticket_id: &str, request_id: &str, text: String, input_ids: &[String]) -> Result<(), String> {
        self.exec().awaiting.insert(ticket_id.to_string());
        let sent = loaded.session.send(request_id, vec![Block::text(text)], Mode::Steer, &Presentation::default(), input_ids).await;
        // No turn follows a failed send, or a message the worker already took into a step.
        if sent.is_err() || !(loaded.session.is_streaming() || loaded.session.has_admitted_submission()) {
            self.exec().awaiting.remove(ticket_id);
        }
        sent
    }
    /// Whether any worker is in a turn, being started or woken, or has background work that will wake it.
    pub fn workers_busy(&self) -> bool {
        let inner = self.exec();
        !inner.running.is_empty() || !inner.awaiting.is_empty() || !inner.starting.is_empty()
    }

    /// The tickets whose worker is in a turn, being started or woken, or has background work that will wake it.
    pub fn busy_tickets(&self) -> Vec<String> {
        let inner = self.exec();
        let busy: std::collections::BTreeSet<&String> = inner.running.iter().chain(inner.awaiting.iter()).chain(inner.starting.keys()).collect();
        busy.into_iter().cloned().collect()
    }

    /// How many open tickets have a worker at work.
    pub fn active_workers(&self) -> usize {
        let running = self.exec().running.clone();
        self.store.open_tickets().iter().filter(|ticket| running.contains(&ticket.id)).count()
    }

    /// Where ticket directories are created.
    pub fn execution_root(&self) -> PathBuf {
        let settings = self.settings();
        if settings.executor.directory.is_empty() {
            self.machine.state_dir.join("work")
        } else {
            PathBuf::from(&settings.executor.directory)
        }
    }

    /// Choose a new ticket's short name, directory and assignment text.
    pub(crate) fn executor_prepare(&self, mut ticket: Ticket, accept: &Accept) -> Result<Ticket, UserError> {
        let requested = accept.name.as_deref().unwrap_or("");
        if !valid_name(requested) {
            return Err(UserError::invalid(&format!("worktree_name: {WORKTREE_NAME_RULE}")));
        }
        let name = format!("{requested}-{}", &ticket.id[..ticket.id.len().min(12)]);
        let settings = self.settings();
        let note = accept.note.as_ref().map(|note| format!("\nRouting note (not the source request): {note}")).unwrap_or_default();
        let assignment = match (&ticket.mandate.basis.rules, ticket.mandate.strength) {
            (Some(ids), neo_core::model::Strength::Inferred) => {
                let rules: String = settings
                    .policy
                    .rules
                    .iter()
                    .filter(|rule| ids.contains(&rule.id))
                    .map(|rule| format!("\n- {} ({}): {}", rule.name, rule.id, rule.instruction))
                    .collect();
                let precedence = if rules.is_empty() {
                    String::new()
                } else {
                    format!("\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:{rules}")
                };
                format!("Proactively accepted under {}. Scope: {}.{precedence}{note}", ids.join(", "), accept.scope)
            }
            _ => note.trim().to_string(),
        };
        ticket.execution = Some(Execution { directory: self.execution_root().join(&name).display().to_string(), name, assignment });
        Ok(ticket)
    }

    /// Create a ticket's directory, running the prepare command first when one is set.
    async fn prepare_directory(&self, ticket: &Ticket) -> Result<(), String> {
        let Some(execution) = &ticket.execution else { return Err("The ticket has no directory".into()) };
        let directory = PathBuf::from(&execution.directory);
        let parent = directory.parent().map(Path::to_path_buf).unwrap_or_else(|| self.execution_root());
        std::fs::create_dir_all(&parent).map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
        let settings = self.settings();
        let command = settings.executor.prepare.trim();
        if !command.is_empty() {
            let place = TicketPlace { id: &ticket.id, name: &execution.name, directory: &directory };
            let (program, args) = shell(settings.executor.prepare_shell.as_deref(), command);
            let mut child = tokio::process::Command::new(&program);
            child
                .args(&args)
                .current_dir(&parent)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            for variable in environment(&settings, Some(&place)) {
                child.env(variable.key, variable.value);
            }
            // A prepare command meets the same blocked commands as a Session.
            child.env("PATH", crate::blocked::path_with(&self.machine.state_dir));
            let failed = |why: String| {
                let _ = std::fs::remove_dir(&directory);
                format!("The prepare command failed: {why}")
            };
            let output = match tokio::time::timeout(PREPARE_TIMEOUT, child.output()).await {
                Err(_) => return Err(failed(format!("it did not finish within {} minutes", PREPARE_TIMEOUT.as_secs() / 60))),
                Ok(Err(error)) => return Err(failed(format!("cannot run {program}: {error}"))),
                Ok(Ok(output)) => output,
            };
            if !output.status.success() {
                let said = String::from_utf8_lossy(&output.stderr);
                let said: String = said.trim().chars().rev().take(1000).collect::<Vec<_>>().into_iter().rev().collect();
                let code = output.status.code().map(|code| format!("exit code {code}")).unwrap_or_else(|| "a signal".into());
                return Err(failed(if said.is_empty() { code } else { format!("{code}: {said}") }));
            }
        }
        std::fs::create_dir_all(&directory).map_err(|error| format!("Cannot create {}: {error}", directory.display()))
    }

    /// End an Assignment's work once the Engine ended it: close its worker's Session, unless that worker is still in
    /// the turn of its own final report, which then closes it.
    pub(crate) fn executor_stop(&self, ticket: &Ticket, assignment: &Assignment, reason: &str) {
        let busy = matches!((&assignment.delivered_at, &assignment.report), (Some(delivered), Some(report)) if delivered >= &report.at);
        let own_turn = assignment.report.as_ref().is_some_and(|report| matches!(report.state, ReportState::Ready | ReportState::Dropped))
            && !busy
            && ticket.undelivered.is_empty();
        let (weak, ticket_id, reason) = (self.weak.clone(), ticket.id.clone(), reason.to_string());
        self.store.after_commit(move || {
            let Some(app) = weak.upgrade() else { return };
            {
                let mut inner = app.exec();
                if own_turn && (inner.running.contains(&ticket_id) || inner.awaiting.contains(&ticket_id)) {
                    inner.unload_after_end.insert(ticket_id);
                    return;
                }
                inner.unload_after_end.remove(&ticket_id);
                inner.running.remove(&ticket_id);
                inner.awaiting.remove(&ticket_id);
                inner.left.remove(&ticket_id);
            }
            app.stop_worker(&ticket_id, &reason);
        });
    }

    /// Close a ticket's worker Session in the background; [`App::worker_stopped`] waits for it.
    fn stop_worker(&self, ticket_id: &str, _reason: &str) {
        self.exec().stopping.insert(ticket_id.to_string());
        let (weak, ticket_id) = (self.weak.clone(), ticket_id.to_string());
        self.rt.spawn(async move {
            let Some(app) = weak.upgrade() else { return };
            app.stop_session(&worker_session_id(&ticket_id)).await;
            app.exec().stopping.remove(&ticket_id);
            app.executor.stopped.notify_waiters();
        });
    }
    async fn worker_stopped(&self, ticket_id: &str) {
        loop {
            let stopped = self.executor.stopped.notified();
            tokio::pin!(stopped);
            stopped.as_mut().enable();
            if !self.exec().stopping.contains(ticket_id) {
                return;
            }
            stopped.await;
        }
    }

    fn worker_failed(&self, ticket_id: &str, summary: &str) {
        let _ = self.store.atomic(|| {
            let updated = self.engine.report(ticket_id, WorkerReport::new(ReportState::Failed, summary))?;
            self.relay(result_relay(&updated, "failed", summary, None));
            Ok::<(), UserError>(())
        });
    }

    pub(crate) async fn launch_queued(self: Arc<Self>, payload: Value) -> Result<(), Failure> {
        let (Some(ticket_id), Some(assignment_id)) = (payload["ticketId"].as_str(), payload["assignmentId"].as_str()) else { return Ok(()) };
        let Some(ticket) = self.store_ticket(ticket_id).filter(Ticket::live) else { return Ok(()) };
        let Some(assignment) = ticket.latest().filter(|latest| latest.id == assignment_id && latest.state == AssignmentState::Pending).cloned() else {
            return Ok(());
        };
        self.reserve(ticket_id, By::Launch)?;
        let launched = self.launch(&ticket, &assignment).await;
        self.free(ticket_id);
        match launched {
            Ok(()) => Ok(()),
            Err(failure) => {
                self.exec().running.remove(ticket_id);
                if self.closing() || matches!(failure, Failure::Later(_)) {
                    return Err(failure);
                }
                // A launch that failed is the ticket's failure, which a person retries; it is not retried blindly.
                let Failure::Error(error) = failure else { unreachable!() };
                if self.store_ticket(ticket_id).is_some_and(|current| current.live() && current.latest().is_some_and(|latest| latest.id == assignment_id)) {
                    self.worker_failed(ticket_id, &error);
                }
                Ok(())
            }
        }
    }

    fn trigger_acknowledged(&self, trigger_id: &str) -> bool {
        self.store.reply_status(&key(&["ack", trigger_id])).is_some()
    }

    /// The message an Input reaches its worker as, a reference to its resource when long.
    fn input_text(&self, ticket: &Ticket, input: &TicketInput) -> String {
        let card = match input {
            TicketInput::Trigger { trigger_id, note, .. } => {
                self.store.trigger(trigger_id).map(|trigger| worker_trigger_message(&trigger, note.as_deref(), self.trigger_acknowledged(&trigger.id)))
            }
            _ => None,
        };
        let message = input_message(input, card);
        if message.chars().count() > ASSIGNMENT_CHARS {
            capped(&message, ASSIGNMENT_CHARS, &input_resource(&ticket.id, input.id())).to_string()
        } else {
            message
        }
    }

    async fn launch(self: &Arc<Self>, ticket: &Ticket, assignment: &Assignment) -> Result<(), Failure> {
        let current = || -> Result<bool, Failure> {
            if self.closing() {
                return Err(Failure::Error("neo-agent is stopping".into()));
            }
            if self.paused() {
                return Err(Failure::Later("Processing is paused".into()));
            }
            Ok(self.store_ticket(&ticket.id).is_some_and(|stored| stored.live() && stored.latest().is_some_and(|latest| latest.id == assignment.id)))
        };
        let Some(execution) = ticket.execution.clone() else { return Err(Failure::Error("The ticket has no directory".into())) };
        let workspace = PathBuf::from(&execution.directory);
        if !current()? {
            return Ok(());
        }
        if !workspace.is_dir() {
            self.prepare_directory(ticket).await?;
            if !current()? {
                return Ok(());
            }
        }
        self.worker_stopped(&ticket.id).await;
        if !current()? {
            return Ok(());
        }
        self.exec().unload_after_end.remove(&ticket.id);
        let session_id = worker_session_id(&ticket.id);
        // A worker whose last turn ended in a model error starts over in a fresh runtime process.
        if let Some(existing) = self.session(&session_id) {
            if !existing.session.is_streaming() && existing.session.journal().last_stop_reason().as_deref() == Some("error") {
                self.stop_session(&session_id).await;
            }
        }
        let loaded = self.ensure_session(&session_id, &workspace, &ticket.title, SessionRole::Worker, Some(&ticket.id)).await?;
        if !current()? {
            return Ok(());
        }
        let journal = loaded.session.journal();
        let first = format!("assignment:{}", ticket.id);
        let later = ticket.assignments.len() > 1;
        // Told already: the transcript holds the assignment, and this kernel's runtime has that context to resume.
        let told = later && journal.has_request(&first) && journal.kernel_session(loaded.session.driver().kernel()).is_some();
        let retried = ticket.assignments.len() >= 2 && ticket.assignments[ticket.assignments.len() - 2].ended_reason.as_deref() == Some("retried");
        let fresh = self.store_ticket(&ticket.id).unwrap_or_else(|| ticket.clone());
        let waiting: Vec<TicketInput> =
            if later || !fresh.undelivered.is_empty() { fresh.undelivered.iter().filter_map(|id| fresh.input(id).cloned()).collect() } else { Vec::new() };
        let mut card = json!({"ticket_id": ticket.id, "directory": execution.directory});
        if told {
            card["assignment"] = ticket.assignments.len().into();
        } else {
            card["title"] = ticket.title.clone().into();
            card["worktree_name"] = execution.name.clone().into();
            if let Some(mandate) = mandate_instructions(ticket) {
                card["mandate"] = mandate.into();
            }
            if !execution.assignment.is_empty() {
                let brief = capped(&execution.assignment, ASSIGNMENT_CHARS, &format!("ticket/{}/assignment", ticket.id));
                card["assignment"] = brief["text"].clone();
                if let Some(chars) = brief.get("chars") {
                    card["assignment_chars"] = chars.clone();
                    card["assignment_read"] = brief["read"].clone();
                }
            }
            if let Some(source) = self.store.trigger(&ticket.origin.trigger_id) {
                card["trigger"] = worker_trigger_message(&source, None, self.trigger_acknowledged(&source.id));
            }
            let batch: Vec<Value> = ticket
                .origin
                .trigger_ids
                .iter()
                .filter(|id| **id != ticket.origin.trigger_id)
                .filter_map(|id| self.store.trigger(id))
                .map(|trigger| batch_line(&trigger))
                .collect();
            if !batch.is_empty() {
                card["batch"] = batch.into();
            }
        }
        if retried {
            card["note"] = RETRIED.into();
        }
        let mut parts = vec![card.to_string()];
        parts.extend(waiting.iter().map(|input| self.input_text(&fresh, input)));
        let request_id = if later { format!("assignment:{}:{}", ticket.id, assignment.id) } else { first };
        let input_ids: Vec<String> = waiting.iter().map(|input| input.id().to_string()).collect();
        if !current()? {
            return Err(Failure::Error("Launch authorization changed before worker delivery".into()));
        }
        self.send_to_worker(&loaded, &ticket.id, &request_id, parts.join("\n\n"), &input_ids).await?;
        // Recorded together, so the Inputs the launch carried are not also queued for a delivery of their own.
        self.store
            .atomic(|| {
                self.engine.assignment_started(&ticket.id, &assignment.id)?;
                if !input_ids.is_empty() {
                    self.engine.inputs_delivered(&ticket.id, &assignment.id, &input_ids)?;
                }
                Ok::<(), UserError>(())
            })
            .map_err(user)?;
        Ok(())
    }

    pub(crate) async fn deliver_queued(self: Arc<Self>, payload: Value) -> Result<(), Failure> {
        let Some(ticket_id) = payload["ticketId"].as_str() else { return Ok(()) };
        self.worker_stopped(ticket_id).await;
        let mut woken = false;
        let result = self.deliver_all(ticket_id, &mut woken).await;
        if woken {
            self.free(ticket_id);
        }
        result
    }

    async fn deliver_all(self: &Arc<Self>, ticket_id: &str, woken: &mut bool) -> Result<(), Failure> {
        loop {
            let Some(ticket) = self.store_ticket(ticket_id).filter(Ticket::live) else { return Ok(()) };
            let Some(assignment) = ticket.running().cloned() else { return Ok(()) };
            let Some(input) = ticket.undelivered.first().and_then(|id| ticket.input(id)).cloned() else { return Ok(()) };
            if !*woken && !self.exec().running.contains(ticket_id) {
                let person = ticket.undelivered.iter().filter_map(|id| ticket.input(id)).any(from_person);
                self.reserve(ticket_id, if person { By::Person } else { By::Wake })?;
                *woken = true;
            }
            match self.deliver_input(&ticket, &assignment, &input).await {
                Ok(()) => {}
                Err(failure) => {
                    if self.closing() || matches!(failure, Failure::Later(_)) {
                        return Err(failure);
                    }
                    let Failure::Error(error) = &failure else { unreachable!() };
                    let still = self
                        .store_ticket(ticket_id)
                        .is_some_and(|current| current.live() && current.running().is_some_and(|running| running.id == assignment.id));
                    if !still {
                        return Ok(());
                    }
                    let _ = self.engine.delivery_failed(ticket_id, &assignment.id, error);
                    return Err(failure);
                }
            }
        }
    }

    async fn deliver_input(self: &Arc<Self>, ticket: &Ticket, assignment: &Assignment, input: &TicketInput) -> Result<(), Failure> {
        let live = || -> Result<(), Failure> {
            let still =
                self.store_ticket(&ticket.id).is_some_and(|current| current.live() && current.running().is_some_and(|running| running.id == assignment.id));
            if !still {
                return Err(Failure::Error("The ticket ended or another Assignment took it over".into()));
            }
            if self.exec().stopping.contains(&ticket.id) {
                return Err(Failure::Later("The worker Session is stopping".into()));
            }
            Ok(())
        };
        live()?;
        let directory = ticket.execution.as_ref().map(|execution| PathBuf::from(&execution.directory)).unwrap_or_default();
        let loaded = self.ensure_session(&worker_session_id(&ticket.id), &directory, &ticket.title, SessionRole::Worker, Some(&ticket.id)).await?;
        live()?;
        let ids = [input.id().to_string()];
        self.send_to_worker(&loaded, &ticket.id, input.id(), self.input_text(ticket, input), &ids).await?;
        self.engine.inputs_delivered(&ticket.id, &assignment.id, &ids).map_err(user)?;
        Ok(())
    }

    /// What a worker Session reported.
    pub(crate) async fn worker_event(self: &Arc<Self>, ticket_id: &str, loaded: &Arc<Loaded>, event: KernelEvent) {
        match event {
            KernelEvent::AgentStart => {
                let mut inner = self.exec();
                inner.running.insert(ticket_id.to_string());
                inner.awaiting.remove(ticket_id);
            }
            KernelEvent::Retry => {
                if self.exec().unload_after_end.contains(ticket_id) {
                    self.turn_over(ticket_id, loaded, None).await;
                }
            }
            KernelEvent::AgentEnd { terminal: true, .. } => self.turn_over(ticket_id, loaded, None).await,
            KernelEvent::AgentEnd { awaiting_async: true, .. } => self.backgrounded(ticket_id, loaded).await,
            KernelEvent::AgentEnd { .. } | KernelEvent::Message(_) => {}
            KernelEvent::Taken { request_ids } => {
                // The worker's runtime took these messages into a step: its model reads the Inputs they carry.
                let journal = loaded.session.journal();
                let inputs: Vec<String> = request_ids.iter().filter_map(|id| journal.request(id)).flat_map(|entry| entry.input_ids()).collect();
                if !inputs.is_empty() {
                    let _ = self.engine.inputs_read(ticket_id, &inputs);
                }
            }
        }
    }

    /// Nothing the worker runs wakes it again: free its slot and report, or close a ticket that stayed ended meanwhile.
    async fn turn_over(self: &Arc<Self>, ticket_id: &str, loaded: &Arc<Loaded>, note: Option<&str>) {
        let unload = {
            let mut inner = self.exec();
            inner.running.remove(ticket_id);
            inner.awaiting.remove(ticket_id);
            inner.unload_after_end.remove(ticket_id)
        };
        if unload && !self.store_ticket(ticket_id).is_some_and(|ticket| ticket.live()) {
            self.exec().left.remove(ticket_id);
            self.stop_worker(ticket_id, "Ticket ended");
            self.effects.wake_kind(crate::effects::LAUNCH);
            return;
        }
        self.worker_ended(ticket_id, loaded, note);
        self.board.set("worker", Health::ready("Worker events are handled"));
        // A slot is free: a launch that waited for one may go.
        self.effects.wake_kind(crate::effects::LAUNCH);
    }

    /// The worker's turn ended while its jobs or subagents run; their ends wake it, so it keeps its slot. A handoff to
    /// a person ends that at once: its subagents stop, and its own shell jobs, such as a server offered for review,
    /// run on until the Assignment ends without waking it.
    async fn backgrounded(self: &Arc<Self>, ticket_id: &str, loaded: &Arc<Loaded>) {
        if self.exec().unload_after_end.contains(ticket_id) {
            self.turn_over(ticket_id, loaded, None).await;
            return;
        }
        if self.store_ticket(ticket_id).is_some_and(|ticket| handed_off(&ticket)) {
            let driver = loaded.session.driver();
            let jobs: Vec<_> = driver.jobs().await.into_iter().filter(|job| job.own).collect();
            // Acknowledged jobs deliver nothing, so neither those left running nor the cancelled ones wake the worker.
            driver.acknowledge(&jobs.iter().map(|job| job.id.clone()).collect::<Vec<_>>()).await;
            for job in &jobs {
                if job.kind == JobKind::Bash {
                    self.exec().left.entry(ticket_id.to_string()).or_default().insert(job.id.clone());
                } else {
                    driver.cancel(&job.id).await;
                }
            }
            self.turn_over(ticket_id, loaded, None).await;
        }
    }

    /// The live background jobs of a ticket's worker, without the shell jobs it left to a person at a handoff.
    pub async fn running_jobs(&self, ticket_id: &str) -> Vec<WorkerJob> {
        let Some(loaded) = self.session(&worker_session_id(ticket_id)).filter(|loaded| !loaded.session.is_disposed()) else { return Vec::new() };
        let left = self.exec().left.get(ticket_id).cloned().unwrap_or_default();
        let now = neo_core::time::now_ms();
        loaded
            .session
            .driver()
            .jobs()
            .await
            .into_iter()
            .filter(|job| job.own && !left.contains(&job.id))
            .map(|job| WorkerJob {
                label: crate::text::clip(job.label.lines().next().unwrap_or(""), 200),
                started_at: neo_core::time::format_iso(job.start_time),
                elapsed_seconds: ((now - job.start_time) / 1000).max(0),
                progress: job.progress.map(|text| text.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect()),
                command: job.command.map(|command| crate::text::clip(&command, 300)),
                pids: job.pids,
                kind: job.kind,
                id: job.id,
            })
            .collect()
    }

    /// Cancel one hung or off-track background job of a ticket and wake its worker with why.
    pub async fn cancel_job(self: &Arc<Self>, ticket_id: &str, job_id: &str, reason: &str) -> Result<bool, String> {
        let Some(loaded) = self.session(&worker_session_id(ticket_id)).filter(|loaded| !loaded.session.is_disposed()) else { return Ok(false) };
        let running = self.running_jobs(ticket_id).await;
        let Some(target) = running.iter().find(|job| job.id == job_id) else { return Ok(false) };
        let driver = loaded.session.driver();
        driver.acknowledge(&[job_id.to_string()]).await;
        if !driver.cancel(job_id).await {
            return Ok(false);
        }
        let remaining: Vec<&str> = running.iter().filter(|job| job.id != job_id).map(|job| job.id.as_str()).collect();
        let mut note = format!("[Watchdog] Stopped background job {job_id} ({}): {reason}", target.label);
        if !remaining.is_empty() {
            note.push_str(&format!(" Remaining background jobs: {}.", remaining.join(", ")));
        }
        let assignment = self.store_ticket(ticket_id).filter(Ticket::live).and_then(|ticket| ticket.running().cloned());
        let idle = remaining.is_empty() && !loaded.session.is_streaming();
        let Some(assignment) = assignment.filter(|_| !self.exec().unload_after_end.contains(ticket_id) && !self.closing() && !self.paused()) else {
            if idle {
                self.turn_over(ticket_id, &loaded, Some(&note)).await;
            }
            return Ok(true);
        };
        let seq = {
            let mut inner = self.exec();
            inner.wake_seq += 1;
            inner.wake_seq
        };
        let request_id = key(&["watchdog-cancel", ticket_id, &assignment.id, &seq.to_string(), &neo_core::time::now_iso()]);
        let prompt = format!("{note} Inspect current workspace and logs: recover or continue the remaining work, or call orchestrator_report (ready, blocked, failed or dropped).");
        if let Err(error) = loaded.session.send(&request_id, vec![Block::text(prompt)], Mode::Steer, &Presentation::default(), &[]).await {
            if idle {
                self.turn_over(ticket_id, &loaded, Some(&note)).await;
            }
            return Err(error);
        }
        Ok(true)
    }

    /// A worker's turn ended with nothing running: note it, and report for a worker that did not report itself.
    fn worker_ended(&self, ticket_id: &str, loaded: &Arc<Loaded>, note: Option<&str>) {
        let Some(ticket) = self.store_ticket(ticket_id).filter(Ticket::live) else { return };
        let Some(assignment) = ticket.running().cloned() else { return };
        if self.closing() {
            return;
        }
        let _ = self.engine.turn_ended(ticket_id, &assignment.id);
        let journal = loaded.session.journal();
        let text = journal.last_assistant_text().map(|text| text.trim().to_string()).unwrap_or_default();
        if journal.last_stop_reason().as_deref() == Some("error") {
            self.worker_failed(ticket_id, if text.is_empty() { "The worker model request failed" } else { &text });
            return;
        }
        if handed_off(&ticket) {
            return;
        }
        let said = if text.is_empty() { assignment.report.as_ref().map(|report| report.summary.clone()).unwrap_or_default() } else { text };
        let summary = [said.as_str(), note.unwrap_or("")].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n\n");
        let reminder = "Worker ended its turn with no background job running and without a terminal orchestrator_report. If it is not waiting on an external event, call orchestrator_ticket_request_status so the worker records its report.";
        let relay_text = [summary.as_str(), reminder].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n\n");
        let _ = self.store.atomic(|| {
            let updated = self.engine.report(ticket_id, WorkerReport::new(ReportState::Waiting, &summary))?;
            self.relay(result_relay(&updated, "waiting", &relay_text, None));
            Ok::<(), UserError>(())
        });
    }

    /// After a restart: restart or continue each Assignment that was running, and launch those still waiting.
    pub(crate) fn executor_resume(&self) {
        let mut open = self.store.open_tickets();
        open.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        for ticket in open {
            if let Some(running) = ticket.running() {
                let _ = self.engine.assignment_interrupted(&ticket.id, &running.id);
            } else if let Some(latest) = ticket.latest().filter(|latest| latest.state == AssignmentState::Pending) {
                if !ticket.waits_for_person() {
                    self.effects.enqueue(crate::effects::LAUNCH, &latest.id, &json!({"ticketId": ticket.id, "assignmentId": latest.id}));
                }
            }
        }
    }
}

/// The program and arguments that run a prepare command: the platform's shell, or the one the settings name.
fn shell(configured: Option<&str>, command: &str) -> (String, Vec<String>) {
    let program = configured.map(str::to_string).unwrap_or_else(|| if cfg!(windows) { "cmd.exe".into() } else { "sh".into() });
    // The name alone, whichever separators the path uses, without its extension.
    let name = program.rsplit(['/', '\\']).next().unwrap_or("");
    let stem = name.strip_suffix(".exe").or_else(|| name.strip_suffix(".EXE")).unwrap_or(name).to_ascii_lowercase();
    let args = match stem.as_str() {
        "cmd" => vec!["/d".into(), "/s".into(), "/c".into(), command.to_string()],
        "powershell" | "pwsh" => vec!["-NoProfile".into(), "-Command".into(), command.to_string()],
        _ => vec!["-c".into(), command.to_string()],
    };
    (program, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_short_kebab_case_names_only() {
        for good in ["fix", "fix-plan-color", "a-b2-c3-d4", "readme-typo"] {
            assert!(valid_worktree_name(good), "{good}");
        }
        for bad in ["", "Fix", "fix_plan", "2fix", "a-b-c-d-e", "fix--plan", "fix-", "修复", "a-very-long-name-that-goes-on-and-on"] {
            assert!(!valid_worktree_name(bad), "{bad}");
        }
    }

    #[test]
    fn runs_a_prepare_command_with_the_shell_that_fits() {
        assert_eq!(shell(Some("pwsh"), "git clone x"), ("pwsh".to_string(), vec!["-NoProfile".to_string(), "-Command".into(), "git clone x".into()]));
        assert_eq!(shell(Some("C:\\Windows\\System32\\cmd.exe"), "dir").1[..3], ["/d".to_string(), "/s".into(), "/c".into()]);
        assert_eq!(shell(Some("/bin/bash"), "ls"), ("/bin/bash".to_string(), vec!["-c".to_string(), "ls".into()]));
        let (program, args) = shell(None, "echo hi");
        assert_eq!(args.last().map(String::as_str), Some("echo hi"));
        assert_eq!(program, if cfg!(windows) { "cmd.exe" } else { "sh" });
    }
}
