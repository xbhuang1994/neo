/**
 * The Antigravity kernel: one `agy` process per Session in its headless print mode, driven by
 * stream-json lines on its standard input and output.
 *
 * The runtime takes the Session's system prompt, built-in tools and extensions from a custom
 * agent. The driver writes that agent, with a plugin carrying the host's MCP server and its hooks,
 * into a bridge folder beside the Session's working directory and adds the folder to the runtime's
 * workspace. Antigravity orders its workspace folders by path and works in the first, and the
 * bridge's path extends the working directory's, so it always comes second.
 *
 * The host's tools reach the model through an MCP server on the loopback interface, which answers
 * only the bearer token written into the plugin. Every tool call, the main conversation's and its
 * subagents', runs a `PreToolUse` hook first: a relay program posts it to the same server, the
 * guard judges it, and a refusal reaches the model with its reason. A hook that fails refuses the
 * call. `Stop` hooks tell whether background commands or subagents still run, which the stream
 * only shows once they end. The runtime keeps its conversations itself, and `--conversation`
 * continues one in a new process.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Proc } from "./process.ts";
import type { Launch, Line } from "./process.ts";
import type { Driver, DriverEvent } from "./session.ts";
import {
  GUARD_ALLOW,
  errorMessage,
  guardBlock,
  isRecord,
  nowMs,
  textBlock,
  uuid,
} from "./types.ts";
import type {
  Block,
  Deliver,
  Guard,
  KernelJob,
  Message,
  ToolHost,
  ToolSpec,
  UnboundedChannel,
} from "./types.ts";
import { VERSION } from "../version.ts";

/** The plugin that carries the host's MCP server and hooks. */
export const PLUGIN = "neo";

/** The MCP server, inside the plugin, that carries the host's tools. */
export const MCP_SERVER = "neo";

/** The custom agent a Session runs as. */
export const AGENT = "neo-session";

/** Package version reported in MCP serverInfo and plugin manifest. */
export const PKG_VERSION = VERSION;

/** The name the model gives the host's MCP server when it calls `call_mcp_tool`: plugin + server. */
export function mcpServerName(): string {
  return `${PLUGIN}_${MCP_SERVER}`;
}

/** A thinking level as Antigravity's `--effort`: `undefined` keeps the model's own. */
export function effortOf(level?: string): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  switch (level) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return undefined;
  }
}

/** The kinds of built-in tool a Session may be allowed, in the host's words. */
export const TOOL_KINDS = ["read", "bash", "edit", "write", "task", "web"] as const;

const TOOL_KIND_SET: ReadonlySet<string> = new Set(TOOL_KINDS);

/** The runtime's tools for each kind (Antigravity CLI 1.5.14 toolset). */
function runtimeTools(kind: string): readonly string[] {
  switch (kind) {
    case "read":
      return ["view_file", "list_dir", "grep_search", "find_by_name"];
    case "bash":
      return ["run_command", "command_status", "send_command_input", "manage_task", "wait", "schedule"];
    case "web":
      return ["read_url_content", "search_web"];
    case "edit":
      return ["replace_file_content", "multi_replace_file_content"];
    case "write":
      return ["write_to_file"];
    case "task":
      return ["invoke_subagent", "manage_subagents", "define_subagent", "send_message", "run_workflow"];
    default:
      return [];
  }
}

/** How an Antigravity Session runs. */
export interface AntigravityOptions {
  /** The `agy` executable. */
  program: string;
  /** The Session's working directory. */
  cwd: string;
  /** What the Session adds to the runtime's own system prompt. */
  systemPrompt?: string;
  /** The built-in tool kinds the model may use: of `TOOL_KINDS`. */
  tools?: string[];
  /** The model, or the runtime's default. */
  model?: string;
  /** The thinking level, as in settings. */
  thinking?: string;
  /** Variables to set for the runtime. */
  env?: Record<string, string>;
  /**
   * The program, and its first arguments, that relays a hook to this driver: the hook's URL
   * follows them. It is `neo-agent agy-hook` in the application, which runs `relayHook`.
   */
  hookRelay?: string[];
  /**
   * A name for the Session's bridge folder that stays the same across its processes. The runtime
   * keeps a conversation's workspace folders from when it began, and its subagents load hooks from
   * those, so a continued conversation needs its bridge where it was. Without one, each process
   * gets a folder of its own.
   */
  bridgeId?: string;
}

/** The folder beside `cwd` that carries a Session's agent and plugin. Its path extends `cwd`'s, so it sorts after it. */
export function bridgeDir(cwd: string, id: string): string {
  return `${cwd}.neo-${id}`;
}

/** The file that marks a bridge folder as the driver's: the host's process id, then a stamp of the process it is for. */
const BRIDGE_MARKER = ".neo-bridge";

