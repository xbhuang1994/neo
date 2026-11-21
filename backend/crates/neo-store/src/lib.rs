//! SQLite persistence for domain aggregates, key-value state, the channel outbox and the effect queue.
//!
//! One connection serves every caller. Transactions nest as savepoints, so the Engine's commands and the side effects
//! they queue commit or roll back together. A transaction belongs to the thread that opened it: other threads wait
//! until it ends, so none of them reads or writes inside a transaction that may still roll back.
#![deny(missing_docs)]

pub mod effects;
mod read;
mod receipts;

pub use read::{FailingReply, Place};
pub use receipts::{DropReason, Dropped, Receipt, Settled};

use neo_core::model::{thread_key, Decision, Thread, Ticket, Trigger, TriggerDisposition};
use neo_core::ports::Repositories;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fmt;
use std::path::Path;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::thread::{self, ThreadId};

/// The schema this build reads and writes. Earlier TypeScript deployments used schema 1 and are not migrated.
pub const SCHEMA_VERSION: i64 = 100;

/// A failure opening or using the database.
#[derive(Debug)]
pub enum StoreError {
    /// The database belongs to another version of the program.
    Schema(i64),
    /// SQLite or the filesystem failed.
    Io(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Schema(found) => write!(
                f,
                "Unsupported database schema {found} (this version uses {SCHEMA_VERSION}); state from another version is not migrated, start with a new empty data directory"
            ),
            StoreError::Io(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Io(error.to_string())
    }
}

/// Generated columns and partial indexes defining the working sets, so passes scan only active rows.
const SETS: &[(&str, &str, &str)] = &[
    ("ticket", "open", "INTEGER AS (CASE WHEN value -> '$.ended' IS NULL THEN 1 END)"),
    // Only the latest assignment can be pending or running because the Engine closes one before adding the next.
    (
        "ticket",
        "active",
        "INTEGER AS (CASE WHEN json_array_length(value, '$.undelivered') > 0 OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END)",
    ),
    ("thread", "active", "INTEGER AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 END)"),
    ("thread", "subscribed", "TEXT AS (CASE WHEN json_array_length(value, '$.subscriptions') > 0 THEN value ->> '$.ref.source' END)"),
    ("outbox", "dropped", "TEXT AS (value ->> '$.dropped.at')"),
    // Ticket and conversation together, to keep the order of a ticket's replies to one conversation.
    (
        "outbox",
        "pending",
        "TEXT AS (CASE WHEN value ->> '$.status' = 'pending' AND value ->> '$.ticketId' IS NOT NULL THEN (value ->> '$.ticketId') || ' ' || (value ->> '$.channel.thread') END)",
    ),
];

struct Inner {
    db: Connection,
    depth: usize,
    /// Callbacks to run once the outermost transaction commits, by savepoint level.
    committed: Vec<Vec<Box<dyn FnOnce() + Send>>>,
}

/// A lock one thread may take several times; the others wait until it has left as often as it entered.
#[derive(Default)]
struct Gate {
    owner: Mutex<(Option<ThreadId>, usize)>,
    free: Condvar,
}

impl Gate {
    fn enter(&self) {
        let me = thread::current().id();
        let mut owner = self.owner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while owner.0.is_some_and(|holder| holder != me) {
            owner = self.free.wait(owner).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *owner = (Some(me), owner.1 + 1);
    }
    fn exit(&self) {
        let mut owner = self.owner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        owner.1 = owner.1.saturating_sub(1);
        if owner.1 == 0 {
            owner.0 = None;
            self.free.notify_one();
        }
    }
}

/// Holds the gate for one statement.
struct Entered<'a>(&'a Gate);

impl Drop for Entered<'_> {
    fn drop(&mut self) {
        self.0.exit();
    }
}

/// SQLite persistence for domain state.
pub struct Store {
    gate: Gate,
    inner: Mutex<Inner>,
}

