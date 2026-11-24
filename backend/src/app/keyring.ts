/**
 * Cross-platform OS keyring access compatible with Antigravity CLI (`agy`), which stores OAuth
 * tokens via `github.com/zalando/go-keyring` under service `"antigravity"` and username `"gemini"`:
 *
 * - macOS: Keychain via `/usr/bin/security` (`find-generic-password` / `delete-generic-password`),
 *   decoding `go-keyring-base64:`, `go-keyring-encoded:`, and raw hex outputs.
 * - Windows: Credential Manager via `advapi32.dll` (`CredReadW` / `CredDeleteW` / `CredFree`)
 *   with `CRED_TYPE_GENERIC` and target name `"antigravity:gemini"` (`service:username`).
 * - Linux: D-Bus Secret Service via `secret-tool` (`service` + `username` attributes) when a
 *   session bus is present.
 */

import { dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "../kernel/types.ts";

/** Service name used by Antigravity CLI (`store.cliTokenStorage` -> `auth.NewCLITokenStorage`). */
export const AGY_KEYRING_SERVICE = "antigravity";

/** Account / username used by Antigravity CLI (`KeyringTokenStorage`). */
export const AGY_KEYRING_USER = "gemini";

/** Environment variable that forces Antigravity CLI to use file-only token storage. */
export const AGY_FORCE_FILE_ENV = "AGY_CLI_FORCE_FILE_TOKEN_STORAGE";

/** Base64 encoding prefix written by `zalando/go-keyring` on macOS. */
export const GO_KEYRING_BASE64_PREFIX = "go-keyring-base64:";

/** Legacy hex encoding prefix supported by `zalando/go-keyring` on macOS. */
export const GO_KEYRING_ENCODED_PREFIX = "go-keyring-encoded:";

const DARWIN_SECURITY_BIN = "/usr/bin/security";
const DARWIN_KEYCHAIN_PROBE_TIMEOUT_MS = 2_000;
const DARWIN_SECURITY_TIMEOUT_MS = 5_000;
const LINUX_SECRET_TOOL_TIMEOUT_MS = 3_000;
const MAX_TOOL_OUTPUT_BYTES = 128 * 1024;

// Win32 CRED_TYPE_GENERIC and 64-bit MSVC layout of CREDENTIALW (wincred.h):
//   +0  DWORD  Flags
//   +4  DWORD  Type
//   +8  LPWSTR TargetName
//   +16 LPWSTR Comment
//   +24 FILETIME LastWritten (8 bytes)
//   +32 DWORD  CredentialBlobSize
//   +36 [4 bytes alignment padding]
//   +40 LPBYTE CredentialBlob
const WIN_CRED_TYPE_GENERIC = 1;
const WIN_CRED_BLOB_SIZE_OFFSET = 32;
const WIN_CRED_BLOB_PTR_OFFSET = 40;
const MAX_WIN_CRED_BLOB_BYTES = 1024 * 1024;

/** Outcome of reading a secret from the OS keyring. */
export type KeyringReadResult =
  | { kind: "found"; value: string }
  | { kind: "notFound" }
  | { kind: "unavailable"; reason?: string };

/** Outcome of deleting a secret from the OS keyring. */
export type KeyringDeleteResult =
  | { kind: "deleted" }
  | { kind: "notFound" }
  | { kind: "unavailable"; reason?: string }
  | { kind: "error"; reason: string };

/** Asynchronous OS keyring backend (used by `RealKernels` to keep the event loop non-blocking). */
export interface KeyringBackend {
  read(service: string, username: string): Promise<KeyringReadResult>;
  delete(service: string, username: string): Promise<KeyringDeleteResult>;
}

/** Synchronous OS keyring backend (used by synchronous `inspectAntigravityAccount` / `logoutAntigravity`). */
export interface SyncKeyringBackend {
  readSync(service: string, username: string): KeyringReadResult;
  deleteSync(service: string, username: string): KeyringDeleteResult;
}

/** Raw outcome of executing an OS helper tool such as `security` or `secret-tool`. */
export interface ToolExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
  timedOut: boolean;
}

function getEnvValue(
  env: Record<string, string | undefined>,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const direct = env[name];
  if (direct !== undefined) {
    return direct;
  }
  if (platform === "win32") {
    const lower = name.toLowerCase();
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === lower) {
        return env[key];
      }
    }
  }
  return undefined;
}

/** Whether `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=true` (matching `agy`'s `forceFileFromEnv`). */
export function isForceFileTokenStorage(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const raw = getEnvValue(env, AGY_FORCE_FILE_ENV, platform);
  return typeof raw === "string" && raw.trim().toLowerCase() === "true";
}

