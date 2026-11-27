/**
 * Canonical Wire Protocol implementation for Master Neo Control Plane:
 * 1. `neo-relay` Auth Token (`neo1.<payload_b64url>.<sig_b64url>`)
 * 2. `neo-relay` 10-byte Binary Frame (`/v1/relay`)
 * 3. Master <-> Tier 1 OS Agent AES-256-GCM AEAD Envelope (`0xE1`)
 * 4. Tier 2 MCU HMAC-SHA256 `e2e_mac` + CBOR `RelayEnvelope`
 * 5. Layer 4 S3 cluster artifact prefix validator
 */

import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { decodeCbor, encodeCbor } from "./cbor.ts";
import {
  E2E_ENVELOPE_VERSION,
  E2E_NONCE_BYTES,
  E2E_TAG_BYTES,
  ENROLL_ENVELOPE_VERSION,
  FILE_ENVELOPE_VERSION,
  FILE_FRAME_FIXED_HEADER_BYTES,
  FILE_FRAME_KIND_ABORT,
  FILE_FRAME_KIND_ACK,
  FILE_FRAME_KIND_DATA,
  FILE_FRAME_KIND_DONE,
  FILE_FRAME_KIND_FINISH,
  FILE_FRAME_VERSION,
  MAX_FILE_FRAME_DATA_BYTES,
  MAX_TRANSFER_ID_BYTES,
  RELAY_HEADER_BYTES,
  RELAY_MAGIC_0,
  RELAY_MAGIC_1,
  RELAY_VERSION,
  type DeviceMessage,
  type DeviceMessageKind,
  type EnrollPayload,
  type FileFrame,
  type FileFrameKind,
  type RelayDirection,
  type RelayEnvelope,
  type RelayFrame,
  type S3PrefixValidation,
  type TokenClaims,
  type TokenTier,
} from "./types.ts";

const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });
const VALID_TIERS: ReadonlySet<string> = new Set(["master", "os", "relay", "admin"]);
const VALID_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "manifest",
  "rpc_req",
  "rpc_resp",
  "heartbeat",
  "relay_envelope",
  "event",
  "enroll_register",
  "enroll_ack",
]);

export const ENROLL_TICKET_PREFIX = "neo_enr_v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Encode bytes or UTF-8 string as RFC 4648 base64url without `=` padding. */
export function base64UrlEncodeNoPad(input: Uint8Array | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return buf.toString("base64url");
}

