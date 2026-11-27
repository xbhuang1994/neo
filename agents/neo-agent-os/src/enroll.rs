use crate::policy::{Policy, PolicyConfig};
use crate::prober::read_hostname;
use crate::protocol::{
    derive_e2e_key, open_device_message, seal_device_message, DeviceMessage, RelayFlags,
    RelayFrame, TokenClaims,
};
use crate::transport::{
    connect_ws_bearer, derive_endpoints, http_post_json, now_ms, run_agent, run_one_shot_check,
    AgentConfig,
};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use clap::{Args, ValueEnum};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use url::Url;

pub const ENROLL_ENVELOPE_VERSION: u8 = 0xE2;
pub const ENROLL_NONCE_LEN: usize = 12;
pub const ENROLL_TAG_LEN: usize = 16;
pub const ENROLL_CLOCK_SKEW_SECS: u64 = 60;
const BOOTSTRAP_EXCHANGE_TIMEOUT_SECS: u64 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum EnrollModeArg {
    Auto,
    System,
    User,
    Foreground,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectiveMode {
    System,
    User,
    Foreground,
}

impl EffectiveMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Foreground => "foreground",
        }
    }
}

#[derive(Debug, Clone, Args)]
pub struct EnrollArgs {
    /// Neo relay base URL (e.g. https://neo.1inch.cn:18443)
    #[arg(long, env = "NEO_RELAY_URL")]
    pub relay_url: Option<String>,

    /// Explicit enrollment claim URL override
    #[arg(long)]
    pub claim_url: Option<String>,

    /// Enrollment ticket string (neo_enr_v1.<ticket_id>.<ephemeral_key>)
    #[arg(long, conflicts_with = "ticket_stdin")]
    pub ticket: Option<String>,

    /// Read enrollment ticket from stdin (avoids exposing ticket on argv)
    #[arg(long, default_value_t = false, conflicts_with = "ticket")]
    pub ticket_stdin: bool,

    /// Installation mode
    #[arg(long, value_enum, default_value_t = EnrollModeArg::Auto)]
    pub mode: EnrollModeArg,

    /// Override configuration directory (stores policy-<cluster>.toml and cluster-<cluster>.env)
    #[arg(long)]
    pub config_dir: Option<PathBuf>,

    /// Write policy and env files without installing or starting an OS service
    #[arg(long, default_value_t = false)]
    pub skip_service: bool,

    /// Skip the post-enrollment one-shot relay connectivity check
    #[arg(long, default_value_t = false)]
    pub skip_check: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTicket {
    pub ticket_id: String,
    pub ephemeral_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ClaimResponse {
    pub ticket_id: String,
    pub ciphertext_b64: String,
    #[serde(default)]
    pub expires_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnrollRelayBridge {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub mqtt_bind: Option<String>,
    #[serde(default)]
    pub uart_device: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnrollLimits {
    #[serde(default)]
    pub memory_max: Option<String>,
    #[serde(default)]
    pub cpu_quota: Option<String>,
    #[serde(default)]
    pub cuda_devices: Option<String>,
}

fn default_auth_mode() -> String {
    "direct".to_string()
}

fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    T: Default + Deserialize<'de>,
    D: Deserializer<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

fn deserialize_expires_at<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let val = serde_json::Value::deserialize(deserializer)?;
    match val {
        serde_json::Value::Number(n) => {
            let raw = n
                .as_u64()
                .ok_or_else(|| serde::de::Error::custom("expires_at must be a non-negative integer"))?;
            Ok(normalize_epoch_secs(raw))
        }
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            if let Ok(raw) = trimmed.parse::<u64>() {
                return Ok(normalize_epoch_secs(raw));
            }
            parse_rfc3339_utc_secs(trimmed)
                .ok_or_else(|| serde::de::Error::custom(format!("invalid expires_at timestamp: {s}")))
        }
        other => Err(serde::de::Error::custom(format!(
            "expires_at must be a unix timestamp or RFC3339 string, got {other}"
        ))),
    }
}

fn normalize_epoch_secs(raw: u64) -> u64 {
    if raw >= 100_000_000_000 {
        raw / 1000
    } else {
        raw
    }
}

/// Minimal zero-dependency UTC RFC3339 parser (`YYYY-MM-DDTHH:MM:SS[.frac]Z`).
fn parse_rfc3339_utc_secs(s: &str) -> Option<u64> {
    let s = s.strip_suffix('Z').or_else(|| s.strip_suffix('z'))?;
    let (date_part, time_part) = s.split_once('T').or_else(|| s.split_once('t'))?;
    let mut d = date_part.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: u32 = d.next()?.parse().ok()?;
    let day: u32 = d.next()?.parse().ok()?;
    if d.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time_no_frac = time_part.split('.').next()?;
    let mut t = time_no_frac.split(':');
    let hour: u64 = t.next()?.parse().ok()?;
    let min: u64 = t.next()?.parse().ok()?;
    let sec: u64 = t.next()?.parse().ok()?;
    if t.next().is_some() || hour > 23 || min > 59 || sec > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    if days < 0 {
        return None;
    }
    Some((days as u64) * 86_400 + hour * 3600 + min * 60 + sec)
}

/// Howard Hinnant's civil-from-days inverse (days since 1970-01-01).
fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64; // [0, 399]
    let m = month as u64;
    let d = day as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    Some(era * 146_097 + (doe as i64) - 719_468)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnrollPayload {
    pub v: u8,
    pub enroll_id: String,
    pub cluster_id: String,
    pub master_id: String,
    pub relay_url: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub device_id: String,
    #[serde(default = "default_auth_mode")]
    pub auth_mode: String,
    pub relay_token: String,
    pub e2e_key: String,
    #[serde(default)]
    pub agent_version: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub download_mirrors: Vec<String>,
    #[serde(default)]
    pub install_mode: Option<String>,
    #[serde(default)]
    pub policy_profile: Option<String>,
    pub policy_toml: String,
    #[serde(default)]
    pub workspace_override: Option<String>,
    #[serde(default)]
    pub relay_bridge: Option<EnrollRelayBridge>,
    #[serde(default)]
    pub limits: Option<EnrollLimits>,
    #[serde(deserialize_with = "deserialize_expires_at")]
    pub expires_at: u64,
}

#[derive(Debug, Clone)]
pub struct EnrollOutcome {
    pub cluster_id: String,
    pub device_id: String,
    pub enroll_id: String,
    pub mode: EffectiveMode,
    pub policy_path: PathBuf,
    pub env_path: PathBuf,
    pub workspace_dir: PathBuf,
    pub ota_cache_dir: PathBuf,
    pub service_status: String,
}

pub fn validate_cluster_id(cluster_id: &str) -> Result<(), String> {
    let bytes = cluster_id.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return Err(format!("invalid cluster_id length: {cluster_id:?}"));
    }
    if !bytes[0].is_ascii_alphanumeric() {
        return Err(format!(
            "cluster_id must start with an ASCII letter or digit: {cluster_id:?}"
        ));
    }
    if !bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
    {
        return Err(format!(
            "cluster_id contains forbidden characters (allowed: [a-zA-Z0-9_-]): {cluster_id:?}"
        ));
    }
    Ok(())
}

pub fn parse_ticket(raw: &str) -> Result<ParsedTicket, String> {
    let trimmed = raw.trim();
    let mut parts = trimmed.split('.');
    let prefix = parts.next().ok_or("missing enrollment ticket prefix")?;
    let ticket_id = parts.next().ok_or("missing enrollment ticket_id")?;
    let ephemeral_key = parts.next().ok_or("missing enrollment ephemeral_key")?;
    if parts.next().is_some() || prefix != "neo_enr_v1" {
        return Err(
            "invalid enrollment ticket format (expected neo_enr_v1.<ticket_id>.<ephemeral_key>)"
                .to_string(),
        );
    }
    if ticket_id.is_empty()
        || !ticket_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid ticket_id in enrollment ticket: {ticket_id:?}"));
    }
    if ephemeral_key.is_empty() || ephemeral_key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("invalid ephemeral_key in enrollment ticket".to_string());
    }
    Ok(ParsedTicket {
        ticket_id: ticket_id.to_string(),
        ephemeral_key: ephemeral_key.to_string(),
    })
}

pub fn derive_enroll_key(ticket_id: &str, ephemeral_key: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(format!("neo-enroll-v1:{ticket_id}:{ephemeral_key}").as_bytes());
    hasher.finalize().into()
}

pub fn build_enroll_aad(ticket_id: &str) -> Vec<u8> {
    format!("neo-enroll-v1|{ticket_id}").into_bytes()
}

pub fn decrypt_enroll_payload(
    ticket: &ParsedTicket,
    ciphertext_b64: &str,
) -> Result<EnrollPayload, String> {
    let wire = STANDARD
        .decode(ciphertext_b64.trim())
        .map_err(|e| format!("invalid ciphertext_b64: {e}"))?;
    if wire.len() < 1 + ENROLL_NONCE_LEN + ENROLL_TAG_LEN {
        return Err(format!("enrollment envelope too short: {} bytes", wire.len()));
    }
    if wire[0] != ENROLL_ENVELOPE_VERSION {
        return Err(format!(
            "unsupported enrollment envelope version: 0x{:02x} (expected 0x{:02x})",
            wire[0], ENROLL_ENVELOPE_VERSION
        ));
    }
    let key = derive_enroll_key(&ticket.ticket_id, &ticket.ephemeral_key);
    let aad = build_enroll_aad(&ticket.ticket_id);
    let nonce = Nonce::from_slice(&wire[1..1 + ENROLL_NONCE_LEN]);
    let ciphertext = &wire[1 + ENROLL_NONCE_LEN..];

    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("enrollment cipher init failed: {e}"))?;
    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| {
            "enrollment payload decryption/authentication failed (wrong key or tampered AAD/ciphertext)"
                .to_string()
        })?;

    let payload: EnrollPayload = serde_json::from_slice(&plaintext)
        .map_err(|e| format!("invalid decrypted EnrollPayload JSON: {e}"))?;
    if payload.v != 1 {
        return Err(format!("unsupported EnrollPayload version: {}", payload.v));
    }
    validate_cluster_id(&payload.cluster_id)?;
    if payload.enroll_id.trim().is_empty() {
        return Err("EnrollPayload missing enroll_id".to_string());
    }
    if payload.master_id.trim().is_empty() {
        return Err("EnrollPayload missing master_id".to_string());
    }
    if payload.relay_url.trim().is_empty() {
        return Err("EnrollPayload missing relay_url".to_string());
    }
    if payload.relay_token.trim().is_empty() {
        return Err("EnrollPayload missing relay_token".to_string());
    }
    if payload.e2e_key.trim().is_empty() {
        return Err("EnrollPayload missing e2e_key".to_string());
    }
    if payload.policy_toml.trim().is_empty() {
        return Err("EnrollPayload missing policy_toml".to_string());
    }
    Ok(payload)
}

