//! Orchestration passes: each kicks the effects that are due and advances the Engine's Evals. A pass runs every two
//! seconds and whenever new work arrives; messages that arrive in a quick burst share one pass.

use crate::effects::Effects;
use crate::health::{Health, HealthBoard};
use neo_core::model::Trigger;
use neo_core::{Engine, ReceiveResult, UserError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

/// How long a burst may hold a pass back, in all.
const BURST_CAP: Duration = Duration::from_millis(4000);
/// How often a pass runs on its own.
const INTERVAL: Duration = Duration::from_millis(2000);

/// How long to wait for more messages after one, so a burst is routed in one turn; zero for none.
pub type BurstDelay = Arc<dyn Fn(&Trigger) -> Duration + Send + Sync>;

#[derive(Default)]
struct Burst {
    /// When the burst's first message arrived.
    since: Option<Instant>,
    /// Grows with every message, so only the latest one's timer fires.
    generation: u64,
}

/// Schedules passes.
pub struct Passes {
    engine: Arc<Engine>,
    effects: Arc<Effects>,
    board: HealthBoard,
    burst_delay: BurstDelay,
    burst: Mutex<Burst>,
    stopped: AtomicBool,
    weak: Weak<Passes>,
}

impl Passes {
    /// Passes over the Engine and the effect queue.
    pub fn new(engine: Arc<Engine>, effects: Arc<Effects>, board: HealthBoard, burst_delay: BurstDelay) -> Arc<Passes> {
        Arc::new_cyclic(|weak| Passes {
            engine,
            effects,
            board,
            burst_delay,
            burst: Mutex::new(Burst::default()),
            stopped: AtomicBool::new(false),
            weak: weak.clone(),
        })
    }

    fn burst(&self) -> std::sync::MutexGuard<'_, Burst> {
        self.burst.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Run a pass every two seconds, unless a burst holds one back.
    pub fn start(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval(INTERVAL);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticks.tick().await;
                let Some(passes) = weak.upgrade() else { return };
                if passes.stopped.load(Ordering::SeqCst) {
                    return;
                }
                if passes.burst().since.is_none() {
                    passes.pump();
                }
            }
        });
    }

    /// Stop running passes.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        *self.burst() = Burst::default();
    }

    /// Take a Source's message in, and run a pass for it: at once, or after its burst settles.
    pub fn receive(&self, trigger: Trigger) -> Result<ReceiveResult, UserError> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err(UserError::invalid("neo-agent is stopping"));
        }
        let delay = (self.burst_delay)(&trigger);
        let result = self.engine.receive(trigger)?;
        if result != ReceiveResult::Stored {
            return Ok(result);
        }
        if delay.is_zero() {
            self.pump();
            return Ok(result);
        }
        let (wait, generation) = {
            let mut burst = self.burst();
            let since = *burst.since.get_or_insert_with(Instant::now);
            burst.generation += 1;
            (delay.min(BURST_CAP.saturating_sub(since.elapsed())), burst.generation)
        };
        if wait.is_zero() {
            self.pump();
            return Ok(result);
        }
        let weak = self.weak.clone();
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            let Some(passes) = weak.upgrade() else { return };
            // A later message of the burst set its own timer.
            if passes.burst().generation == generation && !passes.stopped.load(Ordering::SeqCst) {
                passes.pump();
            }
        });
        Ok(result)
    }

    /// Run one pass now; it ends any burst.
    pub fn pump(&self) {
        {
            let mut burst = self.burst();
            burst.since = None;
            burst.generation += 1;
        }
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        // While processing is paused, the Engine only notes the pause on running Evals so they do not expire.
        let passed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.engine.evaluate_due()));
        match passed {
            Ok(()) => {
                if self.board.get("runtime").is_some_and(|health| health.state == "error") {
                    self.board.set("runtime", Health::ready("Ready"));
                }
            }
            Err(_) => self.board.set("runtime", Health::error("A pass failed")),
        }
        self.effects.kick();
    }

    /// Resolves once no effect that can start now is running, after a pass.
    pub async fn idle(&self) {
        self.pump();
        self.effects.idle(None).await;
    }
}
