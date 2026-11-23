/**
 * Main Recovery Supervisor (`src/supervisor.ts`).
 *
 * Independent daemon lifecycle:
 * 1. Owns single-instance lock under `<stateDir>/daemon.lock`.
 * 2. Launches and supervises Neo target process (`proxy` mode: EntryPoint on `--host:--port`
 *    and Neo on loopback `--internal-port`; `takeover` mode: Neo directly on `--host:--port`,
 *    EntryPoint bound on `--host:--port` only during Recovery Mode).
 * 3. Sniffs `/api/health` continuously; tolerates brief crashes with fast restarts while tracking
 *    continuous unavailability duration.
 * 4. Once continuously unavailable >= `unhealthyAfterMs` AND failed probes >= `minFailedProbes`,
 *    enters Recovery Mode: stops unhealthy Neo, keeps/binds Recovery Console on Neo's entry point,
 *    reads Neo's backend-configured worker from `<dataDir>/orchestrator.sqlite`, streams every
 *    worker step live over SSE, then restarts Neo and verifies `/api/health` stability.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { buildTargetArgs, VERSION, type DaemonConfig } from "./config.ts";
import { EntryPointServer } from "./entrypoint.ts";
import { probeHealth } from "./probe.ts";
import { enrichedPath, ManagedProcess } from "./process.ts";
import { RecoveryStateStore } from "./state.ts";
import { defaultInstallDirs, readRecoveryModeSetting, resolveWorkerConfig } from "./worker-config.ts";
import { readFileTailLines, runRecoveryWorker } from "./worker-runner.ts";

export const ALREADY_RUNNING_EXIT = 3;

function logStderr(msg: string): void {
  process.stderr.write(`[neo-recovery] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export async function allocateFreePort(host = "127.0.0.1"): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else if (port > 0) resolve(port);
        else reject(new Error("Could not allocate a free TCP port"));
      });
    });
  });
}

class DaemonLock {
  private readonly lockPath: string;
  private held = false;

  constructor(stateDir: string) {
    this.lockPath = path.join(stateDir, "daemon.lock");
  }

  acquire(host: string, port: number): { ok: true } | { ok: false; pid: number; port?: number } {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    if (fs.existsSync(this.lockPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.lockPath, "utf8")) as { pid?: number; port?: number };
        if (typeof raw.pid === "number" && raw.pid !== process.pid && isPidAlive(raw.pid)) {
          return { ok: false, pid: raw.pid, port: raw.port };
        }
      } catch {
        // stale or unreadable lockfile
      }
    }
    const payload = JSON.stringify({
      pid: process.pid,
      host,
      port,
      startedAt: new Date().toISOString(),
    });
    fs.writeFileSync(this.lockPath, payload, "utf8");
    this.held = true;
    return { ok: true };
  }

  updatePort(host: string, port: number): void {
    if (!this.held) return;
    try {
      fs.writeFileSync(
        this.lockPath,
        JSON.stringify({ pid: process.pid, host, port, startedAt: new Date().toISOString() }),
        "utf8",
      );
    } catch {
      // ignore
    }
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.lockPath, "utf8")) as { pid?: number };
      if (raw.pid === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // ignore
    }
  }
}

export class RecoverySupervisor {
  readonly config: DaemonConfig;
  readonly store: RecoveryStateStore;

  private readonly lock: DaemonLock;
  private entryServer: EntryPointServer | null = null;
  private targetProc: ManagedProcess | null = null;
  private entryPort: number;
  private targetPort: number;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private recoveryInFlight: Promise<void> | null = null;
  private activeWorkerAbort: AbortController | null = null;
  private lastLaunchAtMs = 0;
  private healthySinceMs: number | null = null;
  private suppressedNoticeSent = false;
  private stopping = false;

  constructor(config: DaemonConfig) {
    this.config = config;
    this.entryPort = config.port;
    this.targetPort = config.mode === "proxy" ? config.internalPort : config.port;
    this.lock = new DaemonLock(config.stateDir);
    const previewCmd = `${config.targetBin} ${config.targetArgs.join(" ")}`.trim();
    this.store = new RecoveryStateStore({
      version: VERSION,
      mode: config.mode,
      entryHost: config.host,
      entryPort: this.entryPort,
      targetPort: this.targetPort,
      targetCommand: previewCmd,
      dataDir: config.dataDir,
      repoDir: config.repoDir,
      stateDir: config.stateDir,
      unhealthyThresholdMs: config.unhealthyAfterMs,
      minFailedProbes: config.minFailedProbes,
      maxAttempts: config.maxAttempts,
      token: config.token,
    });
  }

  get boundEntryPort(): number {
    return this.entryPort;
  }

  get boundTargetPort(): number {
    return this.targetPort;
  }

  async start(): Promise<{ ok: true; entryPort: number; targetPort: number } | { ok: false; exitCode: number; error: string }> {
    const acquired = this.lock.acquire(this.config.host, this.config.port);
    if (!acquired.ok) {
      const where = acquired.port ? ` on port ${acquired.port}` : "";
      return {
        ok: false,
        exitCode: ALREADY_RUNNING_EXIT,
        error: `neo-recovery is already running (PID ${acquired.pid}${where}) for state dir ${this.config.stateDir}`,
      };
    }

    try {
      // Pre-resolve worker config so the console & logs show it immediately
      this.store.setWorkerConfig(resolveWorkerConfig(this.config));

      if (this.config.mode === "proxy") {
        this.entryServer = this.createEntryServer(this.config.port);
        this.entryPort = await this.entryServer.start();
        this.targetPort =
          this.config.internalPort > 0 ? this.config.internalPort : await allocateFreePort("127.0.0.1");
      } else {
        this.entryPort =
          this.config.port > 0 ? this.config.port : await allocateFreePort(this.config.host);
        this.targetPort = this.entryPort;
        this.entryServer = this.createEntryServer(this.entryPort);
      }

      this.lock.updatePort(this.config.host, this.entryPort);
      this.store.setPorts(this.entryPort, this.targetPort);

      this.store.setPhase("starting", "独立恢复守护进程已启动，正在启动目标 Neo 服务…");
      await this.launchTarget();

      // Run initial probe shortly after launch, then on fixed interval
      void this.tick();
      this.probeTimer = setInterval(() => {
        void this.tick();
      }, this.config.probeIntervalMs);
      this.probeTimer.unref?.();

      return { ok: true, entryPort: this.entryPort, targetPort: this.targetPort };
    } catch (err) {
      await this.stop();
      return {
        ok: false,
        exitCode: 1,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.store.setPhase("stopping", "守护进程收到停止信号，正在清理…");

    if (this.probeTimer !== null) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }

    if (this.activeWorkerAbort) {
      this.activeWorkerAbort.abort();
    }
    if (this.recoveryInFlight) {
      await Promise.race([this.recoveryInFlight.catch(() => {}), sleep(5000)]);
    }

    await this.stopTarget();

    if (this.entryServer) {
      await this.entryServer.stop();
    }
    this.lock.release();
  }

  private createEntryServer(port: number): EntryPointServer {
    return new EntryPointServer({
      host: this.config.host,
      port,
      mode: this.config.mode,
      token: this.config.token,
      store: this.store,
      hooks: {
        onAction: (action) => this.handleManualAction(action),
        onProxyError: (reason) => {
          if (this.stopping) return;
          if (this.store.getPhase() === "healthy") {
            this.healthySinceMs = null;
            this.store.markUnavailableNow(reason);
            this.store.setPhase("degraded", `入口转发检测到 Neo 不可达：${reason}`);
          }
        },
      },
    });
  }

  private handleManualAction(action: "recover" | "restart" | "cancel"): void {
    if (this.stopping) return;
    if (action === "cancel") {
      if (this.activeWorkerAbort) {
        this.store.emitEvent({
          kind: "info",
          title: "收到手动中止修复请求",
          status: "info",
        });
        this.activeWorkerAbort.abort();
      }
      return;
    }
    if (action === "recover") {
      if (this.recoveryInFlight) return;
      this.store.setCooldown(null, false);
      void this.enterRecovery("通过 Neo 入口手动触发自动修复");
      return;
    }
    if (action === "restart") {
      if (this.recoveryInFlight) return;
      void this.manualRestartOnly();
    }
  }

  private async manualRestartOnly(): Promise<void> {
    if (this.recoveryInFlight || this.stopping) return;
    const job = (async () => {
      this.store.setCooldown(null, false);
      this.store.setPhase("restarting", "收到手动重启指令，正在重新启动 Neo 并验证健康…");
      await this.stopTarget();
      if (this.config.mode === "takeover" && this.entryServer?.isListening) {
        await sleep(250);
        await this.entryServer.stop();
      }
      await this.launchTarget();
      const healthy = await this.waitForTargetHealthy();
      if (healthy) {
        this.healthySinceMs = Date.now();
        this.store.setPhase("healthy", "Neo 服务重启后恢复健康运行");
      } else {
        await this.stopTarget();
        if (this.config.mode === "takeover" && this.entryServer && !this.entryServer.isListening) {
          try {
            await this.entryServer.start();
          } catch (err) {
            logStderr(`Failed to rebind recovery console: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const retryAt = Date.now() + this.config.cooldownMs;
        this.store.setCooldown(retryAt, false);
        this.store.setPhase("cooldown", "手动重启未能让 Neo 恢复健康，已返回冷却状态");
      }
    })();
    this.recoveryInFlight = job;
    try {
      await job;
    } finally {
      if (this.recoveryInFlight === job) {
        this.recoveryInFlight = null;
      }
    }
  }

  private async launchTarget(): Promise<void> {
    if (this.stopping) return;
    if (this.targetProc?.isRunning) return;

    if (this.config.mode === "proxy" && this.config.internalPort === 0 && this.targetPort <= 0) {
      this.targetPort = await allocateFreePort("127.0.0.1");
      this.store.setPorts(this.entryPort, this.targetPort);
    }

    const bindHost = this.config.mode === "proxy" ? "127.0.0.1" : this.config.host;
    const args = buildTargetArgs(
      this.config.targetArgs,
      bindHost,
      this.targetPort,
      this.config.webDir,
      this.config.dataDir,
    );
    if (
      this.config.allowMultiple &&
      args[0] === "serve" &&
      !args.includes("--allow-multiple")
    ) {
      args.push("--allow-multiple");
    }

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      PATH: enrichedPath(process.env.PATH, defaultInstallDirs()),
      NEO_DATA_DIR: this.config.dataDir,
    };
    if (this.config.token) {
      childEnv.NEO_TOKEN = this.config.token;
    } else {
      delete childEnv.NEO_TOKEN;
    }
    if (this.config.allowMultiple) {
      childEnv.NEO_ALLOW_MULTIPLE = "1";
    }

    this.lastLaunchAtMs = Date.now();
    this.store.appendNeoLog(
      "system",
      `Launching Neo: ${this.config.targetBin} ${args.join(" ")} (cwd=${this.config.targetCwd})`,
    );

    const cwd = fs.existsSync(this.config.targetCwd) ? this.config.targetCwd : process.cwd();
    const proc = new ManagedProcess({
      command: this.config.targetBin,
      args,
      cwd,
      env: childEnv,
      onStdoutLine: (line) => this.store.appendNeoLog("stdout", line),
      onStderrLine: (line) => this.store.appendNeoLog("stderr", line),
      onExit: (info) => {
        if (this.targetProc === proc) {
          this.targetProc = null;
        }
        const desc = info.error
          ? `spawn error: ${info.error}`
          : `code=${info.code} signal=${info.signal ?? "none"}`;
        this.store.appendNeoLog("system", `Neo process exited (${desc})`);
        this.store.setTargetProcess(null, false, info);
      },
    });
    this.targetProc = proc;
    this.store.setTargetProcess(proc.pid ?? null, proc.isRunning);
  }

  private async stopTarget(): Promise<void> {
    const proc = this.targetProc;
    this.targetProc = null;
    if (!proc) return;
    await proc.stop(5000);
    this.store.setTargetProcess(null, false, proc.lastExit ?? undefined);
  }

  private async probeTargetOnce() {
    const probeHost = this.config.mode === "proxy" ? "127.0.0.1" : this.config.host;
    return await probeHealth({
      host: probeHost,
      port: this.targetPort,
      token: this.config.token,
      timeoutMs: this.config.probeTimeoutMs,
      requireReady: this.config.requireReady,
    });
  }

  private syncRecoveryMode(): boolean {
    const setting = readRecoveryModeSetting(this.config.dataDir);
    const toggled = this.store.setRecoveryMode(setting.enabled, setting.source);
    if (toggled) {
      this.suppressedNoticeSent = false;
      this.store.emitEvent({
        kind: "info",
        title: setting.enabled
          ? "已在 Neo 设置中开启自动恢复模式"
          : "已在 Neo 设置中关闭自动恢复模式（将仅保持监测与常规重启）",
        status: "info",
      });
    }
    return setting.enabled;
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.tickRunning || this.recoveryInFlight) return;
    this.tickRunning = true;
    try {
      const phase = this.store.getPhase();
      if (phase === "recovering" || phase === "restarting" || phase === "stopping") {
        return;
      }

      const recoveryEnabled = this.syncRecoveryMode();

      if (phase === "cooldown") {
        const nextRetry = this.store.getNextRetryAtMs();
        if (nextRetry !== null && Date.now() >= nextRetry) {
          if (recoveryEnabled) {
            void this.enterRecovery("冷却结束，自动开始新一轮恢复尝试");
          } else if (!this.suppressedNoticeSent) {
            this.suppressedNoticeSent = true;
            this.store.emitEvent({
              kind: "info",
              title: "冷却结束，但自动恢复模式已在 Neo 设置中关闭，暂停自动修复重试",
              status: "info",
            });
          }
        }
        return;
      }

      const probe = await this.probeTargetOnce();
      if (this.stopping || this.recoveryInFlight) return;
      this.store.recordProbe(probe);

      if (probe.ok) {
        this.suppressedNoticeSent = false;
        if (phase !== "healthy") {
          const needed = phase === "starting" ? 1 : this.config.stableProbes;
          if (this.store.getConsecutiveSuccesses() >= needed) {
            this.healthySinceMs = Date.now();
            this.store.setPhase("healthy", `Neo 服务已就绪并正常运行 (${probe.latencyMs}ms)`);
          }
        } else {
          if (this.healthySinceMs === null) {
            this.healthySinceMs = Date.now();
          }
          if (Date.now() - this.healthySinceMs >= this.config.resetAttemptsAfterMs) {
            this.store.resetConsecutiveAttempts();
          }
        }
        return;
      }

      // Probe failed
      this.healthySinceMs = null;
      if (phase === "healthy") {
        this.store.setPhase("degraded", `嗅探到 Neo 服务不可用：${probe.reason}`);
      } else if (phase === "starting" && !this.targetProc?.isRunning) {
        this.store.setPhase("degraded", `Neo 启动异常：${probe.reason}`);
      }

      const unavailableSince = this.store.getUnavailableSinceMs() ?? Date.now();
      const downMs = Date.now() - unavailableSince;
      const failedCount = this.store.getConsecutiveFailures();

      // Prolonged unavailability check -> enter Recovery Mode only when enabled in Neo settings!
      if (downMs >= this.config.unhealthyAfterMs && failedCount >= this.config.minFailedProbes) {
        if (this.syncRecoveryMode()) {
          const reason = `Neo 连续不可用 ${Math.round(downMs / 1000)}s（连续 ${failedCount} 次探测失败，最近错误：${probe.reason}）`;
          void this.enterRecovery(reason);
          return;
        }
        if (!this.suppressedNoticeSent) {
          this.suppressedNoticeSent = true;
          this.store.emitEvent({
            kind: "info",
            title: `Neo 已连续不可用 ${Math.round(downMs / 1000)}s，但恢复模式已在 Neo 设置中关闭，跳过自动修复`,
            status: "info",
          });
        }
      }

      // During brief outage (or while recovery mode is disabled), try fast normal restart if process died
      if (!this.targetProc?.isRunning && Date.now() - this.lastLaunchAtMs >= this.config.fastRestartDelayMs) {
        this.store.emitEvent({
          kind: "info",
          title: `目标进程已退出，尝试常规快速重启（已不可用 ${Math.round(downMs / 1000)}s / 阈值 ${Math.round(this.config.unhealthyAfterMs / 1000)}s）`,
          status: "info",
        });
        await this.launchTarget();
      }
    } finally {
      this.tickRunning = false;
    }
  }

  private async waitForTargetHealthy(): Promise<boolean> {
    const deadline = Date.now() + this.config.startupTimeoutMs;
    const stepMs = Math.min(1000, Math.max(100, this.config.probeIntervalMs));
    let okStreak = 0;

    while (!this.stopping && Date.now() < deadline) {
      if (!this.targetProc?.isRunning) {
        // Process died quickly after launch
        await sleep(Math.min(200, stepMs));
        if (!this.targetProc?.isRunning) {
          const exit = this.store.snapshot().lastTargetExit;
          this.store.emitEvent({
            kind: "error",
            title: `Neo 重启后进程立即退出 (code=${exit?.code ?? "?"}, signal=${exit?.signal ?? "none"})`,
            detail: exit?.error,
            status: "error",
          });
          return false;
        }
      }

      const probe = await this.probeTargetOnce();
      this.store.recordProbe(probe);
      if (probe.ok) {
        okStreak += 1;
        this.store.emitEvent({
          kind: "probe",
          title: `健康检查通过 (${okStreak}/${this.config.stableProbes}, ${probe.latencyMs}ms)`,
          status: okStreak >= this.config.stableProbes ? "done" : "running",
        });
        if (okStreak >= this.config.stableProbes) {
          return true;
        }
      } else {
        okStreak = 0;
      }
      await sleep(stepMs);
    }

    this.store.emitEvent({
      kind: "error",
      title: `等待 Neo 启动就绪超时 (${Math.round(this.config.startupTimeoutMs / 1000)}s)`,
      detail: this.store.snapshot().lastProbe?.reason,
      status: "error",
    });
    return false;
  }

  private async enterRecovery(triggerReason: string): Promise<void> {
    if (this.recoveryInFlight || this.stopping) return;

    const job = (async () => {
      this.store.setPhase("recovering", `进入自动恢复模式：${triggerReason}`);

      // 1. Stop unhealthy / hung Neo target cleanly so it does not interfere or hold ports
      await this.stopTarget();

      // 2. In takeover mode, bind Neo's entry point immediately so users can watch live repair details
      if (this.config.mode === "takeover" && this.entryServer && !this.entryServer.isListening) {
        try {
          await this.entryServer.start();
          this.store.emitEvent({
            kind: "info",
            title: `已在 Neo 入口 ${this.config.host}:${this.entryPort} 启动实时恢复控制台`,
            status: "done",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logStderr(`Cannot bind takeover recovery server: ${msg}`);
          this.store.emitEvent({
            kind: "error",
            title: `无法接管 Neo 入口端口 ${this.entryPort}`,
            detail: msg,
            status: "error",
          });
        }
      }

      if (this.stopping) return;

      // 3. Re-read Neo's backend-configured worker live from orchestrator.sqlite
      const workerCfg = resolveWorkerConfig(this.config);
      this.store.setWorkerConfig(workerCfg);
      const attempt = this.store.startAttempt(triggerReason, workerCfg, null);

      const snapBefore = this.store.snapshot();
      const downDurationSec = snapBefore.unavailableSince
        ? Math.max(0, Math.round((Date.now() - Date.parse(snapBefore.unavailableSince)) / 1000))
        : 0;
      const lastExit = snapBefore.lastTargetExit
        ? `code=${snapBefore.lastTargetExit.code}, signal=${snapBefore.lastTargetExit.signal ?? "none"}${
            snapBefore.lastTargetExit.error ? `, error=${snapBefore.lastTargetExit.error}` : ""
          }`
        : "(none recorded)";
      const prevAttempt = this.store.getLastAttempt();

      const abortCtrl = new AbortController();
      this.activeWorkerAbort = abortCtrl;

      let outcome;
      try {
        outcome = await runRecoveryWorker({
          config: this.config,
          worker: workerCfg,
          attempt,
          diag: {
            attemptId: attempt.id,
            triggerReason,
            downDurationSec,
            consecutiveFailures: snapBefore.consecutiveFailures,
            lastProbeReason: snapBefore.lastProbe?.reason ?? "unknown",
            lastTargetExit: lastExit,
            recentLogs: this.store.getRecentNeoLogs(80),
            externalLogTail: readFileTailLines(this.config.logFile, 60),
            previousAttemptSummary:
              prevAttempt && prevAttempt.outcome !== "recovered" ? prevAttempt.summary : undefined,
          },
          store: this.store,
          signal: abortCtrl.signal,
        });
      } finally {
        if (this.activeWorkerAbort === abortCtrl) {
          this.activeWorkerAbort = null;
        }
      }

      if (this.stopping) {
        this.store.finishAttempt("aborted", "守护进程正在停止");
        return;
      }

      if (outcome.aborted) {
        this.store.finishAttempt("aborted", outcome.summary);
        const nextRetry = Date.now() + this.config.cooldownMs;
        this.store.setCooldown(nextRetry, false);
        this.store.setPhase("cooldown", "修复任务已中止，进入冷却状态");
        return;
      }

      // 4. Restart Neo and verify health!
      this.store.setPhase(
        "restarting",
        outcome.ok
          ? "Worker 修复完成，正在重新启动 Neo 并验证健康…"
          : "Worker 已退出（存在异常），仍尝试重启 Neo 以检验是否可恢复…",
      );

      // In takeover mode, briefly flush SSE event then release entry port so Neo can bind it
      if (this.config.mode === "takeover" && this.entryServer?.isListening) {
        await sleep(300);
        await this.entryServer.stop();
      }

      await this.launchTarget();
      const healthy = await this.waitForTargetHealthy();

      if (this.stopping) {
        this.store.finishAttempt("aborted", "守护进程在重启验证期间停止");
        return;
      }

      if (healthy) {
        this.healthySinceMs = Date.now();
        this.store.finishAttempt("recovered", outcome.summary);
        this.store.setCooldown(null, false);
        this.store.setPhase("healthy", `自动恢复成功（第 #${attempt.id} 次尝试），Neo 服务已恢复正常！`);
        return;
      }

      // 5. Restart verification failed -> stop broken target, keep Recovery Console visible, enter cooldown
      await this.stopTarget();
      const failSummary = `${outcome.summary}\n[验证失败] 重启 Neo 后健康检查未通过：${
        this.store.snapshot().lastProbe?.reason ?? "未知原因"
      }`;
      this.store.finishAttempt("failed", failSummary);

      if (this.config.mode === "takeover" && this.entryServer && !this.entryServer.isListening) {
        try {
          await this.entryServer.start();
        } catch (err) {
          logStderr(`Cannot rebind takeover recovery console: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const attempts = this.store.getConsecutiveAttempts();
      const exhausted = attempts >= this.config.maxAttempts;
      const waitMs = exhausted
        ? this.config.exhaustedRetryMs
        : Math.min(300_000, this.config.cooldownMs * Math.pow(2, Math.max(0, attempts - 1)));
      const nextRetryAt = Date.now() + waitMs;
      this.store.setCooldown(nextRetryAt, exhausted);
      this.store.setPhase(
        "cooldown",
        exhausted
          ? `连续 ${attempts} 次自动修复未能恢复 Neo，已暂停高频重试，将于 ${Math.round(waitMs / 1000)}s 后再次尝试（可随时手动触发）`
          : `第 ${attempts}/${this.config.maxAttempts} 次修复后 Neo 仍未就绪，将在 ${Math.round(waitMs / 1000)}s 后重试`,
      );
    })();

    this.recoveryInFlight = job;
    try {
      await job;
    } finally {
      if (this.recoveryInFlight === job) {
        this.recoveryInFlight = null;
      }
    }
  }
}
