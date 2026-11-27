use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

pub(crate) const BLOCKED_ENV_VARS: &[&str] = &[
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "LD_DEBUG",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
];

const STDERR_RING_CAP: usize = 64;
const NOISE_RING_CAP: usize = 32;
const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct StdioMcpClient {
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: AtomicU64,
    pending: PendingMap,
    stderr_ring: Arc<Mutex<VecDeque<String>>>,
    noise_ring: Arc<Mutex<VecDeque<String>>>,
    child: Mutex<Child>,
    alive: Arc<AtomicBool>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    protocol_version: String,
    server_info: Value,
    server_capabilities: Value,
}

impl StdioMcpClient {
    pub async fn connect(
        program: &str,
        args: &[String],
        env: &BTreeMap<String, String>,
        cwd: Option<&Path>,
        init_timeout: Duration,
    ) -> Result<Self, String> {
        if program.trim().is_empty() || program.contains('\0') {
            return Err("invalid empty stdio MCP command".to_string());
        }

        let mut cmd = build_stdio_command(program, args);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(dir) = cwd {
            if dir.is_dir() {
                cmd.current_dir(dir);
            }
        }

        for blocked in BLOCKED_ENV_VARS {
            cmd.env_remove(blocked);
        }

        #[cfg(not(windows))]
        {
            let enriched_path = build_enriched_unix_path(
                std::env::var("PATH").ok().as_deref(),
                crate::enroll::user_home_dir().ok().as_deref(),
            );
            cmd.env("PATH", enriched_path);
        }

        for (k, v) in env {
            if k.is_empty()
                || k.contains('\0')
                || v.contains('\0')
                || is_blocked_env_var(k)
            {
                continue;
            }
            cmd.env(k, v);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn stdio MCP '{program}': {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "stdio MCP child missing stdin pipe".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "stdio MCP child missing stdout pipe".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "stdio MCP child missing stderr pipe".to_string())?;

        let stdin = Arc::new(Mutex::new(stdin));
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let stderr_ring = Arc::new(Mutex::new(VecDeque::<String>::with_capacity(STDERR_RING_CAP)));
        let noise_ring = Arc::new(Mutex::new(VecDeque::<String>::with_capacity(NOISE_RING_CAP)));
        let alive = Arc::new(AtomicBool::new(true));

        let stderr_task = {
            let ring = Arc::clone(&stderr_ring);
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match read_line_capped(&mut reader, &mut buf, 64 * 1024).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let line = String::from_utf8_lossy(&buf)
                                .trim_end_matches(['\r', '\n'])
                                .to_string();
                            if !line.is_empty() {
                                push_bounded(&ring, STDERR_RING_CAP, line).await;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
        };

        let stdout_task = {
            let pending = Arc::clone(&pending);
            let noise_ring = Arc::clone(&noise_ring);
            let stderr_ring = Arc::clone(&stderr_ring);
            let stdin_for_reply = Arc::clone(&stdin);
            let alive = Arc::clone(&alive);
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match read_line_capped(&mut reader, &mut buf, MAX_LINE_BYTES).await {
                        Ok(0) => break,
                        Ok(_) => {
                            let line = trim_line_bytes(&buf);
                            if line.is_empty() {
                                continue;
                            }
                            let parsed: Value = match serde_json::from_slice(line) {
                                Ok(v) => v,
                                Err(_) => {
                                    let preview = truncate_diag_line(
                                        &String::from_utf8_lossy(line),
                                        256,
                                    );
                                    push_bounded(&noise_ring, NOISE_RING_CAP, preview).await;
                                    continue;
                                }
                            };

                            if let Some(arr) = parsed.as_array() {
                                for item in arr {
                                    handle_incoming_jsonrpc(
                                        item,
                                        &pending,
                                        &stdin_for_reply,
                                        &noise_ring,
                                    )
                                    .await;
                                }
                            } else {
                                handle_incoming_jsonrpc(
                                    &parsed,
                                    &pending,
                                    &stdin_for_reply,
                                    &noise_ring,
                                )
                                .await;
                            }
                        }
                        Err(e) => {
                            push_bounded(
                                &noise_ring,
                                NOISE_RING_CAP,
                                format!("stdout read error: {e}"),
                            )
                            .await;
                            break;
                        }
                    }
                }

                alive.store(false, Ordering::SeqCst);
                let diag = format_diagnostics(&stderr_ring, &noise_ring).await;
                let mut map = pending.lock().await;
                for (_, tx) in map.drain() {
                    let msg = if diag.is_empty() {
                        "stdio MCP process exited before replying".to_string()
                    } else {
                        format!("stdio MCP process exited before replying ({diag})")
                    };
                    let _ = tx.send(Err(msg));
                }
            })
        };

