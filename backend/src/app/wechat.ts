/**
 * The WeChat bridge: one WeChat user, bound by scanning a QR code, talks to the main Session
 * as in the app. It owns the login, the long poll for that user's messages, replies in order,
 * and the binding kept across restarts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { formatIso, key, latestReport, nowMs, type Ticket } from "../core/index.ts";
import type { AppContext, ChatAttachment, WeChatStateName, WeChatStatus } from "./context.ts";
import type { Sent } from "./outbox.ts";
import {
  allowChatSender,
  CHAT_SOURCE,
  cloneSettings,
  disallowChatSender,
} from "./settings.ts";
import { clip } from "./text.ts";
import {
  idText,
  MAX_MEDIA_BYTES,
  mimeOf,
  safeName,
  WeChatProtocolError,
  type Account,
  type JsonValue,
  type Protocol,
} from "./wechat_protocol.ts";
import { wechatTypingLoop } from "./wechat_typing.ts";

export type { WeChatStateName, WeChatStatus };

const ACCOUNT = "wechat-account";
const CURSOR = "wechat-cursor";
const LOGIN_MINUTES = 5;
/** How many questions about a login may fail in a row before the login is given up. */
const MAX_STATUS_FAILURES = 3;
/** How many ids of messages lately taken into a burst are remembered, so one delivered twice is taken once. */
const SEEN_IDS = 64;
/** How many files lately received are kept, so a quote of one WeChat sends without its contents finds it. */
const RECENT_FILES = 16;
/** The most bytes those files may hold together (64 MiB). */
const RECENT_BYTES = 64 * 1024 * 1024;
/** What a burst of files alone says, once nothing more came. */
export const FILES_ALONE = "[用户只发送了文件，没有说明要做什么；请先确认需求再处理]";

const PLAIN_MESSAGE_ID_RE = /^[A-Za-z0-9_.-]+$/;
const DIGITS_ONLY_RE = /^[0-9]+$/;

/** Result of sending a local file to the bound WeChat user. */
export interface WeChatSendFileResult {
  sent: true;
  name: string;
  reused?: true;
}

interface Running {
  id: number;
  controller: AbortController;
}

/** A burst so far: one message to the main Session, under the id of its first. */
interface Held {
  userId: string;
  id: string;
  text: string[];
  attachments: ChatAttachment[];
  at?: string;
  /** When its first words came (monotonic ms). */
  worded: number | null;
  /** When its last message came (monotonic ms). */
  last: number;
}

/** Messages held back so that a burst, such as a file and then the words about it, reaches the main Session as one. */
interface Burst {
  held: Held | null;
  /** Bursts taken out and still on their way to the main Session. */
  delivering: number;
  /** The poll's cursor past held messages, saved once nothing is held or on its way. */
  cursor: string | null;
  /** Ids lately taken into a burst (FIFO queue + O(1) lookup set). */
  seen: string[];
  seenSet: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  seq: number;
}

/** What one answer about a login's status leads to. */
type LoginStepResult =
  | { kind: "wait"; base: string }
  | { kind: "over" }
  | { kind: "bound"; account: Account };

/** The bridge's state within the application. */
export class WeChatState {
  readonly protocol: Protocol;
  state: WeChatStateName = "disconnected";
  message = "尚未连接微信。";
  qr: string | undefined = undefined;
  login: Running | undefined = undefined;
  verifyCode: string | undefined = undefined;
  loginTask: Promise<void> | undefined = undefined;
  monitor: Running | undefined = undefined;
  monitorTask: Promise<void> | undefined = undefined;
  seq = 0;

  /** Burst coalescing state. */
  readonly burst: Burst = {
    held: null,
    delivering: 0,
    cursor: null,
    seen: [],
    seenSet: new Set<string>(),
    timer: null,
    seq: 0,
  };

  /** Files lately received, newest last. */
  readonly recent: ChatAttachment[] = [];
  /** Total byte length of all entries currently in `recent`. */
  recentBytes = 0;

  /** Held while a login is being started, so two concurrent requests start one. */
  connecting: Promise<void> | null = null;

  constructor(protocol: Protocol) {
    this.protocol = protocol;
  }

  set(state: WeChatStateName, message: string): void {
    this.state = state;
    this.message = message;
    if (state !== "waiting" && state !== "scaned" && state !== "verify") {
      this.qr = undefined;
    }
  }

