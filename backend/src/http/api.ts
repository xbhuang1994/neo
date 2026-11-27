/**
 * The application's JSON API, who may call it, and the web build's files.
 *
 * Ported directly from Rust `neo-http/src/api.rs`.
 */

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { StopWorkerError } from "../app/context.ts";
import type { AppContext, ChatAttachment } from "../app/context.ts";
import {
  MCP_CALL_POLICY_MODES,
  SANDBOX_LEVELS,
  isMcpCallPolicyMode,
  isSandboxLevel,
  renderDirectInstallPs1,
  renderDirectInstallSh,
  type DeviceConfigUpdateInput,
  type DeviceUpdateInput,
  type EnrollmentCreateInput,
  type EnrollmentInstallMode,
  type EnrollmentPlatform,
  type EnrollmentProfile,
  type EnrollmentTransportMode,
  type McpCallAction,
  type McpCallPolicyMode,
  type McuInstallInput,
  type McuTransportKind,
  type TokenTier,
} from "../devices/index.ts";
import { VERSION } from "../version.ts";
import { Response, isLoopbackIp } from "./server.ts";
import type { Request, SocketAddr } from "./server.ts";

/** The most files one chat message carries. */
export const MAX_FILES = 3;
/** The largest file of a chat message. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** The longest chat message, in characters. */
export const MAX_TEXT_CHARS = 8000;

/** Upper bound on base64 string length accepted before decoding (`MAX_FILE_BYTES / 3 * 4 + 8`). */
const MAX_BASE64_LEN = Math.floor(MAX_FILE_BYTES / 3) * 4 + 8;

/** What a page of the web build may load: only what this server gives it. */
export const PAGE_POLICY =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const UNSAFE_ATTACHMENT_NAME_RE = /[/\\\u0000-\u001F\u007F-\u009F]/g;

const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });

const MIME_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  wasm: "application/wasm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  webp: "image/webp",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

const MIN_COMPRESS_BYTES = 512;
const MAX_STATIC_CACHE_BYTES = 64 * 1024 * 1024;
const BROTLI_OPTIONS: zlib.BrotliOptions = {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
};
const GZIP_OPTIONS: zlib.ZlibOptions = { level: 6 };
const EMPTY_BODY = new Uint8Array(0);

type ContentEncoding = "br" | "gzip";

interface StaticCacheEntry {
  mtimeMs: number;
  size: number;
  contentType: string;
  etag: string;
  raw: Uint8Array;
  gzip?: Uint8Array | null;
  br?: Uint8Array | null;
  totalBytes: number;
}

const staticFileCache = new Map<string, StaticCacheEntry>();
let staticCacheTotalBytes = 0;

function evictStaticCache(incomingBytes: number): void {
  if (incomingBytes > MAX_STATIC_CACHE_BYTES) return;
  while (staticCacheTotalBytes + incomingBytes > MAX_STATIC_CACHE_BYTES && staticFileCache.size > 0) {
    const oldestKey = staticFileCache.keys().next().value;
    if (oldestKey === undefined) break;
    const evicted = staticFileCache.get(oldestKey);
    staticFileCache.delete(oldestKey);
    if (evicted) staticCacheTotalBytes -= evicted.totalBytes;
  }
}

function isCompressibleMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime.startsWith("application/json") ||
    mime === "application/wasm" ||
    mime === "image/svg+xml" ||
    mime === "font/ttf" ||
    mime === "font/otf"
  );
}

/** Pick `br` or `gzip` from an `Accept-Encoding` header (respecting `q=0` exclusions). */
export function negotiateEncoding(acceptEncoding: string | undefined): ContentEncoding | null {
  if (!acceptEncoding) return null;
  let brQ = -1;
  let gzipQ = -1;
  const parts = acceptEncoding.split(",");
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]!.trim();
    if (raw.length === 0) continue;
    const semi = raw.indexOf(";");
    const token = (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
    if (token !== "br" && token !== "gzip") continue;
    let q = 1;
    if (semi !== -1) {
      const params = raw.slice(semi + 1).split(";");
      for (let j = 0; j < params.length; j++) {
        const param = params[j]!.trim().toLowerCase();
        if (param.startsWith("q=")) {
          const parsed = Number(param.slice(2).trim());
          if (!Number.isNaN(parsed)) q = parsed;
        }
      }
    }
    if (token === "br") brQ = q;
    else gzipQ = q;
  }
  if (brQ > 0 && brQ >= gzipQ) return "br";
  if (gzipQ > 0) return "gzip";
  return null;
}

function fastSliceTag(data: Uint8Array | string): string {
  const len = typeof data === "string" ? data.length : data.byteLength;
  const hash = typeof Bun !== "undefined" ? Bun.hash(data).toString(36) : Buffer.from(data).length.toString(36);
  return `${len.toString(36)}-${hash}`;
}

function weakEtag(data: Uint8Array | string): string {
  return `W/"${fastSliceTag(data)}"`;
}

function stripWeakPrefix(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("W/") || trimmed.startsWith("w/") ? trimmed.slice(2).trim() : trimmed;
}

/** RFC 9110 weak ETag comparison for `If-None-Match`. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === "*") return true;
  const target = stripWeakPrefix(etag);
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i <= trimmed.length; i++) {
    const ch = i < trimmed.length ? trimmed.charCodeAt(i) : 0x2c /* ',' */;
    if (ch === 0x22 /* '"' */) {
      inQuotes = !inQuotes;
    } else if (ch === 0x2c /* ',' */ && !inQuotes) {
      const candidate = trimmed.slice(start, i).trim();
      if (candidate.length > 0 && stripWeakPrefix(candidate) === target) {
        return true;
      }
      start = i + 1;
    }
  }
  return false;
}

function compressBytes(raw: Uint8Array, encoding: ContentEncoding): Uint8Array | null {
  const compressed =
    encoding === "br"
      ? zlib.brotliCompressSync(raw, BROTLI_OPTIONS)
      : zlib.gzipSync(raw, GZIP_OPTIONS);
  if (compressed.byteLength >= raw.byteLength) {
    return null;
  }
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
}

function maybeCompressApiResponse(request: Request, response: Response): Response {
  if (
    response.status === 204 ||
    response.status === 304 ||
    response.body.byteLength < MIN_COMPRESS_BYTES ||
    !isCompressibleMime(response.contentType)
  ) {
    return response;
  }
  const encoding = negotiateEncoding(request.header("accept-encoding"));
  if (encoding === null) {
    return response;
  }
  const compressed = compressBytes(response.body, encoding);
  if (compressed === null) {
    return response;
  }
  return new Response({
    status: response.status,
    contentType: response.contentType,
    body: compressed,
    headers: [...response.headers, ["content-encoding", encoding], ["vary", "accept-encoding"]],
  });
}

function jsonWithEtag(request: Request, value: unknown): Response {
  const raw = textEncoder.encode(JSON.stringify(value));
  const etag = weakEtag(raw);
  if (etagMatches(request.header("if-none-match"), etag)) {
    return new Response({
      status: 304,
      contentType: "application/json; charset=utf-8",
      body: EMPTY_BODY,
      headers: [
        ["etag", etag],
        ["cache-control", "no-store"],
      ],
    });
  }
  const res = new Response({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: raw,
    headers: [
      ["cache-control", "no-store"],
      ["etag", etag],
    ],
  });
  return maybeCompressApiResponse(request, res);
}

function isImmutableWebAsset(parts: readonly string[]): boolean {
  // Self-hosted Google Fonts fallback files use content-hashed versioned paths (`fonts/fallback/<family>/<ver>/<hash>.woff2`).
  if (parts.length >= 4 && parts[0] === "fonts" && parts[1] === "fallback") {
    const fileName = parts[parts.length - 1] ?? "";
    return fileName.endsWith(".woff2");
  }
  return false;
}

const B64_DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < 26; i++) {
  B64_DECODE[0x41 + i] = i; // A-Z
  B64_DECODE[0x61 + i] = 26 + i; // a-z
}
for (let i = 0; i < 10; i++) {
  B64_DECODE[0x30 + i] = 52 + i; // 0-9
}
B64_DECODE[0x2b] = 62; // +
B64_DECODE[0x2f] = 63; // /

/** How the API is offered. */
export interface Access {
  /** The token every API call carries as `Authorization: Bearer …`; without one, only this machine may call. */
  token?: string;
  /** The folder of the web build served beside the API. */
  webDir?: string;
}

/** Result of validating one attachment object. */
export type AttachmentResult =
  | { readonly ok: true; readonly value: ChatAttachment }
  | { readonly ok: false; readonly error: string };

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: Response };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eqIgnoreAsciiCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let ca = a.charCodeAt(i);
    let cb = b.charCodeAt(i);
    if (ca === cb) continue;
    if (ca >= 0x41 && ca <= 0x5a) ca += 32;
    if (cb >= 0x41 && cb <= 0x5a) cb += 32;
    if (ca !== cb) return false;
  }
  return true;
}

function isAllAsciiDigits(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

function codePointCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      }
    }
    count++;
  }
  return count;
}

function takeCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  let i = 0;
  let count = 0;
  while (i < text.length && count < max) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 2;
        count++;
        continue;
      }
    }
    i++;
    count++;
  }
  return text.slice(0, i);
}

/** Compare two secrets without telling, by the time it takes, where they differ. */
export function sameSecret(given: string, expected: string): boolean {
  const givenBytes = Buffer.from(given, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  const len = Math.max(givenBytes.byteLength, expectedBytes.byteLength);
  const a = Buffer.alloc(len);
  const b = Buffer.alloc(len);
  givenBytes.copy(a);
  expectedBytes.copy(b);
  const equalBytes = len === 0 ? true : timingSafeEqual(a, b);
  return equalBytes && (givenBytes.byteLength ^ expectedBytes.byteLength) === 0;
}

/** The host of a `Host` header or an origin, without its port. */
export function hostName(host: string): string {
  if (host.startsWith("[")) {
    const rest = host.slice(1);
    const close = rest.indexOf("]");
    return close === -1 ? rest : rest.slice(0, close);
  }
  const colon = host.lastIndexOf(":");
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (isAllAsciiDigits(port)) {
      return host.slice(0, colon);
    }
  }
  return host;
}

/** Whether a parsed host name (without port) is `localhost` or a loopback IP address. */
export function loopbackName(name: string): boolean {
  return eqIgnoreAsciiCase(name, "localhost") || isLoopbackIp(name);
}

