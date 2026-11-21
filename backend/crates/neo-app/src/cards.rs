//! Compact, bounded projections of triggers, tickets and decisions for the models; full texts stay behind readable
//! resources.

use crate::text::clip;
use neo_core::ids::key;
use neo_core::model::{thread_key, Assignment, Decision, PolicyEffect, Ticket, TicketInput, Trigger, TriggerDisposition};
use neo_core::reasons::{reason_text, Reason};
use neo_core::stage::{ticket_stage, TicketStage};
use serde_json::{json, Map, Value};

fn preview_chars(text: &str, limit: usize) -> String {
    clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), limit)
}

/// Collapses whitespace and cuts text for a preview.
pub fn preview(text: &str) -> String {
    preview_chars(text, 160)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Adds the entries of `more` to `card`.
fn extend(card: &mut Map<String, Value>, more: Value) {
    card.extend(object(more));
}

/// The state a ticket card shows: an open ticket's stage, or an ended ticket's outcome.
pub fn card_state(ticket: &Ticket) -> String {
    if let Some(ended) = &ticket.ended {
        return ended.outcome.as_str().to_string();
    }
    match ticket_stage(ticket) {
        TicketStage::Person(action) => format!("person/{}", action.as_str()),
        TicketStage::Idle => "idle".into(),
        TicketStage::Working { queued: true } => "working/queued".into(),
        TicketStage::Working { queued: false } => "working".into(),
        TicketStage::Ended => "ended".into(),
    }
}

/// The worker's topic, else its latest report that was not a drop, which only says it handed a message back.
fn subject_of(ticket: &Ticket) -> Option<String> {
    ticket.digest.clone().or_else(|| {
        ticket
            .assignments
            .iter()
            .rev()
            .find_map(|assignment| assignment.report.as_ref().filter(|report| report.state != neo_core::model::ReportState::Dropped))
            .map(|report| report.summary.clone())
    })
}

/// A trigger with where it went.
pub fn trigger_card(trigger: &Trigger, disposition: Option<&TriggerDisposition>) -> Value {
    let mut card = object(json!({
        "trigger_id": trigger.id, "source": trigger.source, "actor": trigger.actor.id, "thread": thread_key(&trigger.threads[0]),
        "human": trigger.human, "at": trigger.at, "preview": preview(&trigger.text), "chars": trigger.text.chars().count(),
        "read": format!("trigger/{}", trigger.id),
    }));
    if let Some(disposition) = disposition {
        let mut went = object(json!({"delivered_to": disposition.fanout}));
        if let Some(filtered) = &disposition.filtered {
            went.insert("filtered".into(), reason_text(std::slice::from_ref(filtered)).into());
        }
        if let Some(decision) = &disposition.decision_id {
            went.insert("decision_id".into(), decision.clone().into());
        }
        card.insert("disposition".into(), went.into());
    }
    card.into()
}

/// A ticket in a line: what it is, where it stands, and how to read more.
pub fn ticket_card(ticket: &Ticket) -> Value {
    let digest = ticket.digest.clone().unwrap_or_else(|| match subject_of(ticket) {
        Some(subject) => preview(&format!("{}: {subject}", ticket.title)),
        None => preview(&ticket.title),
    });
    let mut card = object(json!({
        "ticket_id": ticket.id, "title": ticket.title, "digest": digest, "state": card_state(ticket),
        "strength": ticket.mandate.strength,
    }));
    if let Some(ended) = &ticket.ended {
        card.insert("ended".into(), json!({"at": ended.at, "by": ended.by, "reason": ended.reason.clone().unwrap_or_else(|| ended.outcome.as_str().into())}));
    }
    if let Some(attention) = &ticket.attention {
        let mut asked = object(json!({"question": attention.question}));
        if let Some(trigger) = &attention.trigger_id {
            asked.insert("trigger_id".into(), trigger.clone().into());
        }
        card.insert("attention".into(), asked.into());
    }
    extend(
        &mut card,
        json!({"preview": preview(ticket.latest_report().map(|report| report.summary.as_str()).unwrap_or("")), "read": format!("ticket/{}", ticket.id)}),
    );
    card.into()
}

/// A ticket card without its report preview, for a relay that already carries the report.
pub fn brief_card(ticket: &Ticket) -> Value {
    let mut card = object(ticket_card(ticket));
    card.remove("preview");
    card.into()
}

/// A chat candidate's compact ticket card: what routing a message needs. `asked` is the start of the request it was
/// accepted from, which holds the names a title leaves out.
pub fn routing_card(ticket: &Ticket, asked: Option<&str>) -> Value {
    let mut card = object(json!({"ticket_id": ticket.id, "title": ticket.title}));
    if let Some(asked) = asked {
        card.insert("asked".into(), clip(&preview(asked), 100).into());
    }
    if let Some(subject) = subject_of(ticket) {
        card.insert("digest".into(), preview(&subject).into());
    }
    extend(&mut card, json!({"state": card_state(ticket), "updated": clip(&ticket.updated_at, 16)}));
    if let Some(attention) = &ticket.attention {
        card.insert("attention".into(), json!({"question": attention.question}));
    }
    card.into()
}

/// The tickets a candidate may belong to: open ones first, then newest first, with how many there are in all.
pub fn related_tickets(tickets: &[Ticket], limit: usize, card: impl Fn(&Ticket) -> Value) -> Value {
    let mut order: Vec<&Ticket> = tickets.iter().collect();
    order.sort_by(|a, b| a.ended.is_some().cmp(&b.ended.is_some()).then_with(|| b.created_at.cmp(&a.created_at)));
    json!({"related_tickets": order.into_iter().take(limit).map(card).collect::<Vec<_>>(), "tickets_total": tickets.len()})
}

/// A decision in a line.
pub fn decision_card(decision: &Decision) -> Value {
    let mut card = object(json!({
        "decision_id": decision.id, "kind": decision.kind, "reason": reason_text(&decision.reason), "strength": decision.strength,
        "thread": decision.thread_key, "trigger_ids": decision.trigger_ids, "at": decision.at, "read": format!("decision/{}", decision.id),
    }));
    if let Some(ticket) = &decision.ticket_id {
        card.insert("ticket_id".into(), ticket.clone().into());
    }
    card.into()
}

/// A decision with its Mandate and audit.
pub fn decision_details(decision: &Decision) -> Value {
    let mut card = object(decision_card(decision));
    if let Some(mandate) = &decision.mandate {
        let mut mandate = object(serde_json::to_value(mandate).expect("mandates serialize"));
        mandate.remove("policyVersion");
        card.insert("mandate".into(), mandate.into());
    }
    if let Some(audit) = &decision.audit {
        card.insert("audit".into(), Value::Object(audit.clone()));
    }
    card.into()
}

/// One page of a text, by characters, so concatenated pages give the text back.
pub fn text_page(resource: &str, text: &str, offset: usize, limit: usize) -> Value {
    let total = text.chars().count();
    let end = total.min(offset.saturating_add(limit));
    let page: String = text.chars().skip(offset).take(limit).collect();
    json!({"resource": resource, "offset": offset, "total_chars": total, "next_offset": if end < total { json!(end) } else { Value::Null }, "text": page})
}

/// The longest assignment or input text a message carries whole.
pub const ASSIGNMENT_CHARS: usize = 1500;
const TRIGGER_CHARS: usize = 600;
/// The longest trigger text a worker message carries whole.
pub const WORKER_TRIGGER_CHARS: usize = 4000;

/// `text` whole, or its start with its length and where to read the rest.
pub fn capped(text: &str, limit: usize, read: &str) -> Value {
    if text.chars().count() <= limit {
        json!({"text": text})
    } else {
        json!({"text": format!("{}…", clip(text, limit)), "chars": text.chars().count(), "read": read})
    }
}

fn trigger_card_with_limit(trigger: &Trigger, note: Option<&str>, limit: usize) -> Map<String, Value> {
    let mut message = object(json!({"trigger_id": trigger.id, "from": trigger.actor.id, "thread": thread_key(&trigger.threads[0]), "at": trigger.at}));
    extend(&mut message, capped(&trigger.text, limit, &format!("trigger/{}", trigger.id)));
    if let Some(note) = note {
        message.insert("routing_note".into(), note.into());
    }
    message
}

/// A trigger as the main Session reads it.
pub fn trigger_message(trigger: &Trigger, note: Option<&str>) -> Value {
    trigger_card_with_limit(trigger, note, TRIGGER_CHARS).into()
}

/// A trigger as a worker Session reads it, carrying up to [`WORKER_TRIGGER_CHARS`] inline and whether it was already acknowledged.
pub fn worker_trigger_message(trigger: &Trigger, note: Option<&str>, acknowledged: bool) -> Value {
    let mut message = trigger_card_with_limit(trigger, note, WORKER_TRIGGER_CHARS);
    if acknowledged {
        message.insert("acknowledged".into(), true.into());
    }
    message.into()
}

/// A batch peer of a ticket's origin trigger, in a line.
pub fn batch_line(trigger: &Trigger) -> Value {
    json!({"trigger_id": trigger.id, "from": trigger.actor.id, "at": trigger.at, "preview": preview_chars(&trigger.text, 500), "read": format!("trigger/{}", trigger.id)})
}

/// The resource a long Input is read from.
pub fn input_resource(ticket_id: &str, input_id: &str) -> String {
    format!("ticket/{ticket_id}/input/{}", key(&[input_id]))
}

const RESUMED: &str = "This ticket ended earlier and the message that follows resumed it under the same mandate. First judge from the message and this ticket's topic alone whether it belongs here; if it does not, hand it back with orchestrator_trigger_handback at once, without inspecting the directory. If it asks for more within the original scope, inspect the directory and its history and continue; if it asks for work beyond that scope or for another ticket, hand it back with orchestrator_trigger_handback and report dropped, with a summary that only says it was handed back and no topic, never the subject of that message. No new work does not mean no reply: for thanks, acknowledgements, or other human follow-ups needing no work, report dropped with reply_to_trigger_id set to that message and direct_reply set to a short natural response (at most 100 words in their language; Chinese counts by character) so it goes out directly. Report ready when follow-up work is done. Do not repeat completed work.";
/// What a retried Assignment is told.
pub const RETRIED: &str = "A person retried this ticket. Continue the assignment from the current state of the directory and its history.";

fn policy_message(effect: &PolicyEffect) -> String {
    let mut lines = vec!["Policy change:".to_string()];
    for rule in &effect.rules {
        lines.push(if rule.change == "disabled" {
            format!(
                "Rule {} ({}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.",
                rule.name, rule.id
            )
        } else {
            format!(
                "Rule {} ({}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: {}",
                rule.name,
                rule.id,
                rule.instruction.as_deref().unwrap_or("")
            )
        });
    }
    if effect.proactive == Some(false) {
        lines.push("Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only what is in progress within the assignment, or report dropped, and take on nothing new.".into());
    }
    if effect.requester_allowed == Some(false) {
        let who = effect.requester.as_ref().map(|actor| format!("{} on {}", actor.id, actor.source)).unwrap_or_else(|| "who asked for it".into());
        lines.push(format!("The sender this ticket is for, {who}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it."));
    }
    if lines.len() == 1 {
        return "Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.".into();
    }
    lines.join("\n")
}

/// The message an Input reaches its worker as; `trigger` is the card of a trigger Input's Trigger.
pub fn input_message(input: &TicketInput, trigger: Option<Value>) -> String {
    match input {
        TicketInput::Trigger { trigger_id, context, .. } => {
            let mut card = object(trigger.unwrap_or_else(|| json!({"trigger_id": trigger_id, "read": format!("trigger/{trigger_id}")})));
            if *context {
                card.insert("context".into(), true.into());
            }
            Value::Object(card).to_string()
        }
        TicketInput::PolicyChanged { effect, .. } => policy_message(effect),
        TicketInput::Resumed { .. } => RESUMED.into(),
        TicketInput::Note { text, .. } => format!("Note from the orchestrator, for context only: {text}"),
        TicketInput::Text { text, .. } => text.clone(),
    }
}

/// What an inferred ticket's worker is told about its narrower authority.
pub fn mandate_instructions(ticket: &Ticket) -> Option<&'static str> {
    (ticket.mandate.strength == neo_core::model::Strength::Inferred).then_some(
        "This ticket has limited proactive authorization. Independently verify that it is a small change internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product decisions or clarification, stop and report dropped; do not expand scope.",
    )
}

