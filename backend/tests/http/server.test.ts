import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  MAX_BODY_BYTES,
  MAX_HEAD_BYTES,
  Request,
  Response,
  Server,
  formatSocketAddr,
  isLoopback,
  isLoopbackIp,
  parseHead,
  percentDecode,
  reason,
} from "../../src/http/server.ts";
import type { SocketAddr } from "../../src/http/server.ts";
import {
  GUARD_ALLOW,
  Journal,
  Session,
  UnboundedChannel,
  guardBlock,
  textBlock,
} from "../../src/kernel/index.ts";
import type { DriverEvent, KernelJob, ToolHost } from "../../src/kernel/index.ts";
import {
  MockHttpServer,
  MockResponse,
  ScriptedKernels,
  TempDir,
  findProgram,
  serveMockHttp,
} from "../../src/testkit/index.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** Connect a raw TCP socket to `addr`. */
async function connectTcp(addr: SocketAddr): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ host: addr.host, port: addr.port }, () => {
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** Send raw bytes and read until the server closes the connection (mirrors Rust `raw()` in api.rs). */
async function sendRaw(addr: SocketAddr, payload: string | Uint8Array, timeoutMs = 5_000): Promise<string> {
  const socket = await connectTcp(addr);
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for server to close connection")), timeoutMs);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => finish());
    socket.on("error", (err) => {
      // If we already received data before peer reset, surface only unexpected errors.
      finish(err);
    });
    socket.write(payload);
  });
}

/** Read the next chunk(s) until predicate returns true, or timeout. */
async function readUntil(
  socket: net.Socket,
  predicate: (buf: Buffer) => boolean,
  timeoutMs = 5_000,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const merged = Buffer.concat(chunks);
      if (predicate(merged)) {
        settled = true;
        cleanup();
        resolve(merged);
      }
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`readUntil timed out (received ${Buffer.concat(chunks).byteLength} bytes)`));
    }, timeoutMs);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
  });
}

// ============================================================================
// Ported inline #[cfg(test)] tests from neo-http/src/server.rs & lib.rs
// ============================================================================