fn parse<T: DeserializeOwned>(value: String) -> T {
    serde_json::from_str(&value).expect("stored JSON matches this version's model")
}

impl Store {
    /// Open (or create) the database at `path`, refusing one written by another schema version.
    pub fn open(path: &Path) -> Result<Store, StoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| StoreError::Io(format!("Cannot create {}: {error}", parent.display())))?;
            restrict(parent, 0o700);
        }
        let db = Connection::open(path)?;
        restrict(path, 0o600);
        Self::prepare(db)
    }

    /// An in-memory database, for tests.
    pub fn memory() -> Store {
        Self::prepare(Connection::open_in_memory().expect("SQLite opens in memory")).expect("a new database has the current schema")
    }

    fn prepare(db: Connection) -> Result<Store, StoreError> {
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-16000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        )?;
        let version: Option<String> = db.query_row("SELECT value FROM kv WHERE key='schema'", [], |row| row.get(0)).optional()?;
        let version = version.map(|value| value.parse::<i64>().unwrap_or(-1));
        if let Some(found) = version.filter(|found| *found != SCHEMA_VERSION) {
            return Err(StoreError::Schema(found));
        }
        db.execute_batch(
            "BEGIN;
            CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
              PRIMARY KEY (thread, id));
            CREATE TABLE IF NOT EXISTS effect (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
              generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL,
              since TEXT NOT NULL, PRIMARY KEY (kind, key));
            CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
            CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);
            CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
            CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
            CREATE INDEX IF NOT EXISTS effect_kind_seq ON effect(kind, seq);
            CREATE INDEX IF NOT EXISTS outbox_ticket_reply ON outbox(value ->> '$.ticketId', value ->> '$.queuedAt') WHERE value ->> '$.kind' = 'reply';",
        )?;
        for (table, name, definition) in SETS {
            let exists: bool =
                db.query_row("SELECT COUNT(*) FROM pragma_table_xinfo(?1) WHERE name = ?2", params![table, name], |row| row.get::<_, i64>(0))? > 0;
            if !exists {
                db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} {definition}"))?;
            }
            db.execute_batch(&format!("CREATE INDEX IF NOT EXISTS {table}_{name} ON {table}({name}) WHERE {name} IS NOT NULL"))?;
        }
        if version.is_none() {
            db.execute("INSERT INTO kv VALUES ('schema', ?1)", params![SCHEMA_VERSION.to_string()])?;
        }
        db.execute_batch("COMMIT")?;
        Ok(Store { gate: Gate::default(), inner: Mutex::new(Inner { db, depth: 0, committed: Vec::new() }) })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Run `f` with the connection, inside this thread's open transaction if it has one, and after any other thread's.
    pub(crate) fn with<R>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> R {
        self.gate.enter();
        let _entered = Entered(&self.gate);
        f(&self.lock().db).expect("SQLite statement")
    }

    pub(crate) fn values<T: DeserializeOwned>(&self, sql: &str, parameters: impl rusqlite::Params) -> Vec<T> {
        self.with(|db| {
            let mut statement = db.prepare_cached(sql)?;
            let rows = statement.query_map(parameters, |row| row.get::<_, String>(0))?;
            rows.map(|value| value.map(parse)).collect()
        })
    }

    pub(crate) fn value<T: DeserializeOwned>(&self, sql: &str, parameters: impl rusqlite::Params) -> Option<T> {
        self.with(|db| db.prepare_cached(sql)?.query_row(parameters, |row| row.get::<_, String>(0)).optional()).map(parse)
    }

    fn put(&self, sql: &str, parameters: impl rusqlite::Params) {
        self.with(|db| db.prepare_cached(sql)?.execute(parameters));
    }

    /// Run `work` in a transaction (a savepoint when one is open): committed on `Ok`, rolled back on `Err` or a panic.
    /// Post-commit callbacks run only after the outermost transaction commits.
    pub fn atomic<T, E>(&self, work: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
        self.begin();
        struct Guard<'a>(&'a Store, bool);
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                if !self.1 {
                    self.0.rollback();
                }
            }
        }
        let mut guard = Guard(self, false);
        let result = work();
        guard.1 = true;
        match &result {
            Ok(_) => self.commit(),
            Err(_) => self.rollback(),
        }
        result
    }

    /// Run `action` once the outermost transaction commits, or at once outside a transaction; one queued in a
    /// transaction that rolls back never runs. For in-memory follow-ups to a committed write that need not survive a
    /// restart; durable side effects go through the effect queue.
    pub fn after_commit(&self, action: impl FnOnce() + Send + 'static) {
        self.gate.enter();
        let entered = Entered(&self.gate);
        let mut inner = self.lock();
        if inner.depth == 0 {
            drop(inner);
            drop(entered);
            action();
        } else {
            let level = inner.depth - 1;
            inner.committed[level].push(Box::new(action));
        }
    }

    // Key-value records.

    /// A typed KV record.
    pub fn get<V: DeserializeOwned>(&self, key: &str) -> Option<V> {
        self.value("SELECT value FROM kv WHERE key=?1", params![key])
    }
    /// Write a typed KV record.
    pub fn set<V: Serialize>(&self, key: &str, value: &V) {
        let json = serde_json::to_string(value).expect("KV values serialize");
        self.put("INSERT INTO kv VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, json]);
    }
    /// Delete a KV record.
    pub fn delete(&self, key: &str) {
        self.put("DELETE FROM kv WHERE key=?1", params![key]);
    }
    /// The KV keys that start with `prefix`, in key order.
    pub fn keys(&self, prefix: &str) -> Vec<String> {
        let pattern = format!("{}%", like(prefix));
        self.with(|db| {
            let mut statement = db.prepare_cached("SELECT key FROM kv WHERE key LIKE ?1 ESCAPE '\\' ORDER BY key")?;
            let rows = statement.query_map(params![pattern], |row| row.get::<_, String>(0))?;
            rows.collect()
        })
    }

    /// Set or remove (`None`) source-specific metadata keys on a thread; no-op if the thread does not exist.
    pub fn patch_thread_meta(&self, key: &str, patch: &[(&str, Option<serde_json::Value>)]) {
        let _ = self.atomic(|| -> Result<(), ()> {
            let Some(mut thread) = Repositories::thread(self, key) else { return Ok(()) };
            let before = thread.meta.clone();
            for (name, value) in patch {
                match value {
                    Some(value) => thread.meta.insert(name.to_string(), value.clone()),
                    None => thread.meta.remove(*name),
                };
            }
            if thread.meta != before {
                self.save_thread(&thread);
            }
            Ok(())
        });
    }

    /// The latest `limit` tickets, newest first.
    pub fn recent_tickets(&self, limit: i64) -> Vec<Ticket> {
        self.values("SELECT value FROM ticket ORDER BY rowid DESC LIMIT ?1", params![limit])
    }
}

