use crate::mcp::transport_http::probe_loopback_endpoint;
use crate::mcp::{McpServerConfig, McpServerDescriptor, McpTransportKind};
use crate::policy::Policy;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;
use url::Url;

#[derive(Debug, Clone)]
pub struct DiscoveryEnv {
    pub os_kind: String,
    pub home_dir: Option<PathBuf>,
    pub neo_config_dir: Option<PathBuf>,
    pub appdata_dir: Option<PathBuf>,
    pub local_appdata_dir: Option<PathBuf>,
    pub is_linux_system_mode: bool,
    pub cluster_id: Option<String>,
    pub policy_path: Option<PathBuf>,
    pub disable_os_port_scan: bool,
}

impl DiscoveryEnv {
    pub fn from_system(cluster_id: Option<String>, policy_path: Option<PathBuf>) -> Self {
        let is_linux_system_mode = detect_linux_system_mode(policy_path.as_deref());
        let home_dir = if is_linux_system_mode {
            None
        } else {
            crate::enroll::user_home_dir().ok()
        };
        let appdata_dir = std::env::var("APPDATA")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);
        let local_appdata_dir = std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);

        let neo_config_dir = if is_linux_system_mode {
            Some(PathBuf::from("/etc/neo-agent"))
        } else if cfg!(target_os = "windows") {
            local_appdata_dir
                .as_ref()
                .map(|p| p.join("neo-agent"))
                .or_else(|| home_dir.as_ref().map(|h| h.join(".neo-agent")))
        } else {
            home_dir
                .as_ref()
                .map(|h| h.join(".config").join("neo-agent"))
        };

        Self {
            os_kind: std::env::consts::OS.to_string(),
            home_dir,
            neo_config_dir,
            appdata_dir,
            local_appdata_dir,
            is_linux_system_mode,
            cluster_id,
            policy_path,
            disable_os_port_scan: false,
        }
    }
}

fn detect_linux_system_mode(policy_path: Option<&Path>) -> bool {
    #[cfg(target_os = "linux")]
    {
        if unsafe { libc::geteuid() == 0 } {
            return true;
        }
        if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("LOGNAME")) {
            if user.starts_with("neo-") {
                return true;
            }
        }
        if let Some(p) = policy_path {
            if p.starts_with("/etc/neo-agent") {
                return true;
            }
        }
        false
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = policy_path;
        false
    }
}

#[derive(Debug, Clone)]
pub struct DiscoveredEntry {
    pub config: McpServerConfig,
    pub dedup_key: String,
    pub duplicate_of: Option<String>,
    pub fingerprint: String,
    pub command_preview: Option<String>,
    pub url_sanitized: Option<String>,
    pub env_keys: Vec<String>,
    pub auth_required: bool,
    pub display_source_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DiscoveryOutcome {
    pub discovery_mode: String,
    pub scanned_at_ms: u64,
    pub entries: Vec<DiscoveredEntry>,
    pub warnings: Vec<String>,
    pub mtime_snapshot: MtimeSnapshot,
}

pub type FileStat = Option<(u64, u64)>;
pub type DirStatEntries = Vec<(String, FileStat)>;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MtimeSnapshot {
    pub files: BTreeMap<PathBuf, FileStat>,
    pub dirs: BTreeMap<PathBuf, DirStatEntries>,
}

impl MtimeSnapshot {
    pub fn has_changed(&self) -> bool {
        for (path, prev) in &self.files {
            if stat_file(path) != *prev {
                return true;
            }
        }
        for (dir, prev_entries) in &self.dirs {
            if stat_dropin_dir(dir) != *prev_entries {
                return true;
            }
        }
        false
    }
}

fn stat_file(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some((mtime_ms, meta.len()))
}

fn stat_dropin_dir(dir: &Path) -> Vec<(String, Option<(u64, u64)>)> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut items = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            let name = entry.file_name().to_string_lossy().into_owned();
            items.push((name, stat_file(&path)));
        }
    }
    items.sort_by(|a, b| a.0.cmp(&b.0));
    items
}

#[derive(Debug, Clone)]
struct RawCandidate {
    name: String,
    source: String,
    source_path: Option<PathBuf>,
    scope_hint: Option<String>,
    transport: McpTransportKind,
    command: Option<String>,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    extra_env_keys: Vec<String>,
    cwd: Option<String>,
    url: Option<String>,
    headers: BTreeMap<String, String>,
    explicit_enabled: Option<bool>,
    explicit_call_mode: Option<String>,
}

