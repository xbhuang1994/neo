/**
 * L3 Real-Model Routing Evaluation Harness (Route-Only Sandbox) for Neo Historical-Ticket Recall v2.
 *
 * Evaluates the orchestrator routing prompt (`compose("orchestrator")`) + live `candidateCard` + read-only
 * retrieval tools (`orchestrator_search`, `orchestrator_read`) on the 45-case stratified gold dataset
 * (`benchmarks/datasets/routing_gold_v1.jsonl`).
 *
 * Key design choices:
 *   - Route-Only Sandbox: intercepts `orchestrator_route` arguments directly (never spawns Workers or Sidecars),
 *     avoiding the `decision` table conflation where `attach` and `sidecar` both record `kind: "ignore"`.
 *   - 5x5+2 Confusion Matrix: rows = gold (`sidecar`, `attach`, `accept`, `ignore`, `clarify`); columns track
 *     exact matches plus dedicated `wrong_ticket_sidecar` and `wrong_ticket_attach` columns.
 *   - 4-Way Automatic Root-Cause Attribution: `RETRIEVAL_FN`, `RETRIEVAL_FP_ANCHOR`, `MODEL_LAZINESS_FN`,
 *     `MODEL_MISROUTE_FP`.
 *   - Hard Release Gates + Baseline Diff Blocking: blocks on any newly introduced Critical FP or gate failure.
 *
 * Usage:
 *   bun run benchmarks/routing-eval.ts --dry-run
 *   bun run benchmarks/routing-eval.ts --model <id> --runs 3 --group G1,G3 --save-baseline /tmp/base.json
 *   bun run benchmarks/routing-eval.ts --model <id> --baseline /tmp/base.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  App,
  BaseKernels,
  Protocol,
  buildAntigravityOptions,
  defaultTimings,
  mainSpecs,
  prompts,
  type ModelOption,
  type SessionSpec,
} from "../src/app/index.ts";
import type { Kernel } from "../src/app/settings.ts";
import {
  dispositionAt,
  formatIso,
  mandateBasisVia,
  type Candidate,
  type ChannelRef,
  type Thread,
  type Ticket,
  type TicketOutcome,
  type Trigger,
  type TriggerDisposition,
} from "../src/core/index.ts";
import {
  AntigravityDriver,
  GUARD_ALLOW,
  UnboundedChannel,
  errorMessage,
  guardBlock,
  isRecord,
  textBlock,
  type Driver,
  type DriverEvent,
  type Guard,
  type ToolHost,
  type ToolSpec,
} from "../src/kernel/index.ts";
import { SCHEMA_VERSION } from "../src/store/index.ts";
import { TempDir } from "../src/testkit/index.ts";

// ---------------------------------------------------------------------------
// Public Types & Constants
// ---------------------------------------------------------------------------

export type GoldGroup =
  | "G1_sidecar_hit"
  | "G2_attach_hit"
  | "G3_hard_negative"
  | "G4_clean_negative"
  | "G5_ambiguous_clarify"
  | "G6_guardrails";

export type Surface = "wechat" | "web";

export type SeedProfileName =
  | "deep_history_60"
  | "twin_hard_negatives"
  | "ambiguous_pairs"
  | "guardrails_stopped_handed_back";

export type RouteKind = "sidecar" | "attach" | "accept" | "ignore" | "clarify" | "stop";

export type MatrixRow = "sidecar" | "attach" | "accept" | "ignore" | "clarify";

export type MatrixCol =
  | "sidecar"
  | "attach"
  | "accept"
  | "ignore"
  | "clarify"
  | "wrong_ticket_sidecar"
  | "wrong_ticket_attach"
  | "other_or_error";

export type Attribution =
  | "OK"
  | "RETRIEVAL_FN"
  | "RETRIEVAL_FP_ANCHOR"
  | "MODEL_LAZINESS_FN"
  | "MODEL_MISROUTE_FP"
  | "EXEC_ERROR";

export type FpSeverity = "critical" | "high" | "medium" | "low";

export interface ExpectedRetrieval {
  target_ticket_ids: string[];
  expect_in_card: boolean;
  requires_search: boolean;
  forbidden_card_ticket_ids: string[];
  expect_ambiguous?: boolean;
}

export interface GoldRoute {
  kind: RouteKind;
  ticket_id: string | null;
  acceptable_ticket_ids: string[];
  expected_related_ticket_ids?: string[];
  clarify_candidate_ids?: string[];
  forbidden_kinds: RouteKind[];
  forbidden_ticket_ids: string[];
}

export interface GoldCase {
  id: string;
  group: GoldGroup;
  surface: Surface;
  thread_key: string;
  seed_profile: SeedProfileName;
  user_message: string;
  expected_retrieval: ExpectedRetrieval;
  gold_route: GoldRoute;
  fp_severity: FpSeverity;
  notes?: string;
}

export interface CapturedRouteCall {
  kind: string;
  trigger_id: string;
  ticket_id: string | null;
  related_ticket_ids: string[];
  note: string | null;
  question: string | null;
  reason: string | null;
  raw: Record<string, unknown>;
}

export interface SearchInvocation {
  query: string;
  returned_ticket_ids: string[];
}

export interface ReadInvocation {
  resource: string;
  offset: number;
  limit: number | null;
}

export interface RetrievalTrace {
  cardRelatedIds: string[];
  cardRecalledIds: string[];
  cardOtherThreadIds: string[];
  cardAllTicketIds: string[];
  cardRecalledConfidences: Record<string, string>;
  cardTicketsTotal: number;
  searchCalls: SearchInvocation[];
  readCalls: ReadInvocation[];
  policyViolations: string[];
}

export interface SingleRunOutcome {
  runIndex: number;
  captured: CapturedRouteCall | null;
  trace: RetrievalTrace;
  passed: boolean;
  exactTargetMatch: boolean;
  matrixRow: MatrixRow;
  matrixCol: MatrixCol;
  attribution: Attribution;
  criticalFp: boolean;
  falseAttach: boolean;
  misroute: boolean;
  searchCompliant: boolean | null;
  spuriousSearch: boolean;
  latencyMs: number;
  error?: string;
}

export interface CaseEvalResult {
  testCase: GoldCase;
  runs: SingleRunOutcome[];
  /** Pass@1 outcome (run 0). */
  pass1: SingleRunOutcome;
  /** Majority@N winning outcome (equals pass1 when runs === 1). */
  majority: SingleRunOutcome;
}

export interface GateCheck {
  name: string;
  actual: number;
  threshold: string;
  passed: boolean;
}

export interface EvalMetrics {
  totalCases: number;
  positiveCases: number;
  negativeAndGuardrailCases: number;
  clarifyGoldCases: number;
  tpRatePass1: number;
  tpRateMajority: number;
  totalMisrouteRate: number;
  negativeMisrouteRate: number;
  falseAttachRate: number;
  wrongTicketSidecarCount: number;
  wrongTicketAttachCount: number;
  criticalFpCount: number;
  clarifyPrecision: number;
  clarifyRecall: number;
  searchComplianceRate: number;
  spuriousSearchRate: number;
  guardrailPassRate: number;
  meanLatencyMs: number;
}

export interface EvalReport {
  schemaVersion: string;
  generatedAt: string;
  mode: "dry-run" | "real-llm";
  model: string;
  runsPerCase: number;
  groupsFilter: string[];
  metrics: EvalMetrics;
  confusionMatrix: Record<MatrixRow, Record<MatrixCol, number>>;
  attributionCounts: Record<Attribution, number>;
  groupStats: Record<GoldGroup, { total: number; passed: number; passRate: number; criticalFp: number }>;
  gates: GateCheck[];
  allGatesPassed: boolean;
  cases: Array<{
    id: string;
    group: GoldGroup;
    passed: boolean;
    predictedKind: string | null;
    predictedTicketId: string | null;
    matrixCol: MatrixCol;
    attribution: Attribution;
    criticalFp: boolean;
    falseAttach: boolean;
    searchCalls: number;
    latencyMs: number;
    error?: string;
  }>;
}

export interface BaselineDiff {
  blocked: boolean;
  reasons: string[];
  newCriticalFpIds: string[];
  resolvedCriticalFpIds: string[];
  regressedCaseIds: string[];
  improvedCaseIds: string[];
  deltaTpRate: number;
  deltaMisrouteRate: number;
  deltaFalseAttachRate: number;
}

export interface CliOptions {
  dryRun: boolean;
  model: string | undefined;
  runs: number;
  groups: GoldGroup[];
  baselinePath: string | undefined;
  saveBaselinePath: string | undefined;
  datasetPath: string;
  program: string;
  concurrency: number;
  timeoutMs: number;
  json: boolean;
  help: boolean;
}

export const EXPECTED_GROUP_COUNTS: Readonly<Record<GoldGroup, number>> = {
  G1_sidecar_hit: 10,
  G2_attach_hit: 10,
  G3_hard_negative: 10,
  G4_clean_negative: 8,
  G5_ambiguous_clarify: 5,
  G6_guardrails: 2,
};

export const TOTAL_GOLD_CASES = 45;

export const MATRIX_ROWS: readonly MatrixRow[] = ["sidecar", "attach", "accept", "ignore", "clarify"];

export const MATRIX_COLS: readonly MatrixCol[] = [
  "sidecar",
  "attach",
  "accept",
  "ignore",
  "clarify",
  "wrong_ticket_sidecar",
  "wrong_ticket_attach",
  "other_or_error",
];

export const ATTRIBUTION_KEYS: readonly Attribution[] = [
  "OK",
  "RETRIEVAL_FN",
  "RETRIEVAL_FP_ANCHOR",
  "MODEL_LAZINESS_FN",
  "MODEL_MISROUTE_FP",
  "EXEC_ERROR",
];

export const GATES = {
  minTpRatePass1: 0.88,
  minTpRateMajority3: 0.92,
  maxTotalMisrouteRate: 0.05,
  maxFalseAttachRate: 0.02,
  minClarifyPrecision: 0.85,
  minClarifyRecall: 0.80,
  minSearchCompliance: 0.95,
  maxTpDropFromBaseline: 0.02,
} as const;

const VALID_GROUPS: ReadonlySet<string> = new Set(Object.keys(EXPECTED_GROUP_COUNTS));
const VALID_SURFACES: ReadonlySet<string> = new Set(["wechat", "web"]);
const VALID_PROFILES: ReadonlySet<string> = new Set([
  "deep_history_60",
  "twin_hard_negatives",
  "ambiguous_pairs",
  "guardrails_stopped_handed_back",
]);
const VALID_KINDS: ReadonlySet<string> = new Set(["sidecar", "attach", "accept", "ignore", "clarify", "stop"]);
const VALID_SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low"]);

