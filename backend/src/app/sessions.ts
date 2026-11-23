/**
 * Sessions: the main Session, one per ticket's worker, and one-off Sessions for the Sidecar and the Watchdog.
 */

import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import { key, type Ticket } from "../core/index.ts";
import {
  GUARD_ALLOW,
  Journal,
  Session,
  UnboundedChannel,
  errorMessage,
  guardBlock,
  isRecord,
  textBlock,
  type Block,
  type Driver,
  type DriverEvent,
  type Entry,
  type EventSubscription,
  type Guard,
  type KernelEvent,
  type Presentation,
  type ToolHost,
  type ToolSpec,
} from "../kernel/index.ts";
import type { AppContext, ChatAttachment, Loaded, OnceTools } from "./context.ts";
import { Failure } from "./effects.ts";
import { MAX_SUBAGENTS, type SessionRole, type SessionSpec } from "./kernels.ts";
import { policyVersion } from "./policy.ts";
import { compose as composePrompt } from "./prompts.ts";
import { modelsOf, type Kernel, type RoleModel, type Settings } from "./settings.ts";

export type { ChatAttachment, Loaded, OnceTools };

/** Provides the application's tool specifications for orchestrator and worker Sessions. */
export interface SpecsProvider {
  mainSpecs(): ToolSpec[];
  workerSpecs(): ToolSpec[];
}

/** Configuration options for {@link SessionsState}. */
export interface SessionsStateOptions {
  /** Supplies tool specifications without introducing a circular dependency on `tools.ts`. */
  specsProvider?: SpecsProvider;
}

const DEFAULT_SPECS_PROVIDER: SpecsProvider = {
  mainSpecs: () => [],
  workerSpecs: () => [],
};

/** Fair FIFO async mutex used per session id so distinct sessions open concurrently while same-id opens serialize. */
class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();
  waiters = 0;

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.waiters += 1;
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      this.waiters -= 1;
      release();
    }
  }
}

interface LoadedEntry {
  loaded: Loaded;
  reports: UnboundedChannel<DriverEvent>;
  subscription?: EventSubscription<KernelEvent>;
}

/** The open Sessions and per-session opening locks. */
export class SessionsState {
  private readonly loaded = new Map<string, LoadedEntry>();
  private readonly opening = new Map<string, AsyncMutex>();
  private specsProvider: SpecsProvider;

  constructor(options: SessionsStateOptions = {}) {
    this.specsProvider = options.specsProvider ?? DEFAULT_SPECS_PROVIDER;
  }

  /** Replace the tool specification provider (e.g. wired by `App` once `tools.ts` is loaded). */
  setSpecsProvider(provider: SpecsProvider): void {
    this.specsProvider = provider;
  }

  /** Tool specifications for the main orchestrator Session. */
  mainSpecs(): ToolSpec[] {
    return this.specsProvider.mainSpecs();
  }

  /** Tool specifications for worker Sessions. */
  workerSpecs(): ToolSpec[] {
    return this.specsProvider.workerSpecs();
  }

  /** The open Session with this id, if any. */
  get(sessionId: string): Loaded | null {
    return this.loaded.get(sessionId)?.loaded ?? null;
  }

  /** Whether a Session with this id is currently open. */
  has(sessionId: string): boolean {
    return this.loaded.has(sessionId);
  }

  /** Snapshot of all currently open Sessions. */
  allLoaded(): Loaded[] {
    const out: Loaded[] = [];
    for (const entry of this.loaded.values()) {
      out.push(entry.loaded);
    }
    return out;
  }

  /** Register a newly opened Session and its driver report channel. */
  set(sessionId: string, loaded: Loaded, reports: UnboundedChannel<DriverEvent>): void {
    this.loaded.set(sessionId, { loaded, reports });
  }

