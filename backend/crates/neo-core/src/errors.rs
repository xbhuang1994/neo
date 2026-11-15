//! Errors a caller's request can raise: an invalid request or one that references missing state.

use crate::reasons::fill;
use std::collections::BTreeMap;
use std::fmt;

/// User-facing error codes mapped to whether they report missing state and to their English template.
pub const USER_ERRORS: &[(&str, bool, &str)] = &[
    ("unknownTicket", true, "Unknown ticket"),
    ("unknownProblem", true, "Unavailable Eval not found"),
    ("unknownTrigger", true, "Unknown trigger"),
    ("unknownAssignment", true, "Unknown assignment"),
    ("ticketEnded", false, "Ticket has ended"),
    ("assignmentEnded", false, "Assignment has ended; a newer assignment owns this ticket"),
    ("evalFinished", false, "Eval {eval} has finished or a later eval replaced it; decide the trigger's current eval"),
    ("notAdmissible", false, "Trigger is not admissible: {reason}"),
    ("notExplicit", false, "An accept through orchestrator_route is for explicit requests from allowed senders; assess proactive candidates with orchestrator_eval and orchestrator_eval_decide"),
    ("ticketStopped", false, "A person stopped this ticket; new work needs an accept through orchestrator_route"),
    ("mandateRevoked", false, "The current policy no longer holds this ticket's mandate; new work needs an accept through orchestrator_route"),
    ("notRetryable", false, "Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed"),
    ("sourceThread", false, "This is the thread the ticket started on; it stays subscribed"),
    ("notFollowing", false, "This ticket does not follow that thread"),
    ("questionWithResult", false, "A question for a person cannot also be a ready result or an answer; report it separately"),
    ("askerWithoutQuestion", false, "The message that raised a question needs the question it raised"),
    ("notAsker", false, "A question must name the person's message that raised it, which reached this ticket"),
    ("notAnswerable", false, "An answer must name the person's question it answers, which reached this ticket"),
    ("ackEnded", false, "Ticket ended; do not acknowledge historical requests"),
    ("notReached", false, "Trigger does not belong to this worker"),
    ("handedBack", false, "This ticket handed that trigger back already"),
    ("handedBackHere", false, "The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it"),
    ("workerDecides", false, "This message reached ticket {tickets} on its thread: its worker decides whether it belongs there and hands back what does not, which then arrives as a candidate. Only a stop goes through orchestrator_route, with kind stop"),
    ("ackNoChannel", false, "Acknowledgement requires an assigned human source message"),
    ("ackNotPerson", false, "Use the original human trigger, not a bot or worker report"),
    ("notReady", false, "Ticket is not ready for delivery. Keep progress internal and wait for a verified ready report; do not relabel progress as an answer or send it through another channel."),
    ("resultSent", false, "This ticket's result already went to the person, by its worker's direct reply or an earlier reply. Do not send it again in other words; a new result needs a new ready report."),
    ("notAttention", false, "Attention requires the ticket's current attention question in human_action. Routine unfinished work stays internal."),
    ("notQuestion", false, "An answer must target the original human question, not a worker report or automated trigger"),
    ("noAnswer", false, "No worker answer is ready for this human trigger. Wait for the worker's report, or request one with orchestrator_ticket_request_status, which acts only on a worker that reported waiting; ordinary progress cannot be relabelled as an answer."),
    ("noChannel", false, "No reply channel for this ticket or trigger"),
    ("modelUnavailable", false, "The {block} model is not available: {error}"),
    ("invalid", false, "{message}"),
];

/// A refused or unanswerable request, by code; callers map `missing` to "not found" and the rest to "refused".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserError {
    /// One of [`USER_ERRORS`].
    pub code: &'static str,
    /// Values of the template's placeholders.
    pub values: BTreeMap<String, String>,
    /// Whether the request named state that does not exist.
    pub missing: bool,
    /// The English message.
    pub message: String,
}

impl UserError {
    /// An error with no template values.
    pub fn new(code: &'static str) -> Self {
        Self::with(code, &[])
    }
    /// An error with template values.
    pub fn with(code: &'static str, values: &[(&str, &str)]) -> Self {
        let (_, missing, template) = USER_ERRORS.iter().find(|(known, _, _)| *known == code).copied().unwrap_or((code, false, code));
        let values: BTreeMap<String, String> = values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let message = fill(template, &values);
        UserError { code, values, missing, message }
    }
    /// A refused request with a free-form message.
    pub fn invalid(message: &str) -> Self {
        Self::with("invalid", &[("message", message)])
    }
}

impl fmt::Display for UserError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UserError {}

/// The result of an Engine command.
pub type Result<T> = std::result::Result<T, UserError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_templates_and_marks_missing() {
        let error = UserError::with("evalFinished", &[("eval", "e1")]);
        assert!(error.message.starts_with("Eval e1 has finished"));
        assert!(!error.missing);
        assert!(UserError::new("unknownTicket").missing);
        assert_eq!(UserError::invalid("bad input").to_string(), "bad input");
    }
}
