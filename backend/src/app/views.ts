/**
 * What the app shows and changes: the conversation, the workers, health, and the settings,
 * each as the JSON the API carries.
 */

import {
  latestAssignment,
  parseIso,
  ticketStage,
  type AssignmentState,
  type Attention,
  type DeliveryFailure,
  type PersonAction,
  type Report,
  type Ticket,
  type TicketInput,
  type TicketOutcome,
  type TicketStage,
} from "../core/index.ts";
import {
  entrySource,
  entryTimestamp,
  textOf,
  type Entry,
  type JobKind,
} from "../kernel/index.ts";
import { VERSION } from "../version.ts";
import type { AppContext, WorkerJob } from "./context.ts";
import { Health, type ComponentHealth } from "./health.ts";
import {
  kernelInstall,
  kernelInstalled,
  kernelInstalling,
  kernelInstallProgress,
  type ModelOption,
} from "./kernels.ts";
import {
  cloneSettings,
  DEFAULT_KERNEL,
  defaultRoleModels,
  kernelAsStr,
  limits,
  parseBlock,
  roleModels,
  type EvalConfig,
  type ExecutorConfig,
  type Kernel,
  type PolicyConfig,
  type RoleModel,
} from "./settings.ts";
import { clip } from "./text.ts";

/** How old a kernel's model list may be before it is listed again in the background (60s). */
export const MODEL_LIST_STALE_MS = 60_000;

/** How long a worker's background jobs are cached across overlapping UI poll requests (750ms). */
export const JOBS_CACHE_TTL_MS = 750;

/** The longest line the activity ticker shows of what a worker does. */
const DOING_CHARS = 80;

const TELLING_FIELDS = [
  "description",
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "summary",
  "prompt",
  "text",
] as const;

/** Wire representation of a ticket's stage. */
export interface StageView {
  stage: "person" | "working" | "idle" | "ended";
  action?: PersonAction | "queued";
}

/** Wire payload of `GET /api/health`. */
export interface HealthView {
  ready: boolean;
  version: string;
  kernel: string;
  paused: boolean;
  activeWorkers: number;
  components: Record<string, ComponentHealth>;
}

/** One busy worker entry inside `GET /api/activity`. */
export interface ActivityWorkerView {
  ticketId: string;
  title: string;
  doing: string;
}

/** Wire payload of `GET /api/activity`. */
export interface ActivityView {
  router: boolean;
  workers: ActivityWorkerView[];
}

/** One inline image attached to a visible panel message. */
export interface PanelImageView {
  name: string;
  mediaType: string;
  data: string;
}

/** One non-image file attached to a visible panel message. */
export interface PanelFileView {
  name: string;
  mediaType: string;
  kind: "text" | "file";
}

/** One visible message inside `GET /api/messages`. */
export interface PanelMessageView {
  id: number;
  role: "user" | "assistant";
  text: string;
  source: string;
  at?: number;
  images?: PanelImageView[];
  files?: PanelFileView[];
}

/** One background job on a worker card. */
export interface WorkerBackgroundJobView {
  id: string;
  type: JobKind;
  label: string;
  startedAt: string;
  elapsedSeconds: number;
  progress: string | null;
}

/** Session status sub-object on a worker card. */
export interface WorkerSessionView {
  loaded: boolean;
  streaming: boolean;
}

/** Assignment sub-object on a worker card. */
export interface WorkerAssignmentView {
  id: string;
  state: AssignmentState;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  deliveredAt: string | null;
  idleAt: string | null;
}

/** One worker card returned by `GET /api/workers`. */
export interface WorkerCardView {
  ticketId: string;
  title: string;
  stage: StageView;
  outcome: TicketOutcome | null;
  updatedAt: string;
  createdAt: string;
  directory: string | null;
  digest: string | null;
  session: WorkerSessionView;
  background: WorkerBackgroundJobView[];
  assignment: WorkerAssignmentView | null;
  progress: Report | null;
  attention: Attention | null;
  pendingInputs: number;
  delivery: DeliveryFailure | null;
}

