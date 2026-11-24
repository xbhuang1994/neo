/**
 * Antigravity account management: inspects the Antigravity CLI's Google OAuth login,
 * starts `agy acp --login` over pipes so remote browser sessions can complete sign-in,
 * and logs out by removing the login token file.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { errorMessage, isRecord } from "../kernel/types.ts";
import {
  AGY_KEYRING_SERVICE,
  AGY_KEYRING_USER,
  createSystemKeyringBackend,
  isForceFileTokenStorage,
} from "./keyring.ts";
import type {
  KeyringBackend,
  KeyringDeleteResult,
  KeyringReadResult,
  SyncKeyringBackend,
} from "./keyring.ts";
import type { Kernel } from "./kernel-types.ts";

/** The Google account Antigravity is signed in with. */
export interface AntigravityAccount {
  /** The signed-in email address, or empty when the token file does not carry one. */
  email: string;
  /** Whether this login can be removed from Neo. */
  removable: boolean;
}

/** Antigravity's current login state on this machine. */
export interface AccountStatus {
  /** The signed-in Google account when a login file is present. */
  account: AntigravityAccount | null;
  /** Something the person should know, such as a login kept in the system keyring. */
  note?: string;
}

/** The command that logs Antigravity in. */
export interface LoginCommand {
  /** The `agy` program. */
  program: string;
  /** Its arguments. */
  args: string[];
  /** Variables to set. */
  env: Record<string, string>;
  /** Text that, once printed, means the login failed even though the program keeps running. */
  failsOn?: string;
}

/** Lifecycle state of a CLI login process. */
export type LoginState = "running" | "done" | "failed";

/** One Antigravity login in progress, or the last one. */
export interface LoginView {
  /** Which login. */
  id: number;
  /** `running`, `done` or `failed`. */
  state: LoginState;
  /** The links to open. */
  links: string[];
  /** What the program printed, cleaned, its last lines. */
  output: string;
}

/** Wire snapshot of a login session (alias of `LoginView`). */
export type LoginSnapshot = LoginView;

/** Wire payload returned by `GET /api/settings/accounts` and `POST /api/settings/accounts/logout`. */
export interface AccountsView {
  installed: boolean;
  problem: string | null;
  account: AntigravityAccount | null;
  note: string | null;
  login: LoginView | null;
}

/**
 * Minimal kernel capability surface needed by account management.
 * Structurally satisfied by `Kernels` and `RealKernels` without introducing a circular import.
 */
export interface AccountKernels {
  unavailable(kernel: Kernel): string | undefined;
  installed?(kernel: Kernel): boolean;
  account?(): Promise<AccountStatus>;
  login?(): LoginCommand;
  logout?(): Promise<void>;
}

/** Configuration for `AccountsState` timers and credential-change notifications. */
export interface AccountsStateOptions {
  /** Maximum lifetime of one login process in milliseconds (default: 10 minutes). */
  loginTimeoutMs?: number;
  /** How long `startLogin` waits for an initial link or early exit in milliseconds (default: 3000). */
  linkWaitMs?: number;
  /** How long `loginInput` waits for output or exit after writing a line in milliseconds (default: 1500). */
  inputWaitMs?: number;
  /** Called whenever a login finishes or logout succeeds (e.g. to drop cached model lists). */
  onCredentialsChanged?: () => void;
}

/** Maximum lifetime of a CLI login process (10 minutes). */
export const LOGIN_TIMEOUT_MS = 600_000;

/** Maximum UTF-8 byte length kept in `LoginView.output`. */
export const KEEP_OUTPUT = 6000;

/** Default initial wait in `startLogin` for the CLI to print its sign-in link (3 seconds). */
export const DEFAULT_LINK_WAIT_MS = 3000;

/** Default wait in `loginInput` after sending a pasted line to stdin (1.5 seconds). */
export const DEFAULT_INPUT_WAIT_MS = 1500;

/** Note shown when the OAuth token file is absent and the OS keyring could not be inspected. */
export const NO_LOGIN_FILE_NOTE =
  "No login file found. A login kept in the system keyring does not show here.";

/** Note shown when `agy` is authenticated through an external/unreadable store (e.g. ADC, API key, or unreadable keyring). */
export const EXTERNAL_LOGIN_NOTE =
  "Signed in via Antigravity CLI. This login is managed outside Neo and cannot be signed out from here.";

/** Output marker indicating `agy acp --login` failed even if the process keeps running. */
export const LOGIN_FAILS_ON = "couldn't log in";

