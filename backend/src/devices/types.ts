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
/** Zero-trust enrollment AEAD envelope version tag byte. */
export const ENROLL_ENVELOPE_VERSION = 0xe2;
/** Direct binary E2E file transfer channel AEAD envelope version tag byte. */
export const FILE_ENVELOPE_VERSION = 0xe3;
export const FILE_FRAME_VERSION = 0x01;
export const FILE_FRAME_FIXED_HEADER_BYTES = 25;
export const MAX_FILE_FRAME_DATA_BYTES = 1024 * 1024;
export const MAX_TRANSFER_ID_BYTES = 64;
export const E2E_NONCE_BYTES = 12;
export const E2E_TAG_BYTES = 16;

/** Binary file frame kinds inside a `0xE3` AEAD envelope. */
export const FILE_FRAME_KIND_DATA = 0x01;
export const FILE_FRAME_KIND_ACK = 0x02;
export const FILE_FRAME_KIND_FINISH = 0x03;
export const FILE_FRAME_KIND_DONE = 0x04;
export const FILE_FRAME_KIND_ABORT = 0x05;

export type FileFrameKind =
  | typeof FILE_FRAME_KIND_DATA
  | typeof FILE_FRAME_KIND_ACK
  | typeof FILE_FRAME_KIND_FINISH
  | typeof FILE_FRAME_KIND_DONE
  | typeof FILE_FRAME_KIND_ABORT;

/** Decoded binary file channel frame carried inside a `0xE3` AES-256-GCM envelope. */
export interface FileFrame {
  v: 1;
  kind: FileFrameKind;
  flags: number;
  seq: number;
  offset: number;
  window: number;
  transferId: string;
  data: Uint8Array;
}

/** Default public relay URL used when initializing a new cluster. */
export const DEFAULT_RELAY_URL = "https://neo.1inch.cn:18443";
/** Default co-located `neo-relayd` environment file path. */
export const DEFAULT_LOCAL_RELAY_ENV_PATH = "/nvme/neo-relay/config/relay.env";

/** Message kind inside an encrypted `DeviceMessage`. */
export type DeviceMessageKind =
  | "manifest"
  | "rpc_req"
  | "rpc_resp"
  | "heartbeat"
  | "relay_envelope"
  | "event"
  | "enroll_register"
  | "enroll_ack";

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

/** 5-level per-device sandbox execution permission tiers (ordered from most restricted to unrestricted). */
export type SandboxLevel = "readonly" | "corp" | "personal" | "desktop" | "unrestricted";

/** Ordered list of valid sandbox levels. */
export const SANDBOX_LEVELS: readonly SandboxLevel[] = [
  "readonly",
  "corp",
  "personal",
  "desktop",
  "unrestricted",
];

/** Type guard for `SandboxLevel`. */
export function isSandboxLevel(value: unknown): value is SandboxLevel {
  return typeof value === "string" && (SANDBOX_LEVELS as readonly string[]).includes(value);
}

/** Sync state of a Tier 1 OS device's desired vs. reported sandbox policy. */
export type SandboxSyncState = "synced" | "pending" | "unsupported" | "locked" | "error";

/** Declared action metadata in a capability manifest. */
export interface DeviceActionSpec {
  name: string;
  description?: string;
  risk?: DeviceRiskLevel;
  params?: Record<string, unknown>;
}

/** Reported sandbox policy summary inside a Tier 1 OS `CapabilityManifest`. */
export interface SandboxSummary {
  level?: SandboxLevel;
  unrestricted?: boolean;
  read_only?: boolean;
  locked?: boolean;
  allowed_workspaces?: string[];
  max_child_mem_mb?: number;
  max_exec_timeout_sec?: number;
  [key: string]: unknown;
}

/** Transport kind for a local MCP server discovered on a Tier 1 OS device. */
export type McpTransportKind = "stdio" | "streamable_http" | "sse";

