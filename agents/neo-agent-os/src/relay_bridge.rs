use crate::protocol::RelayEnvelope;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex, RwLock};

pub const UART_MAX_COBS_FRAME_LEN: usize = 4096;
pub const UART_SYNC_0: u8 = 0xA5;
pub const UART_SYNC_1: u8 = 0x01;

/// Standard CRC16-CCITT-FALSE (poly=0x1021, init=0xFFFF, refin=false, refout=false, xorout=0x0000).
pub fn crc16_ccitt(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            if (crc & 0x8000) != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

pub fn cobs_encode(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() + input.len() / 254 + 2);
    out.push(0);
    let mut code_idx = 0usize;
    let mut code: u8 = 1;

    for &b in input {
        if b == 0 {
            out[code_idx] = code;
            code_idx = out.len();
            out.push(0);
            code = 1;
        } else {
            out.push(b);
            code += 1;
            if code == 0xFF {
                out[code_idx] = code;
                code_idx = out.len();
                out.push(0);
                code = 1;
            }
        }
    }
    out[code_idx] = code;
    out
}

pub fn cobs_decode(input: &[u8]) -> Result<Vec<u8>, String> {
    if input.is_empty() {
        return Err("empty COBS frame".to_string());
    }
    let mut out = Vec::with_capacity(input.len());
    let mut idx = 0usize;
    while idx < input.len() {
        let code = input[idx] as usize;
        if code == 0 {
            return Err("unexpected zero byte in COBS payload".to_string());
        }
        idx += 1;
        let end = idx + code - 1;
        if end > input.len() {
            return Err("truncated COBS block".to_string());
        }
        for &b in &input[idx..end] {
            if b == 0 {
                return Err("unexpected zero byte inside COBS block".to_string());
            }
            out.push(b);
        }
        idx = end;
        if code < 0xFF && idx < input.len() {
            out.push(0);
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UartMcuFrame {
    pub mcu_id: String,
    pub seq_id: u64,
    pub e2e_mac: [u8; 32],
    pub cbor_bytes: Vec<u8>,
}

impl UartMcuFrame {
    /// Pre-COBS: `[0xA5, 0x01, mcu_id_len(u8), mcu_id, seq_id(8B BE), e2e_mac(32B), cbor_len(u16 BE), cbor_bytes, crc16_ccitt(u16 BE)]`
    /// COBS-encoded + `0x00` delimiter, asserted `<= 4096` bytes.
    pub fn encode_cobs(&self) -> Result<Vec<u8>, String> {
        let id_bytes = self.mcu_id.as_bytes();
        if id_bytes.is_empty() || id_bytes.len() > u8::MAX as usize {
            return Err("invalid mcu_id length for UART frame".to_string());
        }
        if self.cbor_bytes.len() > u16::MAX as usize {
            return Err("CBOR payload too large for UART frame".to_string());
        }
        let mut raw = Vec::with_capacity(3 + id_bytes.len() + 8 + 32 + 2 + self.cbor_bytes.len() + 2);
        raw.push(UART_SYNC_0);
        raw.push(UART_SYNC_1);
        raw.push(id_bytes.len() as u8);
        raw.extend_from_slice(id_bytes);
        raw.extend_from_slice(&self.seq_id.to_be_bytes());
        raw.extend_from_slice(&self.e2e_mac);
        raw.extend_from_slice(&(self.cbor_bytes.len() as u16).to_be_bytes());
        raw.extend_from_slice(&self.cbor_bytes);
        let crc = crc16_ccitt(&raw);
        raw.extend_from_slice(&crc.to_be_bytes());

        let mut encoded = cobs_encode(&raw);
        encoded.push(0x00);
        if encoded.len() > UART_MAX_COBS_FRAME_LEN {
            return Err(format!(
                "COBS UART frame exceeds {UART_MAX_COBS_FRAME_LEN} bytes: {}",
                encoded.len()
            ));
        }
        Ok(encoded)
    }

    pub fn decode_cobs(frame_bytes: &[u8]) -> Result<Self, String> {
        if frame_bytes.len() > UART_MAX_COBS_FRAME_LEN {
            return Err("COBS UART frame exceeds 4096 byte limit".to_string());
        }
        let trimmed = frame_bytes.strip_suffix(&[0x00]).unwrap_or(frame_bytes);
        let raw = cobs_decode(trimmed)?;
        if raw.len() < 3 + 8 + 32 + 2 + 2 {
            return Err("UART frame too short".to_string());
        }
        if raw[0] != UART_SYNC_0 || raw[1] != UART_SYNC_1 {
            return Err("invalid UART frame sync header".to_string());
        }
        let id_len = raw[2] as usize;
        if id_len == 0 || raw.len() < 3 + id_len + 8 + 32 + 2 + 2 {
            return Err("invalid mcu_id_len in UART frame".to_string());
        }
        let id_end = 3 + id_len;
        let mcu_id = std::str::from_utf8(&raw[3..id_end])
            .map_err(|e| format!("invalid mcu_id UTF-8: {e}"))?
            .to_string();

        let seq_off = id_end;
        let mac_off = seq_off + 8;
        let cbor_len_off = mac_off + 32;
        let cbor_off = cbor_len_off + 2;

        let seq_id = u64::from_be_bytes(raw[seq_off..mac_off].try_into().unwrap());
        let e2e_mac: [u8; 32] = raw[mac_off..cbor_len_off].try_into().unwrap();
        let cbor_len = u16::from_be_bytes([raw[cbor_len_off], raw[cbor_len_off + 1]]) as usize;

        if raw.len() != cbor_off + cbor_len + 2 {
            return Err("UART frame cbor_len mismatch".to_string());
        }
        let cbor_bytes = raw[cbor_off..cbor_off + cbor_len].to_vec();
        let expected_crc = u16::from_be_bytes([raw[raw.len() - 2], raw[raw.len() - 1]]);
        let actual_crc = crc16_ccitt(&raw[..raw.len() - 2]);
        if actual_crc != expected_crc {
            return Err(format!(
                "UART CRC16 mismatch: expected 0x{expected_crc:04x}, got 0x{actual_crc:04x}"
            ));
        }

        Ok(Self {
            mcu_id,
            seq_id,
            e2e_mac,
            cbor_bytes,
        })
    }
}

#[derive(Debug, Clone)]
struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

/// Per-MCU token-bucket rate limiter so a noisy MCU cannot flood the relay.
pub struct McuRateLimiter {
    capacity: f64,
    refill_per_sec: f64,
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl McuRateLimiter {
    pub fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self {
            capacity,
            refill_per_sec,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub async fn allow(&self, mcu_id: &str) -> bool {
        let mut guard = self.buckets.lock().await;
        let now = Instant::now();
        let b = guard.entry(mcu_id.to_string()).or_insert_with(|| Bucket {
            tokens: self.capacity,
            last_refill: now,
        });
        let elapsed = now.duration_since(b.last_refill).as_secs_f64();
        b.tokens = (b.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        b.last_refill = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
struct SubscriberEntry {
    filters: Vec<String>,
    tx: mpsc::Sender<Vec<u8>>,
}

pub struct RelayBridge {
    cluster_id: String,
    relay_node_id: String,
    ota_cache_dir: Option<PathBuf>,
    limiter: McuRateLimiter,
    subscribers: Arc<RwLock<HashMap<u64, SubscriberEntry>>>,
    uplink_tx: mpsc::Sender<RelayEnvelope>,
    uart_tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
}

impl RelayBridge {
    pub fn new(
        cluster_id: String,
        relay_node_id: String,
        ota_cache_dir: Option<PathBuf>,
        uplink_tx: mpsc::Sender<RelayEnvelope>,
    ) -> Arc<Self> {
        Arc::new(Self {
            cluster_id,
            relay_node_id,
            ota_cache_dir,
            limiter: McuRateLimiter::new(20.0, 10.0),
            subscribers: Arc::new(RwLock::new(HashMap::new())),
            uplink_tx,
            uart_tx: Mutex::new(None),
        })
    }

    pub async fn start_mqtt_broker(
        self: &Arc<Self>,
        bind_addr: &str,
    ) -> Result<std::net::SocketAddr, String> {
        let listener = TcpListener::bind(bind_addr)
            .await
            .map_err(|e| format!("failed to bind MQTT broker on {bind_addr}: {e}"))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| format!("MQTT local_addr failed: {e}"))?;
        let bridge = Arc::clone(self);

        tokio::spawn(async move {
            let mut next_client_id: u64 = 1;
            loop {
                match listener.accept().await {
                    Ok((stream, _peer)) => {
                        let cid = next_client_id;
                        next_client_id += 1;
                        let b = Arc::clone(&bridge);
                        tokio::spawn(async move {
                            let _ = handle_mqtt_client(b, cid, stream).await;
                        });
                    }
                    Err(e) => {
                        eprintln!("[relay_bridge] MQTT accept error: {e}");
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                }
            }
        });

        Ok(local_addr)
    }

    pub async fn start_uart_bridge(self: &Arc<Self>, uart_path: &Path) -> Result<(), String> {
        let file = tokio::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(uart_path)
            .await
            .map_err(|e| format!("failed to open UART device {}: {e}", uart_path.display()))?;
        let (mut rd, mut wr) = tokio::io::split(file);
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
        *self.uart_tx.lock().await = Some(tx);
        let bridge = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                if wr.write_all(&frame).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            let mut buf = Vec::with_capacity(UART_MAX_COBS_FRAME_LEN);
            let mut byte = [0u8; 1];
            loop {
                match rd.read_exact(&mut byte).await {
                    Ok(_) => {
                        if byte[0] == 0x00 {
                            if !buf.is_empty() {
                                if let Ok(frame) = UartMcuFrame::decode_cobs(&buf) {
                                    let _ = bridge
                                        .forward_uplink_raw(
                                            &frame.mcu_id,
                                            frame.seq_id,
                                            &frame.e2e_mac,
                                            &frame.cbor_bytes,
                                        )
                                        .await;
                                }
                                buf.clear();
                            }
                        } else if buf.len() < UART_MAX_COBS_FRAME_LEN {
                            buf.push(byte[0]);
                        } else {
                            buf.clear();
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(())
    }

    pub async fn forward_uplink_raw(
        &self,
        mcu_id: &str,
        seq_id: u64,
        e2e_mac: &[u8; 32],
        cbor_bytes: &[u8],
    ) -> Result<(), String> {
        if !self.limiter.allow(mcu_id).await {
            return Err(format!("rate limited uplink from MCU '{mcu_id}'"));
        }
        let env = RelayEnvelope {
            cluster_id: self.cluster_id.clone(),
            relay_node_id: self.relay_node_id.clone(),
            target_mcu_id: mcu_id.to_string(),
            direction: "uplink".to_string(),
            seq_id,
            e2e_mac: hex::encode(e2e_mac),
            cbor_payload_b64: STANDARD.encode(cbor_bytes),
        };
        self.uplink_tx
            .send(env)
            .await
            .map_err(|_| "uplink channel closed".to_string())
    }

    /// Forwards a downlink `RelayEnvelope` from Master to the target MCU over LAN MQTT (and UART if active).
    /// Never inspects or modifies `e2e_mac` or `cbor_payload_b64` (never holds MCU E2E key).
    pub async fn publish_downlink(&self, env: &RelayEnvelope) -> Result<usize, String> {
        if env.cluster_id != self.cluster_id {
            return Err(format!(
                "cross-cluster RelayEnvelope rejected: got '{}', expected '{}'",
                env.cluster_id, self.cluster_id
            ));
        }
        if env.direction != "downlink" {
            return Err(format!("unexpected RelayEnvelope direction: {}", env.direction));
        }
        let mac_vec = hex::decode(&env.e2e_mac)
            .map_err(|e| format!("invalid e2e_mac hex: {e}"))?;
        let mac_bytes: [u8; 32] = mac_vec
            .try_into()
            .map_err(|_| "e2e_mac must be 32 bytes (64 hex chars)".to_string())?;
        let cbor_bytes = STANDARD
            .decode(&env.cbor_payload_b64)
            .map_err(|e| format!("invalid cbor_payload_b64: {e}"))?;

        let mut payload = Vec::with_capacity(8 + 32 + cbor_bytes.len());
        payload.extend_from_slice(&env.seq_id.to_be_bytes());
        payload.extend_from_slice(&mac_bytes);
        payload.extend_from_slice(&cbor_bytes);

        let topic = format!("neo/{}/mcu/{}/down", self.cluster_id, env.target_mcu_id);
        let packet = encode_mqtt_publish(&topic, &payload);

        if let Some(uart_tx) = self.uart_tx.lock().await.clone() {
            let uframe = UartMcuFrame {
                mcu_id: env.target_mcu_id.clone(),
                seq_id: env.seq_id,
                e2e_mac: mac_bytes,
                cbor_bytes,
            };
            if let Ok(encoded) = uframe.encode_cobs() {
                let _ = uart_tx.send(encoded).await;
            }
        }

        let subs = self.subscribers.read().await;
        let mut delivered = 0usize;
        for entry in subs.values() {
            if entry.filters.iter().any(|f| mqtt_topic_matches(f, &topic)) {
                if entry.tx.send(packet.clone()).await.is_ok() {
                    delivered += 1;
                }
            }
        }
        Ok(delivered)
    }

    pub async fn cache_ota_artifact(
        &self,
        mcu_id: &str,
        version: &str,
        bytes: &[u8],
    ) -> Result<PathBuf, String> {
        let base = self
            .ota_cache_dir
            .as_ref()
            .ok_or("ota_cache_dir not configured")?;
        validate_safe_segment(mcu_id)?;
        validate_safe_segment(version)?;
        let dir = base.join(mcu_id);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| format!("failed to create OTA cache dir: {e}"))?;
        let file_path = dir.join(format!("{version}.bin"));
        tokio::fs::write(&file_path, bytes)
            .await
            .map_err(|e| format!("failed to write cached MCU OTA: {e}"))?;
        Ok(file_path)
    }

    pub async fn read_ota_artifact(&self, mcu_id: &str, version: &str) -> Result<Vec<u8>, String> {
        let base = self
            .ota_cache_dir
            .as_ref()
            .ok_or("ota_cache_dir not configured")?;
        validate_safe_segment(mcu_id)?;
        validate_safe_segment(version)?;
        let file_path = base.join(mcu_id).join(format!("{version}.bin"));
        tokio::fs::read(&file_path)
            .await
            .map_err(|e| format!("failed to read cached MCU OTA: {e}"))
    }
}

fn validate_safe_segment(seg: &str) -> Result<(), String> {
    if seg.is_empty()
        || !seg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        || seg.contains("..")
    {
        return Err(format!("unsafe OTA cache path segment: {seg}"));
    }
    Ok(())
}

async fn handle_mqtt_client(
    bridge: Arc<RelayBridge>,
    conn_id: u64,
    stream: TcpStream,
) -> Result<(), String> {
    let (mut rd, mut wr) = stream.into_split();
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);

    let writer_handle = tokio::spawn(async move {
        while let Some(pkt) = rx.recv().await {
            if wr.write_all(&pkt).await.is_err() {
                break;
            }
        }
    });

    let res = mqtt_read_loop(&bridge, conn_id, &mut rd, &tx).await;
    bridge.subscribers.write().await.remove(&conn_id);
    drop(tx);
    let _ = writer_handle.await;
    res
}

async fn mqtt_read_loop(
    bridge: &Arc<RelayBridge>,
    conn_id: u64,
    rd: &mut tokio::net::tcp::OwnedReadHalf,
    tx: &mpsc::Sender<Vec<u8>>,
) -> Result<(), String> {
    loop {
        let (pkt_type, flags, body) = match read_mqtt_packet(rd).await? {
            Some(p) => p,
            None => return Ok(()),
        };
        match pkt_type {
            1 => {
                // CONNECT -> CONNACK (accepted)
                let connack = vec![0x20, 0x02, 0x00, 0x00];
                let _ = tx.send(connack).await;
            }
            3 => {
                // PUBLISH
                let qos = (flags >> 1) & 0x03;
                if body.len() < 2 {
                    return Err("truncated MQTT PUBLISH".to_string());
                }
                let topic_len = u16::from_be_bytes([body[0], body[1]]) as usize;
                if body.len() < 2 + topic_len {
                    return Err("truncated MQTT PUBLISH topic".to_string());
                }
                let topic = std::str::from_utf8(&body[2..2 + topic_len])
                    .map_err(|e| format!("invalid MQTT topic UTF-8: {e}"))?;
                let mut off = 2 + topic_len;
                if qos > 0 {
                    if body.len() < off + 2 {
                        return Err("missing MQTT PUBLISH packet_id".to_string());
                    }
                    let pid_hi = body[off];
                    let pid_lo = body[off + 1];
                    off += 2;
                    if qos == 1 {
                        let _ = tx.send(vec![0x40, 0x02, pid_hi, pid_lo]).await;
                    }
                }
                let payload = &body[off..];
                if let Some((topic_cluster, mcu_id)) = parse_mcu_uplink_topic(topic) {
                    if topic_cluster == bridge.cluster_id && payload.len() >= 40 {
                        let seq_id = u64::from_be_bytes(payload[0..8].try_into().unwrap());
                        let mac: [u8; 32] = payload[8..40].try_into().unwrap();
                        let cbor = &payload[40..];
                        let _ = bridge
                            .forward_uplink_raw(mcu_id, seq_id, &mac, cbor)
                            .await;
                    }
                }
            }
            8 => {
                // SUBSCRIBE
                if body.len() < 2 {
                    return Err("truncated MQTT SUBSCRIBE".to_string());
                }
                let pid_hi = body[0];
                let pid_lo = body[1];
                let mut off = 2usize;
                let mut filters = Vec::new();
                let mut granted = Vec::new();
                while off + 2 <= body.len() {
                    let flen = u16::from_be_bytes([body[off], body[off + 1]]) as usize;
                    off += 2;
                    if off + flen + 1 > body.len() {
                        return Err("truncated MQTT SUBSCRIBE filter".to_string());
                    }
                    let filter = std::str::from_utf8(&body[off..off + flen])
                        .map_err(|e| format!("invalid MQTT filter UTF-8: {e}"))?
                        .to_string();
                    off += flen;
                    let req_qos = body[off];
                    off += 1;
                    filters.push(filter);
                    granted.push(req_qos.min(0)); // grant QoS 0
                }

                {
                    let mut subs = bridge.subscribers.write().await;
                    let entry = subs.entry(conn_id).or_insert_with(|| SubscriberEntry {
                        filters: Vec::new(),
                        tx: tx.clone(),
                    });
                    for f in filters {
                        if !entry.filters.contains(&f) {
                            entry.filters.push(f);
                        }
                    }
                }

                let mut suback = Vec::with_capacity(4 + granted.len());
                suback.push(0x90);
                encode_remaining_len(2 + granted.len(), &mut suback);
                suback.push(pid_hi);
                suback.push(pid_lo);
                suback.extend_from_slice(&granted);
                let _ = tx.send(suback).await;
            }
            10 => {
                // UNSUBSCRIBE
                if body.len() < 2 {
                    return Err("truncated MQTT UNSUBSCRIBE".to_string());
                }
                let pid_hi = body[0];
                let pid_lo = body[1];
                let mut off = 2usize;
                let mut remove_list = Vec::new();
                while off + 2 <= body.len() {
                    let flen = u16::from_be_bytes([body[off], body[off + 1]]) as usize;
                    off += 2;
                    if off + flen > body.len() {
                        break;
                    }
                    if let Ok(f) = std::str::from_utf8(&body[off..off + flen]) {
                        remove_list.push(f.to_string());
                    }
                    off += flen;
                }
                if let Some(entry) = bridge.subscribers.write().await.get_mut(&conn_id) {
                    entry.filters.retain(|f| !remove_list.contains(f));
                }
                let _ = tx.send(vec![0xB0, 0x02, pid_hi, pid_lo]).await;
            }
            12 => {
                // PINGREQ -> PINGRESP
                let _ = tx.send(vec![0xD0, 0x00]).await;
            }
            14 => {
                // DISCONNECT
                return Ok(());
            }
            _ => {}
        }
    }
}

async fn read_mqtt_packet(
    rd: &mut tokio::net::tcp::OwnedReadHalf,
) -> Result<Option<(u8, u8, Vec<u8>)>, String> {
    let mut header = [0u8; 1];
    match rd.read_exact(&mut header).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(format!("MQTT read error: {e}")),
    }
    let pkt_type = header[0] >> 4;
    let flags = header[0] & 0x0F;

    let mut multiplier: usize = 1;
    let mut rem_len: usize = 0;
    for _ in 0..4 {
        let mut b = [0u8; 1];
        rd.read_exact(&mut b)
            .await
            .map_err(|e| format!("MQTT remaining len read error: {e}"))?;
        rem_len += ((b[0] & 0x7F) as usize) * multiplier;
        if (b[0] & 0x80) == 0 {
            break;
        }
        multiplier *= 128;
    }
    if rem_len > 1024 * 1024 {
        return Err("MQTT packet exceeds 1 MiB limit".to_string());
    }
    let mut body = vec![0u8; rem_len];
    if rem_len > 0 {
        rd.read_exact(&mut body)
            .await
            .map_err(|e| format!("MQTT body read error: {e}"))?;
    }
    Ok(Some((pkt_type, flags, body)))
}

fn encode_remaining_len(mut len: usize, out: &mut Vec<u8>) {
    loop {
        let mut encoded = (len % 128) as u8;
        len /= 128;
        if len > 0 {
            encoded |= 0x80;
        }
        out.push(encoded);
        if len == 0 {
            break;
        }
    }
}

pub fn encode_mqtt_publish(topic: &str, payload: &[u8]) -> Vec<u8> {
    let tbytes = topic.as_bytes();
    let rem_len = 2 + tbytes.len() + payload.len();
    let mut out = Vec::with_capacity(1 + 4 + rem_len);
    out.push(0x30); // PUBLISH QoS 0
    encode_remaining_len(rem_len, &mut out);
    out.extend_from_slice(&(tbytes.len() as u16).to_be_bytes());
    out.extend_from_slice(tbytes);
    out.extend_from_slice(payload);
    out
}

pub fn parse_mcu_uplink_topic(topic: &str) -> Option<(&str, &str)> {
    // neo/<cluster_id>/mcu/<mcu_id>/up
    let parts: Vec<&str> = topic.split('/').collect();
    if parts.len() == 5 && parts[0] == "neo" && parts[2] == "mcu" && parts[4] == "up" {
        Some((parts[1], parts[3]))
    } else {
        None
    }
}

pub fn mqtt_topic_matches(filter: &str, topic: &str) -> bool {
    let fparts: Vec<&str> = filter.split('/').collect();
    let tparts: Vec<&str> = topic.split('/').collect();
    for (i, fp) in fparts.iter().enumerate() {
        if *fp == "#" {
            return true;
        }
        if i >= tparts.len() {
            return false;
        }
        if *fp != "+" && *fp != tparts[i] {
            return false;
        }
    }
    fparts.len() == tparts.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cobs_and_crc16_uart_frame_roundtrip() {
        // Known NIST-style check for CRC16-CCITT-FALSE over "123456789" = 0x29B1
        assert_eq!(crc16_ccitt(b"123456789"), 0x29B1);

        let frame = UartMcuFrame {
            mcu_id: "mcu-esp32-rack01".to_string(),
            seq_id: 42,
            e2e_mac: [0xAB; 32],
            cbor_bytes: vec![0xA1, 0x61, 0x74, 0x63, 0x63, 0x6D, 0x64, 0x00, 0xFF],
        };
        let mut encoded = frame.encode_cobs().unwrap();
        assert!(encoded.len() <= UART_MAX_COBS_FRAME_LEN);
        assert_eq!(*encoded.last().unwrap(), 0x00);
        // No zero bytes before trailing delimiter
        assert!(!encoded[..encoded.len() - 1].contains(&0x00));

        let decoded = UartMcuFrame::decode_cobs(&encoded).unwrap();
        assert_eq!(decoded, frame);

        // Corrupt a byte -> CRC error
        encoded[5] ^= 0x01;
        assert!(UartMcuFrame::decode_cobs(&encoded).is_err());
    }

    #[tokio::test]
    async fn mqtt_broker_bridges_uplink_and_downlink_transparently() {
        let (uplink_tx, mut uplink_rx) = mpsc::channel(16);
        let bridge = RelayBridge::new(
            "cluster-test".to_string(),
            "os-relay-1".to_string(),
            None,
            uplink_tx,
        );
        let addr = bridge.start_mqtt_broker("127.0.0.1:0").await.unwrap();

        let mut client = TcpStream::connect(addr).await.unwrap();
        // Send MQTT CONNECT
        let connect_pkt = [
            0x10, 12, 0x00, 0x04, b'M', b'Q', b'T', b'T', 0x04, 0x02, 0x00, 60, 0x00, 0x00,
        ];
        client.write_all(&connect_pkt).await.unwrap();
        let mut connack = [0u8; 4];
        client.read_exact(&mut connack).await.unwrap();
        assert_eq!(connack, [0x20, 0x02, 0x00, 0x00]);

        // SUBSCRIBE to neo/cluster-test/mcu/mcu-1/down
        let sub_topic = b"neo/cluster-test/mcu/mcu-1/down";
        let mut sub = vec![0x82, (2 + 2 + sub_topic.len() + 1) as u8, 0x00, 0x01];
        sub.extend_from_slice(&(sub_topic.len() as u16).to_be_bytes());
        sub.extend_from_slice(sub_topic);
        sub.push(0x00);
        client.write_all(&sub).await.unwrap();
        let mut suback = [0u8; 5];
        client.read_exact(&mut suback).await.unwrap();
        assert_eq!(suback, [0x90, 0x03, 0x00, 0x01, 0x00]);

        // MCU publishes uplink to neo/cluster-test/mcu/mcu-1/up
        let mut up_payload = Vec::new();
        up_payload.extend_from_slice(&7u64.to_be_bytes());
        up_payload.extend_from_slice(&[0x11; 32]);
        up_payload.extend_from_slice(&[0xA0]); // empty CBOR map
        let up_pkt = encode_mqtt_publish("neo/cluster-test/mcu/mcu-1/up", &up_payload);
        client.write_all(&up_pkt).await.unwrap();

        let env = uplink_rx.recv().await.unwrap();
        assert_eq!(env.cluster_id, "cluster-test");
        assert_eq!(env.target_mcu_id, "mcu-1");
        assert_eq!(env.seq_id, 7);
        assert_eq!(env.e2e_mac, hex::encode([0x11u8; 32]));

        // Master sends downlink -> MCU receives MQTT PUBLISH
        let down_env = RelayEnvelope {
            cluster_id: "cluster-test".to_string(),
            relay_node_id: "os-relay-1".to_string(),
            target_mcu_id: "mcu-1".to_string(),
            direction: "downlink".to_string(),
            seq_id: 9,
            e2e_mac: hex::encode([0x22u8; 32]),
            cbor_payload_b64: STANDARD.encode([0xA1, 0x61, 0x74]),
        };
        let delivered = bridge.publish_downlink(&down_env).await.unwrap();
        assert_eq!(delivered, 1);

        let mut buf = [0u8; 256];
        let n = client.read(&mut buf).await.unwrap();
        assert!(n > 40);
        assert_eq!(buf[0], 0x30);
    }

    #[tokio::test]
    async fn ota_cache_roundtrip_and_rate_limiter() {
        let dir = std::env::temp_dir().join(format!("neo_ota_cache_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (tx, _rx) = mpsc::channel(4);
        let bridge = RelayBridge::new(
            "cluster-test".to_string(),
            "os-relay-1".to_string(),
            Some(dir.clone()),
            tx,
        );

        let fw = b"esp32s3-fw-image-v1.0.1";
        bridge
            .cache_ota_artifact("mcu-esp32-rack01", "1.0.1", fw)
            .await
            .unwrap();
        let loaded = bridge
            .read_ota_artifact("mcu-esp32-rack01", "1.0.1")
            .await
            .unwrap();
        assert_eq!(loaded, fw);
        assert!(bridge
            .cache_ota_artifact("../evil", "1.0.1", fw)
            .await
            .is_err());

        let limiter = McuRateLimiter::new(2.0, 0.0);
        assert!(limiter.allow("mcu-1").await);
        assert!(limiter.allow("mcu-1").await);
        assert!(!limiter.allow("mcu-1").await);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
