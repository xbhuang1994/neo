//! The effect queue's dispatcher: side effects persisted inside command transactions run after commit, per kind, with
//! concurrency limits, exponential backoff and health reporting. Rows survive a restart and run again.

use crate::health::{Health, HealthBoard};
use neo_core::time::now_ms;
use neo_store::effects::EffectRow;
use neo_store::Store;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::sync::Notify;

/// Build an Eval's candidate card and relay it to the main Session; the key is the Eval id.
pub const ASSESSMENT: &str = "assessment";
/// Launch a pending Assignment; the key is the Assignment id.
pub const LAUNCH: &str = "launch";
/// Hand a ticket's waiting Inputs to its running Assignment; the key is the Ticket id.
pub const DELIVERY: &str = "delivery";
/// Steer a report or a candidate into the main Session; the key is the request id.
pub const RELAY: &str = "relay";
/// Inject a notice into the main Session without waking it; the key names what it reports.
pub const NOTICE: &str = "notice";
/// Send a message for a Channel through its Source; the key is the message id.
pub const REPLY: &str = "reply";
/// Run a read-only Sidecar query against a ticket and send its answer; the key is the trigger id.
pub const SIDECAR: &str = "sidecar";

/// Consecutive failures before an effect kind reports an error.
pub const FAILURES_BEFORE_ERROR: i64 = 3;

/// Why an effect did not complete.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    /// It cannot run right now, such as while processing is paused or every worker slot is taken: it runs again
    /// after the initial retry delay, without counting as a failure.
    Later(String),
    /// It failed: it runs again with exponential backoff, and counts.
    Error(String),
}

impl From<String> for Failure {
    fn from(error: String) -> Self {
        Failure::Error(error)
    }
}

/// The future an effect handler returns.
pub type Running = Pin<Box<dyn Future<Output = Result<(), Failure>> + Send>>;
/// Runs one effect, given its payload and key.
pub type Handler = Arc<dyn Fn(Value, String) -> Running + Send + Sync>;

/// How a kind of effect runs.
#[derive(Clone)]
pub struct Options {
    /// How many may run at once now; 0 holds the kind, such as while processing is paused.
    pub limit: Arc<dyn Fn() -> usize + Send + Sync>,
    /// Initial and maximum retry delay, in milliseconds.
    pub retry: (i64, i64),
    /// Effects run one at a time in queue order, and a failed one holds back later rows of the kind.
    pub ordered: bool,
    /// Repeated failures do not mark the kind's health as failing, because they already show elsewhere.
    pub quiet: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { limit: Arc::new(|| 1), retry: (2_000, 60_000), ordered: false, quiet: false }
    }
}

struct Kind {
    run: Handler,
    options: Options,
}

/// The clock, in epoch milliseconds.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Durable queue of side effects, dispatched after commit.
pub struct Effects {
    store: Arc<Store>,
    board: HealthBoard,
    now: Clock,
    kinds: Mutex<BTreeMap<String, Arc<Kind>>>,
    seq: AtomicI64,
    wake_gen: AtomicU64,
    /// The kind and key of every effect that runs now.
    running: Mutex<Vec<(String, String)>>,
    started: AtomicBool,
    stopped: AtomicBool,
    /// Wakes the dispatcher.
    work: Notify,
    /// Signals that an effect finished.
    pub(crate) finished: Notify,
    weak: Weak<Effects>,
}

fn health_name(kind: &str) -> String {
    format!("effects:{kind}")
}

impl Effects {
    /// A queue over the store, with the system clock.
    pub fn new(store: Arc<Store>, board: HealthBoard) -> Arc<Effects> {
        Effects::with_clock(store, board, Arc::new(now_ms))
    }