#[cfg(test)]
pub fn seal_enroll_payload(ticket: &ParsedTicket, payload: &EnrollPayload) -> Result<String, String> {
    use rand::RngCore;
    let plaintext = serde_json::to_vec(payload).map_err(|e| format!("serialize error: {e}"))?;
    let key = derive_enroll_key(&ticket.ticket_id, &ticket.ephemeral_key);
    let aad = build_enroll_aad(&ticket.ticket_id);
    let mut nonce_bytes = [0u8; ENROLL_NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("cipher init: {e}"))?;
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "AEAD encrypt failed".to_string())?;
    let mut wire = Vec::with_capacity(1 + ENROLL_NONCE_LEN + ct.len());
    wire.push(ENROLL_ENVELOPE_VERSION);
    wire.extend_from_slice(&nonce_bytes);
    wire.extend_from_slice(&ct);
    Ok(STANDARD.encode(&wire))
}

pub fn validate_payload_expiry(expires_at_secs: u64, now_unix_secs: u64) -> Result<(), String> {
    if expires_at_secs == 0 || now_unix_secs > expires_at_secs.saturating_add(ENROLL_CLOCK_SKEW_SECS)
    {
        return Err(format!(
            "enrollment payload expired (expires_at={expires_at_secs}, now={now_unix_secs}, skew={}s)",
            ENROLL_CLOCK_SKEW_SECS
        ));
    }
    Ok(())
}

pub fn build_claim_url(
    relay_url: Option<&str>,
    claim_url: Option<&str>,
    ticket_id: &str,
) -> Result<String, String> {
    if let Some(cu) = claim_url.map(str::trim).filter(|s| !s.is_empty()) {
        let parsed = Url::parse(cu).map_err(|e| format!("invalid --claim-url '{cu}': {e}"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(format!(
                "unsupported --claim-url scheme '{}' (expected http or https)",
                parsed.scheme()
            ));
        }
        return Ok(cu.to_string());
    }
    let raw_relay = relay_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("--relay-url (or --claim-url) is required for enrollment")?;
    let mut url =
        Url::parse(raw_relay).map_err(|e| format!("invalid --relay-url '{raw_relay}': {e}"))?;
    match url.scheme() {
        "https" | "wss" => {
            let _ = url.set_scheme("https");
        }
        "http" | "ws" => {
            let _ = url.set_scheme("http");
        }
        other => return Err(format!("unsupported --relay-url scheme: {other}")),
    }
    url.set_path("");
    url.set_query(None);
    let base = url.to_string().trim_end_matches('/').to_string();
    Ok(format!("{base}/v1/enroll/claim/{ticket_id}"))
}

pub fn render_policy_toml(template: &str, workspace_dir: &Path) -> String {
    let ws_raw = workspace_dir.to_string_lossy();
    let ws_toml_escaped = ws_raw.replace('\\', "\\\\").replace('"', "\\\"");
    // Handle single-quoted TOML literal strings first (backslashes are literal in '...').
    let step1 = template.replace("'{{WORKSPACE_DIR}}'", &format!("'{ws_raw}'"));
    // Then replace any remaining {{WORKSPACE_DIR}} (e.g. inside double-quoted TOML strings).
    step1.replace("{{WORKSPACE_DIR}}", &ws_toml_escaped)
}

pub fn extract_token_node_id(token: &str) -> Option<String> {
    let mut parts = token.split('.');
    let prefix = parts.next()?;
    let payload_b64 = parts.next()?;
    let _sig = parts.next()?;
    if parts.next().is_some() || prefix != "neo1" {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(payload_b64).ok()?;
    let claims: TokenClaims = serde_json::from_slice(&bytes).ok()?;
    if claims.node_id.trim().is_empty() {
        None
    } else {
        Some(claims.node_id)
    }
}

pub(crate) fn is_linux_root_with_systemd() -> bool {
    #[cfg(target_os = "linux")]
    {
        let is_root = unsafe { libc::geteuid() == 0 };
        is_root && Path::new("/run/systemd/system").exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

pub fn resolve_effective_mode(
    cli_mode: EnrollModeArg,
    payload_mode: Option<&str>,
) -> EffectiveMode {
    match cli_mode {
        EnrollModeArg::System => EffectiveMode::System,
        EnrollModeArg::User => EffectiveMode::User,
        EnrollModeArg::Foreground => EffectiveMode::Foreground,
        EnrollModeArg::Auto => {
            if let Some(pm) = payload_mode.map(str::trim) {
                if pm.eq_ignore_ascii_case("foreground") {
                    return EffectiveMode::Foreground;
                }
                if pm.eq_ignore_ascii_case("user") {
                    return EffectiveMode::User;
                }
            }
            if is_linux_root_with_systemd() {
                EffectiveMode::System
            } else {
                EffectiveMode::User
            }
        }
    }
}

pub(crate) fn user_home_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        if let Ok(p) = std::env::var("USERPROFILE") {
            if !p.trim().is_empty() {
                return Ok(PathBuf::from(p));
            }
        }
        if let Ok(p) = std::env::var("HOME") {
            if !p.trim().is_empty() {
                return Ok(PathBuf::from(p));
            }
        }
        Err("could not determine user home directory (USERPROFILE/HOME unset)".to_string())
    }
    #[cfg(not(windows))]
    {
        if let Ok(p) = std::env::var("HOME") {
            if !p.trim().is_empty() {
                return Ok(PathBuf::from(p));
            }
        }
        Err("could not determine user home directory (HOME unset)".to_string())
    }
}

pub(crate) fn default_config_dir(mode: EffectiveMode) -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    {
        if mode == EffectiveMode::System {
            return Ok(PathBuf::from("/etc/neo-agent"));
        }
        Ok(user_home_dir()?.join(".config").join("neo-agent"))
    }
    #[cfg(target_os = "macos")]
    {
        let _ = mode;
        Ok(user_home_dir()?.join(".config").join("neo-agent"))
    }
    #[cfg(target_os = "windows")]
    {
        let _ = mode;
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if !local.trim().is_empty() {
                return Ok(PathBuf::from(local).join("neo-agent"));
            }
        }
        Ok(user_home_dir()?.join(".neo-agent"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = mode;
        Ok(user_home_dir()?.join(".config").join("neo-agent"))
    }
}

pub(crate) fn default_workspace_dir(
    cluster_id: &str,
    mode: EffectiveMode,
) -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    {
        if mode == EffectiveMode::System {
            return Ok(PathBuf::from(format!("/home/neo-{cluster_id}/work")));
        }
        Ok(user_home_dir()?.join("neo-work").join(cluster_id))
    }
    #[cfg(target_os = "windows")]
    {
        let _ = mode;
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if !local.trim().is_empty() {
                return Ok(PathBuf::from(local)
                    .join("neo-agent")
                    .join(cluster_id)
                    .join("work"));
            }
        }
        Ok(user_home_dir()?
            .join(".neo-agent")
            .join(cluster_id)
            .join("work"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = mode;
        Ok(user_home_dir()?.join("neo-work").join(cluster_id))
    }
}

pub(crate) fn default_ota_cache_dir(
    cluster_id: &str,
    config_dir: &Path,
    custom_config_dir: bool,
    mode: EffectiveMode,
) -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        if !custom_config_dir && mode == EffectiveMode::System {
            return PathBuf::from(format!("/var/lib/neo-agent/{cluster_id}/ota"));
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (custom_config_dir, mode);
    }
    config_dir.join(cluster_id).join("ota")
}

fn resolve_ticket_raw(args: &EnrollArgs) -> Result<String, String> {
    if args.ticket_stdin {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| format!("failed to read enrollment ticket from stdin: {e}"))?;
        let trimmed = buf.trim().to_string();
        if trimmed.is_empty() {
            return Err("enrollment ticket read from stdin is empty".to_string());
        }
        return Ok(trimmed);
    }
    if let Some(ref t) = args.ticket {
        let trimmed = t.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    if let Ok(t) = std::env::var("NEO_ENROLL_TICKET") {
        let trimmed = t.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    Err(
        "enrollment ticket required: pass --ticket-stdin, --ticket <str>, or set NEO_ENROLL_TICKET"
            .to_string(),
    )
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) fn compute_host_fingerprint() -> String {
    let hostname = read_hostname();
    let machine_id = {
        #[cfg(target_os = "linux")]
        {
            std::fs::read_to_string("/etc/machine-id")
                .or_else(|_| std::fs::read_to_string("/var/lib/dbus/machine-id"))
                .map(|s| s.trim().to_string())
                .unwrap_or_default()
        }
        #[cfg(not(target_os = "linux"))]
        {
            String::new()
        }
    };
    let mut hasher = Sha256::new();
    hasher.update(
        format!(
            "{hostname}|{}|{}|{machine_id}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
        .as_bytes(),
    );
    hex::encode(hasher.finalize())
}

async fn claim_ticket(claim_url: &str, expected_ticket_id: &str) -> Result<ClaimResponse, String> {
    let (status, body) = http_post_json(claim_url, b"{}").await?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "enrollment claim HTTP {status} from {claim_url}: {}",
            String::from_utf8_lossy(&body).trim()
        ));
    }
    let resp: ClaimResponse = serde_json::from_slice(&body)
        .map_err(|e| format!("invalid enrollment claim JSON response: {e}"))?;
    if !resp.ticket_id.is_empty() && resp.ticket_id != expected_ticket_id {
        return Err(format!(
            "enrollment claim ticket_id mismatch: server returned '{}', expected '{expected_ticket_id}'",
            resp.ticket_id
        ));
    }
    Ok(resp)
}

