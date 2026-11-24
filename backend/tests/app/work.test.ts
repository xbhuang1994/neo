/**
 * Workers at work, over a scripted kernel: questions and answers, idle turns, model failures and retries, the worker
 * limit, background jobs, the Sidecar, stops, restarts mid-work, the pause and attachments.
 *
 * Faithful pure-TypeScript port of `neo-app/tests/work.rs`.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SIDECAR,
  SIDECAR_SLOW_HINT_EN,
  SIDECAR_SLOW_HINT_ZH,
  SIDECAR_WORDS,
  StopWorkerError,
  cloneSettings,
  slowHintText,
  type ChatAttachment,
  type StopWorkerErrorKind,
} from "../../src/app/index.ts";
import { latestReport, ticketStage } from "../../src/core/index.ts";
import { Fixture, Turn, fixture, message, messages, started } from "./common.ts";

const ACCEPT = "I will do that.";

/** Accept a candidate as new work. */
async function accept(turn: Turn, card: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await turn.call("orchestrator_route", {
    decisions: [
      {
        kind: "accept",
        trigger_id: card.trigger_id,
        title: "Paint the button",
        worktree_name: "paint-button",
        acknowledgement: ACCEPT,
      },
    ],
  });
}

/**
 * The orchestrator every test here shares: accept the first request, attach later ones to the listed ticket, ask
 * people the questions workers raise, and deliver ready results.
 */
async function orchestrate(turn: Turn): Promise<string> {
  for (const msg of messages(turn.text)) {
    const kind = typeof msg.kind === "string" ? msg.kind : undefined;
    if (kind === "candidate") {
      const related = Array.isArray(msg.related_tickets)
        ? (msg.related_tickets as Record<string, unknown>[])
        : undefined;
      const first = related?.[0];
      if (first) {
        await turn.call("orchestrator_route", {
          decisions: [
            {
              kind: "attach",
              trigger_id: msg.trigger_id,
              ticket_id: first.ticket_id,
              acknowledgement: "Passing that on.",
            },
          ],
        });
      } else {
        await accept(turn, msg);
      }
    } else if (kind === "worker_attention") {
      const ticket = msg.ticket as Record<string, unknown>;
      const attention = ticket.attention as Record<string, unknown>;
      const question = attention.question;
      await turn.call("orchestrator_reply", {
        ticket_id: ticket.ticket_id,
        purpose: "attention",
        human_action: question,
        text: question,
      });
    } else if (kind === "worker_report" && msg.state === "ready") {
      const ticket = msg.ticket as Record<string, unknown>;
      await turn.call("orchestrator_reply", {
        ticket_id: ticket.ticket_id,
        purpose: "result",
        text: "It is done.",
      });
    }
  }
  return "Done.";
}

function replies(f: Fixture): string[] {
  return f
    .chat()
    .filter(([source]) => source === "chat-reply")
    .map(([, text]) => text);
}

async function expectStopWorkerError(
  promise: Promise<unknown>,
  expectedKind: StopWorkerErrorKind,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(StopWorkerError);
  expect((caught as StopWorkerError).kind).toBe(expectedKind);
}

/**
 * Three requests, each accepted as its own ticket while the first worker is still at work; returns the most workers
 * that worked at once.
 */
async function mostWorkersAtOnce(limit: number): Promise<number> {
  const f = await started();
  try {
    const settings = cloneSettings(f.app.settings());
    settings.executor.maxWorkers = limit;
    f.app.saveSettings(settings, "app", "executor");

    let active = 0;
    let most = 0;
    f.script(async (turn) => {
      if (turn.role === "worker") {
        active += 1;
        if (active > most) {
          most = active;
        }
        await Bun.sleep(400);
        active -= 1;
        await turn.call("orchestrator_report", { state: "ready", summary: "Painted." });
        return "Finished.";
      }
      // Every request is new work here.
      for (const msg of messages(turn.text)) {
        if (msg.kind === "candidate") {
          await accept(turn, msg);
        }
      }
      return "Done.";
    });

    for (let n = 0; n < 3; n++) {
      // One at a time: messages that arrive while a candidate is being decided are routed together, as one request.
      await f.app.receiveWeb(`Job ${n}`, []);
      await f.until("the request became a ticket", () => f.tickets().length === n + 1);
    }
    await f.until("all three finished", () =>
      f.tickets().every((ticket) => ticket.ended !== undefined),
    );
    await f.settle();
    expect(f.ran("worker").length).toBe(3);
    return most;
  } finally {
    await f.cleanup();
  }
}

