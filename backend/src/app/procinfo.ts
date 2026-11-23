//! What the operating system says about processes: enough for the Watchdog to tell work in progress from a hang.
//!
//! Linux reads `/proc` directly via `node:fs` without spawning subprocesses. Other systems ask their own tools once
//! per sample: `ps` and `lsof` on macOS and other Unix, PowerShell's process table on Windows, where a process's
//! working directory is not available. Every parser builds and is tested on every platform.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { clip as clipChars } from "./text.ts";

/** One process, as sampled. Wire JSON keys match Rust `ProcessSnapshot` verbatim. */
export interface ProcessSnapshot {
  /** Its id. */
  pid: number;
  /** Its parent's id. */
  ppid: number;
  /** Its scheduler state as the system names it, such as `R` or `S`; `?` when unknown. */
  state: string;
  /** The CPU time it has used, in units that only grow: a later sample that is larger means it worked. */
  cpu_ticks: number;
  /** Its command line. */
  cmd: string;
}

/** The most processes one tree is followed to. */
export const MAX_TREE = 128;

/** Maximum Unicode characters kept for a process command line. */
export const CMD_CHARS = 180;

function clipCmd(text: string): string {
  return clipChars(text, CMD_CHARS);
}

function parseStrictUint(text: string): number | null {
  const len = text.length;
  if (len === 0) {
    return null;
  }
  let value = 0;
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) {
      return null;
    }
    value = value * 10 + (code - 48);
  }
  return Number.isSafeInteger(value) ? value : null;
}

function parseStrictBigUint(text: string): bigint | null {
  const len = text.length;
  if (len === 0) {
    return null;
  }
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) {
      return null;
    }
  }
  return BigInt(text);
}

function trimTrailingSeparators(p: string): string {
  let end = p.length;
  while (end > 1 && (p.charCodeAt(end - 1) === 47 || p.charCodeAt(end - 1) === 92)) {
    end -= 1;
  }
  return end === p.length ? p : p.slice(0, end);
}

/**
 * Component-wise path prefix check matching Rust `Path::starts_with`
 * (e.g. `/work/t1/build` starts with `/work/t1`, whereas `/work/t10` does not).
 */
export function pathStartsWith(candidate: string, base: string): boolean {
  if (base.length === 0) {
    return true;
  }
  const normBase = trimTrailingSeparators(path.normalize(base));
  const normCandidate = trimTrailingSeparators(path.normalize(candidate));
  if (normBase === "/" || normBase === path.sep) {
    return normCandidate.startsWith("/") || normCandidate.startsWith(path.sep);
  }
  if (normCandidate === normBase) {
    return true;
  }
  if (!normCandidate.startsWith(normBase)) {
    return false;
  }
  const next = normCandidate.charCodeAt(normBase.length);
  return next === 47 /* '/' */ || next === 92 /* '\\' */;
}

function splitN(text: string, sep: string, limit: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (parts.length < limit - 1) {
    const idx = text.indexOf(sep, start);
    if (idx < 0) {
      break;
    }
    parts.push(text.slice(start, idx));
    start = idx + sep.length;
  }
  parts.push(text.slice(start));
  return parts;
}

// --- Linux `/proc` pure-TS implementation ---

function ownerUid(targetPath: string): number | null {
  try {
    return fs.statSync(targetPath).uid;
  } catch {
    return null;
  }
}

/** One process from `/proc/<pid>/stat` and `/proc/<pid>/cmdline`. */
export function linuxSnapshot(pid: number): ProcessSnapshot | null {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // The command name is in parentheses and may itself hold spaces or parentheses.
  const end = stat.lastIndexOf(")");
  if (end < 0 || end + 2 > stat.length) {
    return null;
  }
  const open = stat.indexOf("(");
  if (open < 0 || open >= end) {
    return null;
  }
  const tail = stat.slice(end + 2).trim();
  const fields = tail.length > 0 ? tail.split(/\s+/) : [];
  const numberAt = (index: number): number => {
    const raw = fields[index];
    if (raw === undefined) return 0;
    return parseStrictUint(raw) ?? 0;
  };
  let command = "";
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
    command = raw.toString("utf8").replaceAll("\0", " ").trim();
  } catch {
    command = "";
  }
  const name = stat.slice(open + 1, end);
  return {
    pid,
    ppid: numberAt(1),
    state: fields[0] ?? "?",
    cpu_ticks: numberAt(11) + numberAt(12),
    cmd: clipCmd(command.length === 0 ? name : command),
  };
}

