import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { App, defaultTimings, mainSpecs, workerSpecs } from "../../src/app/index.ts";
import { Protocol } from "../../src/app/wechat_protocol.ts";
import {
  DEFAULT_RELAY_URL,
  DeviceManager,
  ENROLL_ENVELOPE_VERSION,
  ENROLL_KEY_PREFIX,
  FLAG_DATA,
  buildEnrollAad,
  decodeRelayFrame,
  deriveEnrollKey,
  deriveMcuE2eKey,
  generateEnrollTicket,
  openDeviceMessage,
  openEnrollPayload,
  parseEnrollTicket,
  renderPolicyPreset,
  sealDeviceMessage,
  sealEnrollPayload,
  verifyRelayToken,
  type EnrollPayload,
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
  closed = false;
  onSend?: (data: string | Uint8Array | ArrayBuffer) => void;

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

function makeMockSockets(onSend?: (sock: MockRelaySocket, data: string | Uint8Array | ArrayBuffer) => void) {
  const sockets: MockRelaySocket[] = [];
  const wsFactory = (url: string, headers: Record<string, string>) => {
    const ws = new MockRelaySocket(url, headers);
    if (onSend) {
      ws.onSend = (data) => onSend(ws, data);
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
  extraHeaders?: Record<string, string>,
): Request {
  const headers = new Map<string, string>([["host", "192.168.6.95:3082"]]);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k.toLowerCase(), v);
    }
  }
  let bytes = new Uint8Array(0);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    bytes = new TextEncoder().encode(JSON.stringify(body));
  }
  return new Request({ method, path: reqPath, headers, body: bytes });
}