/** A command line for `sh -c`, or `cmd /c` on Windows. */
export function shellCommand(words: readonly string[]): string {
  const isWin = process.platform === "win32";
  return words
    .map((word) =>
      isWin ? `"${word.replaceAll('"', '""')}"` : `'${word.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");
}

/** The custom agent's file: its plugin, its built-in tools, and the Session's prompt. */
export function agentFile(options: AntigravityOptions): string {
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const kind of options.tools ?? []) {
    for (const tool of runtimeTools(kind)) {
      if (!seen.has(tool)) {
        seen.add(tool);
        tools.push(tool);
      }
    }
  }
  const prompt = (options.systemPrompt ?? "").replace(/\s+$/, "");
  return `---\nname: ${AGENT}\ndescription: A Neo Session.\nplugins:\n  - ${PLUGIN}\ntools: [${tools.join(", ")}]\n---\n${prompt}\n`;
}

/** The plugin's hooks: every tool call is judged before it runs; ends of commands, session starts and turns are reported. */
export function hooksFile(command: string): Record<string, unknown> {
  const handler = (timeout: number) => [{ type: "command", command, timeout }];
  return {
    [PLUGIN]: {
      PreToolUse: [{ matcher: "*", hooks: handler(600) }],
      PostToolUse: [{ matcher: "run_command", hooks: handler(30) }],
      SessionStart: handler(30),
      Stop: handler(30),
    },
  };
}

/** The command line and environment of an Antigravity process. */
export function launch(options: AntigravityOptions, bridge: string, resume?: string): Launch {
  const args: string[] = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--add-dir",
    bridge,
    "--agent",
    AGENT,
  ];
  // Since 1.5.7 the CLI starts in auto mode, which runs commands in a terminal sandbox with no
  // network and asks a person before leaving it, and out of it every command waits for a person's
  // review; nobody is there to answer either. Neo's PreToolUse hook decides instead, so commands
  // run on this machine and reach its network.
  // Keep keys in canonical alphabetical order matching Rust `serde_json::json!`.
  const settings = {
    agentMode: "",
    permissions: { allow: [`mcp(${mcpServerName()}/*)`] },
    toolPermission: "always-proceed",
  };
  args.push("--settings", JSON.stringify(settings));
  if (options.model !== undefined && options.model.length > 0) {
    args.push("--model", options.model);
  }
  const effort = effortOf(options.thinking);
  if (effort !== undefined) {
    args.push("--effort", effort);
  }
  if (resume !== undefined) {
    args.push("--conversation", resume);
  }
  // Print mode, its prompts coming as stream-json lines.
  args.push("-p=");
  return {
    program: options.program,
    args,
    cwd: options.cwd,
    env: { ...(options.env ?? {}) },
    envRemove: [],
  };
}

/** A runtime tool call in the host's words: the kind or host tool it is, and the input the guard judges. */
export function hostView(tool: string, input: unknown): [string, unknown] {
  const obj = isRecord(input) ? input : {};
  const pathObj = (): { path: string } => {
    for (const field of ["Path", "TargetFile", "AbsolutePath", "File"]) {
      const val = obj[field];
      if (typeof val === "string") {
        return { path: val };
      }
    }
    return { path: "" };
  };
  switch (tool) {
    case "run_command":
      return ["bash", { command: typeof obj.CommandLine === "string" ? obj.CommandLine : "" }];
    case "send_command_input":
      return ["bash", { command: typeof obj.Input === "string" ? obj.Input : "" }];
    case "schedule":
      return ["bash", input];
    case "write_file":
    case "write_to_file":
      return ["write", pathObj()];
    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
    case "notebook_edit":
      return ["edit", pathObj()];
    case "read_file":
    case "view_file":
    case "list_dir":
    case "grep_search":
    case "find_by_name":
      return ["read", input];
    case "invoke_subagent":
    case "browser_subagent":
    case "run_workflow":
      return ["task", input];
    case "define_subagent":
    case "manage_subagents":
    case "send_message":
      return ["task_manage", input];
    default:
      return [tool, input];
  }
}

/** Arguments Antigravity adds to every tool call for its own display; a tool that does not declare one never sees it. */
const INJECTED_ARGUMENTS: ReadonlySet<string> = new Set([
  "toolSummary",
  "explanation",
  "toolAction",
  "waitForPreviousTools",
]);

/** Remove Antigravity display arguments that the tool schema does not declare. */
export function stripInjected(spec: ToolSpec | undefined, args: unknown): unknown {
  if (!isRecord(args)) return args;
  const props = spec && isRecord(spec.schema.properties) ? spec.schema.properties : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!INJECTED_ARGUMENTS.has(key) || (props !== undefined && Object.prototype.hasOwnProperty.call(props, key))) {
      out[key] = value;
    }
  }
  return out;
}

/** Parse the tab-separated output of `agy models` into `[id, displayName]` pairs. */
export function parseModels(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const tab = rawLine.indexOf("\t");
    if (tab === -1) continue;
    const id = rawLine.slice(0, tab).trim();
    const name = rawLine.slice(tab + 1).trim();
    if (id.length > 0 && !id.includes(" ")) {
      out.push([id, name]);
    }
  }
  return out;
}

/** Merge override variables on top of `baseEnv`, deduplicating case-insensitively on Windows. */
function mergeChildEnv(
  baseEnv: Record<string, string | undefined>,
  overrides?: Record<string, string>,
): Record<string, string | undefined> {
  if (!overrides || Object.keys(overrides).length === 0) {
    return { ...baseEnv };
  }
  const merged: Record<string, string | undefined> = { ...baseEnv };
  if (process.platform === "win32") {
    const existingByLower = new Map<string, string>();
    for (const key of Object.keys(merged)) {
      existingByLower.set(key.toLowerCase(), key);
    }
    for (const [key, value] of Object.entries(overrides)) {
      const prior = existingByLower.get(key.toLowerCase());
      if (prior !== undefined && prior !== key) {
        delete merged[prior];
      }
      merged[key] = value;
      existingByLower.set(key.toLowerCase(), key);
    }
    return merged;
  }
  return { ...merged, ...overrides };
}

