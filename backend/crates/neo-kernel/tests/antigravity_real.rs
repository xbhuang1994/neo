//! The Antigravity kernel against the real `agy` program and its real models: it needs a signed-in Antigravity CLI,
//! the network and `python3`, which stands in for `neo-agent agy-hook` as the hooks' relay, and asks a small model to
//! follow plain instructions. It runs only with `NEO_AGY_BIN=<program>`, or `NEO_REAL_ANTIGRAVITY=1` for the `agy` on
//! `PATH`; otherwise each test notes that it was skipped. The model is `NEO_AGY_MODEL`, by default
//! `gemini-3.8-flash-low`.

use neo_kernel::antigravity::{Antigravity, AntigravityDriver, AntigravityOptions};
use neo_kernel::journal::{Entry, Journal};
use neo_kernel::session::{Mode, Presentation, Session};
use neo_kernel::types::{Block, BoxFut, Guard, JobKind, KernelEvent, Role, ToolHost, ToolSpec};
use neo_testkit::TempDir;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

fn program() -> Option<PathBuf> {
    let enabled = std::env::var("NEO_REAL_ANTIGRAVITY").is_ok_and(|value| value == "1");
    std::env::var_os("NEO_AGY_BIN").map(PathBuf::from).or_else(|| enabled.then(|| neo_testkit::find_program("agy")).flatten())
}