        let mut client = Self {
            stdin,
            next_id: AtomicU64::new(1),
            pending,
            stderr_ring,
            noise_ring,
            child: Mutex::new(child),
            alive,
            tasks: Mutex::new(vec![stdout_task, stderr_task]),
            protocol_version: MCP_PROTOCOL_VERSION.to_string(),
            server_info: Value::Null,
            server_capabilities: json!({}),
        };

        let init_res = client
            .request(
                "initialize",
                json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "neo-agent-os",
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
                init_timeout,
            )
            .await;

        let init_val = match init_res {
            Ok(v) => v,
            Err(e) => {
                client.shutdown().await;
                return Err(format!("stdio MCP initialize failed: {e}"));
            }
        };

        if let Some(pv) = init_val.get("protocolVersion").and_then(|v| v.as_str()) {
            client.protocol_version = pv.to_string();
        }
        client.server_info = init_val.get("serverInfo").cloned().unwrap_or(Value::Null);
        client.server_capabilities = init_val
            .get("capabilities")
            .cloned()
            .unwrap_or_else(|| json!({}));

        // Best-effort notifications/initialized
        let _ = client
            .notify("notifications/initialized", None)
            .await;

        Ok(client)
    }

    pub fn protocol_version(&self) -> &str {
        &self.protocol_version
    }

    pub fn server_info(&self) -> Value {
        self.server_info.clone()
    }

    pub fn server_capabilities(&self) -> &Value {
        &self.server_capabilities
    }

    pub async fn is_alive(&self) -> bool {
        if !self.alive.load(Ordering::SeqCst) {
            return false;
        }
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(None) => true,
            _ => {
                self.alive.store(false, Ordering::SeqCst);
                false
            }
        }
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            self.pending.lock().await.insert(id, tx);
        }

        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        if let Err(e) = write_ndjson(&self.stdin, &req).await {
            self.pending.lock().await.remove(&id);
            let diag = format_diagnostics(&self.stderr_ring, &self.noise_ring).await;
            return Err(if diag.is_empty() {
                format!("stdio MCP write failed: {e}")
            } else {
                format!("stdio MCP write failed: {e} ({diag})")
            });
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => {
                let diag = format_diagnostics(&self.stderr_ring, &self.noise_ring).await;
                Err(if diag.is_empty() {
                    format!("stdio MCP channel closed while awaiting '{method}'")
                } else {
                    format!("stdio MCP channel closed while awaiting '{method}' ({diag})")
                })
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                let _ = self
                    .notify(
                        "notifications/cancelled",
                        Some(json!({
                            "requestId": id,
                            "reason": "timeout",
                        })),
                    )
                    .await;
                let diag = format_diagnostics(&self.stderr_ring, &self.noise_ring).await;
                Err(if diag.is_empty() {
                    format!(
                        "stdio MCP request '{method}' timed out after {}ms",
                        timeout.as_millis()
                    )
                } else {
                    format!(
                        "stdio MCP request '{method}' timed out after {}ms ({diag})",
                        timeout.as_millis()
                    )
                })
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let payload = match params {
            Some(p) => json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": p,
            }),
            None => json!({
                "jsonrpc": "2.0",
                "method": method,
            }),
        };
        write_ndjson(&self.stdin, &payload).await
    }

    #[cfg(test)]
    pub async fn recent_noise(&self) -> Vec<String> {
        self.noise_ring.lock().await.iter().cloned().collect()
    }

    #[cfg(test)]
    pub async fn recent_stderr(&self) -> Vec<String> {
        self.stderr_ring.lock().await.iter().cloned().collect()
    }

    pub async fn shutdown(&self) {
        self.alive.store(false, Ordering::SeqCst);
        {
            let mut stdin = self.stdin.lock().await;
            let _ = stdin.shutdown().await;
        }
        {
            let mut child = self.child.lock().await;
            let _ = child.kill().await;
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
        {
            let mut tasks = self.tasks.lock().await;
            for handle in tasks.drain(..) {
                handle.abort();
            }
        }
        let mut map = self.pending.lock().await;
        for (_, tx) in map.drain() {
            let _ = tx.send(Err("stdio MCP session shut down".to_string()));
        }
    }
}

