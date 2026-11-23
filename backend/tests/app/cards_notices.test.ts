import { describe, expect, test } from "bun:test";
import {
  ASSIGNMENT_CHARS,
  RETRIED,
  WORKER_TRIGGER_CHARS,
  assignmentLine,
  batchLine,
  briefCard,
  capped,
  cardState,
  charCount,
  decisionCard,
  decisionDetails,
  inputLine,
  inputMessage,
  inputResource,
  mandateInstructions,
  newestPage,
  preview,
  relatedTickets,
  routingCard,
  textPage,
  ticketCard,
  ticketDetails,
  triggerCard,
  triggerMessage,
  workerTriggerMessage,
} from "../../src/app/cards.ts";
import {
  changedPaths,
  eventNotice,
  followupRelay,
  receiptNotice,
  reportRelay,
  resultRelay,
  settingsNotice,
  stateName,
  threadFollowedNotice,
} from "../../src/app/notices.ts";
import {
  MemoryStore,
  key,
  mandateBasisVia,
  reasonCode,
  reasonOf,
  reasonWith,
  said,
  workerReport,
  type Assignment,
  type Decision,
  type DomainEvent,
  type Ticket,
  type TicketInput,
  type Trigger,
  type TriggerDisposition,
} from "../../src/core/index.ts";

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: "tr1",
    source: "wechat",
    threads: [{ source: "wechat", id: "room-1" }],
    actor: { source: "wechat", id: "alice" },
    human: true,
    at: "2026-03-01T10:20:30.400Z",
    text: "Please check the login bug",
    meta: {},
    ...overrides,
  };
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "tk1",
    title: "Fix login bug",
    decisionId: "dec1",
    mandate: {
      strength: "explicit",
      policyVersion: "pv1",
      basis: mandateBasisVia({ via: "addressed", addressed: "mention" }, { source: "wechat", sender: "alice" }),
      actor: { source: "wechat", id: "alice" },
      scope: "Fix the login error in auth module",
    },
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: "2026-03-01T10:21:00.000Z",
    updatedAt: "2026-03-01T10:22:33.000Z",
    origin: { triggerId: "tr1", triggerIds: ["tr1"] },
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: "a1",
    state: "running",
    createdAt: "2026-03-01T10:21:05.000Z",
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dec1",
    evalId: "ev1",
    threadKey: "wechat:room-1",
    triggerIds: ["tr1", "tr2"],
    policyVersion: "pv1",
    at: "2026-03-01T10:21:00.000Z",
    kind: "accept",
    reason: [said("Explicit bug report")],
    strength: "explicit",
    ticketId: "tk1",
    ...overrides,
  };
}

