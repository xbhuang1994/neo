//! The HTTP API end to end, over a scripted kernel: every route's contract, who may call, the web build's files, and
//! the protocol's edges.

#[path = "../../neo-app/tests/common/mod.rs"]
mod common;

use common::*;
use neo_app::http::{send, Request};
use neo_http::server::Server;
use neo_http::{serve, Access};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Api {
    base: String,
    token: Option<String>,
}

impl Api {
    async fn call(&self, method: &'static str, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut headers = Vec::new();
        if body.is_some() {
            headers.push(("content-type".to_string(), "application/json; charset=utf-8".to_string()));
        }
        if let Some(token) = &self.token {
            headers.push(("authorization".to_string(), format!("Bearer {token}")));
        }
        let request = Request {
            method,
            url: format!("{}{path}", self.base),
            headers,
            body: body.map(|body| body.to_string().into_bytes()),
            timeout: Duration::from_secs(20),
            want: Vec::new(),
        };
        let response = send(request).await.expect("the server answers");
        (response.status, serde_json::from_slice(&response.body).unwrap_or(Value::Null))
    }
    async fn get(&self, path: &str) -> (u16, Value) {
        self.call("GET", path, None).await
    }
}

async fn open(f: &Fixture, access: Access) -> (Server, Api) {
    let token = access.token.clone();
    let server = serve(f.app.clone(), "127.0.0.1", 0, access).await.expect("the server listens");
    let base = format!("http://{}", server.addr);
    (server, Api { base, token })
}

