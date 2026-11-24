import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  ConfigFile,
  USAGE,
  defaultCommon,
  defaultServe,
  parse,
  type Command,
  type Result,
} from "../../src/agent/cli.ts";
import { HOOK_READ_TIMEOUT_MS, relayHook } from "../../src/agent/hook-fast.ts";
import { ALREADY_RUNNING, Instance } from "../../src/agent/instance.ts";
import {
  defaultDataDir,
  findRuntime,
  findWeb,
  installDirs,
  onPath,
  programDir,
  runtimeDir,
} from "../../src/agent/paths.ts";
import { VERSION } from "../../src/version.ts";
import { extractCliArgs, isBunVirtualEntry } from "../../src/main.ts";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `neo-${prefix}-`));
}

function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = makeTempDir(prefix);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = makeTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\n");
  fs.chmodSync(filePath, 0o755);
}

describe("version", () => {
  test("matches backend/package.json version", () => {
    const pkgPath = path.resolve(import.meta.dir, "../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(VERSION)).toBe(true);
  });

  test("extractCliArgs strips Bun virtual entrypoints across Linux, macOS, and Windows", () => {
    expect(isBunVirtualEntry("/$bunfs/root/neo-agent")).toBe(true);
    expect(isBunVirtualEntry("B:/~BUN/root/neo-agent.exe")).toBe(true);
    expect(isBunVirtualEntry("B:\\~BUN\\root\\neo-agent.exe")).toBe(true);
    expect(isBunVirtualEntry("version")).toBe(false);

    expect(extractCliArgs(["bun", "B:/~BUN/root/neo-agent.exe", "version"], "C:\\Neo\\neo-agent.exe")).toEqual(["version"]);
    expect(extractCliArgs(["C:\\Neo\\neo-agent.exe", "B:\\~BUN\\root\\neo-agent.exe", "serve", "--port", "0"], "C:\\Neo\\neo-agent.exe")).toEqual(["serve", "--port", "0"]);
    expect(extractCliArgs(["bun", "/$bunfs/root/neo-agent", "doctor"], "/opt/neo/neo-agent")).toEqual(["doctor"]);
    expect(extractCliArgs(["/opt/neo/neo-agent", "version"], "/opt/neo/neo-agent")).toEqual(["version"]);
    expect(extractCliArgs(["/usr/bin/bun", "src/main.ts", "version"], "/usr/bin/bun")).toEqual(["version"]);
  });
});

describe("cli", () => {
  function parsed(line: string): Result<Command, string> {
    const trimmed = line.trim();
    const args = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
    return parse(args);
  }

  test("parses_each_command_with_its_options_in_either_form", () => {
    expect(parsed("")).toEqual({ ok: true, value: { kind: "help" } });
    expect(parsed("help")).toEqual({ ok: true, value: { kind: "help" } });
    expect(parsed("--help")).toEqual({ ok: true, value: { kind: "help" } });
    expect(parsed("-h")).toEqual({ ok: true, value: { kind: "help" } });
    expect(parsed("version")).toEqual({ ok: true, value: { kind: "version" } });
    expect(parsed("--version")).toEqual({ ok: true, value: { kind: "version" } });
    expect(parsed("-V")).toEqual({ ok: true, value: { kind: "version" } });

    expect(parsed("serve")).toEqual({ ok: true, value: { kind: "serve", options: defaultServe() } });

    const serveRes = parsed(
      "serve --host 0.0.0.0 --port=8080 --token abcdefghijklmnop --data-dir /srv/neo --web-dir=/srv/web --config c.json --init-settings s.json --allow-multiple",
    );
    expect(serveRes.ok).toBe(true);
    if (!serveRes.ok || serveRes.value.kind !== "serve") {
      throw new Error("expected serve command");
    }
    const serve = serveRes.value.options;
    expect(serve.host).toBe("0.0.0.0");
    expect(serve.port).toBe(8080);
    expect(serve.token).toBe("abcdefghijklmnop");
    expect(serve.common).toEqual({ dataDir: "/srv/neo", allowMultiple: true });
    expect(serve.webDir).toBe("/srv/web");
    expect(serve.config).toBe("c.json");
    expect(serve.initSettings).toBe("s.json");

    expect(parsed("desktop-sidecar --port 0 --token-stdin --data-dir=/d")).toEqual({
      ok: true,
      value: {
        kind: "sidecar",
        options: {
          common: { ...defaultCommon(), dataDir: "/d" },
          port: 0,
          tokenStdin: true,
        },
      },
    });

    expect(parsed("doctor --data-dir /d")).toEqual({
      ok: true,
      value: {
        kind: "doctor",
        options: { ...defaultCommon(), dataDir: "/d" },
      },
    });
  });

  test("says_what_is_wrong_with_a_command_line", () => {
    const unwrapErr = (line: string): string => {
      const res = parsed(line);
      expect(res.ok).toBe(false);
      return res.ok ? "" : res.error;
    };

    expect(unwrapErr("run")).toBe("Unknown command run; see neo-agent help");
    expect(unwrapErr("serve --verbose")).toBe("Unknown option --verbose for serve; see neo-agent help");
    expect(unwrapErr("serve --agent-dir /srv/omp")).toBe(
      "Unknown option --agent-dir for serve; see neo-agent help",
    );
    expect(unwrapErr("serve --port")).toBe("--port needs a value");
    expect(unwrapErr("serve --port=")).toBe("--port needs a value");
    expect(unwrapErr("serve --port 70000")).toBe(
      '--port takes a number from 0 to 65535, not "70000"',
    );
    expect(unwrapErr("serve --allow-multiple=yes")).toBe("--allow-multiple takes no value");
    expect(unwrapErr("desktop-sidecar --host 0.0.0.0")).toBe(
      "Unknown option --host for desktop-sidecar; see neo-agent help",
    );
    expect(unwrapErr("doctor --port 1")).toBe("Unknown option --port for doctor; see neo-agent help");

    // Additional edge cases matching Rust u16::from_str and inline splitting semantics
    expect(unwrapErr("serve --port -1")).toBe('--port takes a number from 0 to 65535, not "-1"');
    expect(unwrapErr("serve --port 0x10")).toBe('--port takes a number from 0 to 65535, not "0x10"');
    expect(unwrapErr("serve --port 1e2")).toBe('--port takes a number from 0 to 65535, not "1e2"');
    expect(unwrapErr("serve --port= 8080")).toBe("--port needs a value");
    expect(unwrapErr("desktop-sidecar --token-stdin=1")).toBe("--token-stdin takes no value");

    // Inline values containing '=' keep everything after the first '='
    const eqToken = parse(["serve", "--token=abc=def=12345678"]);
    expect(eqToken).toEqual({
      ok: true,
      value: { kind: "serve", options: { ...defaultServe(), token: "abc=def=12345678" } },
    });
  });

  test("reads_a_configuration_file_strictly", () => {
    withTempDir("cli", (dir) => {
      const file = path.join(dir, "config.json");
      fs.writeFileSync(
        file,
        '{"dataDir": "/srv/neo", "host": "0.0.0.0", "port": 3082, "token": "abcdefghijklmnop", "webDir": "/srv/web"}',
      );
      const ok = ConfigFile.read(file);
      expect(ok).toEqual({
        ok: true,
        value: {
          dataDir: "/srv/neo",
          host: "0.0.0.0",
          port: 3082,
          token: "abcdefghijklmnop",
          webDir: "/srv/web",
        },
      });

      fs.writeFileSync(file, '{"stateDir": "/srv/neo"}');
      const unknown = ConfigFile.read(file);
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) {
        expect(unknown.error).toContain("unknown field `stateDir`");
      }

      const missing = ConfigFile.read(path.join(dir, "missing.json"));
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.error.startsWith("Cannot read ")).toBe(true);
      }

      // Null optional fields are accepted like serde Option<T>
      fs.writeFileSync(file, '{"host": null, "port": null}');
      expect(ConfigFile.read(file)).toEqual({ ok: true, value: {} });

      // Invalid port rejected
      fs.writeFileSync(file, '{"port": 70000}');
      const badPort = ConfigFile.read(file);
      expect(badPort.ok).toBe(false);
    });
  });

  test("contains expected USAGE documentation", () => {
    expect(USAGE).toContain("neo-agent serve [options]");
    expect(USAGE).toContain("neo-agent desktop-sidecar [options]");
    expect(USAGE).toContain("neo-agent doctor [options]");
    expect(USAGE).toContain("neo-agent version");
    expect(USAGE).toContain("NEO_AGY_BIN");
    expect(USAGE).toContain("NEO_DATA_DIR");
  });
});

