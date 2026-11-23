/**
 * Unit tests for time, ids, reasons, errors, model, memory AND engine integration tests:
 * intake, evals, fan-out, resume and stop, follow-ups, hand-backs and context threads.
 */

import { describe, expect, test } from "bun:test";
import {
  MemoryRepositories,
  UserError,
  fill,
  formatIso,
  isReadWaiting,
  isoTime,
  key,
  mandateBasisVia,
  parseIso,
  reasonCode,
  reasonOf,
  reasonText,
  reasonWith,
  said,
  shift,
  ticketInputTriggerId,
  waitsForPerson,
  type MandateBasis,
  type PolicyChangedTicketInput,
  type ReplyRequest,
  type TicketInput,
  type TriggerTicketInput,
} from "../../src/core/index.ts";
import {
  Harness,
  acceptOutcome,
  acceptPlain,
  bot,
  by,
  catchUserError,
  channel,
  errorCode,
  explicit,
  guest,
  harness,
  harnessWith,
  ignore,
  inferred,
  member,
  meta,
  on,
  report,
  stop,
  thread,
  trigger,
  type Gate,
} from "./common.ts";

// --- Unit tests from src/*.rs ---

describe("time", () => {
  test("formats and parses round trip", () => {
    expect(formatIso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(formatIso(1_794_664_026_268)).toBe("2026-11-14T13:47:06.268Z");
    expect(parseIso("2026-11-14T13:47:06.268Z")).toBe(1_794_664_026_268);
    const leap = parseIso("2024-02-29T00:00:00Z");
    expect(leap !== undefined ? formatIso(leap) : undefined).toBe("2024-02-29T00:00:00.000Z");
  });

  test("normalizes offsets and whole seconds", () => {
    expect(isoTime("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(isoTime("2026-01-02T03:04:05+08:00")).toBe("2026-01-01T19:04:05.000Z");
    expect(isoTime("2026-01-02T03:04:05.5-0130")).toBe("2026-01-02T04:34:05.500Z");
    expect(isoTime("not a time")).toBe("not a time");
    expect(shift("2026-01-02T03:04:05.000Z", 1500)).toBe("2026-01-02T03:04:06.500Z");
  });
});

describe("ids", () => {
  test("is stable and separates parts", () => {
    expect(key(["a", "b"])).toBe(key(["a", "b"]));
    expect(key(["a", "b"])).not.toBe(key(["ab"]));
    expect(key(["trigger", "chat", "m1"]).length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(key(["a"]))).toBe(true);
    // Cross-check exact SHA-256 of JSON array `["a","b"]`
    const expected = new Bun.CryptoHasher("sha256").update('["a","b"]').digest("hex").slice(0, 32);
    expect(key(["a", "b"])).toBe(expected);
  });
});

describe("reasons", () => {
  test("formats known and literal codes", () => {
    expect(reasonText([said("because")])).toBe("because");
    expect(
      reasonText([reasonOf(reasonWith("routed", "ticket", "t1"), "g1"), reasonCode("no_mention")]),
    ).toBe("g1: Routed to ticket t1; no_mention");
    expect(fill("keep {missing} and {x}", { x: "1" })).toBe("keep {missing} and 1");
  });
});

describe("errors", () => {
  test("fills templates and marks missing", () => {
    const error = UserError.with("evalFinished", { eval: "e1" });
    expect(error.message.startsWith("Eval e1 has finished")).toBe(true);
    expect(error.missing).toBe(false);
    expect(UserError.create("unknownTicket").missing).toBe(true);
    expect(UserError.invalid("bad input").toString()).toBe("bad input");
  });
});

describe("model wire format", () => {
  test("inputs keep their stored shape", () => {
    const input: TriggerTicketInput = {
      kind: "trigger",
      id: "i1",
      triggerId: "g1",
      at: "2026-01-01T00:00:00.000Z",
      human: true,
    };
    const json = JSON.parse(JSON.stringify(input));
    expect(json).toEqual({
      kind: "trigger",
      id: "i1",
      triggerId: "g1",
      at: "2026-01-01T00:00:00.000Z",
      human: true,
    });
    expect("readAt" in json).toBe(false);
    expect("context" in json).toBe(false);
    expect("note" in json).toBe(false);

    const waiting: TicketInput = JSON.parse(
      '{"kind":"trigger","id":"i1","triggerId":"g1","at":"t","readAt":null}',
    );
    expect(waiting.kind).toBe("trigger");
    if (waiting.kind === "trigger") {
      expect(isReadWaiting(waiting.readAt)).toBe(true);
    }
    expect(JSON.parse(JSON.stringify(waiting)).readAt).toBeNull();

    const changed: PolicyChangedTicketInput = {
      kind: "policy-changed",
      id: "p",
      from: "a",
      to: "b",
      at: "t",
      effect: {},
    };
    expect(JSON.parse(JSON.stringify(changed)).kind).toBe("policy-changed");
  });

  test("basis flattens its admission path", () => {
    const basis: MandateBasis = mandateBasisVia(
      { via: "addressed", addressed: "direct" },
      { sender: "web:local" },
    );
    const json = JSON.parse(JSON.stringify(basis));
    expect(json).toEqual({ sender: "web:local", via: "addressed", addressed: "direct" });

    const cell: MandateBasis = mandateBasisVia({
      via: "admission",
      cell: "listedUnaddressed",
      observation: { mode: "auto" },
    });
    expect(JSON.parse(JSON.stringify(cell))).toEqual({
      via: "admission",
      cell: "listedUnaddressed",
      observation: { mode: "auto" },
    });
  });

  test("memory repositories supports nested transaction rollback and copy isolation", () => {
    const repo = new MemoryRepositories();
    repo.saveTrigger(trigger("1"));
    const fetched = repo.trigger("1")!;
    fetched.text = "mutated";
    expect(repo.trigger("1")!.text).toBe("message 1");

    repo.begin();
    repo.saveTrigger(trigger("2"));
    repo.begin();
    repo.saveTrigger({ ...trigger("1"), text: "inner" });
    repo.saveTrigger(trigger("3"));
    repo.commit();
    expect(repo.trigger("1")!.text).toBe("inner");
    expect(repo.trigger("3")).toBeDefined();
    repo.rollback();
    expect(repo.trigger("1")!.text).toBe("message 1");
    expect(repo.trigger("2")).toBeUndefined();
    expect(repo.trigger("3")).toBeUndefined();
  });
});

// --- Engine integration tests (from tests/engine.rs) ---

describe("intake", () => {
  test("stores a trigger once and records source filtering", () => {
    const h = harness();
    expect(h.receive(trigger("1"))).toBe("stored");
    expect(h.receive(trigger("1"))).toBe("duplicate");
    expect(h.receive(meta(trigger("2"), "blocked"))).toBe("filtered");
    expect(h.disposition("2").filtered).toEqual(reasonCode("chat not allowed"));
    expect(h.thread("chat:t1").pending).toEqual(["1"]);
    expect(h.repo.trigger("1")!.at).toBe("2026-09-23T00:00:01.000Z");
  });

  test("records correlation for a trigger on several threads and evaluates only on the primary one", () => {
    const h = harness();
    const both = { ...trigger("1"), threads: [thread("a"), thread("b")] };
    h.receive(both);
    expect([h.thread("chat:a").pending, h.thread("chat:a").correlated]).toEqual([["1"], ["chat:b"]]);
    expect([h.thread("chat:b").pending, h.thread("chat:b").correlated]).toEqual([[], ["chat:a"]]);
  });

  test("refuses a trigger without a thread", () => {
    const h = harness();
    const orphan = { ...trigger("1"), threads: [] };
    expect(errorCode(() => h.engine.receive(orphan))).toBe("invalid");
  });
});

describe("eval", () => {
  test("ignores at the gate without an assessor when nothing is admissible", () => {
    const h = harness();
    h.receive(bot(trigger("1")));
    h.pump();
    expect(h.requests()).toBe(0);
    const decisions = h.decisions("chat:t1");
    expect(decisions.length).toBe(1);
    expect([decisions[0].kind, decisions[0].triggerIds]).toEqual(["ignore", ["1"]]);
    expect(decisions[0].reason).toEqual([reasonOf(reasonCode("not human"), "1")]);
    expect(h.disposition("1").decisionId).toBeDefined();
  });

  test("releases the assessors state for every eval that ends", () => {
    const h = harness();
    h.receive(trigger("1"));
    h.pump();
    h.decide(h.request(0), ignore("chatter"));
    expect(h.r.released).toEqual([h.request(0).evalId]);
  });

  test("serializes evals per thread and debounces triggers that arrive meanwhile", () => {
    const h = harness();
    h.receive(trigger("1"));
    h.pump();
    h.receive(trigger("2"));
    h.receive(trigger("3"));
    h.pump();
    expect(h.requests()).toBe(1);
    expect(h.thread("chat:t1").pending).toEqual(["2", "3"]);
    h.decide(h.request(0), ignore("chatter"));
    h.pump();
    expect(h.requestIds(h.request(1))).toEqual(["2", "3"]);
    expect(h.request(1).strength).toBe("explicit");
  });

  test("accept creates a ticket with a mandate subscription acknowledgement and assignment", () => {
    const h = harness();
    const ticket = h.ticket(h.accepted());
    expect(ticket.title).toBe("Fix");
    expect([ticket.mandate.strength, ticket.mandate.policyVersion, ticket.mandate.scope]).toEqual([
      "explicit",
      "v1",
      "small",
    ]);
    expect(ticket.mandate.actor).toEqual(member());
    expect(ticket.channels).toEqual([channel("1")]);
    expect([ticket.origin.triggerId, ticket.origin.triggerIds]).toEqual(["1", ["1"]]);
    expect(ticket.ended).toBeUndefined();
    expect(ticket.assignments.length).toBe(1);
    expect(ticket.assignments[0].state).toBe("running");
    expect(ticket.assignments[0].startedAt).toBeDefined();
    expect(h.thread("chat:t1").subscriptions).toEqual([ticket.id]);
    expect(h.outbox()).toEqual([
      {
        id: key(["ack", "1"]),
        channel: channel("1"),
        text: "ok",
        kind: "acknowledgement",
        ticketId: ticket.id,
      },
    ]);
    expect(h.starts()).toBe(1);
  });

  test("refuses to decide an eval that a later eval replaced and decides the later one", () => {
    const h = harness();
    h.receive(trigger("1"));
    h.pump();
    const first = h.request(0);
    h.setVersion("v2");
    h.engine.policyChanged("v1", "v2", {});
    h.pump();
    const second = h.request(1);
    const refused = catchUserError(() => h.decide(first, ignore("chatter")));
    expect(refused.message).toContain("has finished or a later eval replaced it");
    const decision = h.decide(second, ignore("chatter"));
    expect([decision.kind, decision.evalId]).toEqual(["ignore", second.evalId]);
  });

  test("records an accept with its ticket subscriptions and acknowledgement together or none of them", () => {
    const h = harnessWith({
      prepare: () => {
        throw UserError.invalid("No directory for the ticket");
      },
    });
    h.receive(trigger("1"));
    h.pump();
    const evalId = h.request(0).evalId;
    const err = catchUserError(() => h.decide(h.request(0), acceptOutcome()));
    expect(err.message).toContain("No directory");
    expect(h.decisions("chat:t1")).toEqual([]);
    expect(h.repo.tickets()).toEqual([]);
    const th = h.thread("chat:t1");
    expect(th.evaluating?.id).toBe(evalId);
    expect(th.subscriptions).toEqual([]);
    expect(h.outbox()).toEqual([]);
  });

  test("records unavailable when the policy version changed during assessment", () => {
    const h = harness();
    h.receive(trigger("1"));
    h.pump();
    h.setVersion("v2");
    const decision = h.decide(h.request(0), acceptPlain("x"));
    expect(decision.kind).toBe("unavailable");
    expect(h.repo.tickets()).toEqual([]);
    // Its batch waits for a fresh Eval under the new version.
    h.pump();
    expect(h.lastIds()).toEqual(["1"]);
    expect(h.lastRequest().policyVersion).toBe("v2");
  });

  test("starts every pending eval in one step so a second pump starts none again", () => {
    const h = harness();
    h.receive(on(trigger("1"), "A"));
    h.receive(on(trigger("2"), "B"));
    h.engine.evaluateDue();
    h.engine.evaluateDue();
    const keys = h.r.requests.map((c) => c.thread.key);
    expect(keys).toEqual(["chat:A", "chat:B"]);
  });

  test("counts a deadline from delivery requeues twice on expiry then records unavailable", () => {
    const h = harness();
    h.receive(trigger("1"));
    h.pump();
    // A candidate the assessor's Session has not taken does not expire.
    h.tick(600);
    h.pump();
    expect(h.engine.candidate("1")?.evalId).toBe(h.request(0).evalId);
    const deliver = () => h.engine.candidateDelivered(h.lastRequest().evalId);
    deliver();
    h.tick(59);
    h.pump();
    expect(h.requests()).toBe(1);
    // Expired, it records nothing and queues the Trigger for a fresh Eval, twice.
    h.tick(2);
    h.pump();
    expect(h.decisions("chat:t1")).toEqual([]);
    expect(h.r.released).toContain(h.request(0).evalId);
    expect(h.requests()).toBe(2);
    expect(h.lastIds()).toEqual(["1"]);
    deliver();
    h.tick(61);
    h.pump();
    expect(h.requests()).toBe(3);
    // The third expiry is recorded unavailable.
    deliver();
    h.tick(61);
    h.pump();
    const decisions = h.decisions("chat:t1");
    expect(decisions.length).toBe(1);
    expect([decisions[0].kind, decisions[0].reason]).toEqual([
      "unavailable",
      [reasonCode("timeout")],
    ]);
    const th = h.thread("chat:t1");
    expect(th.pending).toEqual([]);
    expect(th.evaluating).toBeUndefined();
    expect(th.expired).toBeUndefined();
  });

  test("keeps a deadline on a repeated delivery and refuses to queue a held trigger again", () => {
    const h = harness();
    h.receive(trigger("1"));
    h.pump();
    h.engine.candidateDelivered(h.request(0).evalId);
    const deadline = h.thread("chat:t1").evaluating!.deadline;
    h.tick(10);
    h.engine.candidateDelivered(h.request(0).evalId);
    expect(h.thread("chat:t1").evaluating!.deadline).toBe(deadline);
    expect(h.engine.reevaluate("1")).toBe(false);
    expect(errorCode(() => h.engine.reevaluate("nope"))).toBe("unknownTrigger");
    // Expired Triggers go ahead of what queued meanwhile.
    h.receive(trigger("2"));
    h.tick(61);
    h.pump();
    expect(h.lastIds()).toEqual(["1", "2"]);
  });
});

describe("subscription fan-out", () => {
  test("delivers a persons later message on a subscribed thread to the live ticket and not to eval", () => {
    const h = harness();
    const ticketId = h.accepted();
    const requests = h.requests();
    h.receive(by(trigger("2"), guest()));
    h.pump();
    const ticket = h.ticket(ticketId);
    expect(ticket.inputs.length).toBe(1);
    expect(ticketInputTriggerId(ticket.inputs[0])).toBe("2");
    expect(ticket.undelivered).toEqual([]);
    expect(h.delivered()).toEqual([[ticket.id, ticket.inputs[0].id]]);
    const disposition = h.disposition("2");
    expect(disposition.fanout).toEqual([ticket.id]);
    expect(disposition.evalId).toBeUndefined();
    expect(disposition.context ?? []).toEqual([]);
    // No Eval, so no Decision and no timeout, and the Thread's queue stays free for a new request.
    expect([h.requests(), h.thread("chat:t1").pending.length, h.decisions("chat:t1").length]).toEqual([
      requests,
      0,
      1,
    ]);
    h.tick(600);
    h.engine.evaluateDue();
    expect(h.decisions("chat:t1").length).toBe(1);
    // A bot's message there still goes to Eval, which the gate does not admit.
    h.receive(bot(trigger("3")));
    h.pump();
    const last = h.decisions("chat:t1").pop()!;
    expect([last.kind, last.triggerIds]).toEqual(["ignore", ["3"]]);
  });

  test("keeps a message of a source without fanout from subscribed tickets and delivers it only where attached", () => {
    const h = harness();
    const first = h.accepted();
    const second = h.acceptedOn("2", "t2");
    h.receive(meta(trigger("3"), "routed"));
    h.pump();
    expect(h.disposition("3").fanout).toEqual([]);
    expect(h.ticket(first).inputs).toEqual([]);
    // It went to Eval as a candidate, with the ticket still subscribed to the Thread.
    expect(h.lastIds()).toEqual(["3"]);
    expect(h.thread("chat:t1").subscriptions).toEqual([first]);
    h.engine.attach(second, "3");
    h.settle();
    expect(h.ticket(first).inputs).toEqual([]);
    expect(h.ticket(second).inputs.map(ticketInputTriggerId)).toEqual(["3"]);
    // The worker's topic becomes the ticket's digest for routing.
    h.engine.report(second, { ...report("progress", "Working"), topic: "Backtest check" });
    expect(h.ticket(second).digest).toBe("Backtest check");
    h.report(second, "progress", "Still working");
    expect(h.ticket(second).digest).toBe("Backtest check");
    // A drop only hands a message back, so it cannot change what the ticket is about.
    h.engine.report(second, { ...report("dropped", "Handed back"), topic: "Something else" });
    expect(h.ticket(second).digest).toBe("Backtest check");
  });

  test("lets the main session answer a message that reached no ticket though tickets follow its thread", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(meta(trigger("2"), "routed"));
    h.pump();
    const answer = (triggerId: string, text: string): ReplyRequest => ({
      purpose: "answer",
      triggerId,
      text,
    });
    const reply = h.engine.reply(answer("2", "Hi"));
    expect([reply.status, reply.reused]).toEqual(["pending", false]);
    const sent = h.outbox().pop()!;
    expect([sent.channel, sent.text, sent.kind, sent.ticketId]).toEqual([
      channel("2"),
      "Hi",
      "reply",
      undefined,
    ]);
    // Once attached, the message is the ticket's, and only its worker's answer may be sent.
    h.receive(meta(trigger("3"), "routed"));
    h.pump();
    h.engine.attach(ticketId, "3");
    h.settle();
    expect(errorCode(() => h.engine.reply(answer("3", "Yes")))).toBe("noAnswer");
  });

  test("keeps inputs undelivered until an assignment runs and asks to launch a failed launch again", () => {
    const h = harness();
    h.receive(trigger("1"));
    h.pump();
    const ticketId = h.decide(h.request(0), acceptPlain("Fix")).ticketId!;
    h.settleWith(false);
    h.receive(trigger("2"));
    h.engine.evaluateDue();
    h.settleWith(false);
    const ticket = h.ticket(ticketId);
    expect(ticket.undelivered.length).toBe(1);
    expect([h.delivers(), h.starts()]).toEqual([0, 2]);
    h.engine.assignmentStarted(ticket.id, ticket.assignments[0].id);
    h.settle();
    expect(h.delivered()).toEqual([[ticket.id, ticket.undelivered[0]]]);
  });

  test("does not hand a bots message to an ended ticket", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.report(ticketId, "ready", "done");
    h.receive(bot(trigger("2")));
    h.pump();
    const ticket = h.ticket(ticketId);
    expect(ticket.ended).toBeDefined();
    expect(ticket.undelivered).toEqual([]);
    expect(h.starts()).toBe(1);
  });

  test("resumes once however often it pumps and drops what waited when the mandate no longer holds", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.report(ticketId, "ready", "done");
    h.setVersion("revoked");
    h.receive(by(trigger("2"), guest()));
    h.pump();
    let ticket = h.ticket(ticketId);
    expect(ticket.ended).toBeDefined();
    expect(ticket.undelivered).toEqual([]);
    h.setVersion("v1");
    h.pump();
    expect(h.ticket(ticketId).ended).toBeDefined();
    h.receive(by(trigger("3"), guest()));
    h.pump();
    h.pump();
    ticket = h.ticket(ticketId);
    expect(ticket.assignments.length).toBe(2);
    expect(ticket.inputs.filter((input) => input.kind === "resumed").length).toBe(1);
  });

  test("takes delivery reports only from the assignment that still runs the open ticket", () => {
    const h = harness();
    const ticketId = h.accepted();
    const assignment = h.ticket(ticketId).assignments[0].id;
    h.receive(trigger("2"));
    const input = key(["input", ticketId, "trigger", "2"]);
    h.engine.deliveryFailed(ticketId, assignment, "Session busy");
    expect(h.ticket(ticketId).delivery?.error).toBe("Session busy");
    h.engine.deliveryFailed(ticketId, "another", "other");
    h.engine.inputsDelivered(ticketId, "another", [input]);
    let ticket = h.ticket(ticketId);
    expect([ticket.undelivered, ticket.delivery?.error]).toEqual([[input], "Session busy"]);
    h.engine.inputsDelivered(ticketId, assignment, [input]);
    ticket = h.ticket(ticketId);
    expect(ticket.undelivered).toEqual([]);
    expect(ticket.delivery).toBeUndefined();
    h.receive(trigger("3"));
    h.engine.stopTicket(ticketId);
    h.engine.deliveryFailed(ticketId, assignment, "late");
    ticket = h.ticket(ticketId);
    expect(ticket.ended).toBeDefined();
    expect(ticket.undelivered).toEqual([]);
    expect(ticket.delivery).toBeUndefined();
  });

  test("unsubscribing a thread stops fanout until a new decision subscribes it", () => {
    const h = harness();
    const ticketId = h.accepted();
    expect(h.engine.unsubscribe("chat:t1")).toBe(true);
    expect(h.engine.unsubscribe("chat:t1")).toBe(false);
    h.receive(trigger("2"));
    h.pump();
    expect(h.ticket(ticketId).inputs).toEqual([]);
  });

  test("lets an executor drop a thread attached to its ticket but not its own thread", () => {
    const h = harness();
    const first = h.accepted();
    const second = h.acceptedOn("2", "t2");
    h.receive(on(trigger("3"), "t2"));
    // A follow-up of the second ticket goes to the first only once the second's worker hands it back.
    h.engine.handback(second, "3", "It is about the first fix");
    h.engine.attach(first, "3");
    expect(h.thread("chat:t2").subscriptions).toEqual([second, first]);
    h.engine.markUnrelated(first, "chat:t2", "about another fix");
    expect(h.thread("chat:t2").subscriptions).toEqual([second]);
    const dropped = h.r.events.filter((e) => e.type === "threadUnsubscribed");
    expect(dropped).toEqual([
      {
        type: "threadUnsubscribed",
        threadKey: "chat:t2",
        ticketId: first,
        byPerson: false,
        reason: "about another fix",
      },
    ]);
    expect(errorCode(() => h.engine.markUnrelated(first, "chat:t2", "again"))).toBe("notFollowing");
    expect(errorCode(() => h.engine.markUnrelated(first, "chat:t1", "its own"))).toBe(
      "sourceThread",
    );
  });
});