pub async fn discover_servers(
    policy: &Policy,
    env: &DiscoveryEnv,
    include_loopback_probe_override: Option<bool>,
) -> DiscoveryOutcome {
    let scanned_at_ms = now_ms();
    let mode = policy.mcp_discovery_mode().to_string();
    let mut warnings = Vec::new();
    let mut mtime_snapshot = MtimeSnapshot::default();

    if !policy.mcp_enabled() || mode == "disabled" {
        return DiscoveryOutcome {
            discovery_mode: mode,
            scanned_at_ms,
            entries: Vec::new(),
            warnings,
            mtime_snapshot,
        };
    }

    let mut raw_candidates: Vec<RawCandidate> = Vec::new();

    // -----------------------------------------------------------------------
    // P1: Neo registry (mcp-servers.json, mcp-servers-<cluster>.json) + mcp.d/*.json
    // -----------------------------------------------------------------------
    let mut neo_dirs: Vec<PathBuf> = Vec::new();
    if let Some(ref d) = env.neo_config_dir {
        neo_dirs.push(d.clone());
    } else if env.os_kind == "windows" {
        if let Some(ref local) = env.local_appdata_dir {
            neo_dirs.push(local.join("neo-agent"));
        }
    }
    if let Some(ref pol_path) = env.policy_path {
        if let Some(parent) = pol_path.parent() {
            if !parent.as_os_str().is_empty() && !neo_dirs.iter().any(|existing| existing == parent)
            {
                neo_dirs.push(parent.to_path_buf());
            }
        }
    }

    for dir in &neo_dirs {
        if let Some(ref cid) = env.cluster_id {
            let cluster_reg = dir.join(format!("mcp-servers-{cid}.json"));
            track_and_parse_json_file(
                &cluster_reg,
                "neo",
                None,
                &mut raw_candidates,
                &mut warnings,
                &mut mtime_snapshot,
                true,
            );
        }
        let main_reg = dir.join("mcp-servers.json");
        track_and_parse_json_file(
            &main_reg,
            "neo",
            None,
            &mut raw_candidates,
            &mut warnings,
            &mut mtime_snapshot,
            true,
        );

        let dropin_dir = dir.join("mcp.d");
        mtime_snapshot
            .dirs
            .insert(dropin_dir.clone(), stat_dropin_dir(&dropin_dir));
        if dropin_dir.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&dropin_dir) {
                let mut files: Vec<PathBuf> = rd
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.is_file()
                            && p.extension()
                                .and_then(|e| e.to_str())
                                .map(|ext| ext.eq_ignore_ascii_case("json"))
                                .unwrap_or(false)
                    })
                    .collect();
                files.sort();
                for file in files {
                    track_and_parse_json_file(
                        &file,
                        "neo_dropin",
                        None,
                        &mut raw_candidates,
                        &mut warnings,
                        &mut mtime_snapshot,
                        true,
                    );
                }
            }
        }
    }

    // Extra config paths explicitly declared in local policy.toml (always allowed when MCP enabled)
    for extra in &policy.config().mcp.extra_config_paths {
        let trimmed = extra.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = expand_tilde_path(trimmed, env.home_dir.as_deref());
        let is_toml = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.eq_ignore_ascii_case("toml"))
            .unwrap_or(false);
        if is_toml {
            track_and_parse_codex_toml(
                &path,
                "custom",
                &mut raw_candidates,
                &mut warnings,
                &mut mtime_snapshot,
            );
        } else {
            track_and_parse_json_file(
                &path,
                "custom",
                None,
                &mut raw_candidates,
                &mut warnings,
                &mut mtime_snapshot,
                true,
            );
        }
    }

    // -----------------------------------------------------------------------
    // P2: Workspace configs & Host IDE/CLI configs
    // -----------------------------------------------------------------------
    if mode == "configs_only" || mode == "configs_and_loopback" {
        // Workspace configs inside policy.canonical_workspaces()
        for ws in policy.canonical_workspaces() {
            let ws_str = ws.to_string_lossy().into_owned();
            for rel in [".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json"] {
                let p = ws.join(rel);
                track_and_parse_json_file(
                    &p,
                    "workspace",
                    Some(ws_str.as_str()),
                    &mut raw_candidates,
                    &mut warnings,
                    &mut mtime_snapshot,
                    false,
                );
            }
        }

        // Linux system mode boundary: NEVER scan other users' /home/* host configs!
        if !env.is_linux_system_mode {
            if let Some(ref home) = env.home_dir {
                // 1. Claude Desktop
                if let Some(claude_desktop) = claude_desktop_config_path(env, home) {
                    track_and_parse_json_file(
                        &claude_desktop,
                        "claude_desktop",
                        None,
                        &mut raw_candidates,
                        &mut warnings,
                        &mut mtime_snapshot,
                        false,
                    );
                }

                // 2. Claude Code (~/.claude.json + ~/.claude/settings.json + ~/.claude/mcp.json)
                track_and_parse_claude_code_json(
                    &home.join(".claude.json"),
                    &mut raw_candidates,
                    &mut warnings,
                    &mut mtime_snapshot,
                );
                track_and_parse_json_file(
                    &home.join(".claude").join("settings.json"),
                    "claude_code",
                    None,
                    &mut raw_candidates,
                    &mut warnings,
                    &mut mtime_snapshot,
                    false,
                );
                track_and_parse_json_file(
                    &home.join(".claude").join("mcp.json"),
                    "claude_code",
                    None,
                    &mut raw_candidates,
                    &mut warnings,
                    &mut mtime_snapshot,
                    false,
                );

                // 3. Cursor
                track_and_parse_json_file(
                    &home.join(".cursor").join("mcp.json"),
                    "cursor",
                    None,
                    &mut raw_candidates,
                    &mut warnings,
                    &mut mtime_snapshot,
                    false,
                );

                // 4. Codex CLI (~/.codex/config.toml)
                track_and_parse_codex_toml(
                    &home.join(".codex").join("config.toml"),
                    "codex",
                    &mut raw_candidates,
                    &mut warnings,
                    &mut mtime_snapshot,
                );

                // 5. VS Code (User/mcp.json & User/settings.json)
                for (path, is_settings) in vscode_config_paths(env, home) {
                    if is_settings {
                        track_and_parse_vscode_settings(
                            &path,
                            &mut raw_candidates,
                            &mut warnings,
                            &mut mtime_snapshot,
                        );
                    } else {
                        track_and_parse_json_file(
                            &path,
                            "vscode",
                            None,
                            &mut raw_candidates,
                            &mut warnings,
                            &mut mtime_snapshot,
                            false,
                        );
                    }
                }

                // 6. Antigravity & Gemini
                track_and_parse_json_file(
                    &home
                        .join(".gemini")
                        .join("antigravity")
                        .join("mcp_config.json"),
                    "antigravity",
                    None,
                    &mut raw_candidates,
                    &mut warnings,
                    &mut mtime_snapshot,
                    false,
                );
                track_and_parse_json_file(
                    &home.join(".gemini").join("settings.json"),
                    "gemini",
                    None,
                    &mut raw_candidates,
                    &mut warnings,
                    &mut mtime_snapshot,
                    false,
                );

                // 7. Windsurf
                track_and_parse_json_file(
                    &home
                        .join(".codeium")
                        .join("windsurf")
                        .join("mcp_config.json"),
                    "windsurf",
                    None,
                    &mut raw_candidates,
                    &mut warnings,
                    &mut mtime_snapshot,
                    false,
                );

                // 8. Zed
                track_and_parse_zed_settings(
                    &home.join(".config").join("zed").join("settings.json"),
                    &mut raw_candidates,
                    &mut warnings,
                    &mut mtime_snapshot,
                );
            }
        }
    }

    // -----------------------------------------------------------------------
    // P3: Optional Loopback Port Heuristic Probe
    // -----------------------------------------------------------------------
    let wants_probe = match include_loopback_probe_override {
        Some(v) => v,
        None => mode == "configs_and_loopback",
    };
    if wants_probe {
        if !policy.mcp_allow_loopback_probe() {
            warnings.push(
                "loopback port probe requested but disabled by local policy (allow_loopback_probe = false)"
                    .to_string(),
            );
        } else {
            let loopback_hits =
                discover_loopback_mcp_servers(&policy.config().mcp.probe_ports, env.disable_os_port_scan)
                    .await;
            raw_candidates.extend(loopback_hits);
        }
    }

    // -----------------------------------------------------------------------
    // Loop Prevention, Stable IDs, Redaction, Fingerprinting & Deduplication
    // -----------------------------------------------------------------------
    let mut entries = Vec::new();
    let mut used_ids: HashSet<String> = HashSet::new();
    let mut seen_dedup: HashMap<String, String> = HashMap::new();

    for cand in raw_candidates {
        if is_neo_self_loop(&cand) {
            continue;
        }

        let slug = slugify(&cand.name);
        let base_id = format!("{}:{slug}", cand.source);
        let server_id = if !used_ids.contains(&base_id) {
            base_id
        } else {
            let disambig_input = format!(
                "{}|{}|{}|{}",
                cand.source_path
                    .as_ref()
                    .map(|p| p.to_string_lossy())
                    .unwrap_or_default(),
                cand.scope_hint.as_deref().unwrap_or(""),
                cand.command.as_deref().unwrap_or(""),
                cand.url.as_deref().unwrap_or("")
            );
            let short = short_sha256_hex(&disambig_input, 6);
            let mut candidate_id = format!("{}:{slug}-{short}", cand.source);
            let mut n = 2usize;
            while used_ids.contains(&candidate_id) {
                candidate_id = format!("{}:{slug}-{short}-{n}", cand.source);
                n += 1;
            }
            candidate_id
        };
        used_ids.insert(server_id.clone());

        let (command_preview, cli_had_secret) = match cand.command.as_deref() {
            Some(cmd) => {
                let (preview, had_secret) = redact_command_preview(cmd, &cand.args);
                (Some(preview), had_secret)
            }
            None => (None, false),
        };

        let (url_sanitized, url_had_secret) = match cand.url.as_deref() {
            Some(u) => {
                let (san, had_secret) = sanitize_url(u);
                (Some(san), had_secret)
            }
            None => (None, false),
        };

        let mut env_keys_set: BTreeSet<String> = cand.env.keys().cloned().collect();
        for k in &cand.extra_env_keys {
            if !k.trim().is_empty() {
                env_keys_set.insert(k.trim().to_string());
            }
        }
        let env_keys: Vec<String> = env_keys_set.into_iter().collect();

        let auth_required = cli_had_secret
            || url_had_secret
            || has_auth_headers(&cand.headers)
            || env_keys.iter().any(|k| is_secret_key_name(k));

        let dedup_key = compute_dedup_key(
            cand.transport,
            cand.command.as_deref(),
            &cand.args,
            url_sanitized.as_deref(),
        );
        let duplicate_of = if let Some(primary) = seen_dedup.get(&dedup_key) {
            Some(primary.clone())
        } else {
            seen_dedup.insert(dedup_key.clone(), server_id.clone());
            None
        };

        let fingerprint = compute_server_fingerprint(
            cand.transport,
            cand.command.as_deref(),
            &cand.args,
            &cand.env,
            cand.url.as_deref(),
            &cand.headers,
            cand.cwd.as_deref(),
        );

        let display_source_path = cand
            .source_path
            .as_ref()
            .map(|p| shorten_home_path(p, env.home_dir.as_deref()));

        let config = McpServerConfig {
            server_id,
            name: cand.name,
            source: cand.source,
            transport: cand.transport,
            command: cand.command,
            args: cand.args,
            env: cand.env,
            cwd: cand.cwd,
            url: cand.url,
            headers: cand.headers,
            explicit_enabled: cand.explicit_enabled,
            explicit_call_mode: cand.explicit_call_mode,
            discovered_at_ms: scanned_at_ms,
        };

        entries.push(DiscoveredEntry {
            config,
            dedup_key,
            duplicate_of,
            fingerprint,
            command_preview,
            url_sanitized,
            env_keys,
            auth_required,
            display_source_path,
        });
    }

    DiscoveryOutcome {
        discovery_mode: mode,
        scanned_at_ms,
        entries,
        warnings,
        mtime_snapshot,
    }
}

// ---------------------------------------------------------------------------
// OS Config Paths
// ---------------------------------------------------------------------------

fn claude_desktop_config_path(env: &DiscoveryEnv, home: &Path) -> Option<PathBuf> {
    match env.os_kind.as_str() {
        "macos" => Some(
            home.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"),
        ),
        "windows" => env
            .appdata_dir
            .as_ref()
            .map(|a| a.join("Claude").join("claude_desktop_config.json"))
            .or_else(|| {
                Some(
                    home.join("AppData")
                        .join("Roaming")
                        .join("Claude")
                        .join("claude_desktop_config.json"),
                )
            }),
        _ => Some(
            home.join(".config")
                .join("Claude")
                .join("claude_desktop_config.json"),
        ),
    }
}

fn vscode_config_paths(env: &DiscoveryEnv, home: &Path) -> Vec<(PathBuf, bool)> {
    let base = match env.os_kind.as_str() {
        "macos" => home
            .join("Library")
            .join("Application Support")
            .join("Code")
            .join("User"),
        "windows" => env
            .appdata_dir
            .as_ref()
            .map(|a| a.join("Code").join("User"))
            .unwrap_or_else(|| {
                home.join("AppData")
                    .join("Roaming")
                    .join("Code")
                    .join("User")
            }),
        _ => home.join(".config").join("Code").join("User"),
    };
    vec![
        (base.join("mcp.json"), false),
        (base.join("settings.json"), true),
    ]
}

