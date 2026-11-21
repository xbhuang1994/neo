//! The Oh My Pi kernel: one `omp --mode rpc` process per Session, driven over its newline-delimited JSON protocol.
//! The host's tools are OMP host tools; the tool-call guard and background-job control go through the shim extension
//! (`shim/neo-omp-shim.ts`), which answers over frames RPC mode already has.

use crate::process::{Launch, Line, Proc};
use crate::session::{Driver, DriverEvent};
use crate::types::{uuid, Block, BoxFut, Deliver, Guard, JobKind, KernelJob, Message, Role, ToolHost};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// Starts every request the host sends to the shim; the shim consumes such prompts, so the model never sees them.
pub const SENTINEL: &str = "@@neo-shim@@";
/// The status key under which the shim answers.
pub const STATUS_KEY: &str = "neo-shim";
/// Starts the title of the shim's question about a tool call.
pub const GUARD_TITLE: &str = "neo-guard:";
/// The owner id OMP gives the Session's own background jobs.
const MAIN_AGENT: &str = "Main";

/// How an OMP Session runs.
#[derive(Clone, Default)]
pub struct OmpOptions {
    /// The `omp` executable.
    pub program: PathBuf,
    /// The shim extension file.
    pub shim: PathBuf,
    /// The Session's working directory.
    pub cwd: PathBuf,
    /// OMP's agent directory: credentials, `models.yml`, agent definitions.
    pub agent_dir: PathBuf,
    /// Where OMP keeps this Session's own context file; `None` for a Session that keeps none.
    pub session_dir: Option<PathBuf>,
    /// A file holding the whole system prompt (a file, because a prompt can exceed what a command line carries).
    pub system_prompt_file: PathBuf,
    /// The built-in tools the model may use, such as `read` and `bash`.
    pub builtin_tools: Vec<String>,
    /// The model as `provider/model`, or the runtime's default.
    pub model: Option<String>,
    /// The thinking level.
    pub thinking: Option<String>,
    /// Settings overlay files, such as background jobs and compaction thresholds.
    pub config: Vec<PathBuf>,
    /// Load the project's context files (AGENTS.md and the like); for workers only.
    pub context_files: bool,
    /// Pins the provider's prompt cache for Sessions that share a prefix.
    pub prompt_cache_key: Option<String>,
    /// Variables to set for the runtime.
    pub env: BTreeMap<String, String>,
}

/// The command line and environment of an OMP process; `resume` is the Session's own context file.
pub fn launch(options: &OmpOptions, resume: Option<&str>) -> Launch {
    let mut args: Vec<String> =
        ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-title", "--approval-mode", "yolo"].map(String::from).to_vec();
    fn flag(args: &mut Vec<String>, name: &str, value: &str) {
        args.extend([name.to_string(), value.to_string()]);
    }
    flag(&mut args, "--extension", &options.shim.display().to_string());
    flag(&mut args, "--system-prompt", &options.system_prompt_file.display().to_string());
    flag(&mut args, "--tools", &options.builtin_tools.join(","));
    flag(&mut args, "--cwd", &options.cwd.display().to_string());
    if !options.context_files {
        args.push("--no-context-files".into());
    }
    match &options.session_dir {
        Some(dir) => {
            flag(&mut args, "--session-dir", &dir.display().to_string());
            if let Some(file) = resume {
                flag(&mut args, "--resume", file);
            }
        }
        None => args.push("--no-session".into()),
    }
    if let Some(model) = options.model.as_deref().filter(|model| !model.is_empty()) {
        flag(&mut args, "--model", model);
    }
    if let Some(level) = options.thinking.as_deref().filter(|level| !level.is_empty()) {
        flag(&mut args, "--thinking", level);
    }
    for overlay in &options.config {
        flag(&mut args, "--config", &overlay.display().to_string());
    }
    if let Some(key) = &options.prompt_cache_key {
        flag(&mut args, "--prompt-cache-key", key);
    }
    let mut env = options.env.clone();
    env.insert("PI_CODING_AGENT_DIR".into(), options.agent_dir.display().to_string());
    Launch { program: options.program.clone(), args, cwd: options.cwd.clone(), env, env_remove: Vec::new() }
}

