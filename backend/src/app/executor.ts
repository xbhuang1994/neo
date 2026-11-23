/**
 * The Executor: one persistent worker Session and one directory per ticket. It launches Assignments,
 * hands Inputs to running workers, bounds how many work at once, and reports each worker's turns to
 * the Engine.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  UserError,
  findTicketInput,
  formatIso,
  isTicketLive,
  isUserError,
  key,
  latestAssignment,
  nowIso,
  nowMs,
  runningAssignment,
  waitsForPerson,
  workerReport,
} from "../core/index.ts";
import type { Accept, Assignment, Ticket, TicketInput } from "../core/index.ts";
import { entryInputIds, errorMessage, isRecord, textBlock } from "../kernel/index.ts";
import type { KernelEvent } from "../kernel/index.ts";
import { pathWith } from "./blocked.ts";
import {
  ASSIGNMENT_CHARS,
  RETRIED,
  batchLine,
  capped,
  charCount,
  inputMessage,
  inputResource,
  mandateInstructions,
  workerTriggerMessage,
} from "./cards.ts";
import { StopWorkerError, WORKTREE_NAME_RULE, validWorktreeName } from "./context.ts";
import type { AppContext, Loaded, WorkerJob } from "./context.ts";
import { DELIVERY, Failure, LAUNCH } from "./effects.ts";
import { Health } from "./health.ts";
import { resultRelay } from "./notices.ts";
import { inDirectory, terminatePids, tree } from "./procinfo.ts";
import { environment } from "./prompts.ts";
import type { TicketPlace } from "./prompts.ts";
import { workerSessionId } from "./sessions.ts";
import { clip } from "./text.ts";

export { StopWorkerError, WORKTREE_NAME_RULE, validWorktreeName, type WorkerJob } from "./context.ts";
export { workerSessionId } from "./sessions.ts";

/** How long a prepare command may run before timing out (10 minutes). */
const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;

/** Maximum buffered stderr bytes retained for a prepare command (tail kept for the final 1000 chars). */
const PREPARE_STDERR_CAP_BYTES = 256 * 1024;
const PREPARE_STDERR_KEEP_BYTES = 128 * 1024;

/** Maximum time waited for graceful job cancellation when stopping or interrupting a worker. */
const JOB_CANCEL_TIMEOUT_MS = 2_000;

/** Why a worker's slot is reserved before its turn starts. */
type By = "launch" | "wake" | "person";

/** The Executor's in-memory state. */
export class ExecutorState {
  /** Tickets whose worker is in a turn, or has background work that will wake it. */
  readonly running = new Set<string>();
  /** Tickets whose launch or delivery is under way, with why. */
  readonly starting = new Map<string, By>();
  /**
   * Tickets whose worker was sent a message that starts a turn, until that turn is seen to start:
   * the slot stays taken in between.
   */
  readonly awaiting = new Set<string>();
  /** Tickets that ended on their worker's own final report: its Session closes once that turn is over. */
  readonly unloadAfterEnd = new Set<string>();
  /**
   * Shell jobs a worker left to a person at a handoff, by ticket: they run until the Assignment ends
   * and wake no one.
   */
  readonly left = new Map<string, Set<string>>();
  /** Tickets whose worker Session is currently stopping. */
  readonly stopping = new Set<string>();
  /** Monotonic sequence counter for watchdog wake request ids. */
  wakeSeq = 0;
  /** Event-driven per-ticket stop waiters so `workerStopped` never polls. */
  private readonly stopWaiters = new Map<string, Set<() => void>>();

  /** Wait until a stop notification fires for `ticketId` (returns immediately if not stopping). */
  waitStopped(ticketId: string): Promise<void> {
    if (!this.stopping.has(ticketId)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let waiters = this.stopWaiters.get(ticketId);
      if (waiters === undefined) {
        waiters = new Set<() => void>();
        this.stopWaiters.set(ticketId, waiters);
      }
      waiters.add(resolve);
    });
  }

  /** Wake every waiter waiting for `ticketId` to finish stopping. */
  notifyStopped(ticketId: string): void {
    const waiters = this.stopWaiters.get(ticketId);
    if (waiters === undefined) {
      return;
    }
    this.stopWaiters.delete(ticketId);
    for (const resolve of waiters) {
      resolve();
    }
  }
}

/** The program and arguments that run a prepare command: the platform's shell, or the one the settings name. */
export function prepareShell(
  configured: string | undefined,
  command: string,
  windows: boolean = process.platform === "win32",
): [program: string, args: string[]] {
  const program = configured !== undefined ? configured : windows ? "cmd.exe" : "sh";
  // The name alone, whichever separators the path uses, without its extension.
  const slash = Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\"));
  const name = slash >= 0 ? program.slice(slash + 1) : program;
  const stem = (
    name.endsWith(".exe") || name.endsWith(".EXE") ? name.slice(0, -4) : name
  ).toLowerCase();
  let args: string[];
  if (stem === "cmd") {
    args = ["/d", "/s", "/c", command];
  } else if (stem === "powershell" || stem === "pwsh") {
    args = ["-NoProfile", "-Command", command];
  } else {
    args = ["-c", command];
  }
  return [program, args];
}

function fromPerson(input: TicketInput): boolean {
  if (input.kind === "text") {
    return true;
  }
  return input.kind === "trigger" && input.human === true && !input.context;
}

/**
 * Whether the running Assignment's last word hands the ticket to a person: blocked or failed
 * without a newer human message, or ready or a question with no Input since.
 */