/** The models `agy models` lists: `[id, displayName]` pairs. */
export async function listModels(
  program: string,
  env?: Record<string, string>,
  timeoutMs = 60_000,
): Promise<Array<[string, string]>> {
  const childEnv = mergeChildEnv(process.env, env);
  const needsWinShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(program);
  return await new Promise<Array<[string, string]>>((resolve, reject) => {
    let settled = false;
    const child = spawn(program, ["models"], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: needsWinShell,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      const seconds = Math.max(1, Math.round(timeoutMs / 1000));
      reject(new Error(`Antigravity did not list its models within ${seconds} seconds`));
    }, timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Cannot run ${program}: ${err.message}`));
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || signal !== null) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
        const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
        const why = stderrText.length > 0 ? stderrText : stdoutText;
        const statusDesc = code !== null ? `exit status: ${code}` : `signal: ${signal}`;
        reject(new Error(`Antigravity cannot list its models: ${why.length > 0 ? why : statusDesc}`));
        return;
      }
      resolve(parseModels(Buffer.concat(stdoutChunks).toString("utf8")));
    });
  });
}

function parseHttpUrl(url: string): { host: string; port: number; address: string; reqPath: string } {
  if (!url.startsWith("http://")) {
    throw new Error("The hook URL is not http");
  }
  const rest = url.slice("http://".length);
  const slash = rest.indexOf("/");
  const address = slash === -1 ? rest : rest.slice(0, slash);
  const reqPath = slash === -1 ? "/" : rest.slice(slash);
  const colon = address.lastIndexOf(":");
  let host = address;
  let port = 80;
  if (colon !== -1 && !address.endsWith("]")) {
    host = address.slice(0, colon);
    const parsedPort = Number(address.slice(colon + 1));
    if (Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535) {
      port = parsedPort;
    }
  }
  return { host, port, address, reqPath };
}

async function readInputBytes(input: NodeJS.ReadableStream | Uint8Array | string): Promise<Buffer> {
  if (typeof input === "string") {
    return Buffer.from(input, "utf8");
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(new Error(`Cannot read the hook's input: ${err.message}`));
    };
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

async function writeOutputBytes(
  output: { write(chunk: Uint8Array, cb?: (err?: Error | null) => void): unknown },
  data: Buffer,
): Promise<void> {
  if (data.length === 0) return;
  try {
    // Check if `output` is a Node Writable stream (has `writable` / `once`).
    const maybeStream = output as NodeJS.WritableStream;
    if (typeof maybeStream.once === "function" && typeof maybeStream.write === "function") {
      await new Promise<void>((resolve, reject) => {
        maybeStream.write(data, (err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      output.write(data);
    }
  } catch (err) {
    throw new Error(`Cannot write the hook's answer: ${errorMessage(err)}`);
  }
}

/**
 * Relay one hook: the hook's input, read from `stdin`, is posted to `url` with a single-buffer
 * HTTP/1.1 POST over `node:net` with `TCP_NODELAY`, and the answer is written to `stdout`.
 * Antigravity runs this as the hook's command; an error makes the command fail, which refuses a tool call.
 */
export async function relayHook(
  url: string,
  stdin: NodeJS.ReadableStream | Uint8Array | string = process.stdin,
  stdout: { write(chunk: Uint8Array, cb?: (err?: Error | null) => void): unknown } = process.stdout,
): Promise<void> {
  const { host, port, address, reqPath } = parseHttpUrl(url);
  const body = await readInputBytes(stdin);

  const head = Buffer.from(
    `POST ${reqPath} HTTP/1.1\r\nHost: ${address}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
    "utf8",
  );
  const requestBuf = Buffer.concat([head, body]);

  const reply = await new Promise<Buffer>((resolve, reject) => {
    let connected = false;
    let sent = false;
    let settled = false;
    const chunks: Buffer[] = [];
    const socket = net.createConnection({ host, port });

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(message));
    };

    socket.on("connect", () => {
      connected = true;
      socket.setNoDelay(true);
      // The guard may take its time; Antigravity's own limit on the hook ends it first.
      socket.setTimeout(900_000);
      socket.write(requestBuf, (err?: Error | null) => {
        if (err) {
          fail(`Cannot send the hook to Neo: ${err.message}`);
        } else {
          sent = true;
        }
      });
    });

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    socket.on("timeout", () => {
      fail("Neo did not answer the hook: timed out");
    });

    socket.on("error", (err: Error) => {
      if (!connected) {
        fail(`Cannot reach Neo at ${address}: ${err.message}`);
      } else if (!sent) {
        fail(`Cannot send the hook to Neo: ${err.message}`);
      } else {
        fail(`Neo did not answer the hook: ${err.message}`);
      }
    });

    socket.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    socket.on("close", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
  });

  const split = reply.indexOf("\r\n\r\n");
  if (split === -1) {
    throw new Error("Neo's answer to the hook is malformed");
  }
  const statusLine = reply.subarray(0, split).toString("utf8");
  const status = statusLine.split(/\s+/)[1] ?? "";
  if (status !== "200") {
    throw new Error(`Neo answered the hook with status ${status}`);
  }
  await writeOutputBytes(stdout, reply.subarray(split + 4));
}

export type HookHandler = (payload: unknown) => Promise<Record<string, unknown>>;

/** The largest request body the host server reads (16 MiB). */
const BODY_LIMIT = 16 << 20;

/** Maximum HTTP header block size (64 KiB). */
const HEADER_LIMIT = 64 * 1024;

interface ServerRoutes {
  host: ToolHost;
  token: string;
  bearer: string;
  hookPath: string;
  onToolCall?: () => void;
  onHook?: HookHandler;
}

/** The host's tools as an MCP server, and the hooks' endpoint, on the loopback interface. */
export class HostServer {
  readonly port: number;
  readonly token: string;
  private readonly server: net.Server;
  private readonly sockets: Set<net.Socket>;
  private closed = false;

  constructor(port: number, token: string, server: net.Server, sockets: Set<net.Socket>) {
    this.port = port;
    this.token = token;
    this.server = server;
    this.sockets = sockets;
  }

  mcpUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  hookUrl(): string {
    return `http://127.0.0.1:${this.port}/hook/${this.token}`;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    try {
      this.server.close();
    } catch {
      // ignore
    }
  }
}

function statusReason(status: number): string {
  switch (status) {
    case 200:
      return "OK";
    case 202:
      return "Accepted";
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 405:
      return "Method Not Allowed";
    default:
      return "Payload Too Large";
  }
}

function writeHttpResponse(socket: net.Socket, status: number, body: unknown | undefined): Promise<boolean> {
  if (socket.destroyed || !socket.writable) {
    return Promise.resolve(false);
  }
  const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body), "utf8") : Buffer.alloc(0);
  let head = `HTTP/1.1 ${status} ${statusReason(status)}\r\nContent-Length: ${bodyBuf.length}\r\n`;
  if (bodyBuf.length > 0) {
    head += "Content-Type: application/json\r\n";
  }
  head += "\r\n";
  const frame = bodyBuf.length > 0 ? Buffer.concat([Buffer.from(head, "ascii"), bodyBuf]) : Buffer.from(head, "ascii");
  return new Promise<boolean>((resolve) => {
    socket.write(frame, (err?: Error | null) => {
      resolve(!err);
    });
  });
}

/** Answer one MCP JSON-RPC message; `undefined` for a notification. The guard judges every tool call before it runs. */
async function mcpAnswer(
  host: ToolHost,
  message: unknown,
  onToolCall?: () => void,
): Promise<Record<string, unknown> | undefined> {
  if (!isRecord(message)) return undefined;
  const id = message.id;
  if (id === undefined || id === null) return undefined;

  const method = typeof message.method === "string" ? message.method : "";
  const params = isRecord(message.params) ? message.params : {};

  switch (method) {
    case "initialize": {
      const protocolVersion =
        typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER, version: PKG_VERSION },
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: host.specs().map((spec) => ({
            name: spec.name,
            description: spec.description,
            inputSchema: spec.schema,
          })),
        },
      };
    case "tools/call": {
      if (onToolCall) {
        onToolCall();
        // Yield once so the Taken event is processed before tool side effects run.
        await Promise.resolve();
      }
      const name = typeof params.name === "string" ? params.name : "";
      const specs = host.specs();
      const spec = specs.find((item) => item.name === name);
      const rawArgs = "arguments" in params && params.arguments !== undefined ? params.arguments : {};
      const args = stripInjected(spec, rawArgs);
      const decision = host.guard ? await host.guard(name, args) : GUARD_ALLOW;
      if (decision.decision === "block") {
        return {
          jsonrpc: "2.0",
          id,
          result: { isError: true, content: [{ type: "text", text: decision.reason }] },
        };
      }
      try {
        const value = await host.call(name, args);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(value) }] },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          result: { isError: true, content: [{ type: "text", text: errorMessage(err) }] },
        };
      }
    }
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