pub(crate) fn is_blocked_env_var(key: &str) -> bool {
    BLOCKED_ENV_VARS
        .iter()
        .any(|blocked| blocked.eq_ignore_ascii_case(key))
}

#[cfg(target_os = "windows")]
fn build_stdio_command(program: &str, args: &[String]) -> Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let lower = program.to_ascii_lowercase();
    let base = Path::new(program)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(program)
        .to_ascii_lowercase();
    let needs_cmd_shim = lower.ends_with(".cmd")
        || lower.ends_with(".bat")
        || matches!(
            base.as_str(),
            "npx" | "npm" | "pnpm" | "yarn" | "uvx" | "bunx"
        );
    let mut cmd = if needs_cmd_shim {
        let mut c = Command::new("cmd.exe");
        c.arg("/C").arg(program).args(args);
        c
    } else {
        let mut c = Command::new(program);
        c.args(args);
        c
    };
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn build_stdio_command(program: &str, args: &[String]) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd
}

#[cfg(not(windows))]
pub(crate) fn build_enriched_unix_path(existing: Option<&str>, home: Option<&Path>) -> String {
    let mut entries: Vec<String> = Vec::new();
    let mut push_unique = |p: String| {
        if !p.is_empty() && !entries.iter().any(|e| e == &p) {
            entries.push(p);
        }
    };

    if let Some(cur) = existing {
        for part in cur.split(':') {
            push_unique(part.to_string());
        }
    }

    for sys in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ] {
        push_unique(sys.to_string());
    }

    if let Some(h) = home {
        for rel in [
            ".local/bin",
            ".bun/bin",
            ".cargo/bin",
            ".volta/bin",
            ".fnm/current/bin",
            ".asdf/shims",
            ".mise/shims",
        ] {
            let candidate = h.join(rel);
            if candidate.is_dir() {
                push_unique(candidate.to_string_lossy().into_owned());
            }
        }
        // Pick the latest installed nvm node version bin if present.
        let nvm_versions = h.join(".nvm/versions/node");
        if let Ok(read_dir) = std::fs::read_dir(&nvm_versions) {
            let mut dirs: Vec<PathBuf> = read_dir
                .filter_map(|e| e.ok().map(|ent| ent.path()))
                .filter(|p| p.join("bin").is_dir())
                .collect();
            dirs.sort();
            if let Some(latest) = dirs.last() {
                push_unique(latest.join("bin").to_string_lossy().into_owned());
            }
        }
    }

    entries.join(":")
}

async fn write_ndjson(stdin: &Arc<Mutex<ChildStdin>>, payload: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(payload).map_err(|e| format!("JSON serialize error: {e}"))?;
    bytes.push(b'\n');
    let mut guard = stdin.lock().await;
    guard
        .write_all(&bytes)
        .await
        .map_err(|e| format!("stdin write error: {e}"))?;
    guard
        .flush()
        .await
        .map_err(|e| format!("stdin flush error: {e}"))?;
    Ok(())
}

