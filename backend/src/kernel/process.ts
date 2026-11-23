/**
 * A runtime child process that speaks newline-delimited JSON over its standard input and output.
 *
 * The child leads its own process group (`detached: true` on Unix), so closing it also ends
 * whatever subprocesses it started.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { UnboundedChannel } from "./types.ts";

/** What to run. */
export interface Launch {
  /** The program. */
  program: string;
  /** Its arguments. */
  args?: string[];
  /** Its working directory. */
  cwd: string;
  /** Variables to set on top of the host's environment. */
  env?: Record<string, string>;
  /** Variables of the host's environment the child must not inherit. */
  envRemove?: string[];
}

/** What a child reports. */
export type Line =
  | { readonly type: "json"; readonly value: unknown }
  | { readonly type: "exited"; readonly error?: string };

/** How much of the child's standard error is kept for an error message. */
const STDERR_TAIL = 2000;

interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function waitWithTimeout<T>(promise: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  if (ms <= 0) {
    return Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      Promise.resolve({ timedOut: true as const }),
    ]);
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ timedOut: true });
      }
    }, ms);
    // Do not let a short grace timer pin the process open if everything else finishes.
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    promise.then((value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      }
    });
  });
}

/** End every process of a child's group. */
function terminateGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    if (pid > 0) {
      try {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Ignore if already gone or taskkill unavailable.
      }
    }
    return;
  }
  if (pid > 1) {
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH: process group already gone.
    }
  }
}

/** Bounded stderr tail accumulator with O(1) amortized append and bounded memory. */
class StderrTail {
  private readonly chunks: string[] = [];
  private totalChars = 0;

  push(text: string): void {
    if (text.length === 0) return;
    this.chunks.push(text);
    this.totalChars += text.length;
    if (this.totalChars > STDERR_TAIL * 2) {
      let drop = this.totalChars - STDERR_TAIL;
      let removeCount = 0;
      while (removeCount < this.chunks.length && this.chunks[removeCount]!.length <= drop) {
        drop -= this.chunks[removeCount]!.length;
        this.totalChars -= this.chunks[removeCount]!.length;
        removeCount++;
      }
      if (removeCount > 0) {
        this.chunks.splice(0, removeCount);
      }
      if (drop > 0 && this.chunks.length > 0) {
        const first = this.chunks[0]!;
        let cut = drop;
        // Avoid splitting a UTF-16 surrogate pair.
        if (cut < first.length) {
          const code = first.charCodeAt(cut);
          if (code >= 0xdc00 && code <= 0xdfff) {
            cut += 1;
          }
        }
        this.chunks[0] = first.slice(cut);
        this.totalChars -= cut;
      }
    }
  }

  text(): string {
    const joined = this.chunks.join("");
    if (joined.length <= STDERR_TAIL) {
      return joined.trim();
    }
    let cut = joined.length - STDERR_TAIL;
    const code = joined.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff) {
      cut += 1;
    }
    return joined.slice(cut).trim();
  }
}

