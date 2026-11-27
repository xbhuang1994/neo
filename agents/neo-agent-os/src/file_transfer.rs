use crate::policy::Policy;
use crate::protocol::{validate_transfer_id, FileFrame, FileFrameKind};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex, Notify};

pub const DEFAULT_FILE_CHUNK_BYTES: usize = 128 * 1024;
pub const MIN_FILE_CHUNK_BYTES: usize = 4 * 1024;
pub const MAX_FILE_CHUNK_BYTES: usize = 512 * 1024;
pub const DEFAULT_FILE_WINDOW_BYTES: u32 = 512 * 1024;
pub const MAX_FILE_WINDOW_BYTES: u32 = 2 * 1024 * 1024;
pub const MAX_CONCURRENT_TRANSFERS: usize = 16;

const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const COMPLETED_CACHE_TTL: Duration = Duration::from_secs(60);
const PULL_STALL_TIMEOUT: Duration = Duration::from_secs(3);
const PULL_MAX_STALL_RETRIES: usize = 10;
const PULL_DONE_TIMEOUT: Duration = Duration::from_secs(3);
const PULL_MAX_FINISH_RETRIES: usize = 5;

#[derive(Debug, Clone)]
pub struct OutboundFileFrame {
    pub dst: String,
    pub frame: FileFrame,
}

#[derive(Debug)]
enum PullSignal {
    Ack { offset: u64, window: u32 },
    Done { offset: u64, sha256: Vec<u8> },
    Abort { reason: String },
    RateLimited,
}

struct PullSessionHandle {
    peer_id: String,
    sig_tx: mpsc::Sender<PullSignal>,
}

struct PushSession {
    peer_id: String,
    staging_path: PathBuf,
    target_path: PathBuf,
    total_size: u64,
    received_bytes: u64,
    window_bytes: u32,
    overwrite: bool,
    expected_sha256: Option<[u8; 32]>,
    file: tokio::fs::File,
    hasher: Sha256,
    last_activity: Instant,
}

#[derive(Clone)]
struct CompletedRecord {
    peer_id: String,
    size: u64,
    sha256: [u8; 32],
    completed_at: Instant,
}

pub struct FileTransferManager {
    policy: Arc<Policy>,
    outbound_tx: mpsc::Sender<OutboundFileFrame>,
    pulls: Mutex<HashMap<String, PullSessionHandle>>,
    pushes: Mutex<HashMap<String, PushSession>>,
    completed: Mutex<HashMap<String, CompletedRecord>>,
    rate_notify: Arc<Notify>,
}

impl FileTransferManager {
    pub fn new(policy: Arc<Policy>, outbound_tx: mpsc::Sender<OutboundFileFrame>) -> Arc<Self> {
        Arc::new(Self {
            policy,
            outbound_tx,
            pulls: Mutex::new(HashMap::new()),
            pushes: Mutex::new(HashMap::new()),
            completed: Mutex::new(HashMap::new()),
            rate_notify: Arc::new(Notify::new()),
        })
    }

    pub async fn notify_rate_limited(&self) {
        self.rate_notify.notify_waiters();
        let pulls = self.pulls.lock().await;
        for handle in pulls.values() {
            let _ = handle.sig_tx.try_send(PullSignal::RateLimited);
        }
    }

    pub async fn fail_all_for_disconnect(&self, reason: &str) {
        {
            let mut pulls = self.pulls.lock().await;
            for (_, handle) in pulls.drain() {
                let _ = handle.sig_tx.try_send(PullSignal::Abort {
                    reason: reason.to_string(),
                });
            }
        }
        {
            let mut pushes = self.pushes.lock().await;
            for (_, sess) in pushes.drain() {
                drop(sess.file);
                let _ = tokio::fs::remove_file(&sess.staging_path).await;
            }
        }
    }

    async fn reap_stale_locked(
        pushes: &mut HashMap<String, PushSession>,
        completed: &mut HashMap<String, CompletedRecord>,
    ) {
        let now = Instant::now();
        let stale_ids: Vec<String> = pushes
            .iter()
            .filter(|(_, s)| now.duration_since(s.last_activity) > SESSION_IDLE_TIMEOUT)
            .map(|(k, _)| k.clone())
            .collect();
        for id in stale_ids {
            if let Some(sess) = pushes.remove(&id) {
                drop(sess.file);
                let _ = tokio::fs::remove_file(&sess.staging_path).await;
            }
        }
        completed.retain(|_, rec| now.duration_since(rec.completed_at) <= COMPLETED_CACHE_TTL);
    }

