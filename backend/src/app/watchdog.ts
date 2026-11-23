//! The Watchdog: a periodic control loop beside the work. It filters healthy long-running work without a model call,
//! by process CPU time and workspace file changes; puts back a launch, delivery or reply the queues lost; and asks a
//! one-off Session about a ticket only when it has stalled, sits idle with nothing to wake it, failed in a way that
//! may pass, or still has not been answered.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  canRetry,
  formatIso,
  isTicketLive,
  key,
  latestAssignment,
  latestReport,
  nowIso,
  nowMs,
  parseIso,
  runningAssignment,
  ticketInputTriggerId,
  ticketStage,
  waitsForPerson,
  workerReport,
} from "../core/index.ts";
import type { Ticket } from "../core/index.ts";
import { errorMessage } from "../kernel/index.ts";
import type { Entry, ToolSpec } from "../kernel/index.ts";
import {
  assignmentLine,
  cardState,
  charCount,
  inputLine,
  newestPage,
  ticketCard,
} from "./cards.ts";
import { Args, defaultWatchdogTimings } from "./context.ts";
import type { AppContext, OnceTools, WatchdogTimings, WorkerJob } from "./context.ts";
import { DELIVERY, LAUNCH, RELAY } from "./effects.ts";
import { Health } from "./health.ts";
import { reportRelay, resultRelay, stateName } from "./notices.ts";
import type { Relay } from "./notices.ts";
import { inDirectory, tree } from "./procinfo.ts";
import type { ProcessSnapshot } from "./procinfo.ts";
import { watchdogSystem } from "./prompts.ts";
import { clip } from "./text.ts";

export { defaultWatchdogTimings };
export type { WatchdogTimings };

export const MAX_AUTO_RETRIES = 2;
export const MAX_AUTO_INTERRUPTS = 2;
export const MAX_RELAY_NUDGES = 2;
export const MAX_MANUAL_RELAY_NUDGES = 2;
export const RECENT_WINDOW_MS = 24 * 60 * 60_000;
export const WATCHDOG_HISTORY_KEY = "watchdog-history";
export const MAX_WATCHDOG_HISTORY = 100;
export const MAX_FILES = 200;
export const MAX_DEPTH = 2;

const MAX_TIMEOUT_MS = 2_147_483_647;

const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  "target",
]);

const PRIMARY_LOG_EXTS: ReadonlySet<string> = new Set(["log", "out", "err", "txt"]);
const FALLBACK_LOG_EXTS: ReadonlySet<string> = new Set(["md", "csv", "json"]);

const UTF8_LOSSY_DECODER = new TextDecoder("utf-8", { fatal: false });

/** A workspace file, in a patrol. Wire JSON keys match Rust `FileInfo` verbatim. */
export interface FileInfo {
  path: string;
  bytes: number;
  age_seconds: number;
}

/** The newest log's last lines. Wire JSON keys match Rust `LogTail` verbatim. */
export interface LogTail {
  file: string;
  tail: string;
}

/** Result of scanning a ticket workspace directory. */
export interface Scan {
  recent: FileInfo[];
  latest_mtime: number;
  total_bytes: number;
  count: number;
  log_tail?: LogTail;
}

/** One persisted Watchdog audit record in SQLite `kv["watchdog-history"]`. */
export interface WatchdogEvent {
  at: string;
  kind: string;
  ticket_id?: string;
  detail: string;
}

/** What one look at a ticket found. */
export interface Sample {
  processes: ProcessSnapshot[];
  process_count: number;
  cpu: number;
  recent: FileInfo[];
  latest_mtime: number;
  latest_transcript_at: number;
  /** Changes whenever the ticket, its transcript, its files or its jobs' output do. */
  signature: string;
  log_tail?: LogTail;
}

/** What the Watchdog remembers of a ticket between passes. */
export interface Activity {
  signature: string;
  last_output_at: number;
  cpu: number;
  patrolled_at?: number;
  patrolled_signature?: string;
  note?: string;
}

/** How a ticket moved since the last pass. */
export interface Delta {
  output_changed: boolean;
  cpu_delta: number;
  silent_ms: number;
}

const DELTA_NONE: Delta = { output_changed: false, cpu_delta: 0, silent_ms: 0 };

function deltaJson(delta: Delta): Record<string, unknown> {
  return {
    output_changed: delta.output_changed,
    cpu_ticks_delta: delta.cpu_delta,
    output_silent_seconds: Math.trunc(delta.silent_ms / 1000),
  };
}

function emptyScan(): Scan {
  return {
    recent: [],
    latest_mtime: 0,
    total_bytes: 0,
    count: 0,
  };
}

function defaultActivity(): Activity {
  return {
    signature: "",
    last_output_at: 0,
    cpu: 0,
  };
}

function workerSessionId(ticketId: string): string {
  return `worker-${ticketId}`;
}

/** The last `limit` Unicode scalar values (characters) of `text`, in O(limit) time. */
function tailChars(text: string, limit: number): string {
  if (limit <= 0 || text.length === 0) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  let count = 0;
  let i = text.length;
  while (i > 0 && count < limit) {
    i -= 1;
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
      const prev = text.charCodeAt(i - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) {
        i -= 1;
      }
    }
    count += 1;
  }
  return i === 0 ? text : text.slice(i);
}

/**
 * The last `maxLines` lines within the last `maxBytes` bytes of a file; `undefined` for an empty or unreadable one.
 * Seeks directly to `size - min(size, maxBytes)` so large logs are never loaded into memory.
 */
export function readTail(filePath: string, maxBytes: number, maxLines: number): string | undefined {
  if (maxBytes <= 0 || maxLines <= 0) {
    return undefined;
  }
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0) {
      return undefined;
    }
    const length = Math.min(stat.size, maxBytes);
    const startOffset = stat.size - length;
    const buffer = Buffer.allocUnsafe(length);
    let readTotal = 0;
    while (readTotal < length) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        readTotal,
        length - readTotal,
        startOffset + readTotal,
      );
      if (bytesRead <= 0) {
        break;
      }
      readTotal += bytesRead;
    }
    if (readTotal === 0) {
      return undefined;
    }
    const text = UTF8_LOSSY_DECODER.decode(buffer.subarray(0, readTotal));
    const lines = text.trimEnd().split("\n");
    const tail = lines
      .slice(Math.max(0, lines.length - maxLines))
      .join("\n")
      .trim();
    return tail.length > 0 ? tail : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors.
    }
  }
}

