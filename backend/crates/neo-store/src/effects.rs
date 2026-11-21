//! The durable rows of the effect queue: side effects persisted inside command transactions and run after commit.
//!
//! This module only stores and selects rows; the dispatcher that runs them lives in the application.

use crate::Store;
use neo_core::time::format_iso;
use rusqlite::{params, OptionalExtension};

/// One queued effect. `seq` keeps its queue position; `generation` grows when its payload is replaced, so an attempt
/// that was running does not delete a newer payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectRow {
    /// The row's key within its kind.
    pub key: String,
    /// The payload, as JSON.
    pub value: String,
    /// Queue position.
    pub seq: i64,
    /// Payload generation.
    pub generation: i64,
    /// Consecutive failed attempts.
    pub attempts: i64,
    /// When it may next run, in epoch milliseconds.
    pub due: i64,
}

/// What a kind's queue looks like, for its health entry.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EffectSummary {
    /// How many rows wait.
    pub waiting: i64,
    /// Since when the oldest one waits.
    pub since: Option<String>,
    /// The most consecutive failures of any row.
    pub attempts: i64,
    /// The last failure's error.
    pub error: Option<String>,
}

impl Store {
    /// The highest queue position ever given out.
    pub fn effect_max_seq(&self) -> i64 {
        self.with(|db| db.query_row("SELECT IFNULL(MAX(seq), 0) FROM effect", [], |row| row.get(0)))
    }
    /// Upsert an effect in the caller's transaction, coalescing with a waiting row of the same kind and key, which
    /// keeps its queue position, takes the new payload and starts over.
    pub fn effect_enqueue(&self, kind: &str, key: &str, payload: &str, seq: i64, now_ms: i64) {
        self.with(|db| {
            db.prepare_cached(
                "INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(kind, key) DO UPDATE
                 SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due",
            )?
            .execute(params![kind, key, payload, seq, now_ms, format_iso(now_ms)])
        });
    }
    /// Whether a row of `kind` waits, or the one with `key`.
    pub fn effect_pending(&self, kind: &str, key: Option<&str>) -> bool {
        self.with(|db| match key {
            None => db.prepare_cached("SELECT 1 FROM effect WHERE kind = ?1 LIMIT 1")?.query_row(params![kind], |_| Ok(())).optional(),
            Some(key) => db.prepare_cached("SELECT 1 FROM effect WHERE kind = ?1 AND key = ?2")?.query_row(params![kind, key], |_| Ok(())).optional(),
        })
        .is_some()
    }
    /// Drop a queued row; an attempt of it that already runs finishes normally.
    pub fn effect_cancel(&self, kind: &str, key: &str) {
        self.with(|db| db.prepare_cached("DELETE FROM effect WHERE kind = ?1 AND key = ?2")?.execute(params![kind, key]));
    }
    /// The oldest row of a kind, due or not: an ordered kind waits behind it.
    pub fn effect_head(&self, kind: &str) -> Option<EffectRow> {
        self.effect_rows("SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ?1 ORDER BY seq LIMIT 1", params![kind]).pop()
    }
    /// Up to `limit` rows of a kind that are due, in queue order.
    pub fn effect_due(&self, kind: &str, now_ms: i64, limit: i64) -> Vec<EffectRow> {
        self.effect_rows(
            "SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ?1 AND due <= ?2 ORDER BY seq LIMIT ?3",
            params![kind, now_ms, limit],
        )
    }
    /// The earliest `due` timestamp across all queued effects, or `None` when empty.
    pub fn effect_next_due(&self) -> Option<i64> {
        self.with(|db| db.prepare_cached("SELECT MIN(due) FROM effect")?.query_row([], |row| row.get::<_, Option<i64>>(0)))
    }
    /// Pull unfailed waiting effects of `kind` forward to `now_ms`.
    pub fn effect_wake_kind(&self, kind: &str, now_ms: i64) {
        self.with(|db| db.prepare_cached("UPDATE effect SET due = ?2 WHERE kind = ?1 AND attempts = 0 AND due > ?2")?.execute(params![kind, now_ms]));
    }
    fn effect_rows(&self, sql: &str, parameters: impl rusqlite::Params) -> Vec<EffectRow> {
        self.with(|db| {
            let mut statement = db.prepare_cached(sql)?;
            let rows = statement.query_map(parameters, |row| {
                Ok(EffectRow { key: row.get(0)?, value: row.get(1)?, seq: row.get(2)?, generation: row.get(3)?, attempts: row.get(4)?, due: row.get(5)? })
            })?;
            rows.collect()
        })
    }
    /// An attempt succeeded: delete its row, unless it was replaced or queued again meanwhile.
    pub fn effect_done(&self, kind: &str, row: &EffectRow) {
        self.with(|db| {
            db.prepare_cached("DELETE FROM effect WHERE kind = ?1 AND key = ?2 AND seq = ?3 AND generation = ?4")?.execute(params![
                kind,
                row.key,
                row.seq,
                row.generation
            ])
        });
    }
    /// An attempt could not run now: try again at `due_ms` without counting a failure.
    pub fn effect_later(&self, kind: &str, row: &EffectRow, due_ms: i64) {
        self.with(|db| {
            db.prepare_cached("UPDATE effect SET due = ?1 WHERE kind = ?2 AND key = ?3 AND seq = ?4 AND generation = ?5")?.execute(params![
                due_ms,
                kind,
                row.key,
                row.seq,
                row.generation
            ])
        });
    }
    /// An attempt failed: count it, keep its error, and try again at `due_ms`.
    pub fn effect_failed(&self, kind: &str, row: &EffectRow, error: &str, due_ms: i64) {
        let error: String = error.chars().take(1000).collect();
        self.with(|db| {
            db.prepare_cached("UPDATE effect SET attempts = attempts + 1, error = ?1, due = ?2 WHERE kind = ?3 AND key = ?4 AND seq = ?5 AND generation = ?6")?
                .execute(params![error, due_ms, kind, row.key, row.seq, row.generation])
        });
    }
    /// A kind's queue, for its health entry.
    pub fn effect_summary(&self, kind: &str) -> EffectSummary {
        self.with(|db| {
            db.prepare_cached(
                "SELECT COUNT(*), MIN(since), IFNULL(MAX(attempts), 0),
                 (SELECT error FROM effect WHERE kind = ?1 AND attempts > 0 ORDER BY seq DESC LIMIT 1) FROM effect WHERE kind = ?1",
            )?
            .query_row(params![kind], |row| Ok(EffectSummary { waiting: row.get(0)?, since: row.get(1)?, attempts: row.get(2)?, error: row.get(3)? }))
        })
    }
    /// The consecutive failed attempts of one row, when it waits.
    pub fn effect_attempts(&self, kind: &str, key: &str) -> Option<i64> {
        self.with(|db| {
            db.prepare_cached("SELECT attempts FROM effect WHERE kind = ?1 AND key = ?2")?.query_row(params![kind, key], |row| row.get(0)).optional()
        })
    }
}
