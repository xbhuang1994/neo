//! What the main Session hears outside its own turns: notices injected without waking it, and relays that steer it.

use crate::cards::{brief_card, card_state, trigger_message};
use crate::text::clip;
use neo_core::assignments::{Question, WorkerReport};
use neo_core::ids::key;
use neo_core::model::{followup_owners, FollowupRecords, ReportState, Ticket};
use neo_core::ports::DomainEvent;
use neo_kernel::types::uuid;
use serde_json::{json, Value};

/// A background notice for the main Session: `name` is its coalescing key in the effect queue, so a newer notice of
/// the same name replaces an unsent one.
#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    /// The coalescing key.
    pub name: String,
    /// What the model reads.
    pub value: Value,
}

/// A steering message for the main Session: `id` is the request id that makes its delivery idempotent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Relay {
    /// The request id.
    pub id: String,
    /// The message.
    pub text: String,
}

/// A one-off notice: its unique name keeps repeated occurrences from coalescing.
pub fn receipt_notice(value: Value) -> Notice {
    Notice { name: key(&["receipt", &uuid()]), value }
}

/// The settings were saved: which block, and the paths that changed.
pub fn settings_notice(block: &str, changed: &[String]) -> Notice {
    Notice { name: format!("settings:{block}"), value: json!({"settings_saved": block, "changed": changed}) }
}

/// Up to 20 dot-separated paths where two values differ, such as `eval.mode` or `policy.rules.1.enabled`.
pub fn changed_paths(before: &Value, after: &Value) -> Vec<String> {
    fn walk(before: &Value, after: &Value, path: &str, out: &mut Vec<String>) {
        if before == after || out.len() >= 20 {
            return;
        }
        let child = |name: &str| if path.is_empty() { name.to_string() } else { format!("{path}.{name}") };
        match (before, after) {
            (Value::Object(a), Value::Object(b)) => {
                let mut names: Vec<&String> = a.keys().chain(b.keys()).collect();
                names.sort();
                names.dedup();
                for name in names {
                    walk(a.get(name).unwrap_or(&Value::Null), b.get(name).unwrap_or(&Value::Null), &child(name), out);
                }
            }
            (Value::Array(a), Value::Array(b)) => {
                for index in 0..a.len().max(b.len()) {
                    walk(a.get(index).unwrap_or(&Value::Null), b.get(index).unwrap_or(&Value::Null), &child(&index.to_string()), out);
                }
            }
            _ => out.push(path.to_string()),
        }
    }
    let mut out = Vec::new();
    walk(before, after, "", &mut out);
    out.truncate(20);
    out
}

/// The notice an unsolicited domain event makes for the main Session, if any.
pub fn event_notice(event: &DomainEvent, at: &str, ticket: impl Fn(&str) -> Option<Ticket>) -> Option<Notice> {
    match event {
        DomainEvent::TicketEnded { ticket_id, by, outcome, reason } => Some(receipt_notice(match ticket(ticket_id) {
            Some(ended) => json!({"ticket_ended": brief_card(&ended)}),
            None => {
                json!({"ticket_ended": ticket_id, "by": by, "outcome": outcome, "reason": reason.clone().unwrap_or_else(|| outcome.as_str().into()), "at": at})
            }
        })),
        DomainEvent::TriggerRequeued { trigger_id } => {
            Some(receipt_notice(json!({"trigger_requeued": trigger_id, "read": format!("trigger/{trigger_id}"), "at": at})))
        }
        DomainEvent::ThreadUnsubscribed { thread_key, by_person: true, .. } => Some(Notice {
            name: format!("subscription:{thread_key}"),
            value: json!({"subscription_changes": [{"thread": thread_key, "removed": true}], "at": at}),
        }),
        DomainEvent::ThreadUnsubscribed { thread_key, ticket_id, reason, .. } => Some(receipt_notice(json!({
            "thread_unrelated": {"ticket_id": ticket_id, "thread": thread_key, "reason": reason}, "at": at,
            "note": "Its Executor found this thread unrelated after reading it; attach later triggers there to this ticket only when they point at it explicitly.",
        }))),
        _ => None,
    }
}

/// A ticket's worker follows a related thread for context only.
pub fn thread_followed_notice(ticket_id: &str, thread: &str, reason: &str) -> Notice {
    receipt_notice(
        json!({"thread_followed": {"ticket_id": ticket_id, "thread": thread, "reason": reason}, "note": "For context only: its messages reach this ticket and grant nothing."}),
    )
}