describe("work", () => {
  test("asks_a_person_the_workers_question_and_takes_the_answer_back_to_the_worker", async () => {
    const f = await started();
    try {
      f.script(async (turn) => {
        if (turn.role !== "worker") {
          return await orchestrate(turn);
        }
        const titleCard = turn.card("title");
        if (titleCard) {
          // The assignment: a decision is needed before the work can go on.
          const trigger = titleCard.trigger as Record<string, unknown>;
          const asked = await turn.call("orchestrator_report", {
            state: "progress",
            summary: "Need the color.",
            human_action: "Which color?",
            question_for_trigger_id: trigger.trigger_id,
            topic: "Painting the settings button",
          });
          const attention = asked.attention as Record<string, unknown>;
          expect([asked.notification, attention.question]).toEqual(["orchestrator", "Which color?"]);
          return "Waiting for the answer.";
        }
        // The person's answer, attached to this ticket.
        const card = turn.card("trigger_id");
        expect(card).toBeDefined();
        const done = await turn.call("orchestrator_report", {
          state: "ready",
          summary: "Painted it blue.",
          reply_to_trigger_id: card!.trigger_id,
          direct_reply: "Done: the button is blue now.",
        });
        expect(done.notification).toBe("direct_outbox");
        return "Finished.";
      });

      await f.app.receiveWeb("Paint the settings button.", []);
      await f.until("the question reached the person", () => replies(f).length === 2);
      await f.settle();
      const ticket = f.ticket(0);
      expect(ticketStage(ticket)).toEqual({ kind: "person", action: "answer" });
      expect(ticket.attention?.question).toBe("Which color?");
      expect(replies(f)).toEqual([ACCEPT, "Which color?"]);

      await f.app.receiveWeb("Blue.", []);
      await f.until("the worker answered", () => replies(f).length === 4);
      await f.settle();
      expect(replies(f)).toEqual([
        ACCEPT,
        "Which color?",
        "Passing that on.",
        "Done: the button is blue now.",
      ]);
      const finished = f.ticket(0);
      expect(finished.ended ? [finished.ended.by, finished.ended.outcome] : undefined).toEqual([
        "executor",
        "completed",
      ]);
      expect(finished.attention).toBeUndefined();
      expect(f.tickets().length).toBe(1);
      // The answer went straight out: the orchestrator had no turn for it, only a notice.
      expect(f.ran("orchestrator").length).toBe(3);
      expect(f.ran("worker").length).toBe(2);
      // The worker's second message is the person's answer as an Input, by reference to its trigger.
      const input = messages(f.ran("worker")[1]!.text)[0]!;
      expect([input.text, input.from]).toEqual(["Blue.", "web:local"]);
    } finally {
      await f.cleanup();
    }
  });

  test("reports_for_a_worker_that_ended_its_turn_without_one_and_asks_it_for_its_status", async () => {
    const f = await started();
    try {
      f.script(async (turn) => {
        if (turn.role === "worker" && turn.has("status-only request")) {
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: "It was finished already.",
          });
          return "Reported.";
        }
        // It does the work but forgets to report.
        if (turn.role === "worker") {
          return "I changed the color.";
        }
        for (const msg of messages(turn.text)) {
          if (msg.kind === "worker_report" && msg.state === "waiting") {
            const summary = String(msg.summary);
            expect(
              summary.includes("I changed the color.") &&
                summary.includes("orchestrator_ticket_request_status"),
            ).toBe(true);
            const ticket = msg.ticket as Record<string, unknown>;
            const asked = await turn.call("orchestrator_ticket_request_status", {
              ticket_id: ticket.ticket_id,
            });
            expect(asked.reason).toBe("Asked the worker for a status report");
          }
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Paint the settings button.", []);
      await f.until("the result is delivered", () => replies(f).length === 2);
      await f.settle();
      expect(replies(f)).toEqual([ACCEPT, "It is done."]);
      const ticket = f.ticket(0);
      const reports = ticket.assignments.flatMap((assignment) =>
        assignment.report ? [assignment.report.state] : [],
      );
      expect([ticket.assignments.length, reports]).toEqual([1, ["ready"]]);
      expect(f.ran("worker").length).toBe(2);
    } finally {
      await f.cleanup();
    }
  });

  test("reports_a_failed_model_request_and_starts_over_when_a_person_retries", async () => {
    const f = await started();
    try {
      let attempts = 0;
      f.script(async (turn) => {
        if (turn.role === "worker") {
          if (attempts++ === 0) {
            throw new Error("401 unauthorized");
          }
          await turn.call("orchestrator_report", { state: "ready", summary: "Painted." });
          return "Finished.";
        }
        for (const msg of messages(turn.text)) {
          if (msg.kind === "candidate" && msg.text === "retry it") {
            const related = msg.related_tickets as Record<string, unknown>[];
            const ticketId = related[0]!.ticket_id;
            await turn.call("orchestrator_ticket_retry", { ticket_id: ticketId });
            await turn.call("orchestrator_route", {
              decisions: [
                {
                  kind: "ignore",
                  trigger_id: msg.trigger_id,
                  reason: "A retry",
                  answer: "Retrying.",
                },
              ],
            });
            return "Done.";
          }
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Paint the settings button.", []);
      await f.until("the failure is recorded", () => {
        const first = f.tickets()[0];
        if (!first) return false;
        const stage = ticketStage(first);
        return stage.kind === "person" && stage.action === "failed";
      });
      await f.settle();

      const failed = f.ticket(0);
      const report = latestReport(failed);
      expect(report ? [report.state, report.summary] : undefined).toEqual([
        "failed",
        "401 unauthorized",
      ]);
      // The orchestrator was told, and nothing is retried by itself.
      expect(
        f
          .ran("orchestrator")
          .some((ran) =>
            messages(ran.text).some(
              (msg) => msg.kind === "worker_report" && msg.state === "failed",
            ),
          ),
      ).toBe(true);
      expect(f.ran("worker").length).toBe(1);

      await f.app.receiveWeb("retry it", []);
      await f.until("the retry finished", () => replies(f).includes("It is done."));
      await f.settle();

      const ticket = f.ticket(0);
      expect(
        ticket.assignments.map((assignment) => [assignment.state, assignment.endedReason]),
      ).toEqual([
        ["ended", "retried"],
        ["ended", undefined],
      ]);
      expect(ticket.ended?.outcome).toBe("completed");
      // The new Assignment starts in a fresh runtime process that resumes the worker's context, which holds the
      // assignment already: it is told only that a person retried.
      const second = f.ran("worker")[1]!;
      const card = messages(second.text)[0]!;
      expect(String(card.note).startsWith("A person retried this ticket.")).toBe(true);
      expect([card.assignment, card.trigger]).toEqual([2, undefined]);
      expect(second.resumed).toBe(`rt-worker-${ticket.id}`);
      expect(f.kernels.closed.filter((id) => id.startsWith("worker-")).length).toBe(2);
      expect(replies(f)).toEqual([ACCEPT, "Retrying.", "It is done."]);
    } finally {
      await f.cleanup();
    }
  });

  test(
    "runs_no_more_workers_at_once_than_the_settings_allow",
    async () => {
      expect(await mostWorkersAtOnce(1)).toBe(1);
      expect(await mostWorkersAtOnce(2)).toBe(2);
    },
    20_000,
  );

  test("routes_messages_that_arrive_together_as_one_request", async () => {
    const f = await started();
    try {
      f.kernels.setHold(true);
      for (let n = 0; n < 3; n++) {
        await f.app.receiveWeb(`Part ${n}`, []);
      }
      f.kernels.setHold(false);
      await f.until(
        "both requests are done",
        () => f.tickets().length === 2 && f.tickets().every((ticket) => ticket.ended !== undefined),
      );
      await f.settle();
      // The first message was being decided when the other two came, so those two were decided together.
      const batches = f.tickets().map((ticket) => ticket.origin.triggerIds.length);
      expect(batches).toEqual([1, 2]);
      const secondRun = f.ran("orchestrator").find((ran) => ran.text.includes("Part 2"));
      expect(secondRun).toBeDefined();
      const second = message(secondRun!.text, "candidate");
      const batch = second.batch as Record<string, unknown>[];
      expect([second.text, batch[0]!.preview]).toEqual(["Part 2", "Part 1"]);
    } finally {
      await f.cleanup();
    }
  });

  test("leaves_a_shell_job_running_for_a_person_and_stops_subagents_at_a_handoff", async () => {
    const f = await started();
    try {
      f.script(async (turn) => {
        if (turn.role !== "worker") {
          return await orchestrate(turn);
        }
        // A preview server for the person to try, a subagent still at work, and a question: a handoff.
        turn.jobs.push(
          Fixture.job("bg_1", "bash", "npm run preview"),
          Fixture.job("task_1", "task", "Check the contrast"),
        );
        await turn.call("orchestrator_report", {
          state: "progress",
          summary: "Preview is up.",
          human_action: "Does the preview look right?",
        });
        return "Waiting for the answer.";
      });

      await f.app.receiveWeb("Paint the settings button.", []);
      await f.until("the question reached the person", () => replies(f).length === 2);
      await f.settle();
      const ticket = f.ticket(0);
      const worker = f.app.session(`worker-${ticket.id}`);
      expect(worker).not.toBeNull();
      // The subagent was cancelled, the server runs on, and it is not listed as work the worker still does.
      const jobs = await worker!.session.driver().jobs();
      expect(jobs.map((job) => job.id)).toEqual(["bg_1"]);
      expect(await f.app.runningJobs(ticket.id)).toEqual([]);
      // Its slot is free, and it is not reported as idle: it waits for the person.
      expect(f.app.activeWorkers()).toBe(0);
      expect(ticketStage(ticket)).toEqual({ kind: "person", action: "answer" });
      expect(latestReport(ticket)?.state).toBe("progress");
    } finally {
      await f.cleanup();
    }
  });

  test("keeps_a_worker_with_a_running_job_busy_and_cancels_the_job_for_the_watchdog", async () => {
    const f = await started();
    try {
      f.script(async (turn) => {
        if (turn.role === "worker" && turn.has("[Watchdog]")) {
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: "Recovered and finished.",
          });
          return "Finished.";
        }
        if (turn.role === "worker") {
          turn.jobs.push(Fixture.job("bg_1", "bash", "make train\nsecond line"));
          return "Training runs in the background.";
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Train it.", []);
      await f.until("the job is running", () =>
        f.kernels.ran.some((ran) => ran.role === "worker"),
      );
      await f.settle();
      const ticket = f.ticket(0);
      // The turn ended with a job running: the worker keeps its slot, and no idle report is made for it.
      expect(f.app.activeWorkers()).toBe(1);
      expect(latestReport(ticket)).toBeUndefined();
      const jobs = await f.app.runningJobs(ticket.id);
      expect(jobs.length).toBe(1);
      expect([jobs[0]!.id, jobs[0]!.label, jobs[0]!.command]).toEqual([
        "bg_1",
        "make train",
        "make train\nsecond line",
      ]);
      expect(jobs[0]!.type).toBe("bash");
      expect(await f.app.cancelJob(ticket.id, "no-such-job", "x")).toBe(false);
      expect(await f.app.cancelJob(ticket.id, "bg_1", "No output for 20 minutes.")).toBe(true);
      await f.until("the worker finished", () => f.tickets()[0]!.ended !== undefined);
      await f.settle();
      const woken = f.ran("worker")[1]!.text;
      expect(
        woken.startsWith(
          "[Watchdog] Stopped background job bg_1 (make train): No output for 20 minutes.",
        ),
      ).toBe(true);
      expect(await f.app.runningJobs(ticket.id)).toEqual([]);
      expect(replies(f)).toEqual([ACCEPT, "It is done."]);
    } finally {
      await f.cleanup();
    }
  });

  test("answers_a_question_about_a_ticket_with_the_sidecar_without_waking_its_worker", async () => {
    const f = await started();
    try {
      let packet: Record<string, unknown> | null = null;
      f.script(async (turn) => {
        if (turn.role === "worker") {
          fs.mkdirSync(path.join(turn.cwd, "results"), { recursive: true });
          fs.writeFileSync(path.join(turn.cwd, "results/metrics.csv"), "loss,0.12\n");
          fs.writeFileSync(path.join(turn.cwd, ".hidden"), "x");
          turn.jobs.push(Fixture.job("bg_1", "bash", "make train"));
          await turn.call("orchestrator_report", {
            state: "progress",
            summary: "Epoch 3 of 10, loss 0.12.",
            topic: "Training the model",
          });
          return "Training runs in the background.";
        }
        if (turn.role === "sidecar") {
          expect(turn.toolNames()).toEqual(["sidecar_reply"]);
          packet = JSON.parse(turn.text) as Record<string, unknown>;
          await expect(
            turn.call("sidecar_reply", { text: "字".repeat(SIDECAR_WORDS + 1) }),
          ).rejects.toThrow(`${SIDECAR_WORDS + 1} words`);
          await turn.call("sidecar_reply", { text: "Epoch 3 of 10, loss 0.12." });
          return "Done.";
        }
        for (const msg of messages(turn.text)) {
          if (msg.kind === "candidate" && msg.text === "How is it going?") {
            const related = msg.related_tickets as Record<string, unknown>[];
            const routed = await turn.call("orchestrator_route", {
              decisions: [
                {
                  kind: "sidecar",
                  trigger_id: msg.trigger_id,
                  ticket_id: related[0]!.ticket_id,
                  note: "Asks for progress",
                },
              ],
            });
            const results = routed.results as Record<string, unknown>[];
            expect(results[0]!.reason).toBe("Dispatched to read-only sidecar for immediate reply");
            return "Done.";
          }
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Train it.", []);
      await f.until("the worker reported progress", () => {
        const first = f.tickets()[0];
        return first !== undefined && latestReport(first) !== undefined;
      });
      await f.settle();
      await f.app.receiveWeb("How is it going?", []);
      await f.until("the sidecar answered", () => replies(f).length === 2);
      await f.settle();
      expect(replies(f)).toEqual([ACCEPT, "Epoch 3 of 10, loss 0.12."]);
      expect(f.ran("worker").length).toBe(1);
      expect(packet).not.toBeNull();
      const questions = packet!.questions as Record<string, unknown>[];
      expect(questions[0]!.text).toBe("How is it going?");
      expect(packet!.routing_note).toBe("Asks for progress");
      const latest = packet!.latest_report as Record<string, unknown>;
      expect([latest.state, latest.summary]).toEqual(["progress", "Epoch 3 of 10, loss 0.12."]);
      const runningJobs = packet!.running_jobs as Record<string, unknown>[];
      expect(runningJobs[0]!.id).toBe("bg_1");
      expect(packet!.workspace_files).toEqual(["results/", "results/metrics.csv"]);
      const packetTicket = packet!.ticket as Record<string, unknown>;
      expect(packetTicket.digest).toBe("Training the model");
      // The ticket and its worker are as they were.
      expect(f.ticket(0).ended).toBeUndefined();
      expect(f.ticket(0).inputs).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("stops_a_ticket_on_a_persons_word_and_blocks_its_worker_from_then_on", async () => {
    const f = await started();
    try {
      let workerTurn: Turn | null = null;
      f.script(async (turn) => {
        if (turn.role === "worker") {
          await turn.call("orchestrator_report", { state: "progress", summary: "Started." });
          turn.jobs.push(Fixture.job("bg_1", "bash", "make train"));
          workerTurn = turn;
          return "Working in the background.";
        }
        for (const msg of messages(turn.text)) {
          if (msg.kind === "candidate" && msg.text === "stop that") {
            const related = msg.related_tickets as Record<string, unknown>[];
            const stopped = await turn.call("orchestrator_route", {
              decisions: [
                {
                  kind: "stop",
                  trigger_id: msg.trigger_id,
                  ticket_id: related[0]!.ticket_id,
                  reason: "The person asked to stop",
                },
              ],
            });
            const results = stopped.results as Record<string, unknown>[];
            expect(results[0]!.decision).toBe("stop");
            return "Done.";
          }
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Train it.", []);
      await f.until("the worker is at work", () => workerTurn !== null);
      await f.settle();
      await f.app.receiveWeb("stop that", []);
      await f.until("the ticket ended", () => f.tickets()[0]!.ended !== undefined);
      await f.settle();

      const ticket = f.ticket(0);
      const ended = ticket.ended!;
      expect([ended.by, ended.outcome, ended.reason]).toEqual([
        "human",
        "stopped",
        "The person asked to stop",
      ]);
      // Its Session is closed, its slot is free, and whatever its model still tries is refused.
      await f.until(
        "the worker's Session closed",
        () => f.app.session(`worker-${ticket.id}`) === null,
      );
      expect(f.kernels.closed.includes(`worker-${ticket.id}`)).toBe(true);
      expect(f.app.activeWorkers()).toBe(0);
      const late = workerTurn!;
      let bashError: string | undefined;
      try {
        await late.call("bash", { command: "rm -rf build" });
      } catch (error) {
        bashError = error instanceof Error ? error.message : String(error);
      }
      expect(bashError).toBe("Ticket ended; new work needs a new authorized ticket");
      await expect(
        late.call("orchestrator_report", { state: "ready", summary: "late" }),
      ).rejects.toThrow();
      expect(replies(f)).toEqual([ACCEPT]);
    } finally {
      await f.cleanup();
    }
  });

  test("starts_a_worker_that_a_restart_interrupted_again_with_a_recovery_note", async () => {
    let f = await started();
    let releaseStuck: (() => void) | undefined;
    try {
      let attempts = 0;
      const stuck = new Promise<void>((resolve) => {
        releaseStuck = resolve;
      });
      f.script(async (turn) => {
        if (turn.role === "worker") {
          if (attempts++ === 0) {
            // Mid-work when the host goes down.
            await stuck;
          }
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: "Finished after the restart.",
          });
          return "Finished.";
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Paint the settings button.", []);
      await f.until("the worker is mid-work", () => attempts === 1);
      const before = f.ticket(0);
      expect(before.assignments.map((assignment) => assignment.state)).toEqual(["running"]);

      f = await f.restart();
      await f.until("the work finished", () => replies(f).includes("It is done."));
      await f.settle();

      const ticket = f.ticket(0);
      expect(ticket.id).toBe(before.id);
      expect(
        ticket.assignments.map((assignment) => [assignment.state, assignment.endedReason]),
      ).toEqual([
        ["ended", "hostRestarted"],
        ["ended", undefined],
      ]);
      const workerRuns = f.ran("worker");
      const resumed = workerRuns[workerRuns.length - 1]!;
      expect(resumed.text.includes("The host restarted during this ticket.")).toBe(true);
      // The transcript holds the assignment and the runtime has that context, so the card is short this time.
      const card = messages(resumed.text)[0]!;
      expect([card.assignment, card.trigger]).toEqual([2, undefined]);
      expect(resumed.resumed).toBe(`rt-worker-${ticket.id}`);
      expect(replies(f)).toEqual([ACCEPT, "It is done."]);
    } finally {
      releaseStuck?.();
      await f.cleanup();
    }
  });

  test("holds_everything_while_paused_and_goes_on_once_the_pause_lifts", async () => {
    const f = await started();
    try {
      const settings = cloneSettings(f.app.settings());
      settings.paused = true;
      f.app.saveSettings(settings, "app", "pause");
      const receipt = await f.app.receiveWeb("Please fix the typo in the fixture.", []);
      expect(receipt.result).toBe("stored");
      await f.settle();
      await Bun.sleep(100);
      // The message is shown and stored, and nothing else happened.
      expect(f.chat().length).toBe(1);
      expect(f.kernels.ran.length).toBe(0);
      expect(f.tickets().length).toBe(0);

      settings.paused = false;
      f.app.saveSettings(settings, "app", "pause");
      await f.until("the result is in the transcript", () => f.chat().length >= 3);
      await f.settle();
      expect(f.tickets().length).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  test("shows_images_to_the_model_inlines_text_files_and_saves_the_rest", async () => {
    const f = await started();
    try {
      const attachments: ChatAttachment[] = [
        { name: "shot.png", mediaType: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
        {
          name: "notes.md",
          mediaType: "",
          data: new TextEncoder().encode('# Notes\nUse <b> & "quotes".'),
        },
        {
          name: "data.bin",
          mediaType: "application/octet-stream",
          data: new Uint8Array([0, 1, 2, 3]),
        },
      ];
      await f.app.receiveWeb("See these.", attachments, "web:files");
      await f.until("the work is done", () => f.chat().length >= 3);
      await f.settle();

      const state = f.dir.join("state");
      const saved = (name: string) => path.join(state, "attachments/chat-web-files", name);
      expect(Array.from(fs.readFileSync(saved("1-shot.png")))).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(Array.from(fs.readFileSync(saved("3-data.bin")))).toEqual([0, 1, 2, 3]);
      expect(fs.existsSync(saved("2-notes.md"))).toBe(false);

      // What the person sees: their text with the files, and which files they attached.
      const shown = f.chat()[0]![1];
      expect(
        shown.startsWith('See these.\n\n<attachment name="shot.png" mediaType="image/png" path="'),
      ).toBe(true);
      expect(
        shown.includes('<attachment name="notes.md">\n# Notes\nUse <b> & "quotes".\n</attachment>'),
      ).toBe(true);
      expect(
        shown.includes('<attachment name="data.bin" mediaType="application/octet-stream" path="'),
      ).toBe(true);

      const entry = f.app.chatTranscript()[0] as unknown as Record<string, unknown>;
      const details = entry.details as Record<string, unknown>;
      expect(details.attachments).toEqual([
        { name: "shot.png", mediaType: "image/png" },
        { name: "notes.md", mediaType: "text/plain" },
        { name: "data.bin", mediaType: "application/octet-stream" },
      ]);
      const content = entry.content as Record<string, unknown>[];
      expect(content[1]).toEqual({ type: "image", mimeType: "image/png", data: "iVBORw==" });

      // The model is told of the image with the candidate that carries the message's text.
      const first = f.ran("orchestrator")[0]!.text;
      expect(first.startsWith("Images attached to chat message chat:web:files:")).toBe(true);
      const candidate = message(first, "candidate");
      expect(typeof candidate.chars === "number").toBe(Array.from(shown).length > 600);

      // A message with only files still says something.
      await f.app.receiveWeb("", [
        { name: "b.bin", mediaType: "application/zip", data: new Uint8Array([0]) },
      ]);
      await f.until(
        "it is shown",
        () => f.chat().filter(([source]) => source === "web-panel").length === 2,
      );
      expect(f.chat().some(([, text]) => text.startsWith('<attachment name="b.bin"'))).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("says_why_nothing_runs_when_the_kernel_is_missing_and_still_keeps_messages", async () => {
    const f = fixture();
    try {
      f.kernels.unavailable = "Antigravity CLI (agy) is not installed.";
      await f.app.start();
      const health = f.app.board.get("kernel");
      expect(health).toBeDefined();
      expect([health!.state, health!.detail]).toEqual([
        "error",
        "Antigravity CLI (agy) is not installed.",
      ]);
      await expect(f.app.receiveWeb("hello", [])).rejects.toThrow("agy");
      expect(f.kernels.opened).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  test("sends_a_result_once_when_the_worker_replied_directly_and_the_orchestrator_tries_again", async () => {
    const f = await started();
    try {
      const refused: string[] = [];
      f.script(async (turn) => {
        if (turn.role === "worker") {
          const done = await turn.call("orchestrator_report", {
            state: "ready",
            summary: "Wrote the ring buffer.",
            direct_reply: "Done: the ring buffer is in src/lib.rs.",
          });
          expect(done.notification).toBe("direct_outbox");
          return "Finished.";
        }
        for (const msg of messages(turn.text)) {
          // Told of the worker's own reply, the orchestrator still tries to send the result in its words.
          const direct = msg.worker_direct_reply as Record<string, unknown> | undefined;
          const ticketId = typeof direct?.ticket_id === "string" ? direct.ticket_id : undefined;
          if (ticketId !== undefined) {
            expect(direct!.note).toBe(
              "The person already has this reply; send nothing more for it.",
            );
            try {
              await turn.call("orchestrator_reply", {
                ticket_id: ticketId,
                purpose: "result",
                text: "The ring buffer is written; the code is in src/lib.rs.",
              });
              throw new Error("expected orchestrator_reply to fail");
            } catch (error) {
              refused.push(error instanceof Error ? error.message : String(error));
            }
          }
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Write a ringbuffer in Rust", []);
      await f.until("the ticket completed", () => {
        const first = f.tickets()[0];
        return first !== undefined && first.ended !== undefined;
      });
      await f.settle();
      // A later message starts the turn in which the orchestrator reads the notice of the worker's reply.
      await f.app.receiveWeb("Thanks", []);
      await f.until("the paraphrase was tried", () => refused.length > 0);
      await f.settle();
      expect(refused[0]!.startsWith("This ticket's result already went to the person")).toBe(true);
      const said = replies(f);
      expect(said.filter((text) => text.includes("ring buffer")).length).toBe(1);
      expect(said[1]).toBe("Done: the ring buffer is in src/lib.rs.");
    } finally {
      await f.cleanup();
    }
  });

  test("runs_workers_with_their_own_model_on_antigravity", async () => {
    const f = await started();
    try {
      await f.app.updateModels({
        eval: null,
        executor: { provider: "antigravity", model: "gemini-3.8-pro-high" },
      });
      expect(f.app.board.get("kernel")?.detail).toBe("Running on antigravity");
      f.script(async (turn) => {
        if (turn.role === "worker") {
          await turn.call("orchestrator_report", { state: "ready", summary: "Painted." });
          return "Reported.";
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Paint the settings button.", []);
      await f.until("the result is delivered", () => replies(f).length === 2);
      await f.settle();
      const openedOn = f.kernels.openedOn;
      expect(
        openedOn.some(([role, kernel]) => role === "orchestrator" && kernel === "antigravity"),
      ).toBe(true);
      expect(
        openedOn.some(([role, kernel]) => role === "worker" && kernel === "antigravity"),
      ).toBe(true);
      const worker = f.kernels.opened.find((spec) => spec.role === "worker");
      expect(worker).toBeDefined();
      expect(worker!.model?.model).toBe("gemini-3.8-pro-high");
    } finally {
      await f.cleanup();
    }
  });

  test(
    "relays_sidecar_failure_to_orchestrator_after_bounded_retries",
    async () => {
      const f = await started();
      try {
        const failedCards: Record<string, unknown>[] = [];
        f.script(async (turn) => {
          if (turn.role === "worker") {
            await turn.call("orchestrator_report", {
              state: "progress",
              summary: "Running epoch 1.",
              topic: "Training",
            });
            return "Running.";
          }
          if (turn.role === "sidecar") {
            throw new Error("sidecar runtime error");
          }
          for (const msg of messages(turn.text)) {
            if (msg.kind === "candidate" && msg.text === "How is it going?") {
              const related = msg.related_tickets as Record<string, unknown>[];
              await turn.call("orchestrator_route", {
                decisions: [
                  {
                    kind: "sidecar",
                    trigger_id: msg.trigger_id,
                    ticket_id: related[0]!.ticket_id,
                  },
                ],
              });
              return "Done.";
            }
            if (msg.kind === "sidecar_failed") {
              failedCards.push({ ...msg });
              await turn.call("orchestrator_reply", {
                purpose: "answer",
                trigger_id: msg.trigger_id,
                text: "Fallback answer.",
              });
              return "Done.";
            }
          }
          return await orchestrate(turn);
        });

        await f.app.receiveWeb("Train it.", []);
        await f.until("the worker reported progress", () => {
          const first = f.tickets()[0];
          return first !== undefined && latestReport(first) !== undefined;
        });
        await f.settle();
        await f.app.receiveWeb("How is it going?", []);
        // Bounded retries with exponential backoff (2s + 4s) plus orchestrator fallback.
        for (let i = 0; i < 1500; i++) {
          if (replies(f).length === 2 && !f.app.effects.pending(SIDECAR)) {
            break;
          }
          f.app.passes.pump();
          await Bun.sleep(10);
        }
        await f.settle();
        expect(f.ran("sidecar").length).toBe(3);
        expect(f.app.effects.pending(SIDECAR)).toBe(false);
        expect(failedCards.length).toBe(1);
        expect(
          typeof failedCards[0]!.error === "string" &&
            failedCards[0]!.error.includes("sidecar runtime error"),
        ).toBe(true);
        expect(replies(f)).toEqual([ACCEPT, "Fallback answer."]);
      } finally {
        await f.cleanup();
      }
    },
    30_000,
  );

  test(
    "stops_open_and_failed_workers_via_stop_worker_ticket_and_refuses_completed_or_stopped",
    async () => {
      const f = await started();
      try {
        let workerTurn: Turn | null = null;
        let mode: "background" | "fail" | "complete" = "background";
        f.script(async (turn) => {
          if (turn.role === "worker") {
            if (mode === "background") {
              await turn.call("orchestrator_report", {
                state: "progress",
                summary: "Running subagent and shell.",
              });
              turn.jobs.push(Fixture.job("task_1", "task", "subagent slice"));
              turn.jobs.push(Fixture.job("bg_1", "bash", "make train"));
              workerTurn = turn;
              return "Running in background.";
            }
            if (mode === "fail") {
              throw new Error("model error");
            }
            await turn.call("orchestrator_report", { state: "ready", summary: "All done." });
            return "Finished.";
          }
          for (const msg of messages(turn.text)) {
            if (msg.kind === "candidate") {
              await accept(turn, msg);
            } else if (msg.kind === "worker_report" && msg.state === "ready") {
              const ticket = msg.ticket as Record<string, unknown>;
              await turn.call("orchestrator_reply", {
                ticket_id: ticket.ticket_id,
                purpose: "result",
                text: "It is done.",
              });
            }
          }
          return "Done.";
        });

        // 1. Active working ticket with both subagent and background shell job.
        await f.app.receiveWeb("Run subagent and job.", []);
        await f.until("worker turn stored", () => workerTurn !== null);
        await f.settle();
        const workingId = f.ticket(0).id;
        const detailBefore = (await f.app.workerDetail(workingId)) as Record<string, unknown>;
        expect(Array.isArray(detailBefore.background)).toBe(true);
        expect((detailBefore.background as unknown[]).length).toBe(2);
        expect(f.app.activeWorkers()).toBe(1);

        const stopped = (await f.app.stopWorkerTicket(workingId)) as Record<string, unknown>;
        expect(stopped.stage).toEqual({ stage: "ended" });
        expect(stopped.outcome).toBe("stopped");
        expect(stopped.session).toEqual({ loaded: false, streaming: false });
        expect(stopped.background).toEqual([]);
        expect(f.kernels.closed.includes(`worker-${workingId}`)).toBe(true);
        expect(f.app.activeWorkers()).toBe(0);
        await expectStopWorkerError(f.app.stopWorkerTicket(workingId), "already_ended");

        // 2. Failed ticket (`person/failed`) can also be stopped and then refuses a second stop.
        mode = "fail";
        await f.app.receiveWeb("Fail this one.", []);
        await f.until("failed ticket recorded", () =>
          f.tickets().some((ticket) => {
            if (ticket.id === workingId) return false;
            const stage = ticketStage(ticket);
            return stage.kind === "person" && stage.action === "failed";
          }),
        );
        await f.settle();
        const failedId = f.tickets().find((ticket) => ticket.id !== workingId)!.id;
        const stoppedFailed = (await f.app.stopWorkerTicket(failedId)) as Record<string, unknown>;
        expect(stoppedFailed.stage).toEqual({ stage: "ended" });
        expect(stoppedFailed.outcome).toBe("stopped");
        await expectStopWorkerError(f.app.stopWorkerTicket(failedId), "already_ended");

        // 3. Completed ticket refuses stop and unknown ticket returns NotFound.
        mode = "complete";
        await f.app.receiveWeb("Complete this one.", []);
        await f.until("completed ticket recorded", () =>
          f
            .tickets()
            .some(
              (ticket) =>
                ticket.id !== workingId && ticket.id !== failedId && ticket.ended !== undefined,
            ),
        );
        await f.settle();
        const completedId = f
          .tickets()
          .find((ticket) => ticket.id !== workingId && ticket.id !== failedId)!.id;
        await expectStopWorkerError(f.app.stopWorkerTicket(completedId), "already_ended");
        expect(
          f.tickets().find((ticket) => ticket.id === completedId)!.ended!.outcome,
        ).toBe("completed");
        await expectStopWorkerError(f.app.stopWorkerTicket("missing"), "not_found");
      } finally {
        await f.cleanup();
      }
    },
    20_000,
  );

  test(
    "sends_slow_query_hint_once_across_sidecar_retries_and_skips_retry_after_reply_sent",
    async () => {
      expect(slowHintText("在哪里能看到 A股策略ETF 标普和黄金的分配比例？")).toBe(
        SIDECAR_SLOW_HINT_ZH,
      );
      expect(slowHintText("V4F1?")).toBe(SIDECAR_SLOW_HINT_ZH);
      expect(slowHintText("How is the build going?")).toBe(SIDECAR_SLOW_HINT_EN);

      const f = await started({ sidecarSlowHintMs: 60 });
      try {
        let sidecarAttempt = 0;
        const failedCards: Record<string, unknown>[] = [];
        f.script(async (turn) => {
          if (turn.role === "worker") {
            await turn.call("orchestrator_report", {
              state: "progress",
              summary: "Epoch 5 running.",
              topic: "Training",
            });
            return "Running.";
          }
          if (turn.role === "sidecar") {
            sidecarAttempt += 1;
            // Attempt 1 takes longer than slowHintMs (triggers the hint once), then fails before replying.
            if (sidecarAttempt === 1) {
              await Bun.sleep(120);
              throw new Error("transient lookup failure");
            }
            // Attempt 2 also takes longer than slowHintMs (must NOT duplicate the hint), replies, then throws during wrap-up.
            await Bun.sleep(120);
            await turn.call("sidecar_reply", { text: "Epoch 5 is running cleanly." });
            throw new Error("wrap-up timeout after reply");
          }
          for (const msg of messages(turn.text)) {
            if (msg.kind === "candidate" && msg.text === "How is it going?") {
              const related = msg.related_tickets as Record<string, unknown>[];
              await turn.call("orchestrator_route", {
                decisions: [
                  {
                    kind: "sidecar",
                    trigger_id: msg.trigger_id,
                    ticket_id: related[0]!.ticket_id,
                  },
                ],
              });
              return "Done.";
            }
            if (msg.kind === "sidecar_failed") {
              failedCards.push({ ...msg });
              return "Done.";
            }
          }
          return await orchestrate(turn);
        });

        await f.app.receiveWeb("Train it.", []);
        await f.until("worker reported progress", () => {
          const first = f.tickets()[0];
          return first !== undefined && latestReport(first) !== undefined;
        });
        await f.settle();

        await f.app.receiveWeb("How is it going?", []);
        await f.until("sidecar slow hint and final reply delivered", () => {
          return replies(f).length === 3 && !f.app.effects.pending(SIDECAR);
        });
        await f.settle();

        // Hint sent exactly once (in English matching the question), followed by the real answer;
        // attempt 2 throwing after sidecar_reply must NOT trigger attempt 3 or sidecar_failed.
        expect(sidecarAttempt).toBe(2);
        expect(failedCards).toEqual([]);
        expect(replies(f)).toEqual([ACCEPT, SIDECAR_SLOW_HINT_EN, "Epoch 5 is running cleanly."]);
      } finally {
        await f.cleanup();
      }
    },
    20_000,
  );
});
