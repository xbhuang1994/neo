//! A small HTTP/1.1 server: requests with a declared length, responses with one, connections kept open between
//! requests. It serves one application to its own interface, so it is strict rather than general.

use std::collections::BTreeMap;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;

/// The largest request body taken.
pub const MAX_BODY_BYTES: usize = 24 * 1024 * 1024;
const MAX_HEAD_BYTES: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 256;
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
const BODY_TIMEOUT: Duration = Duration::from_secs(120);
const WRITE_TIMEOUT: Duration = Duration::from_secs(120);

/// A request.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Request {
    /// The method, in capitals.
    pub method: String,
    /// The path, percent-decoded, without the query.
    pub path: String,
    /// The query, as sent.
    pub query: String,
    /// The headers, names in lowercase.
    pub headers: BTreeMap<String, String>,
    /// The body.
    pub body: Vec<u8>,
}

impl Request {
    /// A header's value.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

/// A response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
    /// The status code.
    pub status: u16,
    /// The content type.
    pub content_type: String,
    /// The body.
    pub body: Vec<u8>,
    /// More headers.
    pub headers: Vec<(&'static str, String)>,
}

impl Response {
    /// A JSON response, never cached.
    pub fn json(status: u16, value: &serde_json::Value) -> Response {
        Response {
            status,
            content_type: "application/json; charset=utf-8".into(),
            body: value.to_string().into_bytes(),
            headers: vec![("cache-control", "no-store".into())],
        }
    }
    /// A JSON error: `{"error": …}`.
    pub fn error(status: u16, message: &str) -> Response {
        Response::json(status, &serde_json::json!({"error": message}))
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        411 => "Length Required",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

/// Decode `%XX` in a path; `None` when it is malformed or not UTF-8.
pub fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            decoded.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// What reading a request found.
enum Read {
    Request(Request, bool),
    /// The peer closed, or sent nothing in time.
    Closed,
    /// The request cannot be served: answer this and close.
    Refuse(Response),
}

fn parse_head(head: &str) -> Option<(Request, bool)> {
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target, version) = (first.next()?, first.next()?, first.next()?);
    if first.next().is_some() || !version.starts_with("HTTP/1.") || method.is_empty() || !target.starts_with('/') {
        return None;
    }
    let (raw_path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut headers = BTreeMap::new();
    for line in lines {
        let (name, value) = line.split_once(':')?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    let connection = headers.get("connection").map(|value| value.to_ascii_lowercase()).unwrap_or_default();
    let keep = if version == "HTTP/1.0" { connection.contains("keep-alive") } else { !connection.contains("close") };
    Some((Request { method: method.to_ascii_uppercase(), path: percent_decode(raw_path)?, query: query.to_string(), headers, body: Vec::new() }, keep))
}

async fn read_request(stream: &mut TcpStream, buffer: &mut Vec<u8>) -> Read {
    let mut chunk = vec![0u8; 16 * 1024];
    let head_end = loop {
        match buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            Some(end) if end <= MAX_HEAD_BYTES => break end,
            Some(_) => return Read::Refuse(Response::error(431, "Request headers too large")),
            None => {}
        }
        if buffer.len() > MAX_HEAD_BYTES {
            return Read::Refuse(Response::error(431, "Request headers too large"));
        }
        match tokio::time::timeout(HEAD_TIMEOUT, stream.read(&mut chunk)).await {
            Ok(Ok(read)) if read > 0 => buffer.extend_from_slice(&chunk[..read]),
            _ => return Read::Closed,
        }
    };
    let Some((mut request, keep)) = std::str::from_utf8(&buffer[..head_end]).ok().and_then(parse_head) else {
        return Read::Refuse(Response::error(400, "Malformed request"));
    };
    buffer.drain(..head_end + 4);
    if request.headers.contains_key("transfer-encoding") {
        return Read::Refuse(Response::error(411, "Send the body with a Content-Length"));
    }
    let length = match request.header("content-length") {
        None => 0,
        Some(value) => match value.parse::<usize>() {
            Ok(length) => length,
            Err(_) => return Read::Refuse(Response::error(400, "Malformed Content-Length")),
        },
    };
    if length > MAX_BODY_BYTES {
        return Read::Refuse(Response::error(413, "Request body too large"));
    }
    if length > buffer.len()
        && request.header("expect").is_some_and(|value| value.eq_ignore_ascii_case("100-continue"))
        && stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await.is_err()
    {
        return Read::Closed;
    }
    let body = async {
        while buffer.len() < length {
            match stream.read(&mut chunk).await {
                Ok(read) if read > 0 => buffer.extend_from_slice(&chunk[..read]),
                _ => return false,
            }
        }
        true
    };
    match tokio::time::timeout(BODY_TIMEOUT, body).await {
        Ok(true) => {}
        Ok(false) => return Read::Closed,
        Err(_) => return Read::Refuse(Response::error(408, "The request body did not arrive in time")),
    }
    request.body = buffer.drain(..length).collect();
    Read::Request(request, keep)
}

async fn write_response(stream: &mut TcpStream, response: &Response, keep: bool, head_only: bool) -> bool {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: {}\r\ncontent-length: {}\r\n",
        response.status,
        reason(response.status),
        response.content_type,
        response.body.len()
    );
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(if keep { "connection: keep-alive\r\n\r\n" } else { "connection: close\r\n\r\n" });
    let write = async {
        stream.write_all(head.as_bytes()).await?;
        if !head_only {
            stream.write_all(&response.body).await?;
        }
        stream.flush().await
    };
    matches!(tokio::time::timeout(WRITE_TIMEOUT, write).await, Ok(Ok(())))
}

/// Answers requests.
pub type Handler = Arc<dyn Fn(Request, SocketAddr) -> Pin<Box<dyn Future<Output = Response> + Send>> + Send + Sync>;

async fn serve_connection(mut stream: TcpStream, peer: SocketAddr, handler: Handler, mut stopping: watch::Receiver<bool>) {
    let _ = stream.set_nodelay(true);
    let mut buffer = Vec::new();
    loop {
        let read = tokio::select! {
            read = read_request(&mut stream, &mut buffer) => read,
            _ = stopping.wait_for(|stopping| *stopping) => return,
        };
        match read {
            Read::Closed => return,
            Read::Refuse(response) => {
                write_response(&mut stream, &response, false, false).await;
                return;
            }
            Read::Request(request, keep) => {
                let head_only = request.method == "HEAD";
                // A request that was taken is answered, also while the server stops.
                let response = handler(request, peer).await;
                let keep = keep && !*stopping.borrow();
                if !write_response(&mut stream, &response, keep, head_only).await || !keep {
                    let _ = stream.shutdown().await;
                    return;
                }
            }
        }
    }
}

/// A listening server.
pub struct Server {
    /// The address it listens on.
    pub addr: SocketAddr,
    stopping: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    /// Listen on `host:port`, port 0 for any free one, and answer with `handler`.
    pub async fn bind(host: &str, port: u16, handler: Handler) -> Result<Server, String> {
        let listener = TcpListener::bind((host, port)).await.map_err(|error| format!("Cannot listen on {host}:{port}: {error}"))?;
        let addr = listener.local_addr().map_err(|error| error.to_string())?;
        let (stopping, stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            let room = Arc::new(Semaphore::new(MAX_CONNECTIONS));
            let mut connections = JoinSet::new();
            let mut stop = stopped.clone();
            loop {
                let accepted = tokio::select! {
                    accepted = listener.accept() => accepted,
                    _ = stop.wait_for(|stopping| *stopping) => break,
                    // Finished connections are forgotten as they end.
                    Some(_) = connections.join_next() => continue,
                };
                let Ok((stream, peer)) = accepted else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                let Ok(permit) = room.clone().try_acquire_owned() else {
                    // Too many connections at once: this one is dropped unanswered.
                    continue;
                };
                let (handler, stopped) = (handler.clone(), stopped.clone());
                connections.spawn(async move {
                    serve_connection(stream, peer, handler, stopped).await;
                    drop(permit);
                });
            }
            drop(listener);
            // Requests under way get a moment to finish.
            let _ = tokio::time::timeout(Duration::from_secs(3), async { while connections.join_next().await.is_some() {} }).await;
            connections.shutdown().await;
        });
        Ok(Server { addr, stopping, task })
    }