/** Ordered list of valid MCP transport kinds. */
export const MCP_TRANSPORT_KINDS: readonly McpTransportKind[] = [
  "stdio",
  "streamable_http",
  "sse",
];

/** Type guard for `McpTransportKind`. */
export function isMcpTransportKind(value: unknown): value is McpTransportKind {
  return typeof value === "string" && (MCP_TRANSPORT_KINDS as readonly string[]).includes(value);
}

/** Trust lifecycle state of a discovered local MCP server. */
export type McpTrustState = "discovered" | "enabled" | "disabled" | "blocked_by_policy";

/** Ordered list of valid MCP trust states. */
export const MCP_TRUST_STATES: readonly McpTrustState[] = [
  "discovered",
  "enabled",
  "disabled",
  "blocked_by_policy",
];

/** Type guard for `McpTrustState`. */
export function isMcpTrustState(value: unknown): value is McpTrustState {
  return typeof value === "string" && (MCP_TRUST_STATES as readonly string[]).includes(value);
}

/** Call risk policy mode for a local MCP server. */
export type McpCallPolicyMode = "disabled" | "confirm_all" | "auto_readonly" | "auto_all";

/** Ordered list of valid MCP call policy modes. */
export const MCP_CALL_POLICY_MODES: readonly McpCallPolicyMode[] = [
  "disabled",
  "confirm_all",
  "auto_readonly",
  "auto_all",
];

/** Type guard for `McpCallPolicyMode`. */
export function isMcpCallPolicyMode(value: unknown): value is McpCallPolicyMode {
  return typeof value === "string" && (MCP_CALL_POLICY_MODES as readonly string[]).includes(value);
}

/** Runtime process/session state of a local MCP server on Tier 1. */
export type McpRuntimeState = "stopped" | "starting" | "running" | "idle" | "error";

/** Ordered list of valid MCP runtime states. */
export const MCP_RUNTIME_STATES: readonly McpRuntimeState[] = [
  "stopped",
  "starting",
  "running",
  "idle",
  "error",
];

/** Type guard for `McpRuntimeState`. */
export function isMcpRuntimeState(value: unknown): value is McpRuntimeState {
  return typeof value === "string" && (MCP_RUNTIME_STATES as readonly string[]).includes(value);
}

/** Local MCP discovery scope active on a Tier 1 OS agent. */
export type McpDiscoveryMode = "disabled" | "neo_only" | "configs_only" | "configs_and_loopback";

/** Ordered list of valid MCP discovery modes. */
export const MCP_DISCOVERY_MODES: readonly McpDiscoveryMode[] = [
  "disabled",
  "neo_only",
  "configs_only",
  "configs_and_loopback",
];

/** Type guard for `McpDiscoveryMode`. */
export function isMcpDiscoveryMode(value: unknown): value is McpDiscoveryMode {
  return typeof value === "string" && (MCP_DISCOVERY_MODES as readonly string[]).includes(value);
}

/** Compact per-server summary item carried inside `CapabilityManifest.mcp_summary`. */
export interface McpServerSummaryItem {
  server_id: string;
  name: string;
  source: string;
  transport: McpTransportKind;
  trust_state: McpTrustState;
  call_mode: McpCallPolicyMode;
  runtime_state: McpRuntimeState;
  tool_count?: number | null;
}

/** Lightweight MCP discovery summary embedded in `CapabilityManifest` (never carries full tool schemas). */
export interface McpSummary {
  enabled: boolean;
  discovery_mode: McpDiscoveryMode;
  discovered_count: number;
  enabled_count: number;
  running_count: number;
  catalog_hash: string;
  servers: McpServerSummaryItem[];
}

/** Standard MCP ToolAnnotations hints used for risk classification. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Normalized MCP tool metadata returned by `mcp.inspect`. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

/** Redacted local MCP server descriptor reported by Tier 1 OS agents (secrets stay local). */
export interface McpServerDescriptor {
  server_id: string;
  name: string;
  source: string;
  source_path?: string | null;
  transport: McpTransportKind;
  command_preview?: string | null;
  url_sanitized?: string | null;
  env_keys: string[];
  auth_required: boolean;
  trust_state: McpTrustState;
  call_mode: McpCallPolicyMode;
  runtime_state: McpRuntimeState;
  tool_count?: number | null;
  dedup_key?: string | null;
  duplicate_of?: string | null;
  fingerprint?: string | null;
  last_error?: string | null;
  discovered_at_ms?: number | null;
}

