use crate::mcp::discovery::slugify;
use crate::mcp::transport_http::{LegacySseMcpClient, StreamableHttpMcpClient};
use crate::mcp::transport_stdio::StdioMcpClient;
use crate::mcp::{McpServerConfig, McpToolAnnotations, McpToolInfo, McpTransportKind, StagedFile};
use crate::policy::Policy;
use base64::engine::general_purpose::STANDARD as BASE64_STD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

pub const INLINE_BINARY_STAGE_THRESHOLD: usize = 64 * 1024;
const DEFAULT_INIT_TIMEOUT_MS: u64 = 25_000;
const DEFAULT_CALL_TIMEOUT_MS: u64 = 60_000;
const MAX_LIST_PAGES: usize = 20;

static STAGE_SEQ: AtomicU64 = AtomicU64::new(1);

pub enum McpClient {
    Stdio(Box<StdioMcpClient>),
    StreamableHttp(StreamableHttpMcpClient),
    Sse(LegacySseMcpClient),
}

impl McpClient {
    pub fn protocol_version(&self) -> &str {
        match self {
            Self::Stdio(c) => c.protocol_version(),
            Self::StreamableHttp(c) => c.protocol_version(),
            Self::Sse(c) => c.protocol_version(),
        }
    }

    pub fn server_info(&self) -> Value {
        match self {
            Self::Stdio(c) => c.server_info(),
            Self::StreamableHttp(c) => c.server_info(),
            Self::Sse(c) => c.server_info(),
        }
    }

    pub fn server_capabilities(&self) -> &Value {
        match self {
            Self::Stdio(c) => c.server_capabilities(),
            Self::StreamableHttp(c) => c.server_capabilities(),
            Self::Sse(c) => c.server_capabilities(),
        }
    }

    pub async fn is_alive(&self) -> bool {
        match self {
            Self::Stdio(c) => c.is_alive().await,
            Self::StreamableHttp(c) => c.is_alive(),
            Self::Sse(c) => c.is_alive(),
        }
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        match self {
            Self::Stdio(c) => c.request(method, params, timeout).await,
            Self::StreamableHttp(c) => c.request(method, params, timeout).await,
            Self::Sse(c) => c.request(method, params, timeout).await,
        }
    }

    pub async fn shutdown(&self) {
        match self {
            Self::Stdio(c) => c.shutdown().await,
            Self::StreamableHttp(c) => c.shutdown().await,
            Self::Sse(c) => c.shutdown().await,
        }
    }

    pub async fn list_tools(&self, timeout: Duration) -> Result<Vec<McpToolInfo>, String> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();