/** One input entry on a worker detail view. */
export type WorkerInputView = TicketInput & { delivered: boolean };

/** One recent transcript line on a worker detail view. */
export interface WorkerRecentEntryView {
  id: number;
  role: "assistant" | "toolResult" | "custom";
  text: string;
  at?: number;
}

/** Wire payload of `GET /api/workers/{ticketId}`. */
export interface WorkerDetailView extends WorkerCardView {
  inputs: WorkerInputView[];
  recent: WorkerRecentEntryView[];
}

/** Cached model listing result for a kernel, or `null` while the first listing runs. */
export type KnownModelList =
  | { ok: true; models: ModelOption[] }
  | { ok: false; error: string }
  | null;

/** Wire payload of `GET /api/settings/models`, `PUT /api/settings/models`, and `POST /api/settings/kernel/install`. */
export interface ModelsView {
  kernel: string;
  installed: boolean;
  installing: boolean;
  installProgress: string | null;
  problem: string | null;
  listProblem: string | null;
  loading: boolean;
  current: {
    eval: RoleModel | null;
    executor: RoleModel | null;
  };
  available: ModelOption[];
}

/** Wire payload of `GET /api/settings/general` and `PUT /api/settings/general`. */
export interface GeneralView {
  paused: boolean;
  eval: EvalConfig;
  executor: ExecutorConfig;
  policy: PolicyConfig;
  defaults: {
    directory: string;
  };
  limits: {
    ruleName: number;
    ruleInstruction: number;
    evalTimeoutSeconds: [number, number];
    maxWorkers: [number, number];
    prepareCommand: number;
  };
}