  next(): number {
    this.seq += 1;
    return this.seq;
  }

  loginIs(id: number): boolean {
    return this.login !== undefined && this.login.id === id;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortedError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return error instanceof WeChatProtocolError && error.isAborted;
}

function sleepOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Counts Unicode scalar values, matching Rust `str::chars().count()`. */
function charCount(text: string): number {
  let count = 0;
  const len = text.length;
  for (let i = 0; i < len; ) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 2;
        count += 1;
        continue;
      }
    }
    i += 1;
    count += 1;
  }
  return count;
}

/** A message's structure without what it says: each string by its length, so the log shows what WeChat sent. */
function shape(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return `<${charCount(node)}字>`;
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = walk(v);
      }
      return out;
    }
    return node === undefined ? null : node;
  };
  const shown = JSON.stringify(walk(value));
  return clip(shown ?? "null", 2000);
}

/** A message id that can name a chat message: the id itself when it is made of plain characters, else its digest. */
export function messageId(message: unknown): string {
  const obj = isPlainObject(message) ? message : {};
  const id = idText(obj.message_id) ?? idText(obj.client_id) ?? "";
  if (id.length >= 1 && id.length <= 180 && PLAIN_MESSAGE_ID_RE.test(id)) {
    return id;
  }
  const source = id.length === 0 ? JSON.stringify(message) : id;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(source);
  return hasher.digest("hex");
}

/** When the burst is over, unless more comes: soon after words, later after files alone. */
function heldDue(held: Held, protocol: Protocol): number {
  if (held.worded !== null) {
    return Math.min(held.last + protocol.quietMs, held.worded + protocol.burstCapMs);
  }
  return held.last + protocol.fileWaitMs;
}

/** Component-wise path prefix check matching Rust `Path::starts_with`. */
function pathStartsWith(filePath: string, dirPath: string): boolean {
  const rel = path.relative(dirPath, filePath);
  if (rel === "") {
    return true;
  }
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../")) {
    return false;
  }
  return !path.isAbsolute(rel);
}

/** The bound WeChat account, if any. */
export function wechatAccount(app: AppContext): Account | null {
  const raw = app.store.get<unknown>(ACCOUNT);
  if (!isPlainObject(raw)) {
    return null;
  }
  if (
    typeof raw.token !== "string" ||
    typeof raw.accountId !== "string" ||
    typeof raw.userId !== "string" ||
    typeof raw.baseUrl !== "string"
  ) {
    return null;
  }
  const account: Account = {
    token: raw.token,
    accountId: raw.accountId,
    userId: raw.userId,
    baseUrl: raw.baseUrl,
  };
  if (typeof raw.contextToken === "string") {
    account.contextToken = raw.contextToken;
  }
  return account;
}

/** Where the bridge stands. */
export function wechatStatus(app: AppContext, state: WeChatState): WeChatStatus {
  const account = wechatAccount(app);
  const status: WeChatStatus = {
    state: state.state,
    message: state.message,
  };
  if (state.qr !== undefined) {
    status.qrContent = state.qr;
  }
  if (account !== null) {
    status.senderId = `wechat:${account.userId}`;
  }
  return status;
}

/** Take up a saved binding again. */
export function wechatStart(app: AppContext, state: WeChatState): void {
  const account = wechatAccount(app);
  if (account !== null) {
    state.set("connected", "微信绑定已恢复。");
    wechatMonitor(app, state, account);
  }
}

/** Stop the login and the long poll; the binding stays. */
export async function wechatStop(_app: AppContext, state: WeChatState): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (state.login !== undefined) {
    state.login.controller.abort();
    state.login = undefined;
  }
  if (state.monitor !== undefined) {
    state.monitor.controller.abort();
    state.monitor = undefined;
  }
  if (state.loginTask !== undefined) {
    tasks.push(state.loginTask);
    state.loginTask = undefined;
  }
  if (state.monitorTask !== undefined) {
    tasks.push(state.monitorTask);
    state.monitorTask = undefined;
  }
  for (const task of tasks) {
    await task.catch(() => {});
  }
  // A held burst is let go with its cursor unsaved: the next poll after a start brings its messages again.
  if (state.burst.timer !== null) {
    clearTimeout(state.burst.timer);
    state.burst.timer = null;
  }
  state.burst.held = null;
  state.burst.cursor = null;
  state.burst.seq += 1;
}

