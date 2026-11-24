/**
 * SQLite persistence for domain aggregates, key-value state, the channel outbox and the effect queue.
 *
 * One connection serves every caller. Transactions nest as savepoints, so the Engine's commands and the side effects
 * they queue commit or roll back together.
 */

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  threadKey,
  type Decision,
  type OutboundMessage,
  type ReplyStatus,
  type Repositories,
  type Thread,
  type Ticket,
  type Trigger,
  type TriggerDisposition,
} from "../core/index.ts";
import {
  effectAttempts,
  effectCancel,
  effectDone,
  effectDue,
  effectEnqueue,
  effectFailed,
  effectHead,
  effectLater,
  effectMaxSeq,
  effectNextDue,
  effectPending,
  effectSummary,
  effectWakeKind,
  type EffectRow,
  type EffectSummary,
} from "./effects.ts";
import {
  escapeLike,
  getDecisionsOfKinds,
  getDroppedReplies,
  getDroppedSince,
  getFailingReplies,
  getFirstTrigger,
  getNeighbours,
  getRecentDecisions,
  getRecentTriggers,
  getSentFilesByTicket,
  getSubscribedThreads,
  getThreadPage,
  getThreadTriggers,
  getTicketCount,
  getTicketPage,
  getTriggersByIds,
  searchTriggers,
  type FailingReply,
  type Place,
} from "./read.ts";
import {
  addReceipt,
  getReceipt,
  getReplyStatus,
  getWaitingReceipts,
  hasRepliedSince,
  isReceiptBehind,
  receiptMessage,
  recordSentReceipt,
  settledDropped,
  settledSent,
  settleReceipt,
  withdrawReceipt,
  type DropReason,
  type Dropped,
  type Receipt,
  type Settled,
} from "./receipts.ts";

export {
  receiptMessage,
  settledDropped,
  settledSent,
  type DropReason,
  type Dropped,
  type Receipt,
  type Settled,
};
export type { EffectRow, EffectSummary, FailingReply, Place };

/** The schema this build reads and writes. Earlier TypeScript deployments used schema 1 and are not migrated. */
export const SCHEMA_VERSION = 100;

/** Classification of a `StoreError`. */
export type StoreErrorKind = "schema" | "io";

/** A failure opening or using the database. */
export class StoreError extends Error {
  /** Whether the failure is a schema version mismatch or an I/O / SQLite error. */
  readonly kind: StoreErrorKind;
  /** The database schema version found when `kind === "schema"`. */
  readonly found?: number;

  private constructor(kind: StoreErrorKind, message: string, found?: number) {
    super(message);
    this.name = "StoreError";
    this.kind = kind;
    if (found !== undefined) {
      this.found = found;
    }
  }

  /** The database belongs to another version of the program. */
  static schema(found: number): StoreError {
    return new StoreError(
      "schema",
      `Unsupported database schema ${found} (this version uses ${SCHEMA_VERSION}); state from another version is not migrated, start with a new empty data directory`,
      found,
    );
  }

  /** SQLite or the filesystem failed. */
  static io(message: string): StoreError {
    return new StoreError("io", message);
  }

  override toString(): string {
    return this.message;
  }
}

/** Type guard for `StoreError`. */
export function isStoreError(error: unknown): error is StoreError {
  return error instanceof StoreError;
}

/** Ensure Bun's per-Database `db.query(sql)` LRU cache holds every prepared statement without thrashing. */
if (Database.MAX_QUERY_CACHE_SIZE < 128) {
  Database.MAX_QUERY_CACHE_SIZE = 128;
}