function workerSessionId(ticketId: string): string {
  return `worker-${ticketId}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  if (nl === -1) {
    return text;
  }
  return nl > 0 && text.charCodeAt(nl - 1) === 0x0d ? text.slice(0, nl - 1) : text.slice(0, nl);
}

function firstNonEmptyTrimmedLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function lastNonEmptyTrimmedLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

/** A ticket's stage as the app reads it: `stage`, and for some an `action`. */
export function stageJson(stage: TicketStage): StageView {
  switch (stage.kind) {
    case "person":
      return { stage: "person", action: stage.action };
    case "working":
      return stage.queued ? { stage: "working", action: "queued" } : { stage: "working" };
    case "idle":
      return { stage: "idle" };
    case "ended":
      return { stage: "ended" };
  }
}

/** Validate that `value` is a JSON object containing only fields from `allowed`. */
export function objectKeys(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("Expected a JSON object");
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`Unknown field ${key}; the fields are ${allowed.join(", ")}`);
    }
  }
  return value;
}

/**
 * What a worker's transcript entry did, in at most 4000 characters:
 * text, images by a mark, tool calls by name and arguments.
 */
function activity(entry: Entry): ["assistant" | "toolResult" | "custom", string] {
  const role: "assistant" | "toolResult" | "custom" =
    entry.type === "message"
      ? entry.message.role === "assistant"
        ? "assistant"
        : "toolResult"
      : "custom";
  const content = entry.type === "message" ? entry.message.content : entry.content;
  const parts: string[] = new Array(content.length);
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i];
    switch (block.type) {
      case "text":
        parts[i] = block.text;
        break;
      case "image":
        parts[i] = "[图片]";
        break;
      case "toolCall":
        parts[i] = `[调用 ${block.name}]\n${clip(JSON.stringify(block.arguments ?? null), 2000)}`;
        break;
    }
  }
  return [role, clip(parts.join("\n"), 4000)];
}

/** What a tool call does, in a line: its name and its telling argument. */
function toolLine(name: string, argumentsValue: unknown): string {
  if (isPlainObject(argumentsValue)) {
    for (const field of TELLING_FIELDS) {
      const raw = argumentsValue[field];
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          return `${name} · ${firstLine(trimmed)}`;
        }
      }
    }
  }
  return name;
}

/** What a worker's transcript says it is doing now: its latest tool call, else the latest line it wrote. */
function doing(entries: readonly Entry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    const content = entry.message.content;
    for (let j = content.length - 1; j >= 0; j -= 1) {
      const block = content[j];
      if (block.type === "toolCall") {
        return toolLine(block.name, block.arguments);
      }
      if (block.type === "text") {
        const line = lastNonEmptyTrimmedLine(block.text);
        if (line !== undefined) {
          return line;
        }
      }
    }
  }
  return undefined;
}

/** The files a chat entry says were attached: name, media type, and whether it is an image, an inlined text or a file. */
function entryAttachments(entry: Entry): Array<[string, string, "image" | "text" | "file"]> {
  if (entry.type !== "custom_message" || !isPlainObject(entry.details)) {
    return [];
  }
  const raw = entry.details.attachments;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<[string, string, "image" | "text" | "file"]> = [];
  for (const info of raw) {
    if (!isPlainObject(info) || typeof info.name !== "string") {
      continue;
    }
    const mediaType =
      typeof info.mediaType === "string" ? info.mediaType : "application/octet-stream";
    const kind: "image" | "text" | "file" = mediaType.startsWith("image/")
      ? "image"
      : mediaType.startsWith("text/")
        ? "text"
        : "file";
    out.push([info.name, mediaType, kind]);
  }
  return out;
}

function kernelNamed(value: unknown): Kernel {
  if (value === undefined || value === null || value === "antigravity") {
    return "antigravity";
  }
  throw new Error("kernel must be antigravity");
}

function selection(fields: Record<string, unknown>, name: string): RoleModel | null {
  if (!Object.prototype.hasOwnProperty.call(fields, name)) {
    throw new Error(`${name} is required; null follows the kernel's default`);
  }
  const value = fields[name];
  if (value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new Error(`${name}: expected a JSON object`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "provider" && key !== "model") {
      throw new Error(`${name}: unknown field \`${key}\`, expected \`provider\` or \`model\``);
    }
  }
  if (typeof value.provider !== "string") {
    throw new Error(`${name}: missing or invalid field \`provider\``);
  }
  if (typeof value.model !== "string") {
    throw new Error(`${name}: missing or invalid field \`model\``);
  }
  if (value.provider.trim().length === 0 || value.model.trim().length === 0) {
    throw new Error(`${name} needs a provider and a model`);
  }
  return { provider: value.provider, model: value.model };
}

function activeWorkerCount(app: AppContext): number {
  const maybeActive = (app as AppContext & { activeWorkers?: () => number }).activeWorkers;
  if (typeof maybeActive === "function") {
    return maybeActive.call(app);
  }
  const busy = app.busyTicketIds();
  if (busy.size === 0) {
    return 0;
  }
  let count = 0;
  for (const ticket of app.store.openTickets()) {
    if (busy.has(ticket.id)) {
      count += 1;
    }
  }
  return count;
}

/** Whether the application runs, and how each of its parts is doing. */
export function healthView(app: AppContext): HealthView {
  const settings = app.settings();
  return {
    ready: app.board.get("runtime")?.state === "ready",
    version: VERSION,
    kernel: kernelAsStr(settings.kernel),
    paused: settings.paused,
    activeWorkers: activeWorkerCount(app),
    components: app.board.all(),
  };
}

async function cachedRunningJobs(app: AppContext, ticketId: string): Promise<WorkerJob[]> {
  const loaded = app.session(workerSessionId(ticketId));
  if (loaded === null || loaded.session.isDisposed()) {
    return [];
  }
  const now = Date.now();
  const cached = app.jobsCache.get(ticketId);
  if (cached !== undefined && now - cached.at >= 0 && now - cached.at < JOBS_CACHE_TTL_MS) {
    return cached.jobs.slice();
  }
  const jobs = await app.runningJobs(ticketId);
  app.jobsCache.set(ticketId, { at: Date.now(), jobs: jobs.slice() });
  return jobs;
}

