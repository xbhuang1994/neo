//! What the app shows and changes: the conversation, the workers, health, and the settings, each as the JSON the API
//! carries.

use crate::app::App;
use crate::health::Health;
use crate::kernels::{display_name, ModelOption};
use crate::sessions::worker_session_id;
use crate::settings::{limits, Kernel, RoleModel, Settings};
use crate::text::clip;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How old a kernel's model list may be before it is listed again in the background.
const MODEL_LIST_STALE: Duration = Duration::from_secs(60);
/// How long a worker's background jobs are cached across overlapping UI poll requests.
const JOBS_CACHE_TTL: Duration = Duration::from_millis(750);

/// What a kernel said when last asked for its models.
pub(crate) struct ModelList {
    at: Instant,
    /// `None` while the first listing runs.
    listed: Option<Result<Vec<ModelOption>, String>>,
}
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

/// The longest line the activity ticker shows of what a worker does.
const DOING_CHARS: usize = 80;

/// What a tool call does, in a line: its name and its telling argument.
fn tool_line(name: &str, arguments: &Value) -> String {
    let telling = ["description", "command", "file_path", "path", "pattern", "query", "url", "summary", "prompt", "text"]
        .iter()
        .find_map(|field| arguments[*field].as_str().map(str::trim).filter(|value| !value.is_empty()));
    match telling {
        Some(value) => format!("{name} · {}", value.lines().next().unwrap_or(value)),
        None => name.to_string(),
    }
}

