//! The Antigravity kernel: one `agy acp` process per Session, driven over the Agent Client Protocol (JSON-RPC 2.0 on
//! its standard input and output).
//!
//! The host's tools reach the model through an MCP server on the loopback interface, which answers only the bearer
//! token this driver hands its runtime; the tool-call guard answers the runtime's permission requests for its own
//! tools and judges every call of the host's tools before it runs. The runtime keeps its conversations itself, and
//! `session/resume` continues one in a new process without replaying it.

use crate::process::{Launch, Line, Proc};
use crate::session::{Driver, DriverEvent};
use crate::types::{uuid, Block, BoxFut, Deliver, Guard, KernelJob, Message, Role, ToolHost, ToolSpec};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};

/// The name of the MCP server that carries the host's tools.
pub const MCP_SERVER: &str = "neo";

/// The name Antigravity gives a host tool.
pub fn mcp_tool_name(name: &str) -> String {
    format!("mcp_{MCP_SERVER}_{name}")
}

/// A thinking level as Antigravity's `thought_level`: `None` keeps the model's own level.
pub fn thought_level(level: Option<&str>) -> Option<&'static str> {
    match level? {
        "off" | "minimal" | "low" => Some("low"),
        "medium" => Some("medium"),
        "high" | "xhigh" | "max" => Some("high"),
        _ => None,
    }
}

/// The kinds of built-in tool a Session may be allowed, in the host's words.
pub const TOOL_KINDS: &[&str] = &["read", "bash", "edit", "write", "task"];

/// How an Antigravity Session runs.
#[derive(Clone, Default)]
pub struct AntigravityOptions {
    /// The `agy` executable.
    pub program: PathBuf,
    /// The Session's working directory.
    pub cwd: PathBuf,
    /// What the Session adds to the runtime's own system prompt.
    pub system_prompt: String,
    /// The built-in tool kinds the model may use: of [`TOOL_KINDS`]. Tools of no kind, such as fetching a web page,
    /// are allowed only to a Session that may use `bash`.
    pub tools: Vec<String>,
    /// The model, or the runtime's default.
    pub model: Option<String>,
    /// The thinking level, as in settings.
    pub thinking: Option<String>,
    /// Variables to set for the runtime.
    pub env: BTreeMap<String, String>,
}

/// The command line and environment of an Antigravity process.
pub fn launch(options: &AntigravityOptions) -> Launch {
    Launch {
        program: options.program.clone(),
        args: vec!["acp".into()],
        cwd: options.cwd.clone(),
        env: options.env.clone(),
        env_remove: crate::claude::SESSION_VARIABLES.iter().map(|name| name.to_string()).collect(),
    }
}

/// A runtime tool call in the host's words: the kind or host tool it is, and the input the guard judges. The ACP
/// `kind` the runtime reports decides first; the tool's name decides when the kind says nothing.
pub fn host_view(tool: &str, kind: Option<&str>, input: &Value) -> (String, Value) {
    let path = || {
        let path = ["Path", "TargetFile", "AbsolutePath"].iter().find_map(|field| input[*field].as_str()).unwrap_or("");
        json!({ "path": path })
    };
    if let Some(bare) = tool.strip_prefix(&format!("mcp_{MCP_SERVER}_")) {
        return (bare.to_string(), input.clone());
    }
    match (tool, kind.unwrap_or("")) {
        ("run_command", _) => ("bash".into(), json!({"command": input["CommandLine"].as_str().unwrap_or("")})),
        ("send_command_input", _) => ("bash".into(), json!({"command": input["Input"].as_str().unwrap_or("")})),
        ("write_file" | "write_to_file", _) => ("write".into(), path()),
        ("invoke_subagent" | "define_subagent" | "manage_subagents" | "browser_subagent", _) => ("task".into(), input.clone()),
        (_, "execute") => ("bash".into(), json!({"command": input["CommandLine"].as_str().or(input["command"].as_str()).unwrap_or("")})),
        (_, "edit" | "delete" | "move") => ("edit".into(), path()),
        (_, "read" | "search") => ("read".into(), input.clone()),
        ("edit_file" | "replace_file_content" | "multi_replace_file_content" | "sed_file" | "notebook_edit", _) => ("edit".into(), path()),
        ("read_file" | "view_file" | "list_dir" | "grep_search" | "find_by_name", _) => ("read".into(), input.clone()),
        _ => (tool.to_string(), input.clone()),
    }
}

/// Arguments Antigravity adds to every MCP tool call for its own display; a tool that does not declare one never sees it.
const INJECTED_ARGUMENTS: &[&str] = &["toolSummary", "explanation", "toolAction", "waitForPreviousTools"];

fn strip_injected(spec: Option<&ToolSpec>, mut arguments: Value) -> Value {
    if let Some(fields) = arguments.as_object_mut() {
        let declared = |name: &str| spec.is_some_and(|spec| spec.schema["properties"].get(name).is_some());
        fields.retain(|name, _| !INJECTED_ARGUMENTS.contains(&name.as_str()) || declared(name));
    }
    arguments
}

/// Kernel content as ACP prompt content blocks.
fn prompt_content(content: &[Block]) -> Value {
    content
        .iter()
        .map(|block| match block {
            Block::Text { text } => json!({"type": "text", "text": text}),
            Block::Image { mime_type, data } => json!({"type": "image", "mimeType": mime_type, "data": data}),
            Block::ToolCall { name, .. } => json!({"type": "text", "text": format!("[tool call {name}]")}),
        })
        .collect()
}

/// Why a prompt ended, as a transcript stop reason.
fn stop_reason(reason: &str) -> &'static str {
    match reason {
        "max_tokens" | "max_turn_requests" => "length",
        "cancelled" => "aborted",
        "refusal" => "error",
        _ => "stop",
    }
}