async fn perform_bootstrap_exchange(
    ticket: &ParsedTicket,
    payload: &EnrollPayload,
    mode: EffectiveMode,
) -> Result<(String, String), String> {
    let temp_node_id = extract_token_node_id(&payload.relay_token)
        .unwrap_or_else(|| format!("enr-{}", ticket.ticket_id));
    let endpoints = derive_endpoints(&payload.relay_url)?;
    let mut ws = connect_ws_bearer(&endpoints.relay_url, &payload.relay_token).await?;

    let e2e_key = derive_e2e_key(&payload.cluster_id, &payload.e2e_key);
    let req_id = format!("enr-reg-{}", now_ms());
    let initial_device_id = if payload.device_id.trim().is_empty() {
        temp_node_id.clone()
    } else {
        payload.device_id.clone()
    };

    let reg_msg = DeviceMessage {
        v: 1,
        kind: "enroll_register".to_string(),
        req_id: req_id.clone(),
        cluster_id: payload.cluster_id.clone(),
        device_id: initial_device_id,
        ts_ms: now_ms(),
        body: json!({
            "enroll_id": payload.enroll_id,
            "hostname": read_hostname(),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "install_mode": mode.as_str(),
            "fingerprint": compute_host_fingerprint(),
        }),
    };

    let sealed = seal_device_message(&e2e_key, &temp_node_id, &payload.master_id, &reg_msg)?;
    let frame = RelayFrame {
        flags: RelayFlags::Data,
        src: temp_node_id.clone(),
        dst: payload.master_id.clone(),
        payload: sealed,
    };
    let wire = frame.encode()?;
    ws.send(WsMessage::Binary(wire.clone().into()))
        .await
        .map_err(|e| format!("failed to send enroll_register frame: {e}"))?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(BOOTSTRAP_EXCHANGE_TIMEOUT_SECS);
    let mut saw_offline = false;

    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            let _ = ws.close(None).await;
            if saw_offline {
                return Err(format!(
                    "bootstrap_exchange timed out after {BOOTSTRAP_EXCHANGE_TIMEOUT_SECS}s: master '{}' appears offline on relay",
                    payload.master_id
                ));
            }
            return Err(format!(
                "bootstrap_exchange timed out waiting {BOOTSTRAP_EXCHANGE_TIMEOUT_SECS}s for enroll_ack from '{}'",
                payload.master_id
            ));
        }

        let next_msg = tokio::time::timeout_at(deadline, ws.next()).await;
        match next_msg {
            Err(_) => continue,
            Ok(None) | Ok(Some(Ok(WsMessage::Close(_)))) => {
                return Err("relay WebSocket closed before enroll_ack was received".to_string());
            }
            Ok(Some(Err(e))) => {
                return Err(format!("relay WebSocket error during bootstrap_exchange: {e}"));
            }
            Ok(Some(Ok(WsMessage::Ping(p)))) => {
                let _ = ws.send(WsMessage::Pong(p)).await;
            }
            Ok(Some(Ok(WsMessage::Binary(bin)))) => {
                let rf = match RelayFrame::decode(&bin) {
                    Ok(f) => f,
                    Err(_) => continue,
                };
                match rf.flags {
                    RelayFlags::Ping => {
                        let pong = RelayFrame {
                            flags: RelayFlags::Pong,
                            src: temp_node_id.clone(),
                            dst: rf.src,
                            payload: rf.payload,
                        };
                        if let Ok(b) = pong.encode() {
                            let _ = ws.send(WsMessage::Binary(b.into())).await;
                        }
                    }
                    RelayFlags::Pong => {}
                    RelayFlags::ErrOffline => {
                        saw_offline = true;
                        let retry_sleep = Duration::from_millis(1500);
                        if tokio::time::Instant::now() + retry_sleep < deadline {
                            tokio::time::sleep(retry_sleep).await;
                            let _ = ws.send(WsMessage::Binary(wire.clone().into())).await;
                        }
                    }
                    RelayFlags::ErrSpoofed | RelayFlags::ErrRate => {
                        let _ = ws.close(None).await;
                        return Err(format!(
                            "relay rejected bootstrap_exchange frame with {:?}",
                            rf.flags
                        ));
                    }
                    RelayFlags::Data => {
                        let msg = match open_device_message(
                            &e2e_key,
                            &payload.cluster_id,
                            &rf.src,
                            &temp_node_id,
                            &rf.payload,
                        ) {
                            Ok(m) => m,
                            Err(e) => {
                                eprintln!("[enroll] ignoring unauthenticated E2E frame from '{}': {e}", rf.src);
                                continue;
                            }
                        };
                        if msg.kind != "enroll_ack" || msg.req_id != req_id {
                            continue;
                        }
                        let _ = ws.close(None).await;
                        let ok = msg.body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                        if !ok {
                            let reason = msg
                                .body
                                .get("error")
                                .and_then(|v| v.as_str())
                                .unwrap_or("enrollment rejected by Master Neo");
                            return Err(format!("Master Neo rejected enrollment: {reason}"));
                        }
                        if let Some(ack_cid) = msg.body.get("cluster_id").and_then(|v| v.as_str()) {
                            if ack_cid != payload.cluster_id {
                                return Err(format!(
                                    "enroll_ack cluster_id mismatch: got '{ack_cid}', expected '{}'",
                                    payload.cluster_id
                                ));
                            }
                        }
                        if let Some(ack_eid) = msg.body.get("enroll_id").and_then(|v| v.as_str()) {
                            if ack_eid != payload.enroll_id {
                                return Err(format!(
                                    "enroll_ack enroll_id mismatch: got '{ack_eid}', expected '{}'",
                                    payload.enroll_id
                                ));
                            }
                        }
                        let final_device_id = msg
                            .body
                            .get("device_id")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .ok_or("enroll_ack missing non-empty device_id")?
                            .to_string();
                        let final_token = msg
                            .body
                            .get("relay_token")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .ok_or("enroll_ack missing non-empty relay_token")?
                            .to_string();
                        return Ok((final_device_id, final_token));
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
        }
    }
}

fn validate_env_value(name: &str, val: &str) -> Result<(), String> {
    if val.contains('\n') || val.contains('\r') || val.contains('\0') {
        return Err(format!(
            "refusing to write control/newline character in env var {name}"
        ));
    }
    Ok(())
}

fn build_extra_args(bridge: Option<&EnrollRelayBridge>) -> Result<String, String> {
    let mut parts = Vec::new();
    if let Some(b) = bridge {
        if b.enabled {
            parts.push("--relay".to_string());
            if let Some(ref bind) = b.mqtt_bind {
                let trimmed = bind.trim();
                if !trimmed.is_empty() {
                    validate_env_value("mqtt_bind", trimmed)?;
                    parts.push("--mqtt-bind".to_string());
                    parts.push(trimmed.to_string());
                }
            }
            if let Some(ref uart) = b.uart_device {
                let trimmed = uart.trim();
                if !trimmed.is_empty() {
                    validate_env_value("uart_device", trimmed)?;
                    parts.push("--uart-device".to_string());
                    parts.push(trimmed.to_string());
                }
            }
        }
    }
    Ok(parts.join(" "))
}

fn render_env_file(
    cluster_id: &str,
    device_id: &str,
    master_id: &str,
    relay_url: &str,
    relay_token: &str,
    e2e_key: &str,
    enroll_id: &str,
    ota_cache_dir: &Path,
    extra_args: &str,
    cuda_devices: Option<&str>,
) -> Result<String, String> {
    let ota_str = ota_cache_dir.to_string_lossy();
    validate_env_value("NEO_CLUSTER_ID", cluster_id)?;
    validate_env_value("NEO_DEVICE_ID", device_id)?;
    validate_env_value("NEO_MASTER_ID", master_id)?;
    validate_env_value("NEO_RELAY_URL", relay_url)?;
    validate_env_value("NEO_TOKEN", relay_token)?;
    validate_env_value("NEO_E2E_KEY", e2e_key)?;
    validate_env_value("NEO_ENROLL_ID", enroll_id)?;
    validate_env_value("NEO_OTA_CACHE_DIR", &ota_str)?;
    validate_env_value("NEO_EXTRA_ARGS", extra_args)?;

    let mut out = String::new();
    out.push_str(&format!(
        "# Auto-generated by neo-agent-os enroll for cluster {cluster_id}\n"
    ));
    out.push_str(&format!("NEO_CLUSTER_ID={cluster_id}\n"));
    out.push_str(&format!("NEO_DEVICE_ID={device_id}\n"));
    out.push_str(&format!("NEO_MASTER_ID={master_id}\n"));
    out.push_str(&format!("NEO_RELAY_URL={relay_url}\n"));
    out.push_str(&format!("NEO_TOKEN={relay_token}\n"));
    out.push_str(&format!("NEO_RELAY_TOKEN={relay_token}\n"));
    out.push_str(&format!("NEO_E2E_KEY={e2e_key}\n"));
    out.push_str(&format!("NEO_ENROLL_ID={enroll_id}\n"));
    out.push_str(&format!("NEO_OTA_CACHE_DIR={ota_str}\n"));
    out.push_str(&format!("NEO_EXTRA_ARGS={extra_args}\n"));
    if let Some(cuda) = cuda_devices.map(str::trim).filter(|s| !s.is_empty()) {
        validate_env_value("CUDA_VISIBLE_DEVICES", cuda)?;
        out.push_str(&format!("CUDA_VISIBLE_DEVICES={cuda}\n"));
    }
    Ok(out)
}

fn write_policy_file(path: &Path, content: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644));
        }
    }
    std::fs::write(path, content)
        .map_err(|e| format!("failed to write policy file {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o444))
            .map_err(|e| format!("failed to set 0444 on {}: {e}", path.display()))?;
    }
    Ok(())
}

