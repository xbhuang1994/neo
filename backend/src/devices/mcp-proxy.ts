/**
 * Master Neo Local MCP Discovery & E2EE Proxy Control Plane (`DeviceMcpProxy`):
 * - Persists per-device discovered MCP server descriptors and lazily-inspected tool schemas
 *   under dedicated KV namespace `device-mcp:<deviceId>` (never bloating `device:<deviceId>`).
 * - Ingests lightweight `CapabilityManifest.mcp_summary` and uplink `mcp.catalog_changed` events.
 * - Proxies `mcp.discover`, `mcp.list`, `mcp.inspect`, `mcp.server.set_policy`, `mcp.server.stop`,
 *   `mcp.server.restart`, `mcp.call`, `mcp.resource.read`, and `mcp.prompt.get` over E2EE `0xE1` RPC.
 * - Enforces tool-level risk classification integrated with `DeviceManager`'s `PendingApproval` shortCode flow.
 */

import type { Store } from "../store/index.ts";
import type { RelayClient } from "./relay-client.ts";
import {
  isMcpCallPolicyMode,
  isMcpDiscoveryMode,
  isMcpRuntimeState,
  isMcpTransportKind,
  isMcpTrustState,
  type DeviceConfig,
  type DeviceInvokeRequest,
  type DeviceInvokeResult,
  type DeviceMcpCallInput,
  type DeviceMcpCatalogRecord,
  type DeviceMcpDiscoverOptions,
  type DeviceMcpInspectOptions,
  type DeviceMcpInspectResult,
  type DeviceMcpListOptions,
  type DeviceMcpOverview,
  type DeviceMcpPolicyUpdateInput,
  type DeviceMcpPolicyUpdateResult,
  type DeviceMcpServerActionResult,
  type DeviceRiskLevel,
  type DeviceTwin,
  type McpCallAction,
  type McpCallPolicyMode,
  type McpDiscoveryMode,
  type McpInspectedServerRecord,
  type McpRuntimeState,
  type McpServerDescriptor,
  type McpServerSummaryItem,
  type McpSummary,
  type McpToolAnnotations,
  type McpToolInfo,
  type McpTrustState,
  type PendingApproval,
  type SandboxLevel,
} from "./types.ts";

/** Dedicated KV key prefix for per-device MCP catalogs (kept separate from `device:<id>`). */
export const DEVICE_MCP_KEY_PREFIX = "device-mcp:";

const DEFAULT_MCP_DISCOVER_TIMEOUT_MS = 30_000;
const DEFAULT_MCP_LIST_TIMEOUT_MS = 15_000;
const DEFAULT_MCP_INSPECT_TIMEOUT_MS = 45_000;
const DEFAULT_MCP_POLICY_TIMEOUT_MS = 15_000;
const DEFAULT_MCP_LIFECYCLE_TIMEOUT_MS = 20_000;
const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnsupportedRpcError(error: string): boolean {
  return /unsupported rpc method/i.test(error);
}

function formatUnsupportedError(deviceId: string, method: string, rawError: string): string {
  if (!isUnsupportedRpcError(rawError)) {
    return rawError;
  }
  return `Remote neo-agent-os on ${deviceId} does not support ${method} yet (${rawError}); upgrade the agent via OTA update (updateDevice) to enable local MCP discovery and proxying.`;
}

function normalizeNullableString(value: unknown, fallback?: string | null): string | null | undefined {
  if (typeof value === "string") return value;
  if (value === null) return null;
  return fallback;
}

function normalizeNullableNumber(value: unknown, fallback?: number | null): number | null | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null) return null;
  return fallback;
}

function normalizeStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item): item is string => typeof item === "string");
}

/** Normalize a raw `McpServerSummaryItem` from a manifest or uplink event. */
export function normalizeMcpServerSummaryItem(raw: unknown): McpServerSummaryItem | null {
  if (!isRecord(raw)) return null;
  const serverId = typeof raw.server_id === "string" ? raw.server_id.trim() : "";
  if (!serverId) return null;
  const name = typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name.trim() : serverId;
  const source = typeof raw.source === "string" && raw.source.trim().length > 0 ? raw.source.trim() : "unknown";
  const transport = isMcpTransportKind(raw.transport) ? raw.transport : "stdio";
  const trustState = isMcpTrustState(raw.trust_state)
    ? raw.trust_state
    : raw.trust_state === "denied"
      ? "blocked_by_policy"
      : "discovered";
  const callMode = isMcpCallPolicyMode(raw.call_mode) ? raw.call_mode : "auto_readonly";
  const runtimeState = isMcpRuntimeState(raw.runtime_state) ? raw.runtime_state : "stopped";
  const toolCount = normalizeNullableNumber(raw.tool_count);
  return {
    server_id: serverId,
    name,
    source,
    transport,
    trust_state: trustState,
    call_mode: callMode,
    runtime_state: runtimeState,
    ...(toolCount !== undefined ? { tool_count: toolCount } : {}),
  };
}

/** Normalize a raw `McpSummary` object (strips any extraneous non-summary fields). */
export function normalizeMcpSummary(raw: unknown): McpSummary | undefined {
  if (!isRecord(raw)) return undefined;
  const discoveryMode: McpDiscoveryMode = isMcpDiscoveryMode(raw.discovery_mode)
    ? raw.discovery_mode
    : isMcpDiscoveryMode(raw.discoveryMode)
      ? raw.discoveryMode
      : "disabled";
  const servers: McpServerSummaryItem[] = [];
  if (Array.isArray(raw.servers)) {
    for (let i = 0; i < raw.servers.length; i++) {
      const item = normalizeMcpServerSummaryItem(raw.servers[i]);
      if (item) servers.push(item);
    }
  }
  const enabled =
    typeof raw.enabled === "boolean" ? raw.enabled : discoveryMode !== "disabled";
  const discoveredCount =
    typeof raw.discovered_count === "number" && Number.isFinite(raw.discovered_count)
      ? raw.discovered_count
      : servers.length;
  const enabledCount =
    typeof raw.enabled_count === "number" && Number.isFinite(raw.enabled_count)
      ? raw.enabled_count
      : servers.filter((s) => s.trust_state === "enabled").length;
  const runningCount =
    typeof raw.running_count === "number" && Number.isFinite(raw.running_count)
      ? raw.running_count
      : servers.filter((s) => s.runtime_state === "running").length;
  const catalogHash =
    typeof raw.catalog_hash === "string"
      ? raw.catalog_hash
      : typeof raw.catalogHash === "string"
        ? raw.catalogHash
        : "";
  return {
    enabled,
    discovery_mode: discoveryMode,
    discovered_count: discoveredCount,
    enabled_count: enabledCount,
    running_count: runningCount,
    catalog_hash: catalogHash,
    servers,
  };
}

/**
 * Normalize a raw `McpServerDescriptor`, strictly allowlisting redacted descriptor fields
 * so raw secrets (e.g. `env`, `headers`, `token`) are never stored even if accidentally sent.
 */