/// The text a finished tool call reports.
fn tool_output(update: &Value) -> String {
    let content: Vec<&str> = update["content"]
        .as_array()
        .map(|blocks| blocks.iter().filter_map(|block| block["content"]["text"].as_str().or(block["text"].as_str())).collect())
        .unwrap_or_default();
    if !content.is_empty() {
        return content.join("\n");
    }
    match &update["rawOutput"] {
        Value::Null => update["status"].as_str().unwrap_or("").to_string(),
        Value::String(text) => text.clone(),
        output => output["output"].as_str().map(str::to_string).unwrap_or_else(|| output.to_string()),
    }
}

/// The models `agy models` lists: id and display name.
pub async fn list_models(program: &std::path::Path, env: &BTreeMap<String, String>) -> Result<Vec<(String, String)>, String> {
    let mut command = tokio::process::Command::new(program);
    command.arg("models").envs(env).stdin(std::process::Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .map_err(|_| "Antigravity did not list its models within 60 seconds".to_string())?
        .map_err(|error| format!("Cannot run {}: {error}", program.display()))?;
    if !output.status.success() {
        let why = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("Antigravity cannot list its models: {}", if why.is_empty() { output.status.to_string() } else { why }));
    }
    Ok(parse_models(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_models(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let (id, name) = line.split_once('\t')?;
            let id = id.trim();
            (!id.is_empty() && !id.contains(' ')).then(|| (id.to_string(), name.trim().to_string()))
        })
        .collect()
}

/// The host's tools as an MCP server on the loopback interface.
struct McpServer {
    url: String,
    token: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for McpServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The most notes of refused tool calls sent in a row, without a submission between them.
const MAX_NOTES: u32 = 3;

/// The largest request body the tool server reads.
const MCP_BODY_LIMIT: usize = 16 << 20;

async fn start_mcp(host: Arc<dyn ToolHost>, on_tool_call: Option<Arc<dyn Fn() + Send + Sync>>) -> Result<McpServer, String> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|error| format!("Cannot open the tool server: {error}"))?;
    let port = listener.local_addr().map_err(|error| format!("Cannot open the tool server: {error}"))?.port();
    let token = format!("{}{}", uuid().replace('-', ""), uuid().replace('-', ""));
    let expected = format!("Bearer {token}");
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve_connection(stream, host.clone(), expected.clone(), on_tool_call.clone()));
        }
    });
    Ok(McpServer { url: format!("http://127.0.0.1:{port}/mcp"), token, task })
}

async fn serve_connection(stream: TcpStream, host: Arc<dyn ToolHost>, expected: String, on_tool_call: Option<Arc<dyn Fn() + Send + Sync>>) {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    loop {
        let mut start = String::new();
        if reader.read_line(&mut start).await.unwrap_or(0) == 0 {
            return;
        }
        let mut parts = start.split_whitespace();
        let (method, http11) = (parts.next().unwrap_or("").to_string(), parts.nth(1).is_some_and(|version| version == "HTTP/1.1"));
        let (mut length, mut authorized, mut close) = (0usize, false, !http11);
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                return;
            }
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            let Some((name, value)) = line.split_once(':') else { continue };
            let value = value.trim();
            match name.trim().to_ascii_lowercase().as_str() {
                "content-length" => length = value.parse().unwrap_or(usize::MAX),
                "authorization" => authorized = value == expected,
                "connection" => close = value.eq_ignore_ascii_case("close"),
                "transfer-encoding" => length = usize::MAX,
                _ => {}
            }
        }
        if length > MCP_BODY_LIMIT {
            let _ = respond(&mut writer, 413, None).await;
            return;
        }
        let mut body = vec![0; length];
        if reader.read_exact(&mut body).await.is_err() {
            return;
        }
        let (status, answer) = if !authorized {
            (401, None)
        } else if method != "POST" {
            (405, None)
        } else {
            match serde_json::from_slice::<Value>(&body) {
                Ok(message) => match mcp_answer(host.as_ref(), &message, on_tool_call.as_deref()).await {
                    Some(answer) => (200, Some(answer)),
                    None => (202, None),
                },
                Err(_) => (400, None),
            }
        };
        if respond(&mut writer, status, answer.as_ref()).await.is_err() || close {
            return;
        }
    }
}

async fn respond(writer: &mut tokio::net::tcp::OwnedWriteHalf, status: u16, body: Option<&Value>) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        405 => "Method Not Allowed",
        _ => "Payload Too Large",
    };
    let body = body.map(|body| serde_json::to_vec(body).expect("JSON values serialize")).unwrap_or_default();
    let mut head = format!("HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\n", body.len());
    if !body.is_empty() {
        head.push_str("Content-Type: application/json\r\n");
    }
    head.push_str("\r\n");
    writer.write_all(head.as_bytes()).await?;
    writer.write_all(&body).await?;
    writer.flush().await
}

/// Answer one MCP message; `None` for a notification. The guard judges every tool call before it runs.
async fn mcp_answer(host: &dyn ToolHost, message: &Value, on_tool_call: Option<&(dyn Fn() + Send + Sync)>) -> Option<Value> {
    let id = message.get("id").filter(|id| !id.is_null())?.clone();
    let result = match message["method"].as_str().unwrap_or("") {
        "initialize" => json!({
            "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": MCP_SERVER, "version": env!("CARGO_PKG_VERSION")},
        }),
        "ping" => json!({}),
        "tools/list" => {
            json!({"tools": host.specs().iter().map(|spec| json!({"name": spec.name, "description": spec.description, "inputSchema": spec.schema})).collect::<Vec<_>>()})
        }
        "tools/call" => {
            if let Some(on_call) = on_tool_call {
                on_call();
                tokio::task::yield_now().await;
            }
            let name = message["params"]["name"].as_str().unwrap_or("");
            let specs = host.specs();
            let arguments =
                strip_injected(specs.iter().find(|spec| spec.name == name), message["params"].get("arguments").cloned().unwrap_or_else(|| json!({})));
            let outcome = match host.guard(name, &arguments).await {
                Guard::Block(reason) => Err(reason),
                Guard::Allow => host.call(name, arguments).await,
            };
            match outcome {
                Ok(value) => json!({"content": [{"type": "text", "text": value.to_string()}]}),
                Err(error) => json!({"isError": true, "content": [{"type": "text", "text": error}]}),
            }
        }
        method => return Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("Method not found: {method}")}})),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

