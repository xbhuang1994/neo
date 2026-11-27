use crate::mcp::transport_stdio::{
    extract_jsonrpc_u64_id, format_jsonrpc_error, MCP_PROTOCOL_VERSION,
};
use crate::mcp::McpTransportKind;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;
use url::Url;

const MAX_HEADER_BYTES: usize = 64 * 1024;

pub(crate) enum HttpStream {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for HttpStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match &mut *self {
            HttpStream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            HttpStream::Tls(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for HttpStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match &mut *self {
            HttpStream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            HttpStream::Tls(s) => Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self {
            HttpStream::Plain(s) => Pin::new(s).poll_flush(cx),
            HttpStream::Tls(s) => Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match &mut *self {
            HttpStream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            HttpStream::Tls(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

fn build_tls_connector() -> TlsConnector {
    let mut root_store = RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
}

struct ParsedUrlTarget {
    host_for_dial: String,
    host_header: String,
    port: u16,
    use_tls: bool,
    path_and_query: String,
}

fn parse_url_target(url_str: &str) -> Result<ParsedUrlTarget, String> {
    let url = Url::parse(url_str).map_err(|e| format!("invalid MCP HTTP URL '{url_str}': {e}"))?;
    let raw_host = url.host_str().ok_or("MCP HTTP URL missing host")?;
    let host_for_dial = raw_host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let use_tls = match url.scheme() {
        "https" => true,
        "http" => false,
        other => return Err(format!("unsupported MCP HTTP URL scheme: {other}")),
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
    Ok(ParsedUrlTarget {
        host_for_dial,
        host_header,
        port,
        use_tls,
        path_and_query,
    })
}

async fn connect_http_stream(
    target: &ParsedUrlTarget,
    timeout: Duration,
) -> Result<HttpStream, String> {
    let tcp = tokio::time::timeout(
        timeout,
        TcpStream::connect((target.host_for_dial.as_str(), target.port)),
    )
    .await
    .map_err(|_| {
        format!(
            "MCP HTTP TCP connect timed out ({}:{})",
            target.host_for_dial, target.port
        )
    })?
    .map_err(|e| {
        format!(
            "MCP HTTP TCP connect failed ({}:{}): {e}",
            target.host_for_dial, target.port
        )
    })?;

    if target.use_tls {
        let connector = build_tls_connector();
        let server_name = ServerName::try_from(target.host_for_dial.clone())
            .map_err(|_| format!("invalid TLS server name: {}", target.host_for_dial))?;
        let tls = tokio::time::timeout(timeout, connector.connect(server_name, tcp))
            .await
            .map_err(|_| "MCP HTTP TLS handshake timed out".to_string())?
            .map_err(|e| format!("MCP HTTP TLS handshake failed: {e}"))?;
        Ok(HttpStream::Tls(Box::new(tls)))
    } else {
        Ok(HttpStream::Plain(tcp))
    }
}

struct HttpResponseHead {
    status: u16,
    headers: HashMap<String, String>,
}

impl HttpResponseHead {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_ascii_lowercase()).map(String::as_str)
    }

    fn is_chunked(&self) -> bool {
        self.header("transfer-encoding")
            .map(|v| v.to_ascii_lowercase().contains("chunked"))
            .unwrap_or(false)
    }

    fn content_length(&self) -> Option<usize> {
        self.header("content-length")
            .and_then(|v| v.trim().parse::<usize>().ok())
    }

    fn is_sse(&self) -> bool {
        self.header("content-type")
            .map(|v| v.to_ascii_lowercase().contains("text/event-stream"))
            .unwrap_or(false)
    }
}

async fn read_http_response_head<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<HttpResponseHead, String> {
    let mut header_bytes = Vec::new();
    loop {
        let mut line = Vec::new();
        let n = reader
            .read_until(b'\n', &mut line)
            .await
            .map_err(|e| format!("HTTP header read error: {e}"))?;
        if n == 0 {
            return Err("unexpected EOF while reading HTTP response headers".to_string());
        }
        header_bytes.extend_from_slice(&line);
        if header_bytes.len() > MAX_HEADER_BYTES {
            return Err("HTTP response headers exceed 64 KiB limit".to_string());
        }
        if line == b"\r\n" || line == b"\n" {
            break;
        }
    }

    let head_str = std::str::from_utf8(&header_bytes)
        .map_err(|e| format!("invalid UTF-8 in HTTP headers: {e}"))?;
    let mut lines = head_str.lines();
    let status_line = lines.next().ok_or("missing HTTP status line")?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("invalid HTTP status line: {status_line}"))?;

    let mut headers = HashMap::new();
    for line in lines {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.is_empty() {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    Ok(HttpResponseHead { status, headers })
}

enum BodyMode {
    Chunked { remaining: usize, eof: bool },
    Fixed { remaining: usize },
    UntilEof,
}

struct BodyReader<R> {
    reader: R,
    mode: BodyMode,
    buf: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin> BodyReader<R> {
    fn from_head(reader: R, head: &HttpResponseHead) -> Self {
        let mode = if head.is_chunked() {
            BodyMode::Chunked {
                remaining: 0,
                eof: false,
            }
        } else if let Some(len) = head.content_length() {
            BodyMode::Fixed { remaining: len }
        } else {
            BodyMode::UntilEof
        };
        Self {
            reader,
            mode,
            buf: Vec::new(),
        }
    }

    async fn read_all(&mut self, max_bytes: usize) -> Result<Vec<u8>, String> {
        let mut out = std::mem::take(&mut self.buf);
        loop {
            if out.len() > max_bytes {
                return Err(format!("MCP HTTP response exceeded max_response_bytes ({max_bytes})"));
            }
            let room = max_bytes.saturating_sub(out.len()) + 1;
            let n = read_body_chunk(&mut self.reader, &mut self.mode, &mut out, room).await?;
            if n == 0 {
                break;
            }
        }
        if out.len() > max_bytes {
            return Err(format!("MCP HTTP response exceeded max_response_bytes ({max_bytes})"));
        }
        Ok(out)
    }

    async fn next_line(&mut self, max_line_bytes: usize) -> Result<Option<String>, String> {
        loop {
            if let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
                let mut line_bytes: Vec<u8> = self.buf.drain(..=pos).collect();
                if line_bytes.ends_with(b"\n") {
                    line_bytes.pop();
                }
                if line_bytes.ends_with(b"\r") {
                    line_bytes.pop();
                }
                return Ok(Some(String::from_utf8_lossy(&line_bytes).into_owned()));
            }
            if self.buf.len() > max_line_bytes {
                return Err(format!(
                    "SSE line exceeded maximum allowed size ({max_line_bytes} bytes)"
                ));
            }
            let n = read_body_chunk(&mut self.reader, &mut self.mode, &mut self.buf, 8192).await?;
            if n == 0 {
                if self.buf.is_empty() {
                    return Ok(None);
                }
                let mut rem = std::mem::take(&mut self.buf);
                if rem.ends_with(b"\r") {
                    rem.pop();
                }
                return Ok(Some(String::from_utf8_lossy(&rem).into_owned()));
            }
        }
    }
}

async fn read_body_chunk<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    mode: &mut BodyMode,
    out: &mut Vec<u8>,
    max_take: usize,
) -> Result<usize, String> {
    let cap = max_take.max(1);
    match mode {
        BodyMode::Chunked { remaining, eof } => {
            if *eof {
                return Ok(0);
            }
            while *remaining == 0 {
                let mut size_line = String::new();
                let n = reader
                    .read_line(&mut size_line)
                    .await
                    .map_err(|e| format!("HTTP chunk size read error: {e}"))?;
                if n == 0 {
                    *eof = true;
                    return Ok(0);
                }
                let trimmed = size_line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let size_hex = trimmed.split(';').next().unwrap_or("").trim();
                let size = usize::from_str_radix(size_hex, 16)
                    .map_err(|e| format!("invalid HTTP chunk size '{size_hex}': {e}"))?;
                if size == 0 {
                    let mut trailer = String::new();
                    loop {
                        trailer.clear();
                        let tn = reader.read_line(&mut trailer).await.unwrap_or(0);
                        if tn == 0 || trailer == "\r\n" || trailer == "\n" {
                            break;
                        }
                    }
                    *eof = true;
                    return Ok(0);
                }
                *remaining = size;
            }
            let to_read = (*remaining).min(cap).min(16 * 1024);
            let mut tmp = vec![0u8; to_read];
            let n = reader
                .read(&mut tmp)
                .await
                .map_err(|e| format!("HTTP chunk body read error: {e}"))?;
            if n == 0 {
                return Err("truncated HTTP chunk body".to_string());
            }
            out.extend_from_slice(&tmp[..n]);
            *remaining -= n;
            if *remaining == 0 {
                let mut crlf = [0u8; 2];
                let _ = reader.read_exact(&mut crlf).await;
            }
            Ok(n)
        }
        BodyMode::Fixed { remaining } => {
            if *remaining == 0 {
                return Ok(0);
            }
            let to_read = (*remaining).min(cap).min(16 * 1024);
            let mut tmp = vec![0u8; to_read];
            let n = reader
                .read(&mut tmp)
                .await
                .map_err(|e| format!("HTTP body read error: {e}"))?;
            if n == 0 {
                *remaining = 0;
                return Ok(0);
            }
            out.extend_from_slice(&tmp[..n]);
            *remaining -= n;
            Ok(n)
        }
        BodyMode::UntilEof => {
            let to_read = cap.min(16 * 1024);
            let mut tmp = vec![0u8; to_read];
            let n = reader
                .read(&mut tmp)
                .await
                .map_err(|e| format!("HTTP body read error: {e}"))?;
            if n > 0 {
                out.extend_from_slice(&tmp[..n]);
            }
            Ok(n)
        }
    }
}

#[derive(Debug, Clone)]
struct SseEvent {
    event: Option<String>,
    data: String,
}

async fn next_sse_event<R: AsyncBufRead + Unpin>(
    body: &mut BodyReader<R>,
    max_event_bytes: usize,
) -> Result<Option<SseEvent>, String> {
    let mut event_name: Option<String> = None;
    let mut data_lines: Vec<String> = Vec::new();
    let mut total_bytes = 0usize;

    loop {
        match body.next_line(max_event_bytes).await? {
            None => {
                if !data_lines.is_empty() {
                    return Ok(Some(SseEvent {
                        event: event_name,
                        data: data_lines.join("\n"),
                    }));
                }
                return Ok(None);
            }
            Some(line) => {
                if line.is_empty() {
                    if !data_lines.is_empty() {
                        return Ok(Some(SseEvent {
                            event: event_name,
                            data: data_lines.join("\n"),
                        }));
                    }
                    event_name = None;
                    continue;
                }
                if line.starts_with(':') {
                    // SSE comment / keepalive
                    continue;
                }
                let (field, raw_val) = match line.split_once(':') {
                    Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                    None => (line.as_str(), ""),
                };
                match field {
                    "event" => {
                        event_name = Some(raw_val.to_string());
                    }
                    "data" => {
                        total_bytes += raw_val.len();
                        if total_bytes > max_event_bytes {
                            return Err(format!(
                                "SSE event exceeded max_response_bytes ({max_event_bytes})"
                            ));
                        }
                        data_lines.push(raw_val.to_string());
                    }
                    _ => {}
                }
            }
        }
    }
}

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct HttpRequestOpts<'a> {
    method: &'a str,
    target: &'a ParsedUrlTarget,
    extra_headers: &'a BTreeMap<String, String>,
    accept: &'a str,
    content_type: Option<&'a str>,
    session_id: Option<&'a str>,
    protocol_version: Option<&'a str>,
    connection: &'a str,
    body_len: Option<usize>,
}

fn format_http_request(opts: HttpRequestOpts<'_>) -> String {
    let mut req = format!(
        "{} {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: neo-agent-os/{}\r\nAccept: {}\r\nConnection: {}\r\n",
        opts.method,
        opts.target.path_and_query,
        opts.target.host_header,
        env!("CARGO_PKG_VERSION"),
        opts.accept,
        opts.connection,
    );
    if let Some(ct) = opts.content_type {
        req.push_str(&format!("Content-Type: {ct}\r\n"));
    }
    if let Some(sid) = opts.session_id {
        if !sid.is_empty() && !sid.contains(['\r', '\n']) {
            req.push_str(&format!("Mcp-Session-Id: {sid}\r\n"));
        }
    }
    if let Some(pv) = opts.protocol_version {
        if !pv.is_empty() && !pv.contains(['\r', '\n']) {
            req.push_str(&format!("MCP-Protocol-Version: {pv}\r\n"));
        }
    }
    for (k, v) in opts.extra_headers {
        let kl = k.trim().to_ascii_lowercase();
        if kl.is_empty()
            || matches!(
                kl.as_str(),
                "host" | "content-length" | "connection" | "transfer-encoding"
            )
            || k.contains(['\r', '\n'])
            || v.contains(['\r', '\n'])
        {
            continue;
        }
        req.push_str(&format!("{}: {}\r\n", k.trim(), v.trim()));
    }
    if let Some(len) = opts.body_len {
        req.push_str(&format!("Content-Length: {len}\r\n"));
    }
    req.push_str("\r\n");
    req
}

fn extract_matching_jsonrpc_response(val: &Value, expected_id: u64) -> Option<Result<Value, String>> {
    if let Some(arr) = val.as_array() {
        for item in arr {
            if let Some(res) = extract_matching_jsonrpc_response(item, expected_id) {
                return Some(res);
            }
        }
        return None;
    }
    let obj = val.as_object()?;
    if let Some(id) = extract_jsonrpc_u64_id(obj.get("id")) {
        if id != expected_id {
            return None;
        }
    } else if obj.get("result").is_none() && obj.get("error").is_none() {
        return None;
    }
    if let Some(err) = obj.get("error").filter(|e| !e.is_null()) {
        return Some(Err(format_jsonrpc_error(err)));
    }
    Some(Ok(obj.get("result").cloned().unwrap_or(Value::Null)))
}

// ---------------------------------------------------------------------------
// Streamable HTTP MCP Client (MCP 2025-03-26 / 2025-06-18)
// ---------------------------------------------------------------------------

pub struct StreamableHttpMcpClient {
    url: String,
    headers: BTreeMap<String, String>,
    session_id: Mutex<Option<String>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    max_response_bytes: usize,
    protocol_version: String,
    server_info: Value,
    server_capabilities: Value,
}

impl StreamableHttpMcpClient {
    pub async fn connect(
        url: &str,
        headers: &BTreeMap<String, String>,
        max_response_bytes: usize,
        timeout: Duration,
    ) -> Result<Self, String> {
        // Validate URL early
        let _ = parse_url_target(url)?;
        let mut client = Self {
            url: url.to_string(),
            headers: headers.clone(),
            session_id: Mutex::new(None),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            max_response_bytes: max_response_bytes.max(64 * 1024),
            protocol_version: MCP_PROTOCOL_VERSION.to_string(),
            server_info: Value::Null,
            server_capabilities: json!({}),
        };

        let init_val = client
            .request_inner(
                "initialize",
                json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "neo-agent-os",
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
                timeout,
                false,
            )
            .await
            .map_err(|e| format!("Streamable HTTP MCP initialize failed: {e}"))?;

        if let Some(pv) = init_val.get("protocolVersion").and_then(|v| v.as_str()) {
            client.protocol_version = pv.to_string();
        }
        client.server_info = init_val.get("serverInfo").cloned().unwrap_or(Value::Null);
        client.server_capabilities = init_val
            .get("capabilities")
            .cloned()
            .unwrap_or_else(|| json!({}));

        let _ = client.notify("notifications/initialized", None, timeout).await;
        Ok(client)
    }

    pub fn protocol_version(&self) -> &str {
        &self.protocol_version
    }

    pub fn server_info(&self) -> Value {
        self.server_info.clone()
    }

    pub fn server_capabilities(&self) -> &Value {
        &self.server_capabilities
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub async fn session_id(&self) -> Option<String> {
        self.session_id.lock().await.clone()
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.request_inner(method, params, timeout, true).await
    }

    async fn request_inner(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        include_proto_header: bool,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let body_bytes =
            serde_json::to_vec(&payload).map_err(|e| format!("JSON serialize error: {e}"))?;

        let target = parse_url_target(&self.url)?;
        let sid = self.session_id.lock().await.clone();
        let pv = if include_proto_header {
            Some(self.protocol_version.as_str())
        } else {
            None
        };
        let req_head = format_http_request(HttpRequestOpts {
            method: "POST",
            target: &target,
            extra_headers: &self.headers,
            accept: "application/json, text/event-stream",
            content_type: Some("application/json"),
            session_id: sid.as_deref(),
            protocol_version: pv,
            connection: "close",
            body_len: Some(body_bytes.len()),
        });

        let fut = async {
            let mut stream = connect_http_stream(&target, timeout).await?;
            stream
                .write_all(req_head.as_bytes())
                .await
                .map_err(|e| format!("MCP HTTP request write failed: {e}"))?;
            stream
                .write_all(&body_bytes)
                .await
                .map_err(|e| format!("MCP HTTP body write failed: {e}"))?;
            stream.flush().await.ok();

            let mut reader = BufReader::new(stream);
            let head = read_http_response_head(&mut reader).await?;
            if let Some(new_sid) = head.header("mcp-session-id") {
                if !new_sid.is_empty() {
                    *self.session_id.lock().await = Some(new_sid.to_string());
                }
            }

            let mut body_reader = BodyReader::from_head(reader, &head);
            if !(200..300).contains(&head.status) {
                let err_body = body_reader.read_all(8192).await.unwrap_or_default();
                let snippet = String::from_utf8_lossy(&err_body);
                return Err(format!(
                    "MCP HTTP {} error: {}",
                    head.status,
                    snippet.trim()
                ));
            }

            if head.status == 202 || head.status == 204 {
                return Ok(Value::Null);
            }

            if head.is_sse() {
                while let Some(ev) = next_sse_event(&mut body_reader, self.max_response_bytes).await? {
                    let trimmed = ev.data.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                        if let Some(res) = extract_matching_jsonrpc_response(&val, id) {
                            return res;
                        }
                    }
                }
                return Err(format!(
                    "MCP Streamable HTTP SSE stream ended without JSON-RPC response for id={id}"
                ));
            }

            let raw = body_reader.read_all(self.max_response_bytes).await?;
            if raw.is_empty() {
                return Ok(Value::Null);
            }
            let val: Value = serde_json::from_slice(&raw)
                .map_err(|e| format!("invalid MCP HTTP JSON response: {e}"))?;
            extract_matching_jsonrpc_response(&val, id)
                .unwrap_or_else(|| Err("MCP HTTP JSON response missing result/error".to_string()))
        };

        tokio::time::timeout(timeout, fut)
            .await
            .map_err(|_| format!("MCP Streamable HTTP request '{method}' timed out"))?
    }

    pub async fn notify(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<(), String> {
        let payload = match params {
            Some(p) => json!({ "jsonrpc": "2.0", "method": method, "params": p }),
            None => json!({ "jsonrpc": "2.0", "method": method }),
        };
        let body_bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        let target = parse_url_target(&self.url)?;
        let sid = self.session_id.lock().await.clone();
        let req_head = format_http_request(HttpRequestOpts {
            method: "POST",
            target: &target,
            extra_headers: &self.headers,
            accept: "application/json, text/event-stream",
            content_type: Some("application/json"),
            session_id: sid.as_deref(),
            protocol_version: Some(&self.protocol_version),
            connection: "close",
            body_len: Some(body_bytes.len()),
        });
        let res = tokio::time::timeout(timeout, async {
            let mut stream = connect_http_stream(&target, timeout).await?;
            stream.write_all(req_head.as_bytes()).await.map_err(|e| e.to_string())?;
            stream.write_all(&body_bytes).await.map_err(|e| e.to_string())?;
            stream.flush().await.ok();
            let mut reader = BufReader::new(stream);
            let _ = read_http_response_head(&mut reader).await?;
            Ok::<(), String>(())
        })
        .await;
        match res {
            Ok(inner) => inner,
            Err(_) => Err(format!("MCP Streamable HTTP notify '{method}' timed out")),
        }
    }

    pub async fn shutdown(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let sid = self.session_id.lock().await.take();
        if let Some(sid) = sid {
            if let Ok(target) = parse_url_target(&self.url) {
                let req_head = format_http_request(HttpRequestOpts {
                    method: "DELETE",
                    target: &target,
                    extra_headers: &self.headers,
                    accept: "application/json",
                    content_type: None,
                    session_id: Some(&sid),
                    protocol_version: Some(&self.protocol_version),
                    connection: "close",
                    body_len: None,
                });
                let _ = tokio::time::timeout(Duration::from_secs(1), async {
                    if let Ok(mut stream) =
                        connect_http_stream(&target, Duration::from_secs(1)).await
                    {
                        let _ = stream.write_all(req_head.as_bytes()).await;
                        let _ = stream.flush().await;
                    }
                })
                .await;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Legacy HTTP + SSE MCP Client (MCP 2024-11-05)
// ---------------------------------------------------------------------------

pub struct LegacySseMcpClient {
    message_endpoint: String,
    headers: BTreeMap<String, String>,
    next_id: AtomicU64,
    pending: PendingMap,
    alive: Arc<AtomicBool>,
    sse_task: Mutex<Option<JoinHandle<()>>>,
    max_response_bytes: usize,
    protocol_version: String,
    server_info: Value,
    server_capabilities: Value,
}

impl LegacySseMcpClient {
    pub async fn connect(
        url: &str,
        headers: &BTreeMap<String, String>,
        max_response_bytes: usize,
        timeout: Duration,
    ) -> Result<Self, String> {
        let base_url =
            Url::parse(url).map_err(|e| format!("invalid Legacy SSE MCP URL '{url}': {e}"))?;
        let target = parse_url_target(url)?;
        let req_head = format_http_request(HttpRequestOpts {
            method: "GET",
            target: &target,
            extra_headers: headers,
            accept: "text/event-stream",
            content_type: None,
            session_id: None,
            protocol_version: None,
            connection: "keep-alive",
            body_len: None,
        });

        let mut stream = connect_http_stream(&target, timeout).await?;
        stream
            .write_all(req_head.as_bytes())
            .await
            .map_err(|e| format!("SSE GET request write failed: {e}"))?;
        stream.flush().await.ok();

        let mut reader = BufReader::new(stream);
        let head = tokio::time::timeout(timeout, read_http_response_head(&mut reader))
            .await
            .map_err(|_| "SSE GET header read timed out".to_string())??;

        if head.status != 200 {
            return Err(format!("Legacy SSE endpoint returned HTTP {}", head.status));
        }
        if !head.is_sse() {
            return Err(format!(
                "Legacy SSE endpoint did not return text/event-stream (got {:?})",
                head.header("content-type")
            ));
        }

        let max_bytes = max_response_bytes.max(64 * 1024);
        let mut body_reader = BodyReader::from_head(reader, &head);

        let endpoint_raw = tokio::time::timeout(timeout, async {
            while let Some(ev) = next_sse_event(&mut body_reader, max_bytes).await? {
                let is_endpoint = ev
                    .event
                    .as_deref()
                    .map(|e| e.eq_ignore_ascii_case("endpoint"))
                    .unwrap_or(false);
                if is_endpoint {
                    let trimmed = ev.data.trim();
                    if !trimmed.is_empty() {
                        return Ok(trimmed.to_string());
                    }
                }
            }
            Err("SSE stream closed before receiving 'endpoint' event".to_string())
        })
        .await
        .map_err(|_| "timed out waiting for SSE 'endpoint' event".to_string())??;

        let resolved = base_url
            .join(&endpoint_raw)
            .map_err(|e| format!("invalid SSE message endpoint '{endpoint_raw}': {e}"))?;
        if !matches!(resolved.scheme(), "http" | "https") {
            return Err(format!(
                "disallowed SSE message endpoint scheme '{}'",
                resolved.scheme()
            ));
        }
        // If base SSE URL is loopback, prevent SSE endpoint redirect to non-loopback hosts.
        if is_loopback_host(base_url.host_str()) && !is_loopback_host(resolved.host_str()) {
            return Err(format!(
                "refusing non-loopback SSE message endpoint '{}' from loopback server",
                resolved
            ));
        }

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));

        let sse_task = {
            let pending = Arc::clone(&pending);
            let alive = Arc::clone(&alive);
            tokio::spawn(async move {
                while let Ok(Some(ev)) = next_sse_event(&mut body_reader, max_bytes).await {
                    let is_msg = ev
                        .event
                        .as_deref()
                        .map(|e| e.eq_ignore_ascii_case("message"))
                        .unwrap_or(true);
                    if !is_msg {
                        continue;
                    }
                    let trimmed = ev.data.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                        dispatch_sse_jsonrpc(&val, &pending).await;
                    }
                }
                alive.store(false, Ordering::SeqCst);
                let mut map = pending.lock().await;
                for (_, tx) in map.drain() {
                    let _ = tx.send(Err("Legacy SSE stream closed".to_string()));
                }
            })
        };

        let mut client = Self {
            message_endpoint: resolved.to_string(),
            headers: headers.clone(),
            next_id: AtomicU64::new(1),
            pending,
            alive,
            sse_task: Mutex::new(Some(sse_task)),
            max_response_bytes: max_bytes,
            protocol_version: MCP_PROTOCOL_VERSION.to_string(),
            server_info: Value::Null,
            server_capabilities: json!({}),
        };

        let init_val = match client
            .request(
                "initialize",
                json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "neo-agent-os",
                        "version": env!("CARGO_PKG_VERSION"),
                    }
                }),
                timeout,
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                client.shutdown().await;
                return Err(format!("Legacy SSE MCP initialize failed: {e}"));
            }
        };

        if let Some(pv) = init_val.get("protocolVersion").and_then(|v| v.as_str()) {
            client.protocol_version = pv.to_string();
        }
        client.server_info = init_val.get("serverInfo").cloned().unwrap_or(Value::Null);
        client.server_capabilities = init_val
            .get("capabilities")
            .cloned()
            .unwrap_or_else(|| json!({}));

        let _ = client.notify("notifications/initialized", None, timeout).await;
        Ok(client)
    }

    pub fn protocol_version(&self) -> &str {
        &self.protocol_version
    }

    pub fn server_info(&self) -> Value {
        self.server_info.clone()
    }

    pub fn server_capabilities(&self) -> &Value {
        &self.server_capabilities
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !self.is_alive() {
            return Err("Legacy SSE MCP stream is no longer connected".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let body_bytes =
            serde_json::to_vec(&payload).map_err(|e| format!("JSON serialize error: {e}"))?;

        let post_res = self.post_message(&body_bytes, timeout).await;
        match post_res {
            Err(e) => {
                self.pending.lock().await.remove(&id);
                return Err(e);
            }
            Ok(Some(direct_json)) => {
                // Some servers return JSON-RPC result synchronously in POST 200 body.
                if let Some(res) = extract_matching_jsonrpc_response(&direct_json, id) {
                    self.pending.lock().await.remove(&id);
                    return res;
                }
            }
            Ok(None) => {}
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err(format!(
                "Legacy SSE stream closed while awaiting response for '{method}'"
            )),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!(
                    "Legacy SSE MCP request '{method}' timed out after {}ms",
                    timeout.as_millis()
                ))
            }
        }
    }

    pub async fn notify(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<(), String> {
        let payload = match params {
            Some(p) => json!({ "jsonrpc": "2.0", "method": method, "params": p }),
            None => json!({ "jsonrpc": "2.0", "method": method }),
        };
        let body_bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        let _ = self.post_message(&body_bytes, timeout).await?;
        Ok(())
    }

    async fn post_message(
        &self,
        body_bytes: &[u8],
        timeout: Duration,
    ) -> Result<Option<Value>, String> {
        let target = parse_url_target(&self.message_endpoint)?;
        let req_head = format_http_request(HttpRequestOpts {
            method: "POST",
            target: &target,
            extra_headers: &self.headers,
            accept: "application/json",
            content_type: Some("application/json"),
            session_id: None,
            protocol_version: None,
            connection: "close",
            body_len: Some(body_bytes.len()),
        });

        let fut = async {
            let mut stream = connect_http_stream(&target, timeout).await?;
            stream
                .write_all(req_head.as_bytes())
                .await
                .map_err(|e| format!("SSE POST header write failed: {e}"))?;
            stream
                .write_all(body_bytes)
                .await
                .map_err(|e| format!("SSE POST body write failed: {e}"))?;
            stream.flush().await.ok();

            let mut reader = BufReader::new(stream);
            let head = read_http_response_head(&mut reader).await?;
            let mut body_reader = BodyReader::from_head(reader, &head);
            if !(200..300).contains(&head.status) {
                let err_body = body_reader.read_all(4096).await.unwrap_or_default();
                return Err(format!(
                    "SSE POST HTTP {}: {}",
                    head.status,
                    String::from_utf8_lossy(&err_body).trim()
                ));
            }
            if head.status == 202 || head.status == 204 {
                return Ok(None);
            }
            let raw = body_reader.read_all(self.max_response_bytes).await?;
            if raw.is_empty() {
                return Ok(None);
            }
            Ok(serde_json::from_slice::<Value>(&raw).ok())
        };

        tokio::time::timeout(timeout, fut)
            .await
            .map_err(|_| "SSE POST request timed out".to_string())?
    }

    pub async fn shutdown(&self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Some(handle) = self.sse_task.lock().await.take() {
            handle.abort();
        }
        let mut map = self.pending.lock().await;
        for (_, tx) in map.drain() {
            let _ = tx.send(Err("Legacy SSE MCP session shut down".to_string()));
        }
    }
}

async fn dispatch_sse_jsonrpc(val: &Value, pending: &PendingMap) {
    if let Some(arr) = val.as_array() {
        for item in arr {
            if let Some(obj) = item.as_object() {
                if let Some(id) = extract_jsonrpc_u64_id(obj.get("id")) {
                    if let Some(tx) = pending.lock().await.remove(&id) {
                        if let Some(err) = obj.get("error").filter(|e| !e.is_null()) {
                            let _ = tx.send(Err(format_jsonrpc_error(err)));
                        } else {
                            let _ = tx.send(Ok(obj.get("result").cloned().unwrap_or(Value::Null)));
                        }
                    }
                }
            }
        }
        return;
    }
    if let Some(obj) = val.as_object() {
        if let Some(id) = extract_jsonrpc_u64_id(obj.get("id")) {
            if let Some(tx) = pending.lock().await.remove(&id) {
                if let Some(err) = obj.get("error").filter(|e| !e.is_null()) {
                    let _ = tx.send(Err(format_jsonrpc_error(err)));
                } else {
                    let _ = tx.send(Ok(obj.get("result").cloned().unwrap_or(Value::Null)));
                }
            }
        }
    }
}

fn is_loopback_host(host: Option<&str>) -> bool {
    let Some(h) = host else { return false };
    let clean = h.trim_start_matches('[').trim_end_matches(']');
    clean.eq_ignore_ascii_case("localhost") || clean == "127.0.0.1" || clean == "::1"
}

// ---------------------------------------------------------------------------
// P3 Loopback Heuristic Verification Handshake
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct LoopbackProbeHit {
    pub transport: McpTransportKind,
    pub url: String,
    pub server_name: Option<String>,
}

/// Sends a short-timeout read-only MCP handshake to verify that `127.0.0.1:<port>` is a genuine
/// MCP server (`POST /mcp` JSON-RPC `initialize`, falling back to `GET /sse` checking
/// `text/event-stream`).
pub async fn probe_loopback_endpoint(port: u16, timeout: Duration) -> Option<LoopbackProbeHit> {
    let mcp_url = format!("http://127.0.0.1:{port}/mcp");
    if let Some(hit) = probe_streamable_http_mcp(&mcp_url, timeout).await {
        return Some(hit);
    }

    let sse_url = format!("http://127.0.0.1:{port}/sse");
    if let Some(hit) = probe_legacy_sse_mcp(&sse_url, timeout).await {
        return Some(hit);
    }

    None
}

async fn probe_streamable_http_mcp(url: &str, timeout: Duration) -> Option<LoopbackProbeHit> {
    let target = parse_url_target(url).ok()?;
    let payload = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": "neo-agent-os",
                "version": env!("CARGO_PKG_VERSION"),
            }
        }
    });
    let body_bytes = serde_json::to_vec(&payload).ok()?;
    let empty_hdrs = BTreeMap::new();
    let req_head = format_http_request(HttpRequestOpts {
        method: "POST",
        target: &target,
        extra_headers: &empty_hdrs,
        accept: "application/json, text/event-stream",
        content_type: Some("application/json"),
        session_id: None,
        protocol_version: None,
        connection: "close",
        body_len: Some(body_bytes.len()),
    });