/** Why a request may not call the API, as the response to give. */
export function refused(request: Request, peer: SocketAddr, access: Access): Response | null {
  const host = request.header("host") ?? "";
  // A page of another site must not call the API through a person's browser.
  const origin = request.header("origin");
  if (origin !== undefined) {
    const sep = origin.indexOf("://");
    let same = false;
    if (sep !== -1) {
      const scheme = origin.slice(0, sep);
      const rest = origin.slice(sep + 3);
      same = (scheme === "http" || scheme === "https") && eqIgnoreAsciiCase(rest, host);
    }
    if (!same) {
      return Response.error(403, "Forbidden origin");
    }
  }
  if (access.token !== undefined) {
    const auth = request.header("authorization");
    const given = auth !== undefined && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!sameSecret(given.trim(), access.token)) {
      return Response.error(401, "A valid access token is required").withHeader("www-authenticate", "Bearer");
    }
    return null;
  }
  // Without a token only this machine calls, and under its own name: another name resolving here is refused.
  if (!isLoopbackIp(peer.host) || !loopbackName(hostName(host))) {
    return Response.error(403, "Only this computer may call the API without an access token");
  }
  return null;
}

function jsonBody(request: Request): ParseResult<unknown> {
  const contentTypeHeader = request.header("content-type") ?? "";
  const semi = contentTypeHeader.indexOf(";");
  const media = (semi === -1 ? contentTypeHeader : contentTypeHeader.slice(0, semi)).trim();
  if (!eqIgnoreAsciiCase(media, "application/json")) {
    return { ok: false, response: Response.error(415, "Expected application/json") };
  }
  try {
    const text = utf8FatalDecoder.decode(request.body);
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, response: Response.error(400, `Invalid JSON: ${errorMessage(error)}`) };
  }
}

function optionalJsonBody(request: Request): ParseResult<unknown> {
  if (request.body.byteLength === 0) {
    return { ok: true, value: {} };
  }
  return jsonBody(request);
}

/**
 * Strictly decode standard base64 (RFC 4648 with canonical padding and zero trailing bits),
 * matching Rust `base64::engine::general_purpose::STANDARD.decode`.
 */
export function decodeStrictBase64(encoded: string, maxBytes?: number): Uint8Array | null {
  const len = encoded.length;
  if (len === 0) {
    return new Uint8Array(0);
  }
  if ((len & 3) !== 0) {
    return null;
  }

  let pad = 0;
  if (encoded.charCodeAt(len - 1) === 0x3d /* '=' */) {
    pad = 1;
    if (encoded.charCodeAt(len - 2) === 0x3d /* '=' */) {
      pad = 2;
    }
  }

  const outLen = (len >>> 2) * 3 - pad;
  if (maxBytes !== undefined && outLen > maxBytes) {
    return null;
  }

  const out = new Uint8Array(outLen);
  const fullEnd = pad > 0 ? len - 4 : len;
  let outIdx = 0;

  for (let i = 0; i < fullEnd; i += 4) {
    const c0 = encoded.charCodeAt(i);
    const c1 = encoded.charCodeAt(i + 1);
    const c2 = encoded.charCodeAt(i + 2);
    const c3 = encoded.charCodeAt(i + 3);
    if ((c0 | c1 | c2 | c3) >= 128) return null;
    const v0 = B64_DECODE[c0];
    const v1 = B64_DECODE[c1];
    const v2 = B64_DECODE[c2];
    const v3 = B64_DECODE[c3];
    if ((v0 | v1 | v2 | v3) < 0) return null;
    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    out[outIdx++] = (triple >>> 16) & 0xff;
    out[outIdx++] = (triple >>> 8) & 0xff;
    out[outIdx++] = triple & 0xff;
  }

  if (pad === 1) {
    const c0 = encoded.charCodeAt(fullEnd);
    const c1 = encoded.charCodeAt(fullEnd + 1);
    const c2 = encoded.charCodeAt(fullEnd + 2);
    if ((c0 | c1 | c2) >= 128) return null;
    const v0 = B64_DECODE[c0];
    const v1 = B64_DECODE[c1];
    const v2 = B64_DECODE[c2];
    if ((v0 | v1 | v2) < 0) return null;
    if ((v2 & 0x03) !== 0) return null;
    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6);
    out[outIdx++] = (triple >>> 16) & 0xff;
    out[outIdx++] = (triple >>> 8) & 0xff;
  } else if (pad === 2) {
    const c0 = encoded.charCodeAt(fullEnd);
    const c1 = encoded.charCodeAt(fullEnd + 1);
    if ((c0 | c1) >= 128) return null;
    const v0 = B64_DECODE[c0];
    const v1 = B64_DECODE[c1];
    if ((v0 | v1) < 0) return null;
    if ((v1 & 0x0f) !== 0) return null;
    out[outIdx++] = (v0 << 2) | (v1 >>> 4);
  }

  return out;
}

/** Parse and validate one chat attachment object strictly. */
export function parseAttachment(value: unknown): AttachmentResult {
  if (!isRecord(value)) {
    return { ok: false, error: "Invalid attachment" };
  }
  const rawName = value.name;
  if (typeof rawName !== "string") {
    return { ok: false, error: "Attachment name must be a string" };
  }
  const cleanedName = takeCodePoints(rawName.replace(UNSAFE_ATTACHMENT_NAME_RE, "_").trim(), 200);
  const rawMediaType = typeof value.mediaType === "string" ? value.mediaType : "";
  const mediaType = takeCodePoints(rawMediaType.trim().toLowerCase(), 200);
  const encoded = value.data;
  if (typeof encoded !== "string") {
    return { ok: false, error: "Attachment data must be base64" };
  }
  // Four characters of base64 carry three bytes: refuse an oversized one before decoding it.
  if (encoded.length > MAX_BASE64_LEN) {
    return { ok: false, error: "Attachment data is invalid or exceeds 5 MiB" };
  }
  const data = decodeStrictBase64(encoded, MAX_FILE_BYTES);
  if (data === null || data.byteLength > MAX_FILE_BYTES) {
    return { ok: false, error: "Attachment data is invalid or exceeds 5 MiB" };
  }
  return {
    ok: true,
    value: {
      name: cleanedName.length === 0 ? "attachment" : cleanedName,
      mediaType,
      data,
    },
  };
}

async function chat(app: AppContext, request: Request): Promise<Response> {
  const parsed = jsonBody(request);
  if (!parsed.ok) {
    return parsed.response;
  }
  const body = parsed.value;
  if (!isRecord(body) || typeof body.text !== "string") {
    return Response.error(400, "Expected { text: string }");
  }
  const text = body.text.trim();

  const attachments: ChatAttachment[] = [];
  const rawAttachments = body.attachments;
  if (rawAttachments !== undefined && rawAttachments !== null) {
    if (!Array.isArray(rawAttachments)) {
      return Response.error(400, "attachments must be a list");
    }
    if (rawAttachments.length > MAX_FILES) {
      return Response.error(400, `At most ${MAX_FILES} attachments`);
    }
    for (let i = 0; i < rawAttachments.length; i++) {
      const parsedAttachment = parseAttachment(rawAttachments[i]);
      if (!parsedAttachment.ok) {
        return Response.error(400, parsedAttachment.error);
      }
      attachments.push(parsedAttachment.value);
    }
  }

  if ((text.length === 0 && attachments.length === 0) || codePointCount(text) > MAX_TEXT_CHARS) {
    return Response.error(400, `Message or attachment required; text limit ${MAX_TEXT_CHARS} characters`);
  }

  let messageId: string | undefined;
  const rawMessageId = body.messageId;
  if (rawMessageId !== undefined && rawMessageId !== null) {
    if (typeof rawMessageId !== "string") {
      return Response.error(400, "messageId must be a string");
    }
    messageId = rawMessageId;
  }

  try {
    const receipt = await app.receiveWeb(text, attachments, messageId);
    return Response.json(202, {
      requestId: receipt.requestId,
      triggerId: receipt.triggerId,
      result: receipt.result,
    });
  } catch (error) {
    return Response.error(400, errorMessage(error));
  }
}

async function done(work: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    return Response.json(200, await work());
  } catch (error) {
    return Response.error(400, errorMessage(error));
  }
}

const WORKERS_PREFIX = "/api/workers/";
const STOP_SUFFIX = "/stop";
const DEVICES_PREFIX = "/api/devices/";
const DEVICE_APPROVALS_PREFIX = "/api/devices/approvals/";
const DEVICE_ENROLLMENTS_PREFIX = "/api/devices/enrollments/";
const DEVICE_TRANSFERS_PREFIX = "/api/devices/transfers/";
const PUBLIC_ENROLL_CLAIM_PREFIX = "/enroll/claim/";
const VALID_TOKEN_TIERS: ReadonlySet<string> = new Set(["master", "os", "relay", "admin"]);

const textEncoder = new TextEncoder();

function safeDecodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function matchDeviceMcpServerPath(
  reqPath: string,
  suffix: string,
): { deviceId: string; serverId: string } | null {
  if (!reqPath.startsWith(DEVICES_PREFIX) || !reqPath.endsWith(suffix)) {
    return null;
  }
  const inner = reqPath.slice(DEVICES_PREFIX.length, reqPath.length - suffix.length);
  const mcpIdx = inner.indexOf("/mcp/");
  if (mcpIdx <= 0) {
    return null;
  }
  const rawDeviceId = inner.slice(0, mcpIdx);
  const rawServerId = inner.slice(mcpIdx + "/mcp/".length);
  if (!rawDeviceId || rawDeviceId.includes("/") || !rawServerId || rawServerId.includes("/")) {
    return null;
  }
  const deviceId = safeDecodeSegment(rawDeviceId);
  const serverId = safeDecodeSegment(rawServerId);
  if (!deviceId || deviceId.includes("/") || !serverId || serverId.includes("/")) {
    return null;
  }
  return { deviceId, serverId };
}

function parseQueryBool(
  params: URLSearchParams,
  keys: readonly string[],
  label: string,
): { ok: true; value?: boolean } | { ok: false; response: Response } {
  for (let i = 0; i < keys.length; i++) {
    const raw = params.get(keys[i]!);
    if (raw === null) continue;
    const lower = raw.trim().toLowerCase();
    if (lower === "true" || lower === "1") return { ok: true, value: true };
    if (lower === "false" || lower === "0") return { ok: true, value: false };
    return { ok: false, response: Response.error(400, `${label} must be true or false`) };
  }
  return { ok: true, value: undefined };
}

