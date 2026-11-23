/**
 * Reproducible performance benchmark suite for Neo's pure TypeScript / Bun backend.
 *
 * Measures throughput (ops/sec) and latency percentiles (mean / p50 / p95 / p99) across all hot paths:
 *   1. `Store` SQLite prepared-statement CRUD, generated-column partial-index queries, and nested savepoints
 *   2. `Engine` full domain lifecycle (receive -> evaluateDue -> decide/accept -> assignmentStarted -> report -> reply)
 *   3. `Journal` O(1) append, O(1) duplicate `requestId` lookup, and `recent(30)` read on a 2,000-entry journal
 *   4. `HTTP API` loopback keep-alive hot polling (`/api/health`, `/api/messages`, `/api/workers`, `/api/activity`, 500 reqs each)
 *   5. `agy-hook` fast-path compiled `dist/neo-agent` cold-start + loopback TCP_NODELAY round-trip (20 iterations)
 *   6. `worker-bin` stand-in cold-start exit 126 on compiled `dist/neo-agent` (10 iterations)
 *   7. `procinfo` Linux `/proc` direct tree & directory sampling latency
 *   8. `text.ts` CJK/mixed `wordCount` throughput (50,000 iterations)
 *
 * Run with: `bun run benchmarks/perf.ts`
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { relayHook } from "../src/agent/hook-fast.ts";
import { App, defaultTimings, RealKernels } from "../src/app/index.ts";
import * as procinfo from "../src/app/procinfo.ts";
import { wordCount } from "../src/app/text.ts";
import { Protocol } from "../src/app/wechat_protocol.ts";
import {
  Engine,
  MemoryRepositories,
  createOutcome,
  formatIso,
  mandateBasisVia,
  workerReport,
  type Assessor,
  type Assignment,
  type Candidate,
  type Executor,
  type GateResult,
  type Json,
  type Mandate,
  type OutboundMessage,
  type Outbox,
  type Policy,
  type ReplyStatus,
  type Repositories,
  type ScopeResult,
  type SourceScope,
  type Thread,
  type Ticket,
  type Trigger,
} from "../src/core/index.ts";
import { serve } from "../src/http/index.ts";
import { Journal, textBlock } from "../src/kernel/index.ts";
import { Store } from "../src/store/index.ts";
import { TempDir } from "../src/testkit/index.ts";

const BACKEND_ROOT = path.resolve(import.meta.dir, "..");
const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";
const NEO_AGENT_BIN = path.join(BACKEND_ROOT, "dist", `neo-agent${EXE_SUFFIX}`);
const BASE_MS = 1_790_121_600_000;
const HEADER_END = Buffer.from("\r\n\r\n");

interface BenchResult {
  readonly category: string;
  readonly name: string;
  readonly iterations: number;
  readonly totalMs: number;
  readonly opsPerSec: number;
  readonly meanUs: number;
  readonly p50Us: number;
  readonly p95Us: number;
  readonly p99Us: number;
  readonly notes?: string;
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const idx = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[idx];
}

function computeStats(
  category: string,
  name: string,
  samplesUs: Float64Array,
  totalNs: number,
  notes?: string,
): BenchResult {
  const iterations = samplesUs.length;
  const sorted = new Float64Array(samplesUs);
  sorted.sort();
  let sum = 0;
  for (let i = 0; i < iterations; i++) {
    sum += samplesUs[i];
  }
  const totalMs = totalNs / 1e6;
  const opsPerSec = totalMs > 0 ? iterations / (totalMs / 1000) : 0;
  return {
    category,
    name,
    iterations,
    totalMs: Number(totalMs.toFixed(3)),
    opsPerSec: Number(opsPerSec.toFixed(1)),
    meanUs: Number((sum / iterations).toFixed(2)),
    p50Us: Number(percentile(sorted, 50).toFixed(2)),
    p95Us: Number(percentile(sorted, 95).toFixed(2)),
    p99Us: Number(percentile(sorted, 99).toFixed(2)),
    ...(notes !== undefined ? { notes } : {}),
  };
}

function measureSync(
  category: string,
  name: string,
  iterations: number,
  warmup: number,
  fn: (iter: number) => void,
  notes?: string,
): BenchResult {
  for (let i = 0; i < warmup; i++) {
    fn(-1 - i);
  }
  const samplesUs = new Float64Array(iterations);
  const overallStart = Bun.nanoseconds();
  for (let i = 0; i < iterations; i++) {
    const t0 = Bun.nanoseconds();
    fn(i);
    samplesUs[i] = (Bun.nanoseconds() - t0) / 1e3;
  }
  const totalNs = Bun.nanoseconds() - overallStart;
  return computeStats(category, name, samplesUs, totalNs, notes);
}

async function measureAsync(
  category: string,
  name: string,
  iterations: number,
  warmup: number,
  fn: (iter: number) => Promise<void>,
  notes?: string,
): Promise<BenchResult> {
  for (let i = 0; i < warmup; i++) {
    await fn(-1 - i);
  }
  const samplesUs = new Float64Array(iterations);
  const overallStart = Bun.nanoseconds();
  for (let i = 0; i < iterations; i++) {
    const t0 = Bun.nanoseconds();
    await fn(i);
    samplesUs[i] = (Bun.nanoseconds() - t0) / 1e3;
  }
  const totalNs = Bun.nanoseconds() - overallStart;
  return computeStats(category, name, samplesUs, totalNs, notes);
}

function makeTicket(index: number, state: "ended" | "open-idle" | "open-active"): Ticket {
  const iso = formatIso(BASE_MS + index * 1000);
  const id = `tkt-bench-${index}`;
  const isEnded = state === "ended";
  const isActive = state === "open-active";
  return {
    id,
    title: `Benchmark ticket #${index}`,
    decisionId: `dec-bench-${index}`,
    mandate: {
      strength: "explicit",
      policyVersion: "v1",
      basis: mandateBasisVia({ via: "addressed", addressed: "direct" }),
      actor: { source: "chat", id: "alice" },
      scope: "benchmark",
    },
    channels: [{ source: "chat", thread: `th-${index}`, address: { message: `m-${index}` } }],
    ended: isEnded ? { at: iso, by: "executor", outcome: "completed" } : undefined,
    assignments: [
      {
        id: `asgn-${index}`,
        state: isActive ? "running" : "ended",
        createdAt: iso,
        startedAt: iso,
        endedAt: isActive ? undefined : iso,
        report: isEnded ? { state: "ready", summary: "Done", at: iso } : undefined,
      },
    ],
    inputs: [],
    undelivered: isActive ? [`in-${index}`] : [],
    digest: `Digest for ticket ${index}`,
    createdAt: iso,
    updatedAt: iso,
    origin: { triggerId: `trg-${index}`, triggerIds: [`trg-${index}`] },
  };
}

// ============================================================================
// 1. Store SQLite prepared-statement CRUD, generated-column queries & savepoints
// ============================================================================

function benchStore(tmp: TempDir): BenchResult[] {
  const results: BenchResult[] = [];
  const store = Store.open(tmp.join("store-bench.sqlite"));
  try {
    // 1,000 tickets: 950 ended, 30 open-idle, 20 open-active (50 open total, 20 active total).
    const tickets: Ticket[] = new Array(1000);
    for (let i = 0; i < 1000; i++) {
      const state = i < 20 ? "open-active" : i < 50 ? "open-idle" : "ended";
      tickets[i] = makeTicket(i, state);
    }

    // Warm up prepared statement cache on a throwaway ticket, then delete or overwrite cleanly.
    store.saveTicket(makeTicket(9999, "ended"));

    results.push(
      measureSync("Store", "saveTicket UPSERT (1,000 rows, WAL)", 1000, 0, (i) => {
        store.saveTicket(tickets[i]);
      }),
    );

    let readCheck = 0;
    results.push(
      measureSync("Store", "ticket(id) prepared point read", 1000, 50, (i) => {
        const idx = ((i % 1000) + 1000) % 1000;
        const found = store.ticket(`tkt-bench-${idx}`);
        if (found !== undefined) readCheck += 1;
      }),
    );
    if (readCheck < 1000) {
      throw new Error(`Store point read check failed: ${readCheck}`);
    }

    // Remove the warmup ticket from open/active counts (it's ended anyway).
    let openCount = 0;
    results.push(
      measureSync(
        "Store",
        "openTickets() generated-col partial index (50/1001)",
        1000,
        20,
        () => {
          openCount = store.openTickets().length;
        },
        "50 open rows out of 1,001 total",
      ),
    );
    if (openCount !== 50) {
      throw new Error(`Expected 50 open tickets, got ${openCount}`);
    }

    let activeCount = 0;
    results.push(
      measureSync(
        "Store",
        "activeTickets() generated-col partial index (20/1001)",
        1000,
        20,
        () => {
          activeCount = store.activeTickets().length;
        },
        "20 active rows out of 1,001 total",
      ),
    );
    if (activeCount !== 20) {
      throw new Error(`Expected 20 active tickets, got ${activeCount}`);
    }

    let nestedCheck = 0;
    results.push(
      measureSync(
        "Store",
        "nested atomic() 3-level savepoint txns",
        1000,
        20,
        (i) => {
          const k = `sp-key-${Math.abs(i) % 64}`;
          store.atomic(() => {
            store.set(k, { step: 1, i });
            store.atomic(() => {
              store.set(k, { step: 2, i });
              store.atomic(() => {
                const v = store.get<{ step: number; i: number }>(k);
                if (v?.step === 2) nestedCheck += 1;
              });
            });
          });
        },
        "3 cached savepoint levels + KV write/read",
      ),
    );
    if (nestedCheck < 1000) {
      throw new Error(`Nested savepoint verification failed: ${nestedCheck}`);
    }
  } finally {
    store.close();
  }
  return results;
}

// ============================================================================
// 2. Engine full domain lifecycle throughput
// ============================================================================

function runEngineLifecycleSuite(
  repo: Repositories,
  label: string,
  iterations: number,
  warmup: number,
): BenchResult {
  const candidates: Candidate[] = [];
  const launches: Array<[Ticket, Assignment]> = [];
  const outboxMap = new Map<string, OutboundMessage>();
  let clockSec = 0;

  const assessor: Assessor = {
    request(candidate: Candidate): void {
      candidates.push(candidate);
    },
  };
  const executor: Executor = {
    start(ticket: Ticket, assignment: Assignment): void {
      launches.push([ticket, assignment]);
    },
    deliver(): void {},
    stop(): void {},
  };
  const outbox: Outbox = {
    send(message: OutboundMessage): void {
      if (!outboxMap.has(message.id)) {
        outboxMap.set(message.id, message);
      }
    },
    status(id: string): ReplyStatus | undefined {
      return outboxMap.has(id) ? "pending" : undefined;
    },
    withdraw(id: string): void {
      outboxMap.delete(id);
    },
  };
  const scope: SourceScope = {
    scope(_source: string, _meta: Json): ScopeResult {
      return { kind: "listened", observed: false, fanout: true };
    },
  };
  const policy: Policy = {
    version: () => "v1",
    paused: () => false,
    gate(t: Trigger, _thread: Thread, _tickets: readonly Ticket[]): GateResult {
      if (t.human) {
        return {
          kind: "admissible",
          strength: "explicit",
          basis: mandateBasisVia({ via: "addressed", addressed: "direct" }),
        };
      }
      return { kind: "inadmissible", reason: "not human" };
    },
    revalidate: (_mandate: Mandate) => true,
    admitsInferred: (rules: readonly string[]) => rules.length > 0,
    evalTimeoutMs: () => 60_000,
  };

  const engine = new Engine({
    repo,
    policy: () => policy,
    scope,
    assessor,
    executor,
    outbox,
    now: () => formatIso(BASE_MS + clockSec * 1000),
  });

  const acceptOutcome = createOutcome(
    { kind: "accept", accept: { title: "Bench task", scope: "small", acknowledgement: "On it." } },
    "requested",
  );

  let seq = 0;
  let completed = 0;
  const result = measureSync(
    "Engine",
    label,
    iterations,
    warmup,
    () => {
      const id = `life-${seq++}`;
      const threadId = `th-${id}`;
      clockSec += 1;
      const trigger: Trigger = {
        id,
        source: "chat",
        threads: [{ source: "chat", id: threadId }],
        actor: { source: "chat", id: "alice" },
        human: true,
        at: formatIso(BASE_MS + clockSec * 1000),
        text: `Please handle ${id}`,
        channel: { source: "chat", thread: threadId, address: { message: id } },
        meta: {},
      };

      candidates.length = 0;
      launches.length = 0;

      const received = engine.receive(trigger);
      if (received !== "stored") {
        throw new Error(`Expected stored, got ${received}`);
      }
      engine.evaluateDue();
      const candidate = candidates.pop();
      if (candidate === undefined) {
        throw new Error("Expected candidate from evaluateDue");
      }
      const decision = engine.decide(id, { ...acceptOutcome, evalId: candidate.evalId });
      const ticketId = decision.ticketId;
      const launch = launches.pop();
      if (ticketId === undefined || launch === undefined) {
        throw new Error("Expected accept decision and launched assignment");
      }
      engine.assignmentStarted(ticketId, launch[1].id);
      engine.report(ticketId, workerReport("ready", "Finished benchmark task."));
      const reply = engine.reply({ purpose: "result", ticketId, text: "Done." });
      if (reply.status !== "pending") {
        throw new Error(`Unexpected reply status: ${reply.status}`);
      }
      completed += 1;
    },
    "receive->evaluateDue->decide->start->report->reply",
  );
  if (completed < iterations) {
    throw new Error(`Engine lifecycle mismatch: ${completed}`);
  }
  return result;
}

function benchEngine(tmp: TempDir): BenchResult[] {
  const results: BenchResult[] = [];
  const memRepo = new MemoryRepositories();
  results.push(runEngineLifecycleSuite(memRepo, "Engine full lifecycle (MemoryRepositories)", 1000, 50));

  const sqliteStore = Store.open(tmp.join("engine-bench.sqlite"));
  try {
    results.push(runEngineLifecycleSuite(sqliteStore, "Engine full lifecycle (SQLite WAL)", 250, 10));
  } finally {
    sqliteStore.close();
  }
  return results;
}

// ============================================================================
// 3. Journal O(1) append, duplicate requestId lookup & recent(30)
// ============================================================================

function benchJournal(tmp: TempDir): BenchResult[] {
  const results: BenchResult[] = [];
  const journal = Journal.create(tmp.join("journals"), tmp.path);
  try {
    const entryCount = 2000;
    results.push(
      measureSync(
        "Journal",
        "appendCustom (2,000 JSONL entries)",
        entryCount,
        0,
        (i) => {
          journal.appendCustom(
            [textBlock(`Journal benchmark message #${i}: verifying O(1) append & request index.`)],
            true,
            { requestId: `req-${i}`, source: "web-panel" },
            "user",
          );
        },
        "file-backed append + O(1) Map indexing",
      ),
    );
    journal.flush();

    if (journal.len() !== entryCount) {
      throw new Error(`Expected ${entryCount} journal entries, got ${journal.len()}`);
    }

    let foundCount = 0;
    results.push(
      measureSync(
        "Journal",
        "hasRequest + request(id) O(1) lookup (2k journal)",
        50_000,
        1000,
        (i) => {
          const n = Math.abs(i);
          if ((n & 1) === 0) {
            const key = `req-${n % entryCount}`;
            if (journal.hasRequest(key) && journal.request(key) !== undefined) {
              foundCount += 1;
            }
          } else {
            const miss = `req-missing-${n % entryCount}`;
            if (!journal.hasRequest(miss)) {
              foundCount += 1;
            }
          }
        },
        "50% hits / 50% misses on 2,000-entry journal",
      ),
    );
    if (foundCount < 50_000) {
      throw new Error(`Journal lookup verification failed: ${foundCount}`);
    }

    let tailCheck = 0;
    results.push(
      measureSync(
        "Journal",
        "recent(30) / entriesTail(30) on 2,000-entry journal",
        10_000,
        500,
        () => {
          const [start, entries] = journal.entriesTail(30);
          if (start === entryCount - 30 && entries.length === 30) {
            tailCheck += 1;
          }
        },
      ),
    );
    if (tailCheck < 10_000) {
      throw new Error(`Journal entriesTail verification failed: ${tailCheck}`);
    }
  } finally {
    journal.close();
  }
  return results;
}

// ============================================================================
// 4. HTTP API loopback keep-alive hot polling endpoints (500 reqs each)
// ============================================================================

class KeepAliveClient {
  private readonly socket: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private waiter: ((err?: Error) => void) | null = null;
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      if (this.waiter) {
        const wake = this.waiter;
        this.waiter = null;
        wake();
      }
    });
    const onEnd = (err?: Error): void => {
      this.closed = true;
      if (this.waiter) {
        const wake = this.waiter;
        this.waiter = null;
        wake(err ?? new Error("Keep-alive socket closed unexpectedly"));
      }
    };
    socket.on("end", () => onEnd());
    socket.on("error", (err) => onEnd(err));
    socket.on("close", () => onEnd());
  }

  static async connect(host: string, port: number): Promise<KeepAliveClient> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host, port }, () => {
        s.setNoDelay(true);
        resolve(s);
      });
      s.once("error", reject);
    });
    return new KeepAliveClient(socket);
  }

  private waitMore(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Keep-alive socket already closed"));
    }
    return new Promise<void>((resolve, reject) => {
      this.waiter = (err?: Error) => {
        if (err) reject(err);
        else resolve();
      };
    });
  }

  async get(rawRequest: Buffer): Promise<number> {
    this.socket.write(rawRequest);
    let headEnd = -1;
    while ((headEnd = this.buffer.indexOf(HEADER_END)) === -1) {
      await this.waitMore();
    }
    const head = this.buffer.subarray(0, headEnd).toString("latin1");
    const sp1 = head.indexOf(" ");
    const sp2 = head.indexOf(" ", sp1 + 1);
    const status = Number(head.slice(sp1 + 1, sp2));
    const clMatch = /content-length:\s*(\d+)/i.exec(head);
    const contentLength = clMatch ? Number(clMatch[1]) : 0;
    const totalLen = headEnd + 4 + contentLength;
    while (this.buffer.byteLength < totalLen) {
      await this.waitMore();
    }
    this.buffer = totalLen === this.buffer.byteLength ? Buffer.alloc(0) : this.buffer.subarray(totalLen);
    return status;
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }
}

async function benchHttpApi(tmp: TempDir): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const dataDir = tmp.join("http-bench-data");
  const kernels = new RealKernels({
    find: () => undefined,
    env: {},
    hookRelay: [],
  });
  const app = App.open({ stateDir: dataDir, wechat: new Protocol() }, kernels, defaultTimings());
  // Seed a few ended tickets so /api/workers and /api/activity serialize realistic payloads.
  for (let i = 0; i < 8; i++) {
    app.store.saveTicket(makeTicket(i, "ended"));
  }
  await app.start();
  const server = await serve(app, "127.0.0.1", 0, {});
  const port = server.addr.port;
  const client = await KeepAliveClient.connect("127.0.0.1", port);

  const endpoints = ["/api/health", "/api/messages", "/api/workers", "/api/activity"] as const;
  try {
    for (const endpoint of endpoints) {
      const reqBuf = Buffer.from(
        `GET ${endpoint} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`,
        "latin1",
      );
      results.push(
        await measureAsync("HTTP API", `GET ${endpoint} (keep-alive, 500 reqs)`, 500, 25, async () => {
          const status = await client.get(reqBuf);
          if (status !== 200) {
            throw new Error(`Expected 200 from ${endpoint}, got ${status}`);
          }
        }),
      );
    }
  } finally {
    client.close();
    await server.shutdown();
    await app.stop();
  }
  return results;
}

// ============================================================================
// 5. agy-hook fast-path compiled binary cold-start + loopback TCP_NODELAY
// ============================================================================

async function benchAgyHook(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const replyPayload = '{"decision":"allow"}';
  const rawResponse = Buffer.from(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(replyPayload)}\r\nConnection: close\r\n\r\n${replyPayload}`,
    "utf8",
  );

  const tcpServer = net.createServer((socket) => {
    socket.setNoDelay(true);
    const chunks: Buffer[] = [];
    let headerEnd = -1;
    let contentLen = 0;
    let headerDone = false;
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      if (!headerDone) {
        headerEnd = buf.indexOf(HEADER_END);
        if (headerEnd !== -1) {
          headerDone = true;
          const match = /content-length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString("latin1"));
          contentLen = match ? Number(match[1]) : 0;
        }
      }
      if (headerDone && buf.byteLength >= headerEnd + 4 + contentLen) {
        socket.end(rawResponse);
      }
    });
  });

  await new Promise<void>((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
  const addr = tcpServer.address();
  if (!addr || typeof addr === "string") {
    tcpServer.close();
    throw new Error("Expected TCP address for agy-hook benchmark");
  }
  const hookUrl = `http://127.0.0.1:${addr.port}/hook/bench`;
  const hookPayloadStr = JSON.stringify({
    toolCall: { name: "read_file", arguments: { path: "README.md" } },
  });
  const hookPayloadBytes = Buffer.from(hookPayloadStr, "utf8");

  try {
    // 5a. Compiled standalone binary cold-start + loopback round-trip (20 iterations)
    results.push(
      await measureAsync(
        "agy-hook",
        "dist/neo-agent agy-hook cold-start + TCP_NODELAY",
        20,
        2,
        async () => {
          const proc = Bun.spawn([NEO_AGENT_BIN, "agy-hook", hookUrl], {
            stdin: new Response(hookPayloadStr),
            stdout: "pipe",
            stderr: "pipe",
          });
          const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
          if (code !== 0 || stdout !== replyPayload) {
            const stderr = await new Response(proc.stderr).text();
            throw new Error(`agy-hook failed (code=${code}): stdout=${stdout}, stderr=${stderr}`);
          }
        },
        "compiled binary spawn + loopback POST",
      ),
    );

    // 5b. In-process relayHook pure TCP_NODELAY round-trip (200 iterations)
    results.push(
      await measureAsync(
        "agy-hook",
        "relayHook() in-process loopback TCP_NODELAY",
        200,
        10,
        async () => {
          const res = await relayHook(hookUrl, hookPayloadBytes);
          if (!res.ok || res.body.byteLength !== replyPayload.length) {
            throw new Error(`relayHook failed: ${res.ok ? "bad body" : res.error}`);
          }
        },
      ),
    );
  } finally {
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
  }
  return results;
}

// ============================================================================
// 6. worker-bin stand-in cold-start exit 126 on compiled dist/neo-agent
// ============================================================================

async function benchWorkerBin(tmp: TempDir): Promise<BenchResult[]> {
  const folder = tmp.join("worker-bin");
  fs.mkdirSync(folder, { recursive: true });
  const standIn = path.join(folder, `docker${EXE_SUFFIX}`);
  try {
    fs.linkSync(NEO_AGENT_BIN, standIn);
  } catch {
    fs.copyFileSync(NEO_AGENT_BIN, standIn);
  }
  if (process.platform !== "win32") {
    fs.chmodSync(standIn, 0o755);
  }

  const res = await measureAsync(
    "worker-bin",
    "dist/neo-agent worker-bin stand-in cold-start (exit 126)",
    10,
    2,
    async () => {
      const proc = Bun.spawn([standIn, "run", "--rm", "alpine"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code !== 126 || stderr.length === 0) {
        throw new Error(`worker-bin stand-in failed: exit=${code}, stderr=${stderr}`);
      }
    },
    "zero heavy imports fast-path",
  );
  return [res];
}

// ============================================================================
// 7. procinfo Linux /proc direct tree & directory sampling latency
// ============================================================================

function benchProcinfo(tmp: TempDir): BenchResult[] {
  const results: BenchResult[] = [];
  const isLinux = process.platform === "linux";

  if (isLinux) {
    let snapCount = 0;
    results.push(
      measureSync("procinfo", "linuxSnapshot(self) /proc/<pid>/{stat,cmdline}", 500, 20, () => {
        const snap = procinfo.linuxSnapshot(process.pid);
        if (snap !== null) snapCount += 1;
      }),
    );
    if (snapCount < 500) {
      throw new Error(`linuxSnapshot failed: ${snapCount}`);
    }
  }

  let treeCount = 0;
  results.push(
    measureSync(
      "procinfo",
      isLinux ? "tree([self]) Linux /proc direct walk" : "tree([self]) fallback",
      isLinux ? 200 : 15,
      isLinux ? 10 : 2,
      () => {
        const nodes = procinfo.tree([process.pid]);
        if (nodes.length >= 1) treeCount += 1;
      },
    ),
  );
  if (treeCount === 0) {
    throw new Error("procinfo.tree returned empty");
  }

  let dirSamples = 0;
  results.push(
    measureSync(
      "procinfo",
      isLinux ? "inDirectory(tmp) Linux /proc cwd scan" : "inDirectory(tmp) fallback",
      isLinux ? 50 : 10,
      isLinux ? 5 : 1,
      () => {
        const pids = procinfo.inDirectory(tmp.path);
        dirSamples += pids.length + 1;
      },
    ),
  );
  if (dirSamples === 0) {
    throw new Error("procinfo.inDirectory failed");
  }
  return results;
}

// ============================================================================
// 8. text.ts CJK/mixed wordCount throughput (50,000 iterations)
// ============================================================================

function benchText(): BenchResult[] {
  const samples = [
    "已完成 PR #42 的 SQLite WAL 性能优化，p99 延迟从 12.4ms 降到 0.35ms，don't forget snake_case and well-known v1.2 checks!",
    "请把这次重构的测试覆盖率和性能基准整理成一份简洁汇报，重点列出核心指标。",
    "The pure TypeScript backend on Bun passes all strict type checks, handles HTTP/1.1 keep-alive cleanly, and runs lock-free O(1) journal lookups.",
    "混合テキストテスト：日本語カナ・한글음절・汉字 mixed with v2.0.1-alpha_3 & it's fast!",
  ] as const;

  let checksum = 0;
  const res = measureSync(
    "text",
    "wordCount() CJK/mixed/ASCII (50,000 iters)",
    50_000,
    2_000,
    (i) => {
      const text = samples[Math.abs(i) & 3];
      checksum += wordCount(text);
    },
    "4 rotating CJK/mixed/English/kana/Hangul strings",
  );
  if (checksum <= 0) {
    throw new Error("Unexpected wordCount checksum");
  }
  return [res];
}

// ============================================================================
// Formatting & Runner
// ============================================================================

function formatLatency(us: number): string {
  if (us >= 1000) {
    return `${(us / 1000).toFixed(2)} ms`;
  }
  return `${us.toFixed(2)} us`;
}

function formatOps(ops: number): string {
  return Math.round(ops).toLocaleString("en-US");
}

function printMarkdownTable(results: readonly BenchResult[]): void {
  const headers = ["Category", "Benchmark", "Iters", "Ops/sec", "Mean", "p50", "p95", "p99"];
  const rows = results.map((r) => [
    r.category,
    r.name,
    r.iterations.toLocaleString("en-US"),
    formatOps(r.opsPerSec),
    formatLatency(r.meanUs),
    formatLatency(r.p50Us),
    formatLatency(r.p95Us),
    formatLatency(r.p99Us),
  ]);

  const widths = headers.map((h, idx) => Math.max(h.length, ...rows.map((row) => row[idx].length)));
  const alignRight = [false, false, true, true, true, true, true, true];

  const padCell = (val: string, idx: number): string =>
    alignRight[idx] ? val.padStart(widths[idx]) : val.padEnd(widths[idx]);

  const headerLine = `| ${headers.map((h, i) => padCell(h, i)).join(" | ")} |`;
  const sepLine = `| ${widths
    .map((w, i) => (alignRight[i] ? `${"-".repeat(Math.max(1, w - 1))}:` : "-".repeat(w)))
    .join(" | ")} |`;

  console.log("\n### Neo Pure-TypeScript Backend Performance Benchmark\n");
  console.log(headerLine);
  console.log(sepLine);
  for (const row of rows) {
    console.log(`| ${row.map((cell, i) => padCell(cell, i)).join(" | ")} |`);
  }
  console.log("");
}

async function main(): Promise<void> {
  if (!fs.existsSync(NEO_AGENT_BIN)) {
    throw new Error(`Compiled neo-agent binary not found at ${NEO_AGENT_BIN}; run \`bun run build\` first.`);
  }

  const tmp = new TempDir("perf-bench");
  const allResults: BenchResult[] = [];
  const suiteStart = Bun.nanoseconds();

  try {
    allResults.push(...benchStore(tmp));
    allResults.push(...benchEngine(tmp));
    allResults.push(...benchJournal(tmp));
    allResults.push(...(await benchHttpApi(tmp)));
    allResults.push(...(await benchAgyHook()));
    allResults.push(...(await benchWorkerBin(tmp)));
    allResults.push(...benchProcinfo(tmp));
    allResults.push(...benchText());
  } finally {
    tmp.cleanup();
  }

  const totalSuiteMs = Number(((Bun.nanoseconds() - suiteStart) / 1e6).toFixed(1));
  printMarkdownTable(allResults);

  const summary = {
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
    },
    timestamp: new Date().toISOString(),
    totalSuiteMs,
    benchmarks: allResults,
  };

  console.log("JSON Summary:");
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.main) {
  await main();
}
