//! The Hermes Agent kernel: one Hermes Python runtime process per Session, driven over a newline-delimited JSON bridge
//! (`hermes_bridge.py`) running `run_agent.AIAgent` in-process.
//!
//! Each Session runs in its own process group so closing it ends its children. Host tools are registered directly in
//! Hermes's tool registry under their bare names, and every tool call (main agent and `delegate_task` subagents alike)
//! passes through a `pre_tool_call` hook judged by [`ToolHost::guard`]. Worker Sessions keep Hermes's cross-session
//! memory (`MEMORY.md`, `USER.md`), learned skills (`~/.hermes/skills`) and background review loop; orchestrator,
//! sidecar and watchdog Sessions skip them for fast, stateless execution.

use crate::process::{Launch, Line, Proc};
use crate::session::{Driver, DriverEvent};
use crate::types::{uuid, Block, BoxFut, Deliver, Guard, JobKind, KernelJob, Message, Role, ToolHost};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tokio::sync::{mpsc, oneshot};

/// The Python bridge source embedded in the binary and written to the kernel directory before launch.
pub const BRIDGE_SOURCE: &str = include_str!("hermes_bridge.py");

/// A model the Hermes runtime can use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelInfo {
    /// The provider slug, as Hermes names it (such as `openrouter`, `anthropic`, `nous` or `custom:ollama`).
    pub provider: String,
    /// The model id.
    pub id: String,
    /// A display name.
    pub name: String,
}

/// How a Hermes Session runs.
#[derive(Clone, Default)]
pub struct HermesOptions {
    /// The `hermes` executable.
    pub program: PathBuf,
    /// Where the embedded Python bridge script is written on disk.
    pub bridge_file: PathBuf,
    /// The Session's working directory.
    pub cwd: PathBuf,
    /// The Session's system prompt (with its runtime note).
    pub system_prompt: String,
    /// The built-in tool kinds the model may use: `read`, `bash`, `edit`, `write`, `task`.
    pub builtin_tools: Vec<String>,
    /// The model as `provider/model`, or `None` for Hermes's configured default.
    pub model: Option<String>,
    /// The thinking (reasoning effort) level.
    pub thinking: Option<String>,
    /// Keep the conversation in Hermes's session store so a later process resumes it.
    pub persist: bool,
    /// Load project context files (`AGENTS.md` and the like); for workers only.
    pub context_files: bool,
    /// Enable Hermes's persistent memory (`MEMORY.md`, `USER.md`) and learned skills; for workers only.
    pub memory: bool,
    /// Enable Hermes's post-turn background review self-improvement loop; for workers only.
    pub background_review: bool,
    /// Maximum tool-calling iterations per turn, when bounded (Sidecar and Watchdog).
    pub max_turns: Option<u32>,
    /// Variables to set for the runtime.
    pub env: BTreeMap<String, String>,
}

/// Write the embedded Python bridge to `path` when missing or outdated.
pub fn ensure_bridge_file(path: &Path) -> Result<(), String> {
    if std::fs::read_to_string(path).is_ok_and(|current| current == BRIDGE_SOURCE) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    }
    std::fs::write(path, BRIDGE_SOURCE).map_err(|error| format!("Cannot write {}: {error}", path.display()))
}

const DEFAULT_MODULE_CALL: &str = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
const BRIDGE_PATH_CALL: &str = "runpy.run_path(sys.argv.pop(1), run_name='__main__')";

/// Extract the Python interpreter from a `#!` console-script shebang when the script belongs to Hermes.
fn console_script_python(program: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(program).ok()?;
    let first = text.lines().next()?.strip_prefix("#!")?.trim();
    if !(text.contains("hermes_cli") || text.contains("acp_adapter")) {
        return None;
    }
    let mut parts = first.split_whitespace();
    let head = parts.next()?;
    if head.ends_with("/env") || head == "env" {
        let name = parts.find(|part| !part.starts_with('-'))?;
        if name.contains("python") {
            return Some(PathBuf::from(name));
        }
        return None;
    }
    head.contains("python").then(|| PathBuf::from(head))
}