function hasExtension(filePath: string, extensions: ReadonlySet<string>): boolean {
  const ext = path.extname(filePath);
  if (ext.length <= 1) {
    return false;
  }
  return extensions.has(ext.slice(1).toLowerCase());
}

/**
 * The files of a ticket's directory, two levels deep and 200 at most, without hidden entries and dependency folders.
 */
export function scanWorkspace(directory: string | undefined, now: number): Scan {
  if (directory === undefined || directory.length === 0) {
    return emptyScan();
  }
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(directory);
  } catch {
    return emptyScan();
  }
  if (!rootStat.isDirectory()) {
    return emptyScan();
  }

  interface Found {
    relative: string;
    full: string;
    bytes: number;
    mtime: number;
  }

  const found: Found[] = [];

  const walk = (dir: string, relPrefix: string, depth: number): void => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (let i = 0; i < entries.length; i++) {
      if (found.length >= MAX_FILES) {
        break;
      }
      const entry = entries[i]!;
      const name = entry.name;
      if (name.startsWith(".") || IGNORED_DIRS.has(name)) {
        continue;
      }
      const full = path.join(dir, name);
      const relative = relPrefix.length === 0 ? name : `${relPrefix}/${name}`;
      if (entry.isDirectory()) {
        walk(full, relative, depth + 1);
      } else if (entry.isFile()) {
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(full);
        } catch {
          continue;
        }
        const mtime = Math.trunc(stat.mtimeMs);
        found.push({
          relative,
          full,
          bytes: stat.size,
          mtime: Number.isFinite(mtime) && mtime > 0 ? mtime : 0,
        });
      }
    }
  };

  walk(directory, "", 0);
  found.sort((a, b) => b.mtime - a.mtime);

  let log: Found | undefined;
  for (let i = 0; i < found.length; i++) {
    const item = found[i]!;
    if (item.bytes > 0 && hasExtension(item.relative, PRIMARY_LOG_EXTS)) {
      log = item;
      break;
    }
  }
  if (log === undefined) {
    for (let i = 0; i < found.length; i++) {
      const item = found[i]!;
      if (item.bytes > 0 && hasExtension(item.relative, FALLBACK_LOG_EXTS)) {
        log = item;
        break;
      }
    }
  }

  const recentCount = Math.min(8, found.length);
  const recent: FileInfo[] = new Array<FileInfo>(recentCount);
  for (let i = 0; i < recentCount; i++) {
    const item = found[i]!;
    recent[i] = {
      path: item.relative,
      bytes: item.bytes,
      age_seconds: Math.max(0, Math.trunc((now - item.mtime) / 1000)),
    };
  }

  let totalBytes = 0;
  for (let i = 0; i < found.length; i++) {
    totalBytes += found[i]!.bytes;
  }

  let logTail: LogTail | undefined;
  if (log !== undefined) {
    const tail = readTail(log.full, 4096, 25);
    if (tail !== undefined) {
      logTail = { file: log.relative, tail };
    }
  }

  const scan: Scan = {
    recent,
    latest_mtime: found.length > 0 ? found[0]!.mtime : 0,
    total_bytes: totalBytes,
    count: found.length,
  };
  if (logTail !== undefined) {
    scan.log_tail = logTail;
  }
  return scan;
}

function carried(
  previous: Activity | undefined,
  sample: Sample,
  lastOutputAt: number,
): Activity {
  const next: Activity = {
    signature: sample.signature,
    last_output_at: lastOutputAt,
    cpu: sample.cpu,
  };
  if (previous?.patrolled_at !== undefined) {
    next.patrolled_at = previous.patrolled_at;
  }
  if (previous?.patrolled_signature !== undefined) {
    next.patrolled_signature = previous.patrolled_signature;
  }
  if (previous?.note !== undefined) {
    next.note = previous.note;
  }
  return next;
}

/**
 * Judge a ticket whose worker is at work: what to remember, and how it moved when it should be inspected. Output
 * that changed, CPU time used within the silence allowed, a short silence, and a recent inspection all pass it.
 */
export function judgeWorking(
  previous: Activity | undefined,
  sample: Sample,
  started: number,
  now: number,
  timings: WatchdogTimings,
): [Activity, Delta | undefined] {
  const outputChanged = previous !== undefined && previous.signature !== sample.signature;
  const cpuDelta = previous !== undefined ? Math.max(0, sample.cpu - previous.cpu) : 0;
  const lastOutputAt = outputChanged
    ? now
    : previous !== undefined
      ? previous.last_output_at
      : Math.max(started, sample.latest_mtime, sample.latest_transcript_at);
  const silentMs = Math.max(0, now - lastOutputAt);
  const state = carried(previous, sample, lastOutputAt);
  const passes =
    outputChanged ||
    (cpuDelta > 0 && silentMs < timings.cpuOnlySilenceMs) ||
    silentMs < timings.stallMs ||
    now - (state.patrolled_at ?? 0) < timings.longTaskMs;
  if (passes) {
    return [state, undefined];
  }
  state.patrolled_at = now;
  state.patrolled_signature = sample.signature;
  return [state, { output_changed: false, cpu_delta: cpuDelta, silent_ms: silentMs }];
}

/**
 * Judge a ticket that is idle since `since`. A process of its directory that makes progress passes it; else it is
 * inspected after the grace, and again at the recheck interval, or the longer one while nothing at all has changed.
 */
