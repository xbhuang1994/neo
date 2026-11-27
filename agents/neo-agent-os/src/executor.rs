use crate::policy::{Policy, SandboxLevel};
use crate::prober::SandboxSummary;
use crate::updater::verify_ed25519_signature;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Mutex;

const BLOCKED_ENV_VARS: &[&str] = &[
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "LD_DEBUG",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
];

#[derive(Debug, Clone)]
struct TransferSession {
    staging_path: PathBuf,
    target_path: PathBuf,
}

pub struct Executor {
    policy: Arc<RwLock<Policy>>,
    ota_cache_dir: Option<PathBuf>,
    policy_path: Option<PathBuf>,
    sandbox_override_path: Option<PathBuf>,
    transfers: Mutex<HashMap<String, TransferSession>>,
}

impl Executor {
    pub fn new(policy: Arc<RwLock<Policy>>, ota_cache_dir: Option<PathBuf>) -> Self {
        Self {
            policy,
            ota_cache_dir,
            policy_path: None,
            sandbox_override_path: None,
            transfers: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_policy_paths(
        mut self,
        policy_path: Option<PathBuf>,
        sandbox_override_path: Option<PathBuf>,
    ) -> Self {
        self.policy_path = policy_path;
        self.sandbox_override_path = sandbox_override_path;
        self
    }

    pub fn policy_snapshot(&self) -> Policy {
        self.policy
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn apply_sandbox_level(&self, params: &Value) -> Result<Value, String> {
        let raw_level = params
            .get("level")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "set_sandbox requires 'level' string".to_string())?;
        let level = SandboxLevel::parse(raw_level)?;

        let requested_workspaces: Option<Vec<String>> = match params.get("workspaces") {
            None | Some(Value::Null) => None,
            Some(Value::Array(arr)) => {
                let mut out = Vec::with_capacity(arr.len());
                for item in arr {
                    let s = item
                        .as_str()
                        .ok_or_else(|| "set_sandbox 'workspaces' entries must be strings".to_string())?;
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        out.push(trimmed.to_string());
                    }
                }
                if out.is_empty() {
                    None
                } else {
                    Some(out)
                }
            }
            Some(_) => return Err("set_sandbox 'workspaces' must be an array of strings".to_string()),
        };

        let mut guard = self.policy.write().unwrap_or_else(|e| e.into_inner());
        if guard.is_sandbox_locked() {
            return Err("sandbox level is locked by local policy (lock_sandbox = true)".to_string());
        }

        let workspaces = match requested_workspaces {
            Some(ws) => ws,
            None => {
                if !guard.config().allowed_workspaces.is_empty() {
                    guard.config().allowed_workspaces.clone()
                } else {
                    guard
                        .canonical_workspaces()
                        .iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect()
                }
            }
        };

        let new_policy = Policy::from_preset(level, workspaces, false)?;
        *guard = new_policy.clone();

        let mut persisted = false;
        let mut persisted_path: Option<String> = None;
        let mut persist_warning: Option<String> = None;

        if let Some(ref p) = self.policy_path {
            match new_policy.persist_to_file(p) {
                Ok(()) => {
                    persisted = true;
                    persisted_path = Some(p.to_string_lossy().into_owned());
                    if let Some(ref ov) = self.sandbox_override_path {
                        if ov.exists() {
                            let _ = std::fs::remove_file(ov);
                        }
                    }
                }
                Err(primary_err) => {
                    if let Some(ref ov) = self.sandbox_override_path {
                        match new_policy.persist_to_file(ov) {
                            Ok(()) => {
                                persisted = true;
                                persisted_path = Some(ov.to_string_lossy().into_owned());
                                persist_warning = Some(format!(
                                    "primary policy file not writable ({primary_err}); persisted to override file"
                                ));
                            }
                            Err(ov_err) => {
                                persist_warning = Some(format!(
                                    "applied in memory only; primary policy write failed ({primary_err}) and override write failed ({ov_err})"
                                ));
                            }
                        }
                    } else {
                        persist_warning = Some(format!(
                            "applied in memory only; failed to persist policy ({primary_err})"
                        ));
                    }
                }
            }
        } else if let Some(ref ov) = self.sandbox_override_path {
            match new_policy.persist_to_file(ov) {
                Ok(()) => {
                    persisted = true;
                    persisted_path = Some(ov.to_string_lossy().into_owned());
                }
                Err(ov_err) => {
                    persist_warning = Some(format!(
                        "applied in memory only; override write failed ({ov_err})"
                    ));
                }
            }
        }

        drop(guard);

        let sandbox = SandboxSummary::from_policy(&new_policy);
        Ok(json!({
            "level": level.as_str(),
            "sandbox": sandbox,
            "persisted": persisted,
            "persisted_path": persisted_path,
            "warning": persist_warning,
        }))
    }

    pub async fn dispatch(
        &self,
        method: &str,
        params: &Value,
        timeout_ms: Option<u64>,
    ) -> Value {
        let res = match method {
            "exec" => self.handle_exec(params, timeout_ms).await,
            "fs_read" | "fs.read" => self.handle_fs_read(params).await,
            "fs_write" | "fs.write" => self.handle_fs_write(params).await,
            "fs_list" | "fs.list" => self.handle_fs_list(params).await,
            "transfer_chunk" | "transfer" => self.handle_transfer_chunk(params).await,
            "ota_stage" | "ota.stage" => self.handle_ota_stage(params).await,
            "set_sandbox" | "sandbox.set" => self.apply_sandbox_level(params),
            other => Err(format!("unsupported RPC method: {other}")),
        };
        match res {
            Ok(result) => json!({ "ok": true, "result": result }),
            Err(error) => json!({ "ok": false, "error": error }),
        }
    }

    async fn handle_exec(&self, params: &Value, timeout_ms: Option<u64>) -> Result<Value, String> {
        let policy = self.policy_snapshot();
        let unrestricted = policy.is_unrestricted();

        let (spawn_label, mut cmd) = if unrestricted {
            if let Some(prog) = params.get("program").and_then(|v| v.as_str()) {
                let validated_program = policy.validate_command(prog)?;
                let args: Vec<String> = params
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                let mut c = Command::new(&validated_program);
                c.args(&args);
                (validated_program, c)
            } else if let Some(cmd_str) = params.get("cmd").and_then(|v| v.as_str()) {
                if cmd_str.trim().is_empty() || cmd_str.contains('\0') {
                    return Err("empty or invalid command string".to_string());
                }
                #[cfg(windows)]
                let (shell, c) = {
                    let mut c = Command::new("cmd");
                    c.args(["/C", cmd_str]);
                    ("cmd".to_string(), c)
                };
                #[cfg(not(windows))]
                let (shell, c) = {
                    let mut c = Command::new("sh");
                    c.args(["-c", cmd_str]);
                    ("sh".to_string(), c)
                };
                (shell, c)
            } else {
                return Err("exec requires 'program' or 'cmd'".to_string());
            }
        } else {
            let (program, args) = if let Some(prog) = params.get("program").and_then(|v| v.as_str()) {
                let args: Vec<String> = params
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                (prog.to_string(), args)
            } else if let Some(cmd_str) = params.get("cmd").and_then(|v| v.as_str()) {
                split_command_no_shell(cmd_str)?
            } else {
                return Err("exec requires 'program' or 'cmd'".to_string());
            };

            let validated_program = policy.validate_command(&program)?;
            let mut c = Command::new(&validated_program);
            c.args(&args);
            (validated_program, c)
        };

        let cwd = match params.get("cwd").and_then(|v| v.as_str()) {
            Some(c) if !c.is_empty() => policy.validate_path(c, true)?,
            _ => policy.default_cwd()?,
        };
        if !cwd.is_dir() {
            return Err(format!("cwd is not a directory: {}", cwd.display()));
        }

        let eff_timeout_ms: Option<u64> = if unrestricted && policy.config().max_exec_timeout_sec == 0 {
            timeout_ms.map(|ms| ms.max(100))
        } else {
            let max_timeout_ms = policy.config().max_exec_timeout_sec.saturating_mul(1000);
            Some(
                timeout_ms
                    .unwrap_or(max_timeout_ms)
                    .min(max_timeout_ms)
                    .max(100),
            )
        };

        cmd.current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if unrestricted {
            #[cfg(target_os = "windows")]
            {
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            if let Some(env_map) = params.get("env").and_then(|v| v.as_object()) {
                for (k, v) in env_map {
                    if let Some(val) = v.as_str() {
                        cmd.env(k, val);
                    }
                }
            }
        } else {
            cmd.env_clear();

            #[cfg(target_os = "macos")]
            {
                cmd.env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
                    .env("HOME", cwd.to_string_lossy().as_ref())
                    .env("LANG", "C.UTF-8");
            }
            #[cfg(target_os = "windows")]
            {
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
                for key in ["PATH", "SystemRoot", "COMSPEC", "PATHEXT"] {
                    if let Ok(val) = std::env::var(key) {
                        if !BLOCKED_ENV_VARS.iter().any(|b| b.eq_ignore_ascii_case(key)) {
                            cmd.env(key, val);
                        }
                    }
                }
                cmd.env("USERPROFILE", cwd.to_string_lossy().as_ref())
                    .env("HOME", cwd.to_string_lossy().as_ref());
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                cmd.env("PATH", "/usr/local/bin:/usr/bin:/bin")
                    .env("HOME", cwd.to_string_lossy().as_ref())
                    .env("LANG", "C.UTF-8");
            }

            if let Some(env_map) = params.get("env").and_then(|v| v.as_object()) {
                for (k, v) in env_map {
                    if let Some(val) = v.as_str() {
                        if !BLOCKED_ENV_VARS.iter().any(|b| b.eq_ignore_ascii_case(k)) {
                            cmd.env(k, val);
                        }
                    }
                }
            }
        }

        // Best-effort Linux RLIMIT_AS memory cap in child pre_exec (skipped if max_child_mem_mb == 0).
        #[cfg(target_os = "linux")]
        {
            let mem_limit_bytes = policy
                .config()
                .max_child_mem_mb
                .saturating_mul(1024 * 1024);
            if mem_limit_bytes > 0 {
                unsafe {
                    cmd.pre_exec(move || {
                        let mut cur = libc::rlimit {
                            rlim_cur: 0,
                            rlim_max: 0,
                        };
                        if libc::getrlimit(libc::RLIMIT_AS, &mut cur) == 0 {
                            let target = mem_limit_bytes as libc::rlim_t;
                            let clamped = if cur.rlim_max == libc::RLIM_INFINITY {
                                target
                            } else {
                                target.min(cur.rlim_max)
                            };
                            let new_lim = libc::rlimit {
                                rlim_cur: clamped,
                                rlim_max: cur.rlim_max,
                            };
                            let _ = libc::setrlimit(libc::RLIMIT_AS, &new_lim);
                        }
                        Ok(())
                    });
                }
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn '{spawn_label}': {e}"))?;

        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();
        let max_out = policy.config().max_output_bytes;

        let stdout_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            if let Some(ref mut pipe) = stdout_pipe {
                let mut limited = pipe.take((max_out + 1) as u64);
                let _ = limited.read_to_end(&mut buf).await;
            }
            buf
        });
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            if let Some(ref mut pipe) = stderr_pipe {
                let mut limited = pipe.take((max_out + 1) as u64);
                let _ = limited.read_to_end(&mut buf).await;
            }
            buf
        });

        let (timed_out, exit_code) = match eff_timeout_ms {
            Some(limit_ms) => {
                match tokio::time::timeout(Duration::from_millis(limit_ms), child.wait()).await {
                    Ok(Ok(status)) => (false, status.code()),
                    Ok(Err(e)) => return Err(format!("wait error: {e}")),
                    Err(_) => {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        (true, None)
                    }
                }
            }
            None => match child.wait().await {
                Ok(status) => (false, status.code()),
                Err(e) => return Err(format!("wait error: {e}")),
            },
        };

        let mut stdout_bytes = stdout_task.await.unwrap_or_default();
        let mut stderr_bytes = stderr_task.await.unwrap_or_default();
        let stdout_truncated = stdout_bytes.len() > max_out;
        let stderr_truncated = stderr_bytes.len() > max_out;
        stdout_bytes.truncate(max_out);
        stderr_bytes.truncate(max_out);

        let result = json!({
            "exit_code": exit_code,
            "timed_out": timed_out,
            "stdout": String::from_utf8_lossy(&stdout_bytes),
            "stderr": String::from_utf8_lossy(&stderr_bytes),
            "truncated": stdout_truncated || stderr_truncated,
        });

        if timed_out {
            return Err(format!(
                "command timed out after {}ms",
                eff_timeout_ms.unwrap_or(0)
            ));
        }
        Ok(result)
    }

