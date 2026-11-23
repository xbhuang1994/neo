//! The effect queue's dispatcher: side effects persisted inside command transactions run after commit, per kind, with
//! concurrency limits, exponential backoff and health reporting. Rows survive a restart and run again.

import { nowMs } from "../core/index.ts";
import type { EffectRow, Store } from "../store/index.ts";
import { Health, type HealthBoard } from "./health.ts";

/** Build an Eval's candidate card and relay it to the main Session; the key is the Eval id. */
export const ASSESSMENT = "assessment";
/** Launch a pending Assignment; the key is the Assignment id. */
export const LAUNCH = "launch";
/** Hand a ticket's waiting Inputs to its running Assignment; the key is the Ticket id. */
export const DELIVERY = "delivery";
/** Steer a report or a candidate into the main Session; the key is the request id. */
export const RELAY = "relay";
/** Inject a notice into the main Session without waking it; the key names what it reports. */
export const NOTICE = "notice";
/** Send a message for a Channel through its Source; the key is the message id. */
export const REPLY = "reply";
/** Run a read-only Sidecar query against a ticket and send its answer; the key is the trigger id. */
export const SIDECAR = "sidecar";

/** Consecutive failures before an effect kind reports an error. */
export const FAILURES_BEFORE_ERROR = 3;

/** Default initial and maximum retry delay, in milliseconds. */
export const DEFAULT_RETRY: readonly [number, number] = [2_000, 60_000];

/** Classification of why an effect did not complete (matches Rust `Failure::Later` and `Failure::Error`). */
export type FailureKind = "later" | "error";

/**
 * Why an effect did not complete.
 *
 * Matches Rust `enum Failure { Later(String), Error(String) }` verbatim:
 * - `"later"`: it cannot run right now (paused, worker slot taken, waiting behind an earlier message); runs again
 *   after the initial retry delay without counting as a failure.
 * - `"error"`: it failed; runs again with exponential backoff and counts toward {@link FAILURES_BEFORE_ERROR}.
 */
export class Failure extends Error {
  /** Whether the effect is deferred (`"later"`) or failed (`"error"`). */
  readonly kind: FailureKind;

  constructor(kind: FailureKind, message: string) {
    super(message);
    this.name = "Failure";
    this.kind = kind;
  }

  /**
   * It cannot run right now, such as while processing is paused or every worker slot is taken: it runs again
   * after the initial retry delay, without counting as a failure.
   */
  static later(message: string): Failure {
    return new Failure("later", message);
  }

  /** It failed: it runs again with exponential backoff, and counts. */
  static error(message: string): Failure {
    return new Failure("error", message);
  }

  /** Convert an arbitrary error or message into a {@link Failure} (preserving an existing {@link Failure}). */
  static from(error: unknown): Failure {
    if (error instanceof Failure) {
      return error;
    }
    return Failure.error(error instanceof Error ? error.message : String(error));
  }

  override toString(): string {
    return this.message;
  }
}

/** Type guard for {@link Failure}. */
export function isFailure(value: unknown): value is Failure {
  return value instanceof Failure;
}

/** What an effect handler may return: `void` / `{ ok: true }` for success, or a {@link Failure}. */
export type EffectResult = void | Failure | { ok: true } | { ok: false; failure: Failure };

/** Runs one effect, given its JSON payload and key. */
export type Handler = (payload: unknown, key: string) => Promise<EffectResult> | EffectResult;

/** How a kind of effect runs. */
export interface Options {
  /**
   * How many may run at once now; 0 holds the kind, such as while processing is paused.
   * Accepts a dynamic getter (matching Rust `limit`) or a fixed concurrency number. Defaults to `1`.
   */
  limit?: number | (() => number);
  /**
   * Concurrency limit alias for {@link limit}. Used when {@link limit} is omitted.
   */
  maxConcurrent?: number | (() => number);
  /** Initial and maximum retry delay, in milliseconds. Defaults to `[2_000, 60_000]`. */
  retry?: readonly [number, number];
  /** Effects run one at a time in queue order, and a failed one holds back later rows of the kind. Defaults to `false`. */
  ordered?: boolean;
  /** Repeated failures do not mark the kind's health as failing, because they already show elsewhere. Defaults to `false`. */
  quiet?: boolean;
}

/** The clock, in epoch milliseconds. */
export type EffectClock = () => number;

interface NormalizedOptions {
  limit: () => number;
  retry: readonly [number, number];
  ordered: boolean;
  quiet: boolean;
}