const DEFAULT_DATASET_PATH = path.resolve(import.meta.dir, "datasets/routing_gold_v1.jsonl");
const BASE_ANCHOR_MS = Date.parse("2026-11-24T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Seed Profiles (Deterministic Historical Ticket Catalogs)
// ---------------------------------------------------------------------------

interface SeedTicketSpec {
  id: string;
  title: string;
  asked: string;
  digest: string;
  summary: string;
  threadKey: string;
  surface: Surface;
  createdHoursAgo: number;
  updatedHoursAgo: number;
  status: "completed" | "open_idle" | "open_working" | "stopped" | "dropped";
  endedReason?: string;
  artifacts?: string[];
  worktreeName: string;
}

const FILLER_TOPICS: ReadonlyArray<readonly [slug: string, title: string, digest: string]> = [
  ["meal-prep", "一周工作日低脂高蛋白备餐食谱", "整理周一至周五鸡胸肉、三文鱼与糙米快手备餐清单与采购量。"],
  ["nginx-tls", "排查静态站点 Nginx TLS 1.3 证书自动续期", "修复 certbot hook 未 reload Nginx 导致的证书过期告警。"],
  ["nas-backup", "家用群晖 NAS 照片异地加密增量备份脚本", "配置 restic 定时同步至对象存储并校验恢复完整性。"],
  ["piano-plan", "孩子每周钢琴练习曲目与节拍器打卡表", "按 30 分钟每日分段安排音阶、哈农与考级曲目复习。"],
  ["sqlite-wal", "调研 SQLite WAL 检查点阻塞与页面缓存参数", "对比 wal_autocheckpoint 与 mmap_size 对读延迟的影响。"],
  ["react-table", "修复管理端表格服务端分页排序状态重置问题", "切换筛选条件时保持列宽并将页码归零。"],
  ["wifi-mesh", "家庭两层户型 Wi-Fi 6E Mesh 节点布点优化", "实测弱电箱回程吞吐与 5GHz 信道干扰情况。"],
  ["podcast-rss", "自建播客 RSS 聚合与离线音频下载定时脚本", "每天凌晨拉取订阅源并转为低码率 opus 归档。"],
  ["git-hooks", "统一仓库 pre-commit 格式化与 lint 检查钩子", "增加快速增量校验，跳过未改动目录缩短提交耗时。"],
  ["docker-prune", "清理测试机过期 Docker 镜像与悬空卷脚本", "保留最近 7 天构建缓存并释放 48GB 磁盘空间。"],
  ["coffee-log", "手冲咖啡豆研磨度与萃取水温对比记录表", "汇总埃塞俄比亚水洗与哥伦比亚蜜处理冲煮参数。"],
  ["plant-care", "阳台绿植四季浇水施肥周期提醒清单", "覆盖琴叶榕、龟背竹、蓝雪花与迷迭香养护要点。"],
  ["bike-route", "周末百公里滨江公路车骑行补给路线图", "标注沿途饮水点、爬坡坡度与高德 GPX 轨迹导出。"],
  ["font-subset", "中文字体子集化压缩优化首页首屏加载", "将 6.8MB 字体包按常用 3500 字裁剪至 420KB woff2。"],
  ["ssh-bastion", "配置多跳板机 SSH ProxyJump 与硬件密钥代理", "消除明文私钥落盘风险并统一 config 别名。"],
  ["dns-doh", "排查公司内网 Split-DNS 与 DoH 冲突解析失败", "为内部域名单独配置上游转发规则恢复正常解析。"],
  ["kindle-sync", "整理 Kindle 读书笔记 Markdown 自动归档工具", "按书名拆分高亮摘录并去重重复标注。"],
  ["camera-lens", "全画幅 35mm 与 50mm 定焦人文镜头对比选型", "从重量、暗光对焦与二手保值率三方面给出建议。"],
  ["smart-home", "HomeAssistant 客厅人体传感器夜间起夜灯联动", "23 点后仅触发 10% 暖光灯带，无人 2 分钟自动关闭。"],
  ["resume-en", "润色英文技术简历系统架构与性能数据表述", "将 3 段核心项目改写为量化 STAR 句式并控制在两页内。"],
  ["car-maint", "新能源车 4 万公里保养项目核对与报价清单", "区分必做制动液更换与可跳过的非必要清洗项。"],
  ["book-club", "本月技术读书会《数据密集型应用系统设计》导读", "提炼第 7 章事务隔离级别与快照隔离案例。"],
  ["weather-bot", "编写通勤时段降雨提醒极简 Webhook 脚本", "每天早 7:30 检查未来 3 小时降水量超过 1mm 即推送。"],
  ["svg-icons", "合并重构前端散落 SVG 图标为雪碧图组件", "去除冗余元数据减少 38% 图标体积。"],
  ["log-rotate", "配置生产服务 JSON 日志按天切割与 gzip 压缩", "保留 14 天热日志并自动上传归档桶。"],
  ["ebook-epub", "将技术专栏合集转换为排版整洁的 EPUB 电子书", "修复代码块换行截断并补全章节目录索引。"],
  ["desk-ergo", "居家办公桌显示器支架与人体工学椅高度校准", "按 176cm 身高给出眼平线、肘部与脚踏尺寸参考。"],
  ["pet-vet", "家里布偶猫年度疫苗与体内外驱虫日程记录", "汇总狂犬与猫三联接种日期及体检血常规基线。"],
  ["anki-vocab", "从技术论文 PDF 批量提取生词生成 Anki 卡片", "附带原句上下文与音标释义，导出 apkg 包。"],
  ["vpn-split", "优化 WireGuard 隧道分流规则降低视频会议抖动", "将国内会议网段直连，办公内网走隧道。"],
  ["sql-index", "分析慢查询日志并为订单检索补齐复合索引", "将高频筛选 SQL 耗时从 820ms 降至 14ms。"],
  ["ci-cache", "排查构建流水线依赖缓存命中率下降原因", "修正 lockfile 哈希键计算逻辑恢复缓存复用。"],
  ["music-flac", "批量整理本地无损 FLAC 音乐库 ID3 标签与封面", "统一专辑艺术家字段并修复乱码曲名。"],
  ["home-budget", "整理今年上半年家庭固定支出与订阅服务盘点", "找出 4 项长期未使用的自动续费会员并列出取消清单。"],
  ["api-rate", "为对外开放接口补充令牌桶限流与 429 重试头", "单 IP 限制 120 req/min 并补充压测验证。"],
  ["photo-exif", "编写脚本按拍摄年月自动归档相机 RAW 原片", "读取 EXIF DateTimeOriginal 并校验重复文件哈希。"],
  ["markdown-toc", "给长篇架构文档自动生成多级锚点目录脚本", "兼容中英文标题 slug 规则并校验死链。"],
  ["sleep-track", "导出手环近三个月深睡比例与入睡时间趋势图", "对比工作日与周末睡眠规律给出作息微调建议。"],
  ["redis-ttl", "排查缓存雪崩风险并给热点键添加随机过期抖动", "在基准 TTL 上叠加 ±10% 随机偏移避免同时失效。"],
  ["keyboard-map", "配置客制化机械键盘 QMK 分层快捷键方案", "将方向键与括号映射至主键区减少手腕移动。"],
  ["air-filter", "对比三款客厅空气净化器滤网年化耗材成本", "测算 CADR 值、夜间噪音与第三方滤芯兼容性。"],
  ["video-clip", "用 ffmpeg 批量无损裁剪录屏开头结尾空白片段", "使用 stream copy 保持原画质，30 秒处理完 12 个视频。"],
  ["calendar-ics", "合并多个项目排期表生成统一 ICS 订阅日历", "过滤已取消会议并统一转为东八区时间戳。"],
  ["tea-guide", "整理乌龙茶与白茶冷泡比例及冷藏时长指南", "按 1:100 茶水比记录 6 小时与 12 小时口感差异。"],
  ["usb-hub", "排查雷电扩展坞外接双 4K 显示器间歇黑屏问题", "更换认证 40Gbps 线材并关闭节能休眠恢复稳定。"],
  ["test-data", "生成脱敏中文姓名与手机号的本地压测数据工厂", "保证可复现随机种子且绝不触碰真实用户数据。"],
  ["gpu-fan", "调整工作站显卡待机风扇曲线降低书房底噪", "50 度以下维持 30% 低速静音，满载 78 度平稳控温。"],
  ["rss-digest", "每日自动汇总 HackerNews 与技术博客 Top10 摘要", "去重已读条目并于早 8 点生成简洁阅读清单。"],
];

function buildDeepHistorySpecs(): SeedTicketSpec[] {
  const specs: SeedTicketSpec[] = [
    // Recent tickets (ranks 1..12 inline on candidate card)
    {
      id: "t_dashboard_dark",
      title: "仪表盘暗黑模式配色与图表适配",
      asked: "帮我给 Web 仪表盘做暗黑模式配色和折线图深色主题适配。",
      digest: "已完成仪表盘暗黑模式配色变量与主要图表主题切换，等待微调坐标轴灰阶。",
      summary: "已完成仪表盘暗黑模式 CSS 变量与 ECharts 深色主题配置。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 240,
      updatedHoursAgo: 2, // Old createdAt (10d ago) but updated 2h ago!
      status: "open_idle",
      artifacts: ["dark_theme_tokens.css"],
      worktreeName: "dashboard-dark-mode",
    },
    {
      id: "t_weekly_okr",
      title: "Q4研发团队OKR季度复盘PPT大纲",
      asked: "帮我整理一份 Q4 研发团队 OKR 季度复盘 PPT 大纲。",
      digest: "已完成 Q4 研发团队 OKR 复盘 12 页 PPT 结构与关键指标汇总。",
      summary: "已输出 Q4_OKR_复盘.pptx 大纲，涵盖交付节奏、稳定性与下季目标。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 26,
      updatedHoursAgo: 24,
      status: "completed",
      artifacts: ["Q4_OKR_复盘.pptx", "okr_outline.md"],
      worktreeName: "q4-okr-deck",
    },
  ];

  // Fill ranks 3..13 (11 recent filler tickets so CHAT_RELATED=12 is saturated)
  for (let i = 0; i < 11; i++) {
    const [slug, title, digest] = FILLER_TOPICS[i]!;
    const hours = 4 + i * 6;
    specs.push({
      id: `t_filler_${String(i + 1).padStart(2, "0")}`,
      title,
      asked: `请帮我处理：${title}`,
      digest,
      summary: `已完成：${digest}`,
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: hours + 2,
      updatedHoursAgo: hours,
      status: "completed",
      worktreeName: slug,
    });
  }

  // Deep history targets (well outside CHAT_RELATED = 12!)
  const deepTargets: SeedTicketSpec[] = [
    {
      id: "t_k8s_oom",
      title: "排查推理网关容器OOM内存泄漏问题",
      asked: "线上推理网关容器每隔 6 小时 OOM 重启一次，帮忙排查内存泄漏根因并给修复方案。",
      digest: "定位到流式响应解码器的字节缓冲池未在断连时释放，已补丁修复并设 85% 告警。",
      summary: "根因为流式 SSE 断连路径未回收 byteBufferPool，修复后 RSS 稳定在 420MB。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 98,
      updatedHoursAgo: 96,
      status: "completed",
      artifacts: ["oom_heap_profile.md", "gateway_fix.patch"],
      worktreeName: "gateway-oom-fix",
    },
    {
      id: "t_podcast_notes",
      title: "播客《硅谷AI基础设施》双语文字稿与纪要",
      asked: "帮我把这期《硅谷AI基础设施》播客整理成双语文字稿和核心观点纪要。",
      digest: "已生成 1.2 万字双语文字稿与纪要，提炼推理成本下降、KV Cache 复用与端侧量化三大趋势。",
      summary: "已交付 podcast_ai_infra_notes.md，包含完整双语整理与嘉宾三大推理成本观点。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 122,
      updatedHoursAgo: 120,
      status: "completed",
      artifacts: ["podcast_ai_infra_notes.md"],
      worktreeName: "podcast-ai-notes",
    },
    {
      id: "t_quant_grid",
      title: "网格交易策略回测与手续费滑点分析",
      asked: "写一个网格交易策略回测脚本，分析不同手续费和滑点下的年化收益并出 PDF 报告。",
      digest: "已完成等比/等差网格 5 年回测，万三手续费下年化收益从 14.2% 降至 11.4%（下降 2.8 个百分点）。",
      summary: "已输出 grid_strategy_report.pdf 与 backtest_summary.md，含费率敏感性矩阵。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 146,
      updatedHoursAgo: 144,
      status: "completed",
      artifacts: ["grid_strategy_report.pdf", "backtest_summary.md"],
      worktreeName: "grid-strategy-backtest",
    },
    {
      id: "t_etf_report",
      title: "A股宽基ETF定投回测可视化报告",
      asked: "帮我做一份 A股宽基ETF定投回测可视化报告，对比沪深300、中证500、创业板ETF 十年收益与回撤。",
      digest: "已生成交互式 HTML 可视化报告，中证500定投最大回撤 34.6%，夏普比率 0.72。",
      summary: "已交付 a_share_etf_backtest_2026.html 与 etf_metrics.csv，含十年净值与回撤曲线。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 170,
      updatedHoursAgo: 168,
      status: "completed",
      artifacts: ["a_share_etf_backtest_2026.html", "etf_metrics.csv"],
      worktreeName: "ashare-etf-report",
    },
    {
      id: "t_travel_20w",
      title: "二十万人民币一年游历五大洲旅居漫游计划",
      asked: "帮我规划一份二十万人民币一年游历五大洲的旅居漫游计划，列出国家路线、欧洲段预算并导出 PDF。",
      digest: "覆盖亚欧美非大洋洲 18 个国家的 20 万元一年慢游总方案，欧洲段预算 5.8 万元，已导出 PDF。",
      summary: "已生成 二十万人民币一年游历五大洲旅居漫游计划.pdf 及 reports/国家路线明细.md（含18国清单与分洲预算）。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 194,
      updatedHoursAgo: 192,
      status: "completed",
      artifacts: ["二十万人民币一年游历五大洲旅居漫游计划.pdf", "reports/国家路线明细.md"],
      worktreeName: "world-travel-200k",
    },
    {
      id: "t_travel_20w_visa",
      title: "五大洲漫游签证与保险攻略",
      asked: "把二十万五大洲漫游计划的各国签证办理周期、申根材料与旅居保险单独整理一份攻略。",
      digest: "汇总 18 国签证办理周期（申根/美签建议提前 2-3 个月）与长途医疗险方案。",
      summary: "已交付 五大洲签证攻略.md，包含各国领馆周期、电子签条件与保险对比。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 196,
      updatedHoursAgo: 193,
      status: "completed",
      artifacts: ["五大洲签证攻略.md"],
      worktreeName: "world-travel-visa",
    },
    {
      id: "t_travel_20w_budget",
      title: "二十万环球机票与住宿预算拆解",
      asked: "把二十万五大洲计划里的跨洲机票、月租民宿和餐饮预算做成明细表。",
      digest: "拆解 20 万元全年预算：机票 4.2 万、住宿 8.6 万、餐饮交通 5.4 万、应急 1.8 万。",
      summary: "已交付 预算明细表.csv，覆盖五大洲 18 国月度现金流与淡旺季机票策略。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 197,
      updatedHoursAgo: 194,
      status: "completed",
      artifacts: ["预算明细表.csv"],
      worktreeName: "world-travel-budget",
    },
    {
      id: "t_auth_login",
      title: "修复登录页密码校验与锁定策略",
      asked: "修复登录页密码强度校验 bug，并加上连续 5 次输错密码锁定 15 分钟的策略。",
      digest: "已修复登录表单密码正则校验、5 次失败锁定 15 分钟逻辑并补齐单测。",
      summary: "已完成登录密码校验与锁定策略改动（login_auth_fix.patch、tests/login.test.ts）。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 266,
      updatedHoursAgo: 264,
      status: "completed",
      artifacts: ["login_auth_fix.patch", "tests/login.test.ts"],
      worktreeName: "login-password-fix",
    },
    {
      id: "t_web_travel_gear",
      title: "五大洲长途旅居轻量化行李装备清单",
      asked: "整理一份适合一年五大洲长途旅居的轻量化行李装备清单并导出 PDF。",
      digest: "推荐 40L 登机主力背包 + 轻量化三层穿衣系统，冬季羽绒服克重预算 450g。",
      summary: "已导出 五大洲行李装备清单.pdf，总重控制在 9.5kg 内可全程随身登机。",
      threadKey: "chat:web:local",
      surface: "web",
      createdHoursAgo: 290,
      updatedHoursAgo: 288,
      status: "completed",
      artifacts: ["五大洲行李装备清单.pdf"],
      worktreeName: "travel-gear-list",
    },
    {
      id: "t_web_tax_guide",
      title: "跨境自由职业者税务合规与报税流程笔记",
      asked: "帮我在网页端整理一份跨境自由职业者个人所得税合规与年度汇算清缴流程笔记。",
      digest: "梳理境外劳务收入申报材料、税收抵免与每年 3 月 1 日至 6 月 30 日年度汇算截止期。",
      summary: "已生成 cross_border_tax_guide.pdf，标注关键申报截止日为次年 6 月 30 日。",
      threadKey: "chat:web:local",
      surface: "web",
      createdHoursAgo: 314,
      updatedHoursAgo: 312,
      status: "completed",
      artifacts: ["cross_border_tax_guide.pdf"],
      worktreeName: "cross-border-tax",
    },
  ];
  specs.push(...deepTargets);

  // Fill remaining historical fillers (ranks 14..60+) interleaved around deep targets
  for (let i = 11; i < FILLER_TOPICS.length; i++) {
    const [slug, title, digest] = FILLER_TOPICS[i]!;
    const hours = 80 + (i - 10) * 7;
    specs.push({
      id: `t_filler_${String(i + 1).padStart(2, "0")}`,
      title,
      asked: `帮我完成这项任务：${title}`,
      digest,
      summary: `已完成：${digest}`,
      threadKey: i % 9 === 0 ? "chat:web:local" : "chat:wechat:user-primary",
      surface: i % 9 === 0 ? "web" : "wechat",
      createdHoursAgo: hours + 3,
      updatedHoursAgo: hours,
      status: "completed",
      worktreeName: slug,
    });
  }

  return specs;
}

function buildTwinHardNegativeSpecs(): SeedTicketSpec[] {
  const base = buildDeepHistorySpecs();
  base.push(
    {
      id: "t_invoice_ocr",
      title: "差旅报销发票PDF批量OCR汇总脚本",
      asked: "写一个把差旅报销 PDF 电子发票批量 OCR 识别金额并汇总的脚本。",
      digest: "已完成 PDF 电子发票解析与税号/金额自动汇总脚本。",
      summary: "已交付 invoice_ocr_summary.py，支持增值税电子普票批量汇总。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 110,
      updatedHoursAgo: 108,
      status: "completed",
      artifacts: ["invoice_ocr_summary.py"],
      worktreeName: "invoice-ocr-batch",
    },
    {
      id: "t_crm_export",
      title: "客户管理后台订单导出CSV功能",
      asked: "给客户管理后台订单列表页加上一键导出 CSV 功能。",
      digest: "已实现客户后台按筛选条件流式导出 UTF-8 BOM CSV 功能。",
      summary: "已完成订单 CSV 导出接口与前端下载按钮。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 132,
      updatedHoursAgo: 130,
      status: "completed",
      artifacts: ["crm_csv_export.patch"],
      worktreeName: "crm-csv-export",
    },
  );
  return base;
}

function buildAmbiguousPairSpecs(): SeedTicketSpec[] {
  const specs: SeedTicketSpec[] = [
    // Pair A: strategy reports
    {
      id: "t_strat_v1",
      title: "美股动量轮动策略回测报告",
      asked: "生成一份美股纳指与标普行业动量轮动策略回测报告 PDF。",
      digest: "美股动量轮动策略 10 年回测年化 16.8%，最大回撤 19.4%。",
      summary: "已输出 us_momentum_strategy_report.pdf，含美股轮动策略核心结论。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 96,
      updatedHoursAgo: 95,
      status: "completed",
      artifacts: ["us_momentum_strategy_report.pdf"],
      worktreeName: "us-momentum-report",
    },
    {
      id: "t_strat_v2",
      title: "A股行业轮动策略回测报告",
      asked: "生成一份 A股申万一级行业轮动策略回测报告 PDF。",
      digest: "A股行业轮动策略 10 年回测年化 12.1%，最大回撤 24.8%。",
      summary: "已输出 cn_sector_strategy_report.pdf，含 A股行业轮动策略核心结论。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 72,
      updatedHoursAgo: 71,
      status: "completed",
      artifacts: ["cn_sector_strategy_report.pdf"],
      worktreeName: "cn-sector-report",
    },
    // Pair B: continent plans
    {
      id: "t_plan_20w",
      title: "二十万五大洲一年旅居慢游计划",
      asked: "做一份二十万五大洲一年旅居慢游计划路线与预算 PDF。",
      digest: "20 万元一年覆盖五大洲 18 国慢游路线与住宿方案。",
      summary: "已输出 二十万五大洲旅居计划.pdf。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 80,
      updatedHoursAgo: 79,
      status: "completed",
      artifacts: ["二十万五大洲旅居计划.pdf"],
      worktreeName: "plan-200k-5cont",
    },
    {
      id: "t_plan_10w",
      title: "十万四大洲半年穷游计划",
      asked: "做一份十万四大洲半年穷游计划路线与预算 PDF。",
      digest: "10 万元半年覆盖四大洲 11 国高性价比背包穷游路线。",
      summary: "已输出 十万四大洲穷游计划.pdf。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 104,
      updatedHoursAgo: 103,
      status: "completed",
      artifacts: ["十万四大洲穷游计划.pdf"],
      worktreeName: "plan-100k-4cont",
    },
    // Pair C: two actively running open tickets
    {
      id: "t_active_crawler",
      title: "抓取竞品定价页面数据脚本",
      asked: "运行脚本持续抓取 15 家竞品官网的季度定价页面变动。",
      digest: "正在后台抓取竞品定价页面数据，已完成 6/15 站点。",
      summary: "后台抓取任务运行中，当前进度 6/15。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 3,
      updatedHoursAgo: 1,
      status: "open_working",
      worktreeName: "pricing-crawler",
    },
    {
      id: "t_active_benchmark",
      title: "推理引擎并发吞吐压测任务",
      asked: "在测试机跑一轮 64 并发推理引擎吞吐与 P99 延迟压测。",
      digest: "正在执行 64 并发吞吐压测，已完成 40% 请求样本。",
      summary: "压测脚本后台运行中，预计还需 8 分钟。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 2,
      updatedHoursAgo: 1,
      status: "open_working",
      worktreeName: "engine-load-bench",
    },
    // Pair D: quarterly finance PDFs
    {
      id: "t_q3_finance",
      title: "Q3季度经营财务分析报告",
      asked: "整理 Q3 季度经营财务分析报告并导出 PDF。",
      digest: "Q3 营收同比增速 18.4%，毛利率 62.1%。",
      summary: "已输出 Q3财务分析报告.pdf。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 240,
      updatedHoursAgo: 238,
      status: "completed",
      artifacts: ["Q3财务分析报告.pdf"],
      worktreeName: "q3-finance-pdf",
    },
    {
      id: "t_q4_finance",
      title: "Q4季度经营预算预测报告",
      asked: "整理 Q4 季度经营预算与同比增速预测报告并导出 PDF。",
      digest: "Q4 预计营收同比增速 22.0%，经营现金流转正。",
      summary: "已输出 Q4预算预测报告.pdf。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 48,
      updatedHoursAgo: 47,
      status: "completed",
      artifacts: ["Q4预算预测报告.pdf"],
      worktreeName: "q4-finance-pdf",
    },
    // Pair E: two UI form layout redesign tickets
    {
      id: "t_ui_settings",
      title: "设置页表单布局与交互改版",
      asked: "把设置页的表单布局重做为双栏分组并优化底部保存交互。",
      digest: "已完成设置页表单布局改版与校验提示统一。",
      summary: "已交付设置页双栏表单改版。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 60,
      updatedHoursAgo: 59,
      status: "completed",
      worktreeName: "settings-form-ui",
    },
    {
      id: "t_ui_profile",
      title: "个人资料页表单布局与交互改版",
      asked: "把个人资料页的头像和表单字段布局改版并统一交互。",
      digest: "已完成个人资料页表单布局改版与实时校验。",
      summary: "已交付个人资料页表单布局改版。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 54,
      updatedHoursAgo: 53,
      status: "completed",
      worktreeName: "profile-form-ui",
    },
  ];
  return specs;
}

function buildGuardrailSpecs(): SeedTicketSpec[] {
  return [
    {
      id: "t_stopped_scraper",
      title: "定时监控机票降价爬虫脚本",
      asked: "写一个每 30 分钟监控国际特价机票降价并微信推送提醒的爬虫脚本。",
      digest: "机票降价监控爬虫脚本（已被用户手动停止）。",
      summary: "用户已手动要求停止该监控爬虫工单。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 40,
      updatedHoursAgo: 38,
      status: "stopped",
      endedReason: "用户手动停止",
      artifacts: ["flight_watcher.py"],
      worktreeName: "flight-price-watcher",
    },
    {
      id: "t_handed_back_ui",
      title: "首页导航栏样式调整",
      asked: "调整首页顶部导航栏间距和悬停高亮样式。",
      digest: "专注首页顶部导航栏 CSS 间距与高亮态样式微调，不含任何后端计费逻辑。",
      summary: "已完成导航栏间距调整，等待视觉验收。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 6,
      updatedHoursAgo: 4,
      status: "open_idle",
      worktreeName: "navbar-style-tweak",
    },
    {
      id: "t_guardrail_bg",
      title: "本周数据库备份校验巡检",
      asked: "检查本周 PostgreSQL 自动快照恢复测试状态。",
      digest: "已完成本周数据库快照恢复演练，RTO 4 分钟。",
      summary: "备份校验通过。",
      threadKey: "chat:wechat:user-primary",
      surface: "wechat",
      createdHoursAgo: 30,
      updatedHoursAgo: 29,
      status: "completed",
      worktreeName: "db-backup-check",
    },
  ];
}

export function seedProfileCatalog(profile: SeedProfileName): SeedTicketSpec[] {
  switch (profile) {
    case "deep_history_60":
      return buildDeepHistorySpecs();
    case "twin_hard_negatives":
      return buildTwinHardNegativeSpecs();
    case "ambiguous_pairs":
      return buildAmbiguousPairSpecs();
    case "guardrails_stopped_handed_back":
      return buildGuardrailSpecs();
  }
}

// ---------------------------------------------------------------------------
// Dataset Loading & Strict Schema Validation
// ---------------------------------------------------------------------------

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

export function loadAndValidateDataset(
  datasetPath: string = DEFAULT_DATASET_PATH,
  strictFullStratification: boolean = true,
): { cases: GoldCase[]; errors: string[] } {
  const errors: string[] = [];
  if (!fs.existsSync(datasetPath)) {
    return { cases: [], errors: [`Dataset file not found: ${datasetPath}`] };
  }

  const raw = fs.readFileSync(datasetPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const cases: GoldCase[] = [];
  const seenIds = new Set<string>();
  const profileTicketSets = new Map<SeedProfileName, Set<string>>();

  for (const profile of VALID_PROFILES as ReadonlySet<SeedProfileName>) {
    profileTicketSets.set(
      profile,
      new Set(seedProfileCatalog(profile).map((spec) => spec.id)),
    );
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch (err) {
      errors.push(`Line ${lineNo}: invalid JSON (${errorMessage(err)})`);
      continue;
    }
    if (!isRecord(parsed)) {
      errors.push(`Line ${lineNo}: expected JSON object`);
      continue;
    }

    const id = parsed.id;
    const group = parsed.group;
    const surface = parsed.surface;
    const threadKey = parsed.thread_key;
    const seedProfile = parsed.seed_profile;
    const userMessage = parsed.user_message;
    const expectedRetrieval = parsed.expected_retrieval;
    const goldRoute = parsed.gold_route;
    const fpSeverity = parsed.fp_severity;

    if (typeof id !== "string" || id.trim().length === 0) {
      errors.push(`Line ${lineNo}: missing non-empty string 'id'`);
      continue;
    }
    if (seenIds.has(id)) {
      errors.push(`Line ${lineNo} (${id}): duplicate id`);
    }
    seenIds.add(id);

    if (typeof group !== "string" || !VALID_GROUPS.has(group)) {
      errors.push(`Line ${lineNo} (${id}): invalid 'group'=${String(group)}`);
      continue;
    }
    if (typeof surface !== "string" || !VALID_SURFACES.has(surface)) {
      errors.push(`Line ${lineNo} (${id}): invalid 'surface'=${String(surface)}`);
      continue;
    }
    if (typeof threadKey !== "string" || !threadKey.startsWith("chat:")) {
      errors.push(`Line ${lineNo} (${id}): 'thread_key' must start with 'chat:'`);
      continue;
    }
    if (typeof seedProfile !== "string" || !VALID_PROFILES.has(seedProfile)) {
      errors.push(`Line ${lineNo} (${id}): invalid 'seed_profile'=${String(seedProfile)}`);
      continue;
    }
    if (typeof userMessage !== "string" || userMessage.trim().length === 0) {
      errors.push(`Line ${lineNo} (${id}): missing non-empty 'user_message'`);
      continue;
    }
    if (typeof fpSeverity !== "string" || !VALID_SEVERITIES.has(fpSeverity)) {
      errors.push(`Line ${lineNo} (${id}): invalid 'fp_severity'=${String(fpSeverity)}`);
      continue;
    }
    if (!isRecord(expectedRetrieval)) {
      errors.push(`Line ${lineNo} (${id}): missing object 'expected_retrieval'`);
      continue;
    }
    if (
      !isStringArray(expectedRetrieval.target_ticket_ids) ||
      typeof expectedRetrieval.expect_in_card !== "boolean" ||
      typeof expectedRetrieval.requires_search !== "boolean" ||
      !isStringArray(expectedRetrieval.forbidden_card_ticket_ids)
    ) {
      errors.push(`Line ${lineNo} (${id}): invalid 'expected_retrieval' schema`);
      continue;
    }
    if (!isRecord(goldRoute)) {
      errors.push(`Line ${lineNo} (${id}): missing object 'gold_route'`);
      continue;
    }
    if (
      typeof goldRoute.kind !== "string" ||
      !VALID_KINDS.has(goldRoute.kind) ||
      !(goldRoute.ticket_id === null || typeof goldRoute.ticket_id === "string") ||
      !isStringArray(goldRoute.acceptable_ticket_ids) ||
      !isStringArray(goldRoute.forbidden_kinds) ||
      !isStringArray(goldRoute.forbidden_ticket_ids)
    ) {
      errors.push(`Line ${lineNo} (${id}): invalid 'gold_route' schema`);
      continue;
    }

    // Verify every referenced ticket_id exists in the named seed_profile catalog!
    const validIds = profileTicketSets.get(seedProfile as SeedProfileName)!;
    const refsToCheck: string[] = [
      ...expectedRetrieval.target_ticket_ids,
      ...expectedRetrieval.forbidden_card_ticket_ids,
      ...(goldRoute.ticket_id !== null ? [goldRoute.ticket_id] : []),
      ...goldRoute.acceptable_ticket_ids,
      ...goldRoute.forbidden_ticket_ids,
      ...(Array.isArray(goldRoute.expected_related_ticket_ids)
        ? (goldRoute.expected_related_ticket_ids as string[])
        : []),
      ...(Array.isArray(goldRoute.clarify_candidate_ids)
        ? (goldRoute.clarify_candidate_ids as string[])
        : []),
    ];
    for (const refId of refsToCheck) {
      if (!validIds.has(refId)) {
        errors.push(`Line ${lineNo} (${id}): ticket '${refId}' not found in seed_profile '${seedProfile}'`);
      }
    }

    // Group-specific invariants
    if ((group === "G1_sidecar_hit" || group === "G2_attach_hit") && goldRoute.ticket_id === null) {
      errors.push(`Line ${lineNo} (${id}): positive group ${group} must specify gold_route.ticket_id`);
    }
    if (group === "G5_ambiguous_clarify" && goldRoute.kind !== "clarify") {
      errors.push(`Line ${lineNo} (${id}): G5_ambiguous_clarify must have gold_route.kind === "clarify"`);
    }
    if (group === "G6_guardrails" && goldRoute.forbidden_ticket_ids.length === 0) {
      errors.push(`Line ${lineNo} (${id}): G6_guardrails must specify forbidden_ticket_ids`);
    }

    cases.push({
      id,
      group: group as GoldGroup,
      surface: surface as Surface,
      thread_key: threadKey,
      seed_profile: seedProfile as SeedProfileName,
      user_message: userMessage,
      expected_retrieval: {
        target_ticket_ids: expectedRetrieval.target_ticket_ids,
        expect_in_card: expectedRetrieval.expect_in_card,
        requires_search: expectedRetrieval.requires_search,
        forbidden_card_ticket_ids: expectedRetrieval.forbidden_card_ticket_ids,
        ...(typeof expectedRetrieval.expect_ambiguous === "boolean"
          ? { expect_ambiguous: expectedRetrieval.expect_ambiguous }
          : {}),
      },
      gold_route: {
        kind: goldRoute.kind as RouteKind,
        ticket_id: goldRoute.ticket_id,
        acceptable_ticket_ids: goldRoute.acceptable_ticket_ids,
        ...(Array.isArray(goldRoute.expected_related_ticket_ids)
          ? { expected_related_ticket_ids: goldRoute.expected_related_ticket_ids as string[] }
          : {}),
        ...(Array.isArray(goldRoute.clarify_candidate_ids)
          ? { clarify_candidate_ids: goldRoute.clarify_candidate_ids as string[] }
          : {}),
        forbidden_kinds: goldRoute.forbidden_kinds as RouteKind[],
        forbidden_ticket_ids: goldRoute.forbidden_ticket_ids,
      },
      fp_severity: fpSeverity as FpSeverity,
      ...(typeof parsed.notes === "string" ? { notes: parsed.notes } : {}),
    });
  }

  if (strictFullStratification) {
    if (cases.length !== TOTAL_GOLD_CASES) {
      errors.push(`Expected ${TOTAL_GOLD_CASES} total cases, found ${cases.length}`);
    }
    const counts: Record<GoldGroup, number> = {
      G1_sidecar_hit: 0,
      G2_attach_hit: 0,
      G3_hard_negative: 0,
      G4_clean_negative: 0,
      G5_ambiguous_clarify: 0,
      G6_guardrails: 0,
    };
    for (const c of cases) {
      counts[c.group] += 1;
    }
    for (const [grp, expected] of Object.entries(EXPECTED_GROUP_COUNTS) as Array<[GoldGroup, number]>) {
      if (counts[grp] !== expected) {
        errors.push(`Group ${grp}: expected ${expected} cases, found ${counts[grp]}`);
      }
    }
  }

  return { cases, errors };
}

// ---------------------------------------------------------------------------
// Sandbox Store Seeding & Candidate Card Construction
// ---------------------------------------------------------------------------

class NullKernels extends BaseKernels {
  open(_kernel: Kernel, _spec: SessionSpec, _host: ToolHost, _events: UnboundedChannel<DriverEvent>): Driver {
    throw new Error("NullKernels does not launch runtime processes directly");
  }
  async models(_kernel: Kernel): Promise<ModelOption[]> {
    return [];
  }
  unavailable(_kernel: Kernel): string | undefined {
    return "sandbox-null-kernel";
  }
}

function parseThreadParts(threadKey: string): { source: string; id: string; actorId: string; surface: Surface } {
  const colon = threadKey.indexOf(":");
  const source = colon > 0 ? threadKey.slice(0, colon) : "chat";
  const id = colon > 0 ? threadKey.slice(colon + 1) : threadKey;
  if (id.startsWith("wechat:")) {
    return { source, id, actorId: id.slice("wechat:".length), surface: "wechat" };
  }
  return { source, id, actorId: "web-local", surface: "web" };
}

function channelForThread(threadKey: string): ChannelRef {
  const { source, id, actorId, surface } = parseThreadParts(threadKey);
  return {
    source,
    thread: threadKey,
    address: surface === "wechat" ? { surface: "wechat", userId: actorId } : { surface: "web", thread: id },
  };
}

export interface SeededSandbox {
  app: App;
  trigger: Trigger;
  candidate: Candidate;
  card: Record<string, unknown>;
}

/**
 * Seeds a real SQLite `Store` inside an isolated `App` with the case's `seed_profile` historical tickets,
 * receives the case's `user_message` trigger, builds the exact `Candidate` + `app.candidateCard(candidate)`.
 */
export function seedSandboxApp(testCase: GoldCase, tempRoot: string): SeededSandbox {
  const stateDir = path.join(tempRoot, "state");
  const ticketsDir = path.join(tempRoot, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });

  const app = App.open(
    { stateDir, wechat: new Protocol() },
    new NullKernels(),
    defaultTimings(),
  );

  // Bind primary WeChat account in store kv when seeding so cross-surface allowlists recognize user-primary.
  app.store.set("wechat-account", {
    userId: "user-primary",
    botId: "eval-bot",
    token: "eval-token",
    baseUrl: "http://127.0.0.1:0",
  });

  const specs = seedProfileCatalog(testCase.seed_profile);
  const policyVer = "eval-policy-v1";
  const threadSubscriptions = new Map<string, string[]>();
  const threadLastAt = new Map<string, string>();
  const seededTicketsByThread = new Map<string, Ticket[]>();

  app.store.atomic(() => {
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const createdAt = formatIso(BASE_ANCHOR_MS - spec.createdHoursAgo * 3_600_000);
      const updatedAt = formatIso(BASE_ANCHOR_MS - spec.updatedHoursAgo * 3_600_000);
      const originTriggerId = `trig_origin_${spec.id}`;
      const { source, id: threadId, actorId, surface } = parseThreadParts(spec.threadKey);
      const channel = channelForThread(spec.threadKey);

      const originTrigger: Trigger = {
        id: originTriggerId,
        source,
        threads: [{ source, id: threadId }],
        actor: { source, id: actorId },
        human: true,
        addressed: "direct",
        at: createdAt,
        text: spec.asked,
        channel,
        meta: { surface },
      };
      app.store.saveTrigger(originTrigger);

      const workDir = path.join(ticketsDir, spec.worktreeName);
      fs.mkdirSync(workDir, { recursive: true });
      if (spec.artifacts && spec.artifacts.length > 0) {
        for (const relArtifact of spec.artifacts) {
          const fullPath = path.join(workDir, relArtifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, `# Stub deliverable for ${spec.title}\n`, "utf8");
        }
      }

      const endedOutcome: TicketOutcome | undefined =
        spec.status === "completed" || spec.status === "dropped" || spec.status === "stopped"
          ? spec.status
          : undefined;
      const isEnded = endedOutcome !== undefined;
      const assignmentState =
        spec.status === "open_working" ? "running" : isEnded ? "ended" : "running";
      const reportState =
        spec.status === "completed"
          ? "ready"
          : spec.status === "dropped"
            ? "dropped"
            : spec.status === "open_working"
              ? "progress"
              : "waiting";

      const ticket: Ticket & { artifacts?: string[] } = {
        id: spec.id,
        title: spec.title,
        decisionId: `dec_${spec.id}`,
        mandate: {
          strength: "explicit",
          policyVersion: policyVer,
          basis: mandateBasisVia({ via: "addressed", addressed: "direct" }, { source, sender: actorId }),
          actor: { source, id: actorId },
          scope: spec.title,
        },
        channels: [channel],
        ...(endedOutcome !== undefined
          ? {
              ended: {
                at: updatedAt,
                by: endedOutcome === "stopped" ? "human" : "executor",
                outcome: endedOutcome,
                ...(spec.endedReason !== undefined ? { reason: spec.endedReason } : {}),
              },
            }
          : {}),
        assignments: [
          {
            id: `asg_${spec.id}_1`,
            state: assignmentState,
            createdAt,
            startedAt: createdAt,
            ...(isEnded ? { endedAt: updatedAt } : {}),
            ...(spec.status === "open_idle" ? { idleAt: updatedAt } : {}),
            report: {
              state: reportState,
              summary: spec.summary,
              at: updatedAt,
            },
          },
        ],
        inputs: [],
        undelivered: [],
        digest: spec.digest,
        createdAt,
        updatedAt,
        origin: {
          triggerId: originTriggerId,
          triggerIds: [originTriggerId],
        },
        execution: {
          name: spec.worktreeName,
          directory: workDir,
          assignment: spec.asked,
        },
      };

      if (spec.artifacts && spec.artifacts.length > 0) {
        ticket.artifacts = [...spec.artifacts];
      }

      app.store.saveTicket(ticket);

      const subList = threadSubscriptions.get(spec.threadKey) ?? [];
      subList.push(spec.id);
      threadSubscriptions.set(spec.threadKey, subList);

      const ticketList = seededTicketsByThread.get(spec.threadKey) ?? [];
      ticketList.push(ticket);
      seededTicketsByThread.set(spec.threadKey, ticketList);

      const prevLast = threadLastAt.get(spec.threadKey);
      if (prevLast === undefined || updatedAt > prevLast) {
        threadLastAt.set(spec.threadKey, updatedAt);
      }
    }

    // Ensure every referenced thread exists with subscriptions
    const allThreadKeys = new Set<string>([...threadSubscriptions.keys(), testCase.thread_key]);
    for (const tk of allThreadKeys) {
      const { source, id: threadId, surface } = parseThreadParts(tk);
      const thread: Thread = {
        key: tk,
        ref: { source, id: threadId },
        createdAt: formatIso(BASE_ANCHOR_MS - 360 * 3_600_000),
        lastAt: threadLastAt.get(tk) ?? formatIso(BASE_ANCHOR_MS - 60_000),
        subscriptions: threadSubscriptions.get(tk) ?? [],
        correlated: [],
        pending: [],
        meta: { surface },
      };
      app.store.saveThread(thread);
    }

    // Insert the candidate trigger being evaluated
    const nowAt = formatIso(BASE_ANCHOR_MS);
    const { source, id: threadId, actorId, surface } = parseThreadParts(testCase.thread_key);
    const evalTriggerId = `trig_eval_${testCase.id}`;
    const evalTrigger: Trigger = {
      id: evalTriggerId,
      source,
      threads: [{ source, id: threadId }],
      actor: { source, id: actorId },
      human: true,
      addressed: "direct",
      at: nowAt,
      text: testCase.user_message,
      channel: channelForThread(testCase.thread_key),
      meta: { surface },
    };
    app.store.saveTrigger(evalTrigger);

    // G6-02 specifically seeds a prior handback disposition from `t_handed_back_ui`
    const disp: TriggerDisposition = dispositionAt(nowAt);
    if (testCase.id === "G6-02") {
      disp.handbacks = [
        {
          ticketId: "t_handed_back_ui",
          reason: "该请求涉及后端计费接口，不属于首页导航栏样式范围",
          at: formatIso(BASE_ANCHOR_MS - 30_000),
        },
      ];
    }
    app.store.saveDisposition(evalTriggerId, disp);
  });

  const trigger = app.store.trigger(`trig_eval_${testCase.id}`)!;
  const thread = app.store.thread(testCase.thread_key)!;
  const sameThreadTickets = seededTicketsByThread.get(testCase.thread_key) ?? [];
  const candidate: Candidate = {
    evalId: `eval_${testCase.id}`,
    thread,
    strength: "explicit",
    policyVersion: policyVer,
    triggers: [trigger],
    tickets: sameThreadTickets,
  };

  const card = app.candidateCard(candidate) as Record<string, unknown>;
  return { app, trigger, candidate, card };
}

