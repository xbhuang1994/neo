//! The Hermes Agent kernel against the real `hermes` runtime, the embedded Python bridge and a local fake OpenAI
//! endpoint: no network, no account. These start real runtime processes, so they run only with `NEO_REAL_KERNELS=1`
//! (the `hermes` on `PATH`) or `NEO_HERMES_BIN=<program>`; otherwise each test notes that it was skipped.

use neo_kernel::hermes::{Hermes, HermesDriver, HermesOptions};
use neo_kernel::journal::{Entry, Journal};
use neo_kernel::session::{Mode, Presentation, Session};
use neo_kernel::types::{text_of, Block, BoxFut, Guard, JobKind, KernelEvent, Role, ToolHost, ToolSpec};
use neo_testkit::models::{conversation, openai, tool_names, tool_results, Reply};
use neo_testkit::TempDir;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

fn program() -> Option<PathBuf> {
    let enabled = std::env::var("NEO_REAL_KERNELS").is_ok_and(|value| value == "1");
    std::env::var_os("NEO_HERMES_BIN").map(PathBuf::from).or_else(|| enabled.then(|| neo_testkit::find_program("hermes")).flatten())
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
            if tool == "bash" && input["command"].as_str().is_some_and(|command| command.contains("forbidden")) {
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
    std::fs::write(
        dir.join("hermes-home/config.yaml"),
        format!("model:\n  provider: custom\n  base_url: {model_url}/v1\n  default: fixture\nagent:\n  api_max_retries: 1\n  auto_recovery_cycles: 0\n"),
    )
    .unwrap();
    let host = Arc::new(Host::default());
    let env: BTreeMap<String, String> =
        [("HERMES_HOME".to_string(), dir.join("hermes-home").display().to_string()), ("OPENAI_API_KEY".to_string(), "fixture-key".to_string())]
            .into_iter()
            .collect();
    let options = HermesOptions {
        program: program().expect("checked by the test"),
        bridge_file: dir.join("bridge/neo-hermes-bridge.py"),
        cwd: dir.join("work"),
        system_prompt: "You are a fixture worker.\nReport with orchestrator_report.\n".into(),
        builtin_tools: vec!["read".into(), "bash".into()],
        model: Some("custom/fixture".into()),
        persist: true,
        env,
        ..Default::default()
    };
    let (reports, runtime) = mpsc::unbounded_channel();
    let driver = HermesDriver::new(options, host.clone(), reports);
    let session = Session::new(Arc::new(journal), Arc::new(Hermes(driver)), runtime);
    let events = session.subscribe();
    Fixture { dir, host, session, events }
}

fn fixture(model_url: &str) -> Fixture {
    let dir = TempDir::new("hermes-real");
    for sub in ["work", "hermes-home", "sessions", "bridge"] {
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
            let event = tokio::time::timeout(Duration::from_secs(120), self.events.recv()).await.expect("the turn ends in time").unwrap();
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
                Entry::Message { message, .. } if message.role == Role::Assistant => Some(text_of(&message.content)),
                _ => None,
            })
            .filter(|text| !text.is_empty())
            .collect()
    }
}