async fn handle_incoming_jsonrpc(
    val: &Value,
    pending: &PendingMap,
    stdin: &Arc<Mutex<ChildStdin>>,
    noise_ring: &Arc<Mutex<VecDeque<String>>>,
) {
    let Some(obj) = val.as_object() else {
        push_bounded(
            noise_ring,
            NOISE_RING_CAP,
            truncate_diag_line(&val.to_string(), 256),
        )
        .await;
        return;
    };

    // Server-to-client request (has both method and id)
    if let (Some(method), Some(id_val)) = (
        obj.get("method").and_then(|m| m.as_str()),
        obj.get("id").filter(|id| !id.is_null()),
    ) {
        let reply = if method == "ping" {
            json!({
                "jsonrpc": "2.0",
                "id": id_val,
                "result": {}
            })
        } else {
            json!({
                "jsonrpc": "2.0",
                "id": id_val,
                "error": {
                    "code": -32601,
                    "message": format!("client method '{method}' not supported")
                }
            })
        };
        let _ = write_ndjson(stdin, &reply).await;
        return;
    }

    // Response matching a pending request ID
    if let Some(id) = extract_jsonrpc_u64_id(obj.get("id")) {
        let tx = pending.lock().await.remove(&id);
        if let Some(tx) = tx {
            if let Some(err) = obj.get("error").filter(|e| !e.is_null()) {
                let _ = tx.send(Err(format_jsonrpc_error(err)));
            } else {
                let result = obj.get("result").cloned().unwrap_or(Value::Null);
                let _ = tx.send(Ok(result));
            }
        }
    }
}

pub(crate) fn extract_jsonrpc_u64_id(val: Option<&Value>) -> Option<u64> {
    let v = val?;
    if let Some(u) = v.as_u64() {
        return Some(u);
    }
    if let Some(s) = v.as_str() {
        return s.parse::<u64>().ok();
    }
    None
}

pub(crate) fn format_jsonrpc_error(err: &Value) -> String {
    let code = err.get("code").and_then(|c| c.as_i64());
    let msg = err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("JSON-RPC error");
    match code {
        Some(c) => format!("JSON-RPC error {c}: {msg}"),
        None => msg.to_string(),
    }
}

async fn read_line_capped<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    out: &mut Vec<u8>,
    max_bytes: usize,
) -> std::io::Result<usize> {
    let mut total = 0usize;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(total);
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            let take = pos + 1;
            let room = max_bytes.saturating_sub(out.len());
            if room > 0 {
                let copy_len = take.min(room);
                out.extend_from_slice(&available[..copy_len]);
            }
            reader.consume(take);
            total += take;
            return Ok(total);
        } else {
            let len = available.len();
            let room = max_bytes.saturating_sub(out.len());
            if room > 0 {
                let copy_len = len.min(room);
                out.extend_from_slice(&available[..copy_len]);
            }
            reader.consume(len);
            total += len;
        }
    }
}

fn trim_line_bytes(mut line: &[u8]) -> &[u8] {
    while let Some(&b) = line.last() {
        if b == b'\n' || b == b'\r' || b == b' ' || b == b'\t' {
            line = &line[..line.len() - 1];
        } else {
            break;
        }
    }
    while let Some(&b) = line.first() {
        if b == b' ' || b == b'\t' {
            line = &line[1..];
        } else {
            break;
        }
    }
    line
}

fn truncate_diag_line(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max_chars).collect();
        out.push_str("...");
        out
    }
}

async fn push_bounded(ring: &Arc<Mutex<VecDeque<String>>>, cap: usize, line: String) {
    let mut guard = ring.lock().await;
    if guard.len() >= cap {
        guard.pop_front();
    }
    guard.push_back(line);
}

