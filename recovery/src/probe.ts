/**
 * Lightweight HTTP /api/health sniffer using Node's built-in `node:http`.
 * Zero third-party dependencies, strict timeout, no hanging sockets.
 */

import * as http from "node:http";

export interface ProbeOptions {
  host: string;
  port: number;
  token?: string;
  timeoutMs: number;
  requireReady: boolean;
}

export interface ProbeResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  at: string;
  ready?: boolean;
  version?: string;
  kernel?: string;
  paused?: boolean;
  activeWorkers?: number;
  components?: Record<string, { state: string; detail: string; at: string }>;
  reason: string;
}

function probeHostFor(host: string): string {
  const trimmed = host.trim();
  if (trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]" || trimmed === "") {
    return "127.0.0.1";
  }
  return trimmed.replace(/^\[|\]$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function probeHealth(options: ProbeOptions): Promise<ProbeResult> {
  const start = Date.now();
  const targetHost = probeHostFor(options.host);
  const hostHeader = targetHost.includes(":")
    ? `[${targetHost}]:${options.port}`
    : `${targetHost}:${options.port}`;

  const headers: Record<string, string> = {
    Host: hostHeader,
    Accept: "application/json",
    Connection: "close",
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve(result);
    };

    const req = http.request(
      {
        host: targetHost,
        port: options.port,
        path: "/api/health",
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const MAX_BYTES = 256 * 1024;
        res.on("data", (chunk: Buffer) => {
          if (total < MAX_BYTES) {
            chunks.push(chunk);
            total += chunk.byteLength;
          }
        });
        res.on("end", () => {
          const latencyMs = Date.now() - start;
          const at = new Date().toISOString();
          const status = res.statusCode ?? 0;
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          try {
            body = raw.length > 0 ? JSON.parse(raw) : null;
          } catch {
            body = null;
          }

          if (status === 200 && isRecord(body) && (typeof body.ready === "boolean" || typeof body.version === "string")) {
            const ready = typeof body.ready === "boolean" ? body.ready : true;
            const version = typeof body.version === "string" ? body.version : undefined;
            const kernel = typeof body.kernel === "string" ? body.kernel : undefined;
            const paused = typeof body.paused === "boolean" ? body.paused : undefined;
            const activeWorkers = typeof body.activeWorkers === "number" ? body.activeWorkers : undefined;
            const components = isRecord(body.components)
              ? (body.components as ProbeResult["components"])
              : undefined;

            if (options.requireReady && !ready) {
              finish({
                ok: false,
                statusCode: status,
                latencyMs,
                at,
                ready,
                version,
                kernel,
                paused,
                activeWorkers,
                components,
                reason: "Neo /api/health responded ready=false (--require-ready enabled)",
              });
              return;
            }
            finish({
              ok: true,
              statusCode: status,
              latencyMs,
              at,
              ready,
              version,
              kernel,
              paused,
              activeWorkers,
              components,
              reason: ready ? "healthy" : "reachable (runtime not ready)",
            });
            return;
          }

          if (status === 401 && isRecord(body) && body.authRequired === true) {
            if (!options.token) {
              finish({
                ok: true,
                statusCode: status,
                latencyMs,
                at,
                version: typeof body.version === "string" ? body.version : undefined,
                reason: "reachable (auth required; no token given to daemon)",
              });
              return;
            }
            finish({
              ok: false,
              statusCode: status,
              latencyMs,
              at,
              reason: "HTTP 401: Neo rejected the configured access token",
            });
            return;
          }

          const errText = isRecord(body) && typeof body.error === "string" ? `: ${body.error}` : "";
          finish({
            ok: false,
            statusCode: status,
            latencyMs,
            at,
            reason: `HTTP ${status}${errText || " (unexpected /api/health response)"}`,
          });
        });
        res.on("error", (err) => {
          finish({
            ok: false,
            statusCode: res.statusCode ?? null,
            latencyMs: Date.now() - start,
            at: new Date().toISOString(),
            reason: `Response stream error: ${err.message}`,
          });
        });
      },
    );

    const hardTimer = setTimeout(() => {
      try {
        req.destroy(new Error(`Health probe timed out after ${options.timeoutMs}ms`));
      } catch {
        // ignore
      }
      finish({
        ok: false,
        statusCode: null,
        latencyMs: Date.now() - start,
        at: new Date().toISOString(),
        reason: `Health probe timed out after ${options.timeoutMs}ms`,
      });
    }, options.timeoutMs);
    hardTimer.unref?.();

    req.on("error", (err) => {
      finish({
        ok: false,
        statusCode: null,
        latencyMs: Date.now() - start,
        at: new Date().toISOString(),
        reason: `Unreachable: ${err.message}`,
      });
    });

    req.end();
  });
}