    /// Handles `file.pull.open` / `file_pull_open`: validates policy & opens file,
    /// returning `(rpc_result, streaming_future_starter)` so the caller can enqueue
    /// the `rpc_resp` BEFORE the first `0xE3` `DATA` frame hits the wire.
    pub async fn open_pull(
        self: &Arc<Self>,
        peer_id: &str,
        params: &Value,
    ) -> Result<(Value, PullStreamTask), String> {
        let transfer_id = params
            .get("transfer_id")
            .and_then(|v| v.as_str())
            .ok_or("file.pull.open requires 'transfer_id'")?
            .to_string();
        validate_transfer_id(&transfer_id)?;

        let raw_path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or("file.pull.open requires 'path'")?;
        let path = self.policy.validate_path(raw_path, true)?;
        let meta = tokio::fs::metadata(&path)
            .await
            .map_err(|e| format!("failed to stat file for pull: {e}"))?;
        if !meta.is_file() {
            return Err(format!("pull target is not a regular file: {}", path.display()));
        }
        let total_size = meta.len();
        let mtime_ms = system_time_to_ms(meta.modified().ok());

        let offset = params.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
        if offset > total_size {
            return Err(format!(
                "pull offset {offset} exceeds file size {total_size}"
            ));
        }
        let chunk_size = params
            .get("chunk_size")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_FILE_CHUNK_BYTES)
            .clamp(MIN_FILE_CHUNK_BYTES, MAX_FILE_CHUNK_BYTES);
        let window_bytes = params
            .get("window_bytes")
            .and_then(|v| v.as_u64())
            .map(|v| v.min(MAX_FILE_WINDOW_BYTES as u64) as u32)
            .unwrap_or(DEFAULT_FILE_WINDOW_BYTES)
            .max(chunk_size as u32);

        let file = tokio::fs::File::open(&path)
            .await
            .map_err(|e| format!("failed to open file for pull: {e}"))?;

        let (sig_tx, sig_rx) = mpsc::channel::<PullSignal>(128);
        {
            let mut pulls = self.pulls.lock().await;
            let pushes = self.pushes.lock().await;
            if pulls.contains_key(&transfer_id) || pushes.contains_key(&transfer_id) {
                return Err(format!("transfer_id already active: {transfer_id}"));
            }
            if pulls.len() + pushes.len() >= MAX_CONCURRENT_TRANSFERS {
                return Err("too many concurrent file transfers".to_string());
            }
            pulls.insert(
                transfer_id.clone(),
                PullSessionHandle {
                    peer_id: peer_id.to_string(),
                    sig_tx,
                },
            );
        }

        let rpc_result = json!({
            "transfer_id": transfer_id,
            "path": path.to_string_lossy(),
            "size": total_size,
            "offset": offset,
            "chunk_size": chunk_size,
            "window_bytes": window_bytes,
            "mtime_ms": mtime_ms,
            "protocol": "binary_e2e_v1",
        });

        let task = PullStreamTask {
            manager: Arc::clone(self),
            peer_id: peer_id.to_string(),
            transfer_id,
            file,
            total_size,
            start_offset: offset,
            chunk_size,
            initial_window: window_bytes,
            sig_rx,
        };