fn expand_tilde_path(raw: &str, home: Option<&Path>) -> PathBuf {
    if raw == "~" {
        if let Some(h) = home {
            return h.to_path_buf();
        }
    } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        if let Some(h) = home {
            return h.join(rest);
        }
    }
    PathBuf::from(raw)
}

fn shorten_home_path(path: &Path, home: Option<&Path>) -> String {
    if let Some(h) = home {
        if let Ok(rel) = path.strip_prefix(h) {
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if rel_str.is_empty() {
                return "~".to_string();
            }
            return format!("~/{rel_str}");
        }
    }
    path.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// Config Parsers (JSON / JSONC / Codex TOML / Claude Code / VS Code / Zed)
// ---------------------------------------------------------------------------

fn track_and_parse_json_file(
    path: &Path,
    source: &str,
    default_cwd: Option<&str>,
    out: &mut Vec<RawCandidate>,
    warnings: &mut Vec<String>,
    snapshot: &mut MtimeSnapshot,
    allow_single_server_object: bool,
) {
    snapshot.files.insert(path.to_path_buf(), stat_file(path));
    if !path.is_file() {
        return;
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            warnings.push(format!("failed to read {}: {e}", path.display()));
            return;
        }
    };
    let parsed: Value = match parse_json_or_jsonc(&raw) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("invalid JSON in {}: {e}", path.display()));
            return;
        }
    };

    let Some(obj) = parsed.as_object() else {
        return;
    };

    if let Some(map) = obj
        .get("mcpServers")
        .or_else(|| obj.get("mcp_servers"))
        .and_then(|v| v.as_object())
    {
        parse_server_map(map, source, path, default_cwd, None, out, allow_single_server_object);
        return;
    }

    if let Some(servers_val) = obj.get("servers") {
        if let Some(map) = servers_val.as_object() {
            parse_server_map(map, source, path, default_cwd, None, out, allow_single_server_object);
            return;
        }
        if let Some(arr) = servers_val.as_array() {
            for (idx, item) in arr.iter().enumerate() {
                let fallback_name = format!("server-{}", idx + 1);
                let name = item
                    .get("name")
                    .or_else(|| item.get("id"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(fallback_name);
                if let Some(cand) = parse_server_entry(
                    &name,
                    item,
                    source,
                    path,
                    default_cwd,
                    None,
                    allow_single_server_object,
                ) {
                    out.push(cand);
                }
            }
            return;
        }
    }

    if allow_single_server_object
        && (obj.get("command").is_some()
            || obj.get("url").is_some()
            || obj.get("serverUrl").is_some()
            || obj.get("httpUrl").is_some())
    {
        let fallback = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("server")
            .to_string();
        let name = obj
            .get("name")
            .or_else(|| obj.get("id"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback);
        if let Some(cand) = parse_server_entry(
            &name,
            &parsed,
            source,
            path,
            default_cwd,
            None,
            true,
        ) {
            out.push(cand);
        }
    }
}

fn track_and_parse_claude_code_json(
    path: &Path,
    out: &mut Vec<RawCandidate>,
    warnings: &mut Vec<String>,
    snapshot: &mut MtimeSnapshot,
) {
    snapshot.files.insert(path.to_path_buf(), stat_file(path));
    if !path.is_file() {
        return;
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            warnings.push(format!("failed to read {}: {e}", path.display()));
            return;
        }
    };
    let parsed: Value = match parse_json_or_jsonc(&raw) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("invalid JSON in {}: {e}", path.display()));
            return;
        }
    };
    let Some(obj) = parsed.as_object() else {
        return;
    };

    if let Some(map) = obj.get("mcpServers").and_then(|v| v.as_object()) {
        parse_server_map(map, "claude_code", path, None, None, out, false);
    }

    if let Some(projects) = obj.get("projects").and_then(|v| v.as_object()) {
        let mut proj_keys: Vec<&String> = projects.keys().collect();
        proj_keys.sort();
        for proj_path in proj_keys {
            if let Some(proj_obj) = projects.get(proj_path).and_then(|v| v.as_object()) {
                if let Some(map) = proj_obj.get("mcpServers").and_then(|v| v.as_object()) {
                    let cwd_hint = if Path::new(proj_path).is_dir() {
                        Some(proj_path.as_str())
                    } else {
                        None
                    };
                    parse_server_map(
                        map,
                        "claude_code",
                        path,
                        cwd_hint,
                        Some(proj_path.as_str()),
                        out,
                        false,
                    );
                }
            }
        }
    }
}

fn track_and_parse_vscode_settings(
    path: &Path,
    out: &mut Vec<RawCandidate>,
    warnings: &mut Vec<String>,
    snapshot: &mut MtimeSnapshot,
) {
    snapshot.files.insert(path.to_path_buf(), stat_file(path));
    if !path.is_file() {
        return;
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            warnings.push(format!("failed to read {}: {e}", path.display()));
            return;
        }
    };
    let parsed: Value = match parse_json_or_jsonc(&raw) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("invalid JSON in {}: {e}", path.display()));
            return;
        }
    };
    let Some(obj) = parsed.as_object() else {
        return;
    };

    if let Some(map) = obj
        .get("mcp")
        .and_then(|m| m.get("servers"))
        .and_then(|s| s.as_object())
    {
        parse_server_map(map, "vscode", path, None, None, out, false);
    }
    if let Some(map) = obj.get("mcp.servers").and_then(|s| s.as_object()) {
        parse_server_map(map, "vscode", path, None, None, out, false);
    }
}

fn track_and_parse_zed_settings(
    path: &Path,
    out: &mut Vec<RawCandidate>,
    warnings: &mut Vec<String>,
    snapshot: &mut MtimeSnapshot,
) {
    snapshot.files.insert(path.to_path_buf(), stat_file(path));
    if !path.is_file() {
        return;
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            warnings.push(format!("failed to read {}: {e}", path.display()));
            return;
        }
    };
    let parsed: Value = match parse_json_or_jsonc(&raw) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("invalid JSON in {}: {e}", path.display()));
            return;
        }
    };
    let Some(map) = parsed
        .get("context_servers")
        .and_then(|v| v.as_object())
    else {
        return;
    };

    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    for name in keys {
        let Some(entry) = map.get(name) else { continue };
        let Some(obj) = entry.as_object() else { continue };
        if obj.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
            continue;
        }
        // Zed supports nested command: { path, args, env } as well as flat command/url.
        if let Some(cmd_obj) = obj.get("command").and_then(|v| v.as_object()) {
            let Some(cmd_path) = cmd_obj
                .get("path")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let args = extract_string_array(cmd_obj.get("args"));
            let env = extract_string_map(cmd_obj.get("env"));
            out.push(RawCandidate {
                name: name.clone(),
                source: "zed".to_string(),
                source_path: Some(path.to_path_buf()),
                scope_hint: None,
                transport: McpTransportKind::Stdio,
                command: Some(cmd_path.to_string()),
                args,
                env,
                extra_env_keys: Vec::new(),
                cwd: obj
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                url: None,
                headers: BTreeMap::new(),
                explicit_enabled: None,
                explicit_call_mode: None,
            });
        } else if let Some(cand) = parse_server_entry(name, entry, "zed", path, None, None, false) {
            out.push(cand);
        }
    }
}

fn track_and_parse_codex_toml(
    path: &Path,
    source: &str,
    out: &mut Vec<RawCandidate>,
    warnings: &mut Vec<String>,
    snapshot: &mut MtimeSnapshot,
) {
    snapshot.files.insert(path.to_path_buf(), stat_file(path));
    if !path.is_file() {
        return;
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            warnings.push(format!("failed to read {}: {e}", path.display()));
            return;
        }
    };
    let doc: toml::Value = match toml::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("invalid TOML in {}: {e}", path.display()));
            return;
        }
    };
    let Some(servers) = doc.get("mcp_servers").and_then(|v| v.as_table()) else {
        return;
    };

    let mut keys: Vec<&String> = servers.keys().collect();
    keys.sort();
    for name in keys {
        let Some(tbl) = servers.get(name).and_then(|v| v.as_table()) else {
            continue;
        };
        if tbl.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
            continue;
        }
        let command = tbl
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let args: Vec<String> = tbl
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let mut env = BTreeMap::new();
        if let Some(env_tbl) = tbl.get("env").and_then(|v| v.as_table()) {
            for (k, v) in env_tbl {
                if let Some(s) = v.as_str() {
                    env.insert(k.clone(), s.to_string());
                }
            }
        }
        let cwd = tbl
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let url = tbl
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let mut headers = BTreeMap::new();
        for hdr_key in ["http_headers", "headers"] {
            if let Some(htbl) = tbl.get(hdr_key).and_then(|v| v.as_table()) {
                for (k, v) in htbl {
                    if let Some(s) = v.as_str() {
                        headers.insert(k.clone(), s.to_string());
                    }
                }
            }
        }

        let mut extra_env_keys = Vec::new();
        if let Some(var_name) = tbl
            .get("bearer_token_env_var")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            extra_env_keys.push(var_name.to_string());
            if let Ok(tok) = std::env::var(var_name) {
                if !tok.is_empty() {
                    headers.insert("Authorization".to_string(), format!("Bearer {tok}"));
                }
            } else {
                // Keep auth_required detection accurate even when env var isn't set yet
                headers.entry("Authorization".to_string()).or_default();
            }
        }
        if let Some(env_hdrs) = tbl.get("env_http_headers").and_then(|v| v.as_table()) {
            for (hdr_name, var_val) in env_hdrs {
                if let Some(var_name) = var_val.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    extra_env_keys.push(var_name.to_string());
                    if let Ok(val) = std::env::var(var_name) {
                        if !val.is_empty() {
                            headers.insert(hdr_name.clone(), val);
                        }
                    }
                }
            }
        }

        let explicit_transport = tbl
            .get("transport")
            .or_else(|| tbl.get("type"))
            .and_then(|v| v.as_str());

        let Some(transport) =
            resolve_transport(explicit_transport, command.as_deref(), url.as_deref())
        else {
            continue;
        };

        out.push(RawCandidate {
            name: name.clone(),
            source: source.to_string(),
            source_path: Some(path.to_path_buf()),
            scope_hint: None,
            transport,
            command,
            args,
            env,
            extra_env_keys,
            cwd,
            url,
            headers,
            explicit_enabled: None,
            explicit_call_mode: None,
        });
    }
}