describe("paths", () => {
  test("finds_a_runtime_where_it_is_named_then_on_the_path_then_where_it_installs_itself", () => {
    if (process.platform === "win32") return;

    withTempDir("paths", (dir) => {
      const local = path.join(dir, "home", ".local", "bin");
      const usr = path.join(dir, "usr", "bin");
      const installed = [local];
      makeExecutable(path.join(local, "agy"));
      makeExecutable(path.join(usr, "tool"));

      const pathEnv = [path.join(dir, "empty"), usr].join(path.delimiter);

      // The path wins over the installer's folder, which is found when the path leaves it out.
      expect(findRuntime("tool", undefined, pathEnv, installed)).toBe(path.join(usr, "tool"));
      expect(findRuntime("agy", undefined, pathEnv, installed)).toBe(path.join(local, "agy"));
      expect(findRuntime("agy", undefined, undefined, installed)).toBe(path.join(local, "agy"));

      // The environment's choice wins over all, and a wrong one is not papered over.
      const customAgy = path.join(dir, "custom", "agy");
      makeExecutable(customAgy);
      expect(findRuntime("agy", customAgy, pathEnv, installed)).toBe(customAgy);
      expect(findRuntime("agy", path.join(dir, "custom", "missing"), pathEnv, installed)).toBeUndefined();

      // A file that cannot be run is no program.
      fs.writeFileSync(path.join(usr, "plain"), "text");
      expect(findRuntime("plain", undefined, pathEnv, [])).toBeUndefined();
      expect(findRuntime("missing", undefined, pathEnv, installed)).toBeUndefined();
      expect(findRuntime("agy", undefined, undefined, [])).toBeUndefined();
      expect(onPath("tool", pathEnv)).toBe(path.join(usr, "tool"));
    });
  });

  test("finds_the_web_files_of_an_installation", () => {
    withTempDir("bundle", (dir) => {
      const bin = path.join(dir, "Neo.app", "Contents", "Helpers");
      fs.mkdirSync(bin, { recursive: true });
      const resources = path.join(dir, "Neo.app", "Contents", "Resources");

      expect(findWeb(undefined)).toBeUndefined();
      expect(findWeb(bin)).toBeUndefined();

      fs.mkdirSync(path.join(resources, "web"), { recursive: true });
      expect(findWeb(bin)).toBeUndefined();

      fs.writeFileSync(path.join(resources, "web", "index.html"), "<!doctype html>");
      expect(findWeb(bin)).toBe(path.join(resources, "web"));

      // One level up takes precedence over Resources/web, and beside-program wins over both
      const parentWeb = path.join(dir, "Neo.app", "Contents", "web");
      fs.mkdirSync(parentWeb, { recursive: true });
      fs.writeFileSync(path.join(parentWeb, "index.html"), "<!doctype html>");
      expect(findWeb(bin)).toBe(parentWeb);

      const besideWeb = path.join(bin, "web");
      fs.mkdirSync(besideWeb, { recursive: true });
      fs.writeFileSync(path.join(besideWeb, "index.html"), "<!doctype html>");
      expect(findWeb(bin)).toBe(besideWeb);
    });
  });

  test("names_the_per_user_directories", () => {
    const data = defaultDataDir();
    expect(path.isAbsolute(data)).toBe(true);
    expect(path.basename(data)).toBe("neo-agent");
    expect(path.isAbsolute(runtimeDir())).toBe(true);
    expect(installDirs().length).toBeGreaterThanOrEqual(1);
    const prog = programDir();
    expect(prog !== undefined && path.isAbsolute(prog)).toBe(true);
  });

  test("respects NEO_RUNTIME_DIR and XDG overrides on Linux", () => {
    if (process.platform !== "linux") return;
    const saved = {
      NEO_RUNTIME_DIR: process.env.NEO_RUNTIME_DIR,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    try {
      process.env.NEO_RUNTIME_DIR = "/tmp/neo-custom-run";
      expect(runtimeDir()).toBe("/tmp/neo-custom-run");

      delete process.env.NEO_RUNTIME_DIR;
      process.env.XDG_RUNTIME_DIR = "/run/user/1000";
      expect(runtimeDir()).toBe("/run/user/1000/neo-agent");

      // Relative XDG_RUNTIME_DIR is ignored
      process.env.XDG_RUNTIME_DIR = "relative/run";
      expect(runtimeDir()).toStartWith(os.tmpdir());

      process.env.XDG_STATE_HOME = "/var/tmp/neo-state";
      expect(defaultDataDir()).toBe("/var/tmp/neo-state/neo-agent");

      // Relative XDG_STATE_HOME is ignored
      process.env.XDG_STATE_HOME = "relative/state";
      expect(defaultDataDir().endsWith(path.join(".local", "state", "neo-agent"))).toBe(true);
    } finally {
      if (saved.NEO_RUNTIME_DIR === undefined) delete process.env.NEO_RUNTIME_DIR;
      else process.env.NEO_RUNTIME_DIR = saved.NEO_RUNTIME_DIR;
      if (saved.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = saved.XDG_RUNTIME_DIR;
      if (saved.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved.XDG_STATE_HOME;
    }
  });
});

describe("instance", () => {
  test("ALREADY_RUNNING is 3", () => {
    expect(ALREADY_RUNNING).toBe(3);
  });

  test("lets_one_instance_run_per_user_and_per_data_directory", () => {
    withTempDir("instance", (dir) => {
      const run = path.join(dir, "run");
      const first = path.join(dir, "data-1");
      const second = path.join(dir, "data-2");

      const firstAcquire = Instance.acquire(run, first);
      expect(firstAcquire.ok).toBe(true);
      if (!firstAcquire.ok) {
        throw new Error("the first instance starts");
      }
      const running = firstAcquire.value;

      // A second one is refused, whatever its data directory; it learns where the first one is once that is published.
      expect(Instance.acquire(run, second)).toEqual({
        ok: false,
        error: { kind: "running", info: null },
      });

      running.publish(3082, first);
      const known = Instance.acquire(run, second);
      expect(known.ok).toBe(false);
      if (known.ok || known.error.kind !== "running" || known.error.info === null) {
        throw new Error("the instance is known");
      }
      expect(known.error.info.port).toBe(3082);
      expect(known.error.info.pid).toBe(process.pid);
      expect(known.error.info.dataDir).toBe(first);
      expect(known.error.info.version).toBe(VERSION);

      // Allowed several, an instance still owns its data directory alone.
      expect(Instance.acquire(null, first)).toEqual({
        ok: false,
        error: { kind: "running", info: null },
      });
      const otherAcquire = Instance.acquire(null, second);
      expect(otherAcquire.ok).toBe(true);
      if (!otherAcquire.ok) {
        throw new Error("another data directory is free");
      }
      const other = otherAcquire.value;
      expect(Instance.acquire(null, second)).toEqual({
        ok: false,
        error: { kind: "running", info: null },
      });

      // Ending an instance frees its place and removes what it published.
      running.release();
      running.release(); // idempotent
      expect(fs.existsSync(path.join(run, "instance.json"))).toBe(false);

      const againAcquire = Instance.acquire(run, first);
      expect(againAcquire.ok).toBe(true);
      if (!againAcquire.ok) {
        throw new Error("the place is free again");
      }
      againAcquire.value.release();
      other.release();

      // If per-user lock succeeds but dataDir fails, per-user lock must not leak!
      const blocker = path.join(dir, "blocker-file");
      fs.writeFileSync(blocker, "x");
      const unwound = Instance.acquire(run, blocker);
      expect(unwound.ok).toBe(false);
      if (!unwound.ok) {
        expect(unwound.error.kind).toBe("failed");
      }
      // Verify `run` lock was released during unwind
      const afterUnwind = Instance.acquire(run, first);
      expect(afterUnwind.ok).toBe(true);
      if (afterUnwind.ok) afterUnwind.value.release();

      // A place that cannot be used says so.
      const file = path.join(dir, "file");
      fs.writeFileSync(file, "x");
      const failed = Instance.acquire(file, first);
      expect(failed.ok).toBe(false);
      if (failed.ok || failed.error.kind !== "failed") {
        throw new Error("expected Refused.failed");
      }
      expect(failed.error.reason.startsWith("Cannot lock ")).toBe(true);
    });
  });

  test("releases OS lock automatically when holding process is SIGKILLed", async () => {
    if (process.platform === "win32") return;

    await withTempDirAsync("instance-sigkill", async (dir) => {
      const run = path.join(dir, "run");
      const data = path.join(dir, "data");
      const instanceModule = path.resolve(import.meta.dir, "../../src/agent/instance.ts");

      const script = `
        import { Instance } from ${JSON.stringify(instanceModule)};
        const res = Instance.acquire(${JSON.stringify(run)}, ${JSON.stringify(data)});
        if (!res.ok) process.exit(10);
        res.value.publish(4321, ${JSON.stringify(data)});
        console.log("LOCKED");
        setInterval(() => {}, 10000);
      `;

      const child = Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const reader = child.stdout.getReader();
      let buf = "";
      while (!buf.includes("LOCKED")) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      expect(buf).toContain("LOCKED");

      // While child is alive, our acquire must be refused with Running + published info
      const blocked = Instance.acquire(run, path.join(dir, "other"));
      expect(blocked.ok).toBe(false);
      if (blocked.ok || blocked.error.kind !== "running" || blocked.error.info === null) {
        throw new Error("expected running lock from child process");
      }
      expect(blocked.error.info.port).toBe(4321);
      expect(blocked.error.info.pid).toBe(child.pid);

      // SIGKILL the child (no cleanup handler can run!)
      child.kill("SIGKILL");
      await child.exited;

      // OS kernel must immediately release flock so acquire succeeds!
      const reclaimed = Instance.acquire(run, data);
      expect(reclaimed.ok).toBe(true);
      if (reclaimed.ok) {
        reclaimed.value.release();
      }
    });
  });
});

describe("hook-fast", () => {
  test("exports 900s read timeout matching Rust relay_hook", () => {
    expect(HOOK_READ_TIMEOUT_MS).toBe(900_000);
  });

  test("relays a hook over loopback TCP with exact HTTP/1.1 framing and handles errors", async () => {
    let capturedRawRequest = "";
    const token = "secret-hook-token";

    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      const chunks: Buffer[] = [];
      let headerDone = false;
      let expectedBodyLen = 0;
      let headerEndIdx = -1;

      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        if (!headerDone) {
          headerEndIdx = raw.indexOf("\r\n\r\n");
          if (headerEndIdx !== -1) {
            headerDone = true;
            const headStr = raw.subarray(0, headerEndIdx).toString("utf8");
            const match = /content-length:\s*(\d+)/i.exec(headStr);
            expectedBodyLen = match ? Number(match[1]) : 0;
          }
        }
        if (headerDone && raw.byteLength >= headerEndIdx + 4 + expectedBodyLen) {
          capturedRawRequest = raw.toString("utf8");
          const headStr = raw.subarray(0, headerEndIdx).toString("utf8");
          const firstLine = headStr.split("\r\n")[0] ?? "";
          const reqPath = firstLine.split(" ")[1] ?? "";
          const bodyStr = raw.subarray(headerEndIdx + 4, headerEndIdx + 4 + expectedBodyLen).toString("utf8");

          if (reqPath === `/hook/${token}`) {
            const payload = JSON.parse(bodyStr) as { toolCall?: { name?: string } };
            const replyBody = JSON.stringify({
              decision: "deny",
              reason: payload.toolCall?.name ?? "",
            });
            const resp =
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(replyBody)}\r\nContent-Type: application/json\r\n\r\n${replyBody}`;
            socket.end(resp);
          } else if (reqPath === "/malformed") {
            socket.end("not-an-http-response");
          } else if (reqPath === "/hang") {
            // Leave socket open to trigger timeout
          } else {
            socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("expected TCP address");
    }
    const port = addr.port;

    try {
      // 1. Happy path: 200 OK
      const url = `http://127.0.0.1:${port}/hook/${token}`;
      const reqPayload = '{"toolCall": {"name": "run_command"}}';
      const okRes = await relayHook(url, Buffer.from(reqPayload, "utf8"));
      expect(okRes.ok).toBe(true);
      if (!okRes.ok) throw new Error(okRes.error);
      expect(JSON.parse(okRes.body.toString("utf8"))).toEqual({
        decision: "deny",
        reason: "run_command",
      });

      // Verify exact HTTP/1.1 request framing
      expect(capturedRawRequest).toBe(
        `POST /hook/${token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(reqPayload)}\r\nConnection: close\r\n\r\n${reqPayload}`,
      );

      // 2. Non-200 status (401)
      const unauthorized = await relayHook(`http://127.0.0.1:${port}/hook/wrong`, Buffer.from("{}"));
      expect(unauthorized).toEqual({
        ok: false,
        error: "Neo answered the hook with status 401",
      });

      // 3. Malformed HTTP answer
      const malformed = await relayHook(`http://127.0.0.1:${port}/malformed`, Buffer.from("{}"));
      expect(malformed).toEqual({
        ok: false,
        error: "Neo's answer to the hook is malformed",
      });

      // 4. Read timeout
      const timedOut = await relayHook(`http://127.0.0.1:${port}/hang`, Buffer.from("{}"), 80);
      expect(timedOut).toEqual({
        ok: false,
        error: "Neo did not answer the hook: timed out",
      });

      // 5. Non-HTTP URL
      expect(await relayHook("", Buffer.from("{}"))).toEqual({
        ok: false,
        error: "The hook URL is not http",
      });
      expect(await relayHook("https://127.0.0.1:8080/hook/x", Buffer.from("{}"))).toEqual({
        ok: false,
        error: "The hook URL is not http",
      });

      // 6. End-to-end stdio invocation via subprocess (`runAgyHook`)
      const hookFastModule = path.resolve(import.meta.dir, "../../src/agent/hook-fast.ts");
      const okProc = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { runAgyHook } from ${JSON.stringify(hookFastModule)}; process.exit(await runAgyHook(process.argv[1] ?? ""));`,
          url,
        ],
        {
          stdin: new Response(reqPayload),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const okExit = await okProc.exited;
      const okOut = await new Response(okProc.stdout).text();
      const okErr = await new Response(okProc.stderr).text();
      expect(okExit).toBe(0);
      expect(okErr).toBe("");
      expect(JSON.parse(okOut)).toEqual({ decision: "deny", reason: "run_command" });

      const failProc = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { runAgyHook } from ${JSON.stringify(hookFastModule)}; process.exit(await runAgyHook(process.argv[1] ?? ""));`,
          `http://127.0.0.1:${port}/hook/wrong`,
        ],
        {
          stdin: new Response("{}"),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const failExit = await failProc.exited;
      const failOut = await new Response(failProc.stdout).text();
      const failErr = await new Response(failProc.stderr).text();
      expect(failExit).toBe(1);
      expect(failOut).toBe("");
      expect(failErr.trim()).toBe("Neo answered the hook with status 401");
    } finally {
      server.close();
    }

    // 7. Connection refused after server closes
    const refused = await relayHook(`http://127.0.0.1:${port}/hook/${token}`, Buffer.from("{}"));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.startsWith(`Cannot reach Neo at 127.0.0.1:${port}:`)).toBe(true);
    }
  });
});