/**
 * What is at work now, for the app's ticker: whether the main Session is thinking,
 * and a line for each busy worker on what it is doing. Read from memory only,
 * so the app may ask every few seconds.
 */
export async function activityView(app: AppContext): Promise<ActivityView> {
  const router = app.routerThinking();
  const live: Ticket[] = [];
  for (const ticketId of Array.from(app.busyTicketIds()).sort()) {
    const ticket = app.storeTicket(ticketId);
    if (ticket !== null && ticket.ended === undefined) {
      live.push(ticket);
    }
  }

  const jobsByTicket = new Map<string, WorkerJob[]>();
  if (live.length > 0) {
    const pairs = await Promise.all(
      live.map(async (ticket): Promise<[string, WorkerJob[]]> => [
        ticket.id,
        await cachedRunningJobs(app, ticket.id),
      ]),
    );
    for (const [id, jobs] of pairs) {
      jobsByTicket.set(id, jobs);
    }
  }

  const workers: ActivityWorkerView[] = new Array(live.length);
  for (let i = 0; i < live.length; i += 1) {
    const ticket = live[i];
    const loaded = app.session(workerSessionId(ticket.id));
    const streaming = loaded !== null && loaded.session.isStreaming();
    const recent = loaded !== null ? loaded.session.journal().entriesTail(12)[1] : undefined;
    const jobs = jobsByTicket.get(ticket.id) ?? [];
    const firstJob = jobs[0];
    const jobLine = firstJob !== undefined ? `后台 · ${firstLine(firstJob.label)}` : undefined;
    const reportSummary = latestAssignment(ticket)?.report?.summary;
    const recentDoing = recent !== undefined ? doing(recent) : undefined;

    let rawLine: string;
    if (streaming && recentDoing !== undefined) {
      rawLine = recentDoing;
    } else if (jobLine !== undefined) {
      rawLine = jobLine;
    } else {
      rawLine = recentDoing ?? reportSummary ?? "准备中";
    }
    const line = firstNonEmptyTrimmedLine(rawLine) ?? "准备中";
    workers[i] = {
      ticketId: ticket.id,
      title: ticket.title,
      doing: clip(line, DOING_CHARS),
    };
  }
  return { router, workers };
}

/** The conversation as people see it: what they wrote, in the app or WeChat, and what they were answered. */
export function panelMessages(app: AppContext): PanelMessageView[] {
  const transcript = app.chatTranscript();
  const out: PanelMessageView[] = [];
  for (let index = 0; index < transcript.length; index += 1) {
    const entry = transcript[index];
    if (entry.type !== "custom_message") {
      continue;
    }
    const source = entrySource(entry);
    let role: "user" | "assistant";
    if (source === "chat-reply") {
      role = "assistant";
    } else if (source === "web-panel" || source === "wechat") {
      role = "user";
    } else {
      continue;
    }
    const text = textOf(entry.content);
    if (text.length === 0) {
      continue;
    }

    const files = entryAttachments(entry);
    const imageNames: string[] = [];
    const others: PanelFileView[] = [];
    for (const [name, mediaType, kind] of files) {
      if (kind === "image") {
        imageNames.push(name);
      } else {
        others.push({ name, mediaType, kind });
      }
    }

    let imageNameIdx = 0;
    const images: PanelImageView[] = [];
    for (let at = 0; at < entry.content.length; at += 1) {
      const block = entry.content[at];
      if (block.type === "image") {
        const name =
          imageNameIdx < imageNames.length ? imageNames[imageNameIdx++] : `image-${at + 1}`;
        images.push({ name, mediaType: block.mimeType, data: block.data });
      }
    }

    const message: PanelMessageView = {
      id: index,
      role,
      text,
      source,
    };
    const at = parseIso(entryTimestamp(entry));
    if (at !== undefined) {
      message.at = at;
    }
    if (images.length > 0) {
      message.images = images;
    }
    if (others.length > 0) {
      message.files = others;
    }
    out.push(message);
  }
  return out;
}