    /// Stop listening, let requests under way finish, and close every connection.
    pub async fn shutdown(self) {
        self.stopping.send_replace(true);
        let _ = self.task.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_request_head_and_decides_whether_the_connection_stays() {
        let (request, keep) =
            parse_head("POST /api/workers/a%20b?x=1%202 HTTP/1.1\r\nHost: 127.0.0.1:3082\r\nContent-Type:  application/json \r\nX-Empty:").unwrap();
        assert_eq!((request.method.as_str(), request.path.as_str(), request.query.as_str()), ("POST", "/api/workers/a b", "x=1%202"));
        assert_eq!(
            (request.header("host"), request.header("content-type"), request.header("x-empty")),
            (Some("127.0.0.1:3082"), Some("application/json"), Some(""))
        );
        assert!(keep);
        assert!(!parse_head("GET / HTTP/1.1\r\nConnection: close").unwrap().1);
        assert!(!parse_head("GET / HTTP/1.0").unwrap().1);
        assert!(parse_head("GET / HTTP/1.0\r\nConnection: Keep-Alive").unwrap().1);
        for bad in
            ["GET /", "GET / HTTP/2", "GET nothing HTTP/1.1", "GET / HTTP/1.1 extra", "GET /%zz HTTP/1.1", "GET /%ff HTTP/1.1", "GET / HTTP/1.1\r\nno colon"]
        {
            assert!(parse_head(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("/a%2Fb/%E4%B8%AD").as_deref(), Some("/a/b/中"));
        assert_eq!(percent_decode("plain").as_deref(), Some("plain"));
        assert_eq!((percent_decode("%"), percent_decode("%4"), percent_decode("%c3%28")), (None, None, None));
    }
}
