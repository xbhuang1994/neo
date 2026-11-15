//! Domain model of a proactive agent: the concepts and their invariants, independent of any source, policy, or executor.

use crate::reasons::Reason;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// A JSON object of source-native or assessor-supplied details the core never interprets.
pub type Json = Map<String, Value>;

fn is_false(value: &bool) -> bool {
    !*value
}

/// Actor identity in the source's own vocabulary; Policy decides which actors may originate work on that Source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActorRef {
    /// The Source the actor belongs to.
    pub source: String,
    /// The actor's id on that Source.
    pub id: String,
}

/// Thread identity; the rule that derives `id` from a native event belongs to the source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadRef {
    /// The Source the thread belongs to.
    pub source: String,
    /// The thread's id on that Source.
    pub id: String,
}

/// Write-only address on a thread; the address format belongs to the source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelRef {
    /// The Source that delivers to the channel.
    pub source: String,
    /// The thread the channel writes to.
    pub thread: String,
    /// Source-native address fields.
    pub address: BTreeMap<String, String>,
}

/// Stable key of a thread across the whole domain.
pub fn thread_key(reference: &ThreadRef) -> String {
    format!("{}:{}", reference.source, reference.id)
}

/// How a sender addressed the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Addressed {
    /// By mentioning it.
    Mention,
    /// In a direct message to it.
    Direct,
}

/// One immutable event produced by a source. `text` and `meta` are untrusted external data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    /// Stable id; a trigger received twice is stored once.
    pub id: String,
    /// The Source that produced it.
    pub source: String,
    /// Every thread the trigger belongs to; the first is the primary thread that hosts its evaluation.
    pub threads: Vec<ThreadRef>,
    /// Who wrote it.
    pub actor: ActorRef,
    /// Source-declared: the event was written by a person rather than a bot or this agent.
    pub human: bool,
    /// Source-declared: the sender addressed the agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addressed: Option<Addressed>,
    /// When it happened, in canonical form.
    pub at: String,
    /// What it says.
    pub text: String,
    /// Where a reply to it goes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<ChannelRef>,
    /// A link to it, when the Source has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Source-native details for adapters; the core never interprets them.
    #[serde(default)]
    pub meta: Json,
}

/// A ticket's hand-back of a trigger as beyond the ticket.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handback {
    /// The ticket whose worker handed it back.
    pub ticket_id: String,
    /// Why.
    pub reason: String,
    /// When.
    pub at: String,
}

/// Where a trigger went after intake; it grants nothing, but decides who decides a person's follow-up (see [`followup_owners`]).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDisposition {
    /// Rejected by the source scope filter before entering the domain, for the Source's reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filtered: Option<Reason>,
    /// The Eval that holds or held it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eval_id: Option<String>,
    /// The Decision its Eval ended with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_id: Option<String>,
    /// The tickets it reached, by subscription fan-out or attached by the main Session; a ticket that ended or could not
    /// resume without its worker taking it up no longer counts.
    #[serde(default)]
    pub fanout: Vec<String>,
    /// The tickets of `fanout` it reached only on a Thread their Executor follows for context, which makes it none of theirs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<String>,
    /// A person, or the main Session for a message no ticket decides, sent it to Eval again; a hand-back does not set it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub requeued: bool,
    /// The tickets whose Executor handed it back as beyond the ticket, each once; it goes to Eval once none decides it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub handbacks: Vec<Handback>,
    /// The tickets whose Executor acknowledged it or answered it, taking it up as within the ticket.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acked: Vec<String>,
    /// When the disposition was first recorded.
    pub at: String,
}

impl TriggerDisposition {
    /// An empty disposition recorded at `at`.
    pub fn at(at: &str) -> Self {
        TriggerDisposition { at: at.to_string(), ..Default::default() }
    }
    /// Whether `ticket_id` handed the trigger back.
    pub fn handed_back_by(&self, ticket_id: &str) -> bool {
        self.handbacks.iter().any(|item| item.ticket_id == ticket_id)
    }
}

