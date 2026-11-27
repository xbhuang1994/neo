/**
 * Direct Master Neo <-> Tier 1 OS Agent Binary File Transfer Channel (`0xE3`):
 * - Disk-to-disk streaming (constant O(1) memory, never routes file bytes through LLM context).
 * - Zero base64 bloat: raw binary chunks encrypted with per-cluster AES-256-GCM (`0xE3`, AAD `file-v1|cluster|src|dst`).
 * - Bidirectional PULL (Tier 1 -> Master) and PUSH (Master -> Tier 1).
 * - Sliding-window ACK flow control, adaptive `FLAG_ERR_RATE` backoff, retransmission on stall,
 *   resumable `.neo-part-<id>` staging, end-to-end SHA-256 integrity, and atomic rename commit.
 * - Graceful `rpc_fallback` (`fs_read` / `transfer_chunk` with safe <= 192 KiB chunks) when communicating
 *   with legacy Tier 1 agents that do not yet implement `file.pull.open` / `file.push.open`.
 */

import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual, type Hash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { openFileFrame, sealFileFrame, validateTransferId } from "./protocol.ts";
import type { RelayClient } from "./relay-client.ts";
import {
  FILE_FRAME_KIND_ABORT,
  FILE_FRAME_KIND_ACK,
  FILE_FRAME_KIND_DATA,
  FILE_FRAME_KIND_DONE,
  FILE_FRAME_KIND_FINISH,
  type DeviceConfig,
  type DeviceFilePullInput,
  type DeviceFilePushInput,
  type DeviceFileStat,
  type DeviceFileTransferResult,
  type DeviceInvokeRequest,
  type DeviceInvokeResult,
  type DeviceTwin,
  type FileFrame,
  type FileTransferDirection,
  type FileTransferProtocol,
  type FileTransferStatus,
  type FileTransferView,
} from "./types.ts";

export const DEFAULT_FILE_CHUNK_BYTES = 128 * 1024;
export const MIN_FILE_CHUNK_BYTES = 4 * 1024;
export const MAX_FILE_CHUNK_BYTES = 512 * 1024;
export const DEFAULT_FILE_WINDOW_BYTES = 512 * 1024;
export const MAX_FILE_WINDOW_BYTES = 2 * 1024 * 1024;
export const DEFAULT_FILE_TRANSFER_TIMEOUT_MS = 120_000;
export const FALLBACK_RPC_CHUNK_BYTES = 192 * 1024;

const MAX_CONCURRENT_TRANSFERS = 32;
const MAX_HISTORY_RECORDS = 50;
const PULL_STALL_NUDGE_MS = 3_000;
const PUSH_STALL_TIMEOUT_MS = 3_000;
const PUSH_MAX_STALL_RETRIES = 10;
const PUSH_DONE_TIMEOUT_MS = 3_000;
const PUSH_MAX_FINISH_RETRIES = 5;

const utf8Decoder = new TextDecoder("utf-8");

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampChunkSize(raw?: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_FILE_CHUNK_BYTES;
  return Math.max(MIN_FILE_CHUNK_BYTES, Math.min(MAX_FILE_CHUNK_BYTES, n));
}

function clampWindowBytes(raw: number | undefined, chunkSize: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_FILE_WINDOW_BYTES;
  return Math.max(chunkSize, Math.min(MAX_FILE_WINDOW_BYTES, n));
}

function isUnsupportedRpcError(error: string): boolean {
  return error.toLowerCase().includes("unsupported rpc method");
}

