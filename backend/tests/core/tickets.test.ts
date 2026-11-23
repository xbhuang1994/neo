/**
 * Ticket behaviour: follow-up ownership at a ticket's end, interruptions, pause, policy changes, worker reports,
 * attach, direct decisions, automatic input and replies.
 */

import { describe, expect, test } from "bun:test";
import {
  createOutcome,
  followupOwners,
  key,
  parseIso,
  reasonCode,
  reasonOf,
  reasonWith,
  runningAssignment,
  ticketInputTriggerId,
  ticketStage,
  waitsForPerson,
  type PolicyEffect,
  type ReplyRequest,
  type ReportState,
  type WorkerReport,
} from "../../src/core/index.ts";
import {
  Harness,
  acceptPlain,
  bot,
  by,
  catchUserError,
  channel,
  errorCode,
  guest,
  harness,
  ignore,
  member,
  on,
  report,
  stop,
  thread,
  trigger,
} from "./common.ts";

function owners(h: Harness, triggerId: string): string[] {
  return followupOwners(h.repo.trigger(triggerId)!, h.repo);
}

function expectWorkerDecides(fn: () => unknown, tickets: string): void {
  const err = catchUserError(fn);
  expect(err.code).toBe("workerDecides");
  expect(err.values).toEqual({ tickets });
}

function ack(ticketId: string, triggerId: string, text: string): ReplyRequest {
  return { purpose: "acknowledgement", ticketId, triggerId, text };
}

function answer(triggerId: string, text: string): ReplyRequest {
  return { purpose: "answer", triggerId, text };
}

function result(ticketId: string, text: string): ReplyRequest {
  return { purpose: "result", ticketId, text };
}

function attention(ticketId: string, question: string | undefined, text: string): ReplyRequest {
  return {
    purpose: "attention",
    ticketId,
    ...(question !== undefined ? { question } : {}),
    text,
  };
}

// --- follow-up owners ---

