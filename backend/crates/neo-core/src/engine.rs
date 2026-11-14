//! The domain Engine: the single entry point of the core. Every command runs in one repository transaction and only
//! queues side effects through the ports.

use crate::errors::{Result, UserError};
use crate::model::{followup_owners, reached, thread_key, Decision, Handback, PolicyEffect, Thread, ThreadRef, Ticket, Trigger, TriggerDisposition};
use crate::ports::{Accept, Assessor, Candidate, DomainEvent, Executor, Outbox, Outcome, Policy, Records, Repositories, SourceScope};
use std::collections::HashMap;
use std::sync::Arc;

/// Lets the Executor choose a new ticket's name, directory and assignment text; an error refuses the accept.
pub type PrepareTicket = Box<dyn Fn(Ticket, &Accept) -> Result<Ticket> + Send + Sync>;
/// Receives each domain event with its time.
pub type Emit = Box<dyn Fn(DomainEvent, &str) + Send + Sync>;
/// The clock, as canonical timestamps.
pub type Clock = Box<dyn Fn() -> String + Send + Sync>;

/// What the Engine is built from.
pub struct EngineOptions {
    /// Durable state.
    pub repo: Arc<dyn Repositories>,
    /// The Policy in force now.
    pub policy: Box<dyn Fn() -> Arc<dyn Policy> + Send + Sync>,
    /// Decides whether a Source listens to a trigger; one it does not listen to is stored with a `filtered` disposition.
    pub scope: Arc<dyn SourceScope>,
    /// Judges candidates.
    pub assessor: Arc<dyn Assessor>,
    /// Runs assignments.
    pub executor: Arc<dyn Executor>,
    /// Queues messages for Channels.
    pub outbox: Arc<dyn Outbox>,
    /// Lets the Executor choose a new ticket's name, directory and assignment text; an error refuses the accept.
    pub prepare_ticket: Option<PrepareTicket>,
    /// The clock; the system clock when absent.
    pub now: Option<Clock>,
    /// Receives each domain event with its time.
    pub emit: Option<Emit>,
}

/// How a `receive` ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiveResult {
    /// Stored and routed.
    Stored,
    /// Received before.
    Duplicate,
    /// Its Source does not listen to it.
    Filtered,
}

impl ReceiveResult {
    /// The result's name in API responses.
    pub fn as_str(self) -> &'static str {
        match self {
            ReceiveResult::Stored => "stored",
            ReceiveResult::Duplicate => "duplicate",
            ReceiveResult::Filtered => "filtered",
        }
    }
}

/// Single transactional entry point for mutating Triggers, Threads, Decisions, Tickets, and Assignments.
pub struct Engine {
    pub(crate) o: EngineOptions,
}

struct Transaction<'a> {
    repo: &'a dyn Repositories,
    done: bool,
}

impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.repo.rollback();
        }
    }
}

impl Engine {
    /// An Engine over its ports.
    pub fn new(options: EngineOptions) -> Self {
        Engine { o: options }
    }

    /// Run `work` in one transaction: committed when it returns `Ok`, rolled back on an error or a panic.
    pub fn atomic<T>(&self, work: impl FnOnce() -> Result<T>) -> Result<T> {
        self.o.repo.begin();
        let mut transaction = Transaction { repo: self.o.repo.as_ref(), done: false };
        let result = work();
        transaction.done = true;
        match &result {
            Ok(_) => self.o.repo.commit(),
            Err(_) => self.o.repo.rollback(),
        }
        result
    }

    // Shared by the parts.

