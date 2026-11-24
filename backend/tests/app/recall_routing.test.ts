/**
 * L2 end-to-end integration tests for historical ticket recall v2, pre-routing clarification carry-over,
 * multi-ticket read-only Sidecar, handback circuit-breaker, misrouted-accept recovery, security isolation,
 * cross-surface allowlisting & reply routing, worker isolation, rollout flags, and paginated `tickets` reads.
 *
 * Runs against the real `App`, `Engine`, SQLite `Store`, `Outbox`, `TicketSearchIndex`,
 * `PendingClarification`, `ToolHost`, and `sidecarQueued` over a scripted kernel.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CHAT_SOURCE,
  CLARIFICATION_MAX_TURNS,
  IM_WORDS,
  MISS_LIMIT,
  Protocol,
  SIDECAR,
  SIDECAR_WORDS,
  WEB_SENDER,
  WEB_THREAD,
  allowChatSender,
  cloneSettings,
  loadClarification,
  mainSpecs,
  wordCount,
  workerSpecs,
} from "../../src/app/index.ts";
import {
  formatIso,
  mandateBasisVia,
  type Mandate,
  type Thread,
  type Ticket,
  type Trigger,
} from "../../src/core/index.ts";
import { MockHttpServer, MockResponse, TempDir, type MockRequest } from "../../src/testkit/index.ts";
import { Fixture, Scripted, messages, openIn, started } from "./common.ts";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

interface SeedTicketOptions {
  id: string;
  title: string;
  asked: string;
  digest?: string;
  reportSummary?: string;
  worktreeName?: string;
  artifacts?: string[];
  workspaceFiles?: Record<string, string>;
  createdAt: string;
  updatedAt?: string;
  outcome?: "completed" | "dropped" | "stopped";
  endedBy?: "executor" | "human";
  endedReason?: string;
  surface?: "web" | "wechat";
  senderId?: string;
  threadId?: string;
}

const NOISE_TOPICS: readonly string[] = [
  "PostgreSQL 连接池告警排查",
  "Redis 集群槽位迁移脚本",
  "Kubernetes 节点磁盘扩容",
  "Nginx 反向代理超时调优",
  "GraphQL 网关鉴权中间件",
  "Kafka 消费者积压监控面板",
  "Webpack 构建产物分包瘦身",
  "TypeScript 严格空值检查迁移",
  "Docker 镜像多阶段构建提速",
  "GitLab CI 流水线缓存修复",
  "Elasticsearch 索引分片均衡",
  "Prometheus 指标采集丢点诊断",
  "Grafana 告警模板多语言化",
  "Sentry 错误聚合去重规则",
  "Cloudflare 边缘缓存策略调整",
  "ClickHouse 物化视图延迟分析",
  "RabbitMQ 死信队列重试机制",
  "MinIO 对象存储生命周期清理",
  "Consul 服务发现健康检查",
  "Vault 密钥自动轮转演练",
  "Terraform 生产环境状态锁恢复",
  "Ansible 批量主机补丁分发",
  "Airflow 数据管道依赖重排",
  "Spark 离线汇总作业内存溢出",
  "Flink 实时窗口状态恢复",
  "DuckDB 本地 Parquet 查询基准",
  "SQLite WAL 模式并发写压测",
  "gRPC 流控与背压参数验证",
  "OAuth2 令牌刷新竞态修复",
  "JWT 公钥轮换兼容方案",
  "Stripe 订阅账单对账核验",
  "支付宝回调签名验签排查",
  "发票抬头导出模板字段补齐",
  "季度税务申报底稿核对",
  "供应商采购合同条款比对",
  "差旅报销审批流节点改造",
  "入职培训手册排版修订",
  "年度体检机构报价汇总",
  "会议室预订日历同步故障",
  "企业邮箱退信 SPF 记录配置",
  "客服工单自动分派权重调整",
  "小程序分享海报字体渲染修复",
  "iOS 推送证书续期打包",
  "Android 冷启动耗时火焰图",
  "Flutter 列表滚动掉帧排查",
  "React 表格虚拟滚动重构",
  "Tailwind 暗黑模式主题色板",
  "Playwright 端到端用例去抖",
  "Vitest 覆盖率报告合并上传",
  "OpenAPI 文档自动生成校验",
  "Python 虚拟环境依赖锁定",
  "Rust 异步运行时期望死锁定位",
  "Go 服务内存泄漏 pprof 剖析",
  "Java GC 停顿毛刺根因分析",
  "Linux 内核网络队列调参",
  "TLS 证书自动续签脚本验证",
  "CDN 回源带宽峰值削峰",
  "DNS 灰度切流演练复盘",
  "数据库只读副本延迟告警",
  "消息推送限频熔断阈值校准",
];

/** Directly seed a completed/ended historical ticket + origin trigger + thread subscription + workspace files. */
function seedHistoricalTicket(f: Fixture, opts: SeedTicketOptions): Ticket {
  const surface = opts.surface ?? "web";
  const senderId = opts.senderId ?? (surface === "web" ? WEB_SENDER : "wechat:user-a");
  const threadId = opts.threadId ?? (surface === "web" ? WEB_THREAD : senderId);
  const tKey = `${CHAT_SOURCE}:${threadId}`;
  const originTriggerId = `seed-trig-${opts.id}`;
  const updatedAt = opts.updatedAt ?? opts.createdAt;
  const outcome = opts.outcome ?? "completed";
  const endedBy = opts.endedBy ?? (outcome === "stopped" ? "human" : "executor");
  const reportState = outcome === "dropped" ? "dropped" : "ready";

  const worktreeName = opts.worktreeName ?? `wt-${opts.id}`;
  const directory = path.join(f.app.executionRoot(), worktreeName);
  fs.mkdirSync(directory, { recursive: true });
  if (opts.workspaceFiles !== undefined) {
    for (const [relPath, content] of Object.entries(opts.workspaceFiles)) {
      const fullPath = path.join(directory, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf8");
    }
  }

  const trigger: Trigger = {
    id: originTriggerId,
    source: CHAT_SOURCE,
    threads: [{ source: CHAT_SOURCE, id: threadId }],
    actor: { source: CHAT_SOURCE, id: senderId },
    human: true,
    addressed: "direct",
    at: opts.createdAt,
    text: opts.asked,
    channel: {
      source: CHAT_SOURCE,
      thread: threadId,
      address: { surface, conversation: threadId, sender: senderId },
    },
    meta: {
      kind: "chat",
      messageId: `seed:${opts.id}`,
      originalText: opts.asked,
      surface,
      conversation: threadId,
    },
  };

  const mandate: Mandate = {
    strength: "explicit",
    policyVersion: f.app.policy().version(),
    basis: mandateBasisVia(
      { via: "addressed", addressed: "direct" },
      {
        source: CHAT_SOURCE,
        scope: { kind: "chat", surface, conversation: threadId },
        sender: senderId,
      },
    ),
    actor: { source: CHAT_SOURCE, id: senderId },
    scope: opts.title,
  };

  const ticket: Ticket = {
    id: opts.id,
    title: opts.title,
    decisionId: `seed-dec-${opts.id}`,
    mandate,
    channels: [structuredClone(trigger.channel!)],
    assignments: [
      {
        id: `seed-asgn-${opts.id}`,
        state: "ended",
        createdAt: opts.createdAt,
        startedAt: opts.createdAt,
        endedAt: updatedAt,
        report: {
          state: reportState,
          summary: opts.reportSummary ?? `已完成：${opts.title}`,
          at: updatedAt,
        },
      },
    ],
    inputs: [],
    undelivered: [],
    createdAt: opts.createdAt,
    updatedAt,
    origin: { triggerId: originTriggerId, triggerIds: [originTriggerId] },
    execution: {
      name: worktreeName,
      directory,
      assignment: opts.title,
    },
    ...(opts.digest !== undefined ? { digest: opts.digest } : {}),
    ...(opts.artifacts !== undefined && opts.artifacts.length > 0
      ? { artifacts: [...opts.artifacts] }
      : {}),
    ended: {
      at: updatedAt,
      by: endedBy,
      outcome,
      ...(opts.endedReason !== undefined ? { reason: opts.endedReason } : {}),
    },
  };

  f.app.store.atomic(() => {
    f.app.store.saveTrigger(trigger);
    f.app.store.saveTicket(ticket);
    const existingThread: Thread = f.app.store.thread(tKey) ?? {
      key: tKey,
      ref: { source: CHAT_SOURCE, id: threadId },
      createdAt: opts.createdAt,
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {},
    };
    if (!existingThread.subscriptions.includes(ticket.id)) {
      existingThread.subscriptions.push(ticket.id);
    }
    existingThread.lastAt = updatedAt;
    f.app.store.saveThread(existingThread);
  });

  return ticket;
}

function seedNoiseTicket(f: Fixture, index: number, atMs: number, prefix = "tk-noise"): Ticket {
  const topic = NOISE_TOPICS[index % NOISE_TOPICS.length];
  const ts = formatIso(atMs);
  return seedHistoricalTicket(f, {
    id: `${prefix}-${String(index).padStart(2, "0")}`,
    title: `${topic} #${index + 1}`,
    asked: `请处理第 ${index + 1} 项例行事项：${topic}`,
    digest: `${topic}（已完成验收）`,
    reportSummary: `${topic} 已完成部署与验证。`,
    worktreeName: `noise-task-${index + 1}`,
    createdAt: ts,
    updatedAt: ts,
  });
}

function replies(f: Fixture): string[] {
  return f
    .chat()
    .filter(([source]) => source === "chat-reply")
    .map(([, text]) => text);
}

/** Temporarily override environment variables and unconditionally restore them in `finally`. */
async function withEnv<T>(
  overrides: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(overrides)) {
    saved.set(k, process.env[k]);
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

interface MockWeChatSent {
  toUserId: string;
  text: string;
  raw: Record<string, unknown>;
}

interface MockWeChatBridge {
  server: MockHttpServer;
  sent: MockWeChatSent[];
  close(): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Minimal loopback WeChat HTTP endpoint capturing real `sendmessage` deliveries from `Outbox`. */
async function startMockWeChatBridge(): Promise<MockWeChatBridge> {
  const sent: MockWeChatSent[] = [];
  const encoder = new TextEncoder();
  const server = await MockHttpServer.start(async (request: MockRequest) => {
    if (request.method === "POST" && request.pathname === "/ilink/bot/sendmessage") {
      const body = asRecord(request.json());
      const msg = asRecord(body.msg);
      const items = Array.isArray(msg.item_list) ? msg.item_list : [];
      const first = asRecord(items[0]);
      const textItem = asRecord(first.text_item);
      sent.push({
        toUserId: typeof msg.to_user_id === "string" ? msg.to_user_id : "",
        text: typeof textItem.text === "string" ? textItem.text : "",
        raw: msg,
      });
      return new MockResponse(
        200,
        "application/json",
        encoder.encode(JSON.stringify({ ret: 0, message_id: sent.length })),
        [],
      );
    }
    return new MockResponse(200, "application/json", encoder.encode(JSON.stringify({ ret: 0 })), []);
  });
  return {
    server,
    sent,
    close: () => server.close(),
  };
}

/** Open and start a Fixture wired to a loopback mock WeChat server with 0ms burst delays. */
async function startedWithWeChat(bridge: MockWeChatBridge): Promise<Fixture> {
  const kernels = new Scripted();
  kernels.wechat = Protocol.at(bridge.server.url, `${bridge.server.url}/cdn`, {
    paceMs: 20,
    statusWaitMs: 150,
    quietMs: 0,
    burstCapMs: 500,
    fileWaitMs: 5_000,
    typingCheckMs: 50,
    typingOnMs: 500,
    typingOffMs: 200,
  });
  const f = openIn(new TempDir("recall-wx"), kernels, {
    wechatBurstMs: 0,
    webBurstMs: 0,
  });
  try {
    await f.app.start();
    return f;
  } catch (err) {
    await f.cleanup();
    throw err;
  }
}

/** Bind a WeChat user in Store + Settings so `wechatAccount()`, `allowedSender()`, and `wechatDeliver()` work. */
function bindWeChatUser(f: Fixture, baseUrl: string, userId: string): void {
  f.app.store.set("wechat-account", {
    token: `token-${userId}`,
    accountId: `bot-${userId}`,
    userId,
    baseUrl,
    contextToken: `ctx-${userId}`,
  });
  const settings = cloneSettings(f.app.settings());
  if (allowChatSender(settings, `wechat:${userId}`)) {
    f.app.saveSettings(settings, "internal", "policy");
  }
}

// ---------------------------------------------------------------------------
// L2 End-to-End Integration Test Suite (9 scenarios)
// ---------------------------------------------------------------------------

describe("historical-ticket-recall v2 L2 end-to-end integration", () => {
  test(
    "L2-1: deep history 0-turn candidate recall routes straight to multi-ticket sidecar with 180-char Chinese list and zero worker wakeups",
    async () => {
      const f = await started();
      try {
        const baseMs = Date.parse("2026-10-01T00:00:00.000Z");
        // Seed 60 completed historical tickets in chronological order (index 0 oldest -> 59 newest).
        // Position 35 from newest = index 25 -> `tk-20w`; index 24 -> split sub-ticket `tk-20w-eu`.
        for (let i = 0; i < 60; i++) {
          const ts = formatIso(baseMs + i * 60_000);
          if (i === 25) {
            seedHistoricalTicket(f, {
              id: "tk-20w",
              title: "二十万人民币一年游历五大洲旅居漫游计划",
              asked: "帮我制定一份二十万人民币一年游历五大洲旅居漫游计划并导出PDF",
              digest: "完成二十万人民币一年游历五大洲旅居漫游完整行程、预算分配与各国清单",
              reportSummary:
                "已完成二十万人民币一年游历五大洲旅居漫游计划，涵盖亚洲、欧洲、非洲、美洲、大洋洲五大洲共18个国家。",
              worktreeName: "five-continents-20w-plan",
              artifacts: ["二十万人民币一年游历五大洲旅居漫游计划.pdf"],
              workspaceFiles: {
                "二十万人民币一年游历五大洲旅居漫游计划.pdf":
                  "五大洲旅居漫游计划：日本、泰国、越南、马来西亚、葡萄牙、西班牙、希腊、克罗地亚、意大利、摩洛哥、埃及、南非、墨西哥、秘鲁、哥伦比亚、智利、澳大利亚、新西兰",
              },
              createdAt: ts,
              updatedAt: ts,
            });
          } else if (i === 24) {
            seedHistoricalTicket(f, {
              id: "tk-20w-eu",
              title: "欧洲申根段国家清单与铁路签证节奏",
              asked: "把欧洲申根段的国家清单和铁路衔接整理成单独文档",
              digest: "整理欧洲申根区葡萄牙、西班牙、希腊、克罗地亚、意大利五国签证与铁路衔接",
              reportSummary: "欧洲段涵盖葡萄牙、西班牙、希腊、克罗地亚、意大利五个申根国家。",
              worktreeName: "europe-schengen-segment",
              artifacts: ["欧洲申根段国家清单.md"],
              workspaceFiles: {
                "欧洲申根段国家清单.md": "# 欧洲段国家清单\n- 葡萄牙\n- 西班牙\n- 希腊\n- 克罗地亚\n- 意大利\n",
              },
              createdAt: ts,
              updatedAt: ts,
            });
          } else {
            seedNoiseTicket(f, i, baseMs + i * 60_000);
          }
        }

        const longChineseCountryList =
          "二十万人民币一年游历五大洲旅居漫游计划共涵盖五大洲十八个国家，按大洲分列如下：" +
          "亚洲包含日本、泰国、越南、马来西亚四国，重点体验数字游民友好城市与低成本慢生活节奏；" +
          "欧洲申根板块包含葡萄牙、西班牙、希腊、克罗地亚、意大利五国，串联伊比利亚半岛与地中海沿岸铁路线路；" +
          "非洲包含摩洛哥、埃及、南非三国，兼顾北非文化古城与南非自然海岸线；" +
          "美洲包含墨西哥、秘鲁、哥伦比亚、智利四国，横跨中美与安第斯山脉；" +
          "大洋洲包含澳大利亚与新西兰两国，适合作为收官自驾与深度自然旅居目的地，全程预算可控。";

        // Confirm the reply is >= 180 Chinese characters (clearly > old 100-word IM cap, <= SIDECAR_WORDS = 500).
        expect(wordCount(longChineseCountryList)).toBeGreaterThanOrEqual(180);
        expect(wordCount(longChineseCountryList)).toBeLessThanOrEqual(SIDECAR_WORDS);

        let seenCandidate: Record<string, unknown> | null = null;
        let seenSidecarPacket: Record<string, unknown> | null = null;

        f.script(async (turn) => {
          if (turn.role === "sidecar") {
            seenSidecarPacket = JSON.parse(turn.text) as Record<string, unknown>;
            await turn.call("sidecar_reply", { text: longChineseCountryList });
            return "Sidecar answered.";
          }
          if (turn.role === "orchestrator") {
            for (const msg of messages(turn.text)) {
              if (msg.kind === "candidate") {
                seenCandidate = msg;
                const recalled = msg.recalled_tickets as Record<string, unknown>[];
                const routed = await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "sidecar",
                      trigger_id: msg.trigger_id,
                      ticket_id: recalled[0]!.ticket_id,
                      related_ticket_ids: ["tk-20w-eu"],
                      note: "Read main plan and Europe split deliverable",
                    },
                  ],
                });
                const results = routed.results as Record<string, unknown>[];
                expect(results[0]!.reason).toBe("Dispatched to read-only sidecar for immediate reply");
                return "Routed to multi-ticket sidecar.";
              }
            }
          }
          return "Done.";
        });

        await f.app.receiveWeb("二十万五大洲计划 包含哪些国家？给我一个列表。", []);
        await f.until("sidecar delivered 180-char list", () => replies(f).length === 1);
        await f.settle();

        // Candidate card assertions: 60 total tickets, 12 inline related (without tk-20w),
        // passive channel B directly recalls tk-20w at high confidence with no matched_snippet.
        expect(seenCandidate).not.toBeNull();
        expect(seenCandidate!.tickets_total).toBe(60);
        const related = seenCandidate!.related_tickets as Record<string, unknown>[];
        expect(related.length).toBe(12);
        expect(related.some((item) => item.ticket_id === "tk-20w")).toBe(false);

        const recalled = seenCandidate!.recalled_tickets as Record<string, unknown>[];
        expect(Array.isArray(recalled)).toBe(true);
        expect(recalled.length).toBeGreaterThanOrEqual(1);
        expect(recalled[0]!.ticket_id).toBe("tk-20w");
        expect(seenCandidate!.recall_confidence).toBe("high");
        for (const item of recalled) {
          expect("matched_snippet" in item).toBe(false);
        }

        // Multi-ticket sidecar packet assertions.
        expect(seenSidecarPacket).not.toBeNull();
        const mainTicketCard = seenSidecarPacket!.ticket as Record<string, unknown>;
        expect(mainTicketCard.ticket_id).toBe("tk-20w");
        expect(seenSidecarPacket!.workspace_files).toContain(
          "二十万人民币一年游历五大洲旅居漫游计划.pdf",
        );
        const relatedPackets = seenSidecarPacket!.related_tickets as Record<string, unknown>[];
        expect(Array.isArray(relatedPackets)).toBe(true);
        expect(relatedPackets.length).toBe(1);
        expect((relatedPackets[0]!.ticket as Record<string, unknown>).ticket_id).toBe("tk-20w-eu");
        expect(relatedPackets[0]!.workspace_files).toContain("欧洲申根段国家清单.md");

        // Zero side-effects & exact outbound delivery assertions.
        expect(f.ran("worker").length).toBe(0);
        expect(f.ran("sidecar").length).toBe(1);
        expect(f.tickets().length).toBe(60);
        expect(f.app.store.ticket("tk-20w")!.ended?.outcome).toBe("completed");
        expect(f.app.store.ticket("tk-20w")!.inputs).toEqual([]);
        expect(replies(f)).toEqual([longChineseCountryList]);
      } finally {
        await f.cleanup();
      }
    },
    20_000,
  );

  test(
    "L2-2: candidate miss -> orchestrator_search finds deep historical ticket -> attach resumes worker and auto-collects artifacts on ready",
    async () => {
      const f = await started();
      try {
        const baseMs = Date.parse("2026-10-05T00:00:00.000Z");
        // Put target ticket at oldest position (index 0 of 18 -> outside top-12 related_tickets).
        seedHistoricalTicket(f, {
          id: "tk-nebula",
          title: "星云探针巡检归档",
          asked: "帮我归档星云探针初版巡检规则",
          digest: "初版星云探针巡检归档整理",
          reportSummary: "已完成星云探针初版归档，后续待补齐多集群阈值参数。",
          worktreeName: "nebula-probe-archive",
          artifacts: ["星云探针初版规则.md"],
          workspaceFiles: {
            "星云探针初版规则.md": "# 星云探针初版规则\n待补齐阈值\n",
          },
          createdAt: formatIso(baseMs),
          updatedAt: formatIso(baseMs),
        });
        for (let i = 1; i < 18; i++) {
          seedNoiseTicket(f, i, baseMs + i * 60_000, "tk-bg");
        }

        let seenCandidate: Record<string, unknown> | null = null;
        let searchResult: Record<string, unknown> | null = null;
        let workerEndedClearedDuringRun = false;
        let workerSawResumedPrompt = false;
        let workerSawAttachedTrigger = false;

        f.script(async (turn) => {
          if (turn.role === "orchestrator") {
            for (const msg of messages(turn.text)) {
              if (msg.kind === "candidate") {
                seenCandidate = msg;
                searchResult = await turn.call("orchestrator_search", {
                  query: "星云探针 归档",
                  trigger_id: msg.trigger_id,
                });
                const hits = searchResult.hits as Record<string, unknown>[];
                expect(hits.length).toBeGreaterThanOrEqual(1);
                const targetId = hits[0]!.ticket_id as string;
                const routed = await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "attach",
                      trigger_id: msg.trigger_id,
                      ticket_id: targetId,
                      acknowledgement: "好的，我在原星云探针归档工单里继续补全阈值并产出新交付物。",
                    },
                  ],
                });
                const results = routed.results as Record<string, unknown>[];
                expect(results[0]!.refused).toBeUndefined();
                return "Attached to historical ticket.";
              }
            }
            return "Done.";
          }
          if (turn.role === "worker") {
            const liveTicket = f.app.store.ticket("tk-nebula")!;
            workerEndedClearedDuringRun = liveTicket.ended === undefined;
            workerSawResumedPrompt = turn.text.includes(
              "This ticket ended earlier and the message that follows resumed it under the same mandate.",
            );
            const cards = messages(turn.text);
            workerSawAttachedTrigger = cards.some(
              (c) =>
                typeof c.text === "string" &&
                c.text.includes("上次那个阈值文档帮我补全一下，重新导出一份新版本"),
            );
            // Write both a real deliverable PDF and a boilerplate README (should be ignored by collectArtifacts).
            fs.writeFileSync(path.join(turn.cwd, "星云探针阈值终版报告.pdf"), "PDF_FINAL_V2");
            fs.writeFileSync(path.join(turn.cwd, "README.md"), "# boilerplate\n");
            await turn.call("orchestrator_report", {
              state: "ready",
              summary: "已补齐阈值并生成星云探针阈值终版报告.pdf。",
              direct_reply: "已补全阈值文档，终版报告星云探针阈值终版报告.pdf 已生成。",
            });
            return "Worker ready.";
          }
          return "Done.";
        });

        // Message deliberately uses generic words + reportHead-only term "阈值" so passive candidate recall stays empty.
        await f.app.receiveWeb("上次那个阈值文档帮我补全一下，重新导出一份新版本", []);
        await f.until("resumed ticket finished with direct reply", () => replies(f).length === 2);
        await f.settle();

        // Candidate card did not cover tk-nebula (neither in related_tickets nor recalled_tickets).
        expect(seenCandidate).not.toBeNull();
        const related = seenCandidate!.related_tickets as Record<string, unknown>[];
        expect(related.some((item) => item.ticket_id === "tk-nebula")).toBe(false);
        expect(seenCandidate!.recalled_tickets).toBeUndefined();

        // orchestrator_search returned sanitized metadata with artifacts, matched_fields, and score.
        expect(searchResult).not.toBeNull();
        const hits = searchResult!.hits as Record<string, unknown>[];
        const hit = hits[0]!;
        expect(hit.ticket_id).toBe("tk-nebula");
        expect(hit.artifacts).toEqual(["星云探针初版规则.md"]);
        expect(Array.isArray(hit.matched_fields)).toBe(true);
        expect((hit.matched_fields as string[]).includes("title")).toBe(true);
        expect(typeof hit.score === "number" && (hit.score as number) > 0).toBe(true);
        expect("matched_snippet" in hit).toBe(false);

        // Worker resumed properly with [resumed, trigger] inputs, ended cleared while active,
        // and collectArtifacts persisted new deliverable onto ticket.artifacts on ready.
        expect(workerEndedClearedDuringRun).toBe(true);
        expect(workerSawResumedPrompt).toBe(true);
        expect(workerSawAttachedTrigger).toBe(true);
        expect(f.ran("worker").length).toBe(1);

        const finished = f.app.store.ticket("tk-nebula")!;
        expect(finished.ended?.outcome).toBe("completed");
        const inputKinds = finished.inputs.map((inp) => inp.kind);
        expect(inputKinds).toContain("resumed");
        expect(inputKinds).toContain("trigger");
        expect(finished.artifacts).toContain("星云探针阈值终版报告.pdf");
        expect(finished.artifacts).toContain("星云探针初版规则.md");
        expect(finished.artifacts).not.toContain("README.md");
        expect(f.tickets().length).toBe(18);
      } finally {
        await f.cleanup();
      }
    },
    20_000,
  );

  test(
    "L2-3: hard negatives (twin numeral new task & generic phrasing) yield zero recalled_tickets and leave tk-20w untouched",
    async () => {
      const f = await started();
      try {
        const baseMs = Date.parse("2026-10-10T00:00:00.000Z");
        // Put tk-20w outside top-12 related_tickets so it is actively evaluated by recallForCandidate.
        seedHistoricalTicket(f, {
          id: "tk-20w",
          title: "二十万人民币一年游历五大洲旅居漫游计划",
          asked: "帮我制定二十万人民币一年游历五大洲旅居漫游计划",
          digest: "20万一年五大洲旅居漫游计划与预算指南",
          artifacts: ["二十万人民币一年游历五大洲旅居漫游计划.pdf"],
          createdAt: formatIso(baseMs),
          updatedAt: formatIso(baseMs),
        });
        for (let i = 1; i <= 15; i++) {
          seedNoiseTicket(f, i, baseMs + i * 60_000, "tk-pad");
        }

        const seenCandidates: Record<string, unknown>[] = [];
        let acceptSeq = 0;

        f.script(async (turn) => {
          if (turn.role === "orchestrator") {
            for (const msg of messages(turn.text)) {
              if (msg.kind === "candidate") {
                seenCandidates.push(msg);
                acceptSeq += 1;
                await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "accept",
                      trigger_id: msg.trigger_id,
                      title: acceptSeq === 1 ? "十万半年四大洲穷游计划" : "修改页面按钮样式",
                      worktree_name: acceptSeq === 1 ? "budget-four-continents" : "update-button-style",
                      acknowledgement:
                        acceptSeq === 1 ? "好的，我新开任务制定十万半年四大洲穷游计划。" : "好的，我新建任务修改按钮。",
                    },
                  ],
                });
                return "Accepted as new ticket.";
              }
            }
            return "Done.";
          }
          if (turn.role === "worker") {
            await turn.call("orchestrator_report", {
              state: "ready",
              summary: "独立新工单已完成。",
              direct_reply: "新任务已完成。",
            });
            return "Worker ready.";
          }
          return "Done.";
        });

        await f.app.receiveWeb("帮我新做一个十万人民币半年游历四大洲穷游计划", []);
        await f.until("first new task finished", () => replies(f).length === 2);
        await f.settle();

        await f.app.receiveWeb("修改按钮", []);
        await f.until("second new task finished", () => replies(f).length === 4);
        await f.settle();

        expect(seenCandidates.length).toBe(2);
        // Zero false recall injection on both twin-numeral new-task and generic-word requests.
        expect(seenCandidates[0]!.recalled_tickets).toBeUndefined();
        expect(seenCandidates[0]!.recall_confidence).toBeUndefined();
        expect(seenCandidates[1]!.recalled_tickets).toBeUndefined();
        expect(seenCandidates[1]!.recall_confidence).toBeUndefined();

        // Two brand-new tickets created; tk-20w remained completely untouched.
        expect(f.tickets().length).toBe(18);
        const oldTicket = f.app.store.ticket("tk-20w")!;
        expect(oldTicket.ended?.outcome).toBe("completed");
        expect(oldTicket.assignments.length).toBe(1);
        expect(oldTicket.inputs).toEqual([]);
        expect(f.ran("sidecar").length).toBe(0);
        expect(f.ran("worker").length).toBe(2);
        expect(f.ran("worker").every((r) => r.sessionId !== "worker-tk-20w")).toBe(true);
      } finally {
        await f.cleanup();
      }
    },
    20_000,
  );

  test(
    "L2-4: mis-attach -> handback recovery rejects re-attach (handedBackHere) and trips MISS_LIMIT=3 circuit breaker while preserving sidecar exit",
    async () => {
      const f = await started();
      try {
        const baseMs = Date.parse("2026-10-12T00:00:00.000Z");
        seedHistoricalTicket(f, {
          id: "tk-a",
          title: "历史工单 A：前端样式改造",
          asked: "修改登录页按钮样式",
          createdAt: formatIso(baseMs),
          updatedAt: formatIso(baseMs),
        });
        seedHistoricalTicket(f, {
          id: "tk-b",
          title: "历史工单 B：数据库备份脚本",
          asked: "编写定时备份脚本",
          createdAt: formatIso(baseMs + 60_000),
          updatedAt: formatIso(baseMs + 60_000),
        });
        seedHistoricalTicket(f, {
          id: "tk-c",
          title: "历史工单 C：日志告警配置",
          asked: "配置错误率告警阈值",
          createdAt: formatIso(baseMs + 120_000),
          updatedAt: formatIso(baseMs + 120_000),
        });

        const candidateCards: Record<string, unknown>[] = [];
        let reattachRefusal: string | undefined;

        f.script(async (turn) => {
          if (turn.role === "orchestrator") {
            for (const msg of messages(turn.text)) {
              if (msg.kind === "candidate") {
                candidateCards.push(msg);
                const handedBack = Array.isArray(msg.handed_back)
                  ? (msg.handed_back as Record<string, unknown>[])
                  : [];
                if (handedBack.length === 0) {
                  await turn.call("orchestrator_route", {
                    decisions: [
                      {
                        kind: "attach",
                        trigger_id: msg.trigger_id,
                        ticket_id: "tk-a",
                      },
                    ],
                  });
                } else if (handedBack.length === 1) {
                  // Attempt to re-attach back to tk-a (must be refused with handedBackHere), then mis-attach tk-b.
                  const routed = await turn.call("orchestrator_route", {
                    decisions: [
                      {
                        kind: "attach",
                        trigger_id: msg.trigger_id,
                        ticket_id: "tk-a",
                      },
                      {
                        kind: "attach",
                        trigger_id: msg.trigger_id,
                        ticket_id: "tk-b",
                      },
                    ],
                  });
                  const results = routed.results as Record<string, unknown>[];
                  reattachRefusal = typeof results[0]!.refused === "string" ? results[0]!.refused : undefined;
                  expect(results[1]!.refused).toBeUndefined();
                } else if (handedBack.length === 2) {
                  await turn.call("orchestrator_route", {
                    decisions: [
                      {
                        kind: "attach",
                        trigger_id: msg.trigger_id,
                        ticket_id: "tk-c",
                      },
                    ],
                  });
                } else {
                  // 3 handbacks reached -> accept as brand-new work to break the loop.
                  await turn.call("orchestrator_route", {
                    decisions: [
                      {
                        kind: "accept",
                        trigger_id: msg.trigger_id,
                        title: "年度采购预算表整理",
                        worktree_name: "annual-procurement-budget",
                        acknowledgement: "好的，我新开一个工单来整理年度采购预算表。",
                      },
                    ],
                  });
                }
                return "Candidate handled.";
              }
            }
            return "Done.";
          }

          if (turn.role === "worker") {
            if (
              turn.sessionId === "worker-tk-a" ||
              turn.sessionId === "worker-tk-b" ||
              turn.sessionId === "worker-tk-c"
            ) {
              const attachedTriggerCard = messages(turn.text).find(
                (m) => typeof m.trigger_id === "string" && typeof m.text === "string",
              );
              expect(attachedTriggerCard).toBeDefined();
              const hb = await turn.call("orchestrator_trigger_handback", {
                trigger_id: attachedTriggerCard!.trigger_id,
                reason: `Outside scope of ${turn.sessionId}`,
              });
              expect(hb.queued).toBe(true);
              await turn.call("orchestrator_report", {
                state: "dropped",
                summary: "Handed back",
              });
              return "Handed back.";
            }
            // Fresh accepted ticket completes cleanly.
            await turn.call("orchestrator_report", {
              state: "ready",
              summary: "年度采购预算表已完成。",
              direct_reply: "年度采购预算表已整理完成。",
            });
            return "Fresh ticket ready.";
          }

          return "Done.";
        });

        await f.app.receiveWeb("帮我整理一份全新的年度采购预算表", []);
        await f.until("fresh accepted ticket finished", () => replies(f).length === 2);
        await f.settle();

        expect(candidateCards.length).toBe(4);
        // Handback count grows monotonically across rounds: 0 -> 1 -> 2 -> 3.
        expect(candidateCards[0]!.handed_back).toBeUndefined();
        expect((candidateCards[1]!.handed_back as unknown[]).length).toBe(1);
        expect((candidateCards[2]!.handed_back as unknown[]).length).toBe(2);
        const thirdHandbacks = candidateCards[3]!.handed_back as Record<string, unknown>[];
        expect(thirdHandbacks.length).toBe(MISS_LIMIT);
        expect(thirdHandbacks.map((h) => h.ticket_id)).toEqual(["tk-a", "tk-b", "tk-c"]);

        // Re-attach to already-handed-back ticket was rejected with handedBackHere.
        expect(reattachRefusal).toBe(
          "The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it",
        );

        // Circuit breaker instruction on round 4 forces accept (never attach) while keeping sidecar escape hatch.
        const breakerAction = String(candidateCards[3]!.next_action);
        expect(breakerAction).toContain(`${MISS_LIMIT} handbacks`);
        expect(breakerAction).toContain("kind=accept (never attach)");
        expect(breakerAction).toContain("kind=sidecar");
        expect(candidateCards[3]!.recalled_tickets).toBeUndefined();

        // Loop terminated cleanly with 4 worker turns (A, B, C, fresh) and final reply delivered.
        expect(f.ran("worker").length).toBe(4);
        expect(f.tickets().length).toBe(4);
        expect(replies(f)).toEqual([
          "好的，我新开一个工单来整理年度采购预算表。",
          "年度采购预算表已整理完成。",
        ]);
      } finally {
        await f.cleanup();
      }
    },
    20_000,
  );

  test(
    "L2-5: mis-accept empty ticket recovery locks notReached contract, worker drops [MISROUTED_HISTORY], and sidecar replies without noAnswer",
    async () => {
      const f = await started();
      try {
        const baseMs = Date.parse("2026-10-15T00:00:00.000Z");
        seedHistoricalTicket(f, {
          id: "tk-old",
          title: "二十万人民币一年游历五大洲旅居漫游计划",
          asked: "制定二十万人民币一年游历五大洲旅居漫游计划",
          digest: "已完成五大洲18国旅居漫游计划",
          artifacts: ["二十万人民币一年游历五大洲旅居漫游计划.pdf"],
          workspaceFiles: {
            "二十万人民币一年游历五大洲旅居漫游计划.pdf":
              "包含国家：日本、泰国、葡萄牙、西班牙、希腊、摩洛哥、墨西哥、澳大利亚、新西兰等18国",
          },
          createdAt: formatIso(baseMs),
          updatedAt: formatIso(baseMs),
        });

        let handbackErrorMessage: string | undefined;
        let droppedTicketId: string | undefined;
        let sidecarFailedCount = 0;

        f.script(async (turn) => {
          if (turn.role === "orchestrator") {
            for (const msg of messages(turn.text)) {
              if (msg.kind === "candidate") {
                // Deliberately mis-accept into a fresh empty ticket instead of routing sidecar.
                const routed = await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "accept",
                      trigger_id: msg.trigger_id,
                      title: "查询五大洲计划国家列表",
                      worktree_name: "lookup-continent-countries",
                      acknowledgement: "好的，我先去核查一下。",
                    },
                  ],
                });
                const results = routed.results as Record<string, unknown>[];
                const created = results[0]!.ticket as Record<string, unknown>;
                droppedTicketId = created.ticket_id as string;
                return "Mis-accepted into empty ticket.";
              }
              if (msg.kind === "worker_report" && msg.state === "dropped") {
                expect(String(msg.summary)).toContain("[MISROUTED_HISTORY]");
                const routed = await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "sidecar",
                      trigger_id: msg.trigger_id,
                      ticket_id: "tk-old",
                      note: "Recover misrouted history lookup on tk-old",
                    },
                  ],
                });
                const results = routed.results as Record<string, unknown>[];
                expect(results[0]!.refused).toBeUndefined();
                expect(results[0]!.reason).toBe("Dispatched to read-only sidecar for immediate reply");
                return "Recovered via sidecar.";
              }
              if (msg.kind === "sidecar_failed") {
                sidecarFailedCount += 1;
                return "Unexpected sidecar failure.";
              }
            }
            return "Done.";
          }

          if (turn.role === "worker") {
            const assignment = messages(turn.text)[0]!;
            const originTrigger = assignment.trigger as Record<string, unknown>;
            // Lock domain contract: origin trigger is NOT a trigger Input, so handback MUST throw notReached.
            try {
              await turn.call("orchestrator_trigger_handback", {
                trigger_id: originTrigger.trigger_id,
                reason: "Misrouted history lookup",
              });
            } catch (error) {
              handbackErrorMessage = error instanceof Error ? error.message : String(error);
            }
            // Follow corrected work.md: drop without direct_reply and signal [MISROUTED_HISTORY].
            await turn.call("orchestrator_report", {
              state: "dropped",
              summary:
                "[MISROUTED_HISTORY] 本空单工作区无五大洲计划交付物，用户实为查询历史已完成工单 tk-old，请改用 sidecar 回复。",
            });
            return "Dropped misrouted empty ticket.";
          }

          if (turn.role === "sidecar") {
            const packet = JSON.parse(turn.text) as Record<string, unknown>;
            expect((packet.ticket as Record<string, unknown>).ticket_id).toBe("tk-old");
            const res = await turn.call("sidecar_reply", {
              text: "五大洲计划共包含日本、泰国、葡萄牙、西班牙、希腊、摩洛哥、墨西哥、澳大利亚、新西兰等18个国家。",
            });
            expect(res.sent).toBe(true);
            return "Sidecar delivered recovered answer.";
          }

          return "Done.";
        });

        await f.app.receiveWeb("二十万五大洲计划包含哪些国家？", []);
        await f.until(
          "sidecar delivered final answer after dropped mis-accept",
          () => replies(f).length === 2 && !f.app.effects.pending(SIDECAR),
        );
        await f.settle();

        expect(handbackErrorMessage).toBe("Trigger does not belong to this worker");
        expect(droppedTicketId).toBeDefined();
        expect(f.app.store.ticket(droppedTicketId!)!.ended?.outcome).toBe("dropped");
        expect(sidecarFailedCount).toBe(0);
        expect(f.ran("sidecar").length).toBe(1);
        expect(f.ran("worker").length).toBe(1);
        expect(f.app.store.ticket("tk-old")!.ended?.outcome).toBe("completed");
        expect(replies(f)).toEqual([
          "好的，我先去核查一下。",
          "五大洲计划共包含日本、泰国、葡萄牙、西班牙、希腊、摩洛哥、墨西哥、澳大利亚、新西兰等18个国家。",
        ]);
      } finally {
        await f.cleanup();
      }
    },
    20_000,
  );

  test(
    "L2-6A: ambiguous dual candidates -> kind=clarify -> resetOrchestrator -> reply '1，只列欧洲' losslessly merges T1+T2 into sidecar",
    async () => {
      const f = await started();
      try {
        const baseMs = Date.parse("2026-11-17T00:00:00.000Z");
        // Seed two strongly similar deep-history plans (outside top-12 related_tickets) so both trigger ambiguous recall.
        seedHistoricalTicket(f, {
          id: "tk-10w",
          title: "十万人民币半年游历四大洲旅居国家计划",
          asked: "制定十万人民币半年游历四大洲旅居漫游与国家清单计划",
          digest: "10万半年四大洲旅居计划与涵盖国家清单",
          artifacts: ["十万四大洲旅居国家计划.pdf"],
          workspaceFiles: { "十万四大洲旅居国家计划.pdf": "四大洲10国：日本、泰国、葡萄牙、西班牙、墨西哥等" },
          createdAt: "2026-11-17T10:00:00.000Z",
          updatedAt: "2026-11-17T10:00:00.000Z",
        });
        seedHistoricalTicket(f, {
          id: "tk-20w",
          title: "二十万人民币一年游历五大洲旅居国家计划",
          asked: "制定二十万人民币一年游历五大洲旅居漫游与国家清单计划",
          digest: "20万一年五大洲旅居计划与涵盖国家清单",
          artifacts: ["二十万五大洲旅居国家计划.pdf"],
          workspaceFiles: {
            "二十万五大洲旅居国家计划.pdf": "欧洲段国家：葡萄牙、西班牙、希腊、克罗地亚、意大利",
          },
          createdAt: "2026-11-18T10:00:00.000Z",
          updatedAt: "2026-11-18T10:00:00.000Z",
        });
        // Add 14 newer unrelated tickets so tk-20w and tk-10w sit outside top-12 related_tickets.
        for (let i = 0; i < 14; i++) {
          seedNoiseTicket(f, i, baseMs + (i + 3) * 86_400_000, "tk-rec");
        }

        const clarifyQuestion =
          "你是指哪份大洲计划？回复数字即可：\n1) 11-18 二十万五大洲旅居计划\n2) 11-17 十万四大洲旅居计划\n3) 新开一份计划";

        let turn1Candidate: Record<string, unknown> | null = null;
        let turn2Candidate: Record<string, unknown> | null = null;
        let sidecarPacket: Record<string, unknown> | null = null;

        f.script(async (turn) => {
          if (turn.role === "sidecar") {
            sidecarPacket = JSON.parse(turn.text) as Record<string, unknown>;
            await turn.call("sidecar_reply", {
              text: "二十万五大洲计划的欧洲部分包含：葡萄牙、西班牙、希腊、克罗地亚、意大利五个国家。",
            });
            return "Sidecar answered European subset.";
          }
          if (turn.role === "orchestrator") {
            for (const msg of messages(turn.text)) {
              if (msg.kind === "candidate") {
                if (msg.pending_clarification === undefined) {
                  turn1Candidate = msg;
                  const routed = await turn.call("orchestrator_route", {
                    decisions: [
                      {
                        kind: "clarify",
                        trigger_id: msg.trigger_id,
                        reason: "Two matching continent travel plans exist",
                        question: clarifyQuestion,
                        options: [
                          { key: "1", label: "11-18 二十万五大洲旅居计划", action: "sidecar", ticket_id: "tk-20w" },
                          { key: "2", label: "11-17 十万四大洲旅居计划", action: "sidecar", ticket_id: "tk-10w" },
                          { key: "3", label: "新开一份计划", action: "accept" },
                        ],
                      },
                    ],
                  });
                  const results = routed.results as Record<string, unknown>[];
                  expect(results[0]!.refused).toBeUndefined();
                  return "Clarification sent.";
                }
                turn2Candidate = msg;
                const pending = msg.pending_clarification as Record<string, unknown>;
                const routed = await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "sidecar",
                      trigger_id: msg.trigger_id,
                      ticket_id: "tk-20w",
                      clarification_id: pending.id,
                    },
                  ],
                });
                const results = routed.results as Record<string, unknown>[];
                expect(results[0]!.refused).toBeUndefined();
                return "Routed clarification answer to sidecar.";
              }
            }
          }
          return "Done.";
        });

        // Round 1: ambiguous query triggers clarify.
        const r1 = await f.app.receiveWeb("之前那个大洲计划包含哪些国家？", []);
        await f.until("clarification question sent", () => replies(f).length === 1);
        await f.settle();

        expect(turn1Candidate).not.toBeNull();
        expect(turn1Candidate!.recall_confidence).toBe("ambiguous");
        const recalled = turn1Candidate!.recalled_tickets as Record<string, unknown>[];
        const recalledIds = recalled.map((r) => r.ticket_id);
        expect(recalledIds).toContain("tk-20w");
        expect(recalledIds).toContain("tk-10w");

        // Eval finished immediately (no deadlock), clarification delivered, 0 workers launched.
        expect(f.app.engine.candidate(r1.triggerId)).toBeUndefined();
        expect(f.app.store.thread("chat:web:main")?.evaluating).toBeUndefined();
        expect(replies(f)).toEqual([clarifyQuestion]);
        expect(f.ran("worker").length).toBe(0);

        const storedClar = loadClarification(f.app.store, "chat:web:main");
        expect(storedClar).toBeDefined();
        const savedClarId = storedClar!.id;

        // Wipe main orchestrator session memory (simulating compaction / restart).
        await f.app.resetOrchestrator();
        expect(f.app.chatTranscript()).toEqual([]);

        // Round 2: user replies only "1，只列欧洲".
        const r2 = await f.app.receiveWeb("1，只列欧洲", []);
        await f.until("sidecar answered after reset", () => replies(f).length === 1);
        await f.settle();

        // Candidate card carried pending_clarification AND pinned tk-20w / tk-10w at the top of related_tickets.
        expect(turn2Candidate).not.toBeNull();
        const pendingCard = turn2Candidate!.pending_clarification as Record<string, unknown>;
        expect(pendingCard.id).toBe(savedClarId);
        expect(pendingCard.origin_text).toBe("之前那个大洲计划包含哪些国家？");
        const pinnedRelated = turn2Candidate!.related_tickets as Record<string, unknown>[];
        expect(pinnedRelated.slice(0, 2).map((item) => item.ticket_id)).toEqual(["tk-20w", "tk-10w"]);

        // Sidecar received BOTH T1 original question and T2 follow-up + clarification_context, and kv cleared.
        expect(sidecarPacket).not.toBeNull();
        const packetQuestions = sidecarPacket!.questions as Record<string, unknown>[];
        expect(packetQuestions.length).toBe(2);
        expect(packetQuestions.map((q) => q.trigger_id)).toEqual([r1.triggerId, r2.triggerId]);
        expect(packetQuestions.map((q) => q.text)).toEqual([
          "之前那个大洲计划包含哪些国家？",
          "1，只列欧洲",
        ]);
        const clarCtx = sidecarPacket!.clarification_context as Record<string, unknown>;
        expect(clarCtx).toEqual({
          question: clarifyQuestion,
          answer_trigger_id: r2.triggerId,
        });
        expect(loadClarification(f.app.store, "chat:web:main")).toBeUndefined();
        expect(f.ran("worker").length).toBe(0);
        expect(replies(f)).toEqual([
          "二十万五大洲计划的欧洲部分包含：葡萄牙、西班牙、希腊、克罗地亚、意大利五个国家。",
        ]);
      } finally {
        await f.cleanup();
      }
    },
    20_000,
  );

  test(
    "L2-6B: clarify carry-over on accept & attach, topic-pivot auto-expiry, and hard refusal for >100 words & inferred candidates",
    async () => {
      const f = await started();
      try {
        seedHistoricalTicket(f, {
          id: "tk-20w",
          title: "二十万五大洲旅居计划",
          asked: "制定二十万五大洲旅居计划",
          createdAt: "2026-11-18T10:00:00.000Z",
          updatedAt: "2026-11-18T10:00:00.000Z",
        });

        let phase:
          | "accept_clarify"
          | "accept_resolve"
          | "attach_clarify"
          | "attach_resolve"
          | "pivot_clarify"
          | "pivot_turn1"
          | "pivot_turn2"
          | "pivot_verify"
          | "overlimit_and_inferred" = "accept_clarify";

        let acceptWorkerText = "";
        let acceptedTicketId = "";
        let attachWorkerText = "";
        let pivotVerifyCard: Record<string, unknown> | null = null;
        let overLimitRefusal: string | undefined;
        let inferredRefusal: string | undefined;

        f.script(async (turn) => {
          if (turn.role === "worker") {
            if (turn.sessionId === "worker-tk-20w") {
              attachWorkerText = turn.text;
              await turn.call("orchestrator_report", {
                state: "ready",
                summary: "已在原工单补充欧洲铁路章节。",
                direct_reply: "欧洲铁路章节已补充完成。",
              });
              return "Attach worker ready.";
            }
            acceptWorkerText = turn.text;
            await turn.call("orchestrator_report", {
              state: "ready",
              summary: "新工单已按原需求完成。",
              direct_reply: "新建的对比表已完成。",
            });
            return "Accept worker ready.";
          }

          if (turn.role === "orchestrator") {
            for (const msg of messages(turn.text)) {
              if (msg.kind !== "candidate") continue;

              if (phase === "accept_clarify") {
                await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "clarify",
                      trigger_id: msg.trigger_id,
                      reason: "Clarify existing vs new",
                      question: "请问要延续旧计划还是新开任务？\n1) 二十万五大洲旅居计划\n2) 新开独立任务",
                      options: [
                        { key: "1", label: "二十万五大洲旅居计划", action: "attach", ticket_id: "tk-20w" },
                        { key: "2", label: "新开独立任务", action: "accept" },
                      ],
                    },
                  ],
                });
                return "Clarified for accept.";
              }

              if (phase === "accept_resolve") {
                const pending = msg.pending_clarification as Record<string, unknown>;
                expect(pending).toBeDefined();
                const routed = await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "accept",
                      trigger_id: msg.trigger_id,
                      title: "新建大洲签证行程对比表",
                      worktree_name: "continent-visa-compare",
                      acknowledgement: "好的，我按你刚才的需求新建任务来整理对比表。",
                      clarification_id: pending.id,
                    },
                  ],
                });
                const results = routed.results as Record<string, unknown>[];
                expect(results[0]!.refused).toBeUndefined();
                acceptedTicketId = ((results[0]!.ticket as Record<string, unknown>).ticket_id as string) ?? "";
                return "Accepted with clarification carry-over.";
              }

              if (phase === "attach_clarify") {
                await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "clarify",
                      trigger_id: msg.trigger_id,
                      reason: "Confirm target ticket for attach",
                      question: "确认在二十万五大洲旅居计划里补充吗？\n1) 是的，继续原计划\n2) 新开任务",
                      options: [
                        { key: "1", label: "继续原计划", action: "attach", ticket_id: "tk-20w" },
                        { key: "2", label: "新开任务", action: "accept" },
                      ],
                    },
                  ],
                });
                return "Clarified for attach.";
              }

              if (phase === "attach_resolve") {
                const pending = msg.pending_clarification as Record<string, unknown>;
                expect(pending).toBeDefined();
                const routed = await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "attach",
                      trigger_id: msg.trigger_id,
                      ticket_id: "tk-20w",
                      acknowledgement: "好的，我继续在原五大洲旅居计划里补充欧洲铁路章节。",
                      clarification_id: pending.id,
                    },
                  ],
                });
                const results = routed.results as Record<string, unknown>[];
                expect(results[0]!.refused).toBeUndefined();
                return "Attached with clarification carry-over.";
              }

              if (phase === "pivot_clarify") {
                await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "clarify",
                      trigger_id: msg.trigger_id,
                      reason: "Need target choice",
                      question: "要查看哪份计划？回复 1 或 2。",
                      options: [{ key: "1", label: "二十万五大洲旅居计划", action: "sidecar", ticket_id: "tk-20w" }],
                    },
                  ],
                });
                return "Clarified before topic pivot.";
              }

              if (phase === "pivot_turn1" || phase === "pivot_turn2") {
                await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "ignore",
                      trigger_id: msg.trigger_id,
                      reason: "Unrelated chitchat topic pivot",
                      answer: "好的，收到你的闲聊话题。",
                    },
                  ],
                });
                return "Ignored topic pivot.";
              }

              if (phase === "pivot_verify") {
                pivotVerifyCard = msg;
                // Also verify >100-word clarification question is hard-rejected while explicit ignore succeeds.
                const tooLongQuestion = "请确认你要查询的具体历史工单编号与范围，".repeat(8);
                expect(wordCount(tooLongQuestion)).toBeGreaterThan(IM_WORDS);
                const routed = await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "clarify",
                      trigger_id: msg.trigger_id,
                      reason: "Test word limit rejection",
                      question: tooLongQuestion,
                    },
                    {
                      kind: "ignore",
                      trigger_id: msg.trigger_id,
                      reason: "End verification turn",
                      answer: "明白。",
                    },
                  ],
                });
                const results = routed.results as Record<string, unknown>[];
                overLimitRefusal = typeof results[0]!.refused === "string" ? results[0]!.refused : undefined;
                return "Verified expiry and >100-word refusal.";
              }

              if (phase === "overlimit_and_inferred") {
                expect(msg.strength).toBe("inferred");
                const routed = await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "clarify",
                      trigger_id: msg.trigger_id,
                      reason: "Should be rejected for inferred candidate",
                      question: "Which task do you mean?",
                    },
                    {
                      kind: "ignore",
                      trigger_id: msg.trigger_id,
                      reason: "Close inferred candidate",
                    },
                  ],
                });
                const results = routed.results as Record<string, unknown>[];
                inferredRefusal = typeof results[0]!.refused === "string" ? results[0]!.refused : undefined;
                return "Verified inferred refusal.";
              }
            }
          }
          return "Done.";
        });

        // 1. `accept` with `clarification_id` losslessly carries over original T1 requirement.
        const acceptT1 = await f.app.receiveWeb("帮我整理一份大洲签证与行程对比表，附带预算明细", []);
        await f.until("accept clarify sent", () => replies(f).length === 1);
        await f.settle();

        phase = "accept_resolve";
        await f.app.receiveWeb("2", []);
        await f.until("accepted ticket completed", () => replies(f).length === 3);
        await f.settle();

        expect(acceptedTicketId.length).toBeGreaterThan(0);
        const acceptedTicket = f.app.store.ticket(acceptedTicketId)!;
        expect(
          acceptedTicket.inputs.some(
            (inp) =>
              inp.kind === "trigger" &&
              inp.triggerId === acceptT1.triggerId &&
              inp.note === "Original request carried over from clarification",
          ),
        ).toBe(true);
        expect(acceptWorkerText).toContain("帮我整理一份大洲签证与行程对比表，附带预算明细");
        expect(loadClarification(f.app.store, "chat:web:main")).toBeUndefined();

        // 2. `attach` with `clarification_id` losslessly carries over T1 + T2 into resumed historical ticket.
        phase = "attach_clarify";
        const attachT1 = await f.app.receiveWeb("把大洲计划里的欧洲铁路交通章节补充一下", []);
        await f.until("attach clarify sent", () => replies(f).length === 4);
        await f.settle();

        phase = "attach_resolve";
        const attachT2 = await f.app.receiveWeb("1", []);
        await f.until("attached ticket completed", () => replies(f).length === 6);
        await f.settle();

        const resumedTicket = f.app.store.ticket("tk-20w")!;
        const resumedTriggerIds = resumedTicket.inputs
          .filter((inp) => inp.kind === "trigger")
          .map((inp) => inp.triggerId);
        expect(resumedTriggerIds).toContain(attachT1.triggerId);
        expect(resumedTriggerIds).toContain(attachT2.triggerId);
        expect(attachWorkerText).toContain("把大洲计划里的欧洲铁路交通章节补充一下");
        expect(loadClarification(f.app.store, "chat:web:main")).toBeUndefined();

        // 3. Topic-pivot auto-expiry after CLARIFICATION_MAX_TURNS (2) unconsumed turns (anti-stickiness).
        phase = "pivot_clarify";
        await f.app.receiveWeb("查一下大洲计划", []);
        await f.until("pivot clarify sent", () => replies(f).length === 7);
        await f.settle();
        expect(loadClarification(f.app.store, "chat:web:main")?.turnsSeen).toBe(0);

        phase = "pivot_turn1";
        await f.app.receiveWeb("今天上海天气怎么样？", []);
        await f.until("pivot 1 answered", () => replies(f).length === 8);
        await f.settle();
        expect(loadClarification(f.app.store, "chat:web:main")?.turnsSeen).toBe(1);

        phase = "pivot_turn2";
        await f.app.receiveWeb("再给我讲个程序员笑话", []);
        await f.until("pivot 2 answered", () => replies(f).length === 9);
        await f.settle();
        expect(CLARIFICATION_MAX_TURNS).toBe(2);
        expect(loadClarification(f.app.store, "chat:web:main")).toBeUndefined();

        // Next turn's candidate card has NO pending_clarification, AND >100-word clarify is hard-rejected.
        phase = "pivot_verify";
        await f.app.receiveWeb("你好呀", []);
        await f.until("pivot verify answered", () => replies(f).length === 10);
        await f.settle();
        expect(pivotVerifyCard).not.toBeNull();
        expect(pivotVerifyCard!.pending_clarification).toBeUndefined();
        expect(overLimitRefusal).toBeDefined();
        expect(overLimitRefusal!).toContain(`maximum is ${IM_WORDS}`);

        // 4. `inferred` candidate hard-rejected on kind="clarify".
        const settings = cloneSettings(f.app.settings());
        settings.eval.mode = "auto";
        settings.policy.sources[CHAT_SOURCE].bots = [{ id: "wechat:bot-ci", name: "CI Bot" }];
        f.app.saveSettings(settings, "app", "policy");

        phase = "overlimit_and_inferred";
        const botTrigger: Trigger = {
          id: "trig-bot-inferred-1",
          source: CHAT_SOURCE,
          threads: [{ source: CHAT_SOURCE, id: "web:ci-room" }],
          actor: { source: CHAT_SOURCE, id: "wechat:bot-ci" },
          human: false,
          addressed: "direct",
          at: "2026-11-24T12:30:00.000Z",
          text: "CI build warning on branch main",
          meta: { kind: "chat", surface: "web", conversation: "web:ci-room" },
        };
        f.app.passes.receive(botTrigger);
        await f.until("inferred refusal checked", () => inferredRefusal !== undefined);
        await f.settle();

        expect(inferredRefusal).toBe("clarify is only allowed for explicit human requests");
      } finally {
        await f.cleanup();
      }
    },
    25_000,
  );

  test(
    "L2-7: WeChat rebind security isolation blocks cross-user recall/search/sidecar, and stopped ticket rejects attach while allowing same-user sidecar",
    async () => {
      await withEnv({ NEO_RECALL_CROSS_SURFACE: "1" }, async () => {
        const bridge = await startMockWeChatBridge();
        let f: Fixture | undefined;
        try {
          f = await startedWithWeChat(bridge);
          bindWeChatUser(f, bridge.server.url, "user-a");

          let ticketAId = "";
          let userBCandidate: Record<string, unknown> | null = null;
          let userBSearchResult: Record<string, unknown> | null = null;
          let userBSidecarRefusal: string | undefined;
          let stoppedTicketId = "";
          let stoppedAttachRefusal: string | undefined;
          let stoppedSidecarAnswered = false;
          let mode: "user_a" | "user_b" | "web_stop_setup" | "web_stop_verify" = "user_a";

          f.script(async (turn) => {
            if (turn.role === "worker") {
              if (mode === "user_a") {
                fs.writeFileSync(path.join(turn.cwd, "极密凤凰薪酬审计清单.pdf"), "TOP_SECRET_USER_A_SALARY");
                await turn.call("orchestrator_report", {
                  state: "ready",
                  summary: "已完成用户 A 的极密凤凰薪酬审计清单。",
                  direct_reply: "极密凤凰薪酬审计清单已整理完毕。",
                });
                return "User A worker ready.";
              }
              // Web worker stays active with a background job so human can stop it in progress.
              fs.writeFileSync(path.join(turn.cwd, "stopped_checkpoint.md"), "停单前已完成 60% 进度。");
              turn.jobs.push(Fixture.job("bg_stop", "bash", "sleep 60"));
              await turn.call("orchestrator_report", {
                state: "progress",
                summary: "停单前已完成 60% 进度，保存了 stopped_checkpoint.md。",
                topic: "人工停止前的阶段性调研",
              });
              return "Running progress.";
            }

            if (turn.role === "sidecar") {
              const packet = JSON.parse(turn.text) as Record<string, unknown>;
              expect((packet.ticket as Record<string, unknown>).ticket_id).toBe(stoppedTicketId);
              expect(packet.workspace_files).toContain("stopped_checkpoint.md");
              await turn.call("sidecar_reply", {
                text: "该已停止工单在停止前完成了60%进度，产物目录留有 stopped_checkpoint.md。",
              });
              stoppedSidecarAnswered = true;
              return "Sidecar read stopped ticket.";
            }

            if (turn.role === "orchestrator") {
              for (const msg of messages(turn.text)) {
                if (msg.kind !== "candidate") continue;

                if (mode === "user_a") {
                  const routed = await turn.call("orchestrator_route", {
                    decisions: [
                      {
                        kind: "accept",
                        trigger_id: msg.trigger_id,
                        title: "极密凤凰薪酬审计清单",
                        worktree_name: "phoenix-salary-audit",
                        acknowledgement: "好的，我来整理极密凤凰薪酬审计清单。",
                      },
                    ],
                  });
                  const results = routed.results as Record<string, unknown>[];
                  ticketAId = (results[0]!.ticket as Record<string, unknown>).ticket_id as string;
                  return "Accepted user A ticket.";
                }

                if (mode === "user_b") {
                  userBCandidate = msg;
                  userBSearchResult = await turn.call("orchestrator_search", {
                    query: "极密凤凰薪酬审计",
                    trigger_id: msg.trigger_id,
                  });
                  const routed = await turn.call("orchestrator_route", {
                    decisions: [
                      {
                        kind: "sidecar",
                        trigger_id: msg.trigger_id,
                        ticket_id: ticketAId,
                      },
                      {
                        kind: "ignore",
                        trigger_id: msg.trigger_id,
                        reason: "Unauthorized historical ticket refused",
                        answer: "未找到与您账号关联的相关历史工单。",
                      },
                    ],
                  });
                  const results = routed.results as Record<string, unknown>[];
                  userBSidecarRefusal =
                    typeof results[0]!.refused === "string" ? results[0]!.refused : undefined;
                  return "Verified user B isolation.";
                }

                if (mode === "web_stop_setup") {
                  const routed = await turn.call("orchestrator_route", {
                    decisions: [
                      {
                        kind: "accept",
                        trigger_id: msg.trigger_id,
                        title: "可停止的阶段性调研",
                        worktree_name: "stoppable-research-task",
                        acknowledgement: "好的，我开始执行阶段性调研。",
                      },
                    ],
                  });
                  const results = routed.results as Record<string, unknown>[];
                  stoppedTicketId = (results[0]!.ticket as Record<string, unknown>).ticket_id as string;
                  return "Accepted stoppable ticket.";
                }

                if (mode === "web_stop_verify") {
                  const routed = await turn.call("orchestrator_route", {
                    decisions: [
                      {
                        kind: "attach",
                        trigger_id: msg.trigger_id,
                        ticket_id: stoppedTicketId,
                      },
                      {
                        kind: "sidecar",
                        trigger_id: msg.trigger_id,
                        ticket_id: stoppedTicketId,
                      },
                    ],
                  });
                  const results = routed.results as Record<string, unknown>[];
                  stoppedAttachRefusal =
                    typeof results[0]!.refused === "string" ? results[0]!.refused : undefined;
                  expect(results[1]!.refused).toBeUndefined();
                  return "Verified stopped attach refusal and sidecar allowance.";
                }
              }
            }
            return "Done.";
          });

          // 1. User A creates and completes a secret ticket over WeChat.
          await f.app.receiveWeChat("wx-a-1", "user-a", "帮我整理极密凤凰薪酬审计清单", []);
          await f.until(
            "user A ticket completed",
            () => ticketAId.length > 0 && f!.app.store.ticket(ticketAId)?.ended?.outcome === "completed",
          );
          await f.settle();
          expect(f.app.store.ticket(ticketAId)!.artifacts).toContain("极密凤凰薪酬审计清单.pdf");

          // 2. Unbind user A and bind user B.
          await f.app.wechatDisconnect();
          bindWeChatUser(f, bridge.server.url, "user-b");

          // 3. User B sends identical keywords with NEO_RECALL_CROSS_SURFACE=1 enabled.
          mode = "user_b";
          await f.app.receiveWeChat("wx-b-1", "user-b", "极密凤凰薪酬审计清单里写了什么？", []);
          await f.until("user B refused and answered", () => userBSidecarRefusal !== undefined);
          await f.settle();

          expect(userBCandidate).not.toBeNull();
          expect(userBCandidate!.related_tickets).toEqual([]);
          expect(userBCandidate!.recalled_tickets).toBeUndefined();
          expect(userBCandidate!.other_thread_tickets).toBeUndefined();

          expect(userBSearchResult).not.toBeNull();
          expect(userBSearchResult!.hits).toEqual([]);
          expect(userBSearchResult!.total).toBe(0);

          expect(userBSidecarRefusal).toBeDefined();
          expect(userBSidecarRefusal!).toContain("not accessible");
          expect(f.ran("sidecar").length).toBe(0);

          // 4. Stopped ticket contract (same user): attach rejected with ticketStopped, read-only sidecar allowed.
          mode = "web_stop_setup";
          await f.app.receiveWeb("帮我做一份阶段性调研", []);
          await f.until(
            "stoppable worker reported progress",
            () =>
              stoppedTicketId.length > 0 &&
              f!.app.store.ticket(stoppedTicketId)?.assignments[0]?.report?.state === "progress",
          );
          await f.settle();

          await f.app.stopWorkerTicket(stoppedTicketId);
          expect(f.app.store.ticket(stoppedTicketId)!.ended?.outcome).toBe("stopped");

          mode = "web_stop_verify";
          await f.app.receiveWeb("刚才那个停止的调研做到哪一步了？", []);
          await f.until("sidecar answered stopped ticket", () => stoppedSidecarAnswered);
          await f.settle();

          expect(stoppedAttachRefusal).toBe(
            "A person stopped this ticket; new work needs an accept through orchestrator_route",
          );
          expect(f.ran("sidecar").length).toBe(1);
          expect(replies(f)).toContain(
            "该已停止工单在停止前完成了60%进度，产物目录留有 stopped_checkpoint.md。",
          );
        } finally {
          try {
            await f?.cleanup();
          } finally {
            await bridge.close();
          }
        }
      });
    },
    25_000,
  );

  test(
    "L2-8: Web -> WeChat strict 1-to-1 cross-surface recall populates other_thread_tickets and routes cross-surface attach ready result back to WeChat",
    async () => {
      await withEnv({ NEO_RECALL_CROSS_SURFACE: "1" }, async () => {
        const bridge = await startMockWeChatBridge();
        let f: Fixture | undefined;
        try {
          f = await startedWithWeChat(bridge);
          // Strict 1-to-1 pair: web:local (default) + single bound wechat:user-wx-1.
          bindWeChatUser(f, bridge.server.url, "user-wx-1");

          let webTicketId = "";
          let wxCandidate: Record<string, unknown> | null = null;
          let workerRunCount = 0;

          f.script(async (turn) => {
            if (turn.role === "worker") {
              workerRunCount += 1;
              if (workerRunCount === 1) {
                fs.writeFileSync(
                  path.join(turn.cwd, "量子跃迁跨境物流清关方案.pdf"),
                  "初版跨境清关方案",
                );
                await turn.call("orchestrator_report", {
                  state: "ready",
                  summary: "量子跃迁跨境物流清关方案已完成。",
                  topic: "量子跃迁跨境物流清关与保税仓路由方案",
                  direct_reply: "量子跃迁跨境物流清关方案已生成。",
                });
                return "Web worker completed.";
              }
              // Resumed via WeChat cross-surface attach: report ready WITHOUT reply_to_trigger_id!
              fs.writeFileSync(path.join(turn.cwd, "保税仓清关补充细则.md"), "# 保税仓清关细则\n");
              await turn.call("orchestrator_report", {
                state: "ready",
                summary: "已补充保税仓清关细则。",
                direct_reply: "保税仓清关细则已补充完成并同步。",
              });
              return "Cross-surface resumed worker completed.";
            }

            if (turn.role === "orchestrator") {
              for (const msg of messages(turn.text)) {
                if (msg.kind !== "candidate") continue;

                if (msg.thread === "chat:web:main") {
                  const routed = await turn.call("orchestrator_route", {
                    decisions: [
                      {
                        kind: "accept",
                        trigger_id: msg.trigger_id,
                        title: "量子跃迁跨境物流清关方案",
                        worktree_name: "quantum-crossborder-customs",
                        acknowledgement: "好的，我来制定量子跃迁跨境物流清关方案。",
                      },
                    ],
                  });
                  const results = routed.results as Record<string, unknown>[];
                  webTicketId = (results[0]!.ticket as Record<string, unknown>).ticket_id as string;
                  return "Accepted web ticket.";
                }

                if (msg.thread === "chat:wechat:user-wx-1") {
                  wxCandidate = msg;
                  const otherThread = msg.other_thread_tickets as Record<string, unknown>[];
                  expect(Array.isArray(otherThread)).toBe(true);
                  expect(otherThread.length).toBeGreaterThanOrEqual(1);
                  const routed = await turn.call("orchestrator_route", {
                    decisions: [
                      {
                        kind: "attach",
                        trigger_id: msg.trigger_id,
                        ticket_id: otherThread[0]!.ticket_id,
                        acknowledgement: "好的，我继续在量子跃迁跨境清关工单里补充保税仓部分。",
                      },
                    ],
                  });
                  const results = routed.results as Record<string, unknown>[];
                  expect(results[0]!.refused).toBeUndefined();
                  return "Attached WeChat follow-up to Web ticket.";
                }
              }
            }
            return "Done.";
          });

          // 1. Create and complete ticket on Web surface.
          await f.app.receiveWeb("帮我制定一份量子跃迁跨境物流清关方案并导出文档", []);
          await f.until(
            "web ticket completed",
            () => webTicketId.length > 0 && f!.app.store.ticket(webTicketId)?.ended?.outcome === "completed",
          );
          await f.settle();
          expect(bridge.sent.length).toBe(0);

          // 2. Send high-specificity follow-up on WeChat surface.
          await f.app.receiveWeChat(
            "wx-cross-1",
            "user-wx-1",
            "帮我把量子跃迁跨境物流清关方案的保税仓路由补一下",
            [],
          );
          await f.until(
            "wechat received both ack and ready result",
            () => bridge.sent.length >= 2,
          );
          await f.settle();

          // Candidate card invariant: cross-surface hit lives in other_thread_tickets,
          // NEVER breaking `related_tickets.length <= tickets_total`.
          expect(wxCandidate).not.toBeNull();
          expect(wxCandidate!.tickets_total).toBe(0);
          const wxRelated = wxCandidate!.related_tickets as Record<string, unknown>[];
          expect(wxRelated.length).toBe(0);
          expect(wxRelated.length).toBeLessThanOrEqual(wxCandidate!.tickets_total as number);

          const otherThread = wxCandidate!.other_thread_tickets as Record<string, unknown>[];
          expect(otherThread.length).toBeGreaterThanOrEqual(1);
          expect(otherThread[0]!.ticket_id).toBe(webTicketId);
          expect(otherThread[0]!.source_thread).toBe("chat:web:main");

          // Both acknowledgement AND final ready result (without reply_to_trigger_id) routed precisely to WeChat!
          expect(bridge.sent.map((m) => [m.toUserId, m.text])).toEqual([
            ["user-wx-1", "好的，我继续在量子跃迁跨境清关工单里补充保税仓部分。"],
            ["user-wx-1", "保税仓清关细则已补充完成并同步。"],
          ]);

          // Verify ticket completed and collected the new artifact.
          const updated = f.app.store.ticket(webTicketId)!;
          expect(updated.ended?.outcome).toBe("completed");
          expect(updated.artifacts).toContain("保税仓清关补充细则.md");

          // 3. Strict 1-to-1 allowlist guard: adding a 2nd WeChat sender breaks 1-to-1 pairing,
          // so a new Web ticket is NOT exposed cross-surface to WeChat even with NEO_RECALL_CROSS_SURFACE=1.
          seedHistoricalTicket(f, {
            id: "tk-web-extra",
            title: "火星轨道卫星遥测校准方案",
            asked: "帮我制定火星轨道卫星遥测校准方案",
            digest: "火星轨道卫星遥测校准与深空链路参数",
            artifacts: ["火星轨道卫星遥测校准方案.pdf"],
            createdAt: "2026-11-24T15:00:00.000Z",
            updatedAt: "2026-11-24T15:00:00.000Z",
          });
          const multiSettings = cloneSettings(f.app.settings());
          allowChatSender(multiSettings, "wechat:user-wx-2");
          f.app.saveSettings(multiSettings, "internal", "policy");

          let multiWxCandidate: Record<string, unknown> | null = null;
          f.script(async (turn) => {
            if (turn.role === "orchestrator") {
              for (const msg of messages(turn.text)) {
                if (msg.kind === "candidate") {
                  multiWxCandidate = msg;
                  await turn.call("orchestrator_route", {
                    decisions: [
                      {
                        kind: "ignore",
                        trigger_id: msg.trigger_id,
                        reason: "Check strict 1-to-1 guard",
                        answer: "已核验多账号隔离。",
                      },
                    ],
                  });
                  return "Checked.";
                }
              }
            }
            return "Done.";
          });

          await f.app.receiveWeChat("wx-cross-2", "user-wx-1", "火星轨道卫星遥测校准方案的深空链路参数", []);
          await f.until("strict 1-to-1 guard verified", () => multiWxCandidate !== null);
          await f.settle();
          expect(multiWxCandidate!.other_thread_tickets).toBeUndefined();
        } finally {
          try {
            await f?.cleanup();
          } finally {
            await bridge.close();
          }
        }
      });
    },
    25_000,
  );

  test(
    "L2-9: worker isolation boundary, env rollout switches (CANDIDATE_RELEVANCE=0 / SEARCH_TOOL=0), and orchestrator_read('tickets') pagination total contract",
    async () => {
      const f = await started();
      try {
        // 1. Static worker tool spec boundary.
        expect(workerSpecs().some((spec) => spec.name === "orchestrator_search")).toBe(false);
        expect(mainSpecs().some((spec) => spec.name === "orchestrator_search")).toBe(true);

        // Seed 60 completed tickets (with tk-20w at rank 35 = index 25) to test pagination AND rollout flags.
        const baseMs = Date.parse("2026-09-01T00:00:00.000Z");
        for (let i = 0; i < 60; i++) {
          const ts = formatIso(baseMs + i * 60_000);
          if (i === 25) {
            seedHistoricalTicket(f, {
              id: "tk-20w",
              title: "二十万人民币一年游历五大洲旅居漫游计划",
              asked: "制定二十万人民币一年游历五大洲旅居漫游计划",
              digest: "五大洲18国完整旅居漫游指南",
              artifacts: ["二十万人民币一年游历五大洲旅居漫游计划.pdf"],
              createdAt: ts,
              updatedAt: ts,
            });
          } else {
            seedNoiseTicket(f, i, baseMs + i * 60_000, "tk-pg");
          }
        }

        let page0: Record<string, unknown> | null = null;
        let page1: Record<string, unknown> | null = null;
        let page2: Record<string, unknown> | null = null;
        let candidateWithFlagOff: Record<string, unknown> | null = null;
        let orchToolNamesWithSearchOff: string[] = [];
        let orchSearchDisabledError: string | undefined;
        let workerToolNames: string[] = [];
        let workerSearchError: string | undefined;
        let workerReadTicketsError: string | undefined;

        let stage: "pagination" | "flags_off" | "worker_isolation" = "pagination";

        f.script(async (turn) => {
          if (turn.role === "worker") {
            workerToolNames = turn.toolNames();
            try {
              await turn.call("orchestrator_search", { query: "二十万" });
            } catch (error) {
              workerSearchError = error instanceof Error ? error.message : String(error);
            }
            try {
              await turn.call("orchestrator_read", { resource: "tickets" });
            } catch (error) {
              workerReadTicketsError = error instanceof Error ? error.message : String(error);
            }
            await turn.call("orchestrator_report", {
              state: "ready",
              summary: "Worker isolation verified.",
              direct_reply: "隔离边界校验完成。",
            });
            return "Worker done.";
          }

          if (turn.role === "orchestrator") {
            for (const msg of messages(turn.text)) {
              if (msg.kind !== "candidate") continue;

              if (stage === "pagination") {
                page0 = await turn.call("orchestrator_read", {
                  resource: "tickets",
                  offset: 0,
                  limit: 20,
                });
                page1 = await turn.call("orchestrator_read", {
                  resource: "tickets",
                  offset: 20,
                  limit: 20,
                });
                page2 = await turn.call("orchestrator_read", {
                  resource: "tickets",
                  offset: 40,
                  limit: 20,
                });
                await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "ignore",
                      trigger_id: msg.trigger_id,
                      reason: "Pagination check complete",
                      answer: "分页检查完成。",
                    },
                  ],
                });
                return "Pagination checked.";
              }

              if (stage === "flags_off") {
                candidateWithFlagOff = msg;
                orchToolNamesWithSearchOff = turn.toolNames();
                try {
                  await turn.call("orchestrator_search", { query: "二十万五大洲" });
                } catch (error) {
                  orchSearchDisabledError = error instanceof Error ? error.message : String(error);
                }
                await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "ignore",
                      trigger_id: msg.trigger_id,
                      reason: "Flag check complete",
                      answer: "开关检查完成。",
                    },
                  ],
                });
                return "Flags checked.";
              }

              if (stage === "worker_isolation") {
                await turn.call("orchestrator_route", {
                  decisions: [
                    {
                      kind: "accept",
                      trigger_id: msg.trigger_id,
                      title: "验证 Worker 工具隔离边界",
                      worktree_name: "verify-worker-isolation",
                      acknowledgement: "好的，启动 Worker 验证隔离边界。",
                    },
                  ],
                });
                return "Accepted worker isolation check.";
              }
            }
          }
          return "Done.";
        });

        // 2. Verify orchestrator_read("tickets") pagination + total: 60 + updated/asked/artifacts + final next_offset: null.
        await f.app.receiveWeb("帮我查看历史工单分页", []);
        await f.until("pagination checked", () => page2 !== null && replies(f).length === 1);
        await f.settle();

        const items0 = page0!.items as Record<string, unknown>[];
        const items1 = page1!.items as Record<string, unknown>[];
        const items2 = page2!.items as Record<string, unknown>[];
        expect([items0.length, page0!.total, page0!.next_offset]).toEqual([20, 60, 20]);
        expect([items1.length, page1!.total, page1!.next_offset]).toEqual([20, 60, 40]);
        expect([items2.length, page2!.total, page2!.next_offset]).toEqual([20, 60, null]);

        for (const card of items0) {
          expect(typeof card.updated).toBe("string");
          expect(typeof card.asked).toBe("string");
        }
        const tk20wCard = [...items0, ...items1, ...items2].find((c) => c.ticket_id === "tk-20w");
        expect(tk20wCard).toBeDefined();
        expect(typeof tk20wCard!.updated).toBe("string");
        expect(tk20wCard!.asked).toBe("制定二十万人民币一年游历五大洲旅居漫游计划");
        expect(tk20wCard!.artifacts).toEqual(["二十万人民币一年游历五大洲旅居漫游计划.pdf"]);

        // 3. Verify env rollout switches immediately disable Channel B and hide orchestrator_search (restored in finally).
        stage = "flags_off";
        await withEnv(
          {
            NEO_RECALL_CANDIDATE_RELEVANCE: "0",
            NEO_RECALL_SEARCH_TOOL: "0",
          },
          async () => {
            expect(mainSpecs().some((spec) => spec.name === "orchestrator_search")).toBe(false);
            await f.app.receiveWeb("二十万五大洲计划 包含哪些国家？给我一个列表。", []);
            await f.until("flags_off checked", () => candidateWithFlagOff !== null && replies(f).length === 2);
            await f.settle();

            expect(candidateWithFlagOff!.recalled_tickets).toBeUndefined();
            expect(candidateWithFlagOff!.recall_confidence).toBeUndefined();
            expect(orchToolNamesWithSearchOff).not.toContain("orchestrator_search");
            expect(orchSearchDisabledError).toBe("orchestrator_search is disabled by configuration");
          },
        );
        // After withEnv restores env, orchestrator_search is immediately exposed again.
        expect(mainSpecs().some((spec) => spec.name === "orchestrator_search")).toBe(true);

        // 4. Verify runtime Worker tool isolation (orchestrator_search -> Unknown tool; read tickets -> main Session only).
        stage = "worker_isolation";
        await f.app.receiveWeb("帮我运行一次隔离测试任务", []);
        await f.until("worker isolation completed", () => replies(f).length === 4);
        await f.settle();

        expect(workerToolNames).not.toContain("orchestrator_search");
        expect(workerSearchError).toBe("Unknown tool orchestrator_search");
        expect(workerReadTicketsError).toBe("This resource belongs to the main Session");
      } finally {
        await f.cleanup();
      }
    },
    25_000,
  );
});
