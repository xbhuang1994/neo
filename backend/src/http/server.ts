/**
 * A small HTTP/1.1 server: requests with a declared length, responses with one, connections kept
 * open between requests. It serves one application to its own interface, so it is strict rather
 * than general.
 *
 * Ported directly from Rust `neo-http/src/server.rs` and `is_loopback` from `neo-http/src/lib.rs`.
 */

import * as net from "node:net";

/** The largest request body taken (24 MiB). */
export const MAX_BODY_BYTES = 24 * 1024 * 1024;
/** The largest request head taken (64 KiB). */
export const MAX_HEAD_BYTES = 64 * 1024;
/** Maximum simultaneous connections served. */
export const MAX_CONNECTIONS = 256;
/** Timeout waiting for request headers (30 s). */
export const HEAD_TIMEOUT_MS = 30_000;
/** Timeout waiting for the full request body (120 s). */
export const BODY_TIMEOUT_MS = 120_000;
/** Timeout writing a response (120 s). */
export const WRITE_TIMEOUT_MS = 120_000;
/** Grace period during shutdown for in-flight requests to finish (3 s). */
export const SHUTDOWN_DRAIN_MS = 3_000;

const INLINE_BODY_LIMIT = 256 * 1024;
const READ_PAUSE_WATERMARK = 64 * 1024;
const LINGER_CLOSE_MS = 1_000;

const EMPTY_BYTES = new Uint8Array(0);
const CRLF_CRLF = Buffer.from("\r\n\r\n");
const CONTINUE_100 = Buffer.from("HTTP/1.1 100 Continue\r\n\r\n");
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

const textEncoder = new TextEncoder();
const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });

/** A bound or peer socket address. */
export interface SocketAddr {
  /** IP address (IPv4 or IPv6, without brackets). */
  host: string;
  /** TCP port number. */
  port: number;
}

/** Format a socket address as `host:port` (or `[host]:port` for IPv6). */
export function formatSocketAddr(addr: SocketAddr): string {
  return addr.host.includes(":") ? `[${addr.host}]:${addr.port}` : `${addr.host}:${addr.port}`;
}

/** Input accepted by `new Request(...)`. */
export interface RequestInitData {
  method?: string;
  path?: string;
  query?: string;
  headers?: Map<string, string> | Record<string, string>;
  body?: Uint8Array;
}

/** An HTTP request. */
export class Request {
  /** The method, in capitals. */
  method: string;
  /** The path, percent-decoded, without the query. */
  path: string;
  /** The query, as sent. */
  query: string;
  /** The headers, names in lowercase. */
  headers: Map<string, string>;
  /** The body. */
  body: Uint8Array;

  constructor(init: RequestInitData = {}) {
    this.method = init.method ?? "";
    this.path = init.path ?? "";
    this.query = init.query ?? "";
    if (init.headers instanceof Map) {
      this.headers = init.headers;
    } else if (init.headers) {
      this.headers = new Map<string, string>();
      for (const [name, value] of Object.entries(init.headers)) {
        this.headers.set(name.toLowerCase(), value);
      }
    } else {
      this.headers = new Map<string, string>();
    }
    this.body = init.body ?? EMPTY_BYTES;
  }

  /** A header's value. */
  header(name: string): string | undefined {
    const direct = this.headers.get(name);
    if (direct !== undefined) {
      return direct;
    }
    const lower = name.toLowerCase();
    return lower === name ? undefined : this.headers.get(lower);
  }
}

/** Input accepted by `new Response(...)`. */
export interface ResponseInitData {
  status: number;
  contentType: string;
  body: Uint8Array;
  headers?: Array<[string, string]>;
}

/** An HTTP response. */
export class Response {
  /** The status code. */
  status: number;
  /** The content type. */
  contentType: string;
  /** The body. */
  body: Uint8Array;
  /** More headers. */
  headers: Array<[string, string]>;

  constructor(init: ResponseInitData) {
    this.status = init.status;
    this.contentType = init.contentType;
    this.body = init.body;
    this.headers = init.headers ?? [];
  }

  /** A JSON response, never cached. */
  static json(status: number, value: unknown): Response {
    return new Response({
      status,
      contentType: "application/json; charset=utf-8",
      body: textEncoder.encode(JSON.stringify(value)),
      headers: [["cache-control", "no-store"]],
    });
  }

