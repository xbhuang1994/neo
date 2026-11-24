/**
 * The iLink Bot protocol WeChat offers: login by QR code, long-polled messages,
 * and media through an encrypted CDN.
 *
 * Faithful pure-TypeScript (Bun) port of `neo-app/src/wechat_protocol.rs`.
 */

import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { VERSION } from "../version.ts";

/** The API's address. */
export const API_URL = "https://ilinkai.weixin.qq.com";
/** The media CDN's address. */
export const CDN_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
/** Channel version reported in `base_info`. */
export const CHANNEL_VERSION = "2.4.10";
/** Client version reported in `iLink-App-ClientVersion`. */
export const CLIENT_VERSION = (2 << 16) | (4 << 8) | 10;
/** Bot agent string reported in `base_info`. */
export const BOT_AGENT = `neo-agent/${VERSION}`;
/** The largest media file sent or received (100 MiB). */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
/** The most one call about the typing indicator waits, so that stopping never waits long on it. */
export const TYPING_WAIT_MS = 5_000;
/** Default timeout for standard API calls. */
export const DEFAULT_CALL_TIMEOUT_MS = 15_000;
/** Timeout for CDN upload and download calls. */
export const CDN_TIMEOUT_MS = 30_000;

/** Maximum bytes read from a generic HTTP response (128 MiB, matching Rust `http.rs`). */
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();
const HEX_UPPER = "0123456789ABCDEF";
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const INTEGER_PATTERN = /^-?\d+$/;
const UNSAFE_NAME_CHAR_PATTERN = /[/\\\u0000-\u001F\u007F-\u009F]/g;

/** JSON primitive value. */
export type JsonPrimitive = string | number | boolean | null;
/** Recursive JSON value. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
/** JSON object map. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** The bound bot account and the one user it talks to. */
export interface Account {
  /** The bot's credential. */
  token: string;
  /** The bot's id. */
  accountId: string;
  /** The person who bound it; the only one it listens to. */
  userId: string;
  /** The API address this account uses. */
  baseUrl: string;
  /** The conversation token of the person's latest message, which replies carry. */
  contextToken?: string;
}

/** A login QR code. */
export interface Qr {
  /** Its id, for asking about its status. */
  id: string;
  /** What the code encodes: the address WeChat opens when it is scanned. */
  url: string;
}

/** A file a person attached to a chat message. */
export interface ChatAttachment {
  /** Its file name. */
  name: string;
  /** Its media type, as the sender declared it. */
  mediaType: string;
  /** Its bytes. */
  data: Uint8Array;
}

/** Why a protocol call failed. */
export type WeChatErrorKind = "timeout" | "aborted" | "other";

/** Error thrown by WeChat protocol operations. */
export class WeChatProtocolError extends Error {
  readonly kind: WeChatErrorKind;

  constructor(kind: WeChatErrorKind, message?: string) {
    super(message ?? (kind === "timeout" ? "请求超时" : "请求已取消"));
    this.name = "WeChatProtocolError";
    this.kind = kind;
  }

  /** Nothing came back in time. */
  static timeout(): WeChatProtocolError {
    return new WeChatProtocolError("timeout", "请求超时");
  }

  /** The caller cancelled the operation via `AbortSignal`. */
  static aborted(message = "请求已取消"): WeChatProtocolError {
    return new WeChatProtocolError("aborted", message);
  }

  /** Anything else, in words. */
  static other(message: string): WeChatProtocolError {
    return new WeChatProtocolError("other", message);
  }

  get isTimeout(): boolean {
    return this.kind === "timeout";
  }

  get isAborted(): boolean {
    return this.kind === "aborted";
  }
}

/** Configuration options for {@link Protocol}. */
export interface ProtocolOptions {
  /** The API's address. */
  apiBase?: string;
  /** The CDN's address. */
  cdnBase?: string;
  /** Between two questions about a login, and the first wait after a failed poll (ms). */
  paceMs?: number;
  /** How long one question about a login may wait for its answer (ms). */
  statusWaitMs?: number;
  /** How long the bridge waits after a message with words for more of the same burst (ms). */
  quietMs?: number;
  /** The longest a burst with words is held after its first words (ms). */
  burstCapMs?: number;
  /** How long files sent without words wait for the words that say what to do with them (ms). */
  fileWaitMs?: number;
  /** How often the typing indicator checks whether work is active (ms). */
  typingCheckMs?: number;
  /** How long "typing" stays shown during a blink (ms). */
  typingOnMs?: number;
  /** How long "typing" stays away between two blinks (ms). */
  typingOffMs?: number;
}

