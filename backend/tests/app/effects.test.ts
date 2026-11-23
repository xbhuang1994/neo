//! The effect queue's dispatcher, the Outbox built on it, and orchestration Passes.

import { describe, expect, test } from "bun:test";
import {
  ASSESSMENT,
  DELIVERY,
  Effects,
  FAILURES_BEFORE_ERROR,
  Failure,
  LAUNCH,
  NOTICE,
  RELAY,
  REPLY,
  SIDECAR,
  type Handler,
} from "../../src/app/effects.ts";
import { Health, HealthBoard } from "../../src/app/health.ts";
import { Outbox, type Channels, type Sent } from "../../src/app/outbox.ts";
import { BURST_CAP_MS, INTERVAL_MS, Passes } from "../../src/app/passes.ts";
import {
  Engine,
  UserError,
  type Assessor,
  type ChannelRef,
  type Executor,
  type OutboundMessage,
  type Policy,
  type SourceScope,
  type Trigger,
} from "../../src/core/index.ts";
import { Store } from "../../src/store/index.ts";

interface Fixture {
  store: Store;
  board: HealthBoard;
  clock: { now: number };
  effects: Effects;
  advance(ms: number): void;
  health(kind: string): [string, string];
}

function fixture(): Fixture {
  const store = Store.memory();
  const board = new HealthBoard();
  const clock = { now: 1_000_000 };
  const effects = Effects.withClock(store, board, () => clock.now);
  return {
    store,
    board,
    clock,
    effects,
    advance(ms: number): void {
      clock.now += ms;
    },
    health(kind: string): [string, string] {
      const h = board.get(`effects:${kind}`);
      if (h === undefined) {
        throw new Error(`the kind ${kind} did not report its health`);
      }
      return [h.state, h.detail];
    },
  };
}

/** A handler that records what it ran and fails as the test scripts. */
class Recorder {
  readonly ran: Array<[string, unknown]> = [];
  private outcomes: Array<void | Failure> = [];

  handler(): Handler {
    return async (payload, key) => {
      this.ran.push([key, payload]);
      if (this.outcomes.length === 0) {
        return undefined;
      }
      return this.outcomes.shift();
    };
  }

  keys(): string[] {
    return this.ran.map(([key]) => key);
  }

  fail(outcomes: Array<void | Failure>): void {
    this.outcomes = [...outcomes];
  }
}

/** A handler whose effects wait until the test lets them finish. */
class Gate {
  entered = 0;
  most = 0;
  active = 0;
  readonly started: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private permits = 0;

