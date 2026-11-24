/**
 * One instance per user. A running instance holds an exclusive lock on a file in the per-user runtime directory, and
 * always one in its data directory. The system releases a lock when its process ends, however it ends, so nothing
 * stale is left behind to judge.
 */

import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import { VERSION } from "../version.ts";

/** The exit status of a second instance. */
export const ALREADY_RUNNING = 3;

/** Metadata published by a running instance in `instance.json`. */
export interface InstanceInfo {
  pid?: number;
  port?: number;
  dataDir?: string;
  version?: string;
  [key: string]: unknown;
}

/** Why an instance may not start. */
export type Refused =
  | { kind: "running"; info: InstanceInfo | null }
  | { kind: "failed"; reason: string };

/** Result of acquiring instance locks. */
export type AcquireResult = { ok: true; value: Instance } | { ok: false; error: Refused };

const LOCK_EX = 2;
const LOCK_NB = 4;

interface PosixLockLib {
  flock(fd: number, operation: number): number;
  errno(): number;
}

let cachedPosixLib: PosixLockLib | undefined;

function readErrno(ptr: Pointer | bigint | null): number {
  if (ptr === null) return 0;
  return read.i32(ptr as Pointer, 0);
}

function getPosixLockLib(): PosixLockLib {
  if (cachedPosixLib !== undefined) {
    return cachedPosixLib;
  }
  if (process.platform === "darwin") {
    const lib = dlopen("libSystem.B.dylib", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    const resolved: PosixLockLib = {
      flock: (fd, op) => lib.symbols.flock(fd, op),
      errno: () => readErrno(lib.symbols.__error()),
    };
    cachedPosixLib = resolved;
    return resolved;
  }

  const lib = dlopen("libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  const resolved: PosixLockLib = {
    flock: (fd, op) => lib.symbols.flock(fd, op),
    errno: () => readErrno(lib.symbols.__errno_location()),
  };
  cachedPosixLib = resolved;
  return resolved;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readInstanceInfo(dir: string): InstanceInfo | null {
  try {
    const text = fs.readFileSync(path.join(dir, "instance.json"), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as InstanceInfo;
    }
    return null;
  } catch {
    return null;
  }
}

type TryLockOutcome =
  | { kind: "locked" }
  | { kind: "wouldBlock" }
  | { kind: "error"; message: string };

function tryFlockExclusive(fd: number): TryLockOutcome {
  if (process.platform === "win32") {
    return { kind: "error", message: "flock is not supported on win32" };
  }
  let lib: PosixLockLib;
  try {
    lib = getPosixLockLib();
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }

  const eagain = os.constants.errno.EAGAIN;
  const ewouldblock = os.constants.errno.EWOULDBLOCK;
  const eintr = os.constants.errno.EINTR;

  for (;;) {
    const rc = lib.flock(fd, LOCK_EX | LOCK_NB);
    if (rc === 0) {
      return { kind: "locked" };
    }
    const errno = lib.errno();
    if (errno === eintr) {
      continue;
    }
    if (errno === ewouldblock || errno === eagain) {
      return { kind: "wouldBlock" };
    }
    let detail = `errno ${errno}`;
    if (errno > 0) {
      try {
        const name = util.getSystemErrorName(-errno);
        const desc = typeof util.getSystemErrorMessage === "function" ? util.getSystemErrorMessage(-errno) : "";
        detail = desc ? `${desc} (${name})` : name;
      } catch {
        // Fallback to numeric errno.
      }
    }
    return { kind: "error", message: detail };
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

interface LockHandle {
  fd?: number;
  winLockPath?: string;
}

function lockDirWindows(dir: string, lockPath: string): { ok: true; handle: LockHandle } | { ok: false; error: Refused } {
  const failed = (message: string): { ok: false; error: Refused } => ({
    ok: false,
    error: { kind: "failed", reason: `Cannot lock ${lockPath}: ${message}` },
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }), "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, handle: { winLockPath: lockPath } };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        return failed(errorMessage(error));
      }
      try {
        const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
        if (typeof raw.pid === "number" && raw.pid !== process.pid && isPidAlive(raw.pid)) {
          return { ok: false, error: { kind: "running", info: readInstanceInfo(dir) } };
        }
      } catch {
        // Stale or unreadable lockfile: remove and retry once.
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException)?.code !== "ENOENT") {
          return { ok: false, error: { kind: "running", info: readInstanceInfo(dir) } };
        }
      }
    }
  }
  return { ok: false, error: { kind: "running", info: readInstanceInfo(dir) } };
}