interface KindEntry {
  run: Handler;
  options: NormalizedOptions;
}

interface ScheduledDue {
  kind: string;
  due: number;
  failed: boolean;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

function healthName(kind: string): string {
  return `effects:${kind}`;
}

function effectId(kind: string, key: string): string {
  return `${kind}\0${key}`;
}

function normalizeOptions(options: Options = {}): NormalizedOptions {
  const ordered = options.ordered ?? false;
  const quiet = options.quiet ?? false;
  const retry = options.retry ?? DEFAULT_RETRY;
  const rawLimit = options.limit !== undefined ? options.limit : (options.maxConcurrent ?? 1);
  const baseLimit = typeof rawLimit === "function" ? rawLimit : () => rawLimit;
  const safeLimit = (): number => {
    const value = baseLimit();
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }
    return Math.floor(value);
  };
  const limit = ordered ? (): number => Math.min(safeLimit(), 1) : safeLimit;
  return { limit, retry, ordered, quiet };
}

function formatUnexpectedError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  return String(error);
}

/** Durable queue of side effects, dispatched after commit. */
export class Effects {
  private readonly store: Store;
  private readonly board: HealthBoard;
  private readonly now: EffectClock;
  private readonly kinds = new Map<string, KindEntry>();
  /** Lexicographically sorted kind names, matching Rust `BTreeMap<String, Arc<Kind>>`. */
  private sortedKinds: string[] = [];
  private seq: number;
  private wakeGen = 0;
  /** Running effect keys grouped by kind for O(1) lookups. */
  private readonly runningByKind = new Map<string, Set<string>>();
  private runningTotal = 0;
  /** Known future retry deadlines written by `attempt()`, so the timer never busy-polls while other rows run. */
  private readonly futureDue = new Map<string, ScheduledDue>();
  private started = false;
  private stopped = false;
  private paused = false;
  private dispatchScheduled = false;
  private dueTimer: ReturnType<typeof setTimeout> | undefined;
  private dueTimerAt: number | undefined;
  /** Per-(kind, key) waiters for O(1) targeted wakeups (`waitFor`). */
  private readonly keyWaiters = new Map<string, Set<() => void>>();
  /** Per-kind waiters (`idle(kind)`, `waitFor`). */
  private readonly kindWaiters = new Map<string, Set<() => void>>();
  /** Global waiters (`idle()`, `drain()`). */
  private readonly anyWaiters = new Set<() => void>();

  /** A queue over the store, with the system clock (or a test clock when provided). */
  constructor(store: Store, board: HealthBoard, now: EffectClock = nowMs) {
    this.store = store;
    this.board = board;
    this.now = now;
    this.seq = store.effectMaxSeq();
  }

  /** A queue over the store, with a clock a test controls (matches Rust `Effects::with_clock`). */
  static withClock(store: Store, board: HealthBoard, now: EffectClock): Effects {
    return new Effects(store, board, now);
  }

  /**
   * Upsert an effect in the caller's transaction, coalescing with a waiting row of the same kind and key, which
   * keeps its place in the queue. It runs once the transaction commits.
   */
  enqueue(kind: string, key: string, payload: unknown): void {
    const serialized = JSON.stringify(payload === undefined ? null : payload);
    this.seq += 1;
    const seq = this.seq;
    this.store.effectEnqueue(kind, key, serialized, seq, this.now());
    this.store.afterCommit(() => {
      this.futureDue.delete(effectId(kind, key));
      this.kick();
    });
  }

  /**
   * Register the handler of a kind.
   *
   * Throws when the kind already has a handler.
   */
  handle(kind: string, run: Handler, options: Options = {}): void {
    if (this.kinds.has(kind)) {
      throw new Error(`The ${kind} effects already have a handler`);
    }
    this.kinds.set(kind, { run, options: normalizeOptions(options) });
    this.sortedKinds = Array.from(this.kinds.keys()).sort();
    this.report(kind);
    this.kick();
  }

  /** Whether an effect of `kind` waits, or the one with `key`. */
  pending(kind: string, key?: string): boolean {
    return this.store.effectPending(kind, key);
  }

  /** Drop a queued effect; one that already runs finishes normally. */
  cancel(kind: string, key: string): void {
    this.store.effectCancel(kind, key);
    this.store.afterCommit(() => {
      this.futureDue.delete(effectId(kind, key));
      this.report(kind);
      this.notifyFinished(kind, key);
    });
  }

