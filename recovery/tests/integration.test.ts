import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { parseCli, type DaemonConfig } from "../src/config.ts";
import { RecoverySupervisor } from "../src/supervisor.ts";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSettingsDb(dataDir: string, model: string, recoveryMode?: boolean, revision = 5): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { create: true });
  db.run("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.query("INSERT INTO kv VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    "settings-revision",
    String(revision),
  );
  const settings: Record<string, unknown> = {
    kernel: "antigravity",
    models: {
      antigravity: {
        eval: { provider: "antigravity", model: "gemini-eval-fast" },
        executor: { provider: "antigravity", model },
      },
    },
    executor: { blockedCommands: [] },
  };
  if (recoveryMode !== undefined) {
    settings.recoveryMode = recoveryMode;
  }
  db.query("INSERT INTO kv VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    `settings-version:${revision}`,
    JSON.stringify({ revision, settings }),
  );
  db.close();
}

function writeMockNeoScript(filePath: string, bugFile: string, leakedSecret = ""): void {
  const code = `
import * as fs from "node:fs";
import * as http from "node:http";

let host = "127.0.0.1";
let port = 3082;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--host" && process.argv[i + 1]) host = process.argv[++i];
  else if (process.argv[i] === "--port" && process.argv[i + 1]) port = Number(process.argv[++i]);
}

if (fs.existsSync(${JSON.stringify(bugFile)})) {
  console.error("FATAL: simulated Neo startup crash${leakedSecret ? ` token=${leakedSecret}` : ""}");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.headers["transfer-encoding"]) {
    res.writeHead(411, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Send the body with a Content-Length" }));
    return;
  }
  const url = req.url || "/";
  if (url === "/api/health") {
    const token = process.env.NEO_TOKEN;
    if (token && req.headers.authorization !== "Bearer " + token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "A valid access token is required", authRequired: true, version: "0.6.0-mock" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ready: true, version: "0.6.0-mock", kernel: "antigravity", paused: false, activeWorkers: 0, components: {} }));
    return;
  }
  if (url === "/api/echo" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ echoed: body, contentLength: req.headers["content-length"] }));
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<html><body><h1>NEO_LIVE_APP_OK</h1></body></html>");
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ port, pid: process.pid, version: "0.6.0-mock" }));
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
`;
  fs.writeFileSync(filePath, code, "utf8");
}

function writeMockWorkerScript(filePath: string, bugFile: string, fixOnAttempt = 1, markerFile?: string): void {
  const code = `
import * as fs from "node:fs";

const attempt = Number(process.env.NEO_RECOVERY_ATTEMPT || "1");
const model = process.env.NEO_RECOVERY_MODEL || "";
const diagFile = process.env.NEO_RECOVERY_DIAGNOSTICS_FILE || "";
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (${JSON.stringify(markerFile ?? "")}) {
  fs.writeFileSync(${JSON.stringify(markerFile ?? "")}, JSON.stringify({ attempt, model, diagFile }), "utf8");
}

emit({ event: "init", conversation_id: "conv-recovery-" + attempt });
await sleep(80);
emit({
  event: "step_update",
  step_update: { step_index: 1, step_type: "agent_response", state: "RUNNING", text_delta: "正在分析 Neo 故障日志…" },
});
await sleep(80);
emit({
  event: "step_update",
  step_update: { step_index: 1, step_type: "agent_response", state: "DONE", text_delta: " 发现模拟崩溃标记文件。" },
});
emit({
  event: "step_update",
  step_update: {
    step_index: 2,
    step_type: "tool",
    state: "RUNNING",
    tool_name: "run_command",
    tool_info: { parameters: { CommandLine: "inspect & repair bug marker" } },
  },
});
await sleep(120);

if (attempt >= ${fixOnAttempt}) {
  try { fs.unlinkSync(${JSON.stringify(bugFile)}); } catch {}
  emit({
    event: "step_update",
    step_update: {
      step_index: 2,
      step_type: "tool",
      state: "DONE",
      tool_name: "run_command",
      tool_info: { output: "Removed simulated fault marker and verified build." },
    },
  });
  emit({ event: "result", result: { status: "SUCCESS" } });
  process.exit(0);
} else {
  emit({
    event: "step_update",
    step_update: {
      step_index: 2,
      step_type: "tool",
      state: "ERROR",
      tool_name: "run_command",
      tool_info: { error: { message: "First attempt could not resolve fault yet" } },
    },
  });
  emit({ event: "result", result: { status: "ERROR", error: "Simulated failed repair attempt" } });
  process.exit(1);
}
`;
  fs.writeFileSync(filePath, code, "utf8");
}

