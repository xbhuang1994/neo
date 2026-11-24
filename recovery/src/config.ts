/**
 * CLI argument, environment variable, and optional JSON config parsing.
 * Completely independent from Neo's business logic and runtime modules.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const VERSION = "0.1.0";

export type EntryMode = "proxy" | "takeover";

export interface DaemonConfig {
  mode: EntryMode;
  host: string;
  port: number;
  internalPort: number;
  token?: string;
  targetBin: string;
  targetArgs: string[];
  targetCwd: string;
  webDir?: string;
  dataDir: string;
  repoDir: string;
  stateDir: string;
  allowMultiple: boolean;
  probeIntervalMs: number;
  probeTimeoutMs: number;
  unhealthyAfterMs: number;
  minFailedProbes: number;
  fastRestartDelayMs: number;
  startupTimeoutMs: number;
  stableProbes: number;
  workerTimeoutMs: number;
  maxAttempts: number;
  cooldownMs: number;
  exhaustedRetryMs: number;
  resetAttemptsAfterMs: number;
  requireReady: boolean;
  workerBin?: string;
  workerModel?: string;
  workerCmd?: string;
  workerArgs: string[];
  logFile?: string;
}

export type CliCommand =
  | { kind: "start"; config: DaemonConfig }
  | { kind: "doctor"; config: DaemonConfig }
  | { kind: "status"; url: string; token?: string }
  | { kind: "version" }
  | { kind: "help" };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const USAGE = `neo-recovery ${VERSION} — Independent watchdog & auto-recovery daemon for Neo

Usage:
  neo-recovery start [options] [-- <extra target args...>]
  neo-recovery doctor [options]
  neo-recovery status [--url <url>] [--token <token>]
  neo-recovery version
  neo-recovery help

Options:
  --config <file>             JSON configuration file (CLI and env override it)
  --mode <proxy|takeover>     Entry-point strategy (default: proxy)
                              proxy: listen on entry port, launch Neo on internal loopback port,
                                     seamlessly show live Recovery Console on outage and /_recovery anytime
                              takeover: launch Neo directly on entry port; bind entry port only in recovery
  --host <host>               Entry-point bind address (default: 127.0.0.1; non-loopback requires token)
  --port <port>               Entry-point port (default: 3082)
  --internal-port <port>      Loopback port for Neo in proxy mode (default: 0 = auto free port)
  --token <token>             Access token (>= 16 chars; also NEO_TOKEN)
  --target-bin <path>         Neo executable (default: auto-discover neo-agent)
  --target-arg <arg>          Target argument (repeatable; replaces default ["serve"])
  --target-cwd <dir>          Working directory for Neo
  --web-dir <dir>             Web build directory passed to neo-agent serve --web-dir
  --data-dir <dir>            Neo data directory with orchestrator.sqlite (also NEO_DATA_DIR)
  --repo-dir <dir>            Neo source repo directory for the recovery worker
  --state-dir <dir>           Independent recovery daemon state & logs directory
  --log-file <path>           Optional Neo service log file to include in repair diagnostics
  --allow-multiple            Allow multiple recovery daemons with different state directories

Sniffer & Recovery Timings:
  --probe-interval <sec>      Health check interval (default: 5)
  --probe-timeout <sec>       Single /api/health probe timeout (default: 5)
  --unhealthy-after <sec>     Continuous downtime before Recovery Mode (default: 60)
  --min-failed-probes <n>     Minimum consecutive failed probes before recovery (default: 3)
  --fast-restart-delay <sec>  Delay before normal restart during brief outage (default: 3)
  --startup-timeout <sec>     Max wait for Neo health after launch/restart (default: 30)
  --stable-probes <n>         Consecutive healthy probes to confirm recovery (default: 2)
  --worker-timeout <sec>      Hard timeout per recovery worker attempt (default: 600)
  --max-attempts <n>          Max consecutive failed recovery attempts before slow retry (default: 3)
  --cooldown <sec>            Base cooldown between failed attempts, exponential backoff (default: 30)
  --exhausted-retry <sec>     Retry interval after max attempts exhausted (default: 900)
  --require-ready             Require /api/health JSON ready === true (default: false)

Worker Overrides (default: read live from Neo's orchestrator.sqlite):
  --worker-bin <path>         Override Antigravity CLI (agy) binary path
  --worker-model <id>         Override worker model id
  --worker-cmd <cmd>          Custom worker executable (receives prompt via stdin & NEO_RECOVERY_* env)
  --worker-arg <arg>          Extra argument for --worker-cmd (repeatable)
`;

function envStr(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function homeDir(): string {
  return envStr("HOME") ?? envStr("USERPROFILE") ?? os.homedir() ?? os.tmpdir();
}

export function defaultNeoDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(homeDir(), "Library", "Application Support", "neo-agent");
  }
  if (process.platform === "win32") {
    const localAppData = envStr("LOCALAPPDATA") ?? path.join(homeDir(), "AppData", "Local");
    return path.join(localAppData, "neo-agent");
  }
  const xdg = envStr("XDG_STATE_HOME");
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir(), ".local", "state");
  return path.join(base, "neo-agent");
}

export function defaultRecoveryStateDir(): string {
  if (process.platform === "darwin") {
    return path.join(homeDir(), "Library", "Application Support", "neo-recovery");
  }
  if (process.platform === "win32") {
    const localAppData = envStr("LOCALAPPDATA") ?? path.join(homeDir(), "AppData", "Local");
    return path.join(localAppData, "neo-recovery");
  }
  const xdg = envStr("XDG_STATE_HOME");
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir(), ".local", "state");
  return path.join(base, "neo-recovery");
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDir(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function isLoopbackHost(host: string): boolean {
  const clean = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (clean === "localhost" || clean === "::1") return true;
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(clean)) {
    const parts = clean.split(".").map(Number);
    return parts.every((n) => n >= 0 && n <= 255);
  }
  return false;
}

function discoverDefaultTargetBin(): string {
  const execBase = path.basename(process.execPath).toLowerCase();
  const exeName = process.platform === "win32" ? "neo-agent.exe" : "neo-agent";
  const siblingTarget =
    execBase !== "bun" && execBase !== "bun.exe"
      ? path.join(path.dirname(process.execPath), exeName)
      : undefined;
  const candidates = [
    envStr("NEO_AGENT_BIN"),
    siblingTarget,
    "/nvme/workspace/neo/backend/dist/neo-agent",
    "/opt/neo-agent/neo-agent",
    path.join(homeDir(), ".local", "bin", exeName),
    path.resolve(exeName),
  ];
  for (const candidate of candidates) {
    if (candidate && isFile(candidate)) {
      return candidate;
    }
  }
  return exeName;
}

function inferRepoDir(targetBin: string): string {
  const resolved = path.isAbsolute(targetBin) ? targetBin : path.resolve(targetBin);
  // Common layout: <repo>/backend/dist/neo-agent
  const distDir = path.dirname(resolved);
  const backendDir = path.dirname(distDir);
  const rootDir = path.dirname(backendDir);
  if (
    path.basename(distDir) === "dist" &&
    path.basename(backendDir) === "backend" &&
    isDir(rootDir)
  ) {
    return rootDir;
  }
  if (isDir("/nvme/workspace/neo")) {
    return "/nvme/workspace/neo";
  }
  return process.cwd();
}

function inferWebDir(repoDir: string, targetBin: string): string | undefined {
  const candidates = [
    path.join(repoDir, "app", "build", "web"),
    path.join(path.dirname(targetBin), "web"),
  ];
  for (const dir of candidates) {
    if (isFile(path.join(dir, "index.html"))) {
      return dir;
    }
  }
  return undefined;
}

interface RawConfigFile {
  mode?: EntryMode;
  host?: string;
  port?: number;
  internalPort?: number;
  token?: string;
  targetBin?: string;
  targetArgs?: string[];
  targetCwd?: string;
  webDir?: string;
  dataDir?: string;
  repoDir?: string;
  stateDir?: string;
  logFile?: string;
  allowMultiple?: boolean;
  probeIntervalSec?: number;
  probeTimeoutSec?: number;
  unhealthyAfterSec?: number;
  minFailedProbes?: number;
  fastRestartDelaySec?: number;
  startupTimeoutSec?: number;
  stableProbes?: number;
  workerTimeoutSec?: number;
  maxAttempts?: number;
  cooldownSec?: number;
  exhaustedRetrySec?: number;
  resetAttemptsAfterSec?: number;
  requireReady?: boolean;
  workerBin?: string;
  workerModel?: string;
  workerCmd?: string;
  workerArgs?: string[];
}

const ALLOWED_CONFIG_KEYS = new Set<string>([
  "mode",
  "host",
  "port",
  "internalPort",
  "token",
  "targetBin",
  "targetArgs",
  "targetCwd",
  "webDir",
  "dataDir",
  "repoDir",
  "stateDir",
  "logFile",
  "allowMultiple",
  "probeIntervalSec",
  "probeTimeoutSec",
  "unhealthyAfterSec",
  "minFailedProbes",
  "fastRestartDelaySec",
  "startupTimeoutSec",
  "stableProbes",
  "workerTimeoutSec",
  "maxAttempts",
  "cooldownSec",
  "exhaustedRetrySec",
  "resetAttemptsAfterSec",
  "requireReady",
  "workerBin",
  "workerModel",
  "workerCmd",
  "workerArgs",
]);

function readConfigFile(filePath: string): ParseResult<RawConfigFile> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `Cannot read config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `${filePath}: expected a JSON object` };
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      return { ok: false, error: `${filePath}: unknown config field "${key}"` };
    }
  }
  return { ok: true, value: obj as RawConfigFile };
}

function parseNumber(text: string, flag: string, min: number, max: number, integer = false): ParseResult<number> {
  const num = Number(text);
  if (!Number.isFinite(num) || num < min || num > max || (integer && !Number.isInteger(num))) {
    return {
      ok: false,
      error: `${flag} expects a ${integer ? "whole " : ""}number between ${min} and ${max}, got ${JSON.stringify(text)}`,
    };
  }
  return { ok: true, value: num };
}

function parseEnvNum(name: string, min: number, max: number, integer = false): ParseResult<number | undefined> {
  const raw = envStr(name);
  if (raw === undefined) return { ok: true, value: undefined };
  return parseNumber(raw, name, min, max, integer);
}

/**
 * Strip `--host` and `--port` flags from target args and inject the desired host/port
 * for Neo `serve` (or substitute `{host}` / `{port}` placeholders if used by a custom target).
 */