export function judgeIdle(
  previous: Activity | undefined,
  sample: Sample,
  since: number,
  now: number,
  timings: WatchdogTimings,
): [Activity, Delta | undefined] {
  const outputChanged = previous !== undefined && previous.signature !== sample.signature;
  const cpuDelta = previous !== undefined ? Math.max(0, sample.cpu - previous.cpu) : 0;
  const lastOutputAt = outputChanged
    ? now
    : previous !== undefined
      ? previous.last_output_at
      : sample.latest_mtime > 0
        ? sample.latest_mtime
        : since;
  const state = carried(previous, sample, lastOutputAt);
  if (
    sample.process_count > 0 &&
    (outputChanged || (cpuDelta > 0 && now - lastOutputAt < timings.cpuOnlySilenceMs))
  ) {
    return [state, undefined];
  }
  const unchanged =
    state.patrolled_signature === sample.signature && sample.process_count === 0;
  const cooldown = unchanged ? timings.longTaskMs : timings.idleRecheckMs;
  if (now - since < timings.idleGraceMs || now - (state.patrolled_at ?? 0) < cooldown) {
    return [state, undefined];
  }
  state.patrolled_at = now;
  state.patrolled_signature = sample.signature;
  return [
    state,
    {
      output_changed: outputChanged,
      cpu_delta: cpuDelta,
      silent_ms: Math.max(0, now - lastOutputAt),
    },
  ];
}

/** What a transcript entry says, in at most 500 characters: its text, and each tool call by name and arguments. */
export function excerpt(entry: Entry): [role: "assistant" | "toolResult" | "custom", text: string] {
  const role: "assistant" | "toolResult" | "custom" =
    entry.type === "message"
      ? entry.message.role === "assistant"
        ? "assistant"
        : "toolResult"
      : "custom";
  const content = entry.type === "message" ? entry.message.content : entry.content;
  const parts: string[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i]!;
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "toolCall") {
      const serialized = JSON.stringify(block.arguments ?? null);
      parts.push(`[tool:${block.name}] ${clip(serialized, 240)}`);
    }
  }
  return [role, clip(parts.join("\n"), 500)];
}

interface WatchdogMemory {
  activity: Map<string, Activity>;
  failureSeen: Map<string, string>;
  healthSeen: Map<string, string>;
  relayNudges: Map<string, number>;
  manualRelayNudges: Map<string, [number, number]>;
  autoRetries: Map<string, number>;
  autoInterrupts: Map<string, number>;
  seq: number;
}

/**
 * Suspects and patrol markers gathered before calling the Watchdog Session; markers are committed only once the
 * inspection turn succeeds so a transient Watchdog error never permanently swallows a stalled or failed ticket.
 */
interface PatrolBatch {
  suspects: Record<string, unknown>[];
  healthErrors: Record<string, unknown>[];
  patrolledActivity: Array<[ticketId: string, signature: string]>;
  patrolledFailures: Array<[ticketId: string, updatedAt: string]>;
  patrolledHealth: Array<[component: string, marker: string]>;
  patrolledRelays: string[];
}

function emptyBatch(): PatrolBatch {
  return {
    suspects: [],
    healthErrors: [],
    patrolledActivity: [],
    patrolledFailures: [],
    patrolledHealth: [],
    patrolledRelays: [],
  };
}

/** The Watchdog's state within the application. */
export class WatchdogState {
  readonly timings: WatchdogTimings;
  /** @internal */
  readonly memory: WatchdogMemory = {
    activity: new Map<string, Activity>(),
    failureSeen: new Map<string, string>(),
    healthSeen: new Map<string, string>(),
    relayNudges: new Map<string, number>(),
    manualRelayNudges: new Map<string, [number, number]>(),
    autoRetries: new Map<string, number>(),
    autoInterrupts: new Map<string, number>(),
    seq: 0,
  };
  /** Held by the pass that runs (in-flight pass promise). @internal */
  activePass: Promise<void> | null = null;
  /** Active periodic patrol loop promise. @internal */
  loopTask: Promise<void> | null = null;
  /** Cancels any pending sleep timer for the periodic loop. @internal */
  cancelLoop: (() => void) | null = null;

  constructor(timings: WatchdogTimings = defaultWatchdogTimings()) {
    this.timings = { ...timings };
  }
}

const CACHED_WATCHDOG_SPECS: ToolSpec[] = [
  {
    name: "watchdog_inspect",
    description:
      "Inspect a ticket's inputs, assignments and a longer transcript, only when the evidence inlined in the patrol is not enough.",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ticket_id"],
      properties: {
        ticket_id: { type: "string" },
      },
    },
  },
  {
    name: "watchdog_intervene",
    description:
      "Intervene on a verified anomaly: wake a stranded worker, cancel one hung or off-track background job and wake its worker, interrupt a hung working turn/subprocesses and resume the worker, retry a ticket that failed transiently, or relay a report again whose reply is missing.",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "ticket_id", "message"],
      properties: {
        action: {
          type: "string",
          enum: [
            "wake_worker",
            "cancel_job",
            "interrupt_worker",
            "retry_ticket",
            "relay_report",
          ],
        },
        ticket_id: { type: "string" },
        job_id: { type: "string", description: "cancel_job: the background job's id." },
        message: {
          type: "string",
          maxLength: 1000,
          description: "The finding or the recovery instruction, short and factual.",
        },
      },
    },
  },
];

/** The Watchdog Session's tools (cached). */
export function watchdogSpecs(): ToolSpec[] {
  return CACHED_WATCHDOG_SPECS;
}

/** Log a Watchdog action or error to stderr and persist a bounded audit ring in `kv["watchdog-history"]`. */
function recordWatchdogEvent(
  app: AppContext,
  kind: string,
  ticketId: string | undefined,
  detail: string,
): void {
  const short = clip(detail, 320);
  if (ticketId !== undefined) {
    console.error(`[neo-agent] [watchdog] ${kind} ticket=${ticketId}: ${short}`);
  } else {
    console.error(`[neo-agent] [watchdog] ${kind}: ${short}`);
  }
  const existing = app.store.get<WatchdogEvent[]>(WATCHDOG_HISTORY_KEY);
  const history: WatchdogEvent[] = Array.isArray(existing) ? existing : [];
  const event: WatchdogEvent =
    ticketId !== undefined
      ? { at: nowIso(), kind, ticket_id: ticketId, detail: short }
      : { at: nowIso(), kind, detail: short };
  history.push(event);
  if (history.length > MAX_WATCHDOG_HISTORY) {
    history.splice(0, history.length - MAX_WATCHDOG_HISTORY);
  }
  app.store.set(WATCHDOG_HISTORY_KEY, history);
}