/** `roots` and the processes they started, through each thread's `/proc/<pid>/task/<tid>/children` list. */
export function linuxDescendants(roots: ReadonlyArray<number>): number[] {
  const visited: number[] = [];
  const seen = new Set<number>();
  const queue: number[] = [];
  for (const root of roots) {
    queue.push(root);
  }
  let head = 0;
  while (head < queue.length) {
    if (visited.length >= MAX_TREE) {
      break;
    }
    const pid = queue[head++];
    if (pid === 0 || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    visited.push(pid);
    let tasks: string[];
    try {
      tasks = fs.readdirSync(`/proc/${pid}/task`);
    } catch {
      continue;
    }
    for (const task of tasks) {
      let childrenText: string;
      try {
        childrenText = fs.readFileSync(`/proc/${pid}/task/${task}/children`, "utf8");
      } catch {
        continue;
      }
      const trimmed = childrenText.trim();
      if (trimmed.length === 0) {
        continue;
      }
      for (const token of trimmed.split(/\s+/)) {
        const child = parseStrictUint(token);
        if (child !== null) {
          queue.push(child);
        }
      }
    }
  }
  return visited;
}

/** This user's processes whose `/proc/<pid>/cwd` is in `directory`. */
export function linuxInDirectory(directory: string): number[] {
  const own = process.pid;
  const user = ownerUid("/proc/self");
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const name of entries) {
    const pid = parseStrictUint(name);
    if (pid === null || pid === own) {
      continue;
    }
    const procPath = `/proc/${pid}`;
    // A process of another user cannot be read, and is none of this application's.
    if (user !== null && ownerUid(procPath) !== user) {
      continue;
    }
    let cwd: string;
    try {
      cwd = fs.readlinkSync(`${procPath}/cwd`);
    } catch {
      continue;
    }
    if (pathStartsWith(cwd, directory)) {
      found.push(pid);
    }
  }
  found.sort((a, b) => a - b);
  return found;
}

