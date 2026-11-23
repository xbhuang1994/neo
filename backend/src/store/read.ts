/**
 * Read-only queries for views and tools.
 */

import type { Database } from "bun:sqlite";
import type { Decision, Thread, Trigger } from "../core/index.ts";
import type { Receipt } from "./receipts.ts";

/** A Trigger's position on its thread timeline, ordered by timestamp and then id. */
export interface Place {
  /** The Trigger's time. */
  at: string;
  /** The Trigger's id, as the tie-breaker. */
  id: string;
}

/** A message whose delivery keeps failing. */
export interface FailingReply {
  /** The message's receipt. */
  receipt: Receipt;
  /** Consecutive failed attempts. */
  attempts: number;
  /** The last error. */
  error: string;
}

interface ValueRow {
  value: string;
}

interface FailingReplyRow {
  value: string;
  attempts: number;
  error: string;
}

interface CountRow {
  count: number;
}

/** Escapes `LIKE` wildcards (`\`, `%`, `_`) for a pattern used with `ESCAPE '\'`. */
export function escapeLike(text: string): string {
  let out = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 92 || code === 37 || code === 95) {
      if (i > start) out += text.slice(start, i);
      out += "\\" + text[i];
      start = i + 1;
    }
  }
  if (start === 0) return text;
  if (start < text.length) out += text.slice(start);
  return out;
}

function parseRows<T>(rows: ValueRow[]): T[] {
  const out = new Array<T>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    out[i] = JSON.parse(rows[i].value) as T;
  }
  return out;
}

const SQL_RECENT_TRIGGERS = "SELECT value FROM trigger ORDER BY rowid DESC LIMIT ?1 OFFSET ?2";
const SQL_THREAD_TRIGGERS_LATEST =
  "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 ORDER BY x.at DESC, x.id DESC LIMIT ?2";
const SQL_THREAD_TRIGGERS_BEFORE =
  "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 AND (x.at, x.id) < (?2, ?3) ORDER BY x.at DESC, x.id DESC LIMIT ?4";
const SQL_THREAD_TRIGGERS_THROUGH =
  "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 AND (x.at, x.id) <= (?2, ?3) ORDER BY x.at DESC, x.id DESC LIMIT ?4";
const SQL_THREAD_PAGE =
  "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 ORDER BY x.at DESC, t.rowid DESC LIMIT ?2 OFFSET ?3";
const SQL_NEIGHBOUR_BEFORE =
  "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 AND (x.at, x.id) < (?2, ?3) ORDER BY x.at DESC, x.id DESC LIMIT 1";
const SQL_NEIGHBOUR_AFTER =
  "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 AND (x.at, x.id) > (?2, ?3) ORDER BY x.at ASC, x.id ASC LIMIT 1";
const SQL_FIRST_TRIGGER_ALL =
  "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 ORDER BY x.at ASC, t.rowid ASC LIMIT 1";
const SQL_FIRST_TRIGGER_HUMAN =
  "SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ?1 AND x.human = 1 ORDER BY x.at ASC, t.rowid ASC LIMIT 1";
const SQL_SEARCH_TRIGGERS =
  "SELECT value FROM trigger WHERE id = ?1 OR json_extract(value, '$.meta.messageId') = ?1 OR json_extract(value, '$.text') LIKE ?2 ESCAPE '\\' ORDER BY at DESC LIMIT ?3";
const SQL_RECENT_DECISIONS = "SELECT value FROM decision ORDER BY rowid DESC LIMIT ?1 OFFSET ?2";
const SQL_DECISIONS_OF_KINDS =
  "SELECT value FROM decision WHERE json_extract(value, '$.kind') IN (SELECT value FROM json_each(?1)) ORDER BY rowid DESC LIMIT ?2";
const SQL_FAILING_REPLIES =
  "SELECT o.value AS value, e.attempts AS attempts, e.error AS error FROM effect e JOIN outbox o ON o.id = e.key WHERE e.kind = 'reply' AND e.attempts > 0 ORDER BY e.seq";
const SQL_DROPPED_REPLIES = "SELECT value FROM outbox WHERE dropped IS NOT NULL ORDER BY dropped DESC LIMIT ?1";
const SQL_DROPPED_SINCE = "SELECT COUNT(*) AS count FROM outbox WHERE dropped >= ?1";
const SQL_SUBSCRIBED_BY_SOURCE = "SELECT value FROM thread WHERE subscribed = ?1 ORDER BY rowid";
const SQL_SUBSCRIBED_ALL =
  "SELECT value FROM thread INDEXED BY thread_subscribed WHERE subscribed IS NOT NULL ORDER BY rowid";