/** Connect: with a binding, listen; without one, start a login and show its QR code. */
export async function wechatConnect(app: AppContext, state: WeChatState): Promise<WeChatStatus> {
  const existing = wechatAccount(app);
  if (existing !== null) {
    wechatMonitor(app, state, existing);
    state.set("connected", "微信已连接，可直接与 orchestrator 对话。");
    return wechatStatus(app, state);
  }
  if (state.connecting !== null) {
    // Another request is starting the login: wait for it and show the same code.
    await state.connecting;
    return wechatStatus(app, state);
  }

  let releaseConnecting!: () => void;
  state.connecting = new Promise<void>((resolve) => {
    releaseConnecting = resolve;
  });

  try {
    if (state.login !== undefined) {
      state.login.controller.abort();
      state.login = undefined;
    }
    const id = state.next();
    const controller = new AbortController();
    state.login = { id, controller };
    state.verifyCode = undefined;

    let qrResult: { ok: true; id: string; url: string } | { ok: false; aborted: boolean; error?: string };
    try {
      const qr = await state.protocol.createQr(controller.signal);
      qrResult = { ok: true, id: qr.id, url: qr.url };
    } catch (error) {
      if (isAbortedError(error, controller.signal)) {
        qrResult = { ok: false, aborted: true };
      } else {
        qrResult = { ok: false, aborted: false, error: errorText(error) };
      }
    }

    if (!state.loginIs(id)) {
      return wechatStatus(app, state);
    }

    if (qrResult.ok) {
      state.set("waiting", "使用微信扫码并确认授权。");
      state.qr = qrResult.url;
      state.loginTask = wechatLogin(app, state, id, qrResult.id, controller.signal);
    } else if (qrResult.aborted) {
      state.login = undefined;
    } else {
      state.login = undefined;
      state.set("error", `获取微信二维码失败：${qrResult.error ?? ""}`);
    }
    return wechatStatus(app, state);
  } finally {
    state.connecting = null;
    releaseConnecting();
  }
}

/** Follow a login until it is confirmed, fails, or five minutes have passed. */
async function wechatLogin(
  app: AppContext,
  state: WeChatState,
  id: number,
  qrId: string,
  signal: AbortSignal,
): Promise<void> {
  const protocol = state.protocol;
  const deadline = nowMs() + LOGIN_MINUTES * 60_000;
  let base = protocol.apiBase;
  let failures = 0;

  try {
    while (nowMs() < deadline && state.loginIs(id) && !signal.aborted) {
      const code = state.verifyCode;
      let result: JsonValue;
      try {
        result = await protocol.qrStatus(qrId, base, code, signal);
        failures = 0;
      } catch (error) {
        if (isAbortedError(error, signal)) {
          return;
        }
        // One failed question is not a failed login: the network may hiccup while the person reaches for the phone.
        failures += 1;
        if (failures > MAX_STATUS_FAILURES) {
          throw error;
        }
        const slept = await sleepOrAbort(protocol.paceMs, signal);
        if (!slept) {
          return;
        }
        continue;
      }

      const step = wechatLoginStep(app, state, id, result, code !== undefined, base);
      if (step.kind === "over") {
        return;
      }
      if (step.kind === "bound") {
        wechatMonitor(app, state, step.account);
        return;
      }
      base = step.base;
      const slept = await sleepOrAbort(protocol.paceMs, signal);
      if (!slept) {
        return;
      }
    }

    if (!signal.aborted && state.loginIs(id)) {
      state.login = undefined;
      state.set("error", "连接超时，请重新获取二维码。");
    }
  } catch (error) {
    if (!signal.aborted && state.loginIs(id)) {
      state.login = undefined;
      state.set("error", `微信连接失败：${errorText(error)}`);
    }
  }
}