    /// A queue over the store, with a clock a test controls.
    pub fn with_clock(store: Arc<Store>, board: HealthBoard, now: Clock) -> Arc<Effects> {
        let seq = AtomicI64::new(store.effect_max_seq());
        Arc::new_cyclic(|weak| Effects {
            store,
            board,
            now,
            kinds: Mutex::new(BTreeMap::new()),
            seq,
            wake_gen: AtomicU64::new(0),
            running: Mutex::new(Vec::new()),
            started: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            work: Notify::new(),
            finished: Notify::new(),
            weak: weak.clone(),
        })
    }

    pub(crate) fn running(&self) -> std::sync::MutexGuard<'_, Vec<(String, String)>> {
        self.running.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn kinds(&self) -> Vec<(String, Arc<Kind>)> {
        self.kinds.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).iter().map(|(name, kind)| (name.clone(), kind.clone())).collect()
    }

    /// Upsert an effect in the caller's transaction, coalescing with a waiting row of the same kind and key, which
    /// keeps its place in the queue. It runs once the transaction commits.
    pub fn enqueue(&self, kind: &str, key: &str, payload: &impl Serialize) {
        let payload = serde_json::to_string(payload).expect("effect payloads serialize");
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.store.effect_enqueue(kind, key, &payload, seq, (self.now)());
        let weak = self.weak.clone();
        self.store.after_commit(move || {
            if let Some(effects) = weak.upgrade() {
                effects.kick();
            }
        });
    }

    /// Register the handler of a kind.
    ///
    /// # Panics
    /// When the kind already has a handler.
    pub fn handle(&self, kind: &str, run: Handler, mut options: Options) {
        if options.ordered {
            let limit = options.limit.clone();
            options.limit = Arc::new(move || limit().min(1));
        }
        let before = self.kinds.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(kind.to_string(), Arc::new(Kind { run, options }));
        assert!(before.is_none(), "The {kind} effects already have a handler");
        self.report(kind);
        self.kick();
    }

    /// Whether an effect of `kind` waits, or the one with `key`.
    pub fn pending(&self, kind: &str, key: Option<&str>) -> bool {
        self.store.effect_pending(kind, key)
    }

    /// Drop a queued effect; one that already runs finishes normally.
    pub fn cancel(&self, kind: &str, key: &str) {
        self.store.effect_cancel(kind, key);
        let (weak, kind) = (self.weak.clone(), kind.to_string());
        self.store.after_commit(move || {
            if let Some(effects) = weak.upgrade() {
                effects.report(&kind);
            }
        });
    }

    /// Start running effects; rows queued before wait until now. Spawns the dispatcher on the current runtime.
    pub fn start(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(effects) = weak.upgrade() else { return };
                if effects.stopped.load(Ordering::SeqCst) {
                    return;
                }
                let wake = effects.work.notified();
                tokio::pin!(wake);
                // Register before looking, so a kick during dispatch is not missed.
                wake.as_mut().enable();
                effects.dispatch();
                match effects.store.effect_next_due() {
                    None => wake.await,
                    Some(due) => {
                        let wait_ms = (due - (effects.now)()).clamp(10, 500) as u64;
                        let _ = tokio::time::timeout(Duration::from_millis(wait_ms), wake).await;
                    }
                }
            }
        });
    }

    /// Pull unfailed waiting effects of `kind` forward to now and wake the dispatcher.
    pub fn wake_kind(&self, kind: &str) {
        self.wake_gen.fetch_add(1, Ordering::SeqCst);
        self.store.effect_wake_kind(kind, (self.now)());
        self.kick();
    }

    /// Run whatever is due as soon as possible.
    pub fn kick(&self) {
        self.work.notify_one();
    }

    /// Resolves once no effect of `kind` (or of any kind) runs and none can start: none is due, or its kind has no room.
    pub async fn idle(&self, kind: Option<&str>) {
        loop {
            let finished = self.finished.notified();
            tokio::pin!(finished);
            // Register before looking, so an effect that ends in between is not missed.
            finished.as_mut().enable();
            self.dispatch();
            if !self.running().iter().any(|(running, _)| kind.is_none_or(|kind| kind == running)) {
                return;
            }
            finished.await;
        }
    }

    /// Stop starting effects and wait for the running ones; waiting rows stay for the next start.
    pub async fn drain(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.work.notify_one();
        loop {
            let finished = self.finished.notified();
            tokio::pin!(finished);
            finished.as_mut().enable();
            if self.running().is_empty() {
                return;
            }
            finished.await;
        }
    }

    pub(crate) fn dispatch(&self) {
        if !self.started.load(Ordering::SeqCst) || self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let Some(this) = self.weak.upgrade() else { return };
        for (name, kind) in self.kinds() {
            let now = (self.now)();
            let running: Vec<String> = self.running().iter().filter(|(running, _)| *running == name).map(|(_, key)| key.clone()).collect();
            // An ordered kind waits behind its oldest row even when it is not due yet.
            let rows: Vec<EffectRow> = if kind.options.ordered {
                if running.is_empty() {
                    self.store.effect_head(&name).into_iter().filter(|row| row.due <= now).collect()
                } else {
                    Vec::new()
                }
            } else {
                self.store.effect_due(&name, now, 16 + running.len() as i64).into_iter().filter(|row| !running.contains(&row.key)).collect()
            };
            if rows.is_empty() {
                continue;
            }
            // The limit is asked only once something is ready to run.
            let room = (kind.options.limit)().saturating_sub(running.len());
            for row in rows.into_iter().take(room) {
                self.running().push((name.clone(), row.key.clone()));
                let (this, name, kind) = (this.clone(), name.clone(), kind.clone());
                tokio::spawn(async move {
                    this.attempt(&name, &kind, &row).await;
                    this.running().retain(|(running, key)| !(*running == name && *key == row.key));
                    this.finished.notify_waiters();
                    this.kick();
                });
            }
        }
    }

    async fn attempt(&self, name: &str, kind: &Kind, row: &EffectRow) {
        let wake_gen = self.wake_gen.load(Ordering::SeqCst);
        let payload = serde_json::from_str(&row.value).unwrap_or(Value::Null);
        // A handler that panics counts as a failure rather than leaving its row running forever.
        let outcome = match tokio::spawn((kind.run)(payload, row.key.clone())).await {
            Ok(outcome) => outcome,
            Err(error) => Err(Failure::Error(format!("The handler stopped unexpectedly: {error}"))),
        };
        match outcome {
            Ok(()) => self.store.effect_done(name, row),
            // Left untouched on shutdown, so it runs again on the next start.
            Err(_) if self.stopped.load(Ordering::SeqCst) => return,
            Err(Failure::Later(_)) => {
                let due = if self.wake_gen.load(Ordering::SeqCst) != wake_gen { (self.now)() } else { (self.now)() + kind.options.retry.0 };
                self.store.effect_later(name, row, due);
            }
            Err(Failure::Error(error)) => {
                let (initial, most) = kind.options.retry;
                let delay = most.min(initial.saturating_mul(1 << row.attempts.clamp(0, 16)));
                self.store.effect_failed(name, row, &error, (self.now)() + delay);
                if name == REPLY && row.attempts + 1 == FAILURES_BEFORE_ERROR {
                    self.wake_kind(name);
                }
            }
        }
        self.report(name);
    }

    fn report(&self, kind: &str) {
        let summary = self.store.effect_summary(kind);
        let quiet = self.kinds.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(kind).is_some_and(|kind| kind.options.quiet);
        let detail = match (&summary.since, summary.waiting) {
            (Some(since), waiting) if waiting > 0 => format!("{waiting} waiting since {since}"),
            _ => "Nothing waiting".to_string(),
        };
        let health = if summary.attempts >= FAILURES_BEFORE_ERROR && !quiet {
            Health::error(format!("{detail}; the last failure: {}", summary.error.unwrap_or_default()))
        } else {
            Health::ready(detail)
        };
        self.board.set(&health_name(kind), health);
    }
}