  notifyOne(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
    } else {
      this.permits += 1;
    }
  }

  notifyAll(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      next?.();
    }
  }

  private wait(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  handler(): Handler {
    return async (_payload, key) => {
      this.started.push(key);
      this.entered += 1;
      this.active += 1;
      if (this.active > this.most) {
        this.most = this.active;
      }
      await this.wait();
      this.active -= 1;
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(what: string, condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`timed out waiting until ${what}`);
}

class FakeChannels implements Channels {
  off = false;
  ignored = false;
  results: Array<Sent | Error> = [];
  /** How many more sends of a message id fail. */
  readonly failing = new Map<string, number>();
  readonly sent: string[] = [];
  /** Optional async send hook for testing concurrency and slow sends. */
  onSend?: (message: OutboundMessage) => Promise<Sent>;

  enabled(_source: string): boolean {
    return !this.off;
  }

  allowed(_channel: ChannelRef): boolean {
    return !this.ignored;
  }

  async send(message: OutboundMessage): Promise<Sent> {
    if (this.onSend !== undefined) {
      const outcome = await this.onSend(message);
      if (outcome === "sent") {
        this.sent.push(message.id);
      }
      return outcome;
    }
    const left = this.failing.get(message.id) ?? 0;
    if (left > 0) {
      this.failing.set(message.id, left - 1);
      throw new Error("the network is down");
    }
    const next = this.results.length === 0 ? "sent" : this.results.shift()!;
    if (next instanceof Error) {
      throw next;
    }
    if (next === "sent") {
      this.sent.push(message.id);
    }
    return next;
  }
}

function message(id: string, ticket?: string, thread = "web:main"): OutboundMessage {
  return {
    id,
    channel: { source: "chat", thread, address: {} },
    text: `text ${id}`,
    kind: "reply",
    ...(ticket !== undefined ? { ticketId: ticket } : {}),
  };
}

interface OutboxBox {
  f: Fixture;
  channels: FakeChannels;
  paused: { value: boolean };
  outbox: Outbox;
}

function createOutbox(): OutboxBox {
  const f = fixture();
  const channels = new FakeChannels();
  const paused = { value: false };
  const outbox = new Outbox(f.store, f.effects, channels, () => paused.value);
  f.effects.start();
  return { f, channels, paused, outbox };
}

describe("effects", () => {
  test("exports exact effect kind constants and failure threshold", () => {
    expect(ASSESSMENT).toBe("assessment");
    expect(LAUNCH).toBe("launch");
    expect(DELIVERY).toBe("delivery");
    expect(RELAY).toBe("relay");
    expect(NOTICE).toBe("notice");
    expect(REPLY).toBe("reply");
    expect(SIDECAR).toBe("sidecar");
    expect(FAILURES_BEFORE_ERROR).toBe(3);
  });

  test("rejects registering a second handler for the same kind", () => {
    const f = fixture();
    const recorder = new Recorder();
    f.effects.handle(RELAY, recorder.handler());
    expect(() => f.effects.handle(RELAY, recorder.handler())).toThrow(
      "The relay effects already have a handler",
    );
  });

  test("runs a queued effect once after start and removes it", async () => {
    const f = fixture();
    const recorder = new Recorder();
    f.effects.handle(RELAY, recorder.handler());
    f.effects.enqueue(RELAY, "r1", { text: "hello" });
    // Nothing runs before start, such as while setup is incomplete.
    await f.effects.idle();
    expect(recorder.keys()).toEqual([]);
    expect(f.effects.pending(RELAY, "r1")).toBe(true);
    f.effects.start();
    await f.effects.idle(RELAY);
    expect(recorder.ran).toEqual([["r1", { text: "hello" }]]);
    expect(f.effects.pending(RELAY)).toBe(false);
    expect(f.health(RELAY)).toEqual(["ready", "Nothing waiting"]);
    await f.effects.idle();
    expect(recorder.keys().length).toBe(1);
  });

  test("queues an effect with its transaction or not at all", async () => {
    const f = fixture();
    const recorder = new Recorder();
    f.effects.handle(RELAY, recorder.handler());
    f.effects.start();
    expect(() =>
      f.store.atomic(() => {
        f.effects.enqueue(RELAY, "rolled-back", {});
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    f.store.atomic(() => {
      f.effects.enqueue(RELAY, "kept", {});
    });
    await f.effects.idle();
    expect(recorder.keys()).toEqual(["kept"]);
  });

  test("retries a failure with growing delays and reports the kind failing after three", async () => {
    const f = fixture();
    const recorder = new Recorder();
    recorder.fail(Array.from({ length: 5 }, (_, n) => Failure.error(`offline ${n}`)));
    f.effects.handle(DELIVERY, recorder.handler(), { retry: [1_000, 3_000] });
    f.effects.start();
    f.effects.enqueue(DELIVERY, "t1", {});
    await f.effects.idle();
    expect(recorder.keys().length).toBe(1);
    // Not due again yet.
    f.advance(999);
    await f.effects.idle();
    expect(recorder.keys().length).toBe(1);
    // 1 s, then 2 s, then capped at 3 s.
    for (const [wait, attempts] of [
      [1, 2],
      [2_000, 3],
      [2_999, 3],
      [1, 4],
    ] as const) {
      f.advance(wait);
      await f.effects.idle();
      expect(recorder.keys().length).toBe(attempts);
    }
    const [state, detail] = f.health(DELIVERY);
    expect(state).toBe("error");
    expect(detail.startsWith("1 waiting since ")).toBe(true);
    expect(detail.endsWith("the last failure: offline 3")).toBe(true);
    expect(f.store.effectAttempts(DELIVERY, "t1")).toBe(4);
    // Queued again, it starts over at once and its success clears the failure.
    recorder.fail([]);
    f.effects.enqueue(DELIVERY, "t1", { again: true });
    await f.effects.idle();
    expect(recorder.ran[recorder.ran.length - 1][1]).toEqual({ again: true });
    expect(f.health(DELIVERY)[0]).toBe("ready");
    expect(f.effects.pending(DELIVERY)).toBe(false);
  });

  test("reschedules an effect that cannot run now without counting a failure", async () => {
    const f = fixture();
    const recorder = new Recorder();
    recorder.fail(Array.from({ length: 10 }, () => Failure.later("every worker slot is taken")));
    f.effects.handle(LAUNCH, recorder.handler(), { retry: [1_000, 60_000], quiet: true });
    f.effects.start();
    f.effects.enqueue(LAUNCH, "a1", {});
    for (let round = 1; round <= 6; round++) {
      await f.effects.idle();
      expect(recorder.keys().length).toBe(round);
      // Always the initial delay: waiting is not failing.
      f.advance(1_000);
    }
    expect(f.store.effectAttempts(LAUNCH, "a1")).toBe(0);
    expect(f.health(LAUNCH)[0]).toBe("ready");
  });

  test("keeps a quiet kind ready however often it fails", async () => {
    const f = fixture();
    const recorder = new Recorder();
    recorder.fail(Array.from({ length: 5 }, () => Failure.error("the ticket shows this")));
    f.effects.handle(DELIVERY, recorder.handler(), { retry: [10, 10], quiet: true });
    f.effects.start();
    f.effects.enqueue(DELIVERY, "t1", {});
    for (let i = 0; i < 4; i++) {
      await f.effects.idle();
      f.advance(10);
    }
    expect(f.store.effectAttempts(DELIVERY, "t1")).toBe(4);
    expect(f.health(DELIVERY)[0]).toBe("ready");
  });

  test("runs as many at once as the kind allows and holds it at zero", async () => {
    const f = fixture();
    const gate = new Gate();
    let limit = 0;
    f.effects.handle(LAUNCH, gate.handler(), { limit: () => limit });
    f.effects.start();
    for (const key of ["a", "b", "c", "d"]) {
      f.effects.enqueue(LAUNCH, key, {});
    }
    // Held, such as while processing is paused: idle resolves because nothing can start.
    await f.effects.idle();
    expect(gate.entered).toBe(0);
    limit = 2;
    f.effects.kick();
    await until("two run", () => gate.entered === 2);
    await sleep(30);
    expect(gate.started).toEqual(["a", "b"]);
    // Each one that finishes makes room for the next, in queue order.
    gate.notifyOne();
    await until("a third runs", () => gate.entered === 3);
    for (let i = 0; i < 3; i++) {
      gate.notifyOne();
      await sleep(20);
    }
    await f.effects.idle();
    expect(gate.started).toEqual(["a", "b", "c", "d"]);
    expect(gate.most).toBe(2);
    expect(f.effects.pending(LAUNCH)).toBe(false);
  });

  test("runs an ordered kind one at a time behind its oldest row", async () => {
    const f = fixture();
    const recorder = new Recorder();
    recorder.fail([Failure.error("the first fails")]);
    f.effects.handle(RELAY, recorder.handler(), { ordered: true, limit: () => 8, retry: [1_000, 1_000] });
    f.effects.start();
    for (const key of ["r1", "r2", "r3"]) {
      f.effects.enqueue(RELAY, key, {});
    }
    await f.effects.idle();
    // The failed head holds the later rows back until it is due and succeeds.
    expect(recorder.keys()).toEqual(["r1"]);
    f.advance(1_000);
    await f.effects.idle();
    expect(recorder.keys()).toEqual(["r1", "r1", "r2", "r3"]);
  });

  test("drops a cancelled effect and leaves the rest for the next start when drained", async () => {
    const f = fixture();
    const gate = new Gate();
    f.effects.handle(LAUNCH, gate.handler());
    f.effects.start();
    for (const key of ["a", "b", "c"]) {
      f.effects.enqueue(LAUNCH, key, {});
    }
    await until("the first runs", () => gate.entered === 1);
    f.effects.cancel(LAUNCH, "b");
    let drained = false;
    const draining = f.effects.drain().then(() => {
      drained = true;
    });
    await sleep(30);
    expect(drained).toBe(false);
    gate.notifyOne();
    await draining;
    expect(drained).toBe(true);
    // Nothing new started; what waited is still queued.
    expect(gate.started).toEqual(["a"]);
    expect(f.effects.pending(LAUNCH, "c")).toBe(true);
    expect(f.effects.pending(LAUNCH, "b")).toBe(false);
    expect(f.effects.pending(LAUNCH, "a")).toBe(false);
    // A new queue over the same store, as after a restart, continues after the highest position given out.
    const again = new Effects(f.store, f.board);
    const recorder = new Recorder();
    again.handle(LAUNCH, recorder.handler());
    again.enqueue(LAUNCH, "d", {});
    again.start();
    await again.idle();
    expect(recorder.keys()).toEqual(["c", "d"]);
  });

  test("counts a handler that throws unexpectedly as a failure", async () => {
    const f = fixture();
    let calls = 0;
    f.effects.handle(
      RELAY,
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("boom");
        }
      },
      { retry: [10, 10] },
    );
    f.effects.start();
    f.effects.enqueue(RELAY, "r1", {});
    await f.effects.idle();
    expect(f.store.effectAttempts(RELAY, "r1")).toBe(1);
    f.advance(10);
    await f.effects.idle();
    expect(calls).toBe(2);
    expect(f.effects.pending(RELAY)).toBe(false);
  });

  test("leaves a failing in-flight effect untouched on shutdown so it retries on next start", async () => {
    const f = fixture();
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      f.effects.handle(RELAY, async () => {
        resolve();
        await new Promise<void>((r) => {
          release = r;
        });
        return Failure.error("shutting down");
      });
    });
    f.effects.start();
    f.effects.enqueue(RELAY, "r1", {});
    await started;
    const stopping = f.effects.stop();
    release();
    await stopping;
    // Failed row was left untouched with 0 attempts so it runs cleanly after restart.
    expect(f.effects.pending(RELAY, "r1")).toBe(true);
    expect(f.store.effectAttempts(RELAY, "r1")).toBe(0);
  });

  test("supports setPaused/resume and maxConcurrent options", async () => {
    const f = fixture();
    const recorder = new Recorder();
    f.effects.handle(DELIVERY, recorder.handler(), { maxConcurrent: 2 });
    f.effects.setPaused(true);
    expect(f.effects.isPaused()).toBe(true);
    f.effects.start();
    f.effects.enqueue(DELIVERY, "k1", {});
    f.effects.enqueue(DELIVERY, "k2", {});
    await f.effects.idle();
    expect(recorder.keys()).toEqual([]);

    f.effects.setPaused(false);
    expect(f.effects.isPaused()).toBe(false);
    await f.effects.idle();
    expect(recorder.keys()).toEqual(["k1", "k2"]);
  });

  test("retries automatically on earliest-due timer without busy polling", async () => {
    const store = Store.memory();
    const board = new HealthBoard();
    const effects = new Effects(store, board);
    let calls = 0;
    let doneResolve!: () => void;
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });
    effects.handle(
      RELAY,
      async () => {
        calls += 1;
        if (calls === 1) {
          return Failure.error("transient");
        }
        doneResolve();
      },
      { retry: [25, 100] },
    );
    effects.start();
    effects.enqueue(RELAY, "auto-retry", {});
    await done;
    await effects.idle();
    expect(calls).toBe(2);
    expect(effects.pending(RELAY)).toBe(false);
    await effects.stop();
  });

  test("waitFor resolves on its specific key without waiting for unrelated slow items", async () => {
    const f = fixture();
    let releaseSlow!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      f.effects.handle(
        DELIVERY,
        async (_payload, key) => {
          if (key === "slow") {
            resolve();
            await new Promise<void>((r) => {
              releaseSlow = r;
            });
          }
        },
        { limit: 2 },
      );
    });
    f.effects.start();
    f.effects.enqueue(DELIVERY, "slow", {});
    await slowStarted;

    f.effects.enqueue(DELIVERY, "fast", {});
    const settled = await f.effects.waitFor(DELIVERY, "fast", 500);
    expect(settled).toBe(true);
    expect(f.effects.isRunning(DELIVERY, "slow")).toBe(true);
    expect(f.effects.pending(DELIVERY, "fast")).toBe(false);

    // Timeout works cleanly when waiting on a slow item.
    const timedOut = await f.effects.waitFor(DELIVERY, "slow", 20);
    expect(timedOut).toBe(false);
    expect(f.effects.isRunning(DELIVERY, "slow")).toBe(true);

    releaseSlow();
    expect(await f.effects.waitFor(DELIVERY, "slow", 500)).toBe(true);
    expect(f.effects.pending(DELIVERY)).toBe(false);

    // Cancelling a queued key while waitFor is waiting wakes it immediately.
    let releaseBlocker!: () => void;
    const blockerStarted = new Promise<void>((resolve) => {
      f.effects.handle(
        NOTICE,
        async (_payload, key) => {
          if (key === "n1") {
            resolve();
            await new Promise<void>((r) => {
              releaseBlocker = r;
            });
          }
        },
        { ordered: true },
      );
    });
    f.effects.enqueue(NOTICE, "n1", {});
    f.effects.enqueue(NOTICE, "n2", {});
    await blockerStarted;
    const waitingCancelled = f.effects.waitFor(NOTICE, "n2", 500);
    await sleep(10);
    f.effects.cancel(NOTICE, "n2");
    expect(await waitingCancelled).toBe(true);
    releaseBlocker();
    await f.effects.idle(NOTICE);
  });
});