/// An Input in a line: short text inline, anything else by reference.
pub fn input_line(ticket: &Ticket, input: &TicketInput) -> Value {
    let mut line =
        object(json!({"kind": serde_json::to_value(input).ok().and_then(|value| value.get("kind").cloned()).unwrap_or(Value::Null), "at": input.at()}));
    match input {
        TicketInput::Trigger { trigger_id, .. } | TicketInput::Resumed { trigger_id, .. } => {
            line.insert("trigger_id".into(), trigger_id.clone().into());
        }
        TicketInput::Text { text, .. } if text.chars().count() <= 80 => {
            line.insert("text".into(), text.clone().into());
        }
        TicketInput::Text { text, .. } => {
            extend(&mut line, json!({"preview": clip(&preview(text), 80), "chars": text.chars().count(), "read": input_resource(&ticket.id, input.id())}))
        }
        _ => {
            line.insert("read".into(), input_resource(&ticket.id, input.id()).into());
        }
    }
    if ticket.undelivered.iter().any(|id| id == input.id()) {
        line.insert("undelivered".into(), true.into());
    }
    line.into()
}

/// An Assignment in a line, with its report by reference.
pub fn assignment_line(ticket: &Ticket, item: &Assignment) -> Value {
    let mut line = object(json!({"id": item.id, "state": item.state, "at": item.created_at}));
    if let Some(reason) = &item.ended_reason {
        line.insert("ended_reason".into(), reason_text(&[Reason::code(reason)]).into());
    }
    if let Some(report) = &item.report {
        line.insert(
            "report".into(),
            json!({"state": report.state, "at": report.at, "preview": clip(&preview(&report.summary), 100), "chars": report.summary.chars().count(),
                "read": format!("ticket/{}/report/{}", ticket.id, item.id)}),
        );
    }
    line.into()
}