/// A model the runtime can use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelInfo {
    /// The provider, as the runtime names it.
    pub provider: String,
    /// The model id.
    pub id: String,
    /// A display name.
    pub name: String,
}

/// The models Oh My Pi can use with the credentials in `agent_dir`, asked from a short-lived runtime process.
pub async fn list_models(program: &std::path::Path, agent_dir: &std::path::Path, cwd: &std::path::Path) -> Result<Vec<ModelInfo>, String> {
    let args = ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-title", "--no-context-files"]
        .map(String::from)
        .to_vec();
    let env = BTreeMap::from([("PI_CODING_AGENT_DIR".to_string(), agent_dir.display().to_string())]);
    let (process, mut lines) = Proc::spawn(&Launch { program: program.to_path_buf(), args, cwd: cwd.to_path_buf(), env, env_remove: Vec::new() })?;
    let asked = async {
        let mut sent = false;
        while let Some(line) = lines.recv().await {
            match line {
                Line::Json(frame) if frame["type"] == "ready" && !sent => {
                    process.send(&json!({"id": "models", "type": "get_available_models"})).await?;
                    sent = true;
                }
                Line::Json(frame) if frame["type"] == "response" && frame["id"] == "models" => {
                    if frame["success"] != true {
                        return Err(frame["error"].as_str().unwrap_or("Oh My Pi could not list its models").to_string());
                    }
                    let models = frame["data"]["models"].as_array().cloned().unwrap_or_default();
                    return Ok(models
                        .iter()
                        .filter_map(|model| {
                            let id = model["id"].as_str()?.to_string();
                            Some(ModelInfo { provider: model["provider"].as_str()?.to_string(), name: model["name"].as_str().unwrap_or(&id).to_string(), id })
                        })
                        .collect());
                }
                Line::Exited(error) => return Err(error.unwrap_or_else(|| "Oh My Pi ended before listing its models".into())),
                Line::Json(_) => {}
            }
        }
        Err("Oh My Pi ended before listing its models".to_string())
    };
    let result =
        tokio::time::timeout(Duration::from_secs(60), asked).await.unwrap_or_else(|_| Err("Oh My Pi did not list its models within 60 seconds".into()));
    process.close(Duration::from_secs(1)).await;
    result
}

/// An OMP message as the transcript keeps it; `None` for one the transcript does not keep.
fn message_of(message: &Value) -> Option<Message> {
    let blocks = message["content"].as_array().cloned().unwrap_or_default();
    match message["role"].as_str()? {
        "assistant" => {
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
            let stop = message["stopReason"].as_str().unwrap_or("stop");
            let failed = matches!(stop, "error" | "aborted");
            if content.is_empty() && !failed {
                return None;
            }
            let content = if content.is_empty() { vec![Block::text(message["errorMessage"].as_str().unwrap_or(stop))] } else { content };
            Some(Message { role: Role::Assistant, content, stop_reason: Some(stop.to_string()) })
        }
        "toolResult" => {
            let text: String = blocks.iter().filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n").chars().take(2000).collect();
            Some(Message { role: Role::ToolResult, content: vec![Block::text(text)], stop_reason: None })
        }
        _ => None,
    }
}

#[derive(Default)]
struct Shared {
    process: Option<Arc<Proc>>,
    generation: u64,
    /// Commands awaiting their `response` frame.
    commands: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    /// Shim requests awaiting their status frame.
    shim: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    /// Told when the runtime is ready, or why it ended before.
    ready: Option<oneshot::Sender<Result<(), String>>>,
    /// The last turn ended with background jobs running.
    awaiting_async: bool,
    closed: bool,
    model: Option<String>,
    thinking: Option<String>,
}

