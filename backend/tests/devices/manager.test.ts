import { describe, expect, test } from "bun:test";
import { App, defaultTimings } from "../../src/app/index.ts";
import {
  DeviceManager,
  FLAG_DATA,
  FLAG_ERR_OFFLINE,
  FLAG_ERR_RATE,
  FLAG_ERR_SPOOFED,
  FLAG_PING,
  FLAG_PONG,
  RelayClient,
  decodeCbor,
  decodeRelayFrame,
  encodeCbor,
  encodeRelayFrame,
  inferSandboxLevel,
  openDeviceMessage,
  openRelayEnvelope,
  sealDeviceMessage,
  sealRelayEnvelope,
  type RelaySocket,
} from "../../src/devices/index.ts";
import { Request, handle } from "../../src/http/index.ts";
import { Store } from "../../src/store/index.ts";
import { TempDir } from "../../src/testkit/index.ts";
import { Scripted, ScriptedKernels } from "../app/common.ts";
import { Protocol } from "../../src/app/wechat_protocol.ts";

class MockRelaySocket implements RelaySocket {
  readyState = 0; // CONNECTING
  binaryType = "arraybuffer";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  readonly sent: Array<string | Uint8Array | ArrayBuffer> = [];
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
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.closed = true;
    this.onclose?.({ code, reason });
  }
}

function makeMockSockets() {
  const sockets: MockRelaySocket[] = [];
  const wsFactory = (url: string, headers: Record<string, string>) => {
    const ws = new MockRelaySocket(url, headers);
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
): Request {
  const headers = new Map<string, string>([["host", "127.0.0.1:3082"]]);
  let bytes = new Uint8Array(0);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    bytes = new TextEncoder().encode(JSON.stringify(body));
  }
  return new Request({ method, path: reqPath, headers, body: bytes });
}

