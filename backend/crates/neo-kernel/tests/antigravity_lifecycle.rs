//! Pure-Rust lifecycle tests for `AntigravityDriver`: this test binary serves as both the test runner and the
//! stand-in `agy` process + hook relay so no external scripting runtime is needed.

use neo_kernel::antigravity::{Antigravity, AntigravityDriver, AntigravityOptions};
use neo_kernel::journal::Journal;
use neo_kernel::session::{Mode, Presentation, Session};
use neo_kernel::types::{Block, BoxFut, Guard, JobKind, KernelEvent, ToolHost, ToolSpec};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

fn http_post(url: &str, auth: Option<&str>, body: &[u8]) -> Result<String, String> {
    let rest = url.strip_prefix("http://").ok_or("URL is not http")?;
    let (addr, path) = rest.split_once('/').map(|(a, p)| (a, format!("/{p}"))).unwrap_or((rest, "/".into()));
    let mut stream = TcpStream::connect(addr).map_err(|error| error.to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let auth_line = auth.map(|value| format!("Authorization: {value}\r\n")).unwrap_or_default();
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\n{auth_line}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(body)).map_err(|error| error.to_string())?;
    let mut reply = Vec::new();
    stream.read_to_end(&mut reply).map_err(|error| error.to_string())?;
    let split = reply.windows(4).position(|window| window == b"\r\n\r\n").ok_or("malformed HTTP response")?;
    String::from_utf8(reply[split + 4..].to_vec()).map_err(|error| error.to_string())
}

fn run_hook_relay(url: &str) {
    let mut body = Vec::new();
    std::io::stdin().read_to_end(&mut body).unwrap();
    let response = http_post(url, None, &body).unwrap();
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(response.as_bytes()).unwrap();
    stdout.flush().unwrap();
}