fn parse_server_map(
    map: &serde_json::Map<String, Value>,
    source: &str,
    path: &Path,
    default_cwd: Option<&str>,
    scope_hint: Option<&str>,
    out: &mut Vec<RawCandidate>,
    allow_explicit_policy: bool,
) {
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    for name in keys {
        if let Some(entry) = map.get(name) {
            if let Some(cand) = parse_server_entry(
                name,
                entry,
                source,
                path,
                default_cwd,
                scope_hint,
                allow_explicit_policy,
            ) {
                out.push(cand);
            }
        }
    }
}

fn parse_server_entry(
    name: &str,
    entry: &Value,
    source: &str,
    path: &Path,
    default_cwd: Option<&str>,
    scope_hint: Option<&str>,
    allow_explicit_policy: bool,
) -> Option<RawCandidate> {
    let obj = entry.as_object()?;
    if obj.get("disabled").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }

    let command = obj
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let args = extract_string_array(obj.get("args"));
    let env = extract_string_map(obj.get("env"));
    let cwd = obj
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| default_cwd.map(|s| s.to_string()));
    let url = obj
        .get("url")
        .or_else(|| obj.get("serverUrl"))
        .or_else(|| obj.get("httpUrl"))
        .or_else(|| obj.get("endpoint"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut headers = extract_string_map(obj.get("headers"));
    for (k, v) in extract_string_map(obj.get("httpHeaders")) {
        headers.insert(k, v);
    }

    let explicit_transport = obj
        .get("transport")
        .or_else(|| obj.get("type"))
        .and_then(|v| v.as_str());

    let transport = resolve_transport(explicit_transport, command.as_deref(), url.as_deref())?;

    let explicit_enabled = if allow_explicit_policy {
        obj.get("enabled").and_then(|v| v.as_bool())
    } else {
        None
    };
    let explicit_call_mode = if allow_explicit_policy {
        obj.get("call_mode")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    };

    Some(RawCandidate {
        name: name.to_string(),
        source: source.to_string(),
        source_path: Some(path.to_path_buf()),
        scope_hint: scope_hint.map(|s| s.to_string()),
        transport,
        command,
        args,
        env,
        extra_env_keys: Vec::new(),
        cwd,
        url,
        headers,
        explicit_enabled,
        explicit_call_mode,
    })
}

fn resolve_transport(
    explicit: Option<&str>,
    command: Option<&str>,
    url: Option<&str>,
) -> Option<McpTransportKind> {
    if let Some(t) = explicit {
        match t.trim().to_ascii_lowercase().as_str() {
            "stdio" if command.is_some() => return Some(McpTransportKind::Stdio),
            "sse" if url.is_some() => return Some(McpTransportKind::Sse),
            "http" | "streamable_http" | "streamable-http" | "streamablehttp" if url.is_some() => {
                return Some(McpTransportKind::StreamableHttp);
            }
            _ => {}
        }
    }
    if command.is_some() {
        return Some(McpTransportKind::Stdio);
    }
    if let Some(u) = url {
        let lower = u.to_ascii_lowercase();
        let path_part = lower.split('?').next().unwrap_or(&lower);
        if path_part.ends_with("/sse") || path_part.contains("/sse/") {
            return Some(McpTransportKind::Sse);
        }
        return Some(McpTransportKind::StreamableHttp);
    }
    None
}

fn extract_string_array(val: Option<&Value>) -> Vec<String> {
    val.and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(|s| s.to_string())
                        .or_else(|| item.as_i64().map(|n| n.to_string()))
                        .or_else(|| item.as_u64().map(|n| n.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn extract_string_map(val: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(obj) = val.and_then(|v| v.as_object()) {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                out.insert(k.clone(), s.to_string());
            } else if let Some(n) = v.as_i64() {
                out.insert(k.clone(), n.to_string());
            } else if let Some(b) = v.as_bool() {
                out.insert(k.clone(), b.to_string());
            }
        }
    }
    out
}

/// Parses strict JSON first, falling back to stripping JSONC comments (`//`, `/* ... */`) and
/// trailing commas (common in VS Code / Zed configs).
pub(crate) fn parse_json_or_jsonc(raw: &str) -> Result<Value, String> {
    if let Ok(v) = serde_json::from_str::<Value>(raw) {
        return Ok(v);
    }
    let stripped = strip_jsonc(raw);
    serde_json::from_str::<Value>(&stripped).map_err(|e| e.to_string())
}

fn strip_jsonc(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut no_comments = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut in_string = false;
    let mut escaped = false;

    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            no_comments.push(b);
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        if b == b'"' {
            in_string = true;
            no_comments.push(b);
            i += 1;
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 < bytes.len() {
                i += 2;
            }
            continue;
        }
        no_comments.push(b);
        i += 1;
    }

    // Second pass: remove trailing commas before `}` or `]` outside strings.
    let mut out = Vec::with_capacity(no_comments.len());
    let mut j = 0;
    in_string = false;
    escaped = false;
    while j < no_comments.len() {
        let b = no_comments[j];
        if in_string {
            out.push(b);
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            j += 1;
            continue;
        }
        if b == b'"' {
            in_string = true;
            out.push(b);
            j += 1;
            continue;
        }
        if b == b',' {
            let mut k = j + 1;
            while k < no_comments.len() && no_comments[k].is_ascii_whitespace() {
                k += 1;
            }
            if k < no_comments.len() && (no_comments[k] == b'}' || no_comments[k] == b']') {
                j += 1;
                continue;
            }
        }
        out.push(b);
        j += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// Loop Prevention
// ---------------------------------------------------------------------------

fn is_neo_self_loop(cand: &RawCandidate) -> bool {
    // 1. Source path inside any `.neo-*` bridge folder
    if let Some(ref p) = cand.source_path {
        for comp in p.components() {
            if let Some(seg) = comp.as_os_str().to_str() {
                if seg.starts_with(".neo-") {
                    return true;
                }
            }
        }
    }

    // 2. Command / args / cwd referencing `.neo-*` bridge folder
    if let Some(ref cwd) = cand.cwd {
        if has_neo_dot_folder(cwd) {
            return true;
        }
    }
    if let Some(ref cmd) = cand.command {
        if has_neo_dot_folder(cmd) {
            return true;
        }
    }
    if cand.args.iter().any(|a| has_neo_dot_folder(a)) {
        return true;
    }

    // 3. URL pointing to Master Neo's own pinned device proxy route
    if let Some(ref u) = cand.url {
        let lower = u.to_ascii_lowercase();
        if lower.contains("/mcp/device/") {
            return true;
        }
    }

    // 4. Name/id is `neo_neo` or `neo` with Neo's own loopback hook/mcp plugin pattern
    let name_lower = cand.name.trim().to_ascii_lowercase();
    if name_lower == "neo_neo" || name_lower == "neo-bridge" {
        return true;
    }
    if name_lower == "neo" {
        if let Some(ref u) = cand.url {
            if let Ok(parsed) = Url::parse(u) {
                let is_local = parsed
                    .host_str()
                    .map(|h| {
                        let c = h.trim_start_matches('[').trim_end_matches(']');
                        c.eq_ignore_ascii_case("localhost") || c == "127.0.0.1" || c == "::1"
                    })
                    .unwrap_or(false);
                let path_lower = parsed.path().to_ascii_lowercase();
                if is_local
                    && (path_lower.contains("/mcp")
                        || path_lower.contains("/hook")
                        || path_lower.contains("/neo"))
                {
                    return true;
                }
            }
        }
        let cmd_blob = format!(
            "{} {}",
            cand.command.as_deref().unwrap_or(""),
            cand.args.join(" ")
        )
        .to_ascii_lowercase();
        if cmd_blob.contains("neo-bridge")
            || cmd_blob.contains("neo_neo")
            || cmd_blob.contains("neo-mcp")
            || cmd_blob.contains("neo-hook")
            || cmd_blob.contains("antigravity")
        {
            return true;
        }
    }

    false
}

fn has_neo_dot_folder(s: &str) -> bool {
    s.split(['/', '\\']).any(|seg| seg.starts_with(".neo-"))
}

// ---------------------------------------------------------------------------
// Secret-Stays-Local Redaction & URL Sanitization
// ---------------------------------------------------------------------------

const SECRET_FLAG_NAMES: &[&str] = &[
    "--token",
    "-token",
    "--api-key",
    "--apikey",
    "--api_key",
    "--key",
    "--password",
    "--passwd",
    "--pass",
    "-p",
    "--secret",
    "--auth",
    "--authorization",
    "--bearer",
    "--access-token",
    "--refresh-token",
    "--client-secret",
    "--private-key",
    "--cookie",
    "--dsn",
    "--connection-string",
    "--database-url",
    "--db-url",
];

const SECRET_TOKEN_PREFIXES: &[&str] = &[
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "sk-",
    "sk_",
    "pk_live_",
    "pk_test_",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xoxr-",
    "akia",
    "aiza",
    "glpat-",
    "npm_",
    "pypi-",
    "hf_",
];

pub fn sanitize_url(raw: &str) -> (String, bool) {
    let trimmed = raw.trim();
    if let Ok(mut parsed) = Url::parse(trimmed) {
        let had_userinfo = !parsed.username().is_empty() || parsed.password().is_some();
        let had_query = parsed.query().is_some();
        let _ = parsed.set_username("");
        let _ = parsed.set_password(None);
        parsed.set_query(None);
        parsed.set_fragment(None);
        return (parsed.to_string(), had_userinfo || had_query);
    }

    // Fallback sanitization for non-standard URLs
    let mut had_secret = false;
    let mut s = trimmed.to_string();
    if let Some(idx) = s.find('#') {
        s.truncate(idx);
    }
    if let Some(idx) = s.find('?') {
        had_secret = true;
        s.truncate(idx);
    }
    if let Some(scheme_end) = s.find("://") {
        let after_scheme = &s[scheme_end + 3..];
        let path_start = after_scheme.find('/').unwrap_or(after_scheme.len());
        let authority = &after_scheme[..path_start];
        if let Some(at_pos) = authority.rfind('@') {
            had_secret = true;
            let host_part = &authority[at_pos + 1..];
            let rest = &after_scheme[path_start..];
            s = format!("{}{}{}", &s[..scheme_end + 3], host_part, rest);
        }
    }
    (s, had_secret)
}

pub fn redact_command_preview(command: &str, args: &[String]) -> (String, bool) {
    let (cmd_clean, cmd_sec) = redact_single_arg(command);
    let (redacted_args, args_sec) = redact_args_stateful(args);
    let mut out = Vec::with_capacity(1 + redacted_args.len());
    out.push(cmd_clean);
    out.extend(redacted_args);
    (out.join(" "), cmd_sec || args_sec)
}

fn redact_args_stateful(args: &[String]) -> (Vec<String>, bool) {
    let mut out = Vec::with_capacity(args.len());
    let mut had_secret = false;
    let mut redact_next = false;
    let mut redact_next_header = false;

    for arg in args {
        if redact_next {
            out.push("***".to_string());
            had_secret = true;
            redact_next = false;
            continue;
        }
        if redact_next_header {
            redact_next_header = false;
            if let Some((hdr_k, _)) = arg.split_once(':') {
                if is_secret_key_name(hdr_k) {
                    out.push(format!("{}: ***", hdr_k.trim()));
                    had_secret = true;
                    continue;
                }
            }
            let (clean, sec) = redact_single_arg(arg);
            if sec {
                had_secret = true;
            }
            out.push(clean);
            continue;
        }

        let lower = arg.to_ascii_lowercase();
        if lower == "-h" || lower == "--header" {
            out.push(arg.clone());
            redact_next_header = true;
            continue;
        }
        if SECRET_FLAG_NAMES.iter().any(|f| *f == lower) {
            out.push(arg.clone());
            redact_next = true;
            continue;
        }

        let (clean, sec) = redact_single_arg(arg);
        if sec {
            had_secret = true;
        }
        out.push(clean);
    }

    (out, had_secret)
}

fn redact_single_arg(arg: &str) -> (String, bool) {
    let lower = arg.to_ascii_lowercase();

    // Bearer / Basic header token values
    if lower.starts_with("bearer ") {
        return ("Bearer ***".to_string(), true);
    }
    if lower.starts_with("basic ") {
        return ("Basic ***".to_string(), true);
    }

    // Raw URL inside CLI arg (e.g., postgres://user:pass@host/db?sslmode=require or https://host?api_key=123)
    // Check BEFORE `split_once('=')` so query params like `?sslmode=require` don't bypass URL sanitization!
    if let Some(scheme_pos) = arg.find("://") {
        let eq_pos = arg.find('=');
        if eq_pos.map(|ep| scheme_pos < ep).unwrap_or(true) {
            let (san, had_sec) = sanitize_url(arg);
            return (san, had_sec);
        }
    }

    // Header inline form like `Authorization: Bearer ...`
    if let Some((hdr_k, _)) = arg.split_once(':') {
        if !hdr_k.contains("://") && !hdr_k.contains('/') && is_secret_key_name(hdr_k) {
            return (format!("{}: ***", hdr_k.trim()), true);
        }
    }

    // `--flag=value` or `KEY=value`
    if let Some((k, v)) = arg.split_once('=') {
        let k_lower = k.to_ascii_lowercase();
        if SECRET_FLAG_NAMES.iter().any(|f| *f == k_lower)
            || is_secret_key_name(k)
            || looks_like_secret_value(v)
        {
            return (format!("{k}=***"), true);
        }
        if v.contains("://") {
            let (san, had_sec) = sanitize_url(v);
            return (format!("{k}={san}"), had_sec);
        }
    }

    // Known secret token prefixes or JWTs
    if looks_like_secret_value(arg) {
        return ("***".to_string(), true);
    }

    (arg.to_string(), false)
}

fn looks_like_secret_value(val: &str) -> bool {
    let trimmed = val.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("bearer ") || lower.starts_with("basic ") {
        return true;
    }
    if SECRET_TOKEN_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        return true;
    }
    // JWT shape: eyJ... . eyJ... . sig
    if trimmed.starts_with("eyJ") && trimmed.split('.').count() == 3 && trimmed.len() > 30 {
        return true;
    }
    false
}

fn is_secret_key_name(key: &str) -> bool {
    let lower = key.trim().to_ascii_lowercase();
    for needle in [
        "token",
        "secret",
        "password",
        "passwd",
        "api_key",
        "apikey",
        "api-key",
        "auth",
        "bearer",
        "credential",
        "private_key",
        "private-key",
        "cookie",
        "database_url",
        "db_url",
        "dsn",
    ] {
        if lower.contains(needle) {
            return true;
        }
    }
    lower == "key" || lower.ends_with("_key") || lower.ends_with("-key") || lower == "pass"
}

fn has_auth_headers(headers: &BTreeMap<String, String>) -> bool {
    headers.keys().any(|k| is_secret_key_name(k))
}

// ---------------------------------------------------------------------------
// Deduplication, Fingerprinting, Catalog Hash
// ---------------------------------------------------------------------------

pub(crate) fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "server".to_string()
    } else {
        trimmed
    }
}

