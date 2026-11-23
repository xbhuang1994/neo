/**
 * Observable recovery state store, bounded ring buffers, secret redaction,
 * persistent attempt history, and SSE pub/sub.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { EntryMode } from "./config.ts";
import type { ProbeResult } from "./probe.ts";
import type { ProcessExitInfo } from "./process.ts";
import type { ResolvedWorkerConfig } from "./worker-config.ts";

export type DaemonPhase =
  | "starting"
  | "healthy"
  | "degraded"
  | "recovering"
  | "restarting"
  | "cooldown"
  | "stopping";

export type RecoveryEventKind =
  | "phase"
  | "probe"
  | "worker_init"
  | "worker_text"
  | "tool_start"
  | "tool_end"
  | "worker_log"
  | "worker_stderr"
  | "worker_result"
  | "error"
  | "info";

export interface RecoveryEvent {
  id: number;
  at: string;
  attemptId: number | null;
  kind: RecoveryEventKind;
  title: string;
  detail?: string;
  status?: "running" | "done" | "error" | "info";
  stepKey?: string;
  meta?: Record<string, unknown>;
}

export interface NeoLogLine {
  id: number;
  at: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface RecoveryAttempt {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  triggerReason: string;
  outcome: "running" | "recovered" | "failed" | "aborted";
  workerKernel: string;
  workerModel: string | null;
  workerBinary: string | null;
  workerSource: string;
  settingsRevision: number | null;
  conversationId: string | null;
  workerExitCode: number | null;
  workerSignal: string | null;
  summary: string;
  diagnosticsFile: string | null;
  events: RecoveryEvent[];
}

export interface DaemonSnapshot {
  version: string;
  daemonPid: number;
  mode: EntryMode;
  phase: DaemonPhase;
  phaseSince: string;
  startedAt: string;
  entryHost: string;
  entryPort: number;
  targetPort: number;
  targetPid: number | null;
  targetRunning: boolean;
  targetCommand: string;
  dataDir: string;
  repoDir: string;
  stateDir: string;
  lastHealthyAt: string | null;
  unavailableSince: string | null;
  unhealthyThresholdMs: number;
  minFailedProbes: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  consecutiveAttempts: number;
  maxAttempts: number;
  exhausted: boolean;
  nextRetryAt: string | null;
  lastProbe: ProbeResult | null;
  lastTargetExit: ProcessExitInfo | null;
  recoveryModeEnabled: boolean;
  recoveryModeSource: "sqlite" | "default";
  workerConfig: ResolvedWorkerConfig | null;
  activeAttempt: RecoveryAttempt | null;
  history: RecoveryAttempt[];
  events: RecoveryEvent[];
  neoLogs: NeoLogLine[];
}

export type StreamFrame =
  | { type: "snapshot"; data: DaemonSnapshot }
  | { type: "state"; data: Omit<DaemonSnapshot, "events" | "neoLogs" | "history"> }
  | { type: "event"; data: RecoveryEvent }
  | { type: "log"; data: NeoLogLine }
  | { type: "history"; data: RecoveryAttempt[] };

const MAX_EVENTS = 400;
const MAX_ATTEMPT_EVENTS = 250;
const MAX_NEO_LOGS = 300;
const MAX_HISTORY = 20;

export function createRedactor(secret?: string): (text: string) => string {
  const token = secret?.trim();
  if (!token || token.length < 4) {
    return (text: string) => text;
  }
  return (text: string) => (text.includes(token) ? text.replaceAll(token, "[REDACTED]") : text);
}

export class RecoveryStateStore {
  private readonly version: string;
  private readonly mode: EntryMode;
  private readonly entryHost: string;
  private entryPort: number;
  private targetPort: number;
  private readonly targetCommand: string;
  private readonly dataDir: string;
  private readonly repoDir: string;
  private readonly stateDir: string;
  private readonly unhealthyThresholdMs: number;
  private readonly minFailedProbes: number;
  private readonly maxAttempts: number;
  readonly redact: (text: string) => string;

  private readonly startedAt = new Date().toISOString();
  private phase: DaemonPhase = "starting";
  private phaseSince = this.startedAt;
  private targetPid: number | null = null;
  private targetRunning = false;
  private lastHealthyAt: string | null = null;
  private unavailableSince: string | null = null;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private consecutiveAttempts = 0;
  private exhausted = false;
  private nextRetryAt: string | null = null;
  private lastProbe: ProbeResult | null = null;
  private lastTargetExit: ProcessExitInfo | null = null;
  private recoveryModeEnabled = true;
  private recoveryModeSource: "sqlite" | "default" = "default";
  private workerConfig: ResolvedWorkerConfig | null = null;
  private activeAttempt: RecoveryAttempt | null = null;
  private history: RecoveryAttempt[] = [];
  private readonly events: RecoveryEvent[] = [];
  private readonly neoLogs: NeoLogLine[] = [];

  private nextEventId = 1;
  private nextLogId = 1;
  private nextAttemptId = 1;
  private readonly subscribers = new Set<(frame: StreamFrame) => void>();

  constructor(opts: {
    version: string;
    mode: EntryMode;
    entryHost: string;
    entryPort: number;
    targetPort: number;
    targetCommand: string;
    dataDir: string;
    repoDir: string;
    stateDir: string;
    unhealthyThresholdMs: number;
    minFailedProbes: number;
    maxAttempts: number;
    token?: string;
  }) {
    this.version = opts.version;
    this.mode = opts.mode;
    this.entryHost = opts.entryHost;
    this.entryPort = opts.entryPort;
    this.targetPort = opts.targetPort;
    this.targetCommand = opts.targetCommand;
    this.dataDir = opts.dataDir;
    this.repoDir = opts.repoDir;
    this.stateDir = opts.stateDir;
    this.unhealthyThresholdMs = opts.unhealthyThresholdMs;
    this.minFailedProbes = opts.minFailedProbes;
    this.maxAttempts = opts.maxAttempts;
    this.redact = createRedactor(opts.token);

    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
    } catch {
      // handled later if persistence unavailable
    }
    this.loadHistory();
  }

  private historyPath(): string {
    return path.join(this.stateDir, "history.json");
  }

  private eventsLogPath(): string {
    return path.join(this.stateDir, "events.jsonl");
  }

  private loadHistory(): void {
    try {
      const raw = fs.readFileSync(this.historyPath(), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.history = parsed.slice(-MAX_HISTORY) as RecoveryAttempt[];
        let maxId = 0;
        for (const item of this.history) {
          if (typeof item.id === "number" && item.id > maxId) {
            maxId = item.id;
          }
        }
        this.nextAttemptId = maxId + 1;
      }
    } catch {
      // no previous history yet
    }
  }

  private saveHistory(): void {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const tmp = `${this.historyPath()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.history, null, 2), "utf8");
      fs.renameSync(tmp, this.historyPath());
    } catch {
      // best-effort persistence
    }
  }

  private appendEventLog(event: RecoveryEvent): void {
    try {
      fs.appendFileSync(this.eventsLogPath(), `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // best-effort persistence
    }
  }

  private broadcast(frame: StreamFrame): void {
    for (const listener of this.subscribers) {
      try {
        listener(frame);
      } catch {
        // isolate subscriber errors
      }
    }
  }

  private emitState(): void {
    const snap = this.snapshot();
    const { events: _e, neoLogs: _l, history: _h, ...statePart } = snap;
    this.broadcast({ type: "state", data: statePart });
  }

  subscribe(listener: (frame: StreamFrame) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  getPhase(): DaemonPhase {
    return this.phase;
  }

  getEntryPort(): number {
    return this.entryPort;
  }

  getTargetPort(): number {
    return this.targetPort;
  }

  getUnavailableSinceMs(): number | null {
    return this.unavailableSince ? Date.parse(this.unavailableSince) : null;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getConsecutiveSuccesses(): number {
    return this.consecutiveSuccesses;
  }

  getConsecutiveAttempts(): number {
    return this.consecutiveAttempts;
  }

  getLastHealthyAtMs(): number | null {
    return this.lastHealthyAt ? Date.parse(this.lastHealthyAt) : null;
  }

  getNextRetryAtMs(): number | null {
    return this.nextRetryAt ? Date.parse(this.nextRetryAt) : null;
  }

  getRecentNeoLogs(limit = 80): NeoLogLine[] {
    return this.neoLogs.slice(-limit);
  }

  getLastAttempt(): RecoveryAttempt | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  setPorts(entryPort: number, targetPort: number): void {
    this.entryPort = entryPort;
    this.targetPort = targetPort;
    this.emitState();
  }

  setTargetProcess(pid: number | null, running: boolean, exitInfo?: ProcessExitInfo): void {
    this.targetPid = pid;
    this.targetRunning = running;
    if (exitInfo) {
      this.lastTargetExit = {
        ...exitInfo,
        error: exitInfo.error ? this.redact(exitInfo.error) : undefined,
      };
    }
    this.emitState();
  }

  setPhase(next: DaemonPhase, note?: string): void {
    const changed = this.phase !== next;
    this.phase = next;
    if (changed) {
      this.phaseSince = new Date().toISOString();
    }
    if (note) {
      this.emitEvent({
        kind: "phase",
        title: note,
        status: next === "healthy" ? "done" : next === "cooldown" ? "error" : "info",
        meta: { phase: next },
      });
    }
    this.emitState();
  }

  getRecoveryModeEnabled(): boolean {
    return this.recoveryModeEnabled;
  }

  setRecoveryMode(enabled: boolean, source: "sqlite" | "default"): boolean {
    const changed = this.recoveryModeEnabled !== enabled || this.recoveryModeSource !== source;
    const toggled = this.recoveryModeEnabled !== enabled;
    this.recoveryModeEnabled = enabled;
    this.recoveryModeSource = source;
    if (changed) {
      this.emitState();
    }
    return toggled;
  }

  setWorkerConfig(cfg: ResolvedWorkerConfig): void {
    this.workerConfig = {
      ...cfg,
      warning: cfg.warning ? this.redact(cfg.warning) : undefined,
    };
    this.recoveryModeEnabled = cfg.recoveryMode;
    this.recoveryModeSource = cfg.recoveryModeSource;
    this.emitState();
  }

  setCooldown(nextRetryAtMs: number | null, exhausted: boolean): void {
    this.nextRetryAt = nextRetryAtMs !== null ? new Date(nextRetryAtMs).toISOString() : null;
    this.exhausted = exhausted;
    this.emitState();
  }

  resetConsecutiveAttempts(): void {
    if (this.consecutiveAttempts !== 0 || this.exhausted) {
      this.consecutiveAttempts = 0;
      this.exhausted = false;
      this.emitState();
    }
  }

  recordProbe(result: ProbeResult): void {
    const clean: ProbeResult = {
      ...result,
      reason: this.redact(result.reason),
    };
    this.lastProbe = clean;
    if (clean.ok) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses += 1;
      this.unavailableSince = null;
      this.lastHealthyAt = clean.at;
      this.nextRetryAt = null;
    } else {
      this.consecutiveSuccesses = 0;
      this.consecutiveFailures += 1;
      if (this.unavailableSince === null) {
        this.unavailableSince = clean.at;
      }
    }
    this.emitState();
  }

  markUnavailableNow(reason: string): void {
    const at = new Date().toISOString();
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures += 1;
    if (this.unavailableSince === null) {
      this.unavailableSince = at;
    }
    this.lastProbe = {
      ok: false,
      statusCode: null,
      latencyMs: 0,
      at,
      reason: this.redact(reason),
    };
    this.emitState();
  }

  appendNeoLog(stream: "stdout" | "stderr" | "system", text: string): void {
    const clean = this.redact(text);
    const entry: NeoLogLine = {
      id: this.nextLogId++,
      at: new Date().toISOString(),
      stream,
      text: clean,
    };
    this.neoLogs.push(entry);
    if (this.neoLogs.length > MAX_NEO_LOGS) {
      this.neoLogs.splice(0, this.neoLogs.length - MAX_NEO_LOGS);
    }
    this.broadcast({ type: "log", data: entry });
  }

  startAttempt(triggerReason: string, worker: ResolvedWorkerConfig, diagnosticsFile: string | null): RecoveryAttempt {
    this.consecutiveAttempts += 1;
    const attempt: RecoveryAttempt = {
      id: this.nextAttemptId++,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      triggerReason: this.redact(triggerReason),
      outcome: "running",
      workerKernel: worker.kernel,
      workerModel: worker.model,
      workerBinary: worker.binary,
      workerSource: worker.source,
      settingsRevision: worker.settingsRevision,
      conversationId: null,
      workerExitCode: null,
      workerSignal: null,
      summary: "",
      diagnosticsFile,
      events: [],
    };
    this.activeAttempt = attempt;
    this.nextRetryAt = null;
    this.emitState();
    return attempt;
  }

  setAttemptConversation(conversationId: string): void {
    if (this.activeAttempt) {
      this.activeAttempt.conversationId = conversationId;
      this.emitState();
    }
  }

  setAttemptWorkerExit(code: number | null, signal: string | null): void {
    if (this.activeAttempt) {
      this.activeAttempt.workerExitCode = code;
      this.activeAttempt.workerSignal = signal;
      this.emitState();
    }
  }

  finishAttempt(outcome: "recovered" | "failed" | "aborted", summary: string): RecoveryAttempt | null {
    const attempt = this.activeAttempt;
    if (!attempt) return null;
    attempt.outcome = outcome;
    attempt.finishedAt = new Date().toISOString();
    attempt.summary = this.redact(summary);
    this.activeAttempt = null;
    this.history.push(attempt);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    this.saveHistory();
    this.broadcast({ type: "history", data: this.history });
    this.emitState();
    return attempt;
  }

  emitEvent(input: {
    kind: RecoveryEventKind;
    title: string;
    detail?: string;
    status?: "running" | "done" | "error" | "info";
    stepKey?: string;
    meta?: Record<string, unknown>;
    persist?: boolean;
  }): RecoveryEvent {
    const now = new Date().toISOString();
    const cleanTitle = this.redact(input.title);
    const cleanDetail = input.detail !== undefined ? this.redact(input.detail) : undefined;
    const attemptId = this.activeAttempt?.id ?? null;

    if (input.stepKey) {
      const existing = this.events.find((e) => e.stepKey === input.stepKey);
      if (existing) {
        existing.at = now;
        existing.kind = input.kind;
        existing.title = cleanTitle;
        if (cleanDetail !== undefined) existing.detail = cleanDetail;
        if (input.status !== undefined) existing.status = input.status;
        if (input.meta !== undefined) existing.meta = { ...(existing.meta ?? {}), ...input.meta };
        if (this.activeAttempt) {
          const inAttempt = this.activeAttempt.events.find((e) => e.stepKey === input.stepKey);
          if (inAttempt) {
            Object.assign(inAttempt, existing);
          }
        }
        if (input.persist !== false) {
          this.appendEventLog(existing);
        }
        this.broadcast({ type: "event", data: existing });
        return existing;
      }
    }

    const event: RecoveryEvent = {
      id: this.nextEventId++,
      at: now,
      attemptId,
      kind: input.kind,
      title: cleanTitle,
      detail: cleanDetail,
      status: input.status ?? "info",
      stepKey: input.stepKey,
      meta: input.meta,
    };

    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    if (this.activeAttempt) {
      this.activeAttempt.events.push({ ...event });
      if (this.activeAttempt.events.length > MAX_ATTEMPT_EVENTS) {
        this.activeAttempt.events.splice(0, this.activeAttempt.events.length - MAX_ATTEMPT_EVENTS);
      }
    }
    if (input.persist !== false) {
      this.appendEventLog(event);
    }
    this.broadcast({ type: "event", data: event });
    return event;
  }

  snapshot(): DaemonSnapshot {
    return {
      version: this.version,
      daemonPid: process.pid,
      mode: this.mode,
      phase: this.phase,
      phaseSince: this.phaseSince,
      startedAt: this.startedAt,
      entryHost: this.entryHost,
      entryPort: this.entryPort,
      targetPort: this.targetPort,
      targetPid: this.targetPid,
      targetRunning: this.targetRunning,
      targetCommand: this.targetCommand,
      dataDir: this.dataDir,
      repoDir: this.repoDir,
      stateDir: this.stateDir,
      lastHealthyAt: this.lastHealthyAt,
      unavailableSince: this.unavailableSince,
      unhealthyThresholdMs: this.unhealthyThresholdMs,
      minFailedProbes: this.minFailedProbes,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      consecutiveAttempts: this.consecutiveAttempts,
      maxAttempts: this.maxAttempts,
      exhausted: this.exhausted,
      nextRetryAt: this.nextRetryAt,
      lastProbe: this.lastProbe,
      lastTargetExit: this.lastTargetExit,
      recoveryModeEnabled: this.recoveryModeEnabled,
      recoveryModeSource: this.recoveryModeSource,
      workerConfig: this.workerConfig,
      activeAttempt: this.activeAttempt,
      history: this.history,
      events: this.events,
      neoLogs: this.neoLogs,
    };
  }
}