#[derive(Default)]
struct Shared {
    process: Option<Arc<Proc>>,
    /// The runtime's id of the conversation the process serves.
    session_id: Option<String>,
    /// Grows with every process, so a late line or answer from one that ended is ignored.
    generation: u64,
    next_request: u64,
    requests: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
    /// Prompts sent whose answer has not come; the runtime is busy while there are any.
    in_flight: usize,
    /// Follow-ups waiting for the running turn to end: their submission id and content.
    queued: VecDeque<(String, Value)>,
    /// Prompts sent that the runtime has not confirmed taking into a step yet, oldest first: the request id and a
    /// submission's id, or `None` for a note of the driver's own.
    unechoed: VecDeque<(u64, Option<String>)>,
    /// Why the guard refused tool calls of the running turn. The runtime ends a turn on a refusal without telling
    /// the model why, so the reasons follow as a note of their own.
    refused: Vec<String>,
    /// Notes sent since the last submission, so a model that keeps trying is not told forever.
    notes: u32,
    /// The last update was part of a user message the runtime took.
    echoing: bool,
    /// What the model has said since its last message was recorded.
    text: String,
    /// Tool calls already recorded, and those whose result was.
    calls: HashSet<String>,
    results: HashSet<String>,
    model: Option<String>,
    thinking: Option<String>,
    mcp: Option<Arc<McpServer>>,
}

/// One Antigravity Session's runtime.
pub struct AntigravityDriver {
    options: AntigravityOptions,
    host: Arc<dyn ToolHost>,
    events: mpsc::UnboundedSender<DriverEvent>,
    shared: Arc<Mutex<Shared>>,
    starting: tokio::sync::Mutex<()>,
}

