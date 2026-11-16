//! The Claude Code kernel: one `claude` process per Session, driven over its stream-json input and output and the
//! control protocol that carries the host's tools (as an in-process MCP server) and its tool-call guard (as a
//! PreToolUse hook).

use crate::process::{Launch, Line, Proc};
use crate::session::{Driver, DriverEvent};
use crate::types::{uuid, Block, BoxFut, Deliver, Guard, JobKind, KernelJob, Message, Role, ToolHost};
use neo_core::time::now_ms;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// The name of the MCP server that carries the host's tools.
pub const MCP_SERVER: &str = "neo";

/// The name Claude Code gives a host tool.
pub fn mcp_tool_name(name: &str) -> String {
    format!("mcp__{MCP_SERVER}__{name}")
}

/// Prompts name host tools bare; Claude Code prefixes MCP tools, so whole-word mentions are rewritten.
pub fn rewrite_tool_names(text: &str, names: &[String]) -> String {
    rename_tools(text, names, mcp_tool_name)
}

/// Rewrite whole-word mentions of host tools in a prompt to the names a runtime gives them.
pub fn rename_tools(text: &str, names: &[String], rename: impl Fn(&str) -> String) -> String {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut names: Vec<&String> = names.iter().filter(|name| !name.is_empty()).collect();
    names.sort_by_key(|name| std::cmp::Reverse(name.len()));
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut before: Option<char> = None;
    'scan: while let Some(c) = rest.chars().next() {
        let boundary = before.is_none_or(|b| !(word(b) || b == ':' || b == '-'));
        if boundary {
            for name in &names {
                if rest.starts_with(name.as_str()) && rest[name.len()..].chars().next().is_none_or(|next| !(word(next) || next == '-')) {
                    out.push_str(&rename(name));
                    before = name.chars().last();
                    rest = &rest[name.len()..];
                    continue 'scan;
                }
            }
        }
        out.push(c);
        before = Some(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// A thinking level as Claude Code's effort: `None` for the model's default, `off` to disable thinking.
pub fn effort_of(level: Option<&str>) -> Option<&'static str> {
    match level? {
        "off" => Some("off"),
        "minimal" | "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

/// Variables of an enclosing interactive Claude Code session; a kernel process must not inherit them.
pub const SESSION_VARIABLES: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
];

/// Gateway and model variables from the user's Claude Code settings file, for a service started outside a Claude
/// Code shell: only `ANTHROPIC_*` and `CLAUDE_CODE_*` string values. The settings themselves are not loaded, so no
/// user hooks, plugins or memory reach a Session.
pub fn user_environment(settings_file: &std::path::Path) -> BTreeMap<String, String> {
    let Ok(text) = std::fs::read_to_string(settings_file) else { return BTreeMap::new() };
    let Ok(settings) = serde_json::from_str::<Value>(&text) else { return BTreeMap::new() };
    settings["env"]
        .as_object()
        .map(|env| {
            env.iter()
                .filter(|(name, _)| name.starts_with("ANTHROPIC_") || name.starts_with("CLAUDE_CODE_"))
                .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// A subagent the model may start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subagent {
    /// When to use it, for the model.
    pub description: String,
    /// Its system prompt.
    pub prompt: String,
    /// The built-in tools it may use.
    pub tools: Vec<String>,
}

/// How a Claude Code Session runs.
#[derive(Clone, Default)]
pub struct ClaudeOptions {
    /// The `claude` executable.
    pub program: PathBuf,
    /// The Session's working directory.
    pub cwd: PathBuf,
    /// The whole system prompt.
    pub system_prompt: String,
    /// The built-in tools the model may use, such as `Read` and `Bash`.
    pub builtin_tools: Vec<String>,
    /// The model, or the runtime's default.
    pub model: Option<String>,
    /// The thinking level, as in settings.
    pub thinking: Option<String>,
    /// Subagents by name.
    pub agents: BTreeMap<String, Subagent>,
    /// Load the project's own Claude Code settings and memory; for workers only.
    pub project_settings: bool,
    /// Variables to set for the runtime.
    pub env: BTreeMap<String, String>,
    /// The most turns one run may take.
    pub max_turns: Option<u32>,
    /// Keep the runtime's own session on disk, so a later process resumes it.
    pub persist: bool,
}

/// The command line and environment of a Claude Code process.
pub fn launch(options: &ClaudeOptions, resume: Option<&str>, session_id: &str) -> Launch {
    let mut args: Vec<String> =
        ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages"].map(String::from).to_vec();
    fn flag(args: &mut Vec<String>, name: &str, value: &str) {
        args.extend([name.to_string(), value.to_string()]);
    }
    flag(&mut args, "--setting-sources", if options.project_settings { "project" } else { "" });
    flag(&mut args, "--permission-mode", "bypassPermissions");
    flag(&mut args, "--tools", &options.builtin_tools.join(","));
    if let Some(model) = options.model.as_deref().filter(|model| !model.is_empty()) {
        flag(&mut args, "--model", model);
    }
    match effort_of(options.thinking.as_deref()) {
        Some("off") => args.push("--thinking=disabled".into()),
        Some(effort) => flag(&mut args, "--effort", effort),
        None => {}
    }
    if let Some(turns) = options.max_turns {
        flag(&mut args, "--max-turns", &turns.to_string());
    }
    match resume {
        Some(id) => flag(&mut args, "--resume", id),
        None => flag(&mut args, "--session-id", session_id),
    }
    args.extend(["--strict-mcp-config", "--dangerously-skip-permissions"].map(String::from));
    if !options.persist {
        args.push("--no-session-persistence".into());
    }
    let mut env = options.env.clone();
    env.insert("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS".into(), "1".into());
    Launch {
        program: options.program.clone(),
        args,
        cwd: options.cwd.clone(),
        env,
        env_remove: SESSION_VARIABLES.iter().map(|name| name.to_string()).collect(),
    }
}

/// The `initialize` control request: the system prompt, subagents, the guard hook and the host's tool server.
fn initialize(options: &ClaudeOptions, has_tools: bool) -> Value {
    let mut request = json!({
        "subtype": "initialize",
        "systemPrompt": [options.system_prompt],
        "hooks": {"PreToolUse": [{"matcher": null, "hookCallbackIds": ["guard"]}]},
    });
    if has_tools {
        request["sdkMcpServers"] = json!([MCP_SERVER]);
    }
    if !options.agents.is_empty() {
        request["agents"] = options
            .agents
            .iter()
            .map(|(name, agent)| (name.clone(), json!({"description": agent.description, "prompt": agent.prompt, "tools": agent.tools})))
            .collect::<Map<String, Value>>()
            .into();
    }
    request
}

/// Kernel content as an Anthropic user message's content.
fn user_content(content: &[Block]) -> Value {
    if let [Block::Text { text }] = content {
        return json!(text);
    }
    content
        .iter()
        .map(|block| match block {
            Block::Text { text } => json!({"type": "text", "text": text}),
            Block::Image { mime_type, data } => json!({"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": data}}),
            Block::ToolCall { name, .. } => json!({"type": "text", "text": format!("[tool call {name}]")}),
        })
        .collect()
}

struct Task {
    kind: JobKind,
    label: String,
    start_time: i64,
    progress: Option<String>,
    ambient: bool,
    nested: bool,
}

#[derive(Default)]
struct Shared {
    process: Option<Arc<Proc>>,
    /// Grows with every process, so a late line from one that ended is ignored.
    generation: u64,
    requests: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    tasks: BTreeMap<String, Task>,
    acknowledged: Vec<String>,
    /// Finished jobs since the last turn began: a wake caused only by acknowledged ones is cancelled.
    woke_acknowledged: usize,
    woke_real: usize,
    running: bool,
    /// The runtime works on a wake the host cancelled; what it says meanwhile is dropped.
    suppressing: bool,
    model: Option<String>,
    thinking: Option<String>,
}

/// One Claude Code Session's runtime.
pub struct ClaudeDriver {
    options: ClaudeOptions,
    host: Arc<dyn ToolHost>,
    events: mpsc::UnboundedSender<DriverEvent>,
    shared: Arc<Mutex<Shared>>,
    starting: tokio::sync::Mutex<()>,
}

fn lock(shared: &Mutex<Shared>) -> std::sync::MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl ClaudeDriver {
    /// A driver that reports to `events` and serves the model's tool calls from `host`.
    pub fn new(options: ClaudeOptions, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Arc<ClaudeDriver> {
        let shared = Shared { model: options.model.clone(), thinking: options.thinking.clone(), ..Default::default() };
        Arc::new(ClaudeDriver { options, host, events, shared: Arc::new(Mutex::new(shared)), starting: tokio::sync::Mutex::new(()) })
    }

    /// The running process, starting one that resumes `resume` when none runs.
    async fn process(self: &Arc<Self>, resume: Option<String>) -> Result<Arc<Proc>, String> {
        let _one = self.starting.lock().await;
        if let Some(process) = lock(&self.shared).process.clone() {
            return Ok(process);
        }
        let session_id = uuid();
        let mut options = self.options.clone();
        {
            let shared = lock(&self.shared);
            options.model = shared.model.clone();
            options.thinking = shared.thinking.clone();
        }
        let (process, lines) = Proc::spawn(&launch(&options, resume.as_deref(), &session_id))?;
        let generation = {
            let mut shared = lock(&self.shared);
            shared.generation += 1;
            shared.process = Some(process.clone());
            shared.generation
        };
        let _ = self.events.send(DriverEvent::SessionId(resume.unwrap_or(session_id)));
        tokio::spawn(self.clone().read(lines, generation));
        let request = initialize(&self.options, !self.host.specs().is_empty());
        match tokio::time::timeout(Duration::from_secs(60), self.control(&process, request)).await {
            Ok(Ok(_)) => Ok(process),
            Ok(Err(error)) => Err(format!("Claude Code refused to start: {error}")),
            Err(_) => Err("Claude Code did not answer within 60 seconds".into()),
        }
    }

    /// Send a control request and wait for its answer.
    async fn control(&self, process: &Proc, request: Value) -> Result<Value, String> {
        let id = format!("req_{}", uuid());
        let (answer, answered) = oneshot::channel();
        lock(&self.shared).requests.insert(id.clone(), answer);
        if let Err(error) = process.send(&json!({"type": "control_request", "request_id": id, "request": request})).await {
            lock(&self.shared).requests.remove(&id);
            return Err(error);
        }
        answered.await.unwrap_or_else(|_| Err("Claude Code ended before answering".into()))
    }

    async fn read(self: Arc<Self>, mut lines: mpsc::UnboundedReceiver<Line>, generation: u64) {
        while let Some(line) = lines.recv().await {
            if lock(&self.shared).generation != generation {
                return;
            }
            match line {
                Line::Json(value) => self.handle(value).await,
                Line::Exited(error) => {
                    let awaited = {
                        let mut shared = lock(&self.shared);
                        let awaited = shared.tasks.values().any(|task| !task.ambient);
                        shared.process = None;
                        shared.tasks.clear();
                        shared.acknowledged.clear();
                        shared.running = false;
                        shared.suppressing = false;
                        for (_, answer) in shared.requests.drain() {
                            let _ = answer.send(Err("Claude Code ended before answering".into()));
                        }
                        awaited
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

    async fn handle(self: &Arc<Self>, line: Value) {
        match line["type"].as_str().unwrap_or("") {
            "control_response" => {
                let response = &line["response"];
                let Some(answer) = response["request_id"].as_str().and_then(|id| lock(&self.shared).requests.remove(id)) else { return };
                let _ = answer.send(if response["subtype"] == "success" {
                    Ok(response["response"].clone())
                } else {
                    Err(response["error"].as_str().unwrap_or("the request failed").to_string())
                });
            }
            "control_request" => {
                // Answered off the reading task, so a slow tool does not hold up the stream.
                let driver = self.clone();
                tokio::spawn(async move { driver.serve(line).await });
            }
            "assistant" => {
                if !line["parent_tool_use_id"].is_null() || lock(&self.shared).suppressing {
                    return;
                }
                let blocks = line["message"]["content"].as_array().cloned().unwrap_or_default();
                let content: Vec<Block> = blocks
                    .iter()
                    .filter_map(|block| match block["type"].as_str()? {
                        "text" => Some(Block::text(block["text"].as_str()?)),
                        "tool_use" => {
                            Some(Block::ToolCall { id: block["id"].as_str()?.into(), name: block["name"].as_str()?.into(), arguments: block["input"].clone() })
                        }
                        _ => None,
                    })
                    .collect();
                if content.is_empty() {
                    return;
                }
                let stop = if content.iter().any(|block| matches!(block, Block::ToolCall { .. })) {
                    "toolUse"
                } else if line["message"]["stop_reason"] == "max_tokens" {
                    "length"
                } else {
                    "stop"
                };
                self.emit(DriverEvent::Message(Message { role: Role::Assistant, content, stop_reason: Some(stop.into()) }));
            }
            "user" => {
                let content = &line["message"]["content"];
                let results: Vec<&Value> =
                    content.as_array().map(|blocks| blocks.iter().filter(|block| block["type"] == "tool_result").collect()).unwrap_or_default();
                if line["isReplay"] == true {
                    // Claude Code took a submitted message into a turn.
                    if results.is_empty() {
                        self.emit(DriverEvent::Taken(line["uuid"].as_str().unwrap_or("").to_string()));
                    }
                    return;
                }
                if !line["parent_tool_use_id"].is_null() || lock(&self.shared).suppressing || results.is_empty() {
                    return;
                }
                let content = results
                    .iter()
                    .map(|block| {
                        let text = block["content"].as_str().map(str::to_string).unwrap_or_else(|| block["content"].to_string());
                        Block::text(text.chars().take(2000).collect::<String>())
                    })
                    .collect();
                self.emit(DriverEvent::Message(Message { role: Role::ToolResult, content, stop_reason: None }));
            }
            "result" => {
                if lock(&self.shared).suppressing || line["is_error"] != true {
                    return;
                }
                let errors = line["errors"]
                    .as_array()
                    .map(|errors| errors.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; "))
                    .filter(|text| !text.is_empty());
                let text = errors
                    .or_else(|| line["result"].as_str().filter(|text| !text.is_empty()).map(str::to_string))
                    .unwrap_or_else(|| line["subtype"].as_str().unwrap_or("error").to_string());
                self.emit(DriverEvent::Message(Message { role: Role::Assistant, content: vec![Block::text(text)], stop_reason: Some("error".into()) }));
            }
            "system" => self.system(&line).await,
            _ => {}
        }
    }

    async fn system(&self, line: &Value) {
        match line["subtype"].as_str().unwrap_or("") {
            "init" => {
                if let Some(id) = line["session_id"].as_str() {
                    self.emit(DriverEvent::SessionId(id.to_string()));
                }
            }
            "api_retry" => self.emit(DriverEvent::Retry),
            "session_state_changed" => match line["state"].as_str().unwrap_or("") {
                "running" => {
                    let cancel = {
                        let mut shared = lock(&self.shared);
                        if shared.running {
                            return;
                        }
                        // Jobs the host let finish quietly woke the runtime: cancel that turn instead of reporting it.
                        let cancel = shared.woke_acknowledged > 0 && shared.woke_real == 0;
                        shared.suppressing = cancel;
                        shared.running = !cancel;
                        (shared.woke_acknowledged, shared.woke_real) = (0, 0);
                        cancel.then(|| shared.process.clone()).flatten()
                    };
                    match cancel {
                        Some(process) => {
                            let _ = process
                                .send(&json!({"type": "control_request", "request_id": format!("req_{}", uuid()), "request": {"subtype": "interrupt"}}))
                                .await;
                        }
                        None => self.emit(DriverEvent::Running),
                    }
                }
                "idle" => {
                    let awaiting = {
                        let mut shared = lock(&self.shared);
                        if std::mem::take(&mut shared.suppressing) {
                            return;
                        }
                        shared.running = false;
                        shared.tasks.values().any(|task| !task.ambient)
                    };
                    self.emit(DriverEvent::Idle { awaiting_async: awaiting });
                }
                _ => {}
            },
            "background_tasks_changed" => {
                let listed = line["tasks"].as_array().cloned().unwrap_or_default();
                let mut shared = lock(&self.shared);
                let live: Vec<&str> = listed.iter().filter_map(|task| task["task_id"].as_str()).collect();
                shared.tasks.retain(|id, _| live.contains(&id.as_str()));
                shared.acknowledged.retain(|id| live.contains(&id.as_str()));
                for task in &listed {
                    let Some(id) = task["task_id"].as_str() else { continue };
                    let known = shared.tasks.remove(id);
                    let kind = match task["task_type"].as_str() {
                        Some("local_bash") => JobKind::Bash,
                        Some("local_agent") => JobKind::Task,
                        _ => JobKind::Eval,
                    };
                    shared.tasks.insert(
                        id.to_string(),
                        Task {
                            kind,
                            label: task["description"].as_str().unwrap_or("").to_string(),
                            start_time: known.as_ref().map(|task| task.start_time).unwrap_or_else(now_ms),
                            progress: known.and_then(|task| task.progress),
                            ambient: task["ambient"] == true,
                            nested: task["parent_task_id"].is_string(),
                        },
                    );
                }
            }
            "task_progress" | "task_updated" => {
                let text = line["summary"].as_str().or(line["description"].as_str()).filter(|text| !text.is_empty());
                if let (Some(id), Some(text)) = (line["task_id"].as_str(), text) {
                    if let Some(task) = lock(&self.shared).tasks.get_mut(id) {
                        task.progress = Some(text.to_string());
                    }
                }
            }
            "task_notification" => {
                let mut shared = lock(&self.shared);
                if shared.running {
                    return;
                }
                let acknowledged = line["task_id"].as_str().is_some_and(|id| shared.acknowledged.iter().any(|known| known == id));
                if acknowledged {
                    shared.woke_acknowledged += 1;
                } else {
                    shared.woke_real += 1;
                }
            }
            _ => {}
        }
    }

    /// Answer a control request of the runtime: the guard hook, or a message for the host's tool server.
    async fn serve(&self, line: Value) {
        let (Some(id), request) = (line["request_id"].as_str(), &line["request"]) else { return };
        let response = match request["subtype"].as_str().unwrap_or("") {
            "hook_callback" => {
                let input = &request["input"];
                let tool = input["tool_name"].as_str().unwrap_or("");
                // The host judges its own tools by their bare names.
                let bare = tool.strip_prefix(&format!("mcp__{MCP_SERVER}__")).unwrap_or(tool);
                match self.host.guard(bare, &input["tool_input"]).await {
                    Guard::Allow => json!({}),
                    Guard::Block(reason) => {
                        json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}})
                    }
                }
            }
            "mcp_message" => json!({"mcp_response": self.mcp(&request["message"]).await}),
            _ => json!({}),
        };
        let Some(process) = lock(&self.shared).process.clone() else { return };
        let _ = process.send(&json!({"type": "control_response", "response": {"subtype": "success", "request_id": id, "response": response}})).await;
    }

    /// The host's tools as an MCP server: `initialize`, `tools/list` and `tools/call`.
    async fn mcp(&self, message: &Value) -> Value {
        let id = message.get("id").cloned().unwrap_or(json!(0));
        let result = match message["method"].as_str().unwrap_or("") {
            "initialize" => json!({
                "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": MCP_SERVER, "version": env!("CARGO_PKG_VERSION")},
            }),
            "tools/list" => {
                json!({"tools": self.host.specs().iter().map(|spec| json!({"name": spec.name, "description": spec.description, "inputSchema": spec.schema})).collect::<Vec<_>>()})
            }
            "tools/call" => {
                let name = message["params"]["name"].as_str().unwrap_or("");
                let arguments = message["params"].get("arguments").cloned().unwrap_or_else(|| json!({}));
                match self.host.call(name, arguments).await {
                    Ok(value) => json!({"content": [{"type": "text", "text": value.to_string()}]}),
                    Err(error) => json!({"isError": true, "content": [{"type": "text", "text": error}]}),
                }
            }
            _ => json!({}),
        };
        json!({"jsonrpc": "2.0", "id": id, "result": result})
    }

    fn current(&self) -> Option<Arc<Proc>> {
        lock(&self.shared).process.clone()
    }
}

/// Lets the driver be used through `Arc<dyn Driver>` while its methods need the `Arc` to spawn tasks.
pub struct Claude(pub Arc<ClaudeDriver>);

impl Driver for Claude {
    fn kernel(&self) -> &'static str {
        "claude"
    }
    fn submit<'a>(&'a self, id: &'a str, content: &'a [Block], deliver: Deliver, resume: Option<String>) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            let process = self.0.process(resume).await?;
            let mut message = json!({"type": "user", "uuid": id, "message": {"role": "user", "content": user_content(content)}, "parent_tool_use_id": null});
            // A steered message joins the running turn at its next tool boundary; a follow-up waits for the turn to end.
            if deliver == Deliver::FollowUp {
                message["priority"] = json!("later");
            }
            process.send(&message).await
        })
    }
    fn interrupt(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            if let Some(process) = self.0.current() {
                let _ = tokio::time::timeout(Duration::from_secs(10), self.0.control(&process, json!({"subtype": "interrupt"}))).await;
            }
        })
    }
    fn jobs(&self) -> BoxFut<'_, Vec<KernelJob>> {
        Box::pin(async move {
            lock(&self.0.shared)
                .tasks
                .iter()
                .filter(|(_, task)| !task.ambient)
                .map(|(id, task)| KernelJob {
                    id: id.clone(),
                    kind: task.kind,
                    label: task.label.clone(),
                    start_time: task.start_time,
                    progress: task.progress.clone(),
                    command: (task.kind == JobKind::Bash).then(|| task.label.clone()),
                    own: !task.nested,
                    pids: Vec::new(),
                })
                .collect()
        })
    }
    fn acknowledge<'a>(&'a self, ids: &'a [String]) -> BoxFut<'a, ()> {
        Box::pin(async move {
            let mut shared = lock(&self.0.shared);
            for id in ids {
                if !shared.acknowledged.contains(id) {
                    shared.acknowledged.push(id.clone());
                }
            }
        })
    }
    fn cancel<'a>(&'a self, id: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async move {
            let process = {
                let shared = lock(&self.0.shared);
                if !shared.tasks.contains_key(id) {
                    return false;
                }
                shared.process.clone()
            };
            let Some(process) = process else { return false };
            let _ = tokio::time::timeout(Duration::from_secs(10), self.0.control(&process, json!({"subtype": "stop_task", "task_id": id}))).await;
            true
        })
    }
    fn set_model<'a>(&'a self, model: Option<&'a str>, thinking: Option<&'a str>) -> BoxFut<'a, ()> {
        Box::pin(async move {
            {
                let mut shared = lock(&self.0.shared);
                shared.model = model.map(str::to_string);
                shared.thinking = thinking.map(str::to_string);
            }
            let Some(process) = self.0.current() else { return };
            let wait = Duration::from_secs(10);
            if let Some(model) = model {
                let _ = tokio::time::timeout(wait, self.0.control(&process, json!({"subtype": "set_model", "model": model}))).await;
            }
            if let Some(effort) = effort_of(thinking).filter(|effort| *effort != "off") {
                let _ =
                    tokio::time::timeout(wait, self.0.control(&process, json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": effort}}))).await;
            }
        })
    }
    fn pid(&self) -> Option<u32> {
        self.0.current().map(|process| process.pid())
    }
    fn close(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            let process = {
                let mut shared = lock(&self.0.shared);
                // Lines of the closed process are ignored from here on.
                shared.generation += 1;
                shared.tasks.clear();
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

    #[test]
    fn rewrites_whole_word_mentions_of_host_tools() {
        let names = vec!["orchestrator_read".to_string(), "orchestrator_report".to_string(), "orchestrator_re".to_string()];
        assert_eq!(
            rewrite_tool_names("Call orchestrator_report, then `orchestrator_read`. Not my_orchestrator_read, orchestrator_reads or x:orchestrator_read; orchestrator_re!", &names),
            "Call mcp__neo__orchestrator_report, then `mcp__neo__orchestrator_read`. Not my_orchestrator_read, orchestrator_reads or x:orchestrator_read; mcp__neo__orchestrator_re!"
        );
        assert_eq!(rewrite_tool_names("先调用 orchestrator_read。", &names), "先调用 mcp__neo__orchestrator_read。");
        assert_eq!(rewrite_tool_names("mcp__neo__orchestrator_read stays", &names), "mcp__neo__orchestrator_read stays");
        assert_eq!(rewrite_tool_names("nothing", &[]), "nothing");
    }

    #[test]
    fn maps_thinking_levels_to_efforts() {
        assert_eq!(effort_of(None), None);
        assert_eq!(effort_of(Some("auto")), None);
        assert_eq!(effort_of(Some("off")), Some("off"));
        assert_eq!(effort_of(Some("minimal")), Some("low"));
        assert_eq!(effort_of(Some("xhigh")), Some("xhigh"));
    }

    #[test]
    fn builds_the_command_line_for_a_new_and_a_resumed_session() {
        let mut options = ClaudeOptions {
            program: "claude".into(),
            cwd: "/work".into(),
            builtin_tools: vec!["Read".into(), "Bash".into()],
            persist: true,
            ..Default::default()
        };
        let fresh = launch(&options, None, "sid-1");
        let joined = fresh.args.join(" ");
        assert!(joined.starts_with("--print --input-format stream-json --output-format stream-json --verbose --replay-user-messages --setting-sources  --permission-mode bypassPermissions --tools Read,Bash --session-id sid-1"), "{joined}");
        assert!(joined.ends_with("--strict-mcp-config --dangerously-skip-permissions"));
        assert!(!joined.contains("--model") && !joined.contains("--effort") && !joined.contains("--resume"));
        assert_eq!(fresh.env.get("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS").map(String::as_str), Some("1"));
        assert!(fresh.env_remove.iter().any(|name| name == "CLAUDECODE"));
        options.model = Some("sonnet".into());
        options.thinking = Some("high".into());
        options.project_settings = true;
        options.max_turns = Some(8);
        options.persist = false;
        options.env.insert("BASH_DEFAULT_TIMEOUT_MS".into(), "60000".into());
        let resumed = launch(&options, Some("sid-0"), "unused").args.join(" ");
        assert!(resumed.contains("--setting-sources project") && resumed.contains("--model sonnet --effort high --max-turns 8 --resume sid-0"), "{resumed}");
        assert!(resumed.ends_with("--no-session-persistence") && !resumed.contains("--session-id"));
        options.thinking = Some("off".into());
        assert!(launch(&options, None, "s").args.contains(&"--thinking=disabled".to_string()));
    }

    #[test]
    fn describes_the_session_in_the_initialize_request() {
        let mut options = ClaudeOptions { system_prompt: "You route work.".into(), ..Default::default() };
        let plain = initialize(&options, false);
        assert_eq!(plain["systemPrompt"], json!(["You route work."]));
        assert_eq!(plain["hooks"]["PreToolUse"][0]["hookCallbackIds"], json!(["guard"]));
        assert!(plain.get("sdkMcpServers").is_none() && plain.get("agents").is_none());
        options.agents.insert("ticket-task".into(), Subagent { description: "Helper".into(), prompt: "Help.".into(), tools: vec!["Read".into()] });
        let full = initialize(&options, true);
        assert_eq!(full["sdkMcpServers"], json!(["neo"]));
        assert_eq!(full["agents"]["ticket-task"], json!({"description": "Helper", "prompt": "Help.", "tools": ["Read"]}));
    }

    #[test]
    fn sends_text_as_a_string_and_images_as_base64_sources() {
        assert_eq!(user_content(&[Block::text("hi")]), json!("hi"));
        assert_eq!(
            user_content(&[Block::text("see"), Block::Image { mime_type: "image/png".into(), data: "AAAA".into() }]),
            json!([{"type": "text", "text": "see"}, {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}])
        );
    }
}
