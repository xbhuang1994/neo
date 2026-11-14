//! Ports the core depends on. Sources, policies, assessors, executors, and channels are project-specific.

use crate::model::{
    Assignment, ChannelRef, Decision, DecisionKind, FollowupRecords, Json, Mandate, MandateBasis, Strength, Thread, Ticket, TicketEndBy, TicketOutcome,
    Trigger, TriggerDisposition,
};
use crate::reasons::Reason;

/// Gate admission result: either inadmissible with a reason code, or admissible with strength and basis.
#[derive(Clone, Debug, PartialEq)]
pub enum GateResult {
    /// The trigger may not originate work, for this reason code.
    Inadmissible {
        /// The gate's reason code.
        reason: String,
    },
    /// The trigger may originate work.
    Admissible {
        /// Explicit request or inferred candidate.
        strength: Strength,
        /// How the gate admitted it.
        basis: MandateBasis,
    },
}

/// Whether a Source receives a Trigger.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScopeResult {
    /// The Source listens to it.
    Listened {
        /// It also receives messages not addressed to the agent.
        observed: bool,
        /// The receiving scope the Policy's admission table names, such as a chat.
        row: Option<String>,
        /// `false` keeps the Source's Threads subscribed but sends none of their Triggers to subscribed tickets: the
        /// main Session routes each one to a single ticket.
        fanout: bool,
    },
    /// The Source does not listen to it, for this reason code.
    Ignored {
        /// The scope's reason code.
        reason: String,
    },
}

/// Source configuration as the domain sees it: listening scope per trigger or per recorded Mandate basis.
pub trait SourceScope: Send + Sync {
    /// Whether the Source `source` receives an event with these native details.
    fn scope(&self, source: &str, meta: &Json) -> ScopeResult;
}

/// Versioned rules; `gate` decides who may originate work. Source scope is not part of Policy.
pub trait Policy: Send + Sync {
    /// The version of the rules.
    fn version(&self) -> String;
    /// Whether processing is paused.
    fn paused(&self) -> bool;
    /// Whether a trigger may originate work on its thread.
    fn gate(&self, trigger: &Trigger, thread: &Thread, tickets: &[Ticket]) -> GateResult;
    /// Re-check a mandate's gate-layer basis under this policy, such as before an ended ticket resumes.
    fn revalidate(&self, mandate: &Mandate) -> bool;
    /// Whether an inferred candidate may be accepted on the rules its assessment matched.
    fn admits_inferred(&self, rules: &[String]) -> bool;
    /// How long an assessor may take before an eval is recorded as unavailable.
    fn eval_timeout_ms(&self) -> i64;
}

/// What the assessor receives: bounded facts, never authority.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    /// The Eval to decide.
    pub eval_id: String,
    /// The thread it runs on.
    pub thread: Thread,
    /// The batch it holds.
    pub triggers: Vec<Trigger>,
    /// The batch's strength.
    pub strength: Strength,
    /// The Policy version the gate judged under.
    pub policy_version: String,
    /// Every ticket on the thread, including ended ones, for duplicate judgement.
    pub tickets: Vec<Ticket>,
}

/// Why an outcome was decided: a code it carries, or the words its assessor or person wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Why {
    /// In words.
    Said(String),
    /// By code.
    Code(Reason),
}

impl Why {
    pub(crate) fn reasons(&self) -> Vec<Reason> {
        vec![match self {
            Why::Said(text) => crate::reasons::said(text),
            Why::Code(reason) => reason.clone(),
        }]
    }
}

impl From<&str> for Why {
    fn from(text: &str) -> Self {
        Why::Said(text.to_string())
    }
}

/// An accept: the ticket to create.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Accept {
    /// The ticket's title.
    pub title: String,
    /// What the Mandate authorizes, in words.
    pub scope: String,
    /// The acknowledgement to send where the request was written.
    pub acknowledgement: Option<String>,
    /// The rules the assessment matched.
    pub rules: Option<Vec<String>>,
    /// The ticket's requested short name.
    pub name: Option<String>,
    /// A routing note for its worker.
    pub note: Option<String>,
}