  /** Start running effects; rows queued before wait until now. */
  start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    this.kick();
  }

  /** Pause or resume dispatching across all kinds; resuming wakes the dispatcher immediately. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) {
      return;
    }
    this.paused = paused;
    if (paused) {
      this.clearDueTimer();
    } else {
      this.kick();
    }
  }

  /** Whether dispatching is globally paused via {@link setPaused}. */
  isPaused(): boolean {
    return this.paused;
  }

  /** Pull unfailed waiting effects of `kind` forward to now and wake the dispatcher. */
  wakeKind(kind: string): void {
    this.wakeGen += 1;
    this.store.effectWakeKind(kind, this.now());
    for (const [id, scheduled] of this.futureDue) {
      if (scheduled.kind === kind && !scheduled.failed) {
        this.futureDue.delete(id);
      }
    }
    this.kick();
  }

  /** Run whatever is due as soon as possible. */
  kick(): void {
    if (!this.started || this.stopped || this.paused || this.dispatchScheduled) {
      return;
    }
    this.dispatchScheduled = true;
    queueMicrotask(() => {
      this.dispatchScheduled = false;
      if (!this.started || this.stopped || this.paused) {
        return;
      }
      this.dispatch();
    });
  }

  /** Alias for {@link kick}: wake the dispatcher immediately. */
  wake(): void {
    this.kick();
  }

  /** Whether any effect of `kind` (or specifically `(kind, key)`) is currently running. */
  isRunning(kind?: string, key?: string): boolean {
    if (kind === undefined) {
      return this.runningTotal > 0;
    }
    const set = this.runningByKind.get(kind);
    if (set === undefined || set.size === 0) {
      return false;
    }
    return key === undefined ? true : set.has(key);
  }

  /** Resolves once no effect of `kind` (or of any kind) runs and none can start: none is due, or its kind has no room. */
  async idle(kind?: string): Promise<void> {
    while (true) {
      this.dispatch();
      if (!this.isRunning(kind)) {
        return;
      }
      await this.awaitFinished(kind);
    }
  }

  /**
   * Resolves once `(kind, key)` is no longer pending (returns `true`), or once no effect of `kind` can make
   * progress on it right now or `timeoutMs` elapses (returns `false`).
   *
   * Uses a per-(kind, key) waiter map so callers waiting on a specific receipt wake immediately when their row
   * settles without draining unrelated in-flight items.
   */
  async waitFor(kind: string, key: string, timeoutMs?: number): Promise<boolean> {
    const deadline = timeoutMs !== undefined ? Date.now() + Math.max(0, timeoutMs) : undefined;
    while (true) {
      if (!this.store.effectPending(kind, key) && !this.isRunning(kind, key)) {
        return true;
      }
      this.dispatch();
      if (!this.store.effectPending(kind, key) && !this.isRunning(kind, key)) {
        return true;
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        return false;
      }
      if (this.isRunning(kind, key)) {
        const woke = await this.awaitKeyFinished(kind, key, deadline);
        if (!woke) {
          return false;
        }
        continue;
      }
      if (!this.isRunning(kind)) {
        return false;
      }
      const entry = this.kinds.get(kind);
      if (entry !== undefined && !entry.options.ordered) {
        const attempts = this.store.effectAttempts(kind, key);
        if (attempts !== undefined && attempts > 0) {
          return false;
        }
      }
      const woke = await this.awaitFinished(kind, deadline);
      if (!woke) {
        return false;
      }
    }
  }

  /** Stop starting effects and wait for the running ones; waiting rows stay for the next start. */
  async drain(): Promise<void> {
    this.stopped = true;
    this.clearDueTimer();
    while (this.runningTotal > 0) {
      await this.awaitFinished(undefined);
    }
  }

  /** Alias for {@link drain}: stop starting effects and drain in-flight handlers cleanly. */
  async stop(): Promise<void> {
    await this.drain();
  }

  /** Dispatch every currently due effect within each kind's concurrency room and arm the earliest-due timer. */
  dispatch(): void {
    if (!this.started || this.stopped || this.paused) {
      return;
    }
    let minOrderedDue: number | undefined;
    for (let i = 0; i < this.sortedKinds.length; i++) {
      const name = this.sortedKinds[i];
      const kind = this.kinds.get(name);
      if (kind === undefined) {
        continue;
      }
      const now = this.now();
      const runningSet = this.runningByKind.get(name);
      const runningCount = runningSet?.size ?? 0;

      // An ordered kind waits behind its oldest row even when it is not due yet.
      let rows: EffectRow[];
      if (kind.options.ordered) {
        if (runningCount === 0) {
          const head = this.store.effectHead(name);
          if (head === undefined) {
            rows = [];
          } else if (head.due <= now) {
            rows = [head];
          } else {
            minOrderedDue = minOrderedDue === undefined ? head.due : Math.min(minOrderedDue, head.due);
            rows = [];
          }
        } else {
          rows = [];
        }
      } else {
        const fetched = this.store.effectDue(name, now, 16 + runningCount);
        if (runningSet === undefined || runningCount === 0) {
          rows = fetched;
        } else {
          rows = [];
          for (let j = 0; j < fetched.length; j++) {
            const candidate = fetched[j];
            if (!runningSet.has(candidate.key)) {
              rows.push(candidate);
            }
          }
        }
      }

      if (rows.length === 0) {
        continue;
      }

      // The limit is asked only once something is ready to run.
      const room = Math.max(0, kind.options.limit() - runningCount);
      const toStart = Math.min(rows.length, room);
      for (let j = 0; j < toStart; j++) {
        const row = rows[j];
        this.addRunning(name, row.key);
        this.futureDue.delete(effectId(name, row.key));
        void this.runAttempt(name, kind, row);
      }
    }
    this.scheduleTimer(minOrderedDue);
  }

  private async runAttempt(name: string, kind: KindEntry, row: EffectRow): Promise<void> {
    try {
      await this.attempt(name, kind, row);
    } finally {
      this.removeRunning(name, row.key);
      this.notifyFinished(name, row.key);
      this.kick();
    }
  }

  private async attempt(name: string, kind: KindEntry, row: EffectRow): Promise<void> {
    const wakeGen = this.wakeGen;
    let payload: unknown = null;
    try {
      payload = JSON.parse(row.value);
    } catch {
      payload = null;
    }

    let failure: Failure | undefined;
    try {
      const outcome = await kind.run(payload, row.key);
      if (isFailure(outcome)) {
        failure = outcome;
      } else if (outcome !== undefined && typeof outcome === "object" && "ok" in outcome && outcome.ok === false) {
        failure = outcome.failure;
      }
    } catch (error) {
      // A handler that throws an unexpected error counts as a failure rather than leaving its row running forever.
      failure = isFailure(error)
        ? error
        : Failure.error(`The handler stopped unexpectedly: ${formatUnexpectedError(error)}`);
    }

    if (failure === undefined) {
      this.futureDue.delete(effectId(name, row.key));
      this.store.effectDone(name, row);
    } else if (this.stopped) {
      // Left untouched on shutdown, so it runs again on the next start.
      return;
    } else if (failure.kind === "later") {
      const now = this.now();
      const due = this.wakeGen !== wakeGen ? now : now + kind.options.retry[0];
      this.store.effectLater(name, row, due);
      if (due > now) {
        this.futureDue.set(effectId(name, row.key), { kind: name, due, failed: false });
      }
    } else {
      const [initial, most] = kind.options.retry;
      const shift = Math.min(Math.max(row.attempts, 0), 16);
      const delay = Math.min(most, initial * (1 << shift));
      const now = this.now();
      const due = now + delay;
      this.store.effectFailed(name, row, failure.message, due);
      if (due > now) {
        this.futureDue.set(effectId(name, row.key), { kind: name, due, failed: true });
      }
      if (name === REPLY && row.attempts + 1 === FAILURES_BEFORE_ERROR) {
        this.wakeKind(name);
      }
    }
    this.report(name);
  }

  private report(kind: string): void {
    const summary = this.store.effectSummary(kind);
    const quiet = this.kinds.get(kind)?.options.quiet ?? false;
    const detail =
      summary.since !== undefined && summary.waiting > 0
        ? `${summary.waiting} waiting since ${summary.since}`
        : "Nothing waiting";
    const health =
      summary.attempts >= FAILURES_BEFORE_ERROR && !quiet
        ? Health.error(`${detail}; the last failure: ${summary.error ?? ""}`)
        : Health.ready(detail);
    this.board.set(healthName(kind), health);
  }

  private scheduleTimer(minOrderedDue?: number): void {
    if (!this.started || this.stopped || this.paused) {
      this.clearDueTimer();
      return;
    }
    const now = this.now();
    let earliest: number | undefined = minOrderedDue;

    for (const [id, scheduled] of this.futureDue) {
      if (scheduled.due <= now) {
        this.futureDue.delete(id);
      } else if (earliest === undefined || scheduled.due < earliest) {
        earliest = scheduled.due;
      }
    }

    const dbNextDue = this.store.effectNextDue();
    if (dbNextDue !== undefined && dbNextDue > now) {
      earliest = earliest === undefined ? dbNextDue : Math.min(earliest, dbNextDue);
    }

    if (earliest === undefined) {
      this.clearDueTimer();
      return;
    }

    if (this.dueTimer !== undefined && this.dueTimerAt === earliest) {
      return;
    }

    this.clearDueTimer();
    const delayMs = Math.min(Math.max(1, Math.ceil(earliest - now)), MAX_TIMEOUT_MS);
    this.dueTimerAt = earliest;
    const timer = setTimeout(() => {
      this.dueTimer = undefined;
      this.dueTimerAt = undefined;
      if (!this.started || this.stopped || this.paused) {
        return;
      }
      this.dispatch();
    }, delayMs);
    timer.unref?.();
    this.dueTimer = timer;
  }

  private clearDueTimer(): void {
    if (this.dueTimer !== undefined) {
      clearTimeout(this.dueTimer);
      this.dueTimer = undefined;
    }
    this.dueTimerAt = undefined;
  }

  private addRunning(kind: string, key: string): void {
    let set = this.runningByKind.get(kind);
    if (set === undefined) {
      set = new Set<string>();
      this.runningByKind.set(kind, set);
    }
    if (!set.has(key)) {
      set.add(key);
      this.runningTotal += 1;
    }
  }

  private removeRunning(kind: string, key: string): void {
    const set = this.runningByKind.get(kind);
    if (set !== undefined && set.delete(key)) {
      this.runningTotal -= 1;
      if (set.size === 0) {
        this.runningByKind.delete(kind);
      }
    }
  }

  private notifyFinished(kind: string, key: string): void {
    const id = effectId(kind, key);
    const keySet = this.keyWaiters.get(id);
    if (keySet !== undefined) {
      this.keyWaiters.delete(id);
      for (const resolve of keySet) {
        resolve();
      }
    }
    const kindSet = this.kindWaiters.get(kind);
    if (kindSet !== undefined) {
      this.kindWaiters.delete(kind);
      for (const resolve of kindSet) {
        resolve();
      }
    }
    if (this.anyWaiters.size > 0) {
      const callbacks = Array.from(this.anyWaiters);
      this.anyWaiters.clear();
      for (let i = 0; i < callbacks.length; i++) {
        callbacks[i]();
      }
    }
  }

  private awaitKeyFinished(kind: string, key: string, deadline?: number): Promise<boolean> {
    const id = effectId(kind, key);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const done = (woke: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        const set = this.keyWaiters.get(id);
        if (set !== undefined) {
          set.delete(onNotify);
          if (set.size === 0) {
            this.keyWaiters.delete(id);
          }
        }
        resolve(woke);
      };
      const onNotify = (): void => done(true);
      let set = this.keyWaiters.get(id);
      if (set === undefined) {
        set = new Set<() => void>();
        this.keyWaiters.set(id, set);
      }
      set.add(onNotify);
      if (deadline !== undefined) {
        const remaining = Math.max(0, deadline - Date.now());
        timer = setTimeout(() => done(false), remaining);
      }
    });
  }

  private awaitFinished(kind?: string, deadline?: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const done = (woke: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (kind === undefined) {
          this.anyWaiters.delete(onNotify);
        } else {
          const set = this.kindWaiters.get(kind);
          if (set !== undefined) {
            set.delete(onNotify);
            if (set.size === 0) {
              this.kindWaiters.delete(kind);
            }
          }
        }
        resolve(woke);
      };
      const onNotify = (): void => done(true);
      if (kind === undefined) {
        this.anyWaiters.add(onNotify);
      } else {
        let set = this.kindWaiters.get(kind);
        if (set === undefined) {
          set = new Set<() => void>();
          this.kindWaiters.set(kind, set);
        }
        set.add(onNotify);
      }
      if (deadline !== undefined) {
        const remaining = Math.max(0, deadline - Date.now());
        timer = setTimeout(() => done(false), remaining);
      }
    });
  }
}