/** Strictly decode unpadded RFC 4648 base64url. */
export function base64UrlDecodeNoPad(encoded: string): Uint8Array {
  if (encoded.length === 0) {
    return new Uint8Array(0);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("Invalid base64url string");
  }
  const padLen = (4 - (encoded.length % 4)) % 4;
  const std = encoded.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(padLen);
  const decoded = Buffer.from(std, "base64");
  if (decoded.toString("base64url") !== encoded) {
    throw new Error("Non-canonical base64url string");
  }
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

/** Strictly decode standard base64 (RFC 4648 with padding). */
export function decodeStandardBase64(encoded: string): Uint8Array {
  if (encoded.length === 0) {
    return new Uint8Array(0);
  }
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Invalid standard base64 string");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw new Error("Non-canonical standard base64 string");
  }
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

/**
 * Derive the cluster signing key for `neo1` tokens:
 * - If independent `clusterSecret` is provided, use `UTF8(clusterSecret)`.
 * - Else derive `HMAC-SHA256(UTF8(rootSecret), "cluster:" + clusterId)`.
 */
export function deriveClusterTokenKey(opts: {
  clusterId: string;
  rootSecret?: string;
  clusterSecret?: string;
}): Uint8Array {
  if (opts.clusterSecret !== undefined && opts.clusterSecret.length > 0) {
    const raw = Buffer.from(opts.clusterSecret, "utf8");
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (opts.rootSecret !== undefined && opts.rootSecret.length > 0) {
    const mac = createHmac("sha256", Buffer.from(opts.rootSecret, "utf8"))
      .update(`cluster:${opts.clusterId}`, "utf8")
      .digest();
    return new Uint8Array(mac.buffer, mac.byteOffset, mac.byteLength);
  }
  throw new Error("Either clusterSecret or rootSecret is required to derive token key");
}

/** Mint a `neo1.<base64url_nopad(claims)>.<base64url_nopad(hmac_sha256)>` token. */
export function mintRelayToken(opts: {
  clusterId: string;
  nodeId: string;
  tier: TokenTier;
  rootSecret?: string;
  clusterSecret?: string;
  ttlSec?: number;
  nowSec?: number;
}): string {
  if (!opts.clusterId) throw new Error("clusterId is required");
  if (!opts.nodeId) throw new Error("nodeId is required");
  if (!VALID_TIERS.has(opts.tier)) throw new Error(`Invalid token tier: ${opts.tier}`);
  const iat = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSec ?? 3600;
  const exp = iat + ttl;
  const claims: TokenClaims = {
    cluster_id: opts.clusterId,
    node_id: opts.nodeId,
    tier: opts.tier,
    iat,
    exp,
  };
  const payloadB64 = base64UrlEncodeNoPad(JSON.stringify(claims));
  const signingInput = `neo1.${payloadB64}`;
  const key = deriveClusterTokenKey({
    clusterId: opts.clusterId,
    rootSecret: opts.rootSecret,
    clusterSecret: opts.clusterSecret,
  });
  const sig = createHmac("sha256", key).update(signingInput, "utf8").digest();
  return `${signingInput}.${base64UrlEncodeNoPad(sig)}`;
}

/** Verify a `neo1` token signature, claims structure, cluster match, and expiration. */
export function verifyRelayToken(
  token: string,
  opts: {
    rootSecret?: string;
    clusterSecret?: string;
    expectedClusterId?: string;
    nowSec?: number;
  },
): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "neo1") {
    throw new Error("Invalid neo1 token format");
  }
  const payloadB64 = parts[1]!;
  const sigB64 = parts[2]!;
  const claimsRaw = utf8FatalDecoder.decode(base64UrlDecodeNoPad(payloadB64));
  const parsed: unknown = JSON.parse(claimsRaw);
  if (!isRecord(parsed)) {
    throw new Error("Token claims must be an object");
  }
  const clusterId = parsed.cluster_id;
  const nodeId = parsed.node_id;
  const tier = parsed.tier;
  const iat = parsed.iat;
  const exp = parsed.exp;
  if (
    typeof clusterId !== "string" ||
    clusterId.length === 0 ||
    typeof nodeId !== "string" ||
    nodeId.length === 0 ||
    typeof tier !== "string" ||
    !VALID_TIERS.has(tier) ||
    typeof iat !== "number" ||
    !Number.isInteger(iat) ||
    typeof exp !== "number" ||
    !Number.isInteger(exp)
  ) {
    throw new Error("Invalid neo1 token claims");
  }
  if (opts.expectedClusterId !== undefined && clusterId !== opts.expectedClusterId) {
    throw new Error(`Cluster mismatch: expected ${opts.expectedClusterId}, got ${clusterId}`);
  }
  const key = deriveClusterTokenKey({
    clusterId,
    rootSecret: opts.rootSecret,
    clusterSecret: opts.clusterSecret,
  });
  const expectedSig = createHmac("sha256", key).update(`neo1.${payloadB64}`, "utf8").digest();
  const givenSig = base64UrlDecodeNoPad(sigB64);
  if (givenSig.byteLength !== expectedSig.byteLength || !timingSafeEqual(givenSig, expectedSig)) {
    throw new Error("Invalid neo1 token signature");
  }
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (nowSec > exp) {
    throw new Error("neo1 token has expired");
  }
  return {
    cluster_id: clusterId,
    node_id: nodeId,
    tier: tier as TokenTier,
    iat,
    exp,
  };
}

/**
 * Encode a 10-byte `neo-relay` `/v1/relay` binary frame:
 * `[0]='N'(0x4E), [1]='R'(0x52), [2]=0x01, [3]=flags, [4]=srcLen(u8), [5]=dstLen(u8), [6..10]=payloadLen(u32 BE), src, dst, payload`
 */
export function encodeRelayFrame(frame: RelayFrame): Uint8Array {
  const srcBytes = Buffer.from(frame.src, "utf8");
  const dstBytes = Buffer.from(frame.dst, "utf8");
  if (srcBytes.byteLength > 255) {
    throw new Error(`Relay frame src length (${srcBytes.byteLength}) exceeds 255 bytes`);
  }
  if (dstBytes.byteLength > 255) {
    throw new Error(`Relay frame dst length (${dstBytes.byteLength}) exceeds 255 bytes`);
  }
  const payloadLen = frame.payload.byteLength;
  const total = RELAY_HEADER_BYTES + srcBytes.byteLength + dstBytes.byteLength + payloadLen;
  const out = new Uint8Array(total);
  out[0] = RELAY_MAGIC_0;
  out[1] = RELAY_MAGIC_1;
  out[2] = RELAY_VERSION;
  out[3] = frame.flags & 0xff;
  out[4] = srcBytes.byteLength;
  out[5] = dstBytes.byteLength;
  const view = new DataView(out.buffer);
  view.setUint32(6, payloadLen, false);
  let pos = RELAY_HEADER_BYTES;
  out.set(srcBytes, pos);
  pos += srcBytes.byteLength;
  out.set(dstBytes, pos);
  pos += dstBytes.byteLength;
  out.set(frame.payload, pos);
  return out;
}