/// How strongly a trigger asks for work: a person's explicit request, or a candidate the agent inferred.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Strength {
    /// An allowed sender asked for it.
    Explicit,
    /// The agent may propose it under its rules.
    Inferred,
}

/// The cells of a receiving scope's row in the admission table, by whether the sender is listed and addresses the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdmissionCell {
    /// A listed sender who did not address the agent.
    ListedUnaddressed,
    /// An unlisted sender who addressed the agent.
    UnlistedAddressed,
    /// An unlisted sender who did not address the agent.
    UnlistedUnaddressed,
}

/// Whether proactive candidates are assessed and accepted (`auto`), assessed without accepting (`observe`), or not admitted (`off`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AcceptMode {
    /// Proactive candidates are not admitted.
    Off,
    /// Candidates are assessed and Decisions record what they would accept.
    Observe,
    /// Candidates are assessed and accepted.
    Auto,
}

/// The accept mode an inferred candidate was made under.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Observation {
    /// The accept mode at the gate.
    pub mode: AcceptMode,
}

/// How the gate admitted a Trigger.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "via", rename_all = "lowercase")]
pub enum BasisVia {
    /// A sender on the Source's list addressed the agent.
    Addressed {
        /// How.
        addressed: Addressed,
    },
    /// A message on a Thread that has tickets.
    Followup,
    /// The cell of the receiving scope's admission row; `observation` when it made an inferred candidate under an accept mode.
    Admission {
        /// The admission cell that admitted it.
        cell: AdmissionCell,
        /// How the sender addressed the agent, if at all.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        addressed: Option<Addressed>,
        /// The accept mode an inferred candidate was made under.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation: Option<Observation>,
    },
    /// A message of a bot on its Source's bot list: an inferred candidate at most, never an explicit request or a stop.
    Bot {
        /// How the bot addressed the agent, if at all.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        addressed: Option<Addressed>,
        /// The accept mode the candidate was made under.
        observation: Observation,
    },
}

/// How the gate admitted the Trigger a Mandate came from, which `revalidate` re-checks, and where it was received.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MandateBasis {
    /// The Source it was received on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The receiving scope as the Source recorded it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Json>,
    /// The admission row of the receiving scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<String>,
    /// The allowed sender at acceptance time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    /// The rules an assessment matched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<String>>,
    /// How the gate admitted it.
    #[serde(flatten)]
    pub via: BasisVia,
}

impl MandateBasis {
    /// A basis with only its admission path.
    pub fn via(via: BasisVia) -> Self {
        MandateBasis { source: None, scope: None, row: None, sender: None, rules: None, via }
    }
}

/// Immutable authorization produced by an accept decision; execution is bounded by it and it never changes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mandate {
    /// Explicit request or inferred candidate.
    pub strength: Strength,
    /// The Policy version it was accepted under.
    pub policy_version: String,
    /// How the gate admitted it, for re-validation and audit.
    pub basis: MandateBasis,
    /// Who it is for.
    pub actor: ActorRef,
    /// What it authorizes, in words.
    pub scope: String,
}

/// Active trigger evaluation on a thread; at most one exists per thread.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    /// Stable id.
    pub id: String,
    /// The thread it runs on.
    pub thread_key: String,
    /// The batch it holds.
    pub trigger_ids: Vec<String>,
    /// The admissible Trigger that gave the batch its strength, which a ticket the Eval starts takes as its origin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<String>,
    /// The batch's strength.
    pub strength: Strength,
    /// Actor of the strongest admissible trigger; seeds the mandate on accept.
    pub actor: ActorRef,
    /// Gate basis of the strongest admissible trigger; seeds the mandate on accept.
    pub basis: MandateBasis,
    /// The Policy version the gate judged under.
    pub policy_version: String,
    /// When it started.
    pub started_at: String,
    /// When the candidate reached the assessor's Session; it cannot expire before, and its deadline counts from then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered: Option<String>,
    /// Expiration timestamp; a processing pause shifts it forward by the pause duration.
    pub deadline: String,
    /// When a processing pause began; cleared on resume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_at: Option<String>,
}