function mcpHttpErrorResponse(error: unknown): Response {
  const msg = errorMessage(error);
  const statusCode =
    msg.startsWith("Unknown device:") ||
    msg.startsWith("Unknown MCP server:") ||
    /mcp server .* not found/i.test(msg) ||
    /mcp server not found/i.test(msg)
      ? 404
      : msg.includes("Cross-cluster") || /locked/i.test(msg)
        ? 403
        : 400;
  return Response.error(statusCode, msg);
}

function requestOrigin(request: Request): string {
  const rawProto = (request.header("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase();
  const proto = rawProto === "https" ? "https" : "http";
  const rawHost =
    (request.header("x-forwarded-host") ?? request.header("host") ?? "").split(",")[0]?.trim() ||
    "127.0.0.1:3082";
  const safeHost = rawHost.replace(/[^A-Za-z0-9._:\[\]-]/g, "");
  return `${proto}://${safeHost || "127.0.0.1:3082"}`;
}

function parseOptionalStringField(
  body: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): { ok: true; value?: string } | { ok: false; response: Response } {
  for (let i = 0; i < keys.length; i++) {
    const val = body[keys[i]!];
    if (val === undefined) continue;
    if (val === null) return { ok: true, value: undefined };
    if (typeof val !== "string") {
      return { ok: false, response: Response.error(400, `${label} must be a string`) };
    }
    return { ok: true, value: val };
  }
  return { ok: true, value: undefined };
}

function parseOptionalBoolField(
  body: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): { ok: true; value?: boolean } | { ok: false; response: Response } {
  for (let i = 0; i < keys.length; i++) {
    const val = body[keys[i]!];
    if (val === undefined || val === null) continue;
    if (typeof val !== "boolean") {
      return { ok: false, response: Response.error(400, `${label} must be a boolean`) };
    }
    return { ok: true, value: val };
  }
  return { ok: true, value: undefined };
}

function parseOptionalIntField(
  body: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): { ok: true; value?: number } | { ok: false; response: Response } {
  for (let i = 0; i < keys.length; i++) {
    const val = body[keys[i]!];
    if (val === undefined || val === null) continue;
    if (typeof val !== "number" || !Number.isInteger(val)) {
      return { ok: false, response: Response.error(400, `${label} must be an integer`) };
    }
    return { ok: true, value: val };
  }
  return { ok: true, value: undefined };
}

function parseDeviceConfigInput(raw: unknown): ParseResult<DeviceConfigUpdateInput> {
  if (!isRecord(raw)) {
    return { ok: false, response: Response.error(400, "Expected JSON object") };
  }
  const clusterId = parseOptionalStringField(raw, ["clusterId", "cluster_id"], "clusterId");
  if (!clusterId.ok) return clusterId;
  const masterNodeId = parseOptionalStringField(raw, ["masterNodeId", "master_node_id"], "masterNodeId");
  if (!masterNodeId.ok) return masterNodeId;
  const relayUrl = parseOptionalStringField(raw, ["relayUrl", "relay_url"], "relayUrl");
  if (!relayUrl.ok) return relayUrl;
  const relaySecret = parseOptionalStringField(raw, ["relaySecret", "relay_secret"], "relaySecret");
  if (!relaySecret.ok) return relaySecret;
  const clusterSecret = parseOptionalStringField(raw, ["clusterSecret", "cluster_secret"], "clusterSecret");
  if (!clusterSecret.ok) return clusterSecret;
  const token = parseOptionalStringField(raw, ["token", "relayToken", "relay_token"], "token");
  if (!token.ok) return token;
  const e2eKey = parseOptionalStringField(raw, ["e2eKey", "e2e_key"], "e2eKey");
  if (!e2eKey.ok) return e2eKey;
  const tokenTtlSec = parseOptionalIntField(raw, ["tokenTtlSec", "token_ttl_sec"], "tokenTtlSec");
  if (!tokenTtlSec.ok) return tokenTtlSec;
  const autoDetectLocalRelay = parseOptionalBoolField(
    raw,
    ["autoDetectLocalRelay", "auto_detect_local_relay"],
    "autoDetectLocalRelay",
  );
  if (!autoDetectLocalRelay.ok) return autoDetectLocalRelay;
  const enabled = parseOptionalBoolField(raw, ["enabled"], "enabled");
  if (!enabled.ok) return enabled;

  return {
    ok: true,
    value: {
      ...(clusterId.value !== undefined ? { clusterId: clusterId.value } : {}),
      ...(masterNodeId.value !== undefined ? { masterNodeId: masterNodeId.value } : {}),
      ...(relayUrl.value !== undefined ? { relayUrl: relayUrl.value } : {}),
      ...(relaySecret.value !== undefined ? { relaySecret: relaySecret.value } : {}),
      ...(clusterSecret.value !== undefined ? { clusterSecret: clusterSecret.value } : {}),
      ...(token.value !== undefined ? { token: token.value } : {}),
      ...(e2eKey.value !== undefined ? { e2eKey: e2eKey.value } : {}),
      ...(tokenTtlSec.value !== undefined ? { tokenTtlSec: tokenTtlSec.value } : {}),
      ...(autoDetectLocalRelay.value !== undefined
        ? { autoDetectLocalRelay: autoDetectLocalRelay.value }
        : {}),
      ...(enabled.value !== undefined ? { enabled: enabled.value } : {}),
    },
  };
}

function parseEnrollmentCreateInput(raw: unknown): ParseResult<EnrollmentCreateInput> {
  if (!isRecord(raw)) {
    return { ok: false, response: Response.error(400, "Expected JSON object") };
  }
  const platform = parseOptionalStringField(raw, ["platform"], "platform");
  if (!platform.ok) return platform;
  const profile = parseOptionalStringField(raw, ["profile", "policyProfile", "policy_profile"], "profile");
  if (!profile.ok) return profile;
  const installMode = parseOptionalStringField(raw, ["installMode", "install_mode"], "installMode");
  if (!installMode.ok) return installMode;
  const deviceId = parseOptionalStringField(raw, ["deviceId", "device_id"], "deviceId");
  if (!deviceId.ok) return deviceId;
  const customName = parseOptionalStringField(
    raw,
    ["customName", "custom_name", "deviceName", "device_name"],
    "customName",
  );
  if (!customName.ok) return customName;
  const relayBridge = parseOptionalBoolField(raw, ["relayBridge", "relay_bridge"], "relayBridge");
  if (!relayBridge.ok) return relayBridge;
  const mqttBind = parseOptionalStringField(raw, ["mqttBind", "mqtt_bind"], "mqttBind");
  if (!mqttBind.ok) return mqttBind;
  const uartDevice = parseOptionalStringField(raw, ["uartDevice", "uart_device"], "uartDevice");
  if (!uartDevice.ok) return uartDevice;
  const cudaDevices = parseOptionalStringField(raw, ["cudaDevices", "cuda_devices"], "cudaDevices");
  if (!cudaDevices.ok) return cudaDevices;
  const memoryMax = parseOptionalStringField(raw, ["memoryMax", "memory_max"], "memoryMax");
  if (!memoryMax.ok) return memoryMax;
  const cpuQuota = parseOptionalStringField(raw, ["cpuQuota", "cpu_quota"], "cpuQuota");
  if (!cpuQuota.ok) return cpuQuota;
  const transportMode = parseOptionalStringField(raw, ["transportMode", "transport_mode"], "transportMode");
  if (!transportMode.ok) return transportMode;
  const masterPublicUrl = parseOptionalStringField(
    raw,
    ["masterPublicUrl", "master_public_url"],
    "masterPublicUrl",
  );
  if (!masterPublicUrl.ok) return masterPublicUrl;
  const ttlSec = parseOptionalIntField(raw, ["ttlSec", "ttl_sec"], "ttlSec");
  if (!ttlSec.ok) return ttlSec;
  const maxUses = parseOptionalIntField(raw, ["maxUses", "max_uses"], "maxUses");
  if (!maxUses.ok) return maxUses;
  const agentVersion = parseOptionalStringField(raw, ["agentVersion", "agent_version"], "agentVersion");
  if (!agentVersion.ok) return agentVersion;

  let workspaces: string[] | undefined;
  const rawWorkspaces = raw.workspaces;
  if (rawWorkspaces !== undefined && rawWorkspaces !== null) {
    if (!Array.isArray(rawWorkspaces) || !rawWorkspaces.every((w) => typeof w === "string")) {
      return { ok: false, response: Response.error(400, "workspaces must be an array of strings") };
    }
    workspaces = rawWorkspaces;
  }

  let downloadMirrors: string[] | undefined;
  const rawMirrors = raw.downloadMirrors ?? raw.download_mirrors;
  if (rawMirrors !== undefined && rawMirrors !== null) {
    if (!Array.isArray(rawMirrors) || !rawMirrors.every((m) => typeof m === "string")) {
      return { ok: false, response: Response.error(400, "downloadMirrors must be an array of strings") };
    }
    downloadMirrors = rawMirrors;
  }

  let checksums: Record<string, string> | undefined;
  const rawChecksums = raw.checksums;
  if (rawChecksums !== undefined && rawChecksums !== null) {
    if (
      !isRecord(rawChecksums) ||
      !Object.values(rawChecksums).every((v) => typeof v === "string")
    ) {
      return { ok: false, response: Response.error(400, "checksums must be a map of strings") };
    }
    checksums = rawChecksums as Record<string, string>;
  }

  return {
    ok: true,
    value: {
      ...(platform.value !== undefined ? { platform: platform.value as EnrollmentPlatform } : {}),
      ...(profile.value !== undefined ? { profile: profile.value as EnrollmentProfile } : {}),
      ...(installMode.value !== undefined ? { installMode: installMode.value as EnrollmentInstallMode } : {}),
      ...(deviceId.value !== undefined ? { deviceId: deviceId.value } : {}),
      ...(customName.value !== undefined ? { customName: customName.value } : {}),
      ...(workspaces !== undefined ? { workspaces } : {}),
      ...(relayBridge.value !== undefined ? { relayBridge: relayBridge.value } : {}),
      ...(mqttBind.value !== undefined ? { mqttBind: mqttBind.value } : {}),
      ...(uartDevice.value !== undefined ? { uartDevice: uartDevice.value } : {}),
      ...(cudaDevices.value !== undefined ? { cudaDevices: cudaDevices.value } : {}),
      ...(memoryMax.value !== undefined ? { memoryMax: memoryMax.value } : {}),
      ...(cpuQuota.value !== undefined ? { cpuQuota: cpuQuota.value } : {}),
      ...(transportMode.value !== undefined
        ? { transportMode: transportMode.value as EnrollmentTransportMode }
        : {}),
      ...(masterPublicUrl.value !== undefined ? { masterPublicUrl: masterPublicUrl.value } : {}),
      ...(ttlSec.value !== undefined ? { ttlSec: ttlSec.value } : {}),
      ...(maxUses.value !== undefined ? { maxUses: maxUses.value } : {}),
      ...(agentVersion.value !== undefined ? { agentVersion: agentVersion.value } : {}),
      ...(downloadMirrors !== undefined ? { downloadMirrors } : {}),
      ...(checksums !== undefined ? { checksums } : {}),
    },
  };
}

function parseMcuInstallInput(raw: unknown): ParseResult<McuInstallInput> {
  if (!isRecord(raw)) {
    return { ok: false, response: Response.error(400, "Expected JSON object") };
  }
  const mcuId = parseOptionalStringField(raw, ["mcuId", "mcu_id"], "mcuId");
  if (!mcuId.ok) return mcuId;
  if (!mcuId.value || mcuId.value.trim().length === 0) {
    return { ok: false, response: Response.error(400, "mcuId is required") };
  }
  const customName = parseOptionalStringField(
    raw,
    ["customName", "custom_name", "deviceName", "device_name"],
    "customName",
  );
  if (!customName.ok) return customName;
  const relayDeviceId = parseOptionalStringField(
    raw,
    ["relayDeviceId", "relay_device_id"],
    "relayDeviceId",
  );
  if (!relayDeviceId.ok) return relayDeviceId;
  if (!relayDeviceId.value || relayDeviceId.value.trim().length === 0) {
    return { ok: false, response: Response.error(400, "relayDeviceId is required") };
  }
  const transport = parseOptionalStringField(raw, ["transport"], "transport");
  if (!transport.ok) return transport;
  if (transport.value !== "mqtt" && transport.value !== "serial") {
    return { ok: false, response: Response.error(400, "transport must be mqtt or serial") };
  }
  const mqttBroker = parseOptionalStringField(raw, ["mqttBroker", "mqtt_broker"], "mqttBroker");
  if (!mqttBroker.ok) return mqttBroker;
  const serialPort = parseOptionalStringField(raw, ["serialPort", "serial_port"], "serialPort");
  if (!serialPort.ok) return serialPort;
  const baudRate = parseOptionalIntField(raw, ["baudRate", "baud_rate"], "baudRate");
  if (!baudRate.ok) return baudRate;
  const chip = parseOptionalStringField(raw, ["chip"], "chip");
  if (!chip.ok) return chip;
  const autoDeploy = parseOptionalBoolField(raw, ["autoDeploy", "auto_deploy"], "autoDeploy");
  if (!autoDeploy.ok) return autoDeploy;

  let backupRelayDeviceIds: string[] | undefined;
  const rawBackups = raw.backupRelayDeviceIds ?? raw.backup_relay_device_ids;
  if (rawBackups !== undefined && rawBackups !== null) {
    if (!Array.isArray(rawBackups) || !rawBackups.every((x) => typeof x === "string")) {
      return {
        ok: false,
        response: Response.error(400, "backupRelayDeviceIds must be an array of strings"),
      };
    }
    backupRelayDeviceIds = rawBackups;
  }

  return {
    ok: true,
    value: {
      mcuId: mcuId.value.trim(),
      ...(customName.value !== undefined ? { customName: customName.value } : {}),
      relayDeviceId: relayDeviceId.value.trim(),
      transport: transport.value as McuTransportKind,
      ...(mqttBroker.value !== undefined ? { mqttBroker: mqttBroker.value } : {}),
      ...(serialPort.value !== undefined ? { serialPort: serialPort.value } : {}),
      ...(baudRate.value !== undefined ? { baudRate: baudRate.value } : {}),
      ...(chip.value !== undefined ? { chip: chip.value } : {}),
      ...(backupRelayDeviceIds !== undefined ? { backupRelayDeviceIds } : {}),
      ...(autoDeploy.value !== undefined ? { autoDeploy: autoDeploy.value } : {}),
    },
  };
}

async function routeDevices(
  app: AppContext,
  method: string,
  reqPath: string,
  request: Request,
): Promise<Response | null> {
  if (method === "GET") {
    if (reqPath === "/api/devices") {
      app.devices.triggerBackgroundSync();
      return jsonWithEtag(request, {
        config: app.devices.configView(),
        devices: app.devices.listDevices(),
        approvals: app.devices.listApprovals(),
        enrollments: app.devices.listEnrollments(),
      });
    }
    if (reqPath === "/api/devices/config") {
      return Response.json(200, {
        config: app.devices.configView(),
      });
    }
    if (reqPath === "/api/devices/approvals") {
      return Response.json(200, {
        approvals: app.devices.listApprovals(),
      });
    }
    if (reqPath === "/api/devices/enrollments") {
      return Response.json(200, {
        enrollments: app.devices.listEnrollments(),
      });
    }
    if (reqPath === "/api/devices/transfers") {
      return Response.json(200, {
        transfers: app.devices.listTransfers(),
      });
    }
    if (reqPath.startsWith(DEVICE_TRANSFERS_PREFIX)) {
      const id = safeDecodeSegment(reqPath.slice(DEVICE_TRANSFERS_PREFIX.length));
      if (!id || id.includes("/")) {
        return Response.error(404, "Transfer not found");
      }
      const transfer = app.devices.getTransfer(id);
      if (transfer === null) {
        return Response.error(404, "Transfer not found");
      }
      return Response.json(200, { transfer });
    }
    if (reqPath.startsWith(DEVICE_ENROLLMENTS_PREFIX)) {
      const id = safeDecodeSegment(reqPath.slice(DEVICE_ENROLLMENTS_PREFIX.length));
      if (!id || id.includes("/")) {
        return Response.error(404, "Enrollment not found");
      }
      const enrollment = await app.devices.getEnrollment(id, { syncRelay: true });
      if (enrollment === null) {
        return Response.error(404, "Enrollment not found");
      }
      const devices = enrollment.enrolledDeviceIds
        .map((devId) => app.devices.getDevice(devId))
        .filter((twin): twin is NonNullable<typeof twin> => twin !== null);
      return Response.json(200, { enrollment, devices });
    }
    const mcpToolsRoute = matchDeviceMcpServerPath(reqPath, "/tools");
    if (mcpToolsRoute !== null) {
      const params = new URLSearchParams(request.query);
      const rawQuery = params.get("query");
      const refresh = parseQueryBool(params, ["refresh"], "refresh");
      if (!refresh.ok) return refresh.response;
      const includeResources = parseQueryBool(
        params,
        ["includeResources", "include_resources"],
        "includeResources",
      );
      if (!includeResources.ok) return includeResources.response;
      const includePrompts = parseQueryBool(
        params,
        ["includePrompts", "include_prompts"],
        "includePrompts",
      );
      if (!includePrompts.ok) return includePrompts.response;
      const rawTimeout = params.get("timeoutMs") ?? params.get("timeout_ms");
      let timeoutMs: number | undefined;
      if (rawTimeout !== null && rawTimeout.trim().length > 0) {
        const parsedTimeout = Number(rawTimeout);
        if (!Number.isInteger(parsedTimeout) || parsedTimeout <= 0) {
          return Response.error(400, "timeoutMs must be a positive integer");
        }
        timeoutMs = parsedTimeout;
      }
      try {
        const result = await app.devices.inspectDeviceMcp(
          mcpToolsRoute.deviceId,
          mcpToolsRoute.serverId,
          {
            ...(rawQuery !== null && rawQuery.trim().length > 0 ? { query: rawQuery } : {}),
            ...(refresh.value !== undefined ? { refresh: refresh.value } : {}),
            ...(includeResources.value !== undefined ? { includeResources: includeResources.value } : {}),
            ...(includePrompts.value !== undefined ? { includePrompts: includePrompts.value } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          },
        );
        return Response.json(200, result);
      } catch (error) {
        return mcpHttpErrorResponse(error);
      }
    }
    if (reqPath.startsWith(DEVICES_PREFIX) && reqPath.endsWith("/mcp")) {
      const id = safeDecodeSegment(
        reqPath.slice(DEVICES_PREFIX.length, reqPath.length - "/mcp".length),
      );
      if (!id || id.includes("/")) {
        return Response.error(404, "Device not found");
      }
      try {
        return Response.json(200, app.devices.getDeviceMcp(id));
      } catch (error) {
        return mcpHttpErrorResponse(error);
      }
    }
    if (reqPath.startsWith(DEVICES_PREFIX)) {
      const id = safeDecodeSegment(reqPath.slice(DEVICES_PREFIX.length));
      if (!id || id.includes("/")) {
        return Response.error(404, "Device not found");
      }
      const twin = app.devices.getDevice(id);
      if (twin === null) {
        return Response.error(404, "Device not found");
      }
      return Response.json(200, twin);
    }
    return null;
  }

  if (method === "POST") {
    if (reqPath === "/api/devices/config/init") {
      const parsed = optionalJsonBody(request);
      if (!parsed.ok) return parsed.response;
      const input = parseDeviceConfigInput(parsed.value);
      if (!input.ok) return input.response;
      return await done(async () => ({
        config: await app.devices.initOrUpdateConfig(input.value),
      }));
    }

    if (reqPath === "/api/devices/enrollments") {
      const parsed = optionalJsonBody(request);
      if (!parsed.ok) return parsed.response;
      const input = parseEnrollmentCreateInput(parsed.value);
      if (!input.ok) return input.response;
      const origin = requestOrigin(request);
      return await done(async () => ({
        enrollment: await app.devices.createEnrollment(input.value, { requestOrigin: origin }),
      }));
    }

    if (reqPath === "/api/devices/mcu/install") {
      const parsed = jsonBody(request);
      if (!parsed.ok) return parsed.response;
      const input = parseMcuInstallInput(parsed.value);
      if (!input.ok) return input.response;
      return await done(async () => await app.devices.installMcuViaTier1(input.value));
    }

    if (reqPath === "/api/devices/token") {
      const parsed = jsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value)) {
        return Response.error(400, "Expected JSON object");
      }
      const rawNodeId = parsed.value.nodeId ?? parsed.value.node_id;
      const rawTier = parsed.value.tier;
      const rawClusterId = parsed.value.clusterId ?? parsed.value.cluster_id;
      const rawTtl = parsed.value.ttlSec ?? parsed.value.ttl_sec;
      if (typeof rawNodeId !== "string" || rawNodeId.trim().length === 0) {
        return Response.error(400, "nodeId is required");
      }
      if (typeof rawTier !== "string" || !VALID_TOKEN_TIERS.has(rawTier)) {
        return Response.error(400, "tier must be master, os, relay, or admin");
      }
      if (rawClusterId !== undefined && (typeof rawClusterId !== "string" || rawClusterId.trim().length === 0)) {
        return Response.error(400, "clusterId must be a non-empty string");
      }
      if (rawTtl !== undefined && (typeof rawTtl !== "number" || !Number.isInteger(rawTtl) || rawTtl <= 0)) {
        return Response.error(400, "ttlSec must be a positive integer");
      }
      return await done(() => {
        const token = app.devices.mintToken({
          nodeId: rawNodeId.trim(),
          tier: rawTier as TokenTier,
          ...(typeof rawClusterId === "string" ? { clusterId: rawClusterId.trim() } : {}),
          ...(typeof rawTtl === "number" ? { ttlSec: rawTtl } : {}),
        });
        return {
          token,
          nodeId: rawNodeId.trim(),
          tier: rawTier,
          clusterId: typeof rawClusterId === "string" ? rawClusterId.trim() : app.devices.configView().clusterId,
        };
      });
    }

    if (reqPath.startsWith(DEVICE_APPROVALS_PREFIX)) {
      const rest = reqPath.slice(DEVICE_APPROVALS_PREFIX.length);
      if (rest.endsWith("/approve") || rest.endsWith("/reject")) {
        const isApprove = rest.endsWith("/approve");
        const suffix = isApprove ? "/approve" : "/reject";
        const id = safeDecodeSegment(rest.slice(0, rest.length - suffix.length));
        if (!id || id.includes("/")) {
          return Response.error(404, "Approval not found");
        }
        const parsed = optionalJsonBody(request);
        if (!parsed.ok) return parsed.response;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const reason = typeof body.reason === "string" ? body.reason : undefined;
        try {
          if (isApprove) {
            return Response.json(200, await app.devices.approve(id, "http"));
          }
          return Response.json(200, { approval: app.devices.reject(id, reason, "http") });
        } catch (error) {
          const msg = errorMessage(error);
          return Response.error(msg.startsWith("Approval not found:") ? 404 : 400, msg);
        }
      }
      return Response.error(404, "Not found");
    }

    if (reqPath.startsWith(DEVICES_PREFIX) && reqPath.endsWith("/mcp/discover")) {
      const id = safeDecodeSegment(
        reqPath.slice(DEVICES_PREFIX.length, reqPath.length - "/mcp/discover".length),
      );
      if (!id || id.includes("/")) {
        return Response.error(404, "Device not found");
      }
      const parsed = optionalJsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value)) {
        return Response.error(400, "Expected JSON object");
      }
      const includeLoopbackProbe = parseOptionalBoolField(
        parsed.value,
        ["includeLoopbackProbe", "include_loopback_probe"],
        "includeLoopbackProbe",
      );
      if (!includeLoopbackProbe.ok) return includeLoopbackProbe.response;
      let sources: string[] | undefined;
      const rawSources = parsed.value.sources;
      if (rawSources !== undefined && rawSources !== null) {
        if (!Array.isArray(rawSources) || !rawSources.every((s) => typeof s === "string")) {
          return Response.error(400, "sources must be an array of strings");
        }
        sources = rawSources;
      }
      const timeoutMs = parseOptionalIntField(parsed.value, ["timeoutMs", "timeout_ms"], "timeoutMs");
      if (!timeoutMs.ok) return timeoutMs.response;
      if (timeoutMs.value !== undefined && timeoutMs.value <= 0) {
        return Response.error(400, "timeoutMs must be a positive integer");
      }
      try {
        const overview = await app.devices.discoverDeviceMcp(id, {
          ...(includeLoopbackProbe.value !== undefined
            ? { includeLoopbackProbe: includeLoopbackProbe.value }
            : {}),
          ...(sources !== undefined ? { sources } : {}),
          ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
        });
        return Response.json(200, overview);
      } catch (error) {
        return mcpHttpErrorResponse(error);
      }
    }

    const mcpInspectRoute = matchDeviceMcpServerPath(reqPath, "/inspect");
    if (mcpInspectRoute !== null) {
      const parsed = optionalJsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value)) {
        return Response.error(400, "Expected JSON object");
      }
      const query = parseOptionalStringField(parsed.value, ["query"], "query");
      if (!query.ok) return query.response;
      const includeResources = parseOptionalBoolField(
        parsed.value,
        ["includeResources", "include_resources"],
        "includeResources",
      );
      if (!includeResources.ok) return includeResources.response;
      const includePrompts = parseOptionalBoolField(
        parsed.value,
        ["includePrompts", "include_prompts"],
        "includePrompts",
      );
      if (!includePrompts.ok) return includePrompts.response;
      const refresh = parseOptionalBoolField(parsed.value, ["refresh"], "refresh");
      if (!refresh.ok) return refresh.response;
      const timeoutMs = parseOptionalIntField(parsed.value, ["timeoutMs", "timeout_ms"], "timeoutMs");
      if (!timeoutMs.ok) return timeoutMs.response;
      if (timeoutMs.value !== undefined && timeoutMs.value <= 0) {
        return Response.error(400, "timeoutMs must be a positive integer");
      }
      try {
        const result = await app.devices.inspectDeviceMcp(
          mcpInspectRoute.deviceId,
          mcpInspectRoute.serverId,
          {
            ...(query.value !== undefined && query.value.trim().length > 0 ? { query: query.value } : {}),
            ...(includeResources.value !== undefined ? { includeResources: includeResources.value } : {}),
            ...(includePrompts.value !== undefined ? { includePrompts: includePrompts.value } : {}),
            ...(refresh.value !== undefined ? { refresh: refresh.value } : {}),
            ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
          },
        );
        return Response.json(200, result);
      } catch (error) {
        return mcpHttpErrorResponse(error);
      }
    }

    const mcpCallRoute = matchDeviceMcpServerPath(reqPath, "/call");
    if (mcpCallRoute !== null) {
      const parsed = jsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value)) {
        return Response.error(400, "Expected JSON object");
      }
      const actionField = parseOptionalStringField(parsed.value, ["action"], "action");
      if (!actionField.ok) return actionField.response;
      const action = (actionField.value?.trim() || "tools/call") as McpCallAction;
      if (action !== "tools/call" && action !== "resources/read" && action !== "prompts/get") {
        return Response.error(400, "action must be tools/call, resources/read, or prompts/get");
      }
      const toolName = parseOptionalStringField(parsed.value, ["toolName", "tool_name"], "toolName");
      if (!toolName.ok) return toolName.response;
      const uri = parseOptionalStringField(parsed.value, ["uri"], "uri");
      if (!uri.ok) return uri.response;
      const promptName = parseOptionalStringField(
        parsed.value,
        ["promptName", "prompt_name", "name"],
        "promptName",
      );
      if (!promptName.ok) return promptName.response;
      const reason = parseOptionalStringField(parsed.value, ["reason"], "reason");
      if (!reason.ok) return reason.response;
      const rawArgs = parsed.value.arguments ?? parsed.value.args;
      if (rawArgs !== undefined && rawArgs !== null && !isRecord(rawArgs)) {
        return Response.error(400, "arguments must be an object");
      }
      const timeoutMs = parseOptionalIntField(parsed.value, ["timeoutMs", "timeout_ms"], "timeoutMs");
      if (!timeoutMs.ok) return timeoutMs.response;
      if (timeoutMs.value !== undefined && timeoutMs.value <= 0) {
        return Response.error(400, "timeoutMs must be a positive integer");
      }
      try {
        const result = await app.devices.callDeviceMcp(mcpCallRoute.deviceId, {
          serverId: mcpCallRoute.serverId,
          action,
          ...(toolName.value !== undefined ? { toolName: toolName.value } : {}),
          ...(isRecord(rawArgs) ? { arguments: rawArgs } : {}),
          ...(uri.value !== undefined ? { uri: uri.value } : {}),
          ...(promptName.value !== undefined ? { promptName: promptName.value } : {}),
          ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
          ...(reason.value !== undefined ? { reason: reason.value } : {}),
        });
        if (result.status === "ok") {
          return Response.json(200, result);
        }
        if (result.status === "pending_approval" || result.status === "queued") {
          return Response.json(202, result);
        }
        const statusCode =
          result.error.startsWith("Unknown device:") || result.error.startsWith("Unknown MCP server:")
            ? 404
            : result.error.includes("forbidden") ||
                result.error.includes("Cross-cluster") ||
                result.error.includes("blocked") ||
                result.error.includes("disabled") ||
                /locked/i.test(result.error)
              ? 403
              : 400;
        return Response.json(statusCode, result);
      } catch (error) {
        return mcpHttpErrorResponse(error);
      }
    }

    const mcpStopRoute = matchDeviceMcpServerPath(reqPath, "/stop");
    if (mcpStopRoute !== null) {
      const parsed = optionalJsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value)) {
        return Response.error(400, "Expected JSON object");
      }
      const timeoutMs = parseOptionalIntField(parsed.value, ["timeoutMs", "timeout_ms"], "timeoutMs");
      if (!timeoutMs.ok) return timeoutMs.response;
      if (timeoutMs.value !== undefined && timeoutMs.value <= 0) {
        return Response.error(400, "timeoutMs must be a positive integer");
      }
      try {
        return Response.json(
          200,
          await app.devices.stopDeviceMcpServer(
            mcpStopRoute.deviceId,
            mcpStopRoute.serverId,
            timeoutMs.value,
          ),
        );
      } catch (error) {
        return mcpHttpErrorResponse(error);
      }
    }

    const mcpRestartRoute = matchDeviceMcpServerPath(reqPath, "/restart");
    if (mcpRestartRoute !== null) {
      const parsed = optionalJsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value)) {
        return Response.error(400, "Expected JSON object");
      }
      const timeoutMs = parseOptionalIntField(parsed.value, ["timeoutMs", "timeout_ms"], "timeoutMs");
      if (!timeoutMs.ok) return timeoutMs.response;
      if (timeoutMs.value !== undefined && timeoutMs.value <= 0) {
        return Response.error(400, "timeoutMs must be a positive integer");
      }
      try {
        return Response.json(
          200,
          await app.devices.restartDeviceMcpServer(
            mcpRestartRoute.deviceId,
            mcpRestartRoute.serverId,
            timeoutMs.value,
          ),
        );
      } catch (error) {
        return mcpHttpErrorResponse(error);
      }
    }

    if (reqPath.startsWith(DEVICES_PREFIX) && reqPath.endsWith("/files/stat")) {
      const id = safeDecodeSegment(
        reqPath.slice(DEVICES_PREFIX.length, reqPath.length - "/files/stat".length),
      );
      if (!id || id.includes("/")) {
        return Response.error(404, "Device not found");
      }
      const parsed = jsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value)) {
        return Response.error(400, "Expected JSON object");
      }
      const filePath = parseOptionalStringField(parsed.value, ["path", "remotePath", "remote_path"], "path");
      if (!filePath.ok) return filePath.response;
      if (!filePath.value || filePath.value.trim().length === 0) {
        return Response.error(400, "path is required");
      }
      const sha256 = parseOptionalBoolField(parsed.value, ["sha256", "checksum"], "sha256");
      if (!sha256.ok) return sha256.response;
      const timeoutMs = parseOptionalIntField(parsed.value, ["timeoutMs", "timeout_ms"], "timeoutMs");
      if (!timeoutMs.ok) return timeoutMs.response;
      if (timeoutMs.value !== undefined && timeoutMs.value <= 0) {
        return Response.error(400, "timeoutMs must be a positive integer");
      }
      try {
        const result = await app.devices.statFile(id, filePath.value.trim(), {
          ...(sha256.value !== undefined ? { sha256: sha256.value } : {}),
          ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
        });
        if (result.status === "ok") {
          return Response.json(200, result);
        }
        if (result.status === "queued" || result.status === "pending_approval") {
          return Response.json(202, result);
        }
        const statusCode = result.error.startsWith("Unknown device:")
          ? 404
          : result.error.includes("forbidden") || result.error.includes("Cross-cluster")
            ? 403
            : 400;
        return Response.json(statusCode, result);
      } catch (error) {
        return Response.error(400, errorMessage(error));
      }
    }

    if (
      reqPath.startsWith(DEVICES_PREFIX) &&
      (reqPath.endsWith("/files/pull") || reqPath.endsWith("/files/push"))
    ) {
      const isPull = reqPath.endsWith("/files/pull");
      const suffix = isPull ? "/files/pull" : "/files/push";
      const id = safeDecodeSegment(
        reqPath.slice(DEVICES_PREFIX.length, reqPath.length - suffix.length),
      );
      if (!id || id.includes("/")) {
        return Response.error(404, "Device not found");
      }
      const parsed = jsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value)) {
        return Response.error(400, "Expected JSON object");
      }
      const remotePath = parseOptionalStringField(
        parsed.value,
        ["remotePath", "remote_path"],
        "remotePath",
      );
      if (!remotePath.ok) return remotePath.response;
      if (!remotePath.value || remotePath.value.trim().length === 0) {
        return Response.error(400, "remotePath is required");
      }
      const localPath = parseOptionalStringField(
        parsed.value,
        ["localPath", "local_path"],
        "localPath",
      );
      if (!localPath.ok) return localPath.response;
      if (!localPath.value || localPath.value.trim().length === 0) {
        return Response.error(400, "localPath is required");
      }
      const overwrite = parseOptionalBoolField(parsed.value, ["overwrite"], "overwrite");
      if (!overwrite.ok) return overwrite.response;
      const resume = parseOptionalBoolField(parsed.value, ["resume"], "resume");
      if (!resume.ok) return resume.response;
      const transferId = parseOptionalStringField(
        parsed.value,
        ["transferId", "transfer_id"],
        "transferId",
      );
      if (!transferId.ok) return transferId.response;
      const chunkSize = parseOptionalIntField(parsed.value, ["chunkSize", "chunk_size"], "chunkSize");
      if (!chunkSize.ok) return chunkSize.response;
      if (chunkSize.value !== undefined && (chunkSize.value < 4096 || chunkSize.value > 524_288)) {
        return Response.error(400, "chunkSize must be between 4096 and 524288");
      }
      const timeoutMs = parseOptionalIntField(parsed.value, ["timeoutMs", "timeout_ms"], "timeoutMs");
      if (!timeoutMs.ok) return timeoutMs.response;
      if (timeoutMs.value !== undefined && (timeoutMs.value < 1000 || timeoutMs.value > 600_000)) {
        return Response.error(400, "timeoutMs must be between 1000 and 600000");
      }
      try {
        const shared = {
          deviceId: id,
          remotePath: remotePath.value.trim(),
          localPath: localPath.value.trim(),
          ...(overwrite.value !== undefined ? { overwrite: overwrite.value } : {}),
          ...(resume.value !== undefined ? { resume: resume.value } : {}),
          ...(transferId.value !== undefined ? { transferId: transferId.value.trim() } : {}),
          ...(chunkSize.value !== undefined ? { chunkSize: chunkSize.value } : {}),
          ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
        };
        const result = isPull
          ? await app.devices.pullFile(shared)
          : await app.devices.pushFile(shared);
        return Response.json(200, { transfer: result });
      } catch (error) {
        const msg = errorMessage(error);
        const statusCode = msg.startsWith("Unknown device:")
          ? 404
          : msg.includes("Cross-cluster") || msg.includes("forbidden")
            ? 403
            : 400;
        return Response.error(statusCode, msg);
      }
    }

    if (reqPath.startsWith(DEVICES_PREFIX) && reqPath.endsWith("/ping")) {
      const id = safeDecodeSegment(
        reqPath.slice(DEVICES_PREFIX.length, reqPath.length - "/ping".length),
      );
      if (!id || id.includes("/")) {
        return Response.error(404, "Device not found");
      }
      if (app.devices.getDevice(id) === null) {
        return Response.error(404, "Device not found");
      }
      return await done(async () => await app.devices.pingDevice(id));
    }

    if (reqPath.startsWith(DEVICES_PREFIX) && reqPath.endsWith("/update")) {
      const id = safeDecodeSegment(
        reqPath.slice(DEVICES_PREFIX.length, reqPath.length - "/update".length),
      );
      if (!id || id.includes("/")) {
        return Response.error(404, "Device not found");
      }
      if (app.devices.getDevice(id) === null) {
        return Response.error(404, "Device not found");
      }
      const parsed = optionalJsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value)) {
        return Response.error(400, "Expected JSON object");
      }
      const targetVersion = parseOptionalStringField(
        parsed.value,
        ["targetVersion", "target_version", "version"],
        "targetVersion",
      );
      if (!targetVersion.ok) return targetVersion.response;
      const sha256 = parseOptionalStringField(parsed.value, ["sha256"], "sha256");
      if (!sha256.ok) return sha256.response;
      const force = parseOptionalBoolField(parsed.value, ["force"], "force");
      if (!force.ok) return force.response;
      const timeoutMs = parseOptionalIntField(
        parsed.value,
        ["timeoutMs", "timeout_ms"],
        "timeoutMs",
      );
      if (!timeoutMs.ok) return timeoutMs.response;
      if (timeoutMs.value !== undefined && timeoutMs.value <= 0) {
        return Response.error(400, "timeoutMs must be a positive integer");
      }
      let downloadMirrors: string[] | undefined;
      const rawMirrors = parsed.value.downloadMirrors ?? parsed.value.download_mirrors ?? parsed.value.mirrors;
      if (rawMirrors !== undefined && rawMirrors !== null) {
        if (!Array.isArray(rawMirrors) || !rawMirrors.every((m) => typeof m === "string")) {
          return Response.error(400, "downloadMirrors must be an array of strings");
        }
        downloadMirrors = rawMirrors;
      }
      const updateInput: DeviceUpdateInput = {
        ...(targetVersion.value !== undefined ? { targetVersion: targetVersion.value } : {}),
        ...(downloadMirrors !== undefined ? { downloadMirrors } : {}),
        ...(sha256.value !== undefined ? { sha256: sha256.value } : {}),
        ...(force.value !== undefined ? { force: force.value } : {}),
        ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
      };
      const origin = requestOrigin(request);
      return await done(
        async () => await app.devices.updateDevice(id, updateInput, { requestOrigin: origin }),
      );
    }

    if (reqPath.startsWith(DEVICES_PREFIX) && reqPath.endsWith("/invoke")) {
      const id = safeDecodeSegment(
        reqPath.slice(DEVICES_PREFIX.length, reqPath.length - "/invoke".length),
      );
      if (!id || id.includes("/")) {
        return Response.error(404, "Device not found");
      }
      const parsed = jsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value) || typeof parsed.value.action !== "string" || parsed.value.action.trim().length === 0) {
        return Response.error(400, "Expected { action: string }");
      }
      const rawParams = parsed.value.params;
      if (rawParams !== undefined && rawParams !== null && !isRecord(rawParams)) {
        return Response.error(400, "params must be an object");
      }
      const rawTimeout = parsed.value.timeoutMs ?? parsed.value.timeout_ms;
      if (rawTimeout !== undefined && (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout <= 0)) {
        return Response.error(400, "timeoutMs must be a positive integer");
      }
      const forceQueue = parsed.value.forceQueue ?? parsed.value.force_queue;
      if (forceQueue !== undefined && typeof forceQueue !== "boolean") {
        return Response.error(400, "forceQueue must be a boolean");
      }
      const reason = typeof parsed.value.reason === "string" ? parsed.value.reason : undefined;

      try {
        const result = await app.devices.invoke(id, {
          action: parsed.value.action.trim(),
          params: isRecord(rawParams) ? rawParams : {},
          ...(typeof rawTimeout === "number" ? { timeoutMs: rawTimeout } : {}),
          ...(typeof forceQueue === "boolean" ? { forceQueue } : {}),
          ...(reason !== undefined ? { reason } : {}),
        });
        if (result.status === "ok") {
          return Response.json(200, result);
        }
        if (result.status === "queued" || result.status === "pending_approval") {
          return Response.json(202, result);
        }
        const statusCode = result.error.startsWith("Unknown device:")
          ? 404
          : result.error.includes("forbidden") || result.error.includes("Cross-cluster")
            ? 403
            : 400;
        return Response.json(statusCode, result);
      } catch (error) {
        return Response.error(400, errorMessage(error));
      }
    }
  }

  if (method === "PUT" || method === "PATCH") {
    if (method === "PUT" && reqPath === "/api/devices/config") {
      const parsed = jsonBody(request);
      if (!parsed.ok) return parsed.response;
      const input = parseDeviceConfigInput(parsed.value);
      if (!input.ok) return input.response;
      return await done(async () => ({
        config: await app.devices.initOrUpdateConfig(input.value),
      }));
    }
    const mcpPolicyRoute = matchDeviceMcpServerPath(reqPath, "/policy");
    if (mcpPolicyRoute !== null) {
      const parsed = jsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value)) {
        return Response.error(400, "Expected JSON object");
      }
      const enabled = parseOptionalBoolField(parsed.value, ["enabled"], "enabled");
      if (!enabled.ok) return enabled.response;
      const callModeField = parseOptionalStringField(
        parsed.value,
        ["callMode", "call_mode"],
        "callMode",
      );
      if (!callModeField.ok) return callModeField.response;
      let callMode: McpCallPolicyMode | undefined;
      if (callModeField.value !== undefined) {
        if (!isMcpCallPolicyMode(callModeField.value)) {
          return Response.error(
            400,
            `callMode must be one of: ${MCP_CALL_POLICY_MODES.join(", ")}`,
          );
        }
        callMode = callModeField.value;
      }
      if (enabled.value === undefined && callMode === undefined) {
        return Response.error(400, "At least one of enabled or callMode is required");
      }
      const timeoutMs = parseOptionalIntField(parsed.value, ["timeoutMs", "timeout_ms"], "timeoutMs");
      if (!timeoutMs.ok) return timeoutMs.response;
      if (timeoutMs.value !== undefined && timeoutMs.value <= 0) {
        return Response.error(400, "timeoutMs must be a positive integer");
      }
      try {
        const result = await app.devices.setDeviceMcpServerPolicy(
          mcpPolicyRoute.deviceId,
          mcpPolicyRoute.serverId,
          {
            ...(enabled.value !== undefined ? { enabled: enabled.value } : {}),
            ...(callMode !== undefined ? { callMode } : {}),
            ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
          },
        );
        return Response.json(200, result);
      } catch (error) {
        return mcpHttpErrorResponse(error);
      }
    }

    if (reqPath.startsWith(DEVICES_PREFIX) && reqPath.endsWith("/sandbox")) {
      const id =
        reqPath.length > DEVICES_PREFIX.length + "/sandbox".length
          ? safeDecodeSegment(
              reqPath.slice(DEVICES_PREFIX.length, reqPath.length - "/sandbox".length),
            )
          : null;
      if (!id || id.includes("/")) {
        return Response.error(404, "Device not found");
      }
      const parsed = jsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value)) {
        return Response.error(400, "Expected JSON object");
      }

      const rawLevel = parsed.value.level;
      if (!isSandboxLevel(rawLevel)) {
        return Response.error(400, `level must be one of: ${SANDBOX_LEVELS.join(", ")}`);
      }

      let workspaces: string[] | undefined;
      const rawWorkspaces = parsed.value.workspaces;
      if (rawWorkspaces !== undefined && rawWorkspaces !== null) {
        if (!Array.isArray(rawWorkspaces) || !rawWorkspaces.every((w) => typeof w === "string")) {
          return Response.error(400, "workspaces must be an array of strings");
        }
        workspaces = rawWorkspaces;
      }

      const rawTimeout = parsed.value.timeoutMs ?? parsed.value.timeout_ms;
      if (
        rawTimeout !== undefined &&
        rawTimeout !== null &&
        (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout <= 0)
      ) {
        return Response.error(400, "timeoutMs must be a positive integer");
      }

      try {
        const result = await app.devices.setDeviceSandboxLevel(id, rawLevel, {
          ...(workspaces !== undefined ? { workspaces } : {}),
          ...(typeof rawTimeout === "number" ? { timeoutMs: rawTimeout } : {}),
        });
        if (!result.applied && !result.pending && result.device.sandboxSyncState === "locked") {
          return Response.json(403, {
            ...result,
            error: result.error ?? "Sandbox level is locked by local policy",
          });
        }
        return Response.json(200, result);
      } catch (error) {
        const msg = errorMessage(error);
        const statusCode = msg.startsWith("Unknown device:")
          ? 404
          : msg.includes("Cross-cluster")
            ? 403
            : 400;
        return Response.error(statusCode, msg);
      }
    }

    if (reqPath.startsWith(DEVICES_PREFIX)) {
      const id = safeDecodeSegment(reqPath.slice(DEVICES_PREFIX.length));
      if (!id || id.includes("/") || id === "config") {
        return Response.error(404, "Device not found");
      }
      if (app.devices.getDevice(id) === null) {
        return Response.error(404, "Device not found");
      }
      const parsed = jsonBody(request);
      if (!parsed.ok) return parsed.response;
      if (!isRecord(parsed.value)) {
        return Response.error(400, "Expected JSON object");
      }
      const key =
        "customName" in parsed.value
          ? "customName"
          : "custom_name" in parsed.value
            ? "custom_name"
            : "name" in parsed.value
              ? "name"
              : null;
      if (key === null) {
        return Response.error(400, "Expected { customName: string | null }");
      }
      const rawName = parsed.value[key];
      if (rawName !== null && typeof rawName !== "string") {
        return Response.error(400, "customName must be a string or null");
      }
      return await done(() => app.devices.setDeviceName(id, rawName));
    }
  }

  if (method === "DELETE") {
    if (reqPath.startsWith(DEVICE_TRANSFERS_PREFIX)) {
      const id = safeDecodeSegment(reqPath.slice(DEVICE_TRANSFERS_PREFIX.length));
      if (!id || id.includes("/")) {
        return Response.error(404, "Transfer not found");
      }
      const cancelled = app.devices.cancelTransfer(id);
      if (!cancelled) {
        return Response.error(404, "Active transfer not found");
      }
      return Response.json(200, { cancelled: true, transferId: id });
    }
    if (reqPath.startsWith(DEVICE_ENROLLMENTS_PREFIX)) {
      const id = safeDecodeSegment(reqPath.slice(DEVICE_ENROLLMENTS_PREFIX.length));
      if (!id || id.includes("/")) {
        return Response.error(404, "Enrollment not found");
      }
      try {
        const enrollment = await app.devices.revokeEnrollment(id);
        return Response.json(200, { enrollment });
      } catch (error) {
        const msg = errorMessage(error);
        return Response.error(msg.startsWith("Enrollment not found:") ? 404 : 400, msg);
      }
    }
    if (reqPath.startsWith(DEVICES_PREFIX)) {
      const id = safeDecodeSegment(reqPath.slice(DEVICES_PREFIX.length));
      if (!id || id.includes("/")) {
        return Response.error(404, "Device not found");
      }
      const removed = app.devices.removeDevice(id);
      if (!removed) {
        return Response.error(404, "Device not found");
      }
      return Response.json(200, { removed: true, deviceId: id });
    }
  }

  return null;
}

