/**
 * The durable rows of the effect queue: side effects persisted inside command transactions and run after commit.
 *
 * This module only stores and selects rows; the dispatcher that runs them lives in the application.
 */

import type { Database } from "bun:sqlite";
import { formatIso } from "../core/index.ts";

/**
 * One queued effect. `seq` keeps its queue position; `generation` grows when its payload is replaced, so an attempt
 * that was running does not delete a newer payload.
 */
export interface EffectRow {
  /** The row's key within its kind. */
  key: string;
  /** The payload, as JSON. */
  value: string;
  /** Queue position. */
  seq: number;
  /** Payload generation. */
  generation: number;
  /** Consecutive failed attempts. */
  attempts: number;
  /** When it may next run, in epoch milliseconds. */
  due: number;
}

/** What a kind's queue looks like, for its health entry. */
export interface EffectSummary {
  /** How many rows wait. */
  waiting: number;
  /** Since when the oldest one waits. */
  since?: string;
  /** The most consecutive failures of any row. */
  attempts: number;
  /** The last failure's error. */
  error?: string;
}

interface MaxSeqRow {
  maxSeq: number;
}

interface HitRow {
  hit: number;
}

interface NextDueRow {
  nextDue: number | null;
}

interface SummaryRow {
  waiting: number;
  since: string | null;
  attempts: number;
  error: string | null;
}

interface AttemptsRow {
  attempts: number;
}

const SQL_MAX_SEQ = "SELECT IFNULL(MAX(seq), 0) AS maxSeq FROM effect";
const SQL_ENQUEUE =
  "INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due";
const SQL_PENDING_KIND = "SELECT 1 AS hit FROM effect WHERE kind = ?1 LIMIT 1";
const SQL_PENDING_KEY = "SELECT 1 AS hit FROM effect WHERE kind = ?1 AND key = ?2";
const SQL_CANCEL = "DELETE FROM effect WHERE kind = ?1 AND key = ?2";
const SQL_HEAD = "SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ?1 ORDER BY seq LIMIT 1";
const SQL_DUE =
  "SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ?1 AND due <= ?2 ORDER BY seq LIMIT ?3";
const SQL_NEXT_DUE = "SELECT MIN(due) AS nextDue FROM effect";
const SQL_WAKE_KIND = "UPDATE effect SET due = ?2 WHERE kind = ?1 AND attempts = 0 AND due > ?2";
const SQL_DONE = "DELETE FROM effect WHERE kind = ?1 AND key = ?2 AND seq = ?3 AND generation = ?4";
const SQL_LATER = "UPDATE effect SET due = ?1 WHERE kind = ?2 AND key = ?3 AND seq = ?4 AND generation = ?5";
const SQL_FAILED =
  "UPDATE effect SET attempts = attempts + 1, error = ?1, due = ?2 WHERE kind = ?3 AND key = ?4 AND seq = ?5 AND generation = ?6";
const SQL_SUMMARY =
  "SELECT COUNT(*) AS waiting, MIN(since) AS since, IFNULL(MAX(attempts), 0) AS attempts, (SELECT error FROM effect WHERE kind = ?1 AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error FROM effect WHERE kind = ?1";
const SQL_ATTEMPTS = "SELECT attempts FROM effect WHERE kind = ?1 AND key = ?2";

/** Truncate to at most `maxChars` Unicode scalar values (matching Rust `chars().take(1000)`). */
function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let count = 0;
  let index = 0;
  while (index < text.length && count < maxChars) {
    const code = text.charCodeAt(index);
    index += code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1;
    count += 1;
  }
  return text.slice(0, index);
}

/** The highest queue position ever given out. */
export function effectMaxSeq(db: Database): number {
  const row = db.query<MaxSeqRow, []>(SQL_MAX_SEQ).get();
  return row?.maxSeq ?? 0;
}

/**
 * Upsert an effect in the caller's transaction, coalescing with a waiting row of the same kind and key, which
 * keeps its queue position, takes the new payload and starts over.
 */
export function effectEnqueue(
  db: Database,
  kind: string,
  key: string,
  payload: string,
  seq: number,
  nowMs: number,
): void {
  db.query(SQL_ENQUEUE).run(kind, key, payload, seq, nowMs, formatIso(nowMs));
}

/** Whether a row of `kind` waits, or the one with `key`. */
export function effectPending(db: Database, kind: string, key?: string): boolean {
  if (key === undefined) {
    return db.query<HitRow, [string]>(SQL_PENDING_KIND).get(kind) !== null;
  }
  return db.query<HitRow, [string, string]>(SQL_PENDING_KEY).get(kind, key) !== null;
}

/** Drop a queued row; an attempt of it that already runs finishes normally. */
export function effectCancel(db: Database, kind: string, key: string): void {
  db.query(SQL_CANCEL).run(kind, key);
}

/** The oldest row of a kind, due or not: an ordered kind waits behind it. */
export function effectHead(db: Database, kind: string): EffectRow | undefined {
  return db.query<EffectRow, [string]>(SQL_HEAD).get(kind) ?? undefined;
}

/** Up to `limit` rows of a kind that are due, in queue order. */
export function effectDue(db: Database, kind: string, nowMs: number, limit: number): EffectRow[] {
  return db.query<EffectRow, [string, number, number]>(SQL_DUE).all(kind, nowMs, limit);
}

/** The earliest `due` timestamp across all queued effects, or `undefined` when empty. */
export function effectNextDue(db: Database): number | undefined {
  const row = db.query<NextDueRow, []>(SQL_NEXT_DUE).get();
  return row?.nextDue ?? undefined;
}

/** Pull unfailed waiting effects of `kind` forward to `nowMs`. */
export function effectWakeKind(db: Database, kind: string, nowMs: number): void {
  db.query(SQL_WAKE_KIND).run(kind, nowMs);
}

/** An attempt succeeded: delete its row, unless it was replaced or queued again meanwhile. */
export function effectDone(db: Database, kind: string, row: EffectRow): void {
  db.query(SQL_DONE).run(kind, row.key, row.seq, row.generation);
}

/** An attempt could not run now: try again at `dueMs` without counting a failure. */
export function effectLater(db: Database, kind: string, row: EffectRow, dueMs: number): void {
  db.query(SQL_LATER).run(dueMs, kind, row.key, row.seq, row.generation);
}

/** An attempt failed: count it, keep its error, and try again at `dueMs`. */
export function effectFailed(
  db: Database,
  kind: string,
  row: EffectRow,
  error: string,
  dueMs: number,
): void {
  db.query(SQL_FAILED).run(truncateChars(error, 1000), dueMs, kind, row.key, row.seq, row.generation);
}

/** A kind's queue, for its health entry. */
export function effectSummary(db: Database, kind: string): EffectSummary {
  const row = db.query<SummaryRow, [string]>(SQL_SUMMARY).get(kind);
  if (row === null) {
    return { waiting: 0, attempts: 0 };
  }
  const summary: EffectSummary = { waiting: row.waiting, attempts: row.attempts };
  if (row.since !== null) {
    summary.since = row.since;
  }
  if (row.error !== null) {
    summary.error = row.error;
  }
  return summary;
}

/** The consecutive failed attempts of one row, when it waits. */
export function effectAttempts(db: Database, kind: string, key: string): number | undefined {
  const row = db.query<AttemptsRow, [string, string]>(SQL_ATTEMPTS).get(kind, key);
  return row !== null ? row.attempts : undefined;
}
