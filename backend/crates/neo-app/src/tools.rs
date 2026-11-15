//! The tools the models call: the main Session's for routing, assessing and replying, and a worker's for reading its
//! ticket, acknowledging, handing back and reporting.

use crate::app::App;
use crate::cards::ticket_card;
use crate::effects;
use crate::executor::{valid_worktree_name, WORKTREE_NAME_RULE};
use crate::notices::{receipt_notice, report_relay, thread_followed_notice};
use crate::text::{clip, word_count, IM_WORDS};
use neo_core::assignments::{Question, WorkerReport};
use neo_core::errors::UserError;
use neo_core::model::{followup_owners, DecisionKind, ReportState, ThreadRef};
use neo_core::ports::{Accept, Outcome, OutcomeKind, Records, ReplyStatus, Repositories, Why};
use neo_core::reasons::{reason_text, Reason};
use neo_core::replies::{Purpose, ReplyRequest};
use neo_kernel::types::ToolSpec;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// The most words a routing note may have.
pub const NOTE_WORDS: usize = 30;
/// The longest topic a ticket keeps; a longer one is cut, not refused.
const TOPIC_CHARS: usize = 200;

fn spec(name: &str, description: &str, properties: Value, required: &[&str]) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: description.into(),
        schema: json!({"type": "object", "properties": properties, "required": required, "additionalProperties": false}),
    }
}

/// The arguments of one tool call, read strictly.
pub(crate) struct Args(Map<String, Value>);

impl Args {
    pub(crate) fn of(arguments: Value, allowed: &[&str]) -> Result<Args, String> {
        let Value::Object(map) = arguments else { return Err("The arguments must be an object".into()) };
        if let Some(unknown) = map.keys().find(|name| !allowed.contains(&name.as_str())) {
            return Err(format!("Unknown argument {unknown}; the arguments are {}", allowed.join(", ")));
        }
        Ok(Args(map))
    }
    /// A string that is present and not blank.
    pub(crate) fn text(&self, name: &str) -> Option<&str> {
        self.0.get(name).and_then(Value::as_str).filter(|text| !text.trim().is_empty())
    }
    pub(crate) fn required(&self, name: &str) -> Result<&str, String> {
        self.text(name).ok_or_else(|| format!("{name} is required"))
    }
    pub(crate) fn get(&self, name: &str) -> Option<&Value> {
        self.0.get(name)
    }
    pub(crate) fn number(&self, name: &str, default: usize, most: usize) -> Result<usize, String> {
        match self.0.get(name) {
            None | Some(Value::Null) => Ok(default),
            Some(value) => value.as_u64().map(|n| n as usize).filter(|n| *n <= most).ok_or_else(|| format!("{name} must be a whole number from 0 to {most}")),
        }
    }
}

fn acknowledgement(text: &str) -> Result<&str, String> {
    if word_count(text) > IM_WORDS {
        return Err(format!("An acknowledgement has at most {IM_WORDS} words (Chinese counts by character); write one short sentence."));
    }
    Ok(text.trim())
}

const READ_RESOURCE: &str = "The resource, as the tool's description lists them.";
const READ_OFFSET: &str = "Copy next_offset from the previous page; it counts characters of a text and items of a list.";
const READ_LIMIT: &str = "Characters of a text, 4000 by default and 8000 at most, or items of a list, 20 by default and 50 at most.";

fn read_spec(description: &str, worker: bool) -> ToolSpec {
    spec(
        "orchestrator_read",
        &format!("{description} Resources: {}.", crate::resources::grammar(worker)),
        json!({"resource": {"type": "string", "description": READ_RESOURCE}, "offset": {"type": "integer", "minimum": 0, "description": READ_OFFSET},
            "limit": {"type": "integer", "minimum": 1, "maximum": 8000, "description": READ_LIMIT}}),
        &["resource"],
    )
}

