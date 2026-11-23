/**
 * Test support: the application over a scripted kernel, whose "model" is a closure the test writes.
 * The Sessions, journals, effect queue, Engine and store are the real ones; only the runtime process is replaced.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  App,
  BaseKernels,
  clip,
  Protocol,
  type Kernels,
  type ModelOption,
  type SessionRole,
  type SessionSpec,
  type WatchdogTimings,
} from "../../src/app/index.ts";
import type { Kernel } from "../../src/app/settings.ts";
import { nowMs, type Ticket } from "../../src/core/index.ts";
import {
  entrySource,
  textBlock,
  textOf,
  UnboundedChannel,
  type Block,
  type Deliver,
  type Driver,
  type DriverEvent,
  type JobKind,
  type KernelJob,
  type ToolHost,
} from "../../src/kernel/index.ts";
import { TempDir } from "../../src/testkit/index.ts";

/** What the scripted model is given for one turn. */
export class Turn {
  readonly role: SessionRole;
  readonly sessionId: string;
  readonly cwd: string;
  /** The user message of this turn. */
  readonly text: string;
  readonly tools: ToolHost;
  /** Lets the turn leave a background job running after it ends. */
  readonly jobs: KernelJob[];

  constructor(
    role: SessionRole,
    sessionId: string,
    cwd: string,
    text: string,
    tools: ToolHost,
    jobs: KernelJob[],
  ) {
    this.role = role;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.text = text;
    this.tools = tools;
    this.jobs = jobs;
  }

  /** Call a tool as the runtime would: the guard first, then the host. */
  async call(name: string, argumentsValue: unknown): Promise<Record<string, unknown>> {
    const guard = this.tools.guard ? await this.tools.guard(name, argumentsValue) : { decision: "allow" as const };
    if (guard.decision === "block") {
      throw new Error(guard.reason);
    }
    return (await this.tools.call(name, argumentsValue)) as Record<string, unknown>;
  }

  /** The first JSON object in the turn's text that has this field. */
  card(field: string): Record<string, unknown> | undefined {
    for (const part of this.text.split("\n\n")) {
      try {
        const parsed = JSON.parse(part) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && field in parsed) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // ignore non-JSON paragraphs
      }
    }
    return undefined;
  }

  has(needle: string): boolean {
    return this.text.includes(needle);
  }

  toolNames(): string[] {
    return this.tools.specs().map((spec) => spec.name);
  }
}

/** The JSON messages a turn's text carries, one per paragraph. */
export function messages(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const part of text.split("\n\n")) {
    try {
      const parsed = JSON.parse(part) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // ignore
    }
  }
  return out;
}

/** The message of a turn's text whose `kind` is `kind`. */
export function message(text: string, kind: string): Record<string, unknown> {
  const found = messages(text).find((value) => value.kind === kind);
  if (!found) {
    throw new Error(`no ${kind} message in ${text}`);
  }
  return found;
}

export type Model = (turn: Turn) => Promise<string>;

/** One turn the kernel ran, for assertions. */
export interface Ran {
  role: SessionRole;
  sessionId: string;
  text: string;
  deliver: Deliver;
  resumed?: string;
  model?: string;
}

export class Scripted {
  model: Model | null = null;
  ran: Ran[] = [];
  opened: SessionSpec[] = [];
  openedOn: [SessionRole, Kernel][] = [];
  unavailable: string | undefined = undefined;
  installed: Kernel[] = [];
  wechat: Protocol = new Protocol();
  models: ModelOption[] = [];
  hold = false;
  private releaseWaiters: (() => void)[] = [];
  active = 0;
  mostActive = 0;
  setModels: [string, string | undefined, string | undefined][] = [];
  closed: string[] = [];
  refuseCancel = false;

  setHold(value: boolean): void {
    this.hold = value;
    if (!value) {
      this.notifyRelease();
    }
  }

