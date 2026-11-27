/**
 * Shared application types, argument parser, and AppContext contract shared across
 * `sessions`, `chat`, `executor`, `resources`, `assess`, `tools`, `sidecar`,
 * `watchdog`, `wechat`, `wechat_typing`, `views`, and `app`.
 */

import type {
  Accept,
  Assignment,
  Candidate,
  DecisionKind,
  Engine,
  OutboundMessage,
  Policy,
  ReceiveResult,
  Ticket,
} from "../core/index.ts";
import type { Block, Entry, JobKind, KernelEvent, Session, ToolSpec } from "../kernel/index.ts";
import type { DeviceManager } from "../devices/index.ts";
import type { Store } from "../store/index.ts";
import type { AccountsState, AccountsView, LoginView } from "./accounts.ts";
import type { Effects, Failure } from "./effects.ts";
import type { HealthBoard } from "./health.ts";
import type { Kernels, ModelOption, SessionRole } from "./kernels.ts";
import type { Notice, Relay } from "./notices.ts";
import type { Outbox, Sent } from "./outbox.ts";
import type { Passes } from "./passes.ts";
import type { TicketSearchIndex } from "./recall.ts";
import type { Kernel, Settings } from "./settings.ts";
import type { Account, ChatAttachment, Protocol } from "./wechat_protocol.ts";

export type { ChatAttachment };

/** What a worktree name must be, in words for the model. */
export const WORKTREE_NAME_RULE =
  "Use 1–4 short English words in lowercase kebab-case (first word letters only, no leading digits), at most 32 characters";

/** Whether a ticket's requested short name is 1–4 lowercase kebab-case words of at most 32 characters. */
export function validWorktreeName(name: string): boolean {
  if (name.length === 0 || name.length > 32) return false;
  const words = name.split("-");
  if (words.length === 0 || words.length > 4) return false;
  const first = words[0];
  if (!first || !/^[a-z]+$/.test(first)) return false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (!word || !/^[a-z0-9]+$/.test(word)) return false;
  }
  return true;
}

/** The arguments of one tool call, read strictly. */
export class Args {
  readonly map: Record<string, unknown>;

  private constructor(map: Record<string, unknown>) {
    this.map = map;
  }

  static of(argumentsValue: unknown, allowed: readonly string[]): Args {
    if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) {
      throw new Error("The arguments must be an object");
    }
    const map = argumentsValue as Record<string, unknown>;
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(map)) {
      if (!allowedSet.has(key)) {
        throw new Error(`Unknown argument ${key}; the arguments are ${allowed.join(", ")}`);
      }
    }
    return new Args(map);
  }

  /** A string that is present and not blank. */
  text(name: string): string | undefined {
    const value = this.map[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    return undefined;
  }

  required(name: string): string {
    const value = this.text(name);
    if (value === undefined) {
      throw new Error(`${name} is required`);
    }
    return value;
  }

  get(name: string): unknown {
    return this.map[name];
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.map, name);
  }

  number(name: string, defaultValue: number, most: number): number {
    const value = this.map[name];
    if (value === undefined || value === null) {
      return defaultValue;
    }
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= most) {
      return value;
    }
    throw new Error(`${name} must be a whole number from 0 to ${most}`);
  }
}

/** Where the application keeps its state. */
export interface Machine {
  /** The data directory: database, session transcripts, ticket directories, attachments. */
  stateDir: string;
  /** Where WeChat's API is; its own addresses unless a test stands in for it. */
  wechat: Protocol;
  /** The application's own program, which stands in for blocked commands on Windows. */
  program?: string;
}