type ProbeCache = Mutex<HashMap<(PathBuf, Option<SystemTime>), Option<Vec<String>>>>;
static PROBE_CACHE: OnceLock<ProbeCache> = OnceLock::new();

/// Resolve how `program` runs `bridge_file` with `bridge_args` inside Hermes's Python environment.
pub async fn resolve_launch(program: &Path, bridge_file: &Path, bridge_args: &[String], cwd: &Path, env: &BTreeMap<String, String>) -> Launch {
    let env_remove: Vec<String> = crate::claude::SESSION_VARIABLES.iter().map(|name| name.to_string()).collect();

    // 1. Official Hermes launcher (`install.sh` / `install.ps1` / `hermes update`): `--print-runtime-command`
    // outputs JSON `["<python>", "-I", "-c", "<bootstrap>"]` activating PM's committed dependency store.
    // Cache the probe template per (program, mtime) once `probe.output()` finishes without timing out.
    let key = (program.to_path_buf(), std::fs::metadata(program).ok().and_then(|meta| meta.modified().ok()));
    let cache = PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let cached = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&key).cloned();
    let template = match cached {
        Some(hit) => hit,
        None => {
            let mut probe = tokio::process::Command::new(program);
            probe.arg("--print-runtime-command").envs(env).stdin(std::process::Stdio::null()).kill_on_drop(true);
            for key in &env_remove {
                probe.env_remove(key);
            }
            match tokio::time::timeout(Duration::from_secs(15), probe.output()).await {
                Ok(Ok(output)) => {
                    let found = if output.status.success() {
                        serde_json::from_slice::<Vec<String>>(&output.stdout)
                            .ok()
                            .filter(|command| command.len() >= 4 && command.iter().any(|part| part.contains(DEFAULT_MODULE_CALL)))
                    } else {
                        None
                    };
                    cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(key, found.clone());
                    found
                }
                Ok(Err(_)) | Err(_) => None,
            }
        }
    };
    if let Some(mut command) = template {
        for part in &mut command {
            if part.contains(DEFAULT_MODULE_CALL) {
                *part = part.replace(DEFAULT_MODULE_CALL, BRIDGE_PATH_CALL);
            }
        }
        let python = PathBuf::from(command.remove(0));
        command.push(bridge_file.display().to_string());
        command.extend(bridge_args.iter().cloned());
        return Launch { program: python, args: command, cwd: cwd.to_path_buf(), env: env.clone(), env_remove };
    }

    // 2. Editable / `uv` / `pip` console script (`#!...python...` importing `hermes_cli`).
    if let Some(python) = console_script_python(program) {
        let mut args = vec!["-u".into(), bridge_file.display().to_string()];
        args.extend(bridge_args.iter().cloned());
        return Launch { program: python, args, cwd: cwd.to_path_buf(), env: env.clone(), env_remove };
    }

    // 3. Direct executable or stand-in test script.
    let mut args = vec![bridge_file.display().to_string()];
    args.extend(bridge_args.iter().cloned());
    Launch { program: program.to_path_buf(), args, cwd: cwd.to_path_buf(), env: env.clone(), env_remove }
}

/// A Hermes tool call in the host's words: the kind or host tool it is, and the input [`ToolHost::guard`] judges.
pub fn host_view(tool: &str, input: &Value) -> (String, Value) {
    match tool {
        "terminal" => ("bash".into(), json!({"command": input["command"].as_str().unwrap_or("")})),
        "process_manage" | "execute_code" | "web_search" | "web_extract" => ("bash".into(), input.clone()),
        "write_file" => ("write".into(), json!({"path": input["path"].as_str().unwrap_or("")})),
        "patch" => ("edit".into(), json!({"path": input["path"].as_str().unwrap_or("")})),
        "read_file" | "search_files" | "skills_list" | "skill_view" | "session_search" => ("read".into(), input.clone()),
        "delegate_task" => ("task".into(), input.clone()),
        _ => (tool.to_string(), input.clone()),
    }
}

