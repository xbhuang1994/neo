//! The application: one value that owns the store, the Engine, the effect queue and every Session, and wires the
//! Engine's ports to them. Its behaviour lives in the modules that extend it (`sessions`, `executor`, `tools`, …).

use crate::effects::{self, Effects, Failure, Options};
use crate::executor::ExecutorState;
use crate::health::{Health, HealthBoard};
use crate::kernels::Kernels;
use crate::notices::{event_notice, followup_relay, Notice, Relay};
use crate::outbox::{Channels, Outbox, Sent};
use crate::passes::Passes;
use crate::policy::{policy_effects, policy_version, SettingsPolicy, Sources};
use crate::sessions::SessionsState;
use crate::settings::{Settings, SettingsStore, CHAT_SOURCE};
use neo_core::engine::{Engine, EngineOptions};
use neo_core::ids::key;
use neo_core::model::{Assignment, ChannelRef, Ticket};
use neo_core::ports::{Assessor, Candidate, DomainEvent, Executor, OutboundMessage, Policy, Records, Repositories, SourceScope};
use neo_core::time::now_iso;
use neo_store::Store;
use serde_json::json;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock, Weak};
use std::time::Duration;
use tokio::runtime::Handle;

/// Where the application keeps its state.
#[derive(Clone, Debug)]
pub struct Machine {
    /// The data directory: database, session transcripts, ticket directories, attachments.
    pub state_dir: PathBuf,
    /// Where WeChat's API is; its own addresses unless a test stands in for it.
    pub wechat: crate::wechat_protocol::Protocol,
    /// The application's own program, which stands in for blocked commands on Windows.
    pub program: Option<PathBuf>,
}

/// How long to wait for more chat messages before routing a burst.
#[derive(Clone, Copy, Debug)]
pub struct Timings {
    /// After a WeChat message, which people often send in several parts.
    pub wechat_burst: Duration,
    /// After a message typed into the app.
    pub web_burst: Duration,
    /// The Watchdog's pace.
    pub watchdog: crate::watchdog::WatchdogTimings,
}

impl Default for Timings {
    fn default() -> Self {
        Timings { wechat_burst: Duration::from_millis(1800), web_burst: Duration::ZERO, watchdog: Default::default() }
    }
}

/// The application.
pub struct App {
    /// Where state is kept.
    pub machine: Machine,
    /// Durable state.
    pub store: Arc<Store>,
    /// Component health.
    pub board: HealthBoard,
    /// The effect queue.
    pub effects: Arc<Effects>,
    /// The domain Engine.
    pub engine: Arc<Engine>,
    /// Outbound messages.
    pub outbox: Arc<Outbox>,
    /// Orchestration passes.
    pub passes: Arc<Passes>,
    /// The agent runtimes.
    pub kernels: Arc<dyn Kernels>,
    /// The main Session's id.
    pub master_id: String,
    pub(crate) rt: Handle,
    pub(crate) weak: Weak<App>,
    settings: RwLock<(Arc<Settings>, Arc<dyn Policy>)>,
    closing: AtomicBool,
    /// Turns true when the application stops, for whatever waits and should give up then.
    pub(crate) stopping: tokio::sync::watch::Sender<bool>,
    pub(crate) watchdog: crate::watchdog::WatchdogState,
    /// Above zero while a command the main Session itself made runs, which needs no notice to it.
    quiet: AtomicUsize,
    pub(crate) sessions: SessionsState,
    pub(crate) executor: ExecutorState,
    pub(crate) wechat: crate::wechat::WeChatState,
}

struct ExecutorPort(Weak<App>);

impl Executor for ExecutorPort {
    fn start(&self, ticket: &Ticket, assignment: &Assignment) {
        if let Some(app) = self.0.upgrade() {
            app.effects.enqueue(effects::LAUNCH, &assignment.id, &json!({"ticketId": ticket.id, "assignmentId": assignment.id}));
        }
    }
    fn deliver(&self, ticket: &Ticket, _assignment: &Assignment) {
        if let Some(app) = self.0.upgrade() {
            app.effects.enqueue(effects::DELIVERY, &ticket.id, &json!({"ticketId": ticket.id}));
        }
    }
    fn stop(&self, ticket: &Ticket, assignment: &Assignment, reason: &str) {
        if let Some(app) = self.0.upgrade() {
            app.executor_stop(ticket, assignment, reason);
        }
    }
}

