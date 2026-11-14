//! The Claude Code kernel against the real `claude` program and a local fake Anthropic endpoint: no network, no
//! account. These start real runtime processes and take minutes, so they run only with `NEO_REAL_KERNELS=1` (the
//! `claude` on `PATH`) or `NEO_CLAUDE_BIN=<program>`; otherwise each test notes that it was skipped.

use neo_kernel::claude::{Claude, ClaudeDriver, ClaudeOptions};
use neo_kernel::journal::{Entry, Journal};
use neo_kernel::session::{Mode, Presentation, Session};
use neo_kernel::types::{Block, BoxFut, Guard, KernelEvent, Role, ToolHost, ToolSpec};
use neo_testkit::models::{anthropic, conversation, tool_names, tool_results, Reply};
use neo_testkit::TempDir;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

fn program() -> Option<PathBuf> {
    let enabled = std::env::var("NEO_REAL_KERNELS").is_ok_and(|value| value == "1");
    std::env::var_os("NEO_CLAUDE_BIN").map(PathBuf::from).or_else(|| enabled.then(|| neo_testkit::find_program("claude")).flatten())
}

#[derive(Default)]
struct Host {
    calls: Mutex<Vec<(String, Value)>>,
    guarded: Mutex<Vec<String>>,
}

impl ToolHost for Host {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "orchestrator_report".into(),
            description: "Report the ticket's state.".into(),
            schema: json!({"type": "object", "properties": {"state": {"type": "string"}, "summary": {"type": "string"}}, "required": ["state", "summary"]}),
        }]
    }
    fn call<'a>(&'a self, name: &'a str, arguments: Value) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push((name.to_string(), arguments.clone()));
            if arguments["state"] == "bogus" {
                return Err("Unknown state bogus".into());
            }
            Ok(json!({"reported": true}))
        })
    }
    fn guard<'a>(&'a self, tool: &'a str, input: &'a Value) -> BoxFut<'a, Guard> {
        Box::pin(async move {
            self.guarded.lock().unwrap().push(tool.to_string());
            if tool == "Bash" && input["command"].as_str().is_some_and(|command| command.contains("forbidden")) {
                Guard::Block("Ticket ended; new work needs a new authorized ticket".into())
            } else {
                Guard::Allow
            }
        })
    }
}

struct Fixture {
    dir: TempDir,
    host: Arc<Host>,
    session: Arc<Session>,
    events: broadcast::Receiver<KernelEvent>,
}

fn open(dir: TempDir, journal: Journal, model_url: &str) -> Fixture {
    let host = Arc::new(Host::default());
    let options = ClaudeOptions {
        program: program().expect("checked by the test"),
        cwd: dir.join("work"),
        system_prompt: "You are a fixture worker.".into(),
        builtin_tools: vec!["Read".into(), "Bash".into()],
        model: Some("fixture".into()),
        persist: true,
        env: [
            ("ANTHROPIC_BASE_URL", model_url),
            ("ANTHROPIC_API_KEY", "fixture-key"),
            ("CLAUDE_CONFIG_DIR", dir.join("config").to_str().unwrap()),
            ("DISABLE_TELEMETRY", "1"),
            ("DISABLE_AUTOUPDATER", "1"),
            ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect(),
        ..Default::default()
    };
    let (reports, runtime) = mpsc::unbounded_channel();
    let driver = ClaudeDriver::new(options, host.clone(), reports);
    let session = Session::new(Arc::new(journal), Arc::new(Claude(driver)), runtime);
    let events = session.subscribe();
    Fixture { dir, host, session, events }
}

fn fixture(model_url: &str) -> Fixture {
    let dir = TempDir::new("claude-real");
    for sub in ["work", "config", "sessions"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    let journal = Journal::create(&dir.join("sessions"), &dir.join("work")).unwrap();
    open(dir, journal, model_url)
}

impl Fixture {
    /// The events up to the end of the turn.
    async fn turn(&mut self) -> Vec<KernelEvent> {
        let mut seen = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(90), self.events.recv()).await.expect("the turn ends in time").unwrap();
            let ended = matches!(event, KernelEvent::AgentEnd { .. });
            seen.push(event);
            if ended {
                return seen;
            }
        }
    }
    async fn send(&self, request_id: &str, text: &str) {
        self.session.send(request_id, vec![Block::text(text)], Mode::Queue, &Presentation::default(), &[]).await.unwrap();
    }
    fn said(&self) -> Vec<String> {
        self.session
            .journal()
            .entries()
            .into_iter()
            .filter_map(|entry| match entry {
                Entry::Message { message, .. } if message.role == Role::Assistant => Some(neo_kernel::types::text_of(&message.content)),
                _ => None,
            })
            .filter(|text| !text.is_empty())
            .collect()
    }
}