/** A running child and the pipe to its standard input. */
export class Proc {
  private stdin: Writable | null;
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly childPid: number;
  private closing = false;
  private exited = false;
  private readonly exitPromise: Promise<ExitStatus>;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
    pid: number,
    exitPromise: Promise<ExitStatus>,
  ) {
    this.child = child;
    this.stdin = child.stdin;
    this.childPid = pid;
    this.exitPromise = exitPromise;
    this.exitPromise.then(() => {
      this.exited = true;
    });
  }

  /** Start the child; its output lines and its exit arrive on the returned channel. */
  static async spawn(launch: Launch): Promise<{ proc: Proc; lines: UnboundedChannel<Line> }> {
    const childEnv: Record<string, string | undefined> = { ...process.env };
    if (launch.envRemove) {
      for (const name of launch.envRemove) {
        delete childEnv[name];
      }
    }
    if (launch.env) {
      for (const [key, value] of Object.entries(launch.env)) {
        childEnv[key] = value;
      }
    }

    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(launch.program, launch.args ?? [], {
        cwd: launch.cwd,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot start ${launch.program}: ${msg}`);
    }

    // Prevent unhandled EPIPE errors on stdin when the child dies mid-write.
    child.stdin.on("error", () => {});

    const lines = new UnboundedChannel<Line>();
    const stderrTail = new StderrTail();

    let resolveExit!: (status: ExitStatus) => void;
    const exitPromise = new Promise<ExitStatus>((resolve) => {
      resolveExit = resolve;
    });
    child.once("exit", (code, signal) => {
      resolveExit({ code, signal });
    });

    // Attach streaming stdout reader synchronously before awaiting "spawn" so no output is missed.
    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutPending = "";
    const emitStdoutLine = (rawLine: string): void => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) return;
      try {
        const value: unknown = JSON.parse(line);
        lines.send({ type: "json", value });
      } catch {
        // Ignore non-JSON lines, matching Rust `Proc::spawn`.
      }
    };

    const stdoutEnded = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const rest = stdoutPending + stdoutDecoder.end();
        stdoutPending = "";
        if (rest.length > 0) {
          emitStdoutLine(rest);
        }
        resolve();
      };
      child.stdout.on("data", (chunk: Buffer) => {
        const text = stdoutDecoder.write(chunk);
        if (text.length === 0) return;
        let searchFrom = 0;
        let nl = text.indexOf("\n", searchFrom);
        if (nl === -1) {
          stdoutPending += text;
          return;
        }
        // First newline finishes any buffered partial line.
        emitStdoutLine(stdoutPending + text.slice(0, nl));
        stdoutPending = "";
        searchFrom = nl + 1;
        while ((nl = text.indexOf("\n", searchFrom)) !== -1) {
          emitStdoutLine(text.slice(searchFrom, nl));
          searchFrom = nl + 1;
        }
        if (searchFrom < text.length) {
          stdoutPending = text.slice(searchFrom);
        }
      });
      child.stdout.once("end", finish);
      child.stdout.once("close", finish);
      child.stdout.on("error", finish);
    });

    // Attach bounded stderr reader synchronously before awaiting "spawn".
    const stderrDecoder = new StringDecoder("utf8");
    const stderrEnded = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const rest = stderrDecoder.end();
        if (rest.length > 0) {
          stderrTail.push(rest);
        }
        resolve();
      };
      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail.push(stderrDecoder.write(chunk));
      });
      child.stderr.once("end", finish);
      child.stderr.once("close", finish);
      child.stderr.on("error", finish);
    });

    // Wait for spawn confirmation or synchronous/async spawn failure.
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        child.off("spawn", onSpawn);
        reject(new Error(`Cannot start ${launch.program}: ${err.message}`));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    // Ignore subsequent post-spawn errors on the child emitter (handled via exit status).
    child.on("error", () => {});

    const proc = new Proc(child, child.pid ?? 0, exitPromise);

    // Emit Exited only once stdout, stderr, and child exit have all completed.
    void Promise.all([stdoutEnded, stderrEnded, exitPromise]).then(([, , status]) => {
      const succeeded = status.code === 0 && status.signal === null;
      const failed = !proc.closing && !succeeded;
      if (failed) {
        const tail = stderrTail.text();
        const codeLabel = status.code !== null ? `exit code ${status.code}` : "a signal";
        const error =
          tail.length === 0
            ? `The runtime ended with ${codeLabel}`
            : `The runtime ended with ${codeLabel}: ${tail}`;
        lines.send({ type: "exited", error });
      } else {
        lines.send({ type: "exited" });
      }
      lines.close();
    });

    return { proc, lines };
  }

  /** The child's process id, which is also its process group on Unix. */
  pid(): number {
    return this.childPid;
  }

  /** Write one JSON value as a line to the child. */
  send(value: unknown): Promise<void> {
    const payload = Buffer.from(JSON.stringify(value) + "\n", "utf8");
    const run = async (): Promise<void> => {
      const pipe = this.stdin;
      if (pipe === null || pipe.destroyed || pipe.writableEnded) {
        throw new Error("The runtime's input is closed");
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          cleanup();
          reject(new Error(`Cannot write to the runtime: ${err.message}`));
        };
        const cleanup = () => {
          pipe.off("error", onError);
        };
        pipe.once("error", onError);
        pipe.write(payload, (err?: Error | null) => {
          cleanup();
          if (err) {
            reject(new Error(`Cannot write to the runtime: ${err.message}`));
          } else {
            resolve();
          }
        });
      });
    };

    const next = this.writeChain.then(run, run);
    this.writeChain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /**
   * End the child: close its input, give it `graceMs` to leave, then terminate its whole
   * process group (SIGTERM -> short grace -> SIGKILL fallback, plus Windows `taskkill`).
   */
  async close(graceMs: number): Promise<void> {
    this.closing = true;
    const pipe = this.stdin;
    this.stdin = null;
    if (pipe !== null && !pipe.destroyed && !pipe.writableEnded) {
      try {
        pipe.end();
      } catch {
        // ignore
      }
    }

    if (!this.exited) {
      const waited = await waitWithTimeout(this.exitPromise, graceMs);
      if (waited.timedOut && !this.exited) {
        terminateGroup(this.childPid, "SIGTERM");
        try {
          this.child.kill("SIGTERM");
        } catch {
          // ignore
        }
        const termGrace = graceMs <= 0 ? 0 : Math.min(100, Math.max(20, Math.floor(graceMs / 4)));
        const afterTerm = await waitWithTimeout(this.exitPromise, termGrace);
        if (afterTerm.timedOut && !this.exited) {
          terminateGroup(this.childPid, "SIGKILL");
          try {
            this.child.kill("SIGKILL");
          } catch {
            // ignore
          }
          await this.exitPromise;
        }
      }
    }

    // Even when the child exited cleanly (or on SIGTERM), end any lingering subprocesses in its group.
    terminateGroup(this.childPid, "SIGKILL");
  }
}