struct AssessorPort(Weak<App>);

impl Assessor for AssessorPort {
    fn request(&self, candidate: Candidate) {
        if let (Some(app), Some(first)) = (self.0.upgrade(), candidate.triggers.first()) {
            app.effects.enqueue(effects::ASSESSMENT, &candidate.eval_id, &json!({"triggerId": first.id}));
        }
    }
}

struct ChatChannels(Weak<App>);

impl Channels for ChatChannels {
    fn enabled(&self, source: &str) -> bool {
        source == CHAT_SOURCE
    }
    fn allowed(&self, _channel: &ChannelRef) -> bool {
        true
    }
    fn send(&self, message: OutboundMessage) -> Pin<Box<dyn Future<Output = Result<Sent, String>> + Send + '_>> {
        Box::pin(async move {
            match self.0.upgrade() {
                Some(app) => app.chat_send(&message).await,
                None => Ok(Sent::Waiting),
            }
        })
    }
}

impl App {
    /// Open the application over the data directory. Nothing runs until [`App::start`].
    pub fn open(machine: Machine, kernels: Arc<dyn Kernels>, timings: Timings) -> Result<Arc<App>, String> {
        std::fs::create_dir_all(&machine.state_dir).map_err(|error| format!("Cannot create {}: {error}", machine.state_dir.display()))?;
        let store = Arc::new(Store::open(&machine.state_dir.join("orchestrator.sqlite")).map_err(|error| error.to_string())?);
        let board = HealthBoard::new();
        board.set("runtime", Health::waiting("Starting"));
        let effects = Effects::new(store.clone(), board.clone());
        let master_id = store.get::<String>("master-id").unwrap_or_else(|| format!("orchestrator-{}", key(&[&machine.state_dir.display().to_string()])));
        store.set("master-id", &master_id);
        let sources: Arc<dyn SourceScope> = Arc::new(Sources);
        let current = Arc::new(SettingsStore(&store).current());
        let policy: Arc<dyn Policy> = Arc::new(SettingsPolicy::new((*current).clone(), sources.clone()));
        let rt = Handle::current();
        let wechat = machine.wechat.clone();
        Ok(Arc::new_cyclic(|weak: &Weak<App>| {
            let paused = {
                let weak = weak.clone();
                Arc::new(move || weak.upgrade().is_none_or(|app| app.paused())) as Arc<dyn Fn() -> bool + Send + Sync>
            };
            let outbox = Outbox::new(store.clone(), effects.clone(), Arc::new(ChatChannels(weak.clone())), paused);
            let (for_policy, for_prepare, for_emit) = (weak.clone(), weak.clone(), weak.clone());
            let fallback = policy.clone();
            let engine = Arc::new(Engine::new(EngineOptions {
                repo: store.clone(),
                policy: Box::new(move || for_policy.upgrade().map(|app| app.policy()).unwrap_or_else(|| fallback.clone())),
                scope: sources.clone(),
                assessor: Arc::new(AssessorPort(weak.clone())),
                executor: Arc::new(ExecutorPort(weak.clone())),
                outbox: outbox.clone(),
                prepare_ticket: Some(Box::new(move |ticket, accept| match for_prepare.upgrade() {
                    Some(app) => app.executor_prepare(ticket, accept),
                    None => Ok(ticket),
                })),
                now: None,
                emit: Some(Box::new(move |event, at| {
                    if let Some(app) = for_emit.upgrade() {
                        app.emitted(&event, at);
                    }
                })),
            }));
            let burst = Arc::new(move |trigger: &neo_core::model::Trigger| {
                if trigger.source != CHAT_SOURCE {
                    Duration::ZERO
                } else if trigger.meta.get("surface").and_then(|surface| surface.as_str()) == Some("wechat") {
                    timings.wechat_burst
                } else {
                    timings.web_burst
                }
            });
            let passes = Passes::new(engine.clone(), effects.clone(), board.clone(), burst);
            App {
                machine,
                store,
                board,
                effects,
                engine,
                outbox,
                passes,
                kernels,
                master_id,
                rt,
                weak: weak.clone(),
                settings: RwLock::new((current, policy)),
                closing: AtomicBool::new(false),
                stopping: tokio::sync::watch::Sender::new(false),
                watchdog: crate::watchdog::WatchdogState::new(timings.watchdog),
                quiet: AtomicUsize::new(0),
                sessions: SessionsState::default(),
                executor: ExecutorState::default(),
                wechat: crate::wechat::WeChatState::new(wechat),
            }
        }))
    }

