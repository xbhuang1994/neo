import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  REFUSED_STATUS,
  invokedAs,
  pathWith,
  refusal,
  sync,
  syncBlockedCommands,
  workerBin,
} from "../../src/app/blocked.ts";
import { Health, HealthBoard, healthError, healthReady, healthWaiting } from "../../src/app/health.ts";
import { formatFailure, send, sendJson, sendStream } from "../../src/app/http.ts";
import {
  type ProcessSnapshot,
  cpuTime,
  inDirectory,
  parseLsof,
  parsePs,
  parseWindows,
  pathStartsWith,
  readProcessTable,
  tableTree,
  terminatePids,
  tree,
} from "../../src/app/procinfo.ts";
import {
  type PromptSettings,
  compose,
  environment,
  environmentSection,
  policySection,
  promptFile,
  sidecarPrompt,
  watchdogPrompt,
  watchdogSystem,
} from "../../src/app/prompts.ts";
import { IM_WORDS, checkedImText, clip, languageMismatch, wordCount } from "../../src/app/text.ts";

function defaultPromptSettings(): PromptSettings {
  return {
    eval: { mode: "observe" },
    policy: {
      rules: [
        {
          id: "copy",
          name: "Copy fixes",
          enabled: true,
          instruction:
            "Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.",
        },
        {
          id: "visual",
          name: "Visual fixes",
          enabled: true,
          instruction:
            "Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.",
        },
      ],
      sources: {
        chat: {
          allowed: [{ id: "web:local" }],
        },
      },
    },
    executor: {
      blockedCommands: [],
    },
  };
}

describe("text", () => {
  test("counts_words_in_chinese_english_and_mixed_text", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("Hello, world!")).toBe(2);
    expect(wordCount("修复 README 的错别字。")).toBe(7);
    expect(wordCount("don't use v1.2 of snake_case — it's well-known")).toBe(7);
    expect(wordCount("...!!! ——")).toBe(0);
    expect(wordCount("こんにちは")).toBe(5);
    expect(wordCount("a.b. c")).toBe(2);
    // Additional Unicode edge cases: right single quote, Hangul, supplementary Han, accented Latin.
    expect(wordCount("don’t stop")).toBe(2);
    expect(wordCount("안녕하세요")).toBe(5);
    expect(wordCount("\uD840\uDC00\uD840\uDC01 test")).toBe(3);
    expect(wordCount("café résumé")).toBe(2);
    expect(wordCount("a-修")).toBe(2);
  });

  test("refuses_a_message_over_the_limit", () => {
    const fits = "字".repeat(IM_WORDS);
    expect(checkedImText(fits)).toEqual({ ok: true, value: fits });
    const long = "word ".repeat(IM_WORDS + 1);
    const res = checkedImText(long);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("101 words");
      expect(res.error).toBe(
        "IM message has 101 words; maximum is 100. Rewrite as a short high-level update. Do not split it into multiple messages.",
      );
    }
    expect(clip("你好世界", 2)).toBe("你好");
    expect(clip("\uD840\uDC00abc", 2)).toBe("\uD840\uDC00a");
    expect(clip("abc", 0)).toBe("");
    expect(clip("abc", 10)).toBe("abc");
  });

  test("a_reply_follows_the_language_the_person_wrote_in", () => {
    const asked = "那测试跨不同的cpu 的CCD和相同性能CCD 做对比";
    const english = "On it: comparing the ring buffer's alignment performance across different CPU CCDs.";
    expect(languageMismatch(asked, english)).not.toBeNull();
    expect(languageMismatch(asked, "收到：对比 ring buffer 在跨 CCD 与同 CCD 下的性能。")).toBeNull();
    expect(languageMismatch("[语音转写] C加加的run buffer需要线程安全", "收到：改为线程安全。")).toBeNull();
    expect(languageMismatch("Please fix the save button", "收到：修复保存按钮。")).not.toBeNull();
    expect(languageMismatch("Please fix the save button", "On it: fixing the save button.")).toBeNull();
    expect(languageMismatch("Please fix the save button", "On it: fixing the “保存” button.")).toBeNull();
    // Unclear or mixed messages constrain nothing.
    expect(languageMismatch("ok", "好的")).toBeNull();
    expect(languageMismatch("看下 https://github.com/foo/bar/issues/12", "Looking at it.")).toBeNull();
  });
});

