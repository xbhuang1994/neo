import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StopWorkerError } from "../../src/app/context.ts";
import type { AppContext, ChatAttachment, ChatReceipt, WeChatStatus } from "../../src/app/context.ts";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  PAGE_POLICY,
  Request,
  contentType,
  decodeStrictBase64,
  handle,
  hostName,
  isLoopback,
  parseAttachment,
  refused,
  sameSecret,
  serve,
  webFile,
} from "../../src/http/index.ts";
import type { Access, SocketAddr } from "../../src/http/index.ts";
import { MockHttpServer, MockResponse, TempDir } from "../../src/testkit/index.ts";
import { VERSION } from "../../src/version.ts";

const textDecoder = new TextDecoder("utf-8");
const textEncoder = new TextEncoder();

function makeRequest(
  headers: ReadonlyArray<readonly [string, string]>,
  init: { method?: string; path?: string; body?: Uint8Array | string } = {},
): Request {
  const headerMap = new Map<string, string>();
  for (const [name, value] of headers) {
    headerMap.set(name.toLowerCase(), value);
  }
  const body =
    init.body === undefined
      ? new Uint8Array(0)
      : typeof init.body === "string"
        ? textEncoder.encode(init.body)
        : init.body;
  return new Request({
    method: init.method ?? "GET",
    path: init.path ?? "/api/health",
    headers: headerMap,
    body,
  });
}

function parseJsonBody(body: Uint8Array): unknown {
  return JSON.parse(textDecoder.decode(body));
}

function responseHeader(headers: ReadonlyArray<[string, string]>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of headers) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  return undefined;
}

function mockApp(overrides: Partial<AppContext> = {}): AppContext {
  const defaults: Partial<AppContext> = {
    healthView: () => ({ ready: true, kernel: "antigravity" }),
    panelMessages: () => [],
    workerCards: async () => [],
    activityView: async () => ({ router: false, workers: [] }),
    workerDetail: async () => null,
    stopWorkerTicket: async () => {
      throw StopWorkerError.notFound();
    },
    modelsView: async () => ({ kernel: "antigravity", available: [], current: {} }),
    updateModels: async (value: unknown) => ({ current: value }),
    installKernel: async (value: unknown) => ({ kernel: "antigravity", installing: false, received: value }),
    accountsView: async () => ({ installed: true, problem: null, account: null, note: null, login: null }),
    loginView: () => null,
    startLogin: async () => ({ login: { id: 1, state: "running", links: [], output: "" } }),
    loginInput: async () => ({ login: { id: 1, state: "running", links: [], output: "" } }),
    cancelLogin: () => {},
    logout: async () => ({ installed: true, problem: null, account: null, note: null, login: null }),
    generalView: () => ({ executor: { maxWorkers: 3 }, paused: false }),
    updateGeneral: async (value: unknown) => value,
    resetOrchestrator: async () => {},
    wechatStatus: (): WeChatStatus => ({ state: "disconnected", message: "Not connected" }),
    wechatConnect: async (): Promise<WeChatStatus> => ({ state: "waiting", message: "Scan QR" }),
    wechatDisconnect: async (): Promise<WeChatStatus> => ({ state: "disconnected", message: "Disconnected" }),
    wechatVerify: (): WeChatStatus => {
      throw new Error("当前不需要微信验证码");
    },
    receiveWeb: async (
      _text: string,
      _attachments: ChatAttachment[],
      messageId?: string,
    ): Promise<ChatReceipt> => ({
      requestId: `chat:${messageId ?? "auto"}`,
      triggerId: "trig-1",
      result: "stored",
    }),
  };
  return { ...defaults, ...overrides } as AppContext;
}

// ============================================================================
// Ported inline unit tests from neo-http/src/api.rs and neo-http/src/lib.rs
// ============================================================================

