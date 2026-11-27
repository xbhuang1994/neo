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
  compareSemver,
  decodeCbor,
  decodeRelayFrame,
  encodeCbor,
  encodeRelayFrame,
  isVersionOlder,
  openDeviceMessage,
  openRelayEnvelope,
  renderDirectInstallPs1,
  renderDirectInstallSh,
  sealDeviceMessage,
  sealRelayEnvelope,
  type RelaySocket,
} from "../../src/devices/index.ts";
import { VERSION } from "../../src/version.ts";
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

  test("DeviceManager remote updates Tier 1 & Tier 2 devices strictly matching Master Neo version and never exceeding it", async () => {
    // Semver ordering checks
    expect(compareSemver("0.8.0", "0.9.1")).toBe(-1);
    expect(compareSemver("0.9.1", "0.10.0")).toBe(-1);
    expect(compareSemver("0.9.1-rc.1", "0.9.1")).toBe(-1);
    expect(compareSemver("v0.9.1", "0.9.1")).toBe(0);
    expect(compareSemver("0.10.0", "0.9.1")).toBe(1);
    expect(isVersionOlder("0.9.0", "0.9.1")).toBe(true);
    expect(isVersionOlder("0.9.1", "0.9.1")).toBe(false);
    expect(isVersionOlder("0.10.0", "0.9.1")).toBe(false);

    // Direct install scripts include --upgrade / -Upgrade mode
    const sh = renderDirectInstallSh({ origin: "http://127.0.0.1:3082", agentVersion: VERSION });
    expect(sh).toContain("--upgrade");
    const ps1 = renderDirectInstallPs1({ origin: "http://127.0.0.1:3082", agentVersion: VERSION });
    expect(ps1).toContain("[switch]$Upgrade");

    const store = Store.memory();
    const { sockets, wsFactory } = makeMockSockets();
    const clusterId = "cluster-upd";
    const e2eKey = "upd-e2e-key";

    // Even if agentVersion override is higher, auto-update strictly pins to masterVersion!
    const manager = new DeviceManager({
      store,
      masterId: "m1",
      masterVersion: "0.9.1",
      agentVersion: "0.9.9",
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
    expect(manager.configView().masterVersion).toBe("0.9.1");
    const relaySock = sockets.find((s) => s.url.endsWith("/v1/relay"))!;

    // 1. Register outdated Tier 1 device (v0.8.0) via manifest
    const oldManifest = sealDeviceMessage(
      {
        v: 1,
        kind: "manifest",
        req_id: "m-old",
        cluster_id: clusterId,
        device_id: "mac-01",
        ts_ms: Date.now(),
        body: {
          device_id: "mac-01",
          tier: "os",
          version: "0.8.0",
          os: "macos",
          arch: "aarch64",
          capabilities: ["exec", "fs", "self_update"],
        },
      },
      e2eKey,
      "mac-01",
      "master-m1",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: "mac-01", dst: "master-m1", payload: oldManifest });
    expect(manager.getDevice("mac-01")?.manifest?.version).toBe("0.8.0");

    // 2. Reject any explicit targetVersion higher than Master Neo version (0.9.2 > 0.9.1)
    await expect(manager.updateDevice("mac-01", { targetVersion: "0.9.2" })).rejects.toThrow(
      /exceeds Master Neo version/,
    );
    // Also reject any targetVersion that does not match Master Neo version (0.9.0 != 0.9.1)
    await expect(manager.updateDevice("mac-01", { targetVersion: "0.9.0" })).rejects.toThrow(
      /must match Master Neo version/,
    );

    // 3. Default update targets exact Master Neo version (0.9.1), NOT agentVersion (0.9.9)
    const updPromise = manager.updateDevice("mac-01");
    await new Promise((r) => setTimeout(r, 10));
    expect(relaySock.sent.length).toBe(1);
    const outFrame = decodeRelayFrame(relaySock.sent[0] as Uint8Array);
    const outMsg = openDeviceMessage(outFrame.payload, e2eKey, clusterId, "master-m1", "mac-01");
    expect(outMsg.kind).toBe("rpc_req");
    expect(outMsg.body.method).toBe("self_update");
    const outParams = outMsg.body.params as Record<string, unknown>;
    expect(outParams.target_version).toBe("0.9.1");
    expect(outParams.master_version).toBe("0.9.1");
    expect(outParams.asset).toBe("neo-agent-os-0.9.1-macos-arm64.tar.gz");
    expect(outParams.mirrors).toEqual([
      "https://relay.local:18443/dl/v0.9.1",
      "https://github.com/xbhuang1994/neo/releases/download/v0.9.1",
    ]);

    // Simulate Tier 1 agent rpc_resp
    const respWire = sealDeviceMessage(
      {
        v: 1,
        kind: "rpc_resp",
        req_id: outMsg.req_id,
        cluster_id: clusterId,
        device_id: "mac-01",
        ts_ms: Date.now(),
        body: {
          ok: true,
          result: {
            status: "restarting",
            previous_version: "0.8.0",
            target_version: "0.9.1",
            installed_path: "/Users/test/.local/bin/neo-agent-os",
            sha256: "abc123",
            mirror: "https://relay.local:18443/dl/v0.9.1",
          },
        },
      },
      e2eKey,
      "mac-01",
      "master-m1",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: "mac-01", dst: "master-m1", payload: respWire });
    const updRes = await updPromise;
    expect(updRes.ok).toBe(true);
    expect(updRes.status).toBe("restarting");
    expect(updRes.targetVersion).toBe("0.9.1");
    expect(updRes.currentVersion).toBe("0.8.0");
    expect(updRes.installedPath).toBe("/Users/test/.local/bin/neo-agent-os");

    // 4. After agent reconnects with heartbeat/manifest v0.9.1, updateDevice returns up_to_date
    const hbWire = sealDeviceMessage(
      {
        v: 1,
        kind: "heartbeat",
        req_id: "hb-1",
        cluster_id: clusterId,
        device_id: "mac-01",
        ts_ms: Date.now(),
        body: { status: "online", version: "0.9.1" },
      },
      e2eKey,
      "mac-01",
      "master-m1",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: "mac-01", dst: "master-m1", payload: hbWire });
    expect(manager.getDevice("mac-01")?.manifest?.version).toBe("0.9.1");
    const upToDate = await manager.updateDevice("mac-01");
    expect(upToDate.ok).toBe(true);
    expect(upToDate.status).toBe("up_to_date");

    // 5. Legacy Tier 1 device returning unsupported RPC method -> manual_upgrade_required with exact masterVersion pinned
    manager.upsertDeviceManifest({
      device_id: "win-legacy",
      tier: "os",
      os: "windows",
      arch: "x86_64",
      capabilities: ["exec", "fs"],
    });
    const legacyPromise = manager.updateDevice("win-legacy");
    await new Promise((r) => setTimeout(r, 10));
    const legacyFrame = decodeRelayFrame(relaySock.sent[relaySock.sent.length - 1] as Uint8Array);
    const legacyMsg = openDeviceMessage(legacyFrame.payload, e2eKey, clusterId, "master-m1", "win-legacy");
    const legacyResp = sealDeviceMessage(
      {
        v: 1,
        kind: "rpc_resp",
        req_id: legacyMsg.req_id,
        cluster_id: clusterId,
        device_id: "win-legacy",
        ts_ms: Date.now(),
        body: { ok: false, error: "unsupported RPC method: self_update" },
      },
      e2eKey,
      "win-legacy",
      "master-m1",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: "win-legacy", dst: "master-m1", payload: legacyResp });
    const legacyRes = await legacyPromise;
    expect(legacyRes.ok).toBe(false);
    expect(legacyRes.status).toBe("manual_upgrade_required");
    expect(legacyRes.upgradeCommand).toContain('Install-NeoAgent -Upgrade -Version "0.9.1"');

    // 6. Tier 2 MCU sleeping with ota_apply -> queued in pendingQueue targeting exact masterVersion
    manager.upsertDeviceManifest(
      {
        device_id: "esp32-01",
        tier: "mcu",
        chip: "ESP32-S3",
        fw: "0.1.0",
        acts: ["get_temp", "ota_apply"],
        capabilities: ["get_temp", "ota_apply"],
      },
      { status: "sleeping", route: "via_tier1", relayNodeId: "mac-01" },
    );
    const mcuQueued = await manager.updateDevice("esp32-01");
    expect(mcuQueued.ok).toBe(true);
    expect(mcuQueued.status).toBe("queued");
    expect(mcuQueued.targetVersion).toBe("0.9.1");
    expect(manager.getDevice("esp32-01")?.pendingQueue.length).toBe(1);
    expect(manager.getDevice("esp32-01")?.pendingQueue[0]?.action).toBe("ota_apply");
    expect(manager.getDevice("esp32-01")?.pendingQueue[0]?.params).toEqual({
      version: "0.9.1",
      master_version: "0.9.1",
    });

    // 7. Tier 2 MCU without native OTA action -> stages mcu-update.json on online Tier 1 relay
    manager.upsertDeviceManifest(
      {
        device_id: "stm32-02",
        tier: "mcu",
        chip: "STM32",
        fw: "0.2.0",
        acts: ["read_sensor"],
        capabilities: ["read_sensor"],
      },
      { status: "online", route: "via_tier1", relayNodeId: "mac-01" },
    );
    const stagePromise = manager.updateDevice("stm32-02");
    await new Promise((r) => setTimeout(r, 10));
    const stageFrame = decodeRelayFrame(relaySock.sent[relaySock.sent.length - 1] as Uint8Array);
    const stageMsg = openDeviceMessage(stageFrame.payload, e2eKey, clusterId, "master-m1", "mac-01");
    expect(stageMsg.body.method).toBe("fs_write");
    const stageParams = stageMsg.body.params as Record<string, unknown>;
    expect(stageParams.path).toBe("neo-mcu/stm32-02/mcu-update.json");
    expect(String(stageParams.content)).toContain('"target_version": "0.9.1"');
    const stageResp = sealDeviceMessage(
      {
        v: 1,
        kind: "rpc_resp",
        req_id: stageMsg.req_id,
        cluster_id: clusterId,
        device_id: "mac-01",
        ts_ms: Date.now(),
        body: { ok: true, result: { path: "neo-mcu/stm32-02/mcu-update.json", bytes_written: 120 } },
      },
      e2eKey,
      "mac-01",
      "master-m1",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: "mac-01", dst: "master-m1", payload: stageResp });
    const stageRes = await stagePromise;
    expect(stageRes.ok).toBe(true);
    expect(stageRes.status).toBe("staged");

    // 8. HTTP API POST /api/devices/:id/update validation & 404/400/200 behavior
    const dir = new TempDir("neo-device-update-http-");
    try {
      const scripted = new Scripted();
      scripted.model = async () => "ok";
      const app = App.open(
        { stateDir: dir.path, wechat: new Protocol() },
        new ScriptedKernels(scripted),
        defaultTimings(),
      );
      await app.start();
      await app.devices.configure(
        { clusterId: "http-upd", masterNodeId: "master-1", e2eKey: "k1" },
        { connect: false },
      );
      app.devices.upsertDeviceManifest({
        device_id: "edge-http-1",
        tier: "os",
        version: VERSION,
        os: "linux",
        arch: "x86_64",
      });

      const access = {};
      const peer = { host: "127.0.0.1", port: 50000 };

      const notFound = await handle(app, access, makeRequest("POST", "/api/devices/missing/update", {}), peer);
      expect(notFound.status).toBe(404);

      const higherReject = await handle(
        app,
        access,
        makeRequest("POST", "/api/devices/edge-http-1/update", { targetVersion: "99.0.0" }),
        peer,
      );
      expect(higherReject.status).toBe(400);
      expect(new TextDecoder().decode(higherReject.body)).toContain("exceeds Master Neo version");

      const okRes = await handle(app, access, makeRequest("POST", "/api/devices/edge-http-1/update", {}), peer);
      expect(okRes.status).toBe(200);
      const okJson = JSON.parse(new TextDecoder().decode(okRes.body)) as { ok: boolean; status: string; targetVersion: string };
      expect(okJson.ok).toBe(true);
      expect(okJson.status).toBe("up_to_date");
      expect(okJson.targetVersion).toBe(VERSION);

      await app.stop();
      app.close();
    } finally {
      dir.cleanup();
    }

    await manager.stop();
    store.close();
  });
});