// ---------------------------------------------------------------------------
// Candidate Card Retrieval Introspection
// ---------------------------------------------------------------------------

function extractTicketIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const item of list) {
    if (isRecord(item) && typeof item.ticket_id === "string") {
      ids.push(item.ticket_id);
    }
  }
  return ids;
}

export function inspectCardRetrieval(card: Record<string, unknown>): RetrievalTrace {
  const cardRelatedIds = extractTicketIds(card.related_tickets);
  const cardRecalledIds = extractTicketIds(card.recalled_tickets);
  const cardOtherThreadIds = extractTicketIds(card.other_thread_tickets);
  const cardRecalledConfidences: Record<string, string> = {};

  if (Array.isArray(card.recalled_tickets)) {
    for (const item of card.recalled_tickets) {
      if (isRecord(item) && typeof item.ticket_id === "string" && typeof item.confidence === "string") {
        cardRecalledConfidences[item.ticket_id] = item.confidence;
      }
    }
  }

  const allSet = new Set<string>([...cardRelatedIds, ...cardRecalledIds, ...cardOtherThreadIds]);
  return {
    cardRelatedIds,
    cardRecalledIds,
    cardOtherThreadIds,
    cardAllTicketIds: [...allSet],
    cardRecalledConfidences,
    cardTicketsTotal: typeof card.tickets_total === "number" ? card.tickets_total : cardRelatedIds.length,
    searchCalls: [],
    readCalls: [],
    policyViolations: [],
  };
}

