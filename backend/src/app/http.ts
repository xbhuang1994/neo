//! Outbound HTTP/HTTPS client backed by Bun's pooled `fetch`, for the few outbound calls the application makes itself.

/** Maximum response body size read by {@link send} (128 MiB, matching Rust `128 << 20`). */
export const MAX_BODY_BYTES = 128 << 20;

/** Accepted request header forms. */
export type HttpHeadersInput = ReadonlyArray<readonly [string, string]> | Record<string, string> | Headers;

/** A response's status, headers of interest and body. */
export interface HttpResponse {
  /** The status code. */
  status: number;
  /** The body. */
  body: Uint8Array;
  /** The headers asked for in the request, in that order; empty string when absent. */
  headers: string[];
  /** Full response headers. */
  allHeaders: Headers;
}

/** A streaming response's status, headers of interest and readable byte stream. */
export interface HttpStreamResponse {
  /** The status code. */
  status: number;
  /** The response body stream, or `null` when absent. */
  stream: ReadableStream<Uint8Array> | null;
  /** The headers asked for in the request, in that order; empty string when absent. */
  headers: string[];
  /** Full response headers. */
  allHeaders: Headers;
}

/** A parsed JSON response. */
export interface HttpJsonResponse<T = unknown> {
  /** The status code. */
  status: number;
  /** Parsed JSON body. */
  data: T;
  /** The headers asked for in the request, in that order; empty string when absent. */
  headers: string[];
  /** Full response headers. */
  allHeaders: Headers;
}

/** A request to make. */
export interface HttpRequest {
  /** HTTP method such as `GET` or `POST` (defaults to `GET`). */
  method?: string;
  /** The URL. */
  url: string;
  /** Request headers. */
  headers?: HttpHeadersInput;
  /** The body of a `POST` or other payload-bearing method. */
  body?: Uint8Array | ArrayBuffer | string | null;
  /** How long the whole exchange may take, in milliseconds; `0` or omitted disables timeout. */
  timeoutMs?: number;
  /** Optional external abort signal. */
  signal?: AbortSignal;
  /** Response headers to return in `headers`, in order. */
  want?: ReadonlyArray<string>;
  /** Maximum response body bytes to read (defaults to {@link MAX_BODY_BYTES}). */
  maxBytes?: number;
}

/** Why a request got no response. */
export type HttpFailure =
  | {
      /** Nothing came back in time. */
      kind: "timeout";
    }
  | {
      /** The connection or transfer failed. */
      kind: "transport";
      /** Underlying transport error text. */
      message: string;
    };

/** Result of an outbound HTTP call. */
export type HttpResult<T = HttpResponse> = { ok: true; value: T } | { ok: false; error: HttpFailure };

/** Format a {@link HttpFailure} for display, matching Rust `Display for Failure`. */
export function formatFailure(failure: HttpFailure): string {
  return failure.kind === "timeout" ? "The request timed out" : failure.message;
}

function buildHeaders(input: HttpHeadersInput | undefined): Headers | undefined {
  if (!input) {
    return undefined;
  }
  if (input instanceof Headers) {
    return new Headers(input);
  }
  const headers = new Headers();
  if (Array.isArray(input)) {
    for (const [name, value] of input) {
      headers.append(name, value);
    }
  } else {
    for (const [name, value] of Object.entries(input)) {
      headers.set(name, value);
    }
  }
  return headers;
}

function pickHeaders(responseHeaders: Headers, want: ReadonlyArray<string> | undefined): string[] {
  if (!want || want.length === 0) {
    return [];
  }
  const out = new Array<string>(want.length);
  for (let i = 0; i < want.length; i++) {
    out[i] = responseHeaders.get(want[i]) ?? "";
  }
  return out;
}

function isTimeoutText(text: string): boolean {
  return text.includes("timed out") || text.includes("Timeout") || text.includes("timeout");
}

function classifyError(error: unknown, timeoutSignal?: AbortSignal): HttpFailure {
  if (timeoutSignal?.aborted) {
    return { kind: "timeout" };
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (
      error.name === "TimeoutError" ||
      code === "ETIMEDOUT" ||
      code === "ECONNABORTED" ||
      isTimeoutText(error.message)
    ) {
      return { kind: "timeout" };
    }
    return { kind: "transport", message: error.message || String(error) };
  }
  const text = String(error);
  if (isTimeoutText(text)) {
    return { kind: "timeout" };
  }
  return { kind: "transport", message: text };
}

