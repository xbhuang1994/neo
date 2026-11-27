use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

fn default_max_child_mem_mb() -> u64 {
    2048
}

fn default_max_exec_timeout_sec() -> u64 {
    120
}

fn default_max_output_bytes() -> usize {
    1_048_576
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxLevel {
    Readonly,
    Corp,
    Personal,
    Desktop,
    Unrestricted,
}

impl SandboxLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Readonly => "readonly",
            Self::Corp => "corp",
            Self::Personal => "personal",
            Self::Desktop => "desktop",
            Self::Unrestricted => "unrestricted",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "readonly" => Ok(Self::Readonly),
            "corp" => Ok(Self::Corp),
            "personal" => Ok(Self::Personal),
            "desktop" => Ok(Self::Desktop),
            "unrestricted" => Ok(Self::Unrestricted),
            other => Err(format!(
                "invalid sandbox level '{other}' (expected readonly, corp, personal, desktop, or unrestricted)"
            )),
        }
    }
}

const BASE_DENIED_COMMANDS: &[&str] = &[
    "rm",
    "sudo",
    "su",
    "doas",
    "dd",
    "mkfs",
    "fdisk",
    "parted",
    "shutdown",
    "reboot",
    "poweroff",
    "halt",
    "mount",
    "umount",
    "iptables",
    "ip6tables",
    "nft",
    "systemctl",
    "chmod",
    "chown",
    "chgrp",
    "curl",
    "wget",
    "ssh",
    "scp",
    "sftp",
    "nc",
    "ncat",
];

const READONLY_ALLOWED_COMMANDS: &[&str] = &[
    "ls", "cat", "head", "tail", "grep", "rg", "find", "pwd", "uname", "echo", "git",
];

const CORP_EXTRA_DENIED_COMMANDS: &[&str] = &["python3", "perl", "ruby", "bash", "sh"];

const READONLY_EXTRA_DENIED_COMMANDS: &[&str] = &[
    "python3", "perl", "ruby", "bash", "sh", "mv", "cp", "tee", "sed", "awk", "touch", "mkdir",
    "rmdir", "ln",
];

const CORP_ALLOWED_COMMANDS: &[&str] = &[
    "ls", "cat", "head", "tail", "grep", "rg", "find", "pwd", "uname", "echo", "git", "cargo",
    "bun",
];

const PERSONAL_ALLOWED_COMMANDS: &[&str] = &[
    "ls", "cat", "head", "tail", "grep", "rg", "find", "pwd", "uname", "echo", "git", "cargo",
    "bun", "python3", "make",
];

const DESKTOP_EXTRA_ALLOWED_COMMANDS: &[&str] = &[
    "node",
    "npm",
    "npx",
    "flutter",
    "dart",
    "open",
    "xdg-open",
    "osascript",
    "screencapture",
    "scrot",
    "xdotool",
    "powershell",
    "pwsh",
];

/// Optional `[mcp]` policy section for proactive local MCP discovery and proxying.
/// All fields default cleanly when `[mcp]` is omitted in existing TOML files.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct McpPolicyConfig {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub discovery_mode: Option<String>,
    #[serde(default)]
    pub auto_enable_discovered: Option<bool>,
    #[serde(default)]
    pub allow_loopback_probe: Option<bool>,
    #[serde(default)]
    pub allowed_servers: Vec<String>,
    #[serde(default)]
    pub denied_servers: Vec<String>,
    #[serde(default)]
    pub extra_config_paths: Vec<String>,
    #[serde(default)]
    pub probe_ports: Vec<u16>,
    #[serde(default)]
    pub max_concurrent_servers: Option<usize>,
    #[serde(default)]
    pub idle_timeout_sec: Option<u64>,
    #[serde(default)]
    pub max_response_bytes: Option<usize>,
}

impl McpPolicyConfig {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    pub fn for_preset(level: SandboxLevel) -> Self {
        match level {
            SandboxLevel::Readonly => Self {
                enabled: Some(false),
                discovery_mode: Some("disabled".to_string()),
                auto_enable_discovered: Some(false),
                allow_loopback_probe: Some(false),
                ..Self::default()
            },
            SandboxLevel::Corp => Self {
                enabled: Some(true),
                discovery_mode: Some("neo_only".to_string()),
                auto_enable_discovered: Some(false),
                allow_loopback_probe: Some(false),
                ..Self::default()
            },
            SandboxLevel::Personal => Self {
                enabled: Some(true),
                discovery_mode: Some("configs_only".to_string()),
                auto_enable_discovered: Some(false),
                allow_loopback_probe: Some(false),
                ..Self::default()
            },
            SandboxLevel::Desktop => Self {
                enabled: Some(true),
                discovery_mode: Some("configs_only".to_string()),
                auto_enable_discovered: Some(false),
                allow_loopback_probe: Some(true),
                ..Self::default()
            },
            SandboxLevel::Unrestricted => Self {
                enabled: Some(true),
                discovery_mode: Some("configs_and_loopback".to_string()),
                auto_enable_discovered: Some(false),
                allow_loopback_probe: Some(true),
                ..Self::default()
            },
        }
    }
}