describe("outbox", () => {
  test("sends each message once in the order they were queued", async () => {
    const b = createOutbox();
    for (const id of ["m1", "m2", "m1", "m3"]) {
      b.outbox.send(message(id, "t1"));
    }
    expect(b.outbox.status("m1")).toBe("pending");
    await b.outbox.sent();
    expect(b.channels.sent).toEqual(["m1", "m2", "m3"]);
    expect(b.outbox.status("m3")).toBe("sent");
    // A message id that went out is never sent again.
    b.outbox.send(message("m1", "t1"));
    await b.outbox.sent();
    expect(b.channels.sent.length).toBe(3);
    expect(b.outbox.status("unknown")).toBeUndefined();
  });

  test("holds messages while paused or while the source is off and sends them after", async () => {
    const b = createOutbox();
    b.paused.value = true;
    b.outbox.send(message("m1"));
    await b.outbox.sent();
    expect(b.channels.sent).toEqual([]);
    b.paused.value = false;
    b.channels.off = true;
    await b.outbox.sent();
    expect(b.channels.sent).toEqual([]);
    expect(b.f.store.effectAttempts(REPLY, "m1")).toBe(0);
    b.channels.off = false;
    b.f.advance(5_000);
    await b.outbox.sent();
    expect(b.channels.sent).toEqual(["m1"]);
  });

  test("drops a message whose conversation is gone or no longer listened to", async () => {
    const b = createOutbox();
    b.channels.results = ["gone"];
    b.outbox.send(message("gone"));
    await b.outbox.sent();
    const dropped = b.f.store.receipt("gone")!;
    expect([dropped.status, dropped.dropped?.reason]).toEqual(["dropped", "channelGone"]);
    b.channels.ignored = true;
    b.outbox.send(message("ignored"));
    await b.outbox.sent();
    expect(b.f.store.receipt("ignored")?.dropped?.reason).toBe("channelIgnored");
    expect(b.channels.sent).toEqual([]);
    expect(b.f.effects.pending(REPLY)).toBe(false);
  });

  test("retries a failed send and lets a later message pass once it keeps failing", async () => {
    const b = createOutbox();
    b.channels.failing.set("m1", 3);
    b.outbox.send(message("m1", "t1"));
    b.outbox.send(message("m2", "t1"));
    b.outbox.send(message("other", "t2"));
    await b.outbox.sent();
    // The other ticket's message is not held back; the same ticket's later one is.
    expect(b.channels.sent).toEqual(["other"]);
    for (const wait of [5_000, 10_000]) {
      b.f.advance(wait);
      await b.outbox.sent();
    }
    expect(b.f.store.effectAttempts(REPLY, "m1")).toBe(3);
    expect(b.f.health(REPLY)[0]).toBe("error");
    // After three failures in a row the later message went ahead at once.
    expect(b.channels.sent).toEqual(["other", "m2"]);
    // And the first still goes out when it can.
    b.f.advance(20_000);
    await b.outbox.sent();
    expect(b.channels.sent).toEqual(["other", "m2", "m1"]);
    expect(b.f.health(REPLY)[0]).toBe("ready");
  });

  test("withdraws a message that has not gone out", async () => {
    const b = createOutbox();
    b.paused.value = true;
    b.outbox.send(message("m1"));
    b.outbox.withdraw("m1");
    expect(b.outbox.status("m1")).toBeUndefined();
    expect(b.f.effects.pending(REPLY, "m1")).toBe(false);
    b.paused.value = false;
    b.outbox.send(message("m2"));
    await b.outbox.sent();
    // One that went out stays.
    b.outbox.withdraw("m2");
    expect(b.outbox.status("m2")).toBe("sent");
    expect(b.channels.sent).toEqual(["m2"]);
  });

  test("treats waiting from source as Later without counting a failure", async () => {
    const b = createOutbox();
    b.channels.results = ["waiting", "sent"];
    b.outbox.send(message("m1"));
    await b.outbox.sent();
    expect(b.outbox.status("m1")).toBe("pending");
    expect(b.f.store.effectAttempts(REPLY, "m1")).toBe(0);
    b.f.advance(5_000);
    await b.outbox.sent();
    expect(b.outbox.status("m1")).toBe("sent");
    expect(b.channels.sent).toEqual(["m1"]);
  });

  test("runs up to 4 concurrent reply slots across tickets while waitFor isolates its receipt", async () => {
    const b = createOutbox();
    let inFlight = 0;
    let maxInFlight = 0;
    const releases = new Map<string, () => void>();
    const started = new Set<string>();

    b.channels.onSend = async (msg) => {
      started.add(msg.id);
      inFlight += 1;
      if (inFlight > maxInFlight) {
        maxInFlight = inFlight;
      }
      if (msg.id === "fast") {
        inFlight -= 1;
        return "sent";
      }
      await new Promise<void>((resolve) => {
        releases.set(msg.id, resolve);
      });
      inFlight -= 1;
      return "sent";
    };

    // Three slow replies on distinct tickets occupy 3 of 4 slots.
    b.outbox.send(message("slow1", "t1"));
    b.outbox.send(message("slow2", "t2"));
    b.outbox.send(message("slow3", "t3"));
    await until("three slow replies run concurrently", () => started.size === 3);
    expect(maxInFlight).toBe(3);

    // Fourth slot sends "fast" on t4 and waitFor resolves immediately while slow1..3 remain in flight!
    b.outbox.send(message("fast", "t4"));
    await b.outbox.waitFor("fast", 500);
    expect(b.outbox.status("fast")).toBe("sent");
    expect(b.outbox.status("slow1")).toBe("pending");
    expect(maxInFlight).toBe(4);

    // Same-ticket follow-up "after-slow1" waits behind "slow1" until slow1 settles.
    b.outbox.send(message("after-slow1", "t1"));
    const waiting = b.outbox.waitFor("after-slow1", 500);
    await sleep(20);
    expect(started.has("after-slow1")).toBe(false);

    releases.get("slow1")!();
    await until("after-slow1 starts after slow1", () => started.has("after-slow1"));
    releases.get("after-slow1")!();
    await waiting;
    expect(b.outbox.status("after-slow1")).toBe("sent");
    expect(b.channels.sent.indexOf("slow1")).toBeLessThan(b.channels.sent.indexOf("after-slow1"));

    // Release remaining slow messages.
    releases.get("slow2")!();
    releases.get("slow3")!();
    await b.outbox.sent();
  });
});