function releaseLockHandle(handle: LockHandle): void {
  if (handle.fd !== undefined) {
    try {
      fs.closeSync(handle.fd);
    } catch {
      // Ignore close errors.
    }
  }
  if (handle.winLockPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(handle.winLockPath, "utf8")) as { pid?: unknown };
      if (raw.pid === process.pid) {
        fs.unlinkSync(handle.winLockPath);
      }
    } catch {
      // Ignore best-effort cleanup errors.
    }
  }
}

function lockDir(dir: string): { ok: true; handle: LockHandle } | { ok: false; error: Refused } {
  const lockPath = path.join(dir, "instance.lock");
  const failed = (message: string): { ok: false; error: Refused } => ({
    ok: false,
    error: { kind: "failed", reason: `Cannot lock ${lockPath}: ${message}` },
  });

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return failed(errorMessage(error));
  }

  if (process.platform === "win32") {
    return lockDirWindows(dir, lockPath);
  }

  let fd: number;
  try {
    fd = fs.openSync(lockPath, "a+");
  } catch (error) {
    return failed(errorMessage(error));
  }

  const outcome = tryFlockExclusive(fd);
  if (outcome.kind === "locked") {
    return { ok: true, handle: { fd } };
  }

  try {
    fs.closeSync(fd);
  } catch {
    // Ignore close errors while reporting lock failure.
  }

  if (outcome.kind === "wouldBlock") {
    return { ok: false, error: { kind: "running", info: readInstanceInfo(dir) } };
  }
  return failed(outcome.message);
}

/** The locks of the running instance; they are released when `release()` is called or the process ends. */
export class Instance {
  private readonly locks: LockHandle[];
  private readonly infoPath: string;
  private released = false;

  private constructor(locks: LockHandle[], infoPath: string) {
    this.locks = locks;
    this.infoPath = infoPath;
  }

  /** Become the running instance: of this user, unless several are allowed, and of this data directory always. */
  static acquire(perUser: string | null | undefined, dataDir: string): AcquireResult {
    const locks: LockHandle[] = [];
    if (perUser !== undefined && perUser !== null) {
      const first = lockDir(perUser);
      if (!first.ok) {
        return first;
      }
      locks.push(first.handle);
    }

    const second = lockDir(dataDir);
    if (!second.ok) {
      for (const handle of locks) {
        releaseLockHandle(handle);
      }
      return second;
    }
    locks.push(second.handle);

    const infoDir = perUser !== undefined && perUser !== null ? perUser : dataDir;
    return { ok: true, value: new Instance(locks, path.join(infoDir, "instance.json")) };
  }

  /** Say where this instance listens, for a second one to tell its user. */
  publish(port: number, dataDir: string): void {
    const info = JSON.stringify({
      pid: process.pid,
      port,
      dataDir,
      version: VERSION,
    });
    try {
      fs.writeFileSync(this.infoPath, info);
    } catch {
      // Ignore best-effort publish errors, matching Rust `let _ = fs::write(...)`.
    }
  }

  /** Remove published instance metadata while holding locks, then release all lock handles. */
  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    // Remove instance.json first while still holding the locks, matching Rust Drop order.
    try {
      fs.unlinkSync(this.infoPath);
    } catch {
      // Ignore if not published or already removed.
    }
    for (const handle of this.locks) {
      releaseLockHandle(handle);
    }
    this.locks.length = 0;
  }

  [Symbol.dispose](): void {
    this.release();
  }
}
