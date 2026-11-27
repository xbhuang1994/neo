pub mod discovery;
pub mod supervisor;
pub mod transport_http;
pub mod transport_stdio;

use crate::mcp::discovery::{
    compute_catalog_hash, discover_servers, DiscoveredEntry, DiscoveryEnv, MtimeSnapshot,
};
use crate::mcp::supervisor::McpSupervisor;
use crate::policy::{Policy, SandboxLevel};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpTransportKind {
    Stdio,
    StreamableHttp,
    Sse,
}

impl McpTransportKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Stdio => "stdio",
            Self::StreamableHttp => "streamable_http",
            Self::Sse => "sse",
        }
    }
}

/// Internal full MCP server configuration kept strictly in memory on Tier 1.
/// Intentionally does NOT derive `Serialize` so secret env/header/arg values
/// can never be transmitted out of the local host.
#[derive(Debug, Clone)]
pub struct McpServerConfig {
    pub server_id: String,
    pub name: String,
    pub source: String,
    pub transport: McpTransportKind,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub explicit_enabled: Option<bool>,
    pub explicit_call_mode: Option<String>,
    pub discovered_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpSummaryServer {
    pub server_id: String,
    pub name: String,
    pub source: String,
    pub transport: String,
    pub trust_state: String,
    pub call_mode: String,
    pub runtime_state: String,
    pub tool_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpSummary {
    pub enabled: bool,
    pub discovery_mode: String,
    pub discovered_count: usize,
    pub enabled_count: usize,
    pub running_count: usize,
    pub catalog_hash: String,
    pub servers: Vec<McpSummaryServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpServerDescriptor {
    pub server_id: String,
    pub name: String,
    pub source: String,
    pub source_path: Option<String>,
    pub transport: String,
    pub command_preview: Option<String>,
    pub url_sanitized: Option<String>,
    pub env_keys: Vec<String>,
    pub auth_required: bool,
    pub trust_state: String,
    pub call_mode: String,
    pub runtime_state: String,
    pub tool_count: Option<usize>,
    pub dedup_key: String,
    pub duplicate_of: Option<String>,
    pub fingerprint: String,
    pub last_error: Option<String>,
    pub discovered_at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct McpToolAnnotations {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(
        default,
        rename = "readOnlyHint",
        skip_serializing_if = "Option::is_none"
    )]
    pub read_only_hint: Option<bool>,
    #[serde(
        default,
        rename = "destructiveHint",
        skip_serializing_if = "Option::is_none"
    )]
    pub destructive_hint: Option<bool>,
    #[serde(
        default,
        rename = "idempotentHint",
        skip_serializing_if = "Option::is_none"
    )]
    pub idempotent_hint: Option<bool>,
    #[serde(
        default,
        rename = "openWorldHint",
        skip_serializing_if = "Option::is_none"
    )]
    pub open_world_hint: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpToolInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, rename = "inputSchema")]
    pub input_schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<McpToolAnnotations>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StagedFile {
    pub mime_type: String,
    pub size_bytes: usize,
    pub remote_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ServerPolicyOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trust_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    call_mode: Option<String>,
    #[serde(default)]
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedPolicyStore {
    version: u32,
    #[serde(default)]
    servers: BTreeMap<String, ServerPolicyOverride>,
}

impl Default for PersistedPolicyStore {
    fn default() -> Self {
        Self {
            version: 1,
            servers: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct DiscoveryCache {
    initialized: bool,
    discovery_mode: String,
    scanned_at_ms: u64,
    entries: Vec<DiscoveredEntry>,
    warnings: Vec<String>,
    mtime_snapshot: MtimeSnapshot,
    last_notified_catalog_hash: String,
}

#[derive(Debug, Clone)]
pub struct CatalogChangeEvent {
    pub catalog_hash: String,
    pub summary: McpSummary,
    pub servers: Vec<McpServerDescriptor>,
}

pub fn is_mcp_rpc_method(method: &str) -> bool {
    matches!(
        method,
        "mcp.discover"
            | "mcp_discover"
            | "mcp.list"
            | "mcp_list"
            | "mcp.inspect"
            | "mcp_inspect"
            | "mcp.call"
            | "mcp_call"
            | "mcp.resource.read"
            | "mcp_resource_read"
            | "mcp.prompt.get"
            | "mcp_prompt_get"
            | "mcp.server.set_policy"
            | "mcp_set_policy"
            | "mcp.server.stop"
            | "mcp_server_stop"
            | "mcp.server.restart"
            | "mcp_server_restart"
    )
}

pub struct McpManager {
    policy: Arc<RwLock<Policy>>,
    env: DiscoveryEnv,
    policy_store_path: Option<PathBuf>,
    overrides: Mutex<PersistedPolicyStore>,
    cache: Mutex<DiscoveryCache>,
    supervisor: Arc<McpSupervisor>,
}

impl McpManager {
    pub fn new(
        policy: Arc<RwLock<Policy>>,
        cluster_id: Option<String>,
        policy_path: Option<PathBuf>,
        sandbox_override_path: Option<PathBuf>,
        ota_cache_dir: Option<PathBuf>,
    ) -> Self {
        let env = DiscoveryEnv::from_system(cluster_id, policy_path.clone());
        let policy_store_path = sandbox_override_path
            .as_ref()
            .and_then(|p| p.parent().map(|d| d.join("mcp-policies.json")))
            .or_else(|| ota_cache_dir.as_ref().map(|d| d.join("mcp-policies.json")))
            .or_else(|| {
                policy_path
                    .as_ref()
                    .and_then(|p| p.parent().map(|d| d.join("mcp-policies.json")))
            })
            .or_else(|| env.neo_config_dir.as_ref().map(|d| d.join("mcp-policies.json")));

        Self::with_env(policy, env, policy_store_path)
    }

    pub fn with_env(
        policy: Arc<RwLock<Policy>>,
        env: DiscoveryEnv,
        policy_store_path: Option<PathBuf>,
    ) -> Self {
        let loaded_store = policy_store_path
            .as_deref()
            .and_then(load_policy_store)
            .unwrap_or_default();

        Self {
            policy,
            env,
            policy_store_path,
            overrides: Mutex::new(loaded_store),
            cache: Mutex::new(DiscoveryCache::default()),
            supervisor: Arc::new(McpSupervisor::new()),
        }
    }

    pub fn policy_snapshot(&self) -> Policy {
        self.policy
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    #[cfg(test)]
    pub fn supervisor(&self) -> &Arc<McpSupervisor> {
        &self.supervisor
    }

    pub fn spawn_idle_reaper(self: &Arc<Self>) -> JoinHandle<()> {
        let mgr = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(15));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            interval.tick().await;
            loop {
                interval.tick().await;
                let idle_sec = mgr.policy_snapshot().mcp_idle_timeout_sec();
                if idle_sec > 0 {
                    let _ = mgr
                        .supervisor
                        .reap_idle(Duration::from_secs(idle_sec))
                        .await;
                }
            }
        })
    }

    pub async fn shutdown_all(&self) {
        self.supervisor.shutdown_all().await;
    }

    /// Re-evaluates running MCP sessions after a live `set_sandbox` transition,
    /// stopping any sessions that are no longer permitted, and refreshes discovery cache.
    pub async fn on_sandbox_changed(&self) {
        let pol = self.policy_snapshot();
        let entries_snap = {
            let cache = self.cache.lock().await;
            cache.entries.clone()
        };
        let overrides_snap = self.overrides.lock().await.clone();
        for entry in &entries_snap {
            let eval = evaluate_effective_policy(&pol, &entry.config, &overrides_snap);
            if !eval.can_run {
                let _ = self.supervisor.stop_server(&entry.config.server_id).await;
            }
        }
        let _ = self.run_discovery_internal(Some(false)).await;
    }

    async fn run_discovery_internal(
        &self,
        include_loopback_probe_override: Option<bool>,
    ) -> (String, u64, Vec<McpServerDescriptor>, Vec<String>, McpSummary) {
        let pol = self.policy_snapshot();
        let outcome = discover_servers(&pol, &self.env, include_loopback_probe_override).await;

        {
            let mut cache = self.cache.lock().await;
            cache.initialized = true;
            cache.discovery_mode = outcome.discovery_mode.clone();
            cache.scanned_at_ms = outcome.scanned_at_ms;
            cache.entries = outcome.entries;
            cache.warnings = outcome.warnings.clone();
            cache.mtime_snapshot = outcome.mtime_snapshot;
        }

        let (mode, scanned_at_ms, descriptors, summary) = self.build_catalog_snapshot().await;
        {
            let mut cache = self.cache.lock().await;
            if cache.last_notified_catalog_hash.is_empty() {
                cache.last_notified_catalog_hash = summary.catalog_hash.clone();
            }
        }
        (mode, scanned_at_ms, descriptors, outcome.warnings, summary)
    }

    async fn ensure_initialized(&self) {
        let is_init = self.cache.lock().await.initialized;
        if !is_init {
            let _ = self.run_discovery_internal(Some(false)).await;
        }
    }

    async fn build_catalog_snapshot(&self) -> (String, u64, Vec<McpServerDescriptor>, McpSummary) {
        let pol = self.policy_snapshot();
        let (mode, scanned_at_ms, entries) = {
            let cache = self.cache.lock().await;
            let eff_mode = pol.mcp_discovery_mode().to_string();
            (eff_mode, cache.scanned_at_ms, cache.entries.clone())
        };
        let overrides_snap = self.overrides.lock().await.clone();

        let mut descriptors = Vec::with_capacity(entries.len());
        let mut summary_servers = Vec::with_capacity(entries.len());
        let mut enabled_count = 0usize;
        let mut running_count = 0usize;

        for entry in &entries {
            let eval = evaluate_effective_policy(&pol, &entry.config, &overrides_snap);
            let runtime_state = self
                .supervisor
                .runtime_state(&entry.config.server_id)
                .await
                .to_string();
            let tool_count = self
                .supervisor
                .cached_tool_count(&entry.config.server_id)
                .await;
            let last_error = self.supervisor.last_error(&entry.config.server_id).await;

            if eval.trust_state == "enabled" {
                enabled_count += 1;
            }
            if runtime_state == "running" {
                running_count += 1;
            }

            summary_servers.push(McpSummaryServer {
                server_id: entry.config.server_id.clone(),
                name: entry.config.name.clone(),
                source: entry.config.source.clone(),
                transport: entry.config.transport.as_str().to_string(),
                trust_state: eval.trust_state.clone(),
                call_mode: eval.call_mode.clone(),
                runtime_state: runtime_state.clone(),
                tool_count,
            });

            descriptors.push(McpServerDescriptor {
                server_id: entry.config.server_id.clone(),
                name: entry.config.name.clone(),
                source: entry.config.source.clone(),
                source_path: entry.display_source_path.clone(),
                transport: entry.config.transport.as_str().to_string(),
                command_preview: entry.command_preview.clone(),
                url_sanitized: entry.url_sanitized.clone(),
                env_keys: entry.env_keys.clone(),
                auth_required: entry.auth_required,
                trust_state: eval.trust_state,
                call_mode: eval.call_mode,
                runtime_state,
                tool_count,
                dedup_key: entry.dedup_key.clone(),
                duplicate_of: entry.duplicate_of.clone(),
                fingerprint: entry.fingerprint.clone(),
                last_error,
                discovered_at_ms: entry.config.discovered_at_ms,
            });
        }

        let catalog_hash = compute_catalog_hash(&descriptors);
        let summary = McpSummary {
            enabled: pol.mcp_enabled(),
            discovery_mode: mode.clone(),
            discovered_count: descriptors.len(),
            enabled_count,
            running_count,
            catalog_hash,
            servers: summary_servers,
        };
        (mode, scanned_at_ms, descriptors, summary)
    }

    pub async fn discover_initial(&self) {
        let _ = self.run_discovery_internal(Some(false)).await;
    }

    pub async fn catalog_summary(&self) -> McpSummary {
        self.ensure_initialized().await;
        let (_, _, _, summary) = self.build_catalog_snapshot().await;
        summary
    }

    /// Lightweight periodic change detector: checks watched config mtimes first; only re-parses
    /// and emits a `CatalogChangeEvent` when `catalog_hash` actually changes.
    pub async fn poll_catalog_changes(&self) -> Option<CatalogChangeEvent> {
        let pol = self.policy_snapshot();
        let (needs_scan, prev_hash) = {
            let cache = self.cache.lock().await;
            let mode_changed = cache.discovery_mode != pol.mcp_discovery_mode();
            let mtime_changed = !cache.initialized || cache.mtime_snapshot.has_changed();
            (
                mode_changed || mtime_changed,
                cache.last_notified_catalog_hash.clone(),
            )
        };

        if !needs_scan {
            return None;
        }

        let (_, _, descriptors, _, summary) = self.run_discovery_internal(Some(false)).await;
        if summary.catalog_hash == prev_hash {
            return None;
        }
        {
            let mut cache = self.cache.lock().await;
            cache.last_notified_catalog_hash = summary.catalog_hash.clone();
        }
        Some(CatalogChangeEvent {
            catalog_hash: summary.catalog_hash.clone(),
            summary,
            servers: descriptors,
        })
    }

    async fn find_entry(&self, server_id: &str) -> Result<DiscoveredEntry, String> {
        self.ensure_initialized().await;
        let cache = self.cache.lock().await;
        cache
            .entries
            .iter()
            .find(|e| e.config.server_id == server_id)
            .cloned()
            .ok_or_else(|| format!("MCP server '{server_id}' not found in discovery catalog"))
    }

    async fn descriptor_for(&self, server_id: &str) -> Option<McpServerDescriptor> {
        let (_, _, descriptors, _) = self.build_catalog_snapshot().await;
        descriptors.into_iter().find(|d| d.server_id == server_id)
    }

    pub async fn dispatch_rpc(
        &self,
        method: &str,
        params: &Value,
        timeout_ms: Option<u64>,
    ) -> Result<Value, String> {
        let eff_timeout = params
            .get("timeout_ms")
            .and_then(|v| v.as_u64())
            .or(timeout_ms);

        match method {
            "mcp.discover" | "mcp_discover" => self.rpc_discover(params).await,
            "mcp.list" | "mcp_list" => self.rpc_list(params).await,
            "mcp.inspect" | "mcp_inspect" => self.rpc_inspect(params, eff_timeout).await,
            "mcp.call" | "mcp_call" => self.rpc_call(params, eff_timeout).await,
            "mcp.resource.read" | "mcp_resource_read" => {
                self.rpc_resource_read(params, eff_timeout).await
            }
            "mcp.prompt.get" | "mcp_prompt_get" => self.rpc_prompt_get(params, eff_timeout).await,
            "mcp.server.set_policy" | "mcp_set_policy" => self.rpc_set_policy(params).await,
            "mcp.server.stop" | "mcp_server_stop" => self.rpc_stop_server(params).await,
            "mcp.server.restart" | "mcp_server_restart" => {
                self.rpc_restart_server(params, eff_timeout).await
            }
            other => Err(format!("unsupported MCP RPC method: {other}")),
        }
    }

    async fn rpc_discover(&self, params: &Value) -> Result<Value, String> {
        let include_probe = params
            .get("include_loopback_probe")
            .and_then(|v| v.as_bool());
        let (mode, scanned_at_ms, servers, warnings, summary) =
            self.run_discovery_internal(include_probe).await;
        {
            let mut cache = self.cache.lock().await;
            cache.last_notified_catalog_hash = summary.catalog_hash.clone();
        }
        Ok(json!({
            "discovery_mode": mode,
            "catalog_hash": summary.catalog_hash,
            "scanned_at_ms": scanned_at_ms,
            "servers": servers,
            "warnings": warnings,
            "summary": summary,
        }))
    }

    async fn rpc_list(&self, params: &Value) -> Result<Value, String> {
        let refresh = params
            .get("refresh")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let include_probe = params
            .get("include_loopback_probe")
            .and_then(|v| v.as_bool());

        let (mode, scanned_at_ms, servers, summary) = if refresh {
            let (m, ts, srvs, _w, sum) = self.run_discovery_internal(include_probe).await;
            (m, ts, srvs, sum)
        } else {
            self.ensure_initialized().await;
            self.build_catalog_snapshot().await
        };

        Ok(json!({
            "discovery_mode": mode,
            "catalog_hash": summary.catalog_hash,
            "scanned_at_ms": scanned_at_ms,
            "servers": servers,
            "summary": summary,
        }))
    }

    async fn rpc_inspect(&self, params: &Value, timeout_ms: Option<u64>) -> Result<Value, String> {
        let server_id = required_str(params, "server_id", "mcp.inspect")?;
        let include_resources = params
            .get("include_resources")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let include_prompts = params
            .get("include_prompts")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let entry = self.find_entry(&server_id).await?;
        let pol = self.policy_snapshot();
        let overrides = self.overrides.lock().await.clone();
        enforce_can_run(&pol, &entry.config, &overrides)?;

        let outcome = self
            .supervisor
            .inspect(
                &entry.config,
                &entry.fingerprint,
                &pol,
                include_resources,
                include_prompts,
                timeout_ms,
            )
            .await?;

        let server_desc = self.descriptor_for(&server_id).await;
        Ok(json!({
            "server": server_desc,
            "server_info": outcome.server_info,
            "protocol_version": outcome.protocol_version,
            "tools": outcome.tools,
            "resources": outcome.resources,
            "prompts": outcome.prompts,
            "tools_schema_hash": outcome.tools_schema_hash,
        }))
    }

    async fn rpc_call(&self, params: &Value, timeout_ms: Option<u64>) -> Result<Value, String> {
        let server_id = required_str(params, "server_id", "mcp.call")?;
        let tool_name = required_str(params, "tool_name", "mcp.call")?;
        let arguments = params
            .get("arguments")
            .cloned()
            .filter(|v| !v.is_null())
            .unwrap_or_else(|| json!({}));
        if !arguments.is_object() {
            return Err("mcp.call 'arguments' must be a JSON object".to_string());
        }

        let entry = self.find_entry(&server_id).await?;
        let pol = self.policy_snapshot();
        let overrides = self.overrides.lock().await.clone();
        let eval = enforce_can_run(&pol, &entry.config, &overrides)?;
        if eval.call_mode == "disabled" {
            return Err(format!(
                "MCP server '{server_id}' has call_mode 'disabled'; tool calls are blocked"
            ));
        }

        // Readonly sandbox: only allow read-only, non-destructive tools (verified via inspect annotations).
        if pol.effective_level() == SandboxLevel::Readonly {
            let tool_info = match self.supervisor.cached_tool(&server_id, &tool_name).await {
                Some(t) => Some(t),
                None => {
                    let _ = self
                        .supervisor
                        .inspect(&entry.config, &entry.fingerprint, &pol, false, false, timeout_ms)
                        .await?;
                    self.supervisor.cached_tool(&server_id, &tool_name).await
                }
            };
            let is_readonly_tool = tool_info
                .and_then(|t| t.annotations)
                .map(|a| a.read_only_hint == Some(true) && a.destructive_hint != Some(true))
                .unwrap_or(false);
            if !is_readonly_tool {
                return Err(format!(
                    "readonly sandbox blocks MCP tool '{tool_name}' on '{server_id}' (requires readOnlyHint=true and destructiveHint!=true)"
                ));
            }
        }

        let outcome = self
            .supervisor
            .call_tool(
                &entry.config,
                &entry.fingerprint,
                &pol,
                &tool_name,
                arguments,
                timeout_ms,
            )
            .await?;

        Ok(json!({
            "server_id": server_id,
            "tool_name": tool_name,
            "is_error": outcome.is_error,
            "content": outcome.content,
            "structured_content": outcome.structured_content,
            "staged_files": outcome.staged_files,
            "truncated": outcome.truncated,
            "duration_ms": outcome.duration_ms,
        }))
    }

    async fn rpc_resource_read(
        &self,
        params: &Value,
        timeout_ms: Option<u64>,
    ) -> Result<Value, String> {
        let server_id = required_str(params, "server_id", "mcp.resource.read")?;
        let uri = required_str(params, "uri", "mcp.resource.read")?;

        let entry = self.find_entry(&server_id).await?;
        let pol = self.policy_snapshot();
        let overrides = self.overrides.lock().await.clone();
        let eval = enforce_can_run(&pol, &entry.config, &overrides)?;
        if eval.call_mode == "disabled" {
            return Err(format!(
                "MCP server '{server_id}' has call_mode 'disabled'"
            ));
        }

        let outcome = self
            .supervisor
            .read_resource(&entry.config, &entry.fingerprint, &pol, &uri, timeout_ms)
            .await?;

        Ok(json!({
            "server_id": server_id,
            "uri": uri,
            "contents": outcome.contents,
            "staged_files": outcome.staged_files,
            "truncated": outcome.truncated,
            "duration_ms": outcome.duration_ms,
        }))
    }

    async fn rpc_prompt_get(
        &self,
        params: &Value,
        timeout_ms: Option<u64>,
    ) -> Result<Value, String> {
        let server_id = required_str(params, "server_id", "mcp.prompt.get")?;
        let name = required_str(params, "name", "mcp.prompt.get")?;
        let arguments = params
            .get("arguments")
            .cloned()
            .filter(|v| !v.is_null())
            .unwrap_or_else(|| json!({}));

        let entry = self.find_entry(&server_id).await?;
        let pol = self.policy_snapshot();
        let overrides = self.overrides.lock().await.clone();
        let eval = enforce_can_run(&pol, &entry.config, &overrides)?;
        if eval.call_mode == "disabled" {
            return Err(format!(
                "MCP server '{server_id}' has call_mode 'disabled'"
            ));
        }

        let outcome = self
            .supervisor
            .get_prompt(
                &entry.config,
                &entry.fingerprint,
                &pol,
                &name,
                arguments,
                timeout_ms,
            )
            .await?;

        Ok(json!({
            "server_id": server_id,
            "name": name,
            "description": outcome.description,
            "messages": outcome.messages,
            "truncated": outcome.truncated,
            "duration_ms": outcome.duration_ms,
        }))
    }

    async fn rpc_set_policy(&self, params: &Value) -> Result<Value, String> {
        let pol = self.policy_snapshot();
        if pol.is_sandbox_locked() {
            return Err(
                "MCP server policy is locked by local policy (lock_sandbox = true)".to_string(),
            );
        }
        if !pol.mcp_enabled() {
            return Err("MCP proxy is disabled by local policy".to_string());
        }

        let server_id = required_str(params, "server_id", "mcp.server.set_policy")?;
        let entry = self.find_entry(&server_id).await?;

        let requested_trust: Option<String> = match params.get("trust_state").and_then(|v| v.as_str()) {
            Some(ts) => {
                let norm = ts.trim().to_ascii_lowercase();
                let canonical = match norm.as_str() {
                    "discovered" => "discovered",
                    "enabled" => "enabled",
                    "disabled" => "disabled",
                    "blocked_by_policy" | "denied" => "blocked_by_policy",
                    _ => {
                        return Err(format!(
                            "invalid trust_state '{ts}' (expected discovered, enabled, disabled, or blocked_by_policy)"
                        ));
                    }
                };
                Some(canonical.to_string())
            }
            None => params.get("enabled").and_then(|v| v.as_bool()).map(|en| {
                if en {
                    "enabled".to_string()
                } else {
                    "disabled".to_string()
                }
            }),
        };

        let requested_call_mode: Option<String> = match params.get("call_mode").and_then(|v| v.as_str()) {
            Some(cm) => {
                let norm = cm.trim().to_ascii_lowercase();
                if !matches!(
                    norm.as_str(),
                    "disabled" | "confirm_all" | "auto_readonly" | "auto_all"
                ) {
                    return Err(format!(
                        "invalid call_mode '{cm}' (expected disabled, confirm_all, auto_readonly, or auto_all)"
                    ));
                }
                Some(norm)
            }
            None => None,
        };

        if requested_trust.is_none() && requested_call_mode.is_none() {
            return Err(
                "mcp.server.set_policy requires 'trust_state' (or 'enabled') and/or 'call_mode'"
                    .to_string(),
            );
        }

        // Enforce local policy boundaries even when unlocked
        if matches_any_pattern(
            &pol.config().mcp.denied_servers,
            &entry.config.server_id,
            &entry.config.name,
        ) && requested_trust.as_deref() == Some("enabled")
        {
            return Err(format!(
                "MCP server '{server_id}' is denied by local policy [mcp].denied_servers"
            ));
        }

        let level = pol.effective_level();
        if requested_trust.as_deref() == Some("enabled") {
            if level == SandboxLevel::Readonly && entry.config.transport == McpTransportKind::Stdio {
                return Err(format!(
                    "stdio MCP server '{server_id}' cannot be enabled in readonly sandbox mode"
                ));
            }
            let in_allow = matches_any_pattern(
                &pol.config().mcp.allowed_servers,
                &entry.config.server_id,
                &entry.config.name,
            );
            if matches!(level, SandboxLevel::Readonly | SandboxLevel::Corp) && !in_allow {
                return Err(format!(
                    "MCP server '{server_id}' is not in local policy [mcp].allowed_servers (required for {} sandbox)",
                    level.as_str()
                ));
            }
            if !pol.config().mcp.allowed_servers.is_empty() && !in_allow {
                return Err(format!(
                    "MCP server '{server_id}' is not in local policy [mcp].allowed_servers"
                ));
            }
        }

        if level == SandboxLevel::Readonly
            && matches!(requested_call_mode.as_deref(), Some("auto_all"))
        {
            return Err("readonly sandbox does not permit call_mode 'auto_all'".to_string());
        }

        let persisted = {
            let mut store = self.overrides.lock().await;
            let rec = store.servers.entry(server_id.clone()).or_default();
            if let Some(ref ts) = requested_trust {
                rec.trust_state = Some(ts.clone());
            }
            if let Some(ref cm) = requested_call_mode {
                rec.call_mode = Some(cm.clone());
            }
            rec.updated_at_ms = now_ms();

            match self.policy_store_path.as_deref() {
                Some(path) => persist_policy_store(path, &store).is_ok(),
                None => false,
            }
        };

        if matches!(
            requested_trust.as_deref(),
            Some("disabled") | Some("blocked_by_policy") | Some("denied")
        ) {
            let _ = self.supervisor.stop_server(&server_id).await;
        }

        let (_, _, servers, summary) = self.build_catalog_snapshot().await;
        {
            let mut cache = self.cache.lock().await;
            cache.last_notified_catalog_hash = summary.catalog_hash.clone();
        }
        let server_desc = servers.into_iter().find(|s| s.server_id == server_id);

        Ok(json!({
            "server": server_desc,
            "persisted": persisted,
            "summary": summary,
        }))
    }

    async fn rpc_stop_server(&self, params: &Value) -> Result<Value, String> {
        let server_id = required_str(params, "server_id", "mcp.server.stop")?;
        let stopped = self.supervisor.stop_server(&server_id).await;
        let runtime_state = self.supervisor.runtime_state(&server_id).await;
        Ok(json!({
            "server_id": server_id,
            "stopped": stopped,
            "runtime_state": runtime_state,
        }))
    }

    async fn rpc_restart_server(
        &self,
        params: &Value,
        timeout_ms: Option<u64>,
    ) -> Result<Value, String> {
        let server_id = required_str(params, "server_id", "mcp.server.restart")?;
        let entry = self.find_entry(&server_id).await?;
        let pol = self.policy_snapshot();
        let overrides = self.overrides.lock().await.clone();
        enforce_can_run(&pol, &entry.config, &overrides)?;

        self.supervisor
            .restart_server(&entry.config, &entry.fingerprint, &pol, timeout_ms)
            .await?;

        let server_desc = self.descriptor_for(&server_id).await;
        Ok(json!({
            "server": server_desc,
            "restarted": true,
        }))
    }

    pub async fn build_catalog_changed_event(&self) -> CatalogChangeEvent {
        let (_, _, servers, summary) = self.build_catalog_snapshot().await;
        CatalogChangeEvent {
            catalog_hash: summary.catalog_hash.clone(),
            summary,
            servers,
        }
    }
}

// ---------------------------------------------------------------------------
// Policy Evaluation & Allow/Deny Matching
// ---------------------------------------------------------------------------

struct EffectiveServerPolicy {
    trust_state: String,
    call_mode: String,
    can_run: bool,
    denial_reason: Option<String>,
}

fn evaluate_effective_policy(
    policy: &Policy,
    config: &McpServerConfig,
    overrides: &PersistedPolicyStore,
) -> EffectiveServerPolicy {
    if !policy.mcp_enabled() {
        return EffectiveServerPolicy {
            trust_state: "disabled".to_string(),
            call_mode: "disabled".to_string(),
            can_run: false,
            denial_reason: Some("MCP proxy is disabled by local policy".to_string()),
        };
    }

    if matches_any_pattern(
        &policy.config().mcp.denied_servers,
        &config.server_id,
        &config.name,
    ) {
        return EffectiveServerPolicy {
            trust_state: "blocked_by_policy".to_string(),
            call_mode: "disabled".to_string(),
            can_run: false,
            denial_reason: Some(format!(
                "MCP server '{}' is denied by local policy [mcp].denied_servers",
                config.server_id
            )),
        };
    }

    let level = policy.effective_level();
    let allowlist = &policy.config().mcp.allowed_servers;
    let in_allowlist = matches_any_pattern(allowlist, &config.server_id, &config.name);
    let ov = overrides.servers.get(&config.server_id);

    // Readonly forbids stdio child spawning completely.
    if level == SandboxLevel::Readonly && config.transport == McpTransportKind::Stdio {
        return EffectiveServerPolicy {
            trust_state: "blocked_by_policy".to_string(),
            call_mode: "disabled".to_string(),
            can_run: false,
            denial_reason: Some(format!(
                "stdio MCP server '{}' is forbidden in readonly sandbox mode",
                config.server_id
            )),
        };
    }

    // Corp & Readonly require explicit local policy allowlist membership.
    if matches!(level, SandboxLevel::Readonly | SandboxLevel::Corp) && !in_allowlist {
        return EffectiveServerPolicy {
            trust_state: "blocked_by_policy".to_string(),
            call_mode: "disabled".to_string(),
            can_run: false,
            denial_reason: Some(format!(
                "MCP server '{}' is not in local policy [mcp].allowed_servers (required for {} sandbox)",
                config.server_id,
                level.as_str()
            )),
        };
    }

    // Non-empty explicit allowlist also restricts personal/desktop/unrestricted.
    if !allowlist.is_empty() && !in_allowlist {
        return EffectiveServerPolicy {
            trust_state: "blocked_by_policy".to_string(),
            call_mode: "disabled".to_string(),
            can_run: false,
            denial_reason: Some(format!(
                "MCP server '{}' is not in local policy [mcp].allowed_servers",
                config.server_id
            )),
        };
    }

    let trust_state = if let Some(ts) = ov.and_then(|o| o.trust_state.clone()) {
        if ts == "denied" {
            "blocked_by_policy".to_string()
        } else {
            ts
        }
    } else if in_allowlist {
        "enabled".to_string()
    } else if let Some(en) = config.explicit_enabled {
        if en {
            "enabled".to_string()
        } else {
            "disabled".to_string()
        }
    } else if policy.mcp_auto_enable_discovered() {
        "enabled".to_string()
    } else {
        "discovered".to_string()
    };

    let default_call_mode = match level {
        SandboxLevel::Unrestricted => "auto_all",
        SandboxLevel::Corp => "confirm_all",
        SandboxLevel::Readonly | SandboxLevel::Personal | SandboxLevel::Desktop => "auto_readonly",
    };

    let call_mode = if matches!(trust_state.as_str(), "disabled" | "blocked_by_policy") {
        "disabled".to_string()
    } else {
        let raw_cm = ov
            .and_then(|o| o.call_mode.clone())
            .or_else(|| config.explicit_call_mode.clone())
            .unwrap_or_else(|| default_call_mode.to_string());
        if level == SandboxLevel::Readonly && raw_cm == "auto_all" {
            "auto_readonly".to_string()
        } else {
            raw_cm
        }
    };

    let can_run = trust_state == "enabled";
    let denial_reason = if can_run {
        None
    } else {
        Some(format!(
            "MCP server '{}' is not enabled (trust_state: {}); enable it via mcp.server.set_policy first",
            config.server_id, trust_state
        ))
    };

    EffectiveServerPolicy {
        trust_state,
        call_mode,
        can_run,
        denial_reason,
    }
}

fn enforce_can_run(
    policy: &Policy,
    config: &McpServerConfig,
    overrides: &PersistedPolicyStore,
) -> Result<EffectiveServerPolicy, String> {
    let eval = evaluate_effective_policy(policy, config, overrides);
    if !eval.can_run {
        return Err(eval.denial_reason.unwrap_or_else(|| {
            format!("MCP server '{}' is not permitted by local policy", config.server_id)
        }));
    }
    Ok(eval)
}

fn matches_any_pattern(patterns: &[String], server_id: &str, name: &str) -> bool {
    patterns.iter().any(|p| server_matches_pattern(p, server_id, name))
}

fn server_matches_pattern(pattern: &str, server_id: &str, name: &str) -> bool {
    let pat = pattern.trim();
    if pat.is_empty() {
        return false;
    }
    if pat == "*" {
        return true;
    }
    if let Some(prefix) = pat.strip_suffix('*') {
        return server_id.starts_with(prefix) || name.starts_with(prefix);
    }
    pat == server_id || pat == name
}

fn required_str(params: &Value, key: &str, method: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{method} requires non-empty '{key}' string"))
}

fn load_policy_store(path: &Path) -> Option<PersistedPolicyStore> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<PersistedPolicyStore>(&raw).ok()
}

fn persist_policy_store(path: &Path, store: &PersistedPolicyStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create mcp policy dir: {e}"))?;
        }
    }
    let data = serde_json::to_vec_pretty(store)
        .map_err(|e| format!("failed to serialize mcp-policies.json: {e}"))?;
    let tmp = path.with_extension(format!("json.tmp.{}", std::process::id()));
    if std::fs::write(&tmp, &data).is_ok() {
        if std::fs::rename(&tmp, path).is_ok() {
            return Ok(());
        }
        let _ = std::fs::remove_file(&tmp);
    }
    std::fs::write(path, &data)
        .map_err(|e| format!("failed to write {}: {e}", path.display()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    fn mk_temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "neo_mcp_mgr_{label}_{}_{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    const FULL_STDIO_MOCK_PY: &str = r#"
import sys, json, base64

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
                "serverInfo": {"name": "full-stdio-mock", "version": "1.2.3"},
                "capabilities": {"tools": {}, "resources": {}, "prompts": {}}
            }
        }
        print(json.dumps(resp), flush=True)
    elif method == "notifications/initialized":
        continue
    elif method == "tools/list":
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "add",
                        "description": "Adds two numbers",
                        "inputSchema": {"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}}},
                        "annotations": {"title": "Add", "readOnlyHint": True, "destructiveHint": False}
                    },
                    {
                        "name": "big_screenshot",
                        "description": "Returns >64KiB base64 PNG",
                        "inputSchema": {"type": "object"},
                        "annotations": {"readOnlyHint": True, "destructiveHint": False}
                    }
                ]
            }
        }
        print(json.dumps(resp), flush=True)
    elif method == "resources/list":
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"resources": [{"uri": "file:///demo.txt", "name": "demo"}]}
        }
        print(json.dumps(resp), flush=True)
    elif method == "prompts/list":
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"prompts": [{"name": "greet", "description": "Greeting prompt"}]}
        }
        print(json.dumps(resp), flush=True)
    elif method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "add":
            total = int(args.get("a", 0)) + int(args.get("b", 0))
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"sum={total}"}],
                    "structuredContent": {"sum": total}
                }
            }
            print(json.dumps(resp), flush=True)
        elif name == "big_screenshot":
            raw_bytes = b"\x89PNG\r\n\x1a\n" + (b"X" * 80000)
            b64_str = base64.b64encode(raw_bytes).decode("ascii")
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [
                        {"type": "text", "text": "captured"},
                        {"type": "image", "mimeType": "image/png", "data": b64_str}
                    ]
                }
            }
            print(json.dumps(resp), flush=True)
    elif method == "resources/read":
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"contents": [{"uri": params.get("uri"), "mimeType": "text/plain", "text": "resource-body"}]}
        }
        print(json.dumps(resp), flush=True)
    elif method == "prompts/get":
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "description": "Greeting prompt",
                "messages": [{"role": "user", "content": {"type": "text", "text": f"Hello {params.get('arguments', {}).get('who', 'world')}"}}]
            }
        }
        print(json.dumps(resp), flush=True)