/// Escapes `LIKE` wildcards for a pattern used with `ESCAPE '\'`.
pub(crate) fn like(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(unix)]
fn restrict(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}
#[cfg(not(unix))]
fn restrict(_path: &Path, _mode: u32) {}

impl Repositories for Store {
    fn begin(&self) {
        // Held until the matching commit or rollback, so the transaction is this thread's alone.
        self.gate.enter();
        let mut inner = self.lock();
        let level = inner.depth;
        inner.db.execute_batch(&format!("SAVEPOINT neo_atomic_{level}")).expect("SAVEPOINT");
        inner.depth += 1;
        inner.committed.push(Vec::new());
    }
    fn commit(&self) {
        let actions = {
            let mut inner = self.lock();
            if inner.depth == 0 {
                return;
            }
            inner.depth -= 1;
            let level = inner.depth;
            inner.db.execute_batch(&format!("RELEASE neo_atomic_{level}")).expect("RELEASE");
            let actions = inner.committed.pop().unwrap_or_default();
            if level > 0 {
                inner.committed[level - 1].extend(actions);
                Vec::new()
            } else {
                actions
            }
        };
        self.gate.exit();
        for action in actions {
            action();
        }
    }
    fn rollback(&self) {
        let mut inner = self.lock();
        if inner.depth == 0 {
            return;
        }
        inner.depth -= 1;
        let level = inner.depth;
        inner.db.execute_batch(&format!("ROLLBACK TO neo_atomic_{level}; RELEASE neo_atomic_{level}")).expect("ROLLBACK");
        inner.committed.pop();
        drop(inner);
        self.gate.exit();
    }

