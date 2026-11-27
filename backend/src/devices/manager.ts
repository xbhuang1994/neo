/**
 * Master Neo Device Control Plane (`DeviceManager`):
 * - Persists Device Twins (`device:*`), pending approvals (`device-approval:*`), and config (`device-config`) in `Store` KV.
 * - Routes invocations dynamically (`lan | p2p | relay | via_tier1`) over encrypted E2E envelopes.
 * - Handles Tier 1 disconnect -> marks child Tier 2 MCUs `unreachable_via_relay` (alert suppression) or fails over to backup Tier 1 relay.
 * - Implements Tier 2 Deep Sleep desired-state queue with monotonic `seq_id` idempotency.
 * - Enforces risk gate (`safe_auto`, `confirm_required`, `forbidden`) and Layer 4 S3 cluster prefix validation.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { HealthBoard } from "../app/health.ts";
import type { Store } from "../store/index.ts";
import { VERSION } from "../version.ts";
import { EnrollmentManager, validateWorkspacePath } from "./enrollment.ts";
import { FileTransferManager } from "./file-transfer.ts";
import {
  compareSemver,
  deriveMcuE2eKey,
  isVersionOlder,
  mintRelayToken,
  openDeviceMessage,
  openRelayEnvelope,
  sealDeviceMessage,
  sealRelayEnvelope,
  validateS3ClusterArtifactUri,
} from "./protocol.ts";
import { RelayClient, type RelayErrorEvent, type RelaySocket } from "./relay-client.ts";
import {
  DEFAULT_LOCAL_RELAY_ENV_PATH,
  DEFAULT_RELAY_URL,
  FILE_ENVELOPE_VERSION,
  FLAG_ERR_OFFLINE,
  FLAG_ERR_RATE,
  SANDBOX_LEVELS,
  isSandboxLevel,
  type CapabilityManifest,
  type DeviceConfig,
  type DeviceConfigUpdateInput,
  type DeviceConfigView,
  type DeviceFilePullInput,
  type DeviceFilePushInput,
  type DeviceFileTransferResult,
  type DeviceInvokeRequest,
  type DeviceInvokeResult,
  type DeviceMessage,
  type DevicePingResult,
  type DeviceRiskLevel,
  type DeviceRouteKind,
  type DeviceSandboxUpdateResult,
  type DeviceStatus,
  type DeviceTwin,
  type DeviceUpdateInput,
  type DeviceUpdateResult,
  type DirectClaimResult,
  type EnrollmentCreateInput,
  type EnrollmentView,
  type FileTransferView,
  type McuCborHello,
  type McuCborResult,
  type McuInstallInput,
  type McuInstallResult,
  type PendingApproval,
  type PendingMcuCommand,
  type RelayEnvelope,
  type RelayFrame,
  type S3PrefixValidation,
  type SandboxLevel,
  type SandboxSummary,
  type SandboxSyncState,
  type SignalMessage,
  type TokenTier,
} from "./types.ts";

const DEVICE_KEY_PREFIX = "device:";
const APPROVAL_KEY_PREFIX = "device-approval:";
const CONFIG_KEY = "device-config";

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const MAX_UPLINK_SEQ_HISTORY = 64;

const FORBIDDEN_ACTIONS: ReadonlySet<string> = new Set([
  "factory_reset",
  "wipe_disk",
  "rm_rf",
  "format_disk",
  "flash_bootloader_unsigned",
  "self_destruct",
]);

const DEFAULT_CONFIRM_ACTIONS: ReadonlySet<string> = new Set([
  "set_fan_pwm",
  "set_gpio",
  "ota_apply",
  "self_update",
  "agent.update",
  "reboot",
  "shutdown",
  "unlock_door",
  "relay_switch",
  "set_sandbox",
  "sandbox.set",
]);

const CLUSTER_ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const MCU_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const CHIP_RE = /^[a-zA-Z0-9._-]{1,32}$/;
const SEMVER_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const DEFAULT_UPDATE_TIMEOUT_MS = 180_000;
const GITHUB_RELEASE_BASE = "https://github.com/xbhuang1994/neo/releases/download";

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSandboxSummary(raw: Record<string, unknown>): SandboxSummary {
  const out: SandboxSummary = { ...raw };
  if (isSandboxLevel(raw.level)) {
    out.level = raw.level;
  } else {
    delete out.level;
  }
  if (typeof raw.unrestricted === "boolean") {
    out.unrestricted = raw.unrestricted;
  } else {
    delete out.unrestricted;
  }
  if (typeof raw.read_only === "boolean") {
    out.read_only = raw.read_only;
  } else {
    delete out.read_only;
  }
  if (typeof raw.locked === "boolean") {
    out.locked = raw.locked;
  } else {
    delete out.locked;
  }
  if (Array.isArray(raw.allowed_workspaces)) {
    out.allowed_workspaces = raw.allowed_workspaces.filter((w): w is string => typeof w === "string");
  } else {
    delete out.allowed_workspaces;
  }
  if (typeof raw.max_child_mem_mb === "number") {
    out.max_child_mem_mb = raw.max_child_mem_mb;
  } else {
    delete out.max_child_mem_mb;
  }
  if (typeof raw.max_exec_timeout_sec === "number") {
    out.max_exec_timeout_sec = raw.max_exec_timeout_sec;
  } else {
    delete out.max_exec_timeout_sec;
  }
  return out;
}

/** Infer a Tier 1 OS device's reported `SandboxLevel` from its manifest sandbox summary. */
export function inferSandboxLevel(
  sandbox?: Record<string, unknown>,
  fallback?: SandboxLevel,
): SandboxLevel | undefined {
  if (isRecord(sandbox)) {
    if (isSandboxLevel(sandbox.level)) {
      return sandbox.level;
    }
    if (sandbox.unrestricted === true) {
      return "unrestricted";
    }
    if (sandbox.read_only === true) {
      return "readonly";
    }
  }
  if (fallback !== undefined) {
    return fallback;
  }
  if (isRecord(sandbox)) {
    const mem = typeof sandbox.max_child_mem_mb === "number" ? sandbox.max_child_mem_mb : undefined;
    const timeout =
      typeof sandbox.max_exec_timeout_sec === "number" ? sandbox.max_exec_timeout_sec : undefined;
    if (mem === 0 && timeout === 0) {
      return "unrestricted";
    }
    if (mem === 1024 && timeout === 60) {
      return "readonly";
    }
    if (mem === 4096 && timeout === 90) {
      return "corp";
    }
    if (mem === 4096 && timeout === 180) {
      return "desktop";
    }
    return "personal";
  }
  return undefined;
}

function generateId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

function generateShortCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += alphabet[bytes[i]! % alphabet.length]!;
  }
  return out;
}

function parseRelayEnvSecret(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trim();
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key !== "NEO_RELAY_SECRET") continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    value = value.trim();
    if (value.length > 0) {
      return value;
    }
  }
  return null;
}

function escapeCString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "").replaceAll("\r", "");
}

function formatCByteArray(bytes: Uint8Array): string {
  const rows: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += 8) {
    const slice = bytes.subarray(i, Math.min(i + 8, bytes.byteLength));
    const parts: string[] = [];
    for (let j = 0; j < slice.byteLength; j++) {
      parts.push(`0x${slice[j]!.toString(16).padStart(2, "0")}`);
    }
    rows.push(`  ${parts.join(", ")}`);
  }
  return `{\n${rows.join(",\n")}\n}`;
}

function renderMcuConfigHeader(opts: {
  clusterId: string;
  mcuId: string;
  chip: string;
  relayDeviceId: string;
  transport: "mqtt" | "serial";
  mqttBroker: string;
  serialPort: string;
  baudRate: number;
  mcuKeyBytes: Uint8Array;
  mcuE2eKeyHex: string;
}): string {
  const topicDown = `neo/${opts.clusterId}/mcu/${opts.mcuId}/down`;
  const topicUp = `neo/${opts.clusterId}/mcu/${opts.mcuId}/up`;
  const isMqtt = opts.transport === "mqtt" ? 1 : 0;
  const isSerial = opts.transport === "serial" ? 1 : 0;

  return [
    "/* Auto-generated by Master Neo — Tier 2 MCU provisioning header */",
    "#ifndef NEO_MCU_CONFIG_H",
    "#define NEO_MCU_CONFIG_H",
    "",
    "#include <stdint.h>",
    "",
    `#define NEO_MCU_CLUSTER_ID "${escapeCString(opts.clusterId)}"`,
    `#define NEO_MCU_DEVICE_ID "${escapeCString(opts.mcuId)}"`,
    `#define NEO_MCU_CHIP "${escapeCString(opts.chip)}"`,
    `#define NEO_MCU_RELAY_NODE_ID "${escapeCString(opts.relayDeviceId)}"`,
    "",
    "#define NEO_MCU_E2E_KEY_LEN 32U",
    `#define NEO_MCU_E2E_KEY_HEX "${escapeCString(opts.mcuE2eKeyHex)}"`,
    `#define NEO_MCU_E2E_KEY_BYTES ${formatCByteArray(opts.mcuKeyBytes)}`,
    "",
    `#define NEO_MCU_TRANSPORT_MQTT ${isMqtt}`,
    `#define NEO_MCU_TRANSPORT_SERIAL ${isSerial}`,
    `#define NEO_MCU_MQTT_BROKER "${escapeCString(opts.mqttBroker)}"`,
    `#define NEO_MCU_MQTT_TOPIC_DOWN "${escapeCString(topicDown)}"`,
    `#define NEO_MCU_MQTT_TOPIC_UP "${escapeCString(topicUp)}"`,
    `#define NEO_MCU_SERIAL_PORT "${escapeCString(opts.serialPort)}"`,
    `#define NEO_MCU_SERIAL_BAUD ${opts.baudRate}U`,
    "",
    "#endif /* NEO_MCU_CONFIG_H */",
    "",
  ].join("\n");
}

function sanitizeShellArg(value: string): string {
  return value.replace(/[^A-Za-z0-9._:/-]/g, "");
}

function resolveTier1AssetName(
  manifest: CapabilityManifest | undefined,
  version: string,
): string | undefined {
  const rawOs = manifest?.os?.trim().toLowerCase();
  const rawArch = manifest?.arch?.trim().toLowerCase();
  if (!rawOs || !rawArch) return undefined;
  const osTag =
    rawOs === "linux"
      ? "linux"
      : rawOs === "macos" || rawOs === "darwin"
        ? "macos"
        : rawOs === "windows" || rawOs === "win32"
          ? "windows"
          : null;
  const archTag =
    rawArch === "x86_64" || rawArch === "amd64" || rawArch === "x64"
      ? "x64"
      : rawArch === "aarch64" || rawArch === "arm64"
        ? "arm64"
        : null;
  if (!osTag || !archTag) return undefined;
  const ext = osTag === "windows" ? "zip" : "tar.gz";
  return `neo-agent-os-${version}-${osTag}-${archTag}.${ext}`;
}

function buildManualUpgradeCommand(
  twin: DeviceTwin,
  targetVersion: string,
  relayUrl?: string,
  requestOrigin?: string,
): string {
  const base = sanitizeShellArg((relayUrl || requestOrigin || DEFAULT_RELAY_URL).replace(/\/+$/, "")) || DEFAULT_RELAY_URL;
  const ver = sanitizeShellArg(targetVersion);
  const cluster = sanitizeShellArg(twin.clusterId);
  const os = twin.manifest?.os?.trim().toLowerCase() ?? "";
  if (os === "windows" || os === "win32") {
    return `irm ${base}/install.ps1 | iex; Install-NeoAgent -Upgrade -Version "${ver}" -Cluster "${cluster}"`;
  }
  return `curl -fsSL ${base}/install.sh | bash -s -- --upgrade --version "${ver}" --cluster "${cluster}"`;
}

function renderMcuInstallScript(opts: {
  clusterId: string;
  mcuId: string;
  chip: string;
  transport: "mqtt" | "serial";
  mqttBroker: string;
  serialPort: string;
  baudRate: number;
}): string {
  const cluster = sanitizeShellArg(opts.clusterId);
  const mcuId = sanitizeShellArg(opts.mcuId);
  const chip = sanitizeShellArg(opts.chip);
  const broker = sanitizeShellArg(opts.mqttBroker);
  const serial = sanitizeShellArg(opts.serialPort);

  return `#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export NEO_MCU_CLUSTER_ID='${cluster}'
export NEO_MCU_DEVICE_ID='${mcuId}'
export NEO_MCU_CHIP='${chip}'
export NEO_MCU_TRANSPORT='${opts.transport}'
export NEO_MCU_MQTT_BROKER='${broker}'
export NEO_MCU_SERIAL_PORT='${serial}'
export NEO_MCU_SERIAL_BAUD='${opts.baudRate}'

echo "[neo-mcu-install] Provisioning \${NEO_MCU_DEVICE_ID} (chip=\${NEO_MCU_CHIP}, transport=\${NEO_MCU_TRANSPORT})"
echo "[neo-mcu-install] Config header: \${SCRIPT_DIR}/neo_mcu_config.h"

if [ -f "\${SCRIPT_DIR}/platformio.ini" ] && command -v pio >/dev/null 2>&1; then
  echo "[neo-mcu-install] Building and flashing with PlatformIO..."
  if [ "$NEO_MCU_TRANSPORT" = "serial" ] && [ -n "$NEO_MCU_SERIAL_PORT" ]; then
    exec pio run -d "$SCRIPT_DIR" -t upload --upload-port "$NEO_MCU_SERIAL_PORT"
  fi
  exec pio run -d "$SCRIPT_DIR" -t upload
fi

if [ -f "\${SCRIPT_DIR}/firmware.bin" ] && command -v esptool.py >/dev/null 2>&1; then
  echo "[neo-mcu-install] Flashing firmware.bin via esptool.py on \${NEO_MCU_SERIAL_PORT}..."
  exec esptool.py --chip "$NEO_MCU_CHIP" --port "$NEO_MCU_SERIAL_PORT" --baud "$NEO_MCU_SERIAL_BAUD" write_flash 0x1000 "\${SCRIPT_DIR}/firmware.bin"
fi

if [ -x "\${SCRIPT_DIR}/esp32_rack01_sim" ] && [ -n "\${NEO_E2E_KEY:-}" ]; then
  echo "[neo-mcu-install] Launching local MCU simulator against \${NEO_MCU_MQTT_BROKER}..."
  exec "\${SCRIPT_DIR}/esp32_rack01_sim" --broker "$NEO_MCU_MQTT_BROKER" --cluster "$NEO_MCU_CLUSTER_ID" --device-id "$NEO_MCU_DEVICE_ID" --e2e-key "$NEO_E2E_KEY" --chip "$NEO_MCU_CHIP"
fi

echo "[neo-mcu-install] Staged neo_mcu_config.h and mcu-provision.json in \${SCRIPT_DIR}."
echo "[neo-mcu-install] Include neo_mcu_config.h in your firmware project or place firmware.bin/platformio.ini here and re-run."
`;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  deviceId: string;
  transportTargetId: string;
}