  /** Attach an event observer subscription to a loaded Session so teardown closes it cleanly. */
  setSubscription(
    sessionId: string,
    loaded: Loaded,
    subscription: EventSubscription<KernelEvent>,
  ): void {
    const entry = this.loaded.get(sessionId);
    if (entry !== undefined && entry.loaded === loaded) {
      entry.subscription = subscription;
    } else {
      subscription.close();
    }
  }

  /** Detach the observer subscription once its loop exits. */
  clearSubscription(sessionId: string, loaded: Loaded): void {
    const entry = this.loaded.get(sessionId);
    if (entry !== undefined && entry.loaded === loaded) {
      entry.subscription = undefined;
    }
  }

  /** Remove and return a loaded Session entry. */
  delete(sessionId: string): LoadedEntry | undefined {
    const entry = this.loaded.get(sessionId);
    if (entry !== undefined) {
      this.loaded.delete(sessionId);
    }
    return entry;
  }

  /** Remove and return every loaded Session entry. */
  drain(): LoadedEntry[] {
    const all = Array.from(this.loaded.values());
    this.loaded.clear();
    return all;
  }

  /** Run `fn` while holding the per-session opening/closing lock, cleaning the lock entry when idle. */
  async withSessionLock<T>(sessionId: string, fn: () => Promise<T> | T): Promise<T> {
    let lock = this.opening.get(sessionId);
    if (lock === undefined) {
      lock = new AsyncMutex();
      this.opening.set(sessionId, lock);
    }
    try {
      return await lock.run(fn);
    } finally {
      if (lock.waiters === 0 && this.opening.get(sessionId) === lock) {
        this.opening.delete(sessionId);
      }
    }
  }
}

/** The id of a ticket's worker Session. */
export function workerSessionId(ticketId: string): string {
  return `worker-${ticketId}`;
}

/** The tools of one Session, served by the application. */
export class SessionTools implements ToolHost {
  private readonly app: AppContext;
  private readonly state: SessionsState;
  private readonly ticketId?: string;

  constructor(app: AppContext, state: SessionsState, ticketId?: string) {
    this.app = app;
    this.state = state;
    this.ticketId = ticketId;
  }

  specs(): ToolSpec[] {
    return this.ticketId !== undefined ? this.state.workerSpecs() : this.state.mainSpecs();
  }

  call(name: string, args: unknown): Promise<unknown> {
    if (this.ticketId !== undefined) {
      return this.app.workerTool(this.ticketId, name, args);
    }
    return this.app.mainTool(name, args);
  }

  async guard(tool: string, _input: unknown): Promise<Guard> {
    if (this.ticketId === undefined) {
      return GUARD_ALLOW;
    }
    // A worker whose ticket ended does nothing more, whatever its model still tries.
    if (!this.app.ticketIsLive(this.ticketId)) {
      return guardBlock("Ticket ended; new work needs a new authorized ticket");
    }
    if (tool === "task") {
      const sessionId = workerSessionId(this.ticketId);
      const loaded = this.state.get(sessionId) ?? this.app.session(sessionId);
      if (loaded !== null) {
        const jobs = await loaded.session.driver().jobs();
        let taskCount = 0;
        for (let i = 0; i < jobs.length; i++) {
          if (jobs[i].kind === "task") {
            taskCount += 1;
          }
        }
        if (taskCount >= MAX_SUBAGENTS) {
          return guardBlock(
            `At most ${MAX_SUBAGENTS} subagents run at once; wait for one to finish`,
          );
        }
      }
    }
    return GUARD_ALLOW;
  }
}

/** Adapts {@link OnceTools} to the kernel {@link ToolHost} interface. */
export class OnceToolHost implements ToolHost {
  private readonly tools: OnceTools;

  constructor(tools: OnceTools) {
    this.tools = tools;
  }

  specs(): ToolSpec[] {
    return this.tools.specs.slice();
  }

  call(name: string, args: unknown): Promise<unknown> {
    return this.tools.call(name, args);
  }
}