fn compute_dedup_key(
    transport: McpTransportKind,
    command: Option<&str>,
    args: &[String],
    url_sanitized: Option<&str>,
) -> String {
    match transport {
        McpTransportKind::Stdio => {
            let cmd_norm = command
                .and_then(|c| Path::new(c).file_name().and_then(|s| s.to_str()))
                .or(command)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let (redacted_args, _) = redact_args_stateful(args);
            let args_norm: Vec<String> = redacted_args
                .into_iter()
                .map(|a| a.trim().to_string())
                .collect();
            format!("stdio:{cmd_norm}|{}", args_norm.join("\x1f"))
        }
        McpTransportKind::StreamableHttp | McpTransportKind::Sse => {
            let norm_url = url_sanitized
                .unwrap_or("")
                .trim()
                .trim_end_matches('/')
                .to_ascii_lowercase();
            format!("{}:{norm_url}", transport.as_str())
        }
    }
}

pub fn compute_server_fingerprint(
    transport: McpTransportKind,
    command: Option<&str>,
    args: &[String],
    env: &BTreeMap<String, String>,
    url: Option<&str>,
    headers: &BTreeMap<String, String>,
    cwd: Option<&str>,
) -> String {
    let mut h = Sha256::new();
    h.update(b"neo-mcp-fp-v1:");
    h.update(transport.as_str().as_bytes());
    h.update(b"\0");
    if let Some(c) = command {
        h.update(c.as_bytes());
    }
    h.update(b"\0");
    for a in args {
        h.update(a.as_bytes());
        h.update(b"\x1f");
    }
    h.update(b"\0");
    for (k, v) in env {
        h.update(k.as_bytes());
        h.update(b"=");
        h.update(Sha256::digest(v.as_bytes()));
        h.update(b"\x1f");
    }
    h.update(b"\0");
    if let Some(u) = url {
        h.update(u.as_bytes());
    }
    h.update(b"\0");
    for (k, v) in headers {
        h.update(k.as_bytes());
        h.update(b"=");
        h.update(Sha256::digest(v.as_bytes()));
        h.update(b"\x1f");
    }
    h.update(b"\0");
    if let Some(d) = cwd {
        h.update(d.as_bytes());
    }
    format!("sha256:{}", hex::encode(h.finalize()))
}