/// One page of `items`, newest first, with where the next page is.
pub fn newest_page<T>(items: &[T], offset: usize, size: usize, line: impl Fn(&T) -> Value) -> (Vec<Value>, Option<usize>) {
    let page = items.iter().rev().skip(offset).take(size).map(line).collect();
    (page, (offset + size < items.len()).then_some(offset + size))
}

/// A ticket with its origin, threads and the first pages of its assignments and inputs.
pub fn ticket_details(ticket: &Ticket, threads: Vec<Value>, batch: &[Trigger], worker: bool) -> Value {
    let mut card = object(brief_card(ticket));
    card.insert("trigger_id".into(), ticket.origin.trigger_id.clone().into());
    if !batch.is_empty() {
        card.insert("batch".into(), batch.iter().map(batch_line).collect());
    }
    if !worker {
        card.insert("decision_id".into(), ticket.decision_id.clone().into());
    }
    let page = |items: Vec<Value>, next: Option<usize>, resource: String| {
        let mut page = object(json!({"items": items}));
        if let Some(next) = next {
            extend(&mut page, json!({"next_resource": resource, "next_offset": next}));
        }
        Value::Object(page)
    };
    let (assignments, more_assignments) = newest_page(&ticket.assignments, 0, 3, |item| assignment_line(ticket, item));
    let (inputs, more_inputs) = newest_page(&ticket.inputs, 0, 10, |input| input_line(ticket, input));
    extend(
        &mut card,
        json!({
            "threads": threads, "directory": ticket.execution.as_ref().map(|execution| execution.directory.clone()),
            "scope": ticket.mandate.scope, "requested_by": ticket.mandate.actor.id,
            "assignments": page(assignments, more_assignments, format!("ticket/{}/assignments", ticket.id)),
            "inputs": page(inputs, more_inputs, format!("ticket/{}/inputs", ticket.id)),
            "assignment": format!("ticket/{}/assignment", ticket.id), "result": format!("ticket/{}/result", ticket.id),
            "transcript": format!("ticket/{}/transcript", ticket.id),
        }),
    );
    card.into()
}