/// Local execution policy loaded from `agent-policy.toml` (or runtime sandbox override).
/// Set `lock_sandbox = true` to refuse remote `set_sandbox` RPC transitions.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PolicyConfig {
    #[serde(default)]
    pub allowed_workspaces: Vec<String>,
    #[serde(default)]
    pub allowed_commands: Vec<String>,
    #[serde(default)]
    pub denied_commands: Vec<String>,
    #[serde(default = "default_max_child_mem_mb")]
    pub max_child_mem_mb: u64,
    #[serde(default = "default_max_exec_timeout_sec")]
    pub max_exec_timeout_sec: u64,
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: usize,
    #[serde(default)]
    pub sandbox_level: Option<SandboxLevel>,
    #[serde(default)]
    pub unrestricted: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub lock_sandbox: bool,
    #[serde(default)]
    pub mcp: McpPolicyConfig,
}

#[derive(Debug, Clone)]
pub struct Policy {
    config: PolicyConfig,
    canonical_workspaces: Vec<PathBuf>,
}

const FORBIDDEN_CMD_CHARS: &[char] = &[
    ';', '&', '|', '`', '$', '(', ')', '<', '>', '\n', '\r', '\0', '*', '?',
];

fn escape_toml_string(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

fn format_toml_string_array(items: &[String]) -> String {
    if items.is_empty() {
        return "[]".to_string();
    }
    let lines: Vec<String> = items
        .iter()
        .map(|item| format!("  \"{}\",", escape_toml_string(item)))
        .collect();
    format!("[\n{}\n]", lines.join("\n"))
}

impl Policy {
    pub fn from_file(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("failed to read policy file {}: {e}", path.display()))?;
        Self::from_toml_str(&raw)
    }

    pub fn from_toml_str(toml_str: &str) -> Result<Self, String> {
        let config: PolicyConfig =
            toml::from_str(toml_str).map_err(|e| format!("invalid policy TOML: {e}"))?;
        Self::from_config(config)
    }

    fn from_config(config: PolicyConfig) -> Result<Self, String> {
        let is_unrestricted =
            config.unrestricted || config.sandbox_level == Some(SandboxLevel::Unrestricted);
        let mut canonical_workspaces = Vec::with_capacity(config.allowed_workspaces.len());
        for ws in &config.allowed_workspaces {
            if is_unrestricted {
                if ws.is_empty() || ws.contains('\0') {
                    continue;
                }
                if let Ok(canon) = std::fs::canonicalize(Path::new(ws)) {
                    if canon.is_dir() {
                        canonical_workspaces.push(canon);
                    }
                }
                continue;
            }
            if ws.is_empty() || ws.contains('\0') {
                return Err(format!("invalid workspace path in policy: {ws:?}"));
            }
            let p = Path::new(ws);
            if p.components().any(|c| matches!(c, Component::ParentDir)) {
                return Err(format!("workspace path cannot contain '..': {ws}"));
            }
            let canon = std::fs::canonicalize(p)
                .map_err(|e| format!("failed to canonicalize workspace {ws}: {e}"))?;
            if !canon.is_dir() {
                return Err(format!("workspace is not a directory: {}", canon.display()));
            }
            canonical_workspaces.push(canon);
        }
        Ok(Self {
            config,
            canonical_workspaces,
        })
    }

    pub fn from_preset(
        level: SandboxLevel,
        workspaces: Vec<String>,
        lock_sandbox: bool,
    ) -> Result<Self, String> {
        let to_vec = |items: &[&str]| -> Vec<String> { items.iter().map(|s| (*s).to_string()).collect() };
        let (
            allowed_commands,
            denied_commands,
            max_child_mem_mb,
            max_exec_timeout_sec,
            max_output_bytes,
            read_only,
            unrestricted,
        ) = match level {
            SandboxLevel::Readonly => {
                let mut denied = to_vec(BASE_DENIED_COMMANDS);
                denied.extend(to_vec(READONLY_EXTRA_DENIED_COMMANDS));
                (
                    to_vec(READONLY_ALLOWED_COMMANDS),
                    denied,
                    1024,
                    60,
                    1_048_576,
                    true,
                    false,
                )
            }
            SandboxLevel::Corp => {
                let mut denied = to_vec(BASE_DENIED_COMMANDS);
                denied.extend(to_vec(CORP_EXTRA_DENIED_COMMANDS));
                (
                    to_vec(CORP_ALLOWED_COMMANDS),
                    denied,
                    4096,
                    90,
                    1_048_576,
                    false,
                    false,
                )
            }
            SandboxLevel::Personal => (
                to_vec(PERSONAL_ALLOWED_COMMANDS),
                to_vec(BASE_DENIED_COMMANDS),
                2048,
                120,
                1_048_576,
                false,
                false,
            ),
            SandboxLevel::Desktop => {
                let mut allowed = to_vec(PERSONAL_ALLOWED_COMMANDS);
                allowed.extend(to_vec(DESKTOP_EXTRA_ALLOWED_COMMANDS));
                (
                    allowed,
                    to_vec(BASE_DENIED_COMMANDS),
                    4096,
                    180,
                    1_048_576,
                    false,
                    false,
                )
            }
            SandboxLevel::Unrestricted => (
                Vec::new(),
                Vec::new(),
                0,
                0,
                8_388_608,
                false,
                true,
            ),
        };

        let config = PolicyConfig {
            allowed_workspaces: workspaces,
            allowed_commands,
            denied_commands,
            max_child_mem_mb,
            max_exec_timeout_sec,
            max_output_bytes,
            sandbox_level: Some(level),
            unrestricted,
            read_only,
            lock_sandbox,
            mcp: McpPolicyConfig::for_preset(level),
        };
        Self::from_config(config)
    }

    pub fn render_toml(&self) -> String {
        let level = self.effective_level();
        let mut out = String::new();
        out.push_str(&format!(
            "# Neo Tier 1 OS Agent execution policy (sandbox level: {}).\n\n",
            level.as_str()
        ));
        out.push_str(&format!("sandbox_level = \"{}\"\n", level.as_str()));
        out.push_str(&format!("unrestricted = {}\n", self.is_unrestricted()));
        out.push_str(&format!("read_only = {}\n", self.is_read_only()));
        if self.config.lock_sandbox {
            out.push_str("lock_sandbox = true\n");
        }
        out.push('\n');
        out.push_str(&format!(
            "allowed_workspaces = {}\n\n",
            format_toml_string_array(&self.config.allowed_workspaces)
        ));
        out.push_str(&format!(
            "allowed_commands = {}\n\n",
            format_toml_string_array(&self.config.allowed_commands)
        ));
        out.push_str("# denied_commands always overrides allowed_commands.\n");
        out.push_str(&format!(
            "denied_commands = {}\n\n",
            format_toml_string_array(&self.config.denied_commands)
        ));
        out.push_str(&format!(
            "max_child_mem_mb = {}\n",
            self.config.max_child_mem_mb
        ));
        out.push_str(&format!(
            "max_exec_timeout_sec = {}\n",
            self.config.max_exec_timeout_sec
        ));
        out.push_str(&format!(
            "max_output_bytes = {}\n",
            self.config.max_output_bytes
        ));

        if !self.config.mcp.is_empty() {
            let mcp = &self.config.mcp;
            out.push_str("\n[mcp]\n");
            if let Some(enabled) = mcp.enabled {
                out.push_str(&format!("enabled = {enabled}\n"));
            }
            if let Some(ref mode) = mcp.discovery_mode {
                out.push_str(&format!(
                    "discovery_mode = \"{}\"\n",
                    escape_toml_string(mode)
                ));
            }
            if let Some(auto_en) = mcp.auto_enable_discovered {
                out.push_str(&format!("auto_enable_discovered = {auto_en}\n"));
            }
            if let Some(probe) = mcp.allow_loopback_probe {
                out.push_str(&format!("allow_loopback_probe = {probe}\n"));
            }
            if !mcp.allowed_servers.is_empty() {
                out.push_str(&format!(
                    "allowed_servers = {}\n",
                    format_toml_string_array(&mcp.allowed_servers)
                ));
            }
            if !mcp.denied_servers.is_empty() {
                out.push_str(&format!(
                    "denied_servers = {}\n",
                    format_toml_string_array(&mcp.denied_servers)
                ));
            }
            if !mcp.extra_config_paths.is_empty() {
                out.push_str(&format!(
                    "extra_config_paths = {}\n",
                    format_toml_string_array(&mcp.extra_config_paths)
                ));
            }
            if !mcp.probe_ports.is_empty() {
                let ports: Vec<String> = mcp.probe_ports.iter().map(|p| p.to_string()).collect();
                out.push_str(&format!("probe_ports = [{}]\n", ports.join(", ")));
            }
            if let Some(max_c) = mcp.max_concurrent_servers {
                out.push_str(&format!("max_concurrent_servers = {max_c}\n"));
            }
            if let Some(idle) = mcp.idle_timeout_sec {
                out.push_str(&format!("idle_timeout_sec = {idle}\n"));
            }
            if let Some(max_b) = mcp.max_response_bytes {
                out.push_str(&format!("max_response_bytes = {max_b}\n"));
            }
        }
        out
    }

    pub fn persist_to_file(&self, path: &Path) -> Result<(), String> {
        let content = self.render_toml();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    format!("failed to create policy directory {}: {e}", parent.display())
                })?;
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if path.is_file() {
                if let Ok(meta) = std::fs::metadata(path) {
                    if meta.permissions().mode() & 0o200 == 0 {
                        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644))
                            .map_err(|e| {
                                format!(
                                    "failed to temporarily make policy file {} writable: {e}",
                                    path.display()
                                )
                            })?;
                    }
                }
            }
        }
        let write_res = std::fs::write(path, content)
            .map_err(|e| format!("failed to write policy file {}: {e}", path.display()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if path.is_file() {
                if let Err(e) =
                    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o444))
                {
                    if write_res.is_ok() {
                        return Err(format!("failed to set 0444 on {}: {e}", path.display()));
                    }
                }
            }
        }
        write_res
    }

    pub fn config(&self) -> &PolicyConfig {
        &self.config
    }

    pub fn canonical_workspaces(&self) -> &[PathBuf] {
        &self.canonical_workspaces
    }

    pub fn is_unrestricted(&self) -> bool {
        self.config.unrestricted || self.config.sandbox_level == Some(SandboxLevel::Unrestricted)
    }

    pub fn is_read_only(&self) -> bool {
        !self.is_unrestricted()
            && (self.config.read_only || self.config.sandbox_level == Some(SandboxLevel::Readonly))
    }

    pub fn is_sandbox_locked(&self) -> bool {
        self.config.lock_sandbox
    }

    pub fn effective_level(&self) -> SandboxLevel {
        if self.is_unrestricted() {
            return SandboxLevel::Unrestricted;
        }
        if let Some(lvl) = self.config.sandbox_level {
            return lvl;
        }
        if self.config.read_only {
            return SandboxLevel::Readonly;
        }
        if self.config.max_child_mem_mb == 1024 && self.config.max_exec_timeout_sec == 60 {
            SandboxLevel::Readonly
        } else if self.config.denied_commands.iter().any(|c| c == "bash") {
            SandboxLevel::Corp
        } else if self
            .config
            .allowed_commands
            .iter()
            .any(|c| c == "flutter" || c == "osascript")
        {
            SandboxLevel::Desktop
        } else {
            SandboxLevel::Personal
        }
    }

    pub fn mcp_enabled(&self) -> bool {
        self.config
            .mcp
            .enabled
            .unwrap_or_else(|| self.effective_level() != SandboxLevel::Readonly)
    }

    pub fn mcp_discovery_mode(&self) -> &'static str {
        if !self.mcp_enabled() {
            return "disabled";
        }
        if let Some(ref raw) = self.config.mcp.discovery_mode {
            match raw.trim().to_ascii_lowercase().as_str() {
                "disabled" => return "disabled",
                "neo_only" => return "neo_only",
                "configs_only" => return "configs_only",
                "configs_and_loopback" => return "configs_and_loopback",
                _ => {}
            }
        }
        match self.effective_level() {
            SandboxLevel::Readonly => "disabled",
            SandboxLevel::Corp => "neo_only",
            SandboxLevel::Personal => "configs_only",
            SandboxLevel::Desktop => "configs_only",
            SandboxLevel::Unrestricted => "configs_and_loopback",
        }
    }

    pub fn mcp_auto_enable_discovered(&self) -> bool {
        self.config.mcp.auto_enable_discovered.unwrap_or(false)
    }

    pub fn mcp_allow_loopback_probe(&self) -> bool {
        if !self.mcp_enabled() {
            return false;
        }
        self.config.mcp.allow_loopback_probe.unwrap_or_else(|| {
            matches!(
                self.effective_level(),
                SandboxLevel::Desktop | SandboxLevel::Unrestricted
            )
        })
    }

    pub fn mcp_max_concurrent_servers(&self) -> usize {
        self.config.mcp.max_concurrent_servers.unwrap_or(8).max(1)
    }

    pub fn mcp_idle_timeout_sec(&self) -> u64 {
        self.config.mcp.idle_timeout_sec.unwrap_or(300)
    }

    pub fn mcp_max_response_bytes(&self) -> usize {
        self.config
            .mcp
            .max_response_bytes
            .unwrap_or(4_194_304)
            .max(4096)
    }

    pub fn mcp_soft_text_bytes(&self) -> usize {
        self.mcp_max_response_bytes().min(1_048_576)
    }

    pub fn default_workspace(&self) -> Result<&Path, String> {
        self.canonical_workspaces
            .first()
            .map(|p| p.as_path())
            .ok_or_else(|| "no allowed_workspaces configured in local policy".to_string())
    }

    pub fn default_cwd(&self) -> Result<PathBuf, String> {
        if let Ok(ws) = self.default_workspace() {
            return Ok(ws.to_path_buf());
        }
        if self.is_unrestricted() {
            return crate::enroll::user_home_dir()
                .or_else(|_| std::env::current_dir().map_err(|e| e.to_string()));
        }
        Err("no allowed_workspaces configured in local policy".to_string())
    }

    fn is_within_workspaces(&self, canonical_path: &Path) -> bool {
        self.canonical_workspaces
            .iter()
            .any(|ws| canonical_path.starts_with(ws))
    }

    /// Validates that `raw_path` resolves strictly within `allowed_workspaces` when restricted,
    /// rejecting any `..` traversal or symlink escapes outside workspaces.
    /// In `unrestricted` mode, expands `~`/`~/` and allows arbitrary host paths.
    pub fn validate_path(&self, raw_path: &str, must_exist: bool) -> Result<PathBuf, String> {
        if raw_path.is_empty() || raw_path.contains('\0') {
            return Err("invalid empty or NUL path".to_string());
        }
        if self.is_unrestricted() {
            let expanded = if raw_path == "~" {
                crate::enroll::user_home_dir().unwrap_or_else(|_| PathBuf::from(raw_path))
            } else if let Some(rest) = raw_path
                .strip_prefix("~/")
                .or_else(|| raw_path.strip_prefix("~\\"))
            {
                match crate::enroll::user_home_dir() {
                    Ok(home) => home.join(rest),
                    Err(_) => PathBuf::from(raw_path),
                }
            } else {
                PathBuf::from(raw_path)
            };
            let candidate = if expanded.is_absolute() {
                expanded
            } else {
                self.default_cwd()?.join(expanded)
            };
            if must_exist {
                return std::fs::canonicalize(&candidate)
                    .map_err(|e| format!("path resolution failed for {raw_path}: {e}"));
            }
            return Ok(candidate);
        }
        if self.canonical_workspaces.is_empty() {
            return Err("no allowed_workspaces configured in local policy".to_string());
        }
        let input = Path::new(raw_path);
        for comp in input.components() {
            if matches!(comp, Component::ParentDir) {
                return Err(format!("path traversal '..' rejected: {raw_path}"));
            }
        }

        let candidate = if input.is_absolute() {
            input.to_path_buf()
        } else {
            self.canonical_workspaces[0].join(input)
        };

        if must_exist {
            let canon = std::fs::canonicalize(&candidate)
                .map_err(|e| format!("path resolution failed for {raw_path}: {e}"))?;
            if !self.is_within_workspaces(&canon) {
                return Err(format!(
                    "path '{}' escapes allowed_workspaces",
                    canon.display()
                ));
            }
            return Ok(canon);
        }

        // For write / create paths, guard against overwriting a symlink pointing outside.
        if let Ok(meta) = std::fs::symlink_metadata(&candidate) {
            if meta.file_type().is_symlink() {
                let canon = std::fs::canonicalize(&candidate).map_err(|e| {
                    format!("dangling or unreadable symlink rejected for {raw_path}: {e}")
                })?;
                if !self.is_within_workspaces(&canon) {
                    return Err(format!(
                        "symlink target '{}' escapes allowed_workspaces",
                        canon.display()
                    ));
                }
                return Ok(canon);
            }
            let canon = std::fs::canonicalize(&candidate)
                .map_err(|e| format!("path resolution failed for {raw_path}: {e}"))?;
            if !self.is_within_workspaces(&canon) {
                return Err(format!(
                    "path '{}' escapes allowed_workspaces",
                    canon.display()
                ));
            }
            return Ok(canon);
        }

        // Walk up to the nearest existing ancestor, verify it resolves inside workspace,
        // then append the non-existent tail components.
        let mut cur = candidate.as_path();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        while std::fs::symlink_metadata(cur).is_err() {
            let name = cur
                .file_name()
                .ok_or_else(|| format!("cannot resolve ancestor for {raw_path}"))?;
            tail.push(name.to_os_string());
            cur = cur
                .parent()
                .ok_or_else(|| format!("cannot resolve parent for {raw_path}"))?;
        }

        let canon_anc = std::fs::canonicalize(cur)
            .map_err(|e| format!("failed to canonicalize ancestor {}: {e}", cur.display()))?;
        if !self.is_within_workspaces(&canon_anc) {
            return Err(format!(
                "ancestor '{}' escapes allowed_workspaces",
                canon_anc.display()
            ));
        }
        let mut out = canon_anc;
        for part in tail.into_iter().rev() {
            out.push(part);
        }
        Ok(out)
    }

    /// Validates a command executable against `denied_commands` and `allowed_commands`.
    /// `denied_commands` always takes precedence.
    /// In `unrestricted` mode, allows any non-empty, NUL-free command/path.
    pub fn validate_command(&self, program: &str) -> Result<String, String> {
        if self.is_unrestricted() {
            if program.is_empty() || program.contains('\0') {
                return Err(format!("invalid or empty command name: {program:?}"));
            }
            return Ok(program.to_string());
        }
        if program.is_empty()
            || program.chars().any(|c| FORBIDDEN_CMD_CHARS.contains(&c))
            || program.contains(char::is_whitespace)
        {
            return Err(format!("invalid or unsafe command name: {program:?}"));
        }
        let prog_path = Path::new(program);
        if prog_path
            .components()
            .any(|c| matches!(c, Component::ParentDir))
            || program.split(['/', '\\']).any(|seg| seg == "..")
        {
            return Err(format!("command path cannot contain '..': {program}"));
        }
        let basename = prog_path
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(|s| s.rsplit(['/', '\\']).next())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("invalid command basename: {program}"))?;

        let canon_basename = if program.contains('/') || program.contains('\\') {
            std::fs::canonicalize(prog_path)
                .ok()
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        } else {
            None
        };

        let is_denied = self.config.denied_commands.iter().any(|d| {
            cmd_matches(d, program)
                || cmd_matches(d, basename)
                || canon_basename
                    .as_deref()
                    .is_some_and(|cb| cmd_matches(d, cb))
        });
        if is_denied {
            return Err(format!("command '{program}' is denied by local policy"));
        }

        if !self.config.allowed_commands.is_empty() {
            let is_allowed = self
                .config
                .allowed_commands
                .iter()
                .any(|a| cmd_matches(a, program) || cmd_matches(a, basename));
            if !is_allowed {
                return Err(format!(
                    "command '{program}' is not in local allowed_commands"
                ));
            }
        }

        Ok(program.to_string())
    }
}