describe("cards", () => {
  test("preview collapses whitespace and clips to 160 Unicode scalar chars", () => {
    expect(preview("  hello\n\t  world\u00a0\u3000neo  ")).toBe("hello world neo");
    expect(preview("   \n\t  ")).toBe("");

    const longAscii = "a".repeat(200);
    expect(preview(longAscii)).toBe("a".repeat(160));

    // Emoji are 2 UTF-16 code units each, 1 Unicode scalar each.
    const emojis = "😀".repeat(170);
    const out = preview(emojis);
    expect(charCount(out)).toBe(160);
    expect(out).toBe("😀".repeat(160));
  });

  test("cardState maps ended outcomes and every open stage accurately", () => {
    expect(
      cardState(makeTicket({ ended: { at: "t", by: "executor", outcome: "completed" } })),
    ).toBe("completed");
    expect(
      cardState(makeTicket({ ended: { at: "t", by: "executor", outcome: "dropped" } })),
    ).toBe("dropped");
    expect(
      cardState(makeTicket({ ended: { at: "t", by: "human", outcome: "stopped" } })),
    ).toBe("stopped");

    expect(cardState(makeTicket({ delivery: { error: "err", at: "t" } }))).toBe("person/delivery");
    expect(cardState(makeTicket({ attention: { id: "att1", question: "Which env?" } }))).toBe(
      "person/answer",
    );
    expect(
      cardState(
        makeTicket({
          assignments: [makeAssignment({ report: { state: "ready", summary: "Done", at: "t1" } })],
        }),
      ),
    ).toBe("person/review");
    expect(
      cardState(
        makeTicket({
          assignments: [makeAssignment({ report: { state: "blocked", summary: "Need key", at: "t1" } })],
        }),
      ),
    ).toBe("person/blocked");
    expect(
      cardState(
        makeTicket({
          assignments: [makeAssignment({ report: { state: "failed", summary: "Boom", at: "t1" } })],
        }),
      ),
    ).toBe("person/failed");

    // No assignments or pending assignment -> working/queued.
    expect(cardState(makeTicket({ assignments: [] }))).toBe("working/queued");
    expect(cardState(makeTicket({ assignments: [makeAssignment({ state: "pending" })] }))).toBe(
      "working/queued",
    );

    // Waiting report or ended assignment -> idle.
    expect(
      cardState(
        makeTicket({
          assignments: [makeAssignment({ report: { state: "waiting", summary: "Idle", at: "t1" } })],
        }),
      ),
    ).toBe("idle");
    expect(cardState(makeTicket({ assignments: [makeAssignment({ state: "ended" })] }))).toBe(
      "idle",
    );

    // Running assignment without waiting/ready/blocked/failed -> working.
    expect(cardState(makeTicket({ assignments: [makeAssignment({ state: "running" })] }))).toBe(
      "working",
    );
  });

  test("triggerCard formats fields and optional disposition", () => {
    const trigger = makeTrigger({ text: "  hi\n😀 there  " });
    const bare = triggerCard(trigger);
    expect(bare).toEqual({
      trigger_id: "tr1",
      source: "wechat",
      actor: "alice",
      thread: "wechat:room-1",
      human: true,
      at: "2026-03-01T10:20:30.400Z",
      preview: "hi 😀 there",
      chars: 14,
      read: "trigger/tr1",
    });
    expect("disposition" in bare).toBe(false);

    const disposition: TriggerDisposition = {
      fanout: ["tk1", "tk2"],
      filtered: reasonCode("senderNotMember"),
      decisionId: "dec9",
      at: "2026-03-01T10:20:31.000Z",
    };
    const withDisp = triggerCard(trigger, disposition);
    expect(withDisp.disposition).toEqual({
      delivered_to: ["tk1", "tk2"],
      filtered: "The sender is not on the Source's list",
      decision_id: "dec9",
    });
  });

  test("ticketCard and briefCard handle digest fallback, dropped reports, ended, and attention", () => {
    // 1. Title-only fallback when no digest and no non-dropped report.
    const droppedOnly = makeTicket({
      assignments: [
        makeAssignment({ report: { state: "dropped", summary: "Handed back", at: "t1" } }),
      ],
    });
    const card1 = ticketCard(droppedOnly);
    expect(card1).toEqual({
      ticket_id: "tk1",
      title: "Fix login bug",
      digest: "Fix login bug",
      state: "working",
      strength: "explicit",
      preview: "Handed back",
      read: "ticket/tk1",
    });

    // 2. Falls back to latest non-dropped report for digest, while preview still uses latest report.
    const mixedReports = makeTicket({
      assignments: [
        makeAssignment({
          id: "a1",
          state: "ended",
          report: { state: "progress", summary: "Investigating OAuth", at: "t1" },
        }),
        makeAssignment({
          id: "a2",
          state: "running",
          report: { state: "dropped", summary: "Handed back unrelated msg", at: "t2" },
        }),
      ],
    });
    const card2 = ticketCard(mixedReports);
    expect(card2.digest).toBe("Fix login bug: Investigating OAuth");
    expect(card2.preview).toBe("Handed back unrelated msg");

    // 3. Explicit digest is kept verbatim; ended + attention fields formatted accurately.
    const rich = makeTicket({
      digest: "  Exact   topic  ",
      ended: { at: "2026-03-01T11:00:00.000Z", by: "human", outcome: "stopped" },
      attention: { id: "att1", question: "Proceed?", triggerId: "tr5" },
    });
    const card3 = ticketCard(rich);
    expect(card3.digest).toBe("  Exact   topic  ");
    expect(card3.state).toBe("stopped");
    expect(card3.ended).toEqual({
      at: "2026-03-01T11:00:00.000Z",
      by: "human",
      reason: "stopped",
    });
    expect(card3.attention).toEqual({ question: "Proceed?", trigger_id: "tr5" });

    // Custom ended reason overrides outcome string.
    const customEnded = makeTicket({
      ended: { at: "t", by: "human", outcome: "stopped", reason: "Duplicate request" },
      attention: { id: "att2", question: "Which branch?" },
    });
    const card4 = ticketCard(customEnded);
    expect(card4.ended).toEqual({ at: "t", by: "human", reason: "Duplicate request" });
    expect(card4.attention).toEqual({ question: "Which branch?" });

    // briefCard drops preview only.
    const brief = briefCard(rich);
    expect("preview" in brief).toBe(false);
    expect(brief.ticket_id).toBe("tk1");
    expect(brief.read).toBe("ticket/tk1");
  });

  test("routingCard formats compact chat routing fields", () => {
    const t = makeTicket({
      digest: "  OAuth   token   refresh  ",
      updatedAt: "2026-03-01T10:22:33.444Z",
      attention: { id: "att1", question: "Confirm scope?", triggerId: "tr9" },
    });
    const asked = "  " + "x".repeat(120) + "  ";
    expect(routingCard(t, asked)).toEqual({
      ticket_id: "tk1",
      title: "Fix login bug",
      asked: "x".repeat(100),
      digest: "OAuth token refresh",
      state: "person/answer",
      updated: "2026-03-01T10:22",
      attention: { question: "Confirm scope?" },
    });

    // Without asked, without subject/digest, without attention.
    const minimal = makeTicket({ updatedAt: "2026-03-01T10:22:33.444Z" });
    const card = routingCard(minimal);
    expect(card).toEqual({
      ticket_id: "tk1",
      title: "Fix login bug",
      state: "working/queued",
      updated: "2026-03-01T10:22",
    });
    expect("asked" in card).toBe(false);
    expect("digest" in card).toBe(false);
    expect("attention" in card).toBe(false);
  });

  test("relatedTickets orders open first then newest first, caps to limit, and keeps total", () => {
    const t1 = makeTicket({
      id: "ended-new",
      createdAt: "2026-03-04T00:00:00.000Z",
      ended: { at: "2026-03-04T01:00:00.000Z", by: "executor", outcome: "completed" },
    });
    const t2 = makeTicket({ id: "open-old", createdAt: "2026-03-01T00:00:00.000Z" });
    const t3 = makeTicket({ id: "open-new", createdAt: "2026-03-03T00:00:00.000Z" });
    const t4 = makeTicket({
      id: "ended-old",
      createdAt: "2026-03-02T00:00:00.000Z",
      ended: { at: "2026-03-02T01:00:00.000Z", by: "human", outcome: "stopped" },
    });
    const input = [t1, t2, t3, t4];
    const result = relatedTickets(input, 3, (t) => ({ id: t.id }));
    expect(result).toEqual({
      related_tickets: [{ id: "open-new" }, { id: "open-old" }, { id: "ended-new" }],
      tickets_total: 4,
    });
    // Does not mutate caller array.
    expect(input.map((t) => t.id)).toEqual(["ended-new", "open-old", "open-new", "ended-old"]);
  });

  test("decisionCard and decisionDetails format reason, strip policyVersion, and include audit", () => {
    const mandate = makeTicket().mandate;
    const audit = { direction: "clear", matchedRules: ["r1"] };
    const decision = makeDecision({
      reason: [reasonOf(reasonWith("routed", "ticket", "tk1"), "tr1")],
      mandate,
      audit,
    });
    expect(decisionCard(decision)).toEqual({
      decision_id: "dec1",
      kind: "accept",
      reason: "tr1: Routed to ticket tk1",
      strength: "explicit",
      thread: "wechat:room-1",
      trigger_ids: ["tr1", "tr2"],
      at: "2026-03-01T10:21:00.000Z",
      read: "decision/dec1",
      ticket_id: "tk1",
    });

    const details = decisionDetails(decision);
    expect(details.mandate).toEqual({
      strength: "explicit",
      basis: { via: "addressed", addressed: "mention", source: "wechat", sender: "alice" },
      actor: { source: "wechat", id: "alice" },
      scope: "Fix the login error in auth module",
    });
    expect("policyVersion" in (details.mandate as Record<string, unknown>)).toBe(false);
    // Original decision mandate is untouched.
    expect(decision.mandate?.policyVersion).toBe("pv1");
    expect(details.audit).toEqual(audit);

    // Without ticketId / mandate / audit.
    const ignoreDecision = makeDecision({ kind: "ignore", ticketId: undefined });
    const ignoreCard = decisionDetails(ignoreDecision);
    expect("ticket_id" in ignoreCard).toBe(false);
    expect("mandate" in ignoreCard).toBe(false);
    expect("audit" in ignoreCard).toBe(false);
  });

  test("textPage paginates by Unicode scalar characters and round-trips completely", () => {
    const text = "Hello😀世界🚀!";
    const chunks: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = textPage("trigger/tr1", text, offset, 3);
      expect(page.resource).toBe("trigger/tr1");
      expect(page.offset).toBe(offset);
      expect(page.total_chars).toBe(10);
      chunks.push(page.text);
      offset = page.next_offset;
    }
    expect(chunks).toEqual(["Hel", "lo😀", "世界🚀", "!"]);
    expect(chunks.join("")).toBe(text);

    // Offset past end and empty string.
    expect(textPage("res", "abc", 10, 5)).toEqual({
      resource: "res",
      offset: 10,
      total_chars: 3,
      next_offset: null,
      text: "",
    });
    expect(textPage("res", "", 0, 5)).toEqual({
      resource: "res",
      offset: 0,
      total_chars: 0,
      next_offset: null,
      text: "",
    });
    // Zero limit before end keeps next_offset at offset.
    expect(textPage("res", "abc", 1, 0)).toEqual({
      resource: "res",
      offset: 1,
      total_chars: 3,
      next_offset: 1,
      text: "",
    });
  });

  test("capped, triggerMessage, workerTriggerMessage, and batchLine preserve exact limits and keys", () => {
    expect(ASSIGNMENT_CHARS).toBe(1500);
    expect(WORKER_TRIGGER_CHARS).toBe(4000);

    expect(capped("hello", 5, "r/1")).toEqual({ text: "hello" });
    expect(capped("hello!", 5, "r/1")).toEqual({ text: "hello…", chars: 6, read: "r/1" });
    expect(capped("😀😀😀", 2, "r/2")).toEqual({ text: "😀😀…", chars: 3, read: "r/2" });

    const long700 = "z".repeat(700);
    const trigger700 = makeTrigger({ text: long700 });
    expect(triggerMessage(trigger700, "watch out")).toEqual({
      trigger_id: "tr1",
      from: "alice",
      thread: "wechat:room-1",
      at: "2026-03-01T10:20:30.400Z",
      text: `${"z".repeat(600)}…`,
      chars: 700,
      read: "trigger/tr1",
      routing_note: "watch out",
    });

    // Worker trigger message carries up to 4000 chars inline without truncation.
    const worker700 = workerTriggerMessage(trigger700, undefined, true);
    expect(worker700).toEqual({
      trigger_id: "tr1",
      from: "alice",
      thread: "wechat:room-1",
      at: "2026-03-01T10:20:30.400Z",
      text: long700,
      acknowledged: true,
    });
    expect("routing_note" in worker700).toBe(false);

    const long4005 = makeTrigger({ text: "w".repeat(4005) });
    const worker4005 = workerTriggerMessage(long4005, "note", false);
    expect(worker4005.text).toBe(`${"w".repeat(4000)}…`);
    expect(worker4005.chars).toBe(4005);
    expect(worker4005.read).toBe("trigger/tr1");
    expect(worker4005.routing_note).toBe("note");
    expect("acknowledged" in worker4005).toBe(false);

    // batchLine uses 500-char collapsed preview.
    const batchTrig = makeTrigger({ text: `  ${"b".repeat(520)}\nmore  ` });
    expect(batchLine(batchTrig)).toEqual({
      trigger_id: "tr1",
      from: "alice",
      at: "2026-03-01T10:20:30.400Z",
      preview: "b".repeat(500),
      read: "trigger/tr1",
    });
  });

  test("inputResource, inputMessage, RETRIED, and mandateInstructions match Rust verbatim", () => {
    expect(inputResource("tk1", "in1")).toBe(`ticket/tk1/input/${key(["in1"])}`);
    expect(RETRIED).toBe(
      "A person retried this ticket. Continue the assignment from the current state of the directory and its history.",
    );

    // 1. trigger input without prebuilt card, with and without context.
    const trigInput: TicketInput = { kind: "trigger", id: "i1", triggerId: "tr1", at: "t1" };
    expect(JSON.parse(inputMessage(trigInput))).toEqual({
      trigger_id: "tr1",
      read: "trigger/tr1",
    });
    const ctxTrigInput: TicketInput = {
      kind: "trigger",
      id: "i2",
      triggerId: "tr2",
      at: "t1",
      context: true,
    };
    const customCard = { trigger_id: "tr2", text: "fyi" };
    expect(JSON.parse(inputMessage(ctxTrigInput, customCard))).toEqual({
      trigger_id: "tr2",
      text: "fyi",
      context: true,
    });
    // Does not mutate caller's card.
    expect("context" in customCard).toBe(false);

    // 2. policy-changed input: disabled rule, changed rule, proactive=false, requesterAllowed=false.
    const fullPolicyInput: TicketInput = {
      kind: "policy-changed",
      id: "i3",
      from: "v1",
      to: "v2",
      at: "t1",
      effect: {
        rules: [
          { id: "r1", name: "AutoFix", change: "disabled" },
          { id: "r2", name: "Docs", change: "changed", instruction: "Only fix typos." },
        ],
        proactive: false,
        requesterAllowed: false,
        requester: { source: "wechat", id: "alice" },
      },
    };
    expect(inputMessage(fullPolicyInput)).toBe(
      [
        "Policy change:",
        "Rule AutoFix (r1), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.",
        "Rule Docs (r2), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: Only fix typos.",
        "Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only what is in progress within the assignment, or report dropped, and take on nothing new.",
        "The sender this ticket is for, alice on wechat, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.",
      ].join("\n"),
    );

    // requesterAllowed=false without requester uses fallback phrasing.
    const anonPolicyInput: TicketInput = {
      kind: "policy-changed",
      id: "i3b",
      from: "v1",
      to: "v2",
      at: "t1",
      effect: { requesterAllowed: false },
    };
    expect(inputMessage(anonPolicyInput)).toContain("who asked for it");

    // Empty PolicyEffect returns generic single-line message.
    const emptyPolicyInput: TicketInput = {
      kind: "policy-changed",
      id: "i3c",
      from: "v1",
      to: "v2",
      at: "t1",
      effect: {},
    };
    expect(inputMessage(emptyPolicyInput)).toBe(
      "Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.",
    );

    // 3. resumed, note, text inputs.
    expect(inputMessage({ kind: "resumed", id: "i4", triggerId: "tr3", at: "t1" })).toContain(
      "This ticket ended earlier and the message that follows resumed it under the same mandate.",
    );
    expect(inputMessage({ kind: "note", id: "i5", text: "PR merged", at: "t1" })).toBe(
      "Note from the orchestrator, for context only: PR merged",
    );
    expect(inputMessage({ kind: "text", id: "i6", text: "status?", at: "t1" })).toBe("status?");

    // mandateInstructions only for inferred strength.
    expect(mandateInstructions(makeTicket())).toBeUndefined();
    const inferred = makeTicket({
      mandate: { ...makeTicket().mandate, strength: "inferred" },
    });
    expect(mandateInstructions(inferred)).toBe(
      "This ticket has limited proactive authorization. Independently verify that it is a small change internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product decisions or clarification, stop and report dropped; do not expand scope.",
    );
  });

  test("inputLine, assignmentLine, newestPage, and ticketDetails shape paginated resources", () => {
    const shortText: TicketInput = { kind: "text", id: "in-short", text: "a".repeat(80), at: "t1" };
    const longText: TicketInput = { kind: "text", id: "in-long", text: `  ${"b".repeat(90)}  `, at: "t2" };
    const trigIn: TicketInput = { kind: "trigger", id: "in-trig", triggerId: "tr2", at: "t3" };
    const resIn: TicketInput = { kind: "resumed", id: "in-res", triggerId: "tr3", at: "t4" };
    const noteIn: TicketInput = { kind: "note", id: "in-note", text: "fyi", at: "t5" };
    const polIn: TicketInput = {
      kind: "policy-changed",
      id: "in-pol",
      from: "v1",
      to: "v2",
      at: "t6",
      effect: {},
    };
    const ticket = makeTicket({
      undelivered: ["in-trig", "in-note"],
      assignments: [
        makeAssignment({
          id: "a1",
          state: "ended",
          endedReason: "hostRestarted",
          report: { state: "progress", summary: "  " + "r".repeat(120), at: "t1" },
        }),
        makeAssignment({ id: "a2", state: "ended" }),
        makeAssignment({ id: "a3", state: "ended" }),
        makeAssignment({ id: "a4", state: "running" }),
      ],
      inputs: [
        shortText,
        longText,
        trigIn,
        resIn,
        noteIn,
        polIn,
        { kind: "text", id: "in-7", text: "7", at: "t7" },
        { kind: "text", id: "in-8", text: "8", at: "t8" },
        { kind: "text", id: "in-9", text: "9", at: "t9" },
        { kind: "text", id: "in-10", text: "10", at: "t10" },
        { kind: "text", id: "in-11", text: "11", at: "t11" },
      ],
    });

    expect(inputLine(ticket, shortText)).toEqual({ kind: "text", at: "t1", text: "a".repeat(80) });
    expect(inputLine(ticket, longText)).toEqual({
      kind: "text",
      at: "t2",
      preview: "b".repeat(80),
      chars: 94,
      read: inputResource("tk1", "in-long"),
    });
    expect(inputLine(ticket, trigIn)).toEqual({
      kind: "trigger",
      at: "t3",
      trigger_id: "tr2",
      undelivered: true,
    });
    expect(inputLine(ticket, resIn)).toEqual({ kind: "resumed", at: "t4", trigger_id: "tr3" });
    expect(inputLine(ticket, noteIn)).toEqual({
      kind: "note",
      at: "t5",
      read: inputResource("tk1", "in-note"),
      undelivered: true,
    });
    expect(inputLine(ticket, polIn)).toEqual({
      kind: "policy-changed",
      at: "t6",
      read: inputResource("tk1", "in-pol"),
    });

    expect(assignmentLine(ticket, ticket.assignments[0])).toEqual({
      id: "a1",
      state: "ended",
      at: "2026-03-01T10:21:05.000Z",
      ended_reason: "neo-agent restarted",
      report: {
        state: "progress",
        at: "t1",
        preview: "r".repeat(100),
        chars: 122,
        read: "ticket/tk1/report/a1",
      },
    });

    // newestPage edge cases.
    expect(newestPage([1, 2, 3, 4, 5], 0, 3, (n) => n)).toEqual([[5, 4, 3], 3]);
    expect(newestPage([1, 2, 3, 4, 5], 3, 2, (n) => n)).toEqual([[2, 1], undefined]);
    expect(newestPage([1, 2, 3], 3, 2, (n) => n)).toEqual([[], undefined]);
    expect(newestPage([1], 0, 0, (n) => n)).toEqual([[], 0]);

    // ticketDetails for main session vs worker.
    const batchPeer = makeTrigger({ id: "tr-peer", text: "extra context" });
    const mainDetails = ticketDetails(ticket, [{ thread: "wechat:room-1" }], [batchPeer], false);
    expect("preview" in mainDetails).toBe(false);
    expect(mainDetails.trigger_id).toBe("tr1");
    expect(mainDetails.decision_id).toBe("dec1");
    expect(mainDetails.directory).toBeNull();
    expect(mainDetails.scope).toBe("Fix the login error in auth module");
    expect(mainDetails.requested_by).toBe("alice");
    expect(mainDetails.threads).toEqual([{ thread: "wechat:room-1" }]);
    expect(mainDetails.batch).toEqual([batchLine(batchPeer)]);
    expect(mainDetails.assignment).toBe("ticket/tk1/assignment");
    expect(mainDetails.result).toBe("ticket/tk1/result");
    expect(mainDetails.transcript).toBe("ticket/tk1/transcript");

    const assignmentsPage = mainDetails.assignments as Record<string, unknown>;
    expect((assignmentsPage.items as Array<Record<string, unknown>>).map((a) => a.id)).toEqual([
      "a4",
      "a3",
      "a2",
    ]);
    expect(assignmentsPage.next_resource).toBe("ticket/tk1/assignments");
    expect(assignmentsPage.next_offset).toBe(3);

    const inputsPage = mainDetails.inputs as Record<string, unknown>;
    expect((inputsPage.items as unknown[]).length).toBe(10);
    expect(inputsPage.next_resource).toBe("ticket/tk1/inputs");
    expect(inputsPage.next_offset).toBe(10);

    // Worker view omits decision_id and omits batch when empty; includes execution directory when present.
    const withExec = makeTicket({
      execution: { name: "fix-login", directory: "/work/fix-login", assignment: "Do it" },
    });
    const workerDetails = ticketDetails(withExec, [], [], true);
    expect("decision_id" in workerDetails).toBe(false);
    expect("batch" in workerDetails).toBe(false);
    expect(workerDetails.directory).toBe("/work/fix-login");
    expect((workerDetails.assignments as Record<string, unknown>).next_offset).toBeUndefined();
    expect((workerDetails.inputs as Record<string, unknown>).next_offset).toBeUndefined();
  });
});

