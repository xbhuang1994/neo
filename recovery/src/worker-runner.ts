/**
 * Recovery worker execution & live Antigravity `stream-json` event parser.
 * Invokes the backend-configured worker (`agy` or custom worker override) with diagnostic context,
 * streams every assistant message, tool call, tool output, and stderr line into the RecoveryStateStore,
 * and enforces a hard timeout + cancellation via AbortSignal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonConfig } from "./config.ts";
import { ManagedProcess, enrichedPath } from "./process.ts";
import type { NeoLogLine, RecoveryAttempt, RecoveryStateStore } from "./state.ts";
import { defaultInstallDirs, type ResolvedWorkerConfig } from "./worker-config.ts";

export interface DiagnosticsContext {
  attemptId: number;
  triggerReason: string;
  downDurationSec: number;
  consecutiveFailures: number;
  lastProbeReason: string;
  lastTargetExit: string;
  recentLogs: NeoLogLine[];
  externalLogTail: string[];
  previousAttemptSummary?: string;
}

export interface WorkerRunOutcome {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  timedOut: boolean;
  summary: string;
  conversationId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

export function readFileTailLines(filePath: string | undefined, maxLines = 60): string[] {
  if (!filePath) return [];
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return [];
    const readBytes = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(readBytes);
      fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
      const lines = buf
        .toString("utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      return lines.slice(-maxLines);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

export function buildRepairPrompt(
  config: DaemonConfig,
  worker: ResolvedWorkerConfig,
  diag: DiagnosticsContext,
  diagnosticsFile: string | null,
): string {
  const recentLogText =
    diag.recentLogs.length > 0
      ? diag.recentLogs.map((l) => `[${l.at}] [${l.stream}] ${l.text}`).join("\n")
      : "(no captured stdout/stderr from managed process)";

  const extLogSection =
    diag.externalLogTail.length > 0
      ? `\n### External Service Log Tail (${config.logFile})\n\`\`\`\n${diag.externalLogTail.join("\n")}\n\`\`\`\n`
      : "";

  const prevAttemptSection = diag.previousAttemptSummary
    ? `\n### Previous Failed Recovery Attempt\n${diag.previousAttemptSummary}\nAvoid repeating the exact same ineffective change.\n`
    : "";

  return [
    `You are the automated recovery worker invoked by Neo's independent recovery daemon (PID ${process.pid}).`,
    `Neo has been unavailable for ${diag.downDurationSec}s (${diag.consecutiveFailures} failed health probes) and entered Recovery Mode (Attempt #${diag.attemptId}).`,
    ``,
    `## Failure Diagnostics`,
    `- Trigger reason: ${diag.triggerReason}`,
    `- Last health probe: ${diag.lastProbeReason}`,
    `- Last Neo process exit: ${diag.lastTargetExit}`,
    `- Configured worker: kernel=${worker.kernel}, model=${worker.model ?? "(default)"}, source=${worker.source}`,
    `- Target binary: ${config.targetBin}`,
    `- Target args: ${JSON.stringify(config.targetArgs)}`,
    `- Target cwd: ${config.targetCwd}`,
    `- Repo directory: ${config.repoDir}`,
    `- Neo data directory: ${config.dataDir}`,
    config.webDir ? `- Web directory: ${config.webDir}` : `- Web directory: (auto)`,
    diagnosticsFile ? `- Full diagnostics JSON: ${diagnosticsFile}` : "",
    prevAttemptSection,
    `### Recent Neo Output`,
    "```",
    clipText(recentLogText, 8000),
    "```",
    extLogSection,
    `## Your Recovery Task`,
    `1. Inspect the failure logs, target binary, and source files under \`${config.repoDir}\` to identify the exact root cause why Neo cannot start or serve \`/api/health\`.`,
    `2. Apply the minimal, clean, safe fix needed to restore Neo to healthy operation.`,
    `3. Rebuild and verify before finishing:`,
    `   - If fixing the TypeScript backend under \`${config.repoDir}/backend\`, run \`bun run check\` and \`bun run build\` (so \`${config.targetBin}\` is updated) and verify with a quick test or smoke launch using \`--allow-multiple --port 0 --data-dir <tempdir>\` (stop the temporary smoke process afterward).`,
    `4. Strict safety rules:`,
    `   - DO NOT kill or signal the recovery daemon (PID ${process.pid}).`,
    `   - DO NOT leave a long-running \`neo-agent serve\` bound to port ${config.port} (the recovery daemon will launch and verify Neo automatically as soon as you exit!).`,
    `   - DO NOT delete or wipe user data in \`${config.dataDir}\` (especially \`orchestrator.sqlite\`).`,
    `5. Conclude with a concise summary (in Chinese or English matching the logs) stating: root cause, exact fix applied, and verification checks run.`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/** Extract a concise, human-readable one-line summary for a tool call. */