describe("follow-up owners", () => {
  test("lets the main session take a follow up as new work once it stopped the ticket on it", () => {
    const h = harness();
    const ticketId = h.accepted();
    // "Stop this, and do Y instead": the stop ends the ticket that decided the message, so the request is the main Session's.
    h.receive(trigger("2"));
    h.settle();
    expectWorkerDecides(() => h.engine.decide("2", acceptPlain("Y")), ticketId);
    expect(h.engine.decide("2", stop(ticketId, "asked to stop")).kind).toBe("stop");
    // At the same moment, the accept is a Decision of its own beside the stop's.
    const accepted = h.engine.decide("2", acceptPlain("Y"));
    expect([accepted.kind, accepted.triggerIds]).toEqual(["accept", ["2"]]);
    const kinds = h
      .decisions("chat:t1")
      .filter((d) => d.triggerIds.includes("2"))
      .map((d) => d.kind);
    expect(kinds).toEqual(["stop", "accept"]);
  });

  test("sends a follow up its worker never received to eval when the ticket ends", () => {
    for (const byReport of [true, false]) {
      const h = harness();
      const ticketId = h.accepted();
      h.receive(trigger("2"));
      expect(h.ticket(ticketId).undelivered.length).toBe(1);
      if (byReport) {
        h.report(ticketId, "dropped", "nothing to do");
      } else {
        h.engine.stopTicket(ticketId, "not needed");
      }
      expect(h.thread("chat:t1").pending).toEqual(["2"]);
      h.pump();
      expect(h.lastIds()).toEqual(["2"]);
    }
  });

  test("sends a follow up its worker got since its last report to eval unless it acknowledged it", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.report(ticketId, "progress", "working");
    // The worker acknowledges one of two messages, and its final report was on its way before it took up the other.
    h.tick(1);
    h.receive(trigger("2"));
    h.receive(trigger("3"));
    h.settle();
    h.engine.reply(ack(ticketId, "2", "On it"));
    h.report(ticketId, "dropped", "nothing to do");
    expect(h.thread("chat:t1").pending).toEqual(["3"]);
    // The ticket no longer counts as having reached it.
    expect([h.disposition("2").fanout, h.disposition("3").fanout]).toEqual([[ticketId], []]);
  });

  test("gives a follow up its ended ticket let go to that ticket again when attached there", () => {
    for (const resumed of [false, true]) {
      const h = harness();
      const ticketId = h.accepted();
      // The ticket ends before its worker took up a person's message, which goes to Eval; a later message may resume it.
      h.report(ticketId, "progress", "working");
      h.tick(1);
      h.receive(trigger("2"));
      h.settle();
      h.report(ticketId, "dropped", "nothing to do");
      if (resumed) {
        h.tick(1);
        h.receive(trigger("3"));
      }
      h.pump();
      h.tick(1);
      h.engine.attach(ticketId, "2");
      h.settle();
      // Its worker gets the message again, and an ended ticket resumes for it.
      const copies = h
        .ticket(ticketId)
        .inputs.filter((i) => ticketInputTriggerId(i) === "2")
        .map((i) => i.id);
      expect(copies.length).toBe(2);
      expect(h.delivered()).toContainEqual([ticketId, copies[1]]);
      expect(h.ticket(ticketId).ended).toBeUndefined();
      expect(owners(h, "2")).toEqual([ticketId]);
    }
  });

  test("wakes an ended ticket for an attached message its worker read only for context or before its last report", () => {
    for (const context of [true, false]) {
      const h = harness();
      const ticketId = h.accepted();
      if (context) {
        h.engine.followForContext(ticketId, thread("issue"));
      }
      h.tick(1);
      h.receive(on(trigger("2"), context ? "issue" : "t1"));
      h.settle();
      // The worker reports after reading it and drops the ticket; a person sends a follow-up it had to Eval.
      h.tick(1);
      h.report(ticketId, "progress", "read it");
      h.report(ticketId, "dropped", "nothing to do");
      if (!context) {
        h.engine.reevaluate("2");
      }
      h.pump();
      h.tick(1);
      h.engine.attach(ticketId, "2");
      h.settle();
      expect(h.ticket(ticketId).ended).toBeUndefined();
      expect(owners(h, "2")).toEqual([ticketId]);
    }
  });

  test("counts a question the final report answers as taken up", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.tick(1);
    h.receive(trigger("2"));
    h.settle();
    h.engine.report(ticketId, { ...report("ready", "It reads the config."), answers: "2" });
    expect(h.thread("chat:t1").pending).toEqual([]);
    const disposition = h.disposition("2");
    expect([disposition.fanout, disposition.acked ?? []]).toEqual([[ticketId], [ticketId]]);
  });

  test("sends to eval a message attached after its eval was unavailable once its ticket ends without taking it up", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(on(trigger("2"), "x"));
    h.pump();
    h.decide(h.lastRequest(), createOutcome({ kind: "unavailable" }, "model down"));
    h.tick(1);
    h.engine.attach(ticketId, "2");
    h.settle();
    h.report(ticketId, "dropped", "nothing to do");
    expect(h.thread("chat:x").pending).toEqual(["2"]);
  });

  test("counts a message that resumed a ticket as read by the report that ends it again unlike one that came later", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.report(ticketId, "ready", "done");
    // A person's thanks resumes the ticket, and its worker takes it into a step first; a request comes while it
    // reports that nothing is left.
    h.tick(1);
    h.receive(trigger("2"));
    h.tick(1);
    const latest = h.ticket(ticketId).assignments.slice(-1)[0].id;
    h.engine.assignmentStarted(ticketId, latest);
    h.tick(1);
    h.settle();
    h.read(ticketId);
    h.tick(1);
    h.receive(trigger("3"));
    h.settle();
    h.report(ticketId, "dropped", "nothing to do");
    expect(h.thread("chat:t1").pending).toEqual(["3"]);
  });

  test("sends a follow up to eval after a stop on it was refused but not the one a stop ended it on", () => {
    // A guest's stop is refused, and the worker drops the ticket; a member's stop ends it, and the main Session, which
    // stopped it, decides the rest of the message itself.
    for (const fromGuest of [true, false]) {
      const h = harness();
      const ticketId = h.accepted();
      h.receive(by(trigger("2"), fromGuest ? guest() : member()));
      h.engine.decide("2", stop(ticketId, "asked to stop"));
      if (fromGuest) {
        h.report(ticketId, "dropped", "nothing to do");
      }
      expect(h.thread("chat:t1").pending).toEqual(fromGuest ? ["2"] : []);
    }
  });

  test("hands the follow ups on a thread a worker found unrelated back to eval with its reason", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(on(trigger("2"), "x"));
    h.pump();
    h.engine.attach(ticketId, "2");
    h.settle();
    h.receive(on(trigger("3"), "x"));
    h.settle();
    expectWorkerDecides(() => h.engine.decide("3", acceptPlain("Y")), ticketId);
    // The worker finds the attached thread is not its ticket's: the message the main Session attached goes back with
    // the later one, and each candidate says why.
    h.engine.markUnrelated(ticketId, "chat:x", "about something else");
    expect(h.thread("chat:x").pending).toEqual(["2", "3"]);
    const handbacks = h.disposition("3").handbacks ?? [];
    expect([handbacks.length, handbacks[0].reason]).toEqual([1, "about something else"]);
    h.pump();
    expect(h.lastIds()).toEqual(["2", "3"]);
  });

  test("keeps a follow up two tickets reached with the one that did not hand it back", () => {
    const h = harness();
    const first = h.accepted();
    h.tick(1);
    h.receive(trigger("2"));
    h.settle();
    h.engine.handback(first, "2", "another change");
    h.pump();
    const second = h.decide(h.lastRequest(), acceptPlain("Y")).ticketId!;
    h.settle();
    h.tick(1);
    h.receive(trigger("3"));
    h.settle();
    expect(h.disposition("3").fanout).toEqual([first, second]);
    expect(h.engine.handback(first, "3", "for the other ticket")).toBe(false);
    expect(h.thread("chat:t1").pending).toEqual([]);
    // The main Session may neither take nor dismiss it while the second ticket's worker decides it.
    expectWorkerDecides(() => h.engine.decide("3", acceptPlain("Y")), second);
    expectWorkerDecides(() => h.engine.decide("3", ignore("chat")), second);
    expect(h.engine.handback(second, "3", "neither ticket")).toBe(true);
    expect(h.thread("chat:t1").pending).toEqual(["3"]);
  });
});