    pub(crate) fn repo(&self) -> &dyn Repositories {
        self.o.repo.as_ref()
    }
    pub(crate) fn now(&self) -> String {
        self.o.now.as_ref().map(|now| now()).unwrap_or_else(crate::time::now_iso)
    }
    pub(crate) fn policy(&self) -> Arc<dyn Policy> {
        (self.o.policy)()
    }
    pub(crate) fn emit(&self, event: DomainEvent) {
        if let Some(emit) = &self.o.emit {
            emit(event, &self.now());
        }
    }
    /// The tickets whose worker decides a person's follow-up: see [`followup_owners`].
    pub(crate) fn owners(&self, trigger: &Trigger) -> Vec<String> {
        followup_owners(trigger, &Records(self.repo()))
    }
    /// Refuse a main-Session routing of a follow-up a ticket's worker still decides.
    pub(crate) fn left_to_workers(&self, trigger: &Trigger) -> Result<()> {
        let owners = self.owners(trigger);
        if owners.is_empty() {
            Ok(())
        } else {
            Err(UserError::with("workerDecides", &[("tickets", &owners.join(", "))]))
        }
    }
    pub(crate) fn disposition_or_new(&self, trigger_id: &str) -> TriggerDisposition {
        self.repo().disposition(trigger_id).unwrap_or_else(|| TriggerDisposition::at(&self.now()))
    }
    /// Record that a ticket's worker hands back a Trigger that reached the ticket, with why, and queue it for Eval when
    /// the ticket decided it and no other ticket still does. Returns whether it was queued.
    pub(crate) fn hand_back(&self, ticket_id: &str, trigger: &Trigger, reason: &str) -> bool {
        let decided = self.owners(trigger).iter().any(|id| id == ticket_id);
        let mut disposition = self.disposition_or_new(&trigger.id);
        disposition.handbacks.push(Handback { ticket_id: ticket_id.to_string(), reason: reason.to_string(), at: self.now() });
        self.repo().save_disposition(&trigger.id, &disposition);
        decided && self.owners(trigger).is_empty() && self.queue_for_eval(trigger)
    }
    /// Record that a ticket's worker took a person's message up as within the ticket, by acknowledging or answering it.
    pub(crate) fn take_up(&self, ticket_id: &str, trigger_id: &str) {
        if let Some(mut disposition) = self.repo().disposition(trigger_id) {
            if !disposition.acked.iter().any(|id| id == ticket_id) {
                disposition.acked.push(ticket_id.to_string());
                self.repo().save_disposition(trigger_id, &disposition);
            }
        }
    }
    /// Queue a Trigger on its primary Thread for the next Eval, unless it waits there already or an Eval holds it.
    pub(crate) fn queue_for_eval(&self, trigger: &Trigger) -> bool {
        let mut primary = self.thread_of(&trigger.threads[0]);
        let held = primary.evaluating.as_ref().is_some_and(|evaluation| evaluation.trigger_ids.contains(&trigger.id));
        if held || primary.pending.contains(&trigger.id) {
            return false;
        }
        primary.pending.push(trigger.id.clone());
        self.repo().save_thread(&primary);
        true
    }
    pub(crate) fn require(&self, ticket_id: &str) -> Result<Ticket> {
        self.repo().ticket(ticket_id).ok_or_else(|| UserError::new("unknownTicket"))
    }
    /// The stored Thread, or an unsaved empty Thread aggregate.
    pub(crate) fn thread_of(&self, reference: &ThreadRef) -> Thread {
        let key = thread_key(reference);
        self.repo().thread(&key).unwrap_or_else(|| Thread {
            key,
            reference: reference.clone(),
            created_at: self.now(),
            last_at: None,
            subscriptions: Vec::new(),
            context: Vec::new(),
            correlated: Vec::new(),
            pending: Vec::new(),
            evaluating: None,
            expired: None,
            meta: Default::default(),
        })
    }
    pub(crate) fn tickets_on_thread(&self, thread: &Thread) -> Vec<Ticket> {
        thread.subscriptions.iter().filter_map(|id| self.repo().ticket(id)).collect()
    }
    /// The Trigger that started a ticket.
    pub(crate) fn source(&self, ticket: &Ticket) -> Option<Trigger> {
        self.repo().trigger(&ticket.origin.trigger_id)
    }
    pub(crate) fn reaches(&self, ticket: &Ticket, trigger: &Trigger, context: bool) -> bool {
        reached(ticket, trigger, &|key| self.repo().thread(key), context)
    }

    // Sources

    /// A Source's request to take in a Trigger: store it once, fan it out to the tickets that subscribe to its Threads
    /// (to an ended one only a person's message, which resumes it at once unless processing is paused, and to none a
    /// person stopped), and queue it for Eval on its primary Thread unless a ticket's worker decides it.
    pub fn receive(&self, trigger: Trigger) -> Result<ReceiveResult> {
        self.atomic(|| self.intake_receive(trigger))
    }

    // The clock