export interface DeviceManagerOptions {
  store: Store;
  board?: HealthBoard;
  masterId?: string;
  tokenProvider?: () => string;
  fetchFn?: typeof fetch;
  wsFactory?: (url: string, headers: Record<string, string>) => RelaySocket;
  pingIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  localRelayEnvPath?: string;
  agentVersion?: string;
  masterVersion?: string;
  nowMs?: () => number;
}

/**
 * Manages multi-device discovery, E2E encrypted RPCs, Tier 2 MCU proxy routing,
 * Deep Sleep queues, risk approvals, zero-trust enrollment, and S3 prefix isolation.
 */
export class DeviceManager {
  private readonly store: Store;
  private readonly board?: HealthBoard;
  private readonly defaultMasterId: string;
  private readonly tokenProvider?: () => string;
  private readonly fetchFn?: typeof fetch;
  private readonly wsFactory?: (url: string, headers: Record<string, string>) => RelaySocket;
  private readonly pingIntervalMs?: number;
  private readonly reconnectBaseMs?: number;
  private readonly reconnectMaxMs?: number;
  private readonly localRelayEnvPathOverride?: string;
  private readonly agentVersion: string;
  private readonly masterVersion: string;
  private readonly enrollment: EnrollmentManager;
  private readonly fileTransfer: FileTransferManager;

  private config: DeviceConfig | null = null;
  private relayClient: RelayClient | null = null;
  private readonly pendingTier1Rpcs = new Map<string, PendingRpc>();
  private readonly pendingMcuRpcs = new Map<string, PendingRpc>();
  private readonly actionRiskOverrides = new Map<string, DeviceRiskLevel>();
  private readonly syncingSandboxDevices = new Set<string>();
  private closed = false;

  constructor(options: DeviceManagerOptions) {
    this.store = options.store;
    this.board = options.board;
    this.defaultMasterId = options.masterId ?? "master-1";
    this.tokenProvider = options.tokenProvider;
    this.fetchFn = options.fetchFn;
    this.wsFactory = options.wsFactory;
    this.pingIntervalMs = options.pingIntervalMs;
    this.reconnectBaseMs = options.reconnectBaseMs;
    this.reconnectMaxMs = options.reconnectMaxMs;
    this.localRelayEnvPathOverride = options.localRelayEnvPath;
    this.masterVersion = options.masterVersion?.trim() || VERSION;
    this.agentVersion = options.agentVersion?.trim() || process.env.NEO_AGENT_VERSION?.trim() || this.masterVersion;
    this.enrollment = new EnrollmentManager({
      store: this.store,
      getConfig: () => this.config,
      getMasterToken: () => this.getMasterToken(),
      mintToken: (opts) => this.mintToken(opts),
      getDevice: (deviceId) => this.getDevice(deviceId),
      getAgentVersion: () => this.agentVersion,
      fetchFn: this.fetchFn,
      nowMs: options.nowMs,
    });
    this.fileTransfer = new FileTransferManager({
      getConfig: () => this.config,
      getDevice: (deviceId) => this.getDevice(deviceId),
      getRelayClient: () => this.relayClient,
      invokeDevice: (deviceId, req) => this.invoke(deviceId, req),
      onLogError: (message) => this.updateBoard("error", message),
    });
  }

  private getLocalRelayEnvPath(): string {
    return (
      this.localRelayEnvPathOverride ??
      (process.env.NEO_LOCAL_RELAY_ENV?.trim() || DEFAULT_LOCAL_RELAY_ENV_PATH)
    );
  }

  private readLocalRelaySecret(): string | null {
    const envPath = this.getLocalRelayEnvPath();
    try {
      const raw = fs.readFileSync(envPath, "utf8");
      return parseRelayEnvSecret(raw);
    } catch {
      return null;
    }
  }

  private isLocalRelayDetected(): boolean {
    return this.readLocalRelaySecret() !== null;
  }

  private getMasterToken(): string {
    const cfg = this.requireConfig();
    if (this.tokenProvider) {
      return this.tokenProvider();
    }
    if (cfg.token) {
      return cfg.token;
    }
    return this.mintToken({
      nodeId: cfg.masterNodeId,
      tier: "master",
      clusterId: cfg.clusterId,
      ttlSec: cfg.tokenTtlSec ?? 3600,
    });
  }

  /**
   * Load configuration from environment variables (`NEO_CLUSTER_ID`, `NEO_RELAY_URL`,
   * `NEO_RELAY_SECRET` or `NEO_CLUSTER_SECRET`, `NEO_E2E_KEY`, `NEO_MASTER_NODE_ID`)
   * or persisted `device-config` in `Store` KV. Stays disabled/idle when unconfigured.
   */
  initFromEnv(env: Record<string, string | undefined> = process.env): DeviceConfig | null {
    const clusterId = env.NEO_CLUSTER_ID?.trim();
    const e2eKey = env.NEO_E2E_KEY?.trim();
    const relayUrl = env.NEO_RELAY_URL?.trim();
    const relaySecret = env.NEO_RELAY_SECRET?.trim();
    const clusterSecret = env.NEO_CLUSTER_SECRET?.trim();
    const token = env.NEO_RELAY_TOKEN?.trim();
    const masterNodeId = env.NEO_MASTER_NODE_ID?.trim() || `master-${this.defaultMasterId}`;

    if (clusterId && e2eKey) {
      const cfg: DeviceConfig = {
        clusterId,
        masterNodeId,
        ...(relayUrl ? { relayUrl } : {}),
        ...(relaySecret ? { relaySecret } : {}),
        ...(clusterSecret ? { clusterSecret } : {}),
        ...(token ? { token } : {}),
        e2eKey,
        enabled: true,
      };
      this.config = cfg;
      this.updateBoard("waiting", `Configured for cluster ${clusterId}`);
      return cfg;
    }

    const stored = this.store.get<DeviceConfig>(CONFIG_KEY);
    if (stored && stored.enabled && stored.clusterId && stored.e2eKey) {
      this.config = stored;
      this.updateBoard("waiting", `Loaded device config for cluster ${stored.clusterId}`);
      return stored;
    }

    this.config = null;
    this.updateBoard("waiting", "Device control plane disabled (unconfigured)");
    return null;
  }

  /** Configure or reconfigure the control plane at runtime. */
  async configure(
    input: Partial<DeviceConfig> & { clusterId: string; e2eKey: string },
    opts: { persist?: boolean; connect?: boolean } = {},
  ): Promise<DeviceConfigView> {
    if (!input.clusterId || !input.e2eKey) {
      throw new Error("clusterId and e2eKey are required");
    }
    const next: DeviceConfig = {
      clusterId: input.clusterId,
      masterNodeId: input.masterNodeId ?? this.config?.masterNodeId ?? `master-${this.defaultMasterId}`,
      ...(input.relayUrl !== undefined ? { relayUrl: input.relayUrl } : {}),
      ...(input.relaySecret !== undefined ? { relaySecret: input.relaySecret } : {}),
      ...(input.clusterSecret !== undefined ? { clusterSecret: input.clusterSecret } : {}),
      ...(input.token !== undefined ? { token: input.token } : {}),
      e2eKey: input.e2eKey,
      ...(input.tokenTtlSec !== undefined ? { tokenTtlSec: input.tokenTtlSec } : {}),
      enabled: input.enabled ?? true,
    };

    if (this.relayClient) {
      this.relayClient.close();
      this.relayClient = null;
    }
    this.config = next;
    if (opts.persist) {
      this.store.set(CONFIG_KEY, next);
    }

    if (next.enabled && next.relayUrl && opts.connect !== false) {
      await this.start();
    } else {
      this.updateBoard(
        next.enabled ? "ready" : "waiting",
        next.enabled ? `Configured cluster ${next.clusterId}` : "Device control plane disabled",
      );
    }
    return this.configView();
  }

  /**
   * Initialize or update cluster configuration with automatic defaults, optional
   * local `relay.env` auto-detection, persistence to SQLite KV, and hot relay connect.
   */
  async initOrUpdateConfig(
    input: DeviceConfigUpdateInput = {},
    opts: { connect?: boolean } = {},
  ): Promise<DeviceConfigView> {
    const existing = this.config ?? this.store.get<DeviceConfig>(CONFIG_KEY) ?? null;

    const rawClusterId =
      input.clusterId !== undefined
        ? input.clusterId.trim()
        : existing?.clusterId?.trim() ?? "";
    const clusterId = rawClusterId || `neo-${randomBytes(3).toString("hex")}`;
    if (!CLUSTER_ID_RE.test(clusterId)) {
      throw new Error(`Invalid clusterId '${clusterId}': must match ${CLUSTER_ID_RE.source}`);
    }

    const rawMasterNodeId =
      input.masterNodeId !== undefined
        ? input.masterNodeId.trim()
        : existing?.masterNodeId?.trim() ?? "";
    const masterNodeId = rawMasterNodeId || `master-${this.defaultMasterId}`;
    if (masterNodeId.length > 64) {
      throw new Error("masterNodeId must be at most 64 characters");
    }

    const rawE2eKey =
      input.e2eKey !== undefined ? input.e2eKey.trim() : existing?.e2eKey?.trim() ?? "";
    const e2eKey = rawE2eKey || randomBytes(32).toString("hex");

    let relayUrl: string | undefined;
    if (input.relayUrl !== undefined) {
      const trimmed = input.relayUrl.trim().replace(/\/+$/, "");
      relayUrl = trimmed.length > 0 ? trimmed : undefined;
    } else {
      relayUrl = existing?.relayUrl ?? DEFAULT_RELAY_URL;
    }

    let relaySecret =
      input.relaySecret !== undefined
        ? input.relaySecret.trim() || undefined
        : existing?.relaySecret;
    let clusterSecret =
      input.clusterSecret !== undefined
        ? input.clusterSecret.trim() || undefined
        : existing?.clusterSecret;
    const token =
      input.token !== undefined ? input.token.trim() || undefined : existing?.token;

    // Avoid stale shadowed secrets when switching explicitly between clusterSecret and relaySecret.
    if (input.clusterSecret !== undefined && clusterSecret && input.relaySecret === undefined) {
      relaySecret = undefined;
    } else if (input.relaySecret !== undefined && relaySecret && input.clusterSecret === undefined) {
      clusterSecret = undefined;
    }

    if (
      input.autoDetectLocalRelay !== false &&
      !clusterSecret &&
      !relaySecret &&
      !token
    ) {
      const detected = this.readLocalRelaySecret();
      if (detected) {
        relaySecret = detected;
      }
    }

    const enabled = input.enabled ?? existing?.enabled ?? true;
    const tokenTtlSec = input.tokenTtlSec ?? existing?.tokenTtlSec;

    return await this.configure(
      {
        clusterId,
        masterNodeId,
        e2eKey,
        ...(relayUrl !== undefined ? { relayUrl } : {}),
        ...(relaySecret !== undefined ? { relaySecret } : {}),
        ...(clusterSecret !== undefined ? { clusterSecret } : {}),
        ...(token !== undefined ? { token } : {}),
        ...(tokenTtlSec !== undefined ? { tokenTtlSec } : {}),
        enabled,
      },
      {
        persist: true,
        connect: opts.connect !== false,
      },
    );
  }