// --- interrupted assignments ---

describe("interrupted assignments", () => {
  test("starts an interrupted assignment again with a note and hands one that waits what waits for it", () => {
    const h = harness();
    const interrupted = h.accepted();
    const first = h.ticket(interrupted).assignments[0];
    const waiting = h.acceptedOn("2", "t2");
    h.report(waiting, "waiting", "done for now");
    h.receive(on(trigger("3"), "t2"));
    const starts = h.starts();
    const delivers = h.delivers();
    // The Executor reports each Assignment that was running; a fact about one that no longer runs is dropped.
    for (const id of [interrupted, waiting]) {
      const running = runningAssignment(h.ticket(id))!.id;
      h.engine.assignmentInterrupted(id, running);
    }
    h.engine.assignmentInterrupted(interrupted, first.id);
    const ticket = h.ticket(interrupted);
    expect(ticket.assignments.length).toBe(2);
    expect([ticket.assignments[0].state, ticket.assignments[0].endedReason]).toEqual([
      "ended",
      "hostRestarted",
    ]);
    expect(ticket.assignments[1].state).toBe("pending");
    expect(ticket.inputs.length).toBe(1);
    expect(ticket.inputs[0].kind).toBe("text");
    if (ticket.inputs[0].kind === "text") {
      expect(ticket.inputs[0].text).toContain("The host restarted");
    }
    expect(ticket.undelivered).toEqual([ticket.inputs[0].id]);
    expect(h.starts()).toBe(starts + 1);
    // A worker that waits keeps its Session and gets what waits for it.
    expect(h.ticket(waiting).assignments.length).toBe(1);
    expect(h.delivers()).toBe(delivers + 1);
  });

  test("starts again a worker that reported but then got a persons message", () => {
    const h = harness();
    const other = h.acceptedOn("2", "t2");
    h.report(other, "waiting", "done for now");
    h.tick(1);
    h.receive(by(on(trigger("3"), "t2"), guest()));
    h.settle();
    const running = runningAssignment(h.ticket(other))!;
    expect(running.deliveredAt! > running.report!.at).toBe(true);
    h.engine.assignmentInterrupted(other, running.id);
    expect(h.ticket(other).assignments.map((a) => a.state)).toEqual(["ended", "pending"]);
  });
});

// --- pause ---

describe("pause", () => {
  test("lets no eval expire while paused and moves its deadline on by the pauses length", () => {
    const h = harness();
    h.receive(trigger("1"));
    h.pump();
    h.engine.candidateDelivered(h.request(0).evalId);
    const deadline = parseIso(h.thread("chat:t1").evaluating!.deadline)!;
    h.tick(30);
    h.setPaused(true);
    h.pump();
    // Paused past the deadline, the Eval waits.
    h.tick(300);
    h.pump();
    expect(h.engine.candidate("1")).toBeDefined();
    h.setPaused(false);
    h.pump();
    expect(parseIso(h.thread("chat:t1").evaluating!.deadline)).toBe(deadline + 300_000);
    h.tick(29);
    h.pump();
    expect(h.engine.candidate("1")?.evalId).toBe(h.request(0).evalId);
    // Expired, it queues the Trigger again for a fresh Eval.
    h.tick(1);
    h.pump();
    expect(h.engine.candidate("1")?.evalId).not.toBe(h.request(0).evalId);
    expect(h.decisions("chat:t1")).toEqual([]);
  });

  test("does not start evals while paused", () => {
    const h = harness();
    h.setPaused(true);
    h.receive(trigger("1"));
    h.pump();
    expect(h.requests()).toBe(0);
  });
});

// --- policy change ---