fn lock(shared: &Mutex<Shared>) -> std::sync::MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl AntigravityDriver {
    /// A driver that reports to `events` and serves the model's tool calls from `host`.
    pub fn new(options: AntigravityOptions, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Arc<AntigravityDriver> {
        let shared = Shared { model: options.model.clone(), thinking: options.thinking.clone(), ..Default::default() };
        Arc::new(AntigravityDriver { options, host, events, shared: Arc::new(Mutex::new(shared)), starting: tokio::sync::Mutex::new(()) })
    }

    fn emit(&self, event: DriverEvent) {
        let _ = self.events.send(event);
    }

    /// Mark the prompt that started the running turn taken once the runtime acts on it without echoing the user message.
    fn take_started(&self) {
        let taken = {
            let mut shared = lock(&self.shared);
            if shared.in_flight > 0 && shared.unechoed.len() >= shared.in_flight {
                shared.unechoed.pop_front().and_then(|(_, submission)| submission)
            } else {
                None
            }
        };
        if let Some(id) = taken {
            self.emit(DriverEvent::Taken(id));
        }
    }

    /// Reset a broken runtime process and report its exit so un-taken submissions stay pending without wedging the turn.
    async fn reset_broken(&self, error: String) {
        let process = {
            let mut shared = lock(&self.shared);
            shared.generation += 1;
            shared.session_id = None;
            shared.in_flight = 0;
            shared.queued.clear();
            shared.unechoed.clear();
            shared.refused.clear();
            shared.text.clear();
            for (_, answer) in shared.requests.drain() {
                let _ = answer.send(Err("Antigravity ended before answering".into()));
            }
            shared.process.take()
        };
        if let Some(process) = process {
            process.close(Duration::from_secs(3)).await;
        }
        self.emit(DriverEvent::Exited { error: Some(error), awaited: false });
    }

    /// The running process and its conversation, starting one that resumes `resume` when none runs.
    async fn process(self: &Arc<Self>, resume: Option<String>) -> Result<(Arc<Proc>, String), String> {
        let _one = self.starting.lock().await;
        {
            let shared = lock(&self.shared);
            if let (Some(process), Some(id)) = (&shared.process, &shared.session_id) {
                return Ok((process.clone(), id.clone()));
            }
        }
        let known = lock(&self.shared).mcp.clone();
        let mcp = match (self.host.specs().is_empty(), known) {
            (true, _) => None,
            (false, Some(server)) => Some(server),
            (false, None) => {
                let weak = Arc::downgrade(self);
                let on_call: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                    if let Some(driver) = weak.upgrade() {
                        driver.take_started();
                    }
                });
                let server = Arc::new(start_mcp(self.host.clone(), Some(on_call)).await?);
                lock(&self.shared).mcp = Some(server.clone());
                Some(server)
            }
        };
        let (process, lines) = Proc::spawn(&launch(&self.options))?;
        let generation = {
            let mut shared = lock(&self.shared);
            shared.generation += 1;
            shared.process = Some(process.clone());
            shared.session_id = None;
            shared.generation
        };
        tokio::spawn(self.clone().read(lines, generation));
        match tokio::time::timeout(Duration::from_secs(90), self.open(&process, mcp.as_deref(), resume)).await {
            Ok(Ok(id)) => {
                lock(&self.shared).session_id = Some(id.clone());
                self.emit(DriverEvent::SessionId(id.clone()));
                Ok((process, id))
            }
            failed => {
                {
                    let mut shared = lock(&self.shared);
                    shared.generation += 1;
                    shared.process = None;
                }
                process.close(Duration::from_secs(3)).await;
                Err(match failed {
                    Ok(Err(error)) => format!("Antigravity refused to start: {error}"),
                    _ => "Antigravity did not answer within 90 seconds".into(),
                })
            }
        }
    }

    /// Initialize the protocol and open the conversation: resume `resume`, else a new one.
    async fn open(&self, process: &Proc, mcp: Option<&McpServer>, resume: Option<String>) -> Result<String, String> {
        self.request(process, "initialize", json!({"protocolVersion": 1, "clientCapabilities": {}})).await?;
        let servers: Vec<Value> = mcp
            .map(|server| {
                json!({"type": "http", "name": MCP_SERVER, "url": server.url, "headers": [{"name": "Authorization", "value": format!("Bearer {}", server.token)}]})
            })
            .into_iter()
            .collect();
        let mut params = json!({"cwd": self.options.cwd, "mcpServers": servers});
        if !self.options.system_prompt.is_empty() {
            params["_meta"] = json!({"antigravity": {"systemPrompt": {"append": self.options.system_prompt}}});
        }
        let resumed = match resume {
            Some(id) => {
                let mut params = params.clone();
                params["sessionId"] = json!(id);
                self.request(process, "session/resume", params).await.ok().map(|_| id)
            }
            None => None,
        };
        let id = match resumed {
            Some(id) => id,
            None => {
                let opened = self.request(process, "session/new", params).await?;
                opened["sessionId"].as_str().ok_or("session/new returned no session id")?.to_string()
            }
        };
        let (model, thinking) = {
            let shared = lock(&self.shared);
            (shared.model.clone(), shared.thinking.clone())
        };
        self.configure(process, &id, model.as_deref(), thinking.as_deref()).await;
        Ok(id)
    }

    /// Choose the conversation's model and thinking level; what the runtime refuses keeps its default.
    async fn configure(&self, process: &Proc, id: &str, model: Option<&str>, thinking: Option<&str>) {
        if let Some(model) = model.filter(|model| !model.is_empty()) {
            let _ = self.request(process, "session/set_model", json!({"sessionId": id, "modelId": model})).await;
        }
        if let Some(level) = thought_level(thinking) {
            let _ = self.request(process, "session/set_config_option", json!({"sessionId": id, "configId": "thought_level", "value": level})).await;
        }
    }

    /// Send a request to the runtime and wait for its answer.
    async fn request(&self, process: &Proc, method: &str, params: Value) -> Result<Value, String> {
        let (id, answered) = self.register();
        if let Err(error) = process.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await {
            lock(&self.shared).requests.remove(&id);
            return Err(error);
        }
        answered.await.unwrap_or_else(|_| Err("Antigravity ended before answering".into()))
    }

    fn register(&self) -> (u64, oneshot::Receiver<Result<Value, String>>) {
        let (answer, answered) = oneshot::channel();
        let mut shared = lock(&self.shared);
        shared.next_request += 1;
        let id = shared.next_request;
        shared.requests.insert(id, answer);
        (id, answered)
    }

    /// Send a prompt; its answer, which comes when the turn it joined ends, is handled off this call.
    /// Boxed with its `Send` bound spelled out: an answer may send the next prompt, which makes the future recursive.
    fn prompt(self: &Arc<Self>, process: Arc<Proc>, session: String, submission: Option<String>, content: Value) -> BoxFut<'static, Result<(), String>> {
        let driver = self.clone();
        Box::pin(async move { driver.send_prompt(process, &session, submission, content).await })
    }

    async fn send_prompt(self: &Arc<Self>, process: Arc<Proc>, session: &str, submission: Option<String>, content: Value) -> Result<(), String> {
        let (id, answered) = self.register();
        let generation = {
            let mut shared = lock(&self.shared);
            shared.in_flight += 1;
            if submission.is_some() {
                shared.notes = 0;
            }
            shared.unechoed.push_back((id, submission));
            shared.generation
        };
        self.emit(DriverEvent::Running);
        let sent = process.send(&json!({"jsonrpc": "2.0", "id": id, "method": "session/prompt", "params": {"sessionId": session, "prompt": content}})).await;
        if let Err(error) = sent {
            let mut shared = lock(&self.shared);
            shared.requests.remove(&id);
            shared.in_flight -= 1;
            shared.unechoed.retain(|(known, _)| *known != id);
            return Err(error);
        }
        let driver = self.clone();
        tokio::spawn(async move {
            let answer = answered.await.unwrap_or_else(|_| Err("Antigravity ended before answering".into()));
            driver.answered(generation, id, answer).await;
        });
        Ok(())
    }

    /// A prompt's answer came: record what the model said, then run the next follow-up or report the runtime idle.
    async fn answered(self: &Arc<Self>, generation: u64, request_id: u64, answer: Result<Value, String>) {
        let (taken, broken, said, next) = {
            let mut shared = lock(&self.shared);
            if shared.generation != generation {
                return;
            }
            shared.in_flight = shared.in_flight.saturating_sub(1);
            let untaken = shared
                .unechoed
                .iter()
                .position(|(known, _)| *known == request_id)
                .and_then(|index| shared.unechoed.remove(index))
                .and_then(|(_, submission)| submission);
            let text = std::mem::take(&mut shared.text);
            if let Err(error) = &answer {
                if untaken.is_some() {
                    let detail = format!("{text}{error}").trim().to_string();
                    (None, Some(detail), None, None)
                } else {
                    let said = Some(Message {
                        role: Role::Assistant,
                        content: vec![Block::text(format!("{text}{error}").trim().to_string())],
                        stop_reason: Some("error".into()),
                    });
                    let next = if shared.in_flight > 0 {
                        None
                    } else {
                        shared.refused.clear();
                        shared.queued.pop_front().map(|(id, content)| (Some(id), content))
                    };
                    (None, None, said, next.map(|next| (next, shared.process.clone(), shared.session_id.clone())))
                }
            } else {
                let result = answer.as_ref().expect("checked Ok");
                let taken = untaken;
                let said = (!text.trim().is_empty()).then(|| Message {
                    role: Role::Assistant,
                    content: vec![Block::text(text)],
                    stop_reason: Some(stop_reason(result["stopReason"].as_str().unwrap_or("end_turn")).into()),
                });
                if result["stopReason"] == "cancelled" {
                    shared.refused.clear();
                }
                let next = if shared.in_flight > 0 {
                    None
                } else if !shared.refused.is_empty() && shared.notes < MAX_NOTES {
                    shared.notes += 1;
                    let reasons = std::mem::take(&mut shared.refused).join("\n");
                    Some((
                        None,
                        json!([{"type": "text", "text": format!("[Neo] These tool calls were refused and did not run:\n{reasons}\nContinue without them.")}]),
                    ))
                } else {
                    shared.refused.clear();
                    shared.queued.pop_front().map(|(id, content)| (Some(id), content))
                };
                (taken, None, said, next.map(|next| (next, shared.process.clone(), shared.session_id.clone())))
            }
        };
        if let Some(detail) = broken {
            self.reset_broken(detail).await;
            return;
        }
        if let Some(id) = taken {
            self.emit(DriverEvent::Taken(id));
        }
        if let Some(message) = said {
            self.emit(DriverEvent::Message(message));
        }
        match next {
            Some(((submission, content), Some(process), Some(session))) => {
                if let Err(error) = self.prompt(process, session, submission.clone(), content).await {
                    if submission.is_some() {
                        self.reset_broken(error).await;
                    } else {
                        self.emit(DriverEvent::Message(Message {
                            role: Role::Assistant,
                            content: vec![Block::text(error)],
                            stop_reason: Some("error".into()),
                        }));
                        self.emit(DriverEvent::Idle { awaiting_async: false });
                    }
                }
            }
            Some(_) => {}
            None => {
                if lock(&self.shared).in_flight == 0 {
                    self.emit(DriverEvent::Idle { awaiting_async: false });
                }
            }
        }
    }

    async fn read(self: Arc<Self>, mut lines: mpsc::UnboundedReceiver<Line>, generation: u64) {
        while let Some(line) = lines.recv().await {
            if lock(&self.shared).generation != generation {
                return;
            }
            match line {
                Line::Json(value) => self.handle(value).await,
                Line::Exited(error) => {
                    {
                        let mut shared = lock(&self.shared);
                        shared.generation += 1;
                        shared.process = None;
                        shared.session_id = None;
                        shared.in_flight = 0;
                        shared.queued.clear();
                        shared.unechoed.clear();
                        shared.refused.clear();
                        shared.text.clear();
                        for (_, answer) in shared.requests.drain() {
                            let _ = answer.send(Err("Antigravity ended before answering".into()));
                        }
                    }
                    self.emit(DriverEvent::Exited { error, awaited: false });
                    return;
                }
            }
        }
    }

    async fn handle(self: &Arc<Self>, line: Value) {
        let method = line["method"].as_str();
        match (method, line.get("id").filter(|id| !id.is_null())) {
            // An answer to one of our requests.
            (None, Some(id)) => {
                let Some(answer) = id.as_u64().and_then(|id| lock(&self.shared).requests.remove(&id)) else { return };
                let _ = answer.send(match line.get("error") {
                    Some(error) => Err(error["message"].as_str().map(str::to_string).unwrap_or_else(|| error.to_string())),
                    None => Ok(line["result"].clone()),
                });
            }
            // A request of the runtime, answered off the reading task so a slow guard does not hold up the stream.
            (Some(_), Some(_)) => {
                let driver = self.clone();
                tokio::spawn(async move { driver.serve(line).await });
            }
            (Some("session/update"), None) => self.update(&line["params"]["update"]),
            _ => {}
        }
    }

    fn update(&self, update: &Value) {
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        let mut emitted = Vec::new();
        {
            let mut shared = lock(&self.shared);
            // Outside a prompt nothing would end the turn the update starts.
            if shared.in_flight == 0 {
                return;
            }
            let echoing = std::mem::replace(&mut shared.echoing, kind == "user_message_chunk");
            if matches!(kind, "agent_thought_chunk" | "thought_chunk" | "agent_message_chunk" | "tool_call" | "tool_call_update" | "plan")
                && shared.unechoed.len() >= shared.in_flight
            {
                // Antigravity 1.5.10+ begins the model's step without echoing `user_message_chunk`.
                if let Some((_, submission)) = shared.unechoed.pop_front() {
                    if let Some(id) = submission {
                        emitted.push(DriverEvent::Taken(id));
                    }
                }
            }
            match kind {
                "user_message_chunk" if !echoing => {
                    // The runtime echoed a submission it took into a step; its blocks arrive as consecutive chunks.
                    if let Some((_, submission)) = shared.unechoed.pop_front() {
                        if let Some(id) = submission {
                            emitted.push(DriverEvent::Taken(id));
                        }
                    }
                }
                "agent_message_chunk" => {
                    if let Some(text) = update["content"]["text"].as_str().filter(|_| update["content"]["type"] == "text") {
                        shared.text.push_str(text);
                    }
                }
                "tool_call" | "tool_call_update" => {
                    let Some(id) = update["toolCallId"].as_str() else { return };
                    if shared.calls.insert(id.to_string()) {
                        let name = update["name"].as_str().or(update["title"].as_str()).unwrap_or("tool").to_string();
                        let arguments = update.get("rawInput").or(update.get("args")).cloned().unwrap_or_else(|| json!({}));
                        let mut content = Vec::new();
                        let text = std::mem::take(&mut shared.text);
                        if !text.trim().is_empty() {
                            content.push(Block::text(text));
                        }
                        content.push(Block::ToolCall { id: id.to_string(), name, arguments });
                        emitted.push(DriverEvent::Message(Message { role: Role::Assistant, content, stop_reason: Some("toolUse".into()) }));
                    }
                    let finished = matches!(update["status"].as_str(), Some("completed" | "failed"));
                    if finished && shared.results.insert(id.to_string()) {
                        let text: String = tool_output(update).chars().take(2000).collect();
                        emitted.push(DriverEvent::Message(Message { role: Role::ToolResult, content: vec![Block::text(text)], stop_reason: None }));
                    }
                }
                _ => {}
            }
        }
        for event in emitted {
            self.emit(event);
        }
    }

    /// Answer a request of the runtime: a permission request goes to the guard; nothing else is offered.
    async fn serve(&self, line: Value) {
        let id = line["id"].clone();
        let answer = match line["method"].as_str().unwrap_or("") {
            "session/request_permission" => {
                self.take_started();
                let params = &line["params"];
                let call = &params["toolCall"];
                let tool = call["name"].as_str().unwrap_or("");
                let input = call.get("rawInput").or(call.get("args")).cloned().unwrap_or_else(|| json!({}));
                let refusal = match self.permitted(tool, call["kind"].as_str(), &input) {
                    Ok((name, input)) => match self.host.guard(&name, &input).await {
                        Guard::Allow => None,
                        Guard::Block(reason) => Some(reason),
                    },
                    Err(()) => Some("This Session cannot use that tool".to_string()),
                };
                let allowed = refusal.is_none();
                if let Some(reason) = refusal {
                    let what = call["title"].as_str().filter(|title| !title.is_empty()).unwrap_or(tool);
                    lock(&self.shared).refused.push(format!("- {tool} `{what}`: {reason}"));
                }
                let wanted: &[&str] = if allowed { &["allow_once", "allow_always"] } else { &["reject_once", "reject_always"] };
                let options = params["options"].as_array().cloned().unwrap_or_default();
                let chosen =
                    wanted.iter().find_map(|kind| options.iter().find(|option| option["kind"] == *kind)).and_then(|option| option["optionId"].as_str());
                let outcome = match chosen {
                    Some(option) => json!({"outcome": "selected", "optionId": option}),
                    None => json!({"outcome": "cancelled"}),
                };
                json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": outcome}})
            }
            method => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("Method not found: {method}")}}),
        };
        let Some(process) = lock(&self.shared).process.clone() else { return };
        let _ = process.send(&answer).await;
    }

    /// Whether this Session may use a runtime tool at all, and if so what the guard judges.
    fn permitted(&self, tool: &str, kind: Option<&str>, input: &Value) -> Result<(String, Value), ()> {
        let (name, input) = host_view(tool, kind, input);
        let allowed = |kind: &str| self.options.tools.iter().any(|known| known == kind);
        let ok = if TOOL_KINDS.contains(&name.as_str()) { allowed(&name) } else { self.host.specs().iter().any(|spec| spec.name == name) || allowed("bash") };
        if ok {
            Ok((name, input))
        } else {
            Err(())
        }
    }

    fn current(&self) -> Option<(Arc<Proc>, String)> {
        let shared = lock(&self.shared);
        Some((shared.process.clone()?, shared.session_id.clone()?))
    }
}