  /** Public, secret-free configuration summary. */
  configView(): DeviceConfigView {
    const cfg = this.config;
    const relayState = this.relayClient?.getState() ?? "idle";
    const localRelayDetected = this.isLocalRelayDetected();
    if (!cfg) {
      return {
        enabled: false,
        configured: false,
        clusterId: "",
        masterNodeId: `master-${this.defaultMasterId}`,
        hasRelaySecret: false,
        hasClusterSecret: false,
        hasToken: Boolean(this.tokenProvider),
        hasE2eKey: false,
        canMintTokens: false,
        relayState,
        localRelayDetected,
        defaultRelayUrl: DEFAULT_RELAY_URL,
        agentVersion: this.agentVersion,
        masterVersion: this.masterVersion,
      };
    }
    return {
      enabled: cfg.enabled,
      configured: true,
      clusterId: cfg.clusterId,
      masterNodeId: cfg.masterNodeId,
      ...(cfg.relayUrl ? { relayUrl: cfg.relayUrl } : {}),
      hasRelaySecret: Boolean(cfg.relaySecret),
      hasClusterSecret: Boolean(cfg.clusterSecret),
      hasToken: Boolean(cfg.token || this.tokenProvider),
      hasE2eKey: Boolean(cfg.e2eKey),
      canMintTokens: Boolean(cfg.enabled && cfg.clusterId && (cfg.relaySecret || cfg.clusterSecret)),
      relayState,
      localRelayDetected,
      defaultRelayUrl: DEFAULT_RELAY_URL,
      agentVersion: this.agentVersion,
      masterVersion: this.masterVersion,
    };
  }

  isEnabled(): boolean {
    return Boolean(this.config && this.config.enabled);
  }

  getRelayClient(): RelayClient | null {
    return this.relayClient;
  }