// ---------------------------------------------------------------------------
// Route-Only Intercepting ToolHost (Passes Through Search/Read, Intercepts Route)
// ---------------------------------------------------------------------------

function fallbackTicketSearch(app: App, query: string, limit: number): Record<string, unknown> {
  const q = query.trim().toLowerCase();
  const tokens = q.split(/[\s,，。？！?!、/\\:：;；()（）《》【】\[\]"'“”]+/).filter((t) => t.length > 0);
  // Also extract 2-char CJK chunks for Chinese substring recall fallback when v2 store search isn't wired yet
  const cjkBigrams: string[] = [];
  for (const tok of tokens) {
    if (/[\u4e00-\u9fff]/.test(tok) && tok.length >= 2) {
      for (let i = 0; i < tok.length - 1; i++) {
        cjkBigrams.push(tok.slice(i, i + 2));
      }
    }
  }
  const scored: Array<{ ticket: Ticket & { artifacts?: string[] }; score: number }> = [];
  for (const rawTicket of app.store.tickets()) {
    const ticket = rawTicket as Ticket & { artifacts?: string[] };
    const asked = app.store.trigger(ticket.origin.triggerId)?.text ?? "";
    const hay = [
      ticket.title,
      asked,
      ticket.digest ?? "",
      ...(ticket.artifacts ?? []),
    ]
      .join(" ")
      .toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (hay.includes(tok)) score += 3;
    }
    for (const bg of cjkBigrams) {
      if (hay.includes(bg)) score += 1;
    }
    if (score > 0) {
      scored.push({ ticket, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, Math.min(20, Math.max(1, limit)));
  return {
    query,
    total: scored.length,
    items: top.map(({ ticket, score }) => ({
      ticket_id: ticket.id,
      title: ticket.title,
      digest: ticket.digest ?? "",
      state: ticket.ended ? ticket.ended.outcome : "open",
      updated: ticket.updatedAt.slice(0, 16),
      score,
      ...(ticket.artifacts ? { artifacts: ticket.artifacts } : {}),
    })),
  };
}

function ensureEvalToolSpecs(baseSpecs: ToolSpec[]): ToolSpec[] {
  const cloned = structuredClone(baseSpecs);
  const hasSearch = cloned.some((s) => s.name === "orchestrator_search");
  if (!hasSearch) {
    cloned.push({
      name: "orchestrator_search",
      description:
        "Search historical tickets by keywords, shorthand, or deliverable filename. Use only when the message explicitly references an older historical ticket not shown on the candidate card.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "Keywords or deliverable filename to search." },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum tickets to return (default 8)." },
          include_other_threads: {
            type: "boolean",
            description: "Whether to include authorized tickets from linked surfaces.",
          },
        },
      },
    });
  }

  // Ensure orchestrator_route schema supports v2 fields (`clarify`, `related_ticket_ids`, `clarification_id`, `question`, `options`)
  // even when invoked prior to full v2 tools.ts merge.
  const routeSpec = cloned.find((s) => s.name === "orchestrator_route");
  if (routeSpec && isRecord(routeSpec.schema.properties)) {
    const decisionsProp = routeSpec.schema.properties.decisions;
    if (isRecord(decisionsProp) && isRecord(decisionsProp.items) && isRecord(decisionsProp.items.properties)) {
      const props = decisionsProp.items.properties;
      if (isRecord(props.kind) && Array.isArray(props.kind.enum) && !props.kind.enum.includes("clarify")) {
        props.kind.enum = [...props.kind.enum, "clarify"];
      }
      if (!("related_ticket_ids" in props)) {
        props.related_ticket_ids = {
          type: ["array", "null"],
          items: { type: "string" },
          maxItems: 3,
          description: "sidecar: optional additional related ticket IDs (at most 3) for multi-ticket synthesis.",
        };
      }
      if (!("clarification_id" in props)) {
        props.clarification_id = {
          type: ["string", "null"],
          description: "Optional pending clarification ID when the person answered an open clarification.",
        };
      }
      if (!("question" in props)) {
        props.question = {
          type: ["string", "null"],
          description: "clarify: short numbered choice question in the person's language (<= 60 chars target).",
        };
      }
      if (!("options" in props)) {
        props.options = {
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              action: { type: "string" },
              ticket_id: { type: ["string", "null"] },
            },
          },
          description: "clarify: structured options paired with the question.",
        };
      }
    }
  }

  return cloned;
}

