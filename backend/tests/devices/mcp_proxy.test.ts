import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { App, defaultTimings } from "../../src/app/index.ts";
import { mainSpecs, workerSpecs } from "../../src/app/tools.ts";
import { Protocol } from "../../src/app/wechat_protocol.ts";
import {
  DEVICE_MCP_KEY_PREFIX,
  DeviceManager,
  FLAG_DATA,
  FLAG_PING,
  FLAG_PONG,
  classifyMcpCallRisk,
  decodeRelayFrame,
  encodeRelayFrame,
  normalizeMcpServerDescriptor,
  openDeviceMessage,
  sealDeviceMessage,
  type DeviceMcpCatalogRecord,
  type DeviceTwin,
  type McpServerDescriptor,
  type McpSummary,
  type McpToolInfo,
  type RelaySocket,
} from "../../src/devices/index.ts";
import { Request, handle } from "../../src/http/index.ts";
import { Store } from "../../src/store/index.ts";
import { TempDir } from "../../src/testkit/index.ts";
import { Scripted, ScriptedKernels } from "../app/common.ts";

class MockRelaySocket implements RelaySocket {
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  readonly sent: Array<string | Uint8Array | ArrayBuffer> = [];
  onSend?: (data: string | Uint8Array | ArrayBuffer) => void;
  closed = false;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    this.sent.push(data);
    this.onSend?.(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.closed = true;
    this.onclose?.({ code, reason });
  }
}

function makeMockSockets(onRelaySend?: (sock: MockRelaySocket, data: Uint8Array) => void) {
  const sockets: MockRelaySocket[] = [];
  const wsFactory = (url: string, headers: Record<string, string>) => {
    const ws = new MockRelaySocket(url, headers);
    if (url.endsWith("/v1/relay") && onRelaySend) {
      ws.onSend = (data) => {
        if (data instanceof Uint8Array) {
          onRelaySend(ws, data);
        }
      };
    }
    sockets.push(ws);
    queueMicrotask(() => {
      if (!ws.closed) ws.open();
    });
    return ws;
  };
  return { sockets, wsFactory };
}

function makeRequest(
  method: string,
  reqPath: string,
  body?: unknown,
  query = "",
): Request {
  const headers = new Map<string, string>([["host", "127.0.0.1:3082"]]);
  let bytes = new Uint8Array(0);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    bytes = new TextEncoder().encode(JSON.stringify(body));
  }
  return new Request({ method, path: reqPath, query, headers, body: bytes });
}

interface MockRpcCall {
  method: string;
  params: Record<string, unknown>;
}

async function createMockAgentHarness(
  handler: (
    method: string,
    params: Record<string, unknown>,
    deviceId: string,
  ) => Record<string, unknown>,
  opts: {
    store?: Store;
    clusterId?: string;
    masterId?: string;
    e2eKey?: string;
  } = {},
) {
  const store = opts.store ?? Store.memory();
  const clusterId = opts.clusterId ?? "cluster-mcp";
  const masterId = opts.masterId ?? "master-mcp";
  const e2eKey = opts.e2eKey ?? "mcp-e2e-secret-key";
  const rpcCalls: MockRpcCall[] = [];

  const { wsFactory } = makeMockSockets((sock, raw) => {
    const frame = decodeRelayFrame(raw);
    if (frame.flags !== FLAG_DATA) return;
    const dst = frame.dst;
    const msg = openDeviceMessage(frame.payload, e2eKey, clusterId, masterId, dst);
    if (msg.kind !== "rpc_req") return;
    const method = String(msg.body.method ?? "");
    const params = (msg.body.params ?? {}) as Record<string, unknown>;
    rpcCalls.push({ method, params });

    const body = handler(method, params, dst);
    const respWire = sealDeviceMessage(
      {
        v: 1,
        kind: "rpc_resp",
        req_id: msg.req_id,
        cluster_id: clusterId,
        device_id: dst,
        ts_ms: Date.now(),
        body,
      },
      e2eKey,
      dst,
      masterId,
    );
    queueMicrotask(() => {
      sock.emitMessage(
        encodeRelayFrame({
          flags: FLAG_DATA,
          src: dst,
          dst: masterId,
          payload: respWire,
        }),
      );
    });
  });

  const manager = new DeviceManager({
    store,
    masterId: "mcp",
    fetchFn: (async () =>
      new Response(JSON.stringify({ cluster_id: clusterId }), { status: 200 })) as unknown as typeof fetch,
    wsFactory,
    pingIntervalMs: 0,
  });

  await manager.configure(
    {
      clusterId,
      masterNodeId: masterId,
      relayUrl: "https://relay.local:18443",
      relaySecret: "relay-secret",
      e2eKey,
    },
    { connect: true },
  );

  return { store, manager, clusterId, masterId, e2eKey, rpcCalls };
}

function sampleServers(): McpServerDescriptor[] {
  return [
    {
      server_id: "cursor:github",
      name: "github",
      source: "cursor",
      source_path: "~/.cursor/mcp.json",
      transport: "stdio",
      command_preview: "npx -y @modelcontextprotocol/server-github",
      url_sanitized: null,
      env_keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      auth_required: true,
      trust_state: "enabled",
      call_mode: "auto_readonly",
      runtime_state: "stopped",
      tool_count: 3,
      dedup_key: "stdio:npx:-y:@modelcontextprotocol/server-github",
      duplicate_of: null,
      fingerprint: "sha256:github-v1",
      last_error: null,
      discovered_at_ms: 1700000000000,
    },
    {
      server_id: "neo:local-db",
      name: "local-db",
      source: "neo",
      source_path: "~/.config/neo-agent/mcp.d/db.json",
      transport: "streamable_http",
      command_preview: null,
      url_sanitized: "http://127.0.0.1:8787/mcp",
      env_keys: [],
      auth_required: false,
      trust_state: "discovered",
      call_mode: "confirm_all",
      runtime_state: "stopped",
      tool_count: null,
      dedup_key: "streamable_http:http://127.0.0.1:8787/mcp",
      duplicate_of: null,
      fingerprint: "sha256:db-v1",
      last_error: null,
      discovered_at_ms: 1700000000100,
    },
  ];
}

