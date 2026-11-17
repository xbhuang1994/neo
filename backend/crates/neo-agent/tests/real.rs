//! The whole product with a real kernel: the program as a process, the real `claude` or `omp` runtime under it, and a
//! local fake model endpoint — a chat message over HTTP becomes a ticket, a worker does it, and the result comes back.
//! No network and no account. These start real runtime processes, so they run only with `NEO_REAL_KERNELS=1` (the
//! runtimes on `PATH`) or `NEO_CLAUDE_BIN` / `NEO_OMP_BIN`; otherwise each test notes that it was skipped. The
//! Antigravity test is the exception: its runtime signs in to Google, so it uses real models and is opted into apart.

use neo_app::http::{send, Request};
use neo_testkit::models::{anthropic, conversation, openai, ticket_flow, FakeModel};
use neo_testkit::TempDir;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn runtime(name: &str, variable: &str) -> Option<PathBuf> {
    let enabled = std::env::var("NEO_REAL_KERNELS").is_ok_and(|value| value == "1");
    std::env::var_os(variable).map(PathBuf::from).or_else(|| enabled.then(|| neo_testkit::find_program(name)).flatten())
}

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
}

impl Product {
    fn start(dir: TempDir, settings: Value, env: &[(&str, String)]) -> Product {
        std::fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_neo-agent"));
        command.args(["serve", "--port", "0", "--data-dir"]).arg(dir.join("data")).arg("--init-settings").arg(dir.join("settings.json"));
        command
            .env("NEO_RUNTIME_DIR", dir.join("run"))
            .env("HOME", dir.join("home"))
            .env("NEO_CLAUDE_BIN", dir.join("none"))
            .env("NEO_OMP_BIN", dir.join("none"));
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
    /// The kernel and model settings once the kernels have listed their models, which they do in the background.
    async fn models_ready(&self) -> Value {
        let began = Instant::now();
        loop {
            let (_, models) = self.call("GET", "/api/settings/models", None).await;
            if models["loading"] != true || began.elapsed() > Duration::from_secs(90) {
                return models;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// From a chat message to its result, as the app would see it.
    async fn does_a_request(&self, model: &FakeModel, kernel: &str) {
        let (status, health) = self.call("GET", "/api/health", None).await;
        assert_eq!((status, health["kernel"].as_str(), health["components"]["kernel"]["state"].as_str()), (200, Some(kernel), Some("ready")), "{health}");
        let (status, receipt) = self.call("POST", "/api/chat", Some(json!({"text": "Write the result file.", "messageId": "web:real-1"}))).await;
        assert_eq!((status, receipt["result"].as_str()), (202, Some("stored")));
        let began = Instant::now();
        loop {
            let messages = self.messages().await;
            if messages.len() >= 3 {
                assert_eq!(
                    messages,
                    vec![
                        ("user".into(), "Write the result file.".into()),
                        ("assistant".into(), "On it.".into()),
                        ("assistant".into(), "The file is written.".into())
                    ]
                );
                break;
            }
            assert!(
                began.elapsed() < Duration::from_secs(240),
                "no result in time; messages: {messages:?}; model requests: {}; log: {}",
                model.requests().len(),
                std::fs::read_to_string(self.dir.join("log.txt")).unwrap_or_default()
            );
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let (_, workers) = self.call("GET", "/api/workers", None).await;
        let worker = &workers["workers"][0];
        assert_eq!(
            (worker["title"].as_str(), worker["outcome"].as_str(), worker["progress"]["summary"].as_str()),
            (Some("Write the result file"), Some("completed"), Some("Wrote result.txt.")),
            "{worker}"
        );
        // The worker really ran its shell in the ticket's own directory.
        let directory = PathBuf::from(worker["directory"].as_str().unwrap());
        assert!(directory.starts_with(self.dir.join("data").join("work")) && directory.file_name().unwrap().to_string_lossy().starts_with("write-result-"));
        assert_eq!(std::fs::read_to_string(directory.join("result.txt")).unwrap(), "done by the worker\n");
        let (_, detail) = self.call("GET", &format!("/api/workers/{}", worker["ticketId"].as_str().unwrap()), None).await;
        assert!(detail["recent"].as_array().unwrap().iter().any(|line| line["text"].as_str().is_some_and(|text| text.contains("result.txt"))), "{detail}");
        // Sent again, the same message is the same message.
        let (_, again) = self.call("POST", "/api/chat", Some(json!({"text": "Write the result file.", "messageId": "web:real-1"}))).await;
        assert_eq!(again["result"], "duplicate");
        // Each role had its own prompt.
        let requests = model.requests();
        assert!(
            requests.iter().any(|request| conversation(request).contains("You are the orchestrator"))
                && requests.iter().any(|request| conversation(request).contains("You are a worker."))
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn does_a_request_end_to_end_on_claude_code() {
    let Some(claude) = runtime("claude", "NEO_CLAUDE_BIN") else {
        eprintln!("skipped: set NEO_REAL_KERNELS=1 or NEO_CLAUDE_BIN=<program> to run against the real claude program");
        return;
    };
    let model = anthropic(|request, _| ticket_flow(request, |name| format!("mcp__neo__{name}"), "Bash")).await;
    let dir = TempDir::new("real-claude");
    for sub in ["home", "config"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    let env = [
        ("NEO_CLAUDE_BIN", claude.display().to_string()),
        ("ANTHROPIC_BASE_URL", model.url()),
        ("ANTHROPIC_API_KEY", "fixture-key".to_string()),
        ("CLAUDE_CONFIG_DIR", dir.join("config").display().to_string()),
        ("DISABLE_TELEMETRY", "1".to_string()),
        ("DISABLE_AUTOUPDATER", "1".to_string()),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1".to_string()),
    ];
    let settings = json!({"kernel": "claude", "models": {"claude": {"eval": {"provider": "anthropic", "model": "fixture"}, "executor": {"provider": "anthropic", "model": "fixture"}}}});
    let product = Product::start(dir, settings, &env);
    product.does_a_request(&model, "claude").await;
    let models = product.models_ready().await;
    assert_eq!((models["kernel"].as_str(), models["available"][0]["id"].as_str()), (Some("claude"), Some("fixture")), "{models}");
}

#[tokio::test(flavor = "multi_thread")]
async fn does_a_request_end_to_end_on_oh_my_pi() {
    let Some(omp) = runtime("omp", "NEO_OMP_BIN") else {
        eprintln!("skipped: set NEO_REAL_KERNELS=1 or NEO_OMP_BIN=<program> to run against the real omp program");
        return;
    };
    let model = openai(|request, _| ticket_flow(request, |name| name.to_string(), "bash")).await;
    let dir = TempDir::new("real-omp");
    for sub in ["home", "data/omp"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    std::fs::write(
        dir.join("data/omp/models.yml"),
        format!(
            "providers:\n  fixture:\n    baseUrl: {}/v1\n    api: openai-completions\n    apiKey: fixture-key\n    models:\n      - id: fixture\n        name: fixture\n        api: openai-completions\n        reasoning: false\n        input: [text, image]\n        cost: {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }}\n        contextWindow: 32768\n        maxTokens: 4096\n",
            model.url()
        ),
    )
    .unwrap();
    let settings = json!({"kernel": "omp", "models": {"omp": {"eval": {"provider": "fixture", "model": "fixture"}, "executor": {"provider": "fixture", "model": "fixture"}}}});
    // Oh My Pi reads its models from its agent directory, which the person's environment names.
    let agent_dir = dir.join("data/omp").display().to_string();
    let product = Product::start(dir, settings, &[("NEO_OMP_BIN", omp.display().to_string()), ("PI_CODING_AGENT_DIR", agent_dir)]);
    product.does_a_request(&model, "omp").await;
    let models = product.models_ready().await;
    assert!(models["available"].as_array().unwrap().iter().any(|option| option["provider"] == "fixture" && option["id"] == "fixture"), "{models}");
}

/// The whole product on the Antigravity CLI and its real models, with this program relaying the runtime's hooks. It
/// needs a signed-in `agy` and the network, so it runs only with `NEO_REAL_ANTIGRAVITY=1` or `NEO_AGY_BIN`; the model
/// is `NEO_AGY_MODEL`, by default `gemini-3.8-flash-low`. A real model words its replies itself, so this checks what
/// the product did rather than what was said.
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