macro_rules! require_hermes {
    () => {
        if program().is_none() {
            eprintln!("skipped: set NEO_REAL_KERNELS=1 or NEO_HERMES_BIN=<program> to run against the real hermes program");
            return;
        }
    };
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_a_turn_with_a_host_tool_a_blocked_built_in_tool_and_a_tool_error() {
    require_hermes!();
    let model = openai(|request, _| match tool_results(request) {
        0 => Reply::call("orchestrator_report", json!({"state": "progress", "summary": "Looking"})),
        1 => Reply::call("terminal", json!({"command": "echo forbidden"})),
        2 => Reply::call("orchestrator_report", json!({"state": "bogus", "summary": "x"})),
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
    assert_eq!(
        *f.host.calls.lock().unwrap(),
        vec![
            ("orchestrator_report".to_string(), json!({"state": "progress", "summary": "Looking"})),
            ("orchestrator_report".to_string(), json!({"state": "bogus", "summary": "x"})),
        ]
    );
    assert_eq!(*f.host.guarded.lock().unwrap(), vec!["orchestrator_report", "bash", "orchestrator_report"]);
    let requests = model.requests();
    assert_eq!(requests.len(), 4);
    assert!(conversation(&requests[0]).contains("You are a fixture worker.") && conversation(&requests[0]).contains("Fix the typo in README."));
    let offered = tool_names(&requests[0]);
    assert!(
        offered.contains(&"orchestrator_report".to_string()) && offered.contains(&"terminal".to_string()) && offered.contains(&"read_file".to_string()),
        "{offered:?}"
    );
    assert!(!offered.contains(&"write_file".to_string()) && !offered.contains(&"patch".to_string()), "{offered:?}");
    assert!(conversation(&requests[1]).contains("reported"));
    assert!(conversation(&requests[2]).contains("Ticket ended; new work needs a new authorized ticket"));
    assert!(conversation(&requests[3]).contains("Unknown state bogus"));
    assert_eq!(f.said().last().map(String::as_str), Some("All done."));
    assert_eq!(f.session.journal().last_stop_reason().as_deref(), Some("stop"));
    assert!(f.session.journal().kernel_session("hermes").is_some_and(|id| !id.is_empty()));
    f.session.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_acknowledges_and_cancels_a_background_job_through_the_bridge() {
    require_hermes!();
    let model = openai(|request, _| match tool_results(request) {
        0 => Reply::call("terminal", json!({"command": "sleep 120", "background": true, "notify": true})),
        _ => Reply::text("The command runs in the background."),
    })
    .await;
    let mut f = fixture(&model.url());
    f.send("r1", "Run the long command.").await;
    let events = f.turn().await;
    assert_eq!(events.last(), Some(&KernelEvent::AgentEnd { terminal: false, awaiting_async: true }));
    let jobs = f.session.driver().jobs().await;
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_eq!((jobs[0].kind, jobs[0].command.as_deref(), jobs[0].own), (JobKind::Bash, Some("sleep 120"), true));
    assert!(jobs[0].start_time > 0);
    f.session.driver().acknowledge(std::slice::from_ref(&jobs[0].id)).await;
    assert!(f.session.driver().cancel(&jobs[0].id).await);
    assert!(!f.session.driver().cancel("no-such-job").await);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(f.session.driver().jobs().await.is_empty());
    assert!(matches!(f.events.try_recv(), Err(broadcast::error::TryRecvError::Empty)), "an acknowledged job wakes nobody");
    assert_eq!(model.requests().len(), 2);
    f.session.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_its_context_across_turns_and_resumes_it_in_a_new_process_after_a_restart() {
    require_hermes!();
    let model = openai(|_, number| Reply::text(&format!("answer {number}"))).await;
    let mut f = fixture(&model.url());
    f.send("r1", "first question").await;
    f.turn().await;
    f.session.send("n1", vec![Block::text("notice: the settings changed")], Mode::Inject, &Presentation::default(), &[]).await.unwrap();
    assert_eq!(model.requests().len(), 1);
    f.send("r2", "second question").await;
    let events = f.turn().await;
    assert!(events.contains(&KernelEvent::Taken { request_ids: vec!["n1".into(), "r2".into()] }), "{events:?}");
    let second = conversation(&model.requests()[1]);
    assert!(second.contains("first question") && second.contains("notice: the settings changed") && second.contains("second question"));
    let session_id = f.session.journal().kernel_session("hermes").unwrap();
    f.session.dispose().await;
    let path = f.session.journal().path().to_path_buf();
    let Fixture { dir, .. } = f;
    let mut restarted = open(dir, Journal::open(&path).unwrap(), &model.url());
    restarted.send("r3", "third question").await;
    restarted.turn().await;
    let third = conversation(&model.requests()[2]);
    assert!(third.contains("first question") && third.contains("second question") && third.contains("third question"), "{third}");
    assert_eq!(restarted.session.journal().kernel_session("hermes").as_deref(), Some(session_id.as_str()));
    assert_eq!(restarted.said(), vec!["answer 0", "answer 1", "answer 2"]);
    restarted.session.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_model_failure_as_an_error_turn() {
    require_hermes!();
    let mut f = fixture("http://127.0.0.1:9");
    f.send("r1", "hello").await;
    let events = f.turn().await;
    assert_eq!(events.last(), Some(&KernelEvent::AgentEnd { terminal: true, awaiting_async: false }));
    assert_eq!(f.session.journal().last_stop_reason().as_deref(), Some("error"));
    f.session.dispose().await;
}