describe("health", () => {
  test("tracks component health with sorted snapshots and immutable copies", () => {
    const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const r = Health.ready("Ready");
    const w = Health.waiting("Starting");
    const e = Health.error("Broken");
    expect(r.state).toBe("ready");
    expect(w.state).toBe("waiting");
    expect(e.state).toBe("error");
    expect(r.at).toMatch(isoRe);
    expect(healthReady("a", "2026-01-01T00:00:00.000Z")).toEqual({
      state: "ready",
      detail: "a",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(healthWaiting("b", "2026-01-01T00:00:00.000Z").state).toBe("waiting");
    expect(healthError("c", "2026-01-01T00:00:00.000Z").state).toBe("error");

    const board = new HealthBoard();
    board.waiting("runtime", "Starting");
    board.set("kernel", Health.ready("Running on antigravity"));
    board.error("environment", "Permission denied");
    board.set("alpha", "ready", "First");

    expect(board.get("missing")).toBeUndefined();
    const runtime = board.get("runtime");
    expect(runtime?.state).toBe("waiting");
    expect(runtime?.detail).toBe("Starting");
    // Mutating returned object does not mutate board internals.
    if (runtime) {
      runtime.detail = "mutated";
    }
    expect(board.get("runtime")?.detail).toBe("Starting");

    board.ready("runtime", "Ready");
    const snap = board.snapshot();
    expect(Object.keys(snap)).toEqual(["alpha", "environment", "kernel", "runtime"]);
    expect(board.all()).toEqual(snap);
    expect(snap.runtime.state).toBe("ready");
    expect(snap.runtime.detail).toBe("Ready");
    expect(snap.environment.state).toBe("error");
  });
});

describe("http", () => {
  test("handles requests, headers, statuses, json, streaming, caps, and timeouts", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/echo") {
          const text = await req.text();
          return new Response(JSON.stringify({ method: req.method, header: req.headers.get("x-test"), body: text }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-encrypted-param": "abc123",
            },
          });
        }
        if (url.pathname === "/status/415") {
          return new Response("unsupported", { status: 415 });
        }
        if (url.pathname === "/big") {
          return new Response("0123456789abcdef", { status: 200 });
        }
        if (url.pathname === "/slow-headers") {
          await Bun.sleep(250);
          return new Response("late", { status: 200 });
        }
        if (url.pathname === "/slow-body") {
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("part1"));
              await Bun.sleep(250);
              try {
                controller.enqueue(new TextEncoder().encode("part2"));
                controller.close();
              } catch {
                // Stream already cancelled on timeout.
              }
            },
          });
          return new Response(stream, { status: 200 });
        }
        if (url.pathname === "/bad-json") {
          return new Response("{broken", { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const base = `http://127.0.0.1:${server.port}`;

      // POST with tuple headers, binary body, and wanted response headers.
      const echoed = await send({
        method: "POST",
        url: `${base}/echo`,
        headers: [
          ["x-test", "hello"],
          ["content-type", "text/plain"],
        ],
        body: new TextEncoder().encode("payload"),
        timeoutMs: 5_000,
        want: ["x-encrypted-param", "x-missing"],
      });
      expect(echoed.ok).toBe(true);
      if (echoed.ok) {
        expect(echoed.value.status).toBe(200);
        expect(echoed.value.headers).toEqual(["abc123", ""]);
        const parsed = JSON.parse(new TextDecoder().decode(echoed.value.body));
        expect(parsed).toEqual({ method: "POST", header: "hello", body: "payload" });
      }

      // Non-2xx server status is a Response, not a Failure.
      const status415 = await send({ method: "POST", url: `${base}/status/415`, timeoutMs: 5_000 });
      expect(status415.ok).toBe(true);
      if (status415.ok) {
        expect(status415.value.status).toBe(415);
      }

      // Response body cap truncates cleanly at maxBytes.
      const capped = await send({ method: "GET", url: `${base}/big`, maxBytes: 6, timeoutMs: 5_000 });
      expect(capped.ok).toBe(true);
      if (capped.ok) {
        expect(new TextDecoder().decode(capped.value.body)).toBe("012345");
      }

      // sendJson convenience helper.
      const jsonOk = await sendJson<{ method: string; header: string; body: string }>({
        method: "POST",
        url: `${base}/echo`,
        headers: { "x-test": "json-call" },
        json: { hello: 42 },
        timeoutMs: 5_000,
      });
      expect(jsonOk.ok).toBe(true);
      if (jsonOk.ok) {
        expect(jsonOk.value.status).toBe(200);
        expect(jsonOk.value.data.header).toBe("json-call");
        expect(JSON.parse(jsonOk.value.data.body)).toEqual({ hello: 42 });
      }

      const jsonBad = await sendJson({ method: "GET", url: `${base}/bad-json`, timeoutMs: 5_000 });
      expect(jsonBad.ok).toBe(false);
      if (!jsonBad.ok) {
        expect(jsonBad.error.kind).toBe("transport");
      }

      // sendStream convenience helper.
      const streamed = await sendStream({ method: "GET", url: `${base}/big`, timeoutMs: 5_000 });
      expect(streamed.ok).toBe(true);
      if (streamed.ok) {
        expect(streamed.value.status).toBe(200);
        expect(streamed.value.stream).not.toBeNull();
        const text = await new Response(streamed.value.stream).text();
        expect(text).toBe("0123456789abcdef");
      }

      // Timeout on slow headers.
      const timedOutHeaders = await send({ method: "GET", url: `${base}/slow-headers`, timeoutMs: 50 });
      expect(timedOutHeaders.ok).toBe(false);
      if (!timedOutHeaders.ok) {
        expect(timedOutHeaders.error).toEqual({ kind: "timeout" });
        expect(formatFailure(timedOutHeaders.error)).toBe("The request timed out");
      }

      // Timeout during slow body streaming.
      const timedOutBody = await send({ method: "GET", url: `${base}/slow-body`, timeoutMs: 60 });
      expect(timedOutBody.ok).toBe(false);
      if (!timedOutBody.ok) {
        expect(timedOutBody.error).toEqual({ kind: "timeout" });
      }

      // Transport failure on closed port.
      const refused = await send({ method: "GET", url: "http://127.0.0.1:1/", timeoutMs: 2_000 });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.kind).toBe("transport");
        expect(formatFailure(refused.error).length).toBeGreaterThan(0);
      }
    } finally {
      server.stop(true);
    }
  });
});

