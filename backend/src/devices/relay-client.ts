/**
 * Pure TypeScript `neo-relay` client using built-in `fetch` and `WebSocket`:
 * - `GET /v1/bootstrap` & `GET /v1/peers`
 * - `WS /v1/signal` (`registered`, `heartbeat`, `p2p_offer`, `p2p_answer`, `p2p_punch`, `p2p_unavailable`, `relay_fallback`)
 * - `WS /v1/relay` (10-byte binary frames, Ping/Pong, `0x81`/`0x82`/`0x83` error handling, auto-reconnect)
 */

import { decodeRelayFrame, encodeRelayFrame } from "./protocol.ts";
import {
  FLAG_DATA,
  FLAG_ERR_OFFLINE,
  FLAG_ERR_RATE,
  FLAG_ERR_SPOOFED,
  FLAG_PING,
  FLAG_PONG,
  type RelayBootstrapResponse,
  type RelayConnectionState,
  type RelayFrame,
  type SignalMessage,
} from "./types.ts";

const utf8Decoder = new TextDecoder("utf-8");

/** Minimal WebSocket surface required by `RelayClient` (matches built-in `WebSocket` and test mocks). */
export interface RelaySocket {
  readonly readyState: number;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface RelayErrorEvent {
  code: number;
  src: string;
  dst: string;
  reason: string;
}

export interface RelayClientOptions {
  relayUrl: string;
  clusterId: string;
  nodeId: string;
  tokenProvider: () => string;
  fetchFn?: typeof fetch;
  wsFactory?: (url: string, headers: Record<string, string>) => RelaySocket;
  pingIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onFrame?: (frame: RelayFrame) => void;
  onSignal?: (msg: SignalMessage) => void;
  onRelayError?: (err: RelayErrorEvent) => void;
  onStateChange?: (state: RelayConnectionState) => void;
  onLogError?: (message: string) => void;
}

const WS_OPEN = 1;

function normalizeHttpBase(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("ws://")) return `http://${trimmed.slice(5)}`;
  if (trimmed.startsWith("wss://")) return `https://${trimmed.slice(6)}`;
  return trimmed;
}

function toWsUrl(httpOrWsUrl: string, pathSuffix: string): string {
  const base = normalizeHttpBase(httpOrWsUrl);
  const wsBase = base.startsWith("https://")
    ? `wss://${base.slice("https://".length)}`
    : base.startsWith("http://")
      ? `ws://${base.slice("http://".length)}`
      : base;
  return `${wsBase}${pathSuffix}`;
}

function resolveEndpointUrl(baseUrl: string, candidate: string | undefined, defaultPath: string): string {
  if (candidate && (candidate.startsWith("ws://") || candidate.startsWith("wss://"))) {
    return candidate;
  }
  if (candidate && candidate.startsWith("/")) {
    return toWsUrl(baseUrl, candidate);
  }
  return toWsUrl(baseUrl, defaultPath);
}

function defaultWsFactory(url: string, headers: Record<string, string>): RelaySocket {
  const ws = new WebSocket(url, { headers });
  ws.binaryType = "arraybuffer";
  return ws as unknown as RelaySocket;
}

async function toUint8Array(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return null;
}

/**
 * Resilient client for `neo-relayd` (`/v1/bootstrap`, `/v1/signal`, `/v1/relay`).
 */
export class RelayClient {
  private readonly httpBase: string;
  private readonly clusterId: string;
  private readonly nodeId: string;
  private readonly tokenProvider: () => string;
  private readonly fetchFn: typeof fetch;
  private readonly wsFactory: (url: string, headers: Record<string, string>) => RelaySocket;
  private readonly pingIntervalMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  private readonly onFrame?: (frame: RelayFrame) => void;
  private readonly onSignal?: (msg: SignalMessage) => void;
  private readonly onRelayError?: (err: RelayErrorEvent) => void;
  private readonly onStateChange?: (state: RelayConnectionState) => void;
  private readonly onLogError?: (message: string) => void;

  private signalWs: RelaySocket | null = null;
  private relayWs: RelaySocket | null = null;
  private bootstrapInfo: RelayBootstrapResponse | null = null;
  private state: RelayConnectionState = "idle";
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAtMs = 0;
  private readonly peerRoutes = new Map<string, "p2p" | "relay">();

