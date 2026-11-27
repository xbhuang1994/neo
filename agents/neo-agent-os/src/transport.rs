use crate::executor::Executor;
use crate::file_transfer::{FileTransferManager, OutboundFileFrame};
use crate::mcp::{is_mcp_rpc_method, McpManager};
use crate::policy::Policy;
use crate::prober::{CapabilityManifest, CapabilityProber};
use crate::protocol::{
    derive_e2e_key, open_device_message, open_file_frame, seal_device_message, seal_file_frame,
    stun_probe, udp_punch_peer, BootstrapResponse, DeviceMessage, FileFrame, RelayEnvelope,
    RelayFlags, RelayFrame, SignalMessage, E2E_ENVELOPE_VERSION, FILE_ENVELOPE_VERSION,
};
use crate::relay_bridge::RelayBridge;
use crate::updater::{execute_self_update, RestartPlan, RollbackAction, SelfUpdateRequest, UpdaterManager};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use url::Url;

const OFFLINE_RING_CAP: usize = 128;

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub cluster_id: String,
    pub device_id: String,
    pub master_id: String,
    pub relay_url: String,
    pub token: String,
    pub e2e_secret: String,
    pub enroll_id: Option<String>,
    pub relay_enabled: bool,
    pub mqtt_bind: String,
    pub uart_device: Option<PathBuf>,
    pub ota_cache_dir: Option<PathBuf>,
    pub updater_state_path: Option<PathBuf>,
    pub policy_path: Option<PathBuf>,
    pub sandbox_override_path: Option<PathBuf>,
    #[cfg(test)]
    pub self_update_target: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub enum AgentExit {
    #[allow(dead_code)]
    Stopped,
    Restart(RestartPlan),
}

#[derive(Debug, Clone)]
pub struct RelayEndpoints {
    pub bootstrap_url: String,
    pub whoami_url: String,
    pub signal_url: String,
    pub relay_url: String,
}

pub fn derive_endpoints(base_url: &str) -> Result<RelayEndpoints, String> {
    let mut url = Url::parse(base_url).map_err(|e| format!("invalid relay-url '{base_url}': {e}"))?;
    let ws_scheme = match url.scheme() {
        "https" | "wss" => {
            let _ = url.set_scheme("https");
            "wss"
        }
        "http" | "ws" => {
            let _ = url.set_scheme("http");
            "ws"
        }
        other => return Err(format!("unsupported relay-url scheme: {other}")),
    };
    url.set_path("");
    url.set_query(None);
    let base_http = url.to_string().trim_end_matches('/').to_string();
    let _ = url.set_scheme(ws_scheme);
    let base_ws = url.to_string().trim_end_matches('/').to_string();
    Ok(RelayEndpoints {
        bootstrap_url: format!("{base_http}/v1/bootstrap"),
        whoami_url: format!("{base_http}/v1/whoami"),
        signal_url: format!("{base_ws}/v1/signal"),
        relay_url: format!("{base_ws}/v1/relay"),
    })
}

fn build_tls_connector() -> TlsConnector {
    let mut root_store = RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
}

/// Minimal HTTP/1.1 client over `tokio-rustls` (or plain TCP for `http://` local tests),
/// avoiding heavy `reqwest` dependencies to keep single binary size ~3-6 MB.
pub async fn http_request(
    method: &str,
    url_str: &str,
    bearer_token: Option<&str>,
    content_type: Option<&str>,
    body: &[u8],
) -> Result<(u16, Vec<u8>), String> {
    let url = Url::parse(url_str).map_err(|e| format!("invalid HTTP URL '{url_str}': {e}"))?;
    let raw_host = url.host_str().ok_or("HTTP URL missing host")?;
    let host_for_dial = raw_host.trim_start_matches('[').trim_end_matches(']').to_string();
    let use_tls = match url.scheme() {
        "https" => true,
        "http" => false,
        other => return Err(format!("unsupported HTTP URL scheme: {other}")),
    };
    let port = url
        .port_or_known_default()
        .unwrap_or(if use_tls { 443 } else { 80 });
    let host_header = match url.port() {
        Some(p) => format!("{raw_host}:{p}"),
        None => raw_host.to_string(),
    };
    let path_str = if url.path().is_empty() { "/" } else { url.path() };
    let path_and_query = match url.query() {
        Some(q) => format!("{path_str}?{q}"),
        None => path_str.to_string(),
    };

    let mut req = format!(
        "{method} {path_and_query} HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: neo-agent-os/{}\r\nAccept: application/json\r\nConnection: close\r\n",
        env!("CARGO_PKG_VERSION")
    );
    if let Some(tok) = bearer_token {
        req.push_str(&format!("Authorization: Bearer {tok}\r\n"));
    }
    if let Some(ct) = content_type {
        req.push_str(&format!("Content-Type: {ct}\r\n"));
    }
    if !body.is_empty() || method.eq_ignore_ascii_case("POST") || method.eq_ignore_ascii_case("PUT") {
        req.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    req.push_str("\r\n");

    let tcp = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect((host_for_dial.as_str(), port)),
    )
    .await
    .map_err(|_| format!("HTTP TCP connect timed out: {url_str}"))?
    .map_err(|e| format!("HTTP TCP connect failed ({url_str}): {e}"))?;

    let raw_resp = if use_tls {
        let connector = build_tls_connector();
        let server_name = ServerName::try_from(host_for_dial.clone())
            .map_err(|_| format!("invalid TLS server name: {host_for_dial}"))?;
        let mut tls =
            tokio::time::timeout(Duration::from_secs(10), connector.connect(server_name, tcp))
                .await
                .map_err(|_| "HTTP TLS handshake timed out".to_string())?
                .map_err(|e| format!("HTTP TLS handshake failed: {e}"))?;
        tls.write_all(req.as_bytes())
            .await
            .map_err(|e| format!("HTTP header write failed: {e}"))?;
        if !body.is_empty() {
            tls.write_all(body)
                .await
                .map_err(|e| format!("HTTP body write failed: {e}"))?;
        }
        tls.flush().await.ok();
        let mut buf = Vec::new();
        tokio::time::timeout(Duration::from_secs(15), tls.read_to_end(&mut buf))
            .await
            .map_err(|_| "HTTP response read timed out".to_string())?
            .map_err(|e| format!("HTTP response read failed: {e}"))?;
        buf
    } else {
        let mut tcp = tcp;
        tcp.write_all(req.as_bytes())
            .await
            .map_err(|e| format!("HTTP header write failed: {e}"))?;
        if !body.is_empty() {
            tcp.write_all(body)
                .await
                .map_err(|e| format!("HTTP body write failed: {e}"))?;
        }
        tcp.flush().await.ok();
        let mut buf = Vec::new();
        tokio::time::timeout(Duration::from_secs(15), tcp.read_to_end(&mut buf))
            .await
            .map_err(|_| "HTTP response read timed out".to_string())?
            .map_err(|e| format!("HTTP response read failed: {e}"))?;
        buf
    };

    parse_http_response(&raw_resp)
}

pub async fn http_post_json(url_str: &str, body: &[u8]) -> Result<(u16, Vec<u8>), String> {
    http_request("POST", url_str, None, Some("application/json"), body).await
}

/// Downloads a binary or text asset over HTTP/HTTPS, following up to 5 redirects (for GitHub
/// Releases / CDN mirrors) while enforcing a strict maximum byte limit and timeout.
pub async fn http_download_bytes(
    url_str: &str,
    max_bytes: usize,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let mut current_url = url_str.to_string();
    for hop in 0..=5 {
        let url = Url::parse(&current_url)
            .map_err(|e| format!("invalid download URL '{current_url}': {e}"))?;
        let raw_host = url.host_str().ok_or("download URL missing host")?;
        let host_for_dial = raw_host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string();
        let use_tls = match url.scheme() {
            "https" => true,
            "http" => false,
            other => return Err(format!("unsupported download URL scheme: {other}")),
        };
        let port = url
            .port_or_known_default()
            .unwrap_or(if use_tls { 443 } else { 80 });
        let host_header = match url.port() {
            Some(p) => format!("{raw_host}:{p}"),
            None => raw_host.to_string(),
        };
        let path_str = if url.path().is_empty() { "/" } else { url.path() };
        let path_and_query = match url.query() {
            Some(q) => format!("{path_str}?{q}"),
            None => path_str.to_string(),
        };

        let req = format!(
            "GET {path_and_query} HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: neo-agent-os/{}\r\nAccept: */*\r\nConnection: close\r\n\r\n",
            env!("CARGO_PKG_VERSION")
        );

        let tcp = tokio::time::timeout(
            Duration::from_secs(15),
            TcpStream::connect((host_for_dial.as_str(), port)),
        )
        .await
        .map_err(|_| format!("download TCP connect timed out: {current_url}"))?
        .map_err(|e| format!("download TCP connect failed ({current_url}): {e}"))?;

        let read_limit = (max_bytes as u64).saturating_add(64 * 1024);
        let raw_resp = if use_tls {
            let connector = build_tls_connector();
            let server_name = ServerName::try_from(host_for_dial.clone())
                .map_err(|_| format!("invalid TLS server name: {host_for_dial}"))?;
            let mut tls =
                tokio::time::timeout(Duration::from_secs(15), connector.connect(server_name, tcp))
                    .await
                    .map_err(|_| "download TLS handshake timed out".to_string())?
                    .map_err(|e| format!("download TLS handshake failed: {e}"))?;
            tls.write_all(req.as_bytes())
                .await
                .map_err(|e| format!("download request write failed: {e}"))?;
            tls.flush().await.ok();
            let mut buf = Vec::new();
            let mut limited = tls.take(read_limit + 1);
            tokio::time::timeout(timeout, limited.read_to_end(&mut buf))
                .await
                .map_err(|_| format!("download timed out: {current_url}"))?
                .map_err(|e| format!("download read failed: {e}"))?;
            if (buf.len() as u64) > read_limit {
                return Err(format!("download exceeded max size limit ({max_bytes} bytes)"));
            }
            buf
        } else {
            let mut tcp = tcp;
            tcp.write_all(req.as_bytes())
                .await
                .map_err(|e| format!("download request write failed: {e}"))?;
            tcp.flush().await.ok();
            let mut buf = Vec::new();
            let mut limited = tcp.take(read_limit + 1);
            tokio::time::timeout(timeout, limited.read_to_end(&mut buf))
                .await
                .map_err(|_| format!("download timed out: {current_url}"))?
                .map_err(|e| format!("download read failed: {e}"))?;
            if (buf.len() as u64) > read_limit {
                return Err(format!("download exceeded max size limit ({max_bytes} bytes)"));
            }
            buf
        };

        let (status, location, body) = parse_http_response_with_location(&raw_resp)?;
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            if hop >= 5 {
                return Err(format!("too many HTTP redirects for {url_str}"));
            }
            let loc = location.ok_or_else(|| format!("HTTP {status} redirect missing Location header"))?;
            let next = url
                .join(loc.trim())
                .map_err(|e| format!("invalid redirect Location '{loc}': {e}"))?;
            if !matches!(next.scheme(), "http" | "https") {
                return Err(format!("disallowed redirect scheme '{}'", next.scheme()));
            }
            current_url = next.to_string();
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(format!("HTTP {status} downloading {current_url}"));
        }
        if body.len() > max_bytes {
            return Err(format!("download body exceeds max size limit ({max_bytes} bytes)"));
        }
        return Ok(body);
    }
    Err(format!("too many HTTP redirects for {url_str}"))
}

pub async fn fetch_bootstrap(bootstrap_url: &str, token: &str) -> Result<BootstrapResponse, String> {
    let (status, body) = http_request("GET", bootstrap_url, Some(token), None, &[]).await?;
    if status < 200 || status >= 300 {
        return Err(format!(
            "bootstrap HTTP {status}: {}",
            String::from_utf8_lossy(&body)
        ));
    }
    serde_json::from_slice(&body).map_err(|e| format!("invalid bootstrap JSON: {e}"))
}

fn clean_ip(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

pub async fn fetch_whoami_ip(whoami_url: &str, token: &str) -> Option<String> {
    let (status, body) = tokio::time::timeout(
        Duration::from_secs(2),
        http_request("GET", whoami_url, Some(token), None, &[]),
    )
    .await
    .ok()?
    .ok()?;
    if !(200..300).contains(&status) {
        return None;
    }
    let val: serde_json::Value = serde_json::from_slice(&body).ok()?;
    clean_ip(val.get("observed_ip").and_then(|v| v.as_str()))
}

async fn resolve_observed_ip(endpoints: &RelayEndpoints, token: &str) -> Option<String> {
    if let Ok(Ok(boot)) = tokio::time::timeout(
        Duration::from_secs(2),
        fetch_bootstrap(&endpoints.bootstrap_url, token),
    )
    .await
    {
        if let Some(ip) = clean_ip(boot.observed_ip.as_deref()) {
            return Some(ip);
        }
    }
    fetch_whoami_ip(&endpoints.whoami_url, token).await
}

fn parse_http_response(raw: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let (status, _loc, body) = parse_http_response_with_location(raw)?;
    Ok((status, body))
}

fn parse_http_response_with_location(
    raw: &[u8],
) -> Result<(u16, Option<String>, Vec<u8>), String> {
    let hdr_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("malformed HTTP response (missing header terminator)")?;
    let hdr_str = std::str::from_utf8(&raw[..hdr_end])
        .map_err(|e| format!("invalid HTTP header UTF-8: {e}"))?;
    let mut lines = hdr_str.split("\r\n");
    let status_line = lines.next().ok_or("missing HTTP status line")?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("invalid HTTP status line: {status_line}"))?;

    let mut is_chunked = false;
    let mut location: Option<String> = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim();
            if key.eq_ignore_ascii_case("transfer-encoding")
                && v.to_ascii_lowercase().contains("chunked")
            {
                is_chunked = true;
            } else if key.eq_ignore_ascii_case("location") {
                location = Some(v.trim().to_string());
            }
        }
    }
    let body_raw = &raw[hdr_end + 4..];
    let body = if is_chunked {
        decode_chunked(body_raw)?
    } else {
        body_raw.to_vec()
    };
    Ok((status, location, body))
}