fn write_secret_env_file(path: &Path, content: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("failed to create env file {}: {e}", path.display()))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("failed to write env file {}: {e}", path.display()))?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("failed to set 0600 on {}: {e}", path.display()))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, content)
            .map_err(|e| format!("failed to write env file {}: {e}", path.display()))
    }
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn render_systemd_service_unit(binary_path: &Path) -> String {
    let bin = binary_path.display();
    format!(
        r#"# Layer 3 OS & cgroup v2 isolated multi-instance unit for neo-agent-os.
# Auto-installed by neo-agent-os enroll.

[Unit]
Description=Neo Tier 1 OS Agent (cluster %i)
After=network-online.target
Wants=network-online.target
PartOf=neo-agent-slice@%i.slice

[Service]
Type=simple
User=neo-%i
Group=neo-%i
Slice=neo-agent-slice@%i.slice
WorkingDirectory=/home/neo-%i/work

EnvironmentFile=/etc/neo-agent/cluster-%i.env

# Secrets (NEO_TOKEN / NEO_RELAY_TOKEN, NEO_E2E_KEY) are loaded from EnvironmentFile,
# never passed on argv (no ps aux secret exposure).
ExecStart={bin} \
  --cluster ${{NEO_CLUSTER_ID}} \
  --device-id ${{NEO_DEVICE_ID}} \
  --relay-url ${{NEO_RELAY_URL}} \
  --master-id ${{NEO_MASTER_ID}} \
  --policy /etc/neo-agent/policy-%i.toml \
  --ota-cache-dir /var/lib/neo-agent/%i/ota \
  $NEO_EXTRA_ARGS

Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=30

MemoryAccounting=true
MemoryMax=4G
CPUAccounting=true
CPUQuota=200%
OOMScoreAdjust=-500

NoNewPrivileges=true
ProtectSystem=strict
ReadOnlyPaths=/etc/neo-agent/policy-%i.toml
ReadWritePaths=/home/neo-%i/work /var/lib/neo-agent/%i
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
"#
    )
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn render_systemd_slice_unit() -> &'static str {
    r#"# Layer 3 cgroup v2 isolation slice template for Neo multi-master OS agents.

[Unit]
Description=Neo Multi-Master Isolation Slice (%i)
Before=slices.target

[Slice]
MemoryAccounting=true
MemoryHigh=6G
MemoryMax=8G

CPUAccounting=true
CPUQuota=400%

TasksAccounting=true
TasksMax=512

IOAccounting=true
"#
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn render_systemd_isolation_dropin(
    cluster_id: &str,
    workspace_dir: &Path,
    env_path: &Path,
    policy_path: &Path,
    ota_parent: &Path,
    limits: Option<&EnrollLimits>,
) -> String {
    let mut out = String::new();
    out.push_str("[Service]\n");
    out.push_str(&format!("User=neo-{cluster_id}\n"));
    out.push_str(&format!("Group=neo-{cluster_id}\n"));
    out.push_str(&format!("WorkingDirectory={}\n", workspace_dir.display()));
    out.push_str(&format!("EnvironmentFile={}\n", env_path.display()));
    out.push_str("OOMScoreAdjust=-500\n");
    out.push_str(&format!("ReadOnlyPaths={}\n", policy_path.display()));
    out.push_str(&format!(
        "ReadWritePaths={} {}\n",
        workspace_dir.display(),
        ota_parent.display()
    ));
    if let Some(lim) = limits {
        if let Some(ref mem) = lim.memory_max {
            if !mem.trim().is_empty() {
                out.push_str(&format!("MemoryMax={}\n", mem.trim()));
            }
        }
        if let Some(ref cpu) = lim.cpu_quota {
            if !cpu.trim().is_empty() {
                out.push_str(&format!("CPUQuota={}\n", cpu.trim()));
            }
        }
        if let Some(ref cuda) = lim.cuda_devices {
            if !cuda.trim().is_empty() {
                out.push_str(&format!(
                    "Environment=\"CUDA_VISIBLE_DEVICES={}\"\n",
                    cuda.trim()
                ));
            }
        }
    }
    out
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn render_user_systemd_unit(
    cluster_id: &str,
    exe_path: &Path,
    workspace_dir: &Path,
    env_path: &Path,
    policy_path: &Path,
    ota_cache_dir: &Path,
) -> String {
    format!(
        r#"[Unit]
Description=Neo Tier 1 OS Agent (user cluster {cluster_id})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={}
EnvironmentFile={}
ExecStart={} --env-file {} --policy {} --ota-cache-dir {}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"#,
        workspace_dir.display(),
        env_path.display(),
        exe_path.display(),
        env_path.display(),
        policy_path.display(),
        ota_cache_dir.display(),
    )
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn encode_utf16le_bom(text: &str) -> Vec<u8> {
    let crlf = text.replace("\r\n", "\n").replace('\n', "\r\n");
    let mut out = Vec::with_capacity(2 + crlf.len() * 2);
    out.push(0xFF);
    out.push(0xFE);
    for unit in crlf.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn render_windows_task_xml(
    cluster_id: &str,
    command_path: &Path,
    arguments: &str,
    workspace_dir: &Path,
    user_id: Option<&str>,
) -> String {
    let user_xml = match user_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(uid) => format!("\n      <UserId>{}</UserId>", xml_escape(uid)),
        None => String::new(),
    };
    let principal_user_xml = match user_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(uid) => format!("\n      <UserId>{}</UserId>", xml_escape(uid)),
        None => String::new(),
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Neo Tier 1 OS Agent (cluster {cluster})</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>{user_xml}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">{principal_user_xml}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
      <WorkingDirectory>{workdir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"#,
        cluster = xml_escape(cluster_id),
        user_xml = user_xml,
        principal_user_xml = principal_user_xml,
        command = xml_escape(&command_path.to_string_lossy()),
        arguments = xml_escape(arguments),
        workdir = xml_escape(&workspace_dir.to_string_lossy()),
    )
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn windows_bg_launcher_path(exe_path: &Path) -> PathBuf {
    exe_path
        .parent()
        .map(|d| d.join("neo-agent-os-bg.exe"))
        .unwrap_or_else(|| PathBuf::from("neo-agent-os-bg.exe"))
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn render_windows_cmd_wrapper(
    exe_path: &Path,
    env_path: &Path,
    policy_path: &Path,
    ota_cache_dir: &Path,
) -> String {
    format!(
        "@echo off\r\n\"{}\" --env-file \"{}\" --policy \"{}\" --ota-cache-dir \"{}\"\r\n",
        exe_path.display(),
        env_path.display(),
        policy_path.display(),
        ota_cache_dir.display()
    )
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn render_windows_vbs_launcher(
    exe_path: &Path,
    workspace_dir: &Path,
    env_path: &Path,
    policy_path: &Path,
    ota_cache_dir: &Path,
) -> String {
    let esc = |p: &Path| p.to_string_lossy().replace('"', "\"\"");
    format!(
        "Dim sh\r\nSet sh = CreateObject(\"WScript.Shell\")\r\nsh.CurrentDirectory = \"{}\"\r\nsh.Run \"\"\"{}\"\" --env-file \"\"{}\"\" --policy \"\"{}\"\" --ota-cache-dir \"\"{}\"\"\", 0, False\r\n",
        esc(workspace_dir),
        esc(exe_path),
        esc(env_path),
        esc(policy_path),
        esc(ota_cache_dir)
    )
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn render_macos_plist(
    cluster_id: &str,
    exe_path: &Path,
    workspace_dir: &Path,
    env_path: &Path,
    policy_path: &Path,
    ota_cache_dir: &Path,
    log_dir: &Path,
) -> String {
    let label = format!("cn.1inch.neo.agent.{cluster_id}");
    let stdout_log = log_dir.join("stdout.log");
    let stderr_log = log_dir.join("stderr.log");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>--env-file</string>
    <string>{}</string>
    <string>--policy</string>
    <string>{}</string>
    <string>--ota-cache-dir</string>
    <string>{}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{}</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{}</string>
  <key>StandardErrorPath</key>
  <string>{}</string>
</dict>
</plist>
"#,
        xml_escape(&label),
        xml_escape(&exe_path.to_string_lossy()),
        xml_escape(&env_path.to_string_lossy()),
        xml_escape(&policy_path.to_string_lossy()),
        xml_escape(&ota_cache_dir.to_string_lossy()),
        xml_escape(&workspace_dir.to_string_lossy()),
        xml_escape(&stdout_log.to_string_lossy()),
        xml_escape(&stderr_log.to_string_lossy()),
    )
}

#[cfg(target_os = "linux")]
fn run_cmd_checked(program: &str, args: &[&str]) -> Result<(), String> {
    let out = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run {program}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{program} {} exited with {}: {}",
            args.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn install_service_linux_system(
    cluster_id: &str,
    workspace_dir: &Path,
    env_path: &Path,
    policy_path: &Path,
    ota_cache_dir: &Path,
    limits: Option<&EnrollLimits>,
) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;

    let os_user = format!("neo-{cluster_id}");
    let user_exists = std::process::Command::new("id")
        .args(["-u", &os_user])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !user_exists {
        let nologin = if Path::new("/usr/sbin/nologin").exists() {
            "/usr/sbin/nologin"
        } else if Path::new("/sbin/nologin").exists() {
            "/sbin/nologin"
        } else {
            "/bin/false"
        };
        let home_dir = format!("/home/{os_user}");
        run_cmd_checked(
            "useradd",
            &[
                "--system",
                "--create-home",
                "--home-dir",
                &home_dir,
                "--shell",
                nologin,
                &os_user,
            ],
        )?;
    }

    // Ensure binary is accessible at /usr/local/bin/neo-agent-os
    let target_bin = PathBuf::from("/usr/local/bin/neo-agent-os");
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("failed to resolve current_exe: {e}"))?;
    let bin_for_unit = if current_exe == target_bin {
        target_bin
    } else {
        if let Some(parent) = target_bin.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::copy(&current_exe, &target_bin).map_err(|e| {
            format!(
                "failed to install neo-agent-os binary to {}: {e}",
                target_bin.display()
            )
        })?;
        let _ = std::fs::set_permissions(&target_bin, std::fs::Permissions::from_mode(0o755));
        target_bin
    };

    let ota_parent = ota_cache_dir.parent().unwrap_or(ota_cache_dir);
    std::fs::create_dir_all(workspace_dir)
        .map_err(|e| format!("failed to create workspace {}: {e}", workspace_dir.display()))?;
    std::fs::create_dir_all(ota_cache_dir)
        .map_err(|e| format!("failed to create OTA dir {}: {e}", ota_cache_dir.display()))?;

    let owner_spec = format!("{os_user}:{os_user}");
    run_cmd_checked("chown", &["-R", &owner_spec, &workspace_dir.to_string_lossy()])?;
    let _ = std::fs::set_permissions(workspace_dir, std::fs::Permissions::from_mode(0o750));
    run_cmd_checked("chown", &["-R", &owner_spec, &ota_parent.to_string_lossy()])?;
    let _ = std::fs::set_permissions(ota_parent, std::fs::Permissions::from_mode(0o750));
    run_cmd_checked("chown", &[&owner_spec, &env_path.to_string_lossy()])?;
    let _ = std::fs::set_permissions(env_path, std::fs::Permissions::from_mode(0o600));
    run_cmd_checked("chown", &["root:root", &policy_path.to_string_lossy()])?;
    let _ = std::fs::set_permissions(policy_path, std::fs::Permissions::from_mode(0o444));

    let systemd_dir = Path::new("/etc/systemd/system");
    std::fs::write(
        systemd_dir.join("neo-agent-os@.service"),
        render_systemd_service_unit(&bin_for_unit),
    )
    .map_err(|e| format!("failed to write neo-agent-os@.service: {e}"))?;
    std::fs::write(
        systemd_dir.join("neo-agent-slice@.slice"),
        render_systemd_slice_unit(),
    )
    .map_err(|e| format!("failed to write neo-agent-slice@.slice: {e}"))?;

    let dropin_dir = systemd_dir.join(format!("neo-agent-os@{cluster_id}.service.d"));
    std::fs::create_dir_all(&dropin_dir)
        .map_err(|e| format!("failed to create systemd drop-in dir: {e}"))?;
    std::fs::write(
        dropin_dir.join("10-isolation.conf"),
        render_systemd_isolation_dropin(
            cluster_id,
            workspace_dir,
            env_path,
            policy_path,
            ota_parent,
            limits,
        ),
    )
    .map_err(|e| format!("failed to write 10-isolation.conf: {e}"))?;

    if let Some(lim) = limits {
        if lim.memory_max.as_deref().is_some_and(|s| !s.trim().is_empty())
            || lim.cpu_quota.as_deref().is_some_and(|s| !s.trim().is_empty())
        {
            let slice_dropin_dir = systemd_dir.join(format!("neo-agent-slice@{cluster_id}.slice.d"));
            std::fs::create_dir_all(&slice_dropin_dir)
                .map_err(|e| format!("failed to create slice drop-in dir: {e}"))?;
            let mut slice_conf = String::from("[Slice]\n");
            if let Some(ref m) = lim.memory_max {
                if !m.trim().is_empty() {
                    slice_conf.push_str(&format!("MemoryMax={}\n", m.trim()));
                }
            }
            if let Some(ref c) = lim.cpu_quota {
                if !c.trim().is_empty() {
                    slice_conf.push_str(&format!("CPUQuota={}\n", c.trim()));
                }
            }
            std::fs::write(slice_dropin_dir.join("10-limits.conf"), slice_conf)
                .map_err(|e| format!("failed to write slice 10-limits.conf: {e}"))?;
        }
    }

    let unit_name = format!("neo-agent-os@{cluster_id}.service");
    run_cmd_checked("systemctl", &["daemon-reload"])?;
    run_cmd_checked("systemctl", &["enable", "--now", &unit_name])?;
    Ok(format!("systemd system service enabled & started ({unit_name})"))
}

#[cfg(target_os = "linux")]
fn install_service_linux_user(
    cluster_id: &str,
    config_dir: &Path,
    workspace_dir: &Path,
    env_path: &Path,
    policy_path: &Path,
    ota_cache_dir: &Path,
) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("failed to resolve current_exe: {e}"))?;
    let home = user_home_dir()?;
    let user_unit_dir = home.join(".config").join("systemd").join("user");
    std::fs::create_dir_all(&user_unit_dir)
        .map_err(|e| format!("failed to create {}: {e}", user_unit_dir.display()))?;
    let unit_name = format!("neo-agent-os-{cluster_id}.service");
    let unit_path = user_unit_dir.join(&unit_name);
    std::fs::write(
        &unit_path,
        render_user_systemd_unit(
            cluster_id,
            &exe_path,
            workspace_dir,
            env_path,
            policy_path,
            ota_cache_dir,
        ),
    )
    .map_err(|e| format!("failed to write {}: {e}", unit_path.display()))?;

    let reload_ok = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let enable_ok = reload_ok
        && std::process::Command::new("systemctl")
            .args(["--user", "enable", "--now", &unit_name])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

    if enable_ok {
        return Ok(format!("systemd user service enabled & started ({unit_name})"));
    }

    // Fallback when systemd user bus is unavailable (e.g. containers, headless SSH without linger):
    // write start.sh and immediately spawn a detached silent background daemon with log & PID files.
    let cluster_dir = config_dir.join(cluster_id);
    let log_dir = cluster_dir.join("logs");
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("failed to create {}: {e}", log_dir.display()))?;
    let start_sh = cluster_dir.join("start.sh");
    let script = format!(
        "#!/usr/bin/env sh\nexec '{}' --env-file '{}' --policy '{}' --ota-cache-dir '{}'\n",
        exe_path.display().to_string().replace('\'', "'\\''"),
        env_path.display().to_string().replace('\'', "'\\''"),
        policy_path.display().to_string().replace('\'', "'\\''"),
        ota_cache_dir.display().to_string().replace('\'', "'\\''"),
    );
    std::fs::write(&start_sh, script)
        .map_err(|e| format!("failed to write {}: {e}", start_sh.display()))?;
    let _ = std::fs::set_permissions(&start_sh, std::fs::Permissions::from_mode(0o700));

    let log_file = log_dir.join("agent.log");
    let pid_file = cluster_dir.join("agent.pid");
    if let Ok(old_pid_str) = std::fs::read_to_string(&pid_file) {
        if let Ok(old_pid) = old_pid_str.trim().parse::<i32>() {
            if old_pid > 1 {
                unsafe {
                    let _ = libc::kill(old_pid, libc::SIGTERM);
                }
            }
        }
    }
    let out_fd = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .ok();
    let err_fd = out_fd.as_ref().and_then(|f| f.try_clone().ok());
    let mut bg = std::process::Command::new(&exe_path);
    bg.args([
        "--env-file",
        env_path.to_string_lossy().as_ref(),
        "--policy",
        policy_path.to_string_lossy().as_ref(),
        "--ota-cache-dir",
        ota_cache_dir.to_string_lossy().as_ref(),
    ])
    .current_dir(workspace_dir)
    .stdin(std::process::Stdio::null())
    .stdout(out_fd.map(std::process::Stdio::from).unwrap_or_else(std::process::Stdio::null))
    .stderr(err_fd.map(std::process::Stdio::from).unwrap_or_else(std::process::Stdio::null));
    unsafe {
        use std::os::unix::process::CommandExt;
        bg.pre_exec(|| {
            let _ = libc::setsid();
            Ok(())
        });
    }
    if let Ok(child) = bg.spawn() {
        let _ = std::fs::write(&pid_file, format!("{}\n", child.id()));
        return Ok(format!(
            "background daemon started silently (pid={}, log={})",
            child.id(),
            log_file.display()
        ));
    }

    eprintln!(
        "[enroll] notice: systemd --user bus is unavailable; wrote fallback launcher at {}",
        start_sh.display()
    );
    Ok(format!(
        "systemd --user unavailable; wrote fallback launcher ({})",
        start_sh.display()
    ))
}

#[cfg(target_os = "macos")]
fn install_service_macos(
    cluster_id: &str,
    config_dir: &Path,
    workspace_dir: &Path,
    env_path: &Path,
    policy_path: &Path,
    ota_cache_dir: &Path,
) -> Result<String, String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("failed to resolve current_exe: {e}"))?;
    let home = user_home_dir()?;
    let agents_dir = home.join("Library").join("LaunchAgents");
    std::fs::create_dir_all(&agents_dir)
        .map_err(|e| format!("failed to create {}: {e}", agents_dir.display()))?;
    let log_dir = config_dir.join(cluster_id).join("logs");
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("failed to create {}: {e}", log_dir.display()))?;

    let label = format!("cn.1inch.neo.agent.{cluster_id}");
    let plist_path = agents_dir.join(format!("{label}.plist"));
    let plist_xml = render_macos_plist(
        cluster_id,
        &exe_path,
        workspace_dir,
        env_path,
        policy_path,
        ota_cache_dir,
        &log_dir,
    );
    std::fs::write(&plist_path, plist_xml)
        .map_err(|e| format!("failed to write {}: {e}", plist_path.display()))?;

    let uid = unsafe { libc::geteuid() };
    let domain = format!("gui/{uid}");
    let service_target = format!("{domain}/{label}");
    let plist_str = plist_path.to_string_lossy().to_string();

    // Unload any prior instance cleanly before bootstrap
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", &service_target])
        .output();

    let boot_ok = std::process::Command::new("launchctl")
        .args(["bootstrap", &domain, &plist_str])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !boot_ok {
        let load_out = std::process::Command::new("launchctl")
            .args(["load", "-w", &plist_str])
            .output()
            .map_err(|e| format!("failed to run launchctl load: {e}"))?;
        if !load_out.status.success() {
            return Err(format!(
                "launchctl load failed: {}",
                String::from_utf8_lossy(&load_out.stderr).trim()
            ));
        }
    }

    Ok(format!("launchd LaunchAgent loaded ({})", plist_path.display()))
}