/// Thread aggregate: consistency boundary of eval, holder of subscriptions and decision history.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// `source:id`.
    pub key: String,
    /// Its identity on its Source.
    #[serde(rename = "ref")]
    pub reference: ThreadRef,
    /// When it was first seen.
    pub created_at: String,
    /// Time of the newest trigger on the thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_at: Option<String>,
    /// Tickets subscribed to this thread; live ones receive every trigger as context through fan-out.
    #[serde(default)]
    pub subscriptions: Vec<String>,
    /// The subscribed tickets whose Executor follows the thread for read-only context: its messages reach them, but grant
    /// nothing, and a person's message there resumes none of them that ended.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<String>,
    /// Keys of threads that shared a trigger with this one; context only.
    #[serde(default)]
    pub correlated: Vec<String>,
    /// Triggers waiting for the next eval (debounce buffer).
    #[serde(default)]
    pub pending: Vec<String>,
    /// The Eval in progress.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluating: Option<Evaluation>,
    /// How many Evals of its queued Triggers expired in a row, each of which queued them again; a Decision clears it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expired: Option<u32>,
    /// Source-native attributes needed by channels or readers.
    #[serde(default)]
    pub meta: Json,
}

/// What an Eval ended with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DecisionKind {
    /// Nothing to do.
    Ignore,
    /// A ticket was created.
    Accept,
    /// A ticket was stopped.
    Stop,
    /// The Eval could not be decided.
    Unavailable,
}

/// Outcome of one eval, recorded on the thread.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// Stable id derived from its Eval.
    pub id: String,
    /// The Eval it ends.
    pub eval_id: String,
    /// The thread it was recorded on.
    pub thread_key: String,
    /// The batch it decides.
    pub trigger_ids: Vec<String>,
    /// The Policy version it was decided under.
    pub policy_version: String,
    /// When.
    pub at: String,
    /// What was decided.
    pub kind: DecisionKind,
    /// Why, by code: one reason, or one for each Trigger of the batch it concerns.
    pub reason: Vec<Reason>,
    /// The Eval's strength.
    pub strength: Strength,
    /// The ticket an accept created or a stop ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket_id: Option<String>,
    /// The Mandate an accept gave.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mandate: Option<Mandate>,
    /// Assessor-supplied audit data (rule assessments, direction, evidence).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit: Option<Json>,
    /// A person dismissed the problem an unavailable Decision shows.
    #[serde(default, skip_serializing_if = "is_false")]
    pub dismissed: bool,
}

/// Lifecycle of an Assignment.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssignmentState {
    /// Queued for launch.
    Pending,
    /// Its worker runs.
    Running,
    /// Over.
    Ended,
}

/// What an Assignment reports: work is in progress, its worker waits for a Trigger, a result is ready, a person must act
/// to unblock or recover it, or nothing is left to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportState {
    /// Work is in progress.
    Progress,
    /// The worker waits for a Trigger.
    Waiting,
    /// A result is ready.
    Ready,
    /// A person must act to unblock it.
    Blocked,
    /// A person must act to recover it.
    Failed,
    /// Nothing is left to do.
    Dropped,
}

/// The latest report of an Assignment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    /// What it reports.
    pub state: ReportState,
    /// In words.
    pub summary: String,
    /// When.
    pub at: String,
}

/// Binding between a ticket and one executor instance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    /// Stable id derived from the ticket and its ordinal.
    pub id: String,
    /// Its lifecycle state.
    pub state: AssignmentState,
    /// When it was created.
    pub created_at: String,
    /// When its worker started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// When it ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// Why it ended, when it ended before its ticket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_reason: Option<String>,
    /// Its latest report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<Report>,
    /// When Inputs last reached the worker; one at or after `report.at` means the worker has been busy since that report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
    /// When a turn of its worker last ended with nothing left to run for it and nothing waiting for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_at: Option<String>,
}