function handedOff(ticket: Ticket): boolean {
  const assignment = runningAssignment(ticket);
  if (assignment === undefined) {
    return false;
  }
  const report = assignment.report;
  if (report === undefined) {
    return false;
  }
  if (report.state === "blocked" || report.state === "failed") {
    return waitsForPerson(ticket);
  }
  const quiet = assignment.deliveredAt === undefined || assignment.deliveredAt < report.at;
  return quiet && (report.state === "ready" || ticket.attention !== undefined);
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  if (text.length === 0) {
    return "";
  }
  const nl = text.indexOf("\n");
  if (nl < 0) {
    return text;
  }
  const end = nl > 0 && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
  return text.slice(0, end);
}

/** The last `limit` Unicode scalar values (characters) of `text`, matching Rust `chars().rev().take(limit)`. */
function takeLastChars(text: string, limit: number): string {
  if (limit <= 0 || text.length === 0) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  let count = 0;
  let i = text.length;
  while (i > 0 && count < limit) {
    const code = text.charCodeAt(i - 1);
    if (code >= 0xdc00 && code <= 0xdfff && i >= 2) {
      const prev = text.charCodeAt(i - 2);
      if (prev >= 0xd800 && prev <= 0xdbff) {
        i -= 2;
        count += 1;
        continue;
      }
    }
    i -= 1;
    count += 1;
  }
  return i === 0 ? text : text.slice(i);
}