// --- resume and stop ---

function ended(h: Harness, byPerson: boolean): string {
  const ticketId = h.accepted();
  if (byPerson) {
    h.engine.stopTicket(ticketId);
  } else {
    h.report(ticketId, "ready", "done");
  }
  return ticketId;
}

describe("resume and stop", () => {
  test("resumes an ended ticket on any persons message under the same mandate without a decision", () => {
    const h = harness();
    const ticketId = ended(h, false);
    expect([h.ticket(ticketId).ended?.by, h.ticket(ticketId).ended?.outcome]).toEqual([
      "executor",
      "completed",
    ]);
    const decisions = h.decisions("chat:t1").length;
    // It resumes as the message arrives, before any Eval of it.
    h.receive(by(trigger("2"), guest()));
    expect(h.ticket(ticketId).ended).toBeUndefined();
    h.pump();
    const ticket = h.ticket(ticketId);
    expect(ticket.assignments.length).toBe(2);
    expect(ticket.mandate.policyVersion).toBe("v1");
    expect(ticket.inputs.map((i) => i.kind)).toEqual(["trigger", "resumed"]);
    // The resumed marker reached the worker ahead of the message.
    const order = h.delivered().map(([, id]) => id);
    expect(order).toEqual([ticket.inputs[1].id, ticket.inputs[0].id]);
    expect(h.starts()).toBe(2);
    expect(h.decisions("chat:t1").filter((d) => d.kind !== "ignore").length).toBe(decisions);
  });

  test("resumes an ended ticket at once when a message is attached to it", () => {
    const h = harness();
    const ticketId = ended(h, false);
    h.receive(by(on(trigger("2"), "elsewhere"), guest()));
    const subject = h.engine.attach(ticketId, "2");
    expect(subject.ended).toBeUndefined();
    expect(subject.assignments.map((a) => a.state)).toEqual(["ended", "pending"]);
  });

  test("keeps a ticket a person stopped ended", () => {
    const h = harness();
    const ticketId = ended(h, true);
    expect(h.stops()).toBe(1);
    h.receive(trigger("2"));
    h.pump();
    expect([h.ticket(ticketId).ended?.by, h.ticket(ticketId).ended?.outcome]).toEqual([
      "human",
      "stopped",
    ]);
    expect(h.starts()).toBe(1);
    expect(errorCode(() => h.engine.attach(ticketId, "2"))).toBe("ticketStopped");
  });

  test("keeps a ticket ended when its mandate no longer passes the current policy", () => {
    const h = harness();
    const ticketId = ended(h, false);
    h.setVersion("revoked");
    h.receive(trigger("2"));
    h.pump();
    expect(h.ticket(ticketId).ended).toBeDefined();
    // The message reached no ticket after all, so it is assessed.
    expect(h.disposition("2").fanout).toEqual([]);
    expect(h.lastIds()).toEqual(["2"]);
    h.receive(on(trigger("3"), "x"));
    expect(errorCode(() => h.engine.attach(ticketId, "3"))).toBe("mandateRevoked");
  });

  test("waits out a pause before resuming an ended ticket", () => {
    const h = harness();
    const ticketId = ended(h, false);
    h.setPaused(true);
    h.receive(by(trigger("2"), guest()));
    h.pump();
    expect(h.ticket(ticketId).ended).toBeDefined();
    expect(h.ticket(ticketId).undelivered.length).toBe(1);
    h.setPaused(false);
    h.pump();
    expect(h.ticket(ticketId).ended).toBeUndefined();
  });

  test("stops a live ticket only on an explicit instruction and ends it by the human", () => {
    const h = harness();
    const ticketId = h.accepted();
    // Follow-ups that reached the ticket: the gate judges them when the main Session acts on one, a guest's as inferred.
    h.receive(by(trigger("2"), guest()));
    h.pump();
    const refused = h.engine.decide("2", stop(ticketId, "x"));
    expect([refused.kind, refused.strength, refused.reason]).toEqual([
      "ignore",
      "inferred",
      [reasonCode("stopNotExplicit")],
    ]);
    h.receive(trigger("3"));
    h.pump();
    expect(h.engine.decide("3", stop(ticketId, "human said stop")).kind).toBe("stop");
    const end = h.ticket(ticketId).ended!;
    expect([end.by, end.reason]).toEqual(["human", "human said stop"]);
    expect(h.stops()).toBe(1);
  });

  test("records a stop that names an unknown or ended ticket as ignored", () => {
    const h = harness();
    const ticketId = ended(h, false);
    h.receive(on(trigger("2"), "x"));
    for (const target of ["missing", ticketId]) {
      h.receive(on(trigger(target === "missing" ? "3" : "4"), "x"));
    }
    const unknown = h.engine.decide("3", stop("missing", "stop"));
    const over = h.engine.decide("4", stop(ticketId, "stop"));
    for (const decision of [unknown, over]) {
      expect([decision.kind, decision.reason]).toEqual(["ignore", [reasonCode("stopUnknown")]]);
    }
  });
});