function createPassesHarness(options: {
  burstDelayMs?: number;
  intervalMs?: number;
  burstCapMs?: number;
  monotonicNow?: () => number;
  throwOnEval?: () => boolean;
} = {}) {
  const store = Store.memory();
  const board = new HealthBoard();
  const effects = new Effects(store, board);
  effects.start();

  const evalRequests: string[] = [];
  const policy: Policy = {
    version: () => "v1",
    paused: () => false,
    gate: () => ({
      kind: "admissible",
      strength: "explicit",
      basis: { via: "addressed", addressed: "direct" },
    }),
    revalidate: () => true,
    admitsInferred: () => true,
    evalTimeoutMs: () => 60_000,
  };
  const scope: SourceScope = {
    scope: (source) =>
      source === "ignored"
        ? { kind: "ignored", reason: "notListened" }
        : { kind: "listened", observed: true, fanout: true },
  };
  const assessor: Assessor = {
    request: (candidate) => {
      if (options.throwOnEval?.()) {
        throw new Error("assessor boom");
      }
      evalRequests.push(candidate.evalId);
    },
  };
  const executor: Executor = {
    start: () => {},
    deliver: () => {},
    stop: () => {},
  };
  const outboxPort = {
    send: () => {},
    status: () => undefined,
    withdraw: () => {},
  };
  const engine = new Engine({
    repo: store,
    policy: () => policy,
    scope,
    assessor,
    executor,
    outbox: outboxPort,
  });

  const passes = new Passes(engine, effects, board, () => options.burstDelayMs ?? 0, {
    intervalMs: options.intervalMs,
    burstCapMs: options.burstCapMs,
    monotonicNow: options.monotonicNow,
  });

  return { store, board, effects, engine, passes, evalRequests };
}