async fn format_diagnostics(
    stderr_ring: &Arc<Mutex<VecDeque<String>>>,
    noise_ring: &Arc<Mutex<VecDeque<String>>>,
) -> String {
    let stderr_tail: Vec<String> = {
        let guard = stderr_ring.lock().await;
        guard.iter().rev().take(4).cloned().collect::<Vec<_>>().into_iter().rev().collect()
    };
    if !stderr_tail.is_empty() {
        return format!("stderr: {}", stderr_tail.join(" | "));
    }
    let noise_tail: Vec<String> = {
        let guard = noise_ring.lock().await;
        guard.iter().rev().take(2).cloned().collect::<Vec<_>>().into_iter().rev().collect()
    };
    if !noise_tail.is_empty() {
        return format!("stdout noise: {}", noise_tail.join(" | "));
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOCK_STDIO_MCP_PY: &str = r#"
import sys, json, time, os

print("noisy startup banner on stdout", flush=True)
print("mock mcp booting on stderr", file=sys.stderr, flush=True)

cancelled = []

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") or {}

    if method == "initialize":
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2025-06-18",
                "serverInfo": {"name": "mock-stdio-mcp", "version": "1.0.0"},
                "capabilities": {"tools": {}, "resources": {}, "prompts": {}}
            }
        }
        print(json.dumps(resp), flush=True)
    elif method == "notifications/initialized":
        continue
    elif method == "notifications/cancelled":
        cancelled.append(params.get("requestId"))
        continue
    elif method == "tools/list":
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "echo_env",
                        "description": "Echoes message and env check",
                        "inputSchema": {"type": "object", "properties": {"msg": {"type": "string"}}},
                        "annotations": {"readOnlyHint": True, "destructiveHint": False}
                    }
                ]
            }
        }
        print(json.dumps(resp), flush=True)
    elif method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "slow_hang":
            time.sleep(5)
            continue
        elif name == "cancelled_count":
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"content": [{"type": "text", "text": json.dumps(cancelled)}]}
            }
            print(json.dumps(resp), flush=True)
        else:
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{
                        "type": "text",
                        "text": json.dumps({
                            "msg": args.get("msg"),
                            "allowed_env": os.environ.get("NEO_MCP_TEST_VAL"),
                            "blocked_env": os.environ.get("LD_PRELOAD")
                        })
                    }]
                }
            }
            print(json.dumps(resp), flush=True)
"#;

    #[tokio::test]
    async fn stdio_mcp_handles_handshake_noise_stderr_blocked_env_and_timeout_cancel() {
        let mut env = BTreeMap::new();
        env.insert("NEO_MCP_TEST_VAL".to_string(), "ok-secret".to_string());
        env.insert("LD_PRELOAD".to_string(), "/tmp/evil.so".to_string());

        let args = vec!["-u".to_string(), "-c".to_string(), MOCK_STDIO_MCP_PY.to_string()];
        let client = StdioMcpClient::connect(
            "python3",
            &args,
            &env,
            None,
            Duration::from_secs(5),
        )
        .await
        .expect("connect mock stdio MCP");

        assert_eq!(client.protocol_version(), "2025-06-18");
        assert_eq!(client.server_info()["name"], "mock-stdio-mcp");
        assert!(client.is_alive().await);

        let tools_res = client
            .request("tools/list", json!({}), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(tools_res["tools"][0]["name"], "echo_env");

        let call_res = client
            .request(
                "tools/call",
                json!({"name": "echo_env", "arguments": {"msg": "hello-mcp"}}),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        let text = call_res["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["msg"], "hello-mcp");
        assert_eq!(parsed["allowed_env"], "ok-secret");
        assert!(parsed["blocked_env"].is_null());

        // Non-JSON stdout noise and stderr were captured cleanly
        assert!(client
            .recent_noise()
            .await
            .iter()
            .any(|l| l.contains("noisy startup banner")));
        assert!(client
            .recent_stderr()
            .await
            .iter()
            .any(|l| l.contains("mock mcp booting")));

        // Timeout should error cleanly and send notifications/cancelled
        let timeout_err = client
            .request(
                "tools/call",
                json!({"name": "slow_hang", "arguments": {}}),
                Duration::from_millis(200),
            )
            .await
            .unwrap_err();
        assert!(timeout_err.contains("timed out"), "err={timeout_err}");

        client.shutdown().await;
        assert!(!client.is_alive().await);
    }
}
