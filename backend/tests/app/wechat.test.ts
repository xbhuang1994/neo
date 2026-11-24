/**
 * The WeChat bridge against a stand-in for WeChat's API on a loopback port: binding by QR code and
 * verification code, messages and encrypted media in both directions, the binding across a restart,
 * and its end.
 *
 * Ported from Rust `neo-app/tests/wechat.rs`.
 */

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  allowedSender,
  CHAT_SOURCE,
  mainSpecs,
  Protocol,
  SIDECAR,
  SIDECAR_SLOW_HINT_ZH,
  type Timings,
  type WeChatStateName,
} from "../../src/app/index.ts";
import { decrypt, encrypt, hex } from "../../src/app/wechat_protocol.ts";
import { key, latestReport } from "../../src/core/index.ts";
import { MockHttpServer, MockResponse, TempDir, type MockRequest } from "../../src/testkit/index.ts";
import { Fixture, messages, openIn, Scripted, type Model } from "./common.ts";

const IMAGE_KEY = new Uint8Array(16).fill(7);
const FILE_KEY = new Uint8Array(16).fill(9);
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PIXEL_BYTES = new Uint8Array(Buffer.from(PIXEL, "base64"));

const UTF8_ENCODER = new TextEncoder();

/** Serialize JSON preserving `bigint` values as exact unquoted JSON integers (e.g. 64-bit IDs). */
function jsonResponse(status: number, value: unknown): MockResponse {
  const raw = JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? `__NEO_BIGINT__${entry.toString()}__` : entry,
  ).replace(/"__NEO_BIGINT__(-?\d+)__"/g, "$1");
  return new MockResponse(status, "application/json", UTF8_ENCODER.encode(raw), []);
}

function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sentFirstText(message: Record<string, unknown>): string | undefined {
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  const first = asRecord(items[0]);
  const textItem = asRecord(first.text_item);
  return typeof textItem.text === "string" ? textItem.text : undefined;
}

function expectThrowsExact(fn: () => unknown, expected: string): void {
  let caught: unknown = undefined;
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw).toBe(true);
  const message = caught instanceof Error ? caught.message : String(caught);
  expect(message).toBe(expected);
}

async function expectRejectsMessage(promise: Promise<unknown>): Promise<string> {
  let caught: unknown = undefined;
  let threw = false;
  try {
    await promise;
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw).toBe(true);
  return caught instanceof Error ? caught.message : String(caught);
}

/** What the stand-in saw and how it should behave. */
interface Seen {
  base: string;
  qrCount: number;
  /** What the status of a login is, until the verification code arrives. */
  login: string;
  confirmed: boolean;
  /** How many of the next questions about a login fail. */
  statusFailures: number;
  delivered: boolean;
  /** What a poll answers instead of messages, such as an expired login. */
  poll: unknown | null;
  /** Messages for the next polls, a batch each, after the first. */
  batches: unknown[][];
  cursors: string[];
  sent: Record<string, unknown>[];
  uploadKey: Uint8Array;
  uploads: Uint8Array[];
  tokens: string[];
  /** The typing statuses sent, in order: 1 to show it, 2 to take it away. */
  typing: number[];
  /** Any assertion failures triggered inside the mock HTTP handler. */
  handlerErrors: Error[];
}

interface WeChat {
  server: MockHttpServer;
  seen: Seen;
  close(): Promise<void>;
}

