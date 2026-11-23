/**
 * The HTTP API end to end, over a scripted kernel: every route's contract, who may call,
 * the web build's files, and the protocol's edges.
 *
 * Ported directly from Rust `neo-http/tests/api.rs` with complete route coverage over
 * the real `App` and `serve` HTTP/1.1 server.
 */

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  App,
  Protocol,
  agyTokenFile,
  inspectAntigravityAccount,
  logoutAntigravity,
} from "../../src/app/index.ts";
import type { AccountStatus, LoginCommand } from "../../src/app/index.ts";
import { send } from "../../src/app/http.ts";
import { formatSocketAddr, serve } from "../../src/http/index.ts";
import type { Access, Server, SocketAddr } from "../../src/http/index.ts";
import { MockResponse, TempDir, serveMockHttp } from "../../src/testkit/index.ts";
import {
  Fixture,
  Scripted,
  ScriptedKernels,
  coreModel,
  fixture,
  openIn,
  started,
  watchdogTimings,
} from "../app/common.ts";

const utf8Decoder = new TextDecoder("utf-8");

type JsonObj = Record<string, unknown>;

function asObj(value: unknown): JsonObj {
  expect(typeof value === "object" && value !== null && !Array.isArray(value)).toBe(true);
  return value as JsonObj;
}

