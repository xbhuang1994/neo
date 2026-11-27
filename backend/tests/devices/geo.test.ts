import { describe, expect, test } from "bun:test";
import {
  IpGeoResolver,
  classifyLocalIpLocation,
  formatGeoLocation,
  normalizeIpAddress,
} from "../../src/devices/index.ts";

describe("devices/geo", () => {
  test("normalizes valid IPv4/IPv6 addresses and classifies local/private ranges without network calls", () => {
    expect(normalizeIpAddress(" 113.87.160.22 ")).toBe("113.87.160.22");
    expect(normalizeIpAddress("::ffff:113.87.160.22")).toBe("113.87.160.22");
    expect(normalizeIpAddress("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeIpAddress("not-an-ip")).toBeNull();
    expect(normalizeIpAddress("1.2.3.4/evil")).toBeNull();

    expect(classifyLocalIpLocation("127.0.0.1")).toBe("本机");
    expect(classifyLocalIpLocation("::1")).toBe("本机");
    expect(classifyLocalIpLocation("10.0.0.8")).toBe("局域网");
    expect(classifyLocalIpLocation("172.16.5.4")).toBe("局域网");
    expect(classifyLocalIpLocation("192.168.1.50")).toBe("局域网");
    expect(classifyLocalIpLocation("169.254.1.2")).toBe("局域网");
    expect(classifyLocalIpLocation("fd12:3456::1")).toBe("局域网");
    expect(classifyLocalIpLocation("fe80::1")).toBe("局域网");
    expect(classifyLocalIpLocation("100.64.12.34")).toBe("内网");
    expect(classifyLocalIpLocation("113.87.160.22")).toBeNull();
  });

  test("deduplicates redundant geographic segments cleanly", () => {
    expect(formatGeoLocation(["中国", "广东", "深圳"])).toBe("中国 广东 深圳");
    expect(formatGeoLocation(["中国", "北京", "北京市"])).toBe("中国 北京");
    expect(formatGeoLocation(["中国", "香港特别行政区", "香港"])).toBe("中国 香港特别行政区");
    expect(formatGeoLocation(["Singapore", "Singapore"])).toBe("Singapore");
    expect(formatGeoLocation(["", null, undefined])).toBeNull();
  });

  test("IpGeoResolver uses primary ip-api.com, falls back across providers, caches TTL, and deduplicates concurrent lookups", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const resolver = new IpGeoResolver({
      nowMs: () => now,
      positiveTtlMs: 60_000,
      negativeTtlMs: 10_000,
      fetchFn: (async (url: string | URL) => {
        const s = String(url);
        calls.push(s);
        if (s.includes("ip-api.com") && s.includes("113.87.160.22")) {
          await new Promise((r) => setTimeout(r, 15));
          return new Response(
            JSON.stringify({
              status: "success",
              country: "中国",
              regionName: "广东",
              city: "深圳",
            }),
            { status: 200 },
          );
        }
        if (s.includes("ip-api.com") && s.includes("58.248.102.18")) {
          return new Response("rate limited", { status: 429 });
        }
        if (s.includes("pconline.com.cn") && s.includes("58.248.102.18")) {
          // Real GBK bytes for {"pro":"广东省","city":"广州市"}
          const gbkBytes = new Uint8Array([
            0x7b, 0x22, 0x70, 0x72, 0x6f, 0x22, 0x3a, 0x22, 0xb9, 0xe3, 0xb6, 0xab, 0xca, 0xa1,
            0x22, 0x2c, 0x22, 0x63, 0x69, 0x74, 0x79, 0x22, 0x3a, 0x22, 0xb9, 0xe3, 0xd6, 0xdd,
            0xca, 0xd0, 0x22, 0x7d,
          ]);
          return new Response(gbkBytes, {
            status: 200,
            headers: { "content-type": "application/json; charset=GBK" },
          });
        }
        if (s.includes("ipwho.is") && s.includes("8.8.8.8")) {
          return new Response(
            JSON.stringify({
              success: true,
              country: "United States",
              region: "California",
              city: "Mountain View",
            }),
            { status: 200 },
          );
        }
        return new Response("fail", { status: 500 });
      }) as unknown as typeof fetch,
    });

    // Local IP never hits fetch
    expect(await resolver.lookup("192.168.1.9")).toBe("局域网");
    expect(calls.length).toBe(0);

    // Concurrent lookups for the same public IP share a single in-flight fetch
    const [r1, r2] = await Promise.all([
      resolver.lookup("113.87.160.22"),
      resolver.lookup("113.87.160.22"),
    ]);
    expect(r1).toBe("中国 广东 深圳");
    expect(r2).toBe("中国 广东 深圳");
    expect(calls.length).toBe(1);

    // Cached hit avoids repeat fetch
    expect(await resolver.lookup("113.87.160.22")).toBe("中国 广东 深圳");
    expect(calls.length).toBe(1);

    // Fallback to pconline when ip-api.com fails
    expect(await resolver.lookup("58.248.102.18")).toBe("中国 广东省 广州市");

    // Fallback to ipwho.is when both ip-api.com and pconline fail
    expect(await resolver.lookup("8.8.8.8")).toBe("United States California Mountain View");

    // Negative failure cached briefly, then retried after TTL expiry
    const beforeFail = calls.length;
    expect(await resolver.lookup("1.1.1.1")).toBeNull();
    const afterFail = calls.length;
    expect(afterFail).toBe(beforeFail + 3);
    expect(await resolver.lookup("1.1.1.1")).toBeNull();
    expect(calls.length).toBe(afterFail);

    now += 15_000;
    expect(await resolver.lookup("1.1.1.1")).toBeNull();
    expect(calls.length).toBe(afterFail + 3);
  });
});