export function describeToolCall(toolName: string, rawParams: unknown): string {
  const params = isRecord(rawParams) ? rawParams : {};
  if (typeof params.toolSummary === "string" && params.toolSummary.trim().length > 0) {
    return `${toolName}: ${params.toolSummary.trim()}`;
  }
  switch (toolName) {
    case "run_command":
      if (typeof params.CommandLine === "string") {
        return `run_command: ${clipText(params.CommandLine.trim(), 160)}`;
      }
      break;
    case "read_file":
    case "view_file":
    case "edit_file":
    case "write_file":
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content": {
      for (const k of ["Path", "TargetFile", "AbsolutePath", "File"]) {
        if (typeof params[k] === "string" && params[k].length > 0) {
          return `${toolName}: ${params[k]}`;
        }
      }
      break;
    }
    case "grep_search":
      if (typeof params.Query === "string") {
        return `grep_search: ${clipText(params.Query, 120)}`;
      }
      break;
    case "find_by_name":
      if (typeof params.Pattern === "string") {
        return `find_by_name: ${params.Pattern}`;
      }
      break;
  }
  return toolName;
}

/**
 * Stateful parser for Antigravity CLI `--output-format stream-json` NDJSON lines,
 * emitting live structured events into `RecoveryStateStore`.
 */
export class AgyStreamParser {
  private readonly attemptId: number;
  private readonly store: RecoveryStateStore;
  private readonly textByStep = new Map<number, string>();
  private readonly toolStarted = new Map<number, { name: string; title: string; startedAtMs: number; paramsJson: string }>();
  private readonly toolFinished = new Set<number>();
  private lastAssistantText = "";
  private resultStatus: string | null = null;
  private resultError: string | null = null;
  private conversationId: string | null = null;

  constructor(attemptId: number, store: RecoveryStateStore) {
    this.attemptId = attemptId;
    this.store = store;
  }

  getConversationId(): string | null {
    return this.conversationId;
  }

  getResult(): { status: string | null; error: string | null; lastText: string } {
    return {
      status: this.resultStatus,
      error: this.resultError,
      lastText: this.lastAssistantText,
    };
  }

  feedLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.store.emitEvent({
        kind: "worker_log",
        title: "Worker 输出",
        detail: trimmed,
        status: "info",
      });
      return;
    }

    if (!isRecord(parsed)) {
      this.store.emitEvent({
        kind: "worker_log",
        title: "Worker 输出",
        detail: trimmed,
        status: "info",
      });
      return;
    }

    const event = typeof parsed.event === "string" ? parsed.event : "";
    if (event === "init") {
      const initObj = isRecord(parsed.init) ? parsed.init : undefined;
      const cid =
        typeof parsed.conversation_id === "string"
          ? parsed.conversation_id
          : initObj && typeof initObj.conversation_id === "string"
            ? initObj.conversation_id
            : null;
      if (cid) {
        this.conversationId = cid;
        this.store.setAttemptConversation(cid);
      }
      this.store.emitEvent({
        kind: "worker_init",
        title: cid ? `修复 Worker 会话已建立 (${cid.slice(0, 12)})` : "修复 Worker 会话已建立",
        status: "done",
        meta: cid ? { conversationId: cid } : undefined,
      });
      return;
    }

    if (event === "step_update" && isRecord(parsed.step_update)) {
      this.handleStepUpdate(parsed.step_update);
      return;
    }

    if (event === "result" && isRecord(parsed.result)) {
      this.handleResult(parsed.result);
      return;
    }

    // Generic structured event from custom workers (`{ type/kind, title, detail }`)
    if (typeof parsed.title === "string") {
      this.store.emitEvent({
        kind: "worker_log",
        title: parsed.title,
        detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
        status:
          parsed.status === "running" || parsed.status === "done" || parsed.status === "error"
            ? parsed.status
            : "info",
        stepKey: typeof parsed.stepKey === "string" ? `a${this.attemptId}:${parsed.stepKey}` : undefined,
      });
      return;
    }

    this.store.emitEvent({
      kind: "worker_log",
      title: "Worker 事件",
      detail: clipText(trimmed, 1500),
      status: "info",
    });
  }

  private handleStepUpdate(step: Record<string, unknown>): void {
    const index = typeof step.step_index === "number" ? step.step_index : -1;
    const state = typeof step.state === "string" ? step.state : "";
    const done = state === "DONE" || state === "ERROR" || state === "CANCELED" || state === "CANCELLED";
    const kind = typeof step.step_type === "string" ? step.step_type : "";

    if (kind === "agent_response") {
      const prev = this.textByStep.get(index) ?? "";
      const delta = typeof step.text_delta === "string" ? step.text_delta : "";
      const next = prev + delta;
      this.textByStep.set(index, next);
      const clean = next.trim();
      if (clean.length > 0) {
        this.lastAssistantText = clean;
        this.store.emitEvent({
          kind: "worker_text",
          title: done ? "Worker 分析与说明" : "Worker 思考与输出中…",
          detail: clipText(clean, 8000),
          status: done ? "done" : "running",
          stepKey: `a${this.attemptId}:text-${index}`,
          persist: done,
        });
      }
      return;
    }

    if (kind === "tool" || kind === "subagent") {
      const rawInfo = kind === "tool" ? step.tool_info : step.subagent_info;
      const info = isRecord(rawInfo) ? rawInfo : {};
      const toolName =
        typeof step.tool_name === "string"
          ? step.tool_name
          : typeof info.name === "string"
            ? info.name
            : kind;
      const params = kind === "tool" ? info.parameters : rawInfo;
      const stepKey = `a${this.attemptId}:${kind}-${index}`;

      if (!this.toolStarted.has(index)) {
        const title = describeToolCall(toolName, params);
        const paramsJson = params !== undefined ? clipText(JSON.stringify(params, null, 2), 2000) : "";
        this.toolStarted.set(index, {
          name: toolName,
          title,
          startedAtMs: Date.now(),
          paramsJson,
        });
        this.store.emitEvent({
          kind: "tool_start",
          title,
          detail: paramsJson.length > 0 ? `输入参数:\n${paramsJson}` : undefined,
          status: "running",
          stepKey,
          meta: { tool: toolName, stepIndex: index },
        });
      }

      if (done && !this.toolFinished.has(index)) {
        this.toolFinished.add(index);
        const started = this.toolStarted.get(index);
        const durationMs = started ? Date.now() - started.startedAtMs : 0;
        const errObj = isRecord(info.error) ? info.error : undefined;
        const output =
          typeof info.output === "string"
            ? info.output
            : errObj && typeof errObj.message === "string"
              ? errObj.message
              : state.toLowerCase();
        const isErr = state === "ERROR" || state === "CANCELED" || state === "CANCELLED" || Boolean(errObj);
        const parts: string[] = [];
        if (started?.paramsJson) {
          parts.push(`输入参数:\n${started.paramsJson}`);
        }
        if (output.trim().length > 0) {
          parts.push(`执行输出:\n${clipText(output.trim(), 4000)}`);
        }
        this.store.emitEvent({
          kind: "tool_end",
          title: started?.title ?? toolName,
          detail: parts.join("\n\n"),
          status: isErr ? "error" : "done",
          stepKey,
          meta: {
            tool: toolName,
            stepIndex: index,
            durationMs,
            state,
          },
        });
      }
    }
  }

  private handleResult(result: Record<string, unknown>): void {
    const status = typeof result.status === "string" ? result.status : "UNKNOWN";
    const error = typeof result.error === "string" && result.error.length > 0 ? result.error : null;
    this.resultStatus = status;
    this.resultError = error;
    const ok = status === "SUCCESS";
    this.store.emitEvent({
      kind: "worker_result",
      title: ok ? "修复 Worker 执行完成" : `修复 Worker 异常结束 (${status})`,
      detail: error ?? (this.lastAssistantText ? clipText(this.lastAssistantText, 3000) : undefined),
      status: ok ? "done" : "error",
      meta: { status, finishedReason: result.finished_reason ?? null },
    });
  }
}