        Ok((rpc_result, task))
    }

    /// Handles `file.push.open` / `file_push_open`: validates target path, prepares staging file,
    /// optionally resumes from existing `.neo-part-<transfer_id>`, and registers push receiver.
    pub async fn open_push(&self, peer_id: &str, params: &Value) -> Result<Value, String> {
        let transfer_id = params
            .get("transfer_id")
            .and_then(|v| v.as_str())
            .ok_or("file.push.open requires 'transfer_id'")?
            .to_string();
        validate_transfer_id(&transfer_id)?;

        let raw_path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or("file.push.open requires 'path'")?;
        let target_path = self.policy.validate_path(raw_path, false)?;

        let total_size = params
            .get("size")
            .and_then(|v| v.as_u64())
            .ok_or("file.push.open requires 'size'")?;
        let overwrite = params
            .get("overwrite")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let resume = params
            .get("resume")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let chunk_size = params
            .get("chunk_size")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_FILE_CHUNK_BYTES)
            .clamp(MIN_FILE_CHUNK_BYTES, MAX_FILE_CHUNK_BYTES);
        let window_bytes = params
            .get("window_bytes")
            .and_then(|v| v.as_u64())
            .map(|v| v.min(MAX_FILE_WINDOW_BYTES as u64) as u32)
            .unwrap_or(DEFAULT_FILE_WINDOW_BYTES)
            .max(chunk_size as u32);

        let expected_sha256 = match params.get("sha256").and_then(|v| v.as_str()) {
            Some(hex_str) if !hex_str.is_empty() => {
                let raw = hex::decode(hex_str)
                    .map_err(|e| format!("invalid sha256 hex: {e}"))?;
                let arr: [u8; 32] = raw
                    .try_into()
                    .map_err(|_| "sha256 must be 32 bytes (64 hex chars)".to_string())?;
                Some(arr)
            }
            _ => None,
        };

        if !overwrite {
            if let Ok(meta) = tokio::fs::symlink_metadata(&target_path).await {
                if meta.is_file() || meta.is_dir() || meta.file_type().is_symlink() {
                    return Err(format!(
                        "destination already exists and overwrite is false: {}",
                        target_path.display()
                    ));
                }
            }
        } else if let Ok(meta) = tokio::fs::metadata(&target_path).await {
            if meta.is_dir() {
                return Err(format!(
                    "destination is a directory: {}",
                    target_path.display()
                ));
            }
        }

        let parent = target_path
            .parent()
            .ok_or("target path has no parent directory")?
            .to_path_buf();
        tokio::fs::create_dir_all(&parent)
            .await
            .map_err(|e| format!("failed to create target parent directory: {e}"))?;

        let staging_path = parent.join(format!(".neo-part-{transfer_id}"));
        let mut hasher = Sha256::new();
        let mut resume_offset: u64 = 0;

        if resume {
            if let Ok(meta) = tokio::fs::metadata(&staging_path).await {
                if meta.is_file() && meta.len() <= total_size {
                    let mut existing = tokio::fs::File::open(&staging_path)
                        .await
                        .map_err(|e| format!("failed to open staging file for resume: {e}"))?;
                    let mut buf = vec![0u8; 64 * 1024];
                    loop {
                        let n = existing
                            .read(&mut buf)
                            .await
                            .map_err(|e| format!("failed reading staging file for resume: {e}"))?;
                        if n == 0 {
                            break;
                        }
                        hasher.update(&buf[..n]);
                        resume_offset += n as u64;
                    }
                }
            }
        }

        let mut opts = tokio::fs::OpenOptions::new();
        opts.create(true).write(true);
        if resume && resume_offset > 0 {
            opts.append(false);
        } else {
            opts.truncate(true);
            resume_offset = 0;
            hasher = Sha256::new();
        }
        let mut file = opts
            .open(&staging_path)
            .await
            .map_err(|e| format!("failed to open staging file: {e}"))?;
        if resume_offset > 0 {
            file.seek(std::io::SeekFrom::Start(resume_offset))
                .await
                .map_err(|e| format!("failed to seek staging file: {e}"))?;
        }

        {
            let pulls = self.pulls.lock().await;
            let mut pushes = self.pushes.lock().await;
            let mut completed = self.completed.lock().await;
            Self::reap_stale_locked(&mut pushes, &mut completed).await;

            if pulls.contains_key(&transfer_id) || pushes.contains_key(&transfer_id) {
                return Err(format!("transfer_id already active: {transfer_id}"));
            }
            if pulls.len() + pushes.len() >= MAX_CONCURRENT_TRANSFERS {
                return Err("too many concurrent file transfers".to_string());
            }

            pushes.insert(
                transfer_id.clone(),
                PushSession {
                    peer_id: peer_id.to_string(),
                    staging_path,
                    target_path: target_path.clone(),
                    total_size,
                    received_bytes: resume_offset,
                    window_bytes,
                    overwrite,
                    expected_sha256,
                    file,
                    hasher,
                    last_activity: Instant::now(),
                },
            );
        }

        Ok(json!({
            "transfer_id": transfer_id,
            "path": target_path.to_string_lossy(),
            "size": total_size,
            "resume_offset": resume_offset,
            "chunk_size": chunk_size,
            "window_bytes": window_bytes,
            "protocol": "binary_e2e_v1",
        }))
    }

    pub async fn abort_transfer(&self, peer_id: &str, params: &Value) -> Result<Value, String> {
        let transfer_id = params
            .get("transfer_id")
            .and_then(|v| v.as_str())
            .ok_or("file.transfer.abort requires 'transfer_id'")?;
        validate_transfer_id(transfer_id)?;
        let keep_partial = params
            .get("keep_partial")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut aborted = false;
        {
            let mut pulls = self.pulls.lock().await;
            if let Some(handle) = pulls.get(transfer_id) {
                if handle.peer_id != peer_id {
                    return Err("transfer_id belongs to another peer".to_string());
                }
            }
            if let Some(handle) = pulls.remove(transfer_id) {
                let _ = handle.sig_tx.try_send(PullSignal::Abort {
                    reason: "aborted by peer RPC".to_string(),
                });
                aborted = true;
            }
        }
        {
            let mut pushes = self.pushes.lock().await;
            if let Some(sess) = pushes.get(transfer_id) {
                if sess.peer_id != peer_id {
                    return Err("transfer_id belongs to another peer".to_string());
                }
            }
            if let Some(sess) = pushes.remove(transfer_id) {
                drop(sess.file);
                if !keep_partial {
                    let _ = tokio::fs::remove_file(&sess.staging_path).await;
                }
                aborted = true;
            }
        }

        Ok(json!({
            "transfer_id": transfer_id,
            "aborted": aborted,
        }))
    }

    pub async fn handle_incoming_frame(&self, peer_id: &str, frame: FileFrame) {
        match frame.kind {
            FileFrameKind::Ack => {
                let sig_tx = {
                    let pulls = self.pulls.lock().await;
                    pulls
                        .get(&frame.transfer_id)
                        .filter(|h| h.peer_id == peer_id)
                        .map(|h| h.sig_tx.clone())
                };
                if let Some(tx) = sig_tx {
                    let _ = tx
                        .send(PullSignal::Ack {
                            offset: frame.offset,
                            window: frame.window,
                        })
                        .await;
                }
            }
            FileFrameKind::Done => {
                let sig_tx = {
                    let pulls = self.pulls.lock().await;
                    pulls
                        .get(&frame.transfer_id)
                        .filter(|h| h.peer_id == peer_id)
                        .map(|h| h.sig_tx.clone())
                };
                if let Some(tx) = sig_tx {
                    let _ = tx
                        .send(PullSignal::Done {
                            offset: frame.offset,
                            sha256: frame.data,
                        })
                        .await;
                }
            }
            FileFrameKind::Abort => {
                let reason = String::from_utf8_lossy(&frame.data).to_string();
                let mut handled_pull = false;
                {
                    let mut pulls = self.pulls.lock().await;
                    if pulls
                        .get(&frame.transfer_id)
                        .is_some_and(|h| h.peer_id == peer_id)
                    {
                        if let Some(h) = pulls.remove(&frame.transfer_id) {
                            let _ = h.sig_tx.try_send(PullSignal::Abort { reason });
                            handled_pull = true;
                        }
                    }
                }
                if !handled_pull {
                    let mut pushes = self.pushes.lock().await;
                    if pushes
                        .get(&frame.transfer_id)
                        .is_some_and(|s| s.peer_id == peer_id)
                    {
                        if let Some(sess) = pushes.remove(&frame.transfer_id) {
                            drop(sess.file);
                            let _ = tokio::fs::remove_file(&sess.staging_path).await;
                        }
                    }
                }
            }
            FileFrameKind::Data => {
                self.handle_push_data(peer_id, frame).await;
            }
            FileFrameKind::Finish => {
                self.handle_push_finish(peer_id, frame).await;
            }
        }
    }

    async fn handle_push_data(&self, peer_id: &str, frame: FileFrame) {
        let mut ack_to_send: Option<(u64, u32)> = None;
        let mut abort_reason: Option<String> = None;

        {
            let mut pushes = self.pushes.lock().await;
            let Some(sess) = pushes.get_mut(&frame.transfer_id) else {
                return;
            };
            if sess.peer_id != peer_id {
                return;
            }
            sess.last_activity = Instant::now();

            if frame.offset == sess.received_bytes {
                let end_offset = match frame.offset.checked_add(frame.data.len() as u64) {
                    Some(end) if end <= sess.total_size => end,
                    _ => {
                        abort_reason = Some(format!(
                            "chunk exceeds declared size: offset={} len={} total={}",
                            frame.offset,
                            frame.data.len(),
                            sess.total_size
                        ));
                        0
                    }
                };
                if abort_reason.is_none() {
                    if let Err(e) = sess.file.write_all(&frame.data).await {
                        abort_reason = Some(format!("staging write error: {e}"));
                    } else {
                        sess.hasher.update(&frame.data);
                        sess.received_bytes = end_offset;
                        ack_to_send = Some((sess.received_bytes, sess.window_bytes));
                    }
                }
            } else {
                // Duplicate (offset < received_bytes) or gap after dropped frame (offset > received_bytes):
                // reply cumulative ACK so sender advances or rewinds cleanly.
                ack_to_send = Some((sess.received_bytes, sess.window_bytes));
            }

            if abort_reason.is_some() {
                if let Some(dead) = pushes.remove(&frame.transfer_id) {
                    drop(dead.file);
                    let _ = tokio::fs::remove_file(&dead.staging_path).await;
                }
            }
        }

        if let Some(reason) = abort_reason {
            self.send_abort(peer_id, &frame.transfer_id, &reason).await;
        } else if let Some((offset, window)) = ack_to_send {
            let _ = self
                .outbound_tx
                .send(OutboundFileFrame {
                    dst: peer_id.to_string(),
                    frame: FileFrame {
                        kind: FileFrameKind::Ack,
                        flags: 0,
                        seq: frame.seq,
                        offset,
                        window,
                        transfer_id: frame.transfer_id,
                        data: Vec::new(),
                    },
                })
                .await;
        }
    }

    async fn handle_push_finish(&self, peer_id: &str, frame: FileFrame) {
        // Idempotent DONE re-send if a duplicate FINISH arrives after completion.
        {
            let completed = self.completed.lock().await;
            if let Some(rec) = completed.get(&frame.transfer_id) {
                if rec.peer_id == peer_id {
                    let _ = self
                        .outbound_tx
                        .send(OutboundFileFrame {
                            dst: peer_id.to_string(),
                            frame: FileFrame {
                                kind: FileFrameKind::Done,
                                flags: 0,
                                seq: frame.seq,
                                offset: rec.size,
                                window: 0,
                                transfer_id: frame.transfer_id,
                                data: rec.sha256.to_vec(),
                            },
                        })
                        .await;
                    return;
                }
            }
        }

        let removed = {
            let mut pushes = self.pushes.lock().await;
            if pushes
                .get(&frame.transfer_id)
                .is_none_or(|s| s.peer_id != peer_id)
            {
                return;
            }
            pushes.remove(&frame.transfer_id)
        };
        let Some(mut sess) = removed else {
            return;
        };

        let finalize_res: Result<[u8; 32], String> = async {
            if frame.data.len() != 32 {
                return Err(format!(
                    "FINISH frame requires 32-byte SHA-256, got {} bytes",
                    frame.data.len()
                ));
            }
            if frame.offset != sess.total_size || sess.received_bytes != sess.total_size {
                return Err(format!(
                    "file size mismatch on FINISH: received={}, finish_offset={}, expected={}",
                    sess.received_bytes, frame.offset, sess.total_size
                ));
            }
            let actual: [u8; 32] = sess.hasher.finalize().into();
            if actual.as_slice() != frame.data.as_slice() {
                return Err(format!(
                    "SHA-256 mismatch: expected {}, got {}",
                    hex::encode(&frame.data),
                    hex::encode(actual)
                ));
            }
            if let Some(expected_open) = sess.expected_sha256 {
                if actual != expected_open {
                    return Err(format!(
                        "SHA-256 mismatch vs open expectation: expected {}, got {}",
                        hex::encode(expected_open),
                        hex::encode(actual)
                    ));
                }
            }
            sess.file
                .flush()
                .await
                .map_err(|e| format!("staging flush error: {e}"))?;
            let _ = sess.file.sync_all().await;
            drop(sess.file);

            replace_file_atomic(&sess.staging_path, &sess.target_path, sess.overwrite).await?;
            Ok(actual)
        }
        .await;

        match finalize_res {
            Ok(digest) => {
                {
                    let mut completed = self.completed.lock().await;
                    completed.insert(
                        frame.transfer_id.clone(),
                        CompletedRecord {
                            peer_id: peer_id.to_string(),
                            size: sess.total_size,
                            sha256: digest,
                            completed_at: Instant::now(),
                        },
                    );
                }
                let _ = self
                    .outbound_tx
                    .send(OutboundFileFrame {
                        dst: peer_id.to_string(),
                        frame: FileFrame {
                            kind: FileFrameKind::Done,
                            flags: 0,
                            seq: frame.seq,
                            offset: sess.total_size,
                            window: 0,
                            transfer_id: frame.transfer_id,
                            data: digest.to_vec(),
                        },
                    })
                    .await;
            }
            Err(err) => {
                let _ = tokio::fs::remove_file(&sess.staging_path).await;
                self.send_abort(peer_id, &frame.transfer_id, &err).await;
            }
        }
    }

    async fn send_abort(&self, peer_id: &str, transfer_id: &str, reason: &str) {
        let _ = self
            .outbound_tx
            .send(OutboundFileFrame {
                dst: peer_id.to_string(),
                frame: FileFrame {
                    kind: FileFrameKind::Abort,
                    flags: 0,
                    seq: 0,
                    offset: 0,
                    window: 0,
                    transfer_id: transfer_id.to_string(),
                    data: reason.as_bytes().to_vec(),
                },
            })
            .await;
    }
}

