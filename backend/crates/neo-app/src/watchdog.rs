//! The Watchdog: a periodic control loop beside the work. It filters healthy long-running work without a model call,
//! by process CPU time and workspace file changes; puts back a launch, delivery or reply the queues lost; and asks a
//! one-off Session about a ticket only when it has stalled, sits idle with nothing to wake it, failed in a way that
//! may pass, or still has not been answered.

use crate::app::App;
use crate::cards::{assignment_line, card_state, input_line, newest_page, ticket_card};
use crate::effects;
use crate::executor::WorkerJob;
use crate::health::Health;
use crate::kernels::SessionRole;
use crate::notices::{report_relay, result_relay, state_name, Relay};
use crate::procinfo::{self, ProcessSnapshot};
use crate::sessions::{worker_session_id, OnceTools};
use crate::text::clip;
use crate::tools::Args;
use neo_core::assignments::{Question, WorkerReport};
use neo_core::ids::key;
use neo_core::model::{AssignmentState, ReportState, Ticket, TicketOutcome};
use neo_core::ports::Repositories;
use neo_core::stage::{can_retry, ticket_stage, TicketStage};
use neo_core::time::{now_ms, parse_iso};
use neo_kernel::journal::Entry;
use neo_kernel::types::{Block, Role, ToolSpec};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How often the Watchdog looks, and how long it waits before it asks.
#[derive(Clone, Copy, Debug)]
pub struct WatchdogTimings {
    /// Between two passes.
    pub interval: Duration,
    /// How long a working ticket shows neither output nor CPU time before it is inspected.
    pub stall: Duration,
    /// How long a working ticket may use CPU time without any output before it is inspected.
    pub cpu_only_silence: Duration,
    /// Between two inspections of the same working ticket.
    pub long_task: Duration,
    /// How long a ticket is idle before it is inspected.
    pub idle_grace: Duration,
    /// Between two inspections of a ticket that stays idle.
    pub idle_recheck: Duration,
    /// How long after a report its reply may be missing before the main Session is reminded.
    pub unreplied_grace: Duration,
    /// The most one inspection turn takes.
    pub turn_timeout: Duration,
}

impl Default for WatchdogTimings {
    fn default() -> Self {
        WatchdogTimings {
            interval: Duration::from_secs(3 * 60),
            stall: Duration::from_secs(6 * 60),
            cpu_only_silence: Duration::from_secs(30 * 60),
            long_task: Duration::from_secs(10 * 60),
            idle_grace: Duration::from_secs(60),
            idle_recheck: Duration::from_secs(3 * 60),
            unreplied_grace: Duration::from_secs(60),
            turn_timeout: Duration::from_secs(2 * 60),
        }
    }
}

fn ms(duration: Duration) -> i64 {
    duration.as_millis() as i64
}

const MAX_AUTO_RETRIES: u32 = 2;
const MAX_AUTO_INTERRUPTS: u32 = 2;
const MAX_RELAY_NUDGES: u32 = 2;
const MAX_MANUAL_RELAY_NUDGES: u32 = 2;
const RECENT_WINDOW_MS: i64 = 24 * 60 * 60_000;
const WATCHDOG_HISTORY_KEY: &str = "watchdog-history";
const MAX_WATCHDOG_HISTORY: usize = 100;
const IGNORED_DIRS: &[&str] = &[".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", "target"];
const MAX_FILES: usize = 200;
const MAX_DEPTH: usize = 2;

/// A workspace file, in a patrol.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct FileInfo {
    path: String,
    bytes: u64,
    age_seconds: i64,
}

/// The newest log's last lines.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct LogTail {
    file: String,
    tail: String,
}

#[derive(Clone, Debug, Default)]
struct Scan {
    recent: Vec<FileInfo>,
    latest_mtime: i64,
    total_bytes: u64,
    count: usize,
    log_tail: Option<LogTail>,
}

/// The last `max_lines` lines within the last `max_bytes` bytes of a file; nothing for an empty or unreadable one.
fn read_tail(path: &Path, max_bytes: u64, max_lines: usize) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok().filter(|info| info.is_file())?.len();
    if size == 0 {
        return None;
    }
    let length = size.min(max_bytes);
    file.seek(SeekFrom::Start(size - length)).ok()?;
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.trim_end().split('\n').collect();
    let tail = lines[lines.len().saturating_sub(max_lines)..].join("\n").trim().to_string();
    (!tail.is_empty()).then_some(tail)
}

fn has_extension(path: &str, extensions: &[&str]) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extensions.iter().any(|known| extension.eq_ignore_ascii_case(known)))
}

/// The files of a ticket's directory, two levels deep and 200 at most, without hidden entries and dependency folders.
fn scan_workspace(directory: Option<&Path>, now: i64) -> Scan {
    let Some(directory) = directory.filter(|directory| directory.is_dir()) else { return Scan::default() };
    struct Found {
        relative: String,
        full: PathBuf,
        bytes: u64,
        mtime: i64,
    }
    fn walk(root: &Path, dir: &Path, depth: usize, found: &mut Vec<Found>) {
        if depth > MAX_DEPTH || found.len() >= MAX_FILES {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if found.len() >= MAX_FILES {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            let full = entry.path();
            if kind.is_dir() {
                walk(root, &full, depth + 1, found);
            } else if kind.is_file() {
                let Ok(info) = entry.metadata() else { continue };
                let mtime =
                    info.modified().ok().and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok()).map(|since| since.as_millis() as i64).unwrap_or(0);
                let relative = full
                    .strip_prefix(root)
                    .unwrap_or(&full)
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join("/");
                found.push(Found { relative, full, bytes: info.len(), mtime });
            }
        }
    }
    let mut found = Vec::new();
    walk(directory, directory, 0, &mut found);
    found.sort_by_key(|item| std::cmp::Reverse(item.mtime));
    let log = found
        .iter()
        .find(|item| item.bytes > 0 && has_extension(&item.relative, &["log", "out", "err", "txt"]))
        .or_else(|| found.iter().find(|item| item.bytes > 0 && has_extension(&item.relative, &["md", "csv", "json"])));
    Scan {
        recent: found
            .iter()
            .take(8)
            .map(|item| FileInfo { path: item.relative.clone(), bytes: item.bytes, age_seconds: ((now - item.mtime) / 1000).max(0) })
            .collect(),
        latest_mtime: found.first().map(|item| item.mtime).unwrap_or(0),
        total_bytes: found.iter().map(|item| item.bytes).sum(),
        count: found.len(),
        log_tail: log.and_then(|item| read_tail(&item.full, 4096, 25).map(|tail| LogTail { file: item.relative.clone(), tail })),
    }
}

