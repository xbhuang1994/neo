/**
 * End-to-End Live Integration & Red-Team Verification for Multi-Device Neo (Proposal 1).
 *
 * Runs against live `https://neo.1inch.cn:18443` using ephemeral clusters `e2e-swarm-a` and `e2e-swarm-b`,
 * compiled Rust `neo-agent-os --relay`, compiled C99 `esp32_rack01_sim`, and Master Neo `DeviceManager`.
 *
 * SECURITY: Never prints, logs, or writes `/nvme/neo-relay/config/relay.env` or minted tokens to disk.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  DeviceManager,
  FLAG_ERR_OFFLINE,
  decodeRelayFrame,
  sealDeviceMessage,
  sealRelayEnvelope,
  type RelayFrame,
  type RelaySocket,
} from "../backend/src/devices/index.ts";
import { Store } from "../backend/src/store/index.ts";

const RELAY_URL = "https://neo.1inch.cn:18443";
const RELAYD_BIN = "/nvme/neo-relay/bin/neo-relayd";
const RELAY_ENV_FILE = "/nvme/neo-relay/config/relay.env";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const AGENT_OS_BIN = path.join(REPO_ROOT, "agents/neo-agent-os/target/release/neo-agent-os");
const MCU_SIM_BIN = path.join(REPO_ROOT, "agents/neo-agent-mcu/build/esp32_rack01_sim");

const CLUSTER_A = "e2e-swarm-a";
const CLUSTER_B = "e2e-swarm-b";
const MASTER_A_ID = "master-e2e-a";
const MASTER_B_ID = "master-e2e-b";
const OS_A_ID = "os-e2e-a";
const MCU_A_ID = "mcu-esp32-rack01";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

function mintTokenInMemory(clusterId: string, nodeId: string, tier: "master" | "os"): string {
  const res = Bun.spawnSync([
    RELAYD_BIN,
    "token",
    "--secret-file",
    RELAY_ENV_FILE,
    "--cluster",
    clusterId,
    "--node",
    nodeId,
    "--tier",
    tier,
    "--ttl",
    "5m",
  ]);
  if (res.exitCode !== 0) {
    const err = res.stderr.toString("utf8").trim();
    throw new Error(`neo-relayd token failed (exit ${res.exitCode}): ${err}`);
  }
  const token = res.stdout.toString("utf8").trim();
  if (!token.startsWith("neo1.")) {
    throw new Error("neo-relayd token did not return a neo1 token");
  }
  return token;
}

async function allocateEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to allocate ephemeral port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 150,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

async function readStreamLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trimEnd();
        buf = buf.slice(idx + 1);
        if (line.length > 0) onLine(line);
      }
    }
    if (buf.trim().length > 0) onLine(buf.trim());
  } catch {
    // Stream closed on process exit
  }
}

async function main(): Promise<void> {
  for (const bin of [RELAYD_BIN, AGENT_OS_BIN, MCU_SIM_BIN]) {
    assert(fs.existsSync(bin), `Required binary missing: ${bin}`);
  }
  assert(fs.existsSync(RELAY_ENV_FILE), `Required secret file missing: ${RELAY_ENV_FILE}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-e2e-proposal1-"));
  const workspaceDir = path.join(tmpDir, "workspace-a");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const canonicalWorkspace = fs.realpathSync(workspaceDir);

  const policyPath = path.join(tmpDir, "agent-policy.toml");
  fs.writeFileSync(
    policyPath,
    [
      `allowed_workspaces = [${JSON.stringify(canonicalWorkspace)}]`,
      `allowed_commands = ["echo", "ls", "cat"]`,
      `denied_commands = ["rm", "sudo", "su", "dd", "mkfs", "shutdown", "reboot", "mount", "iptables"]`,
      `max_child_mem_mb = 512`,
      `max_exec_timeout_sec = 15`,
      `max_output_bytes = 65536`,
      "",
    ].join("\n"),
    "utf8",
  );

  // Ephemeral keys & tokens strictly in memory.
  const e2eKeyA = randomBytes(24).toString("hex");
  const e2eKeyB = randomBytes(24).toString("hex");
  const tokenMasterA = mintTokenInMemory(CLUSTER_A, MASTER_A_ID, "master");
  const tokenOsA = mintTokenInMemory(CLUSTER_A, OS_A_ID, "os");
  const tokenMasterB = mintTokenInMemory(CLUSTER_B, MASTER_B_ID, "master");

  const mqttPort = await allocateEphemeralPort();
  const mqttBind = `127.0.0.1:${mqttPort}`;

  const storeA = Store.memory();
  const storeB = Store.memory();
  const managerA = new DeviceManager({
    store: storeA,
    masterId: MASTER_A_ID,
    pingIntervalMs: 10_000,
  });

  // Wrap Master B's WebSocket factory to observe raw binary frames (including 0x81 ErrOffline).
  const masterBObservedFrames: RelayFrame[] = [];
  const wsFactoryB = (url: string, headers: Record<string, string>): RelaySocket => {
    const ws = new WebSocket(url, { headers });
    ws.binaryType = "arraybuffer";
    const proxy: RelaySocket = {
      get readyState() {
        return ws.readyState;
      },
      get binaryType() {
        return ws.binaryType;
      },
      set binaryType(v: string) {
        ws.binaryType = v as typeof ws.binaryType;
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data) {
        ws.send(data);
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    };
    ws.onopen = (ev) => proxy.onopen?.(ev);
    ws.onerror = (ev) => proxy.onerror?.(ev);
    ws.onclose = (ev) => proxy.onclose?.(ev);
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        try {
          masterBObservedFrames.push(decodeRelayFrame(new Uint8Array(ev.data)));
        } catch {
          // Ignore non-relay-frame payloads
        }
      }
      proxy.onmessage?.({ data: ev.data });
    };
    return proxy;
  };

  const managerB = new DeviceManager({
    store: storeB,
    masterId: MASTER_B_ID,
    wsFactory: wsFactoryB,
    pingIntervalMs: 10_000,
  });

  let osProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let mcuProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  const osLogs: string[] = [];
  const mcuLogs: string[] = [];

  try {
    console.log(`[e2e] Starting Master A (${CLUSTER_A}/${MASTER_A_ID}) -> ${RELAY_URL}`);
    await managerA.configure({
      clusterId: CLUSTER_A,
      masterNodeId: MASTER_A_ID,
      relayUrl: RELAY_URL,
      token: tokenMasterA,
      e2eKey: e2eKeyA,
      enabled: true,
    });
    await waitFor("Master A relay connected", () => Boolean(managerA.getRelayClient()?.isRelayConnected()), 15_000);

    console.log(`[e2e] Starting Rust neo-agent-os --relay (${CLUSTER_A}/${OS_A_ID}, mqtt=${mqttBind})`);
    let mqttReady = false;
    osProc = Bun.spawn(
      [
        AGENT_OS_BIN,
        "--cluster",
        CLUSTER_A,
        "--device-id",
        OS_A_ID,
        "--master-id",
        MASTER_A_ID,
        "--relay-url",
        RELAY_URL,
        "--policy",
        policyPath,
        "--relay",
        "--mqtt-bind",
        mqttBind,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          NEO_TOKEN: tokenOsA,
          NEO_E2E_KEY: e2eKeyA,
        },
      },
    );
    void readStreamLines(osProc.stdout, (line) => osLogs.push(line));
    void readStreamLines(osProc.stderr, (line) => {
      osLogs.push(line);
      if (line.includes("Tier 2 MQTT relay broker listening")) {
        mqttReady = true;
      }
    });
    await waitFor("neo-agent-os MQTT broker ready", () => mqttReady, 15_000);

    console.log(`[e2e] Starting C99 esp32_rack01_sim (${CLUSTER_A}/${MCU_A_ID} -> ${mqttBind})`);
    let mcuReady = false;
    mcuProc = Bun.spawn(
      [
        MCU_SIM_BIN,
        "--broker",
        mqttBind,
        "--cluster",
        CLUSTER_A,
        "--device-id",
        MCU_A_ID,
        "--e2e-key",
        e2eKeyA,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    void readStreamLines(mcuProc.stdout, (line) => {
      mcuLogs.push(line);
      if (line.startsWith(`READY cluster=${CLUSTER_A} device=${MCU_A_ID}`)) {
        mcuReady = true;
      }
    });
    void readStreamLines(mcuProc.stderr, (line) => mcuLogs.push(line));
    await waitFor("esp32_rack01_sim READY", () => mcuReady, 10_000);

    // 1. Cluster A discovers neo-agent-os CapabilityManifest over live neo.1inch.cn:18443
    await waitFor(
      "Cluster A discovers os-e2e-a CapabilityManifest",
      () => {
        const d = managerA.getDevice(OS_A_ID);
        return Boolean(d && d.status === "online" && d.manifest && d.capabilities.length > 0);
      },
      15_000,
    );
    const osTwin = managerA.getDevice(OS_A_ID)!;
    assert(osTwin.tier === "os", "os-e2e-a tier should be os");
    assert(osTwin.capabilities.includes("exec"), "manifest missing exec capability");
    assert(osTwin.capabilities.includes("fs"), "manifest missing fs capability");
    assert(osTwin.manifest?.relay_config?.enabled === true, "manifest relay_config.enabled should be true");
    console.log("[PASS 1/8] Cluster A discovered neo-agent-os CapabilityManifest over live neo.1inch.cn:18443");

    // 2. Sandboxed exec & fs write/read inside allowed workspace
    const execOk = await managerA.invoke(OS_A_ID, {
      action: "exec",
      params: { program: "echo", args: ["hello-proposal1"], cwd: canonicalWorkspace },
    });
    assert(execOk.status === "ok", `exec failed: ${JSON.stringify(execOk)}`);
    const execResult = execOk.result as Record<string, unknown>;
    assert(execResult.exit_code === 0, `unexpected exit_code: ${JSON.stringify(execResult)}`);
    assert(String(execResult.stdout).trim() === "hello-proposal1", `unexpected stdout: ${String(execResult.stdout)}`);

    const targetFile = path.join(canonicalWorkspace, "proposal1-test.txt");
    const writeRes = await managerA.invoke(OS_A_ID, {
      action: "fs_write",
      params: {
        path: targetFile,
        content_b64: Buffer.from("neo-sandbox-ok", "utf8").toString("base64"),
        append: false,
      },
    });
    assert(writeRes.status === "ok", `fs_write failed: ${JSON.stringify(writeRes)}`);
    assert((writeRes.result as Record<string, unknown>).bytes_written === 14, "fs_write bytes_written mismatch");

    const readRes = await managerA.invoke(OS_A_ID, {
      action: "fs_read",
      params: { path: targetFile },
    });
    assert(readRes.status === "ok", `fs_read failed: ${JSON.stringify(readRes)}`);
    assert((readRes.result as Record<string, unknown>).text === "neo-sandbox-ok", "fs_read content mismatch");
    console.log("[PASS 2/8] Sandboxed exec + fs_write + fs_read inside allowed workspace succeeded");

    // 3. Red-team sandbox escape attempts
    const passwdRead = await managerA.invoke(OS_A_ID, {
      action: "fs_read",
      params: { path: "/etc/passwd" },
    });
    assert(passwdRead.status === "rejected", `fs_read /etc/passwd should be rejected, got: ${JSON.stringify(passwdRead)}`);

    const traversalRead = await managerA.invoke(OS_A_ID, {
      action: "fs_read",
      params: { path: `${canonicalWorkspace}/../../etc/passwd` },
    });
    assert(traversalRead.status === "rejected", "path traversal fs_read should be rejected");

    const outsideExec = await managerA.invoke(OS_A_ID, {
      action: "exec",
      params: { program: "ls", args: ["-la"], cwd: "/etc" },
    });
    assert(outsideExec.status === "rejected", `exec cwd=/etc should be rejected, got: ${JSON.stringify(outsideExec)}`);

    const deniedExec = await managerA.invoke(OS_A_ID, {
      action: "exec",
      params: { program: "rm", args: ["-f", targetFile], cwd: canonicalWorkspace },
    });
    assert(deniedExec.status === "rejected", "denied command rm should be rejected");
    console.log("[PASS 3/8] Red-team sandbox escape attempts (fs_read /etc/passwd, traversal, cwd=/etc, denied cmd) REJECTED");

    // 4. Tier 2 via Tier 1 proxy: read_dht22 (safe_auto)
    await waitFor(
      "Cluster A discovers mcu-esp32-rack01 via hello",
      () => {
        const m = managerA.getDevice(MCU_A_ID);
        return Boolean(m && m.tier === "mcu" && m.status === "online" && m.relayNodeId === OS_A_ID);
      },
      15_000,
    );
    const dhtRes = await managerA.invoke(MCU_A_ID, { action: "read_dht22" });
    assert(dhtRes.status === "ok", `read_dht22 failed: ${JSON.stringify(dhtRes)}`);
    const dhtData = dhtRes.result as Record<string, unknown>;
    assert(typeof dhtData.temp_c === "number" && typeof dhtData.humidity === "number", `unexpected dht22 payload: ${JSON.stringify(dhtData)}`);
    console.log(`[PASS 4/8] Tier 2 read_dht22 via Tier 1 proxy & live relay succeeded (temp_c=${dhtData.temp_c}, humidity=${dhtData.humidity})`);

    // 5. Approval workflow: set_fan_pwm(duty=85) -> pending_approval -> approve -> ok: true
    const pendingFan = await managerA.invoke(MCU_A_ID, {
      action: "set_fan_pwm",
      params: { duty: 85 },
    });
    assert(pendingFan.status === "pending_approval", `expected pending_approval, got: ${JSON.stringify(pendingFan)}`);
    const approvedFan = await managerA.approve(pendingFan.approvalId, "e2e-verifier");
    assert(approvedFan.result.status === "ok", `approved set_fan_pwm(85) failed: ${JSON.stringify(approvedFan)}`);
    assert((approvedFan.result.result as Record<string, unknown>).duty === 85, "expected duty=85 in MCU response");
    console.log("[PASS 5/8] Approval workflow set_fan_pwm(duty=85): pending_approval -> approve -> MCU ok:true");

    // 6. Bounds check: set_fan_pwm(duty=200) -> rejected by MCU static bounds
    const pendingOob = await managerA.invoke(MCU_A_ID, {
      action: "set_fan_pwm",
      params: { duty: 200 },
    });
    assert(pendingOob.status === "pending_approval", "expected pending_approval for duty=200");
    const oobRes = await managerA.approve(pendingOob.approvalId, "e2e-verifier");
    assert(oobRes.result.status === "rejected", `expected MCU bounds rejection for duty=200, got: ${JSON.stringify(oobRes)}`);
    console.log(`[PASS 6/8] Bounds check set_fan_pwm(duty=200) rejected by C99 MCU: ${oobRes.result.error}`);

    // 7. Multi-master hard isolation
    console.log(`[e2e] Starting Master B (${CLUSTER_B}/${MASTER_B_ID}) -> ${RELAY_URL}`);
    await managerB.configure({
      clusterId: CLUSTER_B,
      masterNodeId: MASTER_B_ID,
      relayUrl: RELAY_URL,
      token: tokenMasterB,
      e2eKey: e2eKeyB,
      enabled: true,
    });
    const clientB = managerB.getRelayClient();
    assert(clientB !== null, "Master B RelayClient missing");
    await waitFor("Master B relay connected", () => clientB.isRelayConnected(), 15_000);

    const peersB = (await clientB.fetchPeers()) as { cluster_id?: string; count?: number; peers?: Array<{ node_id?: string }> };
    assert(peersB.cluster_id === CLUSTER_B, `unexpected peers cluster_id: ${String(peersB.cluster_id)}`);
    const leakedIds = (peersB.peers ?? []).map((p) => p.node_id).filter((id) => id === OS_A_ID || id === MASTER_A_ID);
    assert(leakedIds.length === 0, `Cluster B /v1/peers leaked Cluster A nodes: ${leakedIds.join(",")}`);

    const crossFrameSent = clientB.sendData(OS_A_ID, new Uint8Array([0x01, 0x02, 0x03]));
    assert(crossFrameSent, "Master B sendData failed locally");
    await waitFor(
      "Master B receives FlagErrOffline (0x81) for Cluster A node",
      () =>
        masterBObservedFrames.some(
          (f) =>
            f.flags === FLAG_ERR_OFFLINE &&
            (new TextDecoder().decode(f.payload) === OS_A_ID || f.dst === OS_A_ID || f.src === OS_A_ID),
        ),
      10_000,
    );

    // Forged MCU command signed with Cluster B key forwarded through Tier 1 relay bridge -> rejected by C99 MCU
    const forgedSeq = 9999;
    const forgedEnvelope = sealRelayEnvelope({
      clusterId: CLUSTER_A,
      relayNodeId: OS_A_ID,
      targetMcuId: MCU_A_ID,
      direction: "downlink",
      seqId: forgedSeq,
      payload: { t: "cmd", a: "set_fan_pwm", p: { duty: 11 } },
      e2eMasterSecret: e2eKeyB, // Wrong cluster E2E key!
    });
    const forgedOuter = sealDeviceMessage(
      {
        v: 1,
        kind: "relay_envelope",
        req_id: "forged-mcu-9999",
        cluster_id: CLUSTER_A,
        device_id: MASTER_A_ID,
        ts_ms: Date.now(),
        body: forgedEnvelope as unknown as Record<string, unknown>,
      },
      e2eKeyA,
      MASTER_A_ID,
      OS_A_ID,
    );
    const rejectedBefore = mcuLogs.filter((l) => l.includes("downlink rejected")).length;
    assert(managerA.getRelayClient()!.sendData(OS_A_ID, forgedOuter), "failed to send forged envelope");
    await waitFor(
      "C99 MCU rejects forged e2e_mac signed with Cluster B key",
      () => mcuLogs.filter((l) => l.includes("downlink rejected")).length > rejectedBefore,
      10_000,
    );
    console.log("[PASS 7/8] Multi-master isolation verified: /v1/peers isolated, cross-cluster frame returned 0x81, forged Cluster B MCU MAC rejected by C99 MCU");

    // 8. Tier 1 offline alert suppression
    console.log(`[e2e] Killing neo-agent-os (${OS_A_ID}) to verify Tier 1 offline alert suppression...`);
    osProc.kill("SIGKILL");
    await osProc.exited;
    osProc = null;

    // Give Caddy/neo-relayd a moment to observe the closed TLS/WS connection, then probe until 0x81 ErrOffline is processed.
    await Bun.sleep(400);
    await waitFor(
      "Master A marks child MCU unreachable_via_relay with alertSuppressed",
      async () => {
        const osNow = managerA.getDevice(OS_A_ID);
        const mcuNow = managerA.getDevice(MCU_A_ID);
        if (
          osNow?.status === "offline" &&
          mcuNow?.status === "unreachable_via_relay" &&
          mcuNow?.alertSuppressed === true
        ) {
          return true;
        }
        const res = await managerA.invoke(MCU_A_ID, { action: "read_dht22", timeoutMs: 1_500 });
        assert(res.status === "rejected", `expected rejected after Tier 1 kill, got: ${JSON.stringify(res)}`);
        const osAfter = managerA.getDevice(OS_A_ID);
        const mcuAfter = managerA.getDevice(MCU_A_ID);
        return Boolean(
          osAfter?.status === "offline" &&
            mcuAfter?.status === "unreachable_via_relay" &&
            mcuAfter?.alertSuppressed === true,
        );
      },
      15_000,
      300,
    );
    console.log("[PASS 8/8] Tier 1 offline alert suppression verified: child MCU marked unreachable_via_relay (alertSuppressed=true)");
    console.log("ALL 8 LIVE E2E & RED-TEAM CHECKS PASSED");
  } finally {
    await Promise.allSettled([managerA.stop(), managerB.stop()]);
    if (mcuProc) {
      try {
        mcuProc.kill("SIGTERM");
      } catch {
        // Ignore
      }
      await mcuProc.exited.catch(() => {});
    }
    if (osProc) {
      try {
        osProc.kill("SIGKILL");
      } catch {
        // Ignore
      }
      await osProc.exited.catch(() => {});
    }
    storeA.close();
    storeB.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