describe("http/server unit tests (Rust neo-http/src/{server,lib}.rs)", () => {
  test("parses a request head and decides whether the connection stays", () => {
    const parsed = parseHead(
      "POST /api/workers/a%20b?x=1%202 HTTP/1.1\r\nHost: 127.0.0.1:3082\r\nContent-Type:  application/json \r\nX-Empty:",
    );
    expect(parsed).not.toBeNull();
    const { request, keep } = parsed!;
    expect([request.method, request.path, request.query]).toEqual(["POST", "/api/workers/a b", "x=1%202"]);
    expect([request.header("host"), request.header("content-type"), request.header("x-empty")]).toEqual([
      "127.0.0.1:3082",
      "application/json",
      "",
    ]);
    expect(keep).toBe(true);

    expect(parseHead("GET / HTTP/1.1\r\nConnection: close")?.keep).toBe(false);
    expect(parseHead("GET / HTTP/1.0")?.keep).toBe(false);
    expect(parseHead("GET / HTTP/1.0\r\nConnection: Keep-Alive")?.keep).toBe(true);

    const badHeads = [
      "GET /",
      "GET / HTTP/2",
      "GET nothing HTTP/1.1",
      "GET / HTTP/1.1 extra",
      "GET /%zz HTTP/1.1",
      "GET /%ff HTTP/1.1",
      "GET / HTTP/1.1\r\nno colon",
    ];
    for (const bad of badHeads) {
      expect(parseHead(bad)).toBeNull();
    }
  });

  test("decodes percent escapes", () => {
    expect(percentDecode("/a%2Fb/%E4%B8%AD")).toBe("/a/b/中");
    expect(percentDecode("plain")).toBe("plain");
    expect([percentDecode("%"), percentDecode("%4"), percentDecode("%c3%28")]).toEqual([null, null, null]);
  });

  test("tells loopback hosts from others", () => {
    for (const host of [
      "127.0.0.1",
      "localhost",
      "LOCALHOST",
      "::1",
      "[::1]",
      "127.8.9.1",
      "0:0:0:0:0:0:0:1",
      "::0.0.0.1",
    ]) {
      expect(isLoopback(host)).toBe(true);
    }
    for (const host of [
      "0.0.0.0",
      "::",
      "192.168.1.2",
      "example.com",
      "",
      "::2",
      "::ffff:127.0.0.1",
      "0127.0.0.1",
      "127.0.0.256",
      ":::1",
    ]) {
      expect(isLoopback(host)).toBe(false);
    }
    expect(isLoopbackIp("127.0.0.1")).toBe(true);
    expect(isLoopbackIp("::1")).toBe(true);
    expect(isLoopbackIp("localhost")).toBe(false);
    expect(isLoopbackIp("[::1]")).toBe(false);
  });

  test("constants, Request, Response helpers, and reason phrases match Rust", () => {
    expect(MAX_BODY_BYTES).toBe(24 * 1024 * 1024);
    expect(MAX_HEAD_BYTES).toBe(64 * 1024);

    const req = new Request({
      method: "GET",
      path: "/api/health",
      headers: { Host: "127.0.0.1:3082", "X-Custom": "ok" },
    });
    expect(req.header("host")).toBe("127.0.0.1:3082");
    expect(req.header("Host")).toBe("127.0.0.1:3082");
    expect(req.header("x-custom")).toBe("ok");
    expect(req.header("missing")).toBeUndefined();

    const jsonRes = Response.json(202, { ok: true });
    expect(jsonRes.status).toBe(202);
    expect(jsonRes.contentType).toBe("application/json; charset=utf-8");
    expect(textDecoder.decode(jsonRes.body)).toBe('{"ok":true}');
    expect(jsonRes.headers).toEqual([["cache-control", "no-store"]]);

    const errRes = Response.error(403, "Forbidden origin");
    expect(errRes.status).toBe(403);
    expect(textDecoder.decode(errRes.body)).toBe('{"error":"Forbidden origin"}');

    const rawRes = Response.bytes(200, new Uint8Array([1, 2, 3]), "font/otf").withHeader("x-test", "1");
    expect(rawRes.contentType).toBe("font/otf");
    expect([...rawRes.body]).toEqual([1, 2, 3]);
    expect(rawRes.headers).toEqual([["x-test", "1"]]);

    expect(reason(200)).toBe("OK");
    expect(reason(408)).toBe("Request Timeout");
    expect(reason(411)).toBe("Length Required");
    expect(reason(413)).toBe("Payload Too Large");
    expect(reason(431)).toBe("Request Header Fields Too Large");
    expect(reason(418)).toBe("Status");

    expect(formatSocketAddr({ host: "127.0.0.1", port: 3082 })).toBe("127.0.0.1:3082");
    expect(formatSocketAddr({ host: "::1", port: 3082 })).toBe("[::1]:3082");
  });
});

// ============================================================================
// Protocol edge tests (ported from neo-http/tests/api.rs + server.rs behavior)
// ============================================================================

