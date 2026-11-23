/**
 * Unit and end-to-end lifecycle tests for AntigravityDriver, HostServer, relayHook, and Bridge.
 * Ports all tests from Rust `neo-kernel/src/antigravity.rs` and `tests/antigravity_lifecycle.rs`
 * using a pure-TS/Bun stand-in `agy` script and real `relayHook`.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT,
  AntigravityDriver,
  GUARD_ALLOW,
  Journal,
  Session,
  TOOL_KINDS,
  UnboundedChannel,
  agentFile,
  bridgeDir,
  effortOf,
  guardBlock,
  hooksFile,
  hostView,
  launch,
  parseModels,
  relayHook,
  shellCommand,
  startHostServer,
  stripInjected,
  textBlock,
  textOf,
  uuid,
} from "../../src/kernel/index.ts";
import type {
  AntigravityOptions,
  DriverEvent,
  EventSubscription,
  Guard,
  HookHandler,
  KernelEvent,
  ToolHost,
  ToolSpec,
} from "../../src/kernel/index.ts";

const KERNEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/kernel");
const ANTIGRAVITY_TS = path.join(KERNEL_DIR, "antigravity.ts");

function tempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `neo-${prefix}-${process.pid}-${uuid()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

class EchoHost implements ToolHost {
  specs(): ToolSpec[] {
    return [
      {
        name: "echo",
        description: "Echoes.",
        schema: { type: "object", properties: { text: { type: "string" } } },
      },
    ];
  }

  async call(_name: string, args: unknown): Promise<unknown> {
    return args;
  }

  async guard(_tool: string, input: unknown): Promise<Guard> {
    const obj = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    if (
      obj.text === "no" ||
      (typeof obj.command === "string" && obj.command.includes("forbidden"))
    ) {
      return guardBlock("refused");
    }
    return GUARD_ALLOW;
  }
}

async function rawPost(
  url: string,
  token: string | undefined,
  body: unknown,
): Promise<[number, unknown | undefined]> {
  const rest = url.replace(/^http:\/\//, "");
  const slash = rest.indexOf("/");
  const address = slash === -1 ? rest : rest.slice(0, slash);
  const reqPath = slash === -1 ? "/" : rest.slice(slash);
  const [host, portStr] = address.split(":");
  const port = Number(portStr);
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const auth = token !== undefined ? `Authorization: Bearer ${token}\r\n` : "";
  const head = Buffer.from(
    `POST ${reqPath} HTTP/1.1\r\nHost: x\r\n${auth}Content-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
    "utf8",
  );
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection({ host: host!, port }, () => {
      socket.setNoDelay(true);
      socket.write(Buffer.concat([head, payload]));
    });
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("error", reject);
  });
  const text = raw.toString("utf8");
  const status = Number.parseInt(text.split(/\s+/)[1] ?? "0", 10);
  const sep = text.indexOf("\r\n\r\n");
  const bodyStr = sep === -1 ? "" : text.slice(sep + 4);
  const parsed = bodyStr.length > 0 ? (JSON.parse(bodyStr) as unknown) : undefined;
  return [status, parsed];
}

// ============================================================================
// antigravity.rs unit tests
// ============================================================================

describe("antigravity unit tests", () => {
  test("maps thinking levels to efforts", () => {
    expect(effortOf(undefined)).toBeUndefined();
    expect(effortOf("auto")).toBeUndefined();
    expect(effortOf("off")).toBe("low");
    expect(effortOf("minimal")).toBe("low");
    expect(effortOf("low")).toBe("low");
    expect(effortOf("medium")).toBe("medium");
    expect(effortOf("high")).toBe("high");
    expect(effortOf("xhigh")).toBe("xhigh");
    expect(effortOf("max")).toBe("max");
  });

  test("sees runtime tools as the host names them", () => {
    expect(hostView("run_command", { CommandLine: "ls", WaitMsBeforeAsync: 5000 })).toEqual([
      "bash",
      { command: "ls" },
    ]);
    expect(hostView("schedule", { Prompt: "ping" })).toEqual(["bash", { Prompt: "ping" }]);
    expect(hostView("write_file", { Path: "/w/a.txt", Content: "x" })).toEqual([
      "write",
      { path: "/w/a.txt" },
    ]);
    expect(hostView("write_to_file", { TargetFile: "/w/b.txt" })).toEqual([
      "write",
      { path: "/w/b.txt" },
    ]);
    expect(hostView("replace_file_content", { TargetFile: "/w/a" })).toEqual([
      "edit",
      { path: "/w/a" },
    ]);
    expect(hostView("edit_file", { Path: "/w/b" })).toEqual(["edit", { path: "/w/b" }]);
    expect(hostView("read_file", {})[0]).toBe("read");
    expect(hostView("view_file", {})[0]).toBe("read");
    expect(hostView("invoke_subagent", {})[0]).toBe("task");
    expect(hostView("run_workflow", {})[0]).toBe("task");
    expect(hostView("manage_subagents", {})[0]).toBe("task_manage");
    expect(hostView("define_subagent", {})[0]).toBe("task_manage");
    expect(hostView("send_message", {})[0]).toBe("task_manage");
    expect(hostView("read_url_content", {})[0]).toBe("read_url_content");
  });

  test("drops display arguments a tool does not declare", () => {
    const spec: ToolSpec = {
      name: "t",
      description: "",
      schema: { type: "object", properties: { explanation: { type: "string" } } },
    };
    const args = { toolSummary: "x", explanation: "why", text: "hi" };
    expect(stripInjected(spec, args)).toEqual({ explanation: "why", text: "hi" });
    expect(stripInjected(undefined, args)).toEqual({ text: "hi" });
  });

  test("parses the model list", () => {
    const listed =
      "Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.8-pro-high\tGemini 3.8 Pro (High)\n\n";
    expect(parseModels(listed)).toEqual([
      ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
      ["gemini-3.8-pro-high", "Gemini 3.8 Pro (High)"],
    ]);
  });

  test("puts the bridge after the working directory in path order", () => {
    for (const cwd of ["/w/ticket", "/w/a", "/w/zzz", "/"]) {
      const bridge = bridgeDir(cwd, "abcd1234");
      expect(cwd < bridge).toBe(true);
      expect(bridge.startsWith(cwd)).toBe(true);
    }
    expect(bridgeDir("/w/ticket", "x")).toBe("/w/ticket.neo-x");
  });

  test("writes the agent with the tools of its kinds and its prompt", () => {
    const options: AntigravityOptions = {
      program: "agy",
      cwd: "/w",
      systemPrompt: "Be brief.\n",
      tools: ["read", "bash", "read"],
    };
    const agent = agentFile(options);
    expect(agent.startsWith(`---\nname: ${AGENT}\n`)).toBe(true);
    expect(agent.includes("description: A Neo Session.\nplugins:\n  - neo\n")).toBe(true);
    expect(agent.includes("inheritMcp")).toBe(false);
    expect(agent.includes("inheritCustomizations")).toBe(false);
    expect(
      agent.includes("tools: [view_file, list_dir, grep_search, find_by_name, run_command,"),
    ).toBe(true);
    expect(agent.includes("write_to_file")).toBe(false);
    expect(agent.endsWith("---\nBe brief.\n")).toBe(true);

    const full = agentFile({ program: "agy", cwd: "/w", tools: [...TOOL_KINDS] });
    for (const unsupported of ["view_file_outline", "view_code_item", "delete_file", "move_file"]) {
      expect(full.includes(unsupported)).toBe(false);
    }
    for (const [legacy, alias] of [
      ["view_file", "read_file"],
      ["replace_file_content", "edit_file"],
      ["write_to_file", "write_file"],
    ] as const) {
      expect(full.includes(legacy)).toBe(true);
      expect(full.includes(alias)).toBe(false);
    }
    expect(full.includes("run_workflow")).toBe(true);
  });

  test("hooks every tool call and the ends of turns", () => {
    const hooks = hooksFile("relay") as { neo: Record<string, unknown> };
    const pre = hooks.neo.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    const post = hooks.neo.PostToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    const stop = hooks.neo.Stop as Array<{ command: string }>;
    const start = hooks.neo.SessionStart as Array<{ command: string }>;
    expect(pre[0]!.matcher).toBe("*");
    expect(pre[0]!.hooks[0]!.command).toBe("relay");
    expect(post[0]!.matcher).toBe("run_command");
    expect(post[0]!.hooks[0]!.command).toBe("relay");
    expect(stop[0]!.command).toBe("relay");
    expect(start[0]!.command).toBe("relay");
    expect(hooks.neo.PreInvocation).toBeUndefined();
  });

  if (process.platform !== "win32") {
    test("quotes the relay for the shell", () => {
      expect(shellCommand(["/a b/neo-agent", "agy-hook", "it's"])).toBe(
        `'/a b/neo-agent' 'agy-hook' 'it'\\''s'`,
      );
    });
  }

  test("builds the command line", () => {
    const options: AntigravityOptions = {
      program: "agy",
      cwd: "/w",
      model: "gemini-x",
      thinking: "high",
    };
    const args = launch(options, "/w.neo-1", "c-1").args ?? [];
    const after = (flag: string): string | undefined => {
      const idx = args.indexOf(flag);
      return idx === -1 ? undefined : args[idx + 1];
    };
    expect(after("--add-dir")).toBe("/w.neo-1");
    expect(after("--agent")).toBe(AGENT);
    expect(after("--model")).toBe("gemini-x");
    expect(after("--effort")).toBe("high");
    expect(after("--conversation")).toBe("c-1");
    expect(after("--settings")).toBe(
      `{"agentMode":"","permissions":{"allow":["mcp(neo_neo/*)"]},"toolPermission":"always-proceed"}`,
    );
    expect(args[args.length - 1]).toBe("-p=");
    expect(args.includes("--disable-slash-commands")).toBe(true);

    const minimalArgs = launch({ program: "agy", cwd: "/w" }, "/b").args ?? [];
    expect(minimalArgs.some((arg) => arg === "--conversation" || arg === "--model")).toBe(false);
  });

  test("serves the host tools over MCP to the token holder only", async () => {
    const server = await startHostServer(new EchoHost());
    try {
      const url = server.mcpUrl();
      const [unauthStatus] = await rawPost(url, "wrong", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      expect(unauthStatus).toBe(401);

      const [, listed] = await rawPost(url, server.token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      expect(((listed as Record<string, unknown>).result as { tools: Array<{ name: string }> }).tools[0]!.name).toBe("echo");

      expect(
        await rawPost(url, server.token, {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      ).toEqual([202, undefined]);

      const call = (text: string) => ({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { text, toolSummary: "s" } },
      });

      const [, called] = await rawPost(url, server.token, call("hi"));
      const calledText = (
        (called as Record<string, unknown>).result as { content: Array<{ text: string }> }
      ).content[0]!.text;
      expect(calledText).toBe(JSON.stringify({ text: "hi" }));

      const [, blocked] = await rawPost(url, server.token, call("no"));
      expect((blocked as Record<string, unknown>).result).toEqual({
        isError: true,
        content: [{ type: "text", text: "refused" }],
      });

      // The hooks' endpoint is the token's own path.
      const [wrongHookStatus] = await rawPost(`http://127.0.0.1:${server.port}/hook/wrong`, undefined, {});
      expect(wrongHookStatus).toBe(401);
    } finally {
      server.close();
    }
  });

  test("relays a hook and fails when the host is gone", async () => {
    const onHook: HookHandler = async (payload) => {
      const call = (payload as { toolCall?: { name?: string } }).toolCall;
      return { decision: "deny", reason: call?.name ?? "" };
    };
    const server = await startHostServer(new EchoHost(), undefined, onHook);
    try {
      const url = server.hookUrl();
      const chunks: Buffer[] = [];
      await relayHook(
        url,
        Buffer.from('{"toolCall": {"name": "run_command"}}', "utf8"),
        { write(c: Uint8Array) { chunks.push(Buffer.from(c)); } },
      );
      expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
        decision: "deny",
        reason: "run_command",
      });

      const wrong = `http://127.0.0.1:${server.port}/hook/wrong`;
      await expect(
        relayHook(wrong, Buffer.from("{}"), { write() {} }),
      ).rejects.toThrow("401");
    } finally {
      server.close();
    }

    await expect(
      relayHook("http://127.0.0.1:1/hook/x", Buffer.from("{}"), { write() {} }),
    ).rejects.toThrow("Cannot reach Neo");
  });

  test("keeps alive MCP connections without Nagle stall", async () => {
    const server = await startHostServer(new EchoHost());
    try {
      const payload = Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        "utf8",
      );
      const head = Buffer.from(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer ${server.token}\r\nContent-Length: ${payload.length}\r\n\r\n`,
        "utf8",
      );
      const req = Buffer.concat([head, payload]);

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection({ host: "127.0.0.1", port: server.port }, () => {
          s.setNoDelay(true);
          resolve(s);
        });
        s.once("error", reject);
      });

      try {
        let buf = Buffer.alloc(0);
        let notify: (() => void) | null = null;
        socket.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          if (notify !== null) {
            const fn = notify;
            notify = null;
            fn();
          }
        });

        const readResponse = async (): Promise<unknown> => {
          while (true) {
            const headerEnd = buf.indexOf("\r\n\r\n");
            if (headerEnd !== -1) {
              const headerText = buf.subarray(0, headerEnd).toString("latin1");
              const lines = headerText.split("\r\n");
              expect(lines[0]!.startsWith("HTTP/1.1 200 ")).toBe(true);
              let contentLength = 0;
              for (let i = 1; i < lines.length; i++) {
                const colon = lines[i]!.indexOf(":");
                if (colon !== -1 && lines[i]!.slice(0, colon).trim().toLowerCase() === "content-length") {
                  contentLength = Number.parseInt(lines[i]!.slice(colon + 1).trim(), 10);
                }
              }
              const total = headerEnd + 4 + contentLength;
              if (buf.length >= total) {
                const body = buf.subarray(headerEnd + 4, total).toString("utf8");
                buf = buf.subarray(total);
                return JSON.parse(body) as unknown;
              }
            }
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
        };

        const started = performance.now();
        for (let i = 0; i < 5; i++) {
          socket.write(req);
          const parsed = (await readResponse()) as { id: number };
          expect(parsed.id).toBe(1);
        }
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(50);
      } finally {
        socket.destroy();
      }
    } finally {
      server.close();
    }
  });

  test("handles split-chunk HTTP requests without busy-looping", async () => {
    const server = await startHostServer(new EchoHost());
    try {
      const payload = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "echo", arguments: { text: "split-body-ok" } },
        }),
        "utf8",
      );
      const head = Buffer.from(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer ${server.token}\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
        "utf8",
      );
      const half = Math.floor(payload.length / 2);
      const reply = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const socket = net.createConnection({ host: "127.0.0.1", port: server.port }, async () => {
          socket.setNoDelay(true);
          socket.write(head);
          await Bun.sleep(10);
          socket.write(payload.subarray(0, half));
          await Bun.sleep(10);
          socket.write(payload.subarray(half));
        });
        socket.on("data", (c: Buffer) => chunks.push(c));
        socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        socket.on("error", reject);
      });
      expect(reply.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
      const body = JSON.parse(reply.slice(reply.indexOf("\r\n\r\n") + 4)) as {
        id: number;
        result: { content: Array<{ text: string }> };
      };
      expect(body.id).toBe(7);
      expect(body.result.content[0]!.text).toBe(JSON.stringify({ text: "split-body-ok" }));
    } finally {
      server.close();
    }
  });

  test("judges web, task_manage and read tools according to session kinds", async () => {
    const taskCapHost: ToolHost = {
      specs: () => [],
      call: async () => ({}),
      guard: async (tool) =>
        tool === "task" ? guardBlock("max subagents reached") : GUARD_ALLOW,
    };

    const tx = new UnboundedChannel<DriverEvent>();
    const router = new AntigravityDriver(
      { program: "agy", cwd: "/w", tools: ["read", "bash"] },
      new EchoHost(),
      tx,
    );
    expect(await router.judge("read_file", {})).toEqual(GUARD_ALLOW);
    expect(await router.judge("view_file", {})).toEqual(GUARD_ALLOW);
    expect(await router.judge("schedule", {})).toEqual(GUARD_ALLOW);
    expect((await router.judge("read_url_content", {})).decision).toBe("block");
    expect((await router.judge("search_web", {})).decision).toBe("block");
    expect((await router.judge("manage_subagents", {})).decision).toBe("block");

    const worker = new AntigravityDriver(
      { program: "agy", cwd: "/w", tools: ["read", "bash", "task", "web"] },
      taskCapHost,
      tx,
    );
    expect(await worker.judge("read_url_content", {})).toEqual(GUARD_ALLOW);
    expect(await worker.judge("search_web", {})).toEqual(GUARD_ALLOW);
    expect(await worker.judge("manage_subagents", {})).toEqual(GUARD_ALLOW);
    expect(await worker.judge("define_subagent", {})).toEqual(GUARD_ALLOW);
    expect(await worker.judge("send_message", {})).toEqual(GUARD_ALLOW);
    expect(await worker.judge("invoke_subagent", {})).toEqual(guardBlock("max subagents reached"));
    expect(await worker.judge("run_workflow", {})).toEqual(guardBlock("max subagents reached"));
  });

  test("caps subagent label attempts after three misses", () => {
    const dir = tempDir("agy-subagent-attempts");
    try {
      const transcript = path.join(dir, "transcript.jsonl");
      fs.writeFileSync(transcript, '{"content":"Do the task\\n"}\n');
      const missing = path.join(dir, "missing.jsonl");

      const tx = new UnboundedChannel<DriverEvent>();
      const driver = new AntigravityDriver({ program: "agy", cwd: dir }, new EchoHost(), tx);

      for (let i = 0; i < 4; i++) {
        driver.subagentSeen("sub-miss", { transcriptPath: missing });
      }
      driver.subagentSeen("sub-miss", { transcriptPath: transcript });
      expect(driver.subagentInfo("sub-miss")).toEqual({
        label: undefined,
        labelAttempts: 3,
        activity: undefined,
      });

      driver.subagentSeen("sub-hit", { transcriptPath: transcript });
      expect(driver.subagentInfo("sub-hit")?.label).toBe("Do the task");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tracks backgrounded run_command tasks until killed or turn ends", async () => {
    const tx = new UnboundedChannel<DriverEvent>();
    const driver = new AntigravityDriver({ program: "agy", cwd: "/w" }, new EchoHost(), tx);
    driver.handleLine({ event: "init", conversation_id: "conv-1" });
    driver.handleStep({
      step_index: 1,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "python train.py --epochs 100" },
        output:
          "Tool is running as a background task with task id: conv-1/task-9\nTask logs are available at: /tmp/task-9.log",
      },
    });
    const jobs = await driver.jobs();
    expect(jobs.length).toBe(1);
    expect([jobs[0]!.id, jobs[0]!.kind, jobs[0]!.label]).toEqual([
      "conv-1/task-9",
      "bash",
      "python train.py --epochs 100",
    ]);

    driver.handleStep({
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_name: "manage_task",
      tool_info: {
        name: "manage_task",
        parameters: { Action: "kill", TaskId: "conv-1/task-9" },
        output: 'Task "conv-1/task-9" canceled.',
      },
    });
    expect(await driver.jobs()).toEqual([]);

    // Also cleared when the turn finishes.
    driver.handleStep({
      step_index: 3,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "sleep 60" },
        output: "Tool is running as a background task with task id: conv-1/task-10",
      },
    });
    expect((await driver.jobs()).length).toBe(1);
    driver.pushActiveTurn("t1", true);
    driver.handleResult({ status: "SUCCESS" });
    expect(await driver.jobs()).toEqual([]);
  });
});

// ============================================================================
// End-to-end Antigravity lifecycle tests (pure-TS/Bun stand-in agy + real relayHook)
// ============================================================================

const FAKE_AGY_SOURCE = `
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const args = process.argv.slice(2);
let bridge = "";
let conv = "conv-1";
let model = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--add-dir" && i + 1 < args.length) {
    bridge = args[++i]!;
  } else if (args[i] === "--conversation" && i + 1 < args.length) {
    conv = args[++i]!;
  } else if (args[i] === "--model" && i + 1 < args.length) {
    model = args[++i]!;
  }
}

const plugin = path.join(bridge, ".agents", "plugins", "neo");
const hooks = JSON.parse(fs.readFileSync(path.join(plugin, "hooks.json"), "utf8")).neo;
const mcpConfig = JSON.parse(fs.readFileSync(path.join(plugin, "mcp_config.json"), "utf8"));
const mcp = mcpConfig.mcpServers?.neo;
const agent = fs.readFileSync(path.join(bridge, ".agents", "agents", "neo-session.md"), "utf8");

function emitRaw(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

function out(event: string, body: Record<string, unknown>): void {
  emitRaw({ event, [event]: { ...body, conversation_id: conv } });
}

function callHook(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  const command: string =
    name === "PreToolUse" || name === "PostToolUse"
      ? hooks[name][0].hooks[0].command
      : hooks[name][0].command;
  const fullPayload = {
    conversationId: conv,
    ...payload,
    hookEventName: name,
  };
  const res =
    process.platform === "win32"
      ? spawnSync("cmd", ["/C", command], { input: JSON.stringify(fullPayload), encoding: "utf8" })
      : spawnSync("sh", ["-c", command], { input: JSON.stringify(fullPayload), encoding: "utf8" });
  if (res.status !== 0) {
    return { decision: "deny", reason: "hook failed: " + (res.stderr || "") };
  }
  const stdout = (res.stdout || "").trim();
  if (!stdout) return {};
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function mcpCall(name: string, argumentsObj: Record<string, unknown>): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (mcp?.headers?.Authorization) {
    headers.Authorization = mcp.headers.Authorization;
  }
  const resp = await fetch(mcp.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name, arguments: argumentsObj },
    }),
  });
  const reply = (await resp.json()) as { result?: { content?: Array<{ text?: string }> } };
  return reply.result?.content?.[0]?.text ?? "";
}

emitRaw({ event: "init", conversation_id: conv, init: { agent: "neo-session" } });
let step = 0;
const nextStep = () => ++step;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  let raw: { message?: { content?: string } };
  try {
    raw = JSON.parse(line);
  } catch {
    continue;
  }
  const text = raw?.message?.content ?? "";
  if (text.includes("refuse")) {
    out("result", { status: "ERROR", error: "agent refused to start", num_turns: 0 });
    continue;
  }
  out("step_update", { step_index: nextStep(), state: "DONE", step_type: "user_input" });
  if (text.includes("model?")) {
    out("step_update", {
      step_index: nextStep(),
      state: "DONE",
      step_type: "agent_response",
      text_delta: "model is: " + model + " conv=" + conv,
    });
  }
  if (text.includes("prompt?")) {
    const parts = agent.split("---\\n");
    const body = (parts[parts.length - 1] ?? "").trim();
    out("step_update", {
      step_index: nextStep(),
      state: "DONE",
      step_type: "agent_response",
      text_delta: "prompt says: " + body,
    });
  }
  if (text.includes("tool")) {
    callHook("SessionStart", {});
    const decision = callHook("PreToolUse", {
      toolCall: {
        id: "c1",
        name: "call_mcp_tool",
        args: { ServerName: "neo_neo", ToolName: "echo", Arguments: { text: "ok" } },
      },
    });
    const idx = nextStep();
    out("step_update", {
      step_index: idx,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "call_mcp_tool",
      tool_info: { name: "call_mcp_tool", parameters: { ToolName: "echo" } },
    });
    const result =
      decision.decision === "allow"
        ? await mcpCall("echo", { text: "ok", toolSummary: "x" })
        : String(decision.reason ?? "");
    out("step_update", {
      step_index: idx,
      state: "DONE",
      step_type: "tool",
      tool_name: "call_mcp_tool",
      tool_info: { name: "call_mcp_tool", parameters: { ToolName: "echo" }, output: result },
    });
    callHook("PostToolUse", { toolCall: { id: "c1", name: "call_mcp_tool" } });
  }
  if (text.includes("forbidden")) {
    const decision = callHook("PreToolUse", {
      toolCall: { id: "c2", name: "run_command", args: { CommandLine: "forbidden" } },
    });
    const idx = nextStep();
    const reason = String(decision.reason ?? "");
    out("step_update", {
      step_index: idx,
      state: "ERROR",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "forbidden" },
        error: { message: "denied: " + reason },
      },
    });
  }
  if (text.includes("bridge")) {
    const target = path.join(bridge, "x");
    const decision = callHook("PreToolUse", {
      toolCall: { id: "c3", name: "write_to_file", args: { TargetFile: target } },
    });
    const reply = String(decision.decision ?? "") + ": " + String(decision.reason ?? "");
    out("step_update", {
      step_index: nextStep(),
      state: "DONE",
      step_type: "agent_response",
      text_delta: reply,
    });
  }
  if (text.includes("background")) {
    callHook("PreToolUse", {
      toolCall: { id: "bg1", name: "run_command", args: { CommandLine: "sleep 1" } },
    });
    callHook("Stop", { fullyIdle: false });
    const parent = path.dirname(bridge);
    fs.writeFileSync(path.join(parent, "bg-waiting"), "1");
    while (!fs.existsSync(path.join(parent, "bg-release"))) {
      await Bun.sleep(25);
    }
    callHook("PostToolUse", { toolCall: { id: "bg1", name: "run_command" } });
    callHook("Stop", { fullyIdle: true });
    out("step_update", {
      step_index: nextStep(),
      state: "DONE",
      step_type: "agent_response",
      text_delta: "background done",
    });
  }
  if (text.includes("hang")) {
    await Bun.sleep(60_000);
  }
  const s = nextStep();
  out("step_update", {
    step_index: s,
    state: "ACTIVE",
    step_type: "agent_response",
    text_delta: "Done ",
  });
  const prefix = Array.from(text).slice(0, 12).join("");
  out("step_update", {
    step_index: s,
    state: "DONE",
    step_type: "agent_response",
    text_delta: prefix,
  });
  out("result", { status: "SUCCESS", response: "", num_turns: 1 });
}
`;

class LifecycleFixture {
  readonly dir: string;
  readonly session: Session;
  readonly events: EventSubscription<KernelEvent>;
  readonly driver: AntigravityDriver;

  private constructor(
    dir: string,
    session: Session,
    events: EventSubscription<KernelEvent>,
    driver: AntigravityDriver,
  ) {
    this.dir = dir;
    this.session = session;
    this.events = events;
    this.driver = driver;
  }

  static create(
    tag: string,
    opts?: { host?: ToolHost; model?: string; bridgeId?: string },
  ): LifecycleFixture {
    const dir = tempDir(`agy-lifecycle-${tag}`);
    const cwd = path.join(dir, "work");
    fs.mkdirSync(cwd, { recursive: true });

    const fakeAgyTs = path.join(dir, "fake-agy.ts");
    fs.writeFileSync(fakeAgyTs, FAKE_AGY_SOURCE);

    const fakeAgyBin = path.join(dir, "fake-agy");
    const bunExe = process.execPath;
    fs.writeFileSync(
      fakeAgyBin,
      `#!/bin/sh\nexec '${bunExe.replaceAll("'", "'\\''")}' '${fakeAgyTs.replaceAll("'", "'\\''")}' "$@"\n`,
      { mode: 0o755 },
    );

    const hookRelayTs = path.join(dir, "hook-relay.ts");
    fs.writeFileSync(
      hookRelayTs,
      `import { relayHook } from ${JSON.stringify(ANTIGRAVITY_TS)};\n` +
        `const url = process.argv[2] ?? "";\n` +
        `try {\n` +
        `  await relayHook(url, process.stdin, process.stdout);\n` +
        `} catch (err) {\n` +
        `  process.stderr.write((err instanceof Error ? err.message : String(err)) + "\\n");\n` +
        `  process.exit(1);\n` +
        `}\n`,
    );

    const journal = Journal.create(dir, cwd);
    const options: AntigravityOptions = {
      program: fakeAgyBin,
      cwd,
      systemPrompt: "You are the fixture.",
      tools: ["read", "bash", "write"],
      model: opts?.model,
      bridgeId: opts?.bridgeId,
      hookRelay: [bunExe, hookRelayTs],
    };
    const channel = new UnboundedChannel<DriverEvent>();
    const driver = new AntigravityDriver(options, opts?.host ?? new EchoHost(), channel);
    const session = new Session(journal, driver, channel);
    const events = session.subscribe();
    return new LifecycleFixture(dir, session, events, driver);
  }

  async turn(): Promise<KernelEvent[]> {
    const seen: KernelEvent[] = [];
    while (true) {
      const event = await withTimeout(this.events.recv(), 20_000, "the turn ends");
      expect(event).toBeDefined();
      seen.push(event!);
      if (event!.type === "agentEnd") {
        return seen;
      }
    }
  }

  async send(id: string, text: string): Promise<void> {
    await this.session.send(id, [textBlock(text)], "queue", {}, []);
  }

  said(): string[] {
    const out: string[] = [];
    for (const entry of this.session.journal().entries()) {
      if (entry.type === "message") {
        out.push(textOf(entry.message.content));
      }
    }
    return out;
  }

  cleanup(): void {
    this.events.unsubscribe();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

describe("antigravity lifecycle tests", () => {
  test("runs turns with host tools, hooks and the agent prompt", async () => {
    const f = LifecycleFixture.create("turns");
    try {
      await f.send("r1", "prompt? and tool");
      const seen = await f.turn();
      expect(seen).toContainEqual({ type: "taken", requestIds: ["r1"] });
      expect(seen[seen.length - 1]).toEqual({
        type: "agentEnd",
        terminal: true,
        awaitingAsync: false,
      });
      expect(f.session.journal().pending()).toEqual([]);
      expect(f.session.journal().kernelSession("antigravity")).toBe("conv-1");
      const said = f.said();
      expect(said).toContain("prompt says: You are the fixture.");
      expect(said).toContain('{"text":"ok"}');
      expect(said).toContain("Done prompt? and");

      // A refused command reaches the model with the guard's reason, and the turn goes on.
      await f.send("r2", "forbidden");
      await f.turn();
      expect(f.said()).toContain("denied: refused");

      // Neo's bridge is not the model's to change.
      await f.send("r3", "bridge");
      await f.turn();
      expect(f.said().some((t) => t.startsWith("deny: That folder is Neo's link"))).toBe(true);

      // Two messages sent together run as two turns, in order.
      await f.send("r4", "first");
      await f.send("r5", "second");
      const batch = await f.turn();
      const hasR5 = (events: KernelEvent[]) =>
        events.some((e) => e.type === "taken" && e.requestIds.length === 1 && e.requestIds[0] === "r5");
      if (!hasR5(batch)) {
        batch.push(...(await f.turn()));
      }
      expect(hasR5(batch)).toBe(true);
      expect(f.said()).toContain("Done second");
      expect(f.session.journal().pending()).toEqual([]);

      const bridge = f.driver.bridgeDir()!;
      expect(fs.existsSync(path.join(bridge, ".agents/plugins/neo/hooks.json"))).toBe(true);
      await f.session.dispose();
      expect(fs.existsSync(bridge)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  test("ends the turn while background work runs and lists it", async () => {
    const f = LifecycleFixture.create("background");
    try {
      await f.send("r1", "background");
      const seen1 = await f.turn();
      expect(seen1[seen1.length - 1]).toEqual({
        type: "agentEnd",
        terminal: false,
        awaitingAsync: true,
      });
      const jobs = await f.session.driver().jobs();
      expect(jobs.length).toBe(1);
      expect([jobs[0]!.kind, jobs[0]!.command, jobs[0]!.own]).toEqual(["bash", "sleep 1", true]);

      fs.writeFileSync(path.join(f.dir, "bg-release"), "1");
      const seen2 = await f.turn();
      expect(seen2[seen2.length - 1]).toEqual({
        type: "agentEnd",
        terminal: true,
        awaitingAsync: false,
      });
      expect(await f.session.driver().jobs()).toEqual([]);
      expect(f.said()).toContain("background done");

      await f.session.dispose();
    } finally {
      f.cleanup();
    }
  });

  test("keeps a message the runtime refused pending", async () => {
    const f = LifecycleFixture.create("refuse");
    try {
      await f.send("r1", "refuse");
      const seen = await f.turn();
      expect(seen.some((e) => e.type === "taken")).toBe(false);
      expect(f.session.journal().pending().length).toBe(1);
      expect(f.said().some((t) => t.includes("agent refused to start"))).toBe(true);
      await f.session.dispose();
    } finally {
      f.cleanup();
    }
  });

  test("warms without starting a turn and cleans up on close", async () => {
    const f = LifecycleFixture.create("warm");
    try {
      await f.session.warm();
      expect(f.events.tryRecv()).toBeUndefined();
      expect(f.session.driver().pid()).toBeDefined();
      expect(f.driver.hasActiveTurns()).toBe(false);
      const bridge = f.driver.bridgeDir()!;
      expect(fs.statSync(bridge).isDirectory()).toBe(true);

      await f.session.dispose();
      expect(fs.existsSync(bridge)).toBe(false);
      // Session.warm() after dispose is a quiet no-op, while Driver.warm() rejects.
      await f.session.warm();
      await expect(f.session.driver().warm!()).rejects.toThrow("closed");
      expect(fs.existsSync(bridge)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  test("switches model on next turn when idle and isolates empty MCP tools", async () => {
    const emptyHost: ToolHost = {
      specs: () => [],
      call: async () => ({}),
    };
    const f = LifecycleFixture.create("model-switch", {
      host: emptyHost,
      model: "model-a",
      bridgeId: "fixed123",
    });
    try {
      await f.send("r1", "model?");
      await f.turn();
      expect(f.said()).toContain("model is: model-a conv=conv-1");
      const pidBefore = f.driver.pid();
      const bridge = f.driver.bridgeDir()!;
      // Empty ToolHost writes empty mcpServers object (non-worker MCP isolation).
      const mcpJson = JSON.parse(
        fs.readFileSync(path.join(bridge, ".agents/plugins/neo/mcp_config.json"), "utf8"),
      ) as { mcpServers: Record<string, unknown> };
      expect(mcpJson.mcpServers).toEqual({});

      await f.session.setModel("model-b", "low");
      await f.send("r2", "model?");
      await f.turn();
      expect(f.driver.pid()).not.toBe(pidBefore);
      expect(f.said()).toContain("model is: model-b conv=conv-1");

      await f.session.dispose();
      expect(fs.existsSync(bridge)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  test("interrupts a running turn cleanly and saves image attachments in bridge", async () => {
    const f = LifecycleFixture.create("interrupt-and-img");
    try {
      await f.session.warm();
      const bridge = f.driver.bridgeDir()!;
      await f.session.send(
        "img1",
        [
          textBlock("look"),
          { type: "image", mimeType: "image/png", data: Buffer.from("PNGDATA").toString("base64") },
        ],
        "queue",
      );
      await f.turn();
      const imagesDir = path.join(bridge, "images");
      expect(fs.existsSync(imagesDir)).toBe(true);
      const files = fs.readdirSync(imagesDir);
      expect(files.length).toBe(1);
      expect(files[0]!.endsWith(".png")).toBe(true);

      // Start a hanging turn, wait until taken, then interrupt it.
      await f.send("hang1", "hang");
      while (true) {
        const ev = await withTimeout(f.events.recv(), 10_000, "taken event");
        if (ev?.type === "taken") break;
      }
      await f.session.interrupt();
      const after = await f.turn();
      expect(after[after.length - 1]).toEqual({
        type: "agentEnd",
        terminal: true,
        awaitingAsync: false,
      });
      expect(f.session.journal().lastStopReason()).toBe("aborted");
      expect(f.session.journal().lastAssistantText()).toBe("Interrupted");

      await f.session.dispose();
    } finally {
      f.cleanup();
    }
  });
});