    let fut = async {
        let mut stream = connect_http_stream(&target, timeout).await.ok()?;
        stream.write_all(req_head.as_bytes()).await.ok()?;
        stream.write_all(&body_bytes).await.ok()?;
        stream.flush().await.ok();

        let mut reader = BufReader::new(stream);
        let head = read_http_response_head(&mut reader).await.ok()?;
        if !(200..300).contains(&head.status) {
            return None;
        }
        let mut body_reader = BodyReader::from_head(reader, &head);
        let json_val = if head.is_sse() {
            let mut found = None;
            while let Ok(Some(ev)) = next_sse_event(&mut body_reader, 128 * 1024).await {
                if let Ok(v) = serde_json::from_str::<Value>(ev.data.trim()) {
                    found = Some(v);
                    break;
                }
            }
            found?
        } else {
            let raw = body_reader.read_all(128 * 1024).await.ok()?;
            serde_json::from_slice::<Value>(&raw).ok()?
        };

        let res = extract_matching_jsonrpc_response(&json_val, 1)?.ok()?;
        let obj = res.as_object()?;
        if obj.get("protocolVersion").is_none()
            && obj.get("serverInfo").is_none()
            && obj.get("capabilities").is_none()
        {
            return None;
        }
        let server_name = obj
            .get("serverInfo")
            .and_then(|si| si.get("name"))
            .and_then(|n| n.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        Some(LoopbackProbeHit {
            transport: McpTransportKind::StreamableHttp,
            url: url.to_string(),
            server_name,
        })
    };

    tokio::time::timeout(timeout, fut).await.ok().flatten()
}

async fn probe_legacy_sse_mcp(url: &str, timeout: Duration) -> Option<LoopbackProbeHit> {
    let target = parse_url_target(url).ok()?;
    let empty_hdrs = BTreeMap::new();
    let req_head = format_http_request(HttpRequestOpts {
        method: "GET",
        target: &target,
        extra_headers: &empty_hdrs,
        accept: "text/event-stream",
        content_type: None,
        session_id: None,
        protocol_version: None,
        connection: "close",
        body_len: None,
    });

    let fut = async {
        let mut stream = connect_http_stream(&target, timeout).await.ok()?;
        stream.write_all(req_head.as_bytes()).await.ok()?;
        stream.flush().await.ok();

        let mut reader = BufReader::new(stream);
        let head = read_http_response_head(&mut reader).await.ok()?;
        if head.status != 200 || !head.is_sse() {
            return None;
        }
        // Best-effort read of initial endpoint event to verify MCP SSE server
        let mut body_reader = BodyReader::from_head(reader, &head);
        let ev = next_sse_event(&mut body_reader, 32 * 1024).await.ok()??;
        let is_endpoint = ev
            .event
            .as_deref()
            .map(|e| e.eq_ignore_ascii_case("endpoint"))
            .unwrap_or(false);
        if !is_endpoint || ev.data.trim().is_empty() {
            return None;
        }
        Some(LoopbackProbeHit {
            transport: McpTransportKind::Sse,
            url: url.to_string(),
            server_name: None,
        })
    };

    tokio::time::timeout(timeout, fut).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;

    fn encode_chunked(parts: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for p in parts {
            out.extend_from_slice(format!("{:x}\r\n", p.len()).as_bytes());
            out.extend_from_slice(p);
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"0\r\n\r\n");
        out
    }

    async fn read_full_http_request(stream: &mut TcpStream) -> (String, HashMap<String, String>, Vec<u8>) {
        let mut reader = BufReader::new(stream);
        let mut req_line = String::new();
        reader.read_line(&mut req_line).await.unwrap();
        let mut headers = HashMap::new();
        let mut content_len = 0usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            if line == "\r\n" || line == "\n" || line.is_empty() {
                break;
            }
            if let Some((k, v)) = line.trim_end().split_once(':') {
                let kl = k.trim().to_ascii_lowercase();
                let vv = v.trim().to_string();
                if kl == "content-length" {
                    content_len = vv.parse().unwrap_or(0);
                }
                headers.insert(kl, vv);
            }
        }
        let mut body = vec![0u8; content_len];
        if content_len > 0 {
            reader.read_exact(&mut body).await.unwrap();
        }
        (req_line.trim().to_string(), headers, body)
    }