/** Start the periodic passes. */
export function watchdogStart(app: AppContext, state: WatchdogState): void {
  if (state.loopTask !== null || app.closing() || app.stopSignal.aborted) {
    return;
  }
  app.board.set("watchdog", Health.ready("Watchdog control loop is ready"));

  const intervalMs = Math.min(Math.max(0, state.timings.intervalMs), MAX_TIMEOUT_MS);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wakeSleep: (() => void) | undefined;

  const cancel = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const wake = wakeSleep;
    wakeSleep = undefined;
    wake?.();
  };

  const onAbort = (): void => {
    cancel();
  };
  app.stopSignal.addEventListener("abort", onAbort, { once: true });
  state.cancelLoop = cancel;

  const sleepInterval = (): Promise<void> => {
    if (stopped || app.closing() || app.stopSignal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (wakeSleep === done) {
          wakeSleep = undefined;
        }
        resolve();
      };
      wakeSleep = done;
      timer = setTimeout(done, intervalMs);
      timer.unref?.();
    });
  };

  let loop: Promise<void> | null = null;
  loop = (async (): Promise<void> => {
    try {
      while (!stopped && !app.closing() && !app.stopSignal.aborted) {
        await sleepInterval();
        if (stopped || app.closing() || app.stopSignal.aborted) {
          break;
        }
        await watchdogTick(app, state);
      }
    } finally {
      app.stopSignal.removeEventListener("abort", onAbort);
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (state.loopTask === loop) {
        state.loopTask = null;
      }
      if (state.cancelLoop === cancel) {
        state.cancelLoop = null;
      }
    }
  })();

  state.loopTask = loop;
}

/** Stop the periodic passes, after the one that runs. */
export async function watchdogStop(_app: AppContext, state: WatchdogState): Promise<void> {
  const cancel = state.cancelLoop;
  const loop = state.loopTask;
  state.cancelLoop = null;
  state.loopTask = null;
  cancel?.();
  if (loop !== null) {
    await loop;
  }
  if (state.activePass !== null) {
    await state.activePass;
  }
}

/** Run one Watchdog pass; a caller that finds one running waits for that one instead. */
export async function watchdogTick(app: AppContext, state: WatchdogState): Promise<void> {
  if (app.closing() || app.paused()) {
    return;
  }
  if (state.activePass !== null) {
    await state.activePass;
    return;
  }
  let release!: () => void;
  const passDone = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.activePass = passDone;
  try {
    await watchdogPatrol(app, state);
  } catch (err) {
    if (!app.closing()) {
      const error = errorMessage(err);
      app.board.set("watchdog", Health.error(`Watchdog patrol failed: ${error}`));
      recordWatchdogEvent(app, "patrol_error", undefined, error);
    }
  } finally {
    if (state.activePass === passDone) {
      state.activePass = null;
    }
    release();
  }
}

async function watchdogPatrol(app: AppContext, state: WatchdogState): Promise<void> {
  const now = nowMs();
  healQueues(app);
  const lingering = healUnreplied(app, state, now);
  if (app.closing() || app.paused()) {
    return;
  }
  const batch = await collectSuspects(app, state, now, lingering);
  if (batch.suspects.length === 0 && batch.healthErrors.length === 0) {
    app.board.set("watchdog", Health.ready("All active tickets and queues are healthy"));
    return;
  }
  const problem = app.kernels.unavailable(app.settings().kernel);
  if (problem !== undefined) {
    throw new Error(`Watchdog kernel unavailable: ${problem}`);
  }
  const patrol: Record<string, unknown> = {
    kind: "watchdog_patrol",
    at: formatIso(now),
    suspects: batch.suspects,
  };
  if (batch.healthErrors.length > 0) {
    patrol.health_errors = batch.healthErrors;
  }
  const summaryLabels = batch.suspects.map((s) => {
    const kind = typeof s.kind === "string" ? s.kind : "?";
    const tid = typeof s.ticket_id === "string" ? s.ticket_id : "?";
    return `${kind}:${clip(tid, 8)}`;
  });
  console.error(
    `[neo-agent] [watchdog] patrolling ${batch.suspects.length} suspect(s) [${summaryLabels.join(", ")}], ${batch.healthErrors.length} health error(s)`,
  );
  const tools: OnceTools = {
    specs: watchdogSpecs(),
    call: async (name: string, argumentsValue: unknown): Promise<unknown> => {
      if (app.closing()) {
        throw new Error("neo-agent is stopping");
      }
      switch (name) {
        case "watchdog_inspect": {
          const ticketId = Args.of(argumentsValue, ["ticket_id"]).required("ticket_id");
          return watchdogInspect(app, state, ticketId);
        }
        case "watchdog_intervene":
          return watchdogIntervene(app, state, argumentsValue);
        default:
          throw new Error(`Unknown tool ${name}`);
      }
    },
  };
  const prompt = watchdogSystem(app.settings());
  const note = await app.runOnce(
    "watchdog",
    app.machine.stateDir,
    prompt,
    JSON.stringify(patrol),
    tools,
    state.timings.turnTimeoutMs,
  );
  const memory = state.memory;
  for (let i = 0; i < batch.patrolledActivity.length; i++) {
    const [ticketId, sig] = batch.patrolledActivity[i]!;
    let entry = memory.activity.get(ticketId);
    if (entry === undefined) {
      entry = defaultActivity();
      memory.activity.set(ticketId, entry);
    }
    entry.patrolled_at = now;
    entry.patrolled_signature = sig;
  }
  for (let i = 0; i < batch.patrolledFailures.length; i++) {
    const [ticketId, updatedAt] = batch.patrolledFailures[i]!;
    memory.failureSeen.set(ticketId, updatedAt);
  }
  for (let i = 0; i < batch.patrolledHealth.length; i++) {
    const [component, marker] = batch.patrolledHealth[i]!;
    memory.healthSeen.set(component, marker);
  }
  for (let i = 0; i < batch.patrolledRelays.length; i++) {
    const missingKey = batch.patrolledRelays[i]!;
    const existing = memory.manualRelayNudges.get(missingKey);
    const nextCount = existing !== undefined ? existing[0] + 1 : 1;
    memory.manualRelayNudges.set(missingKey, [nextCount, now]);
  }
  if (note.length > 0) {
    const clippedNote = clip(note, 200);
    for (let i = 0; i < batch.suspects.length; i++) {
      const suspect = batch.suspects[i]!;
      const tid = suspect.ticket_id;
      if (typeof tid === "string") {
        const entry = memory.activity.get(tid);
        if (entry !== undefined) {
          entry.note = clippedNote;
        }
      }
    }
  }
  recordWatchdogEvent(
    app,
    "patrol",
    undefined,
    `inspected ${batch.suspects.length} suspect(s) [${summaryLabels.join(", ")}], ${batch.healthErrors.length} health error(s): ${clip(note, 160)}`,
  );
  app.board.set("watchdog", Health.ready(`Inspected ${batch.suspects.length} suspect ticket(s)`));
}