/** How often the Watchdog looks, and how long it waits before it asks (all durations in milliseconds). */
export interface WatchdogTimings {
  /** Between two passes. */
  intervalMs: number;
  /** How long a working ticket shows neither output nor CPU time before it is inspected. */
  stallMs: number;
  /** How long a working ticket may use CPU time without any output before it is inspected. */
  cpuOnlySilenceMs: number;
  /** Between two inspections of the same working ticket. */
  longTaskMs: number;
  /** How long a ticket is idle before it is inspected. */
  idleGraceMs: number;
  /** Between two inspections of a ticket that stays idle. */
  idleRecheckMs: number;
  /** How long after a report its reply may be missing before the main Session is reminded. */
  unrepliedGraceMs: number;
  /** The most one inspection turn takes. */
  turnTimeoutMs: number;
}

export function defaultWatchdogTimings(): WatchdogTimings {
  return {
    intervalMs: 3 * 60 * 1000,
    stallMs: 6 * 60 * 1000,
    cpuOnlySilenceMs: 30 * 60 * 1000,
    longTaskMs: 10 * 60 * 1000,
    idleGraceMs: 60 * 1000,
    idleRecheckMs: 3 * 60 * 1000,
    unrepliedGraceMs: 60 * 1000,
    turnTimeoutMs: 2 * 60 * 1000,
  };
}

/** Default wait before a read-only sidecar query sends a brief progress hint (ms). */
export const DEFAULT_SIDECAR_SLOW_HINT_MS = 6_000;

/** How long to wait for more chat messages before routing a burst. */
export interface Timings {
  /** After a WeChat message (ms). */
  wechatBurstMs: number;
  /** After a message typed into the app (ms). */
  webBurstMs: number;
  /** The Watchdog's pace. */
  watchdog: WatchdogTimings;
  /** How long a read-only sidecar query may run before sending a brief progress hint (ms); 0 disables. */
  sidecarSlowHintMs?: number;
}

export function defaultTimings(): Timings {
  return {
    wechatBurstMs: 0,
    webBurstMs: 0,
    watchdog: defaultWatchdogTimings(),
    sidecarSlowHintMs: DEFAULT_SIDECAR_SLOW_HINT_MS,
  };
}

/** A Session that is open. */
export interface Loaded {
  /** The Session. */
  session: Session;
  /** The kernel it was opened on; it stays there until it is closed. */
  kernel: Kernel;
  /** What it is for. */
  role: SessionRole;
  /** The ticket of a worker Session. */
  ticketId?: string;
}

/** The tools of a one-off Session. */
export interface OnceTools {
  /** The tools offered. */
  specs: ToolSpec[];
  /** Runs one of them. */
  call: (name: string, argumentsValue: unknown) => Promise<unknown>;
}

/** A chat message to take in. */
export interface ChatInput {
  /** `web` or `wechat`. */
  surface: "web" | "wechat";
  /** The sender's idempotency key: the same id is one message, however often it is sent. */
  messageId: string;
  /** Who wrote it. */
  sender: string;
  /** The conversation it belongs to. */
  conversation: string;
  /** What it says. */
  text: string;
  /** Files attached to it. */
  attachments: ChatAttachment[];
  /** When it was written, when the surface knows. */
  at?: string;
}

/** What became of a chat message. */
export interface ChatReceipt {
  /** Its entry in the chat transcript. */
  requestId: string;
  /** Its Trigger. */
  triggerId: string;
  /** Whether it was stored, a duplicate, or filtered. */
  result: ReceiveResult;
}

/** Why a request to stop a ticket's worker could not run. */
export type StopWorkerErrorKind = "not_found" | "already_ended" | "failed";

export class StopWorkerError extends Error {
  readonly kind: StopWorkerErrorKind;

  constructor(kind: StopWorkerErrorKind, message?: string) {
    super(
      message ??
        (kind === "not_found"
          ? "Worker not found"
          : kind === "already_ended"
            ? "Task has already ended"
            : "Failed to stop worker"),
    );
    this.name = "StopWorkerError";
    this.kind = kind;
  }

  static notFound(): StopWorkerError {
    return new StopWorkerError("not_found", "Worker not found");
  }

  static alreadyEnded(): StopWorkerError {
    return new StopWorkerError("already_ended", "Task has already ended");
  }

  static failed(reason: string): StopWorkerError {
    return new StopWorkerError("failed", reason);
  }
}