describe("policy change", () => {
  test("tells only the live tickets a change bears on and restarts in flight evals under the new version", () => {
    const h = harness();
    const ticketId = h.accepted();
    const other = h.acceptedOn("3", "t3");
    h.receive(on(trigger("2"), "t2"));
    h.pump();
    const effect: PolicyEffect = {
      rules: [
        { id: "copy", name: "Copy", change: "changed", instruction: "Fix typos only." },
      ],
    };
    h.setVersion("v2");
    h.engine.policyChanged("v1", "v2", new Map([[ticketId, effect]]));
    const told = h.ticket(ticketId).inputs;
    expect(told.length).toBe(1);
    expect(told[0].kind).toBe("policy-changed");
    if (told[0].kind === "policy-changed") {
      expect([told[0].from, told[0].to, told[0].effect]).toEqual(["v1", "v2", effect]);
    }
    expect(h.ticket(other).inputs).toEqual([]);
    const decisions = h.decisions("chat:t2");
    expect(decisions.length).toBe(1);
    expect([decisions[0].kind, decisions[0].reason]).toEqual([
      "unavailable",
      [reasonCode("policyChanged")],
    ]);
    expect(h.thread("chat:t2").pending).toEqual(["2"]);
    h.pump();
    expect([h.lastRequest().policyVersion, h.lastIds()]).toEqual(["v2", ["2"]]);
    expect(h.delivered()).toEqual([[ticketId, told[0].id]]);
  });

  test("tells a worker of each policy change also of one that repeats an earlier transition", () => {
    const h = harness();
    const ticketId = h.accepted();
    const effects = new Map<string, PolicyEffect>([[ticketId, { proactive: false }]]);
    h.engine.policyChanged("v1", "v2", effects);
    h.tick(1);
    h.engine.policyChanged("v2", "v1", effects);
    h.tick(1);
    h.engine.policyChanged("v1", "v2", effects);
    expect(h.ticket(ticketId).inputs.length).toBe(3);
  });
});

// --- worker reports ---

describe("worker reports", () => {
  test("asks keeps replaces and clears the question for a person", () => {
    const h = harness();
    const ticketId = h.accepted();
    const asked = h.engine.report(ticketId, {
      ...report("progress", "need a call"),
      question: { kind: "ask", question: "Which color?" },
      askedBy: "1",
    }).attention!;
    expect([asked.question, asked.triggerId]).toEqual(["Which color?", "1"]);
    expect(h.report(ticketId, "blocked", "still waiting").attention).toEqual(asked);
    expect(h.r.withdrawn).toEqual([]);
    const replaced = h.engine.report(ticketId, {
      ...report("progress", "other question"),
      question: { kind: "ask", question: "Which size?" },
    }).attention!;
    expect([replaced.question, replaced.triggerId]).toEqual(["Which size?", undefined]);
    // The replaced question is withdrawn from the outbox if its message has not gone out yet.
    expect(h.r.withdrawn).toEqual([key(["attention-reply", asked.id])]);
    const cleared = h.engine.report(ticketId, {
      ...report("progress", "answered"),
      question: { kind: "clear" },
    });
    expect(cleared.attention).toBeUndefined();
    expect(h.r.withdrawn).toEqual([
      key(["attention-reply", asked.id]),
      key(["attention-reply", replaced.id]),
    ]);
  });

  test("ends the ticket on a final report", () => {
    const outcome = (state: ReportState) => {
      const h = harness();
      const ticketId = h.accepted();
      h.engine.report(ticketId, {
        ...report("progress", "asking"),
        question: { kind: "ask", question: "Ship it?" },
      });
      return h.report(ticketId, state, "done");
    };
    const dropped = outcome("dropped").ended!;
    expect([dropped.by, dropped.outcome, dropped.reason]).toEqual(["executor", "dropped", undefined]);
    const ready = outcome("ready");
    expect(ready.ended?.outcome).toBe("completed");
    expect(ready.attention).toBeUndefined();
    const failed = outcome("failed");
    expect(failed.ended).toBeUndefined();
    expect(failed.attention?.question).toBe("Ship it?");
  });

  test("refuses a question with a result or an answer and ones that name no persons message of the ticket", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(bot(trigger("2")));
    h.receive(on(trigger("4"), "elsewhere"));
    const refuse = (change: (r: WorkerReport) => void) => {
      const value = report("progress", "x");
      change(value);
      return h.engine.report(ticketId, value);
    };
    expect(
      errorCode(() =>
        refuse((r) => {
          r.state = "ready";
          r.question = { kind: "ask", question: "Q?" };
        }),
      ),
    ).toBe("questionWithResult");
    expect(
      errorCode(() =>
        refuse((r) => {
          r.question = { kind: "ask", question: "Q?" };
          r.answers = "1";
        }),
      ),
    ).toBe("questionWithResult");
    expect(
      errorCode(() =>
        refuse((r) => {
          r.askedBy = "1";
        }),
      ),
    ).toBe("askerWithoutQuestion");
    expect(
      errorCode(() =>
        refuse((r) => {
          r.question = { kind: "ask", question: "Q?" };
          r.askedBy = "2";
        }),
      ),
    ).toBe("notAsker");
    expect(
      errorCode(() =>
        refuse((r) => {
          r.answers = "4";
        }),
      ),
    ).toBe("notAnswerable");
    expect(
      refuse((r) => {
        r.answers = "1";
      }).answers,
    ).toEqual(["1"]);
  });

  test("refuses a report on an ended ticket and records how it ended", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.engine.stopTicket(ticketId, "Human asked to stop");
    expect(errorCode(() => h.engine.report(ticketId, report("progress", "x")))).toBe("ticketEnded");
    const end = h.ticket(ticketId).ended!;
    expect([end.by, end.outcome, end.reason]).toEqual(["human", "stopped", "Human asked to stop"]);
    expect(ticketStage(h.ticket(ticketId))).toEqual({ kind: "ended" });
  });
});