function workerCardWithJobs(
  app: AppContext,
  ticket: Ticket,
  jobs: readonly WorkerJob[],
): WorkerCardView {
  const session = app.session(workerSessionId(ticket.id));
  const background: WorkerBackgroundJobView[] = jobs.map((job) => {
    // Its latest line of progress: a subagent's current step, or the end of a job's output.
    const latestProgress =
      job.progress !== undefined ? lastNonEmptyTrimmedLine(job.progress) : undefined;
    return {
      id: job.id,
      type: job.type,
      label: clip(job.label, 160),
      startedAt: job.startedAt,
      elapsedSeconds: job.elapsedSeconds,
      progress: latestProgress !== undefined ? clip(latestProgress, 200) : null,
    };
  });
  const assignment = latestAssignment(ticket);
  return {
    ticketId: ticket.id,
    title: ticket.title,
    stage: stageJson(ticketStage(ticket)),
    outcome: ticket.ended?.outcome ?? null,
    updatedAt: ticket.updatedAt,
    createdAt: ticket.createdAt,
    directory: ticket.execution?.directory ?? null,
    digest: ticket.digest ?? null,
    session: {
      loaded: session !== null,
      streaming:
        session !== null && !session.session.isDisposed() && session.session.isStreaming(),
    },
    background,
    assignment:
      assignment !== undefined
        ? {
            id: assignment.id,
            state: assignment.state,
            createdAt: assignment.createdAt,
            startedAt: assignment.startedAt ?? null,
            endedAt: assignment.endedAt ?? null,
            deliveredAt: assignment.deliveredAt ?? null,
            idleAt: assignment.idleAt ?? null,
          }
        : null,
    progress: assignment?.report ?? null,
    attention: ticket.attention ?? null,
    pendingInputs: ticket.undelivered.length,
    delivery: ticket.delivery ?? null,
  };
}

/** Every ticket with its worker, open ones first and each group by latest change. */
export async function workerCards(app: AppContext): Promise<WorkerCardView[]> {
  const tickets = app.store.tickets();
  tickets.sort((left, right) => {
    const leftEnded = left.ended !== undefined ? 1 : 0;
    const rightEnded = right.ended !== undefined ? 1 : 0;
    if (leftEnded !== rightEnded) {
      return leftEnded - rightEnded;
    }
    return right.updatedAt < left.updatedAt ? -1 : right.updatedAt > left.updatedAt ? 1 : 0;
  });

  const activeIds: string[] = [];
  for (const ticket of tickets) {
    const loaded = app.session(workerSessionId(ticket.id));
    if (loaded !== null && !loaded.session.isDisposed()) {
      activeIds.push(ticket.id);
    }
  }

  const jobsByTicket = new Map<string, WorkerJob[]>();
  if (activeIds.length > 0) {
    const pairs = await Promise.all(
      activeIds.map(async (id): Promise<[string, WorkerJob[]]> => [
        id,
        await cachedRunningJobs(app, id),
      ]),
    );
    for (const [id, jobs] of pairs) {
      jobsByTicket.set(id, jobs);
    }
  }

  return tickets.map((ticket) =>
    workerCardWithJobs(app, ticket, jobsByTicket.get(ticket.id) ?? []),
  );
}