function serveConnection(socket: net.Socket, routes: ServerRoutes): void {
  socket.setNoDelay(true);
  socket.on("error", () => {});

  // O(N) chunk accumulator to avoid O(N^2) Buffer.concat on large bodies.
  let chunks: Buffer[] = [];
  let totalLen = 0;
  let processing = false;
  let dirty = false;
  let closed = false;

  const coalesce = (): Buffer => {
    if (chunks.length === 0) return Buffer.alloc(0);
    if (chunks.length === 1) return chunks[0]!;
    const merged = Buffer.concat(chunks, totalLen);
    chunks = [merged];
    return merged;
  };

  const consume = (n: number): void => {
    if (n <= 0) return;
    if (n >= totalLen) {
      chunks = [];
      totalLen = 0;
      return;
    }
    const merged = coalesce();
    const rest = merged.subarray(n);
    chunks = [rest];
    totalLen = rest.length;
  };

  const drain = async (): Promise<void> => {
    if (processing || closed) return;
    processing = true;
    try {
      while (!closed && totalLen > 0) {
        dirty = false;
        const buf = coalesce();
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          if (buf.length > HEADER_LIMIT) {
            await writeHttpResponse(socket, 413, undefined);
            closed = true;
            socket.end();
          }
          return;
        }

        const headerText = buf.subarray(0, headerEnd).toString("latin1");
        const headerLines = headerText.split("\r\n");
        const requestLine = headerLines[0] ?? "";
        const parts = requestLine.trim().split(/\s+/);
        const method = parts[0] ?? "";
        const reqPath = parts[1] ?? "";
        const http11 = parts[2] === "HTTP/1.1";

        let contentLength = 0;
        let authorized = false;
        let closeConn = !http11;

        for (let i = 1; i < headerLines.length; i++) {
          const line = headerLines[i]!;
          const colon = line.indexOf(":");
          if (colon === -1) continue;
          const name = line.slice(0, colon).trim().toLowerCase();
          const value = line.slice(colon + 1).trim();
          switch (name) {
            case "content-length": {
              const parsed = /^\d+$/.test(value) ? Number(value) : Number.POSITIVE_INFINITY;
              contentLength = Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
              break;
            }
            case "authorization":
              authorized = value === routes.bearer;
              break;
            case "connection":
              closeConn = value.toLowerCase() === "close";
              break;
            case "transfer-encoding":
              contentLength = Number.POSITIVE_INFINITY;
              break;
          }
        }

        if (contentLength > BODY_LIMIT) {
          await writeHttpResponse(socket, 413, undefined);
          closed = true;
          socket.end();
          return;
        }

        const frameLen = headerEnd + 4 + contentLength;
        if (buf.length < frameLen) {
          // Wait for the rest of the body.
          return;
        }

        const bodyBuf = buf.subarray(headerEnd + 4, frameLen);
        // Copy body slice before advancing buffer so subsequent data events cannot alias.
        const bodyText = bodyBuf.toString("utf8");
        consume(frameLen);

        const isHook = reqPath === routes.hookPath;
        let status: number;
        let answer: unknown | undefined;

        if (!(authorized || isHook)) {
          status = 401;
        } else if (method !== "POST") {
          status = 405;
        } else {
          let parsed: unknown;
          let validJson = true;
          try {
            parsed = JSON.parse(bodyText);
          } catch {
            validJson = false;
          }
          if (!validJson) {
            status = 400;
          } else if (isHook) {
            status = 200;
            answer = routes.onHook ? await routes.onHook(parsed) : {};
          } else {
            const mcpReply = await mcpAnswer(routes.host, parsed, routes.onToolCall);
            if (mcpReply !== undefined) {
              status = 200;
              answer = mcpReply;
            } else {
              status = 202;
            }
          }
        }

        const ok = await writeHttpResponse(socket, status, answer);
        if (!ok || closeConn) {
          closed = true;
          socket.end();
          return;
        }
      }
    } finally {
      processing = false;
      if (!closed && dirty) {
        void drain();
      }
    }
  };

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    chunks.push(chunk);
    totalLen += chunk.length;
    dirty = true;
    if (!processing) {
      void drain();
    }
  });

  socket.on("close", () => {
    closed = true;
  });
}

/** Start a loopback HTTP/1.1 keep-alive server for MCP tools and Antigravity hooks. */
export async function startHostServer(
  host: ToolHost,
  onToolCall?: () => void,
  onHook?: HookHandler,
): Promise<HostServer> {
  const token = uuid().replaceAll("-", "") + uuid().replaceAll("-", "");
  const routes: ServerRoutes = {
    host,
    token,
    bearer: `Bearer ${token}`,
    hookPath: `/hook/${token}`,
    onToolCall,
    onHook,
  };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    serveConnection(socket, routes);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      reject(new Error(`Cannot open the tool server: ${err.message}`));
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    server.close();
    throw new Error("Cannot open the tool server: missing bound port");
  }
  return new HostServer(addr.port, token, server, sockets);
}

/** Remove bridges beside `cwd` that a host process which no longer runs left behind. */
function sweepBridges(cwd: string): void {
  if (process.platform === "win32") return;
  const parent = path.dirname(cwd);
  const name = path.basename(cwd);
  if (!name || parent === cwd) return;
  const prefix = `${name}.neo-`;
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const full = path.join(parent, entry);
    let owner: string;
    try {
      owner = fs.readFileSync(path.join(full, BRIDGE_MARKER), "utf8");
    } catch {
      continue;
    }
    const pidStr = owner.trim().split(/\s+/)[0] ?? "";
    const pid = Number.parseInt(pidStr, 10);
    if (!Number.isFinite(pid)) continue;
    let alive = false;
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === "EPERM") {
          alive = true;
        }
      }
    }
    if (!alive) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

/**
 * The bridge folder of a running process: removed when the process ends, unless a later process
 * of the Session has taken it over.
 */
class Bridge {
  readonly dir: string;
  private readonly stamp: string;
  private removed = false;

  private constructor(dir: string, stamp: string) {
    this.dir = dir;
    this.stamp = stamp;
  }

