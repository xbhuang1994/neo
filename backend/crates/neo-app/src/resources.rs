//! The paginated resources `orchestrator_read` serves: tickets, triggers, threads and decisions, and for a worker only
//! what belongs to its own ticket.

use crate::app::App;
use crate::cards::{
    assignment_line, decision_card, decision_details, input_line, input_message, newest_page, preview, text_page, ticket_card, ticket_details, trigger_card,
    trigger_message,
};
use crate::text::clip;
use neo_core::ids::key;
use neo_core::model::{reached, thread_key, Thread, Ticket, Trigger};
use neo_core::ports::Repositories;
use neo_kernel::journal::Entry;
use neo_kernel::types::Block;
use neo_store::Place;
use serde_json::{json, Value};

const RESOURCES: &[(&str, &str, bool)] = &[
    ("tickets", "ticket cards, newest first", false),
    ("triggers", "trigger cards with where each went, newest first", false),
    ("threads", "subscribed threads, newest activity first", false),
    ("thread/<key>", "one thread and its triggers", true),
    ("decisions", "decisions, newest first", false),
    ("decision/<id>", "one decision with its audit", false),
    ("ticket/<id>", "a ticket, its origin, threads, assignments and inputs", true),
    ("ticket/<id>/assignment", "its assignment text", true),
    ("ticket/<id>/assignments", "its assignments, newest first", true),
    ("ticket/<id>/inputs", "its inputs, newest first", true),
    ("ticket/<id>/result", "its latest report", true),
    ("ticket/<id>/report/<id>", "the report of one assignment", true),
    ("ticket/<id>/transcript", "its worker's messages, newest first", true),
    ("ticket/<id>/message/<n>", "one worker message", true),
    ("ticket/<id>/input/<id>", "one delivered input", true),
    ("trigger/<id>", "a trigger and its nearby thread messages", true),
];

/// The resources a Session may read, as its tool description lists them.
pub fn grammar(worker: bool) -> String {
    RESOURCES.iter().filter(|(_, _, for_worker)| !worker || *for_worker).map(|(name, holds, _)| format!("{name}: {holds}")).collect::<Vec<_>>().join("; ")
}

fn trigger_line(trigger: &Trigger) -> Value {
    json!({"trigger_id": trigger.id, "actor": trigger.actor.id, "human": trigger.human, "at": trigger.at, "preview": preview(&trigger.text),
        "chars": trigger.text.chars().count(), "read": format!("trigger/{}", trigger.id)})
}

/// What a transcript entry says, in one line of text.
fn entry_text(entry: &Entry) -> (String, String) {
    let (kind, content) = match entry {
        Entry::Message { message, .. } => {
            (serde_json::to_value(message.role).ok().and_then(|role| role.as_str().map(str::to_string)).unwrap_or_default(), &message.content)
        }
        Entry::CustomMessage { content, .. } => ("custom".to_string(), content),
    };
    let said = content
        .iter()
        .map(|block| match block {
            Block::Text { text } => text.clone(),
            Block::Image { .. } => "[image]".into(),
            Block::ToolCall { name, .. } => format!("[toolCall {name}]"),
        })
        .collect::<Vec<_>>()
        .join(" ");
    (kind, said)
}

/// A page of a list: `size` items, and where the next page starts when one more exists.
fn list_page(items: Vec<Value>, offset: usize, size: usize) -> Value {
    let more = items.len() > size;
    json!({"items": items.into_iter().take(size).collect::<Vec<_>>(), "next_offset": if more { json!(offset + size) } else { Value::Null }})
}