/// One persisted Watchdog audit record in SQLite `kv["watchdog-history"]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct WatchdogEvent {
    at: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ticket_id: Option<String>,
    detail: String,
}

/// What one look at a ticket found.
#[derive(Clone, Debug, Default)]
struct Sample {
    processes: Vec<ProcessSnapshot>,
    process_count: usize,
    cpu: u64,
    recent: Vec<FileInfo>,
    latest_mtime: i64,
    latest_transcript_at: i64,
    /// Changes whenever the ticket, its transcript, its files or its jobs' output do.
    signature: String,
    log_tail: Option<LogTail>,
}

/// What the Watchdog remembers of a ticket between passes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Activity {
    signature: String,
    last_output_at: i64,
    cpu: u64,
    patrolled_at: Option<i64>,
    patrolled_signature: Option<String>,
    note: Option<String>,
}

/// How a ticket moved since the last pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Delta {
    output_changed: bool,
    cpu_delta: u64,
    silent_ms: i64,
}

impl Delta {
    const NONE: Delta = Delta { output_changed: false, cpu_delta: 0, silent_ms: 0 };
    fn json(&self) -> Value {
        json!({"output_changed": self.output_changed, "cpu_ticks_delta": self.cpu_delta, "output_silent_seconds": self.silent_ms / 1000})
    }
}

fn carried(previous: Option<&Activity>, sample: &Sample, last_output_at: i64) -> Activity {
    Activity {
        signature: sample.signature.clone(),
        last_output_at,
        cpu: sample.cpu,
        patrolled_at: previous.and_then(|previous| previous.patrolled_at),
        patrolled_signature: previous.and_then(|previous| previous.patrolled_signature.clone()),
        note: previous.and_then(|previous| previous.note.clone()),
    }
}

/// Judge a ticket whose worker is at work: what to remember, and how it moved when it should be inspected. Output
/// that changed, CPU time used within the silence allowed, a short silence, and a recent inspection all pass it.
fn judge_working(previous: Option<&Activity>, sample: &Sample, started: i64, now: i64, timings: &WatchdogTimings) -> (Activity, Option<Delta>) {
    let output_changed = previous.is_some_and(|previous| previous.signature != sample.signature);
    let cpu_delta = previous.map(|previous| sample.cpu.saturating_sub(previous.cpu)).unwrap_or(0);
    let last_output_at = if output_changed {
        now
    } else {
        previous.map(|previous| previous.last_output_at).unwrap_or(started.max(sample.latest_mtime).max(sample.latest_transcript_at))
    };
    let silent_ms = (now - last_output_at).max(0);
    let mut state = carried(previous, sample, last_output_at);
    let passes = output_changed
        || (cpu_delta > 0 && silent_ms < ms(timings.cpu_only_silence))
        || silent_ms < ms(timings.stall)
        || now - state.patrolled_at.unwrap_or(0) < ms(timings.long_task);
    if passes {
        return (state, None);
    }
    state.patrolled_at = Some(now);
    state.patrolled_signature = Some(sample.signature.clone());
    (state, Some(Delta { output_changed: false, cpu_delta, silent_ms }))
}

/// Judge a ticket that is idle since `since`. A process of its directory that makes progress passes it; else it is
/// inspected after the grace, and again at the recheck interval, or the longer one while nothing at all has changed.
fn judge_idle(previous: Option<&Activity>, sample: &Sample, since: i64, now: i64, timings: &WatchdogTimings) -> (Activity, Option<Delta>) {
    let output_changed = previous.is_some_and(|previous| previous.signature != sample.signature);
    let cpu_delta = previous.map(|previous| sample.cpu.saturating_sub(previous.cpu)).unwrap_or(0);
    let last_output_at = if output_changed {
        now
    } else {
        previous.map(|previous| previous.last_output_at).unwrap_or(if sample.latest_mtime > 0 { sample.latest_mtime } else { since })
    };
    let mut state = carried(previous, sample, last_output_at);
    if sample.process_count > 0 && (output_changed || (cpu_delta > 0 && now - last_output_at < ms(timings.cpu_only_silence))) {
        return (state, None);
    }
    let unchanged = state.patrolled_signature.as_deref() == Some(sample.signature.as_str()) && sample.process_count == 0;
    let cooldown = if unchanged { timings.long_task } else { timings.idle_recheck };
    if now - since < ms(timings.idle_grace) || now - state.patrolled_at.unwrap_or(0) < ms(cooldown) {
        return (state, None);
    }
    state.patrolled_at = Some(now);
    state.patrolled_signature = Some(sample.signature.clone());
    (state, Some(Delta { output_changed, cpu_delta, silent_ms: (now - last_output_at).max(0) }))
}

/// What a transcript entry says, in at most 500 characters: its text, and each tool call by name and arguments.
fn excerpt(entry: &Entry) -> (&'static str, String) {
    let (role, content) = match entry {
        Entry::Message { message, .. } => (if message.role == Role::Assistant { "assistant" } else { "toolResult" }, &message.content),
        Entry::CustomMessage { content, .. } => ("custom", content),
    };
    let parts: Vec<String> = content
        .iter()
        .filter_map(|block| match block {
            Block::Text { text } => Some(text.clone()),
            Block::ToolCall { name, arguments, .. } => Some(format!("[tool:{name}] {}", clip(&arguments.to_string(), 240))),
            Block::Image { .. } => None,
        })
        .collect();
    (role, clip(&parts.join("\n"), 500))
}

#[derive(Default)]
struct Memory {
    activity: HashMap<String, Activity>,
    failure_seen: HashMap<String, String>,
    health_seen: HashMap<String, String>,
    relay_nudges: HashMap<String, u32>,
    manual_relay_nudges: HashMap<String, (u32, i64)>,
    auto_retries: HashMap<String, u32>,
    auto_interrupts: HashMap<String, u32>,
    seq: u64,
}

/// Suspects and patrol markers gathered before calling the Watchdog Session; markers are committed only once the
/// inspection turn succeeds so a transient Watchdog error never permanently swallows a stalled or failed ticket.
#[derive(Default)]
struct PatrolBatch {
    suspects: Vec<Value>,
    health_errors: Vec<Value>,
    patrolled_activity: Vec<(String, String)>,
    patrolled_failures: Vec<(String, String)>,
    patrolled_health: Vec<(String, String)>,
    patrolled_relays: Vec<String>,
}