/** Decode a 10-byte header `neo-relay` `/v1/relay` binary frame. */
export function decodeRelayFrame(bytes: Uint8Array): RelayFrame {
  if (bytes.byteLength < RELAY_HEADER_BYTES) {
    throw new Error(`Relay frame too short: ${bytes.byteLength} < ${RELAY_HEADER_BYTES}`);
  }
  if (bytes[0] !== RELAY_MAGIC_0 || bytes[1] !== RELAY_MAGIC_1) {
    throw new Error("Invalid relay frame magic bytes");
  }
  if (bytes[2] !== RELAY_VERSION) {
    throw new Error(`Unsupported relay frame version: ${bytes[2]}`);
  }
  const flags = bytes[3]!;
  const srcLen = bytes[4]!;
  const dstLen = bytes[5]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadLen = view.getUint32(6, false);
  const expectedLen = RELAY_HEADER_BYTES + srcLen + dstLen + payloadLen;
  if (expectedLen !== bytes.byteLength) {
    throw new Error(`Relay frame length mismatch: expected ${expectedLen}, got ${bytes.byteLength}`);
  }
  let pos = RELAY_HEADER_BYTES;
  const src = utf8FatalDecoder.decode(bytes.subarray(pos, pos + srcLen));
  pos += srcLen;
  const dst = utf8FatalDecoder.decode(bytes.subarray(pos, pos + dstLen));
  pos += dstLen;
  const payload = bytes.slice(pos, pos + payloadLen);
  return { flags, src, dst, payload };
}

/** Derive the 32-byte AES-256-GCM key for Master <-> Tier 1 OS Agent E2E encryption. */
export function deriveE2eKey(clusterId: string, e2eMasterSecret: string): Uint8Array {
  if (!e2eMasterSecret) {
    throw new Error("e2eMasterSecret is required");
  }
  const digest = createHash("sha256")
    .update(`neo-e2e-v1:${clusterId}:${e2eMasterSecret}`, "utf8")
    .digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
}