/// Whether a ticket's worker has read a Trigger Input.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Read {
    /// It has not been delivered to a worker's Session.
    #[default]
    Undelivered,
    /// It waits in the worker's Session.
    Waiting,
    /// The worker's Session took the message that carried it into a step at this time, from which its model reads it.
    At(String),
}

impl Read {
    fn is_undelivered(&self) -> bool {
        matches!(self, Read::Undelivered)
    }
}

impl Serialize for Read {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Read::At(at) => serializer.serialize_str(at),
            _ => serializer.serialize_none(),
        }
    }
}

impl<'de> Deserialize<'de> for Read {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        Ok(match Option::<String>::deserialize(deserializer)? {
            Some(at) => Read::At(at),
            None => Read::Waiting,
        })
    }
}

/// How a Policy change bears on one rule a ticket was accepted under.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleEffect {
    /// The rule's id.
    pub id: String,
    /// The rule's name.
    pub name: String,
    /// `changed` or `disabled`.
    pub change: String,
    /// Its instruction now, when it changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
}

/// How a Policy change bears on a ticket: the rules it was accepted under that changed or no longer apply; `proactive:
/// false` once inferred work is no longer accepted; and `requesterAllowed: false` once its requester may no longer start work.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyEffect {
    /// The rules that changed or were disabled.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<RuleEffect>,
    /// `Some(false)` once inferred work is no longer accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proactive: Option<bool>,
    /// `Some(false)` once the requester may no longer start work there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester_allowed: Option<bool>,
    /// The sender the ticket is for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester: Option<ActorRef>,
}

/// What a ticket's worker receives.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum TicketInput {
    /// A Trigger on one of its Threads, or attached to it.
    Trigger {
        /// Stable id.
        id: String,
        /// The Trigger.
        trigger_id: String,
        /// When it reached the ticket.
        at: String,
        /// The main Session's routing note.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
        /// A person wrote it.
        #[serde(default, skip_serializing_if = "is_false")]
        human: bool,
        /// It reached the ticket only on a Thread its Executor follows for context.
        #[serde(default, skip_serializing_if = "is_false")]
        context: bool,
        /// Whether the worker has read it.
        #[serde(default, skip_serializing_if = "Read::is_undelivered")]
        read_at: Read,
        /// The Assignment it was last delivered to.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delivered_to: Option<String>,
    },
    /// The Policy changed in a way that bears on the ticket, as `effect` says.
    PolicyChanged {
        /// Stable id.
        id: String,
        /// The Policy version before.
        from: String,
        /// The Policy version after.
        to: String,
        /// When.
        at: String,
        /// How it bears on the ticket.
        effect: PolicyEffect,
    },
    /// A human's message on one of its Threads resumed the ended ticket under its unchanged Mandate.
    Resumed {
        /// Stable id.
        id: String,
        /// The message that resumed it.
        trigger_id: String,
        /// When.
        at: String,
    },
    /// Text from the host, such as a status request or a recovery note.
    Text {
        /// Stable id.
        id: String,
        /// The text.
        text: String,
        /// When.
        at: String,
    },
    /// A fact the main Session gave the ticket from other work: context, which asks for nothing and grants nothing.
    Note {
        /// Stable id.
        id: String,
        /// The fact.
        text: String,
        /// When.
        at: String,
    },
}