/** One ticket with its Inputs, newest first, and its worker's latest thirty transcript entries. */
export async function workerDetail(
  app: AppContext,
  ticketId: string,
): Promise<WorkerDetailView | null> {
  const ticket = app.storeTicket(ticketId);
  if (ticket === null) {
    return null;
  }
  const jobs = await cachedRunningJobs(app, ticket.id);
  const card = workerCardWithJobs(app, ticket, jobs);

  const undeliveredSet = new Set(ticket.undelivered);
  const inputs: WorkerInputView[] = new Array(ticket.inputs.length);
  for (let i = ticket.inputs.length - 1, outIdx = 0; i >= 0; i -= 1, outIdx += 1) {
    const input = ticket.inputs[i];
    inputs[outIdx] = {
      ...input,
      delivered: !undeliveredSet.has(input.id),
    };
  }

  const loaded = app.session(workerSessionId(ticketId));
  const [startIndex, entries]: [number, Entry[]] =
    loaded !== null
      ? loaded.session.journal().entriesTail(120)
      : [0, app.workerTranscript(ticketId)];

  const allRecent: WorkerRecentEntryView[] = [];
  for (let offset = 0; offset < entries.length; offset += 1) {
    const entry = entries[offset];
    const [role, text] = activity(entry);
    if (text.length === 0) {
      continue;
    }
    const line: WorkerRecentEntryView = {
      id: startIndex + offset,
      role,
      text,
    };
    const at = parseIso(entryTimestamp(entry));
    if (at !== undefined) {
      line.at = at;
    }
    allRecent.push(line);
  }
  const recent = allRecent.slice(Math.max(0, allRecent.length - 30));

  return {
    ...card,
    inputs,
    recent,
  };
}

/** Say in the health board whether Antigravity can run. */
export function reportKernels(app: AppContext): void {
  const kernel = app.settings().kernel;
  const problem = app.kernels.unavailable(kernel);
  const health =
    problem !== undefined
      ? Health.error(problem)
      : Health.ready(`Running on ${kernelAsStr(kernel)}`);
  app.board.set("kernel", health);
}

/** Ask Antigravity for its models, and keep what it said. */
async function listModelsNow(app: AppContext, kernel: Kernel): Promise<void> {
  let listed: { ok: true; models: ModelOption[] } | { ok: false; error: string };
  try {
    const models = await app.kernels.models(kernel);
    listed = { ok: true, models };
  } catch (error) {
    listed = { ok: false, error: errorText(error) };
  }
  app.modelLists.set(kernel, { at: Date.now(), listed });
}

/**
 * What Antigravity offers now, without waiting: its models or why it has none, or `null`
 * while they are first listed. A list a minute old is listed again in the background.
 */
export function modelsKnown(app: AppContext, kernel: Kernel): KnownModelList {
  const now = Date.now();
  const existing = app.modelLists.get(kernel);
  let known: KnownModelList;
  let refresh: boolean;

  if (existing === undefined) {
    app.modelLists.set(kernel, { at: now, listed: null });
    known = null;
    refresh = true;
  } else if (existing.listed === null) {
    known = null;
    refresh = false;
  } else {
    const stale = now - existing.at > MODEL_LIST_STALE_MS;
    if (stale) {
      // Marked new now, so one refresh runs at a time.
      existing.at = now;
    }
    known = existing.listed.ok
      ? { ok: true, models: existing.listed.models.slice() }
      : { ok: false, error: existing.listed.error };
    refresh = stale;
  }

  if (refresh) {
    void listModelsNow(app, kernel).catch(() => {});
  }
  return known;
}

/** The models Antigravity offers, or why it offers none, and whether they are still being listed. */
function offered(
  app: AppContext,
  kernel: Kernel,
): [ModelOption[], string | null, boolean] {
  const problem = app.kernels.unavailable(kernel);
  if (problem !== undefined) {
    return [[], problem, false];
  }
  const known = modelsKnown(app, kernel);
  if (known === null) {
    return [[], null, true];
  }
  if (known.ok) {
    return [known.models, null, false];
  }
  return [[], known.error, false];
}

/**
 * The Antigravity model settings, with installation status and available models.
 * It never waits for Antigravity to list its models: `loading` says it is still at it.
 */
export async function modelsView(app: AppContext): Promise<ModelsView> {
  const settings = app.settings();
  const kernel = settings.kernel;
  const chosen = roleModels(settings);
  const [available, listProblem, loading] = offered(app, kernel);
  const problem = app.kernels.unavailable(kernel) ?? null;
  return {
    kernel: kernelAsStr(kernel),
    installed: kernelInstalled(app.kernels, kernel),
    installing: kernelInstalling(app.kernels, kernel),
    installProgress: kernelInstallProgress(app.kernels, kernel) ?? null,
    problem,
    listProblem,
    loading,
    current: {
      eval: chosen.eval,
      executor: chosen.executor,
    },
    available,
  };
}