/** A background job of a ticket's worker, for views and the Watchdog. */
export interface WorkerJob {
  /** The runtime's id for it. */
  id: string;
  /** `bash`, `task` or `eval`. */
  type: JobKind;
  /** Its first line, as it shows. */
  label: string;
  /** When it started. */
  startedAt: string;
  /** How long it has run. */
  elapsedSeconds: number;
  /** Its latest progress. */
  progress?: string;
  /** The command line of a shell job. */
  command?: string;
  /** The process ids the runtime reports for it. */
  pids?: number[];
}

/** The WeChat bridge status as the app shows it. */
export type WeChatStateName = "disconnected" | "waiting" | "scaned" | "verify" | "connected" | "error";

export interface WeChatStatus {
  /** `disconnected`, `waiting`, `scaned`, `verify`, `connected` or `error`. */
  state: WeChatStateName;
  /** In words. */
  message: string;
  /** What the login QR code encodes, for the app to draw, while a login waits. */
  qrContent?: string;
  /** The bound user as a chat sender. */
  senderId?: string;
}

/** Cached model list state for a kernel. */
export interface ModelListEntry {
  at: number;
  listed: { ok: true; models: ModelOption[] } | { ok: false; error: string } | null;
}

/**
 * Full interface of `App` used by all `neo-app` behavior modules.
 * Keeps modules decoupled without circular class imports.
 */
export interface AppContext {
  readonly machine: Machine;
  readonly store: Store;
  readonly board: HealthBoard;
  readonly effects: Effects;
  readonly engine: Engine;
  readonly outbox: Outbox;
  readonly passes: Passes;
  readonly kernels: Kernels;
  readonly masterId: string;
  readonly liveTickets: Set<string>;
  readonly jobsCache: Map<string, { at: number; jobs: WorkerJob[] }>;
  readonly modelLists: Map<Kernel, ModelListEntry>;
  readonly accounts: AccountsState;
  readonly devices: DeviceManager;
  readonly stopSignal: AbortSignal;
  readonly sidecarSlowHintMs: number;

  // Core App methods
  settings(): Settings;
  policy(): Policy;
  paused(): boolean;
  closing(): boolean;
  saveSettings(next: Settings, source: string, block: string): Settings;
  syncBlocked(): void;
  quietly<T>(run: () => T): T;
  relay(relay: Relay): void;
  notify(notice: Notice): void;
  ticketIsLive(ticketId: string): boolean;

  // Sessions methods
  storeTicket(ticketId: string): Ticket | null;
  session(sessionId: string): Loaded | null;
  ensureSession(
    sessionId: string,
    role: SessionRole,
    cwd: string,
    prompt: string,
    ticketId?: string,
    onEvent?: (loaded: Loaded, event: KernelEvent) => void | Promise<void>,
  ): Promise<Loaded>;
  ensureOrchestrator(): Promise<Loaded>;
  stopSession(sessionId: string): Promise<void>;
  stopAllSessions(): Promise<void>;
  resetOrchestrator(): Promise<void>;
  reopenOrchestrator(): Promise<void>;
  applyModels(): Promise<void>;
  relayQueued(payload: unknown, requestId: string): Promise<void>;
  noticeQueued(payload: unknown, name: string): Promise<void>;
  presentChat(text: string, attachments: readonly ChatAttachment[], requestId: string, source: string): Promise<string>;
  publish(requestId: string, text: string): Promise<void>;
  chatTranscript(): Entry[];
  workerTranscript(ticketId: string): Entry[];
  runOnce(
    role: SessionRole,
    cwd: string,
    prompt: string,
    message: string,
    tools: OnceTools,
    timeoutMs: number,
  ): Promise<string>;

  // Chat methods
  receiveWeb(text: string, attachments: ChatAttachment[], messageId?: string): Promise<ChatReceipt>;
  receiveWeChat(
    messageId: string,
    userId: string,
    text: string,
    attachments: ChatAttachment[],
    at?: string,
  ): Promise<ChatReceipt>;
  receiveChat(input: ChatInput): Promise<ChatReceipt>;
  chatSend(message: OutboundMessage): Promise<Sent>;