/** Generated columns and partial indexes defining the working sets, so passes scan only active rows. */
const SETS: ReadonlyArray<readonly [table: string, name: string, definition: string]> = [
  ["ticket", "open", "INTEGER AS (CASE WHEN value -> '$.ended' IS NULL THEN 1 END)"],
  // Only the latest assignment can be pending or running because the Engine closes one before adding the next.
  [
    "ticket",
    "active",
    "INTEGER AS (CASE WHEN json_array_length(value, '$.undelivered') > 0 OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END)",
  ],
  [
    "thread",
    "active",
    "INTEGER AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 END)",
  ],
  [
    "thread",
    "subscribed",
    "TEXT AS (CASE WHEN json_array_length(value, '$.subscriptions') > 0 THEN value ->> '$.ref.source' END)",
  ],
  ["outbox", "dropped", "TEXT AS (value ->> '$.dropped.at')"],
  // Ticket and conversation together, to keep the order of a ticket's replies to one conversation.
  [
    "outbox",
    "pending",
    "TEXT AS (CASE WHEN value ->> '$.status' = 'pending' AND value ->> '$.ticketId' IS NOT NULL THEN (value ->> '$.ticketId') || ' ' || (value ->> '$.channel.thread') END)",
  ],
];

const PRAGMAS_AND_KV_SQL =
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-16000; PRAGMA mmap_size=67108864; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

const SCHEMA_TABLES_AND_INDEXES_SQL = `BEGIN;
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
CREATE INDEX IF NOT EXISTS outbox_ticket_reply ON outbox(value ->> '$.ticketId', value ->> '$.queuedAt') WHERE value ->> '$.kind' = 'reply';`;

const CACHED_SAVEPOINT_LEVELS = 8;
const SAVEPOINT_SQL = Array.from({ length: CACHED_SAVEPOINT_LEVELS }, (_, level) => `SAVEPOINT neo_atomic_${level}`);
const RELEASE_SQL = Array.from({ length: CACHED_SAVEPOINT_LEVELS }, (_, level) => `RELEASE neo_atomic_${level}`);
const ROLLBACK_TO_SQL = Array.from(
  { length: CACHED_SAVEPOINT_LEVELS },
  (_, level) => `ROLLBACK TO neo_atomic_${level}`,
);

const SQL_KV_GET = "SELECT value FROM kv WHERE key=?1";
const SQL_KV_SET = "INSERT INTO kv VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
const SQL_KV_DELETE = "DELETE FROM kv WHERE key=?1";
const SQL_KV_KEYS = "SELECT key FROM kv WHERE key LIKE ?1 ESCAPE '\\' ORDER BY key";

const SQL_TRIGGER_GET = "SELECT value FROM trigger WHERE id=?1";
const SQL_TRIGGER_UPSERT =
  "INSERT INTO trigger VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at";
const SQL_TRIGGER_THREAD_DELETE = "DELETE FROM trigger_thread WHERE id=?1";
const SQL_TRIGGER_THREAD_INSERT = "INSERT OR IGNORE INTO trigger_thread VALUES (?1,?2,?3,?4)";

const SQL_DISPOSITION_GET = "SELECT value FROM disposition WHERE id=?1";
const SQL_DISPOSITION_UPSERT =
  "INSERT INTO disposition VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value";

const SQL_THREAD_GET = "SELECT value FROM thread WHERE key=?1";
const SQL_THREAD_UPSERT =
  "INSERT INTO thread VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
const SQL_THREADS_ALL = "SELECT value FROM thread ORDER BY rowid";
const SQL_THREADS_ACTIVE = "SELECT value FROM thread WHERE active = 1 ORDER BY rowid";

const SQL_TICKET_GET = "SELECT value FROM ticket WHERE id=?1";
const SQL_TICKET_UPSERT =
  "INSERT INTO ticket VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value";
const SQL_TICKETS_ALL = "SELECT value FROM ticket ORDER BY rowid DESC";
const SQL_TICKETS_OPEN = "SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC";
const SQL_TICKETS_ACTIVE = "SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC";
const SQL_TICKETS_RECENT = "SELECT value FROM ticket ORDER BY rowid DESC LIMIT ?1";

const SQL_DECISION_GET = "SELECT value FROM decision WHERE id=?1";
const SQL_DECISION_UPSERT =
  "INSERT INTO decision VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread";
const SQL_DECISIONS_BY_THREAD = "SELECT value FROM decision WHERE thread=?1 ORDER BY rowid";

interface ValueRow {
  value: string;
}

interface KeyRow {
  key: string;
}

interface CountRow {
  count: number;
}

