//! The Antigravity kernel: one `agy` process per Session in its headless print mode, driven by stream-json lines on
//! its standard input and output.
//!
//! The runtime takes the Session's system prompt, built-in tools and extensions from a custom agent. The driver writes
//! that agent, with a plugin carrying the host's MCP server and its hooks, into a bridge folder beside the Session's
//! working directory and adds the folder to the runtime's workspace. Antigravity orders its workspace folders by path
//! and works in the first, and the bridge's path extends the working directory's, so it always comes second.
//!
//! The host's tools reach the model through an MCP server on the loopback interface, which answers only the bearer
//! token written into the plugin. Every tool call, the main conversation's and its subagents', runs a `PreToolUse`
//! hook first: a relay program posts it to the same server, the guard judges it, and a refusal reaches the model with
//! its reason. A hook that fails refuses the call. `Stop` hooks tell whether background commands or subagents still
//! run, which the stream only shows once they end. The runtime keeps its conversations itself, and
//! `--conversation` continues one in a new process.

use crate::process::{Launch, Line, Proc};
use crate::session::{Driver, DriverEvent};
use crate::types::{uuid, Block, BoxFut, Deliver, Guard, JobKind, KernelJob, Message, Role, ToolHost, ToolSpec};
use neo_core::time::now_ms;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

/// The plugin that carries the host's MCP server and hooks.
pub const PLUGIN: &str = "neo";

/// The MCP server, inside the plugin, that carries the host's tools.
pub const MCP_SERVER: &str = "neo";

/// The custom agent a Session runs as.
pub const AGENT: &str = "neo-session";

/// The name the model gives the host's MCP server when it calls `call_mcp_tool`: the plugin's, then the server's.
pub fn mcp_server_name() -> String {
    format!("{PLUGIN}_{MCP_SERVER}")
}

/// A thinking level as Antigravity's `--effort`: `None` keeps the model's own.
pub fn effort_of(level: Option<&str>) -> Option<&'static str> {
    match level? {
        "off" | "minimal" | "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

/// The kinds of built-in tool a Session may be allowed, in the host's words.
pub const TOOL_KINDS: &[&str] = &["read", "bash", "edit", "write", "task"];

/// The runtime's tools for each kind. Tools of no kind, such as fetching a web page, come with `bash`.
fn runtime_tools(kind: &str) -> &'static [&'static str] {
    match kind {
        "read" => &["view_file", "list_dir", "grep_search", "find_by_name"],
        "bash" => &["run_command", "command_status", "send_command_input", "manage_task", "wait", "read_url_content", "search_web"],
        "edit" => &["replace_file_content", "multi_replace_file_content"],
        "write" => &["write_to_file"],
        "task" => &["invoke_subagent", "manage_subagents"],
        _ => &[],
    }
}

/// How an Antigravity Session runs.
#[derive(Clone, Default)]
pub struct AntigravityOptions {
    /// The `agy` executable.
    pub program: PathBuf,
    /// The Session's working directory.
    pub cwd: PathBuf,
    /// What the Session adds to the runtime's own system prompt.
    pub system_prompt: String,
    /// The built-in tool kinds the model may use: of [`TOOL_KINDS`].
    pub tools: Vec<String>,
    /// The model, or the runtime's default.
    pub model: Option<String>,
    /// The thinking level, as in settings.
    pub thinking: Option<String>,
    /// Variables to set for the runtime.
    pub env: BTreeMap<String, String>,
    /// The program, and its first arguments, that relays a hook to this driver: the hook's URL follows them. It is
    /// `neo-agent agy-hook` in the application, which runs [`relay_hook`].
    pub hook_relay: Vec<String>,
}

/// The folder beside `cwd` that carries a Session's agent and plugin. Its path extends `cwd`'s, so it sorts after it.
pub fn bridge_dir(cwd: &Path, id: &str) -> PathBuf {
    let mut path = cwd.as_os_str().to_owned();
    path.push(format!(".neo-{id}"));
    PathBuf::from(path)
}

/// The file that marks a bridge folder as the driver's, with the host's process id.
const BRIDGE_MARKER: &str = ".neo-bridge";

