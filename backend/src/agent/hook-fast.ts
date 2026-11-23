/**
 * Ultra-fast `agy-hook` relay: zero imports from core/store/app/http/kernel.
 * Reads hook JSON from stdin, sends a single-buffer HTTP/1.1 POST over loopback TCP with TCP_NODELAY,
 * writes the 200 response body to stdout, and exits 0 on success or 1 on error.
 */

import fs from "node:fs";
import net from "node:net";

/** Read timeout matching Rust `relay_hook`: 900 seconds. */
export const HOOK_READ_TIMEOUT_MS = 900_000;

/** Outcome of relaying one hook payload over HTTP/1.1. */
export type RelayResult = { ok: true; body: Buffer } | { ok: false; error: string };

interface ParsedHookUrl {
  address: string;
  host: string;
  port: number;
  reqPath: string;
}

const HEADER_END = Buffer.from("\r\n\r\n");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseHookUrl(url: string): { ok: true; value: ParsedHookUrl } | { ok: false; error: string } {
  if (!url.startsWith("http://")) {
    return { ok: false, error: "The hook URL is not http" };
  }
  const rest = url.slice("http://".length);
  const slash = rest.indexOf("/");
  const address = slash === -1 ? rest : rest.slice(0, slash);
  const reqPath = slash === -1 ? "/" : rest.slice(slash);

  let host: string;
  let portStr: string;
  if (address.startsWith("[")) {
    const closeBracket = address.indexOf("]:");
    if (closeBracket === -1) {
      return { ok: false, error: `Cannot reach Neo at ${address}: invalid socket address` };
    }
    host = address.slice(1, closeBracket);
    portStr = address.slice(closeBracket + 2);
  } else {
    const colon = address.lastIndexOf(":");
    if (colon === -1) {
      return { ok: false, error: `Cannot reach Neo at ${address}: invalid socket address` };
    }
    host = address.slice(0, colon);
    portStr = address.slice(colon + 1);
  }

  if (host.length === 0 || !/^[0-9]+$/.test(portStr)) {
    return { ok: false, error: `Cannot reach Neo at ${address}: invalid socket address` };
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `Cannot reach Neo at ${address}: invalid socket address` };
  }

  return { ok: true, value: { address, host, port, reqPath } };
}

function secondWhitespaceToken(text: string): string {
  const len = text.length;
  let i = 0;
  while (i < len && text.charCodeAt(i) <= 32) i++;
  while (i < len && text.charCodeAt(i) > 32) i++;
  while (i < len && text.charCodeAt(i) <= 32) i++;
  const start = i;
  while (i < len && text.charCodeAt(i) > 32) i++;
  return text.slice(start, i);
}

/**
 * Relay one hook payload to `url` using a single-buffer HTTP/1.1 POST over `node:net` with `TCP_NODELAY`.
 * Matches Rust `neo_kernel::antigravity::relay_hook` framing, headers, timeouts, and error messages.
 */
