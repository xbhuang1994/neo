/**
 * A stand-in Antigravity CLI (`agy`) for browser tests without network or login: lists fixture
 * models and drives Neo's orchestrator and worker MCP tools over the bridge folder Neo creates.
 *
 * Ported verbatim from Rust `neo-testkit/src/bin/fixture-agy.rs`.
 */

import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const HEADER_END = Buffer.from("\r\n\r\n");

/** Bridge configuration extracted from the session's `.agents` folder. */
export interface BridgeConfig {
  readonly isWorker: boolean;
  readonly url: string;
  readonly auth: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCjk(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x3400 && code <= 0x9fff) {
      return true;
    }
  }
  return false;
}

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    if (process.stdout.write(text)) {
      resolve();
    } else {
      process.stdout.once("drain", resolve);
    }
  });
}

async function emit(value: unknown): Promise<void> {
  await writeStdout(`${JSON.stringify(value)}\n`);
}

function parseAddress(address: string): { host: string; port: number } | null {
  let host: string;
  let portStr: string;
  if (address.startsWith("[")) {
    const close = address.indexOf("]:");
    if (close === -1) return null;
    host = address.slice(1, close);
    portStr = address.slice(close + 2);
  } else {
    const colon = address.lastIndexOf(":");
    if (colon === -1) return null;
    host = address.slice(0, colon);
    portStr = address.slice(colon + 1);
  }
  if (host.length === 0 || !/^[0-9]+$/.test(portStr)) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Call one tool on Neo's loopback MCP server using HTTP/1.1 JSON-RPC 2.0 over raw TCP. */
export async function mcpCall(
  url: string,
  auth: string,
  id: number,
  name: string,
  argumentsValue: unknown,
): Promise<unknown> {
  if (!url.startsWith("http://")) {
    throw new Error("MCP URL is not http");
  }
  const rest = url.slice("http://".length);
  const slash = rest.indexOf("/");
  const address = slash === -1 ? rest : rest.slice(0, slash);
  const reqPath = slash === -1 ? "/" : rest.slice(slash);
  const parsedAddr = parseAddress(address);
  if (parsedAddr === null) {
    throw new Error(`invalid socket address: ${address}`);
  }

  const body = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: argumentsValue },
    }),
    "utf8",
  );
  const head = Buffer.from(
    `POST ${reqPath} HTTP/1.1\r\nHost: ${address}\r\nAuthorization: ${auth}\r\nContent-Type: application/json\r\nContent-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`,
    "utf8",
  );
  const requestBuf = Buffer.allocUnsafe(head.byteLength + body.byteLength);
  head.copy(requestBuf, 0);
  body.copy(requestBuf, head.byteLength);

  const reply = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const socket = net.createConnection({ host: parsedAddr.host, port: parsedAddr.port });

    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(Buffer.concat(chunks));
      }
    };

    socket.on("connect", () => {
      socket.setNoDelay(true);
      socket.write(requestBuf, (err?: Error | null) => {
        if (err) done(err);
      });
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("end", () => done());
    socket.on("close", () => done());
    socket.on("error", (err: Error) => done(err));
  });

  const split = reply.indexOf(HEADER_END);
  if (split === -1) {
    throw new Error("malformed HTTP response");
  }
  const responseBody = reply.subarray(split + 4).toString("utf8");
  return JSON.parse(responseBody);
}

/** Read role and MCP server credentials from Neo's bridge directory. */
export function loadBridge(bridge: string): BridgeConfig {
  let agent = "";
  try {
    agent = fs.readFileSync(path.join(bridge, ".agents", "agents", "neo-session.md"), "utf8");
  } catch {
    agent = "";
  }
  const isWorker = agent.includes("You are a worker.");

  let config: unknown = {};
  try {
    const raw = fs.readFileSync(path.join(bridge, ".agents", "plugins", "neo", "mcp_config.json"), "utf8");
    config = JSON.parse(raw);
  } catch {
    config = {};
  }

  let url = "";
  let auth = "";
  if (isRecord(config) && isRecord(config.mcpServers) && isRecord(config.mcpServers.neo)) {
    const neo = config.mcpServers.neo;
    if (typeof neo.url === "string") {
      url = neo.url;
    }
    if (isRecord(neo.headers) && typeof neo.headers.Authorization === "string") {
      auth = neo.headers.Authorization;
    }
  }

  return { isWorker, url, auth };
}