    /// The settings in force.
    pub fn settings(&self) -> Arc<Settings> {
        self.settings.read().unwrap_or_else(|poisoned| poisoned.into_inner()).0.clone()
    }
    /// The Policy the settings make.
    pub fn policy(&self) -> Arc<dyn Policy> {
        self.settings.read().unwrap_or_else(|poisoned| poisoned.into_inner()).1.clone()
    }
    /// Processing is paused: nothing is assessed, launched or sent.
    pub fn paused(&self) -> bool {
        self.settings().paused
    }
    /// The application is shutting down.
    pub fn closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }

    /// Save new settings, tell open tickets how a Policy change bears on them, and restart running Evals under it.
    /// `source` says who saved them (`app`, `tool` or `internal`), and `block` which part, for the notice.
    pub fn save_settings(&self, next: Settings, source: &str, block: &str) -> Result<Arc<Settings>, String> {
        let mut next = next;
        next.normalize();
        next.validate()?;
        let previous = self.settings();
        if *previous == next {
            return Ok(previous);
        }
        let sources: Arc<dyn SourceScope> = Arc::new(Sources);
        let (from, to) = (policy_version(&previous), policy_version(&next));
        let changed = crate::notices::changed_paths(&serde_json::to_value(&*previous).unwrap_or_default(), &serde_json::to_value(&next).unwrap_or_default());
        let saved = Arc::new(next);
        self.store
            .atomic(|| {
                SettingsStore(&self.store).save(&saved, source, &to, &now_iso())?;
                let effects = policy_effects(&self.store.open_tickets(), &previous, &saved, &sources);
                // The Engine reads the new Policy from here on, also inside this transaction.
                *self.settings.write().unwrap_or_else(|poisoned| poisoned.into_inner()) =
                    (saved.clone(), Arc::new(SettingsPolicy::new((*saved).clone(), sources.clone())));
                if from != to {
                    self.engine.policy_changed(&from, &to, &effects);
                }
                self.notify(crate::notices::settings_notice(block, &changed));
                Ok::<(), String>(())
            })
            .inspect_err(|_| {
                *self.settings.write().unwrap_or_else(|poisoned| poisoned.into_inner()) =
                    (previous.clone(), Arc::new(SettingsPolicy::new((*previous).clone(), sources.clone())));
            })?;
        if previous.executor.blocked_commands != saved.executor.blocked_commands {
            self.sync_blocked();
        }
        self.passes.pump();
        Ok(saved)
    }

    /// Make the stand-ins for blocked commands match the settings.
    pub(crate) fn sync_blocked(&self) {
        match crate::blocked::sync(&self.machine.state_dir, &self.settings().executor.blocked_commands, self.machine.program.as_deref()) {
            Ok(()) => self.board.set("environment", Health::ready("Blocked commands are in place")),
            Err(error) => self.board.set("environment", Health::error(error)),
        }
    }

    /// Run an Engine command the main Session itself made, which needs no notice to it.
    pub fn quietly<T>(&self, run: impl FnOnce() -> T) -> T {
        self.quiet.fetch_add(1, Ordering::SeqCst);
        let result = run();
        self.quiet.fetch_sub(1, Ordering::SeqCst);
        result
    }

    /// Steer a message into the main Session, once per request id.
    pub fn relay(&self, relay: Relay) {
        self.effects.enqueue(effects::RELAY, &relay.id, &json!({"text": relay.text}));
    }
    /// Inject a notice into the main Session without waking it.
    pub fn notify(&self, notice: Notice) {
        self.effects.enqueue(effects::NOTICE, &notice.name, &json!({"value": notice.value}));
    }

    fn emitted(&self, event: &DomainEvent, at: &str) {
        if self.quiet.load(Ordering::SeqCst) > 0 {
            return;
        }
        if let Some(notice) = event_notice(event, at, |id| self.store.ticket(id)) {
            self.notify(notice);
        }
        let followed = match event {
            DomainEvent::TriggerReceived { trigger_id, .. } | DomainEvent::TicketResumed { trigger_id, .. } | DomainEvent::TriggerFollowup { trigger_id } => {
                Some(trigger_id)
            }
            _ => None,
        };
        if let Some(trigger) = followed.and_then(|id| self.store.trigger(id)) {
            if let Some(relay) = followup_relay(&Records(self.store.as_ref()), &trigger) {
                self.relay(relay);
            }
        }
    }

    /// Start everything: the main Session, interrupted work, the effect queue and the passes.
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        let handler = |run: fn(Arc<App>, serde_json::Value, String) -> effects::Running| -> effects::Handler {
            let weak = self.weak.clone();
            Arc::new(move |payload, key| match weak.upgrade() {
                Some(app) => run(app, payload, key),
                None => Box::pin(async { Err(Failure::Later("The application is stopping".into())) }),
            })
        };
        let held = |most: usize| {
            let weak = self.weak.clone();
            Arc::new(move || if weak.upgrade().is_none_or(|app| app.paused()) { 0 } else { most }) as Arc<dyn Fn() -> usize + Send + Sync>
        };
        self.effects.handle(
            effects::RELAY,
            handler(|app, payload, key| Box::pin(async move { app.relay_queued(payload, key).await })),
            Options { ordered: true, ..Options::default() },
        );
        self.effects.handle(
            effects::NOTICE,
            handler(|app, payload, key| Box::pin(async move { app.notice_queued(payload, key).await })),
            Options { ordered: true, ..Options::default() },
        );
        self.effects.handle(
            effects::ASSESSMENT,
            handler(|app, payload, key| Box::pin(async move { app.assessment_queued(payload, key).await })),
            Options { limit: held(4), ..Options::default() },
        );
        let launches = {
            let weak = self.weak.clone();
            Arc::new(move || weak.upgrade().filter(|app| !app.paused()).map(|app| app.launch_room()).unwrap_or(0)) as Arc<dyn Fn() -> usize + Send + Sync>
        };
        self.effects.handle(
            effects::LAUNCH,
            handler(|app, payload, _| Box::pin(async move { app.launch_queued(payload).await })),
            Options { limit: launches, retry: (5_000, 300_000), ..Options::default() },
        );
        self.effects.handle(
            effects::DELIVERY,
            handler(|app, payload, _| Box::pin(async move { app.deliver_queued(payload).await })),
            Options { limit: held(4), quiet: true, ..Options::default() },
        );
        self.effects.handle(
            effects::SIDECAR,
            handler(|app, payload, _| Box::pin(async move { app.sidecar_queued(payload).await })),
            Options { limit: held(4), ..Options::default() },
        );

        self.sync_blocked();
        let kernel = self.settings().kernel;
        match self.kernels.unavailable(kernel) {
            Some(problem) => self.board.set("kernel", Health::error(problem)),
            None => {
                self.board.set("kernel", Health::ready(format!("Running on {}", kernel.as_str())));
                self.ensure_orchestrator().await?;
            }
        }
        if self.closing() {
            return Ok(());
        }
        self.executor_resume();
        self.passes.start();
        self.effects.start();
        self.watchdog_start();
        self.wechat_start();
        self.board.set("runtime", Health::ready("Ready"));
        self.passes.pump();
        Ok(())
    }

    /// Stop in order: no new passes, every Session ended, running effects finished; waiting ones stay for the next start.
    pub async fn stop(&self) {
        if self.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        self.stopping.send_replace(true);
        self.passes.stop();
        self.watchdog_stop().await;
        self.wechat_stop().await;
        self.stop_all_sessions().await;
        self.effects.drain().await;
        self.board.set("runtime", Health::waiting("Stopped"));
    }
}