/// One OMP Session's runtime.
pub struct OmpDriver {
    options: OmpOptions,
    host: Arc<dyn ToolHost>,
    events: mpsc::UnboundedSender<DriverEvent>,
    shared: Arc<Mutex<Shared>>,
    starting: tokio::sync::Mutex<()>,
}

fn lock(shared: &Mutex<Shared>) -> std::sync::MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

const ANSWER: Duration = Duration::from_secs(30);

impl OmpDriver {
    /// A driver that reports to `events` and serves the model's tool calls from `host`.
    pub fn new(options: OmpOptions, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Arc<OmpDriver> {
        let shared = Shared { model: options.model.clone(), thinking: options.thinking.clone(), ..Default::default() };
        Arc::new(OmpDriver { options, host, events, shared: Arc::new(Mutex::new(shared)), starting: tokio::sync::Mutex::new(()) })
    }

    /// The running process, starting one that resumes the context file `resume` when none runs.
    async fn process(self: &Arc<Self>, resume: Option<String>) -> Result<Arc<Proc>, String> {
        let _one = self.starting.lock().await;
        {
            let shared = lock(&self.shared);
            if shared.closed {
                return Err("The session is closed".into());
            }
            if let Some(process) = shared.process.clone() {
                return Ok(process);
            }
        }
        let mut options = self.options.clone();
        {
            let shared = lock(&self.shared);
            if shared.closed {
                return Err("The session is closed".into());
            }
            options.model = shared.model.clone();
            options.thinking = shared.thinking.clone();
        }
        // A context file that is gone cannot be resumed; the Session's transcript still shows what was said.
        let resume = resume.filter(|file| std::path::Path::new(file).is_file());
        let (process, lines) = Proc::spawn(&launch(&options, resume.as_deref()))?;
        let (ready, is_ready) = oneshot::channel();
        let generation = {
            let mut shared = lock(&self.shared);
            if shared.closed {
                None
            } else {
                shared.generation += 1;
                shared.process = Some(process.clone());
                shared.ready = Some(ready);
                Some(shared.generation)
            }
        };
        let Some(generation) = generation else {
            process.close(Duration::from_secs(1)).await;
            return Err("The session is closed".into());
        };
        tokio::spawn(self.clone().read(lines, generation));
        let started = async {
            is_ready.await.map_err(|_| "Oh My Pi ended before it was ready".to_string())??;
            let tools: Vec<Value> = self
                .host
                .specs()
                .iter()
                .map(|spec| json!({"name": spec.name, "description": spec.description, "parameters": spec.schema, "loadMode": "essential"}))
                .collect();
            if !tools.is_empty() {
                self.command(&process, json!({"type": "set_host_tools", "tools": tools})).await?;
            }
            let state = self.command(&process, json!({"type": "get_state"})).await?;
            if let Some(file) = state["sessionFile"].as_str() {
                let _ = self.events.send(DriverEvent::SessionId(file.to_string()));
            }
            Ok::<(), String>(())
        };
        match tokio::time::timeout(Duration::from_secs(90), started).await {
            Ok(Ok(())) => {
                if lock(&self.shared).closed {
                    self.forget(&process).await;
                    return Err("The session is closed".into());
                }
                Ok(process)
            }
            Ok(Err(error)) => {
                self.forget(&process).await;
                if lock(&self.shared).closed {
                    Err("The session is closed".into())
                } else {
                    Err(format!("Oh My Pi did not start: {error}"))
                }
            }
            Err(_) => {
                self.forget(&process).await;
                if lock(&self.shared).closed {
                    Err("The session is closed".into())
                } else {
                    Err("Oh My Pi was not ready within 90 seconds".into())
                }
            }
        }
    }

    async fn forget(&self, process: &Arc<Proc>) {
        {
            let mut shared = lock(&self.shared);
            if shared.process.as_ref().is_some_and(|current| Arc::ptr_eq(current, process)) {
                shared.process = None;
                shared.generation += 1;
            }
        }
        process.close(Duration::from_secs(1)).await;
    }

    /// Send a command and wait for its `response`.
    async fn command(&self, process: &Proc, mut command: Value) -> Result<Value, String> {
        let id = format!("c_{}", uuid());
        command["id"] = json!(id);
        let (answer, answered) = oneshot::channel();
        lock(&self.shared).commands.insert(id.clone(), answer);
        if let Err(error) = process.send(&command).await {
            lock(&self.shared).commands.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(ANSWER, answered).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Oh My Pi ended before answering".into()),
            Err(_) => {
                lock(&self.shared).commands.remove(&id);
                Err(format!("Oh My Pi did not answer {} within {} seconds", command["type"].as_str().unwrap_or("a command"), ANSWER.as_secs()))
            }
        }
    }

    /// Ask the shim extension for something and wait for its status frame.
    async fn shim(&self, mut call: Value) -> Result<Value, String> {
        let Some(process) = self.current() else { return Err("Oh My Pi is not running".into()) };
        let id = format!("s_{}", uuid());
        call["id"] = json!(id);
        let (answer, answered) = oneshot::channel();
        lock(&self.shared).shim.insert(id.clone(), answer);
        let sent = process.send(&json!({"id": id, "type": "prompt", "message": format!("{SENTINEL}{call}")})).await;
        let result = match sent {
            Err(error) => Err(error),
            Ok(()) => match tokio::time::timeout(ANSWER, answered).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err("Oh My Pi ended before answering".into()),
                Err(_) => Err("The shim extension did not answer; is it loaded?".into()),
            },
        };
        lock(&self.shared).shim.remove(&id);
        result
    }