describe("devices/relay-client & manager", () => {
  test("RelayClient connects bootstrap/signal/relay, replies Ping->Pong, handles 0x81..0x83 errors and reconnects", async () => {
    const { sockets, wsFactory } = makeMockSockets();
    const signals: string[] = [];
    const errors: number[] = [];
    const frames: string[] = [];

    const client = new RelayClient({
      relayUrl: "https://relay.example.test:18443",
      clusterId: "c1",
      nodeId: "master-1",
      tokenProvider: () => "neo1.tok.sig",
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            cluster_id: "c1",
            node_id: "master-1",
            signal_url: "wss://relay.example.test:18443/v1/signal",
            relay_url: "wss://relay.example.test:18443/v1/relay",
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
      wsFactory,
      pingIntervalMs: 0,
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
      onSignal: (m) => signals.push(m.type),
      onRelayError: (e) => errors.push(e.code),
      onFrame: (f) => frames.push(f.src),
    });

    await client.connect();
    expect(client.isRelayConnected()).toBe(true);
    expect(sockets.length).toBe(2);

    const relaySock = sockets.find((s) => s.url.endsWith("/v1/relay"))!;
    const signalSock = sockets.find((s) => s.url.endsWith("/v1/signal"))!;
    expect(relaySock.headers.Authorization).toBe("Bearer neo1.tok.sig");

    // Signal events
    signalSock.emitMessage(JSON.stringify({ type: "registered", ok: true }));
    signalSock.emitMessage(JSON.stringify({ type: "p2p_punch", from: "os-1" }));
    expect(client.getPeerRouteHint("os-1")).toBe("p2p");
    signalSock.emitMessage(JSON.stringify({ type: "relay_fallback", from: "os-1" }));
    expect(client.getPeerRouteHint("os-1")).toBe("relay");
    expect(signals).toEqual(["registered", "p2p_punch", "relay_fallback"]);

    // Ping -> auto Pong
    const pingWire = encodeRelayFrame({
      flags: FLAG_PING,
      src: "relay",
      dst: "master-1",
      payload: new Uint8Array([1, 2]),
    });
    relaySock.emitMessage(pingWire);
    await new Promise((r) => setTimeout(r, 10));
    expect(relaySock.sent.length).toBe(1);
    const pong = decodeRelayFrame(relaySock.sent[0] as Uint8Array);
    expect(pong.flags).toBe(FLAG_PONG);
    expect(pong.dst).toBe("relay");
    expect(pong.payload).toEqual(new Uint8Array([1, 2]));

    // Error frames 0x81 / 0x82 / 0x83
    relaySock.emitMessage(
      encodeRelayFrame({ flags: FLAG_ERR_OFFLINE, src: "os-1", dst: "master-1", payload: new Uint8Array(0) }),
    );
    relaySock.emitMessage(
      encodeRelayFrame({ flags: FLAG_ERR_SPOOFED, src: "relay", dst: "master-1", payload: new Uint8Array(0) }),
    );
    relaySock.emitMessage(
      encodeRelayFrame({ flags: FLAG_ERR_RATE, src: "relay", dst: "master-1", payload: new Uint8Array(0) }),
    );
    // Data frame
    relaySock.emitMessage(
      encodeRelayFrame({ flags: FLAG_DATA, src: "os-1", dst: "master-1", payload: new Uint8Array([9]) }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toEqual([FLAG_ERR_OFFLINE, FLAG_ERR_SPOOFED, FLAG_ERR_RATE]);
    expect(frames).toEqual(["os-1"]);

    // Auto-reconnect on close
    relaySock.close(1006, "drop");
    await new Promise((r) => setTimeout(r, 40));
    expect(sockets.length).toBeGreaterThan(2);

    client.close();
  });

  test("DeviceManager handles Tier 1 RPC, Tier 2 MCU proxy, approvals, Deep Sleep queue, and Tier 1 disconnect failover/suppression", async () => {
    const store = Store.memory();
    const { sockets, wsFactory } = makeMockSockets();
    const clusterId = "cluster-a";
    const e2eKey = "test-e2e-key";

    const manager = new DeviceManager({
      store,
      masterId: "m1",
      fetchFn: (async () =>
        new Response(JSON.stringify({ cluster_id: clusterId }), { status: 200 })) as unknown as typeof fetch,
      wsFactory,
      pingIntervalMs: 0,
    });

    await manager.configure(
      {
        clusterId,
        masterNodeId: "master-m1",
        relayUrl: "https://relay.local:18443",
        relaySecret: "relay-root-secret",
        e2eKey,
      },
      { persist: true, connect: true },
    );

    const relaySock = sockets.find((s) => s.url.endsWith("/v1/relay"))!;

    // 1. Tier 1 OS Agent manifest arrival over E2E relay frame
    const manifestWire = sealDeviceMessage(
      {
        v: 1,
        kind: "manifest",
        req_id: "m-1",
        cluster_id: clusterId,
        device_id: "os-1",
        ts_ms: Date.now(),
        body: {
          device_id: "os-1",
          tier: "os",
          os: "linux",
          arch: "x86_64",
          capabilities: ["exec", "fs", "relay"],
        },
      },
      e2eKey,
      "os-1",
      "master-m1",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: "os-1", dst: "master-m1", payload: manifestWire });

    const osTwin = manager.getDevice("os-1");
    expect(osTwin).not.toBeNull();
    expect(osTwin!.status).toBe("online");
    expect(osTwin!.route).toBe("relay");

    // 2. Tier 1 safe_auto exec RPC
    const execPromise = manager.invoke("os-1", { action: "exec", params: { program: "echo", args: ["hi"] } });
    await new Promise((r) => setTimeout(r, 10));
    expect(relaySock.sent.length).toBe(1);
    const outFrame = decodeRelayFrame(relaySock.sent[0] as Uint8Array);
    expect(outFrame.dst).toBe("os-1");
    const outMsg = openDeviceMessage(outFrame.payload, e2eKey, clusterId, "master-m1", "os-1");
    expect(outMsg.kind).toBe("rpc_req");
    expect(outMsg.body.method).toBe("exec");

    // Simulate Tier 1 rpc_resp
    const respWire = sealDeviceMessage(
      {
        v: 1,
        kind: "rpc_resp",
        req_id: outMsg.req_id,
        cluster_id: clusterId,
        device_id: "os-1",
        ts_ms: Date.now(),
        body: { ok: true, result: { stdout: "hi\n", exit_code: 0 } },
      },
      e2eKey,
      "os-1",
      "master-m1",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: "os-1", dst: "master-m1", payload: respWire });
    const execRes = await execPromise;
    expect(execRes).toEqual({
      status: "ok",
      deviceId: "os-1",
      action: "exec",
      reqId: outMsg.req_id,
      result: { stdout: "hi\n", exit_code: 0 },
    });

    // 3. Tier 2 MCU hello arrival via Tier 1 relay_envelope
    const helloEnv = sealRelayEnvelope({
      clusterId,
      relayNodeId: "os-1",
      targetMcuId: "mcu-1",
      direction: "uplink",
      seqId: 0,
      payload: { t: "hello", chip: "esp32s3", fw: "1.0.0", acts: ["read_dht22", "set_fan_pwm"] },
      e2eMasterSecret: e2eKey,
    });
    const helloWire = sealDeviceMessage(
      {
        v: 1,
        kind: "relay_envelope",
        req_id: "h-1",
        cluster_id: clusterId,
        device_id: "os-1",
        ts_ms: Date.now(),
        body: helloEnv as unknown as Record<string, unknown>,
      },
      e2eKey,
      "os-1",
      "master-m1",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: "os-1", dst: "master-m1", payload: helloWire });

    const mcuTwin = manager.getDevice("mcu-1");
    expect(mcuTwin).not.toBeNull();
    expect(mcuTwin!.tier).toBe("mcu");
    expect(mcuTwin!.route).toBe("via_tier1");
    expect(mcuTwin!.relayNodeId).toBe("os-1");

    // 4. Risk gate: forbidden -> rejected; confirm_required -> pending_approval -> approve by shortCode
    const forbiddenRes = await manager.invoke("mcu-1", { action: "factory_reset" });
    expect(forbiddenRes.status).toBe("rejected");

    const pendingRes = await manager.invoke("mcu-1", { action: "set_fan_pwm", params: { duty: 85 } });
    expect(pendingRes.status).toBe("pending_approval");
    if (pendingRes.status !== "pending_approval") throw new Error("unreachable");

    const approvePromise = manager.approve(pendingRes.shortCode, "tester");
    await new Promise((r) => setTimeout(r, 10));
    expect(relaySock.sent.length).toBe(2);
    const mcuOutFrame = decodeRelayFrame(relaySock.sent[1] as Uint8Array);
    const mcuOutMsg = openDeviceMessage(mcuOutFrame.payload, e2eKey, clusterId, "master-m1", "os-1");
    expect(mcuOutMsg.kind).toBe("relay_envelope");
    const openedEnv = openRelayEnvelope<{ t: string; a: string; p: { duty: number } }>(
      mcuOutMsg.body as never,
      e2eKey,
      clusterId,
    );
    expect(openedEnv.payload).toEqual({ t: "cmd", a: "set_fan_pwm", p: { duty: 85 } });
    expect(openedEnv.envelope.seq_id).toBe(1);

    // Reply from MCU
    const mcuResEnv = sealRelayEnvelope({
      clusterId,
      relayNodeId: "os-1",
      targetMcuId: "mcu-1",
      direction: "uplink",
      seqId: 1,
      payload: { t: "res", ok: true, a: "set_fan_pwm", d: { duty: 85 }, e: "" },
      e2eMasterSecret: e2eKey,
    });
    manager.handleRelayFrame({
      flags: FLAG_DATA,
      src: "os-1",
      dst: "master-m1",
      payload: sealDeviceMessage(
        {
          v: 1,
          kind: "relay_envelope",
          req_id: "r-mcu-1",
          cluster_id: clusterId,
          device_id: "os-1",
          ts_ms: Date.now(),
          body: mcuResEnv as unknown as Record<string, unknown>,
        },
        e2eKey,
        "os-1",
        "master-m1",
      ),
    });

    const approved = await approvePromise;
    expect(approved.approval.status).toBe("approved");
    expect(approved.result).toEqual({
      status: "ok",
      deviceId: "mcu-1",
      action: "set_fan_pwm",
      reqId: mcuOutMsg.req_id,
      seqId: 1,
      result: { duty: 85 },
    });

    // 5. Deep Sleep desired-state queue + wake flush + seq_id idempotency
    manager.setDeviceStatus("mcu-1", "sleeping");
    const queued = await manager.invoke("mcu-1", { action: "read_dht22", params: {} });
    expect(queued.status).toBe("queued");
    if (queued.status !== "queued") throw new Error("unreachable");
    expect(queued.seqId).toBe(2);
    expect(manager.getDevice("mcu-1")!.pendingQueue.length).toBe(1);

    // Wake up via MCU hello -> flushes queued seqId=2
    manager.handleRelayFrame({ flags: FLAG_DATA, src: "os-1", dst: "master-m1", payload: helloWire });
    await new Promise((r) => setTimeout(r, 10));
    expect(relaySock.sent.length).toBe(3);
    const wakeFrame = decodeRelayFrame(relaySock.sent[2] as Uint8Array);
    const wakeMsg = openDeviceMessage(wakeFrame.payload, e2eKey, clusterId, "master-m1", "os-1");
    const wakeEnv = openRelayEnvelope(wakeMsg.body as never, e2eKey, clusterId);
    expect(wakeEnv.envelope.seq_id).toBe(2);

    // Acknowledge seqId=2
    const mcuRes2 = sealRelayEnvelope({
      clusterId,
      relayNodeId: "os-1",
      targetMcuId: "mcu-1",
      direction: "uplink",
      seqId: 2,
      payload: { t: "res", ok: true, a: "read_dht22", d: { temp: 25 }, e: "" },
      e2eMasterSecret: e2eKey,
    });
    const mcuRes2Wire = sealDeviceMessage(
      {
        v: 1,
        kind: "relay_envelope",
        req_id: "r-mcu-2",
        cluster_id: clusterId,
        device_id: "os-1",
        ts_ms: Date.now(),
        body: mcuRes2 as unknown as Record<string, unknown>,
      },
      e2eKey,
      "os-1",
      "master-m1",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: "os-1", dst: "master-m1", payload: mcuRes2Wire });
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.getDevice("mcu-1")!.pendingQueue.length).toBe(0);
    expect(manager.getDevice("mcu-1")!.lastAckedSeqId).toBe(2);

    // 6. Tier 1 disconnect -> marks child MCU unreachable_via_relay with alertSuppressed
    const disconnectOutcome = manager.handleTier1Disconnect("os-1");
    expect(disconnectOutcome.unreachable).toEqual(["mcu-1"]);
    expect(manager.getDevice("os-1")!.status).toBe("offline");
    expect(manager.getDevice("mcu-1")!.status).toBe("unreachable_via_relay");
    expect(manager.getDevice("mcu-1")!.alertSuppressed).toBe(true);

    // 7. Failover to backup Tier 1 relay when available
    manager.upsertDeviceManifest({ device_id: "os-1", tier: "os", capabilities: ["relay"] }, { status: "online" });
    manager.upsertDeviceManifest({ device_id: "os-backup", tier: "os", capabilities: ["relay"] }, { status: "online" });
    manager.upsertDeviceManifest(
      { device_id: "mcu-1", tier: "mcu", acts: ["read_dht22"] },
      { route: "via_tier1", status: "online", relayNodeId: "os-1", backupRelayNodeIds: ["os-backup"] },
    );
    const failoverOutcome = manager.handleTier1Disconnect("os-1");
    expect(failoverOutcome.failedOver).toEqual(["mcu-1"]);
    expect(manager.getDevice("mcu-1")!.relayNodeId).toBe("os-backup");
    expect(manager.getDevice("mcu-1")!.status).toBe("online");
    expect(manager.getDevice("mcu-1")!.alertSuppressed).toBe(false);

    // 7b. Live neo-relay FLAG_ERR_OFFLINE (0x81) frame: src="neo-relay", dst=master, payload=UTF8(offlinePeer)
    manager.upsertDeviceManifest({ device_id: "os-live", tier: "os", capabilities: ["exec", "relay"] }, { status: "online" });
    manager.upsertDeviceManifest(
      { device_id: "mcu-live", tier: "mcu", acts: ["read_dht22"] },
      { route: "via_tier1", status: "online", relayNodeId: "os-live" },
    );
    relaySock.emitMessage(
      encodeRelayFrame({
        flags: FLAG_ERR_OFFLINE,
        src: "neo-relay",
        dst: "master-m1",
        payload: new TextEncoder().encode("os-live"),
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.getDevice("os-live")!.status).toBe("offline");
    expect(manager.getDevice("mcu-live")!.status).toBe("unreachable_via_relay");
    expect(manager.getDevice("mcu-live")!.alertSuppressed).toBe(true);

    // 8. Verify persistence on reload with same Store
    const manager2 = new DeviceManager({ store, masterId: "m1" });
    expect(manager2.initFromEnv({})?.clusterId).toBe(clusterId);
    expect(manager2.getDevice("mcu-1")?.relayNodeId).toBe("os-backup");

    // Verify CBOR encode/decode sanity for downstream payload
    expect(decodeCbor(encodeCbor({ ok: true }))).toEqual({ ok: true });

    await manager.stop();
    await manager2.stop();
    store.close();
  });

  test("App wiring, tools (device_list/device_invoke/device_approve), and HTTP API device routes", async () => {
    const dir = new TempDir("neo-devices-api");
    try {
      const scripted = new Scripted();
      scripted.model = async () => "ok";
      const app = App.open(
        { stateDir: dir.path, wechat: new Protocol() },
        new ScriptedKernels(scripted),
        defaultTimings(),
      );
      // Disabled/idle by default when env unconfigured
      expect(app.devices.isEnabled()).toBe(false);
      await app.start();

      // Configure at runtime without relayUrl
      await app.devices.configure(
        {
          clusterId: "cluster-http",
          masterNodeId: "master-http",
          relaySecret: "http-relay-secret",
          e2eKey: "http-e2e-key",
        },
        { connect: false },
      );

      app.devices.upsertDeviceManifest(
        { device_id: "os-http", tier: "os", capabilities: ["exec", "relay"] },
        { status: "online" },
      );
      app.devices.upsertDeviceManifest(
        { device_id: "mcu-http", tier: "mcu", acts: ["set_fan_pwm"] },
        { status: "sleeping", relayNodeId: "os-http" },
      );

      // Tools check
      const listResult = (await app.mainTool("device_list", {})) as {
        devices: Array<{ deviceId: string }>;
      };
      expect(listResult.devices.map((d) => d.deviceId).sort()).toEqual(["mcu-http", "os-http"]);

      const workerInvoke = (await app.workerTool("t-1", "device_invoke", {
        device_id: "mcu-http",
        action: "set_fan_pwm",
        params: { duty: 70 },
      })) as { status: string; shortCode: string; approvalId: string };
      expect(workerInvoke.status).toBe("pending_approval");

      const workerApprove = (await app.workerTool("t-1", "device_approve", {
        approval_id: workerInvoke.shortCode,
        decision: "approve",
      })) as { approval: { status: string }; result: { status: string } };
      expect(workerApprove.approval.status).toBe("approved");
      expect(workerApprove.result.status).toBe("queued");

      // HTTP API routes check
      const peer = { host: "127.0.0.1", port: 50001 };
      const access = {};

      const listRes = await handle(app, access, makeRequest("GET", "/api/devices"), peer);
      expect(listRes.status).toBe(200);
      const listJson = JSON.parse(new TextDecoder().decode(listRes.body)) as {
        devices: Array<{ deviceId: string }>;
      };
      expect(listJson.devices.length).toBe(2);

      const getRes = await handle(app, access, makeRequest("GET", "/api/devices/mcu-http"), peer);
      expect(getRes.status).toBe(200);

      const missingRes = await handle(app, access, makeRequest("GET", "/api/devices/nope"), peer);
      expect(missingRes.status).toBe(404);

      const tokRes = await handle(
        app,
        access,
        makeRequest("POST", "/api/devices/token", { nodeId: "os-http", tier: "os", ttlSec: 120 }),
        peer,
      );
      expect(tokRes.status).toBe(200);
      const tokJson = JSON.parse(new TextDecoder().decode(tokRes.body)) as { token: string };
      expect(tokJson.token.startsWith("neo1.")).toBe(true);

      const invokeRes = await handle(
        app,
        access,
        makeRequest("POST", "/api/devices/mcu-http/invoke", {
          action: "set_fan_pwm",
          params: { duty: 60 },
        }),
        peer,
      );
      expect(invokeRes.status).toBe(202);
      const invokeJson = JSON.parse(new TextDecoder().decode(invokeRes.body)) as {
        status: string;
        approvalId: string;
      };
      expect(invokeJson.status).toBe("pending_approval");

      const approvalsRes = await handle(app, access, makeRequest("GET", "/api/devices/approvals"), peer);
      expect(approvalsRes.status).toBe(200);

      const rejectRes = await handle(
        app,
        access,
        makeRequest("POST", `/api/devices/approvals/${invokeJson.approvalId}/reject`, {
          reason: "too loud",
        }),
        peer,
      );
      expect(rejectRes.status).toBe(200);
      const rejectJson = JSON.parse(new TextDecoder().decode(rejectRes.body)) as {
        approval: { status: string; error: string };
      };
      expect(rejectJson.approval.status).toBe("rejected");
      expect(rejectJson.approval.error).toBe("too loud");

      await app.stop();
      app.close();
    } finally {
      dir.cleanup();
    }
  });

  test("DeviceManager connects using pre-minted token or tokenProvider without relaySecret/clusterSecret", async () => {
    const store = Store.memory();
    const { sockets, wsFactory } = makeMockSockets();
    const manager = new DeviceManager({
      store,
      masterId: "tok",
      fetchFn: (async () =>
        new Response(JSON.stringify({ cluster_id: "c-tok" }), { status: 200 })) as unknown as typeof fetch,
      wsFactory,
      pingIntervalMs: 0,
    });

    await manager.configure(
      {
        clusterId: "c-tok",
        masterNodeId: "master-tok",
        relayUrl: "https://relay.local:18443",
        token: "neo1.preminted.sig",
        e2eKey: "tok-e2e-key",
      },
      { connect: true },
    );

    expect(manager.getRelayClient()?.isRelayConnected()).toBe(true);
    expect(manager.configView().hasToken).toBe(true);
    expect(JSON.stringify(manager.configView())).not.toContain("neo1.preminted.sig");
    expect(sockets.every((s) => s.headers.Authorization === "Bearer neo1.preminted.sig")).toBe(true);

    await manager.stop();
    store.close();
  });

  test("inferSandboxLevel handles explicit levels, boolean flags, fallback, and legacy mem/timeout heuristics", () => {
    expect(inferSandboxLevel({ level: "unrestricted", read_only: true }, "corp")).toBe("unrestricted");
    expect(inferSandboxLevel({ level: "desktop" })).toBe("desktop");
    expect(inferSandboxLevel({ unrestricted: true }, "personal")).toBe("unrestricted");
    expect(inferSandboxLevel({ read_only: true }, "personal")).toBe("readonly");
    expect(inferSandboxLevel({ max_child_mem_mb: 1024, max_exec_timeout_sec: 60 }, "corp")).toBe("corp");
    expect(inferSandboxLevel({ max_child_mem_mb: 0, max_exec_timeout_sec: 0 })).toBe("unrestricted");
    expect(inferSandboxLevel({ max_child_mem_mb: 1024, max_exec_timeout_sec: 60 })).toBe("readonly");
    expect(inferSandboxLevel({ max_child_mem_mb: 4096, max_exec_timeout_sec: 90 })).toBe("corp");
    expect(inferSandboxLevel({ max_child_mem_mb: 4096, max_exec_timeout_sec: 180 })).toBe("desktop");
    expect(inferSandboxLevel({ max_child_mem_mb: 2048, max_exec_timeout_sec: 120 })).toBe("personal");
    expect(inferSandboxLevel({ allowed_workspaces: ["/work"] })).toBe("personal");
    expect(inferSandboxLevel(undefined, "desktop")).toBe("desktop");
    expect(inferSandboxLevel(undefined, undefined)).toBeUndefined();
  });

  test("setDeviceSandboxLevel online E2E RPC sync, offline desired-state sync-on-reconnect, older agent unsupported, locked agent, and risk gate", async () => {
    const store = Store.memory();
    const { sockets, wsFactory } = makeMockSockets();
    const clusterId = "cluster-sbx";
    const e2eKey = "sandbox-e2e-secret";

    const manager = new DeviceManager({
      store,
      masterId: "sbx",
      fetchFn: (async () =>
        new Response(JSON.stringify({ cluster_id: clusterId }), { status: 200 })) as unknown as typeof fetch,
      wsFactory,
      pingIntervalMs: 0,
    });

    try {
      await manager.configure(
        {
          clusterId,
          masterNodeId: "master-sbx",
          relayUrl: "https://relay.local:18443",
          relaySecret: "sbx-relay-secret",
          e2eKey,
        },
        { persist: true, connect: true },
      );

      const relaySock = sockets.find((s) => s.url.endsWith("/v1/relay"))!;

      const emitManifest = (deviceId: string, sandbox: Record<string, unknown>) => {
        const wire = sealDeviceMessage(
          {
            v: 1,
            kind: "manifest",
            req_id: `man-${Date.now()}-${Math.random()}`,
            cluster_id: clusterId,
            device_id: deviceId,
            ts_ms: Date.now(),
            body: {
              device_id: deviceId,
              tier: "os",
              os: "linux",
              arch: "x86_64",
              capabilities: ["exec", "fs"],
              sandbox,
            },
          },
          e2eKey,
          deviceId,
          "master-sbx",
        );
        manager.handleRelayFrame({ flags: FLAG_DATA, src: deviceId, dst: "master-sbx", payload: wire });
      };

      const emitRpcResp = (deviceId: string, reqId: string, body: Record<string, unknown>) => {
        const wire = sealDeviceMessage(
          {
            v: 1,
            kind: "rpc_resp",
            req_id: reqId,
            cluster_id: clusterId,
            device_id: deviceId,
            ts_ms: Date.now(),
            body,
          },
          e2eKey,
          deviceId,
          "master-sbx",
        );
        manager.handleRelayFrame({ flags: FLAG_DATA, src: deviceId, dst: "master-sbx", payload: wire });
      };

      // 1. Online Tier 1 OS agent registers with personal sandbox
      emitManifest("os-1", {
        level: "personal",
        unrestricted: false,
        read_only: false,
        locked: false,
        allowed_workspaces: ["/home/neo/work"],
        max_child_mem_mb: 2048,
        max_exec_timeout_sec: 120,
      });

      const initialTwin = manager.getDevice("os-1")!;
      expect(initialTwin.sandboxLevel).toBe("personal");
      expect(initialTwin.sandboxSyncState).toBe("synced");

      // 2. Online setDeviceSandboxLevel -> E2E set_sandbox RPC -> synced + updated manifest.sandbox
      const updatePromise = manager.setDeviceSandboxLevel("os-1", "unrestricted", {
        workspaces: ["/srv/work"],
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(relaySock.sent.length).toBe(1);
      const outFrame1 = decodeRelayFrame(relaySock.sent[0] as Uint8Array);
      expect(outFrame1.dst).toBe("os-1");
      const outMsg1 = openDeviceMessage(outFrame1.payload, e2eKey, clusterId, "master-sbx", "os-1");
      expect(outMsg1.kind).toBe("rpc_req");
      expect(outMsg1.body.method).toBe("set_sandbox");
      expect(outMsg1.body.params).toEqual({ level: "unrestricted", workspaces: ["/srv/work"] });

      emitRpcResp("os-1", outMsg1.req_id, {
        ok: true,
        result: {
          persisted: false,
          persist_warning: "policy file is read-only; applied in memory only",
          sandbox: {
            level: "unrestricted",
            unrestricted: true,
            read_only: false,
            locked: false,
            allowed_workspaces: ["/srv/work"],
            max_child_mem_mb: 0,
            max_exec_timeout_sec: 0,
          },
        },
      });

      const updateRes = await updatePromise;
      expect(updateRes.applied).toBe(true);
      expect(updateRes.pending).toBe(false);
      expect(updateRes.level).toBe("unrestricted");
      expect(updateRes.persisted).toBe(false);
      expect(updateRes.warning).toBe("policy file is read-only; applied in memory only");
      expect(updateRes.device.sandboxLevel).toBe("unrestricted");
      expect(updateRes.device.desiredSandboxLevel).toBe("unrestricted");
      expect(updateRes.device.sandboxSyncState).toBe("synced");
      expect(updateRes.device.sandboxSyncError).toBeUndefined();
      expect(updateRes.device.manifest?.sandbox?.unrestricted).toBe(true);
      expect(updateRes.device.manifest?.sandbox?.allowed_workspaces).toEqual(["/srv/work"]);
      expect(updateRes.device.reportedState.sandboxLevel).toBe("unrestricted");

      // 3. Offline desired-state persistence & automatic sync on reconnect (with duplicate manifest guard)
      manager.handleTier1Disconnect("os-1");
      expect(manager.getDevice("os-1")!.status).toBe("offline");

      const offlineRes = await manager.setDeviceSandboxLevel("os-1", "readonly");
      expect(offlineRes.applied).toBe(false);
      expect(offlineRes.pending).toBe(true);
      expect(offlineRes.level).toBe("readonly");
      expect(offlineRes.warning).toContain("offline");
      expect(offlineRes.device.desiredSandboxLevel).toBe("readonly");
      expect(offlineRes.device.sandboxLevel).toBe("unrestricted");
      expect(offlineRes.device.sandboxSyncState).toBe("pending");
      expect(offlineRes.device.desiredState.sandboxLevel).toBe("readonly");
      expect(relaySock.sent.length).toBe(1); // no RPC sent while offline

      // Device reconnects and emits TWO back-to-back manifests reporting old level ("unrestricted")
      emitManifest("os-1", {
        level: "unrestricted",
        unrestricted: true,
        read_only: false,
        locked: false,
      });
      emitManifest("os-1", {
        level: "unrestricted",
        unrestricted: true,
        read_only: false,
        locked: false,
      });
      await new Promise((r) => setTimeout(r, 15));

      // Exactly ONE auto-sync set_sandbox RPC dispatched (re-entrancy guard blocks duplicate)
      expect(relaySock.sent.length).toBe(2);
      const syncFrame = decodeRelayFrame(relaySock.sent[1] as Uint8Array);
      const syncMsg = openDeviceMessage(syncFrame.payload, e2eKey, clusterId, "master-sbx", "os-1");
      expect(syncMsg.body.method).toBe("set_sandbox");
      expect(syncMsg.body.params).toEqual({ level: "readonly" });

      emitRpcResp("os-1", syncMsg.req_id, {
        ok: true,
        result: {
          persisted: true,
          sandbox: {
            level: "readonly",
            unrestricted: false,
            read_only: true,
            locked: false,
            max_child_mem_mb: 1024,
            max_exec_timeout_sec: 60,
          },
        },
      });
      await new Promise((r) => setTimeout(r, 15));

      const syncedTwin = manager.getDevice("os-1")!;
      expect(syncedTwin.sandboxLevel).toBe("readonly");
      expect(syncedTwin.desiredSandboxLevel).toBe("readonly");
      expect(syncedTwin.sandboxSyncState).toBe("synced");
      expect(syncedTwin.manifest?.sandbox?.read_only).toBe(true);

      // 3b. Offline desired level already matching when device reconnects -> synced immediately without RPC
      manager.handleTier1Disconnect("os-1");
      await manager.setDeviceSandboxLevel("os-1", "corp");
      emitManifest("os-1", { level: "corp", unrestricted: false, read_only: false, locked: false });
      await new Promise((r) => setTimeout(r, 15));
      expect(relaySock.sent.length).toBe(2); // no extra RPC
      expect(manager.getDevice("os-1")!.sandboxSyncState).toBe("synced");
      expect(manager.getDevice("os-1")!.sandboxLevel).toBe("corp");

      // 3c. Offline desired level when reconnecting manifest reports locked: true -> locked without RPC
      manager.handleTier1Disconnect("os-1");
      await manager.setDeviceSandboxLevel("os-1", "desktop");
      emitManifest("os-1", { level: "corp", unrestricted: false, read_only: false, locked: true });
      await new Promise((r) => setTimeout(r, 15));
      expect(relaySock.sent.length).toBe(2); // no RPC sent to locked agent
      expect(manager.getDevice("os-1")!.sandboxSyncState).toBe("locked");
      expect(manager.getDevice("os-1")!.sandboxSyncError).toContain("locked");

      // 4. Older agent returning "unsupported RPC method: set_sandbox"
      emitManifest("os-old", {
        allowed_workspaces: ["/work"],
        max_child_mem_mb: 4096,
        max_exec_timeout_sec: 90,
      });
      expect(manager.getDevice("os-old")!.sandboxLevel).toBe("corp");

      const unsupPromise = manager.setDeviceSandboxLevel("os-old", "desktop");
      await new Promise((r) => setTimeout(r, 10));
      expect(relaySock.sent.length).toBe(3);
      const unsupMsg = openDeviceMessage(
        decodeRelayFrame(relaySock.sent[2] as Uint8Array).payload,
        e2eKey,
        clusterId,
        "master-sbx",
        "os-old",
      );
      emitRpcResp("os-old", unsupMsg.req_id, {
        ok: false,
        error: "unsupported RPC method: set_sandbox",
      });
      const unsupRes = await unsupPromise;
      expect(unsupRes.applied).toBe(false);
      expect(unsupRes.pending).toBe(true);
      expect(unsupRes.error).toContain("unsupported RPC method");
      expect(unsupRes.warning).toContain("upgrade neo-agent-os");
      expect(unsupRes.device.sandboxSyncState).toBe("unsupported");
      expect(unsupRes.device.desiredSandboxLevel).toBe("desktop");

      // 5. Locally locked agent returning locked error
      emitManifest("os-locked", {
        level: "corp",
        locked: true,
      });
      const lockedPromise = manager.setDeviceSandboxLevel("os-locked", "unrestricted");
      await new Promise((r) => setTimeout(r, 10));
      expect(relaySock.sent.length).toBe(4);
      const lockedMsg = openDeviceMessage(
        decodeRelayFrame(relaySock.sent[3] as Uint8Array).payload,
        e2eKey,
        clusterId,
        "master-sbx",
        "os-locked",
      );
      emitRpcResp("os-locked", lockedMsg.req_id, {
        ok: false,
        error: "Sandbox level is locked by local policy (lock_sandbox = true)",
      });
      const lockedRes = await lockedPromise;
      expect(lockedRes.applied).toBe(false);
      expect(lockedRes.pending).toBe(false);
      expect(lockedRes.error).toContain("locked");
      expect(lockedRes.device.sandboxSyncState).toBe("locked");
      expect(lockedRes.device.sandboxLevel).toBe("corp");
      expect(lockedRes.device.desiredSandboxLevel).toBe("corp");

      // 6. Transient RPC error keeps desired state pending for retry
      const errPromise = manager.setDeviceSandboxLevel("os-1", "personal");
      await new Promise((r) => setTimeout(r, 10));
      expect(relaySock.sent.length).toBe(5);
      const errMsg = openDeviceMessage(
        decodeRelayFrame(relaySock.sent[4] as Uint8Array).payload,
        e2eKey,
        clusterId,
        "master-sbx",
        "os-1",
      );
      emitRpcResp("os-1", errMsg.req_id, {
        ok: false,
        error: "temporary disk busy",
      });
      const errRes = await errPromise;
      expect(errRes.applied).toBe(false);
      expect(errRes.pending).toBe(true);
      expect(errRes.error).toBe("temporary disk busy");
      expect(errRes.device.sandboxSyncState).toBe("pending");
      expect(errRes.device.desiredSandboxLevel).toBe("personal");

      // 7. Autonomous LLM device_invoke risk gate for set_sandbox & sandbox.set
      const gate1 = await manager.invoke("os-1", {
        action: "set_sandbox",
        params: { level: "unrestricted" },
      });
      expect(gate1.status).toBe("pending_approval");
      const gate2 = await manager.invoke("os-1", {
        action: "sandbox.set",
        params: { level: "unrestricted" },
      });
      expect(gate2.status).toBe("pending_approval");
    } finally {
      await manager.stop();
      store.close();
    }
  });

  test("HTTP PUT /api/devices/:id/sandbox handles online LAN, offline pending, locked 403, MCU 400, invalid level/workspaces 400, unknown 404, cross-cluster 403, and device_invoke risk gate", async () => {
    const dir = new TempDir("neo-sandbox-http");
    try {
      let lanResponse: Record<string, unknown> = { ok: true, result: { persisted: true } };
      const mockedFetch = (async () =>
        new Response(JSON.stringify(lanResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

      const scripted = new Scripted();
      scripted.model = async () => "ok";
      const app = App.open(
        { stateDir: dir.path, wechat: new Protocol() },
        new ScriptedKernels(scripted),
        defaultTimings(),
      );

      // Inject mock fetchFn onto DeviceManager via configure + LAN route for deterministic HTTP E2E test
      (app.devices as unknown as { fetchFn: typeof fetch }).fetchFn = mockedFetch;

      await app.devices.configure(
        {
          clusterId: "cluster-sbx-http",
          masterNodeId: "master-sbx-http",
          clusterSecret: "sbx-http-secret",
          e2eKey: "sbx-http-e2e",
        },
        { connect: false },
      );

      app.devices.upsertDeviceManifest(
        {
          device_id: "os-lan",
          tier: "os",
          capabilities: ["exec", "fs"],
          sandbox: { level: "personal", locked: false },
        },
        { status: "online", route: "lan", lanUrl: "http://127.0.0.1:9999" },
      );
      app.devices.upsertDeviceManifest(
        {
          device_id: "os-offline",
          tier: "os",
          capabilities: ["exec", "fs"],
          sandbox: { level: "personal", locked: false },
        },
        { status: "offline" },
      );
      app.devices.upsertDeviceManifest(
        { device_id: "mcu-esp", tier: "mcu", acts: ["read_dht22"] },
        { status: "sleeping", relayNodeId: "os-lan" },
      );
      // Cross-cluster twin directly saved in store
      const crossClusterTwin = app.devices.upsertDeviceManifest(
        { device_id: "os-foreign", tier: "os", capabilities: ["exec"] },
        { status: "online" },
      );
      app.devices.saveDevice({ ...crossClusterTwin, clusterId: "other-cluster" });

      const peer = { host: "127.0.0.1", port: 51234 };
      const access = {};

      // 1. Online LAN Tier 1 -> 200 applied
      lanResponse = {
        ok: true,
        result: {
          persisted: true,
          sandbox: {
            level: "desktop",
            unrestricted: false,
            read_only: false,
            locked: false,
            allowed_workspaces: ["/home/dev/work"],
            max_child_mem_mb: 4096,
            max_exec_timeout_sec: 180,
          },
        },
      };
      const okRes = await handle(
        app,
        access,
        makeRequest("PUT", "/api/devices/os-lan/sandbox", {
          level: "desktop",
          workspaces: ["/home/dev/work"],
          timeoutMs: 5000,
        }),
        peer,
      );
      expect(okRes.status).toBe(200);
      const okJson = JSON.parse(new TextDecoder().decode(okRes.body)) as {
        applied: boolean;
        pending: boolean;
        persisted: boolean;
        level: string;
        device: { sandboxLevel: string; sandboxSyncState: string };
      };
      expect(okJson.applied).toBe(true);
      expect(okJson.pending).toBe(false);
      expect(okJson.persisted).toBe(true);
      expect(okJson.level).toBe("desktop");
      expect(okJson.device.sandboxLevel).toBe("desktop");
      expect(okJson.device.sandboxSyncState).toBe("synced");

      // 2. Locked agent -> HTTP 403
      lanResponse = {
        ok: false,
        error: "Sandbox is locked by local policy (lock_sandbox = true)",
      };
      const lockedRes = await handle(
        app,
        access,
        makeRequest("PUT", "/api/devices/os-lan/sandbox", { level: "unrestricted" }),
        peer,
      );
      expect(lockedRes.status).toBe(403);
      const lockedJson = JSON.parse(new TextDecoder().decode(lockedRes.body)) as {
        error: string;
        applied: boolean;
        pending: boolean;
        device: { sandboxSyncState: string; desiredSandboxLevel: string };
      };
      expect(lockedJson.error).toContain("locked");
      expect(lockedJson.applied).toBe(false);
      expect(lockedJson.pending).toBe(false);
      expect(lockedJson.device.sandboxSyncState).toBe("locked");
      expect(lockedJson.device.desiredSandboxLevel).toBe("desktop");

      // 3. Offline Tier 1 -> HTTP 200 with pending: true
      const offlineRes = await handle(
        app,
        access,
        makeRequest("PUT", "/api/devices/os-offline/sandbox", { level: "unrestricted" }),
        peer,
      );
      expect(offlineRes.status).toBe(200);
      const offlineJson = JSON.parse(new TextDecoder().decode(offlineRes.body)) as {
        applied: boolean;
        pending: boolean;
        device: { desiredSandboxLevel: string; sandboxSyncState: string };
      };
      expect(offlineJson.applied).toBe(false);
      expect(offlineJson.pending).toBe(true);
      expect(offlineJson.device.desiredSandboxLevel).toBe("unrestricted");
      expect(offlineJson.device.sandboxSyncState).toBe("pending");

      // 4. Tier 2 MCU -> HTTP 400
      const mcuRes = await handle(
        app,
        access,
        makeRequest("PUT", "/api/devices/mcu-esp/sandbox", { level: "readonly" }),
        peer,
      );
      expect(mcuRes.status).toBe(400);

      // 5. Invalid level -> HTTP 400
      const badLevelRes = await handle(
        app,
        access,
        makeRequest("PUT", "/api/devices/os-lan/sandbox", { level: "godmode" }),
        peer,
      );
      expect(badLevelRes.status).toBe(400);

      // 6. Invalid workspaces (path traversal / wrong type) -> HTTP 400
      const badWsTraversal = await handle(
        app,
        access,
        makeRequest("PUT", "/api/devices/os-lan/sandbox", {
          level: "personal",
          workspaces: ["/work/../etc"],
        }),
        peer,
      );
      expect(badWsTraversal.status).toBe(400);

      const badWsType = await handle(
        app,
        access,
        makeRequest("PUT", "/api/devices/os-lan/sandbox", {
          level: "personal",
          workspaces: [123],
        }),
        peer,
      );
      expect(badWsType.status).toBe(400);

      // 7. Invalid timeoutMs -> HTTP 400
      const badTimeout = await handle(
        app,
        access,
        makeRequest("PUT", "/api/devices/os-lan/sandbox", {
          level: "personal",
          timeoutMs: 0,
        }),
        peer,
      );
      expect(badTimeout.status).toBe(400);

      // 8. Unknown device -> HTTP 404
      const missingRes = await handle(
        app,
        access,
        makeRequest("PUT", "/api/devices/no-such-device/sandbox", { level: "personal" }),
        peer,
      );
      expect(missingRes.status).toBe(404);

      // 9. Cross-cluster device -> HTTP 403
      const crossRes = await handle(
        app,
        access,
        makeRequest("PUT", "/api/devices/os-foreign/sandbox", { level: "personal" }),
        peer,
      );
      expect(crossRes.status).toBe(403);

      // 10. Autonomous LLM workerTool device_invoke("set_sandbox") -> pending_approval
      const llmGate = (await app.workerTool("t-sbx", "device_invoke", {
        device_id: "os-lan",
        action: "set_sandbox",
        params: { level: "unrestricted" },
      })) as { status: string; action: string };
      expect(llmGate.status).toBe("pending_approval");
      expect(llmGate.action).toBe("set_sandbox");

      await app.stop();
      app.close();
    } finally {
      dir.cleanup();
    }
  });
});