    fn trigger(&self, id: &str) -> Option<Trigger> {
        self.value("SELECT value FROM trigger WHERE id=?1", params![id])
    }
    fn save_trigger(&self, trigger: &Trigger) {
        let json = serde_json::to_string(trigger).expect("triggers serialize");
        self.with(|db| {
            db.prepare_cached("INSERT INTO trigger VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at")?
                .execute(params![trigger.id, json, trigger.at])?;
            db.prepare_cached("DELETE FROM trigger_thread WHERE id=?1")?.execute(params![trigger.id])?;
            let mut insert = db.prepare_cached("INSERT OR IGNORE INTO trigger_thread VALUES (?1,?2,?3,?4)")?;
            for reference in &trigger.threads {
                insert.execute(params![thread_key(reference), trigger.id, trigger.at, trigger.human as i64])?;
            }
            Ok(())
        });
    }
    fn disposition(&self, id: &str) -> Option<TriggerDisposition> {
        self.value("SELECT value FROM disposition WHERE id=?1", params![id])
    }
    fn save_disposition(&self, id: &str, value: &TriggerDisposition) {
        let json = serde_json::to_string(value).expect("dispositions serialize");
        self.put("INSERT INTO disposition VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value", params![id, json]);
    }

    fn thread(&self, key: &str) -> Option<Thread> {
        self.value("SELECT value FROM thread WHERE key=?1", params![key])
    }
    fn save_thread(&self, thread: &Thread) {
        let json = serde_json::to_string(thread).expect("threads serialize");
        self.put("INSERT INTO thread VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![thread.key, json]);
    }
    fn threads(&self) -> Vec<Thread> {
        self.values("SELECT value FROM thread ORDER BY rowid", [])
    }
    fn active_threads(&self) -> Vec<Thread> {
        self.values("SELECT value FROM thread WHERE active = 1 ORDER BY rowid", [])
    }

    fn ticket(&self, id: &str) -> Option<Ticket> {
        self.value("SELECT value FROM ticket WHERE id=?1", params![id])
    }
    fn save_ticket(&self, ticket: &Ticket) {
        let json = serde_json::to_string(ticket).expect("tickets serialize");
        self.put("INSERT INTO ticket VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value", params![ticket.id, json]);
    }
    fn tickets(&self) -> Vec<Ticket> {
        self.values("SELECT value FROM ticket ORDER BY rowid DESC", [])
    }
    fn open_tickets(&self) -> Vec<Ticket> {
        self.values("SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC", [])
    }
    fn active_tickets(&self) -> Vec<Ticket> {
        self.values("SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC", [])
    }

    fn decision(&self, id: &str) -> Option<Decision> {
        self.value("SELECT value FROM decision WHERE id=?1", params![id])
    }
    fn save_decision(&self, decision: &Decision) {
        let json = serde_json::to_string(decision).expect("decisions serialize");
        self.put(
            "INSERT INTO decision VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread",
            params![decision.id, decision.thread_key, json],
        );
    }
    fn decisions_by_thread(&self, key: &str) -> Vec<Decision> {
        self.values("SELECT value FROM decision WHERE thread=?1 ORDER BY rowid", params![key])
    }
}