/// List the models Hermes has configured, asked from a short-lived bridge run.
pub async fn list_models(program: &Path, bridge_file: &Path, cwd: &Path, env: &BTreeMap<String, String>) -> Result<Vec<ModelInfo>, String> {
    ensure_bridge_file(bridge_file)?;
    let _ = std::fs::create_dir_all(cwd);
    let args = vec!["--list-models".to_string()];
    let launch = resolve_launch(program, bridge_file, &args, cwd, env).await;
    let (process, mut lines) = Proc::spawn(&launch)?;
    let asked = async {
        while let Some(line) = lines.recv().await {
            match line {
                Line::Json(frame) if frame["type"] == "models" => {
                    let items = frame["models"].as_array().cloned().unwrap_or_default();
                    return Ok(items
                        .iter()
                        .filter_map(|item| {
                            let id = item["id"].as_str()?.to_string();
                            let provider = item["provider"].as_str()?.to_string();
                            let name = item["name"].as_str().unwrap_or(&id).to_string();
                            Some(ModelInfo { provider, id, name })
                        })
                        .collect());
                }
                Line::Json(frame) if frame["type"] == "error" => {
                    return Err(frame["error"].as_str().unwrap_or("Hermes could not list its models").to_string());
                }
                Line::Exited(error) => return Err(error.unwrap_or_else(|| "Hermes ended before listing its models".into())),
                Line::Json(_) => {}
            }
        }
        Err("Hermes ended before listing its models".to_string())
    };
    let result = tokio::time::timeout(Duration::from_secs(60), asked).await.unwrap_or_else(|_| Err("Hermes did not list its models within 60 seconds".into()));
    process.close(Duration::from_secs(1)).await;
    result
}

/// An assistant message frame from the bridge as [`Message`].
fn assistant_message(frame: &Value) -> Option<Message> {
    let blocks = frame["content"].as_array().cloned().unwrap_or_default();
    let content: Vec<Block> = blocks
        .iter()
        .filter_map(|block| match block["type"].as_str()? {
            "text" => Some(Block::text(block["text"].as_str()?)),
            "toolCall" => {
                Some(Block::ToolCall { id: block["id"].as_str()?.into(), name: block["name"].as_str()?.into(), arguments: block["arguments"].clone() })
            }
            _ => None,
        })
        .collect();
    let stop = frame["stop_reason"].as_str().unwrap_or("stop");
    let failed = matches!(stop, "error" | "aborted");
    if content.is_empty() && !failed {
        return None;
    }
    let content = if content.is_empty() { vec![Block::text(stop)] } else { content };
    Some(Message { role: Role::Assistant, content, stop_reason: Some(stop.to_string()) })
}

#[derive(Default)]
struct Shared {
    process: Option<Arc<Proc>>,
    generation: u64,
    requests: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    ready: Option<oneshot::Sender<Result<(), String>>>,
    awaiting_async: bool,
    closed: bool,
    model: Option<String>,
    thinking: Option<String>,
}

/// One Hermes Session's runtime.
pub struct HermesDriver {
    options: HermesOptions,
    host: Arc<dyn ToolHost>,
    events: mpsc::UnboundedSender<DriverEvent>,
    shared: Arc<Mutex<Shared>>,
    starting: tokio::sync::Mutex<()>,
}

fn lock(shared: &Mutex<Shared>) -> std::sync::MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

const ANSWER: Duration = Duration::from_secs(30);