/// The main Session's tools.
pub fn main_specs() -> Vec<ToolSpec> {
    let ticket = json!({"ticket_id": {"type": "string"}});
    vec![
        read_spec("Read one page of a resource, such as the ticket list or a ticket. Follow next_offset, and next_resource where a page names one.", false),
        spec(
            "orchestrator_route",
            "Route candidates, one item each by the card's trigger_id, in one call: accept an explicit request as a new ticket, attach follow-on work to an existing ticket (with an immediate acknowledgement), sidecar a read-only progress, summary or comparison question on a ticket without waking its worker, stop a ticket on a person's stop message, or ignore a candidate that needs no ticket or stop, as dispatch says. Items run in order and each is answered on its own; a refused item leaves the others. An inferred candidate may be ignored here; accepting one goes through orchestrator_eval_decide.",
            json!({"decisions": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object", "additionalProperties": false, "required": ["kind", "trigger_id"], "properties": {
                "kind": {"type": "string", "enum": ["accept", "attach", "sidecar", "ignore", "stop"]},
                "trigger_id": {"type": "string", "description": "The candidate card's trigger_id; deciding it decides its batch."},
                "ticket_id": {"type": ["string", "null"], "description": "attach, sidecar and stop: the ticket."},
                "title": {"type": ["string", "null"], "description": "accept: a short label of at most 200 characters describing the original request; no added requirements or implementation advice."},
                "worktree_name": {"type": ["string", "null"], "description": "accept: a meaningful short English ticket name, e.g. fix-plan-color. Translate other languages into English; 1–4 lowercase words in kebab-case, at most 32 characters."},
                "acknowledgement": {"type": ["string", "null"], "description": format!("accept (required) and attach (recommended): one brief sentence of at most {IM_WORDS} words naming the concrete change and intended result, written in the language the person wrote in: a Chinese message gets a Chinese acknowledgement, never English. It is posted at once as a reply to the original message, so do not quote it.")},
                "note": {"type": ["string", "null"], "description": format!("accept, attach and sidecar: optional routing background or explicit human constraint, at most {NOTE_WORDS} words. Never implementation instructions.")},
                "reason": {"type": ["string", "null"], "description": "ignore and stop: why, at most 500 characters; an ignore needs it."},
                "answer": {"type": ["string", "null"], "description": "ignore only: for ordinary conversation that needs no ticket, the natural answer to send at once, in the language the person wrote in. Avoids another turn."},
            }}}}),
            &["decisions"],
        ),
        spec("orchestrator_ticket_retry", "Start a new assignment on an explicit human request to retry a ticket whose worker reported failed or blocked, or whose input was not delivered; the stalled one ends.", ticket.clone(), &["ticket_id"]),
        spec("orchestrator_ticket_request_status", "Ask the worker of an idle ticket, one whose turn ended without a report, for a status report; for other tickets it sends nothing and returns the card.", ticket.clone(), &["ticket_id"]),
        spec(
            "orchestrator_ticket_note",
            "Tell a ticket's worker a fact from other work, such as what another ticket found; it grants no authority.",
            json!({"ticket_id": {"type": "string"}, "text": {"type": "string", "description": format!("At most {IM_WORDS} words.")}}),
            &["ticket_id", "text"],
        ),
        spec("orchestrator_trigger_requeue", "Queue a trigger for a fresh assessment; a follow-up that reached a ticket comes back only from its worker.", json!({"trigger_id": {"type": "string"}}), &["trigger_id"]),
        spec("orchestrator_eval", "Load a proactive candidate's window and its thread's tickets.", json!({"trigger_id": {"type": "string"}}), &["trigger_id"]),
        spec(
            "orchestrator_eval_read",
            "Read more of a candidate's context, always with its trigger_id: a message whole by message_id, or a page of its thread by cursor.",
            json!({"trigger_id": {"type": "string", "description": "The candidate's trigger_id."}, "resource": {"type": "string", "enum": ["message", "thread"]},
                "message_id": {"type": "string", "description": "Only for message: omit for the trigger, or the id of a window message."},
                "cursor": {"type": "string", "description": "Only for thread: omit on the first page, then the next_cursor returned."},
                "offset": {"type": "integer", "minimum": 0, "description": "Text pagination: copy next_offset; keep the other arguments unchanged."}}),
            &["trigger_id", "resource"],
        ),
        spec(
            "orchestrator_eval_decide",
            "Record the decision of an assessment, as admission describes it, after orchestrator_eval with the same trigger_id.",
            json!({"trigger_id": {"type": "string"}, "decision": {"type": "string", "enum": ["accept", "ignore", "unavailable"]},
                "rule_assessments": {"type": "array", "description": "One per enabled rule.", "items": {"type": "object", "additionalProperties": false, "required": ["rule_id", "matched", "reason"],
                    "properties": {"rule_id": {"type": "string"}, "matched": {"type": "boolean"}, "reason": {"type": "string"}}}},
                "direction": {"type": "object", "description": "Required for every decision.", "additionalProperties": false, "required": ["implementation_requested", "target_basis", "requires_design_decision", "evidence"],
                    "properties": {"implementation_requested": {"type": "boolean"}, "target_basis": {"type": "string", "enum": ["specified", "existing-standard", "undetermined"]},
                        "requires_design_decision": {"type": "boolean"}, "evidence": {"type": "string"}}},
                "title": {"type": "string"}, "worktree_name": {"type": "string"}, "scope": {"type": "string"},
                "intent_evidence": {"type": ["string", "null"], "description": "For acceptance: the quotes that establish the three facts."},
                "acknowledgement": {"type": ["string", "null"], "description": "For acceptance: one sentence in the language the person wrote in; omit only when a matched rule asks for silence."},
                "reason": {"type": "string"}}),
            &["trigger_id", "decision", "rule_assessments", "direction", "title", "scope", "reason"],
        ),
        spec(
            "orchestrator_reply",
            "Send an answer to a human question, a ready result, or attention requiring human action, as the replies section says; the gate refuses anything else, such as progress.",
            json!({"trigger_id": {"type": "string", "description": "The original human question, for an answer only."}, "ticket_id": {"type": "string"},
                "purpose": {"type": "string", "enum": ["answer", "result", "attention"]},
                "human_action": {"type": "string", "description": "Required for attention: the ticket's current attention question."}, "text": {"type": "string"}}),
            &["purpose", "text"],
        ),
        spec(
            "orchestrator_thread_unsubscribe",
            "Drop every ticket subscription on a thread; a new positive decision can subscribe it again.",
            json!({"thread": {"type": "string", "description": "Thread key, such as chat:web:main."}}),
            &["thread"],
        ),
        spec(
            "wechat_send_file",
            "Send a local image, video, or other file to the bound WeChat user. Use an absolute path produced or verified during this conversation; an optional caption is sent first. Requires an active binding.",
            json!({"path": {"type": "string", "description": "Absolute local file path."}, "caption": {"type": "string"}}),
            &["path"],
        ),
    ]
}