    /// Requeues overdue Evals before recording `unavailable`, starts the Evals of Threads whose queued Triggers wait,
    /// and resumes ended tickets a person's message reached while processing was paused. While processing is paused,
    /// nothing expires. Each Eval and each ticket update takes one transaction.
    pub fn evaluate_due(&self) {
        let policy = self.policy();
        for thread in self.repo().active_threads() {
            if thread.evaluating.is_some() {
                let _ = self.atomic(|| {
                    self.evals_due(thread, policy.as_ref());
                    Ok(())
                });
            }
        }
        if policy.paused() {
            return;
        }
        for ticket in self.repo().active_tickets() {
            if !ticket.live() && !ticket.undelivered.is_empty() {
                let _ = self.atomic(|| {
                    self.tickets_wake(&ticket.id);
                    Ok(())
                });
            }
        }
        for thread in self.repo().active_threads() {
            if !thread.pending.is_empty() && thread.evaluating.is_none() {
                let _ = self.atomic(|| {
                    self.evals_start(&thread.key, policy.as_ref());
                    Ok(())
                });
            }
        }
    }

    // The main Session

    /// The candidate of the Eval that holds a Trigger, as its assessor sees it; `None` while no Eval holds it.
    pub fn candidate(&self, trigger_id: &str) -> Option<Candidate> {
        self.evals_candidate(trigger_id)
    }
    /// Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does, such as a person's
    /// explicit request the main Session routes. A Trigger that already started a ticket returns that ticket's Decision.
    /// An invalid stop is recorded as `ignore`; one judged under an older Policy as `unavailable`.
    pub fn decide(&self, trigger_id: &str, outcome: Outcome) -> Result<Decision> {
        self.atomic(|| self.evals_decide(trigger_id, outcome))
    }
    /// Attach a Trigger to a ticket that the message points at: the ticket follows the Trigger's Threads and receives it
    /// as an Input with the routing note, and the Eval that holds the Trigger ends. An ended ticket resumes under its
    /// Mandate, at once unless processing is paused.
    pub fn attach(&self, ticket_id: &str, trigger_id: &str, note: Option<&str>) -> Result<Ticket> {
        self.atomic(|| {
            // A message this ticket's worker handed back is not its work: attached here, no worker would decide it.
            if self.repo().disposition(trigger_id).is_some_and(|d| d.handed_back_by(ticket_id)) {
                return Err(UserError::new("handedBackHere"));
            }
            let trigger = self.tickets_attachable(ticket_id, trigger_id)?;
            self.evals_withdraw(&trigger);
            self.tickets_attach(ticket_id, &trigger, note)?;
            self.evals_routed(trigger_id, ticket_id);
            self.tickets_wake(ticket_id);
            self.require(ticket_id)
        })
    }
    /// Ask a running worker that waits in `waiting` state for its status; any other worker is left alone.
    pub fn request_status(&self, ticket_id: &str) -> Result<bool> {
        self.atomic(|| self.tickets_request_status(ticket_id))
    }
    /// Wake an open ticket's running worker with a Watchdog diagnostic message so it can inspect, finish or report.
    pub fn wake_worker(&self, ticket_id: &str, text: &str) -> Result<bool> {
        self.atomic(|| self.tickets_wake_worker(ticket_id, text))
    }
    /// Queue a message for the Channel its purpose names; a message queued before is not queued again.
    pub fn reply(&self, request: crate::replies::ReplyRequest) -> Result<crate::replies::Reply> {
        self.atomic(|| self.replies_reply(request))
    }

    // People, through the app or the main Session

    /// The assessor delivered an Eval's candidate to its Session: the Eval's deadline counts from now.
    pub fn candidate_delivered(&self, eval_id: &str) {
        let _ = self.atomic(|| {
            self.evals_delivered(eval_id, self.policy().as_ref());
            Ok(())
        });
    }
    /// Queue a stored Trigger for a fresh Eval, such as a person's replay; false while an Eval holds it.
    pub fn reevaluate(&self, trigger_id: &str) -> Result<bool> {
        self.atomic(|| self.evals_reevaluate(trigger_id))
    }
    /// A person dismisses the problem an unavailable Decision shows.
    pub fn dismiss(&self, decision_id: &str) -> Result<Decision> {
        self.atomic(|| self.evals_dismiss(decision_id))
    }
    /// Drop every ticket's Subscription to a Thread, until a new Decision subscribes one again.
    pub fn unsubscribe(&self, thread: &str) -> Result<bool> {
        self.atomic(|| Ok(self.tickets_drop_subscriptions(thread, true, None, None)))
    }
    /// A person stops a ticket, which withdraws its Mandate: it ends and receives nothing more.
    pub fn stop_ticket(&self, ticket_id: &str, reason: Option<&str>) -> Result<Ticket> {
        self.atomic(|| {
            self.tickets_end(ticket_id, crate::model::TicketEndBy::Human, crate::model::TicketOutcome::Stopped, None, reason)?;
            self.require(ticket_id)
        })
    }
    /// A person retries a ticket whose worker reported failed or blocked (or whose input delivery failed): the stalled
    /// Assignment ends and a new one starts under the same Mandate.
    pub fn retry_ticket(&self, ticket_id: &str) -> Result<Ticket> {
        self.atomic(|| self.tickets_retry(ticket_id))
    }

