/**
 * The Antigravity CLI runtime behind Sessions: what a Session of each role needs,
 * and how Antigravity provides it.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { key } from "../core/ids.ts";
import {
  AntigravityDriver,
  listModels as kernelListModels,
  mcpServerName,
} from "../kernel/index.ts";
import type {
  AntigravityOptions,
  Driver,
  DriverEvent,
  ToolHost,
  UnboundedChannel,
} from "../kernel/index.ts";
import { errorMessage } from "../kernel/types.ts";
import {
  antigravityLoginCommand,
  inspectAntigravityAccount,
  logoutAntigravity,
} from "./accounts.ts";
import type { AccountStatus, LoginCommand } from "./accounts.ts";
import type { Kernel, RoleModel } from "./kernel-types.ts";

/** What a Session is for. */
export type SessionRole = "orchestrator" | "worker" | "sidecar" | "watchdog";

/** How many subagents a worker may run at once. */
export const MAX_SUBAGENTS = 8;

/** How long the installer may run (10 minutes). */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** What a Session needs from its runtime. */
export interface SessionSpec {
  /** The Session's durable id. */
  sessionId: string;
  /** What it is for. */
  role: SessionRole;
  /** Where it works. */
  cwd: string;
  /** Its whole system prompt, naming the host's tools bare. */
  systemPrompt: string;
  /** The model, or the runtime's default. */
  model?: RoleModel | null;
}

/** A model a role may use. */
export interface ModelOption {
  /** The model id. */
  id: string;
  /** The provider. */
  provider: string;
  /** A display name. */
  name: string;
}

/** Live snapshot of a kernel installation in progress. */
export interface InstallProgress {
  /** Whether the kernel's program is currently being installed. */
  installing: boolean;
  /** The last non-empty progress line printed by the installer, if any. */
  line?: string;
}

/** Internal per-kernel installation tracking record. */
export interface InstallState {
  /** The last cleaned progress line printed by the installer (empty before first line). */
  line: string;
  /** The shared in-flight installation promise when an installer process is active. */
  promise?: Promise<string>;
}

/** Finds the kernel's program on this machine. */
export type Finder = (kernel: Kernel) => string | undefined;

/** The program the kernel runs. */
export function programName(kernel: Kernel): string {
  switch (kernel) {
    case "antigravity":
      return "agy";
  }
}

/** The kernel's name for people. */
export function displayName(kernel: Kernel): string {
  switch (kernel) {
    case "antigravity":
      return "Antigravity CLI";
  }
}

const WORKER_TOOL_KINDS = ["read", "bash", "web", "edit", "write", "task"] as const;
const SIDECAR_TOOL_KINDS = ["read"] as const;
const ORCHESTRATOR_OR_WATCHDOG_TOOL_KINDS = ["read", "bash"] as const;

/** The built-in tool kinds permitted for each Session role. */
export function toolKindsForRole(role: SessionRole): readonly string[] {
  switch (role) {
    case "worker":
      return WORKER_TOOL_KINDS;
    case "sidecar":
      return SIDECAR_TOOL_KINDS;
    case "orchestrator":
    case "watchdog":
      return ORCHESTRATOR_OR_WATCHDOG_TOOL_KINDS;
  }
}

/** The Antigravity runtime note appended to a Session's system prompt. */
export function runtimeNoteForRole(role: SessionRole, hasAppTools: boolean): string {
  const server = mcpServerName();
  const application = hasAppTools
    ? ` Application tools are on MCP server \`${server}\`: call one with \`call_mcp_tool\` passing \`ServerName: "${server}"\`, \`ToolName: "<name>"\`, and \`Arguments: {...}\` (JSON object).`
    : "";
  switch (role) {
    case "worker":
      return `Runtime note: you run in the Antigravity CLI. Tool names above map to \`read_file\`/\`view_file\`, \`grep_search\`, \`find_by_name\`, \`list_dir\`, \`run_command\`, \`edit_file\`/\`replace_file_content\`/\`multi_replace_file_content\`, \`write_file\`/\`write_to_file\`, and \`invoke_subagent\` / \`define_subagent\` / \`manage_subagents\` (plus \`run_workflow\` for Python \`parallel()\` / \`pipeline()\` fan-out workflows; at most 8 concurrent subagents).${application} A command that runs in the background or a subagent wakes you when finished; end your turn to wait instead of polling. Do not use browser or image tools unless the ticket asks for them.`;
    case "sidecar":
      return `Runtime note: you run in the Antigravity CLI. Tool names above map to \`read_file\`/\`view_file\`, \`grep_search\`, \`find_by_name\`, and \`list_dir\`.${application}`;
    case "orchestrator":
    case "watchdog":
      return `Runtime note: you run in the Antigravity CLI. Tool names above map to \`read_file\`/\`view_file\`, \`grep_search\`, \`find_by_name\`, \`list_dir\`, and \`run_command\`.${application} Do not use browser, image, scheduling or web-search tools.`;
  }
}