/// A worker Session's tools.
pub fn worker_specs() -> Vec<ToolSpec> {
    vec![
        read_spec("Read one page of a resource of this ticket. Follow next_offset, and next_resource where a page names one.", true),
        spec(
            "orchestrator_ack",
            "Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.",
            json!({"trigger_id": {"type": "string"}, "text": {"type": "string", "description": format!("At most {IM_WORDS} words; Markdown is supported.")}}),
            &["trigger_id", "text"],
        ),
        spec(
            "orchestrator_thread_unrelated",
            "Stop following an attached thread that is not about this ticket, as the work section says; its own thread cannot be dropped.",
            json!({"thread": {"type": "string", "description": "The thread key, which trigger/<id> of one of its messages shows as thread."}, "reason": {"type": "string", "description": "One sentence on why the thread is not about this ticket."}}),
            &["thread", "reason"],
        ),
        spec(
            "orchestrator_thread_follow",
            "Follow a related thread for context only.",
            json!({"thread": {"type": "string", "description": "Thread key, <source>:<id>."}, "reason": {"type": "string", "description": "How it relates, in one sentence."}}),
            &["thread", "reason"],
        ),
        spec(
            "orchestrator_trigger_handback",
            "Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket's to decide.",
            json!({"trigger_id": {"type": "string"}, "reason": {"type": "string", "description": "One sentence on what it asks for beyond this ticket."}}),
            &["trigger_id", "reason"],
        ),
        spec(
            "orchestrator_report",
            "Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.",
            json!({"state": {"type": "string", "enum": ["progress", "ready", "blocked", "failed", "dropped"]}, "summary": {"type": "string"},
                "human_action": {"type": ["string", "null"], "description": "One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it."},
                "question_for_trigger_id": {"type": "string", "description": "With human_action: the human message that raised the question, which is asked where that person wrote."},
                "reply_to_trigger_id": {"type": "string", "description": "The human message this report answers, including a no-work acknowledgement; never for routine progress."},
                "direct_reply": {"type": "string", "description": format!("Optional reply of at most {IM_WORDS} words sent at once to the person's conversation: valid when answering reply_to_trigger_id, or on state=ready when no file needs sending.")},
                "topic": {"type": "string", "description": format!("What this ticket is about, in one or two sentences of at most {TOPIC_CHARS} characters: the subject, the files or area it touches and where it stands. Send it with the first report and whenever it changes.")}}),
            &["state", "summary"],
        ),
    ]
}

fn user(error: UserError) -> String {
    error.message
}

struct Routed {
    decision: Option<DecisionKind>,
    reason: String,
    ticket_id: Option<String>,
    trigger_ids: Vec<String>,
}

