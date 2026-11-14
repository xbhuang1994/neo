//! What the app shows and changes: the conversation, the workers, health, and the settings, each as the JSON the API
//! carries.

use crate::app::App;
use crate::health::Health;
use crate::kernels::support;
use crate::sessions::worker_session_id;
use crate::settings::{limits, Kernel, RoleModel, RoleModels, Settings};
use crate::text::clip;
use neo_core::model::Ticket;
use neo_core::ports::Repositories;
use neo_core::stage::{ticket_stage, TicketStage};
use neo_core::time::parse_iso;
use neo_kernel::journal::Entry;
use neo_kernel::types::{text_of, Block, Role};
use serde_json::{json, Map, Value};
use std::sync::Arc;

/// A ticket's stage as the app reads it: `stage`, and for some an `action`.
pub fn stage_json(stage: TicketStage) -> Value {
    match stage {
        TicketStage::Person(action) => json!({"stage": "person", "action": action.as_str()}),
        TicketStage::Working { queued: true } => json!({"stage": "working", "action": "queued"}),
        TicketStage::Working { queued: false } => json!({"stage": "working"}),
        TicketStage::Idle => json!({"stage": "idle"}),
        TicketStage::Ended => json!({"stage": "ended"}),
    }
}

/// What a worker's transcript entry did, in at most 4000 characters: text, images by a mark, tool calls by name and
/// arguments.
fn activity(entry: &Entry) -> (&'static str, String) {
    let (role, content) = match entry {
        Entry::Message { message, .. } => (if message.role == Role::Assistant { "assistant" } else { "toolResult" }, &message.content),
        Entry::CustomMessage { content, .. } => ("custom", content),
    };
    let parts: Vec<String> = content
        .iter()
        .map(|block| match block {
            Block::Text { text } => text.clone(),
            Block::Image { .. } => "[图片]".to_string(),
            Block::ToolCall { name, arguments, .. } => format!("[调用 {name}]\n{}", clip(&arguments.to_string(), 2000)),
        })
        .collect();
    (role, clip(&parts.join("\n"), 4000))
}

/// The files a chat entry says were attached: name, media type, and whether it is an image, an inlined text or a file.
fn attachments(entry: &Entry) -> Vec<(String, String, &'static str)> {
    let Entry::CustomMessage { details: Some(details), .. } = entry else { return Vec::new() };
    details["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|info| {
            let name = info["name"].as_str()?.to_string();
            let media_type = info["mediaType"].as_str().unwrap_or("application/octet-stream").to_string();
            let kind = if media_type.starts_with("image/") {
                "image"
            } else if media_type.starts_with("text/") {
                "text"
            } else {
                "file"
            };
            Some((name, media_type, kind))
        })
        .collect()
}

fn selection(value: Option<&Value>, name: &str) -> Result<Option<RoleModel>, String> {
    match value {
        None => Err(format!("{name} is required; null follows the kernel's default")),
        Some(Value::Null) => Ok(None),
        Some(value) => {
            let model: RoleModel = serde_json::from_value(value.clone()).map_err(|error| format!("{name}: {error}"))?;
            if model.provider.trim().is_empty() || model.model.trim().is_empty() {
                return Err(format!("{name} needs a provider and a model"));
            }
            Ok(Some(model))
        }
    }
}

fn object(value: Value, allowed: &[&str]) -> Result<Map<String, Value>, String> {
    let Value::Object(map) = value else { return Err("Expected a JSON object".into()) };
    if let Some(unknown) = map.keys().find(|name| !allowed.contains(&name.as_str())) {
        return Err(format!("Unknown field {unknown}; the fields are {}", allowed.join(", ")));
    }
    Ok(map)
}

impl App {
    /// Whether the application runs, and how each of its parts is doing.
    pub fn health_view(&self) -> Value {
        let settings = self.settings();
        json!({
            "ready": self.board.get("runtime").is_some_and(|health| health.state == "ready"),
            "version": env!("CARGO_PKG_VERSION"),
            "kernel": settings.kernel.as_str(),
            "paused": settings.paused,
            "activeWorkers": self.active_workers(),
            "components": self.board.all(),
        })
    }