function decodeJsonBody<T>(body: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

describe("devices/enrollment protocol, config, flow, MCU install, and HTTP API", () => {
  test("sealEnrollPayload / openEnrollPayload wire format, ticket generation, tamper detection, and policy presets", () => {
    const ticket = generateEnrollTicket();
    expect(ticket.ticketId.length).toBe(11);
    expect(ticket.ephemeralKey.length).toBe(22);
    expect(ticket.enrollCode).toBe(`neo_enr_v1.${ticket.ticketId}.${ticket.ephemeralKey}`);
    expect(parseEnrollTicket(ticket.enrollCode)).toEqual({
      ticketId: ticket.ticketId,
      ephemeralKey: ticket.ephemeralKey,
    });
    expect(() => parseEnrollTicket("bad.ticket")).toThrow();

    // Verify exact key & AAD byte-for-byte
    const expectedKey = createHash("sha256")
      .update(`neo-enroll-v1:${ticket.ticketId}:${ticket.ephemeralKey}`, "utf8")
      .digest();
    expect(Buffer.from(deriveEnrollKey(ticket.ticketId, ticket.ephemeralKey))).toEqual(expectedKey);
    expect(Buffer.from(buildEnrollAad(ticket.ticketId)).toString("utf8")).toBe(
      `neo-enroll-v1|${ticket.ticketId}`,
    );

    const payload: EnrollPayload = {
      v: 1,
      enroll_id: `enr_${ticket.ticketId}`,
      cluster_id: "personal",
      master_id: "master-1",
      relay_url: DEFAULT_RELAY_URL,
      device_id: "auto",
      auth_mode: "bootstrap_exchange",
      relay_token: "neo1.abc.def",
      e2e_key: "deadbeef",
      agent_version: "0.8.0",
      download_mirrors: [`${DEFAULT_RELAY_URL}/dl/v0.8.0`],
      checksums: {},
      install_mode: "auto",
      policy_profile: "personal",
      policy_toml: renderPolicyPreset("personal"),
      workspace_override: "",
      relay_bridge: { enabled: false, mqtt_bind: "127.0.0.1:1883", uart_device: null },
      limits: { memory_max: "2G", cpu_quota: "200%", cuda_devices: "" },
      expires_at: 1_800_000_000,
    };

    const fixedNonce = new Uint8Array(12).fill(0x5c);
    const b64 = sealEnrollPayload(payload, ticket.ticketId, ticket.ephemeralKey, fixedNonce);
    const wire = Buffer.from(b64, "base64");
    expect(wire[0]).toBe(ENROLL_ENVELOPE_VERSION);
    expect(wire[0]).toBe(0xe2);
    expect(new Uint8Array(wire.subarray(1, 13))).toEqual(fixedNonce);

    const opened = openEnrollPayload<EnrollPayload>(b64, ticket.ticketId, ticket.ephemeralKey);
    expect(opened).toEqual(payload);

    // Wrong ephemeralKey or AAD (ticketId) must fail AEAD verification
    expect(() => openEnrollPayload(b64, ticket.ticketId, "AAAAAAAAAAAAAAAAAAAAAA")).toThrow();
    expect(() => openEnrollPayload(b64, "AAAAAAAAAAA", ticket.ephemeralKey)).toThrow();

    // Tampered version byte / ciphertext / auth tag must fail
    const badVer = Buffer.from(wire);
    badVer[0] = 0xe1;
    expect(() => openEnrollPayload(badVer.toString("base64"), ticket.ticketId, ticket.ephemeralKey)).toThrow(
      "version",
    );

    const tamperedCt = Buffer.from(wire);
    tamperedCt[20] ^= 0x01;
    expect(() => openEnrollPayload(tamperedCt.toString("base64"), ticket.ticketId, ticket.ephemeralKey)).toThrow();

    const tamperedTag = Buffer.from(wire);
    tamperedTag[tamperedTag.length - 1] ^= 0x80;
    expect(() => openEnrollPayload(tamperedTag.toString("base64"), ticket.ticketId, ticket.ephemeralKey)).toThrow();

    // All 4 policy presets use {{WORKSPACE_DIR}} and enforce expected limits/commands
    for (const profile of ["personal", "corp", "readonly", "desktop"] as const) {
      const toml = renderPolicyPreset(profile);
      expect(toml).toContain('allowed_workspaces = [\n  "{{WORKSPACE_DIR}}",\n]');
    }
    expect(renderPolicyPreset("personal")).toContain("max_child_mem_mb = 2048");
    expect(renderPolicyPreset("corp")).toContain('"bash"');
    expect(renderPolicyPreset("corp")).toContain("max_exec_timeout_sec = 90");
    expect(renderPolicyPreset("readonly")).toContain("max_child_mem_mb = 1024");
    expect(renderPolicyPreset("desktop")).toContain('"flutter"');
    expect(renderPolicyPreset("desktop")).toContain("max_exec_timeout_sec = 180");
  });

  test("initOrUpdateConfig auto-detects local relay.env, derives matching neo-relayd key, persists, and hot-connects", async () => {
    const dir = new TempDir("neo-local-relay-env");
    const store = Store.memory();
    const relayEnvPath = path.join(dir.path, "relay.env");
    const rootSecret = "super-local-relay-root-secret-xyz";
    fs.writeFileSync(relayEnvPath, `# comment\nexport NEO_RELAY_SECRET="${rootSecret}"\nOTHER=1\n`, "utf8");

    const { sockets, wsFactory } = makeMockSockets();
    const manager = new DeviceManager({
      store,
      masterId: "m-auto",
      localRelayEnvPath: relayEnvPath,
      fetchFn: (async () =>
        new Response(JSON.stringify({ cluster_id: "ok" }), { status: 200 })) as unknown as typeof fetch,
      wsFactory,
      pingIntervalMs: 0,
    });

    try {
      const before = manager.configView();
      expect(before.configured).toBe(false);
      expect(before.canMintTokens).toBe(false);
      expect(before.localRelayDetected).toBe(true);
      expect(before.defaultRelayUrl).toBe(DEFAULT_RELAY_URL);
      expect(before.relayState).toBe("idle");

      const cfgView = await manager.initOrUpdateConfig({});
      expect(cfgView.configured).toBe(true);
      expect(cfgView.enabled).toBe(true);
      expect(cfgView.clusterId).toMatch(/^neo-[0-9a-f]{6}$/);
      expect(cfgView.relayUrl).toBe(DEFAULT_RELAY_URL);
      expect(cfgView.hasRelaySecret).toBe(true);
      expect(cfgView.hasClusterSecret).toBe(false);
      expect(cfgView.hasE2eKey).toBe(true);
      expect(cfgView.canMintTokens).toBe(true);
      expect(cfgView.relayState).toBe("connected");
      expect(JSON.stringify(cfgView)).not.toContain(rootSecret);

      // Minted token must verify with neo-relayd's HMAC-SHA256(rootSecret, "cluster:" + clusterId)
      const tok = manager.mintToken({ nodeId: "os-verify", tier: "os", ttlSec: 300 });
      const claims = verifyRelayToken(tok, { rootSecret, expectedClusterId: cfgView.clusterId });
      expect(claims.node_id).toBe("os-verify");
      // Also check raw HMAC equivalence directly
      const expectedKey = createHmac("sha256", Buffer.from(rootSecret, "utf8"))
        .update(`cluster:${cfgView.clusterId}`, "utf8")
        .digest();
      const parts = tok.split(".");
      const expectedSig = createHmac("sha256", expectedKey)
        .update(`neo1.${parts[1]}`, "utf8")
        .digest("base64url");
      expect(parts[2]).toBe(expectedSig);

      expect(sockets.length).toBe(2);

      // Reload from same store persists clusterId & secrets
      const manager2 = new DeviceManager({ store, masterId: "m-auto", localRelayEnvPath: relayEnvPath });
      const loaded = manager2.initFromEnv({});
      expect(loaded?.clusterId).toBe(cfgView.clusterId);
      expect(manager2.configView().canMintTokens).toBe(true);

      // Explicit relayUrl: "" switches to direct-only without defaulting back to DEFAULT_RELAY_URL
      const directOnly = await manager.initOrUpdateConfig({ relayUrl: "" });
      expect(directOnly.relayUrl).toBeUndefined();
      expect(directOnly.relayState).toBe("idle");

      await manager2.stop();
    } finally {
      await manager.stop();
      store.close();
      dir.cleanup();
    }
  });

  test("createEnrollment (relay & direct modes), syncRelay, claimDirectEnrollment single-use/410/429, and revokeEnrollment", async () => {
    const store = Store.memory();
    let nowMs = 1_765_000_000_000;
    const relayCalls: Array<{ method: string; url: string; auth: string | null; body?: unknown }> = [];
    const storedOnRelay = new Map<string, { ciphertext_b64: string; status: string; claimed_count: number; last_claimed_ip: string; last_claimed_at_ms: number }>();

    const mockFetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization");
      const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      relayCalls.push({ method, url, auth, body: rawBody });

      if (method === "POST" && url.endsWith("/v1/enroll/tickets")) {
        const ticketId = rawBody.ticket_id as string;
        storedOnRelay.set(ticketId, {
          ciphertext_b64: rawBody.ciphertext_b64,
          status: "pending",
          claimed_count: 0,
          last_claimed_ip: "",
          last_claimed_at_ms: 0,
        });
        return new Response(JSON.stringify({ ticket_id: ticketId, status: "pending" }), { status: 201 });
      }
      if (method === "GET" && url.includes("/v1/enroll/tickets/") && url.endsWith("/status")) {
        const ticketId = url.split("/v1/enroll/tickets/")[1]!.split("/status")[0]!;
        const entry = storedOnRelay.get(ticketId);
        if (!entry) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        return new Response(
          JSON.stringify({
            ticket_id: ticketId,
            cluster_id: "cluster-enr",
            status: entry.status,
            claimed_count: entry.claimed_count,
            last_claimed_ip: entry.last_claimed_ip,
            last_claimed_at_ms: entry.last_claimed_at_ms,
          }),
          { status: 200 },
        );
      }
      if (method === "DELETE" && url.includes("/v1/enroll/tickets/")) {
        const ticketId = url.split("/v1/enroll/tickets/")[1]!;
        storedOnRelay.delete(ticketId);
        return new Response(JSON.stringify({ ticket_id: ticketId, status: "revoked" }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const manager = new DeviceManager({
      store,
      masterId: "m-enr",
      fetchFn: mockFetch,
      nowMs: () => nowMs,
    });

    await manager.configure(
      {
        clusterId: "cluster-enr",
        masterNodeId: "master-enr",
        relayUrl: "https://relay.example.test:18443",
        relaySecret: "relay-root-enr",
        e2eKey: "super-secret-e2e-key-must-never-leak",
      },
      { persist: true, connect: false },
    );

    // 1. Relay mode with auto deviceId -> bootstrap_exchange
    const relayEnr = await manager.createEnrollment({
      platform: "linux",
      profile: "corp",
      installMode: "system",
      transportMode: "relay",
      ttlSec: 600,
      maxUses: 1,
    });
    expect(relayEnr.status).toBe("pending");
    expect(relayEnr.authMode).toBe("bootstrap_exchange");
    expect(relayEnr.transportMode).toBe("relay");
    expect(relayEnr.enrollCode).toMatch(/^neo_enr_v1\.[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{22}$/);
    expect(relayEnr.commands?.linuxRoot).toContain("https://relay.example.test:18443/install.sh");
    expect(relayEnr.commands?.linuxRoot).not.toContain("--claim-url");
    expect(relayEnr.commands?.docker).toContain("--ticket");
    expect(relayEnr.commands?.docker).toContain("--mode foreground");

    // Verify Store KV record NEVER contains e2eKey or ephemeralKey or relay_token
    const rawKv = JSON.stringify(store.get(`${ENROLL_KEY_PREFIX}${relayEnr.id}`));
    expect(rawKv).not.toContain("super-secret-e2e-key-must-never-leak");
    const parsedTicket = parseEnrollTicket(relayEnr.enrollCode!);
    expect(rawKv).not.toContain(parsedTicket.ephemeralKey);
    expect(rawKv).not.toContain("neo1.");

    // Decrypt parcel uploaded to relay and inspect payload
    const uploaded = storedOnRelay.get(parsedTicket.ticketId)!;
    expect(uploaded).toBeDefined();
    const decrypted = openEnrollPayload<EnrollPayload>(
      uploaded.ciphertext_b64,
      parsedTicket.ticketId,
      parsedTicket.ephemeralKey,
    );
    expect(decrypted.enroll_id).toBe(relayEnr.id);
    expect(decrypted.cluster_id).toBe("cluster-enr");
    expect(decrypted.auth_mode).toBe("bootstrap_exchange");
    expect(decrypted.device_id).toBe("auto");
    expect(decrypted.e2e_key).toBe("super-secret-e2e-key-must-never-leak");
    const tempClaims = verifyRelayToken(decrypted.relay_token, {
      rootSecret: "relay-root-enr",
      expectedClusterId: "cluster-enr",
      nowSec: Math.floor(nowMs / 1000) + 60,
    });
    expect(tempClaims.node_id).toBe(`enr-${parsedTicket.ticketId}`);
    expect(tempClaims.exp - tempClaims.iat).toBe(900); // 15-min bootstrap token

    // Simulate relay claim -> syncRelay reflects claimed IP & timestamp
    uploaded.status = "claimed";
    uploaded.claimed_count = 1;
    uploaded.last_claimed_ip = "203.0.113.55";
    uploaded.last_claimed_at_ms = nowMs + 5_000;
    const synced = await manager.getEnrollment(relayEnr.id, { syncRelay: true });
    expect(synced?.status).toBe("claimed");
    expect(synced?.lastClaimedIp).toBe("203.0.113.55");
    expect(synced?.lastClaimedAt).toBe(new Date(nowMs + 5_000).toISOString());

    // Revoke relay enrollment -> DELETE called & status becomes revoked
    const revoked = await manager.revokeEnrollment(relayEnr.id);
    expect(revoked.status).toBe("revoked");
    expect(relayCalls.some((c) => c.method === "DELETE" && c.url.endsWith(`/v1/enroll/tickets/${parsedTicket.ticketId}`))).toBe(true);

    // 2. Direct mode with explicit deviceId & maxUses=1 -> auth_mode = "direct"
    const directEnr = await manager.createEnrollment(
      {
        platform: "macos",
        profile: "desktop",
        deviceId: "mac-studio-01",
        transportMode: "direct",
        masterPublicUrl: "http://192.168.6.95:3082",
        ttlSec: 600,
        maxUses: 1,
      },
    );
    expect(directEnr.authMode).toBe("direct");
    expect(directEnr.commands?.macos).toContain("http://192.168.6.95:3082/install.sh");
    expect(directEnr.commands?.macos).toContain(`--claim-url "http://192.168.6.95:3082/enroll/claim/${directEnr.ticketId}"`);
    expect(directEnr.commands?.windows).toContain(`-ClaimUrl "http://192.168.6.95:3082/enroll/claim/${directEnr.ticketId}"`);

    const directParsed = parseEnrollTicket(directEnr.enrollCode!);
    const claim1 = manager.claimDirectEnrollment(directParsed.ticketId, "192.168.6.100");
    expect(claim1.ok).toBe(true);
    if (!claim1.ok) throw new Error("unreachable");
    const directPayload = openEnrollPayload<EnrollPayload>(
      claim1.ciphertext_b64,
      directParsed.ticketId,
      directParsed.ephemeralKey,
    );
    expect(directPayload.auth_mode).toBe("direct");
    expect(directPayload.device_id).toBe("mac-studio-01");
    const permClaims = verifyRelayToken(directPayload.relay_token, {
      rootSecret: "relay-root-enr",
      expectedClusterId: "cluster-enr",
      nowSec: Math.floor(nowMs / 1000) + 10,
    });
    expect(permClaims.node_id).toBe("mac-studio-01");
    expect(permClaims.exp - permClaims.iat).toBe(365 * 86_400);

    // Second claim on single-use direct parcel -> 410 Gone
    const claim2 = manager.claimDirectEnrollment(directParsed.ticketId, "192.168.6.100");
    expect(claim2.ok).toBe(false);
    if (claim2.ok) throw new Error("unreachable");
    expect(claim2.status).toBe(410);

    // Auto-expiry transition when clock advances past ttlSec
    const expiring = await manager.createEnrollment({
      transportMode: "direct",
      ttlSec: 60,
      maxUses: 1,
    });
    nowMs += 61_000;
    const afterExpiry = await manager.getEnrollment(expiring.id);
    expect(afterExpiry?.status).toBe("expired");
    const expiredClaim = manager.claimDirectEnrollment(expiring.ticketId, "192.168.6.101");
    expect(expiredClaim.ok).toBe(false);
    if (!expiredClaim.ok) {
      expect(expiredClaim.status).toBe(410);
    }

    // Per-IP rate limit (20 req/min/IP) -> 21st returns 429
    for (let i = 0; i < 20; i++) {
      const r = manager.claimDirectEnrollment("nonexistent1", "10.0.0.99");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(404);
    }
    const rateLimited = manager.claimDirectEnrollment("nonexistent1", "10.0.0.99");
    expect(rateLimited.ok).toBe(false);
    if (!rateLimited.ok) {
      expect(rateLimited.status).toBe(429);
    }

    await manager.stop();
    store.close();
  });

  test("enroll_register -> enroll_ack E2E exchange assigns unique device_id & permanent token, and manifest enroll_id completes enrollment", async () => {
    const store = Store.memory();
    const { sockets, wsFactory } = makeMockSockets();
    const clusterId = "cluster-ex";
    const e2eKey = "e2e-exchange-secret";
    const relaySecret = "relay-exchange-secret";

    const manager = new DeviceManager({
      store,
      masterId: "ex",
      fetchFn: (async () =>
        new Response(JSON.stringify({ cluster_id: clusterId }), { status: 200 })) as unknown as typeof fetch,
      wsFactory,
      pingIntervalMs: 0,
    });

    await manager.configure(
      {
        clusterId,
        masterNodeId: "master-ex",
        relayUrl: "https://relay.local:18443",
        relaySecret,
        e2eKey,
      },
      { persist: true, connect: true },
    );

    const relaySock = sockets.find((s) => s.url.endsWith("/v1/relay"))!;

    // Batch enrollment (maxUses=2) via direct transport
    const batch = await manager.createEnrollment({
      transportMode: "direct",
      maxUses: 2,
      ttlSec: 600,
    });

    const tempNode = `enr-${batch.ticketId}`;

    // Host 1 sends enroll_register
    const reg1Wire = sealDeviceMessage(
      {
        v: 1,
        kind: "enroll_register",
        req_id: "reg-1",
        cluster_id: clusterId,
        device_id: tempNode,
        ts_ms: Date.now(),
        body: {
          enroll_id: batch.id,
          hostname: "Pi4_Lab.Local!",
          os: "linux",
          arch: "aarch64",
          install_mode: "system",
          fingerprint: "fp-host-1",
        },
      },
      e2eKey,
      tempNode,
      "master-ex",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: tempNode, dst: "master-ex", payload: reg1Wire });
    expect(relaySock.sent.length).toBe(1);

    const ack1Frame = decodeRelayFrame(relaySock.sent[0] as Uint8Array);
    expect(ack1Frame.dst).toBe(tempNode);
    const ack1Msg = openDeviceMessage(ack1Frame.payload, e2eKey, clusterId, "master-ex", tempNode);
    expect(ack1Msg.kind).toBe("enroll_ack");
    expect(ack1Msg.req_id).toBe("reg-1");
    expect(ack1Msg.body.ok).toBe(true);
    expect(ack1Msg.body.enroll_id).toBe(batch.id);
    expect(ack1Msg.body.device_id).toBe("os-pi4-lab-local");
    expect(ack1Msg.body.cluster_id).toBe(clusterId);
    const tok1 = verifyRelayToken(ack1Msg.body.relay_token as string, {
      rootSecret: relaySecret,
      expectedClusterId: clusterId,
    });
    expect(tok1.node_id).toBe("os-pi4-lab-local");
    expect(tok1.tier).toBe("os");
    expect(tok1.exp - tok1.iat).toBe(365 * 86_400);

    // Idempotent retry from same fingerprint gets identical device_id without consuming extra use
    const reg1RetryWire = sealDeviceMessage(
      {
        v: 1,
        kind: "enroll_register",
        req_id: "reg-1-retry",
        cluster_id: clusterId,
        device_id: tempNode,
        ts_ms: Date.now(),
        body: {
          enroll_id: batch.id,
          hostname: "Pi4_Lab.Local!",
          fingerprint: "fp-host-1",
        },
      },
      e2eKey,
      tempNode,
      "master-ex",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: tempNode, dst: "master-ex", payload: reg1RetryWire });
    const ack1Retry = openDeviceMessage(
      decodeRelayFrame(relaySock.sent[1] as Uint8Array).payload,
      e2eKey,
      clusterId,
      "master-ex",
      tempNode,
    );
    expect(ack1Retry.body.device_id).toBe("os-pi4-lab-local");
    expect((await manager.getEnrollment(batch.id))?.usedCount).toBe(1);

    // Host 2 with SAME hostname but DIFFERENT fingerprint gets deduplicated suffix -2
    const reg2Wire = sealDeviceMessage(
      {
        v: 1,
        kind: "enroll_register",
        req_id: "reg-2",
        cluster_id: clusterId,
        device_id: tempNode,
        ts_ms: Date.now(),
        body: {
          enroll_id: batch.id,
          hostname: "Pi4_Lab.Local!",
          fingerprint: "fp-host-2",
        },
      },
      e2eKey,
      tempNode,
      "master-ex",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: tempNode, dst: "master-ex", payload: reg2Wire });
    const ack2 = openDeviceMessage(
      decodeRelayFrame(relaySock.sent[2] as Uint8Array).payload,
      e2eKey,
      clusterId,
      "master-ex",
      tempNode,
    );
    expect(ack2.body.ok).toBe(true);
    expect(ack2.body.device_id).toBe("os-pi4-lab-local-2");
    const batchAfter2 = await manager.getEnrollment(batch.id);
    expect(batchAfter2?.status).toBe("completed");
    expect(batchAfter2?.usedCount).toBe(2);
    expect(batchAfter2?.enrolledDeviceIds).toEqual(["os-pi4-lab-local", "os-pi4-lab-local-2"]);

    // Host 3 exceeding maxUses receives ok: false
    const reg3Wire = sealDeviceMessage(
      {
        v: 1,
        kind: "enroll_register",
        req_id: "reg-3",
        cluster_id: clusterId,
        device_id: tempNode,
        ts_ms: Date.now(),
        body: {
          enroll_id: batch.id,
          hostname: "Pi4_Lab.Local!",
          fingerprint: "fp-host-3",
        },
      },
      e2eKey,
      tempNode,
      "master-ex",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: tempNode, dst: "master-ex", payload: reg3Wire });
    const ack3 = openDeviceMessage(
      decodeRelayFrame(relaySock.sent[3] as Uint8Array).payload,
      e2eKey,
      clusterId,
      "master-ex",
      tempNode,
    );
    expect(ack3.body.ok).toBe(false);

    // Direct-mode enrollment completed when manifest arrives carrying body.enroll_id
    const directSingle = await manager.createEnrollment({
      transportMode: "direct",
      deviceId: "gpu-box-01",
      maxUses: 1,
    });
    expect(directSingle.status).toBe("pending");
    const manifestWire = sealDeviceMessage(
      {
        v: 1,
        kind: "manifest",
        req_id: "m-enr-1",
        cluster_id: clusterId,
        device_id: "gpu-box-01",
        ts_ms: Date.now(),
        body: {
          device_id: "gpu-box-01",
          tier: "os",
          os: "linux",
          arch: "x86_64",
          capabilities: ["exec", "fs", "relay"],
          enroll_id: directSingle.id,
        },
      },
      e2eKey,
      "gpu-box-01",
      "master-ex",
    );
    manager.handleRelayFrame({ flags: FLAG_DATA, src: "gpu-box-01", dst: "master-ex", payload: manifestWire });

    const doneSingle = await manager.getEnrollment(directSingle.id);
    expect(doneSingle?.status).toBe("completed");
    expect(doneSingle?.enrolledDeviceIds).toEqual(["gpu-box-01"]);
    expect(manager.getDevice("gpu-box-01")?.status).toBe("online");

    await manager.stop();
    store.close();
  });

  test("installMcuViaTier1 deploys over Tier 1 fs_write RPC when online and falls back gracefully when offline, plus device_mcu_install tool", async () => {
    const store = Store.memory();
    const clusterId = "cluster-mcu";
    const e2eKey = "mcu-cluster-e2e-secret";
    const writtenFiles: Array<{ path: string; content: string }> = [];

    let managerRef: DeviceManager | null = null;
    const { wsFactory } = makeMockSockets((sock, raw) => {
      if (!sock.url.endsWith("/v1/relay") || !(raw instanceof Uint8Array)) return;
      const frame = decodeRelayFrame(raw);
      const msg = openDeviceMessage(frame.payload, e2eKey, clusterId, "master-mcu", frame.dst);
      if (msg.kind === "rpc_req" && msg.body.method === "fs_write") {
        const params = msg.body.params as { path: string; content: string };
        writtenFiles.push({ path: params.path, content: params.content });
        const respWire = sealDeviceMessage(
          {
            v: 1,
            kind: "rpc_resp",
            req_id: msg.req_id,
            cluster_id: clusterId,
            device_id: frame.dst,
            ts_ms: Date.now(),
            body: { ok: true, result: { path: params.path, bytes_written: params.content.length } },
          },
          e2eKey,
          frame.dst,
          "master-mcu",
        );
        queueMicrotask(() => {
          managerRef?.handleRelayFrame({ flags: FLAG_DATA, src: frame.dst, dst: "master-mcu", payload: respWire });
        });
      }
    });

    const manager = new DeviceManager({
      store,
      masterId: "mcu",
      fetchFn: (async () =>
        new Response(JSON.stringify({ cluster_id: clusterId }), { status: 200 })) as unknown as typeof fetch,
      wsFactory,
      pingIntervalMs: 0,
    });
    managerRef = manager;

    await manager.configure(
      {
        clusterId,
        masterNodeId: "master-mcu",
        relayUrl: "https://relay.local:18443",
        relaySecret: "mcu-relay-secret",
        e2eKey,
      },
      { persist: true, connect: true },
    );

    manager.upsertDeviceManifest(
      {
        device_id: "os-gw-1",
        tier: "os",
        capabilities: ["exec", "fs", "relay"],
        relay_config: { enabled: true, mqtt_bind: "192.168.1.50:1883", uart_device: "/dev/ttyUSB0" },
      },
      { status: "online" },
    );
    manager.upsertDeviceManifest(
      { device_id: "os-gw-offline", tier: "os", capabilities: ["relay"] },
      { status: "offline" },
    );

    // 1. Online Tier 1 MQTT auto-deploy via encrypted fs_write RPC
    const onlineRes = await manager.installMcuViaTier1({
      mcuId: "mcu-esp32-rack01",
      relayDeviceId: "os-gw-1",
      transport: "mqtt",
      chip: "esp32s3",
      backupRelayDeviceIds: ["os-gw-offline"],
      autoDeploy: true,
    });
    const expectedKeyHex = Buffer.from(deriveMcuE2eKey(clusterId, e2eKey)).toString("hex");
    expect(onlineRes.deployed).toBe(true);
    expect(onlineRes.deployMethod).toBe("tier1_rpc");
    expect(onlineRes.workspaceDir).toBe("neo-mcu/mcu-esp32-rack01");
    expect(onlineRes.mcuE2eKeyHex).toBe(expectedKeyHex);
    expect(onlineRes.configHeader).toContain(`#define NEO_MCU_CLUSTER_ID "${clusterId}"`);
    expect(onlineRes.configHeader).toContain('#define NEO_MCU_DEVICE_ID "mcu-esp32-rack01"');
    expect(onlineRes.configHeader).toContain("#define NEO_MCU_TRANSPORT_MQTT 1");
    expect(onlineRes.configHeader).toContain('#define NEO_MCU_MQTT_BROKER "192.168.1.50:1883"');
    expect(onlineRes.configHeader).toContain(`#define NEO_MCU_MQTT_TOPIC_DOWN "neo/${clusterId}/mcu/mcu-esp32-rack01/down"`);
    expect(onlineRes.configHeader).toContain(`#define NEO_MCU_MQTT_TOPIC_UP "neo/${clusterId}/mcu/mcu-esp32-rack01/up"`);
    expect(onlineRes.configHeader).toContain("NEO_MCU_E2E_KEY_BYTES");
    expect(onlineRes.installScript).toContain("NEO_MCU_DEVICE_ID='mcu-esp32-rack01'");
    expect(onlineRes.twin.tier).toBe("mcu");
    expect(onlineRes.twin.route).toBe("via_tier1");
    expect(onlineRes.twin.relayNodeId).toBe("os-gw-1");
    expect(onlineRes.twin.backupRelayNodeIds).toEqual(["os-gw-offline"]);
    expect(onlineRes.twin.status).toBe("sleeping");
    expect(onlineRes.twin.reportedState.transport).toBe("mqtt");
    expect(onlineRes.twin.reportedState.mqttBroker).toBe("192.168.1.50:1883");

    expect(writtenFiles.map((f) => f.path)).toEqual([
      "neo-mcu/mcu-esp32-rack01/neo_mcu_config.h",
      "neo-mcu/mcu-esp32-rack01/mcu-provision.json",
      "neo-mcu/mcu-esp32-rack01/install-mcu.sh",
    ]);

    // 2. Offline Tier 1 Serial fallback -> staged_manual without crashing
    const offlineRes = await manager.installMcuViaTier1({
      mcuId: "mcu-stm32-02",
      relayDeviceId: "os-gw-offline",
      transport: "serial",
      serialPort: "/dev/ttyACM0",
      baudRate: 921600,
      chip: "stm32",
    });
    expect(offlineRes.deployed).toBe(false);
    expect(offlineRes.deployMethod).toBe("staged_manual");
    expect(offlineRes.deployDetail).toContain("offline");
    expect(offlineRes.configHeader).toContain("#define NEO_MCU_TRANSPORT_SERIAL 1");
    expect(offlineRes.configHeader).toContain('#define NEO_MCU_SERIAL_PORT "/dev/ttyACM0"');
    expect(offlineRes.configHeader).toContain("#define NEO_MCU_SERIAL_BAUD 921600U");
    expect(manager.getDevice("mcu-stm32-02")?.relayNodeId).toBe("os-gw-offline");

    await manager.stop();
    store.close();

    // 3. Verify device_mcu_install tool schema in mainSpecs() & workerSpecs() and execution on App
    const mainToolSpec = mainSpecs().find((s) => s.name === "device_mcu_install");
    const workerToolSpec = workerSpecs().find((s) => s.name === "device_mcu_install");
    expect(mainToolSpec).toBeDefined();
    expect(workerToolSpec).toBeDefined();
    expect(mainToolSpec!.schema.required).toEqual(["mcu_id", "relay_device_id", "transport"]);

    const dir = new TempDir("neo-mcu-tool");
    try {
      const scripted = new Scripted();
      scripted.model = async () => "ok";
      const app = App.open(
        { stateDir: dir.path, wechat: new Protocol() },
        new ScriptedKernels(scripted),
        defaultTimings(),
      );
      await app.devices.initOrUpdateConfig(
        { clusterId: "tool-mcu", relayUrl: "", clusterSecret: "tool-sec", e2eKey: "tool-e2e" },
        { connect: false },
      );
      app.devices.upsertDeviceManifest({ device_id: "os-tool", tier: "os", capabilities: ["relay"] }, { status: "offline" });

      const toolOut = (await app.mainTool("device_mcu_install", {
        mcu_id: "mcu-tool-01",
        relay_device_id: "os-tool",
        transport: "mqtt",
        mqtt_broker: "10.0.0.5:1883",
        chip: "esp32",
      })) as { deployed: boolean; deployMethod: string; twin: { deviceId: string } };
      expect(toolOut.deployed).toBe(false);
      expect(toolOut.deployMethod).toBe("staged_manual");
      expect(toolOut.twin.deviceId).toBe("mcu-tool-01");

      await app.stop();
      app.close();
    } finally {
      dir.cleanup();
    }
  });

  test("HTTP API integration for config, enrollments, ping, remove, MCU install, and public Master Direct Mode routes", async () => {
    const dir = new TempDir("neo-enroll-http");
    try {
      const scripted = new Scripted();
      scripted.model = async () => "ok";
      const app = App.open(
        { stateDir: dir.path, wechat: new Protocol() },
        new ScriptedKernels(scripted),
        defaultTimings(),
      );

      const access = { token: "admin-secret-token" };
      const authHeader = { authorization: "Bearer admin-secret-token" };
      const localPeer = { host: "127.0.0.1", port: 51000 };
      const remotePeer = { host: "192.168.6.200", port: 51001 };

      // Authenticated routes reject unauthenticated remote peer
      const unauthRes = await handle(app, access, makeRequest("GET", "/api/devices"), remotePeer);
      expect(unauthRes.status).toBe(401);

      // GET /api/devices/config before init
      const cfgBeforeRes = await handle(app, access, makeRequest("GET", "/api/devices/config", undefined, authHeader), localPeer);
      expect(cfgBeforeRes.status).toBe(200);
      const cfgBefore = decodeJsonBody<{ config: { configured: boolean; defaultRelayUrl: string } }>(cfgBeforeRes.body);
      expect(cfgBefore.config.configured).toBe(false);
      expect(cfgBefore.config.defaultRelayUrl).toBe(DEFAULT_RELAY_URL);

      // POST /api/devices/config/init (direct mode: relayUrl="")
      const initRes = await handle(
        app,
        access,
        makeRequest(
          "POST",
          "/api/devices/config/init",
          {
            clusterId: "http-enr-cluster",
            relayUrl: "",
            clusterSecret: "http-cluster-secret",
            autoDetectLocalRelay: false,
          },
          authHeader,
        ),
        localPeer,
      );
      expect(initRes.status).toBe(200);
      const initJson = decodeJsonBody<{ config: { clusterId: string; configured: boolean; canMintTokens: boolean } }>(initRes.body);
      expect(initJson.config.clusterId).toBe("http-enr-cluster");
      expect(initJson.config.configured).toBe(true);
      expect(initJson.config.canMintTokens).toBe(true);

      // PUT /api/devices/config updates masterNodeId
      const putRes = await handle(
        app,
        access,
        makeRequest("PUT", "/api/devices/config", { masterNodeId: "master-custom", relayUrl: "" }, authHeader),
        localPeer,
      );
      expect(putRes.status).toBe(200);
      expect(decodeJsonBody<{ config: { masterNodeId: string } }>(putRes.body).config.masterNodeId).toBe("master-custom");

      // POST /api/devices/enrollments (Master Direct Mode)
      const createEnrRes = await handle(
        app,
        access,
        makeRequest(
          "POST",
          "/api/devices/enrollments",
          {
            platform: "linux",
            profile: "personal",
            installMode: "user",
            transportMode: "direct",
            ttlSec: 600,
            maxUses: 1,
          },
          authHeader,
        ),
        localPeer,
      );
      expect(createEnrRes.status).toBe(200);
      const created = decodeJsonBody<{ enrollment: { id: string; ticketId: string; enrollCode: string; commands: { linuxUser: string } } }>(
        createEnrRes.body,
      ).enrollment;
      expect(created.commands.linuxUser).toContain("http://192.168.6.95:3082/install.sh");
      expect(created.commands.linuxUser).toContain(`--claim-url "http://192.168.6.95:3082/enroll/claim/${created.ticketId}"`);

      // GET /api/devices includes config, devices, approvals, enrollments
      const overviewRes = await handle(app, access, makeRequest("GET", "/api/devices", undefined, authHeader), localPeer);
      expect(overviewRes.status).toBe(200);
      const overview = decodeJsonBody<{ config: unknown; devices: unknown[]; approvals: unknown[]; enrollments: Array<{ id: string }> }>(
        overviewRes.body,
      );
      expect(overview.enrollments.some((e) => e.id === created.id)).toBe(true);
      expect(Array.isArray(overview.approvals)).toBe(true);

      // GET /api/devices/enrollments & /api/devices/enrollments/:id
      const listEnrRes = await handle(app, access, makeRequest("GET", "/api/devices/enrollments", undefined, authHeader), localPeer);
      expect(listEnrRes.status).toBe(200);
      const getEnrRes = await handle(
        app,
        access,
        makeRequest("GET", `/api/devices/enrollments/${created.id}`, undefined, authHeader),
        localPeer,
      );
      expect(getEnrRes.status).toBe(200);
      expect(decodeJsonBody<{ enrollment: { id: string }; devices: unknown[] }>(getEnrRes.body).enrollment.id).toBe(created.id);

      // Public Master Direct Mode routes WITHOUT access token from remotePeer!
      const shRes = await handle(app, access, makeRequest("GET", "/install.sh"), remotePeer);
      expect(shRes.status).toBe(200);
      const shBody = new TextDecoder().decode(shRes.body);
      expect(shBody).toContain("DEFAULT_MASTER_ORIGIN='http://192.168.6.95:3082'");
      expect(shBody).toContain("--claim-url");
      expect(shBody).toContain("--ticket-stdin");

      const ps1Res = await handle(app, access, makeRequest("GET", "/install.ps1"), remotePeer);
      expect(ps1Res.status).toBe(200);
      const ps1Body = new TextDecoder().decode(ps1Res.body);
      expect(ps1Body).toContain("Install-NeoAgent");
      expect(ps1Body).toContain("http://192.168.6.95:3082");

      // Public POST /enroll/claim/:id -> 200 first time, 410 second time
      const claimRes1 = await handle(app, access, makeRequest("POST", `/enroll/claim/${created.ticketId}`), remotePeer);
      expect(claimRes1.status).toBe(200);
      const claimJson = decodeJsonBody<{ ticket_id: string; ciphertext_b64: string; expires_at_ms: number }>(claimRes1.body);
      expect(claimJson.ticket_id).toBe(created.ticketId);
      const parsedCode = parseEnrollTicket(created.enrollCode);
      const opened = openEnrollPayload<EnrollPayload>(
        claimJson.ciphertext_b64,
        parsedCode.ticketId,
        parsedCode.ephemeralKey,
      );
      expect(opened.cluster_id).toBe("http-enr-cluster");

      const claimRes2 = await handle(app, access, makeRequest("POST", `/enroll/claim/${created.ticketId}`), remotePeer);
      expect(claimRes2.status).toBe(410);

      // DELETE /api/devices/enrollments/:id
      const delEnrRes = await handle(
        app,
        access,
        makeRequest("DELETE", `/api/devices/enrollments/${created.id}`, undefined, authHeader),
        localPeer,
      );
      expect(delEnrRes.status).toBe(200);
      expect(decodeJsonBody<{ enrollment: { status: string } }>(delEnrRes.body).enrollment.status).toBe("revoked");

      // POST /api/devices/mcu/install
      app.devices.upsertDeviceManifest({ device_id: "os-http-gw", tier: "os", capabilities: ["relay"] }, { status: "offline" });
      const mcuRes = await handle(
        app,
        access,
        makeRequest(
          "POST",
          "/api/devices/mcu/install",
          { mcuId: "mcu-http-01", relayDeviceId: "os-http-gw", transport: "mqtt", chip: "esp32" },
          authHeader,
        ),
        localPeer,
      );
      expect(mcuRes.status).toBe(200);
      const mcuJson = decodeJsonBody<{ deployed: boolean; deployMethod: string; twin: { deviceId: string } }>(mcuRes.body);
      expect(mcuJson.deployed).toBe(false);
      expect(mcuJson.deployMethod).toBe("staged_manual");
      expect(mcuJson.twin.deviceId).toBe("mcu-http-01");

      // POST /api/devices/:id/ping
      const pingRes = await handle(
        app,
        access,
        makeRequest("POST", "/api/devices/os-http-gw/ping", {}, authHeader),
        localPeer,
      );
      expect(pingRes.status).toBe(200);
      const pingJson = decodeJsonBody<{ ok: boolean; deviceId: string; status: string }>(pingRes.body);
      expect(pingJson.ok).toBe(false);
      expect(pingJson.deviceId).toBe("os-http-gw");
      expect(pingJson.status).toBe("offline");

      const pingMissing = await handle(
        app,
        access,
        makeRequest("POST", "/api/devices/no-such-device/ping", {}, authHeader),
        localPeer,
      );
      expect(pingMissing.status).toBe(404);

      // DELETE /api/devices/:id
      const delDevRes = await handle(
        app,
        access,
        makeRequest("DELETE", "/api/devices/mcu-http-01", undefined, authHeader),
        localPeer,
      );
      expect(delDevRes.status).toBe(200);
      expect(decodeJsonBody<{ removed: boolean; deviceId: string }>(delDevRes.body)).toEqual({
        removed: true,
        deviceId: "mcu-http-01",
      });

      const delDevAgain = await handle(
        app,
        access,
        makeRequest("DELETE", "/api/devices/mcu-http-01", undefined, authHeader),
        localPeer,
      );
      expect(delDevAgain.status).toBe(404);

      await app.stop();
      app.close();
    } finally {
      dir.cleanup();
    }
  });

  test("NEO_LOCAL_RELAY_ENV detection, live pingDevice RPC roundtrip, and removeDevice Tier 1 cascade", async () => {
    const dir = new TempDir("neo-env-ping");
    const store = Store.memory();
    const prevEnv = process.env.NEO_LOCAL_RELAY_ENV;
    const envFile = path.join(dir.path, "custom-relay.env");
    fs.writeFileSync(envFile, "NEO_RELAY_SECRET='env-var-secret-value'\n", "utf8");
    process.env.NEO_LOCAL_RELAY_ENV = envFile;

    let managerRef: DeviceManager | null = null;
    const clusterId = "cluster-ping";
    const e2eKey = "ping-e2e-secret";
    const { wsFactory } = makeMockSockets((sock, raw) => {
      if (!sock.url.endsWith("/v1/relay") || !(raw instanceof Uint8Array)) return;
      const frame = decodeRelayFrame(raw);
      const msg = openDeviceMessage(frame.payload, e2eKey, clusterId, "master-ping", frame.dst);
      if (msg.kind === "rpc_req" && msg.body.method === "fs_list") {
        const respWire = sealDeviceMessage(
          {
            v: 1,
            kind: "rpc_resp",
            req_id: msg.req_id,
            cluster_id: clusterId,
            device_id: frame.dst,
            ts_ms: Date.now(),
            body: { ok: true, result: { path: "/work", entries: [] } },
          },
          e2eKey,
          frame.dst,
          "master-ping",
        );
        queueMicrotask(() => {
          managerRef?.handleRelayFrame({ flags: FLAG_DATA, src: frame.dst, dst: "master-ping", payload: respWire });
        });
      }
    });

    const manager = new DeviceManager({
      store,
      masterId: "ping",
      fetchFn: (async () =>
        new Response(JSON.stringify({ cluster_id: clusterId }), { status: 200 })) as unknown as typeof fetch,
      wsFactory,
      pingIntervalMs: 0,
    });
    managerRef = manager;

    try {
      expect(manager.configView().localRelayDetected).toBe(true);
      const cfg = await manager.initOrUpdateConfig({
        clusterId,
        masterNodeId: "master-ping",
        e2eKey,
      });
      expect(cfg.hasRelaySecret).toBe(true);
      expect(cfg.relayState).toBe("connected");

      manager.upsertDeviceManifest({ device_id: "os-live-1", tier: "os", capabilities: ["fs", "relay"] }, { status: "online" });
      manager.upsertDeviceManifest({ device_id: "os-live-backup", tier: "os", capabilities: ["fs", "relay"] }, { status: "online" });
      manager.upsertDeviceManifest(
        { device_id: "mcu-child-1", tier: "mcu", acts: ["read_dht22"] },
        { status: "online", route: "via_tier1", relayNodeId: "os-live-1", backupRelayNodeIds: ["os-live-backup"] },
      );

      // Live Tier 1 ping roundtrip succeeds
      const pingOs = await manager.pingDevice("os-live-1");
      expect(pingOs.ok).toBe(true);
      expect(pingOs.status).toBe("online");
      expect(pingOs.route).toBe("relay");
      expect(pingOs.latencyMs).toBeGreaterThanOrEqual(0);

      // Live Tier 2 MCU ping checks parent Tier 1 relay
      const pingMcu = await manager.pingDevice("mcu-child-1");
      expect(pingMcu.ok).toBe(true);
      expect(pingMcu.route).toBe("via_tier1");

      // Removing primary Tier 1 fails over child MCU to backup
      expect(manager.removeDevice("os-live-1")).toBe(true);
      expect(manager.getDevice("os-live-1")).toBeNull();
      expect(manager.getDevice("mcu-child-1")?.relayNodeId).toBe("os-live-backup");
      expect(manager.getDevice("mcu-child-1")?.status).toBe("online");

      // Removing backup leaves child MCU unreachable_via_relay with alertSuppressed
      expect(manager.removeDevice("os-live-backup")).toBe(true);
      expect(manager.getDevice("mcu-child-1")?.status).toBe("unreachable_via_relay");
      expect(manager.getDevice("mcu-child-1")?.alertSuppressed).toBe(true);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.NEO_LOCAL_RELAY_ENV;
      } else {
        process.env.NEO_LOCAL_RELAY_ENV = prevEnv;
      }
      await manager.stop();
      store.close();
      dir.cleanup();
    }
  });
});
