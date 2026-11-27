/**
 * Neo Entry-Point HTTP Server (`src/entrypoint.ts`).
 *
 * - In `proxy` mode (default): always owns Neo's entry-point port (`--host:--port`).
 *   * When Neo is `healthy`: transparently proxies all Neo traffic (`/`, `/api/*`, web assets)
 *     to Neo's internal loopback port, normalizing `Transfer-Encoding: chunked` to exact
 *     `Content-Length` so Neo's strict HTTP/1.1 server accepts every request cleanly.
 *   * Always serves `/_recovery`, `/_recovery/status`, `/_recovery/events` (SSE), and
 *     `/_recovery/action` so operators can inspect status and history even while healthy.
 *   * When Neo is NOT `healthy` (`starting`, `degraded`, `recovering`, `restarting`, `cooldown`):
 *     serves the live Recovery Console directly at `/` (Neo's entry point) and returns clean
 *     JSON `503` recovery status on `/api/*` so already-open web/desktop tabs explain what's happening.
 * - In `takeover` mode: started only while Neo is in recovery/cooldown, serving the exact same
 *   Recovery Console directly on Neo's entry-point port, and cleanly closed before restarting Neo.
 */

import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { isLoopbackHost, type EntryMode } from "./config.ts";
import { renderRecoveryConsoleHtml } from "./console-html.ts";
import type { RecoveryStateStore, StreamFrame } from "./state.ts";

const MAX_PROXY_BODY_BYTES = 24 * 1024 * 1024;

const CONSOLE_CSP =
  "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "upgrade",
]);

export interface EntryPointHooks {
  onAction: (action: "recover" | "restart" | "cancel") => void;
  onProxyError: (reason: string) => void;
}

export interface EntryPointOptions {
  host: string;
  port: number;
  mode: EntryMode;
  token?: string;
  store: RecoveryStateStore;
  hooks: EntryPointHooks;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  const len = Math.max(a.byteLength, b.byteLength);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  a.copy(pa);
  b.copy(pb);
  return (len === 0 || timingSafeEqual(pa, pb)) && a.byteLength === b.byteLength;
}

function normalizeIp(raw: string | undefined): string {
  if (!raw) return "";
  if (raw.startsWith("::ffff:") || raw.startsWith("::FFFF:")) {
    return raw.slice(7);
  }
  return raw;
}

function hostWithoutPort(hostHeader: string): string {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close === -1 ? trimmed : trimmed.slice(1, close);
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
}

function checkAccess(
  req: http.IncomingMessage,
  token: string | undefined,
): { ok: true } | { ok: false; status: 401 | 403; error: string } {
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (origin !== undefined) {
    const sep = origin.indexOf("://");
    let same = false;
    if (sep !== -1) {
      const scheme = origin.slice(0, sep).toLowerCase();
      const rest = origin.slice(sep + 3);
      same = (scheme === "http" || scheme === "https") && rest.toLowerCase() === host.toLowerCase();
    }
    if (!same) {
      return { ok: false, status: 403, error: "Forbidden origin" };
    }
  }

  if (token !== undefined) {
    const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const given = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    if (!sameSecret(given, token)) {
      return { ok: false, status: 401, error: "A valid access token is required" };
    }
    return { ok: true };
  }

  const peerIp = normalizeIp(req.socket.remoteAddress);
  if (!isLoopbackHost(peerIp) || !isLoopbackHost(hostWithoutPort(host))) {
    return { ok: false, status: 403, error: "Only this computer may call the API without an access token" };
  }
  return { ok: true };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  if (res.writableEnded) return;
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.byteLength,
    "Cache-Control": "no-store",
    ...(extraHeaders ?? {}),
  };
  res.writeHead(status, headers);
  res.end(buf);
}

function sendHtml(res: http.ServerResponse, html: string, headOnly: boolean): void {
  if (res.writableEnded) return;
  const buf = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": buf.byteLength,
    "Cache-Control": "no-cache, no-store",
    "Content-Security-Policy": CONSOLE_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(headOnly ? undefined : buf);
}

function readBoundedBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      total += chunk.byteLength;
      if (total > maxBytes) {
        failed = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => {
      if (!failed) resolve(Buffer.concat(chunks, total));
    });
    req.once("error", () => {
      if (!failed) {
        failed = true;
        resolve(null);
      }
    });
  });
}