export function normalizeMcpServerDescriptor(
  raw: unknown,
  existing?: McpServerDescriptor,
): McpServerDescriptor | null {
  if (!isRecord(raw)) return null;
  const serverId = typeof raw.server_id === "string" ? raw.server_id.trim() : "";
  if (!serverId) return null;
  const name =
    typeof raw.name === "string" && raw.name.trim().length > 0
      ? raw.name.trim()
      : existing?.name ?? serverId;
  const source =
    typeof raw.source === "string" && raw.source.trim().length > 0
      ? raw.source.trim()
      : existing?.source ?? "unknown";
  const transport = isMcpTransportKind(raw.transport)
    ? raw.transport
    : existing?.transport ?? "stdio";
  const trustState = isMcpTrustState(raw.trust_state)
    ? raw.trust_state
    : raw.trust_state === "denied"
      ? "blocked_by_policy"
      : existing?.trust_state ?? "discovered";
  const callMode = isMcpCallPolicyMode(raw.call_mode)
    ? raw.call_mode
    : existing?.call_mode ?? "auto_readonly";
  const runtimeState = isMcpRuntimeState(raw.runtime_state)
    ? raw.runtime_state
    : existing?.runtime_state ?? "stopped";

  const sourcePath = normalizeNullableString(raw.source_path, existing?.source_path);
  const commandPreview = normalizeNullableString(raw.command_preview, existing?.command_preview);
  const urlSanitized = normalizeNullableString(raw.url_sanitized, existing?.url_sanitized);
  const envKeys =
    raw.env_keys !== undefined
      ? normalizeStringArray(raw.env_keys)
      : existing?.env_keys ?? [];
  const authRequired =
    typeof raw.auth_required === "boolean"
      ? raw.auth_required
      : existing?.auth_required ?? false;
  const toolCount = normalizeNullableNumber(raw.tool_count, existing?.tool_count);
  const dedupKey = normalizeNullableString(raw.dedup_key, existing?.dedup_key);
  const duplicateOf = normalizeNullableString(raw.duplicate_of, existing?.duplicate_of);
  const fingerprint = normalizeNullableString(raw.fingerprint, existing?.fingerprint);
  const lastError = normalizeNullableString(raw.last_error, existing?.last_error);
  const discoveredAtMs = normalizeNullableNumber(raw.discovered_at_ms, existing?.discovered_at_ms);

  return {
    server_id: serverId,
    name,
    source,
    ...(sourcePath !== undefined ? { source_path: sourcePath } : {}),
    transport,
    ...(commandPreview !== undefined ? { command_preview: commandPreview } : {}),
    ...(urlSanitized !== undefined ? { url_sanitized: urlSanitized } : {}),
    env_keys: envKeys,
    auth_required: authRequired,
    trust_state: trustState,
    call_mode: callMode,
    runtime_state: runtimeState,
    ...(toolCount !== undefined ? { tool_count: toolCount } : {}),
    ...(dedupKey !== undefined ? { dedup_key: dedupKey } : {}),
    ...(duplicateOf !== undefined ? { duplicate_of: duplicateOf } : {}),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    ...(lastError !== undefined ? { last_error: lastError } : {}),
    ...(discoveredAtMs !== undefined ? { discovered_at_ms: discoveredAtMs } : {}),
  };
}

/** Merge a lightweight `McpServerSummaryItem` into an existing cached `McpServerDescriptor` (if any). */
function summaryItemToDescriptor(
  item: McpServerSummaryItem,
  existing?: McpServerDescriptor,
): McpServerDescriptor {
  const toolCount = item.tool_count !== undefined ? item.tool_count : existing?.tool_count;
  return {
    server_id: item.server_id,
    name: item.name,
    source: item.source,
    ...(existing?.source_path !== undefined ? { source_path: existing.source_path } : {}),
    transport: item.transport,
    ...(existing?.command_preview !== undefined ? { command_preview: existing.command_preview } : {}),
    ...(existing?.url_sanitized !== undefined ? { url_sanitized: existing.url_sanitized } : {}),
    env_keys: existing?.env_keys ?? [],
    auth_required: existing?.auth_required ?? false,
    trust_state: item.trust_state,
    call_mode: item.call_mode,
    runtime_state: item.runtime_state,
    ...(toolCount !== undefined ? { tool_count: toolCount } : {}),
    ...(existing?.dedup_key !== undefined ? { dedup_key: existing.dedup_key } : {}),
    ...(existing?.duplicate_of !== undefined ? { duplicate_of: existing.duplicate_of } : {}),
    ...(existing?.fingerprint !== undefined ? { fingerprint: existing.fingerprint } : {}),
    ...(existing?.last_error !== undefined ? { last_error: existing.last_error } : {}),
    ...(existing?.discovered_at_ms !== undefined ? { discovered_at_ms: existing.discovered_at_ms } : {}),
  };
}

function descriptorToSummaryItem(desc: McpServerDescriptor): McpServerSummaryItem {
  return {
    server_id: desc.server_id,
    name: desc.name,
    source: desc.source,
    transport: desc.transport,
    trust_state: desc.trust_state,
    call_mode: desc.call_mode,
    runtime_state: desc.runtime_state,
    ...(desc.tool_count !== undefined ? { tool_count: desc.tool_count } : {}),
  };
}

function buildSummary(opts: {
  discoveryMode: McpDiscoveryMode;
  catalogHash: string;
  servers: readonly McpServerDescriptor[];
  enabled?: boolean;
}): McpSummary {
  const items = opts.servers.map(descriptorToSummaryItem);
  return {
    enabled: opts.enabled ?? opts.discoveryMode !== "disabled",
    discovery_mode: opts.discoveryMode,
    discovered_count: items.length,
    enabled_count: items.filter((s) => s.trust_state === "enabled").length,
    running_count: items.filter((s) => s.runtime_state === "running").length,
    catalog_hash: opts.catalogHash,
    servers: items,
  };
}

/** Normalize MCP tool annotations (accepts both camelCase MCP spec and snake_case keys). */
export function normalizeMcpToolAnnotations(raw: unknown): McpToolAnnotations | undefined {
  if (!isRecord(raw)) return undefined;
  const out: McpToolAnnotations = {};
  if (typeof raw.title === "string") out.title = raw.title;
  const readOnly = raw.readOnlyHint ?? raw.read_only_hint;
  if (typeof readOnly === "boolean") out.readOnlyHint = readOnly;
  const destructive = raw.destructiveHint ?? raw.destructive_hint;
  if (typeof destructive === "boolean") out.destructiveHint = destructive;
  const idempotent = raw.idempotentHint ?? raw.idempotent_hint;
  if (typeof idempotent === "boolean") out.idempotentHint = idempotent;
  const openWorld = raw.openWorldHint ?? raw.open_world_hint;
  if (typeof openWorld === "boolean") out.openWorldHint = openWorld;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Normalize an inspected `McpToolInfo` item. */
export function normalizeMcpToolInfo(raw: unknown): McpToolInfo | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  const description = typeof raw.description === "string" ? raw.description : undefined;
  const rawSchema = raw.inputSchema ?? raw.input_schema;
  const inputSchema: Record<string, unknown> = isRecord(rawSchema) ? rawSchema : {};
  const annotations = normalizeMcpToolAnnotations(raw.annotations);
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    inputSchema,
    ...(annotations !== undefined ? { annotations } : {}),
  };
}

function preserveToolsByServer(
  prevRecord: DeviceMcpCatalogRecord | null,
  nextServers: readonly McpServerDescriptor[],
): Record<string, McpInspectedServerRecord> {
  if (!prevRecord || !isRecord(prevRecord.toolsByServer)) {
    return {};
  }
  const prevById = new Map<string, McpServerDescriptor>();
  for (let i = 0; i < prevRecord.servers.length; i++) {
    const s = prevRecord.servers[i]!;
    prevById.set(s.server_id, s);
  }
  const preserved: Record<string, McpInspectedServerRecord> = {};
  for (let i = 0; i < nextServers.length; i++) {
    const next = nextServers[i]!;
    const cached = prevRecord.toolsByServer[next.server_id];
    if (!cached) continue;
    const prev = prevById.get(next.server_id);
    if (prev?.fingerprint && next.fingerprint && prev.fingerprint !== next.fingerprint) {
      // Fingerprint changed: invalidate stale cached tool schemas/annotations.
      continue;
    }
    preserved[next.server_id] = cached;
  }
  return preserved;
}