  /** A JSON error: `{"error": …}`. */
  static error(status: number, message: string): Response {
    return Response.json(status, { error: message });
  }

  /** A raw bytes response. */
  static bytes(
    status: number,
    body: Uint8Array,
    contentType = "application/octet-stream",
    headers: Array<[string, string]> = [],
  ): Response {
    return new Response({ status, contentType, body, headers });
  }

  /** Append one header and return `this`. */
  withHeader(name: string, value: string): this {
    this.headers.push([name, value]);
    return this;
  }
}

/** Non-shadowing aliases for callers that also use global Fetch `Request` / `Response`. */
export { Request as HttpRequest, Response as HttpResponse };

/** HTTP/1.1 reason phrase matching Rust `server.rs`. */
export function reason(status: number): string {
  switch (status) {
    case 200:
      return "OK";
    case 202:
      return "Accepted";
    case 204:
      return "No Content";
    case 304:
      return "Not Modified";
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 408:
      return "Request Timeout";
    case 411:
      return "Length Required";
    case 413:
      return "Payload Too Large";
    case 415:
      return "Unsupported Media Type";
    case 431:
      return "Request Header Fields Too Large";
    case 500:
      return "Internal Server Error";
    case 503:
      return "Service Unavailable";
    default:
      return "Status";
  }
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

/** Decode `%XX` in a path; `null` when it is malformed or not valid UTF-8. */
export function percentDecode(text: string): string | null {
  if (!text.includes("%")) {
    return text;
  }
  const bytes = textEncoder.encode(text);
  const decoded = new Uint8Array(bytes.byteLength);
  let out = 0;
  let at = 0;
  while (at < bytes.byteLength) {
    const b = bytes[at];
    if (b === 0x25 /* '%' */) {
      if (at + 2 >= bytes.byteLength) {
        return null;
      }
      const hi = hexValue(bytes[at + 1]);
      const lo = hexValue(bytes[at + 2]);
      if (hi < 0 || lo < 0) {
        return null;
      }
      decoded[out++] = (hi << 4) | lo;
      at += 3;
    } else {
      decoded[out++] = b;
      at += 1;
    }
  }
  try {
    return utf8FatalDecoder.decode(decoded.subarray(0, out));
  } catch {
    return null;
  }
}

/** Parsed request head and whether the connection should stay open. */
export interface ParsedHead {
  request: Request;
  keep: boolean;
}

/** Parse a request head (lines separated by `\r\n`, without the trailing `\r\n\r\n`). */
export function parseHead(head: string): ParsedHead | null {
  const firstBreak = head.indexOf("\r\n");
  const requestLine = firstBreak === -1 ? head : head.slice(0, firstBreak);

  const sp1 = requestLine.indexOf(" ");
  if (sp1 <= 0) return null;
  const sp2 = requestLine.indexOf(" ", sp1 + 1);
  if (sp2 === -1) return null;
  if (requestLine.indexOf(" ", sp2 + 1) !== -1) return null;

  const method = requestLine.slice(0, sp1);
  const target = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1);

  if (!version.startsWith("HTTP/1.") || method.length === 0 || !target.startsWith("/")) {
    return null;
  }

  const qIdx = target.indexOf("?");
  const rawPath = qIdx === -1 ? target : target.slice(0, qIdx);
  const query = qIdx === -1 ? "" : target.slice(qIdx + 1);

  const headers = new Map<string, string>();
  if (firstBreak !== -1) {
    let pos = firstBreak + 2;
    while (pos <= head.length) {
      const nextBreak = head.indexOf("\r\n", pos);
      const line = nextBreak === -1 ? head.slice(pos) : head.slice(pos, nextBreak);
      const colon = line.indexOf(":");
      if (colon === -1) {
        return null;
      }
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers.set(name, value);
      if (nextBreak === -1) {
        break;
      }
      pos = nextBreak + 2;
    }
  }

  const decodedPath = percentDecode(rawPath);
  if (decodedPath === null) {
    return null;
  }

  const connection = (headers.get("connection") ?? "").toLowerCase();
  const keep = version === "HTTP/1.0" ? connection.includes("keep-alive") : !connection.includes("close");

  return {
    request: new Request({
      method: method.toUpperCase(),
      path: decodedPath,
      query,
      headers,
      body: EMPTY_BYTES,
    }),
    keep,
  };
}