macro_rules! require_claude {
    () => {
        if program().is_none() {
            eprintln!("skipped: set NEO_REAL_KERNELS=1 or NEO_CLAUDE_BIN=<program> to run against the real claude program");
            return;
        }
    };
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_a_turn_with_a_host_tool_a_blocked_built_in_tool_and_a_tool_error() {
    require_claude!();
    let model = anthropic(|request, _| match tool_results(request) {
        0 => Reply::call("mcp__neo__orchestrator_report", json!({"state": "progress", "summary": "Looking"})),
        1 => Reply::call("Bash", json!({"command": "echo forbidden"})),
        2 => Reply::call("mcp__neo__orchestrator_report", json!({"state": "bogus", "summary": "x"})),
        _ => Reply::text("All done."),
    })
    .await;
    let mut f = fixture(&model.url());
    f.send("assignment:1", "Fix the typo in README.").await;
    let events = f.turn().await;
    assert_eq!(events.first(), Some(&KernelEvent::AgentStart));
    assert!(events.contains(&KernelEvent::Taken { request_ids: vec!["assignment:1".into()] }), "{events:?}");
    assert_eq!(events.last(), Some(&KernelEvent::AgentEnd { terminal: true, awaiting_async: false }));
    assert!(!f.session.is_streaming() && f.session.journal().pending().is_empty());
    // The host served its tool twice and judged every call, its own under their bare names.
    assert_eq!(
        *f.host.calls.lock().unwrap(),
        vec![
            ("orchestrator_report".to_string(), json!({"state": "progress", "summary": "Looking"})),
            ("orchestrator_report".to_string(), json!({"state": "bogus", "summary": "x"})),
        ]
    );
    assert_eq!(*f.host.guarded.lock().unwrap(), vec!["orchestrator_report", "Bash", "orchestrator_report"]);
    // What the model was given: the system prompt, only the allowed tools, and each tool's outcome.
    let requests = model.requests();
    assert_eq!(requests.len(), 4);
    assert!(conversation(&requests[0]).contains("You are a fixture worker.") && conversation(&requests[0]).contains("Fix the typo in README."));
    let offered = tool_names(&requests[0]);
    assert!(
        offered.contains(&"mcp__neo__orchestrator_report".to_string()) && offered.contains(&"Bash".to_string()) && offered.contains(&"Read".to_string()),
        "{offered:?}"
    );
    assert!(!offered.contains(&"Write".to_string()) && !offered.contains(&"Edit".to_string()), "{offered:?}");
    assert!(conversation(&requests[1]).contains("reported"));
    assert!(conversation(&requests[2]).contains("Ticket ended; new work needs a new authorized ticket"));
    assert!(conversation(&requests[3]).contains("Unknown state bogus"));
    assert_eq!(f.said().last().map(String::as_str), Some("All done."));
    assert_eq!(f.session.journal().last_stop_reason().as_deref(), Some("stop"));
    assert!(f.session.journal().kernel_session("claude").is_some());
    f.session.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_its_context_across_turns_and_resumes_it_in_a_new_process_after_a_restart() {
    require_claude!();
    let model =
        anthropic(|request, number| Reply::text(&format!("answer {number} to {} messages", request["messages"].as_array().map(Vec::len).unwrap_or(0)))).await;
    let mut f = fixture(&model.url());
    f.send("r1", "first question").await;
    f.turn().await;
    // A notice waits for the next turn, and reaches the model with the message that starts it.
    f.session.send("n1", vec![Block::text("notice: the settings changed")], Mode::Inject, &Presentation::default(), &[]).await.unwrap();
    assert_eq!(model.requests().len(), 1);
    f.send("r2", "second question").await;
    let events = f.turn().await;
    assert!(events.contains(&KernelEvent::Taken { request_ids: vec!["n1".into(), "r2".into()] }), "{events:?}");
    let second = conversation(&model.requests()[1]);
    assert!(second.contains("first question") && second.contains("notice: the settings changed") && second.contains("second question"));
    let runtime_session = f.session.journal().kernel_session("claude").unwrap();
    // The host restarts: a new process resumes the runtime's own session, so the model still has the earlier turns.
    f.session.dispose().await;
    let path = f.session.journal().path().to_path_buf();
    let Fixture { dir, .. } = f;
    let mut restarted = open(dir, Journal::open(&path).unwrap(), &model.url());
    restarted.send("r3", "third question").await;
    restarted.turn().await;
    let third = conversation(&model.requests()[2]);
    assert!(third.contains("first question") && third.contains("second question") && third.contains("third question"), "{third}");
    assert_eq!(restarted.session.journal().kernel_session("claude").as_deref(), Some(runtime_session.as_str()));
    assert_eq!(restarted.said().len(), 3);
    restarted.session.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_model_failure_as_an_error_turn() {
    require_claude!();
    // Nothing listens here, so every model request fails.
    let mut f = fixture("http://127.0.0.1:9");
    f.send("r1", "hello").await;
    let events = f.turn().await;
    assert_eq!(events.last(), Some(&KernelEvent::AgentEnd { terminal: true, awaiting_async: false }));
    assert_eq!(f.session.journal().last_stop_reason().as_deref(), Some("error"));
    f.session.dispose().await;
    drop(f.dir);
}
