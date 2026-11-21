//! Candidates for the main Session: the card each Eval is delivered as, and the read-only assessment of proactive ones.

use crate::app::App;
use crate::cards::{capped, related_tickets, routing_card, text_page, ticket_card, trigger_card, trigger_message};
use crate::effects::Failure;
use crate::executor::{valid_worktree_name, WORKTREE_NAME_RULE};
use crate::policy::{assessment_outcome, direction_allowed, Assessment};
use crate::settings::CHAT_SOURCE;
use crate::text::{checked_im_text, clip, word_count, IM_WORDS};
use crate::tools::Args;
use neo_core::model::{thread_key, DecisionKind, Strength, Ticket, Trigger};
use neo_core::ports::{Candidate, OutcomeKind, Repositories};
use neo_core::reasons::reason_text;
use neo_kernel::session::{Mode, Presentation};
use neo_kernel::types::Block;
use serde_json::{json, Value};
use std::sync::Arc;

/// How many tickets a chat candidate's card shows inline; older ones stay behind `orchestrator_read`.
const CHAT_RELATED: usize = 12;

fn related_limit(tickets: &[Ticket]) -> usize {
    let open_count = tickets.iter().filter(|ticket| ticket.ended.is_none()).count();
    CHAT_RELATED.max(open_count).min(24)
}
/// Workers that handed one message back before no open ticket is taken to own it: it is new work.
const MISS_LIMIT: usize = 3;
const TRIGGER_CHARS: usize = 4000;
const NEAR_CHARS: usize = 1200;
const WINDOW_CHARS: usize = 400;
const STUB_CHARS: usize = 50;
/// How many of a thread's latest messages an assessment loads.
const THREAD_MESSAGES: i64 = 200;
const EXPLICIT: &str =
    "This is an explicit request, which is routed instead of assessed: use orchestrator_route with its trigger_id and kind accept, attach, stop or ignore";

fn cut(text: &str, limit: usize) -> Value {
    if text.chars().count() <= limit {
        json!({"text": text})
    } else {
        json!({"text": format!("{}…", clip(text, limit)), "chars": text.chars().count()})
    }
}

impl App {
    /// The card a candidate reaches the main Session as: the message as workers read it, routing facts, and what to do next.
    pub fn candidate_card(&self, candidate: &Candidate) -> Value {
        let primary = candidate.triggers.last().expect("an Eval holds at least one trigger");
        let settings = self.settings();
        let mut card = trigger_message(primary, None);
        card["kind"] = "candidate".into();
        card["strength"] = serde_json::to_value(candidate.strength).unwrap_or_default();
        card["mode"] = serde_json::to_value(settings.eval.mode).unwrap_or_default();
        let others: Vec<Value> = candidate.triggers.iter().filter(|trigger| trigger.id != primary.id).map(|trigger| trigger_card(trigger, None)).collect();
        if !others.is_empty() {
            card["batch"] = others.into();
        }
        // Triggers a worker handed back as outside its ticket's scope, with its reason.
        let handed_back: Vec<Value> = candidate
            .triggers
            .iter()
            .flat_map(|trigger| {
                let handbacks = self.store.disposition(&trigger.id).map(|disposition| disposition.handbacks).unwrap_or_default();
                handbacks.into_iter().map(|item| json!({"trigger_id": trigger.id, "ticket_id": item.ticket_id, "reason": item.reason})).collect::<Vec<_>>()
            })
            .collect();
        let missed = handed_back.iter().filter(|item| item["trigger_id"] == primary.id.as_str()).count() >= MISS_LIMIT;
        if !handed_back.is_empty() {
            card["handed_back"] = handed_back.into();
        }
        let chat = primary.source == CHAT_SOURCE;
        let limit = related_limit(&candidate.tickets);
        let related = if chat {
            related_tickets(&candidate.tickets, limit, |ticket| {
                routing_card(ticket, self.store.trigger(&ticket.origin.trigger_id).map(|trigger| trigger.text).as_deref())
            })
        } else {
            related_tickets(&candidate.tickets, limit, ticket_card)
        };
        card.as_object_mut().expect("a card is an object").extend(related.as_object().cloned().unwrap_or_default());
        let delivered = self.store.disposition(&primary.id).map(|disposition| disposition.fanout).unwrap_or_default();
        if !delivered.is_empty() {
            card["delivered_to"] = delivered.into();
        }
        card["next_action"] = if missed {
            format!("{MISS_LIMIT} handbacks: route with orchestrator_route kind=accept (never attach), or kind=ignore with answer if chat only.")
        } else if candidate.strength == Strength::Explicit {
            "Route via orchestrator_route (accept, attach, sidecar, stop, ignore); for plain chat, use ignore with answer in user's language.".to_string()
        } else {
            "Ignore with orchestrator_route if no rule applies; else run orchestrator_eval, orchestrator_eval_read, orchestrator_eval_decide.".to_string()
        }
        .into();
        card
    }