/// What a worker's transcript says it is doing now: its latest tool call, else the latest line it wrote.
fn doing(entries: &[Entry]) -> Option<String> {
    entries.iter().rev().find_map(|entry| {
        let Entry::Message { message, .. } = entry else { return None };
        if message.role != Role::Assistant {
            return None;
        }
        message.content.iter().rev().find_map(|block| match block {
            Block::ToolCall { name, arguments, .. } => Some(tool_line(name, arguments)),
            Block::Text { text } => text.lines().rev().map(str::trim).find(|line| !line.is_empty()).map(str::to_string),
            Block::Image { .. } => None,
        })
    })
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

fn kernel_named(value: Option<&Value>) -> Result<Kernel, String> {
    match value {
        None | Some(Value::Null) => Ok(Kernel::Antigravity),
        Some(Value::String(name)) if name == "antigravity" => Ok(Kernel::Antigravity),
        _ => Err("kernel must be antigravity".into()),
    }
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

pub(crate) fn object(value: Value, allowed: &[&str]) -> Result<Map<String, Value>, String> {
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

    async fn cached_running_jobs(&self, ticket_id: &str) -> Vec<crate::executor::WorkerJob> {
        if self.session(&worker_session_id(ticket_id)).is_none_or(|loaded| loaded.session.is_disposed()) {
            return Vec::new();
        }
        {
            let cache = self.jobs_cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some((at, jobs)) = cache.get(ticket_id) {
                if at.elapsed() < JOBS_CACHE_TTL {
                    return jobs.clone();
                }
            }
        }
        let jobs = self.running_jobs(ticket_id).await;
        self.jobs_cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(ticket_id.to_string(), (Instant::now(), jobs.clone()));
        jobs
    }

    /// What is at work now, for the app's ticker: whether the main Session is thinking, and a line for each busy
    /// worker on what it is doing. Read from memory only, so the app may ask every few seconds.
    pub async fn activity_view(&self) -> Value {
        let router = self.router_thinking();
        let live: Vec<Ticket> =
            self.busy_tickets().into_iter().filter_map(|ticket_id| self.store_ticket(&ticket_id).filter(|ticket| ticket.ended.is_none())).collect();
        let mut jobs_by_ticket: HashMap<String, Vec<crate::executor::WorkerJob>> = HashMap::new();
        if !live.is_empty() {
            if let Some(app) = self.weak.upgrade() {
                let mut set = tokio::task::JoinSet::new();
                for ticket in &live {
                    let app = app.clone();
                    let id = ticket.id.clone();
                    set.spawn(async move {
                        let jobs = app.cached_running_jobs(&id).await;
                        (id, jobs)
                    });
                }
                while let Some(res) = set.join_next().await {
                    if let Ok((id, jobs)) = res {
                        jobs_by_ticket.insert(id, jobs);
                    }
                }
            } else {
                for ticket in &live {
                    jobs_by_ticket.insert(ticket.id.clone(), self.cached_running_jobs(&ticket.id).await);
                }
            }
        }
        let mut workers = Vec::with_capacity(live.len());
        for ticket in live {
            let loaded = self.session(&worker_session_id(&ticket.id));
            let streaming = loaded.as_ref().is_some_and(|loaded| loaded.session.is_streaming());
            let recent = loaded.as_ref().map(|loaded| loaded.session.journal().entries_tail(12).1);
            let jobs = jobs_by_ticket.remove(&ticket.id).unwrap_or_default();
            let job = jobs.first().map(|job| format!("后台 · {}", job.label.lines().next().unwrap_or("")));
            let report = ticket.latest().and_then(|assignment| assignment.report.as_ref()).map(|report| report.summary.clone());
            let line = match (streaming, recent.as_deref().and_then(doing), job) {
                (true, Some(line), _) => line,
                (_, _, Some(job)) => job,
                (_, line, None) => line.or(report).unwrap_or_else(|| "准备中".to_string()),
            };
            let line = line.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("准备中");
            workers.push(json!({"ticketId": ticket.id, "title": ticket.title, "doing": clip(line, DOING_CHARS)}));
        }
        json!({"router": router, "workers": workers})
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

    fn worker_card_with_jobs(&self, ticket: &Ticket, jobs: Vec<crate::executor::WorkerJob>) -> Value {
        let session = self.session(&worker_session_id(&ticket.id));
        let background: Vec<Value> = jobs
            .into_iter()
            .map(|job| {
                // Its latest line of progress: a subagent's current step, or the end of a job's output.
                let progress = job.progress.as_deref().and_then(|text| text.lines().rev().map(str::trim).find(|line| !line.is_empty())).map(|line| clip(line, 200));
                json!({"id": job.id, "type": job.kind, "label": clip(&job.label, 160), "startedAt": job.started_at, "elapsedSeconds": job.elapsed_seconds, "progress": progress})
            })
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

    async fn worker_card(&self, ticket: &Ticket) -> Value {
        let jobs = self.cached_running_jobs(&ticket.id).await;
        self.worker_card_with_jobs(ticket, jobs)
    }

    /// Every ticket with its worker, open ones first and each group by latest change.
    pub async fn worker_cards(&self) -> Vec<Value> {
        let mut tickets = self.store.tickets();
        tickets.sort_by(|left, right| left.ended.is_some().cmp(&right.ended.is_some()).then_with(|| right.updated_at.cmp(&left.updated_at)));
        let active_ids: Vec<String> = tickets
            .iter()
            .filter(|ticket| self.session(&worker_session_id(&ticket.id)).is_some_and(|loaded| !loaded.session.is_disposed()))
            .map(|ticket| ticket.id.clone())
            .collect();
        let mut jobs_by_ticket: HashMap<String, Vec<crate::executor::WorkerJob>> = HashMap::new();
        if !active_ids.is_empty() {
            if let Some(app) = self.weak.upgrade() {
                let mut set = tokio::task::JoinSet::new();
                for id in active_ids {
                    let app = app.clone();
                    set.spawn(async move {
                        let jobs = app.cached_running_jobs(&id).await;
                        (id, jobs)
                    });
                }
                while let Some(res) = set.join_next().await {
                    if let Ok((id, jobs)) = res {
                        jobs_by_ticket.insert(id, jobs);
                    }
                }
            } else {
                for id in active_ids {
                    jobs_by_ticket.insert(id.clone(), self.cached_running_jobs(&id).await);
                }
            }
        }
        tickets
            .iter()
            .map(|ticket| {
                let jobs = jobs_by_ticket.remove(&ticket.id).unwrap_or_default();
                self.worker_card_with_jobs(ticket, jobs)
            })
            .collect()
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
        let (start_index, entries) = match self.session(&worker_session_id(ticket_id)) {
            Some(loaded) => loaded.session.journal().entries_tail(120),
            None => (0, self.worker_transcript(ticket_id)),
        };
        let recent: Vec<Value> = entries
            .iter()
            .enumerate()
            .filter_map(|(offset, entry)| {
                let (role, text) = activity(entry);
                if text.is_empty() {
                    return None;
                }
                let mut line = json!({"id": start_index + offset, "role": role, "text": text});
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

    /// Say in the health board whether Antigravity can run.
    pub(crate) fn report_kernels(&self) {
        let kernel = self.settings().kernel;
        let health = match self.kernels.unavailable(kernel) {
            Some(problem) => Health::error(problem),
            None => Health::ready(format!("Running on {}", kernel.as_str())),
        };
        self.board.set("kernel", health);
    }

    /// What Antigravity offers now, without waiting: its models or why it has none, or `None` while they are first
    /// listed. A list a minute old is listed again in the background.
    pub(crate) fn models_known(self: &Arc<Self>, kernel: Kernel) -> Option<Result<Vec<ModelOption>, String>> {
        let mut lists = self.model_lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (known, refresh) = match lists.get_mut(&kernel) {
            Some(list) if list.listed.is_none() => (None, false),
            Some(list) => {
                let stale = list.at.elapsed() > MODEL_LIST_STALE;
                if stale {
                    // Marked new now, so one refresh runs at a time.
                    list.at = Instant::now();
                }
                (list.listed.clone(), stale)
            }
            None => {
                lists.insert(kernel, ModelList { at: Instant::now(), listed: None });
                (None, true)
            }
        };
        drop(lists);
        if refresh {
            let app = self.clone();
            self.rt.spawn(async move {
                let _ = app.list_models_now(kernel).await;
            });
        }
        known
    }

    /// Ask Antigravity for its models, and keep what it said.
    async fn list_models_now(&self, kernel: Kernel) -> Result<Vec<ModelOption>, String> {
        let listed = self.kernels.models(kernel).await;
        self.model_lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(kernel, ModelList { at: Instant::now(), listed: Some(listed.clone()) });
        listed
    }

    /// The models Antigravity offers, or why it offers none, and whether they are still being listed.
    fn offered(self: &Arc<Self>, kernel: Kernel) -> (Vec<ModelOption>, Option<String>, bool) {
        if let Some(problem) = self.kernels.unavailable(kernel) {
            return (Vec::new(), Some(problem), false);
        }
        match self.models_known(kernel) {
            Some(Ok(models)) => (models, None, false),
            Some(Err(error)) => (Vec::new(), Some(error), false),
            None => (Vec::new(), None, true),
        }
    }

    /// The Antigravity model settings, with installation status and available models. It never waits for Antigravity
    /// to list its models: `loading` says it is still at it.
    pub async fn models_view(self: &Arc<Self>) -> Value {
        let settings = self.settings();
        let kernel = settings.kernel;
        let chosen = settings.role_models();
        let (available, list_problem, loading) = self.offered(kernel);
        let problem = self.kernels.unavailable(kernel);
        json!({
            "kernel": kernel.as_str(),
            "installed": self.kernels.installed(kernel),
            "installing": self.kernels.installing(kernel),
            "installProgress": self.kernels.install_progress(kernel),
            "problem": problem,
            "listProblem": list_problem,
            "loading": loading,
            "current": {"eval": chosen.eval, "executor": chosen.executor},
            "available": available,
        })
    }

    /// Save the model settings: the main Session's model (`eval`) and the workers' model (`executor`); `null` follows
    /// Antigravity's default. Models apply to open Sessions from their next turn.
    pub async fn update_models(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let fields = object(value, &["eval", "executor"])?;
        let eval = selection(fields.get("eval"), "eval")?;
        let executor = selection(fields.get("executor"), "executor")?;
        let before = self.settings();
        let mut next = (*before).clone();
        let entry = next.models.entry(Kernel::Antigravity).or_default();
        entry.eval = eval;
        entry.executor = executor;
        self.save_settings(next, "app", "models")?;
        self.apply_models().await;
        self.report_kernels();
        self.passes.pump();
        Ok(self.models_view().await)
    }

    /// Install the Antigravity CLI with its official installer. Once installed, the main Session opens on it at once.
    pub async fn install_kernel(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let fields = object(value, &["kernel"])?;
        let kernel = kernel_named(fields.get("kernel"))?;
        if !self.kernels.installed(kernel) {
            // The installer runs on when whoever asked goes away, such as a page reloaded during a download;
            // the settings page shows its progress meanwhile.
            let app = Arc::clone(self);
            tokio::spawn(async move {
                app.kernels.install(kernel).await?;
                app.model_lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&kernel);
                let _ = app.models_known(kernel);
                Ok::<_, String>(())
            })
            .await
            .map_err(|error| format!("Installing {} stopped: {error}", display_name(kernel)))??;
        }
        if let Some(problem) = self.kernels.unavailable(kernel) {
            return Err(problem);
        }
        self.ensure_orchestrator().await?;
        self.report_kernels();
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
    fn says_what_a_worker_does_by_its_latest_tool_call_or_line() {
        let said = |role: Role, content: Vec<Block>| Entry::Message {
            id: "1".into(),
            timestamp: String::new(),
            message: Message { role, content, stop_reason: None },
        };
        let call = |name: &str, arguments: Value| Block::ToolCall { id: "c".into(), name: name.into(), arguments };
        let entries = vec![
            said(Role::Assistant, vec![Block::text("Old.")]),
            said(Role::Assistant, vec![Block::text("Running tests."), call("bash", json!({"command": "cargo test\n--all", "timeout": 60}))]),
            said(Role::ToolResult, vec![Block::text("ok")]),
        ];
        assert_eq!(doing(&entries).as_deref(), Some("bash · cargo test"));
        assert_eq!(doing(&entries[..1]).as_deref(), Some("Old."));
        assert_eq!(doing(&[said(Role::Assistant, vec![call("todo", json!({}))])]).as_deref(), Some("todo"));
        assert_eq!(doing(&[said(Role::Assistant, vec![Block::text("First.\n\nLast line.  \n")])]).as_deref(), Some("Last line."));
        assert_eq!(doing(&[]), None);
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
            selection(Some(&json!({"provider": "antigravity", "model": "gemini-3.8-flash-low"})), "eval").unwrap().unwrap().model,
            "gemini-3.8-flash-low"
        );
        assert!(selection(None, "eval").unwrap_err().starts_with("eval is required"));
        assert!(selection(Some(&json!({"provider": "antigravity"})), "executor").unwrap_err().starts_with("executor: "));
        assert_eq!(selection(Some(&json!({"provider": " ", "model": "m"})), "executor").unwrap_err(), "executor needs a provider and a model");
        assert_eq!(object(json!({"a": 1, "x": 2}), &["a", "b"]).unwrap_err(), "Unknown field x; the fields are a, b");
        assert_eq!(object(json!([1]), &["a"]).unwrap_err(), "Expected a JSON object");
    }
}