/// Send raw bytes and read until the server closes the connection.
async fn raw(server: &Server, bytes: &[u8]) -> String {
    let mut stream = tokio::net::TcpStream::connect(server.addr).await.unwrap();
    stream.write_all(bytes).await.unwrap();
    let mut answer = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut answer)).await.expect("the server closes the connection");
    String::from_utf8_lossy(&answer).to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_every_route_of_the_app() {
    let f = fixture().await;
    *f.kernels.models.lock().unwrap() = vec![neo_app::kernels::ModelOption { id: "big".into(), provider: "fixture".into(), name: "Big".into() }];
    f.app.start().await.unwrap();
    let (server, api) = open(&f, Access::default()).await;

    let (status, health) = api.get("/api/health").await;
    assert_eq!((status, health["ready"].as_bool(), health["kernel"].as_str()), (200, Some(true), Some("omp")));
    assert_eq!(api.get("/api/messages").await, (200, json!({"messages": []})));
    assert_eq!(api.get("/api/workers").await, (200, json!({"workers": []})));
    assert_eq!(api.get("/api/activity").await, (200, json!({"router": false, "workers": []})));

    // A chat message is taken once, however often it is sent.
    let message = json!({"text": "  Please fix the typo in the fixture.  ", "messageId": "web:m1", "attachments": [{"name": "notes.md", "mediaType": "text/markdown", "data": "IyBOb3Rlcw=="}]});
    let (status, receipt) = api.call("POST", "/api/chat", Some(message.clone())).await;
    assert_eq!((status, receipt["requestId"].as_str(), receipt["result"].as_str()), (202, Some("chat:web:m1"), Some("stored")));
    let (status, again) = api.call("POST", "/api/chat", Some(message)).await;
    assert_eq!((status, again["result"].as_str(), &again["triggerId"]), (202, Some("duplicate"), &receipt["triggerId"]));
    f.until("the result is in the transcript", || f.chat().len() >= 3).await;
    f.settle().await;
    let (_, messages) = api.get("/api/messages").await;
    let messages = messages["messages"].as_array().unwrap().clone();
    assert_eq!(messages.iter().map(|message| message["role"].as_str().unwrap()).collect::<Vec<_>>(), vec!["user", "assistant", "assistant"]);
    assert!(messages[0]["text"].as_str().unwrap().starts_with("Please fix the typo in the fixture.\n\n<attachment name=\"notes.md\">"));
    assert_eq!(messages[0]["files"], json!([{"name": "notes.md", "mediaType": "text/markdown", "kind": "text"}]));
    assert_eq!(messages[2]["text"], "Fixture work completed.");

    let (_, workers) = api.get("/api/workers").await;
    let id = workers["workers"][0]["ticketId"].as_str().unwrap().to_string();
    assert_eq!((workers["workers"].as_array().map(Vec::len), &workers["workers"][0]["stage"]), (Some(1), &json!({"stage": "ended"})));
    let (status, worker) = api.get(&format!("/api/workers/{id}")).await;
    assert_eq!((status, worker["ticketId"].as_str(), worker["recent"].is_array(), worker["inputs"].is_array()), (200, Some(id.as_str()), true, true));
    assert_eq!(api.get("/api/workers/missing").await, (404, json!({"error": "Worker not found"})));
    assert_eq!(api.get("/api/workers/a%2Fb").await.0, 404);

    // Models and the kernel.
    let (status, models) = api.get("/api/settings/models").await;
    assert_eq!((status, models["kernel"].as_str(), models["available"][0]["id"].as_str()), (200, Some("omp"), Some("big")));
    let chosen = json!({"eval": {"provider": "fixture", "model": "big", "thinkingLevel": "low"}, "executor": null, "advisor": null});
    let (status, models) = api.call("PUT", "/api/settings/models", Some(chosen.clone())).await;
    assert_eq!((status, &models["current"]), (200, &chosen));
    assert_eq!(
        api.call("PUT", "/api/settings/models", Some(json!({"eval": {"provider": "x", "model": "y"}, "executor": null, "advisor": null}))).await,
        (400, json!({"error": "Unknown OMP model: x/y"}))
    );
    let (status, switched) = api.call("PUT", "/api/settings/kernel", Some(json!({"kernel": "claude"}))).await;
    assert_eq!((status, switched["kernel"].as_str(), switched["supports"]["advisor"].as_bool()), (200, Some("claude"), Some(false)));
    assert_eq!(api.call("PUT", "/api/settings/kernel", Some(json!({"kernel": "other"}))).await, (400, json!({"error": "kernel is omp, claude or antigravity"})));
    assert_eq!(api.call("PUT", "/api/settings/kernel", Some(json!({"kernel": "omp"}))).await.1["current"], chosen);

    // General settings.
    let (status, general) = api.get("/api/settings/general").await;
    assert_eq!((status, general["executor"]["maxWorkers"].as_u64(), general["paused"].as_bool()), (200, Some(3), Some(false)));
    let (status, general) = api.call("PUT", "/api/settings/general", Some(json!({"executor": {"maxWorkers": 2}}))).await;
    assert_eq!((status, general["executor"]["maxWorkers"].as_u64()), (200, Some(2)));
    let (status, refused) = api.call("PUT", "/api/settings/general", Some(json!({"executor": {"maxWorkers": 0}}))).await;
    assert!(status == 400 && refused["error"].as_str().unwrap().contains("1 to 16"), "{refused}");

    // WeChat: its state, and what cannot be done without a login.
    let (status, wechat) = api.get("/api/wechat").await;
    assert_eq!((status, wechat["state"].as_str()), (200, Some("disconnected")));
    assert_eq!(api.call("POST", "/api/wechat/verify", Some(json!({"code": "1234"}))).await, (400, json!({"error": "当前不需要微信验证码"})));
    assert_eq!(api.call("POST", "/api/wechat/verify", Some(json!({"code": 1234}))).await, (400, json!({"error": "Expected { code: string }"})));
    assert_eq!(api.call("POST", "/api/wechat/disconnect", None).await.1["state"], "disconnected");

    // What a chat message must be.
    let refused = |body: Value| async { api.call("POST", "/api/chat", Some(body)).await };
    assert_eq!(refused(json!({"message": "x"})).await, (400, json!({"error": "Expected { text: string }"})));
    assert_eq!(refused(json!({"text": "   "})).await, (400, json!({"error": "Message or attachment required; text limit 8000 characters"})));
    assert_eq!(refused(json!({"text": "长".repeat(8001)})).await.0, 400);
    assert_eq!(refused(json!({"text": "é".repeat(8000), "messageId": "web:long"})).await.0, 202);
    let file = json!({"name": "a.bin", "data": "AA=="});
    assert_eq!(refused(json!({"text": "x", "attachments": [file, file, file, file]})).await, (400, json!({"error": "At most 3 attachments"})));
    assert_eq!(
        refused(json!({"text": "x", "attachments": [{"name": "a", "data": "@@"}]})).await,
        (400, json!({"error": "Attachment data is invalid or exceeds 5 MiB"}))
    );
    assert_eq!(refused(json!({"text": "x", "attachments": "none"})).await, (400, json!({"error": "attachments must be a list"})));
    assert_eq!(refused(json!({"text": "x", "messageId": 7})).await, (400, json!({"error": "messageId must be a string"})));
    assert_eq!(refused(json!({"text": "x", "messageId": "bad id"})).await, (400, json!({"error": "Invalid chat message ID"})));
    let plain = Request {
        method: "POST",
        url: format!("{}/api/chat", api.base),
        headers: vec![("content-type".into(), "text/plain".into())],
        body: Some(b"{\"text\":\"x\"}".to_vec()),
        timeout: Duration::from_secs(5),
        want: vec![],
    };
    assert_eq!(send(plain).await.unwrap().status, 415);
    let broken = Request {
        method: "POST",
        url: format!("{}/api/chat", api.base),
        headers: vec![("content-type".into(), "application/json".into())],
        body: Some(b"{\"text\":".to_vec()),
        timeout: Duration::from_secs(5),
        want: vec![],
    };
    let response = send(broken).await.unwrap();
    assert!(response.status == 400 && String::from_utf8_lossy(&response.body).contains("Invalid JSON"));

    // Routes that are not there, by path or by method.
    assert_eq!(api.get("/api/nothing").await, (404, json!({"error": "Not found"})));
    assert_eq!(api.call("POST", "/api/messages", None).await.0, 404);
    assert_eq!(api.get("/").await.0, 404, "no web build is served unless one is named");

    // A reset empties the conversation and keeps the tickets.
    f.settle().await;
    assert_eq!(api.call("POST", "/api/session/reset", None).await, (200, json!({"reset": true})));
    assert_eq!(api.get("/api/messages").await, (200, json!({"messages": []})));
    assert_eq!(api.get("/api/workers").await.1["workers"].as_array().map(Vec::len), Some(2));
    api.call("POST", "/api/chat", Some(json!({"text": "And another typo."}))).await;
    f.until("the conversation goes on", || f.chat().len() >= 3).await;

    server.shutdown().await;
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn lets_in_this_machine_alone_or_whoever_has_the_token() {
    let f = started().await;
    let (open_server, _) = open(&f, Access::default()).await;
    let port = open_server.addr.port();
    let status = |answer: String| answer.split(' ').nth(1).unwrap_or("").to_string();
    let get = |headers: &str| format!("GET /api/health HTTP/1.1\r\n{headers}Connection: close\r\n\r\n").into_bytes();
    assert_eq!(status(raw(&open_server, &get(&format!("Host: 127.0.0.1:{port}\r\n"))).await), "200");
    assert_eq!(status(raw(&open_server, &get(&format!("Host: localhost:{port}\r\nOrigin: http://localhost:{port}\r\n"))).await), "200");
    // Another site's page in this machine's browser, and a foreign name resolving to this machine.
    let foreign = raw(&open_server, &get(&format!("Host: 127.0.0.1:{port}\r\nOrigin: https://evil.example\r\n"))).await;
    assert!(status(foreign.clone()) == "403" && foreign.ends_with("{\"error\":\"Forbidden origin\"}"), "{foreign}");
    assert_eq!(status(raw(&open_server, &get(&format!("Host: rebind.example:{port}\r\n"))).await), "403");
    let posted = format!(
        "POST /api/session/reset HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://attacker.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    assert_eq!(status(raw(&open_server, posted.as_bytes()).await), "403");
    open_server.shutdown().await;

    // With a token, every call carries it; the server says that it wants one, and nothing else.
    let token = "0123456789abcdef-token";
    let (server, api) = open(&f, Access { token: Some(token.into()), web_dir: None }).await;
    assert_eq!(api.get("/api/health").await.0, 200);
    assert_eq!(api.get("/api/messages").await.0, 200);
    let anonymous = Api { base: api.base.clone(), token: None };
    let (status_code, hint) = anonymous.get("/api/health").await;
    assert_eq!((status_code, hint["authRequired"].as_bool(), hint.get("components")), (401, Some(true), None));
    assert_eq!(anonymous.get("/api/messages").await, (401, json!({"error": "A valid access token is required"})));
    assert_eq!(anonymous.call("POST", "/api/chat", Some(json!({"text": "x"}))).await.0, 401);
    let wrong = Api { base: api.base.clone(), token: Some("0123456789abcdef-tokex".into()) };
    assert_eq!(wrong.get("/api/workers").await.0, 401);
    assert!(f.chat().is_empty());
    server.shutdown().await;

    // An API without a token is not offered beyond this machine, nor with a token that is too short.
    assert_eq!(
        serve(f.app.clone(), "0.0.0.0", 0, Access::default()).await.err().unwrap(),
        "Listening on 0.0.0.0 needs an access token: set one, or listen on 127.0.0.1"
    );
    assert_eq!(
        serve(f.app.clone(), "127.0.0.1", 0, Access { token: Some("short".into()), web_dir: None }).await.err().unwrap(),
        "The access token must have at least 16 characters"
    );
    let wide = serve(f.app.clone(), "0.0.0.0", 0, Access { token: Some(token.into()), web_dir: None }).await.expect("a token lets it listen widely");
    wide.shutdown().await;
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_the_web_build_beside_the_api() {
    let f = started().await;
    let web = f.dir.join("web");
    std::fs::create_dir_all(web.join("assets/fonts")).unwrap();
    std::fs::write(web.join("index.html"), "<!doctype html><title>Neo Agent</title>").unwrap();
    std::fs::write(web.join("main.dart.js"), "console.log('app')").unwrap();
    std::fs::write(web.join("assets/fonts/a.otf"), [0u8, 1, 2]).unwrap();
    std::fs::write(f.dir.join("secret.txt"), "outside the web build").unwrap();
    let (server, api) = open(&f, Access { token: Some("0123456789abcdef-token".into()), web_dir: Some(web.clone()) }).await;
    let fetch = |path: &str| {
        let url = format!("{}{path}", api.base);
        async move {
            send(Request {
                method: "GET",
                url,
                timeout: Duration::from_secs(5),
                want: vec!["content-type", "content-security-policy", "cache-control"],
                ..Request::default()
            })
            .await
            .unwrap()
        }
    };
    // The page and its files need no token: the page is where the token is entered.
    let page = fetch("/").await;
    assert_eq!(
        (page.status, String::from_utf8_lossy(&page.body).as_ref(), page.headers[0].as_str(), page.headers[2].as_str()),
        (200, "<!doctype html><title>Neo Agent</title>", "text/html; charset=utf-8", "no-cache")
    );
    assert!(page.headers[1].contains("default-src 'self'") && page.headers[1].contains("frame-ancestors 'none'"));
    let script = fetch("/main.dart.js").await;
    assert_eq!((script.status, script.headers[0].as_str(), script.body.as_slice()), (200, "text/javascript; charset=utf-8", &b"console.log('app')"[..]));
    let font = fetch("/assets/fonts/a.otf").await;
    assert_eq!((font.status, font.headers[0].as_str(), font.body.as_slice()), (200, "font/otf", &[0u8, 1, 2][..]));
    // A path that names no file is a page of the app; a missing file is missing.
    assert_eq!(String::from_utf8_lossy(&fetch("/settings/models").await.body), "<!doctype html><title>Neo Agent</title>");
    assert_eq!(fetch("/missing.js").await.status, 404);
    // Nothing outside the folder is reachable.
    for path in ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "/..%5csecret.txt"] {
        let answer = fetch(path).await;
        assert!(answer.status == 404 && !String::from_utf8_lossy(&answer.body).contains("outside"), "{path}");
    }
    // Only reads, and the API beside it still wants its token.
    assert_eq!(
        send(Request { method: "POST", url: format!("{}/", api.base), timeout: Duration::from_secs(5), ..Request::default() }).await.unwrap().status,
        404
    );
    assert_eq!(Api { base: api.base.clone(), token: None }.get("/api/messages").await.0, 401);
    assert_eq!(api.get("/api/messages").await.0, 200);
    // A HEAD names the length and sends no body.
    let head = raw(&server, b"HEAD / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await;
    assert!(head.starts_with("HTTP/1.1 200 OK\r\n") && head.contains("content-length: 39\r\n") && head.ends_with("\r\n\r\n"), "{head}");
    server.shutdown().await;
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_connections_open_and_refuses_what_it_cannot_serve() {
    let f = started().await;
    let (server, _) = open(&f, Access::default()).await;
    let host = format!("Host: 127.0.0.1:{}\r\n", server.addr.port());
    // Two requests on one connection, the second closing it; a body split across writes.
    let mut stream = tokio::net::TcpStream::connect(server.addr).await.unwrap();
    stream.write_all(format!("GET /api/messages HTTP/1.1\r\n{host}\r\n").as_bytes()).await.unwrap();
    let mut first = vec![0u8; 4096];
    let read = stream.read(&mut first).await.unwrap();
    let first = String::from_utf8_lossy(&first[..read]).to_string();
    assert!(first.starts_with("HTTP/1.1 200 OK\r\n") && first.contains("connection: keep-alive\r\n") && first.ends_with("{\"messages\":[]}"), "{first}");
    let body = "{\"code\":\"1\"}";
    stream
        .write_all(
            format!(
                "POST /api/wechat/verify HTTP/1.1\r\n{host}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                &body[..4]
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    stream.write_all(&body.as_bytes()[4..]).await.unwrap();
    let mut second = Vec::new();
    stream.read_to_end(&mut second).await.unwrap();
    let second = String::from_utf8_lossy(&second).to_string();
    assert!(
        second.starts_with("HTTP/1.1 400 Bad Request\r\n") && second.contains("connection: close\r\n") && second.contains("当前不需要微信验证码"),
        "{second}"
    );

    let status = |answer: String| answer.lines().next().unwrap_or("").to_string();
    assert_eq!(
        status(
            raw(&server, format!("POST /api/chat HTTP/1.1\r\n{host}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n", 25 * 1024 * 1024).as_bytes())
                .await
        ),
        "HTTP/1.1 413 Payload Too Large"
    );
    assert_eq!(
        status(raw(&server, format!("POST /api/chat HTTP/1.1\r\n{host}Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n").as_bytes()).await),
        "HTTP/1.1 411 Length Required"
    );
    assert_eq!(status(raw(&server, b"NONSENSE\r\n\r\n").await), "HTTP/1.1 400 Bad Request");
    assert_eq!(status(raw(&server, format!("GET /api/health HTTP/1.1\r\n{host}Content-Length: many\r\n\r\n").as_bytes()).await), "HTTP/1.1 400 Bad Request");
    assert_eq!(status(raw(&server, format!("GET /{} HTTP/1.1\r\n\r\n", "a".repeat(70_000)).as_bytes()).await), "HTTP/1.1 431 Request Header Fields Too Large");
    // A body announced with Expect is asked for before it is read.
    let mut stream = tokio::net::TcpStream::connect(server.addr).await.unwrap();
    stream.write_all(format!("POST /api/wechat/verify HTTP/1.1\r\n{host}Content-Type: application/json\r\nExpect: 100-continue\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
    let mut go = vec![0u8; 64];
    let read = stream.read(&mut go).await.unwrap();
    assert_eq!(&go[..read], b"HTTP/1.1 100 Continue\r\n\r\n");
    stream.write_all(body.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.unwrap();
    assert!(String::from_utf8_lossy(&answer).starts_with("HTTP/1.1 400 Bad Request"));

    // Stopping closes idle connections and frees the port.
    let mut idle = tokio::net::TcpStream::connect(server.addr).await.unwrap();
    let addr = server.addr;
    server.shutdown().await;
    let mut rest = Vec::new();
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), idle.read_to_end(&mut rest)).await.expect("the idle connection is closed").unwrap_or(0), 0);
    assert!(tokio::net::TcpStream::connect(addr).await.is_err());
    f.app.stop().await;
}