/** Build the AES-256-GCM AAD `UTF8(cluster_id + "|" + src_id + "|" + dst_id)`. */
export function buildE2eAad(clusterId: string, srcId: string, dstId: string): Uint8Array {
  const buf = Buffer.from(`${clusterId}|${srcId}|${dstId}`, "utf8");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Encrypt and authenticate a `DeviceMessage` into wire bytes:
 * `[0]=0xE1, [1..13]=12B nonce, [13..]=AES-256-GCM ciphertext || 16B tag`.
 */
export function sealDeviceMessage(
  message: DeviceMessage,
  e2eMasterSecret: string,
  srcId: string,
  dstId: string,
  nonceOverride?: Uint8Array,
): Uint8Array {
  const key = deriveE2eKey(message.cluster_id, e2eMasterSecret);
  const nonce = nonceOverride ?? new Uint8Array(randomBytes(E2E_NONCE_BYTES));
  if (nonce.byteLength !== E2E_NONCE_BYTES) {
    throw new Error(`E2E nonce must be ${E2E_NONCE_BYTES} bytes`);
  }
  const aad = buildE2eAad(message.cluster_id, srcId, dstId);
  const plaintext = Buffer.from(JSON.stringify(message), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = cipher.update(plaintext);
  const final = cipher.final();
  const tag = cipher.getAuthTag();
  const out = new Uint8Array(1 + E2E_NONCE_BYTES + ciphertext.byteLength + final.byteLength + tag.byteLength);
  out[0] = E2E_ENVELOPE_VERSION;
  out.set(nonce, 1);
  let pos = 1 + E2E_NONCE_BYTES;
  out.set(ciphertext, pos);
  pos += ciphertext.byteLength;
  out.set(final, pos);
  pos += final.byteLength;
  out.set(tag, pos);
  return out;
}

/** Decrypt and verify an inner E2E `DeviceMessage`, enforcing `cluster_id === localClusterId`. */
export function openDeviceMessage(
  wire: Uint8Array,
  e2eMasterSecret: string,
  localClusterId: string,
  srcId: string,
  dstId: string,
): DeviceMessage {
  const minBytes = 1 + E2E_NONCE_BYTES + E2E_TAG_BYTES;
  if (wire.byteLength < minBytes) {
    throw new Error(`E2E envelope too short: ${wire.byteLength} < ${minBytes}`);
  }
  if (wire[0] !== E2E_ENVELOPE_VERSION) {
    throw new Error(`Unsupported E2E envelope version: 0x${wire[0]!.toString(16)}`);
  }
  const nonce = wire.subarray(1, 1 + E2E_NONCE_BYTES);
  const tagStart = wire.byteLength - E2E_TAG_BYTES;
  const ciphertext = wire.subarray(1 + E2E_NONCE_BYTES, tagStart);
  const tag = wire.subarray(tagStart);
  const key = deriveE2eKey(localClusterId, e2eMasterSecret);
  const aad = buildE2eAad(localClusterId, srcId, dstId);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const part1 = decipher.update(ciphertext);
  const part2 = decipher.final();
  const plaintext = Buffer.concat([part1, part2]);
  const parsed: unknown = JSON.parse(utf8FatalDecoder.decode(plaintext));

  if (!isRecord(parsed)) {
    throw new Error("Decrypted DeviceMessage must be a JSON object");
  }
  if (parsed.v !== 1) {
    throw new Error(`Unsupported DeviceMessage version: ${String(parsed.v)}`);
  }
  if (typeof parsed.kind !== "string" || !VALID_MESSAGE_KINDS.has(parsed.kind)) {
    throw new Error(`Invalid DeviceMessage kind: ${String(parsed.kind)}`);
  }
  if (parsed.cluster_id !== localClusterId) {
    throw new Error(
      `Cross-cluster DeviceMessage rejected: expected ${localClusterId}, got ${String(parsed.cluster_id)}`,
    );
  }
  if (typeof parsed.req_id !== "string" || typeof parsed.device_id !== "string") {
    throw new Error("DeviceMessage missing req_id or device_id");
  }
  if (typeof parsed.ts_ms !== "number" || !Number.isInteger(parsed.ts_ms)) {
    throw new Error("DeviceMessage ts_ms must be an integer");
  }
  if (!isRecord(parsed.body)) {
    throw new Error("DeviceMessage body must be an object");
  }
  return {
    v: 1,
    kind: parsed.kind as DeviceMessageKind,
    req_id: parsed.req_id,
    cluster_id: parsed.cluster_id,
    device_id: parsed.device_id,
    ts_ms: parsed.ts_ms,
    body: parsed.body,
  };
}

/** Derive the 32-byte Tier 2 MCU HMAC key: `SHA-256("neo-mcu-e2e-v1:" + cluster_id + ":" + e2e_master_secret)`. */
export function deriveMcuE2eKey(clusterId: string, e2eMasterSecret: string): Uint8Array {
  if (!e2eMasterSecret) {
    throw new Error("e2eMasterSecret is required");
  }
  const digest = createHash("sha256")
    .update(`neo-mcu-e2e-v1:${clusterId}:${e2eMasterSecret}`, "utf8")
    .digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
}

/**
 * Compute raw 32-byte MCU `e2e_mac`:
 * `HMAC-SHA256(mcu_key, UTF8(cluster_id) || 0x00 || UTF8(target_mcu_id) || 0x00 || uint64_be(seq_id) || raw_cbor_bytes)`.
 */
export function computeMcuMac(opts: {
  clusterId: string;
  targetMcuId: string;
  seqId: number | bigint;
  rawCbor: Uint8Array;
  e2eMasterSecret: string;
}): Uint8Array {
  const mcuKey = deriveMcuE2eKey(opts.clusterId, opts.e2eMasterSecret);
  const seqBig = typeof opts.seqId === "bigint" ? opts.seqId : BigInt(opts.seqId);
  if (seqBig < 0n || seqBig > 0xffffffffffffffffn) {
    throw new Error(`MCU seq_id out of uint64 range: ${seqBig.toString()}`);
  }
  const seqBuf = new Uint8Array(8);
  new DataView(seqBuf.buffer).setBigUint64(0, seqBig, false);

  const hmac = createHmac("sha256", mcuKey);
  hmac.update(Buffer.from(opts.clusterId, "utf8"));
  hmac.update(Uint8Array.of(0x00));
  hmac.update(Buffer.from(opts.targetMcuId, "utf8"));
  hmac.update(Uint8Array.of(0x00));
  hmac.update(seqBuf);
  hmac.update(opts.rawCbor);
  const digest = hmac.digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
}

/** Compute lowercase 64-char hex MCU `e2e_mac`. */
export function computeMcuMacHex(opts: {
  clusterId: string;
  targetMcuId: string;
  seqId: number | bigint;
  rawCbor: Uint8Array;
  e2eMasterSecret: string;
}): string {
  return Buffer.from(computeMcuMac(opts)).toString("hex");
}

/** Constant-time verify an MCU `e2e_mac` (64-char hex or 32-byte buffer). */
export function verifyMcuMac(opts: {
  clusterId: string;
  targetMcuId: string;
  seqId: number | bigint;
  rawCbor: Uint8Array;
  e2eMasterSecret: string;
  givenMac: string | Uint8Array;
}): boolean {
  let givenBytes: Uint8Array;
  if (typeof opts.givenMac === "string") {
    if (!/^[0-9a-fA-F]{64}$/.test(opts.givenMac)) {
      return false;
    }
    const buf = Buffer.from(opts.givenMac, "hex");
    givenBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } else {
    if (opts.givenMac.byteLength !== 32) {
      return false;
    }
    givenBytes = opts.givenMac;
  }
  const expected = computeMcuMac(opts);
  return timingSafeEqual(givenBytes, expected);
}

/** Encode a Tier 2 CBOR payload, sign it with `e2e_mac`, and construct a `RelayEnvelope`. */
export function sealRelayEnvelope(opts: {
  clusterId: string;
  relayNodeId: string;
  targetMcuId: string;
  direction: RelayDirection;
  seqId: number;
  payload: unknown;
  e2eMasterSecret: string;
}): RelayEnvelope {
  const rawCbor = encodeCbor(opts.payload);
  const e2eMac = computeMcuMacHex({
    clusterId: opts.clusterId,
    targetMcuId: opts.targetMcuId,
    seqId: opts.seqId,
    rawCbor,
    e2eMasterSecret: opts.e2eMasterSecret,
  });
  return {
    cluster_id: opts.clusterId,
    relay_node_id: opts.relayNodeId,
    target_mcu_id: opts.targetMcuId,
    direction: opts.direction,
    seq_id: opts.seqId,
    e2e_mac: e2eMac,
    cbor_payload_b64: Buffer.from(rawCbor).toString("base64"),
  };
}

/** Verify cluster + `e2e_mac` on a `RelayEnvelope` and decode its CBOR payload. */
export function openRelayEnvelope<T = Record<string, unknown>>(
  envelope: RelayEnvelope,
  e2eMasterSecret: string,
  localClusterId: string,
): { envelope: RelayEnvelope; rawCbor: Uint8Array; payload: T } {
  if (envelope.cluster_id !== localClusterId) {
    throw new Error(
      `Cross-cluster RelayEnvelope rejected: expected ${localClusterId}, got ${envelope.cluster_id}`,
    );
  }
  if (!Number.isInteger(envelope.seq_id) || envelope.seq_id < 0) {
    throw new Error(`Invalid RelayEnvelope seq_id: ${envelope.seq_id}`);
  }
  const rawCbor = decodeStandardBase64(envelope.cbor_payload_b64);
  const ok = verifyMcuMac({
    clusterId: envelope.cluster_id,
    targetMcuId: envelope.target_mcu_id,
    seqId: envelope.seq_id,
    rawCbor,
    e2eMasterSecret,
    givenMac: envelope.e2e_mac,
  });
  if (!ok) {
    throw new Error("Invalid MCU e2e_mac");
  }
  const payload = decodeCbor<T>(rawCbor);
  return { envelope, rawCbor, payload };
}

/**
 * Layer 4 S3 cluster prefix validator:
 * Accepts only `s3://neo-artifacts/<cluster_id>/<task_id>/...` matching `localClusterId`,
 * rejecting cross-cluster prefixes, wrong buckets, and path traversal segments.
 */
export function validateS3ClusterArtifactUri(
  uri: string,
  localClusterId: string,
  expectedTaskId?: string,
): S3PrefixValidation {
  if (!uri.startsWith("s3://")) {
    return { ok: false, error: "Artifact URI must start with s3://" };
  }
  if (uri.includes("\\") || uri.includes("\0")) {
    return { ok: false, error: "Artifact URI contains illegal characters" };
  }
  const rest = uri.slice("s3://".length);
  const firstSlash = rest.indexOf("/");
  if (firstSlash <= 0) {
    return { ok: false, error: "Artifact URI missing bucket or object key" };
  }
  const bucket = rest.slice(0, firstSlash);
  if (bucket !== "neo-artifacts") {
    return { ok: false, error: `Invalid S3 bucket ${bucket}; expected neo-artifacts` };
  }
  const objectKey = rest.slice(firstSlash + 1);
  const segments = objectKey.split("/");
  if (segments.length < 3) {
    return {
      ok: false,
      error: "Artifact key must match <cluster_id>/<task_id>/<object>",
    };
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.length === 0 || seg === "." || seg === "..") {
      return { ok: false, error: "Artifact URI contains invalid or traversal path segment" };
    }
  }
  const clusterId = segments[0]!;
  const taskId = segments[1]!;
  if (clusterId !== localClusterId) {
    return {
      ok: false,
      error: `Cross-cluster S3 artifact access rejected (${clusterId} !== ${localClusterId})`,
    };
  }
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) {
    return {
      ok: false,
      error: `Task mismatch in S3 artifact URI (${taskId} !== ${expectedTaskId})`,
    };
  }
  return {
    ok: true,
    bucket,
    clusterId,
    taskId,
    objectKey,
  };
}

