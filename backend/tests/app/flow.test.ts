/**
 * The whole path of a request, over a scripted kernel: a chat message becomes a candidate, the orchestrator accepts
 * it, a worker does the work in its own directory and reports, and the result goes back to the conversation.
 *
 * Faithful pure-TypeScript port of `neo-app/tests/flow.rs`.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionRole } from "../../src/app/index.ts";
import { key } from "../../src/core/index.ts";
import { textOf } from "../../src/kernel/index.ts";
import { message, messages, started } from "./common.ts";

describe("flow", () => {
  test("carries_a_chat_request_from_message_to_result", async () => {
    const f = await started();
    try {
      const receipt = await f.app.receiveWeb("Please fix the typo in the fixture.", [], "web:m1");
      expect([receipt.result, receipt.requestId]).toEqual(["stored", "chat:web:m1"]);
      await f.until("the result is in the transcript", () => f.chat().length >= 3);
      await f.settle();

      // The person sees their message, the acknowledgement and the result, each once and in order.
      expect(f.chat()).toEqual([
        ["web-panel", "Please fix the typo in the fixture."],
        ["chat-reply", "I will fix the fixture typo."],
        ["chat-reply", "Fixture work completed."],
      ]);

      // One ticket, accepted explicitly from the local sender, completed by its worker's ready report.
      const tickets = f.tickets();
      expect(tickets.length).toBe(1);
      const ticket = tickets[0]!;
      expect([ticket.title, ticket.mandate.actor.id]).toEqual(["Fix fixture typo", "web:local"]);
      expect(ticket.ended?.outcome).toBe("completed");
      expect(ticket.assignments.map((assignment) => assignment.state)).toEqual(["ended"]);
      expect(
        ticket.assignments[0]?.report
          ? [ticket.assignments[0].report.state, ticket.assignments[0].report.summary]
          : undefined,
      ).toEqual(["ready", "Fixture change is ready."]);
      expect(ticket.digest).toBe("The fixture typo in fixture-result.txt");

      // The worker ran in the ticket's own directory, named after the ticket.
      const execution = ticket.execution;
      expect(execution).toBeDefined();
      expect(
        execution!.name.startsWith("fix-fixture-typo-") &&
          execution!.directory.endsWith(execution!.name),
      ).toBe(true);
      expect(execution!.directory.startsWith(f.dir.join("state/work"))).toBe(true);
      expect(fs.readFileSync(path.join(execution!.directory, "fixture-result.txt"), "utf8")).toBe(
        "fixed\n",
      );

      // What each Session was told.
      const main = f.ran("orchestrator");
      expect(main.length).toBe(2);
      const candidate = message(main[0]!.text, "candidate");
      expect([candidate.kind, candidate.strength, candidate.from]).toEqual([
        "candidate",
        "explicit",
        "web:local",
      ]);
      expect(candidate.text).toBe("Please fix the typo in the fixture.");
      expect(candidate.trigger_id).toBe(receipt.triggerId);
      const report = message(main[1]!.text, "worker_report");
      expect([report.state, report.summary]).toEqual(["ready", "Fixture change is ready."]);

      // The main Session is also told that the ticket ended, as a notice that starts no turn of its own: it reads it
      // with the report when it came first, else with its next message.
      const mainSession = f.app.session(f.app.masterId);
      expect(mainSession).not.toBeNull();
      const noted: Record<string, unknown>[] = [];
      for (const entry of mainSession!.session.journal().entries()) {
        if (entry.type === "custom_message") {
          try {
            const parsed = JSON.parse(textOf(entry.content)) as unknown;
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              noted.push(parsed as Record<string, unknown>);
            }
          } catch {
            // ignore non-JSON entries
          }
        }
      }
      const ended = noted.find((value) => "ticket_ended" in value);
      expect(ended).toBeDefined();
      expect((ended!.ticket_ended as Record<string, unknown>).state).toBe("completed");

      const workers = f.ran("worker");
      expect(workers.length).toBe(1);
      const assignment = messages(workers[0]!.text)[0];
      expect(assignment).toBeDefined();
      expect([assignment!.ticket_id, assignment!.title]).toEqual([ticket.id, "Fix fixture typo"]);
      expect((assignment!.trigger as Record<string, unknown>).text).toBe(
        "Please fix the typo in the fixture.",
      );
      expect(assignment!.directory).toBe(execution!.directory);

      // Each role was given its own prompt and tools.
      const opened = [...f.kernels.opened];
      const ofRole = (role: SessionRole) => {
        const spec = opened.find((item) => item.role === role);
        expect(spec).toBeDefined();
        return spec!;
      };
      expect(
        ofRole("orchestrator").systemPrompt.includes("You are the orchestrator") &&
          ofRole("orchestrator").systemPrompt.includes("## Policy"),
      ).toBe(true);
      expect(
        ofRole("worker").systemPrompt.includes("You are a worker.") &&
          !ofRole("worker").systemPrompt.includes("## Policy"),
      ).toBe(true);
      expect(ofRole("worker").cwd).toBe(execution!.directory);

      // The worker's Session closed with its ticket; both replies went out.
      expect(f.app.session(`worker-${ticket.id}`)).toBeNull();
      expect(f.app.store.waitingReceipts()).toEqual([]);
      expect(f.app.activeWorkers()).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test("takes_a_chat_message_once_however_often_it_is_sent", async () => {
    const f = await started();
    try {
      const first = await f.app.receiveWeb("Fix it.", [], "web:same");
      const again = await f.app.receiveWeb("Fix it.", [], "web:same");
      expect([first.result, again.result]).toEqual(["stored", "duplicate"]);
      expect(first.triggerId).toBe(again.triggerId);
      await f.until("the work is done", () => f.chat().length >= 3);
      await f.settle();
      expect(f.tickets().length).toBe(1);
      expect(f.chat().filter(([source]) => source === "web-panel").length).toBe(1);
      await expect(f.app.receiveWeb("x", [], "bad id")).rejects.toThrow("Invalid chat message ID");
    } finally {
      await f.cleanup();
    }
  });

  test("answers_plain_conversation_in_the_same_turn_without_a_ticket", async () => {
    const f = await started();
    try {
      f.script(async (turn) => {
        const card = turn.card("kind");
        if (card?.kind === "candidate") {
          const routed = await turn.call("orchestrator_route", {
            decisions: [
              {
                kind: "ignore",
                trigger_id: card.trigger_id,
                reason: "Small talk",
                answer: "你好！有什么需要我做的吗？",
              },
            ],
          });
          const results = routed.results as Record<string, unknown>[];
          expect(results[0]!.decision).toBe("ignore");
        }
        return "Done.";
      });
      await f.app.receiveWeb("你好", []);
      await f.until("the answer is in the transcript", () => f.chat().length === 2);
      await f.settle();
      expect(f.chat()[1]).toEqual(["chat-reply", "你好！有什么需要我做的吗？"]);
      expect(f.tickets()).toEqual([]);
      expect(f.ran("orchestrator").length).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  test("refuses_one_bad_routing_item_and_still_runs_the_others", async () => {
    const f = await started();
    try {
      let results: Record<string, unknown> | null = null;
      f.script(async (turn) => {
        const card = turn.card("kind");
        if (card?.kind === "candidate") {
          const id = card.trigger_id;
          results = await turn.call("orchestrator_route", {
            decisions: [
              { kind: "accept", trigger_id: id, title: "No name" },
              {
                kind: "accept",
                trigger_id: id,
                title: "T",
                worktree_name: "Bad Name",
                acknowledgement: "ok",
              },
              { kind: "attach", trigger_id: id, ticket_id: "missing" },
              { kind: "stop", trigger_id: "missing", ticket_id: "missing" },
              { kind: "sideways", trigger_id: id },
              { kind: "ignore", trigger_id: id },
              { kind: "ignore", trigger_id: id, reason: "Chatter", title: "x", extra: 1 },
              { kind: "ignore", trigger_id: id, reason: "Chatter" },
              { kind: "ignore", trigger_id: id, reason: "Again" },
            ],
          });
        }
        return "Done.";
      });
      await f.app.receiveWeb("hello", []);
      await f.until("the call returned", () => results !== null);
      await f.settle();
      const items = (results!.results as Record<string, unknown>[]) ?? [];
      const refused = items.map((item) =>
        typeof item.refused === "string" ? item.refused : "",
      );
      expect(refused[0]).toBe("accept needs worktree_name");
      expect(refused[1]!.startsWith("worktree_name: Use 1–4 short English words")).toBe(true);
      expect(refused[2]).toBe("Unknown ticket");
      expect(refused[3]).toBe("Unknown trigger");
      expect(refused[4]).toBe("kind is accept, attach, sidecar, ignore or stop");
      expect(refused[5]).toBe("ignore needs reason");
      expect(refused[6]!.startsWith("Unknown argument extra")).toBe(true);
      // The eighth item is the one that decided it; the ninth finds it decided in this call.
      expect([items[7]!.decision, refused[7]]).toEqual(["ignore", ""]);
      expect(refused[8]!.startsWith("Decided in this call with")).toBe(true);
      expect(f.tickets()).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("keeps_its_state_across_a_restart_and_sends_nothing_twice", async () => {
    let f = await started();
    try {
      await f.app.receiveWeb("Please fix the typo in the fixture.", [], "web:m1");
      await f.until("the result is in the transcript", () => f.chat().length >= 3);
      await f.settle();
      const beforeChat = f.chat();
      const beforeTickets = f.tickets();
      const beforeRanLen = f.kernels.ran.length;

      f = await f.restart();
      await f.settle();
      expect(f.chat()).toEqual(beforeChat);
      expect(f.tickets()).toEqual(beforeTickets);
      expect(f.kernels.ran.length).toBe(beforeRanLen);

      // The same message after the restart is still the same message.
      const dup = await f.app.receiveWeb("Please fix the typo in the fixture.", [], "web:m1");
      expect(dup.result).toBe("duplicate");

      // And new work goes on in the same conversation, with the main Session resuming its runtime context.
      await f.app.receiveWeb("And another typo.", [], "web:m2");
      await f.until("the second result is in the transcript", () => f.chat().length >= 6);
      await f.settle();
      expect(f.tickets().length).toBe(2);
      const main = f.ran("orchestrator");
      expect(main[main.length - 1]!.resumed).toBe(`rt-${f.app.masterId}`);
      expect(f.app.store.replyStatus(key(["ack", f.ticket(1).origin.triggerId]))).toBe("sent");
    } finally {
      await f.cleanup();
    }
  });
});