pub fn compute_catalog_hash(descriptors: &[McpServerDescriptor]) -> String {
    let mut sorted: Vec<&McpServerDescriptor> = descriptors.iter().collect();
    sorted.sort_by(|a, b| a.server_id.cmp(&b.server_id));
    let mut h = Sha256::new();
    h.update(b"neo-mcp-catalog-v1:");
    for d in sorted {
        h.update(d.server_id.as_bytes());
        h.update(b"|");
        h.update(d.name.as_bytes());
        h.update(b"|");
        h.update(d.source.as_bytes());
        h.update(b"|");
        h.update(d.transport.as_bytes());
        h.update(b"|");
        h.update(d.command_preview.as_deref().unwrap_or("").as_bytes());
        h.update(b"|");
        h.update(d.url_sanitized.as_deref().unwrap_or("").as_bytes());
        h.update(b"|");
        for k in &d.env_keys {
            h.update(k.as_bytes());
            h.update(b",");
        }
        h.update(if d.auth_required { b"|1|" } else { b"|0|" });
        h.update(d.trust_state.as_bytes());
        h.update(b"|");
        h.update(d.call_mode.as_bytes());
        h.update(b"|");
        h.update(d.duplicate_of.as_deref().unwrap_or("").as_bytes());
        h.update(b"|");
        h.update(d.fingerprint.as_bytes());
        h.update(b"\n");
    }
    format!("sha256:{}", hex::encode(h.finalize()))
}

fn short_sha256_hex(input: &str, hex_chars: usize) -> String {
    let full = hex::encode(Sha256::digest(input.as_bytes()));
    full.chars().take(hex_chars).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// P3: Loopback Listening Port Enumeration & Pre-Filtered MCP Handshake Probe
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct LoopbackCandidate {
    port: u16,
    process_hint: Option<String>,
}

async fn discover_loopback_mcp_servers(
    probe_ports: &[u16],
    disable_os_port_scan: bool,
) -> Vec<RawCandidate> {
    let mut by_port: BTreeMap<u16, Option<String>> = BTreeMap::new();

    if !disable_os_port_scan {
        let listeners = enumerate_loopback_listeners().await;
        for cand in listeners {
            let matches_port = probe_ports.contains(&cand.port);
            let matches_proc = cand
                .process_hint
                .as_deref()
                .map(process_looks_like_mcp)
                .unwrap_or(false);
            if matches_port || matches_proc {
                by_port.insert(cand.port, cand.process_hint);
            }
        }
    }

    for &port in probe_ports {
        if port > 0 {
            by_port.entry(port).or_insert(None);
        }
    }

    // Cap candidates to prevent slow scans
    let candidates: Vec<(u16, Option<String>)> = by_port.into_iter().take(32).collect();
    if candidates.is_empty() {
        return Vec::new();
    }

    let sem = Arc::new(Semaphore::new(8));
    let mut handles = Vec::with_capacity(candidates.len());
    for (port, proc_hint) in candidates {
        let sem = Arc::clone(&sem);
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            let hit = probe_loopback_endpoint(port, Duration::from_millis(800)).await?;
            let name = hit
                .server_name
                .or_else(|| {
                    proc_hint
                        .as_deref()
                        .and_then(extract_friendly_proc_name)
                        .map(|n| format!("{n}-{port}"))
                })
                .unwrap_or_else(|| format!("mcp-{port}"));

            Some(RawCandidate {
                name,
                source: "loopback".to_string(),
                source_path: None,
                scope_hint: Some(format!("127.0.0.1:{port}")),
                transport: hit.transport,
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                extra_env_keys: Vec::new(),
                cwd: None,
                url: Some(hit.url),
                headers: BTreeMap::new(),
                explicit_enabled: None,
                explicit_call_mode: None,
            })
        }));
    }

    let mut out = Vec::new();
    for h in handles {
        if let Ok(Some(cand)) = h.await {
            out.push(cand);
        }
    }
    out.sort_by(|a, b| a.url.cmp(&b.url));
    out
}

fn process_looks_like_mcp(hint: &str) -> bool {
    let lower = hint.to_ascii_lowercase();
    if lower.contains("neo-agent-os") || lower.contains("neo-relayd") {
        return false;
    }
    lower.contains("mcp")
}

fn extract_friendly_proc_name(hint: &str) -> Option<String> {
    let first = hint.split_whitespace().next()?;
    let base = Path::new(first)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(first);
    let slug = slugify(base);
    if slug.is_empty() || slug == "server" {
        None
    } else {
        Some(slug)
    }
}

async fn enumerate_loopback_listeners() -> Vec<LoopbackCandidate> {
    #[cfg(target_os = "linux")]
    {
        tokio::task::spawn_blocking(enumerate_linux_proc_listeners)
            .await
            .unwrap_or_default()
    }
    #[cfg(target_os = "macos")]
    {
        enumerate_macos_lsof_listeners().await
    }
    #[cfg(target_os = "windows")]
    {
        enumerate_windows_netstat_listeners().await
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "linux")]
fn enumerate_linux_proc_listeners() -> Vec<LoopbackCandidate> {
    let mut inode_to_port: HashMap<String, u16> = HashMap::new();
    for (path, is_v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
        if let Ok(content) = std::fs::read_to_string(path) {
            for line in content.lines().skip(1) {
                let cols: Vec<&str> = line.split_whitespace().collect();
                if cols.len() < 10 {
                    continue;
                }
                // State "0A" == TCP_LISTEN
                if cols[3] != "0A" {
                    continue;
                }
                let Some((ip_hex, port_hex)) = cols[1].split_once(':') else {
                    continue;
                };
                let is_loopback_or_any = if is_v6 {
                    ip_hex == "00000000000000000000000001000000"
                        || ip_hex == "00000000000000000000000000000000"
                } else {
                    ip_hex == "0100007F" || ip_hex == "00000000"
                };
                if !is_loopback_or_any {
                    continue;
                }
                if let Ok(port) = u16::from_str_radix(port_hex, 16) {
                    if port > 0 {
                        inode_to_port.insert(cols[9].to_string(), port);
                    }
                }
            }
        }
    }

    if inode_to_port.is_empty() {
        return Vec::new();
    }

    let mut port_to_hint: BTreeMap<u16, Option<String>> = BTreeMap::new();
    for &port in inode_to_port.values() {
        port_to_hint.entry(port).or_insert(None);
    }

    if let Ok(proc_dir) = std::fs::read_dir("/proc") {
        for entry in proc_dir.flatten() {
            let pid_str = entry.file_name().to_string_lossy().into_owned();
            if !pid_str.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let fd_dir = entry.path().join("fd");
            let Ok(fds) = std::fs::read_dir(&fd_dir) else {
                continue;
            };
            let mut matched_ports = Vec::new();
            for fd in fds.flatten() {
                if let Ok(link) = std::fs::read_link(fd.path()) {
                    let s = link.to_string_lossy();
                    if let Some(inode) = s
                        .strip_prefix("socket:[")
                        .and_then(|rest| rest.strip_suffix(']'))
                    {
                        if let Some(&port) = inode_to_port.get(inode) {
                            matched_ports.push(port);
                        }
                    }
                }
            }
            if matched_ports.is_empty() {
                continue;
            }
            let cmdline = std::fs::read(entry.path().join("cmdline"))
                .ok()
                .map(|bytes| {
                    bytes
                        .split(|&b| b == 0)
                        .filter(|s| !s.is_empty())
                        .map(|s| String::from_utf8_lossy(s).into_owned())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    std::fs::read_to_string(entry.path().join("comm"))
                        .ok()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                });
            for p in matched_ports {
                port_to_hint.insert(p, cmdline.clone());
            }
        }
    }

    port_to_hint
        .into_iter()
        .map(|(port, process_hint)| LoopbackCandidate { port, process_hint })
        .collect()
}