/** Queue again a launch that is pending or a delivery that is due, when its effect is gone. */
function healQueues(app: AppContext): void {
  let changed = false;
  const open = app.store.openTickets();
  for (let i = 0; i < open.length; i++) {
    const ticket = open[i]!;
    if (waitsForPerson(ticket)) {
      continue;
    }
    if (runningAssignment(ticket) !== undefined) {
      if (ticket.undelivered.length > 0 && !app.effects.pending(DELIVERY, ticket.id)) {
        app.effects.enqueue(DELIVERY, ticket.id, { ticketId: ticket.id });
        recordWatchdogEvent(app, "heal_queue", ticket.id, "re-enqueued missing delivery effect");
        changed = true;
      }
    } else {
      const latest = latestAssignment(ticket);
      if (latest !== undefined && latest.state === "pending") {
        if (!app.effects.pending(LAUNCH, latest.id)) {
          app.effects.enqueue(LAUNCH, latest.id, {
            ticketId: ticket.id,
            assignmentId: latest.id,
          });
          recordWatchdogEvent(
            app,
            "heal_queue",
            ticket.id,
            `re-enqueued missing launch effect for assignment ${latest.id}`,
          );
          changed = true;
        }
      }
    }
  }
  if (changed) {
    app.passes.pump();
  }
}

/**
 * Remind the main Session of each report, question or answer a person has not been sent, twice at most; the
 * tickets still unanswered after that go to an inspection (bounded by {@link MAX_MANUAL_RELAY_NUDGES}).
 */
function healUnreplied(
  app: AppContext,
  state: WatchdogState,
  now: number,
): Array<[ticket: Ticket, missingKey: string]> {
  const main = app.session(app.masterId);
  if (app.effects.pending(RELAY) || (main !== null && main.session.isStreaming())) {
    return [];
  }
  const lingering: Array<[Ticket, string]> = [];
  let nudged = false;
  const recent = app.store.recentTickets(50);
  for (let i = 0; i < recent.length; i++) {
    const ticket = recent[i]!;
    const missing = missingReply(app, state, ticket, now);
    if (missing === undefined) {
      continue;
    }
    const current = state.memory.relayNudges.get(missing) ?? 0;
    if (current < MAX_RELAY_NUDGES) {
      const attempt = current + 1;
      state.memory.relayNudges.set(missing, attempt);
      if (relayMissing(app, ticket, `auto:${attempt}`)) {
        recordWatchdogEvent(app, "auto_relay", ticket.id, `auto:${attempt} (${missing})`);
        nudged = true;
      }
    } else {
      lingering.push([ticket, missing]);
    }
  }
  if (nudged) {
    app.passes.pump();
  }
  return lingering;
}

/** What a person is still owed for a ticket, as a key that is new for each thing owed. */
function missingReply(
  app: AppContext,
  state: WatchdogState,
  ticket: Ticket,
  now: number,
): string | undefined {
  const grace = state.timings.unrepliedGraceMs;
  if (ticket.attention !== undefined && isTicketLive(ticket)) {
    const updatedAtMs = parseIso(ticket.updatedAt) ?? now;
    if (
      now - updatedAtMs < grace ||
      app.store.replyStatus(key(["attention-reply", ticket.attention.id])) !== undefined
    ) {
      return undefined;
    }
    return `attention:${ticket.id}:${ticket.attention.id}`;
  }
  const report = latestReport(ticket);
  if (report === undefined) {
    return undefined;
  }
  // Routine progress and waiting reports never owe a human reply (open attention questions are checked above).
  if (report.state === "progress" || report.state === "waiting") {
    return undefined;
  }
  const reportAtMs = parseIso(report.at);
  if (reportAtMs === undefined) {
    return undefined;
  }
  const age = now - reportAtMs;
  if (age < grace || age > RECENT_WINDOW_MS) {
    return undefined;
  }
  const replied = app.store.repliedSince(ticket.id, report.at);
  if (!replied) {
    const answer = pendingAnswer(app, ticket);
    if (answer !== undefined) {
      return `answer:${ticket.id}:${report.at}:${answer}`;
    }
  }
  const origin = app.store.trigger(ticket.origin.triggerId);
  if (origin === undefined || !origin.human || origin.channel === undefined) {
    return undefined;
  }
  const ready =
    ticket.ended !== undefined
      ? ticket.ended.outcome === "completed"
      : runningAssignment(ticket)?.report?.state === "ready";
  return ready && !replied ? `result:${ticket.id}:${report.at}` : undefined;
}

/**
 * The first pending answer trigger not already satisfied by a reply on an earlier ended assignment.
 * For a dropped report, only considers triggers delivered to the latest assignment so stale entries from an
 * earlier assignment do not loop relays on a handback drop.
 */
function pendingAnswer(app: AppContext, ticket: Ticket): string | undefined {
  const answers = ticket.answers;
  if (answers === undefined || answers.length === 0) {
    return undefined;
  }
  const latestId = latestAssignment(ticket)?.id;
  const dropped = latestReport(ticket)?.state === "dropped";
  for (let i = 0; i < answers.length; i++) {
    const id = answers[i]!;
    const input = ticket.inputs.find((item) => ticketInputTriggerId(item) === id);
    if (dropped) {
      const deliveredHere =
        (input !== undefined &&
          input.kind === "trigger" &&
          input.deliveredTo !== undefined &&
          input.deliveredTo === latestId) ||
        (input === undefined &&
          ticket.origin.triggerId === id &&
          ticket.assignments.length === 1);
      if (!deliveredHere) {
        continue;
      }
    }
    let earlierReplied = false;
    if (input !== undefined && input.kind === "trigger" && input.deliveredTo !== undefined) {
      const ended = ticket.assignments.find(
        (assignment) =>
          assignment.id === input.deliveredTo && assignment.state === "ended",
      );
      if (ended?.report !== undefined) {
        earlierReplied = app.store.repliedSince(ticket.id, ended.report.at);
      }
    }
    if (!earlierReplied) {
      return id;
    }
  }
  return undefined;
}