function asArray(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

class Api {
  readonly base: string;
  readonly token?: string;

  constructor(base: string, token?: string) {
    this.base = base;
    this.token = token;
  }

  async call(method: string, reqPath: string, body?: unknown): Promise<[number, unknown]> {
    const headers: Array<[string, string]> = [];
    if (body !== undefined) {
      headers.push(["content-type", "application/json; charset=utf-8"]);
    }
    if (this.token !== undefined) {
      headers.push(["authorization", `Bearer ${this.token}`]);
    }
    const result = await send({
      method,
      url: `${this.base}${reqPath}`,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      timeoutMs: 20_000,
      want: [],
    });
    if (!result.ok) {
      throw new Error(`the server answers (${method} ${reqPath}): ${JSON.stringify(result.error)}`);
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(utf8Decoder.decode(result.value.body));
    } catch {
      parsed = null;
    }
    return [result.value.status, parsed];
  }

  async get(reqPath: string): Promise<[number, unknown]> {
    return await this.call("GET", reqPath);
  }
}

async function open(f: Fixture, access: Access = {}): Promise<{ server: Server; api: Api }> {
  const token = access.token;
  const server = await serve(f.app, "127.0.0.1", 0, access);
  const base = `http://${formatSocketAddr(server.addr)}`;
  return { server, api: new Api(base, token) };
}

/**
 * Buffered TCP client stream that captures incoming data events immediately on connect
 * so no bytes or EOF events are lost between sequential reads on a keep-alive connection.
 */
class TcpStream {
  readonly socket: net.Socket;
  private chunks: Buffer[] = [];
  private ended = false;
  private error: Error | null = null;
  private waiter: (() => void) | null = null;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      if (chunk.byteLength > 0) {
        this.chunks.push(chunk);
        this.wake();
      }
    });
    socket.on("end", () => {
      this.ended = true;
      this.wake();
    });
    socket.on("close", () => {
      this.ended = true;
      this.wake();
    });
    socket.on("error", (err: Error) => {
      this.error = err;
      this.ended = true;
      this.wake();
    });
  }

  static async connect(addr: SocketAddr): Promise<TcpStream> {
    return await new Promise<TcpStream>((resolve, reject) => {
      const socket = net.createConnection({ host: addr.host, port: addr.port }, () => {
        socket.off("error", onConnectError);
        socket.setNoDelay(true);
        resolve(new TcpStream(socket));
      });
      const onConnectError = (err: Error): void => {
        reject(err);
      };
      socket.once("error", onConnectError);
    });
  }

  private wake(): void {
    if (this.waiter !== null) {
      const fn = this.waiter;
      this.waiter = null;
      fn();
    }
  }

  private waitEvent(timeoutMs: number): Promise<boolean> {
    if (this.ended) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.waiter === wake) {
          this.waiter = null;
        }
        resolve(ok);
      };
      const wake = (): void => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.waiter = wake;
    });
  }

  async writeAll(data: string | Uint8Array): Promise<void> {
    await new Promise<void>((resolve) => {
      try {
        this.socket.write(data, () => resolve());
      } catch {
        resolve();
      }
    });
  }

  private takeBuffered(): Buffer {
    if (this.chunks.length === 0) {
      return Buffer.alloc(0);
    }
    const merged = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = [];
    return merged;
  }

  /** Read until `predicate` matches the accumulated bytes, or EOF. Throws on timeout. */
  async readUntil(predicate: (buf: Buffer) => boolean, timeoutMs = 10_000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    let acc = this.takeBuffered();
    while (!predicate(acc) && !this.ended) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for response (received ${acc.byteLength} bytes)`);
      }
      const ok = await this.waitEvent(remaining);
      if (!ok) {
        throw new Error(`Timed out waiting for response (received ${acc.byteLength} bytes)`);
      }
      const next = this.takeBuffered();
      if (next.byteLength > 0) {
        acc = acc.byteLength === 0 ? next : Buffer.concat([acc, next]);
      }
    }
    return acc;
  }

  /** Read until the server closes the connection. Throws on timeout. */
  async readToEnd(timeoutMs = 10_000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    const out: Buffer[] = [];
    const flush = (): void => {
      const next = this.takeBuffered();
      if (next.byteLength > 0) {
        out.push(next);
      }
    };
    flush();
    while (!this.ended) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("the server closes the connection");
      }
      const ok = await this.waitEvent(remaining);
      if (!ok) {
        throw new Error("the server closes the connection");
      }
      flush();
    }
    flush();
    return out.length === 0 ? Buffer.alloc(0) : out.length === 1 ? out[0] : Buffer.concat(out);
  }

  lastError(): Error | null {
    return this.error;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** Send raw bytes and read until the server closes the connection (mirrors Rust `raw()`). */
async function raw(server: Server, bytes: string | Uint8Array): Promise<string> {
  const stream = await TcpStream.connect(server.addr);
  try {
    await stream.writeAll(bytes);
    const answer = await stream.readToEnd(10_000);
    return answer.toString("utf8");
  } finally {
    stream.destroy();
  }
}

function statusCodeOf(rawResponse: string): string {
  return rawResponse.split(" ")[1] ?? "";
}

function statusLineOf(rawResponse: string): string {
  const crlf = rawResponse.indexOf("\r\n");
  if (crlf !== -1) {
    return rawResponse.slice(0, crlf);
  }
  const lf = rawResponse.indexOf("\n");
  return lf === -1 ? rawResponse : rawResponse.slice(0, lf);
}

// ============================================================================
// Ported end-to-end tests from neo-http/tests/api.rs
// ============================================================================

describe("neo-http/tests/api.rs end-to-end HTTP API tests", () => {
  test("serves_every_route_of_the_app", async () => {
    const f = fixture();
    let server: Server | undefined;
    try {
      f.kernels.models = [
        {
          id: "gemini-3.8-flash-low",
          provider: "antigravity",
          name: "Gemini 3.8 Flash (Low)",
        },
      ];
      await f.app.start();
      const opened = await open(f, {});
      server = opened.server;
      const { api } = opened;

      const [healthStatus, healthRaw] = await api.get("/api/health");
      const health = asObj(healthRaw);
      expect([healthStatus, health.ready, health.kernel]).toEqual([200, true, "antigravity"]);
      expect(await api.get("/api/messages")).toEqual([200, { messages: [] }]);
      expect(await api.get("/api/workers")).toEqual([200, { workers: [] }]);
      expect(await api.get("/api/activity")).toEqual([200, { router: false, workers: [] }]);

      // A chat message is taken once, however often it is sent.
      const message = {
        text: "  Please fix the typo in the fixture.  ",
        messageId: "web:m1",
        attachments: [{ name: "notes.md", mediaType: "text/markdown", data: "IyBOb3Rlcw==" }],
      };
      const [postStatus, receiptRaw] = await api.call("POST", "/api/chat", message);
      const receipt = asObj(receiptRaw);
      expect([postStatus, receipt.requestId, receipt.result]).toEqual([
        202,
        "chat:web:m1",
        "stored",
      ]);
      const [dupStatus, againRaw] = await api.call("POST", "/api/chat", message);
      const again = asObj(againRaw);
      expect([dupStatus, again.result, again.triggerId]).toEqual([
        202,
        "duplicate",
        receipt.triggerId,
      ]);

      await f.until("the result is in the transcript", () => f.chat().length >= 3);
      await f.settle();

      const [, messagesPayloadRaw] = await api.get("/api/messages");
      const messages = asArray(asObj(messagesPayloadRaw).messages).map(asObj);
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
      expect(
        typeof messages[0].text === "string" &&
          messages[0].text.startsWith(
            'Please fix the typo in the fixture.\n\n<attachment name="notes.md">',
          ),
      ).toBe(true);
      expect(messages[0].files).toEqual([
        { name: "notes.md", mediaType: "text/markdown", kind: "text" },
      ]);
      expect(messages[2].text).toBe("Fixture work completed.");

      const [, workersPayloadRaw] = await api.get("/api/workers");
      const workers = asArray(asObj(workersPayloadRaw).workers).map(asObj);
      const id = String(workers[0].ticketId);
      expect([workers.length, workers[0].stage]).toEqual([1, { stage: "ended" }]);

      const [workerStatus, workerRaw] = await api.get(`/api/workers/${id}`);
      const worker = asObj(workerRaw);
      expect([
        workerStatus,
        worker.ticketId,
        Array.isArray(worker.recent),
        Array.isArray(worker.inputs),
      ]).toEqual([200, id, true, true]);
      expect(await api.get("/api/workers/missing")).toEqual([404, { error: "Worker not found" }]);
      expect((await api.get("/api/workers/a%2Fb"))[0]).toBe(404);
      expect(await api.call("POST", `/api/workers/${id}/stop`)).toEqual([
        400,
        { error: "Task has already ended" },
      ]);
      expect(await api.call("POST", "/api/workers/missing/stop")).toEqual([
        404,
        { error: "Worker not found" },
      ]);
      expect((await api.call("POST", "/api/workers/a%2Fb/stop"))[0]).toBe(404);
      expect((await api.call("POST", "/api/workers//stop"))[0]).toBe(404);

      // Models and Antigravity installation.
      const [modelsStatus, modelsRaw] = await api.get("/api/settings/models");
      const models = asObj(modelsRaw);
      const available = asArray(models.available).map(asObj);
      expect([modelsStatus, models.kernel, available[0]?.id]).toEqual([
        200,
        "antigravity",
        "gemini-3.8-flash-low",
      ]);

      const chosen = {
        eval: { provider: "antigravity", model: "gemini-3.8-flash-low" },
        executor: null,
      };
      const [putModelsStatus, putModelsRaw] = await api.call("PUT", "/api/settings/models", chosen);
      expect([putModelsStatus, asObj(putModelsRaw).current]).toEqual([200, chosen]);

      const [installStatus, installedRaw] = await api.call("POST", "/api/settings/kernel/install", {
        kernel: "antigravity",
      });
      const installed = asObj(installedRaw);
      expect([installStatus, installed.kernel, installed.installing]).toEqual([
        200,
        "antigravity",
        false,
      ]);
      expect(
        await api.call("POST", "/api/settings/kernel/install", { kernel: "other" }),
      ).toEqual([400, { error: "kernel must be antigravity" }]);

      // Removed multi-kernel and custom-provider routes return 404.
      expect(
        (await api.call("PUT", "/api/settings/kernel", { kernel: "antigravity" }))[0],
      ).toBe(404);
      expect((await api.get("/api/settings/providers"))[0]).toBe(404);
      expect((await api.call("POST", "/api/settings/accounts/key", {}))[0]).toBe(404);

      // Antigravity-only account endpoint (no multi-kernel or provider fields accepted).
      const [accountsStatus, accountsRaw] = await api.get("/api/settings/accounts");
      const accounts = asObj(accountsRaw);
      expect([accountsStatus, accounts.installed, !("kernels" in accounts)]).toEqual([
        200,
        true,
        true,
      ]);
      expect(
        await api.call("POST", "/api/settings/accounts/login", { kernel: "antigravity" }),
      ).toEqual([400, { error: "Unknown field kernel" }]);
      expect(
        await api.call("POST", "/api/settings/accounts/login", { provider: "google" }),
      ).toEqual([400, { error: "Unknown field provider" }]);
      expect(
        await api.call("POST", "/api/settings/accounts/logout", { account: "google" }),
      ).toEqual([400, { error: "Unknown field account" }]);

      // General settings.
      const [generalStatus, generalRaw] = await api.get("/api/settings/general");
      const general = asObj(generalRaw);
      expect([generalStatus, asObj(general.executor).maxWorkers, general.paused]).toEqual([
        200,
        3,
        false,
      ]);
      const [putGeneralStatus, putGeneralRaw] = await api.call("PUT", "/api/settings/general", {
        executor: { maxWorkers: 2 },
      });
      expect([putGeneralStatus, asObj(asObj(putGeneralRaw).executor).maxWorkers]).toEqual([
        200,
        2,
      ]);
      const [badGeneralStatus, refusedGeneralRaw] = await api.call("PUT", "/api/settings/general", {
        executor: { maxWorkers: 0 },
      });
      const refusedGeneral = asObj(refusedGeneralRaw);
      expect(badGeneralStatus).toBe(400);
      expect(String(refusedGeneral.error)).toContain("1 to 16");

      // WeChat: its state, and what cannot be done without a login.
      const [wechatStatus, wechatRaw] = await api.get("/api/wechat");
      expect([wechatStatus, asObj(wechatRaw).state]).toEqual([200, "disconnected"]);
      expect(await api.call("POST", "/api/wechat/verify", { code: "1234" })).toEqual([
        400,
        { error: "当前不需要微信验证码" },
      ]);
      expect(await api.call("POST", "/api/wechat/verify", { code: 1234 })).toEqual([
        400,
        { error: "Expected { code: string }" },
      ]);
      const [disconnectStatus, disconnectRaw] = await api.call("POST", "/api/wechat/disconnect");
      expect([disconnectStatus, asObj(disconnectRaw).state]).toEqual([200, "disconnected"]);

      // What a chat message must be.
      const refusedChat = (body: unknown) => api.call("POST", "/api/chat", body);
      expect(await refusedChat({ message: "x" })).toEqual([
        400,
        { error: "Expected { text: string }" },
      ]);
      expect(await refusedChat({ text: "   " })).toEqual([
        400,
        { error: "Message or attachment required; text limit 8000 characters" },
      ]);
      expect((await refusedChat({ text: "长".repeat(8001) }))[0]).toBe(400);
      expect((await refusedChat({ text: "é".repeat(8000), messageId: "web:long" }))[0]).toBe(202);

      const file = { name: "a.bin", data: "AA==" };
      expect(await refusedChat({ text: "x", attachments: [file, file, file, file] })).toEqual([
        400,
        { error: "At most 3 attachments" },
      ]);
      expect(
        await refusedChat({ text: "x", attachments: [{ name: "a", data: "@@" }] }),
      ).toEqual([400, { error: "Attachment data is invalid or exceeds 5 MiB" }]);
      expect(await refusedChat({ text: "x", attachments: "none" })).toEqual([
        400,
        { error: "attachments must be a list" },
      ]);
      expect(await refusedChat({ text: "x", messageId: 7 })).toEqual([
        400,
        { error: "messageId must be a string" },
      ]);
      expect(await refusedChat({ text: "x", messageId: "bad id" })).toEqual([
        400,
        { error: "Invalid chat message ID" },
      ]);

      const plain = await send({
        method: "POST",
        url: `${api.base}/api/chat`,
        headers: [["content-type", "text/plain"]],
        body: '{"text":"x"}',
        timeoutMs: 5_000,
        want: [],
      });
      expect(plain.ok).toBe(true);
      if (plain.ok) {
        expect(plain.value.status).toBe(415);
      }

      const broken = await send({
        method: "POST",
        url: `${api.base}/api/chat`,
        headers: [["content-type", "application/json"]],
        body: '{"text":',
        timeoutMs: 5_000,
        want: [],
      });
      expect(broken.ok).toBe(true);
      if (broken.ok) {
        expect(broken.value.status).toBe(400);
        expect(utf8Decoder.decode(broken.value.body)).toContain("Invalid JSON");
      }

      // Routes that are not there, by path or by method.
      expect(await api.get("/api/nothing")).toEqual([404, { error: "Not found" }]);
      expect((await api.call("POST", "/api/messages"))[0]).toBe(404);
      expect((await api.get("/"))[0]).toBe(404);

      // A reset empties the conversation and keeps the tickets.
      await f.settle();
      expect(await api.call("POST", "/api/session/reset")).toEqual([200, { reset: true }]);
      expect(await api.get("/api/messages")).toEqual([200, { messages: [] }]);
      const [, afterResetWorkersRaw] = await api.get("/api/workers");
      expect(asArray(asObj(afterResetWorkersRaw).workers).length).toBe(2);

      await api.call("POST", "/api/chat", { text: "And another typo." });
      await f.until("the conversation goes on", () => f.chat().length >= 3);
    } finally {
      if (server) {
        await server.shutdown();
      }
      await f.cleanup();
    }
  });

  test("lets_in_this_machine_alone_or_whoever_has_the_token", async () => {
    const f = await started();
    let openServer: Server | undefined;
    let tokenServer: Server | undefined;
    let wideServer: Server | undefined;
    try {
      const opened = await open(f, {});
      openServer = opened.server;
      const port = openServer.addr.port;
      const get = (headers: string) =>
        `GET /api/health HTTP/1.1\r\n${headers}Connection: close\r\n\r\n`;

      expect(statusCodeOf(await raw(openServer, get(`Host: 127.0.0.1:${port}\r\n`)))).toBe("200");
      expect(
        statusCodeOf(
          await raw(
            openServer,
            get(`Host: localhost:${port}\r\nOrigin: http://localhost:${port}\r\n`),
          ),
        ),
      ).toBe("200");

      // Another site's page in this machine's browser, and a foreign name resolving to this machine.
      const foreign = await raw(
        openServer,
        get(`Host: 127.0.0.1:${port}\r\nOrigin: https://evil.example\r\n`),
      );
      expect(statusCodeOf(foreign)).toBe("403");
      expect(foreign.endsWith('{"error":"Forbidden origin"}')).toBe(true);

      expect(statusCodeOf(await raw(openServer, get(`Host: rebind.example:${port}\r\n`)))).toBe(
        "403",
      );

      const posted =
        `POST /api/session/reset HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        "Origin: http://attacker.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
      expect(statusCodeOf(await raw(openServer, posted))).toBe("403");

      await openServer.shutdown();
      openServer = undefined;

      // With a token, every call carries it; the server says that it wants one, and nothing else.
      const token = "0123456789abcdef-token";
      const authed = await open(f, { token });
      tokenServer = authed.server;
      const { api } = authed;

      expect((await api.get("/api/health"))[0]).toBe(200);
      expect((await api.get("/api/messages"))[0]).toBe(200);

      const anonymous = new Api(api.base);
      const [anonHealthStatus, hintRaw] = await anonymous.get("/api/health");
      const hint = asObj(hintRaw);
      expect([anonHealthStatus, hint.authRequired, "components" in hint]).toEqual([
        401,
        true,
        false,
      ]);
      expect(await anonymous.get("/api/messages")).toEqual([
        401,
        { error: "A valid access token is required" },
      ]);
      expect((await anonymous.call("POST", "/api/chat", { text: "x" }))[0]).toBe(401);

      const wrong = new Api(api.base, "0123456789abcdef-tokex");
      expect((await wrong.get("/api/workers"))[0]).toBe(401);
      expect(f.chat()).toEqual([]);

      await tokenServer.shutdown();
      tokenServer = undefined;

      // An API without a token is not offered beyond this machine, nor with a token that is too short.
      await expect(serve(f.app, "0.0.0.0", 0, {})).rejects.toThrow(
        "Listening on 0.0.0.0 needs an access token: set one, or listen on 127.0.0.1",
      );
      await expect(serve(f.app, "127.0.0.1", 0, { token: "short" })).rejects.toThrow(
        "The access token must have at least 16 characters",
      );
      wideServer = await serve(f.app, "0.0.0.0", 0, { token });
      await wideServer.shutdown();
      wideServer = undefined;
    } finally {
      if (openServer) await openServer.shutdown();
      if (tokenServer) await tokenServer.shutdown();
      if (wideServer) await wideServer.shutdown();
      await f.cleanup();
    }
  });

  test("serves_the_web_build_beside_the_api", async () => {
    const f = await started();
    let server: Server | undefined;
    try {
      const web = f.dir.join("web");
      fs.mkdirSync(path.join(web, "assets", "fonts"), { recursive: true });
      fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Neo</title>");
      fs.writeFileSync(path.join(web, "main.dart.js"), "console.log('app')");
      fs.writeFileSync(path.join(web, "assets", "fonts", "a.otf"), Uint8Array.from([0, 1, 2]));
      fs.writeFileSync(f.dir.join("secret.txt"), "outside the web build");

      const opened = await open(f, { token: "0123456789abcdef-token", webDir: web });
      server = opened.server;
      const { api } = opened;

      const fetchPage = async (reqPath: string) => {
        const res = await send({
          method: "GET",
          url: `${api.base}${reqPath}`,
          timeoutMs: 5_000,
          want: ["content-type", "content-security-policy", "cache-control"],
        });
        if (!res.ok) {
          throw new Error(`GET ${reqPath} failed: ${JSON.stringify(res.error)}`);
        }
        return res.value;
      };

      // The page and its files need no token: the page is where the token is entered.
      const page = await fetchPage("/");
      expect([page.status, utf8Decoder.decode(page.body), page.headers[0], page.headers[2]]).toEqual([
        200,
        "<!doctype html><title>Neo</title>",
        "text/html; charset=utf-8",
        "no-cache",
      ]);
      expect(page.headers[1]).toContain("default-src 'self'");
      expect(page.headers[1]).toContain("frame-ancestors 'none'");

      const script = await fetchPage("/main.dart.js");
      expect([script.status, script.headers[0], utf8Decoder.decode(script.body)]).toEqual([
        200,
        "text/javascript; charset=utf-8",
        "console.log('app')",
      ]);

      const font = await fetchPage("/assets/fonts/a.otf");
      expect([font.status, font.headers[0], Array.from(font.body)]).toEqual([
        200,
        "font/otf",
        [0, 1, 2],
      ]);

      // A path that names no file is a page of the app; a missing file is missing.
      const spaRoute = await fetchPage("/settings/models");
      expect(spaRoute.status).toBe(200);
      expect(utf8Decoder.decode(spaRoute.body)).toBe("<!doctype html><title>Neo</title>");
      expect((await fetchPage("/missing.js")).status).toBe(404);

      // Nothing outside the folder is reachable (tested both via HTTP client and verbatim raw TCP
      // so client-side URL normalization cannot mask server-side traversal checks).
      const traversalPaths = [
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/assets/..%2f..%2fsecret.txt",
        "/assets/%2e%2e/%2e%2e/secret.txt",
        "/..%5csecret.txt",
      ];
      for (const reqPath of traversalPaths) {
        const answer = await fetchPage(reqPath);
        expect(answer.status).toBe(404);
        expect(utf8Decoder.decode(answer.body)).not.toContain("outside");

        const rawAnswer = await raw(
          server,
          `GET ${reqPath} HTTP/1.1\r\nHost: 127.0.0.1:${server.addr.port}\r\nConnection: close\r\n\r\n`,
        );
        expect(statusCodeOf(rawAnswer)).toBe("404");
        expect(rawAnswer).not.toContain("outside");
      }

      // Only reads, and the API beside it still wants its token.
      const postRoot = await send({
        method: "POST",
        url: `${api.base}/`,
        timeoutMs: 5_000,
      });
      expect(postRoot.ok).toBe(true);
      if (postRoot.ok) {
        expect(postRoot.value.status).toBe(404);
      }
      expect((await new Api(api.base).get("/api/messages"))[0]).toBe(401);
      expect((await api.get("/api/messages"))[0]).toBe(200);

      // A HEAD names the length and sends no body.
      const head = await raw(server, "HEAD / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      expect(head.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
      expect(head).toContain("content-length: 33\r\n");
      expect(head.endsWith("\r\n\r\n")).toBe(true);
    } finally {
      if (server) {
        await server.shutdown();
      }
      await f.cleanup();
    }
  });

  test("keeps_connections_open_and_refuses_what_it_cannot_serve", async () => {
    const f = await started();
    let server: Server | undefined;
    let keepAliveStream: TcpStream | undefined;
    let continueStream: TcpStream | undefined;
    let idleStream: TcpStream | undefined;
    try {
      const opened = await open(f, {});
      server = opened.server;
      const host = `Host: 127.0.0.1:${server.addr.port}\r\n`;

      // Two requests on one connection, the second closing it; a body split across writes.
      keepAliveStream = await TcpStream.connect(server.addr);
      await keepAliveStream.writeAll(`GET /api/messages HTTP/1.1\r\n${host}\r\n`);
      const firstBuf = await keepAliveStream.readUntil((buf) =>
        buf.toString("utf8").endsWith('{"messages":[]}'),
      );
      const first = firstBuf.toString("utf8");
      expect(first.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
      expect(first).toContain("connection: keep-alive\r\n");
      expect(first.endsWith('{"messages":[]}')).toBe(true);

      const body = '{"code":"1"}';
      await keepAliveStream.writeAll(
        `POST /api/wechat/verify HTTP/1.1\r\n${host}Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\nConnection: close\r\n\r\n${body.slice(0, 4)}`,
      );
      await Bun.sleep(30);
      await keepAliveStream.writeAll(body.slice(4));
      const second = (await keepAliveStream.readToEnd()).toString("utf8");
      expect(second.startsWith("HTTP/1.1 400 Bad Request\r\n")).toBe(true);
      expect(second).toContain("connection: close\r\n");
      expect(second).toContain("当前不需要微信验证码");
      keepAliveStream.destroy();
      keepAliveStream = undefined;

      // Protocol refusals: 413, 411, 400, 400 (bad Content-Length), 431.
      expect(
        statusLineOf(
          await raw(
            server,
            `POST /api/chat HTTP/1.1\r\n${host}Content-Type: application/json\r\nContent-Length: ${25 * 1024 * 1024}\r\n\r\n`,
          ),
        ),
      ).toBe("HTTP/1.1 413 Payload Too Large");

      expect(
        statusLineOf(
          await raw(
            server,
            `POST /api/chat HTTP/1.1\r\n${host}Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
          ),
        ),
      ).toBe("HTTP/1.1 411 Length Required");

      expect(statusLineOf(await raw(server, "NONSENSE\r\n\r\n"))).toBe("HTTP/1.1 400 Bad Request");

      expect(
        statusLineOf(
          await raw(server, `GET /api/health HTTP/1.1\r\n${host}Content-Length: many\r\n\r\n`),
        ),
      ).toBe("HTTP/1.1 400 Bad Request");

      expect(
        statusLineOf(await raw(server, `GET /${"a".repeat(70_000)} HTTP/1.1\r\n\r\n`)),
      ).toBe("HTTP/1.1 431 Request Header Fields Too Large");

      // A body announced with Expect is asked for before it is read.
      continueStream = await TcpStream.connect(server.addr);
      await continueStream.writeAll(
        `POST /api/wechat/verify HTTP/1.1\r\n${host}Content-Type: application/json\r\n` +
          `Expect: 100-continue\r\nContent-Length: ${Buffer.byteLength(body, "utf8")}\r\nConnection: close\r\n\r\n`,
      );
      const goBuf = await continueStream.readUntil(
        (buf) => buf.byteLength >= "HTTP/1.1 100 Continue\r\n\r\n".length,
      );
      expect(goBuf.toString("utf8")).toBe("HTTP/1.1 100 Continue\r\n\r\n");

      await continueStream.writeAll(body);
      const afterContinue = (await continueStream.readToEnd()).toString("utf8");
      expect(afterContinue.startsWith("HTTP/1.1 400 Bad Request")).toBe(true);
      continueStream.destroy();
      continueStream = undefined;

      // Stopping closes idle connections and frees the port.
      idleStream = await TcpStream.connect(server.addr);
      const addr = server.addr;
      await server.shutdown();
      server = undefined;
      const rest = await idleStream.readToEnd(5_000);
      expect(rest.byteLength).toBe(0);
      idleStream.destroy();
      idleStream = undefined;

      let connectFailed = false;
      try {
        const probe = await TcpStream.connect(addr);
        probe.destroy();
      } catch {
        connectFailed = true;
      }
      expect(connectFailed).toBe(true);
    } finally {
      keepAliveStream?.destroy();
      continueStream?.destroy();
      idleStream?.destroy();
      if (server) {
        await server.shutdown();
      }
      await f.cleanup();
    }
  });

  test("stops_an_active_worker_via_http_and_returns_ended_detail", async () => {
    const f = fixture();
    let server: Server | undefined;
    try {
      let running = false;
      f.script(async (turn) => {
        if (turn.role === "worker") {
          turn.jobs.push(Fixture.job("task_1", "task", "subagent"));
          turn.jobs.push(Fixture.job("bg_1", "bash", "sleep 30"));
          running = true;
          return "Background jobs started.";
        }
        const card = turn.card("kind");
        if (card && card.kind === "candidate") {
          await turn.call("orchestrator_route", {
            decisions: [
              {
                kind: "accept",
                trigger_id: card.trigger_id,
                title: "Long job",
                worktree_name: "long-job",
                acknowledgement: "Starting.",
              },
            ],
          });
        }
        return "Done.";
      });

      await f.app.start();
      const opened = await open(f, {});
      server = opened.server;
      const { api } = opened;

      await api.call("POST", "/api/chat", {
        text: "Start a long background task.",
        messageId: "web:stop1",
      });
      await f.until("worker is running", () => running);
      await f.settle();

      const [, workersPayloadRaw] = await api.get("/api/workers");
      const workers = asArray(asObj(workersPayloadRaw).workers).map(asObj);
      const id = String(workers[0].ticketId);

      const [status, stoppedRaw] = await api.call("POST", `/api/workers/${id}/stop`);
      const stopped = asObj(stoppedRaw);
      expect(status).toBe(200);
      expect(stopped.stage).toEqual({ stage: "ended" });
      expect(stopped.outcome).toBe("stopped");
      expect(stopped.session).toEqual({ loaded: false, streaming: false });
      expect(stopped.background).toEqual([]);
      expect(await api.call("POST", `/api/workers/${id}/stop`)).toEqual([
        400,
        { error: "Task has already ended" },
      ]);
    } finally {
      if (server) {
        await server.shutdown();
      }
      await f.cleanup();
    }
  });
});