async function pollSnapshot(app: AppContext, request: Request): Promise<Response> {
  const params = new URLSearchParams(request.query);
  const rawInclude = params.get("include");
  const include = new Set<string>(
    rawInclude
      ? rawInclude
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : ["m", "w", "a", "d"],
  );
  const workerId = params.get("worker")?.trim() || undefined;
  if (workerId && rawInclude === null) include.add("wd");
  if (params.get("health") === "1") include.add("h");

  const wantMessages = include.has("m");
  const wantWorkers = include.has("w");
  const wantActivity = include.has("a");
  const wantDevices = include.has("d") && app.devices !== undefined;
  const wantDetail = include.has("wd") && workerId !== undefined && workerId.length > 0;
  const wantHealth = include.has("h");

  if (wantDevices) {
    app.devices.triggerBackgroundSync();
  }

  const [workersValue, activityValue, detailValue] = await Promise.all([
    wantWorkers ? app.workerCards() : Promise.resolve(undefined),
    wantActivity ? app.activityView() : Promise.resolve(undefined),
    wantDetail ? app.workerDetail(workerId) : Promise.resolve(undefined),
  ]);

  const changed: Record<string, unknown> = {};
  const etags: Record<string, string> = {};
  let anyChanged = false;

  const checkSlice = (key: string, payloadKey: string, value: unknown): void => {
    const serialized = JSON.stringify(value);
    const tag = fastSliceTag(serialized);
    etags[key] = tag;
    if (params.get(key) !== tag) {
      changed[payloadKey] = value;
      anyChanged = true;
    }
  };

  if (wantMessages) {
    checkSlice("m", "messages", app.panelMessages());
  }
  if (wantWorkers) {
    checkSlice("w", "workers", workersValue);
  }
  if (wantActivity) {
    checkSlice("a", "activity", activityValue);
  }
  if (wantDevices) {
    checkSlice("d", "devices", {
      config: app.devices.configView(),
      devices: app.devices.listDevices(),
      approvals: app.devices.listApprovals(),
      enrollments: app.devices.listEnrollments(),
    });
  }
  if (wantDetail) {
    checkSlice("wd", "workerDetail", detailValue ?? null);
  }
  if (wantHealth) {
    checkSlice("h", "health", app.healthView());
  }

  if (!anyChanged) {
    return new Response({
      status: 304,
      contentType: "application/json; charset=utf-8",
      body: EMPTY_BODY,
      headers: [["cache-control", "no-store"]],
    });
  }

  return maybeCompressApiResponse(request, Response.json(200, { changed, etags }));
}

