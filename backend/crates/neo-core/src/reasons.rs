//! Structured reason codes and templates for decisions, filtered triggers, and ended assignments.
//! Policy gates and source scopes may also emit their own literal reason codes.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Reason codes the core emits, with their English templates.
pub const REASONS: &[(&str, &str)] = &[
    ("said", "{text}"),
    ("timeout", "Assessment timed out"),
    ("policyChanged", "Policy changed during assessment"),
    ("noAdmissible", "No admissible trigger"),
    ("startedTicket", "Already started ticket {ticket}"),
    ("acceptedBefore", "Trigger {trigger} was accepted before"),
    ("routed", "Routed to ticket {ticket}"),
    ("explicitRouted", "Explicit request from an allowed sender routed by the orchestrator"),
    ("humanStop", "Human asked to stop"),
    ("forwarded", "Forwarded to the worker of the Ticket already on this Thread"),
    ("senderNotMember", "The sender is not on the Source's list"),
    ("retried", "Retried by a person"),
    ("hostRestarted", "neo-agent restarted"),
    ("stopUnknown", "Stop target is unknown or already ended"),
    ("stopNotExplicit", "A stop needs an explicit request from a sender on the list"),
    ("directionUnsettled", "Implementation intent or target direction is not established, or a product/design decision is still required"),
    ("noRuleMatched", "No enabled admission rule matched"),
    ("ignoredFromCard", "Ignored from its card, without a rule assessment"),
    ("observed", "Observe mode: would accept ({text})"),
];

/// Reason code and template values; `trigger_id` identifies the trigger in a batch that the reason applies to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reason {
    /// One of [`REASONS`], or a literal code a gate or scope emitted.
    pub code: String,
    /// Values for the template's placeholders.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub values: BTreeMap<String, String>,
    /// The trigger of a batch this reason applies to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_id: Option<String>,
}

impl Reason {
    /// A reason with no values.
    pub fn code(code: &str) -> Self {
        Reason { code: code.to_string(), values: BTreeMap::new(), trigger_id: None }
    }
    /// A reason with one template value.
    pub fn with(code: &str, name: &str, value: &str) -> Self {
        Reason { code: code.to_string(), values: BTreeMap::from([(name.to_string(), value.to_string())]), trigger_id: None }
    }
    /// The same reason, for one trigger of a batch.
    pub fn of(mut self, trigger_id: &str) -> Self {
        self.trigger_id = Some(trigger_id.to_string());
        self
    }
}

/// The reason an assessor or a person gave in words.
pub fn said(text: &str) -> Reason {
    Reason::with("said", "text", text)
}

/// Replaces `{name}` placeholders with their values; unknown placeholders stay.
pub fn fill(template: &str, values: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) if after[..close].chars().all(|c| c.is_alphanumeric() || c == '_') && close > 0 => {
                match values.get(&after[..close]) {
                    Some(value) => out.push_str(value),
                    None => out.push_str(&rest[open..open + close + 2]),
                }
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Formats reasons in English (prefixed by the trigger id when present) for agent consumption.
pub fn reason_text(reasons: &[Reason]) -> String {
    reasons
        .iter()
        .map(|reason| {
            let template = REASONS.iter().find(|(code, _)| *code == reason.code).map(|(_, t)| *t).unwrap_or(&reason.code);
            let text = fill(template, &reason.values);
            match &reason.trigger_id {
                Some(id) => format!("{id}: {text}"),
                None => text,
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_and_literal_codes() {
        assert_eq!(reason_text(&[said("because")]), "because");
        assert_eq!(reason_text(&[Reason::with("routed", "ticket", "t1").of("g1"), Reason::code("no_mention")]), "g1: Routed to ticket t1; no_mention");
        assert_eq!(fill("keep {missing} and {x}", &BTreeMap::from([("x".into(), "1".into())])), "keep {missing} and 1");
    }
}