/// A command line for `sh -c`, or `cmd /c` on Windows.
fn shell_command(words: &[String]) -> String {
    words
        .iter()
        .map(|word| if cfg!(windows) { format!("\"{}\"", word.replace('"', "\"\"")) } else { format!("'{}'", word.replace('\'', "'\\''")) })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The custom agent's file: its plugin, its built-in tools, and the Session's prompt.
pub fn agent_file(options: &AntigravityOptions) -> String {
    let mut tools: Vec<&str> = Vec::new();
    for kind in &options.tools {
        for tool in runtime_tools(kind) {
            if !tools.contains(tool) {
                tools.push(tool);
            }
        }
    }
    format!(
        "---\nname: {AGENT}\ndescription: A Neo Session.\nplugins:\n  - {PLUGIN}\ntools: [{}]\n---\n{}\n",
        tools.join(", "),
        options.system_prompt.trim_end()
    )
}

/// The plugin's hooks: every tool call is judged before it runs; ends of tool calls, model calls and turns are reported.
pub fn hooks_file(command: &str) -> Value {
    let handler = |timeout: u64| json!([{"type": "command", "command": command, "timeout": timeout}]);
    json!({
        PLUGIN: {
            "PreToolUse": [{"matcher": "*", "hooks": handler(600)}],
            "PostToolUse": [{"matcher": "*", "hooks": handler(30)}],
            "PreInvocation": handler(30),
            "Stop": handler(30),
        }
    })
}

/// The command line and environment of an Antigravity process.
pub fn launch(options: &AntigravityOptions, bridge: &Path, resume: Option<&str>) -> Launch {
    let mut args: Vec<String> = ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands"].map(String::from).to_vec();
    args.extend(["--add-dir".into(), bridge.display().to_string(), "--agent".into(), AGENT.into()]);
    // Since 1.5.7 the CLI starts in auto mode, which runs commands in a terminal sandbox with no network and asks a
    // person before leaving it, and out of it every command waits for a person's review; nobody is there to answer
    // either. Neo's PreToolUse hook decides instead, as `bypassPermissions` lets it on Claude Code, so commands run
    // on this machine and reach its network.
    let settings = json!({
        "agentMode": "",
        "toolPermission": "always-proceed",
        "permissions": {"allow": [format!("mcp({}/*)", mcp_server_name())]},
    });
    args.extend(["--settings".into(), settings.to_string()]);
    if let Some(model) = options.model.as_deref().filter(|model| !model.is_empty()) {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(effort) = effort_of(options.thinking.as_deref()) {
        args.extend(["--effort".into(), effort.into()]);
    }
    if let Some(id) = resume {
        args.extend(["--conversation".into(), id.into()]);
    }
    // Print mode, its prompts coming as stream-json lines.
    args.push("-p=".into());
    Launch {
        program: options.program.clone(),
        args,
        cwd: options.cwd.clone(),
        env: options.env.clone(),
        env_remove: crate::claude::SESSION_VARIABLES.iter().map(|name| name.to_string()).collect(),
    }
}

/// A runtime tool call in the host's words: the kind or host tool it is, and the input the guard judges.
pub fn host_view(tool: &str, input: &Value) -> (String, Value) {
    let path = || {
        let path = ["Path", "TargetFile", "AbsolutePath", "File"].iter().find_map(|field| input[*field].as_str()).unwrap_or("");
        json!({ "path": path })
    };
    match tool {
        "run_command" => ("bash".into(), json!({"command": input["CommandLine"].as_str().unwrap_or("")})),
        "send_command_input" => ("bash".into(), json!({"command": input["Input"].as_str().unwrap_or("")})),
        "write_file" | "write_to_file" => ("write".into(), path()),
        "edit_file" | "replace_file_content" | "multi_replace_file_content" | "sed_file" | "notebook_edit" | "delete_file" | "move_file" => {
            ("edit".into(), path())
        }
        "read_file" | "view_file" | "list_dir" | "grep_search" | "find_by_name" => ("read".into(), input.clone()),
        "invoke_subagent" | "define_subagent" | "manage_subagents" | "browser_subagent" => ("task".into(), input.clone()),
        _ => (tool.to_string(), input.clone()),
    }
}

/// Arguments Antigravity adds to every tool call for its own display; a tool that does not declare one never sees it.
const INJECTED_ARGUMENTS: &[&str] = &["toolSummary", "explanation", "toolAction", "waitForPreviousTools"];

fn strip_injected(spec: Option<&ToolSpec>, mut arguments: Value) -> Value {
    if let Some(fields) = arguments.as_object_mut() {
        let declared = |name: &str| spec.is_some_and(|spec| spec.schema["properties"].get(name).is_some());
        fields.retain(|name, _| !INJECTED_ARGUMENTS.contains(&name.as_str()) || declared(name));
    }
    arguments
}

/// The models `agy models` lists: id and display name.
pub async fn list_models(program: &Path, env: &BTreeMap<String, String>) -> Result<Vec<(String, String)>, String> {
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

/// Relay one hook: the hook's input, read from `input`, is posted to `url`, and the answer written to `output`.
/// Antigravity runs this as the hook's command; an error makes the command fail, which refuses a tool call.
pub fn relay_hook(url: &str, input: &mut impl Read, output: &mut impl Write) -> Result<(), String> {
    let rest = url.strip_prefix("http://").ok_or("The hook URL is not http")?;
    let (address, path) = rest.split_once('/').map(|(address, path)| (address, format!("/{path}"))).unwrap_or((rest, "/".into()));
    let mut body = Vec::new();
    input.read_to_end(&mut body).map_err(|error| format!("Cannot read the hook's input: {error}"))?;
    let mut stream = std::net::TcpStream::connect(address).map_err(|error| format!("Cannot reach Neo at {address}: {error}"))?;
    // The guard may take its time; Antigravity's own limit on the hook ends it first.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(900)));
    let head =
        format!("POST {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(&body)).map_err(|error| format!("Cannot send the hook to Neo: {error}"))?;
    let mut reply = Vec::new();
    stream.read_to_end(&mut reply).map_err(|error| format!("Neo did not answer the hook: {error}"))?;
    let split = reply.windows(4).position(|window| window == b"\r\n\r\n").ok_or("Neo's answer to the hook is malformed")?;
    let status = String::from_utf8_lossy(&reply[..split]).split_whitespace().nth(1).unwrap_or("").to_string();
    if status != "200" {
        return Err(format!("Neo answered the hook with status {status}"));
    }
    output.write_all(&reply[split + 4..]).and_then(|_| output.flush()).map_err(|error| format!("Cannot write the hook's answer: {error}"))
}

type HookHandler = Arc<dyn Fn(Value) -> BoxFut<'static, Value> + Send + Sync>;

/// The host's tools as an MCP server, and the hooks' endpoint, on the loopback interface.
struct HostServer {
    port: u16,
    token: String,
    task: tokio::task::JoinHandle<()>,
}

impl HostServer {
    fn mcp_url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }
    fn hook_url(&self) -> String {
        format!("http://127.0.0.1:{}/hook/{}", self.port, self.token)
    }
}

impl Drop for HostServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The largest request body the server reads.
const BODY_LIMIT: usize = 16 << 20;

#[derive(Clone)]
struct Routes {
    host: Arc<dyn ToolHost>,
    token: String,
    on_tool_call: Option<Arc<dyn Fn() + Send + Sync>>,
    on_hook: Option<HookHandler>,
}

async fn start_server(host: Arc<dyn ToolHost>, on_tool_call: Option<Arc<dyn Fn() + Send + Sync>>, on_hook: Option<HookHandler>) -> Result<HostServer, String> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|error| format!("Cannot open the tool server: {error}"))?;
    let port = listener.local_addr().map_err(|error| format!("Cannot open the tool server: {error}"))?.port();
    let token = format!("{}{}", uuid().replace('-', ""), uuid().replace('-', ""));
    let routes = Routes { host, token: token.clone(), on_tool_call, on_hook };
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve_connection(stream, routes.clone()));
        }
    });
    Ok(HostServer { port, token, task })
}