/** Parsed Antigravity OAuth token payload from either the OS keyring or token file. */
export interface ParsedAntigravityToken {
  /** Whether the payload carries an active credential (not empty or signed-out metadata). */
  hasToken: boolean;
  /** Extracted email address (`id_token_email` or JWT `id_token` email), or `""`. */
  email: string;
  /** True when the payload explicitly records `"token": null` (signed-out metadata). */
  explicitlySignedOut: boolean;
}

/** Result of probing `agy` directly when neither keyring nor token file holds a credential. */
export interface CliAuthProbeResult {
  signedIn: boolean;
  confirmedUnauthenticated?: boolean;
}

/** Options for synchronous `inspectAntigravityAccount`. */
export interface InspectAccountOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Explicit keyring backend, or `null` to skip keyring inspection. */
  keyring?: SyncKeyringBackend | null;
}

/** Options for asynchronous `inspectAntigravityAccountAsync`. */
export interface InspectAccountAsyncOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Explicit keyring backend, or `null` to skip keyring inspection. */
  keyring?: KeyringBackend | null;
  /** Optional fallback probe (such as `agy models`) when keyring and token file yield no login. */
  probeSignedIn?: () => Promise<CliAuthProbeResult>;
}

/** Options for synchronous `logoutAntigravity`. */
export interface LogoutAccountOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Explicit keyring backend, or `null` to skip keyring deletion. */
  keyring?: SyncKeyringBackend | null;
}

/** Options for asynchronous `logoutAntigravityAsync`. */
export interface LogoutAccountAsyncOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Explicit keyring backend, or `null` to skip keyring deletion. */
  keyring?: KeyringBackend | null;
}

/** Maximum raw buffer retained before rolling old lines into archived links (64 KiB). */
const MAX_RAW_CHARS = 65_536;

/** Minimum recent raw tail retained when compacting `raw` (16 KiB). */
const MIN_RAW_KEEP_CHARS = 16_384;

/** Grace period after process exit to drain trailing stdout/stderr pipe chunks. */
const EXIT_DRAIN_MS = 200;

/** Maximum UTF-8 byte length accepted for a single pasted login input line. */
const MAX_INPUT_BYTES = 8000;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function isControlCodePoint(cp: number): boolean {
  return (cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f);
}

function nonEmptyEnv(
  env: Record<string, string | undefined>,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const direct = env[name];
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  if (platform === "win32") {
    const lower = name.toLowerCase();
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === lower) {
        const value = env[key];
        if (typeof value === "string" && value.length > 0) {
          return value;
        }
      }
    }
  }
  return undefined;
}

function safeOsHomedir(): string {
  try {
    return os.homedir();
  } catch {
    return "";
  }
}

/**
 * Resolve the user's home directory matching Go's `os.UserHomeDir()` (which `agy` uses):
 * on Windows, `USERPROFILE` takes precedence over `HOME`; elsewhere, `HOME` takes precedence.
 * Empty environment variables are ignored and `os.homedir()` is used as fallback.
 */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return (
      nonEmptyEnv(env, "USERPROFILE", platform) ??
      nonEmptyEnv(env, "HOME", platform) ??
      safeOsHomedir()
    );
  }
  return (
    nonEmptyEnv(env, "HOME", platform) ??
    nonEmptyEnv(env, "USERPROFILE", platform) ??
    safeOsHomedir()
  );
}

/** Antigravity's login token file (`~/.gemini/antigravity-cli/antigravity-oauth-token`). */
export function agyTokenFile(
  homeDir?: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const base = homeDir !== undefined ? homeDir : resolveHome(env, platform);
  return path.join(base, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

/** Suppress browser launch and ANSI color codes during CLI login. */
export function loginEnv(env?: Record<string, string>): Record<string, string> {
  return {
    ...(env ?? {}),
    BROWSER: "true",
    NO_COLOR: "1",
  };
}

/** Text without terminal escapes: colours, cursor moves and OSC hyperlinks. */
export function clean(text: string): string {
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
      if (i < len) {
        const next = text.codePointAt(i)!;
        const nextWidth = next > 0xffff ? 2 : 1;
        if (next === 0x5b) {
          // CSI sequence: ESC [ ... (@..~)
          i += 1;
          while (i < len) {
            const c = text.codePointAt(i)!;
            i += c > 0xffff ? 2 : 1;
            if (c >= 0x40 && c <= 0x7e) {
              break;
            }
          }
        } else if (next === 0x5d) {
          // OSC sequence: runs to BEL (\x07) or ST (ESC \).
          i += 1;
          while (i < len) {
            const c = text.codePointAt(i)!;
            i += c > 0xffff ? 2 : 1;
            if (c === 0x07) {
              break;
            }
            if (c === 0x1b && i < len && text.codePointAt(i) === 0x5c) {
              i += 1;
              break;
            }
          }
        } else {
          // Other two-character escape sequence: skip the following code point.
          i += nextWidth;
        }
      }
      runStart = i;
      continue;
    }

    if (cp === 0x0d || (isControlCodePoint(cp) && cp !== 0x0a && cp !== 0x09)) {
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
    return text;
  }
  if (runStart < len) {
    out += text.slice(runStart);
  }
  return out;
}

const LINK_SPLIT_RE = /[\p{White_Space}<>"']+/u;
const LINK_TRAILING_PUNCT_RE = /[.,)\]]+$/;