/// What an assessment decided.
#[derive(Clone, Debug, PartialEq)]
pub enum OutcomeKind {
    /// Nothing to do.
    Ignore,
    /// The Eval could not be decided.
    Unavailable,
    /// Create a ticket.
    Accept(Accept),
    /// Stop a ticket.
    Stop {
        /// The ticket to stop.
        ticket_id: String,
    },
}

/// An outcome for the Eval that holds a Trigger.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    /// What was decided.
    pub kind: OutcomeKind,
    /// Why.
    pub reason: Why,
    /// Assessor-supplied audit data.
    pub audit: Option<Json>,
    /// The Eval it was judged for, so a later Eval refuses it.
    pub eval_id: Option<String>,
}

impl Outcome {
    /// An outcome with no audit, for whichever Eval holds the trigger.
    pub fn new(kind: OutcomeKind, reason: impl Into<Why>) -> Self {
        Outcome { kind, reason: reason.into(), audit: None, eval_id: None }
    }
    pub(crate) fn kind_name(&self) -> &'static str {
        match self.kind {
            OutcomeKind::Ignore => "ignore",
            OutcomeKind::Unavailable => "unavailable",
            OutcomeKind::Accept(_) => "accept",
            OutcomeKind::Stop { .. } => "stop",
        }
    }
}

/// Semantic judgement. `request` queues the assessment, idempotently per Eval; the outcome returns through `Engine::decide`.
pub trait Assessor: Send + Sync {
    /// Queue the assessment of a candidate.
    fn request(&self, candidate: Candidate);
    /// Called whenever an eval ends, decided or not, so the assessor drops what it kept for it.
    fn release(&self, _eval_id: &str) {}
}

/// Executes assignments; concurrency and workspace management are its own concern. The Engine calls it inside its
/// commands, so each method only queues work, which reports back through the Engine's callbacks.
pub trait Executor: Send + Sync {
    /// Queue a pending assignment for launch.
    fn start(&self, ticket: &Ticket, assignment: &Assignment);
    /// Queue delivery of the ticket's waiting Inputs to its running assignment.
    fn deliver(&self, ticket: &Ticket, assignment: &Assignment);
    /// End an assignment's work; called after the ticket or assignment has already ended in the domain.
    fn stop(&self, ticket: &Ticket, assignment: &Assignment, reason: &str);
}

/// What a queued message is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageKind {
    /// "Got it" for a request the agent works on.
    Acknowledgement,
    /// An answer, a result, or a question for a person.
    Reply,
    /// A notice from the host.
    Notice,
}

/// A message for a Channel; `ticket_id` names the Ticket it is for, when there is one.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundMessage {
    /// Deterministic id that keeps it from going out twice.
    pub id: String,
    /// Where it goes.
    pub channel: ChannelRef,
    /// What it says.
    pub text: String,
    /// What it is.
    pub kind: MessageKind,
    /// The ticket it is for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket_id: Option<String>,
}

/// A queued message waits, went out, or was dropped because its conversation can never receive it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReplyStatus {
    /// It waits to go out.
    Pending,
    /// It went out.
    Sent,
    /// Its conversation can never receive it.
    Dropped,
}

/// The messages queued for Channels; the Engine queues them inside its commands, and a sender delivers them later.
pub trait Outbox: Send + Sync {
    /// Queue a message idempotently; an id queued before keeps its first message.
    fn send(&self, message: OutboundMessage);
    /// Whether a message was queued, and what became of it.
    fn status(&self, id: &str) -> Option<ReplyStatus>;
    /// Withdraw a message that has not gone out.
    fn withdraw(&self, id: &str);
}