#[derive(Default)]
struct Host {
    calls: Mutex<Vec<(String, Value)>>,
    guarded: Mutex<Vec<(String, Value)>>,
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
            self.calls.lock().unwrap().push((name.to_string(), arguments));
            Ok(json!({"reported": true, "code": "KIWI-42"}))
        })
    }
    fn guard<'a>(&'a self, tool: &'a str, input: &'a Value) -> BoxFut<'a, Guard> {
        Box::pin(async move {
            self.guarded.lock().unwrap().push((tool.to_string(), input.clone()));
            if tool == "bash" && input["command"].as_str().is_some_and(|command| command.contains("forbidden")) {
                Guard::Block("Ticket ended".into())
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

/// The hooks' relay: what `neo-agent agy-hook` does, in Python.
const RELAY: &str = "import sys, urllib.request\nreq = urllib.request.Request(sys.argv[1], data=sys.stdin.buffer.read(), method='POST')\nsys.stdout.write(urllib.request.urlopen(req, timeout=600).read().decode())\n";

fn open(dir: TempDir, journal: Journal) -> Fixture {
    open_with(dir, journal, &["read", "bash"])
}

fn open_with(dir: TempDir, journal: Journal, tools: &[&str]) -> Fixture {
    let host = Arc::new(Host::default());
    let relay = dir.join("relay.py");
    std::fs::write(&relay, RELAY).unwrap();
    let options = AntigravityOptions {
        program: program().expect("checked by the test"),
        cwd: dir.join("work"),
        system_prompt: "You are a fixture worker. Do exactly what you are asked, nothing more, and answer in one short line.".into(),
        tools: tools.iter().map(|tool| tool.to_string()).collect(),
        model: Some(std::env::var("NEO_AGY_MODEL").unwrap_or_else(|_| "gemini-3.8-flash-low".into())),
        hook_relay: vec!["python3".into(), relay.display().to_string()],
        // As in the application: one bridge folder per Session, kept across its processes.
        bridge_id: Some("fixture".into()),
        ..Default::default()
    };
    let (reports, runtime) = mpsc::unbounded_channel();
    let driver = AntigravityDriver::new(options, host.clone(), reports);
    let session = Session::new(Arc::new(journal), Arc::new(Antigravity(driver)), runtime);
    let events = session.subscribe();
    Fixture { dir, host, session, events }
}

fn fixture() -> Fixture {
    let dir = TempDir::new("antigravity-real");
    for sub in ["work", "sessions"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    let journal = Journal::create(&dir.join("sessions"), &dir.join("work")).unwrap();
    open(dir, journal)
}

impl Fixture {
    async fn turn(&mut self) -> Vec<KernelEvent> {
        let mut seen = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(240), self.events.recv()).await.expect("the turn ends in time").unwrap();
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
    fn messages(&self) -> Vec<(Role, String)> {
        self.session
            .journal()
            .entries()
            .iter()
            .filter_map(|entry| match entry {
                Entry::Message { message, .. } => Some((message.role, neo_kernel::types::text_of(&message.content))),
                _ => None,
            })
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_host_tools_guards_commands_and_resumes_its_conversation() {
    if program().is_none() {
        eprintln!("skipped: set NEO_AGY_BIN or NEO_REAL_ANTIGRAVITY=1 to run against the real Antigravity CLI");
        return;
    }
    let mut f = fixture();
    f.send("r1", "Call the orchestrator_report tool with state \"done\" and summary \"fixture\", then reply with the code it returns.").await;
    let events = f.turn().await;
    assert!(matches!(events.first(), Some(KernelEvent::AgentStart)), "{events:?}");
    assert!(events.iter().any(|event| matches!(event, KernelEvent::Taken { request_ids } if request_ids == &["r1".to_string()])), "{events:?}");
    let calls = f.host.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].0, "orchestrator_report");
    assert!(calls[0].1.get("toolSummary").is_none(), "display arguments are dropped: {:?}", calls[0].1);
    assert!(f.host.guarded.lock().unwrap().iter().any(|(tool, _)| tool == "orchestrator_report"), "host tools are guarded");
    let said = f.messages();
    assert!(said.iter().any(|(role, text)| *role == Role::Assistant && text.contains("KIWI-42")), "{said:?}");

    f.send("r2", "Run the shell command `echo forbidden-step` once. If it is denied, do not retry; reply with DENIED and the reason you were given.").await;
    f.turn().await;
    let guarded = f.host.guarded.lock().unwrap().clone();
    assert!(guarded.iter().any(|(tool, input)| tool == "bash" && input["command"].as_str().is_some_and(|c| c.contains("forbidden"))), "{guarded:?}");
    let said = f.messages();
    assert!(said.iter().rev().any(|(role, text)| *role == Role::Assistant && text.to_uppercase().contains("DENIED")), "{said:?}");
    assert!(said.iter().any(|(_, text)| text.contains("Ticket ended")), "the guard's reason reaches the model: {said:?}");

    // A new process continues the same conversation.
    let journal = Arc::clone(f.session.journal());
    let resumed_from = journal.kernel_session("antigravity").expect("the runtime's session id is recorded");
    f.session.dispose().await;
    let Fixture { dir, .. } = f;
    let journal = Journal::open(journal.path()).unwrap();
    let mut f = open(dir, journal);
    f.send("r3", "What code did the orchestrator_report tool return earlier in this conversation? Reply with the code only.").await;
    f.turn().await;
    assert_eq!(f.session.journal().kernel_session("antigravity"), Some(resumed_from));
    let said = f.messages();
    assert!(said.last().is_some_and(|(_, text)| text.contains("KIWI-42")), "{said:?}");
    f.session.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ends_a_turn_while_a_background_command_runs_and_wakes_when_it_ends() {
    if program().is_none() {
        eprintln!("skipped: set NEO_AGY_BIN or NEO_REAL_ANTIGRAVITY=1 to run against the real Antigravity CLI");
        return;
    }
    let mut f = fixture();
    f.send(
        "r1",
        "Run the shell command `sleep 25 && echo BG-FINISHED` with WaitMsBeforeAsync set to 500 so that it moves to the background. Do not wait for it or check on it: reply STARTED and end your turn at once. When it finishes, reply with its output.",
    )
    .await;
    let events = f.turn().await;
    assert_eq!(events.last(), Some(&KernelEvent::AgentEnd { terminal: false, awaiting_async: true }), "{events:?}");
    let jobs = f.session.driver().jobs().await;
    assert!(jobs.iter().any(|job| job.kind == JobKind::Bash && job.own && job.command.as_deref().is_some_and(|c| c.contains("sleep 25"))), "{jobs:?}");
    let events = f.turn().await;
    assert_eq!(events.last(), Some(&KernelEvent::AgentEnd { terminal: true, awaiting_async: false }), "{events:?}");
    assert!(f.session.driver().jobs().await.is_empty());
    let said = f.messages();
    assert!(said.iter().any(|(role, text)| *role == Role::Assistant && text.contains("BG-FINISHED")), "{said:?}");
    f.session.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_commands_on_this_machine_outside_any_sandbox() {
    if program().is_none() {
        eprintln!("skipped: set NEO_AGY_BIN or NEO_REAL_ANTIGRAVITY=1 to run against the real Antigravity CLI");
        return;
    }
    // Auto mode, the CLI's default since 1.5.7, runs commands in a sandbox whose network has only loopback.
    // `/proc/net/dev` lists the interfaces of the reader's own network namespace, after two header lines.
    let interfaces = std::fs::read_to_string("/proc/net/dev").unwrap().lines().count() - 2;
    let mut f = fixture();
    f.send("r1", "Run the shell command `tail -n +3 /proc/net/dev | wc -l` and reply with the number it prints only.").await;
    f.turn().await;
    let said = f.messages();
    let answer = said.iter().rev().find(|(role, _)| *role == Role::Assistant).map(|(_, text)| text.trim().to_string());
    assert_eq!(answer, Some(interfaces.to_string()), "{said:?}");
    f.session.dispose().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_a_running_subagent_as_a_background_job() {
    if program().is_none() {
        eprintln!("skipped: set NEO_AGY_BIN or NEO_REAL_ANTIGRAVITY=1 to run against the real Antigravity CLI");
        return;
    }
    let dir = TempDir::new("antigravity-real");
    for sub in ["work", "sessions"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    let journal = Journal::create(&dir.join("sessions"), &dir.join("work")).unwrap();
    let mut f = open_with(dir, journal, &["read", "bash", "task"]);
    f.send("r0", "Reply OK.").await;
    f.turn().await;
    // Workers come back in a new process that continues their conversation.
    let journal = Arc::clone(f.session.journal());
    f.session.dispose().await;
    let Fixture { dir, .. } = f;
    let journal = Journal::open(journal.path()).unwrap();
    let mut f = open_with(dir, journal, &["read", "bash", "task"]);
    f.send(
        "r1",
        "Use invoke_subagent to start one subagent whose only job is to run the shell command `sleep 40 && echo SUB-FINISHED` and send back its output. Do not run anything yourself and do not wait: reply STARTED and end your turn at once. When the subagent reports, reply with its output.",
    )
    .await;
    let events = f.turn().await;
    assert_eq!(events.last(), Some(&KernelEvent::AgentEnd { terminal: false, awaiting_async: true }), "{events:?}");
    let mut seen = Vec::new();
    for _ in 0..40 {
        seen = f.session.driver().jobs().await;
        if seen.iter().any(|job| job.kind == JobKind::Task && job.label.contains("SUB-FINISHED")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    // Listed with its task, taken from the message that started it.
    assert!(seen.iter().any(|job| job.kind == JobKind::Task && job.own && job.label.contains("SUB-FINISHED")), "{seen:?}");
    let events = f.turn().await;
    assert_eq!(events.last(), Some(&KernelEvent::AgentEnd { terminal: true, awaiting_async: false }), "{events:?}");
    assert!(f.session.driver().jobs().await.is_empty());
    f.session.dispose().await;
}