/** The web links in a login's output that a person can open elsewhere: not those to this machine. */
export function links(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const word of text.split(LINK_SPLIT_RE)) {
    const start = word.indexOf("https://");
    if (start === -1) {
      continue;
    }
    const link = word.slice(start).replace(LINK_TRAILING_PUNCT_RE, "");
    if (link.length > "https://".length && !seen.has(link)) {
      seen.add(link);
      found.push(link);
    }
  }
  return found;
}

/**
 * Trim whitespace and keep at most `maxBytes` trailing UTF-8 bytes without splitting
 * a multi-byte character (matches Rust `str::is_char_boundary`).
 */
export function tail(text: string, maxBytes = KEEP_OUTPUT): string {
  const trimmed = text.trim();
  const buf = Buffer.from(trimmed, "utf8");
  if (buf.length <= maxBytes) {
    return trimmed;
  }
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return buf.subarray(start).toString("utf8");
}

/** Validate that a JSON request body is an empty object `{}`. */
export function emptyObject(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("Expected a JSON object");
  }
  for (const key of Object.keys(value)) {
    throw new Error(`Unknown field ${key}`);
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function emailFromJwt(jwt: unknown): string {
  if (!nonEmptyString(jwt)) {
    return "";
  }
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) {
    return "";
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return isRecord(payload) && nonEmptyString(payload.email) ? payload.email.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Parse an Antigravity CLI token payload (`StoredToken` JSON or legacy flat `oauth2.Token` JSON).
 * Distinguishes active logins from empty payloads or signed-out metadata records (`"token": null`).
 */
export function parseAntigravityToken(text: string): ParsedAntigravityToken {
  if (text.trim().length === 0) {
    return { hasToken: false, email: "", explicitlySignedOut: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Malformed non-empty token file/entry: treat as present with unknown email so it remains visible & removable.
    return { hasToken: true, email: "", explicitlySignedOut: false };
  }
  if (!isRecord(parsed)) {
    return { hasToken: false, email: "", explicitlySignedOut: false };
  }

  const nested = isRecord(parsed.token) ? parsed.token : null;
  const email =
    nonEmptyString(parsed.id_token_email)
      ? parsed.id_token_email.trim()
      : emailFromJwt(nested?.id_token) || emailFromJwt(parsed.id_token);

  const hasNestedToken =
    nested !== null &&
    (nonEmptyString(nested.access_token) ||
      nonEmptyString(nested.refresh_token) ||
      Object.keys(nested).length > 0);
  const hasFlatToken =
    nonEmptyString(parsed.access_token) || nonEmptyString(parsed.refresh_token);

  if (Object.prototype.hasOwnProperty.call(parsed, "token")) {
    const explicitlySignedOut = parsed.token === null && !hasFlatToken;
    return {
      hasToken: hasNestedToken || hasFlatToken,
      email,
      explicitlySignedOut,
    };
  }

  return {
    hasToken: hasFlatToken || email.length > 0,
    email,
    explicitlySignedOut: false,
  };
}

/** Whether an `agy models` error message clearly indicates the CLI is not signed in. */
export function isUnauthenticatedModelError(message: string): boolean {
  return /please sign in|not signed in|not logged in|unauthenticated|login required|authentication required/i.test(
    message,
  );
}

function readTokenFileParsed(tokenPath: string): ParsedAntigravityToken | null {
  try {
    const text = fs.readFileSync(tokenPath, "utf8");
    return parseAntigravityToken(text);
  } catch {
    return null;
  }
}

function resolveAccountFromStores(
  keyringResult: KeyringReadResult | null,
  fileParsed: ParsedAntigravityToken | null,
): { status: AccountStatus | null; keyringCheckedCleanly: boolean } {
  const keyringParsed =
    keyringResult !== null && keyringResult.kind === "found"
      ? parseAntigravityToken(keyringResult.value)
      : null;

  // Match `agy`'s `compositeTokenStorage`: prefer an active keyring token, falling back to file,
  // and fill missing email from the companion store when that store is not signed-out metadata.
  if (keyringParsed !== null && keyringParsed.hasToken) {
    const email =
      keyringParsed.email.length > 0
        ? keyringParsed.email
        : fileParsed !== null && !fileParsed.explicitlySignedOut
          ? fileParsed.email
          : "";
    return {
      status: { account: { email, removable: true } },
      keyringCheckedCleanly: true,
    };
  }

  if (fileParsed !== null && fileParsed.hasToken) {
    const email =
      fileParsed.email.length > 0
        ? fileParsed.email
        : keyringParsed !== null && !keyringParsed.explicitlySignedOut
          ? keyringParsed.email
          : "";
    return {
      status: { account: { email, removable: true } },
      keyringCheckedCleanly: keyringResult !== null && keyringResult.kind !== "unavailable",
    };
  }

  const keyringCheckedCleanly =
    keyringResult !== null && keyringResult.kind !== "unavailable";
  return { status: null, keyringCheckedCleanly };
}

/**
 * Synchronously inspect Antigravity's OAuth credentials (OS keyring and/or token file).
 * When `homeDir` is explicitly provided without a `keyring` override, only the file under
 * `homeDir` is inspected so tests stay isolated from the host OS keyring.
 */
export function inspectAntigravityAccount(
  homeDir?: string,
  options: InspectAccountOptions = {},
): AccountStatus {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const forceFile = isForceFileTokenStorage(env, platform);
  const keyringBackend: SyncKeyringBackend | null = forceFile
    ? null
    : options.keyring !== undefined
      ? options.keyring
      : homeDir === undefined
        ? createSystemKeyringBackend(platform, env)
        : null;

  const keyringResult =
    keyringBackend !== null
      ? keyringBackend.readSync(AGY_KEYRING_SERVICE, AGY_KEYRING_USER)
      : null;
  const fileParsed = readTokenFileParsed(agyTokenFile(homeDir, env, platform));
  const { status, keyringCheckedCleanly } = resolveAccountFromStores(keyringResult, fileParsed);
  if (status !== null) {
    return status;
  }
  return keyringCheckedCleanly
    ? { account: null }
    : { account: null, note: NO_LOGIN_FILE_NOTE };
}

/**
 * Asynchronously inspect Antigravity's OAuth credentials across OS keyring, login token file,
 * and an optional CLI probe fallback (e.g. `agy models`).
 */
export async function inspectAntigravityAccountAsync(
  options: InspectAccountAsyncOptions = {},
): Promise<AccountStatus> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const forceFile = isForceFileTokenStorage(env, platform);
  const keyringBackend: KeyringBackend | null = forceFile
    ? null
    : options.keyring !== undefined
      ? options.keyring
      : options.homeDir === undefined
        ? createSystemKeyringBackend(platform, env)
        : null;

  const keyringResult =
    keyringBackend !== null
      ? await keyringBackend.read(AGY_KEYRING_SERVICE, AGY_KEYRING_USER)
      : null;
  const fileParsed = readTokenFileParsed(agyTokenFile(options.homeDir, env, platform));
  const { status, keyringCheckedCleanly } = resolveAccountFromStores(keyringResult, fileParsed);
  if (status !== null) {
    return status;
  }

  if (options.probeSignedIn !== undefined) {
    const probe = await options.probeSignedIn();
    if (probe.signedIn) {
      return {
        account: { email: "", removable: false },
        note: EXTERNAL_LOGIN_NOTE,
      };
    }
    if (probe.confirmedUnauthenticated) {
      return { account: null };
    }
  }

  return keyringCheckedCleanly
    ? { account: null }
    : { account: null, note: NO_LOGIN_FILE_NOTE };
}

/** Build the command that logs Antigravity in with Google over pipes. */
export function antigravityLoginCommand(
  program: string,
  env?: Record<string, string>,
): LoginCommand {
  return {
    program,
    args: ["acp", "--login"],
    env: loginEnv(env),
    failsOn: LOGIN_FAILS_ON,
  };
}

function unlinkTokenFile(tokenPath: string): Error | null {
  try {
    fs.unlinkSync(tokenPath);
    return null;
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return null;
    }
    return new Error(`Cannot remove the Antigravity login: ${errorMessage(err)}`);
  }
}

function finalizeLogoutErrors(fileErr: Error | null, keyringResult: KeyringDeleteResult | null): void {
  if (fileErr !== null) {
    throw fileErr;
  }
  if (keyringResult !== null && keyringResult.kind === "error") {
    throw new Error(
      `Cannot remove the Antigravity login from the system keyring: ${keyringResult.reason}`,
    );
  }
}

/**
 * Synchronously log Antigravity out by removing its login token file and (when not isolated to a
 * specific `homeDir`) its OS keyring entry. Succeeds if already logged out.
 */
export function logoutAntigravity(
  homeDir?: string,
  options: LogoutAccountOptions = {},
): void {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const tokenPath = agyTokenFile(homeDir, env, platform);
  const fileErr = unlinkTokenFile(tokenPath);

  const keyringBackend: SyncKeyringBackend | null =
    options.keyring !== undefined
      ? options.keyring
      : homeDir === undefined
        ? createSystemKeyringBackend(platform, env)
        : null;
  const keyringResult =
    keyringBackend !== null
      ? keyringBackend.deleteSync(AGY_KEYRING_SERVICE, AGY_KEYRING_USER)
      : null;

  finalizeLogoutErrors(fileErr, keyringResult);
}

/**
 * Asynchronously log Antigravity out by removing both its login token file and its OS keyring entry.
 * Succeeds if already logged out.
 */
export async function logoutAntigravityAsync(
  options: LogoutAccountAsyncOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const tokenPath = agyTokenFile(options.homeDir, env, platform);
  const fileErr = unlinkTokenFile(tokenPath);

  const keyringBackend: KeyringBackend | null =
    options.keyring !== undefined
      ? options.keyring
      : options.homeDir === undefined
        ? createSystemKeyringBackend(platform, env)
        : null;
  const keyringResult =
    keyringBackend !== null
      ? await keyringBackend.delete(AGY_KEYRING_SERVICE, AGY_KEYRING_USER)
      : null;

  finalizeLogoutErrors(fileErr, keyringResult);
}

/** Terminate a spawned child process (and its process group on Unix / process tree on Windows). */
function killChildTree(child: ChildProcessByStdio<Writable, Readable, Readable>): void {
  const pid = child.pid;
  if (pid !== undefined && pid > 0) {
    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Ignore if taskkill fails or process already exited.
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
    // Ignore if already exited.
  }
}

interface LoginOutcome {
  ok: boolean;
  success: boolean;
  error?: string;
}

interface LoginSessionConfig {
  timeoutMs: number;
  onFinished: () => void;
}

/**
 * One active (or completed) Antigravity CLI login child process running over pipes.
 * Handles ANSI stripping, `https://` link extraction, bounded output tail, `failsOn`
 * detection, stdin line writing, cancellation, and timeout.
 */
export class LoginSession {
  readonly id: number;
  private readonly view: LoginView;
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly command: LoginCommand;
  private readonly onFinished: () => void;
  private stdin: Writable | null;
  private writingStdin = false;
  private raw = "";
  private archivedLinks: string[] = [];
  private settled = false;
  private processExited = false;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private exitDrainHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly waiters = new Set<() => void>();
  private readonly donePromise: Promise<void>;
  private resolveDone!: () => void;

  private constructor(
    id: number,
    command: LoginCommand,
    child: ChildProcessByStdio<Writable, Readable, Readable>,
    config: LoginSessionConfig,
  ) {
    this.id = id;
    this.command = command;
    this.child = child;
    this.stdin = child.stdin;
    this.onFinished = config.onFinished;
    this.view = {
      id,
      state: "running",
      links: [],
      output: "",
    };
    this.donePromise = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });

    this.timeoutHandle = setTimeout(() => {
      this.finish({
        ok: false,
        success: false,
        error: "The login took more than ten minutes",
      });
    }, config.timeoutMs);
    if (typeof this.timeoutHandle.unref === "function") {
      this.timeoutHandle.unref();
    }
  }

  /** Spawn a login command over pipes and attach event-driven stream/exit handlers. */
  static async start(
    id: number,
    command: LoginCommand,
    config: LoginSessionConfig,
  ): Promise<LoginSession> {
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...command.env,
    };

    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(command.program, command.args, {
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      throw new Error(`Cannot run ${command.program}: ${errorMessage(err)}`);
    }

    // Prevent unhandled EPIPE if the child exits while stdin is being written.
    child.stdin.on("error", () => {});

    // Buffer early output chunks before spawn confirmation so fast commands never lose output.
    const earlyChunks: string[] = [];
    let session: LoginSession | null = null;
    let openStreams = 2;
    let exitedStatus: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let spawnSettled = false;

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const deliverText = (chunk: string): void => {
      if (chunk.length === 0) return;
      if (session !== null) {
        session.handleChunk(chunk);
      } else {
        earlyChunks.push(chunk);
      }
    };

    const onStreamClosed = (decoder: StringDecoder): void => {
      const rest = decoder.end();
      if (rest.length > 0) {
        deliverText(rest);
      }
      openStreams -= 1;
      if (openStreams <= 0 && session !== null) {
        session.onStreamsDrained(exitedStatus);
      }
    };

    const attachStream = (stream: Readable, decoder: StringDecoder): void => {
      let ended = false;
      const done = () => {
        if (ended) return;
        ended = true;
        onStreamClosed(decoder);
      };
      stream.on("data", (chunk: Buffer) => {
        deliverText(decoder.write(chunk));
      });
      stream.once("end", done);
      stream.once("close", done);
      stream.on("error", done);
    };

    attachStream(child.stdout, stdoutDecoder);
    attachStream(child.stderr, stderrDecoder);

    child.once("exit", (code, signal) => {
      exitedStatus = { code, signal };
      if (session !== null) {
        session.onProcessExit(exitedStatus, openStreams <= 0);
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        if (spawnSettled) return;
        spawnSettled = true;
        child.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        if (spawnSettled) return;
        spawnSettled = true;
        child.off("spawn", onSpawn);
        reject(new Error(`Cannot run ${command.program}: ${err.message}`));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    // Post-spawn errors are handled via exit status.
    child.on("error", () => {});

    session = new LoginSession(id, command, child, config);
    for (const chunk of earlyChunks) {
      session.handleChunk(chunk);
    }
    earlyChunks.length = 0;

    if (exitedStatus !== null) {
      session.onProcessExit(exitedStatus, openStreams <= 0);
    } else if (openStreams <= 0) {
      session.onStreamsDrained(null);
    }

    return session;
  }

  /** Current immutable snapshot of this login session. */
  snapshot(): LoginView {
    return {
      id: this.view.id,
      state: this.view.state,
      links: [...this.view.links],
      output: this.view.output,
    };
  }

  /** Whether this login session is still running. */
  isRunning(): boolean {
    return this.view.state === "running";
  }

  /** Resolves once the login session finishes (`done` or `failed`). */
  whenDone(): Promise<void> {
    return this.donePromise;
  }

  /** Wait until a sign-in link appears, the session finishes, or `ms` elapses. */
  waitForLinkOrExit(ms: number): Promise<void> {
    if (this.view.state !== "running" || this.view.links.length > 0 || ms <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let done = false;
      const check = () => {
        if (done) return;
        if (this.view.state !== "running" || this.view.links.length > 0) {
          finish();
        }
      };
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      this.waiters.add(check);
    });
  }

  /** Wait until the session finishes or `ms` elapses. */
  waitForExitOrTimeout(ms: number): Promise<void> {
    if (this.view.state !== "running" || ms <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let done = false;
      const check = () => {
        if (done) return;
        if (this.view.state !== "running") {
          finish();
        }
      };
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      this.waiters.add(check);
    });
  }

  /** Write a single line (followed by `\n`) to the login process's stdin pipe. */
  async writeLine(line: string): Promise<void> {
    if (this.view.state !== "running" || this.stdin === null || this.writingStdin) {
      throw new Error("No login is waiting");
    }
    const pipe = this.stdin;
    if (pipe.destroyed || pipe.writableEnded) {
      this.stdin = null;
      throw new Error("No login is waiting");
    }
    this.writingStdin = true;
    const payload = Buffer.from(`${line}\n`, "utf8");
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          pipe.off("error", onError);
        };
        const onError = (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`The login is no longer listening: ${err.message}`));
        };
        pipe.once("error", onError);
        pipe.write(payload, (err?: Error | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (err) {
            reject(new Error(`The login is no longer listening: ${err.message}`));
          } else {
            resolve();
          }
        });
      });
    } finally {
      this.writingStdin = false;
      if (this.view.state !== "running") {
        this.closeStdin();
      }
    }
  }

  /** Cancel this login session if it is still running. */
  cancel(): void {
    this.closeStdin();
    this.finish({
      ok: false,
      success: false,
      error: "Cancelled",
    });
  }

  private notifyWaiters(): void {
    for (const waiter of Array.from(this.waiters)) {
      waiter();
    }
  }

  private closeStdin(): void {
    const pipe = this.stdin;
    this.stdin = null;
    if (pipe !== null && !pipe.destroyed && !pipe.writableEnded) {
      try {
        pipe.end();
      } catch {
        // Ignore close errors on already-broken pipe.
      }
    }
  }

  private compactRawIfNeeded(): void {
    if (this.raw.length <= MAX_RAW_CHARS) {
      return;
    }
    const targetDrop = this.raw.length - MIN_RAW_KEEP_CHARS;
    let cut = this.raw.indexOf("\n", targetDrop);
    if (cut !== -1) {
      cut += 1;
    } else if (this.raw.length > MAX_RAW_CHARS * 2) {
      cut = targetDrop;
      // Avoid splitting a UTF-16 surrogate pair.
      const code = this.raw.charCodeAt(cut);
      if (code >= 0xdc00 && code <= 0xdfff) {
        cut += 1;
      }
    } else {
      return;
    }
    const dropped = this.raw.slice(0, cut);
    this.raw = this.raw.slice(cut);
    const seen = new Set(this.archivedLinks);
    for (const link of links(clean(dropped))) {
      if (!seen.has(link)) {
        seen.add(link);
        this.archivedLinks.push(link);
      }
    }
  }

  private updateFromRaw(): string {
    this.compactRawIfNeeded();
    const cleaned = clean(this.raw);
    const recentLinks = links(cleaned);
    if (this.archivedLinks.length === 0) {
      this.view.links = recentLinks;
    } else {
      const merged = [...this.archivedLinks];
      const seen = new Set(merged);
      for (const link of recentLinks) {
        if (!seen.has(link)) {
          seen.add(link);
          merged.push(link);
        }
      }
      this.view.links = merged;
    }
    this.view.output = tail(cleaned);
    return cleaned;
  }

  private handleChunk(chunk: string): void {
    if (this.settled) return;
    this.raw += chunk;
    const cleaned = this.updateFromRaw();
    const failed =
      this.command.failsOn !== undefined && cleaned.includes(this.command.failsOn);
    if (failed) {
      this.finish({ ok: true, success: false });
      return;
    }
    this.notifyWaiters();
  }

  private onProcessExit(
    status: { code: number | null; signal: NodeJS.Signals | null },
    streamsDrained: boolean,
  ): void {
    this.processExited = true;
    if (this.settled) return;
    if (streamsDrained) {
      this.finalizeWithStatus(status, true);
      return;
    }
    // Let the last output in before saying how it ended (up to 200ms).
    if (this.exitDrainHandle === null) {
      this.exitDrainHandle = setTimeout(() => {
        this.exitDrainHandle = null;
        this.finalizeWithStatus(status, false);
      }, EXIT_DRAIN_MS);
      if (typeof this.exitDrainHandle.unref === "function") {
        this.exitDrainHandle.unref();
      }
    }
  }

  private onStreamsDrained(
    exitedStatus: { code: number | null; signal: NodeJS.Signals | null } | null,
  ): void {
    if (this.settled) return;
    if (exitedStatus !== null) {
      this.finalizeWithStatus(exitedStatus, true);
    }
  }

  private finalizeWithStatus(
    status: {
      code: number | null;
      signal: NodeJS.Signals | null;
    },
    streamsDrained: boolean,
  ): void {
    if (this.settled) return;
    this.updateFromRaw();
    this.finish(
      {
        ok: true,
        success: status.code === 0 && status.signal === null,
      },
      streamsDrained,
    );
  }

  private finish(outcome: LoginOutcome, cleanExitDrained = false): void {
    if (this.settled) return;
    this.settled = true;

    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (this.exitDrainHandle !== null) {
      clearTimeout(this.exitDrainHandle);
      this.exitDrainHandle = null;
    }

    this.closeStdin();
    if (!(this.processExited && cleanExitDrained)) {
      killChildTree(this.child);
    }

    // Destroy readable streams so lingering grandchildren cannot keep handles open.
    try {
      this.child.stdout.destroy();
    } catch {
      // ignore
    }
    try {
      this.child.stderr.destroy();
    } catch {
      // ignore
    }

    this.view.state = outcome.ok && outcome.success ? "done" : "failed";
    if (!outcome.ok && outcome.error !== undefined) {
      this.view.output = tail(`${this.view.output}\n${outcome.error}`);
    }

    this.notifyWaiters();
    this.onFinished();
    this.resolveDone();
  }
}