export function relayHook(
  url: string,
  body: Uint8Array,
  timeoutMs: number = HOOK_READ_TIMEOUT_MS,
): Promise<RelayResult> {
  const parsed = parseHookUrl(url);
  if (!parsed.ok) {
    return Promise.resolve(parsed);
  }
  const { address, host, port, reqPath } = parsed.value;

  const head = Buffer.from(
    `POST ${reqPath} HTTP/1.1\r\nHost: ${address}\r\nContent-Type: application/json\r\nContent-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`,
    "utf8",
  );
  const requestBuf = Buffer.allocUnsafe(head.byteLength + body.byteLength);
  head.copy(requestBuf, 0);
  if (body.byteLength > 0) {
    Buffer.from(body.buffer, body.byteOffset, body.byteLength).copy(requestBuf, head.byteLength);
  }

  return new Promise<RelayResult>((resolve) => {
    let settled = false;
    let phase: "connecting" | "writing" | "reading" = "connecting";
    const chunks: Buffer[] = [];

    let socket: net.Socket | undefined;

    const finish = (result: RelayResult) => {
      if (settled) return;
      settled = true;
      if (socket !== undefined) {
        socket.setTimeout(0);
        if (!socket.destroyed) {
          socket.destroy();
        }
      }
      resolve(result);
    };

    try {
      socket = net.createConnection({ host, port });
    } catch (error) {
      finish({ ok: false, error: `Cannot reach Neo at ${address}: ${errorMessage(error)}` });
      return;
    }

    const activeSocket = socket;
    activeSocket.setNoDelay(true);
    activeSocket.setTimeout(timeoutMs);

    activeSocket.once("connect", () => {
      activeSocket.setNoDelay(true);
      phase = "writing";
      activeSocket.write(requestBuf, (err) => {
        if (err) {
          finish({ ok: false, error: `Cannot send the hook to Neo: ${errorMessage(err)}` });
          return;
        }
        phase = "reading";
      });
    });

    activeSocket.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    activeSocket.once("timeout", () => {
      finish({ ok: false, error: "Neo did not answer the hook: timed out" });
    });

    activeSocket.once("error", (err) => {
      if (phase === "connecting") {
        finish({ ok: false, error: `Cannot reach Neo at ${address}: ${errorMessage(err)}` });
      } else if (phase === "writing") {
        finish({ ok: false, error: `Cannot send the hook to Neo: ${errorMessage(err)}` });
      } else {
        finish({ ok: false, error: `Neo did not answer the hook: ${errorMessage(err)}` });
      }
    });

    activeSocket.once("end", () => {
      if (settled) return;
      const reply =
        chunks.length === 0 ? Buffer.alloc(0) : chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      const split = reply.indexOf(HEADER_END);
      if (split === -1) {
        finish({ ok: false, error: "Neo's answer to the hook is malformed" });
        return;
      }
      const headText = reply.subarray(0, split).toString("utf8");
      const status = secondWhitespaceToken(headText);
      if (status !== "200") {
        finish({ ok: false, error: `Neo answered the hook with status ${status}` });
        return;
      }
      finish({ ok: true, body: reply.subarray(split + 4) });
    });

    activeSocket.once("close", () => {
      if (!settled) {
        finish({ ok: false, error: "Neo did not answer the hook: connection closed" });
      }
    });
  });
}

async function readAllStdin(): Promise<Buffer> {
  try {
    return fs.readFileSync(0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EAGAIN" && code !== "EWOULDBLOCK") {
      throw error;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return chunks.length === 0 ? Buffer.alloc(0) : chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  }
}

async function writeAllFd(fd: number, data: Buffer): Promise<void> {
  if (data.byteLength === 0) return;
  let offset = 0;
  while (offset < data.byteLength) {
    try {
      const written = fs.writeSync(fd, data, offset, data.byteLength - offset);
      if (written <= 0) {
        throw new Error("short write");
      }
      offset += written;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        const stream = fd === 1 ? process.stdout : process.stderr;
        const remaining = data.subarray(offset);
        await new Promise<void>((resolve, reject) => {
          stream.write(remaining, (writeErr) => {
            if (writeErr) reject(writeErr);
            else resolve();
          });
        });
        return;
      }
      throw error;
    }
  }
}

/**
 * Relay stdin to `url` and write the hook answer to stdout.
 */
export async function relayHookStdio(
  url: string,
  timeoutMs: number = HOOK_READ_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Validate URL before blocking on stdin, matching Rust `relay_hook`.
  if (!url.startsWith("http://")) {
    return { ok: false, error: "The hook URL is not http" };
  }

  let body: Buffer;
  try {
    body = await readAllStdin();
  } catch (error) {
    return { ok: false, error: `Cannot read the hook's input: ${errorMessage(error)}` };
  }

  const result = await relayHook(url, body, timeoutMs);
  if (!result.ok) {
    return result;
  }

  try {
    await writeAllFd(1, result.body);
  } catch (error) {
    return { ok: false, error: `Cannot write the hook's answer: ${errorMessage(error)}` };
  }

  return { ok: true };
}

/**
 * CLI entrypoint for `neo-agent agy-hook <url>`: returns exit code `0` on success, `1` on error (writing stderr).
 */
export async function runAgyHook(url: string): Promise<number> {
  const result = await relayHookStdio(url);
  if (result.ok) {
    return 0;
  }
  try {
    await writeAllFd(2, Buffer.from(`${result.error}\n`, "utf8"));
  } catch {
    // Ignore stderr write failure when exiting with error.
  }
  return 1;
}
