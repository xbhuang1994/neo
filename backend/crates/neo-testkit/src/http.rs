//! A minimal HTTP/1.1 server on a loopback port: one request per connection, answered by a closure.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// A received request.
#[derive(Clone, Debug, Default)]
pub struct Request {
    /// The method, such as `POST`.
    pub method: String,
    /// The path with its query.
    pub path: String,
    /// Header names in lowercase.
    pub headers: BTreeMap<String, String>,
    /// The body.
    pub body: Vec<u8>,
}

/// A response to send.
#[derive(Clone, Debug)]
pub struct Response {
    /// The status code.
    pub status: u16,
    /// The content type.
    pub content_type: String,
    /// The body.
    pub body: Vec<u8>,
    /// More headers than the content type.
    pub headers: Vec<(String, String)>,
}

impl Response {
    /// A response of raw bytes.
    pub fn bytes(status: u16, body: Vec<u8>) -> Response {
        Response { status, content_type: "application/octet-stream".into(), body, headers: Vec::new() }
    }
    /// The same response with one more header.
    pub fn header(mut self, name: &str, value: &str) -> Response {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }
    /// A JSON response.
    pub fn json(status: u16, value: &serde_json::Value) -> Response {
        Response { status, content_type: "application/json".into(), body: value.to_string().into_bytes(), headers: Vec::new() }
    }
    /// A server-sent-events response.
    pub fn events(body: String) -> Response {
        Response { status: 200, content_type: "text/event-stream".into(), body: body.into_bytes(), headers: Vec::new() }
    }
}

/// A running server; it stops when dropped.
pub struct Server {
    /// The address it listens on.
    pub addr: SocketAddr,
    task: JoinHandle<()>,
}

impl Server {
    /// `http://127.0.0.1:<port>`.
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut data = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break end;
        }
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        data.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&data[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_string(), first.next()?.to_string());
    let headers: BTreeMap<String, String> =
        lines.filter_map(|line| line.split_once(':')).map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string())).collect();
    let length: usize = headers.get("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
    let mut body = data[head_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Some(Request { method, path, headers, body })
}

/// Serve every request on a free loopback port with `handler`.
pub async fn serve(handler: impl Fn(Request) -> Response + Send + Sync + 'static) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a loopback port is free");
    let addr = listener.local_addr().expect("the listener has an address");
    let handler = Arc::new(handler);
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let handler = handler.clone();
            tokio::spawn(async move {
                let Some(request) = read_request(&mut stream).await else { return };
                let response = handler(request);
                let more: String = response.headers.iter().map(|(name, value)| format!("{name}: {value}\r\n")).collect();
                let head = format!(
                    "HTTP/1.1 {} OK\r\ncontent-type: {}\r\ncontent-length: {}\r\n{more}connection: close\r\n\r\n",
                    response.status,
                    response.content_type,
                    response.body.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(&response.body).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    Server { addr, task }
}
