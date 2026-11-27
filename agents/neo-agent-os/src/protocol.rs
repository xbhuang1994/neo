use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use tokio::net::UdpSocket;

#[allow(dead_code)]
type HmacSha256 = Hmac<Sha256>;

pub const RELAY_MAGIC: [u8; 2] = [0x4E, 0x52]; // "NR"
pub const RELAY_VERSION: u8 = 0x01;
pub const RELAY_HEADER_LEN: usize = 10;
pub const MAX_RELAY_PAYLOAD_LEN: usize = 16 * 1024 * 1024;
pub const E2E_ENVELOPE_VERSION: u8 = 0xE1;
pub const E2E_NONCE_LEN: usize = 12;
pub const E2E_TAG_LEN: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RelayFlags {
    Data = 0x01,
    Ping = 0x02,
    Pong = 0x03,
    ErrOffline = 0x81,
    ErrSpoofed = 0x82,
    ErrRate = 0x83,
}

impl TryFrom<u8> for RelayFlags {
    type Error = String;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0x01 => Ok(Self::Data),
            0x02 => Ok(Self::Ping),
            0x03 => Ok(Self::Pong),
            0x81 => Ok(Self::ErrOffline),
            0x82 => Ok(Self::ErrSpoofed),
            0x83 => Ok(Self::ErrRate),
            other => Err(format!("unknown relay frame flags: 0x{other:02x}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayFrame {
    pub flags: RelayFlags,
    pub src: String,
    pub dst: String,
    pub payload: Vec<u8>,
}

impl RelayFrame {
    pub fn encode(&self) -> Result<Vec<u8>, String> {
        let src_bytes = self.src.as_bytes();
        let dst_bytes = self.dst.as_bytes();
        if src_bytes.len() > u8::MAX as usize {
            return Err("src node_id exceeds 255 bytes".to_string());
        }
        if dst_bytes.len() > u8::MAX as usize {
            return Err("dst node_id exceeds 255 bytes".to_string());
        }
        if self.payload.len() > MAX_RELAY_PAYLOAD_LEN {
            return Err("relay payload exceeds max size".to_string());
        }
        let mut out =
            Vec::with_capacity(RELAY_HEADER_LEN + src_bytes.len() + dst_bytes.len() + self.payload.len());
        out.push(RELAY_MAGIC[0]);
        out.push(RELAY_MAGIC[1]);
        out.push(RELAY_VERSION);
        out.push(self.flags as u8);
        out.push(src_bytes.len() as u8);
        out.push(dst_bytes.len() as u8);
        out.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        out.extend_from_slice(src_bytes);
        out.extend_from_slice(dst_bytes);
        out.extend_from_slice(&self.payload);
        Ok(out)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < RELAY_HEADER_LEN {
            return Err(format!("relay frame too short: {} bytes", bytes.len()));
        }
        if bytes[0] != RELAY_MAGIC[0] || bytes[1] != RELAY_MAGIC[1] {
            return Err("invalid relay frame magic".to_string());
        }
        if bytes[2] != RELAY_VERSION {
            return Err(format!("unsupported relay frame version: {}", bytes[2]));
        }
        let flags = RelayFlags::try_from(bytes[3])?;
        let src_len = bytes[4] as usize;
        let dst_len = bytes[5] as usize;
        let payload_len = u32::from_be_bytes([bytes[6], bytes[7], bytes[8], bytes[9]]) as usize;
        if payload_len > MAX_RELAY_PAYLOAD_LEN {
            return Err("relay frame payload exceeds limit".to_string());
        }
        let expected = RELAY_HEADER_LEN + src_len + dst_len + payload_len;
        if bytes.len() != expected {
            return Err(format!(
                "relay frame length mismatch: got {}, expected {expected}",
                bytes.len()
            ));
        }
        let src_start = RELAY_HEADER_LEN;
        let dst_start = src_start + src_len;
        let payload_start = dst_start + dst_len;
        let src = std::str::from_utf8(&bytes[src_start..dst_start])
            .map_err(|e| format!("invalid UTF-8 src: {e}"))?
            .to_string();
        let dst = std::str::from_utf8(&bytes[dst_start..payload_start])
            .map_err(|e| format!("invalid UTF-8 dst: {e}"))?
            .to_string();
        let payload = bytes[payload_start..].to_vec();
        Ok(Self {
            flags,
            src,
            dst,
            payload,
        })
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenClaims {
    pub cluster_id: String,
    pub node_id: String,
    pub tier: String,
    pub iat: u64,
    pub exp: u64,
}

#[allow(dead_code)]
pub fn derive_cluster_hmac_key(root_secret: &str, cluster_id: &str) -> [u8; 32] {
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(root_secret.as_bytes()).expect("HMAC accepts any key");
    mac.update(format!("cluster:{cluster_id}").as_bytes());
    mac.finalize().into_bytes().into()
}

#[allow(dead_code)]
pub fn mint_neo1_token(claims: &TokenClaims, key: &[u8]) -> Result<String, String> {
    let claims_json = serde_json::to_vec(claims).map_err(|e| e.to_string())?;
    let payload_b64 = URL_SAFE_NO_PAD.encode(claims_json);
    let signing_input = format!("neo1.{payload_b64}");
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).map_err(|e| e.to_string())?;
    mac.update(signing_input.as_bytes());
    let sig = mac.finalize().into_bytes();
    let sig_b64 = URL_SAFE_NO_PAD.encode(sig);
    Ok(format!("{signing_input}.{sig_b64}"))
}

#[allow(dead_code)]
pub fn verify_neo1_token(token: &str, key: &[u8], now_unix: u64) -> Result<TokenClaims, String> {
    let mut parts = token.split('.');
    let prefix = parts.next().ok_or("missing neo1 prefix")?;
    let payload_b64 = parts.next().ok_or("missing neo1 payload")?;
    let sig_b64 = parts.next().ok_or("missing neo1 signature")?;
    if parts.next().is_some() || prefix != "neo1" {
        return Err("invalid neo1 token format".to_string());
    }
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|e| format!("invalid token signature base64url: {e}"))?;
    let signing_input = format!("neo1.{payload_b64}");
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).map_err(|e| e.to_string())?;
    mac.update(signing_input.as_bytes());
    mac.verify_slice(&sig_bytes)
        .map_err(|_| "invalid token HMAC signature".to_string())?;

    let claims_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|e| format!("invalid token claims base64url: {e}"))?;
    let claims: TokenClaims =
        serde_json::from_slice(&claims_bytes).map_err(|e| format!("invalid claims JSON: {e}"))?;
    if claims.exp <= now_unix {
        return Err("token expired".to_string());
    }
    Ok(claims)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeviceMessage {
    pub v: u8,
    pub kind: String,
    pub req_id: String,
    pub cluster_id: String,
    pub device_id: String,
    pub ts_ms: u64,
    pub body: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayEnvelope {
    pub cluster_id: String,
    pub relay_node_id: String,
    pub target_mcu_id: String,
    pub direction: String,
    pub seq_id: u64,
    pub e2e_mac: String,
    pub cbor_payload_b64: String,
}

pub fn derive_e2e_key(cluster_id: &str, e2e_master_secret: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(format!("neo-e2e-v1:{cluster_id}:{e2e_master_secret}").as_bytes());
    hasher.finalize().into()
}

pub fn build_e2e_aad(cluster_id: &str, src_id: &str, dst_id: &str) -> Vec<u8> {
    format!("{cluster_id}|{src_id}|{dst_id}").into_bytes()
}

pub fn seal_device_message(
    key: &[u8; 32],
    src_id: &str,
    dst_id: &str,
    msg: &DeviceMessage,
) -> Result<Vec<u8>, String> {
    if msg.v != 1 {
        return Err(format!("unsupported DeviceMessage version: {}", msg.v));
    }
    let plaintext = serde_json::to_vec(msg).map_err(|e| format!("serialize error: {e}"))?;
    let aad = build_e2e_aad(&msg.cluster_id, src_id, dst_id);
    let mut nonce_bytes = [0u8; E2E_NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("cipher init error: {e}"))?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "AEAD encryption failed".to_string())?;

    let mut out = Vec::with_capacity(1 + E2E_NONCE_LEN + ciphertext.len());
    out.push(E2E_ENVELOPE_VERSION);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn open_device_message(
    key: &[u8; 32],
    local_cluster_id: &str,
    src_id: &str,
    dst_id: &str,
    wire: &[u8],
) -> Result<DeviceMessage, String> {
    if wire.len() < 1 + E2E_NONCE_LEN + E2E_TAG_LEN {
        return Err("E2E envelope too short".to_string());
    }
    if wire[0] != E2E_ENVELOPE_VERSION {
        return Err(format!("invalid E2E version byte: 0x{:02x}", wire[0]));
    }
    let nonce = Nonce::from_slice(&wire[1..1 + E2E_NONCE_LEN]);
    let ciphertext = &wire[1 + E2E_NONCE_LEN..];
    let aad = build_e2e_aad(local_cluster_id, src_id, dst_id);

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("cipher init error: {e}"))?;
    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| "AEAD decryption/authentication failed".to_string())?;