function buildSignal(
  timeoutMs: number | undefined,
  externalSignal: AbortSignal | undefined,
): { signal: AbortSignal | undefined; timeoutSignal: AbortSignal | undefined } {
  let timeoutSignal: AbortSignal | undefined;
  let signal = externalSignal;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutSignal = AbortSignal.timeout(timeoutMs);
    signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  }
  return { signal, timeoutSignal };
}

async function readBodyCapped(response: globalThis.Response, maxBytes: number): Promise<Uint8Array> {
  if (maxBytes <= 0 || !response.body) {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // Ignore cancellation errors on empty cap.
      }
    }
    return new Uint8Array(0);
  }

  const contentEncoding = response.headers.get("content-encoding");
  const contentLengthRaw = response.headers.get("content-length");
  if (!contentEncoding && contentLengthRaw !== null) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isInteger(contentLength) && contentLength >= 0 && contentLength <= maxBytes) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.byteLength === remaining ? value : value.subarray(0, remaining));
        total += remaining;
        try {
          await reader.cancel();
        } catch {
          // Ignore cancel errors after cap is satisfied.
        }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0];
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function executeFetch(
  request: HttpRequest,
): Promise<HttpResult<{ raw: globalThis.Response; timeoutSignal: AbortSignal | undefined }>> {
  const { signal, timeoutSignal } = buildSignal(request.timeoutMs, request.signal);
  const method = request.method && request.method.length > 0 ? request.method : "GET";
  const init: RequestInit = { method };
  const headers = buildHeaders(request.headers);
  if (headers) {
    init.headers = headers;
  }
  if (request.body !== undefined && request.body !== null) {
    init.body = request.body as NonNullable<RequestInit["body"]>;
  }
  if (signal) {
    init.signal = signal;
  }

  try {
    // A status the server chose is a response, not a failure.
    const raw = await fetch(request.url, init);
    return { ok: true, value: { raw, timeoutSignal } };
  } catch (error) {
    return { ok: false, error: classifyError(error, timeoutSignal) };
  }
}

/** Make an outbound HTTP request and read up to `maxBytes` (default 128 MiB) of response body. */
export async function send(request: HttpRequest): Promise<HttpResult<HttpResponse>> {
  const fetched = await executeFetch(request);
  if (!fetched.ok) {
    return fetched;
  }
  const { raw, timeoutSignal } = fetched.value;
  const status = raw.status;
  const headers = pickHeaders(raw.headers, request.want);
  const maxBytes = request.maxBytes ?? MAX_BODY_BYTES;
  try {
    const body = await readBodyCapped(raw, maxBytes);
    return {
      ok: true,
      value: { status, body, headers, allHeaders: raw.headers },
    };
  } catch (error) {
    return { ok: false, error: classifyError(error, timeoutSignal) };
  }
}

/** Make an outbound HTTP request and return the response body stream without buffering. */
export async function sendStream(request: HttpRequest): Promise<HttpResult<HttpStreamResponse>> {
  const fetched = await executeFetch(request);
  if (!fetched.ok) {
    return fetched;
  }
  const { raw } = fetched.value;
  return {
    ok: true,
    value: {
      status: raw.status,
      stream: raw.body,
      headers: pickHeaders(raw.headers, request.want),
      allHeaders: raw.headers,
    },
  };
}

/** Make an outbound HTTP request with optional JSON body and decode the response body as JSON. */
export async function sendJson<T = unknown>(
  request: Omit<HttpRequest, "body"> & { json?: unknown; body?: HttpRequest["body"] },
): Promise<HttpResult<HttpJsonResponse<T>>> {
  const headers = buildHeaders(request.headers) ?? new Headers();
  let body = request.body;
  if (request.json !== undefined) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    body = JSON.stringify(request.json);
  }
  const res = await send({ ...request, headers, body });
  if (!res.ok) {
    return res;
  }
  const { status, body: bytes, headers: wanted, allHeaders } = res.value;
  try {
    const text = new TextDecoder().decode(bytes);
    const data = JSON.parse(text) as T;
    return {
      ok: true,
      value: { status, data, headers: wanted, allHeaders },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { kind: "transport", message: `Invalid JSON response: ${message}` } };
  }
}

export type { HttpFailure as Failure, HttpRequest as Request, HttpResponse as Response };