export function buildTargetArgs(
  rawArgs: readonly string[],
  host: string,
  port: number,
  webDir?: string,
  explicitDataDir?: string,
): string[] {
  const usesPlaceholders = rawArgs.some((a) => a.includes("{host}") || a.includes("{port}"));
  if (usesPlaceholders) {
    return rawArgs.map((a) => a.replaceAll("{host}", host).replaceAll("{port}", String(port)));
  }

  const out: string[] = [];
  let hasWebDir = false;
  let hasDataDir = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--host" || arg === "--port") {
      i += 1; // skip value
      continue;
    }
    if (arg.startsWith("--host=") || arg.startsWith("--port=")) {
      continue;
    }
    if (arg === "--web-dir" || arg.startsWith("--web-dir=")) {
      hasWebDir = true;
    }
    if (arg === "--data-dir" || arg.startsWith("--data-dir=")) {
      hasDataDir = true;
    }
    out.push(arg);
  }
  if (out.length === 0) {
    out.push("serve");
  }
  if (out[0] === "serve") {
    if (webDir && !hasWebDir) {
      out.push("--web-dir", webDir);
    }
    if (explicitDataDir && !hasDataDir) {
      out.push("--data-dir", explicitDataDir);
    }
    out.push("--host", host, "--port", String(port));
  }
  return out;
}