/**
 * Generate a zero-trust enrollment ticket string:
 * `neo_enr_v1.<ticketId>.<ephemeralKey>`
 * where `ticketId` = 8 random bytes base64url no-pad (11 chars)
 * and `ephemeralKey` = 16 random bytes base64url no-pad (22 chars).
 */
export function generateEnrollTicket(): {
  ticketId: string;
  ephemeralKey: string;
  enrollCode: string;
} {
  const ticketId = base64UrlEncodeNoPad(randomBytes(8));
  const ephemeralKey = base64UrlEncodeNoPad(randomBytes(16));
  return {
    ticketId,
    ephemeralKey,
    enrollCode: `${ENROLL_TICKET_PREFIX}.${ticketId}.${ephemeralKey}`,
  };
}

/** Parse and validate an enrollment ticket `neo_enr_v1.<ticketId>.<ephemeralKey>`. */
export function parseEnrollTicket(enrollCode: string): {
  ticketId: string;
  ephemeralKey: string;
} {
  const parts = enrollCode.trim().split(".");
  if (parts.length !== 3 || parts[0] !== ENROLL_TICKET_PREFIX) {
    throw new Error("Invalid enrollment ticket format");
  }
  const ticketId = parts[1]!;
  const ephemeralKey = parts[2]!;
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(ticketId)) {
    throw new Error("Invalid enrollment ticketId");
  }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(ephemeralKey)) {
    throw new Error("Invalid enrollment ephemeralKey");
  }
  return { ticketId, ephemeralKey };
}

