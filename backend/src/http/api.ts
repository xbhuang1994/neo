/**
 * The application's JSON API, who may call it, and the web build's files.
 *
 * Ported directly from Rust `neo-http/src/api.rs`.
 */

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StopWorkerError } from "../app/context.ts";
import type { AppContext, ChatAttachment } from "../app/context.ts";
import {
  renderDirectInstallPs1,
  renderDirectInstallSh,
  type DeviceConfigUpdateInput,
  type EnrollmentCreateInput,
  type EnrollmentInstallMode,
  type EnrollmentPlatform,
  type EnrollmentProfile,
  type EnrollmentTransportMode,
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
      return Response.json(200, {
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

  if (method === "PUT") {
    if (reqPath === "/api/devices/config") {
      const parsed = jsonBody(request);
      if (!parsed.ok) return parsed.response;
      const input = parseDeviceConfigInput(parsed.value);
      if (!input.ok) return input.response;
      return await done(async () => ({
        config: await app.devices.initOrUpdateConfig(input.value),
      }));
    }
  }

  if (method === "DELETE") {
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
      case "/api/health":
        return Response.json(200, app.healthView());
      case "/api/messages":
        return Response.json(200, { messages: app.panelMessages() });
      case "/api/workers":
        return Response.json(200, { workers: await app.workerCards() });
      case "/api/activity":
        return Response.json(200, await app.activityView());
      case "/api/settings/models":
        return Response.json(200, await app.modelsView());
      case "/api/settings/accounts":
        return Response.json(200, await app.accountsView());
      case "/api/settings/accounts/login":
        return Response.json(200, { login: app.loginView() });
      case "/api/settings/general":
        return Response.json(200, app.generalView());
      case "/api/wechat":
        return Response.json(200, app.wechatStatus());
      default:
        if (reqPath.startsWith(WORKERS_PREFIX)) {
          const worker = await app.workerDetail(reqPath.slice(WORKERS_PREFIX.length));
          if (worker !== null && worker !== undefined) {
            return Response.json(200, worker);
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

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** A file of the web build; any path that names no file is the app itself, which routes within the page. */
export async function webFile(webDir: string, reqPath: string): Promise<Response> {
  const parts = reqPath.split("/").filter((part) => part.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === ".." || part === "." || part.includes("\\") || part.includes("\0") || part.includes(":")) {
      return Response.error(404, "Not found");
    }
  }

  let file = parts.length === 0 ? webDir : path.join(webDir, ...parts);
  if (!(await isRegularFile(file))) {
    // A missing asset is an error; a missing page is a route of the app.
    if (parts.length > 0 && parts[parts.length - 1].includes(".")) {
      return Response.error(404, "Not found");
    }
    file = path.join(webDir, "index.html");
  }

  try {
    const buf = await fs.promises.readFile(file);
    return new Response({
      status: 200,
      contentType: contentType(file),
      body: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      headers: [
        ["cache-control", "no-cache"],
        ["content-security-policy", PAGE_POLICY],
        ["x-content-type-options", "nosniff"],
        ["referrer-policy", "no-referrer"],
      ],
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
    return await webFile(access.webDir, request.path);
  }
  return Response.error(404, "Not found");
}