function filterToolsByQuery(tools: readonly McpToolInfo[], query?: string): {
  tools: McpToolInfo[];
  filtered: boolean;
} {
  const needle = query?.trim().toLowerCase() ?? "";
  if (!needle) {
    return { tools: [...tools], filtered: false };
  }
  return {
    tools: tools.filter((tool) => {
      const nameMatch = tool.name.toLowerCase().includes(needle);
      const descMatch = (tool.description ?? "").toLowerCase().includes(needle);
      return nameMatch || descMatch;
    }),
    filtered: true,
  };
}

/**
 * Pure risk classifier for proxied local MCP calls:
 * - `blocked_by_policy` / `disabled` / `call_mode === "disabled"` -> `"forbidden"`
 * - `resources/read` & `prompts/get` -> read-only (`"safe_auto"` unless `call_mode === "confirm_all"`)
 * - `tools/call`:
 *   - `"confirm_all"` -> `"confirm_required"`
 *   - `"auto_readonly"` -> `"safe_auto"` iff `readOnlyHint === true && destructiveHint !== true`, else `"confirm_required"`
 *   - `"auto_all"` -> `"confirm_required"` iff `destructiveHint === true && sandboxLevel !== "unrestricted"`, else `"safe_auto"`
 */
export function classifyMcpCallRisk(opts: {
  action: McpCallAction;
  trustState: McpTrustState;
  callMode: McpCallPolicyMode;
  sandboxLevel?: SandboxLevel;
  annotations?: McpToolAnnotations;
}): DeviceRiskLevel {
  if (
    opts.trustState === "blocked_by_policy" ||
    opts.trustState === "disabled" ||
    opts.callMode === "disabled"
  ) {
    return "forbidden";
  }

  if (opts.action === "resources/read" || opts.action === "prompts/get") {
    return opts.callMode === "confirm_all" ? "confirm_required" : "safe_auto";
  }

  switch (opts.callMode) {
    case "confirm_all":
      return "confirm_required";
    case "auto_readonly":
      return opts.annotations?.readOnlyHint === true && opts.annotations?.destructiveHint !== true
        ? "safe_auto"
        : "confirm_required";
    case "auto_all":
      return opts.annotations?.destructiveHint === true && opts.sandboxLevel !== "unrestricted"
        ? "confirm_required"
        : "safe_auto";
    default:
      return "forbidden";
  }
}

export interface DeviceMcpProxyOptions {
  store: Store;
  getConfig: () => DeviceConfig | null;
  getDevice: (deviceId: string) => DeviceTwin | null;
  listDevices: () => DeviceTwin[];
  saveDevice: (twin: DeviceTwin) => DeviceTwin;
  getRelayClient: () => RelayClient | null;
  dispatchTier1Rpc: (twin: DeviceTwin, request: DeviceInvokeRequest) => Promise<DeviceInvokeResult>;
  createPendingApproval: (
    clusterId: string,
    deviceId: string,
    action: string,
    params: Record<string, unknown>,
    request: DeviceInvokeRequest,
  ) => PendingApproval;
}

/** Manages local MCP discovery caching, policy updates, inspection, and risk-gated E2EE calls. */
export class DeviceMcpProxy {
  private readonly store: Store;
  private readonly getConfig: () => DeviceConfig | null;
  private readonly getDevice: (deviceId: string) => DeviceTwin | null;
  private readonly listDevices: () => DeviceTwin[];
  private readonly saveDevice: (twin: DeviceTwin) => DeviceTwin;
  private readonly getRelayClient: () => RelayClient | null;
  private readonly dispatchTier1Rpc: (
    twin: DeviceTwin,
    request: DeviceInvokeRequest,
  ) => Promise<DeviceInvokeResult>;
  private readonly createPendingApproval: (
    clusterId: string,
    deviceId: string,
    action: string,
    params: Record<string, unknown>,
    request: DeviceInvokeRequest,
  ) => PendingApproval;

  constructor(options: DeviceMcpProxyOptions) {
    this.store = options.store;
    this.getConfig = options.getConfig;
    this.getDevice = options.getDevice;
    this.listDevices = options.listDevices;
    this.saveDevice = options.saveDevice;
    this.getRelayClient = options.getRelayClient;
    this.dispatchTier1Rpc = options.dispatchTier1Rpc;
    this.createPendingApproval = options.createPendingApproval;
  }

  private kvKey(deviceId: string): string {
    return `${DEVICE_MCP_KEY_PREFIX}${deviceId}`;
  }

  private loadRecord(deviceId: string): DeviceMcpCatalogRecord | null {
    return this.store.get<DeviceMcpCatalogRecord>(this.kvKey(deviceId)) ?? null;
  }

  private saveRecord(record: DeviceMcpCatalogRecord): DeviceMcpCatalogRecord {
    this.store.set(this.kvKey(record.deviceId), record);
    return record;
  }

  private syncTwinManifestSummary(deviceId: string, summary: McpSummary): void {
    const twin = this.getDevice(deviceId);
    if (!twin || twin.tier !== "os" || !twin.manifest) {
      return;
    }
    // Only lightweight `McpSummary` is written to `twin.manifest`; full tool schemas stay in `device-mcp:<id>`.
    this.saveDevice({
      ...twin,
      manifest: {
        ...twin.manifest,
        mcp_summary: summary,
      },
    });
  }

  private isOnlineAndReachable(twin: DeviceTwin): boolean {
    if (twin.tier !== "os" || twin.status === "offline") {
      return false;
    }
    return (
      (twin.route === "lan" && Boolean(twin.lanUrl)) ||
      Boolean(this.getRelayClient()?.isRelayConnected())
    );
  }

  private requireTier1Ready(
    deviceId: string,
    actionLabel: string,
  ): { cfg: DeviceConfig; twin: DeviceTwin } {
    const cfg = this.getConfig();
    if (!cfg || !cfg.enabled) {
      throw new Error("Device control plane is not configured");
    }
    const twin = this.getDevice(deviceId);
    if (!twin) {
      throw new Error(`Unknown device: ${deviceId}`);
    }
    if (twin.clusterId !== cfg.clusterId) {
      throw new Error(
        `Cross-cluster device ${actionLabel} rejected (${twin.clusterId} !== ${cfg.clusterId})`,
      );
    }
    if (twin.tier !== "os") {
      throw new Error(`MCP proxy is only supported on Tier 1 OS devices (${deviceId} is ${twin.tier})`);
    }
    if (twin.status === "offline") {
      throw new Error(`Device ${deviceId} is offline`);
    }
    if (!this.isOnlineAndReachable(twin)) {
      throw new Error("Relay client is not connected");
    }
    return { cfg, twin };
  }

  /** Whether a Tier 1 OS device advertises MCP discovery/proxy support. */
  isSupported(twin: DeviceTwin): boolean {
    return (
      twin.tier === "os" &&
      (twin.capabilities.includes("mcp_proxy") ||
        twin.capabilities.includes("mcp_discovery") ||
        twin.manifest?.mcp_summary !== undefined)
    );
  }

  /** Ingest lightweight `CapabilityManifest.mcp_summary` while preserving richer cached descriptors & tool schemas. */
  handleManifestSummary(
    deviceId: string,
    clusterId: string,
    summary: McpSummary,
  ): DeviceMcpCatalogRecord {
    const normalized = normalizeMcpSummary(summary) ?? summary;
    const prev = this.loadRecord(deviceId);
    const prevById = new Map<string, McpServerDescriptor>();
    if (prev) {
      for (let i = 0; i < prev.servers.length; i++) {
        const srv = prev.servers[i]!;
        prevById.set(srv.server_id, srv);
      }
    }
    const mergedServers = normalized.servers.map((item) =>
      summaryItemToDescriptor(item, prevById.get(item.server_id)),
    );
    const toolsByServer = preserveToolsByServer(prev, mergedServers);
    const record: DeviceMcpCatalogRecord = {
      deviceId,
      clusterId,
      discoveryMode: normalized.discovery_mode,
      catalogHash: normalized.catalog_hash,
      ...(prev?.scannedAtMs !== undefined ? { scannedAtMs: prev.scannedAtMs } : {}),
      updatedAt: nowIso(),
      servers: mergedServers,
      ...(prev?.warnings !== undefined ? { warnings: prev.warnings } : {}),
      toolsByServer,
      summary: normalized,
    };
    return this.saveRecord(record);
  }