export function buildInterceptingToolHost(
  app: App,
  triggerId: string,
  trace: RetrievalTrace,
  onCaptured: (route: CapturedRouteCall) => void,
): ToolHost {
  const specs = ensureEvalToolSpecs(mainSpecs());

  const guard = async (name: string, _input: unknown): Promise<Guard> => {
    if (name === "orchestrator_route" || name === "orchestrator_search" || name === "orchestrator_read") {
      return GUARD_ALLOW;
    }
    trace.policyViolations.push(`Blocked disallowed tool in route-only sandbox: ${name}`);
    return guardBlock(`Route-only sandbox blocks side-effect or workspace tool '${name}'.`);
  };

  const call = async (name: string, argumentsValue: unknown): Promise<unknown> => {
    if (name === "orchestrator_search") {
      const args = isRecord(argumentsValue) ? argumentsValue : {};
      const query = typeof args.query === "string" ? args.query : "";
      const limit = typeof args.limit === "number" ? args.limit : 8;
      let result: unknown;
      try {
        // Delegate to production v2 orchestrator_search when registered in app.mainTool
        result = await app.mainTool("orchestrator_search", argumentsValue);
      } catch (err) {
        const msg = errorMessage(err);
        if (msg.includes("Unknown tool") || msg.includes("not found")) {
          result = fallbackTicketSearch(app, query, limit);
        } else {
          throw err;
        }
      }
      const returnedIds = isRecord(result) ? extractTicketIds(result.items ?? result.tickets) : [];
      trace.searchCalls.push({ query, returned_ticket_ids: returnedIds });
      return result;
    }

    if (name === "orchestrator_read") {
      const args = isRecord(argumentsValue) ? argumentsValue : {};
      const resource = typeof args.resource === "string" ? args.resource : "";
      const offset = typeof args.offset === "number" ? args.offset : 0;
      const limit = typeof args.limit === "number" ? args.limit : null;
      trace.readCalls.push({ resource, offset, limit });
      return await app.mainTool("orchestrator_read", argumentsValue);
    }

    if (name === "orchestrator_route") {
      const args = isRecord(argumentsValue) ? argumentsValue : {};
      const decisions = Array.isArray(args.decisions) ? args.decisions : [];
      let chosen: Record<string, unknown> | undefined;
      for (const item of decisions) {
        if (isRecord(item) && item.trigger_id === triggerId) {
          chosen = item;
          break;
        }
      }
      if (chosen === undefined && decisions.length > 0 && isRecord(decisions[0])) {
        chosen = decisions[0];
      }
      if (chosen !== undefined) {
        const relatedIds = Array.isArray(chosen.related_ticket_ids)
          ? chosen.related_ticket_ids.filter((x): x is string => typeof x === "string")
          : [];
        const captured: CapturedRouteCall = {
          kind: typeof chosen.kind === "string" ? chosen.kind : "unknown",
          trigger_id: typeof chosen.trigger_id === "string" ? chosen.trigger_id : triggerId,
          ticket_id: typeof chosen.ticket_id === "string" ? chosen.ticket_id : null,
          related_ticket_ids: relatedIds,
          note: typeof chosen.note === "string" ? chosen.note : null,
          question: typeof chosen.question === "string" ? chosen.question : null,
          reason: typeof chosen.reason === "string" ? chosen.reason : null,
          raw: chosen,
        };
        onCaptured(captured);
        return {
          results: [
            {
              trigger_id: captured.trigger_id,
              ok: true,
              kind: captured.kind,
              intercepted: true,
            },
          ],
        };
      }
      return { results: [], error: "No decision item provided" };
    }

    trace.policyViolations.push(`Unexpected tool invocation: ${name}`);
    throw new Error(`Tool '${name}' is disabled in route-only sandbox`);
  };

  return {
    specs: () => specs,
    call,
    guard,
  };
}

// ---------------------------------------------------------------------------
// Scoring, 5x5+2 Confusion Matrix & 4-Way Root-Cause Attribution
// ---------------------------------------------------------------------------

function toMatrixRow(kind: RouteKind): MatrixRow {
  if (kind === "stop") return "clarify";
  return kind;
}

export function scoreCaseRun(
  testCase: GoldCase,
  runIndex: number,
  captured: CapturedRouteCall | null,
  trace: RetrievalTrace,
  latencyMs: number,
  execError?: string,
): SingleRunOutcome {
  const gold = testCase.gold_route;
  const retrieval = testCase.expected_retrieval;
  const matrixRow = toMatrixRow(gold.kind);

  const searchCalled = trace.searchCalls.length > 0;
  const searchReturnedTarget = trace.searchCalls.some((call) =>
    call.returned_ticket_ids.some((id) => retrieval.target_ticket_ids.includes(id)),
  );
  const cardHadTarget = retrieval.target_ticket_ids.some((id) => trace.cardAllTicketIds.includes(id));
  const cardInjectedForbidden = retrieval.forbidden_card_ticket_ids.some((id) =>
    trace.cardRecalledIds.includes(id),
  );
  const searchCompliant = retrieval.requires_search ? searchCalled : null;
  const spuriousSearch = testCase.group === "G4_clean_negative" && searchCalled;

  if (execError !== undefined || captured === null) {
    return {
      runIndex,
      captured,
      trace,
      passed: false,
      exactTargetMatch: false,
      matrixRow,
      matrixCol: "other_or_error",
      attribution: "EXEC_ERROR",
      criticalFp: false,
      falseAttach: false,
      misroute: false,
      searchCompliant,
      spuriousSearch,
      latencyMs,
      error: execError ?? "Model ended turn without calling orchestrator_route",
    };
  }

  const predKind = captured.kind as RouteKind;
  const predTicketId = captured.ticket_id;

  const acceptableSet = new Set<string>(
    gold.acceptable_ticket_ids.length > 0
      ? gold.acceptable_ticket_ids
      : gold.ticket_id !== null
        ? [gold.ticket_id]
        : [],
  );
  const forbiddenTickets = new Set<string>(gold.forbidden_ticket_ids);
  const forbiddenKinds = new Set<RouteKind>(gold.forbidden_kinds);

  let passed = false;
  let exactTargetMatch = false;
  let matrixCol: MatrixCol = "other_or_error";
  let falseAttach = false;
  let misroute = false;

  if (predKind === "sidecar") {
    if (gold.kind === "sidecar" && predTicketId !== null && acceptableSet.has(predTicketId)) {
      passed = true;
      exactTargetMatch = true;
      matrixCol = "sidecar";
    } else {
      passed = false;
      matrixCol = "wrong_ticket_sidecar";
      misroute = true;
    }
  } else if (predKind === "attach") {
    if (
      gold.kind === "attach" &&
      predTicketId !== null &&
      acceptableSet.has(predTicketId) &&
      !forbiddenTickets.has(predTicketId)
    ) {
      passed = true;
      exactTargetMatch = true;
      matrixCol = "attach";
    } else {
      passed = false;
      matrixCol = "wrong_ticket_attach";
      falseAttach = true;
      misroute = true;
    }
  } else if (predKind === "accept") {
    matrixCol = "accept";
    passed = gold.kind === "accept" && !forbiddenKinds.has("accept");
  } else if (predKind === "ignore") {
    matrixCol = "ignore";
    passed = gold.kind === "ignore" && !forbiddenKinds.has("ignore");
  } else if (predKind === "clarify") {
    matrixCol = "clarify";
    passed = gold.kind === "clarify" && !forbiddenKinds.has("clarify");
  } else {
    matrixCol = "other_or_error";
    passed = gold.kind === predKind && !forbiddenKinds.has(predKind);
    if (!passed && predKind === "stop") {
      misroute = true;
    }
  }

  // Guardrail violation or forbidden ticket check
  if (predTicketId !== null && forbiddenTickets.has(predTicketId)) {
    passed = false;
    misroute = true;
    if (predKind === "attach") {
      falseAttach = true;
      matrixCol = "wrong_ticket_attach";
    } else if (predKind === "sidecar") {
      matrixCol = "wrong_ticket_sidecar";
    }
  }

  const criticalFp =
    !passed &&
    testCase.fp_severity === "critical" &&
    (falseAttach || matrixCol === "wrong_ticket_sidecar" || predKind === "stop");

  // 4-Way Root-Cause Attribution
  let attribution: Attribution = "OK";
  if (!passed) {
    const isPositiveGroup =
      testCase.group === "G1_sidecar_hit" ||
      testCase.group === "G2_attach_hit" ||
      testCase.group === "G5_ambiguous_clarify";

    if (isPositiveGroup) {
      const targetSurfaced = cardHadTarget || searchReturnedTarget;
      if (misroute) {
        // Model targeted the wrong ticket or guessed blindly on ambiguous pair
        attribution = cardInjectedForbidden ? "RETRIEVAL_FP_ANCHOR" : "MODEL_MISROUTE_FP";
      } else if (!targetSurfaced && !searchCalled) {
        // Card missed target AND model didn't try orchestrator_search!
        attribution = retrieval.expect_in_card ? "RETRIEVAL_FN" : "MODEL_LAZINESS_FN";
      } else if (!targetSurfaced && searchCalled) {
        // Model searched faithfully, yet retrieval failed to surface the target
        attribution = "RETRIEVAL_FN";
      } else {
        // Target WAS surfaced in card or search, yet model still accepted/ignored instead of hitting it
        attribution = "MODEL_LAZINESS_FN";
      }
    } else {
      // Negative or Guardrail groups (G3, G4, G6)
      const hitInjectedDistractor =
        predTicketId !== null &&
        retrieval.forbidden_card_ticket_ids.includes(predTicketId) &&
        trace.cardRecalledIds.includes(predTicketId);
      if (hitInjectedDistractor || (cardInjectedForbidden && misroute)) {
        attribution = "RETRIEVAL_FP_ANCHOR";
      } else {
        attribution = "MODEL_MISROUTE_FP";
      }
    }
  }

  return {
    runIndex,
    captured,
    trace,
    passed,
    exactTargetMatch,
    matrixRow,
    matrixCol,
    attribution,
    criticalFp,
    falseAttach,
    misroute,
    searchCompliant,
    spuriousSearch,
    latencyMs,
  };
}