/** Relay a ticket's open question or latest report to the main Session again, under a request id of its own. */
function relayMissing(app: AppContext, ticket: Ticket, tag: string): boolean {
  const report = latestReport(ticket);
  let relay: Relay | undefined;
  if (ticket.attention !== undefined && isTicketLive(ticket)) {
    const asked = workerReport(report?.state ?? "progress", report?.summary ?? "", {
      question: { kind: "ask", question: ticket.attention.question },
    });
    relay = reportRelay(ticket, asked);
  } else if (report !== undefined) {
    const answerTo = !app.store.repliedSince(ticket.id, report.at)
      ? pendingAnswer(app, ticket)
      : undefined;
    const state =
      ticket.ended?.outcome === "completed" ? "ready" : stateName(report.state);
    relay = resultRelay(ticket, state, report.summary, answerTo);
  }
  if (relay === undefined) {
    return false;
  }
  app.relay({ id: `watchdog:${relay.id}:${tag}`, text: relay.text });
  return true;
}

function recentTranscript(
  app: AppContext,
  ticketId: string,
  count: number,
): Array<Record<string, unknown>> {
  const loaded = app.session(workerSessionId(ticketId));
  let startIndex: number;
  let entries: Entry[];
  if (loaded !== null) {
    [startIndex, entries] = loaded.session.journal().entriesTail(count * 3);
  } else {
    startIndex = 0;
    entries = app.workerTranscript(ticketId);
  }
  const lines: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < entries.length; offset++) {
    const entry = entries[offset]!;
    const [role, text] = excerpt(entry);
    if (text.length > 0) {
      lines.push({
        index: startIndex + offset,
        role,
        at: entry.timestamp,
        text,
      });
    }
  }
  return lines.slice(Math.max(0, lines.length - count));
}

function transcriptActivity(app: AppContext, ticketId: string): [signature: string, atMs: number] {
  const loaded = app.session(workerSessionId(ticketId));
  let startIndex: number;
  let entries: Entry[];
  if (loaded !== null) {
    [startIndex, entries] = loaded.session.journal().entriesTail(1);
  } else {
    const all = app.workerTranscript(ticketId);
    if (all.length === 0) {
      return ["", 0];
    }
    startIndex = all.length - 1;
    entries = [all[all.length - 1]!];
  }
  if (entries.length === 0) {
    return ["", 0];
  }
  const last = entries[entries.length - 1]!;
  const index = startIndex + (entries.length - 1);
  const ts = last.timestamp;
  return [`${index}:${ts}`, parseIso(ts) ?? 0];
}

/**
 * Look at a ticket's workload processes and files, excluding the worker runtime process itself (`driverPid`) so an
 * idle or stuck CLI process never masquerades as active computation or a detached job, while still seeing child
 * processes spawned by the worker even when they run in another working directory.
 */
async function sampleTicket(
  app: AppContext,
  ticket: Ticket,
  jobs: readonly WorkerJob[],
  now: number,
): Promise<Sample> {
  const directory = ticket.execution?.directory;
  const driverPid = app.session(workerSessionId(ticket.id))?.session.driver().pid();
  const [transcriptSig, latestTranscriptAt] = transcriptActivity(app, ticket.id);
  const roots: number[] = [];
  const pipes: string[] = new Array<string>(jobs.length);
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!;
    if (job.pids !== undefined) {
      for (let j = 0; j < job.pids.length; j++) {
        roots.push(job.pids[j]!);
      }
    }
    const progress = job.progress ?? "";
    const tail = tailChars(progress, 64);
    pipes[i] = `${job.id}:${Buffer.byteLength(progress, "utf8")}:${tail}`;
  }

  if (directory !== undefined && directory.length > 0) {
    let canonical = directory;
    try {
      canonical = fs.realpathSync(directory);
    } catch {
      // Keep original directory path when canonicalization fails.
    }
    const dirPids = inDirectory(canonical);
    for (let i = 0; i < dirPids.length; i++) {
      roots.push(dirPids[i]!);
    }
  }
  if (driverPid !== undefined) {
    roots.push(driverPid);
  }
  const ownPid = process.pid;
  const allProcesses = tree(roots);
  const processes: ProcessSnapshot[] = [];
  let cpu = 0;
  for (let i = 0; i < allProcesses.length; i++) {
    const proc = allProcesses[i]!;
    if (proc.pid !== ownPid && proc.pid !== driverPid) {
      processes.push(proc);
      cpu += proc.cpu_ticks;
    }
  }
  const files = scanWorkspace(directory, now);
  const sample: Sample = {
    process_count: processes.length,
    cpu,
    processes: processes.length > 16 ? processes.slice(0, 16) : processes,
    signature: `${ticket.updatedAt}|${transcriptSig}|${files.count}:${files.total_bytes}:${files.latest_mtime}|${pipes.join("|")}`,
    recent: files.recent,
    latest_mtime: files.latest_mtime,
    latest_transcript_at: latestTranscriptAt,
  };
  if (files.log_tail !== undefined) {
    sample.log_tail = files.log_tail;
  }
  return sample;
}