async function runWithTimeout(ms: number, work: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = work().catch(() => undefined);
  try {
    await Promise.race([
      run,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function maxWorkers(app: AppContext): number {
  return app.settings().executor.maxWorkers;
}

/** How many more Assignments may launch now: the worker limit less the workers in a turn and those being woken. */
export function launchRoom(app: AppContext, state: ExecutorState): number {
  // A launch under way is one of the launch effects the queue already counts.
  const busy = new Set<string>();
  for (const id of state.running) {
    busy.add(id);
  }
  for (const id of state.awaiting) {
    busy.add(id);
  }
  for (const [id, by] of state.starting) {
    if (by !== "launch") {
      busy.add(id);
    }
  }
  return Math.max(0, maxWorkers(app) - busy.size);
}

/** Reserve a worker slot before a turn starts; a person's message may take one slot beyond the limit. */
function reserve(app: AppContext, state: ExecutorState, ticketId: string, by: By): void {
  const max = maxWorkers(app);
  if (state.starting.has(ticketId)) {
    return;
  }
  const used = new Set<string>();
  for (const id of state.running) {
    used.add(id);
  }
  for (const id of state.awaiting) {
    used.add(id);
  }
  for (const id of state.starting.keys()) {
    used.add(id);
  }
  if (used.size >= max + (by === "person" ? 1 : 0)) {
    throw Failure.later("No worker slot is free");
  }
  state.starting.set(ticketId, by);
}

function free(state: ExecutorState, ticketId: string): void {
  state.starting.delete(ticketId);
}

/**
 * Send a worker a message that asks for a turn, keeping its slot taken from before the send until
 * the turn is seen to start, so no other worker is admitted in between.
 */
async function sendToWorker(
  state: ExecutorState,
  loaded: Loaded,
  ticketId: string,
  requestId: string,
  text: string,
  inputIds: readonly string[],
): Promise<void> {
  state.awaiting.add(ticketId);
  try {
    await loaded.session.send(requestId, [textBlock(text)], "steer", {}, inputIds);
  } catch (error) {
    state.awaiting.delete(ticketId);
    throw error;
  }
  // No turn follows a failed send, or a message the worker already took into a step.
  if (!(loaded.session.isStreaming() || loaded.session.hasAdmittedSubmission())) {
    state.awaiting.delete(ticketId);
  }
}

/** Whether any worker is in a turn, being started or woken, or has background work that will wake it. */
export function workersBusy(_app: AppContext, state: ExecutorState): boolean {
  return state.running.size > 0 || state.awaiting.size > 0 || state.starting.size > 0;
}

/** Whether this ticket's worker is currently in a turn, starting, or awaiting a turn. */
export function isWorkerActive(_app: AppContext, state: ExecutorState, ticketId: string): boolean {
  return state.running.has(ticketId) || state.awaiting.has(ticketId) || state.starting.has(ticketId);
}

/** The tickets whose worker is in a turn, being started or woken, or has background work that will wake it. */
export function busyTicketIds(_app: AppContext, state: ExecutorState): Set<string> {
  const ids = new Set<string>();
  for (const id of state.running) {
    ids.add(id);
  }
  for (const id of state.awaiting) {
    ids.add(id);
  }
  for (const id of state.starting.keys()) {
    ids.add(id);
  }
  if (ids.size <= 1) {
    return ids;
  }
  const sorted = Array.from(ids).sort();
  return new Set(sorted);
}

/** Sorted list of busy ticket ids, matching Rust `App::busy_tickets`. */
export function busyTickets(app: AppContext, state: ExecutorState): string[] {
  return Array.from(busyTicketIds(app, state));
}

/** How many open tickets have a worker at work. */
/** Number of currently open tickets with an active worker. Uses O(active) in-memory `liveTickets` (zero SQLite I/O). */
export function activeWorkers(app: AppContext, state: ExecutorState): number {
  if (state.running.size === 0) return 0;
  let count = 0;
  for (const ticketId of state.running) {
    if (app.liveTickets.has(ticketId)) {
      count += 1;
    }
  }
  return count;
}

/** Where ticket directories are created. */
export function executionRoot(app: AppContext): string {
  const dir = app.settings().executor.directory;
  return dir.length === 0 ? path.join(app.machine.stateDir, "work") : dir;
}

/** Choose a new ticket's short name, directory and assignment text. */
export function executorPrepare(app: AppContext, ticket: Ticket, accept: Accept): Ticket {
  const requested = accept.name ?? "";
  if (!validWorktreeName(requested)) {
    throw UserError.invalid(`worktree_name: ${WORKTREE_NAME_RULE}`);
  }
  const name = `${requested}-${ticket.id.slice(0, Math.min(ticket.id.length, 12))}`;
  const settings = app.settings();
  const note =
    accept.note !== undefined ? `\nRouting note (not the source request): ${accept.note}` : "";
  let assignment: string;
  if (ticket.mandate.basis.rules !== undefined && ticket.mandate.strength === "inferred") {
    const ids = ticket.mandate.basis.rules;
    const idSet = new Set(ids);
    let rules = "";
    for (const rule of settings.policy.rules) {
      if (idSet.has(rule.id)) {
        rules += `\n- ${rule.name} (${rule.id}): ${rule.instruction}`;
      }
    }
    const precedence =
      rules.length === 0
        ? ""
        : `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}`;
    assignment = `Proactively accepted under ${ids.join(", ")}. Scope: ${accept.scope}.${precedence}${note}`;
  } else {
    assignment = note.trim();
  }
  ticket.execution = {
    directory: path.join(executionRoot(app), name),
    name,
    assignment,
  };
  return ticket;
}

/** Create a ticket's directory, running the prepare command first when one is set. */
async function prepareDirectory(
  app: AppContext,
  ticket: Ticket,
  timeoutMs: number = PREPARE_TIMEOUT_MS,
): Promise<void> {
  const execution = ticket.execution;
  if (execution === undefined) {
    throw Failure.error("The ticket has no directory");
  }
  const directory = execution.directory;
  const dirParent = path.dirname(directory);
  const parent =
    directory.length === 0 || dirParent === directory ? executionRoot(app) : dirParent;
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (error) {
    throw Failure.error(`Cannot create ${parent}: ${errorMessage(error)}`);
  }

  const settings = app.settings();
  const command = settings.executor.prepare.trim();
  if (command.length > 0) {
    const place: TicketPlace = { id: ticket.id, name: execution.name, directory };
    const [program, args] = prepareShell(settings.executor.prepareShell, command);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) {
        env[k] = v;
      }
    }
    for (const variable of environment(settings, place)) {
      env[variable.key] = variable.value;
    }
    // A prepare command meets the same blocked commands as a Session.
    env.PATH = pathWith(app.machine.stateDir);

    const failed = (why: string): Failure => {
      try {
        fs.rmdirSync(directory);
      } catch {
        // Ignore cleanup failure when directory was not created or is non-empty.
      }
      return Failure.error(`The prepare command failed: ${why}`);
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      const child = spawn(program, args, {
        cwd: parent,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const cleanupTimer = (): void => {
        clearTimeout(timer);
      };

      const finishErr = (failure: Failure): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupTimer();
        reject(failure);
      };

      const finishOk = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupTimer();
        resolve();
      };

      // Drain stdout so a chatty prepare script never blocks on a full OS pipe.
      child.stdout?.resume();
      child.stderr?.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        totalBytes += chunk.length;
        if (totalBytes > PREPARE_STDERR_CAP_BYTES) {
          const combined = Buffer.concat(chunks, totalBytes);
          const tail = combined.subarray(combined.length - PREPARE_STDERR_KEEP_BYTES);
          chunks.length = 0;
          chunks.push(tail);
          totalBytes = tail.length;
        }
      });

      const timer = setTimeout(() => {
        const pid = child.pid;
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore if already exited.
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (pid !== undefined) {
          const pids = tree([pid]).map((processSnapshot) => processSnapshot.pid);
          if (pids.length > 0) {
            void terminatePids(pids);
          }
        }
        finishErr(failed(`it did not finish within ${Math.floor(timeoutMs / 60_000)} minutes`));
      }, timeoutMs);
      timer.unref?.();

      child.once("error", (error) => {
        finishErr(failed(`cannot run ${program}: ${errorMessage(error)}`));
      });

      child.once("close", (exitCode, signal) => {
        if (settled) {
          return;
        }
        if (exitCode === 0 && signal === null) {
          finishOk();
          return;
        }
        const stderrText = chunks.length > 0 ? Buffer.concat(chunks, totalBytes).toString("utf8") : "";
        const said = takeLastChars(stderrText.trim(), 1000);
        const code = exitCode !== null ? `exit code ${exitCode}` : "a signal";
        finishErr(failed(said.length === 0 ? code : `${code}: ${said}`));
      });
    });
  }

  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw Failure.error(`Cannot create ${directory}: ${errorMessage(error)}`);
  }
}

/**
 * End an Assignment's work once the Engine ended it: close its worker's Session, unless that worker
 * is still in the turn of its own final report, which then closes it. A human stop always
 * terminates immediately.
 */