/** Windows Credential Manager target name written by `zalando/go-keyring` (`service:username`). */
export function winCredTargetName(service: string, username: string): string {
  return `${service}:${username}`;
}

/** Decode a secret returned by `zalando/go-keyring` (base64 prefix, legacy hex prefix, or macOS raw hex). */
export function decodeGoKeyringSecret(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed.startsWith(GO_KEYRING_BASE64_PREFIX)) {
    const encoded = trimmed.slice(GO_KEYRING_BASE64_PREFIX.length);
    try {
      return Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith(GO_KEYRING_ENCODED_PREFIX)) {
    const encoded = trimmed.slice(GO_KEYRING_ENCODED_PREFIX.length);
    if (encoded.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(encoded)) {
      return Buffer.from(encoded, "hex").toString("utf8");
    }
    return trimmed;
  }
  // macOS `/usr/bin/security find-generic-password -w` prints raw hex when a secret stored
  // directly (without go-keyring-base64:) contains newlines or non-ASCII bytes.
  if (trimmed.length >= 4 && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "hex").toString("utf8");
    const decodedTrimmed = decoded.trim();
    if (
      decodedTrimmed.startsWith(GO_KEYRING_BASE64_PREFIX) ||
      decodedTrimmed.startsWith(GO_KEYRING_ENCODED_PREFIX)
    ) {
      return decodeGoKeyringSecret(decodedTrimmed);
    }
    if (decodedTrimmed.startsWith("{")) {
      return decoded;
    }
  }
  return trimmed;
}

/** Decode raw bytes from Windows `CREDENTIALW.CredentialBlob` (UTF-8 from `go-keyring`, or UTF-16LE fallback). */
export function decodeWinCredBlob(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // `zalando/go-keyring` writes UTF-8 (`[]byte(password)`). If another tool wrote UTF-16LE
  // (e.g. `{` as `0x7b 0x00`), detect alternating NUL bytes cleanly.
  let text: string;
  if (buf.length >= 2 && buf.length % 2 === 0 && buf[1] === 0 && buf[0] !== 0) {
    let nulOddCount = 0;
    const samplePairs = Math.min(8, buf.length / 2);
    for (let i = 0; i < samplePairs; i += 1) {
      if (buf[i * 2 + 1] === 0) {
        nulOddCount += 1;
      }
    }
    text = nulOddCount === samplePairs ? buf.toString("utf16le") : buf.toString("utf8");
  } else {
    text = buf.toString("utf8");
  }
  return decodeGoKeyringSecret(text.replace(/\0+$/, ""));
}

/** Whether this Linux process appears to have a D-Bus user session for Secret Service. */
export function hasLinuxSecretServiceEnv(
  env: Record<string, string | undefined> = process.env,
  existsSync: (filePath: string) => boolean = fs.existsSync,
): boolean {
  const bus = env.DBUS_SESSION_BUS_ADDRESS;
  if (typeof bus === "string" && bus.trim().length > 0) {
    return true;
  }
  const xdgRuntime = env.XDG_RUNTIME_DIR;
  if (typeof xdgRuntime === "string" && xdgRuntime.trim().length > 0) {
    try {
      return existsSync(path.join(xdgRuntime, "bus"));
    } catch {
      return false;
    }
  }
  return false;
}

/** Interpret `/usr/bin/security find-generic-password` output on macOS. */
export function parseDarwinSecurityResult(result: ToolExecResult): KeyringReadResult {
  if (result.timedOut) {
    return { kind: "unavailable", reason: "macOS Keychain lookup timed out" };
  }
  if (result.error) {
    return { kind: "unavailable", reason: result.error.message };
  }
  if (result.status === 0) {
    const value = decodeGoKeyringSecret(result.stdout);
    return value.length > 0 ? { kind: "found", value } : { kind: "notFound" };
  }
  const combined = `${result.stderr}\n${result.stdout}`.trim();
  if (result.status === 44 || combined.toLowerCase().includes("could not be found")) {
    return { kind: "notFound" };
  }
  return {
    kind: "unavailable",
    reason: combined.length > 0 ? combined : `security exited with status ${result.status ?? "unknown"}`,
  };
}