impl App {
    fn thread_title(&self, thread: &Thread) -> String {
        thread
            .meta
            .get("label")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| self.store.first_trigger(&thread.key, true).map(|trigger| preview(&trigger.text)))
            .unwrap_or_else(|| thread.key.clone())
    }

    fn thread_card(&self, thread: &Thread) -> Value {
        let mut card = json!({"thread": thread.key, "label": self.thread_title(thread), "source": thread.reference.source, "tickets": thread.subscriptions,
            "pending": thread.pending.len(), "read": format!("thread/{}", thread.key)});
        if let Some(evaluation) = &thread.evaluating {
            card["evaluating"] = json!({"since": evaluation.started_at, "deadline": evaluation.deadline});
        }
        card
    }

    /// Whether a worker may read a trigger: it reached the ticket, or the ticket was accepted from it.
    fn readable(&self, ticket: &Ticket, trigger: &Trigger) -> bool {
        reached(ticket, trigger, &|key| self.store.thread(key), true) || ticket.origin.trigger_ids.contains(&trigger.id)
    }

    /// Read one page of a resource; with `ticket_id`, as that ticket's worker.
    pub fn read_resource(&self, resource: &str, offset: usize, limit: Option<usize>, ticket_id: Option<&str>) -> Result<Value, String> {
        let main_only = || if ticket_id.is_some() { Err("This resource belongs to the main Session".to_string()) } else { Ok(()) };
        let size = limit.unwrap_or(20).min(50);
        let text = |body: &str| text_page(resource, body, offset, limit.unwrap_or(4000));
        let unknown = || "Unknown context resource".to_string();
        let worker_ticket = ticket_id.and_then(|id| self.store_ticket(id));
        match resource {
            "tickets" => {
                main_only()?;
                Ok(list_page(self.store.tickets().iter().skip(offset).take(size + 1).map(ticket_card).collect(), offset, size))
            }
            "triggers" => {
                main_only()?;
                let items = self
                    .store
                    .recent_triggers(offset as i64, size as i64 + 1)
                    .iter()
                    .map(|trigger| trigger_card(trigger, self.store.disposition(&trigger.id).as_ref()))
                    .collect();
                Ok(list_page(items, offset, size))
            }
            "threads" => {
                main_only()?;
                let mut threads = self.store.subscribed_threads(None);
                threads.sort_by(|a, b| b.last_at.as_ref().unwrap_or(&b.created_at).cmp(a.last_at.as_ref().unwrap_or(&a.created_at)));
                Ok(list_page(threads.iter().skip(offset).take(size + 1).map(|thread| self.thread_card(thread)).collect(), offset, size))
            }
            "decisions" => {
                main_only()?;
                Ok(list_page(self.store.recent_decisions(offset as i64, size as i64 + 1).iter().map(decision_card).collect(), offset, size))
            }
            _ => {
                if let Some(id) = resource.strip_prefix("decision/") {
                    main_only()?;
                    return self.store.decision(id).map(|decision| decision_details(&decision)).ok_or_else(|| "Unknown decision".to_string());
                }
                if let Some(thread_id) = resource.strip_prefix("thread/") {
                    let thread =
                        self.store.thread(thread_id).filter(|thread| ticket_id.is_none_or(|id| thread.subscriptions.iter().any(|subscribed| subscribed == id)));
                    let Some(thread) = thread else { return Err("Unknown or inaccessible thread".into()) };
                    let mut card = self.thread_card(&thread);
                    let page = list_page(self.store.thread_page(&thread.key, offset as i64, size as i64 + 1).iter().map(trigger_line).collect(), offset, size);
                    let fields = card.as_object_mut().expect("a card is an object");
                    fields.remove("read");
                    let tickets = fields.remove("tickets");
                    if ticket_id.is_none() {
                        let ids: Vec<String> = serde_json::from_value(tickets.unwrap_or_default()).unwrap_or_default();
                        fields.insert("tickets".into(), ids.iter().filter_map(|id| self.store_ticket(id)).map(|ticket| ticket_card(&ticket)).collect());
                        let decisions = self.store.decisions_by_thread(&thread.key);
                        fields.insert("decisions".into(), decisions.iter().rev().take(5).map(decision_card).collect());
                    }
                    fields.extend(page.as_object().cloned().unwrap_or_default());
                    return Ok(card);
                }
                if let Some(id) = resource.strip_prefix("trigger/") {
                    if id.is_empty() || id.contains('/') {
                        return Err(unknown());
                    }
                    let found = self.store.trigger(id).ok_or("Unknown trigger")?;
                    if ticket_id.is_some() && !worker_ticket.as_ref().is_some_and(|ticket| self.readable(ticket, &found)) {
                        return Err("Trigger does not belong to this worker".into());
                    }
                    let shown = |item: Option<Trigger>| item.filter(|item| worker_ticket.as_ref().is_none_or(|ticket| self.readable(ticket, item)));
                    // A worker sees only that the message reached its own ticket.
                    let disposition = self.store.disposition(&found.id).map(|mut disposition| {
                        if let Some(ticket) = &worker_ticket {
                            disposition.decision_id = None;
                            disposition.fanout.retain(|id| *id == ticket.id);
                        }
                        disposition
                    });
                    let mut card = trigger_card(&found, disposition.as_ref());
                    let fields = card.as_object_mut().expect("a card is an object");
                    for name in ["preview", "chars", "read"] {
                        fields.remove(name);
                    }
                    let status = self.store.reply_status(&key(&["ack", &found.id]));
                    fields.insert(
                        "acknowledgement".into(),
                        status.map(|status| serde_json::to_value(status).unwrap_or_default()).unwrap_or_else(|| "not_requested".into()),
                    );
                    if offset == 0 {
                        let (before, after) = self.store.neighbours(&thread_key(&found.threads[0]), &Place { at: found.at.clone(), id: found.id.clone() });
                        let mut around = json!({});
                        if let Some(before) = shown(before) {
                            around["before"] = trigger_line(&before);
                        }
                        if let Some(after) = shown(after) {
                            around["after"] = trigger_line(&after);
                        }
                        fields.insert("around".into(), around);
                    }
                    fields.extend(text(&found.text).as_object().cloned().unwrap_or_default());
                    return Ok(card);
                }
                let Some(rest) = resource.strip_prefix("ticket/") else { return Err(unknown()) };
                let parts: Vec<&str> = rest.split('/').collect();
                let (id, section, part) = match parts.as_slice() {
                    [id] => (*id, None, None),
                    [id, section] => (*id, Some(*section), None),
                    [id, section, part] => (*id, Some(*section), Some(*part)),
                    _ => return Err(unknown()),
                };
                if id.is_empty() {
                    return Err(unknown());
                }
                if ticket_id.is_some_and(|own| own != id) {
                    return Err("Ticket does not belong to this worker".into());
                }
                let ticket = self.store_ticket(id).ok_or("Unknown ticket")?;
                let body = match (section, part) {
                    (None, _) => {
                        let threads =
                            self.store.subscribed_threads(None).into_iter().filter(|thread| thread.subscriptions.iter().any(|subscribed| subscribed == id));
                        let marked = threads
                            .map(|thread| {
                                let mut line = json!({"thread": thread.key});
                                if thread.context.iter().any(|follower| follower == id) {
                                    line["context"] = true.into();
                                }
                                line
                            })
                            .collect();
                        let batch: Vec<Trigger> = ticket
                            .origin
                            .trigger_ids
                            .iter()
                            .filter(|other| **other != ticket.origin.trigger_id)
                            .filter_map(|other| self.store.trigger(other))
                            .collect();
                        return Ok(ticket_details(&ticket, marked, &batch, ticket_id.is_some()));
                    }
                    (Some(section @ ("assignments" | "inputs")), None) => {
                        let size = limit.unwrap_or(if section == "assignments" { 3 } else { 10 }).min(50);
                        let (items, next) = if section == "assignments" {
                            newest_page(&ticket.assignments, offset, size, |item| assignment_line(&ticket, item))
                        } else {
                            newest_page(&ticket.inputs, offset, size, |input| input_line(&ticket, input))
                        };
                        return Ok(json!({"items": items, "next_offset": next}));
                    }
                    (Some("assignment"), None) => ticket.execution.as_ref().map(|execution| execution.assignment.clone()).unwrap_or_default(),
                    (Some("result"), None) => ticket.latest_report().map(|report| report.summary.clone()).unwrap_or_default(),
                    (Some("transcript"), None) => {
                        let entries = self.worker_transcript(id);
                        let mut lines: Vec<String> = entries
                            .iter()
                            .enumerate()
                            .map(|(index, entry)| {
                                let (kind, said) = entry_text(entry);
                                json!({"type": kind, "preview": clip(&preview(&said), 80), "chars": said.chars().count(), "read": format!("ticket/{id}/message/{index}")}).to_string()
                            })
                            .collect();
                        lines.reverse();
                        lines.join("\n")
                    }
                    (Some("input"), Some(part)) => {
                        let input = ticket.inputs.iter().find(|item| key(&[item.id()]) == part || item.id() == part).ok_or("Unknown ticket input")?;
                        let card = input.trigger_id().and_then(|trigger_id| self.store.trigger(trigger_id)).map(|trigger| {
                            let note = match input {
                                neo_core::model::TicketInput::Trigger { note, .. } => note.as_deref(),
                                _ => None,
                            };
                            trigger_message(&trigger, note)
                        });
                        input_message(input, card)
                    }
                    (Some("message"), Some(part)) => {
                        let index: usize = part.parse().map_err(|_| unknown())?;
                        let entries = self.worker_transcript(id);
                        serde_json::to_string(entries.get(index).ok_or("Unknown transcript entry")?).unwrap_or_default()
                    }
                    (Some("report"), Some(part)) => ticket
                        .assignments
                        .iter()
                        .find(|item| item.id == part)
                        .and_then(|item| item.report.as_ref())
                        .map(|report| report.summary.clone())
                        .ok_or("Unknown assignment report")?,
                    _ => return Err(unknown()),
                };
                Ok(text(&body))
            }
        }
    }
}