async fn serve_connection(stream: TcpStream, routes: Routes) {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let bearer = format!("Bearer {}", routes.token);
    let hook_path = format!("/hook/{}", routes.token);
    loop {
        let mut start = String::new();
        if reader.read_line(&mut start).await.unwrap_or(0) == 0 {
            return;
        }
        let mut parts = start.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("").to_string();
        let http11 = parts.next().is_some_and(|version| version == "HTTP/1.1");
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
                "authorization" => authorized = value == bearer,
                "connection" => close = value.eq_ignore_ascii_case("close"),
                "transfer-encoding" => length = usize::MAX,
                _ => {}
            }
        }
        if length > BODY_LIMIT {
            let _ = respond(&mut writer, 413, None).await;
            return;
        }
        let mut body = vec![0; length];
        if reader.read_exact(&mut body).await.is_err() {
            return;
        }
        let hook = path == hook_path;
        let (status, answer) = if !(authorized || hook) {
            (401, None)
        } else if method != "POST" {
            (405, None)
        } else {
            match serde_json::from_slice::<Value>(&body) {
                Ok(message) if hook => match &routes.on_hook {
                    Some(on_hook) => (200, Some(on_hook(message).await)),
                    None => (200, Some(json!({}))),
                },
                Ok(message) => match mcp_answer(routes.host.as_ref(), &message, routes.on_tool_call.as_deref()).await {
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

/// The bridge folder of a running process: removed when the process ends.
struct Bridge {
    dir: PathBuf,
}

impl Bridge {
    /// Write the bridge for one process of a Session.
    fn create(options: &AntigravityOptions, server: &HostServer, has_tools: bool) -> Result<Bridge, String> {
        let dir = bridge_dir(&options.cwd, &uuid()[..8]);
        sweep_bridges(&options.cwd);
        let plugin = dir.join(".agents").join("plugins").join(PLUGIN);
        let failed = |error: std::io::Error| format!("Cannot write Antigravity's bridge at {}: {error}", dir.display());
        std::fs::create_dir_all(dir.join(".agents").join("agents")).map_err(failed)?;
        std::fs::create_dir_all(&plugin).map_err(failed)?;
        let bridge = Bridge { dir: dir.clone() };
        std::fs::write(dir.join(BRIDGE_MARKER), std::process::id().to_string()).map_err(failed)?;
        std::fs::write(dir.join(".agents").join("agents").join(format!("{AGENT}.md")), agent_file(options)).map_err(failed)?;
        let manifest = json!({"name": PLUGIN, "description": "Neo's tools and tool-call guard", "version": env!("CARGO_PKG_VERSION")});
        std::fs::write(plugin.join("plugin.json"), manifest.to_string()).map_err(failed)?;
        let mut relay = options.hook_relay.clone();
        relay.push(server.hook_url());
        std::fs::write(plugin.join("hooks.json"), hooks_file(&shell_command(&relay)).to_string()).map_err(failed)?;
        let servers = if has_tools {
            json!({MCP_SERVER: {"url": server.mcp_url(), "headers": {"Authorization": format!("Bearer {}", server.token)}}})
        } else {
            json!({})
        };
        std::fs::write(plugin.join("mcp_config.json"), json!({"mcpServers": servers}).to_string()).map_err(failed)?;
        Ok(bridge)
    }

    /// The folder holds `path`.
    fn holds(&self, path: &str) -> bool {
        !path.is_empty() && Path::new(path).starts_with(&self.dir)
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Remove bridges beside `cwd` that a host process which no longer runs left behind.
fn sweep_bridges(cwd: &Path) {
    #[cfg(unix)]
    {
        let (Some(parent), Some(name)) = (cwd.parent(), cwd.file_name()) else { return };
        let prefix = format!("{}.neo-", name.to_string_lossy());
        let Ok(entries) = std::fs::read_dir(parent) else { return };
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().starts_with(&prefix) {
                continue;
            }
            let Ok(owner) = std::fs::read_to_string(entry.path().join(BRIDGE_MARKER)) else { continue };
            let Ok(pid) = owner.trim().parse::<i32>() else { continue };
            // SAFETY: signal 0 only checks whether the process exists.
            let alive = pid > 0 && (unsafe { libc::kill(pid, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM));
            if !alive {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    #[cfg(not(unix))]
    let _ = cwd;
}

/// A message the runtime was handed, until its turn ends.
struct Turn {
    /// The submission's id.
    id: String,
    taken: bool,
}

/// A command the model runs, from its `PreToolUse` hook to its `PostToolUse` hook.
struct Command {
    conversation: String,
    command: String,
    start_time: i64,
}

#[derive(Default)]
struct Shared {
    process: Option<Arc<Proc>>,
    bridge: Option<Bridge>,
    server: Option<Arc<HostServer>>,
    /// Grows with every process, so a late line from one that ended is ignored.
    generation: u64,
    /// The model and thinking level the running process was started with.
    started_with: (Option<String>, Option<String>),
    /// The runtime's id of the main conversation.
    conversation: Option<String>,
    /// Messages handed to the runtime whose turn has not ended, oldest first. It runs one turn per message.
    turns: VecDeque<Turn>,
    /// The model said its turn is over while background work still runs; the stream holds what follows until it ends.
    awaiting: bool,
    /// What the model says in the step being streamed, and that step.
    text: String,
    text_step: Option<i64>,
    /// Tool steps already recorded, and those whose result was.
    calls: HashSet<i64>,
    results: HashSet<i64>,
    /// Commands running, by tool call id.
    commands: BTreeMap<String, Command>,
    /// Subagents' conversations that have not stopped, with when they started.
    subagents: BTreeMap<String, i64>,
    model: Option<String>,
    thinking: Option<String>,
}

impl Shared {
    /// Forget the process: what it ran is gone with it.
    fn reset(&mut self) -> (Option<Arc<Proc>>, Option<Bridge>) {
        self.generation += 1;
        self.turns.clear();
        self.awaiting = false;
        self.text.clear();
        self.text_step = None;
        self.calls.clear();
        self.results.clear();
        self.commands.clear();
        self.subagents.clear();
        (self.process.take(), self.bridge.take())
    }
}

/// One Antigravity Session's runtime.
pub struct AntigravityDriver {
    options: AntigravityOptions,
    host: Arc<dyn ToolHost>,
    events: mpsc::UnboundedSender<DriverEvent>,
    shared: Arc<Mutex<Shared>>,
    starting: tokio::sync::Mutex<()>,
    weak: Weak<AntigravityDriver>,
}

fn lock(shared: &Mutex<Shared>) -> std::sync::MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

impl AntigravityDriver {
    /// A driver that reports to `events` and serves the model's tool calls from `host`.
    pub fn new(options: AntigravityOptions, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Arc<AntigravityDriver> {
        let shared = Shared { model: options.model.clone(), thinking: options.thinking.clone(), ..Default::default() };
        Arc::new_cyclic(|weak| AntigravityDriver {
            options,
            host,
            events,
            shared: Arc::new(Mutex::new(shared)),
            starting: tokio::sync::Mutex::new(()),
            weak: weak.clone(),
        })
    }

    fn emit(&self, event: DriverEvent) {
        let _ = self.events.send(event);
    }

    /// The runtime acts on the message whose turn runs: report it taken once.
    fn take_started(&self) {
        let taken = {
            let mut shared = lock(&self.shared);
            match shared.turns.front_mut() {
                Some(turn) if !turn.taken => {
                    turn.taken = true;
                    Some(turn.id.clone())
                }
                _ => None,
            }
        };
        if let Some(id) = taken {
            self.emit(DriverEvent::Taken(id));
        }
    }

    /// The host's server, started once per driver.
    async fn server(&self) -> Result<Arc<HostServer>, String> {
        if let Some(server) = lock(&self.shared).server.clone() {
            return Ok(server);
        }
        let weak = self.weak.clone();
        let on_call: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            if let Some(driver) = weak.upgrade() {
                driver.take_started();
            }
        });
        let weak = self.weak.clone();
        let on_hook: HookHandler = Arc::new(move |payload| {
            let weak = weak.clone();
            Box::pin(async move {
                match weak.upgrade() {
                    Some(driver) => driver.hook(payload).await,
                    None => json!({"decision": "deny", "reason": "The Session has ended"}),
                }
            })
        });
        let server = Arc::new(start_server(self.host.clone(), Some(on_call), Some(on_hook)).await?);
        lock(&self.shared).server = Some(server.clone());
        Ok(server)
    }

    /// The running process, starting one that continues `resume` when none runs. A process started with another model
    /// is replaced once it has no turn.
    async fn process(self: &Arc<Self>, resume: Option<String>) -> Result<Arc<Proc>, String> {
        let _one = self.starting.lock().await;
        let stale = {
            let mut shared = lock(&self.shared);
            let wanted = (shared.model.clone(), shared.thinking.clone());
            match shared.process.clone() {
                Some(process) if shared.started_with == wanted || !shared.turns.is_empty() => return Ok(process),
                Some(_) => Some(shared.reset()),
                None => None,
            }
        };
        if let Some((Some(process), bridge)) = stale {
            process.close(Duration::from_secs(5)).await;
            drop(bridge);
        }
        let server = self.server().await?;
        let mut options = self.options.clone();
        let resume = {
            let shared = lock(&self.shared);
            options.model = shared.model.clone();
            options.thinking = shared.thinking.clone();
            shared.conversation.clone().or(resume)
        };
        let bridge = Bridge::create(&options, &server, !self.host.specs().is_empty())?;
        let (process, lines) = Proc::spawn(&launch(&options, &bridge.dir, resume.as_deref()))?;
        let generation = {
            let mut shared = lock(&self.shared);
            shared.generation += 1;
            shared.process = Some(process.clone());
            shared.bridge = Some(bridge);
            shared.started_with = (options.model.clone(), options.thinking.clone());
            shared.generation
        };
        tokio::spawn(self.clone().read(lines, generation));
        Ok(process)
    }

    async fn read(self: Arc<Self>, mut lines: mpsc::UnboundedReceiver<Line>, generation: u64) {
        while let Some(line) = lines.recv().await {
            if lock(&self.shared).generation != generation {
                return;
            }
            match line {
                Line::Json(value) => self.handle(&value),
                Line::Exited(error) => {
                    let (awaited, _process, bridge) = {
                        let mut shared = lock(&self.shared);
                        let awaited = shared.awaiting || !shared.subagents.is_empty();
                        let (process, bridge) = shared.reset();
                        (awaited, process, bridge)
                    };
                    drop(bridge);
                    self.emit(DriverEvent::Exited { error, awaited });
                    return;
                }
            }
        }
    }

    fn handle(&self, line: &Value) {
        match line["event"].as_str().unwrap_or("") {
            "init" => {
                let Some(id) = line["conversation_id"].as_str().or(line["init"]["conversation_id"].as_str()) else { return };
                let changed = {
                    let mut shared = lock(&self.shared);
                    shared.conversation.as_deref() != Some(id) && {
                        shared.conversation = Some(id.to_string());
                        true
                    }
                };
                if changed {
                    self.emit(DriverEvent::SessionId(id.to_string()));
                }
            }
            "step_update" => self.step(&line["step_update"]),
            "result" => self.result(&line["result"]),
            _ => {}
        }
    }

    /// One step of the main conversation, begun or done.
    fn step(&self, step: &Value) {
        let index = step["step_index"].as_i64().unwrap_or(-1);
        let state = step["state"].as_str().unwrap_or("");
        let done = matches!(state, "DONE" | "ERROR" | "CANCELED" | "CANCELLED");
        let kind = step["step_type"].as_str().unwrap_or("");
        if matches!(kind, "user_input" | "agent_response" | "tool" | "subagent") {
            self.take_started();
        }
        let mut emitted = Vec::new();
        {
            let mut shared = lock(&self.shared);
            match kind {
                "agent_response" => {
                    if shared.text_step != Some(index) {
                        let said = std::mem::take(&mut shared.text);
                        if !said.trim().is_empty() {
                            emitted.push(Message { role: Role::Assistant, content: vec![Block::text(said.trim())], stop_reason: Some("stop".into()) });
                        }
                        shared.text_step = Some(index);
                    }
                    if let Some(delta) = step["text_delta"].as_str() {
                        shared.text.push_str(delta);
                    }
                    if done {
                        let said = std::mem::take(&mut shared.text);
                        shared.text_step = None;
                        if !said.trim().is_empty() {
                            emitted.push(Message { role: Role::Assistant, content: vec![Block::text(said.trim())], stop_reason: Some("stop".into()) });
                        }
                    }
                }
                "tool" | "subagent" => {
                    let info = if kind == "tool" { &step["tool_info"] } else { &step["subagent_info"] };
                    if shared.calls.insert(index) {
                        let name = step["tool_name"].as_str().or(info["name"].as_str()).unwrap_or(kind).to_string();
                        let arguments = if kind == "tool" { info["parameters"].clone() } else { info.clone() };
                        emitted.push(Message {
                            role: Role::Assistant,
                            content: vec![Block::ToolCall { id: format!("step-{index}"), name, arguments }],
                            stop_reason: Some("toolUse".into()),
                        });
                    }
                    if done && shared.results.insert(index) {
                        let text = info["output"]
                            .as_str()
                            .map(str::to_string)
                            .or_else(|| info["error"]["message"].as_str().map(str::to_string))
                            .unwrap_or_else(|| if kind == "subagent" { format!("subagent {}", state.to_lowercase()) } else { state.to_lowercase() });
                        emitted.push(Message { role: Role::ToolResult, content: vec![Block::text(clip(&text, 2000))], stop_reason: None });
                    }
                }
                _ => {}
            }
        }
        for message in emitted {
            self.emit(DriverEvent::Message(message));
        }
    }

    /// A turn ended: the oldest message's.
    fn result(&self, result: &Value) {
        let failed = result["status"] != "SUCCESS";
        let error = result["error"].as_str().filter(|error| !error.is_empty()).unwrap_or("Antigravity failed").to_string();
        let interrupted = result["finished_reason"] == "interrupted";
        let (turn, said, idle) = {
            let mut shared = lock(&self.shared);
            let said = std::mem::take(&mut shared.text);
            shared.text_step = None;
            shared.awaiting = false;
            // The turn ran to its end, background work included.
            let main = shared.conversation.clone();
            shared.commands.retain(|_, command| Some(&command.conversation) != main.as_ref());
            shared.subagents.clear();
            let turn = shared.turns.pop_front();
            (turn, said, shared.turns.is_empty())
        };
        let Some(turn) = turn else { return };
        if failed && !turn.taken {
            // The runtime refused the message before acting on it: it stays pending, and a new process tries again.
            let driver = self.weak.upgrade();
            tokio::spawn(async move {
                if let Some(driver) = driver {
                    driver.reset_broken(error).await;
                }
            });
            return;
        }
        if !turn.taken {
            self.emit(DriverEvent::Taken(turn.id.clone()));
        }
        if !said.trim().is_empty() {
            self.emit(DriverEvent::Message(Message { role: Role::Assistant, content: vec![Block::text(said.trim())], stop_reason: Some("stop".into()) }));
        }
        if failed {
            let stop = if interrupted { "aborted" } else { "error" };
            self.emit(DriverEvent::Message(Message { role: Role::Assistant, content: vec![Block::text(error)], stop_reason: Some(stop.into()) }));
        }
        if idle {
            self.emit(DriverEvent::Idle { awaiting_async: false });
        }
    }

    /// End a process that refused a message, and report its exit so the message stays pending.
    async fn reset_broken(&self, error: String) {
        let (process, bridge) = lock(&self.shared).reset();
        if let Some(process) = process {
            process.close(Duration::from_secs(3)).await;
        }
        drop(bridge);
        self.emit(DriverEvent::Exited { error: Some(error), awaited: false });
    }

    /// Answer a hook of the runtime.
    async fn hook(&self, payload: Value) -> Value {
        let conversation = payload["conversationId"].as_str().unwrap_or("").to_string();
        let main = {
            let mut shared = lock(&self.shared);
            if shared.conversation.is_none() && !conversation.is_empty() {
                shared.conversation = Some(conversation.clone());
            }
            shared.conversation.as_deref() == Some(conversation.as_str())
        };
        match payload["hookEventName"].as_str().unwrap_or("") {
            "PreInvocation" => {
                if main {
                    self.take_started();
                }
                json!({})
            }
            "PreToolUse" => {
                if main {
                    self.take_started();
                }
                let call = &payload["toolCall"];
                let tool = call["name"].as_str().unwrap_or("");
                let input = call.get("args").cloned().unwrap_or_else(|| json!({}));
                match self.judge(tool, &input).await {
                    Guard::Allow => {
                        let mut shared = lock(&self.shared);
                        if !main {
                            shared.subagents.entry(conversation.clone()).or_insert_with(now_ms);
                        }
                        if tool == "run_command" {
                            if let Some(id) = call["id"].as_str() {
                                let command = input["CommandLine"].as_str().unwrap_or("").to_string();
                                shared.commands.insert(id.to_string(), Command { conversation, command, start_time: now_ms() });
                            }
                        }
                        json!({"decision": "allow"})
                    }
                    Guard::Block(reason) => json!({"decision": "deny", "reason": reason}),
                }
            }
            "PostToolUse" => {
                if let Some(id) = payload["toolCall"]["id"].as_str() {
                    lock(&self.shared).commands.remove(id);
                }
                json!({})
            }
            "Stop" => {
                let backgrounded = {
                    let mut shared = lock(&self.shared);
                    if main {
                        let waiting = payload["fullyIdle"] == false && !shared.turns.is_empty();
                        let first = waiting && !shared.awaiting;
                        shared.awaiting = waiting;
                        first
                    } else {
                        shared.subagents.remove(&conversation);
                        false
                    }
                };
                // The stream shows nothing more until the background work ends, so the turn is reported over now.
                if backgrounded {
                    self.emit(DriverEvent::Idle { awaiting_async: true });
                }
                json!({})
            }
            _ => json!({}),
        }
    }

    /// Whether a tool call may run: the Session's tools, Neo's bridge left alone, then the guard.
    async fn judge(&self, tool: &str, input: &Value) -> Guard {
        if tool == "call_mcp_tool" {
            // The host's tools are judged by name where they run, in the MCP server.
            return if input["ServerName"].as_str() == Some(mcp_server_name().as_str()) {
                Guard::Allow
            } else {
                Guard::Block("Only Neo's application tools are available here".into())
            };
        }
        let (name, input) = host_view(tool, input);
        let allowed = |kind: &str| self.options.tools.iter().any(|known| known == kind);
        let permitted =
            if TOOL_KINDS.contains(&name.as_str()) { allowed(&name) } else { self.host.specs().iter().any(|spec| spec.name == name) || allowed("bash") };
        if !permitted {
            return Guard::Block("This Session cannot use that tool".into());
        }
        if matches!(name.as_str(), "edit" | "write") {
            let path = input["path"].as_str().unwrap_or("");
            if lock(&self.shared).bridge.as_ref().is_some_and(|bridge| bridge.holds(path)) {
                return Guard::Block("That folder is Neo's link to this runtime; leave it alone".into());
            }
        }
        self.host.guard(&name, &input).await
    }

    /// The message's text; images are saved in the bridge for the model to view.
    fn message_text(&self, content: &[Block]) -> String {
        let dir = lock(&self.shared).bridge.as_ref().map(|bridge| bridge.dir.join("images"));
        let mut parts = Vec::new();
        for block in content {
            match block {
                Block::Text { text } => parts.push(text.clone()),
                Block::Image { mime_type, data } => {
                    let extension = mime_type.rsplit('/').next().unwrap_or("png").replace("jpeg", "jpg");
                    let saved = dir.as_ref().and_then(|dir| {
                        let path = dir.join(format!("{}.{extension}", uuid()));
                        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).ok()?;
                        std::fs::create_dir_all(dir).ok()?;
                        std::fs::write(&path, bytes).ok()?;
                        Some(path)
                    });
                    parts.push(match saved {
                        Some(path) => format!("[Image attached at {}; look at it with view_file]", path.display()),
                        None => "[An image was attached but could not be saved]".into(),
                    });
                }
                Block::ToolCall { name, .. } => parts.push(format!("[tool call {name}]")),
            }
        }
        parts.join("\n\n")
    }

    fn current(&self) -> Option<Arc<Proc>> {
        lock(&self.shared).process.clone()
    }
}

/// Lets the driver be used through `Arc<dyn Driver>` while its methods need the `Arc` to spawn tasks.
pub struct Antigravity(pub Arc<AntigravityDriver>);

impl Driver for Antigravity {
    fn kernel(&self) -> &'static str {
        "antigravity"
    }
    fn submit<'a>(&'a self, id: &'a str, content: &'a [Block], _deliver: Deliver, resume: Option<String>) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            let process = self.0.process(resume).await?;
            let text = self.0.message_text(content);
            // The runtime runs one turn per message, in order: a message sent during a turn waits for it to end.
            lock(&self.0.shared).turns.push_back(Turn { id: id.to_string(), taken: false });
            self.0.emit(DriverEvent::Running);
            let sent = process.send(&json!({"event": "user", "message": {"content": text}})).await;
            if sent.is_err() {
                lock(&self.0.shared).turns.retain(|turn| turn.id != id);
            }
            sent
        })
    }
    fn interrupt(&self) -> BoxFut<'_, ()> {
        // The runtime has no way to cancel a turn but ending its process; the next message continues the conversation.
        Box::pin(async move {
            let (process, bridge, untaken, busy) = {
                let mut shared = lock(&self.0.shared);
                let untaken = shared.turns.iter().any(|turn| !turn.taken);
                let busy = !shared.turns.is_empty();
                let (process, bridge) = shared.reset();
                (process, bridge, untaken, busy)
            };
            if let Some(process) = process {
                process.close(Duration::from_secs(3)).await;
            }
            drop(bridge);
            if untaken {
                self.0.emit(DriverEvent::Exited { error: None, awaited: false });
            } else if busy {
                self.0.emit(DriverEvent::Message(Message {
                    role: Role::Assistant,
                    content: vec![Block::text("Interrupted")],
                    stop_reason: Some("aborted".into()),
                }));
                self.0.emit(DriverEvent::Idle { awaiting_async: false });
            }
        })
    }
    fn jobs(&self) -> BoxFut<'_, Vec<KernelJob>> {
        Box::pin(async move {
            let shared = lock(&self.0.shared);
            let main = shared.conversation.clone();
            let mut jobs: Vec<KernelJob> = shared
                .subagents
                .iter()
                .map(|(id, start)| KernelJob {
                    id: id.clone(),
                    kind: JobKind::Task,
                    label: "subagent".into(),
                    start_time: *start,
                    progress: None,
                    command: None,
                    own: true,
                    pids: Vec::new(),
                })
                .collect();
            // A command of the main conversation is a background job once the model ended its turn while it runs.
            jobs.extend(shared.commands.iter().filter(|(_, command)| Some(&command.conversation) != main.as_ref() || shared.awaiting).map(|(id, command)| {
                KernelJob {
                    id: id.clone(),
                    kind: JobKind::Bash,
                    label: command.command.clone(),
                    start_time: command.start_time,
                    progress: None,
                    command: Some(command.command.clone()),
                    own: Some(&command.conversation) == main.as_ref(),
                    pids: Vec::new(),
                }
            }));
            jobs
        })
    }
    fn acknowledge<'a>(&'a self, _ids: &'a [String]) -> BoxFut<'a, ()> {
        // The runtime wakes the model when its background work ends; nothing outside it can stop that.
        Box::pin(async {})
    }
    fn cancel<'a>(&'a self, _id: &'a str) -> BoxFut<'a, bool> {
        // Nor can one job be stopped from outside.
        Box::pin(async { false })
    }
    fn set_model<'a>(&'a self, model: Option<&'a str>, thinking: Option<&'a str>) -> BoxFut<'a, ()> {
        // The process takes them at its start; the next message starts one with them once no turn runs.
        Box::pin(async move {
            let mut shared = lock(&self.0.shared);
            shared.model = model.map(str::to_string);
            shared.thinking = thinking.map(str::to_string);
        })
    }
    fn pid(&self) -> Option<u32> {
        self.0.current().map(|process| process.pid())
    }
    fn close(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            let (process, bridge, _server) = {
                let mut shared = lock(&self.0.shared);
                let (process, bridge) = shared.reset();
                (process, bridge, shared.server.take())
            };
            if let Some(process) = process {
                process.close(Duration::from_secs(5)).await;
            }
            drop(bridge);
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_thinking_levels_to_efforts() {
        assert_eq!(effort_of(None), None);
        assert_eq!(effort_of(Some("auto")), None);
        assert_eq!(effort_of(Some("off")), Some("low"));
        assert_eq!(effort_of(Some("medium")), Some("medium"));
        assert_eq!(effort_of(Some("max")), Some("max"));
    }

    #[test]
    fn sees_runtime_tools_as_the_host_names_them() {
        assert_eq!(host_view("run_command", &json!({"CommandLine": "ls", "WaitMsBeforeAsync": 5000})), ("bash".into(), json!({"command": "ls"})));
        assert_eq!(host_view("write_file", &json!({"Path": "/w/a.txt", "Content": "x"})), ("write".into(), json!({"path": "/w/a.txt"})));
        assert_eq!(host_view("replace_file_content", &json!({"TargetFile": "/w/a"})), ("edit".into(), json!({"path": "/w/a"})));
        assert_eq!(host_view("read_file", &json!({})).0, "read");
        assert_eq!(host_view("invoke_subagent", &json!({})).0, "task");
        assert_eq!(host_view("read_url_content", &json!({})).0, "read_url_content");
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
    fn puts_the_bridge_after_the_working_directory_in_path_order() {
        for cwd in ["/w/ticket", "/w/a", "/w/zzz", "/"] {
            let cwd = Path::new(cwd);
            let bridge = bridge_dir(cwd, "abcd1234");
            assert!(cwd.as_os_str() < bridge.as_os_str(), "{bridge:?}");
            assert!(bridge.to_string_lossy().starts_with(&*cwd.to_string_lossy()));
        }
        assert_eq!(bridge_dir(Path::new("/w/ticket"), "x"), PathBuf::from("/w/ticket.neo-x"));
    }

    #[test]
    fn writes_the_agent_with_the_tools_of_its_kinds_and_its_prompt() {
        let options =
            AntigravityOptions { system_prompt: "Be brief.\n".into(), tools: vec!["read".into(), "bash".into(), "read".into()], ..Default::default() };
        let agent = agent_file(&options);
        assert!(agent.starts_with(&format!("---\nname: {AGENT}\n")), "{agent}");
        assert!(agent.contains("plugins:\n  - neo\n"), "{agent}");
        assert!(agent.contains("tools: [view_file, list_dir, grep_search, find_by_name, run_command,"), "{agent}");
        assert!(!agent.contains("write_to_file"));
        assert!(agent.ends_with("---\nBe brief.\n"), "{agent}");
    }

    #[test]
    fn hooks_every_tool_call_and_the_ends_of_turns() {
        let hooks = hooks_file("relay");
        assert_eq!(hooks["neo"]["PreToolUse"][0]["matcher"], "*");
        assert_eq!(hooks["neo"]["PreToolUse"][0]["hooks"][0]["command"], "relay");
        assert_eq!(hooks["neo"]["Stop"][0]["command"], "relay");
        assert_eq!(hooks["neo"]["PreInvocation"][0]["command"], "relay");
    }

    #[cfg(unix)]
    #[test]
    fn quotes_the_relay_for_the_shell() {
        assert_eq!(shell_command(&["/a b/neo-agent".into(), "agy-hook".into(), "it's".into()]), "'/a b/neo-agent' 'agy-hook' 'it'\\''s'");
    }

    #[test]
    fn builds_the_command_line() {
        let options =
            AntigravityOptions { program: "agy".into(), cwd: "/w".into(), model: Some("gemini-x".into()), thinking: Some("high".into()), ..Default::default() };
        let args = launch(&options, Path::new("/w.neo-1"), Some("c-1")).args;
        let after = |flag: &str| args.iter().position(|arg| arg == flag).map(|index| args[index + 1].clone());
        assert_eq!(after("--add-dir").as_deref(), Some("/w.neo-1"));
        assert_eq!(after("--agent").as_deref(), Some(AGENT));
        assert_eq!(after("--model").as_deref(), Some("gemini-x"));
        assert_eq!(after("--effort").as_deref(), Some("high"));
        assert_eq!(after("--conversation").as_deref(), Some("c-1"));
        assert_eq!(after("--settings").as_deref(), Some(r#"{"agentMode":"","permissions":{"allow":["mcp(neo_neo/*)"]},"toolPermission":"always-proceed"}"#));
        assert_eq!(args.last().map(String::as_str), Some("-p="));
        assert!(args.contains(&"--disable-slash-commands".to_string()));
        assert!(!launch(&AntigravityOptions::default(), Path::new("/b"), None).args.iter().any(|arg| arg == "--conversation" || arg == "--model"));
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
                if input["text"] == "no" || input["command"].as_str().is_some_and(|command| command.contains("forbidden")) {
                    Guard::Block("refused".into())
                } else {
                    Guard::Allow
                }
            })
        }
    }

    async fn post(url: &str, token: Option<&str>, body: &Value) -> (u16, Option<Value>) {
        let rest = url.trim_start_matches("http://");
        let (address, path) = rest.split_once('/').map(|(address, path)| (address.to_string(), format!("/{path}"))).unwrap();
        let mut stream = TcpStream::connect(address).await.unwrap();
        let body = serde_json::to_vec(body).unwrap();
        let auth = token.map(|token| format!("Authorization: Bearer {token}\r\n")).unwrap_or_default();
        let head = format!("POST {path} HTTP/1.1\r\nHost: x\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
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
        let server = start_server(Arc::new(Echo), None, None).await.unwrap();
        let url = server.mcp_url();
        let (status, _) = post(&url, Some("wrong"), &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})).await;
        assert_eq!(status, 401);
        let (_, listed) = post(&url, Some(&server.token), &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})).await;
        assert_eq!(listed.unwrap()["result"]["tools"][0]["name"], "echo");
        assert_eq!(post(&url, Some(&server.token), &json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).await, (202, None));
        let call = |text: &str| json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "echo", "arguments": {"text": text, "toolSummary": "s"}}});
        let (_, called) = post(&url, Some(&server.token), &call("hi")).await;
        assert_eq!(called.unwrap()["result"]["content"][0]["text"], json!({"text": "hi"}).to_string());
        let (_, blocked) = post(&url, Some(&server.token), &call("no")).await;
        assert_eq!(blocked.unwrap()["result"], json!({"isError": true, "content": [{"type": "text", "text": "refused"}]}));
        // The hooks' endpoint is the token's own path.
        let (status, _) = post(&format!("http://127.0.0.1:{}/hook/wrong", server.port), None, &json!({})).await;
        assert_eq!(status, 401);
    }

    #[tokio::test]
    async fn relays_a_hook_and_fails_when_the_host_is_gone() {
        let on_hook: HookHandler = Arc::new(|payload| Box::pin(async move { json!({"decision": "deny", "reason": payload["toolCall"]["name"]}) }));
        let server = start_server(Arc::new(Echo), None, Some(on_hook)).await.unwrap();
        let url = server.hook_url();
        let relayed = tokio::task::spawn_blocking(move || {
            let mut output = Vec::new();
            relay_hook(&url, &mut &br#"{"toolCall": {"name": "run_command"}}"#[..], &mut output).map(|_| output)
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&relayed).unwrap(), json!({"decision": "deny", "reason": "run_command"}));
        let wrong = format!("http://127.0.0.1:{}/hook/wrong", server.port);
        let refused = tokio::task::spawn_blocking(move || relay_hook(&wrong, &mut &b"{}"[..], &mut Vec::new())).await.unwrap();
        assert!(refused.unwrap_err().contains("401"));
        drop(server);
        assert!(relay_hook("http://127.0.0.1:1/hook/x", &mut &b"{}"[..], &mut Vec::new()).is_err());
    }

    #[cfg(unix)]
    mod lifecycle {
        use super::*;
        use crate::journal::Journal;
        use crate::session::{Mode, Presentation, Session};
        use crate::types::KernelEvent;
        use std::os::unix::fs::PermissionsExt;

        /// A stand-in for `agy`: it reads the bridge the driver wrote, calls hooks and the MCP server as the runtime
        /// would, and writes stream-json lines.
        const FAKE_AGY: &str = r#"#!/usr/bin/env python3
import json, sys, os, subprocess, urllib.request, glob, re
args = sys.argv[1:]
bridge = args[args.index("--add-dir") + 1]
conv = args[args.index("--conversation") + 1] if "--conversation" in args else "conv-1"
plugin = os.path.join(bridge, ".agents", "plugins", "neo")
hooks = json.load(open(os.path.join(plugin, "hooks.json")))["neo"]
mcp = json.load(open(os.path.join(plugin, "mcp_config.json")))["mcpServers"].get("neo")
agent = open(os.path.join(bridge, ".agents", "agents", "neo-session.md")).read()
def out(event, body):
    sys.stdout.write(json.dumps({"event": event, event: dict(body, conversation_id=conv)}) + "\n"); sys.stdout.flush()
def hook(name, payload):
    handler = hooks[name][0]["hooks"][0] if name in ("PreToolUse", "PostToolUse") else hooks[name][0]
    payload = dict(payload, hookEventName=name, conversationId=payload.get("conversationId", conv))
    done = subprocess.run(handler["command"], shell=True, input=json.dumps(payload).encode(), capture_output=True)
    if done.returncode != 0: return {"decision": "deny", "reason": "hook failed"}
    return json.loads(done.stdout or b"{}")
def mcp_call(name, arguments):
    req = urllib.request.Request(mcp["url"], data=json.dumps({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": name, "arguments": arguments}}).encode(), headers=mcp["headers"], method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=5).read())["result"]["content"][0]["text"]
sys.stdout.write(json.dumps({"event": "init", "conversation_id": conv, "init": {"agent": "neo-session"}}) + "\n"); sys.stdout.flush()
step = 0
def next_step():
    global step
    step += 1
    return step
for raw in sys.stdin:
    text = json.loads(raw)["message"]["content"]
    if "refuse" in text:
        out("result", {"status": "ERROR", "error": "agent refused to start", "num_turns": 0})
        continue
    out("step_update", {"step_index": next_step(), "state": "DONE", "step_type": "user_input"})
    if "prompt?" in text:
        out("step_update", {"step_index": next_step(), "state": "DONE", "step_type": "agent_response", "text_delta": "prompt says: " + agent.split("---\n")[-1].strip()})
    if "tool" in text:
        hook("PreInvocation", {})
        decision = hook("PreToolUse", {"toolCall": {"id": "c1", "name": "call_mcp_tool", "args": {"ServerName": "neo_neo", "ToolName": "echo", "Arguments": {"text": "ok"}}}})
        i = next_step()
        out("step_update", {"step_index": i, "state": "ACTIVE", "step_type": "tool", "tool_name": "call_mcp_tool", "tool_info": {"name": "call_mcp_tool", "parameters": {"ToolName": "echo"}}})
        result = mcp_call("echo", {"text": "ok", "toolSummary": "x"}) if decision.get("decision") == "allow" else decision.get("reason")
        out("step_update", {"step_index": i, "state": "DONE", "step_type": "tool", "tool_name": "call_mcp_tool", "tool_info": {"name": "call_mcp_tool", "parameters": {"ToolName": "echo"}, "output": result}})
        hook("PostToolUse", {"toolCall": {"id": "c1", "name": "call_mcp_tool"}})
    if "forbidden" in text:
        decision = hook("PreToolUse", {"toolCall": {"id": "c2", "name": "run_command", "args": {"CommandLine": "forbidden"}}})
        i = next_step()
        out("step_update", {"step_index": i, "state": "ERROR", "step_type": "tool", "tool_name": "run_command", "tool_info": {"name": "run_command", "parameters": {"CommandLine": "forbidden"}, "error": {"message": "denied: " + decision.get("reason", "")}}})
    if "bridge" in text:
        decision = hook("PreToolUse", {"toolCall": {"id": "c3", "name": "write_to_file", "args": {"TargetFile": os.path.join(bridge, "x")}}})
        out("step_update", {"step_index": next_step(), "state": "DONE", "step_type": "agent_response", "text_delta": decision["decision"] + ": " + decision.get("reason", "")})
    if "background" in text:
        hook("PreToolUse", {"toolCall": {"id": "bg1", "name": "run_command", "args": {"CommandLine": "sleep 1"}}})
        hook("Stop", {"fullyIdle": False})
        open(os.path.join(bridge, "..", "bg-waiting"), "w").write("1")
        import time
        while not os.path.exists(os.path.join(bridge, "..", "bg-release")): time.sleep(0.05)
        hook("PostToolUse", {"toolCall": {"id": "bg1", "name": "run_command"}})
        hook("Stop", {"fullyIdle": True})
        out("step_update", {"step_index": next_step(), "state": "DONE", "step_type": "agent_response", "text_delta": "background done"})
    out("step_update", {"step_index": next_step(), "state": "ACTIVE", "step_type": "agent_response", "text_delta": "Done "})
    out("step_update", {"step_index": step, "state": "DONE", "step_type": "agent_response", "text_delta": text[:12]})
    out("result", {"status": "SUCCESS", "response": "", "num_turns": 1})
"#;

        /// A hook relay in Python, standing in for `neo-agent agy-hook`.
        const RELAY: &str = r#"#!/usr/bin/env python3
import sys, urllib.request
req = urllib.request.Request(sys.argv[1], data=sys.stdin.buffer.read(), headers={"Content-Type": "application/json"}, method="POST")
sys.stdout.write(urllib.request.urlopen(req, timeout=30).read().decode())
"#;

        fn script(dir: &Path, name: &str, text: &str) -> PathBuf {
            let path = dir.join(name);
            std::fs::write(&path, text).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        struct Fixture {
            dir: PathBuf,
            session: Arc<Session>,
            events: tokio::sync::broadcast::Receiver<KernelEvent>,
            driver: Arc<AntigravityDriver>,
        }

        fn fixture() -> Fixture {
            let dir = std::env::temp_dir().join(format!("neo-agy-test-{}-{}", std::process::id(), uuid()));
            let cwd = dir.join("work");
            std::fs::create_dir_all(&cwd).unwrap();
            let program = script(&dir, "fake-agy.py", FAKE_AGY);
            let relay = script(&dir, "relay.py", RELAY);
            let journal = Arc::new(Journal::create(&dir, &cwd).unwrap());
            let options = AntigravityOptions {
                program,
                cwd,
                system_prompt: "You are the fixture.".into(),
                tools: vec!["read".into(), "bash".into(), "write".into()],
                hook_relay: vec![relay.display().to_string()],
                ..Default::default()
            };
            let (reports, runtime) = mpsc::unbounded_channel();
            let driver = AntigravityDriver::new(options, Arc::new(Echo), reports);
            let session = Session::new(journal, Arc::new(Antigravity(driver.clone())), runtime);
            let events = session.subscribe();
            Fixture { dir, session, events, driver }
        }

        impl Fixture {
            async fn turn(&mut self) -> Vec<KernelEvent> {
                let mut seen = Vec::new();
                loop {
                    let event = tokio::time::timeout(Duration::from_secs(20), self.events.recv()).await.expect("the turn ends").unwrap();
                    let done = matches!(event, KernelEvent::AgentEnd { .. });
                    seen.push(event);
                    if done {
                        return seen;
                    }
                }
            }
            async fn send(&self, id: &str, text: &str) {
                self.session.send(id, vec![Block::text(text)], Mode::Queue, &Presentation::default(), &[]).await.unwrap();
            }
            fn said(&self) -> Vec<String> {
                self.session
                    .journal()
                    .entries()
                    .iter()
                    .filter_map(|entry| match entry {
                        crate::journal::Entry::Message { message, .. } => Some(crate::types::text_of(&message.content)),
                        _ => None,
                    })
                    .collect()
            }
        }

        #[tokio::test]
        async fn runs_turns_with_host_tools_hooks_and_the_agent_prompt() {
            let mut f = fixture();
            f.send("r1", "prompt? and tool").await;
            let seen = f.turn().await;
            assert!(seen.contains(&KernelEvent::Taken { request_ids: vec!["r1".into()] }), "{seen:?}");
            assert_eq!(seen.last(), Some(&KernelEvent::AgentEnd { terminal: true, awaiting_async: false }));
            assert!(f.session.journal().pending().is_empty());
            assert_eq!(f.session.journal().kernel_session("antigravity").as_deref(), Some("conv-1"));
            let said = f.said();
            assert!(said.iter().any(|text| text == "prompt says: You are the fixture."), "{said:?}");
            assert!(said.iter().any(|text| text == r#"{"text":"ok"}"#), "the host tool ran without display arguments: {said:?}");
            assert!(said.iter().any(|text| text == "Done prompt? and"), "{said:?}");

            // A refused command reaches the model with the guard's reason, and the turn goes on.
            f.send("r2", "forbidden").await;
            f.turn().await;
            assert!(f.said().iter().any(|text| text == "denied: refused"), "{:?}", f.said());

            // Neo's bridge is not the model's to change.
            f.send("r3", "bridge").await;
            f.turn().await;
            assert!(f.said().iter().any(|text| text.starts_with("deny: That folder is Neo's link")), "{:?}", f.said());

            // Two messages sent together run as two turns, in order.
            f.send("r4", "first").await;
            f.send("r5", "second").await;
            let mut seen = f.turn().await;
            if !seen.iter().any(|event| matches!(event, KernelEvent::Taken { request_ids } if request_ids == &["r5".to_string()])) {
                seen.extend(f.turn().await);
            }
            assert!(seen.iter().any(|event| matches!(event, KernelEvent::Taken { request_ids } if request_ids == &["r5".to_string()])), "{seen:?}");
            assert!(f.said().iter().any(|text| text == "Done second"), "{:?}", f.said());
            assert!(f.session.journal().pending().is_empty());

            let bridge = lock(&f.driver.shared).bridge.as_ref().map(|bridge| bridge.dir.clone()).unwrap();
            assert!(bridge.join(".agents/plugins/neo/hooks.json").is_file());
            f.session.dispose().await;
            assert!(!bridge.exists(), "the bridge goes with the process");
            let _ = std::fs::remove_dir_all(&f.dir);
        }

        #[tokio::test]
        async fn ends_the_turn_while_background_work_runs_and_lists_it() {
            let mut f = fixture();
            f.send("r1", "background").await;
            let seen = f.turn().await;
            assert_eq!(seen.last(), Some(&KernelEvent::AgentEnd { terminal: false, awaiting_async: true }), "{seen:?}");
            let jobs = f.session.driver().jobs().await;
            assert_eq!(jobs.len(), 1, "{jobs:?}");
            assert_eq!((jobs[0].kind, jobs[0].command.as_deref(), jobs[0].own), (JobKind::Bash, Some("sleep 1"), true));
            std::fs::write(f.dir.join("bg-release"), "1").unwrap();
            let seen = f.turn().await;
            assert_eq!(seen.last(), Some(&KernelEvent::AgentEnd { terminal: true, awaiting_async: false }), "{seen:?}");
            assert!(f.session.driver().jobs().await.is_empty());
            assert!(f.said().iter().any(|text| text == "background done"), "{:?}", f.said());
            f.session.dispose().await;
            let _ = std::fs::remove_dir_all(&f.dir);
        }

        #[tokio::test]
        async fn keeps_a_message_the_runtime_refused_pending() {
            let mut f = fixture();
            f.send("r1", "refuse").await;
            let seen = f.turn().await;
            assert!(!seen.iter().any(|event| matches!(event, KernelEvent::Taken { .. })), "{seen:?}");
            assert_eq!(f.session.journal().pending().len(), 1);
            assert!(f.said().iter().any(|text| text.contains("agent refused to start")), "{:?}", f.said());
            f.session.dispose().await;
            let _ = std::fs::remove_dir_all(&f.dir);
        }
    }
}
