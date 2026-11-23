//! Blocked commands: a folder of stand-ins, first on the `PATH` of every Session and prepare command, that refuse to
//! run the commands the settings name. On Unix a stand-in is a small shell script; on Windows it is a copy of the
//! application's own program, which refuses when started under another name.

import * as fs from "node:fs";
import * as path from "node:path";

/** Marks a stand-in as written by this application. */
const MARKER = "# neo-agent blocked command";

/** The exit status of a refused command, as shells use for "cannot execute". */
export const REFUSED_STATUS = 126;

/** Result of synchronizing blocked command stand-ins. */
export type BlockedSyncResult = { ok: true } | { ok: false; error: string };

/** The folder of stand-ins within the data directory. */
export function workerBin(stateDir: string): string {
  return path.join(stateDir, "worker-bin");
}

/** What a refused command says. */
export function refusal(name: string): string {
  return `${name} is blocked in this installation by the Neo settings; do the work without it.`;
}

/** `PATH` with the folder of stand-ins first (deduplicated). */
export function pathWith(stateDir: string, currentPath?: string): string {
  const own = workerBin(stateDir);
  const raw = currentPath !== undefined ? currentPath : process.env.PATH;
  const parts: string[] = [own];
  if (raw !== undefined && raw.length > 0) {
    for (const entry of raw.split(path.delimiter)) {
      if (entry !== own) {
        parts.push(entry);
      }
    }
  }
  return parts.join(path.delimiter);
}

/** The command name a program was started under, without folder and `.exe`: what a stand-in refuses as. */
export function invokedAs(program: string): string {
  const slash = Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\"));
  const name = slash >= 0 ? program.slice(slash + 1) : program;
  if (name.endsWith(".exe") || name.endsWith(".EXE")) {
    return name.slice(0, -4);
  }
  return name;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function isRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function ours(file: string): boolean {
  if (isWindows()) {
    const ext = path.extname(file).toLowerCase();
    return ext === ".exe" || ext === ".cmd";
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(256);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    const firstNl = head.indexOf("\n");
    if (firstNl < 0) {
      return false;
    }
    const rest = head.slice(firstNl + 1);
    const secondNl = rest.indexOf("\n");
    const secondLine = (secondNl >= 0 ? rest.slice(0, secondNl) : rest).replace(/\r$/, "");
    return secondLine === MARKER;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error.
      }
    }
  }
}

function unixScript(name: string): string {
  const safeMessage = refusal(name).replaceAll("'", "'\\''");
  return `#!/bin/sh\n${MARKER}\necho '${safeMessage}' >&2\nexit ${REFUSED_STATUS}\n`;
}

function writeStandIn(dir: string, name: string, program: string | null | undefined): string {
  if (isWindows()) {
    if (program) {
      const file = path.join(dir, `${name}.exe`);
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore if not present.
      }
      try {
        fs.linkSync(program, file);
      } catch {
        fs.copyFileSync(program, file);
      }
      return file;
    }
    const file = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(file, `@echo ${refusal(name)} 1>&2\r\n@exit /b ${REFUSED_STATUS}\r\n`, "utf8");
    return file;
  }

  const file = path.join(dir, name);
  const content = unixScript(name);

  // Fast idempotency check: avoid rewriting unchanged executable stand-ins.
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && (stat.mode & 0o777) === 0o755 && stat.size === Buffer.byteLength(content, "utf8")) {
      if (fs.readFileSync(file, "utf8") === content) {
        return file;
      }
    }
  } catch {
    // Missing or unreadable — create fresh stand-in below.
  }

  const temporary = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, content, { mode: 0o755 });
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, file);
  return file;
}

/**
 * Make the folder hold a stand-in for each of `names` and none of its own for any other; files it did not write stay.
 */
export function sync(
  stateDir: string,
  names: ReadonlyArray<string>,
  program?: string | null,
): BlockedSyncResult {
  const dir = workerBin(stateDir);
  const failed = (error: unknown): BlockedSyncResult => {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Cannot prepare blocked commands in ${dir}: ${detail}` };
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    const kept = new Set<string>();
    for (const name of names) {
      kept.add(writeStandIn(dir, name, program));
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (!kept.has(file) && (entry.isFile() || (entry.isSymbolicLink() && isRegularFile(file))) && ours(file)) {
        fs.unlinkSync(file);
      }
    }
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Synchronize blocked command stand-ins inside `<dataDir>/worker-bin/` cleanly and idempotently.
 * Convenience wrapper with `(dataDir, programPath, commands)` argument order.
 */
export function syncBlockedCommands(
  dataDir: string,
  programPath: string | null | undefined,
  commands: ReadonlyArray<string>,
): BlockedSyncResult {
  return sync(dataDir, commands, programPath);
}