    /// Deliver an Eval's candidate card to the main Session; its deadline counts from then, so a busy Session does not
    /// use up assessment time.
    pub(crate) async fn assessment_queued(self: Arc<Self>, payload: Value, eval_id: String) -> Result<(), Failure> {
        let Some(candidate) = payload["triggerId"].as_str().and_then(|id| self.engine.candidate(id)).filter(|candidate| candidate.eval_id == eval_id) else {
            return Ok(());
        };
        let main = self.ensure_orchestrator().await?;
        let card = self.candidate_card(&candidate).to_string();
        main.session.send(&format!("candidate:{eval_id}"), vec![Block::text(card)], Mode::Steer, &Presentation::default(), &[]).await?;
        self.engine.candidate_delivered(&eval_id);
        Ok(())
    }

    /// The Eval that holds a trigger, for assessment: explicit requests are routed instead.
    fn eval_for(&self, trigger_id: &str) -> Result<(Candidate, Trigger), String> {
        let candidate = self
            .engine
            .candidate(trigger_id)
            .ok_or("No assessment is in progress for this trigger; it was already decided, timed out, or never reached assessment")?;
        if candidate.strength == Strength::Explicit {
            return Err(EXPLICIT.into());
        }
        let trigger = candidate.triggers.iter().find(|item| item.id == trigger_id).cloned().ok_or("No assessment is in progress for this trigger")?;
        Ok((candidate, trigger))
    }

    /// What `orchestrator_eval` returns: the trigger's text once, its batch peers, the thread's tickets, and the thread
    /// window: the first five messages and five on either side of the trigger, long ones cut, the rest as stubs.
    pub(crate) fn eval_context(&self, trigger_id: &str) -> Result<Value, String> {
        let (candidate, trigger) = self.eval_for(trigger_id)?;
        let thread = thread_key(&trigger.threads[0]);
        let messages = self.store.thread_triggers(&thread, THREAD_MESSAGES, None, false);
        let at = messages.iter().position(|message| message.id == trigger.id);
        let shown = |index: usize| index < 5 || at.is_some_and(|at| index.abs_diff(at) <= 5);
        let window: Vec<Value> = messages
            .iter()
            .enumerate()
            .map(|(index, message)| {
                let mut line = json!({"id": message.id, "from": message.actor.id});
                if !message.human {
                    line["bot"] = true.into();
                }
                if !shown(index) {
                    line["preview"] = clip(&message.text.split_whitespace().collect::<Vec<_>>().join(" "), STUB_CHARS).into();
                    return line;
                }
                line["at"] = message.at.clone().into();
                // The trigger's own text is shown once, at the top.
                if Some(index) == at {
                    line["trigger"] = true.into();
                    return line;
                }
                let near = at.is_some_and(|at| index.abs_diff(at) <= 2);
                line.as_object_mut()
                    .expect("a line is an object")
                    .extend(cut(&message.text, if near { NEAR_CHARS } else { WINDOW_CHARS }).as_object().cloned().unwrap_or_default());
                line
            })
            .collect();
        let mut context = json!({"trigger_id": trigger.id, "strength": candidate.strength, "mode": self.settings().eval.mode,
            "source": {"kind": trigger.source, "actor": trigger.actor.id, "thread": thread}});
        let fields = context.as_object_mut().expect("a context is an object");
        fields.extend(cut(&trigger.text, TRIGGER_CHARS).as_object().cloned().unwrap_or_default());
        let others: Vec<Value> = candidate
            .triggers
            .iter()
            .filter(|item| item.id != trigger.id)
            .map(|item| {
                let mut line = json!({"trigger_id": item.id, "actor": item.actor.id, "at": item.at});
                let text = cut(&item.text, WINDOW_CHARS);
                if text.get("chars").is_some() {
                    line["read"] = format!("trigger/{}", item.id).into();
                }
                line.as_object_mut().expect("a line is an object").extend(text.as_object().cloned().unwrap_or_default());
                line
            })
            .collect();
        if !others.is_empty() {
            fields.insert("batch".into(), others.into());
        }
        fields.extend(related_tickets(&candidate.tickets, related_limit(&candidate.tickets), ticket_card).as_object().cloned().unwrap_or_default());
        // The rules are in the main Session's Policy section, which names the version this Eval was built from.
        fields.insert("policy_version".into(), candidate.policy_version.clone().into());
        fields.insert(
            "thread".into(),
            json!({"complete": (messages.len() as i64) < THREAD_MESSAGES, "loaded_messages": messages.len(), "source_found": at.is_some(), "messages": window}),
        );
        Ok(context)
    }