  constructor(options: RelayClientOptions) {
    this.httpBase = normalizeHttpBase(options.relayUrl);
    this.clusterId = options.clusterId;
    this.nodeId = options.nodeId;
    this.tokenProvider = options.tokenProvider;
    this.fetchFn = options.fetchFn ?? fetch;
    this.wsFactory = options.wsFactory ?? defaultWsFactory;
    this.pingIntervalMs = options.pingIntervalMs ?? 25_000;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.onFrame = options.onFrame;
    this.onSignal = options.onSignal;
    this.onRelayError = options.onRelayError;
    this.onStateChange = options.onStateChange;
    this.onLogError = options.onLogError;
  }

  getState(): RelayConnectionState {
    return this.state;
  }

  isRelayConnected(): boolean {
    return this.relayWs !== null && this.relayWs.readyState === WS_OPEN;
  }

  isSignalConnected(): boolean {
    return this.signalWs !== null && this.signalWs.readyState === WS_OPEN;
  }

  getLastPongAtMs(): number {
    return this.lastPongAtMs;
  }

  getBootstrapInfo(): RelayBootstrapResponse | null {
    return this.bootstrapInfo;
  }

  getPeerRouteHint(peerId: string): "p2p" | "relay" | undefined {
    return this.peerRoutes.get(peerId);
  }