describe("http/server protocol and lifecycle", () => {
  test("keeps connections open, handles split bodies, HEAD, Expect: 100-continue, and refuses invalid requests", async () => {
    const peers: SocketAddr[] = [];
    const server = await Server.bind("127.0.0.1", 0, (req, peer) => {
      peers.push(peer);
      if (req.path === "/api/messages" && req.method === "GET") {
        return Response.json(200, { messages: [] });
      }
      if (req.path === "/api/wechat/verify" && req.method === "POST") {
        const parsed = JSON.parse(textDecoder.decode(req.body)) as { code?: string };
        return Response.error(400, `当前不需要微信验证码:${parsed.code ?? ""}`);
      }
      if (req.path === "/" && (req.method === "GET" || req.method === "HEAD")) {
        return Response.bytes(200, textEncoder.encode("<!doctype html><title>Neo</title>"), "text/html; charset=utf-8");
      }
      return Response.error(404, "Not found");
    });

    try {
      const hostHeader = `Host: 127.0.0.1:${server.addr.port}\r\n`;

      // 1. Two requests on one connection; second has Connection: close and body split across writes.
      const stream = await connectTcp(server.addr);
      stream.write(`GET /api/messages HTTP/1.1\r\n${hostHeader}\r\n`);
      const firstBuf = await readUntil(stream, (buf) => buf.toString("utf8").endsWith('{"messages":[]}'));
      const first = firstBuf.toString("utf8");
      expect(first.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
      expect(first.includes("connection: keep-alive\r\n")).toBe(true);
      expect(first.endsWith('{"messages":[]}')).toBe(true);

      const body = '{"code":"1"}';
      stream.write(
        `POST /api/wechat/verify HTTP/1.1\r\n${hostHeader}Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.slice(0, 4)}`,
      );
      await Bun.sleep(30);
      stream.write(body.slice(4));
      const second = (await readUntil(stream, () => false)).toString("utf8");
      stream.destroy();
      expect(second.startsWith("HTTP/1.1 400 Bad Request\r\n")).toBe(true);
      expect(second.includes("connection: close\r\n")).toBe(true);
      expect(second.includes("当前不需要微信验证码:1")).toBe(true);

      // Peer address was loopback IPv4.
      expect(peers.length).toBeGreaterThanOrEqual(2);
      expect(isLoopbackIp(peers[0].host)).toBe(true);

      // 2. HEAD sets content-length and omits the body.
      const headResp = await sendRaw(server.addr, "HEAD / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      expect(headResp.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
      expect(headResp.includes("content-length: 33\r\n")).toBe(true);
      expect(headResp.endsWith("\r\n\r\n")).toBe(true);

      // 3. Refused requests: 413, 411, 400 (malformed head), 400 (malformed CL), 431 (oversized head).
      const firstLine = (raw: string): string => raw.split("\r\n")[0] ?? "";

      const tooLarge = await sendRaw(
        server.addr,
        `POST /api/chat HTTP/1.1\r\n${hostHeader}Content-Type: application/json\r\nContent-Length: ${25 * 1024 * 1024}\r\n\r\n`,
      );
      expect(firstLine(tooLarge)).toBe("HTTP/1.1 413 Payload Too Large");
      expect(tooLarge.endsWith('{"error":"Request body too large"}')).toBe(true);

      const chunked = await sendRaw(
        server.addr,
        `POST /api/chat HTTP/1.1\r\n${hostHeader}Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
      );
      expect(firstLine(chunked)).toBe("HTTP/1.1 411 Length Required");
      expect(chunked.endsWith('{"error":"Send the body with a Content-Length"}')).toBe(true);

      const nonsense = await sendRaw(server.addr, "NONSENSE\r\n\r\n");
      expect(firstLine(nonsense)).toBe("HTTP/1.1 400 Bad Request");
      expect(nonsense.endsWith('{"error":"Malformed request"}')).toBe(true);

      const badCl = await sendRaw(
        server.addr,
        `GET /api/health HTTP/1.1\r\n${hostHeader}Content-Length: many\r\n\r\n`,
      );
      expect(firstLine(badCl)).toBe("HTTP/1.1 400 Bad Request");
      expect(badCl.endsWith('{"error":"Malformed Content-Length"}')).toBe(true);

      const emptyCl = await sendRaw(
        server.addr,
        `GET /api/health HTTP/1.1\r\n${hostHeader}Content-Length: \r\n\r\n`,
      );
      expect(firstLine(emptyCl)).toBe("HTTP/1.1 400 Bad Request");
      expect(emptyCl.endsWith('{"error":"Malformed Content-Length"}')).toBe(true);

      const hugeHead = await sendRaw(server.addr, `GET /${"a".repeat(70_000)} HTTP/1.1\r\n\r\n`);
      expect(firstLine(hugeHead)).toBe("HTTP/1.1 431 Request Header Fields Too Large");
      expect(hugeHead.endsWith('{"error":"Request headers too large"}')).toBe(true);

      // 4. Expect: 100-continue asks for the body before reading it.
      const expStream = await connectTcp(server.addr);
      expStream.write(
        `POST /api/wechat/verify HTTP/1.1\r\n${hostHeader}Content-Type: application/json\r\nExpect: 100-continue\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
      );
      const goBuf = await readUntil(expStream, (buf) => buf.toString("utf8").includes("100 Continue\r\n\r\n"));
      expect(goBuf.toString("utf8")).toBe("HTTP/1.1 100 Continue\r\n\r\n");
      expStream.write(body);
      const answer = (await readUntil(expStream, () => false)).toString("utf8");
      expStream.destroy();
      expect(answer.startsWith("HTTP/1.1 400 Bad Request\r\n")).toBe(true);

      // 5. Shutdown closes idle connections with EOF and frees the port.
      const idle = await connectTcp(server.addr);
      const closedAddr = server.addr;
      const idleEnd = new Promise<number>((resolve) => {
        let bytes = 0;
        idle.on("data", (c: Buffer) => {
          bytes += c.byteLength;
        });
        idle.on("end", () => resolve(bytes));
        idle.on("close", () => resolve(bytes));
        idle.on("error", () => resolve(bytes));
      });
      await server.shutdown();
      expect(await idleEnd).toBe(0);
      idle.destroy();

      let connectFailed = false;
      try {
        const s = await connectTcp(closedAddr);
        s.destroy();
      } catch {
        connectFailed = true;
      }
      expect(connectFailed).toBe(true);
    } finally {
      await server.shutdown();
    }
  });

  test("handles fragmented headers across chunks, pipelined requests, and large (>256KiB) request/response bodies", async () => {
    const server = await Server.bind("127.0.0.1", 0, (req) => {
      if (req.path === "/echo") {
        return Response.bytes(200, req.body, "application/octet-stream");
      }
      return Response.json(200, { path: req.path, query: req.query, len: req.body.byteLength });
    });

    try {
      // Fragmented headers where `\r\n\r\n` is split across separate writes.
      const s = await connectTcp(server.addr);
      s.write("GET /frag?a=1 ");
      await Bun.sleep(10);
      s.write("HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r");
      await Bun.sleep(10);
      s.write("\n\r\n");
      const fragResp = (await readUntil(s, () => false)).toString("utf8");
      s.destroy();
      expect(fragResp.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
      expect(fragResp.endsWith('{"path":"/frag","query":"a=1","len":0}')).toBe(true);

      // Fragmented oversized header (> 64 KiB across multiple chunks) -> 431.
      const bigHdrSock = await connectTcp(server.addr);
      const chunk20k = "a".repeat(20_000);
      bigHdrSock.write(`GET /${chunk20k}`);
      await Bun.sleep(5);
      bigHdrSock.write(chunk20k);
      await Bun.sleep(5);
      bigHdrSock.write(chunk20k);
      await Bun.sleep(5);
      bigHdrSock.write(`${chunk20k} HTTP/1.1\r\n\r\n`);
      const bigHdrResp = (await readUntil(bigHdrSock, () => false)).toString("utf8");
      bigHdrSock.destroy();
      expect(bigHdrResp.startsWith("HTTP/1.1 431 Request Header Fields Too Large\r\n")).toBe(true);

      // Pipelined requests sent in a single TCP write.
      const pipeResp = await sendRaw(
        server.addr,
        "GET /one HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nGET /two HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
      );
      expect(pipeResp).toContain('{"path":"/one","query":"","len":0}');
      expect(pipeResp).toContain('{"path":"/two","query":"","len":0}');

      // Large body (512 KiB > 256 KiB inline threshold) echoed back intact via Bun fetch.
      const payload = new Uint8Array(512 * 1024);
      for (let i = 0; i < payload.byteLength; i++) {
        payload[i] = i & 0xff;
      }
      const res = await fetch(`${server.url()}/echo`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: payload,
      });
      expect(res.status).toBe(200);
      const echoed = new Uint8Array(await res.arrayBuffer());
      expect(echoed.byteLength).toBe(payload.byteLength);
      expect(Buffer.compare(Buffer.from(echoed), Buffer.from(payload))).toBe(0);
    } finally {
      await server.shutdown();
    }
  });

  test("returns 408 Request Timeout when body does not arrive in time, and finishes in-flight requests on shutdown", async () => {
    let releaseHandler!: () => void;
    let handlerEntered!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      handlerEntered = r;
    });
    const gatePromise = new Promise<void>((r) => {
      releaseHandler = r;
    });

    const server = await Server.bind(
      "127.0.0.1",
      0,
      async (req) => {
        if (req.path === "/slow") {
          handlerEntered();
          await gatePromise;
          return Response.json(200, { finished: true });
        }
        return Response.json(200, { ok: true });
      },
      { bodyTimeoutMs: 80 },
    );

    try {
      // Body timeout -> 408
      const timeoutResp = await sendRaw(
        server.addr,
        "POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\npartial",
      );
      expect(timeoutResp.startsWith("HTTP/1.1 408 Request Timeout\r\n")).toBe(true);
      expect(timeoutResp.endsWith('{"error":"The request body did not arrive in time"}')).toBe(true);

      // In-flight request completes with `connection: close` during shutdown.
      const inflight = sendRaw(server.addr, "GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      await enteredPromise;
      const shuttingDown = server.shutdown();
      await Bun.sleep(20);
      releaseHandler();
      const resp = await inflight;
      await shuttingDown;
      expect(resp.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
      expect(resp.includes("connection: close\r\n")).toBe(true);
      expect(resp.endsWith('{"finished":true}')).toBe(true);
    } finally {
      releaseHandler();
      await server.shutdown();
    }
  });

  test("enforces maxConnections limit by dropping excess connections", async () => {
    const server = await Server.bind(
      "127.0.0.1",
      0,
      () => Response.json(200, { ok: true }),
      { maxConnections: 1 },
    );
    try {
      // Occupy the single connection slot with an idle keep-alive socket.
      const holder = await connectTcp(server.addr);
      holder.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      await readUntil(holder, (b) => b.toString("utf8").includes('{"ok":true}'));

      // Second concurrent socket should be dropped unanswered.
      const dropped = await sendRaw(server.addr, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").catch(
        () => "",
      );
      expect(dropped).toBe("");
      holder.destroy();
    } finally {
      await server.shutdown();
    }
  });

  test("handles half-open client FIN, invalid UTF-8 head, exact 64 KiB head boundary, HTTP/1.0 keep-alive, head timeout, and bind error", async () => {
    const server = await Server.bind(
      "127.0.0.1",
      0,
      async (req) => {
        if (req.path === "/delayed") {
          await Bun.sleep(20);
        }
        return Response.json(200, { path: req.path, len: req.body.byteLength });
      },
      { headTimeoutMs: 80 },
    );

    try {
      // 1. Client half-closes immediately (socket.end) while handler is async: still receives full response!
      const halfOpen = await connectTcp(server.addr);
      const halfOpenResp = new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        halfOpen.on("data", (c: Buffer) => chunks.push(c));
        halfOpen.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        halfOpen.on("error", reject);
      });
      halfOpen.end("GET /delayed HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      const received = await halfOpenResp;
      halfOpen.destroy();
      expect(received.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
      expect(received.endsWith('{"path":"/delayed","len":0}')).toBe(true);

      // 2. Invalid UTF-8 bytes in request head -> 400 Bad Request
      const badUtf8 = Buffer.concat([
        Buffer.from("GET /"),
        Buffer.from([0xff, 0xfe]),
        Buffer.from(" HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"),
      ]);
      const utf8Resp = await sendRaw(server.addr, badUtf8);
      expect(utf8Resp.startsWith("HTTP/1.1 400 Bad Request\r\n")).toBe(true);
      expect(utf8Resp.endsWith('{"error":"Malformed request"}')).toBe(true);

      // 3. Exact MAX_HEAD_BYTES boundary: 65536 bytes accepted, 65537 bytes rejected with 431.
      const prefix = "GET /ok HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nX-Pad: ";
      const exactHead = prefix + "x".repeat(MAX_HEAD_BYTES - prefix.length);
      expect(exactHead.length).toBe(MAX_HEAD_BYTES);
      const exactResp = await sendRaw(server.addr, `${exactHead}\r\n\r\n`);
      expect(exactResp.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);

      const overByOne = `${exactHead}x\r\n\r\n`;
      const overResp = await sendRaw(server.addr, overByOne);
      expect(overResp.startsWith("HTTP/1.1 431 Request Header Fields Too Large\r\n")).toBe(true);

      // 4. HTTP/1.0 defaults to Connection: close
      const http10 = await sendRaw(server.addr, "GET /v10 HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
      expect(http10.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
      expect(http10.includes("connection: close\r\n")).toBe(true);

      // 5. Incomplete head times out quietly (headTimeoutMs = 80)
      const idleTimeout = await sendRaw(server.addr, "GET /partial");
      expect(idleTimeout).toBe("");

      // 6. Binding an already-occupied port fails with Rust-compatible message
      let bindErr = "";
      try {
        const dup = await Server.bind("127.0.0.1", server.addr.port, () => Response.json(200, {}));
        await dup.shutdown();
      } catch (err) {
        bindErr = err instanceof Error ? err.message : String(err);
      }
      expect(bindErr).toContain(`Cannot listen on 127.0.0.1:${server.addr.port}:`);
    } finally {
      await server.shutdown();
    }
  });
});

// ============================================================================
// neo-testkit tests (TempDir, findProgram, MockHttpServer, ScriptedDriver/Kernels)
// ============================================================================

describe("testkit", () => {
  test("TempDir creates unique directories, joins paths, cleans up, and supports Symbol.dispose", () => {
    let disposedPath = "";
    {
      using dir = new TempDir("dispose-test");
      disposedPath = dir.path;
      expect(fs.existsSync(dir.path)).toBe(true);
      expect(path.basename(dir.path).startsWith("neo-dispose-test-")).toBe(true);
      const nested = dir.join("sub", "file.txt");
      fs.mkdirSync(path.dirname(nested), { recursive: true });
      fs.writeFileSync(nested, "hello");
      expect(fs.readFileSync(nested, "utf8")).toBe("hello");
    }
    expect(fs.existsSync(disposedPath)).toBe(false);

    const a = new TempDir("uniq");
    const b = new TempDir("uniq");
    try {
      expect(a.path).not.toBe(b.path);
    } finally {
      a.cleanup();
      b.cleanup();
    }
    expect(fs.existsSync(a.path)).toBe(false);
    expect(fs.existsSync(b.path)).toBe(false);
  });

  test("findProgram locates executables on PATH and returns undefined when absent", () => {
    const sh = findProgram("sh");
    expect(sh).toBeDefined();
    expect(fs.statSync(sh!).isFile()).toBe(true);
    expect(findProgram("definitely-nonexistent-neo-binary-xyz")).toBeUndefined();
  });

  test("MockHttpServer records requests, handles dynamic/async handlers, scripted queue, headers, events, and chunked bodies", async () => {
    const server = await serveMockHttp(async (req) => {
      if (req.method === "GET" && req.pathname === "/ilink/bot/get_qrcode_status") {
        await Bun.sleep(15);
        return MockResponse.json(200, { status: "confirmed", query: req.query });
      }
      if (req.method === "POST" && req.pathname === "/cdn/upload") {
        return MockResponse.bytes(200, req.body).header("x-encrypted-param", "download-1");
      }
      if (req.pathname === "/events") {
        return MockResponse.events("data: hello\n\n");
      }
      return MockResponse.text(404, "missing");
    });

    try {
      // 1. Dynamic async handler + query string preserved on req.path
      const res1 = await fetch(`${server.url}/ilink/bot/get_qrcode_status?qrcode=qr%20id`, {
        headers: { Authorization: "Bearer tok-1" },
      });
      expect(res1.status).toBe(200);
      expect(await res1.json()).toEqual({ status: "confirmed", query: "qrcode=qr%20id" });

      // 2. Binary upload + custom response header chaining
      const res2 = await fetch(`${server.url}/cdn/upload`, {
        method: "POST",
        body: new Uint8Array([9, 8, 7]),
      });
      expect(res2.status).toBe(200);
      expect(res2.headers.get("x-encrypted-param")).toBe("download-1");
      expect([...new Uint8Array(await res2.arrayBuffer())]).toEqual([9, 8, 7]);

      // 3. SSE response
      const res3 = await fetch(`${server.url}/events`);
      expect(res3.status).toBe(200);
      expect(res3.headers.get("content-type")).toBe("text/event-stream");
      expect(await res3.text()).toBe("data: hello\n\n");

      // 4. Recorded requests match arrival order
      expect(server.requests.length).toBe(3);
      expect(server.requests[0].path).toBe("/ilink/bot/get_qrcode_status?qrcode=qr%20id");
      expect(server.requests[0].header("authorization")).toBe("Bearer tok-1");
      expect([...server.requests[1].body]).toEqual([9, 8, 7]);

      // 5. Enqueued scripted responses take precedence FIFO over fallback handler
      server.clearRequests();
      server.enqueue(
        MockResponse.json(201, { queued: 1 }),
        (req) => MockResponse.json(200, { echoed: req.json() }),
      );
      const q1 = await fetch(`${server.url}/any`);
      expect(q1.status).toBe(201);
      expect(await q1.json()).toEqual({ queued: 1 });

      const q2 = await fetch(`${server.url}/any`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: 42 }),
      });
      expect(q2.status).toBe(200);
      expect(await q2.json()).toEqual({ echoed: { n: 42 } });

      // 6. Chunked transfer-encoding raw request decoded accurately
      const chunkedRaw = await sendRaw(
        server.addr,
        "POST /cdn/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
      );
      expect(chunkedRaw.endsWith("hello world")).toBe(true);
      expect(server.requests[server.requests.length - 1].text()).toBe("hello world");
    } finally {
      await server.close();
    }

    // Also test standalone queue-only MockHttpServer with AsyncDisposable
    await using queueOnly = await MockHttpServer.start();
    const emptyRes = await fetch(`${queueOnly.url}/unmatched`);
    expect(emptyRes.status).toBe(404);
  });

  test("ScriptedKernels and ScriptedDriver drive a real Session with tools, cards, jobs, hold/release, and close", async () => {
    using dir = new TempDir("scripted-driver");
    const journal = Journal.create(dir.path, dir.path);
    const kernels = new ScriptedKernels();

    const calledTools: Array<{ name: string; args: unknown }> = [];
    const tools: ToolHost = {
      specs: () => [{ name: "ping", description: "Ping", schema: { type: "object" } }],
      async guard(tool) {
        return tool === "blocked" ? guardBlock("not allowed") : GUARD_ALLOW;
      },
      async call(name, args) {
        calledTools.push({ name, args });
        return { pong: true };
      },
    };

    const bgJob: KernelJob = {
      id: "job-1",
      kind: "bash",
      label: "sleep 30",
      startTime: Date.now(),
      own: true,
      pids: [],
    };

    kernels.model = async (turn) => {
      const card = turn.card("kind");
      expect(card?.kind).toBe("candidate");
      expect(turn.has("candidate")).toBe(true);
      const res = await turn.callTool("ping", { v: 1 });
      expect(res).toEqual({ pong: true });
      await expect(turn.callTool("blocked", {})).rejects.toThrow("not allowed");
      turn.jobs.push(bgJob);
      return "Handled candidate.";
    };

    const events = new UnboundedChannel<DriverEvent>();
    const driver = kernels.open("s-1", events, tools, "gemini-flash");
    const session = new Session(journal, driver, events);
    const sub = session.subscribe();

    try {
      kernels.hold();
      await session.send("req-1", [textBlock(JSON.stringify({ kind: "candidate", id: "t1" }))], "queue", {
        display: true,
        fromUser: true,
      });

      // Turn is active and held before model runs.
      await Bun.sleep(20);
      expect(kernels.active).toBe(1);
      expect(kernels.mostActive).toBe(1);
      kernels.release();

      // Wait for agentEnd event with awaitingAsync = true (because bgJob was left running).
      let endEvent: { terminal: boolean; awaitingAsync: boolean } | undefined;
      while (!endEvent) {
        const ev = await sub.recv();
        if (!ev) break;
        if (ev.type === "agentEnd") {
          endEvent = { terminal: ev.terminal, awaitingAsync: ev.awaitingAsync };
        }
      }
      expect(endEvent).toEqual({ terminal: false, awaitingAsync: true });
      expect(calledTools).toEqual([{ name: "ping", args: { v: 1 } }]);
      expect(kernels.ran.length).toBe(1);
      expect(kernels.ran[0].model).toBe("gemini-flash");

      // Cancel respects refuseCancel flag.
      kernels.refuseCancel = true;
      expect(await driver.cancel("job-1")).toBe(false);
      kernels.refuseCancel = false;
      expect(await driver.cancel("job-1")).toBe(true);
      expect((await driver.jobs()).length).toBe(0);

      await driver.setModel("gemini-pro", "high");
      expect(kernels.setModels).toEqual([{ sessionId: "s-1", model: "gemini-pro", thinking: "high" }]);
    } finally {
      sub.close();
      await session.close();
    }

    expect(kernels.closed).toEqual(["s-1"]);
  });
});
