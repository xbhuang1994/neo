/**
 * Test support: temporary directories, program lookup, a loopback mock HTTP/1.1 server,
 * and minimal generic scripted kernel drivers for session and application tests.
 *
 * Ported from Rust `neo-testkit/src/{lib,http}.rs`.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { UnboundedChannel, errorMessage, isRecord, textBlock } from "../kernel/index.ts";
import type { Block, Deliver, Driver, DriverEvent, KernelJob, ToolHost } from "../kernel/index.ts";

const EMPTY_BYTES = new Uint8Array(0);
const CRLF = Buffer.from("\r\n");
const CRLF_CRLF = Buffer.from("\r\n\r\n");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

let nextTempDirId = 0;

/** A directory under the system temp directory, removable via `cleanup()` or `using`. */
export class TempDir {
  /** The directory path. */
  readonly path: string;

  /** Create a new empty directory whose name starts with `neo-${prefix}-`. */
  constructor(prefix: string) {
    const unique = `neo-${prefix}-${process.pid}-${nextTempDirId++}`;
    const dir = path.join(os.tmpdir(), unique);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    this.path = dir;
  }

  /** A path inside the directory. */
  join(...segments: string[]): string {
    return path.join(this.path, ...segments);
  }

  /** Remove the temporary directory and all of its contents. */
  cleanup(): void {
    fs.rmSync(this.path, { recursive: true, force: true });
  }

  [Symbol.dispose](): void {
    this.cleanup();
  }
}

/** The first program named `name` on `PATH`. */
export function findProgram(name: string): string | undefined {
  const pathEnv = process.env.PATH;
  if (!pathEnv) {
    return undefined;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore missing or unreadable entries.
    }
  }
  return undefined;
}

// ============================================================================
// MockHttpServer (ported from neo-testkit/src/http.rs)
// ============================================================================

/** A request received by `MockHttpServer`. */
export class MockRequest {
  /** The method, such as `POST`. */
  readonly method: string;
  /** The full request target (path with its query, matching Rust `neo-testkit::http::Request`). */
  readonly path: string;
  /** The path without the query string. */
  readonly pathname: string;
  /** The query string without the leading `?`, or empty string. */
  readonly query: string;
  /** Header names in lowercase. */
  readonly headers: Map<string, string>;
  /** The raw body bytes. */
  readonly body: Uint8Array;

  constructor(
    method: string,
    target: string,
    headers: Map<string, string>,
    body: Uint8Array,
  ) {
    this.method = method;
    this.path = target;
    const qIdx = target.indexOf("?");
    this.pathname = qIdx === -1 ? target : target.slice(0, qIdx);
    this.query = qIdx === -1 ? "" : target.slice(qIdx + 1);
    this.headers = headers;
    this.body = body;
  }

  /** Lookup a header case-insensitively. */
  header(name: string): string | undefined {
    const direct = this.headers.get(name);
    if (direct !== undefined) return direct;
    const lower = name.toLowerCase();
    return lower === name ? undefined : this.headers.get(lower);
  }

  /** Decode body as UTF-8 text. */
  text(): string {
    return textDecoder.decode(this.body);
  }

  /** Decode body as JSON. */
  json<T = unknown>(): T {
    return JSON.parse(this.text()) as T;
  }
}

/** A response returned by `MockHttpServer`. */
export class MockResponse {
  /** The HTTP status code. */
  status: number;
  /** The `content-type` header value. */
  contentType: string;
  /** The body bytes. */
  body: Uint8Array;
  /** Extra headers beyond `content-type` and `content-length`. */
  headers: Array<[string, string]>;

  constructor(
    status: number,
    contentType: string,
    body: Uint8Array,
    headers: Array<[string, string]> = [],
  ) {
    this.status = status;
    this.contentType = contentType;
    this.body = body;
    this.headers = headers;
  }

  /** A response of raw bytes (`application/octet-stream`). */
  static bytes(status: number, body: Uint8Array | string = EMPTY_BYTES): MockResponse {
    const bytes = typeof body === "string" ? textEncoder.encode(body) : body;
    return new MockResponse(status, "application/octet-stream", bytes, []);
  }

  /** A UTF-8 plain text response. */
  static text(status: number, body: string): MockResponse {
    return new MockResponse(status, "text/plain; charset=utf-8", textEncoder.encode(body), []);
  }