export async function runRecoveryWorker(opts: {
  config: DaemonConfig;
  worker: ResolvedWorkerConfig;
  attempt: RecoveryAttempt;
  diag: DiagnosticsContext;
  store: RecoveryStateStore;
  signal: AbortSignal;
}): Promise<WorkerRunOutcome> {
  const { config, worker, attempt, diag, store, signal } = opts;

  if (!worker.binary) {
    const msg = worker.warning ?? "未找到可用的修复 Worker 运行时（agy），无法执行自动修复";
    store.emitEvent({ kind: "error", title: "无法启动修复 Worker", detail: msg, status: "error" });
    return {
      ok: false,
      exitCode: null,
      signal: null,
      aborted: false,
      timedOut: false,
      summary: msg,
      conversationId: null,
    };
  }

  let diagnosticsFile: string | null = null;
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    diagnosticsFile = path.join(config.stateDir, `attempt-${attempt.id}-diagnostics.json`);
    const payload = {
      attemptId: attempt.id,
      at: new Date().toISOString(),
      triggerReason: store.redact(diag.triggerReason),
      downDurationSec: diag.downDurationSec,
      consecutiveFailures: diag.consecutiveFailures,
      lastProbeReason: store.redact(diag.lastProbeReason),
      lastTargetExit: store.redact(diag.lastTargetExit),
      worker: {
        kernel: worker.kernel,
        model: worker.model,
        binary: worker.binary,
        source: worker.source,
        settingsRevision: worker.settingsRevision,
      },
      target: {
        bin: config.targetBin,
        args: config.targetArgs,
        cwd: config.targetCwd,
        repoDir: config.repoDir,
        dataDir: config.dataDir,
      },
      recentLogs: diag.recentLogs,
      externalLogTail: diag.externalLogTail.map((l) => store.redact(l)),
    };
    fs.writeFileSync(diagnosticsFile, JSON.stringify(payload, null, 2), "utf8");
    attempt.diagnosticsFile = diagnosticsFile;
  } catch {
    diagnosticsFile = null;
  }

  const prompt = buildRepairPrompt(config, worker, diag, diagnosticsFile);
  const parser = new AgyStreamParser(attempt.id, store);

  let command: string;
  let args: string[];
  let stdinText: string | undefined;

  if (worker.customCommand) {
    command = worker.customCommand;
    args = [...worker.customArgs];
    stdinText = prompt;
  } else {
    command = worker.binary;
    const timeoutSec = Math.max(10, Math.ceil(config.workerTimeoutMs / 1000));
    args = [
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
      "--dangerously-skip-permissions",
      "--settings",
      JSON.stringify({ agentMode: "", toolPermission: "always-proceed" }),
      "--print-timeout",
      `${timeoutSec}s`,
    ];
    if (worker.model) {
      args.push("--model", worker.model);
    }
    if (worker.customArgs.length > 0) {
      args.push(...worker.customArgs);
    }
    args.push("-p", prompt);
  }

  const cwd = fs.existsSync(config.repoDir) ? config.repoDir : config.targetCwd;
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: enrichedPath(process.env.PATH, defaultInstallDirs()),
    NEO_RECOVERY_ATTEMPT: String(attempt.id),
    NEO_RECOVERY_REPO_DIR: config.repoDir,
    NEO_RECOVERY_DATA_DIR: config.dataDir,
    NEO_RECOVERY_TARGET_BIN: config.targetBin,
    NEO_RECOVERY_MODEL: worker.model ?? "",
    NEO_RECOVERY_KERNEL: worker.kernel,
    NEO_RECOVERY_DIAGNOSTICS_FILE: diagnosticsFile ?? "",
    NEO_RECOVERY_DAEMON_PID: String(process.pid),
  };
  // Never pass Neo's API secret into the repair worker environment unless strictly needed
  delete childEnv.NEO_TOKEN;

  store.emitEvent({
    kind: "info",
    title: `正在启动修复 Worker (${worker.kernel}${worker.model ? ` / ${worker.model}` : ""})`,
    detail: `程序: ${command}\n工作目录: ${cwd}\n配置来源: ${worker.source}${
      worker.settingsRevision !== null ? ` (settings rev ${worker.settingsRevision})` : ""
    }${worker.warning ? `\n提示: ${worker.warning}` : ""}`,
    status: "info",
    meta: { command, cwd, kernel: worker.kernel, model: worker.model },
  });

  const stderrTail: string[] = [];
  const proc = new ManagedProcess({
    command,
    args,
    cwd,
    env: childEnv,
    stdinText,
    onStdoutLine: (line) => parser.feedLine(line),
    onStderrLine: (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 30) stderrTail.shift();
      store.emitEvent({
        kind: "worker_stderr",
        title: "Worker stderr",
        detail: line,
        status: "info",
      });
    },
  });

  let timedOut = false;
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    store.emitEvent({
      kind: "error",
      title: "修复 Worker 被中止",
      status: "error",
    });
    void proc.stop(3000);
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    store.emitEvent({
      kind: "error",
      title: `修复 Worker 超过时限 (${Math.round(config.workerTimeoutMs / 1000)}s)，正在终止`,
      status: "error",
    });
    void proc.stop(3000);
  }, config.workerTimeoutMs);
  timer.unref?.();

  const exitInfo = await proc.wait();
  clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);
  store.setAttemptWorkerExit(exitInfo.code, exitInfo.signal);

  const parsedResult = parser.getResult();
  const ok =
    !aborted &&
    !timedOut &&
    exitInfo.error === undefined &&
    exitInfo.code === 0 &&
    exitInfo.signal === null &&
    (parsedResult.status === null || parsedResult.status === "SUCCESS");

  let summary = parsedResult.lastText;
  if (!summary) {
    if (aborted) summary = "修复任务被中止";
    else if (timedOut) summary = `修复 Worker 超时 (${Math.round(config.workerTimeoutMs / 1000)}s)`;
    else if (exitInfo.error) summary = `无法启动 Worker: ${exitInfo.error}`;
    else if (parsedResult.error) summary = parsedResult.error;
    else if (!ok && stderrTail.length > 0) summary = stderrTail.slice(-5).join("\n");
    else if (ok) summary = "Worker 已完成修复流程并正常退出";
    else summary = `Worker 异常退出 (code=${exitInfo.code}, signal=${exitInfo.signal})`;
  }

  return {
    ok,
    exitCode: exitInfo.code,
    signal: exitInfo.signal,
    aborted,
    timedOut,
    summary: clipText(summary, 2000),
    conversationId: parser.getConversationId(),
  };
}
