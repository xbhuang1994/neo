/**
 * Leak-proof process-group manager for both the supervised Neo process and recovery workers.
 * Spawns children in their own process group on Unix so SIGTERM/SIGKILL cleanly terminates
 * any descendant sub-processes without leaving orphans behind.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export interface SpawnOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  stdinText?: string;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onExit?: (info: ProcessExitInfo) => void;
}

export interface ProcessExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  at: string;
}

const MAX_LINE_CHARS = 16_384;

function pumpLines(stream: Readable, onLine: (line: string) => void): void {
  let pending = "";
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const emitLine = (raw: string) => {
    const clean = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (clean.length === 0) return;
    onLine(clean.length > MAX_LINE_CHARS ? `${clean.slice(0, MAX_LINE_CHARS)}… [truncated]` : clean);
  };

  stream.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    pending += text;
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      emitLine(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
    if (pending.length > MAX_LINE_CHARS * 2) {
      emitLine(pending);
      pending = "";
    }
  });

  const flush = () => {
    pending += decoder.decode();
    if (pending.length > 0) {
      emitLine(pending);
      pending = "";
    }
  };
  stream.once("end", flush);
  stream.once("close", flush);
  stream.on("error", () => {});
}

export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || pid <= 0) return;
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      try {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // ignore
      }
    }
    return;
  }
  if (pid > 1) {
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH or already exited
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // ignore
  }
}

export class ManagedProcess {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  readonly startedAt: string;
  private exited = false;
  private exitInfo: ProcessExitInfo | null = null;
  private readonly exitPromise: Promise<ProcessExitInfo>;
  private stopping: Promise<ProcessExitInfo> | null = null;

  constructor(options: SpawnOptions) {
    this.startedAt = new Date().toISOString();
    const usePipeStdin = options.stdinText !== undefined;
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [usePipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;
    this.pid = child.pid;

    if (usePipeStdin && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdinText, "utf8");
    }
    if (child.stdout && options.onStdoutLine) {
      pumpLines(child.stdout, options.onStdoutLine);
    } else {
      child.stdout?.resume();
    }
    if (child.stderr && options.onStderrLine) {
      pumpLines(child.stderr, options.onStderrLine);
    } else {
      child.stderr?.resume();
    }

    this.exitPromise = new Promise<ProcessExitInfo>((resolve) => {
      const done = (info: ProcessExitInfo) => {
        if (this.exited) return;
        this.exited = true;
        this.exitInfo = info;
        options.onExit?.(info);
        resolve(info);
      };
      child.once("error", (err) => {
        done({
          code: null,
          signal: null,
          error: err.message,
          at: new Date().toISOString(),
        });
      });
      child.once("close", (code, signal) => {
        done({
          code,
          signal,
          at: new Date().toISOString(),
        });
      });
    });
  }

  get isRunning(): boolean {
    return !this.exited;
  }

  get lastExit(): ProcessExitInfo | null {
    return this.exitInfo;
  }

  wait(): Promise<ProcessExitInfo> {
    return this.exitPromise;
  }

  stop(graceMs = 5000): Promise<ProcessExitInfo> {
    if (this.exited && this.exitInfo) {
      return Promise.resolve(this.exitInfo);
    }
    if (this.stopping) {
      return this.stopping;
    }
    this.stopping = (async () => {
      killProcessGroup(this.pid, "SIGTERM");
      try {
        this.child.kill("SIGTERM");
      } catch {
        // ignore
      }
      const winner = await Promise.race([
        this.exitPromise.then(() => "exited" as const),
        new Promise<"timeout">((resolve) => {
          const t = setTimeout(() => resolve("timeout"), graceMs);
          t.unref?.();
        }),
      ]);
      if (winner === "timeout" && !this.exited) {
        killProcessGroup(this.pid, "SIGKILL");
        try {
          this.child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      return await this.exitPromise;
    })();
    return this.stopping;
  }
}

/**
 * Build a safe child PATH that retains standard user tool directories even under minimal systemd environments.
 */
export function enrichedPath(currentPath: string | undefined, extraDirs: readonly string[]): string {
  const sep = process.platform === "win32" ? ";" : ":";
  const parts = (currentPath ?? "").split(sep).filter((p) => p.length > 0);
  const seen = new Set(parts);
  for (const dir of extraDirs) {
    if (dir.length > 0 && !seen.has(dir)) {
      seen.add(dir);
      parts.push(dir);
    }
  }
  return parts.join(sep);
}