pub struct PullStreamTask {
    manager: Arc<FileTransferManager>,
    peer_id: String,
    transfer_id: String,
    file: tokio::fs::File,
    total_size: u64,
    start_offset: u64,
    chunk_size: usize,
    initial_window: u32,
    sig_rx: mpsc::Receiver<PullSignal>,
}

impl PullStreamTask {
    pub async fn run(mut self) {
        let res = self.run_inner().await;
        if let Err(err) = res {
            self.manager
                .send_abort(&self.peer_id, &self.transfer_id, &err)
                .await;
        }
        self.manager.pulls.lock().await.remove(&self.transfer_id);
    }

    async fn run_inner(&mut self) -> Result<(), String> {
        let mut hasher = Sha256::new();
        let mut hashed_offset: u64 = 0;

        // If resuming from start_offset > 0, hash the prefix [0..start_offset) so FINISH carries full-file SHA-256.
        if self.start_offset > 0 {
            let mut buf = vec![0u8; 64 * 1024];
            let mut rem = self.start_offset;
            while rem > 0 {
                let want = (rem as usize).min(buf.len());
                let n = self
                    .file
                    .read(&mut buf[..want])
                    .await
                    .map_err(|e| format!("failed hashing pull prefix: {e}"))?;
                if n == 0 {
                    return Err("unexpected EOF while hashing pull prefix".to_string());
                }
                hasher.update(&buf[..n]);
                hashed_offset += n as u64;
                rem -= n as u64;
            }
        }

        let mut send_offset = self.start_offset;
        let mut acked_offset = self.start_offset;
        let mut peer_window = self.initial_window as u64;
        let mut effective_window = peer_window.max(self.chunk_size as u64);
        let mut pacing_delay_ms: u64 = 0;
        let mut seq: u32 = 0;
        let mut stall_retries: usize = 0;
        let mut buf = vec![0u8; self.chunk_size];

        while acked_offset < self.total_size {
            // Drain any pending signals without blocking before sending.
            while let Ok(sig) = self.sig_rx.try_recv() {
                match sig {
                    PullSignal::Ack { offset, window } => {
                        if window > 0 {
                            peer_window = (window as u64).max(self.chunk_size as u64);
                        }
                        if offset > acked_offset {
                            acked_offset = offset.min(self.total_size);
                            stall_retries = 0;
                            pacing_delay_ms = pacing_delay_ms / 2;
                            effective_window = (effective_window + self.chunk_size as u64).min(peer_window);
                        } else if offset < send_offset {
                            // Receiver reported gap (e.g. relay dropped a chunk); rewind cleanly.
                            send_offset = offset;
                            effective_window = self.chunk_size as u64;
                        }
                    }
                    PullSignal::Done { .. } => {
                        return Ok(());
                    }
                    PullSignal::Abort { reason } => {
                        return Err(format!("aborted by receiver: {reason}"));
                    }
                    PullSignal::RateLimited => {
                        pacing_delay_ms = if pacing_delay_ms == 0 {
                            200
                        } else {
                            (pacing_delay_ms * 2).min(2000)
                        };
                        effective_window = self.chunk_size as u64;
                    }
                }
            }

            if acked_offset >= self.total_size {
                break;
            }

            // Send chunks while window permits and bytes remain.
            let in_flight = send_offset.saturating_sub(acked_offset);
            if send_offset < self.total_size && in_flight < effective_window {
                if pacing_delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(pacing_delay_ms)).await;
                }
                self.file
                    .seek(std::io::SeekFrom::Start(send_offset))
                    .await
                    .map_err(|e| format!("pull seek error: {e}"))?;
                let remaining = (self.total_size - send_offset) as usize;
                let want = remaining.min(self.chunk_size);
                let mut read_total = 0usize;
                while read_total < want {
                    let n = self
                        .file
                        .read(&mut buf[read_total..want])
                        .await
                        .map_err(|e| format!("pull read error: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    read_total += n;
                }
                if read_total == 0 {
                    return Err("unexpected EOF while reading pull file".to_string());
                }

                let chunk_start = send_offset;
                let chunk_end = chunk_start + read_total as u64;
                if chunk_end > hashed_offset {
                    let fresh_start = hashed_offset.saturating_sub(chunk_start) as usize;
                    if fresh_start < read_total {
                        hasher.update(&buf[fresh_start..read_total]);
                    }
                    hashed_offset = chunk_end;
                }

                let frame = FileFrame {
                    kind: FileFrameKind::Data,
                    flags: 0,
                    seq,
                    offset: chunk_start,
                    window: 0,
                    transfer_id: self.transfer_id.clone(),
                    data: buf[..read_total].to_vec(),
                };
                seq = seq.wrapping_add(1);
                send_offset = chunk_end;

                self.manager
                    .outbound_tx
                    .send(OutboundFileFrame {
                        dst: self.peer_id.clone(),
                        frame,
                    })
                    .await
                    .map_err(|_| "outbound relay channel closed".to_string())?;
                continue;
            }

            // Window full or all data sent; wait for ACK / ABORT / RateLimited or stall timeout.
            match tokio::time::timeout(PULL_STALL_TIMEOUT, self.sig_rx.recv()).await {
                Ok(Some(PullSignal::Ack { offset, window })) => {
                    if window > 0 {
                        peer_window = (window as u64).max(self.chunk_size as u64);
                    }
                    if offset > acked_offset {
                        acked_offset = offset.min(self.total_size);
                        stall_retries = 0;
                        pacing_delay_ms = pacing_delay_ms / 2;
                        effective_window = (effective_window + self.chunk_size as u64).min(peer_window);
                    } else if offset < send_offset {
                        send_offset = offset;
                        effective_window = self.chunk_size as u64;
                    }
                }
                Ok(Some(PullSignal::Done { .. })) => return Ok(()),
                Ok(Some(PullSignal::Abort { reason })) => {
                    return Err(format!("aborted by receiver: {reason}"));
                }
                Ok(Some(PullSignal::RateLimited)) => {
                    pacing_delay_ms = if pacing_delay_ms == 0 {
                        200
                    } else {
                        (pacing_delay_ms * 2).min(2000)
                    };
                    effective_window = self.chunk_size as u64;
                    send_offset = acked_offset;
                }
                Ok(None) => return Err("pull signal channel closed".to_string()),
                Err(_) => {
                    stall_retries += 1;
                    if stall_retries > PULL_MAX_STALL_RETRIES {
                        return Err("pull transfer timed out waiting for receiver ACK".to_string());
                    }
                    // Rewind to acked_offset and retransmit with reduced window.
                    send_offset = acked_offset;
                    effective_window = self.chunk_size as u64;
                }
            }
        }

        let digest: [u8; 32] = hasher.finalize().into();

        // Send FINISH and await DONE with bounded retries.
        for attempt in 0..=PULL_MAX_FINISH_RETRIES {
            let finish = FileFrame {
                kind: FileFrameKind::Finish,
                flags: 0,
                seq,
                offset: self.total_size,
                window: 0,
                transfer_id: self.transfer_id.clone(),
                data: digest.to_vec(),
            };
            self.manager
                .outbound_tx
                .send(OutboundFileFrame {
                    dst: self.peer_id.clone(),
                    frame: finish,
                })
                .await
                .map_err(|_| "outbound relay channel closed".to_string())?;

            let deadline = tokio::time::Instant::now() + PULL_DONE_TIMEOUT;
            loop {
                match tokio::time::timeout_at(deadline, self.sig_rx.recv()).await {
                    Ok(Some(PullSignal::Done { offset, sha256 })) => {
                        if offset != self.total_size || sha256.as_slice() != digest.as_slice() {
                            return Err("receiver DONE digest/size mismatch".to_string());
                        }
                        return Ok(());
                    }
                    Ok(Some(PullSignal::Abort { reason })) => {
                        return Err(format!("aborted by receiver: {reason}"));
                    }
                    Ok(Some(PullSignal::Ack { .. })) | Ok(Some(PullSignal::RateLimited)) => {
                        continue;
                    }
                    Ok(None) => return Err("pull signal channel closed waiting for DONE".to_string()),
                    Err(_) => break,
                }
            }
            if attempt == PULL_MAX_FINISH_RETRIES {
                return Err("pull transfer timed out waiting for receiver DONE".to_string());
            }
        }
        Ok(())
    }
}

