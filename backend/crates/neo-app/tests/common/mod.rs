//! Test support: the application over a scripted kernel, whose "model" is a closure the test writes. The Sessions,
//! journals, effect queue, Engine and store are the real ones; only the runtime process is replaced.
#![allow(dead_code)]

use neo_app::app::{App, Machine, Timings};
use neo_app::kernels::{Kernels, ModelOption, SessionRole, SessionSpec};
use neo_app::settings::Kernel;
use neo_core::model::Ticket;
use neo_core::ports::Repositories;
use neo_kernel::journal::Entry;
use neo_kernel::session::{Driver, DriverEvent};
use neo_kernel::types::{text_of, Block, BoxFut, Deliver, Guard, JobKind, KernelJob, Message, Role, ToolHost};
use neo_testkit::TempDir;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

/// What the scripted model is given for one turn.
pub struct Turn {
    pub role: SessionRole,
    pub session_id: String,
    pub cwd: std::path::PathBuf,
    /// The user message of this turn.
    pub text: String,
    pub tools: Arc<dyn ToolHost>,
    /// Lets the turn leave a background job running after it ends.
    pub jobs: Arc<Mutex<Vec<KernelJob>>>,
}

impl Turn {
    /// Call a tool as the runtime would: the guard first, then the host.
    pub async fn call(&self, name: &str, arguments: Value) -> Result<Value, String> {
        if let Guard::Block(reason) = self.tools.guard(name, &arguments).await {
            return Err(reason);
        }
        self.tools.call(name, arguments).await
    }
    /// The first JSON object in the turn's text that has this field.
    pub fn card(&self, field: &str) -> Option<Value> {
        self.text.split("\n\n").filter_map(|part| serde_json::from_str::<Value>(part).ok()).find(|value| value.get(field).is_some())
    }
    pub fn has(&self, needle: &str) -> bool {
        self.text.contains(needle)
    }
    pub fn tool_names(&self) -> Vec<String> {
        self.tools.specs().into_iter().map(|spec| spec.name).collect()
    }
}

/// The JSON messages a turn's text carries, one per paragraph.
pub fn messages(text: &str) -> Vec<Value> {
    text.split("\n\n").filter_map(|part| serde_json::from_str::<Value>(part).ok()).collect()
}
/// The message of a turn's text whose `kind` is `kind`.
pub fn message(text: &str, kind: &str) -> Value {
    messages(text).into_iter().find(|value| value["kind"] == kind).unwrap_or_else(|| panic!("no {kind} message in {text}"))
}

/// What the scripted model says at the end of a turn; `Err` is a failed model request.
pub type Said = Result<String, String>;
pub type Model = Arc<dyn Fn(Turn) -> BoxFut<'static, Said> + Send + Sync>;

/// One turn the kernel ran, for assertions.
#[derive(Clone, Debug)]
pub struct Ran {
    pub role: SessionRole,
    pub session_id: String,
    pub text: String,
    pub deliver: Deliver,
    pub resumed: Option<String>,
    pub model: Option<String>,
}

#[derive(Default)]
pub struct Scripted {
    pub model: Mutex<Option<Model>>,
    pub ran: Mutex<Vec<Ran>>,
    pub opened: Mutex<Vec<SessionSpec>>,
    /// The kernel each opened Session runs on, by role.
    pub opened_on: Mutex<Vec<(SessionRole, Kernel)>>,
    pub unavailable: Mutex<Option<String>>,
    /// The kernels installed through the application; installing one makes every kernel available.
    pub installed: Mutex<Vec<Kernel>>,
    /// Where the application finds WeChat.
    pub wechat: Mutex<neo_app::wechat_protocol::Protocol>,
    pub models: Mutex<Vec<ModelOption>>,
    /// Turns wait here until the test lets them go, when set.
    pub hold: AtomicBool,
    pub release: tokio::sync::Notify,
    pub active: AtomicUsize,
    pub most_active: AtomicUsize,
    #[allow(clippy::type_complexity)]
    pub set_models: Mutex<Vec<(String, Option<String>, Option<String>)>>,
    pub closed: Mutex<Vec<String>>,
    /// When set, `Driver::cancel` returns false (simulating Antigravity, which cannot cancel one job from outside).
    pub refuse_cancel: AtomicBool,
}

