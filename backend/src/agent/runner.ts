/**
 * Full CLI runner for `serve`, `desktop-sidecar`, `doctor`, `version`, and `--help`.
 * Loaded lazily by `src/main.ts` so fast-path `worker-bin` and `agy-hook` invocations
 * pay zero module load cost.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { App, defaultTimings, type Machine } from "../app/app.ts";
import * as blocked from "../app/blocked.ts";
import { displayName, programName, RealKernels } from "../app/kernels.ts";
import { parseSettings, type Kernel } from "../app/settings.ts";
import { Protocol } from "../app/wechat_protocol.ts";
import { isLoopback, serve, type Access } from "../http/index.ts";
import { VERSION } from "../version.ts";
import { ConfigFile, parse, USAGE, type Common, type Serve, type Sidecar } from "./cli.ts";
import { ALREADY_RUNNING, Instance } from "./instance.ts";
import { defaultDataDir, findRuntime, findWeb, installDirs, onPath, programDir, runtimeDir } from "./paths.ts";

const DEFAULT_PORT = 3082;

function log(message: string): void {
  process.stderr.write(`[neo-agent] ${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Plan {
  dataDir: string;
  allowMultiple: boolean;
  host: string;
  port: number;
  token?: string;
  webDir?: string;
  initSettings?: string;
}

function envPath(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function resolveCommon(common: Common, config: ConfigFile): [string, boolean] {
  const dataDir = path.resolve(
    common.dataDir ?? envPath("NEO_DATA_DIR") ?? config.dataDir ?? defaultDataDir(),
  );
  const envMultiple = process.env.NEO_ALLOW_MULTIPLE;
  const allowMultiple =
    common.allowMultiple ||
    (envMultiple !== undefined && (envMultiple === "1" || envMultiple.toLowerCase() === "true"));
  return [dataDir, allowMultiple];
}

function selfExecutable(): string {
  // When running as a compiled Bun standalone binary, process.execPath IS neo-agent.
  // When running via `bun run src/main.ts`, prefer process.execPath + script path for hooks.
  return process.execPath;
}

function isCompiledStandalone(): boolean {
  const execBase = path.basename(process.execPath).toLowerCase();
  if (execBase !== "bun" && execBase !== "bun.exe") {
    return true;
  }
  const arg1 = process.argv[1];
  return !arg1 || arg1.startsWith("/$bunfs/") || arg1.startsWith("B:\\~BUN\\");
}

function selfHookRelay(): string[] {
  if (isCompiledStandalone()) {
    return [process.execPath, "agy-hook"];
  }
  const entry = process.argv[1];
  return entry ? [process.execPath, "run", entry, "agy-hook"] : [process.execPath, "agy-hook"];
}

function buildKernels(plan: Plan): RealKernels {
  let cached: string | undefined;
  const find = (kernel: Kernel): string | undefined => {
    if (cached !== undefined) {
      try {
        if (fs.statSync(cached).isFile()) {
          return cached;
        }
      } catch {
        cached = undefined;
      }
    }
    const name = programName(kernel);
    const found = findRuntime(name, envPath("NEO_AGY_BIN"), process.env.PATH, installDirs());
    cached = found;
    return found;
  };
  const env: Record<string, string> = {
    PATH: blocked.pathWith(plan.dataDir),
  };
  return new RealKernels({
    find,
    env,
    hookRelay: selfHookRelay(),
  });
}

function askedToStop(parentClosed?: Promise<void>): Promise<string> {
  return new Promise<string>((resolve) => {
    let done = false;
    const finish = (why: string) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(why);
    };
    const onInt = () => finish("interrupted");
    const onTerm = () => finish("terminated");
    const onHup = () => finish("hung up");

    const cleanup = () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      if (process.platform !== "win32") {
        process.off("SIGHUP", onHup);
      }
    };

    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    if (process.platform !== "win32") {
      process.on("SIGHUP", onHup);
    }
    if (parentClosed) {
      void parentClosed.then(() => finish("the desktop app closed"));
    }
  });
}

async function runServer(plan: Plan, sidecar: boolean, parentClosed?: Promise<void>): Promise<number> {
  try {
    fs.mkdirSync(plan.dataDir, { recursive: true });
  } catch (error) {
    process.stderr.write(`Cannot create ${plan.dataDir}: ${errorMessage(error)}\n`);
    return 1;
  }

  const perUser = plan.allowMultiple ? null : runtimeDir();
  const acquired = Instance.acquire(perUser, plan.dataDir);
  if (!acquired.ok) {
    if (acquired.error.kind === "running") {
      const port = acquired.error.info?.port;
      const place = typeof port === "number" ? ` on port ${port}` : "";
      process.stderr.write(
        `Neo is already running${place}. Only one instance runs per user; pass --allow-multiple with another --data-dir to run a second one.\n`,
      );
      return ALREADY_RUNNING;
    }
    process.stderr.write(`${acquired.error.reason}\n`);
    return 1;
  }
  const instance = acquired.value;

  try {
    const kernels = buildKernels(plan);
    const name = displayName("antigravity");
    const program = kernels.program("antigravity");
    const problem = kernels.unavailable("antigravity");
    if (program !== undefined && problem === undefined) {
      log(`${name}: ${program}`);
    } else {
      log(`${name}: ${problem ?? ""}`);
    }

    const machine: Machine = {
      stateDir: plan.dataDir,
      wechat: new Protocol(),
      program: isCompiledStandalone() ? selfExecutable() : undefined,
    };
    const app = App.open(machine, kernels, defaultTimings());

    if (plan.initSettings !== undefined && app.store.get<number>("settings-revision") === undefined) {
      let text: string;
      try {
        text = fs.readFileSync(plan.initSettings, "utf8");
      } catch (error) {
        process.stderr.write(`Cannot read ${plan.initSettings}: ${errorMessage(error)}\n`);
        await app.stop();
        app.close();
        return 1;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        process.stderr.write(`${plan.initSettings}: ${errorMessage(error)}\n`);
        await app.stop();
        app.close();
        return 1;
      }
      try {
        const parsed = parseSettings(value);
        app.saveSettings(parsed, "internal", "init");
      } catch (error) {
        process.stderr.write(`${plan.initSettings}: ${errorMessage(error)}\n`);
        await app.stop();
        app.close();
        return 1;
      }
      log(`Started from the settings in ${plan.initSettings}`);
    }

    await app.start();

    const access: Access = {
      token: plan.token,
      webDir: plan.webDir,
    };
    let server;
    try {
      server = await serve(app, plan.host, plan.port, access);
    } catch (error) {
      await app.stop();
      app.close();
      process.stderr.write(`${errorMessage(error)}\n`);
      return 1;
    }

    const port = server.addr.port;
    instance.publish(port, plan.dataDir);
    const shown = isLoopback(plan.host) ? "127.0.0.1" : plan.host;
    process.stdout.write(
      `${JSON.stringify({
        port,
        pid: process.pid,
        version: VERSION,
        url: `http://${shown}:${port}/`,
      })}\n`,
    );
    log(`Listening on http://${plan.host}:${port}/ — data in ${plan.dataDir}`);
    if (!sidecar) {
      if (plan.webDir) {
        log(`Serving the web app from ${plan.webDir}`);
      } else {
        log("The web app's files were not found; only the API is served (see --web-dir)");
      }
    }

    const why = await askedToStop(parentClosed);
    log(`Stopping: ${why}`);
    await server.shutdown();
    await app.stop();
    app.close();
    return 0;
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  } finally {
    instance.release();
  }
}

function versionOf(program: string): string {
  try {
    const out = spawnSync(program, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 5_000,
    });
    if (out.error) {
      return `cannot run: ${out.error.message}`;
    }
    if (out.status === 0) {
      return (out.stdout ?? "").split(/\r?\n/)[0]?.trim() ?? "";
    }
    return `exited with exit status: ${out.status ?? "signal"}`;
  } catch (error) {
    return `cannot run: ${errorMessage(error)}`;
  }
}

function runDoctor(options: Common): number {
  const [dataDir] = resolveCommon(options, ConfigFile.default());
  const plan: Plan = {
    dataDir,
    allowMultiple: true,
    host: "",
    port: 0,
  };
  const kernels = buildKernels(plan);
  const progDir = programDir();
  process.stdout.write(`Neo ${VERSION}\n`);
  process.stdout.write(`Data directory:   ${plan.dataDir}\n`);
  process.stdout.write(`Instance lock:    ${runtimeDir()}\n`);

  const name = `${displayName("antigravity")}:`.padEnd(18, " ");
  const program = kernels.program("antigravity");
  const problem = kernels.unavailable("antigravity");
  let usable = false;
  if (program !== undefined && problem === undefined) {
    process.stdout.write(`${name}ok — ${program} (${versionOf(program)})\n`);
    usable = true;
  } else {
    process.stdout.write(`${name}missing — ${problem ?? ""}\n`);
  }

  const git = onPath("git", process.env.PATH);
  if (git) {
    process.stdout.write(`git:              ok — ${git} (${versionOf(git)})\n`);
  } else {
    process.stdout.write("git:              missing — workers that use git need it installed\n");
  }

  const web = findWeb(progDir);
  if (web) {
    process.stdout.write(`Web app:          ${web}\n`);
  } else {
    process.stdout.write("Web app:          not found beside the program (serve --web-dir <dir> names it)\n");
  }

  if (!usable) {
    process.stdout.write(
      "Antigravity CLI (agy) cannot run: install it (the app's settings can install it), or set NEO_AGY_BIN.\n",
    );
    return 1;
  }
  return 0;
}

function buildServePlan(options: Serve): { ok: true; plan: Plan } | { ok: false; error: string } {
  let config = ConfigFile.default();
  if (options.config !== undefined) {
    const read = ConfigFile.read(options.config);
    if (!read.ok) return { ok: false, error: read.error };
    config = read.value;
  }
  const [dataDir, allowMultiple] = resolveCommon(options.common, config);
  const rawToken = options.token ?? process.env.NEO_TOKEN ?? config.token;
  const trimmedToken = rawToken?.trim();
  const token = trimmedToken && trimmedToken.length > 0 ? trimmedToken : undefined;

  const explicitWeb = options.webDir ?? config.webDir;
  const webDir = explicitWeb ? path.resolve(explicitWeb) : findWeb(programDir());
  if (webDir !== undefined) {
    let hasIndex = false;
    try {
      hasIndex = fs.statSync(path.join(webDir, "index.html")).isFile();
    } catch {
      hasIndex = false;
    }
    if (!hasIndex) {
      return { ok: false, error: `${webDir} holds no web app (index.html is missing)` };
    }
  }

  return {
    ok: true,
    plan: {
      dataDir,
      allowMultiple,
      host: options.host ?? config.host ?? "127.0.0.1",
      port: options.port ?? config.port ?? DEFAULT_PORT,
      token,
      webDir,
      initSettings: options.initSettings,
    },
  };
}

async function buildSidecarPlan(
  options: Sidecar,
): Promise<{ ok: true; plan: Plan; parentClosed: Promise<void> } | { ok: false; error: string }> {
  if (!options.tokenStdin) {
    return { ok: false, error: "desktop-sidecar takes its access token with --token-stdin" };
  }

  let resolveClosed!: () => void;
  const parentClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const firstLine = await new Promise<{ ok: true; line: string } | { ok: false; error: string }>((resolve) => {
    let gotFirst = false;
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (!gotFirst) {
        gotFirst = true;
        resolve({ ok: true, line });
      }
    });
    rl.on("close", () => {
      if (!gotFirst) {
        gotFirst = true;
        resolve({ ok: true, line: "" });
      }
      resolveClosed();
    });
    rl.on("error", (err) => {
      if (!gotFirst) {
        gotFirst = true;
        resolve({ ok: false, error: `Cannot read the access token: ${errorMessage(err)}` });
      }
      resolveClosed();
    });
  });

  if (!firstLine.ok) {
    return firstLine;
  }
  const token = firstLine.line.trim();
  if (token.length < 16) {
    return { ok: false, error: "The access token on standard input must have at least 16 characters" };
  }
  const [dataDir, allowMultiple] = resolveCommon(options.common, ConfigFile.default());
  return {
    ok: true,
    plan: {
      dataDir,
      allowMultiple,
      host: "127.0.0.1",
      port: options.port,
      token,
    },
    parentClosed,
  };
}

export async function runCli(args: readonly string[]): Promise<number> {
  const parsed = parse(args);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  const command = parsed.value;
  switch (command.kind) {
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case "version":
      process.stdout.write(`neo-agent ${VERSION}\n`);
      return 0;
    case "doctor":
      return runDoctor(command.options);
    case "serve": {
      const planResult = buildServePlan(command.options);
      if (!planResult.ok) {
        process.stderr.write(`${planResult.error}\n`);
        return 2;
      }
      return await runServer(planResult.plan, false);
    }
    case "sidecar": {
      const planResult = await buildSidecarPlan(command.options);
      if (!planResult.ok) {
        process.stderr.write(`${planResult.error}\n`);
        return 2;
      }
      return await runServer(planResult.plan, true, planResult.parentClosed);
    }
  }
}
