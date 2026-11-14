//! The Oh My Pi kernel against the real `omp` program, the real shim extension and a local fake OpenAI endpoint: no
//! network, no account. These start real runtime processes, so they run only with `NEO_REAL_KERNELS=1` (the `omp` on
//! `PATH`) or `NEO_OMP_BIN=<program>`; otherwise each test notes that it was skipped.

use neo_kernel::journal::{Entry, Journal};
use neo_kernel::omp::{Omp, OmpDriver, OmpOptions};
use neo_kernel::session::{Mode, Presentation, Session};
use neo_kernel::types::{text_of, Block, BoxFut, Guard, JobKind, KernelEvent, Role, ToolHost, ToolSpec};
use neo_testkit::models::{conversation, openai, tool_names, tool_results, Reply};
use neo_testkit::TempDir;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

fn program() -> Option<PathBuf> {
    let enabled = std::env::var("NEO_REAL_KERNELS").is_ok_and(|value| value == "1");
    std::env::var_os("NEO_OMP_BIN").map(PathBuf::from).or_else(|| enabled.then(|| neo_testkit::find_program("omp")).flatten())
}

fn shim() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../shim/neo-omp-shim.ts").canonicalize().expect("the shim extension is in the repository")
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
        dir.join("agent/models.yml"),
        format!(
            "providers:\n  fixture:\n    baseUrl: {model_url}/v1\n    api: openai-completions\n    apiKey: fixture-key\n    models:\n      - id: fixture\n        name: fixture\n        api: openai-completions\n        reasoning: false\n        input: [text, image]\n        cost: {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }}\n        contextWindow: 32768\n        maxTokens: 4096\n"
        ),
    )
    .unwrap();
    // A command still running after a second moves to the background, as a worker's does after a minute.
    std::fs::write(
        dir.join("overlay.yml"),
        "async:\n  enabled: true\nbash:\n  autoBackground:\n    enabled: true\n    thresholdMs: 1000\nretry:\n  enabled: false\n",
    )
    .unwrap();
    std::fs::write(dir.join("prompt.md"), "You are a fixture worker.\nReport with orchestrator_report.\n").unwrap();
    let host = Arc::new(Host::default());
    let options = OmpOptions {
        program: program().expect("checked by the test"),
        shim: shim(),
        cwd: dir.join("work"),
        agent_dir: dir.join("agent"),
        session_dir: Some(dir.join("omp-sessions")),
        system_prompt_file: dir.join("prompt.md"),
        builtin_tools: vec!["read".into(), "bash".into()],
        model: Some("fixture/fixture".into()),
        config: vec![dir.join("overlay.yml")],
        ..Default::default()
    };
    let (reports, runtime) = mpsc::unbounded_channel();
    let driver = OmpDriver::new(options, host.clone(), reports);
    let session = Session::new(Arc::new(journal), Arc::new(Omp(driver)), runtime);
    let events = session.subscribe();
    Fixture { dir, host, session, events }
}