/**
 * Manages Antigravity account views, logout, and at most one active `agy acp --login`
 * session at a time. Held by `App` without any circular dependency.
 */
export class AccountsState {
  private current: LoginSession | null = null;
  private nextId = 0;
  private readonly loginTimeoutMs: number;
  private readonly linkWaitMs: number;
  private readonly inputWaitMs: number;
  private readonly onCredentialsChanged?: () => void;

  constructor(options: AccountsStateOptions = {}) {
    this.loginTimeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    this.linkWaitMs = options.linkWaitMs ?? DEFAULT_LINK_WAIT_MS;
    this.inputWaitMs = options.inputWaitMs ?? DEFAULT_INPUT_WAIT_MS;
    this.onCredentialsChanged = options.onCredentialsChanged;
  }

  /** Antigravity's account status, with any login in progress. */
  async accountsView(kernels: AccountKernels): Promise<AccountsView> {
    const installed = kernels.installed
      ? kernels.installed("antigravity")
      : kernels.unavailable("antigravity") === undefined;
    let account: AntigravityAccount | null = null;
    let note: string | null = null;
    let problem: string | null = null;
    if (installed) {
      try {
        const status = kernels.account
          ? await kernels.account()
          : await Promise.reject(new Error("Antigravity CLI account cannot be managed from here"));
        account = status.account;
        note = status.note ?? null;
      } catch (err) {
        problem = errorMessage(err);
      }
    }
    return {
      installed,
      problem,
      account,
      note,
      login: this.loginView(),
    };
  }