export function executorStop(
  app: AppContext,
  state: ExecutorState,
  ticket: Ticket,
  assignment: Assignment,
  reason: string,
): void {
  const humanStop = ticket.ended?.by === "human";
  const busy =
    assignment.deliveredAt !== undefined &&
    assignment.report !== undefined &&
    assignment.deliveredAt >= assignment.report.at;
  const ownTurn =
    !humanStop &&
    (assignment.report?.state === "ready" || assignment.report?.state === "dropped") &&
    !busy &&
    ticket.undelivered.length === 0;
  const ticketId = ticket.id;
  app.store.afterCommit(() => {
    if (ownTurn && (state.running.has(ticketId) || state.awaiting.has(ticketId))) {
      state.unloadAfterEnd.add(ticketId);
      return;
    }
    state.unloadAfterEnd.delete(ticketId);
    state.running.delete(ticketId);
    state.awaiting.delete(ticketId);
    state.left.delete(ticketId);
    stopWorker(app, state, ticketId, reason);
  });
}

async function disposeAndCollectSessionPids(loaded: Loaded): Promise<number[]> {
  loaded.session.beginDispose();
  const driver = loaded.session.driver();
  const roots: number[] = [];
  const driverPid = driver.pid();
  if (driverPid !== undefined) {
    roots.push(driverPid);
  }
  await runWithTimeout(JOB_CANCEL_TIMEOUT_MS, async () => {
    const jobs = await driver.jobs();
    const jobIds: string[] = [];
    for (const job of jobs) {
      for (const pid of job.pids) {
        roots.push(pid);
      }
      jobIds.push(job.id);
    }
    if (jobIds.length > 0) {
      await driver.acknowledge(jobIds);
      await Promise.allSettled(jobIds.map((jobId) => driver.cancel(jobId)));
    }
  });
  if (roots.length === 0) {
    return [];
  }
  return tree(roots).map((proc) => proc.pid);
}

function safeTicketDir(ticket: Ticket | null): string | undefined {
  const execution = ticket?.execution;
  if (execution === undefined || execution.name.length === 0) {
    return undefined;
  }
  const dir = execution.directory;
  const safeLeaf = path.basename(dir) === execution.name;
  return safeLeaf && isDirectory(dir) ? dir : undefined;
}

async function cleanupWorkspacePids(
  ticketDir: string | undefined,
  strayPids: number[],
): Promise<void> {
  if (ticketDir !== undefined) {
    let canonical = ticketDir;
    try {
      canonical = fs.realpathSync(ticketDir);
    } catch {
      // Fallback to original directory path if canonicalization fails.
    }
    const dirPids = inDirectory(canonical);
    if (dirPids.length > 0) {
      for (const proc of tree(dirPids)) {
        strayPids.push(proc.pid);
      }
    }
  }
  if (strayPids.length > 0) {
    await terminatePids(strayPids);
  }
}

/**
 * Close a ticket's worker Session together with all its subagents, background jobs and detached
 * workspace processes; `workerStopped` waits for it.
 */
function stopWorker(
  app: AppContext,
  state: ExecutorState,
  ticketId: string,
  _reason: string,
): void {
  if (state.stopping.has(ticketId)) {
    return;
  }
  state.stopping.add(ticketId);
  void (async () => {
    try {
      const sessionId = workerSessionId(ticketId);
      let strayPids: number[] = [];
      const loaded = app.session(sessionId);
      if (loaded !== null) {
        strayPids = await disposeAndCollectSessionPids(loaded);
      }
      await app.stopSession(sessionId);
      const stored = app.storeTicket(ticketId);
      const ticketDir = stored !== null && !isTicketLive(stored) ? safeTicketDir(stored) : undefined;
      await cleanupWorkspacePids(ticketDir, strayPids);
    } finally {
      app.jobsCache.delete(ticketId);
      state.stopping.delete(ticketId);
      state.notifyStopped(ticketId);
      app.effects.wakeKind(LAUNCH);
    }
  })();
}

async function workerStopped(state: ExecutorState, ticketId: string): Promise<void> {
  while (state.stopping.has(ticketId)) {
    await state.waitStopped(ticketId);
  }
}

/**
 * Stop an open ticket from the UI together with its worker, subagents, background jobs and queued
 * work, marking it ended with outcome `stopped`, and return the refreshed worker detail view.
 * Refuses unknown or already ended tickets.
 */
export async function stopWorkerTicket(
  app: AppContext,
  state: ExecutorState,
  ticketId: string,
): Promise<unknown> {
  app.store.atomic(() => {
    const ticket = app.storeTicket(ticketId);
    if (ticket === null) {
      throw StopWorkerError.notFound();
    }
    if (!isTicketLive(ticket)) {
      throw StopWorkerError.alreadyEnded();
    }
    try {
      app.engine.stopTicket(ticketId, "Stopped from task detail");
    } catch (error) {
      throw StopWorkerError.failed(isUserError(error) ? error.message : errorMessage(error));
    }
    app.effects.cancel(DELIVERY, ticketId);
    for (const assignment of ticket.assignments) {
      app.effects.cancel(LAUNCH, assignment.id);
    }
  });
  state.unloadAfterEnd.delete(ticketId);
  state.running.delete(ticketId);
  state.awaiting.delete(ticketId);
  state.left.delete(ticketId);
  stopWorker(app, state, ticketId, "Stopped from task detail");
  await workerStopped(state, ticketId);
  app.jobsCache.delete(ticketId);
  app.effects.wakeKind(LAUNCH);
  app.passes.pump();
  const detail = await app.workerDetail(ticketId);
  if (detail === null) {
    throw StopWorkerError.notFound();
  }
  return detail;
}

function workerFailed(app: AppContext, ticketId: string, summary: string): void {
  try {
    app.store.atomic(() => {
      const updated = app.engine.report(ticketId, workerReport("failed", summary));
      app.relay(resultRelay(updated, "failed", summary, null));
    });
  } catch {
    // Match Rust `let _ = self.store.atomic(...)`
  }
}