/** Triggers newest first by arrival order rather than by their own timestamp. */
export function getRecentTriggers(db: Database, offset: number, limit: number): Trigger[] {
  return parseRows<Trigger>(db.query<ValueRow, [number, number]>(SQL_RECENT_TRIGGERS).all(limit, offset));
}

/** The latest `limit` triggers on a thread, oldest first, optionally bounded before (or `through`) a place. */
export function getThreadTriggers(
  db: Database,
  thread: string,
  limit: number,
  before?: Place,
  through = false,
): Trigger[] {
  const rows =
    before === undefined
      ? db.query<ValueRow, [string, number]>(SQL_THREAD_TRIGGERS_LATEST).all(thread, limit)
      : db
          .query<ValueRow, [string, string, string, number]>(
            through ? SQL_THREAD_TRIGGERS_THROUGH : SQL_THREAD_TRIGGERS_BEFORE,
          )
          .all(thread, before.at, before.id, limit);
  const found = parseRows<Trigger>(rows);
  found.reverse();
  return found;
}

/** One page of a thread's triggers, newest first. */
export function getThreadPage(db: Database, thread: string, offset: number, limit: number): Trigger[] {
  return parseRows<Trigger>(
    db.query<ValueRow, [string, number, number]>(SQL_THREAD_PAGE).all(thread, limit, offset),
  );
}

/** The nearest triggers on a thread immediately before and after a place. */
export function getNeighbours(
  db: Database,
  thread: string,
  place: Place,
): [Trigger | undefined, Trigger | undefined] {
  const beforeRow = db
    .query<ValueRow, [string, string, string]>(SQL_NEIGHBOUR_BEFORE)
    .get(thread, place.at, place.id);
  const afterRow = db
    .query<ValueRow, [string, string, string]>(SQL_NEIGHBOUR_AFTER)
    .get(thread, place.at, place.id);
  return [
    beforeRow !== null ? (JSON.parse(beforeRow.value) as Trigger) : undefined,
    afterRow !== null ? (JSON.parse(afterRow.value) as Trigger) : undefined,
  ];
}

/** The oldest trigger on a thread, used to title it. */
export function getFirstTrigger(db: Database, thread: string, humanOnly: boolean): Trigger | undefined {
  const row = db
    .query<ValueRow, [string]>(humanOnly ? SQL_FIRST_TRIGGER_HUMAN : SQL_FIRST_TRIGGER_ALL)
    .get(thread);
  return row !== null ? (JSON.parse(row.value) as Trigger) : undefined;
}

/** Triggers whose id or message id is `query`, or whose text contains it, newest first. */
export function searchTriggers(db: Database, query: string, limit: number): Trigger[] {
  const contains = `%${escapeLike(query)}%`;
  return parseRows<Trigger>(
    db.query<ValueRow, [string, string, number]>(SQL_SEARCH_TRIGGERS).all(query, contains, limit),
  );
}

/** Decisions newest first. */
export function getRecentDecisions(db: Database, offset: number, limit: number): Decision[] {
  return parseRows<Decision>(db.query<ValueRow, [number, number]>(SQL_RECENT_DECISIONS).all(limit, offset));
}

/** The newest decisions of the given kinds, to surface rare outcomes among many ignores. */
export function getDecisionsOfKinds(
  db: Database,
  kinds: readonly string[],
  limit: number,
): Decision[] {
  const kindsJson = JSON.stringify(kinds);
  return parseRows<Decision>(
    db.query<ValueRow, [string, number]>(SQL_DECISIONS_OF_KINDS).all(kindsJson, limit),
  );
}

/** Messages whose `reply` effect failed, with their failure count and last error, oldest first. */
export function getFailingReplies(db: Database): FailingReply[] {
  const rows = db.query<FailingReplyRow, []>(SQL_FAILING_REPLIES).all();
  const out = new Array<FailingReply>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    out[i] = {
      receipt: JSON.parse(row.value) as Receipt,
      attempts: row.attempts,
      error: row.error,
    };
  }
  return out;
}

/** The latest dropped messages, newest first. */
export function getDroppedReplies(db: Database, limit: number): Receipt[] {
  return parseRows<Receipt>(db.query<ValueRow, [number]>(SQL_DROPPED_REPLIES).all(limit));
}

/** How many messages were dropped at or after `since`. */
export function getDroppedSince(db: Database, since: string): number {
  const row = db.query<CountRow, [string]>(SQL_DROPPED_SINCE).get(since);
  return row?.count ?? 0;
}

/** The threads tickets subscribe to, of one Source or of all. */
export function getSubscribedThreads(db: Database, source?: string): Thread[] {
  const rows =
    source !== undefined
      ? db.query<ValueRow, [string]>(SQL_SUBSCRIBED_BY_SOURCE).all(source)
      : db.query<ValueRow, []>(SQL_SUBSCRIBED_ALL).all();
  return parseRows<Thread>(rows);
}