  /** Handle uplink `DeviceMessage (kind: "event", body.event === "mcp.catalog_changed")`. */
  handleCatalogChangedEvent(
    deviceId: string,
    clusterId: string,
    body: Record<string, unknown>,
  ): DeviceMcpCatalogRecord {
    const prev = this.loadRecord(deviceId);
    const prevById = new Map<string, McpServerDescriptor>();
    if (prev) {
      for (let i = 0; i < prev.servers.length; i++) {
        const srv = prev.servers[i]!;
        prevById.set(srv.server_id, srv);
      }
    }

    const rawSummary = isRecord(body.summary)
      ? body.summary
      : isRecord(body.mcp_summary)
        ? body.mcp_summary
        : undefined;
    const parsedSummary = rawSummary ? normalizeMcpSummary(rawSummary) : undefined;

    let nextServers: McpServerDescriptor[];
    if (Array.isArray(body.servers)) {
      nextServers = [];
      for (let i = 0; i < body.servers.length; i++) {
        const rawSrv = body.servers[i];
        const rawId = isRecord(rawSrv) && typeof rawSrv.server_id === "string" ? rawSrv.server_id.trim() : "";
        const desc = normalizeMcpServerDescriptor(rawSrv, rawId ? prevById.get(rawId) : undefined);
        if (desc) nextServers.push(desc);
      }
    } else if (parsedSummary) {
      nextServers = parsedSummary.servers.map((item) =>
        summaryItemToDescriptor(item, prevById.get(item.server_id)),
      );
    } else {
      nextServers = prev?.servers ?? [];
    }

    const discoveryMode: McpDiscoveryMode = isMcpDiscoveryMode(body.discovery_mode)
      ? body.discovery_mode
      : isMcpDiscoveryMode(body.discoveryMode)
        ? body.discoveryMode
        : parsedSummary?.discovery_mode ?? prev?.discoveryMode ?? "disabled";

    const catalogHash =
      typeof body.catalog_hash === "string"
        ? body.catalog_hash
        : typeof body.catalogHash === "string"
          ? body.catalogHash
          : parsedSummary?.catalog_hash ?? prev?.catalogHash ?? "";

    const scannedAtMs =
      typeof body.scanned_at_ms === "number" && Number.isFinite(body.scanned_at_ms)
        ? body.scanned_at_ms
        : typeof body.scannedAtMs === "number" && Number.isFinite(body.scannedAtMs)
          ? body.scannedAtMs
          : prev?.scannedAtMs;

    const enabledFlag =
      typeof body.enabled === "boolean"
        ? body.enabled
        : parsedSummary?.enabled ?? prev?.summary?.enabled;

    const summary =
      parsedSummary && !Array.isArray(body.servers)
        ? parsedSummary
        : buildSummary({
            discoveryMode,
            catalogHash,
            servers: nextServers,
            ...(enabledFlag !== undefined ? { enabled: enabledFlag } : {}),
          });

    const toolsByServer = preserveToolsByServer(prev, nextServers);
    const record: DeviceMcpCatalogRecord = {
      deviceId,
      clusterId,
      discoveryMode,
      catalogHash,
      ...(scannedAtMs !== undefined ? { scannedAtMs } : {}),
      updatedAt: nowIso(),
      servers: nextServers,
      ...(prev?.warnings !== undefined ? { warnings: prev.warnings } : {}),
      toolsByServer,
      summary,
    };

    const saved = this.saveRecord(record);
    this.syncTwinManifestSummary(deviceId, summary);
    return saved;
  }

  /** Remove cached MCP catalog for a deleted device. */
  removeDevice(deviceId: string): void {
    this.store.delete(this.kvKey(deviceId));
  }

  /** Return cached MCP discovery overview for one device (falling back to manifest summary). */
  getOverview(deviceId: string): DeviceMcpOverview {
    const cfg = this.getConfig();
    const twin = this.getDevice(deviceId);
    if (!twin) {
      throw new Error(`Unknown device: ${deviceId}`);
    }
    if (cfg && twin.clusterId !== cfg.clusterId) {
      throw new Error(
        `Cross-cluster device MCP overview rejected (${twin.clusterId} !== ${cfg.clusterId})`,
      );
    }
    const supported = this.isSupported(twin);
    const record = this.loadRecord(deviceId);
    if (record) {
      const summary =
        record.summary ??
        buildSummary({
          discoveryMode: record.discoveryMode,
          catalogHash: record.catalogHash,
          servers: record.servers,
        });
      return {
        deviceId: twin.deviceId,
        ...(twin.customName !== undefined ? { customName: twin.customName } : {}),
        status: twin.status,
        supported,
        discoveryMode: record.discoveryMode,
        catalogHash: record.catalogHash,
        ...(record.scannedAtMs !== undefined ? { scannedAtMs: record.scannedAtMs } : {}),
        updatedAt: record.updatedAt,
        servers: record.servers,
        ...(record.warnings !== undefined ? { warnings: record.warnings } : {}),
        summary,
      };
    }

    const manifestSummary = twin.manifest?.mcp_summary
      ? normalizeMcpSummary(twin.manifest.mcp_summary)
      : undefined;
    if (manifestSummary) {
      return {
        deviceId: twin.deviceId,
        ...(twin.customName !== undefined ? { customName: twin.customName } : {}),
        status: twin.status,
        supported,
        discoveryMode: manifestSummary.discovery_mode,
        catalogHash: manifestSummary.catalog_hash,
        updatedAt: twin.updatedAt,
        servers: manifestSummary.servers.map((item) => summaryItemToDescriptor(item)),
        summary: manifestSummary,
      };
    }

    return {
      deviceId: twin.deviceId,
      ...(twin.customName !== undefined ? { customName: twin.customName } : {}),
      status: twin.status,
      supported,
      discoveryMode: "disabled",
      catalogHash: "",
      updatedAt: twin.updatedAt,
      servers: [],
    };
  }

  /** Summarize MCP discovery across all paired Tier 1 OS devices in the active cluster. */
  listAllOverview(): DeviceMcpOverview[] {
    const cfg = this.getConfig();
    const devices = this.listDevices();
    const out: DeviceMcpOverview[] = [];
    for (let i = 0; i < devices.length; i++) {
      const twin = devices[i]!;
      if (twin.tier !== "os") continue;
      if (cfg && twin.clusterId !== cfg.clusterId) continue;
      out.push(this.getOverview(twin.deviceId));
    }
    return out;
  }