    let msg: DeviceMessage = serde_json::from_slice(&plaintext)
        .map_err(|e| format!("invalid decrypted DeviceMessage JSON: {e}"))?;
    if msg.v != 1 {
        return Err(format!("unsupported DeviceMessage version: {}", msg.v));
    }
    if msg.cluster_id != local_cluster_id {
        return Err(format!(
            "cross-cluster DeviceMessage rejected: got '{}', expected '{local_cluster_id}'",
            msg.cluster_id
        ));
    }
    Ok(msg)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BootstrapResponse {
    #[serde(default)]
    pub cluster_id: Option<String>,
    #[serde(default)]
    pub node_id: Option<String>,
    #[serde(default)]
    pub stun_servers: Vec<String>,
    #[serde(default)]
    pub relay_url: Option<String>,
    #[serde(default)]
    pub signal_url: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts_ms: Option<u64>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

impl SignalMessage {
    pub fn new(msg_type: impl Into<String>) -> Self {
        Self {
            msg_type: msg_type.into(),
            cluster_id: None,
            node_id: None,
            from: None,
            to: None,
            tier: None,
            addr: None,
            candidates: None,
            ts_ms: None,
            extra: HashMap::new(),
        }
    }
}

const STUN_MAGIC_COOKIE: u32 = 0x2112_A442;
const STUN_BINDING_REQUEST: u16 = 0x0001;
const STUN_BINDING_RESPONSE: u16 = 0x0101;
const STUN_ATTR_MAPPED_ADDRESS: u16 = 0x0001;
const STUN_ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

/// Builds a 20-byte RFC 5389 STUN Binding Request.
pub fn build_stun_binding_request(tx_id: [u8; 12]) -> [u8; 20] {
    let mut pkt = [0u8; 20];
    pkt[0..2].copy_from_slice(&STUN_BINDING_REQUEST.to_be_bytes());
    pkt[2..4].copy_from_slice(&0u16.to_be_bytes());
    pkt[4..8].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
    pkt[8..20].copy_from_slice(&tx_id);
    pkt
}

/// Parses an RFC 5389 STUN Binding Response, extracting `XOR-MAPPED-ADDRESS`
/// (or falling back to `MAPPED-ADDRESS`).
pub fn parse_stun_binding_response(
    pkt: &[u8],
    expected_tx_id: &[u8; 12],
) -> Result<SocketAddr, String> {
    if pkt.len() < 20 {
        return Err("STUN packet shorter than 20 bytes".to_string());
    }
    let msg_type = u16::from_be_bytes([pkt[0], pkt[1]]);
    if msg_type != STUN_BINDING_RESPONSE {
        return Err(format!("unexpected STUN message type: 0x{msg_type:04x}"));
    }
    let msg_len = u16::from_be_bytes([pkt[2], pkt[3]]) as usize;
    if pkt.len() < 20 + msg_len {
        return Err("truncated STUN attributes".to_string());
    }
    let cookie = u32::from_be_bytes([pkt[4], pkt[5], pkt[6], pkt[7]]);
    if cookie != STUN_MAGIC_COOKIE {
        return Err("invalid STUN magic cookie".to_string());
    }
    if &pkt[8..20] != expected_tx_id {
        return Err("STUN transaction ID mismatch".to_string());
    }

    let mut mapped_fallback: Option<SocketAddr> = None;
    let mut off = 20;
    let end = 20 + msg_len;
    while off + 4 <= end {
        let attr_type = u16::from_be_bytes([pkt[off], pkt[off + 1]]);
        let attr_len = u16::from_be_bytes([pkt[off + 2], pkt[off + 3]]) as usize;
        off += 4;
        if off + attr_len > end {
            break;
        }
        let val = &pkt[off..off + attr_len];
        if attr_type == STUN_ATTR_XOR_MAPPED_ADDRESS {
            if let Some(addr) = parse_stun_addr(val, true, expected_tx_id) {
                return Ok(addr);
            }
        } else if attr_type == STUN_ATTR_MAPPED_ADDRESS && mapped_fallback.is_none() {
            mapped_fallback = parse_stun_addr(val, false, expected_tx_id);
        }
        let padded = (attr_len + 3) & !3;
        off += padded;
    }

    mapped_fallback.ok_or_else(|| "no XOR-MAPPED-ADDRESS or MAPPED-ADDRESS in STUN response".to_string())
}

fn parse_stun_addr(val: &[u8], xor: bool, tx_id: &[u8; 12]) -> Option<SocketAddr> {
    if val.len() < 4 {
        return None;
    }
    let family = val[1];
    let raw_port = u16::from_be_bytes([val[2], val[3]]);
    let port = if xor {
        raw_port ^ ((STUN_MAGIC_COOKIE >> 16) as u16)
    } else {
        raw_port
    };
    match family {
        0x01 if val.len() >= 8 => {
            let mut octets = [val[4], val[5], val[6], val[7]];
            if xor {
                let cookie_bytes = STUN_MAGIC_COOKIE.to_be_bytes();
                for i in 0..4 {
                    octets[i] ^= cookie_bytes[i];
                }
            }
            Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::from(octets)), port))
        }
        0x02 if val.len() >= 20 => {
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&val[4..20]);
            if xor {
                let cookie_bytes = STUN_MAGIC_COOKIE.to_be_bytes();
                for i in 0..4 {
                    octets[i] ^= cookie_bytes[i];
                }
                for i in 0..12 {
                    octets[4 + i] ^= tx_id[i];
                }
            }
            Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(octets)), port))
        }
        _ => None,
    }
}