/** Apply one answer about a login's status. */
function wechatLoginStep(
  app: AppContext,
  state: WeChatState,
  id: number,
  result: JsonValue,
  codeGiven: boolean,
  base: string,
): LoginStepResult {
  if (!state.loginIs(id)) {
    return { kind: "over" };
  }
  const obj = isPlainObject(result) ? result : {};
  const status = typeof obj.status === "string" ? obj.status : "";
  let nextBase = base;

  switch (status) {
    case "scaned":
      state.verifyCode = undefined;
      state.set("scaned", "已扫码，请在手机微信确认。");
      break;
    case "need_verifycode":
      state.set("verify", codeGiven ? "验证码不正确，请重新输入。" : "输入手机微信显示的验证码。");
      break;
    case "scaned_but_redirect": {
      const host = asNonEmptyString(obj.redirect_host);
      if (host !== undefined) {
        nextBase = `https://${host}`;
      }
      break;
    }
    case "confirmed": {
      const token = asNonEmptyString(obj.bot_token);
      const accountId = asNonEmptyString(obj.ilink_bot_id);
      const userId = asNonEmptyString(obj.ilink_user_id);
      if (token === undefined || accountId === undefined || userId === undefined) {
        throw new Error("扫码确认响应缺少账号凭据或绑定用户");
      }
      const account: Account = {
        token,
        accountId,
        userId,
        baseUrl: asNonEmptyString(obj.baseurl) ?? state.protocol.apiBase,
      };
      // The binding is whole before it shows as connected: the account, and its user as a chat sender.
      app.store.set(ACCOUNT, account);
      app.store.delete(CURSOR);
      wechatAllow(app, account.userId, true);
      state.login = undefined;
      state.set("connected", "微信连接成功。");
      return { kind: "bound", account };
    }
    case "binded_redirect": {
      const account = wechatAccount(app);
      if (account === null) {
        throw new Error("微信已绑定其他实例；请先解除原绑定");
      }
      state.login = undefined;
      state.set("connected", "微信已连接。");
      return { kind: "bound", account };
    }
    case "expired":
      state.login = undefined;
      state.set("error", "二维码已过期，请重新连接。");
      return { kind: "over" };
    case "verify_code_blocked":
      state.login = undefined;
      state.set("error", "验证码错误次数过多，请重新扫码。");
      return { kind: "over" };
    default:
      break;
  }
  return { kind: "wait", base: nextBase };
}

/** Give the code WeChat showed on the phone. */
export function wechatVerify(app: AppContext, state: WeChatState, code: string): WeChatStatus {
  const trimmed = code.trim();
  if (state.login === undefined || state.state !== "verify") {
    throw new Error("当前不需要微信验证码");
  }
  if (trimmed.length < 1 || trimmed.length > 16 || !DIGITS_ONLY_RE.test(trimmed)) {
    throw new Error("验证码必须为数字");
  }
  state.verifyCode = trimmed;
  state.set("waiting", "验证码已提交，等待微信确认。");
  return wechatStatus(app, state);
}

/** Unbind: stop listening and forget the account; the conversation stays. */
export async function wechatDisconnect(app: AppContext, state: WeChatState): Promise<WeChatStatus> {
  await wechatStop(app, state);
  const account = wechatAccount(app);
  if (account !== null) {
    wechatAllow(app, account.userId, false);
  }
  app.store.delete(ACCOUNT);
  app.store.delete(CURSOR);
  state.set("disconnected", "微信已断开，orchestrator 对话记录保留。");
  return wechatStatus(app, state);
}

/** Put the bound user on the chat Source's list of senders, or take it off. */
function wechatAllow(app: AppContext, userId: string, allow: boolean): void {
  const settings = cloneSettings(app.settings());
  const sender = `wechat:${userId}`;
  const changed = allow
    ? allowChatSender(settings, sender)
    : disallowChatSender(settings, sender);
  if (changed) {
    try {
      app.saveSettings(settings, "internal", "policy");
    } catch {
      // Best-effort settings update matching Rust `let _ = self.save_settings(...)`.
    }
  }
}

function wechatMonitor(app: AppContext, state: WeChatState, account: Account): void {
  if (state.monitor !== undefined || app.closing()) {
    return;
  }
  const id = state.next();
  const controller = new AbortController();
  state.monitor = { id, controller };
  state.monitorTask = (async () => {
    // The typing indicator lives as long as the poll, whether it is cancelled or the login ends.
    const typingController = new AbortController();
    const poll = (async () => {
      try {
        await wechatPoll(app, state, account, controller.signal);
      } finally {
        typingController.abort();
      }
    })();
    const typing = wechatTypingLoop(app, state.protocol, account, typingController.signal);
    await Promise.all([poll, typing]);
    if (state.monitor !== undefined && state.monitor.id === id) {
      state.monitor = undefined;
    }
  })();
}