impl App {
    fn routed(&self, decision: Option<DecisionKind>, reason: &str, ticket_id: Option<&str>) -> Value {
        self.passes.pump();
        let mut result = json!({"reason": reason});
        if let Some(decision) = decision {
            result["decision"] = serde_json::to_value(decision).unwrap_or_default();
        }
        if let Some(ticket) = ticket_id.and_then(|id| self.store_ticket(id)) {
            result["ticket"] = ticket_card(&ticket);
        }
        result
    }

    /// Why a routing item cannot run: a field its kind needs is missing, or one it reads breaks its limit.
    fn invalid_item(item: &Args, kind: &str) -> Option<String> {
        let checks: [(&str, &[&str], &[&str]); 7] = [
            ("ticket_id", &["attach", "sidecar", "stop"], &["attach", "sidecar", "stop"]),
            ("title", &["accept"], &["accept"]),
            ("worktree_name", &["accept"], &["accept"]),
            ("acknowledgement", &["accept", "attach"], &["accept"]),
            ("note", &["accept", "attach", "sidecar"], &[]),
            ("reason", &["ignore", "stop"], &["ignore"]),
            ("answer", &["ignore"], &[]),
        ];
        for (field, reads, needs) in checks {
            if !reads.contains(&kind) {
                continue;
            }
            let Some(value) = item.text(field) else {
                if needs.contains(&kind) {
                    return Some(format!("{kind} needs {field}"));
                }
                continue;
            };
            let problem = match field {
                "title" if value.chars().count() > 200 => Some("at most 200 characters".to_string()),
                "worktree_name" if !valid_worktree_name(value) => Some(WORKTREE_NAME_RULE.to_string()),
                "acknowledgement" => acknowledgement(value).err(),
                "note" if word_count(value) > NOTE_WORDS => {
                    Some(format!("Routing note must not exceed {NOTE_WORDS} words. Shorten it; do not split it across deliveries."))
                }
                "reason" if value.chars().count() > 500 => Some("at most 500 characters".to_string()),
                "answer" if value.chars().count() > 20_000 => Some("at most 20000 characters".to_string()),
                _ => None,
            };
            if let Some(problem) = problem {
                return Some(format!("{field}: {problem}"));
            }
        }
        if item.text("answer").is_some() && kind != "ignore" {
            return Some("answer is only valid with ignore".into());
        }
        None
    }