impl TicketInput {
    /// The Input's id.
    pub fn id(&self) -> &str {
        match self {
            TicketInput::Trigger { id, .. }
            | TicketInput::PolicyChanged { id, .. }
            | TicketInput::Resumed { id, .. }
            | TicketInput::Text { id, .. }
            | TicketInput::Note { id, .. } => id,
        }
    }
    /// When the Input was added.
    pub fn at(&self) -> &str {
        match self {
            TicketInput::Trigger { at, .. }
            | TicketInput::PolicyChanged { at, .. }
            | TicketInput::Resumed { at, .. }
            | TicketInput::Text { at, .. }
            | TicketInput::Note { at, .. } => at,
        }
    }
    /// The Trigger a trigger Input carries.
    pub fn trigger_id(&self) -> Option<&str> {
        match self {
            TicketInput::Trigger { trigger_id, .. } => Some(trigger_id),
            _ => None,
        }
    }
    /// Whether it is a message no person wrote, such as a bot's or the main Session's note.
    pub fn automatic(&self) -> bool {
        matches!(self, TicketInput::Note { .. } | TicketInput::Trigger { human: false, .. })
    }
}

/// Who ended a ticket.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TicketEndBy {
    /// Its worker's report.
    Executor,
    /// A person.
    Human,
}

/// How a ticket ended: with its result, with nothing to do, or stopped by a person.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TicketOutcome {
    /// With its result.
    Completed,
    /// With nothing to do.
    Dropped,
    /// Stopped by a person.
    Stopped,
}

impl TicketOutcome {
    /// The outcome's name as stored.
    pub fn as_str(self) -> &'static str {
        match self {
            TicketOutcome::Completed => "completed",
            TicketOutcome::Dropped => "dropped",
            TicketOutcome::Stopped => "stopped",
        }
    }
}

/// When, by whom, and how a ticket ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ended {
    /// When.
    pub at: String,
    /// By whom.
    pub by: TicketEndBy,
    /// How.
    pub outcome: TicketOutcome,
    /// A person's or the host's reason beyond the outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// A question for a person; `trigger_id` is the human message that raised it, whose conversation it goes back to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    /// Stable id.
    pub id: String,
    /// The question.
    pub question: String,
    /// The message that raised it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_id: Option<String>,
}

/// The Triggers a ticket was accepted from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    /// The one that started it.
    pub trigger_id: String,
    /// The batch its Eval held.
    pub trigger_ids: Vec<String>,
}

/// What a ticket's Executor chose: its short name, directory and assignment text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Execution {
    /// Short name.
    pub name: String,
    /// Working directory.
    pub directory: String,
    /// The assignment text its worker starts from.
    pub assignment: String,
}

/// The latest failed delivery of an Input to a ticket's worker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliveryFailure {
    /// What went wrong.
    pub error: String,
    /// When.
    pub at: String,
}

/// Ticket aggregate: an authorized work item with its assignments, channels and inputs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    /// Stable id derived from its Eval.
    pub id: String,
    /// What it is, in a line.
    pub title: String,
    /// The accept that created it.
    pub decision_id: String,
    /// What authorizes it.
    pub mandate: Mandate,
    /// The Channels of the messages it was accepted from, which its replies go to.
    #[serde(default)]
    pub channels: Vec<ChannelRef>,
    /// When, by whom, and how the ticket ended; an open ticket has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended: Option<Ended>,
    /// Open question for a person; cleared by the executor or when the ticket ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention: Option<Attention>,
    /// Its Assignments, oldest first; the latest is the only one that can be pending or running.
    #[serde(default)]
    pub assignments: Vec<Assignment>,
    /// Everything its worker received or will receive.
    #[serde(default)]
    pub inputs: Vec<TicketInput>,
    /// Inputs not yet handed to a running assignment.
    #[serde(default)]
    pub undelivered: Vec<String>,
    /// People's questions the worker answered, whose answers the main Session may send.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub answers: Vec<String>,
    /// A short description of what the ticket is about, kept current by its worker's reports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    /// When it was created.
    pub created_at: String,
    /// When it last changed.
    pub updated_at: String,
    /// The Triggers it was accepted from.
    pub origin: Origin,
    /// What its Executor chose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<Execution>,
    /// The latest failed delivery of an Input to its worker, until a delivery succeeds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<DeliveryFailure>,
    /// When the report was made whose result a person was sent: that report's result is not sent a second time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_sent: Option<String>,
}