/** Declared image MIME types accepted directly and normalized to canonical MIME types. */
export const IMAGE_TYPES: ReadonlyArray<readonly [string, string]> = [
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/webp", "image/webp"],
  ["image/gif", "image/gif"],
];

/** Image file extensions used when no specific MIME type was declared. */
export const IMAGE_EXTENSIONS: ReadonlyArray<readonly [string, string]> = [
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
];

/** File extensions treated as likely text for inline attachment rendering. */
export const TEXT_EXTENSIONS: readonly string[] = [
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "xml",
  "csv",
  "tsv",
  "log",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "css",
  "html",
  "htm",
  "svg",
  "py",
  "sh",
  "bash",
  "zsh",
  "sql",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "rs",
  "go",
  "java",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "rb",
  "lua",
  "vue",
  "svelte",
  "dart",
  "swift",
  "kt",
];

/** Maximum attachment size eligible for inline UTF-8 rendering (256 KiB). */
export const MAX_INLINE_TEXT_BYTES = 256 * 1024;

const IMAGE_TYPE_MAP: ReadonlyMap<string, string> = new Map(IMAGE_TYPES);
const IMAGE_EXTENSION_MAP: ReadonlyMap<string, string> = new Map(IMAGE_EXTENSIONS);
const TEXT_EXTENSION_SET: ReadonlySet<string> = new Set(TEXT_EXTENSIONS);
const APPLICATION_TEXT_SUBTYPES: ReadonlySet<string> = new Set([
  "json",
  "xml",
  "yaml",
  "x-yaml",
  "javascript",
  "typescript",
  "x-sh",
  "x-python",
  "csv",
  "sql",
]);

// `ignoreBOM: true` preserves leading U+FEFF verbatim, matching Rust `String::from_utf8`.
const UTF8_STRICT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function extension(name: string): string {
  const ext = path.extname(name);
  if (ext.length <= 1) {
    return "";
  }
  return ext.slice(1).toLowerCase();
}

/** The image type of an attachment, by its declared type, else by its file name when the type says nothing. */
export function imageType(attachment: ChatAttachment): string | undefined {
  const known = IMAGE_TYPE_MAP.get(attachment.mediaType);
  if (known !== undefined) {
    return known;
  }
  if (attachment.mediaType.length === 0 || attachment.mediaType === "application/octet-stream") {
    return IMAGE_EXTENSION_MAP.get(extension(attachment.name));
  }
  return undefined;
}

function isApplicationText(mediaType: string): boolean {
  if (!mediaType.startsWith("application/")) {
    return false;
  }
  const rest = mediaType.slice("application/".length);
  const semi = rest.indexOf(";");
  const subtype = semi === -1 ? rest : rest.slice(0, semi);
  return APPLICATION_TEXT_SUBTYPES.has(subtype);
}

/** The text of an attachment small enough to show inline, when it is text. */
export function inlineText(attachment: ChatAttachment): string | undefined {
  if (attachment.data.byteLength > MAX_INLINE_TEXT_BYTES) {
    return undefined;
  }
  const mediaType = attachment.mediaType;
  const textual =
    mediaType.startsWith("text/") ||
    mediaType.startsWith("image/svg+xml") ||
    isApplicationText(mediaType);
  const likely = textual || TEXT_EXTENSION_SET.has(extension(attachment.name));
  if (!likely && attachment.data.includes(0)) {
    return undefined;
  }
  try {
    return UTF8_STRICT_DECODER.decode(attachment.data);
  } catch {
    return undefined;
  }
}

function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function encodeBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Look up a ticket from the store. */
export function storeTicket(app: AppContext, ticketId: string): Ticket | null {
  return app.store.ticket(ticketId) ?? null;
}

/** The open Session with this id. */
export function session(state: SessionsState, sessionId: string): Loaded | null {
  return state.get(sessionId);
}