// --- follow-ups ---

describe("follow-ups", () => {
  test("keeps a follow up a person sent to eval again in the queue", () => {
    const h = harness();
    h.accepted();
    h.receive(by(trigger("2"), guest()));
    h.receive(by(trigger("3"), guest()));
    expect(h.thread("chat:t1").pending).toEqual([]);
    expect(h.engine.reevaluate("3")).toBe(true);
    h.pump();
    expect(h.lastIds()).toEqual(["3"]);
    expect(h.thread("chat:t1").pending).toEqual([]);
    expect(h.decisions("chat:t1").flatMap((d) => d.triggerIds)).toEqual(["1"]);
  });

  test("decides a follow up in a gate only eval beside the eval its thread has in progress", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(by(trigger("2"), guest()));
    h.engine.reevaluate("2");
    h.pump();
    const evaluating = h.thread("chat:t1").evaluating!;
    h.receive(trigger("3"));
    const decision = h.engine.decide("3", stop(ticketId, "stop it"));
    expect([decision.kind, decision.triggerIds]).toEqual(["stop", ["3"]]);
    expect(h.thread("chat:t1").evaluating).toEqual(evaluating);
    const other = h.decide(h.lastRequest(), ignore("chat"));
    expect([other.kind, other.triggerIds]).toEqual(["ignore", ["2"]]);
  });

  test("leaves the thread free for a later request that reaches no ticket", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(by(trigger("2"), guest()));
    h.pump();
    h.engine.stopTicket(ticketId, "not needed");
    // The follow-up held no Eval while the ticket decided it, so the next request is assessed at once, together with
    // the follow-up, which the stop let go of before its worker took it up.
    h.receive(trigger("3"));
    h.pump();
    expect(h.lastIds()).toEqual(["2", "3"]);
  });
});