    #[tokio::test]
    async fn streamable_http_mcp_supports_json_chunked_sse_and_session_id() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            for _ in 0..5 {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let (req_line, headers, body) = read_full_http_request(&mut stream).await;
                if req_line.starts_with("DELETE ") {
                    let _ = stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                    break;
                }
                assert_eq!(
                    headers.get("authorization").map(String::as_str),
                    Some("Bearer test-local-tok")
                );
                let msg: Value = serde_json::from_slice(&body).unwrap();
                let method = msg["method"].as_str().unwrap_or("");
                let id = msg.get("id").cloned();

                match method {
                    "initialize" => {
                        let resp_body = serde_json::to_vec(&json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "protocolVersion": "2025-06-18",
                                "serverInfo": {"name": "mock-http-mcp", "version": "2.0"},
                                "capabilities": {"tools": {}}
                            }
                        }))
                        .unwrap();
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: sess-xyz-99\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            resp_body.len()
                        );
                        stream.write_all(head.as_bytes()).await.unwrap();
                        stream.write_all(&resp_body).await.unwrap();
                    }
                    "notifications/initialized" => {
                        assert_eq!(
                            headers.get("mcp-session-id").map(String::as_str),
                            Some("sess-xyz-99")
                        );
                        stream
                            .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                            .await
                            .unwrap();
                    }
                    "tools/list" => {
                        assert_eq!(
                            headers.get("mcp-session-id").map(String::as_str),
                            Some("sess-xyz-99")
                        );
                        // Respond with chunked application/json
                        let resp_body = serde_json::to_vec(&json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "tools": [{"name": "stream_calc", "inputSchema": {"type": "object"}}]
                            }
                        }))
                        .unwrap();
                        let mid = resp_body.len() / 2;
                        let chunked = encode_chunked(&[&resp_body[..mid], &resp_body[mid..]]);
                        stream
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
                            .await
                            .unwrap();
                        stream.write_all(&chunked).await.unwrap();
                    }
                    "tools/call" => {
                        assert_eq!(
                            headers.get("mcp-session-id").map(String::as_str),
                            Some("sess-xyz-99")
                        );
                        // Respond with chunked text/event-stream containing progress notification + final result
                        let prog_ev = b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":50}}\n\n";
                        let final_json = serde_json::to_string(&json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "content": [{"type": "text", "text": "sse-answer=42"}]
                            }
                        }))
                        .unwrap();
                        let final_ev = format!("event: message\ndata: {final_json}\n\n");
                        let chunked = encode_chunked(&[prog_ev, final_ev.as_bytes()]);
                        stream
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
                            .await
                            .unwrap();
                        stream.write_all(&chunked).await.unwrap();
                    }
                    _ => {}
                }
            }
        });

        let mut hdrs = BTreeMap::new();
        hdrs.insert("Authorization".to_string(), "Bearer test-local-tok".to_string());
        let client = StreamableHttpMcpClient::connect(
            &format!("http://{addr}/mcp"),
            &hdrs,
            1024 * 1024,
            Duration::from_secs(5),
        )
        .await
        .expect("connect streamable HTTP");

        assert_eq!(client.session_id().await.as_deref(), Some("sess-xyz-99"));
        assert_eq!(client.server_info()["name"], "mock-http-mcp");

        let tools = client
            .request("tools/list", json!({}), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(tools["tools"][0]["name"], "stream_calc");

        let call = client
            .request(
                "tools/call",
                json!({"name": "stream_calc", "arguments": {}}),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(call["content"][0]["text"], "sse-answer=42");

        client.shutdown().await;
        let _ = tokio::time::timeout(Duration::from_secs(2), server).await;
    }

    #[tokio::test]
    async fn legacy_sse_mcp_discovers_endpoint_and_multiplexes_responses() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let (sse_tx, mut sse_rx) = mpsc::channel::<String>(16);

        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let (req_line, _headers, body) = read_full_http_request(&mut stream).await;
                if req_line.starts_with("GET /sse ") {
                    let mut rx = std::mem::replace(&mut sse_rx, mpsc::channel(1).1);
                    tokio::spawn(async move {
                        let _ = stream
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
                            .await;
                        let ep = b"event: endpoint\ndata: /messages?sid=abc\n\n";
                        let chunk = format!("{:x}\r\n", ep.len());
                        let _ = stream.write_all(chunk.as_bytes()).await;
                        let _ = stream.write_all(ep).await;
                        let _ = stream.write_all(b"\r\n").await;
                        let _ = stream.flush().await;

                        while let Some(ev_payload) = rx.recv().await {
                            let frame = format!("event: message\ndata: {ev_payload}\n\n");
                            let hdr = format!("{:x}\r\n", frame.len());
                            if stream.write_all(hdr.as_bytes()).await.is_err() {
                                break;
                            }
                            if stream.write_all(frame.as_bytes()).await.is_err() {
                                break;
                            }
                            if stream.write_all(b"\r\n").await.is_err() {
                                break;
                            }
                            let _ = stream.flush().await;
                        }
                    });
                } else if req_line.starts_with("POST /messages?sid=abc ") {
                    let msg: Value = serde_json::from_slice(&body).unwrap();
                    let method = msg["method"].as_str().unwrap_or("");
                    let id = msg.get("id").cloned();
                    let _ = stream
                        .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                    match method {
                        "initialize" => {
                            let resp = json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "protocolVersion": "2024-11-05",
                                    "serverInfo": {"name": "mock-legacy-sse"},
                                    "capabilities": {"tools": {}}
                                }
                            });
                            let _ = sse_tx.send(resp.to_string()).await;
                        }
                        "tools/list" => {
                            let resp = json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "tools": [{"name": "legacy_ping", "inputSchema": {"type": "object"}}]
                                }
                            });
                            let _ = sse_tx.send(resp.to_string()).await;
                        }
                        "tools/call" => {
                            let resp = json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "content": [{"type": "text", "text": "legacy-pong"}]
                                }
                            });
                            let _ = sse_tx.send(resp.to_string()).await;
                        }
                        _ => {}
                    }
                }
            }
        });

        let client = LegacySseMcpClient::connect(
            &format!("http://{addr}/sse"),
            &BTreeMap::new(),
            1024 * 1024,
            Duration::from_secs(5),
        )
        .await
        .expect("connect legacy SSE MCP");

        assert_eq!(client.server_info()["name"], "mock-legacy-sse");
        assert!(client.is_alive());

        let tools = client
            .request("tools/list", json!({}), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(tools["tools"][0]["name"], "legacy_ping");

        let call = client
            .request(
                "tools/call",
                json!({"name": "legacy_ping", "arguments": {}}),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(call["content"][0]["text"], "legacy-pong");

        client.shutdown().await;
        server.abort();
    }

    #[tokio::test]
    async fn loopback_probe_verifies_mcp_and_rejects_non_mcp_servers() {
        // 1. Mock Streamable HTTP MCP server
        let mcp_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mcp_port = mcp_listener.local_addr().unwrap().port();
        let mcp_srv = tokio::spawn(async move {
            while let Ok((mut stream, _)) = mcp_listener.accept().await {
                let (req_line, _, _) = read_full_http_request(&mut stream).await;
                if req_line.starts_with("POST /mcp ") {
                    let body = br#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"probed-http-mcp"},"capabilities":{}}}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.write_all(body).await;
                } else {
                    let _ = stream
                        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                }
            }
        });

        // 2. Mock Legacy SSE MCP server
        let sse_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let sse_port = sse_listener.local_addr().unwrap().port();
        let sse_srv = tokio::spawn(async move {
            while let Ok((mut stream, _)) = sse_listener.accept().await {
                let (req_line, _, _) = read_full_http_request(&mut stream).await;
                if req_line.starts_with("GET /sse ") {
                    let body = b"event: endpoint\ndata: /messages\n\n";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.write_all(body).await;
                } else {
                    let _ = stream
                        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                }
            }
        });

        // 3. Plain non-MCP HTTP server (should NOT be admitted!)
        let plain_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let plain_port = plain_listener.local_addr().unwrap().port();
        let plain_srv = tokio::spawn(async move {
            while let Ok((mut stream, _)) = plain_listener.accept().await {
                let (_, _, _) = read_full_http_request(&mut stream).await;
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 11\r\nConnection: close\r\n\r\n<html>hi</html>")
                    .await;
            }
        });

        let hit_http = probe_loopback_endpoint(mcp_port, Duration::from_millis(800))
            .await
            .expect("should verify HTTP MCP");
        assert_eq!(hit_http.transport, McpTransportKind::StreamableHttp);
        assert_eq!(hit_http.server_name.as_deref(), Some("probed-http-mcp"));

        let hit_sse = probe_loopback_endpoint(sse_port, Duration::from_millis(800))
            .await
            .expect("should verify SSE MCP");
        assert_eq!(hit_sse.transport, McpTransportKind::Sse);

        let hit_plain = probe_loopback_endpoint(plain_port, Duration::from_millis(800)).await;
        assert!(hit_plain.is_none(), "non-MCP HTTP server must not be admitted");

        mcp_srv.abort();
        sse_srv.abort();
        plain_srv.abort();
    }
}