#[cfg(target_os = "windows")]
fn spawn_windows_detached(
    exe_path: &Path,
    bg_launcher: Option<&Path>,
    workspace_dir: &Path,
    env_path: &Path,
    policy_path: &Path,
    ota_cache_dir: &Path,
    log_file: &Path,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    if let Some(bg_exe) = bg_launcher {
        std::process::Command::new(bg_exe)
            .args([
                "--log-file",
                log_file.to_string_lossy().as_ref(),
                "--env-file",
                env_path.to_string_lossy().as_ref(),
                "--policy",
                policy_path.to_string_lossy().as_ref(),
                "--ota-cache-dir",
                ota_cache_dir.to_string_lossy().as_ref(),
            ])
            .current_dir(workspace_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn()
            .map_err(|e| format!("failed to launch neo-agent-os-bg background process: {e}"))?;
        return Ok(());
    }
    let out_fd = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file)
        .ok();
    let err_fd = out_fd.as_ref().and_then(|f| f.try_clone().ok());
    std::process::Command::new(exe_path)
        .args([
            "--env-file",
            env_path.to_string_lossy().as_ref(),
            "--policy",
            policy_path.to_string_lossy().as_ref(),
            "--ota-cache-dir",
            ota_cache_dir.to_string_lossy().as_ref(),
        ])
        .current_dir(workspace_dir)
        .stdin(std::process::Stdio::null())
        .stdout(out_fd.map(std::process::Stdio::from).unwrap_or_else(std::process::Stdio::null))
        .stderr(err_fd.map(std::process::Stdio::from).unwrap_or_else(std::process::Stdio::null))
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|e| format!("failed to launch neo-agent-os background process: {e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_service_windows(
    cluster_id: &str,
    config_dir: &Path,
    workspace_dir: &Path,
    env_path: &Path,
    policy_path: &Path,
    ota_cache_dir: &Path,
) -> Result<String, String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("failed to resolve current_exe: {e}"))?;

    let user_id = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
        (Ok(dom), Ok(usr)) if !dom.trim().is_empty() && !usr.trim().is_empty() => {
            Some(format!("{}\\{}", dom.trim(), usr.trim()))
        }
        (_, Ok(usr)) if !usr.trim().is_empty() => Some(usr.trim().to_string()),
        _ => None,
    };

    // Best-effort ACL restriction on .env file so only current user can read/write it.
    if let Some(ref uid) = user_id {
        let grant = format!("{uid}:(R,W)");
        let _ = std::process::Command::new("icacls")
            .args([
                env_path.to_string_lossy().as_ref(),
                "/inheritance:r",
                "/grant:r",
                &grant,
            ])
            .output();
    }

    let cluster_dir = config_dir.join(cluster_id);
    let log_dir = cluster_dir.join("logs");
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("failed to create {}: {e}", log_dir.display()))?;

    let log_file = log_dir.join("agent.log");
    let task_xml_path = cluster_dir.join("task.xml");
    let run_cmd_path = cluster_dir.join("run.cmd");
    let run_vbs_path = cluster_dir.join("run.vbs");

    std::fs::write(
        &run_cmd_path,
        render_windows_cmd_wrapper(&exe_path, env_path, policy_path, ota_cache_dir),
    )
    .map_err(|e| format!("failed to write {}: {e}", run_cmd_path.display()))?;
    std::fs::write(
        &run_vbs_path,
        render_windows_vbs_launcher(&exe_path, workspace_dir, env_path, policy_path, ota_cache_dir),
    )
    .map_err(|e| format!("failed to write {}: {e}", run_vbs_path.display()))?;

    // NEVER run the console-subsystem neo-agent-os.exe directly from Task Scheduler,
    // which would open a visible black console window on the user's desktop.
    // Prefer the GUI-subsystem neo-agent-os-bg.exe launcher (zero console, zero flash,
    // Job Object cleanup); fall back to wscript.exe //B //Nologo <run.vbs>.
    let bg_candidate = windows_bg_launcher_path(&exe_path);
    let bg_launcher = if bg_candidate.is_file() {
        Some(bg_candidate)
    } else {
        None
    };

    let (xml_cmd_path, xml_args) = match bg_launcher.as_deref() {
        Some(bg_exe) => (
            bg_exe.to_path_buf(),
            format!(
                "--log-file \"{}\" --env-file \"{}\" --policy \"{}\" --ota-cache-dir \"{}\"",
                log_file.display(),
                env_path.display(),
                policy_path.display(),
                ota_cache_dir.display()
            ),
        ),
        None => (
            PathBuf::from("wscript.exe"),
            format!("//B //Nologo \"{}\"", run_vbs_path.display()),
        ),
    };

    let task_xml = render_windows_task_xml(
        cluster_id,
        &xml_cmd_path,
        &xml_args,
        workspace_dir,
        user_id.as_deref(),
    );
    std::fs::write(&task_xml_path, encode_utf16le_bom(&task_xml))
        .map_err(|e| format!("failed to write {}: {e}", task_xml_path.display()))?;

    let task_name = format!("NeoAgent-{cluster_id}");

    // Stop any previously running task instance cleanly before re-registering.
    let _ = std::process::Command::new("schtasks")
        .args(["/End", "/TN", &task_name])
        .output();

    // Primary: Task Scheduler XML import using headless GUI-subsystem launcher
    // (no 261-char /TR limit, zero visible console window, works for non-admin per-user
    // LogonTrigger, disables 72h timeout & battery stop, RestartOnFailure enabled).
    let xml_out = std::process::Command::new("schtasks")
        .args([
            "/Create",
            "/F",
            "/TN",
            &task_name,
            "/XML",
            task_xml_path.to_string_lossy().as_ref(),
        ])
        .output();

    if let Ok(ref out) = xml_out {
        if out.status.success() {
            let started = std::process::Command::new("schtasks")
                .args(["/Run", "/TN", &task_name])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !started {
                spawn_windows_detached(
                    &exe_path,
                    bg_launcher.as_deref(),
                    workspace_dir,
                    env_path,
                    policy_path,
                    ota_cache_dir,
                    &log_file,
                )?;
            }
            return Ok(format!(
                "Windows Scheduled Task registered (silent headless background, {task_name})"
            ));
        }
    }

    // Fallback 1: short silent VBS wrapper via /TR (guaranteed << 261 chars, zero console window).
    let short_tr = format!("wscript.exe //B //Nologo \"{}\"", run_vbs_path.display());
    if short_tr.len() <= 260 {
        let tr_out = std::process::Command::new("schtasks")
            .args([
                "/Create",
                "/F",
                "/SC",
                "ONLOGON",
                "/TN",
                &task_name,
                "/TR",
                &short_tr,
            ])
            .output();
        if let Ok(ref out) = tr_out {
            if out.status.success() {
                let started = std::process::Command::new("schtasks")
                    .args(["/Run", "/TN", &task_name])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if !started {
                    spawn_windows_detached(
                        &exe_path,
                        bg_launcher.as_deref(),
                        workspace_dir,
                        env_path,
                        policy_path,
                        ota_cache_dir,
                        &log_file,
                    )?;
                }
                return Ok(format!(
                    "Windows Scheduled Task registered via silent launcher ({task_name})"
                ));
            }
        }
    }

    // Fallback 2: HKCU Run registry key (works without admin rights or Task Scheduler GPO)
    // plus immediate detached headless background launch.
    let reg_cmd = match bg_launcher.as_deref() {
        Some(bg_exe) => format!("\"{}\" {}", bg_exe.display(), xml_args),
        None => short_tr,
    };
    let reg_out = std::process::Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            &task_name,
            "/t",
            "REG_SZ",
            "/d",
            &reg_cmd,
            "/f",
        ])
        .output()
        .map_err(|e| format!("failed to register HKCU startup entry: {e}"))?;
    if !reg_out.status.success() {
        let xml_err = xml_out
            .as_ref()
            .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string())
            .unwrap_or_default();
        return Err(format!(
            "failed to register Windows autostart (schtasks XML: {xml_err}; reg add exited with {})",
            reg_out.status
        ));
    }

    spawn_windows_detached(
        &exe_path,
        bg_launcher.as_deref(),
        workspace_dir,
        env_path,
        policy_path,
        ota_cache_dir,
        &log_file,
    )?;
    Ok(format!(
        "Windows silent background startup registered (HKCU Run: {task_name})"
    ))
}