    /// The conversation as people see it: what they wrote, in the app or WeChat, and what they were answered.
    pub fn panel_messages(&self) -> Vec<Value> {
        self.chat_transcript()
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let Entry::CustomMessage { content, .. } = entry else { return None };
                let role = match entry.source() {
                    Some("chat-reply") => "assistant",
                    Some("web-panel") | Some("wechat") => "user",
                    _ => return None,
                };
                let text = text_of(content);
                if text.is_empty() {
                    return None;
                }
                let files = attachments(entry);
                let mut names = files.iter().filter(|(_, _, kind)| *kind == "image").map(|(name, _, _)| name.clone());
                let images: Vec<Value> = content
                    .iter()
                    .enumerate()
                    .filter_map(|(at, block)| match block {
                        Block::Image { mime_type, data } => {
                            Some(json!({"name": names.next().unwrap_or_else(|| format!("image-{}", at + 1)), "mediaType": mime_type, "data": data}))
                        }
                        _ => None,
                    })
                    .collect();
                let others: Vec<Value> = files
                    .iter()
                    .filter(|(_, _, kind)| *kind != "image")
                    .map(|(name, media_type, kind)| json!({"name": name, "mediaType": media_type, "kind": kind}))
                    .collect();
                let mut message = json!({"id": index, "role": role, "text": text, "source": entry.source()});
                if let Some(at) = parse_iso(entry.timestamp()) {
                    message["at"] = at.into();
                }
                if !images.is_empty() {
                    message["images"] = images.into();
                }
                if !others.is_empty() {
                    message["files"] = others.into();
                }
                Some(message)
            })
            .collect()
    }

    async fn worker_card(&self, ticket: &Ticket) -> Value {
        let session = self.session(&worker_session_id(&ticket.id));
        let background: Vec<Value> = self
            .running_jobs(&ticket.id)
            .await
            .into_iter()
            .map(|job| json!({"id": job.id, "type": job.kind, "label": clip(&job.label, 160), "startedAt": job.started_at, "elapsedSeconds": job.elapsed_seconds}))
            .collect();
        let assignment = ticket.latest();
        json!({
            "ticketId": ticket.id,
            "title": ticket.title,
            "stage": stage_json(ticket_stage(ticket)),
            "outcome": ticket.ended.as_ref().map(|ended| ended.outcome.as_str()),
            "updatedAt": ticket.updated_at,
            "createdAt": ticket.created_at,
            "directory": ticket.execution.as_ref().map(|execution| execution.directory.clone()),
            "digest": ticket.digest,
            "session": {"loaded": session.is_some(), "streaming": session.is_some_and(|loaded| !loaded.session.is_disposed() && loaded.session.is_streaming())},
            "background": background,
            "assignment": assignment.map(|assignment| json!({"id": assignment.id, "state": assignment.state, "createdAt": assignment.created_at, "startedAt": assignment.started_at,
                "endedAt": assignment.ended_at, "deliveredAt": assignment.delivered_at, "idleAt": assignment.idle_at})),
            "progress": assignment.and_then(|assignment| assignment.report.as_ref()),
            "attention": ticket.attention,
            "pendingInputs": ticket.undelivered.len(),
            "delivery": ticket.delivery,
        })
    }

    /// Every ticket with its worker, open ones first and each group by latest change.
    pub async fn worker_cards(&self) -> Vec<Value> {
        let mut tickets = self.store.tickets();
        tickets.sort_by(|left, right| left.ended.is_some().cmp(&right.ended.is_some()).then_with(|| right.updated_at.cmp(&left.updated_at)));
        let mut cards = Vec::with_capacity(tickets.len());
        for ticket in &tickets {
            cards.push(self.worker_card(ticket).await);
        }
        cards
    }

    /// One ticket with its Inputs, newest first, and its worker's latest thirty transcript entries.
    pub async fn worker_detail(&self, ticket_id: &str) -> Option<Value> {
        let ticket = self.store_ticket(ticket_id)?;
        let mut card = self.worker_card(&ticket).await;
        let inputs: Vec<Value> = ticket
            .inputs
            .iter()
            .rev()
            .map(|input| {
                let mut line = serde_json::to_value(input).unwrap_or(Value::Null);
                line["delivered"] = (!ticket.undelivered.iter().any(|id| id == input.id())).into();
                line
            })
            .collect();
        let recent: Vec<Value> = self
            .worker_transcript(ticket_id)
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let (role, text) = activity(entry);
                if text.is_empty() {
                    return None;
                }
                let mut line = json!({"id": index, "role": role, "text": text});
                if let Some(at) = parse_iso(entry.timestamp()) {
                    line["at"] = at.into();
                }
                Some(line)
            })
            .collect();
        card["inputs"] = inputs.into();
        card["recent"] = recent[recent.len().saturating_sub(30)..].to_vec().into();
        Some(card)
    }

    /// The kernel and model settings, with what may be chosen.
    pub async fn models_view(&self) -> Value {
        let settings = self.settings();
        let kernel = settings.kernel;
        let chosen = settings.role_models();
        let (available, problem) = match self.kernels.unavailable(kernel) {
            Some(problem) => (Vec::new(), Some(problem)),
            None => match self.kernels.models(kernel).await {
                Ok(models) => (models, None),
                Err(error) => (Vec::new(), Some(error)),
            },
        };
        let kernels: Vec<Value> =
            [Kernel::Omp, Kernel::Claude].into_iter().map(|kernel| json!({"id": kernel.as_str(), "problem": self.kernels.unavailable(kernel)})).collect();
        json!({
            "kernel": kernel.as_str(),
            "kernels": kernels,
            "supports": support(kernel),
            "current": {"eval": chosen.eval, "executor": chosen.executor, "advisor": chosen.advisor},
            "available": available,
            "problem": problem,
        })
    }

    /// Choose the models of the current kernel's roles; `null` follows the kernel's default. They apply to open
    /// Sessions from their next turn.
    pub async fn update_models(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let fields = object(value, &["eval", "executor", "advisor"])?;
        let settings = self.settings();
        let kernel = settings.kernel;
        let supports = support(kernel);
        let chosen = RoleModels {
            eval: selection(fields.get("eval"), "eval")?,
            executor: selection(fields.get("executor"), "executor")?,
            // A kernel without an advisor keeps none, whatever was sent.
            advisor: selection(fields.get("advisor"), "advisor")?.filter(|_| supports.advisor),
        };
        let all: Vec<&RoleModel> = [&chosen.eval, &chosen.executor, &chosen.advisor].into_iter().flatten().collect();
        for model in &all {
            if let Some(level) = model.thinking_level.as_deref().filter(|level| !supports.thinking_levels.contains(level)) {
                return Err(format!("Thinking level {level} is not supported by the {} kernel", kernel.as_str()));
            }
        }
        // Oh My Pi knows its models by provider and id: an unknown one is refused before anything is saved.
        if kernel == Kernel::Omp && !all.is_empty() {
            let known = self.kernels.models(kernel).await?;
            if let Some(unknown) = all.iter().find(|model| !known.iter().any(|option| option.provider == model.provider && option.id == model.model)) {
                return Err(format!("Unknown OMP model: {}/{}", unknown.provider, unknown.model));
            }
        }
        let mut next = (*settings).clone();
        next.models.insert(kernel, chosen);
        self.save_settings(next, "app", "models")?;
        self.apply_models().await;
        Ok(self.models_view().await)
    }

    /// Switch the kernel new Sessions run on. The main Session reopens on it from its transcript; a worker stays on
    /// the kernel it started on until its ticket ends. Each kernel keeps its own model choices.
    pub async fn set_kernel(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let fields = object(value, &["kernel"])?;
        let kernel = match fields.get("kernel").and_then(Value::as_str) {
            Some("omp") => Kernel::Omp,
            Some("claude") => Kernel::Claude,
            _ => return Err("kernel is omp or claude".into()),
        };
        let before = self.settings();
        if before.kernel == kernel {
            return Ok(self.models_view().await);
        }
        if let Some(problem) = self.kernels.unavailable(kernel) {
            return Err(problem);
        }
        let mut next = (*before).clone();
        next.kernel = kernel;
        self.save_settings(next, "app", "kernel")?;
        if let Err(error) = self.reopen_orchestrator().await {
            // The main Session could not open on the new kernel: stay on the old one.
            self.save_settings((*before).clone(), "internal", "kernel")?;
            let _ = self.reopen_orchestrator().await;
            return Err(error);
        }
        self.board.set("kernel", Health::ready(format!("Running on {}", kernel.as_str())));
        self.passes.pump();
        Ok(self.models_view().await)
    }

    /// Everything else a person configures: the pause, proactive assessment, workers and their directories, rules and
    /// who may write; with the limits the app checks input against.
    pub fn general_view(&self) -> Value {
        let settings = self.settings();
        json!({
            "paused": settings.paused,
            "eval": settings.eval,
            "executor": settings.executor,
            "policy": settings.policy,
            "defaults": {"directory": self.execution_root().display().to_string()},
            "limits": {
                "ruleName": limits::RULE_NAME,
                "ruleInstruction": limits::RULE_INSTRUCTION,
                "evalTimeoutSeconds": [limits::EVAL_TIMEOUT_SECONDS.0, limits::EVAL_TIMEOUT_SECONDS.1],
                "maxWorkers": [limits::MAX_WORKERS.0, limits::MAX_WORKERS.1],
                "prepareCommand": limits::PREPARE_COMMAND,
            },
        })
    }

    /// Change some of the general settings: each block that is sent replaces that block whole, and the others stay.
    pub async fn update_general(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let fields = object(value, &["paused", "eval", "executor", "policy"])?;
        if fields.is_empty() {
            return Err("Send at least one of paused, eval, executor, policy".into());
        }
        let before = self.settings();
        let mut merged = serde_json::to_value(&*before).map_err(|error| error.to_string())?;
        let block = fields.keys().cloned().collect::<Vec<_>>().join(",");
        for (name, value) in fields {
            merged[name.as_str()] = value;
        }
        let next = Settings::parse(merged)?;
        let prompts_changed = next.policy != before.policy || next.eval != before.eval || next.executor != before.executor;
        self.save_settings(next, "app", &block)?;
        if prompts_changed && self.session(&self.master_id).is_some() {
            // The main Session's prompt states the Policy and the environment: compose it anew.
            self.reopen_orchestrator().await?;
        }
        self.effects.kick();
        self.passes.pump();
        Ok(self.general_view())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neo_core::stage::PersonAction;
    use neo_kernel::types::Message;

    #[test]
    fn names_each_stage_for_the_app() {
        assert_eq!(stage_json(TicketStage::Person(PersonAction::Review)), json!({"stage": "person", "action": "review"}));
        assert_eq!(stage_json(TicketStage::Working { queued: true }), json!({"stage": "working", "action": "queued"}));
        assert_eq!(stage_json(TicketStage::Working { queued: false }), json!({"stage": "working"}));
        assert_eq!((stage_json(TicketStage::Idle), stage_json(TicketStage::Ended)), (json!({"stage": "idle"}), json!({"stage": "ended"})));
    }

    #[test]
    fn shows_a_workers_activity_with_images_and_tool_calls_marked() {
        let entry = Entry::Message {
            id: "1".into(),
            timestamp: String::new(),
            message: Message {
                role: Role::Assistant,
                content: vec![
                    Block::text("Looking."),
                    Block::Image { mime_type: "image/png".into(), data: "AA==".into() },
                    Block::ToolCall { id: "c".into(), name: "bash".into(), arguments: json!({"command": "ls"}) },
                ],
                stop_reason: None,
            },
        };
        assert_eq!(activity(&entry), ("assistant", "Looking.\n[图片]\n[调用 bash]\n{\"command\":\"ls\"}".to_string()));
    }

    #[test]
    fn reads_model_selections_and_refuses_unknown_fields() {
        assert_eq!(selection(Some(&Value::Null), "eval"), Ok(None));
        assert_eq!(
            selection(Some(&json!({"provider": "p", "model": "m", "thinkingLevel": "high"})), "eval").unwrap().unwrap().thinking_level.as_deref(),
            Some("high")
        );
        assert!(selection(None, "eval").unwrap_err().starts_with("eval is required"));
        assert!(selection(Some(&json!({"provider": "p"})), "executor").unwrap_err().starts_with("executor: "));
        assert_eq!(selection(Some(&json!({"provider": " ", "model": "m"})), "advisor").unwrap_err(), "advisor needs a provider and a model");
        assert_eq!(object(json!({"a": 1, "x": 2}), &["a", "b"]).unwrap_err(), "Unknown field x; the fields are a, b");
        assert_eq!(object(json!([1]), &["a"]).unwrap_err(), "Expected a JSON object");
    }
}