/// What the Engine reports after a change.
#[derive(Clone, Debug, PartialEq)]
#[allow(missing_docs)]
pub enum DomainEvent {
    TriggerReceived {
        trigger_id: String,
        threads: Vec<String>,
    },
    EvalStarted {
        eval_id: String,
        thread_key: String,
        trigger_ids: Vec<String>,
        strength: Strength,
    },
    DecisionRecorded {
        decision_id: String,
        kind: DecisionKind,
        thread_key: String,
    },
    TicketCreated {
        ticket_id: String,
        decision_id: String,
        strength: Strength,
    },
    TicketResumed {
        ticket_id: String,
        trigger_id: String,
    },
    TicketEnded {
        ticket_id: String,
        by: TicketEndBy,
        outcome: TicketOutcome,
        reason: Option<String>,
    },
    AssignmentStarted {
        ticket_id: String,
        assignment_id: String,
    },
    AssignmentEnded {
        ticket_id: String,
        assignment_id: String,
        reason: String,
    },
    ThreadSubscribed {
        thread_key: String,
        ticket_id: String,
    },
    /// A person dropped every ticket's Subscription (`by_person`), or a ticket's Executor its own, for `reason`.
    ThreadUnsubscribed {
        thread_key: String,
        ticket_id: String,
        by_person: bool,
        reason: Option<String>,
    },
    TriggerRequeued {
        trigger_id: String,
    },
    /// A person's follow-up that reached tickets left the Eval queue.
    TriggerFollowup {
        trigger_id: String,
    },
    PolicyChanged {
        from: String,
        to: String,
    },
}

/// Durable state. Every method is synchronous so a transaction can wrap a unit of work; values are returned by copy, so
/// a caller's changes reach the store only through `save_*`.
pub trait Repositories: Send + Sync {
    /// Open a (possibly nested) transaction.
    fn begin(&self);
    /// Commit the innermost transaction.
    fn commit(&self);
    /// Roll the innermost transaction back.
    fn rollback(&self);

    /// The stored Trigger.
    fn trigger(&self, id: &str) -> Option<Trigger>;
    /// Store a Trigger.
    fn save_trigger(&self, trigger: &Trigger);
    /// The stored disposition of a Trigger.
    fn disposition(&self, id: &str) -> Option<TriggerDisposition>;
    /// Store a Trigger's disposition.
    fn save_disposition(&self, id: &str, value: &TriggerDisposition);

    /// The stored Thread.
    fn thread(&self, key: &str) -> Option<Thread>;
    /// Store a Thread.
    fn save_thread(&self, thread: &Thread);
    /// Every Thread.
    fn threads(&self) -> Vec<Thread>;
    /// Threads with Triggers queued for Eval or an Eval in progress.
    fn active_threads(&self) -> Vec<Thread>;

    /// The stored ticket.
    fn ticket(&self, id: &str) -> Option<Ticket>;
    /// Store a ticket.
    fn save_ticket(&self, ticket: &Ticket);
    /// Every ticket, newest first.
    fn tickets(&self) -> Vec<Ticket>;
    /// Tickets that have not ended, newest first.
    fn open_tickets(&self) -> Vec<Ticket>;
    /// Tickets with undelivered Inputs or a pending or running Assignment.
    fn active_tickets(&self) -> Vec<Ticket>;

    /// The stored Decision.
    fn decision(&self, id: &str) -> Option<Decision>;
    /// Store a Decision.
    fn save_decision(&self, decision: &Decision);
    /// A Thread's Decisions, oldest first.
    fn decisions_by_thread(&self, key: &str) -> Vec<Decision>;
}

/// A repository as what deciding a follow-up's owners reads (see [`crate::model::followup_owners`]).
pub struct Records<'a>(pub &'a dyn Repositories);

impl FollowupRecords for Records<'_> {
    fn ticket(&self, id: &str) -> Option<Ticket> {
        self.0.ticket(id)
    }
    fn thread(&self, key: &str) -> Option<Thread> {
        self.0.thread(key)
    }
    fn disposition(&self, id: &str) -> Option<TriggerDisposition> {
        self.0.disposition(id)
    }
}