function triggerAcknowledged(app: AppContext, triggerId: string): boolean {
  return app.store.replyStatus(key(["ack", triggerId])) !== undefined;
}

/** The message an Input reaches its worker as, a reference to its resource when long. */
function inputText(app: AppContext, ticket: Ticket, input: TicketInput): string {
  let card: Record<string, unknown> | undefined;
  if (input.kind === "trigger") {
    const trigger = app.store.trigger(input.triggerId);
    if (trigger !== undefined) {
      card = workerTriggerMessage(trigger, input.note, triggerAcknowledged(app, trigger.id));
    }
  }
  const message = inputMessage(input, card);
  if (charCount(message) > ASSIGNMENT_CHARS) {
    return JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id)));
  }
  return message;
}

/** Handle a queued `LAUNCH` effect for one pending Assignment. */
export async function launchQueued(
  app: AppContext,
  state: ExecutorState,
  payload: unknown,
): Promise<void> {
  if (!isRecord(payload)) {
    return;
  }
  const ticketId = typeof payload.ticketId === "string" ? payload.ticketId : undefined;
  const assignmentId = typeof payload.assignmentId === "string" ? payload.assignmentId : undefined;
  if (ticketId === undefined || assignmentId === undefined) {
    return;
  }
  const ticket = app.storeTicket(ticketId);
  if (ticket === null || !isTicketLive(ticket)) {
    return;
  }
  const latest = latestAssignment(ticket);
  if (latest === undefined || latest.id !== assignmentId || latest.state !== "pending") {
    return;
  }
  const assignment = structuredClone(latest);
  reserve(app, state, ticketId, "launch");
  let failure: Failure | undefined;
  try {
    await launch(app, state, ticket, assignment);
  } catch (error) {
    failure = Failure.from(error);
  } finally {
    free(state, ticketId);
  }
  if (failure !== undefined) {
    state.running.delete(ticketId);
    if (app.closing() || failure.kind === "later") {
      throw failure;
    }
    // A launch that failed is the ticket's failure, which a person retries; it is not retried blindly.
    const current = app.storeTicket(ticketId);
    if (
      current !== null &&
      isTicketLive(current) &&
      latestAssignment(current)?.id === assignmentId
    ) {
      workerFailed(app, ticketId, failure.message);
    }
  }
}

async function launch(
  app: AppContext,
  state: ExecutorState,
  ticket: Ticket,
  assignment: Assignment,
): Promise<void> {
  const current = (): boolean => {
    if (app.closing()) {
      throw Failure.error("neo-agent is stopping");
    }
    if (app.paused()) {
      throw Failure.later("Processing is paused");
    }
    const stored = app.storeTicket(ticket.id);
    return (
      stored !== null &&
      isTicketLive(stored) &&
      latestAssignment(stored)?.id === assignment.id
    );
  };

  const execution = ticket.execution;
  if (execution === undefined) {
    throw Failure.error("The ticket has no directory");
  }
  const workspace = execution.directory;
  if (!current()) {
    return;
  }
  if (!isDirectory(workspace)) {
    await prepareDirectory(app, ticket);
    if (!current()) {
      return;
    }
  }
  await workerStopped(state, ticket.id);
  if (!current()) {
    return;
  }
  state.unloadAfterEnd.delete(ticket.id);
  const sessionId = workerSessionId(ticket.id);
  // A worker whose last turn ended in a model error starts over in a fresh runtime process.
  const existing = app.session(sessionId);
  if (
    existing !== null &&
    !existing.session.isStreaming() &&
    existing.session.journal().lastStopReason() === "error"
  ) {
    await app.stopSession(sessionId);
  }
  const loaded = await app.ensureSession(sessionId, "worker", workspace, ticket.title, ticket.id);
  if (!current()) {
    await app.stopSession(sessionId);
    return;
  }

  const journal = loaded.session.journal();
  const first = `assignment:${ticket.id}`;
  const later = ticket.assignments.length > 1;
  // Told already: the transcript holds the assignment, and this kernel's runtime has that context to resume.
  const told =
    later &&
    journal.hasRequest(first) &&
    journal.kernelSession(loaded.session.driver().kernel()) !== undefined;
  const retried =
    ticket.assignments.length >= 2 &&
    ticket.assignments[ticket.assignments.length - 2].endedReason === "retried";
  const fresh = app.storeTicket(ticket.id) ?? ticket;
  const waiting: TicketInput[] = [];
  if (later || fresh.undelivered.length > 0) {
    for (const id of fresh.undelivered) {
      const inp = findTicketInput(fresh, id);
      if (inp !== undefined) {
        waiting.push(inp);
      }
    }
  }

  const card: Record<string, unknown> = {
    ticket_id: ticket.id,
    directory: execution.directory,
  };
  if (told) {
    card.assignment = ticket.assignments.length;
  } else {
    card.title = ticket.title;
    card.worktree_name = execution.name;
    const mandate = mandateInstructions(ticket);
    if (mandate !== undefined) {
      card.mandate = mandate;
    }
    if (execution.assignment.length > 0) {
      const brief = capped(
        execution.assignment,
        ASSIGNMENT_CHARS,
        `ticket/${ticket.id}/assignment`,
      );
      card.assignment = brief.text;
      if (brief.chars !== undefined) {
        card.assignment_chars = brief.chars;
        card.assignment_read = brief.read;
      }
    }
    const source = app.store.trigger(ticket.origin.triggerId);
    if (source !== undefined) {
      card.trigger = workerTriggerMessage(source, undefined, triggerAcknowledged(app, source.id));
    }
    const batch: Record<string, unknown>[] = [];
    for (const id of ticket.origin.triggerIds) {
      if (id === ticket.origin.triggerId) {
        continue;
      }
      const trigger = app.store.trigger(id);
      if (trigger !== undefined) {
        batch.push(batchLine(trigger));
      }
    }
    if (batch.length > 0) {
      card.batch = batch;
    }
  }
  if (retried) {
    card.note = RETRIED;
  }

  const parts: string[] = [JSON.stringify(card)];
  for (const input of waiting) {
    parts.push(inputText(app, fresh, input));
  }
  const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first;
  const inputIds = waiting.map((input) => input.id);
  if (!current()) {
    await app.stopSession(sessionId);
    throw Failure.error("Launch authorization changed before worker delivery");
  }
  await sendToWorker(state, loaded, ticket.id, requestId, parts.join("\n\n"), inputIds);
  // Recorded together, so the Inputs the launch carried are not also queued for a delivery of their own.
  app.store.atomic(() => {
    app.engine.assignmentStarted(ticket.id, assignment.id);
    if (inputIds.length > 0) {
      app.engine.inputsDelivered(ticket.id, assignment.id, inputIds);
    }
  });
}