struct ScriptedDriver {
    kernels: Arc<Scripted>,
    spec: SessionSpec,
    host: Arc<dyn ToolHost>,
    events: mpsc::UnboundedSender<DriverEvent>,
    /// Turns run one at a time, in the order they were submitted.
    queue: mpsc::UnboundedSender<(String, String, Deliver, Option<String>)>,
    jobs: Arc<Mutex<Vec<KernelJob>>>,
    acknowledged: Mutex<Vec<String>>,
    runtime_id: String,
    closed: AtomicBool,
    /// Tells a turn in progress that its runtime was closed.
    closing: tokio::sync::watch::Sender<bool>,
}

impl Driver for ScriptedDriver {
    fn kernel(&self) -> &'static str {
        "scripted"
    }
    fn submit<'a>(&'a self, id: &'a str, content: &'a [Block], deliver: Deliver, resume: Option<String>) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            if self.closed.load(Ordering::SeqCst) {
                return Err("The scripted runtime is closed".into());
            }
            let text: Vec<&str> = content.iter().filter_map(|block| if let Block::Text { text } = block { Some(text.as_str()) } else { None }).collect();
            self.queue.send((id.to_string(), text.join("\n\n"), deliver, resume)).map_err(|_| "The scripted runtime is closed".to_string())
        })
    }
    fn interrupt(&self) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
    fn jobs(&self) -> BoxFut<'_, Vec<KernelJob>> {
        Box::pin(async move { self.jobs.lock().unwrap().clone() })
    }
    fn acknowledge<'a>(&'a self, ids: &'a [String]) -> BoxFut<'a, ()> {
        Box::pin(async move { self.acknowledged.lock().unwrap().extend(ids.iter().cloned()) })
    }
    fn cancel<'a>(&'a self, id: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async move {
            if self.kernels.refuse_cancel.load(Ordering::SeqCst) {
                return false;
            }
            let mut jobs = self.jobs.lock().unwrap();
            let before = jobs.len();
            jobs.retain(|job| job.id != id);
            jobs.len() != before
        })
    }
    fn set_model<'a>(&'a self, model: Option<&'a str>, thinking: Option<&'a str>) -> BoxFut<'a, ()> {
        Box::pin(async move {
            self.kernels.set_models.lock().unwrap().push((self.spec.session_id.clone(), model.map(str::to_string), thinking.map(str::to_string)))
        })
    }
    fn pid(&self) -> Option<u32> {
        None
    }
    fn close(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            self.closed.store(true, Ordering::SeqCst);
            let _ = self.closing.send(true);
            self.kernels.closed.lock().unwrap().push(self.spec.session_id.clone());
        })
    }
}

/// The scripted kernel as the application holds it.
pub struct ScriptedKernels(pub Arc<Scripted>);

impl Kernels for ScriptedKernels {
    fn open(&self, kernel: Kernel, spec: &SessionSpec, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Result<Arc<dyn Driver>, String> {
        let kernels = &self.0;
        kernels.opened.lock().unwrap().push(spec.clone());
        kernels.opened_on.lock().unwrap().push((spec.role, kernel));
        let (queue, mut turns) = mpsc::unbounded_channel::<(String, String, Deliver, Option<String>)>();
        let driver = Arc::new(ScriptedDriver {
            kernels: kernels.clone(),
            spec: spec.clone(),
            host,
            events,
            queue,
            jobs: Arc::new(Mutex::new(Vec::new())),
            acknowledged: Mutex::new(Vec::new()),
            runtime_id: format!("rt-{}", spec.session_id),
            closed: AtomicBool::new(false),
            closing: tokio::sync::watch::channel(false).0,
        });
        let running = driver.clone();
        tokio::spawn(async move {
            while let Some((id, text, deliver, resumed)) = turns.recv().await {
                let driver = &running;
                if driver.closed.load(Ordering::SeqCst) {
                    return;
                }
                let kernels = &driver.kernels;
                let _ = driver.events.send(DriverEvent::SessionId(driver.runtime_id.clone()));
                let _ = driver.events.send(DriverEvent::Running);
                let _ = driver.events.send(DriverEvent::Taken(id));
                kernels.ran.lock().unwrap().push(Ran {
                    role: driver.spec.role,
                    session_id: driver.spec.session_id.clone(),
                    text: text.clone(),
                    deliver,
                    resumed,
                    model: driver.spec.model.as_ref().map(|model| model.model.clone()),
                });
                let active = kernels.active.fetch_add(1, Ordering::SeqCst) + 1;
                kernels.most_active.fetch_max(active, Ordering::SeqCst);
                while kernels.hold.load(Ordering::SeqCst) {
                    kernels.release.notified().await;
                }
                let model = kernels.model.lock().unwrap().clone();
                let turn = Turn {
                    role: driver.spec.role,
                    session_id: driver.spec.session_id.clone(),
                    cwd: driver.spec.cwd.clone(),
                    text,
                    tools: driver.host.clone(),
                    jobs: driver.jobs.clone(),
                };
                let mut closing = driver.closing.subscribe();
                let said = tokio::select! {
                    said = async { match model { Some(model) => model(turn).await, None => Ok("Done.".to_string()) } } => Some(said),
                    // The runtime was closed mid-turn, as when its process is ended.
                    _ = closing.wait_for(|closed| *closed) => None,
                };
                kernels.active.fetch_sub(1, Ordering::SeqCst);
                let Some(said) = said else { return };
                if driver.closed.load(Ordering::SeqCst) {
                    return;
                }
                let (text, stop) = match said {
                    Ok(text) => (text, "stop"),
                    Err(error) => (error, "error"),
                };
                let _ = driver.events.send(DriverEvent::Message(Message {
                    role: Role::Assistant,
                    content: vec![Block::text(text)],
                    stop_reason: Some(stop.into()),
                }));
                let awaiting = !driver.jobs.lock().unwrap().is_empty();
                let _ = driver.events.send(DriverEvent::Idle { awaiting_async: awaiting });
            }
        });
        Ok(driver)
    }
    fn models(&self, _kernel: Kernel) -> BoxFut<'_, Result<Vec<ModelOption>, String>> {
        Box::pin(async move { Ok(self.0.models.lock().unwrap().clone()) })
    }
    fn unavailable(&self, _kernel: Kernel) -> Option<String> {
        self.0.unavailable.lock().unwrap().clone()
    }
    fn install(&self, kernel: Kernel) -> BoxFut<'_, Result<std::path::PathBuf, String>> {
        Box::pin(async move {
            self.0.installed.lock().unwrap().push(kernel);
            *self.0.unavailable.lock().unwrap() = None;
            Ok(std::path::PathBuf::from("/installed").join(kernel.as_str()))
        })
    }
}