function parseIpv4(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (part.length === 0 || part.length > 3) return null;
    if (part.length > 1 && part.charCodeAt(0) === 0x30 /* '0' */) return null;
    let value = 0;
    for (let j = 0; j < part.length; j++) {
      const c = part.charCodeAt(j);
      if (c < 0x30 || c > 0x39) return null;
      value = value * 10 + (c - 0x30);
    }
    if (value > 255) return null;
    octets[i] = value;
  }
  return octets;
}

function parseIpv6Groups(part: string, allowIpv4Tail: boolean): number[] | null {
  if (part.length === 0) return [];
  const segments = part.split(":");
  const groups: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (allowIpv4Tail && i === segments.length - 1 && seg.includes(".")) {
      const ipv4 = parseIpv4(seg);
      if (ipv4 === null) return null;
      groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      continue;
    }
    if (seg.length === 0 || seg.length > 4) return null;
    let value = 0;
    for (let j = 0; j < seg.length; j++) {
      const digit = hexValue(seg.charCodeAt(j));
      if (digit < 0) return null;
      value = (value << 4) | digit;
    }
    groups.push(value);
  }
  return groups;
}

function parseIpv6(text: string): Uint16Array | null {
  if (!text.includes(":")) return null;
  const doubleColon = text.indexOf("::");
  if (doubleColon === -1) {
    const groups = parseIpv6Groups(text, true);
    if (groups === null || groups.length !== 8) return null;
    return Uint16Array.from(groups);
  }
  if (text.indexOf("::", doubleColon + 2) !== -1) {
    return null;
  }
  const left = parseIpv6Groups(text.slice(0, doubleColon), false);
  const right = parseIpv6Groups(text.slice(doubleColon + 2), true);
  if (left === null || right === null) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  const out = new Uint16Array(8);
  for (let i = 0; i < left.length; i++) {
    out[i] = left[i];
  }
  const rightStart = left.length + missing;
  for (let i = 0; i < right.length; i++) {
    out[rightStart + i] = right[i];
  }
  return out;
}

/** Whether a parsed IPv4 or IPv6 address is loopback (`127.0.0.0/8` or `::1`), matching Rust `IpAddr::is_loopback`. */
export function isLoopbackIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) {
    return v4[0] === 127;
  }
  const v6 = parseIpv6(ip);
  if (v6 !== null) {
    return (
      v6[0] === 0 &&
      v6[1] === 0 &&
      v6[2] === 0 &&
      v6[3] === 0 &&
      v6[4] === 0 &&
      v6[5] === 0 &&
      v6[6] === 0 &&
      v6[7] === 1
    );
  }
  return false;
}

function stripBrackets(host: string): string {
  let start = 0;
  let end = host.length;
  while (start < end && host.charCodeAt(start) === 0x5b /* '[' */) start++;
  while (end > start && host.charCodeAt(end - 1) === 0x5d /* ']' */) end--;
  return start === 0 && end === host.length ? host : host.slice(start, end);
}

/** Whether a host name or address is this machine's loopback, where the API may be offered without a token. */
export function isLoopback(host: string): boolean {
  if (host.toLowerCase() === "localhost") {
    return true;
  }
  return isLoopbackIp(stripBrackets(host));
}

function normalizePeerHost(remoteAddress: string | undefined): string {
  if (!remoteAddress) {
    return "";
  }
  if (remoteAddress.startsWith("::ffff:") || remoteAddress.startsWith("::FFFF:")) {
    const tail = remoteAddress.slice(7);
    if (parseIpv4(tail) !== null) {
      return tail;
    }
  }
  return remoteAddress;
}

function parseContentLength(raw: string): { ok: true; value: number } | { ok: false; status: 400 | 413; message: string } {
  if (raw.length === 0) {
    return { ok: false, status: 400, message: "Malformed Content-Length" };
  }
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x30 || c > 0x39) {
      return { ok: false, status: 400, message: "Malformed Content-Length" };
    }
  }
  // Fast path for normal lengths (<= 15 digits fits in safe integer without BigInt).
  if (raw.length <= 15) {
    const value = Number(raw);
    if (value > MAX_BODY_BYTES) {
      return { ok: false, status: 413, message: "Request body too large" };
    }
    return { ok: true, value };
  }
  const big = BigInt(raw);
  if (big > MAX_U64) {
    return { ok: false, status: 400, message: "Malformed Content-Length" };
  }
  if (big > BigInt(MAX_BODY_BYTES)) {
    return { ok: false, status: 413, message: "Request body too large" };
  }
  return { ok: true, value: Number(big) };
}