    /// Carry out one routing decision as its Engine command. `decided` holds the Triggers this call's earlier items
    /// decided, with their batches.
    fn route(&self, item: &Args, kind: &str, trigger_id: &str, decided: &HashMap<String, String>) -> Result<Result<Routed, String>, UserError> {
        let note = item.text("note").map(str::to_string);
        if let Some(earlier) = decided.get(trigger_id).filter(|_| matches!(kind, "ignore" | "sidecar")) {
            return Ok(Err(format!("Decided in this call with {earlier}, whose Decision took its batch")));
        }
        let from_decision = |decision: neo_core::model::Decision| Routed {
            decision: Some(decision.kind),
            reason: reason_text(&decision.reason),
            ticket_id: decision.ticket_id,
            trigger_ids: decision.trigger_ids,
        };
        match kind {
            "accept" => {
                let before = self.store.disposition(trigger_id).and_then(|disposition| disposition.decision_id);
                let title = item.text("title").unwrap_or("").to_string();
                let accept = Accept {
                    scope: title.clone(),
                    title,
                    acknowledgement: item.text("acknowledgement").map(|text| text.trim().to_string()),
                    rules: None,
                    name: item.text("worktree_name").map(str::to_string),
                    note,
                };
                let decision = self.engine.decide(trigger_id, Outcome::new(OutcomeKind::Accept(accept), Why::Code(Reason::code("explicitRouted"))))?;
                // A Decision that created no ticket is the item's refusal; one that existed before keeps what it was accepted with.
                let Some(ticket_id) = decision.ticket_id.clone().filter(|_| decision.kind == DecisionKind::Accept) else {
                    return Ok(Err(format!("Ticket was not created: {}", reason_text(&decision.reason))));
                };
                if Some(&decision.id) == before.as_ref() {
                    return Ok(Ok(Routed {
                        decision: Some(DecisionKind::Accept),
                        reason: format!("Already accepted as {ticket_id}; title and acknowledgement unchanged"),
                        ticket_id: Some(ticket_id),
                        trigger_ids: Vec::new(),
                    }));
                }
                Ok(Ok(from_decision(decision)))
            }
            "attach" => {
                let ticket_id = item.text("ticket_id").unwrap_or("");
                // A person's burst of chat messages held in one Eval goes to the ticket together.
                let primary = self.store.trigger(trigger_id);
                let burst: Vec<String> = match (&primary, self.engine.candidate(trigger_id)) {
                    (Some(primary), Some(candidate)) if primary.source == crate::settings::CHAT_SOURCE => {
                        candidate.triggers.iter().filter(|trigger| trigger.actor.id == primary.actor.id).map(|trigger| trigger.id.clone()).collect()
                    }
                    _ => vec![trigger_id.to_string()],
                };
                let targets = if burst.iter().any(|id| id == trigger_id) { burst } else { vec![trigger_id.to_string()] };
                let mut ticket = None;
                for id in &targets {
                    ticket = Some(self.quietly(|| self.engine.attach(ticket_id, id, if id == trigger_id { note.as_deref() } else { None }))?);
                }
                let ticket = ticket.expect("at least the trigger itself is attached");
                if let Some(text) = item.text("acknowledgement") {
                    self.engine.reply(ReplyRequest {
                        purpose: Purpose::Acknowledgement,
                        ticket_id: Some(ticket.id.clone()),
                        trigger_id: Some(trigger_id.to_string()),
                        question: None,
                        text: text.trim().to_string(),
                    })?;
                }
                Ok(Ok(Routed {
                    decision: None,
                    reason: "Attached: the ticket follows the trigger's thread and receives the trigger".into(),
                    ticket_id: Some(ticket.id),
                    trigger_ids: targets,
                }))
            }
            "sidecar" => {
                let ticket_id = item.text("ticket_id").unwrap_or("");
                if self.store_ticket(ticket_id).is_none() {
                    return Ok(Err(format!("Unknown ticket: {ticket_id}")));
                }
                let decision =
                    self.engine.decide(trigger_id, Outcome::new(OutcomeKind::Ignore, note.as_deref().unwrap_or("Answered via read-only sidecar")))?;
                let mut payload = json!({"ticketId": ticket_id, "triggerId": trigger_id, "batchIds": decision.trigger_ids});
                if let Some(note) = &note {
                    payload["note"] = note.clone().into();
                }
                self.effects.enqueue(effects::SIDECAR, trigger_id, &payload);
                Ok(Ok(Routed {
                    decision: Some(DecisionKind::Ignore),
                    reason: "Dispatched to read-only sidecar for immediate reply".into(),
                    ticket_id: Some(ticket_id.to_string()),
                    trigger_ids: decision.trigger_ids,
                }))
            }
            // Through the Engine, so only a person's message the gate admits with explicit strength stops a ticket.
            "stop" => {
                let why = match item.text("reason") {
                    Some(reason) => Why::Said(reason.to_string()),
                    None => Why::Code(Reason::code("humanStop")),
                };
                let decision =
                    self.engine.decide(trigger_id, Outcome::new(OutcomeKind::Stop { ticket_id: item.text("ticket_id").unwrap_or("").to_string() }, why))?;
                Ok(Ok(from_decision(decision)))
            }
            _ => {
                let decision = self.engine.decide(trigger_id, Outcome::new(OutcomeKind::Ignore, item.text("reason").unwrap_or("")))?;
                if let Some(answer) = item.text("answer") {
                    self.engine.reply(ReplyRequest {
                        purpose: Purpose::Answer,
                        ticket_id: None,
                        trigger_id: Some(trigger_id.to_string()),
                        question: None,
                        text: answer.trim().to_string(),
                    })?;
                }
                Ok(Ok(from_decision(decision)))
            }
        }
    }