  /** A JSON response (`application/json`). */
  static json(status: number, value: unknown): MockResponse {
    return new MockResponse(status, "application/json", textEncoder.encode(JSON.stringify(value)), []);
  }

  /** A server-sent-events response (`200`, `text/event-stream`). */
  static events(body: string): MockResponse {
    return new MockResponse(200, "text/event-stream", textEncoder.encode(body), []);
  }

  /** Add one more header and return `this`. */
  header(name: string, value: string): this {
    this.headers.push([name, value]);
    return this;
  }
}

/** Handler closure answering a `MockRequest`. */
export type MockHttpHandler = (request: MockRequest) => MockResponse | Promise<MockResponse>;

class MockSocketReader {
  private readonly socket: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private waiter: (() => void) | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      if (chunk.byteLength === 0) return;
      this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      if (this.waiter) {
        const wake = this.waiter;
        this.waiter = null;
        wake();
      }
    });
    const finish = (): void => {
      this.ended = true;
      if (this.waiter) {
        const wake = this.waiter;
        this.waiter = null;
        wake();
      }
    };
    socket.on("end", finish);
    socket.on("error", finish);
    socket.on("close", finish);
  }

  private async waitMore(): Promise<boolean> {
    if (this.ended) return false;
    const before = this.buffer.byteLength;
    await new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
    return this.buffer.byteLength > before;
  }

  async readRequest(): Promise<MockRequest | null> {
    let headEnd = -1;
    while ((headEnd = this.buffer.indexOf(CRLF_CRLF)) === -1) {
      if (!(await this.waitMore())) {
        return null;
      }
    }

    const headText = this.buffer.subarray(0, headEnd).toString("utf8");
    this.buffer = this.buffer.subarray(headEnd + 4);

    const lines = headText.split("\r\n");
    if (lines.length === 0) return null;
    const first = lines[0].split(" ");
    if (first.length < 2) return null;
    const method = first[0];
    const target = first[1];

    const headers = new Map<string, string>();
    for (let i = 1; i < lines.length; i++) {
      const colon = lines[i].indexOf(":");
      if (colon === -1) continue;
      headers.set(lines[i].slice(0, colon).trim().toLowerCase(), lines[i].slice(colon + 1).trim());
    }

    const transferEncoding = headers.get("transfer-encoding")?.toLowerCase() ?? "";
    let body: Uint8Array;
    if (transferEncoding.includes("chunked")) {
      if (headers.get("expect")?.toLowerCase() === "100-continue" && this.buffer.byteLength === 0) {
        this.socket.write("HTTP/1.1 100 Continue\r\n\r\n");
      }
      body = await this.readChunkedBody();
    } else {
      const rawLength = headers.get("content-length");
      const length = rawLength ? Number.parseInt(rawLength, 10) : 0;
      const targetLen = Number.isFinite(length) && length > 0 ? length : 0;
      if (headers.get("expect")?.toLowerCase() === "100-continue" && this.buffer.byteLength < targetLen) {
        this.socket.write("HTTP/1.1 100 Continue\r\n\r\n");
      }
      if (targetLen === 0) {
        body = EMPTY_BYTES;
      } else if (this.buffer.byteLength >= targetLen) {
        body = new Uint8Array(this.buffer.subarray(0, targetLen));
      } else {
        const out = new Uint8Array(targetLen);
        let filled = Math.min(this.buffer.byteLength, targetLen);
        if (filled > 0) {
          out.set(this.buffer.subarray(0, filled), 0);
        }
        this.buffer = Buffer.alloc(0);
        while (filled < targetLen) {
          if (!(await this.waitMore())) {
            break;
          }
          const toCopy = Math.min(this.buffer.byteLength, targetLen - filled);
          out.set(this.buffer.subarray(0, toCopy), filled);
          filled += toCopy;
          this.buffer = toCopy === this.buffer.byteLength ? Buffer.alloc(0) : this.buffer.subarray(toCopy);
        }
        body = filled === targetLen ? out : out.subarray(0, filled);
      }
    }

    return new MockRequest(method, target, headers, body);
  }

  private async readChunkedBody(): Promise<Uint8Array> {
    const parts: Buffer[] = [];
    while (true) {
      let lineEnd = -1;
      while ((lineEnd = this.buffer.indexOf(CRLF)) === -1) {
        if (!(await this.waitMore())) {
          return parts.length === 0 ? EMPTY_BYTES : new Uint8Array(Buffer.concat(parts));
        }
      }
      const sizeLine = this.buffer.subarray(0, lineEnd).toString("ascii");
      this.buffer = this.buffer.subarray(lineEnd + 2);
      const semi = sizeLine.indexOf(";");
      const hex = (semi === -1 ? sizeLine : sizeLine.slice(0, semi)).trim();
      const size = Number.parseInt(hex, 16);
      if (!Number.isFinite(size) || size < 0) {
        break;
      }
      if (size === 0) {
        // Consume optional trailers until trailing CRLF.
        while (this.buffer.byteLength < 2 && (await this.waitMore())) {
          // wait
        }
        break;
      }
      while (this.buffer.byteLength < size + 2) {
        if (!(await this.waitMore())) {
          break;
        }
      }
      const chunkBytes = this.buffer.subarray(0, Math.min(size, this.buffer.byteLength));
      parts.push(Buffer.from(chunkBytes));
      this.buffer = this.buffer.subarray(Math.min(size + 2, this.buffer.byteLength));
    }
    return parts.length === 0 ? EMPTY_BYTES : new Uint8Array(Buffer.concat(parts));
  }
}

