//! The application's JSON API, who may call it, and the web build's files.

use crate::server::{Request, Response};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use neo_app::app::App;
use neo_app::sessions::ChatAttachment;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The most files one chat message carries.
pub const MAX_FILES: usize = 3;
/// The largest file of a chat message.
pub const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;
/// The longest chat message, in characters.
pub const MAX_TEXT_CHARS: usize = 8000;

/// How the API is offered.
#[derive(Clone, Debug, Default)]
pub struct Access {
    /// The token every API call carries as `Authorization: Bearer …`; without one, only this machine may call.
    pub token: Option<String>,
    /// The folder of the web build served beside the API.
    pub web_dir: Option<PathBuf>,
}

/// Compare two secrets without telling, by the time it takes, where they differ.
fn same_secret(given: &str, expected: &str) -> bool {
    let (given, expected) = (given.as_bytes(), expected.as_bytes());
    let mut difference = given.len() ^ expected.len();
    for at in 0..given.len().max(expected.len()) {
        difference |= (*given.get(at).unwrap_or(&0) ^ *expected.get(at).unwrap_or(&0)) as usize;
    }
    difference == 0
}

/// The host of a `Host` header or an origin, without its port.
fn host_name(host: &str) -> &str {
    match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.rsplit_once(':').filter(|(_, port)| port.bytes().all(|b| b.is_ascii_digit())).map(|(name, _)| name).unwrap_or(host),
    }
}

fn loopback_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("localhost") || name.parse::<std::net::IpAddr>().is_ok_and(|address| address.is_loopback())
}

/// Why a request may not call the API, as the response to give.
fn refused(request: &Request, peer: SocketAddr, access: &Access) -> Option<Response> {
    let host = request.header("host").unwrap_or("");
    // A page of another site must not call the API through a person's browser.
    if let Some(origin) = request.header("origin") {
        let same = origin.split_once("://").is_some_and(|(scheme, rest)| matches!(scheme, "http" | "https") && rest.eq_ignore_ascii_case(host));
        if !same {
            return Some(Response::error(403, "Forbidden origin"));
        }
    }
    match &access.token {
        Some(token) => {
            let given = request.header("authorization").and_then(|value| value.strip_prefix("Bearer ")).unwrap_or("");
            (!same_secret(given.trim(), token)).then(|| {
                let mut response = Response::error(401, "A valid access token is required");
                response.headers.push(("www-authenticate", "Bearer".into()));
                response
            })
        }
        // Without a token only this machine calls, and under its own name: another name resolving here is refused.
        None => (!peer.ip().is_loopback() || !loopback_name(host_name(host)))
            .then(|| Response::error(403, "Only this computer may call the API without an access token")),
    }
}

fn json_body(request: &Request) -> Result<Value, Response> {
    let content_type = request.header("content-type").unwrap_or("");
    if !content_type.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json") {
        return Err(Response::error(415, "Expected application/json"));
    }
    serde_json::from_slice(&request.body).map_err(|error| Response::error(400, &format!("Invalid JSON: {error}")))
}

fn attachment(value: &Value) -> Result<ChatAttachment, String> {
    if !value.is_object() {
        return Err("Invalid attachment".into());
    }
    let name = value["name"].as_str().ok_or("Attachment name must be a string")?;
    let name: String = name.chars().map(|c| if matches!(c, '/' | '\\') || c.is_control() { '_' } else { c }).collect();
    let name: String = name.trim().chars().take(200).collect();
    let media_type: String = value["mediaType"].as_str().unwrap_or("").trim().to_lowercase().chars().take(200).collect();
    let encoded = value["data"].as_str().ok_or("Attachment data must be base64")?;
    // Four characters of base64 carry three bytes: refuse an oversized one before decoding it.
    if encoded.len() > MAX_FILE_BYTES / 3 * 4 + 8 {
        return Err("Attachment data is invalid or exceeds 5 MiB".into());
    }
    let data = STANDARD.decode(encoded).ok().filter(|data| data.len() <= MAX_FILE_BYTES).ok_or("Attachment data is invalid or exceeds 5 MiB")?;
    Ok(ChatAttachment { name: if name.is_empty() { "attachment".into() } else { name }, media_type, data })
}

async fn chat(app: &Arc<App>, request: &Request) -> Result<Response, Response> {
    let body = json_body(request)?;
    let bad = |message: &str| Response::error(400, message);
    let text = body.get("text").and_then(Value::as_str).ok_or_else(|| bad("Expected { text: string }"))?.trim();
    let attachments = match body.get("attachments") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) if items.len() <= MAX_FILES => items.iter().map(attachment).collect::<Result<Vec<_>, _>>().map_err(|error| bad(&error))?,
        Some(Value::Array(_)) => return Err(bad(&format!("At most {MAX_FILES} attachments"))),
        Some(_) => return Err(bad("attachments must be a list")),
    };
    if (text.is_empty() && attachments.is_empty()) || text.chars().count() > MAX_TEXT_CHARS {
        return Err(bad(&format!("Message or attachment required; text limit {MAX_TEXT_CHARS} characters")));
    }
    let message_id = match body.get("messageId") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) => Some(id.clone()),
        Some(_) => return Err(bad("messageId must be a string")),
    };
    let receipt = app.receive_web(text, attachments, message_id).await.map_err(|error| bad(&error))?;
    Ok(Response::json(202, &json!({"requestId": receipt.request_id, "triggerId": receipt.trigger_id, "result": receipt.result.as_str()})))
}

