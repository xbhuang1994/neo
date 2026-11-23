//! Orchestration passes: each kicks the effects that are due and advances the Engine's Evals. A pass runs every two
//! seconds and whenever new work arrives; messages that arrive in a quick burst share one pass.

import { UserError, type Engine, type ReceiveResult, type Trigger } from "../core/index.ts";
import type { Effects } from "./effects.ts";
import { Health, type HealthBoard } from "./health.ts";

/** How long a burst may hold a pass back, in all (milliseconds). */
export const BURST_CAP_MS = 4_000;
/** How often a pass runs on its own (milliseconds). */
export const INTERVAL_MS = 2_000;

/** How long to wait for more messages after one, in milliseconds, so a burst is routed in one turn; 0 for none. */
export type BurstDelay = (trigger: Trigger) => number;

/** Optional timing overrides for {@link Passes} (primarily for deterministic tests). */
export interface PassesOptions {
  /** Override periodic pass interval in milliseconds (defaults to {@link INTERVAL_MS}). */
  intervalMs?: number;
  /** Override maximum burst deferral window in milliseconds (defaults to {@link BURST_CAP_MS}). */
  burstCapMs?: number;
  /** Override monotonic clock in milliseconds (defaults to `performance.now`). */
  monotonicNow?: () => number;
}

/** Schedules orchestration passes over the Engine and the effect queue. */
export class Passes {
  private readonly engine: Engine;
  private readonly effects: Effects;
  private readonly board: HealthBoard;
  private readonly burstDelay: BurstDelay;
  private readonly intervalMs: number;
  private readonly burstCapMs: number;
  private readonly monotonicNow: () => number;

  /** When the burst's first message arrived (monotonic ms), or `undefined` when no burst is active. */
  private burstSince: number | undefined;
  /** Grows with every message and pass, so only the latest burst timer fires. */
  private burstGeneration = 0;
  private burstTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private stopped = false;
  private kickPending = false;
  private activePass = false;
  private readonly stopWaiters: Array<() => void> = [];

  /** Passes over the Engine and the effect queue. */
  constructor(
    engine: Engine,
    effects: Effects,
    board: HealthBoard,
    burstDelay: BurstDelay,
    options: PassesOptions = {},
  ) {
    this.engine = engine;
    this.effects = effects;
    this.board = board;
    this.burstDelay = burstDelay;
    this.intervalMs = options.intervalMs ?? INTERVAL_MS;
    this.burstCapMs = options.burstCapMs ?? BURST_CAP_MS;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  /** Run a pass every two seconds, unless a burst holds one back. */
  start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    this.scheduleNextTick();
  }

  /** Stop running passes, clearing timers and waiting for any active pass to finish. */
  stop(): Promise<void> {
    this.stopped = true;
    this.kickPending = false;
    this.burstSince = undefined;
    this.burstGeneration += 1;
    this.clearBurstTimer();
    this.clearIntervalTimer();
    if (!this.activePass) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.stopWaiters.push(resolve);
    });
  }

  /** Coalesce one or more wakeups into a single pass on the next microtask. */
  kick(): void {
    if (this.stopped || this.kickPending) {
      return;
    }
    this.kickPending = true;
    queueMicrotask(() => {
      if (!this.kickPending) {
        return;
      }
      this.kickPending = false;
      if (!this.stopped) {
        this.pump();
      }
    });
  }

  /** Take a Source's message in, and run a pass for it: at once, or after its burst settles. */
  receive(trigger: Trigger): ReceiveResult {
    if (this.stopped) {
      throw UserError.invalid("neo-agent is stopping");
    }
    const rawDelay = this.burstDelay(trigger);
    const delayMs = Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : 0;
    const result = this.engine.receive(trigger);
    if (result !== "stored") {
      return result;
    }
    if (delayMs === 0) {
      this.pump();
      return result;
    }
    const now = this.monotonicNow();
    if (this.burstSince === undefined) {
      this.burstSince = now;
    }
    this.burstGeneration += 1;
    const generation = this.burstGeneration;
    const elapsed = Math.max(0, now - this.burstSince);
    const waitMs = Math.min(delayMs, Math.max(0, this.burstCapMs - elapsed));
    if (waitMs === 0) {
      this.pump();
      return result;
    }
    this.clearBurstTimer();
    const timer = setTimeout(() => {
      this.burstTimer = undefined;
      // A later message of the burst set its own timer.
      if (this.burstGeneration === generation && !this.stopped) {
        this.pump();
      }
    }, waitMs);
    timer.unref?.();
    this.burstTimer = timer;
    return result;
  }

  /** Run one pass now; it ends any burst. */
  pump(): void {
    this.kickPending = false;
    this.burstSince = undefined;
    this.burstGeneration += 1;
    this.clearBurstTimer();
    if (this.stopped) {
      return;
    }
    this.activePass = true;
    try {
      // While processing is paused, the Engine only notes the pause on running Evals so they do not expire.
      this.engine.evaluateDue();
      if (this.board.get("runtime")?.state === "error") {
        this.board.set("runtime", Health.ready("Ready"));
      }
    } catch {
      this.board.set("runtime", Health.error("A pass failed"));
    } finally {
      this.activePass = false;
      if (this.stopWaiters.length > 0) {
        const waiters = this.stopWaiters.splice(0, this.stopWaiters.length);
        for (let i = 0; i < waiters.length; i++) {
          waiters[i]();
        }
      }
    }
    this.effects.kick();
  }

  /** Resolves once no effect that can start now is running, after a pass. */
  async idle(): Promise<void> {
    this.pump();
    await this.effects.idle();
  }

  private scheduleNextTick(): void {
    if (this.stopped) {
      return;
    }
    this.clearIntervalTimer();
    const timer = setTimeout(() => {
      this.intervalTimer = undefined;
      if (this.stopped) {
        return;
      }
      if (this.burstSince === undefined) {
        this.pump();
      }
      this.scheduleNextTick();
    }, this.intervalMs);
    timer.unref?.();
    this.intervalTimer = timer;
  }

  private clearBurstTimer(): void {
    if (this.burstTimer !== undefined) {
      clearTimeout(this.burstTimer);
      this.burstTimer = undefined;
    }
  }

  private clearIntervalTimer(): void {
    if (this.intervalTimer !== undefined) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = undefined;
    }
  }
}