/** The kernel a Session runs on. */
export function roleKernel(settings: Settings, _role: SessionRole): Kernel {
  return settings.kernel;
}

/** The configured model for a Session role, or `null` to follow the runtime default. */
export function roleModel(settings: Settings, role: SessionRole): RoleModel | null {
  const models = modelsOf(settings, roleKernel(settings, role));
  switch (role) {
    case "worker":
      return models.executor;
    case "orchestrator":
      return models.eval;
    // One-off turns run with the main Session's model, else the workers' model.
    case "sidecar":
    case "watchdog":
      return models.eval ?? models.executor;
  }
}

/** Follow a worker (or custom-observed) Session's turns, for as long as it stays open. */
function observeSession(
  app: AppContext,
  state: SessionsState,
  sessionId: string,
  loaded: Loaded,
  ticketId: string | undefined,
  onEvent: ((loaded: Loaded, event: KernelEvent) => void | Promise<void>) | undefined,
): void {
  if (onEvent === undefined && ticketId === undefined) {
    return;
  }
  const events = loaded.session.subscribe();
  state.setSubscription(sessionId, loaded, events);
  void (async () => {
    try {
      while (true) {
        const event = await events.recv();
        if (event === undefined) {
          return;
        }
        if (state.get(sessionId) !== loaded) {
          return;
        }
        try {
          if (onEvent !== undefined) {
            await onEvent(loaded, event);
          } else if (ticketId !== undefined) {
            await app.workerEvent(ticketId, loaded, event);
          }
        } catch {
          // Keep observing subsequent events even if one callback throws.
        }
      }
    } finally {
      events.close();
      state.clearSubscription(sessionId, loaded);
    }
  })();
}

/**
 * The open Session with this id, opening it on the current kernel from its transcript when it is not.
 *
 * Matches `AppContext.ensureSession`: `title` names the transcript (via `journal.setName`), while the
 * system prompt is always composed from the current settings for `role`.
 */
export async function ensureSession(
  app: AppContext,
  state: SessionsState,
  sessionId: string,
  role: SessionRole,
  cwd: string,
  title: string,
  ticketId?: string,
  onEvent?: (loaded: Loaded, event: KernelEvent) => void | Promise<void>,
): Promise<Loaded> {
  const existing = state.get(sessionId);
  if (existing !== null) {
    return existing;
  }
  return state.withSessionLock(sessionId, () => {
    const already = state.get(sessionId);
    if (already !== null) {
      return already;
    }
    if (app.closing()) {
      throw new Error("neo-agent is stopping");
    }
    if (ticketId !== undefined && !app.ticketIsLive(ticketId)) {
      throw new Error("Ticket ended");
    }
    const settings = app.settings();
    const kernel = roleKernel(settings, role);
    const problem = app.kernels.unavailable(kernel);
    if (problem !== undefined) {
      throw new Error(problem);
    }
    const record = `session-file:${sessionId}`;
    const storedPath = app.store.get<string>(record);
    let journal: Journal;
    if (typeof storedPath === "string" && storedPath.length > 0 && isRegularFile(storedPath)) {
      try {
        journal = Journal.open(storedPath);
      } catch (err) {
        throw new Error(
          `Cannot reopen session ${sessionId} at ${storedPath}: ${errorMessage(err)}`,
        );
      }
    } else {
      try {
        journal = Journal.create(path.join(app.machine.stateDir, "sessions"), cwd);
      } catch (err) {
        throw new Error(`Cannot create a session transcript: ${errorMessage(err)}`);
      }
      app.store.set(record, journal.path());
    }
    journal.setName(title);
    const spec: SessionSpec = {
      sessionId,
      role,
      cwd,
      systemPrompt: composePrompt(
        role === "worker" ? "worker" : "orchestrator",
        settings,
        policyVersion(settings),
      ),
      model: roleModel(settings, role),
    };
    const host = new SessionTools(app, state, ticketId);
    const reports = new UnboundedChannel<DriverEvent>();
    let driver: Driver;
    try {
      driver = app.kernels.open(kernel, spec, host, reports);
    } catch (err) {
      journal.close();
      reports.close();
      throw err;
    }
    const opened = new Session(journal, driver, reports);
    const loaded: Loaded =
      ticketId !== undefined
        ? { session: opened, kernel, role, ticketId }
        : { session: opened, kernel, role };
    state.set(sessionId, loaded, reports);
    observeSession(app, state, sessionId, loaded, ticketId, onEvent);
    return loaded;
  });
}