function generateTransferId(): string {
  return `ft_${randomBytes(8).toString("hex")}`;
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function computeLocalFilePrefixHash(
  filePath: string,
  maxBytes?: number,
): Promise<{ size: number; hasher: Hash }> {
  const hasher = createHash("sha256");
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (maxBytes === undefined || total < maxBytes) {
      const want =
        maxBytes === undefined ? buf.byteLength : Math.min(buf.byteLength, maxBytes - total);
      if (want <= 0) break;
      const { bytesRead } = await handle.read(buf, 0, want, total);
      if (bytesRead === 0) break;
      hasher.update(buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    return { size: total, hasher };
  } finally {
    await handle.close();
  }
}

interface PullSession {
  transferId: string;
  deviceId: string;
  remotePath: string;
  localPath: string;
  stagingPath: string;
  handle: fs.promises.FileHandle | null;
  hasher: Hash;
  receivedBytes: number;
  resumedFromBytes: number;
  totalBytes: number | null;
  chunks: number;
  windowBytes: number;
  overwrite: boolean;
  startedAtMs: number;
  idleTimeoutMs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  nudgeTimer: ReturnType<typeof setInterval> | null;
  lastActivityMs: number;
  settled: boolean;
  queue: Promise<void>;
  resolve: (result: DeviceFileTransferResult) => void;
  reject: (err: Error) => void;
}

type PushSignal =
  | { kind: "ack"; offset: number; window: number }
  | { kind: "done"; offset: number; sha256: Uint8Array }
  | { kind: "abort"; reason: string }
  | { kind: "rate_limited" };

interface PushSession {
  transferId: string;
  deviceId: string;
  signals: PushSignal[];
  waiter: (() => void) | null;
  cancelled: boolean;
  cancelReason?: string;
}

export interface FileTransferManagerOptions {
  getConfig: () => DeviceConfig | null;
  getDevice: (deviceId: string) => DeviceTwin | null;
  getRelayClient: () => RelayClient | null;
  invokeDevice: (deviceId: string, req: DeviceInvokeRequest) => Promise<DeviceInvokeResult>;
  onLogError?: (message: string) => void;
}

export class FileTransferManager {
  private readonly getConfig: () => DeviceConfig | null;
  private readonly getDevice: (deviceId: string) => DeviceTwin | null;
  private readonly getRelayClient: () => RelayClient | null;
  private readonly invokeDevice: (deviceId: string, req: DeviceInvokeRequest) => Promise<DeviceInvokeResult>;
  private readonly onLogError?: (message: string) => void;

  private readonly pullSessions = new Map<string, PullSession>();
  private readonly pushSessions = new Map<string, PushSession>();
  private readonly views = new Map<string, FileTransferView>();
  private readonly historyOrder: string[] = [];

  constructor(options: FileTransferManagerOptions) {
    this.getConfig = options.getConfig;
    this.getDevice = options.getDevice;
    this.getRelayClient = options.getRelayClient;
    this.invokeDevice = options.invokeDevice;
    this.onLogError = options.onLogError;
  }

  /** Query metadata (and optional streaming SHA-256) of a remote Tier 1 path via `fs.stat`. */
  async statFile(
    deviceId: string,
    remotePath: string,
    opts: { sha256?: boolean; timeoutMs?: number } = {},
  ): Promise<DeviceInvokeResult> {
    if (typeof remotePath !== "string" || remotePath.trim().length === 0) {
      return {
        status: "rejected",
        deviceId,
        action: "fs.stat",
        error: "remotePath is required",
      };
    }
    return await this.invokeDevice(deviceId, {
      action: "fs.stat",
      params: {
        path: remotePath,
        ...(opts.sha256 ? { sha256: true } : {}),
      },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  /** List active and recently finished file transfers (newest first). */
  listTransfers(): FileTransferView[] {
    const out: FileTransferView[] = [];
    for (let i = this.historyOrder.length - 1; i >= 0; i--) {
      const id = this.historyOrder[i]!;
      const view = this.views.get(id);
      if (view) out.push({ ...view });
    }
    return out;
  }

  /** Inspect one transfer by ID. */
  getTransfer(transferId: string): FileTransferView | null {
    const view = this.views.get(transferId);
    return view ? { ...view } : null;
  }

  /** Cancel an active pull or push transfer cleanly. */
  cancelTransfer(transferId: string, reason = "Cancelled by operator"): boolean {
    const pull = this.pullSessions.get(transferId);
    if (pull) {
      this.sendFileFrame(pull.deviceId, {
        v: 1,
        kind: FILE_FRAME_KIND_ABORT,
        flags: 0,
        seq: 0,
        offset: 0,
        window: 0,
        transferId,
        data: Buffer.from(reason, "utf8"),
      });
      void this.abortPullSession(pull, reason, "cancelled");
      return true;
    }

    const push = this.pushSessions.get(transferId);
    if (push) {
      push.cancelled = true;
      push.cancelReason = reason;
      this.pushSignal(push, { kind: "abort", reason });
      this.sendFileFrame(push.deviceId, {
        v: 1,
        kind: FILE_FRAME_KIND_ABORT,
        flags: 0,
        seq: 0,
        offset: 0,
        window: 0,
        transferId,
        data: Buffer.from(reason, "utf8"),
      });
      this.updateView(transferId, {
        status: "cancelled",
        error: reason,
        completedAt: nowIso(),
      });
      return true;
    }
    return false;
  }

  /** Notify active outbound push streams that the relay returned `FLAG_ERR_RATE (0x83)`. */
  notifyRateLimited(): void {
    for (const push of this.pushSessions.values()) {
      this.pushSignal(push, { kind: "rate_limited" });
    }
  }

  /** Abort all active transfers bound to a disconnected/removed Tier 1 peer. */
  failForPeer(deviceId: string, reason: string): void {
    for (const pull of Array.from(this.pullSessions.values())) {
      if (pull.deviceId === deviceId) {
        void this.abortPullSession(pull, reason, "failed");
      }
    }
    for (const push of Array.from(this.pushSessions.values())) {
      if (push.deviceId === deviceId) {
        push.cancelled = true;
        push.cancelReason = reason;
        this.pushSignal(push, { kind: "abort", reason });
      }
    }
  }

  /** Abort all active transfers on shutdown. */
  failAll(reason: string): void {
    for (const pull of Array.from(this.pullSessions.values())) {
      void this.abortPullSession(pull, reason, "failed");
    }
    for (const push of Array.from(this.pushSessions.values())) {
      push.cancelled = true;
      push.cancelReason = reason;
      this.pushSignal(push, { kind: "abort", reason });
    }
  }

  /** Decrypt and dispatch an incoming `0xE3` binary file channel envelope from `srcNodeId`. */
  handleIncomingEnvelope(srcNodeId: string, rawPayload: Uint8Array): void {
    const cfg = this.getConfig();
    if (!cfg || !cfg.enabled) return;

    let frame: FileFrame;
    try {
      frame = openFileFrame(rawPayload, cfg.e2eKey, cfg.clusterId, srcNodeId, cfg.masterNodeId);
    } catch (error) {
      this.onLogError?.(
        `Dropped invalid 0xE3 file frame from ${srcNodeId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    switch (frame.kind) {
      case FILE_FRAME_KIND_DATA:
      case FILE_FRAME_KIND_FINISH: {
        const pull = this.pullSessions.get(frame.transferId);
        if (!pull || pull.deviceId !== srcNodeId || pull.settled) {
          return;
        }
        // Serialize disk writes and finalization per transfer in strict arrival order.
        pull.queue = pull.queue
          .then(async () => {
            if (pull.settled) return;
            if (frame.kind === FILE_FRAME_KIND_DATA) {
              await this.processPullData(pull, frame);
            } else {
              await this.processPullFinish(pull, frame);
            }
          })
          .catch((error) => {
            const msg = error instanceof Error ? error.message : String(error);
            void this.abortPullSession(pull, msg, "failed");
          });
        break;
      }
      case FILE_FRAME_KIND_ACK: {
        const push = this.pushSessions.get(frame.transferId);
        if (!push || push.deviceId !== srcNodeId) return;
        this.pushSignal(push, { kind: "ack", offset: frame.offset, window: frame.window });
        break;
      }
      case FILE_FRAME_KIND_DONE: {
        const push = this.pushSessions.get(frame.transferId);
        if (!push || push.deviceId !== srcNodeId) return;
        this.pushSignal(push, { kind: "done", offset: frame.offset, sha256: frame.data });
        break;
      }
      case FILE_FRAME_KIND_ABORT: {
        const reason = utf8Decoder.decode(frame.data) || "Remote peer aborted transfer";
        const pull = this.pullSessions.get(frame.transferId);
        if (pull && pull.deviceId === srcNodeId) {
          void this.abortPullSession(pull, reason, "failed");
          return;
        }
        const push = this.pushSessions.get(frame.transferId);
        if (push && push.deviceId === srcNodeId) {
          this.pushSignal(push, { kind: "abort", reason });
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Pull (download) a file directly from a paired Tier 1 OS agent to `input.localPath` on Master Neo.
   */
  async pullFile(input: DeviceFilePullInput): Promise<DeviceFileTransferResult> {
    const cfg = this.requireConfig();
    const twin = this.requireTier1Online(input.deviceId, cfg.clusterId);
    const remotePath = input.remotePath?.trim();
    if (!remotePath || remotePath.includes("\0")) {
      throw new Error("remotePath must be a non-empty path without NUL bytes");
    }
    const rawLocalPath = input.localPath?.trim();
    if (!rawLocalPath || rawLocalPath.includes("\0")) {
      throw new Error("localPath must be a non-empty path without NUL bytes");
    }
    const localPath = path.resolve(rawLocalPath);
    const overwrite = input.overwrite !== false;
    const resume = input.resume === true;
    const chunkSize = clampChunkSize(input.chunkSize);
    const windowBytes = clampWindowBytes(input.windowBytes, chunkSize);
    const timeoutMs = Math.max(
      1_000,
      Math.min(600_000, input.timeoutMs ?? DEFAULT_FILE_TRANSFER_TIMEOUT_MS),
    );

    const transferId = input.transferId?.trim() || generateTransferId();
    validateTransferId(transferId);

    if (this.pullSessions.has(transferId) || this.pushSessions.has(transferId)) {
      throw new Error(`Transfer already active: ${transferId}`);
    }
    if (this.pullSessions.size + this.pushSessions.size >= MAX_CONCURRENT_TRANSFERS) {
      throw new Error("Too many concurrent file transfers");
    }

    if (!overwrite) {
      try {
        await fs.promises.lstat(localPath);
        throw new Error(`Local destination already exists and overwrite is false: ${localPath}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw err;
        }
      }
    } else {
      try {
        const st = await fs.promises.stat(localPath);
        if (st.isDirectory()) {
          throw new Error(`Local destination is a directory: ${localPath}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw err;
        }
      }
    }

    const localDir = path.dirname(localPath);
    await fs.promises.mkdir(localDir, { recursive: true });
    const stagingPath = path.join(localDir, `.neo-part-${transferId}`);

    let resumeOffset = 0;
    let hasher = createHash("sha256");
    if (resume) {
      try {
        const st = await fs.promises.stat(stagingPath);
        if (st.isFile() && st.size > 0) {
          const prefix = await computeLocalFilePrefixHash(stagingPath);
          resumeOffset = prefix.size;
          hasher = prefix.hasher;
        }
      } catch {
        resumeOffset = 0;
        hasher = createHash("sha256");
      }
    }

    const startedAtMs = Date.now();
    this.recordView({
      transferId,
      deviceId: twin.deviceId,
      direction: "pull",
      remotePath,
      localPath,
      status: "opening",
      protocol: "binary_e2e_v1",
      bytesTransferred: resumeOffset,
      totalBytes: 0,
      resumedFromBytes: resumeOffset,
      chunks: 0,
      startedAt: nowIso(),
      updatedAt: nowIso(),
    });

    const canBinaryRelay = Boolean(this.getRelayClient()?.isRelayConnected());
    if (!canBinaryRelay) {
      if (twin.route === "lan" && twin.lanUrl && input.allowFallback !== false) {
        return await this.pullFileViaRpcFallback({
          transferId,
          deviceId: twin.deviceId,
          remotePath,
          localPath,
          stagingPath,
          overwrite,
          resumeOffset,
          hasher,
          timeoutMs,
          startedAtMs,
        });
      }
      const errMsg = "Relay client is not connected";
      this.updateView(transferId, { status: "failed", error: errMsg, completedAt: nowIso() });
      throw new Error(errMsg);
    }

    const handle = await fs.promises.open(stagingPath, resumeOffset > 0 ? "r+" : "w");
    let resolveFn!: (res: DeviceFileTransferResult) => void;
    let rejectFn!: (err: Error) => void;
    const completion = new Promise<DeviceFileTransferResult>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const session: PullSession = {
      transferId,
      deviceId: twin.deviceId,
      remotePath,
      localPath,
      stagingPath,
      handle,
      hasher,
      receivedBytes: resumeOffset,
      resumedFromBytes: resumeOffset,
      totalBytes: null,
      chunks: 0,
      windowBytes,
      overwrite,
      startedAtMs,
      idleTimeoutMs: timeoutMs,
      idleTimer: null,
      nudgeTimer: null,
      lastActivityMs: Date.now(),
      settled: false,
      queue: Promise.resolve(),
      resolve: resolveFn,
      reject: rejectFn,
    };

    // Register BEFORE invoking `file.pull.open` so early `0xE3` DATA frames are never missed!
    this.pullSessions.set(transferId, session);
    this.resetPullIdleTimer(session);

    const openRes = await this.invokeDevice(twin.deviceId, {
      action: "file.pull.open",
      params: {
        transfer_id: transferId,
        path: remotePath,
        offset: resumeOffset,
        chunk_size: chunkSize,
        window_bytes: windowBytes,
      },
      timeoutMs: Math.min(timeoutMs, 30_000),
    });

    if (openRes.status !== "ok") {
      const errText =
        openRes.status === "rejected"
          ? openRes.error
          : `file.pull.open did not execute immediately (status=${openRes.status})`;
      await this.cleanupPullSession(session, true);
      if (
        openRes.status === "rejected" &&
        isUnsupportedRpcError(openRes.error) &&
        input.allowFallback !== false
      ) {
        return await this.pullFileViaRpcFallback({
          transferId,
          deviceId: twin.deviceId,
          remotePath,
          localPath,
          stagingPath,
          overwrite,
          resumeOffset: 0,
          hasher: createHash("sha256"),
          timeoutMs,
          startedAtMs,
        });
      }
      this.updateView(transferId, { status: "failed", error: errText, completedAt: nowIso() });
      throw new Error(errText);
    }

    const meta = isRecord(openRes.result) ? openRes.result : {};
    const remoteSize = typeof meta.size === "number" ? meta.size : null;
    const canonicalRemotePath =
      typeof meta.path === "string" && meta.path.length > 0 ? meta.path : remotePath;
    if (!session.settled) {
      if (remoteSize !== null) {
        session.totalBytes = remoteSize;
      }
      session.remotePath = canonicalRemotePath;
      this.updateView(transferId, {
        status: "transferring",
        remotePath: canonicalRemotePath,
        ...(remoteSize !== null ? { totalBytes: remoteSize } : {}),
      });

      // Periodic nudge ACK if incoming frames stall (triggers go-back-N resend on Tier 1).
      session.nudgeTimer = setInterval(() => {
        if (session.settled) return;
        if (Date.now() - session.lastActivityMs >= PULL_STALL_NUDGE_MS) {
          this.sendFileFrame(session.deviceId, {
            v: 1,
            kind: FILE_FRAME_KIND_ACK,
            flags: 0,
            seq: session.chunks,
            offset: session.receivedBytes,
            window: session.windowBytes,
            transferId: session.transferId,
            data: new Uint8Array(0),
          });
        }
      }, Math.min(PULL_STALL_NUDGE_MS, Math.max(500, Math.floor(timeoutMs / 4))));
    }

    return await completion;
  }

  /**
   * Push (upload) a local file on Master Neo directly to `input.remotePath` on a paired Tier 1 OS agent.
   */
  async pushFile(input: DeviceFilePushInput): Promise<DeviceFileTransferResult> {
    const cfg = this.requireConfig();
    const twin = this.requireTier1Online(input.deviceId, cfg.clusterId);
    const rawLocalPath = input.localPath?.trim();
    if (!rawLocalPath || rawLocalPath.includes("\0")) {
      throw new Error("localPath must be a non-empty path without NUL bytes");
    }
    const remotePath = input.remotePath?.trim();
    if (!remotePath || remotePath.includes("\0")) {
      throw new Error("remotePath must be a non-empty path without NUL bytes");
    }
    const localPath = path.resolve(rawLocalPath);
    const localStat = await fs.promises.stat(localPath);
    if (!localStat.isFile()) {
      throw new Error(`localPath is not a regular file: ${localPath}`);
    }
    const totalSize = localStat.size;

    const overwrite = input.overwrite !== false;
    const resume = input.resume === true;
    const reqChunkSize = clampChunkSize(input.chunkSize);
    const reqWindowBytes = clampWindowBytes(input.windowBytes, reqChunkSize);
    const timeoutMs = Math.max(
      1_000,
      Math.min(600_000, input.timeoutMs ?? DEFAULT_FILE_TRANSFER_TIMEOUT_MS),
    );
    const transferId = input.transferId?.trim() || generateTransferId();
    validateTransferId(transferId);

    if (this.pullSessions.has(transferId) || this.pushSessions.has(transferId)) {
      throw new Error(`Transfer already active: ${transferId}`);
    }
    if (this.pullSessions.size + this.pushSessions.size >= MAX_CONCURRENT_TRANSFERS) {
      throw new Error("Too many concurrent file transfers");
    }

    const startedAtMs = Date.now();
    this.recordView({
      transferId,
      deviceId: twin.deviceId,
      direction: "push",
      remotePath,
      localPath,
      status: "opening",
      protocol: "binary_e2e_v1",
      bytesTransferred: 0,
      totalBytes: totalSize,
      resumedFromBytes: 0,
      chunks: 0,
      startedAt: nowIso(),
      updatedAt: nowIso(),
    });

    const canBinaryRelay = Boolean(this.getRelayClient()?.isRelayConnected());
    if (!canBinaryRelay) {
      if (twin.route === "lan" && twin.lanUrl && input.allowFallback !== false) {
        return await this.pushFileViaRpcFallback({
          transferId,
          deviceId: twin.deviceId,
          localPath,
          remotePath,
          totalSize,
          timeoutMs,
          startedAtMs,
        });
      }
      const errMsg = "Relay client is not connected";
      this.updateView(transferId, { status: "failed", error: errMsg, completedAt: nowIso() });
      throw new Error(errMsg);
    }

    const session: PushSession = {
      transferId,
      deviceId: twin.deviceId,
      signals: [],
      waiter: null,
      cancelled: false,
    };
    this.pushSessions.set(transferId, session);

    try {
      const openRes = await this.invokeDevice(twin.deviceId, {
        action: "file.push.open",
        params: {
          transfer_id: transferId,
          path: remotePath,
          size: totalSize,
          chunk_size: reqChunkSize,
          window_bytes: reqWindowBytes,
          overwrite,
          resume,
        },
        timeoutMs: Math.min(timeoutMs, 30_000),
      });

      if (openRes.status !== "ok") {
        const errText =
          openRes.status === "rejected"
            ? openRes.error
            : `file.push.open did not execute immediately (status=${openRes.status})`;
        if (
          openRes.status === "rejected" &&
          isUnsupportedRpcError(openRes.error) &&
          input.allowFallback !== false
        ) {
          this.pushSessions.delete(transferId);
          return await this.pushFileViaRpcFallback({
            transferId,
            deviceId: twin.deviceId,
            localPath,
            remotePath,
            totalSize,
            timeoutMs,
            startedAtMs,
          });
        }
        this.updateView(transferId, { status: "failed", error: errText, completedAt: nowIso() });
        throw new Error(errText);
      }

      const meta = isRecord(openRes.result) ? openRes.result : {};
      const canonicalRemotePath =
        typeof meta.path === "string" && meta.path.length > 0 ? meta.path : remotePath;
      const resumeOffset =
        typeof meta.resume_offset === "number" &&
        Number.isInteger(meta.resume_offset) &&
        meta.resume_offset >= 0 &&
        meta.resume_offset <= totalSize
          ? meta.resume_offset
          : 0;
      const chunkSize = clampChunkSize(
        typeof meta.chunk_size === "number" ? meta.chunk_size : reqChunkSize,
      );
      let peerWindow = clampWindowBytes(
        typeof meta.window_bytes === "number" ? meta.window_bytes : reqWindowBytes,
        chunkSize,
      );

      this.updateView(transferId, {
        status: "transferring",
        remotePath: canonicalRemotePath,
        resumedFromBytes: resumeOffset,
        bytesTransferred: resumeOffset,
      });

      // Hash prefix [0..resumeOffset) so FINISH carries full-file SHA-256 even on resume.
      const hasher = createHash("sha256");
      let hashedOffset = 0;
      const handle = await fs.promises.open(localPath, "r");
      try {
        if (resumeOffset > 0) {
          const preBuf = Buffer.allocUnsafe(64 * 1024);
          while (hashedOffset < resumeOffset) {
            const want = Math.min(preBuf.byteLength, resumeOffset - hashedOffset);
            const { bytesRead } = await handle.read(preBuf, 0, want, hashedOffset);
            if (bytesRead === 0) {
              throw new Error("Unexpected EOF while hashing push resume prefix");
            }
            hasher.update(preBuf.subarray(0, bytesRead));
            hashedOffset += bytesRead;
          }
        }

        let sendOffset = resumeOffset;
        let ackedOffset = resumeOffset;
        let effectiveWindow = peerWindow;
        let pacingDelayMs = 0;
        let seq = 0;
        let chunks = 0;
        let stallRetries = 0;
        const readBuf = Buffer.allocUnsafe(chunkSize);
        const deadlineMs = Date.now() + timeoutMs;

        while (ackedOffset < totalSize) {
          if (session.cancelled) {
            throw new Error(session.cancelReason || "Transfer cancelled");
          }
          if (Date.now() > deadlineMs) {
            throw new Error(`Push transfer timed out after ${timeoutMs}ms`);
          }

          // Drain queued signals before sending next chunk.
          while (session.signals.length > 0) {
            const sig = session.signals.shift()!;
            if (sig.kind === "abort") {
              throw new Error(sig.reason);
            }
            if (sig.kind === "done") {
              ackedOffset = totalSize;
              break;
            }
            if (sig.kind === "rate_limited") {
              pacingDelayMs = pacingDelayMs === 0 ? 200 : Math.min(2000, pacingDelayMs * 2);
              effectiveWindow = chunkSize;
              sendOffset = ackedOffset;
              continue;
            }
            if (sig.kind === "ack") {
              if (sig.window > 0) {
                peerWindow = Math.max(chunkSize, sig.window);
              }
              if (sig.offset > ackedOffset) {
                ackedOffset = Math.min(totalSize, sig.offset);
                stallRetries = 0;
                pacingDelayMs = Math.floor(pacingDelayMs / 2);
                effectiveWindow = Math.min(peerWindow, effectiveWindow + chunkSize);
                this.updateView(transferId, { bytesTransferred: ackedOffset, chunks });
              } else if (sig.offset < sendOffset) {
                // Gap reported by receiver (e.g. relay dropped a chunk); rewind cleanly.
                sendOffset = sig.offset;
                effectiveWindow = chunkSize;
              }
            }
          }

          if (ackedOffset >= totalSize) break;

          const inFlight = sendOffset - ackedOffset;
          if (sendOffset < totalSize && inFlight < effectiveWindow) {
            if (pacingDelayMs > 0) {
              await sleepMs(pacingDelayMs);
            }
            const want = Math.min(chunkSize, totalSize - sendOffset);
            const { bytesRead } = await handle.read(readBuf, 0, want, sendOffset);
            if (bytesRead === 0) {
              throw new Error("Unexpected EOF while streaming local file for push");
            }
            const chunkStart = sendOffset;
            const chunkEnd = chunkStart + bytesRead;
            const chunkSlice = new Uint8Array(bytesRead);
            chunkSlice.set(readBuf.subarray(0, bytesRead));

            if (chunkEnd > hashedOffset) {
              const freshStart = Math.max(0, hashedOffset - chunkStart);
              if (freshStart < bytesRead) {
                hasher.update(chunkSlice.subarray(freshStart));
              }
              hashedOffset = chunkEnd;
            }

            const sent = this.sendFileFrame(twin.deviceId, {
              v: 1,
              kind: FILE_FRAME_KIND_DATA,
              flags: 0,
              seq: seq >>> 0,
              offset: chunkStart,
              window: 0,
              transferId,
              data: chunkSlice,
            });
            if (!sent) {
              throw new Error("Failed to send 0xE3 DATA frame (relay disconnected)");
            }
            seq = (seq + 1) >>> 0;
            chunks += 1;
            sendOffset = chunkEnd;
            continue;
          }

          const remainingMs = Math.max(100, deadlineMs - Date.now());
          const sig = await this.waitForPushSignal(
            session,
            Math.min(PUSH_STALL_TIMEOUT_MS, remainingMs),
          );
          if (sig === null) {
            stallRetries += 1;
            if (stallRetries > PUSH_MAX_STALL_RETRIES || Date.now() > deadlineMs) {
              throw new Error("Push transfer timed out waiting for receiver ACK");
            }
            sendOffset = ackedOffset;
            effectiveWindow = chunkSize;
            continue;
          }
          // Re-queue signal to handle via unified drain branch at loop top.
          session.signals.unshift(sig);
        }

        const digestBuf = hasher.digest();
        const digestBytes = new Uint8Array(
          digestBuf.buffer,
          digestBuf.byteOffset,
          digestBuf.byteLength,
        );
        const sha256Hex = digestBuf.toString("hex");

        // Send FINISH and await DONE with bounded retries.
        let verifiedDone = false;
        for (let attempt = 0; attempt <= PUSH_MAX_FINISH_RETRIES; attempt++) {
          if (session.cancelled) {
            throw new Error(session.cancelReason || "Transfer cancelled");
          }
          const sentFinish = this.sendFileFrame(twin.deviceId, {
            v: 1,
            kind: FILE_FRAME_KIND_FINISH,
            flags: 0,
            seq: seq >>> 0,
            offset: totalSize,
            window: 0,
            transferId,
            data: digestBytes,
          });
          if (!sentFinish) {
            throw new Error("Failed to send 0xE3 FINISH frame");
          }

          const waitUntil = Date.now() + Math.min(PUSH_DONE_TIMEOUT_MS, Math.max(200, deadlineMs - Date.now()));
          while (Date.now() < waitUntil) {
            const sig = await this.waitForPushSignal(session, Math.max(50, waitUntil - Date.now()));
            if (sig === null) break;
            if (sig.kind === "abort") {
              throw new Error(sig.reason);
            }
            if (sig.kind === "done") {
              if (
                sig.offset !== totalSize ||
                sig.sha256.byteLength !== 32 ||
                !timingSafeEqual(sig.sha256, digestBytes)
              ) {
                throw new Error("Remote DONE SHA-256/size verification mismatch");
              }
              verifiedDone = true;
              break;
            }
          }
          if (verifiedDone) break;
          if (attempt === PUSH_MAX_FINISH_RETRIES) {
            throw new Error("Push transfer timed out waiting for receiver DONE");
          }
        }

        const durationMs = Math.max(1, Date.now() - startedAtMs);
        const bytesSentNow = totalSize - resumeOffset;
        const result: DeviceFileTransferResult = {
          transferId,
          deviceId: twin.deviceId,
          direction: "push",
          remotePath: canonicalRemotePath,
          localPath,
          bytesTransferred: totalSize,
          totalBytes: totalSize,
          resumedFromBytes: resumeOffset,
          chunks,
          sha256: sha256Hex,
          durationMs,
          throughputBytesPerSec: Math.round((bytesSentNow * 1000) / durationMs),
          protocol: "binary_e2e_v1",
        };
        this.updateView(transferId, {
          status: "completed",
          bytesTransferred: totalSize,
          totalBytes: totalSize,
          chunks,
          sha256: sha256Hex,
          completedAt: nowIso(),
        });
        return result;
      } finally {
        await handle.close();
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (!session.cancelled) {
        this.sendFileFrame(twin.deviceId, {
          v: 1,
          kind: FILE_FRAME_KIND_ABORT,
          flags: 0,
          seq: 0,
          offset: 0,
          window: 0,
          transferId,
          data: Buffer.from(errMsg, "utf8"),
        });
        this.updateView(transferId, {
          status: "failed",
          error: errMsg,
          completedAt: nowIso(),
        });
      }
      throw error;
    } finally {
      this.pushSessions.delete(transferId);
    }
  }

  private async processPullData(session: PullSession, frame: FileFrame): Promise<void> {
    session.lastActivityMs = Date.now();
    this.resetPullIdleTimer(session);

    if (frame.offset === session.receivedBytes) {
      if (session.totalBytes !== null && frame.offset + frame.data.byteLength > session.totalBytes) {
        const reason = `Received chunk exceeds declared size (${frame.offset + frame.data.byteLength} > ${session.totalBytes})`;
        this.sendAbortFrame(session.deviceId, session.transferId, reason);
        await this.abortPullSession(session, reason, "failed");
        return;
      }
      if (!session.handle) {
        throw new Error("Local pull staging handle closed");
      }
      if (frame.data.byteLength > 0) {
        await session.handle.write(frame.data, 0, frame.data.byteLength, frame.offset);
        session.hasher.update(frame.data);
        session.receivedBytes += frame.data.byteLength;
      }
      session.chunks += 1;
      this.updateView(session.transferId, {
        status: "transferring",
        bytesTransferred: session.receivedBytes,
        chunks: session.chunks,
      });
    }

    // Cumulative ACK advances sender window (or triggers go-back-N rewind on gap).
    this.sendFileFrame(session.deviceId, {
      v: 1,
      kind: FILE_FRAME_KIND_ACK,
      flags: 0,
      seq: frame.seq,
      offset: session.receivedBytes,
      window: session.windowBytes,
      transferId: session.transferId,
      data: new Uint8Array(0),
    });
  }

  private async processPullFinish(session: PullSession, frame: FileFrame): Promise<void> {
    session.lastActivityMs = Date.now();
    if (frame.data.byteLength !== 32) {
      const reason = `FINISH frame missing 32-byte SHA-256 (got ${frame.data.byteLength} bytes)`;
      this.sendAbortFrame(session.deviceId, session.transferId, reason);
      await this.abortPullSession(session, reason, "failed");
      return;
    }
    const expectedTotal = session.totalBytes ?? frame.offset;
    if (frame.offset !== expectedTotal || session.receivedBytes !== expectedTotal) {
      const reason = `Pull size mismatch on FINISH: received=${session.receivedBytes}, finish=${frame.offset}, expected=${expectedTotal}`;
      this.sendAbortFrame(session.deviceId, session.transferId, reason);
      await this.abortPullSession(session, reason, "failed");
      return;
    }

    const actualBuf = session.hasher.digest();
    const actualBytes = new Uint8Array(actualBuf.buffer, actualBuf.byteOffset, actualBuf.byteLength);
    if (!timingSafeEqual(actualBytes, frame.data)) {
      const reason = `Pull SHA-256 mismatch: expected ${Buffer.from(frame.data).toString("hex")}, got ${actualBuf.toString("hex")}`;
      this.sendAbortFrame(session.deviceId, session.transferId, reason);
      await this.abortPullSession(session, reason, "failed");
      return;
    }

    if (session.handle) {
      await session.handle.sync().catch(() => {});
      await session.handle.close();
      session.handle = null;
    }

    if (!session.overwrite) {
      try {
        await fs.promises.lstat(session.localPath);
        const reason = `Local destination already exists and overwrite is false: ${session.localPath}`;
        this.sendAbortFrame(session.deviceId, session.transferId, reason);
        await this.abortPullSession(session, reason, "failed");
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw err;
        }
      }
    }

    await fs.promises.rename(session.stagingPath, session.localPath);

    this.sendFileFrame(session.deviceId, {
      v: 1,
      kind: FILE_FRAME_KIND_DONE,
      flags: 0,
      seq: frame.seq,
      offset: expectedTotal,
      window: 0,
      transferId: session.transferId,
      data: actualBytes,
    });

    const sha256Hex = actualBuf.toString("hex");
    const durationMs = Math.max(1, Date.now() - session.startedAtMs);
    const transferredNow = expectedTotal - session.resumedFromBytes;
    const result: DeviceFileTransferResult = {
      transferId: session.transferId,
      deviceId: session.deviceId,
      direction: "pull",
      remotePath: session.remotePath,
      localPath: session.localPath,
      bytesTransferred: expectedTotal,
      totalBytes: expectedTotal,
      resumedFromBytes: session.resumedFromBytes,
      chunks: session.chunks,
      sha256: sha256Hex,
      durationMs,
      throughputBytesPerSec: Math.round((transferredNow * 1000) / durationMs),
      protocol: "binary_e2e_v1",
    };

    session.settled = true;
    this.clearPullTimers(session);
    this.pullSessions.delete(session.transferId);
    this.updateView(session.transferId, {
      status: "completed",
      bytesTransferred: expectedTotal,
      totalBytes: expectedTotal,
      chunks: session.chunks,
      sha256: sha256Hex,
      completedAt: nowIso(),
    });
    session.resolve(result);
  }

  private async pullFileViaRpcFallback(opts: {
    transferId: string;
    deviceId: string;
    remotePath: string;
    localPath: string;
    stagingPath: string;
    overwrite: boolean;
    resumeOffset: number;
    hasher: Hash;
    timeoutMs: number;
    startedAtMs: number;
  }): Promise<DeviceFileTransferResult> {
    this.updateView(opts.transferId, {
      status: "transferring",
      protocol: "rpc_fallback",
    });

    const handle = await fs.promises.open(opts.stagingPath, opts.resumeOffset > 0 ? "r+" : "w");
    let offset = opts.resumeOffset;
    let totalBytes = 0;
    let chunks = 0;
    let canonicalRemotePath = opts.remotePath;
    try {
      while (true) {
        const res = await this.invokeDevice(opts.deviceId, {
          action: "fs_read",
          params: {
            path: opts.remotePath,
            offset,
            limit: FALLBACK_RPC_CHUNK_BYTES,
          },
          timeoutMs: Math.min(opts.timeoutMs, 30_000),
        });
        if (res.status !== "ok") {
          const err = res.status === "rejected" ? res.error : `fs_read returned ${res.status}`;
          throw new Error(err);
        }
        const body = isRecord(res.result) ? res.result : {};
        if (typeof body.path === "string" && body.path.length > 0) {
          canonicalRemotePath = body.path;
        }
        if (typeof body.size === "number") {
          totalBytes = body.size;
        }
        const b64 = typeof body.content_b64 === "string" ? body.content_b64 : "";
        const chunk = Buffer.from(b64, "base64");
        if (chunk.byteLength > 0) {
          await handle.write(chunk, 0, chunk.byteLength, offset);
          opts.hasher.update(chunk);
          offset += chunk.byteLength;
          chunks += 1;
        }
        this.updateView(opts.transferId, {
          remotePath: canonicalRemotePath,
          bytesTransferred: offset,
          totalBytes,
          chunks,
        });
        if (body.eof === true || chunk.byteLength === 0 || offset >= totalBytes) {
          break;
        }
      }
      await handle.sync().catch(() => {});
      await handle.close();
      await fs.promises.rename(opts.stagingPath, opts.localPath);

      const sha256Hex = opts.hasher.digest("hex");
      const durationMs = Math.max(1, Date.now() - opts.startedAtMs);
      const result: DeviceFileTransferResult = {
        transferId: opts.transferId,
        deviceId: opts.deviceId,
        direction: "pull",
        remotePath: canonicalRemotePath,
        localPath: opts.localPath,
        bytesTransferred: offset,
        totalBytes: offset,
        resumedFromBytes: opts.resumeOffset,
        chunks,
        sha256: sha256Hex,
        durationMs,
        throughputBytesPerSec: Math.round(((offset - opts.resumeOffset) * 1000) / durationMs),
        protocol: "rpc_fallback",
      };
      this.updateView(opts.transferId, {
        status: "completed",
        bytesTransferred: offset,
        totalBytes: offset,
        chunks,
        sha256: sha256Hex,
        completedAt: nowIso(),
      });
      return result;
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.promises.rm(opts.stagingPath, { force: true }).catch(() => {});
      const errMsg = error instanceof Error ? error.message : String(error);
      this.updateView(opts.transferId, { status: "failed", error: errMsg, completedAt: nowIso() });
      throw error;
    }
  }

  private async pushFileViaRpcFallback(opts: {
    transferId: string;
    deviceId: string;
    localPath: string;
    remotePath: string;
    totalSize: number;
    timeoutMs: number;
    startedAtMs: number;
  }): Promise<DeviceFileTransferResult> {
    this.updateView(opts.transferId, {
      status: "transferring",
      protocol: "rpc_fallback",
    });

    const fullHash = (await computeLocalFilePrefixHash(opts.localPath)).hasher.digest("hex");
    const handle = await fs.promises.open(opts.localPath, "r");
    let offset = 0;
    let chunks = 0;
    let canonicalRemotePath = opts.remotePath;
    try {
      const readBuf = Buffer.allocUnsafe(FALLBACK_RPC_CHUNK_BYTES);
      while (true) {
        const want = Math.min(FALLBACK_RPC_CHUNK_BYTES, opts.totalSize - offset);
        const bytesRead =
          want > 0 ? (await handle.read(readBuf, 0, want, offset)).bytesRead : 0;
        const slice = readBuf.subarray(0, bytesRead);
        const eof = offset + bytesRead >= opts.totalSize;
        const chunkSha = createHash("sha256").update(slice).digest("hex");
        const res = await this.invokeDevice(opts.deviceId, {
          action: "transfer_chunk",
          params: {
            transfer_id: opts.transferId,
            path: opts.remotePath,
            offset,
            chunk_b64: slice.toString("base64"),
            chunk_sha256: chunkSha,
            ...(eof ? { final_sha256: fullHash } : {}),
            eof,
          },
          timeoutMs: Math.min(opts.timeoutMs, 30_000),
        });
        if (res.status !== "ok") {
          const err =
            res.status === "rejected" ? res.error : `transfer_chunk returned ${res.status}`;
          throw new Error(err);
        }
        const body = isRecord(res.result) ? res.result : {};
        if (typeof body.path === "string" && body.path.length > 0) {
          canonicalRemotePath = body.path;
        }
        offset += bytesRead;
        chunks += 1;
        this.updateView(opts.transferId, {
          remotePath: canonicalRemotePath,
          bytesTransferred: offset,
          totalBytes: opts.totalSize,
          chunks,
        });
        if (eof) break;
      }

      const durationMs = Math.max(1, Date.now() - opts.startedAtMs);
      const result: DeviceFileTransferResult = {
        transferId: opts.transferId,
        deviceId: opts.deviceId,
        direction: "push",
        remotePath: canonicalRemotePath,
        localPath: opts.localPath,
        bytesTransferred: opts.totalSize,
        totalBytes: opts.totalSize,
        resumedFromBytes: 0,
        chunks,
        sha256: fullHash,
        durationMs,
        throughputBytesPerSec: Math.round((opts.totalSize * 1000) / durationMs),
        protocol: "rpc_fallback",
      };
      this.updateView(opts.transferId, {
        status: "completed",
        bytesTransferred: opts.totalSize,
        totalBytes: opts.totalSize,
        chunks,
        sha256: fullHash,
        completedAt: nowIso(),
      });
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.updateView(opts.transferId, { status: "failed", error: errMsg, completedAt: nowIso() });
      throw error;
    } finally {
      await handle.close();
    }
  }

  private resetPullIdleTimer(session: PullSession): void {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
    }
    session.idleTimer = setTimeout(() => {
      if (session.settled) return;
      const reason = `Pull transfer timed out after ${session.idleTimeoutMs}ms without progress`;
      this.sendAbortFrame(session.deviceId, session.transferId, reason);
      void this.abortPullSession(session, reason, "failed");
    }, session.idleTimeoutMs);
  }

  private clearPullTimers(session: PullSession): void {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.nudgeTimer !== null) {
      clearInterval(session.nudgeTimer);
      session.nudgeTimer = null;
    }
  }

  private async cleanupPullSession(session: PullSession, removeStaging: boolean): Promise<void> {
    this.clearPullTimers(session);
    this.pullSessions.delete(session.transferId);
    if (session.handle) {
      await session.handle.close().catch(() => {});
      session.handle = null;
    }
    if (removeStaging) {
      await fs.promises.rm(session.stagingPath, { force: true }).catch(() => {});
    }
  }

  private async abortPullSession(
    session: PullSession,
    reason: string,
    status: "failed" | "cancelled",
  ): Promise<void> {
    if (session.settled) return;
    session.settled = true;
    await this.cleanupPullSession(session, true);
    this.updateView(session.transferId, {
      status,
      error: reason,
      completedAt: nowIso(),
    });
    session.reject(new Error(reason));
  }

  private pushSignal(session: PushSession, signal: PushSignal): void {
    session.signals.push(signal);
    if (session.waiter) {
      const wake = session.waiter;
      session.waiter = null;
      wake();
    }
  }

  private waitForPushSignal(session: PushSession, timeoutMs: number): Promise<PushSignal | null> {
    if (session.signals.length > 0) {
      return Promise.resolve(session.signals.shift()!);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (session.waiter === wake) {
          session.waiter = null;
        }
        resolve(null);
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        resolve(session.signals.shift() ?? null);
      };
      session.waiter = wake;
    });
  }

  private sendFileFrame(dstDeviceId: string, frame: FileFrame): boolean {
    const cfg = this.getConfig();
    const client = this.getRelayClient();
    if (!cfg || !client || !client.isRelayConnected()) {
      return false;
    }
    const wire = sealFileFrame(frame, cfg.e2eKey, cfg.clusterId, cfg.masterNodeId, dstDeviceId);
    return client.sendData(dstDeviceId, wire);
  }

  private sendAbortFrame(dstDeviceId: string, transferId: string, reason: string): void {
    this.sendFileFrame(dstDeviceId, {
      v: 1,
      kind: FILE_FRAME_KIND_ABORT,
      flags: 0,
      seq: 0,
      offset: 0,
      window: 0,
      transferId,
      data: Buffer.from(reason, "utf8"),
    });
  }

  private recordView(view: FileTransferView): void {
    this.views.set(view.transferId, view);
    const existingIdx = this.historyOrder.indexOf(view.transferId);
    if (existingIdx >= 0) {
      this.historyOrder.splice(existingIdx, 1);
    }
    this.historyOrder.push(view.transferId);
    while (this.historyOrder.length > MAX_HISTORY_RECORDS) {
      const oldest = this.historyOrder.shift()!;
      if (!this.pullSessions.has(oldest) && !this.pushSessions.has(oldest)) {
        this.views.delete(oldest);
      }
    }
  }

  private updateView(transferId: string, patch: Partial<FileTransferView>): void {
    const cur = this.views.get(transferId);
    if (!cur) return;
    this.views.set(transferId, { ...cur, ...patch, updatedAt: nowIso() });
  }

  private requireConfig(): DeviceConfig {
    const cfg = this.getConfig();
    if (!cfg || !cfg.enabled) {
      throw new Error("Device control plane is not configured or enabled");
    }
    return cfg;
  }

  private requireTier1Online(deviceId: string, localClusterId: string): DeviceTwin {
    const twin = this.getDevice(deviceId);
    if (!twin) {
      throw new Error(`Unknown device: ${deviceId}`);
    }
    if (twin.clusterId !== localClusterId) {
      throw new Error(
        `Cross-cluster file transfer rejected (${twin.clusterId} !== ${localClusterId})`,
      );
    }
    if (twin.tier !== "os") {
      throw new Error(
        `Direct file transfer requires Tier 1 'os' agent (device '${deviceId}' is tier '${twin.tier}')`,
      );
    }
    if (twin.status === "offline") {
      throw new Error(`Device ${deviceId} is offline`);
    }
    return twin;
  }
}

export type { DeviceFileStat };