/** Handle a queued `DELIVERY` effect for one ticket's undelivered Inputs. */
export async function deliverQueued(
  app: AppContext,
  state: ExecutorState,
  payload: unknown,
): Promise<void> {
  if (!isRecord(payload)) {
    return;
  }
  const ticketId = typeof payload.ticketId === "string" ? payload.ticketId : undefined;
  if (ticketId === undefined) {
    return;
  }
  await workerStopped(state, ticketId);
  const woken = { value: false };
  try {
    await deliverAll(app, state, ticketId, woken);
  } finally {
    if (woken.value) {
      free(state, ticketId);
    }
  }
}

async function deliverAll(
  app: AppContext,
  state: ExecutorState,
  ticketId: string,
  woken: { value: boolean },
): Promise<void> {
  while (true) {
    const ticket = app.storeTicket(ticketId);
    if (ticket === null || !isTicketLive(ticket)) {
      return;
    }
    const assignment = runningAssignment(ticket);
    if (assignment === undefined) {
      return;
    }
    const firstId = ticket.undelivered[0];
    if (firstId === undefined) {
      return;
    }
    const input = findTicketInput(ticket, firstId);
    if (input === undefined) {
      return;
    }
    if (!woken.value && !state.running.has(ticketId)) {
      let person = false;
      for (const id of ticket.undelivered) {
        const candidate = findTicketInput(ticket, id);
        if (candidate !== undefined && fromPerson(candidate)) {
          person = true;
          break;
        }
      }
      reserve(app, state, ticketId, person ? "person" : "wake");
      woken.value = true;
    }
    try {
      await deliverInput(app, state, ticket, assignment, input);
    } catch (error) {
      const failure = Failure.from(error);
      if (app.closing() || failure.kind === "later") {
        throw failure;
      }
      const current = app.storeTicket(ticketId);
      const still =
        current !== null &&
        isTicketLive(current) &&
        runningAssignment(current)?.id === assignment.id;
      if (!still) {
        return;
      }
      try {
        app.engine.deliveryFailed(ticketId, assignment.id, failure.message);
      } catch {
        // Match Rust `let _ = self.engine.delivery_failed(...)`
      }
      throw failure;
    }
  }
}

async function deliverInput(
  app: AppContext,
  state: ExecutorState,
  ticket: Ticket,
  assignment: Assignment,
  input: TicketInput,
): Promise<void> {
  const live = (): void => {
    const current = app.storeTicket(ticket.id);
    const still =
      current !== null &&
      isTicketLive(current) &&
      runningAssignment(current)?.id === assignment.id;
    if (!still) {
      throw Failure.error("The ticket ended or another Assignment took it over");
    }
    if (state.stopping.has(ticket.id)) {
      throw Failure.later("The worker Session is stopping");
    }
  };

  live();
  const directory = ticket.execution?.directory ?? "";
  const sessionId = workerSessionId(ticket.id);
  const loaded = await app.ensureSession(sessionId, "worker", directory, ticket.title, ticket.id);
  try {
    live();
  } catch (error) {
    await app.stopSession(sessionId);
    throw error;
  }
  const ids = [input.id];
  await sendToWorker(state, loaded, ticket.id, input.id, inputText(app, ticket, input), ids);
  app.engine.inputsDelivered(ticket.id, assignment.id, ids);
}

/** What a worker Session reported. */
export async function workerEvent(
  app: AppContext,
  state: ExecutorState,
  ticketId: string,
  loaded: Loaded,
  event: KernelEvent,
): Promise<void> {
  switch (event.type) {
    case "agentStart":
      state.running.add(ticketId);
      state.awaiting.delete(ticketId);
      break;
    case "retry":
      if (state.unloadAfterEnd.has(ticketId)) {
        await turnOver(app, state, ticketId, loaded, undefined);
      }
      break;
    case "agentEnd":
      if (event.terminal) {
        await turnOver(app, state, ticketId, loaded, undefined);
      } else if (event.awaitingAsync) {
        await backgrounded(app, state, ticketId, loaded);
      }
      break;
    case "message":
      break;
    case "taken": {
      // The worker's runtime took these messages into a step: its model reads the Inputs they carry.
      const journal = loaded.session.journal();
      const inputs: string[] = [];
      for (const id of event.requestIds) {
        const entry = journal.request(id);
        if (entry !== undefined) {
          for (const inputId of entryInputIds(entry)) {
            inputs.push(inputId);
          }
        }
      }
      if (inputs.length > 0) {
        try {
          app.engine.inputsRead(ticketId, inputs);
        } catch {
          // Match Rust `let _ = self.engine.inputs_read(...)`
        }
      }
      break;
    }
  }
}