  /** The login in progress or the last one, if any. */
  loginView(): LoginView | null {
    return this.current !== null ? this.current.snapshot() : null;
  }

  /** Start logging Antigravity in; a login still in progress is ended first. */
  async startLogin(
    kernels: AccountKernels,
    value: unknown = {},
    onComplete?: () => void,
  ): Promise<{ login: LoginView | null }> {
    emptyObject(value);
    const command = kernels.login
      ? kernels.login()
      : (() => {
          throw new Error("Antigravity CLI cannot log in from here");
        })();
    this.cancelLogin();

    const id = ++this.nextId;
    const session = await LoginSession.start(id, command, {
      timeoutMs: this.loginTimeoutMs,
      onFinished: () => {
        this.onCredentialsChanged?.();
        onComplete?.();
      },
    });
    this.current = session;

    // Give the program a moment to print its link (or finish early).
    await session.waitForLinkOrExit(this.linkWaitMs);
    return { login: this.loginView() };
  }

  /** Pass what the person pasted, such as an authorization code or redirect URL, to the login. */
  async loginInput(value: unknown): Promise<{ login: LoginView | null }> {
    if (!isRecord(value)) {
      throw new Error("Expected a JSON object");
    }
    for (const key of Object.keys(value)) {
      if (key !== "text") {
        throw new Error(`Unknown field ${key}`);
      }
    }
    if (typeof value.text !== "string") {
      throw new Error("text is required");
    }
    const text = value.text.trim();
    if (text.includes("\n") || Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
      throw new Error("Paste one line");
    }
    const session = this.current;
    if (session === null || !session.isRunning()) {
      throw new Error("No login is waiting");
    }
    await session.writeLine(text);
    // Give the login process a moment to answer (or return immediately if it exits).
    await session.waitForExitOrTimeout(this.inputWaitMs);
    return { login: this.loginView() };
  }

  /** End the login in progress, if any. */
  cancelLogin(): void {
    if (this.current !== null && this.current.isRunning()) {
      this.current.cancel();
    }
  }

  /** Log Antigravity out and return the refreshed accounts view. */
  async logout(
    kernels: AccountKernels,
    value: unknown = {},
    onLogout?: () => void,
  ): Promise<AccountsView> {
    emptyObject(value);
    if (kernels.logout) {
      await kernels.logout();
    } else {
      throw new Error("Antigravity CLI cannot log out from here");
    }
    this.onCredentialsChanged?.();
    onLogout?.();
    return await this.accountsView(kernels);
  }

  /** Release any running login process (e.g. during application shutdown). */
  dispose(): void {
    this.cancelLogin();
  }
}

export { AccountsState as AccountManager, AccountsState as Logins };