// --- attach ---

describe("attach", () => {
  test("sends the routing note for a message the worker has and ends an eval that holds only that message", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(by(trigger("2"), guest()));
    h.pump();
    expect(h.delivered().map(([, id]) => id)).toEqual([key(["input", ticketId, "trigger", "2"])]);
    // The follow-up reached the ticket without an Eval, and is its worker's to judge; sent to Eval again by a person, it is judged there.
    expect(h.engine.candidate("2")).toBeUndefined();
    expectWorkerDecides(() => h.engine.attach(ticketId, "2"), ticketId);
    expect(h.engine.reevaluate("2")).toBe(true);
    h.pump();
    expect(h.engine.candidate("2")).toBeDefined();
    const attached = h.engine.attach(ticketId, "2", "The guest asks for the same fix");
    h.settle();
    expect(attached.inputs.length).toBe(2);
    expect(attached.inputs[1].kind).toBe("trigger");
    if (attached.inputs[1].kind === "trigger") {
      expect([attached.inputs[1].triggerId, attached.inputs[1].note]).toEqual([
        "2",
        "The guest asks for the same fix",
      ]);
    }
    expect(h.delivered().map(([, id]) => id)).toEqual(attached.inputs.map((i) => i.id));
    expect(h.engine.candidate("2")).toBeUndefined();
    const last = h.decisions("chat:t1").pop()!;
    expect([last.kind, last.reason]).toEqual(["ignore", [reasonWith("routed", "ticket", ticketId)]]);
    // A note for a message that still waits for the worker goes out with it.
    h.receive(by(trigger("5"), guest()));
    h.engine.reevaluate("5");
    const noted = h.engine.attach(ticketId, "5", "Same fix again");
    const lastNoted = noted.inputs[noted.inputs.length - 1];
    expect(lastNoted.kind).toBe("trigger");
    if (lastNoted.kind === "trigger") {
      expect([lastNoted.triggerId, lastNoted.note]).toEqual(["5", "Same fix again"]);
    }
    expect(noted.inputs.filter((i) => ticketInputTriggerId(i) === "5").length).toBe(1);
    h.receive(on(trigger("6"), "elsewhere"));
    expect(errorCode(() => h.engine.attach("missing", "6"))).toBe("unknownTicket");
    expect(errorCode(() => h.engine.attach(ticketId, "missing"))).toBe("unknownTrigger");
  });

  test("ends the batch eval of an attached message and assesses the rest again", () => {
    const h = harness();
    const ticketId = h.accepted();
    const other = h.acceptedOn("5", "t5");
    h.receive(on(trigger("2"), "x"));
    h.receive(on(trigger("3"), "x"));
    h.pump();
    h.engine.attach(ticketId, "3");
    h.pump();
    const decisions = h.decisions("chat:x");
    expect(decisions.length).toBe(1);
    expect([decisions[0].kind, decisions[0].triggerIds]).toEqual(["unavailable", ["2", "3"]]);
    expect(decisions[0].reason).toEqual([
      reasonOf(reasonWith("routed", "ticket", ticketId), "3"),
    ]);
    expect(h.requestIds(h.engine.candidate("2")!)).toEqual(["2"]);
    expect(owners(h, "3")).toEqual([ticketId]);
    expectWorkerDecides(() => h.engine.attach(other, "3"), ticketId);
  });
});

// --- direct decisions ---