/** Nothing the worker runs wakes it again: free its slot and report, or close a ticket that stayed ended meanwhile. */
async function turnOver(
  app: AppContext,
  state: ExecutorState,
  ticketId: string,
  loaded: Loaded,
  note: string | undefined,
): Promise<void> {
  state.running.delete(ticketId);
  state.awaiting.delete(ticketId);
  const unload = state.unloadAfterEnd.delete(ticketId);
  const stored = app.storeTicket(ticketId);
  if (unload && !(stored !== null && isTicketLive(stored))) {
    state.left.delete(ticketId);
    stopWorker(app, state, ticketId, "Ticket ended");
    app.effects.wakeKind(LAUNCH);
    return;
  }
  workerEnded(app, ticketId, loaded, note);
  app.board.set("worker", Health.ready("Worker events are handled"));
  // A slot is free: a launch that waited for one may go.
  app.effects.wakeKind(LAUNCH);
}

/**
 * The worker's turn ended while its jobs or subagents run; their ends wake it, so it keeps its
 * slot. A handoff to a person ends that at once: its subagents stop, and its own shell jobs, such
 * as a server offered for review, run on until the Assignment ends without waking it.
 */
async function backgrounded(
  app: AppContext,
  state: ExecutorState,
  ticketId: string,
  loaded: Loaded,
): Promise<void> {
  if (state.unloadAfterEnd.has(ticketId)) {
    await turnOver(app, state, ticketId, loaded, undefined);
    return;
  }
  const ticket = app.storeTicket(ticketId);
  if (ticket !== null && handedOff(ticket)) {
    const driver = loaded.session.driver();
    const allJobs = await driver.jobs();
    const jobs = allJobs.filter((job) => job.own);
    // Acknowledged jobs deliver nothing, so neither those left running nor the cancelled ones wake the worker.
    await driver.acknowledge(jobs.map((job) => job.id));
    for (const job of jobs) {
      if (job.kind === "bash") {
        let leftSet = state.left.get(ticketId);
        if (leftSet === undefined) {
          leftSet = new Set<string>();
          state.left.set(ticketId, leftSet);
        }
        leftSet.add(job.id);
      } else {
        await driver.cancel(job.id);
      }
    }
    await turnOver(app, state, ticketId, loaded, undefined);
  }
}

/** The live background jobs of a ticket's worker, without the shell jobs it left to a person at a handoff. */
export async function runningJobs(
  app: AppContext,
  state: ExecutorState,
  ticketId: string,
): Promise<WorkerJob[]> {
  const loaded = app.session(workerSessionId(ticketId));
  if (loaded === null || loaded.session.isDisposed()) {
    return [];
  }
  const left = new Set(state.left.get(ticketId));
  const now = nowMs();
  const jobs = await loaded.session.driver().jobs();
  const out: WorkerJob[] = [];
  for (const job of jobs) {
    if (!job.own || left.has(job.id)) {
      continue;
    }
    const item: WorkerJob = {
      id: job.id,
      type: job.kind,
      label: clip(firstLine(job.label), 200),
      startedAt: formatIso(job.startTime),
      elapsedSeconds: Math.max(0, Math.trunc((now - job.startTime) / 1000)),
    };
    if (job.progress !== undefined) {
      item.progress = takeLastChars(job.progress, 600);
    }
    if (job.command !== undefined) {
      item.command = clip(job.command, 300);
    }
    if (job.pids.length > 0) {
      item.pids = [...job.pids];
    }
    out.push(item);
  }
  return out;
}

/**
 * Cancel one hung or off-track background job of a ticket and wake its worker with why.
 * When the runtime cannot cancel a single job from outside (such as Antigravity), interrupts the
 * stalled worker runtime, cleans up hung child processes, and resumes the worker with the finding.
 */
export async function cancelJob(
  app: AppContext,
  state: ExecutorState,
  ticketId: string,
  jobId: string,
  reason: string,
): Promise<boolean> {
  const loaded = app.session(workerSessionId(ticketId));
  if (loaded === null || loaded.session.isDisposed()) {
    return false;
  }
  const running = await runningJobs(app, state, ticketId);
  const target = running.find((job) => job.id === jobId);
  if (target === undefined) {
    return false;
  }
  const driver = loaded.session.driver();
  await driver.acknowledge([jobId]);
  if (!(await driver.cancel(jobId))) {
    const note = `[Watchdog] Interrupted stalled session to stop background job ${jobId} (${target.label}): ${reason}`;
    return interruptAndWake(app, state, ticketId, note, "watchdog-cancel");
  }
  const remaining = running.filter((job) => job.id !== jobId).map((job) => job.id);
  let note = `[Watchdog] Stopped background job ${jobId} (${target.label}): ${reason}`;
  if (remaining.length > 0) {
    note += ` Remaining background jobs: ${remaining.join(", ")}.`;
  }
  const stored = app.storeTicket(ticketId);
  const assignment = stored !== null && isTicketLive(stored) ? runningAssignment(stored) : undefined;
  const idle = remaining.length === 0 && !loaded.session.isStreaming();
  if (
    assignment === undefined ||
    state.unloadAfterEnd.has(ticketId) ||
    app.closing() ||
    app.paused()
  ) {
    if (idle) {
      await turnOver(app, state, ticketId, loaded, note);
    }
    return true;
  }
  state.wakeSeq += 1;
  const seq = state.wakeSeq;
  const requestId = key(["watchdog-cancel", ticketId, assignment.id, String(seq), nowIso()]);
  const prompt = `${note} Inspect current workspace and logs: recover or continue the remaining work, or call orchestrator_report (ready, blocked, failed or dropped).`;
  try {
    await loaded.session.send(requestId, [textBlock(prompt)], "steer", {}, []);
  } catch (error) {
    if (idle) {
      await turnOver(app, state, ticketId, loaded, note);
    }
    throw error;
  }
  return true;
}