/// The Watchdog's state within the application.
pub struct WatchdogState {
    timings: WatchdogTimings,
    memory: Mutex<Memory>,
    /// Held by the pass that runs.
    active: tokio::sync::Mutex<()>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl WatchdogState {
    pub(crate) fn new(timings: WatchdogTimings) -> WatchdogState {
        WatchdogState { timings, memory: Mutex::default(), active: tokio::sync::Mutex::new(()), task: Mutex::new(None) }
    }
    fn memory(&self) -> std::sync::MutexGuard<'_, Memory> {
        self.memory.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The Watchdog Session's tools.
pub fn watchdog_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "watchdog_inspect".into(),
            description: "Inspect a ticket's inputs, assignments and a longer transcript, only when the evidence inlined in the patrol is not enough.".into(),
            schema: json!({"type": "object", "additionalProperties": false, "required": ["ticket_id"], "properties": {"ticket_id": {"type": "string"}}}),
        },
        ToolSpec {
            name: "watchdog_intervene".into(),
            description: "Intervene on a verified anomaly: wake a stranded worker, cancel one hung or off-track background job and wake its worker, interrupt a hung working turn/subprocesses and resume the worker, retry a ticket that failed transiently, or relay a report again whose reply is missing.".into(),
            schema: json!({"type": "object", "additionalProperties": false, "required": ["action", "ticket_id", "message"], "properties": {
                "action": {"type": "string", "enum": ["wake_worker", "cancel_job", "interrupt_worker", "retry_ticket", "relay_report"]},
                "ticket_id": {"type": "string"},
                "job_id": {"type": "string", "description": "cancel_job: the background job's id."},
                "message": {"type": "string", "maxLength": 1000, "description": "The finding or the recovery instruction, short and factual."}}}),
        },
    ]
}

impl App {
    fn watchdog_health(&self, health: Health) {
        self.board.set("watchdog", health);
    }

    /// Log a Watchdog action or error to stderr and persist a bounded audit ring in `kv["watchdog-history"]`.
    fn record_watchdog_event(&self, kind: &str, ticket_id: Option<&str>, detail: &str) {
        let short = clip(detail, 320);
        match ticket_id {
            Some(tid) => eprintln!("[neo-agent] [watchdog] {kind} ticket={tid}: {short}"),
            None => eprintln!("[neo-agent] [watchdog] {kind}: {short}"),
        }
        let mut history: Vec<WatchdogEvent> = self.store.get(WATCHDOG_HISTORY_KEY).unwrap_or_default();
        history.push(WatchdogEvent { at: neo_core::time::now_iso(), kind: kind.to_string(), ticket_id: ticket_id.map(str::to_string), detail: short });
        if history.len() > MAX_WATCHDOG_HISTORY {
            let drain = history.len() - MAX_WATCHDOG_HISTORY;
            history.drain(..drain);
        }
        self.store.set(WATCHDOG_HISTORY_KEY, &history);
    }

