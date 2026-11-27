/**
 * Read-only queries for views and tools.
 */

import type { Database } from "bun:sqlite";
import type { Decision, Thread, Ticket, Trigger } from "../core/index.ts";
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

interface IdValueRow {
  id: string;
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

interface TicketCountsRow {
  total: number;
  active: number;
}

/** Aggregate counts of stored tickets. */
export interface TicketCounts {
  total: number;
  active: number;
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
const SQL_TICKET_PAGE = "SELECT value FROM ticket ORDER BY rowid DESC LIMIT ?1 OFFSET ?2";
const SQL_TICKET_COUNT = "SELECT COUNT(*) AS count FROM ticket";
const SQL_TICKET_COUNTS =
  "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN open = 1 THEN 1 ELSE 0 END), 0) AS active FROM ticket";
const SQL_WORKER_TICKET_PAGE =
  "SELECT value FROM ticket ORDER BY (open IS NULL) ASC, value ->> '$.updatedAt' DESC, id DESC LIMIT ?1 OFFSET ?2";
const SQL_SENT_TICKET_OUTBOX =
  "SELECT value FROM outbox WHERE value ->> '$.status' = 'sent' AND value ->> '$.ticketId' IS NOT NULL AND value ->> '$.kind' = 'reply' ORDER BY rowid DESC";

const TRIGGER_BATCH_SIZE = 200;
const MAX_SENT_FILES_PER_TICKET = 20;
const DELIVERABLE_EXTENSIONS =
  "pdf|docx?|xlsx?|pptx?|csv|tsv|md|txt|json|jsonl|html?|png|jpe?g|webp|gif|svg|zip|tar|gz|tgz|rar|7z|mp3|mp4|wav|mov|epub|rtf|odt|ods|odp|xml|ya?ml|bin";
const STANDALONE_FILENAME_RE = new RegExp(
  `^[^\\r\\n<>:"|?*\\\\/:!！?？。，；,;]+\\.(?:${DELIVERABLE_EXTENSIONS}|py|ts|tsx|js|jsx|sql|sh|patch|diff|log)$`,
  "iu",
);
const INLINE_FILENAME_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_.-])([\\p{L}\\p{N}][\\p{L}\\p{N}._-]{0,120}\\.(?:${DELIVERABLE_EXTENSIONS}))(?!(?:[\\p{L}\\p{N}_-]|\\.[a-zA-Z0-9]))`,
  "giu",
);
const URL_RE = /https?:\/\/\S+/gi;

function extractReceiptFileNames(rawText: string): string[] {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return [];
  if (
    trimmed.length <= 180 &&
    !trimmed.includes("://") &&
    STANDALONE_FILENAME_RE.test(trimmed)
  ) {
    return [trimmed];
  }
  const withoutUrls = trimmed.replace(URL_RE, " ");
  const found: string[] = [];
  const seen = new Set<string>();
  INLINE_FILENAME_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_FILENAME_RE.exec(withoutUrls)) !== null) {
    const candidate = match[1];
    if (!seen.has(candidate)) {
      seen.add(candidate);
      found.push(candidate);
    }
  }
  return found;
}

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

/** One page of tickets, newest first. */
export function getTicketPage(db: Database, offset: number, limit: number): Ticket[] {
  return parseRows<Ticket>(db.query<ValueRow, [number, number]>(SQL_TICKET_PAGE).all(limit, offset));
}

/** Total number of stored tickets. */
export function getTicketCount(db: Database): number {
  const row = db.query<CountRow, []>(SQL_TICKET_COUNT).get();
  return row?.count ?? 0;
}

/** Total and open (active) counts of stored tickets. */
export function getTicketCounts(db: Database): TicketCounts {
  const row = db.query<TicketCountsRow, []>(SQL_TICKET_COUNTS).get();
  return {
    total: row?.total ?? 0,
    active: row?.active ?? 0,
  };
}

/** One page of tickets in worker-list order: open first, then each group by `updatedAt DESC, id DESC`. */
export function getWorkerTicketPage(db: Database, offset: number, limit: number): Ticket[] {
  if (limit <= 0) return [];
  return parseRows<Ticket>(
    db.query<ValueRow, [number, number]>(SQL_WORKER_TICKET_PAGE).all(limit, Math.max(0, offset)),
  );
}

/** Batch-fetch triggers by id in chunks of at most 200 placeholders to stay well under SQLite's bind limit. */
export function getTriggersByIds(db: Database, ids: readonly string[]): Map<string, Trigger> {
  const out = new Map<string, Trigger>();
  if (ids.length === 0) return out;
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += TRIGGER_BATCH_SIZE) {
    const batch = unique.slice(start, start + TRIGGER_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    const stmt = db.prepare<IdValueRow, string[]>(
      `SELECT id, value FROM trigger WHERE id IN (${placeholders})`,
    );
    try {
      const rows = stmt.all(...batch);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        out.set(row.id, JSON.parse(row.value) as Trigger);
      }
    } finally {
      stmt.finalize();
    }
  }
  return out;
}

/**
 * Best-effort map of `ticketId -> sent deliverable filenames` mined from sent outbox receipts, for historical
 * backfill; fault-tolerant and never throws.
 */
export function getSentFilesByTicket(db: Database): Map<string, string[]> {
  const out = new Map<string, string[]>();
  try {
    const rows = db.query<ValueRow, []>(SQL_SENT_TICKET_OUTBOX).all();
    for (let i = 0; i < rows.length; i++) {
      let parsed: Record<string, unknown>;
      try {
        const raw: unknown = JSON.parse(rows[i].value);
        if (typeof raw !== "object" || raw === null) continue;
        parsed = raw as Record<string, unknown>;
      } catch {
        continue;
      }
      const ticketId = typeof parsed.ticketId === "string" ? parsed.ticketId : undefined;
      if (ticketId === undefined || ticketId.length === 0) continue;
      const rawText =
        typeof parsed.text === "string"
          ? parsed.text
          : typeof parsed.message === "object" &&
              parsed.message !== null &&
              typeof (parsed.message as Record<string, unknown>).text === "string"
            ? ((parsed.message as Record<string, unknown>).text as string)
            : undefined;
      if (rawText === undefined || rawText.length === 0) continue;
      const names = extractReceiptFileNames(rawText);
      if (names.length === 0) continue;
      let list = out.get(ticketId);
      if (list === undefined) {
        list = [];
        out.set(ticketId, list);
      }
      for (const name of names) {
        if (list.length >= MAX_SENT_FILES_PER_TICKET) break;
        if (!list.includes(name)) {
          list.push(name);
        }
      }
    }
  } catch {
    // Fault-tolerant helper: return whatever was collected without throwing.
  }
  return out;
}