  // Executor methods
  launchRoom(): number;
  workersBusy(): boolean;
  activeWorkers(): number;
  isWorkerActive(ticketId: string): boolean;
  busyTicketIds(): Set<string>;
  executionRoot(): string;
  executorPrepare(ticket: Ticket, accept: Accept): Ticket;
  executorStop(ticket: Ticket, assignment: Assignment, reason: string): void;
  stopWorkerTicket(ticketId: string): Promise<unknown>;
  launchQueued(payload: unknown): Promise<void>;
  deliverQueued(payload: unknown): Promise<void>;
  workerEvent(ticketId: string, loaded: Loaded, event: KernelEvent): Promise<void>;
  runningJobs(ticketId: string): Promise<WorkerJob[]>;
  cancelJob(ticketId: string, jobId: string, reason: string): Promise<boolean>;
  interruptWorker(ticketId: string, reason: string): Promise<boolean>;
  executorResume(): void;

  // Resources, Assess, Sidecar
  ensureSearchIndex(): TicketSearchIndex;
  readResource(resource: string, offset: number, limit?: number, ticketId?: string): unknown;
  candidateCard(candidate: Candidate): unknown;
  assessmentQueued(payload: unknown, evalId: string): Promise<void>;
  evalContext(triggerId: string): unknown;
  evalRead(args: Args): unknown;
  evalDecide(triggerId: string, fields: unknown): [DecisionKind, string, string | undefined];
  sidecarQueued(payload: unknown): Promise<void>;

  // Tools
  wrongLanguage(triggerId: string, field: string, text: string): string | null;
  mainTool(name: string, argumentsValue: unknown): Promise<unknown>;
  workerTool(ticketId: string, name: string, argumentsValue: unknown): Promise<unknown>;

  // Watchdog
  watchdogStart(): void;
  watchdogStop(): Promise<void>;
  watchdogTick(): Promise<void>;
  watchdogInspect(ticketId: string): Promise<unknown>;
  watchdogIntervene(argumentsValue: unknown): Promise<unknown>;

  // WeChat & Typing
  wechatAccount(): Account | null;
  wechatStatus(): WeChatStatus;
  wechatStart(): void;
  wechatStop(): Promise<void>;
  wechatConnect(): Promise<WeChatStatus>;
  wechatVerify(code: string): WeChatStatus;
  wechatDisconnect(): Promise<WeChatStatus>;
  wechatDeliver(id: string, text: string, userId: string): Promise<Sent>;
  wechatSendFile(filePath: string, caption?: string): Promise<unknown>;
  wechatSendTicketFile(filePath: string, caption?: string, ticketId?: string): Promise<unknown>;
  routerThinking(): boolean;
  agentsBusy(): boolean;

  // Views & Accounts
  healthView(): unknown;
  activityView(): Promise<unknown>;
  panelMessages(): unknown[];
  workerCards(): Promise<unknown[]>;
  workerDetail(ticketId: string): Promise<unknown | null>;
  reportKernels(): void;
  modelsKnown(kernel: Kernel): { ok: true; models: ModelOption[] } | { ok: false; error: string } | null;
  modelsView(): Promise<unknown>;
  updateModels(value: unknown): Promise<unknown>;
  installKernel(value: unknown): Promise<unknown>;
  accountsView(): Promise<AccountsView>;
  loginView(): LoginView | null;
  startLogin(value: unknown): Promise<{ login: LoginView | null }>;
  loginInput(value: unknown): Promise<{ login: LoginView | null }>;
  cancelLogin(): void;
  logout(value: unknown): Promise<AccountsView>;
  generalView(): unknown;
  updateGeneral(value: unknown): Promise<unknown>;
}

/** Re-export Failure and Block for convenience in behavior modules. */
export type { Block, Failure };