/** Cached tool/resource/prompt inspection payload for a single MCP server. */
export interface McpInspectedServerRecord {
  tools: McpToolInfo[];
  resources?: unknown[];
  prompts?: unknown[];
  toolsSchemaHash?: string;
  serverInfo?: Record<string, unknown>;
  protocolVersion?: string;
  inspectedAt: string;
}

/** Persisted per-device MCP catalog stored separately in KV under `device-mcp:<deviceId>`. */
export interface DeviceMcpCatalogRecord {
  deviceId: string;
  clusterId: string;
  discoveryMode: McpDiscoveryMode;
  catalogHash: string;
  scannedAtMs?: number;
  updatedAt: string;
  servers: McpServerDescriptor[];
  warnings?: string[];
  toolsByServer: Record<string, McpInspectedServerRecord>;
  summary?: McpSummary;
}

/** Public overview of a Tier 1 OS device's MCP discovery catalog and support state. */
export interface DeviceMcpOverview {
  deviceId: string;
  customName?: string;
  status: DeviceStatus;
  supported: boolean;
  discoveryMode: McpDiscoveryMode;
  catalogHash: string;
  scannedAtMs?: number;
  updatedAt: string;
  servers: McpServerDescriptor[];
  warnings?: string[];
  summary?: McpSummary;
}

/** Options for `DeviceMcpProxy.discover`. */
export interface DeviceMcpDiscoverOptions {
  includeLoopbackProbe?: boolean;
  sources?: string[];
  timeoutMs?: number;
}

/** Options for `DeviceMcpProxy.list`. */
export interface DeviceMcpListOptions {
  refresh?: boolean;
  includeLoopbackProbe?: boolean;
  timeoutMs?: number;
}

/** Options for `DeviceMcpProxy.inspect`. */
export interface DeviceMcpInspectOptions {
  query?: string;
  includeResources?: boolean;
  includePrompts?: boolean;
  refresh?: boolean;
  timeoutMs?: number;
}

/** Outcome of `DeviceMcpProxy.inspect`. */
export interface DeviceMcpInspectResult {
  deviceId: string;
  serverId: string;
  server?: McpServerDescriptor;
  tools: McpToolInfo[];
  totalTools: number;
  filtered: boolean;
  resources?: unknown[];
  prompts?: unknown[];
  toolsSchemaHash?: string;
  serverInfo?: Record<string, unknown>;
  protocolVersion?: string;
  cached: boolean;
  inspectedAt: string;
}

/** Input to `DeviceMcpProxy.setServerPolicy`. */
export interface DeviceMcpPolicyUpdateInput {
  enabled?: boolean;
  callMode?: McpCallPolicyMode;
  timeoutMs?: number;
}

/** Outcome of `DeviceMcpProxy.setServerPolicy`. */
export interface DeviceMcpPolicyUpdateResult {
  deviceId: string;
  serverId: string;
  server?: McpServerDescriptor;
  persisted?: boolean;
  summary?: McpSummary;
  result?: unknown;
}

/** Outcome of `DeviceMcpProxy.stopServer` / `restartServer`. */
export interface DeviceMcpServerActionResult {
  deviceId: string;
  serverId: string;
  action: "stop" | "restart";
  stopped?: boolean;
  restarted?: boolean;
  runtimeState?: McpRuntimeState;
  server?: McpServerDescriptor;
  summary?: McpSummary;
  result?: unknown;
}

/** Supported MCP invocation operations through `DeviceMcpProxy.callTool`. */
export type McpCallAction = "tools/call" | "resources/read" | "prompts/get";