    async fn handle_fs_read(&self, params: &Value) -> Result<Value, String> {
        let policy = self.policy_snapshot();
        let raw_path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or("fs_read requires 'path'")?;
        let path = policy.validate_path(raw_path, true)?;
        let offset = params.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
        let max_limit = policy.config().max_output_bytes as u64;
        let limit = params
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(max_limit)
            .min(max_limit);

        let mut file = tokio::fs::File::open(&path)
            .await
            .map_err(|e| format!("failed to open file: {e}"))?;
        let meta = file
            .metadata()
            .await
            .map_err(|e| format!("metadata error: {e}"))?;
        let total_size = meta.len();

        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("seek error: {e}"))?;
        let mut buf = Vec::new();
        let mut reader = file.take(limit);
        reader
            .read_to_end(&mut buf)
            .await
            .map_err(|e| format!("read error: {e}"))?;
        let eof = offset.saturating_add(buf.len() as u64) >= total_size;
        let text = std::str::from_utf8(&buf).ok().map(|s| s.to_string());

        Ok(json!({
            "path": path.to_string_lossy(),
            "size": total_size,
            "offset": offset,
            "bytes_read": buf.len(),
            "eof": eof,
            "content_b64": STANDARD.encode(&buf),
            "text": text,
        }))
    }

    async fn handle_fs_write(&self, params: &Value) -> Result<Value, String> {
        let policy = self.policy_snapshot();
        if policy.is_read_only() {
            return Err("filesystem write denied by readonly sandbox policy".to_string());
        }
        let raw_path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or("fs_write requires 'path'")?;
        let path = policy.validate_path(raw_path, false)?;
        let append = params
            .get("append")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let bytes = if let Some(b64) = params.get("content_b64").and_then(|v| v.as_str()) {
            STANDARD
                .decode(b64)
                .map_err(|e| format!("invalid content_b64: {e}"))?
        } else if let Some(text) = params.get("content").and_then(|v| v.as_str()) {
            text.as_bytes().to_vec()
        } else {
            return Err("fs_write requires 'content_b64' or 'content'".to_string());
        };

        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("failed to create parent directory: {e}"))?;
        }

        let mut opts = tokio::fs::OpenOptions::new();
        opts.create(true).write(true);
        if append {
            opts.append(true);
        } else {
            opts.truncate(true);
        }
        let mut file = opts
            .open(&path)
            .await
            .map_err(|e| format!("failed to open for write: {e}"))?;
        file.write_all(&bytes)
            .await
            .map_err(|e| format!("write error: {e}"))?;
        file.flush().await.map_err(|e| format!("flush error: {e}"))?;

        Ok(json!({
            "path": path.to_string_lossy(),
            "bytes_written": bytes.len(),
        }))
    }

    async fn handle_fs_list(&self, params: &Value) -> Result<Value, String> {
        let policy = self.policy_snapshot();
        let path = match params.get("path").and_then(|v| v.as_str()) {
            Some(p) if !p.is_empty() => policy.validate_path(p, true)?,
            _ => policy.default_cwd()?,
        };

        let mut entries_rd = tokio::fs::read_dir(&path)
            .await
            .map_err(|e| format!("read_dir failed: {e}"))?;
        let mut entries = Vec::new();
        while let Some(entry) = entries_rd
            .next_entry()
            .await
            .map_err(|e| format!("read_dir entry error: {e}"))?
        {
            let meta = entry.metadata().await.ok();
            entries.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "is_dir": meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                "is_file": meta.as_ref().map(|m| m.is_file()).unwrap_or(false),
                "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
            }));
        }
        Ok(json!({
            "path": path.to_string_lossy(),
            "entries": entries,
        }))
    }

    async fn handle_transfer_chunk(&self, params: &Value) -> Result<Value, String> {
        let policy = self.policy_snapshot();
        if policy.is_read_only() {
            return Err("filesystem write denied by readonly sandbox policy".to_string());
        }
        let transfer_id = params
            .get("transfer_id")
            .and_then(|v| v.as_str())
            .ok_or("transfer_chunk requires 'transfer_id'")?;
        if transfer_id.is_empty()
            || !transfer_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("invalid transfer_id".to_string());
        }
        let raw_path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or("transfer_chunk requires 'path'")?;
        let target_path = policy.validate_path(raw_path, false)?;
        let offset = params.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
        let eof = params.get("eof").and_then(|v| v.as_bool()).unwrap_or(false);
        let chunk_b64 = params
            .get("chunk_b64")
            .and_then(|v| v.as_str())
            .ok_or("transfer_chunk requires 'chunk_b64'")?;
        let chunk = STANDARD
            .decode(chunk_b64)
            .map_err(|e| format!("invalid chunk_b64: {e}"))?;

        if let Some(expected_chunk_sha) = params.get("chunk_sha256").and_then(|v| v.as_str()) {
            let actual = hex::encode(Sha256::digest(&chunk));
            if !actual.eq_ignore_ascii_case(expected_chunk_sha) {
                return Err(format!(
                    "chunk_sha256 mismatch: expected {expected_chunk_sha}, got {actual}"
                ));
            }
        }

        let parent = target_path
            .parent()
            .ok_or("target path has no parent")?
            .to_path_buf();
        tokio::fs::create_dir_all(&parent)
            .await
            .map_err(|e| format!("failed to create target parent: {e}"))?;

        let staging_path = {
            let mut guard = self.transfers.lock().await;
            if let Some(sess) = guard.get(transfer_id) {
                if sess.target_path != target_path {
                    return Err("transfer_id target path mismatch".to_string());
                }
                sess.staging_path.clone()
            } else {
                let stage = parent.join(format!(".neo-part-{transfer_id}"));
                guard.insert(
                    transfer_id.to_string(),
                    TransferSession {
                        staging_path: stage.clone(),
                        target_path: target_path.clone(),
                    },
                );
                stage
            }
        };

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&staging_path)
            .await
            .map_err(|e| format!("failed to open staging file: {e}"))?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("staging seek error: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("staging write error: {e}"))?;
        file.flush()
            .await
            .map_err(|e| format!("staging flush error: {e}"))?;
        drop(file);

        let mut finalized = false;
        let mut final_sha_hex = None;
        if eof {
            let full = tokio::fs::read(&staging_path)
                .await
                .map_err(|e| format!("failed to read staging file for verification: {e}"))?;
            let actual_final = hex::encode(Sha256::digest(&full));
            if let Some(expected_final) = params.get("final_sha256").and_then(|v| v.as_str()) {
                if !actual_final.eq_ignore_ascii_case(expected_final) {
                    let _ = tokio::fs::remove_file(&staging_path).await;
                    self.transfers.lock().await.remove(transfer_id);
                    return Err(format!(
                        "final_sha256 mismatch: expected {expected_final}, got {actual_final}"
                    ));
                }
            }
            tokio::fs::rename(&staging_path, &target_path)
                .await
                .map_err(|e| format!("failed to finalize transfer rename: {e}"))?;
            self.transfers.lock().await.remove(transfer_id);
            finalized = true;
            final_sha_hex = Some(actual_final);
        }

        Ok(json!({
            "transfer_id": transfer_id,
            "path": target_path.to_string_lossy(),
            "offset": offset,
            "bytes_written": chunk.len(),
            "finalized": finalized,
            "sha256": final_sha_hex,
        }))
    }

    async fn handle_ota_stage(&self, params: &Value) -> Result<Value, String> {
        let cache_dir = self
            .ota_cache_dir
            .as_ref()
            .ok_or("ota_cache_dir not configured")?;
        let pub_hex = params
            .get("public_key_hex")
            .and_then(|v| v.as_str())
            .ok_or("ota_stage requires 'public_key_hex'")?;
        let sig_hex = params
            .get("signature_hex")
            .and_then(|v| v.as_str())
            .ok_or("ota_stage requires 'signature_hex'")?;
        let pkg_b64 = params
            .get("package_b64")
            .and_then(|v| v.as_str())
            .ok_or("ota_stage requires 'package_b64'")?;
        let version = params
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("staged");
        if version.is_empty()
            || !version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        {
            return Err("invalid OTA version string".to_string());
        }

        let pk_vec = hex::decode(pub_hex).map_err(|e| format!("invalid public_key_hex: {e}"))?;
        let pk: [u8; 32] = pk_vec
            .try_into()
            .map_err(|_| "public_key_hex must be 32 bytes".to_string())?;
        let sig_vec = hex::decode(sig_hex).map_err(|e| format!("invalid signature_hex: {e}"))?;
        let sig: [u8; 64] = sig_vec
            .try_into()
            .map_err(|_| "signature_hex must be 64 bytes".to_string())?;
        let pkg = STANDARD
            .decode(pkg_b64)
            .map_err(|e| format!("invalid package_b64: {e}"))?;

        verify_ed25519_signature(&pk, &pkg, &sig)?;

        tokio::fs::create_dir_all(cache_dir)
            .await
            .map_err(|e| format!("failed to create OTA cache dir: {e}"))?;
        let pkg_path = cache_dir.join(format!("ota-{version}.bin"));
        tokio::fs::write(&pkg_path, &pkg)
            .await
            .map_err(|e| format!("failed to write OTA artifact: {e}"))?;

        Ok(json!({
            "staged": true,
            "version": version,
            "size": pkg.len(),
            "sha256": hex::encode(Sha256::digest(&pkg)),
            "path": pkg_path.to_string_lossy(),
        }))
    }
}