const FOLLOWUP_NOTE: &str =
    "Its ticket's worker has it and decides; act only if the person asks to stop the work (orchestrator_route kind stop with this trigger_id).";

/// The relay for a person's follow-up that reached at least one live ticket whose worker decides it; `None` otherwise.
pub fn followup_relay(records: &dyn FollowupRecords, trigger: &neo_core::model::Trigger) -> Option<Relay> {
    if followup_owners(trigger, records).is_empty() {
        return None;
    }
    let disposition = records.disposition(&trigger.id)?;
    let tickets: Vec<Value> = disposition
        .fanout
        .iter()
        .filter_map(|id| records.ticket(id).filter(Ticket::live))
        .map(|ticket| {
            let mut line = json!({"ticket_id": ticket.id, "title": ticket.title, "state": card_state(&ticket)});
            if disposition.context.contains(&ticket.id) {
                line["context"] = true.into();
            }
            line
        })
        .collect();
    if tickets.is_empty() {
        return None;
    }
    let mut message = trigger_message(trigger, None);
    message["kind"] = "follow_up".into();
    message["delivered_to"] = tickets.into();
    message["note"] = FOLLOWUP_NOTE.into();
    Some(Relay { id: format!("followup:{}", trigger.id), text: message.to_string() })
}

/// A worker's report as the main Session hears it; a long summary is cut and stays readable as the ticket's result.
pub fn result_relay(ticket: &Ticket, state: &str, text: &str, reply_to: Option<&str>) -> Relay {
    let id = key(&["worker-result", &ticket.id, &ticket.updated_at, text]);
    let mut report = json!({"kind": "worker_report", "ticket": brief_card(ticket), "trigger_id": ticket.origin.trigger_id, "state": state});
    if let Some(reply_to) = reply_to {
        report["answer_to"] = reply_to.into();
    }
    report["summary"] = clip(text, 600).into();
    if text.chars().count() > 600 {
        report["chars"] = text.chars().count().into();
    }
    report["read"] = format!("ticket/{}/result", ticket.id).into();
    Relay { id: format!("report:{id}"), text: report.to_string() }
}

pub(crate) fn state_name(state: ReportState) -> &'static str {
    match state {
        ReportState::Progress => "progress",
        ReportState::Waiting => "waiting",
        ReportState::Ready => "ready",
        ReportState::Blocked => "blocked",
        ReportState::Failed => "failed",
        ReportState::Dropped => "dropped",
    }
}

/// The relay a recorded worker report makes: a question for a person is an attention relay, and a result, blocker,
/// end, or answer is a report relay, while routine progress stays internal.
pub fn report_relay(ticket: &Ticket, report: &WorkerReport) -> Option<Relay> {
    if let (Question::Ask(_), Some(asked)) = (&report.question, &ticket.attention) {
        let text = json!({"kind": "worker_attention", "ticket": brief_card(ticket), "state": state_name(report.state), "read": format!("ticket/{}/result", ticket.id)});
        return Some(Relay { id: format!("attention:{}:{}", ticket.id, asked.id), text: text.to_string() });
    }
    if report.state == ReportState::Progress && report.answers.is_none() {
        return None;
    }
    Some(result_relay(ticket, state_name(report.state), &report.summary, report.answers.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_the_paths_where_two_values_differ() {
        let before = json!({"eval": {"mode": "observe", "timeoutSeconds": 120}, "policy": {"rules": [{"id": "a", "enabled": true}, {"id": "b", "enabled": true}]}, "gone": 1});
        let after = json!({"eval": {"mode": "auto", "timeoutSeconds": 120}, "policy": {"rules": [{"id": "a", "enabled": true}, {"id": "b", "enabled": false}, {"id": "c"}]}, "new": true});
        assert_eq!(changed_paths(&before, &after), vec!["eval.mode", "gone", "new", "policy.rules.1.enabled", "policy.rules.2"]);
        assert!(changed_paths(&before, &before).is_empty());
        let many = |n: i64| Value::Array((0..40).map(|i| json!(i * n)).collect());
        assert_eq!(changed_paths(&many(1), &many(2)).len(), 20);
    }

    #[test]
    fn names_a_settings_notice_by_its_block_and_a_receipt_uniquely() {
        assert_eq!(settings_notice("executor", &["executor.maxWorkers".into()]).name, "settings:executor");
        assert_ne!(receipt_notice(json!({})).name, receipt_notice(json!({})).name);
    }
}