/**
 * Save the model settings: the main Session's model (`eval`) and the workers' model (`executor`);
 * `null` follows Antigravity's default. Models apply to open Sessions from their next turn.
 */
export async function updateModels(app: AppContext, value: unknown): Promise<ModelsView> {
  const fields = objectKeys(value, ["eval", "executor"]);
  const evalModel = selection(fields, "eval");
  const executorModel = selection(fields, "executor");
  const next = cloneSettings(app.settings());
  const entry = next.models[DEFAULT_KERNEL] ?? defaultRoleModels();
  entry.eval = evalModel;
  entry.executor = executorModel;
  next.models[DEFAULT_KERNEL] = entry;
  app.saveSettings(next, "app", "models");
  await app.applyModels();
  reportKernels(app);
  app.passes.pump();
  return modelsView(app);
}

/** Install the Antigravity CLI with its official installer. Once installed, the main Session opens on it at once. */
export async function installKernel(app: AppContext, value: unknown): Promise<ModelsView> {
  const fields = objectKeys(value, ["kernel"]);
  const kernel = kernelNamed(fields.kernel);
  if (!kernelInstalled(app.kernels, kernel)) {
    // The installer runs on even if the request disconnects (e.g. page reloaded during download);
    // the settings page shows its progress meanwhile.
    await (async () => {
      await kernelInstall(app.kernels, kernel);
      app.modelLists.delete(kernel);
      modelsKnown(app, kernel);
    })();
  }
  const problem = app.kernels.unavailable(kernel);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  await app.ensureOrchestrator();
  reportKernels(app);
  app.passes.pump();
  return modelsView(app);
}

/**
 * Everything else a person configures: the pause, proactive assessment, workers and their directories,
 * rules and who may write; with the limits the app checks input against.
 */
export function generalView(app: AppContext): GeneralView {
  const settings = app.settings();
  return {
    paused: settings.paused,
    eval: settings.eval,
    executor: settings.executor,
    policy: settings.policy,
    defaults: { directory: app.executionRoot() },
    limits: {
      ruleName: limits.RULE_NAME,
      ruleInstruction: limits.RULE_INSTRUCTION,
      evalTimeoutSeconds: [limits.EVAL_TIMEOUT_SECONDS[0], limits.EVAL_TIMEOUT_SECONDS[1]],
      maxWorkers: [limits.MAX_WORKERS[0], limits.MAX_WORKERS[1]],
      prepareCommand: limits.PREPARE_COMMAND,
    },
  };
}

/** Change some of the general settings: each block that is sent replaces that block whole, and the others stay. */
export async function updateGeneral(app: AppContext, value: unknown): Promise<GeneralView> {
  const fields = objectKeys(value, ["paused", "eval", "executor", "policy"]);
  const keys = Object.keys(fields);
  if (keys.length === 0) {
    throw new Error("Send at least one of paused, eval, executor, policy");
  }
  const before = app.settings();
  const block = keys.slice().sort().join(",");
  const next = parseBlock(before, fields);

  const beforeCanon = cloneSettings(before);
  const nextCanon = cloneSettings(next);
  const promptsChanged =
    JSON.stringify(nextCanon.policy) !== JSON.stringify(beforeCanon.policy) ||
    JSON.stringify(nextCanon.eval) !== JSON.stringify(beforeCanon.eval) ||
    JSON.stringify(nextCanon.executor) !== JSON.stringify(beforeCanon.executor);

  app.saveSettings(next, "app", block);
  if (promptsChanged && app.session(app.masterId) !== null) {
    // The main Session's prompt states the Policy and the environment: compose it anew.
    await app.reopenOrchestrator();
  }
  app.effects.kick();
  app.passes.pump();
  return generalView(app);
}