/**
 * Computes Pass@1 (run 0) and Majority@N outcome across N repeated runs for a single case.
 */
export function aggregateCaseRuns(testCase: GoldCase, runs: SingleRunOutcome[]): CaseEvalResult {
  const pass1 = runs[0]!;
  if (runs.length === 1) {
    return { testCase, runs, pass1, majority: pass1 };
  }

  const votes = new Map<string, { count: number; sample: SingleRunOutcome }>();
  for (const run of runs) {
    const key = `${run.captured?.kind ?? "ERR"}::${run.captured?.ticket_id ?? "null"}`;
    const entry = votes.get(key);
    if (entry === undefined) {
      votes.set(key, { count: 1, sample: run });
    } else {
      entry.count += 1;
    }
  }

  let winner = pass1;
  let bestCount = -1;
  for (const entry of votes.values()) {
    if (entry.count > bestCount) {
      bestCount = entry.count;
      winner = entry.sample;
    }
  }

  return { testCase, runs, pass1, majority: winner };
}

// ---------------------------------------------------------------------------
// Real-LLM Sandbox Execution
// ---------------------------------------------------------------------------

function resolveHookRelay(): string[] {
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const compiledBin = path.resolve(import.meta.dir, "../dist", `neo-agent${exeSuffix}`);
  if (fs.existsSync(compiledBin)) {
    return [compiledBin, "agy-hook"];
  }
  const mainTs = path.resolve(import.meta.dir, "../src/main.ts");
  return [process.execPath, "run", mainTs, "agy-hook"];
}

