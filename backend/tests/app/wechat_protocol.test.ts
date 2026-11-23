import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import net from "node:net";
import {
  API_URL,
  BOT_AGENT,
  CDN_URL,
  CHANNEL_VERSION,
  CLIENT_VERSION,
  MAX_MEDIA_BYTES,
  Protocol,
  WeChatProtocolError,
  decrypt,
  encodeQuery,
  encrypt,
  hex,
  idText,
  imageMime,
  md5Hex,
  mediaKey,
  mimeOf,
  parseWeChatJson,
  safeName,
  unhex,
} from "../../src/app/wechat_protocol.ts";
import type { Account, JsonObject } from "../../src/app/wechat_protocol.ts";

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("wechat_protocol crypto, encoding, and helpers (ported from Rust #[cfg(test)])", () => {
  test("digests with MD5 as the reference vectors say", () => {
    expect(md5Hex(new Uint8Array(0))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(Buffer.from("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex(Buffer.from("The quick brown fox jumps over the lazy dog"))).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
    expect(
      md5Hex(
        Buffer.from(
          "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
        ),
      ),
    ).toBe("57edf4a22be3c955ac49da2e2107b67a");
    // Lengths around the padding boundary.
    expect(md5Hex(new Uint8Array(55).fill(0x61))).toBe("ef1772b6dff9a122358552954ad0df65");
    expect(md5Hex(new Uint8Array(56).fill(0x61))).toBe("3b0c8ac703f828b04c6c197006d17218");
    expect(md5Hex(new Uint8Array(64).fill(0x61))).toBe("014842d480b571495a4a0363793f7367");
    // Respects Uint8Array subarray byteOffset/byteLength.
    const backing = Buffer.from("XXabcYY");
    expect(md5Hex(backing.subarray(2, 5))).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  test("encrypts as AES-128-ECB with PKCS#7 padding and back", () => {
    // FIPS-197 appendix C.1: one block, then a whole block of padding.
    const key = unhex("000102030405060708090a0b0c0d0e0f");
    expect(key).not.toBeNull();
    const plain = unhex("00112233445566778899aabbccddeeff");
    expect(plain).not.toBeNull();

    const encrypted = encrypt(plain!, key!);
    expect(hex(encrypted.subarray(0, 16))).toBe("69c4e0d86a7b0430d8cdb78070b4c55a");
    expect(encrypted.byteLength).toBe(32);
    expect(decrypt(encrypted, key!)).toEqual(plain!);

    for (const length of [0, 1, 15, 16, 17, 1000]) {
      const data = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        data[i] = (i * 7) & 0xff;
      }
      const enc = encrypt(data, key!);
      expect(enc.byteLength).toBe((Math.floor(length / 16) + 1) * 16);
      expect(decrypt(enc, key!)).toEqual(data);
    }

    // Subarray view round-trip.
    const paddedKey = new Uint8Array(20);
    paddedKey.set(key!, 2);
    const paddedPlain = new Uint8Array(24);
    paddedPlain.set(plain!, 4);
    const viewEnc = encrypt(paddedPlain.subarray(4, 20), paddedKey.subarray(2, 18));
    expect(hex(viewEnc.subarray(0, 16))).toBe("69c4e0d86a7b0430d8cdb78070b4c55a");
    expect(decrypt(viewEnc, paddedKey.subarray(2, 18))).toEqual(plain!);

    // Error cases with exact Chinese messages from Rust.
    expect(() => decrypt(encrypted.subarray(0, 20), key!)).toThrow("微信媒体密文长度无效");
    expect(() => decrypt(new Uint8Array(16), key!)).toThrow("微信媒体解密失败");
    expect(() => decrypt(new Uint8Array(0), key!)).toThrow("微信媒体密文长度无效");
    expect(() => encrypt(plain!, new Uint8Array(15))).toThrow("微信媒体 AES 密钥格式无效");
    expect(() => decrypt(encrypted, new Uint8Array(15))).toThrow("微信媒体 AES 密钥格式无效");
  });

  test("reads a media key in either encoding", () => {
    const key = new Uint8Array(16).fill(9);
    const b64Raw = Buffer.from(key).toString("base64");
    const b64Hex = Buffer.from(hex(key), "utf8").toString("base64");

    expect(mediaKey(b64Raw)).toEqual(key);
    expect(mediaKey(`  ${b64Raw}\n`)).toEqual(key);
    expect(mediaKey(b64Hex)).toEqual(key);
    expect(mediaKey(Buffer.from(hex(key).toUpperCase(), "utf8").toString("base64"))).toEqual(key);

    expect(() => mediaKey(Buffer.from(new Uint8Array(8).fill(1)).toString("base64"))).toThrow(
      "微信媒体 AES 密钥格式无效",
    );
    expect(() => mediaKey(Buffer.from("z".repeat(32), "utf8").toString("base64"))).toThrow(
      "微信媒体 AES 密钥格式无效",
    );
    expect(() => mediaKey("not base64!")).toThrow("微信媒体 AES 密钥格式无效");
    // Missing padding and embedded whitespace must be rejected (strict RFC 4648 STANDARD).
    expect(() => mediaKey(b64Raw.replace(/=+$/, ""))).toThrow("微信媒体 AES 密钥格式无效");
    expect(() => mediaKey(`${b64Raw.slice(0, 8)}\n${b64Raw.slice(8)}`)).toThrow(
      "微信媒体 AES 密钥格式无效",
    );
    // Non-canonical trailing bits must be rejected.
    expect(() => mediaKey(`${b64Raw.slice(0, 21)}B==`)).toThrow("微信媒体 AES 密钥格式无效");
  });

  test("hex and unhex reject odd-length or non-hex inputs", () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xa5, 0xff]);
    expect(hex(bytes)).toBe("000fa5ff");
    expect(unhex("000fa5ff")).toEqual(bytes);
    expect(unhex("000FA5FF")).toEqual(bytes);
    expect(unhex("")).toEqual(new Uint8Array(0));
    expect(unhex("abc")).toBeNull();
    expect(unhex("zzzz")).toBeNull();
    expect(unhex("0g")).toBeNull();
    expect(unhex("+1")).toBeNull();
  });

  test("names files safely and knows their types", () => {
    expect(safeName("../notes.txt", "file.bin")).toBe(".._notes.txt");
    expect(safeName(" a\\b\u0007c ", "file.bin")).toBe("a_b_c");
    expect(safeName("   ", "file.bin")).toBe("file.bin");
    expect(safeName(null, "file.bin")).toBe("file.bin");
    expect(safeName(undefined, "file.bin")).toBe("file.bin");
    expect(Array.from(safeName("长".repeat(300), "x")).length).toBe(200);
    // Astral Unicode scalar values (surrogate pairs) must also count as 200 scalar values.
    expect(Array.from(safeName("😀".repeat(250), "x")).length).toBe(200);
    // C1 control characters (U+007F..U+009F) are replaced too.
    expect(safeName("a\u007fb\u0085c", "file.bin")).toBe("a_b_c");

    expect([mimeOf("A.PNG"), mimeOf("notes.md"), mimeOf("archive"), mimeOf("x.unknown")]).toEqual([
      "image/png",
      "text/markdown",
      "application/octet-stream",
      "application/octet-stream",
    ]);
    expect(mimeOf("report.DOCX")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(mimeOf("sheet.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(mimeOf("clip.mov")).toBe("video/quicktime");

    expect(imageMime(PIXEL_PNG)).toBe("image/png");
    expect(imageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageMime(Buffer.from("GIF87a..."))).toBe("image/gif");
    expect(imageMime(Buffer.from("GIF89a..."))).toBe("image/gif");
    expect(imageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(imageMime(Buffer.from("plain"))).toBe("application/octet-stream");
  });

  test("keeps 64-bit ids exact and encodes query values", () => {
    const parsed = parseWeChatJson(
      '{"message_id":9007199254740993,"u64_max":18446744073709551615,"neg":-9007199254740993,"safe":42,"other":"abc","none":null,"empty":""}',
    ) as JsonObject;
    expect(idText(parsed.message_id)).toBe("9007199254740993");
    expect(idText(parsed.u64_max)).toBe("18446744073709551615");
    expect(idText(parsed.neg)).toBe("-9007199254740993");
    expect(idText(parsed.safe)).toBe("42");
    expect(idText(parsed.other)).toBe("abc");
    expect(idText(parsed.none)).toBeUndefined();
    expect(idText(parsed.empty)).toBeUndefined();
    expect(idText(9007199254740993n)).toBe("9007199254740993");
    // Parsed result stays JSON-serializable without BigInt TypeError.
    expect(() => JSON.stringify(parsed)).not.toThrow();

    expect(encodeQuery("a b&c=d/é~")).toBe("a%20b%26c%3Dd%2F%C3%A9~");
    // Unlike JS encodeURIComponent, RFC 3986 encodes ! ' ( ) * as well.
    expect(encodeQuery("a!b'c(d)e*f-_.~")).toBe("a%21b%27c%28d%29e%2Af-_.~");
  });

  test("Protocol defaults and Protocol.at normalize URLs and match Rust defaults", () => {
    const def = new Protocol();
    expect(def.apiBase).toBe(API_URL);
    expect(def.cdnBase).toBe(CDN_URL);
    expect(def.paceMs).toBe(1_000);
    expect(def.statusWaitMs).toBe(45_000);
    expect(def.quietMs).toBe(1_500);
    expect(def.burstCapMs).toBe(6_000);
    expect(def.fileWaitMs).toBe(15_000);
    expect(def.typingCheckMs).toBe(250);
    expect(def.typingOnMs).toBe(2_000);
    expect(def.typingOffMs).toBe(1_000);

    const custom = Protocol.at("http://127.0.0.1:9000///", "http://127.0.0.1:9000/cdn/", {
      statusWaitMs: 250,
    });
    expect(custom.apiBase).toBe("http://127.0.0.1:9000");
    expect(custom.cdnBase).toBe("http://127.0.0.1:9000/cdn");
    expect(custom.statusWaitMs).toBe(250);
  });
});

interface RecordedRequest {
  method: string;
  pathname: string;
  search: string;
  headers: Record<string, string>;
  bodyBytes: Uint8Array;
  bodyJson: unknown;
}

describe("wechat_protocol HTTP/JSON & CDN wire round-trips", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl = "";
  let recorded: RecordedRequest[] = [];
  let handler: (req: Request, rec: RecordedRequest) => Response | Promise<Response>;

  const account = (): Account => ({
    token: "secret-bot-token",
    accountId: "bot-01",
    userId: "bound-user",
    baseUrl,
    contextToken: "ctx-token-1",
  });

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const bodyBytes = new Uint8Array(await req.arrayBuffer());
        let bodyJson: unknown = null;
        if (bodyBytes.byteLength > 0) {
          try {
            bodyJson = JSON.parse(Buffer.from(bodyBytes).toString("utf8"));
          } catch {
            bodyJson = null;
          }
        }
        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        const rec: RecordedRequest = {
          method: req.method,
          pathname: url.pathname,
          search: url.search,
          headers,
          bodyBytes,
          bodyJson,
        };
        recorded.push(rec);
        return handler(req, rec);
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  beforeEach(() => {
    recorded = [];
    handler = () => new Response("not mocked", { status: 404 });
  });

  function assertApiHeaders(headers: Record<string, string>, expectedToken?: string): void {
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["authorizationtype"]).toBe("ilink_bot_token");
    expect(headers["ilink-app-id"]).toBe("bot");
    expect(headers["ilink-app-clientversion"]).toBe(String(CLIENT_VERSION));
    const uinRaw = headers["x-wechat-uin"];
    expect(uinRaw).toBeDefined();
    const uinDecoded = Buffer.from(uinRaw!, "base64").toString("utf8");
    expect(/^\d+$/.test(uinDecoded)).toBe(true);
    const uinNumber = Number(uinDecoded);
    expect(uinNumber).toBeGreaterThanOrEqual(0);
    expect(uinNumber).toBeLessThanOrEqual(0xffffffff);
    if (expectedToken !== undefined) {
      expect(headers["authorization"]).toBe(`Bearer ${expectedToken}`);
    } else {
      expect(headers["authorization"]).toBeUndefined();
    }
  }

  test("createQr sends exact path, headers, base_info, and handles invalid/error responses", async () => {
    const protocol = Protocol.at(baseUrl, `${baseUrl}/cdn`);
    handler = () =>
      Response.json({
        qrcode: "qr id/1",
        qrcode_img_content: "weixin://bind-url",
      });

    const qr = await protocol.createQr();
    expect(qr).toEqual({ id: "qr id/1", url: "weixin://bind-url" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].pathname).toBe("/ilink/bot/get_bot_qrcode");
    expect(recorded[0].search).toBe("?bot_type=3");
    assertApiHeaders(recorded[0].headers);
    expect(recorded[0].bodyJson).toEqual({
      local_token_list: [],
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
    });

    // Missing qrcode_img_content.
    handler = () => Response.json({ qrcode: "only-id" });
    await expect(protocol.createQr()).rejects.toThrow("微信未返回有效二维码");

    // Non-2xx status.
    handler = () => new Response("boom", { status: 502 });
    await expect(protocol.createQr()).rejects.toThrow("微信接口 HTTP 502");

    // Unparseable response body.
    handler = () => new Response("not-json", { status: 200 });
    await expect(protocol.createQr()).rejects.toThrow("微信接口返回了无法解析的内容");
  });

  test("qrStatus encodes qrcode and verify_code, converts timeout to wait, and propagates external abort", async () => {
    const protocol = Protocol.at(baseUrl, `${baseUrl}/cdn`, { statusWaitMs: 120 });
    handler = () => Response.json({ status: "confirmed", bot_token: "tok" });

    const res = await protocol.qrStatus("qr id", baseUrl, "1234");
    expect(res).toEqual({ status: "confirmed", bot_token: "tok" });
    expect(recorded[0].method).toBe("GET");
    expect(recorded[0].pathname).toBe("/ilink/bot/get_qrcode_status");
    expect(recorded[0].search).toBe("?qrcode=qr%20id&verify_code=1234");
    assertApiHeaders(recorded[0].headers);

    // Without verifyCode omits &verify_code.
    await protocol.qrStatus("qr+1", baseUrl);
    expect(recorded[1].search).toBe("?qrcode=qr%2B1");

    // Timeout returns { status: "wait" }.
    handler = async () => {
      await Bun.sleep(400);
      return Response.json({ status: "late" });
    };
    const timedOut = await protocol.qrStatus("qr id", baseUrl);
    expect(timedOut).toEqual({ status: "wait" });

    // External AbortSignal rejects with aborted error instead of { status: "wait" }.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    let caught: unknown;
    try {
      await protocol.qrStatus("qr id", baseUrl, undefined, ac.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WeChatProtocolError);
    expect((caught as WeChatProtocolError).isAborted).toBe(true);
  });

  test("updates preserves 64-bit message_id across wire, converts timeout to empty poll, and respects AbortSignal", async () => {
    const protocol = Protocol.at(baseUrl, `${baseUrl}/cdn`);
    handler = () =>
      new Response(
        '{"ret":0,"get_updates_buf":"cursor-2","msgs":[{"message_id":9007199254740993,"message_type":1,"item_list":[{"type":1,"text_item":{"text":"你好"}}]}]}',
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const poll = (await protocol.updates(account(), "cursor-1", 2_000)) as JsonObject;
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].pathname).toBe("/ilink/bot/getupdates");
    assertApiHeaders(recorded[0].headers, "secret-bot-token");
    expect(recorded[0].bodyJson).toEqual({
      get_updates_buf: "cursor-1",
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
    });
    const msgs = poll.msgs as JsonObject[];
    expect(idText(msgs[0].message_id)).toBe("9007199254740993");

    // Timeout returns empty poll with the same cursor.
    handler = async () => {
      await Bun.sleep(300);
      return Response.json({ ret: 0, msgs: [] });
    };
    const emptyPoll = await protocol.updates(account(), "cursor-stay", 80);
    expect(emptyPoll).toEqual({ ret: 0, msgs: [], get_updates_buf: "cursor-stay" });

    // External abort must NOT return an empty poll.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    let abortedErr: unknown;
    try {
      await protocol.updates(account(), "cursor-stay", 2_000, ac.signal);
    } catch (err) {
      abortedErr = err;
    }
    expect(abortedErr).toBeInstanceOf(WeChatProtocolError);
    expect((abortedErr as WeChatProtocolError).isAborted).toBe(true);
  });

  test("typingTicket and sendTyping serialize exact payloads and handle errors", async () => {
    const protocol = Protocol.at(baseUrl, `${baseUrl}/cdn`);
    handler = (_req, rec) => {
      if (rec.pathname === "/ilink/bot/getconfig") {
        return Response.json({ ret: 0, typing_ticket: "ticket-xyz" });
      }
      if (rec.pathname === "/ilink/bot/sendtyping") {
        return Response.json({ ret: 0 });
      }
      return new Response(null, { status: 404 });
    };

    const ticket = await protocol.typingTicket(account());
    expect(ticket).toBe("ticket-xyz");
    expect(recorded[0].bodyJson).toEqual({
      ilink_user_id: "bound-user",
      context_token: "ctx-token-1",
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
    });

    // Account without contextToken sends explicit null (matching Rust Option::None in serde_json::json!).
    const noCtx: Account = { ...account(), contextToken: undefined };
    await protocol.typingTicket(noCtx);
    expect(recorded[1].bodyJson).toEqual({
      ilink_user_id: "bound-user",
      context_token: null,
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
    });

    await protocol.sendTyping(account(), "ticket-xyz", true);
    expect(recorded[2].bodyJson).toEqual({
      ilink_user_id: "bound-user",
      typing_ticket: "ticket-xyz",
      status: 1,
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
    });

    await protocol.sendTyping(account(), "ticket-xyz", false);
    expect(recorded[3].bodyJson).toEqual({
      ilink_user_id: "bound-user",
      typing_ticket: "ticket-xyz",
      status: 2,
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
    });

    // Error branches.
    handler = () => Response.json({ ret: -1 });
    await expect(protocol.typingTicket(account())).rejects.toThrow("微信未返回输入状态凭证：无说明");
    await expect(protocol.sendTyping(account(), "t", true)).rejects.toThrow(
      "微信输入状态失败：ret=-1",
    );

    handler = () => Response.json({ ret: 5, errmsg: "expired ticket" });
    await expect(protocol.typingTicket(account())).rejects.toThrow(
      "微信未返回输入状态凭证：expired ticket",
    );
    await expect(protocol.sendTyping(account(), "t", true)).rejects.toThrow(
      "微信输入状态失败：expired ticket",
    );
  });

  test("sendText skips empty strings, sends exact message shape, and handles errors", async () => {
    const protocol = Protocol.at(baseUrl, `${baseUrl}/cdn`);
    handler = () => Response.json({ ret: 0 });

    // Empty text makes zero HTTP requests.
    await protocol.sendText(account(), "");
    expect(recorded).toHaveLength(0);

    await protocol.sendText(account(), "hello world", "msg-42");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].pathname).toBe("/ilink/bot/sendmessage");
    assertApiHeaders(recorded[0].headers, "secret-bot-token");
    expect(recorded[0].bodyJson).toEqual({
      msg: {
        from_user_id: "",
        to_user_id: "bound-user",
        client_id: "neo-agent:msg-42",
        message_type: 2,
        message_state: 2,
        context_token: "ctx-token-1",
        item_list: [{ type: 1, text_item: { text: "hello world" } }],
      },
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
    });

    // Omitted messageId generates a neo-agent:<uuid-v4> client_id.
    await protocol.sendText({ ...account(), contextToken: undefined }, "auto id");
    const sent = recorded[1].bodyJson as { msg: { client_id: string; context_token: unknown } };
    expect(sent.msg.client_id).toMatch(
      /^neo-agent:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(sent.msg.context_token).toBeNull();

    handler = () => Response.json({ ret: 4001, errmsg: "rate limited" });
    await expect(protocol.sendText(account(), "fail")).rejects.toThrow("微信发送失败：rate limited");

    handler = () => Response.json({ ret: 4002 });
    await expect(protocol.sendText(account(), "fail")).rejects.toThrow("微信发送失败：ret=4002");
  });

  test("sendMedia uploads encrypted image/video/file with caption, verifies AES/MD5, and retries CDN once", async () => {
    const protocol = Protocol.at(baseUrl, `${baseUrl}/cdn`);
    let lastAesKeyHex = "";
    let lastFileKey = "";
    let uploadAttempts = 0;
    const uploadedPlaintexts: Uint8Array[] = [];
    const sentMessages: JsonObject[] = [];

    handler = (_req, rec) => {
      if (rec.pathname === "/ilink/bot/getuploadurl") {
        const body = rec.bodyJson as JsonObject;
        lastAesKeyHex = body.aeskey as string;
        lastFileKey = body.filekey as string;
        expect(lastAesKeyHex).toMatch(/^[0-9a-f]{32}$/);
        expect(lastFileKey).toMatch(/^[0-9a-f]{32}$/);
        expect(body.no_need_thumb).toBe(true);
        expect(body.to_user_id).toBe("bound-user");
        // Test upload_param fallback for images, upload_full_url for video & files.
        if (body.media_type === 1) {
          return Response.json({ upload_param: "up/param 1" });
        }
        return Response.json({ upload_full_url: `${baseUrl}/cdn/direct-upload` });
      }
      if (rec.pathname === "/cdn/upload" || rec.pathname === "/cdn/direct-upload") {
        uploadAttempts += 1;
        expect(rec.headers["content-type"]).toBe("application/octet-stream");
        expect(rec.headers["authorization"]).toBeUndefined();
        if (rec.pathname === "/cdn/upload") {
          expect(rec.search).toBe(
            `?encrypted_query_param=up%2Fparam%201&filekey=${encodeQuery(lastFileKey)}`,
          );
        }
        // Fail the first attempt to verify retry logic.
        if (uploadAttempts === 1) {
          return new Response("temporary error", { status: 503 });
        }
        const key = unhex(lastAesKeyHex)!;
        uploadedPlaintexts.push(decrypt(rec.bodyBytes, key));
        return new Response(null, {
          status: 200,
          headers: { "x-encrypted-param": `dl-param-${uploadedPlaintexts.length}` },
        });
      }
      if (rec.pathname === "/ilink/bot/sendmessage") {
        const body = rec.bodyJson as { msg: JsonObject };
        sentMessages.push(body.msg);
        return Response.json({ ret: 0 });
      }
      return new Response(null, { status: 404 });
    };

    // 1. Image with caption (triggers CDN retry on 1st attempt + upload_param fallback).
    await protocol.sendMedia(account(), PIXEL_PNG, "pic.png", "image/png", "Look!", "m-img");
    expect(uploadAttempts).toBe(2);
    expect(uploadedPlaintexts[0]).toEqual(new Uint8Array(PIXEL_PNG));
    // Caption sent first, then image item.
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0].client_id).toBe("neo-agent:m-img:caption");
    expect((sentMessages[0].item_list as JsonObject[])[0]).toEqual({
      type: 1,
      text_item: { text: "Look!" },
    });
    expect(sentMessages[1].client_id).toBe("neo-agent:m-img");
    const imgItem = (sentMessages[1].item_list as JsonObject[])[0];
    expect(imgItem.type).toBe(2);
    const imgMedia = (imgItem.image_item as JsonObject).media as JsonObject;
    expect(imgMedia.encrypt_query_param).toBe("dl-param-1");
    expect(imgMedia.encrypt_type).toBe(1);
    expect(hex(mediaKey(imgMedia.aes_key as string))).toBe(lastAesKeyHex);
    expect((imgItem.image_item as JsonObject).mid_size).toBe(
      (Math.floor(PIXEL_PNG.byteLength / 16) + 1) * 16,
    );

    // 2. Video without caption.
    const videoBytes = Buffer.from("fake-mp4-stream-bytes");
    await protocol.sendMedia(account(), videoBytes, "clip.mp4", "video/mp4", "", "m-vid");
    const vidMsg = sentMessages[2];
    const vidItem = (vidMsg.item_list as JsonObject[])[0];
    expect(vidItem.type).toBe(5);
    expect((vidItem.video_item as JsonObject).video_size).toBe(32);

    // 3. Generic file with unsafe filename.
    const fileBytes = Buffer.from("quarterly report");
    await protocol.sendMedia(
      account(),
      fileBytes,
      "../dir/report.txt",
      "text/plain",
      "",
      "m-file",
    );
    const fileMsg = sentMessages[3];
    const fileItem = (fileMsg.item_list as JsonObject[])[0];
    expect(fileItem.type).toBe(4);
    expect((fileItem.file_item as JsonObject).file_name).toBe(".._dir_report.txt");
    expect((fileItem.file_item as JsonObject).len).toBe(String(fileBytes.byteLength));
    // Verify MD5 and sizes on getuploadurl request for file.
    const fileUploadAsk = recorded.filter((r) => r.pathname === "/ilink/bot/getuploadurl")[2]
      .bodyJson as JsonObject;
    expect(fileUploadAsk.media_type).toBe(3);
    expect(fileUploadAsk.rawsize).toBe(fileBytes.byteLength);
    expect(fileUploadAsk.rawfilemd5).toBe(md5Hex(fileBytes));
    expect(fileUploadAsk.filesize).toBe(32);

    // 4. Rejects missing upload URL.
    handler = () => Response.json({});
    await expect(
      protocol.sendMedia(account(), fileBytes, "x.txt", "text/plain", ""),
    ).rejects.toThrow("微信未返回媒体上传地址");

    // 5. Rejects oversized media (> 100 MiB) without hitting the network.
    const fakeOversized = { byteLength: MAX_MEDIA_BYTES + 1 } as Uint8Array;
    await expect(
      protocol.sendMedia(account(), fakeOversized, "huge.bin", "application/octet-stream", ""),
    ).rejects.toThrow("微信媒体不能超过 100 MiB");
  });

  test("sendMedia stops retrying immediately on AbortSignal", async () => {
    const protocol = Protocol.at(baseUrl, `${baseUrl}/cdn`);
    let cdnCalls = 0;
    handler = (_req, rec) => {
      if (rec.pathname === "/ilink/bot/getuploadurl") {
        return Response.json({ upload_full_url: `${baseUrl}/cdn/fail` });
      }
      cdnCalls += 1;
      return new Response("down", { status: 500 });
    };

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    let err: unknown;
    try {
      await protocol.sendMedia(
        account(),
        Buffer.from("payload"),
        "a.txt",
        "text/plain",
        "",
        undefined,
        ac.signal,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WeChatProtocolError);
    expect((err as WeChatProtocolError).isAborted).toBe(true);
    expect(cdnCalls).toBe(1);
  });

  test("downloadAttachment downloads and decrypts image, file, video, and handles errors", async () => {
    const protocol = Protocol.at(baseUrl, `${baseUrl}/cdn`);
    const imageKey = new Uint8Array(16).fill(7);
    const fileKey = new Uint8Array(16).fill(9);
    const videoKey = new Uint8Array(16).fill(11);
    const encryptedPng = encrypt(new Uint8Array(PIXEL_PNG), imageKey);
    const encryptedFile = encrypt(Buffer.from("wechat file payload"), fileKey);
    const encryptedVideo = encrypt(Buffer.from("video-bytes"), videoKey);

    handler = (_req, rec) => {
      if (rec.pathname === "/cdn/image") {
        return new Response(encryptedPng, { status: 200 });
      }
      if (rec.pathname === "/cdn/file") {
        return new Response(encryptedFile, { status: 200 });
      }
      if (rec.pathname === "/cdn/download") {
        if (rec.search === "?encrypted_query_param=vid%20param") {
          return new Response(encryptedVideo, { status: 200 });
        }
        if (rec.search === "?encrypted_query_param=plain") {
          return new Response(Buffer.from("raw-unencrypted"), { status: 200 });
        }
      }
      if (rec.pathname === "/cdn/bad-cipher") {
        return new Response(new Uint8Array(16), { status: 200 });
      }
      return new Response(null, { status: 404 });
    };

    // Type 2: image with item-level hex aeskey.
    const img = await protocol.downloadAttachment(
      {
        type: 2,
        image_item: {
          aeskey: hex(imageKey),
          media: { full_url: `${baseUrl}/cdn/image` },
        },
      },
      "m1",
    );
    expect(img).toEqual({
      name: "wechat-m1.jpg",
      mediaType: "image/png",
      data: new Uint8Array(PIXEL_PNG),
    });

    // Type 2: empty item-level aeskey falls back to media.aes_key (base64 of raw 16 bytes).
    const imgFallback = await protocol.downloadAttachment(
      {
        type: 2,
        image_item: {
          aeskey: "",
          media: {
            full_url: `${baseUrl}/cdn/image`,
            aes_key: Buffer.from(imageKey).toString("base64"),
          },
        },
      },
      "m2",
    );
    expect(imgFallback?.data).toEqual(new Uint8Array(PIXEL_PNG));

    // Type 4: file with base64(hex(key)) and path traversal in file_name.
    const file = await protocol.downloadAttachment(
      {
        type: 4,
        file_item: {
          file_name: "../notes.txt",
          media: {
            full_url: `${baseUrl}/cdn/file`,
            aes_key: Buffer.from(hex(fileKey), "utf8").toString("base64"),
          },
        },
      },
      "m3",
    );
    expect(file).toEqual({
      name: ".._notes.txt",
      mediaType: "text/plain",
      data: new Uint8Array(Buffer.from("wechat file payload")),
    });

    // Type 5: video via cdnBase/download?encrypted_query_param=... fallback.
    const video = await protocol.downloadAttachment(
      {
        type: 5,
        video_item: {
          media: {
            encrypt_query_param: "vid param",
            aes_key: Buffer.from(videoKey).toString("base64"),
          },
        },
      },
      "m4",
    );
    expect(video).toEqual({
      name: "wechat-m4.mp4",
      mediaType: "video/mp4",
      data: new Uint8Array(Buffer.from("video-bytes")),
    });

    // Type 5 without aes_key returns unencrypted payload.
    const rawVideo = await protocol.downloadAttachment(
      {
        type: 5,
        video_item: {
          media: { encrypt_query_param: "plain" },
        },
      },
      "m5",
    );
    expect(rawVideo?.data).toEqual(new Uint8Array(Buffer.from("raw-unencrypted")));

    // Non-attachment items return null.
    expect(await protocol.downloadAttachment({ type: 1, text_item: { text: "hi" } }, "m6")).toBeNull();
    expect(await protocol.downloadAttachment({ type: 3, voice_item: { text: "hi" } }, "m6")).toBeNull();
    expect(await protocol.downloadAttachment({ type: 2, image_item: { media: [] } }, "m6")).toBeNull();
    expect(await protocol.downloadAttachment("not-an-object", "m6")).toBeNull();

    // Error messages wrapped verbatim with "微信附件下载失败：".
    await expect(
      protocol.downloadAttachment(
        { type: 4, file_item: { file_name: "lost.bin", media: { full_url: `${baseUrl}/cdn/missing` } } },
        "m7",
      ),
    ).rejects.toThrow("微信附件下载失败：微信 CDN HTTP 404");

    await expect(
      protocol.downloadAttachment(
        {
          type: 2,
          image_item: { aeskey: "not-hex", media: { full_url: `${baseUrl}/cdn/image` } },
        },
        "m8",
      ),
    ).rejects.toThrow("微信附件下载失败：微信媒体 AES 密钥格式无效");

    await expect(
      protocol.downloadAttachment(
        {
          type: 4,
          file_item: {
            file_name: "corrupt.bin",
            media: {
              full_url: `${baseUrl}/cdn/bad-cipher`,
              aes_key: Buffer.from(fileKey).toString("base64"),
            },
          },
        },
        "m9",
      ),
    ).rejects.toThrow("微信附件下载失败：微信媒体解密失败");

    const rawSrv = net.createServer((sock) => {
      sock.once("data", () => {
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${MAX_MEDIA_BYTES + 32}\r\n\r\nhello`);
      });
    });
    await new Promise<void>((resolve) => rawSrv.listen(0, "127.0.0.1", resolve));
    const rawAddr = rawSrv.address() as net.AddressInfo;
    try {
      await expect(
        protocol.downloadAttachment(
          {
            type: 4,
            file_item: {
              file_name: "huge.bin",
              media: { full_url: `http://127.0.0.1:${rawAddr.port}/cdn/oversized` },
            },
          },
          "m10",
        ),
      ).rejects.toThrow("微信附件下载失败：微信媒体不能超过 100 MiB");
    } finally {
      rawSrv.close();
    }
  });

  test("sendMedia exhausts 3 CDN attempts when x-encrypted-param header is missing", async () => {
    const protocol = Protocol.at(baseUrl, `${baseUrl}/cdn`);
    let cdnCalls = 0;
    handler = (_req, rec) => {
      if (rec.pathname === "/ilink/bot/getuploadurl") {
        return Response.json({ upload_full_url: `${baseUrl}/cdn/no-header` });
      }
      cdnCalls += 1;
      return new Response(null, { status: 200 });
    };

    await expect(
      protocol.sendMedia(account(), Buffer.from("payload"), "a.txt", "text/plain", ""),
    ).rejects.toThrow("微信 CDN 未返回下载参数");
    expect(cdnCalls).toBe(3);
  });
});