    async fn read(self: Arc<Self>, mut lines: mpsc::UnboundedReceiver<Line>, generation: u64) {
        while let Some(line) = lines.recv().await {
            if lock(&self.shared).generation != generation {
                return;
            }
            match line {
                Line::Json(frame) => self.handle(frame),
                Line::Exited(error) => {
                    let awaited = {
                        let mut shared = lock(&self.shared);
                        shared.process = None;
                        // Whoever waits for it to start hears why it could not, in the runtime's own words.
                        if let Some(ready) = shared.ready.take() {
                            let _ = ready.send(Err(error.clone().unwrap_or_else(|| "Oh My Pi ended before it was ready".into())));
                        }
                        let waiting: Vec<_> = shared.commands.drain().map(|(_, answer)| answer).collect();
                        for answer in waiting.into_iter().chain(std::mem::take(&mut shared.shim).into_values()) {
                            let _ = answer.send(Err("Oh My Pi ended before answering".into()));
                        }
                        std::mem::take(&mut shared.awaiting_async)
                    };
                    let _ = self.events.send(DriverEvent::Exited { error, awaited });
                    return;
                }
            }
        }
    }

    fn emit(&self, event: DriverEvent) {
        let _ = self.events.send(event);
    }

    /// The running process, if any.
    fn current(&self) -> Option<Arc<Proc>> {
        lock(&self.shared).process.clone()
    }