async function* readStdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  for await (const chunk of process.stdin) {
    const text =
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk as Uint8Array, { stream: true });
    pending += text;
    let newlineIdx = pending.indexOf("\n");
    while (newlineIdx !== -1) {
      let line = pending.slice(0, newlineIdx);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      pending = pending.slice(newlineIdx + 1);
      yield line;
      newlineIdx = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    yield pending.endsWith("\r") ? pending.slice(0, -1) : pending;
  }
}

/** Main entry point for the fixture `agy` binary. */
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args[0] === "--version") {
    await writeStdout("agy 1.0.0-fixture\n");
    return;
  }
  if (args[0] === "models") {
    await writeStdout("gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n");
    await writeStdout("gemini-3.8-pro-high\tGemini 3.8 Pro (High)\n");
    return;
  }

  let bridge = "";
  let conversation = `conv-fixture-${process.pid}`;
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--add-dir" && i + 1 < args.length) {
      bridge = args[i + 1];
      i += 2;
    } else if (args[i] === "--conversation" && i + 1 < args.length) {
      conversation = args[i + 1];
      i += 2;
    } else {
      i += 1;
    }
  }

  const { isWorker, url, auth } = loadBridge(bridge);
  await emit({ event: "init", conversation_id: conversation });

  let stepIndex = 1;
  let callId = 1;
  let askedChinese = false;

  for await (const line of readStdinLines()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.event !== "user") {
      continue;
    }
    const content =
      isRecord(value.message) && typeof value.message.content === "string"
        ? value.message.content
        : "";
    const cards: Record<string, unknown>[] = [];
    for (const part of content.split("\n\n")) {
      try {
        const parsed: unknown = JSON.parse(part);
        if (isRecord(parsed)) {
          cards.push(parsed);
        }
      } catch {
        // Ignore non-JSON paragraphs.
      }
    }

    await emit({
      event: "step_update",
      step_update: { step_index: stepIndex, state: "DONE", step_type: "user_input" },
    });
    stepIndex += 1;

    let reply: string;
    if (isWorker) {
      try {
        fs.writeFileSync("result.txt", "done by the worker\n");
      } catch {
        // Match Rust `let _ = std::fs::write(...)`.
      }
      await emit({
        event: "step_update",
        step_update: {
          step_index: stepIndex,
          state: "DONE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "printf 'done by the worker\\n' > result.txt" },
            output: "wrote result.txt",
          },
        },
      });
      stepIndex += 1;
      try {
        await mcpCall(url, auth, callId, "orchestrator_report", {
          state: "ready",
          summary: "Wrote result.txt.",
          topic: "Write result.txt",
        });
      } catch (error) {
        process.stderr.write(`[fixture-agy] orchestrator_report error: ${errorMessage(error)}\n`);
      }
      callId += 1;
      reply = "Wrote result.txt.";
    } else {
      const candidate = cards.find((card) => card.kind === "candidate");
      const readyReport =
        candidate === undefined
          ? cards.find((card) => card.kind === "worker_report" && card.state === "ready")
          : undefined;

      if (candidate !== undefined) {
        const text = typeof candidate.text === "string" ? candidate.text : "";
        askedChinese = hasCjk(text);
        const ack = askedChinese ? "收到：正在把结果写进文件。" : "On it.";
        try {
          await mcpCall(url, auth, callId, "orchestrator_route", {
            decisions: [
              {
                kind: "accept",
                trigger_id: candidate.trigger_id ?? null,
                title: "Write the result file",
                worktree_name: "write-result",
                acknowledgement: ack,
              },
            ],
          });
        } catch (error) {
          process.stderr.write(`[fixture-agy] orchestrator_route error: ${errorMessage(error)}\n`);
        }
        callId += 1;
        reply = "Accepted.";
      } else if (readyReport !== undefined) {
        const answer = askedChinese ? "结果已写入文件。" : "The file is written.";
        const ticketId = isRecord(readyReport.ticket) ? (readyReport.ticket.ticket_id ?? null) : null;
        try {
          await mcpCall(url, auth, callId, "orchestrator_reply", {
            ticket_id: ticketId,
            purpose: "result",
            text: answer,
          });
        } catch (error) {
          process.stderr.write(`[fixture-agy] orchestrator_reply error: ${errorMessage(error)}\n`);
        }
        callId += 1;
        reply = "Delivered.";
      } else {
        reply = "Done.";
      }
    }

    await emit({
      event: "step_update",
      step_update: {
        step_index: stepIndex,
        state: "DONE",
        step_type: "agent_response",
        text_delta: reply,
      },
    });
    stepIndex += 1;
    await emit({ event: "result", result: { status: "SUCCESS" } });
  }
}

if (import.meta.main) {
  void main();
}
