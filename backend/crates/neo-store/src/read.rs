//! Read-only queries for views and tools.

use crate::{like, Receipt, Store};
use neo_core::model::{Decision, Thread, Trigger};
use rusqlite::params;

/// A Trigger's position on its thread timeline, ordered by timestamp and then id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    /// The Trigger's time.
    pub at: String,
    /// The Trigger's id, as the tie-breaker.
    pub id: String,
}

/// A message whose delivery keeps failing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailingReply {
    /// The message's receipt.
    pub receipt: Receipt,
    /// Consecutive failed attempts.
    pub attempts: i64,
    /// The last error.
    pub error: String,
}

impl Store {
    /// Triggers newest first by arrival order rather than by their own timestamp.
    pub fn recent_triggers(&self, offset: i64, limit: i64) -> Vec<Trigger> {
        self.values("SELECT value FROM trigger ORDER BY rowid DESC LIMIT ?1 OFFSET ?2", params![limit, offset])
    }
    /// The latest `limit` triggers on a thread, oldest first, optionally bounded before (or `through`) a place.
    pub fn thread_triggers(&self, thread: &str, limit: i64, before: Option<&Place>, through: bool) -> Vec<Trigger> {
        let mut found: Vec<Trigger> = match before {
            None => self.values(
                "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 ORDER BY x.at DESC, x.id DESC LIMIT ?2",
                params![thread, limit],
            ),
            Some(place) => self.values(
                &format!(
                    "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 AND (x.at, x.id) {} (?2, ?3)
                     ORDER BY x.at DESC, x.id DESC LIMIT ?4",
                    if through { "<=" } else { "<" }
                ),
                params![thread, place.at, place.id, limit],
            ),
        };
        found.reverse();
        found
    }
    /// One page of a thread's triggers, newest first.
    pub fn thread_page(&self, thread: &str, offset: i64, limit: i64) -> Vec<Trigger> {
        self.values(
            "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 ORDER BY x.at DESC, t.rowid DESC LIMIT ?2 OFFSET ?3",
            params![thread, limit, offset],
        )
    }
    /// The nearest triggers on a thread immediately before and after a place.
    pub fn neighbours(&self, thread: &str, place: &Place) -> (Option<Trigger>, Option<Trigger>) {
        let nearest = |side: &str, order: &str| {
            self.value::<Trigger>(
                &format!(
                    "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 AND (x.at, x.id) {side} (?2, ?3)
                     ORDER BY x.at {order}, x.id {order} LIMIT 1"
                ),
                params![thread, place.at, place.id],
            )
        };
        (nearest("<", "DESC"), nearest(">", "ASC"))
    }
    /// The oldest trigger on a thread, used to title it.
    pub fn first_trigger(&self, thread: &str, human_only: bool) -> Option<Trigger> {
        self.value(
            &format!(
                "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 {} ORDER BY x.at ASC, t.rowid ASC LIMIT 1",
                if human_only { "AND x.human = 1" } else { "" }
            ),
            params![thread],
        )
    }
    /// Triggers whose id or message id is `query`, or whose text contains it, newest first.
    pub fn search_triggers(&self, query: &str, limit: i64) -> Vec<Trigger> {
        let contains = format!("%{}%", like(query));
        self.values(
            "SELECT value FROM trigger WHERE id = ?1 OR json_extract(value, '$.meta.messageId') = ?1
             OR json_extract(value, '$.text') LIKE ?2 ESCAPE '\\' ORDER BY at DESC LIMIT ?3",
            params![query, contains, limit],
        )
    }
    /// Decisions newest first.
    pub fn recent_decisions(&self, offset: i64, limit: i64) -> Vec<Decision> {
        self.values("SELECT value FROM decision ORDER BY rowid DESC LIMIT ?1 OFFSET ?2", params![limit, offset])
    }
    /// The newest decisions of the given kinds, to surface rare outcomes among many ignores.
    pub fn decisions_of_kinds(&self, kinds: &[&str], limit: i64) -> Vec<Decision> {
        let kinds = serde_json::to_string(kinds).expect("kinds serialize");
        self.values(
            "SELECT value FROM decision WHERE json_extract(value, '$.kind') IN (SELECT value FROM json_each(?1)) ORDER BY rowid DESC LIMIT ?2",
            params![kinds, limit],
        )
    }
    /// Messages whose `reply` effect failed, with their failure count and last error, oldest first.
    pub fn failing_replies(&self) -> Vec<FailingReply> {
        self.with(|db| {
            let mut statement = db.prepare_cached(
                "SELECT o.value, e.attempts, e.error FROM effect e JOIN outbox o ON o.id = e.key WHERE e.kind = 'reply' AND e.attempts > 0 ORDER BY e.seq",
            )?;
            let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)))?;
            rows.map(|row| {
                row.map(|(value, attempts, error)| FailingReply { receipt: serde_json::from_str(&value).expect("stored receipts parse"), attempts, error })
            })
            .collect()
        })
    }
    /// The latest dropped messages, newest first.
    pub fn dropped_replies(&self, limit: i64) -> Vec<Receipt> {
        self.values("SELECT value FROM outbox WHERE dropped IS NOT NULL ORDER BY dropped DESC LIMIT ?1", params![limit])
    }
    /// How many messages were dropped at or after `since`.
    pub fn dropped_since(&self, since: &str) -> i64 {
        self.with(|db| db.prepare_cached("SELECT COUNT(*) FROM outbox WHERE dropped >= ?1")?.query_row(params![since], |row| row.get(0)))
    }
    /// The threads tickets subscribe to, of one Source or of all.
    pub fn subscribed_threads(&self, source: Option<&str>) -> Vec<Thread> {
        match source {
            Some(source) => self.values("SELECT value FROM thread WHERE subscribed = ?1 ORDER BY rowid", params![source]),
            None => self.values("SELECT value FROM thread INDEXED BY thread_subscribed WHERE subscribed IS NOT NULL ORDER BY rowid", []),
        }
    }
}