  private setState(next: RelayConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange?.(next);
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.tokenProvider()}`,
    };
  }

  /** Fetch `GET /v1/bootstrap` from `neo-relayd`. */
  async fetchBootstrap(): Promise<RelayBootstrapResponse> {
    const res = await this.fetchFn(`${this.httpBase}/v1/bootstrap`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Bootstrap failed with HTTP ${res.status}`);
    }
    const parsed = (await res.json()) as RelayBootstrapResponse;
    this.bootstrapInfo = parsed;
    return parsed;
  }

  /** Fetch `GET /v1/peers` from `neo-relayd` (cluster-scoped peer discovery). */
  async fetchPeers(): Promise<unknown> {
    const res = await this.fetchFn(`${this.httpBase}/v1/peers`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Peers query failed with HTTP ${res.status}`);
    }
    return await res.json();
  }

  /** Connect to `/v1/bootstrap` (best effort), `/v1/signal`, and `/v1/relay`. */
  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("RelayClient is closed");
    }
    this.clearTimers();
    this.setState("connecting");

    let bootstrap: RelayBootstrapResponse | null = null;
    try {
      bootstrap = await this.fetchBootstrap();
    } catch (error) {
      this.onLogError?.(
        `Relay bootstrap skipped/failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (this.closed) return;

    const signalUrl = resolveEndpointUrl(
      this.httpBase,
      bootstrap?.signal_ws_url ?? bootstrap?.signal_url,
      "/v1/signal",
    );
    const relayUrl = resolveEndpointUrl(
      this.httpBase,
      bootstrap?.relay_ws_url ?? bootstrap?.relay_url,
      "/v1/relay",
    );

    const openRelayPromise = this.openRelaySocket(relayUrl);
    this.openSignalSocket(signalUrl);
    await openRelayPromise;
  }

  private openSignalSocket(url: string): void {
    if (this.closed) return;
    try {
      this.signalWs?.close(1000, "reconnecting");
    } catch {
      // Ignore close error
    }
    const ws = this.wsFactory(url, this.authHeaders());
    this.signalWs = ws;

    ws.onopen = () => {
      if (this.closed || this.signalWs !== ws) return;
      this.sendSignal({
        type: "heartbeat",
        cluster_id: this.clusterId,
        node_id: this.nodeId,
        ts_ms: Date.now(),
      });
    };

    ws.onmessage = (event) => {
      if (this.closed || this.signalWs !== ws) return;
      if (typeof event.data !== "string") return;
      try {
        const msg = JSON.parse(event.data) as SignalMessage;
        this.handleSignalMessage(msg);
      } catch (error) {
        this.onLogError?.(
          `Invalid signal JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    ws.onerror = () => {
      // Wait for onclose to schedule reconnect if needed.
    };

    ws.onclose = () => {
      if (this.signalWs === ws) {
        this.signalWs = null;
      }
      if (!this.closed) {
        this.scheduleReconnect();
      }
    };
  }

  private openRelaySocket(url: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    try {
      this.relayWs?.close(1000, "reconnecting");
    } catch {
      // Ignore close error
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = this.wsFactory(url, this.authHeaders());
      ws.binaryType = "arraybuffer";
      this.relayWs = ws;

      ws.onopen = () => {
        if (this.closed || this.relayWs !== ws) {
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        this.reconnectAttempt = 0;
        this.setState("connected");
        this.startPingLoop();
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      ws.onmessage = (event) => {
        if (this.closed || this.relayWs !== ws) return;
        void toUint8Array(event.data)
          .then((bytes) => {
            if (bytes !== null) {
              this.handleRelayBinary(bytes);
            }
          })
          .catch((error) => {
            this.onLogError?.(
              `Relay message read error: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("Relay WebSocket connection failed"));
        }
      };

      ws.onclose = (ev) => {
        if (this.relayWs === ws) {
          this.relayWs = null;
        }
        this.stopPingLoop();
        if (!settled) {
          settled = true;
          reject(new Error(`Relay WebSocket closed (${ev.code ?? 1006})`));
        }
        if (!this.closed) {
          this.setState("reconnecting");
          this.scheduleReconnect();
        }
      };
    });
  }

  private handleSignalMessage(msg: SignalMessage): void {
    const peerId = msg.from ?? msg.src ?? msg.peer_id ?? msg.node_id;
    switch (msg.type) {
      case "registered":
        break;
      case "heartbeat":
        break;
      case "p2p_offer":
      case "p2p_answer":
      case "p2p_punch":
        if (peerId && peerId !== this.nodeId) {
          this.peerRoutes.set(peerId, "p2p");
        }
        break;
      case "p2p_unavailable":
      case "relay_fallback":
        if (peerId && peerId !== this.nodeId) {
          this.peerRoutes.set(peerId, "relay");
        }
        break;
      default:
        break;
    }
    this.onSignal?.(msg);
  }

  private handleRelayBinary(bytes: Uint8Array): void {
    let frame: RelayFrame;
    try {
      frame = decodeRelayFrame(bytes);
    } catch (error) {
      this.onLogError?.(
        `Invalid relay binary frame: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    switch (frame.flags) {
      case FLAG_PING: {
        this.sendRawFrame({
          flags: FLAG_PONG,
          src: this.nodeId,
          dst: frame.src,
          payload: frame.payload,
        });
        break;
      }
      case FLAG_PONG: {
        this.lastPongAtMs = Date.now();
        break;
      }
      case FLAG_ERR_OFFLINE:
      case FLAG_ERR_SPOOFED:
      case FLAG_ERR_RATE: {
        const reason =
          frame.payload.byteLength > 0
            ? utf8Decoder.decode(frame.payload)
            : frame.flags === FLAG_ERR_OFFLINE
              ? "Peer offline"
              : frame.flags === FLAG_ERR_SPOOFED
                ? "Spoofed source rejected"
                : "Rate limited";
        this.onRelayError?.({
          code: frame.flags,
          src: frame.src,
          dst: frame.dst,
          reason,
        });
        break;
      }
      case FLAG_DATA:
      default:
        this.onFrame?.(frame);
        break;
    }
  }

  /** Send a JSON message over `/v1/signal`. */
  sendSignal(msg: SignalMessage): boolean {
    if (!this.signalWs || this.signalWs.readyState !== WS_OPEN) {
      return false;
    }
    this.signalWs.send(JSON.stringify(msg));
    return true;
  }

  /** Send a raw binary `RelayFrame` over `/v1/relay`. */
  sendRawFrame(frame: RelayFrame): boolean {
    if (!this.relayWs || this.relayWs.readyState !== WS_OPEN) {
      return false;
    }
    const wire = encodeRelayFrame(frame);
    this.relayWs.send(wire);
    return true;
  }

  /** Send a `FLAG_DATA` binary frame to `dst` over `/v1/relay`. */
  sendData(dst: string, payload: Uint8Array): boolean {
    return this.sendRawFrame({
      flags: FLAG_DATA,
      src: this.nodeId,
      dst,
      payload,
    });
  }

  /** Send a `FLAG_PING` binary frame over `/v1/relay`. */
  sendPing(dst = "", payload: Uint8Array = new Uint8Array(0)): boolean {
    return this.sendRawFrame({
      flags: FLAG_PING,
      src: this.nodeId,
      dst,
      payload,
    });
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      this.sendPing("");
      this.sendSignal({
        type: "heartbeat",
        cluster_id: this.clusterId,
        node_id: this.nodeId,
        ts_ms: Date.now(),
      });
    }, this.pingIntervalMs);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopPingLoop();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempt, 10),
    );
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      void this.connect().catch((error) => {
        this.onLogError?.(
          `Relay reconnect failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!this.closed) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  /** Permanently close the relay and signal WebSockets and stop reconnecting. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.setState("closed");
    try {
      this.signalWs?.close(1000, "shutdown");
    } catch {
      // Ignore close error
    }
    try {
      this.relayWs?.close(1000, "shutdown");
    } catch {
      // Ignore close error
    }
    this.signalWs = null;
    this.relayWs = null;
  }
}