/**
 * A minimal loopback HTTP/1.1 test server: records every request and answers from a scripted
 * response queue or dynamic handler closure.
 */
export class MockHttpServer {
  /** Bound loopback address. */
  readonly addr: { readonly host: string; readonly port: number };
  /** Base URL (`http://127.0.0.1:<port>`). */
  readonly url: string;
  /** All recorded requests in arrival order. */
  readonly requests: MockRequest[] = [];

  private readonly netServer: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly queue: Array<MockResponse | MockHttpHandler> = [];
  private handler: MockHttpHandler | undefined;
  private closed = false;

  private constructor(
    addr: { host: string; port: number },
    netServer: net.Server,
    handler?: MockHttpHandler,
  ) {
    this.addr = addr;
    this.url = `http://${addr.host}:${addr.port}`;
    this.netServer = netServer;
    this.handler = handler;
  }

  /** Start a new mock HTTP server on a free loopback port (`127.0.0.1:0`). */
  static async start(handler?: MockHttpHandler): Promise<MockHttpServer> {
    let instance!: MockHttpServer;
    const netServer = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("error", () => {});
      socket.setNoDelay(true);
      instance.sockets.add(socket);
      socket.once("close", () => {
        instance.sockets.delete(socket);
      });
      void instance.handleSocket(socket);
    });

    await new Promise<void>((resolve, reject) => {
      netServer.once("error", reject);
      netServer.listen({ host: "127.0.0.1", port: 0 }, () => {
        netServer.off("error", reject);
        resolve();
      });
    });
    netServer.on("error", () => {});

    const raw = netServer.address();
    if (!raw || typeof raw === "string") {
      netServer.close();
      throw new Error("MockHttpServer failed to obtain a bound loopback port");
    }

    instance = new MockHttpServer({ host: raw.address, port: raw.port }, netServer, handler);
    return instance;
  }

  /** Enqueue one or more scripted responses (or per-request handlers), consumed FIFO before the fallback handler. */
  enqueue(...responses: Array<MockResponse | MockHttpHandler>): this {
    this.queue.push(...responses);
    return this;
  }

  /** Set or replace the fallback request handler. */
  setHandler(handler: MockHttpHandler | undefined): this {
    this.handler = handler;
    return this;
  }

  /** Clear recorded requests. */
  clearRequests(): void {
    this.requests.length = 0;
  }

  private async handleSocket(socket: net.Socket): Promise<void> {
    const reader = new MockSocketReader(socket);
    const request = await reader.readRequest();
    if (!request || this.closed) {
      socket.destroy();
      return;
    }
    this.requests.push(request);

    let response: MockResponse;
    try {
      const next = this.queue.shift();
      if (next !== undefined) {
        response = typeof next === "function" ? await next(request) : next;
      } else if (this.handler) {
        response = await this.handler(request);
      } else {
        response = MockResponse.json(404, { error: "No mock response configured" });
      }
    } catch (err) {
      response = MockResponse.json(500, { error: errorMessage(err) });
    }

    if (socket.destroyed || this.closed) {
      socket.destroy();
      return;
    }

    let more = "";
    for (const [name, value] of response.headers) {
      more += `${name}: ${value}\r\n`;
    }
    const head = `HTTP/1.1 ${response.status} OK\r\ncontent-type: ${response.contentType}\r\ncontent-length: ${response.body.byteLength}\r\n${more}connection: close\r\n\r\n`;
    const headBytes = textEncoder.encode(head);

    try {
      const combined = Buffer.allocUnsafe(headBytes.byteLength + response.body.byteLength);
      combined.set(headBytes, 0);
      combined.set(response.body, headBytes.byteLength);
      await new Promise<void>((resolve) => {
        socket.write(combined, () => resolve());
      });
      await new Promise<void>((resolve) => {
        socket.end(() => resolve());
      });
    } catch {
      // Ignore write errors if peer closed early.
    }
    if (!socket.destroyed) {
      if (socket.readableEnded) {
        socket.destroy();
      } else {
        const timer = setTimeout(() => socket.destroy(), 250);
        timer.unref?.();
        socket.once("end", () => {
          clearTimeout(timer);
          socket.destroy();
        });
        socket.resume();
      }
    }
  }

  /** Stop the mock server and close all connections. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      try {
        this.netServer.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  /** Alias for `close()`. */
  async shutdown(): Promise<void> {
    await this.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Convenience matching Rust `neo_testkit::http::serve(handler)`. */
export async function serveMockHttp(handler?: MockHttpHandler): Promise<MockHttpServer> {
  return await MockHttpServer.start(handler);
}

// ============================================================================
// Generic ScriptedDriver / ScriptedKernels helpers
// ============================================================================

/** Context handed to a scripted model for one turn. */
export class ScriptedTurn {
  readonly sessionId: string;
  readonly id: string;
  readonly text: string;
  readonly content: Block[];
  readonly deliver: Deliver;
  readonly resume?: string;
  readonly tools?: ToolHost;
  /** Mutable list of background jobs; adding entries leaves `awaitingAsync = true` on idle. */
  readonly jobs: KernelJob[];

  constructor(init: {
    sessionId: string;
    id: string;
    text: string;
    content: Block[];
    deliver: Deliver;
    resume?: string;
    tools?: ToolHost;
    jobs: KernelJob[];
  }) {
    this.sessionId = init.sessionId;
    this.id = init.id;
    this.text = init.text;
    this.content = init.content;
    this.deliver = init.deliver;
    this.resume = init.resume;
    this.tools = init.tools;
    this.jobs = init.jobs;
  }

  /** Call a tool as a runtime would: guard first, then host. */
  async callTool(name: string, args: unknown): Promise<unknown> {
    if (!this.tools) {
      throw new Error(`No ToolHost attached for tool ${name}`);
    }
    if (this.tools.guard) {
      const verdict = await this.tools.guard(name, args);
      if (verdict.decision === "block") {
        throw new Error(verdict.reason);
      }
    }
    return await this.tools.call(name, args);
  }

  /** Return the first JSON object paragraph in `text` that contains `field`. */
  card(field: string): Record<string, unknown> | undefined {
    for (const part of this.text.split("\n\n")) {
      try {
        const parsed: unknown = JSON.parse(part);
        if (isRecord(parsed) && field in parsed) {
          return parsed;
        }
      } catch {
        // Not a JSON paragraph.
      }
    }
    return undefined;
  }

  /** Whether `text` contains `needle`. */
  has(needle: string): boolean {
    return this.text.includes(needle);
  }
}

/** What a scripted model returns at the end of a turn. */
export type ScriptedTurnOutcome = string | { readonly text: string; readonly stopReason?: string };

/** Scripted model closure invoked once per submitted turn. */
export type ScriptedModel = (turn: ScriptedTurn) => Promise<ScriptedTurnOutcome> | ScriptedTurnOutcome;

/** Record of one turn executed by a scripted driver. */
export interface ScriptedRanTurn {
  readonly sessionId: string;
  readonly id: string;
  readonly text: string;
  readonly deliver: Deliver;
  readonly resume?: string;
  readonly model?: string;
}

/** Options for `new ScriptedDriver(...)`. */
export interface ScriptedDriverOptions {
  sessionId: string;
  events: UnboundedChannel<DriverEvent>;
  tools?: ToolHost;
  model?: ScriptedModel;
  getModel?: () => ScriptedModel | undefined;
  kernelName?: string;
  runtimeId?: string;
  modelName?: string;
  refuseCancel?: () => boolean;
  waitIfHeld?: () => Promise<void>;
  onTurnStart?: (ran: ScriptedRanTurn) => void;
  onTurnEnd?: () => void;
  onSetModel?: (sessionId: string, model?: string, thinking?: string) => void;
  onClose?: (sessionId: string) => void;
}

interface QueuedSubmission {
  readonly id: string;
  readonly content: Block[];
  readonly text: string;
  readonly deliver: Deliver;
  readonly resume?: string;
}

/** A minimal in-memory `Driver` that runs submitted turns through a scripted closure. */
export class ScriptedDriver implements Driver {
  readonly sessionId: string;
  readonly jobsList: KernelJob[] = [];
  readonly acknowledged: string[] = [];
  readonly ran: ScriptedRanTurn[] = [];
  readonly setModels: Array<{ model?: string; thinking?: string }> = [];

  private readonly kernelName: string;
  private readonly runtimeId: string;
  private readonly events: UnboundedChannel<DriverEvent>;
  private readonly tools?: ToolHost;
  private readonly queue = new UnboundedChannel<QueuedSubmission>();
  private readonly options: ScriptedDriverOptions;
  private modelFn: ScriptedModel | undefined;
  private currentModelName: string | undefined;
  private closed = false;
  private closeListeners = new Set<() => void>();

  constructor(options: ScriptedDriverOptions) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.kernelName = options.kernelName ?? "scripted";
    this.runtimeId = options.runtimeId ?? `rt-${options.sessionId}`;
    this.events = options.events;
    this.tools = options.tools;
    this.modelFn = options.model;
    this.currentModelName = options.modelName;
    void this.runLoop();
  }

  /** Replace this driver's scripted model closure. */
  setScriptedModel(model: ScriptedModel | undefined): void {
    this.modelFn = model;
  }

  kernel(): string {
    return this.kernelName;
  }

  async submit(id: string, content: Block[], deliver: Deliver, resume?: string): Promise<void> {
    if (this.closed) {
      throw new Error("The scripted runtime is closed");
    }
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text") {
        parts.push(block.text);
      }
    }
    this.queue.send({ id, content, text: parts.join("\n\n"), deliver, resume });
  }

  async interrupt(): Promise<void> {}

  async jobs(): Promise<KernelJob[]> {
    return this.jobsList.map((job) => ({ ...job, pids: [...job.pids] }));
  }

  async acknowledge(ids: string[]): Promise<void> {
    this.acknowledged.push(...ids);
  }

  async cancel(id: string): Promise<boolean> {
    if (this.options.refuseCancel?.()) {
      return false;
    }
    const before = this.jobsList.length;
    for (let i = this.jobsList.length - 1; i >= 0; i--) {
      if (this.jobsList[i].id === id) {
        this.jobsList.splice(i, 1);
      }
    }
    return this.jobsList.length !== before;
  }

  async setModel(model?: string, thinking?: string): Promise<void> {
    this.currentModelName = model;
    this.setModels.push({ model, thinking });
    this.options.onSetModel?.(this.sessionId, model, thinking);
  }

  pid(): number | undefined {
    return undefined;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
    for (const listener of this.closeListeners) {
      listener();
    }
    this.closeListeners.clear();
    this.options.onClose?.(this.sessionId);
  }

  private waitClosed(): { promise: Promise<void>; unsubscribe: () => void } {
    if (this.closed) {
      return { promise: Promise.resolve(), unsubscribe: () => {} };
    }
    let fn!: () => void;
    const promise = new Promise<void>((resolve) => {
      fn = resolve;
      this.closeListeners.add(fn);
    });
    return {
      promise,
      unsubscribe: () => {
        this.closeListeners.delete(fn);
      },
    };
  }

  private async runLoop(): Promise<void> {
    while (true) {
      const next = await this.queue.recv();
      if (next === undefined || this.closed) {
        return;
      }
      this.events.send({ type: "sessionId", id: this.runtimeId });
      this.events.send({ type: "running" });
      this.events.send({ type: "taken", id: next.id });

      const ran: ScriptedRanTurn = {
        sessionId: this.sessionId,
        id: next.id,
        text: next.text,
        deliver: next.deliver,
        resume: next.resume,
        model: this.currentModelName,
      };
      this.ran.push(ran);
      this.options.onTurnStart?.(ran);

      if (this.options.waitIfHeld) {
        const closedWait = this.waitClosed();
        await Promise.race([this.options.waitIfHeld(), closedWait.promise]);
        closedWait.unsubscribe();
        if (this.closed) {
          this.options.onTurnEnd?.();
          return;
        }
      }

      const turn = new ScriptedTurn({
        sessionId: this.sessionId,
        id: next.id,
        text: next.text,
        content: next.content,
        deliver: next.deliver,
        resume: next.resume,
        tools: this.tools,
        jobs: this.jobsList,
      });

      const model = this.modelFn ?? this.options.getModel?.();
      const closedWait = this.waitClosed();
      const outcomePromise: Promise<{ closed: false; text: string; stopReason: string }> = (async () => {
        try {
          const result = model ? await model(turn) : "Done.";
          if (typeof result === "string") {
            return { closed: false as const, text: result, stopReason: "stop" };
          }
          return { closed: false as const, text: result.text, stopReason: result.stopReason ?? "stop" };
        } catch (err) {
          return { closed: false as const, text: errorMessage(err), stopReason: "error" };
        }
      })();

      const raced = await Promise.race([
        outcomePromise,
        closedWait.promise.then(() => ({ closed: true as const })),
      ]);
      closedWait.unsubscribe();
      this.options.onTurnEnd?.();

      if (raced.closed || this.closed) {
        return;
      }

      this.events.send({
        type: "message",
        message: {
          role: "assistant",
          content: [textBlock(raced.text)],
          stopReason: raced.stopReason,
        },
      });
      this.events.send({
        type: "idle",
        awaitingAsync: this.jobsList.length > 0,
      });
    }
  }
}