function intField(obj: Record<string, unknown>, name: string): number {
  const value = obj[name];
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

/** Long-poll for the bound user's messages until cancelled or the login is no longer valid. */
async function wechatPoll(
  app: AppContext,
  state: WeChatState,
  account: Account,
  signal: AbortSignal,
): Promise<void> {
  const protocol = state.protocol;
  const savedCursor = app.store.get<unknown>(CURSOR);
  let cursor = typeof savedCursor === "string" ? savedCursor : "";
  let timeoutMs = 35_000;
  let failures = 0;

  while (!signal.aborted) {
    let update: JsonValue;
    let pollError: string | undefined;
    let loginExpired = false;

    try {
      update = await protocol.updates(account, cursor, timeoutMs, signal);
      const obj = isPlainObject(update) ? update : {};
      const ret = intField(obj, "ret");
      const errcode = intField(obj, "errcode");

      if (ret === -14 || errcode === -14) {
        loginExpired = true;
      } else if (ret !== 0 || errcode !== 0) {
        const errmsg = asNonEmptyString(obj.errmsg);
        pollError = errmsg ?? `微信长轮询 ret=${ret !== 0 ? ret : errcode}`;
      } else {
        const wait = obj.longpolling_timeout_ms;
        if (typeof wait === "number" && Number.isInteger(wait) && wait > 0) {
          timeoutMs = wait;
        }
        if (Array.isArray(obj.msgs)) {
          for (const message of obj.msgs) {
            await wechatReceive(app, state, account, message, signal);
          }
        }
        const next = asNonEmptyString(obj.get_updates_buf);
        if (next !== undefined) {
          cursor = next;
          wechatKeepCursor(app, state, cursor);
        }
      }
    } catch (error) {
      if (isAbortedError(error, signal)) {
        return;
      }
      pollError = errorText(error);
    }

    if (signal.aborted) {
      return;
    }

    if (loginExpired) {
      state.set("error", "微信登录已失效，请断开后重新扫码。");
      return;
    }

    if (pollError === undefined) {
      failures = 0;
      if (
        state.login === undefined &&
        (state.state !== "connected" || state.message.startsWith("微信接收暂时失败"))
      ) {
        state.set("connected", "微信已连接。");
      }
    } else {
      failures += 1;
      state.set("connected", `微信接收暂时失败，正在重试：${pollError}`);
      const waitMs = Math.min(protocol.paceMs * 2 ** Math.min(failures, 5), 30_000);
      const slept = await sleepOrAbort(waitMs, signal);
      if (!slept) {
        return;
      }
    }
  }
}

/**
 * Take in one message of the long poll: only a direct message of the bound user,
 * with its text, voice transcripts and attachments.
 */
async function wechatReceive(
  app: AppContext,
  state: WeChatState,
  account: Account,
  message: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (!isPlainObject(message)) {
    return;
  }
  const fromGroup = typeof message.group_id === "string" && message.group_id.length > 0;
  if (
    message.message_type !== 1 ||
    fromGroup ||
    message.from_user_id !== account.userId
  ) {
    return;
  }
  const id = messageId(message);
  const token = asNonEmptyString(message.context_token);
  if (token !== undefined && account.contextToken !== token) {
    account.contextToken = token;
    app.store.set(ACCOUNT, account);
  }
  console.error(`[neo-agent] 微信消息 ${id}：${shape(message.item_list)}`);

  const quoted: string[] = [];
  const text: string[] = [];
  const attachments: ChatAttachment[] = [];

  if (isPlainObject(message.ref_msg)) {
    await wechatQuote(state, message.ref_msg, `${id}-ref`, quoted, attachments, signal);
  }

  if (Array.isArray(message.item_list)) {
    for (const item of message.item_list) {
      if (isPlainObject(item)) {
        const itemType = item.type;
        const textItem = isPlainObject(item.text_item) ? item.text_item : undefined;
        const voiceItem = isPlainObject(item.voice_item) ? item.voice_item : undefined;
        const textSaid = typeof textItem?.text === "string" ? textItem.text : undefined;
        const voiceSaid = typeof voiceItem?.text === "string" ? voiceItem.text : undefined;

        if (itemType === 1 && textSaid !== undefined && textSaid.length > 0) {
          text.push(textSaid);
        } else if (itemType === 3 && voiceSaid !== undefined && voiceSaid.length > 0) {
          text.push(`[语音转写] ${voiceSaid}`);
        }

        await wechatFetch(state, item as JsonValue, id, text, attachments, signal);

        if (isPlainObject(item.ref_msg)) {
          await wechatQuote(state, item.ref_msg, `${id}-ref`, quoted, attachments, signal);
        }
      }
    }
  }

  quoted.push(...text);
  if (quoted.length === 0 && attachments.length === 0) {
    return;
  }
  const createTime = message.create_time_ms;
  const at =
    typeof createTime === "number" && Number.isInteger(createTime)
      ? formatIso(createTime)
      : undefined;
  await wechatHold(app, state, account.userId, `wechat:${id}`, quoted, attachments, at);
}

/**
 * The image, file or video an item carries, among the attachments; a file that cannot be fetched
 * is said in words, and holds back neither its message nor those after it.
 */
async function wechatFetch(
  state: WeChatState,
  item: JsonValue,
  id: string,
  text: string[],
  attachments: ChatAttachment[],
  signal: AbortSignal,
): Promise<void> {
  try {
    const attachment = await state.protocol.downloadAttachment(item, id, signal);
    if (attachment !== null) {
      wechatRemember(state, attachment);
      attachments.push(attachment);
    }
  } catch (error) {
    if (isAbortedError(error, signal)) {
      throw error;
    }
    text.push(`[${errorText(error)}]`);
  }
}

/** Keep a received file among the recent ones. */
function wechatRemember(state: WeChatState, attachment: ChatAttachment): void {
  if (attachment.data.byteLength > RECENT_BYTES) {
    return;
  }
  for (let i = state.recent.length - 1; i >= 0; i -= 1) {
    if (state.recent[i].name === attachment.name) {
      state.recentBytes -= state.recent[i].data.byteLength;
      state.recent.splice(i, 1);
    }
  }
  state.recent.push(attachment);
  state.recentBytes += attachment.data.byteLength;
  while (state.recent.length > RECENT_FILES || state.recentBytes > RECENT_BYTES) {
    const oldest = state.recent.shift();
    if (oldest === undefined) {
      break;
    }
    state.recentBytes -= oldest.data.byteLength;
  }
}

/** The file of that name lately received, newest first. */
function wechatRecalled(state: WeChatState, name: string): ChatAttachment | undefined {
  for (let i = state.recent.length - 1; i >= 0; i -= 1) {
    const kept = state.recent[i];
    if (kept.name === name) {
      return { name: kept.name, mediaType: kept.mediaType, data: kept.data };
    }
  }
  return undefined;
}

/** What a message quotes: its words as a quote line, its file among the attachments. */
async function wechatQuote(
  state: WeChatState,
  quote: Record<string, unknown>,
  id: string,
  lines: string[],
  attachments: ChatAttachment[],
  signal: AbortSignal,
): Promise<void> {
  const item = isPlainObject(quote.message_item) ? quote.message_item : {};
  const rawTitle = typeof quote.title === "string" ? quote.title.trim() : "";
  const title = rawTitle.length > 0 ? rawTitle : undefined;

  const textItem = isPlainObject(item.text_item) ? item.text_item : undefined;
  const voiceItem = isPlainObject(item.voice_item) ? item.voice_item : undefined;
  const rawSaid =
    typeof textItem?.text === "string"
      ? textItem.text
      : typeof voiceItem?.text === "string"
        ? voiceItem.text
        : undefined;
  const trimmedSaid = rawSaid?.trim();
  const said = trimmedSaid !== undefined && trimmedSaid.length > 0 ? trimmedSaid : undefined;

  const fileItem = isPlainObject(item.file_item) ? item.file_item : undefined;
  const rawFileName = typeof fileItem?.file_name === "string" ? fileItem.file_name : undefined;
  const named =
    rawFileName !== undefined && rawFileName.trim().length > 0
      ? safeName(rawFileName, "file.bin")
      : undefined;

  const before = attachments.length;
  const failed: string[] = [];
  await wechatFetch(state, item as JsonValue, id, failed, attachments, signal);

  // WeChat may quote a file by its name alone: then it is the one of that name lately received.
  if (attachments.length === before) {
    const candidates = [named, title];
    for (const candidate of candidates) {
      if (candidate === undefined) {
        continue;
      }
      const file = wechatRecalled(state, candidate);
      if (file !== undefined) {
        attachments.push(file);
        failed.length = 0;
        break;
      }
    }
  }

  const attached = attachments[before];
  if (attached !== undefined) {
    lines.push(`[引用的文件：${attached.name}]`);
  } else if (named !== undefined) {
    lines.push(`[引用的文件：${named}（未能取回文件内容）]`);
  } else if ((said ?? title) !== undefined) {
    lines.push(`[引用] ${said ?? title}`);
  }
  lines.push(...failed);
}

/** Take a message into the burst it belongs to; the burst goes to the main Session when it is over. */
async function wechatHold(
  app: AppContext,
  state: WeChatState,
  userId: string,
  id: string,
  text: string[],
  attachments: ChatAttachment[],
  at?: string,
): Promise<void> {
  const burst = state.burst;
  if (burst.seenSet.has(id)) {
    return;
  }
  burst.seen.push(id);
  burst.seenSet.add(id);
  if (burst.seen.length > SEEN_IDS) {
    const oldest = burst.seen.shift();
    if (oldest !== undefined) {
      burst.seenSet.delete(oldest);
    }
  }

  const now = performance.now();
  // Only the bound user's messages come here, and unbinding lets a held burst go: a burst is one person's.
  const worded = text.length > 0 ? now : null;
  if (burst.held === null) {
    burst.held = {
      userId,
      id,
      text: [],
      attachments: [],
      at,
      worded: null,
      last: now,
    };
  }
  const held = burst.held;
  held.text.push(...text);
  held.attachments.push(...attachments);
  if (held.worded === null && worded !== null) {
    held.worded = worded;
  }
  held.last = now;

  const due = heldDue(held, state.protocol);
  burst.seq += 1;
  if (burst.timer !== null) {
    clearTimeout(burst.timer);
    burst.timer = null;
  }
  if (due > now) {
    const seq = burst.seq;
    const delayMs = Math.max(0, Math.ceil(due - now));
    burst.timer = setTimeout(() => {
      void wechatFlush(app, state, seq).catch((error) => {
        state.set("connected", `微信接收暂时失败，正在重试：${errorText(error)}`);
      });
    }, delayMs);
    return;
  }
  await wechatFlush(app, state, null);
}

/** Send the held burst to the main Session: any burst, or only the one `seq` names, when nothing came since. */
async function wechatFlush(app: AppContext, state: WeChatState, seq: number | null): Promise<void> {
  const burst = state.burst;
  if (seq !== null && seq !== burst.seq) {
    return;
  }
  const held = burst.held;
  if (held === null) {
    return;
  }
  burst.held = null;
  if (seq === null) {
    if (burst.timer !== null) {
      clearTimeout(burst.timer);
      burst.timer = null;
    }
  } else {
    burst.timer = null;
  }
  burst.delivering += 1;

  const text = held.text.length === 0 ? FILES_ALONE : held.text.join("\n");
  let ok = false;
  try {
    await app.receiveWeChat(held.id, held.userId, text, held.attachments, held.at);
    ok = true;
  } finally {
    burst.delivering -= 1;
    if (ok && burst.held === null && burst.delivering === 0 && burst.cursor !== null) {
      const cursor = burst.cursor;
      burst.cursor = null;
      app.store.set(CURSOR, cursor);
    }
  }
}

/** Save the poll's cursor, unless messages before it are still held or on their way: then once they are delivered. */
function wechatKeepCursor(app: AppContext, state: WeChatState, cursor: string): void {
  if (state.burst.held !== null || state.burst.delivering > 0) {
    state.burst.cursor = cursor;
  } else {
    state.burst.cursor = null;
    app.store.set(CURSOR, cursor);
  }
}

/**
 * Send a reply to the user it was written for, when that user is still the bound one;
 * the id makes a retry the same message.
 */
export async function wechatDeliver(
  app: AppContext,
  state: WeChatState,
  id: string,
  text: string,
  userId: string,
): Promise<Sent> {
  const account = wechatAccount(app);
  if (account === null || account.userId !== userId) {
    return "gone";
  }
  await state.protocol.sendText(account, text, id);
  return "sent";
}

/** The ticket whose directory holds `filePath`, choosing the deepest match when directories nest. */
function ticketForPath(app: AppContext, filePath: string): Ticket | null {
  let bestTicket: Ticket | null = null;
  let bestDepth = -1;
  for (const ticket of app.store.tickets()) {
    const rawDir = ticket.execution?.directory;
    if (rawDir === undefined || rawDir.length === 0) {
      continue;
    }
    let dir: string;
    try {
      dir = fs.realpathSync(rawDir);
    } catch {
      dir = rawDir;
    }
    if (pathStartsWith(filePath, dir) && dir.length >= bestDepth) {
      bestDepth = dir.length;
      bestTicket = ticket;
    }
  }
  return bestTicket;
}

/** Send a local file to the bound user, after its caption. */
export function wechatSendFile(
  app: AppContext,
  state: WeChatState,
  filePath: string,
  caption?: string,
): Promise<WeChatSendFileResult> {
  return wechatSendTicketFile(app, state, filePath, caption, undefined);
}

/**
 * Send a local file to the bound user, recording a reply receipt when it delivers a ticket's report
 * so Watchdog does not re-relay that report and a duplicate call does not send the file twice.
 */
export async function wechatSendTicketFile(
  app: AppContext,
  state: WeChatState,
  filePath: string,
  caption?: string,
  ticketId?: string,
): Promise<WeChatSendFileResult> {
  const account = wechatAccount(app);
  if (account === null) {
    throw new Error("请先在应用中连接微信");
  }

  const trimmedTicketId = ticketId?.trim();
  let explicit: Ticket | null = null;
  if (trimmedTicketId !== undefined && trimmedTicketId.length > 0) {
    explicit = app.storeTicket(trimmedTicketId);
    if (explicit === null) {
      throw new Error(`Unknown ticket: ${trimmedTicketId}`);
    }
  }

  let info: fs.Stats;
  try {
    info = await fs.promises.stat(filePath);
  } catch (error) {
    throw new Error(`无法读取微信附件：${errorText(error)}`);
  }
  if (!info.isFile()) {
    throw new Error("微信附件路径必须是文件");
  }
  if (info.size > MAX_MEDIA_BYTES) {
    throw new Error("微信附件不能超过 100 MiB");
  }

  let canonical: string;
  try {
    canonical = await fs.promises.realpath(filePath);
  } catch {
    canonical = filePath;
  }

  const base = path.basename(filePath);
  const name = base.length > 0 && base !== "/" && base !== "." && base !== ".." ? base : "file.bin";

  const ticket = explicit ?? ticketForPath(app, canonical) ?? ticketForPath(app, filePath);
  let receipt: { ticketId: string; reportAt: string; id: string } | undefined;
  if (ticket !== null) {
    const report = latestReport(ticket);
    if (report !== undefined) {
      const id = key(["wechat-file", ticket.id, report.at, canonical]);
      receipt = { ticketId: ticket.id, reportAt: report.at, id };
    }
  }

  if (receipt !== undefined && app.store.replyStatus(receipt.id) === "sent") {
    return { sent: true, reused: true, name };
  }

  let data: Uint8Array;
  try {
    const buffer = await fs.promises.readFile(canonical);
    data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch (error) {
    throw new Error(`无法读取微信附件：${errorText(error)}`);
  }
  if (data.byteLength > MAX_MEDIA_BYTES) {
    throw new Error("微信附件不能超过 100 MiB");
  }

  await state.protocol.sendMedia(
    account,
    data,
    name,
    mimeOf(name),
    caption ?? "",
    receipt?.id,
  );

  if (receipt !== undefined) {
    const party = `wechat:${account.userId}`;
    const trimmedCaption = caption?.trim();
    const text =
      trimmedCaption !== undefined && trimmedCaption.length > 0 ? trimmedCaption : name;
    app.store.recordSentReceipt(
      {
        id: receipt.id,
        channel: {
          source: CHAT_SOURCE,
          thread: party,
          address: {
            surface: "wechat",
            conversation: party,
            sender: party,
          },
        },
        text,
        kind: "reply",
        ticketId: receipt.ticketId,
      },
      receipt.reportAt,
    );
    try {
      app.store.atomic(() => {
        const stored = app.storeTicket(receipt.ticketId);
        if (stored !== null && stored.answers !== undefined && stored.answers.length > 0) {
          delete stored.answers;
          app.store.saveTicket(stored);
        }
      });
    } catch {
      // Best-effort answer clearing matching Rust `let _ = self.store.atomic(...)`.
    }
  }

  return { sent: true, name };
}
