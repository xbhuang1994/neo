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

/// Immutable local policy loaded from `agent-policy.toml`.
/// Never modified by control-plane or relay messages.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PolicyConfig {
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
}

#[derive(Debug, Clone)]
pub struct Policy {
    config: PolicyConfig,
    canonical_workspaces: Vec<PathBuf>,
}

const FORBIDDEN_CMD_CHARS: &[char] = &[
    ';', '&', '|', '`', '$', '(', ')', '<', '>', '\n', '\r', '\0', '*', '?',
];

impl Policy {
    pub fn from_file(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("failed to read policy file {}: {e}", path.display()))?;
        Self::from_toml_str(&raw)
    }

    pub fn from_toml_str(toml_str: &str) -> Result<Self, String> {
        let config: PolicyConfig =
            toml::from_str(toml_str).map_err(|e| format!("invalid policy TOML: {e}"))?;
        let mut canonical_workspaces = Vec::with_capacity(config.allowed_workspaces.len());
        for ws in &config.allowed_workspaces {
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

    pub fn config(&self) -> &PolicyConfig {
        &self.config
    }

    pub fn canonical_workspaces(&self) -> &[PathBuf] {
        &self.canonical_workspaces
    }

    pub fn default_workspace(&self) -> Result<&Path, String> {
        self.canonical_workspaces
            .first()
            .map(|p| p.as_path())
            .ok_or_else(|| "no allowed_workspaces configured in local policy".to_string())
    }

    fn is_within_workspaces(&self, canonical_path: &Path) -> bool {
        self.canonical_workspaces
            .iter()
            .any(|ws| canonical_path.starts_with(ws))
    }

    /// Validates that `raw_path` resolves strictly within `allowed_workspaces`,
    /// rejecting any `..` traversal or symlink escapes outside workspaces.
    pub fn validate_path(&self, raw_path: &str, must_exist: bool) -> Result<PathBuf, String> {
        if raw_path.is_empty() || raw_path.contains('\0') {
            return Err("invalid empty or NUL path".to_string());
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
    pub fn validate_command(&self, program: &str) -> Result<String, String> {
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
        {
            return Err(format!("command path cannot contain '..': {program}"));
        }
        let basename = prog_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| format!("invalid command basename: {program}"))?;

        let canon_basename = if program.contains('/') {
            std::fs::canonicalize(prog_path)
                .ok()
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        } else {
            None
        };

        let is_denied = self.config.denied_commands.iter().any(|d| {
            d == program
                || d == basename
                || canon_basename.as_deref().is_some_and(|cb| cb == d)
        });
        if is_denied {
            return Err(format!("command '{program}' is denied by local policy"));
        }

        if !self.config.allowed_commands.is_empty() {
            let is_allowed = self
                .config
                .allowed_commands
                .iter()
                .any(|a| a == program || a == basename);
            if !is_allowed {
                return Err(format!(
                    "command '{program}' is not in local allowed_commands"
                ));
            }
        }

        Ok(program.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn blocks_dotdot_and_symlink_escapes() {
        let ws = temp_dir("ws");
        let outside = temp_dir("outside");
        let outside_file = outside.join("secret.txt");
        std::fs::write(&outside_file, "top-secret").unwrap();
        let evil_link = ws.join("escape_link");
        symlink(&outside_file, &evil_link).unwrap();

        let toml = format!(
            r#"
allowed_workspaces = ["{}"]
allowed_commands = ["echo", "ls"]
denied_commands = ["rm", "sudo"]
max_child_mem_mb = 512
max_exec_timeout_sec = 30
"#,
            ws.display()
        );
        let policy = Policy::from_toml_str(&toml).unwrap();

        assert!(policy.validate_path("/etc/passwd", true).is_err());
        assert!(policy
            .validate_path(&format!("{}/../etc/passwd", ws.display()), false)
            .is_err());
        assert!(policy
            .validate_path(&evil_link.to_string_lossy(), true)
            .is_err());
        assert!(policy
            .validate_path(&evil_link.to_string_lossy(), false)
            .is_err());

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
            ws.display()
        );
        let policy = Policy::from_toml_str(&toml).unwrap();
        assert!(policy.validate_command("echo").is_ok());
        assert!(policy.validate_command("/bin/echo").is_ok());
        assert!(policy.validate_command("rm").is_err()); // denied overrides allowed
        assert!(policy.validate_command("cat").is_err()); // not in allowlist
        assert!(policy.validate_command("echo;rm").is_err());
        let _ = std::fs::remove_dir_all(&ws);
    }
}