/** Generic scripted kernel registry/factory for spawning coordinated `ScriptedDriver` instances in tests. */
export class ScriptedKernels {
  /** Shared scripted model invoked for all opened drivers unless overridden per driver. */
  model: ScriptedModel | undefined;
  /** All turns run across all opened drivers. */
  readonly ran: ScriptedRanTurn[] = [];
  /** All session ids opened through this registry. */
  readonly opened: string[] = [];
  /** All `setModel` calls across opened drivers. */
  readonly setModels: Array<{ sessionId: string; model?: string; thinking?: string }> = [];
  /** All session ids whose drivers were closed. */
  readonly closed: string[] = [];
  /** When true, `Driver.cancel` returns `false`. */
  refuseCancel = false;
  /** Number of turns currently executing. */
  active = 0;
  /** Peak concurrent turns observed. */
  mostActive = 0;

  private held = false;
  private waiters: Array<() => void> = [];

  constructor(model?: ScriptedModel) {
    this.model = model;
  }

  /** Pause new turns before invoking `model` until `release()` is called. */
  hold(): void {
    this.held = true;
  }

  /** Resume all held turns. */
  release(): void {
    this.held = false;
    const toWake = this.waiters;
    this.waiters = [];
    for (const wake of toWake) {
      wake();
    }
  }

  private async waitIfHeld(): Promise<void> {
    while (this.held) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  /** Open a new `ScriptedDriver` wired into this registry's shared state. */
  open(
    sessionId: string,
    events: UnboundedChannel<DriverEvent>,
    tools?: ToolHost,
    modelName?: string,
  ): ScriptedDriver {
    this.opened.push(sessionId);
    return new ScriptedDriver({
      sessionId,
      events,
      tools,
      modelName,
      getModel: () => this.model,
      refuseCancel: () => this.refuseCancel,
      waitIfHeld: () => this.waitIfHeld(),
      onTurnStart: (ran) => {
        this.ran.push(ran);
        this.active += 1;
        if (this.active > this.mostActive) {
          this.mostActive = this.active;
        }
      },
      onTurnEnd: () => {
        this.active = Math.max(0, this.active - 1);
      },
      onSetModel: (sid, model, thinking) => {
        this.setModels.push({ sessionId: sid, model, thinking });
      },
      onClose: (sid) => {
        this.closed.push(sid);
      },
    });
  }
}