/** The main Session, open. */
export function ensureOrchestrator(app: AppContext, state: SessionsState): Promise<Loaded> {
  return ensureSession(
    app,
    state,
    app.masterId,
    "orchestrator",
    app.machine.stateDir,
    "neo-agent orchestrator",
  );
}

/** Close a Session; its transcript stays, and it reopens from it. */
export async function stopSession(state: SessionsState, sessionId: string): Promise<void> {
  const entry = await state.withSessionLock(sessionId, () => state.delete(sessionId));
  if (entry !== undefined) {
    entry.subscription?.close();
    try {
      await entry.loaded.session.dispose();
    } finally {
      entry.reports.close();
    }
  }
}

/** Close every open Session: mark all disposed immediately, then dispose each runtime. */
export async function stopAllSessions(state: SessionsState): Promise<void> {
  const all = state.drain();
  for (let i = 0; i < all.length; i++) {
    const entry = all[i];
    entry.subscription?.close();
    entry.loaded.session.beginDispose();
  }
  await Promise.all(
    all.map(async (entry) => {
      try {
        await entry.loaded.session.dispose();
      } finally {
        entry.reports.close();
      }
    }),
  );
}

/** Replace the main Session with an empty one; tickets, workers, attachments and the WeChat binding stay. */
export async function resetOrchestrator(app: AppContext, state: SessionsState): Promise<void> {
  await stopSession(state, app.masterId);
  app.store.delete(`session-file:${app.masterId}`);
  await ensureOrchestrator(app, state);
}

/** Reopen the main Session from its transcript, so its system prompt is composed from the settings now. */
export async function reopenOrchestrator(app: AppContext, state: SessionsState): Promise<void> {
  await stopSession(state, app.masterId);
  const main = await ensureOrchestrator(app, state);
  if (!app.paused()) {
    void (async () => {
      if (!app.closing() && !app.paused()) {
        try {
          await main.session.warm();
        } catch {
          // Matches Rust `let _ = main.session.warm().await;`
        }
      }
    })();
  }
}

/** Apply the settings' model choices to open Sessions, from their next turn. */
export async function applyModels(app: AppContext, state: SessionsState): Promise<void> {
  const settings = app.settings();
  const all = state.allLoaded();
  for (let i = 0; i < all.length; i++) {
    const loaded = all[i];
    if (loaded.session.isDisposed()) {
      continue;
    }
    const model = roleModel(settings, loaded.role);
    await loaded.session.driver().setModel(model?.model, undefined);
  }
}

/** Steer a queued relay message into the main Session. */
export async function relayQueued(
  app: AppContext,
  state: SessionsState,
  payload: unknown,
  requestId: string,
): Promise<void> {
  try {
    const main = await ensureOrchestrator(app, state);
    const text = isRecord(payload) && typeof payload.text === "string" ? payload.text : "";
    await main.session.send(requestId, [textBlock(text)], "steer", {}, []);
  } catch (err) {
    throw Failure.from(err);
  }
}