function sampleGithubTools(): McpToolInfo[] {
  return [
    {
      name: "list_issues",
      description: "List GitHub issues in a repository",
      inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "create_issue",
      description: "Create a new GitHub issue",
      inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: "delete_repository",
      description: "Permanently delete a repository",
      inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "ambiguous_readonly_destructive",
      description: "Contradictory annotations tool",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: true },
    },
    {
      name: "unannotated_action",
      description: "Tool with no MCP annotations",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

describe("devices/mcp-proxy", () => {
  test("manifest mcp_summary ingestion, KV separation, secret stripping, mcp.catalog_changed fingerprint invalidation, and removeDevice cleanup", async () => {
    const store = Store.memory();
    const { manager, clusterId, e2eKey } = await createMockAgentHarness(
      (method) => {
        if (method === "mcp.inspect") {
          return {
            ok: true,
            result: {
              tools: sampleGithubTools(),
              tools_schema_hash: "sha256:tools-v1",
              protocol_version: "2025-03-26",
              server_info: { name: "github-mcp", version: "1.2.3" },
            },
          };
        }
        return { ok: false, error: `unexpected method: ${method}` };
      },
      { store },
    );

    // Secret-stripping check on descriptor normalizer
    const stripped = normalizeMcpServerDescriptor({
      server_id: "cursor:secret-test",
      name: "secret-test",
      source: "cursor",
      transport: "stdio",
      env_keys: ["API_KEY"],
      env: { API_KEY: "super-secret-token" },
      headers: { Authorization: "Bearer super-secret" },
      token: "leak-me",
      auth_required: true,
      trust_state: "discovered",
      call_mode: "auto_readonly",
      runtime_state: "stopped",
    });
    expect(stripped).not.toBeNull();
    expect("env" in (stripped as unknown as Record<string, unknown>)).toBe(false);
    expect("headers" in (stripped as unknown as Record<string, unknown>)).toBe(false);
    expect("token" in (stripped as unknown as Record<string, unknown>)).toBe(false);
    expect(stripped?.env_keys).toEqual(["API_KEY"]);

    // 1. Ingest manifest with mcp_summary over E2E DeviceMessage
    const summary: McpSummary = {
      enabled: true,
      discovery_mode: "configs_only",
      discovered_count: 2,
      enabled_count: 1,
      running_count: 0,
      catalog_hash: "cat-hash-1",
      servers: [
        {
          server_id: "cursor:github",
          name: "github",
          source: "cursor",
          transport: "stdio",
          trust_state: "enabled",
          call_mode: "auto_readonly",
          runtime_state: "stopped",
          tool_count: 5,
        },
        {
          server_id: "neo:local-db",
          name: "local-db",
          source: "neo",
          transport: "streamable_http",
          trust_state: "discovered",
          call_mode: "confirm_all",
          runtime_state: "stopped",
          tool_count: null,
        },
      ],
    };

    manager.handleDeviceMessage("os-mac", {
      v: 1,
      kind: "manifest",
      req_id: "m-1",
      cluster_id: clusterId,
      device_id: "os-mac",
      ts_ms: Date.now(),
      body: {
        device_id: "os-mac",
        tier: "os",
        os: "macos",
        arch: "arm64",
        capabilities: ["exec", "fs", "mcp_discovery", "mcp_proxy"],
        sandbox: { level: "personal" },
        mcp_summary: summary,
      },
    });

    const overview1 = manager.getDeviceMcp("os-mac");
    expect(overview1.supported).toBe(true);
    expect(overview1.discoveryMode).toBe("configs_only");
    expect(overview1.catalogHash).toBe("cat-hash-1");
    expect(overview1.servers.length).toBe(2);
    expect(overview1.summary?.discovered_count).toBe(2);

    // 2. Inspect cursor:github -> full schemas go ONLY to device-mcp:os-mac, NEVER device:os-mac
    const inspected = await manager.inspectDeviceMcp("os-mac", "cursor:github");
    expect(inspected.cached).toBe(false);
    expect(inspected.tools.length).toBe(5);
    expect(inspected.protocolVersion).toBe("2025-03-26");

    const rawDeviceTwin = store.get<DeviceTwin>("device:os-mac")!;
    const rawDeviceJson = JSON.stringify(rawDeviceTwin);
    expect(rawDeviceTwin.manifest?.mcp_summary?.catalog_hash).toBe("cat-hash-1");
    expect(rawDeviceJson).not.toContain("toolsByServer");
    expect(rawDeviceJson).not.toContain("inputSchema");

    const kvRecord = store.get<DeviceMcpCatalogRecord>(`${DEVICE_MCP_KEY_PREFIX}os-mac`)!;
    expect(kvRecord.toolsByServer["cursor:github"]?.tools.length).toBe(5);

    // 3. Re-ingesting manifest summary preserves richer inspected tools when server_id still exists
    manager.handleDeviceMessage("os-mac", {
      v: 1,
      kind: "manifest",
      req_id: "m-2",
      cluster_id: clusterId,
      device_id: "os-mac",
      ts_ms: Date.now(),
      body: {
        device_id: "os-mac",
        tier: "os",
        capabilities: ["exec", "mcp_discovery", "mcp_proxy"],
        mcp_summary: { ...summary, running_count: 1 },
      },
    });
    const kvAfterManifest = store.get<DeviceMcpCatalogRecord>(`${DEVICE_MCP_KEY_PREFIX}os-mac`)!;
    expect(kvAfterManifest.toolsByServer["cursor:github"]?.tools.length).toBe(5);

    // 4. Uplink mcp.catalog_changed event with descriptors:
    //    First set fingerprint on cursor:github & neo:local-db, then change only cursor:github's fingerprint
    manager.handleDeviceMessage("os-mac", {
      v: 1,
      kind: "event",
      req_id: "ev-1",
      cluster_id: clusterId,
      device_id: "os-mac",
      ts_ms: Date.now(),
      body: {
        event: "mcp.catalog_changed",
        discovery_mode: "configs_and_loopback",
        catalog_hash: "cat-hash-2",
        servers: sampleServers(),
      },
    });
    // Cached tools preserved (previous descriptor had no fingerprint yet)
    let kvAfterEv1 = store.get<DeviceMcpCatalogRecord>(`${DEVICE_MCP_KEY_PREFIX}os-mac`)!;
    expect(kvAfterEv1.catalogHash).toBe("cat-hash-2");
    expect(kvAfterEv1.discoveryMode).toBe("configs_and_loopback");
    expect(kvAfterEv1.toolsByServer["cursor:github"]?.tools.length).toBe(5);
    expect(manager.getDevice("os-mac")?.manifest?.mcp_summary?.catalog_hash).toBe("cat-hash-2");

    // Now send mcp.catalog_changed where cursor:github fingerprint CHANGED -> tools invalidated, neo:local-db removed
    manager.handleDeviceMessage("os-mac", {
      v: 1,
      kind: "event",
      req_id: "ev-2",
      cluster_id: clusterId,
      device_id: "os-mac",
      ts_ms: Date.now(),
      body: {
        event: "mcp.catalog_changed",
        discovery_mode: "configs_only",
        catalog_hash: "cat-hash-3",
        servers: [
          {
            ...sampleServers()[0]!,
            fingerprint: "sha256:github-v2-changed",
          },
        ],
      },
    });
    const kvAfterEv2 = store.get<DeviceMcpCatalogRecord>(`${DEVICE_MCP_KEY_PREFIX}os-mac`)!;
    expect(kvAfterEv2.catalogHash).toBe("cat-hash-3");
    expect(kvAfterEv2.servers.length).toBe(1);
    expect(kvAfterEv2.toolsByServer["cursor:github"]).toBeUndefined();
    expect(manager.getDevice("os-mac")?.manifest?.mcp_summary?.discovered_count).toBe(1);

    // 5. removeDevice cleans up device-mcp:<id>
    expect(manager.removeDevice("os-mac")).toBe(true);
    expect(store.get(`${DEVICE_MCP_KEY_PREFIX}os-mac`)).toBeUndefined();
    expect(() => manager.getDeviceMcp("os-mac")).toThrow("Unknown device: os-mac");

    // Suppress unused variable warning
    expect(e2eKey.length).toBeGreaterThan(0);

    await manager.stop();
    store.close();
  });

  test("discover, list, inspect (with KV cache & query filter), setServerPolicy (including locked), stop, and restart", async () => {
    let lockSandbox = false;
    let servers = sampleServers();

    const { store, manager, rpcCalls } = await createMockAgentHarness((method, params) => {
      if (method === "mcp.discover") {
        return {
          ok: true,
          result: {
            discovery_mode: params.include_loopback_probe ? "configs_and_loopback" : "configs_only",
            catalog_hash: "disc-hash-1",
            scanned_at_ms: 1700000100000,
            servers,
            warnings: ["skipped malformed config ~/.vscode/mcp.json"],
          },
        };
      }
      if (method === "mcp.list") {
        return {
          ok: true,
          result: {
            discovery_mode: "configs_only",
            catalog_hash: "list-hash-1",
            servers,
          },
        };
      }
      if (method === "mcp.inspect") {
        return {
          ok: true,
          result: {
            tools: sampleGithubTools(),
            ...(params.include_resources ? { resources: [{ uri: "repo://readme", name: "README" }] } : {}),
            ...(params.include_prompts ? { prompts: [{ name: "triage", description: "Triage issue" }] } : {}),
            tools_schema_hash: "sha256:gh-tools",
            protocol_version: "2025-03-26",
            runtime_state: "running",
          },
        };
      }
      if (method === "mcp.server.set_policy") {
        if (lockSandbox) {
          return {
            ok: false,
            error: "MCP policy modification rejected: local policy is locked (lock_sandbox = true)",
          };
        }
        const sid = String(params.server_id);
        servers = servers.map((s) =>
          s.server_id === sid
            ? {
                ...s,
                ...(typeof params.enabled === "boolean"
                  ? { trust_state: params.enabled ? "enabled" : "disabled" }
                  : {}),
                ...(typeof params.call_mode === "string"
                  ? { call_mode: params.call_mode as McpServerDescriptor["call_mode"] }
                  : {}),
              }
            : s,
        );
        const updated = servers.find((s) => s.server_id === sid);
        return { ok: true, result: { server: updated, persisted: true } };
      }
      if (method === "mcp.server.stop") {
        const sid = String(params.server_id);
        servers = servers.map((s) =>
          s.server_id === sid ? { ...s, runtime_state: "stopped" } : s,
        );
        return { ok: true, result: { server: servers.find((s) => s.server_id === sid) } };
      }
      if (method === "mcp.server.restart") {
        const sid = String(params.server_id);
        servers = servers.map((s) =>
          s.server_id === sid ? { ...s, runtime_state: "running" } : s,
        );
        return { ok: true, result: { server: servers.find((s) => s.server_id === sid) } };
      }
      return { ok: false, error: `unsupported RPC method: ${method}` };
    });

    manager.upsertDeviceManifest(
      {
        device_id: "os-linux",
        tier: "os",
        os: "linux",
        capabilities: ["exec", "mcp_discovery", "mcp_proxy"],
        sandbox: { level: "desktop" },
      },
      { status: "online" },
    );

    // 1. list() on empty cache when supported & online calls mcp.list
    const initialList = await manager.listDeviceMcp("os-linux");
    expect(initialList.servers.length).toBe(2);
    expect(initialList.catalogHash).toBe("list-hash-1");
    expect(rpcCalls.map((c) => c.method)).toEqual(["mcp.list"]);

    // 2. Subsequent list() without refresh hits cache (no extra RPC)
    const cachedList = await manager.listDeviceMcp("os-linux");
    expect(cachedList.servers.length).toBe(2);
    expect(rpcCalls.length).toBe(1);

    // 3. list({ refresh: true, includeLoopbackProbe: true }) triggers mcp.discover
    const refreshed = await manager.listDeviceMcp("os-linux", {
      refresh: true,
      includeLoopbackProbe: true,
    });
    expect(refreshed.discoveryMode).toBe("configs_and_loopback");
    expect(refreshed.catalogHash).toBe("disc-hash-1");
    expect(refreshed.warnings).toEqual(["skipped malformed config ~/.vscode/mcp.json"]);
    expect(rpcCalls[1]).toEqual({
      method: "mcp.discover",
      params: { include_loopback_probe: true },
    });
    expect(manager.getDevice("os-linux")?.manifest?.mcp_summary?.catalog_hash).toBe("disc-hash-1");

    // 4. discover() with explicit sources
    await manager.discoverDeviceMcp("os-linux", {
      includeLoopbackProbe: false,
      sources: ["cursor", "neo"],
    });
    expect(rpcCalls[2]).toEqual({
      method: "mcp.discover",
      params: { include_loopback_probe: false, sources: ["cursor", "neo"] },
    });

    // 5. inspect() fetches remote once, caches full tools, and filters client-side on query
    const insp1 = await manager.inspectDeviceMcp("os-linux", "cursor:github", { query: "ISSUE" });
    expect(insp1.cached).toBe(false);
    expect(insp1.filtered).toBe(true);
    expect(insp1.totalTools).toBe(5);
    expect(insp1.tools.map((t) => t.name)).toEqual(["list_issues", "create_issue"]);

    // Cache hit with different query -> zero new RPCs!
    const callsBefore = rpcCalls.length;
    const insp2 = await manager.inspectDeviceMcp("os-linux", "cursor:github", { query: "permanently" });
    expect(insp2.cached).toBe(true);
    expect(insp2.tools.map((t) => t.name)).toEqual(["delete_repository"]);
    expect(rpcCalls.length).toBe(callsBefore);

    // Requesting resources triggers remote inspect since resources weren't cached yet
    const insp3 = await manager.inspectDeviceMcp("os-linux", "cursor:github", {
      includeResources: true,
      includePrompts: true,
    });
    expect(insp3.cached).toBe(false);
    expect(insp3.resources?.length).toBe(1);
    expect(insp3.prompts?.length).toBe(1);

    // 6. setServerPolicy updates cached descriptor & manifest summary
    const pol = await manager.setDeviceMcpServerPolicy("os-linux", "neo:local-db", {
      enabled: true,
      callMode: "auto_readonly",
    });
    expect(pol.server?.trust_state).toBe("enabled");
    expect(pol.server?.call_mode).toBe("auto_readonly");
    expect(pol.persisted).toBe(true);
    expect(manager.getDevice("os-linux")?.manifest?.mcp_summary?.enabled_count).toBe(2);

    // Locked error preserved clearly
    lockSandbox = true;
    await expect(
      manager.setDeviceMcpServerPolicy("os-linux", "neo:local-db", { callMode: "auto_all" }),
    ).rejects.toThrow(/locked/i);
    lockSandbox = false;

    // 7. restartServer & stopServer update runtime_state in cache + manifest summary
    const restarted = await manager.restartDeviceMcpServer("os-linux", "cursor:github");
    expect(restarted.action).toBe("restart");
    expect(restarted.server?.runtime_state).toBe("running");
    expect(manager.getDevice("os-linux")?.manifest?.mcp_summary?.running_count).toBe(1);

    const stopped = await manager.stopDeviceMcpServer("os-linux", "cursor:github");
    expect(stopped.action).toBe("stop");
    expect(stopped.server?.runtime_state).toBe("stopped");
    expect(manager.getDevice("os-linux")?.manifest?.mcp_summary?.running_count).toBe(0);

    await manager.stop();
    store.close();
  });

  test("risk gating matrix & PendingApproval shortCode execution flow (tools/call, resources/read, prompts/get)", async () => {
    // Pure matrix verification
    expect(
      classifyMcpCallRisk({
        action: "tools/call",
        trustState: "blocked_by_policy",
        callMode: "auto_all",
        sandboxLevel: "unrestricted",
      }),
    ).toBe("forbidden");
    expect(
      classifyMcpCallRisk({
        action: "tools/call",
        trustState: "disabled",
        callMode: "auto_all",
        sandboxLevel: "unrestricted",
      }),
    ).toBe("forbidden");
    expect(
      classifyMcpCallRisk({
        action: "tools/call",
        trustState: "enabled",
        callMode: "disabled",
        sandboxLevel: "unrestricted",
      }),
    ).toBe("forbidden");
    expect(
      classifyMcpCallRisk({
        action: "tools/call",
        trustState: "enabled",
        callMode: "confirm_all",
        annotations: { readOnlyHint: true, destructiveHint: false },
      }),
    ).toBe("confirm_required");
    expect(
      classifyMcpCallRisk({
        action: "tools/call",
        trustState: "enabled",
        callMode: "auto_readonly",
        annotations: { readOnlyHint: true },
      }),
    ).toBe("safe_auto");
    expect(
      classifyMcpCallRisk({
        action: "tools/call",
        trustState: "enabled",
        callMode: "auto_readonly",
        annotations: { readOnlyHint: true, destructiveHint: true },
      }),
    ).toBe("confirm_required");
    expect(
      classifyMcpCallRisk({
        action: "tools/call",
        trustState: "enabled",
        callMode: "auto_readonly",
        annotations: undefined,
      }),
    ).toBe("confirm_required");
    expect(
      classifyMcpCallRisk({
        action: "tools/call",
        trustState: "enabled",
        callMode: "auto_all",
        sandboxLevel: "personal",
        annotations: { destructiveHint: true },
      }),
    ).toBe("confirm_required");
    expect(
      classifyMcpCallRisk({
        action: "tools/call",
        trustState: "enabled",
        callMode: "auto_all",
        sandboxLevel: "unrestricted",
        annotations: { destructiveHint: true },
      }),
    ).toBe("safe_auto");
    expect(
      classifyMcpCallRisk({
        action: "tools/call",
        trustState: "enabled",
        callMode: "auto_all",
        sandboxLevel: "personal",
        annotations: { destructiveHint: false },
      }),
    ).toBe("safe_auto");
    expect(
      classifyMcpCallRisk({
        action: "resources/read",
        trustState: "enabled",
        callMode: "auto_readonly",
      }),
    ).toBe("safe_auto");
    expect(
      classifyMcpCallRisk({
        action: "resources/read",
        trustState: "enabled",
        callMode: "confirm_all",
      }),
    ).toBe("confirm_required");
    expect(
      classifyMcpCallRisk({
        action: "prompts/get",
        trustState: "enabled",
        callMode: "auto_readonly",
      }),
    ).toBe("safe_auto");
    expect(
      classifyMcpCallRisk({
        action: "prompts/get",
        trustState: "enabled",
        callMode: "confirm_all",
      }),
    ).toBe("confirm_required");

    // End-to-end execution + lazy inspect + shortCode approval dispatch
    const { store, manager, rpcCalls } = await createMockAgentHarness((method, params) => {
      if (method === "mcp.inspect") {
        return { ok: true, result: { tools: sampleGithubTools() } };
      }
      if (method === "mcp.call") {
        return {
          ok: true,
          result: {
            content: [{ type: "text", text: `called ${params.server_id}/${params.tool_name}` }],
            isError: false,
          },
        };
      }
      if (method === "mcp.resource.read") {
        return {
          ok: true,
          result: { contents: [{ uri: params.uri, text: "resource body" }] },
        };
      }
      if (method === "mcp.prompt.get") {
        return {
          ok: true,
          result: { messages: [{ role: "user", content: { type: "text", text: `prompt ${params.name}` } }] },
        };
      }
      return { ok: false, error: `unexpected: ${method}` };
    });

    const summary: McpSummary = {
      enabled: true,
      discovery_mode: "configs_only",
      discovered_count: 5,
      enabled_count: 3,
      running_count: 0,
      catalog_hash: "risk-cat",
      servers: [
        {
          server_id: "srv:readonly",
          name: "readonly",
          source: "cursor",
          transport: "stdio",
          trust_state: "enabled",
          call_mode: "auto_readonly",
          runtime_state: "stopped",
        },
        {
          server_id: "srv:confirm",
          name: "confirm",
          source: "cursor",
          transport: "stdio",
          trust_state: "enabled",
          call_mode: "confirm_all",
          runtime_state: "stopped",
        },
        {
          server_id: "srv:autoall",
          name: "autoall",
          source: "neo",
          transport: "stdio",
          trust_state: "enabled",
          call_mode: "auto_all",
          runtime_state: "stopped",
        },
        {
          server_id: "srv:blocked",
          name: "blocked",
          source: "cursor",
          transport: "stdio",
          trust_state: "blocked_by_policy",
          call_mode: "auto_all",
          runtime_state: "stopped",
        },
        {
          server_id: "srv:disabled",
          name: "disabled",
          source: "cursor",
          transport: "stdio",
          trust_state: "disabled",
          call_mode: "auto_readonly",
          runtime_state: "stopped",
        },
      ],
    };

    manager.upsertDeviceManifest(
      {
        device_id: "os-personal",
        tier: "os",
        capabilities: ["mcp_proxy", "mcp_discovery"],
        sandbox: { level: "personal" },
        mcp_summary: summary,
      },
      { status: "online" },
    );
    manager.upsertDeviceManifest(
      {
        device_id: "os-unrestricted",
        tier: "os",
        capabilities: ["mcp_proxy", "mcp_discovery"],
        sandbox: { level: "unrestricted" },
        mcp_summary: summary,
      },
      { status: "online" },
    );

    // 1. Blocked & disabled rejected immediately
    const blockedRes = await manager.callDeviceMcp("os-personal", {
      serverId: "srv:blocked",
      toolName: "list_issues",
    });
    expect(blockedRes.status).toBe("rejected");
    if (blockedRes.status === "rejected") {
      expect(blockedRes.error).toContain("blocked_by_policy");
    }

    const disabledRes = await manager.callDeviceMcp("os-personal", {
      serverId: "srv:disabled",
      toolName: "list_issues",
    });
    expect(disabledRes.status).toBe("rejected");

    // 2. auto_readonly + readOnlyHint (triggers lazy inspect first!) -> safe_auto -> ok
    const roRes = await manager.callDeviceMcp("os-personal", {
      serverId: "srv:readonly",
      toolName: "list_issues",
      arguments: { repo: "neo" },
    });
    expect(roRes.status).toBe("ok");
    expect(rpcCalls.map((c) => c.method)).toEqual(["mcp.inspect", "mcp.call"]);

    // 3. auto_readonly + mutating/destructive/unannotated -> pending_approval -> shortCode approve -> executes mcp.call
    const writeRes = await manager.callDeviceMcp("os-personal", {
      serverId: "srv:readonly",
      toolName: "delete_repository",
      arguments: { repo: "demo" },
      reason: "User requested cleanup",
    });
    expect(writeRes.status).toBe("pending_approval");
    if (writeRes.status === "pending_approval") {
      expect(writeRes.action).toBe("mcp.call");
      expect(writeRes.shortCode.length).toBe(6);
      expect(writeRes.params).toEqual({
        server_id: "srv:readonly",
        tool_name: "delete_repository",
        arguments: { repo: "demo" },
      });

      const approved = await manager.approve(writeRes.shortCode, "operator");
      expect(approved.approval.status).toBe("approved");
      expect(approved.result.status).toBe("ok");
      if (approved.result.status === "ok") {
        expect(JSON.stringify(approved.result.result)).toContain("srv:readonly/delete_repository");
      }
    }

    // 4. resources/read & prompts/get on auto_readonly -> safe_auto; on confirm_all -> pending_approval -> approve
    const resRead = await manager.callDeviceMcp("os-personal", {
      serverId: "srv:readonly",
      action: "resources/read",
      uri: "repo://readme",
    });
    expect(resRead.status).toBe("ok");

    const promptConfirm = await manager.callDeviceMcp("os-personal", {
      serverId: "srv:confirm",
      action: "prompts/get",
      promptName: "triage",
      arguments: { severity: "high" },
    });
    expect(promptConfirm.status).toBe("pending_approval");
    if (promptConfirm.status === "pending_approval") {
      expect(promptConfirm.action).toBe("mcp.prompt.get");
      const approvedPrompt = await manager.approve(promptConfirm.shortCode, "operator");
      expect(approvedPrompt.result.status).toBe("ok");
    }

    // 5. auto_all + destructiveHint: personal -> pending_approval; unrestricted -> safe_auto
    const personalDestructive = await manager.callDeviceMcp("os-personal", {
      serverId: "srv:autoall",
      toolName: "delete_repository",
      arguments: { repo: "x" },
    });
    expect(personalDestructive.status).toBe("pending_approval");

    const unrestrictedDestructive = await manager.callDeviceMcp("os-unrestricted", {
      serverId: "srv:autoall",
      toolName: "delete_repository",
      arguments: { repo: "x" },
    });
    expect(unrestrictedDestructive.status).toBe("ok");

    // 6. Autonomous device_invoke("mcp.server.set_policy" / "mcp_set_policy") -> pending_approval
    const invokePolicy1 = await manager.invoke("os-personal", {
      action: "mcp.server.set_policy",
      params: { server_id: "srv:readonly", call_mode: "auto_all" },
    });
    expect(invokePolicy1.status).toBe("pending_approval");

    const invokePolicy2 = await manager.invoke("os-personal", {
      action: "mcp_set_policy",
      params: { server_id: "srv:readonly", enabled: true },
    });
    expect(invokePolicy2.status).toBe("pending_approval");

    await manager.stop();
    store.close();
  });

  test("cross-cluster isolation, MCU rejection, and legacy agent unsupported RPC actionable OTA error", async () => {
    const { store, manager } = await createMockAgentHarness((method) => {
      return { ok: false, error: `unsupported RPC method: ${method}` };
    });

    manager.upsertDeviceManifest(
      { device_id: "os-legacy", tier: "os", capabilities: ["exec", "fs"] },
      { status: "online" },
    );
    manager.upsertDeviceManifest(
      { device_id: "mcu-sensor", tier: "mcu", chip: "esp32", acts: ["read_temp"] },
      { status: "online", relayNodeId: "os-legacy" },
    );
    // Inject a foreign cluster twin directly in KV
    manager.saveDevice({
      deviceId: "os-foreign",
      clusterId: "other-cluster",
      tier: "os",
      status: "online",
      route: "relay",
      capabilities: ["mcp_proxy", "mcp_discovery"],
      desiredState: {},
      reportedState: {},
      pendingQueue: [],
      lastSeqId: 0,
      lastAckedSeqId: 0,
      updatedAt: new Date().toISOString(),
    });

    // Legacy agent: supported === false and discover gives actionable OTA upgrade error mentioning updateDevice
    expect(manager.getDeviceMcp("os-legacy").supported).toBe(false);
    await expect(manager.discoverDeviceMcp("os-legacy")).rejects.toThrow(/updateDevice/i);
    await expect(manager.inspectDeviceMcp("os-legacy", "cursor:github")).rejects.toThrow(
      /updateDevice/i,
    );

    // Cross-cluster isolation
    expect(() => manager.getDeviceMcp("os-foreign")).toThrow(/Cross-cluster/);
    expect(manager.listAllDevicesMcp().some((d) => d.deviceId === "os-foreign")).toBe(false);
    await expect(manager.discoverDeviceMcp("os-foreign")).rejects.toThrow(/Cross-cluster/);
    await expect(manager.listDeviceMcp("os-foreign")).rejects.toThrow(/Cross-cluster/);
    await expect(manager.inspectDeviceMcp("os-foreign", "srv:1")).rejects.toThrow(/Cross-cluster/);
    await expect(
      manager.setDeviceMcpServerPolicy("os-foreign", "srv:1", { enabled: true }),
    ).rejects.toThrow(/Cross-cluster/);
    await expect(manager.stopDeviceMcpServer("os-foreign", "srv:1")).rejects.toThrow(/Cross-cluster/);
    await expect(manager.restartDeviceMcpServer("os-foreign", "srv:1")).rejects.toThrow(
      /Cross-cluster/,
    );
    const crossCall = await manager.callDeviceMcp("os-foreign", {
      serverId: "srv:1",
      toolName: "foo",
    });
    expect(crossCall.status).toBe("rejected");
    if (crossCall.status === "rejected") {
      expect(crossCall.error).toContain("Cross-cluster");
    }

    // Tier 2 MCU rejected
    await expect(manager.discoverDeviceMcp("mcu-sensor")).rejects.toThrow(/Tier 1 OS/);
    const mcuCall = await manager.callDeviceMcp("mcu-sensor", {
      serverId: "srv:1",
      toolName: "foo",
    });
    expect(mcuCall.status).toBe("rejected");

    await manager.stop();
    store.close();
  });

  test("LLM tools (device_mcp_list/inspect/call with customName) and HTTP /api/devices/:id/mcp* routes", async () => {
    // 1. Verify all 3 tools are exposed in BOTH mainSpecs() and workerSpecs()
    for (const toolName of ["device_mcp_list", "device_mcp_inspect", "device_mcp_call"]) {
      expect(mainSpecs().some((s) => s.name === toolName)).toBe(true);
      expect(workerSpecs().some((s) => s.name === toolName)).toBe(true);
    }

    const dir = new TempDir("neo-mcp-http-tools");
    try {
      const scripted = new Scripted();
      scripted.model = async () => "ok";
      const app = App.open(
        { stateDir: dir.path, wechat: new Protocol() },
        new ScriptedKernels(scripted),
        defaultTimings(),
      );
      await app.start();

      let lockPolicy = false;
      let servers = sampleServers();

      const { manager } = await createMockAgentHarness(
        (method, params) => {
          if (method === "mcp.discover" || method === "mcp.list") {
            return {
              ok: true,
              result: {
                discovery_mode: params.include_loopback_probe ? "configs_and_loopback" : "configs_only",
                catalog_hash: "http-cat-1",
                servers,
              },
            };
          }
          if (method === "mcp.inspect") {
            return {
              ok: true,
              result: {
                tools: sampleGithubTools(),
                resources: [{ uri: "file:///notes.md", name: "notes" }],
                prompts: [{ name: "summarize", description: "Summarize" }],
                tools_schema_hash: "sha256:http-tools",
                protocol_version: "2025-03-26",
              },
            };
          }
          if (method === "mcp.server.set_policy") {
            if (lockPolicy) {
              return { ok: false, error: "Policy is locked by local lock_sandbox setting" };
            }
            const sid = String(params.server_id);
            servers = servers.map((s) =>
              s.server_id === sid
                ? {
                    ...s,
                    ...(typeof params.enabled === "boolean"
                      ? { trust_state: params.enabled ? "enabled" : "disabled" }
                      : {}),
                    ...(typeof params.call_mode === "string"
                      ? { call_mode: params.call_mode as McpServerDescriptor["call_mode"] }
                      : {}),
                  }
                : s,
            );
            return { ok: true, result: { server: servers.find((s) => s.server_id === sid) } };
          }
          if (method === "mcp.server.stop") {
            return { ok: true, result: { runtime_state: "stopped" } };
          }
          if (method === "mcp.server.restart") {
            return { ok: true, result: { runtime_state: "running" } };
          }
          if (method === "mcp.call") {
            return {
              ok: true,
              result: {
                content: [{ type: "text", text: `ok:${params.server_id}:${params.tool_name}` }],
                isError: false,
              },
            };
          }
          if (method === "mcp.resource.read") {
            return { ok: true, result: { contents: [{ uri: params.uri, text: "hello resource" }] } };
          }
          if (method === "mcp.prompt.get") {
            return { ok: true, result: { description: `prompt:${params.name}` } };
          }
          return { ok: false, error: `unsupported RPC method: ${method}` };
        },
        { store: app.store },
      );

      manager.upsertDeviceManifest(
        {
          device_id: "os-workstation",
          tier: "os",
          capabilities: ["exec", "mcp_discovery", "mcp_proxy"],
          sandbox: { level: "personal" },
        },
        { status: "online", customName: "MacBook Pro" },
      );
      manager.saveDevice({
        deviceId: "os-foreign",
        clusterId: "foreign-cluster",
        tier: "os",
        status: "online",
        route: "relay",
        capabilities: ["mcp_proxy"],
        desiredState: {},
        reportedState: {},
        pendingQueue: [],
        lastSeqId: 0,
        lastAckedSeqId: 0,
        updatedAt: new Date().toISOString(),
      });
      (app as unknown as { devices: DeviceManager }).devices = manager;

      // 2. LLM tools: device_mcp_list (omitted device_id + customName resolution)
      const allList = (await app.mainTool("device_mcp_list", {})) as {
        devices: Array<{ deviceId: string; customName?: string }>;
      };
      expect(allList.devices.length).toBe(1);
      expect(allList.devices[0]?.deviceId).toBe("os-workstation");
      expect(allList.devices[0]?.customName).toBe("MacBook Pro");

      const namedList = (await app.workerTool("t-mcp", "device_mcp_list", {
        device_id: "macbook pro",
        refresh: true,
        include_loopback_probe: true,
      })) as { deviceId: string; discoveryMode: string; servers: McpServerDescriptor[] };
      expect(namedList.deviceId).toBe("os-workstation");
      expect(namedList.discoveryMode).toBe("configs_and_loopback");
      expect(namedList.servers.length).toBe(2);

      // 3. LLM tool: device_mcp_inspect with customName + query filter
      const toolInspect = (await app.mainTool("device_mcp_inspect", {
        device_id: "MacBook Pro",
        server_id: "cursor:github",
        query: "issue",
        include_resources: true,
        include_prompts: true,
      })) as { tools: McpToolInfo[]; totalTools: number; filtered: boolean; resources: unknown[] };
      expect(toolInspect.filtered).toBe(true);
      expect(toolInspect.totalTools).toBe(5);
      expect(toolInspect.tools.length).toBe(2);
      expect(toolInspect.resources.length).toBe(1);

      // 4. LLM tool: device_mcp_call (safe_auto read-only, pending_approval write -> device_approve, resources/read, prompts/get)
      const callOk = (await app.workerTool("t-mcp", "device_mcp_call", {
        device_id: "MacBook Pro",
        server_id: "cursor:github",
        tool_name: "list_issues",
        arguments: { repo: "neo" },
      })) as { status: string; result: unknown };
      expect(callOk.status).toBe("ok");

      const callPending = (await app.mainTool("device_mcp_call", {
        device_id: "MacBook Pro",
        server_id: "cursor:github",
        tool_name: "create_issue",
        arguments: { title: "MCP test" },
        reason: "Create tracking issue",
      })) as { status: string; shortCode: string };
      expect(callPending.status).toBe("pending_approval");

      const approvedTool = (await app.mainTool("device_approve", {
        approval_id: callPending.shortCode,
        decision: "approve",
      })) as { result: { status: string } };
      expect(approvedTool.result.status).toBe("ok");

      const readResTool = (await app.mainTool("device_mcp_call", {
        device_id: "MacBook Pro",
        server_id: "cursor:github",
        action: "resources/read",
        uri: "file:///notes.md",
      })) as { status: string };
      expect(readResTool.status).toBe("ok");

      const getPromptTool = (await app.mainTool("device_mcp_call", {
        device_id: "MacBook Pro",
        server_id: "cursor:github",
        action: "prompts/get",
        prompt_name: "summarize",
      })) as { status: string };
      expect(getPromptTool.status).toBe("ok");

      // 5. HTTP API routes
      const peer = { host: "127.0.0.1", port: 50500 };

      // GET /api/devices/:id/mcp
      const getOverviewRes = await handle(
        app,
        {},
        makeRequest("GET", "/api/devices/os-workstation/mcp"),
        peer,
      );
      expect(getOverviewRes.status).toBe(200);
      const getOverviewJson = JSON.parse(new TextDecoder().decode(getOverviewRes.body)) as {
        deviceId: string;
        supported: boolean;
        servers: McpServerDescriptor[];
      };
      expect(getOverviewJson.deviceId).toBe("os-workstation");
      expect(getOverviewJson.supported).toBe(true);
      expect(getOverviewJson.servers.length).toBe(2);

      // GET /api/devices/missing/mcp -> 404; cross-cluster -> 403
      expect(
        (await handle(app, {}, makeRequest("GET", "/api/devices/no-such-dev/mcp"), peer)).status,
      ).toBe(404);
      expect(
        (await handle(app, {}, makeRequest("GET", "/api/devices/os-foreign/mcp"), peer)).status,
      ).toBe(403);

      // GET /api/devices/:id/mcp/:serverId/tools?query=delete&refresh=false (with URL-encoded colon %3A)
      const getToolsRes = await handle(
        app,
        {},
        makeRequest(
          "GET",
          "/api/devices/os-workstation/mcp/cursor%3Agithub/tools",
          undefined,
          "query=delete&refresh=false",
        ),
        peer,
      );
      expect(getToolsRes.status).toBe(200);
      const getToolsJson = JSON.parse(new TextDecoder().decode(getToolsRes.body)) as {
        tools: McpToolInfo[];
        cached: boolean;
      };
      expect(getToolsJson.cached).toBe(true);
      expect(getToolsJson.tools.map((t) => t.name)).toEqual(["delete_repository"]);

      // POST /api/devices/:id/mcp/discover
      const discRes = await handle(
        app,
        {},
        makeRequest("POST", "/api/devices/os-workstation/mcp/discover", {
          includeLoopbackProbe: false,
          sources: ["cursor"],
        }),
        peer,
      );
      expect(discRes.status).toBe(200);
      const discJson = JSON.parse(new TextDecoder().decode(discRes.body)) as {
        deviceId: string;
        discoveryMode: string;
      };
      expect(discJson.deviceId).toBe("os-workstation");
      expect(discJson.discoveryMode).toBe("configs_only");

      // POST /api/devices/:id/mcp/:serverId/inspect
      const postInspectRes = await handle(
        app,
        {},
        makeRequest("POST", "/api/devices/os-workstation/mcp/cursor:github/inspect", {
          query: "create",
          refresh: true,
        }),
        peer,
      );
      expect(postInspectRes.status).toBe(200);
      const postInspectJson = JSON.parse(new TextDecoder().decode(postInspectRes.body)) as {
        tools: McpToolInfo[];
        cached: boolean;
      };
      expect(postInspectJson.cached).toBe(false);
      expect(postInspectJson.tools.map((t) => t.name)).toEqual(["create_issue"]);

      // PUT /api/devices/:id/mcp/:serverId/policy (200 ok, 403 locked, 400 invalid)
      const putPolRes = await handle(
        app,
        {},
        makeRequest("PUT", "/api/devices/os-workstation/mcp/neo:local-db/policy", {
          enabled: true,
          callMode: "auto_readonly",
        }),
        peer,
      );
      expect(putPolRes.status).toBe(200);
      const putPolJson = JSON.parse(new TextDecoder().decode(putPolRes.body)) as {
        server: McpServerDescriptor;
      };
      expect(putPolJson.server.trust_state).toBe("enabled");
      expect(putPolJson.server.call_mode).toBe("auto_readonly");

      const badPolRes = await handle(
        app,
        {},
        makeRequest("PUT", "/api/devices/os-workstation/mcp/neo:local-db/policy", {
          callMode: "bogus",
        }),
        peer,
      );
      expect(badPolRes.status).toBe(400);

      lockPolicy = true;
      const lockedPolRes = await handle(
        app,
        {},
        makeRequest("PUT", "/api/devices/os-workstation/mcp/neo:local-db/policy", {
          callMode: "auto_all",
        }),
        peer,
      );
      expect(lockedPolRes.status).toBe(403);
      lockPolicy = false;

      // POST /api/devices/:id/mcp/:serverId/call -> 200 ok, 202 pending_approval, 404 unknown server, 403 disabled
      const httpCallOk = await handle(
        app,
        {},
        makeRequest("POST", "/api/devices/os-workstation/mcp/cursor:github/call", {
          toolName: "list_issues",
          arguments: { repo: "neo" },
        }),
        peer,
      );
      expect(httpCallOk.status).toBe(200);

      const httpCallPending = await handle(
        app,
        {},
        makeRequest("POST", "/api/devices/os-workstation/mcp/cursor:github/call", {
          toolName: "delete_repository",
          arguments: { repo: "neo" },
        }),
        peer,
      );
      expect(httpCallPending.status).toBe(202);

      const httpCallUnknownSrv = await handle(
        app,
        {},
        makeRequest("POST", "/api/devices/os-workstation/mcp/no:server/call", {
          toolName: "foo",
        }),
        peer,
      );
      expect(httpCallUnknownSrv.status).toBe(404);

      // Disable neo:local-db and verify call returns 403
      await handle(
        app,
        {},
        makeRequest("PUT", "/api/devices/os-workstation/mcp/neo:local-db/policy", {
          enabled: false,
        }),
        peer,
      );
      const httpCallDisabled = await handle(
        app,
        {},
        makeRequest("POST", "/api/devices/os-workstation/mcp/neo:local-db/call", {
          toolName: "query",
        }),
        peer,
      );
      expect(httpCallDisabled.status).toBe(403);

      // POST /api/devices/:id/mcp/:serverId/restart & /stop -> 200
      const restartRes = await handle(
        app,
        {},
        makeRequest("POST", "/api/devices/os-workstation/mcp/cursor:github/restart"),
        peer,
      );
      expect(restartRes.status).toBe(200);
      expect(JSON.parse(new TextDecoder().decode(restartRes.body)).server.runtime_state).toBe("running");

      const stopRes = await handle(
        app,
        {},
        makeRequest("POST", "/api/devices/os-workstation/mcp/cursor:github/stop"),
        peer,
      );
      expect(stopRes.status).toBe(200);
      expect(JSON.parse(new TextDecoder().decode(stopRes.body)).server.runtime_state).toBe("stopped");

      await manager.stop();
      await app.stop();
      app.close();
    } finally {
      dir.cleanup();
    }
  });

  const rustAgentBin = (() => {
    const repoRoot = path.resolve(import.meta.dir, "../../..");
    for (const candidate of [
      path.join(repoRoot, "agents/neo-agent-os/target/debug/neo-agent-os"),
      path.join(repoRoot, "agents/neo-agent-os/target/release/neo-agent-os"),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  })();

  test.skipIf(!rustAgentBin)(
    "REAL cross-language E2E: TypeScript DeviceManager/DeviceMcpProxy <-> WS relay <-> compiled Rust neo-agent-os <-> real Stdio MCP server",
    async () => {
      const rustBin = rustAgentBin!;
      const dir = new TempDir("neo-mcp-xlang");
      const fakeHome = path.join(dir.path, "home");
      const remoteWs = path.join(dir.path, "remote-ws");
      const otaDir = path.join(dir.path, "ota-cache");
      const cursorDir = path.join(fakeHome, ".cursor");
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.mkdirSync(remoteWs, { recursive: true });
      fs.mkdirSync(otaDir, { recursive: true });
      const canonicalWs = fs.realpathSync(remoteWs);

      // Tiny real Stdio MCP server speaking JSON-RPC 2.0 NDJSON over stdin/stdout.
      const mockMcpScript = path.join(dir.path, "mock-mcp-server.mjs");
      fs.writeFileSync(
        mockMcpScript,
        `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try { req = JSON.parse(trimmed); } catch { return; }
  if (req.id === undefined || req.id === null) return;
  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "xlang-mock-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (req.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [
          {
            name: "read_note",
            description: "Read a note without mutating state",
            inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            annotations: { readOnlyHint: true, destructiveHint: false },
          },
          {
            name: "delete_note",
            description: "Permanently delete a note",
            inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        ],
      },
    });
    return;
  }
  if (req.method === "tools/call") {
    const toolName = req.params?.name ?? "";
    const args = req.params?.arguments ?? {};
    const authed = process.env.GITHUB_TOKEN === "ghp_super_secret_do_not_leak_99999";
    if (toolName === "read_note") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: "note:" + String(args.id ?? "") + ":authed=" + String(authed) }] },
      });
      return;
    }
    if (toolName === "delete_note") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: "deleted:" + String(args.id ?? "") }] },
      });
      return;
    }
  }
  send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found: " + String(req.method) } });
});
`,
        "utf8",
      );

      // Cursor MCP config containing real local secrets that MUST NEVER leave Tier 1.
      fs.writeFileSync(
        path.join(cursorDir, "mcp.json"),
        JSON.stringify(
          {
            mcpServers: {
              demo: {
                command: process.execPath,
                args: ["run", mockMcpScript, "--api-key=sk-secret-do-not-leak-12345"],
                env: {
                  GITHUB_TOKEN: "ghp_super_secret_do_not_leak_99999",
                },
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const policyPath = path.join(dir.path, "policy.toml");
      fs.writeFileSync(
        policyPath,
        [
          `sandbox_level = "personal"`,
          `allowed_workspaces = [${JSON.stringify(canonicalWs)}]`,
          `allowed_commands = ["echo"]`,
          `denied_commands = ["rm"]`,
          "",
        ].join("\n"),
        "utf8",
      );

      const clusterId = "cluster-mcp-xlang";
      const masterId = "master-mcp-xlang";
      const osId = "os-mcp-xlang";
      const e2eKey = "mcp-xlang-e2e-secret";

      const relayPeers = new Map<string, Bun.ServerWebSocket<{ nodeId: string; path: string }>>();
      const server = Bun.serve<{ nodeId: string; path: string }>({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req, srv) {
          const url = new URL(req.url);
          const auth = req.headers.get("authorization") ?? "";
          const tok = auth.replace(/^Bearer\s+/i, "").trim();
          const nodeId = tok.startsWith("tok:") ? tok.slice(4) : "unknown";
          if (url.pathname === "/v1/bootstrap") {
            return new Response(
              JSON.stringify({ cluster_id: clusterId, node_id: nodeId, stun_servers: [] }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.pathname === "/v1/signal" || url.pathname === "/v1/relay") {
            if (srv.upgrade(req, { data: { nodeId, path: url.pathname } })) {
              return undefined;
            }
            return new Response("upgrade failed", { status: 400 });
          }
          return new Response("not found", { status: 404 });
        },
        websocket: {
          maxPayloadLength: 4 * 1024 * 1024,
          open(ws) {
            if (ws.data.path === "/v1/relay") {
              relayPeers.set(ws.data.nodeId, ws);
            }
          },
          message(ws, message) {
            if (ws.data.path !== "/v1/relay") return;
            const bytes =
              message instanceof Uint8Array
                ? message
                : typeof message === "string"
                  ? new TextEncoder().encode(message)
                  : new Uint8Array(message);
            const frame = decodeRelayFrame(bytes);
            if (frame.flags === FLAG_PING) {
              ws.sendBinary(
                encodeRelayFrame({
                  flags: FLAG_PONG,
                  src: "neo-relay",
                  dst: ws.data.nodeId,
                  payload: new Uint8Array(0),
                }),
              );
              return;
            }
            if (frame.flags === FLAG_DATA) {
              const dstSock = relayPeers.get(frame.dst);
              if (dstSock) dstSock.sendBinary(bytes);
            }
          },
          close(ws) {
            if (ws.data.path === "/v1/relay" && relayPeers.get(ws.data.nodeId) === ws) {
              relayPeers.delete(ws.data.nodeId);
            }
          },
        },
      });

      const relayBaseUrl = `http://127.0.0.1:${server.port}`;
      const store = Store.memory();
      const manager = new DeviceManager({
        store,
        masterId: "mcp-xlang",
        pingIntervalMs: 0,
      });

      let agentProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
      try {
        await manager.configure(
          {
            clusterId,
            masterNodeId: masterId,
            relayUrl: relayBaseUrl,
            token: `tok:${masterId}`,
            e2eKey,
          },
          { connect: true },
        );

        agentProc = Bun.spawn(
          [
            rustBin,
            "--cluster",
            clusterId,
            "--device-id",
            osId,
            "--master-id",
            masterId,
            "--relay-url",
            relayBaseUrl,
            "--token",
            `tok:${osId}`,
            "--e2e-key",
            e2eKey,
            "--policy",
            policyPath,
            "--ota-cache-dir",
            otaDir,
          ],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              HOME: fakeHome,
              USERPROFILE: fakeHome,
              XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
            },
          },
        );

        // Wait until Rust agent publishes its E2EE manifest with mcp_summary.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const twin = manager.getDevice(osId);
          if (twin && twin.status === "online" && twin.capabilities.includes("mcp_proxy")) {
            break;
          }
          await Bun.sleep(30);
        }

        const twin = manager.getDevice(osId);
        expect(twin).not.toBeNull();
        expect(twin!.capabilities).toContain("mcp_discovery");
        expect(twin!.capabilities).toContain("mcp_proxy");
        expect(twin!.manifest?.mcp_summary?.discovered_count).toBe(1);

        // 1. Discover & verify Secret-Stays-Local redaction across the real E2EE wire!
        const discovered = await manager.discoverDeviceMcp(osId);
        expect(discovered.servers.length).toBe(1);
        const demo = discovered.servers[0]!;
        expect(demo.server_id).toBe("cursor:demo");
        expect(demo.source).toBe("cursor");
        expect(demo.transport).toBe("stdio");
        expect(demo.trust_state).toBe("discovered");
        expect(demo.env_keys).toEqual(["GITHUB_TOKEN"]);
        const discoveredWireJson = JSON.stringify(discovered);
        expect(discoveredWireJson).not.toContain("ghp_super_secret_do_not_leak_99999");
        expect(discoveredWireJson).not.toContain("sk-secret-do-not-leak-12345");

        // 2. Enable server via setDeviceMcpServerPolicy
        const enabledRes = await manager.setDeviceMcpServerPolicy(osId, "cursor:demo", {
          enabled: true,
          callMode: "auto_readonly",
        });
        expect(enabledRes.persisted).toBe(true);
        expect(enabledRes.server?.trust_state).toBe("enabled");
        expect(enabledRes.server?.call_mode).toBe("auto_readonly");

        // 3. Inspect lazily spawns the real Stdio MCP child and returns tools with annotations
        const inspected = await manager.inspectDeviceMcp(osId, "cursor:demo");
        expect(inspected.tools.map((t) => t.name).sort()).toEqual(["delete_note", "read_note"]);
        const readTool = inspected.tools.find((t) => t.name === "read_note");
        expect(readTool?.annotations?.readOnlyHint).toBe(true);
        const deleteTool = inspected.tools.find((t) => t.name === "delete_note");
        expect(deleteTool?.annotations?.destructiveHint).toBe(true);

        // 4. Call read-only tool -> safe_auto, executes on real Stdio MCP with local GITHUB_TOKEN intact
        const readRes = await manager.callDeviceMcp(osId, {
          serverId: "cursor:demo",
          toolName: "read_note",
          arguments: { id: "doc-42" },
        });
        expect(readRes.status).toBe("ok");
        if (readRes.status === "ok") {
          expect(JSON.stringify(readRes.result)).toContain("note:doc-42:authed=true");
        }

        // 5. Call destructive tool -> confirm_required -> PendingApproval shortCode -> approve -> executes!
        const deletePending = await manager.callDeviceMcp(osId, {
          serverId: "cursor:demo",
          toolName: "delete_note",
          arguments: { id: "doc-42" },
          reason: "Cleanup test note",
        });
        expect(deletePending.status).toBe("pending_approval");
        if (deletePending.status === "pending_approval") {
          const approved = await manager.approve(deletePending.shortCode, "operator");
          expect(approved.approval.status).toBe("approved");
          expect(approved.result.status).toBe("ok");
          if (approved.result.status === "ok") {
            expect(JSON.stringify(approved.result.result)).toContain("deleted:doc-42");
          }
        }

        // 6. Stop running MCP session cleanly
        const stopped = await manager.stopDeviceMcpServer(osId, "cursor:demo");
        expect(stopped.stopped).toBe(true);
        expect(stopped.runtimeState).toBe("stopped");
      } finally {
        if (agentProc) {
          try {
            agentProc.kill();
            await agentProc.exited;
          } catch {
            // ignore
          }
        }
        await manager.stop();
        server.stop(true);
        store.close();
        dir.cleanup();
      }
    },
    25_000,
  );
});