pub async fn replace_file_atomic(staging: &Path, target: &Path, overwrite: bool) -> Result<(), String> {
    if !overwrite && tokio::fs::symlink_metadata(target).await.is_ok() {
        return Err(format!(
            "destination already exists and overwrite is false: {}",
            target.display()
        ));
    }
    match tokio::fs::rename(staging, target).await {
        Ok(()) => Ok(()),
        Err(first_err) => {
            #[cfg(windows)]
            {
                if overwrite && tokio::fs::symlink_metadata(target).await.is_ok() {
                    let _ = tokio::fs::remove_file(target).await;
                    return tokio::fs::rename(staging, target)
                        .await
                        .map_err(|e| format!("failed to finalize file rename: {e}"));
                }
            }
            Err(format!("failed to finalize file rename: {first_err}"))
        }
    }
}

pub fn system_time_to_ms(t: Option<SystemTime>) -> Option<u64> {
    t.and_then(|st| st.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_ws(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "neo_ft_test_{}_{}_{}",
            name,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_policy(ws: &Path) -> Arc<Policy> {
        let escaped = ws.display().to_string().replace('\\', "\\\\");
        Arc::new(Policy::from_toml_str(&format!("allowed_workspaces = [\"{escaped}\"]\n")).unwrap())
    }

    #[tokio::test]
    async fn pull_streams_binary_chunks_with_ack_and_sha256_finish() {
        let ws = make_temp_ws("pull");
        let policy = make_policy(&ws);
        let src_path = ws.join("manual.bin");
        let payload: Vec<u8> = (0..(100 * 1024)).map(|i| ((i * 31 + 7) & 0xFF) as u8).collect();
        std::fs::write(&src_path, &payload).unwrap();
        let expected_sha: [u8; 32] = Sha256::digest(&payload).into();

        let (tx, mut rx) = mpsc::channel::<OutboundFileFrame>(64);
        let mgr = FileTransferManager::new(policy, tx);

        let (meta, task) = mgr
            .open_pull(
                "master-1",
                &json!({
                    "transfer_id": "ft_pull_1",
                    "path": src_path.to_string_lossy(),
                    "chunk_size": 16384,
                    "window_bytes": 32768
                }),
            )
            .await
            .unwrap();
        assert_eq!(meta["size"], payload.len());
        assert_eq!(meta["protocol"], "binary_e2e_v1");

        let handle = tokio::spawn(task.run());

        let mut received = Vec::new();
        let mut finish_sha = Vec::new();
        while let Some(out) = rx.recv().await {
            assert_eq!(out.dst, "master-1");
            match out.frame.kind {
                FileFrameKind::Data => {
                    assert_eq!(out.frame.offset, received.len() as u64);
                    received.extend_from_slice(&out.frame.data);
                    mgr.handle_incoming_frame(
                        "master-1",
                        FileFrame {
                            kind: FileFrameKind::Ack,
                            flags: 0,
                            seq: out.frame.seq,
                            offset: received.len() as u64,
                            window: 32768,
                            transfer_id: "ft_pull_1".to_string(),
                            data: Vec::new(),
                        },
                    )
                    .await;
                }
                FileFrameKind::Finish => {
                    finish_sha = out.frame.data.clone();
                    assert_eq!(out.frame.offset, payload.len() as u64);
                    mgr.handle_incoming_frame(
                        "master-1",
                        FileFrame {
                            kind: FileFrameKind::Done,
                            flags: 0,
                            seq: out.frame.seq,
                            offset: payload.len() as u64,
                            window: 0,
                            transfer_id: "ft_pull_1".to_string(),
                            data: finish_sha.clone(),
                        },
                    )
                    .await;
                    break;
                }
                other => panic!("unexpected outbound frame kind: {other:?}"),
            }
        }
        handle.await.unwrap();
        assert_eq!(received, payload);
        assert_eq!(finish_sha.as_slice(), expected_sha.as_slice());

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn push_receives_chunks_verifies_sha256_supports_resume_and_rejects_escape() {
        let ws = make_temp_ws("push");
        let policy = make_policy(&ws);
        let (tx, mut rx) = mpsc::channel::<OutboundFileFrame>(64);
        let mgr = FileTransferManager::new(policy, tx);

        // Sandbox escape must be rejected
        assert!(mgr
            .open_push(
                "master-1",
                &json!({ "transfer_id": "ft_esc", "path": "/etc/evil", "size": 10 })
            )
            .await
            .is_err());

        // Pre-populate partial staging file to test resume
        let target = ws.join("nested/payload.bin");
        let part1 = b"part-one-bytes-";
        let part2 = b"part-two-bytes!";
        let mut full = Vec::new();
        full.extend_from_slice(part1);
        full.extend_from_slice(part2);
        let full_sha: [u8; 32] = Sha256::digest(&full).into();

        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target.parent().unwrap().join(".neo-part-ft_push_1"), part1).unwrap();

        let open = mgr
            .open_push(
                "master-1",
                &json!({
                    "transfer_id": "ft_push_1",
                    "path": target.to_string_lossy(),
                    "size": full.len(),
                    "resume": true,
                    "overwrite": true
                }),
            )
            .await
            .unwrap();
        assert_eq!(open["resume_offset"], part1.len());

        // Spoofed peer DATA must be ignored
        mgr.handle_incoming_frame(
            "evil-peer",
            FileFrame {
                kind: FileFrameKind::Data,
                flags: 0,
                seq: 0,
                offset: part1.len() as u64,
                window: 0,
                transfer_id: "ft_push_1".to_string(),
                data: b"CORRUPTXXXXXXXX".to_vec(),
            },
        )
        .await;
        assert!(rx.try_recv().is_err());

        // Valid peer sends part2 + FINISH
        mgr.handle_incoming_frame(
            "master-1",
            FileFrame {
                kind: FileFrameKind::Data,
                flags: 0,
                seq: 0,
                offset: part1.len() as u64,
                window: 0,
                transfer_id: "ft_push_1".to_string(),
                data: part2.to_vec(),
            },
        )
        .await;
        let ack = rx.recv().await.unwrap();
        assert_eq!(ack.frame.kind, FileFrameKind::Ack);
        assert_eq!(ack.frame.offset, full.len() as u64);

        mgr.handle_incoming_frame(
            "master-1",
            FileFrame {
                kind: FileFrameKind::Finish,
                flags: 0,
                seq: 1,
                offset: full.len() as u64,
                window: 0,
                transfer_id: "ft_push_1".to_string(),
                data: full_sha.to_vec(),
            },
        )
        .await;
        let done = rx.recv().await.unwrap();
        assert_eq!(done.frame.kind, FileFrameKind::Done);
        assert_eq!(done.frame.offset, full.len() as u64);
        assert_eq!(done.frame.data.as_slice(), full_sha.as_slice());
        assert_eq!(std::fs::read(&target).unwrap(), full);

        // Idempotent duplicate FINISH gets DONE again
        mgr.handle_incoming_frame(
            "master-1",
            FileFrame {
                kind: FileFrameKind::Finish,
                flags: 0,
                seq: 1,
                offset: full.len() as u64,
                window: 0,
                transfer_id: "ft_push_1".to_string(),
                data: full_sha.to_vec(),
            },
        )
        .await;
        let done2 = rx.recv().await.unwrap();
        assert_eq!(done2.frame.kind, FileFrameKind::Done);

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn push_aborts_and_cleans_staging_on_sha256_mismatch() {
        let ws = make_temp_ws("badsha");
        let policy = make_policy(&ws);
        let (tx, mut rx) = mpsc::channel::<OutboundFileFrame>(16);
        let mgr = FileTransferManager::new(policy, tx);
        let target = ws.join("bad.bin");

        mgr.open_push(
            "master-1",
            &json!({ "transfer_id": "ft_bad", "path": target.to_string_lossy(), "size": 5 }),
        )
        .await
        .unwrap();

        mgr.handle_incoming_frame(
            "master-1",
            FileFrame {
                kind: FileFrameKind::Data,
                flags: 0,
                seq: 0,
                offset: 0,
                window: 0,
                transfer_id: "ft_bad".to_string(),
                data: b"hello".to_vec(),
            },
        )
        .await;
        let _ack = rx.recv().await.unwrap();

        mgr.handle_incoming_frame(
            "master-1",
            FileFrame {
                kind: FileFrameKind::Finish,
                flags: 0,
                seq: 1,
                offset: 5,
                window: 0,
                transfer_id: "ft_bad".to_string(),
                data: vec![0xAA; 32], // wrong SHA-256
            },
        )
        .await;
        let abort = rx.recv().await.unwrap();
        assert_eq!(abort.frame.kind, FileFrameKind::Abort);
        assert!(!target.exists());
        assert!(!ws.join(".neo-part-ft_bad").exists());

        let _ = std::fs::remove_dir_all(&ws);
    }
}
