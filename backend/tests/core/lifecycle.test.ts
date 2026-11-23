/**
 * Assignment lifecycle: retries, failed deliveries, revoked Mandates, and what counts as read when a ticket ends.
 */

import { describe, expect, test } from "bun:test";
import {
  canRetry,
  followupOwners,
  reasonCode,
  runningAssignment,
  ticketInputTriggerId,
  ticketStage,
} from "../../src/core/index.ts";
import {
  Harness,
  acceptPlain,
  errorCode,
  harness,
  on,
  trigger,
} from "./common.ts";

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

function pending(h: Harness): string[] {
  return h.thread("chat:t1").pending;
}

/** A ticket that ended, resumed by a person's message `2`, whose new Assignment started; its Inputs wait for delivery. */
function resumed(): readonly [Harness, string, string, string, string] {
  const h = harness();
  const ticketId = h.accepted();
  h.report(ticketId, "ready", "done");
  h.tick(1);
  h.receive(trigger("2"));
  const assignment = h.ticket(ticketId).assignments.slice(-1)[0].id;
  h.tick(1);
  h.engine.assignmentStarted(ticketId, assignment);
  const waiting = h.ticket(ticketId).undelivered;
  expect(waiting.length).toBe(2);
  return [h, ticketId, assignment, waiting[0], waiting[1]];
}

describe("assignment lifecycle", () => {
  test("retries a failed ticket with a new assignment and asks only a waiting worker for its status", () => {
    const h = harness();
    const ticketId = h.accepted();
    expect(errorCode(() => h.engine.retryTicket(ticketId))).toBe("notRetryable");
    expect(h.engine.requestStatus(ticketId)).toBe(false);
    expect(h.ticket(ticketId).inputs).toEqual([]);
    h.report(ticketId, "waiting", "idle");
    expect(ticketStage(h.ticket(ticketId))).toEqual({ kind: "idle" });
    expect(h.engine.requestStatus(ticketId)).toBe(true);
    const inputs = h.ticket(ticketId).inputs;
    expect(inputs.length).toBe(1);
    expect(inputs[0].kind).toBe("text");
    if (inputs[0].kind === "text") {
      expect(inputs[0].text).toContain("status-only");
    }
    h.report(ticketId, "failed", "broke");
    expect(canRetry(h.ticket(ticketId))).toBe(true);
    const starts = h.starts();
    const stops = h.stops();
    const retried = h.engine.retryTicket(ticketId);
    expect(retried.assignments.length).toBe(2);
    expect([retried.assignments[0].state, retried.assignments[0].endedReason]).toEqual([
      "ended",
      "retried",
    ]);
    expect(retried.assignments[1].state).toBe("pending");
    expect([h.starts(), h.stops()]).toEqual([starts + 1, stops + 1]);
    expect(h.r.launches[h.r.launches.length - 1]?.[1].id).toBe(retried.assignments[1].id);
    expect(errorCode(() => h.engine.retryTicket("missing"))).toBe("unknownTicket");
  });

  test("wakes a running worker for the watchdog and leaves an ended ticket alone", () => {
    const h = harness();
    const ticketId = h.accepted();
    expect(h.engine.wakeWorker(ticketId, "The build finished 10 minutes ago.")).toBe(true);
    h.settle();
    const inputs = h.ticket(ticketId).inputs;
    expect(inputs.length).toBe(1);
    expect(inputs[0].kind).toBe("text");
    if (inputs[0].kind === "text") {
      expect(inputs[0].text).toBe("[Watchdog] The build finished 10 minutes ago.");
    }
    expect(h.delivered().length).toBe(1);
    h.engine.stopTicket(ticketId);
    expect(h.engine.wakeWorker(ticketId, "again")).toBe(false);
  });

  test("forgets a failed delivery once a new assignment takes over or the ticket ends", () => {
    const h = harness();
    const ticketId = h.accepted();
    const failed = () => {
      h.engine.deliveryFailed(ticketId, running(h, ticketId), "Session busy");
      expect(h.ticket(ticketId).delivery?.error).toBe("Session busy");
    };
    failed();
    h.report(ticketId, "blocked", "needs access");
    h.engine.retryTicket(ticketId);
    h.settle();
    expect(h.ticket(ticketId).delivery).toBeUndefined();
    failed();
    h.engine.stopTicket(ticketId);
    expect(h.ticket(ticketId).delivery).toBeUndefined();
  });

  test("starts a new assignment for a ticket whose input keeps failing to reach its worker", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.report(ticketId, "failed", "tests fail");
    // A person's answer goes to the failed worker, and delivering it fails.
    h.tick(5);
    h.receive(trigger("2"));
    expect(h.ticket(ticketId).undelivered.length).toBe(1);
    h.engine.deliveryFailed(ticketId, running(h, ticketId), "Session gone");
    expect(ticketStage(h.ticket(ticketId))).toEqual({ kind: "person", action: "delivery" });
    const retried = h.engine.retryTicket(ticketId);
    expect(retried.assignments.map((a) => a.state)).toEqual(["ended", "pending"]);
    expect(retried.delivery).toBeUndefined();
    expect(retried.undelivered.length).toBe(1);
  });

  test("truncates a long delivery error", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.engine.deliveryFailed(ticketId, running(h, ticketId), "界".repeat(500));
    expect(Array.from(h.ticket(ticketId).delivery!.error).length).toBe(300);
  });

  test("changes nothing on a late start of an assignment a retry replaced", () => {
    const h = harness();
    const ticketId = h.accepted();
    const first = h.ticket(ticketId).assignments[0].id;
    h.report(ticketId, "failed", "broke");
    h.engine.retryTicket(ticketId);
    const before = h.ticket(ticketId);
    const delivered = h.delivered().length;
    h.engine.assignmentStarted(ticketId, first);
    h.settleWith(false);
    expect(h.ticket(ticketId).assignments).toEqual(before.assignments);
    expect(h.delivered().length).toBe(delivered);
  });

  test("refuses to retry a ticket a person stopped after its failed report", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.report(ticketId, "failed", "broke");
    h.engine.stopTicket(ticketId);
    expect(errorCode(() => h.engine.retryTicket(ticketId))).toBe("notRetryable");
  });

  test("queues an evals batch again when it is decided under an older policy", () => {
    const h = harness();
    h.receive(trigger("1"));
    h.pump();
    const candidate = h.lastRequest();
    // The version changes without a Policy change being reported, such as across a restart.
    h.setVersion("v2");
    const decision = h.decide(candidate, acceptPlain("Fix"));
    expect([decision.kind, decision.reason]).toEqual([
      "unavailable",
      [reasonCode("policyChanged")],
    ]);
    expect(pending(h)).toEqual(["1"]);
    h.pump();
    expect([h.lastRequest().policyVersion, h.lastIds()]).toEqual(["v2", ["1"]]);
  });

  test("queues a persons message for eval when the only ticket it reached cannot resume under the policy now", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.report(ticketId, "ready", "Done");
    h.settle();
    h.setVersion("revoked");
    h.tick(5);
    h.receive(trigger("2"));
    const ticket = h.ticket(ticketId);
    expect(ticket.undelivered).toEqual([]);
    expect(ticket.ended).toBeDefined();
    expect(pending(h)).toEqual(["2"]);
    expect(followupOwners(h.repo.trigger("2")!, h.repo)).toEqual([]);
  });

  test("queues a message that waited out a pause for eval when its ticket cannot resume once the pause lifts", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.report(ticketId, "ready", "Done");
    h.settle();
    h.setPaused(true);
    h.tick(5);
    h.receive(trigger("2"));
    h.pump();
    expect(h.ticket(ticketId).undelivered.length).toBe(1);
    h.setVersion("revoked");
    h.setPaused(false);
    h.engine.evaluateDue();
    const ticket = h.ticket(ticketId);
    expect(ticket.undelivered).toEqual([]);
    expect(ticket.ended).toBeDefined();
    expect(pending(h).includes("2") || h.engine.candidate("2") !== undefined).toBe(true);
  });
});