/** Derive the 32-byte AES-256-GCM key for enrollment sealing: `SHA-256("neo-enroll-v1:" + ticketId + ":" + ephemeralKey)`. */
export function deriveEnrollKey(ticketId: string, ephemeralKey: string): Uint8Array {
  if (!ticketId || !ephemeralKey) {
    throw new Error("ticketId and ephemeralKey are required");
  }
  const digest = createHash("sha256")
    .update(`neo-enroll-v1:${ticketId}:${ephemeralKey}`, "utf8")
    .digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
}

/** Build the enrollment AES-256-GCM AAD `UTF8("neo-enroll-v1|" + ticketId)`. */
export function buildEnrollAad(ticketId: string): Uint8Array {
  if (!ticketId) {
    throw new Error("ticketId is required");
  }
  const buf = Buffer.from(`neo-enroll-v1|${ticketId}`, "utf8");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Encrypt and authenticate an enrollment payload into standard base64 (`ciphertext_b64`):
 * Wire bytes: `[0xE2][12B random nonce][AES-256-GCM ciphertext || 16B tag]`.
 */
export function sealEnrollPayload(
  payload: unknown,
  ticketId: string,
  ephemeralKey: string,
  nonceOverride?: Uint8Array,
): string {
  const key = deriveEnrollKey(ticketId, ephemeralKey);
  const nonce = nonceOverride ?? new Uint8Array(randomBytes(E2E_NONCE_BYTES));
  if (nonce.byteLength !== E2E_NONCE_BYTES) {
    throw new Error(`Enrollment nonce must be ${E2E_NONCE_BYTES} bytes`);
  }
  const aad = buildEnrollAad(ticketId);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = cipher.update(plaintext);
  const final = cipher.final();
  const tag = cipher.getAuthTag();
  const out = new Uint8Array(1 + E2E_NONCE_BYTES + ciphertext.byteLength + final.byteLength + tag.byteLength);
  out[0] = ENROLL_ENVELOPE_VERSION;
  out.set(nonce, 1);
  let pos = 1 + E2E_NONCE_BYTES;
  out.set(ciphertext, pos);
  pos += ciphertext.byteLength;
  out.set(final, pos);
  pos += final.byteLength;
  out.set(tag, pos);
  return Buffer.from(out).toString("base64");
}

/**
 * Decrypt and verify a base64-encoded `0xE2` enrollment parcel using `(ticketId, ephemeralKey)`.
 */
export function openEnrollPayload<T = EnrollPayload>(
  ciphertextB64: string,
  ticketId: string,
  ephemeralKey: string,
): T {
  const wire = decodeStandardBase64(ciphertextB64);
  const minBytes = 1 + E2E_NONCE_BYTES + E2E_TAG_BYTES;
  if (wire.byteLength < minBytes) {
    throw new Error(`Enrollment envelope too short: ${wire.byteLength} < ${minBytes}`);
  }
  if (wire[0] !== ENROLL_ENVELOPE_VERSION) {
    throw new Error(`Unsupported enrollment envelope version: 0x${wire[0]!.toString(16)}`);
  }
  const nonce = wire.subarray(1, 1 + E2E_NONCE_BYTES);
  const tagStart = wire.byteLength - E2E_TAG_BYTES;
  const ciphertext = wire.subarray(1 + E2E_NONCE_BYTES, tagStart);
  const tag = wire.subarray(tagStart);
  const key = deriveEnrollKey(ticketId, ephemeralKey);
  const aad = buildEnrollAad(ticketId);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const part1 = decipher.update(ciphertext);
  const part2 = decipher.final();
  const plaintext = Buffer.concat([part1, part2]);
  return JSON.parse(utf8FatalDecoder.decode(plaintext)) as T;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

function parseSemver(raw: string): ParsedSemver | null {
  const trimmed = raw.trim().replace(/^[vV]/, "").split("+")[0]?.trim() ?? "";
  if (!trimmed) return null;
  const dashIdx = trimmed.indexOf("-");
  const core = dashIdx === -1 ? trimmed : trimmed.slice(0, dashIdx);
  const preRaw = dashIdx === -1 ? "" : trimmed.slice(dashIdx + 1);
  const parts = core.split(".");
  if (parts.length !== 3) return null;
  if (!parts.every((p) => /^(0|[1-9]\d*)$/.test(p))) return null;
  const pre = preRaw.length > 0 ? preRaw.split(".") : [];
  if (dashIdx !== -1 && (pre.length === 0 || pre.some((id) => !/^[0-9A-Za-z-]+$/.test(id)))) {
    return null;
  }
  return {
    major: Number(parts[0]),
    minor: Number(parts[1]),
    patch: Number(parts[2]),
    pre,
  };
}

/** Compare two SemVer 2.0.0 strings (`-1`, `0`, `1`), or `null` if either is invalid. */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const ia = pa.pre[i]!;
    const ib = pb.pre[i]!;
    const na = /^\d+$/.test(ia);
    const nb = /^\d+$/.test(ib);
    if (na && nb) {
      const va = Number(ia);
      const vb = Number(ib);
      if (va !== vb) return va < vb ? -1 : 1;
    } else if (na) {
      return -1;
    } else if (nb) {
      return 1;
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1;
    }
  }
  return pa.pre.length === pb.pre.length ? 0 : pa.pre.length < pb.pre.length ? -1 : 1;
}

