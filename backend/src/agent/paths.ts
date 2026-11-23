/**
 * Where things are on this machine: the per-user data directory, the place of the instance lock, the Antigravity CLI
 * runtime, and the web app's files.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function envVar(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function home(): string {
  return envVar("HOME") ?? envVar("USERPROFILE") ?? os.tmpdir();
}

/**
 * The per-user data directory: `~/Library/Application Support/neo-agent` on macOS, `%LOCALAPPDATA%\neo-agent` on
 * Windows, and `$XDG_STATE_HOME/neo-agent` (by default `~/.local/state/neo-agent`) elsewhere.
 */
export function defaultDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(home(), "Library", "Application Support", "neo-agent");
  }
  if (process.platform === "win32") {
    const localAppData = envVar("LOCALAPPDATA") ?? path.join(home(), "AppData", "Local");
    return path.join(localAppData, "neo-agent");
  }
  const xdg = envVar("XDG_STATE_HOME");
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home(), ".local", "state");
  return path.join(base, "neo-agent");
}

/**
 * Where the per-user instance lock is kept: one place per user, whatever data directory an instance uses.
 */
export function runtimeDir(): string {
  const explicit = envVar("NEO_RUNTIME_DIR");
  if (explicit) {
    return explicit;
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    return path.join(defaultDataDir(), "run");
  }
  const xdg = envVar("XDG_RUNTIME_DIR");
  if (xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, "neo-agent");
  }
  const user = process.env.USER ?? process.env.LOGNAME ?? "user";
  return path.join(os.tmpdir(), `neo-agent-${user}`);
}

function parentDir(dirPath: string): string | undefined {
  if (!dirPath) return undefined;
  const parent = path.dirname(dirPath);
  if (parent === dirPath) return undefined;
  return parent;
}

/** The folder the running program is in. */
export function programDir(): string | undefined {
  const program = process.execPath;
  if (!program) return undefined;
  let resolved = program;
  try {
    // A link to the program, as package managers make, counts as where it really is.
    resolved = fs.realpathSync(program);
  } catch {
    // Keep original path when canonicalization fails.
  }
  return parentDir(resolved);
}

/**
 * The folders, relative to the program, where an installation keeps what it bundles: beside the program, one level
 * up, and in a macOS app bundle's resources.
 */
function bundled(progDir: string, folder: string): string[] {
  const places = [path.join(progDir, folder)];
  const parent = parentDir(progDir);
  if (parent !== undefined) {
    places.push(path.join(parent, folder));
    places.push(path.join(parent, "Resources", folder));
  }
  return places;
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function executable(filePath: string): boolean {
  try {
    const info = fs.statSync(filePath);
    if (!info.isFile()) return false;
    if (process.platform !== "win32") {
      return (info.mode & 0o111) !== 0;
    }
    return true;
  } catch {
    return false;
  }
}

function candidateNames(name: string): string[] {
  if (process.platform === "win32") {
    return [`${name}.exe`, `${name}.cmd`, name];
  }
  return [name];
}

function splitPaths(pathEnv: string): string[] {
  if (process.platform !== "win32") {
    return pathEnv.split(":");
  }
  // Match Rust std::env::split_paths on Windows: `;` separates entries unless quoted with `"`.
  const dirs: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < pathEnv.length; i++) {
    const ch = pathEnv[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ";" && !inQuotes) {
      dirs.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  dirs.push(current);
  return dirs;
}

function findInDirs(name: string, dirs: readonly string[]): string | undefined {
  const names = candidateNames(name);
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    for (const file of names) {
      const candidate = path.join(dir, file);
      if (executable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** A program on a `PATH`. */
export function onPath(name: string, pathEnv: string | undefined | null): string | undefined {
  if (pathEnv === undefined || pathEnv === null || pathEnv.length === 0) {
    return undefined;
  }
  return findInDirs(name, splitPaths(pathEnv));
}

/**
 * Where the Antigravity CLI official installer puts `agy`: `~/.local/bin` on macOS and Linux; on Windows
 * `%LOCALAPPDATA%\agy\bin` and `%USERPROFILE%\.local\bin`.
 */
export function installDirs(): string[] {
  const localBin = path.join(home(), ".local", "bin");
  if (process.platform !== "win32") {
    return [localBin];
  }
  const appData = envVar("LOCALAPPDATA") ?? path.join(home(), "AppData", "Local");
  return [path.join(appData, "agy", "bin"), localBin];
}

/**
 * A runtime program: the one the environment names, else the one on `PATH`, else the one where its installer puts
 * it, which a service's `PATH` may leave out. Nothing is bundled.
 */
export function findRuntime(
  name: string,
  named: string | undefined | null,
  pathEnv: string | undefined | null,
  dirs: readonly string[],
): string | undefined {
  if (named !== undefined && named !== null) {
    // A name that does not exist is a mistake to report, not a reason to look elsewhere.
    return executable(named) ? named : undefined;
  }
  return onPath(name, pathEnv) ?? findInDirs(name, dirs);
}

/** The web app's files, when an installation has them beside the program. */
export function findWeb(progDir: string | undefined | null): string | undefined {
  if (progDir === undefined || progDir === null) {
    return undefined;
  }
  for (const dir of bundled(progDir, "web")) {
    if (isFile(path.join(dir, "index.html"))) {
      return dir;
    }
  }
  return undefined;
}