// --- hand-back ---

describe("hand-back", () => {
  test("queues a handed back message for a fresh eval once per ticket and keeps the subscription", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(trigger("2"));
    h.receive(by(trigger("3"), guest()));
    h.pump();
    expect(h.engine.handback(ticketId, "2", "A new request")).toBe(true);
    h.pump();
    expect([h.lastRequest().strength, h.lastIds()]).toEqual(["explicit", ["2"]]);
    const handbacks = h.disposition("2").handbacks ?? [];
    expect(handbacks.map((b) => [b.ticketId, b.reason])).toEqual([[ticketId, "A new request"]]);
    h.decide(h.lastRequest(), ignore("chat"));
    expect(errorCode(() => h.engine.handback(ticketId, "2", "Again"))).toBe("handedBack");
    expect(h.engine.handback(ticketId, "3", "A guest asks for more")).toBe(true);
    h.pump();
    expect([h.lastRequest().strength, h.lastIds()]).toEqual(["inferred", ["3"]]);
    expect(h.thread("chat:t1").subscriptions).toContain(ticketId);
    // Only a message that reached the ticket can go back.
    h.receive(on(trigger("4"), "elsewhere"));
    expect(errorCode(() => h.engine.handback(ticketId, "4", "Not mine"))).toBe("notReached");
  });

  test("queues again no message the ticket did not decide", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.engine.followForContext(ticketId, thread("issue"));
    h.receive(trigger("2"));
    h.engine.reevaluate("2");
    h.receive(bot(trigger("3")));
    h.receive(on(trigger("4"), "issue"));
    h.pump();
    const count = h.requests();
    for (const index of [count - 2, count - 1]) {
      h.decide(h.request(index), ignore("chat"));
    }
    // Each went to Eval without the ticket, and its Decision stands.
    for (const id of ["2", "3", "4"]) {
      expect(h.engine.handback(ticketId, id, "Not this ticket")).toBe(false);
    }
    expect(h.thread("chat:t1").pending).toEqual([]);
    expect(h.thread("chat:issue").pending).toEqual([]);
    // The hand-back is recorded all the same, so the main Session does not attach the message back.
    expect((h.disposition("4").handbacks ?? []).length).toBe(1);
    expect(errorCode(() => h.engine.attach(ticketId, "4"))).toBe("handedBackHere");
  });

  test("leaves an attached message to the tickets worker whose hand back sends it to eval", () => {
    const h = harness();
    const ticketId = h.accepted();
    h.receive(on(trigger("2"), "x"));
    h.pump();
    h.engine.attach(ticketId, "2");
    h.settle();
    // Routed to the ticket, it is not new work as well.
    const refused = catchUserError(() => h.engine.decide("2", acceptPlain("Y")));
    expect(refused.code).toBe("workerDecides");
    expect(refused.values).toEqual({ tickets: ticketId });
    expect(h.engine.handback(ticketId, "2", "Asks for another change")).toBe(true);
    expect(h.thread("chat:x").pending).toEqual(["2"]);
  });
});

