/**
 * Unit and integration tests for pre-routing clarification state (`clarification.ts`),
 * strict thread/cross-surface access control & artifact recording (`access.ts`),
 * and multi-ticket / authorized / 500-word Sidecar execution (`sidecar.ts`).
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  accessibleThreads,
  canAccessTicket,
  recordTicketArtifact,
  ticketThreads,
} from "../../src/app/access.ts";
import {
  CLARIFICATION_MAX_TURNS,
  CLARIFICATION_TTL_MS,
  bumpClarificationTurn,
  clarificationKey,
  clearClarification,
  consumeClarification,
  isShortConfirmation,
  loadClarification,
  saveClarification,
  type PendingClarification,
} from "../../src/app/clarification.ts";
import {
  CHAT_SOURCE,
  WEB_SENDER,
  WEB_THREAD,
  allowChatSender,
  cloneSettings,
  disallowChatSender,
  wordCount,
} from "../../src/app/index.ts";
import {
  RELATED_REPORT_EXCERPT_CHARS,
  SIDECAR_WORDS,
  fallbackReply,
  sidecarQueued,
} from "../../src/app/sidecar.ts";
import { formatIso, latestReport, type Ticket, type Trigger } from "../../src/core/index.ts";
import { Store } from "../../src/store/index.ts";
import { Fixture, messages, started } from "./common.ts";

function sampleClarification(
  threadKey = "chat:wechat:user-a",
  nowMs = Date.parse("2026-11-24T12:00:00.000Z"),
  overrides: Partial<PendingClarification> = {},
): PendingClarification {
  return {
    id: "clar-1",
    threadKey,
    originTriggerId: "trig-origin-1",
    originBatchIds: ["trig-origin-1", "trig-origin-2"],
    originText: "二十万五大洲计划包含哪些国家？",
    question: "你是指哪份计划？回数字就行：\n1) 11-18 二十万五大洲慢游计划\n2) 11-17 十万四大洲计划\n3) 新开任务",
    options: [
      { key: "1", label: "11-18 二十万五大洲慢游计划", action: "sidecar", ticketId: "tkt-20w" },
      { key: "2", label: "11-17 十万四大洲计划", action: "sidecar", ticketId: "tkt-10w" },
      { key: "3", label: "新开任务", action: "accept" },
    ],
    createdAt: formatIso(nowMs),
    expiresAt: formatIso(nowMs + CLARIFICATION_TTL_MS),
    turnsSeen: 0,
    ...overrides,
  };
}

function bindWeChatUser(f: Fixture, userId: string): void {
  f.app.store.set("wechat-account", {
    token: `tok-${userId}`,
    accountId: `bot-${userId}`,
    userId,
    baseUrl: "https://ilinkai.weixin.qq.com",
  });
  const settings = cloneSettings(f.app.settings());
  if (allowChatSender(settings, `wechat:${userId}`)) {
    f.app.saveSettings(settings, "internal", "policy");
  }
}

async function unbindWeChatUser(f: Fixture): Promise<void> {
  await f.app.wechatDisconnect();
}

function makeSyntheticTrigger(overrides: Partial<Trigger>): Trigger {
  return {
    id: "trig-synthetic",
    source: CHAT_SOURCE,
    threads: [{ source: CHAT_SOURCE, id: WEB_THREAD }],
    actor: { source: CHAT_SOURCE, id: WEB_SENDER },
    human: true,
    addressed: "direct",
    at: "2026-11-24T12:00:00.000Z",
    text: "查一下计划",
    channel: {
      source: CHAT_SOURCE,
      thread: WEB_THREAD,
      address: { surface: "web", conversation: WEB_THREAD, sender: WEB_SENDER },
    },
    meta: { kind: "chat" },
    ...overrides,
  };
}

function replies(f: Fixture): string[] {
  return f
    .chat()
    .filter(([source]) => source === "chat-reply")
    .map(([, text]) => text);
}

describe("clarification state machine", () => {
  test("saves, loads, consumes with matching id, ignores wrong id, and clears", () => {
    const store = Store.memory();
    try {
      const baseMs = Date.parse("2026-11-24T12:00:00.000Z");
      const thread = "chat:wechat:user-a";
      const record = sampleClarification(thread, baseMs);

      expect(clarificationKey(thread)).toBe("clarification:chat:wechat:user-a");
      expect(loadClarification(store, thread, baseMs)).toBeUndefined();

      saveClarification(store, record);
      const loaded = loadClarification(store, thread, baseMs + 1000);
      expect(loaded).toEqual(record);

      // Wrong clarificationId must NOT consume or delete the valid pending clarification.
      expect(consumeClarification(store, thread, "wrong-id", baseMs + 2000)).toBeUndefined();
      expect(loadClarification(store, thread, baseMs + 2000)).toEqual(record);

      // Matching clarificationId consumes and removes it.
      const consumed = consumeClarification(store, thread, record.id, baseMs + 3000);
      expect(consumed).toEqual(record);
      expect(loadClarification(store, thread, baseMs + 3000)).toBeUndefined();
      expect(store.get(clarificationKey(thread))).toBeUndefined();

      // clearClarification explicitly deletes stored state.
      saveClarification(store, record);
      expect(loadClarification(store, thread, baseMs)).toEqual(record);
      clearClarification(store, thread);
      expect(store.get(clarificationKey(thread))).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("auto-expires and deletes clarification after 30-minute TTL", () => {
    const store = Store.memory();
    try {
      const baseMs = Date.parse("2026-11-24T12:00:00.000Z");
      const thread = "chat:web:main";
      const record = sampleClarification(thread, baseMs);
      saveClarification(store, record);

      expect(CLARIFICATION_TTL_MS).toBe(30 * 60 * 1000);
      // 1 ms before expiry is still valid.
      expect(loadClarification(store, thread, baseMs + CLARIFICATION_TTL_MS - 1)).toEqual(record);
      // At exact expiry boundary it is auto-deleted and returns undefined.
      expect(loadClarification(store, thread, baseMs + CLARIFICATION_TTL_MS)).toBeUndefined();
      expect(store.get(clarificationKey(thread))).toBeUndefined();

      // consumeClarification also refuses expired records and cleans them up.
      saveClarification(store, record);
      expect(
        consumeClarification(store, thread, record.id, baseMs + CLARIFICATION_TTL_MS + 60_000),
      ).toBeUndefined();
      expect(store.get(clarificationKey(thread))).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("auto-invalidates and deletes clarification when turnsSeen reaches CLARIFICATION_MAX_TURNS", () => {
    const store = Store.memory();
    try {
      const baseMs = Date.parse("2026-11-24T12:00:00.000Z");
      const thread = "chat:wechat:user-a";
      const record = sampleClarification(thread, baseMs, { turnsSeen: 0 });
      saveClarification(store, record);

      expect(CLARIFICATION_MAX_TURNS).toBe(2);

      // Turn 1: increments to 1, stays valid.
      bumpClarificationTurn(store, thread, baseMs + 1000);
      const afterFirst = loadClarification(store, thread, baseMs + 1000);
      expect(afterFirst?.turnsSeen).toBe(1);

      // Turn 2: reaches CLARIFICATION_MAX_TURNS (2), deleted immediately.
      bumpClarificationTurn(store, thread, baseMs + 2000);
      expect(loadClarification(store, thread, baseMs + 2000)).toBeUndefined();
      expect(store.get(clarificationKey(thread))).toBeUndefined();

      // Directly persisted record with turnsSeen >= 2 is cleaned up on load.
      saveClarification(store, sampleClarification(thread, baseMs, { turnsSeen: 2 }));
      expect(loadClarification(store, thread, baseMs + 1000)).toBeUndefined();
      expect(store.get(clarificationKey(thread))).toBeUndefined();

      // Malformed KV entry is also auto-cleaned.
      store.set(clarificationKey(thread), { broken: true });
      expect(loadClarification(store, thread, baseMs + 1000)).toBeUndefined();
      expect(store.get(clarificationKey(thread))).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("isShortConfirmation distinguishes short confirmations/selections from new requests", () => {
    // Positive cases
    expect(isShortConfirmation("1")).toBe(true);
    expect(isShortConfirmation("  2  ")).toBe(true);
    expect(isShortConfirmation("3")).toBe(true);
    expect(isShortConfirmation("4")).toBe(true);
    expect(isShortConfirmation("1，只列欧洲国家和预算明细")).toBe(true);
    expect(isShortConfirmation("第一个，只要东南亚国家列表")).toBe(true);
    expect(isShortConfirmation("第2份方案，补充一下签证要求")).toBe(true);
    expect(isShortConfirmation("是的，帮我查一下那份总表")).toBe(true);
    expect(isShortConfirmation("好的，直接按旧稿继续修改")).toBe(true);
    expect(isShortConfirmation("对，就是上周生成的那份报告")).toBe(true);
    expect(isShortConfirmation("嗯，把欧洲部分发给我看下")).toBe(true);
    expect(isShortConfirmation("就它，不需要新开任务了")).toBe(true);
    expect(isShortConfirmation("那个二十万五大洲漫游计划")).toBe(true);
    expect(isShortConfirmation("新开一个完全不同的日本滑雪计划")).toBe(true);
    expect(isShortConfirmation("新建任务，不要修改原来的文件")).toBe(true);
    expect(isShortConfirmation("ok")).toBe(true);
    expect(isShortConfirmation("选A就行")).toBe(true);

    // Negative cases
    expect(isShortConfirmation("")).toBe(false);
    expect(isShortConfirmation("   \n\t  ")).toBe(false);
    expect(isShortConfirmation("帮我重新写一份全新的季度财务分析报告")).toBe(false);
    expect(isShortConfirmation("请设计一个支持导出PDF的日程提醒工具")).toBe(false);
    expect(isShortConfirmation("Can you build a new web dashboard for metrics?")).toBe(false);
    expect(isShortConfirmation("今天北京天气怎么样适合出门吗")).toBe(false);
  });
});

describe("access control and artifact recording", () => {
  test("blocks unbound predecessor WeChat user tickets from newly bound user even with cross-surface enabled", async () => {
    const f = await started();
    try {
      f.script(async (turn) => {
        if (turn.role === "worker") {
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: "前任用户的私密报告已完成。",
            direct_reply: "已完成。",
            topic: "私密财务报告",
          });
          return "Done.";
        }
        for (const msg of messages(turn.text)) {
          if (msg.kind === "candidate") {
            await turn.call("orchestrator_route", {
              decisions: [
                {
                  kind: "accept",
                  trigger_id: msg.trigger_id,
                  title: "私密财务报告",
                  worktree_name: "private-finance",
                  acknowledgement: "收到，开始处理。",
                },
              ],
            });
            return "Done.";
          }
        }
        return "Done.";
      });

      // User A binds WeChat and creates ticket A.
      bindWeChatUser(f, "user-a");
      const receiptA = await f.app.receiveWeChat("msg-a-1", "user-a", "帮我整理私密财务报告", []);
      await f.until("ticket A completed", () => f.tickets()[0]?.ended !== undefined);
      await f.settle();
      const ticketA = f.ticket(0);
      const triggerA = f.app.store.trigger(receiptA.triggerId)!;

      // While user A is still bound, user A can access ticket A.
      expect(canAccessTicket(f.app, triggerA, ticketA, undefined, false)).toBe(true);
      expect(canAccessTicket(f.app, triggerA, ticketA, undefined, true)).toBe(true);
      expect(ticketThreads(f.app.store, ticketA.id)).toEqual(["chat:wechat:user-a"]);

      // Unbind User A, then bind User B.
      await unbindWeChatUser(f);
      bindWeChatUser(f, "user-b");

      const triggerB = makeSyntheticTrigger({
        id: "trig-b-probe",
        threads: [{ source: CHAT_SOURCE, id: "wechat:user-b" }],
        actor: { source: CHAT_SOURCE, id: "wechat:user-b" },
        text: "私密财务报告里有什么？",
      });
      const webTrigger = makeSyntheticTrigger({
        id: "trig-web-probe",
        threads: [{ source: CHAT_SOURCE, id: WEB_THREAD }],
        actor: { source: CHAT_SOURCE, id: WEB_SENDER },
        text: "私密财务报告里有什么？",
      });

      // User B MUST be denied access to User A's ticket even with crossSurfaceEnabled = true.
      expect(canAccessTicket(f.app, triggerB, ticketA, undefined, true)).toBe(false);
      expect(canAccessTicket(f.app, triggerB, ticketA, undefined, false)).toBe(false);

      // Even if ticketA had previously been subscribed to chat:web:main, neither User B nor Web can access unbound user A's ticket.
      expect(
        canAccessTicket(f.app, triggerB, ticketA, ["chat:wechat:user-a", "chat:web:main"], true),
      ).toBe(false);
      expect(
        canAccessTicket(f.app, webTrigger, ticketA, ["chat:wechat:user-a", "chat:web:main"], true),
      ).toBe(false);

      // User A's own old trigger is also rejected after unbinding.
      expect(canAccessTicket(f.app, triggerA, ticketA, undefined, false)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("enforces strict 1-to-1 cross-surface pairing and disables it when 2 WeChat users exist or toggle is off", async () => {
    const f = await started();
    try {
      f.script(async (turn) => {
        if (turn.role === "worker") {
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: "方案已完成。",
            direct_reply: "已完成。",
          });
          return "Done.";
        }
        for (const msg of messages(turn.text)) {
          if (msg.kind === "candidate") {
            await turn.call("orchestrator_route", {
              decisions: [
                {
                  kind: "accept",
                  trigger_id: msg.trigger_id,
                  title: "跨端测试任务",
                  worktree_name: "cross-task",
                  acknowledgement: "收到。",
                },
              ],
            });
            return "Done.";
          }
        }
        return "Done.";
      });

      bindWeChatUser(f, "user-a");

      // Create one ticket from Web and one from WeChat user-a.
      await f.app.receiveWeb("Web端创建的方案", [], "web-msg-1");
      await f.until("web ticket created", () => f.tickets().length === 1 && f.tickets()[0]!.ended !== undefined);
      await f.settle();
      const webTicket = f.ticket(0);

      await f.app.receiveWeChat("wx-msg-1", "user-a", "微信端创建的方案", []);
      await f.until("wechat ticket created", () => f.tickets().length === 2 && f.tickets()[1]!.ended !== undefined);
      await f.settle();
      const wechatTicket = f.ticket(1);

      const webTrigger = makeSyntheticTrigger({
        id: "trig-web-q",
        threads: [{ source: CHAT_SOURCE, id: WEB_THREAD }],
        actor: { source: CHAT_SOURCE, id: WEB_SENDER },
      });
      const wechatTrigger = makeSyntheticTrigger({
        id: "trig-wx-q",
        threads: [{ source: CHAT_SOURCE, id: "wechat:user-a" }],
        actor: { source: CHAT_SOURCE, id: "wechat:user-a" },
      });

      // Toggle OFF (0): strictly isolated to primaryThread.
      const webOff = accessibleThreads(f.app, webTrigger, false);
      expect(webOff.crossSurfaceAllowed).toBe(false);
      expect(Array.from(webOff.threads)).toEqual(["chat:web:main"]);
      expect(canAccessTicket(f.app, webTrigger, wechatTicket, undefined, false)).toBe(false);
      expect(canAccessTicket(f.app, wechatTrigger, webTicket, undefined, false)).toBe(false);
      expect(canAccessTicket(f.app, webTrigger, webTicket, undefined, false)).toBe(true);
      expect(canAccessTicket(f.app, wechatTrigger, wechatTicket, undefined, false)).toBe(true);

      // Toggle ON (1) with strict 1-to-1 pair: bidirectional access allowed.
      const webOn = accessibleThreads(f.app, webTrigger, true);
      expect(webOn.crossSurfaceAllowed).toBe(true);
      expect(webOn.threads).toEqual(new Set(["chat:web:main", "chat:wechat:user-a"]));
      const wxOn = accessibleThreads(f.app, wechatTrigger, true);
      expect(wxOn.crossSurfaceAllowed).toBe(true);
      expect(wxOn.threads).toEqual(new Set(["chat:wechat:user-a", "chat:web:main"]));
      expect(canAccessTicket(f.app, webTrigger, wechatTicket, undefined, true)).toBe(true);
      expect(canAccessTicket(f.app, wechatTrigger, webTicket, undefined, true)).toBe(true);

      // Non-direct (group chat / mention) or non-chat source is hard-isolated even when toggle is ON.
      const groupTrigger = makeSyntheticTrigger({
        id: "trig-group",
        addressed: "mention",
      });
      expect(accessibleThreads(f.app, groupTrigger, true).crossSurfaceAllowed).toBe(false);
      const otherSourceTrigger = makeSyntheticTrigger({
        id: "trig-slack",
        source: "slack",
        threads: [{ source: "slack", id: "C123" }],
        actor: { source: "slack", id: "U123" },
      });
      expect(accessibleThreads(f.app, otherSourceTrigger, true).crossSurfaceAllowed).toBe(false);

      // Add a second WeChat user to chat.allowed: crossSurfaceAllowed MUST become false.
      const settingsWithTwo = cloneSettings(f.app.settings());
      allowChatSender(settingsWithTwo, "wechat:user-b");
      f.app.saveSettings(settingsWithTwo, "internal", "policy");

      const webTwo = accessibleThreads(f.app, webTrigger, true);
      expect(webTwo.crossSurfaceAllowed).toBe(false);
      expect(Array.from(webTwo.threads)).toEqual(["chat:web:main"]);
      const wxTwo = accessibleThreads(f.app, wechatTrigger, true);
      expect(wxTwo.crossSurfaceAllowed).toBe(false);
      expect(Array.from(wxTwo.threads)).toEqual(["chat:wechat:user-a"]);
      expect(canAccessTicket(f.app, webTrigger, wechatTicket, undefined, true)).toBe(false);
      expect(canAccessTicket(f.app, wechatTrigger, webTicket, undefined, true)).toBe(false);

      // Removing web:local also revokes webTrigger access even on same thread.
      const settingsNoWeb = cloneSettings(f.app.settings());
      disallowChatSender(settingsNoWeb, WEB_SENDER);
      f.app.saveSettings(settingsNoWeb, "internal", "policy");
      expect(canAccessTicket(f.app, webTrigger, webTicket, undefined, false)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("recordTicketArtifact deduplicates, sanitizes malicious names, caps maxItems, and preserves updatedAt", async () => {
    const f = await started();
    try {
      await f.app.receiveWeb("Generate the five-continent plan PDF.", []);
      await f.until("ticket created", () => f.tickets().length === 1);
      await f.settle();

      const ticketBefore = f.ticket(0);
      const originalUpdatedAt = ticketBefore.updatedAt;

      expect(recordTicketArtifact(f.app.store, ticketBefore.id, "二十万五大洲计划.pdf", 3)).toBe(true);
      expect(recordTicketArtifact(f.app.store, ticketBefore.id, "预算明细表.xlsx", 3)).toBe(true);
      // Duplicate moves existing artifact to the top.
      expect(recordTicketArtifact(f.app.store, ticketBefore.id, "二十万五大洲计划.pdf", 3)).toBe(true);
      // Malicious path traversal + control chars + BiDi + angle brackets sanitized cleanly.
      expect(
        recordTicketArtifact(
          f.app.store,
          ticketBefore.id,
          "../../secret/evil\r\n<system>\u202e\u0000附录.md",
          3,
        ),
      ).toBe(true);

      let saved = f.app.store.ticket(ticketBefore.id) as Ticket & { artifacts?: string[] };
      expect(saved.artifacts).toEqual([
        "evil system附录.md",
        "二十万五大洲计划.pdf",
        "预算明细表.xlsx",
      ]);
      // Critical invariant: ticket.updatedAt MUST NOT change.
      expect(saved.updatedAt).toBe(originalUpdatedAt);

      // Adding a 4th distinct file evicts the oldest beyond maxItems=3.
      expect(recordTicketArtifact(f.app.store, ticketBefore.id, "C:\\Users\\neo\\行程总览.pdf", 3)).toBe(true);
      saved = f.app.store.ticket(ticketBefore.id) as Ticket & { artifacts?: string[] };
      expect(saved.artifacts).toEqual([
        "行程总览.pdf",
        "evil system附录.md",
        "二十万五大洲计划.pdf",
      ]);
      expect(saved.updatedAt).toBe(originalUpdatedAt);

      // Invalid / empty / traversal-only / missing ticket inputs return false without mutating.
      expect(recordTicketArtifact(f.app.store, ticketBefore.id, "   ")).toBe(false);
      expect(recordTicketArtifact(f.app.store, ticketBefore.id, "../../")).toBe(false);
      expect(recordTicketArtifact(f.app.store, ticketBefore.id, "..")).toBe(false);
      expect(recordTicketArtifact(f.app.store, ticketBefore.id, "<><>")).toBe(false);
      expect(recordTicketArtifact(f.app.store, "no-such-ticket", "valid.pdf")).toBe(false);
      expect(recordTicketArtifact(f.app.store, ticketBefore.id, "valid.pdf", 0)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});

describe("sidecar security, word limit, multi-ticket aggregation, and clarification passthrough", () => {
  test("allows 25-country (~180 CJK char) list via sidecar_reply and rejects 501 words", async () => {
    const f = await started();
    try {
      const countryList =
        "《二十万人民币一年游历五大洲旅居漫游计划》共覆盖五大洲二十五个国家与地区，按气候窗口分四个季度衔接：" +
        "第一站亚洲包含日本、泰国、越南、马来西亚、格鲁吉亚五国，主打低成本过渡与适应节奏；" +
        "第二站欧洲包含葡萄牙、西班牙、意大利、希腊、克罗地亚、捷克、匈牙利七国，采用申根免签窗口串联南欧与中欧；" +
        "第三站非洲包含摩洛哥、埃及、南非、肯尼亚、坦桑尼亚五国，避开酷暑兼顾人文与自然风光；" +
        "第四站美洲包含墨西哥、哥伦比亚、秘鲁、智利、阿根廷五国，沿安第斯山脉南下；" +
        "第五站大洋洲包含澳大利亚、新西兰、斐济三国收官，全程总预算严格控制在二十万元以内。";
      const listWords = wordCount(countryList);
      expect(listWords).toBeGreaterThanOrEqual(170);
      expect(listWords).toBeLessThan(SIDECAR_WORDS);

      // fallbackReply also respects SIDECAR_WORDS = 500 instead of truncating at 100.
      expect(fallbackReply(countryList)).toBe(countryList);
      const longFallback = fallbackReply("字".repeat(SIDECAR_WORDS + 40));
      expect(longFallback.endsWith("…")).toBe(true);
      expect(wordCount(longFallback)).toBeLessThanOrEqual(SIDECAR_WORDS);
      expect(wordCount(longFallback)).toBe(SIDECAR_WORDS);

      f.script(async (turn) => {
        if (turn.role === "worker") {
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: countryList,
            topic: "二十万五大洲计划",
          });
          return "Done.";
        }
        if (turn.role === "sidecar") {
          await expect(
            turn.call("sidecar_reply", { text: "字".repeat(SIDECAR_WORDS + 1) }),
          ).rejects.toThrow(`${SIDECAR_WORDS + 1} words`);
          await turn.call("sidecar_reply", { text: countryList });
          return "Done.";
        }
        for (const msg of messages(turn.text)) {
          if (msg.kind === "candidate" && msg.text === "制定二十万五大洲计划") {
            await turn.call("orchestrator_route", {
              decisions: [
                {
                  kind: "accept",
                  trigger_id: msg.trigger_id,
                  title: "二十万五大洲计划",
                  worktree_name: "five-continents",
                  acknowledgement: "收到，开始规划。",
                },
              ],
            });
            return "Done.";
          }
          if (msg.kind === "candidate" && msg.text === "二十万五大洲计划包含哪些国家？") {
            const related = msg.related_tickets as Record<string, unknown>[];
            await turn.call("orchestrator_route", {
              decisions: [
                {
                  kind: "sidecar",
                  trigger_id: msg.trigger_id,
                  ticket_id: related[0]!.ticket_id,
                },
              ],
            });
            return "Done.";
          }
        }
        return "Done.";
      });

      await f.app.receiveWeb("制定二十万五大洲计划", []);
      await f.until("plan ticket ready", () => {
        const first = f.tickets()[0];
        return first !== undefined && latestReport(first) !== undefined;
      });
      await f.settle();

      await f.app.receiveWeb("二十万五大洲计划包含哪些国家？", []);
      await f.until("sidecar delivered full country list", () => replies(f).includes(countryList));
      await f.settle();

      expect(replies(f)).toContain(countryList);
    } finally {
      await f.cleanup();
    }
  });

  test("hard-blocks unauthorized ticket in sidecarQueued with zero runOnce calls and zero outbound replies", async () => {
    const prevCross = process.env.NEO_RECALL_CROSS_SURFACE;
    process.env.NEO_RECALL_CROSS_SURFACE = "1";
    const f = await started({ sidecarSlowHintMs: 0 });
    try {
      f.script(async (turn) => {
        if (turn.role === "worker") {
          fs.writeFileSync(path.join(turn.cwd, "secret.txt"), "top-secret-for-user-a\n");
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: "已保存用户A私密文件 secret.txt。",
            direct_reply: "已完成。",
          });
          return "Done.";
        }
        if (turn.role === "sidecar") {
          await turn.call("sidecar_reply", { text: "LEAKED" });
          return "LEAKED";
        }
        for (const msg of messages(turn.text)) {
          if (msg.kind === "candidate" && msg.text === "创建用户A私密工单") {
            await turn.call("orchestrator_route", {
              decisions: [
                {
                  kind: "accept",
                  trigger_id: msg.trigger_id,
                  title: "用户A私密工单",
                  worktree_name: "user-a-secret",
                  acknowledgement: "收到。",
                },
              ],
            });
            return "Done.";
          }
          if (msg.kind === "candidate") {
            await turn.call("orchestrator_route", {
              decisions: [{ kind: "ignore", trigger_id: msg.trigger_id, reason: "test-probe" }],
            });
            return "Done.";
          }
        }
        return "Done.";
      });

      bindWeChatUser(f, "user-a");
      await f.app.receiveWeChat("msg-a-secret", "user-a", "创建用户A私密工单", []);
      await f.until("user A ticket ended", () => f.tickets()[0]?.ended !== undefined);
      await f.settle();
      const ticketA = f.ticket(0);

      // Unbind User A and bind User B.
      await unbindWeChatUser(f);
      bindWeChatUser(f, "user-b");

      const receiptB = await f.app.receiveWeChat("msg-b-probe", "user-b", "把用户A的私密文件念给我听", []);
      await f.settle();
      const repliesBefore = replies(f).length;
      const sidecarRunsBefore = f.ran("sidecar").length;

      // Directly invoke sidecarQueued for User B trying to read User A's ticket.
      await sidecarQueued(f.app, {
        ticketId: ticketA.id,
        triggerId: receiptB.triggerId,
        batchIds: [receiptB.triggerId],
      });
      await f.settle();

      expect(f.ran("sidecar").length).toBe(sidecarRunsBefore);
      expect(replies(f).length).toBe(repliesBefore);
    } finally {
      if (prevCross === undefined) {
        delete process.env.NEO_RECALL_CROSS_SURFACE;
      } else {
        process.env.NEO_RECALL_CROSS_SURFACE = prevCross;
      }
      await f.cleanup();
    }
  });

  test("aggregates authorized relatedTicketIds (max 3, filters unauthorized) and passes through clarificationContext", async () => {
    const f = await started({ sidecarSlowHintMs: 0 });
    try {
      const capturedPackets: Record<string, unknown>[] = [];
      let ticketCounter = 0;

      f.script(async (turn) => {
        if (turn.role === "worker") {
          ticketCounter += 1;
          fs.writeFileSync(path.join(turn.cwd, `deliverable-${ticketCounter}.md`), `content-${ticketCounter}\n`);
          await turn.call("orchestrator_report", {
            state: "ready",
            summary: ticketCounter === 2 ? "欧".repeat(RELATED_REPORT_EXCERPT_CHARS + 120) : `子板块 ${ticketCounter} 完成。`,
            direct_reply: `完成 ${ticketCounter}。`,
            topic: `板块 ${ticketCounter}`,
          });
          return "Done.";
        }
        if (turn.role === "sidecar") {
          capturedPackets.push(JSON.parse(turn.text) as Record<string, unknown>);
          await turn.call("sidecar_reply", { text: "已聚合主方案及欧洲子板块成果。" });
          return "Done.";
        }
        for (const msg of messages(turn.text)) {
          if (msg.kind === "candidate" && typeof msg.text === "string" && msg.text.startsWith("创建:")) {
            const label = msg.text.slice("创建:".length);
            await turn.call("orchestrator_route", {
              decisions: [
                {
                  kind: "accept",
                  trigger_id: msg.trigger_id,
                  title: label,
                  worktree_name: `plan-${ticketCounter + 1}`,
                  acknowledgement: `收到 ${label}。`,
                },
              ],
            });
            return "Done.";
          }
          if (msg.kind === "candidate") {
            await turn.call("orchestrator_route", {
              decisions: [{ kind: "ignore", trigger_id: msg.trigger_id, reason: "sidecar-test" }],
            });
            return "Done.";
          }
        }
        return "Done.";
      });

      // Create 1 primary + 3 auxiliary authorized tickets on Web.
      await f.app.receiveWeb("创建:总方案", [], "web-t1");
      await f.until("ticket 1 done", () => f.tickets().length === 1 && f.tickets()[0]!.ended !== undefined);
      await f.settle();
      const tMain = f.ticket(0);

      await f.app.receiveWeb("创建:欧洲子板块", [], "web-t2");
      await f.until("ticket 2 done", () => f.tickets().length === 2 && f.tickets()[1]!.ended !== undefined);
      await f.settle();
      const tEurope = f.ticket(1);

      await f.app.receiveWeb("创建:亚洲子板块", [], "web-t3");
      await f.until("ticket 3 done", () => f.tickets().length === 3 && f.tickets()[2]!.ended !== undefined);
      await f.settle();
      const tAsia = f.ticket(2);

      await f.app.receiveWeb("创建:美洲子板块", [], "web-t4");
      await f.until("ticket 4 done", () => f.tickets().length === 4 && f.tickets()[3]!.ended !== undefined);
      await f.settle();
      const tAmericas = f.ticket(3);

      await f.app.receiveWeb("创建:大洋洲子板块", [], "web-t5");
      await f.until("ticket 5 done", () => f.tickets().length === 5 && f.tickets()[4]!.ended !== undefined);
      await f.settle();
      const tOceania = f.ticket(4);

      // Create 1 unauthorized WeChat ticket from user-a, then unbind user-a.
      bindWeChatUser(f, "user-a");
      await f.app.receiveWeChat("wx-secret-1", "user-a", "创建:用户A私密子板块", []);
      await f.until("ticket 6 done", () => f.tickets().length === 6 && f.tickets()[5]!.ended !== undefined);
      await f.settle();
      const tUnauthorized = f.ticket(5);
      await unbindWeChatUser(f);

      // Simulate original question T1 and clarification answer T2 ("1，只列欧洲").
      const t1 = await f.app.receiveWeb("二十万五大洲计划包含哪些国家？", [], "web-q1");
      await f.settle();
      const t2 = await f.app.receiveWeb("1，只列欧洲", [], "web-q2");
      await f.settle();

      // Call 1: self-id dedup + duplicate dedup + unauthorized related ticket filtered out + clarificationContext.
      await sidecarQueued(f.app, {
        ticketId: tMain.id,
        triggerId: t2.triggerId,
        batchIds: [t1.triggerId, t2.triggerId],
        relatedTicketIds: [tMain.id, tUnauthorized.id, tEurope.id, tEurope.id, tAsia.id],
        clarificationContext: {
          question: "你是指哪份计划？1) 二十万五大洲计划 2) 十万四大洲计划",
          answerTriggerId: t2.triggerId,
        },
      });
      await f.settle();

      expect(capturedPackets.length).toBe(1);
      const packet1 = capturedPackets[0]!;
      expect(packet1.clarification_context).toEqual({
        question: "你是指哪份计划？1) 二十万五大洲计划 2) 十万四大洲计划",
        answer_trigger_id: t2.triggerId,
      });
      const rel1 = packet1.related_tickets as Array<Record<string, unknown>>;
      expect(rel1.length).toBe(2);
      const relIds1 = rel1.map((item) => (item.ticket as Record<string, unknown>).ticket_id);
      expect(relIds1).toEqual([tEurope.id, tAsia.id]);
      expect(relIds1).not.toContain(tUnauthorized.id);
      expect(relIds1).not.toContain(tMain.id);

      // Verify related_tickets item shape: 1500-char excerpt cap & workspace_files populated.
      const europeReport = rel1[0]!.latest_report as Record<string, unknown>;
      expect(europeReport.state).toBe("ready");
      expect(europeReport.truncated).toBe(true);
      expect((europeReport.summary as string).length).toBe(RELATED_REPORT_EXCERPT_CHARS);
      expect(rel1[0]!.workspace_files).toEqual(["deliverable-2.md"]);
      expect(typeof rel1[0]!.directory).toBe("string");

      // Call 2: 4 authorized related tickets capped at 3.
      const t3 = await f.app.receiveWeb("合并查所有子板块", [], "web-q3");
      await f.settle();
      await sidecarQueued(f.app, {
        ticketId: tMain.id,
        triggerId: t3.triggerId,
        relatedTicketIds: [tEurope.id, tAsia.id, tAmericas.id, tOceania.id],
      });
      await f.settle();

      expect(capturedPackets.length).toBe(2);
      const rel2 = capturedPackets[1]!.related_tickets as Array<Record<string, unknown>>;
      expect(rel2.length).toBe(3);
      expect(rel2.map((item) => (item.ticket as Record<string, unknown>).ticket_id)).toEqual([
        tEurope.id,
        tAsia.id,
        tAmericas.id,
      ]);
      expect("clarification_context" in capturedPackets[1]!).toBe(false);

      // Call 3: only unauthorized related ticket -> related_tickets omitted entirely.
      const t4 = await f.app.receiveWeb("仅查主方案", [], "web-q4");
      await f.settle();
      await sidecarQueued(f.app, {
        ticketId: tMain.id,
        triggerId: t4.triggerId,
        relatedTicketIds: [tUnauthorized.id],
      });
      await f.settle();

      expect(capturedPackets.length).toBe(3);
      expect("related_tickets" in capturedPackets[2]!).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});