    // The Executor

    /// The Executor's fact that an Assignment runs; the Inputs that wait for it go out.
    pub fn assignment_started(&self, ticket_id: &str, assignment_id: &str) -> Result<()> {
        self.atomic(|| self.assignments_started(ticket_id, assignment_id))
    }
    /// The Executor's fact that Inputs reached the Assignment that runs the ticket, which clears a failed delivery.
    pub fn inputs_delivered(&self, ticket_id: &str, assignment_id: &str, input_ids: &[String]) -> Result<()> {
        self.atomic(|| self.assignments_delivered(ticket_id, assignment_id, input_ids))
    }
    /// The Executor's fact that the worker's Session took the messages that carried Inputs into a step.
    pub fn inputs_read(&self, ticket_id: &str, input_ids: &[String]) -> Result<()> {
        self.atomic(|| self.assignments_read(ticket_id, input_ids))
    }
    /// The Executor's fact that a turn of the worker of the Assignment that runs the ticket ended.
    pub fn turn_ended(&self, ticket_id: &str, assignment_id: &str) -> Result<()> {
        self.atomic(|| self.assignments_turn_ended(ticket_id, assignment_id))
    }
    /// The Executor's fact that delivering Inputs to the Assignment that runs the ticket failed.
    pub fn delivery_failed(&self, ticket_id: &str, assignment_id: &str, error: &str) -> Result<()> {
        self.atomic(|| self.assignments_delivery_failed(ticket_id, assignment_id, error))
    }
    /// A worker's request to mark a Thread attached to its ticket unrelated, for `reason`: only that ticket's
    /// Subscription drops.
    pub fn mark_unrelated(&self, ticket_id: &str, thread: &str, reason: &str) -> Result<()> {
        self.atomic(|| self.tickets_mark_unrelated(ticket_id, thread, reason))
    }
    /// An Executor's Subscription to a Thread it found related, for context. False when it follows the Thread already.
    pub fn follow_for_context(&self, ticket_id: &str, thread: &ThreadRef) -> Result<bool> {
        self.atomic(|| self.tickets_follow_for_context(ticket_id, thread))
    }
    /// A fact the main Session gives an open ticket's Executor as a note Input; it grants nothing.
    pub fn note(&self, ticket_id: &str, text: &str) -> Result<Ticket> {
        self.atomic(|| self.tickets_note(ticket_id, text))
    }
    /// An Executor's hand-back of a message that reached its ticket but asks for more than it. Returns whether it was
    /// queued for Eval: false while another ticket still decides it, and for one this ticket did not decide.
    pub fn handback(&self, ticket_id: &str, trigger_id: &str, reason: &str) -> Result<bool> {
        self.atomic(|| self.evals_handback(ticket_id, trigger_id, reason))
    }
    /// Record a report on an open ticket's current Assignment. A `dropped` report ends the ticket, and so does a
    /// `ready` one; a `blocked` or `failed` report holds back automated inputs until a human message arrives.
    pub fn report(&self, ticket_id: &str, report: crate::assignments::WorkerReport) -> Result<Ticket> {
        self.atomic(|| self.assignments_report(ticket_id, report))
    }
    /// Handles an assignment that was running when the host stopped: restarts it with a recovery note unless its latest
    /// report is settled and no Input reached its worker after that report.
    pub fn assignment_interrupted(&self, ticket_id: &str, assignment_id: &str) -> Result<()> {
        self.atomic(|| self.assignments_interrupted(ticket_id, assignment_id))
    }

    // Settings

    /// The Policy changed: each open ticket in `effects` is told how the change bears on it, and Evals in progress
    /// start again under the new version.
    pub fn policy_changed(&self, from: &str, to: &str, effects: &HashMap<String, PolicyEffect>) {
        let _ = self.atomic(|| {
            self.tickets_policy_changed(from, to, effects);
            self.evals_policy_changed(from, to);
            Ok(())
        });
    }
}