async function waitFor<T>(fn: () => Promise<T | false> | T | false, timeoutMs = 15_000, stepMs = 80): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function makeConfig(args: string[]): DaemonConfig {
  const parsed = parseCli(args);
  if (!parsed.ok || parsed.value.kind !== "start") {
    throw new Error(`parseCli failed: ${parsed.ok ? parsed.value.kind : parsed.error}`);
  }
  return parsed.value.config;
}

describe("end-to-end recovery daemon integration", () => {
  test("proxy mode detects prolonged outage, streams live recovery details at Neo entry point, repairs using SQLite worker model, and proxies healthy Neo including chunked POST", async () => {
    const tmp = makeTempDir("neo-rec-e2e-proxy-");
    const dataDir = path.join(tmp, "neo-data");
    const stateDir = path.join(tmp, "rec-state");
    const bugFile = path.join(tmp, "BUG_ACTIVE");
    const neoScript = path.join(tmp, "mock-neo.ts");
    const workerScript = path.join(tmp, "mock-worker.ts");
    const markerFile = path.join(tmp, "worker-seen.json");
    const token = "test-neo-secret-token-123456";

    writeSettingsDb(dataDir, "gemini-e2e-worker-model");
    fs.writeFileSync(bugFile, "broken", "utf8");
    writeMockNeoScript(neoScript, bugFile, token);
    writeMockWorkerScript(workerScript, bugFile, 1, markerFile);

    const config = makeConfig([
      "start",
      "--mode",
      "proxy",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--internal-port",
      "0",
      "--token",
      token,
      "--data-dir",
      dataDir,
      "--repo-dir",
      tmp,
      "--state-dir",
      stateDir,
      "--target-bin",
      process.execPath,
      "--target-arg",
      "run",
      "--target-arg",
      neoScript,
      "--target-arg",
      "--host",
      "--target-arg",
      "{host}",
      "--target-arg",
      "--port",
      "--target-arg",
      "{port}",
      "--worker-cmd",
      process.execPath,
      "--worker-arg",
      "run",
      "--worker-arg",
      workerScript,
      "--probe-interval",
      "0.12",
      "--probe-timeout",
      "1",
      "--unhealthy-after",
      "0.45",
      "--min-failed-probes",
      "3",
      "--fast-restart-delay",
      "0.3",
      "--startup-timeout",
      "6",
      "--stable-probes",
      "2",
    ]);

    const supervisor = new RecoverySupervisor(config);
    const started = await supervisor.start();
    expect(started.ok).toBe(true);
    const entryPort = (started as { ok: true; entryPort: number }).entryPort;
    const baseUrl = `http://127.0.0.1:${entryPort}`;

    try {
      // 1. Security checks right away while degraded/starting
      const unauthStatus = await fetch(`${baseUrl}/_recovery/status`);
      expect(unauthStatus.status).toBe(401);
      const unauthJson = (await unauthStatus.json()) as { authRequired: boolean };
      expect(unauthJson.authRequired).toBe(true);

      const badOrigin = await fetch(`${baseUrl}/_recovery/status`, {
        headers: { Authorization: `Bearer ${token}`, Origin: "http://evil.example" },
      });
      expect(badOrigin.status).toBe(403);

      // 2. While Neo is down, Neo's entry point (`/`) serves the Recovery Console HTML
      const entryHtmlRes = await fetch(`${baseUrl}/`);
      expect(entryHtmlRes.status).toBe(200);
      const entryHtml = await entryHtmlRes.text();
      expect(entryHtml).toContain("Neo 独立守护与自动恢复");

      // 3. Connect authenticated SSE stream and collect live recovery events
      const sseController = new AbortController();
      const sseEvents: Array<{ type: string; data: unknown }> = [];
      const ssePromise = (async () => {
        const res = await fetch(`${baseUrl}/_recovery/events`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: sseController.signal,
        });
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let sep: number;
            while ((sep = buf.indexOf("\n\n")) !== -1) {
              const block = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              let evType = "message";
              const lines: string[] = [];
              for (const line of block.split(/\r?\n/)) {
                if (line.startsWith("event:")) evType = line.slice(6).trim();
                else if (line.startsWith("data:")) lines.push(line.slice(5).trim());
              }
              if (lines.length > 0) {
                sseEvents.push({ type: evType, data: JSON.parse(lines.join("\n")) });
              }
            }
          }
        } catch {
          // aborted once test verifies recovery
        }
      })();

      // Wait until automatic recovery finishes and Neo becomes healthy!
      await waitFor(() => supervisor.store.getPhase() === "healthy", 15_000, 100);
      sseController.abort();
      await ssePromise;

      // Verify worker received backend-configured model from orchestrator.sqlite
      const seen = JSON.parse(fs.readFileSync(markerFile, "utf8")) as {
        attempt: number;
        model: string;
        diagFile: string;
      };
      expect(seen.attempt).toBe(1);
      expect(seen.model).toBe("gemini-e2e-worker-model");
      expect(fs.existsSync(seen.diagFile)).toBe(true);
      const diagText = fs.readFileSync(seen.diagFile, "utf8");
      expect(diagText).toContain("[REDACTED]");
      expect(diagText).not.toContain(token);

      // Verify SSE streamed rich repair details (worker_init, worker_text, tool_start/tool_end, worker_result)
      const kinds = new Set(
        sseEvents
          .filter((e) => e.type === "event")
          .map((e) => (e.data as { kind: string }).kind),
      );
      expect(kinds.has("worker_init")).toBe(true);
      expect(kinds.has("worker_text")).toBe(true);
      expect(kinds.has("tool_end")).toBe(true);
      expect(kinds.has("worker_result")).toBe(true);

      // Verify Neo entry point now transparently proxies the healthy Neo app!
      const livePage = await fetch(`${baseUrl}/`);
      expect(livePage.status).toBe(200);
      expect(await livePage.text()).toContain("NEO_LIVE_APP_OK");

      const liveHealth = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(liveHealth.status).toBe(200);
      const healthJson = (await liveHealth.json()) as { ready: boolean; version: string };
      expect(healthJson.ready).toBe(true);
      expect(healthJson.version).toBe("0.6.0-mock");

      // Verify chunked POST body is normalized to Content-Length for strict Neo HTTP/1.1 server
      const chunkedReply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: entryPort,
            path: "/api/echo",
            method: "POST",
            headers: {
              "Transfer-Encoding": "chunked",
              "Content-Type": "text/plain",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("error", reject);
        req.write("hello ");
        req.end("chunked-neo");
      });
      expect(chunkedReply.status).toBe(200);
      expect(JSON.parse(chunkedReply.body)).toEqual({
        echoed: "hello chunked-neo",
        contentLength: "17",
      });

      // Verify /_recovery/status still accessible while healthy, with history persisted & secret redacted
      const statusRes = await fetch(`${baseUrl}/_recovery/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(statusRes.status).toBe(200);
      const statusText = await statusRes.text();
      expect(statusText).not.toContain(token);
      const snap = JSON.parse(statusText) as {
        phase: string;
        history: Array<{ id: number; outcome: string; workerModel: string }>;
      };
      expect(snap.phase).toBe("healthy");
      expect(snap.history.length).toBe(1);
      expect(snap.history[0].outcome).toBe("recovered");
      expect(snap.history[0].workerModel).toBe("gemini-e2e-worker-model");
    } finally {
      await supervisor.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  test("retries after failed attempt via cooldown and recovers on attempt 2", async () => {
    const tmp = makeTempDir("neo-rec-e2e-retry-");
    const dataDir = path.join(tmp, "neo-data");
    const stateDir = path.join(tmp, "rec-state");
    const bugFile = path.join(tmp, "BUG_ACTIVE");
    const neoScript = path.join(tmp, "mock-neo.ts");
    const workerScript = path.join(tmp, "mock-worker.ts");

    writeSettingsDb(dataDir, "gemini-retry-model");
    fs.writeFileSync(bugFile, "broken", "utf8");
    writeMockNeoScript(neoScript, bugFile);
    writeMockWorkerScript(workerScript, bugFile, 2);

    const config = makeConfig([
      "start",
      "--mode",
      "proxy",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--internal-port",
      "0",
      "--data-dir",
      dataDir,
      "--repo-dir",
      tmp,
      "--state-dir",
      stateDir,
      "--target-bin",
      process.execPath,
      "--target-arg",
      "run",
      "--target-arg",
      neoScript,
      "--target-arg",
      "--host",
      "--target-arg",
      "{host}",
      "--target-arg",
      "--port",
      "--target-arg",
      "{port}",
      "--worker-cmd",
      process.execPath,
      "--worker-arg",
      "run",
      "--worker-arg",
      workerScript,
      "--probe-interval",
      "0.12",
      "--unhealthy-after",
      "0.35",
      "--min-failed-probes",
      "2",
      "--fast-restart-delay",
      "0.25",
      "--startup-timeout",
      "3",
      "--stable-probes",
      "1",
      "--cooldown",
      "0.3",
      "--max-attempts",
      "3",
    ]);

    const supervisor = new RecoverySupervisor(config);
    const started = await supervisor.start();
    expect(started.ok).toBe(true);

    try {
      await waitFor(() => supervisor.store.getPhase() === "healthy", 18_000, 100);
      const history = supervisor.store.snapshot().history;
      expect(history.length).toBe(2);
      expect(history[0].outcome).toBe("failed");
      expect(history[1].outcome).toBe("recovered");
    } finally {
      await supervisor.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 22_000);

  test("takeover mode binds Neo entry port during recovery and hands it back directly to Neo after repair", async () => {
    const tmp = makeTempDir("neo-rec-e2e-takeover-");
    const dataDir = path.join(tmp, "neo-data");
    const stateDir = path.join(tmp, "rec-state");
    const bugFile = path.join(tmp, "BUG_ACTIVE");
    const neoScript = path.join(tmp, "mock-neo.ts");
    const workerScript = path.join(tmp, "mock-worker.ts");

    writeSettingsDb(dataDir, "gemini-takeover-model");
    fs.writeFileSync(bugFile, "broken", "utf8");
    writeMockNeoScript(neoScript, bugFile);
    writeMockWorkerScript(workerScript, bugFile, 1);

    const config = makeConfig([
      "start",
      "--mode",
      "takeover",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--data-dir",
      dataDir,
      "--repo-dir",
      tmp,
      "--state-dir",
      stateDir,
      "--target-bin",
      process.execPath,
      "--target-arg",
      "run",
      "--target-arg",
      neoScript,
      "--target-arg",
      "--host",
      "--target-arg",
      "{host}",
      "--target-arg",
      "--port",
      "--target-arg",
      "{port}",
      "--worker-cmd",
      process.execPath,
      "--worker-arg",
      "run",
      "--worker-arg",
      workerScript,
      "--probe-interval",
      "0.12",
      "--unhealthy-after",
      "0.35",
      "--min-failed-probes",
      "2",
      "--fast-restart-delay",
      "0.25",
      "--startup-timeout",
      "5",
      "--stable-probes",
      "2",
    ]);

    const supervisor = new RecoverySupervisor(config);
    const started = await supervisor.start();
    expect(started.ok).toBe(true);
    const entryPort = (started as { ok: true; entryPort: number }).entryPort;
    const baseUrl = `http://127.0.0.1:${entryPort}`;

    try {
      // Wait for takeover Recovery Console to be reachable on Neo's exact entry port while recovering
      const sawConsole = await waitFor(async () => {
        if (supervisor.store.getPhase() !== "recovering") return false;
        try {
          const res = await fetch(`${baseUrl}/`);
          const text = await res.text();
          return text.includes("Neo 独立守护与自动恢复");
        } catch {
          return false;
        }
      }, 10_000, 60);
      expect(sawConsole).toBe(true);

      // Wait for Neo to recover and bind the entry port directly
      await waitFor(() => supervisor.store.getPhase() === "healthy", 15_000, 100);
      const livePage = await fetch(`${baseUrl}/`);
      expect(livePage.status).toBe(200);
      expect(await livePage.text()).toContain("NEO_LIVE_APP_OK");
    } finally {
      await supervisor.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  test("launches and proxies real compiled neo-agent binary in isolated temp data dir", async () => {
    const realNeoBin = "/nvme/workspace/neo/backend/dist/neo-agent";
    const realWebDir = "/nvme/workspace/neo/app/build/web";
    if (!fs.existsSync(realNeoBin) || !fs.existsSync(path.join(realWebDir, "index.html"))) {
      return;
    }

    const tmp = makeTempDir("neo-rec-real-neo-");
    const dataDir = path.join(tmp, "neo-data");
    const stateDir = path.join(tmp, "rec-state");
    const token = "isolated-real-neo-test-token-1234";

    const config = makeConfig([
      "start",
      "--mode",
      "proxy",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--internal-port",
      "0",
      "--token",
      token,
      "--allow-multiple",
      "--target-bin",
      realNeoBin,
      "--web-dir",
      realWebDir,
      "--data-dir",
      dataDir,
      "--repo-dir",
      "/nvme/workspace/neo",
      "--state-dir",
      stateDir,
      "--probe-interval",
      "0.25",
      "--unhealthy-after",
      "30",
    ]);

    const supervisor = new RecoverySupervisor(config);
    const started = await supervisor.start();
    expect(started.ok).toBe(true);
    const entryPort = (started as { ok: true; entryPort: number }).entryPort;
    const baseUrl = `http://127.0.0.1:${entryPort}`;

    try {
      await waitFor(() => supervisor.store.getPhase() === "healthy", 15_000, 150);

      // Unauthenticated /api/health returns Neo's 401 authRequired payload through the proxy
      const unauthHealth = await fetch(`${baseUrl}/api/health`);
      expect(unauthHealth.status).toBe(401);

      const healthRes = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as { version: string; kernel: string };
      expect(typeof health.version).toBe("string");
      expect(health.kernel).toBe("antigravity");

      const webRes = await fetch(`${baseUrl}/`);
      expect(webRes.status).toBe(200);
      const html = await webRes.text();
      expect(html.toLowerCase()).toContain("<!doctype html");

      const recRes = await fetch(`${baseUrl}/_recovery/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(recRes.status).toBe(200);
      const rec = (await recRes.json()) as { phase: string; targetRunning: boolean };
      expect(rec.phase).toBe("healthy");
      expect(rec.targetRunning).toBe(true);
    } finally {
      await supervisor.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 25_000);

  test("enforces single-instance lock per state directory and supports manual recover action", async () => {
    const tmp = makeTempDir("neo-rec-lock-");
    const dataDir = path.join(tmp, "neo-data");
    const stateDir = path.join(tmp, "rec-state");
    const bugFile = path.join(tmp, "BUG_ACTIVE");
    const neoScript = path.join(tmp, "mock-neo.ts");
    const workerScript = path.join(tmp, "mock-worker.ts");
    const token = "manual-action-test-token-987654";

    writeSettingsDb(dataDir, "gemini-manual-model");
    fs.writeFileSync(bugFile, "broken", "utf8");
    writeMockNeoScript(neoScript, bugFile);
    writeMockWorkerScript(workerScript, bugFile, 1);

    const args = [
      "start",
      "--mode",
      "proxy",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--internal-port",
      "0",
      "--token",
      token,
      "--data-dir",
      dataDir,
      "--repo-dir",
      tmp,
      "--state-dir",
      stateDir,
      "--target-bin",
      process.execPath,
      "--target-arg",
      "run",
      "--target-arg",
      neoScript,
      "--target-arg",
      "--host",
      "--target-arg",
      "{host}",
      "--target-arg",
      "--port",
      "--target-arg",
      "{port}",
      "--worker-cmd",
      process.execPath,
      "--worker-arg",
      "run",
      "--worker-arg",
      workerScript,
      "--probe-interval",
      "0.2",
      "--unhealthy-after",
      "300",
      "--min-failed-probes",
      "999",
      "--startup-timeout",
      "5",
      "--stable-probes",
      "1",
    ];

    const first = new RecoverySupervisor(makeConfig(args));
    const started = await first.start();
    expect(started.ok).toBe(true);
    const entryPort = (started as { ok: true; entryPort: number }).entryPort;

    try {
      // Simulate another PID holding the lockfile
      const lockFile = path.join(stateDir, "daemon.lock");
      const origLock = fs.readFileSync(lockFile, "utf8");
      const fake = JSON.parse(origLock) as { pid: number };
      // Use PID 1 (init) which is always alive and !== process.pid
      fs.writeFileSync(lockFile, JSON.stringify({ ...fake, pid: 1 }), "utf8");
      const second = new RecoverySupervisor(makeConfig(args));
      const blocked = await second.start();
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.exitCode).toBe(3);
      }
      fs.writeFileSync(lockFile, origLock, "utf8");

      // Trigger manual recovery immediately (bypassing 300s threshold)
      const actRes = await fetch(`http://127.0.0.1:${entryPort}/_recovery/action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action: "recover" }),
      });
      expect(actRes.status).toBe(202);

      await waitFor(() => first.store.getPhase() === "healthy", 15_000, 100);
      expect(first.store.snapshot().history.length).toBe(1);
      expect(first.store.snapshot().history[0].outcome).toBe("recovered");
    } finally {
      await first.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  test("skips automatic recovery while recoveryMode is false in Neo settings, and auto-recovers as soon as re-enabled", async () => {
    const tmp = makeTempDir("neo-rec-toggle-e2e-");
    const dataDir = path.join(tmp, "neo-data");
    const stateDir = path.join(tmp, "rec-state");
    const bugFile = path.join(tmp, "BUG_ACTIVE");
    const neoScript = path.join(tmp, "mock-neo.ts");
    const workerScript = path.join(tmp, "mock-worker.ts");
    const markerFile = path.join(tmp, "worker-ran.json");
    const token = "toggle-e2e-secret-token-123456";

    // Start with recoveryMode explicitly turned OFF in Neo settings
    writeSettingsDb(dataDir, "gemini-toggle-model", false, 10);
    fs.writeFileSync(bugFile, "broken", "utf8");
    writeMockNeoScript(neoScript, bugFile);
    writeMockWorkerScript(workerScript, bugFile, 1, markerFile);

    const config = makeConfig([
      "start",
      "--mode",
      "proxy",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--internal-port",
      "0",
      "--token",
      token,
      "--data-dir",
      dataDir,
      "--repo-dir",
      tmp,
      "--state-dir",
      stateDir,
      "--target-bin",
      process.execPath,
      "--target-arg",
      "run",
      "--target-arg",
      neoScript,
      "--target-arg",
      "--host",
      "--target-arg",
      "{host}",
      "--target-arg",
      "--port",
      "--target-arg",
      "{port}",
      "--worker-cmd",
      process.execPath,
      "--worker-arg",
      "run",
      "--worker-arg",
      workerScript,
      "--probe-interval",
      "0.12",
      "--unhealthy-after",
      "0.35",
      "--min-failed-probes",
      "2",
      "--fast-restart-delay",
      "0.4",
      "--startup-timeout",
      "5",
      "--stable-probes",
      "1",
    ]);

    const supervisor = new RecoverySupervisor(config);
    const started = await supervisor.start();
    expect(started.ok).toBe(true);
    const entryPort = (started as { ok: true; entryPort: number }).entryPort;

    try {
      // Wait well past unhealthyAfterMs + minFailedProbes -> worker MUST NOT have run!
      await waitFor(() => supervisor.store.getConsecutiveFailures() >= 5, 8_000, 80);
      expect(fs.existsSync(markerFile)).toBe(false);
      expect(supervisor.store.getPhase()).toBe("degraded");
      const statusOff = (await (
        await fetch(`http://127.0.0.1:${entryPort}/_recovery/status`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json()) as { recoveryModeEnabled: boolean; history: unknown[] };
      expect(statusOff.recoveryModeEnabled).toBe(false);
      expect(statusOff.history.length).toBe(0);

      // Now turn recoveryMode ON in Neo's SQLite settings (same as toggling the Neo Settings switch!)
      writeSettingsDb(dataDir, "gemini-toggle-model", true, 11);

      // Without restarting the daemon, it detects the toggle, runs worker, and brings Neo back healthy!
      await waitFor(() => supervisor.store.getPhase() === "healthy", 15_000, 100);
      expect(fs.existsSync(markerFile)).toBe(true);
      expect(supervisor.store.snapshot().recoveryModeEnabled).toBe(true);
      expect(supervisor.store.snapshot().history.length).toBe(1);
      expect(supervisor.store.snapshot().history[0].outcome).toBe("recovered");
    } finally {
      await supervisor.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 22_000);
});
