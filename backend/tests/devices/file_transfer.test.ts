import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { App, defaultTimings } from "../../src/app/index.ts";
import { mainSpecs, workerSpecs } from "../../src/app/tools.ts";
import { Protocol } from "../../src/app/wechat_protocol.ts";
import {
  DeviceManager,
  FILE_ENVELOPE_VERSION,
  FILE_FRAME_KIND_ABORT,
  FILE_FRAME_KIND_ACK,
  FILE_FRAME_KIND_DATA,
  FILE_FRAME_KIND_DONE,
  FILE_FRAME_KIND_FINISH,
  FLAG_DATA,
  FLAG_ERR_RATE,
  FLAG_PING,
  FLAG_PONG,
  decodeRelayFrame,
  encodeRelayFrame,
  openDeviceMessage,
  openFileFrame,
  sealDeviceMessage,
  sealFileFrame,
  type RelayFrame,
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

function makeRequest(method: string, reqPath: string, body?: unknown): Request {
  const headers = new Map<string, string>([["host", "127.0.0.1:3082"]]);
  let bytes = new Uint8Array(0);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    bytes = new TextEncoder().encode(JSON.stringify(body));
  }
  return new Request({ method, path: reqPath, headers, body: bytes });
}

function sha256Bytes(data: Uint8Array): Uint8Array {
  const d = createHash("sha256").update(data).digest();
  return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function findRustAgentBinary(): string | null {
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const candidates = [
    path.join(repoRoot, "agents/neo-agent-os/target/debug/neo-agent-os"),
    path.join(repoRoot, "agents/neo-agent-os/target/release/neo-agent-os"),
  ];
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting after ${timeoutMs}ms`);
}

describe("devices/file-transfer", () => {
  test("pullFile & pushFile stream 0xE3 binary frames with resume, rate-limit backoff, SHA-256 verification, and legacy RPC fallback", async () => {
    const dir = new TempDir("neo-ft-unit");
    try {
      const store = Store.memory();
      const clusterId = "cluster-ft";
      const masterId = "master-ft";
      const deviceId = "os-mac";
      const e2eKey = "ft-e2e-secret";

      // Simulated remote files on Tier 1
      const remotePayload = randomBytes(48 * 1024 + 321); // multi-chunk
      const remoteSha = sha256Bytes(remotePayload);
      let legacyMode = false;
      let dropSecondPushChunkOnce = true;
      const receivedPushChunks = new Map<string, { chunks: Buffer[]; expectedSize: number }>();

      const { wsFactory } = makeMockSockets((sock, raw) => {
        const frame = decodeRelayFrame(raw);
        if (frame.flags !== FLAG_DATA || frame.dst !== deviceId) return;

        // Incoming 0xE3 binary file frame from Master (ACK/DONE during pull; DATA/FINISH during push)
        if (frame.payload[0] === FILE_ENVELOPE_VERSION) {
          const ff = openFileFrame(frame.payload, e2eKey, clusterId, masterId, deviceId);
          if (ff.kind === FILE_FRAME_KIND_DATA) {
            const st = receivedPushChunks.get(ff.transferId);
            if (!st) return;
            const curLen = st.chunks.reduce((a, b) => a + b.byteLength, 0);
            // Simulate a single relay rate-limit drop on chunk 1 to test rewind + backoff!
            if (dropSecondPushChunkOnce && ff.offset > 0) {
              dropSecondPushChunkOnce = false;
              queueMicrotask(() => {
                sock.emitMessage(
                  encodeRelayFrame({
                    flags: FLAG_ERR_RATE,
                    src: "neo-relay",
                    dst: masterId,
                    payload: new TextEncoder().encode("rate limit exceeded"),
                  }),
                );
              });
              return;
            }
            if (ff.offset === curLen) {
              st.chunks.push(Buffer.from(ff.data));
            }
            const nextOffset = st.chunks.reduce((a, b) => a + b.byteLength, 0);
            const ackWire = sealFileFrame(
              {
                v: 1,
                kind: FILE_FRAME_KIND_ACK,
                flags: 0,
                seq: ff.seq,
                offset: nextOffset,
                window: 32 * 1024,
                transferId: ff.transferId,
                data: new Uint8Array(0),
              },
              e2eKey,
              clusterId,
              deviceId,
              masterId,
            );
            queueMicrotask(() => {
              sock.emitMessage(
                encodeRelayFrame({
                  flags: FLAG_DATA,
                  src: deviceId,
                  dst: masterId,
                  payload: ackWire,
                }),
              );
            });
          } else if (ff.kind === FILE_FRAME_KIND_FINISH) {
            const st = receivedPushChunks.get(ff.transferId);
            if (!st) return;
            const full = Buffer.concat(st.chunks);
            const digest = sha256Bytes(full);
            const doneWire = sealFileFrame(
              {
                v: 1,
                kind: FILE_FRAME_KIND_DONE,
                flags: 0,
                seq: ff.seq,
                offset: full.byteLength,
                window: 0,
                transferId: ff.transferId,
                data: digest,
              },
              e2eKey,
              clusterId,
              deviceId,
              masterId,
            );
            queueMicrotask(() => {
              sock.emitMessage(
                encodeRelayFrame({
                  flags: FLAG_DATA,
                  src: deviceId,
                  dst: masterId,
                  payload: doneWire,
                }),
              );
            });
          }
          return;
        }

        // Control plane 0xE1 RPC
        const msg = openDeviceMessage(frame.payload, e2eKey, clusterId, masterId, deviceId);
        if (msg.kind !== "rpc_req") return;
        const method = String(msg.body.method ?? "");
        const params = (msg.body.params ?? {}) as Record<string, unknown>;

        const replyRpc = (body: Record<string, unknown>) => {
          const respWire = sealDeviceMessage(
            {
              v: 1,
              kind: "rpc_resp",
              req_id: msg.req_id,
              cluster_id: clusterId,
              device_id: deviceId,
              ts_ms: Date.now(),
              body,
            },
            e2eKey,
            deviceId,
            masterId,
          );
          queueMicrotask(() => {
            sock.emitMessage(
              encodeRelayFrame({ flags: FLAG_DATA, src: deviceId, dst: masterId, payload: respWire }),
            );
          });
        };

        if (method === "fs.stat" || method === "fs_stat") {
          replyRpc({
            ok: true,
            result: {
              exists: true,
              path: String(params.path),
              kind: "file",
              is_file: true,
              is_dir: false,
              size: remotePayload.byteLength,
              ...(params.sha256 ? { sha256: sha256Hex(remotePayload) } : {}),
            },
          });
          return;
        }

        if (method === "file.pull.open") {
          if (legacyMode) {
            replyRpc({ ok: false, error: "unsupported RPC method: file.pull.open" });
            return;
          }
          const transferId = String(params.transfer_id);
          const startOffset = Number(params.offset ?? 0);
          const chunkSize = Number(params.chunk_size ?? 16384);
          replyRpc({
            ok: true,
            result: {
              transfer_id: transferId,
              path: String(params.path),
              size: remotePayload.byteLength,
              offset: startOffset,
              chunk_size: chunkSize,
              protocol: "binary_e2e_v1",
            },
          });
          // Stream remaining chunks + FINISH via 0xE3
          setTimeout(() => {
            let off = startOffset;
            let seq = 0;
            while (off < remotePayload.byteLength) {
              const end = Math.min(off + chunkSize, remotePayload.byteLength);
              const slice = remotePayload.subarray(off, end);
              const dataWire = sealFileFrame(
                {
                  v: 1,
                  kind: FILE_FRAME_KIND_DATA,
                  flags: 0,
                  seq: seq++,
                  offset: off,
                  window: 0,
                  transferId,
                  data: new Uint8Array(slice),
                },
                e2eKey,
                clusterId,
                deviceId,
                masterId,
              );
              sock.emitMessage(
                encodeRelayFrame({ flags: FLAG_DATA, src: deviceId, dst: masterId, payload: dataWire }),
              );
              off = end;
            }
            const finishWire = sealFileFrame(
              {
                v: 1,
                kind: FILE_FRAME_KIND_FINISH,
                flags: 0,
                seq,
                offset: remotePayload.byteLength,
                window: 0,
                transferId,
                data: remoteSha,
              },
              e2eKey,
              clusterId,
              deviceId,
              masterId,
            );
            sock.emitMessage(
              encodeRelayFrame({ flags: FLAG_DATA, src: deviceId, dst: masterId, payload: finishWire }),
            );
          }, 5);
          return;
        }

        if (method === "file.push.open") {
          if (legacyMode) {
            replyRpc({ ok: false, error: "unsupported RPC method: file.push.open" });
            return;
          }
          const transferId = String(params.transfer_id);
          receivedPushChunks.set(transferId, { chunks: [], expectedSize: Number(params.size) });
          replyRpc({
            ok: true,
            result: {
              transfer_id: transferId,
              path: String(params.path),
              size: Number(params.size),
              resume_offset: 0,
              chunk_size: Number(params.chunk_size ?? 16384),
              window_bytes: 32 * 1024,
              protocol: "binary_e2e_v1",
            },
          });
          return;
        }

        if (method === "fs_read") {
          const offset = Number(params.offset ?? 0);
          const limit = Number(params.limit ?? 16384);
          const slice = remotePayload.subarray(offset, Math.min(offset + limit, remotePayload.byteLength));
          replyRpc({
            ok: true,
            result: {
              path: String(params.path),
              size: remotePayload.byteLength,
              offset,
              bytes_read: slice.byteLength,
              eof: offset + slice.byteLength >= remotePayload.byteLength,
              content_b64: Buffer.from(slice).toString("base64"),
            },
          });
          return;
        }

        if (method === "transfer_chunk") {
          const transferId = String(params.transfer_id);
          const chunk = Buffer.from(String(params.chunk_b64 ?? ""), "base64");
          const entry = receivedPushChunks.get(transferId) ?? { chunks: [], expectedSize: 0 };
          entry.chunks.push(chunk);
          receivedPushChunks.set(transferId, entry);
          replyRpc({
            ok: true,
            result: {
              transfer_id: transferId,
              path: String(params.path),
              offset: Number(params.offset ?? 0),
              bytes_written: chunk.byteLength,
              finalized: Boolean(params.eof),
            },
          });
        }
      });

      const manager = new DeviceManager({
        store,
        masterId: "ft",
        fetchFn: (async () => new Response(JSON.stringify({ cluster_id: clusterId }), { status: 200 })) as unknown as typeof fetch,
        wsFactory,
        pingIntervalMs: 0,
      });

      await manager.configure(
        {
          clusterId,
          masterNodeId: masterId,
          relayUrl: "https://relay.local:18443",
          relaySecret: "secret",
          e2eKey,
        },
        { connect: true },
      );

      manager.upsertDeviceManifest(
        { device_id: deviceId, tier: "os", capabilities: ["exec", "fs", "fs_stat", "file_channel"] },
        { status: "online" },
      );

      // 1. statFile
      const st = await manager.statFile(deviceId, "/ws/manual.pdf", { sha256: true });
      expect(st.status).toBe("ok");
      if (st.status === "ok") {
        const res = st.result as Record<string, unknown>;
        expect(res.exists).toBe(true);
        expect(res.size).toBe(remotePayload.byteLength);
        expect(res.sha256).toBe(sha256Hex(remotePayload));
      }

      // 2. Binary 0xE3 pull with resume from pre-existing partial staging file
      const pulledPath = path.join(dir.path, "pulled-manual.pdf");
      const resumePrefixLen = 12 * 1024;
      fs.writeFileSync(
        path.join(dir.path, ".neo-part-ft_resume_pull"),
        remotePayload.subarray(0, resumePrefixLen),
      );
      const pullRes = await manager.pullFile({
        deviceId,
        remotePath: "/ws/manual.pdf",
        localPath: pulledPath,
        transferId: "ft_resume_pull",
        resume: true,
        chunkSize: 16 * 1024,
      });
      expect(pullRes.protocol).toBe("binary_e2e_v1");
      expect(pullRes.resumedFromBytes).toBe(resumePrefixLen);
      expect(pullRes.bytesTransferred).toBe(remotePayload.byteLength);
      expect(pullRes.sha256).toBe(sha256Hex(remotePayload));
      expect(Buffer.compare(fs.readFileSync(pulledPath), remotePayload)).toBe(0);

      // 3. Binary 0xE3 push with simulated FLAG_ERR_RATE drop + automatic rewind & completion
      const pushLocalPath = path.join(dir.path, "upload.bin");
      const pushPayload = randomBytes(36 * 1024 + 99);
      fs.writeFileSync(pushLocalPath, pushPayload);
      const pushRes = await manager.pushFile({
        deviceId,
        localPath: pushLocalPath,
        remotePath: "/ws/upload.bin",
        transferId: "ft_push_rl",
        chunkSize: 16 * 1024,
        windowBytes: 32 * 1024,
      });
      expect(pushRes.protocol).toBe("binary_e2e_v1");
      expect(pushRes.bytesTransferred).toBe(pushPayload.byteLength);
      expect(pushRes.sha256).toBe(sha256Hex(pushPayload));
      const pushedBytes = Buffer.concat(receivedPushChunks.get("ft_push_rl")!.chunks);
      expect(Buffer.compare(pushedBytes, pushPayload)).toBe(0);

      // 4. Legacy fallback mode (older Tier 1 agent without file.pull.open / file.push.open)
      legacyMode = true;
      const legacyPullPath = path.join(dir.path, "legacy-pull.bin");
      const legacyPull = await manager.pullFile({
        deviceId,
        remotePath: "/ws/manual.pdf",
        localPath: legacyPullPath,
      });
      expect(legacyPull.protocol).toBe("rpc_fallback");
      expect(Buffer.compare(fs.readFileSync(legacyPullPath), remotePayload)).toBe(0);

      const legacyPush = await manager.pushFile({
        deviceId,
        localPath: pushLocalPath,
        remotePath: "/ws/legacy-upload.bin",
        transferId: "ft_legacy_push",
      });
      expect(legacyPush.protocol).toBe("rpc_fallback");
      expect(Buffer.compare(Buffer.concat(receivedPushChunks.get("ft_legacy_push")!.chunks), pushPayload)).toBe(0);

      // Transfer history view
      expect(manager.listTransfers().length).toBe(4);
      expect(manager.getTransfer("ft_resume_pull")?.status).toBe("completed");

      await manager.stop();
      store.close();
    } finally {
      dir.cleanup();
    }
  });

  test("device_file_transfer tool schema & execution and HTTP /api/devices/:id/files/* endpoints", async () => {
    const mainSpec = mainSpecs().find((s) => s.name === "device_file_transfer");
    const workerSpec = workerSpecs().find((s) => s.name === "device_file_transfer");
    expect(mainSpec).toBeDefined();
    expect(workerSpec).toBeDefined();

    const dir = new TempDir("neo-ft-http");
    try {
      const scripted = new Scripted();
      scripted.model = async () => "ok";
      const app = App.open(
        { stateDir: dir.path, wechat: new Protocol() },
        new ScriptedKernels(scripted),
        defaultTimings(),
      );
      await app.start();

      // Configure with mocked WS relay
      const clusterId = "cluster-api";
      const masterId = "master-api";
      const deviceId = "os-api";
      const e2eKey = "api-e2e-key";
      const remoteData = new TextEncoder().encode("Quant360 FPGA manual bytes!");
      const remoteSha = sha256Bytes(remoteData);

      const { wsFactory } = makeMockSockets((sock, raw) => {
        const frame = decodeRelayFrame(raw);
        if (frame.flags !== FLAG_DATA || frame.dst !== deviceId) return;
        if (frame.payload[0] === FILE_ENVELOPE_VERSION) return;
        const msg = openDeviceMessage(frame.payload, e2eKey, clusterId, masterId, deviceId);
        if (msg.kind !== "rpc_req") return;
        const method = String(msg.body.method);
        const params = (msg.body.params ?? {}) as Record<string, unknown>;
        const sendRpcResp = (body: Record<string, unknown>) => {
          const w = sealDeviceMessage(
            {
              v: 1,
              kind: "rpc_resp",
              req_id: msg.req_id,
              cluster_id: clusterId,
              device_id: deviceId,
              ts_ms: Date.now(),
              body,
            },
            e2eKey,
            deviceId,
            masterId,
          );
          queueMicrotask(() => {
            sock.emitMessage(encodeRelayFrame({ flags: FLAG_DATA, src: deviceId, dst: masterId, payload: w }));
          });
        };

        if (method === "fs.stat") {
          sendRpcResp({
            ok: true,
            result: { exists: true, path: String(params.path), size: remoteData.byteLength, is_file: true },
          });
        } else if (method === "file.pull.open") {
          const transferId = String(params.transfer_id);
          sendRpcResp({
            ok: true,
            result: {
              transfer_id: transferId,
              path: String(params.path),
              size: remoteData.byteLength,
              offset: 0,
              chunk_size: 131072,
              protocol: "binary_e2e_v1",
            },
          });
          setTimeout(() => {
            const dWire = sealFileFrame(
              {
                v: 1,
                kind: FILE_FRAME_KIND_DATA,
                flags: 0,
                seq: 0,
                offset: 0,
                window: 0,
                transferId,
                data: remoteData,
              },
              e2eKey,
              clusterId,
              deviceId,
              masterId,
            );
            const fWire = sealFileFrame(
              {
                v: 1,
                kind: FILE_FRAME_KIND_FINISH,
                flags: 0,
                seq: 1,
                offset: remoteData.byteLength,
                window: 0,
                transferId,
                data: remoteSha,
              },
              e2eKey,
              clusterId,
              deviceId,
              masterId,
            );
            sock.emitMessage(encodeRelayFrame({ flags: FLAG_DATA, src: deviceId, dst: masterId, payload: dWire }));
            sock.emitMessage(encodeRelayFrame({ flags: FLAG_DATA, src: deviceId, dst: masterId, payload: fWire }));
          }, 5);
        }
      });

      const dm = new DeviceManager({
        store: app.store,
        masterId: "api",
        fetchFn: (async () => new Response(JSON.stringify({ cluster_id: clusterId }), { status: 200 })) as unknown as typeof fetch,
        wsFactory,
        pingIntervalMs: 0,
      });
      await dm.configure(
        {
          clusterId,
          masterNodeId: masterId,
          relayUrl: "https://relay.local:18443",
          relaySecret: "sec",
          e2eKey,
        },
        { connect: true },
      );
      dm.upsertDeviceManifest({ device_id: deviceId, tier: "os", capabilities: ["fs_stat", "file_channel"] }, { status: "online" });
      // Attach test DeviceManager onto app for tool + HTTP route verification
      (app as unknown as { devices: DeviceManager }).devices = dm;

      const toolDest = path.join(dir.path, "tool-pulled.pdf");
      const toolOut = (await app.mainTool("device_file_transfer", {
        device_id: deviceId,
        direction: "pull",
        remote_path: "/ws/Quant360.pdf",
        local_path: toolDest,
      })) as { protocol: string; bytesTransferred: number; sha256: string };
      expect(toolOut.protocol).toBe("binary_e2e_v1");
      expect(toolOut.bytesTransferred).toBe(remoteData.byteLength);
      expect(fs.readFileSync(toolDest, "utf8")).toBe("Quant360 FPGA manual bytes!");

      const peer = { host: "127.0.0.1", port: 50002 };
      const statResp = await handle(
        app,
        {},
        makeRequest("POST", `/api/devices/${deviceId}/files/stat`, { path: "/ws/Quant360.pdf" }),
        peer,
      );
      expect(statResp.status).toBe(200);
      const statJson = JSON.parse(new TextDecoder().decode(statResp.body)) as {
        status: string;
        result: { exists: boolean; size: number };
      };
      expect(statJson.status).toBe("ok");
      expect(statJson.result.size).toBe(remoteData.byteLength);

      const httpDest = path.join(dir.path, "http-pulled.pdf");
      const pullResp = await handle(
        app,
        {},
        makeRequest("POST", `/api/devices/${deviceId}/files/pull`, {
          remotePath: "/ws/Quant360.pdf",
          localPath: httpDest,
        }),
        peer,
      );
      expect(pullResp.status).toBe(200);
      const pullJson = JSON.parse(new TextDecoder().decode(pullResp.body)) as {
        transfer: { transferId: string; protocol: string; bytesTransferred: number };
      };
      expect(pullJson.transfer.protocol).toBe("binary_e2e_v1");
      expect(fs.readFileSync(httpDest, "utf8")).toBe("Quant360 FPGA manual bytes!");

      const listResp = await handle(app, {}, makeRequest("GET", "/api/devices/transfers"), peer);
      expect(listResp.status).toBe(200);
      const listJson = JSON.parse(new TextDecoder().decode(listResp.body)) as {
        transfers: Array<{ transferId: string }>;
      };
      expect(listJson.transfers.length).toBe(2);

      const getResp = await handle(
        app,
        {},
        makeRequest("GET", `/api/devices/transfers/${pullJson.transfer.transferId}`),
        peer,
      );
      expect(getResp.status).toBe(200);

      const delResp = await handle(
        app,
        {},
        makeRequest("DELETE", "/api/devices/transfers/nonexistent"),
        peer,
      );
      expect(delResp.status).toBe(404);

      await dm.stop();
      await app.stop();
      app.close();
    } finally {
      dir.cleanup();
    }
  });

  test("pullFile rejects SHA-256 mismatch, cleans up staging, aborts on disconnect, and supports cancelTransfer", async () => {
    const dir = new TempDir("neo-ft-errors");
    try {
      const store = Store.memory();
      const clusterId = "cluster-err";
      const masterId = "master-err";
      const deviceId = "os-err";
      const e2eKey = "err-e2e-key";
      let mode: "bad_sha" | "hang" = "bad_sha";

      const { wsFactory } = makeMockSockets((sock, raw) => {
        const frame = decodeRelayFrame(raw);
        if (frame.flags !== FLAG_DATA || frame.dst !== deviceId) return;
        if (frame.payload[0] === FILE_ENVELOPE_VERSION) return;
        const msg = openDeviceMessage(frame.payload, e2eKey, clusterId, masterId, deviceId);
        if (msg.kind !== "rpc_req" || msg.body.method !== "file.pull.open") return;
        const params = (msg.body.params ?? {}) as Record<string, unknown>;
        const transferId = String(params.transfer_id);
        const resp = sealDeviceMessage(
          {
            v: 1,
            kind: "rpc_resp",
            req_id: msg.req_id,
            cluster_id: clusterId,
            device_id: deviceId,
            ts_ms: Date.now(),
            body: {
              ok: true,
              result: {
                transfer_id: transferId,
                path: String(params.path),
                size: 5,
                offset: 0,
                chunk_size: 4096,
                protocol: "binary_e2e_v1",
              },
            },
          },
          e2eKey,
          deviceId,
          masterId,
        );
        queueMicrotask(() => {
          sock.emitMessage(encodeRelayFrame({ flags: FLAG_DATA, src: deviceId, dst: masterId, payload: resp }));
        });
        if (mode === "bad_sha") {
          setTimeout(() => {
            const dWire = sealFileFrame(
              {
                v: 1,
                kind: FILE_FRAME_KIND_DATA,
                flags: 0,
                seq: 0,
                offset: 0,
                window: 0,
                transferId,
                data: new TextEncoder().encode("hello"),
              },
              e2eKey,
              clusterId,
              deviceId,
              masterId,
            );
            const fWire = sealFileFrame(
              {
                v: 1,
                kind: FILE_FRAME_KIND_FINISH,
                flags: 0,
                seq: 1,
                offset: 5,
                window: 0,
                transferId,
                data: new Uint8Array(32).fill(0xee), // wrong SHA-256
              },
              e2eKey,
              clusterId,
              deviceId,
              masterId,
            );
            sock.emitMessage(encodeRelayFrame({ flags: FLAG_DATA, src: deviceId, dst: masterId, payload: dWire }));
            sock.emitMessage(encodeRelayFrame({ flags: FLAG_DATA, src: deviceId, dst: masterId, payload: fWire }));
          }, 5);
        }
      });

      const manager = new DeviceManager({
        store,
        masterId: "err",
        fetchFn: (async () => new Response(JSON.stringify({ cluster_id: clusterId }), { status: 200 })) as unknown as typeof fetch,
        wsFactory,
        pingIntervalMs: 0,
      });
      await manager.configure(
        {
          clusterId,
          masterNodeId: masterId,
          relayUrl: "https://relay.local:18443",
          relaySecret: "sec",
          e2eKey,
        },
        { connect: true },
      );
      manager.upsertDeviceManifest({ device_id: deviceId, tier: "os", capabilities: ["file_channel"] }, { status: "online" });

      // 1. Bad SHA-256 rejected and staging cleaned up
      const badDest = path.join(dir.path, "bad.bin");
      await expect(
        manager.pullFile({ deviceId, remotePath: "/ws/bad.bin", localPath: badDest, transferId: "ft_bad_sha" }),
      ).rejects.toThrow("SHA-256 mismatch");
      expect(fs.existsSync(badDest)).toBe(false);
      expect(fs.existsSync(path.join(dir.path, ".neo-part-ft_bad_sha"))).toBe(false);

      // 2. cancelTransfer aborts an active pull cleanly
      mode = "hang";
      const cancelPromise = manager.pullFile({
        deviceId,
        remotePath: "/ws/hang.bin",
        localPath: path.join(dir.path, "hang.bin"),
        transferId: "ft_cancel_me",
        timeoutMs: 10_000,
      });
      await Bun.sleep(20);
      expect(manager.cancelTransfer("ft_cancel_me", "user aborted")).toBe(true);
      await expect(cancelPromise).rejects.toThrow("user aborted");
      expect(manager.getTransfer("ft_cancel_me")?.status).toBe("cancelled");

      // 3. handleTier1Disconnect aborts active transfer
      const discPromise = manager.pullFile({
        deviceId,
        remotePath: "/ws/disc.bin",
        localPath: path.join(dir.path, "disc.bin"),
        transferId: "ft_disc_me",
        timeoutMs: 10_000,
      });
      await Bun.sleep(20);
      manager.handleTier1Disconnect(deviceId);
      await expect(discPromise).rejects.toThrow("disconnected");

      await manager.stop();
      store.close();
    } finally {
      dir.cleanup();
    }
  });

  const rustBinForE2e = findRustAgentBinary();
  test.skipIf(!rustBinForE2e)(
    "REAL cross-language E2E: TypeScript DeviceManager <-> local WS relay <-> compiled Rust neo-agent-os (fs.stat + 1.5 MiB binary pull/push + resume + 0B file + overwrite + sandbox escape)",
    async () => {
    const rustBin = rustBinForE2e!;

    const dir = new TempDir("neo-ft-crosslang");
    const remoteWs = path.join(dir.path, "remote-ws");
    const masterDir = path.join(dir.path, "master-files");
    fs.mkdirSync(remoteWs, { recursive: true });
    fs.mkdirSync(masterDir, { recursive: true });
    const canonicalRemoteWs = fs.realpathSync(remoteWs);

    const policyPath = path.join(dir.path, "policy.toml");
    fs.writeFileSync(
      policyPath,
      [
        `allowed_workspaces = [${JSON.stringify(canonicalRemoteWs)}]`,
        `allowed_commands = ["echo"]`,
        `denied_commands = ["rm"]`,
        "",
      ].join("\n"),
      "utf8",
    );

    const clusterId = "cluster-xlang";
    const masterId = "master-xlang";
    const osId = "os-xlang";
    const e2eKey = "xlang-e2e-shared-key";

    // Minimal in-process loopback relay server enforcing 1 MiB max frame size just like neo-relayd!
    const MAX_RELAY_WS_FRAME = 1024 * 1024;
    const relayPeers = new Map<string, Bun.ServerWebSocket<{ nodeId: string; path: string }>>();
    let observedBinaryFileFrames = 0;

    const server = Bun.serve<{ nodeId: string; path: string }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        const auth = req.headers.get("authorization") ?? "";
        const tok = auth.replace(/^Bearer\s+/i, "").trim();
        const nodeId = tok.startsWith("tok:") ? tok.slice(4) : "unknown";
        if (url.pathname === "/v1/bootstrap") {
          return new Response(JSON.stringify({ cluster_id: clusterId, node_id: nodeId, stun_servers: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
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
        maxPayloadLength: MAX_RELAY_WS_FRAME,
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
          expect(bytes.byteLength).toBeLessThanOrEqual(MAX_RELAY_WS_FRAME);
          const frame = decodeRelayFrame(bytes);
          if (frame.flags === FLAG_PING) {
            ws.sendBinary(
              encodeRelayFrame({ flags: FLAG_PONG, src: "neo-relay", dst: ws.data.nodeId, payload: new Uint8Array(0) }),
            );
            return;
          }
          if (frame.flags === FLAG_DATA) {
            if (frame.payload[0] === FILE_ENVELOPE_VERSION) {
              observedBinaryFileFrames += 1;
            }
            const dstSock = relayPeers.get(frame.dst);
            if (dstSock) {
              dstSock.sendBinary(bytes);
            }
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
      masterId: "xlang",
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
          "--policy",
          policyPath,
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            NEO_TOKEN: `tok:${osId}`,
            NEO_E2E_KEY: e2eKey,
          },
        },
      );

      await waitFor(() => {
        const twin = manager.getDevice(osId);
        return Boolean(twin && twin.status === "online" && twin.capabilities.includes("file_channel"));
      }, 10_000);

      const twin = manager.getDevice(osId)!;
      expect(twin.capabilities).toContain("fs_stat");
      expect(twin.capabilities).toContain("file_channel");

      // Prepare a 1.5 MiB binary file on Rust Tier 1 workspace (exceeds 1 MiB relay frame limit!)
      const bigFileSize = 1_536 * 1024 + 777;
      const bigBytes = randomBytes(bigFileSize);
      const bigSha = sha256Hex(bigBytes);
      const remoteBigPath = path.join(canonicalRemoteWs, "Quant360_FPGA_Manual.pdf");
      fs.writeFileSync(remoteBigPath, bigBytes);

      // 1. fs.stat (existing file with SHA-256, missing file in workspace, and /etc/passwd escape rejection)
      const statOk = await manager.statFile(osId, remoteBigPath, { sha256: true });
      expect(statOk.status).toBe("ok");
      if (statOk.status === "ok") {
        const r = statOk.result as Record<string, unknown>;
        expect(r.exists).toBe(true);
        expect(r.is_file).toBe(true);
        expect(r.size).toBe(bigFileSize);
        expect(r.sha256).toBe(bigSha);
      }

      const statMissing = await manager.statFile(osId, path.join(canonicalRemoteWs, "not-here.pdf"));
      expect(statMissing.status).toBe("ok");
      if (statMissing.status === "ok") {
        expect((statMissing.result as Record<string, unknown>).exists).toBe(false);
      }

      const statEscape = await manager.statFile(osId, "/etc/passwd");
      expect(statEscape.status).toBe("rejected");

      // 2. PULL 1.5 MiB binary file over real 0xE3 binary channel from Rust -> Master TS
      const pulledLocalPath = path.join(masterDir, "Quant360_FPGA_Manual.pdf");
      const pullRes = await manager.pullFile({
        deviceId: osId,
        remotePath: remoteBigPath,
        localPath: pulledLocalPath,
        chunkSize: 128 * 1024,
        windowBytes: 512 * 1024,
      });
      expect(pullRes.protocol).toBe("binary_e2e_v1");
      expect(pullRes.bytesTransferred).toBe(bigFileSize);
      expect(pullRes.sha256).toBe(bigSha);
      expect(Buffer.compare(fs.readFileSync(pulledLocalPath), bigBytes)).toBe(0);
      expect(observedBinaryFileFrames).toBeGreaterThan(20);

      // 3. PUSH 1.5 MiB binary file over real 0xE3 binary channel from Master TS -> Rust
      const pushSourcePath = path.join(masterDir, "firmware-upload.bin");
      const pushBytes = randomBytes(1_400 * 1024 + 123);
      const pushSha = sha256Hex(pushBytes);
      fs.writeFileSync(pushSourcePath, pushBytes);
      const remotePushTarget = path.join(canonicalRemoteWs, "uploads/firmware-upload.bin");

      const pushRes = await manager.pushFile({
        deviceId: osId,
        localPath: pushSourcePath,
        remotePath: remotePushTarget,
        chunkSize: 128 * 1024,
        windowBytes: 512 * 1024,
      });
      expect(pushRes.protocol).toBe("binary_e2e_v1");
      expect(pushRes.bytesTransferred).toBe(pushBytes.byteLength);
      expect(pushRes.sha256).toBe(pushSha);
      expect(Buffer.compare(fs.readFileSync(remotePushTarget), pushBytes)).toBe(0);

      // 4. Cross-language resume (pull + push) and overwrite=false enforcement
      const resumePullDest = path.join(masterDir, "resumed-manual.pdf");
      const pullPrefix = 300 * 1024;
      fs.writeFileSync(
        path.join(masterDir, ".neo-part-xlang_resume_pull"),
        bigBytes.subarray(0, pullPrefix),
      );
      const resumedPull = await manager.pullFile({
        deviceId: osId,
        remotePath: remoteBigPath,
        localPath: resumePullDest,
        transferId: "xlang_resume_pull",
        resume: true,
        chunkSize: 128 * 1024,
      });
      expect(resumedPull.resumedFromBytes).toBe(pullPrefix);
      expect(resumedPull.sha256).toBe(bigSha);
      expect(Buffer.compare(fs.readFileSync(resumePullDest), bigBytes)).toBe(0);

      const resumePushRemote = path.join(canonicalRemoteWs, "uploads/resumed-upload.bin");
      const pushPrefix = 250 * 1024;
      fs.writeFileSync(
        path.join(canonicalRemoteWs, "uploads/.neo-part-xlang_resume_push"),
        pushBytes.subarray(0, pushPrefix),
      );
      const resumedPush = await manager.pushFile({
        deviceId: osId,
        localPath: pushSourcePath,
        remotePath: resumePushRemote,
        transferId: "xlang_resume_push",
        resume: true,
        chunkSize: 128 * 1024,
      });
      expect(resumedPush.resumedFromBytes).toBe(pushPrefix);
      expect(resumedPush.sha256).toBe(pushSha);
      expect(Buffer.compare(fs.readFileSync(resumePushRemote), pushBytes)).toBe(0);

      // overwrite=false must reject existing destinations on both pull & push
      await expect(
        manager.pullFile({
          deviceId: osId,
          remotePath: remoteBigPath,
          localPath: resumePullDest,
          overwrite: false,
        }),
      ).rejects.toThrow("overwrite is false");

      await expect(
        manager.pushFile({
          deviceId: osId,
          localPath: pushSourcePath,
          remotePath: resumePushRemote,
          overwrite: false,
          allowFallback: false,
        }),
      ).rejects.toThrow("overwrite is false");

      // 5. Zero-byte file pull & push
      const emptyRemote = path.join(canonicalRemoteWs, "empty.bin");
      fs.writeFileSync(emptyRemote, new Uint8Array(0));
      const emptyPulled = path.join(masterDir, "empty-pulled.bin");
      const emptyPullRes = await manager.pullFile({
        deviceId: osId,
        remotePath: emptyRemote,
        localPath: emptyPulled,
      });
      expect(emptyPullRes.bytesTransferred).toBe(0);
      expect(emptyPullRes.sha256).toBe(sha256Hex(new Uint8Array(0)));
      expect(fs.readFileSync(emptyPulled).byteLength).toBe(0);

      const emptyPushedRemote = path.join(canonicalRemoteWs, "empty-pushed.bin");
      const emptyPushRes = await manager.pushFile({
        deviceId: osId,
        localPath: emptyPulled,
        remotePath: emptyPushedRemote,
      });
      expect(emptyPushRes.bytesTransferred).toBe(0);
      expect(emptyPushRes.sha256).toBe(sha256Hex(new Uint8Array(0)));
      expect(fs.readFileSync(emptyPushedRemote).byteLength).toBe(0);

      // 6. Sandbox escape rejection on pull & push
      await expect(
        manager.pullFile({
          deviceId: osId,
          remotePath: "/etc/passwd",
          localPath: path.join(masterDir, "stolen.txt"),
          allowFallback: false,
        }),
      ).rejects.toThrow();

      await expect(
        manager.pushFile({
          deviceId: osId,
          localPath: emptyPulled,
          remotePath: "/etc/evil-neo-test",
          allowFallback: false,
        }),
      ).rejects.toThrow();
    } finally {
      await manager.stop();
      if (agentProc) {
        try {
          agentProc.kill("SIGKILL");
        } catch {
          // Ignore
        }
        await agentProc.exited.catch(() => {});
      }
      server.stop(true);
      store.close();
      dir.cleanup();
    }
  },
  );
});