fn decode_chunked(mut data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let pos = data
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or("malformed chunked HTTP body")?;
        let size_line = std::str::from_utf8(&data[..pos]).map_err(|e| e.to_string())?;
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|e| format!("invalid chunk size '{size_hex}': {e}"))?;
        data = &data[pos + 2..];
        if size == 0 {
            break;
        }
        if data.len() < size + 2 {
            return Err("truncated HTTP chunk".to_string());
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
    Ok(out)
}

pub(crate) async fn connect_ws_bearer(
    ws_url: &str,
    token: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<TcpStream>,
    >,
    String,
> {
    let mut req = ws_url
        .into_client_request()
        .map_err(|e| format!("invalid WS URL '{ws_url}': {e}"))?;
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| "invalid token header value".to_string())?,
    );
    let (stream, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(req),
    )
    .await
    .map_err(|_| format!("WS connect timed out: {ws_url}"))?
    .map_err(|e| format!("WS connect failed ({ws_url}): {e}"))?;
    Ok(stream)
}

fn build_manifest_body(
    manifest: &CapabilityManifest,
    enroll_id: Option<&str>,
) -> serde_json::Value {
    let mut body = serde_json::to_value(manifest).unwrap_or_else(|_| json!({}));
    if let Some(eid) = enroll_id.filter(|s| !s.is_empty()) {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("enroll_id".to_string(), json!(eid));
            obj.insert(
                "fingerprint".to_string(),
                json!(crate::enroll::compute_host_fingerprint()),
            );
        }
    }
    body
}

pub async fn run_one_shot_check(cfg: &AgentConfig, policy: &Policy) -> Result<(), String> {
    let endpoints = derive_endpoints(&cfg.relay_url)?;
    let mut manifest = CapabilityProber::probe(
        policy,
        &cfg.device_id,
        cfg.relay_enabled,
        Some(&cfg.mqtt_bind),
        cfg.uart_device.as_deref(),
    );
    let bootstrap = fetch_bootstrap(&endpoints.bootstrap_url, &cfg.token).await?;
    manifest.public_ip = clean_ip(bootstrap.observed_ip.as_deref());
    eprintln!(
        "[one-shot-check] bootstrap ok (stun_servers={:?})",
        bootstrap.stun_servers
    );

    // Verify /v1/signal registration
    let mut sig_ws = connect_ws_bearer(&endpoints.signal_url, &cfg.token).await?;
    let reg = SignalMessage {
        cluster_id: Some(cfg.cluster_id.clone()),
        node_id: Some(cfg.device_id.clone()),
        tier: Some("os".to_string()),
        ts_ms: Some(now_ms()),
        ..SignalMessage::new("register")
    };
    sig_ws
        .send(WsMessage::Text(serde_json::to_string(&reg).unwrap().into()))
        .await
        .map_err(|e| format!("signal send failed: {e}"))?;
    let _ = sig_ws.close(None).await;

    // Verify /v1/relay binary Ping/Pong + encrypted manifest framing
    let mut relay_ws = connect_ws_bearer(&endpoints.relay_url, &cfg.token).await?;
    let ping = RelayFrame {
        flags: RelayFlags::Ping,
        src: cfg.device_id.clone(),
        dst: String::new(),
        payload: Vec::new(),
    };
    relay_ws
        .send(WsMessage::Binary(ping.encode()?.into()))
        .await
        .map_err(|e| format!("relay ping send failed: {e}"))?;

    let e2e_key = derive_e2e_key(&cfg.cluster_id, &cfg.e2e_secret);
    let manifest_msg = DeviceMessage {
        v: 1,
        kind: "manifest".to_string(),
        req_id: format!("manifest-{}", now_ms()),
        cluster_id: cfg.cluster_id.clone(),
        device_id: cfg.device_id.clone(),
        ts_ms: now_ms(),
        body: build_manifest_body(&manifest, cfg.enroll_id.as_deref()),
    };
    let sealed = seal_device_message(&e2e_key, &cfg.device_id, &cfg.master_id, &manifest_msg)?;
    let frame = RelayFrame {
        flags: RelayFlags::Data,
        src: cfg.device_id.clone(),
        dst: cfg.master_id.clone(),
        payload: sealed,
    };
    relay_ws
        .send(WsMessage::Binary(frame.encode()?.into()))
        .await
        .map_err(|e| format!("relay manifest send failed: {e}"))?;

    // Briefly await Pong/Ack without failing if master is not online yet
    if let Ok(Some(Ok(WsMessage::Binary(bin)))) =
        tokio::time::timeout(Duration::from_millis(800), relay_ws.next()).await
    {
        if let Ok(rf) = RelayFrame::decode(&bin) {
            eprintln!("[one-shot-check] relay frame rx flags={:?}", rf.flags);
        }
    }
    let _ = relay_ws.close(None).await;
    eprintln!("[one-shot-check] all checks passed");
    Ok(())
}