async function answer(
  seen: Seen,
  request: MockRequest,
  closeSignal: AbortSignal,
): Promise<MockResponse> {
  try {
    const pathname = request.pathname;
    const query = request.query;
    let body: Record<string, unknown> = {};
    if (request.body.byteLength > 0) {
      try {
        body = asRecord(request.json());
      } catch {
        body = {};
      }
    }
    const token = request.headers.get("authorization");
    if (token !== undefined) {
      seen.tokens.push(token);
    }
    const base = seen.base;

    if (request.method === "POST" && pathname === "/ilink/bot/get_bot_qrcode") {
      seen.qrCount += 1;
      const baseInfo = asRecord(body.base_info);
      expect(baseInfo.channel_version).toBe("2.4.10");
      return jsonResponse(200, {
        qrcode: "qr id",
        qrcode_img_content: "weixin://fixture-bind",
      });
    }

    if (request.method === "GET" && pathname === "/ilink/bot/get_qrcode_status") {
      expect(query).toContain("qrcode=qr%20id");
      if (query.includes("verify_code=1234")) {
        seen.confirmed = true;
      }
      if (seen.statusFailures > 0) {
        seen.statusFailures -= 1;
        return MockResponse.bytes(500);
      }
      if (seen.login === "slow") {
        // Held open longer than the client waits, as when nothing happens on the phone.
        await sleepOrAbort(400, closeSignal);
        return jsonResponse(200, { status: "wait" });
      }
      if (seen.confirmed) {
        return jsonResponse(200, {
          status: "confirmed",
          bot_token: "secret-token",
          ilink_bot_id: "fixture-bot",
          ilink_user_id: "bound-user",
          baseurl: base,
        });
      }
      return jsonResponse(200, { status: seen.login });
    }

    if (request.method === "POST" && pathname === "/ilink/bot/getupdates") {
      seen.cursors.push(typeof body.get_updates_buf === "string" ? body.get_updates_buf : "");
      if (seen.poll !== null) {
        return jsonResponse(200, seen.poll);
      }
      if (seen.delivered) {
        const batch = seen.batches.shift();
        if (batch !== undefined) {
          const cursor = `cursor-batch-${seen.cursors.length}`;
          return jsonResponse(200, {
            ret: 0,
            msgs: batch,
            get_updates_buf: cursor,
            longpolling_timeout_ms: 100,
          });
        }
      }
      const text = {
        message_id: 9007199254740993n,
        from_user_id: "bound-user",
        message_type: 1,
        context_token: "context-1",
        create_time_ms: 1_750_000_000_000,
        item_list: [{ type: 1, text_item: { text: "微信文本" } }],
      };
      const media = {
        message_id: "media-1",
        from_user_id: "bound-user",
        message_type: 1,
        context_token: "context-1",
        item_list: [
          { type: 1, text_item: { text: "微信附件" } },
          { type: 3, voice_item: { text: "语音内容" } },
          {
            type: 2,
            image_item: {
              aeskey: hex(IMAGE_KEY),
              media: { full_url: `${base}/cdn/image` },
            },
          },
          {
            type: 4,
            file_item: {
              file_name: "../notes.txt",
              media: {
                full_url: `${base}/cdn/file`,
                aes_key: Buffer.from(hex(FILE_KEY), "utf8").toString("base64"),
              },
            },
          },
          {
            type: 4,
            file_item: {
              file_name: "lost.bin",
              media: { full_url: `${base}/cdn/missing` },
            },
          },
        ],
      };
      const stranger = {
        message_id: "ignored",
        from_user_id: "stranger",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "不得投递" } }],
      };
      const group = {
        message_id: "grouped",
        from_user_id: "bound-user",
        group_id: "g1",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "群里的话" } }],
      };
      const msgs = seen.delivered ? [] : [text, text, stranger, group, media];
      seen.delivered = true;
      // An empty poll leaves the cursor where it was.
      const asked =
        typeof body.get_updates_buf === "string" &&
        body.get_updates_buf.length > 0 &&
        msgs.length === 0
          ? body.get_updates_buf
          : undefined;
      const cursor = asked ?? "cursor-1";
      return jsonResponse(200, {
        ret: 0,
        msgs,
        get_updates_buf: cursor,
        longpolling_timeout_ms: 100,
      });
    }

    if (request.method === "POST" && pathname === "/ilink/bot/getconfig") {
      expect(body.ilink_user_id).toBe("bound-user");
      return jsonResponse(200, { ret: 0, typing_ticket: "typing-ticket" });
    }

    if (request.method === "POST" && pathname === "/ilink/bot/sendtyping") {
      expect([body.ilink_user_id, body.typing_ticket]).toEqual(["bound-user", "typing-ticket"]);
      seen.typing.push(typeof body.status === "number" ? body.status : 0);
      return jsonResponse(200, { ret: 0 });
    }

    if (request.method === "POST" && pathname === "/ilink/bot/sendmessage") {
      seen.sent.push(asRecord(body.msg));
      return jsonResponse(200, { ret: 0, message_id: 9007199254740995n });
    }

    if (request.method === "POST" && pathname === "/ilink/bot/getuploadurl") {
      const aesHex = body.aeskey;
      expect(typeof aesHex).toBe("string");
      const keyBytes = new Uint8Array(16);
      for (let i = 0; i < 16; i += 1) {
        keyBytes[i] = Number.parseInt((aesHex as string).slice(2 * i, 2 * i + 2), 16);
      }
      seen.uploadKey = keyBytes;
      const rawsize = body.rawsize as number;
      const filesize = body.filesize as number;
      expect(filesize).toBe((Math.floor(rawsize / 16) + 1) * 16);
      expect(typeof body.rawfilemd5 === "string" ? body.rawfilemd5.length : undefined).toBe(32);
      return jsonResponse(200, { upload_full_url: `${base}/cdn/upload` });
    }

    if (request.method === "POST" && pathname === "/cdn/upload") {
      expect(seen.uploadKey.byteLength).toBe(16);
      seen.uploads.push(decrypt(request.body, seen.uploadKey));
      const param = `download-${seen.uploads.length}`;
      return MockResponse.bytes(200).header("x-encrypted-param", param);
    }

    if (request.method === "GET" && pathname === "/cdn/image") {
      return MockResponse.bytes(200, encrypt(PIXEL_BYTES, IMAGE_KEY));
    }

    if (request.method === "GET" && pathname === "/cdn/report") {
      return MockResponse.bytes(200, encrypt(UTF8_ENCODER.encode("quarterly numbers"), FILE_KEY));
    }

    if (request.method === "GET" && pathname === "/cdn/file") {
      return MockResponse.bytes(200, encrypt(UTF8_ENCODER.encode("wechat file payload"), FILE_KEY));
    }

    return MockResponse.bytes(404);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    seen.handlerErrors.push(err);
    throw err;
  }
}

async function startWeChat(login: string): Promise<WeChat> {
  const seen: Seen = {
    base: "",
    qrCount: 0,
    login,
    confirmed: false,
    statusFailures: 0,
    delivered: false,
    poll: null,
    batches: [],
    cursors: [],
    sent: [],
    uploadKey: new Uint8Array(0),
    uploads: [],
    tokens: [],
    typing: [],
    handlerErrors: [],
  };
  const closeController = new AbortController();
  const server = await MockHttpServer.start((request) =>
    answer(seen, request, closeController.signal),
  );
  seen.base = server.url;
  return {
    server,
    seen,
    async close(): Promise<void> {
      closeController.abort();
      await server.close();
    },
  };
}

/**
 * The application over the stand-in, with an orchestrator that answers every message in the same
 * turn; each message with words is taken at once.
 */
async function boundTo(wechat: WeChat): Promise<Fixture> {
  return boundWith(wechat, 0, 15_000);
}