async function route(app: AppContext, request: Request): Promise<Response> {
  const { method, path: reqPath } = request;
  if (reqPath === "/api/devices" || reqPath.startsWith(DEVICES_PREFIX)) {
    const deviceResponse = await routeDevices(app, method, reqPath, request);
    if (deviceResponse !== null) {
      return deviceResponse;
    }
  }

  if (method === "GET") {
    switch (reqPath) {
      case "/api/poll":
        return await pollSnapshot(app, request);
      case "/api/health":
        return jsonWithEtag(request, app.healthView());
      case "/api/messages":
        return jsonWithEtag(request, { messages: app.panelMessages() });
      case "/api/workers":
        return jsonWithEtag(request, { workers: await app.workerCards() });
      case "/api/activity":
        return jsonWithEtag(request, await app.activityView());
      case "/api/settings/models":
        return maybeCompressApiResponse(request, Response.json(200, await app.modelsView()));
      case "/api/settings/accounts":
        return maybeCompressApiResponse(request, Response.json(200, await app.accountsView()));
      case "/api/settings/accounts/login":
        return maybeCompressApiResponse(request, Response.json(200, { login: app.loginView() }));
      case "/api/settings/general":
        return maybeCompressApiResponse(request, Response.json(200, app.generalView()));
      case "/api/wechat":
        return maybeCompressApiResponse(request, Response.json(200, app.wechatStatus()));
      default:
        if (reqPath.startsWith(WORKERS_PREFIX)) {
          const worker = await app.workerDetail(reqPath.slice(WORKERS_PREFIX.length));
          if (worker !== null && worker !== undefined) {
            return jsonWithEtag(request, worker);
          }
          return Response.error(404, "Worker not found");
        }
        return Response.error(404, "Not found");
    }
  }

  if (method === "POST") {
    switch (reqPath) {
      case "/api/settings/kernel/install": {
        const parsed = jsonBody(request);
        if (!parsed.ok) return parsed.response;
        return await done(() => app.installKernel(parsed.value));
      }
      case "/api/settings/accounts/login": {
        const parsed = optionalJsonBody(request);
        if (!parsed.ok) return parsed.response;
        return await done(() => app.startLogin(parsed.value));
      }
      case "/api/settings/accounts/login/input": {
        const parsed = jsonBody(request);
        if (!parsed.ok) return parsed.response;
        return await done(() => app.loginInput(parsed.value));
      }
      case "/api/settings/accounts/login/cancel":
        app.cancelLogin();
        return Response.json(200, { login: app.loginView() });
      case "/api/settings/accounts/logout": {
        const parsed = optionalJsonBody(request);
        if (!parsed.ok) return parsed.response;
        return await done(() => app.logout(parsed.value));
      }
      case "/api/session/reset":
        return await done(async () => {
          await app.resetOrchestrator();
          return { reset: true };
        });
      case "/api/wechat/connect":
        return Response.json(200, await app.wechatConnect());
      case "/api/wechat/disconnect":
        return Response.json(200, await app.wechatDisconnect());
      case "/api/wechat/verify": {
        const parsed = jsonBody(request);
        if (!parsed.ok) return parsed.response;
        if (!isRecord(parsed.value) || typeof parsed.value.code !== "string") {
          return Response.error(400, "Expected { code: string }");
        }
        const code = parsed.value.code;
        return await done(() => app.wechatVerify(code));
      }
      case "/api/chat":
        return await chat(app, request);
      default:
        if (reqPath.startsWith(WORKERS_PREFIX) && reqPath.endsWith(STOP_SUFFIX)) {
          if (reqPath.length < WORKERS_PREFIX.length + STOP_SUFFIX.length) {
            return Response.error(404, "Worker not found");
          }
          const id = reqPath.slice(WORKERS_PREFIX.length, reqPath.length - STOP_SUFFIX.length);
          if (id.length === 0 || id.includes("/")) {
            return Response.error(404, "Worker not found");
          }
          try {
            const worker = await app.stopWorkerTicket(id);
            return Response.json(200, worker);
          } catch (error) {
            if (error instanceof StopWorkerError) {
              if (error.kind === "not_found") {
                return Response.error(404, "Worker not found");
              }
              if (error.kind === "already_ended") {
                return Response.error(400, "Task has already ended");
              }
              return Response.error(400, error.message);
            }
            return Response.error(400, errorMessage(error));
          }
        }
        return Response.error(404, "Not found");
    }
  }

  if (method === "PUT") {
    switch (reqPath) {
      case "/api/settings/models": {
        const parsed = jsonBody(request);
        if (!parsed.ok) return parsed.response;
        return await done(() => app.updateModels(parsed.value));
      }
      case "/api/settings/general": {
        const parsed = jsonBody(request);
        if (!parsed.ok) return parsed.response;
        return await done(() => app.updateGeneral(parsed.value));
      }
      default:
        return Response.error(404, "Not found");
    }
  }

  return Response.error(404, "Not found");
}