/** Input to `DeviceMcpProxy.callTool`. */
export interface DeviceMcpCallInput {
  serverId: string;
  action?: McpCallAction;
  toolName?: string;
  arguments?: Record<string, unknown>;
  uri?: string;
  promptName?: string;
  timeoutMs?: number;
  reason?: string;
}

/** Tier 1 or Tier 2 capability manifest reported by an agent. */
export interface CapabilityManifest {
  device_id: string;
  tier: DeviceTier;
  agent_version?: string;
  version?: string;
  os?: string;
  arch?: string;
  hostname?: string;
  public_ip?: string;
  location?: string;
  cpus?: number;
  ram_mb?: number;
  capabilities?: string[];
  actions?: DeviceActionSpec[];
  sandbox?: SandboxSummary;
  mcp_summary?: McpSummary;
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
  /** Optional user-defined custom display name (does not alter protocol `deviceId`). */
  customName?: string;
  tier: DeviceTier;
  status: DeviceStatus;
  route: DeviceRouteKind;
  agentVersion?: string;
  publicIp?: string;
  location?: string;
  locationIp?: string;
  lanUrl?: string;
  relayNodeId?: string;
  backupRelayNodeIds?: string[];
  alertSuppressed?: boolean;
  manifest?: CapabilityManifest;
  capabilities: string[];
  sandboxLevel?: SandboxLevel;
  desiredSandboxLevel?: SandboxLevel;
  sandboxSyncState?: SandboxSyncState;
  sandboxSyncError?: string;
  sandboxUpdatedAt?: string;
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

/** Input to `DeviceManager.setDeviceSandboxLevel`. */
export interface DeviceSandboxUpdateInput {
  level: SandboxLevel;
  workspaces?: string[];
  timeoutMs?: number;
}

/** Outcome of `DeviceManager.setDeviceSandboxLevel`. */
export interface DeviceSandboxUpdateResult {
  device: DeviceTwin;
  level: SandboxLevel;
  applied: boolean;
  pending: boolean;
  persisted?: boolean;
  warning?: string;
  error?: string;
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
  canMintTokens: boolean;
  relayState: RelayConnectionState;
  localRelayDetected: boolean;
  defaultRelayUrl: string;
  agentVersion: string;
  masterVersion: string;
}

/** Input to `DeviceManager.initOrUpdateConfig`. */
export interface DeviceConfigUpdateInput {
  clusterId?: string;
  masterNodeId?: string;
  relayUrl?: string;
  relaySecret?: string;
  clusterSecret?: string;
  token?: string;
  e2eKey?: string;
  tokenTtlSec?: number;
  autoDetectLocalRelay?: boolean;
  enabled?: boolean;
}

/** Outcome of `DeviceManager.pingDevice`. */
export interface DevicePingResult {
  ok: boolean;
  deviceId: string;
  latencyMs: number;
  status: DeviceStatus;
  route: DeviceRouteKind;
  error?: string;
}

/** Status of a remote Tier device update request. */
export type DeviceUpdateStatus =
  | "restarting"
  | "updated"
  | "queued"
  | "staged"
  | "up_to_date"
  | "manual_upgrade_required"
  | "failed";

/** Input to `DeviceManager.updateDevice`. */
export interface DeviceUpdateInput {
  targetVersion?: string;
  downloadMirrors?: string[];
  sha256?: string;
  force?: boolean;
  timeoutMs?: number;
}

/** Outcome of `DeviceManager.updateDevice`. */
export interface DeviceUpdateResult {
  ok: boolean;
  status: DeviceUpdateStatus;
  deviceId: string;
  tier: DeviceTier;
  currentVersion?: string;
  targetVersion: string;
  message: string;
  error?: string;
  upgradeCommand?: string;
  seqId?: number;
  installedPath?: string;
  sha256?: string;
  mirror?: string;
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

/** Peer summary item returned by `neo-relayd` `GET /v1/peers`. */
export interface RelayPeerInfo {
  cluster_id?: string;
  node_id?: string;
  tier?: string;
  observed_ip?: string;
  lan_addrs?: string[];
  reflexive_udp?: string;
  nat_type?: string;
  path_mode?: string;
  signal_online?: boolean;
  relay_online?: boolean;
  last_seen_ms?: number;
  [key: string]: unknown;
}

/** Response shape returned by `neo-relayd` `GET /v1/bootstrap`. */
export interface RelayBootstrapResponse {
  cluster_id?: string;
  node_id?: string;
  observed_ip?: string;
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

/** Target OS / runtime platform for one-click agent enrollment. */
export type EnrollmentPlatform = "linux" | "macos" | "windows" | "docker";

/** Sandbox policy preset for enrolled Tier 1 OS agents. */
export type EnrollmentProfile = SandboxLevel;

/** Installation privilege / service mode on the target host. */
export type EnrollmentInstallMode = "auto" | "system" | "user" | "foreground";

/** Ticket delivery transport: zero-trust relay pool or Master Direct Mode. */
export type EnrollmentTransportMode = "relay" | "direct";

/** Lifecycle status of an agent enrollment ticket. */
export type EnrollmentStatus = "pending" | "claimed" | "completed" | "expired" | "revoked";

/** Authentication handoff mode inside an encrypted `EnrollPayload`. */
export type EnrollmentAuthMode = "direct" | "bootstrap_exchange";

/** Decrypted enrollment parcel sealed with `0xE2` AES-256-GCM. */
export interface EnrollPayload {
  v: 1;
  enroll_id: string;
  cluster_id: string;
  master_id: string;
  relay_url: string;
  device_id: string;
  auth_mode: EnrollmentAuthMode;
  relay_token: string;
  e2e_key: string;
  agent_version: string;
  download_mirrors: string[];
  checksums: Record<string, string>;
  install_mode: EnrollmentInstallMode;
  policy_profile: EnrollmentProfile;
  policy_toml: string;
  workspace_override: string;
  relay_bridge: {
    enabled: boolean;
    mqtt_bind: string;
    uart_device: string | null;
  };
  limits: {
    memory_max: string;
    cpu_quota: string;
    cuda_devices: string;
  };
  expires_at: number;
}

/** Platform-specific one-line installation and uninstall commands. */
export interface EnrollmentCommands {
  linuxRoot: string;
  linuxUser: string;
  macos: string;
  windows: string;
  docker: string;
  uninstall: string;
}

/** Input to `createEnrollment`. */
export interface EnrollmentCreateInput {
  platform?: EnrollmentPlatform;
  profile?: EnrollmentProfile;
  installMode?: EnrollmentInstallMode;
  deviceId?: string;
  customName?: string;
  workspaces?: string[];
  relayBridge?: boolean;
  mqttBind?: string;
  uartDevice?: string | null;
  cudaDevices?: string;
  memoryMax?: string;
  cpuQuota?: string;
  transportMode?: EnrollmentTransportMode;
  masterPublicUrl?: string;
  ttlSec?: number;
  maxUses?: number;
  agentVersion?: string;
  downloadMirrors?: string[];
  checksums?: Record<string, string>;
}

/** Public view of an enrollment record (never exposes cluster `e2eKey` or long-lived tokens). */
export interface EnrollmentView {
  id: string;
  ticketId: string;
  clusterId: string;
  status: EnrollmentStatus;
  platform: EnrollmentPlatform;
  profile: EnrollmentProfile;
  installMode: EnrollmentInstallMode;
  transportMode: EnrollmentTransportMode;
  authMode: EnrollmentAuthMode;
  requestedDeviceId?: string;
  requestedCustomName?: string;
  relayUrl?: string;
  claimUrl?: string;
  ttlSec: number;
  maxUses: number;
  usedCount: number;
  claimedCount: number;
  createdAt: string;
  expiresAt: string;
  expiresAtSec: number;
  lastClaimedAt?: string;
  lastClaimedIp?: string;
  completedAt?: string;
  revokedAt?: string;
  enrolledDeviceIds: string[];
  enrollCode?: string;
  commands?: EnrollmentCommands;
  qrPayload?: string;
  policyPreview?: string;
}

/** Result of Master Direct Mode `POST /enroll/claim/:id`. */
export type DirectClaimResult =
  | {
      ok: true;
      status: 200;
      ticket_id: string;
      ciphertext_b64: string;
      expires_at: number;
      expires_at_ms: number;
    }
  | {
      ok: false;
      status: 404 | 410 | 429;
      error: string;
    };

/** Physical/local transport linking a Tier 2 MCU to its Tier 1 `neo-agent-os` gateway. */
export type McuTransportKind = "mqtt" | "serial";

/** Input to `DeviceManager.installMcuViaTier1`. */
export interface McuInstallInput {
  mcuId: string;
  customName?: string;
  relayDeviceId: string;
  transport: McuTransportKind;
  mqttBroker?: string;
  serialPort?: string;
  baudRate?: number;
  chip?: string;
  backupRelayDeviceIds?: string[];
  autoDeploy?: boolean;
}

/** Output of `DeviceManager.installMcuViaTier1`. */
export interface McuInstallResult {
  twin: DeviceTwin;
  deployed: boolean;
  deployMethod: "tier1_rpc" | "staged_manual";
  deployDetail: string;
  workspaceDir: string;
  configHeader: string;
  installScript: string;
  mcuE2eKeyHex: string;
}

/** Result of Tier 1 `fs.stat` / `fs_stat` RPC. */
export interface DeviceFileStat {
  exists: boolean;
  path: string;
  name?: string;
  kind?: "file" | "dir" | "symlink" | "other";
  is_file?: boolean;
  is_dir?: boolean;
  is_symlink?: boolean;
  size?: number;
  readonly?: boolean;
  mode?: number | null;
  mtime_ms?: number | null;
  ctime_ms?: number | null;
  sha256?: string;
}

/** Direction of a direct Master Neo <-> Tier 1 file transfer. */
export type FileTransferDirection = "pull" | "push";

/** Wire transport protocol used for a file transfer. */
export type FileTransferProtocol = "binary_e2e_v1" | "rpc_fallback";

/** Lifecycle status of an observable file transfer. */
export type FileTransferStatus = "opening" | "transferring" | "completed" | "failed" | "cancelled";

/** Input to `DeviceManager.pullFile`. */
export interface DeviceFilePullInput {
  deviceId: string;
  remotePath: string;
  localPath: string;
  transferId?: string;
  overwrite?: boolean;
  resume?: boolean;
  chunkSize?: number;
  windowBytes?: number;
  timeoutMs?: number;
  allowFallback?: boolean;
}

/** Input to `DeviceManager.pushFile`. */
export interface DeviceFilePushInput {
  deviceId: string;
  localPath: string;
  remotePath: string;
  transferId?: string;
  overwrite?: boolean;
  resume?: boolean;
  chunkSize?: number;
  windowBytes?: number;
  timeoutMs?: number;
  allowFallback?: boolean;
}

/** Completed outcome of `DeviceManager.pullFile` / `DeviceManager.pushFile`. */
export interface DeviceFileTransferResult {
  transferId: string;
  deviceId: string;
  direction: FileTransferDirection;
  remotePath: string;
  localPath: string;
  bytesTransferred: number;
  totalBytes: number;
  resumedFromBytes: number;
  chunks: number;
  sha256: string;
  durationMs: number;
  throughputBytesPerSec: number;
  protocol: FileTransferProtocol;
}

/** Public snapshot of an active or recently finished file transfer. */
export interface FileTransferView {
  transferId: string;
  deviceId: string;
  direction: FileTransferDirection;
  remotePath: string;
  localPath: string;
  status: FileTransferStatus;
  protocol: FileTransferProtocol;
  bytesTransferred: number;
  totalBytes: number;
  resumedFromBytes: number;
  chunks: number;
  sha256?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}