    /// Start the periodic passes.
    pub(crate) fn watchdog_start(self: &Arc<Self>) {
        let mut task = self.watchdog.task.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if task.is_some() || self.closing() {
            return;
        }
        self.watchdog_health(Health::ready("Watchdog control loop is ready"));
        let (weak, interval, mut stopping) = (self.weak.clone(), self.watchdog.timings.interval, self.stopping.subscribe());
        *task = Some(self.rt.spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {}
                    _ = stopping.wait_for(|stopping| *stopping) => return,
                }
                let Some(app) = weak.upgrade() else { return };
                app.watchdog_tick().await;
            }
        }));
    }

    /// Stop the periodic passes, after the one that runs.
    pub(crate) async fn watchdog_stop(&self) {
        let task = self.watchdog.task.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(task) = task {
            let _ = task.await;
        }
        let _ = self.watchdog.active.lock().await;
    }

    /// Run one Watchdog pass; a caller that finds one running waits for that one instead.
    pub async fn watchdog_tick(self: &Arc<Self>) {
        if self.closing() || self.paused() {
            return;
        }
        let Ok(_running) = self.watchdog.active.try_lock() else {
            let _ = self.watchdog.active.lock().await;
            return;
        };
        if let Err(error) = self.watchdog_patrol().await {
            if !self.closing() {
                self.watchdog_health(Health::error(format!("Watchdog patrol failed: {error}")));
                self.record_watchdog_event("patrol_error", None, &error);
            }
        }
    }

    async fn watchdog_patrol(self: &Arc<Self>) -> Result<(), String> {
        let now = now_ms();
        self.heal_queues();
        let lingering = self.heal_unreplied(now);
        if self.closing() || self.paused() {
            return Ok(());
        }
        let batch = self.collect_suspects(now, &lingering).await;
        if batch.suspects.is_empty() && batch.health_errors.is_empty() {
            self.watchdog_health(Health::ready("All active tickets and queues are healthy"));
            return Ok(());
        }
        if let Some(problem) = self.kernels.unavailable(self.settings().kernel) {
            return Err(format!("Watchdog kernel unavailable: {problem}"));
        }
        let mut patrol = json!({"kind": "watchdog_patrol", "at": neo_core::time::format_iso(now), "suspects": batch.suspects});
        if !batch.health_errors.is_empty() {
            patrol["health_errors"] = batch.health_errors.clone().into();
        }
        let summary_labels: Vec<String> = batch
            .suspects
            .iter()
            .map(|s| format!("{}:{}", s["kind"].as_str().unwrap_or("?"), s["ticket_id"].as_str().unwrap_or("?").chars().take(8).collect::<String>()))
            .collect();
        eprintln!(
            "[neo-agent] [watchdog] patrolling {} suspect(s) [{}], {} health error(s)",
            batch.suspects.len(),
            summary_labels.join(", "),
            batch.health_errors.len()
        );
        let weak = self.weak.clone();
        let tools = OnceTools {
            specs: watchdog_specs(),
            call: Box::new(move |name, arguments| {
                let weak = weak.clone();
                Box::pin(async move {
                    let app = weak.upgrade().ok_or("neo-agent is stopping")?;
                    match name.as_str() {
                        "watchdog_inspect" => app.watchdog_inspect(Args::of(arguments, &["ticket_id"])?.required("ticket_id")?).await,
                        "watchdog_intervene" => app.watchdog_intervene(arguments).await,
                        _ => Err(format!("Unknown tool {name}")),
                    }
                })
            }),
        };
        let prompt = crate::prompts::watchdog_system(&self.settings());
        let note = self.run_once(SessionRole::Watchdog, &self.machine.state_dir, prompt, patrol.to_string(), tools, self.watchdog.timings.turn_timeout).await?;
        {
            let mut memory = self.watchdog.memory();
            for (ticket_id, sig) in batch.patrolled_activity {
                let state = memory.activity.entry(ticket_id).or_default();
                state.patrolled_at = Some(now);
                state.patrolled_signature = Some(sig);
            }
            for (ticket_id, updated_at) in batch.patrolled_failures {
                memory.failure_seen.insert(ticket_id, updated_at);
            }
            for (component, marker) in batch.patrolled_health {
                memory.health_seen.insert(component, marker);
            }
            for missing_key in batch.patrolled_relays {
                let entry = memory.manual_relay_nudges.entry(missing_key).or_insert((0, 0));
                entry.0 += 1;
                entry.1 = now;
            }
            if !note.is_empty() {
                for suspect in &batch.suspects {
                    if let Some(state) = suspect["ticket_id"].as_str().and_then(|id| memory.activity.get_mut(id)) {
                        state.note = Some(clip(&note, 200));
                    }
                }
            }
        }
        self.record_watchdog_event(
            "patrol",
            None,
            &format!(
                "inspected {} suspect(s) [{}], {} health error(s): {}",
                batch.suspects.len(),
                summary_labels.join(", "),
                batch.health_errors.len(),
                clip(&note, 160)
            ),
        );
        self.watchdog_health(Health::ready(format!("Inspected {} suspect ticket(s)", batch.suspects.len())));
        Ok(())
    }

    /// Queue again a launch that is pending or a delivery that is due, when its effect is gone.
    fn heal_queues(&self) {
        let mut changed = false;
        for ticket in self.store.open_tickets() {
            if ticket.waits_for_person() {
                continue;
            }
            if ticket.running().is_some() {
                if !ticket.undelivered.is_empty() && !self.effects.pending(effects::DELIVERY, Some(&ticket.id)) {
                    self.effects.enqueue(effects::DELIVERY, &ticket.id, &json!({"ticketId": ticket.id}));
                    self.record_watchdog_event("heal_queue", Some(&ticket.id), "re-enqueued missing delivery effect");
                    changed = true;
                }
            } else if let Some(latest) = ticket.latest().filter(|latest| latest.state == AssignmentState::Pending) {
                if !self.effects.pending(effects::LAUNCH, Some(&latest.id)) {
                    self.effects.enqueue(effects::LAUNCH, &latest.id, &json!({"ticketId": ticket.id, "assignmentId": latest.id}));
                    self.record_watchdog_event("heal_queue", Some(&ticket.id), &format!("re-enqueued missing launch effect for assignment {}", latest.id));
                    changed = true;
                }
            }
        }
        if changed {
            self.passes.pump();
        }
    }

    /// Remind the main Session of each report, question or answer a person has not been sent, twice at most; the
    /// tickets still unanswered after that go to an inspection (bounded by [`MAX_MANUAL_RELAY_NUDGES`]).
    fn heal_unreplied(&self, now: i64) -> Vec<(Ticket, String)> {
        if self.effects.pending(effects::RELAY, None) || self.session(&self.master_id).is_some_and(|main| main.session.is_streaming()) {
            return Vec::new();
        }
        let mut lingering = Vec::new();
        let mut nudged = false;
        for ticket in self.store.recent_tickets(50) {
            let Some(missing) = self.missing_reply(&ticket, now) else { continue };
            let count = {
                let mut memory = self.watchdog.memory();
                let count = memory.relay_nudges.entry(missing.clone()).or_insert(0);
                (*count < MAX_RELAY_NUDGES).then(|| {
                    *count += 1;
                    *count
                })
            };
            match count {
                Some(attempt) => {
                    if self.relay_missing(&ticket, &format!("auto:{attempt}")) {
                        self.record_watchdog_event("auto_relay", Some(&ticket.id), &format!("auto:{attempt} ({missing})"));
                        nudged = true;
                    }
                }
                None => lingering.push((ticket, missing)),
            }
        }
        if nudged {
            self.passes.pump();
        }
        lingering
    }

    /// What a person is still owed for a ticket, as a key that is new for each thing owed.
    fn missing_reply(&self, ticket: &Ticket, now: i64) -> Option<String> {
        let grace = ms(self.watchdog.timings.unreplied_grace);
        if let Some(attention) = ticket.attention.as_ref().filter(|_| ticket.live()) {
            if now - parse_iso(&ticket.updated_at).unwrap_or(now) < grace || self.store.reply_status(&key(&["attention-reply", &attention.id])).is_some() {
                return None;
            }
            return Some(format!("attention:{}:{}", ticket.id, attention.id));
        }
        let report = ticket.latest_report()?;
        // Routine progress and waiting reports never owe a human reply (open attention questions are checked above).
        if matches!(report.state, ReportState::Progress | ReportState::Waiting) {
            return None;
        }
        let age = now - parse_iso(&report.at)?;
        if age < grace || age > RECENT_WINDOW_MS {
            return None;
        }
        let replied = self.store.replied_since(&ticket.id, &report.at);
        if let Some(answer) = self.pending_answer(ticket).filter(|_| !replied) {
            return Some(format!("answer:{}:{}:{answer}", ticket.id, report.at));
        }
        let origin = self.store.trigger(&ticket.origin.trigger_id)?;
        if !origin.human || origin.channel.is_none() {
            return None;
        }
        let ready = match &ticket.ended {
            Some(ended) => ended.outcome == TicketOutcome::Completed,
            None => ticket.running().and_then(|running| running.report.as_ref()).is_some_and(|report| report.state == ReportState::Ready),
        };
        (ready && !replied).then(|| format!("result:{}:{}", ticket.id, report.at))
    }

    /// The first pending answer trigger not already satisfied by a reply on an earlier ended assignment.
    /// For a dropped report, only considers triggers delivered to the latest assignment so stale entries from an
    /// earlier assignment do not loop relays on a handback drop.
    fn pending_answer<'a>(&self, ticket: &'a Ticket) -> Option<&'a str> {
        let latest_id = ticket.latest().map(|assignment| assignment.id.as_str());
        let dropped = ticket.latest_report().is_some_and(|report| report.state == ReportState::Dropped);
        ticket.answers.iter().map(String::as_str).find(|id| {
            let input = ticket.inputs.iter().find(|input| input.trigger_id() == Some(*id));
            if dropped {
                let delivered_here = matches!(
                    input,
                    Some(neo_core::model::TicketInput::Trigger { delivered_to: Some(assignment_id), .. }) if Some(assignment_id.as_str()) == latest_id
                ) || (input.is_none() && ticket.origin.trigger_id == *id && ticket.assignments.len() == 1);
                if !delivered_here {
                    return false;
                }
            }
            let earlier_replied = input
                .and_then(|input| match input {
                    neo_core::model::TicketInput::Trigger { delivered_to: Some(assignment_id), .. } => {
                        ticket.assignments.iter().find(|assignment| assignment.id == *assignment_id && assignment.state == AssignmentState::Ended)
                    }
                    _ => None,
                })
                .and_then(|ended| ended.report.as_ref())
                .is_some_and(|prior| self.store.replied_since(&ticket.id, &prior.at));
            !earlier_replied
        })
    }

    /// Relay a ticket's open question or latest report to the main Session again, under a request id of its own.
    fn relay_missing(&self, ticket: &Ticket, tag: &str) -> bool {
        let report = ticket.latest_report();
        let relay = if let Some(attention) = ticket.attention.as_ref().filter(|_| ticket.live()) {
            let mut asked = WorkerReport::new(
                report.map(|report| report.state).unwrap_or(ReportState::Progress),
                report.map(|report| report.summary.as_str()).unwrap_or(""),
            );
            asked.question = Question::Ask(attention.question.clone());
            report_relay(ticket, &asked)
        } else {
            report.map(|report| {
                let answer_to = self.pending_answer(ticket).filter(|_| !self.store.replied_since(&ticket.id, &report.at));
                let state =
                    if ticket.ended.as_ref().is_some_and(|ended| ended.outcome == TicketOutcome::Completed) { "ready" } else { state_name(report.state) };
                result_relay(ticket, state, &report.summary, answer_to)
            })
        };
        let Some(relay) = relay else { return false };
        self.relay(Relay { id: format!("watchdog:{}:{tag}", relay.id), text: relay.text });
        true
    }

    fn recent_transcript(&self, ticket_id: &str, count: usize) -> Vec<Value> {
        let (start_index, entries) = match self.session(&worker_session_id(ticket_id)) {
            Some(loaded) => loaded.session.journal().entries_tail(count * 3),
            None => (0, self.worker_transcript(ticket_id)),
        };
        let lines: Vec<Value> = entries
            .iter()
            .enumerate()
            .filter_map(|(offset, entry)| {
                let (role, text) = excerpt(entry);
                (!text.is_empty()).then(|| json!({"index": start_index + offset, "role": role, "at": entry.timestamp(), "text": text}))
            })
            .collect();
        lines[lines.len().saturating_sub(count)..].to_vec()
    }

    fn transcript_activity(&self, ticket_id: &str) -> (String, i64) {
        let (start_index, entries) = match self.session(&worker_session_id(ticket_id)) {
            Some(loaded) => loaded.session.journal().entries_tail(1),
            None => {
                let all = self.worker_transcript(ticket_id);
                let len = all.len();
                (len.saturating_sub(1), all.into_iter().rev().take(1).collect())
            }
        };
        let Some(last) = entries.last() else {
            return (String::new(), 0);
        };
        let index = start_index + entries.len().saturating_sub(1);
        let ts = last.timestamp();
        (format!("{index}:{ts}"), parse_iso(ts).unwrap_or(0))
    }

    /// Look at a ticket's workload processes and files, excluding the worker runtime process itself (`driver_pid`) so an
    /// idle or stuck CLI process never masquerades as active computation or a detached job, while still seeing child
    /// processes spawned by the worker even when they run in another working directory.
    async fn sample(&self, ticket: &Ticket, jobs: &[WorkerJob], now: i64) -> Sample {
        let directory = ticket.execution.as_ref().map(|execution| PathBuf::from(&execution.directory));
        let driver_pid = self.session(&worker_session_id(&ticket.id)).and_then(|loaded| loaded.session.driver().pid());
        let (transcript_sig, latest_transcript_at) = self.transcript_activity(&ticket.id);
        let mut roots: Vec<u32> = jobs.iter().flat_map(|job| job.pids.iter().copied()).collect();
        let pipes: Vec<String> = jobs
            .iter()
            .map(|job| {
                let progress = job.progress.as_deref().unwrap_or("");
                let tail: String = progress.chars().rev().take(64).collect::<Vec<_>>().into_iter().rev().collect();
                format!("{}:{}:{tail}", job.id, progress.len())
            })
            .collect();
        let updated = ticket.updated_at.clone();
        tokio::task::spawn_blocking(move || {
            if let Some(directory) = directory.as_ref() {
                roots.extend(procinfo::in_directory(&directory.canonicalize().unwrap_or_else(|_| directory.clone())));
            }
            if let Some(pid) = driver_pid {
                roots.push(pid);
            }
            let own_pid = std::process::id();
            let processes: Vec<ProcessSnapshot> =
                procinfo::tree(&roots).into_iter().filter(|process| process.pid != own_pid && Some(process.pid) != driver_pid).collect();
            let files = scan_workspace(directory.as_deref(), now);
            Sample {
                process_count: processes.len(),
                cpu: processes.iter().map(|process| process.cpu_ticks).sum(),
                processes: processes.into_iter().take(16).collect(),
                signature: format!("{updated}|{transcript_sig}|{}:{}:{}|{}", files.count, files.total_bytes, files.latest_mtime, pipes.join("|")),
                recent: files.recent,
                latest_mtime: files.latest_mtime,
                latest_transcript_at,
                log_tail: files.log_tail,
            }
        })
        .await
        .unwrap_or_default()
    }

    #[allow(clippy::too_many_arguments)]
    fn suspect(&self, kind: &str, ticket: &Ticket, jobs: &[WorkerJob], sample: &Sample, delta: Delta, elapsed_ms: Option<i64>, note: Option<String>) -> Value {
        let session = self.session(&worker_session_id(&ticket.id));
        let streaming = session.as_ref().is_some_and(|loaded| !loaded.session.is_disposed() && loaded.session.is_streaming());
        let mut suspect = json!({
            "kind": kind,
            "ticket_id": ticket.id,
            "title": ticket.title,
            "scope": ticket.mandate.scope,
            "state": card_state(ticket),
            "session": {"loaded": session.is_some(), "streaming": streaming, "worker_active": self.is_worker_active(&ticket.id)},
            "running_jobs": jobs,
            "process_tree": sample.processes,
            "activity_delta": delta.json(),
            "recent_files": sample.recent,
            "recent_transcript": self.recent_transcript(&ticket.id, 6),
        });
        if let Some(execution) = &ticket.execution {
            suspect["directory"] = execution.directory.clone().into();
        }
        if let Some(elapsed) = elapsed_ms {
            suspect["elapsed_seconds"] = (elapsed / 1000).into();
        }
        if let Some(tail) = &sample.log_tail {
            suspect["latest_log_tail"] = json!(tail);
        }
        if let Some(report) = ticket.latest_report() {
            suspect["latest_report"] = json!({"state": report.state, "at": report.at, "preview": clip(&report.summary, 320)});
        }
        if let Some(delivery) = &ticket.delivery {
            suspect["delivery_error"] = delivery.error.clone().into();
        }
        if let Some(note) = note {
            suspect["previous_patrol_note"] = note.into();
        }
        suspect
    }

    async fn collect_suspects(&self, now: i64, lingering: &[(Ticket, String)]) -> PatrolBatch {
        let timings = self.watchdog.timings;
        let open = self.store.open_tickets();
        {
            let ids: HashSet<&str> = open.iter().map(|ticket| ticket.id.as_str()).collect();
            self.watchdog.memory().activity.retain(|id, _| ids.contains(id.as_str()));
        }
        let mut batch = PatrolBatch::default();
        let mut seen: HashSet<String> = HashSet::new();
        for ticket in &open {
            let stage = ticket_stage(ticket);
            let running = ticket.running();
            let jobs = self.running_jobs(&ticket.id).await;
            let sample = self.sample(ticket, &jobs, now).await;
            let previous = self.watchdog.memory().activity.get(&ticket.id).cloned();
            let session_streaming =
                self.session(&worker_session_id(&ticket.id)).is_some_and(|loaded| !loaded.session.is_disposed() && loaded.session.is_streaming());
            let worker_active = self.is_worker_active(&ticket.id) || session_streaming || !jobs.is_empty();
            let judged = match (stage, running) {
                (TicketStage::Idle, _) => {
                    let since = parse_iso(running.and_then(|running| running.report.as_ref()).map(|report| report.at.as_str()).unwrap_or(&ticket.updated_at))
                        .unwrap_or(now);
                    Some(("idle_without_followup", judge_idle(previous.as_ref(), &sample, since, now, &timings), since))
                }
                (TicketStage::Working { queued: false }, Some(running)) if !worker_active && ticket.undelivered.is_empty() => {
                    // Ticket thinks it is working, yet no runtime turn, job, launch or delivery is active: stranded.
                    let started = parse_iso(running.started_at.as_deref().unwrap_or(&ticket.created_at)).unwrap_or(now);
                    let since = started.max(sample.latest_transcript_at);
                    Some(("idle_without_followup", judge_idle(previous.as_ref(), &sample, since, now, &timings), since))
                }
                (TicketStage::Working { queued: false }, Some(running)) => {
                    let started = parse_iso(running.started_at.as_deref().unwrap_or(&ticket.created_at)).unwrap_or(now);
                    Some(("long_running_worker", judge_working(previous.as_ref(), &sample, started, now, &timings), started))
                }
                _ => None,
            };
            if let Some((kind, (mut state, delta), since)) = judged {
                let note = state.note.clone();
                if let Some(delta) = delta {
                    // Defer committing patrolled_at/patrolled_signature until run_once succeeds.
                    state.patrolled_at = previous.as_ref().and_then(|prev| prev.patrolled_at);
                    state.patrolled_signature = previous.as_ref().and_then(|prev| prev.patrolled_signature.clone());
                    batch.patrolled_activity.push((ticket.id.clone(), sample.signature.clone()));
                    seen.insert(ticket.id.clone());
                    batch.suspects.push(self.suspect(kind, ticket, &jobs, &sample, delta, Some((now - since).max(0)), note));
                }
                self.watchdog.memory().activity.insert(ticket.id.clone(), state);
                continue;
            }
            let failed = ticket.delivery.is_some()
                || ticket.latest().and_then(|latest| latest.report.as_ref()).is_some_and(|report| report.state == ReportState::Failed);
            if can_retry(ticket) && failed {
                let fresh = {
                    let memory = self.watchdog.memory();
                    memory.auto_retries.get(&ticket.id).copied().unwrap_or(0) < MAX_AUTO_RETRIES
                        && memory.failure_seen.get(&ticket.id) != Some(&ticket.updated_at)
                };
                if fresh {
                    batch.patrolled_failures.push((ticket.id.clone(), ticket.updated_at.clone()));
                    seen.insert(ticket.id.clone());
                    batch.suspects.push(self.suspect("delivery_or_transient_failure", ticket, &jobs, &sample, Delta::NONE, None, None));
                }
            }
        }
        for (ticket, missing_key) in lingering {
            let skip = {
                let memory = self.watchdog.memory();
                let patrolled = memory.activity.get(&ticket.id).and_then(|state| state.patrolled_at).unwrap_or(0);
                let (manual_count, last_manual) = memory.manual_relay_nudges.get(missing_key).copied().unwrap_or((0, 0));
                seen.contains(&ticket.id)
                    || now - patrolled < ms(timings.unreplied_grace)
                    || manual_count >= MAX_MANUAL_RELAY_NUDGES
                    || (manual_count > 0 && now - last_manual < ms(timings.long_task))
            };
            if skip {
                continue;
            }
            let jobs = self.running_jobs(&ticket.id).await;
            let sample = self.sample(ticket, &jobs, now).await;
            let previous = self.watchdog.memory().activity.get(&ticket.id).cloned();
            self.watchdog.memory().activity.insert(
                ticket.id.clone(),
                Activity {
                    signature: sample.signature.clone(),
                    last_output_at: now,
                    cpu: sample.cpu,
                    patrolled_at: previous.as_ref().and_then(|prev| prev.patrolled_at),
                    patrolled_signature: previous.as_ref().and_then(|prev| prev.patrolled_signature.clone()),
                    note: previous.and_then(|prev| prev.note),
                },
            );
            batch.patrolled_activity.push((ticket.id.clone(), sample.signature.clone()));
            batch.patrolled_relays.push(missing_key.clone());
            seen.insert(ticket.id.clone());
            batch.suspects.push(self.suspect("unreplied_ticket", ticket, &jobs, &sample, Delta::NONE, None, None));
        }
        {
            let memory = self.watchdog.memory();
            for (component, health) in self.board.all() {
                if component == "watchdog" || health.state != "error" {
                    continue;
                }
                let marker = format!("{}:{}", health.at, health.detail);
                if memory.health_seen.get(&component) == Some(&marker) {
                    continue;
                }
                batch.patrolled_health.push((component.clone(), marker));
                batch.health_errors.push(json!({"component": component, "detail": health.detail, "at": health.at}));
            }
        }
        batch
    }

    /// A ticket in more depth than a patrol inlines, for the Watchdog Session.
    pub async fn watchdog_inspect(self: &Arc<Self>, ticket_id: &str) -> Result<Value, String> {
        let ticket = self.store_ticket(ticket_id).ok_or_else(|| format!("Unknown ticket: {ticket_id}"))?;
        let session = self.session(&worker_session_id(ticket_id));
        Ok(json!({
            "ticket": ticket_card(&ticket),
            "directory": ticket.execution.as_ref().map(|execution| execution.directory.clone()),
            "scope": ticket.mandate.scope,
            "answers_pending": ticket.answers,
            "delivery": ticket.delivery,
            "session": {
                "loaded": session.is_some(),
                "streaming": session.is_some_and(|loaded| !loaded.session.is_disposed() && loaded.session.is_streaming()),
                "worker_active": self.is_worker_active(ticket_id),
            },
            "running_jobs": self.running_jobs(ticket_id).await,
            "assignments": newest_page(&ticket.assignments, 0, 3, |item| assignment_line(&ticket, item)).0,
            "inputs": newest_page(&ticket.inputs, 0, 8, |input| input_line(&ticket, input)).0,
            "recent_transcript": self.recent_transcript(ticket_id, 12),
        }))
    }

    /// Act on what a patrol found: wake a worker, cancel a job, interrupt a hung worker, retry a ticket, or relay a report again.
    pub async fn watchdog_intervene(self: &Arc<Self>, arguments: Value) -> Result<Value, String> {
        let args = Args::of(arguments, &["action", "ticket_id", "job_id", "message"])?;
        let (action, ticket_id, message) = (args.required("action")?, args.required("ticket_id")?, args.required("message")?.trim());
        if message.chars().count() > 1000 {
            return Err("message has at most 1000 characters".into());
        }
        let ticket = self.store_ticket(ticket_id).ok_or_else(|| format!("Unknown ticket: {ticket_id}"))?;
        match action {
            "wake_worker" => {
                let woken = self.engine.wake_worker(ticket_id, message).map_err(|error| error.message)?;
                if woken {
                    self.passes.pump();
                }
                self.record_watchdog_event("intervene", Some(ticket_id), &format!("wake_worker woken={woken}: {message}"));
                Ok(json!({"action": action, "ticket_id": ticket_id, "woken": woken}))
            }
            "cancel_job" => {
                let job_id = args.text("job_id").ok_or("cancel_job requires job_id")?;
                let cancelled = self.cancel_job(ticket_id, job_id, message).await?;
                self.record_watchdog_event("intervene", Some(ticket_id), &format!("cancel_job job={job_id} cancelled={cancelled}: {message}"));
                Ok(json!({"action": action, "ticket_id": ticket_id, "job_id": job_id, "cancelled": cancelled}))
            }
            "interrupt_worker" => {
                let refused = |reason: &str| {
                    self.record_watchdog_event("intervene", Some(ticket_id), &format!("interrupt_worker refused ({reason}): {message}"));
                    Ok(json!({"action": action, "ticket_id": ticket_id, "interrupted": false, "reason": reason}))
                };
                if !ticket.live() || ticket.running().is_none() {
                    return refused("Ticket has no running worker");
                }
                {
                    let memory = self.watchdog.memory();
                    if memory.auto_interrupts.get(ticket_id).copied().unwrap_or(0) >= MAX_AUTO_INTERRUPTS {
                        return refused("Auto-interrupt limit reached");
                    }
                }
                let interrupted = self.interrupt_worker(ticket_id, message).await?;
                if interrupted {
                    *self.watchdog.memory().auto_interrupts.entry(ticket_id.to_string()).or_insert(0) += 1;
                }
                self.record_watchdog_event("intervene", Some(ticket_id), &format!("interrupt_worker interrupted={interrupted}: {message}"));
                Ok(json!({"action": action, "ticket_id": ticket_id, "interrupted": interrupted}))
            }
            "retry_ticket" => {
                let refused = |reason: &str| {
                    self.record_watchdog_event("intervene", Some(ticket_id), &format!("retry_ticket refused ({reason}): {message}"));
                    Ok(json!({"action": action, "ticket_id": ticket_id, "retried": false, "reason": reason}))
                };
                {
                    let mut memory = self.watchdog.memory();
                    let used = memory.auto_retries.entry(ticket_id.to_string()).or_insert(0);
                    if *used >= MAX_AUTO_RETRIES {
                        return refused("Auto-retry limit reached");
                    }
                    if !can_retry(&ticket) {
                        return refused("Ticket is not retryable");
                    }
                    *used += 1;
                }
                self.engine.retry_ticket(ticket_id).map_err(|error| error.message)?;
                self.passes.pump();
                self.record_watchdog_event("intervene", Some(ticket_id), &format!("retry_ticket retried=true: {message}"));
                Ok(json!({"action": action, "ticket_id": ticket_id, "retried": true}))
            }
            "relay_report" => {
                let tag = {
                    let mut memory = self.watchdog.memory();
                    memory.seq += 1;
                    format!("manual:{}", memory.seq)
                };
                let relayed = self.relay_missing(&ticket, &tag);
                if relayed {
                    self.passes.pump();
                }
                self.record_watchdog_event("intervene", Some(ticket_id), &format!("relay_report relayed={relayed} tag={tag}: {message}"));
                Ok(json!({"action": action, "ticket_id": ticket_id, "relayed": relayed}))
            }
            _ => Err("action is wake_worker, cancel_job, interrupt_worker, retry_ticket or relay_report".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neo_kernel::types::Message;

    const MIN: i64 = 60_000;

    fn sample(signature: &str, cpu: u64, processes: usize) -> Sample {
        Sample { signature: signature.into(), cpu, process_count: processes, ..Sample::default() }
    }

    #[test]
    fn passes_a_working_ticket_while_it_writes_or_computes_and_inspects_a_stalled_one() {
        let t = WatchdogTimings::default();
        let start = 1_000 * MIN;
        // First sight, just started: remembered, not inspected.
        let (first, verdict) = judge_working(None, &sample("a", 10, 1), start, start + MIN, &t);
        assert_eq!((verdict, first.last_output_at, first.cpu), (None, start, 10));
        // Output changed: the silence starts again.
        let (changed, verdict) = judge_working(Some(&first), &sample("b", 10, 1), start, start + 20 * MIN, &t);
        assert_eq!((verdict, changed.last_output_at), (None, start + 20 * MIN));
        // No output but CPU time used: passes for half an hour of silence.
        let (busy, verdict) = judge_working(Some(&changed), &sample("b", 50, 1), start, start + 40 * MIN, &t);
        assert_eq!((verdict, busy.cpu), (None, 50));
        // CPU time still used after the silence allowed: inspected, with the delta.
        let (state, verdict) = judge_working(Some(&busy), &sample("b", 90, 1), start, start + 51 * MIN, &t);
        assert_eq!(verdict, Some(Delta { output_changed: false, cpu_delta: 40, silent_ms: 31 * MIN }));
        assert_eq!((state.patrolled_at, state.patrolled_signature.as_deref()), (Some(start + 51 * MIN), Some("b")));
        // Just inspected: left alone until the cooldown is over, then inspected again.
        assert_eq!(judge_working(Some(&state), &sample("b", 90, 1), start, start + 55 * MIN, &t).1, None);
        assert!(judge_working(Some(&state), &sample("b", 90, 1), start, start + 62 * MIN, &t).1.is_some());
        // Neither output nor CPU time: inspected once the stall time has passed, not before.
        assert_eq!(judge_working(Some(&first), &sample("a", 10, 1), start, start + 5 * MIN, &t).1, None);
        assert_eq!(
            judge_working(Some(&first), &sample("a", 10, 1), start, start + 7 * MIN, &t).1,
            Some(Delta { output_changed: false, cpu_delta: 0, silent_ms: 7 * MIN })
        );
        // A file written after the start counts as output from the first sight on.
        let recent = Sample { latest_mtime: start + 9 * MIN, ..sample("a", 0, 0) };
        assert_eq!(judge_working(None, &recent, start, start + 12 * MIN, &t).1, None);
        // Recent transcript activity also counts as output even when workspace files did not change.
        let stepping = Sample { latest_transcript_at: start + 10 * MIN, ..sample("a", 0, 0) };
        assert_eq!(judge_working(None, &stepping, start, start + 12 * MIN, &t).1, None);
    }

    #[test]
    fn inspects_an_idle_ticket_after_the_grace_and_rechecks_it_more_slowly_while_nothing_changes() {
        let t = WatchdogTimings::default();
        let since = 1_000 * MIN;
        assert_eq!(judge_idle(None, &sample("a", 0, 0), since, since + MIN / 2, &t).1, None, "within the grace");
        let (state, verdict) = judge_idle(None, &sample("a", 0, 0), since, since + 2 * MIN, &t);
        assert_eq!(verdict, Some(Delta { output_changed: false, cpu_delta: 0, silent_ms: 2 * MIN }));
        // Nothing changed and no process: the long cooldown applies.
        assert_eq!(judge_idle(Some(&state), &sample("a", 0, 0), since, since + 6 * MIN, &t).1, None);
        assert!(judge_idle(Some(&state), &sample("a", 0, 0), since, since + 13 * MIN, &t).1.is_some());
        // Something changed without a live process: rechecked at the short interval.
        let (_, verdict) = judge_idle(Some(&state), &sample("b", 0, 0), since, since + 6 * MIN, &t);
        assert_eq!(verdict, Some(Delta { output_changed: true, cpu_delta: 0, silent_ms: 0 }));
        // A detached process that writes or computes is left alone.
        assert_eq!(judge_idle(Some(&state), &sample("b", 0, 1), since, since + 20 * MIN, &t).1, None);
        assert_eq!(judge_idle(Some(&state), &sample("a", 5, 1), since, since + 20 * MIN, &t).1, None);
        // One that only sits there is not.
        assert!(judge_idle(Some(&state), &sample("a", 0, 1), since, since + 20 * MIN, &t).1.is_some());
        // The note of the last patrol is carried along.
        let noted = Activity { note: Some("Left alone.".into()), ..state.clone() };
        assert_eq!(judge_idle(Some(&noted), &sample("a", 0, 0), since, since + 13 * MIN, &t).0.note.as_deref(), Some("Left alone."));
    }

    #[test]
    fn scans_a_workspace_two_levels_deep_and_tails_its_newest_log() {
        let dir = std::env::temp_dir().join(format!("neo-watchdog-{}-{}", std::process::id(), now_ms()));
        for sub in ["src/deep/deeper/deepest", "node_modules/x", ".git", "logs"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        let write = |path: &str, text: &str| std::fs::write(dir.join(path), text).unwrap();
        write("README.md", "# Title\n");
        write("src/main.rs", "fn main() {}\n");
        write("src/deep/kept.rs", "//\n");
        write("src/deep/deeper/deepest/skipped.rs", "//\n");
        write("node_modules/x/index.js", "x\n");
        write(".git/HEAD", "ref\n");
        write(".hidden", "h\n");
        write("logs/empty.log", "");
        let lines: Vec<String> = (1..=40).map(|n| format!("step {n}")).collect();
        write("logs/train.log", &format!("{}\n", lines.join("\n")));
        let scan = scan_workspace(Some(&dir), now_ms() + 5_000);
        let mut paths: Vec<&str> = scan.recent.iter().map(|file| file.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, vec!["README.md", "logs/empty.log", "logs/train.log", "src/deep/kept.rs", "src/main.rs"]);
        assert_eq!(scan.count, 5);
        assert_eq!(scan.total_bytes, scan.recent.iter().map(|file| file.bytes).sum::<u64>());
        assert!(scan.latest_mtime > 0 && scan.recent.iter().all(|file| (0..120).contains(&file.age_seconds)));
        // The newest log that has anything in it.
        let tail = scan.log_tail.expect("the log's tail");
        assert_eq!(tail.file, "logs/train.log");
        assert!(tail.tail.starts_with("step 16\n") && tail.tail.ends_with("step 40"), "{}", tail.tail);
        assert_eq!(read_tail(&dir.join("logs/train.log"), 20, 25).as_deref(), Some("38\nstep 39\nstep 40"));
        assert_eq!(read_tail(&dir.join("logs/empty.log"), 4096, 25), None);
        assert_eq!(read_tail(&dir.join("missing.log"), 4096, 25), None);
        let none = scan_workspace(Some(&dir.join("missing")), 0);
        assert_eq!((none.count, none.latest_mtime), (0, 0));
        assert_eq!(scan_workspace(None, 0).count, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn excerpts_text_and_tool_calls_of_a_transcript_entry() {
        let said = Entry::Message {
            id: "1".into(),
            timestamp: "2026-01-01T00:00:00.000Z".into(),
            message: Message {
                role: Role::Assistant,
                content: vec![
                    Block::text("Running the build."),
                    Block::ToolCall { id: "c".into(), name: "bash".into(), arguments: json!({"command": "make"}) },
                ],
                stop_reason: None,
            },
        };
        assert_eq!(excerpt(&said), ("assistant", "Running the build.\n[tool:bash] {\"command\":\"make\"}".to_string()));
        let long = Entry::CustomMessage {
            id: "2".into(),
            timestamp: String::new(),
            custom_type: "neo".into(),
            content: vec![Block::text("x".repeat(900))],
            display: false,
            details: None,
            attribution: None,
        };
        let (role, text) = excerpt(&long);
        assert_eq!((role, text.chars().count()), ("custom", 500));
    }
}