/// Lets the driver be used through `Arc<dyn Driver>` while its methods need the `Arc` to spawn tasks.
pub struct Antigravity(pub Arc<AntigravityDriver>);

impl Driver for Antigravity {
    fn kernel(&self) -> &'static str {
        "antigravity"
    }
    fn submit<'a>(&'a self, id: &'a str, content: &'a [Block], deliver: Deliver, resume: Option<String>) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            let (process, session) = self.0.process(resume).await?;
            let content = prompt_content(content);
            // A steered message joins the running turn at its next tool boundary; a follow-up waits for the turn to end.
            {
                let mut shared = lock(&self.0.shared);
                if deliver == Deliver::FollowUp && (shared.in_flight > 0 || !shared.queued.is_empty()) {
                    shared.queued.push_back((id.to_string(), content));
                    return Ok(());
                }
            }
            self.0.prompt(process, session, Some(id.to_string()), content).await
        })
    }
    fn interrupt(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            if let Some((process, session)) = self.0.current() {
                let _ = process.send(&json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session}})).await;
            }
        })
    }
    fn jobs(&self) -> BoxFut<'_, Vec<KernelJob>> {
        // The runtime does not report its background commands over the protocol.
        Box::pin(async { Vec::new() })
    }
    fn acknowledge<'a>(&'a self, _ids: &'a [String]) -> BoxFut<'a, ()> {
        Box::pin(async {})
    }
    fn cancel<'a>(&'a self, _id: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async { false })
    }
    fn set_model<'a>(&'a self, model: Option<&'a str>, thinking: Option<&'a str>) -> BoxFut<'a, ()> {
        Box::pin(async move {
            {
                let mut shared = lock(&self.0.shared);
                shared.model = model.map(str::to_string);
                shared.thinking = thinking.map(str::to_string);
            }
            if let Some((process, session)) = self.0.current() {
                let _ = tokio::time::timeout(Duration::from_secs(20), self.0.configure(&process, &session, model, thinking)).await;
            }
        })
    }
    fn pid(&self) -> Option<u32> {
        lock(&self.0.shared).process.as_ref().map(|process| process.pid())
    }
    fn close(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            let (process, _server) = {
                let mut shared = lock(&self.0.shared);
                // Lines of the closed process are ignored from here on.
                shared.generation += 1;
                shared.session_id = None;
                shared.in_flight = 0;
                shared.queued.clear();
                shared.unechoed.clear();
                shared.refused.clear();
                (shared.process.take(), shared.mcp.take())
            };
            if let Some(process) = process {
                process.close(Duration::from_secs(5)).await;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_thinking_levels_to_the_three_antigravity_levels() {
        assert_eq!(thought_level(None), None);
        assert_eq!(thought_level(Some("auto")), None);
        assert_eq!(thought_level(Some("off")), Some("low"));
        assert_eq!(thought_level(Some("medium")), Some("medium"));
        assert_eq!(thought_level(Some("max")), Some("high"));
    }

    #[test]
    fn sees_runtime_tools_as_the_host_names_them() {
        assert_eq!(
            host_view("run_command", Some("execute"), &json!({"CommandLine": "ls", "WaitMsBeforeAsync": 5000})),
            ("bash".into(), json!({"command": "ls"}))
        );
        assert_eq!(host_view("write_file", Some("edit"), &json!({"Path": "/w/a.txt", "Content": "x"})), ("write".into(), json!({"path": "/w/a.txt"})));
        assert_eq!(host_view("edit_file", Some("edit"), &json!({"Path": "/w/a", "Target": "x"})), ("edit".into(), json!({"path": "/w/a"})));
        assert_eq!(host_view("multi_replace_file_content", None, &json!({"TargetFile": "/w/a"})).0, "edit");
        assert_eq!(host_view("some_new_tool", Some("delete"), &json!({"Path": "/w/a"})).0, "edit");
        assert_eq!(host_view("read_file", Some("read"), &json!({})).0, "read");
        assert_eq!(host_view("invoke_subagent", Some("other"), &json!({})).0, "task");
        assert_eq!(host_view("mcp_neo_ticket_report", Some("other"), &json!({"a": 1})), ("ticket_report".into(), json!({"a": 1})));
        assert_eq!(host_view("read_url_content", Some("fetch"), &json!({})).0, "read_url_content");
    }

    #[test]
    fn drops_display_arguments_a_tool_does_not_declare() {
        let spec =
            ToolSpec { name: "t".into(), description: String::new(), schema: json!({"type": "object", "properties": {"explanation": {"type": "string"}}}) };
        let arguments = json!({"toolSummary": "x", "explanation": "why", "text": "hi"});
        assert_eq!(strip_injected(Some(&spec), arguments.clone()), json!({"explanation": "why", "text": "hi"}));
        assert_eq!(strip_injected(None, arguments), json!({"text": "hi"}));
    }

    #[test]
    fn parses_the_model_list() {
        let listed = "Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n\n";
        assert_eq!(
            parse_models(listed),
            vec![("gemini-3.8-flash-low".into(), "Gemini 3.8 Flash (Low)".into()), ("claude-opus-5-5-high".into(), "Claude Opus 5.5 (High)".into())]
        );
    }

    #[test]
    fn reads_tool_output_from_content_or_raw_output() {
        let content = json!({"status": "completed", "content": [{"type": "content", "content": {"type": "text", "text": "done"}}]});
        assert_eq!(tool_output(&content), "done");
        assert_eq!(tool_output(&json!({"status": "completed", "rawOutput": {"output": "out"}})), "out");
        assert_eq!(tool_output(&json!({"status": "failed"})), "failed");
        assert_eq!(stop_reason("cancelled"), "aborted");
        assert_eq!(stop_reason("end_turn"), "stop");
    }

    #[test]
    fn sends_images_as_acp_image_blocks() {
        assert_eq!(
            prompt_content(&[Block::text("see"), Block::Image { mime_type: "image/png".into(), data: "AAAA".into() }]),
            json!([{"type": "text", "text": "see"}, {"type": "image", "mimeType": "image/png", "data": "AAAA"}])
        );
    }

    struct Echo;
    impl ToolHost for Echo {
        fn specs(&self) -> Vec<ToolSpec> {
            vec![ToolSpec { name: "echo".into(), description: "Echoes.".into(), schema: json!({"type": "object", "properties": {"text": {"type": "string"}}}) }]
        }
        fn call<'a>(&'a self, _name: &'a str, arguments: Value) -> BoxFut<'a, Result<Value, String>> {
            Box::pin(async move { Ok(arguments) })
        }
        fn guard<'a>(&'a self, _tool: &'a str, input: &'a Value) -> BoxFut<'a, Guard> {
            Box::pin(async move {
                if input["text"] == "no" {
                    Guard::Block("refused".into())
                } else {
                    Guard::Allow
                }
            })
        }
    }

    async fn post(url: &str, token: &str, body: &Value) -> (u16, Option<Value>) {
        let address = url.trim_start_matches("http://").split('/').next().unwrap().to_string();
        let mut stream = TcpStream::connect(address).await.unwrap();
        let body = serde_json::to_vec(body).unwrap();
        let head = format!("POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        stream.write_all(head.as_bytes()).await.unwrap();
        stream.write_all(&body).await.unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).await.unwrap();
        let status = reply.split_whitespace().nth(1).unwrap().parse().unwrap();
        let body = reply.split_once("\r\n\r\n").map(|(_, body)| body).filter(|body| !body.is_empty()).map(|body| serde_json::from_str(body).unwrap());
        (status, body)
    }

    #[tokio::test]
    async fn serves_the_host_tools_over_mcp_to_the_token_holder_only() {
        let server = start_mcp(Arc::new(Echo), None).await.unwrap();
        let (status, _) = post(&server.url, "wrong", &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})).await;
        assert_eq!(status, 401);
        let (_, listed) = post(&server.url, &server.token, &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})).await;
        assert_eq!(listed.unwrap()["result"]["tools"][0]["name"], "echo");
        assert_eq!(post(&server.url, &server.token, &json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).await, (202, None));
        let call = |text: &str| json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "echo", "arguments": {"text": text, "toolSummary": "s"}}});
        let (_, called) = post(&server.url, &server.token, &call("hi")).await;
        assert_eq!(called.unwrap()["result"]["content"][0]["text"], json!({"text": "hi"}).to_string());
        let (_, blocked) = post(&server.url, &server.token, &call("no")).await;
        assert_eq!(blocked.unwrap()["result"], json!({"isError": true, "content": [{"type": "text", "text": "refused"}]}));
        let (_, unknown) = post(&server.url, &server.token, &json!({"jsonrpc": "2.0", "id": 3, "method": "server/discover"})).await;
        assert_eq!(unknown.unwrap()["error"]["code"], -32601);
    }

    #[cfg(unix)]
    mod lifecycle {
        use super::*;
        use crate::journal::Journal;
        use crate::session::{Mode, Presentation, Session};
        use crate::types::KernelEvent;
        use std::os::unix::fs::PermissionsExt;

        fn fake_acp(dir: &std::path::Path, script_body: &str) -> PathBuf {
            let path = dir.join("fake-agy.py");
            let script = format!("#!/usr/bin/env python3\nimport json, sys, time, urllib.request\n{script_body}\n");
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        #[tokio::test]
        async fn marks_prompts_taken_and_ends_turns_without_user_message_chunks_or_on_steered_prompts() {
            let dir = std::env::temp_dir().join(format!("neo-agy-test-{}-{}", std::process::id(), uuid()));
            std::fs::create_dir_all(&dir).unwrap();
            let program = fake_acp(
                &dir,
                r#"
mcp_url = None
mcp_auth = None
held = []
for raw in sys.stdin:
    msg = json.loads(raw)
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1}}) + "\n")
        sys.stdout.flush()
    elif method == "session/new":
        servers = msg["params"].get("mcpServers") or []
        if servers:
            mcp_url = servers[0]["url"]
            mcp_auth = servers[0]["headers"][0]["value"]
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "s-1"}}) + "\n")
        sys.stdout.flush()
    elif method == "session/prompt":
        text = msg["params"]["prompt"][0]["text"]
        if "turn1" in text:
            # Antigravity 1.5.10+: no user_message_chunk; call MCP tool directly then emit agent_message_chunk.
            req = urllib.request.Request(
                mcp_url,
                data=json.dumps({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "echo", "arguments": {"text": "ok"}}}).encode(),
                headers={"Authorization": mcp_auth, "Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5).read()
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done 1"}}}}) + "\n")
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}}) + "\n")
            sys.stdout.flush()
        elif "hold" in text:
            held.append(mid)
        elif "release" in text:
            held.append(mid)
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done steered"}}}}) + "\n")
            for hid in held:
                sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": hid, "result": {"stopReason": "end_turn"}}) + "\n")
            held.clear()
            sys.stdout.flush()
        elif "fail_rpc" in text:
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": "rpc failed"}}) + "\n")
            sys.stdout.flush()