  /** Persist a refreshed server list returned by `mcp.discover` or `mcp.list`. */
  private applyCatalogRpcResult(
    deviceId: string,
    clusterId: string,
    rawResult: unknown,
  ): DeviceMcpCatalogRecord {
    const prev = this.loadRecord(deviceId);
    const prevById = new Map<string, McpServerDescriptor>();
    if (prev) {
      for (let i = 0; i < prev.servers.length; i++) {
        const srv = prev.servers[i]!;
        prevById.set(srv.server_id, srv);
      }
    }

    const res = isRecord(rawResult) ? rawResult : {};
    const parsedSummary = isRecord(res.summary)
      ? normalizeMcpSummary(res.summary)
      : isRecord(res.mcp_summary)
        ? normalizeMcpSummary(res.mcp_summary)
        : undefined;

    const rawServers = Array.isArray(res.servers)
      ? res.servers
      : Array.isArray(rawResult)
        ? rawResult
        : undefined;

    let servers: McpServerDescriptor[];
    if (rawServers) {
      servers = [];
      for (let i = 0; i < rawServers.length; i++) {
        const item = rawServers[i];
        const rawId = isRecord(item) && typeof item.server_id === "string" ? item.server_id.trim() : "";
        const desc = normalizeMcpServerDescriptor(item, rawId ? prevById.get(rawId) : undefined);
        if (desc) servers.push(desc);
      }
    } else if (parsedSummary) {
      servers = parsedSummary.servers.map((item) =>
        summaryItemToDescriptor(item, prevById.get(item.server_id)),
      );
    } else {
      servers = prev?.servers ?? [];
    }

    const discoveryMode: McpDiscoveryMode = isMcpDiscoveryMode(res.discovery_mode)
      ? res.discovery_mode
      : isMcpDiscoveryMode(res.discoveryMode)
        ? res.discoveryMode
        : parsedSummary?.discovery_mode ?? prev?.discoveryMode ?? "configs_only";

    const catalogHash =
      typeof res.catalog_hash === "string"
        ? res.catalog_hash
        : typeof res.catalogHash === "string"
          ? res.catalogHash
          : parsedSummary?.catalog_hash ?? prev?.catalogHash ?? "";

    const scannedAtMs =
      typeof res.scanned_at_ms === "number" && Number.isFinite(res.scanned_at_ms)
        ? res.scanned_at_ms
        : typeof res.scannedAtMs === "number" && Number.isFinite(res.scannedAtMs)
          ? res.scannedAtMs
          : Date.now();

    const enabledFlag =
      typeof res.enabled === "boolean" ? res.enabled : parsedSummary?.enabled;
    const warnings = Array.isArray(res.warnings)
      ? res.warnings.filter((w): w is string => typeof w === "string")
      : prev?.warnings;

    const summary = buildSummary({
      discoveryMode,
      catalogHash,
      servers,
      ...(enabledFlag !== undefined ? { enabled: enabledFlag } : {}),
    });

    const toolsByServer = preserveToolsByServer(prev, servers);
    const record: DeviceMcpCatalogRecord = {
      deviceId,
      clusterId,
      discoveryMode,
      catalogHash,
      scannedAtMs,
      updatedAt: nowIso(),
      servers,
      ...(warnings !== undefined ? { warnings } : {}),
      toolsByServer,
      summary,
    };

    const saved = this.saveRecord(record);
    this.syncTwinManifestSummary(deviceId, summary);
    return saved;
  }

  /** Trigger live MCP discovery (`mcp.discover`) on a paired Tier 1 OS device and persist descriptors. */
  async discover(
    deviceId: string,
    opts: DeviceMcpDiscoverOptions = {},
  ): Promise<DeviceMcpOverview> {
    const { cfg, twin } = this.requireTier1Ready(deviceId, "MCP discovery");
    const params: Record<string, unknown> = {};
    if (opts.includeLoopbackProbe !== undefined) {
      params.include_loopback_probe = opts.includeLoopbackProbe;
    }
    if (opts.sources !== undefined) {
      params.sources = opts.sources;
    }

    const rpcRes = await this.dispatchTier1Rpc(twin, {
      action: "mcp.discover",
      params,
      timeoutMs: opts.timeoutMs ?? DEFAULT_MCP_DISCOVER_TIMEOUT_MS,
    });
    if (rpcRes.status !== "ok") {
      const err = rpcRes.status === "rejected" ? rpcRes.error : `Unexpected RPC status: ${rpcRes.status}`;
      throw new Error(formatUnsupportedError(deviceId, "mcp.discover", err));
    }

    this.applyCatalogRpcResult(deviceId, cfg.clusterId, rpcRes.result);
    return this.getOverview(deviceId);
  }

  /** List MCP servers for a device (refreshing via `mcp.discover`, fetching `mcp.list` if empty & online, or returning cache). */
  async list(deviceId: string, opts: DeviceMcpListOptions = {}): Promise<DeviceMcpOverview> {
    const cfg = this.getConfig();
    const twin = this.getDevice(deviceId);
    if (!twin) {
      throw new Error(`Unknown device: ${deviceId}`);
    }
    if (cfg && twin.clusterId !== cfg.clusterId) {
      throw new Error(`Cross-cluster device MCP list rejected (${twin.clusterId} !== ${cfg.clusterId})`);
    }
    if (opts.refresh === true) {
      return await this.discover(deviceId, {
        includeLoopbackProbe: opts.includeLoopbackProbe,
        timeoutMs: opts.timeoutMs,
      });
    }

    const cached = this.loadRecord(deviceId);
    const cacheEmpty =
      !cached ||
      (cached.servers.length === 0 && !cached.catalogHash && cached.scannedAtMs === undefined);
    if (cacheEmpty && cfg?.enabled && this.isSupported(twin) && this.isOnlineAndReachable(twin)) {
      const rpcRes = await this.dispatchTier1Rpc(twin, {
        action: "mcp.list",
        params: {},
        timeoutMs: opts.timeoutMs ?? DEFAULT_MCP_LIST_TIMEOUT_MS,
      });
      if (rpcRes.status !== "ok") {
        const err = rpcRes.status === "rejected" ? rpcRes.error : `Unexpected RPC status: ${rpcRes.status}`;
        throw new Error(formatUnsupportedError(deviceId, "mcp.list", err));
      }
      this.applyCatalogRpcResult(deviceId, cfg.clusterId, rpcRes.result);
    }

    return this.getOverview(deviceId);
  }