describe("neo-http/src/api.rs inline tests", () => {
  test("lets_only_this_machine_call_without_a_token", () => {
    const open: Access = {};
    const local: SocketAddr = { host: "127.0.0.1", port: 50000 };
    const remote: SocketAddr = { host: "192.168.1.9", port: 50000 };
    const status = (headers: ReadonlyArray<readonly [string, string]>, peer: SocketAddr) =>
      refused(makeRequest(headers), peer, open)?.status ?? null;

    expect(status([["host", "127.0.0.1:3082"]], local)).toBeNull();
    expect(status([["host", "localhost:3082"]], local)).toBeNull();
    expect(status([["host", "[::1]:3082"]], { host: "::1", port: 50000 })).toBeNull();
    expect(
      status(
        [
          ["host", "127.0.0.1:3082"],
          ["origin", "http://127.0.0.1:3082"],
        ],
        local,
      ),
    ).toBeNull();

    // Another site's page, a name that only resolves here, and another machine.
    expect(
      status(
        [
          ["host", "127.0.0.1:3082"],
          ["origin", "https://evil.example"],
        ],
        local,
      ),
    ).toBe(403);
    expect(
      status(
        [
          ["host", "127.0.0.1:3082"],
          ["origin", "null"],
        ],
        local,
      ),
    ).toBe(403);
    expect(status([["host", "rebind.example:3082"]], local)).toBe(403);
    expect(status([], local)).toBe(403);
    expect(status([["host", "127.0.0.1:3082"]], remote)).toBe(403);
  });

  test("asks_everyone_for_the_token_once_one_is_set", () => {
    const access: Access = { token: "s3cret-token" };
    const remote: SocketAddr = { host: "192.168.1.9", port: 50000 };
    const status = (headers: ReadonlyArray<readonly [string, string]>) =>
      refused(makeRequest(headers), remote, access)?.status ?? null;

    expect(
      status([
        ["host", "neo.example"],
        ["authorization", "Bearer s3cret-token"],
      ]),
    ).toBeNull();
    expect(
      status([
        ["host", "neo.example"],
        ["authorization", "Bearer s3cret-token"],
        ["origin", "https://neo.example"],
      ]),
    ).toBeNull();
    expect(status([["host", "neo.example"]])).toBe(401);
    expect(
      status([
        ["host", "neo.example"],
        ["authorization", "Bearer s3cret-tokex"],
      ]),
    ).toBe(401);
    expect(
      status([
        ["host", "neo.example"],
        ["authorization", "Bearer s3cret-token-and-more"],
      ]),
    ).toBe(401);
    expect(
      status([
        ["host", "neo.example"],
        ["authorization", "Basic s3cret-token"],
      ]),
    ).toBe(401);
    expect(
      status([
        ["host", "neo.example"],
        ["authorization", "Bearer s3cret-token"],
        ["origin", "https://other.example"],
      ]),
    ).toBe(403);

    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("", "abc")).toBe(false);
    expect(sameSecret("abcd", "abc")).toBe(false);
    expect(sameSecret("abc\0", "abc")).toBe(false);
    expect(sameSecret("", "")).toBe(true);
  });

  test("reads_an_attachment_strictly", () => {
    const read = parseAttachment({ name: " ../a\\b\u0001.png ", mediaType: " Image/PNG ", data: "iVBORw==" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.name).toBe(".._a_b_.png");
      expect(read.value.mediaType).toBe("image/png");
      expect(Array.from(read.value.data)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }

    const blankName = parseAttachment({ name: "  ", data: "" });
    expect(blankName.ok).toBe(true);
    if (blankName.ok) {
      expect(blankName.value.name).toBe("attachment");
      expect(blankName.value.data.byteLength).toBe(0);
    }

    expect(parseAttachment("x")).toEqual({ ok: false, error: "Invalid attachment" });
    expect(parseAttachment({ data: "AA==" })).toEqual({ ok: false, error: "Attachment name must be a string" });
    expect(parseAttachment({ name: "a" })).toEqual({ ok: false, error: "Attachment data must be base64" });
    expect(parseAttachment({ name: "a", data: "not base64!" })).toEqual({
      ok: false,
      error: "Attachment data is invalid or exceeds 5 MiB",
    });

    const big = Buffer.alloc(MAX_FILE_BYTES + 1).toString("base64");
    expect(parseAttachment({ name: "a", data: big })).toEqual({
      ok: false,
      error: "Attachment data is invalid or exceeds 5 MiB",
    });

    const most = Buffer.alloc(MAX_FILE_BYTES).toString("base64");
    const maxRead = parseAttachment({ name: "a", data: most });
    expect(maxRead.ok).toBe(true);
    if (maxRead.ok) {
      expect(maxRead.value.data.byteLength).toBe(MAX_FILE_BYTES);
    }
  });

  test("knows_the_types_of_the_web_builds_files", () => {
    expect([
      contentType("index.html"),
      contentType("main.dart.js"),
      contentType("canvaskit.wasm"),
      contentType("a.PNG"),
      contentType("x.unknown"),
    ]).toEqual([
      "text/html; charset=utf-8",
      "text/javascript; charset=utf-8",
      "application/wasm",
      "image/png",
      "application/octet-stream",
    ]);

    expect([
      hostName("127.0.0.1:3082"),
      hostName("localhost"),
      hostName("[::1]:3082"),
      hostName("a.example:x"),
    ]).toEqual(["127.0.0.1", "localhost", "::1", "a.example:x"]);
  });

  test("tells_loopback_hosts_from_others", () => {
    for (const host of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]", "127.8.9.1"]) {
      expect(isLoopback(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.2", "example.com", ""]) {
      expect(isLoopback(host)).toBe(false);
    }
  });
});

// ============================================================================
// Additional strict unit coverage: base64, MIME map, routes, auth hint, static files, serve
// ============================================================================

describe("strict base64 and MIME map", () => {
  test("decodeStrictBase64 rejects malformed padding, whitespace, and non-zero trailing bits", () => {
    expect(decodeStrictBase64("")).toEqual(new Uint8Array(0));
    expect(decodeStrictBase64("AA==")).toEqual(new Uint8Array([0]));
    expect(decodeStrictBase64("AAA=")).toEqual(new Uint8Array([0, 0]));
    expect(decodeStrictBase64("AAAA")).toEqual(new Uint8Array([0, 0, 0]));

    // Non-canonical trailing bits must be refused (matches Rust base64::STANDARD).
    expect(decodeStrictBase64("AB==")).toBeNull();
    expect(decodeStrictBase64("AAB=")).toBeNull();
    // Invalid padding / characters / length.
    expect(decodeStrictBase64("====")).toBeNull();
    expect(decodeStrictBase64("A===")).toBeNull();
    expect(decodeStrictBase64("AA=A")).toBeNull();
    expect(decodeStrictBase64("AA")).toBeNull();
    expect(decodeStrictBase64("AA==\n")).toBeNull();
    expect(decodeStrictBase64(" AA==")).toBeNull();
    expect(decodeStrictBase64("@@")).toBeNull();
    expect(decodeStrictBase64("éAAA")).toBeNull();
  });

  test("covers all 19 web build MIME extensions", () => {
    const cases: Array<[string, string]> = [
      ["a.html", "text/html; charset=utf-8"],
      ["a.js", "text/javascript; charset=utf-8"],
      ["a.mjs", "text/javascript; charset=utf-8"],
      ["a.css", "text/css; charset=utf-8"],
      ["a.json", "application/json; charset=utf-8"],
      ["a.map", "application/json; charset=utf-8"],
      ["a.wasm", "application/wasm"],
      ["a.png", "image/png"],
      ["a.jpg", "image/jpeg"],
      ["a.jpeg", "image/jpeg"],
      ["a.gif", "image/gif"],
      ["a.svg", "image/svg+xml"],
      ["a.ico", "image/x-icon"],
      ["a.webp", "image/webp"],
      ["a.ttf", "font/ttf"],
      ["a.otf", "font/otf"],
      ["a.woff", "font/woff"],
      ["a.woff2", "font/woff2"],
      ["a.txt", "text/plain; charset=utf-8"],
      ["noext", "application/octet-stream"],
    ];
    for (const [name, expected] of cases) {
      expect(contentType(name)).toBe(expected);
    }
  });
});

describe("API routing, auth hints, static web serving, and serve()", () => {
  const local: SocketAddr = { host: "127.0.0.1", port: 50000 };

  test("returns 401 authRequired + version hint on GET /api/health without token", async () => {
    const app = mockApp();
    const access: Access = { token: "0123456789abcdef-token" };

    const healthDenied = await handle(app, access, makeRequest([["host", "127.0.0.1:3082"]]), local);
    expect(healthDenied.status).toBe(401);
    expect(responseHeader(healthDenied.headers, "www-authenticate")).toBe("Bearer");
    expect(parseJsonBody(healthDenied.body)).toEqual({
      error: "A valid access token is required",
      authRequired: true,
      version: VERSION,
    });

    const otherDenied = await handle(
      app,
      access,
      makeRequest([["host", "127.0.0.1:3082"]], { method: "GET", path: "/api/messages" }),
      local,
    );
    expect(otherDenied.status).toBe(401);
    expect(responseHeader(otherDenied.headers, "www-authenticate")).toBe("Bearer");
    expect(parseJsonBody(otherDenied.body)).toEqual({ error: "A valid access token is required" });

    // Origin failure still returns 403 even on GET /api/health.
    const originDenied = await handle(
      app,
      access,
      makeRequest([
        ["host", "127.0.0.1:3082"],
        ["origin", "https://evil.example"],
      ]),
      local,
    );
    expect(originDenied.status).toBe(403);
    expect(parseJsonBody(originDenied.body)).toEqual({ error: "Forbidden origin" });
  });

  test("routes all 23 API endpoints and validates chat/worker/wechat/settings payloads", async () => {
    let cancelCalled = 0;
    let resetCalled = 0;
    let lastChatArgs: { text: string; attachments: ChatAttachment[]; messageId?: string } | undefined;

    const app = mockApp({
      workerDetail: async (id) => (id === "w1" ? { ticketId: "w1", stage: { stage: "running" } } : null),
      stopWorkerTicket: async (id) => {
        if (id === "w-ok") return { ticketId: "w-ok", outcome: "stopped" };
        if (id === "w-ended") throw StopWorkerError.alreadyEnded();
        if (id === "w-fail") throw StopWorkerError.failed("signal refused");
        throw StopWorkerError.notFound();
      },
      cancelLogin: () => {
        cancelCalled += 1;
      },
      resetOrchestrator: async () => {
        resetCalled += 1;
      },
      wechatVerify: (code) => {
        if (code === "ok") return { state: "connected", message: "Connected" };
        throw new Error("当前不需要微信验证码");
      },
      receiveWeb: async (text, attachments, messageId) => {
        lastChatArgs = { text, attachments, messageId };
        if (messageId === "bad id") throw new Error("Invalid chat message ID");
        return { requestId: `chat:${messageId ?? "gen"}`, triggerId: "t1", result: "stored" };
      },
    });

    const call = async (method: string, reqPath: string, body?: unknown, contentTypeHdr?: string) => {
      const headers: Array<[string, string]> = [["host", "127.0.0.1:3082"]];
      let rawBody: Uint8Array = new Uint8Array(0);
      if (body !== undefined) {
        headers.push(["content-type", contentTypeHdr ?? "application/json; charset=utf-8"]);
        rawBody = typeof body === "string" ? textEncoder.encode(body) : textEncoder.encode(JSON.stringify(body));
      }
      const res = await handle(app, {}, makeRequest(headers, { method, path: reqPath, body: rawBody }), local);
      return { status: res.status, json: parseJsonBody(res.body) };
    };

    expect((await call("GET", "/api/health")).status).toBe(200);
    expect(await call("GET", "/api/messages")).toEqual({ status: 200, json: { messages: [] } });
    expect(await call("GET", "/api/workers")).toEqual({ status: 200, json: { workers: [] } });
    expect(await call("GET", "/api/activity")).toEqual({ status: 200, json: { router: false, workers: [] } });
    expect(await call("GET", "/api/workers/w1")).toEqual({
      status: 200,
      json: { ticketId: "w1", stage: { stage: "running" } },
    });
    expect(await call("GET", "/api/workers/missing")).toEqual({ status: 404, json: { error: "Worker not found" } });

    expect(await call("POST", "/api/workers/w-ok/stop")).toEqual({
      status: 200,
      json: { ticketId: "w-ok", outcome: "stopped" },
    });
    expect(await call("POST", "/api/workers/w-ended/stop")).toEqual({
      status: 400,
      json: { error: "Task has already ended" },
    });
    expect(await call("POST", "/api/workers/w-fail/stop")).toEqual({
      status: 400,
      json: { error: "signal refused" },
    });
    expect(await call("POST", "/api/workers/missing/stop")).toEqual({
      status: 404,
      json: { error: "Worker not found" },
    });
    expect(await call("POST", "/api/workers/a/b/stop")).toEqual({
      status: 404,
      json: { error: "Worker not found" },
    });
    expect(await call("POST", "/api/workers//stop")).toEqual({
      status: 404,
      json: { error: "Worker not found" },
    });
    expect(await call("POST", "/api/workers/stop")).toEqual({
      status: 404,
      json: { error: "Worker not found" },
    });

    expect((await call("GET", "/api/settings/models")).status).toBe(200);
    expect(await call("PUT", "/api/settings/models", { eval: null })).toEqual({
      status: 200,
      json: { current: { eval: null } },
    });
    expect((await call("POST", "/api/settings/kernel/install", { kernel: "antigravity" })).status).toBe(200);
    expect((await call("GET", "/api/settings/accounts")).status).toBe(200);
    expect(await call("GET", "/api/settings/accounts/login")).toEqual({ status: 200, json: { login: null } });
    // Empty body is valid for optionalJsonBody routes.
    expect((await call("POST", "/api/settings/accounts/login")).status).toBe(200);
    expect((await call("POST", "/api/settings/accounts/login/input", { text: "code" })).status).toBe(200);
    expect(await call("POST", "/api/settings/accounts/login/cancel")).toEqual({ status: 200, json: { login: null } });
    expect(cancelCalled).toBe(1);
    expect((await call("POST", "/api/settings/accounts/logout")).status).toBe(200);
    expect((await call("GET", "/api/settings/general")).status).toBe(200);
    expect(await call("PUT", "/api/settings/general", { paused: true })).toEqual({
      status: 200,
      json: { paused: true },
    });
    expect(await call("POST", "/api/session/reset")).toEqual({ status: 200, json: { reset: true } });
    expect(resetCalled).toBe(1);

    expect((await call("GET", "/api/wechat")).status).toBe(200);
    expect((await call("POST", "/api/wechat/connect")).status).toBe(200);
    expect((await call("POST", "/api/wechat/disconnect")).status).toBe(200);
    expect(await call("POST", "/api/wechat/verify", { code: 123 })).toEqual({
      status: 400,
      json: { error: "Expected { code: string }" },
    });
    expect(await call("POST", "/api/wechat/verify", { code: "bad" })).toEqual({
      status: 400,
      json: { error: "当前不需要微信验证码" },
    });
    expect(await call("POST", "/api/wechat/verify", { code: "ok" })).toEqual({
      status: 200,
      json: { state: "connected", message: "Connected" },
    });

    // POST /api/chat validation + success.
    expect(await call("POST", "/api/chat", { text: "x" }, "text/plain")).toEqual({
      status: 415,
      json: { error: "Expected application/json" },
    });
    const invalidJson = await call("POST", "/api/chat", '{"text":', "application/json");
    expect(invalidJson.status).toBe(400);
    expect((invalidJson.json as { error: string }).error).toContain("Invalid JSON:");

    expect(await call("POST", "/api/chat", { message: "x" })).toEqual({
      status: 400,
      json: { error: "Expected { text: string }" },
    });
    expect(await call("POST", "/api/chat", { text: "   " })).toEqual({
      status: 400,
      json: { error: `Message or attachment required; text limit ${MAX_TEXT_CHARS} characters` },
    });
    expect((await call("POST", "/api/chat", { text: "长".repeat(MAX_TEXT_CHARS + 1) })).status).toBe(400);
    // Astral characters count as 1 Unicode scalar value each, matching Rust `chars().count()`.
    expect((await call("POST", "/api/chat", { text: "😀".repeat(MAX_TEXT_CHARS), messageId: "web:emoji" })).status).toBe(
      202,
    );
    expect((await call("POST", "/api/chat", { text: "😀".repeat(MAX_TEXT_CHARS + 1) })).status).toBe(400);

    const file = { name: "a.bin", data: "AA==" };
    expect(await call("POST", "/api/chat", { text: "x", attachments: [file, file, file, file] })).toEqual({
      status: 400,
      json: { error: `At most ${MAX_FILES} attachments` },
    });
    expect(await call("POST", "/api/chat", { text: "x", attachments: "none" })).toEqual({
      status: 400,
      json: { error: "attachments must be a list" },
    });
    expect(await call("POST", "/api/chat", { text: "x", messageId: 7 })).toEqual({
      status: 400,
      json: { error: "messageId must be a string" },
    });
    expect(await call("POST", "/api/chat", { text: "x", messageId: "bad id" })).toEqual({
      status: 400,
      json: { error: "Invalid chat message ID" },
    });

    // Attachment-only chat message with empty text is accepted.
    const attachOnly = await call("POST", "/api/chat", {
      text: "   ",
      attachments: [{ name: "note.txt", mediaType: "text/plain", data: "SGk=" }],
      messageId: "web:a1",
    });
    expect(attachOnly).toEqual({
      status: 202,
      json: { requestId: "chat:web:a1", triggerId: "t1", result: "stored" },
    });
    expect(lastChatArgs?.text).toBe("");
    expect(lastChatArgs?.attachments).toHaveLength(1);
    expect(textDecoder.decode(lastChatArgs!.attachments[0].data)).toBe("Hi");

    // Unknown paths and wrong methods.
    expect(await call("GET", "/api/nothing")).toEqual({ status: 404, json: { error: "Not found" } });
    expect(await call("POST", "/api/messages")).toEqual({ status: 404, json: { error: "Not found" } });
    expect(await call("DELETE", "/api/health")).toEqual({ status: 404, json: { error: "Not found" } });
  });

  test("serves static web files with CSP/headers, SPA fallback, and traversal protection", async () => {
    using dir = new TempDir("http-web");
    const web = dir.join("web");
    fs.mkdirSync(path.join(web, "assets", "fonts"), { recursive: true });
    fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Neo</title>");
    fs.writeFileSync(path.join(web, "main.dart.js"), "console.log('app')");
    fs.writeFileSync(path.join(web, "assets", "fonts", "a.otf"), Uint8Array.from([0, 1, 2]));
    fs.writeFileSync(dir.join("secret.txt"), "outside the web build");

    const index = await webFile(web, "/");
    expect(index.status).toBe(200);
    expect(index.contentType).toBe("text/html; charset=utf-8");
    expect(textDecoder.decode(index.body)).toBe("<!doctype html><title>Neo</title>");
    expect(responseHeader(index.headers, "cache-control")).toBe("no-cache");
    expect(responseHeader(index.headers, "content-security-policy")).toBe(PAGE_POLICY);
    expect(responseHeader(index.headers, "x-content-type-options")).toBe("nosniff");
    expect(responseHeader(index.headers, "referrer-policy")).toBe("no-referrer");

    const js = await webFile(web, "/main.dart.js");
    expect(js.status).toBe(200);
    expect(js.contentType).toBe("text/javascript; charset=utf-8");
    expect(textDecoder.decode(js.body)).toBe("console.log('app')");

    const font = await webFile(web, "/assets/fonts/a.otf");
    expect(font.status).toBe(200);
    expect(font.contentType).toBe("font/otf");
    expect(Array.from(font.body)).toEqual([0, 1, 2]);

    // Extensionless route falls back to index.html; missing .ext asset returns 404.
    const spa = await webFile(web, "/settings/models");
    expect(spa.status).toBe(200);
    expect(textDecoder.decode(spa.body)).toBe("<!doctype html><title>Neo</title>");
    expect((await webFile(web, "/missing.js")).status).toBe(404);

    // Traversal and unsafe path segments are rejected.
    for (const bad of ["/../secret.txt", "/./index.html", "/a\\b", "/a\0b", "/c:d"]) {
      const res = await webFile(web, bad);
      expect(res.status).toBe(404);
      expect(textDecoder.decode(res.body)).not.toContain("outside");
    }

    // Method gating through handle().
    const app = mockApp();
    const access: Access = { token: "0123456789abcdef-token", webDir: web };
    expect((await handle(app, access, makeRequest([], { method: "HEAD", path: "/" }), local)).status).toBe(200);
    expect((await handle(app, access, makeRequest([], { method: "POST", path: "/" }), local)).status).toBe(404);
    expect((await handle(app, {}, makeRequest([], { method: "GET", path: "/" }), local)).status).toBe(404);
  });

  test("serve enforces token length and non-loopback requirement, and serves requests over loopback", async () => {
    const app = mockApp();
    await expect(serve(app, "0.0.0.0", 0, {})).rejects.toThrow(
      "Listening on 0.0.0.0 needs an access token: set one, or listen on 127.0.0.1",
    );
    await expect(serve(app, "127.0.0.1", 0, { token: "short" })).rejects.toThrow(
      "The access token must have at least 16 characters",
    );

    const server = await serve(app, "127.0.0.1", 0, {});
    try {
      const res = await fetch(`${server.url()}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ready: true, kernel: "antigravity" });
    } finally {
      await server.shutdown();
    }
  });
});

// ============================================================================
// fixture-agy.ts verification
// ============================================================================

async function runChild(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        status: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

describe("fixture-agy stand-in CLI", () => {
  const fixtureEntry = path.resolve(import.meta.dir, "../../src/testkit/fixture-agy.ts");

  test("reports --version and models verbatim", async () => {
    const ver = await runChild(process.execPath, [fixtureEntry, "--version"]);
    expect(ver.status).toBe(0);
    expect(ver.stdout).toBe("agy 1.0.0-fixture\n");

    const models = await runChild(process.execPath, [fixtureEntry, "models"]);
    expect(models.status).toBe(0);
    expect(models.stdout).toBe(
      "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.8-pro-high\tGemini 3.8 Pro (High)\n",
    );
  });

  test("drives orchestrator and worker MCP tools over the bridge folder", async () => {
    const mcpCalls: Array<{ auth?: string; body: Record<string, unknown> }> = [];
    const mockMcp = await MockHttpServer.start((req) => {
      const body = req.json<Record<string, unknown>>();
      mcpCalls.push({ auth: req.header("authorization"), body });
      return MockResponse.json(200, { jsonrpc: "2.0", id: body.id, result: { ok: true } });
    });

    try {
      using dir = new TempDir("fixture-agy");
      const bridge = dir.join("bridge");
      const agentsDir = path.join(bridge, ".agents", "agents");
      const pluginDir = path.join(bridge, ".agents", "plugins", "neo");
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "mcp_config.json"),
        JSON.stringify({
          mcpServers: {
            neo: {
              url: `${mockMcp.url}/mcp`,
              headers: { Authorization: "Bearer test-secret" },
            },
          },
        }),
      );

      // 1. Orchestrator flow (Chinese web-e2e scenario).
      fs.writeFileSync(path.join(agentsDir, "neo-session.md"), "You are the orchestrator.\n");
      const candidateTurn = JSON.stringify({
        event: "user",
        message: {
          content: JSON.stringify({
            kind: "candidate",
            trigger_id: "trig-zh-1",
            text: "请把结果写进文件。",
          }),
        },
      });
      const reportTurn = JSON.stringify({
        event: "user",
        message: {
          content: JSON.stringify({
            kind: "worker_report",
            state: "ready",
            ticket: { ticket_id: "tk-1" },
          }),
        },
      });
      const orchProc = await runChild(
        process.execPath,
        [fixtureEntry, "--add-dir", bridge, "--conversation", "conv-orch", "-p="],
        { input: `${candidateTurn}\n${reportTurn}\n` },
      );
      expect(orchProc.status).toBe(0);
      expect(orchProc.stderr).toBe("");
      const orchEvents = orchProc.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(orchEvents[0]).toEqual({ event: "init", conversation_id: "conv-orch" });
      expect(orchEvents[orchEvents.length - 1]).toEqual({ event: "result", result: { status: "SUCCESS" } });
      expect(mcpCalls).toHaveLength(2);
      expect(mcpCalls[0].auth).toBe("Bearer test-secret");
      expect(mcpCalls[0].body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "orchestrator_route",
          arguments: {
            decisions: [
              {
                kind: "accept",
                trigger_id: "trig-zh-1",
                title: "Write the result file",
                worktree_name: "write-result",
                acknowledgement: "收到：正在把结果写进文件。",
              },
            ],
          },
        },
      });
      expect(mcpCalls[1].body).toEqual({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "orchestrator_reply",
          arguments: {
            ticket_id: "tk-1",
            purpose: "result",
            text: "结果已写入文件。",
          },
        },
      });

      // 2. Worker flow: writes result.txt and calls orchestrator_report.
      const workDir = dir.join("worktree");
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, "neo-session.md"), "You are a worker.\n");
      const workerTurn = JSON.stringify({
        event: "user",
        message: { content: "Write result.txt" },
      });
      const workerProc = await runChild(process.execPath, [fixtureEntry, "--add-dir", bridge, "-p="], {
        cwd: workDir,
        input: `${workerTurn}\n`,
      });
      expect(workerProc.status).toBe(0);
      expect(workerProc.stderr).toBe("");
      expect(fs.readFileSync(path.join(workDir, "result.txt"), "utf8")).toBe("done by the worker\n");
      expect(mcpCalls).toHaveLength(3);
      expect(mcpCalls[2].body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "orchestrator_report",
          arguments: {
            state: "ready",
            summary: "Wrote result.txt.",
            topic: "Write result.txt",
          },
        },
      });

      // 3. Interactive open-stdin multi-turn stream (English flow): init flushes before stdin, each turn flushes without EOF.
      fs.writeFileSync(path.join(agentsDir, "neo-session.md"), "You are the orchestrator.\n");
      const live = spawn(process.execPath, [fixtureEntry, "--add-dir", bridge, "--conversation", "conv-en", "-p="], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines: string[] = [];
      let pendingBuf = "";
      let lineWaiter: (() => void) | null = null;
      live.stdout.on("data", (chunk: Buffer) => {
        pendingBuf += chunk.toString("utf8");
        let nl = pendingBuf.indexOf("\n");
        while (nl !== -1) {
          lines.push(pendingBuf.slice(0, nl));
          pendingBuf = pendingBuf.slice(nl + 1);
          nl = pendingBuf.indexOf("\n");
        }
        if (lineWaiter) {
          const wake = lineWaiter;
          lineWaiter = null;
          wake();
        }
      });
      const waitLines = async (count: number): Promise<void> => {
        const deadline = Date.now() + 5_000;
        while (lines.length < count) {
          const left = deadline - Date.now();
          if (left <= 0) throw new Error(`Timed out waiting for ${count} stdout lines (got ${lines.length})`);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, left);
            lineWaiter = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
      };

      await waitLines(1);
      expect(JSON.parse(lines[0])).toEqual({ event: "init", conversation_id: "conv-en" });

      live.stdin.write(
        `${JSON.stringify({
          event: "user",
          message: {
            content: JSON.stringify({
              kind: "candidate",
              trigger_id: "trig-en-1",
              text: "Write the result file.",
            }),
          },
        })}\n`,
      );
      await waitLines(4);
      expect(JSON.parse(lines[3])).toEqual({ event: "result", result: { status: "SUCCESS" } });
      expect(mcpCalls[3].body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "orchestrator_route",
          arguments: {
            decisions: [
              {
                kind: "accept",
                trigger_id: "trig-en-1",
                title: "Write the result file",
                worktree_name: "write-result",
                acknowledgement: "On it.",
              },
            ],
          },
        },
      });

      live.stdin.write(
        `${JSON.stringify({
          event: "user",
          message: {
            content: JSON.stringify({
              kind: "worker_report",
              state: "ready",
              ticket: { ticket_id: "tk-en-1" },
            }),
          },
        })}\n`,
      );
      await waitLines(7);
      expect(JSON.parse(lines[6])).toEqual({ event: "result", result: { status: "SUCCESS" } });
      expect(mcpCalls[4].body).toEqual({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "orchestrator_reply",
          arguments: {
            ticket_id: "tk-en-1",
            purpose: "result",
            text: "The file is written.",
          },
        },
      });

      const exitCode = await new Promise<number | null>((resolve) => {
        live.once("close", resolve);
        live.stdin.end();
      });
      expect(exitCode).toBe(0);
    } finally {
      await mockMcp.close();
    }
  });
});