  static create(options: AntigravityOptions, server: HostServer, hasTools: boolean): Bridge {
    const dir = bridgeDir(options.cwd, options.bridgeId ?? uuid().slice(0, 8));
    sweepBridges(options.cwd);
    const agentsDir = path.join(dir, ".agents", "agents");
    const pluginDir = path.join(dir, ".agents", "plugins", PLUGIN);
    const stamp = `${process.pid} ${uuid()}`;
    try {
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(dir, BRIDGE_MARKER), stamp);
      fs.writeFileSync(path.join(agentsDir, `${AGENT}.md`), agentFile(options));
      const manifest = {
        name: PLUGIN,
        description: "Neo's tools and tool-call guard",
        version: PKG_VERSION,
      };
      fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest));
      const relay = [...(options.hookRelay ?? []), server.hookUrl()];
      const command =
        process.platform !== "win32" ? `exec ${shellCommand(relay)}` : shellCommand(relay);
      fs.writeFileSync(path.join(pluginDir, "hooks.json"), JSON.stringify(hooksFile(command)));
      const servers = hasTools
        ? {
            [MCP_SERVER]: {
              url: server.mcpUrl(),
              headers: { Authorization: `Bearer ${server.token}` },
            },
          }
        : {};
      fs.writeFileSync(
        path.join(pluginDir, "mcp_config.json"),
        JSON.stringify({ mcpServers: servers }),
      );
    } catch (err) {
      throw new Error(`Cannot write Antigravity's bridge at ${dir}: ${errorMessage(err)}`);
    }
    return new Bridge(dir, stamp);
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    try {
      const owner = fs.readFileSync(path.join(this.dir, BRIDGE_MARKER), "utf8");
      if (owner === this.stamp) {
        fs.rmSync(this.dir, { recursive: true, force: true });
      }
    } catch {
      // ignore if already gone
    }
  }

  /** Whether `targetPath` is inside (or equal to) the bridge folder. */
  holds(targetPath: string): boolean {
    if (!targetPath) return false;
    if (path.isAbsolute(this.dir) !== path.isAbsolute(targetPath)) return false;
    const rel = path.relative(this.dir, targetPath);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  }
}

/** Unicode code-point safe clipping, matching Rust `text.chars().take(max)`. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let i = 0;
  let count = 0;
  while (i < text.length && count < max) {
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    count += 1;
  }
  return text.slice(0, i);
}

/** A subagent's task: the start of the message that began its conversation, the first step of its transcript. */
function subagentTask(transcript: string): string | undefined {
  const filePath = transcript.startsWith("file://") ? transcript.slice("file://".length) : transcript;
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  } catch {
    return undefined;
  }
  let head: string;
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
    const slice = nl === -1 ? buf.subarray(0, bytesRead) : buf.subarray(0, nl);
    head = slice.toString("utf8");
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(head);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.content !== "string") return undefined;
  const content = parsed.content;
  const markerIdx = content.indexOf(" content=");
  const text = markerIdx === -1 ? content : content.slice(markerIdx + " content=".length);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length > 0 && !line.startsWith("<")) {
      return clip(line, 160);
    }
  }
  return undefined;
}

/** A tool call as a short line: the summary the model gave it, or its name. */
function toolActivity(tool: string, input: unknown): string {
  if (isRecord(input) && typeof input.toolSummary === "string") {
    const summary = input.toolSummary.trim();
    if (summary.length > 0) {
      return clip(summary, 160);
    }
  }
  return tool;
}