/** Return true iff `current` and `target` are valid semver and `current < target`. */
export function isVersionOlder(current: string, target: string): boolean {
  const cmp = compareSemver(current, target);
  return cmp !== null && cmp < 0;
}

const VALID_FILE_FRAME_KINDS: ReadonlySet<number> = new Set([
  FILE_FRAME_KIND_DATA,
  FILE_FRAME_KIND_ACK,
  FILE_FRAME_KIND_FINISH,
  FILE_FRAME_KIND_DONE,
  FILE_FRAME_KIND_ABORT,
]);

const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Validate a direct file transfer ID (`^[A-Za-z0-9_-]{1,64}$`). */
export function validateTransferId(transferId: string): void {
  if (!TRANSFER_ID_RE.test(transferId)) {
    throw new Error(`Invalid transfer_id: ${JSON.stringify(transferId)}`);
  }
}

/** Build the `0xE3` direct file channel AEAD AAD `UTF8("file-v1|" + cluster_id + "|" + src_id + "|" + dst_id)`. */
export function buildFileAad(clusterId: string, srcId: string, dstId: string): Uint8Array {
  const buf = Buffer.from(`file-v1|${clusterId}|${srcId}|${dstId}`, "utf8");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Encode `FileFramePlaintext` (byte-for-byte compatible with Rust `neo-agent-os::protocol::FileFrame`):
 * `[0]=0x01, [1]=kind, [2..4]=flags(u16 BE), [4..8]=seq(u32 BE), [8..16]=offset(u64 BE),
 *  [16..20]=window(u32 BE), [20]=idLen(u8), [21..21+idLen]=transferId,
 *  [21+idLen..25+idLen]=dataLen(u32 BE), [25+idLen..]=data`.
 */
export function encodeFileFramePlaintext(frame: FileFrame): Uint8Array {
  if (frame.v !== FILE_FRAME_VERSION) {
    throw new Error(`Unsupported FileFrame version: ${String(frame.v)}`);
  }
  if (!VALID_FILE_FRAME_KINDS.has(frame.kind)) {
    throw new Error(`Unknown FileFrame kind: 0x${frame.kind.toString(16)}`);
  }
  validateTransferId(frame.transferId);
  if (!Number.isSafeInteger(frame.offset) || frame.offset < 0) {
    throw new Error(`Invalid FileFrame offset: ${frame.offset}`);
  }
  if (!Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq > 0xffffffff) {
    throw new Error(`Invalid FileFrame seq: ${frame.seq}`);
  }
  if (!Number.isInteger(frame.window) || frame.window < 0 || frame.window > 0xffffffff) {
    throw new Error(`Invalid FileFrame window: ${frame.window}`);
  }
  if (frame.data.byteLength > MAX_FILE_FRAME_DATA_BYTES) {
    throw new Error(
      `FileFrame data exceeds max size (${frame.data.byteLength} > ${MAX_FILE_FRAME_DATA_BYTES})`,
    );
  }
  const idBytes = Buffer.from(frame.transferId, "ascii");
  const total = FILE_FRAME_FIXED_HEADER_BYTES + idBytes.byteLength + frame.data.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0] = FILE_FRAME_VERSION;
  out[1] = frame.kind;
  view.setUint16(2, frame.flags & 0xffff, false);
  view.setUint32(4, frame.seq >>> 0, false);
  view.setBigUint64(8, BigInt(frame.offset), false);
  view.setUint32(16, frame.window >>> 0, false);
  out[20] = idBytes.byteLength;
  out.set(idBytes, 21);
  const dataLenOff = 21 + idBytes.byteLength;
  view.setUint32(dataLenOff, frame.data.byteLength >>> 0, false);
  out.set(frame.data, dataLenOff + 4);
  return out;
}