/** MIME type of one static file from the web build, by extension. */
export function contentType(filePath: string): string {
  const ext = path.extname(filePath);
  if (ext.length <= 1) {
    return "application/octet-stream";
  }
  const lower = ext.slice(1).toLowerCase();
  return MIME_TYPES[lower] ?? "application/octet-stream";
}

async function statRegularFile(filePath: string): Promise<fs.Stats | null> {
  try {
    const st = await fs.promises.stat(filePath);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

async function loadStaticEntry(file: string, stat: fs.Stats): Promise<StaticCacheEntry> {
  const cached = staticFileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // Refresh LRU order.
    staticFileCache.delete(file);
    staticFileCache.set(file, cached);
    return cached;
  }
  const buf = await fs.promises.readFile(file);
  const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const entry: StaticCacheEntry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    contentType: contentType(file),
    etag: weakEtag(raw),
    raw,
    totalBytes: raw.byteLength,
  };
  if (cached) {
    staticFileCache.delete(file);
    staticCacheTotalBytes -= cached.totalBytes;
  }
  if (entry.totalBytes <= MAX_STATIC_CACHE_BYTES) {
    evictStaticCache(entry.totalBytes);
    staticFileCache.set(file, entry);
    staticCacheTotalBytes += entry.totalBytes;
  }
  return entry;
}