#[cfg(target_os = "macos")]
async fn enumerate_macos_lsof_listeners() -> Vec<LoopbackCandidate> {
    let Ok(Ok(out)) = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::process::Command::new("lsof")
            .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"])
            .output(),
    )
    .await
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut cur_pid = String::new();
    let mut cur_cmd = String::new();
    let mut port_pid: BTreeMap<u16, (String, String)> = BTreeMap::new();

    for line in text.lines() {
        if let Some(pid) = line.strip_prefix('p') {
            cur_pid = pid.to_string();
        } else if let Some(cmd) = line.strip_prefix('c') {
            cur_cmd = cmd.to_string();
        } else if let Some(name) = line.strip_prefix('n') {
            if let Some((host, port_str)) = name.rsplit_once(':') {
                if host == "127.0.0.1" || host == "[::1]" || host == "*" {
                    if let Ok(port) = port_str.parse::<u16>() {
                        port_pid.insert(port, (cur_pid.clone(), cur_cmd.clone()));
                    }
                }
            }
        }
    }

    let mut out_cands = Vec::new();
    for (port, (pid, cmd)) in port_pid {
        let full_cmd = if !pid.is_empty() {
            tokio::time::timeout(
                Duration::from_millis(500),
                tokio::process::Command::new("ps")
                    .args(["-p", &pid, "-o", "args="])
                    .output(),
            )
            .await
            .ok()
            .and_then(|r| r.ok())
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or(cmd)
        } else {
            cmd
        };
        out_cands.push(LoopbackCandidate {
            port,
            process_hint: if full_cmd.is_empty() {
                None
            } else {
                Some(full_cmd)
            },
        });
    }
    out_cands
}