/** The same, holding bursts for `quietMs` after words and files alone for `fileWaitMs`. */
async function boundWith(
  wechat: WeChat,
  quietMs: number,
  fileWaitMs: number,
  timings?: Partial<Timings>,
): Promise<Fixture> {
  const kernels = new Scripted();
  kernels.wechat = Protocol.at(wechat.server.url, `${wechat.server.url}/cdn`, {
    paceMs: 20,
    statusWaitMs: 150,
    quietMs,
    burstCapMs: 2_000,
    fileWaitMs,
    typingCheckMs: 20,
    typingOnMs: 100,
    typingOffMs: 60,
  });
  kernels.model = async (turn) => {
    const card = turn.card("kind");
    if (card !== undefined && card.kind === "candidate") {
      await turn.call("orchestrator_route", {
        decisions: [
          {
            kind: "ignore",
            trigger_id: card.trigger_id,
            reason: "Conversation",
            answer: "orchestrator 微信回复",
          },
        ],
      });
    }
    return "Done.";
  };
  const f = openIn(new TempDir("wechat"), kernels, timings);
  try {
    await f.app.start();
    return f;
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}

function state(f: Fixture): WeChatStateName {
  return f.app.wechatStatus().state;
}

/** A file the bound user sends, as WeChat's CDN holds it. */
function report(name: string, base: string): Record<string, unknown> {
  return {
    type: 4,
    file_item: {
      file_name: name,
      media: {
        full_url: `${base}/cdn/report`,
        aes_key: Buffer.from(hex(FILE_KEY), "utf8").toString("base64"),
      },
    },
  };
}

function fromBound(id: string, items: unknown[]): Record<string, unknown> {
  return {
    message_id: id,
    from_user_id: "bound-user",
    message_type: 1,
    context_token: "context-1",
    item_list: items,
  };
}

/** Bound, with the first poll's messages already taken, so only the batches given later arrive. */
async function quietlyBound(
  quietMs: number,
  fileWaitMs: number,
  timings?: Partial<Timings>,
): Promise<[WeChat, Fixture]> {
  const wechat = await startWeChat("need_verifycode");
  try {
    wechat.seen.delivered = true;
    const f = await boundWith(wechat, quietMs, fileWaitMs, timings);
    try {
      await f.app.wechatConnect();
      await f.until("the code is asked for", () => state(f) === "verify");
      f.app.wechatVerify("1234");
      await f.until("the account is bound", () => state(f) === "connected");
      return [wechat, f];
    } catch (error) {
      await f.cleanup();
      throw error;
    }
  } catch (error) {
    await wechat.close();
    throw error;
  }
}

function wechatChat(f: Fixture): string[] {
  return f
    .chat()
    .filter(([source]) => source === "wechat")
    .map(([, text]) => text);
}

describe("wechat bridge integration (ported from neo-app/tests/wechat.rs)", () => {
  test(
    "binds_by_qr_code_and_exchanges_text_images_and_files",
    async () => {
      const wechat = await startWeChat("need_verifycode");
      let f: Fixture | undefined;
      try {
        f = await boundTo(wechat);
        expect(f.app.wechatStatus()).toEqual({
          state: "disconnected",
          message: "尚未连接微信。",
        });
        expectThrowsExact(() => f!.app.wechatVerify("1234"), "当前不需要微信验证码");
        expect(await expectRejectsMessage(f.app.wechatSendFile("/tmp/x"))).toBe(
          "请先在应用中连接微信",
        );

        // Two requests at once start one login; the code to draw is what WeChat said the QR encodes.
        const [first, second] = await Promise.all([
          f.app.wechatConnect(),
          f.app.wechatConnect(),
        ]);
        expect(wechat.seen.qrCount).toBe(1);
        for (const s of [first, second]) {
          expect(["waiting", "verify"]).toContain(s.state);
          expect(s.qrContent).toBe("weixin://fixture-bind");
        }
        await f.until("the code is asked for", () => state(f!) === "verify");
        expect(f.app.wechatStatus().message).toBe("输入手机微信显示的验证码。");
        expectThrowsExact(() => f!.app.wechatVerify("12a4"), "验证码必须为数字");
        const verified = f.app.wechatVerify(" 1234 ");
        expect([verified.state, verified.qrContent]).toEqual([
          "waiting",
          "weixin://fixture-bind",
        ]);
        await f.until("the account is bound", () => state(f!) === "connected");
        const status = f.app.wechatStatus();
        expect(status.senderId).toBe("wechat:bound-user");
        expect("qrContent" in status).toBe(false);
        expect(JSON.stringify(status)).not.toContain("secret-token");
        // The bound user may now write to the application, as the app's own user may.
        expect(allowedSender(f.app.settings(), CHAT_SOURCE, "wechat:bound-user")).toBeDefined();

        // Its messages arrive once each; a stranger's and a group's do not.
        await f.until("both messages were answered", () =>
          wechat.seen.sent.some((message) => sentFirstText(message) === "orchestrator 微信回复"),
        );
        await f.settle();
        const chat = f.chat();
        const fromWeChat = chat
          .filter(([source]) => source === "wechat")
          .map(([, text]) => text);
        expect(fromWeChat).toHaveLength(2);
        expect(fromWeChat[0]).toBe("微信文本");
        const stateDir = f.dir.join("state");
        const image = path.join(stateDir, "attachments/chat-wechat-media-1/1-wechat-media-1.jpg");
        expect(
          fromWeChat[1].startsWith(
            "微信附件\n[语音转写] 语音内容\n[微信附件下载失败：微信 CDN HTTP 404]\n\n",
          ),
        ).toBe(true);
        expect(fromWeChat[1]).toContain(
          `<attachment name="wechat-media-1.jpg" mediaType="image/png" path="${image}">`,
        );
        expect(fromWeChat[1]).toContain(
          '<attachment name=".._notes.txt">\nwechat file payload\n</attachment>',
        );
        expect(new Uint8Array(fs.readFileSync(image))).toEqual(PIXEL_BYTES);
        expect(
          chat.some(([, text]) => text.includes("不得投递") || text.includes("群里的话")),
        ).toBe(false);
        const transcript = JSON.stringify(f.app.chatTranscript());
        const exactIdMatches =
          transcript.split('"requestId":"chat:wechat:9007199254740993"').length - 1;
        expect(exactIdMatches).toBe(1);
        // The message carries the time WeChat gave it, and the person's conversation as its channel.
        const trigger = f.app.store.trigger(
          key(["trigger", CHAT_SOURCE, "wechat:9007199254740993"]),
        );
        expect(trigger).toBeDefined();
        expect([trigger!.at, trigger!.actor.id]).toEqual([
          "2025-06-15T15:06:40.000Z",
          "wechat:bound-user",
        ]);
        expect(trigger!.channel?.thread).toBe("wechat:bound-user");
        // The model saw the image.
        expect(
          f
            .ran("orchestrator")
            .some((ran) => ran.text.includes("Images attached to chat message chat:wechat:media-1:")),
        ).toBe(true);
        // Replies went to the transcript and to WeChat, under the reply's own id and the conversation's token.
        {
          const replies = wechat.seen.sent.filter(
            (message) => sentFirstText(message) === "orchestrator 微信回复",
          );
          expect(replies.length).toBeGreaterThan(0);
          for (const reply of replies) {
            expect([reply.to_user_id, reply.context_token, reply.message_type]).toEqual([
              "bound-user",
              "context-1",
              2,
            ]);
            const clientId = reply.client_id;
            expect(
              typeof clientId === "string" &&
                clientId.startsWith("neo-agent:") &&
                clientId.length > 20,
            ).toBe(true);
          }
          expect(wechat.seen.tokens.every((token) => token === "Bearer secret-token")).toBe(true);
          expect(wechat.seen.cursors[0]).toBe("");
          expect(wechat.seen.cursors[wechat.seen.cursors.length - 1]).toBe("cursor-1");
        }
        expect(
          chat.some(([source, text]) => source === "chat-reply" && text === "orchestrator 微信回复"),
        ).toBe(true);
        expect(f.app.store.get<string>("wechat-cursor")).toBe("cursor-1");

        // Files go out encrypted: any file as a file after its caption, an image as an image.
        const out = path.join(stateDir, "out.bin");
        fs.writeFileSync(out, new Uint8Array([0, 255, 1, 2, 3]));
        expect(await f.app.wechatSendFile(out, "文件说明")).toEqual({
          sent: true,
          name: "out.bin",
        });
        const picture = path.join(stateDir, "pixel.png");
        fs.writeFileSync(picture, PIXEL_BYTES);
        await f.app.wechatSendFile(picture);
        expect(await expectRejectsMessage(f.app.wechatSendFile(stateDir))).toContain("必须是文件");
        expect(
          (await expectRejectsMessage(f.app.wechatSendFile("/nonexistent/file.bin"))).startsWith(
            "无法读取微信附件",
          ),
        ).toBe(true);
        {
          expect(wechat.seen.uploads).toEqual([
            new Uint8Array([0, 255, 1, 2, 3]),
            PIXEL_BYTES,
          ]);
          const tail = wechat.seen.sent.slice(-3).reverse();
          const captionItem = asRecord((tail[2].item_list as unknown[])[0]);
          expect([captionItem.type, asRecord(captionItem.text_item).text]).toEqual([
            1,
            "文件说明",
          ]);
          const file = asRecord((tail[1].item_list as unknown[])[0]);
          const fileItem = asRecord(file.file_item);
          const fileMedia = asRecord(fileItem.media);
          expect([file.type, fileItem.file_name, fileItem.len]).toEqual([4, "out.bin", "5"]);
          expect([fileMedia.encrypt_query_param, fileMedia.encrypt_type]).toEqual([
            "download-1",
            1,
          ]);
          const imageSent = asRecord((tail[0].item_list as unknown[])[0]);
          const imageItem = asRecord(imageSent.image_item);
          const imageMedia = asRecord(imageItem.media);
          expect([imageSent.type, imageMedia.encrypt_query_param]).toEqual([2, "download-2"]);
          expect(
            Buffer.from(imageMedia.aes_key as string, "base64").toString("utf8"),
          ).toBe(hex(wechat.seen.uploadKey));
        }
        // The main Session has the tool for it.
        expect(mainSpecs().some((spec) => spec.name === "wechat_send_file")).toBe(true);

        // After a restart the binding is taken up where it stopped, without a new login.
        const polls = wechat.seen.cursors.length;
        f = await f.restart();
        expect(state(f)).toBe("connected");
        await f.until("polling goes on", () => wechat.seen.cursors.length > polls);
        expect(wechat.seen.cursors[wechat.seen.cursors.length - 1]).toBe("cursor-1");
        expect(wechat.seen.qrCount).toBe(1);
        expect((await f.app.wechatConnect()).message).toBe(
          "微信已连接，可直接与 orchestrator 对话。",
        );
        expect(f.chat().length).toBe(chat.length);

        // Unbinding forgets the account and the sender, and keeps the conversation.
        const disconnected = await f.app.wechatDisconnect();
        expect(disconnected).toEqual({
          state: "disconnected",
          message: "微信已断开，orchestrator 对话记录保留。",
        });
        expect(f.app.store.get("wechat-account")).toBeUndefined();
        expect(f.app.store.get("wechat-cursor")).toBeUndefined();
        expect(allowedSender(f.app.settings(), CHAT_SOURCE, "wechat:bound-user")).toBeUndefined();
        expect(f.chat().length).toBe(chat.length);
        const pollsAfterDisconnect = wechat.seen.cursors.length;
        await Bun.sleep(150);
        expect(wechat.seen.cursors.length).toBeLessThanOrEqual(pollsAfterDisconnect + 1);
        await f.app.stop();
        expect(wechat.seen.handlerErrors).toEqual([]);
      } finally {
        try {
          await f?.cleanup();
        } finally {
          await wechat.close();
        }
      }
    },
    20_000,
  );

  test(
    "says_why_a_login_ended_and_starts_a_new_one_on_request",
    async () => {
      const wechat = await startWeChat("expired");
      let f: Fixture | undefined;
      try {
        f = await boundTo(wechat);
        await f.app.wechatConnect();
        await f.until("the login ended", () => state(f!) === "error");
        expect(f.app.wechatStatus()).toEqual({
          state: "error",
          message: "二维码已过期，请重新连接。",
        });
        // Scanned: waits for the phone; a second request replaces the login with a new code.
        wechat.seen.login = "scaned";
        await f.app.wechatConnect();
        await f.until("it was scanned", () => state(f!) === "scaned");
        expect(f.app.wechatStatus().qrContent).toBe("weixin://fixture-bind");
        expect((await f.app.wechatConnect()).state).toBe("waiting");
        expect(wechat.seen.qrCount).toBe(3);
        wechat.seen.login = "verify_code_blocked";
        await f.until("the code was refused for good", () => state(f!) === "error");
        expect(f.app.wechatStatus().message).toBe("验证码错误次数过多，请重新扫码。");
        // A confirmation without credentials binds nothing.
        wechat.seen.login = "confirmed";
        await f.app.wechatConnect();
        await f.until("the login failed", () => state(f!) === "error");
        expect(f.app.wechatStatus().message).toBe(
          "微信连接失败：扫码确认响应缺少账号凭据或绑定用户",
        );
        expect(f.app.store.get("wechat-account")).toBeUndefined();
        // Stopping in the middle of a login leaves nothing running.
        wechat.seen.login = "wait";
        await f.app.wechatConnect();
        expect(state(f)).toBe("waiting");
        await f.app.stop();
        expect(wechat.seen.handlerErrors).toEqual([]);
      } finally {
        try {
          await f?.cleanup();
        } finally {
          await wechat.close();
        }
      }
    },
    20_000,
  );

  test(
    "stops_listening_when_wechat_ends_the_login_and_retries_other_failures",
    async () => {
      const wechat = await startWeChat("need_verifycode");
      let f: Fixture | undefined;
      try {
        f = await boundTo(wechat);
        await f.app.wechatConnect();
        await f.until("the code is asked for", () => state(f!) === "verify");
        f.app.wechatVerify("1234");
        await f.until("the account is bound", () => state(f!) === "connected");
        await f.until(
          "the first poll was answered",
          () => f!.app.store.get<string>("wechat-cursor") !== undefined,
        );
        // A failure that may pass is retried, and said.
        wechat.seen.poll = { ret: 500, errmsg: "busy" };
        await f.until(
          "the failure shows",
          () => f!.app.wechatStatus().message === "微信接收暂时失败，正在重试：busy",
        );
        expect(state(f)).toBe("connected");
        wechat.seen.poll = null;
        await f.until("it recovered", () => f!.app.wechatStatus().message === "微信已连接。");
        // An ended login is not.
        wechat.seen.poll = { errcode: -14 };
        await f.until("the login is known to be over", () => state(f!) === "error");
        expect(f.app.wechatStatus().message).toBe("微信登录已失效，请断开后重新扫码。");
        const polls = wechat.seen.cursors.length;
        await Bun.sleep(150);
        expect(wechat.seen.cursors.length).toBe(polls);
        // A reply to that user can still be tried while the binding is kept, and a reply to another user never is.
        expect((await f.app.wechatDisconnect()).state).toBe("disconnected");
        await f.app.stop();
        expect(wechat.seen.handlerErrors).toEqual([]);
      } finally {
        try {
          await f?.cleanup();
        } finally {
          await wechat.close();
        }
      }
    },
    20_000,
  );

  test(
    "keeps_a_login_alive_through_slow_and_failed_questions",
    async () => {
      const wechat = await startWeChat("slow");
      let f: Fixture | undefined;
      try {
        f = await boundTo(wechat);
        await f.app.wechatConnect();
        // WeChat answers later than the client waits, several times over: the login still waits for the scan.
        await Bun.sleep(700);
        expect([state(f), f.app.wechatStatus().qrContent]).toEqual([
          "waiting",
          "weixin://fixture-bind",
        ]);
        // A few failed questions in a row are ridden out, and the scan is then seen.
        wechat.seen.statusFailures = 3;
        wechat.seen.login = "scaned";
        await f.until("it was scanned", () => state(f!) === "scaned");
        expect(wechat.seen.statusFailures).toBe(0);
        // More than that in a row ends the login, with the reason.
        wechat.seen.statusFailures = 50;
        await f.until("the login failed", () => state(f!) === "error");
        expect(f.app.wechatStatus().message).toBe("微信连接失败：微信接口 HTTP 500");
        expect(wechat.seen.qrCount).toBe(1);
        await f.app.stop();
        expect(wechat.seen.handlerErrors).toEqual([]);
      } finally {
        try {
          await f?.cleanup();
        } finally {
          await wechat.close();
        }
      }
    },
    20_000,
  );

  test(
    "takes_a_file_and_the_words_after_it_as_one_message",
    async () => {
      const [wechat, f] = await quietlyBound(150, 10_000);
      try {
        const base = wechat.server.url;
        wechat.seen.batches.push([fromBound("burst-1", [report("report.txt", base)])]);
        await Bun.sleep(300);
        // The file alone waits for its words, and its cursor is not saved while it waits.
        expect(wechatChat(f)).toEqual([]);
        const cursorWhileWaiting = f.app.store.get<string>("wechat-cursor");
        expect(
          cursorWhileWaiting !== undefined && cursorWhileWaiting.startsWith("cursor-batch"),
        ).toBe(false);
        wechat.seen.batches.push([
          fromBound("burst-2", [{ type: 1, text_item: { text: "总结这个文件" } }]),
        ]);
        await f.until("the burst arrived", () => wechatChat(f).length > 0);
        await Bun.sleep(300);
        const chat = wechatChat(f);
        expect(chat).toHaveLength(1);
        expect(chat[0].startsWith("总结这个文件\n")).toBe(true);
        expect(chat[0]).toContain(
          '<attachment name="report.txt">\nquarterly numbers\n</attachment>',
        );
        expect(f.app.store.trigger(key(["trigger", CHAT_SOURCE, "wechat:burst-1"]))).toBeDefined();
        await f.until("the cursor is saved", () => {
          const cursor = f.app.store.get<string>("wechat-cursor");
          return cursor !== undefined && cursor.startsWith("cursor-batch");
        });
        await f.app.stop();
        expect(wechat.seen.handlerErrors).toEqual([]);
      } finally {
        try {
          await f.cleanup();
        } finally {
          await wechat.close();
        }
      }
    },
    20_000,
  );

  test(
    "takes_files_alone_once_no_words_come_and_says_so",
    async () => {
      const [wechat, f] = await quietlyBound(150, 300);
      try {
        const base = wechat.server.url;
        wechat.seen.batches.push([
          fromBound("alone-1", [report("a.txt", base)]),
          fromBound("alone-2", [report("b.txt", base)]),
        ]);
        await f.until("the files arrived", () => wechatChat(f).length > 0);
        const chat = wechatChat(f);
        expect(chat).toHaveLength(1);
        expect(chat[0].startsWith("[用户只发送了文件，没有说明要做什么")).toBe(true);
        expect(chat[0]).toContain('<attachment name="a.txt">');
        expect(chat[0]).toContain('<attachment name="b.txt">');
        await f.app.stop();
        expect(wechat.seen.handlerErrors).toEqual([]);
      } finally {
        try {
          await f.cleanup();
        } finally {
          await wechat.close();
        }
      }
    },
    20_000,
  );

  test(
    "takes_what_a_message_quotes",
    async () => {
      const [wechat, f] = await quietlyBound(0, 10_000);
      try {
        const base = wechat.server.url;
        wechat.seen.batches.push([
          fromBound("quote-1", [
            {
              type: 1,
              text_item: { text: "按这个文件处理" },
              ref_msg: { title: "plan.txt", message_item: report("plan.txt", base) },
            },
          ]),
          fromBound("quote-2", [
            {
              type: 1,
              text_item: { text: "好的" },
              ref_msg: {
                message_item: { type: 1, text_item: { text: "明天开会" } },
              },
            },
          ]),
        ]);
        await f.until("both arrived", () => wechatChat(f).length === 2);
        const chat = wechatChat(f);
        expect(chat[0].startsWith("[引用的文件：plan.txt]\n按这个文件处理\n")).toBe(true);
        expect(chat[0]).toContain(
          '<attachment name="plan.txt">\nquarterly numbers\n</attachment>',
        );
        expect(chat[1]).toBe("[引用] 明天开会\n好的");
        await f.app.stop();
        expect(wechat.seen.handlerErrors).toEqual([]);
      } finally {
        try {
          await f.cleanup();
        } finally {
          await wechat.close();
        }
      }
    },
    20_000,
  );

  test(
    "finds_a_file_quoted_by_its_name_alone_among_those_lately_received",
    async () => {
      const [wechat, f] = await quietlyBound(0, 200);
      try {
        const base = wechat.server.url;
        wechat.seen.batches.push([fromBound("named-1", [report("plan.md", base)])]);
        await f.until("the file arrived", () => wechatChat(f).length === 1);
        wechat.seen.batches.push([
          fromBound("named-2", [
            {
              type: 1,
              text_item: { text: "复现这个文档" },
              ref_msg: {
                message_item: { type: 4, file_item: { file_name: "plan.md" } },
              },
            },
          ]),
          fromBound("named-3", [
            {
              type: 1,
              text_item: { text: "还有这个" },
              ref_msg: {
                title: "gone.pdf",
                message_item: { type: 4, file_item: { file_name: "gone.pdf" } },
              },
            },
          ]),
        ]);
        await f.until("the quotes arrived", () => wechatChat(f).length === 3);
        const chat = wechatChat(f);
        expect(chat[1].startsWith("[引用的文件：plan.md]\n复现这个文档\n")).toBe(true);
        expect(chat[1]).toContain(
          '<attachment name="plan.md">\nquarterly numbers\n</attachment>',
        );
        // A file never received is still named, so the window shows what was quoted.
        expect(chat[2]).toBe("[引用的文件：gone.pdf（未能取回文件内容）]\n还有这个");
        await f.app.stop();
        expect(wechat.seen.handlerErrors).toEqual([]);
      } finally {
        try {
          await f.cleanup();
        } finally {
          await wechat.close();
        }
      }
    },
    20_000,
  );

  test(
    "blinks_typing_while_the_orchestrator_works_and_takes_it_away_after",
    async () => {
      const [wechat, f] = await quietlyBound(0, 10_000);
      let held = true;
      try {
        await Bun.sleep(200);
        // Nothing at work: nothing is shown.
        expect(wechat.seen.typing).toEqual([]);
        f.script(async () => {
          while (held) {
            await Bun.sleep(10);
          }
          return "Done.";
        });
        wechat.seen.batches.push([
          fromBound("think-1", [{ type: 1, text_item: { text: "想一想" } }]),
        ]);
        // While the turn runs, "typing" blinks: shown, taken away, shown again, and so on.
        await f.until("typing blinks", () => wechat.seen.typing.length >= 5);
        const blinks = [...wechat.seen.typing];
        expect(blinks.every((status, at) => status === (at % 2 === 0 ? 1 : 2))).toBe(true);
        held = false;
        await f.until(
          "typing is taken away",
          () => wechat.seen.typing[wechat.seen.typing.length - 1] === 2,
        );
        const count = wechat.seen.typing.length;
        await Bun.sleep(250);
        expect(wechat.seen.typing.length).toBe(count);
        await f.app.stop();
        expect(wechat.seen.handlerErrors).toEqual([]);
      } finally {
        held = false;
        try {
          await f.cleanup();
        } finally {
          await wechat.close();
        }
      }
    },
    20_000,
  );

  test(
    "keeps_typing_blinking_and_sends_slow_hint_while_sidecar_runs_after_orchestrator_finishes",
    async () => {
      const [wechat, f] = await quietlyBound(0, 10_000, { sidecarSlowHintMs: 80 });
      let holdSidecar = true;
      try {
        f.script(async (turn) => {
          if (turn.role === "worker") {
            await turn.call("orchestrator_report", {
              state: "ready",
              summary: "控制台已部署。",
              direct_reply: "已完成部署。",
              topic: "部署控制台",
            });
            return "Done.";
          }
          if (turn.role === "sidecar") {
            while (holdSidecar) {
              await Bun.sleep(10);
            }
            await turn.call("sidecar_reply", { text: "在首页驾驶舱可以看到各资产分配比例。" });
            return "Done.";
          }
          for (const msg of messages(turn.text)) {
            if (msg.kind === "candidate" && msg.text === "先帮我部署控制台") {
              await turn.call("orchestrator_route", {
                decisions: [
                  {
                    kind: "accept",
                    trigger_id: msg.trigger_id,
                    title: "部署控制台",
                    worktree_name: "deploy-console",
                    acknowledgement: "收到：部署控制台。",
                  },
                ],
              });
              return "Done.";
            }
            if (msg.kind === "candidate" && msg.text === "在哪里看分配比例？") {
              const related = msg.related_tickets as Record<string, unknown>[];
              await turn.call("orchestrator_route", {
                decisions: [
                  {
                    kind: "sidecar",
                    trigger_id: msg.trigger_id,
                    ticket_id: related[0]!.ticket_id,
                    note: "Read-only UI lookup",
                  },
                ],
              });
              return "Done.";
            }
          }
          return "Done.";
        });

        // First create and finish a ticket so no worker is active during the follow-up sidecar query.
        wechat.seen.batches.push([
          fromBound("setup-1", [{ type: 1, text_item: { text: "先帮我部署控制台" } }]),
        ]);
        await f.until("setup ticket completed", () => f.tickets()[0]?.ended !== undefined);
        await f.settle();
        await f.until(
          "typing cleared after setup",
          () =>
            wechat.seen.typing.length === 0 ||
            wechat.seen.typing[wechat.seen.typing.length - 1] === 2,
        );

        const sentBefore = wechat.seen.sent.length;
        wechat.seen.batches.push([
          fromBound("ask-1", [{ type: 1, text_item: { text: "在哪里看分配比例？" } }]),
        ]);

        // Wait until the orchestrator finished routing and only the sidecar effect is running.
        await f.until(
          "sidecar running with router and workers idle",
          () =>
            f.app.effects.isRunning(SIDECAR) && !f.app.routerThinking() && !f.app.workersBusy(),
        );
        expect(f.app.agentsBusy()).toBe(true);

        // Typing must continue blinking while only the sidecar runs.
        const typingAtRouterIdle = wechat.seen.typing.length;
        await f.until(
          "typing keeps blinking during sidecar",
          () => wechat.seen.typing.length >= typingAtRouterIdle + 3,
        );

        // Slow-query hint must be delivered to WeChat before the sidecar finishes.
        await f.until(
          "slow-query hint sent on WeChat",
          () =>
            wechat.seen.sent
              .slice(sentBefore)
              .some((item) => sentFirstText(item) === SIDECAR_SLOW_HINT_ZH),
        );

        // Release the sidecar and verify the real answer follows the hint and typing stops cleanly.
        holdSidecar = false;
        await f.until(
          "sidecar answer sent on WeChat",
          () => wechat.seen.sent.length >= sentBefore + 2,
        );
        await f.settle();
        expect(wechat.seen.sent.slice(sentBefore).map((item) => sentFirstText(item))).toEqual([
          SIDECAR_SLOW_HINT_ZH,
          "在首页驾驶舱可以看到各资产分配比例。",
        ]);
        await f.until(
          "typing cleared after sidecar finishes",
          () => wechat.seen.typing[wechat.seen.typing.length - 1] === 2,
        );
        const finalTypingCount = wechat.seen.typing.length;
        await Bun.sleep(200);
        expect(wechat.seen.typing.length).toBe(finalTypingCount);
        expect(f.app.agentsBusy()).toBe(false);
        await f.app.stop();
        expect(wechat.seen.handlerErrors).toEqual([]);
      } finally {
        holdSidecar = false;
        try {
          await f.cleanup();
        } finally {
          await wechat.close();
        }
      }
    },
    20_000,
  );

  test(
    "records_a_file_result_receipt_so_watchdog_and_restarts_do_not_resend_it",
    async () => {
      const [wechat, initial] = await quietlyBound(0, 10_000);
      let f = initial;
      try {
        let version = 0;
        const script = (): Model => async (turn) => {
          if (turn.role === "worker") {
            version += 1;
            const rev = version;
            fs.writeFileSync(path.join(turn.cwd, "report.docx"), Buffer.from(`report-v${rev}`));
            fs.writeFileSync(path.join(turn.cwd, "chart.png"), PIXEL_BYTES);
            const cards = messages(turn.text);
            let triggerId: string | undefined;
            for (let i = cards.length - 1; i >= 0; i -= 1) {
              const card = cards[i];
              const nestedTrigger = asRecord(card.trigger);
              if (typeof nestedTrigger.trigger_id === "string") {
                triggerId = nestedTrigger.trigger_id;
                break;
              }
              if (typeof card.trigger_id === "string") {
                triggerId = card.trigger_id;
                break;
              }
            }
            if (triggerId === undefined) {
              throw new Error("the human trigger");
            }
            await turn.call("orchestrator_report", {
              state: "ready",
              reply_to_trigger_id: triggerId,
              summary: `Send report.docx (v${rev}).`,
            });
            return "Ready.";
          }
          if (turn.role === "watchdog") {
            const patrol = turn.card("kind");
            if (patrol === undefined) {
              throw new Error("the patrol");
            }
            const suspects = Array.isArray(patrol.suspects) ? patrol.suspects : [];
            for (const rawSuspect of suspects) {
              const suspect = asRecord(rawSuspect);
              await turn.call("watchdog_intervene", {
                action: "relay_report",
                ticket_id: suspect.ticket_id,
                message: "Missing reply.",
              });
            }
            return "Patrolled.";
          }
          for (const message of messages(turn.text)) {
            if (message.kind === "candidate" && message.text === "给我一份市场调研报告") {
              await turn.call("orchestrator_route", {
                decisions: [
                  {
                    kind: "accept",
                    trigger_id: message.trigger_id,
                    title: "市场调研报告",
                    worktree_name: "market-report",
                    acknowledgement: "收到：准备市场调研报告。",
                  },
                ],
              });
            } else if (message.kind === "candidate") {
              const related = Array.isArray(message.related_tickets) ? message.related_tickets : [];
              const ticketId = asRecord(related[0]).ticket_id;
              await turn.call("orchestrator_route", {
                decisions: [
                  {
                    kind: "attach",
                    trigger_id: message.trigger_id,
                    ticket_id: ticketId,
                    acknowledgement: "收到：补充后重发报告。",
                  },
                ],
              });
            } else if (message.kind === "worker_report" && message.state === "ready") {
              const ticketId = asRecord(message.ticket).ticket_id as string;
              const card = await turn.call("orchestrator_read", {
                resource: `ticket/${ticketId}`,
              });
              const reportPath = `${card.directory as string}/report.docx`;
              // Omit ticket_id: the ticket is resolved from its directory.
              await turn.call("wechat_send_file", {
                path: reportPath,
                caption: "这是最新版报告。",
              });
            }
          }
          return "Done.";
        };

        f.script(script());
        const readyRelays = (fixture: Fixture): number =>
          fixture
            .ran("orchestrator")
            .filter((ran) =>
              messages(ran.text).some(
                (message) => message.kind === "worker_report" && message.state === "ready",
              ),
            ).length;

        wechat.seen.batches.push([
          fromBound("ask-1", [{ type: 1, text_item: { text: "给我一份市场调研报告" } }]),
        ]);
        await f.until("the file was uploaded", () => wechat.seen.uploads.length === 1);
        await f.settle();
        expect(wechat.seen.uploads).toEqual([new Uint8Array(Buffer.from("report-v1"))]);
        expect(readyRelays(f)).toBe(1);
        expect(f.ticket(0).answers ?? []).toEqual([]);

        // Watchdog sees the file receipt as the report's reply: neither auto-nudges nor patrols re-relay it.
        for (let i = 0; i < 3; i += 1) {
          await f.app.watchdogTick();
          await f.settle();
        }
        expect(readyRelays(f)).toBe(1);
        expect(f.ran("watchdog")).toEqual([]);
        expect(wechat.seen.uploads.length).toBe(1);

        // Across a server restart and a fresh orchestrator session, Watchdog stays quiet and a duplicate file send is a no-op.
        f = await f.restart();
        f.script(script());
        await f.app.resetOrchestrator();
        await f.app.watchdogTick();
        await f.settle();
        expect(f.ran("watchdog")).toEqual([]);
        const ticket = f.ticket(0);
        const dir = ticket.execution!.directory;
        const reportPath = `${dir}/report.docx`;
        expect(await f.app.wechatSendFile(reportPath, "这是最新版《市场调研报告》。")).toEqual({
          sent: true,
          reused: true,
          name: "report.docx",
        });
        expect(
          await f.app.wechatSendTicketFile(reportPath, "又发一次", ticket.id),
        ).toEqual({
          sent: true,
          reused: true,
          name: "report.docx",
        });
        expect(
          await expectRejectsMessage(
            f.app.wechatSendTicketFile(reportPath, undefined, "missing"),
          ),
        ).toBe("Unknown ticket: missing");
        expect(wechat.seen.uploads.length).toBe(1);

        // A companion file for the same report still goes out once.
        const chartPath = `${dir}/chart.png`;
        expect(
          await f.app.wechatSendTicketFile(chartPath, undefined, ticket.id),
        ).toEqual({
          sent: true,
          name: "chart.png",
        });
        expect(
          await f.app.wechatSendTicketFile(chartPath, undefined, ticket.id),
        ).toEqual({
          sent: true,
          reused: true,
          name: "chart.png",
        });
        expect(wechat.seen.uploads.length).toBe(2);

        // A human follow-up that produces a newer ready report sends the updated file of the same name.
        wechat.seen.batches.push([
          fromBound("ask-2", [{ type: 1, text_item: { text: "补充第 5.3 节后再发我" } }]),
        ]);
        await f.until("the updated file was uploaded", () => wechat.seen.uploads.length === 3);
        await f.settle();
        expect(wechat.seen.uploads[2]).toEqual(new Uint8Array(Buffer.from("report-v2")));
        expect(f.ticket(0).answers ?? []).toEqual([]);
        await f.app.watchdogTick();
        await f.settle();
        expect(f.ran("watchdog")).toEqual([]);
        await f.app.stop();
        expect(wechat.seen.handlerErrors).toEqual([]);
      } finally {
        try {
          await f.cleanup();
        } finally {
          await wechat.close();
        }
      }
    },
    20_000,
  );

  test(
    "clears_answers_after_wechat_file_delivery_so_resumed_progress_never_nudges",
    async () => {
      const [wechat, f] = await quietlyBound(0, 10_000);
      try {
        let phase = 0;
        f.script(async (turn) => {
          if (turn.role === "worker") {
            const step = phase;
            phase += 1;
            if (step === 0) {
              fs.writeFileSync(path.join(turn.cwd, "report.docx"), Buffer.from("report-v1"));
              const cards = messages(turn.text);
              let triggerId: string | undefined;
              for (let i = cards.length - 1; i >= 0; i -= 1) {
                const card = cards[i];
                const nestedTrigger = asRecord(card.trigger);
                if (typeof nestedTrigger.trigger_id === "string") {
                  triggerId = nestedTrigger.trigger_id;
                  break;
                }
                if (typeof card.trigger_id === "string") {
                  triggerId = card.trigger_id;
                  break;
                }
              }
              if (triggerId === undefined) {
                throw new Error("the human trigger");
              }
              await turn.call("orchestrator_report", {
                state: "ready",
                reply_to_trigger_id: triggerId,
                summary: "Send report.docx.",
              });
            } else {
              turn.jobs.push(Fixture.job("bg_1", "bash", "sleep 10"));
              await turn.call("orchestrator_report", {
                state: "progress",
                summary: "Running v2 training.",
              });
            }
            return "Done.";
          }
          if (turn.role === "watchdog") {
            return "Healthy.";
          }
          for (const message of messages(turn.text)) {
            if (message.kind === "candidate" && message.text === "生成第一版报告") {
              await turn.call("orchestrator_route", {
                decisions: [
                  {
                    kind: "accept",
                    trigger_id: message.trigger_id,
                    title: "报告研究",
                    worktree_name: "report-research",
                    acknowledgement: "收到。",
                  },
                ],
              });
            } else if (message.kind === "candidate") {
              const related = Array.isArray(message.related_tickets) ? message.related_tickets : [];
              const ticketId = asRecord(related[0]).ticket_id;
              await turn.call("orchestrator_route", {
                decisions: [
                  {
                    kind: "attach",
                    trigger_id: message.trigger_id,
                    ticket_id: ticketId,
                    acknowledgement: "收到：继续第二版。",
                  },
                ],
              });
            } else if (message.kind === "worker_report" && message.state === "ready") {
              const ticketId = asRecord(message.ticket).ticket_id as string;
              const card = await turn.call("orchestrator_read", {
                resource: `ticket/${ticketId}`,
              });
              const reportPath = `${card.directory as string}/report.docx`;
              await turn.call("wechat_send_file", {
                path: reportPath,
                caption: "已发送报告。",
                ticket_id: ticketId,
              });
            }
          }
          return "Done.";
        });

        const progressRelays = (fixture: Fixture): number =>
          fixture
            .ran("orchestrator")
            .filter((ran) =>
              messages(ran.text).some(
                (message) => message.kind === "worker_report" && message.state === "progress",
              ),
            ).length;

        wechat.seen.batches.push([
          fromBound("ask-1", [{ type: 1, text_item: { text: "生成第一版报告" } }]),
        ]);
        await f.until("first report uploaded", () => wechat.seen.uploads.length === 1);
        await f.settle();
        expect(f.ticket(0).answers ?? []).toEqual([]);

        wechat.seen.batches.push([
          fromBound("ask-2", [{ type: 1, text_item: { text: "继续第二版" } }]),
        ]);
        await f.until(
          "progress report recorded",
          () => latestReport(f.ticket(0))?.summary === "Running v2 training.",
        );
        await f.settle();

        for (let i = 0; i < 3; i += 1) {
          await f.app.watchdogTick();
          await f.settle();
        }
        expect(progressRelays(f)).toBe(0);
        await f.app.stop();
        expect(wechat.seen.handlerErrors).toEqual([]);
      } finally {
        try {
          await f.cleanup();
        } finally {
          await wechat.close();
        }
      }
    },
    20_000,
  );
});