describe("direct decisions", () => {
  test("decides an explicit request no eval holds in a direct eval and accepts a trigger once", () => {
    const h = harness();
    h.receive(trigger("1"));
    const decision = h.engine.decide("1", acceptPlain("Fix"));
    expect([decision.kind, decision.triggerIds, decision.strength]).toEqual([
      "accept",
      ["1"],
      "explicit",
    ]);
    const th = h.thread("chat:t1");
    expect(th.pending).toEqual([]);
    expect(th.evaluating).toBeUndefined();
    expect(h.engine.decide("1", acceptPlain("Again"))).toEqual(decision);
    // A guest's follow-up reached that ticket without an Eval: its worker decides it, and only what the worker hands
    // back can become new work, under the gate's authority, inferred.
    h.receive(by(trigger("2"), guest()));
    h.pump();
    const ticketId = decision.ticketId!;
    const withRules = () =>
      createOutcome(
        { kind: "accept", accept: { title: "Fix", scope: "small", rules: ["r1"] } },
        "rule",
      );
    expectWorkerDecides(() => h.engine.decide("2", withRules()), ticketId);
    h.engine.handback(ticketId, "2", "A different fix");
    expect(errorCode(() => h.engine.decide("2", acceptPlain("Fix")))).toBe("notExplicit");
    const inf = h.engine.decide("2", withRules());
    expect([inf.kind, inf.strength]).toEqual(["accept", "inferred"]);
    expect(inf.mandate!.basis.rules).toEqual(["r1"]);
    expect(errorCode(() => h.engine.decide("missing", ignore("x")))).toBe("unknownTrigger");
  });

  test("refuses a direct decision on a trigger the gate does not admit and leaves the queue as it was", () => {
    const h = harness();
    h.receive(by(trigger("1"), guest()));
    const refused = catchUserError(() => h.engine.decide("1", acceptPlain("Fix")));
    expect(refused.code).toBe("notAdmissible");
    expect(refused.values).toEqual({ reason: "not a member" });
    expect(h.thread("chat:t1").pending).toEqual(["1"]);
  });

  test("ends the eval of a replayed trigger that started a ticket and returns that tickets decision", () => {
    const h = harness();
    const ticketId = h.accepted();
    const decision = h.decisions("chat:t1").pop()!;
    h.tick(1);
    expect(h.engine.reevaluate("1")).toBe(true);
    h.pump();
    expect(h.engine.candidate("1")).toBeUndefined();
    const last = h.decisions("chat:t1").pop()!;
    expect([last.kind, last.triggerIds]).toEqual(["ignore", ["1"]]);
    expect(last.reason).toEqual([reasonOf(reasonWith("startedTicket", "ticket", ticketId), "1")]);
    expect(h.engine.decide("1", acceptPlain("Fix"))).toEqual(decision);
    expect(h.repo.tickets().length).toBe(1);
  });

  test("keeps a replayed trigger that started a ticket out of the eval of the triggers queued with it", () => {
    const h = harness();
    h.accepted();
    h.receive(by(trigger("2"), guest()));
    h.engine.reevaluate("2");
    h.engine.reevaluate("1");
    h.pump();
    // The member's replayed request lends the guest's message no authority.
    expect(h.engine.candidate("1")).toBeUndefined();
    const candidate = h.engine.candidate("2")!;
    expect([candidate.strength, h.requestIds(candidate)]).toEqual(["inferred", ["2"]]);
    expect(errorCode(() => h.engine.decide("2", acceptPlain("Other")))).toBe("notExplicit");
    expect(h.repo.tickets().length).toBe(1);
  });

  test("marks the ignore of an inferred candidate that no assessment judged", () => {
    const h = harness();
    h.accepted();
    for (const id of ["2", "3"]) {
      h.receive(by(trigger(id), guest()));
      h.engine.reevaluate(id);
      h.pump();
      const outcome = ignore("chat");
      if (id === "3") {
        outcome.audit = {};
      }
      const decision = h.decide(h.lastRequest(), outcome);
      const codes = decision.reason.map((r) => r.code);
      expect(codes).toEqual(id === "2" ? ["ignoredFromCard", "said"] : ["said"]);
    }
  });

  test("dismisses the problem an unavailable decision shows and only such a decision", () => {
    const h = harness();
    h.receive(trigger("1"));
    h.pump();
    const unavailable = h.decide(
      h.lastRequest(),
      createOutcome({ kind: "unavailable" }, "model down"),
    );
    expect(h.engine.dismiss(unavailable.id).dismissed).toBe(true);
    h.receive(trigger("2"));
    h.pump();
    const ignored = h.decide(h.lastRequest(), ignore("chat"));
    expect(errorCode(() => h.engine.dismiss(ignored.id))).toBe("unknownProblem");
    expect(errorCode(() => h.engine.dismiss("missing"))).toBe("unknownProblem");
  });
});

// --- automatic input ---

