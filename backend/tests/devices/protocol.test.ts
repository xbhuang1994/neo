import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  FLAG_DATA,
  FLAG_ERR_OFFLINE,
  FLAG_ERR_RATE,
  FLAG_ERR_SPOOFED,
  FLAG_PING,
  FLAG_PONG,
  computeMcuMac,
  computeMcuMacHex,
  decodeCbor,
  decodeRelayFrame,
  deriveClusterTokenKey,
  deriveE2eKey,
  deriveMcuE2eKey,
  encodeCbor,
  encodeRelayFrame,
  mintRelayToken,
  openDeviceMessage,
  openRelayEnvelope,
  sealDeviceMessage,
  sealRelayEnvelope,
  validateS3ClusterArtifactUri,
  verifyMcuMac,
  verifyRelayToken,
  type DeviceMessage,
} from "../../src/devices/index.ts";

describe("devices/protocol", () => {
  test("mints and verifies neo1 tokens with rootSecret derivation and independent clusterSecret", () => {
    const clusterId = "cluster-alpha";
    const nodeId = "master-1";
    const rootSecret = "root-super-secret";
    const nowSec = 1_760_000_000;

    const derived = deriveClusterTokenKey({ clusterId, rootSecret });
    const expectedDerived = createHmac("sha256", Buffer.from(rootSecret, "utf8"))
      .update(`cluster:${clusterId}`, "utf8")
      .digest();
    expect(Buffer.from(derived)).toEqual(expectedDerived);

    const token = mintRelayToken({
      clusterId,
      nodeId,
      tier: "master",
      rootSecret,
      ttlSec: 300,
      nowSec,
    });
    expect(token.startsWith("neo1.")).toBe(true);
    const parts = token.split(".");
    expect(parts.length).toBe(3);
    expect(token.includes("=")).toBe(false);

    const claimsJson = Buffer.from(parts[1]!, "base64url").toString("utf8");
    expect(claimsJson).toBe(
      `{"cluster_id":"cluster-alpha","node_id":"master-1","tier":"master","iat":${nowSec},"exp":${nowSec + 300}}`,
    );

    const verified = verifyRelayToken(token, {
      rootSecret,
      expectedClusterId: clusterId,
      nowSec: nowSec + 100,
    });
    expect(verified).toEqual({
      cluster_id: clusterId,
      node_id: nodeId,
      tier: "master",
      iat: nowSec,
      exp: nowSec + 300,
    });

    // Reject expired, tampered, wrong root secret, and cross-cluster
    expect(() =>
      verifyRelayToken(token, { rootSecret, nowSec: nowSec + 301 }),
    ).toThrow("expired");
    expect(() =>
      verifyRelayToken(token, { rootSecret: "wrong-root", nowSec: nowSec + 10 }),
    ).toThrow("signature");
    expect(() =>
      verifyRelayToken(token, {
        rootSecret,
        expectedClusterId: "cluster-beta",
        nowSec: nowSec + 10,
      }),
    ).toThrow("Cluster mismatch");

    // Independent clusterSecret mode (raw UTF-8 key)
    const clusterSecret = "independent-cluster-secret";
    const indepToken = mintRelayToken({
      clusterId,
      nodeId: "os-01",
      tier: "os",
      clusterSecret,
      ttlSec: 60,
      nowSec,
    });
    const indepClaims = verifyRelayToken(indepToken, {
      clusterSecret,
      nowSec: nowSec + 30,
    });
    expect(indepClaims.tier).toBe("os");
    expect(() =>
      verifyRelayToken(indepToken, { rootSecret, nowSec: nowSec + 30 }),
    ).toThrow("signature");
  });

  test("encodes and decodes 10-byte neo-relay binary frames byte-for-byte", () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const wire = encodeRelayFrame({
      flags: FLAG_DATA,
      src: "master-1",
      dst: "os-rack01",
      payload,
    });

    // Exact 10-byte header layout
    expect(wire[0]).toBe(0x4e); // 'N'
    expect(wire[1]).toBe(0x52); // 'R'
    expect(wire[2]).toBe(0x01); // version
    expect(wire[3]).toBe(FLAG_DATA);
    expect(wire[4]).toBe(8); // "master-1"
    expect(wire[5]).toBe(9); // "os-rack01"
    expect(new DataView(wire.buffer).getUint32(6, false)).toBe(4);
    expect(wire.byteLength).toBe(10 + 8 + 9 + 4);

    const decoded = decodeRelayFrame(wire);
    expect(decoded.flags).toBe(FLAG_DATA);
    expect(decoded.src).toBe("master-1");
    expect(decoded.dst).toBe("os-rack01");
    expect(decoded.payload).toEqual(payload);

    for (const flag of [FLAG_PING, FLAG_PONG, FLAG_ERR_OFFLINE, FLAG_ERR_SPOOFED, FLAG_ERR_RATE]) {
      const f = decodeRelayFrame(encodeRelayFrame({ flags: flag, src: "a", dst: "b", payload: new Uint8Array(0) }));
      expect(f.flags).toBe(flag);
    }

    expect(() => decodeRelayFrame(new Uint8Array(9))).toThrow("too short");
    const badMagic = wire.slice();
    badMagic[0] = 0x00;
    expect(() => decodeRelayFrame(badMagic)).toThrow("magic");
    const truncated = wire.slice(0, wire.byteLength - 1);
    expect(() => decodeRelayFrame(truncated)).toThrow("mismatch");
  });

  test("seals and opens inner E2E AES-256-GCM DeviceMessage with exact key, nonce, and AAD", () => {
    const clusterId = "cluster-a";
    const e2eSecret = "e2e-shared-secret";
    const srcId = "master-1";
    const dstId = "os-node-1";
    const fixedNonce = new Uint8Array(12).fill(0x2a);

    const expectedKey = createHash("sha256")
      .update(`neo-e2e-v1:${clusterId}:${e2eSecret}`, "utf8")
      .digest();
    expect(Buffer.from(deriveE2eKey(clusterId, e2eSecret))).toEqual(expectedKey);

    const msg: DeviceMessage = {
      v: 1,
      kind: "rpc_req",
      req_id: "req-123",
      cluster_id: clusterId,
      device_id: srcId,
      ts_ms: 1760000000123,
      body: { method: "exec", params: { program: "echo", args: ["ok"] } },
    };

    const wire = sealDeviceMessage(msg, e2eSecret, srcId, dstId, fixedNonce);
    expect(wire[0]).toBe(0xe1);
    expect(wire.subarray(1, 13)).toEqual(fixedNonce);

    const opened = openDeviceMessage(wire, e2eSecret, clusterId, srcId, dstId);
    expect(opened).toEqual(msg);

    // Wrong AAD (swapped src/dst or wrong cluster) must fail AEAD auth tag
    expect(() => openDeviceMessage(wire, e2eSecret, clusterId, dstId, srcId)).toThrow();
    expect(() => openDeviceMessage(wire, e2eSecret, "cluster-b", srcId, dstId)).toThrow();
    expect(() => openDeviceMessage(wire, "wrong-secret", clusterId, srcId, dstId)).toThrow();

    // Tampered ciphertext byte must fail
    const tampered = wire.slice();
    tampered[20] ^= 0xff;
    expect(() => openDeviceMessage(tampered, e2eSecret, clusterId, srcId, dstId)).toThrow();
  });

  test("encodes and decodes RFC 8949 CBOR subset matching Tier 2 MCU messages", () => {
    const cmd = { t: "cmd", a: "set_fan_pwm", p: { duty: 85, negative: -42 } };
    const cmdBytes = encodeCbor(cmd);
    expect(decodeCbor(cmdBytes)).toEqual(cmd);

    const hello = {
      t: "hello",
      chip: "esp32s3",
      fw: "1.0.0",
      acts: ["set_fan_pwm", "read_dht22"],
    };
    expect(decodeCbor(encodeCbor(hello))).toEqual(hello);

    const res = {
      t: "res",
      ok: true,
      a: "read_dht22",
      d: { temp_c: 24, rh_pct: 55, raw: new Uint8Array([1, 2, 3]), extra: null },
      e: "",
    };
    expect(decodeCbor(encodeCbor(res))).toEqual(res);

    // Integer boundary encodings
    const ints = [0, 1, 23, 24, 255, 256, 65535, 65536, 4294967295, 4294967296, -1, -24, -25, -1000, -100000];
    expect(decodeCbor(encodeCbor(ints))).toEqual(ints);

    // Trailing bytes rejected
    expect(() => decodeCbor(new Uint8Array([...cmdBytes, 0x00]))).toThrow("trailing");
  });

  test("computes and verifies Tier 2 MCU e2e_mac and RelayEnvelope", () => {
    const clusterId = "cluster-a";
    const relayNodeId = "os-relay-1";
    const targetMcuId = "mcu-esp32-rack01";
    const e2eSecret = "e2e-shared-secret";
    const seqId = 42;

    const payload = { t: "cmd", a: "read_dht22", p: {} };
    const rawCbor = encodeCbor(payload);

    // Verify exact key & input concatenation byte-for-byte
    const expectedMcuKey = createHash("sha256")
      .update(`neo-mcu-e2e-v1:${clusterId}:${e2eSecret}`, "utf8")
      .digest();
    expect(Buffer.from(deriveMcuE2eKey(clusterId, e2eSecret))).toEqual(expectedMcuKey);

    const seqBe = Buffer.alloc(8);
    seqBe.writeBigUInt64BE(BigInt(seqId), 0);
    const expectedMac = createHmac("sha256", expectedMcuKey)
      .update(
        Buffer.concat([
          Buffer.from(clusterId, "utf8"),
          Buffer.from([0x00]),
          Buffer.from(targetMcuId, "utf8"),
          Buffer.from([0x00]),
          seqBe,
          Buffer.from(rawCbor),
        ]),
      )
      .digest();

    const actualMac = computeMcuMac({
      clusterId,
      targetMcuId,
      seqId,
      rawCbor,
      e2eMasterSecret: e2eSecret,
    });
    expect(Buffer.from(actualMac)).toEqual(expectedMac);
    expect(
      computeMcuMacHex({
        clusterId,
        targetMcuId,
        seqId,
        rawCbor,
        e2eMasterSecret: e2eSecret,
      }),
    ).toBe(expectedMac.toString("hex"));

    const envelope = sealRelayEnvelope({
      clusterId,
      relayNodeId,
      targetMcuId,
      direction: "downlink",
      seqId,
      payload,
      e2eMasterSecret: e2eSecret,
    });
    expect(envelope.e2e_mac).toBe(expectedMac.toString("hex"));

    const opened = openRelayEnvelope(envelope, e2eSecret, clusterId);
    expect(opened.payload).toEqual(payload);

    // Cross-cluster, wrong seq_id, wrong target_mcu_id, or tampered MAC must fail
    expect(() => openRelayEnvelope(envelope, e2eSecret, "cluster-b")).toThrow("Cross-cluster");
    expect(() =>
      openRelayEnvelope({ ...envelope, seq_id: 43 }, e2eSecret, clusterId),
    ).toThrow("e2e_mac");
    expect(() =>
      openRelayEnvelope({ ...envelope, target_mcu_id: "mcu-other" }, e2eSecret, clusterId),
    ).toThrow("e2e_mac");
    expect(
      verifyMcuMac({
        clusterId,
        targetMcuId,
        seqId,
        rawCbor,
        e2eMasterSecret: "wrong-key",
        givenMac: envelope.e2e_mac,
      }),
    ).toBe(false);
  });

  test("enforces Layer 4 S3 cluster prefix isolation", () => {
    expect(
      validateS3ClusterArtifactUri("s3://neo-artifacts/cluster-a/task-1/out.bin", "cluster-a", "task-1"),
    ).toEqual({
      ok: true,
      bucket: "neo-artifacts",
      clusterId: "cluster-a",
      taskId: "task-1",
      objectKey: "cluster-a/task-1/out.bin",
    });

    expect(
      validateS3ClusterArtifactUri("s3://neo-artifacts/cluster-b/task-1/out.bin", "cluster-a").ok,
    ).toBe(false);
    expect(
      validateS3ClusterArtifactUri("s3://neo-artifacts/cluster-a/../cluster-b/out.bin", "cluster-a").ok,
    ).toBe(false);
    expect(
      validateS3ClusterArtifactUri("s3://other-bucket/cluster-a/task-1/out.bin", "cluster-a").ok,
    ).toBe(false);
    expect(
      validateS3ClusterArtifactUri("https://neo-artifacts/cluster-a/task-1/out.bin", "cluster-a").ok,
    ).toBe(false);
  });
});