    fn handle(self: &Arc<Self>, frame: Value) {
        match frame["type"].as_str().unwrap_or("") {
            "ready" => {
                if let Some(ready) = lock(&self.shared).ready.take() {
                    let _ = ready.send(Ok(()));
                }
            }
            "response" => {
                // The shim consumes its own prompts, whose acknowledgements nobody waits for.
                let Some(answer) = frame["id"].as_str().and_then(|id| lock(&self.shared).commands.remove(id)) else { return };
                let _ = answer.send(if frame["success"] == true {
                    Ok(frame.get("data").cloned().unwrap_or(Value::Null))
                } else {
                    Err(frame["error"].as_str().unwrap_or("the command failed").to_string())
                });
            }
            "agent_start" => {
                lock(&self.shared).awaiting_async = false;
                self.emit(DriverEvent::Running);
            }
            "agent_end" => {
                let awaiting = frame["awaitingAsyncWork"] == true || frame["isTerminal"] == false;
                lock(&self.shared).awaiting_async = awaiting;
                self.emit(DriverEvent::Idle { awaiting_async: awaiting });
            }
            "auto_retry_start" => self.emit(DriverEvent::Retry),
            "message_end" => {
                let message = &frame["message"];
                if message["role"] == "user" {
                    // The runtime took a submitted message into a turn; it does not say which, so the oldest counts.
                    if message["attribution"] == "user" {
                        self.emit(DriverEvent::Taken(String::new()));
                    }
                } else if let Some(message) = message_of(message) {
                    self.emit(DriverEvent::Message(message));
                }
            }
            "host_tool_call" => {
                let driver = self.clone();
                tokio::spawn(async move { driver.serve_tool(frame).await });
            }
            "extension_ui_request" => {
                let driver = self.clone();
                tokio::spawn(async move { driver.serve_ui(frame).await });
            }
            _ => {}
        }
    }

    async fn reply(&self, frame: Value) {
        if let Some(process) = self.current() {
            let _ = process.send(&frame).await;
        }
    }

    /// Run one of the host's tools for the model.
    async fn serve_tool(&self, frame: Value) {
        let (Some(id), Some(name)) = (frame["id"].as_str(), frame["toolName"].as_str()) else { return };
        let (text, failed) = match self.host.call(name, frame.get("arguments").cloned().unwrap_or_else(|| json!({}))).await {
            Ok(value) => (value.to_string(), false),
            Err(error) => (error, true),
        };
        self.reply(json!({"type": "host_tool_result", "id": id, "result": {"content": [{"type": "text", "text": text}]}, "isError": failed})).await;
    }

    /// Answer the shim: its results arrive as status frames, and its tool-call questions as input requests.
    async fn serve_ui(&self, frame: Value) {
        let Some(id) = frame["id"].as_str() else { return };
        match frame["method"].as_str().unwrap_or("") {
            "setStatus" if frame["statusKey"] == STATUS_KEY => {
                let Ok(answer) = serde_json::from_str::<Value>(frame["statusText"].as_str().unwrap_or("")) else { return };
                let Some(waiting) = answer["id"].as_str().and_then(|id| lock(&self.shared).shim.remove(id)) else { return };
                let _ = waiting.send(match answer.get("error").and_then(Value::as_str) {
                    Some(error) => Err(error.to_string()),
                    None => Ok(answer.get("result").cloned().unwrap_or(Value::Null)),
                });
            }
            "input" if frame["title"].as_str().is_some_and(|title| title.starts_with(GUARD_TITLE)) => {
                let call: Value = serde_json::from_str(&frame["title"].as_str().unwrap_or("")[GUARD_TITLE.len()..]).unwrap_or(Value::Null);
                let verdict = match self.host.guard(call["tool"].as_str().unwrap_or(""), &call["input"]).await {
                    Guard::Allow => "ok".to_string(),
                    Guard::Block(reason) => format!("block:{reason}"),
                };
                self.reply(json!({"type": "extension_ui_response", "id": id, "value": verdict})).await;
            }
            // Nobody sits at this runtime: any other dialog is dismissed rather than left open.
            "select" | "confirm" | "input" | "editor" | "ask" => self.reply(json!({"type": "extension_ui_response", "id": id, "cancelled": true})).await,
            _ => {}
        }
    }
}

/// Lets the driver be used through `Arc<dyn Driver>` while its methods need the `Arc` to spawn tasks.
pub struct Omp(pub Arc<OmpDriver>);