pub async fn stun_probe(
    sock: &UdpSocket,
    stun_server: &str,
    timeout: Duration,
) -> Result<SocketAddr, String> {
    let mut tx_id = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut tx_id);
    let req = build_stun_binding_request(tx_id);
    sock.send_to(&req, stun_server)
        .await
        .map_err(|e| format!("STUN send failed: {e}"))?;

    let mut buf = [0u8; 512];
    let (n, _) = tokio::time::timeout(timeout, sock.recv_from(&mut buf))
        .await
        .map_err(|_| "STUN probe timed out".to_string())?
        .map_err(|e| format!("STUN recv failed: {e}"))?;
    parse_stun_binding_response(&buf[..n], &tx_id)
}

/// Attempts UDP hole punching to `peer_addr` with a bounded timeout (e.g. 2500ms).
/// Falls back cleanly to WSS relay if punch fails or times out.
pub async fn udp_punch_peer(
    sock: &UdpSocket,
    peer_addr: SocketAddr,
    cluster_id: &str,
    local_id: &str,
    peer_id: &str,
    timeout: Duration,
) -> Result<SocketAddr, String> {
    let probe_msg = format!("NEO_PUNCH|{cluster_id}|{local_id}|{peer_id}");
    let expected_prefix = format!("NEO_PUNCH|{cluster_id}|{peer_id}|{local_id}");
    let ack_msg = format!("NEO_PUNCH_ACK|{cluster_id}|{local_id}|{peer_id}");
    let expected_ack = format!("NEO_PUNCH_ACK|{cluster_id}|{peer_id}|{local_id}");

    let deadline = tokio::time::Instant::now() + timeout;
    let mut buf = [0u8; 512];
    let mut tick = tokio::time::interval(Duration::from_millis(200));

    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err("UDP P2P punch timed out (fallback to WSS relay)".to_string());
        }
        tokio::select! {
            _ = tick.tick() => {
                let _ = sock.send_to(probe_msg.as_bytes(), peer_addr).await;
            }
            recv = tokio::time::timeout_at(deadline, sock.recv_from(&mut buf)) => {
                match recv {
                    Ok(Ok((n, from))) => {
                        let s = std::str::from_utf8(&buf[..n]).unwrap_or("");
                        if s == expected_prefix {
                            let _ = sock.send_to(ack_msg.as_bytes(), from).await;
                            return Ok(from);
                        }
                        if s == expected_ack {
                            return Ok(from);
                        }
                    }
                    Ok(Err(e)) => return Err(format!("UDP punch recv error: {e}")),
                    Err(_) => return Err("UDP P2P punch timed out (fallback to WSS relay)".to_string()),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_frame_10b_wire_roundtrip() {
        let frame = RelayFrame {
            flags: RelayFlags::Data,
            src: "master-1".to_string(),
            dst: "os-node-1".to_string(),
            payload: vec![0xDE, 0xAD, 0xBE, 0xEF],
        };
        let wire = frame.encode().unwrap();
        assert_eq!(&wire[0..4], &[0x4E, 0x52, 0x01, 0x01]);
        assert_eq!(wire[4], 8);
        assert_eq!(wire[5], 9);
        assert_eq!(&wire[6..10], &[0, 0, 0, 4]);
        let decoded = RelayFrame::decode(&wire).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn neo1_token_mint_and_verify() {
        let key = derive_cluster_hmac_key("root-secret", "cluster-a");
        let claims = TokenClaims {
            cluster_id: "cluster-a".to_string(),
            node_id: "os-1".to_string(),
            tier: "os".to_string(),
            iat: 1000,
            exp: 2000,
        };
        let token = mint_neo1_token(&claims, &key).unwrap();
        assert!(token.starts_with("neo1."));
        let verified = verify_neo1_token(&token, &key, 1500).unwrap();
        assert_eq!(verified, claims);
        assert!(verify_neo1_token(&token, &key, 2000).is_err());
        let wrong_key = derive_cluster_hmac_key("root-secret", "cluster-b");
        assert!(verify_neo1_token(&token, &wrong_key, 1500).is_err());
    }

    #[test]
    fn e2e_aead_roundtrip_and_cross_cluster_rejection() {
        let key_a = derive_e2e_key("cluster-a", "shared-e2e-secret");
        let msg = DeviceMessage {
            v: 1,
            kind: "rpc_req".to_string(),
            req_id: "req-1".to_string(),
            cluster_id: "cluster-a".to_string(),
            device_id: "os-1".to_string(),
            ts_ms: 1_700_000_000_000,
            body: serde_json::json!({"method": "exec", "params": {"program": "echo"}}),
        };
        let wire = seal_device_message(&key_a, "master-1", "os-1", &msg).unwrap();
        assert_eq!(wire[0], 0xE1);
        let opened = open_device_message(&key_a, "cluster-a", "master-1", "os-1", &wire).unwrap();
        assert_eq!(opened, msg);

        // Wrong AAD src_id must fail authentication
        assert!(open_device_message(&key_a, "cluster-a", "spoofed", "os-1", &wire).is_err());
        // Different cluster key must fail
        let key_b = derive_e2e_key("cluster-b", "shared-e2e-secret");
        assert!(open_device_message(&key_b, "cluster-b", "master-1", "os-1", &wire).is_err());
        // Even if sealed with matching key, mismatched inner cluster_id is rejected
        let spoofed_inner = DeviceMessage {
            cluster_id: "cluster-b".to_string(),
            ..msg
        };
        let mut aad_bytes = Vec::new();
        aad_bytes.extend_from_slice(&build_e2e_aad("cluster-a", "master-1", "os-1"));
        let cipher = Aes256Gcm::new_from_slice(&key_a).unwrap();
        let nonce = [7u8; 12];
        let ct = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &serde_json::to_vec(&spoofed_inner).unwrap(),
                    aad: &aad_bytes,
                },
            )
            .unwrap();
        let mut forged_wire = vec![0xE1];
        forged_wire.extend_from_slice(&nonce);
        forged_wire.extend_from_slice(&ct);
        assert!(open_device_message(&key_a, "cluster-a", "master-1", "os-1", &forged_wire).is_err());
    }

    #[test]
    fn stun_xor_mapped_address_parser() {
        let tx_id = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        let req = build_stun_binding_request(tx_id);
        assert_eq!(req.len(), 20);
        assert_eq!(&req[4..8], &STUN_MAGIC_COOKIE.to_be_bytes());

        // Craft STUN Binding Success Response with XOR-MAPPED-ADDRESS 203.0.113.42:54321
        let port_xor: u16 = 54321 ^ ((STUN_MAGIC_COOKIE >> 16) as u16);
        let ip = Ipv4Addr::new(203, 0, 113, 42).octets();
        let cookie = STUN_MAGIC_COOKIE.to_be_bytes();
        let ip_xor = [
            ip[0] ^ cookie[0],
            ip[1] ^ cookie[1],
            ip[2] ^ cookie[2],
            ip[3] ^ cookie[3],
        ];
        let mut resp = Vec::new();
        resp.extend_from_slice(&STUN_BINDING_RESPONSE.to_be_bytes());
        resp.extend_from_slice(&12u16.to_be_bytes()); // 1 attr (4B hdr + 8B val)
        resp.extend_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
        resp.extend_from_slice(&tx_id);
        resp.extend_from_slice(&STUN_ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        resp.extend_from_slice(&8u16.to_be_bytes());
        resp.push(0x00);
        resp.push(0x01); // IPv4
        resp.extend_from_slice(&port_xor.to_be_bytes());
        resp.extend_from_slice(&ip_xor);

        let parsed = parse_stun_binding_response(&resp, &tx_id).unwrap();
        assert_eq!(parsed, "203.0.113.42:54321".parse::<SocketAddr>().unwrap());
    }
}
