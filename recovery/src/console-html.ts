/**
 * Self-contained Recovery Console HTML served directly at Neo's entry point (`/`) during
 * outage / recovery / restart, and always accessible at `/_recovery`.
 *
 * Zero external assets, zero CDN dependencies, dark/light system theme matching Neo's Apple style,
 * auto-reuses Neo web app's `localStorage["neo-agent"].token`, streams live repair details over
 * authenticated `fetch()` SSE with automatic fallback polling.
 */

export function renderRecoveryConsoleHtml(authRequired: boolean): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Neo 自动恢复控制台</title>
<style>
  :root {
    --bg: #f5f5f7;
    --card: #ffffff;
    --card-muted: #f0f1f4;
    --text: #1d1d1f;
    --text-2: #6e6e73;
    --text-3: #86868b;
    --border: rgba(0,0,0,0.09);
    --accent: #007aff;
    --green: #28a745;
    --amber: #d97706;
    --red: #d93025;
    --purple: #6366f1;
    --code-bg: #f3f4f6;
    --shadow: 0 1px 3px rgba(0,0,0,0.05), 0 8px 24px rgba(0,0,0,0.04);
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1014;
      --card: #181920;
      --card-muted: #20222b;
      --text: #f5f5f7;
      --text-2: #a1a1aa;
      --text-3: #71717a;
      --border: rgba(255,255,255,0.10);
      --accent: #3b82f6;
      --green: #34d399;
      --amber: #f59e0b;
      --red: #f87171;
      --purple: #818cf8;
      --code-bg: #121319;
      --shadow: 0 2px 10px rgba(0,0,0,0.35);
    }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: var(--bg); color: var(--text);
    font-family: var(--sans); font-size: 14px; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 20px 18px 40px; }
  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    gap: 14px; flex-wrap: wrap; margin-bottom: 18px;
  }
  .brand { display: flex; align-items: center; gap: 11px; }
  .logo {
    width: 34px; height: 34px; border-radius: 9px;
    background: linear-gradient(135deg, #5ac8fa, #007aff 55%, #5856d6);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 16px; letter-spacing: -0.5px;
    box-shadow: 0 4px 12px rgba(0,122,255,0.28);
  }
  .brand-title { font-size: 17px; font-weight: 650; margin: 0; }
  .brand-sub { font-size: 12px; color: var(--text-2); margin-top: 1px; }
  .pill {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 5px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600;
    background: var(--card-muted); color: var(--text); border: 1px solid var(--border);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); }
  .pill.healthy { background: rgba(40,167,69,0.14); color: var(--green); border-color: rgba(40,167,69,0.25); }
  .pill.healthy .dot { background: var(--green); }
  .pill.recovering, .pill.restarting { background: rgba(0,122,255,0.14); color: var(--accent); border-color: rgba(0,122,255,0.28); }
  .pill.recovering .dot, .pill.restarting .dot { background: var(--accent); animation: pulse 1.3s ease-in-out infinite; }
  .pill.degraded, .pill.starting { background: rgba(217,119,6,0.14); color: var(--amber); border-color: rgba(217,119,6,0.28); }
  .pill.degraded .dot, .pill.starting .dot { background: var(--amber); animation: pulse 1.4s ease-in-out infinite; }
  .pill.cooldown { background: rgba(217,48,37,0.14); color: var(--red); border-color: rgba(217,48,37,0.28); }
  .pill.cooldown .dot { background: var(--red); }
  @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.82); } }

  .banner {
    display: none; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    padding: 13px 16px; border-radius: 12px; margin-bottom: 16px;
    background: rgba(40,167,69,0.13); border: 1px solid rgba(40,167,69,0.3); color: var(--text);
  }
  .banner.show { display: flex; }
  .banner strong { color: var(--green); }

  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 14px; box-shadow: var(--shadow); padding: 16px;
  }
  .stepper {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px;
  }
  .step {
    padding: 10px 12px; border-radius: 10px; background: var(--card);
    border: 1px solid var(--border); display: flex; align-items: center; gap: 9px;
    font-size: 12.5px; color: var(--text-2); transition: border-color .2s, background .2s;
  }
  .step .num {
    width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
    font-size: 11.5px; font-weight: 700; background: var(--card-muted); color: var(--text-2); flex-shrink: 0;
  }
  .step.active { border-color: var(--accent); color: var(--text); font-weight: 600; background: rgba(0,122,255,0.06); }
  .step.active .num { background: var(--accent); color: #fff; }
  .step.done { border-color: rgba(40,167,69,0.35); color: var(--text); }
  .step.done .num { background: var(--green); color: #fff; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(225px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .metric-label { font-size: 11.5px; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.4px; }
  .metric-val { font-size: 15px; font-weight: 620; margin-top: 4px; word-break: break-word; }
  .metric-sub { font-size: 12px; color: var(--text-2); margin-top: 3px; word-break: break-word; }
  .progress-bar {
    height: 6px; border-radius: 999px; background: var(--card-muted); overflow: hidden; margin-top: 9px;
  }
  .progress-fill { height: 100%; background: var(--accent); transition: width 0.4s ease; width: 0%; }

  .toolbar {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; flex-wrap: wrap; margin-bottom: 12px;
  }
  .tabs, .actions, .filters { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  button {
    font-family: inherit; font-size: 12.5px; font-weight: 550;
    padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--card); color: var(--text); cursor: pointer;
    transition: background .15s, border-color .15s, opacity .15s;
  }
  button:hover:not(:disabled) { background: var(--card-muted); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  button.primary:hover:not(:disabled) { filter: brightness(1.06); background: var(--accent); }
  button.danger { color: var(--red); border-color: rgba(217,48,37,0.3); }
  button.tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  button.chip { padding: 4px 10px; font-size: 12px; border-radius: 999px; }
  button.chip.active { background: rgba(0,122,255,0.14); color: var(--accent); border-color: rgba(0,122,255,0.3); }

  .stream-box {
    max-height: 540px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;
    padding-right: 4px;
  }
  .event-item {
    border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
    background: var(--card-muted);
  }
  .event-item.status-running { border-left: 3px solid var(--accent); }
  .event-item.status-done { border-left: 3px solid var(--green); }
  .event-item.status-error { border-left: 3px solid var(--red); }
  .event-item.status-info { border-left: 3px solid var(--text-3); }
  .event-head {
    display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  }
  .event-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .badge {
    font-size: 10.5px; font-weight: 650; padding: 2px 7px; border-radius: 6px;
    background: var(--card); color: var(--text-2); border: 1px solid var(--border); flex-shrink: 0;
  }
  .badge.tool { color: var(--purple); }
  .badge.text { color: var(--accent); }
  .badge.err { color: var(--red); }
  .event-title { font-weight: 600; font-size: 13px; word-break: break-word; }
  .event-time { font-size: 11.5px; color: var(--text-3); font-family: var(--mono); flex-shrink: 0; }
  .event-detail {
    margin-top: 8px; padding: 9px 10px; border-radius: 8px;
    background: var(--code-bg); font-family: var(--mono); font-size: 12px;
    white-space: pre-wrap; word-break: break-word; overflow-x: auto;
    max-height: 280px; overflow-y: auto; border: 1px solid var(--border);
  }
  details { margin-top: 6px; }
  details > summary { cursor: pointer; font-size: 12px; color: var(--accent); user-select: none; }

  .log-box {
    background: var(--code-bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px; max-height: 520px; overflow-y: auto;
    font-family: var(--mono); font-size: 12px; line-height: 1.5;
  }
  .log-line { white-space: pre-wrap; word-break: break-word; margin-bottom: 2px; }
  .log-line.stderr { color: var(--red); }
  .log-line.system { color: var(--accent); }
  .log-ts { color: var(--text-3); margin-right: 8px; }

  .empty { text-align: center; padding: 36px 16px; color: var(--text-2); }

  .auth-card {
    max-width: 440px; margin: 56px auto; padding: 24px;
  }
  .auth-card h2 { margin: 0 0 8px; font-size: 17px; }
  .auth-card p { margin: 0 0 14px; color: var(--text-2); font-size: 13px; }
  .auth-row { display: flex; gap: 8px; }
  input[type="password"], input[type="text"] {
    flex: 1; padding: 8px 11px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 13px;
  }
  .err-msg { color: var(--red); font-size: 12.5px; margin-top: 8px; }

  .hidden { display: none !important; }
  @media (max-width: 720px) {
    .stepper { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div class="brand">
      <div class="logo">N</div>
      <div>
        <div class="brand-title">Neo 独立守护与自动恢复</div>
        <div class="brand-sub" id="subline">连接守护进程状态流中…</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span class="pill" id="modePill"><span class="dot"></span><span id="modeText">自动恢复: 读取中</span></span>
      <span class="pill" id="phasePill"><span class="dot"></span><span id="phaseText">连接中</span></span>
      <span class="pill" id="streamPill"><span class="dot"></span><span id="streamText">实时流未连接</span></span>
    </div>
  </div>

  <div class="banner" id="recoveredBanner">
    <div><strong>Neo 服务已恢复健康</strong> · <span id="redirectHint">即将自动返回 Neo 界面…</span></div>
    <div class="actions">
      <button class="primary" id="btnEnterNeo">立即进入 Neo</button>
      <button id="btnStayHere">留在此页查看记录</button>
    </div>
  </div>

  <div class="card auth-card hidden" id="authCard">
    <h2>需要访问令牌</h2>
    <p>当前 Neo 入口启用了访问令牌保护，请输入与 Neo 相同的访问令牌以查看实时恢复过程。</p>
    <form id="authForm" class="auth-row">
      <input id="tokenInput" type="password" placeholder="输入 NEO_TOKEN…" autocomplete="current-password" />
      <button class="primary" type="submit">连接</button>
    </form>
    <div class="err-msg hidden" id="authErr"></div>
  </div>

  <div id="mainView" class="hidden">
    <div class="stepper">
      <div class="step" id="st-detect"><span class="num">1</span><span>嗅探异常</span></div>
      <div class="step" id="st-repair"><span class="num">2</span><span>Worker 诊断修复</span></div>
      <div class="step" id="st-restart"><span class="num">3</span><span>重启与健康验证</span></div>
      <div class="step" id="st-healthy"><span class="num">4</span><span>服务正常运行</span></div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="metric-label">服务探测状态</div>
        <div class="metric-val" id="mProbeTitle">—</div>
        <div class="metric-sub" id="mProbeSub">—</div>
        <div class="progress-bar hidden" id="thresholdBar"><div class="progress-fill" id="thresholdFill"></div></div>
      </div>
      <div class="card">
        <div class="metric-label">后端修复 Worker</div>
        <div class="metric-val" id="mWorkerTitle">—</div>
        <div class="metric-sub" id="mWorkerSub">—</div>
      </div>
      <div class="card">
        <div class="metric-label">恢复任务进度</div>
        <div class="metric-val" id="mAttemptTitle">—</div>
        <div class="metric-sub" id="mAttemptSub">—</div>
      </div>
      <div class="card">
        <div class="metric-label">目标服务进程</div>
        <div class="metric-val" id="mTargetTitle">—</div>
        <div class="metric-sub" id="mTargetSub">—</div>
      </div>
    </div>

    <div class="card">
      <div class="toolbar">
        <div class="tabs">
          <button class="tab active" data-tab="timeline">修复过程细节 (<span id="cntEvents">0</span>)</button>
          <button class="tab" data-tab="logs">Neo 服务日志 (<span id="cntLogs">0</span>)</button>
          <button class="tab" data-tab="history">历史恢复记录 (<span id="cntHistory">0</span>)</button>
        </div>
        <div class="actions">
          <button id="btnRecover">立即修复</button>
          <button id="btnRestart">尝试重启 Neo</button>
          <button class="danger hidden" id="btnCancel">中止修复</button>
        </div>
      </div>

      <div id="pane-timeline">
        <div class="toolbar" style="margin-bottom:10px;">
          <div class="filters">
            <button class="chip active" data-filter="all">全部</button>
            <button class="chip" data-filter="tools">工具调用</button>
            <button class="chip" data-filter="worker">Worker 输出</button>
            <button class="chip" data-filter="system">阶段/系统</button>
          </div>
          <label style="font-size:12px;color:var(--text-2);display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" id="chkAutoScroll" checked /> 自动滚动到底部
          </label>
        </div>
        <div class="stream-box" id="timelineBox">
          <div class="empty">等待事件流…</div>
        </div>
      </div>

      <div id="pane-logs" class="hidden">
        <div class="log-box" id="logsBox"><div class="empty">暂无 Neo 日志输出</div></div>
      </div>

      <div id="pane-history" class="hidden">
        <div class="stream-box" id="historyBox"><div class="empty">暂无历史恢复记录</div></div>
      </div>
    </div>
  </div>
</div>

<script>
(() => {
  const AUTH_REQUIRED = ${authRequired ? "true" : "false"};
  const STORAGE_KEY = "neo-agent";
  const isRecoveryRoute = location.pathname.startsWith("/_recovery");

  const PHASE_LABEL = {
    starting: "正在启动 Neo",
    healthy: "正常运行",
    degraded: "服务异常 · 观察中",
    recovering: "恢复模式 · 自动修复中",
    restarting: "修复完成 · 重启验证中",
    cooldown: "等待重试 / 冷却中",
    stopping: "守护进程停止中",
  };

  let state = null;
  let events = [];
  let neoLogs = [];
  let history = [];
  let activeTab = "timeline";
  let activeFilter = "all";
  let streamAbort = null;
  let redirectTimer = null;
  let stayOnPage = isRecoveryRoute;

  const $ = (id) => document.getElementById(id);

  function loadToken() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj.token === "string" && obj.token.trim()) return obj.token.trim();
      }
    } catch {}
    try {
      return sessionStorage.getItem("neo-recovery-token") || "";
    } catch { return ""; }
  }

  function saveToken(token) {
    try {
      let obj = {};
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) obj = JSON.parse(raw) || {};
      obj.token = token;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {}
    try { sessionStorage.setItem("neo-recovery-token", token); } catch {}
  }

  let token = loadToken();

  function authHeaders() {
    const h = { Accept: "application/json" };
    if (token) h.Authorization = "Bearer " + token;
    return h;
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toTimeString().slice(0, 8);
    } catch { return iso; }
  }

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "0s";
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + "m " + String(r).padStart(2, "0") + "s";
  }

  function setStreamBadge(connected, text) {
    const pill = $("streamPill");
    pill.className = "pill " + (connected ? "healthy" : "degraded");
    $("streamText").textContent = text;
  }

  function showAuth(errText) {
    $("authCard").classList.remove("hidden");
    $("mainView").classList.add("hidden");
    const el = $("authErr");
    if (errText) {
      el.textContent = errText;
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }

  function showMain() {
    $("authCard").classList.add("hidden");
    $("mainView").classList.remove("hidden");
  }

  function updateStepper(phase) {
    const ids = ["st-detect", "st-repair", "st-restart", "st-healthy"];
    const order = { starting: 2, degraded: 0, recovering: 1, restarting: 2, cooldown: 1, healthy: 3, stopping: -1 };
    const idx = order[phase] ?? 0;
    ids.forEach((id, i) => {
      const el = $(id);
      el.className = "step" + (phase === "healthy" ? " done" : i < idx ? " done" : i === idx ? " active" : "");
    });
  }

  function renderHeaderAndMetrics() {
    if (!state) return;
    const phase = state.phase;
    const recOn = state.recoveryModeEnabled !== false;
    $("modePill").className = "pill " + (recOn ? "healthy" : "degraded");
    $("modeText").textContent = recOn ? "自动恢复: 已开启" : "自动恢复: 已关闭";
    $("phasePill").className = "pill " + phase;
    $("phaseText").textContent = PHASE_LABEL[phase] || phase;
    $("subline").textContent =
      "模式: " + state.mode + " · 入口 :" + state.entryPort +
      (state.mode === "proxy" ? " → 内部 :" + state.targetPort : "") +
      " · 守护 PID " + state.daemonPid;

    updateStepper(phase);

    // Probe card
    const probe = state.lastProbe;
    $("mProbeTitle").textContent = probe
      ? (probe.ok ? "健康 (" + probe.latencyMs + "ms)" : "不可用 · 连续失败 " + state.consecutiveFailures + " 次")
      : "等待首次探测";
    const downMs = state.unavailableSince ? Math.max(0, Date.now() - Date.parse(state.unavailableSince)) : 0;
    let probeSub = probe ? probe.reason : "正在检查 /api/health";
    if (phase === "degraded" && state.unavailableSince) {
      if (!recOn) {
        probeSub += " · 已不可用 " + fmtDuration(downMs) + "（恢复模式已在 Neo 设置中关闭，不自动调用修复）";
        $("thresholdBar").classList.add("hidden");
      } else {
        const remain = Math.max(0, state.unhealthyThresholdMs - downMs);
        probeSub += " · 已不可用 " + fmtDuration(downMs) + " / 阈值 " + fmtDuration(state.unhealthyThresholdMs) +
          (remain > 0 ? "（" + fmtDuration(remain) + " 后自动修复）" : "（等待连续失败次数达标）");
        $("thresholdBar").classList.remove("hidden");
        $("thresholdFill").style.width = Math.min(100, Math.round((downMs / Math.max(1, state.unhealthyThresholdMs)) * 100)) + "%";
      }
    } else {
      $("thresholdBar").classList.add("hidden");
    }
    $("mProbeSub").textContent = probeSub;

    // Worker card
    const wc = state.workerConfig;
    if (wc) {
      $("mWorkerTitle").textContent = wc.kernel + (wc.model ? " · " + wc.model : " · 默认模型");
      $("mWorkerSub").textContent = "来源: " + wc.source +
        (wc.settingsRevision !== null ? " (rev " + wc.settingsRevision + ")" : "") +
        (wc.binary ? " · " + wc.binary : " · 未找到运行时") +
        (wc.warning ? " · " + wc.warning : "");
    } else {
      $("mWorkerTitle").textContent = "等待读取 Neo 后端配置";
      $("mWorkerSub").textContent = state.dataDir + "/orchestrator.sqlite";
    }

    // Attempt card
    const att = state.activeAttempt;
    if (att) {
      const elapsed = Date.now() - Date.parse(att.startedAt);
      $("mAttemptTitle").textContent = "第 #" + att.id + " 次恢复进行中 (" + fmtDuration(elapsed) + ")";
      $("mAttemptSub").textContent = "触发原因: " + att.triggerReason;
    } else if (phase === "cooldown" && state.nextRetryAt) {
      const wait = Math.max(0, Date.parse(state.nextRetryAt) - Date.now());
      $("mAttemptTitle").textContent = state.exhausted
        ? "连续 " + state.consecutiveAttempts + " 次修复未成功"
        : "第 " + state.consecutiveAttempts + "/" + state.maxAttempts + " 次失败 · 冷却中";
      $("mAttemptSub").textContent = "下次自动重试倒计时: " + fmtDuration(wait);
    } else {
      const last = history.length ? history[history.length - 1] : null;
      $("mAttemptTitle").textContent = last ? "最近修复 #" + last.id + " (" + last.outcome + ")" : "暂无恢复记录";
      $("mAttemptSub").textContent = last ? (last.summary || last.triggerReason) : "连续失败达阈值后自动进入恢复模式";
    }

    // Target card
    $("mTargetTitle").textContent = state.targetRunning
      ? "运行中 (PID " + (state.targetPid ?? "?") + ")"
      : "未运行";
    let targetSub = state.targetCommand;
    if (state.lastTargetExit && !state.targetRunning) {
      targetSub = "上次退出: code=" + state.lastTargetExit.code +
        (state.lastTargetExit.signal ? " signal=" + state.lastTargetExit.signal : "") +
        (state.lastTargetExit.error ? " (" + state.lastTargetExit.error + ")" : "");
    }
    $("mTargetSub").textContent = targetSub;

    // Buttons
    $("btnRecover").disabled = phase === "recovering" || phase === "restarting" || phase === "stopping";
    $("btnRestart").disabled = phase === "recovering" || phase === "restarting" || phase === "stopping";
    $("btnCancel").classList.toggle("hidden", phase !== "recovering");

    // Banner when healthy
    const banner = $("recoveredBanner");
    if (phase === "healthy") {
      banner.classList.add("show");
      if (!stayOnPage && !isRecoveryRoute) {
        $("btnStayHere").classList.remove("hidden");
        if (!redirectTimer) {
          let sec = 3;
          $("redirectHint").textContent = sec + " 秒后自动进入 Neo 界面…";
          redirectTimer = setInterval(() => {
            sec -= 1;
            if (sec <= 0) {
              clearInterval(redirectTimer);
              redirectTimer = null;
              location.replace("/");
            } else {
              $("redirectHint").textContent = sec + " 秒后自动进入 Neo 界面…";
            }
          }, 1000);
        }
      } else {
        $("btnStayHere").classList.add("hidden");
        $("redirectHint").textContent = "当前在守护状态页，随时可返回 Neo。";
      }
    } else {
      banner.classList.remove("show");
      if (redirectTimer) { clearInterval(redirectTimer); redirectTimer = null; }
    }
  }

  function matchesFilter(ev) {
    if (activeFilter === "all") return true;
    if (activeFilter === "tools") return ev.kind === "tool_start" || ev.kind === "tool_end";
    if (activeFilter === "worker") return ev.kind === "worker_text" || ev.kind === "worker_log" || ev.kind === "worker_stderr" || ev.kind === "worker_result" || ev.kind === "worker_init";
    if (activeFilter === "system") return ev.kind === "phase" || ev.kind === "probe" || ev.kind === "info" || ev.kind === "error";
    return true;
  }

  function badgeMeta(ev) {
    switch (ev.kind) {
      case "tool_start": return ["工具运行中", "tool"];
      case "tool_end": return [ev.status === "error" ? "工具失败" : "工具完成", ev.status === "error" ? "err" : "tool"];
      case "worker_text": return ["Worker", "text"];
      case "worker_init": return ["会话", "text"];
      case "worker_result": return ["结果", ev.status === "error" ? "err" : "text"];
      case "worker_stderr": return ["stderr", "err"];
      case "phase": return ["阶段", ""];
      case "error": return ["错误", "err"];
      default: return ["信息", ""];
    }
  }

  function renderTimeline() {
    $("cntEvents").textContent = String(events.length);
    const box = $("timelineBox");
    const visible = events.filter(matchesFilter);
    if (visible.length === 0) {
      box.innerHTML = '<div class="empty">暂无匹配的修复过程记录</div>';
      return;
    }
    const html = visible.map((ev) => {
      const [label, cls] = badgeMeta(ev);
      const dur = ev.meta && typeof ev.meta.durationMs === "number" ? " · " + ev.meta.durationMs + "ms" : "";
      let detailHtml = "";
      if (ev.detail) {
        const isTool = ev.kind === "tool_start" || ev.kind === "tool_end";
        const long = ev.detail.length > 360;
        if (isTool && long) {
          detailHtml = '<details' + (ev.status === "running" || ev.status === "error" ? " open" : "") +
            '><summary>展开工具输入与输出详情 (' + ev.detail.length + ' 字符)</summary>' +
            '<div class="event-detail">' + esc(ev.detail) + '</div></details>';
        } else {
          detailHtml = '<div class="event-detail">' + esc(ev.detail) + '</div>';
        }
      }
      return '<div class="event-item status-' + esc(ev.status || "info") + '">' +
        '<div class="event-head">' +
          '<div class="event-left">' +
            '<span class="badge ' + cls + '">' + esc(label) + '</span>' +
            '<span class="event-title">' + esc(ev.title) + '</span>' +
          '</div>' +
          '<span class="event-time">' + esc(fmtTime(ev.at)) + esc(dur) + '</span>' +
        '</div>' +
        detailHtml +
      '</div>';
    }).join("");
    box.innerHTML = html;
    if ($("chkAutoScroll").checked) {
      box.scrollTop = box.scrollHeight;
    }
  }

  function renderLogs() {
    $("cntLogs").textContent = String(neoLogs.length);
    const box = $("logsBox");
    if (neoLogs.length === 0) {
      box.innerHTML = '<div class="empty">暂无 Neo 日志输出</div>';
      return;
    }
    box.innerHTML = neoLogs.map((l) =>
      '<div class="log-line ' + esc(l.stream) + '"><span class="log-ts">' +
      esc(fmtTime(l.at)) + '</span>' + esc(l.text) + '</div>'
    ).join("");
    if ($("chkAutoScroll").checked) {
      box.scrollTop = box.scrollHeight;
    }
  }

  function renderHistory() {
    $("cntHistory").textContent = String(history.length);
    const box = $("historyBox");
    if (history.length === 0) {
      box.innerHTML = '<div class="empty">暂无历史恢复记录</div>';
      return;
    }
    box.innerHTML = [...history].reverse().map((att) => {
      const dur = att.finishedAt ? fmtDuration(Date.parse(att.finishedAt) - Date.parse(att.startedAt)) : "进行中";
      const st = att.outcome === "recovered" ? "done" : att.outcome === "failed" ? "error" : "info";
      return '<div class="event-item status-' + st + '">' +
        '<div class="event-head">' +
          '<div class="event-left">' +
            '<span class="badge">' + esc(att.outcome) + '</span>' +
            '<span class="event-title">恢复 #' + att.id + ' · ' + esc(att.workerKernel) + (att.workerModel ? ' / ' + esc(att.workerModel) : '') + '</span>' +
          '</div>' +
          '<span class="event-time">' + esc(fmtTime(att.startedAt)) + ' · 耗时 ' + esc(dur) + '</span>' +
        '</div>' +
        '<div class="metric-sub" style="margin-top:6px;">触发原因: ' + esc(att.triggerReason) + '</div>' +
        (att.summary ? '<div class="event-detail">' + esc(att.summary) + '</div>' : '') +
      '</div>';
    }).join("");
  }

  function applySnapshot(snap) {
    state = snap;
    events = Array.isArray(snap.events) ? snap.events : [];
    neoLogs = Array.isArray(snap.neoLogs) ? snap.neoLogs : [];
    history = Array.isArray(snap.history) ? snap.history : [];
    showMain();
    renderHeaderAndMetrics();
    renderTimeline();
    renderLogs();
    renderHistory();
  }

  function upsertEvent(ev) {
    const idx = events.findIndex((x) => x.id === ev.id || (ev.stepKey && x.stepKey === ev.stepKey));
    if (idx !== -1) events[idx] = ev;
    else {
      events.push(ev);
      if (events.length > 400) events.shift();
    }
    renderTimeline();
  }

  async function fetchSnapshot() {
    const res = await fetch("/_recovery/status", { headers: authHeaders(), cache: "no-store" });
    if (res.status === 401) {
      showAuth(token ? "访问令牌无效，请重新输入" : "");
      return false;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const snap = await res.json();
    applySnapshot(snap);
    return true;
  }

  async function connectStream() {
    if (streamAbort) streamAbort.abort();
    const ctrl = new AbortController();
    streamAbort = ctrl;
    try {
      const ok = await fetchSnapshot();
      if (!ok) return;
      const res = await fetch("/_recovery/events", {
        headers: authHeaders(),
        signal: ctrl.signal,
        cache: "no-store",
      });
      if (res.status === 401) {
        showAuth("访问令牌无效，请重新输入");
        return;
      }
      if (!res.ok || !res.body) throw new Error("Stream HTTP " + res.status);
      setStreamBadge(true, "实时流已连接");

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf("\\n\\n")) !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let evType = "message";
          const dataLines = [];
          for (const line of block.split(/\\r?\\n/)) {
            if (line.startsWith("event:")) evType = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          try {
            const payload = JSON.parse(dataLines.join("\\n"));
            if (evType === "snapshot") applySnapshot(payload);
            else if (evType === "state") {
              state = Object.assign({}, state || {}, payload);
              renderHeaderAndMetrics();
            } else if (evType === "event") {
              upsertEvent(payload);
            } else if (evType === "log") {
              neoLogs.push(payload);
              if (neoLogs.length > 300) neoLogs.shift();
              renderLogs();
            } else if (evType === "history") {
              history = payload;
              renderHistory();
            }
          } catch {}
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setStreamBadge(false, "正在重连…");
    }
    if (!ctrl.signal.aborted) {
      setTimeout(() => void connectStream(), 1500);
    }
  }

  async function postAction(action) {
    try {
      const res = await fetch("/_recovery/action", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify({ action }),
      });
      if (res.status === 401) {
        showAuth("需要有效的访问令牌");
        return;
      }
      await fetchSnapshot();
    } catch {}
  }

  document.querySelectorAll("button.tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll("button.tab").forEach((b) => b.classList.toggle("active", b === btn));
      ["timeline", "logs", "history"].forEach((name) => {
        $("pane-" + name).classList.toggle("hidden", name !== activeTab);
      });
    });
  });

  document.querySelectorAll("button.chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.filter;
      document.querySelectorAll("button.chip").forEach((b) => b.classList.toggle("active", b === btn));
      renderTimeline();
    });
  });

  $("btnRecover").addEventListener("click", () => void postAction("recover"));
  $("btnRestart").addEventListener("click", () => void postAction("restart"));
  $("btnCancel").addEventListener("click", () => void postAction("cancel"));
  $("btnEnterNeo").addEventListener("click", () => location.replace("/"));
  $("btnStayHere").addEventListener("click", () => {
    stayOnPage = true;
    if (redirectTimer) { clearInterval(redirectTimer); redirectTimer = null; }
    if (!isRecoveryRoute && window.history && window.history.replaceState) {
      window.history.replaceState({}, "", "/_recovery");
    }
    renderHeaderAndMetrics();
  });

  $("authForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const val = $("tokenInput").value.trim();
    if (!val) return;
    token = val;
    saveToken(token);
    void connectStream();
  });

  // Periodic UI tick to keep countdown timers crisp every second
  setInterval(() => {
    if (state && (state.phase === "degraded" || state.phase === "recovering" || state.phase === "cooldown")) {
      renderHeaderAndMetrics();
    }
  }, 1000);

  if (AUTH_REQUIRED && !token) {
    showAuth("");
  } else {
    void connectStream();
  }
})();
</script>
</body>
</html>`;
}