fn run_fake_agy(args: &[String]) {
    let mut bridge = PathBuf::new();
    let mut conv = "conv-1".to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--add-dir" if i + 1 < args.len() => {
                bridge = PathBuf::from(&args[i + 1]);
                i += 2;
            }
            "--conversation" if i + 1 < args.len() => {
                conv = args[i + 1].clone();
                i += 2;
            }
            _ => i += 1,
        }
    }
    let plugin = bridge.join(".agents").join("plugins").join("neo");
    let hooks: Value = serde_json::from_str::<Value>(&std::fs::read_to_string(plugin.join("hooks.json")).unwrap()).unwrap()["neo"].clone();
    let mcp = serde_json::from_str::<Value>(&std::fs::read_to_string(plugin.join("mcp_config.json")).unwrap()).unwrap()["mcpServers"]["neo"].clone();
    let agent = std::fs::read_to_string(bridge.join(".agents").join("agents").join("neo-session.md")).unwrap();

    let emit_raw = |value: &Value| {
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{value}");
        let _ = stdout.flush();
    };
    let out = |event: &str, mut body: Value| {
        body["conversation_id"] = json!(conv);
        emit_raw(&json!({"event": event, event: body}));
    };
    let call_hook = |name: &str, mut payload: Value| -> Value {
        let command = if matches!(name, "PreToolUse" | "PostToolUse") {
            hooks[name][0]["hooks"][0]["command"].as_str().unwrap()
        } else {
            hooks[name][0]["command"].as_str().unwrap()
        };
        payload["hookEventName"] = json!(name);
        if payload.get("conversationId").is_none() {
            payload["conversationId"] = json!(conv);
        }
        let mut child = if cfg!(windows) {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", command]);
            cmd
        } else {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", command]);
            cmd
        };
        let mut spawned = child.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        spawned.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let output = spawned.wait_with_output().unwrap();
        if !output.status.success() {
            return json!({"decision": "deny", "reason": "hook failed"});
        }
        if output.stdout.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&output.stdout).unwrap_or_else(|_| json!({}))
        }
    };
    let mcp_call = |name: &str, arguments: Value| -> String {
        let url = mcp["url"].as_str().unwrap();
        let auth = mcp["headers"]["Authorization"].as_str();
        let body = serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": name, "arguments": arguments}})).unwrap();
        let reply: Value = serde_json::from_str(&http_post(url, auth, &body).unwrap()).unwrap();
        reply["result"]["content"][0]["text"].as_str().unwrap_or("").to_string()
    };

    emit_raw(&json!({"event": "init", "conversation_id": conv, "init": {"agent": "neo-session"}}));
    let mut step = 0i64;
    let mut next_step = || {
        step += 1;
        step
    };

    let stdin = std::io::stdin();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(raw) = serde_json::from_str::<Value>(&line) else { continue };
        let text = raw["message"]["content"].as_str().unwrap_or("");
        if text.contains("refuse") {
            out("result", json!({"status": "ERROR", "error": "agent refused to start", "num_turns": 0}));
            continue;
        }
        out("step_update", json!({"step_index": next_step(), "state": "DONE", "step_type": "user_input"}));
        if text.contains("prompt?") {
            let body = agent.rsplit("---\n").next().unwrap_or("").trim();
            out(
                "step_update",
                json!({"step_index": next_step(), "state": "DONE", "step_type": "agent_response", "text_delta": format!("prompt says: {body}")}),
            );
        }
        if text.contains("tool") {
            call_hook("SessionStart", json!({}));
            let decision = call_hook(
                "PreToolUse",
                json!({"toolCall": {"id": "c1", "name": "call_mcp_tool", "args": {"ServerName": "neo_neo", "ToolName": "echo", "Arguments": {"text": "ok"}}}}),
            );
            let idx = next_step();
            out(
                "step_update",
                json!({"step_index": idx, "state": "ACTIVE", "step_type": "tool", "tool_name": "call_mcp_tool", "tool_info": {"name": "call_mcp_tool", "parameters": {"ToolName": "echo"}}}),
            );
            let result = if decision["decision"].as_str() == Some("allow") {
                mcp_call("echo", json!({"text": "ok", "toolSummary": "x"}))
            } else {
                decision["reason"].as_str().unwrap_or("").to_string()
            };
            out(
                "step_update",
                json!({"step_index": idx, "state": "DONE", "step_type": "tool", "tool_name": "call_mcp_tool", "tool_info": {"name": "call_mcp_tool", "parameters": {"ToolName": "echo"}, "output": result}}),
            );
            call_hook("PostToolUse", json!({"toolCall": {"id": "c1", "name": "call_mcp_tool"}}));
        }
        if text.contains("forbidden") {
            let decision = call_hook("PreToolUse", json!({"toolCall": {"id": "c2", "name": "run_command", "args": {"CommandLine": "forbidden"}}}));
            let idx = next_step();
            let reason = decision["reason"].as_str().unwrap_or("");
            out(
                "step_update",
                json!({"step_index": idx, "state": "ERROR", "step_type": "tool", "tool_name": "run_command", "tool_info": {"name": "run_command", "parameters": {"CommandLine": "forbidden"}, "error": {"message": format!("denied: {reason}")}}}),
            );
        }
        if text.contains("bridge") {
            let target = bridge.join("x").display().to_string();
            let decision = call_hook("PreToolUse", json!({"toolCall": {"id": "c3", "name": "write_to_file", "args": {"TargetFile": target}}}));
            let reply = format!("{}: {}", decision["decision"].as_str().unwrap_or(""), decision["reason"].as_str().unwrap_or(""));
            out("step_update", json!({"step_index": next_step(), "state": "DONE", "step_type": "agent_response", "text_delta": reply}));
        }
        if text.contains("background") {
            call_hook("PreToolUse", json!({"toolCall": {"id": "bg1", "name": "run_command", "args": {"CommandLine": "sleep 1"}}}));
            call_hook("Stop", json!({"fullyIdle": false}));
            let parent = bridge.parent().unwrap();
            let _ = std::fs::write(parent.join("bg-waiting"), "1");
            while !parent.join("bg-release").exists() {
                std::thread::sleep(Duration::from_millis(50));
            }
            call_hook("PostToolUse", json!({"toolCall": {"id": "bg1", "name": "run_command"}}));
            call_hook("Stop", json!({"fullyIdle": true}));
            out("step_update", json!({"step_index": next_step(), "state": "DONE", "step_type": "agent_response", "text_delta": "background done"}));
        }
        let s = next_step();
        out("step_update", json!({"step_index": s, "state": "ACTIVE", "step_type": "agent_response", "text_delta": "Done "}));
        let prefix: String = text.chars().take(12).collect();
        out("step_update", json!({"step_index": s, "state": "DONE", "step_type": "agent_response", "text_delta": prefix}));
        out("result", json!({"status": "SUCCESS", "response": "", "num_turns": 1}));
    }
}