/** Extracts the Antigravity task id when `run_command` moves to a background task. */
function backgroundTaskId(output: string): string | undefined {
  const MARKER = "Tool is running as a background task with task id:";
  const idx = output.indexOf(MARKER);
  if (idx === -1) return undefined;
  const rest = output.slice(idx + MARKER.length).trimStart();
  const token = rest.split(/\s+/)[0] ?? "";
  const id = token.replace(/^["'.,;]+|["'.,;]+$/g, "");
  return id.length > 0 ? id : undefined;
}

/** True when `manage_task` output indicates the task is no longer running. */
function backgroundTaskDone(action: string, output: string): boolean {
  return (
    action.toLowerCase() === "kill" ||
    output.includes("Status: DONE") ||
    output.includes("Status: FAILED") ||
    output.includes("Status: CANCELED") ||
    output.includes("Status: CANCELLED") ||
    output.includes("canceled") ||
    output.includes("cancelled")
  );
}

const STANDARD_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeStrictBase64(data: string): Buffer | undefined {
  if (data.length % 4 === 1 || !STANDARD_BASE64_RE.test(data)) {
    return undefined;
  }
  return Buffer.from(data, "base64");
}

interface Subagent {
  startTime: number;
  label?: string;
  labelAttempts: number;
  activity?: string;
}

interface Turn {
  id: string;
  taken: boolean;
}

interface Command {
  conversation: string;
  command: string;
  startTime: number;
}

/** One Antigravity Session's runtime driver. */
export class AntigravityDriver implements Driver {
  private readonly options: AntigravityOptions;
  private readonly host: ToolHost;
  private readonly events: UnboundedChannel<DriverEvent>;

  private proc: Proc | undefined;
  private bridge: Bridge | undefined;
  private hostServer: HostServer | undefined;
  /** Grows with every process, so a late line from one that ended is ignored. */
  private generation = 0;
  /** The model and thinking level the running process was started with. */
  private startedWith: [string | undefined, string | undefined] = [undefined, undefined];
  /** The runtime's id of the main conversation. */
  private conversation: string | undefined;
  /** Messages handed to the runtime whose turn has not ended, oldest first. */
  private turns: Turn[] = [];
  /** The model said its turn is over while background work still runs. */
  private awaiting = false;
  /** What the model says in the step being streamed, and that step. */
  private text = "";
  private textStep: number | undefined;
  /** Tool steps already recorded, and those whose result was. */
  private readonly calls = new Set<number>();
  private readonly results = new Set<number>();
  /** Commands running synchronously, by tool call id. */
  private readonly commands = new Map<string, Command>();
  /** Background shell commands moved async by `run_command`, by Antigravity task id. */
  private readonly backgroundTasks = new Map<string, Command>();
  /** Subagents' conversations that have not stopped. */
  private readonly subagents = new Map<string, Subagent>();
  private closed = false;
  private model: string | undefined;
  private thinking: string | undefined;
  /** Serializes process startup / replacement. */
  private startingChain: Promise<void> = Promise.resolve();

  constructor(
    options: AntigravityOptions,
    host: ToolHost,
    events: UnboundedChannel<DriverEvent>,
  ) {
    this.options = options;
    this.host = host;
    this.events = events;
    this.model = options.model;
    this.thinking = options.thinking;
  }

  kernel(): string {
    return "antigravity";
  }

  private emit(event: DriverEvent): void {
    this.events.send(event);
  }

  /** Forget the process: what it ran is gone with it. */
  private reset(): { proc: Proc | undefined; bridge: Bridge | undefined } {
    this.generation += 1;
    this.turns.length = 0;
    this.awaiting = false;
    this.text = "";
    this.textStep = undefined;
    this.calls.clear();
    this.results.clear();
    this.commands.clear();
    this.backgroundTasks.clear();
    this.subagents.clear();
    const proc = this.proc;
    const bridge = this.bridge;
    this.proc = undefined;
    this.bridge = undefined;
    return { proc, bridge };
  }

  /** The runtime acts on the message whose turn runs: report it taken once. */
  private takeStarted(): void {
    const front = this.turns[0];
    if (front !== undefined && !front.taken) {
      front.taken = true;
      this.emit({ type: "taken", id: front.id });
    }
  }

  private async withStartingLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.startingChain;
    let release!: () => void;
    this.startingChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** The host's server, started once per driver. */
  private async ensureServer(): Promise<HostServer> {
    if (this.closed) {
      throw new Error("The session is closed");
    }
    if (this.hostServer !== undefined) {
      return this.hostServer;
    }
    const server = await startHostServer(
      this.host,
      () => this.takeStarted(),
      async (payload) => {
        if (this.closed) {
          return { decision: "deny", reason: "The Session has ended" };
        }
        return await this.handleHook(payload);
      },
    );
    if (this.closed) {
      server.close();
      throw new Error("The session is closed");
    }
    this.hostServer = server;
    return server;
  }

  /**
   * The running process, starting one that continues `resume` when none runs.
   * A process started with another model/thinking level is replaced once it has no turn.
   */
  private ensureProcess(resume?: string): Promise<Proc> {
    return this.withStartingLock(async () => {
      if (this.closed) {
        throw new Error("The session is closed");
      }
      const sameModel =
        this.startedWith[0] === this.model && this.startedWith[1] === this.thinking;
      if (this.proc !== undefined) {
        if (sameModel || this.turns.length > 0) {
          return this.proc;
        }
        const stale = this.reset();
        if (stale.proc !== undefined) {
          await stale.proc.close(2000);
        }
        if (stale.bridge !== undefined) {
          stale.bridge.remove();
        }
      }

      const server = await this.ensureServer();
      if (this.closed) {
        throw new Error("The session is closed");
      }

      const effectiveOptions: AntigravityOptions = {
        ...this.options,
        model: this.model,
        thinking: this.thinking,
      };
      const effectiveResume = this.conversation ?? resume;
      const hasTools = this.host.specs().length > 0;
      const bridge = Bridge.create(effectiveOptions, server, hasTools);

      if (this.closed) {
        bridge.remove();
        throw new Error("The session is closed");
      }

      let spawned: { proc: Proc; lines: UnboundedChannel<Line> };
      try {
        spawned = await Proc.spawn(launch(effectiveOptions, bridge.dir, effectiveResume));
      } catch (err) {
        bridge.remove();
        throw err;
      }

      if (this.closed) {
        await spawned.proc.close(2000);
        bridge.remove();
        throw new Error("The session is closed");
      }

      this.generation += 1;
      const gen = this.generation;
      this.proc = spawned.proc;
      this.bridge = bridge;
      this.startedWith = [effectiveOptions.model, effectiveOptions.thinking];
      void this.readLoop(spawned.lines, gen);
      return spawned.proc;
    });
  }

  private async readLoop(lines: UnboundedChannel<Line>, generation: number): Promise<void> {
    while (true) {
      const line = await lines.recv();
      if (line === undefined) return;
      if (this.generation !== generation) return;
      if (line.type === "json") {
        this.handleLine(line.value);
      } else {
        const awaited =
          this.awaiting || this.subagents.size > 0 || this.backgroundTasks.size > 0;
        const { bridge } = this.reset();
        if (bridge !== undefined) {
          bridge.remove();
        }
        this.emit({ type: "exited", error: line.error, awaited });
        return;
      }
    }
  }

  /** Process one parsed JSON stream event from `agy`. */
  handleLine(line: unknown): void {
    if (!isRecord(line)) return;
    const event = typeof line.event === "string" ? line.event : "";
    switch (event) {
      case "init": {
        const initObj = isRecord(line.init) ? line.init : undefined;
        const id =
          typeof line.conversation_id === "string"
            ? line.conversation_id
            : initObj && typeof initObj.conversation_id === "string"
              ? initObj.conversation_id
              : undefined;
        if (id === undefined) return;
        if (this.conversation !== id) {
          this.conversation = id;
          this.emit({ type: "sessionId", id });
        }
        break;
      }
      case "step_update":
        this.handleStep(line.step_update);
        break;
      case "result":
        this.handleResult(line.result);
        break;
    }
  }

  /** Process one step update of the main conversation. */
  handleStep(step: unknown): void {
    if (!isRecord(step)) return;
    const index = typeof step.step_index === "number" ? step.step_index : -1;
    const state = typeof step.state === "string" ? step.state : "";
    const done =
      state === "DONE" || state === "ERROR" || state === "CANCELED" || state === "CANCELLED";
    const kind = typeof step.step_type === "string" ? step.step_type : "";
    if (
      kind === "user_input" ||
      kind === "agent_response" ||
      kind === "tool" ||
      kind === "subagent"
    ) {
      this.takeStarted();
    }

    const emitted: Message[] = [];
    if (kind === "agent_response") {
      if (this.textStep !== index) {
        const said = this.text.trim();
        this.text = "";
        if (said.length > 0) {
          emitted.push({ role: "assistant", content: [textBlock(said)], stopReason: "stop" });
        }
        this.textStep = index;
      }
      if (typeof step.text_delta === "string") {
        this.text += step.text_delta;
      }
      if (done) {
        const said = this.text.trim();
        this.text = "";
        this.textStep = undefined;
        if (said.length > 0) {
          emitted.push({ role: "assistant", content: [textBlock(said)], stopReason: "stop" });
        }
      }
    } else if (kind === "tool" || kind === "subagent") {
      const rawInfo = kind === "tool" ? step.tool_info : step.subagent_info;
      const info = isRecord(rawInfo) ? rawInfo : {};
      if (!this.calls.has(index)) {
        this.calls.add(index);
        const name =
          typeof step.tool_name === "string"
            ? step.tool_name
            : typeof info.name === "string"
              ? info.name
              : kind;
        const args =
          kind === "tool"
            ? "parameters" in info
              ? info.parameters
              : null
            : rawInfo !== undefined
              ? rawInfo
              : null;
        emitted.push({
          role: "assistant",
          content: [{ type: "toolCall", id: `step-${index}`, name, arguments: args }],
          stopReason: "toolUse",
        });
      }
      if (done && !this.results.has(index)) {
        this.results.add(index);
        const errObj = isRecord(info.error) ? info.error : undefined;
        const text =
          typeof info.output === "string"
            ? info.output
            : errObj && typeof errObj.message === "string"
              ? errObj.message
              : kind === "subagent"
                ? `subagent ${state.toLowerCase()}`
                : state.toLowerCase();

        if (kind === "tool") {
          const toolName =
            typeof step.tool_name === "string"
              ? step.tool_name
              : typeof info.name === "string"
                ? info.name
                : "";
          const params = isRecord(info.parameters) ? info.parameters : {};
          if (toolName === "run_command") {
            const taskId = backgroundTaskId(text);
            if (taskId !== undefined) {
              const command = typeof params.CommandLine === "string" ? params.CommandLine : "";
              this.backgroundTasks.set(taskId, {
                conversation: this.conversation ?? "",
                command,
                startTime: nowMs(),
              });
            }
          } else if (toolName === "manage_task") {
            const action = typeof params.Action === "string" ? params.Action : "";
            const taskId = typeof params.TaskId === "string" ? params.TaskId : undefined;
            if (taskId !== undefined && backgroundTaskDone(action, text)) {
              this.backgroundTasks.delete(taskId);
            }
          }
        }

        emitted.push({
          role: "toolResult",
          content: [textBlock(clip(text, 2000))],
        });
      }
    }

    for (const message of emitted) {
      this.emit({ type: "message", message });
    }
  }

  /** Process the end of a turn (oldest queued message). */
  handleResult(result: unknown): void {
    const obj = isRecord(result) ? result : {};
    const failed = obj.status !== "SUCCESS";
    const error =
      typeof obj.error === "string" && obj.error.length > 0 ? obj.error : "Antigravity failed";
    const interrupted = obj.finished_reason === "interrupted";

    const said = this.text;
    this.text = "";
    this.textStep = undefined;
    this.awaiting = false;
    // The turn ran to its end, background work included.
    if (this.conversation !== undefined) {
      for (const [id, cmd] of this.commands) {
        if (cmd.conversation === this.conversation) {
          this.commands.delete(id);
        }
      }
    }
    this.backgroundTasks.clear();
    this.subagents.clear();
    const turn = this.turns.shift();
    const idle = this.turns.length === 0;

    if (turn === undefined) return;
    if (failed && !turn.taken) {
      // The runtime refused the message before acting on it: it stays pending, and a new process tries again.
      void this.resetBroken(error);
      return;
    }
    if (!turn.taken) {
      this.emit({ type: "taken", id: turn.id });
    }
    if (said.trim().length > 0) {
      this.emit({
        type: "message",
        message: { role: "assistant", content: [textBlock(said.trim())], stopReason: "stop" },
      });
    }
    if (failed) {
      this.emit({
        type: "message",
        message: {
          role: "assistant",
          content: [textBlock(error)],
          stopReason: interrupted ? "aborted" : "error",
        },
      });
    }
    if (idle) {
      this.emit({ type: "idle", awaitingAsync: false });
    }
  }

  /** End a process that refused a message, and report its exit so the message stays pending. */
  private async resetBroken(error: string): Promise<void> {
    const { proc, bridge } = this.reset();
    if (proc !== undefined) {
      await proc.close(3000);
    }
    if (bridge !== undefined) {
      bridge.remove();
    }
    this.emit({ type: "exited", error, awaited: false });
  }

  /** Answer a hook of the runtime. */
  async handleHook(payload: unknown): Promise<Record<string, unknown>> {
    const obj = isRecord(payload) ? payload : {};
    const conversation = typeof obj.conversationId === "string" ? obj.conversationId : "";
    if (this.conversation === undefined && conversation.length > 0) {
      this.conversation = conversation;
    }
    const main = this.conversation === conversation;
    const hookEvent = typeof obj.hookEventName === "string" ? obj.hookEventName : "";

    switch (hookEvent) {
      case "PreInvocation":
      case "SessionStart":
        if (main) {
          this.takeStarted();
        } else {
          this.subagentSeen(conversation, obj);
        }
        return {};
      case "PreToolUse": {
        if (main) {
          this.takeStarted();
        }
        const call = isRecord(obj.toolCall) ? obj.toolCall : {};
        const tool = typeof call.name === "string" ? call.name : "";
        const input = "args" in call && call.args !== undefined ? call.args : {};
        const decision = await this.judge(tool, input);
        if (decision.decision === "allow") {
          if (!main) {
            this.subagentSeen(conversation, obj);
            const sub = this.subagents.get(conversation);
            if (sub !== undefined) {
              sub.activity = toolActivity(tool, input);
            }
          }
          if (tool === "run_command" && typeof call.id === "string") {
            const command =
              isRecord(input) && typeof input.CommandLine === "string" ? input.CommandLine : "";
            this.commands.set(call.id, {
              conversation,
              command,
              startTime: nowMs(),
            });
          }
          return { decision: "allow" };
        }
        return { decision: "deny", reason: decision.reason };
      }
      case "PostToolUse": {
        const call = isRecord(obj.toolCall) ? obj.toolCall : undefined;
        if (call && typeof call.id === "string") {
          this.commands.delete(call.id);
        }
        return {};
      }
      case "Stop": {
        let backgrounded = false;
        if (main) {
          const waiting = obj.fullyIdle === false && this.turns.length > 0;
          backgrounded = waiting && !this.awaiting;
          this.awaiting = waiting;
        } else {
          this.subagents.delete(conversation);
        }
        // The stream shows nothing more until the background work ends, so the turn is reported over now.
        if (backgrounded) {
          this.emit({ type: "idle", awaitingAsync: true });
        }
        return {};
      }
      default:
        return {};
    }
  }

  /** A subagent's conversation is running: list it, and read its task until its transcript shows it (capped at 3 misses). */
  subagentSeen(conversation: string, payload: unknown): void {
    const existing = this.subagents.get(conversation);
    if (existing !== undefined && (existing.label !== undefined || existing.labelAttempts >= 3)) {
      return;
    }
    const transcriptPath =
      isRecord(payload) && typeof payload.transcriptPath === "string"
        ? payload.transcriptPath
        : undefined;
    const label = transcriptPath !== undefined ? subagentTask(transcriptPath) : undefined;
    let subagent = this.subagents.get(conversation);
    if (subagent === undefined) {
      subagent = { startTime: nowMs(), label: undefined, labelAttempts: 0, activity: undefined };
      this.subagents.set(conversation, subagent);
    }
    if (subagent.label === undefined) {
      if (label !== undefined) {
        subagent.label = label;
      } else {
        subagent.labelAttempts = Math.min(255, subagent.labelAttempts + 1);
      }
    }
  }

  /** Inspect tracked subagent label attempts (primarily for diagnostics/tests). */
  subagentInfo(conversation: string): { label?: string; labelAttempts: number; activity?: string } | undefined {
    const sub = this.subagents.get(conversation);
    if (sub === undefined) return undefined;
    return { label: sub.label, labelAttempts: sub.labelAttempts, activity: sub.activity };
  }

  /** Whether a tool call may run: the Session's tools, Neo's bridge left alone, then the host guard. */
  async judge(tool: string, input: unknown): Promise<Guard> {
    if (tool === "call_mcp_tool") {
      // The host's tools are judged by name where they run, in the MCP server.
      const serverName = isRecord(input) ? input.ServerName : undefined;
      return serverName === mcpServerName()
        ? GUARD_ALLOW
        : guardBlock("Only Neo's application tools are available here");
    }
    const [name, viewInput] = hostView(tool, input);
    const allowed = (kind: string): boolean => (this.options.tools ?? []).includes(kind);
    let permitted: boolean;
    if (name === "task_manage") {
      permitted = allowed("task");
    } else if (name === "read_url_content" || name === "search_web") {
      permitted = allowed("web");
    } else if (TOOL_KIND_SET.has(name)) {
      permitted = allowed(name);
    } else {
      permitted = this.host.specs().some((spec) => spec.name === name) || allowed("bash");
    }
    if (!permitted) {
      return guardBlock("This Session cannot use that tool");
    }
    if (name === "edit" || name === "write") {
      const targetPath =
        isRecord(viewInput) && typeof viewInput.path === "string" ? viewInput.path : "";
      if (this.bridge !== undefined && this.bridge.holds(targetPath)) {
        return guardBlock("That folder is Neo's link to this runtime; leave it alone");
      }
    }
    return this.host.guard ? await this.host.guard(name, viewInput) : GUARD_ALLOW;
  }

  /** The message's text; images are saved in the bridge for the model to view. */
  private messageText(content: readonly Block[]): string {
    const imagesDir = this.bridge !== undefined ? path.join(this.bridge.dir, "images") : undefined;
    const parts: string[] = [];
    for (const block of content) {
      switch (block.type) {
        case "text":
          parts.push(block.text);
          break;
        case "image": {
          const ext = (block.mimeType.split("/").pop() || "png").replace("jpeg", "jpg");
          let savedPath: string | undefined;
          if (imagesDir !== undefined) {
            const bytes = decodeStrictBase64(block.data);
            if (bytes !== undefined) {
              try {
                fs.mkdirSync(imagesDir, { recursive: true });
                const target = path.join(imagesDir, `${uuid()}.${ext}`);
                fs.writeFileSync(target, bytes);
                savedPath = target;
              } catch {
                savedPath = undefined;
              }
            }
          }
          parts.push(
            savedPath !== undefined
              ? `[Image attached at ${savedPath}; look at it with view_file]`
              : "[An image was attached but could not be saved]",
          );
          break;
        }
        case "toolCall":
          parts.push(`[tool call ${block.name}]`);
          break;
      }
    }
    return parts.join("\n\n");
  }

  /** The live bridge folder for the active process, if any. */
  bridgeDir(): string | undefined {
    return this.bridge?.dir;
  }

  /** Whether any turn is currently queued or running on the driver. */
  hasActiveTurns(): boolean {
    return this.turns.length > 0;
  }

  /** Record a synthetic active turn (for unit tests simulating turn completion). */
  pushActiveTurn(id: string, taken: boolean): void {
    this.turns.push({ id, taken });
  }

  async warm(resume?: string): Promise<void> {
    await this.ensureProcess(resume);
  }

  async submit(
    id: string,
    content: Block[],
    _deliver: Deliver,
    resume?: string,
  ): Promise<void> {
    const proc = await this.ensureProcess(resume);
    const text = this.messageText(content);
    // The runtime runs one turn per message, in order: a message sent during a turn waits for it to end.
    this.turns.push({ id, taken: false });
    this.emit({ type: "running" });
    try {
      await proc.send({ event: "user", message: { content: text } });
    } catch (err) {
      this.turns = this.turns.filter((turn) => turn.id !== id);
      throw err;
    }
  }

  async interrupt(): Promise<void> {
    // The runtime has no way to cancel a turn but ending its process; the next message continues the conversation.
    const untaken = this.turns.some((turn) => !turn.taken);
    const busy = this.turns.length > 0;
    const { proc, bridge } = this.reset();
    if (proc !== undefined) {
      await proc.close(3000);
    }
    if (bridge !== undefined) {
      bridge.remove();
    }
    if (untaken) {
      this.emit({ type: "exited", awaited: false });
    } else if (busy) {
      this.emit({
        type: "message",
        message: { role: "assistant", content: [textBlock("Interrupted")], stopReason: "aborted" },
      });
      this.emit({ type: "idle", awaitingAsync: false });
    }
  }

  async jobs(): Promise<KernelJob[]> {
    const main = this.conversation;
    const jobs: KernelJob[] = [];

    const subagentIds = Array.from(this.subagents.keys()).sort();
    for (const id of subagentIds) {
      const subagent = this.subagents.get(id)!;
      const job: KernelJob = {
        id,
        kind: "task",
        label: subagent.label ?? "subagent",
        startTime: subagent.startTime,
        own: true,
        pids: [],
      };
      if (subagent.activity !== undefined) {
        job.progress = subagent.activity;
      }
      jobs.push(job);
    }

    // A command of the main conversation is a background job once the model ended its turn while it runs.
    const commandIds = Array.from(this.commands.keys()).sort();
    for (const id of commandIds) {
      const cmd = this.commands.get(id)!;
      const isMainCmd = main !== undefined && cmd.conversation === main;
      if (!isMainCmd || this.awaiting) {
        jobs.push({
          id,
          kind: "bash",
          label: cmd.command,
          startTime: cmd.startTime,
          command: cmd.command,
          own: isMainCmd,
          pids: [],
        });
      }
    }

    // Commands moved async by `run_command` stay tracked until `manage_task` finishes/kills them or the turn ends.
    const bgIds = Array.from(this.backgroundTasks.keys()).sort();
    for (const id of bgIds) {
      const cmd = this.backgroundTasks.get(id)!;
      jobs.push({
        id,
        kind: "bash",
        label: cmd.command,
        startTime: cmd.startTime,
        command: cmd.command,
        own: true,
        pids: [],
      });
    }

    return jobs;
  }

  async acknowledge(_ids: string[]): Promise<void> {
    // The runtime wakes the model when its background work ends; nothing outside it can stop that.
  }

  async cancel(_id: string): Promise<boolean> {
    // Nor can one job be stopped from outside.
    return false;
  }

  async setModel(model?: string, thinking?: string): Promise<void> {
    // The process takes them at its start; the next message starts one with them once no turn runs.
    this.model = model;
    this.thinking = thinking;
  }

  pid(): number | undefined {
    return this.proc?.pid();
  }

  async close(): Promise<void> {
    this.closed = true;
    const { proc, bridge } = this.reset();
    const server = this.hostServer;
    this.hostServer = undefined;
    if (server !== undefined) {
      server.close();
    }
    if (proc !== undefined) {
      await proc.close(2000);
    }
    if (bridge !== undefined) {
      bridge.remove();
    }
  }
}