export async function runCaseRealLlm(
  testCase: GoldCase,
  runIndex: number,
  options: { model?: string; program: string; timeoutMs: number },
): Promise<SingleRunOutcome> {
  const startNs = Bun.nanoseconds();
  const tempDir = new TempDir(`neo-routing-eval-${testCase.id}-r${runIndex}`);
  let driver: Driver | undefined;
  let app: App | undefined;

  try {
    const sandbox = seedSandboxApp(testCase, tempDir.path);
    app = sandbox.app;
    const trace = inspectCardRetrieval(sandbox.card);
    let captured: CapturedRouteCall | null = null;

    const host = buildInterceptingToolHost(app, sandbox.trigger.id, trace, (route) => {
      if (captured === null) {
        captured = route;
      }
    });

    const systemPrompt = prompts.compose("orchestrator", app.settings());
    const sessionSpec: SessionSpec = {
      sessionId: `eval-${testCase.id}-r${runIndex}`,
      role: "orchestrator",
      cwd: tempDir.path,
      systemPrompt,
      model: options.model !== undefined ? { provider: "antigravity", model: options.model } : undefined,
    };

    const driverOptions = buildAntigravityOptions(
      options.program,
      sessionSpec,
      host,
      {},
      resolveHookRelay(),
    );
    const events = new UnboundedChannel<DriverEvent>();
    driver = new AntigravityDriver(driverOptions, host, events);

    const turnDone = new Promise<string | undefined>((resolve) => {
      let settled = false;
      const finish = (err?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(err);
      };
      const timer = setTimeout(() => {
        finish(`Timed out after ${options.timeoutMs}ms waiting for orchestrator_route`);
      }, options.timeoutMs);

      void (async () => {
        while (!settled) {
          const ev = await events.recv();
          if (ev === undefined) {
            finish("Driver event channel closed unexpectedly");
            return;
          }
          if (ev.type === "idle") {
            finish(undefined);
            return;
          }
          if (ev.type === "exited") {
            finish(ev.error ?? (captured === null ? "Driver exited before routing" : undefined));
            return;
          }
        }
      })();
    });

    await driver.submit(
      `eval:${testCase.id}:${runIndex}`,
      [textBlock(JSON.stringify(sandbox.card))],
      "steer",
    );

    const execError = await turnDone;
    const latencyMs = Number(((Bun.nanoseconds() - startNs) / 1e6).toFixed(2));
    return scoreCaseRun(testCase, runIndex, captured, trace, latencyMs, execError);
  } catch (err) {
    const latencyMs = Number(((Bun.nanoseconds() - startNs) / 1e6).toFixed(2));
    return scoreCaseRun(
      testCase,
      runIndex,
      null,
      {
        cardRelatedIds: [],
        cardRecalledIds: [],
        cardOtherThreadIds: [],
        cardAllTicketIds: [],
        cardRecalledConfidences: {},
        cardTicketsTotal: 0,
        searchCalls: [],
        readCalls: [],
        policyViolations: [],
      },
      latencyMs,
      errorMessage(err),
    );
  } finally {
    if (driver !== undefined) {
      try {
        await driver.close();
      } catch {
        // ignore close errors
      }
    }
    if (app !== undefined) {
      try {
        app.close();
      } catch {
        // ignore store close errors
      }
    }
    tempDir.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Dry-Run Mode (Schema + Real Store/Card Integrity + Simulated Pipeline)
// ---------------------------------------------------------------------------

export function runCaseDryRun(testCase: GoldCase, runIndex: number): SingleRunOutcome {
  const startNs = Bun.nanoseconds();
  const tempDir = new TempDir(`neo-routing-dry-${testCase.id}-r${runIndex}`);
  let app: App | undefined;

  try {
    const sandbox = seedSandboxApp(testCase, tempDir.path);
    app = sandbox.app;

    // Verify real Store schema invariant and real candidateCard fields
    const schemaVal = app.store.get<number | string>("schema");
    if (Number(schemaVal) !== SCHEMA_VERSION) {
      throw new Error(`Unexpected store schema version: ${String(schemaVal)} (expected ${SCHEMA_VERSION})`);
    }
    if (testCase.seed_profile === "deep_history_60" && testCase.surface === "wechat") {
      const total = sandbox.card.tickets_total;
      if (typeof total !== "number" || total < 50) {
        throw new Error(`Expected deep_history_60 card tickets_total >= 50, got ${String(total)}`);
      }
    }
    if (testCase.id === "G6-02") {
      const hb = sandbox.card.handed_back;
      if (!Array.isArray(hb) || hb.length === 0) {
        throw new Error("G6-02 candidateCard missing expected handed_back entry");
      }
    }

    const trace = inspectCardRetrieval(sandbox.card);
    if (testCase.expected_retrieval.requires_search) {
      trace.searchCalls.push({
        query: testCase.user_message.slice(0, 24),
        returned_ticket_ids: [...testCase.expected_retrieval.target_ticket_ids],
      });
    }

    const captured: CapturedRouteCall = {
      kind: testCase.gold_route.kind,
      trigger_id: sandbox.trigger.id,
      ticket_id: testCase.gold_route.ticket_id,
      related_ticket_ids: [...(testCase.gold_route.expected_related_ticket_ids ?? [])],
      note: null,
      question:
        testCase.gold_route.kind === "clarify"
          ? "你是指哪一份？回数字即可：1) 候选项A 2) 候选项B"
          : null,
      reason: testCase.gold_route.kind === "ignore" ? "ordinary conversation" : null,
      raw: { simulated: true },
    };

    const latencyMs = Number(((Bun.nanoseconds() - startNs) / 1e6).toFixed(2));
    return scoreCaseRun(testCase, runIndex, captured, trace, latencyMs);
  } finally {
    if (app !== undefined) {
      app.close();
    }
    tempDir.cleanup();
  }
}

/**
 * Deterministic in-memory self-checks executed during `--dry-run` to prove every confusion-matrix column,
 * all 4 root-cause attribution buckets, Majority@3 voting, and Baseline Critical-FP diff blocking work accurately.
 */
export function runDryRunSelfChecks(cases: readonly GoldCase[]): void {
  const g1 = cases.find((c) => c.id === "G1-01") ?? cases[0]!;
  const g1Search = cases.find((c) => c.id === "G1-09") ?? g1;
  const g2 = cases.find((c) => c.id === "G2-01") ?? cases[0]!;
  const g3 = cases.find((c) => c.id === "G3-01") ?? cases[0]!;
  const g6 = cases.find((c) => c.id === "G6-01") ?? cases[0]!;

  const emptyTrace = (over: Partial<RetrievalTrace> = {}): RetrievalTrace => ({
    cardRelatedIds: [],
    cardRecalledIds: [],
    cardOtherThreadIds: [],
    cardAllTicketIds: [],
    cardRecalledConfidences: {},
    cardTicketsTotal: 60,
    searchCalls: [],
    readCalls: [],
    policyViolations: [],
    ...over,
  });

  // 1. RETRIEVAL_FN: model searched, target still not returned, routed accept
  const rFn = scoreCaseRun(
    g1,
    0,
    { kind: "accept", trigger_id: "t1", ticket_id: null, related_ticket_ids: [], note: null, question: null, reason: null, raw: {} },
    emptyTrace({ searchCalls: [{ query: "二十万五大洲", returned_ticket_ids: [] }] }),
    10,
  );
  if (rFn.attribution !== "RETRIEVAL_FN") {
    throw new Error(`Self-check failed: expected RETRIEVAL_FN, got ${rFn.attribution}`);
  }

  // 2. RETRIEVAL_FP_ANCHOR: hard-negative distractor injected into recalled_tickets -> model false-attached to it
  const rFpAnchor = scoreCaseRun(
    g3,
    0,
    { kind: "attach", trigger_id: "t2", ticket_id: "t_travel_20w", related_ticket_ids: [], note: null, question: null, reason: null, raw: {} },
    emptyTrace({ cardRecalledIds: ["t_travel_20w"], cardAllTicketIds: ["t_travel_20w"] }),
    10,
  );
  if (
    rFpAnchor.attribution !== "RETRIEVAL_FP_ANCHOR" ||
    rFpAnchor.matrixCol !== "wrong_ticket_attach" ||
    !rFpAnchor.criticalFp ||
    !rFpAnchor.falseAttach
  ) {
    throw new Error(`Self-check failed: expected RETRIEVAL_FP_ANCHOR + wrong_ticket_attach + criticalFp`);
  }

  // 3. MODEL_LAZINESS_FN: target requires search, model skipped search and accepted
  const rLazy = scoreCaseRun(
    g1Search,
    0,
    { kind: "accept", trigger_id: "t3", ticket_id: null, related_ticket_ids: [], note: null, question: null, reason: null, raw: {} },
    emptyTrace(),
    10,
  );
  if (rLazy.attribution !== "MODEL_LAZINESS_FN" || rLazy.searchCompliant !== false) {
    throw new Error(`Self-check failed: expected MODEL_LAZINESS_FN + searchCompliant=false, got ${rLazy.attribution}`);
  }

  // 4. MODEL_MISROUTE_FP + wrong_ticket_sidecar + guardrail stopped attach check
  const rWrongSidecar = scoreCaseRun(
    g1,
    0,
    { kind: "sidecar", trigger_id: "t4", ticket_id: "t_etf_report", related_ticket_ids: [], note: null, question: null, reason: null, raw: {} },
    emptyTrace({ cardAllTicketIds: ["t_travel_20w", "t_etf_report"] }),
    10,
  );
  if (rWrongSidecar.matrixCol !== "wrong_ticket_sidecar" || rWrongSidecar.attribution !== "MODEL_MISROUTE_FP") {
    throw new Error(`Self-check failed: expected wrong_ticket_sidecar + MODEL_MISROUTE_FP`);
  }

  const rGuardrail = scoreCaseRun(
    g6,
    0,
    { kind: "attach", trigger_id: "t5", ticket_id: "t_stopped_scraper", related_ticket_ids: [], note: null, question: null, reason: null, raw: {} },
    emptyTrace(),
    10,
  );
  if (!rGuardrail.criticalFp || !rGuardrail.falseAttach || rGuardrail.attribution !== "MODEL_MISROUTE_FP") {
    throw new Error(`Self-check failed: stopped ticket attach must be criticalFp + MODEL_MISROUTE_FP`);
  }

  // 5. Majority@3 voting check
  const passRun = scoreCaseRun(
    g2,
    0,
    { kind: "attach", trigger_id: "t6", ticket_id: "t_etf_report", related_ticket_ids: [], note: null, question: null, reason: null, raw: {} },
    emptyTrace({ cardAllTicketIds: ["t_etf_report"] }),
    10,
  );
  const failRun = scoreCaseRun(
    g2,
    1,
    { kind: "accept", trigger_id: "t6", ticket_id: null, related_ticket_ids: [], note: null, question: null, reason: null, raw: {} },
    emptyTrace({ cardAllTicketIds: ["t_etf_report"] }),
    10,
  );
  const agg = aggregateCaseRuns(g2, [failRun, passRun, { ...passRun, runIndex: 2 }]);
  if (agg.pass1.passed !== false || agg.majority.passed !== true) {
    throw new Error("Self-check failed: Majority@3 aggregation mismatch");
  }

  // 6. Baseline Critical-FP diff blocking check
  const baseReport = computeReport(
    [aggregateCaseRuns(g3, [scoreCaseRun(g3, 0, { kind: "accept", trigger_id: "t", ticket_id: null, related_ticket_ids: [], note: null, question: null, reason: null, raw: {} }, emptyTrace(), 5)])],
    { mode: "dry-run", model: "dry-run", runsPerCase: 1, groupsFilter: [] },
  );
  const regressedReport = computeReport(
    [aggregateCaseRuns(g3, [rFpAnchor])],
    { mode: "dry-run", model: "dry-run", runsPerCase: 1, groupsFilter: [] },
  );
  const diff = diffAgainstBaseline(regressedReport, baseReport);
  if (!diff.blocked || !diff.newCriticalFpIds.includes(g3.id)) {
    throw new Error("Self-check failed: Baseline diff did not block on newly introduced Critical FP");
  }
}

// ---------------------------------------------------------------------------
// Metrics Aggregation, Matrix, Gates & Baseline Diff
// ---------------------------------------------------------------------------

function emptyConfusionMatrix(): Record<MatrixRow, Record<MatrixCol, number>> {
  const matrix = {} as Record<MatrixRow, Record<MatrixCol, number>>;
  for (const row of MATRIX_ROWS) {
    const cols = {} as Record<MatrixCol, number>;
    for (const col of MATRIX_COLS) {
      cols[col] = 0;
    }
    matrix[row] = cols;
  }
  return matrix;
}

export function computeReport(
  results: readonly CaseEvalResult[],
  meta: { mode: "dry-run" | "real-llm"; model: string; runsPerCase: number; groupsFilter: string[] },
): EvalReport {
  const matrix = emptyConfusionMatrix();
  const attributionCounts: Record<Attribution, number> = {
    OK: 0,
    RETRIEVAL_FN: 0,
    RETRIEVAL_FP_ANCHOR: 0,
    MODEL_LAZINESS_FN: 0,
    MODEL_MISROUTE_FP: 0,
    EXEC_ERROR: 0,
  };
  const groupStats: Record<GoldGroup, { total: number; passed: number; passRate: number; criticalFp: number }> = {
    G1_sidecar_hit: { total: 0, passed: 0, passRate: 1, criticalFp: 0 },
    G2_attach_hit: { total: 0, passed: 0, passRate: 1, criticalFp: 0 },
    G3_hard_negative: { total: 0, passed: 0, passRate: 1, criticalFp: 0 },
    G4_clean_negative: { total: 0, passed: 0, passRate: 1, criticalFp: 0 },
    G5_ambiguous_clarify: { total: 0, passed: 0, passRate: 1, criticalFp: 0 },
    G6_guardrails: { total: 0, passed: 0, passRate: 1, criticalFp: 0 },
  };

  let positiveTotal = 0;
  let positivePass1 = 0;
  let positiveMajority = 0;
  let negGuardTotal = 0;
  let negGuardMisroute = 0;
  let totalMisroutes = 0;
  let falseAttaches = 0;
  let wrongTicketSidecar = 0;
  let wrongTicketAttach = 0;
  let criticalFpCount = 0;

  let clarifyGold = 0;
  let clarifyTp = 0;
  let clarifyPredicted = 0;

  let searchRequiredTotal = 0;
  let searchRequiredComplied = 0;
  let cleanNegTotal = 0;
  let cleanNegSpuriousSearch = 0;

  let guardrailTotal = 0;
  let guardrailPassed = 0;
  let latencySum = 0;

  const caseSummaries: EvalReport["cases"] = [];

  for (const res of results) {
    const tc = res.testCase;
    const out = res.majority;

    matrix[out.matrixRow][out.matrixCol] += 1;
    attributionCounts[out.attribution] += 1;

    const gs = groupStats[tc.group];
    gs.total += 1;
    if (out.passed) gs.passed += 1;
    if (out.criticalFp) gs.criticalFp += 1;

    latencySum += out.latencyMs;

    if (tc.group === "G1_sidecar_hit" || tc.group === "G2_attach_hit") {
      positiveTotal += 1;
      if (res.pass1.passed) positivePass1 += 1;
      if (out.passed) positiveMajority += 1;
    }

    if (tc.group === "G3_hard_negative" || tc.group === "G4_clean_negative" || tc.group === "G6_guardrails") {
      negGuardTotal += 1;
      if (out.misroute) negGuardMisroute += 1;
    }

    if (tc.group === "G4_clean_negative") {
      cleanNegTotal += 1;
      if (out.spuriousSearch) cleanNegSpuriousSearch += 1;
    }

    if (tc.group === "G6_guardrails") {
      guardrailTotal += 1;
      if (out.passed) guardrailPassed += 1;
    }

    if (out.misroute) totalMisroutes += 1;
    if (out.falseAttach) falseAttaches += 1;
    if (out.matrixCol === "wrong_ticket_sidecar") wrongTicketSidecar += 1;
    if (out.matrixCol === "wrong_ticket_attach") wrongTicketAttach += 1;
    if (out.criticalFp) criticalFpCount += 1;

    if (tc.gold_route.kind === "clarify") {
      clarifyGold += 1;
      if (out.captured?.kind === "clarify") clarifyTp += 1;
    }
    if (out.captured?.kind === "clarify") {
      clarifyPredicted += 1;
    }

    if (out.searchCompliant !== null) {
      searchRequiredTotal += 1;
      if (out.searchCompliant) searchRequiredComplied += 1;
    }

    caseSummaries.push({
      id: tc.id,
      group: tc.group,
      passed: out.passed,
      predictedKind: out.captured?.kind ?? null,
      predictedTicketId: out.captured?.ticket_id ?? null,
      matrixCol: out.matrixCol,
      attribution: out.attribution,
      criticalFp: out.criticalFp,
      falseAttach: out.falseAttach,
      searchCalls: out.trace.searchCalls.length,
      latencyMs: out.latencyMs,
      ...(out.error !== undefined ? { error: out.error } : {}),
    });
  }

  for (const grp of Object.keys(groupStats) as GoldGroup[]) {
    const gs = groupStats[grp];
    gs.passRate = gs.total > 0 ? gs.passed / gs.total : 1;
  }

  const totalCases = results.length;
  const tpRatePass1 = positiveTotal > 0 ? positivePass1 / positiveTotal : 1;
  const tpRateMajority = positiveTotal > 0 ? positiveMajority / positiveTotal : 1;
  const totalMisrouteRate = totalCases > 0 ? totalMisroutes / totalCases : 0;
  const negativeMisrouteRate = negGuardTotal > 0 ? negGuardMisroute / negGuardTotal : 0;
  const falseAttachRate = totalCases > 0 ? falseAttaches / totalCases : 0;
  const clarifyPrecision =
    clarifyPredicted > 0 ? clarifyTp / clarifyPredicted : clarifyGold === 0 ? 1 : 0;
  const clarifyRecall = clarifyGold > 0 ? clarifyTp / clarifyGold : 1;
  const searchComplianceRate =
    searchRequiredTotal > 0 ? searchRequiredComplied / searchRequiredTotal : 1;
  const spuriousSearchRate = cleanNegTotal > 0 ? cleanNegSpuriousSearch / cleanNegTotal : 0;
  const guardrailPassRate = guardrailTotal > 0 ? guardrailPassed / guardrailTotal : 1;
  const meanLatencyMs = totalCases > 0 ? Number((latencySum / totalCases).toFixed(2)) : 0;

  const metrics: EvalMetrics = {
    totalCases,
    positiveCases: positiveTotal,
    negativeAndGuardrailCases: negGuardTotal,
    clarifyGoldCases: clarifyGold,
    tpRatePass1,
    tpRateMajority,
    totalMisrouteRate,
    negativeMisrouteRate,
    falseAttachRate,
    wrongTicketSidecarCount: wrongTicketSidecar,
    wrongTicketAttachCount: wrongTicketAttach,
    criticalFpCount,
    clarifyPrecision,
    clarifyRecall,
    searchComplianceRate,
    spuriousSearchRate,
    guardrailPassRate,
    meanLatencyMs,
  };

  const gates: GateCheck[] = [];
  if (positiveTotal > 0) {
    gates.push({
      name: "TP Rate (Pass@1)",
      actual: tpRatePass1,
      threshold: `>= ${(GATES.minTpRatePass1 * 100).toFixed(0)}%`,
      passed: tpRatePass1 >= GATES.minTpRatePass1,
    });
    if (meta.runsPerCase >= 3) {
      gates.push({
        name: `TP Rate (Majority@${meta.runsPerCase})`,
        actual: tpRateMajority,
        threshold: `>= ${(GATES.minTpRateMajority3 * 100).toFixed(0)}%`,
        passed: tpRateMajority >= GATES.minTpRateMajority3,
      });
    }
  }
  gates.push({
    name: "Total Misroute Rate",
    actual: totalMisrouteRate,
    threshold: `<= ${(GATES.maxTotalMisrouteRate * 100).toFixed(0)}%`,
    passed: totalMisrouteRate <= GATES.maxTotalMisrouteRate,
  });
  gates.push({
    name: "False-Attach Rate",
    actual: falseAttachRate,
    threshold: `<= ${(GATES.maxFalseAttachRate * 100).toFixed(0)}%`,
    passed: falseAttachRate <= GATES.maxFalseAttachRate,
  });
  if (clarifyGold > 0) {
    gates.push({
      name: "Clarify Precision",
      actual: clarifyPrecision,
      threshold: `>= ${(GATES.minClarifyPrecision * 100).toFixed(0)}%`,
      passed: clarifyPrecision >= GATES.minClarifyPrecision,
    });
    gates.push({
      name: "Clarify Recall",
      actual: clarifyRecall,
      threshold: `>= ${(GATES.minClarifyRecall * 100).toFixed(0)}%`,
      passed: clarifyRecall >= GATES.minClarifyRecall,
    });
  }
  if (searchRequiredTotal > 0) {
    gates.push({
      name: "Search Compliance",
      actual: searchComplianceRate,
      threshold: `>= ${(GATES.minSearchCompliance * 100).toFixed(0)}%`,
      passed: searchComplianceRate >= GATES.minSearchCompliance,
    });
  }
  if (guardrailTotal > 0) {
    gates.push({
      name: "Guardrails (G6)",
      actual: guardrailPassRate,
      threshold: "= 100%",
      passed: guardrailPassRate === 1,
    });
  }

  return {
    schemaVersion: "routing-eval-v1",
    generatedAt: new Date().toISOString(),
    mode: meta.mode,
    model: meta.model,
    runsPerCase: meta.runsPerCase,
    groupsFilter: meta.groupsFilter,
    metrics,
    confusionMatrix: matrix,
    attributionCounts,
    groupStats,
    gates,
    allGatesPassed: gates.every((g) => g.passed),
    cases: caseSummaries,
  };
}

export function diffAgainstBaseline(current: EvalReport, baseline: EvalReport): BaselineDiff {
  const baseById = new Map(baseline.cases.map((c) => [c.id, c]));
  const newCriticalFpIds: string[] = [];
  const resolvedCriticalFpIds: string[] = [];
  const regressedCaseIds: string[] = [];
  const improvedCaseIds: string[] = [];

  for (const cur of current.cases) {
    const prev = baseById.get(cur.id);
    if (prev === undefined) continue;
    if (cur.criticalFp && !prev.criticalFp) {
      newCriticalFpIds.push(cur.id);
    }
    if (!cur.criticalFp && prev.criticalFp) {
      resolvedCriticalFpIds.push(cur.id);
    }
    if (!cur.passed && prev.passed) {
      regressedCaseIds.push(cur.id);
    }
    if (cur.passed && !prev.passed) {
      improvedCaseIds.push(cur.id);
    }
  }

  const deltaTpRate = current.metrics.tpRatePass1 - baseline.metrics.tpRatePass1;
  const deltaMisrouteRate = current.metrics.totalMisrouteRate - baseline.metrics.totalMisrouteRate;
  const deltaFalseAttachRate = current.metrics.falseAttachRate - baseline.metrics.falseAttachRate;

  const reasons: string[] = [];
  if (newCriticalFpIds.length > 0) {
    reasons.push(`Newly introduced Critical FP case(s): ${newCriticalFpIds.join(", ")}`);
  }
  if (deltaTpRate < -GATES.maxTpDropFromBaseline) {
    reasons.push(
      `TP Rate regressed by ${(deltaTpRate * 100).toFixed(2)}pp (limit -${(GATES.maxTpDropFromBaseline * 100).toFixed(1)}pp)`,
    );
  }
  if (current.metrics.totalMisrouteRate > GATES.maxTotalMisrouteRate && deltaMisrouteRate > 0) {
    reasons.push(
      `Total Misroute Rate exceeded gate (${(current.metrics.totalMisrouteRate * 100).toFixed(2)}% > ${(GATES.maxTotalMisrouteRate * 100).toFixed(0)}%)`,
    );
  }
  if (current.metrics.falseAttachRate > GATES.maxFalseAttachRate && deltaFalseAttachRate > 0) {
    reasons.push(
      `False-Attach Rate exceeded gate (${(current.metrics.falseAttachRate * 100).toFixed(2)}% > ${(GATES.maxFalseAttachRate * 100).toFixed(0)}%)`,
    );
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    newCriticalFpIds,
    resolvedCriticalFpIds,
    regressedCaseIds,
    improvedCaseIds,
    deltaTpRate,
    deltaMisrouteRate,
    deltaFalseAttachRate,
  };
}

// ---------------------------------------------------------------------------
// Pretty Report Printer
// ---------------------------------------------------------------------------

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : `${" ".repeat(width - text.length)}${text}`;
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

export function formatReportText(report: EvalReport, diff?: BaselineDiff): string {
  const lines: string[] = [];
  lines.push("================================================================================");
  lines.push(`Neo L3 Historical-Ticket Routing Eval (${report.mode.toUpperCase()})`);
  lines.push(
    `Model: ${report.model} | Cases: ${report.metrics.totalCases} | Runs/Case: ${report.runsPerCase} | Mean Latency: ${report.metrics.meanLatencyMs}ms`,
  );
  lines.push("================================================================================");

  // 1. Group Breakdown
  lines.push("");
  lines.push("1) Group Breakdown:");
  for (const grp of Object.keys(EXPECTED_GROUP_COUNTS) as GoldGroup[]) {
    const gs = report.groupStats[grp];
    if (gs.total === 0) continue;
    lines.push(
      `  ${padRight(grp, 22)} ${padLeft(`${gs.passed}/${gs.total}`, 6)} (${padLeft(pct(gs.passRate), 6)})  critical_fp=${gs.criticalFp}`,
    );
  }

  // 2. 5x5+2 Confusion Matrix
  lines.push("");
  lines.push("2) 5x5 Confusion Matrix (+ wrong_ticket_sidecar / wrong_ticket_attach):");
  const colHeaders: ReadonlyArray<readonly [MatrixCol, string, number]> = [
    ["sidecar", "sidecar", 8],
    ["attach", "attach", 8],
    ["accept", "accept", 8],
    ["ignore", "ignore", 8],
    ["clarify", "clarify", 8],
    ["wrong_ticket_sidecar", "wr_side", 9],
    ["wrong_ticket_attach", "wr_att", 8],
    ["other_or_error", "err/oth", 8],
  ];
  const headerLine =
    padRight("Gold \\ Pred", 12) +
    colHeaders.map(([, label, w]) => padLeft(label, w)).join("") +
    padLeft("Total", 7);
  lines.push(`  ${headerLine}`);
  lines.push(`  ${"-".repeat(headerLine.length)}`);
  for (const row of MATRIX_ROWS) {
    const rowData = report.confusionMatrix[row];
    let sum = 0;
    const cells = colHeaders.map(([col, , w]) => {
      const val = rowData[col];
      sum += val;
      return padLeft(String(val), w);
    });
    lines.push(`  ${padRight(row, 12)}${cells.join("")}${padLeft(String(sum), 7)}`);
  }

  // 3. 4-Way Automatic Root-Cause Attribution
  lines.push("");
  lines.push("3) 4-Way Root-Cause Attribution:");
  for (const key of ATTRIBUTION_KEYS) {
    lines.push(`  ${padRight(key, 22)} ${padLeft(String(report.attributionCounts[key]), 4)}`);
  }

  // 4. Core Gate Evaluation
  lines.push("");
  lines.push("4) Core Release Gates:");
  for (const gate of report.gates) {
    const badge = gate.passed ? "PASS" : "FAIL";
    lines.push(
      `  [${badge}] ${padRight(gate.name, 26)} actual=${padLeft(pct(gate.actual), 7)}  target=${gate.threshold}`,
    );
  }
  lines.push(
    `  Extra telemetry: wrong_ticket_sidecar=${report.metrics.wrongTicketSidecarCount}, wrong_ticket_attach=${report.metrics.wrongTicketAttachCount}, critical_fp=${report.metrics.criticalFpCount}, spurious_search=${pct(report.metrics.spuriousSearchRate)}`,
  );

  // 5. Failed Case Diagnostics
  const failed = report.cases.filter((c) => !c.passed);
  if (failed.length > 0) {
    lines.push("");
    lines.push(`5) Failed Cases (${failed.length}):`);
    for (const item of failed) {
      lines.push(
        `  - ${item.id} [${item.group}] pred=${item.predictedKind ?? "NONE"}(${item.predictedTicketId ?? "-"}) col=${item.matrixCol} cause=${item.attribution}${item.criticalFp ? " [CRITICAL_FP]" : ""}${item.error ? ` err=${item.error}` : ""}`,
      );
    }
  }

  // 6. Baseline Diff
  if (diff !== undefined) {
    lines.push("");
    lines.push(`6) Baseline Diff (${diff.blocked ? "BLOCKED" : "OK"}):`);
    lines.push(
      `  Delta TP: ${(diff.deltaTpRate * 100).toFixed(2)}pp | Delta Misroute: ${(diff.deltaMisrouteRate * 100).toFixed(2)}pp | Delta False-Attach: ${(diff.deltaFalseAttachRate * 100).toFixed(2)}pp`,
    );
    lines.push(
      `  New Critical FP: ${diff.newCriticalFpIds.length > 0 ? diff.newCriticalFpIds.join(", ") : "none"} | Regressed: ${diff.regressedCaseIds.length} | Improved: ${diff.improvedCaseIds.length}`,
    );
    for (const reason of diff.reasons) {
      lines.push(`  [BLOCK] ${reason}`);
    }
  }

  lines.push("================================================================================");
  lines.push(
    `OVERALL VERDICT: ${report.allGatesPassed && !(diff?.blocked ?? false) ? "PASS" : "FAIL"}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI Argument Parser & Entrypoint
// ---------------------------------------------------------------------------

function resolveGroupToken(token: string): GoldGroup {
  const trimmed = token.trim();
  if (VALID_GROUPS.has(trimmed)) {
    return trimmed as GoldGroup;
  }
  const upper = trimmed.toUpperCase();
  for (const grp of Object.keys(EXPECTED_GROUP_COUNTS) as GoldGroup[]) {
    if (grp.toUpperCase().startsWith(`${upper}_`) || grp.toUpperCase() === upper) {
      return grp;
    }
  }
  throw new Error(`Unknown --group '${token}'. Valid groups: ${Object.keys(EXPECTED_GROUP_COUNTS).join(", ")} (or G1..G6)`);
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    dryRun: false,
    model: process.env.NEO_EVAL_MODEL,
    runs: 1,
    groups: [],
    baselinePath: undefined,
    saveBaselinePath: undefined,
    datasetPath: DEFAULT_DATASET_PATH,
    program: process.env.NEO_AGY_PROGRAM ?? "agy",
    concurrency: 4,
    timeoutMs: 60_000,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--model": {
        const val = argv[++i];
        if (!val) throw new Error("--model requires a value");
        opts.model = val;
        break;
      }
      case "--runs": {
        const val = Number.parseInt(argv[++i] ?? "", 10);
        if (!Number.isInteger(val) || val < 1 || val > 20) {
          throw new Error("--runs must be an integer between 1 and 20");
        }
        opts.runs = val;
        break;
      }
      case "--group": {
        const raw = argv[++i];
        if (!raw) throw new Error("--group requires a value (e.g., G1 or G1,G3)");
        for (const part of raw.split(",")) {
          if (part.trim().length > 0) {
            opts.groups.push(resolveGroupToken(part));
          }
        }
        break;
      }
      case "--baseline": {
        const val = argv[++i];
        if (!val) throw new Error("--baseline requires a file path");
        opts.baselinePath = val;
        break;
      }
      case "--save-baseline": {
        const val = argv[++i];
        if (!val) throw new Error("--save-baseline requires a file path");
        opts.saveBaselinePath = val;
        break;
      }
      case "--dataset": {
        const val = argv[++i];
        if (!val) throw new Error("--dataset requires a file path");
        opts.datasetPath = path.resolve(val);
        break;
      }
      case "--program": {
        const val = argv[++i];
        if (!val) throw new Error("--program requires an executable path");
        opts.program = val;
        break;
      }
      case "--concurrency": {
        const val = Number.parseInt(argv[++i] ?? "", 10);
        if (!Number.isInteger(val) || val < 1 || val > 16) {
          throw new Error("--concurrency must be an integer between 1 and 16");
        }
        opts.concurrency = val;
        break;
      }
      case "--timeout-ms": {
        const val = Number.parseInt(argv[++i] ?? "", 10);
        if (!Number.isInteger(val) || val < 1_000) {
          throw new Error("--timeout-ms must be an integer >= 1000");
        }
        opts.timeoutMs = val;
        break;
      }
      default:
        throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  return opts;
}

function usageText(): string {
  return [
    "Usage: bun run benchmarks/routing-eval.ts [options]",
    "",
    "Options:",
    "  --dry-run                Validate all 45 JSONL rows, seed profiles, candidate cards, and run offline self-checks",
    "  --model <id>             Model id passed to AntigravityDriver (or NEO_EVAL_MODEL env)",
    "  --runs <n>               Number of repeated runs per sample for Pass@1 & Majority@N (default: 1)",
    "  --group <G1..G6>         Filter groups by prefix or full name (comma-separated, e.g. G1,G3)",
    "  --baseline <path>        Compare against saved baseline JSON and block on Critical FP / regressions",
    "  --save-baseline <path>   Save full evaluation JSON report to <path>",
    "  --dataset <path>         Path to JSONL dataset (default: benchmarks/datasets/routing_gold_v1.jsonl)",
    "  --program <path>         Antigravity CLI executable (default: agy)",
    "  --concurrency <n>        Parallel sandbox evaluations in real-LLM mode (default: 4)",
    "  --timeout-ms <n>         Per-case LLM turn timeout in ms (default: 60000)",
    "  --json                   Emit full JSON report to stdout",
    "  -h, --help               Show this help message",
  ].join("\n");
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;

  const runner = async (): Promise<void> => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await worker(items[idx]!, idx);
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(workers);
  return results;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    console.error(`Error: ${errorMessage(err)}\n\n${usageText()}`);
    return 2;
  }

  if (opts.help) {
    console.log(usageText());
    return 0;
  }

  const { cases: allCases, errors } = loadAndValidateDataset(opts.datasetPath, true);
  if (errors.length > 0) {
    console.error(`Dataset validation failed (${errors.length} error(s)):`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    return 1;
  }

  const activeCases =
    opts.groups.length > 0
      ? allCases.filter((c) => opts.groups.includes(c.group))
      : allCases;

  if (activeCases.length === 0) {
    console.error("No cases matched the selected --group filter.");
    return 1;
  }

  let results: CaseEvalResult[];
  if (opts.dryRun) {
    // Run deterministic scoring / attribution / Majority@3 / baseline-diff self-checks first
    runDryRunSelfChecks(allCases);
    results = activeCases.map((tc) => {
      const runs: SingleRunOutcome[] = [];
      for (let r = 0; r < opts.runs; r++) {
        runs.push(runCaseDryRun(tc, r));
      }
      return aggregateCaseRuns(tc, runs);
    });
  } else {
    results = await runWithConcurrency(activeCases, opts.concurrency, async (tc) => {
      const runs: SingleRunOutcome[] = [];
      for (let r = 0; r < opts.runs; r++) {
        runs.push(
          await runCaseRealLlm(tc, r, {
            model: opts.model,
            program: opts.program,
            timeoutMs: opts.timeoutMs,
          }),
        );
      }
      return aggregateCaseRuns(tc, runs);
    });
  }

  const report = computeReport(results, {
    mode: opts.dryRun ? "dry-run" : "real-llm",
    model: opts.dryRun ? "dry-run-oracle" : (opts.model ?? "runtime-default"),
    runsPerCase: opts.runs,
    groupsFilter: opts.groups,
  });

  let diff: BaselineDiff | undefined;
  if (opts.baselinePath !== undefined) {
    const rawBaseline = fs.readFileSync(opts.baselinePath, "utf8");
    const baseline = JSON.parse(rawBaseline) as EvalReport;
    diff = diffAgainstBaseline(report, baseline);
  }

  if (opts.saveBaselinePath !== undefined) {
    fs.mkdirSync(path.dirname(path.resolve(opts.saveBaselinePath)), { recursive: true });
    fs.writeFileSync(opts.saveBaselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (opts.json) {
    console.log(JSON.stringify({ report, ...(diff !== undefined ? { diff } : {}) }, null, 2));
  } else {
    console.log(formatReportText(report, diff));
  }

  const passed = report.allGatesPassed && !(diff?.blocked ?? false);
  return passed ? 0 : 1;
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