"#;

    #[tokio::test]
    async fn end_to_end_stdio_discover_policy_inspect_call_stage_persist_reap_and_watch() {
        let root = mk_temp_root("e2e_stdio");
        let home = root.join("home");
        let neo_cfg = home.join(".config").join("neo-agent");
        let ws = root.join("ws");
        std::fs::create_dir_all(&ws).unwrap();

        let script_path = root.join("mock_mcp.py");
        write_file(&script_path, FULL_STDIO_MOCK_PY);

        write_file(
            &home.join(".cursor/mcp.json"),
            &serde_json::to_string_pretty(&json!({
                "mcpServers": {
                    "calc": {
                        "command": "python3",
                        "args": ["-u", script_path.to_string_lossy()]
                    },
                    "calc2": {
                        "command": "python3",
                        "args": ["-u", script_path.to_string_lossy(), "--second"]
                    }
                }
            }))
            .unwrap(),
        );

        let ws_esc = ws.display().to_string().replace('\\', "\\\\");
        let policy = Arc::new(RwLock::new(
            Policy::from_toml_str(&format!(
                r#"
sandbox_level = "personal"
allowed_workspaces = ["{ws_esc}"]

[mcp]
max_concurrent_servers = 1
idle_timeout_sec = 300
"#
            ))
            .unwrap(),
        ));

        let env = DiscoveryEnv {
            os_kind: "linux".to_string(),
            home_dir: Some(home.clone()),
            neo_config_dir: Some(neo_cfg.clone()),
            appdata_dir: None,
            local_appdata_dir: None,
            is_linux_system_mode: false,
            cluster_id: Some("personal".to_string()),
            policy_path: None,
            disable_os_port_scan: true,
        };
        let store_path = root.join("mcp-policies.json");

        let mgr = McpManager::with_env(Arc::clone(&policy), env.clone(), Some(store_path.clone()));

        // 1. Discover
        let disc = mgr.dispatch_rpc("mcp.discover", &json!({}), None).await.unwrap();
        assert_eq!(disc["discovery_mode"], "configs_only");
        assert_eq!(disc["summary"]["discovered_count"], 2);
        assert_eq!(disc["summary"]["enabled_count"], 0);

        // 2. Inspect before enable MUST fail
        let inspect_err = mgr
            .dispatch_rpc("mcp.inspect", &json!({"server_id": "cursor:calc"}), None)
            .await
            .unwrap_err();
        assert!(inspect_err.contains("not enabled"), "err={inspect_err}");

        // 3. Enable via mcp.server.set_policy -> persists to mcp-policies.json
        let set_res = mgr
            .dispatch_rpc(
                "mcp.server.set_policy",
                &json!({"server_id": "cursor:calc", "trust_state": "enabled", "call_mode": "auto_readonly"}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(set_res["persisted"], true);
        assert_eq!(set_res["server"]["trust_state"], "enabled");
        assert_eq!(set_res["server"]["call_mode"], "auto_readonly");
        assert!(store_path.is_file());

        // 4. Inspect (lazy spawn + tools/resources/prompts + schema hash)
        let insp = mgr
            .dispatch_rpc(
                "mcp.inspect",
                &json!({"server_id": "cursor:calc", "include_resources": true, "include_prompts": true}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(insp["protocol_version"], "2025-06-18");
        assert_eq!(insp["server_info"]["name"], "full-stdio-mock");
        assert_eq!(insp["tools"].as_array().unwrap().len(), 2);
        assert_eq!(insp["tools"][0]["annotations"]["readOnlyHint"], true);
        assert_eq!(insp["resources"].as_array().unwrap().len(), 1);
        assert_eq!(insp["prompts"].as_array().unwrap().len(), 1);
        assert!(insp["tools_schema_hash"].as_str().unwrap().starts_with("sha256:"));
        assert_eq!(insp["server"]["runtime_state"], "running");
        assert_eq!(insp["server"]["tool_count"], 2);

        // 5. Call standard tool
        let call_res = mgr
            .dispatch_rpc(
                "mcp.call",
                &json!({"server_id": "cursor:calc", "tool_name": "add", "arguments": {"a": 19, "b": 23}}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(call_res["is_error"], false);
        assert_eq!(call_res["content"][0]["text"], "sum=42");
        assert_eq!(call_res["structured_content"]["sum"], 42);
        assert_eq!(call_res["staged_files"].as_array().unwrap().len(), 0);
        assert_eq!(call_res["truncated"], false);

        // 6. Call tool returning >64KiB base64 PNG -> stages to <ws>/.neo-mcp-tmp/
        let big_res = mgr
            .dispatch_rpc(
                "mcp.call",
                &json!({"server_id": "cursor:calc", "tool_name": "big_screenshot", "arguments": {}}),
                None,
            )
            .await
            .unwrap();
        let staged = big_res["staged_files"].as_array().unwrap();
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0]["mime_type"], "image/png");
        assert_eq!(staged[0]["size_bytes"], 80008);
        let remote_path = staged[0]["remote_path"].as_str().unwrap();
        assert!(remote_path.contains(".neo-mcp-tmp"));
        assert!(remote_path.ends_with(".png"));
        let disk_bytes = std::fs::read(remote_path).unwrap();
        assert_eq!(disk_bytes.len(), 80008);
        assert!(disk_bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        let inline_placeholder = big_res["content"][1]["data"].as_str().unwrap();
        assert!(inline_placeholder.starts_with("[staged:"));
        assert!(inline_placeholder.len() < 512);

        // 7. Resource read & Prompt get
        let res_read = mgr
            .dispatch_rpc(
                "mcp.resource.read",
                &json!({"server_id": "cursor:calc", "uri": "file:///demo.txt"}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(res_read["contents"][0]["text"], "resource-body");

        let prompt_res = mgr
            .dispatch_rpc(
                "mcp.prompt.get",
                &json!({"server_id": "cursor:calc", "name": "greet", "arguments": {"who": "Neo"}}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(prompt_res["messages"][0]["content"]["text"], "Hello Neo");

        // 8. LRU eviction when max_concurrent_servers = 1
        mgr.dispatch_rpc(
            "mcp.server.set_policy",
            &json!({"server_id": "cursor:calc2", "enabled": true}),
            None,
        )
        .await
        .unwrap();
        mgr.dispatch_rpc("mcp.inspect", &json!({"server_id": "cursor:calc2"}), None)
            .await
            .unwrap();
        assert_eq!(mgr.supervisor().running_count().await, 1);
        assert_eq!(mgr.supervisor().runtime_state("cursor:calc").await, "stopped");
        assert_eq!(mgr.supervisor().runtime_state("cursor:calc2").await, "running");

        // 9. Restart & Stop & Idle reaper
        let restart_res = mgr
            .dispatch_rpc("mcp.server.restart", &json!({"server_id": "cursor:calc2"}), None)
            .await
            .unwrap();
        assert_eq!(restart_res["restarted"], true);
        assert_eq!(restart_res["server"]["runtime_state"], "running");

        tokio::time::sleep(Duration::from_millis(60)).await;
        let reaped = mgr.supervisor().reap_idle(Duration::from_millis(40)).await;
        assert_eq!(reaped, 1);
        assert_eq!(mgr.supervisor().runtime_state("cursor:calc2").await, "stopped");

        // Re-inspect and explicitly stop
        mgr.dispatch_rpc("mcp.inspect", &json!({"server_id": "cursor:calc"}), None)
            .await
            .unwrap();
        let stop_res = mgr
            .dispatch_rpc("mcp.server.stop", &json!({"server_id": "cursor:calc"}), None)
            .await
            .unwrap();
        assert_eq!(stop_res["stopped"], true);
        assert_eq!(stop_res["runtime_state"], "stopped");

        // 10. Policy persistence survives brand new McpManager instance
        let mgr2 = McpManager::with_env(Arc::clone(&policy), env.clone(), Some(store_path.clone()));
        let list2 = mgr2.dispatch_rpc("mcp.list", &json!({}), None).await.unwrap();
        let calc_desc = list2["servers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["server_id"] == "cursor:calc")
            .unwrap();
        assert_eq!(calc_desc["trust_state"], "enabled");
        assert_eq!(calc_desc["call_mode"], "auto_readonly");

        // 11. Lightweight mtime change detection (poll_catalog_changes)
        assert!(mgr2.poll_catalog_changes().await.is_none());
        write_file(
            &neo_cfg.join("mcp.d").join("added.json"),
            r#"{"name": "added-srv", "url": "http://127.0.0.1:9999/mcp"}"#,
        );
        let ev = mgr2
            .poll_catalog_changes()
            .await
            .expect("adding mcp.d file must trigger catalog change");
        assert_eq!(ev.summary.discovered_count, 3);
        assert!(ev.servers.iter().any(|s| s.server_id == "neo_dropin:added-srv"));
        // Second poll without further changes returns None
        assert!(mgr2.poll_catalog_changes().await.is_none());

        mgr.shutdown_all().await;
        mgr2.shutdown_all().await;
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn sandbox_matrix_readonly_corp_unrestricted_and_lock_sandbox_enforcement() {
        let root = mk_temp_root("sandbox_matrix");
        let home = root.join("home");
        let neo_cfg = home.join(".config").join("neo-agent");
        let ws = root.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let ws_esc = ws.display().to_string().replace('\\', "\\\\");

        // Start a mock HTTP MCP server with 1 read-only tool and 1 destructive tool
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let http_srv = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut reader = BufReader::new(&mut stream);
                let mut req_line = String::new();
                if reader.read_line(&mut req_line).await.unwrap_or(0) == 0 {
                    continue;
                }
                let mut content_len = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).await.unwrap_or(0) == 0
                        || line == "\r\n"
                        || line == "\n"
                    {
                        break;
                    }
                    if let Some((k, v)) = line.trim_end().split_once(':') {
                        if k.trim().eq_ignore_ascii_case("content-length") {
                            content_len = v.trim().parse().unwrap_or(0);
                        }
                    }
                }
                let mut body = vec![0u8; content_len];
                if content_len > 0 {
                    let _ = reader.read_exact(&mut body).await;
                }
                let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
                    continue;
                };
                let method = msg["method"].as_str().unwrap_or("");
                let id = msg.get("id").cloned();
                let resp_val = match method {
                    "initialize" => json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": {
                            "protocolVersion": "2025-06-18",
                            "serverInfo": {"name": "ro-http-mcp"},
                            "capabilities": {"tools": {}}
                        }
                    }),
                    "notifications/initialized" => {
                        let _ = stream
                            .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                            .await;
                        continue;
                    }
                    "tools/list" => json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": {
                            "tools": [
                                {"name": "read_docs", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": true, "destructiveHint": false}},
                                {"name": "delete_all", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": false, "destructiveHint": true}}
                            ]
                        }
                    }),
                    "tools/call" => json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": {"content": [{"type": "text", "text": "ok"}]}
                    }),
                    _ => continue,
                };
                let resp_bytes = serde_json::to_vec(&resp_val).unwrap();
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    resp_bytes.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(&resp_bytes).await;
            }
        });

        write_file(
            &neo_cfg.join("mcp-servers.json"),
            &serde_json::to_string_pretty(&json!({
                "mcpServers": {
                    "docs": { "url": format!("http://127.0.0.1:{port}/mcp") },
                    "local-stdio": { "command": "python3", "args": ["-c", "pass"] },
                    "banned": { "url": format!("http://127.0.0.1:{port}/mcp") }
                }
            }))
            .unwrap(),
        );
        write_file(
            &home.join(".cursor/mcp.json"),
            r#"{"mcpServers": {"personal-ide": {"command": "echo", "args": ["hi"]}}}"#,
        );

        let env = DiscoveryEnv {
            os_kind: "linux".to_string(),
            home_dir: Some(home.clone()),
            neo_config_dir: Some(neo_cfg.clone()),
            appdata_dir: None,
            local_appdata_dir: None,
            is_linux_system_mode: false,
            cluster_id: Some("corp".to_string()),
            policy_path: None,
            disable_os_port_scan: true,
        };

        // Case 1: Default Readonly -> disabled
        let ro_default = Arc::new(RwLock::new(
            Policy::from_preset(
                SandboxLevel::Readonly,
                vec![ws.to_string_lossy().into_owned()],
                false,
            )
            .unwrap(),
        ));
        let mgr_ro_def = McpManager::with_env(ro_default, env.clone(), None);
        let disc_ro = mgr_ro_def.dispatch_rpc("mcp.discover", &json!({}), None).await.unwrap();
        assert_eq!(disc_ro["discovery_mode"], "disabled");
        assert_eq!(disc_ro["servers"].as_array().unwrap().len(), 0);

        // Case 2: Readonly explicitly enabled with allowlist -> forbids stdio, allows readOnly HTTP tool, blocks destructive tool
        let ro_allow = Arc::new(RwLock::new(
            Policy::from_toml_str(&format!(
                r#"
sandbox_level = "readonly"
allowed_workspaces = ["{ws_esc}"]

[mcp]
enabled = true
discovery_mode = "neo_only"
allowed_servers = ["neo:docs", "neo:local-stdio"]
"#
            ))
            .unwrap(),
        ));
        let mgr_ro = McpManager::with_env(ro_allow, env.clone(), None);
        mgr_ro.dispatch_rpc("mcp.discover", &json!({}), None).await.unwrap();

        let stdio_err = mgr_ro
            .dispatch_rpc("mcp.inspect", &json!({"server_id": "neo:local-stdio"}), None)
            .await
            .unwrap_err();
        assert!(stdio_err.contains("readonly"), "err={stdio_err}");

        let ok_call = mgr_ro
            .dispatch_rpc(
                "mcp.call",
                &json!({"server_id": "neo:docs", "tool_name": "read_docs", "arguments": {}}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(ok_call["content"][0]["text"], "ok");

        let destructive_err = mgr_ro
            .dispatch_rpc(
                "mcp.call",
                &json!({"server_id": "neo:docs", "tool_name": "delete_all", "arguments": {}}),
                None,
            )
            .await
            .unwrap_err();
        assert!(destructive_err.contains("readOnlyHint"), "err={destructive_err}");

        // Case 3: Corp -> neo_only (ignores cursor), deny-by-default unless in allowed_servers, denied_servers overrides
        let corp_pol = Arc::new(RwLock::new(
            Policy::from_toml_str(&format!(
                r#"
sandbox_level = "corp"
allowed_workspaces = ["{ws_esc}"]

[mcp]
allowed_servers = ["neo:docs", "neo:banned"]
denied_servers = ["neo:banned"]
"#
            ))
            .unwrap(),
        ));
        let mgr_corp = McpManager::with_env(corp_pol, env.clone(), None);
        let corp_disc = mgr_corp.dispatch_rpc("mcp.discover", &json!({}), None).await.unwrap();
        assert_eq!(corp_disc["discovery_mode"], "neo_only");
        let corp_ids: Vec<&str> = corp_disc["servers"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["server_id"].as_str())
            .collect();
        assert!(corp_ids.contains(&"neo:docs"));
        assert!(!corp_ids.contains(&"cursor:personal-ide"));

        let corp_denied = mgr_corp
            .dispatch_rpc("mcp.inspect", &json!({"server_id": "neo:banned"}), None)
            .await
            .unwrap_err();
        assert!(corp_denied.contains("denied"), "err={corp_denied}");

        let corp_not_allowed = mgr_corp
            .dispatch_rpc("mcp.inspect", &json!({"server_id": "neo:local-stdio"}), None)
            .await
            .unwrap_err();
        assert!(corp_not_allowed.contains("allowed_servers"), "err={corp_not_allowed}");

        // Case 4: lock_sandbox = true rejects mcp.server.set_policy with "locked"
        let locked_pol = Arc::new(RwLock::new(
            Policy::from_preset(
                SandboxLevel::Personal,
                vec![ws.to_string_lossy().into_owned()],
                true,
            )
            .unwrap(),
        ));
        let mgr_locked = McpManager::with_env(locked_pol, env.clone(), None);
        let lock_err = mgr_locked
            .dispatch_rpc(
                "mcp.server.set_policy",
                &json!({"server_id": "neo:docs", "trust_state": "enabled"}),
                None,
            )
            .await
            .unwrap_err();
        assert!(lock_err.to_ascii_lowercase().contains("locked"), "err={lock_err}");

        // Case 5: Unrestricted with auto_enable_discovered = true + loopback probe discovery
        let unr_pol = Arc::new(RwLock::new(
            Policy::from_toml_str(&format!(
                r#"
sandbox_level = "unrestricted"
allowed_workspaces = ["{ws_esc}"]

[mcp]
auto_enable_discovered = true
probe_ports = [{port}]
"#
            ))
            .unwrap(),
        ));
        let mgr_unr = McpManager::with_env(unr_pol, env, None);
        let unr_disc = mgr_unr
            .dispatch_rpc("mcp.discover", &json!({"include_loopback_probe": true}), None)
            .await
            .unwrap();
        let loopback_srv = unr_disc["servers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["source"] == "loopback")
            .expect("should discover loopback MCP server");
        assert_eq!(loopback_srv["trust_state"], "enabled");
        assert_eq!(loopback_srv["call_mode"], "auto_all");
        let lb_id = loopback_srv["server_id"].as_str().unwrap();
        let lb_insp = mgr_unr
            .dispatch_rpc("mcp.inspect", &json!({"server_id": lb_id}), None)
            .await
            .unwrap();
        assert_eq!(lb_insp["tools"].as_array().unwrap().len(), 2);

        mgr_ro.shutdown_all().await;
        mgr_corp.shutdown_all().await;
        mgr_unr.shutdown_all().await;
        http_srv.abort();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn guard_truncates_huge_text_and_stages_large_resource_blob() {
        let ws = mk_temp_root("stage_unit");
        let raw_blob = vec![0xABu8; 70_000];
        let b64_blob = B64.encode(&raw_blob);
        let mut content = json!([
            {"type": "text", "text": "a".repeat(2000)},
            {"type": "resource", "resource": {"uri": "file:///bin", "mimeType": "application/pdf", "blob": b64_blob}}
        ]);
        let mut sc = None;
        let (staged, truncated) =
            supervisor::guard_and_stage_content("neo:srv", &mut content, &mut sc, Some(&ws), 500, 4096);
        assert!(truncated);
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].mime_type, "application/pdf");
        assert_eq!(staged[0].size_bytes, 70_000);
        assert!(staged[0].remote_path.ends_with(".pdf"));
        assert_eq!(std::fs::read(&staged[0].remote_path).unwrap(), raw_blob);
        assert!(content[0]["text"].as_str().unwrap().ends_with("...[truncated]"));
        let _ = std::fs::remove_dir_all(&ws);
    }
}