// --- context threads and notes ---

describe("context threads and notes", () => {
  test("fans a thread followed for context out to the live ticket and resumes no ended ticket from it", () => {
    const h = harness();
    const ticketId = h.accepted();
    expect(h.engine.followForContext(ticketId, thread("issue"))).toBe(true);
    expect(h.engine.followForContext(ticketId, thread("issue"))).toBe(false);
    h.receive(on(trigger("2"), "issue"));
    h.settle();
    expect(h.ticket(ticketId).inputs.map(ticketInputTriggerId)).toEqual(["2"]);
    h.report(ticketId, "dropped", "nothing to do");
    h.receive(on(trigger("3"), "issue"));
    expect(h.ticket(ticketId).ended).toBeDefined();
    // Attached by the main Session, the Thread is the ticket's own, and a person's later message there resumes it.
    h.engine.attach(ticketId, "3");
    h.settle();
    expect(h.thread("chat:issue").context ?? []).toEqual([]);
    h.report(ticketId, "dropped", "nothing to do");
    expect(h.ticket(ticketId).ended).toBeDefined();
    h.receive(on(trigger("4"), "issue"));
    expect(h.ticket(ticketId).ended).toBeUndefined();
  });

  test("counts a message on a context thread as none of the tickets follow ups and lifts no block with it", () => {
    const h = harness();
    const owner = h.accepted();
    const follower = h.acceptedOn("2", "other");
    h.engine.followForContext(follower, thread("t1"));
    h.receive(by(trigger("3"), guest()));
    h.pump();
    const disposition = h.disposition("3");
    expect([disposition.fanout, disposition.context ?? []]).toEqual([
      [owner, follower],
      [follower],
    ]);
    const lastInput = h.ticket(follower).inputs[h.ticket(follower).inputs.length - 1];
    expect(lastInput.kind).toBe("trigger");
    if (lastInput.kind === "trigger") {
      expect(lastInput.triggerId).toBe("3");
      expect(lastInput.context).toBe(true);
    }
    // A message reaching only the follower goes to Eval, with the guest's that the stopped owner let go of.
    h.engine.stopTicket(owner, "done");
    h.report(follower, "blocked", "needs a decision");
    h.receive(trigger("4"));
    h.pump();
    expect(h.lastIds()).toEqual(["3", "4"]);
    expect(waitsForPerson(h.ticket(follower))).toBe(true);
  });

  test("sends a message to eval when only a ticket following its thread for context is left", () => {
    const h = harness();
    const owner = h.accepted();
    const follower = h.acceptedOn("2", "other");
    h.engine.followForContext(follower, thread("t1"));
    h.report(owner, "ready", "done");
    h.setVersion("revoked");
    h.receive(trigger("3"));
    h.setVersion("v1");
    h.pump();
    const disposition = h.disposition("3");
    expect([disposition.fanout, disposition.context ?? []]).toEqual([[follower], [follower]]);
    expect(h.lastIds()).toEqual(["3"]);
  });

  test("gives an open tickets worker a note held like automatic input and refuses one for an ended ticket", () => {
    const h = harness();
    const ticketId = h.accepted();
    const noted = h.engine.note(ticketId, "The other ticket renamed the API");
    const last = noted.inputs[noted.inputs.length - 1];
    expect(last.kind).toBe("note");
    if (last.kind === "note") {
      expect(last.text).toBe("The other ticket renamed the API");
    }
    // A worker that reported blocked waits for a person: a note does not wake it.
    h.settle();
    h.report(ticketId, "blocked", "needs a decision");
    const note = h.engine
      .note(ticketId, "Ticket B changed the schema")
      .inputs.slice(-1)[0];
    h.settle();
    expect(h.delivered().some(([, id]) => id === note.id)).toBe(false);
    expect(h.ticket(ticketId).inputs).toContainEqual(note);
    h.engine.stopTicket(ticketId, "done");
    expect(errorCode(() => h.engine.note(ticketId, "Too late"))).toBe("ticketEnded");
  });

  test("takes a mixed batchs strength actor and basis from its strongest admissible trigger", () => {
    const gate: Gate = (t) => {
      if (t.actor.id === "alice") return explicit();
      if (t.actor.id === "guest") return inferred();
      return { kind: "inadmissible", reason: "not a member" };
    };
    const h = harnessWith({ gate });
    h.receive(by(trigger("1"), guest()));
    h.receive(trigger("2"));
    h.receive(trigger("3"));
    h.receive(by(trigger("4"), guest()));
    h.receive(by(trigger("5"), { source: "chat", id: "stranger" }));
    h.pump();
    const evaluation = h.thread("chat:t1").evaluating!;
    // The latest of the explicit ones gives the batch its origin.
    expect([evaluation.strength, evaluation.primary, evaluation.actor.id]).toEqual([
      "explicit",
      "3",
      "alice",
    ]);
    expect(evaluation.triggerIds).toEqual(["1", "2", "3", "4", "5"]);
    const ticketId = h.decide(h.lastRequest(), acceptOutcome()).ticketId!;
    const ticket = h.ticket(ticketId);
    expect(ticket.origin.triggerId).toBe("3");
    expect(h.outbox()[0].id).toBe(key(["ack", "3"]));
    expect(ticket.channels.length).toBe(5);
  });
});
