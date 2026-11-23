/**
 * The domain Engine's tests from `neo-core`, run against the real SQLite `Store` instead of `MemoryRepositories`.
 *
 * Covers intake, evals, fan-out, resume/stop, follow-ups, hand-backs, context threads, assignment lifecycle,
 * delivery/readAt tri-state round-trips, policy changes, worker reports, attach, direct decisions, automatic
 * input, replies, transactional rollback, and SQLite working-set/reopen fidelity.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  UserError,
  canRetry,
  createOutcome,
  followupOwners,
  isReadUndelivered,
  isReadWaiting,
  readAtTimestamp,
  reasonCode,
  runningAssignment,
  ticketInputTriggerId,
  ticketStage,
  waitsForPerson,
  type ReplyRequest,
  type Trigger,
} from "../../src/core/index.ts";
import { Store } from "../../src/store/index.ts";
import {
  Harness,
  acceptOutcome,
  acceptPlain,
  bot,
  by,
  catchUserError,
  errorCode,
  explicit,
  guest,
  harnessWith,
  ignore,
  inferred,
  meta,
  on,
  report,
  stop,
  thread,
  trigger,
  type Hooks,
} from "../core/common.ts";

function sqlHarness(hooks: Omit<Hooks, "repo"> = {}): { h: Harness; store: Store } {
  const store = Store.memory();
  const h = harnessWith({ ...hooks, repo: store });
  return { h, store };
}

function running(h: Harness, ticketId: string): string {
  const a = runningAssignment(h.ticket(ticketId));
  if (a === undefined) throw new Error("an assignment runs");
  return a.id;
}

function inputOf(h: Harness, ticketId: string, triggerId: string): string {
  const found = h.ticket(ticketId).inputs.find((input) => ticketInputTriggerId(input) === triggerId);
  if (found === undefined) throw new Error("the trigger reached the ticket");
  return found.id;
}

// --- intake & evals ---

describe("core engine over SQLite Store: intake & evals", () => {
  test("stores a trigger once, records source filtering, correlation, and refuses trigger without thread", () => {
    const { h, store } = sqlHarness();
    expect(h.receive(trigger("1"))).toBe("stored");
    expect(h.receive(trigger("1"))).toBe("duplicate");
    expect(h.receive(meta(trigger("2"), "blocked"))).toBe("filtered");
    expect(h.disposition("2").filtered).toEqual(reasonCode("chat not allowed"));
    expect(h.thread("chat:t1").pending).toEqual(["1"]);
    expect(store.activeThreads().map((t) => t.key)).toEqual(["chat:t1"]);
    expect(store.threadTriggers("chat:t1", 10).map((t) => t.id)).toEqual(["1", "2"]);

    const multi: Trigger = { ...trigger("3"), threads: [thread("t1"), thread("t2")] };
    expect(h.receive(multi)).toBe("stored");
    expect(h.thread("chat:t1").correlated).toContain("chat:t2");
    expect(h.thread("chat:t2").correlated).toContain("chat:t1");
    expect(h.thread("chat:t2").pending).toEqual([]);
    expect(store.threadTriggers("chat:t2", 10).map((t) => t.id)).toEqual(["3"]);

    expect(() => h.receive({ ...trigger("4"), threads: [] })).toThrow();
    store.close();
  });

  test("serializes evals per thread, debounces triggers, and handles expiry & policy version changes", () => {
    const { h, store } = sqlHarness();
    h.receive(trigger("1"));
    h.pump();
    expect(h.lastIds()).toEqual(["1"]);
    expect(store.activeThreads().map((t) => t.key)).toEqual(["chat:t1"]);

    // Second trigger debounces while first eval runs.
    h.receive(trigger("2"));
    h.pump();
    expect(h.requests()).toBe(1);
    expect(h.thread("chat:t1").pending).toEqual(["2"]);

    // Ignore first eval -> releases assessor & advances to second trigger on next pump.
    h.decide(h.lastRequest(), ignore("not needed"));
    expect(h.r.released.length).toBe(1);
    expect(store.decisionsByThread("chat:t1").map((d) => d.kind)).toEqual(["ignore"]);

    h.pump();
    expect(h.lastIds()).toEqual(["2"]);

    // Policy version change during assessment records unavailable and requeues the trigger under v2.
    h.setVersion("v2");
    const unavailable = h.decide(h.lastRequest(), acceptOutcome());
    expect(unavailable.kind).toBe("unavailable");
    expect(store.decisionsByThread("chat:t1").map((d) => d.kind)).toEqual(["ignore", "unavailable"]);
    expect(store.decisionsOfKinds(["unavailable"], 10).length).toBe(1);
    expect(store.activeThreads().map((t) => t.key)).toEqual(["chat:t1"]);
    expect(h.thread("chat:t1").pending).toEqual(["2"]);
    // Clear the requeued trigger before testing expiry on trigger 3.
    h.pump();
    h.decide(h.lastRequest(), ignore("settled under v2"));
    expect(store.activeThreads()).toEqual([]);

    // Expiry: counts from delivery, requeues twice, then records unavailable.
    h.receive(trigger("3"));
    h.pump();
    const eval1 = h.lastRequest().evalId;
    const reqBase = h.requests();
    h.engine.candidateDelivered(eval1);
    h.tick(61);
    h.engine.evaluateDue();
    expect(h.requests()).toBe(reqBase + 1);
    const eval2 = h.lastRequest().evalId;
    h.engine.candidateDelivered(eval2);
    h.tick(61);
    h.engine.evaluateDue();
    expect(h.requests()).toBe(reqBase + 2);
    const eval3 = h.lastRequest().evalId;
    h.engine.candidateDelivered(eval3);
    h.tick(61);
    h.engine.evaluateDue();
    expect(store.decisionsByThread("chat:t1").slice(-1)[0].kind).toBe("unavailable");
    expect(store.activeThreads()).toEqual([]);
    store.close();
  });

  test("records an accept atomically with ticket, subscriptions, and acknowledgement — or rolls back completely", () => {
    let fail = true;
    const { h, store } = sqlHarness({
      prepare: (ticket, _accept) => {
        if (fail) {
          throw UserError.invalid("workspace busy");
        }
        return ticket;
      },
    });
    h.receive(trigger("1"));
    h.pump();
    const candidate = h.lastRequest();
    expect(errorCode(() => h.decide(candidate, acceptOutcome()))).toBe("invalid");
    // SQLite rolled back completely: no ticket, no decision, eval still active.
    expect(store.tickets()).toEqual([]);
    expect(store.openTickets()).toEqual([]);
    expect(store.activeTickets()).toEqual([]);
    expect(store.subscribedThreads()).toEqual([]);
    expect(store.decisionsByThread("chat:t1")).toEqual([]);
    expect(h.thread("chat:t1").evaluating?.id).toBe(candidate.evalId);

    fail = false;
    const decision = h.decide(candidate, acceptOutcome());
    expect(decision.kind).toBe("accept");
    expect(decision.ticketId).toBeDefined();
    expect(store.openTickets().map((t) => t.id)).toEqual([decision.ticketId!]);
    expect(store.activeTickets().map((t) => t.id)).toEqual([decision.ticketId!]);
    expect(store.subscribedThreads("chat").map((t) => t.key)).toEqual(["chat:t1"]);
    expect(h.outbox().length).toBe(1);
    store.close();
  });
});

// --- fan-out, follow-ups, hand-backs, context threads ---

describe("core engine over SQLite Store: fan-out, follow-ups, hand-backs, context threads", () => {
  test("fans out to subscribed tickets, hands back to eval, and tracks context threads", () => {
    const { h, store } = sqlHarness();
    const ticketId = h.accepted();
    // Human follow-up fans out to open ticket and is owned by its worker.
    h.receive(trigger("2"));
    h.settle();
    expect(followupOwners(h.repo.trigger("2")!, h.repo)).toEqual([ticketId]);
    expect(errorCode(() => h.engine.decide("2", acceptPlain("Y")))).toBe("workerDecides");

    // Worker hands it back -> returns to eval on primary thread.
    expect(h.engine.handback(ticketId, "2", "outside scope")).toBe(true);
    expect(followupOwners(h.repo.trigger("2")!, h.repo)).toEqual([]);
    expect(store.activeThreads().map((t) => t.key)).toEqual(["chat:t1"]);
    h.pump();
    expect(h.lastIds()).toEqual(["2"]);

    // Context thread follow: subscribes thread in SQLite, receives triggers, but does not own follow-ups.
    h.engine.followForContext(ticketId, thread("t2"));
    expect(store.subscribedThreads("chat").map((t) => t.key)).toEqual(["chat:t1", "chat:t2"]);
    h.receive(on(trigger("3"), "t2"));
    h.settle();
    expect(h.ticket(ticketId).inputs.some((i) => ticketInputTriggerId(i) === "3")).toBe(true);
    expect(followupOwners(h.repo.trigger("3")!, h.repo)).toEqual([]);

    // Unfollow context thread works; unfollowing source thread is refused.
    h.engine.markUnrelated(ticketId, "chat:t2", "not relevant");
    expect(store.subscribedThreads("chat").map((t) => t.key)).toEqual(["chat:t1"]);
    expect(errorCode(() => h.engine.markUnrelated(ticketId, "chat:t1", "nope"))).toBe("sourceThread");
    store.close();
  });

  test("stops ticket on follow-up and accepts new work on the same trigger", () => {
    const { h, store } = sqlHarness();
    const ticketId = h.accepted();
    h.receive(trigger("2"));
    h.settle();

    const stopped = h.engine.decide("2", stop(ticketId, "asked to stop"));
    expect(stopped.kind).toBe("stop");
    expect(store.openTickets()).toEqual([]);
    expect(store.activeTickets()).toEqual([]);

    const accepted = h.engine.decide("2", acceptPlain("Y"));
    expect(accepted.kind).toBe("accept");
    expect(store.openTickets().map((t) => t.id)).toEqual([accepted.ticketId!]);
    expect(
      store
        .decisionsByThread("chat:t1")
        .filter((d) => d.triggerIds.includes("2"))
        .map((d) => d.kind),
    ).toEqual(["stop", "accept"]);
    store.close();
  });
});

// --- assignment lifecycle & readAt tri-state ---

describe("core engine over SQLite Store: assignment lifecycle & readAt round-trip", () => {
  test("preserves TriggerTicketInput readAt tri-state (undefined, null, timestamp) through SQLite JSON", () => {
    const { h, store } = sqlHarness();
    const ticketId = h.accepted();
    const assignmentId = running(h, ticketId);

    // 1. Undelivered: readAt is omitted (`undefined`).
    h.receive(trigger("2"));
    const inputId = inputOf(h, ticketId, "2");
    const undeliveredInput = h.ticket(ticketId).inputs.find((i) => i.id === inputId)!;
    expect(undeliveredInput.kind).toBe("trigger");
    if (undeliveredInput.kind === "trigger") {
      expect(isReadUndelivered(undeliveredInput.readAt)).toBe(true);
      expect("readAt" in undeliveredInput).toBe(false);
    }
    expect(store.activeTickets().map((t) => t.id)).toEqual([ticketId]);

    // 2. Delivered but unread: readAt is JSON `null` (`isReadWaiting`).
    h.engine.inputsDelivered(ticketId, assignmentId, [inputId]);
    const waitingInput = h.ticket(ticketId).inputs.find((i) => i.id === inputId)!;
    if (waitingInput.kind === "trigger") {
      expect(isReadWaiting(waitingInput.readAt)).toBe(true);
      expect(waitingInput.readAt).toBeNull();
    }

    // 3. Read by worker: readAt is ISO timestamp string.
    h.tick(5);
    h.read(ticketId);
    const readInput = h.ticket(ticketId).inputs.find((i) => i.id === inputId)!;
    if (readInput.kind === "trigger") {
      expect(readAtTimestamp(readInput.readAt)).toBeDefined();
      expect(typeof readInput.readAt).toBe("string");
    }
    store.close();
  });

  test("retries failed ticket, handles delivery failure, resumes ended ticket, and refuses revoked mandate", () => {
    const { h, store } = sqlHarness();
    const ticketId = h.accepted();
    expect(errorCode(() => h.engine.retryTicket(ticketId))).toBe("notRetryable");

    h.report(ticketId, "waiting", "idle");
    expect(ticketStage(h.ticket(ticketId))).toEqual({ kind: "idle" });
    expect(h.engine.requestStatus(ticketId)).toBe(true);

    h.report(ticketId, "failed", "broke");
    expect(canRetry(h.ticket(ticketId))).toBe(true);
    expect(waitsForPerson(h.ticket(ticketId))).toBe(true);
    const retried = h.engine.retryTicket(ticketId);
    expect(retried.assignments.length).toBe(2);
    expect(retried.assignments[1].state).toBe("pending");
    expect(store.activeTickets().map((t) => t.id)).toEqual([ticketId]);
    h.settle();

    // Delivery failure marks delivery field and makes ticket retryable.
    h.receive(trigger("2"));
    h.engine.deliveryFailed(ticketId, running(h, ticketId), "socket closed");
    expect(h.ticket(ticketId).delivery?.error).toBe("socket closed");
    expect(canRetry(h.ticket(ticketId))).toBe(true);
    h.settle();
    expect(h.ticket(ticketId).delivery).toBeUndefined();

    // Ready report ends ticket -> moves out of openTickets and activeTickets.
    h.report(ticketId, "ready", "done");
    expect(store.openTickets()).toEqual([]);
    expect(store.activeTickets()).toEqual([]);

    // Human message resumes ended ticket when mandate still valid.
    h.tick(1);
    h.receive(trigger("3"));
    expect(store.openTickets().map((t) => t.id)).toEqual([ticketId]);
    expect(store.activeTickets().map((t) => t.id)).toEqual([ticketId]);
    h.settle();

    // End again and revoke policy version -> follow-up cannot resume, routes to eval instead.
    h.report(ticketId, "ready", "done again");
    h.setVersion("revoked");
    h.tick(1);
    h.receive(trigger("4"));
    expect(store.openTickets()).toEqual([]);
    expect(store.activeThreads().map((t) => t.key)).toEqual(["chat:t1"]);
    store.close();
  });
});

// --- policy changes, reports, attach, automatic input, replies ---

describe("core engine over SQLite Store: reports, policy changes, attach, replies", () => {
  test("propagates policy changes, holds automatic input when blocked, handles worker reports & replies", () => {
    const { h, store } = sqlHarness();
    const ticketId = h.accepted();

    // Policy change delivers policy-changed input to open ticket.
    h.setVersion("v2");
    h.engine.policyChanged("v1", "v2", { [ticketId]: { proactive: false } });
    h.settle();
    expect(h.ticket(ticketId).inputs.some((i) => i.kind === "policy-changed")).toBe(true);

    // Worker reports blocked with a question -> automatic (bot) input held back until person responds.
    h.receive(trigger("2"));
    h.settle();
    h.read(ticketId);
    h.tick(1);
    h.engine.report(ticketId, {
      ...report("blocked", "need clarification"),
      question: { kind: "ask", question: "Which environment?" },
      askedBy: "2",
    });
    expect(h.ticket(ticketId).attention?.question).toBe("Which environment?");

    const deliversBefore = h.delivers();
    h.receive(bot(trigger("3")));
    expect(h.delivers()).toBe(deliversBefore);

    // Send attention reply.
    const attentionReq: ReplyRequest = {
      purpose: "attention",
      ticketId,
      question: "Which environment?",
      text: "Which environment should I deploy to?",
    };
    const sentAttention = h.engine.reply(attentionReq);
    expect(sentAttention.status).toBe("pending");

    // Person answers -> lifts waitsForPerson and delivers pending inputs.
    h.tick(1);
    h.receive(trigger("4"));
    h.settle();
    expect(waitsForPerson(h.ticket(ticketId))).toBe(false);

    // Worker reports answer and ready result; replies succeed once and refuse duplicate result.
    h.read(ticketId);
    h.tick(1);
    h.engine.report(ticketId, {
      ...report("ready", "deployed to staging"),
      answers: "4",
    });
    const ansReply = h.engine.reply({ purpose: "answer", triggerId: "4", text: "Deployed!" });
    expect(ansReply.reused).toBe(false);
    const resReply = h.engine.reply({ purpose: "result", ticketId, text: "All done" });
    expect(resReply.reused).toBe(false);
    expect(errorCode(() => h.engine.reply({ purpose: "result", ticketId, text: "Again" }))).toBe("resultSent");
    store.close();
  });

  test("attaches trigger from an eval to a ticket and persists full engine state across SQLite reopen", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "neo-store-engine-reopen-"));
    const dbPath = path.join(dir, "engine.sqlite");
    try {
      let ticketId: string;
      {
        const store = Store.open(dbPath);
        const h = harnessWith({
          repo: store,
          gate: (t, th) => {
            if (!t.human) return { kind: "inadmissible", reason: "not human" };
            if (t.actor.id === "alice") return explicit();
            if (th.subscriptions.length > 0) return inferred();
            return { kind: "inadmissible", reason: "guest" };
          },
        });
        ticketId = h.accepted();
        // Trigger on another thread held in eval gets attached to ticketId.
        h.receive(on(trigger("2"), "t2"));
        h.pump();
        expect(h.lastIds()).toEqual(["2"]);
        h.engine.attach(ticketId, "2", "related follow-up");
        expect(h.thread("chat:t2").evaluating).toBeUndefined();
        h.settle();
        // Guest message on subscribed thread is inferred.
        h.receive(by(trigger("3"), guest()));
        h.settle();
        // Verify direct ignore / dismiss unavailable also round-trip.
        h.receive(on(trigger("4"), "t3"));
        h.pump();
        const c = h.lastRequest();
        h.engine.decide("4", createOutcome({ kind: "unavailable" }, "model down", { evalId: c.evalId }));
        const decId = store.decisionsByThread("chat:t3")[0].id;
        expect(h.engine.dismiss(decId).dismissed).toBe(true);
        store.close();
      }

      // Reopen on disk and confirm all aggregates, working sets, and indexes survived intact.
      const reopened = Store.open(dbPath);
      try {
        expect(reopened.openTickets().map((t) => t.id)).toEqual([ticketId]);
        expect(reopened.activeTickets().map((t) => t.id)).toEqual([ticketId]);
        // Attaching trigger 2 from chat:t2 also subscribes the ticket to chat:t2.
        expect(reopened.subscribedThreads("chat").map((t) => t.key)).toEqual(["chat:t1", "chat:t2"]);
        expect(reopened.ticket(ticketId)?.inputs.some((i) => ticketInputTriggerId(i) === "2")).toBe(true);
        expect(reopened.decisionsByThread("chat:t3")[0].dismissed).toBe(true);
        expect(reopened.threadTriggers("chat:t1", 10).map((t) => t.id)).toEqual(["1", "3"]);
        expect(reopened.threadTriggers("chat:t2", 10).map((t) => t.id)).toEqual(["2"]);
        // Verify error guard helper works cleanly on reopened repo too.
        const h2 = harnessWith({ repo: reopened });
        const err = catchUserError(() => h2.engine.retryTicket(ticketId));
        expect(err.code).toBe("notRetryable");
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shifts eval deadline during pause, handles assignment interruption, unsubscribe, and stop cleanup", () => {
    const { h, store } = sqlHarness();
    // Pause holds expiry and shifts eval deadline when unpaused.
    h.receive(trigger("1"));
    h.pump();
    const evalId = h.lastRequest().evalId;
    h.engine.candidateDelivered(evalId);
    const beforeDeadline = h.thread("chat:t1").evaluating!.deadline;
    h.setPaused(true);
    h.tick(30);
    h.engine.evaluateDue();
    expect(h.thread("chat:t1").evaluating?.pausedAt).toBeDefined();
    h.tick(120);
    h.engine.evaluateDue();
    expect(h.thread("chat:t1").evaluating?.id).toBe(evalId);
    h.setPaused(false);
    h.engine.evaluateDue();
    expect(h.thread("chat:t1").evaluating?.pausedAt).toBeUndefined();
    expect(h.thread("chat:t1").evaluating!.deadline > beforeDeadline).toBe(true);

    // Accept, add note, interrupt running assignment -> restarts with recovery note.
    const ticketId = h.decide(h.lastRequest(), acceptOutcome()).ticketId!;
    h.settle();
    h.engine.note(ticketId, "context fact from main session");
    h.settle();
    const runningId = running(h, ticketId);
    h.engine.assignmentInterrupted(ticketId, runningId);
    const restarted = h.ticket(ticketId);
    expect(restarted.assignments.length).toBe(2);
    expect(restarted.assignments[0].state).toBe("ended");
    expect(restarted.assignments[1].state).toBe("pending");
    expect(restarted.inputs.some((i) => i.kind === "text" && i.text.includes("host restarted"))).toBe(true);
    h.settle();

    // Unsubscribe drops every subscription on thread and updates thread_subscribed index.
    expect(h.engine.unsubscribe("chat:t1")).toBe(true);
    expect(store.subscribedThreads()).toEqual([]);

    // Human stop clears pending undelivered/attention/delivery and removes ticket from open & active sets.
    h.receive(trigger("2"));
    h.engine.stopTicket(ticketId, "done by hand");
    const stopped = h.ticket(ticketId);
    expect(stopped.ended?.by).toBe("human");
    expect(stopped.undelivered).toEqual([]);
    expect(stopped.attention).toBeUndefined();
    expect(store.openTickets()).toEqual([]);
    expect(store.activeTickets()).toEqual([]);
    store.close();
  });
});