/** Inject a queued notice into the main Session when open, without starting a turn. */
export async function noticeQueued(
  app: AppContext,
  state: SessionsState,
  payload: unknown,
  name: string,
): Promise<void> {
  // A notice only adds to what the main Session reads next; with no Session open there is nobody to tell.
  const main = state.get(app.masterId);
  if (main === null) {
    return;
  }
  const rawValue = isRecord(payload) && "value" in payload ? payload.value : null;
  const text = JSON.stringify(rawValue === undefined ? null : rawValue);
  try {
    await main.session.send(`notice:${name}:${key([text])}`, [textBlock(text)], "inject", {}, []);
  } catch (err) {
    throw Failure.from(err);
  }
}

/**
 * Record a person's chat message in the main Session's transcript, without starting a turn. Images are shown to
 * the model on its next turn, text files are inlined, and other files are saved for a worker to read. Returns
 * the message as the Trigger carries it.
 */
export async function presentChat(
  app: AppContext,
  state: SessionsState,
  text: string,
  attachments: readonly ChatAttachment[],
  requestId: string,
  source: string,
): Promise<string> {
  const main = await ensureOrchestrator(app, state);
  const images: Block[] = [];
  const rendered: string[] = [];
  const shown: Array<[string, string]> = [];
  let directory: string | undefined;

  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index];
    const image = imageType(attachment);
    if (image !== undefined) {
      images.push({ type: "image", mimeType: image, data: encodeBase64(attachment.data) });
    } else {
      const inlined = inlineText(attachment);
      if (inlined !== undefined) {
        rendered.push(
          `<attachment name="${attribute(attachment.name)}">\n${inlined}\n</attachment>`,
        );
        shown.push([
          attachment.name,
          attachment.mediaType.length === 0 ? "text/plain" : attachment.mediaType,
        ]);
        continue;
      }
    }
    if (directory === undefined) {
      directory = path.join(app.machine.stateDir, "attachments", requestId.replaceAll(":", "-"));
    }
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (err) {
      throw new Error(`Cannot save the attachment: ${errorMessage(err)}`);
    }
    const filePath = path.join(directory, `${index + 1}-${attachment.name}`);
    try {
      fs.writeFileSync(filePath, attachment.data);
    } catch (err) {
      throw new Error(`Cannot save the attachment: ${errorMessage(err)}`);
    }
    const stored =
      image ??
      (attachment.mediaType.length === 0 ? "application/octet-stream" : attachment.mediaType);
    rendered.push(
      `<attachment name="${attribute(attachment.name)}" mediaType="${attribute(stored)}" path="${attribute(filePath)}">\nFile saved at the path above. Use read or bash to inspect or transform it as needed; do not execute it implicitly.\n</attachment>`,
    );
    shown.push([attachment.name, stored]);
  }

  const parts: string[] = [];
  if (text.length > 0) {
    parts.push(text);
  }
  for (let i = 0; i < rendered.length; i++) {
    parts.push(rendered[i]);
  }
  const body = parts.length === 0 ? "请查看附件。" : parts.join("\n\n");
  const content: Block[] = [textBlock(body), ...images];
  const presentation: Presentation = {
    display: true,
    fromUser: true,
    source,
    attachments: shown,
  };
  main.session.append(requestId, content, presentation, false);
  if (images.length > 0) {
    // The message's text reaches the model in its candidate card; its images wait for that turn here.
    const seen: Block[] = [textBlock(`Images attached to chat message ${requestId}:`), ...images];
    main.session.append(`images:${requestId}`, seen, {}, true);
  }
  return body;
}

/** Show a reply in the chat transcript without starting a turn. */
export async function publish(
  app: AppContext,
  state: SessionsState,
  requestId: string,
  text: string,
): Promise<void> {
  const main = await ensureOrchestrator(app, state);
  main.session.append(requestId, [textBlock(text)], { display: true, source: "chat-reply" }, false);
}

/** The visible chat transcript, oldest first. */
export function chatTranscript(app: AppContext, state: SessionsState): Entry[] {
  const main = state.get(app.masterId);
  if (main !== null) {
    return main.session.journal().chat();
  }
  const filePath = app.store.get<string>(`session-file:${app.masterId}`);
  if (typeof filePath !== "string" || filePath.length === 0) {
    return [];
  }
  let journal: Journal | undefined;
  try {
    journal = Journal.open(filePath);
    return journal.chat();
  } catch {
    return [];
  } finally {
    journal?.close();
  }
}