pub fn split_command_no_shell(cmd_str: &str) -> Result<(String, Vec<String>), String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in cmd_str.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None => match ch {
                '\'' | '"' => quote = Some(ch),
                c if c.is_whitespace() => {
                    if !current.is_empty() {
                        tokens.push(std::mem::take(&mut current));
                    }
                }
                ';' | '&' | '|' | '`' | '$' | '(' | ')' | '<' | '>' | '\n' | '\r' => {
                    return Err(format!("shell operator '{ch}' is forbidden"));
                }
                _ => current.push(ch),
            },
        }
    }
    if quote.is_some() {
        return Err("unterminated quote in command string".to_string());
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    if tokens.is_empty() {
        return Err("empty command string".to_string());
    }
    let prog = tokens.remove(0);
    Ok((prog, tokens))
}

/// Best-effort adjustment of Linux `oom_score_adj` for the agent process.
pub fn best_effort_oom_score_adj(score: i32) {
    #[cfg(target_os = "linux")]
    {
        let _ = std::fs::write("/proc/self/oom_score_adj", format!("{score}\n"));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = score;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "neo_exec_test_{}_{}_{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn exec_fs_and_chunked_transfer_respect_policy() {
        let ws = make_test_workspace("all");
        let toml = format!(
            r#"
allowed_workspaces = ["{}"]
allowed_commands = ["echo", "sh"]
denied_commands = ["rm", "sh"]
max_child_mem_mb = 512
max_exec_timeout_sec = 5
"#,
            ws.display()
        );
        let policy = Arc::new(RwLock::new(Policy::from_toml_str(&toml).unwrap()));
        let exec = Executor::new(policy, None);

        // Allowed exec
        let res = exec
            .dispatch("exec", &json!({"program": "echo", "args": ["hello-neo"]}), None)
            .await;
        assert_eq!(res["ok"], true);
        assert!(res["result"]["stdout"].as_str().unwrap().contains("hello-neo"));

        // Denied exec
        let denied = exec
            .dispatch("exec", &json!({"program": "sh", "args": ["-c", "id"]}), None)
            .await;
        assert_eq!(denied["ok"], false);

        // Escape fs_read rejected
        let esc = exec
            .dispatch("fs_read", &json!({"path": "/etc/passwd"}), None)
            .await;
        assert_eq!(esc["ok"], false);

        // fs_write + fs_read inside workspace
        let target = ws.join("notes.txt");
        let wr = exec
            .dispatch(
                "fs_write",
                &json!({"path": target.to_string_lossy(), "content": "abc123"}),
                None,
            )
            .await;
        assert_eq!(wr["ok"], true);
        let rd = exec
            .dispatch("fs_read", &json!({"path": target.to_string_lossy()}), None)
            .await;
        assert_eq!(rd["ok"], true);
        assert_eq!(rd["result"]["text"], "abc123");

        // Chunked SHA-256 verified transfer
        let c1 = b"hello-";
        let c2 = b"transfer";
        let mut full = Vec::new();
        full.extend_from_slice(c1);
        full.extend_from_slice(c2);
        let final_sha = hex::encode(Sha256::digest(&full));
        let tx_target = ws.join("bin/payload.bin");

        let r1 = exec
            .dispatch(
                "transfer_chunk",
                &json!({
                    "transfer_id": "tx_1",
                    "path": tx_target.to_string_lossy(),
                    "offset": 0,
                    "chunk_b64": STANDARD.encode(c1),
                    "chunk_sha256": hex::encode(Sha256::digest(c1)),
                    "eof": false
                }),
                None,
            )
            .await;
        assert_eq!(r1["ok"], true);

        let r2 = exec
            .dispatch(
                "transfer_chunk",
                &json!({
                    "transfer_id": "tx_1",
                    "path": tx_target.to_string_lossy(),
                    "offset": c1.len(),
                    "chunk_b64": STANDARD.encode(c2),
                    "chunk_sha256": hex::encode(Sha256::digest(c2)),
                    "final_sha256": final_sha,
                    "eof": true
                }),
                None,
            )
            .await;
        assert_eq!(r2["ok"], true);
        assert_eq!(r2["result"]["finalized"], true);
        assert_eq!(std::fs::read(&tx_target).unwrap(), full);

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn readonly_blocks_fs_write_and_transfer_but_allows_read_and_list() {
        let ws = make_test_workspace("readonly");
        let existing = ws.join("readme.txt");
        std::fs::write(&existing, "readonly-content").unwrap();

        let policy = Arc::new(RwLock::new(
            Policy::from_preset(
                SandboxLevel::Readonly,
                vec![ws.to_string_lossy().into_owned()],
                false,
            )
            .unwrap(),
        ));
        let exec = Executor::new(policy, None);

        // fs_read allowed inside workspace
        let rd = exec
            .dispatch("fs_read", &json!({"path": existing.to_string_lossy()}), None)
            .await;
        assert_eq!(rd["ok"], true);
        assert_eq!(rd["result"]["text"], "readonly-content");

        // fs_list allowed inside workspace
        let ls = exec
            .dispatch("fs_list", &json!({"path": ws.to_string_lossy()}), None)
            .await;
        assert_eq!(ls["ok"], true);
        let names: Vec<&str> = ls["result"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["name"].as_str())
            .collect();
        assert!(names.contains(&"readme.txt"));

        // fs_write blocked
        let wr = exec
            .dispatch(
                "fs_write",
                &json!({"path": ws.join("blocked.txt").to_string_lossy(), "content": "nope"}),
                None,
            )
            .await;
        assert_eq!(wr["ok"], false);
        assert_eq!(
            wr["error"].as_str().unwrap(),
            "filesystem write denied by readonly sandbox policy"
        );
        assert!(!ws.join("blocked.txt").exists());

        // transfer_chunk blocked
        let tx = exec
            .dispatch(
                "transfer_chunk",
                &json!({
                    "transfer_id": "tx_ro",
                    "path": ws.join("tx.bin").to_string_lossy(),
                    "offset": 0,
                    "chunk_b64": STANDARD.encode(b"abc"),
                    "eof": true
                }),
                None,
            )
            .await;
        assert_eq!(tx["ok"], false);
        assert_eq!(
            tx["error"].as_str().unwrap(),
            "filesystem write denied by readonly sandbox policy"
        );

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn unrestricted_allows_outside_fs_dotdot_pipeline_env_and_zero_limits() {
        let ws = make_test_workspace("unr_ws");
        let outside = make_test_workspace("unr_out");
        let sub = outside.join("sub");
        std::fs::create_dir_all(&sub).unwrap();

        let policy = Arc::new(RwLock::new(
            Policy::from_preset(
                SandboxLevel::Unrestricted,
                vec![ws.to_string_lossy().into_owned()],
                false,
            )
            .unwrap(),
        ));
        assert_eq!(policy.read().unwrap().config().max_child_mem_mb, 0);
        assert_eq!(policy.read().unwrap().config().max_exec_timeout_sec, 0);
        let exec = Executor::new(policy, None);

        // Write and read outside workspace using a path containing `..`
        let outside_dotdot = format!("{}/../outside_note.txt", sub.display());
        let wr = exec
            .dispatch(
                "fs_write",
                &json!({"path": outside_dotdot, "content": "outside-ok"}),
                None,
            )
            .await;
        assert_eq!(wr["ok"], true, "fs_write failed: {wr}");

        let rd = exec
            .dispatch("fs_read", &json!({"path": outside_dotdot}), None)
            .await;
        assert_eq!(rd["ok"], true, "fs_read failed: {rd}");
        assert_eq!(rd["result"]["text"], "outside-ok");

        // Shell pipeline via `cmd` and no policy timeout (max_exec_timeout_sec = 0)
        #[cfg(unix)]
        {
            let pipe_res = exec
                .dispatch(
                    "exec",
                    &json!({"cmd": "echo hello | tr a-z A-Z", "cwd": outside.to_string_lossy()}),
                    None,
                )
                .await;
            assert_eq!(pipe_res["ok"], true, "pipeline exec failed: {pipe_res}");
            assert_eq!(pipe_res["result"]["stdout"].as_str().unwrap().trim(), "HELLO");

            // Host env is inherited and params.env overrides are not filtered by BLOCKED_ENV_VARS
            let host_var = std::env::vars().find(|(k, v)| {
                !matches!(k.as_str(), "PATH" | "HOME" | "LANG" | "PWD" | "SHLVL" | "_")
                    && !v.is_empty()
                    && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            });
            let env_res = exec
                .dispatch(
                    "exec",
                    &json!({
                        "program": "env",
                        "args": [],
                        "env": {
                            "NEO_UNRESTRICTED_TEST": "yes",
                            "DYLD_FRAMEWORK_PATH": "/tmp/custom-fw"
                        }
                    }),
                    Some(2000),
                )
                .await;
            assert_eq!(env_res["ok"], true, "env exec failed: {env_res}");
            let env_out = env_res["result"]["stdout"].as_str().unwrap();
            assert!(env_out.contains("NEO_UNRESTRICTED_TEST=yes"));
            assert!(env_out.contains("DYLD_FRAMEWORK_PATH=/tmp/custom-fw"));
            if let Some((hk, hv)) = host_var {
                assert!(
                    env_out.contains(&format!("{hk}={hv}")),
                    "expected inherited host env {hk}={hv} in output"
                );
            }
        }

        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn set_sandbox_transitions_preserve_workspaces_and_persist_with_fallback() {
        let root = make_test_workspace("switch");
        let ws = root.join("work");
        let outside = root.join("outside");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("ext.txt");
        std::fs::write(&outside_file, "external-data").unwrap();

        let policy_path = root.join("policy-personal.toml");
        let override_path = root.join("ota").join("sandbox-override.toml");

        let initial = Policy::from_preset(
            SandboxLevel::Personal,
            vec![ws.to_string_lossy().into_owned()],
            false,
        )
        .unwrap();
        initial.persist_to_file(&policy_path).unwrap();
        // Plant a stale override file to verify primary persistence cleans it up
        std::fs::create_dir_all(override_path.parent().unwrap()).unwrap();
        std::fs::write(&override_path, "stale = true\n").unwrap();

        let shared = Arc::new(RwLock::new(initial));
        let exec = Executor::new(Arc::clone(&shared), None)
            .with_policy_paths(Some(policy_path.clone()), Some(override_path.clone()));

        // 1. personal -> outside fs_read denied
        let r_denied = exec
            .dispatch("fs_read", &json!({"path": outside_file.to_string_lossy()}), None)
            .await;
        assert_eq!(r_denied["ok"], false);

        // 2. personal -> unrestricted
        let sw_unr = exec
            .dispatch("set_sandbox", &json!({"level": "unrestricted"}), None)
            .await;
        assert_eq!(sw_unr["ok"], true, "switch to unrestricted failed: {sw_unr}");
        assert_eq!(sw_unr["result"]["level"], "unrestricted");
        assert_eq!(sw_unr["result"]["sandbox"]["unrestricted"], true);
        assert_eq!(sw_unr["result"]["persisted"], true);
        assert_eq!(
            sw_unr["result"]["persisted_path"].as_str(),
            Some(policy_path.to_string_lossy().as_ref())
        );
        assert!(sw_unr["result"]["warning"].is_null());
        assert!(!override_path.exists(), "stale override should be removed");

        // Reload persisted policy from disk and verify workspaces preserved
        let disk_unr = Policy::from_file(&policy_path).unwrap();
        assert!(disk_unr.is_unrestricted());
        assert_eq!(
            disk_unr.config().allowed_workspaces,
            vec![ws.to_string_lossy().into_owned()]
        );

        // Now outside fs_read succeeds
        let r_ok = exec
            .dispatch("fs_read", &json!({"path": outside_file.to_string_lossy()}), None)
            .await;
        assert_eq!(r_ok["ok"], true);
        assert_eq!(r_ok["result"]["text"], "external-data");

        // 3. unrestricted -> readonly (restores workspace confinement & blocks writes)
        let sw_ro = exec
            .dispatch("sandbox.set", &json!({"level": "readonly"}), None)
            .await;
        assert_eq!(sw_ro["ok"], true);
        assert_eq!(sw_ro["result"]["level"], "readonly");
        assert_eq!(sw_ro["result"]["sandbox"]["read_only"], true);
        assert_eq!(sw_ro["result"]["sandbox"]["unrestricted"], false);

        let r_out_again = exec
            .dispatch("fs_read", &json!({"path": outside_file.to_string_lossy()}), None)
            .await;
        assert_eq!(r_out_again["ok"], false);
        let w_ro = exec
            .dispatch(
                "fs_write",
                &json!({"path": ws.join("ro.txt").to_string_lossy(), "content": "x"}),
                None,
            )
            .await;
        assert_eq!(w_ro["ok"], false);

        // 4. readonly -> personal (restores writes inside workspace, keeps outside blocked)
        let sw_pers = exec
            .dispatch("set_sandbox", &json!({"level": "personal"}), None)
            .await;
        assert_eq!(sw_pers["ok"], true);
        assert_eq!(sw_pers["result"]["level"], "personal");
        let w_pers = exec
            .dispatch(
                "fs_write",
                &json!({"path": ws.join("ok.txt").to_string_lossy(), "content": "back"}),
                None,
            )
            .await;
        assert_eq!(w_pers["ok"], true);
        let r_out_still_blocked = exec
            .dispatch("fs_read", &json!({"path": outside_file.to_string_lossy()}), None)
            .await;
        assert_eq!(r_out_still_blocked["ok"], false);

        // 5. Fallback to override file when primary policy_path cannot be written (e.g. directory path)
        let unwritable_policy_dir = root.join("unwritable_primary_dir");
        std::fs::create_dir_all(&unwritable_policy_dir).unwrap();
        let fallback_override = root.join("fallback_ota").join("sandbox-override.toml");
        let exec_fb = Executor::new(Arc::clone(&shared), None)
            .with_policy_paths(Some(unwritable_policy_dir), Some(fallback_override.clone()));
        let sw_fb = exec_fb
            .dispatch("set_sandbox", &json!({"level": "desktop"}), None)
            .await;
        assert_eq!(sw_fb["ok"], true, "fallback switch failed: {sw_fb}");
        assert_eq!(sw_fb["result"]["level"], "desktop");
        assert_eq!(sw_fb["result"]["persisted"], true);
        assert_eq!(
            sw_fb["result"]["persisted_path"].as_str(),
            Some(fallback_override.to_string_lossy().as_ref())
        );
        assert!(sw_fb["result"]["warning"].as_str().is_some());
        let loaded_ov = Policy::from_file(&fallback_override).unwrap();
        assert_eq!(loaded_ov.effective_level(), SandboxLevel::Desktop);

        // 6. Reject `..` in workspaces when switching to a restricted level without mutating policy
        let bad_ws = exec_fb
            .dispatch(
                "set_sandbox",
                &json!({"level": "personal", "workspaces": [format!("{}/../outside", ws.display())]}),
                None,
            )
            .await;
        assert_eq!(bad_ws["ok"], false);
        assert_eq!(shared.read().unwrap().effective_level(), SandboxLevel::Desktop);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn lock_sandbox_rejects_remote_set_sandbox() {
        let ws = make_test_workspace("locked");
        let locked_policy = Policy::from_preset(
            SandboxLevel::Corp,
            vec![ws.to_string_lossy().into_owned()],
            true,
        )
        .unwrap();
        let shared = Arc::new(RwLock::new(locked_policy));
        let exec = Executor::new(Arc::clone(&shared), None);

        let res = exec
            .dispatch("set_sandbox", &json!({"level": "unrestricted"}), None)
            .await;
        assert_eq!(res["ok"], false);
        assert!(res["error"]
            .as_str()
            .unwrap()
            .contains("lock_sandbox = true"));
        assert_eq!(shared.read().unwrap().effective_level(), SandboxLevel::Corp);
        assert!(!shared.read().unwrap().is_unrestricted());

        let _ = std::fs::remove_dir_all(&ws);
    }
}