describe("automatic input", () => {
  test("holds back automatic input from a worker that reported blocked until a persons message arrives", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(bot(trigger("2")));
    h.report(ticketId, "blocked", "needs a decision");
    // Both pending and subsequent automated inputs stay on the ticket without waking the worker.
    h.receive(bot(trigger("3")));
    h.settle();
    const ticket = h.ticket(ticketId);
    expect(ticket.undelivered).toEqual([]);
    expect(ticket.inputs.map(ticketInputTriggerId)).toEqual(["2", "3"]);
    expect(h.delivered()).toEqual([]);
    h.tick(1);
    h.receive(by(trigger("4"), guest()));
    h.receive(bot(trigger("5")));
    h.settle();
    expect(h.delivered().map(([, id]) => id)).toEqual([
      key(["input", ticketId, "trigger", "4"]),
      key(["input", ticketId, "trigger", "5"]),
    ]);
  });

  test("stops waiting for a person on a persons message a later report or a retry", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.report(ticketId, "blocked", "needs a decision");
    expect(waitsForPerson(h.ticket(ticketId))).toBe(true);
    expect(ticketStage(h.ticket(ticketId))).toEqual({ kind: "person", action: "blocked" });
    // The worker has the person's reply, so the stale blocked report no longer holds the ticket.
    h.tick(1);
    h.receive(by(trigger("2"), guest()));
    h.settle();
    expect(waitsForPerson(h.ticket(ticketId))).toBe(false);
    expect(ticketStage(h.ticket(ticketId))).toEqual({ kind: "working", queued: false });
    h.tick(1);
    h.report(ticketId, "failed", "broke");
    expect(waitsForPerson(h.ticket(ticketId))).toBe(true);
    expect(ticketStage(h.ticket(ticketId))).toEqual({ kind: "person", action: "failed" });
    h.tick(1);
    h.report(ticketId, "progress", "found a way");
    expect(waitsForPerson(h.ticket(ticketId))).toBe(false);
    h.tick(1);
    h.report(ticketId, "blocked", "needs access");
    h.engine.retryTicket(ticketId);
    expect(waitsForPerson(h.ticket(ticketId))).toBe(false);
    expect(ticketStage(h.ticket(ticketId))).toEqual({ kind: "working", queued: true });
  });

  test("launches a failed launch again for a persons message but not for a policy change", () => {
    const h = harness();
    h.receive(trigger("1"));
    h.pump();
    const ticketId = h.decide(h.lastRequest(), acceptPlain("Fix")).ticketId!;
    h.report(ticketId, "failed", "The prepare command failed");
    const starts = h.starts();
    h.setVersion("v2");
    h.engine.policyChanged("v1", "v2", new Map([[ticketId, {}]]));
    expect(h.starts()).toBe(starts);
    h.tick(1);
    h.receive(by(trigger("2"), guest()));
    expect(h.starts()).toBe(starts + 1);
  });
});

// --- replies ---