function buildSuspect(
  app: AppContext,
  kind: string,
  ticket: Ticket,
  jobs: readonly WorkerJob[],
  sample: Sample,
  delta: Delta,
  elapsedMs: number | undefined,
  note: string | undefined,
): Record<string, unknown> {
  const loaded = app.session(workerSessionId(ticket.id));
  const streaming =
    loaded !== null && !loaded.session.isDisposed() && loaded.session.isStreaming();
  const suspect: Record<string, unknown> = {
    kind,
    ticket_id: ticket.id,
    title: ticket.title,
    scope: ticket.mandate.scope,
    state: cardState(ticket),
    session: {
      loaded: loaded !== null,
      streaming,
      worker_active: app.isWorkerActive(ticket.id),
    },
    running_jobs: jobs,
    process_tree: sample.processes,
    activity_delta: deltaJson(delta),
    recent_files: sample.recent,
    recent_transcript: recentTranscript(app, ticket.id, 6),
  };
  if (ticket.execution !== undefined) {
    suspect.directory = ticket.execution.directory;
  }
  if (elapsedMs !== undefined) {
    suspect.elapsed_seconds = Math.trunc(elapsedMs / 1000);
  }
  if (sample.log_tail !== undefined) {
    suspect.latest_log_tail = sample.log_tail;
  }
  const report = latestReport(ticket);
  if (report !== undefined) {
    suspect.latest_report = {
      state: report.state,
      at: report.at,
      preview: clip(report.summary, 320),
    };
  }
  if (ticket.delivery !== undefined) {
    suspect.delivery_error = ticket.delivery.error;
  }
  if (note !== undefined) {
    suspect.previous_patrol_note = note;
  }
  return suspect;
}

async function collectSuspects(
  app: AppContext,
  state: WatchdogState,
  now: number,
  lingering: ReadonlyArray<readonly [ticket: Ticket, missingKey: string]>,
): Promise<PatrolBatch> {
  const timings = state.timings;
  const open = app.store.openTickets();
  const openIds = new Set<string>();
  for (let i = 0; i < open.length; i++) {
    openIds.add(open[i]!.id);
  }
  for (const id of state.memory.activity.keys()) {
    if (!openIds.has(id)) {
      state.memory.activity.delete(id);
    }
  }

  const batch = emptyBatch();
  const seen = new Set<string>();

  for (let i = 0; i < open.length; i++) {
    const ticket = open[i]!;
    const stage = ticketStage(ticket);
    const running = runningAssignment(ticket);
    const jobs = await app.runningJobs(ticket.id);
    const sample = await sampleTicket(app, ticket, jobs, now);
    const previous = state.memory.activity.get(ticket.id);
    const loaded = app.session(workerSessionId(ticket.id));
    const sessionStreaming =
      loaded !== null && !loaded.session.isDisposed() && loaded.session.isStreaming();
    const workerActive = app.isWorkerActive(ticket.id) || sessionStreaming || jobs.length > 0;

    let judged:
      | {
          kind: string;
          result: [Activity, Delta | undefined];
          since: number;
        }
      | undefined;

    if (stage.kind === "idle") {
      const sinceIso = running?.report?.at ?? ticket.updatedAt;
      const since = parseIso(sinceIso) ?? now;
      judged = {
        kind: "idle_without_followup",
        result: judgeIdle(previous, sample, since, now, timings),
        since,
      };
    } else if (stage.kind === "working" && !stage.queued && running !== undefined) {
      if (!workerActive && ticket.undelivered.length === 0) {
        // Ticket thinks it is working, yet no runtime turn, job, launch or delivery is active: stranded.
        const started = parseIso(running.startedAt ?? ticket.createdAt) ?? now;
        const since = Math.max(started, sample.latest_transcript_at);
        judged = {
          kind: "idle_without_followup",
          result: judgeIdle(previous, sample, since, now, timings),
          since,
        };
      } else {
        const started = parseIso(running.startedAt ?? ticket.createdAt) ?? now;
        judged = {
          kind: "long_running_worker",
          result: judgeWorking(previous, sample, started, now, timings),
          since: started,
        };
      }
    }

    if (judged !== undefined) {
      const [nextState, delta] = judged.result;
      const note = nextState.note;
      if (delta !== undefined) {
        // Defer committing patrolled_at/patrolled_signature until runOnce succeeds.
        if (previous?.patrolled_at !== undefined) {
          nextState.patrolled_at = previous.patrolled_at;
        } else {
          delete nextState.patrolled_at;
        }
        if (previous?.patrolled_signature !== undefined) {
          nextState.patrolled_signature = previous.patrolled_signature;
        } else {
          delete nextState.patrolled_signature;
        }
        batch.patrolledActivity.push([ticket.id, sample.signature]);
        seen.add(ticket.id);
        batch.suspects.push(
          buildSuspect(
            app,
            judged.kind,
            ticket,
            jobs,
            sample,
            delta,
            Math.max(0, now - judged.since),
            note,
          ),
        );
      }
      state.memory.activity.set(ticket.id, nextState);
      continue;
    }

    const failed =
      ticket.delivery !== undefined || latestAssignment(ticket)?.report?.state === "failed";
    if (canRetry(ticket) && failed) {
      const autoRetries = state.memory.autoRetries.get(ticket.id) ?? 0;
      const fresh =
        autoRetries < MAX_AUTO_RETRIES &&
        state.memory.failureSeen.get(ticket.id) !== ticket.updatedAt;
      if (fresh) {
        batch.patrolledFailures.push([ticket.id, ticket.updatedAt]);
        seen.add(ticket.id);
        batch.suspects.push(
          buildSuspect(
            app,
            "delivery_or_transient_failure",
            ticket,
            jobs,
            sample,
            DELTA_NONE,
            undefined,
            undefined,
          ),
        );
      }
    }
  }

  for (let i = 0; i < lingering.length; i++) {
    const [ticket, missingKey] = lingering[i]!;
    const patrolled = state.memory.activity.get(ticket.id)?.patrolled_at ?? 0;
    const manual = state.memory.manualRelayNudges.get(missingKey);
    const manualCount = manual !== undefined ? manual[0] : 0;
    const lastManual = manual !== undefined ? manual[1] : 0;
    const skip =
      seen.has(ticket.id) ||
      now - patrolled < timings.unrepliedGraceMs ||
      manualCount >= MAX_MANUAL_RELAY_NUDGES ||
      (manualCount > 0 && now - lastManual < timings.longTaskMs);
    if (skip) {
      continue;
    }
    const jobs = await app.runningJobs(ticket.id);
    const sample = await sampleTicket(app, ticket, jobs, now);
    const previous = state.memory.activity.get(ticket.id);
    const nextActivity: Activity = {
      signature: sample.signature,
      last_output_at: now,
      cpu: sample.cpu,
    };
    if (previous?.patrolled_at !== undefined) {
      nextActivity.patrolled_at = previous.patrolled_at;
    }
    if (previous?.patrolled_signature !== undefined) {
      nextActivity.patrolled_signature = previous.patrolled_signature;
    }
    if (previous?.note !== undefined) {
      nextActivity.note = previous.note;
    }
    state.memory.activity.set(ticket.id, nextActivity);
    batch.patrolledActivity.push([ticket.id, sample.signature]);
    batch.patrolledRelays.push(missingKey);
    seen.add(ticket.id);
    batch.suspects.push(
      buildSuspect(
        app,
        "unreplied_ticket",
        ticket,
        jobs,
        sample,
        DELTA_NONE,
        undefined,
        undefined,
      ),
    );
  }

  for (const [component, health] of Object.entries(app.board.all())) {
    if (component === "watchdog" || health.state !== "error") {
      continue;
    }
    const marker = `${health.at}:${health.detail}`;
    if (state.memory.healthSeen.get(component) === marker) {
      continue;
    }
    batch.patrolledHealth.push([component, marker]);
    batch.healthErrors.push({
      component,
      detail: health.detail,
      at: health.at,
    });
  }

  return batch;
}