        for _ in 0..MAX_LIST_PAGES {
            let params = match cursor {
                Some(ref c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let res = self.request("tools/list", params, timeout).await?;
            if let Some(arr) = res.get("tools").and_then(|v| v.as_array()) {
                for item in arr {
                    if let Some(tool) = parse_tool_info(item) {
                        tools.push(tool);
                    }
                }
            }
            let next = res
                .get("nextCursor")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            match next {
                Some(nc) if seen_cursors.insert(nc.clone()) => cursor = Some(nc),
                _ => break,
            }
        }
        Ok(tools)
    }

    pub async fn list_resources(&self, timeout: Duration) -> Result<Vec<Value>, String> {
        let mut resources = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();

        for _ in 0..MAX_LIST_PAGES {
            let params = match cursor {
                Some(ref c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let res = match self.request("resources/list", params, timeout).await {
                Ok(v) => v,
                Err(e) if is_method_not_found(&e) => return Ok(Vec::new()),
                Err(e) => return Err(e),
            };
            if let Some(arr) = res.get("resources").and_then(|v| v.as_array()) {
                resources.extend(arr.iter().cloned());
            }
            let next = res
                .get("nextCursor")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            match next {
                Some(nc) if seen_cursors.insert(nc.clone()) => cursor = Some(nc),
                _ => break,
            }
        }
        Ok(resources)
    }

    pub async fn list_prompts(&self, timeout: Duration) -> Result<Vec<Value>, String> {
        let mut prompts = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();

        for _ in 0..MAX_LIST_PAGES {
            let params = match cursor {
                Some(ref c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let res = match self.request("prompts/list", params, timeout).await {
                Ok(v) => v,
                Err(e) if is_method_not_found(&e) => return Ok(Vec::new()),
                Err(e) => return Err(e),
            };
            if let Some(arr) = res.get("prompts").and_then(|v| v.as_array()) {
                prompts.extend(arr.iter().cloned());
            }
            let next = res
                .get("nextCursor")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            match next {
                Some(nc) if seen_cursors.insert(nc.clone()) => cursor = Some(nc),
                _ => break,
            }
        }
        Ok(prompts)
    }
}

fn is_method_not_found(err: &str) -> bool {
    err.contains("-32601") || err.to_ascii_lowercase().contains("method not found")
}

fn parse_tool_info(item: &Value) -> Option<McpToolInfo> {
    let obj = item.as_object()?;
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let description = obj
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let input_schema = obj
        .get("inputSchema")
        .or_else(|| obj.get("input_schema"))
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    let annotations = obj.get("annotations").and_then(|v| v.as_object()).map(|a| {
        McpToolAnnotations {
            title: a.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()),
            read_only_hint: a
                .get("readOnlyHint")
                .or_else(|| a.get("read_only_hint"))
                .and_then(|v| v.as_bool()),
            destructive_hint: a
                .get("destructiveHint")
                .or_else(|| a.get("destructive_hint"))
                .and_then(|v| v.as_bool()),
            idempotent_hint: a
                .get("idempotentHint")
                .or_else(|| a.get("idempotent_hint"))
                .and_then(|v| v.as_bool()),
            open_world_hint: a
                .get("openWorldHint")
                .or_else(|| a.get("open_world_hint"))
                .and_then(|v| v.as_bool()),
        }
    });

    Some(McpToolInfo {
        name,
        description,
        input_schema,
        annotations,
    })
}

pub fn compute_tools_schema_hash(tools: &[McpToolInfo]) -> String {
    let mut sorted = tools.to_vec();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));
    let canonical = serde_json::to_vec(&sorted).unwrap_or_default();
    format!("sha256:{}", hex::encode(Sha256::digest(&canonical)))
}

struct ManagedSession {
    fingerprint: String,
    client: Arc<McpClient>,
    last_used: Instant,
    in_flight: usize,
}

#[derive(Debug, Clone)]
pub struct InspectOutcome {
    pub server_info: Value,
    pub protocol_version: String,
    pub tools: Vec<McpToolInfo>,
    pub resources: Vec<Value>,
    pub prompts: Vec<Value>,
    pub tools_schema_hash: String,
}

#[derive(Debug, Clone)]
pub struct CallOutcome {
    pub is_error: bool,
    pub content: Value,
    pub structured_content: Option<Value>,
    pub staged_files: Vec<StagedFile>,
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct ResourceReadOutcome {
    pub contents: Value,
    pub staged_files: Vec<StagedFile>,
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct PromptGetOutcome {
    pub description: Option<String>,
    pub messages: Value,
    pub truncated: bool,
    pub duration_ms: u64,
}

pub struct McpSupervisor {
    sessions: Mutex<HashMap<String, ManagedSession>>,
    connect_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    starting: Mutex<HashSet<String>>,
    last_errors: Mutex<HashMap<String, String>>,
    cached_tools: Mutex<HashMap<String, Vec<McpToolInfo>>>,
}

impl McpSupervisor {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            connect_locks: Mutex::new(HashMap::new()),
            starting: Mutex::new(HashSet::new()),
            last_errors: Mutex::new(HashMap::new()),
            cached_tools: Mutex::new(HashMap::new()),
        }
    }

    pub async fn runtime_state(&self, server_id: &str) -> &'static str {
        if self.starting.lock().await.contains(server_id) {
            return "starting";
        }
        let maybe_client = {
            let guard = self.sessions.lock().await;
            guard.get(server_id).map(|s| Arc::clone(&s.client))
        };
        if let Some(client) = maybe_client {
            if client.is_alive().await {
                return "running";
            }
            // Clean up dead session lazily
            let _ = self.sessions.lock().await.remove(server_id);
        }
        if self.last_errors.lock().await.contains_key(server_id) {
            return "error";
        }
        "stopped"
    }

    #[cfg(test)]
    pub async fn running_count(&self) -> usize {
        let clients: Vec<(String, Arc<McpClient>)> = {
            let guard = self.sessions.lock().await;
            guard
                .iter()
                .map(|(k, v)| (k.clone(), Arc::clone(&v.client)))
                .collect()
        };
        let mut count = 0;
        let mut dead = Vec::new();
        for (id, c) in clients {
            if c.is_alive().await {
                count += 1;
            } else {
                dead.push(id);
            }
        }
        if !dead.is_empty() {
            let mut guard = self.sessions.lock().await;
            for id in dead {
                guard.remove(&id);
            }
        }
        count
    }

    pub async fn cached_tool_count(&self, server_id: &str) -> Option<usize> {
        self.cached_tools
            .lock()
            .await
            .get(server_id)
            .map(|t| t.len())
    }

    pub async fn cached_tool(&self, server_id: &str, tool_name: &str) -> Option<McpToolInfo> {
        self.cached_tools
            .lock()
            .await
            .get(server_id)
            .and_then(|tools| tools.iter().find(|t| t.name == tool_name).cloned())
    }

    pub async fn last_error(&self, server_id: &str) -> Option<String> {
        self.last_errors.lock().await.get(server_id).cloned()
    }

    async fn get_connect_lock(&self, server_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.connect_locks.lock().await;
        map.entry(server_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn acquire_session(
        &self,
        config: &McpServerConfig,
        fingerprint: &str,
        policy: &Policy,
        connect_timeout: Duration,
    ) -> Result<Arc<McpClient>, String> {
        let lock = self.get_connect_lock(&config.server_id).await;
        let _connect_guard = lock.lock().await;

        // Reuse existing live session if fingerprint matches
        let existing_to_drop = {
            let mut sessions = self.sessions.lock().await;
            if let Some(sess) = sessions.get_mut(&config.server_id) {
                if sess.fingerprint == fingerprint && sess.client.is_alive().await {
                    sess.last_used = Instant::now();
                    sess.in_flight += 1;
                    return Ok(Arc::clone(&sess.client));
                }
                sessions.remove(&config.server_id).map(|s| s.client)
            } else {
                None
            }
        };
        if let Some(old) = existing_to_drop {
            old.shutdown().await;
        }

        // Enforce max_concurrent_servers by evicting LRU idle session
        let max_conc = policy.mcp_max_concurrent_servers();
        let evicted = {
            let mut sessions = self.sessions.lock().await;
            let mut to_evict = Vec::new();
            while sessions.len() >= max_conc {
                let lru_key = sessions
                    .iter()
                    .filter(|(_, s)| s.in_flight == 0)
                    .min_by_key(|(_, s)| s.last_used)
                    .map(|(k, _)| k.clone());
                match lru_key {
                    Some(k) => {
                        if let Some(removed) = sessions.remove(&k) {
                            to_evict.push(removed.client);
                        }
                    }
                    None => {
                        return Err(format!(
                            "max concurrent MCP servers limit reached ({max_conc}); all active sessions are busy"
                        ));
                    }
                }
            }
            to_evict
        };
        for c in evicted {
            c.shutdown().await;
        }

        self.starting.lock().await.insert(config.server_id.clone());
        let connect_res = spawn_client(config, policy, connect_timeout).await;
        self.starting.lock().await.remove(&config.server_id);

        match connect_res {
            Ok(client) => {
                let arc = Arc::new(client);
                self.last_errors.lock().await.remove(&config.server_id);
                self.sessions.lock().await.insert(
                    config.server_id.clone(),
                    ManagedSession {
                        fingerprint: fingerprint.to_string(),
                        client: Arc::clone(&arc),
                        last_used: Instant::now(),
                        in_flight: 1,
                    },
                );
                Ok(arc)
            }
            Err(err) => {
                self.last_errors
                    .lock()
                    .await
                    .insert(config.server_id.clone(), err.clone());
                Err(err)
            }
        }
    }

    async fn release_session(&self, server_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(sess) = sessions.get_mut(server_id) {
            sess.in_flight = sess.in_flight.saturating_sub(1);
            sess.last_used = Instant::now();
        }
    }

    pub async fn inspect(
        &self,
        config: &McpServerConfig,
        fingerprint: &str,
        policy: &Policy,
        include_resources: bool,
        include_prompts: bool,
        timeout_ms: Option<u64>,
    ) -> Result<InspectOutcome, String> {
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_INIT_TIMEOUT_MS).max(500));
        let client = self
            .acquire_session(config, fingerprint, policy, timeout)
            .await?;

        let result: Result<InspectOutcome, String> = async {
            let tools = client.list_tools(timeout).await?;
            let caps = client.server_capabilities();
            let resources = if include_resources || caps.get("resources").is_some() {
                client.list_resources(timeout).await.unwrap_or_default()
            } else {
                Vec::new()
            };
            let prompts = if include_prompts || caps.get("prompts").is_some() {
                client.list_prompts(timeout).await.unwrap_or_default()
            } else {
                Vec::new()
            };
            let tools_schema_hash = compute_tools_schema_hash(&tools);
            self.cached_tools
                .lock()
                .await
                .insert(config.server_id.clone(), tools.clone());
            Ok(InspectOutcome {
                server_info: client.server_info(),
                protocol_version: client.protocol_version().to_string(),
                tools,
                resources,
                prompts,
                tools_schema_hash,
            })
        }
        .await;

        self.release_session(&config.server_id).await;
        if let Err(ref e) = result {
            self.last_errors
                .lock()
                .await
                .insert(config.server_id.clone(), e.clone());
        }
        result
    }

    pub async fn call_tool(
        &self,
        config: &McpServerConfig,
        fingerprint: &str,
        policy: &Policy,
        tool_name: &str,
        arguments: Value,
        timeout_ms: Option<u64>,
    ) -> Result<CallOutcome, String> {
        let started = Instant::now();
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_CALL_TIMEOUT_MS).max(500));
        let client = self
            .acquire_session(config, fingerprint, policy, timeout)
            .await?;