"#,
            );

            struct RecordingHost {
                pending_on_call: Mutex<Vec<usize>>,
                journal: Arc<Journal>,
            }
            impl ToolHost for RecordingHost {
                fn specs(&self) -> Vec<ToolSpec> {
                    Echo.specs()
                }
                fn call<'a>(&'a self, _name: &'a str, arguments: Value) -> BoxFut<'a, Result<Value, String>> {
                    Box::pin(async move {
                        self.pending_on_call.lock().unwrap().push(self.journal.pending().len());
                        Ok(arguments)
                    })
                }
            }

            let journal = Arc::new(Journal::create(&dir, &dir).unwrap());
            let host = Arc::new(RecordingHost { pending_on_call: Mutex::new(Vec::new()), journal: journal.clone() });
            let options = AntigravityOptions { program, cwd: dir.clone(), tools: vec!["read".into()], ..Default::default() };
            let (reports, runtime) = mpsc::unbounded_channel();
            let driver = AntigravityDriver::new(options, host.clone(), reports);
            let session = Session::new(journal.clone(), Arc::new(Antigravity(driver)), runtime);
            let mut events = session.subscribe();

            async fn wait_turn(events: &mut tokio::sync::broadcast::Receiver<KernelEvent>) -> Vec<KernelEvent> {
                let mut seen = Vec::new();
                loop {
                    let event = tokio::time::timeout(Duration::from_secs(10), events.recv()).await.expect("turn finishes").unwrap();
                    let done = matches!(event, KernelEvent::AgentEnd { .. });
                    seen.push(event);
                    if done {
                        return seen;
                    }
                }
            }

            // 1. Single prompt without user_message_chunk: Taken fires before MCP tool call and turn ends cleanly.
            session.send("r1", vec![Block::text("turn1")], Mode::Steer, &Presentation::default(), &[]).await.unwrap();
            let seen = wait_turn(&mut events).await;
            assert!(seen.contains(&KernelEvent::Taken { request_ids: vec!["r1".into()] }), "{seen:?}");
            assert!(!session.is_streaming() && !session.has_admitted_submission());
            assert!(journal.pending().is_empty());
            assert_eq!(*host.pending_on_call.lock().unwrap(), vec![0], "submission is already marked taken when MCP tool executes");

            // 2. Concurrent Mode::Steer prompts answered together without user_message_chunk: all are taken and turn ends.
            session.send("r2", vec![Block::text("hold-1")], Mode::Steer, &Presentation::default(), &[]).await.unwrap();
            session.send("r3", vec![Block::text("hold-2")], Mode::Steer, &Presentation::default(), &[]).await.unwrap();
            session.send("r4", vec![Block::text("release")], Mode::Steer, &Presentation::default(), &[]).await.unwrap();
            let seen = wait_turn(&mut events).await;
            for req in ["r2", "r3", "r4"] {
                assert!(
                    seen.iter().any(|e| matches!(e, KernelEvent::Taken { request_ids } if request_ids.contains(&req.to_string()))),
                    "missing {req}: {seen:?}"
                );
            }
            assert!(!session.is_streaming() && !session.has_admitted_submission());
            assert!(journal.pending().is_empty());

            // 3. Un-taken prompt rejected with JSON-RPC error: turn ends cleanly while entry stays pending for retry.
            session.send("r5", vec![Block::text("fail_rpc")], Mode::Steer, &Presentation::default(), &[]).await.unwrap();
            let _ = wait_turn(&mut events).await;
            assert!(!session.is_streaming() && !session.has_admitted_submission());
            assert_eq!(journal.last_stop_reason().as_deref(), Some("error"));
            assert_eq!(journal.pending().len(), 1);

            session.dispose().await;
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