    /// Serve more of a candidate's context: one message whole, or a page of its thread.
    pub(crate) fn eval_read(&self, args: Args) -> Result<Value, String> {
        let (_, trigger) = self.eval_for(args.required("trigger_id")?)?;
        let thread = thread_key(&trigger.threads[0]);
        let offset = args.number("offset", 0, usize::MAX)?;
        match args.required("resource")? {
            "message" => {
                if args.text("cursor").is_some() {
                    return Err("cursor is only for thread. First page: {resource:\"thread\"}.".into());
                }
                let id = args.text("message_id").unwrap_or(&trigger.id);
                let message = self.store.trigger(id).filter(|message| message.threads.iter().any(|reference| thread_key(reference) == thread));
                let message = message.ok_or("Unknown message reference. Read the thread first; copy a returned message id.")?;
                Ok(text_page("message", &message.text, offset, 4000))
            }
            "thread" => {
                if args.text("message_id").is_some() {
                    return Err("message_id is only for message.".into());
                }
                let start: usize = match args.text("cursor") {
                    Some(cursor) => {
                        cursor.parse().map_err(|_| "Unknown thread cursor. First call {resource:\"thread\"}; then copy the returned next_cursor exactly.")?
                    }
                    None => 0,
                };
                // Newest first, a page at a time.
                let page = self.store.thread_page(&thread, start as i64, 21);
                let messages: Vec<Value> = page
                    .iter()
                    .take(20)
                    .map(|message| {
                        let mut line = json!({"id": message.id, "from": message.actor.id, "at": message.at});
                        line.as_object_mut()
                            .expect("a line is an object")
                            .extend(capped(&message.text, NEAR_CHARS, &format!("message {}", message.id)).as_object().cloned().unwrap_or_default());
                        line
                    })
                    .collect();
                let body =
                    json!({"next_cursor": if page.len() > 20 { json!((start + 20).to_string()) } else { Value::Null }, "messages": messages}).to_string();
                Ok(text_page("thread", &body, offset, 4000))
            }
            _ => Err("resource is message or thread".into()),
        }
    }

    /// Record an assessment's decision: validate it against the enabled rules and pass it to the Engine.
    pub(crate) fn eval_decide(&self, trigger_id: &str, fields: Value) -> Result<(DecisionKind, String, Option<String>), String> {
        let (candidate, _) = self.eval_for(trigger_id)?;
        let assessment: Assessment = serde_json::from_value(fields).map_err(|error| format!("Invalid assessment: {error}"))?;
        let length = |text: &str| text.chars().count();
        if assessment.title.is_empty() || length(&assessment.title) > 160 {
            return Err("title has 1 to 160 characters".into());
        }
        if length(&assessment.scope) > 1500 {
            return Err("scope has at most 1500 characters".into());
        }
        if assessment.reason.is_empty() || length(&assessment.reason) > 500 {
            return Err("reason has 1 to 500 characters".into());
        }
        if assessment.intent_evidence.as_ref().is_some_and(|evidence| length(evidence) > 700) {
            return Err("intent_evidence has at most 700 characters".into());
        }
        if let Some(name) = assessment.worktree_name.as_deref().filter(|name| !name.is_empty()) {
            if !valid_worktree_name(name) {
                return Err(format!("worktree_name: {WORKTREE_NAME_RULE}"));
            }
        }
        if let Some(text) = assessment.acknowledgement.as_deref().filter(|text| !text.is_empty()) {
            if word_count(text) > IM_WORDS {
                return Err(format!("An acknowledgement has at most {IM_WORDS} words; write one short sentence."));
            }
            if let Some(problem) = self.wrong_language(trigger_id, "acknowledgement", text) {
                return Err(problem);
            }
        }
        let accepts =
            assessment.decision == "accept" && direction_allowed(&assessment.direction) && assessment.rule_assessments.iter().any(|rule| rule.matched);
        if accepts && assessment.worktree_name.as_deref().is_none_or(str::is_empty) {
            return Err("Accepted work requires a short English worktree_name".into());
        }
        let mut outcome = assessment_outcome(&assessment, &self.settings(), candidate.strength)?;
        if let OutcomeKind::Accept(accept) = &outcome.kind {
            if let Some(text) = &accept.acknowledgement {
                checked_im_text(text)?;
            }
        }
        outcome.eval_id = Some(candidate.eval_id.clone());
        let decision = self.engine.decide(trigger_id, outcome).map_err(|error| error.message)?;
        Ok((decision.kind, reason_text(&decision.reason), decision.ticket_id))
    }
}
