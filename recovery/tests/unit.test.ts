import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildTargetArgs, parseCli, type DaemonConfig } from "../src/config.ts";
import { createRedactor, RecoveryStateStore } from "../src/state.ts";
import { readRecoveryModeSetting, resolveWorkerConfig } from "../src/worker-config.ts";
import { AgyStreamParser, buildRepairPrompt, describeToolCall } from "../src/worker-runner.ts";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("config parsing and target args", () => {
  test("rejects non-loopback host without valid token", () => {
    const prev = process.env.NEO_TOKEN;
    delete process.env.NEO_TOKEN;
    try {
      const noToken = parseCli(["start", "--host", "0.0.0.0", "--port", "3082"]);
      expect(noToken.ok).toBe(false);

      const shortToken = parseCli(["start", "--host", "0.0.0.0", "--token", "short"]);
      expect(shortToken.ok).toBe(false);

      const valid = parseCli(["start", "--host", "0.0.0.0", "--token", "0123456789abcdef0123"]);
      expect(valid.ok).toBe(true);
      if (valid.ok && valid.value.kind === "start") {
        expect(valid.value.config.host).toBe("0.0.0.0");
        expect(valid.value.config.mode).toBe("proxy");
      }
    } finally {
      if (prev !== undefined) process.env.NEO_TOKEN = prev;
    }
  });

  test("loads JSON config file and lets CLI override", () => {
    const dir = makeTempDir("neo-rec-cfg-");
    const cfgFile = path.join(dir, "recovery.json");
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({
        mode: "takeover",
        port: 4100,
        unhealthyAfterSec: 45,
        maxAttempts: 4,
      }),
    );
    const parsed = parseCli(["start", "--config", cfgFile, "--mode", "proxy", "--port", "4200"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.kind === "start") {
      expect(parsed.value.config.mode).toBe("proxy");
      expect(parsed.value.config.port).toBe(4200);
      expect(parsed.value.config.unhealthyAfterMs).toBe(45_000);
      expect(parsed.value.config.maxAttempts).toBe(4);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("buildTargetArgs replaces host/port for serve and supports placeholders", () => {
    const serveArgs = buildTargetArgs(
      ["serve", "--host", "0.0.0.0", "--port=3082", "--allow-multiple"],
      "127.0.0.1",
      13082,
      "/tmp/web",
      "/tmp/data",
    );
    expect(serveArgs).toEqual([
      "serve",
      "--allow-multiple",
      "--web-dir",
      "/tmp/web",
      "--data-dir",
      "/tmp/data",
      "--host",
      "127.0.0.1",
      "--port",
      "13082",
    ]);

    const customArgs = buildTargetArgs(
      ["run", "server.ts", "--bind={host}:{port}"],
      "127.0.0.1",
      19999,
    );
    expect(customArgs).toEqual(["run", "server.ts", "--bind=127.0.0.1:19999"]);
  });
});

describe("worker-config SQLite discovery", () => {
  test("reads kernel and executor model from Neo orchestrator.sqlite", () => {
    const dir = makeTempDir("neo-rec-db-");
    const dbPath = path.join(dir, "orchestrator.sqlite");
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.query("INSERT INTO kv VALUES (?1, ?2)").run("settings-revision", "12");
    db.query("INSERT INTO kv VALUES (?1, ?2)").run(
      "settings-version:12",
      JSON.stringify({
        revision: 12,
        settings: {
          kernel: "antigravity",
          models: {
            antigravity: {
              eval: { provider: "antigravity", model: "gemini-eval-fast" },
              executor: { provider: "antigravity", model: "gemini-worker-pro" },
            },
          },
          executor: { blockedCommands: ["rm"] },
        },
      }),
    );
    db.close();

    const parsed = parseCli(["start", "--data-dir", dir]);
    expect(parsed.ok).toBe(true);
    const cfg = (parsed as { ok: true; value: { kind: "start"; config: DaemonConfig } }).value.config;
    const resolved = resolveWorkerConfig(cfg);
    expect(resolved.source).toBe("sqlite");
    expect(resolved.kernel).toBe("antigravity");
    expect(resolved.model).toBe("gemini-worker-pro");
    expect(resolved.settingsRevision).toBe(12);
    expect(resolved.blockedCommands).toEqual(["rm"]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("falls back gracefully when orchestrator.sqlite is corrupt or missing", () => {
    const dir = makeTempDir("neo-rec-corrupt-");
    fs.writeFileSync(path.join(dir, "orchestrator.sqlite"), "not a valid sqlite file");

    const parsed = parseCli(["start", "--data-dir", dir]);
    expect(parsed.ok).toBe(true);
    const cfg = (parsed as { ok: true; value: { kind: "start"; config: DaemonConfig } }).value.config;
    const resolved = resolveWorkerConfig(cfg);
    expect(resolved.source).toBe("fallback");
    expect(resolved.kernel).toBe("antigravity");
    expect(resolved.model).toBeNull();
    expect(resolved.recoveryMode).toBe(true);
    expect(resolved.recoveryModeSource).toBe("default");
    expect(resolved.warning).toBeDefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("readRecoveryModeSetting reflects Neo settings.recoveryMode live", () => {
    const dir = makeTempDir("neo-rec-toggle-db-");
    const dbPath = path.join(dir, "orchestrator.sqlite");
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.query("INSERT INTO kv VALUES (?1, ?2)").run("settings-revision", "1");
    db.query("INSERT INTO kv VALUES (?1, ?2)").run(
      "settings-version:1",
      JSON.stringify({ revision: 1, settings: { kernel: "antigravity", recoveryMode: false } }),
    );
    db.close();

    const off = readRecoveryModeSetting(dir);
    expect(off.enabled).toBe(false);
    expect(off.source).toBe("sqlite");
    expect(off.revision).toBe(1);

    const db2 = new Database(dbPath, { readwrite: true });
    db2.query("UPDATE kv SET value = ?1 WHERE key = 'settings-revision'").run("2");
    db2.query("INSERT INTO kv VALUES (?1, ?2)").run(
      "settings-version:2",
      JSON.stringify({ revision: 2, settings: { kernel: "antigravity", recoveryMode: true } }),
    );
    db2.close();

    const on = readRecoveryModeSetting(dir);
    expect(on.enabled).toBe(true);
    expect(on.source).toBe("sqlite");
    expect(on.revision).toBe(2);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("AgyStreamParser, redaction, and state persistence", () => {
  test("parses stream-json init, streaming text, tool lifecycle, and result", () => {
    const stateDir = makeTempDir("neo-rec-state-");
    const secret = "super-secret-token-value-12345";
    const store = new RecoveryStateStore({
      version: "0.1.0",
      mode: "proxy",
      entryHost: "127.0.0.1",
      entryPort: 3082,
      targetPort: 13082,
      targetCommand: "neo-agent serve",
      dataDir: stateDir,
      repoDir: stateDir,
      stateDir,
      unhealthyThresholdMs: 60_000,
      minFailedProbes: 3,
      maxAttempts: 3,
      token: secret,
    });

    const parser = new AgyStreamParser(1, store);
    parser.feedLine(JSON.stringify({ event: "init", conversation_id: "conv-abc-123" }));
    parser.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: { step_index: 1, step_type: "agent_response", state: "RUNNING", text_delta: "Diagnosing " },
      }),
    );
    parser.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "agent_response",
          state: "DONE",
          text_delta: `crash with token ${secret}`,
        },
      }),
    );
    parser.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "tool",
          state: "RUNNING",
          tool_name: "run_command",
          tool_info: { parameters: { CommandLine: "bun run build" } },
        },
      }),
    );
    parser.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "tool",
          state: "DONE",
          tool_name: "run_command",
          tool_info: { output: "Compiled successfully" },
        },
      }),
    );
    parser.feedLine(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }));

    expect(parser.getConversationId()).toBe("conv-abc-123");
    expect(parser.getResult().status).toBe("SUCCESS");

    const snap = store.snapshot();
    // Same step_index updates in place rather than duplicating cards
    const textEvents = snap.events.filter((e) => e.kind === "worker_text");
    expect(textEvents.length).toBe(1);
    expect(textEvents[0].detail).toContain("[REDACTED]");
    expect(textEvents[0].detail).not.toContain(secret);

    const toolEvents = snap.events.filter((e) => e.kind === "tool_end");
    expect(toolEvents.length).toBe(1);
    expect(toolEvents[0].title).toBe("run_command: bun run build");
    expect(toolEvents[0].detail).toContain("Compiled successfully");

    expect(describeToolCall("read_file", { Path: "/a/b.ts" })).toBe("read_file: /a/b.ts");
    expect(createRedactor(secret)(`Bearer ${secret}`)).toBe("Bearer [REDACTED]");

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("buildRepairPrompt omits token and includes diagnostics", () => {
    const parsed = parseCli(["start", "--token", "very-secret-token-999999"]);
    expect(parsed.ok).toBe(true);
    const cfg = (parsed as { ok: true; value: { kind: "start"; config: DaemonConfig } }).value.config;
    const prompt = buildRepairPrompt(
      cfg,
      {
        kernel: "antigravity",
        provider: "antigravity",
        model: "gemini-worker-pro",
        binary: "/usr/bin/agy",
        customArgs: [],
        settingsRevision: 7,
        source: "sqlite",
        dbPath: "/tmp/orchestrator.sqlite",
        blockedCommands: [],
        recoveryMode: true,
        recoveryModeSource: "sqlite",
      },
      {
        attemptId: 2,
        triggerReason: "Down for 65s",
        downDurationSec: 65,
        consecutiveFailures: 6,
        lastProbeReason: "ECONNREFUSED",
        lastTargetExit: "code=1",
        recentLogs: [{ id: 1, at: "2026-01-01T00:00:00Z", stream: "stderr", text: "SyntaxError: broken" }],
        externalLogTail: [],
        previousAttemptSummary: "Attempt 1 missed rebuild",
      },
      "/tmp/diag.json",
    );
    expect(prompt).toContain("gemini-worker-pro");
    expect(prompt).toContain("SyntaxError: broken");
    expect(prompt).toContain("Attempt 1 missed rebuild");
    expect(prompt).not.toContain("very-secret-token-999999");
  });
});
