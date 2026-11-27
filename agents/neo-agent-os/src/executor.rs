use crate::policy::Policy;
use crate::updater::verify_ed25519_signature;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
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
    policy: Arc<Policy>,
    ota_cache_dir: Option<PathBuf>,
    transfers: Mutex<HashMap<String, TransferSession>>,
}

impl Executor {
    pub fn new(policy: Arc<Policy>, ota_cache_dir: Option<PathBuf>) -> Self {
        Self {
            policy,
            ota_cache_dir,
            transfers: Mutex::new(HashMap::new()),
        }
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
            other => Err(format!("unsupported RPC method: {other}")),
        };
        match res {
            Ok(result) => json!({ "ok": true, "result": result }),
            Err(error) => json!({ "ok": false, "error": error }),
        }
    }

    async fn handle_exec(&self, params: &Value, timeout_ms: Option<u64>) -> Result<Value, String> {
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

        let validated_program = self.policy.validate_command(&program)?;

        let cwd = match params.get("cwd").and_then(|v| v.as_str()) {
            Some(c) if !c.is_empty() => self.policy.validate_path(c, true)?,
            _ => self.policy.default_workspace()?.to_path_buf(),
        };
        if !cwd.is_dir() {
            return Err(format!("cwd is not a directory: {}", cwd.display()));
        }

        let max_timeout_ms = self.policy.config().max_exec_timeout_sec.saturating_mul(1000);
        let eff_timeout_ms = timeout_ms
            .unwrap_or(max_timeout_ms)
            .min(max_timeout_ms)
            .max(100);

        let mut cmd = Command::new(&validated_program);
        cmd.args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env_clear();

        #[cfg(target_os = "macos")]
        {
            cmd.env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
                .env("HOME", cwd.to_string_lossy().as_ref())
                .env("LANG", "C.UTF-8");
        }
        #[cfg(target_os = "windows")]
        {
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

        // Best-effort Linux RLIMIT_AS memory cap in child pre_exec.
        #[cfg(target_os = "linux")]
        {
            let mem_limit_bytes = self
                .policy
                .config()
                .max_child_mem_mb
                .saturating_mul(1024 * 1024);
            unsafe {
                cmd.pre_exec(move || {
                    if mem_limit_bytes > 0 {
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
                    }
                    Ok(())
                });
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn '{validated_program}': {e}"))?;

        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();
        let max_out = self.policy.config().max_output_bytes;

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

        let wait_res = tokio::time::timeout(Duration::from_millis(eff_timeout_ms), child.wait()).await;
        let (timed_out, exit_code) = match wait_res {
            Ok(Ok(status)) => (false, status.code()),
            Ok(Err(e)) => return Err(format!("wait error: {e}")),
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                (true, None)
            }
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
            return Err(format!("command timed out after {eff_timeout_ms}ms"));
        }
        Ok(result)
    }

    async fn handle_fs_read(&self, params: &Value) -> Result<Value, String> {
        let raw_path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or("fs_read requires 'path'")?;
        let path = self.policy.validate_path(raw_path, true)?;
        let offset = params.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
        let max_limit = self.policy.config().max_output_bytes as u64;
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
        let raw_path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or("fs_write requires 'path'")?;
        let path = self.policy.validate_path(raw_path, false)?;
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
        let path = match params.get("path").and_then(|v| v.as_str()) {
            Some(p) if !p.is_empty() => self.policy.validate_path(p, true)?,
            _ => self.policy.default_workspace()?.to_path_buf(),
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
        let target_path = self.policy.validate_path(raw_path, false)?;
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
        let policy = Arc::new(Policy::from_toml_str(&toml).unwrap());
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
}