/** Build `AntigravityOptions` for a Session specification and host tool set. */
export function buildAntigravityOptions(
  program: string,
  spec: SessionSpec,
  host: ToolHost,
  env: Record<string, string> = {},
  hookRelay: readonly string[] = [],
): AntigravityOptions {
  const note = runtimeNoteForRole(spec.role, host.specs().length > 0);
  // The model id names its effort; only an inspection turn, which decides from evidence it is handed, asks for low.
  const thinking = spec.role === "watchdog" ? "low" : undefined;
  return {
    program,
    cwd: spec.cwd,
    systemPrompt: `${spec.systemPrompt}\n\n${note}`,
    tools: [...toolKindsForRole(spec.role)],
    model: spec.model ? spec.model.model : undefined,
    thinking,
    env: { ...env },
    hookRelay: [...hookRelay],
    bridgeId: key([spec.sessionId]).slice(0, 8),
  };
}

/**
 * The official installer of the Antigravity CLI, as a shell command: a script fetched from Google
 * that puts `agy` in the user's own folders, with no administrator rights.
 */
export function installCommand(
  kernel: Kernel,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  let script: string;
  let windowsScript: string;
  switch (kernel) {
    case "antigravity":
      script = "https://antigravity.google/cli/install.sh";
      windowsScript = "https://antigravity.google/cli/install.ps1";
      break;
  }
  if (platform === "win32") {
    const command = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; irm ${windowsScript} | iex`;
    return [
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
    ];
  }
  return ["bash", ["-c", `set -o pipefail; curl -fsSL ${script} | bash`]];
}

/** How long the installer may run, in milliseconds. */
export function installTimeoutMs(_kernel: Kernel): number {
  return INSTALL_TIMEOUT_MS;
}

const UTF8_LOSSY_DECODER = new TextDecoder("utf-8", { fatal: false });
const NEWLINE_BYTE = new Uint8Array([0x0a]);

function isControlCodePoint(cp: number): boolean {
  return (cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f);
}

/** Strip CSI terminal colour codes and control characters from an installer line, then trim. */
export function plainText(text: string): string {
  let out = "";
  let runStart = 0;
  const len = text.length;
  let i = 0;

  while (i < len) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;

    if (cp === 0x1b) {
      if (i > runStart) {
        out += text.slice(runStart, i);
      }
      i += 1;
      if (i < len && text.codePointAt(i) === 0x5b) {
        i += 1;
        while (i < len) {
          const c = text.codePointAt(i)!;
          i += c > 0xffff ? 2 : 1;
          if (c >= 0x40 && c <= 0x7e) {
            break;
          }
        }
      }
      runStart = i;
      continue;
    }

    if (isControlCodePoint(cp)) {
      if (i > runStart) {
        out += text.slice(runStart, i);
      }
      i += width;
      runStart = i;
      continue;
    }

    i += width;
  }

  if (runStart === 0) {
    return text.trim();
  }
  if (runStart < len) {
    out += text.slice(runStart);
  }
  return out.trim();
}

/**
 * Splits an installer's output into lines, at `\n` and at the bare `\r` with which tools redraw
 * their progress, without terminal colour codes or blank lines. An unfinished line stays in `pending`.
 */
export function outputLines(pending: number[], chunk: Uint8Array): string[] {
  const lines: string[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const byte = chunk[i]!;
    if (byte === 0x0a || byte === 0x0d) {
      if (pending.length > 0) {
        const decoded = UTF8_LOSSY_DECODER.decode(Uint8Array.from(pending));
        pending.length = 0;
        const line = plainText(decoded);
        if (line.length > 0) {
          lines.push(line);
        }
      }
    } else {
      pending.push(byte);
    }
  }
  return lines;
}

function headBeforeDigit(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x30 && code <= 0x39) {
      return text.slice(0, i);
    }
  }
  return text;
}

/**
 * The last lines an installer printed, a redrawn progress line kept once: the new line replaces
 * the one before when both read the same up to their first digit.
 */
export class OutputTail {
  static readonly KEEP = 12;
  private readonly lines: string[] = [];

  push(line: string): void {
    const last = this.lines.length > 0 ? this.lines[this.lines.length - 1]! : undefined;
    if (last !== undefined && headBeforeDigit(last) === headBeforeDigit(line)) {
      this.lines.pop();
    }
    this.lines.push(line);
    if (this.lines.length > OutputTail.KEEP) {
      this.lines.shift();
    }
  }

  text(): string {
    return this.lines.join("\n");
  }
}

/** Opens runtimes for Sessions and manages kernel installation and accounts. */
export interface Kernels {
  /** Start nothing yet: build the runtime a Session submits to, which reports to `events` and serves tools from `host`. */
  open(
    kernel: Kernel,
    spec: SessionSpec,
    host: ToolHost,
    events: UnboundedChannel<DriverEvent>,
  ): Driver;
  /** The models the kernel can use here. */
  models(kernel: Kernel): Promise<ModelOption[]>;
  /** Why the kernel cannot run here, such as its program not being installed; `undefined` when it can. */
  unavailable(kernel: Kernel): string | undefined;
  /** Install the kernel's program with its official installer, and say where it went. */
  install?(kernel: Kernel): Promise<string>;
  /** Whether the kernel's program is on this machine, whether or not the kernel can run. */
  installed?(kernel: Kernel): boolean;
  /** Whether the kernel's program is being installed now. */
  installing?(kernel: Kernel): boolean;
  /** The last line the kernel's installer printed while it runs, such as how far its download has come. */
  installProgress?(kernel: Kernel): string | undefined;
  /** Who Antigravity is logged in as. */
  account?(): Promise<AccountStatus>;
  /** The command that logs Antigravity in. */
  login?(): LoginCommand;
  /** Log Antigravity out. */
  logout?(): Promise<void>;
}

/** Default-aware helper matching `Kernels::installed`. */
export function kernelInstalled(kernels: Kernels, kernel: Kernel): boolean {
  return kernels.installed ? kernels.installed(kernel) : kernels.unavailable(kernel) === undefined;
}

/** Default-aware helper matching `Kernels::installing`. */
export function kernelInstalling(kernels: Kernels, kernel: Kernel): boolean {
  return kernels.installing ? kernels.installing(kernel) : false;
}

/** Default-aware helper matching `Kernels::install_progress`. */
export function kernelInstallProgress(kernels: Kernels, kernel: Kernel): string | undefined {
  return kernels.installProgress ? kernels.installProgress(kernel) : undefined;
}

/** Default-aware helper matching `Kernels::install`. */
export function kernelInstall(kernels: Kernels, kernel: Kernel): Promise<string> {
  if (kernels.install) {
    return kernels.install(kernel);
  }
  return Promise.reject(new Error(`${displayName(kernel)} cannot be installed from here`));
}

/** Default-aware helper matching `Kernels::account`. */
export function kernelAccount(kernels: Kernels): Promise<AccountStatus> {
  if (kernels.account) {
    return kernels.account();
  }
  return Promise.reject(new Error("Antigravity CLI account cannot be managed from here"));
}

/** Default-aware helper matching `Kernels::login`. */
export function kernelLogin(kernels: Kernels): LoginCommand {
  if (kernels.login) {
    return kernels.login();
  }
  throw new Error("Antigravity CLI cannot log in from here");
}

/** Default-aware helper matching `Kernels::logout`. */
export function kernelLogout(kernels: Kernels): Promise<void> {
  if (kernels.logout) {
    return kernels.logout();
  }
  return Promise.reject(new Error("Antigravity CLI cannot log out from here"));
}

/** Abstract base class implementing default `Kernels` trait methods (mirrors Rust `trait Kernels`). */
export abstract class BaseKernels implements Kernels {
  abstract open(
    kernel: Kernel,
    spec: SessionSpec,
    host: ToolHost,
    events: UnboundedChannel<DriverEvent>,
  ): Driver;
  abstract models(kernel: Kernel): Promise<ModelOption[]>;
  abstract unavailable(kernel: Kernel): string | undefined;

  async install(kernel: Kernel): Promise<string> {
    throw new Error(`${displayName(kernel)} cannot be installed from here`);
  }

  installed(kernel: Kernel): boolean {
    return this.unavailable(kernel) === undefined;
  }

  installing(_kernel: Kernel): boolean {
    return false;
  }

  installProgress(_kernel: Kernel): string | undefined {
    return undefined;
  }

  async account(): Promise<AccountStatus> {
    throw new Error("Antigravity CLI account cannot be managed from here");
  }

  login(): LoginCommand {
    throw new Error("Antigravity CLI cannot log in from here");
  }

  async logout(): Promise<void> {
    throw new Error("Antigravity CLI cannot log out from here");
  }
}

/** Options for constructing `RealKernels`. */
export interface RealKernelsOptions {
  /** Finds the kernel's program on this machine. */
  find: Finder;
  /** Variables to set for every runtime, on top of the host's environment. */
  env?: Record<string, string>;
  /** The program, with its first arguments, that relays Antigravity's hooks: `neo-agent agy-hook`. */
  hookRelay?: string[];
  /** Override home directory used for Antigravity OAuth token inspection/logout (defaults to HOME/USERPROFILE). */
  homeDir?: string;
  /** Override installer command builder (primarily for testing). */
  installerCommand?: (kernel: Kernel) => [string, string[]];
  /** Override installer timeout in milliseconds (defaults to 10 minutes). */
  installerTimeoutMs?: number;
}

function killInstallerGroup(child: ChildProcessByStdio<null, Readable, Readable>): void {
  const pid = child.pid;
  if (pid !== undefined && pid > 0) {
    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Ignore if taskkill is unavailable or process already exited.
      }
    } else if (pid > 1) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // ESRCH: process group already gone.
      }
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Ignore if already gone.
  }
}

/**
 * The real Antigravity runtime: the `agy` program installed on this machine. It is not bundled
 * and is looked for again whenever it is needed, so one installed while the application runs is
 * used at once.
 */
export class RealKernels implements Kernels {
  /** Finds the kernel's program. */
  readonly find: Finder;
  /** Kernels whose programs are being installed, each with its latest progress line and in-flight promise. */
  readonly installingStates = new Map<Kernel, InstallState>();
  /** Variables to set for every runtime, on top of the host's environment. */
  readonly env: Record<string, string>;
  /** The program, with its first arguments, that relays Antigravity's hooks: `neo-agent agy-hook`. */
  readonly hookRelay: string[];

  private readonly homeDir?: string;
  private readonly installerCommand?: (kernel: Kernel) => [string, string[]];
  private readonly installerTimeoutMs?: number;

  constructor(options: RealKernelsOptions) {
    this.find = options.find;
    this.env = { ...(options.env ?? {}) };
    this.hookRelay = [...(options.hookRelay ?? [])];
    this.homeDir = options.homeDir;
    this.installerCommand = options.installerCommand;
    this.installerTimeoutMs = options.installerTimeoutMs;
  }

  /** The kernel's program, looked for now. */
  program(kernel: Kernel): string | undefined {
    return this.find(kernel);
  }

  /** Return the kernel's program or throw its `unavailable` reason. */
  require(kernel: Kernel): string {
    const found = this.program(kernel);
    if (found === undefined) {
      throw new Error(this.unavailable(kernel) ?? "");
    }
    return found;
  }

  private noteProgress(kernel: Kernel, line: string): void {
    const state = this.installingStates.get(kernel);
    if (state !== undefined) {
      state.line = line;
    }
  }

  private openAntigravity(
    spec: SessionSpec,
    host: ToolHost,
    events: UnboundedChannel<DriverEvent>,
  ): Driver {
    const program = this.require("antigravity");
    const options = buildAntigravityOptions(program, spec, host, this.env, this.hookRelay);
    return new AntigravityDriver(options, host, events);
  }

  open(
    kernel: Kernel,
    spec: SessionSpec,
    host: ToolHost,
    events: UnboundedChannel<DriverEvent>,
  ): Driver {
    switch (kernel) {
      case "antigravity":
        return this.openAntigravity(spec, host, events);
    }
  }

  async models(kernel: Kernel): Promise<ModelOption[]> {
    switch (kernel) {
      case "antigravity": {
        const program = this.require("antigravity");
        const raw = await kernelListModels(program, this.env);
        return raw.map(([id, name]) => ({ id, provider: "antigravity", name }));
      }
    }
  }

  /** Alias of `models(kernel)`. */
  listModels(kernel: Kernel): Promise<ModelOption[]> {
    return this.models(kernel);
  }

  unavailable(kernel: Kernel): string | undefined {
    if (this.program(kernel) === undefined) {
      const installing = this.installing(kernel);
      return `${displayName(kernel)} (${programName(kernel)}) is ${
        installing ? "being installed" : "not installed. Install it to run sessions"
      }`;
    }
    return undefined;
  }

  /**
   * Install the kernel's program with its official installer and return its discovered path.
   * Idempotent when the program is already installed, and shares a single in-flight installer
   * promise when called concurrently.
   */
  install(kernel: Kernel): Promise<string> {
    const active = this.installingStates.get(kernel);
    if (active !== undefined) {
      if (active.promise !== undefined) {
        return active.promise;
      }
      return Promise.reject(new Error(`${displayName(kernel)} is already being installed`));
    }
    const existing = this.program(kernel);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const state: InstallState = { line: "" };
    this.installingStates.set(kernel, state);
    const promise = this.runInstaller(kernel).finally(() => {
      if (this.installingStates.get(kernel) === state) {
        this.installingStates.delete(kernel);
      }
    });
    state.promise = promise;
    return promise;
  }

  installed(kernel: Kernel): boolean {
    return this.program(kernel) !== undefined;
  }

  installing(kernel: Kernel): boolean {
    return this.installingStates.has(kernel);
  }

  installProgress(kernel: Kernel): string | undefined {
    const line = this.installingStates.get(kernel)?.line;
    return line !== undefined && line.length > 0 ? line : undefined;
  }

  /** Structured snapshot of the kernel's current installation status. */
  installState(kernel: Kernel): InstallProgress {
    const state = this.installingStates.get(kernel);
    if (state === undefined) {
      return { installing: false };
    }
    return state.line.length > 0
      ? { installing: true, line: state.line }
      : { installing: true };
  }

  async account(): Promise<AccountStatus> {
    this.require("antigravity");
    return inspectAntigravityAccount(this.homeDir);
  }

  /** Alias of `account()`. */
  accountStatus(): Promise<AccountStatus> {
    return this.account();
  }

  login(): LoginCommand {
    const program = this.require("antigravity");
    return antigravityLoginCommand(program, this.env);
  }

  /** Alias of `login()`. */
  loginCommand(): LoginCommand {
    return this.login();
  }

  async logout(): Promise<void> {
    this.require("antigravity");
    logoutAntigravity(this.homeDir);
  }

  private async runInstaller(kernel: Kernel): Promise<string> {
    const name = displayName(kernel);
    const [program, args] = this.installerCommand
      ? this.installerCommand(kernel)
      : installCommand(kernel);

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(program, args, {
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group on Unix, so that stopping it stops downloads it started too.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      throw new Error(`Cannot run ${program} to install ${name}: ${errorMessage(err)}`);
    }

    const tail = new OutputTail();
    const pump = (stream: Readable): Promise<void> =>
      new Promise<void>((resolve) => {
        const pending: number[] = [];
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          for (const line of outputLines(pending, NEWLINE_BYTE)) {
            this.noteProgress(kernel, line);
            tail.push(line);
          }
          resolve();
        };
        stream.on("data", (chunk: Buffer) => {
          for (const line of outputLines(pending, chunk)) {
            this.noteProgress(kernel, line);
            tail.push(line);
          }
        });
        stream.once("end", finish);
        stream.once("close", finish);
        stream.on("error", finish);
      });

    const stdoutDone = pump(child.stdout);
    const stderrDone = pump(child.stderr);

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => {
          resolve({ code, signal });
        });
      },
    );

    // Wait for spawn confirmation or spawn error.
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        child.off("spawn", onSpawn);
        reject(new Error(`Cannot run ${program} to install ${name}: ${err.message}`));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    child.on("error", () => {});

    const limitMs = this.installerTimeoutMs ?? installTimeoutMs(kernel);
    const run = Promise.all([stdoutDone, stderrDone, exitPromise]).then(([, , status]) => status);

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const status = await Promise.race([
      run,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, limitMs);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      }),
    ]);

    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    if (timedOut || status === null) {
      killInstallerGroup(child);
      try {
        child.stdout.destroy();
      } catch {
        // ignore
      }
      try {
        child.stderr.destroy();
      } catch {
        // ignore
      }
      const minutes = Math.floor(limitMs / 60_000);
      throw new Error(
        `Installing ${name} took longer than ${minutes} minutes and was stopped`,
      );
    }

    if (status.code !== 0 || status.signal !== null) {
      const statusLabel =
        status.code !== null
          ? `exit status: ${status.code}`
          : `signal: ${status.signal ?? "unknown"}`;
      throw new Error(`Installing ${name} failed (${statusLabel}):\n${tail.text()}`);
    }

    const found = this.program(kernel);
    if (found === undefined) {
      throw new Error(
        `The ${name} installer finished, but its program (${programName(kernel)}) was not found where it installs itself`,
      );
    }
    return found;
  }
}