// --- what a worker read ---

describe("what a worker read", () => {
  test("lets a stop send to eval a message that waited for delivery when a turn ended", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.report(ticketId, "progress", "working");
    h.tick(1);
    h.receive(trigger("2"));
    const assignment = running(h, ticketId);
    const input = h.ticket(ticketId).undelivered[0];
    // The turn ends while the message is on its way; it reaches the worker after, and a person stops the ticket.
    h.tick(1);
    h.engine.turnEnded(ticketId, assignment);
    h.tick(1);
    h.engine.inputsDelivered(ticketId, assignment, [input]);
    h.tick(1);
    h.engine.stopTicket(ticketId, "not needed");
    expect(pending(h)).toEqual(["2"]);
  });

  test("lets a stop send to eval a message that came before a waiting report but reached the worker after it", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.tick(1);
    h.receive(trigger("2"));
    const assignment = running(h, ticketId);
    const input = h.ticket(ticketId).undelivered[0];
    h.tick(1);
    h.report(ticketId, "waiting", "Waiting for input");
    h.tick(1);
    h.engine.inputsDelivered(ticketId, assignment, [input]);
    h.tick(1);
    h.engine.stopTicket(ticketId, "not needed");
    expect(pending(h)).toEqual(["2"]);
  });

  test("sends to eval a message that reached its worker only after a progress report at a dropped report", () => {
    const [h, ticketId, assignment, note, message] = resumed();
    // Delivering the message fails at first; the worker reports progress, and the retry hands the message over while
    // it writes that nothing is left.
    h.engine.inputsDelivered(ticketId, assignment, [note]);
    h.engine.deliveryFailed(ticketId, assignment, "Session busy");
    h.tick(1);
    h.report(ticketId, "progress", "Looking");
    h.tick(1);
    h.engine.inputsDelivered(ticketId, assignment, [message]);
    h.tick(1);
    h.report(ticketId, "dropped", "Nothing to do");
    expect(pending(h)).toEqual(["2"]);
  });

  test("counts a message as read by a later dropped report once the session took it into a step", () => {
    const [h, ticketId, assignment, note, message] = resumed();
    // The Session takes it into the step its arrival starts, before the Executor records the delivery.
    h.engine.inputsRead(ticketId, [message]);
    h.engine.inputsDelivered(ticketId, assignment, [note, message]);
    h.tick(1);
    h.report(ticketId, "progress", "Looking");
    h.tick(1);
    h.report(ticketId, "dropped", "Nothing to do");
    expect(pending(h)).toEqual([]);
  });

  test("counts a message delivered after a failure and a turn end as read only once a step took it", () => {
    for (const taken of [false, true]) {
      const [h, ticketId, assignment, note, message] = resumed();
      h.engine.inputsDelivered(ticketId, assignment, [note]);
      h.engine.deliveryFailed(ticketId, assignment, "Session busy");
      h.tick(1);
      h.engine.turnEnded(ticketId, assignment);
      h.tick(1);
      h.engine.inputsDelivered(ticketId, assignment, [message]);
      if (taken) {
        h.read(ticketId);
      }
      h.tick(1);
      h.report(ticketId, "dropped", "Nothing to do");
      expect(pending(h)).toEqual(taken ? [] : ["2"]);
    }
  });

  test("counts a message a step took before a restart as read only once the restarted worker reports", () => {
    for (const reported of [false, true]) {
      const h = harness();
      const ticketId = h.accepted();
      h.report(ticketId, "progress", "working");
      h.tick(1);
      h.receive(trigger("2"));
      h.settle();
      h.read(ticketId);
      // The Assignment starts again with a recovery note, in the same Session, which holds the message.
      h.tick(1);
      h.engine.assignmentInterrupted(ticketId, running(h, ticketId));
      h.settle();
      if (reported) {
        h.tick(1);
        h.report(ticketId, "progress", "Recovered");
      }
      h.tick(1);
      h.engine.stopTicket(ticketId, "not needed");
      expect(pending(h)).toEqual(reported ? [] : ["2"]);
    }
  });

  test("gives a retrys assignment the messages the failed one had delivered but no step took", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.tick(1);
    h.receive(trigger("2"));
    h.settle();
    const input = inputOf(h, ticketId, "2");
    expect(h.ticket(ticketId).undelivered).toEqual([]);
    h.tick(1);
    h.report(ticketId, "failed", "The turn broke.");
    h.tick(1);
    h.engine.retryTicket(ticketId);
    expect(h.ticket(ticketId).undelivered).toEqual([input]);
  });

  test("gives a retry only what the assignment it replaces had delivered not what an earlier end let go of", () => {
    const h = harness();
    const ticketId = h.accepted();
    // A follow-up reaches the worker, and the ticket ends before any step took it, which sends it to Eval.
    h.tick(1);
    h.receive(trigger("2"));
    h.settle();
    h.tick(1);
    h.report(ticketId, "dropped", "nothing to do");
    expect(pending(h)).toEqual(["2"]);
    // A person's message resumes the ticket; its worker reports blocked before a step took it, and a person retries.
    h.tick(1);
    h.receive(trigger("3"));
    h.settle();
    h.tick(1);
    h.report(ticketId, "blocked", "Which page?");
    h.tick(1);
    h.engine.retryTicket(ticketId);
    expect(h.ticket(ticketId).undelivered).toEqual([inputOf(h, ticketId, "3")]);
  });

  test("gives a restarts assignment what the replaced one had delivered and a retry of it gets it again", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.tick(1);
    h.receive(trigger("2"));
    h.settle();
    // The host restarts mid-work before a step took the message: the new Assignment gets it.
    h.tick(1);
    h.engine.assignmentInterrupted(ticketId, running(h, ticketId));
    expect(h.ticket(ticketId).undelivered[0]).toBe(inputOf(h, ticketId, "2"));
    h.settle();
    // That Assignment blocks before a step took it, and a person retries: the retry's Assignment gets it too.
    h.tick(1);
    h.report(ticketId, "blocked", "Which page?");
    h.tick(1);
    h.engine.retryTicket(ticketId);
    expect(h.ticket(ticketId).undelivered).toEqual([inputOf(h, ticketId, "2")]);
  });

  test("rolls a command back when it fails part way", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(on(trigger("2"), "x"));
    const beforeTicket = h.ticket(ticketId);
    const beforeThread = h.thread("chat:x");
    const beforeDisposition = h.disposition("2");
    h.report(ticketId, "ready", "done");
    h.setVersion("revoked");
    // The attach is refused after reading state, and nothing it touched changed.
    expect(errorCode(() => h.engine.attach(ticketId, "2"))).toBe("mandateRevoked");
    expect([h.thread("chat:x"), h.disposition("2")]).toEqual([beforeThread, beforeDisposition]);
    expect(h.ticket(ticketId).inputs).toEqual(beforeTicket.inputs);
  });
});