/** `pid` and its ancestor process ids from `/proc/<pid>/stat`, capped to avoid loops. */
export function linuxAncestors(pid: number): Set<number> {
  const set = new Set<number>();
  let current = pid;
  for (let i = 0; i < 64; i++) {
    if (current <= 1 || set.has(current)) {
      break;
    }
    set.add(current);
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${current}/stat`, "utf8");
    } catch {
      break;
    }
    const end = stat.lastIndexOf(")");
    if (end < 0 || end + 2 > stat.length) {
      break;
    }
    const tail = stat.slice(end + 2).trim();
    const fields = tail.length > 0 ? tail.split(/\s+/) : [];
    const ppidRaw = fields[1];
    if (ppidRaw === undefined) {
      break;
    }
    const ppid = parseStrictUint(ppidRaw);
    if (ppid === null) {
      break;
    }
    current = ppid;
  }
  return set;
}

// --- Cross-platform parsers and subprocess fallbacks ---

function runTool(program: string, args: ReadonlyArray<string>): string | null {
  try {
    const result = spawnSync(program, args, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer: 32 << 20,
    });
    if (result.error) {
      return null;
    }
    // `lsof` exits non-zero when some process cannot be read, and still lists the rest.
    return typeof result.stdout === "string" ? result.stdout : "";
  } catch {
    return null;
  }
}

/** A CPU time such as `1:23.45`, `00:01:23` or `2-03:04:05` in hundredths of a second. */
export function cpuTime(text: string): number {
  const dash = text.indexOf("-");
  let days = 0;
  let clock = text;
  if (dash >= 0) {
    days = parseStrictUint(text.slice(0, dash)) ?? 0;
    clock = text.slice(dash + 1);
  }
  let hundredths = 0;
  let seconds = 0;
  for (const part of clock.split(":")) {
    const dot = part.indexOf(".");
    const whole = dot >= 0 ? part.slice(0, dot) : part;
    const fraction = dot >= 0 ? part.slice(dot + 1) : "";
    seconds = seconds * 60 + (parseStrictUint(whole) ?? 0);
    const digits = (fraction + "00").slice(0, 2);
    hundredths = parseStrictUint(digits) ?? 0;
  }
  return (days * 86_400 + seconds) * 100 + hundredths;
}

/** The lines of `ps -axo pid=,ppid=,state=,time=,command=`. */
export function parsePs(output: string): ProcessSnapshot[] {
  const results: ProcessSnapshot[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    let rest = rawLine.trimStart();
    if (rest.length === 0) {
      continue;
    }
    const nextField = (): string => {
      let end = 0;
      while (end < rest.length) {
        const code = rest.charCodeAt(end);
        if (code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11) {
          break;
        }
        end += 1;
      }
      const value = rest.slice(0, end);
      rest = rest.slice(end).trimStart();
      return value;
    };
    const pid = parseStrictUint(nextField());
    if (pid === null) continue;
    const ppid = parseStrictUint(nextField());
    if (ppid === null) continue;
    const state = nextField();
    const time = nextField();
    results.push({
      pid,
      ppid,
      state,
      cpu_ticks: cpuTime(time),
      cmd: clipCmd(rest.trimEnd()),
    });
  }
  return results;
}

/** The processes whose working directory, in `lsof -a -d cwd -F pn` output, is `directory` or inside it. */
export function parseLsof(output: string, directory: string, ownPid: number = process.pid): number[] {
  const found: number[] = [];
  const seen = new Set<number>();
  let pid: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      pid = parseStrictUint(line.slice(1));
    } else if (line.startsWith("n") && pid !== null) {
      const cwd = line.slice(1);
      if (pid !== ownPid && pathStartsWith(cwd, directory) && !seen.has(pid)) {
        seen.add(pid);
        found.push(pid);
      }
    }
  }
  return found;
}

/** The lines PowerShell prints for the Windows process table: id, parent id, CPU time in 100 ns, name, command line. */
export function parseWindows(output: string): ProcessSnapshot[] {
  const results: ProcessSnapshot[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      continue;
    }
    const fields = splitN(line, "\t", 5);
    if (fields.length < 4) {
      continue;
    }
    const pid = parseStrictUint(fields[0].trim());
    if (pid === null) continue;
    const ppid = parseStrictUint(fields[1].trim());
    if (ppid === null) continue;
    const timeRaw = parseStrictBigUint(fields[2].trim()) ?? 0n;
    const name = fields[3];
    const cmdField = fields[4]?.trim() ?? "";
    const command = cmdField.length > 0 ? cmdField : name;
    results.push({
      pid,
      ppid,
      state: "?",
      cpu_ticks: Number(timeRaw / 100_000n),
      cmd: clipCmd(command),
    });
  }
  return results;
}

/** Every process the system lists, from its own tools (`ps` on Unix, PowerShell on Windows). */
export function readProcessTable(): ProcessSnapshot[] {
  if (process.platform === "win32") {
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.KernelModeTime + $_.UserModeTime)`t$($_.Name)`t$($_.CommandLine)" }';
    const output = runTool("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return output !== null ? parseWindows(output) : [];
  }
  const output = runTool("ps", ["-axo", "pid=,ppid=,state=,time=,command="]);
  return output !== null ? parsePs(output) : [];
}

/** `roots` and their descendants within a process table. */
export function tableTree(roots: ReadonlyArray<number>, table: ReadonlyArray<ProcessSnapshot>): ProcessSnapshot[] {
  const children = new Map<number, number[]>();
  const byPid = new Map<number, ProcessSnapshot>();
  for (const proc of table) {
    let list = children.get(proc.ppid);
    if (!list) {
      list = [];
      children.set(proc.ppid, list);
    }
    list.push(proc.pid);
    if (!byPid.has(proc.pid)) {
      byPid.set(proc.pid, proc);
    }
  }
  const visited: number[] = [];
  const seen = new Set<number>();
  const queue: number[] = [];
  for (const root of roots) {
    queue.push(root);
  }
  let head = 0;
  while (head < queue.length) {
    if (visited.length >= MAX_TREE) {
      break;
    }
    const pid = queue[head++];
    if (pid === 0 || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    visited.push(pid);
    const kids = children.get(pid);
    if (kids) {
      for (const kid of kids) {
        queue.push(kid);
      }
    }
  }
  const out: ProcessSnapshot[] = [];
  for (const pid of visited) {
    const snap = byPid.get(pid);
    if (snap) {
      out.push({ ...snap });
    }
  }
  return out;
}

// --- Public cross-platform API ---

/** `roots` and every process they started, as far as {@link MAX_TREE} processes. */
export function tree(roots: ReadonlyArray<number>): ProcessSnapshot[] {
  if (roots.length === 0) {
    return [];
  }
  if (process.platform === "linux") {
    const pids = linuxDescendants(roots);
    const out: ProcessSnapshot[] = [];
    for (const pid of pids) {
      const snap = linuxSnapshot(pid);
      if (snap !== null) {
        out.push(snap);
      }
    }
    return out;
  }
  return tableTree(roots, readProcessTable());
}

/** The processes of this user whose working directory is `directory` or inside it; empty where the system cannot say. */
export function inDirectory(directory: string): number[] {
  if (process.platform === "linux") {
    return linuxInDirectory(directory);
  }
  if (process.platform === "win32") {
    return [];
  }
  const output = runTool("lsof", ["-a", "-d", "cwd", "-F", "pn"]);
  return output !== null ? parseLsof(output, directory) : [];
}

/** The current process id and its ancestors, so cleanup never signals the host process or its parents. */
function selfAncestors(): Set<number> {
  if (process.platform === "linux") {
    return linuxAncestors(process.pid);
  }
  const table = readProcessTable();
  const parents = new Map<number, number>();
  for (const proc of table) {
    parents.set(proc.pid, proc.ppid);
  }
  const protectedPids = new Set<number>();
  let current = process.pid;
  for (let i = 0; i < 64; i++) {
    if (current <= 1 || protectedPids.has(current)) {
      break;
    }
    protectedPids.add(current);
    const ppid = parents.get(current);
    if (ppid === undefined) {
      break;
    }
    current = ppid;
  }
  return protectedPids;
}

function collectTargets(pids: ReadonlyArray<number>): number[] {
  const protectedPids = selfAncestors();
  const targets: number[] = [];
  const seen = new Set<number>();
  for (const pid of pids) {
    if (pid > 1 && !protectedPids.has(pid) && !seen.has(pid)) {
      seen.add(pid);
      targets.push(pid);
    }
  }
  return targets;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Process already exited or cannot be signaled.
  }
}

function killWindowsTargets(targets: ReadonlyArray<number>): void {
  for (const pid of targets) {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Ignore taskkill failures.
    }
  }
}

/**
 * Ask `pids` to exit gracefully (`SIGTERM`) and forcibly end (`SIGKILL`) any that remain after up to 300ms,
 * ignoring pid 0/1, this process and its ancestors. Non-blocking on the event loop.
 */
export async function terminatePids(pids: ReadonlyArray<number>): Promise<void> {
  const targets = collectTargets(pids);
  if (targets.length === 0) {
    return;
  }
  if (process.platform === "win32") {
    killWindowsTargets(targets);
    return;
  }
  for (const pid of targets) {
    safeSignal(pid, "SIGTERM");
  }
  for (let i = 0; i < 12; i++) {
    if (!targets.some(isProcessAlive)) {
      return;
    }
    await Bun.sleep(25);
  }
  for (const pid of targets) {
    if (isProcessAlive(pid)) {
      safeSignal(pid, "SIGKILL");
    }
  }
}

/** Synchronous variant of {@link terminatePids} for process shutdown hooks. */
export function terminatePidsSync(pids: ReadonlyArray<number>): void {
  const targets = collectTargets(pids);
  if (targets.length === 0) {
    return;
  }
  if (process.platform === "win32") {
    killWindowsTargets(targets);
    return;
  }
  for (const pid of targets) {
    safeSignal(pid, "SIGTERM");
  }
  for (let i = 0; i < 12; i++) {
    if (!targets.some(isProcessAlive)) {
      return;
    }
    Bun.sleepSync(25);
  }
  for (const pid of targets) {
    if (isProcessAlive(pid)) {
      safeSignal(pid, "SIGKILL");
    }
  }
}