describe("prompts", () => {
  test("joins_the_lines_of_a_paragraph_and_keeps_paragraph_breaks", () => {
    expect(promptFile("One.\r\n  Two.  \n\n \nThree.\nFour.\n\n")).toBe("One. Two.\nThree. Four.");
    expect(promptFile("- a\n- b")).toBe("- a - b");
    expect(promptFile("")).toBe("");
  });

  test("composes_each_roles_prompt_from_its_own_sections_in_order", () => {
    const settings = defaultPromptSettings();
    const orchestrator = compose("orchestrator", settings);
    const worker = compose("worker", settings);
    const assertOrder = (text: string, parts: string[]) => {
      let from = 0;
      for (const part of parts) {
        const at = text.indexOf(part, from);
        expect(at, `${JSON.stringify(part)} is missing or out of order`).toBeGreaterThanOrEqual(0);
        from = at + part.length;
      }
    };
    assertOrder(orchestrator, [
      "The orchestrator decides candidates",
      "You are the orchestrator",
      "## Communication",
      "## subscriptions",
      "## replies",
      "## dispatch",
      "Assess proactive candidates yourself",
      "Ticket handoff contract",
      "For an active ticket.attention",
      "Execution environment",
      "## Policy",
    ]);
    assertOrder(worker, [
      "The orchestrator decides candidates",
      "You are a worker.",
      "## Communication",
      "## Ticket scope",
      "## Delivery requirements",
      "## replies",
      "## work",
      "Ticket handoff contract",
      "Use orchestrator_report human_action",
      "Execution environment",
    ]);
    expect(worker).not.toContain("## Policy");
    expect(worker).not.toContain("## dispatch");
    expect(worker).not.toContain("## subscriptions");
    expect(worker).not.toContain("You are the orchestrator");
    expect(orchestrator).not.toContain("## work\n");
    expect(orchestrator).not.toContain("## Ticket scope");
    expect(orchestrator).not.toContain("## Delivery requirements");
    expect(orchestrator).not.toContain("You are a worker.");

    // The Policy section closes the orchestrator's prompt, so changing it keeps the prefix before it.
    const initialPolicy = policySection(settings);
    expect(orchestrator.endsWith(initialPolicy)).toBe(true);
    const changed = structuredClone(settings);
    changed.policy.rules[0].enabled = false;
    const again = compose("orchestrator", changed);
    const prefix = orchestrator.length - initialPolicy.length;
    expect(again.slice(0, prefix)).toBe(orchestrator.slice(0, prefix));
    expect(again).not.toBe(orchestrator);
    expect(compose("worker", changed)).toBe(worker);
  });

  test("names_no_removed_integration_in_any_prompt", () => {
    const settings = defaultPromptSettings();
    const prompts = [
      compose("orchestrator", settings),
      compose("worker", settings),
      sidecarPrompt(),
      watchdogPrompt(),
    ];
    for (const text of prompts) {
      const words = text.split(/[^\p{Alphabetic}\p{Number}]+/u);
      for (const word of ["GitHub", "github", "gh", "PR", "PRs", "CI"]) {
        expect(words.includes(word), `a prompt still mentions ${JSON.stringify(word)}`).toBe(false);
      }
      expect(text).not.toContain("pull request");
      expect(text.length).toBeGreaterThan(500);
    }
  });

  test("lists_the_enabled_rules_one_per_line_or_says_there_are_none", () => {
    const settings = defaultPromptSettings();
    settings.policy.rules[0].instruction = "First line.\n\n  Second line.";
    settings.policy.rules[1].enabled = false;
    const section = policySection(settings);
    expect(section).toMatch(/^## Policy\nPolicy version [0-9a-f]{32}; accept mode observe\./);
    expect(
      section.endsWith("The enabled rules, by name and id:\n- Copy fixes (copy): First line. Second line."),
    ).toBe(true);
    // Explicit policy version override works cleanly without circular imports.
    const custom = policySection(settings, "custom-ver-123");
    expect(custom.startsWith("## Policy\nPolicy version custom-ver-123; accept mode observe.")).toBe(true);

    settings.policy.rules[0].enabled = false;
    settings.eval.mode = "auto";
    const none = policySection(settings);
    expect(none).toContain("accept mode auto");
    expect(none.endsWith("No rule is enabled: a proactive candidate can only be ignored.")).toBe(true);
  });

  test("describes_the_execution_environment_with_quoted_values", () => {
    const settings = defaultPromptSettings();
    settings.executor.blockedCommands = ["docker", "kubectl"];
    const general = environment(settings, null);
    expect(general.map((variable) => variable.key)).toEqual(["NEO_AGENT_BLOCKED_COMMANDS"]);
    const place = { id: "t1", name: "fix-typo", directory: '/data/work/fix "typo"' };
    const ticket = environment(settings, place);
    expect(ticket.map((variable) => variable.key)).toEqual([
      "NEO_AGENT_DIR",
      "NEO_AGENT_NAME",
      "NEO_AGENT_TICKET",
      "NEO_AGENT_BLOCKED_COMMANDS",
    ]);
    const section = environmentSection(ticket);
    expect(section).toContain(
      '- NEO_AGENT_DIR = "/data/work/fix \\"typo\\"": This ticket\'s directory; its worker Session works in it.',
    );
    expect(section).toContain('- NEO_AGENT_BLOCKED_COMMANDS = "docker kubectl": Commands blocked');
    expect(compose("worker", settings)).toContain('- NEO_AGENT_BLOCKED_COMMANDS = "docker kubectl"');
    const watchdog = watchdogSystem(settings);
    expect(watchdog.startsWith(watchdogPrompt())).toBe(true);
    expect(watchdog).toContain('- NEO_AGENT_BLOCKED_COMMANDS = "docker kubectl"');
  });
});

describe("blocked", () => {
  test("names_the_command_a_program_was_started_as", () => {
    expect(invokedAs("/usr/local/bin/neo-agent")).toBe("neo-agent");
    expect(invokedAs("C:\\data\\worker-bin\\docker.exe")).toBe("docker");
    expect(invokedAs("kubectl.EXE")).toBe("kubectl");
    expect(invokedAs("git")).toBe("git");
    expect(refusal("docker").startsWith("docker is blocked")).toBe(true);
    expect(REFUSED_STATUS).toBe(126);
  });

  if (process.platform !== "win32") {
    test("keeps_a_stand_in_for_each_blocked_command_and_refuses_when_run", () => {
      const state = path.join(os.tmpdir(), `neo-blocked-${process.pid}-${Date.now()}`);
      const dir = workerBin(state);
      try {
        expect(sync(state, ["docker", "kubectl"], null)).toEqual({ ok: true });
        fs.writeFileSync(path.join(dir, "mine"), "#!/bin/sh\necho mine\n", "utf8");
        const listNames = (d: string) => fs.readdirSync(d).sort();
        expect(listNames(dir)).toEqual(["docker", "kubectl", "mine"]);

        const run = spawnSync(path.join(dir, "docker"), ["ps"], { encoding: "utf8" });
        expect(run.status).toBe(REFUSED_STATUS);
        expect(run.stderr.trim()).toBe(refusal("docker"));
        expect(run.stdout).toBe("");

        // Found first on the path a Session is given.
        const envPath = pathWith(state);
        const found = spawnSync("sh", ["-c", "command -v kubectl"], {
          env: { ...process.env, PATH: envPath },
          encoding: "utf8",
        });
        expect(found.stdout.trim()).toBe(path.join(dir, "kubectl"));

        // A changed list removes what is no longer blocked, and never a file of someone else's.
        expect(syncBlockedCommands(state, null, ["kubectl"])).toEqual({ ok: true });
        expect(listNames(dir)).toEqual(["kubectl", "mine"]);
        // Idempotent re-sync keeps everything intact.
        expect(syncBlockedCommands(state, null, ["kubectl"])).toEqual({ ok: true });
        expect(listNames(dir)).toEqual(["kubectl", "mine"]);

        expect(sync(state, [], null)).toEqual({ ok: true });
        expect(listNames(dir)).toEqual(["mine"]);

        const pathEntries = pathWith(state).split(path.delimiter);
        expect(pathEntries[0]).toBe(dir);
        expect(pathEntries.filter((entry) => entry === dir).length).toBe(1);
        // Even when dir is already in PATH, it appears once and first.
        const deduped = pathWith(state, `/usr/bin${path.delimiter}${dir}${path.delimiter}/bin`).split(path.delimiter);
        expect(deduped[0]).toBe(dir);
        expect(deduped.filter((entry) => entry === dir).length).toBe(1);
      } finally {
        fs.rmSync(state, { recursive: true, force: true });
      }
    });
  }
});

describe("procinfo", () => {
  test("reads_cpu_times_in_either_systems_format", () => {
    expect(cpuTime("0:00.03")).toBe(3);
    expect(cpuTime("1:23.45")).toBe(8_345);
    expect(cpuTime("00:01:23")).toBe(8_300);
    expect(cpuTime("2-03:04:05")).toBe((2 * 86_400 + 3 * 3_600 + 4 * 60 + 5) * 100);
    expect(cpuTime("75:00.5")).toBe(450_050);
    expect(cpuTime("junk")).toBe(0);
  });

  test("parses_the_process_table_of_ps_on_macos_and_linux", () => {
    const macos =
      "    1     0 Ss     2:11.90 /sbin/launchd\n  501     1 S      0:00.03 /bin/zsh -l\n 7001   501 R+     1:02.50 python train.py --epochs 10\nnot a line\n";
    const table = parsePs(macos);
    expect(table.length).toBe(3);
    expect(table[2]).toEqual({
      pid: 7001,
      ppid: 501,
      state: "R+",
      cpu_ticks: 6_250,
      cmd: "python train.py --epochs 10",
    });
    const linux = "      1       0 S 00:00:07 /sbin/init splash\n   4242    4000 R 00:10:00 make -j8\n";
    expect(parsePs(linux)[1]).toEqual({
      pid: 4242,
      ppid: 4000,
      state: "R",
      cpu_ticks: 60_000,
      cmd: "make -j8",
    });
    const long = `5 1 S 0:00.00 ${"x".repeat(400)}`;
    expect(parsePs(long)[0].cmd.length).toBe(180);
  });

  test("follows_a_tree_through_the_table_without_looping", () => {
    const proc = (pid: number, ppid: number): ProcessSnapshot => ({
      pid,
      ppid,
      state: "S",
      cpu_ticks: 0,
      cmd: `p${pid}`,
    });
    // 10 -> 11 -> 12, 10 -> 13; 20 is unrelated; 30 and 31 name each other as parents.
    const table = [proc(10, 1), proc(11, 10), proc(12, 11), proc(13, 10), proc(20, 1), proc(30, 31), proc(31, 30)];
    const pids = (roots: number[]) => tableTree(roots, table).map((p) => p.pid);
    expect(pids([10])).toEqual([10, 11, 13, 12]);
    expect(pids([11, 20, 11])).toEqual([11, 20, 12]);
    expect(pids([30])).toEqual([30, 31]);
    expect(pids([99])).toEqual([]);
    expect(pids([])).toEqual([]);
  });

  test("finds_working_directories_in_lsof_output", () => {
    const own = process.pid;
    const output = `p101\nfcwd\nn/Users/me/work/t1\np102\nfcwd\nn/Users/me/work/t1/build\np103\nfcwd\nn/Users/me/work/t10\np104\nfcwd\nn/\np${own}\nfcwd\nn/Users/me/work/t1\n`;
    expect(parseLsof(output, "/Users/me/work/t1")).toEqual([101, 102]);
    expect(parseLsof("", "/x")).toEqual([]);
    expect(pathStartsWith("/Users/me/work/t1/build", "/Users/me/work/t1/")).toBe(true);
    expect(pathStartsWith("/Users/me/work/t10", "/Users/me/work/t1")).toBe(false);
  });

  test("parses_the_windows_process_table", () => {
    const output =
      '0\t0\t0\tSystem Idle Process\t\r\n4\t0\t1250000\tSystem\t\r\n8120\t4400\t31250000\tpython.exe\t"C:\\Python\\python.exe" train.py\r\nbad\r\n';
    const table = parseWindows(output);
    expect(table.length).toBe(3);
    expect(table[1]).toEqual({
      pid: 4,
      ppid: 0,
      state: "?",
      cpu_ticks: 12,
      cmd: "System",
    });
    expect([table[2].ppid, table[2].cpu_ticks, table[2].cmd]).toEqual([
      4400,
      312,
      '"C:\\Python\\python.exe" train.py',
    ]);
  });

  if (process.platform === "linux") {
    test("samples_live_processes_by_tree_and_by_working_directory", async () => {
      const rawDir = path.join(os.tmpdir(), `neo-procinfo-${process.pid}-${Date.now()}`);
      fs.mkdirSync(path.join(rawDir, "sub"), { recursive: true });
      const directory = fs.realpathSync(rawDir);

      const shell = spawn("sh", ["-c", "sleep 30 & cd sub && sleep 31 & wait"], {
        cwd: directory,
        stdio: "ignore",
      });

      try {
        const shellPid = shell.pid!;
        let found: number[] | null = null;
        for (let i = 0; i < 100; i++) {
          await Bun.sleep(20);
          const pids = inDirectory(directory);
          if (pids.length >= 3) {
            found = pids;
            break;
          }
        }
        expect(found, "the shell and both sleeps are found by their working directory").not.toBeNull();
        expect(found!).toContain(shellPid);

        const processes = tree([shellPid]);
        const commands = processes.map((p) => p.cmd);
        expect(commands).toContain("sleep 30");
        expect(commands).toContain("sleep 31");
        expect(processes[0].pid).toBe(shellPid);
        expect(processes.slice(1).every((p) => p.ppid !== 0 && p.state.length > 0)).toBe(true);

        // The same tree through `ps`, as other systems read it.
        const listed = tableTree([shellPid], readProcessTable());
        if (listed.length > 0) {
          expect(listed.some((p) => p.cmd === "sleep 30")).toBe(true);
        }

        for (const p of processes.slice(1)) {
          try {
            process.kill(p.pid, "SIGTERM");
          } catch {
            // Already exited.
          }
        }
        shell.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          shell.once("exit", () => resolve());
          setTimeout(resolve, 1_000);
        });

        expect(inDirectory(directory)).not.toContain(shellPid);
        expect(inDirectory("/nonexistent-directory")).toEqual([]);

        // `terminatePids` ends detached background processes while leaving our own process alone.
        const detached = spawnSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 </dev/null & echo $!"], {
          cwd: directory,
          encoding: "utf8",
        });
        expect(detached.status).toBe(0);
        const bgPid = Number.parseInt(detached.stdout.trim(), 10);
        expect(Number.isInteger(bgPid) && bgPid > 1).toBe(true);

        let foundBg = false;
        for (let i = 0; i < 50; i++) {
          if (inDirectory(directory).includes(bgPid)) {
            foundBg = true;
            break;
          }
          await Bun.sleep(20);
        }
        expect(foundBg, "detached process should appear in directory").toBe(true);

        await terminatePids([0, process.pid, bgPid]);

        // Wait briefly for reap/exit of the detached grandchild (reparented to init/subreaper).
        let gone = false;
        for (let i = 0; i < 40; i++) {
          let alive = false;
          if (fs.existsSync(`/proc/${bgPid}`)) {
            try {
              const stat = fs.readFileSync(`/proc/${bgPid}/stat`, "utf8");
              alive = !stat.includes(") Z ");
            } catch {
              alive = false;
            }
          }
          if (!alive) {
            gone = true;
            break;
          }
          await Bun.sleep(20);
        }
        expect(gone, `detached pid ${bgPid} should be terminated`).toBe(true);
      } finally {
        try {
          shell.kill("SIGKILL");
        } catch {
          // Ignore if already dead.
        }
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