function makeTrigger(id: string, source = "chat"): Trigger {
  return {
    id,
    source,
    at: "2026-11-23T00:00:00.000Z",
    actor: { source, id: "u1" },
    human: true,
    addressed: "direct",
    text: `hello ${id}`,
    threads: [{ source, id: "web:main" }],
    channel: { source, thread: "web:main", address: {} },
    meta: {},
  };
}

describe("passes", () => {
  test("exports exact default timing constants", () => {
    expect(BURST_CAP_MS).toBe(4_000);
    expect(INTERVAL_MS).toBe(2_000);
  });

  test("runs immediately with zero burst delay and skips duplicates/filtered", async () => {
    const h = createPassesHarness({ burstDelayMs: 0 });
    expect(h.passes.receive(makeTrigger("tr1"))).toBe("stored");
    expect(h.evalRequests.length).toBe(1);
    expect(h.passes.receive(makeTrigger("tr1"))).toBe("duplicate");
    expect(h.evalRequests.length).toBe(1);
    expect(h.passes.receive(makeTrigger("tr2", "ignored"))).toBe("filtered");
    expect(h.evalRequests.length).toBe(1);
    await h.passes.stop();
    await h.effects.stop();
  });

  test("coalesces a burst into a single pass and caps burst deferral", async () => {
    let mono = 1_000;
    const h = createPassesHarness({
      burstDelayMs: 40,
      burstCapMs: 70,
      monotonicNow: () => mono,
    });
    expect(h.passes.receive(makeTrigger("b1"))).toBe("stored");
    expect(h.evalRequests.length).toBe(0);
    mono += 20;
    expect(h.passes.receive(makeTrigger("b2"))).toBe("stored");
    expect(h.evalRequests.length).toBe(0);
    // Wait for burst timer to fire once with both triggers in the same Eval batch.
    await until("burst eval started", () => h.evalRequests.length === 1);
    const thread = h.store.thread("chat:web:main");
    expect(thread?.evaluating?.triggerIds).toEqual(["b1", "b2"]);

    // Verify burst cap forces an immediate pass when elapsed reaches burstCapMs.
    mono = 5_000;
    const h2 = createPassesHarness({
      burstDelayMs: 500,
      burstCapMs: 100,
      monotonicNow: () => mono,
    });
    expect(h2.passes.receive(makeTrigger("c1"))).toBe("stored");
    expect(h2.evalRequests.length).toBe(0);
    mono += 100;
    expect(h2.passes.receive(makeTrigger("c2"))).toBe("stored");
    expect(h2.evalRequests.length).toBe(1);

    await h.passes.stop();
    await h2.passes.stop();
    await h.effects.stop();
    await h2.effects.stop();
  });

  test("runs periodic passes unless a burst holds one back and coalesces kick()", async () => {
    const h = createPassesHarness({ burstDelayMs: 0, intervalMs: 25 });
    let evalCalls = 0;
    const origEvaluateDue = h.engine.evaluateDue.bind(h.engine);
    h.engine.evaluateDue = () => {
      evalCalls += 1;
      origEvaluateDue();
    };

    // Multiple synchronous kicks coalesce into a single pass.
    h.passes.kick();
    h.passes.kick();
    h.passes.kick();
    await sleep(5);
    expect(evalCalls).toBe(1);

    // Periodic timer runs passes automatically, and skips ticks while a burst is holding back.
    h.passes.start();
    await until("periodic passes ran", () => evalCalls >= 3);
    await h.passes.stop();
    const afterStop = evalCalls;
    await sleep(60);
    expect(evalCalls).toBe(afterStop);
    await h.effects.stop();

    // Periodic timer skips pumping while a burst is active.
    const hBurst = createPassesHarness({ burstDelayMs: 70, intervalMs: 15, burstCapMs: 200 });
    let burstEvalCalls = 0;
    const origBurstEval = hBurst.engine.evaluateDue.bind(hBurst.engine);
    hBurst.engine.evaluateDue = () => {
      burstEvalCalls += 1;
      origBurstEval();
    };
    hBurst.passes.start();
    expect(hBurst.passes.receive(makeTrigger("hold-1"))).toBe("stored");
    await sleep(40);
    // Multiple 15ms interval ticks elapsed while burst held back, so 0 passes ran yet.
    expect(burstEvalCalls).toBe(0);
    await until("burst timer eventually fires", () => burstEvalCalls >= 1);
    await hBurst.passes.stop();
    await hBurst.effects.stop();
  });

  test("records runtime error health on pass failure and clears it on next clean pass", async () => {
    let shouldFail = true;
    const h = createPassesHarness({ throwOnEval: () => shouldFail });
    h.board.set("runtime", Health.waiting("Starting"));

    // A clean pass does not overwrite a non-error runtime state such as "waiting".
    shouldFail = false;
    h.passes.pump();
    expect(h.board.get("runtime")?.state).toBe("waiting");

    shouldFail = true;
    h.board.set("runtime", Health.ready("Ready"));

    h.engine.receive(makeTrigger("e1"));
    h.passes.pump();
    expect(h.board.get("runtime")?.state).toBe("error");
    expect(h.board.get("runtime")?.detail).toBe("A pass failed");

    shouldFail = false;
    await h.passes.idle();
    expect(h.board.get("runtime")?.state).toBe("ready");
    expect(h.board.get("runtime")?.detail).toBe("Ready");
    expect(h.evalRequests.length).toBe(1);

    await h.passes.stop();
    expect(() => h.passes.receive(makeTrigger("e2"))).toThrow(UserError);
    try {
      h.passes.receive(makeTrigger("e2"));
    } catch (error) {
      expect(error).toBeInstanceOf(UserError);
      expect((error as UserError).code).toBe("invalid");
      expect((error as UserError).message).toBe("neo-agent is stopping");
    }
    await h.effects.stop();
  });
});
