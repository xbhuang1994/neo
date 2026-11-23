/**
 * What the app shows and changes, over a scripted kernel: the conversation, workers, health, Antigravity model
 * settings and the general settings.
 *
 * Ported faithfully from `neo-app/tests/views.rs`.
 */

import { describe, expect, test } from "bun:test";
import { roleModels, type ChatAttachment, type ModelOption } from "../../src/app/index.ts";
import { VERSION } from "../../src/version.ts";
import { coreModel, Fixture, fixture, modelsReady, started } from "./common.ts";

function option(provider: string, id: string): ModelOption {
  return { id, provider, name: `${provider} ${id}` };
}

async function expectRejectMessage(promise: Promise<unknown>, label: string): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected rejection: ${label}`);
}

describe("views", () => {
  test("shows_the_conversation_the_workers_and_health", async () => {
    const f = await started();
    try {
      expect(f.app.panelMessages()).toEqual([]);
      expect(await f.app.workerCards()).toEqual([]);

      const attachments: ChatAttachment[] = [
        { name: "shot.png", mediaType: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
        { name: "notes.md", mediaType: "", data: new TextEncoder().encode("# Notes") },
        { name: "data.bin", mediaType: "application/zip", data: new Uint8Array([0, 1]) },
      ];
      await f.app.receiveWeb("Please fix the typo in the fixture.", attachments, "web:m1");
      await f.until("the result is in the transcript", () => f.chat().length >= 3);
      await f.settle();

      const msgs = f.app.panelMessages() as Record<string, unknown>[];
      expect(msgs.map((msg) => msg.role)).toEqual(["user", "assistant", "assistant"]);
      expect(
        (msgs[0].text as string).startsWith(
          'Please fix the typo in the fixture.\n\n<attachment name="shot.png"',
        ),
      ).toBe(true);
      expect(msgs[0].images).toEqual([{ name: "shot.png", mediaType: "image/png", data: "iVBORw==" }]);
      expect(msgs[0].files).toEqual([
        { name: "notes.md", mediaType: "text/plain", kind: "text" },
        { name: "data.bin", mediaType: "application/zip", kind: "file" },
      ]);
      expect([msgs[1].text, msgs[2].text]).toEqual([
        "I will fix the fixture typo.",
        "Fixture work completed.",
      ]);
      expect(Object.prototype.hasOwnProperty.call(msgs[1], "images")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(msgs[1], "files")).toBe(false);
      expect(msgs.every((msg) => typeof msg.at === "number" && msg.at > 1_700_000_000_000)).toBe(true);
      expect((msgs[0].id as number) < (msgs[1].id as number)).toBe(true);
      // Nothing the model was told in between shows.
      expect(JSON.stringify(msgs)).not.toContain("candidate");

      const cards = (await f.app.workerCards()) as Record<string, unknown>[];
      expect(cards.length).toBe(1);
      const ticket = f.ticket(0);
      const card = cards[0];
      expect([card.ticketId, card.title, card.outcome]).toEqual([ticket.id, "Fix fixture typo", "completed"]);
      expect(card.stage).toEqual({ stage: "ended" });
      expect(card.session).toEqual({ loaded: false, streaming: false });
      const progress = card.progress as Record<string, unknown>;
      expect([progress.state, progress.summary]).toEqual(["ready", "Fixture change is ready."]);
      const assignment = card.assignment as Record<string, unknown>;
      expect([assignment.state, card.pendingInputs, (card.background as unknown[]).length]).toEqual([
        "ended",
        0,
        0,
      ]);
      expect(card.directory).toBe(ticket.execution!.directory);
      expect(card.attention).toBeNull();
      expect(card.delivery).toBeNull();

      const detail = (await f.app.workerDetail(ticket.id)) as Record<string, unknown> | null;
      expect(detail).not.toBeNull();
      expect(detail!.ticketId).toBe(card.ticketId);
      expect(Array.isArray(detail!.inputs)).toBe(true);
      const recent = detail!.recent as Record<string, unknown>[];
      expect(recent.some((line) => line.role === "assistant" && line.text === "Worker ready.")).toBe(true);
      expect(
        recent.some(
          (line) =>
            line.role === "custom" &&
            typeof line.text === "string" &&
            line.text.includes("Fix fixture typo"),
        ),
      ).toBe(true);
      expect(await f.app.workerDetail("missing")).toBeNull();

      const health = f.app.healthView() as Record<string, unknown>;
      expect([health.ready, health.kernel, health.paused, health.activeWorkers]).toEqual([
        true,
        "antigravity",
        false,
        0,
      ]);
      const components = health.components as Record<string, Record<string, unknown>>;
      expect(components.runtime.state).toBe("ready");
      expect(components.kernel.detail).toBe("Running on antigravity");
      expect(health.version).toBe(VERSION);
      await f.app.stop();
      expect((f.app.healthView() as Record<string, unknown>).ready).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("shows_a_running_worker_with_its_question_and_jobs", async () => {
    const f = await started();
    try {
      f.script(async (turn) => {
        if (turn.role === "worker") {
          turn.jobs.push(Fixture.job("bg_1", "bash", "make train\nsecond line"));
          await turn.call("orchestrator_report", {
            state: "progress",
            summary: "Training.",
            human_action: "Which dataset?",
          });
          return "Waiting.";
        }
        return await coreModel()(turn);
      });

      await f.app.receiveWeb("Train it.", []);
      await f.until("the question is open", () => f.tickets()[0]?.attention !== undefined);
      await f.settle();

      const card = ((await f.app.workerCards()) as Record<string, unknown>[])[0];
      expect(card.stage).toEqual({ stage: "person", action: "answer" });
      expect((card.attention as Record<string, unknown>).question).toBe("Which dataset?");
      expect([(card.session as Record<string, unknown>).loaded, card.outcome === null]).toEqual([true, true]);
      expect((card.progress as Record<string, unknown>).state).toBe("progress");
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("shows_what_is_at_work_for_the_ticker", async () => {
    const f = await started();
    let routerHeld = true;
    let workerHeld = true;
    try {
      expect(await f.app.activityView()).toEqual({ router: false, workers: [] });

      f.script(async (turn) => {
        if (turn.role === "worker") {
          await turn.call("orchestrator_report", {
            state: "progress",
            summary: "Training the model.\nEpoch 1.",
          });
          while (workerHeld) {
            await Bun.sleep(10);
          }
          return await coreModel()(turn);
        }
        while (routerHeld) {
          await Bun.sleep(10);
        }
        return await coreModel()(turn);
      });

      await f.app.receiveWeb("Train it.", []);
      await f.until("the router thinks", async () => {
        const view = (await f.app.activityView()) as Record<string, unknown>;
        return view.router === true;
      });
      routerHeld = false;
      await f.until("the worker says what it does", async () => {
        const view = (await f.app.activityView()) as {
          router: boolean;
          workers: Record<string, unknown>[];
        };
        return (
          Array.isArray(view.workers) &&
          view.workers.length === 1 &&
          view.workers[0].doing === "Training the model."
        );
      });
      const current = (await f.app.activityView()) as {
        router: boolean;
        workers: Record<string, unknown>[];
      };
      expect(current.workers[0].title).toBe("Fix fixture typo");
      workerHeld = false;
      await f.until("nothing is at work", async () => {
        const view = (await f.app.activityView()) as { router: boolean; workers: unknown[] };
        return view.router === false && Array.isArray(view.workers) && view.workers.length === 0;
      });
      expect(await f.app.activityView()).toEqual({ router: false, workers: [] });
      await f.app.stop();
    } finally {
      routerHeld = false;
      workerHeld = false;
      await f.cleanup();
    }
  });

  test("chooses_models_and_installs_antigravity", async () => {
    let f = fixture();
    try {
      f.kernels.models = [
        option("antigravity", "gemini-3.8-flash-low"),
        option("antigravity", "gemini-3.8-pro-high"),
      ];
      await f.app.start();
      let view = await modelsReady(f.app);
      expect([view.kernel, view.installed, view.installing, view.problem === null]).toEqual([
        "antigravity",
        true,
        false,
        true,
      ]);
      expect(view.current).toEqual({ eval: null, executor: null });
      expect((view.available as unknown[])[0]).toEqual({
        id: "gemini-3.8-flash-low",
        provider: "antigravity",
        name: "antigravity gemini-3.8-flash-low",
      });

      // Refusals change nothing.
      const refused = (value: unknown) =>
        expectRejectMessage(f.app.updateModels(value), JSON.stringify(value));
      expect((await refused({ eval: null })).startsWith("executor is required")).toBe(true);
      expect(
        (await refused({ eval: null, executor: null, advisor: null })).startsWith("Unknown field advisor"),
      ).toBe(true);
      expect(
        await refused({
          eval: { provider: "antigravity", model: "gemini-3.8-flash-low", thinkingLevel: "high" },
          executor: null,
        }),
      ).toContain("unknown field");
      expect(Object.keys(f.app.settings().models).length).toBe(0);

      // A choice is saved and reaches the open main Session.
      const chosen = {
        eval: { provider: "antigravity", model: "gemini-3.8-flash-low" },
        executor: { provider: "antigravity", model: "gemini-3.8-pro-high" },
      };
      view = (await f.app.updateModels(chosen)) as Record<string, unknown>;
      expect(view.current).toEqual(chosen);
      expect(f.kernels.setModels[f.kernels.setModels.length - 1]).toEqual([
        f.app.masterId,
        "gemini-3.8-flash-low",
        undefined,
      ]);
      expect(roleModels(f.app.settings()).executor?.model).toBe("gemini-3.8-pro-high");

      // Missing Antigravity reports its problem and can be installed.
      f.kernels.unavailable = "Antigravity CLI (agy) is not installed.";
      view = (await f.app.modelsView()) as Record<string, unknown>;
      expect([view.problem, view.installed, (view.available as unknown[]).length]).toEqual([
        "Antigravity CLI (agy) is not installed.",
        false,
        0,
      ]);
      expect(
        await expectRejectMessage(f.app.installKernel({ kernel: "other" }), "installKernel other"),
      ).toBe("kernel must be antigravity");
      view = (await f.app.installKernel({ kernel: "antigravity" })) as Record<string, unknown>;
      expect([view.kernel, view.installed, view.problem === null]).toEqual(["antigravity", true, true]);
      expect(f.kernels.installed).toEqual(["antigravity"]);
      // Already installed does not install again.
      await f.app.installKernel({});
      expect(f.kernels.installed.length).toBe(1);

      // The choices outlive a restart.
      f = await f.restart();
      expect(((await f.app.modelsView()) as Record<string, unknown>).current).toEqual(chosen);
      expect(f.kernels.opened[f.kernels.opened.length - 1]?.model?.model).toBe("gemini-3.8-flash-low");
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });

  test("changes_general_settings_block_by_block", async () => {
    let f = await started();
    try {
      let view = f.app.generalView() as Record<string, unknown>;
      expect([
        view.paused,
        (view.eval as Record<string, unknown>).mode,
        (view.executor as Record<string, unknown>).maxWorkers,
      ]).toEqual([false, "observe", 3]);
      expect((view.limits as Record<string, unknown>).maxWorkers).toEqual([1, 16]);
      expect((view.defaults as Record<string, unknown>).directory).toBe(f.dir.join("state/work"));
      const sources = (view.policy as Record<string, unknown>).sources as Record<
        string,
        Record<string, unknown>
      >;
      expect((sources.chat.allowed as Record<string, unknown>[])[0].id).toBe("web:local");
      expect(Object.prototype.hasOwnProperty.call(view, "models")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(view, "kernel")).toBe(false);

      // One block replaces that block and leaves the others.
      let opened = f.kernels.opened.length;
      view = (await f.app.updateGeneral({
        executor: { maxWorkers: 5, blockedCommands: ["sudo", "shutdown"] },
      })) as Record<string, unknown>;
      expect([
        (view.executor as Record<string, unknown>).maxWorkers,
        (view.executor as Record<string, unknown>).blockedCommands,
      ]).toEqual([5, ["sudo", "shutdown"]]);
      expect((view.eval as Record<string, unknown>).mode).toBe("observe");
      expect(f.app.settings().executor.maxWorkers).toBe(5);
      // The main Session reads the environment from its prompt, so it was composed anew.
      expect(f.kernels.opened.length).toBe(opened + 1);
      expect(f.kernels.opened[f.kernels.opened.length - 1].systemPrompt).toContain("sudo shutdown");

      const rules = [
        {
          id: "docs",
          name: "Docs",
          enabled: true,
          instruction: "Fix documentation typos when asked.",
        },
      ];
      view = (await f.app.updateGeneral({
        policy: { rules, sources: (view.policy as Record<string, unknown>).sources },
        eval: { mode: "auto", timeoutSeconds: 60 },
      })) as Record<string, unknown>;
      expect([
        (view.policy as Record<string, unknown>).rules,
        (view.eval as Record<string, unknown>).mode,
        (view.eval as Record<string, unknown>).timeoutSeconds,
      ]).toEqual([rules, "auto", 60]);
      expect(f.kernels.opened[f.kernels.opened.length - 1].systemPrompt).toContain(
        "Fix documentation typos when asked.",
      );
      expect(f.app.settings().executor.maxWorkers).toBe(5);

      // Refusals say why and change nothing.
      const refused = (value: unknown) =>
        expectRejectMessage(f.app.updateGeneral(value), JSON.stringify(value));
      expect(await refused({ executor: { maxWorkers: 99 } })).toContain("1 to 16");
      expect((await refused({ kernel: "antigravity" })).startsWith("Unknown field kernel")).toBe(true);
      expect(await refused({ executor: { workers: 2 } })).toContain("unknown field");
      expect(await refused({})).toBe("Send at least one of paused, eval, executor, policy");
      expect(await refused("paused")).toBe("Expected a JSON object");
      expect(f.app.settings().executor.maxWorkers).toBe(5);

      // The pause holds work, and lifting it lets it go on.
      opened = f.kernels.opened.length;
      expect(((await f.app.updateGeneral({ paused: true })) as Record<string, unknown>).paused).toBe(true);
      expect(f.kernels.opened.length).toBe(opened);
      await f.app.receiveWeb("Please fix the typo in the fixture.", []);
      await Bun.sleep(150);
      expect(f.tickets().length).toBe(0);
      expect((f.app.healthView() as Record<string, unknown>).paused).toBe(true);
      await f.app.updateGeneral({ paused: false });
      await f.until("the work is done", () => f.chat().length >= 3);
      await f.settle();
      expect(f.tickets().length).toBe(1);

      // What was saved is there after a restart.
      f = await f.restart();
      view = f.app.generalView() as Record<string, unknown>;
      expect([
        (view.executor as Record<string, unknown>).maxWorkers,
        (view.eval as Record<string, unknown>).mode,
        ((view.policy as Record<string, unknown>).rules as Record<string, unknown>[])[0].id,
      ]).toEqual([5, "auto", "docs"]);
      await f.app.stop();
    } finally {
      await f.cleanup();
    }
  });
});