    fn route_all(&self, arguments: Value) -> Result<Value, String> {
        let args = Args::of(arguments, &["decisions"])?;
        let Some(Value::Array(items)) = args.get("decisions").cloned() else { return Err("decisions is required: a list of 1 to 20 routing items".into()) };
        if items.is_empty() || items.len() > 20 {
            return Err("decisions takes 1 to 20 routing items".into());
        }
        let mut decided: HashMap<String, String> = HashMap::new();
        let mut results = Vec::new();
        for item in items {
            let fields = ["kind", "trigger_id", "ticket_id", "title", "worktree_name", "acknowledgement", "note", "reason", "answer"];
            let (kind, trigger_id) = (item["kind"].as_str().unwrap_or("").to_string(), item["trigger_id"].as_str().unwrap_or("").to_string());
            let mut head = json!({"trigger_id": trigger_id, "kind": kind});
            let outcome: Result<Routed, String> = match Args::of(item, &fields) {
                Err(problem) => Err(problem),
                Ok(_) if !["accept", "attach", "sidecar", "ignore", "stop"].contains(&kind.as_str()) => {
                    Err("kind is accept, attach, sidecar, ignore or stop".into())
                }
                Ok(_) if trigger_id.is_empty() => Err("trigger_id is required".into()),
                Ok(item) => match Self::invalid_item(&item, &kind) {
                    Some(problem) => Err(problem),
                    // Each item is one Engine command, in a transaction of its own; one that is refused leaves the others.
                    None => match self.store.atomic(|| self.route(&item, &kind, &trigger_id, &decided)) {
                        Ok(routed) => routed,
                        Err(error) => Err(error.message),
                    },
                },
            };
            match outcome {
                Err(refused) => head["refused"] = refused.into(),
                Ok(routed) => {
                    for id in &routed.trigger_ids {
                        decided.entry(id.clone()).or_insert_with(|| trigger_id.clone());
                    }
                    if let Some(decision) = routed.decision {
                        head["decision"] = serde_json::to_value(decision).unwrap_or_default();
                    }
                    head["reason"] = routed.reason.into();
                    if let Some(ticket) = routed.ticket_id.and_then(|id| self.store_ticket(&id)) {
                        head["ticket"] = ticket_card(&ticket);
                    }
                }
            }
            results.push(head);
        }
        self.passes.pump();
        Ok(json!({"results": results}))
    }

    /// Run one of the main Session's tools.
    pub(crate) async fn main_tool(self: &Arc<Self>, name: &str, arguments: Value) -> Result<Value, String> {
        match name {
            "orchestrator_read" => {
                let args = Args::of(arguments, &["resource", "offset", "limit"])?;
                self.read_resource(
                    args.required("resource")?,
                    args.number("offset", 0, usize::MAX)?,
                    args.get("limit").and_then(Value::as_u64).map(|n| (n as usize).clamp(1, 8000)),
                    None,
                )
            }
            "orchestrator_route" => self.route_all(arguments),
            "orchestrator_ticket_retry" => {
                let args = Args::of(arguments, &["ticket_id"])?;
                let ticket = self.engine.retry_ticket(args.required("ticket_id")?).map_err(user)?;
                Ok(self.routed(None, "Started a new assignment", Some(&ticket.id)))
            }
            "orchestrator_ticket_request_status" => {
                let args = Args::of(arguments, &["ticket_id"])?;
                let ticket_id = args.required("ticket_id")?;
                let asked = self.engine.request_status(ticket_id).map_err(user)?;
                Ok(self.routed(
                    None,
                    if asked { "Asked the worker for a status report" } else { "The worker is not waiting; nothing was sent" },
                    Some(ticket_id),
                ))
            }
            "orchestrator_ticket_note" => {
                let args = Args::of(arguments, &["ticket_id", "text"])?;
                let (ticket_id, text) = (args.required("ticket_id")?, args.required("text")?.trim());
                if word_count(text) > IM_WORDS {
                    return Err(format!("At most {IM_WORDS} words"));
                }
                self.engine.note(ticket_id, text).map_err(user)?;
                Ok(self.routed(None, "Noted for the worker", Some(ticket_id)))
            }
            "orchestrator_trigger_requeue" => {
                let args = Args::of(arguments, &["trigger_id"])?;
                let trigger_id = args.required("trigger_id")?;
                // A follow-up that reached a ticket is its worker's to judge, which hands back what is not its own.
                let owners = self.store.trigger(trigger_id).map(|trigger| followup_owners(&trigger, &Records(self.store.as_ref()))).unwrap_or_default();
                if !owners.is_empty() {
                    return Err(UserError::with("workerDecides", &[("tickets", &owners.join(", "))]).message);
                }
                let queued = self.quietly(|| self.engine.reevaluate(trigger_id)).map_err(user)?;
                self.passes.pump();
                Ok(json!({"queued": queued}))
            }
            "orchestrator_eval" => {
                let args = Args::of(arguments, &["trigger_id"])?;
                self.eval_context(args.required("trigger_id")?)
            }
            "orchestrator_eval_read" => self.eval_read(Args::of(arguments, &["trigger_id", "resource", "message_id", "cursor", "offset"])?),
            "orchestrator_eval_decide" => {
                let Value::Object(mut fields) = arguments else { return Err("The arguments must be an object".into()) };
                let trigger_id =
                    fields.remove("trigger_id").and_then(|id| id.as_str().map(str::to_string)).filter(|id| !id.is_empty()).ok_or("trigger_id is required")?;
                let (decision, reason, ticket_id) = self.eval_decide(&trigger_id, Value::Object(fields))?;
                Ok(self.routed(Some(decision), &reason, ticket_id.as_deref()))
            }
            "orchestrator_reply" => {
                let args = Args::of(arguments, &["trigger_id", "ticket_id", "purpose", "human_action", "text"])?;
                let purpose = match args.required("purpose")? {
                    "answer" => Purpose::Answer,
                    "result" => Purpose::Result,
                    "attention" => Purpose::Attention,
                    _ => return Err("purpose is answer, result or attention".into()),
                };
                let text = args.required("text")?;
                if text.chars().count() > 20_000 {
                    return Err("text has at most 20000 characters".into());
                }
                let request = ReplyRequest {
                    purpose,
                    ticket_id: args.text("ticket_id").map(str::to_string),
                    trigger_id: args.text("trigger_id").map(str::to_string),
                    question: args.text("human_action").map(|question| question.trim().to_string()),
                    text: text.to_string(),
                };
                let reply = self.engine.reply(request).map_err(user)?;
                self.outbox.sent().await;
                Ok(json!({"status": self.store.reply_status(&reply.id).unwrap_or(reply.status)}))
            }
            "orchestrator_thread_unsubscribe" => {
                let args = Args::of(arguments, &["thread"])?;
                let thread = args.required("thread")?;
                Ok(json!({"removed": self.quietly(|| self.engine.unsubscribe(thread)).map_err(user)?, "thread": thread}))
            }
            "wechat_send_file" => {
                let args = Args::of(arguments, &["path", "caption"])?;
                let path = args.required("path")?.trim().to_string();
                let caption = args.text("caption").map(str::to_string);
                if caption.as_ref().is_some_and(|caption| caption.chars().count() > 8000) {
                    return Err("caption has at most 8000 characters".into());
                }
                self.wechat_send_file(&path, caption.as_deref()).await
            }
            _ => Err(format!("Unknown tool {name}")),
        }
    }