  /** Connect to `neo-relay` when configured and enabled; no-op when unconfigured. */
  async start(): Promise<void> {
    if (this.closed) return;
    const cfg = this.config ?? this.initFromEnv();
    if (!cfg || !cfg.enabled) {
      return;
    }
    if (!cfg.relayUrl) {
      this.updateBoard("ready", `Device control plane ready (local/manual mode, cluster ${cfg.clusterId})`);
      return;
    }
    if (!cfg.relaySecret && !cfg.clusterSecret && !cfg.token && !this.tokenProvider) {
      this.updateBoard(
        "error",
        "Relay URL configured without NEO_RELAY_SECRET, NEO_CLUSTER_SECRET, or NEO_RELAY_TOKEN",
      );
      return;
    }
    if (this.relayClient) {
      return;
    }

    const client = new RelayClient({
      relayUrl: cfg.relayUrl,
      clusterId: cfg.clusterId,
      nodeId: cfg.masterNodeId,
      tokenProvider: () => {
        if (this.tokenProvider) {
          return this.tokenProvider();
        }
        if (cfg.token) {
          return cfg.token;
        }
        return this.mintToken({
          nodeId: cfg.masterNodeId,
          tier: "master",
          clusterId: cfg.clusterId,
          ttlSec: cfg.tokenTtlSec ?? 3600,
        });
      },
      fetchFn: this.fetchFn,
      wsFactory: this.wsFactory,
      pingIntervalMs: this.pingIntervalMs,
      reconnectBaseMs: this.reconnectBaseMs,
      reconnectMaxMs: this.reconnectMaxMs,
      onFrame: (frame) => this.handleRelayFrame(frame),
      onSignal: (sig) => this.handleSignal(sig),
      onRelayError: (err) => this.handleRelayError(err),
      onStateChange: (state) => {
        if (state === "connected") {
          this.updateBoard("ready", `Connected to relay (${cfg.clusterId})`);
        } else if (state === "reconnecting") {
          this.updateBoard("waiting", "Reconnecting to relay");
        } else if (state === "closed") {
          this.updateBoard("waiting", "Relay disconnected");
        }
      },
      onLogError: (message) => {
        this.updateBoard("error", message);
      },
    });
    this.relayClient = client;
    try {
      await client.connect();
    } catch (error) {
      this.updateBoard(
        "waiting",
        `Relay initial connect pending retry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Stop the relay connection and fail any in-flight RPCs cleanly. */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fileTransfer.failAll("DeviceManager stopped");
    if (this.relayClient) {
      this.relayClient.close();
      this.relayClient = null;
    }
    this.failAllPending("DeviceManager stopped");
  }

  /** Mint a `neo1` relay auth token using the configured cluster/root secret. */
  mintToken(opts: {
    nodeId: string;
    tier: TokenTier;
    clusterId?: string;
    ttlSec?: number;
    nowSec?: number;
  }): string {
    const cfg = this.config;
    if (!cfg) {
      throw new Error("Device control plane is not configured");
    }
    const clusterId = opts.clusterId ?? cfg.clusterId;
    return mintRelayToken({
      clusterId,
      nodeId: opts.nodeId,
      tier: opts.tier,
      rootSecret: cfg.relaySecret,
      clusterSecret: cfg.clusterSecret,
      ttlSec: opts.ttlSec,
      nowSec: opts.nowSec,
    });
  }

  /** Configure custom risk classification for an action (cannot downgrade `forbidden`). */
  setActionRisk(action: string, risk: DeviceRiskLevel): void {
    if (FORBIDDEN_ACTIONS.has(action) && risk !== "forbidden") {
      throw new Error(`Action ${action} is permanently forbidden`);
    }
    this.actionRiskOverrides.set(action, risk);
  }

  /** Return all persisted Device Twins in KV, sorted by deviceId. */
  listDevices(): DeviceTwin[] {
    const keys = this.store.keys(DEVICE_KEY_PREFIX);
    const out: DeviceTwin[] = [];
    for (let i = 0; i < keys.length; i++) {
      const twin = this.store.get<DeviceTwin>(keys[i]!);
      if (twin) out.push(twin);
    }
    return out;
  }

  /** Get one Device Twin by ID. */
  getDevice(deviceId: string): DeviceTwin | null {
    return this.store.get<DeviceTwin>(`${DEVICE_KEY_PREFIX}${deviceId}`) ?? null;
  }

  /** Upsert a Device Twin in KV. */
  saveDevice(twin: DeviceTwin): DeviceTwin {
    const updated: DeviceTwin = { ...twin, updatedAt: nowIso() };
    this.store.set(`${DEVICE_KEY_PREFIX}${updated.deviceId}`, updated);
    return updated;
  }

  /** Register or update a device twin from a manifest or manual enrollment. */
  upsertDeviceManifest(
    manifest: CapabilityManifest,
    opts: {
      route?: DeviceRouteKind;
      status?: DeviceStatus;
      lanUrl?: string;
      relayNodeId?: string;
      backupRelayNodeIds?: string[];
    } = {},
  ): DeviceTwin {
    const cfg = this.requireConfig();
    const existing = this.getDevice(manifest.device_id);
    const now = nowIso();
    const normalizedManifest: CapabilityManifest = isRecord(manifest.sandbox)
      ? { ...manifest, sandbox: normalizeSandboxSummary(manifest.sandbox) }
      : manifest;
    const capabilities =
      normalizedManifest.capabilities ??
      normalizedManifest.acts ??
      (normalizedManifest.actions
        ? normalizedManifest.actions.map((a) => a.name)
        : existing?.capabilities ?? []);
    const defaultRoute: DeviceRouteKind =
      normalizedManifest.tier === "mcu" ? "via_tier1" : opts.route ?? existing?.route ?? "relay";

    let sandboxLevel: SandboxLevel | undefined;
    let desiredSandboxLevel: SandboxLevel | undefined = existing?.desiredSandboxLevel;
    let sandboxUpdatedAt: string | undefined = existing?.sandboxUpdatedAt;
    let sandboxSyncState: SandboxSyncState | undefined = existing?.sandboxSyncState;
    let sandboxSyncError: string | undefined = existing?.sandboxSyncError;

    if (normalizedManifest.tier === "os") {
      sandboxLevel = inferSandboxLevel(normalizedManifest.sandbox, existing?.sandboxLevel);
      if (existing?.desiredSandboxLevel) {
        if (sandboxLevel === existing.desiredSandboxLevel) {
          sandboxSyncState = "synced";
          sandboxSyncError = undefined;
        } else if (normalizedManifest.sandbox?.locked === true) {
          sandboxSyncState = "locked";
          sandboxSyncError = "Sandbox level is locked by local policy";
        } else {
          sandboxSyncState = existing.sandboxSyncState ?? "pending";
        }
      } else if (sandboxLevel) {
        sandboxSyncState = "synced";
        sandboxSyncError = undefined;
      }
    }

    const reportedState: Record<string, unknown> =
      normalizedManifest.tier === "os" && sandboxLevel !== undefined
        ? { ...(existing?.reportedState ?? {}), sandboxLevel }
        : existing?.reportedState ?? {};

    const twin: DeviceTwin = {
      deviceId: normalizedManifest.device_id,
      clusterId: cfg.clusterId,
      tier: normalizedManifest.tier,
      status: opts.status ?? "online",
      route: opts.route ?? existing?.route ?? defaultRoute,
      ...(opts.lanUrl !== undefined
        ? { lanUrl: opts.lanUrl }
        : existing?.lanUrl !== undefined
          ? { lanUrl: existing.lanUrl }
          : {}),
      ...(opts.relayNodeId !== undefined
        ? { relayNodeId: opts.relayNodeId }
        : existing?.relayNodeId !== undefined
          ? { relayNodeId: existing.relayNodeId }
          : {}),
      ...(opts.backupRelayNodeIds !== undefined
        ? { backupRelayNodeIds: opts.backupRelayNodeIds }
        : existing?.backupRelayNodeIds !== undefined
          ? { backupRelayNodeIds: existing.backupRelayNodeIds }
          : {}),
      alertSuppressed: false,
      manifest: normalizedManifest,
      capabilities,
      ...(sandboxLevel !== undefined ? { sandboxLevel } : {}),
      ...(desiredSandboxLevel !== undefined ? { desiredSandboxLevel } : {}),
      ...(sandboxSyncState !== undefined ? { sandboxSyncState } : {}),
      ...(sandboxSyncError !== undefined ? { sandboxSyncError } : {}),
      ...(sandboxUpdatedAt !== undefined ? { sandboxUpdatedAt } : {}),
      desiredState: existing?.desiredState ?? {},
      reportedState,
      pendingQueue: existing?.pendingQueue ?? [],
      lastSeqId: existing?.lastSeqId ?? 0,
      lastAckedSeqId: existing?.lastAckedSeqId ?? 0,
      ...(existing?.seenUplinkSeqIds ? { seenUplinkSeqIds: existing.seenUplinkSeqIds } : {}),
      lastSeenAt: now,
      lastSeenMs: Date.now(),
      updatedAt: now,
    };
    return this.saveDevice(twin);
  }

  /**
   * Configure the 5-level sandbox execution policy (`readonly | corp | personal | desktop | unrestricted`)
   * on a Tier 1 OS device via E2E `set_sandbox` RPC, persisting desired state for auto-sync on reconnect
   * when the device is offline or unreachable.
   */
  async setDeviceSandboxLevel(
    deviceId: string,
    level: SandboxLevel,
    opts: { workspaces?: string[]; timeoutMs?: number } = {},
  ): Promise<DeviceSandboxUpdateResult> {
    if (!isSandboxLevel(level)) {
      throw new Error(
        `Invalid sandbox level '${String(level)}': must be one of ${SANDBOX_LEVELS.join(", ")}`,
      );
    }
    const cfg = this.requireConfig();
    const twin = this.getDevice(deviceId);
    if (!twin) {
      throw new Error(`Unknown device: ${deviceId}`);
    }
    if (twin.clusterId !== cfg.clusterId) {
      throw new Error(`Cross-cluster device sandbox update rejected (${twin.clusterId} !== ${cfg.clusterId})`);
    }
    if (twin.tier !== "os") {
      throw new Error("Sandbox level can only be configured on Tier 1 OS devices");
    }

    let cleanedWorkspaces: string[] | undefined;
    if (opts.workspaces !== undefined) {
      if (!Array.isArray(opts.workspaces)) {
        throw new Error("workspaces must be an array of strings");
      }
      cleanedWorkspaces = opts.workspaces.map((raw) => {
        if (typeof raw !== "string") {
          throw new Error("workspaces must be an array of strings");
        }
        return validateWorkspacePath(raw);
      });
    }
    if (
      opts.timeoutMs !== undefined &&
      (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0)
    ) {
      throw new Error("timeoutMs must be a positive integer");
    }

    const updatedAt = nowIso();
    const nextDesiredState: Record<string, unknown> = {
      ...twin.desiredState,
      sandboxLevel: level,
    };
    if (cleanedWorkspaces && cleanedWorkspaces.length > 0) {
      nextDesiredState.sandboxWorkspaces = cleanedWorkspaces;
    } else {
      delete nextDesiredState.sandboxWorkspaces;
    }

    const { sandboxSyncError: _clearedErr, ...twinBase } = twin;
    const canReach =
      twin.status !== "offline" &&
      ((twin.route === "lan" && Boolean(twin.lanUrl)) ||
        Boolean(this.relayClient?.isRelayConnected()));

    const staged = this.saveDevice({
      ...twinBase,
      desiredSandboxLevel: level,
      desiredState: nextDesiredState,
      sandboxSyncState: "pending",
      sandboxUpdatedAt: updatedAt,
    });

    if (!canReach) {
      return {
        device: staged,
        level,
        applied: false,
        pending: true,
        warning: "Device is offline; sandbox level will apply automatically when it reconnects.",
      };
    }

    const rpcParams: Record<string, unknown> = {
      level,
      ...(cleanedWorkspaces && cleanedWorkspaces.length > 0
        ? { workspaces: cleanedWorkspaces }
        : {}),
    };
    const rpcRes = await this.dispatchTier1Rpc(staged, {
      action: "set_sandbox",
      params: rpcParams,
      timeoutMs: opts.timeoutMs ?? 15_000,
    });

    const latest = this.getDevice(deviceId) ?? staged;

    if (rpcRes.status === "ok") {
      const resObj = isRecord(rpcRes.result) ? rpcRes.result : {};
      const persisted = typeof resObj.persisted === "boolean" ? resObj.persisted : undefined;
      const warning =
        typeof resObj.warning === "string" && resObj.warning.trim().length > 0
          ? resObj.warning.trim()
          : typeof resObj.persist_warning === "string" && resObj.persist_warning.trim().length > 0
            ? resObj.persist_warning.trim()
            : undefined;

      let nextManifest = latest.manifest;
      if (isRecord(resObj.manifest)) {
        const m = resObj.manifest;
        const rawSandbox = isRecord(m.sandbox)
          ? normalizeSandboxSummary(m.sandbox)
          : isRecord(resObj.sandbox)
            ? normalizeSandboxSummary(resObj.sandbox)
            : nextManifest?.sandbox;
        const mergedSandbox: SandboxSummary | undefined = rawSandbox
          ? { ...rawSandbox, level: rawSandbox.level ?? level }
          : undefined;
        nextManifest = {
          ...(nextManifest ?? { device_id: latest.deviceId, tier: latest.tier }),
          ...(typeof m.device_id === "string" ? { device_id: m.device_id } : {}),
          tier: m.tier === "mcu" ? "mcu" : "os",
          ...(typeof m.os === "string" ? { os: m.os } : {}),
          ...(typeof m.arch === "string" ? { arch: m.arch } : {}),
          ...(typeof m.hostname === "string" ? { hostname: m.hostname } : {}),
          ...(typeof m.cpus === "number" ? { cpus: m.cpus } : {}),
          ...(typeof m.ram_mb === "number" ? { ram_mb: m.ram_mb } : {}),
          ...(Array.isArray(m.capabilities)
            ? { capabilities: m.capabilities.filter((c): c is string => typeof c === "string") }
            : {}),
          ...(Array.isArray(m.actions) ? { actions: m.actions as CapabilityManifest["actions"] } : {}),
          ...(isRecord(m.relay_config)
            ? { relay_config: m.relay_config as CapabilityManifest["relay_config"] }
            : {}),
          ...(mergedSandbox ? { sandbox: mergedSandbox } : {}),
        };
      } else if (isRecord(resObj.sandbox)) {
        const normalizedSandbox = normalizeSandboxSummary(resObj.sandbox);
        if (normalizedSandbox.level === undefined) {
          normalizedSandbox.level = level;
        }
        nextManifest = {
          ...(nextManifest ?? { device_id: latest.deviceId, tier: latest.tier }),
          sandbox: normalizedSandbox,
        };
      } else if (nextManifest) {
        nextManifest = {
          ...nextManifest,
          sandbox: {
            ...(nextManifest.sandbox ?? {}),
            level,
            unrestricted: level === "unrestricted",
            read_only: level === "readonly",
            ...(cleanedWorkspaces && cleanedWorkspaces.length > 0
              ? { allowed_workspaces: cleanedWorkspaces }
              : {}),
          },
        };
      }

      const { sandboxSyncError: _dropErr, ...latestBase } = latest;
      const nextCapabilities =
        nextManifest?.capabilities ??
        nextManifest?.acts ??
        (nextManifest?.actions ? nextManifest.actions.map((a) => a.name) : latest.capabilities);
      const saved = this.saveDevice({
        ...latestBase,
        ...(nextManifest ? { manifest: nextManifest } : {}),
        capabilities: nextCapabilities,
        sandboxLevel: level,
        desiredSandboxLevel: level,
        sandboxSyncState: "synced",
        sandboxUpdatedAt: nowIso(),
        reportedState: {
          ...latest.reportedState,
          sandboxLevel: level,
        },
      });

      return {
        device: saved,
        level,
        applied: true,
        pending: false,
        ...(persisted !== undefined ? { persisted } : {}),
        ...(warning !== undefined ? { warning } : {}),
      };
    }

    const err = rpcRes.status === "rejected" ? rpcRes.error : `Unexpected RPC status: ${rpcRes.status}`;
    if (/unsupported RPC method/i.test(err)) {
      const saved = this.saveDevice({
        ...latest,
        desiredSandboxLevel: level,
        sandboxSyncState: "unsupported",
        sandboxSyncError: err,
        sandboxUpdatedAt: nowIso(),
      });
      return {
        device: saved,
        level,
        applied: false,
        pending: true,
        error: err,
        warning:
          "Remote neo-agent-os does not support live sandbox switching yet; upgrade neo-agent-os to sync automatically.",
      };
    }

    if (/locked/i.test(err)) {
      const { desiredSandboxLevel: _oldDesired, ...latestWithoutDesired } = latest;
      const revertedDesiredState: Record<string, unknown> = { ...latest.desiredState };
      if (latest.sandboxLevel !== undefined) {
        revertedDesiredState.sandboxLevel = latest.sandboxLevel;
      } else {
        delete revertedDesiredState.sandboxLevel;
      }
      delete revertedDesiredState.sandboxWorkspaces;
      const saved = this.saveDevice({
        ...latestWithoutDesired,
        ...(latest.sandboxLevel !== undefined ? { desiredSandboxLevel: latest.sandboxLevel } : {}),
        desiredState: revertedDesiredState,
        sandboxSyncState: "locked",
        sandboxSyncError: err,
        sandboxUpdatedAt: nowIso(),
      });
      return {
        device: saved,
        level,
        applied: false,
        pending: false,
        error: err,
      };
    }

    const saved = this.saveDevice({
      ...latest,
      desiredSandboxLevel: level,
      sandboxSyncState: "pending",
      sandboxSyncError: err,
      sandboxUpdatedAt: nowIso(),
    });
    return {
      device: saved,
      level,
      applied: false,
      pending: true,
      error: err,
    };
  }

  private async syncDesiredSandbox(deviceId: string): Promise<void> {
    if (this.closed || this.syncingSandboxDevices.has(deviceId)) {
      return;
    }
    const twin = this.getDevice(deviceId);
    if (
      !twin ||
      twin.tier !== "os" ||
      twin.status !== "online" ||
      !twin.desiredSandboxLevel ||
      twin.sandboxLevel === twin.desiredSandboxLevel ||
      twin.manifest?.sandbox?.locked === true ||
      twin.sandboxSyncState !== "pending"
    ) {
      return;
    }

    const desiredLevel = twin.desiredSandboxLevel;
    const rawWorkspaces = twin.desiredState?.sandboxWorkspaces;
    const workspaces =
      Array.isArray(rawWorkspaces) && rawWorkspaces.every((w): w is string => typeof w === "string")
        ? rawWorkspaces
        : undefined;

    this.syncingSandboxDevices.add(deviceId);
    try {
      await this.setDeviceSandboxLevel(deviceId, desiredLevel, {
        ...(workspaces && workspaces.length > 0 ? { workspaces } : {}),
      });
    } catch {
      // Best-effort background sync; twin stays pending for the next reconnect.
    } finally {
      this.syncingSandboxDevices.delete(deviceId);
    }
  }

  /** Update a device's route dynamically (`lan | p2p | relay | via_tier1`). */
  setDeviceRoute(deviceId: string, route: DeviceRouteKind, lanUrl?: string): DeviceTwin {
    const twin = this.getDevice(deviceId);
    if (!twin) {
      throw new Error(`Unknown device: ${deviceId}`);
    }
    const next: DeviceTwin = {
      ...twin,
      route,
      ...(lanUrl !== undefined ? { lanUrl } : {}),
    };
    return this.saveDevice(next);
  }

  /** Put a Tier 2 MCU into or out of Deep Sleep mode (queued commands flush on wake). */
  setDeviceStatus(deviceId: string, status: DeviceStatus): DeviceTwin {
    const twin = this.getDevice(deviceId);
    if (!twin) {
      throw new Error(`Unknown device: ${deviceId}`);
    }
    const next = this.saveDevice({
      ...twin,
      status,
      ...(status === "online" ? { alertSuppressed: false } : {}),
    });
    if (status === "online" && next.tier === "mcu" && next.pendingQueue.length > 0) {
      void this.flushPendingQueue(deviceId);
    }
    return next;
  }

  /** Remove a device twin from the cluster store and fail any in-flight RPCs targeting it. */
  removeDevice(deviceId: string): boolean {
    const existing = this.getDevice(deviceId);
    if (!existing) {
      return false;
    }
    this.store.delete(`${DEVICE_KEY_PREFIX}${deviceId}`);
    this.fileTransfer.failForPeer(deviceId, `Device ${deviceId} removed`);
    this.rejectWaitersForTransport(deviceId, `Device ${deviceId} removed`);

    if (existing.tier === "os") {
      const all = this.listDevices();
      for (let i = 0; i < all.length; i++) {
        const mcu = all[i]!;
        if (mcu.tier !== "mcu" || mcu.relayNodeId !== deviceId) continue;
        const backupId = this.findOnlineBackupRelay(mcu, deviceId);
        if (backupId !== null) {
          this.saveDevice({
            ...mcu,
            relayNodeId: backupId,
            status: mcu.status === "unreachable_via_relay" ? "online" : mcu.status,
            alertSuppressed: false,
          });
        } else {
          this.saveDevice({
            ...mcu,
            status: "unreachable_via_relay",
            alertSuppressed: true,
          });
        }
      }
    }
    return true;
  }

  /** Probe live connectivity and latency to a paired device via lightweight RPC or relay check. */
  async pingDevice(deviceId: string): Promise<DevicePingResult> {
    const startedAt = Date.now();
    const twin = this.getDevice(deviceId);
    if (!twin) {
      return {
        ok: false,
        deviceId,
        latencyMs: 0,
        status: "offline",
        route: "relay",
        error: `Unknown device: ${deviceId}`,
      };
    }

    if (twin.status === "offline" || twin.status === "unreachable_via_relay") {
      return {
        ok: false,
        deviceId,
        latencyMs: Date.now() - startedAt,
        status: twin.status,
        route: twin.route,
        error: `Device ${deviceId} is ${twin.status}`,
      };
    }

    if (twin.tier === "os") {
      const canProbe =
        (twin.route === "lan" && Boolean(twin.lanUrl)) ||
        Boolean(this.relayClient?.isRelayConnected());
      if (!canProbe) {
        return {
          ok: false,
          deviceId,
          latencyMs: Date.now() - startedAt,
          status: twin.status,
          route: twin.route,
          error: "Relay client is not connected",
        };
      }
      const res = await this.dispatchTier1Rpc(twin, {
        action: "fs_list",
        params: {},
        timeoutMs: 5_000,
      });
      const latencyMs = Date.now() - startedAt;
      const latest = this.getDevice(deviceId) ?? twin;
      if (res.status === "ok") {
        this.saveDevice({
          ...latest,
          status: "online",
          alertSuppressed: false,
          lastSeenAt: nowIso(),
          lastSeenMs: Date.now(),
        });
        return {
          ok: true,
          deviceId,
          latencyMs,
          status: "online",
          route: latest.route,
        };
      }
      return {
        ok: false,
        deviceId,
        latencyMs,
        status: latest.status,
        route: latest.route,
        error: res.status === "rejected" ? res.error : "Ping failed",
      };
    }

    // Tier 2 MCU: check parent Tier 1 relay path.
    const relayNodeId = this.resolveOnlineRelayForMcu(twin);
    if (!relayNodeId) {
      return {
        ok: false,
        deviceId,
        latencyMs: Date.now() - startedAt,
        status: "unreachable_via_relay",
        route: twin.route,
        error: `MCU ${deviceId} has no online Tier 1 relay`,
      };
    }
    if (twin.status === "sleeping") {
      return {
        ok: true,
        deviceId,
        latencyMs: Date.now() - startedAt,
        status: "sleeping",
        route: twin.route,
      };
    }
    const parentPing = await this.pingDevice(relayNodeId);
    return {
      ok: parentPing.ok,
      deviceId,
      latencyMs: Date.now() - startedAt,
      status: twin.status,
      route: twin.route,
      ...(parentPing.ok ? {} : { error: parentPing.error ?? `Parent relay ${relayNodeId} unreachable` }),
    };
  }

  /**
   * Remotely update a paired Tier 1 OS agent or Tier 2 MCU to the Master Neo target version.
   * - Tier 1 (`os`): dispatches E2E encrypted `self_update` RPC (mirror download, SHA-256 verify,
   *   atomic swap + rollback metadata, and clean in-place restart). If the remote agent predates
   *   `self_update` RPC, returns `manual_upgrade_required` with a ready-to-run upgrade command.
   * - Tier 2 (`mcu`): dispatches signed CBOR `ota_apply`/`ota_update` downlink command when
   *   supported (queuing in Deep Sleep shadow when sleeping), or stages `mcu-update.json` onto
   *   the online parent Tier 1 relay workspace.
   */
  async updateDevice(
    deviceId: string,
    input: DeviceUpdateInput = {},
    opts: { requestOrigin?: string } = {},
  ): Promise<DeviceUpdateResult> {
    const cfg = this.requireConfig();
    const twin = this.getDevice(deviceId);
    if (!twin) {
      throw new Error(`Unknown device: ${deviceId}`);
    }
    if (twin.clusterId !== cfg.clusterId) {
      return {
        ok: false,
        status: "failed",
        deviceId,
        tier: twin.tier,
        targetVersion: this.masterVersion,
        message: `Cross-cluster device update rejected (${twin.clusterId} !== ${cfg.clusterId})`,
        error: `Cross-cluster device update rejected (${twin.clusterId} !== ${cfg.clusterId})`,
      };
    }

    // Automatic remote updates MUST strictly match Master Neo's version and never exceed it.
    const masterVer = this.masterVersion.replace(/^[vV]/, "");
    const rawTarget = (input.targetVersion?.trim() || masterVer).replace(/^[vV]/, "");
    if (!SEMVER_VERSION_RE.test(rawTarget)) {
      throw new Error(`Invalid targetVersion '${rawTarget}': expected semver (e.g. ${masterVer})`);
    }
    const cmpToMaster = compareSemver(rawTarget, masterVer);
    if (cmpToMaster === null || cmpToMaster > 0) {
      throw new Error(
        `Target update version v${rawTarget} exceeds Master Neo version v${masterVer}; automatic updates must match Master Neo version and never exceed it`,
      );
    }
    if (cmpToMaster !== 0) {
      throw new Error(
        `Target update version v${rawTarget} must match Master Neo version v${masterVer}`,
      );
    }
    const targetVersion = masterVer;

    const currentVersion =
      twin.tier === "mcu"
        ? (twin.manifest?.fw?.trim() || twin.manifest?.version?.trim() || undefined)
        : (twin.manifest?.version?.trim() ||
          (typeof twin.reportedState.version === "string" && twin.reportedState.version.trim().length > 0
            ? twin.reportedState.version.trim()
            : undefined));

    if (!input.force && currentVersion && !isVersionOlder(currentVersion, targetVersion)) {
      return {
        ok: true,
        status: "up_to_date",
        deviceId,
        tier: twin.tier,
        currentVersion,
        targetVersion,
        message: `Device ${deviceId} is already on v${currentVersion} (target v${targetVersion})`,
      };
    }

    if (twin.tier === "os") {
      if (twin.status === "offline") {
        const error = `Device ${deviceId} is offline`;
        return {
          ok: false,
          status: "failed",
          deviceId,
          tier: "os",
          ...(currentVersion ? { currentVersion } : {}),
          targetVersion,
          message: error,
          error,
        };
      }

      const canSend =
        (twin.route === "lan" && Boolean(twin.lanUrl)) ||
        Boolean(this.relayClient?.isRelayConnected());
      if (!canSend) {
        const error = "Relay client is not connected";
        return {
          ok: false,
          status: "failed",
          deviceId,
          tier: "os",
          ...(currentVersion ? { currentVersion } : {}),
          targetVersion,
          message: error,
          error,
        };
      }

      const relayBase = cfg.relayUrl ? cfg.relayUrl.replace(/\/+$/, "") : "";
      const mirrors =
        input.downloadMirrors && input.downloadMirrors.length > 0
          ? input.downloadMirrors
          : relayBase
            ? [`${relayBase}/dl/v${targetVersion}`, `${GITHUB_RELEASE_BASE}/v${targetVersion}`]
            : [`${GITHUB_RELEASE_BASE}/v${targetVersion}`];
      const asset = resolveTier1AssetName(twin.manifest, targetVersion);

      const rpcRes = await this.dispatchTier1Rpc(twin, {
        action: "self_update",
        params: {
          target_version: targetVersion,
          master_version: targetVersion,
          mirrors,
          ...(asset ? { asset } : {}),
          ...(input.sha256 ? { sha256: input.sha256 } : {}),
          ...(input.force ? { force: true } : {}),
        },
        timeoutMs: input.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS,
      });

      if (rpcRes.status === "ok") {
        const body = isRecord(rpcRes.result) ? rpcRes.result : {};
        const rpcStatus = body.status === "up_to_date" ? "up_to_date" : "restarting";
        const installedPath =
          typeof body.installed_path === "string" && body.installed_path.length > 0
            ? body.installed_path
            : undefined;
        const sha256 =
          typeof body.sha256 === "string" && body.sha256.length > 0 ? body.sha256 : undefined;
        const mirror =
          typeof body.mirror === "string" && body.mirror.length > 0 ? body.mirror : undefined;
        const latest = this.getDevice(deviceId) ?? twin;
        this.saveDevice({
          ...latest,
          reportedState: {
            ...latest.reportedState,
            lastUpdate: {
              status: rpcStatus,
              fromVersion: currentVersion ?? null,
              targetVersion,
              at: nowIso(),
            },
          },
        });
        return {
          ok: true,
          status: rpcStatus,
          deviceId,
          tier: "os",
          ...(currentVersion ? { currentVersion } : {}),
          targetVersion,
          message:
            rpcStatus === "up_to_date"
              ? `Device ${deviceId} is already on v${targetVersion}`
              : `Triggered remote update to v${targetVersion}; awaiting agent reconnect`,
          ...(installedPath ? { installedPath } : {}),
          ...(sha256 ? { sha256 } : {}),
          ...(mirror ? { mirror } : {}),
        };
      }

      const error = rpcRes.status === "rejected" ? rpcRes.error : "Remote update failed";
      if (error.includes("unsupported RPC method")) {
        const upgradeCommand = buildManualUpgradeCommand(
          twin,
          targetVersion,
          cfg.relayUrl,
          opts.requestOrigin,
        );
        return {
          ok: false,
          status: "manual_upgrade_required",
          deviceId,
          tier: "os",
          ...(currentVersion ? { currentVersion } : {}),
          targetVersion,
          message:
            "Remote agent predates self_update RPC; run the upgrade command once on the device to enable one-click updates.",
          error,
          upgradeCommand,
        };
      }

      return {
        ok: false,
        status: "failed",
        deviceId,
        tier: "os",
        ...(currentVersion ? { currentVersion } : {}),
        targetVersion,
        message: error,
        error,
      };
    }

    // Tier 2 MCU remote update
    const acts = new Set<string>([...twin.capabilities, ...(twin.manifest?.acts ?? [])]);
    const otaAction = acts.has("ota_apply")
      ? "ota_apply"
      : acts.has("ota_update")
        ? "ota_update"
        : null;

    if (otaAction !== null) {
      const mcuRes = await this.dispatchMcuCommand(twin, {
        action: otaAction,
        params: { version: targetVersion, master_version: targetVersion },
        timeoutMs: input.timeoutMs ?? 60_000,
      });
      if (mcuRes.status === "ok") {
        const latest = this.getDevice(deviceId) ?? twin;
        const resData = isRecord(mcuRes.result) ? mcuRes.result : {};
        const reportedFw =
          typeof resData.fw === "string" && resData.fw.trim().length > 0
            ? resData.fw.trim()
            : undefined;
        if (reportedFw && latest.manifest) {
          this.saveDevice({
            ...latest,
            manifest: { ...latest.manifest, fw: reportedFw },
          });
        }
        return {
          ok: true,
          status: "updated",
          deviceId,
          tier: "mcu",
          ...(currentVersion ? { currentVersion } : {}),
          targetVersion,
          ...(mcuRes.seqId !== undefined ? { seqId: mcuRes.seqId } : {}),
          message: `Dispatched ${otaAction} to MCU ${deviceId} (target v${targetVersion})`,
        };
      }
      if (mcuRes.status === "queued") {
        return {
          ok: true,
          status: "queued",
          deviceId,
          tier: "mcu",
          ...(currentVersion ? { currentVersion } : {}),
          targetVersion,
          seqId: mcuRes.seqId,
          message: mcuRes.reason,
        };
      }
      const error = mcuRes.status === "rejected" ? mcuRes.error : "MCU update failed";
      return {
        ok: false,
        status: "failed",
        deviceId,
        tier: "mcu",
        ...(currentVersion ? { currentVersion } : {}),
        targetVersion,
        message: error,
        error,
      };
    }

    const relayNodeId = this.resolveOnlineRelayForMcu(twin);
    if (!relayNodeId) {
      const error = `MCU ${deviceId} is unreachable_via_relay (no online Tier 1 relay)`;
      return {
        ok: false,
        status: "failed",
        deviceId,
        tier: "mcu",
        ...(currentVersion ? { currentVersion } : {}),
        targetVersion,
        message: error,
        error,
      };
    }
    const relayTwin = this.getDevice(relayNodeId);
    if (!relayTwin) {
      const error = `Parent Tier 1 relay ${relayNodeId} not found`;
      return {
        ok: false,
        status: "failed",
        deviceId,
        tier: "mcu",
        ...(currentVersion ? { currentVersion } : {}),
        targetVersion,
        message: error,
        error,
      };
    }

    const updateDescriptor = JSON.stringify(
      {
        cluster_id: cfg.clusterId,
        mcu_id: deviceId,
        chip: twin.manifest?.chip ?? "esp32",
        current_fw: currentVersion ?? null,
        target_version: targetVersion,
        master_version: targetVersion,
        requested_at: nowIso(),
      },
      null,
      2,
    );
    const descriptorPath = `neo-mcu/${deviceId}/mcu-update.json`;
    const stageRes = await this.dispatchTier1Rpc(relayTwin, {
      action: "fs_write",
      params: { path: descriptorPath, content: updateDescriptor },
      timeoutMs: 15_000,
    });
    if (stageRes.status !== "ok") {
      const error =
        stageRes.status === "rejected"
          ? `Failed to stage MCU update on ${relayNodeId}: ${stageRes.error}`
          : `Failed to stage MCU update on ${relayNodeId}`;
      return {
        ok: false,
        status: "failed",
        deviceId,
        tier: "mcu",
        ...(currentVersion ? { currentVersion } : {}),
        targetVersion,
        message: error,
        error,
      };
    }
    return {
      ok: true,
      status: "staged",
      deviceId,
      tier: "mcu",
      ...(currentVersion ? { currentVersion } : {}),
      targetVersion,
      installedPath: `${relayNodeId}:${descriptorPath}`,
      message: `Staged v${targetVersion} MCU update descriptor on ${relayNodeId}:${descriptorPath}`,
    };
  }

  /** Create a new zero-trust agent enrollment ticket and return platform install commands. */
  async createEnrollment(
    input: EnrollmentCreateInput = {},
    opts: { requestOrigin?: string } = {},
  ): Promise<EnrollmentView> {
    return await this.enrollment.createEnrollment(input, opts);
  }

  /** Get one enrollment record, optionally syncing live claim status from `neo-relayd`. */
  async getEnrollment(
    id: string,
    opts: { syncRelay?: boolean } = {},
  ): Promise<EnrollmentView | null> {
    return await this.enrollment.getEnrollment(id, opts);
  }

  /** List all persisted enrollment records, newest first. */
  listEnrollments(): EnrollmentView[] {
    return this.enrollment.listEnrollments();
  }

  /** Revoke an enrollment ticket immediately (best-effort relay delete or direct parcel burn). */
  async revokeEnrollment(id: string): Promise<EnrollmentView> {
    return await this.enrollment.revokeEnrollment(id);
  }

  /** Claim a Master Direct Mode enrollment parcel (`POST /enroll/claim/:id`). */
  claimDirectEnrollment(ticketId: string, clientIp: string): DirectClaimResult {
    return this.enrollment.claimDirectEnrollment(ticketId, clientIp);
  }

  /**
   * Master-driven Tier 2 MCU installation via a paired Tier 1 `neo-agent-os` gateway (MQTT or Serial):
   * - Derives the 32-byte cluster MCU E2E key and renders `neo_mcu_config.h`, `mcu-provision.json`, and `install-mcu.sh`.
   * - Pre-registers or updates the Tier 2 MCU `DeviceTwin` bound to `relayDeviceId`.
   * - When `autoDeploy !== false` and the Tier 1 gateway is online, pushes the files directly onto Tier 1 via encrypted `fs_write` RPC.
   */
  async installMcuViaTier1(input: McuInstallInput): Promise<McuInstallResult> {
    const cfg = this.requireConfig();
    if (!cfg.enabled) {
      throw new Error("Device control plane is not enabled");
    }

    const mcuId = typeof input.mcuId === "string" ? input.mcuId.trim() : "";
    if (!MCU_ID_RE.test(mcuId)) {
      throw new Error(`Invalid mcuId '${mcuId}': must match ${MCU_ID_RE.source}`);
    }
    const relayDeviceId =
      typeof input.relayDeviceId === "string" ? input.relayDeviceId.trim() : "";
    if (!relayDeviceId) {
      throw new Error("relayDeviceId is required");
    }
    if (input.transport !== "mqtt" && input.transport !== "serial") {
      throw new Error("transport must be 'mqtt' or 'serial'");
    }
    const baudRate = input.baudRate ?? 115200;
    if (!Number.isInteger(baudRate) || baudRate < 1200 || baudRate > 4_000_000) {
      throw new Error("baudRate must be an integer between 1200 and 4000000");
    }
    const chip = (input.chip?.trim() || "esp32");
    if (!CHIP_RE.test(chip)) {
      throw new Error(`Invalid chip '${chip}': must match ${CHIP_RE.source}`);
    }

    const tier1 = this.getDevice(relayDeviceId);
    const mqttBroker =
      input.mqttBroker?.trim() ||
      tier1?.manifest?.relay_config?.mqtt_bind?.trim() ||
      "127.0.0.1:1883";
    const serialPort =
      input.serialPort?.trim() ||
      tier1?.manifest?.relay_config?.uart_device?.trim() ||
      "/dev/ttyUSB0";
    const backupRelayDeviceIds = Array.isArray(input.backupRelayDeviceIds)
      ? Array.from(
          new Set(
            input.backupRelayDeviceIds
              .map((id) => (typeof id === "string" ? id.trim() : ""))
              .filter((id) => id.length > 0 && id !== relayDeviceId),
          ),
        )
      : undefined;

    const mcuKeyBytes = deriveMcuE2eKey(cfg.clusterId, cfg.e2eKey);
    const mcuE2eKeyHex = Buffer.from(mcuKeyBytes).toString("hex");
    const topicDown = `neo/${cfg.clusterId}/mcu/${mcuId}/down`;
    const topicUp = `neo/${cfg.clusterId}/mcu/${mcuId}/up`;

    const configHeader = renderMcuConfigHeader({
      clusterId: cfg.clusterId,
      mcuId,
      chip,
      relayDeviceId,
      transport: input.transport,
      mqttBroker,
      serialPort,
      baudRate,
      mcuKeyBytes,
      mcuE2eKeyHex,
    });

    const provisionJson = JSON.stringify(
      {
        cluster_id: cfg.clusterId,
        mcu_id: mcuId,
        chip,
        relay_device_id: relayDeviceId,
        backup_relay_device_ids: backupRelayDeviceIds ?? [],
        transport: input.transport,
        mqtt_broker: mqttBroker,
        mqtt_topic_down: topicDown,
        mqtt_topic_up: topicUp,
        serial_port: serialPort,
        baud_rate: baudRate,
        mcu_e2e_key_hex: mcuE2eKeyHex,
        generated_at: nowIso(),
      },
      null,
      2,
    );

    const installScript = renderMcuInstallScript({
      clusterId: cfg.clusterId,
      mcuId,
      chip,
      transport: input.transport,
      mqttBroker,
      serialPort,
      baudRate,
    });

    const existingMcu = this.getDevice(mcuId);
    const preRegistered = this.upsertDeviceManifest(
      {
        device_id: mcuId,
        tier: "mcu",
        chip,
        acts: existingMcu?.manifest?.acts ?? [],
        capabilities: existingMcu?.capabilities ?? [],
      },
      {
        route: "via_tier1",
        status: "sleeping",
        relayNodeId: relayDeviceId,
        ...(backupRelayDeviceIds !== undefined ? { backupRelayNodeIds: backupRelayDeviceIds } : {}),
      },
    );
    const twin = this.saveDevice({
      ...preRegistered,
      reportedState: {
        ...preRegistered.reportedState,
        transport: input.transport,
        mqttBroker,
        serialPort,
        baudRate,
      },
    });

    const workspaceDir = `neo-mcu/${mcuId}`;
    const autoDeploy = input.autoDeploy !== false;

    if (!autoDeploy) {
      return {
        twin,
        deployed: false,
        deployMethod: "staged_manual",
        deployDetail: "autoDeploy disabled; MCU twin pre-registered with manual provisioning bundle",
        workspaceDir,
        configHeader,
        installScript,
        mcuE2eKeyHex,
      };
    }

    if (!tier1) {
      return {
        twin,
        deployed: false,
        deployMethod: "staged_manual",
        deployDetail: `Tier 1 relay device '${relayDeviceId}' not found; MCU twin pre-registered for later deployment`,
        workspaceDir,
        configHeader,
        installScript,
        mcuE2eKeyHex,
      };
    }

    if (tier1.tier !== "os") {
      return {
        twin,
        deployed: false,
        deployMethod: "staged_manual",
        deployDetail: `Device '${relayDeviceId}' is tier '${tier1.tier}', expected Tier 1 'os' relay`,
        workspaceDir,
        configHeader,
        installScript,
        mcuE2eKeyHex,
      };
    }

    if (tier1.status !== "online") {
      return {
        twin,
        deployed: false,
        deployMethod: "staged_manual",
        deployDetail: `Tier 1 relay device '${relayDeviceId}' is ${tier1.status}; MCU twin pre-registered`,
        workspaceDir,
        configHeader,
        installScript,
        mcuE2eKeyHex,
      };
    }

    const canSend =
      Boolean(this.relayClient?.isRelayConnected()) ||
      (tier1.route === "lan" && Boolean(tier1.lanUrl));
    if (!canSend) {
      return {
        twin,
        deployed: false,
        deployMethod: "staged_manual",
        deployDetail: "Relay client is not connected; MCU twin pre-registered",
        workspaceDir,
        configHeader,
        installScript,
        mcuE2eKeyHex,
      };
    }

    const files: Array<{ path: string; content: string }> = [
      { path: `${workspaceDir}/neo_mcu_config.h`, content: configHeader },
      { path: `${workspaceDir}/mcu-provision.json`, content: provisionJson },
      { path: `${workspaceDir}/install-mcu.sh`, content: installScript },
    ];

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const rpcRes = await this.dispatchTier1Rpc(tier1, {
          action: "fs_write",
          params: { path: file.path, content: file.content },
          timeoutMs: 15_000,
        });
        if (rpcRes.status !== "ok") {
          const reason = rpcRes.status === "rejected" ? rpcRes.error : `unexpected RPC status ${rpcRes.status}`;
          return {
            twin,
            deployed: false,
            deployMethod: "staged_manual",
            deployDetail: `Tier 1 fs_write failed for ${file.path}: ${reason}`,
            workspaceDir,
            configHeader,
            installScript,
            mcuE2eKeyHex,
          };
        }
      }
      return {
        twin,
        deployed: true,
        deployMethod: "tier1_rpc",
        deployDetail: `Pushed neo_mcu_config.h, mcu-provision.json, and install-mcu.sh to ${relayDeviceId}:${workspaceDir}`,
        workspaceDir,
        configHeader,
        installScript,
        mcuE2eKeyHex,
      };
    } catch (error) {
      return {
        twin,
        deployed: false,
        deployMethod: "staged_manual",
        deployDetail: `Tier 1 RPC error: ${error instanceof Error ? error.message : String(error)}`,
        workspaceDir,
        configHeader,
        installScript,
        mcuE2eKeyHex,
      };
    }
  }

  /** List pending/decided approvals, newest first. */
  listApprovals(statusFilter?: PendingApproval["status"]): PendingApproval[] {
    const keys = this.store.keys(APPROVAL_KEY_PREFIX);
    const out: PendingApproval[] = [];
    for (let i = 0; i < keys.length; i++) {
      const item = this.store.get<PendingApproval>(keys[i]!);
      if (item && (!statusFilter || item.status === statusFilter)) {
        out.push(item);
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out;
  }

  /** Look up an approval by full `id` or `shortCode` (case-insensitive). */
  getApproval(idOrShortCode: string): PendingApproval | null {
    const direct = this.store.get<PendingApproval>(`${APPROVAL_KEY_PREFIX}${idOrShortCode}`);
    if (direct) return direct;
    const upper = idOrShortCode.trim().toUpperCase();
    const keys = this.store.keys(APPROVAL_KEY_PREFIX);
    for (let i = 0; i < keys.length; i++) {
      const item = this.store.get<PendingApproval>(keys[i]!);
      if (item && item.shortCode.toUpperCase() === upper) {
        return item;
      }
    }
    return null;
  }

  /** Classify the risk level of an action for a given device. */
  classifyRisk(twin: DeviceTwin, action: string, riskOverride?: DeviceRiskLevel): DeviceRiskLevel {
    if (FORBIDDEN_ACTIONS.has(action)) {
      return "forbidden";
    }
    const spec = twin.manifest?.actions?.find((a) => a.name === action);
    if (spec?.risk === "forbidden") {
      return "forbidden";
    }
    const localOverride = this.actionRiskOverrides.get(action);
    if (localOverride !== undefined) {
      return localOverride;
    }
    if (spec?.risk !== undefined) {
      return spec.risk;
    }
    if (riskOverride !== undefined) {
      return riskOverride;
    }
    if (DEFAULT_CONFIRM_ACTIONS.has(action)) {
      return "confirm_required";
    }
    return "safe_auto";
  }

  /** Validate an S3 artifact URI against the local cluster prefix `s3://neo-artifacts/<cluster_id>/<task_id>/...`. */
  validateArtifactUri(uri: string, expectedTaskId?: string): S3PrefixValidation {
    const cfg = this.requireConfig();
    return validateS3ClusterArtifactUri(uri, cfg.clusterId, expectedTaskId);
  }

  /** Query metadata (and optional streaming SHA-256) of a remote Tier 1 path via `fs.stat`. */
  async statFile(
    deviceId: string,
    remotePath: string,
    opts: { sha256?: boolean; timeoutMs?: number } = {},
  ): Promise<DeviceInvokeResult> {
    return await this.fileTransfer.statFile(deviceId, remotePath, opts);
  }

  /** Pull (download) a file directly from a paired Tier 1 OS agent to Master Neo local disk (`0xE3` binary E2E channel). */
  async pullFile(input: DeviceFilePullInput): Promise<DeviceFileTransferResult> {
    return await this.fileTransfer.pullFile(input);
  }

  /** Push (upload) a local file on Master Neo directly to a paired Tier 1 OS agent (`0xE3` binary E2E channel). */
  async pushFile(input: DeviceFilePushInput): Promise<DeviceFileTransferResult> {
    return await this.fileTransfer.pushFile(input);
  }

  /** List active and recently finished direct file transfers, newest first. */
  listTransfers(): FileTransferView[] {
    return this.fileTransfer.listTransfers();
  }

  /** Get status/progress of a direct file transfer by ID. */
  getTransfer(transferId: string): FileTransferView | null {
    return this.fileTransfer.getTransfer(transferId);
  }

  /** Cancel an in-flight direct file transfer by ID. */
  cancelTransfer(transferId: string, reason?: string): boolean {
    return this.fileTransfer.cancelTransfer(transferId, reason);
  }

  /** Invoke an action on a Tier 1 OS Agent or Tier 2 MCU (subject to risk gating & Deep Sleep queueing). */
  async invoke(deviceId: string, request: DeviceInvokeRequest): Promise<DeviceInvokeResult> {
    const cfg = this.requireConfig();
    const twin = this.getDevice(deviceId);
    if (!twin) {
      return {
        status: "rejected",
        deviceId,
        action: request.action,
        error: `Unknown device: ${deviceId}`,
      };
    }
    if (twin.clusterId !== cfg.clusterId) {
      return {
        status: "rejected",
        deviceId,
        action: request.action,
        error: `Cross-cluster device invocation rejected (${twin.clusterId} !== ${cfg.clusterId})`,
      };
    }

    const params = request.params ?? {};
    const risk = this.classifyRisk(twin, request.action, request.riskOverride);
    if (risk === "forbidden") {
      return {
        status: "rejected",
        deviceId,
        action: request.action,
        error: `Action '${request.action}' is forbidden by security policy`,
      };
    }
    if (risk === "confirm_required") {
      const approval = this.createPendingApproval(cfg.clusterId, deviceId, request.action, params, request);
      return {
        status: "pending_approval",
        approvalId: approval.id,
        shortCode: approval.shortCode,
        deviceId,
        action: request.action,
        params,
      };
    }

    return await this.dispatchInvocation(twin, request);
  }

  /** Approve a pending confirmation request by `id` or `shortCode` and dispatch it immediately. */
  async approve(
    idOrShortCode: string,
    decidedBy = "operator",
  ): Promise<{ approval: PendingApproval; result: DeviceInvokeResult }> {
    const approval = this.getApproval(idOrShortCode);
    if (!approval) {
      throw new Error(`Approval not found: ${idOrShortCode}`);
    }
    if (approval.status !== "pending") {
      throw new Error(`Approval ${approval.id} is already ${approval.status}`);
    }
    const cfg = this.requireConfig();
    if (approval.clusterId !== cfg.clusterId) {
      throw new Error("Cross-cluster approval rejected");
    }
    const twin = this.getDevice(approval.deviceId);
    if (!twin) {
      throw new Error(`Unknown device: ${approval.deviceId}`);
    }

    const decidedAt = nowIso();
    const updated: PendingApproval = {
      ...approval,
      status: "approved",
      decidedAt,
      decidedBy,
    };
    this.store.set(`${APPROVAL_KEY_PREFIX}${updated.id}`, updated);

    const invokeResult = await this.dispatchInvocation(twin, {
      action: approval.action,
      params: approval.params,
      timeoutMs: approval.timeoutMs,
      reason: approval.reason,
    });

    const finalized: PendingApproval = {
      ...updated,
      ...(invokeResult.status === "ok"
        ? { result: invokeResult.result }
        : invokeResult.status === "rejected"
          ? { error: invokeResult.error }
          : { result: invokeResult }),
    };
    this.store.set(`${APPROVAL_KEY_PREFIX}${finalized.id}`, finalized);
    return { approval: finalized, result: invokeResult };
  }

  /** Reject a pending confirmation request by `id` or `shortCode`. */
  reject(idOrShortCode: string, reason = "Rejected by operator", decidedBy = "operator"): PendingApproval {
    const approval = this.getApproval(idOrShortCode);
    if (!approval) {
      throw new Error(`Approval not found: ${idOrShortCode}`);
    }
    if (approval.status !== "pending") {
      throw new Error(`Approval ${approval.id} is already ${approval.status}`);
    }
    const updated: PendingApproval = {
      ...approval,
      status: "rejected",
      decidedAt: nowIso(),
      decidedBy,
      error: reason,
    };
    this.store.set(`${APPROVAL_KEY_PREFIX}${updated.id}`, updated);
    return updated;
  }

  private createPendingApproval(
    clusterId: string,
    deviceId: string,
    action: string,
    params: Record<string, unknown>,
    request: DeviceInvokeRequest,
  ): PendingApproval {
    const approval: PendingApproval = {
      id: generateId("apr"),
      shortCode: generateShortCode(),
      clusterId,
      deviceId,
      action,
      params,
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
      status: "pending",
      createdAt: nowIso(),
    };
    this.store.set(`${APPROVAL_KEY_PREFIX}${approval.id}`, approval);
    return approval;
  }

  private async dispatchInvocation(
    twin: DeviceTwin,
    request: DeviceInvokeRequest,
  ): Promise<DeviceInvokeResult> {
    if (twin.tier === "mcu") {
      return await this.dispatchMcuCommand(twin, request);
    }
    return await this.dispatchTier1Rpc(twin, request);
  }

  private async dispatchTier1Rpc(
    twin: DeviceTwin,
    request: DeviceInvokeRequest,
  ): Promise<DeviceInvokeResult> {
    const cfg = this.requireConfig();
    if (twin.status === "offline") {
      return {
        status: "rejected",
        deviceId: twin.deviceId,
        action: request.action,
        error: `Device ${twin.deviceId} is offline`,
      };
    }

    const reqId = generateId("rpc");
    const timeoutMs = request.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const msg: DeviceMessage = {
      v: 1,
      kind: "rpc_req",
      req_id: reqId,
      cluster_id: cfg.clusterId,
      device_id: cfg.masterNodeId,
      ts_ms: Date.now(),
      body: {
        method: request.action,
        params: request.params ?? {},
        timeout_ms: timeoutMs,
      },
    };

    if (twin.route === "lan" && twin.lanUrl) {
      try {
        const res = await (this.fetchFn ?? fetch)(`${twin.lanUrl.replace(/\/+$/, "")}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(msg),
        });
        if (res.ok) {
          const respBody = (await res.json()) as Record<string, unknown>;
          return this.interpretRpcResponse(twin.deviceId, request.action, reqId, respBody);
        }
      } catch {
        // Dynamic route fallback to relay when LAN fails.
        this.saveDevice({ ...twin, route: "relay" });
      }
    }

    const client = this.relayClient;
    if (!client || !client.isRelayConnected()) {
      return {
        status: "rejected",
        deviceId: twin.deviceId,
        action: request.action,
        error: "Relay client is not connected",
      };
    }

    const encrypted = sealDeviceMessage(msg, cfg.e2eKey, cfg.masterNodeId, twin.deviceId);
    const waiter = this.registerWaiter(
      this.pendingTier1Rpcs,
      reqId,
      twin.deviceId,
      twin.deviceId,
      timeoutMs,
    );

    const sent = client.sendData(twin.deviceId, encrypted);
    if (!sent) {
      this.cancelWaiter(this.pendingTier1Rpcs, reqId);
      return {
        status: "rejected",
        deviceId: twin.deviceId,
        action: request.action,
        error: "Failed to send relay frame",
      };
    }

    try {
      const respBody = (await waiter) as Record<string, unknown>;
      return this.interpretRpcResponse(twin.deviceId, request.action, reqId, respBody);
    } catch (error) {
      return {
        status: "rejected",
        deviceId: twin.deviceId,
        action: request.action,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private interpretRpcResponse(
    deviceId: string,
    action: string,
    reqId: string,
    body: Record<string, unknown>,
  ): DeviceInvokeResult {
    if (body.ok === false) {
      return {
        status: "rejected",
        deviceId,
        action,
        error: typeof body.error === "string" && body.error.length > 0 ? body.error : "Remote execution failed",
      };
    }
    return {
      status: "ok",
      deviceId,
      action,
      reqId,
      result: body.result !== undefined ? body.result : body,
    };
  }

  private async dispatchMcuCommand(
    initialTwin: DeviceTwin,
    request: DeviceInvokeRequest,
  ): Promise<DeviceInvokeResult> {
    const cfg = this.requireConfig();
    let twin = this.getDevice(initialTwin.deviceId) ?? initialTwin;
    const reqId = generateId("mcu");
    const params = request.params ?? {};

    // Allocate strictly monotonic seq_id and persist desiredState atomically.
    const seqId = twin.lastSeqId + 1;
    const nextDesired = { ...twin.desiredState, [request.action]: params };

    if (twin.status === "sleeping" || request.forceQueue) {
      const queuedItem: PendingMcuCommand = {
        seqId,
        action: request.action,
        params,
        reqId,
        queuedAt: nowIso(),
        attempts: 0,
        ...(twin.relayNodeId ? { relayNodeId: twin.relayNodeId } : {}),
      };
      twin = this.saveDevice({
        ...twin,
        lastSeqId: seqId,
        desiredState: nextDesired,
        pendingQueue: [...twin.pendingQueue, queuedItem],
      });
      return {
        status: "queued",
        deviceId: twin.deviceId,
        action: request.action,
        reqId,
        seqId,
        reason: "MCU is sleeping; command queued in desired-state shadow",
      };
    }

    const relayNodeId = this.resolveOnlineRelayForMcu(twin);
    if (!relayNodeId) {
      this.saveDevice({
        ...twin,
        status: "unreachable_via_relay",
        alertSuppressed: true,
      });
      return {
        status: "rejected",
        deviceId: twin.deviceId,
        action: request.action,
        error: `MCU ${twin.deviceId} is unreachable_via_relay (no online Tier 1 relay)`,
      };
    }

    if (relayNodeId !== twin.relayNodeId) {
      twin = this.saveDevice({
        ...twin,
        relayNodeId,
        lastSeqId: seqId,
        desiredState: nextDesired,
      });
    } else {
      twin = this.saveDevice({
        ...twin,
        lastSeqId: seqId,
        desiredState: nextDesired,
      });
    }

    return await this.sendMcuEnvelopeAndWait(
      cfg,
      twin,
      relayNodeId,
      seqId,
      request.action,
      params,
      reqId,
      request.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
    );
  }

  private async sendMcuEnvelopeAndWait(
    cfg: DeviceConfig,
    twin: DeviceTwin,
    relayNodeId: string,
    seqId: number,
    action: string,
    params: Record<string, unknown>,
    reqId: string,
    timeoutMs: number,
  ): Promise<DeviceInvokeResult> {
    const client = this.relayClient;
    if (!client || !client.isRelayConnected()) {
      return {
        status: "rejected",
        deviceId: twin.deviceId,
        action,
        error: "Relay client is not connected",
      };
    }

    const envelope = sealRelayEnvelope({
      clusterId: cfg.clusterId,
      relayNodeId,
      targetMcuId: twin.deviceId,
      direction: "downlink",
      seqId,
      payload: {
        t: "cmd",
        a: action,
        p: params,
      },
      e2eMasterSecret: cfg.e2eKey,
    });

    const msg: DeviceMessage = {
      v: 1,
      kind: "relay_envelope",
      req_id: reqId,
      cluster_id: cfg.clusterId,
      device_id: cfg.masterNodeId,
      ts_ms: Date.now(),
      body: envelope as unknown as Record<string, unknown>,
    };

    const encrypted = sealDeviceMessage(msg, cfg.e2eKey, cfg.masterNodeId, relayNodeId);
    const waiterKey = `${twin.deviceId}:${seqId}`;
    const waiter = this.registerWaiter(
      this.pendingMcuRpcs,
      waiterKey,
      twin.deviceId,
      relayNodeId,
      timeoutMs,
    );

    const sent = client.sendData(relayNodeId, encrypted);
    if (!sent) {
      this.cancelWaiter(this.pendingMcuRpcs, waiterKey);
      return {
        status: "rejected",
        deviceId: twin.deviceId,
        action,
        error: `Failed to send downlink envelope via ${relayNodeId}`,
      };
    }

    try {
      const res = (await waiter) as McuCborResult;
      if (!res.ok) {
        return {
          status: "rejected",
          deviceId: twin.deviceId,
          action,
          error: res.e || "MCU command failed",
        };
      }
      return {
        status: "ok",
        deviceId: twin.deviceId,
        action,
        reqId,
        seqId,
        result: res.d,
      };
    } catch (error) {
      return {
        status: "rejected",
        deviceId: twin.deviceId,
        action,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Flush queued Deep Sleep commands for a woken Tier 2 MCU in monotonic `seq_id` order. */
  async flushPendingQueue(deviceId: string): Promise<DeviceInvokeResult[]> {
    const cfg = this.requireConfig();
    const twin = this.getDevice(deviceId);
    if (!twin || twin.tier !== "mcu" || twin.pendingQueue.length === 0) {
      return [];
    }
    const relayNodeId = this.resolveOnlineRelayForMcu(twin);
    if (!relayNodeId) {
      return [];
    }

    const queue = [...twin.pendingQueue].sort((a, b) => a.seqId - b.seqId);
    const results: DeviceInvokeResult[] = [];
    for (let i = 0; i < queue.length; i++) {
      const cmd = queue[i]!;
      if (cmd.seqId <= twin.lastAckedSeqId) {
        // Idempotent skip for already acknowledged seq_id.
        this.removeQueuedSeqId(deviceId, cmd.seqId);
        continue;
      }
      const bumped = this.bumpQueueAttempt(deviceId, cmd.seqId);
      const latestTwin = bumped ?? twin;
      const res = await this.sendMcuEnvelopeAndWait(
        cfg,
        latestTwin,
        relayNodeId,
        cmd.seqId,
        cmd.action,
        cmd.params,
        cmd.reqId,
        DEFAULT_RPC_TIMEOUT_MS,
      );
      results.push(res);
    }
    return results;
  }

  private bumpQueueAttempt(deviceId: string, seqId: number): DeviceTwin | null {
    const current = this.getDevice(deviceId);
    if (!current) return null;
    const nextQueue = current.pendingQueue.map((item) =>
      item.seqId === seqId ? { ...item, attempts: item.attempts + 1 } : item,
    );
    return this.saveDevice({ ...current, pendingQueue: nextQueue });
  }

  private removeQueuedSeqId(deviceId: string, seqId: number): void {
    const current = this.getDevice(deviceId);
    if (!current) return;
    const nextQueue = current.pendingQueue.filter((item) => item.seqId !== seqId);
    if (nextQueue.length !== current.pendingQueue.length) {
      this.saveDevice({ ...current, pendingQueue: nextQueue });
    }
  }

  private resolveOnlineRelayForMcu(twin: DeviceTwin): string | null {
    if (twin.relayNodeId) {
      const primary = this.getDevice(twin.relayNodeId);
      if (primary && primary.tier === "os" && primary.status === "online") {
        return primary.deviceId;
      }
    }
    const backups = twin.backupRelayNodeIds ?? [];
    for (let i = 0; i < backups.length; i++) {
      const candidate = this.getDevice(backups[i]!);
      if (candidate && candidate.tier === "os" && candidate.status === "online") {
        return candidate.deviceId;
      }
    }
    return null;
  }

  /**
   * Handle Tier 1 OS relay node disconnect:
   * - Marks the Tier 1 device `offline`.
   * - For every child Tier 2 MCU using it: fails over to an online backup Tier 1 relay if available,
   *   otherwise marks the child MCU `unreachable_via_relay` with `alertSuppressed: true`.
   */
  handleTier1Disconnect(tier1DeviceId: string): {
    failedOver: string[];
    unreachable: string[];
  } {
    const failedOver: string[] = [];
    const unreachable: string[] = [];

    const parent = this.getDevice(tier1DeviceId);
    if (parent && parent.tier === "os" && parent.status !== "offline") {
      this.saveDevice({ ...parent, status: "offline" });
    }

    this.fileTransfer.failForPeer(tier1DeviceId, `Peer ${tier1DeviceId} disconnected`);
    this.rejectWaitersForTransport(tier1DeviceId, `Peer ${tier1DeviceId} disconnected`);

    const all = this.listDevices();
    for (let i = 0; i < all.length; i++) {
      const mcu = all[i]!;
      if (mcu.tier !== "mcu" || mcu.relayNodeId !== tier1DeviceId) {
        continue;
      }
      const backupId = this.findOnlineBackupRelay(mcu, tier1DeviceId);
      if (backupId !== null) {
        this.saveDevice({
          ...mcu,
          relayNodeId: backupId,
          status: mcu.status === "unreachable_via_relay" ? "online" : mcu.status,
          alertSuppressed: false,
        });
        failedOver.push(mcu.deviceId);
      } else {
        this.saveDevice({
          ...mcu,
          status: "unreachable_via_relay",
          alertSuppressed: true,
        });
        unreachable.push(mcu.deviceId);
      }
    }

    return { failedOver, unreachable };
  }

  private findOnlineBackupRelay(mcu: DeviceTwin, excludeId: string): string | null {
    const backups = mcu.backupRelayNodeIds ?? [];
    for (let i = 0; i < backups.length; i++) {
      const id = backups[i]!;
      if (id === excludeId) continue;
      const candidate = this.getDevice(id);
      if (candidate && candidate.tier === "os" && candidate.status === "online") {
        return candidate.deviceId;
      }
    }
    return null;
  }

  /** Handle an incoming `FLAG_DATA` relay frame (exposed for unit tests & RelayClient). */
  handleRelayFrame(frame: RelayFrame): void {
    const cfg = this.config;
    if (!cfg || !cfg.enabled) return;

    if (frame.payload.byteLength > 0 && frame.payload[0] === FILE_ENVELOPE_VERSION) {
      this.fileTransfer.handleIncomingEnvelope(frame.src, frame.payload);
      return;
    }

    let msg: DeviceMessage;
    try {
      msg = openDeviceMessage(frame.payload, cfg.e2eKey, cfg.clusterId, frame.src, cfg.masterNodeId);
    } catch (error) {
      this.updateBoard(
        "error",
        `Dropped invalid E2E frame from ${frame.src}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    this.handleDeviceMessage(frame.src, msg);
  }

  /** Process a decrypted & cluster-verified `DeviceMessage`. */
  handleDeviceMessage(srcNodeId: string, msg: DeviceMessage): void {
    const cfg = this.requireConfig();
    if (msg.cluster_id !== cfg.clusterId) {
      throw new Error(`Cross-cluster DeviceMessage rejected (${msg.cluster_id} !== ${cfg.clusterId})`);
    }

    switch (msg.kind) {
      case "manifest": {
        const body = msg.body;
        const manifestVersion =
          typeof body.version === "string" && body.version.trim().length > 0
            ? body.version.trim()
            : typeof body.agent_version === "string" && body.agent_version.trim().length > 0
              ? body.agent_version.trim()
              : undefined;
        const manifest: CapabilityManifest = {
          device_id: typeof body.device_id === "string" ? body.device_id : msg.device_id || srcNodeId,
          tier: body.tier === "mcu" ? "mcu" : "os",
          ...(manifestVersion ? { version: manifestVersion } : {}),
          ...(typeof body.os === "string" ? { os: body.os } : {}),
          ...(typeof body.arch === "string" ? { arch: body.arch } : {}),
          ...(typeof body.hostname === "string" ? { hostname: body.hostname } : {}),
          ...(typeof body.cpus === "number" ? { cpus: body.cpus } : {}),
          ...(typeof body.ram_mb === "number" ? { ram_mb: body.ram_mb } : {}),
          ...(Array.isArray(body.capabilities)
            ? { capabilities: body.capabilities.filter((c): c is string => typeof c === "string") }
            : {}),
          ...(Array.isArray(body.actions) ? { actions: body.actions as CapabilityManifest["actions"] } : {}),
          ...(isRecord(body.sandbox) ? { sandbox: normalizeSandboxSummary(body.sandbox) } : {}),
          ...(isRecord(body.relay_config)
            ? { relay_config: body.relay_config as CapabilityManifest["relay_config"] }
            : {}),
        };
        const routeHint = this.relayClient?.getPeerRouteHint(manifest.device_id);
        let twin = this.upsertDeviceManifest(manifest, {
          status: "online",
          ...(routeHint ? { route: routeHint } : {}),
        });
        const fingerprint =
          typeof body.fingerprint === "string" && body.fingerprint.trim().length > 0
            ? body.fingerprint.trim()
            : undefined;
        if (fingerprint || manifestVersion) {
          twin = this.saveDevice({
            ...twin,
            reportedState: {
              ...twin.reportedState,
              ...(fingerprint ? { fingerprint } : {}),
              ...(manifestVersion ? { version: manifestVersion } : {}),
            },
          });
        }
        const enrollId = typeof body.enroll_id === "string" ? body.enroll_id.trim() : "";
        if (enrollId) {
          this.enrollment.markEnrollmentCompleted(enrollId, manifest.device_id, fingerprint);
        }
        if (
          twin.tier === "os" &&
          twin.status === "online" &&
          twin.desiredSandboxLevel &&
          twin.sandboxLevel !== twin.desiredSandboxLevel &&
          twin.manifest?.sandbox?.locked !== true &&
          twin.sandboxSyncState === "pending"
        ) {
          void this.syncDesiredSandbox(twin.deviceId);
        }
        break;
      }
      case "enroll_register": {
        const ackBody = this.enrollment.handleEnrollRegister(srcNodeId, msg);
        const ackMsg: DeviceMessage = {
          v: 1,
          kind: "enroll_ack",
          req_id: msg.req_id,
          cluster_id: cfg.clusterId,
          device_id: cfg.masterNodeId,
          ts_ms: Date.now(),
          body: ackBody,
        };
        const client = this.relayClient;
        if (client && client.isRelayConnected()) {
          const encrypted = sealDeviceMessage(ackMsg, cfg.e2eKey, cfg.masterNodeId, srcNodeId);
          client.sendData(srcNodeId, encrypted);
        }
        break;
      }
      case "heartbeat": {
        const devId = msg.device_id || srcNodeId;
        const existing = this.getDevice(devId);
        if (existing) {
          const hbVersion =
            typeof msg.body.version === "string" && msg.body.version.trim().length > 0
              ? msg.body.version.trim()
              : undefined;
          const nextManifest =
            hbVersion && existing.manifest && existing.manifest.version !== hbVersion
              ? { ...existing.manifest, version: hbVersion }
              : existing.manifest;
          this.saveDevice({
            ...existing,
            status: "online",
            alertSuppressed: false,
            ...(nextManifest ? { manifest: nextManifest } : {}),
            lastSeenAt: nowIso(),
            lastSeenMs: Date.now(),
            reportedState: { ...existing.reportedState, ...msg.body },
          });
        }
        break;
      }
      case "rpc_resp": {
        const pending = this.pendingTier1Rpcs.get(msg.req_id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingTier1Rpcs.delete(msg.req_id);
          pending.resolve(msg.body);
        }
        break;
      }
      case "relay_envelope": {
        this.handleRelayEnvelopeMessage(srcNodeId, msg.body);
        break;
      }
      case "event": {
        const eventType = typeof msg.body.event === "string" ? msg.body.event : "";
        const targetId = typeof msg.body.device_id === "string" ? msg.body.device_id : msg.device_id || srcNodeId;
        if (eventType === "mcu_sleep") {
          const twin = this.getDevice(targetId);
          if (twin && twin.tier === "mcu") {
            this.saveDevice({ ...twin, status: "sleeping" });
          }
        } else if (eventType === "tier1_offline") {
          this.handleTier1Disconnect(targetId);
        }
        break;
      }
      default:
        break;
    }
  }

  private handleRelayEnvelopeMessage(srcNodeId: string, rawBody: Record<string, unknown>): void {
    const cfg = this.requireConfig();
    const env: RelayEnvelope = {
      cluster_id: typeof rawBody.cluster_id === "string" ? rawBody.cluster_id : "",
      relay_node_id: typeof rawBody.relay_node_id === "string" ? rawBody.relay_node_id : srcNodeId,
      target_mcu_id: typeof rawBody.target_mcu_id === "string" ? rawBody.target_mcu_id : "",
      direction: rawBody.direction === "downlink" ? "downlink" : "uplink",
      seq_id: typeof rawBody.seq_id === "number" ? rawBody.seq_id : -1,
      e2e_mac: typeof rawBody.e2e_mac === "string" ? rawBody.e2e_mac : "",
      cbor_payload_b64: typeof rawBody.cbor_payload_b64 === "string" ? rawBody.cbor_payload_b64 : "",
    };

    let payload: Record<string, unknown>;
    try {
      const opened = openRelayEnvelope<Record<string, unknown>>(env, cfg.e2eKey, cfg.clusterId);
      payload = opened.payload;
    } catch (error) {
      this.updateBoard(
        "error",
        `Rejected MCU RelayEnvelope for ${env.target_mcu_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (!isRecord(payload)) return;
    const kind = payload.t;
    const relayNodeId = env.relay_node_id || srcNodeId;

    if (kind === "hello") {
      const hello = payload as unknown as McuCborHello;
      const acts = Array.isArray(hello.acts)
        ? hello.acts.filter((a): a is string => typeof a === "string")
        : [];
      const twin = this.upsertDeviceManifest(
        {
          device_id: env.target_mcu_id,
          tier: "mcu",
          chip: typeof hello.chip === "string" ? hello.chip : undefined,
          fw: typeof hello.fw === "string" ? hello.fw : undefined,
          acts,
          capabilities: acts,
        },
        {
          route: "via_tier1",
          status: "online",
          relayNodeId,
        },
      );
      if (twin.pendingQueue.length > 0) {
        void this.flushPendingQueue(twin.deviceId);
      }
      return;
    }

    if (kind === "res") {
      const res: McuCborResult = {
        t: "res",
        ok: Boolean(payload.ok),
        a: typeof payload.a === "string" ? payload.a : "",
        d: isRecord(payload.d) ? payload.d : {},
        ...(typeof payload.e === "string" ? { e: payload.e } : {}),
      };

      const existing = this.getDevice(env.target_mcu_id);
      if (existing) {
        const seen = existing.seenUplinkSeqIds ?? [];
        if (env.seq_id > 0 && seen.includes(env.seq_id)) {
          // Idempotent duplicate uplink result: ignore state mutation.
          return;
        }
        const nextSeen =
          env.seq_id > 0 ? [...seen, env.seq_id].slice(-MAX_UPLINK_SEQ_HISTORY) : seen;
        const nextQueue = existing.pendingQueue.filter((q) => q.seqId !== env.seq_id);
        const nextReported = res.ok
          ? { ...existing.reportedState, ...res.d, [res.a]: res.d }
          : existing.reportedState;
        this.saveDevice({
          ...existing,
          status: "online",
          relayNodeId,
          alertSuppressed: false,
          lastSeenAt: nowIso(),
          lastSeenMs: Date.now(),
          lastAckedSeqId: Math.max(existing.lastAckedSeqId, env.seq_id),
          seenUplinkSeqIds: nextSeen,
          pendingQueue: nextQueue,
          reportedState: nextReported,
        });
      }

      const waiterKey = `${env.target_mcu_id}:${env.seq_id}`;
      const pending = this.pendingMcuRpcs.get(waiterKey);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingMcuRpcs.delete(waiterKey);
        pending.resolve(res);
      }
    }
  }

  private handleSignal(sig: SignalMessage): void {
    const peerId = sig.from ?? sig.src ?? sig.peer_id ?? sig.node_id;
    if (!peerId || peerId === this.config?.masterNodeId) return;
    const twin = this.getDevice(peerId);
    if (!twin) return;

    if (sig.type === "p2p_offer" || sig.type === "p2p_answer" || sig.type === "p2p_punch") {
      if (twin.tier === "os" && twin.route !== "lan") {
        this.saveDevice({ ...twin, route: "p2p" });
      }
    } else if (sig.type === "p2p_unavailable" || sig.type === "relay_fallback") {
      if (twin.tier === "os" && twin.route === "p2p") {
        this.saveDevice({ ...twin, route: "relay" });
      }
    } else if (sig.type === "peer_offline" || sig.type === "disconnected") {
      this.handleTier1Disconnect(peerId);
    }
  }

  private handleRelayError(err: RelayErrorEvent): void {
    if (err.code === FLAG_ERR_OFFLINE) {
      const candidates = [
        err.reason && err.reason !== "Peer offline" ? err.reason : "",
        err.src && err.src !== "neo-relay" && err.src !== this.config?.masterNodeId ? err.src : "",
        err.dst && err.dst !== "neo-relay" && err.dst !== this.config?.masterNodeId ? err.dst : "",
      ];
      let offlinePeer = candidates.find((c) => c.length > 0 && this.getDevice(c) !== null) ?? "";
      if (!offlinePeer) {
        offlinePeer =
          err.src === "neo-relay"
            ? err.reason && err.reason !== "Peer offline"
              ? err.reason
              : ""
            : (candidates.find((c) => c.length > 0) ?? "");
      }
      if (offlinePeer) {
        this.handleTier1Disconnect(offlinePeer);
      } else {
        // Fallback: reject oldest pending waiters if relay didn't identify peer in src/dst/reason.
        this.failAllPending(`Relay peer offline: ${err.reason}`);
      }
      return;
    }
    if (err.code === FLAG_ERR_RATE) {
      this.fileTransfer.notifyRateLimited();
    }
    this.updateBoard("error", `Relay error 0x${err.code.toString(16)}: ${err.reason}`);
  }

  private registerWaiter(
    map: Map<string, PendingRpc>,
    key: string,
    deviceId: string,
    transportTargetId: string,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        map.delete(key);
        reject(new Error(`RPC timeout after ${timeoutMs}ms for ${deviceId}`));
      }, timeoutMs);
      map.set(key, { resolve, reject, timer, deviceId, transportTargetId });
    });
  }

  private cancelWaiter(map: Map<string, PendingRpc>, key: string): void {
    const entry = map.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      map.delete(key);
    }
  }

  private rejectWaitersForTransport(transportTargetId: string, reason: string): void {
    for (const [key, entry] of this.pendingTier1Rpcs.entries()) {
      if (entry.transportTargetId === transportTargetId || entry.deviceId === transportTargetId) {
        clearTimeout(entry.timer);
        this.pendingTier1Rpcs.delete(key);
        entry.reject(new Error(reason));
      }
    }
    for (const [key, entry] of this.pendingMcuRpcs.entries()) {
      if (entry.transportTargetId === transportTargetId || entry.deviceId === transportTargetId) {
        clearTimeout(entry.timer);
        this.pendingMcuRpcs.delete(key);
        entry.reject(new Error(reason));
      }
    }
  }

  private failAllPending(reason: string): void {
    for (const [key, entry] of this.pendingTier1Rpcs.entries()) {
      clearTimeout(entry.timer);
      this.pendingTier1Rpcs.delete(key);
      entry.reject(new Error(reason));
    }
    for (const [key, entry] of this.pendingMcuRpcs.entries()) {
      clearTimeout(entry.timer);
      this.pendingMcuRpcs.delete(key);
      entry.reject(new Error(reason));
    }
  }

  private requireConfig(): DeviceConfig {
    if (!this.config) {
      throw new Error("Device control plane is not configured");
    }
    return this.config;
  }

  private updateBoard(state: "ready" | "waiting" | "error", detail: string): void {
    this.board?.set("devices", state, detail);
  }
}