describe("replies", () => {
  test("acknowledges a persons message that reached an open ticket once and refuses others", () => {
    const h = harness();
    const ticketId = h.accepted();
    // The acknowledgement of the accept stays; a later request for one reuses it.
    expect(h.engine.reply(ack(ticketId, "1", "On it"))).toEqual({
      id: key(["ack", "1"]),
      status: "pending",
      reused: true,
    });
    expect(h.outbox().map((m) => m.text)).toEqual(["ok"]);
    h.receive(by(trigger("2"), guest()));
    expect(h.engine.reply(ack(ticketId, "2", "Looking"))).toEqual({
      id: key(["ack", "2"]),
      status: "pending",
      reused: false,
    });
    h.receive(bot(trigger("3")));
    expect(errorCode(() => h.engine.reply(ack(ticketId, "3", "x")))).toBe("ackNotPerson");
    h.receive(on(trigger("6"), "elsewhere"));
    expect(errorCode(() => h.engine.reply(ack(ticketId, "6", "x")))).toBe("notReached");
    h.engine.stopTicket(ticketId);
    expect(errorCode(() => h.engine.reply(ack(ticketId, "2", "x")))).toBe("ackEnded");
  });

  test("lets a worker acknowledge or ask no one on a thread it follows only for context", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.engine.followForContext(ticketId, thread("issue"));
    h.receive(on(trigger("2"), "issue"));
    expect(errorCode(() => h.engine.reply(ack(ticketId, "2", "On it")))).toBe("notReached");
    expect(
      errorCode(() =>
        h.engine.report(ticketId, {
          ...report("progress", "asking"),
          question: { kind: "ask", question: "Q?" },
          askedBy: "2",
        }),
      ),
    ).toBe("notAsker");
  });

  test("sends an answer only after the worker reported it a result only when ready and attention only for its question", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(by(trigger("2"), guest()));
    expect(errorCode(() => h.engine.reply(answer("2", "Yes")))).toBe("noAnswer");
    h.engine.report(ticketId, { ...report("progress", "Yes"), answers: "2" });
    const sent = h.engine.reply(answer("2", "Yes"));
    expect([sent.status, sent.reused]).toEqual(["pending", false]);
    const last = h.outbox().pop()!;
    expect([last.channel, last.text, last.kind]).toEqual([channel("2"), "Yes", "reply"]);
    expect(h.ticket(ticketId).answers ?? []).toEqual([]);
    // The same answer again reuses the queued message.
    expect(h.engine.reply(answer("2", "Yes")).reused).toBe(true);
    expect(errorCode(() => h.engine.reply(result(ticketId, "Done")))).toBe("notReady");
    h.engine.report(ticketId, {
      ...report("progress", "asking"),
      question: { kind: "ask", question: "Which color?" },
      askedBy: "2",
    });
    expect(errorCode(() => h.engine.reply(attention(ticketId, "Which size?", "x")))).toBe(
      "notAttention",
    );
    // Without an open question there is nothing to ask, whether or not a question is named.
    const quiet = h.acceptedOn("9", "t9");
    expect(
      errorCode(() => h.engine.reply(attention(quiet, undefined, "Anything to send."))),
    ).toBe("notAttention");
    expect(errorCode(() => h.engine.reply(attention(quiet, "", "Anything to send.")))).toBe(
      "notAttention",
    );
    const open = h.ticket(ticketId).attention!;
    expect(h.engine.reply(attention(ticketId, "Which color?", "Which color?")).id).toBe(
      key(["attention-reply", open.id]),
    );
    // A question goes where the message that raised it was written.
    expect(h.outbox().pop()!.channel).toEqual(channel("2"));
    h.report(ticketId, "ready", "Done");
    expect(h.engine.reply(result(ticketId, "Done")).status).toBe("pending");
    expect(h.outbox().pop()!.channel).toEqual(channel("1"));
    expect(h.engine.reply(result(ticketId, "Done")).reused).toBe(true);
    // The same result in other words is refused: the person has it.
    expect(
      errorCode(() => h.engine.reply(result(ticketId, "It is done, in other words."))),
    ).toBe("resultSent");
    expect(
      h
        .outbox()
        .filter((message) => message.kind === "reply" && message.channel.address.message === "1")
        .length,
    ).toBe(1);

    // Delivering a ready result also clears any pending answers carried on that ready report.
    const ticket2 = h.acceptedOn("19", "t19");
    h.receive(on(by(trigger("20"), guest()), "t19"));
    h.engine.report(ticket2, { ...report("ready", "All finished."), answers: "20" });
    expect(h.ticket(ticket2).answers).toEqual(["20"]);
    h.engine.reply(result(ticket2, "All finished."));
    expect(h.ticket(ticket2).answers ?? []).toEqual([]);
  });

  test("answers a human trigger after its tickets worker handed it back", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(by(trigger("2"), guest()));
    expect(errorCode(() => h.engine.reply(answer("2", "成都现在 16℃。")))).toBe("noAnswer");
    h.engine.handback(ticketId, "2", "Weather is outside this ticket");
    const sent = h.engine.reply(answer("2", "成都现在 16℃。"));
    expect([sent.status, sent.reused]).toEqual(["pending", false]);
    const last = h.outbox().pop()!;
    expect([last.channel, last.text, last.ticketId]).toEqual([
      channel("2"),
      "成都现在 16℃。",
      undefined,
    ]);
    expect(errorCode(() => h.engine.reply(answer("missing", "x")))).toBe("unknownTrigger");
  });

  test("clears pending answers attention delivery and undelivered when human stops a ticket", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(on(by(trigger("2"), guest()), "t1"));
    h.settle();
    h.engine.report(ticketId, { ...report("progress", "Answering soon."), answers: "2" });
    h.tick(1);
    h.engine.report(ticketId, {
      ...report("progress", "Need input."),
      question: { kind: "ask", question: "Confirm?" },
      askedBy: "2",
    });
    h.receive(on(by(trigger("3"), guest()), "t1"));
    const runningId = runningAssignment(h.ticket(ticketId))!.id;
    h.engine.deliveryFailed(ticketId, runningId, "transient error");
    expect((h.ticket(ticketId).answers ?? []).length).toBeGreaterThan(0);
    expect(h.ticket(ticketId).attention).toBeDefined();
    expect(h.ticket(ticketId).delivery).toBeDefined();
    expect(h.ticket(ticketId).undelivered.length).toBeGreaterThan(0);

    const stopped = h.engine.stopTicket(ticketId, "Stopped by user");
    const end = stopped.ended!;
    expect([end.by, end.outcome]).toEqual(["human", "stopped"]);
    expect(stopped.answers ?? []).toEqual([]);
    expect(stopped.attention).toBeUndefined();
    expect(stopped.delivery).toBeUndefined();
    expect(stopped.undelivered).toEqual([]);
    expect(stopped.assignments.every((a) => a.state === "ended")).toBe(true);
  });
});