/** A file of the web build; any path that names no file is the app itself, which routes within the page. */
export async function webFile(webDir: string, reqPath: string, request?: Request): Promise<Response> {
  const parts = reqPath.split("/").filter((part) => part.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === ".." || part === "." || part.includes("\\") || part.includes("\0") || part.includes(":")) {
      return Response.error(404, "Not found");
    }
  }

  let file = parts.length === 0 ? webDir : path.join(webDir, ...parts);
  let stat = parts.length === 0 ? null : await statRegularFile(file);
  let isSpaFallback = false;
  if (stat === null) {
    // A missing asset is an error; a missing page is a route of the app.
    if (parts.length > 0 && parts[parts.length - 1].includes(".")) {
      return Response.error(404, "Not found");
    }
    file = path.join(webDir, "index.html");
    stat = await statRegularFile(file);
    if (stat === null) {
      return Response.error(404, "Not found");
    }
    isSpaFallback = true;
  }

  try {
    const entry = await loadStaticEntry(file, stat);
    const cacheControl =
      !isSpaFallback && isImmutableWebAsset(parts)
        ? "public, max-age=31536000, immutable"
        : "no-cache";
    const compressible = isCompressibleMime(entry.contentType) && entry.raw.byteLength >= MIN_COMPRESS_BYTES;

    const baseHeaders: Array<[string, string]> = [
      ["cache-control", cacheControl],
      ["etag", entry.etag],
      ["content-security-policy", PAGE_POLICY],
      ["x-content-type-options", "nosniff"],
      ["referrer-policy", "no-referrer"],
    ];
    if (compressible) {
      baseHeaders.push(["vary", "accept-encoding"]);
    }

    if (request && etagMatches(request.header("if-none-match"), entry.etag)) {
      return new Response({
        status: 304,
        contentType: entry.contentType,
        body: EMPTY_BODY,
        headers: baseHeaders,
      });
    }

    let body = entry.raw;
    if (request && compressible) {
      const encoding = negotiateEncoding(request.header("accept-encoding"));
      if (encoding === "br") {
        if (entry.br === undefined) {
          entry.br = compressBytes(entry.raw, "br");
          if (entry.br && staticFileCache.get(file) === entry) {
            evictStaticCache(entry.br.byteLength);
            entry.totalBytes += entry.br.byteLength;
            staticCacheTotalBytes += entry.br.byteLength;
          }
        }
        if (entry.br) {
          body = entry.br;
          baseHeaders.push(["content-encoding", "br"]);
        }
      } else if (encoding === "gzip") {
        if (entry.gzip === undefined) {
          entry.gzip = compressBytes(entry.raw, "gzip");
          if (entry.gzip && staticFileCache.get(file) === entry) {
            evictStaticCache(entry.gzip.byteLength);
            entry.totalBytes += entry.gzip.byteLength;
            staticCacheTotalBytes += entry.gzip.byteLength;
          }
        }
        if (entry.gzip) {
          body = entry.gzip;
          baseHeaders.push(["content-encoding", "gzip"]);
        }
      }
    }

    return new Response({
      status: 200,
      contentType: entry.contentType,
      body,
      headers: baseHeaders,
    });
  } catch {
    return Response.error(404, "Not found");
  }
}