  /** Inspect tools (and optional resources/prompts) of one local MCP server with KV caching & client-side query filtering. */
  async inspect(
    deviceId: string,
    serverId: string,
    opts: DeviceMcpInspectOptions = {},
  ): Promise<DeviceMcpInspectResult> {
    const cleanServerId = serverId.trim();
    if (!cleanServerId) {
      throw new Error("serverId is required");
    }
    const cfg = this.getConfig();
    const twin = this.getDevice(deviceId);
    if (!twin) {
      throw new Error(`Unknown device: ${deviceId}`);
    }
    if (cfg && twin.clusterId !== cfg.clusterId) {
      throw new Error(`Cross-cluster device MCP inspect rejected (${twin.clusterId} !== ${cfg.clusterId})`);
    }
    if (twin.tier !== "os") {
      throw new Error(`MCP proxy is only supported on Tier 1 OS devices (${deviceId} is ${twin.tier})`);
    }

    const existingRecord = this.loadRecord(deviceId);
    const cachedEntry = existingRecord?.toolsByServer?.[cleanServerId];
    const needsRemote =
      opts.refresh === true ||
      !cachedEntry ||
      (opts.includeResources === true && cachedEntry.resources === undefined) ||
      (opts.includePrompts === true && cachedEntry.prompts === undefined);

    if (!needsRemote && cachedEntry) {
      const server = existingRecord?.servers.find((s) => s.server_id === cleanServerId);
      const { tools, filtered } = filterToolsByQuery(cachedEntry.tools, opts.query);
      return {
        deviceId,
        serverId: cleanServerId,
        ...(server ? { server } : {}),
        tools,
        totalTools: cachedEntry.tools.length,
        filtered,
        ...(cachedEntry.resources !== undefined ? { resources: cachedEntry.resources } : {}),
        ...(cachedEntry.prompts !== undefined ? { prompts: cachedEntry.prompts } : {}),
        ...(cachedEntry.toolsSchemaHash !== undefined ? { toolsSchemaHash: cachedEntry.toolsSchemaHash } : {}),
        ...(cachedEntry.serverInfo !== undefined ? { serverInfo: cachedEntry.serverInfo } : {}),
        ...(cachedEntry.protocolVersion !== undefined ? { protocolVersion: cachedEntry.protocolVersion } : {}),
        cached: true,
        inspectedAt: cachedEntry.inspectedAt,
      };
    }

    const { cfg: activeCfg, twin: activeTwin } = this.requireTier1Ready(deviceId, "MCP inspect");
    const params: Record<string, unknown> = {
      server_id: cleanServerId,
      ...(opts.includeResources !== undefined ? { include_resources: opts.includeResources } : {}),
      ...(opts.includePrompts !== undefined ? { include_prompts: opts.includePrompts } : {}),
      ...(opts.refresh !== undefined ? { refresh: opts.refresh } : {}),
    };

    const rpcRes = await this.dispatchTier1Rpc(activeTwin, {
      action: "mcp.inspect",
      params,
      timeoutMs: opts.timeoutMs ?? DEFAULT_MCP_INSPECT_TIMEOUT_MS,
    });
    if (rpcRes.status !== "ok") {
      const err = rpcRes.status === "rejected" ? rpcRes.error : `Unexpected RPC status: ${rpcRes.status}`;
      throw new Error(formatUnsupportedError(deviceId, "mcp.inspect", err));
    }

    const res = isRecord(rpcRes.result) ? rpcRes.result : {};
    const rawTools = Array.isArray(res.tools) ? res.tools : [];
    const normalizedTools: McpToolInfo[] = [];
    for (let i = 0; i < rawTools.length; i++) {
      const t = normalizeMcpToolInfo(rawTools[i]);
      if (t) normalizedTools.push(t);
    }

    const resources = Array.isArray(res.resources)
      ? res.resources
      : cachedEntry?.resources;
    const prompts = Array.isArray(res.prompts)
      ? res.prompts
      : cachedEntry?.prompts;
    const toolsSchemaHash =
      typeof res.tools_schema_hash === "string"
        ? res.tools_schema_hash
        : typeof res.toolsSchemaHash === "string"
          ? res.toolsSchemaHash
          : undefined;
    const serverInfo = isRecord(res.server_info)
      ? res.server_info
      : isRecord(res.serverInfo)
        ? res.serverInfo
        : undefined;
    const protocolVersion =
      typeof res.protocol_version === "string"
        ? res.protocol_version
        : typeof res.protocolVersion === "string"
          ? res.protocolVersion
          : undefined;
    const inspectedAt = nowIso();

    const inspectedRecord: McpInspectedServerRecord = {
      tools: normalizedTools,
      ...(resources !== undefined ? { resources } : {}),
      ...(prompts !== undefined ? { prompts } : {}),
      ...(toolsSchemaHash !== undefined ? { toolsSchemaHash } : {}),
      ...(serverInfo !== undefined ? { serverInfo } : {}),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      inspectedAt,
    };

    const prev = this.loadRecord(deviceId);
    const nextServers = prev ? [...prev.servers] : [];
    const existingIdx = nextServers.findIndex((s) => s.server_id === cleanServerId);
    const prevServer = existingIdx >= 0 ? nextServers[existingIdx] : undefined;

    let updatedServer: McpServerDescriptor | undefined = prevServer;
    if (isRecord(res.server)) {
      const normalizedDesc = normalizeMcpServerDescriptor(res.server, prevServer);
      if (normalizedDesc) {
        updatedServer = {
          ...normalizedDesc,
          tool_count: normalizedDesc.tool_count ?? normalizedTools.length,
        };
      }
    } else if (prevServer) {
      updatedServer = {
        ...prevServer,
        tool_count: normalizedTools.length,
        ...(isMcpRuntimeState(res.runtime_state) ? { runtime_state: res.runtime_state } : {}),
      };
    }

    if (updatedServer) {
      if (existingIdx >= 0) {
        nextServers[existingIdx] = updatedServer;
      } else {
        nextServers.push(updatedServer);
      }
    }

    const discoveryMode =
      prev?.discoveryMode ?? activeTwin.manifest?.mcp_summary?.discovery_mode ?? "configs_only";
    const catalogHash = prev?.catalogHash ?? activeTwin.manifest?.mcp_summary?.catalog_hash ?? "";
    const summary = buildSummary({
      discoveryMode,
      catalogHash,
      servers: nextServers,
      enabled: prev?.summary?.enabled ?? activeTwin.manifest?.mcp_summary?.enabled,
    });

    const nextRecord: DeviceMcpCatalogRecord = {
      deviceId,
      clusterId: activeCfg.clusterId,
      discoveryMode,
      catalogHash,
      ...(prev?.scannedAtMs !== undefined ? { scannedAtMs: prev.scannedAtMs } : {}),
      updatedAt: inspectedAt,
      servers: nextServers,
      ...(prev?.warnings !== undefined ? { warnings: prev.warnings } : {}),
      toolsByServer: {
        ...(prev?.toolsByServer ?? {}),
        [cleanServerId]: inspectedRecord,
      },
      summary,
    };
    this.saveRecord(nextRecord);
    if (nextServers.length > 0) {
      this.syncTwinManifestSummary(deviceId, summary);
    }

    const { tools, filtered } = filterToolsByQuery(normalizedTools, opts.query);
    return {
      deviceId,
      serverId: cleanServerId,
      ...(updatedServer ? { server: updatedServer } : {}),
      tools,
      totalTools: normalizedTools.length,
      filtered,
      ...(resources !== undefined ? { resources } : {}),
      ...(prompts !== undefined ? { prompts } : {}),
      ...(toolsSchemaHash !== undefined ? { toolsSchemaHash } : {}),
      ...(serverInfo !== undefined ? { serverInfo } : {}),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      cached: false,
      inspectedAt,
    };
  }

  /** Update a local MCP server's trust (`enabled`) and/or `callMode` policy via `mcp.server.set_policy`. */
  async setServerPolicy(
    deviceId: string,
    serverId: string,
    input: DeviceMcpPolicyUpdateInput,
  ): Promise<DeviceMcpPolicyUpdateResult> {
    const cleanServerId = serverId.trim();
    if (!cleanServerId) {
      throw new Error("serverId is required");
    }
    if (input.enabled === undefined && input.callMode === undefined) {
      throw new Error("At least one of enabled or callMode is required");
    }
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    if (input.callMode !== undefined && !isMcpCallPolicyMode(input.callMode)) {
      throw new Error(`Invalid callMode '${String(input.callMode)}'`);
    }

    const { cfg, twin } = this.requireTier1Ready(deviceId, "MCP server policy update");
    const params: Record<string, unknown> = {
      server_id: cleanServerId,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.callMode !== undefined ? { call_mode: input.callMode } : {}),
    };

    const rpcRes = await this.dispatchTier1Rpc(twin, {
      action: "mcp.server.set_policy",
      params,
      timeoutMs: input.timeoutMs ?? DEFAULT_MCP_POLICY_TIMEOUT_MS,
    });
    if (rpcRes.status !== "ok") {
      const err = rpcRes.status === "rejected" ? rpcRes.error : `Unexpected RPC status: ${rpcRes.status}`;
      // Preserve locked error verbatim so HTTP routes can map it to 403.
      throw new Error(formatUnsupportedError(deviceId, "mcp.server.set_policy", err));
    }

    const res = isRecord(rpcRes.result) ? rpcRes.result : {};
    const persisted = typeof res.persisted === "boolean" ? res.persisted : undefined;
    const { server, summary } = this.updateCachedServerAfterMutation(deviceId, cfg.clusterId, cleanServerId, res, {
      ...(input.enabled !== undefined ? { trust_state: input.enabled ? "enabled" : "disabled" } : {}),
      ...(input.callMode !== undefined ? { call_mode: input.callMode } : {}),
    });