/** A ticket's worker transcript, oldest first; empty when it never had a Session. */
export function workerTranscript(
  app: AppContext,
  state: SessionsState,
  ticketId: string,
): Entry[] {
  const sessionId = workerSessionId(ticketId);
  const loaded = state.get(sessionId);
  if (loaded !== null) {
    return loaded.session.journal().entries();
  }
  const filePath = app.store.get<string>(`session-file:${sessionId}`);
  if (typeof filePath !== "string" || filePath.length === 0) {
    return [];
  }
  let journal: Journal | undefined;
  try {
    journal = Journal.open(filePath);
    return journal.entries();
  } catch {
    return [];
  } finally {
    journal?.close();
  }
}

/** Run one stateless turn on a Session of its own and return what the model said last. */
export async function runOnce(
  app: AppContext,
  role: SessionRole,
  cwd: string,
  systemPrompt: string,
  message: string,
  tools: OnceTools,
  timeoutMs: number,
): Promise<string> {
  if (app.closing() || app.stopSignal.aborted) {
    throw new Error("neo-agent is stopping");
  }
  const settings = app.settings();
  const kernel = roleKernel(settings, role);
  const problem = app.kernels.unavailable(kernel);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  let journal: Journal;
  try {
    journal = Journal.create(path.join(app.machine.stateDir, "sessions", "once"), cwd);
  } catch (err) {
    throw new Error(`Cannot create a session transcript: ${errorMessage(err)}`);
  }
  const file = journal.path();
  const spec: SessionSpec = {
    sessionId: `once-${key([file])}`,
    role,
    cwd,
    systemPrompt,
    model: roleModel(settings, role),
  };
  const reports = new UnboundedChannel<DriverEvent>();
  let driver: Driver;
  try {
    driver = app.kernels.open(kernel, spec, new OnceToolHost(tools), reports);
  } catch (err) {
    journal.close();
    reports.close();
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }

  const tempSession = new Session(journal, driver, reports);
  const events = tempSession.subscribe();
  const turn = (async (): Promise<string> => {
    await tempSession.send("once", [textBlock(message)], "steer", {}, []);
    while (true) {
      const event = await events.recv();
      if (event === undefined) {
        throw new Error("The session ended unexpectedly");
      }
      if (event.type === "agentEnd" && event.terminal) {
        break;
      }
    }
    if (tempSession.journal().lastStopReason() === "error") {
      throw new Error(tempSession.journal().lastAssistantText() ?? "The model request failed");
    }
    return (tempSession.journal().lastAssistantText() ?? "").trim();
  })();
  // Prevent unhandled rejection if timeout or shutdown wins the race before `events.close()` unwinds `turn`.
  turn.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const clampedTimeoutMs = Math.max(0, timeoutMs);
  const timeoutSecs = Math.floor(clampedTimeoutMs / 1000);
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`The turn timed out after ${timeoutSecs} seconds`));
    }, clampedTimeoutMs);
    timer.unref?.();
  });

  let onAbort: (() => void) | undefined;
  const stopPromise = new Promise<never>((_resolve, reject) => {
    if (app.stopSignal.aborted) {
      reject(new Error("neo-agent is stopping"));
      return;
    }
    onAbort = () => {
      reject(new Error("neo-agent is stopping"));
    };
    app.stopSignal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([turn, timeoutPromise, stopPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      app.stopSignal.removeEventListener("abort", onAbort);
    }
    events.close();
    try {
      await tempSession.dispose();
    } finally {
      reports.close();
      try {
        fs.unlinkSync(file);
      } catch {
        // ignore cleanup failure
      }
    }
  }
}