fn install_os_service(
    mode: EffectiveMode,
    cluster_id: &str,
    config_dir: &Path,
    workspace_dir: &Path,
    env_path: &Path,
    policy_path: &Path,
    ota_cache_dir: &Path,
    limits: Option<&EnrollLimits>,
) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        match mode {
            EffectiveMode::System => install_service_linux_system(
                cluster_id,
                workspace_dir,
                env_path,
                policy_path,
                ota_cache_dir,
                limits,
            ),
            EffectiveMode::User => install_service_linux_user(
                cluster_id,
                config_dir,
                workspace_dir,
                env_path,
                policy_path,
                ota_cache_dir,
            ),
            EffectiveMode::Foreground => Ok("foreground mode (no service installed)".to_string()),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = limits;
        match mode {
            EffectiveMode::Foreground => Ok("foreground mode (no service installed)".to_string()),
            EffectiveMode::System | EffectiveMode::User => install_service_macos(
                cluster_id,
                config_dir,
                workspace_dir,
                env_path,
                policy_path,
                ota_cache_dir,
            ),
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = limits;
        match mode {
            EffectiveMode::Foreground => Ok("foreground mode (no service installed)".to_string()),
            EffectiveMode::System | EffectiveMode::User => install_service_windows(
                cluster_id,
                config_dir,
                workspace_dir,
                env_path,
                policy_path,
                ota_cache_dir,
            ),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (
            mode,
            cluster_id,
            config_dir,
            workspace_dir,
            env_path,
            policy_path,
            ota_cache_dir,
            limits,
        );
        Ok("service installation unsupported on this OS".to_string())
    }
}

pub async fn run_enroll(args: EnrollArgs) -> Result<EnrollOutcome, String> {
    let raw_ticket = resolve_ticket_raw(&args)?;
    let ticket = parse_ticket(&raw_ticket)?;
    let claim_url = build_claim_url(
        args.relay_url.as_deref(),
        args.claim_url.as_deref(),
        &ticket.ticket_id,
    )?;

    let claim = claim_ticket(&claim_url, &ticket.ticket_id).await?;
    let payload = decrypt_enroll_payload(&ticket, &claim.ciphertext_b64)?;
    validate_payload_expiry(payload.expires_at, now_unix_secs())?;

    let mode = resolve_effective_mode(args.mode, payload.install_mode.as_deref());

    let (final_device_id, final_relay_token) = match payload.auth_mode.as_str() {
        "direct" => {
            if payload.device_id.trim().is_empty() {
                return Err("EnrollPayload auth_mode=direct requires non-empty device_id".to_string());
            }
            (payload.device_id.clone(), payload.relay_token.clone())
        }
        "bootstrap_exchange" => perform_bootstrap_exchange(&ticket, &payload, mode).await?,
        other => return Err(format!("unsupported EnrollPayload auth_mode: '{other}'")),
    };

    let custom_config_dir = args.config_dir.is_some();
    let config_dir = match args.config_dir {
        Some(dir) => dir,
        None => default_config_dir(mode)?,
    };
    let workspace_dir = match payload
        .workspace_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(ws) => PathBuf::from(ws),
        None => default_workspace_dir(&payload.cluster_id, mode)?,
    };
    let ota_cache_dir = default_ota_cache_dir(
        &payload.cluster_id,
        &config_dir,
        custom_config_dir,
        mode,
    );

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("failed to create config dir {}: {e}", config_dir.display()))?;
    std::fs::create_dir_all(&workspace_dir)
        .map_err(|e| format!("failed to create workspace dir {}: {e}", workspace_dir.display()))?;
    std::fs::create_dir_all(&ota_cache_dir)
        .map_err(|e| format!("failed to create OTA cache dir {}: {e}", ota_cache_dir.display()))?;

    let rendered_policy = render_policy_toml(&payload.policy_toml, &workspace_dir);
    // Pre-create any allowed_workspaces declared in policy_toml so canonicalization succeeds.
    if let Ok(parsed_cfg) = toml::from_str::<PolicyConfig>(&rendered_policy) {
        for ws in &parsed_cfg.allowed_workspaces {
            if !ws.is_empty() && !ws.contains('\0') {
                let p = Path::new(ws);
                if !p.exists() {
                    let _ = std::fs::create_dir_all(p);
                }
            }
        }
    }

    let policy_path = config_dir.join(format!("policy-{}.toml", payload.cluster_id));
    let env_path = config_dir.join(format!("cluster-{}.env", payload.cluster_id));
    write_policy_file(&policy_path, &rendered_policy)?;

    let extra_args = build_extra_args(payload.relay_bridge.as_ref())?;
    let cuda_devices = payload
        .limits
        .as_ref()
        .and_then(|l| l.cuda_devices.as_deref());
    let env_content = render_env_file(
        &payload.cluster_id,
        &final_device_id,
        &payload.master_id,
        &payload.relay_url,
        &final_relay_token,
        &payload.e2e_key,
        &payload.enroll_id,
        &ota_cache_dir,
        &extra_args,
        cuda_devices,
    )?;
    write_secret_env_file(&env_path, &env_content)?;

    let policy = Arc::new(Policy::from_file(&policy_path)?);
    let bridge = payload.relay_bridge.as_ref();
    let relay_enabled = bridge.map(|b| b.enabled).unwrap_or(false);
    let mqtt_bind = bridge
        .and_then(|b| b.mqtt_bind.clone())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1:1883".to_string());
    let uart_device = bridge
        .and_then(|b| b.uart_device.clone())
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from);
    let updater_state_path = Some(ota_cache_dir.join("updater-state.json"));

    let cfg = AgentConfig {
        cluster_id: payload.cluster_id.clone(),
        device_id: final_device_id.clone(),
        master_id: payload.master_id.clone(),
        relay_url: payload.relay_url.clone(),
        token: final_relay_token,
        e2e_secret: payload.e2e_key.clone(),
        enroll_id: Some(payload.enroll_id.clone()),
        relay_enabled,
        mqtt_bind,
        uart_device,
        ota_cache_dir: Some(ota_cache_dir.clone()),
        updater_state_path,
    };

    if mode == EffectiveMode::Foreground {
        let outcome = EnrollOutcome {
            cluster_id: payload.cluster_id,
            device_id: final_device_id,
            enroll_id: payload.enroll_id,
            mode,
            policy_path,
            env_path,
            workspace_dir,
            ota_cache_dir,
            service_status: "running in foreground".to_string(),
        };
        print_enroll_summary(&outcome);
        tokio::select! {
            res = run_agent(cfg, policy) => res?,
            _ = tokio::signal::ctrl_c() => {
                eprintln!("[neo-agent-os] shutdown signal received");
            }
        }
        return Ok(outcome);
    }

    if !args.skip_check {
        run_one_shot_check(&cfg, &policy).await?;
    }

    let service_status = if args.skip_service {
        "skipped (--skip-service)".to_string()
    } else {
        install_os_service(
            mode,
            &payload.cluster_id,
            &config_dir,
            &workspace_dir,
            &env_path,
            &policy_path,
            &ota_cache_dir,
            payload.limits.as_ref(),
        )?
    };

    let outcome = EnrollOutcome {
        cluster_id: payload.cluster_id,
        device_id: final_device_id,
        enroll_id: payload.enroll_id,
        mode,
        policy_path,
        env_path,
        workspace_dir,
        ota_cache_dir,
        service_status,
    };
    print_enroll_summary(&outcome);
    Ok(outcome)
}