class StopSignal {
  private stopped = false;
  private readonly listeners = new Set<() => void>();

  get isStopped(): boolean {
    return this.stopped;
  }

  trigger(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const listener of this.listeners) {
      listener();
    }
    this.listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    if (this.stopped) {
      listener();
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * Buffered event-driven reader over a `net.Socket`:
 * - O(1) fast path for single-packet headers via native `Buffer.indexOf`
 * - O(N) state-machine scan for fragmented multi-packet headers (bounded at `MAX_HEAD_BYTES`)
 * - Single-allocation O(N) body assembly directly from incoming TCP chunks
 */
class SocketReader {
  private readonly socket: net.Socket;
  private readonly chunks: Buffer[] = [];
  private headOffset = 0;
  private totalLength = 0;
  private ended = false;
  private paused = false;
  private waiter: (() => void) | null = null;

  private readonly onData: (chunk: Buffer) => void;
  private readonly onEnd: () => void;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.onData = (chunk: Buffer) => {
      if (chunk.byteLength === 0) return;
      this.chunks.push(chunk);
      this.totalLength += chunk.byteLength;
      if (this.waiter !== null) {
        const wake = this.waiter;
        this.waiter = null;
        wake();
      } else if (!this.paused && this.totalLength >= READ_PAUSE_WATERMARK) {
        this.paused = true;
        this.socket.pause();
      }
    };
    this.onEnd = () => {
      this.ended = true;
      if (this.waiter !== null) {
        const wake = this.waiter;
        this.waiter = null;
        wake();
      }
    };
    socket.on("data", this.onData);
    socket.on("end", this.onEnd);
    socket.on("error", this.onEnd);
    socket.on("close", this.onEnd);
  }

  get available(): number {
    return this.totalLength;
  }

  detach(): void {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("error", this.onEnd);
    this.socket.off("close", this.onEnd);
  }

  async waitForMore(timeoutMs: number, stop: StopSignal): Promise<"data" | "closed" | "timeout" | "stopped"> {
    if (stop.isStopped) return "stopped";
    if (this.ended) return "closed";
    if (timeoutMs <= 0) return "timeout";
    const before = this.totalLength;
    if (this.paused) {
      this.paused = false;
      this.socket.resume();
      if (this.totalLength > before) return "data";
      if (this.ended) return "closed";
    }
    return await new Promise<"data" | "closed" | "timeout" | "stopped">((resolve) => {
      let settled = false;
      const done = (result: "data" | "closed" | "timeout" | "stopped"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        this.waiter = null;
        resolve(result);
      };
      const timer = setTimeout(() => done("timeout"), timeoutMs);
      const unsubscribe = stop.subscribe(() => done("stopped"));
      this.waiter = () => {
        if (this.totalLength > before) {
          done("data");
        } else {
          done("closed");
        }
      };
    });
  }

  /**
   * Find `\r\n\r\n` within the first `MAX_HEAD_BYTES` bytes.
   * Returns byte offset (`>= 0`), `-1` if not found yet and still within limit,
   * or `-2` if headers exceed `MAX_HEAD_BYTES` (431).
   */
  findHeadEnd(): number {
    if (this.totalLength < 4) {
      return -1;
    }
    const first = this.chunks[0];
    const firstAvail = first.byteLength - this.headOffset;
    if (this.chunks.length === 1 || firstAvail >= MAX_HEAD_BYTES + 4) {
      const idx = first.indexOf(CRLF_CRLF, this.headOffset);
      if (idx !== -1) {
        const rel = idx - this.headOffset;
        return rel <= MAX_HEAD_BYTES ? rel : -2;
      }
      return firstAvail > MAX_HEAD_BYTES ? -2 : -1;
    }

    // Fragmented multi-chunk scan with a 4-state matcher, bounded at MAX_HEAD_BYTES + 4.
    const limit = Math.min(this.totalLength, MAX_HEAD_BYTES + 4);
    let state = 0;
    let pos = 0;
    for (let c = 0; c < this.chunks.length && pos < limit; c++) {
      const buf = this.chunks[c];
      let i = c === 0 ? this.headOffset : 0;
      const maxEnd = Math.min(buf.byteLength, i + (limit - pos));
      for (; i < maxEnd; i++, pos++) {
        const b = buf[i];
        if (state === 0) {
          if (b === 13) state = 1;
        } else if (state === 1) {
          if (b === 10) state = 2;
          else if (b !== 13) state = 0;
        } else if (state === 2) {
          if (b === 13) state = 3;
          else state = 0;
        } else {
          if (b === 10) {
            const headEnd = pos - 3;
            return headEnd <= MAX_HEAD_BYTES ? headEnd : -2;
          }
          state = b === 13 ? 1 : 0;
        }
      }
    }
    return this.totalLength > MAX_HEAD_BYTES ? -2 : -1;
  }

  /** Consume `length` bytes and decode strictly as UTF-8, or return `null` on invalid UTF-8. */
  takeUtf8(length: number): string | null {
    if (length === 0) return "";
    const first = this.chunks[0];
    const firstAvail = first.byteLength - this.headOffset;
    if (firstAvail >= length) {
      const slice = first.subarray(this.headOffset, this.headOffset + length);
      this.headOffset += length;
      this.totalLength -= length;
      if (this.headOffset === first.byteLength) {
        this.chunks.shift();
        this.headOffset = 0;
      }
      try {
        return utf8FatalDecoder.decode(slice);
      } catch {
        return null;
      }
    }
    const bytes = this.takeBytes(length);
    try {
      return utf8FatalDecoder.decode(bytes);
    } catch {
      return null;
    }
  }

  /** Discard `count` buffered bytes. */
  skipBytes(count: number): void {
    let remaining = count;
    while (remaining > 0) {
      const first = this.chunks[0];
      const avail = first.byteLength - this.headOffset;
      if (avail <= remaining) {
        remaining -= avail;
        this.totalLength -= avail;
        this.chunks.shift();
        this.headOffset = 0;
      } else {
        this.headOffset += remaining;
        this.totalLength -= remaining;
        remaining = 0;
      }
    }
  }

  /** Copy `length` already-buffered bytes out of the queue. */
  takeBytes(length: number): Uint8Array {
    if (length === 0) return EMPTY_BYTES;
    const first = this.chunks[0];
    const firstAvail = first.byteLength - this.headOffset;
    if (firstAvail >= length) {
      if (this.headOffset === 0 && firstAvail === length) {
        this.chunks.shift();
        this.totalLength -= length;
        return new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
      }
      const out = new Uint8Array(length);
      out.set(first.subarray(this.headOffset, this.headOffset + length));
      this.headOffset += length;
      this.totalLength -= length;
      if (this.headOffset === first.byteLength) {
        this.chunks.shift();
        this.headOffset = 0;
      }
      return out;
    }
    const out = new Uint8Array(length);
    this.drainInto(out, 0, length);
    return out;
  }

  /** Drain up to `maxCount` buffered bytes into `target` starting at `offset`; returns bytes copied. */
  drainInto(target: Uint8Array, offset: number, maxCount: number): number {
    let copied = 0;
    while (copied < maxCount && this.chunks.length > 0) {
      const first = this.chunks[0];
      const avail = first.byteLength - this.headOffset;
      const toCopy = Math.min(avail, maxCount - copied);
      target.set(first.subarray(this.headOffset, this.headOffset + toCopy), offset + copied);
      copied += toCopy;
      this.totalLength -= toCopy;
      if (toCopy === avail) {
        this.chunks.shift();
        this.headOffset = 0;
      } else {
        this.headOffset += toCopy;
      }
    }
    return copied;
  }
}

type ReadResult =
  | { readonly kind: "request"; readonly request: Request; readonly keep: boolean }
  | { readonly kind: "closed" }
  | { readonly kind: "refuse"; readonly response: Response };

async function writeAll(socket: net.Socket, buffers: readonly Uint8Array[], timeoutMs: number): Promise<boolean> {
  if (socket.destroyed || !socket.writable) {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", onFail);
      socket.off("close", onFail);
      resolve(ok);
    };
    const onFail = (): void => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("error", onFail);
    socket.on("close", onFail);

    const corked = buffers.length > 1;
    try {
      if (corked) {
        socket.cork();
      }
      for (let i = 0; i < buffers.length; i++) {
        if (i === buffers.length - 1) {
          socket.write(buffers[i], (err) => finish(!err));
        } else {
          socket.write(buffers[i]);
        }
      }
    } catch {
      finish(false);
    } finally {
      if (corked && !socket.destroyed) {
        try {
          socket.uncork();
        } catch {
          // Ignore uncork errors on closing sockets.
        }
      }
    }
  });
}