/** Interpret `/usr/bin/security delete-generic-password` output on macOS. */
export function parseDarwinDeleteResult(result: ToolExecResult): KeyringDeleteResult {
  if (result.timedOut) {
    return { kind: "error", reason: "macOS Keychain delete timed out" };
  }
  if (result.error) {
    if (result.error.code === "ENOENT") {
      return { kind: "unavailable", reason: result.error.message };
    }
    return { kind: "error", reason: result.error.message };
  }
  if (result.status === 0) {
    return { kind: "deleted" };
  }
  const combined = `${result.stderr}\n${result.stdout}`.trim();
  if (result.status === 44 || combined.toLowerCase().includes("could not be found")) {
    return { kind: "notFound" };
  }
  return {
    kind: "error",
    reason: combined.length > 0 ? combined : `security exited with status ${result.status ?? "unknown"}`,
  };
}

/** Interpret `secret-tool lookup` output on Linux. */
export function parseLinuxSecretToolResult(result: ToolExecResult): KeyringReadResult {
  if (result.timedOut) {
    return { kind: "unavailable", reason: "secret-tool lookup timed out" };
  }
  if (result.error) {
    return { kind: "unavailable", reason: result.error.message };
  }
  if (result.status === 0) {
    const value = decodeGoKeyringSecret(result.stdout);
    return value.length > 0 ? { kind: "found", value } : { kind: "notFound" };
  }
  const stderr = result.stderr.trim();
  if (result.status === 1 && stderr.length === 0) {
    return { kind: "notFound" };
  }
  return {
    kind: "unavailable",
    reason: stderr.length > 0 ? stderr : `secret-tool exited with status ${result.status ?? "unknown"}`,
  };
}

/** Interpret `secret-tool clear` output on Linux. */
export function parseLinuxSecretToolDeleteResult(result: ToolExecResult): KeyringDeleteResult {
  if (result.timedOut) {
    return { kind: "unavailable", reason: "secret-tool clear timed out" };
  }
  if (result.error) {
    return { kind: "unavailable", reason: result.error.message };
  }
  if (result.status === 0) {
    return { kind: "deleted" };
  }
  const stderr = result.stderr.trim();
  if (result.status === 1 && stderr.length === 0) {
    return { kind: "notFound" };
  }
  return {
    kind: "error",
    reason: stderr.length > 0 ? stderr : `secret-tool exited with status ${result.status ?? "unknown"}`,
  };
}

function runToolSync(
  program: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Record<string, string | undefined>,
): ToolExecResult {
  const out = spawnSync(program, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_TOOL_OUTPUT_BYTES,
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  const err = out.error as NodeJS.ErrnoException | undefined;
  const timedOut = err?.code === "ETIMEDOUT";
  return {
    status: out.status,
    stdout: typeof out.stdout === "string" ? out.stdout : "",
    stderr: typeof out.stderr === "string" ? out.stderr : "",
    error: timedOut ? undefined : err,
    timedOut,
  };
}

function runToolAsync(
  program: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Record<string, string | undefined>,
): Promise<ToolExecResult> {
  return new Promise<ToolExecResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let child;
    try {
      child = spawn(program, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env,
      });
    } catch (err) {
      resolve({
        status: null,
        stdout: "",
        stderr: "",
        error: err as NodeJS.ErrnoException,
        timedOut: false,
      });
      return;
    }

    const finish = (status: number | null, error?: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        error,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore if already gone.
      }
      finish(null);
    }, timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < MAX_TOOL_OUTPUT_BYTES) {
        const take = chunk.subarray(0, MAX_TOOL_OUTPUT_BYTES - stdoutBytes);
        stdoutChunks.push(take);
        stdoutBytes += take.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < MAX_TOOL_OUTPUT_BYTES) {
        const take = chunk.subarray(0, MAX_TOOL_OUTPUT_BYTES - stderrBytes);
        stderrChunks.push(take);
        stderrBytes += take.length;
      }
    });

    child.once("error", (err) => {
      finish(null, err as NodeJS.ErrnoException);
    });
    child.once("close", (code) => {
      finish(code);
    });
  });
}

interface WinAdvapi32 {
  credReadW(targetPtr: Pointer, type: number, flags: number, outCredPtr: Pointer): number;
  credDeleteW(targetPtr: Pointer, type: number, flags: number): number;
  credFree(credPtr: Pointer): void;
}

let cachedWinAdvapi32: WinAdvapi32 | null | undefined;
let cachedWinAdvapi32Error: string | undefined;