fn print_enroll_summary(outcome: &EnrollOutcome) {
    println!("Neo Tier 1 OS agent enrolled:");
    println!("  cluster_id:  {}", outcome.cluster_id);
    println!("  device_id:   {}", outcome.device_id);
    println!("  enroll_id:   {}", outcome.enroll_id);
    println!("  mode:        {}", outcome.mode.as_str());
    println!("  workspace:   {}", outcome.workspace_dir.display());
    println!("  policy:      {}", outcome.policy_path.display());
    println!("  env_file:    {}", outcome.env_path.display());
    println!("  ota_cache:   {}", outcome.ota_cache_dir.display());
    println!("  service:     {}", outcome.service_status);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{derive_cluster_hmac_key, mint_neo1_token};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn sample_payload(relay_url: &str, workspace_override: Option<String>, auth_mode: &str) -> EnrollPayload {
        EnrollPayload {
            v: 1,
            enroll_id: "enr_2026_test01".to_string(),
            cluster_id: "personal".to_string(),
            master_id: "master-personal".to_string(),
            relay_url: relay_url.to_string(),
            device_id: "os-personal-01".to_string(),
            auth_mode: auth_mode.to_string(),
            relay_token: "neo1.placeholder.sig".to_string(),
            e2e_key: "super-secret-e2e-key".to_string(),
            agent_version: Some("0.8.0".to_string()),
            download_mirrors: vec!["https://github.com/example/releases".to_string()],
            install_mode: Some("user".to_string()),
            policy_profile: Some("personal".to_string()),
            policy_toml: r#"
allowed_workspaces = ["{{WORKSPACE_DIR}}"]
allowed_commands = ["echo", "ls"]
denied_commands = ["rm", "sudo"]
max_child_mem_mb = 1024
max_exec_timeout_sec = 60
"#
            .to_string(),
            workspace_override,
            relay_bridge: Some(EnrollRelayBridge {
                enabled: true,
                mqtt_bind: Some("127.0.0.1:1883".to_string()),
                uart_device: None,
            }),
            limits: Some(EnrollLimits {
                memory_max: Some("2G".to_string()),
                cpu_quota: Some("150%".to_string()),
                cuda_devices: Some("0".to_string()),
            }),
            expires_at: now_unix_secs() + 600,
        }
    }

    #[test]
    fn parses_valid_and_rejects_malformed_tickets() {
        let t = parse_ticket("  neo_enr_v1.tkt_abc-123.ephemeralKeyValue99  \n").unwrap();
        assert_eq!(t.ticket_id, "tkt_abc-123");
        assert_eq!(t.ephemeral_key, "ephemeralKeyValue99");

        assert!(parse_ticket("neo_enr_v2.abc.def").is_err());
        assert!(parse_ticket("neo_enr_v1.abc").is_err());
        assert!(parse_ticket("neo_enr_v1.abc.def.extra").is_err());
        assert!(parse_ticket("neo_enr_v1..def").is_err());
        assert!(parse_ticket("neo_enr_v1.bad/id.def").is_err());
        assert!(parse_ticket("neo_enr_v1.abc.").is_err());
    }

    #[test]
    fn aes_gcm_decrypt_roundtrip_and_aad_tamper_rejection() {
        let ticket = parse_ticket("neo_enr_v1.tkt_roundtrip_1.secretKeyMaterialXYZ").unwrap();
        let payload = sample_payload("https://neo.1inch.cn:18443", None, "direct");
        let ct_b64 = seal_enroll_payload(&ticket, &payload).unwrap();

        let raw_wire = STANDARD.decode(&ct_b64).unwrap();
        assert_eq!(raw_wire[0], 0xE2);

        let opened = decrypt_enroll_payload(&ticket, &ct_b64).unwrap();
        assert_eq!(opened, payload);

        // Wrong ticket_id (changes both key & AAD) must fail
        let wrong_id = ParsedTicket {
            ticket_id: "tkt_other".to_string(),
            ephemeral_key: ticket.ephemeral_key.clone(),
        };
        assert!(decrypt_enroll_payload(&wrong_id, &ct_b64).is_err());

        // Same key manually encrypted with wrong AAD must fail authentication
        let key = derive_enroll_key(&ticket.ticket_id, &ticket.ephemeral_key);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let nonce = [9u8; 12];
        let forged_ct = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &serde_json::to_vec(&payload).unwrap(),
                    aad: b"neo-enroll-v1|tampered-aad",
                },
            )
            .unwrap();
        let mut forged_wire = vec![0xE2];
        forged_wire.extend_from_slice(&nonce);
        forged_wire.extend_from_slice(&forged_ct);
        assert!(decrypt_enroll_payload(&ticket, &STANDARD.encode(&forged_wire)).is_err());

        // Wrong envelope version byte (0xE1 instead of 0xE2) must fail
        let mut bad_ver = raw_wire.clone();
        bad_ver[0] = 0xE1;
        assert!(decrypt_enroll_payload(&ticket, &STANDARD.encode(&bad_ver)).is_err());
    }

    #[test]
    fn validates_expiry_with_60s_clock_skew() {
        let now = 1_800_000_000u64;
        assert!(validate_payload_expiry(now + 10, now).is_ok());
        assert!(validate_payload_expiry(now - 59, now).is_ok());
        assert!(validate_payload_expiry(now - 60, now).is_ok());
        assert!(validate_payload_expiry(now - 61, now).is_err());
        assert!(validate_payload_expiry(0, now).is_err());
    }

    #[test]
    fn renders_policy_workspace_placeholder_for_unix_and_windows_paths() {
        let tmpl = "allowed_workspaces = [\"{{WORKSPACE_DIR}}\"]\nallowed_commands = [\"echo\"]\n";
        let unix_rendered = render_policy_toml(tmpl, Path::new("/home/neo-personal/work"));
        assert!(unix_rendered.contains("\"/home/neo-personal/work\""));

        let win_rendered = render_policy_toml(
            tmpl,
            Path::new(r"C:\Users\Alice\AppData\Local\neo-agent\personal\work"),
        );
        let parsed: PolicyConfig = toml::from_str(&win_rendered).unwrap();
        assert_eq!(
            parsed.allowed_workspaces,
            vec![r"C:\Users\Alice\AppData\Local\neo-agent\personal\work"]
        );
    }

    #[test]
    fn renders_hardened_systemd_unit_without_argv_secrets_and_valid_macos_plist() {
        let unit = render_systemd_service_unit(Path::new("/usr/local/bin/neo-agent-os"));
        assert!(!unit.contains("--token"));
        assert!(!unit.contains("--e2e-key"));
        assert!(unit.contains("EnvironmentFile=/etc/neo-agent/cluster-%i.env"));

        let slice = render_systemd_slice_unit();
        assert!(slice.contains("[Slice]"));
        assert!(slice.contains("MemoryAccounting=true"));

        let dropin = render_systemd_isolation_dropin(
            "personal",
            Path::new("/home/neo-personal/work"),
            Path::new("/etc/neo-agent/cluster-personal.env"),
            Path::new("/etc/neo-agent/policy-personal.toml"),
            Path::new("/var/lib/neo-agent/personal"),
            Some(&EnrollLimits {
                memory_max: Some("2G".to_string()),
                cpu_quota: Some("150%".to_string()),
                cuda_devices: Some("0".to_string()),
            }),
        );
        assert!(dropin.contains("MemoryMax=2G"));
        assert!(dropin.contains("CPUQuota=150%"));
        assert!(dropin.contains("CUDA_VISIBLE_DEVICES=0"));

        let user_unit = render_user_systemd_unit(
            "personal",
            Path::new("/home/alice/.local/bin/neo-agent-os"),
            Path::new("/home/alice/neo-work/personal"),
            Path::new("/home/alice/.config/neo-agent/cluster-personal.env"),
            Path::new("/home/alice/.config/neo-agent/policy-personal.toml"),
            Path::new("/home/alice/.config/neo-agent/personal/ota"),
        );
        assert!(user_unit.contains("--env-file"));
        assert!(!user_unit.contains("--token"));

        let plist = render_macos_plist(
            "personal",
            Path::new("/usr/local/bin/neo-agent-os"),
            Path::new("/Users/alice/neo-work/personal"),
            Path::new("/Users/alice/.config/neo-agent/cluster-personal.env"),
            Path::new("/Users/alice/.config/neo-agent/policy-personal.toml"),
            Path::new("/Users/alice/.config/neo-agent/personal/ota"),
            Path::new("/Users/alice/.config/neo-agent/personal/logs"),
        );
        assert!(plist.contains("cn.1inch.neo.agent.personal"));
        assert!(plist.contains("<string>--env-file</string>"));
        assert!(!plist.contains("--token"));
        assert!(!plist.contains("--e2e-key"));
    }

    #[tokio::test]
    async fn mock_http_claim_and_skip_service_direct_enrollment_flow() {
        let tmp = std::env::temp_dir().join(format!(
            "neo_enroll_direct_{}_{}",
            std::process::id(),
            now_ms()
        ));
        let cfg_dir = tmp.join("cfg");
        let ws_dir = tmp.join("work");
        std::fs::create_dir_all(&tmp).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let relay_url = format!("http://{addr}");

        let ticket = parse_ticket("neo_enr_v1.tkt_direct_01.ephemeralSecretDirect01").unwrap();
        let payload = sample_payload(
            &relay_url,
            Some(ws_dir.to_string_lossy().into_owned()),
            "direct",
        );
        let ct_b64 = seal_enroll_payload(&ticket, &payload).unwrap();
        let e2e_key = derive_e2e_key(&payload.cluster_id, &payload.e2e_key);
        let expected_enroll_id = payload.enroll_id.clone();

        let (manifest_tx, mut manifest_rx) = tokio::sync::mpsc::channel::<DeviceMessage>(1);

        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let ct_b64 = ct_b64.clone();
                let manifest_tx = manifest_tx.clone();
                tokio::spawn(async move {
                    let mut peek = [0u8; 512];
                    let n = stream.peek(&mut peek).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&peek[..n]);
                    if head.starts_with("POST /v1/enroll/claim/tkt_direct_01 ") {
                        let mut sink = [0u8; 2048];
                        let _ = stream.read(&mut sink).await;
                        let body = serde_json::to_vec(&json!({
                            "ticket_id": "tkt_direct_01",
                            "ciphertext_b64": ct_b64,
                            "expires_at_ms": (now_unix_secs() + 600) * 1000
                        }))
                        .unwrap();
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                        let _ = stream.write_all(&body).await;
                    } else if head.starts_with("GET /v1/bootstrap ") {
                        let mut sink = [0u8; 1024];
                        let _ = stream.read(&mut sink).await;
                        let body = br#"{"stun_servers":[]}"#;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                        let _ = stream.write_all(body).await;
                    } else if head.starts_with("GET /v1/signal ") {
                        if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                            let _ = ws.next().await;
                        }
                    } else if head.starts_with("GET /v1/relay ") {
                        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                        while let Some(Ok(WsMessage::Binary(bin))) = ws.next().await {
                            let rf = RelayFrame::decode(&bin).unwrap();
                            if rf.flags == RelayFlags::Ping {
                                let pong = RelayFrame {
                                    flags: RelayFlags::Pong,
                                    src: "relay".to_string(),
                                    dst: rf.src,
                                    payload: Vec::new(),
                                };
                                let _ = ws
                                    .send(WsMessage::Binary(pong.encode().unwrap().into()))
                                    .await;
                            } else if rf.flags == RelayFlags::Data {
                                let msg = open_device_message(
                                    &e2e_key,
                                    "personal",
                                    &rf.src,
                                    &rf.dst,
                                    &rf.payload,
                                )
                                .unwrap();
                                let _ = manifest_tx.send(msg).await;
                                break;
                            }
                        }
                    }
                });
            }
        });

        let outcome = run_enroll(EnrollArgs {
            relay_url: Some(relay_url),
            claim_url: None,
            ticket: Some("neo_enr_v1.tkt_direct_01.ephemeralSecretDirect01".to_string()),
            ticket_stdin: false,
            mode: EnrollModeArg::User,
            config_dir: Some(cfg_dir.clone()),
            skip_service: true,
            skip_check: false,
        })
        .await
        .unwrap();

        assert_eq!(outcome.cluster_id, "personal");
        assert_eq!(outcome.device_id, "os-personal-01");
        assert_eq!(outcome.enroll_id, expected_enroll_id);
        assert!(outcome.policy_path.exists());
        assert!(outcome.env_path.exists());

        // Verify env file contents & permissions
        let env_map = crate::parse_env_file(&outcome.env_path).unwrap();
        assert_eq!(env_map.get("NEO_CLUSTER_ID").map(String::as_str), Some("personal"));
        assert_eq!(env_map.get("NEO_DEVICE_ID").map(String::as_str), Some("os-personal-01"));
        assert_eq!(env_map.get("NEO_TOKEN").map(String::as_str), Some("neo1.placeholder.sig"));
        assert_eq!(
            env_map.get("NEO_RELAY_TOKEN").map(String::as_str),
            Some("neo1.placeholder.sig")
        );
        assert_eq!(
            env_map.get("NEO_E2E_KEY").map(String::as_str),
            Some("super-secret-e2e-key")
        );
        assert_eq!(
            env_map.get("NEO_ENROLL_ID").map(String::as_str),
            Some("enr_2026_test01")
        );
        assert_eq!(
            env_map.get("NEO_EXTRA_ARGS").map(String::as_str),
            Some("--relay --mqtt-bind 127.0.0.1:1883")
        );
        assert_eq!(env_map.get("CUDA_VISIBLE_DEVICES").map(String::as_str), Some("0"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let env_mode = std::fs::metadata(&outcome.env_path).unwrap().permissions().mode() & 0o777;
            let pol_mode = std::fs::metadata(&outcome.policy_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(env_mode, 0o600);
            assert_eq!(pol_mode, 0o444);
        }

        // Verify one-shot check sent manifest with enroll_id
        let manifest_msg = tokio::time::timeout(Duration::from_secs(3), manifest_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(manifest_msg.kind, "manifest");
        assert_eq!(
            manifest_msg.body.get("enroll_id").and_then(|v| v.as_str()),
            Some("enr_2026_test01")
        );

        server.abort();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn bootstrap_exchange_receives_permanent_credentials_over_e2e_relay() {
        let tmp = std::env::temp_dir().join(format!(
            "neo_enroll_bsx_{}_{}",
            std::process::id(),
            now_ms()
        ));
        let cfg_dir = tmp.join("cfg");
        let ws_dir = tmp.join("work");
        std::fs::create_dir_all(&tmp).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let relay_url = format!("http://{addr}");

        let ticket = parse_ticket("neo_enr_v1.tkt_bsx_02.ephemeralSecretBsx02").unwrap();
        let key_hmac = derive_cluster_hmac_key("root", "personal");
        let temp_token = mint_neo1_token(
            &TokenClaims {
                cluster_id: "personal".to_string(),
                node_id: "enr-temp-node".to_string(),
                tier: "os".to_string(),
                iat: now_unix_secs(),
                exp: now_unix_secs() + 300,
            },
            &key_hmac,
        )
        .unwrap();

        let mut payload = sample_payload(
            &relay_url,
            Some(ws_dir.to_string_lossy().into_owned()),
            "bootstrap_exchange",
        );
        payload.device_id = String::new();
        payload.relay_token = temp_token;
        let ct_b64 = seal_enroll_payload(&ticket, &payload).unwrap();
        let e2e_key = derive_e2e_key(&payload.cluster_id, &payload.e2e_key);

        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let ct_b64 = ct_b64.clone();
                tokio::spawn(async move {
                    let mut peek = [0u8; 512];
                    let n = stream.peek(&mut peek).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&peek[..n]);
                    if head.starts_with("POST /v1/enroll/claim/tkt_bsx_02 ") {
                        let mut sink = [0u8; 2048];
                        let _ = stream.read(&mut sink).await;
                        let body = serde_json::to_vec(&json!({
                            "ticket_id": "tkt_bsx_02",
                            "ciphertext_b64": ct_b64,
                        }))
                        .unwrap();
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                        let _ = stream.write_all(&body).await;
                    } else if head.starts_with("GET /v1/relay ") {
                        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                        if let Some(Ok(WsMessage::Binary(bin))) = ws.next().await {
                            let rf = RelayFrame::decode(&bin).unwrap();
                            assert_eq!(rf.src, "enr-temp-node");
                            assert_eq!(rf.dst, "master-personal");
                            let reg = open_device_message(
                                &e2e_key,
                                "personal",
                                "enr-temp-node",
                                "master-personal",
                                &rf.payload,
                            )
                            .unwrap();
                            assert_eq!(reg.kind, "enroll_register");
                            assert_eq!(reg.body["enroll_id"], "enr_2026_test01");
                            assert!(!reg.body["fingerprint"].as_str().unwrap().is_empty());

                            let ack = DeviceMessage {
                                v: 1,
                                kind: "enroll_ack".to_string(),
                                req_id: reg.req_id,
                                cluster_id: "personal".to_string(),
                                device_id: "master-personal".to_string(),
                                ts_ms: now_ms(),
                                body: json!({
                                    "ok": true,
                                    "enroll_id": "enr_2026_test01",
                                    "cluster_id": "personal",
                                    "device_id": "os-perm-mac-09",
                                    "relay_token": "neo1.permanentTokenPayload.sig"
                                }),
                            };
                            let sealed = seal_device_message(
                                &e2e_key,
                                "master-personal",
                                "enr-temp-node",
                                &ack,
                            )
                            .unwrap();
                            let resp_frame = RelayFrame {
                                flags: RelayFlags::Data,
                                src: "master-personal".to_string(),
                                dst: "enr-temp-node".to_string(),
                                payload: sealed,
                            };
                            let _ = ws
                                .send(WsMessage::Binary(resp_frame.encode().unwrap().into()))
                                .await;
                        }
                    }
                });
            }
        });

        let outcome = run_enroll(EnrollArgs {
            relay_url: Some(relay_url),
            claim_url: None,
            ticket: Some("neo_enr_v1.tkt_bsx_02.ephemeralSecretBsx02".to_string()),
            ticket_stdin: false,
            mode: EnrollModeArg::User,
            config_dir: Some(cfg_dir.clone()),
            skip_service: true,
            skip_check: true,
        })
        .await
        .unwrap();

        assert_eq!(outcome.device_id, "os-perm-mac-09");
        let env_map = crate::parse_env_file(&outcome.env_path).unwrap();
        assert_eq!(
            env_map.get("NEO_DEVICE_ID").map(String::as_str),
            Some("os-perm-mac-09")
        );
        assert_eq!(
            env_map.get("NEO_TOKEN").map(String::as_str),
            Some("neo1.permanentTokenPayload.sig")
        );
        assert_eq!(
            env_map.get("NEO_RELAY_TOKEN").map(String::as_str),
            Some("neo1.permanentTokenPayload.sig")
        );

        server.abort();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn renders_windows_task_xml_and_wrappers_for_long_paths_without_261_char_limit() {
        let exe = Path::new(r"C:\Users\TroyeSimon\AppData\Local\neo-agent\bin\neo-agent-os.exe");
        let bg = windows_bg_launcher_path(exe);
        assert!(bg.to_string_lossy().ends_with("neo-agent-os-bg.exe"));
        let ws = Path::new(r"C:\Users\TroyeSimon\AppData\Local\neo-agent\neo-cluster-prod\work");
        let env = Path::new(r"C:\Users\TroyeSimon\AppData\Local\neo-agent\cluster-neo-cluster-prod.env");
        let pol = Path::new(r"C:\Users\TroyeSimon\AppData\Local\neo-agent\policy-neo-cluster-prod.toml");
        let ota = Path::new(r"C:\Users\TroyeSimon\AppData\Local\neo-agent\neo-cluster-prod\ota");
        let log = Path::new(r"C:\Users\TroyeSimon\AppData\Local\neo-agent\neo-cluster-prod\logs\agent.log");

        let args = format!(
            "--log-file \"{}\" --env-file \"{}\" --policy \"{}\" --ota-cache-dir \"{}\"",
            log.display(),
            env.display(),
            pol.display(),
            ota.display()
        );
        assert!(
            args.len() > 261,
            "test fixture should reproduce >261 char command args (got {})",
            args.len()
        );

        let xml = render_windows_task_xml(
            "neo-cluster-prod",
            &bg,
            &args,
            ws,
            Some(r"DESKTOP-TEST\TroyeSimon"),
        );
        assert!(xml.contains(r#"encoding="UTF-16""#));
        assert!(xml.contains("neo-agent-os-bg.exe</Command>"));
        assert!(!xml.contains("neo-agent-os.exe</Command>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(xml.contains("<Hidden>true</Hidden>"));
        assert!(xml.contains("<UserId>DESKTOP-TEST\\TroyeSimon</UserId>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));

        let utf16 = encode_utf16le_bom(&xml);
        assert_eq!(&utf16[..2], &[0xFF, 0xFE]);
        assert!(utf16.len() > xml.len() * 2);

        let vbs = render_windows_vbs_launcher(exe, ws, env, pol, ota);
        assert!(vbs.contains("WScript.Shell"));
        assert!(vbs.contains("CurrentDirectory"));
        assert!(vbs.contains("--env-file"));
        assert!(vbs.contains(", 0, False"));

        let cmd = render_windows_cmd_wrapper(exe, env, pol, ota);
        assert!(cmd.starts_with("@echo off\r\n"));
        assert!(cmd.contains("--ota-cache-dir"));

        let plist = render_macos_plist("personal", exe, ws, env, pol, ota, log);
        assert!(plist.contains("<key>ProcessType</key>\n  <string>Background</string>"));
    }
}