impl Ticket {
    /// Whether the ticket is open: it has not ended.
    pub fn live(&self) -> bool {
        self.ended.is_none()
    }
    /// Whether a person stopped it, which withdrew its Mandate.
    pub fn stopped_by_person(&self) -> bool {
        self.ended.as_ref().is_some_and(|ended| ended.by == TicketEndBy::Human)
    }
    /// The Assignment whose worker runs.
    pub fn running(&self) -> Option<&Assignment> {
        self.assignments.iter().find(|assignment| assignment.state == AssignmentState::Running)
    }
    /// The Assignment whose worker runs, to change it.
    pub fn running_mut(&mut self) -> Option<&mut Assignment> {
        self.assignments.iter_mut().find(|assignment| assignment.state == AssignmentState::Running)
    }
    /// The latest Assignment.
    pub fn latest(&self) -> Option<&Assignment> {
        self.assignments.last()
    }
    /// The latest report any of its Assignments made, which is what the ticket last said.
    pub fn latest_report(&self) -> Option<&Report> {
        self.assignments.iter().rev().find_map(|assignment| assignment.report.as_ref())
    }
    /// The Input with this id.
    pub fn input(&self, id: &str) -> Option<&TicketInput> {
        self.inputs.iter().find(|input| input.id() == id)
    }
    /// Whether the Trigger came to the ticket as an Input.
    pub fn has_trigger_input(&self, trigger_id: &str) -> bool {
        self.inputs.iter().any(|input| input.trigger_id() == Some(trigger_id))
    }
    /// Until when its worker had a turn to read what reached it: its latest report (a progress report only when
    /// `progress`), or the end of its latest turn, whichever is later.
    pub fn read_until(&self, progress: bool) -> String {
        let report = self
            .assignments
            .iter()
            .rev()
            .find_map(|assignment| assignment.report.as_ref().filter(|report| progress || report.state != ReportState::Progress))
            .map(|report| report.at.as_str())
            .unwrap_or("");
        self.assignments.iter().filter_map(|assignment| assignment.idle_at.as_deref()).fold(report, |a, b| if a > b { a } else { b }).to_string()
    }
    /// Whether it waits for a person: its latest Assignment reported blocked or failed, and no person's message reached
    /// it since. A later report that is neither, a person's message, or a retry lifts it.
    pub fn waits_for_person(&self) -> bool {
        let Some(report) = self.latest().and_then(|assignment| assignment.report.as_ref()) else {
            return false;
        };
        if !matches!(report.state, ReportState::Blocked | ReportState::Failed) {
            return false;
        }
        !self.inputs.iter().any(|input| matches!(input, TicketInput::Trigger { human: true, context: false, at, .. } if at.as_str() > report.at.as_str()))
    }
}

/// What deciding a follow-up's owners reads: the stored tickets, Threads and dispositions.
pub trait FollowupRecords {
    /// The stored ticket.
    fn ticket(&self, id: &str) -> Option<Ticket>;
    /// The stored Thread.
    fn thread(&self, key: &str) -> Option<Thread>;
    /// The stored disposition of a Trigger.
    fn disposition(&self, id: &str) -> Option<TriggerDisposition>;
}

/// The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
/// and did not hand it back. A ticket can while it is live, and while it is ended, not by a person, with the Trigger
/// waiting to resume it. None once a person sent it to Eval, or while an Eval holds it. While a ticket owns it, the
/// message goes to no Eval, and the main Session may only stop the work on it.
pub fn followup_owners(trigger: &Trigger, records: &dyn FollowupRecords) -> Vec<String> {
    if !trigger.human {
        return Vec::new();
    }
    let Some(disposition) = records.disposition(&trigger.id) else {
        return Vec::new();
    };
    if disposition.requeued {
        return Vec::new();
    }
    // The disposition alone rules most messages out, so a Thread or a ticket is read only for one that may have an owner.
    let reached: Vec<&String> = disposition.fanout.iter().filter(|id| !disposition.handed_back_by(id) && !disposition.context.contains(id)).collect();
    if reached.is_empty() {
        return Vec::new();
    }
    let held = trigger
        .threads
        .first()
        .and_then(|reference| records.thread(&thread_key(reference)))
        .and_then(|thread| thread.evaluating)
        .is_some_and(|evaluation| evaluation.trigger_ids.contains(&trigger.id));
    if held {
        return Vec::new();
    }
    reached
        .into_iter()
        .filter(|id| {
            records.ticket(id).is_some_and(|ticket| {
                ticket.live()
                    || (!ticket.stopped_by_person()
                        && ticket
                            .inputs
                            .iter()
                            .any(|input| input.trigger_id() == Some(trigger.id.as_str()) && ticket.undelivered.iter().any(|u| u == input.id())))
            })
        })
        .cloned()
        .collect()
}

/// Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that
/// ticket's work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
pub fn settled(decision: &Decision) -> bool {
    !matches!(decision.kind, DecisionKind::Stop | DecisionKind::Unavailable)
        && !decision.reason.iter().any(|reason| matches!(reason.code.as_str(), "stopNotExplicit" | "stopUnknown" | "routed"))
}

/// Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket
/// subscribes to; with `context` false, not a Thread the ticket follows only for context.
pub fn reached(ticket: &Ticket, trigger: &Trigger, thread: &dyn Fn(&str) -> Option<Thread>, context: bool) -> bool {
    if ticket.origin.trigger_id == trigger.id {
        return true;
    }
    let threads: Vec<Option<Thread>> = trigger.threads.iter().map(|reference| thread(&thread_key(reference))).collect();
    let follows = |current: &Thread| current.context.contains(&ticket.id);
    if threads.iter().flatten().any(|current| current.subscriptions.contains(&ticket.id) && (context || !follows(current))) {
        return true;
    }
    ticket.has_trigger_input(&trigger.id) && (context || !threads.iter().all(|current| current.as_ref().is_some_and(follows)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inputs_keep_their_stored_shape() {
        let input = TicketInput::Trigger {
            id: "i1".into(),
            trigger_id: "g1".into(),
            at: "2026-01-01T00:00:00.000Z".into(),
            note: None,
            human: true,
            context: false,
            read_at: Read::Undelivered,
            delivered_to: None,
        };
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json, serde_json::json!({"kind": "trigger", "id": "i1", "triggerId": "g1", "at": "2026-01-01T00:00:00.000Z", "human": true}));
        let waiting: TicketInput =
            serde_json::from_value(serde_json::json!({"kind": "trigger", "id": "i1", "triggerId": "g1", "at": "t", "readAt": null})).unwrap();
        assert!(matches!(waiting, TicketInput::Trigger { read_at: Read::Waiting, .. }));
        assert_eq!(serde_json::to_value(&waiting).unwrap()["readAt"], Value::Null);
        let changed = TicketInput::PolicyChanged { id: "p".into(), from: "a".into(), to: "b".into(), at: "t".into(), effect: PolicyEffect::default() };
        assert_eq!(serde_json::to_value(&changed).unwrap()["kind"], "policy-changed");
    }

    #[test]
    fn basis_flattens_its_admission_path() {
        let basis = MandateBasis { sender: Some("web:local".into()), ..MandateBasis::via(BasisVia::Addressed { addressed: Addressed::Direct }) };
        let json = serde_json::to_value(&basis).unwrap();
        assert_eq!(json, serde_json::json!({"sender": "web:local", "via": "addressed", "addressed": "direct"}));
        assert_eq!(serde_json::from_value::<MandateBasis>(json).unwrap(), basis);
        let cell = MandateBasis::via(BasisVia::Admission {
            cell: AdmissionCell::ListedUnaddressed,
            addressed: None,
            observation: Some(Observation { mode: AcceptMode::Auto }),
        });
        assert_eq!(serde_json::to_value(&cell).unwrap(), serde_json::json!({"via": "admission", "cell": "listedUnaddressed", "observation": {"mode": "auto"}}));
    }
}