pub async fn run_agent(
    cfg: AgentConfig,
    policy: Arc<std::sync::RwLock<Policy>>,
) -> Result<AgentExit, String> {
    let boot_started = Instant::now();
    let endpoints = derive_endpoints(&cfg.relay_url)?;
    let e2e_key = derive_e2e_key(&cfg.cluster_id, &cfg.e2e_secret);
    let executor = Arc::new(
        Executor::new(Arc::clone(&policy), cfg.ota_cache_dir.clone())
            .with_policy_paths(cfg.policy_path.clone(), cfg.sandbox_override_path.clone()),
    );
    let mcp_manager = Arc::new(McpManager::new(
        Arc::clone(&policy),
        Some(cfg.cluster_id.clone()),
        cfg.policy_path.clone(),
        cfg.sandbox_override_path.clone(),
        cfg.ota_cache_dir.clone(),
    ));
    mcp_manager.discover_initial().await;
    let mcp_reaper_handle = mcp_manager.spawn_idle_reaper();
    let updating_flag = Arc::new(AtomicBool::new(false));
    let (restart_tx, mut restart_rx) = oneshot::channel::<RestartPlan>();
    let restart_slot = Arc::new(Mutex::new(Some(restart_tx)));

    let mut updater = cfg
        .updater_state_path
        .as_ref()
        .map(|p| UpdaterManager::load_or_init(p))
        .transpose()?;

    let (uplink_tx, mut uplink_rx) = mpsc::channel::<RelayEnvelope>(128);
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<(String, DeviceMessage)>(256);
    let (outbound_file_tx, mut outbound_file_rx) = mpsc::channel::<OutboundFileFrame>(256);
    let file_transfers = FileTransferManager::new(Arc::clone(&policy), outbound_file_tx);
    let (inbound_file_tx, mut inbound_file_rx) = mpsc::channel::<(String, FileFrame)>(256);
    {
        let ft = Arc::clone(&file_transfers);
        tokio::spawn(async move {
            while let Some((src, file_frame)) = inbound_file_rx.recv().await {
                ft.handle_incoming_frame(&src, file_frame).await;
            }
        });
    }

    let relay_bridge = if cfg.relay_enabled {
        let bridge = RelayBridge::new(
            cfg.cluster_id.clone(),
            cfg.device_id.clone(),
            cfg.ota_cache_dir.clone(),
            uplink_tx,
        );
        let bound = bridge.start_mqtt_broker(&cfg.mqtt_bind).await?;
        eprintln!("[neo-agent-os] Tier 2 MQTT relay broker listening on {bound}");
        if let Some(ref uart) = cfg.uart_device {
            if let Err(e) = bridge.start_uart_bridge(uart).await {
                eprintln!("[neo-agent-os] UART bridge error ({}): {e}", uart.display());
            }
        }
        Some(bridge)
    } else {
        None
    };

    let active_master = Arc::new(Mutex::new(cfg.master_id.clone()));
    let observed_public_ip = Arc::new(Mutex::new(None::<String>));
    let offline_ring = Arc::new(Mutex::new(VecDeque::<(String, DeviceMessage)>::with_capacity(
        OFFLINE_RING_CAP,
    )));

    // Forward Tier 2 MCU uplinks from RelayBridge to outbound Master queue.
    {
        let out_tx = outbound_tx.clone();
        let master_ref = Arc::clone(&active_master);
        let cluster_id = cfg.cluster_id.clone();
        let device_id = cfg.device_id.clone();
        tokio::spawn(async move {
            while let Some(env) = uplink_rx.recv().await {
                let dst = master_ref.lock().await.clone();
                let msg = DeviceMessage {
                    v: 1,
                    kind: "relay_envelope".to_string(),
                    req_id: format!("mcu-up-{}", env.seq_id),
                    cluster_id: cluster_id.clone(),
                    device_id: device_id.clone(),
                    ts_ms: now_ms(),
                    body: serde_json::to_value(&env).unwrap_or(json!({})),
                };
                let _ = out_tx.send((dst, msg)).await;
            }
        });
    }

    // Best-effort bootstrap + signal/P2P background loop
    {
        let cfg_sig = cfg.clone();
        let endpoints_sig = endpoints.clone();
        let public_ip_sig = Arc::clone(&observed_public_ip);
        tokio::spawn(async move {
            run_signal_loop(cfg_sig, endpoints_sig, public_ip_sig).await;
        });
    }

    // Main /v1/relay loop with auto-reconnect and offline ring buffer
    let mut backoff_ms = 500u64;
    loop {
        match connect_ws_bearer(&endpoints.relay_url, &cfg.token).await {
            Ok(ws) => {
                backoff_ms = 500;
                if let Some(ref mut upd) = updater {
                    match upd.on_healthy_connect(boot_started.elapsed()) {
                        Ok(RollbackAction::Committed) => {
                            eprintln!("[updater] pending_boot committed");
                        }
                        Ok(RollbackAction::RolledBack) => {
                            eprintln!("[updater] 15s commit window missed; rolled back");
                        }
                        _ => {}
                    }
                }

                let (mut ws_sink, mut ws_stream) = ws.split();
                if let Some(ip) = resolve_observed_ip(&endpoints, &cfg.token).await {
                    *observed_public_ip.lock().await = Some(ip);
                }
                let policy_snap = policy.read().unwrap_or_else(|e| e.into_inner()).clone();
                let mcp_summary = mcp_manager.catalog_summary().await;
                let mut manifest = CapabilityProber::probe_with_mcp(
                    &policy_snap,
                    &cfg.device_id,
                    cfg.relay_enabled,
                    Some(&cfg.mqtt_bind),
                    cfg.uart_device.as_deref(),
                    Some(mcp_summary),
                );
                manifest.public_ip = observed_public_ip.lock().await.clone();
                let init_master = active_master.lock().await.clone();
                let manifest_msg = DeviceMessage {
                    v: 1,
                    kind: "manifest".to_string(),
                    req_id: format!("manifest-{}", now_ms()),
                    cluster_id: cfg.cluster_id.clone(),
                    device_id: cfg.device_id.clone(),
                    ts_ms: now_ms(),
                    body: build_manifest_body(&manifest, cfg.enroll_id.as_deref()),
                };
                if let Err(e) =
                    send_encrypted_frame(&mut ws_sink, &e2e_key, &cfg.device_id, &init_master, &manifest_msg)
                        .await
                {
                    eprintln!("[relay] failed to send manifest: {e}");
                }

                // Flush offline ring buffer
                {
                    let mut ring = offline_ring.lock().await;
                    while let Some((dst, msg)) = ring.pop_front() {
                        if send_encrypted_frame(&mut ws_sink, &e2e_key, &cfg.device_id, &dst, &msg)
                            .await
                            .is_err()
                        {
                            ring.push_front((dst, msg));
                            break;
                        }
                    }
                }

                let mut hb_tick = tokio::time::interval_at(
                    tokio::time::Instant::now() + Duration::from_secs(25),
                    Duration::from_secs(25),
                );
                hb_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                let mut mcp_tick = tokio::time::interval_at(
                    tokio::time::Instant::now() + Duration::from_secs(60),
                    Duration::from_secs(60),
                );
                mcp_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

                loop {
                    tokio::select! {
                        biased;
                        Ok(plan) = &mut restart_rx => {
                            mcp_reaper_handle.abort();
                            mcp_manager.shutdown_all().await;
                            file_transfers
                                .fail_all_for_disconnect("agent restarting for self_update")
                                .await;
                            // Flush any queued rpc_resp frames before closing WebSocket.
                            while let Ok((dst, msg)) = outbound_rx.try_recv() {
                                let _ = send_encrypted_frame(&mut ws_sink, &e2e_key, &cfg.device_id, &dst, &msg).await;
                            }
                            let _ = ws_sink.send(WsMessage::Close(None)).await;
                            let _ = ws_sink.flush().await;
                            drop(relay_bridge);
                            return Ok(AgentExit::Restart(plan));
                        }
                        _ = mcp_tick.tick() => {
                            if let Some(changed) = mcp_manager.poll_catalog_changes().await {
                                let dst = active_master.lock().await.clone();
                                let ev = DeviceMessage {
                                    v: 1,
                                    kind: "event".to_string(),
                                    req_id: format!("mcp-evt-{}", now_ms()),
                                    cluster_id: cfg.cluster_id.clone(),
                                    device_id: cfg.device_id.clone(),
                                    ts_ms: now_ms(),
                                    body: json!({
                                        "event": "mcp.catalog_changed",
                                        "catalog_hash": changed.catalog_hash,
                                        "summary": changed.summary,
                                        "servers": changed.servers,
                                    }),
                                };
                                if send_encrypted_frame(&mut ws_sink, &e2e_key, &cfg.device_id, &dst, &ev).await.is_err() {
                                    push_ring(&offline_ring, (dst, ev)).await;
                                    break;
                                }
                            }
                        }
                        _ = hb_tick.tick() => {
                            let ping = RelayFrame {
                                flags: RelayFlags::Ping,
                                src: cfg.device_id.clone(),
                                dst: String::new(),
                                payload: Vec::new(),
                            };
                            if let Ok(bytes) = ping.encode() {
                                if ws_sink.send(WsMessage::Binary(bytes.into())).await.is_err() {
                                    break;
                                }
                            }
                            let dst = active_master.lock().await.clone();
                            let current_ip = observed_public_ip.lock().await.clone();
                            let mut hb_body = json!({
                                "status": "online",
                                "version": env!("CARGO_PKG_VERSION"),
                                "agent_version": env!("CARGO_PKG_VERSION"),
                            });
                            if let (Some(ip), Some(obj)) = (current_ip, hb_body.as_object_mut()) {
                                obj.insert("public_ip".to_string(), json!(ip));
                            }
                            let hb = DeviceMessage {
                                v: 1,
                                kind: "heartbeat".to_string(),
                                req_id: format!("hb-{}", now_ms()),
                                cluster_id: cfg.cluster_id.clone(),
                                device_id: cfg.device_id.clone(),
                                ts_ms: now_ms(),
                                body: hb_body,
                            };
                            if send_encrypted_frame(&mut ws_sink, &e2e_key, &cfg.device_id, &dst, &hb).await.is_err() {
                                break;
                            }
                        }
                        Some((dst, msg)) = outbound_rx.recv() => {
                            if send_encrypted_frame(&mut ws_sink, &e2e_key, &cfg.device_id, &dst, &msg).await.is_err() {
                                push_ring(&offline_ring, (dst, msg)).await;
                                break;
                            }
                        }
                        incoming = ws_stream.next() => {
                            match incoming {
                                Some(Ok(WsMessage::Binary(bin))) => {
                                    match RelayFrame::decode(&bin) {
                                        Ok(frame) => {
                                            match frame.flags {
                                                RelayFlags::Ping => {
                                                    let pong = RelayFrame {
                                                        flags: RelayFlags::Pong,
                                                        src: cfg.device_id.clone(),
                                                        dst: frame.src,
                                                        payload: frame.payload,
                                                    };
                                                    if let Ok(bytes) = pong.encode() {
                                                        let _ = ws_sink.send(WsMessage::Binary(bytes.into())).await;
                                                    }
                                                }
                                                RelayFlags::Pong => {}
                                                RelayFlags::ErrRate => {
                                                    eprintln!("[relay] control error frame {:?} from '{}' -> '{}'", frame.flags, frame.src, frame.dst);
                                                    file_transfers.notify_rate_limited().await;
                                                }
                                                RelayFlags::ErrOffline | RelayFlags::ErrSpoofed => {
                                                    eprintln!("[relay] control error frame {:?} from '{}' -> '{}'", frame.flags, frame.src, frame.dst);
                                                }
                                                RelayFlags::Data => {
                                                    match frame.payload.first().copied() {
                                                        Some(FILE_ENVELOPE_VERSION) => {
                                                            match open_file_frame(
                                                                &e2e_key,
                                                                &cfg.cluster_id,
                                                                &frame.src,
                                                                &cfg.device_id,
                                                                &frame.payload,
                                                            ) {
                                                                Ok(file_frame) => {
                                                                    if inbound_file_tx.send((frame.src, file_frame)).await.is_err() {
                                                                        eprintln!("[relay] inbound file worker closed");
                                                                    }
                                                                }
                                                                Err(e) => {
                                                                    eprintln!("[relay] rejected 0xE3 file frame from '{}': {e}", frame.src);
                                                                }
                                                            }
                                                        }
                                                        Some(E2E_ENVELOPE_VERSION) => {
                                                            match open_device_message(
                                                                &e2e_key,
                                                                &cfg.cluster_id,
                                                                &frame.src,
                                                                &cfg.device_id,
                                                                &frame.payload,
                                                            ) {
                                                                Ok(msg) => {
                                                                    *active_master.lock().await = frame.src.clone();
                                                                    handle_device_message(
                                                                        &cfg,
                                                                        &policy,
                                                                        &executor,
                                                                        &mcp_manager,
                                                                        &file_transfers,
                                                                        &relay_bridge,
                                                                        &observed_public_ip,
                                                                        &outbound_tx,
                                                                        &updating_flag,
                                                                        &restart_slot,
                                                                        &frame.src,
                                                                        msg,
                                                                    ).await;
                                                                }
                                                                Err(e) => {
                                                                    eprintln!("[relay] rejected E2E frame from '{}': {e}", frame.src);
                                                                }
                                                            }
                                                        }
                                                        other => {
                                                            eprintln!("[relay] unsupported E2E payload version {:?} from '{}'", other, frame.src);
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        Err(e) => eprintln!("[relay] malformed binary frame: {e}"),
                                    }
                                }
                                Some(Ok(WsMessage::Ping(p))) => {
                                    let _ = ws_sink.send(WsMessage::Pong(p)).await;
                                }
                                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => {
                                    break;
                                }
                                _ => {}
                            }
                        }
                        Some(out_file) = outbound_file_rx.recv() => {
                            if send_encrypted_file_frame(
                                &mut ws_sink,
                                &e2e_key,
                                &cfg.cluster_id,
                                &cfg.device_id,
                                &out_file.dst,
                                &out_file.frame,
                            ).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                // Abort in-flight file transfer handles cleanly when WS disconnects and drain stale frames.
                file_transfers
                    .fail_all_for_disconnect("relay websocket disconnected")
                    .await;
                while outbound_file_rx.try_recv().is_ok() {}
            }
            Err(e) => {
                eprintln!("[relay] connect error: {e}; retrying in {backoff_ms}ms");
            }
        }

        // Drain outbound channel into ring buffer while offline
        while let Ok(item) = outbound_rx.try_recv() {
            push_ring(&offline_ring, item).await;
        }
        if let Ok(plan) = restart_rx.try_recv() {
            mcp_reaper_handle.abort();
            mcp_manager.shutdown_all().await;
            drop(relay_bridge);
            return Ok(AgentExit::Restart(plan));
        }
        tokio::select! {
            Ok(plan) = &mut restart_rx => {
                mcp_reaper_handle.abort();
                mcp_manager.shutdown_all().await;
                drop(relay_bridge);
                return Ok(AgentExit::Restart(plan));
            }
            _ = tokio::time::sleep(Duration::from_millis(backoff_ms)) => {}
        }
        backoff_ms = (backoff_ms * 2).min(15_000);
    }
}

async fn handle_device_message(
    cfg: &AgentConfig,
    policy: &Arc<std::sync::RwLock<Policy>>,
    executor: &Arc<Executor>,
    mcp_manager: &Arc<McpManager>,
    file_transfers: &Arc<FileTransferManager>,
    relay_bridge: &Option<Arc<RelayBridge>>,
    observed_public_ip: &Arc<Mutex<Option<String>>>,
    outbound_tx: &mpsc::Sender<(String, DeviceMessage)>,
    updating_flag: &Arc<AtomicBool>,
    restart_slot: &Arc<Mutex<Option<oneshot::Sender<RestartPlan>>>>,
    src_node: &str,
    msg: DeviceMessage,
) {
    match msg.kind.as_str() {
        "rpc_req" => {
            let method = msg
                .body
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let params = msg.body.get("params").cloned().unwrap_or_else(|| json!({}));
            let timeout_ms = msg.body.get("timeout_ms").and_then(|v| v.as_u64());

            if method == "mcu_ota_cache" {
                let body = if let Some(ref bridge) = relay_bridge {
                    let action = params.get("action").and_then(|v| v.as_str()).unwrap_or("put");
                    let mcu_id = params.get("mcu_id").and_then(|v| v.as_str()).unwrap_or("");
                    let version = params.get("version").and_then(|v| v.as_str()).unwrap_or("");
                    match action {
                        "get" => match bridge.read_ota_artifact(mcu_id, version).await {
                            Ok(bytes) => json!({
                                "ok": true,
                                "result": {
                                    "size": bytes.len(),
                                    "firmware_b64": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)
                                }
                            }),
                            Err(e) => json!({ "ok": false, "error": e }),
                        },
                        _ => {
                            let b64 = params.get("firmware_b64").and_then(|v| v.as_str()).unwrap_or("");
                            match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64) {
                                Ok(bytes) => match bridge.cache_ota_artifact(mcu_id, version, &bytes).await {
                                    Ok(path) => json!({ "ok": true, "result": { "path": path.to_string_lossy(), "size": bytes.len() } }),
                                    Err(e) => json!({ "ok": false, "error": e }),
                                },
                                Err(e) => json!({ "ok": false, "error": format!("invalid firmware_b64: {e}") }),
                            }
                        }
                    }
                } else {
                    json!({ "ok": false, "error": "--relay not enabled" })
                };
                let resp = DeviceMessage {
                    v: 1,
                    kind: "rpc_resp".to_string(),
                    req_id: msg.req_id,
                    cluster_id: cfg.cluster_id.clone(),
                    device_id: cfg.device_id.clone(),
                    ts_ms: now_ms(),
                    body,
                };
                let _ = outbound_tx.send((src_node.to_string(), resp)).await;
                return;
            }

            if method == "self_update" || method == "agent.update" {
                let target_version = params
                    .get("target_version")
                    .or_else(|| params.get("version"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let master_version = params
                    .get("master_version")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                let mirrors: Vec<String> = params
                    .get("mirrors")
                    .or_else(|| params.get("download_mirrors"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                let asset = params
                    .get("asset")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let expected_sha256 = params
                    .get("sha256")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let force = params
                    .get("force")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if target_version.is_empty() {
                    let resp = DeviceMessage {
                        v: 1,
                        kind: "rpc_resp".to_string(),
                        req_id: msg.req_id,
                        cluster_id: cfg.cluster_id.clone(),
                        device_id: cfg.device_id.clone(),
                        ts_ms: now_ms(),
                        body: json!({ "ok": false, "error": "self_update requires 'target_version'" }),
                    };
                    let _ = outbound_tx.send((src_node.to_string(), resp)).await;
                    return;
                }

                if updating_flag
                    .compare_exchange(false, true, AtomicOrdering::SeqCst, AtomicOrdering::SeqCst)
                    .is_err()
                {
                    let resp = DeviceMessage {
                        v: 1,
                        kind: "rpc_resp".to_string(),
                        req_id: msg.req_id,
                        cluster_id: cfg.cluster_id.clone(),
                        device_id: cfg.device_id.clone(),
                        ts_ms: now_ms(),
                        body: json!({ "ok": false, "error": "self_update already in progress" }),
                    };
                    let _ = outbound_tx.send((src_node.to_string(), resp)).await;
                    return;
                }

                let upd_req = SelfUpdateRequest {
                    target_version,
                    master_version,
                    mirrors,
                    asset,
                    expected_sha256,
                    force,
                };
                let relay_url = cfg.relay_url.clone();
                let ota_dir = cfg.ota_cache_dir.clone();
                let state_path = cfg.updater_state_path.clone();
                #[cfg(test)]
                let install_target = cfg.self_update_target.clone();
                #[cfg(not(test))]
                let install_target: Option<PathBuf> = None;

                let out = outbound_tx.clone();
                let flag = Arc::clone(updating_flag);
                let restart_slot = Arc::clone(restart_slot);
                let cluster_id = cfg.cluster_id.clone();
                let device_id = cfg.device_id.clone();
                let dst = src_node.to_string();
                let req_id = msg.req_id.clone();

                tokio::spawn(async move {
                    let res = execute_self_update(
                        &upd_req,
                        &relay_url,
                        ota_dir.as_deref(),
                        state_path.as_deref(),
                        install_target.as_deref(),
                    )
                    .await;
                    match res {
                        Ok(outcome) => {
                            let body = json!({
                                "ok": true,
                                "result": {
                                    "status": outcome.status,
                                    "previous_version": outcome.previous_version,
                                    "target_version": outcome.target_version,
                                    "installed_path": outcome.installed_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
                                    "sha256": outcome.sha256,
                                    "mirror": outcome.mirror,
                                }
                            });
                            let resp = DeviceMessage {
                                v: 1,
                                kind: "rpc_resp".to_string(),
                                req_id,
                                cluster_id,
                                device_id,
                                ts_ms: now_ms(),
                                body,
                            };
                            let _ = out.send((dst, resp)).await;

                            if let Some(plan) = outcome.restart_plan {
                                // Allow the encrypted rpc_resp frame to flush before tearing down WS and restarting.
                                tokio::time::sleep(Duration::from_millis(350)).await;
                                if let Some(tx) = restart_slot.lock().await.take() {
                                    let _ = tx.send(plan);
                                }
                            } else {
                                flag.store(false, AtomicOrdering::SeqCst);
                            }
                        }
                        Err(err) => {
                            flag.store(false, AtomicOrdering::SeqCst);
                            let resp = DeviceMessage {
                                v: 1,
                                kind: "rpc_resp".to_string(),
                                req_id,
                                cluster_id,
                                device_id,
                                ts_ms: now_ms(),
                                body: json!({ "ok": false, "error": err }),
                            };
                            let _ = out.send((dst, resp)).await;
                        }
                    }
                });
                return;
            }

            if method == "probe" {
                let policy_snap = policy.read().unwrap_or_else(|e| e.into_inner()).clone();
                let mcp_summary = mcp_manager.catalog_summary().await;
                let mut manifest = CapabilityProber::probe_with_mcp(
                    &policy_snap,
                    &cfg.device_id,
                    cfg.relay_enabled,
                    Some(&cfg.mqtt_bind),
                    cfg.uart_device.as_deref(),
                    Some(mcp_summary),
                );
                manifest.public_ip = observed_public_ip.lock().await.clone();
                let resp = DeviceMessage {
                    v: 1,
                    kind: "rpc_resp".to_string(),
                    req_id: msg.req_id,
                    cluster_id: cfg.cluster_id.clone(),
                    device_id: cfg.device_id.clone(),
                    ts_ms: now_ms(),
                    body: json!({ "ok": true, "result": manifest }),
                };
                let _ = outbound_tx.send((src_node.to_string(), resp)).await;
                return;
            }

            if method == "set_sandbox" || method == "sandbox.set" {
                match executor.apply_sandbox_level(&params) {
                    Ok(mut result_val) => {
                        mcp_manager.on_sandbox_changed().await;
                        let policy_snap = executor.policy_snapshot();
                        let mcp_summary = mcp_manager.catalog_summary().await;
                        let mut manifest = CapabilityProber::probe_with_mcp(
                            &policy_snap,
                            &cfg.device_id,
                            cfg.relay_enabled,
                            Some(&cfg.mqtt_bind),
                            cfg.uart_device.as_deref(),
                            Some(mcp_summary),
                        );
                        manifest.public_ip = observed_public_ip.lock().await.clone();
                        if let Some(obj) = result_val.as_object_mut() {
                            obj.insert(
                                "manifest".to_string(),
                                serde_json::to_value(&manifest).unwrap_or_else(|_| json!({})),
                            );
                        }
                        let resp = DeviceMessage {
                            v: 1,
                            kind: "rpc_resp".to_string(),
                            req_id: msg.req_id,
                            cluster_id: cfg.cluster_id.clone(),
                            device_id: cfg.device_id.clone(),
                            ts_ms: now_ms(),
                            body: json!({ "ok": true, "result": result_val }),
                        };
                        let _ = outbound_tx.send((src_node.to_string(), resp)).await;

                        let manifest_msg = DeviceMessage {
                            v: 1,
                            kind: "manifest".to_string(),
                            req_id: format!("manifest-{}", now_ms()),
                            cluster_id: cfg.cluster_id.clone(),
                            device_id: cfg.device_id.clone(),
                            ts_ms: now_ms(),
                            body: build_manifest_body(&manifest, cfg.enroll_id.as_deref()),
                        };
                        let _ = outbound_tx
                            .send((src_node.to_string(), manifest_msg))
                            .await;
                    }
                    Err(e) => {
                        let resp = DeviceMessage {
                            v: 1,
                            kind: "rpc_resp".to_string(),
                            req_id: msg.req_id,
                            cluster_id: cfg.cluster_id.clone(),
                            device_id: cfg.device_id.clone(),
                            ts_ms: now_ms(),
                            body: json!({ "ok": false, "error": e }),
                        };
                        let _ = outbound_tx.send((src_node.to_string(), resp)).await;
                    }
                }
                return;
            }

            if matches!(method.as_str(), "file.pull.open" | "file_pull_open") {
                let open_res = file_transfers.open_pull(src_node, &params).await;
                match open_res {
                    Ok((result, task)) => {
                        let resp = DeviceMessage {
                            v: 1,
                            kind: "rpc_resp".to_string(),
                            req_id: msg.req_id,
                            cluster_id: cfg.cluster_id.clone(),
                            device_id: cfg.device_id.clone(),
                            ts_ms: now_ms(),
                            body: json!({ "ok": true, "result": result }),
                        };
                        let _ = outbound_tx.send((src_node.to_string(), resp)).await;
                        tokio::spawn(task.run());
                    }
                    Err(error) => {
                        let resp = DeviceMessage {
                            v: 1,
                            kind: "rpc_resp".to_string(),
                            req_id: msg.req_id,
                            cluster_id: cfg.cluster_id.clone(),
                            device_id: cfg.device_id.clone(),
                            ts_ms: now_ms(),
                            body: json!({ "ok": false, "error": error }),
                        };
                        let _ = outbound_tx.send((src_node.to_string(), resp)).await;
                    }
                }
                return;
            }

            if matches!(method.as_str(), "file.push.open" | "file_push_open") {
                let body = match file_transfers.open_push(src_node, &params).await {
                    Ok(result) => json!({ "ok": true, "result": result }),
                    Err(error) => json!({ "ok": false, "error": error }),
                };
                let resp = DeviceMessage {
                    v: 1,
                    kind: "rpc_resp".to_string(),
                    req_id: msg.req_id,
                    cluster_id: cfg.cluster_id.clone(),
                    device_id: cfg.device_id.clone(),
                    ts_ms: now_ms(),
                    body,
                };
                let _ = outbound_tx.send((src_node.to_string(), resp)).await;
                return;
            }

            if matches!(method.as_str(), "file.transfer.abort" | "file_transfer_abort") {
                let body = match file_transfers.abort_transfer(src_node, &params).await {
                    Ok(result) => json!({ "ok": true, "result": result }),
                    Err(error) => json!({ "ok": false, "error": error }),
                };
                let resp = DeviceMessage {
                    v: 1,
                    kind: "rpc_resp".to_string(),
                    req_id: msg.req_id,
                    cluster_id: cfg.cluster_id.clone(),
                    device_id: cfg.device_id.clone(),
                    ts_ms: now_ms(),
                    body,
                };
                let _ = outbound_tx.send((src_node.to_string(), resp)).await;
                return;
            }
            if is_mcp_rpc_method(&method) {
                let mcp = Arc::clone(mcp_manager);
                let out = outbound_tx.clone();
                let cluster_id = cfg.cluster_id.clone();
                let device_id = cfg.device_id.clone();
                let dst = src_node.to_string();
                let req_id = msg.req_id.clone();
                let is_set_policy = matches!(method.as_str(), "mcp.server.set_policy" | "mcp_set_policy");

                tokio::spawn(async move {
                    let res = mcp.dispatch_rpc(&method, &params, timeout_ms).await;
                    let ok_flag = res.is_ok();
                    let body = match res {
                        Ok(result) => json!({ "ok": true, "result": result }),
                        Err(error) => json!({ "ok": false, "error": error }),
                    };
                    let resp = DeviceMessage {
                        v: 1,
                        kind: "rpc_resp".to_string(),
                        req_id,
                        cluster_id: cluster_id.clone(),
                        device_id: device_id.clone(),
                        ts_ms: now_ms(),
                        body,
                    };
                    let _ = out.send((dst.clone(), resp)).await;

                    if is_set_policy && ok_flag {
                        let changed = mcp.build_catalog_changed_event().await;
                        let ev = DeviceMessage {
                            v: 1,
                            kind: "event".to_string(),
                            req_id: format!("mcp-evt-{}", now_ms()),
                            cluster_id,
                            device_id,
                            ts_ms: now_ms(),
                            body: json!({
                                "event": "mcp.catalog_changed",
                                "catalog_hash": changed.catalog_hash,
                                "summary": changed.summary,
                                "servers": changed.servers,
                            }),
                        };
                        let _ = out.send((dst, ev)).await;
                    }
                });
                return;
            }

            let exec = Arc::clone(executor);
            let out = outbound_tx.clone();
            let cluster_id = cfg.cluster_id.clone();
            let device_id = cfg.device_id.clone();
            let dst = src_node.to_string();
            let req_id = msg.req_id.clone();

            tokio::spawn(async move {
                let body = exec.dispatch(&method, &params, timeout_ms).await;
                let resp = DeviceMessage {
                    v: 1,
                    kind: "rpc_resp".to_string(),
                    req_id,
                    cluster_id,
                    device_id,
                    ts_ms: now_ms(),
                    body,
                };
                let _ = out.send((dst, resp)).await;
            });
        }
        "relay_envelope" => {
            if let Some(ref bridge) = relay_bridge {
                match serde_json::from_value::<RelayEnvelope>(msg.body) {
                    Ok(env) => {
                        if let Err(e) = bridge.publish_downlink(&env).await {
                            eprintln!("[relay_bridge] downlink error: {e}");
                        }
                    }
                    Err(e) => eprintln!("[relay_bridge] invalid RelayEnvelope JSON: {e}"),
                }
            } else {
                eprintln!("[relay] received relay_envelope but --relay is not enabled");
            }
        }
        _ => {}
    }
}

async fn run_signal_loop(
    cfg: AgentConfig,
    endpoints: RelayEndpoints,
    observed_public_ip: Arc<Mutex<Option<String>>>,
) {
    let mut backoff_ms = 1000u64;
    loop {
        let stun_servers = match fetch_bootstrap(&endpoints.bootstrap_url, &cfg.token).await {
            Ok(b) => {
                if let Some(ip) = clean_ip(b.observed_ip.as_deref()) {
                    *observed_public_ip.lock().await = Some(ip);
                }
                b.stun_servers
            }
            Err(_) => Vec::new(),
        };

        if let Ok(mut ws) = connect_ws_bearer(&endpoints.signal_url, &cfg.token).await {
            backoff_ms = 1000;
            let mut public_addr: Option<String> = None;
            if let Some(stun_srv) = stun_servers.first() {
                if let Ok(sock) = UdpSocket::bind("0.0.0.0:0").await {
                    if let Ok(addr) = stun_probe(&sock, stun_srv, Duration::from_millis(1500)).await {
                        let ip_str = addr.ip().to_string();
                        {
                            let mut guard = observed_public_ip.lock().await;
                            if guard.is_none() {
                                *guard = Some(ip_str);
                            }
                        }
                        public_addr = Some(addr.to_string());
                    }
                }
            }

            let reg = SignalMessage {
                cluster_id: Some(cfg.cluster_id.clone()),
                node_id: Some(cfg.device_id.clone()),
                tier: Some("os".to_string()),
                addr: public_addr.clone(),
                ts_ms: Some(now_ms()),
                ..SignalMessage::new("register")
            };
            let _ = ws
                .send(WsMessage::Text(serde_json::to_string(&reg).unwrap().into()))
                .await;

            let mut hb = tokio::time::interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = hb.tick() => {
                        let msg = SignalMessage {
                            cluster_id: Some(cfg.cluster_id.clone()),
                            node_id: Some(cfg.device_id.clone()),
                            ts_ms: Some(now_ms()),
                            ..SignalMessage::new("heartbeat")
                        };
                        if ws.send(WsMessage::Text(serde_json::to_string(&msg).unwrap().into())).await.is_err() {
                            break;
                        }
                    }
                    incoming = ws.next() => {
                        match incoming {
                            Some(Ok(WsMessage::Text(txt))) => {
                                if let Ok(sig) = serde_json::from_str::<SignalMessage>(&txt) {
                                    if matches!(sig.msg_type.as_str(), "p2p_offer" | "p2p_punch") {
                                        if let (Some(peer_id), Some(addr_str)) = (sig.from.as_deref(), sig.addr.as_deref()) {
                                            if let Ok(peer_addr) = addr_str.parse::<SocketAddr>() {
                                                let cluster = cfg.cluster_id.clone();
                                                let local_id = cfg.device_id.clone();
                                                let peer = peer_id.to_string();
                                                if let Ok(sock) = UdpSocket::bind("0.0.0.0:0").await {
                                                    let punch = udp_punch_peer(
                                                        &sock,
                                                        peer_addr,
                                                        &cluster,
                                                        &local_id,
                                                        &peer,
                                                        Duration::from_millis(2500),
                                                    ).await;
                                                    if punch.is_err() {
                                                        let fb = SignalMessage {
                                                            cluster_id: Some(cluster),
                                                            from: Some(local_id),
                                                            to: Some(peer),
                                                            ..SignalMessage::new("relay_fallback")
                                                        };
                                                        let _ = ws.send(WsMessage::Text(serde_json::to_string(&fb).unwrap().into())).await;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                            _ => {}
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(30_000);
    }
}

async fn send_encrypted_frame<S>(
    ws_sink: &mut S,
    e2e_key: &[u8; 32],
    src_id: &str,
    dst_id: &str,
    msg: &DeviceMessage,
) -> Result<(), String>
where
    S: SinkExt<WsMessage> + Unpin,
    S::Error: std::fmt::Display,
{
    let sealed = seal_device_message(e2e_key, src_id, dst_id, msg)?;
    let frame = RelayFrame {
        flags: RelayFlags::Data,
        src: src_id.to_string(),
        dst: dst_id.to_string(),
        payload: sealed,
    };
    let wire = frame.encode()?;
    ws_sink
        .send(WsMessage::Binary(wire.into()))
        .await
        .map_err(|e| format!("WS send error: {e}"))
}

async fn send_encrypted_file_frame<S>(
    ws_sink: &mut S,
    e2e_key: &[u8; 32],
    cluster_id: &str,
    src_id: &str,
    dst_id: &str,
    file_frame: &FileFrame,
) -> Result<(), String>
where
    S: SinkExt<WsMessage> + Unpin,
    S::Error: std::fmt::Display,
{
    let sealed = seal_file_frame(e2e_key, cluster_id, src_id, dst_id, file_frame)?;
    let frame = RelayFrame {
        flags: RelayFlags::Data,
        src: src_id.to_string(),
        dst: dst_id.to_string(),
        payload: sealed,
    };
    let wire = frame.encode()?;
    ws_sink
        .send(WsMessage::Binary(wire.into()))
        .await
        .map_err(|e| format!("WS file frame send error: {e}"))
}

async fn push_ring(
    ring: &Arc<Mutex<VecDeque<(String, DeviceMessage)>>>,
    item: (String, DeviceMessage),
) {
    let mut guard = ring.lock().await;
    if guard.len() >= OFFLINE_RING_CAP {
        guard.pop_front();
    }
    guard.push_back(item);
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn mock_relay_ws_receives_manifest_and_executes_rpc() {
        let ws_dir = std::env::temp_dir().join(format!("neo_transport_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws_dir);
        std::fs::create_dir_all(&ws_dir).unwrap();
        let policy = Arc::new(std::sync::RwLock::new(
            Policy::from_toml_str(&format!(
                "allowed_workspaces = [\"{}\"]\nallowed_commands = [\"echo\"]\n",
                ws_dir.display()
            ))
            .unwrap(),
        ));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let e2e_secret = "test-e2e-secret";
        let cluster_id = "cluster-e2e";
        let e2e_key = derive_e2e_key(cluster_id, e2e_secret);

        let server_task = tokio::spawn(async move {
            let (tx_done, mut rx_done) = mpsc::channel::<()>(1);
            loop {
                tokio::select! {
                    _ = rx_done.recv() => break,
                    accept_res = listener.accept() => {
                        let (mut stream, _) = accept_res.unwrap();
                        let tx_done = tx_done.clone();
                        tokio::spawn(async move {
                            let mut peek_buf = [0u8; 512];
                            let n = stream.peek(&mut peek_buf).await.unwrap_or(0);
                            let head = String::from_utf8_lossy(&peek_buf[..n]);
                            if head.starts_with("GET /v1/bootstrap ") {
                                let mut sink = [0u8; 1024];
                                let _ = stream.read(&mut sink).await;
                                let body = br#"{"stun_servers":[],"observed_ip":"113.87.160.22"}"#;
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body.len()
                                );
                                let _ = stream.write_all(resp.as_bytes()).await;
                                let _ = stream.write_all(body).await;
                                return;
                            }
                            if head.starts_with("GET /v1/signal ") {
                                if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                                    let _ = ws.next().await;
                                }
                                return;
                            }
                            if head.starts_with("GET /v1/relay ") {
                                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                                let bin = match ws.next().await.unwrap().unwrap() {
                                    WsMessage::Binary(b) => b,
                                    other => panic!("expected binary manifest frame, got {other:?}"),
                                };
                                let rf = RelayFrame::decode(&bin).unwrap();
                                assert_eq!(rf.flags, RelayFlags::Data);
                                assert_eq!(rf.src, "os-1");
                                assert_eq!(rf.dst, "master-1");
                                let manifest_msg =
                                    open_device_message(&e2e_key, cluster_id, "os-1", "master-1", &rf.payload)
                                        .unwrap();
                                assert_eq!(manifest_msg.kind, "manifest");
                                assert_eq!(
                                    manifest_msg.body.get("version").and_then(|v| v.as_str()),
                                    Some(env!("CARGO_PKG_VERSION"))
                                );
                                assert_eq!(
                                    manifest_msg.body.get("enroll_id").and_then(|v| v.as_str()),
                                    Some("enr-test-01")
                                );
                                assert_eq!(
                                    manifest_msg.body.get("agent_version").and_then(|v| v.as_str()),
                                    Some(env!("CARGO_PKG_VERSION"))
                                );
                                assert_eq!(
                                    manifest_msg.body.get("public_ip").and_then(|v| v.as_str()),
                                    Some("113.87.160.22")
                                );

                                let req = DeviceMessage {
                                    v: 1,
                                    kind: "rpc_req".to_string(),
                                    req_id: "req-42".to_string(),
                                    cluster_id: cluster_id.to_string(),
                                    device_id: "os-1".to_string(),
                                    ts_ms: 1000,
                                    body: json!({"method": "exec", "params": {"program": "echo", "args": ["ok-ws"]}}),
                                };
                                let sealed = seal_device_message(&e2e_key, "master-1", "os-1", &req).unwrap();
                                let req_frame = RelayFrame {
                                    flags: RelayFlags::Data,
                                    src: "master-1".to_string(),
                                    dst: "os-1".to_string(),
                                    payload: sealed,
                                };
                                ws.send(WsMessage::Binary(req_frame.encode().unwrap().into()))
                                    .await
                                    .unwrap();

                                let resp_bin = match ws.next().await.unwrap().unwrap() {
                                    WsMessage::Binary(b) => b,
                                    other => panic!("expected binary rpc_resp, got {other:?}"),
                                };
                                let resp_rf = RelayFrame::decode(&resp_bin).unwrap();
                                let resp_msg = open_device_message(
                                    &e2e_key,
                                    cluster_id,
                                    "os-1",
                                    "master-1",
                                    &resp_rf.payload,
                                )
                                .unwrap();
                                assert_eq!(resp_msg.kind, "rpc_resp");
                                assert_eq!(resp_msg.req_id, "req-42");
                                assert_eq!(resp_msg.body["ok"], true);
                                assert!(resp_msg.body["result"]["stdout"]
                                    .as_str()
                                    .unwrap()
                                    .contains("ok-ws"));
                                let _ = tx_done.send(()).await;
                            }
                        });
                    }
                }
            }
        });

        let cfg = AgentConfig {
            cluster_id: cluster_id.to_string(),
            device_id: "os-1".to_string(),
            master_id: "master-1".to_string(),
            relay_url: format!("http://{addr}"),
            token: "neo1.dummy.sig".to_string(),
            e2e_secret: e2e_secret.to_string(),
            enroll_id: Some("enr-test-01".to_string()),
            relay_enabled: false,
            mqtt_bind: "127.0.0.1:0".to_string(),
            uart_device: None,
            ota_cache_dir: None,
            updater_state_path: None,
            policy_path: None,
            sandbox_override_path: None,
            self_update_target: None,
        };

        let agent_task = tokio::spawn(async move {
            let _ = run_agent(cfg, policy).await;
        });

        tokio::time::timeout(Duration::from_secs(5), server_task)
            .await
            .unwrap()
            .unwrap();
        agent_task.abort();
        let _ = std::fs::remove_dir_all(&ws_dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mock_relay_ws_executes_self_update_rpc_and_exits_with_restart_plan() {
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::PermissionsExt;

        let tmp = std::env::temp_dir().join(format!(
            "neo_transport_self_update_{}_{}",
            std::process::id(),
            now_ms()
        ));
        let ws_dir = tmp.join("ws");
        let pkg_dir = tmp.join("pkg");
        let ota_dir = tmp.join("ota");
        let bin_dir = tmp.join("bin");
        std::fs::create_dir_all(&ws_dir).unwrap();
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();

        let new_bin = pkg_dir.join("neo-agent-os");
        std::fs::write(&new_bin, "#!/bin/sh\necho 'neo-agent-os 9.8.7'\n").unwrap();
        std::fs::set_permissions(&new_bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let asset = crate::updater::native_asset_name("9.8.7").unwrap();
        let archive_path = tmp.join(&asset);
        let st = std::process::Command::new("tar")
            .args([
                "-czf",
                archive_path.to_string_lossy().as_ref(),
                "-C",
                pkg_dir.to_string_lossy().as_ref(),
                "neo-agent-os",
            ])
            .status()
            .unwrap();
        assert!(st.success());
        let archive_bytes = std::fs::read(&archive_path).unwrap();
        let archive_sha = hex::encode(Sha256::digest(&archive_bytes));
        let sums_bytes = format!("{archive_sha}  {asset}\n").into_bytes();

        let target_exe = bin_dir.join("neo-agent-os");
        std::fs::write(&target_exe, "#!/bin/sh\necho 'neo-agent-os 0.1.0'\n").unwrap();
        std::fs::set_permissions(&target_exe, std::fs::Permissions::from_mode(0o755)).unwrap();

        let policy = Arc::new(std::sync::RwLock::new(
            Policy::from_toml_str(&format!(
                "allowed_workspaces = [\"{}\"]\n",
                ws_dir.display()
            ))
            .unwrap(),
        ));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let e2e_secret = "test-update-secret";
        let cluster_id = "cluster-upd";
        let e2e_key = derive_e2e_key(cluster_id, e2e_secret);
        let asset_srv = asset.clone();
        let archive_srv = archive_bytes.clone();
        let sums_srv = sums_bytes.clone();

        let server_task = tokio::spawn(async move {
            let (tx_done, mut rx_done) = mpsc::channel::<()>(1);
            loop {
                tokio::select! {
                    _ = rx_done.recv() => break,
                    accept_res = listener.accept() => {
                        let (mut stream, _) = accept_res.unwrap();
                        let tx_done = tx_done.clone();
                        let asset_c = asset_srv.clone();
                        let archive_c = archive_srv.clone();
                        let sums_c = sums_srv.clone();
                        tokio::spawn(async move {
                            let mut peek_buf = [0u8; 512];
                            let n = stream.peek(&mut peek_buf).await.unwrap_or(0);
                            let head = String::from_utf8_lossy(&peek_buf[..n]);
                            if head.starts_with(&format!("GET /dl/v9.8.7/{asset_c} ")) {
                                let mut sink = [0u8; 1024];
                                let _ = stream.read(&mut sink).await;
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    archive_c.len()
                                );
                                let _ = stream.write_all(resp.as_bytes()).await;
                                let _ = stream.write_all(&archive_c).await;
                                return;
                            }
                            if head.starts_with("GET /dl/v9.8.7/SHA256SUMS.txt ") {
                                let mut sink = [0u8; 1024];
                                let _ = stream.read(&mut sink).await;
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    sums_c.len()
                                );
                                let _ = stream.write_all(resp.as_bytes()).await;
                                let _ = stream.write_all(&sums_c).await;
                                return;
                            }
                            if head.starts_with("GET /v1/bootstrap ") {
                                let mut sink = [0u8; 1024];
                                let _ = stream.read(&mut sink).await;
                                let body = br#"{"stun_servers":[]}"#;
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body.len()
                                );
                                let _ = stream.write_all(resp.as_bytes()).await;
                                let _ = stream.write_all(body).await;
                                return;
                            }
                            if head.starts_with("GET /v1/signal ") {
                                if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                                    let _ = ws.next().await;
                                }
                                return;
                            }
                            if head.starts_with("GET /v1/relay ") {
                                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                                let _manifest = ws.next().await.unwrap().unwrap();

                                let req = DeviceMessage {
                                    v: 1,
                                    kind: "rpc_req".to_string(),
                                    req_id: "upd-1".to_string(),
                                    cluster_id: cluster_id.to_string(),
                                    device_id: "os-upd".to_string(),
                                    ts_ms: 1000,
                                    body: json!({
                                        "method": "self_update",
                                        "params": {
                                            "target_version": "9.8.7",
                                            "mirrors": [format!("http://{addr}/dl/v9.8.7")],
                                            "asset": asset_c
                                        }
                                    }),
                                };
                                let sealed = seal_device_message(&e2e_key, "master-1", "os-upd", &req).unwrap();
                                let req_frame = RelayFrame {
                                    flags: RelayFlags::Data,
                                    src: "master-1".to_string(),
                                    dst: "os-upd".to_string(),
                                    payload: sealed,
                                };
                                ws.send(WsMessage::Binary(req_frame.encode().unwrap().into()))
                                    .await
                                    .unwrap();

                                let resp_msg = loop {
                                    let resp_bin = match ws.next().await.unwrap().unwrap() {
                                        WsMessage::Binary(b) => b,
                                        WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
                                        other => panic!("expected rpc_resp binary frame, got {other:?}"),
                                    };
                                    let resp_rf = RelayFrame::decode(&resp_bin).unwrap();
                                    if resp_rf.flags != RelayFlags::Data {
                                        continue;
                                    }
                                    let msg = open_device_message(
                                        &e2e_key,
                                        cluster_id,
                                        "os-upd",
                                        "master-1",
                                        &resp_rf.payload,
                                    )
                                    .unwrap();
                                    if msg.kind == "rpc_resp" {
                                        break msg;
                                    }
                                };
                                assert_eq!(resp_msg.kind, "rpc_resp");
                                assert_eq!(resp_msg.req_id, "upd-1");
                                assert_eq!(resp_msg.body["ok"], true);
                                assert_eq!(resp_msg.body["result"]["status"], "restarting");
                                assert_eq!(resp_msg.body["result"]["target_version"], "9.8.7");
                                let _ = tx_done.send(()).await;
                            }
                        });
                    }
                }
            }
        });

        let cfg = AgentConfig {
            cluster_id: cluster_id.to_string(),
            device_id: "os-upd".to_string(),
            master_id: "master-1".to_string(),
            relay_url: format!("http://{addr}"),
            token: "neo1.dummy.sig".to_string(),
            e2e_secret: e2e_secret.to_string(),
            enroll_id: None,
            relay_enabled: false,
            mqtt_bind: "127.0.0.1:0".to_string(),
            uart_device: None,
            ota_cache_dir: Some(ota_dir.clone()),
            updater_state_path: Some(ota_dir.join("updater-state.json")),
            policy_path: None,
            sandbox_override_path: None,
            self_update_target: Some(target_exe.clone()),
        };

        let exit = tokio::time::timeout(Duration::from_secs(10), run_agent(cfg, policy))
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), server_task)
            .await
            .unwrap()
            .unwrap();

        match exit {
            AgentExit::Restart(plan) => {
                assert_eq!(plan.target_version, "9.8.7");
                assert_eq!(plan.binary_path, target_exe);
                assert!(std::fs::read_to_string(&target_exe).unwrap().contains("9.8.7"));
            }
            AgentExit::Stopped => panic!("expected AgentExit::Restart"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn live_set_sandbox_rpc_switches_level_persists_and_emits_updated_manifest() {
        use crate::policy::SandboxLevel;

        let root = std::env::temp_dir().join(format!(
            "neo_transport_sandbox_{}_{}",
            std::process::id(),
            now_ms()
        ));
        let ws_dir = root.join("work");
        let ota_dir = root.join("ota");
        let policy_path = root.join("policy-cluster.toml");
        let override_path = ota_dir.join("sandbox-override.toml");
        std::fs::create_dir_all(&ws_dir).unwrap();
        std::fs::create_dir_all(&ota_dir).unwrap();

        let initial_policy = Policy::from_preset(
            SandboxLevel::Personal,
            vec![ws_dir.to_string_lossy().into_owned()],
            false,
        )
        .unwrap();
        initial_policy.persist_to_file(&policy_path).unwrap();
        let policy = Arc::new(std::sync::RwLock::new(initial_policy));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let e2e_secret = "sandbox-e2e-secret";
        let cluster_id = "cluster-sbx";
        let e2e_key = derive_e2e_key(cluster_id, e2e_secret);
        let ws_file_str = ws_dir.join("ro-check.txt").to_string_lossy().into_owned();
        let policy_path_check = policy_path.clone();

        let server_task = tokio::spawn(async move {
            let (tx_done, mut rx_done) = mpsc::channel::<()>(1);
            loop {
                tokio::select! {
                    _ = rx_done.recv() => break,
                    accept_res = listener.accept() => {
                        let (mut stream, _) = accept_res.unwrap();
                        let tx_done = tx_done.clone();
                        let ws_file_str = ws_file_str.clone();
                        let policy_path_check = policy_path_check.clone();
                        tokio::spawn(async move {
                            let mut peek_buf = [0u8; 512];
                            let n = stream.peek(&mut peek_buf).await.unwrap_or(0);
                            let head = String::from_utf8_lossy(&peek_buf[..n]);
                            if head.starts_with("GET /v1/bootstrap ") {
                                let mut sink = [0u8; 1024];
                                let _ = stream.read(&mut sink).await;
                                let body = br#"{"stun_servers":[]}"#;
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body.len()
                                );
                                let _ = stream.write_all(resp.as_bytes()).await;
                                let _ = stream.write_all(body).await;
                                return;
                            }
                            if head.starts_with("GET /v1/signal ") {
                                if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                                    let _ = ws.next().await;
                                }
                                return;
                            }
                            if head.starts_with("GET /v1/relay ") {
                                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                                async fn recv_non_hb(
                                    ws: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
                                    e2e_key: &[u8; 32],
                                    cluster_id: &str,
                                    src: &str,
                                    dst: &str,
                                ) -> DeviceMessage {
                                    loop {
                                        let bin = match ws.next().await.unwrap().unwrap() {
                                            WsMessage::Binary(b) => b,
                                            _ => continue,
                                        };
                                        let rf = RelayFrame::decode(&bin).unwrap();
                                        if rf.flags != RelayFlags::Data {
                                            continue;
                                        }
                                        let msg = open_device_message(
                                            e2e_key,
                                            cluster_id,
                                            src,
                                            dst,
                                            &rf.payload,
                                        )
                                        .unwrap();
                                        if msg.kind == "heartbeat" {
                                            continue;
                                        }
                                        return msg;
                                    }
                                }
                                let send_rpc = |req_id: &str, method: &str, params: serde_json::Value| -> Vec<u8> {
                                    let req = DeviceMessage {
                                        v: 1,
                                        kind: "rpc_req".to_string(),
                                        req_id: req_id.to_string(),
                                        cluster_id: cluster_id.to_string(),
                                        device_id: "os-sbx".to_string(),
                                        ts_ms: now_ms(),
                                        body: json!({ "method": method, "params": params }),
                                    };
                                    let sealed = seal_device_message(&e2e_key, "master-sbx", "os-sbx", &req).unwrap();
                                    RelayFrame {
                                        flags: RelayFlags::Data,
                                        src: "master-sbx".to_string(),
                                        dst: "os-sbx".to_string(),
                                        payload: sealed,
                                    }
                                    .encode()
                                    .unwrap()
                                };

                                // 1. Initial manifest -> personal
                                let m0 = recv_non_hb(&mut ws, &e2e_key, cluster_id, "os-sbx", "master-sbx").await;
                                assert_eq!(m0.kind, "manifest");
                                assert_eq!(m0.body["sandbox"]["level"], "personal");
                                assert_eq!(m0.body["sandbox"]["unrestricted"], false);
                                assert_eq!(m0.body["sandbox"]["read_only"], false);

                                // 2. Switch to unrestricted via set_sandbox
                                ws.send(WsMessage::Binary(
                                    send_rpc("req-sbx-1", "set_sandbox", json!({"level": "unrestricted"})).into(),
                                ))
                                .await
                                .unwrap();

                                let resp1 = recv_non_hb(&mut ws, &e2e_key, cluster_id, "os-sbx", "master-sbx").await;
                                assert_eq!(resp1.kind, "rpc_resp");
                                assert_eq!(resp1.req_id, "req-sbx-1");
                                assert_eq!(resp1.body["ok"], true);
                                assert_eq!(resp1.body["result"]["level"], "unrestricted");
                                assert_eq!(resp1.body["result"]["persisted"], true);
                                assert_eq!(resp1.body["result"]["manifest"]["sandbox"]["level"], "unrestricted");
                                assert_eq!(resp1.body["result"]["manifest"]["sandbox"]["unrestricted"], true);

                                // Expect fresh manifest emitted immediately after rpc_resp
                                let m1 = recv_non_hb(&mut ws, &e2e_key, cluster_id, "os-sbx", "master-sbx").await;
                                assert_eq!(m1.kind, "manifest");
                                assert_eq!(m1.body["sandbox"]["level"], "unrestricted");
                                assert_eq!(m1.body["sandbox"]["unrestricted"], true);
                                assert!(!m1.body["sandbox"]["allowed_workspaces"].as_array().unwrap().is_empty());

                                // Verify policy file updated on disk
                                let disk = Policy::from_file(&policy_path_check).unwrap();
                                assert!(disk.is_unrestricted());

                                // 3. Probe reflects live unrestricted state
                                ws.send(WsMessage::Binary(
                                    send_rpc("req-probe-1", "probe", json!({})).into(),
                                ))
                                .await
                                .unwrap();
                                let probe_resp = recv_non_hb(&mut ws, &e2e_key, cluster_id, "os-sbx", "master-sbx").await;
                                assert_eq!(probe_resp.kind, "rpc_resp");
                                assert_eq!(probe_resp.req_id, "req-probe-1");
                                assert_eq!(probe_resp.body["ok"], true);
                                assert_eq!(probe_resp.body["result"]["sandbox"]["level"], "unrestricted");

                                // 4. Switch to readonly via sandbox.set alias
                                ws.send(WsMessage::Binary(
                                    send_rpc("req-sbx-2", "sandbox.set", json!({"level": "readonly"})).into(),
                                ))
                                .await
                                .unwrap();
                                let resp2 = recv_non_hb(&mut ws, &e2e_key, cluster_id, "os-sbx", "master-sbx").await;
                                assert_eq!(resp2.kind, "rpc_resp");
                                assert_eq!(resp2.req_id, "req-sbx-2");
                                assert_eq!(resp2.body["ok"], true);
                                assert_eq!(resp2.body["result"]["level"], "readonly");

                                let m2 = recv_non_hb(&mut ws, &e2e_key, cluster_id, "os-sbx", "master-sbx").await;
                                assert_eq!(m2.kind, "manifest");
                                assert_eq!(m2.body["sandbox"]["level"], "readonly");
                                assert_eq!(m2.body["sandbox"]["read_only"], true);

                                // 5. fs_write is now rejected by readonly policy
                                ws.send(WsMessage::Binary(
                                    send_rpc(
                                        "req-write-ro",
                                        "fs_write",
                                        json!({"path": ws_file_str, "content": "denied"}),
                                    )
                                    .into(),
                                ))
                                .await
                                .unwrap();
                                let wr_resp = recv_non_hb(&mut ws, &e2e_key, cluster_id, "os-sbx", "master-sbx").await;
                                assert_eq!(wr_resp.kind, "rpc_resp");
                                assert_eq!(wr_resp.req_id, "req-write-ro");
                                assert_eq!(wr_resp.body["ok"], false);
                                assert!(wr_resp.body["error"].as_str().unwrap().contains("readonly"));

                                let _ = tx_done.send(()).await;
                            }
                        });
                    }
                }
            }
        });

        let cfg = AgentConfig {
            cluster_id: cluster_id.to_string(),
            device_id: "os-sbx".to_string(),
            master_id: "master-sbx".to_string(),
            relay_url: format!("http://{addr}"),
            token: "neo1.dummy.sig".to_string(),
            e2e_secret: e2e_secret.to_string(),
            enroll_id: None,
            relay_enabled: false,
            mqtt_bind: "127.0.0.1:0".to_string(),
            uart_device: None,
            ota_cache_dir: Some(ota_dir),
            updater_state_path: None,
            policy_path: Some(policy_path),
            sandbox_override_path: Some(override_path),
            self_update_target: None,
        };

        let agent_task = tokio::spawn(async move {
            let _ = run_agent(cfg, policy).await;
        });

        tokio::time::timeout(Duration::from_secs(5), server_task)
            .await
            .unwrap()
            .unwrap();
        agent_task.abort();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn locked_sandbox_policy_rejects_set_sandbox_rpc_over_ws() {
        use crate::policy::SandboxLevel;

        let root = std::env::temp_dir().join(format!(
            "neo_transport_locked_{}_{}",
            std::process::id(),
            now_ms()
        ));
        let ws_dir = root.join("work");
        std::fs::create_dir_all(&ws_dir).unwrap();

        let locked_policy = Policy::from_preset(
            SandboxLevel::Personal,
            vec![ws_dir.to_string_lossy().into_owned()],
            true,
        )
        .unwrap();
        let policy = Arc::new(std::sync::RwLock::new(locked_policy));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let e2e_secret = "locked-e2e-secret";
        let cluster_id = "cluster-lock";
        let e2e_key = derive_e2e_key(cluster_id, e2e_secret);

        let server_task = tokio::spawn(async move {
            let (tx_done, mut rx_done) = mpsc::channel::<()>(1);
            loop {
                tokio::select! {
                    _ = rx_done.recv() => break,
                    accept_res = listener.accept() => {
                        let (mut stream, _) = accept_res.unwrap();
                        let tx_done = tx_done.clone();
                        tokio::spawn(async move {
                            let mut peek_buf = [0u8; 512];
                            let n = stream.peek(&mut peek_buf).await.unwrap_or(0);
                            let head = String::from_utf8_lossy(&peek_buf[..n]);
                            if head.starts_with("GET /v1/bootstrap ") {
                                let mut sink = [0u8; 1024];
                                let _ = stream.read(&mut sink).await;
                                let body = br#"{"stun_servers":[]}"#;
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body.len()
                                );
                                let _ = stream.write_all(resp.as_bytes()).await;
                                let _ = stream.write_all(body).await;
                                return;
                            }
                            if head.starts_with("GET /v1/signal ") {
                                if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                                    let _ = ws.next().await;
                                }
                                return;
                            }
                            if head.starts_with("GET /v1/relay ") {
                                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                                async fn recv_non_hb(
                                    ws: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
                                    e2e_key: &[u8; 32],
                                    cluster_id: &str,
                                ) -> DeviceMessage {
                                    loop {
                                        let bin = match ws.next().await.unwrap().unwrap() {
                                            WsMessage::Binary(b) => b,
                                            _ => continue,
                                        };
                                        let rf = RelayFrame::decode(&bin).unwrap();
                                        if rf.flags != RelayFlags::Data {
                                            continue;
                                        }
                                        let msg = open_device_message(
                                            e2e_key,
                                            cluster_id,
                                            "os-lock",
                                            "master-lock",
                                            &rf.payload,
                                        )
                                        .unwrap();
                                        if msg.kind == "heartbeat" {
                                            continue;
                                        }
                                        return msg;
                                    }
                                }
                                // Initial manifest
                                let m0 = recv_non_hb(&mut ws, &e2e_key, cluster_id).await;
                                assert_eq!(m0.kind, "manifest");
                                assert_eq!(m0.body["sandbox"]["locked"], true);

                                // Attempt remote set_sandbox -> must be rejected
                                let req = DeviceMessage {
                                    v: 1,
                                    kind: "rpc_req".to_string(),
                                    req_id: "req-lock-1".to_string(),
                                    cluster_id: cluster_id.to_string(),
                                    device_id: "os-lock".to_string(),
                                    ts_ms: now_ms(),
                                    body: json!({
                                        "method": "set_sandbox",
                                        "params": { "level": "unrestricted" }
                                    }),
                                };
                                let sealed = seal_device_message(&e2e_key, "master-lock", "os-lock", &req).unwrap();
                                let rf = RelayFrame {
                                    flags: RelayFlags::Data,
                                    src: "master-lock".to_string(),
                                    dst: "os-lock".to_string(),
                                    payload: sealed,
                                };
                                ws.send(WsMessage::Binary(rf.encode().unwrap().into())).await.unwrap();

                                let resp = recv_non_hb(&mut ws, &e2e_key, cluster_id).await;
                                assert_eq!(resp.kind, "rpc_resp");
                                assert_eq!(resp.req_id, "req-lock-1");
                                assert_eq!(resp.body["ok"], false);
                                assert!(resp.body["error"].as_str().unwrap().contains("lock_sandbox = true"));
                                let _ = tx_done.send(()).await;
                            }
                        });
                    }
                }
            }
        });

        let cfg = AgentConfig {
            cluster_id: cluster_id.to_string(),
            device_id: "os-lock".to_string(),
            master_id: "master-lock".to_string(),
            relay_url: format!("http://{addr}"),
            token: "neo1.dummy.sig".to_string(),
            e2e_secret: e2e_secret.to_string(),
            enroll_id: None,
            relay_enabled: false,
            mqtt_bind: "127.0.0.1:0".to_string(),
            uart_device: None,
            ota_cache_dir: None,
            updater_state_path: None,
            policy_path: None,
            sandbox_override_path: None,
            self_update_target: None,
        };

        let agent_task = tokio::spawn(async move {
            let _ = run_agent(cfg, policy).await;
        });

        tokio::time::timeout(Duration::from_secs(5), server_task)
            .await
            .unwrap()
            .unwrap();
        agent_task.abort();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn mock_relay_ws_handles_fs_stat_and_binary_0xe3_pull_push() {
        use crate::protocol::FileFrameKind;
        use sha2::{Digest, Sha256};

        let ws_dir = std::env::temp_dir().join(format!(
            "neo_transport_ft_test_{}_{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&ws_dir);
        std::fs::create_dir_all(&ws_dir).unwrap();
        let seed_file = ws_dir.join("seed.bin");
        let seed_bytes: Vec<u8> = (0..(40 * 1024 + 17)).map(|i| ((i * 19 + 3) & 0xFF) as u8).collect();
        std::fs::write(&seed_file, &seed_bytes).unwrap();
        let seed_sha: [u8; 32] = Sha256::digest(&seed_bytes).into();
        let push_target = ws_dir.join("sub/pushed.bin");
        let push_bytes: Vec<u8> = (0..(35 * 1024 + 5)).map(|i| ((i * 7 + 11) & 0xFF) as u8).collect();
        let push_sha: [u8; 32] = Sha256::digest(&push_bytes).into();

        let policy = Arc::new(std::sync::RwLock::new(
            Policy::from_toml_str(&format!(
                "allowed_workspaces = [\"{}\"]\n",
                ws_dir.display().to_string().replace('\\', "\\\\")
            ))
            .unwrap(),
        ));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let e2e_secret = "ft-ws-secret";
        let cluster_id = "cluster-ft-ws";
        let e2e_key = derive_e2e_key(cluster_id, e2e_secret);
        let seed_file_srv = seed_file.clone();
        let seed_bytes_srv = seed_bytes.clone();
        let push_target_srv = push_target.clone();
        let push_bytes_srv = push_bytes.clone();

        let server_task = tokio::spawn(async move {
            let (tx_done, mut rx_done) = mpsc::channel::<()>(1);
            loop {
                tokio::select! {
                    _ = rx_done.recv() => break,
                    accept_res = listener.accept() => {
                        let (mut stream, _) = accept_res.unwrap();
                        let tx_done = tx_done.clone();
                        let seed_file_srv = seed_file_srv.clone();
                        let seed_bytes_srv = seed_bytes_srv.clone();
                        let push_target_srv = push_target_srv.clone();
                        let push_bytes_srv = push_bytes_srv.clone();
                        tokio::spawn(async move {
                            let mut peek_buf = [0u8; 512];
                            let n = stream.peek(&mut peek_buf).await.unwrap_or(0);
                            let head = String::from_utf8_lossy(&peek_buf[..n]);
                            if head.starts_with("GET /v1/bootstrap ") {
                                let mut sink = [0u8; 1024];
                                let _ = stream.read(&mut sink).await;
                                let body = br#"{"stun_servers":[]}"#;
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body.len()
                                );
                                let _ = stream.write_all(resp.as_bytes()).await;
                                let _ = stream.write_all(body).await;
                                return;
                            }
                            if head.starts_with("GET /v1/signal ") {
                                if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                                    let _ = ws.next().await;
                                }
                                return;
                            }
                            if head.starts_with("GET /v1/relay ") {
                                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                                async fn next_app_frame(
                                    ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
                                    e2e_key: &[u8; 32],
                                    cluster_id: &str,
                                ) -> RelayFrame {
                                    loop {
                                        let Some(Ok(WsMessage::Binary(bin))) = ws.next().await else {
                                            continue;
                                        };
                                        let rf = RelayFrame::decode(&bin).unwrap();
                                        if rf.flags != RelayFlags::Data {
                                            continue;
                                        }
                                        if rf.payload.first() == Some(&E2E_ENVELOPE_VERSION) {
                                            if let Ok(m) = open_device_message(
                                                e2e_key,
                                                cluster_id,
                                                &rf.src,
                                                &rf.dst,
                                                &rf.payload,
                                            ) {
                                                if m.kind == "heartbeat" || m.kind == "manifest" {
                                                    continue;
                                                }
                                            }
                                        }
                                        return rf;
                                    }
                                }

                                // Wait for initial manifest frame first
                                loop {
                                    let Some(Ok(WsMessage::Binary(bin))) = ws.next().await else { continue };
                                    let rf = RelayFrame::decode(&bin).unwrap();
                                    if rf.flags == RelayFlags::Data
                                        && rf.payload.first() == Some(&E2E_ENVELOPE_VERSION)
                                    {
                                        let m = open_device_message(&e2e_key, cluster_id, &rf.src, &rf.dst, &rf.payload).unwrap();
                                        if m.kind == "manifest" {
                                            break;
                                        }
                                    }
                                }

                                // 1. fs.stat RPC
                                let stat_req = DeviceMessage {
                                    v: 1,
                                    kind: "rpc_req".to_string(),
                                    req_id: "stat-1".to_string(),
                                    cluster_id: cluster_id.to_string(),
                                    device_id: "os-ft".to_string(),
                                    ts_ms: 1000,
                                    body: json!({"method": "fs.stat", "params": {"path": seed_file_srv.to_string_lossy(), "sha256": true}}),
                                };
                                let rf = RelayFrame {
                                    flags: RelayFlags::Data,
                                    src: "master-1".to_string(),
                                    dst: "os-ft".to_string(),
                                    payload: seal_device_message(&e2e_key, "master-1", "os-ft", &stat_req).unwrap(),
                                };
                                ws.send(WsMessage::Binary(rf.encode().unwrap().into())).await.unwrap();
                                let stat_rf = next_app_frame(&mut ws, &e2e_key, cluster_id).await;
                                let stat_resp = open_device_message(&e2e_key, cluster_id, "os-ft", "master-1", &stat_rf.payload).unwrap();
                                assert_eq!(stat_resp.body["ok"], true);
                                assert_eq!(stat_resp.body["result"]["size"], seed_bytes_srv.len());
                                assert_eq!(stat_resp.body["result"]["sha256"], hex::encode(seed_sha));

                                // 2. file.pull.open + receive 0xE3 DATA/FINISH
                                let pull_req = DeviceMessage {
                                    v: 1,
                                    kind: "rpc_req".to_string(),
                                    req_id: "pull-1".to_string(),
                                    cluster_id: cluster_id.to_string(),
                                    device_id: "os-ft".to_string(),
                                    ts_ms: 1001,
                                    body: json!({"method": "file.pull.open", "params": {"transfer_id": "ws_pull_1", "path": seed_file_srv.to_string_lossy(), "chunk_size": 16384, "window_bytes": 32768}}),
                                };
                                let prf = RelayFrame {
                                    flags: RelayFlags::Data,
                                    src: "master-1".to_string(),
                                    dst: "os-ft".to_string(),
                                    payload: seal_device_message(&e2e_key, "master-1", "os-ft", &pull_req).unwrap(),
                                };
                                ws.send(WsMessage::Binary(prf.encode().unwrap().into())).await.unwrap();
                                let mut pulled = Vec::new();
                                loop {
                                    let r = next_app_frame(&mut ws, &e2e_key, cluster_id).await;
                                    if r.payload[0] == E2E_ENVELOPE_VERSION {
                                        let m = open_device_message(&e2e_key, cluster_id, "os-ft", "master-1", &r.payload).unwrap();
                                        assert_eq!(m.body["ok"], true);
                                        continue;
                                    }
                                    let ff = open_file_frame(&e2e_key, cluster_id, "os-ft", "master-1", &r.payload).unwrap();
                                    match ff.kind {
                                        FileFrameKind::Data => {
                                            pulled.extend_from_slice(&ff.data);
                                            let ack = FileFrame {
                                                kind: FileFrameKind::Ack,
                                                flags: 0,
                                                seq: ff.seq,
                                                offset: pulled.len() as u64,
                                                window: 32768,
                                                transfer_id: "ws_pull_1".to_string(),
                                                data: Vec::new(),
                                            };
                                            let aw = RelayFrame {
                                                flags: RelayFlags::Data,
                                                src: "master-1".to_string(),
                                                dst: "os-ft".to_string(),
                                                payload: seal_file_frame(&e2e_key, cluster_id, "master-1", "os-ft", &ack).unwrap(),
                                            };
                                            ws.send(WsMessage::Binary(aw.encode().unwrap().into())).await.unwrap();
                                        }
                                        FileFrameKind::Finish => {
                                            assert_eq!(ff.data.as_slice(), seed_sha.as_slice());
                                            let done = FileFrame {
                                                kind: FileFrameKind::Done,
                                                flags: 0,
                                                seq: ff.seq,
                                                offset: pulled.len() as u64,
                                                window: 0,
                                                transfer_id: "ws_pull_1".to_string(),
                                                data: seed_sha.to_vec(),
                                            };
                                            let dw = RelayFrame {
                                                flags: RelayFlags::Data,
                                                src: "master-1".to_string(),
                                                dst: "os-ft".to_string(),
                                                payload: seal_file_frame(&e2e_key, cluster_id, "master-1", "os-ft", &done).unwrap(),
                                            };
                                            ws.send(WsMessage::Binary(dw.encode().unwrap().into())).await.unwrap();
                                            break;
                                        }
                                        other => panic!("unexpected frame: {other:?}"),
                                    }
                                }
                                assert_eq!(pulled, seed_bytes_srv);

                                // 3. file.push.open + send 0xE3 DATA/FINISH -> receive DONE
                                let push_req = DeviceMessage {
                                    v: 1,
                                    kind: "rpc_req".to_string(),
                                    req_id: "push-1".to_string(),
                                    cluster_id: cluster_id.to_string(),
                                    device_id: "os-ft".to_string(),
                                    ts_ms: 1002,
                                    body: json!({"method": "file.push.open", "params": {"transfer_id": "ws_push_1", "path": push_target_srv.to_string_lossy(), "size": push_bytes_srv.len(), "chunk_size": 16384}}),
                                };
                                let psh = RelayFrame {
                                    flags: RelayFlags::Data,
                                    src: "master-1".to_string(),
                                    dst: "os-ft".to_string(),
                                    payload: seal_device_message(&e2e_key, "master-1", "os-ft", &push_req).unwrap(),
                                };
                                ws.send(WsMessage::Binary(psh.encode().unwrap().into())).await.unwrap();
                                let open_rf = next_app_frame(&mut ws, &e2e_key, cluster_id).await;
                                let open_resp = open_device_message(&e2e_key, cluster_id, "os-ft", "master-1", &open_rf.payload).unwrap();
                                assert_eq!(open_resp.body["ok"], true);

                                for (idx, chunk) in push_bytes_srv.chunks(16384).enumerate() {
                                    let df = FileFrame {
                                        kind: FileFrameKind::Data,
                                        flags: 0,
                                        seq: idx as u32,
                                        offset: (idx * 16384) as u64,
                                        window: 0,
                                        transfer_id: "ws_push_1".to_string(),
                                        data: chunk.to_vec(),
                                    };
                                    let dw = RelayFrame {
                                        flags: RelayFlags::Data,
                                        src: "master-1".to_string(),
                                        dst: "os-ft".to_string(),
                                        payload: seal_file_frame(&e2e_key, cluster_id, "master-1", "os-ft", &df).unwrap(),
                                    };
                                    ws.send(WsMessage::Binary(dw.encode().unwrap().into())).await.unwrap();
                                    let ack_rf = next_app_frame(&mut ws, &e2e_key, cluster_id).await;
                                    let ack = open_file_frame(&e2e_key, cluster_id, "os-ft", "master-1", &ack_rf.payload).unwrap();
                                    assert_eq!(ack.kind, FileFrameKind::Ack);
                                }
                                let fin = FileFrame {
                                    kind: FileFrameKind::Finish,
                                    flags: 0,
                                    seq: 99,
                                    offset: push_bytes_srv.len() as u64,
                                    window: 0,
                                    transfer_id: "ws_push_1".to_string(),
                                    data: push_sha.to_vec(),
                                };
                                let fw = RelayFrame {
                                    flags: RelayFlags::Data,
                                    src: "master-1".to_string(),
                                    dst: "os-ft".to_string(),
                                    payload: seal_file_frame(&e2e_key, cluster_id, "master-1", "os-ft", &fin).unwrap(),
                                };
                                ws.send(WsMessage::Binary(fw.encode().unwrap().into())).await.unwrap();
                                let done_rf = next_app_frame(&mut ws, &e2e_key, cluster_id).await;
                                let done = open_file_frame(&e2e_key, cluster_id, "os-ft", "master-1", &done_rf.payload).unwrap();
                                assert_eq!(done.kind, FileFrameKind::Done);
                                assert_eq!(done.data.as_slice(), push_sha.as_slice());

                                let _ = tx_done.send(()).await;
                            }
                        });
                    }
                }
            }
        });

        let cfg = AgentConfig {
            cluster_id: cluster_id.to_string(),
            device_id: "os-ft".to_string(),
            master_id: "master-1".to_string(),
            relay_url: format!("http://{addr}"),
            token: "neo1.dummy.sig".to_string(),
            e2e_secret: e2e_secret.to_string(),
            enroll_id: None,
            relay_enabled: false,
            mqtt_bind: "127.0.0.1:0".to_string(),
            uart_device: None,
            ota_cache_dir: None,
            updater_state_path: None,
            policy_path: None,
            sandbox_override_path: None,
            self_update_target: None,
        };
        let agent_task = tokio::spawn(async move {
            let _ = run_agent(cfg, policy).await;
        });

        tokio::time::timeout(Duration::from_secs(5), server_task)
            .await
            .unwrap()
            .unwrap();
        agent_task.abort();
        assert_eq!(std::fs::read(&push_target).unwrap(), push_bytes);
        let _ = std::fs::remove_dir_all(&ws_dir);
    }

    #[tokio::test]
    async fn mock_relay_ws_handles_mcp_discovery_policy_inspect_call_and_event() {
        let root = std::env::temp_dir().join(format!(
            "neo_transport_mcp_{}_{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let ws_dir = root.join("ws");
        let cfg_dir = root.join("cfg");
        let ota_dir = root.join("ota");
        std::fs::create_dir_all(&ws_dir).unwrap();
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::create_dir_all(&ota_dir).unwrap();

        let py_script = root.join("ws_mcp_mock.py");
        std::fs::write(
            &py_script,
            r#"
import sys, json
for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    msg = json.loads(line)
    m = msg.get("method")
    rid = msg.get("id")
    if m == "initialize":
        print(json.dumps({"jsonrpc":"2.0","id":rid,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"ws-stdio-mcp"},"capabilities":{"tools":{}}}}), flush=True)
    elif m == "tools/list":
        print(json.dumps({"jsonrpc":"2.0","id":rid,"result":{"tools":[{"name":"ping_tool","inputSchema":{"type":"object"}}]}}), flush=True)
    elif m == "tools/call":
        print(json.dumps({"jsonrpc":"2.0","id":rid,"result":{"content":[{"type":"text","text":"ws-pong"}]}}), flush=True)
"#,
        )
        .unwrap();

        std::fs::write(
            cfg_dir.join("mcp-servers.json"),
            serde_json::to_string_pretty(&json!({
                "mcpServers": {
                    "ws-test-mcp": {
                        "command": "python3",
                        "args": ["-u", py_script.to_string_lossy()]
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let policy_path = cfg_dir.join("policy.toml");
        let ws_esc = ws_dir.display().to_string().replace('\\', "\\\\");
        let policy = Arc::new(std::sync::RwLock::new(
            Policy::from_toml_str(&format!(
                r#"
sandbox_level = "personal"
allowed_workspaces = ["{ws_esc}"]

[mcp]
enabled = true
discovery_mode = "neo_only"
"#
            ))
            .unwrap(),
        ));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let e2e_secret = "mcp-ws-secret";
        let cluster_id = "cluster-mcp";
        let e2e_key = derive_e2e_key(cluster_id, e2e_secret);

        let server_task = tokio::spawn(async move {
            let (tx_done, mut rx_done) = mpsc::channel::<()>(1);
            loop {
                tokio::select! {
                    _ = rx_done.recv() => break,
                    accept_res = listener.accept() => {
                        let (mut stream, _) = accept_res.unwrap();
                        let tx_done = tx_done.clone();
                        tokio::spawn(async move {
                            let mut peek_buf = [0u8; 512];
                            let n = stream.peek(&mut peek_buf).await.unwrap_or(0);
                            let head = String::from_utf8_lossy(&peek_buf[..n]);
                            if head.starts_with("GET /v1/bootstrap ") {
                                let mut sink = [0u8; 1024];
                                let _ = stream.read(&mut sink).await;
                                let body = br#"{"stun_servers":[]}"#;
                                let resp = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body.len()
                                );
                                let _ = stream.write_all(resp.as_bytes()).await;
                                let _ = stream.write_all(body).await;
                                return;
                            }
                            if head.starts_with("GET /v1/signal ") {
                                if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                                    let _ = ws.next().await;
                                }
                                return;
                            }
                            if head.starts_with("GET /v1/relay ") {
                                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                                async fn recv_msg<S>(
                                    ws: &mut S,
                                    key: &[u8; 32],
                                    cluster: &str,
                                ) -> DeviceMessage
                                where
                                    S: StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
                                {
                                    loop {
                                        if let Some(Ok(WsMessage::Binary(b))) = ws.next().await {
                                            let rf = RelayFrame::decode(&b).unwrap();
                                            if rf.flags == RelayFlags::Data {
                                                let msg = open_device_message(key, cluster, "os-mcp", "master-1", &rf.payload).unwrap();
                                                if msg.kind != "heartbeat" {
                                                    return msg;
                                                }
                                            }
                                        }
                                    }
                                }

                                // 1. Manifest includes mcp_discovery, mcp_proxy, and mcp_summary
                                let manifest = recv_msg(&mut ws, &e2e_key, cluster_id).await;
                                assert_eq!(manifest.kind, "manifest");
                                let caps: Vec<&str> = manifest.body["capabilities"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .filter_map(|v| v.as_str())
                                    .collect();
                                assert!(caps.contains(&"mcp_discovery"));
                                assert!(caps.contains(&"mcp_proxy"));
                                assert_eq!(manifest.body["mcp_summary"]["enabled"], true);
                                assert!(manifest.body["mcp_summary"]["discovered_count"].as_u64().unwrap() >= 1);

                                // Helper to send RPC
                                let send_rpc = |req_id: &str, method: &str, params: serde_json::Value| {
                                    let req = DeviceMessage {
                                        v: 1,
                                        kind: "rpc_req".to_string(),
                                        req_id: req_id.to_string(),
                                        cluster_id: cluster_id.to_string(),
                                        device_id: "os-mcp".to_string(),
                                        ts_ms: 1000,
                                        body: json!({ "method": method, "params": params }),
                                    };
                                    let sealed = seal_device_message(&e2e_key, "master-1", "os-mcp", &req).unwrap();
                                    let rf = RelayFrame {
                                        flags: RelayFlags::Data,
                                        src: "master-1".to_string(),
                                        dst: "os-mcp".to_string(),
                                        payload: sealed,
                                    };
                                    WsMessage::Binary(rf.encode().unwrap().into())
                                };

                                // 2. mcp.server.set_policy -> rpc_resp + mcp.catalog_changed event
                                ws.send(send_rpc(
                                    "req-policy",
                                    "mcp.server.set_policy",
                                    json!({"server_id": "neo:ws-test-mcp", "trust_state": "enabled"}),
                                ))
                                .await
                                .unwrap();
                                let resp_pol = recv_msg(&mut ws, &e2e_key, cluster_id).await;
                                assert_eq!(resp_pol.kind, "rpc_resp");
                                assert_eq!(resp_pol.req_id, "req-policy");
                                assert_eq!(resp_pol.body["ok"], true);
                                assert_eq!(resp_pol.body["result"]["persisted"], true);
                                assert_eq!(resp_pol.body["result"]["server"]["trust_state"], "enabled");

                                let evt = recv_msg(&mut ws, &e2e_key, cluster_id).await;
                                assert_eq!(evt.kind, "event");
                                assert_eq!(evt.body["event"], "mcp.catalog_changed");
                                assert!(evt.body["catalog_hash"].as_str().unwrap().starts_with("sha256:"));

                                // 3. mcp.inspect
                                ws.send(send_rpc(
                                    "req-inspect",
                                    "mcp.inspect",
                                    json!({"server_id": "neo:ws-test-mcp"}),
                                ))
                                .await
                                .unwrap();
                                let resp_insp = recv_msg(&mut ws, &e2e_key, cluster_id).await;
                                assert_eq!(resp_insp.body["ok"], true);
                                assert_eq!(resp_insp.body["result"]["tools"][0]["name"], "ping_tool");

                                // 4. mcp.call (using underscore alias!)
                                ws.send(send_rpc(
                                    "req-call",
                                    "mcp_call",
                                    json!({"server_id": "neo:ws-test-mcp", "tool_name": "ping_tool", "arguments": {}}),
                                ))
                                .await
                                .unwrap();
                                let resp_call = recv_msg(&mut ws, &e2e_key, cluster_id).await;
                                assert_eq!(resp_call.body["ok"], true);
                                assert_eq!(resp_call.body["result"]["content"][0]["text"], "ws-pong");

                                // 5. mcp.server.stop
                                ws.send(send_rpc(
                                    "req-stop",
                                    "mcp.server.stop",
                                    json!({"server_id": "neo:ws-test-mcp"}),
                                ))
                                .await
                                .unwrap();
                                let resp_stop = recv_msg(&mut ws, &e2e_key, cluster_id).await;
                                assert_eq!(resp_stop.body["ok"], true);
                                assert_eq!(resp_stop.body["result"]["stopped"], true);

                                let _ = tx_done.send(()).await;
                            }
                        });
                    }
                }
            }
        });

        let cfg = AgentConfig {
            cluster_id: cluster_id.to_string(),
            device_id: "os-mcp".to_string(),
            master_id: "master-1".to_string(),
            relay_url: format!("http://{addr}"),
            token: "neo1.dummy.sig".to_string(),
            e2e_secret: e2e_secret.to_string(),
            enroll_id: None,
            relay_enabled: false,
            mqtt_bind: "127.0.0.1:0".to_string(),
            uart_device: None,
            ota_cache_dir: Some(ota_dir),
            updater_state_path: None,
            policy_path: Some(policy_path),
            sandbox_override_path: None,
            self_update_target: None,
        };

        let agent_task = tokio::spawn(async move {
            let _ = run_agent(cfg, policy).await;
        });

        tokio::time::timeout(Duration::from_secs(8), server_task)
            .await
            .unwrap()
            .unwrap();
        agent_task.abort();
        let _ = std::fs::remove_dir_all(&root);
    }
}