function writeSseFrame(res: http.ServerResponse, frame: StreamFrame): void {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`);
  } catch {
    // client disconnected
  }
}

export class EntryPointServer {
  private readonly options: EntryPointOptions;
  private readonly consoleHtml: string;
  private readonly upstreamAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 64,
    keepAliveMsecs: 30_000,
  });
  private server: http.Server | null = null;
  private boundPort: number;
  private readonly sseClients = new Set<{ res: http.ServerResponse; close: () => void }>();

  constructor(options: EntryPointOptions) {
    this.options = options;
    this.boundPort = options.port;
    this.consoleHtml = renderRecoveryConsoleHtml(Boolean(options.token));
  }

  get isListening(): boolean {
    return this.server !== null;
  }

  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort;

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.keepAliveTimeout = 60_000;
    server.headersTimeout = 35_000;

    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => {
        server.off("listening", onListen);
        reject(err);
      };
      const onListen = () => {
        server.off("error", onErr);
        resolve();
      };
      server.once("error", onErr);
      server.once("listening", onListen);
      server.listen(this.options.port, this.options.host);
    });

    const addr = server.address() as AddressInfo | null;
    this.boundPort = addr?.port ?? this.options.port;
    this.server = server;
    return this.boundPort;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const client of this.sseClients) {
      client.close();
    }
    this.sseClients.clear();
    this.upstreamAgent.destroy();
    if (!server) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref?.();
      try {
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeAllConnections?.();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "/";
    const qIdx = rawUrl.indexOf("?");
    const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);

    // 1. Recovery console & recovery APIs are always handled directly by this independent daemon
    if (pathname === "/_recovery" || pathname === "/_recovery/") {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      sendHtml(res, this.consoleHtml, method === "HEAD");
      return;
    }

    if (pathname === "/_recovery/status") {
      if (method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      const auth = checkAccess(req, this.options.token);
      if (!auth.ok) {
        sendJson(
          res,
          auth.status,
          { error: auth.error, authRequired: auth.status === 401 },
          auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined,
        );
        return;
      }
      sendJson(res, 200, this.options.store.snapshot());
      return;
    }

    if (pathname === "/_recovery/events") {
      if (method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      const auth = checkAccess(req, this.options.token);
      if (!auth.ok) {
        sendJson(
          res,
          auth.status,
          { error: auth.error, authRequired: auth.status === 401 },
          auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined,
        );
        return;
      }
      this.handleSse(req, res);
      return;
    }

    if (pathname === "/_recovery/action") {
      if (method !== "POST") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      const auth = checkAccess(req, this.options.token);
      if (!auth.ok) {
        sendJson(
          res,
          auth.status,
          { error: auth.error, authRequired: auth.status === 401 },
          auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined,
        );
        return;
      }
      const raw = await readBoundedBody(req, 16 * 1024);
      if (!raw) {
        sendJson(res, 400, { error: "Invalid request body" });
        return;
      }
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        const action = parsed?.action;
        if (action !== "recover" && action !== "restart" && action !== "cancel") {
          sendJson(res, 400, { error: 'Expected { "action": "recover" | "restart" | "cancel" }' });
          return;
        }
        this.options.hooks.onAction(action);
        sendJson(res, 202, { accepted: true, action });
      } catch {
        sendJson(res, 400, { error: "Malformed JSON" });
      }
      return;
    }

    // 2. When in proxy mode and Neo is healthy, transparently proxy to Neo's internal loopback port
    const phase = this.options.store.getPhase();
    const targetPort = this.options.store.getTargetPort();
    if (this.options.mode === "proxy" && phase === "healthy" && targetPort > 0) {
      await this.proxyToNeo(req, res, targetPort, pathname);
      return;
    }

    // 3. Otherwise (outage / recovering / restarting / cooldown / takeover mode), serve Recovery Console at Neo's entry point!
    this.serveDegradedOrRecovery(req, res, method, pathname);
  }

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    writeSseFrame(res, { type: "snapshot", data: this.options.store.snapshot() });

    const unsubscribe = this.options.store.subscribe((frame) => {
      writeSseFrame(res, frame);
    });
    const ping = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) {
        try {
          res.write(": ping\n\n");
        } catch {
          cleanup();
        }
      }
    }, 15_000);
    ping.unref?.();

    const entry = {
      res,
      close: () => {
        cleanup();
        try {
          res.end();
        } catch {
          // ignore
        }
      },
    };
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(ping);
      unsubscribe();
      this.sseClients.delete(entry);
    };

    this.sseClients.add(entry);
    req.once("close", cleanup);
    res.once("close", cleanup);
    res.once("error", cleanup);
  }

  private serveDegradedOrRecovery(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    pathname: string,
  ): void {
    const snap = this.options.store.snapshot();
    const isApi = pathname === "/api" || pathname.startsWith("/api/");

    if (isApi) {
      const auth = checkAccess(req, this.options.token);
      if (!auth.ok) {
        sendJson(
          res,
          auth.status,
          {
            error: auth.error,
            authRequired: auth.status === 401,
            recovering: snap.phase === "recovering" || snap.phase === "restarting",
            phase: snap.phase,
            recoveryUrl: "/_recovery",
          },
          auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined,
        );
        return;
      }
      const message =
        snap.phase === "recovering"
          ? "Neo 正在恢复模式自动修复中，请刷新页面查看实时修复过程细节"
          : snap.phase === "restarting"
            ? "Neo 修复完成，正在重启并验证服务健康…"
            : snap.phase === "starting"
              ? "Neo 正在启动中，请稍候…"
              : "Neo 服务当前不可用，守护进程正在处理恢复，请刷新页面查看详情";
      sendJson(res, 503, {
        ready: false,
        recovering: snap.phase === "recovering" || snap.phase === "restarting",
        phase: snap.phase,
        error: message,
        recoveryUrl: "/_recovery",
        attempt: snap.activeAttempt?.id ?? null,
        lastProbe: snap.lastProbe,
      });
      return;
    }

    if (method === "GET" || method === "HEAD") {
      sendHtml(res, this.consoleHtml, method === "HEAD");
      return;
    }
    sendJson(res, 503, { error: "Neo service is currently recovering", phase: snap.phase });
  }

  private async proxyToNeo(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    targetPort: number,
    pathname: string,
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const headers: Record<string, string | string[]> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (val === undefined) continue;
      const lower = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      headers[lower] = val;
    }

    // Neo's strict HTTP/1.1 server rejects `Transfer-Encoding: chunked` with 411;
    // normalize chunked bodies to an exact `Content-Length`.
    let bufferedBody: Buffer | undefined;
    if ("transfer-encoding" in headers) {
      delete headers["transfer-encoding"];
      const body = await readBoundedBody(req, MAX_PROXY_BODY_BYTES);
      if (body === null) {
        sendJson(res, 413, { error: "Request body too large" });
        return;
      }
      bufferedBody = body;
      headers["content-length"] = String(body.byteLength);
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      const upstreamReq = http.request(
        {
          host: "127.0.0.1",
          port: targetPort,
          agent: this.upstreamAgent,
          method,
          path: req.url ?? "/",
          headers,
        },
        (upstreamRes) => {
          if (res.headersSent) {
            upstreamRes.resume();
            finish();
            return;
          }
          const outHeaders: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(upstreamRes.headers)) {
            if (v !== undefined && !HOP_BY_HOP_HEADERS.has(k.toLowerCase())) {
              outHeaders[k] = v;
            }
          }
          res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
          upstreamRes.pipe(res);
          upstreamRes.once("end", finish);
          upstreamRes.once("error", () => {
            if (!res.writableEnded) res.destroy();
            finish();
          });
        },
      );

      upstreamReq.setTimeout(120_000, () => {
        upstreamReq.destroy(new Error("Upstream Neo request timed out"));
      });

      upstreamReq.on("error", (err) => {
        this.options.hooks.onProxyError(`Proxy upstream error: ${err.message}`);
        if (!res.headersSent) {
          this.serveDegradedOrRecovery(req, res, method, pathname);
        } else if (!res.writableEnded) {
          res.destroy();
        }
        finish();
      });

      req.once("aborted", () => {
        upstreamReq.destroy();
        finish();
      });

      if (bufferedBody !== undefined) {
        upstreamReq.end(bufferedBody);
      } else if (method === "GET" || method === "HEAD") {
        upstreamReq.end();
      } else {
        req.pipe(upstreamReq);
      }
    });
  }
}