/** Encode bytes as lowercase hex. */
export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

function hexNibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}

/** Decode an even-length ASCII hex string into bytes; returns `null` if invalid. */
export function unhex(text: string): Uint8Array | null {
  if ((text.length & 1) === 1) {
    return null;
  }
  const out = new Uint8Array(text.length >>> 1);
  for (let i = 0, j = 0; i < text.length; i += 2, j += 1) {
    const hi = hexNibble(text.charCodeAt(i));
    const lo = hexNibble(text.charCodeAt(i + 1));
    if (hi < 0 || lo < 0) {
      return null;
    }
    out[j] = (hi << 4) | lo;
  }
  return out;
}

function unhexBytes(bytes: Uint8Array): Uint8Array | null {
  if ((bytes.byteLength & 1) === 1) {
    return null;
  }
  const out = new Uint8Array(bytes.byteLength >>> 1);
  for (let i = 0, j = 0; i < bytes.byteLength; i += 2, j += 1) {
    const hi = hexNibble(bytes[i]);
    const lo = hexNibble(bytes[i + 1]);
    if (hi < 0 || lo < 0) {
      return null;
    }
    out[j] = (hi << 4) | lo;
  }
  return out;
}

/** Percent-encode a query value (RFC 3986 unreserved characters left unescaped). */
export function encodeQuery(value: string): string {
  const bytes = UTF8_ENCODER.encode(value);
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const byte = bytes[i];
    if (
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      byte === 0x2d || // -
      byte === 0x5f || // _
      byte === 0x2e || // .
      byte === 0x7e // ~
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${HEX_UPPER[byte >>> 4]}${HEX_UPPER[byte & 0x0f]}`;
    }
  }
  return out;
}

/** The MD5 digest the upload API asks for, in lowercase hex. */
export function md5Hex(data: Uint8Array | string): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(data);
  return hasher.digest("hex");
}

/** AES-128-ECB with PKCS#7 padding, as the CDN stores media. */
export function encrypt(plain: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.byteLength !== 16) {
    throw new Error("微信媒体 AES 密钥格式无效");
  }
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const first = cipher.update(plain);
  const last = cipher.final();
  if (first.byteLength === 0) {
    return new Uint8Array(last.buffer, last.byteOffset, last.byteLength);
  }
  if (last.byteLength === 0) {
    return new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  }
  const out = new Uint8Array(first.byteLength + last.byteLength);
  out.set(first, 0);
  out.set(last, first.byteLength);
  return out;
}

/** The reverse of {@link encrypt}; throws on data that is not whole blocks or whose padding is wrong. */
export function decrypt(encrypted: Uint8Array, key: Uint8Array): Uint8Array {
  if (encrypted.byteLength === 0 || (encrypted.byteLength & 15) !== 0) {
    throw new Error("微信媒体密文长度无效");
  }
  if (key.byteLength !== 16) {
    throw new Error("微信媒体 AES 密钥格式无效");
  }
  try {
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    const first = decipher.update(encrypted);
    const last = decipher.final();
    if (first.byteLength === 0) {
      return new Uint8Array(last.buffer, last.byteOffset, last.byteLength);
    }
    if (last.byteLength === 0) {
      return new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
    }
    const out = new Uint8Array(first.byteLength + last.byteLength);
    out.set(first, 0);
    out.set(last, first.byteLength);
    return out;
  } catch {
    throw new Error("微信媒体解密失败");
  }
}

/**
 * Decode a strict RFC 4648 canonical standard base64 string (matching Rust `base64::STANDARD`).
 * Rejects whitespace, missing/invalid padding, invalid characters, and non-zero trailing bits.
 */
function decodeBase64Strict(text: string): Uint8Array | null {
  if ((text.length & 3) !== 0 || !BASE64_PATTERN.test(text)) {
    return null;
  }
  const decoded = Buffer.from(text, "base64");
  if (decoded.toString("base64") !== text) {
    return null;
  }
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

/** A media key as messages carry it: base64 of the 16 bytes, or of their 32 hex digits. */
export function mediaKey(encoded: string): Uint8Array {
  const decoded = decodeBase64Strict(encoded.trim());
  if (decoded === null) {
    throw new Error("微信媒体 AES 密钥格式无效");
  }
  if (decoded.byteLength === 16) {
    return decoded;
  }
  if (decoded.byteLength === 32) {
    const raw = unhexBytes(decoded);
    if (raw !== null && raw.byteLength === 16) {
      return raw;
    }
  }
  throw new Error("微信媒体 AES 密钥格式无效");
}

const MIME_MAP: ReadonlyMap<string, string> = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
  ["pdf", "application/pdf"],
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["csv", "text/csv"],
  ["zip", "application/zip"],
  ["doc", "application/msword"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);

function toAsciiLower(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code | 0x20) : text[i];
  }
  return out;
}

/** The media type a file name's extension stands for. */
export function mimeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) {
    return "application/octet-stream";
  }
  const extension = toAsciiLower(name.slice(dot + 1));
  return MIME_MAP.get(extension) ?? "application/octet-stream";
}

/** A file name without separators and control characters, 200 Unicode scalar values at most. */
export function safeName(name: string | null | undefined, fallback: string): string {
  const cleaned = (name ?? "").replace(UNSAFE_NAME_CHAR_PATTERN, "_").trim();
  if (cleaned.length === 0) {
    return fallback;
  }
  if (cleaned.length <= 200) {
    return cleaned;
  }
  let count = 0;
  let end = 0;
  for (const ch of cleaned) {
    count += 1;
    end += ch.length;
    if (count === 200) {
      break;
    }
  }
  return cleaned.slice(0, end);
}

/** What kind of image the bytes are, by how they begin. */
export function imageMime(data: Uint8Array): string {
  if (
    data.byteLength >= 8 &&
    data[0] === 137 &&
    data[1] === 80 &&
    data[2] === 78 &&
    data[3] === 71 &&
    data[4] === 13 &&
    data[5] === 10 &&
    data[6] === 26 &&
    data[7] === 10
  ) {
    return "image/png";
  }
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.byteLength >= 6 &&
    data[0] === 0x47 && // G
    data[1] === 0x49 && // I
    data[2] === 0x46 && // F
    data[3] === 0x38 && // 8
    (data[4] === 0x37 || data[4] === 0x39) && // 7 or 9
    data[5] === 0x61 // a
  ) {
    return "image/gif";
  }
  if (
    data.byteLength >= 12 &&
    data[0] === 0x52 && // R
    data[1] === 0x49 && // I
    data[2] === 0x46 && // F
    data[3] === 0x46 && // F
    data[8] === 0x57 && // W
    data[9] === 0x45 && // E
    data[10] === 0x42 && // B
    data[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

interface JsonParseReviverContext {
  source?: string;
}

type JsonParseWithContext = (
  text: string,
  reviver: (this: unknown, key: string, value: unknown, context?: JsonParseReviverContext) => unknown,
) => unknown;

/**
 * Parse a WeChat JSON payload while preserving exact decimal digits of 64-bit integers
 * outside IEEE-754 safe integer range (`|n| > Number.MAX_SAFE_INTEGER`) as strings so
 * IDs such as `9007199254740993` are never rounded and the parsed tree stays JSON-serializable.
 */
export function parseWeChatJson(text: string): JsonValue {
  const parse = JSON.parse as unknown as JsonParseWithContext;
  return parse(text, (_key, value, context) => {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      const source = context?.source;
      if (source !== undefined && INTEGER_PATTERN.test(source)) {
        return source;
      }
    }
    return value;
  }) as JsonValue;
}

/** An id that the API sends as a string or as a 64-bit number. */
export function idText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asI64(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  timeoutMs: number;
  want?: readonly string[];
  maxBytes?: number;
  rejectAboveBytes?: number;
  rejectAboveMessage?: string;
  signal?: AbortSignal;
}

interface HttpResponse {
  status: number;
  body: Uint8Array;
  headers: string[];
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
  onCapExceeded?: () => void,
): Promise<Uint8Array> {
  const stream = response.body;
  if (stream === null) {
    return new Uint8Array(0);
  }
  const reader = stream.getReader();
  try {
    const first = await reader.read();
    if (first.done) {
      return new Uint8Array(0);
    }
    const firstChunk = first.value;
    if (firstChunk.byteLength >= maxBytes) {
      onCapExceeded?.();
      await reader.cancel().catch(() => {});
      return firstChunk.byteLength === maxBytes ? firstChunk : firstChunk.subarray(0, maxBytes);
    }
    const second = await reader.read();
    if (second.done) {
      return firstChunk;
    }
    const chunks: Uint8Array[] = [firstChunk];
    let total = firstChunk.byteLength;
    let chunk: Uint8Array = second.value;
    for (;;) {
      const remaining = maxBytes - total;
      if (chunk.byteLength >= remaining) {
        chunks.push(chunk.byteLength === remaining ? chunk : chunk.subarray(0, remaining));
        total = maxBytes;
        onCapExceeded?.();
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      const next = await reader.read();
      if (next.done) {
        break;
      }
      chunk = next.value;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      out.set(chunks[i], offset);
      offset += chunks[i].byteLength;
    }
    return out;
  } finally {
    reader.releaseLock();
  }
}

async function httpSend(request: HttpRequest): Promise<HttpResponse> {
  const externalSignal = request.signal;
  if (externalSignal?.aborted) {
    throw WeChatProtocolError.aborted();
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  if (request.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, request.timeoutMs);
  }

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const status = response.status;
    const headers = request.want ? request.want.map((name) => response.headers.get(name) ?? "") : [];

    // Early reject oversized uncompressed 2xx responses when Content-Length is known.
    if (
      request.rejectAboveBytes !== undefined &&
      status >= 200 &&
      status < 300 &&
      !response.headers.get("content-encoding")
    ) {
      const clHeader = response.headers.get("content-length");
      if (clHeader !== null) {
        const declared = Number(clHeader);
        if (Number.isFinite(declared) && declared > request.rejectAboveBytes) {
          controller.abort(new Error("oversized"));
          await response.body?.cancel().catch(() => {});
          throw WeChatProtocolError.other(request.rejectAboveMessage ?? "微信媒体不能超过 100 MiB");
        }
      }
    }

    const body = await readBodyCapped(response, request.maxBytes ?? MAX_RESPONSE_BYTES, () => {
      controller.abort(new Error("capped"));
    });
    return { status, body, headers };
  } catch (error) {
    if (error instanceof WeChatProtocolError) {
      throw error;
    }
    if (externalSignal?.aborted) {
      throw WeChatProtocolError.aborted();
    }
    if (timedOut) {
      throw WeChatProtocolError.timeout();
    }
    const text = error instanceof Error ? error.message : String(error);
    if (text.includes("timed out") || text.includes("Timeout") || text.includes("timeout")) {
      throw WeChatProtocolError.timeout();
    }
    throw WeChatProtocolError.other(text);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(WeChatProtocolError.aborted());
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(WeChatProtocolError.aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface CallOptions {
  method?: "GET" | "POST";
  token?: string;
  body?: JsonObject;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The iLink Bot HTTP/JSON + CDN client. */
export class Protocol {
  /** The API's address. */
  apiBase: string;
  /** The CDN's address. */
  cdnBase: string;
  /** Between two questions about a login, and the first wait after a failed poll (ms). */
  paceMs: number;
  /** How long one question about a login may wait for its answer; WeChat holds each for about half a minute (ms). */
  statusWaitMs: number;
  /** How long the bridge waits after a message with words for more of the same burst; zero takes each at once (ms). */
  quietMs: number;
  /** The longest a burst with words is held after its first words (ms). */
  burstCapMs: number;
  /** How long files sent without words wait for the words that say what to do with them (ms). */
  fileWaitMs: number;
  /** How often the typing indicator looks whether the main Session or a worker is at work (ms). */
  typingCheckMs: number;
  /** While work goes on, "typing" blinks: shown this long, then taken away for `typingOffMs` (ms). */
  typingOnMs: number;
  /** How long "typing" stays away between two blinks (ms). */
  typingOffMs: number;

  constructor(options: ProtocolOptions = {}) {
    this.apiBase = trimTrailingSlashes(options.apiBase ?? API_URL);
    this.cdnBase = trimTrailingSlashes(options.cdnBase ?? CDN_URL);
    this.paceMs = options.paceMs ?? 1_000;
    this.statusWaitMs = options.statusWaitMs ?? 45_000;
    this.quietMs = options.quietMs ?? 1_500;
    this.burstCapMs = options.burstCapMs ?? 6_000;
    this.fileWaitMs = options.fileWaitMs ?? 15_000;
    this.typingCheckMs = options.typingCheckMs ?? 250;
    this.typingOnMs = options.typingOnMs ?? 2_000;
    this.typingOffMs = options.typingOffMs ?? 1_000;
  }

  /** A client for other addresses than WeChat's own, as tests use. */
  static at(
    apiBase: string,
    cdnBase: string,
    options?: Omit<ProtocolOptions, "apiBase" | "cdnBase">,
  ): Protocol {
    return new Protocol({
      ...options,
      apiBase: trimTrailingSlashes(apiBase),
      cdnBase: trimTrailingSlashes(cdnBase),
    });
  }

  private async call(base: string, path: string, options: CallOptions = {}): Promise<JsonValue> {
    const uinNum = randomBytes(4).readUInt32BE(0);
    const uin = Buffer.from(String(uinNum), "utf8").toString("base64");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorizationType: "ilink_bot_token",
      "x-wechat-uin": uin,
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String(CLIENT_VERSION),
    };
    if (options.token !== undefined) {
      headers.authorization = `Bearer ${options.token}`;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify({
        ...options.body,
        base_info: {
          channel_version: CHANNEL_VERSION,
          bot_agent: BOT_AGENT,
        },
      });
    }

    const response = await httpSend({
      method: options.method ?? "POST",
      url: `${trimTrailingSlashes(base)}/${path}`,
      headers,
      body,
      timeoutMs: options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      signal: options.signal,
    });

    if (response.status < 200 || response.status >= 300) {
      throw WeChatProtocolError.other(`微信接口 HTTP ${response.status}`);
    }
    try {
      const text = UTF8_DECODER.decode(response.body);
      return parseWeChatJson(text);
    } catch {
      throw WeChatProtocolError.other("微信接口返回了无法解析的内容");
    }
  }

  /** Ask for a login QR code. */
  async createQr(signal?: AbortSignal): Promise<Qr> {
    const result = await this.call(this.apiBase, "ilink/bot/get_bot_qrcode?bot_type=3", {
      body: { local_token_list: [] },
      signal,
    });
    const obj = isPlainObject(result) ? result : undefined;
    const id = asNonEmptyString(obj?.qrcode);
    const url = asNonEmptyString(obj?.qrcode_img_content);
    if (id !== undefined && url !== undefined) {
      return { id, url };
    }
    throw WeChatProtocolError.other("微信未返回有效二维码");
  }

  /** Where a login stands; the call waits up to `statusWaitMs` (default 45s) for a change. */
  async qrStatus(
    id: string,
    base: string,
    verifyCode?: string,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const code = verifyCode !== undefined ? `&verify_code=${encodeQuery(verifyCode)}` : "";
    try {
      return await this.call(base, `ilink/bot/get_qrcode_status?qrcode=${encodeQuery(id)}${code}`, {
        method: "GET",
        timeoutMs: this.statusWaitMs,
        signal,
      });
    } catch (error) {
      // WeChat holds the question open until something changes: no answer in time means nothing changed yet.
      if (error instanceof WeChatProtocolError && error.isTimeout) {
        return { status: "wait" };
      }
      throw error;
    }
  }

  /** Long-poll for messages after `cursor`; a poll that times out is an empty one. */
  async updates(
    account: Account,
    cursor: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    try {
      return await this.call(account.baseUrl, "ilink/bot/getupdates", {
        token: account.token,
        body: { get_updates_buf: cursor },
        timeoutMs,
        signal,
      });
    } catch (error) {
      if (error instanceof WeChatProtocolError && error.isTimeout) {
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      }
      throw error;
    }
  }

  /** The ticket that lets the bot show the bound user that it is typing. */
  async typingTicket(account: Account, signal?: AbortSignal): Promise<string> {
    const body: JsonObject = {
      ilink_user_id: account.userId,
      context_token: account.contextToken ?? null,
    };
    const response = await this.call(account.baseUrl, "ilink/bot/getconfig", {
      token: account.token,
      body,
      timeoutMs: TYPING_WAIT_MS,
      signal,
    });
    const obj = isPlainObject(response) ? response : undefined;
    const ret = asI64(obj?.ret);
    const ticket = asNonEmptyString(obj?.typing_ticket);
    if ((ret === undefined || ret === 0) && ticket !== undefined) {
      return ticket;
    }
    const errmsg = asString(obj?.errmsg) ?? "无说明";
    throw WeChatProtocolError.other(`微信未返回输入状态凭证：${errmsg}`);
  }

  /** Show the bound user "typing", or take it away. */
  async sendTyping(
    account: Account,
    ticket: string,
    typing: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const body: JsonObject = {
      ilink_user_id: account.userId,
      typing_ticket: ticket,
      status: typing ? 1 : 2,
    };
    const response = await this.call(account.baseUrl, "ilink/bot/sendtyping", {
      token: account.token,
      body,
      timeoutMs: TYPING_WAIT_MS,
      signal,
    });
    const obj = isPlainObject(response) ? response : undefined;
    const ret = asI64(obj?.ret);
    if (ret === undefined || ret === 0) {
      return;
    }
    const detail = asString(obj?.errmsg) ?? `ret=${ret}`;
    throw WeChatProtocolError.other(`微信输入状态失败：${detail}`);
  }

  private async sendItem(
    account: Account,
    item: JsonObject,
    clientId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const fullClientId =
      clientId !== undefined ? `neo-agent:${clientId}` : `neo-agent:${randomUUID()}`;
    const message: JsonObject = {
      msg: {
        from_user_id: "",
        to_user_id: account.userId,
        client_id: fullClientId,
        message_type: 2,
        message_state: 2,
        context_token: account.contextToken ?? null,
        item_list: [item],
      },
    };
    const response = await this.call(account.baseUrl, "ilink/bot/sendmessage", {
      token: account.token,
      body: message,
      signal,
    });
    const obj = isPlainObject(response) ? response : undefined;
    const ret = asI64(obj?.ret);
    if (ret === undefined || ret === 0) {
      return;
    }
    const detail = asString(obj?.errmsg) ?? `ret=${ret}`;
    throw WeChatProtocolError.other(`微信发送失败：${detail}`);
  }

  /** Send a text to the bound user; the same `messageId` is the same message to WeChat. */
  async sendText(
    account: Account,
    text: string,
    messageId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (text.length === 0) {
      return;
    }
    await this.sendItem(account, { type: 1, text_item: { text } }, messageId, signal);
  }

  /** Upload a file encrypted and send it as an image, a video or a file, after its caption. */
  async sendMedia(
    account: Account,
    plain: Uint8Array,
    name: string,
    mediaType: string,
    caption: string,
    messageId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (plain.byteLength > MAX_MEDIA_BYTES) {
      throw WeChatProtocolError.other("微信媒体不能超过 100 MiB");
    }
    const fileKey = hex(randomBytes(16));
    const key = randomBytes(16);
    const keyHex = hex(key);
    const cipherSize = (Math.floor(plain.byteLength / 16) + 1) * 16;
    const kind = mediaType.startsWith("image/") ? 1 : mediaType.startsWith("video/") ? 2 : 3;

    const ask: JsonObject = {
      filekey: fileKey,
      media_type: kind,
      to_user_id: account.userId,
      rawsize: plain.byteLength,
      rawfilemd5: md5Hex(plain),
      filesize: cipherSize,
      no_need_thumb: true,
      aeskey: keyHex,
    };
    const upload = await this.call(account.baseUrl, "ilink/bot/getuploadurl", {
      token: account.token,
      body: ask,
      signal,
    });
    const uploadObj = isPlainObject(upload) ? upload : undefined;
    const fullUrl = asNonEmptyString(uploadObj?.upload_full_url);
    const uploadParam = asNonEmptyString(uploadObj?.upload_param);
    let url: string;
    if (fullUrl !== undefined) {
      url = fullUrl;
    } else if (uploadParam !== undefined) {
      url = `${trimTrailingSlashes(this.cdnBase)}/upload?encrypted_query_param=${encodeQuery(uploadParam)}&filekey=${encodeQuery(fileKey)}`;
    } else {
      throw WeChatProtocolError.other("微信未返回媒体上传地址");
    }

    const encrypted = encrypt(plain, key);
    let download = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let attemptError: WeChatProtocolError | undefined;
      try {
        const response = await httpSend({
          method: "POST",
          url,
          headers: { "content-type": "application/octet-stream" },
          body: encrypted,
          timeoutMs: CDN_TIMEOUT_MS,
          want: ["x-encrypted-param"],
          signal,
        });
        if (response.status < 200 || response.status >= 300) {
          attemptError = WeChatProtocolError.other(`微信 CDN HTTP ${response.status}`);
        } else {
          const param = response.headers[0] ?? "";
          if (param.length === 0) {
            attemptError = WeChatProtocolError.other("微信 CDN 未返回下载参数");
          } else {
            download = param;
            break;
          }
        }
      } catch (error) {
        if (error instanceof WeChatProtocolError) {
          if (error.isAborted) {
            throw error;
          }
          attemptError = error;
        } else {
          attemptError = WeChatProtocolError.other(
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      if (attempt === 2) {
        throw attemptError;
      }
      await sleepCancellable(500 * (attempt + 1), signal);
    }

    if (caption.length > 0) {
      const captionId = messageId !== undefined ? `${messageId}:caption` : undefined;
      await this.sendText(account, caption, captionId, signal);
    }

    const media: JsonObject = {
      encrypt_query_param: download,
      aes_key: Buffer.from(keyHex, "utf8").toString("base64"),
      encrypt_type: 1,
    };
    const item: JsonObject =
      kind === 1
        ? { type: 2, image_item: { media, mid_size: cipherSize } }
        : kind === 2
          ? { type: 5, video_item: { media, video_size: cipherSize } }
          : {
              type: 4,
              file_item: {
                media,
                file_name: safeName(name, "file.bin"),
                len: String(plain.byteLength),
              },
            };
    await this.sendItem(account, item, messageId, signal);
  }

  private async download(
    media: JsonObject,
    hexKey?: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const fullUrl = asNonEmptyString(media.full_url);
    const url =
      fullUrl ??
      `${trimTrailingSlashes(this.cdnBase)}/download?encrypted_query_param=${encodeQuery(asString(media.encrypt_query_param) ?? "")}`;

    let response: HttpResponse;
    try {
      response = await httpSend({
        method: "GET",
        url,
        timeoutMs: CDN_TIMEOUT_MS,
        maxBytes: MAX_MEDIA_BYTES + 17,
        rejectAboveBytes: MAX_MEDIA_BYTES + 16,
        rejectAboveMessage: "微信媒体不能超过 100 MiB",
        signal,
      });
    } catch (error) {
      if (error instanceof WeChatProtocolError) {
        if (error.isAborted) {
          throw error;
        }
        if (error.isTimeout) {
          throw new Error("The request timed out");
        }
      }
      throw error;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`微信 CDN HTTP ${response.status}`);
    }
    if (response.body.byteLength > MAX_MEDIA_BYTES + 16) {
      throw new Error("微信媒体不能超过 100 MiB");
    }

    let key: Uint8Array | undefined;
    if (hexKey !== undefined && hexKey.length > 0) {
      const parsed = unhex(hexKey);
      if (parsed === null || parsed.byteLength !== 16) {
        throw new Error("微信媒体 AES 密钥格式无效");
      }
      key = parsed;
    } else {
      const aesKey = asNonEmptyString(media.aes_key);
      if (aesKey !== undefined) {
        key = mediaKey(aesKey);
      }
    }

    if (key !== undefined) {
      return decrypt(response.body, key);
    }
    return response.body;
  }

  /** The image, file or video a message item carries, downloaded and decrypted; null for other items. */
  async downloadAttachment(
    item: JsonValue,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<ChatAttachment | null> {
    if (!isPlainObject(item)) {
      return null;
    }
    const kind = asI64(item.type);
    try {
      if (kind === 2 && isPlainObject(item.image_item) && isPlainObject(item.image_item.media)) {
        const data = await this.download(
          item.image_item.media,
          asString(item.image_item.aeskey),
          signal,
        );
        return {
          name: `wechat-${messageId}.jpg`,
          mediaType: imageMime(data),
          data,
        };
      }
      if (kind === 4 && isPlainObject(item.file_item) && isPlainObject(item.file_item.media)) {
        const name = safeName(asString(item.file_item.file_name), "file.bin");
        const data = await this.download(item.file_item.media, undefined, signal);
        return {
          name,
          mediaType: mimeOf(name),
          data,
        };
      }
      if (kind === 5 && isPlainObject(item.video_item) && isPlainObject(item.video_item.media)) {
        const data = await this.download(item.video_item.media, undefined, signal);
        return {
          name: `wechat-${messageId}.mp4`,
          mediaType: "video/mp4",
          data,
        };
      }
      return null;
    } catch (error) {
      if (error instanceof WeChatProtocolError && error.isAborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw WeChatProtocolError.other(`微信附件下载失败：${message}`);
    }
  }
}
