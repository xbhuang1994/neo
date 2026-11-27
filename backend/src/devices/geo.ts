/**
 * Lightweight, resilient IP geolocation resolver for Master Neo Device Control Plane.
 *
 * - Validates IP syntax via `node:net` (`isIP`) so untrusted values are never interpolated into URLs.
 * - Detects loopback and private/RFC1918/CGNAT/ULA/link-local addresses locally without external calls.
 * - Resolves public IPs via a bounded multi-provider fallback chain (`ip-api.com` zh-CN -> `whois.pconline.com.cn` -> `ipwho.is`).
 * - Caches positive hits (24h TTL) and negative failures (5m TTL), and deduplicates concurrent in-flight lookups.
 */

import { isIP } from "node:net";

const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 3_000;
const MAX_CACHE_ENTRIES = 1024;

interface GeoCacheEntry {
  location: string | null;
  expiresAtMs: number;
}

export type IpGeoLookupFn = (ip: string) => Promise<string | null>;

export interface IpGeoResolverOptions {
  fetchFn?: typeof fetch;
  lookupFn?: IpGeoLookupFn;
  timeoutMs?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  nowMs?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize an IP string (trims whitespace, unwraps IPv4-mapped IPv6 `::ffff:` prefix). */
export function normalizeIpAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1).trim();
  }
  if (value.toLowerCase().startsWith("::ffff:")) {
    value = value.slice(7);
  }
  if (isIP(value) === 0) return null;
  return value;
}

/** Classify loopback/local/private/CGNAT IP addresses without external network calls. */
export function classifyLocalIpLocation(rawIp: string): string | null {
  const ip = normalizeIpAddress(rawIp);
  if (!ip) return null;

  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return "本机";
    if (a === 0) return "本机";
    if (a === 10) return "局域网";
    if (a === 172 && b >= 16 && b <= 31) return "局域网";
    if (a === 192 && b === 168) return "局域网";
    if (a === 169 && b === 254) return "局域网";
    if (a === 100 && b >= 64 && b <= 127) return "内网";
    return null;
  }

  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::" || lower === "0:0:0:0:0:0:0:1" || lower === "0:0:0:0:0:0:0:0") {
      return "本机";
    }
    if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
      return "局域网";
    }
  }
  return null;
}

/** Join non-empty geographic segments while removing duplicates and redundant substrings (e.g. 北京 + 北京市). */
export function formatGeoLocation(segments: ReadonlyArray<string | undefined | null>): string | null {
  const cleaned: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const raw = segments[i];
    if (typeof raw !== "string") continue;
    const part = raw.trim().replace(/\s+/g, " ");
    if (!part) continue;
    const norm = part.toLowerCase().replace(/(省|市|自治区|特别行政区)$/u, "");
    const duplicate = cleaned.some((prev) => {
      const prevNorm = prev.toLowerCase().replace(/(省|市|自治区|特别行政区)$/u, "");
      return prevNorm === norm || prev.toLowerCase() === part.toLowerCase();
    });
    if (!duplicate) {
      cleaned.push(part);
    }
  }
  if (cleaned.length === 0) return null;
  return cleaned.join(" ");
}

function decodePconlineBody(bytes: Uint8Array, contentType: string | null): string {
  const ct = (contentType ?? "").toLowerCase();
  const explicitGbk = ct.includes("gbk") || ct.includes("gb18030") || ct.includes("gb2312");
  if (!explicitGbk) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // Fall through to GB18030/GBK decoding when bytes are not valid UTF-8.
    }
  }
  try {
    return new TextDecoder("gb18030").decode(bytes);
  } catch {
    try {
      return new TextDecoder("gbk").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

async function queryIpApiCom(
  ip: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const res = await fetchFn(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,country,regionName,city`,
      {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!isRecord(data) || data.status !== "success") return null;
    return formatGeoLocation([
      typeof data.country === "string" ? data.country : undefined,
      typeof data.regionName === "string" ? data.regionName : undefined,
      typeof data.city === "string" ? data.city : undefined,
    ]);
  } catch {
    return null;
  }
}

async function queryPconline(
  ip: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const res = await fetchFn(
      `https://whois.pconline.com.cn/ipJson.jsp?ip=${encodeURIComponent(ip)}&json=true`,
      {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = decodePconlineBody(buf, res.headers.get("content-type")).trim();
    const data: unknown = JSON.parse(text);
    if (!isRecord(data)) return null;
    const pro = typeof data.pro === "string" ? data.pro.trim() : "";
    const city = typeof data.city === "string" ? data.city.trim() : "";
    const addr = typeof data.addr === "string" ? data.addr.trim() : "";
    if (pro || city) {
      return formatGeoLocation(["中国", pro, city]);
    }
    if (addr) {
      // Strip ISP suffix when separated by space (e.g. "广东省深圳市 电信" -> "广东省深圳市")
      const locOnly = addr.split(/\s+/)[0]?.trim();
      return formatGeoLocation([locOnly || addr]);
    }
    return null;
  } catch {
    return null;
  }
}

async function queryIpWhoIs(
  ip: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const res = await fetchFn(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!isRecord(data) || data.success !== true) return null;
    return formatGeoLocation([
      typeof data.country === "string" ? data.country : undefined,
      typeof data.region === "string" ? data.region : undefined,
      typeof data.city === "string" ? data.city : undefined,
    ]);
  } catch {
    return null;
  }
}

/**
 * Resolves public IP addresses to human-readable physical geographic locations with caching and deduplication.
 */
export class IpGeoResolver {
  private readonly fetchFn: typeof fetch;
  private readonly lookupFn?: IpGeoLookupFn;
  private readonly timeoutMs: number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly nowMs: () => number;

  private readonly cache = new Map<string, GeoCacheEntry>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(options: IpGeoResolverOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.lookupFn = options.lookupFn;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
    this.positiveTtlMs = options.positiveTtlMs ?? POSITIVE_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? NEGATIVE_TTL_MS;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /** Resolve an IP address to a concise geographic location string (or `null` when unavailable). */
  async lookup(rawIp: string): Promise<string | null> {
    const ip = normalizeIpAddress(rawIp);
    if (!ip) return null;

    const localLabel = classifyLocalIpLocation(ip);
    if (localLabel !== null) {
      return localLabel;
    }

    const now = this.nowMs();
    const cached = this.cache.get(ip);
    if (cached && cached.expiresAtMs > now) {
      return cached.location;
    }

    const pending = this.inFlight.get(ip);
    if (pending) {
      return await pending;
    }

    const task = this.performLookup(ip);
    this.inFlight.set(ip, task);
    try {
      const location = await task;
      const ttl = location !== null ? this.positiveTtlMs : this.negativeTtlMs;
      this.setCache(ip, { location, expiresAtMs: this.nowMs() + ttl });
      return location;
    } finally {
      this.inFlight.delete(ip);
    }
  }

  private setCache(ip: string, entry: GeoCacheEntry): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES && !this.cache.has(ip)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(ip, entry);
  }

  private async performLookup(ip: string): Promise<string | null> {
    if (this.lookupFn) {
      try {
        const custom = await this.lookupFn(ip);
        return typeof custom === "string" && custom.trim().length > 0 ? custom.trim() : null;
      } catch {
        return null;
      }
    }
    const primary = await queryIpApiCom(ip, this.fetchFn, this.timeoutMs);
    if (primary) return primary;
    const secondary = await queryPconline(ip, this.fetchFn, this.timeoutMs);
    if (secondary) return secondary;
    return await queryIpWhoIs(ip, this.fetchFn, this.timeoutMs);
  }
}