/** Decode a `FileFramePlaintext` binary buffer strictly. */
export function decodeFileFramePlaintext(bytes: Uint8Array): FileFrame {
  if (bytes.byteLength < FILE_FRAME_FIXED_HEADER_BYTES) {
    throw new Error(`FileFrame plaintext too short: ${bytes.byteLength}`);
  }
  if (bytes[0] !== FILE_FRAME_VERSION) {
    throw new Error(`Unsupported FileFrame version: ${bytes[0]}`);
  }
  const kind = bytes[1]!;
  if (!VALID_FILE_FRAME_KINDS.has(kind)) {
    throw new Error(`Unknown FileFrame kind: 0x${kind.toString(16)}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint16(2, false);
  const seq = view.getUint32(4, false);
  const offsetBig = view.getBigUint64(8, false);
  if (offsetBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`FileFrame offset exceeds MAX_SAFE_INTEGER: ${offsetBig.toString()}`);
  }
  const offset = Number(offsetBig);
  const window = view.getUint32(16, false);
  const idLen = bytes[20]!;
  if (idLen === 0 || idLen > MAX_TRANSFER_ID_BYTES) {
    throw new Error(`Invalid FileFrame transferId length: ${idLen}`);
  }
  const dataLenOff = 21 + idLen;
  if (bytes.byteLength < dataLenOff + 4) {
    throw new Error("Truncated FileFrame transferId/dataLen");
  }
  const transferId = utf8FatalDecoder.decode(bytes.subarray(21, dataLenOff));
  validateTransferId(transferId);
  const dataLen = view.getUint32(dataLenOff, false);
  if (dataLen > MAX_FILE_FRAME_DATA_BYTES) {
    throw new Error(`FileFrame data exceeds max size: ${dataLen}`);
  }
  const dataStart = dataLenOff + 4;
  const expectedLen = dataStart + dataLen;
  if (bytes.byteLength !== expectedLen) {
    throw new Error(`FileFrame length mismatch: expected ${expectedLen}, got ${bytes.byteLength}`);
  }
  const data = bytes.slice(dataStart, expectedLen);
  return {
    v: 1,
    kind: kind as FileFrameKind,
    flags,
    seq,
    offset,
    window,
    transferId,
    data,
  };
}

/**
 * Encrypt and authenticate a binary `FileFrame` into wire bytes:
 * `[0]=0xE3, [1..13]=12B nonce, [13..]=AES-256-GCM(FileFramePlaintext) || 16B tag`.
 */
export function sealFileFrame(
  frame: FileFrame,
  e2eMasterSecret: string,
  clusterId: string,
  srcId: string,
  dstId: string,
  nonceOverride?: Uint8Array,
): Uint8Array {
  const key = deriveE2eKey(clusterId, e2eMasterSecret);
  const nonce = nonceOverride ?? new Uint8Array(randomBytes(E2E_NONCE_BYTES));
  if (nonce.byteLength !== E2E_NONCE_BYTES) {
    throw new Error(`File E2E nonce must be ${E2E_NONCE_BYTES} bytes`);
  }
  const aad = buildFileAad(clusterId, srcId, dstId);
  const plaintext = encodeFileFramePlaintext(frame);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = cipher.update(plaintext);
  const final = cipher.final();
  const tag = cipher.getAuthTag();
  const out = new Uint8Array(
    1 + E2E_NONCE_BYTES + ciphertext.byteLength + final.byteLength + tag.byteLength,
  );
  out[0] = FILE_ENVELOPE_VERSION;
  out.set(nonce, 1);
  let pos = 1 + E2E_NONCE_BYTES;
  out.set(ciphertext, pos);
  pos += ciphertext.byteLength;
  out.set(final, pos);
  pos += final.byteLength;
  out.set(tag, pos);
  return out;
}

/** Decrypt and authenticate an incoming `0xE3` binary `FileFrame`. */
export function openFileFrame(
  wire: Uint8Array,
  e2eMasterSecret: string,
  localClusterId: string,
  srcId: string,
  dstId: string,
): FileFrame {
  const minBytes = 1 + E2E_NONCE_BYTES + E2E_TAG_BYTES;
  if (wire.byteLength < minBytes) {
    throw new Error(`File E2E envelope too short: ${wire.byteLength} < ${minBytes}`);
  }
  if (wire[0] !== FILE_ENVELOPE_VERSION) {
    throw new Error(`Unsupported file E2E envelope version: 0x${wire[0]!.toString(16)}`);
  }
  const nonce = wire.subarray(1, 1 + E2E_NONCE_BYTES);
  const tagStart = wire.byteLength - E2E_TAG_BYTES;
  const ciphertext = wire.subarray(1 + E2E_NONCE_BYTES, tagStart);
  const tag = wire.subarray(tagStart);
  const key = deriveE2eKey(localClusterId, e2eMasterSecret);
  const aad = buildFileAad(localClusterId, srcId, dstId);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const part1 = decipher.update(ciphertext);
  const part2 = decipher.final();
  const plaintext = Buffer.concat([part1, part2]);
  return decodeFileFramePlaintext(
    new Uint8Array(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength),
  );
}

/** Maximum Unicode code points allowed in a user-defined custom device name. */
export const MAX_DEVICE_CUSTOM_NAME_CHARS = 64;

const DEVICE_NAME_CONTROL_RE = /[\u0000-\u001F\u007F]/;

/**
 * Validate and normalize an optional custom device display name.
 * Returns `undefined` when empty/whitespace/null (meaning unset/default),
 * or throws an `Error` if control characters or length limits are violated.
 */
export function normalizeDeviceCustomName(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (DEVICE_NAME_CONTROL_RE.test(trimmed)) {
    throw new Error("Device custom name cannot contain control characters");
  }
  if (Array.from(trimmed).length > MAX_DEVICE_CUSTOM_NAME_CHARS) {
    throw new Error(`Device custom name must be at most ${MAX_DEVICE_CUSTOM_NAME_CHARS} characters`);
  }
  return trimmed;
}
