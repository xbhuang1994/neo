/**
 * The store itself: schema versioning, transactions, key-value records, working sets, generated columns,
 * timelines, receipts, and effect rows.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mandateBasisVia,
  type Assignment,
  type AssignmentState,
  type Decision,
  type DecisionKind,
  type OutboundMessage,
  type Thread,
  type Ticket,
  type Trigger,
} from "../../src/core/index.ts";
import {
  SCHEMA_VERSION,
  Store,
  StoreError,
  isStoreError,
  settledDropped,
  settledSent,
  type EffectRow,
  type Place,
} from "../../src/store/index.ts";

function withTempDir(name: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), `neo-store-${name}-`));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeTrigger(id: string, threadId: string, at: string): Trigger {
  return {
    id,
    source: "chat",
    threads: [{ source: "chat", id: threadId }],
    actor: { source: "chat", id: "web:local" },
    human: true,
    addressed: "direct",
    at,
    text: `message ${id}`,
    meta: {},
  };
}

function makeThread(id: string): Thread {
  return {
    key: `chat:${id}`,
    ref: { source: "chat", id },
    createdAt: "2026-01-01T00:00:00.000Z",
    subscriptions: [],
    correlated: [],
    pending: [],
    meta: {},
  };
}

function makeTicket(id: string): Ticket {
  return {
    id,
    title: `Ticket ${id}`,
    decisionId: "d",
    mandate: {
      strength: "explicit",
      policyVersion: "v1",
      basis: mandateBasisVia({ via: "addressed", addressed: "direct" }),
      actor: { source: "chat", id: "web:local" },
      scope: "small",
    },
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    origin: { triggerId: "g", triggerIds: ["g"] },
  };
}

function makeAssignment(state: AssignmentState): Assignment {
  return {
    id: "a",
    state,
    createdAt: "t",
  };
}

function makeMessage(id: string, ticketId: string | undefined, conversation: string): OutboundMessage {
  return {
    id,
    channel: { source: "chat", thread: conversation, address: {} },
    text: `text ${id}`,
    kind: "reply",
    ...(ticketId !== undefined ? { ticketId } : {}),
  };
}

function makeDecision(id: string, threadKey: string, kind: DecisionKind): Decision {
  return {
    id,
    evalId: `e-${id}`,
    threadKey,
    triggerIds: [],
    policyVersion: "v1",
    at: "t",
    kind,
    reason: [],
    strength: "explicit",
  };
}

// --- schema ---

describe("schema", () => {
  test("keeps state across reopening and restricts the file", () => {
    withTempDir("reopen", (dir) => {
      const dbPath = path.join(dir, "state", "orchestrator.sqlite");
      {
        const store = Store.open(dbPath);
        store.saveTicket(makeTicket("t1"));
        store.set("master-id", "orchestrator-1");
        store.close();
      }
      const store = Store.open(dbPath);
      try {
        expect(store.ticket("t1")?.title).toBe("Ticket t1");
        expect(store.get<string>("master-id")).toBe("orchestrator-1");
        expect(store.get<number>("schema")).toBe(SCHEMA_VERSION);
        if (process.platform !== "win32") {
          expect(statSync(dbPath).mode & 0o777).toBe(0o600);
          expect(statSync(path.dirname(dbPath)).mode & 0o777).toBe(0o700);
        }
      } finally {
        store.close();
      }
    });
  });

  test("refuses a database of another schema version and leaves it untouched", () => {
    withTempDir("schema", (dir) => {
      const dbPath = path.join(dir, "orchestrator.sqlite");
      {
        // What the earlier TypeScript version left behind: schema 1.
        const db = new Database(dbPath, { create: true, readwrite: true });
        db.run(
          "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES ('schema', '1'); INSERT INTO kv VALUES ('master-id', '\"old\"')",
        );
        db.close();
      }
      let caught: unknown;
      try {
        Store.open(dbPath);
      } catch (err) {
        caught = err;
      }
      expect(isStoreError(caught)).toBe(true);
      const error = caught as StoreError;
      expect(error.kind).toBe("schema");
      expect(error.found).toBe(1);
      const text = error.toString();
      expect(text).toBe(
        `Unsupported database schema 1 (this version uses ${SCHEMA_VERSION}); state from another version is not migrated, start with a new empty data directory`,
      );
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
          .get();
        expect(row?.count).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  test("handles non-numeric schema value as -1 and throws StoreError.io on invalid path", () => {
    withTempDir("schema-bad", (dir) => {
      const dbPath = path.join(dir, "bad.sqlite");
      const db = new Database(dbPath, { create: true, readwrite: true });
      db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES ('schema', 'bogus')");
      db.close();

      let caught: unknown;
      try {
        Store.open(dbPath);
      } catch (err) {
        caught = err;
      }
      expect(isStoreError(caught)).toBe(true);
      expect((caught as StoreError).kind).toBe("schema");
      expect((caught as StoreError).found).toBe(-1);

      // Cannot create directory over a regular file.
      const blocker = path.join(dir, "not-a-dir");
      writeFileSync(blocker, "x");
      let ioErr: unknown;
      try {
        Store.open(path.join(blocker, "db.sqlite"));
      } catch (err) {
        ioErr = err;
      }
      expect(isStoreError(ioErr)).toBe(true);
      expect((ioErr as StoreError).kind).toBe("io");
      expect((ioErr as StoreError).message).toContain("Cannot create");
    });
  });

  test("creates exact SQLite tables, indexes, pragmas, and generated columns", () => {
    withTempDir("ddl", (dir) => {
      const dbPath = path.join(dir, "ddl.sqlite");
      const store = Store.open(dbPath);

      // Populate rows exercising every generated column expression.
      const openRunning = makeTicket("t-open-running");
      openRunning.assignments = [makeAssignment("ended"), makeAssignment("running")];
      const openPending = makeTicket("t-open-pending");
      openPending.assignments = [makeAssignment("pending")];
      const openIdle = makeTicket("t-open-idle");
      openIdle.assignments = [makeAssignment("ended")];
      const closedUndelivered = makeTicket("t-closed-undelivered");
      closedUndelivered.ended = { at: "2026-01-01T00:00:01.000Z", by: "executor", outcome: "completed" };
      closedUndelivered.undelivered = ["i1"];
      const closedOver = makeTicket("t-closed-over");
      closedOver.ended = { at: "2026-01-01T00:00:02.000Z", by: "human", outcome: "stopped" };
      for (const t of [openRunning, openPending, openIdle, closedUndelivered, closedOver]) {
        store.saveTicket(t);
      }

      const thQuiet = makeThread("quiet");
      const thPending = makeThread("pending");
      thPending.pending = ["g1"];
      const thEval = makeThread("eval");
      thEval.evaluating = {
        id: "e1",
        threadKey: "chat:eval",
        triggerIds: ["g2"],
        strength: "explicit",
        actor: { source: "chat", id: "alice" },
        basis: mandateBasisVia({ via: "addressed", addressed: "direct" }),
        policyVersion: "v1",
        startedAt: "2026-01-01T00:00:00.000Z",
        deadline: "2026-01-01T00:01:00.000Z",
      };
      const thSub = makeThread("sub");
      thSub.ref = { source: "wechat", id: "sub" };
      thSub.key = "wechat:sub";
      thSub.subscriptions = ["t-open-running"];
      for (const th of [thQuiet, thPending, thEval, thSub]) {
        store.saveThread(th);
      }

      store.addReceipt(makeMessage("m-pending-ticket", "t-open-running", "conv-1"));
      store.addReceipt(makeMessage("m-pending-noticket", undefined, "conv-1"));
      store.addReceipt(makeMessage("m-dropped", "t-open-running", "conv-1"));
      store.settleReceipt(makeMessage("m-dropped", "t-open-running", "conv-1"), settledDropped("channelGone"));
      store.addReceipt(makeMessage("m-sent", "t-open-running", "conv-1"));
      store.settleReceipt(makeMessage("m-sent", "t-open-running", "conv-1"), settledSent());
      store.close();

      // Inspect raw SQLite schema & generated column values directly.
      const db = new Database(dbPath, { readonly: true });
      try {
        const journalMode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
        expect(journalMode?.journal_mode.toLowerCase()).toBe("wal");

        const tables = db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all()
          .map((r) => r.name);
        expect(tables).toEqual([
          "decision",
          "disposition",
          "effect",
          "kv",
          "outbox",
          "thread",
          "ticket",
          "trigger",
          "trigger_thread",
        ]);

        const indexes = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
          )
          .all()
          .map((r) => r.name);
        expect(indexes).toEqual([
          "decision_thread",
          "effect_due",
          "effect_kind_seq",
          "outbox_dropped",
          "outbox_pending",
          "outbox_ticket_reply",
          "thread_active",
          "thread_subscribed",
          "ticket_active",
          "ticket_open",
          "trigger_at",
          "trigger_thread_at",
        ]);

        // Assert ticket generated columns (`open`, `active`) directly.
        const ticketCols = db
          .query<{ id: string; open: number | null; active: number | null }, []>(
            "SELECT id, open, active FROM ticket ORDER BY rowid",
          )
          .all();
        expect(ticketCols).toEqual([
          { id: "t-open-running", open: 1, active: 1 },
          { id: "t-open-pending", open: 1, active: 1 },
          { id: "t-open-idle", open: 1, active: null },
          { id: "t-closed-undelivered", open: null, active: 1 },
          { id: "t-closed-over", open: null, active: null },
        ]);

        // Assert thread generated columns (`active`, `subscribed`) directly.
        const threadCols = db
          .query<{ key: string; active: number | null; subscribed: string | null }, []>(
            "SELECT key, active, subscribed FROM thread ORDER BY rowid",
          )
          .all();
        expect(threadCols).toEqual([
          { key: "chat:quiet", active: null, subscribed: null },
          { key: "chat:pending", active: 1, subscribed: null },
          { key: "chat:eval", active: 1, subscribed: null },
          { key: "wechat:sub", active: null, subscribed: "wechat" },
        ]);

        // Assert outbox generated columns (`dropped`, `pending`) directly.
        const outboxCols = db
          .query<{ id: string; dropped: string | null; pending: string | null }, []>(
            "SELECT id, dropped, pending FROM outbox ORDER BY rowid",
          )
          .all();
        expect(outboxCols.map((r) => ({ id: r.id, hasDropped: r.dropped !== null, pending: r.pending }))).toEqual([
          { id: "m-pending-ticket", hasDropped: false, pending: "t-open-running conv-1" },
          { id: "m-pending-noticket", hasDropped: false, pending: null },
          { id: "m-dropped", hasDropped: true, pending: null },
          { id: "m-sent", hasDropped: false, pending: null },
        ]);
      } finally {
        db.close();
      }
    });
  });
});

// --- transactions ---

describe("transactions", () => {
  test("rolls back a nested transaction alone and everything with the outer one", () => {
    const store = Store.memory();
    store.atomic(() => {
      store.set("a", 1);
      expect(() =>
        store.atomic(() => {
          store.set("b", 2);
          throw new Error("inner failed");
        }),
      ).toThrow("inner failed");
      expect([store.get<number>("a"), store.get<number>("b")]).toEqual([1, undefined]);
    });
    expect([store.get<number>("a"), store.get<number>("b")]).toEqual([1, undefined]);

    expect(() =>
      store.atomic(() => {
        store.set("a", 10);
        store.atomic(() => {
          store.set("c", 3);
        });
        throw new Error("outer failed");
      }),
    ).toThrow("outer failed");
    expect([store.get<number>("a"), store.get<number>("c")]).toEqual([1, undefined]);
    store.close();
  });

  test("rolls back when work throws and stays usable", () => {
    const store = Store.memory();
    expect(() =>
      store.atomic(() => {
        store.set("a", 1);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.get<number>("a")).toBeUndefined();
    store.set("a", 2);
    expect(store.get<number>("a")).toBe(2);
    store.close();
  });

  test("runs post-commit actions in FIFO order only after outermost commit and never after rollback", () => {
    const store = Store.memory();
    const order: number[] = [];
    store.afterCommit(() => order.push(1));
    expect(order).toEqual([1]);

    store.atomic(() => {
      store.afterCommit(() => order.push(10));
      store.atomic(() => {
        store.afterCommit(() => order.push(100));
      });
      try {
        store.atomic(() => {
          store.afterCommit(() => order.push(1000));
          throw new Error("inner abort");
        });
      } catch {
        // expected
      }
      store.afterCommit(() => {
        order.push(200);
        // Nested atomic inside an afterCommit callback runs cleanly at depth 0.
        store.atomic(() => {
          store.set("from-hook", true);
          store.afterCommit(() => order.push(201));
        });
      });
      expect(order).toEqual([1]);
    });
    expect(order).toEqual([1, 10, 100, 200, 201]);
    expect(store.get<boolean>("from-hook")).toBe(true);

    try {
      store.atomic(() => {
        store.afterCommit(() => order.push(10_000));
        store.atomic(() => {
          store.afterCommit(() => order.push(20_000));
        });
        throw new Error("outer abort");
      });
    } catch {
      // expected
    }
    expect(order).toEqual([1, 10, 100, 200, 201]);
    store.close();
  });

  test("supports deep nesting beyond cached savepoint levels and no-op commit/rollback at depth 0", () => {
    const store = Store.memory();
    store.commit();
    store.rollback();

    const nest = (depth: number): void => {
      store.atomic(() => {
        store.set(`k${depth}`, depth);
        if (depth > 0) {
          nest(depth - 1);
        }
        if (depth === 1) {
          expect(() =>
            store.atomic(() => {
              store.set("dropped", true);
              throw new Error("deep rollback");
            }),
          ).toThrow("deep rollback");
        }
      });
    };
    nest(12);
    expect(store.get<number>("k0")).toBe(0);
    expect(store.get<number>("k12")).toBe(12);
    expect(store.get<boolean>("dropped")).toBeUndefined();
    store.close();
  });
});

// --- key-value records ---

describe("key-value records", () => {
  test("reads, writes, deletes, and lists typed records by prefix", () => {
    const store = Store.memory();
    expect(store.get<string>("missing")).toBeUndefined();
    store.set("session-file:worker-1", "a.jsonl");
    store.set("session-file:worker-2", "b.jsonl");
    store.set("session-file_other", "c");
    store.set("session-file:worker-1", "a2.jsonl");
    expect(store.get<string>("session-file:worker-1")).toBe("a2.jsonl");
    expect(store.keys("session-file:")).toEqual(["session-file:worker-1", "session-file:worker-2"]);
    // LIKE wildcards in a prefix match themselves only.
    store.set("a%b:1", 1);
    store.set("axb:1", 1);
    store.set("a\\b:1", 1);
    store.set("a_b:1", 1);
    store.set("ayb:1", 1);
    expect(store.keys("a%b:")).toEqual(["a%b:1"]);
    expect(store.keys("a\\b:")).toEqual(["a\\b:1"]);
    expect(store.keys("a_b:")).toEqual(["a_b:1"]);
    store.delete("session-file:worker-2");
    expect(store.keys("session-file:")).toEqual(["session-file:worker-1"]);
    store.close();
  });
});

// --- working sets ---

describe("working sets", () => {
  test("lists open and active tickets newest first from their stored state", () => {
    const store = Store.memory();
    const idle = makeTicket("idle");
    idle.assignments = [makeAssignment("ended")];
    const running = makeTicket("running");
    running.assignments = [makeAssignment("ended"), makeAssignment("running")];
    const waiting = makeTicket("waiting");
    waiting.ended = { at: "t", by: "executor", outcome: "completed" };
    waiting.undelivered = ["i1"];
    const over = makeTicket("over");
    over.ended = { at: "t", by: "human", outcome: "stopped" };
    over.assignments = [makeAssignment("ended")];
    for (const each of [idle, running, waiting, over]) {
      store.saveTicket(each);
    }
    const names = (tickets: Ticket[]): string[] => tickets.map((t) => t.id);
    expect(names(store.tickets())).toEqual(["over", "waiting", "running", "idle"]);
    expect(names(store.recentTickets(2))).toEqual(["over", "waiting"]);
    expect(names(store.openTickets())).toEqual(["running", "idle"]);
    expect(names(store.activeTickets())).toEqual(["waiting", "running"]);
    // Saving again keeps a ticket's place and moves it between sets.
    running.assignments[1].state = "ended";
    store.saveTicket(running);
    expect(names(store.activeTickets())).toEqual(["waiting"]);
    expect(names(store.tickets())).toEqual(["over", "waiting", "running", "idle"]);
    store.close();
  });

  test("lists active and subscribed threads and patches their metadata", () => {
    const store = Store.memory();
    const quiet = makeThread("quiet");
    const queued = makeThread("queued");
    queued.pending = ["g1"];
    const followed = makeThread("followed");
    followed.subscriptions = ["t1"];
    for (const each of [quiet, queued, followed]) {
      store.saveThread(each);
    }
    const keys = (threads: Thread[]): string[] => threads.map((t) => t.key);
    expect(keys(store.threads())).toEqual(["chat:quiet", "chat:queued", "chat:followed"]);
    expect(keys(store.activeThreads())).toEqual(["chat:queued"]);
    expect(keys(store.subscribedThreads())).toEqual(["chat:followed"]);
    expect(keys(store.subscribedThreads("chat"))).toEqual(["chat:followed"]);
    expect(store.subscribedThreads("other")).toEqual([]);

    store.patchThreadMeta("chat:quiet", [
      ["label", "Quiet"],
      ["gone", undefined],
    ]);
    expect(store.thread("chat:quiet")?.meta.label).toBe("Quiet");
    store.patchThreadMeta("chat:quiet", { label: undefined, nullable: null });
    expect(store.thread("chat:quiet")?.meta).toEqual({ nullable: null });
    store.patchThreadMeta("chat:quiet", { nullable: undefined });
    expect(store.thread("chat:quiet")?.meta).toEqual({});
    store.patchThreadMeta("chat:missing", { label: "x" });
    expect(store.thread("chat:missing")).toBeUndefined();
    store.close();
  });
});

// --- timelines ---

describe("timelines", () => {
  test("pages a thread's triggers by time then id and finds neighbours", () => {
    const store = Store.memory();
    const at = (second: number): string => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
    for (const [id, second] of [
      ["c", 3],
      ["a", 1],
      ["b2", 2],
      ["b1", 2],
      ["d", 4],
    ] as const) {
      store.saveTrigger(makeTrigger(id, "t1", at(second)));
    }
    const robot = makeTrigger("robot", "t1", at(0));
    robot.human = false;
    store.saveTrigger(robot);
    store.saveTrigger(makeTrigger("x", "other", at(9)));

    const ids = (triggers: Trigger[]): string[] => triggers.map((t) => t.id);
    expect(ids(store.threadTriggers("chat:t1", 50, undefined, false))).toEqual([
      "robot",
      "a",
      "b1",
      "b2",
      "c",
      "d",
    ]);
    expect(ids(store.threadTriggers("chat:t1", 2, undefined, false))).toEqual(["c", "d"]);

    const place: Place = { at: at(2), id: "b2" };
    expect(ids(store.threadTriggers("chat:t1", 50, place, false))).toEqual(["robot", "a", "b1"]);
    expect(ids(store.threadTriggers("chat:t1", 2, place, true))).toEqual(["b1", "b2"]);

    const [before, after] = store.neighbours("chat:t1", place);
    expect([before?.id, after?.id]).toEqual(["b1", "c"]);
    const [firstBefore] = store.neighbours("chat:t1", { at: at(0), id: "robot" });
    expect(firstBefore).toBeUndefined();

    expect(store.firstTrigger("chat:t1", false)?.id).toBe("robot");
    expect(store.firstTrigger("chat:t1", true)?.id).toBe("a");

    // Newest first, by arrival for equal times.
    expect(ids(store.threadPage("chat:t1", 0, 3))).toEqual(["d", "c", "b1"]);
    expect(ids(store.threadPage("chat:t1", 3, 3))).toEqual(["b2", "a", "robot"]);
    expect(ids(store.recentTriggers(0, 2))).toEqual(["x", "robot"]);
    store.close();
  });

  test("reindexes a trigger saved again and searches by id, messageId, and text", () => {
    const store = Store.memory();
    const moved = makeTrigger("g1", "t1", "2026-01-01T00:00:01.000Z");
    moved.text = "Fix the 100% broken_link";
    moved.meta.messageId = "web:abc";
    store.saveTrigger(moved);
    moved.threads = [{ source: "chat", id: "t2" }];
    store.saveTrigger(moved);
    expect(store.threadTriggers("chat:t1", 10, undefined, false)).toEqual([]);
    expect(store.threadTriggers("chat:t2", 10, undefined, false).length).toBe(1);

    store.saveTrigger(makeTrigger("g2", "t1", "2026-01-01T00:00:02.000Z"));
    const found = (query: string): string[] => store.searchTriggers(query, 10).map((t) => t.id);
    expect(found("g1")).toEqual(["g1"]);
    expect(found("web:abc")).toEqual(["g1"]);
    expect(found("message")).toEqual(["g2"]);
    // Wildcards in the query are literal.
    expect(found("100%")).toEqual(["g1"]);
    expect(found("broken_link")).toEqual(["g1"]);
    expect(found("brokenXlink")).toEqual([]);
    expect(found("%").length).toBe(1);
    store.close();
  });

  test("stores decisions by thread in order and filters them by kind", () => {
    const store = Store.memory();
    store.saveDecision(makeDecision("d1", "chat:a", "ignore"));
    store.saveDecision(makeDecision("d2", "chat:b", "unavailable"));
    store.saveDecision(makeDecision("d3", "chat:a", "accept"));
    const ids = (decisions: Decision[]): string[] => decisions.map((d) => d.id);
    expect(ids(store.decisionsByThread("chat:a"))).toEqual(["d1", "d3"]);
    expect(ids(store.recentDecisions(0, 2))).toEqual(["d3", "d2"]);
    expect(ids(store.decisionsOfKinds(["unavailable", "accept"], 10))).toEqual(["d3", "d2"]);
    expect(store.decisionsOfKinds(["stop"], 10)).toEqual([]);
    expect(store.decision("d2")?.kind).toBe("unavailable");
    store.close();
  });
});

// --- receipts ---

describe("receipts", () => {
  test("records a message once and settles or withdraws it", () => {
    const store = Store.memory();
    const first = makeMessage("m1", "t1", "c1");
    expect(store.addReceipt(first)).toBe(true);
    const again: OutboundMessage = { ...first, text: "another text" };
    expect(store.addReceipt(again)).toBe(false);
    const receipt = store.receipt("m1");
    expect(receipt).toBeDefined();
    expect([receipt?.text, receipt?.status]).toEqual(["text m1", "pending"]);
    expect(receipt?.queuedAt).toBeDefined();
    expect(store.waitingReceipts().length).toBe(1);

    store.settleReceipt(first, settledSent());
    expect(store.replyStatus("m1")).toBe("sent");
    expect(store.withdrawReceipt("m1")).toBe(false);
    expect(store.waitingReceipts()).toEqual([]);

    // A message withdrawn while it was being sent still leaves a receipt, so its id is never queued again.
    const racing = makeMessage("m2", "t1", "c1");
    store.addReceipt(racing);
    expect(store.withdrawReceipt("m2")).toBe(true);
    expect(store.replyStatus("m2")).toBeUndefined();
    store.settleReceipt(racing, settledSent());
    expect(store.replyStatus("m2")).toBe("sent");
    expect(store.receipt("m2")?.queuedAt).toBeUndefined();
    expect(store.addReceipt(racing)).toBe(false);
    store.close();
  });

  test("records dropped messages with their reason", () => {
    const store = Store.memory();
    for (const id of ["m1", "m2"]) {
      store.addReceipt(makeMessage(id, undefined, "c1"));
    }
    store.settleReceipt(makeMessage("m1", undefined, "c1"), settledDropped("channelGone"));
    const dropped = store.receipt("m1");
    expect(dropped).toBeDefined();
    expect(dropped?.status).toBe("dropped");
    expect(dropped?.dropped?.reason).toBe("channelGone");
    expect(store.droppedReplies(10).map((r) => r.id)).toEqual(["m1"]);
    expect(store.droppedSince("2000-01-01T00:00:00.000Z")).toBe(1);
    expect(store.droppedSince("2999-01-01T00:00:00.000Z")).toBe(0);
    // Verify camelCase wire representation matches Rust.
    const serialized = JSON.parse(JSON.stringify(dropped)) as Record<string, unknown>;
    expect((serialized.dropped as Record<string, unknown>).reason).toBe("channelGone");
    store.close();
  });

  test("holds a ticket's later message to a conversation behind an earlier one until it keeps failing", () => {
    const store = Store.memory();
    store.addReceipt(makeMessage("m1", "t1", "c1"));
    store.addReceipt(makeMessage("m2", "t1", "c1"));
    store.addReceipt(makeMessage("other-conversation", "t1", "c2"));
    store.addReceipt(makeMessage("other-ticket", "t2", "c1"));
    store.addReceipt(makeMessage("no-ticket", undefined, "c1"));

    expect(store.receiptBehind("m1", 3)).toBe(false);
    expect(store.receiptBehind("m2", 3)).toBe(true);
    for (const free of ["other-conversation", "other-ticket", "no-ticket"]) {
      expect(store.receiptBehind(free, 3)).toBe(false);
    }

    // Once the earlier one failed three times in a row, the later one goes ahead.
    store.effectEnqueue("reply", "m1", "{}", 1, 0);
    const row = store.effectHead("reply")!;
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(store.receiptBehind("m2", 3)).toBe(true);
      store.effectFailed("reply", row, "offline", 0);
    }
    expect(store.receiptBehind("m2", 3)).toBe(false);

    const failing = store.failingReplies();
    expect(failing.length).toBe(1);
    expect([failing[0].receipt.id, failing[0].attempts, failing[0].error]).toEqual(["m1", 3, "offline"]);

    // Or once it went out.
    store.settleReceipt(makeMessage("m1", "t1", "c1"), settledSent());
    expect(store.receiptBehind("m2", 1_000)).toBe(false);
    store.close();
  });

  test("tells whether a ticket was replied to since a time", () => {
    const store = Store.memory();
    expect(store.repliedSince("t1", "2000-01-01T00:00:00.000Z")).toBe(false);
    const ack: OutboundMessage = { ...makeMessage("ack", "t1", "c1"), kind: "acknowledgement" };
    store.addReceipt(ack);
    expect(store.repliedSince("t1", "2000-01-01T00:00:00.000Z")).toBe(false);
    store.addReceipt(makeMessage("m1", "t1", "c1"));
    expect(store.repliedSince("t1", "2000-01-01T00:00:00.000Z")).toBe(true);
    expect(store.repliedSince("t1", "2999-01-01T00:00:00.000Z")).toBe(false);
    expect(store.repliedSince("t2", "2000-01-01T00:00:00.000Z")).toBe(false);

    store.recordSentReceipt(makeMessage("file-1", "t2", "c1"), "2999-01-01T00:00:00.000Z");
    expect(store.replyStatus("file-1")).toBe("sent");
    expect(store.waitingReceipts().every((receipt) => receipt.id !== "file-1")).toBe(true);
    expect(store.repliedSince("t2", "2999-01-01T00:00:00.000Z")).toBe(true);
    store.close();
  });
});

// --- effect rows ---

describe("effect rows", () => {
  test("coalesces an effect queued again keeping its place and starting over", () => {
    const store = Store.memory();
    expect(store.effectMaxSeq()).toBe(0);
    store.effectEnqueue("delivery", "t1", '{"n":1}', 1, 1_000);
    store.effectEnqueue("delivery", "t2", '{"n":2}', 2, 1_000);
    const first = store.effectHead("delivery")!;
    store.effectFailed("delivery", first, "busy", 5_000);
    expect(store.effectAttempts("delivery", "t1")).toBe(1);

    store.effectEnqueue("delivery", "t1", '{"n":3}', 3, 2_000);
    const replaced = store.effectHead("delivery")!;
    expect([replaced.key, replaced.value, replaced.seq, replaced.generation, replaced.attempts, replaced.due]).toEqual([
      "t1",
      '{"n":3}',
      1,
      1,
      0,
      2_000,
    ]);
    expect(store.effectMaxSeq()).toBe(2);

    // The attempt that ran the old payload does not delete or change the new one.
    store.effectDone("delivery", first);
    store.effectFailed("delivery", first, "late", 9_000);
    store.effectLater("delivery", first, 9_000);
    expect(store.effectHead("delivery")).toEqual(replaced);

    store.effectDone("delivery", replaced);
    expect(store.effectHead("delivery")?.key).toBe("t2");
    store.close();
  });

  test("selects due rows in queue order, wakes unfailed rows, and reschedules them", () => {
    const store = Store.memory();
    expect(store.effectNextDue()).toBeUndefined();
    for (const [seq, key] of [
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ] as const) {
      store.effectEnqueue("launch", key, "{}", seq, 1_000);
    }
    store.effectEnqueue("relay", "r", "{}", 4, 2_000);
    expect(store.effectNextDue()).toBe(1_000);

    const keys = (rows: EffectRow[]): string[] => rows.map((row) => row.key);
    expect(store.effectDue("launch", 999, 16)).toEqual([]);
    expect(keys(store.effectDue("launch", 1_000, 16))).toEqual(["a", "b", "c"]);
    expect(keys(store.effectDue("launch", 1_000, 2))).toEqual(["a", "b"]);

    const a = store.effectHead("launch")!;
    store.effectLater("launch", a, 3_000);
    expect(keys(store.effectDue("launch", 1_000, 16))).toEqual(["b", "c"]);
    // An ordered kind still waits behind its oldest row, due or not.
    const head = store.effectHead("launch");
    expect([head?.key, head?.attempts, head?.due]).toEqual(["a", 0, 3_000]);

    // Wake pulls unfailed future rows of kind forward, leaving failed rows untouched.
    const b = store.effectDue("launch", 1_000, 1)[0];
    store.effectFailed("launch", b, "temporary", 9_000);
    store.effectWakeKind("launch", 1_500);
    expect(store.effectHead("launch")?.due).toBe(1_500);
    expect(store.effectDue("launch", 1_500, 16).map((r) => r.key)).toEqual(["a", "c"]);

    expect(store.effectPending("launch")).toBe(true);
    expect(store.effectPending("launch", "b")).toBe(true);
    expect(store.effectPending("launch", "z")).toBe(false);
    store.effectCancel("launch", "b");
    expect(store.effectPending("launch", "b")).toBe(false);
    expect(store.effectPending("sidecar")).toBe(false);
    store.close();
  });

  test("summarizes a kind's queue for its health and truncates long errors to 1000 Unicode chars", () => {
    const store = Store.memory();
    const empty = store.effectSummary("reply");
    expect([empty.waiting, empty.since, empty.attempts, empty.error]).toEqual([0, undefined, 0, undefined]);

    store.effectEnqueue("reply", "m1", "{}", 1, 1_767_225_600_000);
    store.effectEnqueue("reply", "m2", "{}", 2, 1_767_225_660_000);
    const row = store.effectHead("reply")!;
    // 1500 emoji code points (each 2 UTF-16 units) truncate cleanly to 1000 code points without splitting surrogates.
    const emojis = "🔥".repeat(1_500);
    store.effectFailed("reply", row, emojis, 0);
    const afterLong = store.effectSummary("reply");
    expect([...(afterLong.error ?? "")].length).toBe(1_000);

    store.effectFailed("reply", row, "the channel is offline", 0);
    const summary = store.effectSummary("reply");
    expect([summary.waiting, summary.attempts]).toEqual([2, 2]);
    expect(summary.since).toBe("2026-01-01T00:00:00.000Z");
    expect(summary.error).toBe("the channel is offline");
    expect(store.effectAttempts("reply", "missing")).toBeUndefined();
    store.close();
  });

  test("queues an effect and its state change together or not at all", () => {
    const store = Store.memory();
    expect(() =>
      store.atomic(() => {
        store.saveTicket(makeTicket("t1"));
        store.addReceipt(makeMessage("m1", "t1", "c1"));
        store.effectEnqueue("reply", "m1", "{}", 1, 0);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(store.ticket("t1")).toBeUndefined();
    expect(store.receipt("m1")).toBeUndefined();
    expect(store.effectPending("reply")).toBe(false);
    store.close();
  });
});

// --- pagination, batch lookup, sent files, and commit hooks ---

describe("pagination, batch lookup, sent files, and commit hooks", () => {
  test("pages tickets newest first and reports total ticketCount", () => {
    const store = Store.memory();
    expect(store.ticketCount()).toBe(0);
    expect(store.ticketPage(0, 10)).toEqual([]);

    for (let i = 1; i <= 5; i++) {
      store.saveTicket(makeTicket(`t${i}`));
    }
    expect(store.ticketCount()).toBe(5);
    expect(store.ticketPage(0, 2).map((t) => t.id)).toEqual(["t5", "t4"]);
    expect(store.ticketPage(2, 2).map((t) => t.id)).toEqual(["t3", "t2"]);
    expect(store.ticketPage(4, 2).map((t) => t.id)).toEqual(["t1"]);
    expect(store.ticketPage(5, 2)).toEqual([]);
    expect(store.ticketPage(0, 0)).toEqual([]);

    // Updating an existing ticket does not change ticketCount or its rowid order.
    const updated = makeTicket("t2");
    updated.title = "Updated t2";
    store.saveTicket(updated);
    expect(store.ticketCount()).toBe(5);
    expect(store.ticketPage(0, 5).map((t) => t.id)).toEqual(["t5", "t4", "t3", "t2", "t1"]);
    expect(store.ticket("t2")?.title).toBe("Updated t2");
    store.close();
  });

  test("batch-fetches triggersByIds across empty, missing, duplicate, and >250 batches", () => {
    const store = Store.memory();
    expect(store.triggersByIds([]).size).toBe(0);
    expect(store.triggersByIds(["missing-1", "missing-2"]).size).toBe(0);

    const total = 265;
    const allIds: string[] = [];
    store.atomic(() => {
      for (let i = 0; i < total; i++) {
        const id = `trig-${String(i).padStart(3, "0")}`;
        allIds.push(id);
        store.saveTrigger(makeTrigger(id, "t1", `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`));
      }
    });

    // Include duplicates and missing IDs alongside all 265 stored IDs (>200 chunk boundary).
    const queriedIds = [...allIds, "trig-000", "trig-264", "not-found"];
    const fetched = store.triggersByIds(queriedIds);
    expect(fetched.size).toBe(total);
    expect(fetched.get("trig-000")?.text).toBe("message trig-000");
    expect(fetched.get("trig-199")?.text).toBe("message trig-199");
    expect(fetched.get("trig-200")?.text).toBe("message trig-200");
    expect(fetched.get("trig-264")?.text).toBe("message trig-264");
    expect(fetched.has("not-found")).toBe(false);
    store.close();
  });

  test("extracts sentFilesByTicket from sent outbox receipts fault-tolerantly", () => {
    withTempDir("sent-files", (dir) => {
      const dbPath = path.join(dir, "sent-files.sqlite");
      const store = Store.open(dbPath);
      const sendFileReceipt = (id: string, ticketId: string | undefined, text: string, kind: "reply" | "acknowledgement" = "reply") => {
        store.recordSentReceipt(
          {
            id,
            channel: {
              source: "chat",
              thread: "wechat:u1",
              address: { surface: "wechat", conversation: "wechat:u1", sender: "wechat:u1" },
            },
            text,
            kind,
            ...(ticketId !== undefined ? { ticketId } : {}),
          },
          "2026-01-01T00:00:00.000Z",
        );
      };

      // Standalone filenames (ASCII & Chinese) and captions mentioning deliverable files.
      sendFileReceipt("f1", "t1", "report.docx");
      sendFileReceipt("f2", "t1", "2026年市场调研报告.pdf");
      sendFileReceipt("f3", "t1", "已更新，请查收 summary.xlsx 和 report.docx");
      // Normal prose, URLs, acknowledgements, pending, dropped, and no-ticketId rows are ignored.
      sendFileReceipt("f4", "t1", "任务已完成，没有附件。");
      sendFileReceipt("f5", "t1", "请访问 https://example.com/hidden.pdf 查看");
      sendFileReceipt("f6", "t1", "收到，开始准备 ack-ignored.pdf", "acknowledgement");
      sendFileReceipt("f7", undefined, "orphan.pdf");
      store.addReceipt({ ...makeMessage("f8", "t2", "wechat:u1"), text: "pending-only.pdf" });
      store.addReceipt({ ...makeMessage("f9", "t2", "wechat:u1"), text: "dropped-only.pdf" });
      store.settleReceipt({ ...makeMessage("f9", "t2", "wechat:u1"), text: "dropped-only.pdf" }, settledDropped("channelGone"));
      sendFileReceipt("f10", "t3", "Q1 Sales Report.pdf");
      store.close();

      // Inject unexpected JSON shapes directly to verify fault-tolerance (never throws).
      const rawDb = new Database(dbPath, { readwrite: true });
      rawDb
        .query("INSERT INTO outbox (id, value) VALUES (?1, ?2)")
        .run("weird-1", JSON.stringify({ status: "sent", ticketId: "t1", kind: "reply", text: 12345 }));
      rawDb
        .query("INSERT INTO outbox (id, value) VALUES (?1, ?2)")
        .run("weird-2", JSON.stringify({ status: "sent", ticketId: "", kind: "reply", text: "empty.pdf" }));
      rawDb
        .query("INSERT INTO outbox (id, value) VALUES (?1, ?2)")
        .run("weird-3", JSON.stringify({ status: "sent", ticketId: "t4", kind: "reply", message: { text: "nested.pdf" } }));
      rawDb.close();

      const reopened = Store.open(dbPath);
      try {
        const files = reopened.sentFilesByTicket();
        expect(files.get("t1")).toEqual(["summary.xlsx", "report.docx", "2026年市场调研报告.pdf"]);
        expect(files.has("t2")).toBe(false);
        expect(files.get("t3")).toEqual(["Q1 Sales Report.pdf"]);
        expect(files.get("t4")).toEqual(["nested.pdf"]);
      } finally {
        reopened.close();
      }
    });
  });

  test("fires onTicketSaved and onThreadSaved only after outermost commit and never on rollback", () => {
    const store = Store.memory();
    const savedTickets: Array<{ id: string; title: string }> = [];
    const savedThreads: Array<{ key: string; pending: string[] }> = [];

    const unsubTicket = store.onTicketSaved((ticket) => {
      savedTickets.push({ id: ticket.id, title: ticket.title });
      // Mutating the delivered snapshot does not affect stored state or other listeners.
      ticket.title = "mutated-by-listener";
    });
    const unsubThread = store.onThreadSaved((thread) => {
      savedThreads.push({ key: thread.key, pending: [...thread.pending] });
    });

    // Outside a transaction, hooks fire immediately.
    store.saveTicket(makeTicket("t-direct"));
    store.saveThread(makeThread("th-direct"));
    expect(savedTickets).toEqual([{ id: "t-direct", title: "Ticket t-direct" }]);
    expect(savedThreads).toEqual([{ key: "chat:th-direct", pending: [] }]);
    expect(store.ticket("t-direct")?.title).toBe("Ticket t-direct");

    // Inside a transaction: deferred until outermost commit; rolled-back inner savepoints never notify.
    store.atomic(() => {
      const outerTicket = makeTicket("t-outer");
      store.saveTicket(outerTicket);
      const outerThread = makeThread("th-outer");
      outerThread.pending = ["g1"];
      store.saveThread(outerThread);

      // Inner committed savepoint merges into outer commit.
      store.atomic(() => {
        store.saveTicket(makeTicket("t-inner-ok"));
      });

      // Inner rolled-back savepoint discards its notifications.
      expect(() =>
        store.atomic(() => {
          store.saveTicket(makeTicket("t-inner-fail"));
          store.saveThread(makeThread("th-inner-fail"));
          throw new Error("inner rollback");
        }),
      ).toThrow("inner rollback");

      // Nothing fired yet before outer commit.
      expect(savedTickets.length).toBe(1);
      expect(savedThreads.length).toBe(1);
    });

    expect(savedTickets).toEqual([
      { id: "t-direct", title: "Ticket t-direct" },
      { id: "t-outer", title: "Ticket t-outer" },
      { id: "t-inner-ok", title: "Ticket t-inner-ok" },
    ]);
    expect(savedThreads).toEqual([
      { key: "chat:th-direct", pending: [] },
      { key: "chat:th-outer", pending: ["g1"] },
    ]);

    // Outer rollback discards all notifications (including committed nested savepoints).
    expect(() =>
      store.atomic(() => {
        store.saveTicket(makeTicket("t-outer-fail"));
        store.saveThread(makeThread("th-outer-fail"));
        store.atomic(() => {
          store.saveTicket(makeTicket("t-nested-under-failed-outer"));
          store.saveThread(makeThread("th-nested-under-failed-outer"));
        });
        throw new Error("outer rollback");
      }),
    ).toThrow("outer rollback");
    expect(savedTickets.length).toBe(3);
    expect(savedThreads.length).toBe(2);

    // Unsubscribe is idempotent and stops further notifications.
    unsubTicket();
    unsubTicket();
    unsubThread();
    unsubThread();
    store.saveTicket(makeTicket("t-after-unsub"));
    store.saveThread(makeThread("th-after-unsub"));
    expect(savedTickets.length).toBe(3);
    expect(savedThreads.length).toBe(2);
    store.close();
  });
});