    /// Run one of a worker Session's tools.
    pub(crate) async fn worker_tool(self: &Arc<Self>, ticket_id: &str, name: &str, arguments: Value) -> Result<Value, String> {
        match name {
            "orchestrator_read" => {
                let args = Args::of(arguments, &["resource", "offset", "limit"])?;
                self.read_resource(
                    args.required("resource")?,
                    args.number("offset", 0, usize::MAX)?,
                    args.get("limit").and_then(Value::as_u64).map(|n| (n as usize).clamp(1, 8000)),
                    Some(ticket_id),
                )
            }
            "orchestrator_ack" => {
                let args = Args::of(arguments, &["trigger_id", "text"])?;
                let trigger_id = args.required("trigger_id")?;
                let text = acknowledgement(args.required("text")?)?;
                let reply = self
                    .engine
                    .reply(ReplyRequest {
                        purpose: Purpose::Acknowledgement,
                        ticket_id: Some(ticket_id.to_string()),
                        trigger_id: Some(trigger_id.to_string()),
                        question: None,
                        text: text.to_string(),
                    })
                    .map_err(user)?;
                if reply.status != ReplyStatus::Sent {
                    self.outbox.sent().await;
                }
                Ok(json!({"trigger_id": trigger_id, "acknowledgement": self.store.reply_status(&reply.id).unwrap_or(reply.status), "reused": reply.reused}))
            }
            "orchestrator_thread_unrelated" => {
                let args = Args::of(arguments, &["thread", "reason"])?;
                let (thread, reason) = (args.required("thread")?, clip(args.required("reason")?.trim(), 300));
                self.engine.mark_unrelated(ticket_id, thread, &reason).map_err(user)?;
                Ok(json!({"removed": true, "thread": thread}))
            }
            "orchestrator_thread_follow" => {
                let args = Args::of(arguments, &["thread", "reason"])?;
                let (thread, reason) = (args.required("thread")?, clip(args.required("reason")?.trim(), 300));
                let Some((source, id)) = thread.split_once(':').filter(|(source, id)| !source.is_empty() && !id.is_empty()) else {
                    return Err("A thread key is <source>:<id>".into());
                };
                let followed = self
                    .store
                    .atomic(|| {
                        let followed = self.engine.follow_for_context(ticket_id, &ThreadRef { source: source.to_string(), id: id.to_string() })?;
                        if followed {
                            self.notify(thread_followed_notice(ticket_id, thread, &reason));
                        }
                        Ok::<bool, UserError>(followed)
                    })
                    .map_err(user)?;
                Ok(json!({"followed": followed, "thread": thread}))
            }
            "orchestrator_trigger_handback" => {
                let args = Args::of(arguments, &["trigger_id", "reason"])?;
                let (trigger_id, reason) = (args.required("trigger_id")?, clip(args.required("reason")?.trim(), 300));
                Ok(json!({"trigger_id": trigger_id, "queued": self.engine.handback(ticket_id, trigger_id, &reason).map_err(user)?}))
            }
            "orchestrator_report" => {
                self.worker_report(
                    ticket_id,
                    Args::of(arguments, &["state", "summary", "human_action", "question_for_trigger_id", "reply_to_trigger_id", "direct_reply", "topic"])?,
                )
                .await
            }
            _ => Err(format!("Unknown tool {name}")),
        }
    }