// ============================================================================
// Additional end-to-end route tests over real App + serve HTTP server
// ============================================================================

class AccountScriptedKernels extends ScriptedKernels {
  private readonly homeDir: string;
  private readonly loginScript: string;

  constructor(scripted: Scripted, homeDir: string, loginScript: string) {
    super(scripted);
    this.homeDir = homeDir;
    this.loginScript = loginScript;
  }

  override async account(): Promise<AccountStatus> {
    return inspectAntigravityAccount(this.homeDir);
  }

  override login(): LoginCommand {
    return {
      program: process.execPath,
      args: ["-e", this.loginScript],
      env: {},
    };
  }

  override async logout(): Promise<void> {
    logoutAntigravity(this.homeDir);
  }
}

describe("Additional end-to-end HTTP route coverage over real App + serve", () => {
  test("accounts login, login/input, login/cancel, and logout end to end over HTTP", async () => {
    const dir = new TempDir("http-accounts");
    const homeDir = dir.join("home");
    fs.mkdirSync(homeDir, { recursive: true });

    const loginScript = [
      'console.log("Sign in at https://accounts.google.com/o/oauth2/auth?state=e2e-test");',
      "process.stdin.resume();",
      'process.stdin.on("data", (chunk) => {',
      '  const line = chunk.toString("utf8").trim();',
      '  console.log("Got code: " + line);',
      "  process.exit(0);",
      "});",
    ].join("\n");

    const scripted = new Scripted();
    scripted.model = coreModel();
    const kernels = new AccountScriptedKernels(scripted, homeDir, loginScript);
    const app = App.open(
      { stateDir: dir.join("state"), wechat: scripted.wechat },
      kernels,
      { wechatBurstMs: 60, webBurstMs: 0, watchdog: watchdogTimings() },
    );
    const f = new Fixture(dir, scripted, app);

    let server: Server | undefined;
    try {
      await f.app.start();
      const opened = await open(f, {});
      server = opened.server;
      const { api } = opened;

      // Initial state: no login running, no token file.
      expect(await api.get("/api/settings/accounts/login")).toEqual([200, { login: null }]);
      const [initAccStatus, initAccRaw] = await api.get("/api/settings/accounts");
      const initAcc = asObj(initAccRaw);
      expect([initAccStatus, initAcc.installed, initAcc.account, initAcc.problem]).toEqual([
        200,
        true,
        null,
        null,
      ]);

      // Sending input before a login starts is refused.
      expect(
        await api.call("POST", "/api/settings/accounts/login/input", { text: "code-0" }),
      ).toEqual([400, { error: "No login is waiting" }]);

      // Start login (no request body allowed via optionalJsonBody).
      const [startStatus, startRaw] = await api.call("POST", "/api/settings/accounts/login");
      const startLogin = asObj(asObj(startRaw).login);
      expect(startStatus).toBe(200);
      expect(startLogin.state).toBe("running");
      expect(startLogin.links).toEqual([
        "https://accounts.google.com/o/oauth2/auth?state=e2e-test",
      ]);

      // Polling GET /api/settings/accounts/login reflects the active login.
      const [pollStatus, pollRaw] = await api.get("/api/settings/accounts/login");
      const pollLogin = asObj(asObj(pollRaw).login);
      expect([pollStatus, pollLogin.id, pollLogin.state]).toEqual([200, startLogin.id, "running"]);

      // Validation errors on login/input.
      expect(
        await api.call("POST", "/api/settings/accounts/login/input", { extra: "nope" }),
      ).toEqual([400, { error: "Unknown field extra" }]);
      expect(
        await api.call("POST", "/api/settings/accounts/login/input", { text: 42 }),
      ).toEqual([400, { error: "text is required" }]);
      expect(
        await api.call("POST", "/api/settings/accounts/login/input", { text: "line1\nline2" }),
      ).toEqual([400, { error: "Paste one line" }]);

      // Valid input completes the login process cleanly.
      const [inputStatus, inputRaw] = await api.call("POST", "/api/settings/accounts/login/input", {
        text: "auth-code-99",
      });
      const doneLogin = asObj(asObj(inputRaw).login);
      expect(inputStatus).toBe(200);
      expect(doneLogin.state).toBe("done");
      expect(String(doneLogin.output)).toContain("Got code: auth-code-99");

      // Start another login with `{}` and cancel it via POST /api/settings/accounts/login/cancel.
      const [start2Status, start2Raw] = await api.call("POST", "/api/settings/accounts/login", {});
      expect(start2Status).toBe(200);
      expect(asObj(asObj(start2Raw).login).state).toBe("running");

      const [cancelStatus, cancelRaw] = await api.call(
        "POST",
        "/api/settings/accounts/login/cancel",
      );
      const cancelledLogin = asObj(asObj(cancelRaw).login);
      expect(cancelStatus).toBe(200);
      expect(cancelledLogin.state).toBe("failed");
      expect(String(cancelledLogin.output)).toContain("Cancelled");

      // Create an OAuth token file, verify accountsView sees it, then log out via HTTP.
      const tokenPath = agyTokenFile(homeDir);
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, JSON.stringify({ id_token_email: "user@example.com" }));

      const [signedInStatus, signedInRaw] = await api.get("/api/settings/accounts");
      expect(signedInStatus).toBe(200);
      expect(asObj(signedInRaw).account).toEqual({
        email: "user@example.com",
        removable: true,
      });

      const [logoutStatus, logoutRaw] = await api.call("POST", "/api/settings/accounts/logout");
      const loggedOut = asObj(logoutRaw);
      expect([logoutStatus, loggedOut.installed, loggedOut.account, loggedOut.problem]).toEqual([
        200,
        true,
        null,
        null,
      ]);
      expect(fs.existsSync(tokenPath)).toBe(false);
    } finally {
      if (server) {
        await server.shutdown();
      }
      await f.cleanup();
    }
  });

  test("wechat connect, verify (valid and invalid codes), and disconnect over HTTP", async () => {
    let seenVerifyCode: string | null = null;
    const mockWechat = await serveMockHttp((req) => {
      if (req.pathname === "/ilink/bot/get_bot_qrcode") {
        return MockResponse.json(200, {
          qrcode: "qr-test-1",
          qrcode_img_content: "https://weixin.qq.com/x/qr-test-1",
        });
      }
      if (req.pathname === "/ilink/bot/get_qrcode_status") {
        const params = new URLSearchParams(req.query);
        const code = params.get("verify_code");
        if (code !== null) {
          seenVerifyCode = code;
          return MockResponse.json(200, { status: "wait" });
        }
        return MockResponse.json(200, { status: "need_verifycode" });
      }
      return MockResponse.json(404, { error: "unexpected" });
    });

    const dir = new TempDir("http-wechat");
    const scripted = new Scripted();
    scripted.model = coreModel();
    scripted.wechat = Protocol.at(mockWechat.url, mockWechat.url, {
      paceMs: 25,
      statusWaitMs: 2_000,
    });
    const f = openIn(dir, scripted);

    let server: Server | undefined;
    try {
      await f.app.start();
      const opened = await open(f, {});
      server = opened.server;
      const { api } = opened;

      const [connectStatus, connectRaw] = await api.call("POST", "/api/wechat/connect");
      const connected = asObj(connectRaw);
      expect(connectStatus).toBe(200);
      expect(connected.qrContent).toBe("https://weixin.qq.com/x/qr-test-1");

      // Wait until the login loop polls get_qrcode_status and enters `verify` state.
      await f.until("wechat enters verify state", () => f.app.wechatStatus().state === "verify");

      // Non-digit verification codes are refused with 400.
      expect(await api.call("POST", "/api/wechat/verify", { code: "abcd" })).toEqual([
        400,
        { error: "验证码必须为数字" },
      ]);

      // Valid numeric verification code moves state to waiting and is forwarded to WeChat.
      const [verifyStatus, verifyRaw] = await api.call("POST", "/api/wechat/verify", {
        code: " 654321 ",
      });
      expect([verifyStatus, asObj(verifyRaw).state]).toEqual([200, "waiting"]);
      await f.until("wechat forwards verify_code", () => seenVerifyCode === "654321");

      // Disconnect stops the login loop and returns disconnected state.
      const [discStatus, discRaw] = await api.call("POST", "/api/wechat/disconnect");
      expect([discStatus, asObj(discRaw).state]).toEqual([200, "disconnected"]);
    } finally {
      if (server) {
        await server.shutdown();
      }
      await f.cleanup();
      await mockWechat.close();
    }
  });

  test("chat handles attachment-only messages, inline images, and binary files over HTTP", async () => {
    const f = await started();
    let server: Server | undefined;
    try {
      const opened = await open(f, {});
      server = opened.server;
      const { api } = opened;

      // 1x1 transparent PNG in standard base64
      const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const [status, receiptRaw] = await api.call("POST", "/api/chat", {
        text: "",
        messageId: "web:files1",
        attachments: [
          { name: "dot.png", mediaType: "image/png", data: pngBase64 },
          { name: "payload.bin", mediaType: "application/octet-stream", data: "AAECAw==" },
        ],
      });
      const receipt = asObj(receiptRaw);
      expect([status, receipt.requestId, receipt.result]).toEqual([
        202,
        "chat:web:files1",
        "stored",
      ]);

      await f.until("attachment message is in transcript", () => f.chat().length >= 3);
      await f.settle();

      const [, messagesRaw] = await api.get("/api/messages");
      const messages = asArray(asObj(messagesRaw).messages).map(asObj);
      expect(messages[0].role).toBe("user");
      expect(messages[0].images).toEqual([
        { name: "dot.png", mediaType: "image/png", data: pngBase64 },
      ]);
      expect(messages[0].files).toEqual([
        { name: "payload.bin", mediaType: "application/octet-stream", kind: "file" },
      ]);
    } finally {
      if (server) {
        await server.shutdown();
      }
      await f.cleanup();
    }
  });
});