function getWinAdvapi32(): WinAdvapi32 | null {
  if (cachedWinAdvapi32 !== undefined) {
    return cachedWinAdvapi32;
  }
  if (process.platform !== "win32") {
    cachedWinAdvapi32 = null;
    return null;
  }
  try {
    const lib = dlopen("advapi32.dll", {
      CredReadW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      CredDeleteW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32],
        returns: FFIType.i32,
      },
      CredFree: {
        args: [FFIType.ptr],
        returns: FFIType.void,
      },
    });
    cachedWinAdvapi32 = {
      credReadW: (targetPtr, type, flags, outCredPtr) =>
        lib.symbols.CredReadW(targetPtr, type, flags, outCredPtr),
      credDeleteW: (targetPtr, type, flags) => lib.symbols.CredDeleteW(targetPtr, type, flags),
      credFree: (credPtr) => lib.symbols.CredFree(credPtr),
    };
    return cachedWinAdvapi32;
  } catch (err) {
    cachedWinAdvapi32 = null;
    cachedWinAdvapi32Error = errorMessage(err);
    return null;
  }
}

/**
 * Read and decode `CredentialBlob` from a 64-bit Win32 `CREDENTIALW` struct pointer returned by `CredReadW`.
 * Exported so unit tests can verify the exact MSVC struct layout and byte-copy logic across platforms.
 */
export function readWinCredBlobFromStruct(credAddr: bigint): KeyringReadResult {
  if (credAddr === 0n) {
    return { kind: "notFound" };
  }
  const blobSize = read.u32(credAddr, WIN_CRED_BLOB_SIZE_OFFSET);
  const blobPtr = read.u64(credAddr, WIN_CRED_BLOB_PTR_OFFSET);
  if (blobSize === 0 || blobPtr === 0n || blobSize > MAX_WIN_CRED_BLOB_BYTES) {
    return { kind: "notFound" };
  }
  const bytes = Buffer.allocUnsafe(blobSize);
  for (let i = 0; i < blobSize; i += 1) {
    bytes[i] = read.u8(blobPtr, i);
  }
  const value = decodeWinCredBlob(bytes);
  return value.length > 0 ? { kind: "found", value } : { kind: "notFound" };
}

function readWinCredSync(service: string, username: string): KeyringReadResult {
  const lib = getWinAdvapi32();
  if (lib === null) {
    return {
      kind: "unavailable",
      reason: cachedWinAdvapi32Error ?? "advapi32.dll is unavailable",
    };
  }
  const targetName = winCredTargetName(service, username);
  const targetBuf = Buffer.from(`${targetName}\0`, "utf16le");
  const outPtrBuf = new BigUint64Array(1);
  const ok = lib.credReadW(ptr(targetBuf), WIN_CRED_TYPE_GENERIC, 0, ptr(outPtrBuf));
  if (ok === 0) {
    return { kind: "notFound" };
  }
  const credAddr = outPtrBuf[0] ?? 0n;
  if (credAddr === 0n) {
    return { kind: "notFound" };
  }
  try {
    return readWinCredBlobFromStruct(credAddr);
  } finally {
    lib.credFree(Number(credAddr) as Pointer);
  }
}

function deleteWinCredSync(service: string, username: string): KeyringDeleteResult {
  const lib = getWinAdvapi32();
  if (lib === null) {
    return {
      kind: "unavailable",
      reason: cachedWinAdvapi32Error ?? "advapi32.dll is unavailable",
    };
  }
  const targetName = winCredTargetName(service, username);
  const targetBuf = Buffer.from(`${targetName}\0`, "utf16le");
  const ok = lib.credDeleteW(ptr(targetBuf), WIN_CRED_TYPE_GENERIC, 0);
  if (ok !== 0) {
    return { kind: "deleted" };
  }
  // Distinguish ERROR_NOT_FOUND from a genuine removal failure by probing whether the entry remains.
  const check = readWinCredSync(service, username);
  if (check.kind === "notFound") {
    return { kind: "notFound" };
  }
  return {
    kind: "error",
    reason: "Windows Credential Manager could not delete the Antigravity credential",
  };
}

function darwinKeychainUnlockedSync(): boolean {
  const probe = runToolSync(DARWIN_SECURITY_BIN, ["show-keychain-info"], DARWIN_KEYCHAIN_PROBE_TIMEOUT_MS);
  return !probe.timedOut && !probe.error && probe.status === 0;
}

async function darwinKeychainUnlockedAsync(): Promise<boolean> {
  const probe = await runToolAsync(
    DARWIN_SECURITY_BIN,
    ["show-keychain-info"],
    DARWIN_KEYCHAIN_PROBE_TIMEOUT_MS,
  );
  return !probe.timedOut && !probe.error && probe.status === 0;
}