async function endSocket(socket: net.Socket, timeoutMs: number): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", done);
      socket.off("close", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    socket.on("error", done);
    socket.on("close", done);
    try {
      socket.end(done);
    } catch {
      done();
    }
  });
}

function releaseHalfOpenSocket(socket: net.Socket, lingering: Set<net.Socket>): void {
  if (socket.destroyed || socket.readableEnded) {
    socket.destroy();
    return;
  }
  lingering.add(socket);
  const cleanup = (): void => {
    clearTimeout(timer);
    lingering.delete(socket);
    socket.off("end", cleanup);
    socket.off("close", cleanup);
    socket.off("error", cleanup);
    if (!socket.destroyed) {
      socket.destroy();
    }
  };
  const timer = setTimeout(cleanup, LINGER_CLOSE_MS);
  timer.unref?.();
  socket.on("end", cleanup);
  socket.on("close", cleanup);
  socket.on("error", cleanup);
  socket.on("data", () => {});
  socket.resume();
}

async function readRequest(
  socket: net.Socket,
  reader: SocketReader,
  stop: StopSignal,
  config: ResolvedServerOptions,
): Promise<ReadResult> {
  let headEnd: number;
  const headDeadline = Date.now() + config.headTimeoutMs;
  while (true) {
    const found = reader.findHeadEnd();
    if (found >= 0) {
      headEnd = found;
      break;
    }
    if (found === -2) {
      return { kind: "refuse", response: Response.error(431, "Request headers too large") };
    }
    const status = await reader.waitForMore(headDeadline - Date.now(), stop);
    if (status !== "data") {
      return { kind: "closed" };
    }
  }

  const headText = reader.takeUtf8(headEnd);
  reader.skipBytes(4); // consume "\r\n\r\n"
  if (headText === null) {
    return { kind: "refuse", response: Response.error(400, "Malformed request") };
  }
  const parsed = parseHead(headText);
  if (parsed === null) {
    return { kind: "refuse", response: Response.error(400, "Malformed request") };
  }
  const { request, keep } = parsed;

  if (request.headers.has("transfer-encoding")) {
    return { kind: "refuse", response: Response.error(411, "Send the body with a Content-Length") };
  }

  const rawLength = request.header("content-length");
  let length = 0;
  if (rawLength !== undefined) {
    const parsedLength = parseContentLength(rawLength);
    if (!parsedLength.ok) {
      return { kind: "refuse", response: Response.error(parsedLength.status, parsedLength.message) };
    }
    length = parsedLength.value;
  }

  if (
    length > reader.available &&
    request.header("expect")?.toLowerCase() === "100-continue"
  ) {
    const sent = await writeAll(socket, [CONTINUE_100], config.writeTimeoutMs);
    if (!sent) {
      return { kind: "closed" };
    }
  }

  if (length === 0) {
    request.body = EMPTY_BYTES;
    return { kind: "request", request, keep };
  }

  if (reader.available >= length) {
    request.body = reader.takeBytes(length);
    return { kind: "request", request, keep };
  }

  const body = new Uint8Array(length);
  let filled = reader.drainInto(body, 0, length);
  const deadline = Date.now() + config.bodyTimeoutMs;
  while (filled < length) {
    const remainingMs = deadline - Date.now();
    const status = await reader.waitForMore(remainingMs, stop);
    if (status === "timeout") {
      return { kind: "refuse", response: Response.error(408, "The request body did not arrive in time") };
    }
    if (status !== "data") {
      return { kind: "closed" };
    }
    filled += reader.drainInto(body, filled, length - filled);
  }
  request.body = body;
  return { kind: "request", request, keep };
}