    return {
      deviceId,
      serverId: cleanServerId,
      ...(server ? { server } : {}),
      ...(persisted !== undefined ? { persisted } : {}),
      ...(summary ? { summary } : {}),
      result: rpcRes.result,
    };
  }

  /** Stop a running local MCP server session via `mcp.server.stop`. */
  async stopServer(
    deviceId: string,
    serverId: string,
    timeoutMs?: number,
  ): Promise<DeviceMcpServerActionResult> {
    const cleanServerId = serverId.trim();
    if (!cleanServerId) {
      throw new Error("serverId is required");
    }
    const { cfg, twin } = this.requireTier1Ready(deviceId, "MCP server stop");
    const rpcRes = await this.dispatchTier1Rpc(twin, {
      action: "mcp.server.stop",
      params: { server_id: cleanServerId },
      timeoutMs: timeoutMs ?? DEFAULT_MCP_LIFECYCLE_TIMEOUT_MS,
    });
    if (rpcRes.status !== "ok") {
      const err = rpcRes.status === "rejected" ? rpcRes.error : `Unexpected RPC status: ${rpcRes.status}`;
      throw new Error(formatUnsupportedError(deviceId, "mcp.server.stop", err));
    }
    const res = isRecord(rpcRes.result) ? rpcRes.result : {};
    const { server, summary } = this.updateCachedServerAfterMutation(deviceId, cfg.clusterId, cleanServerId, res, {
      runtime_state: "stopped",
    });
    const stopped = typeof res.stopped === "boolean" ? res.stopped : true;
    const runtimeState: McpRuntimeState =
      server?.runtime_state ?? (isMcpRuntimeState(res.runtime_state) ? res.runtime_state : "stopped");
    return {
      deviceId,
      serverId: cleanServerId,
      action: "stop",
      stopped,
      runtimeState,
      ...(server ? { server } : {}),
      ...(summary ? { summary } : {}),
      result: rpcRes.result,
    };
  }

  /** Restart a local MCP server session via `mcp.server.restart`. */
  async restartServer(
    deviceId: string,
    serverId: string,
    timeoutMs?: number,
  ): Promise<DeviceMcpServerActionResult> {
    const cleanServerId = serverId.trim();
    if (!cleanServerId) {
      throw new Error("serverId is required");
    }
    const { cfg, twin } = this.requireTier1Ready(deviceId, "MCP server restart");
    const rpcRes = await this.dispatchTier1Rpc(twin, {
      action: "mcp.server.restart",
      params: { server_id: cleanServerId },
      timeoutMs: timeoutMs ?? DEFAULT_MCP_DISCOVER_TIMEOUT_MS,
    });
    if (rpcRes.status !== "ok") {
      const err = rpcRes.status === "rejected" ? rpcRes.error : `Unexpected RPC status: ${rpcRes.status}`;
      throw new Error(formatUnsupportedError(deviceId, "mcp.server.restart", err));
    }
    const res = isRecord(rpcRes.result) ? rpcRes.result : {};
    const fallbackState: McpRuntimeState = isMcpRuntimeState(res.runtime_state)
      ? res.runtime_state
      : "running";
    const { server, summary } = this.updateCachedServerAfterMutation(deviceId, cfg.clusterId, cleanServerId, res, {
      runtime_state: fallbackState,
    });
    const restarted = typeof res.restarted === "boolean" ? res.restarted : true;
    const runtimeState: McpRuntimeState = server?.runtime_state ?? fallbackState;
    return {
      deviceId,
      serverId: cleanServerId,
      action: "restart",
      restarted,
      runtimeState,
      ...(server ? { server } : {}),
      ...(summary ? { summary } : {}),
      result: rpcRes.result,
    };
  }

  private updateCachedServerAfterMutation(
    deviceId: string,
    clusterId: string,
    serverId: string,
    res: Record<string, unknown>,
    fallbackPatch: Partial<Pick<McpServerDescriptor, "trust_state" | "call_mode" | "runtime_state">>,
  ): { server?: McpServerDescriptor; summary?: McpSummary } {
    const prev = this.loadRecord(deviceId);
    const twin = this.getDevice(deviceId);
    const baseServers = prev
      ? [...prev.servers]
      : twin?.manifest?.mcp_summary
        ? twin.manifest.mcp_summary.servers.map((item) => summaryItemToDescriptor(item))
        : [];
    const idx = baseServers.findIndex((s) => s.server_id === serverId);
    const existing = idx >= 0 ? baseServers[idx] : undefined;

    let updatedServer: McpServerDescriptor | undefined;
    if (isRecord(res.server)) {
      updatedServer = normalizeMcpServerDescriptor(res.server, existing) ?? undefined;
    } else if (existing) {
      updatedServer = {
        ...existing,
        ...(isMcpTrustState(res.trust_state)
          ? { trust_state: res.trust_state }
          : fallbackPatch.trust_state !== undefined
            ? { trust_state: fallbackPatch.trust_state }
            : {}),
        ...(isMcpCallPolicyMode(res.call_mode)
          ? { call_mode: res.call_mode }
          : fallbackPatch.call_mode !== undefined
            ? { call_mode: fallbackPatch.call_mode }
            : {}),
        ...(isMcpRuntimeState(res.runtime_state)
          ? { runtime_state: res.runtime_state }
          : fallbackPatch.runtime_state !== undefined
            ? { runtime_state: fallbackPatch.runtime_state }
            : {}),
      };
    }

    if (updatedServer) {
      if (idx >= 0) {
        baseServers[idx] = updatedServer;
      } else {
        baseServers.push(updatedServer);
      }
    }

    const returnedSummary = isRecord(res.summary)
      ? normalizeMcpSummary(res.summary)
      : isRecord(res.mcp_summary)
        ? normalizeMcpSummary(res.mcp_summary)
        : undefined;

    const discoveryMode =
      returnedSummary?.discovery_mode ??
      prev?.discoveryMode ??
      twin?.manifest?.mcp_summary?.discovery_mode ??
      "configs_only";
    const catalogHash =
      returnedSummary?.catalog_hash ??
      prev?.catalogHash ??
      twin?.manifest?.mcp_summary?.catalog_hash ??
      "";
    const summary =
      returnedSummary ??
      (baseServers.length > 0
        ? buildSummary({
            discoveryMode,
            catalogHash,
            servers: baseServers,
            enabled: prev?.summary?.enabled ?? twin?.manifest?.mcp_summary?.enabled,
          })
        : undefined);

    if (prev || updatedServer || summary) {
      const nextRecord: DeviceMcpCatalogRecord = {
        deviceId,
        clusterId,
        discoveryMode,
        catalogHash,
        ...(prev?.scannedAtMs !== undefined ? { scannedAtMs: prev.scannedAtMs } : {}),
        updatedAt: nowIso(),
        servers: baseServers,
        ...(prev?.warnings !== undefined ? { warnings: prev.warnings } : {}),
        toolsByServer: prev?.toolsByServer ?? {},
        ...(summary ? { summary } : {}),
      };
      this.saveRecord(nextRecord);
      if (summary) {
        this.syncTwinManifestSummary(deviceId, summary);
      }
    }

    return { server: updatedServer, summary };
  }

  /**
   * Call a tool, read a resource, or get a prompt on a local MCP server proxied via Tier 1.
   * Integrates directly with `DeviceManager`'s `PendingApproval` + `shortCode` flow when risk gating requires approval.
   */
  async callTool(deviceId: string, input: DeviceMcpCallInput): Promise<DeviceInvokeResult> {
    const action: McpCallAction = input.action ?? "tools/call";
    if (action !== "tools/call" && action !== "resources/read" && action !== "prompts/get") {
      return {
        status: "rejected",
        deviceId,
        action: "mcp.call",
        error: `Unsupported MCP action '${String(action)}': must be tools/call, resources/read, or prompts/get`,
      };
    }

    const rpcAction =
      action === "tools/call"
        ? "mcp.call"
        : action === "resources/read"
          ? "mcp.resource.read"
          : "mcp.prompt.get";

    const cfg = this.getConfig();
    if (!cfg || !cfg.enabled) {
      return {
        status: "rejected",
        deviceId,
        action: rpcAction,
        error: "Device control plane is not configured",
      };
    }

    const twin = this.getDevice(deviceId);
    if (!twin) {
      return {
        status: "rejected",
        deviceId,
        action: rpcAction,
        error: `Unknown device: ${deviceId}`,
      };
    }

    if (twin.clusterId !== cfg.clusterId) {
      return {
        status: "rejected",
        deviceId,
        action: rpcAction,
        error: `Cross-cluster device MCP invocation rejected (${twin.clusterId} !== ${cfg.clusterId})`,
      };
    }

    if (twin.tier !== "os") {
      return {
        status: "rejected",
        deviceId,
        action: rpcAction,
        error: `MCP proxy is only supported on Tier 1 OS devices (${deviceId} is ${twin.tier})`,
      };
    }

    const serverId = typeof input.serverId === "string" ? input.serverId.trim() : "";
    if (!serverId) {
      return {
        status: "rejected",
        deviceId,
        action: rpcAction,
        error: "serverId is required",
      };
    }

    // Validate operation-specific inputs before inspecting or creating approvals.
    let rpcParams: Record<string, unknown>;
    let toolName = "";
    if (action === "tools/call") {
      toolName = typeof input.toolName === "string" ? input.toolName.trim() : "";
      if (!toolName) {
        return {
          status: "rejected",
          deviceId,
          action: rpcAction,
          error: "toolName is required for tools/call",
        };
      }
      if (input.arguments !== undefined && !isRecord(input.arguments)) {
        return {
          status: "rejected",
          deviceId,
          action: rpcAction,
          error: "arguments must be a JSON object",
        };
      }
      rpcParams = {
        server_id: serverId,
        tool_name: toolName,
        arguments: input.arguments ?? {},
        ...(input.timeoutMs !== undefined ? { timeout_ms: input.timeoutMs } : {}),
      };
    } else if (action === "resources/read") {
      const uri = typeof input.uri === "string" ? input.uri.trim() : "";
      if (!uri) {
        return {
          status: "rejected",
          deviceId,
          action: rpcAction,
          error: "uri is required for resources/read",
        };
      }
      rpcParams = {
        server_id: serverId,
        uri,
        ...(input.timeoutMs !== undefined ? { timeout_ms: input.timeoutMs } : {}),
      };
    } else {
      const promptName = typeof input.promptName === "string" ? input.promptName.trim() : "";
      if (!promptName) {
        return {
          status: "rejected",
          deviceId,
          action: rpcAction,
          error: "promptName is required for prompts/get",
        };
      }
      if (input.arguments !== undefined && !isRecord(input.arguments)) {
        return {
          status: "rejected",
          deviceId,
          action: rpcAction,
          error: "arguments must be a JSON object",
        };
      }
      rpcParams = {
        server_id: serverId,
        name: promptName,
        prompt_name: promptName,
        ...(input.arguments !== undefined ? { arguments: input.arguments } : {}),
        ...(input.timeoutMs !== undefined ? { timeout_ms: input.timeoutMs } : {}),
      };
    }

    // Resolve server descriptor from KV cache or manifest summary (hydrating once via mcp.list if cache empty).
    let record = this.loadRecord(deviceId);
    let server: McpServerDescriptor | undefined = record?.servers.find(
      (s) => s.server_id === serverId,
    );
    if (!server && twin.manifest?.mcp_summary) {
      const summaryItem = twin.manifest.mcp_summary.servers.find((s) => s.server_id === serverId);
      if (summaryItem) {
        server = summaryItemToDescriptor(summaryItem);
      }
    }
    if (!server && !record && this.isSupported(twin) && this.isOnlineAndReachable(twin)) {
      try {
        await this.list(deviceId, { timeoutMs: Math.min(input.timeoutMs ?? DEFAULT_MCP_LIST_TIMEOUT_MS, 15_000) });
        record = this.loadRecord(deviceId);
        server = record?.servers.find((s) => s.server_id === serverId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isUnsupportedRpcError(msg) || msg.includes("does not support")) {
          return {
            status: "rejected",
            deviceId,
            action: rpcAction,
            error: msg,
          };
        }
      }
    }

    if (!server) {
      return {
        status: "rejected",
        deviceId,
        action: rpcAction,
        error: `Unknown MCP server: ${serverId}`,
      };
    }

    if (server.trust_state === "blocked_by_policy") {
      return {
        status: "rejected",
        deviceId,
        action: rpcAction,
        error: `MCP server '${serverId}' is blocked_by_policy (forbidden by security policy)`,
      };
    }
    if (server.trust_state === "disabled") {
      return {
        status: "rejected",
        deviceId,
        action: rpcAction,
        error: `MCP server '${serverId}' is disabled (forbidden by MCP policy)`,
      };
    }
    if (server.call_mode === "disabled") {
      return {
        status: "rejected",
        deviceId,
        action: rpcAction,
        error: `MCP server '${serverId}' call_mode is disabled (forbidden by MCP policy)`,
      };
    }

    // Look up cached tool annotations for tools/call (lazy inspect if server is enabled & uncached).
    let annotations: McpToolAnnotations | undefined;
    if (action === "tools/call") {
      let cachedServerTools = record?.toolsByServer?.[serverId];
      if (
        !cachedServerTools &&
        server.trust_state === "enabled" &&
        server.call_mode !== "confirm_all" &&
        this.isOnlineAndReachable(twin)
      ) {
        try {
          await this.inspect(deviceId, serverId, {
            timeoutMs: Math.min(input.timeoutMs ?? DEFAULT_MCP_INSPECT_TIMEOUT_MS, 30_000),
          });
          record = this.loadRecord(deviceId);
          cachedServerTools = record?.toolsByServer?.[serverId];
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (isUnsupportedRpcError(msg) || msg.includes("does not support")) {
            return {
              status: "rejected",
              deviceId,
              action: rpcAction,
              error: msg,
            };
          }
          // Fall back to treating annotations as unknown.
        }
      }
      annotations = cachedServerTools?.tools.find((t) => t.name === toolName)?.annotations;
    }

    const risk = classifyMcpCallRisk({
      action,
      trustState: server.trust_state,
      callMode: server.call_mode,
      sandboxLevel: twin.sandboxLevel,
      annotations,
    });

    if (risk === "forbidden") {
      return {
        status: "rejected",
        deviceId,
        action: rpcAction,
        error: `MCP call on server '${serverId}' is forbidden by security policy`,
      };
    }

    if (risk === "confirm_required") {
      const approval = this.createPendingApproval(cfg.clusterId, deviceId, rpcAction, rpcParams, {
        action: rpcAction,
        params: rpcParams,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
      return {
        status: "pending_approval",
        approvalId: approval.id,
        shortCode: approval.shortCode,
        deviceId,
        action: rpcAction,
        params: rpcParams,
      };
    }

    const rpcRes = await this.dispatchTier1Rpc(twin, {
      action: rpcAction,
      params: rpcParams,
      timeoutMs: input.timeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    if (rpcRes.status === "rejected" && isUnsupportedRpcError(rpcRes.error)) {
      return {
        ...rpcRes,
        error: formatUnsupportedError(deviceId, rpcAction, rpcRes.error),
      };
    }
    return rpcRes;
  }
}