/**
 * Interrupt a stalled or hung working turn (and any hung child/detached workspace processes) and
 * immediately resume the worker with a Watchdog recovery prompt.
 */
export async function interruptWorker(
  app: AppContext,
  state: ExecutorState,
  ticketId: string,
  reason: string,
): Promise<boolean> {
  const note = `[Watchdog] Interrupted stalled turn: ${reason}`;
  return interruptAndWake(app, state, ticketId, note, "watchdog-interrupt");
}

async function interruptAndWake(
  app: AppContext,
  state: ExecutorState,
  ticketId: string,
  note: string,
  requestKind: string,
): Promise<boolean> {
  const ticket = app.storeTicket(ticketId);
  if (ticket === null || !isTicketLive(ticket)) {
    return false;
  }
  const assignment = runningAssignment(ticket);
  if (assignment === undefined) {
    return false;
  }
  if (state.unloadAfterEnd.has(ticketId) || app.closing() || app.paused()) {
    return false;
  }
  const sessionId = workerSessionId(ticketId);
  let strayPids: number[] = [];
  const existing = app.session(sessionId);
  if (existing !== null) {
    // Begin disposal first so closing the hung runtime cannot emit a spurious waiting/failed relay.
    strayPids = await disposeAndCollectSessionPids(existing);
    await app.stopSession(sessionId);
  }
  const ticketDir = safeTicketDir(ticket);
  await cleanupWorkspacePids(ticketDir, strayPids);
  state.running.delete(ticketId);
  state.awaiting.delete(ticketId);
  state.left.delete(ticketId);
  app.jobsCache.delete(ticketId);

  const directory = ticket.execution?.directory ?? "";
  const loaded = await app.ensureSession(sessionId, "worker", directory, ticket.title, ticketId);
  state.wakeSeq += 1;
  const seq = state.wakeSeq;
  const requestId = key([requestKind, ticketId, assignment.id, String(seq), nowIso()]);
  const prompt = `${note} Inspect current workspace and logs: recover or continue the remaining work, or call orchestrator_report (ready, blocked, failed or dropped).`;
  await sendToWorker(state, loaded, ticketId, requestId, prompt, []);
  return true;
}

/** A worker's turn ended with nothing running: note it, and report for a worker that did not report itself. */
function workerEnded(
  app: AppContext,
  ticketId: string,
  loaded: Loaded,
  note: string | undefined,
): void {
  const ticket = app.storeTicket(ticketId);
  if (ticket === null || !isTicketLive(ticket)) {
    return;
  }
  const assignment = runningAssignment(ticket);
  if (assignment === undefined) {
    return;
  }
  if (app.closing()) {
    return;
  }
  try {
    app.engine.turnEnded(ticketId, assignment.id);
  } catch {
    // Match Rust `let _ = self.engine.turn_ended(...)`
  }
  const journal = loaded.session.journal();
  const text = (journal.lastAssistantText() ?? "").trim();
  if (journal.lastStopReason() === "error") {
    workerFailed(app, ticketId, text.length === 0 ? "The worker model request failed" : text);
    return;
  }
  if (handedOff(ticket)) {
    return;
  }
  const said = text.length === 0 ? (assignment.report?.summary ?? "") : text;
  const summaryParts: string[] = [];
  if (said.length > 0) {
    summaryParts.push(said);
  }
  if (note !== undefined && note.length > 0) {
    summaryParts.push(note);
  }
  const summary = summaryParts.join("\n\n");
  const reminder =
    "Worker ended its turn with no background job running and without a terminal orchestrator_report. If it is not waiting on an external event, call orchestrator_ticket_request_status so the worker records its report.";
  const relayText = summary.length > 0 ? `${summary}\n\n${reminder}` : reminder;
  try {
    app.store.atomic(() => {
      const updated = app.engine.report(ticketId, workerReport("waiting", summary));
      app.relay(resultRelay(updated, "waiting", relayText, null));
    });
  } catch {
    // Match Rust `let _ = self.store.atomic(...)`
  }
}

/** After a restart: restart or continue each Assignment that was running, and launch those still waiting. */
export function executorResume(app: AppContext, _state: ExecutorState): void {
  const open = app.store.openTickets();
  open.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const ticket of open) {
    const running = runningAssignment(ticket);
    if (running !== undefined) {
      try {
        app.engine.assignmentInterrupted(ticket.id, running.id);
      } catch {
        // Match Rust `let _ = self.engine.assignment_interrupted(...)`
      }
    } else {
      const latest = latestAssignment(ticket);
      if (latest !== undefined && latest.state === "pending" && !waitsForPerson(ticket)) {
        app.effects.enqueue(LAUNCH, latest.id, {
          ticketId: ticket.id,
          assignmentId: latest.id,
        });
      }
    }
  }
}