async function writeResponse(
  socket: net.Socket,
  response: Response,
  keep: boolean,
  headOnly: boolean,
  writeTimeoutMs: number,
): Promise<boolean> {
  const noBodyStatus = response.status === 204 || response.status === 304;
  let head = noBodyStatus
    ? `HTTP/1.1 ${response.status} ${reason(response.status)}\r\n`
    : `HTTP/1.1 ${response.status} ${reason(response.status)}\r\ncontent-type: ${response.contentType}\r\ncontent-length: ${response.body.byteLength}\r\n`;
  for (let i = 0; i < response.headers.length; i++) {
    const [name, value] = response.headers[i];
    head += `${name}: ${value}\r\n`;
  }
  head += keep ? "connection: keep-alive\r\n\r\n" : "connection: close\r\n\r\n";

  const headBytes = textEncoder.encode(head);
  if (headOnly || noBodyStatus || response.body.byteLength === 0) {
    return await writeAll(socket, [headBytes], writeTimeoutMs);
  }
  if (response.body.byteLength <= INLINE_BODY_LIMIT) {
    const combined = Buffer.allocUnsafe(headBytes.byteLength + response.body.byteLength);
    combined.set(headBytes, 0);
    combined.set(response.body, headBytes.byteLength);
    return await writeAll(socket, [combined], writeTimeoutMs);
  }
  return await writeAll(socket, [headBytes, response.body], writeTimeoutMs);
}