fn done(result: Result<Value, String>) -> Result<Response, Response> {
    result.map(|value| Response::json(200, &value)).map_err(|error| Response::error(400, &error))
}

async fn route(app: &Arc<App>, request: &Request) -> Result<Response, Response> {
    let ok = |value: Value| Ok(Response::json(200, &value));
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/health") => ok(app.health_view()),
        ("GET", "/api/messages") => ok(json!({"messages": app.panel_messages()})),
        ("GET", "/api/workers") => ok(json!({"workers": app.worker_cards().await})),
        ("GET", "/api/activity") => ok(app.activity_view().await),
        ("GET", path) if path.starts_with("/api/workers/") => match app.worker_detail(&path["/api/workers/".len()..]).await {
            Some(worker) => ok(worker),
            None => Err(Response::error(404, "Worker not found")),
        },
        ("GET", "/api/settings/models") => ok(app.models_view().await),
        ("PUT", "/api/settings/models") => done(app.update_models(json_body(request)?).await),
        ("PUT", "/api/settings/kernel") => done(app.set_kernel(json_body(request)?).await),
        ("GET", "/api/settings/general") => ok(app.general_view()),
        ("PUT", "/api/settings/general") => done(app.update_general(json_body(request)?).await),
        ("POST", "/api/session/reset") => done(app.reset_orchestrator().await.map(|()| json!({"reset": true}))),
        ("GET", "/api/wechat") => ok(json!(app.wechat_status())),
        ("POST", "/api/wechat/connect") => ok(json!(app.wechat_connect().await)),
        ("POST", "/api/wechat/disconnect") => ok(json!(app.wechat_disconnect().await)),
        ("POST", "/api/wechat/verify") => {
            let body = json_body(request)?;
            let code = body.get("code").and_then(Value::as_str).ok_or_else(|| Response::error(400, "Expected { code: string }"))?;
            done(app.wechat_verify(code).map(|status| json!(status)))
        }
        ("POST", "/api/chat") => chat(app, request).await,
        _ => Err(Response::error(404, "Not found")),
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// What a page of the web build may load: only what this server gives it.
const PAGE_POLICY: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/// A file of the web build; any path that names no file is the app itself, which routes within the page.
async fn web_file(web_dir: &Path, path: &str) -> Response {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.iter().any(|part| *part == ".." || *part == "." || part.contains('\\') || part.contains('\0') || part.contains(':')) {
        return Response::error(404, "Not found");
    }
    let mut file = parts.iter().fold(web_dir.to_path_buf(), |dir, part| dir.join(part));
    let is_file = |path: &Path| path.is_file();
    if !is_file(&file) {
        // A missing asset is an error; a missing page is a route of the app.
        if parts.last().is_some_and(|name| name.contains('.')) {
            return Response::error(404, "Not found");
        }
        file = web_dir.join("index.html");
    }
    let read = {
        let file = file.clone();
        tokio::task::spawn_blocking(move || std::fs::read(file)).await
    };
    match read {
        Ok(Ok(body)) => Response {
            status: 200,
            content_type: content_type(&file).into(),
            body,
            headers: vec![
                ("cache-control", "no-cache".into()),
                ("content-security-policy", PAGE_POLICY.into()),
                ("x-content-type-options", "nosniff".into()),
                ("referrer-policy", "no-referrer".into()),
            ],
        },
        _ => Response::error(404, "Not found"),
    }
}

/// Answer one request.
pub async fn handle(app: Arc<App>, access: Arc<Access>, request: Request, peer: SocketAddr) -> Response {
    if request.path == "/api" || request.path.starts_with("/api/") {
        if let Some(response) = refused(&request, peer, &access) {
            // Whether the server is there, and that it wants a token, is no secret.
            if request.method == "GET" && request.path == "/api/health" && response.status == 401 {
                let mut hint =
                    Response::json(401, &json!({"error": "A valid access token is required", "authRequired": true, "version": env!("CARGO_PKG_VERSION")}));
                hint.headers.push(("www-authenticate", "Bearer".into()));
                return hint;
            }
            return response;
        }
        return match route(&app, &request).await {
            Ok(response) | Err(response) => response,
        };
    }
    if !matches!(request.method.as_str(), "GET" | "HEAD") {
        return Response::error(404, "Not found");
    }
    match &access.web_dir {
        Some(web_dir) => web_file(web_dir, &request.path).await,
        None => Response::error(404, "Not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(headers: &[(&str, &str)]) -> Request {
        Request {
            method: "GET".into(),
            path: "/api/health".into(),
            headers: headers.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect(),
            ..Request::default()
        }
    }

    #[test]
    fn lets_only_this_machine_call_without_a_token() {
        let open = Access::default();
        let local: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let remote: SocketAddr = "192.168.1.9:50000".parse().unwrap();
        let status = |headers: &[(&str, &str)], peer| refused(&request(headers), peer, &open).map(|response| response.status);
        assert_eq!(status(&[("host", "127.0.0.1:3082")], local), None);
        assert_eq!(status(&[("host", "localhost:3082")], local), None);
        assert_eq!(status(&[("host", "[::1]:3082")], "[::1]:50000".parse().unwrap()), None);
        assert_eq!(status(&[("host", "127.0.0.1:3082"), ("origin", "http://127.0.0.1:3082")], local), None);
        // Another site's page, a name that only resolves here, and another machine.
        assert_eq!(status(&[("host", "127.0.0.1:3082"), ("origin", "https://evil.example")], local), Some(403));
        assert_eq!(status(&[("host", "127.0.0.1:3082"), ("origin", "null")], local), Some(403));
        assert_eq!(status(&[("host", "rebind.example:3082")], local), Some(403));
        assert_eq!(status(&[], local), Some(403));
        assert_eq!(status(&[("host", "127.0.0.1:3082")], remote), Some(403));
    }

    #[test]
    fn asks_everyone_for_the_token_once_one_is_set() {
        let access = Access { token: Some("s3cret-token".into()), web_dir: None };
        let remote: SocketAddr = "192.168.1.9:50000".parse().unwrap();
        let status = |headers: &[(&str, &str)]| refused(&request(headers), remote, &access).map(|response| response.status);
        assert_eq!(status(&[("host", "neo.example"), ("authorization", "Bearer s3cret-token")]), None);
        assert_eq!(status(&[("host", "neo.example"), ("authorization", "Bearer s3cret-token"), ("origin", "https://neo.example")]), None);
        assert_eq!(status(&[("host", "neo.example")]), Some(401));
        assert_eq!(status(&[("host", "neo.example"), ("authorization", "Bearer s3cret-tokex")]), Some(401));
        assert_eq!(status(&[("host", "neo.example"), ("authorization", "Bearer s3cret-token-and-more")]), Some(401));
        assert_eq!(status(&[("host", "neo.example"), ("authorization", "Basic s3cret-token")]), Some(401));
        assert_eq!(status(&[("host", "neo.example"), ("authorization", "Bearer s3cret-token"), ("origin", "https://other.example")]), Some(403));
        assert!(same_secret("abc", "abc") && !same_secret("abc", "abd") && !same_secret("", "abc") && !same_secret("abcd", "abc"));
    }

    #[test]
    fn reads_an_attachment_strictly() {
        let read = attachment(&json!({"name": " ../a\\b\u{1}.png ", "mediaType": " Image/PNG ", "data": "iVBORw=="})).unwrap();
        assert_eq!((read.name.as_str(), read.media_type.as_str(), read.data.as_slice()), (".._a_b_.png", "image/png", &[0x89, b'P', b'N', b'G'][..]));
        assert_eq!(attachment(&json!({"name": "  ", "data": ""})).unwrap().name, "attachment");
        assert_eq!(attachment(&json!("x")).unwrap_err(), "Invalid attachment");
        assert_eq!(attachment(&json!({"data": "AA=="})).unwrap_err(), "Attachment name must be a string");
        assert_eq!(attachment(&json!({"name": "a"})).unwrap_err(), "Attachment data must be base64");
        assert_eq!(attachment(&json!({"name": "a", "data": "not base64!"})).unwrap_err(), "Attachment data is invalid or exceeds 5 MiB");
        let big = STANDARD.encode(vec![0u8; MAX_FILE_BYTES + 1]);
        assert_eq!(attachment(&json!({"name": "a", "data": big})).unwrap_err(), "Attachment data is invalid or exceeds 5 MiB");
        let most = STANDARD.encode(vec![0u8; MAX_FILE_BYTES]);
        assert_eq!(attachment(&json!({"name": "a", "data": most})).unwrap().data.len(), MAX_FILE_BYTES);
    }

    #[test]
    fn knows_the_types_of_the_web_builds_files() {
        let of = |name: &str| content_type(Path::new(name));
        assert_eq!(
            (of("index.html"), of("main.dart.js"), of("canvaskit.wasm"), of("a.PNG"), of("x.unknown")),
            ("text/html; charset=utf-8", "text/javascript; charset=utf-8", "application/wasm", "image/png", "application/octet-stream")
        );
        assert_eq!(
            (host_name("127.0.0.1:3082"), host_name("localhost"), host_name("[::1]:3082"), host_name("a.example:x")),
            ("127.0.0.1", "localhost", "::1", "a.example:x")
        );
    }
}
