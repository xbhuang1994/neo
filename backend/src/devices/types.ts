/**
 * Shared types for Neo Multi-Device Control Plane (wire protocol, relay client,
 * Device Twin state, risk gating, and RPC payloads).
 */

/** Node tier encoded inside `neo1` authentication tokens. */
export type TokenTier = "master" | "os" | "relay" | "admin";

/** Claims JSON inside a `neo1` token. */
export interface TokenClaims {
  cluster_id: string;
  node_id: string;
  tier: TokenTier;
  iat: number;
  exp: number;
}

/** `neo-relay` 10-byte binary frame magic bytes and version. */
export const RELAY_MAGIC_0 = 0x4e; // 'N'
export const RELAY_MAGIC_1 = 0x52; // 'R'
export const RELAY_VERSION = 0x01;
export const RELAY_HEADER_BYTES = 10;

/** `neo-relay` binary frame flags. */
export const FLAG_DATA = 0x01;
export const FLAG_PING = 0x02;
export const FLAG_PONG = 0x03;
export const FLAG_ERR_OFFLINE = 0x81;
export const FLAG_ERR_SPOOFED = 0x82;
export const FLAG_ERR_RATE = 0x83;

export type RelayFrameFlag =
  | typeof FLAG_DATA
  | typeof FLAG_PING
  | typeof FLAG_PONG
  | typeof FLAG_ERR_OFFLINE
  | typeof FLAG_ERR_SPOOFED
  | typeof FLAG_ERR_RATE;

/** Decoded 10-byte header + variable body of a `/v1/relay` binary frame. */
export interface RelayFrame {
  flags: number;
  src: string;
  dst: string;
  payload: Uint8Array;
}

/** Inner E2E AEAD envelope version tag byte. */
export const E2E_ENVELOPE_VERSION = 0xe1;
export const E2E_NONCE_BYTES = 12;
export const E2E_TAG_BYTES = 16;

/** Message kind inside an encrypted `DeviceMessage`. */
export type DeviceMessageKind =
  | "manifest"
  | "rpc_req"
  | "rpc_resp"
  | "heartbeat"
  | "relay_envelope"
  | "event";

/** Plaintext JSON payload inside the Master <-> Tier 1 OS Agent AEAD envelope. */
export interface DeviceMessage {
  v: 1;
  kind: DeviceMessageKind;
  req_id: string;
  cluster_id: string;
  device_id: string;
  ts_ms: number;
  body: Record<string, unknown>;
}

/** Direction of a Tier 2 MCU `RelayEnvelope`. */
export type RelayDirection = "downlink" | "uplink";

/** Tier 2 MCU E2E relay envelope carried in `DeviceMessage.body` when `kind === "relay_envelope"`. */
export interface RelayEnvelope {
  cluster_id: string;
  relay_node_id: string;
  target_mcu_id: string;
  direction: RelayDirection;
  seq_id: number;
  e2e_mac: string;
  cbor_payload_b64: string;
}

/** Downlink CBOR command map sent to a Tier 2 MCU. */
export interface McuCborCommand {
  t: "cmd";
  a: string;
  p: Record<string, unknown>;
}

/** Uplink CBOR result map received from a Tier 2 MCU. */
export interface McuCborResult {
  t: "res";
  ok: boolean;
  a: string;
  d: Record<string, unknown>;
  e?: string;
}

/** Uplink CBOR hello announcement received from a Tier 2 MCU. */
export interface McuCborHello {
  t: "hello";
  chip: string;
  fw: string;
  acts: string[];
}

export type McuCborPayload = McuCborCommand | McuCborResult | McuCborHello | Record<string, unknown>;

/** Device architecture tier. */
export type DeviceTier = "os" | "mcu";

/** Dynamic routing path to a device. */
export type DeviceRouteKind = "lan" | "p2p" | "relay" | "via_tier1";

/** Current reachability status of a device twin. */
export type DeviceStatus = "online" | "offline" | "sleeping" | "unreachable_via_relay";

/** Action risk classification for the risk gate. */
export type DeviceRiskLevel = "safe_auto" | "confirm_required" | "forbidden";

/** Declared action metadata in a capability manifest. */
export interface DeviceActionSpec {
  name: string;
  description?: string;
  risk?: DeviceRiskLevel;
  params?: Record<string, unknown>;
}