describe("notices", () => {
  // Ported directly from neo-app/src/notices.rs #[cfg(test)]
  test("lists the paths where two values differ", () => {
    const before = {
      eval: { mode: "observe", timeoutSeconds: 120 },
      policy: {
        rules: [
          { id: "a", enabled: true },
          { id: "b", enabled: true },
        ],
      },
      gone: 1,
    };
    const after = {
      eval: { mode: "auto", timeoutSeconds: 120 },
      policy: {
        rules: [{ id: "a", enabled: true }, { id: "b", enabled: false }, { id: "c" }],
      },
      new: true,
    };
    expect(changedPaths(before, after)).toEqual([
      "eval.mode",
      "gone",
      "new",
      "policy.rules.1.enabled",
      "policy.rules.2",
    ]);
    expect(changedPaths(before, before)).toEqual([]);

    const many = (n: number) => Array.from({ length: 40 }, (_, i) => i * n);
    expect(changedPaths(many(1), many(2)).length).toBe(20);

    // Subtle JSON edge cases matching Rust serde_json::Value semantics.
    expect(changedPaths({ a: null }, {})).toEqual([]);
    expect(changedPaths({ a: [] }, { a: {} })).toEqual(["a"]);
    expect(changedPaths(1, 2)).toEqual([""]);
    expect(changedPaths(1, 1)).toEqual([]);
  });

  // Ported directly from neo-app/src/notices.rs #[cfg(test)]
  test("names a settings notice by its block and a receipt uniquely", () => {
    const settings = settingsNotice("executor", ["executor.maxWorkers"]);
    expect(settings.name).toBe("settings:executor");
    expect(settings.value).toEqual({
      settings_saved: "executor",
      changed: ["executor.maxWorkers"],
    });
    expect(receiptNotice({}).name).not.toBe(receiptNotice({}).name);
  });

  test("eventNotice builds notices for TicketEnded, TriggerRequeued, ThreadUnsubscribed, and ignores others", () => {
    const at = "2026-03-01T12:00:00.000Z";
    const endedTicket = makeTicket({
      ended: { at, by: "executor", outcome: "completed" },
    });

    // TicketEnded with stored ticket -> briefCard.
    const endedEv: DomainEvent = {
      type: "ticketEnded",
      ticketId: "tk1",
      by: "executor",
      outcome: "completed",
    };
    const n1 = eventNotice(endedEv, at, (id) => (id === "tk1" ? endedTicket : undefined));
    expect(n1).toBeDefined();
    expect(n1?.value).toEqual({ ticket_ended: briefCard(endedTicket) });

    // TicketEnded without stored ticket -> fallback object (defaulting reason to outcome).
    const n2 = eventNotice(endedEv, at, () => undefined);
    expect(n2?.value).toEqual({
      ticket_ended: "tk1",
      by: "executor",
      outcome: "completed",
      reason: "completed",
      at,
    });

    // TicketEnded without stored ticket with explicit reason.
    const stoppedEv: DomainEvent = {
      type: "ticketEnded",
      ticketId: "tk9",
      by: "human",
      outcome: "stopped",
      reason: "Cancelled",
    };
    const n2b = eventNotice(stoppedEv, at, () => undefined);
    expect(n2b?.value).toEqual({
      ticket_ended: "tk9",
      by: "human",
      outcome: "stopped",
      reason: "Cancelled",
      at,
    });

    // TriggerRequeued.
    const requeuedEv: DomainEvent = { type: "triggerRequeued", triggerId: "tr42" };
    const n3 = eventNotice(requeuedEv, at, () => undefined);
    expect(n3?.value).toEqual({
      trigger_requeued: "tr42",
      read: "trigger/tr42",
      at,
    });

    // ThreadUnsubscribed byPerson: true -> coalescing subscription:<threadKey> notice.
    const personUnsub: DomainEvent = {
      type: "threadUnsubscribed",
      threadKey: "wechat:room-1",
      ticketId: "tk1",
      byPerson: true,
    };
    const n4 = eventNotice(personUnsub, at, () => undefined);
    expect(n4).toEqual({
      name: "subscription:wechat:room-1",
      value: {
        subscription_changes: [{ thread: "wechat:room-1", removed: true }],
        at,
      },
    });

    // ThreadUnsubscribed byPerson: false -> receipt with thread_unrelated (null when reason omitted).
    const workerUnsub: DomainEvent = {
      type: "threadUnsubscribed",
      threadKey: "wechat:room-2",
      ticketId: "tk1",
      byPerson: false,
      reason: "Different repo",
    };
    const n5 = eventNotice(workerUnsub, at, () => undefined);
    expect(n5?.value).toEqual({
      thread_unrelated: { ticket_id: "tk1", thread: "wechat:room-2", reason: "Different repo" },
      at,
      note: "Its Executor found this thread unrelated after reading it; attach later triggers there to this ticket only when they point at it explicitly.",
    });

    const workerUnsubNoReason: DomainEvent = {
      type: "threadUnsubscribed",
      threadKey: "wechat:room-3",
      ticketId: "tk1",
      byPerson: false,
    };
    const n6 = eventNotice(workerUnsubNoReason, at, () => undefined);
    expect((n6?.value as Record<string, unknown>).thread_unrelated).toEqual({
      ticket_id: "tk1",
      thread: "wechat:room-3",
      reason: null,
    });

    // Unhandled events return undefined.
    expect(
      eventNotice({ type: "policyChanged", from: "v1", to: "v2" }, at, () => undefined),
    ).toBeUndefined();
    expect(
      eventNotice({ type: "triggerReceived", triggerId: "tr1", threads: ["wechat:room-1"] }, at, () => undefined),
    ).toBeUndefined();
  });

  test("threadFollowedNotice produces exact payload", () => {
    const notice = threadFollowedNotice("tk1", "github:pr-9", "Tracks deploy status");
    expect(notice.value).toEqual({
      thread_followed: {
        ticket_id: "tk1",
        thread: "github:pr-9",
        reason: "Tracks deploy status",
      },
      note: "For context only: its messages reach this ticket and grant nothing.",
    });
  });

  test("followupRelay handles live owners, context flag, non-live filtering, and non-owner suppression", () => {
    const repo = new MemoryStore();
    const trigger = makeTrigger({ id: "tr-fu", text: "Any update?" });

    const liveOwner = makeTicket({
      id: "tk-live",
      title: "Live task",
      assignments: [makeAssignment({ state: "running" })],
    });
    const liveContext = makeTicket({
      id: "tk-ctx",
      title: "Context watcher",
      assignments: [],
    });
    const endedTicket = makeTicket({
      id: "tk-ended",
      title: "Done task",
      ended: { at: "t", by: "executor", outcome: "completed" },
    });

    repo.saveTicket(liveOwner);
    repo.saveTicket(liveContext);
    repo.saveTicket(endedTicket);
    repo.saveDisposition("tr-fu", {
      fanout: ["tk-live", "tk-ctx", "tk-ended"],
      context: ["tk-ctx"],
      at: "2026-03-01T10:25:00.000Z",
    });

    const relay = followupRelay(repo, trigger);
    expect(relay).toBeDefined();
    expect(relay?.id).toBe("followup:tr-fu");
    expect(JSON.parse(relay!.text)).toEqual({
      trigger_id: "tr-fu",
      from: "alice",
      thread: "wechat:room-1",
      at: "2026-03-01T10:20:30.400Z",
      text: "Any update?",
      kind: "follow_up",
      delivered_to: [
        { ticket_id: "tk-live", title: "Live task", state: "working" },
        { ticket_id: "tk-ctx", title: "Context watcher", state: "working/queued", context: true },
      ],
      note: "Its ticket's worker has it and decides; act only if the person asks to stop the work (orchestrator_route kind stop with this trigger_id).",
    });

    // Bot trigger -> no owners -> undefined.
    expect(followupRelay(repo, makeTrigger({ id: "tr-fu", human: false }))).toBeUndefined();

    // Ended ticket waiting to resume IS in followupOwners, but has no live tickets in fanout -> undefined.
    const resumable = makeTicket({
      id: "tk-resumable",
      ended: { at: "t", by: "executor", outcome: "completed" },
      inputs: [{ kind: "trigger", id: "in-r", triggerId: "tr-res", at: "t2", human: true }],
      undelivered: ["in-r"],
    });
    repo.saveTicket(resumable);
    repo.saveDisposition("tr-res", { fanout: ["tk-resumable"], at: "t2" });
    expect(followupRelay(repo, makeTrigger({ id: "tr-res" }))).toBeUndefined();
  });

  test("resultRelay formats worker_report with directory, answer_to, and 2000-char summary clipping", () => {
    const ticket = makeTicket({
      execution: { name: "fix-login", directory: "/repo/wt", assignment: "Fix it" },
    });
    const shortRelay = resultRelay(ticket, "ready", "All tests pass", "tr-q1");
    expect(shortRelay.id).toBe(
      `report:${key(["worker-result", ticket.id, ticket.updatedAt, "All tests pass"])}`,
    );
    const shortPayload = JSON.parse(shortRelay.text);
    expect(shortPayload).toEqual({
      kind: "worker_report",
      ticket: briefCard(ticket),
      trigger_id: "tr1",
      state: "ready",
      directory: "/repo/wt",
      answer_to: "tr-q1",
      summary: "All tests pass",
      read: "ticket/tk1/result",
    });
    expect("chars" in shortPayload).toBe(false);

    // Long summary (> 2000 Unicode scalar chars) clips at 2000 and includes chars; no execution omits directory.
    const noExecTicket = makeTicket();
    const longText = "🎉".repeat(2005);
    const longRelay = resultRelay(noExecTicket, "blocked", longText);
    const longPayload = JSON.parse(longRelay.text);
    expect("directory" in longPayload).toBe(false);
    expect("answer_to" in longPayload).toBe(false);
    expect(longPayload.summary).toBe("🎉".repeat(2000));
    expect(longPayload.chars).toBe(2005);
    expect(longPayload.read).toBe("ticket/tk1/result");
  });

  test("stateName and reportRelay handle worker_attention, progress suppression, and answer/result relays", () => {
    expect(stateName("progress")).toBe("progress");
    expect(stateName("waiting")).toBe("waiting");
    expect(stateName("ready")).toBe("ready");
    expect(stateName("blocked")).toBe("blocked");
    expect(stateName("failed")).toBe("failed");
    expect(stateName("dropped")).toBe("dropped");

    // 1. Question::Ask with ticket.attention -> worker_attention, summary clipped to 600.
    const askingTicket = makeTicket({
      attention: { id: "att-42", question: "Approve deploy?", triggerId: "tr1" },
    });
    const askReport = workerReport("waiting", "x".repeat(700), {
      question: { kind: "ask", question: "Approve deploy?" },
    });
    const attnRelay = reportRelay(askingTicket, askReport);
    expect(attnRelay).toBeDefined();
    expect(attnRelay?.id).toBe("attention:tk1:att-42");
    expect(JSON.parse(attnRelay!.text)).toEqual({
      kind: "worker_attention",
      ticket: briefCard(askingTicket),
      state: "waiting",
      read: "ticket/tk1/result",
      summary: "x".repeat(600),
    });

    // Empty summary is omitted on worker_attention.
    const emptyAskRelay = reportRelay(
      askingTicket,
      workerReport("blocked", "", { question: { kind: "ask", question: "Approve deploy?" } }),
    );
    const emptyAskPayload = JSON.parse(emptyAskRelay!.text);
    expect("summary" in emptyAskPayload).toBe(false);
    expect(emptyAskPayload.kind).toBe("worker_attention");

    // 2. Routine progress without answers -> undefined.
    expect(reportRelay(makeTicket(), workerReport("progress", "Still compiling"))).toBeUndefined();

    // 3. Progress WITH answers -> worker_report relay with answer_to.
    const answerRelay = reportRelay(
      makeTicket(),
      workerReport("progress", "Yes, v2 is supported", { answers: "tr-q2" }),
    );
    expect(answerRelay).toBeDefined();
    const answerPayload = JSON.parse(answerRelay!.text);
    expect(answerPayload.kind).toBe("worker_report");
    expect(answerPayload.state).toBe("progress");
    expect(answerPayload.answer_to).toBe("tr-q2");
    expect(answerPayload.summary).toBe("Yes, v2 is supported");

    // 4. Non-progress states without question -> worker_report relay.
    const readyRelay = reportRelay(makeTicket(), workerReport("ready", "Shipped"));
    expect(readyRelay).toBeDefined();
    expect(JSON.parse(readyRelay!.text).state).toBe("ready");

    // 5. Question::Ask when ticket.attention is absent falls through to normal report rules.
    expect(
      reportRelay(
        makeTicket(),
        workerReport("progress", "Working", { question: { kind: "ask", question: "Q?" } }),
      ),
    ).toBeUndefined();
  });
});