    async fn worker_report(self: &Arc<Self>, ticket_id: &str, args: Args) -> Result<Value, String> {
        if !self.store_ticket(ticket_id).is_some_and(|ticket| ticket.live()) {
            return Err("Ticket ended; do not resume it".into());
        }
        let state = match args.required("state")? {
            "progress" => ReportState::Progress,
            "ready" => ReportState::Ready,
            "blocked" => ReportState::Blocked,
            "failed" => ReportState::Failed,
            "dropped" => ReportState::Dropped,
            _ => return Err("state is progress, ready, blocked, failed or dropped".into()),
        };
        let question = match args.get("human_action") {
            None => Question::Keep,
            Some(Value::Null) => Question::Clear,
            Some(Value::String(text)) if !text.trim().is_empty() && text.trim().chars().count() <= 1000 => Question::Ask(text.trim().to_string()),
            Some(_) => return Err("human_action is one concrete question of at most 1000 characters, or null to clear the pending one".into()),
        };
        let direct = match args.text("direct_reply") {
            Some(text) => Some(acknowledgement(text)?.to_string()),
            None => None,
        };
        let report = WorkerReport {
            state,
            summary: args.required("summary")?.to_string(),
            question,
            asked_by: args.text("question_for_trigger_id").map(str::to_string),
            answers: args.text("reply_to_trigger_id").map(str::to_string),
            // A long topic is cut, never a reason to refuse a report that may carry an answer.
            topic: args.text("topic").map(|topic| clip(topic.trim(), TOPIC_CHARS)),
        };
        // The report, and either the direct reply or the relay to the main Session, are recorded together.
        let (result, direct_sent) = self
            .store
            .atomic(|| {
                let updated = self.engine.report(ticket_id, report.clone())?;
                let mut direct_sent = false;
                if let Some(text) = direct.as_ref().filter(|_| updated.attention.is_none()) {
                    if let Some(answered) = &report.answers {
                        self.engine.reply(ReplyRequest {
                            purpose: Purpose::Answer,
                            ticket_id: Some(ticket_id.to_string()),
                            trigger_id: Some(answered.clone()),
                            question: None,
                            text: text.clone(),
                        })?;
                        direct_sent = true;
                    } else if state == ReportState::Ready && !updated.channels.is_empty() {
                        self.engine.reply(ReplyRequest {
                            purpose: Purpose::Result,
                            ticket_id: Some(ticket_id.to_string()),
                            trigger_id: None,
                            question: None,
                            text: text.clone(),
                        })?;
                        direct_sent = true;
                    }
                }
                if direct_sent {
                    self.notify(receipt_notice(
                        json!({"worker_direct_reply": {"ticket_id": ticket_id, "state": args.text("state"), "reply": direct, "note": "The person already has this reply; send nothing more for it."}}),
                    ));
                    return Ok((json!({"reported": true, "notification": "direct_outbox"}), true));
                }
                let relay = report_relay(&updated, &report);
                let mut result = json!({"reported": true, "notification": if relay.is_some() { "orchestrator" } else { "internal_only" }});
                if let Some(relay) = relay {
                    self.relay(relay);
                }
                if let Some(attention) = &updated.attention {
                    result["attention"] = serde_json::to_value(attention).unwrap_or_default();
                }
                Ok::<(Value, bool), UserError>((result, false))
            })
            .map_err(user)?;
        if direct_sent {
            self.outbox.sent().await;
        }
        self.passes.pump();
        Ok(result)
    }
}