/** Answer one request. */
export async function handle(
  app: AppContext,
  access: Access,
  request: Request,
  peer: SocketAddr,
): Promise<Response> {
  if (request.path === "/api" || request.path.startsWith("/api/")) {
    const denied = refused(request, peer, access);
    if (denied !== null) {
      // Whether the server is there, and that it wants a token, is no secret.
      if (request.method === "GET" && request.path === "/api/health" && denied.status === 401) {
        return Response.json(401, {
          error: "A valid access token is required",
          authRequired: true,
          version: VERSION,
        }).withHeader("www-authenticate", "Bearer");
      }
      return denied;
    }
    return await route(app, request);
  }

  // Public Master Direct Mode enrollment endpoints (no access token required).
  if (request.method === "POST" && request.path.startsWith(PUBLIC_ENROLL_CLAIM_PREFIX)) {
    const id = safeDecodeSegment(request.path.slice(PUBLIC_ENROLL_CLAIM_PREFIX.length));
    if (!id || id.includes("/")) {
      return Response.error(404, "Enrollment ticket not found");
    }
    const claimed = app.devices.claimDirectEnrollment(id, peer.host);
    if (claimed.ok) {
      return Response.json(200, {
        ticket_id: claimed.ticket_id,
        ciphertext_b64: claimed.ciphertext_b64,
        expires_at: claimed.expires_at,
        expires_at_ms: claimed.expires_at_ms,
      });
    }
    return Response.error(claimed.status, claimed.error);
  }

  if (request.method === "GET" || request.method === "HEAD") {
    if (request.path === "/install.sh") {
      const cfgView = app.devices.configView();
      const script = renderDirectInstallSh({
        origin: requestOrigin(request),
        relayUrl: cfgView.relayUrl,
        agentVersion: cfgView.agentVersion,
      });
      return new Response({
        status: 200,
        contentType: "text/x-shellscript; charset=utf-8",
        body: textEncoder.encode(script),
        headers: [
          ["cache-control", "no-store"],
          ["x-content-type-options", "nosniff"],
        ],
      });
    }
    if (request.path === "/install.ps1") {
      const cfgView = app.devices.configView();
      const script = renderDirectInstallPs1({
        origin: requestOrigin(request),
        relayUrl: cfgView.relayUrl,
        agentVersion: cfgView.agentVersion,
      });
      return new Response({
        status: 200,
        contentType: "text/plain; charset=utf-8",
        body: textEncoder.encode(script),
        headers: [
          ["cache-control", "no-store"],
          ["x-content-type-options", "nosniff"],
        ],
      });
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.error(404, "Not found");
  }
  if (access.webDir !== undefined) {
    return await webFile(access.webDir, request.path, request);
  }
  return Response.error(404, "Not found");
}