function parseSchemaVersion(raw: string): number {
  if (!/^[+-]?\d+$/.test(raw)) return -1;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function restrict(target: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(target, mode);
  } catch {
    // Match Rust `let _ = set_permissions(...)`: ignore best-effort permission errors.
  }
}

function isPatchEntries(
  patch: Readonly<Record<string, unknown>> | ReadonlyArray<readonly [string, unknown]>,
): patch is ReadonlyArray<readonly [string, unknown]> {
  return Array.isArray(patch);
}

function parseRows<T>(rows: ValueRow[]): T[] {
  const out = new Array<T>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    out[i] = JSON.parse(rows[i].value) as T;
  }
  return out;
}

/** SQLite persistence for domain state. */
export class Store implements Repositories {
  private readonly db: Database;
  private depth = 0;
  private readonly committed: Array<Array<() => void>> = [];
  private readonly ticketSavedListeners = new Set<(ticket: Ticket) => void>();
  private readonly threadSavedListeners = new Set<(thread: Thread) => void>();
  private closed = false;

  private constructor(db: Database) {
    this.db = db;
  }

  /** Open (or create) the database at `dbPath`, refusing one written by another schema version. */
  static open(dbPath: string): Store {
    const parent = path.dirname(dbPath);
    if (parent !== "" && parent !== ".") {
      try {
        mkdirSync(parent, { recursive: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw StoreError.io(`Cannot create ${parent}: ${message}`);
      }
      restrict(parent, 0o700);
    }
    let db: Database;
    try {
      db = new Database(dbPath, { create: true, readwrite: true });
    } catch (error) {
      throw StoreError.io(error instanceof Error ? error.message : String(error));
    }
    restrict(dbPath, 0o600);
    const store = Store.prepare(db);
    restrict(dbPath, 0o600);
    return store;
  }

  /** An in-memory database, for tests. */
  static memory(): Store {
    const db = new Database(":memory:");
    return Store.prepare(db);
  }

  private static prepare(db: Database): Store {
    try {
      db.run(PRAGMAS_AND_KV_SQL);
      const versionRow = db
        .query<ValueRow, []>("SELECT value FROM kv WHERE key='schema'")
        .get();
      const version = versionRow !== null ? parseSchemaVersion(versionRow.value) : undefined;
      if (version !== undefined && version !== SCHEMA_VERSION) {
        throw StoreError.schema(version);
      }
      db.run(SCHEMA_TABLES_AND_INDEXES_SQL);
      for (const [table, name, definition] of SETS) {
        const existsRow = db
          .query<CountRow, [string, string]>(
            "SELECT COUNT(*) AS count FROM pragma_table_xinfo(?1) WHERE name = ?2",
          )
          .get(table, name);
        if ((existsRow?.count ?? 0) === 0) {
          db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
        db.run(`CREATE INDEX IF NOT EXISTS ${table}_${name} ON ${table}(${name}) WHERE ${name} IS NOT NULL`);
      }
      if (version === undefined) {
        db.query("INSERT INTO kv VALUES ('schema', ?1)").run(String(SCHEMA_VERSION));
      }
      db.run("COMMIT");
      return new Store(db);
    } catch (error) {
      try {
        if (db.inTransaction) {
          db.run("ROLLBACK");
        }
      } catch {
        // Ignore rollback errors during cleanup.
      }
      try {
        db.close();
      } catch {
        // Ignore close errors during cleanup.
      }
      if (error instanceof StoreError) {
        throw error;
      }
      throw StoreError.io(error instanceof Error ? error.message : String(error));
    }
  }

  /** Close the underlying SQLite database connection (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // Transactions and post-commit callbacks

  /** Open a (possibly nested) transaction savepoint. */
  begin(): void {
    const level = this.depth;
    if (level < CACHED_SAVEPOINT_LEVELS) {
      this.db.query(SAVEPOINT_SQL[level]).run();
    } else {
      this.db.run(`SAVEPOINT neo_atomic_${level}`);
    }
    this.depth += 1;
    this.committed.push([]);
  }

  /** Commit the innermost transaction savepoint; post-commit callbacks run only after the outermost commit. */
  commit(): void {
    if (this.depth === 0) {
      return;
    }
    this.depth -= 1;
    const level = this.depth;
    if (level < CACHED_SAVEPOINT_LEVELS) {
      this.db.query(RELEASE_SQL[level]).run();
    } else {
      this.db.run(`RELEASE neo_atomic_${level}`);
    }
    const actions = this.committed.pop() ?? [];
    if (level > 0) {
      const parent = this.committed[level - 1];
      for (let i = 0; i < actions.length; i++) {
        parent.push(actions[i]);
      }
      return;
    }
    for (let i = 0; i < actions.length; i++) {
      actions[i]();
    }
  }

  /** Roll the innermost transaction savepoint back and discard its queued post-commit callbacks. */
  rollback(): void {
    if (this.depth === 0) {
      return;
    }
    this.depth -= 1;
    const level = this.depth;
    if (level < CACHED_SAVEPOINT_LEVELS) {
      this.db.query(ROLLBACK_TO_SQL[level]).run();
      this.db.query(RELEASE_SQL[level]).run();
    } else {
      this.db.run(`ROLLBACK TO neo_atomic_${level}`);
      this.db.run(`RELEASE neo_atomic_${level}`);
    }
    this.committed.pop();
  }

  /**
   * Run `work` in a transaction (a savepoint when one is open): committed on normal return, rolled back if `work`
   * throws. Post-commit callbacks run only after the outermost transaction commits.
   */
  atomic<T>(work: () => T): T {
    this.begin();
    let result: T;
    try {
      result = work();
    } catch (error) {
      this.rollback();
      throw error;
    }
    this.commit();
    return result;
  }

  /**
   * Run `action` once the outermost transaction commits, or at once outside a transaction; one queued in a
   * transaction that rolls back never runs. For in-memory follow-ups to a committed write that need not survive a
   * restart; durable side effects go through the effect queue.
   */
  afterCommit(action: () => void): void {
    if (this.depth === 0) {
      action();
    } else {
      this.committed[this.depth - 1].push(action);
    }
  }

  /**
   * Subscribe to committed `saveTicket` writes (dispatched via `afterCommit`, never on rollback).
   * Returns an idempotent unsubscribe function.
   */
  onTicketSaved(listener: (ticket: Ticket) => void): () => void {
    this.ticketSavedListeners.add(listener);
    return () => {
      this.ticketSavedListeners.delete(listener);
    };
  }

  /**
   * Subscribe to committed `saveThread` writes (dispatched via `afterCommit`, never on rollback).
   * Returns an idempotent unsubscribe function.
   */
  onThreadSaved(listener: (thread: Thread) => void): () => void {
    this.threadSavedListeners.add(listener);
    return () => {
      this.threadSavedListeners.delete(listener);
    };
  }

  // Key-value records

  /** A typed KV record. */
  get<V = unknown>(key: string): V | undefined {
    const row = this.db.query<ValueRow, [string]>(SQL_KV_GET).get(key);
    return row !== null ? (JSON.parse(row.value) as V) : undefined;
  }

  /** Write a typed KV record. */
  set<V>(key: string, value: V): void {
    this.db.query(SQL_KV_SET).run(key, JSON.stringify(value));
  }

  /** Delete a KV record. */
  delete(key: string): void {
    this.db.query(SQL_KV_DELETE).run(key);
  }

  /** The KV keys that start with `prefix`, in key order. */
  keys(prefix: string): string[] {
    const pattern = `${escapeLike(prefix)}%`;
    const rows = this.db.query<KeyRow, [string]>(SQL_KV_KEYS).all(pattern);
    const out = new Array<string>(rows.length);
    for (let i = 0; i < rows.length; i++) {
      out[i] = rows[i].key;
    }
    return out;
  }

  /** Set or remove (`undefined`) source-specific metadata keys on a thread; no-op if the thread does not exist. */
  patchThreadMeta(
    key: string,
    patch: Readonly<Record<string, unknown>> | ReadonlyArray<readonly [string, unknown]>,
  ): void {
    this.atomic(() => {
      const thread = this.thread(key);
      if (thread === undefined) return;
      const before = JSON.stringify(thread.meta);
      const entries: ReadonlyArray<readonly [string, unknown]> = isPatchEntries(patch)
        ? patch
        : Object.entries(patch);
      for (const [name, value] of entries) {
        if (value === undefined) {
          delete thread.meta[name];
        } else {
          thread.meta[name] = value;
        }
      }
      if (JSON.stringify(thread.meta) !== before) {
        this.saveThread(thread);
      }
    });
  }

  /** The latest `limit` tickets, newest first. */
  recentTickets(limit: number): Ticket[] {
    return parseRows<Ticket>(this.db.query<ValueRow, [number]>(SQL_TICKETS_RECENT).all(limit));
  }

  // Repositories implementation

  trigger(id: string): Trigger | undefined {
    const row = this.db.query<ValueRow, [string]>(SQL_TRIGGER_GET).get(id);
    return row !== null ? (JSON.parse(row.value) as Trigger) : undefined;
  }

  saveTrigger(trigger: Trigger): void {
    const json = JSON.stringify(trigger);
    this.db.query(SQL_TRIGGER_UPSERT).run(trigger.id, json, trigger.at);
    this.db.query(SQL_TRIGGER_THREAD_DELETE).run(trigger.id);
    const insert = this.db.query(SQL_TRIGGER_THREAD_INSERT);
    const human = trigger.human ? 1 : 0;
    for (let i = 0; i < trigger.threads.length; i++) {
      insert.run(threadKey(trigger.threads[i]), trigger.id, trigger.at, human);
    }
  }

  disposition(id: string): TriggerDisposition | undefined {
    const row = this.db.query<ValueRow, [string]>(SQL_DISPOSITION_GET).get(id);
    return row !== null ? (JSON.parse(row.value) as TriggerDisposition) : undefined;
  }

  saveDisposition(id: string, value: TriggerDisposition): void {
    this.db.query(SQL_DISPOSITION_UPSERT).run(id, JSON.stringify(value));
  }

  thread(key: string): Thread | undefined {
    const row = this.db.query<ValueRow, [string]>(SQL_THREAD_GET).get(key);
    return row !== null ? (JSON.parse(row.value) as Thread) : undefined;
  }

  saveThread(thread: Thread): void {
    const json = JSON.stringify(thread);
    this.db.query(SQL_THREAD_UPSERT).run(thread.key, json);
    if (this.threadSavedListeners.size > 0) {
      this.afterCommit(() => {
        if (this.threadSavedListeners.size === 0) return;
        for (const listener of [...this.threadSavedListeners]) {
          listener(JSON.parse(json) as Thread);
        }
      });
    }
  }

  threads(): Thread[] {
    return parseRows<Thread>(this.db.query<ValueRow, []>(SQL_THREADS_ALL).all());
  }

  activeThreads(): Thread[] {
    return parseRows<Thread>(this.db.query<ValueRow, []>(SQL_THREADS_ACTIVE).all());
  }

  ticket(id: string): Ticket | undefined {
    const row = this.db.query<ValueRow, [string]>(SQL_TICKET_GET).get(id);
    return row !== null ? (JSON.parse(row.value) as Ticket) : undefined;
  }

  saveTicket(ticket: Ticket): void {
    const json = JSON.stringify(ticket);
    this.db.query(SQL_TICKET_UPSERT).run(ticket.id, json);
    if (this.ticketSavedListeners.size > 0) {
      this.afterCommit(() => {
        if (this.ticketSavedListeners.size === 0) return;
        for (const listener of [...this.ticketSavedListeners]) {
          listener(JSON.parse(json) as Ticket);
        }
      });
    }
  }

  tickets(): Ticket[] {
    return parseRows<Ticket>(this.db.query<ValueRow, []>(SQL_TICKETS_ALL).all());
  }

  openTickets(): Ticket[] {
    return parseRows<Ticket>(this.db.query<ValueRow, []>(SQL_TICKETS_OPEN).all());
  }

  activeTickets(): Ticket[] {
    return parseRows<Ticket>(this.db.query<ValueRow, []>(SQL_TICKETS_ACTIVE).all());
  }

  decision(id: string): Decision | undefined {
    const row = this.db.query<ValueRow, [string]>(SQL_DECISION_GET).get(id);
    return row !== null ? (JSON.parse(row.value) as Decision) : undefined;
  }

  saveDecision(decision: Decision): void {
    this.db.query(SQL_DECISION_UPSERT).run(decision.id, decision.threadKey, JSON.stringify(decision));
  }

  decisionsByThread(key: string): Decision[] {
    return parseRows<Decision>(this.db.query<ValueRow, [string]>(SQL_DECISIONS_BY_THREAD).all(key));
  }

  // Read queries (read.ts)

  /** Triggers newest first by arrival order rather than by their own timestamp. */
  recentTriggers(offset: number, limit: number): Trigger[] {
    return getRecentTriggers(this.db, offset, limit);
  }

  /** The latest `limit` triggers on a thread, oldest first, optionally bounded before (or `through`) a place. */
  threadTriggers(thread: string, limit: number, before?: Place, through = false): Trigger[] {
    return getThreadTriggers(this.db, thread, limit, before, through);
  }

  /** One page of a thread's triggers, newest first. */
  threadPage(thread: string, offset: number, limit: number): Trigger[] {
    return getThreadPage(this.db, thread, offset, limit);
  }

  /** The nearest triggers on a thread immediately before and after a place. */
  neighbours(thread: string, place: Place): [Trigger | undefined, Trigger | undefined] {
    return getNeighbours(this.db, thread, place);
  }

  /** The oldest trigger on a thread, used to title it. */
  firstTrigger(thread: string, humanOnly: boolean): Trigger | undefined {
    return getFirstTrigger(this.db, thread, humanOnly);
  }

  /** Triggers whose id or message id is `query`, or whose text contains it, newest first. */
  searchTriggers(query: string, limit: number): Trigger[] {
    return searchTriggers(this.db, query, limit);
  }

  /** Decisions newest first. */
  recentDecisions(offset: number, limit: number): Decision[] {
    return getRecentDecisions(this.db, offset, limit);
  }

  /** The newest decisions of the given kinds, to surface rare outcomes among many ignores. */
  decisionsOfKinds(kinds: readonly string[], limit: number): Decision[] {
    return getDecisionsOfKinds(this.db, kinds, limit);
  }

  /** Messages whose `reply` effect failed, with their failure count and last error, oldest first. */
  failingReplies(): FailingReply[] {
    return getFailingReplies(this.db);
  }

  /** The latest dropped messages, newest first. */
  droppedReplies(limit: number): Receipt[] {
    return getDroppedReplies(this.db, limit);
  }

  /** How many messages were dropped at or after `since`. */
  droppedSince(since: string): number {
    return getDroppedSince(this.db, since);
  }

  /** The threads tickets subscribe to, of one Source or of all. */
  subscribedThreads(source?: string): Thread[] {
    return getSubscribedThreads(this.db, source);
  }

  /** One page of tickets, newest first. */
  ticketPage(offset: number, limit: number): Ticket[] {
    return getTicketPage(this.db, offset, limit);
  }

  /** Total number of stored tickets. */
  ticketCount(): number {
    return getTicketCount(this.db);
  }

  /** Batch-fetch triggers by id in chunks, avoiding SQLite bind-parameter limits and N+1 queries. */
  triggersByIds(ids: readonly string[]): Map<string, Trigger> {
    return getTriggersByIds(this.db, ids);
  }

  /** Best-effort map of `ticketId -> sent deliverable filenames` mined from sent outbox receipts. */
  sentFilesByTicket(): Map<string, string[]> {
    return getSentFilesByTicket(this.db);
  }

  // Receipts (receipts.ts)

  /** The receipt of a queued message. */
  receipt(id: string): Receipt | undefined {
    return getReceipt(this.db, id);
  }

  /** Delivery status of a queued message. */
  replyStatus(id: string): ReplyStatus | undefined {
    return getReplyStatus(this.db, id);
  }

  /** Pending receipts, oldest first. */
  waitingReceipts(): Receipt[] {
    return getWaitingReceipts(this.db);
  }

  /**
   * True if an earlier message for the same ticket and conversation is still pending with fewer than `failures`
   * consecutive failed `reply` effect attempts.
   */
  receiptBehind(id: string, failures: number): boolean {
    return isReceiptBehind(this.db, id, failures);
  }

  /** Record a new pending receipt; a message id recorded before keeps its original receipt. Returns whether it was new. */
  addReceipt(message: OutboundMessage): boolean {
    return addReceipt(this.db, message);
  }

  /** Record a message that already went out directly (such as a media upload), queued at least as recently as `since`. */
  recordSentReceipt(message: OutboundMessage, since: string): void {
    recordSentReceipt(this.db, message, since);
  }

  /** True when a reply for `ticketId` was queued at or after `since`. */
  repliedSince(ticketId: string, since: string): boolean {
    return hasRepliedSince(this.db, ticketId, since);
  }

  /**
   * Mark a pending receipt sent or dropped, recreating the receipt if the message was withdrawn while being sent so
   * its id cannot be queued again.
   */
  settleReceipt(message: OutboundMessage, outcome: Settled): void {
    settleReceipt(this.db, message, outcome);
  }

  /** Withdraw a pending message that has not gone out. Returns whether one was waiting and removed. */
  withdrawReceipt(id: string): boolean {
    return withdrawReceipt(this.db, id);
  }

  // Effects (effects.ts)

  /** The highest queue position ever given out. */
  effectMaxSeq(): number {
    return effectMaxSeq(this.db);
  }

  /**
   * Upsert an effect in the caller's transaction, coalescing with a waiting row of the same kind and key, which
   * keeps its queue position, takes the new payload and starts over.
   */
  effectEnqueue(kind: string, key: string, payload: string, seq: number, nowMs: number): void {
    effectEnqueue(this.db, kind, key, payload, seq, nowMs);
  }

  /** Whether a row of `kind` waits, or the one with `key`. */
  effectPending(kind: string, key?: string): boolean {
    return effectPending(this.db, kind, key);
  }

  /** Drop a queued row; an attempt of it that already runs finishes normally. */
  effectCancel(kind: string, key: string): void {
    effectCancel(this.db, kind, key);
  }

  /** The oldest row of a kind, due or not: an ordered kind waits behind it. */
  effectHead(kind: string): EffectRow | undefined {
    return effectHead(this.db, kind);
  }

  /** Up to `limit` rows of a kind that are due, in queue order. */
  effectDue(kind: string, nowMs: number, limit: number): EffectRow[] {
    return effectDue(this.db, kind, nowMs, limit);
  }

  /** The earliest `due` timestamp across all queued effects, or `undefined` when empty. */
  effectNextDue(): number | undefined {
    return effectNextDue(this.db);
  }

  /** Pull unfailed waiting effects of `kind` forward to `nowMs`. */
  effectWakeKind(kind: string, nowMs: number): void {
    effectWakeKind(this.db, kind, nowMs);
  }

  /** An attempt succeeded: delete its row, unless it was replaced or queued again meanwhile. */
  effectDone(kind: string, row: EffectRow): void {
    effectDone(this.db, kind, row);
  }

  /** An attempt could not run now: try again at `dueMs` without counting a failure. */
  effectLater(kind: string, row: EffectRow, dueMs: number): void {
    effectLater(this.db, kind, row, dueMs);
  }

  /** An attempt failed: count it, keep its error, and try again at `dueMs`. */
  effectFailed(kind: string, row: EffectRow, error: string, dueMs: number): void {
    effectFailed(this.db, kind, row, error, dueMs);
  }

  /** A kind's queue, for its health entry. */
  effectSummary(kind: string): EffectSummary {
    return effectSummary(this.db, kind);
  }

  /** The consecutive failed attempts of one row, when it waits. */
  effectAttempts(kind: string, key: string): number | undefined {
    return effectAttempts(this.db, kind, key);
  }
}