pub struct Fixture {
    pub dir: Arc<TempDir>,
    pub kernels: Arc<Scripted>,
    pub app: Arc<App>,
}

pub fn model(run: impl Fn(Turn) -> BoxFut<'static, Said> + Send + Sync + 'static) -> Model {
    Arc::new(run)
}

/// The default script: the orchestrator accepts each candidate as a new ticket and sends each ready report as the
/// result; a worker writes a file into its directory and reports ready.
pub fn core_model() -> Model {
    model(|turn| {
        Box::pin(async move {
            match turn.role {
                SessionRole::Orchestrator => {
                    if let Some(card) = turn.card("kind").filter(|card| card["kind"] == "candidate") {
                        let routed = turn
                            .call("orchestrator_route", json!({"decisions": [{"kind": "accept", "trigger_id": card["trigger_id"], "title": "Fix fixture typo", "worktree_name": "fix-fixture-typo", "acknowledgement": "I will fix the fixture typo."}]}))
                            .await?;
                        return Ok(format!("Routed: {}", routed["results"][0]["decision"].as_str().unwrap_or("refused")));
                    }
                    if let Some(report) = turn.card("kind").filter(|card| card["kind"] == "worker_report" && card["state"] == "ready") {
                        turn.call(
                            "orchestrator_reply",
                            json!({"ticket_id": report["ticket"]["ticket_id"], "purpose": "result", "text": "Fixture work completed."}),
                        )
                        .await?;
                    }
                    Ok("Done.".into())
                }
                SessionRole::Worker => {
                    std::fs::write(turn.cwd.join("fixture-result.txt"), "fixed\n").map_err(|error| error.to_string())?;
                    turn.call(
                        "orchestrator_report",
                        json!({"state": "ready", "summary": "Fixture change is ready.", "topic": "The fixture typo in fixture-result.txt"}),
                    )
                    .await?;
                    Ok("Worker ready.".into())
                }
                _ => Ok("Done.".into()),
            }
        })
    })
}

/// The Watchdog as tests run it: passes only when a test asks for one, and then without waiting.
pub fn watchdog_timings() -> neo_app::watchdog::WatchdogTimings {
    neo_app::watchdog::WatchdogTimings {
        interval: Duration::from_secs(3600),
        stall: Duration::ZERO,
        cpu_only_silence: Duration::from_secs(3600),
        long_task: Duration::ZERO,
        idle_grace: Duration::ZERO,
        idle_recheck: Duration::ZERO,
        unreplied_grace: Duration::ZERO,
        turn_timeout: Duration::from_secs(10),
    }
}

