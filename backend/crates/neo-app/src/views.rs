//! What the app shows and changes: the conversation, the workers, health, and the settings, each as the JSON the API
//! carries.

use crate::app::App;
use crate::health::Health;
use crate::kernels::{support, ModelOption};
use crate::sessions::worker_session_id;
use crate::settings::{limits, Kernel, RoleModel, Settings};
use crate::text::clip;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// How old a kernel's model list may be before it is listed again in the background.
const MODEL_LIST_STALE: Duration = Duration::from_secs(60);

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
    match value.and_then(Value::as_str) {
        Some("omp") => Ok(Kernel::Omp),
        Some("claude") => Ok(Kernel::Claude),
        Some("antigravity") => Ok(Kernel::Antigravity),
        _ => Err("kernel is omp, claude or antigravity".into()),
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
            "workerKernel": settings.worker_kernel().as_str(),
            "paused": settings.paused,
            "activeWorkers": self.active_workers(),
            "components": self.board.all(),
        })
    }

    /// What is at work now, for the app's ticker: whether the main Session is thinking, and a line for each busy
    /// worker on what it is doing. Read from memory only, so the app may ask every few seconds.
    pub async fn activity_view(&self) -> Value {
        let router = self.router_thinking();
        let mut workers = Vec::new();
        for ticket_id in self.busy_tickets() {
            let Some(ticket) = self.store_ticket(&ticket_id).filter(|ticket| ticket.ended.is_none()) else { continue };
            let loaded = self.session(&worker_session_id(&ticket_id));
            let streaming = loaded.as_ref().is_some_and(|loaded| loaded.session.is_streaming());
            let recent = loaded.as_ref().map(|loaded| {
                let journal = loaded.session.journal();
                journal.entries_from(journal.len().saturating_sub(12))
            });
            let jobs = self.running_jobs(&ticket_id).await;
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

    /// Say in the health board whether the main Session's kernel and the workers' can run.
    pub(crate) fn report_kernels(&self) {
        let settings = self.settings();
        let (main, workers) = (settings.kernel, settings.worker_kernel());
        let problem = self
            .kernels
            .unavailable(main)
            .or_else(|| (workers != main).then(|| self.kernels.unavailable(workers)).flatten().map(|problem| format!("Workers: {problem}")));
        let health = match problem {
            Some(problem) => Health::error(problem),
            None if workers == main => Health::ready(format!("Running on {}", main.as_str())),
            None => Health::ready(format!("Main Session on {}, workers on {}", main.as_str(), workers.as_str())),
        };
        self.board.set("kernel", health);
    }

    /// What a kernel offers now, without waiting: its models or why it has none, or `None` while they are first
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

    /// A kernel's models, waiting for them when they are not known or `fresh` asks for a new list.
    pub(crate) async fn listed_models(self: &Arc<Self>, kernel: Kernel, fresh: bool) -> Result<Vec<ModelOption>, String> {
        match self.models_known(kernel) {
            Some(Ok(models)) if !fresh => Ok(models),
            _ => self.list_models_now(kernel).await,
        }
    }

    /// Ask the kernel for its models, and keep what it said.
    async fn list_models_now(&self, kernel: Kernel) -> Result<Vec<ModelOption>, String> {
        let listed = self.kernels.models(kernel).await;
        self.model_lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(kernel, ModelList { at: Instant::now(), listed: Some(listed.clone()) });
        listed
    }

    /// The models a kernel offers, or why it offers none, and whether they are still being listed.
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

    /// The kernel and model settings, with what may be chosen: the main Session's kernel and model, the workers', and
    /// for every kernel its models and the choices kept for it, so a page can prepare a switch before saving it. It
    /// never waits for a kernel to list its models: `loading` says one is still at it.
    pub async fn models_view(self: &Arc<Self>) -> Value {
        let settings = self.settings();
        let (kernel, workers) = (settings.kernel, settings.worker_kernel());
        let chosen = settings.role_models();
        let mut loading = false;
        let mut offers = BTreeMap::new();
        let kernels: Vec<Value> = [Kernel::Omp, Kernel::Claude, Kernel::Antigravity]
            .into_iter()
            .map(|each| {
                let (available, problem, listing) = self.offered(each);
                loading |= listing;
                offers.insert(each, (available.clone(), problem.clone()));
                let kept = settings.models_of(each);
                json!({
                    "id": each.as_str(),
                    "problem": self.kernels.unavailable(each),
                    "installed": self.kernels.installed(each),
                    "installing": self.kernels.installing(each),
                    "supports": support(each),
                    "available": available,
                    "listProblem": problem,
                    "loading": listing,
                    "models": {"eval": kept.eval, "executor": kept.executor},
                })
            })
            .collect();
        let (available, problem) = offers.get(&kernel).cloned().unwrap_or_default();
        let (worker_available, worker_problem) = offers.get(&workers).cloned().unwrap_or_default();
        json!({
            "kernel": kernel.as_str(),
            "workerKernel": workers.as_str(),
            "workerKernelFollows": settings.worker_kernel.is_none(),
            "kernels": kernels,
            "loading": loading,
            "supports": support(kernel),
            "workerSupports": support(workers),
            "current": {"eval": chosen.eval, "executor": chosen.executor},
            "available": available,
            "problem": problem,
            "workerAvailable": worker_available,
            "workerProblem": worker_problem,
        })
    }

    /// Check a role's model against its kernel: a level it does not take is dropped or refused, and Oh My Pi knows its
    /// models by provider and id.
    async fn checked(self: &Arc<Self>, kernel: Kernel, model: Option<RoleModel>) -> Result<Option<RoleModel>, String> {
        let Some(mut model) = model else { return Ok(None) };
        let supports = support(kernel);
        if supports.thinking_levels.is_empty() {
            // The runtime picks its own effort: a level sent along is dropped.
            model.thinking_level = None;
        }
        if let Some(level) = model.thinking_level.as_deref().filter(|level| !supports.thinking_levels.contains(level)) {
            return Err(format!("Thinking level {level} is not supported by the {} kernel", kernel.as_str()));
        }
        if kernel == Kernel::Omp {
            let listed = |known: &[ModelOption]| known.iter().any(|option| option.provider == model.provider && option.id == model.model);
            // A model added since the last list is looked for in a new one.
            if !listed(&self.listed_models(kernel, false).await?) && !listed(&self.listed_models(kernel, true).await?) {
                return Err(format!("Unknown OMP model: {}/{}", model.provider, model.model));
            }
        }
        Ok(Some(model))
    }

    /// Save the kernel and model settings as one: the main Session's kernel (`kernel`, else as it is) and model
    /// (`eval`), the workers' kernel (`workerKernel`, `null` to follow the main Session's, else as it is) and model
    /// (`executor`); a model `null` follows its kernel's default. Everything is checked before anything is saved. A
    /// new main kernel reopens the main Session on it from its transcript; a worker stays on the kernel it started on
    /// until its ticket ends. Models apply to open Sessions from their next turn.
    pub async fn update_models(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let fields = object(value, &["eval", "executor", "kernel", "workerKernel"])?;
        let before = self.settings();
        let kernel = match fields.get("kernel") {
            Some(value) => kernel_named(Some(value))?,
            None => before.kernel,
        };
        let worker_kernel = match fields.get("workerKernel") {
            None => before.worker_kernel,
            Some(Value::Null) => None,
            Some(value) => Some(kernel_named(Some(value)).map_err(|_| "workerKernel is omp, claude, antigravity or null".to_string())?),
        };
        let workers = worker_kernel.unwrap_or(kernel);
        for each in [kernel, workers] {
            if each != before.kernel && each != before.worker_kernel() {
                if let Some(problem) = self.kernels.unavailable(each) {
                    return Err(problem);
                }
            }
        }
        let eval = self.checked(kernel, selection(fields.get("eval"), "eval")?).await?;
        let executor = self.checked(workers, selection(fields.get("executor"), "executor")?).await?;
        let mut next = (*before).clone();
        next.kernel = kernel;
        next.worker_kernel = worker_kernel;
        next.models.entry(kernel).or_default().eval = eval;
        next.models.entry(workers).or_default().executor = executor;
        self.save_settings(next, "app", "models")?;
        if kernel != before.kernel {
            if let Err(error) = self.reopen_orchestrator().await {
                // The main Session could not open on the new kernel: everything stays as it was.
                self.save_settings((*before).clone(), "internal", "models")?;
                let _ = self.reopen_orchestrator().await;
                self.report_kernels();
                return Err(error);
            }
        }
        self.apply_models().await;
        self.report_kernels();
        self.passes.pump();
        Ok(self.models_view().await)
    }

    /// Install a kernel's program with its official installer. When the main Session runs on it, the main Session
    /// opens on it at once.
    pub async fn install_kernel(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let fields = object(value, &["kernel"])?;
        let kernel = kernel_named(fields.get("kernel"))?;
        if !self.kernels.installed(kernel) {
            self.kernels.install(kernel).await?;
            self.model_lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&kernel);
            let _ = self.models_known(kernel);
        }
        let settings = self.settings();
        if settings.kernel == kernel {
            if let Some(problem) = self.kernels.unavailable(kernel) {
                return Err(problem);
            }
            self.ensure_orchestrator().await?;
        }
        if settings.kernel == kernel || settings.worker_kernel() == kernel {
            self.report_kernels();
            self.passes.pump();
        }
        Ok(self.models_view().await)
    }

    /// Switch the kernel the main Session runs on (`kernel`), the workers' (`workerKernel`, `null` to follow the
    /// main Session's), or both. The main Session reopens on its kernel from its transcript; a worker stays on the
    /// kernel it started on until its ticket ends. Each kernel keeps its own model choices.
    pub async fn set_kernel(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let fields = object(value, &["kernel", "workerKernel"])?;
        if fields.is_empty() {
            return Err("kernel or workerKernel is required".into());
        }
        let main = fields.get("kernel").map(|value| kernel_named(Some(value))).transpose()?;
        let workers = match fields.get("workerKernel") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(value) => Some(Some(kernel_named(Some(value)).map_err(|_| "workerKernel is omp, claude, antigravity or null".to_string())?)),
        };
        for kernel in [main, workers.flatten()].into_iter().flatten() {
            if let Some(problem) = self.kernels.unavailable(kernel) {
                return Err(problem);
            }
        }
        let before = self.settings();
        if let Some(choice) = workers.filter(|choice| *choice != before.worker_kernel) {
            let mut next = (*before).clone();
            next.worker_kernel = choice;
            self.save_settings(next, "app", "kernel")?;
        }
        if let Some(kernel) = main.filter(|kernel| *kernel != before.kernel) {
            let kept = self.settings();
            let mut next = (*kept).clone();
            next.kernel = kernel;
            self.save_settings(next, "app", "kernel")?;
            if let Err(error) = self.reopen_orchestrator().await {
                // The main Session could not open on the new kernel: stay on the old one.
                self.save_settings((*kept).clone(), "internal", "kernel")?;
                let _ = self.reopen_orchestrator().await;
                self.report_kernels();
                return Err(error);
            }
        }
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
            selection(Some(&json!({"provider": "p", "model": "m", "thinkingLevel": "high"})), "eval").unwrap().unwrap().thinking_level.as_deref(),
            Some("high")
        );
        assert!(selection(None, "eval").unwrap_err().starts_with("eval is required"));
        assert!(selection(Some(&json!({"provider": "p"})), "executor").unwrap_err().starts_with("executor: "));
        assert_eq!(selection(Some(&json!({"provider": " ", "model": "m"})), "executor").unwrap_err(), "executor needs a provider and a model");
        assert_eq!(object(json!({"a": 1, "x": 2}), &["a", "b"]).unwrap_err(), "Unknown field x; the fields are a, b");
        assert_eq!(object(json!([1]), &["a"]).unwrap_err(), "Expected a JSON object");
    }
}