impl HermesDriver {
    /// A driver that reports to `events` and serves the model's tool calls from `host`.
    pub fn new(options: HermesOptions, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Arc<HermesDriver> {
        let shared = Shared { model: options.model.clone(), thinking: options.thinking.clone(), ..Default::default() };
        Arc::new(HermesDriver { options, host, events, shared: Arc::new(Mutex::new(shared)), starting: tokio::sync::Mutex::new(()) })
    }

    fn init_frame(&self, model: Option<String>, thinking: Option<String>, resume: Option<String>) -> Value {
        let host_tools: Vec<Value> =
            self.host.specs().into_iter().map(|tool| json!({"name": tool.name, "description": tool.description, "schema": tool.schema})).collect();
        json!({
            "type": "init",
            "cwd": self.options.cwd.display().to_string(),
            "system_prompt": self.options.system_prompt,
            "builtin_tools": self.options.builtin_tools,
            "host_tools": host_tools,
            "model": model,
            "thinking": thinking,
            "persist": self.options.persist,
            "context_files": self.options.context_files,
            "memory": self.options.memory,
            "background_review": self.options.background_review,
            "max_turns": self.options.max_turns,
            "resume": resume,
        })
    }

    /// The running process, starting one that resumes `resume` when none runs.
    async fn process(self: &Arc<Self>, resume: Option<String>) -> Result<Arc<Proc>, String> {
        let _one = self.starting.lock().await;
        {
            let state = lock(&self.shared);
            if state.closed {
                return Err("The session is closed".into());
            }
            if let Some(process) = state.process.clone() {
                return Ok(process);
            }
        }
        ensure_bridge_file(&self.options.bridge_file)?;
        std::fs::create_dir_all(&self.options.cwd).map_err(|error| format!("Cannot create {}: {error}", self.options.cwd.display()))?;
        let (model, thinking) = {
            let state = lock(&self.shared);
            if state.closed {
                return Err("The session is closed".into());
            }
            (state.model.clone(), state.thinking.clone())
        };
        let launch = resolve_launch(&self.options.program, &self.options.bridge_file, &[], &self.options.cwd, &self.options.env).await;
        if lock(&self.shared).closed {
            return Err("The session is closed".into());
        }
        let (process, lines) = Proc::spawn(&launch)?;
        let (ready_tx, ready_rx) = oneshot::channel();
        let generation = {
            let mut state = lock(&self.shared);
            if state.closed {
                None
            } else {
                state.generation += 1;
                state.process = Some(process.clone());
                state.ready = Some(ready_tx);
                state.awaiting_async = false;
                Some(state.generation)
            }
        };
        let Some(generation) = generation else {
            process.close(Duration::from_secs(2)).await;
            return Err("The session is closed".into());
        };
        let reader = self.clone();
        tokio::spawn(async move { reader.read(generation, lines).await });

        let init = self.init_frame(model, thinking, resume);
        if let Err(error) = process.send(&init).await {
            self.close_now().await;
            return if lock(&self.shared).closed { Err("The session is closed".into()) } else { Err(error) };
        }
        match tokio::time::timeout(Duration::from_secs(60), ready_rx).await {
            Ok(Ok(Ok(()))) => {
                if lock(&self.shared).closed {
                    self.close_now().await;
                    return Err("The session is closed".into());
                }
                Ok(process)
            }
            Ok(Ok(Err(why))) => {
                self.close_now().await;
                if lock(&self.shared).closed {
                    Err("The session is closed".into())
                } else {
                    Err(why)
                }
            }
            _ => {
                self.close_now().await;
                if lock(&self.shared).closed {
                    Err("The session is closed".into())
                } else {
                    Err("Hermes did not become ready within 60 seconds".into())
                }
            }
        }
    }

    async fn read(self: Arc<Self>, generation: u64, mut lines: mpsc::UnboundedReceiver<Line>) {
        while let Some(line) = lines.recv().await {
            match line {
                Line::Json(frame) => self.frame(generation, frame),
                Line::Exited(error) => {
                    let (current, awaited) = {
                        let mut state = lock(&self.shared);
                        if state.generation != generation {
                            (false, false)
                        } else {
                            state.process = None;
                            if let Some(ready) = state.ready.take() {
                                let _ = ready.send(Err(error.clone().unwrap_or_else(|| "Hermes ended before it was ready".into())));
                            }
                            for (_, waiter) in state.requests.drain() {
                                let _ = waiter.send(Err("Hermes ended".into()));
                            }
                            (true, std::mem::replace(&mut state.awaiting_async, false))
                        }
                    };
                    if current {
                        let _ = self.events.send(DriverEvent::Exited { error, awaited });
                    }
                    return;
                }
            }
        }
    }

    fn frame(self: &Arc<Self>, generation: u64, frame: Value) {
        if lock(&self.shared).generation != generation {
            return;
        }
        match frame["type"].as_str().unwrap_or("") {
            "ready" => {
                if self.options.persist {
                    if let Some(id) = frame["session_id"].as_str().filter(|id| !id.is_empty()) {
                        let _ = self.events.send(DriverEvent::SessionId(id.to_string()));
                    }
                }
                if let Some(ready) = lock(&self.shared).ready.take() {
                    let _ = ready.send(Ok(()));
                }
            }
            "error" => {
                let why = frame["error"].as_str().unwrap_or("Hermes failed").to_string();
                if let Some(ready) = lock(&self.shared).ready.take() {
                    let _ = ready.send(Err(why));
                }
            }
            "running" => {
                let _ = self.events.send(DriverEvent::Running);
            }
            "taken" => {
                if let Some(id) = frame["id"].as_str() {
                    let _ = self.events.send(DriverEvent::Taken(id.to_string()));
                }
            }
            "retry" => {
                let _ = self.events.send(DriverEvent::Retry);
            }
            "assistant" => {
                if let Some(message) = assistant_message(&frame) {
                    let _ = self.events.send(DriverEvent::Message(message));
                }
            }
            "tool_result_msg" => {
                let text: String = frame["text"].as_str().unwrap_or("").chars().take(2000).collect();
                let _ = self.events.send(DriverEvent::Message(Message { role: Role::ToolResult, content: vec![Block::text(text)], stop_reason: None }));
            }
            "idle" => {
                let awaiting_async = frame["awaiting_async"] == true;
                lock(&self.shared).awaiting_async = awaiting_async;
                let _ = self.events.send(DriverEvent::Idle { awaiting_async });
            }
            "guard" => {
                let Some(call_id) = frame["call_id"].as_str().map(str::to_string) else { return };
                let raw_tool = frame["tool"].as_str().unwrap_or("");
                let (tool, input) = host_view(raw_tool, &frame["input"]);
                let driver = self.clone();
                tokio::spawn(async move {
                    let reply = match driver.host.guard(&tool, &input).await {
                        Guard::Allow => json!({"type": "guard_result", "call_id": call_id, "allow": true}),
                        Guard::Block(reason) => json!({"type": "guard_result", "call_id": call_id, "allow": false, "reason": reason}),
                    };
                    let process = lock(&driver.shared).process.clone();
                    if let Some(process) = process {
                        let _ = process.send(&reply).await;
                    }
                });
            }
            "tool_call" => {
                let Some(call_id) = frame["call_id"].as_str().map(str::to_string) else { return };
                let Some(name) = frame["name"].as_str().map(str::to_string) else { return };
                let arguments = frame.get("arguments").cloned().unwrap_or_else(|| json!({}));
                let driver = self.clone();
                tokio::spawn(async move {
                    let reply = match driver.host.call(&name, arguments).await {
                        Ok(result) => json!({"type": "tool_result", "call_id": call_id, "ok": true, "result": result}),
                        Err(error) => json!({"type": "tool_result", "call_id": call_id, "ok": false, "error": error}),
                    };
                    let process = lock(&driver.shared).process.clone();
                    if let Some(process) = process {
                        let _ = process.send(&reply).await;
                    }
                });
            }
            "response" => {
                if let Some(req_id) = frame["req_id"].as_str() {
                    if let Some(waiter) = lock(&self.shared).requests.remove(req_id) {
                        let _ = waiter.send(Ok(frame));
                    }
                }
            }
            _ => {}
        }
    }

    async fn ask(&self, mut request: Value) -> Result<Value, String> {
        let Some(process) = lock(&self.shared).process.clone() else { return Err("Hermes is not running".into()) };
        let req_id = uuid();
        request["req_id"] = json!(req_id);
        let (tx, rx) = oneshot::channel();
        lock(&self.shared).requests.insert(req_id.clone(), tx);
        if let Err(error) = process.send(&request).await {
            lock(&self.shared).requests.remove(&req_id);
            return Err(error);
        }
        match tokio::time::timeout(ANSWER, rx).await {
            Ok(Ok(answer)) => answer,
            _ => {
                lock(&self.shared).requests.remove(&req_id);
                Err("Hermes did not answer in time".into())
            }
        }
    }

    async fn close_now(&self) {
        let process = {
            let mut state = lock(&self.shared);
            state.generation += 1;
            if let Some(ready) = state.ready.take() {
                let _ = ready.send(Err("The session is closed".into()));
            }
            state.awaiting_async = false;
            for (_, waiter) in state.requests.drain() {
                let _ = waiter.send(Err("The session is closed".into()));
            }
            state.process.take()
        };
        if let Some(process) = process {
            let _ = process.send(&json!({"type": "close"})).await;
            process.close(Duration::from_secs(2)).await;
        }
    }
}

/// [`HermesDriver`] as a [`Driver`].
pub struct Hermes(pub Arc<HermesDriver>);

impl Driver for Hermes {
    fn kernel(&self) -> &'static str {
        "hermes"
    }