pub async fn open_in(dir: Arc<TempDir>, kernels: Arc<Scripted>) -> Fixture {
    let app = App::open(
        Machine { state_dir: dir.join("state"), wechat: kernels.wechat.lock().unwrap().clone(), program: None },
        Arc::new(ScriptedKernels(kernels.clone())),
        Timings { wechat_burst: Duration::from_millis(60), web_burst: Duration::ZERO, watchdog: watchdog_timings() },
    )
    .expect("the application opens");
    Fixture { dir, kernels, app }
}

/// The application over a new data directory, with the core script, not started yet.
pub async fn fixture() -> Fixture {
    let kernels = Arc::new(Scripted::default());
    *kernels.model.lock().unwrap() = Some(core_model());
    open_in(Arc::new(TempDir::new("app")), kernels).await
}

/// The same, started.
pub async fn started() -> Fixture {
    let f = fixture().await;
    f.app.start().await.expect("the application starts");
    f
}

impl Fixture {
    pub fn script(&self, run: Model) {
        *self.kernels.model.lock().unwrap() = Some(run);
    }
    /// Wait until `condition` holds, pumping passes meanwhile.
    pub async fn until(&self, what: &str, condition: impl Fn() -> bool) {
        for _ in 0..600 {
            if condition() {
                return;
            }
            self.app.passes.pump();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting until {what}; transcript: {:#?}; turns: {:#?}", self.chat(), self.turns());
    }
    /// Wait until nothing is left to do: no turn runs, no effect can start, and the store agrees twice in a row.
    pub async fn settle(&self) {
        let mut quiet = 0;
        for _ in 0..400 {
            self.app.passes.idle().await;
            tokio::time::sleep(Duration::from_millis(15)).await;
            let busy = self.kernels.active.load(Ordering::SeqCst) > 0 || self.app.session(&self.app.master_id).is_some_and(|main| main.session.is_streaming());
            quiet = if busy { 0 } else { quiet + 1 };
            if quiet >= 4 {
                return;
            }
        }
        panic!("the application did not settle; turns: {:#?}", self.turns());
    }
    pub fn tickets(&self) -> Vec<Ticket> {
        let mut tickets = self.app.store.tickets();
        tickets.reverse();
        tickets
    }
    pub fn ticket(&self, index: usize) -> Ticket {
        self.tickets().into_iter().nth(index).expect("the ticket exists")
    }
    /// The visible chat transcript as (source, text).
    pub fn chat(&self) -> Vec<(String, String)> {
        self.app
            .chat_transcript()
            .into_iter()
            .map(|entry| {
                let text = match &entry {
                    Entry::CustomMessage { content, .. } => text_of(content),
                    Entry::Message { message, .. } => text_of(&message.content),
                };
                (entry.source().unwrap_or("").to_string(), text)
            })
            .collect()
    }
    pub fn turns(&self) -> Vec<(SessionRole, String)> {
        self.kernels.ran.lock().unwrap().iter().map(|ran| (ran.role, neo_app::text::clip(&ran.text, 200))).collect()
    }
    pub fn ran(&self, role: SessionRole) -> Vec<Ran> {
        self.kernels.ran.lock().unwrap().iter().filter(|ran| ran.role == role).cloned().collect()
    }
    /// A background job a scripted worker leaves running.
    pub fn job(id: &str, kind: JobKind, label: &str) -> KernelJob {
        KernelJob {
            id: id.into(),
            kind,
            label: label.into(),
            start_time: neo_core::time::now_ms(),
            progress: None,
            command: (kind == JobKind::Bash).then(|| label.to_string()),
            own: true,
            pids: Vec::new(),
        }
    }
    /// Stop the application and open it again over the same data directory, as after a restart.
    pub async fn restart(self) -> Fixture {
        self.app.stop().await;
        let (dir, kernels) = (self.dir.clone(), self.kernels.clone());
        drop(self);
        let f = open_in(dir, kernels).await;
        f.app.start().await.expect("the application starts again");
        f
    }
}

/// Counts of how often each tool result was seen, for scripts that act once.
#[derive(Default)]
pub struct Once(Mutex<HashMap<String, usize>>);

impl Once {
    /// True the first time `key` is asked.
    pub fn first(&self, key: &str) -> bool {
        let mut seen = self.0.lock().unwrap();
        let count = seen.entry(key.to_string()).or_insert(0);
        *count += 1;
        *count == 1
    }
}

/// The kernel and model settings once every kernel has listed its models.
pub async fn models_ready(app: &std::sync::Arc<neo_app::app::App>) -> serde_json::Value {
    for _ in 0..200 {
        let view = app.models_view().await;
        if view["loading"] != true {
            return view;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the kernels never listed their models");
}