/** Build the default cross-platform OS keyring backend for the current platform. */
export function createSystemKeyringBackend(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): KeyringBackend & SyncKeyringBackend {
  return {
    async read(service: string, username: string): Promise<KeyringReadResult> {
      if (platform === "win32") {
        return readWinCredSync(service, username);
      }
      if (platform === "darwin") {
        if (!(await darwinKeychainUnlockedAsync())) {
          return { kind: "unavailable", reason: "macOS Keychain is locked or unavailable" };
        }
        const res = await runToolAsync(
          DARWIN_SECURITY_BIN,
          ["find-generic-password", "-s", service, "-a", username, "-w"],
          DARWIN_SECURITY_TIMEOUT_MS,
        );
        return parseDarwinSecurityResult(res);
      }
      if (platform === "linux") {
        if (!hasLinuxSecretServiceEnv(env)) {
          return { kind: "unavailable", reason: "No D-Bus session bus" };
        }
        const res = await runToolAsync(
          "secret-tool",
          ["lookup", "service", service, "username", username],
          LINUX_SECRET_TOOL_TIMEOUT_MS,
          env,
        );
        return parseLinuxSecretToolResult(res);
      }
      return { kind: "unavailable", reason: `Unsupported keyring platform: ${platform}` };
    },

    async delete(service: string, username: string): Promise<KeyringDeleteResult> {
      if (platform === "win32") {
        return deleteWinCredSync(service, username);
      }
      if (platform === "darwin") {
        if (!(await darwinKeychainUnlockedAsync())) {
          return { kind: "unavailable", reason: "macOS Keychain is locked or unavailable" };
        }
        const res = await runToolAsync(
          DARWIN_SECURITY_BIN,
          ["delete-generic-password", "-s", service, "-a", username],
          DARWIN_SECURITY_TIMEOUT_MS,
        );
        return parseDarwinDeleteResult(res);
      }
      if (platform === "linux") {
        if (!hasLinuxSecretServiceEnv(env)) {
          return { kind: "unavailable", reason: "No D-Bus session bus" };
        }
        const res = await runToolAsync(
          "secret-tool",
          ["clear", "service", service, "username", username],
          LINUX_SECRET_TOOL_TIMEOUT_MS,
          env,
        );
        return parseLinuxSecretToolDeleteResult(res);
      }
      return { kind: "unavailable", reason: `Unsupported keyring platform: ${platform}` };
    },

    readSync(service: string, username: string): KeyringReadResult {
      if (platform === "win32") {
        return readWinCredSync(service, username);
      }
      if (platform === "darwin") {
        if (!darwinKeychainUnlockedSync()) {
          return { kind: "unavailable", reason: "macOS Keychain is locked or unavailable" };
        }
        const res = runToolSync(
          DARWIN_SECURITY_BIN,
          ["find-generic-password", "-s", service, "-a", username, "-w"],
          DARWIN_SECURITY_TIMEOUT_MS,
        );
        return parseDarwinSecurityResult(res);
      }
      if (platform === "linux") {
        if (!hasLinuxSecretServiceEnv(env)) {
          return { kind: "unavailable", reason: "No D-Bus session bus" };
        }
        const res = runToolSync(
          "secret-tool",
          ["lookup", "service", service, "username", username],
          LINUX_SECRET_TOOL_TIMEOUT_MS,
          env,
        );
        return parseLinuxSecretToolResult(res);
      }
      return { kind: "unavailable", reason: `Unsupported keyring platform: ${platform}` };
    },

    deleteSync(service: string, username: string): KeyringDeleteResult {
      if (platform === "win32") {
        return deleteWinCredSync(service, username);
      }
      if (platform === "darwin") {
        if (!darwinKeychainUnlockedSync()) {
          return { kind: "unavailable", reason: "macOS Keychain is locked or unavailable" };
        }
        const res = runToolSync(
          DARWIN_SECURITY_BIN,
          ["delete-generic-password", "-s", service, "-a", username],
          DARWIN_SECURITY_TIMEOUT_MS,
        );
        return parseDarwinDeleteResult(res);
      }
      if (platform === "linux") {
        if (!hasLinuxSecretServiceEnv(env)) {
          return { kind: "unavailable", reason: "No D-Bus session bus" };
        }
        const res = runToolSync(
          "secret-tool",
          ["clear", "service", service, "username", username],
          LINUX_SECRET_TOOL_TIMEOUT_MS,
          env,
        );
        return parseLinuxSecretToolDeleteResult(res);
      }
      return { kind: "unavailable", reason: `Unsupported keyring platform: ${platform}` };
    },
  };
}