#[cfg(windows)]
fn strip_exe(s: &str) -> &str {
    s.strip_suffix(".exe")
        .or_else(|| s.strip_suffix(".EXE"))
        .unwrap_or(s)
}

#[cfg(windows)]
fn cmd_matches(policy_entry: &str, candidate: &str) -> bool {
    if policy_entry.eq_ignore_ascii_case(candidate) {
        return true;
    }
    strip_exe(policy_entry).eq_ignore_ascii_case(strip_exe(candidate))
}

#[cfg(not(windows))]
fn cmd_matches(policy_entry: &str, candidate: &str) -> bool {
    policy_entry == candidate
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    fn temp_dir(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "neo_policy_test_{}_{}_{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn toml_escape(path: &Path) -> String {
        path.display().to_string().replace('\\', "\\\\")
    }

    #[test]
    fn blocks_dotdot_and_symlink_escapes() {
        let ws = temp_dir("ws");
        let outside = temp_dir("outside");
        let outside_file = outside.join("secret.txt");
        std::fs::write(&outside_file, "top-secret").unwrap();
        #[cfg(unix)]
        let evil_link = {
            let link = ws.join("escape_link");
            symlink(&outside_file, &link).unwrap();
            link
        };

        let toml = format!(
            r#"
allowed_workspaces = ["{}"]
allowed_commands = ["echo", "ls"]
denied_commands = ["rm", "sudo"]
max_child_mem_mb = 512
max_exec_timeout_sec = 30
"#,
            toml_escape(&ws)
        );
        let policy = Policy::from_toml_str(&toml).unwrap();

        assert!(policy
            .validate_path(&outside_file.to_string_lossy(), true)
            .is_err());
        assert!(policy
            .validate_path(&format!("{}/../etc/passwd", ws.display()), false)
            .is_err());
        #[cfg(unix)]
        {
            assert!(policy.validate_path("/etc/passwd", true).is_err());
            assert!(policy
                .validate_path(&evil_link.to_string_lossy(), true)
                .is_err());
            assert!(policy
                .validate_path(&evil_link.to_string_lossy(), false)
                .is_err());
        }

        let valid_new = ws.join("sub/file.txt");
        let resolved = policy
            .validate_path(&valid_new.to_string_lossy(), false)
            .unwrap();
        assert!(resolved.starts_with(std::fs::canonicalize(&ws).unwrap()));

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn enforces_command_allow_and_deny_lists() {
        let ws = temp_dir("cmds");
        let toml = format!(
            r#"
allowed_workspaces = ["{}"]
allowed_commands = ["echo", "rm"]
denied_commands = ["rm", "sudo"]
"#,
            toml_escape(&ws)
        );
        let policy = Policy::from_toml_str(&toml).unwrap();
        assert!(policy.validate_command("echo").is_ok());
        assert!(policy.validate_command("/bin/echo").is_ok());
        assert!(policy.validate_command(r"C:\Tools\echo").is_ok());
        assert!(policy.validate_command("rm").is_err()); // denied overrides allowed
        assert!(policy.validate_command(r"C:\Windows\System32\rm").is_err());
        assert!(policy.validate_command(r"foo\..\echo").is_err());
        assert!(policy.validate_command("cat").is_err()); // not in allowlist
        assert!(policy.validate_command("echo;rm").is_err());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn sandbox_level_parse_and_effective_level_inference() {
        assert_eq!(SandboxLevel::parse("READONLY").unwrap(), SandboxLevel::Readonly);
        assert_eq!(SandboxLevel::parse("  corp ").unwrap(), SandboxLevel::Corp);
        assert_eq!(SandboxLevel::parse("Personal").unwrap(), SandboxLevel::Personal);
        assert_eq!(SandboxLevel::parse("desktop").unwrap(), SandboxLevel::Desktop);
        assert_eq!(
            SandboxLevel::parse("UnReStRiCtEd").unwrap(),
            SandboxLevel::Unrestricted
        );
        assert!(SandboxLevel::parse("unknown").is_err());

        let ws = temp_dir("infer");
        let ws_esc = toml_escape(&ws);

        // Legacy readonly inference (1024MB / 60s)
        let ro_legacy = Policy::from_toml_str(&format!(
            r#"
allowed_workspaces = ["{ws_esc}"]
max_child_mem_mb = 1024
max_exec_timeout_sec = 60
"#
        ))
        .unwrap();
        assert_eq!(ro_legacy.effective_level(), SandboxLevel::Readonly);
        assert!(!ro_legacy.is_read_only()); // explicit read_only/sandbox_level not set

        // Legacy corp inference (denied bash)
        let corp_legacy = Policy::from_toml_str(&format!(
            r#"
allowed_workspaces = ["{ws_esc}"]
denied_commands = ["rm", "bash"]
max_child_mem_mb = 4096
max_exec_timeout_sec = 90
"#
        ))
        .unwrap();
        assert_eq!(corp_legacy.effective_level(), SandboxLevel::Corp);

        // Legacy desktop inference (allowed flutter)
        let desktop_legacy = Policy::from_toml_str(&format!(
            r#"
allowed_workspaces = ["{ws_esc}"]
allowed_commands = ["ls", "flutter"]
max_child_mem_mb = 4096
max_exec_timeout_sec = 180
"#
        ))
        .unwrap();
        assert_eq!(desktop_legacy.effective_level(), SandboxLevel::Desktop);

        // Legacy personal default
        let personal_legacy = Policy::from_toml_str(&format!(
            r#"
allowed_workspaces = ["{ws_esc}"]
allowed_commands = ["ls", "cargo"]
"#
        ))
        .unwrap();
        assert_eq!(personal_legacy.effective_level(), SandboxLevel::Personal);

        // Explicit flags
        let explicit_ro = Policy::from_toml_str(&format!(
            r#"
allowed_workspaces = ["{ws_esc}"]
read_only = true
"#
        ))
        .unwrap();
        assert!(explicit_ro.is_read_only());
        assert_eq!(explicit_ro.effective_level(), SandboxLevel::Readonly);

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn presets_render_roundtrip_and_persist_to_readonly_file() {
        let ws = temp_dir("preset");
        let ws_str = ws.to_string_lossy().into_owned();

        for (lvl, exp_mem, exp_timeout, exp_out, exp_ro, exp_unr) in [
            (SandboxLevel::Readonly, 1024, 60, 1_048_576, true, false),
            (SandboxLevel::Corp, 4096, 90, 1_048_576, false, false),
            (SandboxLevel::Personal, 2048, 120, 1_048_576, false, false),
            (SandboxLevel::Desktop, 4096, 180, 1_048_576, false, false),
            (SandboxLevel::Unrestricted, 0, 0, 8_388_608, false, true),
        ] {
            let pol = Policy::from_preset(lvl, vec![ws_str.clone()], false).unwrap();
            assert_eq!(pol.effective_level(), lvl);
            assert_eq!(pol.config().max_child_mem_mb, exp_mem);
            assert_eq!(pol.config().max_exec_timeout_sec, exp_timeout);
            assert_eq!(pol.config().max_output_bytes, exp_out);
            assert_eq!(pol.is_read_only(), exp_ro);
            assert_eq!(pol.is_unrestricted(), exp_unr);
            assert_eq!(pol.config().allowed_workspaces, vec![ws_str.clone()]);

            let rendered = pol.render_toml();
            let reparsed = Policy::from_toml_str(&rendered).unwrap();
            assert_eq!(reparsed.config(), pol.config());
        }

        // Persist over an existing 0444 read-only file and verify 0444 is restored on Unix
        let pol_path = ws.join("policy-test.toml");
        let p1 = Policy::from_preset(SandboxLevel::Personal, vec![ws_str.clone()], false).unwrap();
        p1.persist_to_file(&pol_path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&pol_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o444);
        }

        let p2 =
            Policy::from_preset(SandboxLevel::Unrestricted, vec![ws_str.clone()], true).unwrap();
        p2.persist_to_file(&pol_path).unwrap();
        let loaded = Policy::from_file(&pol_path).unwrap();
        assert_eq!(loaded.effective_level(), SandboxLevel::Unrestricted);
        assert!(loaded.is_sandbox_locked());
        assert_eq!(loaded.config().allowed_workspaces, vec![ws_str]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&pol_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o444);
        }

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn unrestricted_allows_missing_workspaces_outside_paths_tilde_dotdot_and_any_command() {
        let outside = temp_dir("unr_outside");
        let outside_file = outside.join("file.txt");
        std::fs::write(&outside_file, "free").unwrap();

        // Missing workspaces and omitted workspaces are tolerated in unrestricted mode
        let pol = Policy::from_toml_str(
            r#"
sandbox_level = "unrestricted"
allowed_workspaces = ["/definitely/does/not/exist/neo_missing_ws"]
"#,
        )
        .unwrap();
        assert!(pol.is_unrestricted());
        assert!(!pol.is_read_only());
        assert!(pol.canonical_workspaces().is_empty());
        assert!(pol.default_cwd().is_ok());

        // Also works when allowed_workspaces is omitted entirely
        let pol_empty = Policy::from_toml_str("unrestricted = true\n").unwrap();
        assert!(pol_empty.is_unrestricted());
        assert_eq!(pol_empty.effective_level(), SandboxLevel::Unrestricted);

        // Paths outside workspace and with `..` succeed
        let resolved_exist = pol
            .validate_path(&outside_file.to_string_lossy(), true)
            .unwrap();
        assert_eq!(resolved_exist, std::fs::canonicalize(&outside_file).unwrap());

        let dotdot_target = format!("{}/sub/../new.txt", outside.display());
        assert!(pol.validate_path(&dotdot_target, false).is_ok());

        // `~` and `~/` expand to home dir when HOME/USERPROFILE is set
        if let Ok(home) = crate::enroll::user_home_dir() {
            assert_eq!(pol.validate_path("~", false).unwrap(), home);
            assert_eq!(
                pol.validate_path("~/foo/bar", false).unwrap(),
                home.join("foo/bar")
            );
        }

        // Empty or NUL paths still rejected
        assert!(pol.validate_path("", false).is_err());
        assert!(pol.validate_path("abc\0def", false).is_err());

        // Arbitrary commands allowed, empty/NUL still rejected
        assert_eq!(pol.validate_command("rm").unwrap(), "rm");
        assert_eq!(pol.validate_command("/usr/bin/env").unwrap(), "/usr/bin/env");
        assert_eq!(pol.validate_command("sh").unwrap(), "sh");
        assert!(pol.validate_command("").is_err());
        assert!(pol.validate_command("bad\0cmd").is_err());

        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn mcp_policy_defaults_backwards_compat_and_toml_roundtrip() {
        let ws = temp_dir("mcp_pol");
        let ws_esc = toml_escape(&ws);

        // Existing TOML without [mcp] continues to parse with level-based defaults
        let legacy = Policy::from_toml_str(&format!(
            "allowed_workspaces = [\"{ws_esc}\"]\nsandbox_level = \"personal\"\n"
        ))
        .unwrap();
        assert!(legacy.config().mcp.is_empty());
        assert!(legacy.mcp_enabled());
        assert_eq!(legacy.mcp_discovery_mode(), "configs_only");
        assert!(!legacy.mcp_auto_enable_discovered());
        assert!(!legacy.mcp_allow_loopback_probe());
        assert_eq!(legacy.mcp_max_concurrent_servers(), 8);
        assert_eq!(legacy.mcp_idle_timeout_sec(), 300);
        assert_eq!(legacy.mcp_max_response_bytes(), 4_194_304);
        assert_eq!(legacy.mcp_soft_text_bytes(), 1_048_576);
        assert!(!legacy.render_toml().contains("[mcp]"));

        // Preset defaults across all 5 sandbox levels
        for (lvl, en, mode, probe) in [
            (SandboxLevel::Readonly, false, "disabled", false),
            (SandboxLevel::Corp, true, "neo_only", false),
            (SandboxLevel::Personal, true, "configs_only", false),
            (SandboxLevel::Desktop, true, "configs_only", true),
            (SandboxLevel::Unrestricted, true, "configs_and_loopback", true),
        ] {
            let pol = Policy::from_preset(lvl, vec![ws.to_string_lossy().into_owned()], false).unwrap();
            assert_eq!(pol.mcp_enabled(), en);
            assert_eq!(pol.mcp_discovery_mode(), mode);
            assert!(!pol.mcp_auto_enable_discovered());
            assert_eq!(pol.mcp_allow_loopback_probe(), probe);
        }

        // Explicit [mcp] section parses and round-trips cleanly
        let custom_toml = format!(
            r#"
sandbox_level = "corp"
allowed_workspaces = ["{ws_esc}"]

[mcp]
enabled = true
discovery_mode = "configs_and_loopback"
auto_enable_discovered = true
allow_loopback_probe = true
allowed_servers = ["neo:docs", "cursor:github"]
denied_servers = ["loopback:*"]
extra_config_paths = ["/etc/neo-agent/custom-mcp.json"]
probe_ports = [3100, 8081]
max_concurrent_servers = 4
idle_timeout_sec = 120
max_response_bytes = 2097152
"#
        );
        let custom = Policy::from_toml_str(&custom_toml).unwrap();
        assert!(custom.mcp_enabled());
        assert_eq!(custom.mcp_discovery_mode(), "configs_and_loopback");
        assert!(custom.mcp_auto_enable_discovered());
        assert!(custom.mcp_allow_loopback_probe());
        assert_eq!(custom.config().mcp.allowed_servers, vec!["neo:docs", "cursor:github"]);
        assert_eq!(custom.config().mcp.denied_servers, vec!["loopback:*"]);
        assert_eq!(custom.config().mcp.probe_ports, vec![3100, 8081]);
        assert_eq!(custom.mcp_max_concurrent_servers(), 4);
        assert_eq!(custom.mcp_idle_timeout_sec(), 120);
        assert_eq!(custom.mcp_max_response_bytes(), 2_097_152);

        let rendered = custom.render_toml();
        assert!(rendered.contains("[mcp]"));
        let reparsed = Policy::from_toml_str(&rendered).unwrap();
        assert_eq!(reparsed.config(), custom.config());

        let _ = std::fs::remove_dir_all(&ws);
    }
}