fn fixture(model_url: &str) -> Fixture {
    let dir = TempDir::new("omp-real");
    for sub in ["work", "agent", "sessions", "omp-sessions"] {
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

macro_rules! require_omp {
    () => {
        if program().is_none() {
            eprintln!("skipped: set NEO_REAL_KERNELS=1 or NEO_OMP_BIN=<program> to run against the real omp program");
            return;
        }
    };
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_a_turn_with_a_host_tool_a_blocked_built_in_tool_and_a_tool_error() {
    require_omp!();
    let model = openai(|request, _| match tool_results(request) {
        0 => Reply::call("orchestrator_report", json!({"state": "progress", "summary": "Looking"})),
        1 => Reply::call("bash", json!({"command": "echo forbidden"})),
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
    // The host served its tool twice, and the shim asked it about every call.
    assert_eq!(
        *f.host.calls.lock().unwrap(),
        vec![
            ("orchestrator_report".to_string(), json!({"state": "progress", "summary": "Looking"})),
            ("orchestrator_report".to_string(), json!({"state": "bogus", "summary": "x"})),
        ]
    );
    assert_eq!(*f.host.guarded.lock().unwrap(), vec!["orchestrator_report", "bash", "orchestrator_report"]);
    // What the model was given: the system prompt, the host's tool beside only the allowed built-in ones, and each outcome.
    let requests = model.requests();
    assert_eq!(requests.len(), 4);
    assert!(conversation(&requests[0]).contains("You are a fixture worker.") && conversation(&requests[0]).contains("Fix the typo in README."));
    let offered = tool_names(&requests[0]);
    assert!(
        offered.contains(&"orchestrator_report".to_string()) && offered.contains(&"bash".to_string()) && offered.contains(&"read".to_string()),
        "{offered:?}"
    );
    assert!(!offered.contains(&"write".to_string()) && !offered.contains(&"edit".to_string()), "{offered:?}");
    assert!(conversation(&requests[1]).contains("reported"));
    assert!(conversation(&requests[2]).contains("Ticket ended; new work needs a new authorized ticket"));
    assert!(conversation(&requests[3]).contains("Unknown state bogus"));
    assert_eq!(f.said().last().map(String::as_str), Some("All done."));
    assert_eq!(f.session.journal().last_stop_reason().as_deref(), Some("stop"));
    let context_file = f.session.journal().kernel_session("omp").expect("the runtime's context file is recorded");
    assert!(context_file.starts_with(f.dir.join("omp-sessions").to_str().unwrap()), "{context_file}");
    f.session.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_acknowledges_and_cancels_a_background_job_through_the_shim() {
    require_omp!();
    let model = openai(|request, _| match tool_results(request) {
        0 => Reply::call("bash", json!({"command": "sleep 120"})),
        _ => Reply::text("The command runs in the background."),
    })
    .await;
    let mut f = fixture(&model.url());
    f.send("r1", "Run the long command.").await;
    let events = f.turn().await;
    // The turn ends while its command still runs: not terminal, the job will wake the Session.
    assert_eq!(events.last(), Some(&KernelEvent::AgentEnd { terminal: false, awaiting_async: true }));
    let jobs = f.session.driver().jobs().await;
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_eq!((jobs[0].kind, jobs[0].command.as_deref(), jobs[0].own), (JobKind::Bash, Some("sleep 120"), true));
    assert!(jobs[0].start_time > 0);
    // Letting it finish quietly, then cancelling it: the Session is not woken, and the job is gone.
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
    require_omp!();
    let model = openai(|_, number| Reply::text(&format!("answer {number}"))).await;
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
    let context_file = f.session.journal().kernel_session("omp").unwrap();
    // The host restarts: a new process resumes the runtime's own context file, so the model still has the earlier turns.
    f.session.dispose().await;
    let path = f.session.journal().path().to_path_buf();
    let Fixture { dir, .. } = f;
    let mut restarted = open(dir, Journal::open(&path).unwrap(), &model.url());
    restarted.send("r3", "third question").await;
    restarted.turn().await;
    let third = conversation(&model.requests()[2]);
    assert!(third.contains("first question") && third.contains("second question") && third.contains("third question"), "{third}");
    assert_eq!(restarted.session.journal().kernel_session("omp").as_deref(), Some(context_file.as_str()));
    assert_eq!(restarted.said(), vec!["answer 0", "answer 1", "answer 2"]);
    restarted.session.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_model_failure_as_an_error_turn() {
    require_omp!();
    // Nothing listens here, so every model request fails.
    let mut f = fixture("http://127.0.0.1:9");
    f.send("r1", "hello").await;
    let events = f.turn().await;
    assert_eq!(events.last(), Some(&KernelEvent::AgentEnd { terminal: true, awaiting_async: false }));
    assert_eq!(f.session.journal().last_stop_reason().as_deref(), Some("error"));
    f.session.dispose().await;
}