  notifyRelease(): void {
    const waiters = this.releaseWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  waitRelease(): Promise<void> {
    if (!this.hold) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.releaseWaiters.push(resolve);
    });
  }
}

interface QueuedTurn {
  id: string;
  text: string;
  deliver: Deliver;
  resume?: string;
}

class AppScriptedDriver implements Driver {
  readonly kernels: Scripted;
  readonly spec: SessionSpec;
  readonly host: ToolHost;
  readonly events: UnboundedChannel<DriverEvent>;
  readonly queue = new UnboundedChannel<QueuedTurn>();
  readonly jobList: KernelJob[] = [];
  readonly acknowledged: string[] = [];
  readonly runtimeId: string;
  closed = false;
  private closeResolvers: (() => void)[] = [];

  constructor(kernels: Scripted, spec: SessionSpec, host: ToolHost, events: UnboundedChannel<DriverEvent>) {
    this.kernels = kernels;
    this.spec = spec;
    this.host = host;
    this.events = events;
    this.runtimeId = `rt-${spec.sessionId}`;
    void this.loop();
  }

  kernel(): string {
    return "scripted";
  }

  async submit(id: string, content: readonly Block[], deliver: Deliver, resume?: string): Promise<void> {
    if (this.closed) {
      throw new Error("The scripted runtime is closed");
    }
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text") {
        parts.push(block.text);
      }
    }
    this.queue.send({ id, text: parts.join("\n\n"), deliver, resume });
  }

  async interrupt(): Promise<void> {}

  async jobs(): Promise<KernelJob[]> {
    return [...this.jobList];
  }

  async acknowledge(ids: readonly string[]): Promise<void> {
    this.acknowledged.push(...ids);
  }

  async cancel(id: string): Promise<boolean> {
    if (this.kernels.refuseCancel) {
      return false;
    }
    const before = this.jobList.length;
    for (let i = this.jobList.length - 1; i >= 0; i--) {
      if (this.jobList[i]!.id === id) {
        this.jobList.splice(i, 1);
      }
    }
    return this.jobList.length !== before;
  }

  async setModel(model?: string, thinking?: string): Promise<void> {
    this.kernels.setModels.push([this.spec.sessionId, model, thinking]);
  }

  pid(): number | undefined {
    return undefined;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.queue.close();
      const waiters = this.closeResolvers.splice(0);
      for (const resolve of waiters) resolve();
      this.kernels.closed.push(this.spec.sessionId);
    }
  }

  private waitClosed(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.closeResolvers.push(resolve);
    });
  }

  private async loop(): Promise<void> {
    while (true) {
      const item = await this.queue.recv();
      if (item === undefined || this.closed) {
        return;
      }
      this.events.send({ type: "sessionId", id: this.runtimeId });
      this.events.send({ type: "running" });
      this.events.send({ type: "taken", id: item.id });
      this.kernels.ran.push({
        role: this.spec.role,
        sessionId: this.spec.sessionId,
        text: item.text,
        deliver: item.deliver,
        resumed: item.resume,
        model: this.spec.model?.model,
      });

      this.kernels.active += 1;
      if (this.kernels.active > this.kernels.mostActive) {
        this.kernels.mostActive = this.kernels.active;
      }

      try {
        while (this.kernels.hold && !this.closed) {
          await Promise.race([this.kernels.waitRelease(), this.waitClosed()]);
        }
        if (this.closed) {
          return;
        }
        const modelFn = this.kernels.model;
        const turn = new Turn(
          this.spec.role,
          this.spec.sessionId,
          this.spec.cwd,
          item.text,
          this.host,
          this.jobList,
        );

        const outcome = await Promise.race<
          { kind: "closed" } | { kind: "ok"; text: string } | { kind: "err"; error: string }
        >([
          (async () => {
            try {
              const text = modelFn ? await modelFn(turn) : "Done.";
              return { kind: "ok" as const, text };
            } catch (err) {
              return {
                kind: "err" as const,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          })(),
          this.waitClosed().then(() => ({ kind: "closed" as const })),
        ]);

        if (outcome.kind === "closed" || this.closed) {
          return;
        }
        const [text, stopReason] =
          outcome.kind === "ok" ? [outcome.text, "stop"] : [outcome.error, "error"];
        this.events.send({
          type: "message",
          message: {
            role: "assistant",
            content: [textBlock(text)],
            stopReason,
          },
        });
        this.events.send({
          type: "idle",
          awaitingAsync: this.jobList.length > 0,
        });
      } finally {
        this.kernels.active -= 1;
      }
    }
  }
}

/** The scripted kernel as the application holds it. */
export class ScriptedKernels extends BaseKernels implements Kernels {
  readonly scripted: Scripted;

  constructor(scripted: Scripted) {
    super();
    this.scripted = scripted;
  }

  open(
    kernel: Kernel,
    spec: SessionSpec,
    host: ToolHost,
    events: UnboundedChannel<DriverEvent>,
  ): Driver {
    this.scripted.opened.push({ ...spec });
    this.scripted.openedOn.push([spec.role, kernel]);
    return new AppScriptedDriver(this.scripted, spec, host, events);
  }

  async models(_kernel: Kernel): Promise<ModelOption[]> {
    return [...this.scripted.models];
  }

  unavailable(_kernel: Kernel): string | undefined {
    return this.scripted.unavailable;
  }

  override async install(kernel: Kernel): Promise<string> {
    this.scripted.installed.push(kernel);
    this.scripted.unavailable = undefined;
    return path.join("/installed", kernel);
  }
}

/** The default script: orchestrator accepts each candidate & replies on ready; worker writes file & reports ready. */
export function coreModel(): Model {
  return async (turn: Turn): Promise<string> => {
    if (turn.role === "orchestrator") {
      const candidate = turn.card("kind");
      if (candidate?.kind === "candidate") {
        const routed = await turn.call("orchestrator_route", {
          decisions: [
            {
              kind: "accept",
              trigger_id: candidate.trigger_id,
              title: "Fix fixture typo",
              worktree_name: "fix-fixture-typo",
              acknowledgement: "I will fix the fixture typo.",
            },
          ],
        });
        const results = routed.results as Record<string, unknown>[] | undefined;
        const first = results?.[0];
        return `Routed: ${typeof first?.decision === "string" ? first.decision : "refused"}`;
      }
      if (candidate?.kind === "worker_report" && candidate.state === "ready") {
        const ticketObj = candidate.ticket as Record<string, unknown>;
        await turn.call("orchestrator_reply", {
          ticket_id: ticketObj.ticket_id,
          purpose: "result",
          text: "Fixture work completed.",
        });
      }
      return "Done.";
    }
    if (turn.role === "worker") {
      fs.writeFileSync(path.join(turn.cwd, "fixture-result.txt"), "fixed\n");
      await turn.call("orchestrator_report", {
        state: "ready",
        summary: "Fixture change is ready.",
        topic: "The fixture typo in fixture-result.txt",
      });
      return "Worker ready.";
    }
    return "Done.";
  };
}

/** The Watchdog as tests run it: passes only when a test asks for one, and then without waiting. */
export function watchdogTimings(): WatchdogTimings {
  return {
    intervalMs: 3_600_000,
    stallMs: 0,
    cpuOnlySilenceMs: 3_600_000,
    longTaskMs: 0,
    idleGraceMs: 0,
    idleRecheckMs: 0,
    unrepliedGraceMs: 0,
    turnTimeoutMs: 10_000,
  };
}

export class Fixture {
  readonly dir: TempDir;
  readonly kernels: Scripted;
  readonly app: App;

  constructor(dir: TempDir, kernels: Scripted, app: App) {
    this.dir = dir;
    this.kernels = kernels;
    this.app = app;
  }

  script(run: Model): void {
    this.kernels.model = run;
  }

  /** Wait until `condition` holds, pumping passes meanwhile. */
  async until(what: string, condition: () => boolean | Promise<boolean>): Promise<void> {
    for (let i = 0; i < 600; i++) {
      if (await condition()) {
        return;
      }
      this.app.passes.pump();
      await Bun.sleep(10);
    }
    throw new Error(
      `timed out waiting until ${what}; transcript: ${JSON.stringify(this.chat())}; turns: ${JSON.stringify(this.turns())}`,
    );
  }

  /** Wait until nothing is left to do: no turn runs, no effect can start, and quiet 4x in a row. */
  async settle(): Promise<void> {
    let quiet = 0;
    for (let i = 0; i < 400; i++) {
      await this.app.passes.idle();
      await Bun.sleep(15);
      const main = this.app.session(this.app.masterId);
      const busy = this.kernels.active > 0 || (main !== null && main.session.isStreaming());
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= 4) {
        return;
      }
    }
    throw new Error(`the application did not settle; turns: ${JSON.stringify(this.turns())}`);
  }

  tickets(): Ticket[] {
    return this.app.store.tickets().reverse();
  }

  ticket(index: number): Ticket {
    const found = this.tickets()[index];
    if (!found) {
      throw new Error(`ticket at index ${index} does not exist`);
    }
    return found;
  }

  /** The visible chat transcript as [source, text]. */
  chat(): [string, string][] {
    return this.app.chatTranscript().map((entry) => {
      const text = entry.type === "custom_message" ? textOf(entry.content) : textOf(entry.message.content);
      return [entrySource(entry) ?? "", text];
    });
  }

  turns(): [SessionRole, string][] {
    return this.kernels.ran.map((ran) => [ran.role, clip(ran.text, 200)]);
  }

  ran(role: SessionRole): Ran[] {
    return this.kernels.ran.filter((ran) => ran.role === role);
  }

  /** A background job a scripted worker leaves running. */
  static job(id: string, kind: JobKind, label: string): KernelJob {
    return {
      id,
      kind,
      label,
      startTime: nowMs(),
      command: kind === "bash" ? label : undefined,
      own: true,
      pids: [],
    };
  }

  /** Stop the application and remove the temporary directory. */
  async cleanup(): Promise<void> {
    await this.app.stop();
    this.app.close();
    this.dir.cleanup();
  }

  /** Stop the application and open it again over the same data directory, as after a restart. */
  async restart(): Promise<Fixture> {
    await this.app.stop();
    this.app.close();
    const next = openIn(this.dir, this.kernels);
    await next.app.start();
    return next;
  }
}

export function openIn(dir: TempDir, kernels: Scripted): Fixture {
  const app = App.open(
    {
      stateDir: dir.join("state"),
      wechat: kernels.wechat,
    },
    new ScriptedKernels(kernels),
    {
      wechatBurstMs: 60,
      webBurstMs: 0,
      watchdog: watchdogTimings(),
    },
  );
  return new Fixture(dir, kernels, app);
}

export function fixture(): Fixture {
  const kernels = new Scripted();
  kernels.model = coreModel();
  return openIn(new TempDir("app"), kernels);
}

export async function started(): Promise<Fixture> {
  const f = fixture();
  await f.app.start();
  return f;
}

/** Counts of how often each tool result was seen, for scripts that act once. */
export class Once {
  private readonly seen = new Map<string, number>();

  first(key: string): boolean {
    const count = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, count);
    return count === 1;
  }
}

/** The kernel and model settings once every kernel has listed its models. */
export async function modelsReady(app: App): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const view = (await app.modelsView()) as Record<string, unknown>;
    if (view.loading !== true) {
      return view;
    }
    await Bun.sleep(10);
  }
  throw new Error("the kernels never listed their models");
}