/** Answers requests. */
export type Handler = (request: Request, peer: SocketAddr) => Promise<Response> | Response;

/** Optional tuning knobs for `Server.bind` (defaults match Rust `server.rs`). */
export interface ServerOptions {
  maxConnections?: number;
  headTimeoutMs?: number;
  bodyTimeoutMs?: number;
  writeTimeoutMs?: number;
  shutdownDrainMs?: number;
}

interface ResolvedServerOptions {
  maxConnections: number;
  headTimeoutMs: number;
  bodyTimeoutMs: number;
  writeTimeoutMs: number;
  shutdownDrainMs: number;
}

/** Handle to a running HTTP server. */
export interface HttpServerHandle {
  /** The address it listens on. */
  readonly addr: SocketAddr;
  /** Stop listening, let requests under way finish, and close every connection. */
  shutdown(): Promise<void>;
}

async function serveConnection(
  socket: net.Socket,
  peer: SocketAddr,
  handler: Handler,
  stop: StopSignal,
  config: ResolvedServerOptions,
  lingering: Set<net.Socket>,
): Promise<void> {
  socket.setNoDelay(true);
  const reader = new SocketReader(socket);
  try {
    while (true) {
      const read = await readRequest(socket, reader, stop, config);
      if (read.kind === "closed") {
        reader.detach();
        if (!socket.destroyed && !socket.writableEnded) {
          await endSocket(socket, LINGER_CLOSE_MS);
        }
        socket.destroy();
        return;
      }
      if (read.kind === "refuse") {
        const wrote = await writeResponse(socket, read.response, false, false, config.writeTimeoutMs);
        reader.detach();
        if (wrote) {
          await endSocket(socket, config.writeTimeoutMs);
          releaseHalfOpenSocket(socket, lingering);
        } else {
          socket.destroy();
        }
        return;
      }
      const headOnly = read.request.method === "HEAD";
      // A request that was taken is answered, also while the server stops.
      let response: Response;
      let handlerFailed = false;
      try {
        response = await handler(read.request, peer);
      } catch {
        response = Response.error(500, "Internal server error");
        handlerFailed = true;
      }
      const keep = read.keep && !handlerFailed && !stop.isStopped;
      const wrote = await writeResponse(socket, response, keep, headOnly, config.writeTimeoutMs);
      if (!wrote || !keep) {
        reader.detach();
        if (wrote) {
          await endSocket(socket, config.writeTimeoutMs);
          releaseHalfOpenSocket(socket, lingering);
        } else {
          socket.destroy();
        }
        return;
      }
    }
  } finally {
    reader.detach();
  }
}

/** A listening HTTP/1.1 server. */
export class Server implements HttpServerHandle {
  /** The address it listens on. */
  readonly addr: SocketAddr;

  private readonly netServer: net.Server;
  private readonly stop: StopSignal;
  private readonly activeSockets: Set<net.Socket>;
  private readonly lingeringSockets: Set<net.Socket>;
  private readonly activeTasks: Set<Promise<void>>;
  private readonly shutdownDrainMs: number;
  private shutdownPromise: Promise<void> | null = null;