impl Driver for Omp {
    fn kernel(&self) -> &'static str {
        "omp"
    }
    fn warm<'a>(&'a self, resume: Option<String>) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move { self.0.process(resume).await.map(|_| ()) })
    }
    fn submit<'a>(&'a self, _id: &'a str, content: &'a [Block], deliver: Deliver, resume: Option<String>) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            let process = self.0.process(resume).await?;
            let images: Vec<Value> = content
                .iter()
                .filter_map(|block| {
                    if let Block::Image { mime_type, data } = block {
                        Some(json!({"type": "image", "data": data, "mimeType": mime_type}))
                    } else {
                        None
                    }
                })
                .collect();
            // While a turn runs, a steered message joins it at its next tool boundary and a follow-up waits for its end.
            // Deliveries read as paragraphs of one message.
            let text: Vec<&str> = content.iter().filter_map(|block| if let Block::Text { text } = block { Some(text.as_str()) } else { None }).collect();
            let mut command =
                json!({"type": "prompt", "message": text.join("\n\n"), "streamingBehavior": if deliver == Deliver::Steer { "steer" } else { "followUp" }});
            if !images.is_empty() {
                command["images"] = json!(images);
            }
            self.0.command(&process, command).await.map(|_| ())
        })
    }
    fn interrupt(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            if let Some(process) = self.0.current() {
                let _ = self.0.command(&process, json!({"type": "abort"})).await;
            }
        })
    }
    fn jobs(&self) -> BoxFut<'_, Vec<KernelJob>> {
        Box::pin(async move {
            let Ok(Value::Array(jobs)) = self.0.shim(json!({"op": "jobs"})).await else { return Vec::new() };
            jobs.iter()
                .filter_map(|job| {
                    Some(KernelJob {
                        id: job["id"].as_str()?.to_string(),
                        kind: match job["type"].as_str() {
                            Some("bash") => JobKind::Bash,
                            Some("task") => JobKind::Task,
                            _ => JobKind::Eval,
                        },
                        label: job["label"].as_str().unwrap_or("").to_string(),
                        start_time: job["startTime"].as_i64().unwrap_or(0),
                        progress: job["progressText"].as_str().map(str::to_string),
                        command: job["command"].as_str().map(str::to_string),
                        own: job["ownerId"].as_str().is_none_or(|owner| owner.is_empty() || owner == MAIN_AGENT),
                        pids: job["pids"].as_array().map(|pids| pids.iter().filter_map(|pid| pid.as_u64().map(|pid| pid as u32)).collect()).unwrap_or_default(),
                    })
                })
                .collect()
        })
    }
    fn acknowledge<'a>(&'a self, ids: &'a [String]) -> BoxFut<'a, ()> {
        Box::pin(async move {
            if !ids.is_empty() {
                let _ = self.0.shim(json!({"op": "ack", "ids": ids})).await;
            }
        })
    }
    fn cancel<'a>(&'a self, id: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async move { self.0.shim(json!({"op": "cancel", "job": id})).await.is_ok_and(|cancelled| cancelled == true) })
    }
    fn set_model<'a>(&'a self, model: Option<&'a str>, thinking: Option<&'a str>) -> BoxFut<'a, ()> {
        Box::pin(async move {
            {
                let mut shared = lock(&self.0.shared);
                shared.model = model.map(str::to_string);
                shared.thinking = thinking.map(str::to_string);
            }
            let Some(process) = self.0.current() else { return };
            if let Some((provider, id)) = model.and_then(|model| model.split_once('/')) {
                let _ = self.0.command(&process, json!({"type": "set_model", "provider": provider, "modelId": id})).await;
            }
            if let Some(level) = thinking {
                let _ = self.0.command(&process, json!({"type": "set_thinking_level", "level": level})).await;
            }
        })
    }
    fn pid(&self) -> Option<u32> {
        lock(&self.0.shared).process.as_ref().map(|process| process.pid())
    }
    fn close(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            let process = {
                let mut shared = lock(&self.0.shared);
                shared.closed = true;
                shared.generation += 1;
                shared.awaiting_async = false;
                if let Some(ready) = shared.ready.take() {
                    let _ = ready.send(Err("The session is closed".into()));
                }
                let waiting: Vec<_> = shared.commands.drain().map(|(_, answer)| answer).collect();
                for answer in waiting.into_iter().chain(std::mem::take(&mut shared.shim).into_values()) {
                    let _ = answer.send(Err("The session is closed".into()));
                }
                shared.process.take()
            };
            if let Some(process) = process {
                process.close(Duration::from_secs(3)).await;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::text_of;

    #[test]
    fn builds_the_command_line_for_a_worker_and_for_a_session_that_keeps_no_context() {
        let mut options = OmpOptions {
            program: "omp".into(),
            shim: "/app/shim/neo-omp-shim.ts".into(),
            cwd: "/work/t1".into(),
            agent_dir: "/data/omp".into(),
            session_dir: Some("/data/sessions".into()),
            system_prompt_file: "/data/prompts/worker.md".into(),
            builtin_tools: vec!["read".into(), "bash".into(), "task".into()],
            model: Some("fixture/big".into()),
            thinking: Some("high".into()),
            config: vec!["/data/overlays/worker.yml".into()],
            context_files: true,
            ..Default::default()
        };
        let worker = launch(&options, Some("/data/sessions/a.jsonl"));
        assert_eq!(
            worker.args.join(" "),
            "--mode rpc --no-extensions --no-skills --no-rules --no-lsp --no-title --approval-mode yolo --extension /app/shim/neo-omp-shim.ts \
             --system-prompt /data/prompts/worker.md --tools read,bash,task --cwd /work/t1 --session-dir /data/sessions --resume /data/sessions/a.jsonl \
             --model fixture/big --thinking high --config /data/overlays/worker.yml"
        );
        assert_eq!(worker.env.get("PI_CODING_AGENT_DIR").map(String::as_str), Some("/data/omp"));
        assert!(!worker.args.contains(&"--no-ui".to_string()), "the shim answers over UI frames");
        options.session_dir = None;
        options.context_files = false;
        options.model = None;
        options.thinking = None;
        options.config.clear();
        options.prompt_cache_key = Some("sidecar-1".into());
        let once = launch(&options, Some("ignored")).args.join(" ");
        assert!(once.ends_with("--cwd /work/t1 --no-context-files --no-session --prompt-cache-key sidecar-1"), "{once}");
        assert!(!once.contains("--resume") && !once.contains("--model"));
    }

    #[test]
    fn keeps_what_the_model_and_tools_said_and_drops_the_rest() {
        let said = message_of(&json!({"role": "assistant", "stopReason": "toolUse", "content": [
            {"type": "thinking", "thinking": "hm"}, {"type": "text", "text": "Reading"}, {"type": "toolCall", "id": "c1", "name": "read", "arguments": {"path": "a"}}]}))
        .unwrap();
        assert_eq!(said.role, Role::Assistant);
        assert_eq!(said.content, vec![Block::text("Reading"), Block::ToolCall { id: "c1".into(), name: "read".into(), arguments: json!({"path": "a"}) }]);
        assert_eq!(said.stop_reason.as_deref(), Some("toolUse"));
        let failed = message_of(&json!({"role": "assistant", "stopReason": "error", "errorMessage": "401 unauthorized", "content": []})).unwrap();
        assert_eq!((text_of(&failed.content), failed.stop_reason.as_deref()), ("401 unauthorized".to_string(), Some("error")));
        assert!(message_of(&json!({"role": "assistant", "stopReason": "stop", "content": [{"type": "thinking", "thinking": "only"}]})).is_none());
        let result = message_of(&json!({"role": "toolResult", "content": [{"type": "text", "text": "界".repeat(3000)}]})).unwrap();
        assert_eq!((result.role, text_of(&result.content).chars().count()), (Role::ToolResult, 2000));
        assert!(message_of(&json!({"role": "custom", "content": "notice"})).is_none());
        assert!(message_of(&json!({"role": "user", "content": [{"type": "text", "text": "hi"}]})).is_none());
    }
}