        let req_params = json!({
            "name": tool_name,
            "arguments": arguments,
        });
        let raw_res = client.request("tools/call", req_params, timeout).await;
        self.release_session(&config.server_id).await;

        let res = match raw_res {
            Ok(v) => v,
            Err(e) => {
                self.last_errors
                    .lock()
                    .await
                    .insert(config.server_id.clone(), e.clone());
                return Err(e);
            }
        };

        let is_error = res
            .get("isError")
            .or_else(|| res.get("is_error"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let mut content = res.get("content").cloned().unwrap_or_else(|| json!([]));
        let mut structured_content = res
            .get("structuredContent")
            .or_else(|| res.get("structured_content"))
            .cloned();

        let staging_root = resolve_staging_root(policy);
        let (staged_files, truncated) = guard_and_stage_content(
            &config.server_id,
            &mut content,
            &mut structured_content,
            staging_root.as_deref(),
            policy.mcp_soft_text_bytes(),
            policy.mcp_max_response_bytes(),
        );

        Ok(CallOutcome {
            is_error,
            content,
            structured_content,
            staged_files,
            truncated,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub async fn read_resource(
        &self,
        config: &McpServerConfig,
        fingerprint: &str,
        policy: &Policy,
        uri: &str,
        timeout_ms: Option<u64>,
    ) -> Result<ResourceReadOutcome, String> {
        let started = Instant::now();
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_CALL_TIMEOUT_MS).max(500));
        let client = self
            .acquire_session(config, fingerprint, policy, timeout)
            .await?;

        let raw_res = client
            .request("resources/read", json!({ "uri": uri }), timeout)
            .await;
        self.release_session(&config.server_id).await;

        let res = raw_res?;
        let mut contents = res.get("contents").cloned().unwrap_or_else(|| json!([]));
        let mut none_structured: Option<Value> = None;
        let staging_root = resolve_staging_root(policy);
        let (staged_files, truncated) = guard_and_stage_content(
            &config.server_id,
            &mut contents,
            &mut none_structured,
            staging_root.as_deref(),
            policy.mcp_soft_text_bytes(),
            policy.mcp_max_response_bytes(),
        );

        Ok(ResourceReadOutcome {
            contents,
            staged_files,
            truncated,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub async fn get_prompt(
        &self,
        config: &McpServerConfig,
        fingerprint: &str,
        policy: &Policy,
        name: &str,
        arguments: Value,
        timeout_ms: Option<u64>,
    ) -> Result<PromptGetOutcome, String> {
        let started = Instant::now();
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_CALL_TIMEOUT_MS).max(500));
        let client = self
            .acquire_session(config, fingerprint, policy, timeout)
            .await?;

        let raw_res = client
            .request(
                "prompts/get",
                json!({
                    "name": name,
                    "arguments": arguments,
                }),
                timeout,
            )
            .await;
        self.release_session(&config.server_id).await;

        let res = raw_res?;
        let description = res
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let mut messages = res.get("messages").cloned().unwrap_or_else(|| json!([]));
        let mut none_structured: Option<Value> = None;
        let staging_root = resolve_staging_root(policy);
        let (_staged, truncated) = guard_and_stage_content(
            &config.server_id,
            &mut messages,
            &mut none_structured,
            staging_root.as_deref(),
            policy.mcp_soft_text_bytes(),
            policy.mcp_max_response_bytes(),
        );

        Ok(PromptGetOutcome {
            description,
            messages,
            truncated,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub async fn stop_server(&self, server_id: &str) -> bool {
        let removed = self.sessions.lock().await.remove(server_id);
        self.last_errors.lock().await.remove(server_id);
        if let Some(sess) = removed {
            sess.client.shutdown().await;
            true
        } else {
            false
        }
    }

    pub async fn restart_server(
        &self,
        config: &McpServerConfig,
        fingerprint: &str,
        policy: &Policy,
        timeout_ms: Option<u64>,
    ) -> Result<(), String> {
        let _ = self.stop_server(&config.server_id).await;
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_INIT_TIMEOUT_MS).max(500));
        let _client = self
            .acquire_session(config, fingerprint, policy, timeout)
            .await?;
        self.release_session(&config.server_id).await;
        Ok(())
    }

    pub async fn reap_idle(&self, idle_timeout: Duration) -> usize {
        let expired: Vec<Arc<McpClient>> = {
            let mut sessions = self.sessions.lock().await;
            let keys: Vec<String> = sessions
                .iter()
                .filter(|(_, s)| s.in_flight == 0 && s.last_used.elapsed() >= idle_timeout)
                .map(|(k, _)| k.clone())
                .collect();
            let mut out = Vec::with_capacity(keys.len());
            for k in keys {
                if let Some(s) = sessions.remove(&k) {
                    out.push(s.client);
                }
            }
            out
        };
        let count = expired.len();
        for c in expired {
            c.shutdown().await;
        }
        count
    }

    pub async fn shutdown_all(&self) {
        let all: Vec<Arc<McpClient>> = {
            let mut sessions = self.sessions.lock().await;
            sessions.drain().map(|(_, s)| s.client).collect()
        };
        for c in all {
            c.shutdown().await;
        }
    }
}

async fn spawn_client(
    config: &McpServerConfig,
    policy: &Policy,
    timeout: Duration,
) -> Result<McpClient, String> {
    match config.transport {
        McpTransportKind::Stdio => {
            let program = config
                .command
                .as_deref()
                .ok_or_else(|| format!("stdio MCP '{}' missing command", config.server_id))?;
            let cwd = config
                .cwd
                .as_deref()
                .map(PathBuf::from)
                .filter(|p| p.is_dir())
                .or_else(|| policy.default_cwd().ok());
            let client =
                StdioMcpClient::connect(program, &config.args, &config.env, cwd.as_deref(), timeout)
                    .await?;
            Ok(McpClient::Stdio(Box::new(client)))
        }
        McpTransportKind::StreamableHttp => {
            let url = config
                .url
                .as_deref()
                .ok_or_else(|| format!("HTTP MCP '{}' missing url", config.server_id))?;
            let client = StreamableHttpMcpClient::connect(
                url,
                &config.headers,
                policy.mcp_max_response_bytes(),
                timeout,
            )
            .await?;
            Ok(McpClient::StreamableHttp(client))
        }
        McpTransportKind::Sse => {
            let url = config
                .url
                .as_deref()
                .ok_or_else(|| format!("SSE MCP '{}' missing url", config.server_id))?;
            let client = LegacySseMcpClient::connect(
                url,
                &config.headers,
                policy.mcp_max_response_bytes(),
                timeout,
            )
            .await?;
            Ok(McpClient::Sse(client))
        }
    }
}

fn resolve_staging_root(policy: &Policy) -> Option<PathBuf> {
    policy
        .default_workspace()
        .ok()
        .map(Path::to_path_buf)
        .or_else(|| {
            if policy.is_unrestricted() {
                policy.default_cwd().ok()
            } else {
                None
            }
        })
}

// ---------------------------------------------------------------------------
// Response Guard & Large Binary Payload Staging (0xE3 file transfer linkage)
// ---------------------------------------------------------------------------

pub fn guard_and_stage_content(
    server_id: &str,
    content: &mut Value,
    structured_content: &mut Option<Value>,
    workspace_root: Option<&Path>,
    soft_text_bytes: usize,
    max_response_bytes: usize,
) -> (Vec<StagedFile>, bool) {
    let mut staged_files = Vec::new();
    let mut truncated = false;
    let mut text_budget = soft_text_bytes;

    if let Some(items) = content.as_array_mut() {
        for item in items.iter_mut() {
            process_content_item(
                server_id,
                item,
                workspace_root,
                &mut text_budget,
                &mut staged_files,
                &mut truncated,
            );
        }
    } else if content.is_object() {
        process_content_item(
            server_id,
            content,
            workspace_root,
            &mut text_budget,
            &mut staged_files,
            &mut truncated,
        );
    }

    // Enforce total serialized max_response_bytes guard
    let total_size = estimate_json_size(content)
        + structured_content
            .as_ref()
            .map(estimate_json_size)
            .unwrap_or(0);
    if total_size > max_response_bytes {
        truncated = true;
        if let Some(sc) = structured_content.as_ref() {
            if estimate_json_size(sc) > max_response_bytes / 2 {
                *structured_content = Some(json!({
                    "_truncated": true,
                    "_reason": format!("structured_content exceeded max_response_bytes ({max_response_bytes})")
                }));
            }
        }
        if estimate_json_size(content) > max_response_bytes {
            let mut hard_budget = max_response_bytes.saturating_sub(2048);
            if let Some(items) = content.as_array_mut() {
                for item in items.iter_mut() {
                    enforce_hard_item_cap(item, &mut hard_budget);
                }
            }
        }
    }

    (staged_files, truncated)
}

fn process_content_item(
    server_id: &str,
    item: &mut Value,
    workspace_root: Option<&Path>,
    text_budget: &mut usize,
    staged_files: &mut Vec<StagedFile>,
    truncated: &mut bool,
) {
    let Some(obj) = item.as_object_mut() else {
        return;
    };

    // Case 1: tools/call image or audio content item with inline base64 `data`
    let item_type = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if matches!(item_type.as_str(), "image" | "audio") {
        let mime = obj
            .get("mimeType")
            .or_else(|| obj.get("mime_type"))
            .and_then(|v| v.as_str())
            .unwrap_or("application/octet-stream")
            .to_string();
        if let Some(data_str) = obj.get("data").and_then(|v| v.as_str()).map(|s| s.to_string()) {
            if should_stage_base64(&data_str, *text_budget) {
                if let Some(staged) = stage_base64_blob(server_id, &data_str, &mime, workspace_root)
                {
                    let placeholder = format!(
                        "[staged:{} ({} bytes, {})]",
                        staged.remote_path, staged.size_bytes, staged.mime_type
                    );
                    obj.insert("data".to_string(), Value::String(placeholder));
                    obj.insert(
                        "staged_remote_path".to_string(),
                        Value::String(staged.remote_path.clone()),
                    );
                    staged_files.push(staged);
                } else {
                    obj.insert(
                        "data".to_string(),
                        Value::String(truncate_utf8(&data_str, 4096)),
                    );
                    *truncated = true;
                }
            } else {
                *text_budget = text_budget.saturating_sub(data_str.len());
            }
        }
        return;
    }

    // Case 2: embedded resource `{ type: "resource", resource: { blob | text, mimeType } }`
    if item_type == "resource" {
        if let Some(res_obj) = obj.get_mut("resource").and_then(|v| v.as_object_mut()) {
            process_resource_object(
                server_id,
                res_obj,
                workspace_root,
                text_budget,
                staged_files,
                truncated,
            );
        }
        return;
    }

    // Case 3: resources/read entry `{ uri, mimeType, blob | text }`
    if obj.contains_key("blob") {
        process_resource_object(
            server_id,
            obj,
            workspace_root,
            text_budget,
            staged_files,
            truncated,
        );
        return;
    }

    // Case 4: prompts/get message `{ role, content: { ... } }`
    if obj.contains_key("role") && obj.get("content").map(|v| v.is_object()).unwrap_or(false) {
        if let Some(inner) = obj.get_mut("content") {
            process_content_item(
                server_id,
                inner,
                workspace_root,
                text_budget,
                staged_files,
                truncated,
            );
        }
        return;
    }

    // Case 5: text item `{ type: "text", text: "..." }` or resource `{ text: "..." }`
    if let Some(text_val) = obj.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()) {
        if text_val.len() > *text_budget {
            let kept = truncate_utf8(&text_val, *text_budget);
            obj.insert("text".to_string(), Value::String(kept));
            *text_budget = 0;
            *truncated = true;
        } else {
            *text_budget = text_budget.saturating_sub(text_val.len());
        }
    }
}

fn process_resource_object(
    server_id: &str,
    res_obj: &mut serde_json::Map<String, Value>,
    workspace_root: Option<&Path>,
    text_budget: &mut usize,
    staged_files: &mut Vec<StagedFile>,
    truncated: &mut bool,
) {
    let mime = res_obj
        .get("mimeType")
        .or_else(|| res_obj.get("mime_type"))
        .and_then(|v| v.as_str())
        .unwrap_or("application/octet-stream")
        .to_string();

    if let Some(blob_str) = res_obj
        .get("blob")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
    {
        if should_stage_base64(&blob_str, *text_budget) {
            if let Some(staged) = stage_base64_blob(server_id, &blob_str, &mime, workspace_root) {
                let placeholder = format!(
                    "[staged:{} ({} bytes, {})]",
                    staged.remote_path, staged.size_bytes, staged.mime_type
                );
                res_obj.insert("blob".to_string(), Value::String(placeholder));
                res_obj.insert(
                    "staged_remote_path".to_string(),
                    Value::String(staged.remote_path.clone()),
                );
                staged_files.push(staged);
            } else {
                res_obj.insert(
                    "blob".to_string(),
                    Value::String(truncate_utf8(&blob_str, 4096)),
                );
                *truncated = true;
            }
        } else {
            *text_budget = text_budget.saturating_sub(blob_str.len());
        }
    }

    if let Some(text_val) = res_obj
        .get("text")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
    {
        if text_val.len() > *text_budget {
            res_obj.insert("text".to_string(), Value::String(truncate_utf8(&text_val, *text_budget)));
            *text_budget = 0;
            *truncated = true;
        } else {
            *text_budget = text_budget.saturating_sub(text_val.len());
        }
    }
}

fn should_stage_base64(b64: &str, remaining_text_budget: usize) -> bool {
    let approx_decoded = (b64.len() / 4) * 3;
    approx_decoded > INLINE_BINARY_STAGE_THRESHOLD
        || b64.len() > INLINE_BINARY_STAGE_THRESHOLD
        || b64.len() > remaining_text_budget
}

fn stage_base64_blob(
    server_id: &str,
    b64: &str,
    mime_type: &str,
    workspace_root: Option<&Path>,
) -> Option<StagedFile> {
    let ws = workspace_root?;
    let cleaned: String = b64.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let decoded = BASE64_STD.decode(cleaned.as_bytes()).ok()?;

    let tmp_dir = ws.join(".neo-mcp-tmp");
    std::fs::create_dir_all(&tmp_dir).ok()?;

    let safe_server = slugify(server_id);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let seq = STAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    let ext = mime_to_extension(mime_type);
    let filename = format!("mcp-{safe_server}-{ts}-{seq}.{ext}");
    let full_path = tmp_dir.join(&filename);
    std::fs::write(&full_path, &decoded).ok()?;

    let remote_path = std::fs::canonicalize(&full_path)
        .unwrap_or(full_path)
        .to_string_lossy()
        .into_owned();

    Some(StagedFile {
        mime_type: mime_type.to_string(),
        size_bytes: decoded.len(),
        remote_path,
    })
}

fn mime_to_extension(mime: &str) -> &'static str {
    let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match base.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        "application/pdf" => "pdf",
        "application/json" => "json",
        "text/plain" => "txt",
        "text/html" => "html",
        _ => "bin",
    }
}

fn enforce_hard_item_cap(item: &mut Value, budget: &mut usize) {
    let Some(obj) = item.as_object_mut() else {
        return;
    };
    for key in ["text", "data", "blob"] {
        if let Some(s) = obj.get(key).and_then(|v| v.as_str()).map(|s| s.to_string()) {
            if s.len() > *budget {
                obj.insert(key.to_string(), Value::String(truncate_utf8(&s, *budget)));
                *budget = 0;
            } else {
                *budget = budget.saturating_sub(s.len());
            }
        }
    }
}

fn truncate_utf8(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let suffix = "\n...[truncated]";
    let keep = max_bytes.saturating_sub(suffix.len());
    let mut end = keep.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = s[..end].to_string();
    out.push_str(suffix);
    out
}

fn estimate_json_size(v: &Value) -> usize {
    serde_json::to_vec(v).map(|b| b.len()).unwrap_or(0)
}