struct Echo;

impl ToolHost for Echo {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec { name: "echo".into(), description: "Echoes.".into(), schema: json!({"type": "object", "properties": {"text": {"type": "string"}}}) }]
    }
    fn call<'a>(&'a self, _name: &'a str, arguments: Value) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move { Ok(arguments) })
    }
    fn guard<'a>(&'a self, _tool: &'a str, input: &'a Value) -> BoxFut<'a, Guard> {
        Box::pin(async move {
            if input["text"] == "no" || input["command"].as_str().is_some_and(|command| command.contains("forbidden")) {
                Guard::Block("refused".into())
            } else {
                Guard::Allow
            }
        })
    }
}

struct Fixture {
    dir: PathBuf,
    session: Arc<Session>,
    events: tokio::sync::broadcast::Receiver<KernelEvent>,
    driver: Arc<AntigravityDriver>,
}

fn fixture(tag: &str) -> Fixture {
    let dir = std::env::temp_dir().join(format!("neo-agy-lifecycle-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let cwd = dir.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let exe = std::env::current_exe().unwrap();
    let journal = Arc::new(Journal::create(&dir, &cwd).unwrap());
    let mut env = BTreeMap::new();
    env.insert("NEO_TEST_FAKE_AGY".into(), "1".into());
    let options = AntigravityOptions {
        program: exe.clone(),
        cwd,
        system_prompt: "You are the fixture.".into(),
        tools: vec!["read".into(), "bash".into(), "write".into()],
        env,
        hook_relay: vec![exe.display().to_string(), "--neo-test-hook-relay".into()],
        ..Default::default()
    };
    let (reports, runtime) = mpsc::unbounded_channel();
    let driver = AntigravityDriver::new(options, Arc::new(Echo), reports);
    let session = Session::new(journal, Arc::new(Antigravity(driver.clone())), runtime);
    let events = session.subscribe();
    Fixture { dir, session, events, driver }
}

impl Fixture {
    async fn turn(&mut self) -> Vec<KernelEvent> {
        let mut seen = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(20), self.events.recv()).await.expect("the turn ends").unwrap();
            let done = matches!(event, KernelEvent::AgentEnd { .. });
            seen.push(event);
            if done {
                return seen;
            }
        }
    }
    async fn send(&self, id: &str, text: &str) {
        self.session.send(id, vec![Block::text(text)], Mode::Queue, &Presentation::default(), &[]).await.unwrap();
    }
    fn said(&self) -> Vec<String> {
        self.session
            .journal()
            .entries()
            .iter()
            .filter_map(|entry| match entry {
                neo_kernel::journal::Entry::Message { message, .. } => Some(neo_kernel::types::text_of(&message.content)),
                _ => None,
            })
            .collect()
    }
    fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn runs_turns_with_host_tools_hooks_and_the_agent_prompt() {
    let mut f = fixture("turns");
    f.send("r1", "prompt? and tool").await;
    let seen = f.turn().await;
    assert!(seen.contains(&KernelEvent::Taken { request_ids: vec!["r1".into()] }), "{seen:?}");
    assert_eq!(seen.last(), Some(&KernelEvent::AgentEnd { terminal: true, awaiting_async: false }));
    assert!(f.session.journal().pending().is_empty());
    assert_eq!(f.session.journal().kernel_session("antigravity").as_deref(), Some("conv-1"));
    let said = f.said();
    assert!(said.iter().any(|text| text == "prompt says: You are the fixture."), "{said:?}");
    assert!(said.iter().any(|text| text == r#"{"text":"ok"}"#), "the host tool ran without display arguments: {said:?}");
    assert!(said.iter().any(|text| text == "Done prompt? and"), "{said:?}");

    // A refused command reaches the model with the guard's reason, and the turn goes on.
    f.send("r2", "forbidden").await;
    f.turn().await;
    assert!(f.said().iter().any(|text| text == "denied: refused"), "{:?}", f.said());

    // Neo's bridge is not the model's to change.
    f.send("r3", "bridge").await;
    f.turn().await;
    assert!(f.said().iter().any(|text| text.starts_with("deny: That folder is Neo's link")), "{:?}", f.said());

    // Two messages sent together run as two turns, in order.
    f.send("r4", "first").await;
    f.send("r5", "second").await;
    let mut seen = f.turn().await;
    if !seen.iter().any(|event| matches!(event, KernelEvent::Taken { request_ids } if request_ids == &["r5".to_string()])) {
        seen.extend(f.turn().await);
    }
    assert!(seen.iter().any(|event| matches!(event, KernelEvent::Taken { request_ids } if request_ids == &["r5".to_string()])), "{seen:?}");
    assert!(f.said().iter().any(|text| text == "Done second"), "{:?}", f.said());
    assert!(f.session.journal().pending().is_empty());

    let bridge = f.driver.bridge_dir().unwrap();
    assert!(Path::new(&bridge).join(".agents/plugins/neo/hooks.json").is_file());
    f.session.dispose().await;
    assert!(!bridge.exists(), "the bridge goes with the process");
    f.cleanup();
}

async fn ends_the_turn_while_background_work_runs_and_lists_it() {
    let mut f = fixture("background");
    f.send("r1", "background").await;
    let seen = f.turn().await;
    assert_eq!(seen.last(), Some(&KernelEvent::AgentEnd { terminal: false, awaiting_async: true }), "{seen:?}");
    let jobs = f.session.driver().jobs().await;
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_eq!((jobs[0].kind, jobs[0].command.as_deref(), jobs[0].own), (JobKind::Bash, Some("sleep 1"), true));
    std::fs::write(f.dir.join("bg-release"), "1").unwrap();
    let seen = f.turn().await;
    assert_eq!(seen.last(), Some(&KernelEvent::AgentEnd { terminal: true, awaiting_async: false }), "{seen:?}");
    assert!(f.session.driver().jobs().await.is_empty());
    assert!(f.said().iter().any(|text| text == "background done"), "{:?}", f.said());
    f.session.dispose().await;
    f.cleanup();
}

async fn keeps_a_message_the_runtime_refused_pending() {
    let mut f = fixture("refuse");
    f.send("r1", "refuse").await;
    let seen = f.turn().await;
    assert!(!seen.iter().any(|event| matches!(event, KernelEvent::Taken { .. })), "{seen:?}");
    assert_eq!(f.session.journal().pending().len(), 1);
    assert!(f.said().iter().any(|text| text.contains("agent refused to start")), "{:?}", f.said());
    f.session.dispose().await;
    f.cleanup();
}

async fn warms_without_starting_a_turn_and_cleans_up_on_close() {
    let mut f = fixture("warm");
    f.session.warm().await.unwrap();
    assert!(matches!(f.events.try_recv(), Err(tokio::sync::broadcast::error::TryRecvError::Empty)));
    assert!(f.session.driver().pid().is_some());
    assert!(!f.driver.has_active_turns());
    let bridge = f.driver.bridge_dir().unwrap();
    assert!(bridge.is_dir());

    f.session.dispose().await;
    assert!(!bridge.exists());
    assert!(f.session.warm().await.is_ok());
    assert!(f.session.driver().warm(None).await.is_err());
    assert!(!bridge.exists());
    f.cleanup();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--neo-test-hook-relay") {
        let url = args.get(1).expect("hook relay URL");
        run_hook_relay(url);
        return;
    }
    if std::env::var_os("NEO_TEST_FAKE_AGY").is_some() {
        run_fake_agy(&args);
        return;
    }
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async {
        runs_turns_with_host_tools_hooks_and_the_agent_prompt().await;
        ends_the_turn_while_background_work_runs_and_lists_it().await;
        keeps_a_message_the_runtime_refused_pending().await;
        warms_without_starting_a_turn_and_cleans_up_on_close().await;
    });
}