/** A ticket in more depth than a patrol inlines, for the Watchdog Session. */
export async function watchdogInspect(
  app: AppContext,
  _state: WatchdogState,
  ticketId: string,
): Promise<unknown> {
  const ticket = app.storeTicket(ticketId);
  if (ticket === null) {
    throw new Error(`Unknown ticket: ${ticketId}`);
  }
  const loaded = app.session(workerSessionId(ticketId));
  return {
    ticket: ticketCard(ticket),
    directory: ticket.execution?.directory ?? null,
    scope: ticket.mandate.scope,
    answers_pending: ticket.answers ?? [],
    delivery: ticket.delivery ?? null,
    session: {
      loaded: loaded !== null,
      streaming:
        loaded !== null && !loaded.session.isDisposed() && loaded.session.isStreaming(),
      worker_active: app.isWorkerActive(ticketId),
    },
    running_jobs: await app.runningJobs(ticketId),
    assignments: newestPage(ticket.assignments, 0, 3, (item) => assignmentLine(ticket, item))[0],
    inputs: newestPage(ticket.inputs, 0, 8, (input) => inputLine(ticket, input))[0],
    recent_transcript: recentTranscript(app, ticketId, 12),
  };
}

/**
 * Act on what a patrol found: wake a worker, cancel a job, interrupt a hung worker, retry a ticket, or relay a
 * report again.
 */
export async function watchdogIntervene(
  app: AppContext,
  state: WatchdogState,
  argumentsValue: unknown,
): Promise<unknown> {
  const args = Args.of(argumentsValue, ["action", "ticket_id", "job_id", "message"]);
  const action = args.required("action");
  const ticketId = args.required("ticket_id");
  const message = args.required("message").trim();
  if (charCount(message) > 1000) {
    throw new Error("message has at most 1000 characters");
  }
  const ticket = app.storeTicket(ticketId);
  if (ticket === null) {
    throw new Error(`Unknown ticket: ${ticketId}`);
  }

  switch (action) {
    case "wake_worker": {
      const woken = app.engine.wakeWorker(ticketId, message);
      if (woken) {
        app.passes.pump();
      }
      recordWatchdogEvent(app, "intervene", ticketId, `wake_worker woken=${woken}: ${message}`);
      return { action, ticket_id: ticketId, woken };
    }
    case "cancel_job": {
      const jobId = args.text("job_id");
      if (jobId === undefined) {
        throw new Error("cancel_job requires job_id");
      }
      const cancelled = await app.cancelJob(ticketId, jobId, message);
      recordWatchdogEvent(
        app,
        "intervene",
        ticketId,
        `cancel_job job=${jobId} cancelled=${cancelled}: ${message}`,
      );
      return { action, ticket_id: ticketId, job_id: jobId, cancelled };
    }
    case "interrupt_worker": {
      const refused = (reason: string): Record<string, unknown> => {
        recordWatchdogEvent(
          app,
          "intervene",
          ticketId,
          `interrupt_worker refused (${reason}): ${message}`,
        );
        return { action, ticket_id: ticketId, interrupted: false, reason };
      };
      if (!isTicketLive(ticket) || runningAssignment(ticket) === undefined) {
        return refused("Ticket has no running worker");
      }
      if ((state.memory.autoInterrupts.get(ticketId) ?? 0) >= MAX_AUTO_INTERRUPTS) {
        return refused("Auto-interrupt limit reached");
      }
      const interrupted = await app.interruptWorker(ticketId, message);
      if (interrupted) {
        state.memory.autoInterrupts.set(
          ticketId,
          (state.memory.autoInterrupts.get(ticketId) ?? 0) + 1,
        );
      }
      recordWatchdogEvent(
        app,
        "intervene",
        ticketId,
        `interrupt_worker interrupted=${interrupted}: ${message}`,
      );
      return { action, ticket_id: ticketId, interrupted };
    }
    case "retry_ticket": {
      const refused = (reason: string): Record<string, unknown> => {
        recordWatchdogEvent(
          app,
          "intervene",
          ticketId,
          `retry_ticket refused (${reason}): ${message}`,
        );
        return { action, ticket_id: ticketId, retried: false, reason };
      };
      const used = state.memory.autoRetries.get(ticketId) ?? 0;
      if (used >= MAX_AUTO_RETRIES) {
        return refused("Auto-retry limit reached");
      }
      if (!canRetry(ticket)) {
        return refused("Ticket is not retryable");
      }
      state.memory.autoRetries.set(ticketId, used + 1);
      app.engine.retryTicket(ticketId);
      app.passes.pump();
      recordWatchdogEvent(app, "intervene", ticketId, `retry_ticket retried=true: ${message}`);
      return { action, ticket_id: ticketId, retried: true };
    }
    case "relay_report": {
      state.memory.seq += 1;
      const tag = `manual:${state.memory.seq}`;
      const relayed = relayMissing(app, ticket, tag);
      if (relayed) {
        app.passes.pump();
      }
      recordWatchdogEvent(
        app,
        "intervene",
        ticketId,
        `relay_report relayed=${relayed} tag=${tag}: ${message}`,
      );
      return { action, ticket_id: ticketId, relayed };
    }
    default:
      throw new Error(
        "action is wake_worker, cancel_job, interrupt_worker, retry_ticket or relay_report",
      );
  }
}