  private constructor(
    addr: SocketAddr,
    netServer: net.Server,
    stop: StopSignal,
    activeSockets: Set<net.Socket>,
    lingeringSockets: Set<net.Socket>,
    activeTasks: Set<Promise<void>>,
    shutdownDrainMs: number,
  ) {
    this.addr = addr;
    this.netServer = netServer;
    this.stop = stop;
    this.activeSockets = activeSockets;
    this.lingeringSockets = lingeringSockets;
    this.activeTasks = activeTasks;
    this.shutdownDrainMs = shutdownDrainMs;
  }

  /** Base HTTP URL for this listening server (`http://host:port` or `http://[host]:port`). */
  url(): string {
    return `http://${formatSocketAddr(this.addr)}`;
  }

  /** Listen on `host:port`, port `0` for any free one, and answer with `handler`. */
  static async bind(host: string, port: number, handler: Handler, options: ServerOptions = {}): Promise<Server> {
    const config: ResolvedServerOptions = {
      maxConnections: options.maxConnections ?? MAX_CONNECTIONS,
      headTimeoutMs: options.headTimeoutMs ?? HEAD_TIMEOUT_MS,
      bodyTimeoutMs: options.bodyTimeoutMs ?? BODY_TIMEOUT_MS,
      writeTimeoutMs: options.writeTimeoutMs ?? WRITE_TIMEOUT_MS,
      shutdownDrainMs: options.shutdownDrainMs ?? SHUTDOWN_DRAIN_MS,
    };

    const stop = new StopSignal();
    const activeSockets = new Set<net.Socket>();
    const lingeringSockets = new Set<net.Socket>();
    const activeTasks = new Set<Promise<void>>();

    const netServer = net.createServer({ allowHalfOpen: true }, (socket) => {
      // Prevent unhandled 'error' events (ECONNRESET/EPIPE) at any point in the socket lifecycle.
      socket.on("error", () => {});
      if (stop.isStopped || activeSockets.size >= config.maxConnections) {
        // Too many connections at once or server stopping: dropped unanswered.
        socket.destroy();
        return;
      }
      const peer: SocketAddr = {
        host: normalizePeerHost(socket.remoteAddress),
        port: socket.remotePort ?? 0,
      };
      activeSockets.add(socket);
      const task = serveConnection(socket, peer, handler, stop, config, lingeringSockets).finally(() => {
        activeSockets.delete(socket);
        activeTasks.delete(task);
      });
      activeTasks.add(task);
    });

    const listenHost = stripBrackets(host);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        netServer.off("listening", onListening);
        reject(new Error(`Cannot listen on ${host}:${port}: ${error.message}`));
      };
      const onListening = (): void => {
        netServer.off("error", onError);
        resolve();
      };
      netServer.once("error", onError);
      netServer.once("listening", onListening);
      try {
        netServer.listen({ host: listenHost, port });
      } catch (error) {
        netServer.off("error", onError);
        netServer.off("listening", onListening);
        const msg = error instanceof Error ? error.message : String(error);
        reject(new Error(`Cannot listen on ${host}:${port}: ${msg}`));
      }
    });

    // Swallow post-bind server errors to avoid unhandled EventEmitter crashes.
    netServer.on("error", () => {});

    const rawAddr = netServer.address();
    if (!rawAddr || typeof rawAddr === "string") {
      netServer.close();
      throw new Error(`Cannot determine bound address for ${host}:${port}`);
    }

    return new Server(
      { host: rawAddr.address, port: rawAddr.port },
      netServer,
      stop,
      activeSockets,
      lingeringSockets,
      activeTasks,
      config.shutdownDrainMs,
    );
  }

  /** Stop listening, let requests under way finish, and close every connection. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return await this.shutdownPromise;
    }
    this.shutdownPromise = this.performShutdown();
    return await this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.stop.trigger();

    const closeDone = new Promise<void>((resolve) => {
      try {
        this.netServer.close(() => resolve());
      } catch {
        resolve();
      }
    });

    // Requests under way get a moment to finish.
    if (this.activeTasks.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.activeTasks]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.shutdownDrainMs);
        }),
      ]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    // Force-close any remaining active or half-open lingering sockets.
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    for (const socket of this.lingeringSockets) {
      socket.destroy();
    }
    this.lingeringSockets.clear();

    await closeDone;
  }
}