/** Tier 1 or Tier 2 capability manifest reported by an agent. */
export interface CapabilityManifest {
  device_id: string;
  tier: DeviceTier;
  os?: string;
  arch?: string;
  hostname?: string;
  cpus?: number;
  ram_mb?: number;
  capabilities?: string[];
  actions?: DeviceActionSpec[];
  sandbox?: Record<string, unknown>;
  relay_config?: {
    enabled?: boolean;
    mqtt_bind?: string;
    uart_device?: string | null;
  };
  chip?: string;
  fw?: string;
  acts?: string[];
}

/** Queued downlink command for a sleeping Tier 2 MCU. */
export interface PendingMcuCommand {
  seqId: number;
  action: string;
  params: Record<string, unknown>;
  reqId: string;
  queuedAt: string;
  attempts: number;
  relayNodeId?: string;
}

/** Persisted Device Twin stored under `device:<deviceId>` in `Store` KV. */
export interface DeviceTwin {
  deviceId: string;
  clusterId: string;
  tier: DeviceTier;
  status: DeviceStatus;
  route: DeviceRouteKind;
  lanUrl?: string;
  relayNodeId?: string;
  backupRelayNodeIds?: string[];
  alertSuppressed?: boolean;
  manifest?: CapabilityManifest;
  capabilities: string[];
  desiredState: Record<string, unknown>;
  reportedState: Record<string, unknown>;
  pendingQueue: PendingMcuCommand[];
  lastSeqId: number;
  lastAckedSeqId: number;
  seenUplinkSeqIds?: number[];
  lastSeenAt?: string;
  lastSeenMs?: number;
  updatedAt: string;
}

/** Approval status for `confirm_required` device invocations. */
export type ApprovalStatus = "pending" | "approved" | "rejected";

/** Persisted approval record stored under `device-approval:<id>` in `Store` KV. */
export interface PendingApproval {
  id: string;
  shortCode: string;
  clusterId: string;
  deviceId: string;
  action: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  reason?: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  result?: unknown;
  error?: string;
}

/** Persistent or env-derived configuration for the Master Neo device control plane. */
export interface DeviceConfig {
  clusterId: string;
  masterNodeId: string;
  relayUrl?: string;
  relaySecret?: string;
  clusterSecret?: string;
  token?: string;
  e2eKey: string;
  tokenTtlSec?: number;
  enabled: boolean;
}

/** Public view of `DeviceConfig` with secrets redacted. */
export interface DeviceConfigView {
  enabled: boolean;
  configured: boolean;
  clusterId: string;
  masterNodeId: string;
  relayUrl?: string;
  hasRelaySecret: boolean;
  hasClusterSecret: boolean;
  hasToken: boolean;
  hasE2eKey: boolean;
}

/** Input to `DeviceManager.invoke`. */
export interface DeviceInvokeRequest {
  action: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  reason?: string;
  riskOverride?: DeviceRiskLevel;
  forceQueue?: boolean;
}

/** Outcome of `DeviceManager.invoke`. */
export type DeviceInvokeResult =
  | {
      status: "ok";
      deviceId: string;
      action: string;
      reqId: string;
      seqId?: number;
      result: unknown;
    }
  | {
      status: "queued";
      deviceId: string;
      action: string;
      reqId: string;
      seqId: number;
      reason: string;
    }
  | {
      status: "pending_approval";
      approvalId: string;
      shortCode: string;
      deviceId: string;
      action: string;
      params: Record<string, unknown>;
    }
  | {
      status: "rejected";
      deviceId: string;
      action: string;
      error: string;
    };

/** Response shape returned by `neo-relayd` `GET /v1/bootstrap`. */
export interface RelayBootstrapResponse {
  cluster_id?: string;
  node_id?: string;
  relay_url?: string;
  relay_ws_url?: string;
  signal_url?: string;
  signal_ws_url?: string;
  stun_addrs?: string[];
  stun_port?: number;
  peers?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** JSON message exchanged on `neo-relayd` `/v1/signal` WebSocket. */
export interface SignalMessage {
  type: string;
  cluster_id?: string;
  node_id?: string;
  from?: string;
  to?: string;
  src?: string;
  dst?: string;
  peer_id?: string;
  sdp?: string;
  addr?: string;
  addrs?: string[];
  reason?: string;
  ts_ms?: number;
  [key: string]: unknown;
}

/** Connection state of `RelayClient`. */
export type RelayConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

/** Result of validating an S3 artifact URI for cluster isolation. */
export type S3PrefixValidation =
  | {
      ok: true;
      bucket: string;
      clusterId: string;
      taskId: string;
      objectKey: string;
    }
  | {
      ok: false;
      error: string;
    };
