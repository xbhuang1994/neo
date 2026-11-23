/**
 * The Watchdog over a scripted kernel: it stays silent while all is well, puts back what the queues lost, reminds the
 * main Session of a missing reply, and asks its own one-off Session about stalled, stranded and failed tickets.
 *
 * Ported faithfully from `neo-app/tests/watchdog.rs`.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cloneSettings, Health, LAUNCH } from "../../src/app/index.ts";
import { latestAssignment, latestReport } from "../../src/core/index.ts";
import { Fixture, message, messages, started, type Turn } from "./common.ts";

/** Accept every candidate as new work and send every ready result. */
async function orchestrate(turn: Turn): Promise<string> {
  for (const msg of messages(turn.text)) {
    if (msg.kind === "candidate") {
      await turn.call("orchestrator_route", {
        decisions: [
          {
            kind: "accept",
            trigger_id: msg.trigger_id,
            title: "Train the model",
            worktree_name: "train-model",
            acknowledgement: "On it.",
          },
        ],
      });
    } else if (msg.kind === "worker_report" && msg.state === "ready") {
      const ticketObj = msg.ticket as Record<string, unknown>;
      await turn.call("orchestrator_reply", {
        ticket_id: ticketObj.ticket_id,
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

/** The patrols the Watchdog Session was given. */
function patrols(f: Fixture): Record<string, unknown>[] {
  return f.ran("watchdog").map((ran) => message(ran.text, "watchdog_patrol"));
}

async function expectRejectMessage(promise: Promise<unknown>, label: string): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected rejection: ${label}`);
}

describe("watchdog", () => {
  test("asks_no_model_while_all_is_well_and_reports_a_failing_component_once", async () => {
    const f = await started();
    try {
      expect(f.app.board.get("watchdog")?.detail).toBe("Watchdog control loop is ready");
      await f.app.receiveWeb("Please fix the typo in the fixture.", []);
      await f.until("the result is in the transcript", () => f.chat().length >= 3);
      await f.settle();
      await f.app.watchdogTick();
      await f.settle();
      expect(patrols(f)).toEqual([]);
      const wdHealth = f.app.board.get("watchdog");
      expect([wdHealth?.state, wdHealth?.detail]).toEqual(["ready", "All active tickets and queues are healthy"]);
      expect(f.ran("orchestrator").length).toBe(2);

      // A component that fails is shown to the Watchdog Session once, with its own prompt and tools.
      f.app.board.set("wechat", Health.error("Polling failed: timeout"));
      await f.app.watchdogTick();
      await f.app.watchdogTick();
      const seen = patrols(f);
      expect(seen.length).toBe(1);
      expect(seen[0].suspects).toEqual([]);
      const healthErrors = seen[0].health_errors as Record<string, unknown>[];
      expect([healthErrors[0]?.component, healthErrors[0]?.detail]).toEqual(["wechat", "Polling failed: timeout"]);
      const spec = f.kernels.opened.find((entry) => entry.role === "watchdog");
      expect(spec).toBeDefined();
      expect(spec!.systemPrompt.startsWith("You are the Watchdog of neo-agent")).toBe(true);
      expect(spec!.systemPrompt.includes("NEO_AGENT_BLOCKED_COMMANDS")).toBe(true);
      expect(f.app.board.get("watchdog")?.detail).toBe("All active tickets and queues are healthy");

      // Nothing runs while paused.
      f.app.board.set("wechat", Health.error("Polling failed again"));
      const settings = cloneSettings(f.app.settings());
      settings.paused = true;
      f.app.saveSettings(settings, "app", "pause");
      await f.app.watchdogTick();
      expect(patrols(f).length).toBe(1);
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("wakes_a_worker_that_sits_idle_with_its_work_finished", async () => {
    const f = await started();
    try {
      let tools: string[] = [];
      let inspected: Record<string, unknown> | null = null;
      f.script(async (turn) => {
        if (turn.role === "worker" && turn.has("[Watchdog]")) {
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: "Training finished; results are in results.log.",
          });
          return "Reported.";
        }
        if (turn.role === "worker") {
          fs.writeFileSync(path.join(turn.cwd, "results.log"), "epoch 1\nepoch 2\nEXIT 0\n");
          return "I started the training detached; it writes results.log.";
        }
        if (turn.role === "watchdog") {
          tools = turn.toolNames();
          const patrol = turn.card("kind");
          if (!patrol) throw new Error("the patrol");
          const suspects = patrol.suspects as Record<string, unknown>[];
          const ticketId = suspects[0].ticket_id;
          inspected = await turn.call("watchdog_inspect", { ticket_id: ticketId });
          const woken = await turn.call("watchdog_intervene", {
            action: "wake_worker",
            ticket_id: ticketId,
            message: "results.log ends with EXIT 0: verify and report.",
          });
          expect(woken.woken).toBe(true);
          return "Woke the worker: the detached run finished.";
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Train it.", []);
      await f.until("the worker went idle", () => {
        const first = f.tickets()[0];
        return first !== undefined && latestReport(first)?.state === "waiting";
      });
      await f.settle();
      await f.app.watchdogTick();
      await f.until("the worker reported", () => f.tickets()[0]?.ended !== undefined);
      await f.settle();

      const ticket = f.ticket(0);
      const seen = patrols(f);
      expect(seen.length).toBe(1);
      const suspect = (seen[0].suspects as Record<string, unknown>[])[0];
      expect([suspect.kind, suspect.ticket_id, suspect.title, suspect.state]).toEqual([
        "idle_without_followup",
        ticket.id,
        "Train the model",
        "idle",
      ]);
      expect(suspect.directory).toBe(ticket.execution!.directory);
      expect(suspect.running_jobs).toEqual([]);
      expect((suspect.activity_delta as Record<string, unknown>).output_changed).toBe(false);
      expect((suspect.recent_files as Record<string, unknown>[])[0].path).toBe("results.log");
      expect(suspect.latest_log_tail).toEqual({ file: "results.log", tail: "epoch 1\nepoch 2\nEXIT 0" });
      expect((suspect.latest_report as Record<string, unknown>).state).toBe("waiting");
      const recentTranscript = suspect.recent_transcript as Record<string, unknown>[];
      expect(Array.isArray(recentTranscript)).toBe(true);
      expect(
        recentTranscript.some(
          (line) =>
            line.role === "assistant" &&
            line.text === "I started the training detached; it writes results.log.",
        ),
      ).toBe(true);
      expect(typeof suspect.elapsed_seconds).toBe("number");
      expect(Object.prototype.hasOwnProperty.call(suspect, "previous_patrol_note")).toBe(false);
      expect(tools).toEqual(["watchdog_inspect", "watchdog_intervene"]);

      expect(inspected).not.toBeNull();
      const inspection = inspected!;
      expect([
        (inspection.ticket as Record<string, unknown>).ticket_id,
        (inspection.session as Record<string, unknown>).loaded,
      ]).toEqual([ticket.id, true]);
      expect((inspection.assignments as unknown[]).length).toBe(1);
      expect(Array.isArray(inspection.inputs)).toBe(true);
      expect((inspection.recent_transcript as unknown[]).length).toBeGreaterThan(0);

      // The worker was told what the Watchdog found, and the result went out.
      expect(f.ran("worker")[1].text).toContain("[Watchdog] results.log ends with EXIT 0: verify and report.");
      expect(ticket.ended?.outcome).toBe("completed");
      expect(replies(f)).toEqual(["On it.", "It is done."]);
      expect(f.app.board.get("watchdog")?.detail).toBe("Inspected 1 suspect ticket(s)");

      // Refusals, in words.
      const refuse = (argumentsValue: unknown) =>
        expectRejectMessage(f.app.watchdogIntervene(argumentsValue), JSON.stringify(argumentsValue));

      expect(await refuse({ action: "wake_worker", ticket_id: "missing", message: "x" })).toBe(
        "Unknown ticket: missing",
      );
      expect(await refuse({ action: "cancel_job", ticket_id: ticket.id, message: "x" })).toBe(
        "cancel_job requires job_id",
      );
      expect(await refuse({ action: "restart", ticket_id: ticket.id, message: "x" })).toBe(
        "action is wake_worker, cancel_job, interrupt_worker, retry_ticket or relay_report",
      );
      expect(
        (await refuse({ action: "wake_worker", ticket_id: ticket.id, message: "x", force: true })).startsWith(
          "Unknown argument force",
        ),
      ).toBe(true);
      expect(await refuse({ action: "wake_worker", ticket_id: ticket.id })).toBe("message is required");
      expect(
        (
          (await f.app.watchdogIntervene({
            action: "wake_worker",
            ticket_id: ticket.id,
            message: "x",
          })) as Record<string, unknown>
        ).woken,
      ).toBe(false);
      expect(
        (
          (await f.app.watchdogIntervene({
            action: "retry_ticket",
            ticket_id: ticket.id,
            message: "x",
          })) as Record<string, unknown>
        ).reason,
      ).toBe("Ticket is not retryable");
      expect(await expectRejectMessage(f.app.watchdogInspect("missing"), "watchdogInspect missing")).toBe(
        "Unknown ticket: missing",
      );
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("cancels_a_background_job_that_stalled_and_tells_its_worker", async () => {
    const f = await started();
    try {
      f.script(async (turn) => {
        if (turn.role === "worker" && turn.has("[Watchdog]")) {
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: "Reran it in the foreground.",
          });
          return "Finished.";
        }
        if (turn.role === "worker") {
          const job = Fixture.job("bg_7", "bash", "python train.py");
          job.progress = "epoch 3/10";
          turn.jobs.push(job);
          return "Training runs in the background.";
        }
        if (turn.role === "watchdog") {
          const patrol = turn.card("kind");
          if (!patrol) throw new Error("the patrol");
          const suspect = (patrol.suspects as Record<string, unknown>[])[0];
          const runningJobs = suspect.running_jobs as Record<string, unknown>[];
          const cancelled = await turn.call("watchdog_intervene", {
            action: "cancel_job",
            ticket_id: suspect.ticket_id,
            job_id: runningJobs[0].id,
            message: "No output and no CPU time for 20 minutes.",
          });
          expect(cancelled.cancelled).toBe(true);
          return "Cancelled the hung job.";
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Train it.", []);
      await f.until("the job is running", () => f.ran("worker").length > 0);
      await f.settle();
      expect(f.app.activeWorkers()).toBe(1);
      await f.app.watchdogTick();
      await f.until("the worker finished", () => f.tickets()[0]?.ended !== undefined);
      await f.settle();

      const seen = patrols(f);
      expect(seen.length).toBe(1);
      const suspect = (seen[0].suspects as Record<string, unknown>[])[0];
      expect([suspect.kind, suspect.state]).toEqual(["long_running_worker", "working"]);
      const runningJob = (suspect.running_jobs as Record<string, unknown>[])[0];
      expect([runningJob.id, runningJob.command, runningJob.progress]).toEqual([
        "bg_7",
        "python train.py",
        "epoch 3/10",
      ]);
      const delta = suspect.activity_delta as Record<string, unknown>;
      expect([delta.output_changed, delta.cpu_ticks_delta]).toEqual([false, 0]);
      expect(
        f.ran("worker")[1].text.startsWith(
          "[Watchdog] Stopped background job bg_7 (python train.py): No output and no CPU time for 20 minutes.",
        ),
      ).toBe(true);
      expect(replies(f)).toEqual(["On it.", "It is done."]);
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("retries_a_ticket_that_failed_in_passing_twice_at_most", async () => {
    const f = await started();
    try {
      let attempts = 0;
      f.script(async (turn) => {
        if (turn.role === "worker") {
          attempts += 1;
          throw new Error(`529 overloaded (attempt ${attempts})`);
        }
        if (turn.role === "watchdog") {
          const patrol = turn.card("kind");
          if (!patrol) throw new Error("the patrol");
          const suspect = (patrol.suspects as Record<string, unknown>[])[0];
          expect(suspect.kind).toBe("delivery_or_transient_failure");
          const retried = await turn.call("watchdog_intervene", {
            action: "retry_ticket",
            ticket_id: suspect.ticket_id,
            message: "The model was overloaded; try again.",
          });
          return `Retried: ${String(retried.retried)}`;
        }
        return await orchestrate(turn);
      });

      const failed = (attempt: number): boolean => {
        const first = f.tickets()[0];
        return first !== undefined && latestReport(first)?.summary === `529 overloaded (attempt ${attempt})`;
      };

      await f.app.receiveWeb("Train it.", []);
      for (let attempt = 1; attempt <= 3; attempt++) {
        await f.until("the failure is recorded", () => failed(attempt));
        await f.settle();
        await f.app.watchdogTick();
        await f.settle();
      }
      await f.app.watchdogTick();
      await f.settle();

      // Two retries, then the failure stays for a person: the third failure is not even inspected.
      const ticket = f.ticket(0);
      expect(f.ran("worker").length).toBe(3);
      expect(patrols(f).length).toBe(2);
      const firstSuspect = (patrols(f)[0].suspects as Record<string, unknown>[])[0];
      expect((firstSuspect.latest_report as Record<string, unknown>).preview).toBe("529 overloaded (attempt 1)");
      expect(ticket.assignments.map((assignment) => assignment.state)).toEqual(["ended", "ended", "running"]);
      expect(
        await f.app.watchdogIntervene({
          action: "retry_ticket",
          ticket_id: ticket.id,
          message: "again",
        }),
      ).toEqual({
        action: "retry_ticket",
        ticket_id: ticket.id,
        retried: false,
        reason: "Auto-retry limit reached",
      });
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("reminds_the_main_session_of_a_result_nobody_was_sent_and_then_asks_about_it", async () => {
    const f = await started();
    try {
      let answer = false;
      f.script(async (turn) => {
        if (turn.role === "worker") {
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: "Trained to 93%.",
          });
          return "Finished.";
        }
        if (turn.role === "watchdog") {
          const patrol = turn.card("kind");
          if (!patrol) throw new Error("the patrol");
          const suspect = (patrol.suspects as Record<string, unknown>[])[0];
          const relayed = await turn.call("watchdog_intervene", {
            action: "relay_report",
            ticket_id: suspect.ticket_id,
            message: "The result was never sent.",
          });
          expect(relayed.relayed).toBe(true);
          return "Relayed the report again.";
        }
        // An orchestrator that forgets to send results until it is allowed to.
        if (!answer) {
          for (const msg of messages(turn.text)) {
            if (msg.kind === "candidate") {
              return await orchestrate(turn);
            }
          }
          return "Noted.";
        }
        return await orchestrate(turn);
      });

      const reports = (): number =>
        f
          .ran("orchestrator")
          .filter((ran) => messages(ran.text).some((msg) => msg.kind === "worker_report" && msg.state === "ready"))
          .length;

      await f.app.receiveWeb("Train it.", []);
      await f.until("the ticket completed", () => f.tickets()[0]?.ended !== undefined);
      await f.settle();
      expect([reports(), replies(f)]).toEqual([1, ["On it."]]);

      // Two reminders by itself, one per pass, each a new request to the main Session.
      for (const sent of [2, 3]) {
        await f.app.watchdogTick();
        await f.until("the reminder arrived", () => reports() === sent);
        await f.settle();
      }
      expect(patrols(f)).toEqual([]);

      // Still unanswered: now the Watchdog Session is asked, and relays it once more; this time it is sent.
      answer = true;
      await f.app.watchdogTick();
      await f.until("the result went out", () => replies(f).length === 2);
      await f.settle();

      const seen = patrols(f);
      expect(seen.length).toBe(1);
      const suspect = (seen[0].suspects as Record<string, unknown>[])[0];
      expect([suspect.kind, suspect.state]).toEqual(["unreplied_ticket", "completed"]);
      expect([reports(), replies(f)]).toEqual([4, ["On it.", "It is done."]]);

      // Answered: nothing more is owed.
      await f.app.watchdogTick();
      await f.settle();
      expect([reports(), patrols(f).length]).toEqual([4, 1]);
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("queues_a_lost_launch_again", async () => {
    const f = await started();
    try {
      const settings = cloneSettings(f.app.settings());
      settings.executor.maxWorkers = 1;
      f.app.saveSettings(settings, "app", "executor");

      f.script(async (turn) => {
        if (turn.role === "worker" && (turn.has("[Watchdog]") || turn.has("second"))) {
          await turn.call("orchestrator_report", { state: "ready", summary: "Done." });
          return "Finished.";
        }
        if (turn.role === "worker") {
          turn.jobs.push(Fixture.job("bg_1", "bash", "make first"));
          return "Running in the background.";
        }
        // The Watchdog looks at the first ticket's job and leaves it alone.
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("The first job.", []);
      await f.until(
        "the first worker holds the only slot",
        () => f.app.activeWorkers() === 1 && f.ran("worker").length > 0,
      );
      await f.settle();

      await f.app.receiveWeb("The second job.", []);
      await f.until("the second ticket waits", () => f.tickets().length === 2);
      await f.settle();

      const waiting = f.ticket(1);
      const assignment = latestAssignment(waiting)!;
      expect(assignment.state).toBe("pending");
      expect(f.app.effects.pending(LAUNCH, assignment.id)).toBe(true);

      // The launch is lost, as after a crash between the two writes.
      f.app.effects.cancel(LAUNCH, assignment.id);
      expect(f.app.effects.pending(LAUNCH, assignment.id)).toBe(false);
      await f.app.watchdogTick();
      expect(f.app.effects.pending(LAUNCH, assignment.id)).toBe(true);
      expect(patrols(f).length).toBe(1);

      // Once the slot is free, the second ticket runs.
      const first = f.ticket(0);
      expect(await f.app.cancelJob(first.id, "bg_1", "Not needed.")).toBe(true);
      await f.until("both finished", () => f.tickets().every((ticket) => ticket.ended !== undefined));
      await f.settle();
      expect(f.ran("worker").length).toBe(3);
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("gives_way_to_a_shutdown_in_the_middle_of_an_inspection", async () => {
    const f = await started();
    try {
      f.script(async (turn) => {
        if (turn.role === "watchdog") {
          // An inspection that would take until its time limit.
          return await new Promise<string>(() => {});
        }
        return "Done.";
      });

      f.app.board.set("wechat", Health.error("Polling failed"));
      const pass = f.app.watchdogTick();
      await f.until("the inspection runs", () => f.ran("watchdog").length > 0);
      const began = performance.now();
      await f.app.stop();
      await pass;
      const elapsedMs = performance.now() - began;
      expect(elapsedMs).toBeLessThan(5_000);
      // A shutdown is no failure of the Watchdog.
      expect(f.app.board.get("watchdog")?.state).not.toBe("error");
      await f.app.watchdogTick();
      expect(f.ran("watchdog").length).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  test("interrupts_a_stalled_worker_turn_and_resumes_it", async () => {
    const f = await started();
    try {
      f.script(async (turn) => {
        if (turn.role === "worker" && turn.has("[Watchdog]")) {
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: "Recovered after Watchdog interrupt.",
          });
          return "Finished.";
        }
        if (turn.role === "worker") {
          // Hung mid-turn with no running_jobs (e.g. dead API stream or stuck synchronous command).
          return await new Promise<string>(() => {});
        }
        if (turn.role === "watchdog") {
          const patrol = turn.card("kind");
          if (!patrol) throw new Error("the patrol");
          const suspect = (patrol.suspects as Record<string, unknown>[])[0];
          expect(suspect.kind).toBe("long_running_worker");
          expect((suspect.session as Record<string, unknown>).streaming).toBe(true);
          const res = await turn.call("watchdog_intervene", {
            action: "interrupt_worker",
            ticket_id: suspect.ticket_id,
            message: "Turn stalled with zero progress.",
          });
          expect(res.interrupted).toBe(true);
          return "Interrupted the stalled worker.";
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Run the stalled task.", []);
      await f.until("the worker hung mid-turn", () => f.ran("worker").length === 1);
      await f.app.watchdogTick();
      await f.until("the resumed worker finished", () => f.tickets()[0]?.ended !== undefined);
      await f.settle();

      const workerRuns = f.ran("worker");
      expect(workerRuns.length).toBe(2);
      expect(
        workerRuns[1].text.startsWith("[Watchdog] Interrupted stalled turn: Turn stalled with zero progress."),
      ).toBe(true);
      expect(workerRuns[1].resumed).toBeDefined();
      expect(replies(f)).toEqual(["On it.", "It is done."]);

      // Audit history was persisted in SQLite kv.
      const history = f.app.store.get<Record<string, unknown>[]>("watchdog-history");
      expect(history).toBeDefined();
      expect(
        history!.some(
          (ev) =>
            ev.kind === "intervene" &&
            typeof ev.detail === "string" &&
            ev.detail.includes("interrupt_worker interrupted=true"),
        ),
      ).toBe(true);
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("falls_back_to_interrupting_session_when_driver_cannot_cancel_single_job", async () => {
    const f = await started();
    try {
      f.kernels.refuseCancel = true;
      f.script(async (turn) => {
        if (turn.role === "worker" && turn.has("[Watchdog]")) {
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: "Recovered from non-cancellable Antigravity job.",
          });
          return "Finished.";
        }
        if (turn.role === "worker") {
          turn.jobs.push(Fixture.job("conv-1/task-9", "bash", "python hang.py"));
          return "Waiting on background job.";
        }
        if (turn.role === "watchdog") {
          const patrol = turn.card("kind");
          if (!patrol) throw new Error("the patrol");
          const suspect = (patrol.suspects as Record<string, unknown>[])[0];
          const res = await turn.call("watchdog_intervene", {
            action: "cancel_job",
            ticket_id: suspect.ticket_id,
            job_id: "conv-1/task-9",
            message: "Job hung with zero CPU.",
          });
          expect(res.cancelled).toBe(true);
          return "Interrupted session to cancel non-cancellable job.";
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Run hanging job.", []);
      await f.until("the job is running", () => f.ran("worker").length === 1);
      await f.settle();
      await f.app.watchdogTick();
      await f.until("the worker finished", () => f.tickets()[0]?.ended !== undefined);
      await f.settle();

      const woken = f.ran("worker")[1].text;
      expect(
        woken.startsWith(
          "[Watchdog] Interrupted stalled session to stop background job conv-1/task-9 (python hang.py): Job hung with zero CPU.",
        ),
      ).toBe(true);
      expect(replies(f)).toEqual(["On it.", "It is done."]);
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("retries_patrolling_a_failed_ticket_after_a_transient_watchdog_error", async () => {
    const f = await started();
    try {
      let workerCalls = 0;
      let watchdogCalls = 0;
      f.script(async (turn) => {
        if (turn.role === "worker") {
          if (workerCalls++ === 0) {
            throw new Error("API error: EOF");
          }
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: "Succeeded on retry.",
          });
          return "Done.";
        }
        if (turn.role === "watchdog") {
          if (watchdogCalls++ === 0) {
            // First patrol itself fails transiently (same outage as the worker).
            throw new Error("Watchdog upstream timeout");
          }
          const patrol = turn.card("kind");
          if (!patrol) throw new Error("the patrol");
          const suspect = (patrol.suspects as Record<string, unknown>[])[0];
          expect(suspect.kind).toBe("delivery_or_transient_failure");
          const retried = await turn.call("watchdog_intervene", {
            action: "retry_ticket",
            ticket_id: suspect.ticket_id,
            message: "Transient EOF.",
          });
          expect(retried.retried).toBe(true);
          return "Retried.";
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Do work.", []);
      await f.until("worker failed once", () => {
        const first = f.tickets()[0];
        return first !== undefined && latestReport(first)?.state === "failed";
      });
      await f.settle();

      // Tick 1: Watchdog patrol errors out; failure_seen must NOT be permanently committed.
      await f.app.watchdogTick();
      expect(f.app.board.get("watchdog")?.state).toBe("error");
      expect(f.ran("worker").length).toBe(1);

      // Tick 2: Watchdog retries the patrol and recovers the failed ticket!
      await f.app.watchdogTick();
      await f.until("worker recovered and completed", () => f.tickets()[0]?.ended !== undefined);
      await f.settle();
      expect(f.ran("worker").length).toBe(2);
      expect(f.ran("watchdog").length).toBe(2);
      expect(replies(f)).toEqual(["On it.", "It is done."]);
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("never_relays_progress_for_stale_answers_and_caps_manual_relay_escalations", async () => {
    const f = await started();
    try {
      // Main session never sends the final result, so we can verify manual escalation caps cleanly.
      f.script(async (turn) => {
        if (turn.role === "worker") {
          await turn.call("orchestrator_report", { state: "ready", summary: "Result ready." });
          return "Done.";
        }
        if (turn.role === "watchdog") {
          const patrol = turn.card("kind");
          if (!patrol) throw new Error("the patrol");
          const tid = (patrol.suspects as Record<string, unknown>[])[0].ticket_id;
          await turn.call("watchdog_intervene", {
            action: "relay_report",
            ticket_id: tid,
            message: "Still missing.",
          });
          return "Relayed.";
        }
        for (const msg of messages(turn.text)) {
          if (msg.kind === "candidate") {
            await turn.call("orchestrator_route", {
              decisions: [
                {
                  kind: "accept",
                  trigger_id: msg.trigger_id,
                  title: "Task",
                  worktree_name: "task-one",
                  acknowledgement: "On it.",
                },
              ],
            });
          }
        }
        return "Ignored.";
      });

      await f.app.receiveWeb("Do task.", []);
      await f.until("ticket completed", () => f.tickets()[0]?.ended !== undefined);
      await f.settle();

      // 2 auto nudges + at most 2 manual Watchdog LLM escalations, then silence (not infinite 24h spam!).
      for (let i = 0; i < 8; i++) {
        await f.app.watchdogTick();
        await f.settle();
      }
      expect(patrols(f).length).toBe(2);
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("ignores_progress_report_with_stale_answers_and_caps_auto_interrupts", async () => {
    const f = await started();
    try {
      f.script(async (turn) => {
        if (turn.role === "worker") {
          turn.jobs.push(Fixture.job("bg_1", "bash", "sleep 30"));
          await turn.call("orchestrator_report", {
            state: "progress",
            summary: "Still working on phase 2.",
          });
          return "Working.";
        }
        if (turn.role === "watchdog") {
          return "Healthy.";
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("Start phase 2.", []);
      await f.until("progress report saved", () => {
        const first = f.tickets()[0];
        return first !== undefined && latestReport(first)?.state === "progress";
      });
      await f.settle();

      // Simulate a stale trigger id left behind in ticket.answers while a Progress report is active.
      const ticket = f.ticket(0);
      ticket.answers = [...(ticket.answers ?? []), ticket.origin.triggerId];
      f.app.store.saveTicket(ticket);

      const mainBefore = f.ran("orchestrator").length;
      for (let i = 0; i < 3; i++) {
        await f.app.watchdogTick();
        await f.settle();
      }
      expect(f.ran("orchestrator").length).toBe(mainBefore);

      // Verify auto-interrupt limit caps at 2 per ticket.
      const tid = ticket.id;
      const first = (await f.app.watchdogIntervene({
        action: "interrupt_worker",
        ticket_id: tid,
        message: "hang 1",
      })) as Record<string, unknown>;
      expect(first.interrupted).toBe(true);
      await f.until("second worker turn started", () => f.ran("worker").length >= 2);
      const second = (await f.app.watchdogIntervene({
        action: "interrupt_worker",
        ticket_id: tid,
        message: "hang 2",
      })) as Record<string, unknown>;
      expect(second.interrupted).toBe(true);
      await f.until("third worker turn started", () => f.ran("worker").length >= 3);
      expect(
        await f.app.watchdogIntervene({
          action: "interrupt_worker",
          ticket_id: tid,
          message: "hang 3",
        }),
      ).toEqual({
        action: "interrupt_worker",
        ticket_id: tid,
        interrupted: false,
        reason: "Auto-interrupt limit reached",
      });
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("heals_lost_launch_even_when_watchdog_kernel_is_unavailable", async () => {
    const f = await started();
    try {
      const settings = cloneSettings(f.app.settings());
      settings.executor.maxWorkers = 1;
      f.app.saveSettings(settings, "app", "executor");
      f.script(async (turn) => {
        if (turn.role === "worker") {
          turn.jobs.push(Fixture.job("bg_1", "bash", "sleep 10"));
          return "Working.";
        }
        return await orchestrate(turn);
      });

      await f.app.receiveWeb("First.", []);
      await f.until("first holds slot", () => f.app.activeWorkers() === 1 && f.ran("worker").length > 0);
      await f.settle();
      await f.app.receiveWeb("Second.", []);
      await f.until("second waits", () => f.tickets().length === 2);
      await f.settle();

      const assignment = latestAssignment(f.ticket(1))!;
      f.app.effects.cancel(LAUNCH, assignment.id);
      expect(f.app.effects.pending(LAUNCH, assignment.id)).toBe(false);
      // Even if the LLM kernel is temporarily unavailable, zero-model queue healing must still run!
      f.kernels.unavailable = "CLI missing";
      await f.app.watchdogTick();
      expect(f.app.effects.pending(LAUNCH, assignment.id)).toBe(true);
      expect(patrols(f)).toEqual([]);
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });
});
