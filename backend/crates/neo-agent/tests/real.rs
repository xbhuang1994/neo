//! The whole product on the Antigravity CLI and its real models, with this program relaying the runtime's hooks. It
//! needs a signed-in `agy` and the network, so it runs only with `NEO_REAL_ANTIGRAVITY=1` or `NEO_AGY_BIN`; the model
//! is `NEO_AGY_MODEL`, by default `gemini-3.8-flash-low`. A real model words its replies itself, so this checks what
//! the product did rather than what was said.

use neo_app::http::{send, Request};
use neo_testkit::TempDir;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Product {
    child: Child,
    port: u16,
    dir: TempDir,
}

impl Drop for Product {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Product {
    /// End the program as a service manager would, waiting for it to leave.
    fn stop(&mut self) {
        if self.child.try_wait().ok().flatten().is_some() {
            return;
        }
        let _ = Command::new("kill").args(["-TERM", &self.child.id().to_string()]).status();
        let began = Instant::now();
        while began.elapsed() < Duration::from_secs(15) && self.child.try_wait().ok().flatten().is_none() {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn start(dir: TempDir, settings: Value, env: &[(&str, String)]) -> Product {
        std::fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_neo-agent"));
        command.args(["serve", "--port", "0", "--data-dir"]).arg(dir.join("data")).arg("--init-settings").arg(dir.join("settings.json"));
        command
            .env("NEO_RUNTIME_DIR", dir.join("run"))
            .env("HOME", dir.join("home"))
            .env("NEO_AGY_BIN", dir.join("none"))
            .env_remove("NEO_TOKEN")
            .env_remove("NEO_DATA_DIR")
            .env_remove("NEO_ALLOW_MULTIPLE");
        for (name, value) in env {
            command.env(name, value);
        }
        let log = std::fs::File::create(dir.join("log.txt")).unwrap();
        let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(log).spawn().expect("the program starts");
        let mut line = String::new();
        BufReader::new(child.stdout.as_mut().unwrap()).read_line(&mut line).unwrap();
        let said: Value = serde_json::from_str(&line)
            .unwrap_or_else(|_| panic!("no listening line: {line:?}; {}", std::fs::read_to_string(dir.join("log.txt")).unwrap_or_default()));
        Product { port: said["port"].as_u64().unwrap() as u16, child, dir }
    }

    async fn call(&self, method: &'static str, path: &str, body: Option<Value>) -> (u16, Value) {
        let headers = if body.is_some() { vec![("content-type".to_string(), "application/json".to_string())] } else { Vec::new() };
        let request = Request {
            method,
            url: format!("http://127.0.0.1:{}{path}", self.port),
            headers,
            body: body.map(|body| body.to_string().into_bytes()),
            timeout: Duration::from_secs(30),
            want: Vec::new(),
        };
        let response = send(request).await.expect("the server answers");
        (response.status, serde_json::from_slice(&response.body).unwrap_or(Value::Null))
    }

    async fn messages(&self) -> Vec<(String, String)> {
        let (_, body) = self.call("GET", "/api/messages", None).await;
        body["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|message| (message["role"].as_str().unwrap_or("").to_string(), message["text"].as_str().unwrap_or("").to_string()))
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn does_a_request_end_to_end_on_antigravity() {
    let enabled = std::env::var("NEO_REAL_ANTIGRAVITY").is_ok_and(|value| value == "1");
    let Some(agy) = std::env::var_os("NEO_AGY_BIN").map(PathBuf::from).or_else(|| enabled.then(|| neo_testkit::find_program("agy")).flatten()) else {
        eprintln!("skipped: set NEO_REAL_ANTIGRAVITY=1 or NEO_AGY_BIN=<program> to run against the real Antigravity CLI");
        return;
    };
    let model = std::env::var("NEO_AGY_MODEL").unwrap_or_else(|_| "gemini-3.8-flash-low".into());
    let dir = TempDir::new("real-agy");
    // Antigravity keeps its sign-in in the person's home.
    let home = std::env::var("HOME").unwrap_or_default();
    let settings = json!({"kernel": "antigravity", "models": {"antigravity": {"eval": {"provider": "antigravity", "model": model}, "executor": {"provider": "antigravity", "model": model}}}});
    let mut product = Product::start(dir, settings, &[("NEO_AGY_BIN", agy.display().to_string()), ("HOME", home)]);
    let (status, health) = product.call("GET", "/api/health", None).await;
    assert_eq!((status, health["kernel"].as_str(), health["components"]["kernel"]["state"].as_str()), (200, Some("antigravity"), Some("ready")), "{health}");
    let request = "Please do this as a task: create a file named result.txt in the task's directory whose whole content is the line `done by the worker`, using the shell, then report the task done.";
    let (status, receipt) = product.call("POST", "/api/chat", Some(json!({"text": request, "messageId": "web:real-agy-1"}))).await;
    assert_eq!((status, receipt["result"].as_str()), (202, Some("stored")));
    let began = Instant::now();
    let worker = loop {
        let (_, workers) = product.call("GET", "/api/workers", None).await;
        let done = workers["workers"].as_array().and_then(|workers| workers.iter().find(|worker| worker["outcome"] == "completed").cloned());
        if let Some(worker) = done {
            break worker;
        }
        assert!(
            began.elapsed() < Duration::from_secs(600),
            "no completed ticket in time; workers: {workers}; messages: {:?}; log: {}",
            product.messages().await,
            std::fs::read_to_string(product.dir.join("log.txt")).unwrap_or_default()
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    };
    // The worker ran its shell in the ticket's own directory, and the bridge beside it is not left in it.
    let directory = PathBuf::from(worker["directory"].as_str().unwrap());
    assert!(directory.starts_with(product.dir.join("data").join("work")), "{worker}");
    assert_eq!(std::fs::read_to_string(directory.join("result.txt")).unwrap().trim(), "done by the worker");
    assert!(!directory.join(".agents").exists());
    // The person hears back: their message, an acknowledgement or the result, all from the main Session.
    let began = Instant::now();
    loop {
        let messages = product.messages().await;
        if messages.iter().filter(|(role, _)| role == "assistant").count() >= 1
            && messages.first().is_some_and(|(role, text)| role == "user" && text == request)
        {
            break;
        }
        assert!(began.elapsed() < Duration::from_secs(120), "no reply: {messages:?}");
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let work = product.dir.join("data").join("work");
    product.stop();
    let left: Vec<_> =
        std::fs::read_dir(&work).unwrap().flatten().map(|entry| entry.file_name()).filter(|name| name.to_string_lossy().contains(".neo-")).collect();
    assert!(left.is_empty(), "bridges left after shutdown: {left:?}");
}