export function parseCli(args: readonly string[]): ParseResult<CliCommand> {
  if (args.length === 0) {
    return { ok: true, value: { kind: "help" } };
  }
  const first = args[0];
  if (first === "help" || first === "--help" || first === "-h") {
    return { ok: true, value: { kind: "help" } };
  }
  if (first === "version" || first === "--version" || first === "-V") {
    return { ok: true, value: { kind: "version" } };
  }
  if (first === "status") {
    let url = "http://127.0.0.1:3082";
    let token = envStr("NEO_TOKEN");
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === "--url" && i + 1 < args.length) {
        url = args[++i];
      } else if (a.startsWith("--url=")) {
        url = a.slice("--url=".length);
      } else if (a === "--token" && i + 1 < args.length) {
        token = args[++i];
      } else if (a.startsWith("--token=")) {
        token = a.slice("--token=".length);
      } else {
        return { ok: false, error: `Unknown option for status: ${a}` };
      }
    }
    return { ok: true, value: { kind: "status", url, token } };
  }

  let command: "start" | "doctor";
  let startIdx = 1;
  if (first === "start" || first === "doctor") {
    command = first;
  } else if (first.startsWith("-")) {
    command = "start";
    startIdx = 0;
  } else {
    return { ok: false, error: `Unknown command "${first}"; see neo-recovery help` };
  }

  // Parse CLI flags and optional `-- <passthrough target args>`
  let configPath: string | undefined;
  const cli: Partial<RawConfigFile> = {};
  const cliTargetArgs: string[] = [];
  const cliWorkerArgs: string[] = [];
  let passthroughArgs: string[] | undefined;

  for (let i = startIdx; i < args.length; i++) {
    const raw = args[i];
    if (raw === "--") {
      passthroughArgs = args.slice(i + 1);
      break;
    }
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inlineVal = eq === -1 ? undefined : raw.slice(eq + 1);

    const takeVal = (): ParseResult<string> => {
      if (inlineVal !== undefined) return { ok: true, value: inlineVal };
      if (i + 1 >= args.length) return { ok: false, error: `${flag} requires a value` };
      return { ok: true, value: args[++i] };
    };

    switch (flag) {
      case "--config": {
        const v = takeVal();
        if (!v.ok) return v;
        configPath = v.value;
        break;
      }
      case "--mode": {
        const v = takeVal();
        if (!v.ok) return v;
        if (v.value !== "proxy" && v.value !== "takeover") {
          return { ok: false, error: `--mode must be "proxy" or "takeover", got ${JSON.stringify(v.value)}` };
        }
        cli.mode = v.value;
        break;
      }
      case "--host": {
        const v = takeVal();
        if (!v.ok) return v;
        cli.host = v.value;
        break;
      }
      case "--port": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 0, 65535, true);
        if (!n.ok) return n;
        cli.port = n.value;
        break;
      }
      case "--internal-port": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 0, 65535, true);
        if (!n.ok) return n;
        cli.internalPort = n.value;
        break;
      }
      case "--token": {
        const v = takeVal();
        if (!v.ok) return v;
        cli.token = v.value;
        break;
      }
      case "--target-bin": {
        const v = takeVal();
        if (!v.ok) return v;
        cli.targetBin = v.value;
        break;
      }
      case "--target-arg": {
        const v = takeVal();
        if (!v.ok) return v;
        cliTargetArgs.push(v.value);
        break;
      }
      case "--target-cwd": {
        const v = takeVal();
        if (!v.ok) return v;
        cli.targetCwd = v.value;
        break;
      }
      case "--web-dir": {
        const v = takeVal();
        if (!v.ok) return v;
        cli.webDir = v.value;
        break;
      }
      case "--data-dir": {
        const v = takeVal();
        if (!v.ok) return v;
        cli.dataDir = v.value;
        break;
      }
      case "--repo-dir": {
        const v = takeVal();
        if (!v.ok) return v;
        cli.repoDir = v.value;
        break;
      }
      case "--state-dir": {
        const v = takeVal();
        if (!v.ok) return v;
        cli.stateDir = v.value;
        break;
      }
      case "--log-file": {
        const v = takeVal();
        if (!v.ok) return v;
        cli.logFile = v.value;
        break;
      }
      case "--allow-multiple": {
        if (inlineVal !== undefined) return { ok: false, error: `${flag} takes no value` };
        cli.allowMultiple = true;
        break;
      }
      case "--require-ready": {
        if (inlineVal !== undefined) return { ok: false, error: `${flag} takes no value` };
        cli.requireReady = true;
        break;
      }
      case "--probe-interval": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 0.05, 3600);
        if (!n.ok) return n;
        cli.probeIntervalSec = n.value;
        break;
      }
      case "--probe-timeout": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 0.1, 120);
        if (!n.ok) return n;
        cli.probeTimeoutSec = n.value;
        break;
      }
      case "--unhealthy-after": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 0.1, 86400);
        if (!n.ok) return n;
        cli.unhealthyAfterSec = n.value;
        break;
      }
      case "--min-failed-probes": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 1, 1000, true);
        if (!n.ok) return n;
        cli.minFailedProbes = n.value;
        break;
      }
      case "--fast-restart-delay": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 0.05, 600);
        if (!n.ok) return n;
        cli.fastRestartDelaySec = n.value;
        break;
      }
      case "--startup-timeout": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 0.5, 600);
        if (!n.ok) return n;
        cli.startupTimeoutSec = n.value;
        break;
      }
      case "--stable-probes": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 1, 100, true);
        if (!n.ok) return n;
        cli.stableProbes = n.value;
        break;
      }
      case "--worker-timeout": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 1, 7200);
        if (!n.ok) return n;
        cli.workerTimeoutSec = n.value;
        break;
      }
      case "--max-attempts": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 1, 100, true);
        if (!n.ok) return n;
        cli.maxAttempts = n.value;
        break;
      }
      case "--cooldown": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 0.1, 86400);
        if (!n.ok) return n;
        cli.cooldownSec = n.value;
        break;
      }
      case "--exhausted-retry": {
        const v = takeVal();
        if (!v.ok) return v;
        const n = parseNumber(v.value, flag, 0.2, 86400);
        if (!n.ok) return n;
        cli.exhaustedRetrySec = n.value;
        break;
      }
      case "--worker-bin": {
        const v = takeVal();
        if (!v.ok) return v;
        cli.workerBin = v.value;
        break;
      }
      case "--worker-model": {
        const v = takeVal();
        if (!v.ok) return v;
        cli.workerModel = v.value;
        break;
      }
      case "--worker-cmd": {
        const v = takeVal();
        if (!v.ok) return v;
        cli.workerCmd = v.value;
        break;
      }
      case "--worker-arg": {
        const v = takeVal();
        if (!v.ok) return v;
        cliWorkerArgs.push(v.value);
        break;
      }
      default:
        return { ok: false, error: `Unknown option "${flag}"; see neo-recovery help` };
    }
  }

  let fileCfg: RawConfigFile = {};
  const resolvedConfigPath = configPath ?? envStr("NEO_RECOVERY_CONFIG");
  if (resolvedConfigPath) {
    const loaded = readConfigFile(resolvedConfigPath);
    if (!loaded.ok) return loaded;
    fileCfg = loaded.value;
  }

  const envMode = envStr("NEO_RECOVERY_MODE");
  if (envMode && envMode !== "proxy" && envMode !== "takeover") {
    return { ok: false, error: `NEO_RECOVERY_MODE must be "proxy" or "takeover"` };
  }
  const envPort = parseEnvNum("NEO_RECOVERY_PORT", 0, 65535, true);
  if (!envPort.ok) return envPort;
  const envInternalPort = parseEnvNum("NEO_RECOVERY_INTERNAL_PORT", 0, 65535, true);
  if (!envInternalPort.ok) return envInternalPort;
  const envUnhealthy = parseEnvNum("NEO_RECOVERY_UNHEALTHY_AFTER", 0.1, 86400);
  if (!envUnhealthy.ok) return envUnhealthy;
  const envProbeInterval = parseEnvNum("NEO_RECOVERY_PROBE_INTERVAL", 0.05, 3600);
  if (!envProbeInterval.ok) return envProbeInterval;
  const envWorkerTimeout = parseEnvNum("NEO_RECOVERY_WORKER_TIMEOUT", 1, 7200);
  if (!envWorkerTimeout.ok) return envWorkerTimeout;

  const mode: EntryMode = cli.mode ?? (envMode as EntryMode | undefined) ?? fileCfg.mode ?? "proxy";
  const host = cli.host ?? envStr("NEO_RECOVERY_HOST") ?? fileCfg.host ?? "127.0.0.1";
  const port = cli.port ?? envPort.value ?? fileCfg.port ?? 3082;
  const internalPort = cli.internalPort ?? envInternalPort.value ?? fileCfg.internalPort ?? 0;

  const rawToken = cli.token ?? envStr("NEO_TOKEN") ?? fileCfg.token;
  const token = rawToken && rawToken.trim().length > 0 ? rawToken.trim() : undefined;

  if (!isLoopbackHost(host)) {
    if (!token || token.length < 16) {
      return {
        ok: false,
        error: `Listening on non-loopback host ${host} requires an access token of at least 16 characters (--token or NEO_TOKEN)`,
      };
    }
  } else if (token !== undefined && token.length < 16) {
    return {
      ok: false,
      error: "Access token (--token or NEO_TOKEN) must have at least 16 characters",
    };
  }

  const targetBin =
    cli.targetBin ?? envStr("NEO_RECOVERY_TARGET_BIN") ?? fileCfg.targetBin ?? discoverDefaultTargetBin();
  const dataDir = path.resolve(
    cli.dataDir ?? envStr("NEO_DATA_DIR") ?? fileCfg.dataDir ?? defaultNeoDataDir(),
  );
  const repoDir = path.resolve(
    cli.repoDir ?? envStr("NEO_RECOVERY_REPO_DIR") ?? fileCfg.repoDir ?? inferRepoDir(targetBin),
  );
  const targetCwd = path.resolve(
    cli.targetCwd ?? envStr("NEO_RECOVERY_TARGET_CWD") ?? fileCfg.targetCwd ?? repoDir,
  );
  const stateDir = path.resolve(
    cli.stateDir ?? envStr("NEO_RECOVERY_STATE_DIR") ?? fileCfg.stateDir ?? defaultRecoveryStateDir(),
  );
  const rawWebDir = cli.webDir ?? envStr("NEO_RECOVERY_WEB_DIR") ?? fileCfg.webDir ?? inferWebDir(repoDir, targetBin);
  const webDir = rawWebDir ? path.resolve(rawWebDir) : undefined;

  const targetArgs =
    passthroughArgs !== undefined
      ? [...cliTargetArgs, ...passthroughArgs]
      : cliTargetArgs.length > 0
        ? cliTargetArgs
        : fileCfg.targetArgs !== undefined
          ? [...fileCfg.targetArgs]
          : ["serve"];

  const workerArgs =
    cliWorkerArgs.length > 0
      ? cliWorkerArgs
      : fileCfg.workerArgs !== undefined
        ? [...fileCfg.workerArgs]
        : [];

  const envAllowMulti = envStr("NEO_RECOVERY_ALLOW_MULTIPLE") ?? envStr("NEO_ALLOW_MULTIPLE");
  const allowMultiple =
    Boolean(cli.allowMultiple) ||
    Boolean(fileCfg.allowMultiple) ||
    envAllowMulti === "1" ||
    envAllowMulti?.toLowerCase() === "true";

  const config: DaemonConfig = {
    mode,
    host,
    port,
    internalPort,
    token,
    targetBin,
    targetArgs,
    targetCwd,
    webDir,
    dataDir,
    repoDir,
    stateDir,
    allowMultiple,
    probeIntervalMs: Math.round((cli.probeIntervalSec ?? envProbeInterval.value ?? fileCfg.probeIntervalSec ?? 5) * 1000),
    probeTimeoutMs: Math.round((cli.probeTimeoutSec ?? fileCfg.probeTimeoutSec ?? 5) * 1000),
    unhealthyAfterMs: Math.round((cli.unhealthyAfterSec ?? envUnhealthy.value ?? fileCfg.unhealthyAfterSec ?? 60) * 1000),
    minFailedProbes: cli.minFailedProbes ?? fileCfg.minFailedProbes ?? 3,
    fastRestartDelayMs: Math.round((cli.fastRestartDelaySec ?? fileCfg.fastRestartDelaySec ?? 3) * 1000),
    startupTimeoutMs: Math.round((cli.startupTimeoutSec ?? fileCfg.startupTimeoutSec ?? 30) * 1000),
    stableProbes: cli.stableProbes ?? fileCfg.stableProbes ?? 2,
    workerTimeoutMs: Math.round((cli.workerTimeoutSec ?? envWorkerTimeout.value ?? fileCfg.workerTimeoutSec ?? 600) * 1000),
    maxAttempts: cli.maxAttempts ?? fileCfg.maxAttempts ?? 3,
    cooldownMs: Math.round((cli.cooldownSec ?? fileCfg.cooldownSec ?? 30) * 1000),
    exhaustedRetryMs: Math.round((cli.exhaustedRetrySec ?? fileCfg.exhaustedRetrySec ?? 900) * 1000),
    resetAttemptsAfterMs: Math.round((fileCfg.resetAttemptsAfterSec ?? 60) * 1000),
    requireReady: Boolean(cli.requireReady ?? fileCfg.requireReady ?? false),
    workerBin: cli.workerBin ?? envStr("NEO_RECOVERY_WORKER_BIN") ?? fileCfg.workerBin,
    workerModel: cli.workerModel ?? envStr("NEO_RECOVERY_WORKER_MODEL") ?? fileCfg.workerModel,
    workerCmd: cli.workerCmd ?? envStr("NEO_RECOVERY_WORKER_CMD") ?? fileCfg.workerCmd,
    workerArgs,
    logFile: cli.logFile ?? envStr("NEO_RECOVERY_LOG_FILE") ?? fileCfg.logFile,
  };

  return { ok: true, value: { kind: command, config } };
}
