/**
 * The program itself, started as a real compiled standalone process: its commands, the server and
 * the desktop sidecar over real loopback sockets, `--config` and `--init-settings`, single-instance
 * locking (exit 3), clean SIGTERM and stdin-EOF shutdown, blocked-command stand-ins (exit 126),
 * `agy-hook` relay, and an end-to-end chat -> worker -> result flow driven by compiled `fixture-agy`.
 *
 * Ports every test from Rust `neo-agent/tests/process.rs` plus full standalone process coverage.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as httpClient from "../../src/app/http.ts";
import { TempDir } from "../../src/testkit/index.ts";
import { VERSION } from "../../src/version.ts";

const BACKEND_ROOT = path.resolve(import.meta.dir, "../..");
const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";
const PROGRAM = path.join(BACKEND_ROOT, "dist", `neo-agent${EXE_SUFFIX}`);
const FIXTURE_AGY = path.join(BACKEND_ROOT, "dist", `fixture-agy${EXE_SUFFIX}`);
const TOKEN = "0123456789abcdef-token";

type EnvMap = Record<string, string | undefined>;

interface CommandOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Build an isolated environment matching Rust `process.rs::program(dir)`: no machine state leaks in. */
function cleanEnv(dir: TempDir, overrides: EnvMap = {}): EnvMap {
  const env: EnvMap = { ...process.env };
  delete env.NEO_TOKEN;
  delete env.NEO_DATA_DIR;
  delete env.NEO_ALLOW_MULTIPLE;
  env.NEO_RUNTIME_DIR = dir.join("run");
  env.NEO_AGY_BIN = dir.join("no-agy");
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function serveArgs(dir: TempDir, data: string, more: readonly string[] = []): string[] {
  return ["serve", "--port", "0", "--data-dir", dir.join(data), ...more];
}

/** Run a short-lived executable to completion and capture exit code, stdout, and stderr. */
async function runExe(
  exe: string,
  args: readonly string[],
  options: { env?: EnvMap; stdinText?: string; cwd?: string } = {},
): Promise<CommandOutput> {
  const proc = Bun.spawn([exe, ...args], {
    env: options.env,
    cwd: options.cwd,
    stdin: options.stdinText !== undefined ? new Response(options.stdinText) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** Perform one HTTP call against the running process, matching Rust `process.rs::call`. */
async function call(
  port: number,
  method: string,
  reqPath: string,
  body?: unknown,
  token?: string,
): Promise<[number, unknown]> {
  const headers: Array<[string, string]> = [];
  if (body !== undefined) {
    headers.push(["content-type", "application/json"]);
  }
  if (token !== undefined) {
    headers.push(["authorization", `Bearer ${token}`]);
  }
  const res = await httpClient.send({
    method,
    url: `http://127.0.0.1:${port}${reqPath}`,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    timeoutMs: 10_000,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${method} ${reqPath} failed: ${httpClient.formatFailure(res.error)}`);
  }
  const text = new TextDecoder().decode(res.value.body);
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return [res.value.status, parsed];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the first `\n`-terminated line from a ReadableStream with a timeout, then drain the rest. */
async function readFirstLine(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<{ line: string; drain: Promise<void> }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const nl = buffer.indexOf("\n");
    if (nl !== -1) {
      const line = buffer.slice(0, nl + 1);
      const drain = (async () => {
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          // Stream closed on termination.
        } finally {
          reader.releaseLock();
        }
      })();
      return { line, drain };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reader.releaseLock();
      throw new Error(`Timed out after ${timeoutMs}ms waiting for startup JSON line; got ${JSON.stringify(buffer)}`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for startup JSON line; got ${JSON.stringify(buffer)}`)),
          remaining,
        );
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (chunk.done) {
      buffer += decoder.decode();
      reader.releaseLock();
      return { line: buffer, drain: Promise.resolve() };
    }
    buffer += decoder.decode(chunk.value, { stream: true });
  }
}

/** A long-running `neo-agent` child process, ported from Rust `process.rs::Running`. */
class Running {
  readonly port: number;
  readonly pid: number;
  readonly startedLine: Record<string, unknown>;
  private readonly proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  private readonly stderrPromise: Promise<string>;
  private readonly stdoutDrain: Promise<void>;
  private stdinClosed = false;
  private exited = false;

  private constructor(
    proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">,
    port: number,
    startedLine: Record<string, unknown>,
    stderrPromise: Promise<string>,
    stdoutDrain: Promise<void>,
  ) {
    this.proc = proc;
    this.pid = proc.pid;
    this.port = port;
    this.startedLine = startedLine;
    this.stderrPromise = stderrPromise;
    this.stdoutDrain = stdoutDrain;
    void proc.exited.then(() => {
      this.exited = true;
    });
  }

  /** Start a long-running command and read the JSON line saying where it listens. */
  static async start(
    args: readonly string[],
    env: EnvMap,
    token?: string,
  ): Promise<Running> {
    const proc = Bun.spawn([PROGRAM, ...args], {
      env,
      stdin: token !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderrPromise = new Response(proc.stderr).text();

    if (token !== undefined) {
      const sink = proc.stdin as Bun.FileSink;
      sink.write(`${token}\n`);
      await sink.flush();
    }

    let line: string;
    let drain: Promise<void>;
    try {
      const first = await readFirstLine(proc.stdout, 15_000);
      line = first.line;
      drain = first.drain;
    } catch (error) {
      proc.kill("SIGKILL");
      const errors = await stderrPromise.catch(() => "");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; stderr: ${errors}`,
      );
    }

    let said: unknown;
    try {
      said = JSON.parse(line);
    } catch {
      proc.kill("SIGKILL");
      await proc.exited;
      const errors = await stderrPromise.catch(() => "");
      throw new Error(`the program did not say where it listens: ${JSON.stringify(line)}; ${errors}`);
    }

    if (!isRecord(said) || typeof said.port !== "number") {
      proc.kill("SIGKILL");
      await proc.exited;
      const errors = await stderrPromise.catch(() => "");
      throw new Error(`unexpected startup line: ${JSON.stringify(line)}; ${errors}`);
    }

    expect([said.pid, said.version]).toEqual([proc.pid, VERSION]);
    return new Running(proc, said.port, said, stderrPromise, drain);
  }

  async get(reqPath: string, token?: string): Promise<[number, unknown]> {
    return await call(this.port, "GET", reqPath, undefined, token);
  }

  async call(method: string, reqPath: string, body?: unknown, token?: string): Promise<[number, unknown]> {
    return await call(this.port, method, reqPath, body, token);
  }

  /** Close standard input (simulating the desktop app closing). */
  async closeStdin(): Promise<void> {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    const sink = this.proc.stdin;
    if (sink && typeof sink === "object" && "end" in sink) {
      await sink.end();
    }
  }

  /** Wait for the program to end by itself within 20s and return `[exitCode, stderr]`. */
  async ended(timeoutMs = 20_000): Promise<[number | null, string]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([
      this.proc.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the program did not end")), timeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    this.exited = true;
    const [errors] = await Promise.all([this.stderrPromise, this.stdoutDrain]);
    return [code, errors];
  }

  /** Send SIGTERM and wait for a clean shutdown. */
  async terminate(timeoutMs = 20_000): Promise<[number | null, string]> {
    process.kill(this.pid, "SIGTERM");
    return await this.ended(timeoutMs);
  }

  /** Force-kill if still running, guaranteeing no leaked child processes. */
  async kill(): Promise<void> {
    if (!this.exited) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      await this.proc.exited.catch(() => {});
      this.exited = true;
    }
    await Promise.allSettled([this.stderrPromise, this.stdoutDrain]);
  }
}

async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 50,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await Bun.sleep(intervalMs);
  }
}

describe("neo-agent compiled process tests (Rust neo-agent/tests/process.rs)", () => {
  test("answers_its_plain_commands", async () => {
    const dir = new TempDir("agent-cli");
    try {
      const version = await runExe(PROGRAM, ["version"], { env: cleanEnv(dir) });
      expect([version.code, version.stdout]).toEqual([0, `neo-agent ${VERSION}\n`]);

      const help = await runExe(PROGRAM, [], { env: cleanEnv(dir) });
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("neo-agent serve [options]");
      expect(help.stdout).toContain("desktop-sidecar");

      const unknown = await runExe(PROGRAM, ["launch"], { env: cleanEnv(dir) });
      expect([unknown.code, unknown.stderr]).toEqual([2, "Unknown command launch; see neo-agent help\n"]);

      const option = await runExe(PROGRAM, ["serve", "--port", "many"], { env: cleanEnv(dir) });
      expect(option.code).toBe(2);
      expect(option.stderr).toContain("--port takes a number");

      // Offering the API to other machines takes a token, and a web folder must hold the web app.
      const open = await runExe(PROGRAM, serveArgs(dir, "wide", ["--host", "0.0.0.0"]), {
        env: cleanEnv(dir, { NEO_ALLOW_MULTIPLE: "1" }),
      });
      expect(open.code).toBe(1);
      expect(open.stderr).toContain("Listening on 0.0.0.0 needs an access token");

      const web = await runExe(PROGRAM, serveArgs(dir, "web", ["--web-dir", dir.join("no-web")]), {
        env: cleanEnv(dir),
      });
      expect(web.code).toBe(2);
      expect(web.stderr).toContain("holds no web app");

      const sidecar = await runExe(PROGRAM, ["desktop-sidecar", "--port", "0"], { env: cleanEnv(dir) });
      expect([sidecar.code, sidecar.stderr]).toEqual([
        2,
        "desktop-sidecar takes its access token with --token-stdin\n",
      ]);

      const short = await runExe(PROGRAM, ["desktop-sidecar", "--token-stdin"], {
        env: cleanEnv(dir),
        stdinText: "short\n",
      });
      expect(short.code).toBe(2);
      expect(short.stderr).toContain("at least 16 characters");

      // Without Antigravity the check of the machine fails and says what to do; with it, it passes.
      const doctorMissing = await runExe(PROGRAM, ["doctor", "--data-dir", dir.join("d")], {
        env: cleanEnv(dir),
      });
      expect(doctorMissing.code).toBe(1);
      expect(doctorMissing.stdout).toContain("Antigravity CLI:  missing");
      expect(doctorMissing.stdout).toContain("Antigravity CLI (agy) cannot run");
      expect(doctorMissing.stdout).toContain(`Data directory:   ${dir.join("d")}`);

      if (process.platform !== "win32") {
        const agy = dir.join("agy");
        fs.writeFileSync(agy, "#!/bin/sh\necho '9.9.9 (Antigravity CLI)'\n");
        fs.chmodSync(agy, 0o755);
        const doctorOk = await runExe(PROGRAM, ["doctor", "--data-dir", dir.join("d")], {
          env: cleanEnv(dir, { NEO_AGY_BIN: agy }),
        });
        expect(doctorOk.code).toBe(0);
        expect(doctorOk.stdout).toContain(`Antigravity CLI:  ok — ${agy} (9.9.9 (Antigravity CLI))`);
      }
    } finally {
      dir.cleanup();
    }
  });

  test(
    "serves_the_api_as_one_instance_and_stops_cleanly",
    async () => {
      const dir = new TempDir("agent-serve");
      const running: Running[] = [];
      try {
        const init = dir.join("settings.json");
        const web = dir.join("web");
        fs.writeFileSync(init, JSON.stringify({ executor: { maxWorkers: 7 } }));
        fs.mkdirSync(web, { recursive: true });
        fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Neo</title>");

        const first = await Running.start(
          serveArgs(dir, "data", ["--init-settings", init, "--web-dir", web]),
          cleanEnv(dir),
        );
        running.push(first);

        // It runs without a kernel, says so, and takes settings; the page is served beside the API.
        const [healthStatus, healthBody] = await first.get("/api/health");
        expect(healthStatus).toBe(200);
        const health = healthBody as {
          ready: boolean;
          components: { kernel: { state: string; detail: string } };
        };
        expect([health.ready, health.components.kernel.state]).toEqual([true, "error"]);
        expect(health.components.kernel.detail).toContain("is not installed");

        const [, generalInitial] = await first.get("/api/settings/general");
        expect((generalInitial as { executor: { maxWorkers: number } }).executor.maxWorkers).toBe(7);

        expect(await first.get("/api/messages")).toEqual([200, { messages: [] }]);

        const [putStatus] = await first.call("PUT", "/api/settings/general", {
          executor: { maxWorkers: 4 },
        });
        expect(putStatus).toBe(200);

        const [indexStatus] = await first.get("/");
        expect(indexStatus).toBe(200);

        const [chatStatus, refusedBody] = await first.call("POST", "/api/chat", { text: "hello" });
        expect(chatStatus).toBe(400);
        expect((refusedBody as { error: string }).error).toContain("is not installed");

        // A second instance of this user is refused and told where the first one is, whatever data directory it names.
        const second = await runExe(PROGRAM, serveArgs(dir, "other"), { env: cleanEnv(dir) });
        expect(second.code).toBe(3);
        expect(second.stderr).toContain(`Neo is already running on port ${first.port}`);
        expect(second.stdout).toBe("");

        // Allowed several, another data directory runs beside it, and the same one does not.
        const same = await runExe(PROGRAM, serveArgs(dir, "data", ["--allow-multiple"]), {
          env: cleanEnv(dir),
        });
        expect(same.code).toBe(3);

        const beside = await Running.start(
          serveArgs(dir, "other", ["--allow-multiple"]),
          cleanEnv(dir),
        );
        running.push(beside);
        expect(beside.port).not.toBe(first.port);
        const [, besideGeneral] = await beside.get("/api/settings/general");
        expect((besideGeneral as { executor: { maxWorkers: number } }).executor.maxWorkers).toBe(3);
        await beside.kill();

        if (process.platform !== "win32") {
          // Asked to end, it ends in order and frees its place.
          const [termStatus, termLog] = await first.terminate();
          expect(termStatus).toBe(0);
          expect(termLog).toContain("Stopping: terminated");
          expect(fs.existsSync(dir.join("run", "instance.json"))).toBe(false);

          // What was stored is there again, and the settings file is only where a new installation starts from.
          fs.writeFileSync(init, JSON.stringify({ executor: { maxWorkers: 9 } }));
          const again = await Running.start(
            serveArgs(dir, "data", ["--init-settings", init]),
            cleanEnv(dir),
          );
          running.push(again);
          const [, againGeneral] = await again.get("/api/settings/general");
          expect((againGeneral as { executor: { maxWorkers: number } }).executor.maxWorkers).toBe(4);
          // Without the web folder named, none is found beside a development build: only the API answers.
          const [noWebStatus] = await again.get("/");
          expect(noWebStatus).toBe(404);
          const [againTermStatus] = await again.terminate();
          expect(againTermStatus).toBe(0);
        }
      } finally {
        for (const proc of running) {
          await proc.kill();
        }
        dir.cleanup();
      }
    },
    30_000,
  );

  test(
    "backs_the_desktop_app_for_as_long_as_the_app_lives",
    async () => {
      const dir = new TempDir("agent-sidecar");
      let sidecar: Running | undefined;
      try {
        sidecar = await Running.start(
          ["desktop-sidecar", "--port", "0", "--token-stdin", "--data-dir", dir.join("data")],
          cleanEnv(dir),
          TOKEN,
        );

        // Only whoever holds the token the app made may call.
        expect(await sidecar.get("/api/messages", TOKEN)).toEqual([200, { messages: [] }]);
        expect((await sidecar.get("/api/messages"))[0]).toBe(401);
        expect((await sidecar.get("/api/messages", "0123456789abcdef-other"))[0]).toBe(401);

        const [hintStatus, hintBody] = await sidecar.get("/api/health");
        expect([hintStatus, (hintBody as { authRequired?: boolean }).authRequired]).toEqual([401, true]);

        const [, okHealth] = await sidecar.get("/api/health", TOKEN);
        expect((okHealth as { ready?: boolean }).ready).toBe(true);

        // The app going away, however it does, ends its backend.
        await sidecar.closeStdin();
        const [exitStatus, log] = await sidecar.ended();
        expect(exitStatus).toBe(0);
        expect(log).toContain("Stopping: the desktop app closed");
      } finally {
        if (sidecar) await sidecar.kill();
        dir.cleanup();
      }
    },
    30_000,
  );

  test("refuses_to_run_as_a_blocked_command", async () => {
    const dir = new TempDir("agent-blocked");
    try {
      const folder = dir.join("worker-bin");
      fs.mkdirSync(folder, { recursive: true });
      const name = process.platform === "win32" ? "docker.exe" : "docker";
      const standIn = path.join(folder, name);
      fs.copyFileSync(PROGRAM, standIn);
      if (process.platform !== "win32") {
        fs.chmodSync(standIn, 0o755);
      }

      const refused = await runExe(standIn, ["run", "--rm", "alpine"]);
      expect(refused.code).toBe(126);
      expect(refused.stderr).toBe(
        "docker is blocked in this installation by the Neo settings; do the work without it.\n",
      );
      expect(refused.stdout).toBe("");

      // Under its own name elsewhere it is itself.
      const elsewhere = dir.join(process.platform === "win32" ? "renamed.exe" : "renamed");
      fs.copyFileSync(PROGRAM, elsewhere);
      if (process.platform !== "win32") {
        fs.chmodSync(elsewhere, 0o755);
      }
      const renamedVersion = await runExe(elsewhere, ["version"]);
      expect(renamedVersion.code).toBe(0);
      expect(renamedVersion.stdout.startsWith("neo-agent ")).toBe(true);
      expect(fs.statSync(PROGRAM).isFile()).toBe(true);
    } finally {
      dir.cleanup();
    }
  });

  test(
    "loads_serve_options_from_config_file_and_rejects_invalid_config",
    async () => {
      const dir = new TempDir("agent-config");
      let server: Running | undefined;
      try {
        const webDir = dir.join("web");
        fs.mkdirSync(webDir, { recursive: true });
        fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>Config</title>");

        const cfgToken = "config-access-token-0123456789";
        const configPath = dir.join("config.json");
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            dataDir: dir.join("cfg-data"),
            host: "127.0.0.1",
            port: 0,
            token: cfgToken,
            webDir,
          }),
        );

        server = await Running.start(["serve", "--config", configPath], cleanEnv(dir));
        expect((await server.get("/api/messages"))[0]).toBe(401);
        expect(await server.get("/api/messages", cfgToken)).toEqual([200, { messages: [] }]);
        expect((await server.get("/"))[0]).toBe(200);

        if (process.platform !== "win32") {
          const [status, log] = await server.terminate();
          expect(status).toBe(0);
          expect(log).toContain("Stopping: terminated");
        } else {
          await server.kill();
        }

        // Unknown field in config file is strictly rejected with exit code 2.
        const badConfig = dir.join("bad-config.json");
        fs.writeFileSync(badConfig, JSON.stringify({ stateDir: dir.join("bad") }));
        const invalid = await runExe(PROGRAM, ["serve", "--config", badConfig], {
          env: cleanEnv(dir),
        });
        expect(invalid.code).toBe(2);
        expect(invalid.stderr).toContain("unknown field `stateDir`");
      } finally {
        if (server) await server.kill();
        dir.cleanup();
      }
    },
    30_000,
  );

  test("relays_agy_hook_over_loopback_tcp_and_reports_errors", async () => {
    const hookToken = "hook-secret-token";
    let lastRequestLine = "";
    let lastBody = "";

    const tcpServer = net.createServer((socket) => {
      socket.setNoDelay(true);
      const chunks: Buffer[] = [];
      let headerDone = false;
      let headerEnd = -1;
      let contentLen = 0;

      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        if (!headerDone) {
          headerEnd = raw.indexOf("\r\n\r\n");
          if (headerEnd !== -1) {
            headerDone = true;
            const head = raw.subarray(0, headerEnd).toString("utf8");
            const match = /content-length:\s*(\d+)/i.exec(head);
            contentLen = match ? Number(match[1]) : 0;
          }
        }
        if (headerDone && raw.byteLength >= headerEnd + 4 + contentLen) {
          const head = raw.subarray(0, headerEnd).toString("utf8");
          lastRequestLine = head.split("\r\n")[0] ?? "";
          const reqPath = lastRequestLine.split(" ")[1] ?? "";
          lastBody = raw.subarray(headerEnd + 4, headerEnd + 4 + contentLen).toString("utf8");

          if (reqPath === `/hook/${hookToken}`) {
            const payload = JSON.parse(lastBody) as { toolCall?: { name?: string } };
            const reply = JSON.stringify({
              decision: "deny",
              reason: payload.toolCall?.name ?? "unknown",
            });
            socket.end(
              `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(reply)}\r\nConnection: close\r\n\r\n${reply}`,
            );
          } else {
            socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          }
        }
      });
    });

    await new Promise<void>((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
    const addr = tcpServer.address();
    if (!addr || typeof addr === "string") {
      tcpServer.close();
      throw new Error("expected TCP address");
    }

    try {
      const payload = JSON.stringify({ toolCall: { name: "run_command" } });
      const ok = await runExe(PROGRAM, ["agy-hook", `http://127.0.0.1:${addr.port}/hook/${hookToken}`], {
        stdinText: payload,
      });
      expect(ok.code).toBe(0);
      expect(ok.stderr).toBe("");
      expect(JSON.parse(ok.stdout)).toEqual({ decision: "deny", reason: "run_command" });
      expect(lastRequestLine).toBe(`POST /hook/${hookToken} HTTP/1.1`);
      expect(lastBody).toBe(payload);

      const denied = await runExe(PROGRAM, ["agy-hook", `http://127.0.0.1:${addr.port}/hook/wrong`], {
        stdinText: "{}",
      });
      expect(denied.code).toBe(1);
      expect(denied.stdout).toBe("");
      expect(denied.stderr.trim()).toBe("Neo answered the hook with status 401");

      const nonHttp = await runExe(PROGRAM, ["agy-hook", `https://127.0.0.1:${addr.port}/hook/${hookToken}`], {
        stdinText: "{}",
      });
      expect(nonHttp.code).toBe(1);
      expect(nonHttp.stderr.trim()).toBe("The hook URL is not http");
    } finally {
      await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    }
  });

  test(
    "runs_end_to_end_chat_to_worker_to_result_with_fixture_agy",
    async () => {
      expect(fs.statSync(FIXTURE_AGY).isFile()).toBe(true);
      const dir = new TempDir("agent-e2e-fixture");
      let server: Running | undefined;
      try {
        const env = cleanEnv(dir, { NEO_AGY_BIN: FIXTURE_AGY });

        // Doctor recognizes compiled fixture-agy as a valid Antigravity CLI runtime.
        const doctor = await runExe(PROGRAM, ["doctor", "--data-dir", dir.join("data")], { env });
        expect(doctor.code).toBe(0);
        expect(doctor.stdout).toContain(`Antigravity CLI:  ok — ${FIXTURE_AGY} (agy 1.0.0-fixture)`);

        server = await Running.start(serveArgs(dir, "data"), env);

        const [healthStatus, healthBody] = await server.get("/api/health");
        expect(healthStatus).toBe(200);
        const health = healthBody as {
          ready: boolean;
          components: { kernel: { state: string } };
        };
        expect(health.ready).toBe(true);
        expect(health.components.kernel.state).toBe("ready");

        // Model listing discovers fixture-agy's models (loaded asynchronously in background).
        const models = await pollUntil(
          async () => {
            const [status, body] = await server!.get("/api/settings/models");
            if (status !== 200 || !isRecord(body) || !Array.isArray(body.available)) {
              return undefined;
            }
            if (body.loading === true && body.available.length === 0) {
              return undefined;
            }
            return body.available as Array<{ id?: string; name?: string }>;
          },
          10_000,
          50,
          "fixture-agy models in /api/settings/models",
        );
        expect(models.map((m) => m.id)).toContain("gemini-3.8-flash-low");
        expect(models.map((m) => m.id)).toContain("gemini-3.8-pro-high");

        // Send a chat request: fixture-agy orchestrator accepts -> spawns fixture-agy worker ->
        // worker writes result.txt and reports ready -> orchestrator delivers final reply.
        const [chatStatus, chatReceipt] = await server.call("POST", "/api/chat", {
          text: "Write the result file please",
        });
        expect(chatStatus).toBe(202);
        expect((chatReceipt as { result: string }).result).toBe("stored");

        const finalMessages = await pollUntil(
          async () => {
            const [status, body] = await server!.get("/api/messages");
            if (status !== 200 || !isRecord(body) || !Array.isArray(body.messages)) {
              return undefined;
            }
            const msgs = body.messages as Array<{ text?: string }>;
            if (msgs.some((m) => m.text === "The file is written.")) {
              return msgs;
            }
            return undefined;
          },
          20_000,
          100,
          "orchestrator final reply in /api/messages",
        );

        const texts = finalMessages.map((m) => m.text ?? "");
        expect(texts).toContain("Write the result file please");
        expect(texts).toContain("On it.");
        expect(texts).toContain("The file is written.");

        const workers = await pollUntil(
          async () => {
            const [status, body] = await server!.get("/api/workers");
            if (status !== 200 || !isRecord(body) || !Array.isArray(body.workers)) {
              return undefined;
            }
            const list = body.workers as Array<{
              ticketId?: string;
              title?: string;
              directory?: string | null;
              outcome?: string | null;
              stage?: { stage?: string };
              progress?: { state?: string; summary?: string } | null;
            }>;
            const match = list.find(
              (w) => w.title === "Write the result file" && w.stage?.stage === "ended",
            );
            return match ? list : undefined;
          },
          10_000,
          100,
          "completed worker card in /api/workers",
        );

        const worker = workers.find((w) => w.title === "Write the result file");
        expect(worker?.outcome).toBe("completed");
        expect(worker?.progress?.state).toBe("ready");
        expect(worker?.progress?.summary).toBe("Wrote result.txt.");

        // Verify the worker actually wrote result.txt in its worktree directory.
        const workerDir = worker?.directory ?? dir.join("data", "work", "write-result");
        const resultFile = path.join(workerDir, "result.txt");
        expect(fs.existsSync(resultFile)).toBe(true);
        expect(fs.readFileSync(resultFile, "utf8")).toBe("done by the worker\n");

        // SIGTERM shuts down cleanly and removes instance.json.
        if (process.platform !== "win32") {
          const [termStatus, termLog] = await server.terminate();
          expect(termStatus).toBe(0);
          expect(termLog).toContain("Stopping: terminated");
          expect(fs.existsSync(dir.join("run", "instance.json"))).toBe(false);
        }
      } finally {
        if (server) await server.kill();
        dir.cleanup();
      }
    },
    45_000,
  );

  test(
    "enforces_single_instance_allow_multiple_persistence_and_sigterm_shutdown",
    async () => {
      const dir = new TempDir("agent-single-instance");
      const running: Running[] = [];
      try {
        const web = dir.join("web");
        fs.mkdirSync(web, { recursive: true });
        fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Neo</title>");

        const first = await Running.start(
          serveArgs(dir, "data", ["--web-dir", web]),
          cleanEnv(dir),
        );
        running.push(first);

        expect(await first.get("/api/messages")).toEqual([200, { messages: [] }]);
        expect((await first.get("/"))[0]).toBe(200);

        const [putStatus] = await first.call("PUT", "/api/settings/general", {
          executor: { maxWorkers: 4 },
        });
        expect(putStatus).toBe(200);

        const [chatStatus, refusedBody] = await first.call("POST", "/api/chat", { text: "hello" });
        expect(chatStatus).toBe(400);
        expect((refusedBody as { error: string }).error).toContain("is not installed");

        // Second instance for same user is refused with exit 3 and told where the first listens.
        const second = await runExe(PROGRAM, serveArgs(dir, "other"), { env: cleanEnv(dir) });
        expect(second.code).toBe(3);
        expect(second.stderr).toContain(`Neo is already running on port ${first.port}`);
        expect(second.stdout).toBe("");

        // With --allow-multiple, same data dir is still refused (exit 3), different data dir succeeds.
        const same = await runExe(PROGRAM, serveArgs(dir, "data", ["--allow-multiple"]), {
          env: cleanEnv(dir),
        });
        expect(same.code).toBe(3);

        const beside = await Running.start(
          serveArgs(dir, "other", ["--allow-multiple"]),
          cleanEnv(dir),
        );
        running.push(beside);
        expect(beside.port).not.toBe(first.port);
        const [, besideGeneral] = await beside.get("/api/settings/general");
        expect((besideGeneral as { executor: { maxWorkers: number } }).executor.maxWorkers).toBe(3);
        await beside.kill();

        if (process.platform !== "win32") {
          const [termStatus, termLog] = await first.terminate();
          expect(termStatus).toBe(0);
          expect(termLog).toContain("Stopping: terminated");
          expect(fs.existsSync(dir.join("run", "instance.json"))).toBe(false);

          // Stored settings persist across restart, and omitting --web-dir returns 404 on `/`.
          const again = await Running.start(serveArgs(dir, "data"), cleanEnv(dir));
          running.push(again);
          const [, againGeneral] = await again.get("/api/settings/general");
          expect((againGeneral as { executor: { maxWorkers: number } }).executor.maxWorkers).toBe(4);
          expect((await again.get("/"))[0]).toBe(404);
          const [againTermStatus] = await again.terminate();
          expect(againTermStatus).toBe(0);
        }
      } finally {
        for (const proc of running) {
          await proc.kill();
        }
        dir.cleanup();
      }
    },
    30_000,
  );
});