    fn warm<'a>(&'a self, resume: Option<String>) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move { self.0.process(resume).await.map(|_| ()) })
    }

    fn submit<'a>(&'a self, id: &'a str, content: &'a [Block], deliver: Deliver, resume: Option<String>) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            let process = self.0.process(resume).await?;
            let mode = match deliver {
                Deliver::Steer => "steer",
                Deliver::FollowUp => "follow_up",
            };
            process.send(&json!({"type": "submit", "id": id, "deliver": mode, "content": content})).await
        })
    }

    fn interrupt(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            let process = lock(&self.0.shared).process.clone();
            if let Some(process) = process {
                let _ = process.send(&json!({"type": "interrupt"})).await;
            }
        })
    }

    fn jobs(&self) -> BoxFut<'_, Vec<KernelJob>> {
        Box::pin(async move {
            let Ok(answer) = self.0.ask(json!({"type": "jobs"})).await else { return Vec::new() };
            answer["jobs"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|job| KernelJob {
                    id: job["id"].as_str().unwrap_or("").into(),
                    kind: match job["kind"].as_str() {
                        Some("task") => JobKind::Task,
                        Some("eval") => JobKind::Eval,
                        _ => JobKind::Bash,
                    },
                    label: job["label"].as_str().unwrap_or("").into(),
                    start_time: job["startTime"].as_i64().unwrap_or(0),
                    progress: job["progress"].as_str().map(str::to_string),
                    command: job["command"].as_str().map(str::to_string),
                    own: job["own"].as_bool().unwrap_or(true),
                    pids: job["pids"].as_array().into_iter().flatten().filter_map(|pid| pid.as_u64().map(|pid| pid as u32)).collect(),
                })
                .collect()
        })
    }

    fn acknowledge<'a>(&'a self, ids: &'a [String]) -> BoxFut<'a, ()> {
        Box::pin(async move {
            if !ids.is_empty() {
                let _ = self.0.ask(json!({"type": "ack", "ids": ids})).await;
            }
        })
    }

    fn cancel<'a>(&'a self, id: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async move { self.0.ask(json!({"type": "cancel", "job": id})).await.ok().and_then(|res| res["cancelled"].as_bool()).unwrap_or(false) })
    }

    fn set_model<'a>(&'a self, model: Option<&'a str>, thinking: Option<&'a str>) -> BoxFut<'a, ()> {
        Box::pin(async move {
            let (next_model, next_thinking) = (model.map(str::to_string), thinking.map(str::to_string));
            {
                let mut state = lock(&self.0.shared);
                state.model = next_model.clone();
                state.thinking = next_thinking.clone();
            }
            let _ = self.0.ask(json!({"type": "set_model", "model": next_model, "thinking": next_thinking})).await;
        })
    }

    fn pid(&self) -> Option<u32> {
        lock(&self.0.shared).process.as_ref().map(|process| process.pid())
    }

    fn close(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            lock(&self.0.shared).closed = true;
            self.0.close_now().await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ToolSpec;

    #[test]
    fn maps_hermes_tools_to_host_guard_kinds() {
        assert_eq!(host_view("terminal", &json!({"command": "cargo test"})), ("bash".into(), json!({"command": "cargo test"})));
        assert_eq!(host_view("write_file", &json!({"path": "a.txt"})), ("write".into(), json!({"path": "a.txt"})));
        assert_eq!(host_view("patch", &json!({"path": "b.rs"})), ("edit".into(), json!({"path": "b.rs"})));
        assert_eq!(host_view("read_file", &json!({"path": "c.md"})), ("read".into(), json!({"path": "c.md"})));
        assert_eq!(host_view("delegate_task", &json!({"goal": "slice"})), ("task".into(), json!({"goal": "slice"})));
        assert_eq!(host_view("orchestrator_report", &json!({"state": "ready"})), ("orchestrator_report".into(), json!({"state": "ready"})));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resolves_an_official_hermes_launcher_command() {
        use std::os::unix::fs::PermissionsExt;
        let dir = neo_testkit::TempDir::new("hermes-launcher");
        let launcher = dir.join("hermes");
        let bootstrap = format!("import sys, runpy; {DEFAULT_MODULE_CALL}");
        let payload = serde_json::to_string(&vec!["/usr/bin/python3", "-I", "-c", &bootstrap]).unwrap();
        std::fs::write(
            &launcher,
            format!("#!/bin/sh\nif [ \"$1\" = \"--print-runtime-command\" ]; then\n  cat <<'EOF'\n{payload}\nEOF\n  exit 0\nfi\nexit 1\n"),
        )
        .unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bridge = dir.join("bridge.py");
        let launch = resolve_launch(&launcher, &bridge, &["--list-models".into()], dir.path(), &BTreeMap::new()).await;
        assert_eq!(launch.program, PathBuf::from("/usr/bin/python3"));
        assert!(launch.args[2].contains(BRIDGE_PATH_CALL), "{:?}", launch.args);
        assert_eq!(launch.args[3], bridge.display().to_string());
        assert_eq!(launch.args[4], "--list-models");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn caches_the_runtime_command_probe_across_launches() {
        use std::os::unix::fs::PermissionsExt;
        let dir = neo_testkit::TempDir::new("hermes-probe-cache");
        let launcher = dir.join("hermes");
        let count_file = dir.join("probe-count");
        let bootstrap = format!("import sys, runpy; {DEFAULT_MODULE_CALL}");
        let payload = serde_json::to_string(&vec!["/usr/bin/python3", "-I", "-c", &bootstrap]).unwrap();
        std::fs::write(
            &launcher,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"--print-runtime-command\" ]; then\n  printf x >> '{}'\n  cat <<'EOF'\n{payload}\nEOF\n  exit 0\nfi\nexit 1\n",
                count_file.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bridge_a = dir.join("bridge-a.py");
        let bridge_b = dir.join("bridge-b.py");
        let first = resolve_launch(&launcher, &bridge_a, &[], dir.path(), &BTreeMap::new()).await;
        let second = resolve_launch(&launcher, &bridge_b, &["--list-models".into()], dir.path(), &BTreeMap::new()).await;
        assert_eq!(std::fs::read_to_string(&count_file).unwrap(), "x");
        assert_eq!(first.args[3], bridge_a.display().to_string());
        assert_eq!(second.args[3], bridge_b.display().to_string());
        assert_eq!(second.args[4], "--list-models");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn drives_a_session_over_the_bridge_protocol() {
        use std::os::unix::fs::PermissionsExt;

        struct FakeHost;
        impl ToolHost for FakeHost {
            fn specs(&self) -> Vec<ToolSpec> {
                vec![ToolSpec { name: "orchestrator_report".into(), description: "Report".into(), schema: json!({"type": "object"}) }]
            }
            fn call<'a>(&'a self, name: &'a str, arguments: Value) -> BoxFut<'a, Result<Value, String>> {
                Box::pin(async move { Ok(json!({"called": name, "args": arguments})) })
            }
            fn guard<'a>(&'a self, tool: &'a str, input: &'a Value) -> BoxFut<'a, Guard> {
                Box::pin(async move {
                    if tool == "bash" && input["command"].as_str() == Some("forbidden") {
                        Guard::Block("blocked command".into())
                    } else {
                        Guard::Allow
                    }
                })
            }
        }

        let dir = neo_testkit::TempDir::new("hermes-proto");
        let fake = dir.join("fake-hermes");
        let script = r#"#!/usr/bin/env python3
import json, sys

if sys.argv[2:] == ["--list-models"]:
    print(json.dumps({"type": "models", "models": [{"provider": "openrouter", "id": "claude-sonnet", "name": "Claude Sonnet"}]}), flush=True)
    sys.exit(0)

init = json.loads(sys.stdin.readline())
assert init["type"] == "init"
print(json.dumps({"type": "ready", "session_id": init.get("resume") or "hermes-sess-1"}), flush=True)

for line in sys.stdin:
    frame = json.loads(line)
    kind = frame["type"]
    if kind == "submit":
        print(json.dumps({"type": "running"}), flush=True)
        print(json.dumps({"type": "taken", "id": frame["id"]}), flush=True)
        print(json.dumps({"type": "guard", "call_id": "g1", "tool": "terminal", "input": {"command": "forbidden"}}), flush=True)
        g1 = json.loads(sys.stdin.readline())
        assert g1["allow"] is False and "blocked command" in g1["reason"]
        print(json.dumps({"type": "tool_call", "call_id": "t1", "name": "orchestrator_report", "arguments": {"state": "ready"}}), flush=True)
        t1 = json.loads(sys.stdin.readline())
        assert t1["ok"] is True and t1["result"]["called"] == "orchestrator_report"
        print(json.dumps({"type": "assistant", "content": [{"type": "text", "text": "Done!"}], "stop_reason": "stop"}), flush=True)
        print(json.dumps({"type": "idle", "awaiting_async": True}), flush=True)
    elif kind == "jobs":
        print(json.dumps({"type": "response", "req_id": frame["req_id"], "jobs": [{"id": "proc_1", "kind": "bash", "label": "sleep 10", "startTime": 100, "command": "sleep 10", "own": True, "pids": [42]}]}), flush=True)
    elif kind == "ack":
        print(json.dumps({"type": "response", "req_id": frame["req_id"], "ok": True}), flush=True)
    elif kind == "cancel":
        print(json.dumps({"type": "response", "req_id": frame["req_id"], "cancelled": frame["job"] == "proc_1"}), flush=True)
    elif kind == "close":
        break
"#;
        std::fs::write(&fake, script).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let bridge = dir.join("bridge.py");
        let models = list_models(&fake, &bridge, dir.path(), &BTreeMap::new()).await.unwrap();
        assert_eq!(models, vec![ModelInfo { provider: "openrouter".into(), id: "claude-sonnet".into(), name: "Claude Sonnet".into() }]);

        let (tx, mut rx) = mpsc::unbounded_channel();
        let options = HermesOptions {
            program: fake,
            bridge_file: bridge,
            cwd: dir.join("work"),
            system_prompt: "prompt".into(),
            builtin_tools: vec!["read".into(), "bash".into()],
            persist: true,
            ..Default::default()
        };
        let driver = Hermes(HermesDriver::new(options, Arc::new(FakeHost), tx));
        driver.submit("s1", &[Block::text("hi")], Deliver::FollowUp, None).await.unwrap();

        let mut seen = Vec::new();
        while let Ok(Some(ev)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            let done = matches!(ev, DriverEvent::Idle { .. });
            seen.push(ev);
            if done {
                break;
            }
        }
        assert!(seen.contains(&DriverEvent::SessionId("hermes-sess-1".into())), "{seen:?}");
        assert!(seen.contains(&DriverEvent::Taken("s1".into())), "{seen:?}");
        assert!(seen.contains(&DriverEvent::Idle { awaiting_async: true }), "{seen:?}");

        let jobs = driver.jobs().await;
        assert_eq!(jobs.len(), 1);
        assert_eq!((jobs[0].id.as_str(), jobs[0].pids.as_slice()), ("proc_1", &[42][..]));
        driver.acknowledge(&["proc_1".into()]).await;
        assert!(driver.cancel("proc_1").await);
        assert!(!driver.cancel("missing").await);
        driver.close().await;
    }
}