#[cfg(target_os = "windows")]
async fn enumerate_windows_netstat_listeners() -> Vec<LoopbackCandidate> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = tokio::process::Command::new("netstat");
    cmd.args(["-ano", "-p", "tcp"])
        .creation_flags(CREATE_NO_WINDOW);
    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(2), cmd.output()).await else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }

    let mut pid_names: HashMap<String, String> = HashMap::new();
    let mut tl = tokio::process::Command::new("tasklist");
    tl.args(["/FO", "CSV", "/NH"]).creation_flags(CREATE_NO_WINDOW);
    if let Ok(Ok(tl_out)) = tokio::time::timeout(Duration::from_secs(2), tl.output()).await {
        for line in String::from_utf8_lossy(&tl_out.stdout).lines() {
            let parts: Vec<&str> = line.split("\",\"").collect();
            if parts.len() >= 2 {
                let name = parts[0].trim_matches('"').to_string();
                let pid = parts[1].trim_matches('"').to_string();
                pid_names.insert(pid, name);
            }
        }
    }

    let mut by_port: BTreeMap<u16, Option<String>> = BTreeMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 || !cols[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        let local = cols[1];
        let pid = cols[4];
        if let Some((host, port_str)) = local.rsplit_once(':') {
            if host == "127.0.0.1" || host == "[::1]" || host == "0.0.0.0" || host == "[::]" {
                if let Ok(port) = port_str.parse::<u16>() {
                    by_port.insert(port, pid_names.get(pid).cloned());
                }
            }
        }
    }

    by_port
        .into_iter()
        .map(|(port, process_hint)| LoopbackCandidate { port, process_hint })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::SandboxLevel;

    fn mk_temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "neo_mcp_disc_{label}_{}_{}",
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

    #[tokio::test]
    async fn discovers_all_cross_platform_formats_redacts_secrets_dedups_and_prevents_loops() {
        let root = mk_temp_root("all_formats");
        let home = root.join("home");
        let neo_cfg = home.join(".config").join("neo-agent");
        let ws = root.join("workspace");
        std::fs::create_dir_all(&ws).unwrap();

        // P1: Neo registry + mcp.d drop-in
        write_file(
            &neo_cfg.join("mcp-servers.json"),
            r#"{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github", "--token", "ghp_SUPERSECRETTOKEN123456"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_ENVSECRET987654",
        "LOG_LEVEL": "info"
      },
      "enabled": true
    }
  }
}"#,
        );
        write_file(
            &neo_cfg.join("mcp.d").join("local-api.json"),
            r#"{
  "name": "local-api",
  "url": "https://alice:pwSecret99@localhost:8443/mcp?api_key=queryLeak777",
  "headers": {
    "Authorization": "Bearer headerLeak888",
    "X-Custom": "plain"
  }
}"#,
        );

        // P2: Claude Desktop (Linux path) — duplicates `github` from Neo P1 + has own `postgres`
        write_file(
            &home.join(".config/Claude/claude_desktop_config.json"),
            r#"{
  "mcpServers": {
    "github": {
      "command": "/usr/local/bin/npx",
      "args": ["-y", "@modelcontextprotocol/server-github", "--token", "ghp_OTHERSECRET"],
      "env": { "GITHUB_TOKEN": "ghp_CLAUDE_SECRET" }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgres://dbuser:dbPassSecret@localhost:5432/mydb?sslmode=require"]
    },
    "neo_neo": {
      "url": "http://127.0.0.1:4242/mcp"
    }
  }
}"#,
        );

        // P2: Claude Code (~/.claude.json top-level + projects + settings.json)
        let proj_a = root.join("proj_a");
        let proj_b = root.join("proj_b");
        std::fs::create_dir_all(&proj_a).unwrap();
        std::fs::create_dir_all(&proj_b).unwrap();
        let proj_a_s = proj_a.to_string_lossy().replace('\\', "\\\\");
        let proj_b_s = proj_b.to_string_lossy().replace('\\', "\\\\");
        write_file(
            &home.join(".claude.json"),
            &format!(
                r#"{{
  "mcpServers": {{
    "fetch": {{ "command": "uvx", "args": ["mcp-server-fetch", "--api-key=sk-CLAUDECODE_KEY_999"] }}
  }},
  "projects": {{
    "{proj_a_s}": {{
      "mcpServers": {{
        "repo-tools": {{ "command": "node", "args": ["tool-a.js"] }}
      }}
    }},
    "{proj_b_s}": {{
      "mcpServers": {{
        "repo-tools": {{ "command": "node", "args": ["tool-b.js"] }}
      }}
    }}
  }}
}}"#
            ),
        );
        write_file(
            &home.join(".claude/settings.json"),
            r#"{ "mcpServers": { "neo": { "url": "http://127.0.0.1:4999/mcp" } } }"#,
        );

        // P2: Cursor
        write_file(
            &home.join(".cursor/mcp.json"),
            r#"{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/sse?token=cursorQuerySecret",
      "headers": { "X-Api-Key": "sk-CURSOR_HEADER_SECRET" }
    },
    "pinned-loop": {
      "url": "http://127.0.0.1:4100/mcp/device/dev-1/srv-1"
    }
  }
}"#,
        );

        // P2: Codex CLI (~/.codex/config.toml)
        write_file(
            &home.join(".codex/config.toml"),
            r#"
[mcp_servers.codex_stdio]
command = "python3"
args = ["-m", "my_mcp", "--secret", "mySuperSecretVal"]
env = { OPENAI_API_KEY = "sk-CODEX_ENV_SECRET" }

[mcp_servers.codex_http]
url = "https://mcp.codex.local/mcp"
http_headers = { Authorization = "Bearer codexBearerSecret" }
bearer_token_env_var = "CODEX_MCP_TOKEN"
"#,
        );

        // P2: VS Code (JSONC with comments + trailing commas, plus settings.json)
        write_file(
            &home.join(".config/Code/User/mcp.json"),
            r#"{
  // VS Code MCP servers
  "servers": {
    "vscode-fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
  },
}"#,
        );
        write_file(
            &home.join(".config/Code/User/settings.json"),
            r#"{
  /* inline comment */
  "mcp.servers": {
    "vscode-settings-srv": {
      "url": "http://127.0.0.1:9001/mcp",
    },
  },
}"#,
        );

        // P2: Antigravity + Gemini
        write_file(
            &home.join(".gemini/antigravity/mcp_config.json"),
            r#"{
  "mcpServers": {
    "ag-browser": {
      "serverUrl": "http://127.0.0.1:9222/mcp"
    },
    "bridge": {
      "command": "node",
      "args": ["/home/user/.neo-bridge/server.js"]
    }
  }
}"#,
        );
        write_file(
            &home.join(".gemini/settings.json"),
            r#"{ "mcpServers": { "gemini-docs": { "command": "uvx", "args": ["docs-mcp"] } } }"#,
        );

        // P2: Windsurf & Zed
        write_file(
            &home.join(".codeium/windsurf/mcp_config.json"),
            r#"{ "mcpServers": { "ws-search": { "command": "npx", "args": ["-y", "search-mcp", "-H", "Authorization: Bearer windsurfSecret"] } } }"#,
        );
        write_file(
            &home.join(".config/zed/settings.json"),
            r#"{
  // Zed context servers
  "context_servers": {
    "zed-rust": {
      "command": {
        "path": "rust-mcp",
        "args": ["--workspace"],
        "env": { "ZED_API_KEY": "zedSecret123" }
      }
    }
  }
}"#,
        );

        // Workspace configs
        write_file(
            &ws.join(".mcp.json"),
            r#"{ "mcpServers": { "ws-local": { "command": "node", "args": ["local-mcp.js"] } } }"#,
        );
        write_file(
            &ws.join(".neo-work/.mcp.json"),
            r#"{ "mcpServers": { "should-skip": { "command": "echo" } } }"#,
        );

        let policy = Policy::from_preset(
            SandboxLevel::Personal,
            vec![ws.to_string_lossy().into_owned()],
            false,
        )
        .unwrap();

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

        let outcome = discover_servers(&policy, &env, Some(false)).await;
        assert!(outcome.warnings.is_empty(), "warnings: {:?}", outcome.warnings);

        let ids: Vec<&str> = outcome
            .entries
            .iter()
            .map(|e| e.config.server_id.as_str())
            .collect();

        // All expected sources discovered
        assert!(ids.contains(&"neo:github"), "ids: {ids:?}");
        assert!(ids.contains(&"neo_dropin:local-api"), "ids: {ids:?}");
        assert!(ids.contains(&"workspace:ws-local"), "ids: {ids:?}");
        assert!(ids.contains(&"claude_desktop:github"), "ids: {ids:?}");
        assert!(ids.contains(&"claude_desktop:postgres"), "ids: {ids:?}");
        assert!(ids.contains(&"claude_code:fetch"), "ids: {ids:?}");
        assert!(ids.contains(&"cursor:linear"), "ids: {ids:?}");
        assert!(ids.contains(&"codex:codex_stdio"), "ids: {ids:?}");
        assert!(ids.contains(&"codex:codex_http"), "ids: {ids:?}");
        assert!(ids.contains(&"vscode:vscode-fs"), "ids: {ids:?}");
        assert!(ids.contains(&"vscode:vscode-settings-srv"), "ids: {ids:?}");
        assert!(ids.contains(&"antigravity:ag-browser"), "ids: {ids:?}");
        assert!(ids.contains(&"gemini:gemini-docs"), "ids: {ids:?}");
        assert!(ids.contains(&"windsurf:ws-search"), "ids: {ids:?}");
        assert!(ids.contains(&"zed:zed-rust"), "ids: {ids:?}");

        // Disambiguated duplicate names within same source (claude_code projects)
        let repo_tool_ids: Vec<&str> = ids
            .iter()
            .copied()
            .filter(|id| id.starts_with("claude_code:repo-tools"))
            .collect();
        assert_eq!(repo_tool_ids.len(), 2);
        assert_ne!(repo_tool_ids[0], repo_tool_ids[1]);

        // Loop prevention skipped all Neo self-loop configs
        assert!(!ids.iter().any(|id| id.contains("neo_neo")));
        assert!(!ids.contains(&"claude_code:neo"));
        assert!(!ids.iter().any(|id| id.contains("pinned-loop")));
        assert!(!ids.iter().any(|id| id.contains("bridge")));

        // Deduplication: claude_desktop:github points to higher-priority neo:github
        let neo_gh = outcome
            .entries
            .iter()
            .find(|e| e.config.server_id == "neo:github")
            .unwrap();
        let claude_gh = outcome
            .entries
            .iter()
            .find(|e| e.config.server_id == "claude_desktop:github")
            .unwrap();
        assert_eq!(neo_gh.duplicate_of, None);
        assert_eq!(claude_gh.duplicate_of.as_deref(), Some("neo:github"));

        // Verify Codex HTTP bearer_token_env_var recorded in env_keys & auth_required
        let codex_http = outcome
            .entries
            .iter()
            .find(|e| e.config.server_id == "codex:codex_http")
            .unwrap();
        assert!(codex_http.env_keys.contains(&"CODEX_MCP_TOKEN".to_string()));
        assert!(codex_http.auth_required);
        assert_eq!(codex_http.config.transport, McpTransportKind::StreamableHttp);

        // Verify Cursor SSE transport inference
        let cursor_linear = outcome
            .entries
            .iter()
            .find(|e| e.config.server_id == "cursor:linear")
            .unwrap();
        assert_eq!(cursor_linear.config.transport, McpTransportKind::Sse);
        assert_eq!(
            cursor_linear.url_sanitized.as_deref(),
            Some("https://mcp.linear.app/sse")
        );
        assert!(cursor_linear.auth_required);

        // Verify ZERO secrets leak in ANY external descriptor fields!
        let forbidden_secrets = [
            "ghp_SUPERSECRETTOKEN123456",
            "ghp_ENVSECRET987654",
            "pwSecret99",
            "queryLeak777",
            "headerLeak888",
            "ghp_OTHERSECRET",
            "ghp_CLAUDE_SECRET",
            "dbPassSecret",
            "sk-CLAUDECODE_KEY_999",
            "cursorQuerySecret",
            "sk-CURSOR_HEADER_SECRET",
            "mySuperSecretVal",
            "sk-CODEX_ENV_SECRET",
            "codexBearerSecret",
            "windsurfSecret",
            "zedSecret123",
        ];

        for entry in &outcome.entries {
            let desc = McpServerDescriptor {
                server_id: entry.config.server_id.clone(),
                name: entry.config.name.clone(),
                source: entry.config.source.clone(),
                source_path: entry.display_source_path.clone(),
                transport: entry.config.transport.as_str().to_string(),
                command_preview: entry.command_preview.clone(),
                url_sanitized: entry.url_sanitized.clone(),
                env_keys: entry.env_keys.clone(),
                auth_required: entry.auth_required,
                trust_state: "discovered".to_string(),
                call_mode: "auto_readonly".to_string(),
                runtime_state: "stopped".to_string(),
                tool_count: None,
                dedup_key: entry.dedup_key.clone(),
                duplicate_of: entry.duplicate_of.clone(),
                fingerprint: entry.fingerprint.clone(),
                last_error: None,
                discovered_at_ms: entry.config.discovered_at_ms,
            };
            let serialized = serde_json::to_string(&desc).unwrap();
            for secret in forbidden_secrets {
                assert!(
                    !serialized.contains(secret),
                    "SECRET LEAKED in descriptor for {}: found '{}' in {}",
                    entry.config.server_id,
                    secret,
                    serialized
                );
            }
        }

        // Verify local internal config still preserves real secrets for spawning
        assert_eq!(
            neo_gh.config.env.get("GITHUB_PERSONAL_ACCESS_TOKEN").map(String::as_str),
            Some("ghp_ENVSECRET987654")
        );
        assert!(neo_gh.command_preview.as_deref().unwrap().contains("--token ***"));
        assert!(neo_gh.env_keys.contains(&"GITHUB_PERSONAL_ACCESS_TOKEN".to_string()));
        assert!(neo_gh.auth_required);

        // Verify Linux system mode NEVER scans home host configs
        let sys_env = DiscoveryEnv {
            os_kind: "linux".to_string(),
            home_dir: Some(home.clone()), // even if populated, system mode must ignore it!
            neo_config_dir: Some(neo_cfg.clone()),
            appdata_dir: None,
            local_appdata_dir: None,
            is_linux_system_mode: true,
            cluster_id: Some("personal".to_string()),
            policy_path: None,
            disable_os_port_scan: true,
        };
        let sys_out = discover_servers(&policy, &sys_env, Some(false)).await;
        let sys_ids: Vec<&str> = sys_out
            .entries
            .iter()
            .map(|e| e.config.server_id.as_str())
            .collect();
        assert!(sys_ids.contains(&"neo:github"));
        assert!(sys_ids.contains(&"neo_dropin:local-api"));
        assert!(sys_ids.contains(&"workspace:ws-local"));
        assert!(!sys_ids.iter().any(|id| id.starts_with("claude_desktop:")));
        assert!(!sys_ids.iter().any(|id| id.starts_with("cursor:")));
        assert!(!sys_ids.iter().any(|id| id.starts_with("codex:")));
        assert!(!sys_ids.iter().any(|id| id.starts_with("vscode:")));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn redact_and_sanitize_edge_cases() {
        let (preview, sec) = redact_command_preview(
            "npx",
            &[
                "-y".into(),
                "my-mcp".into(),
                "--api-key".into(),
                "secret123".into(),
                "--password=pw456".into(),
                "ghp_abcdef123456".into(),
                "sk-openai999".into(),
                "Bearer tok_xyz".into(),
                "https://user:pass@api.example.com:8443/v1?key=abc#frag".into(),
            ],
        );
        assert!(sec);
        assert!(!preview.contains("secret123"));
        assert!(!preview.contains("pw456"));
        assert!(!preview.contains("ghp_abcdef123456"));
        assert!(!preview.contains("sk-openai999"));
        assert!(!preview.contains("tok_xyz"));
        assert!(!preview.contains("pass@"));
        assert!(!preview.contains("key=abc"));
        assert!(preview.contains("--api-key ***"));
        assert!(preview.contains("--password=***"));
        assert!(preview.contains("Bearer ***"));
        assert!(preview.contains("https://api.example.com:8443/v1"));
    }
}
