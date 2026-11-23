/**
 * Unit and integration tests for kernel types, Journal, Proc, and Session.
 * Ports all tests from Rust `neo-kernel/src/{types,journal,process}.rs` and `tests/session.rs`.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Journal,
  Proc,
  Session,
  UnboundedChannel,
  entryInputIds,
  entryRequestId,
  textBlock,
  textOf,
  uuid,
} from "../../src/kernel/index.ts";
import type {
  Block,
  Deliver,
  Driver,
  DriverEvent,
  EventSubscription,
  KernelEvent,
  KernelJob,
  Line,
  Message,
  Mode,
} from "../../src/kernel/index.ts";

function tempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `neo-${prefix}-${process.pid}-${uuid()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ============================================================================
// types.rs tests
// ============================================================================

describe("types", () => {
  test("makes distinct well-formed uuids", () => {
    const a = uuid();
    const b = uuid();
    expect(a).not.toBe(b);
    expect(a.length).toBe(36);
    expect(a[14]).toBe("4");
    expect(["8", "9", "a", "b"]).toContain(a[19]);
  });

  test("keeps the stored shape of content blocks", () => {
    const blocks: Block[] = [
      textBlock("hi"),
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
    ];
    const stored: unknown = JSON.parse(JSON.stringify(blocks));
    expect(stored).toEqual([
      { type: "text", text: "hi" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
    ]);
    expect(textOf(blocks)).toBe("hi");
  });
});

// ============================================================================
// journal.rs tests
// ============================================================================

describe("Journal", () => {
  test("keeps entries, marks and pending deliveries across reopening", () => {
    const dir = tempDir("journal-reopen");
    try {
      let journalPath: string;
      {
        const journal = Journal.create(dir, "/work");
        journal.setName("Fix typo");
        journal.setKernelSession("antigravity", "c-1");
        journal.setKernelSession("other", "/sessions/o.jsonl");
        journal.setKernelSession("antigravity", "c-2");
        const chat = journal.appendCustom(
          [textBlock("hello")],
          true,
          { requestId: "chat:1", source: "web-panel" },
          "user",
          undefined,
        );
        const relay = journal.appendCustom(
          [textBlock("candidate")],
          false,
          { requestId: "r1", inputIds: ["i1", "i2"] },
          "agent",
          true,
        );
        const notice = journal.appendCustom(
          [textBlock("notice")],
          false,
          { requestId: "n1" },
          undefined,
          false,
        );
        journal.appendMessage({
          role: "assistant",
          content: [textBlock("On it")],
          stopReason: "stop",
        });

        expect(
          journal.pending().map((p) => [entryRequestId(p.entry), p.trigger]),
        ).toEqual([
          ["r1", true],
          ["n1", false],
        ]);
        journal.markTaken([relay.id]);
        expect(journal.isPending(relay.id)).toBe(false);
        expect(journal.isPending(notice.id)).toBe(true);
        expect(journal.isPending(chat.id)).toBe(false);
        expect(entryInputIds(relay)).toEqual(["i1", "i2"]);
        journal.flush();
        journalPath = journal.path();
        journal.close();
      }

      const journal = Journal.open(journalPath);
      expect(journal.len()).toBe(4);
      expect(journal.name()).toBe("Fix typo");
      expect([
        journal.kernelSession("antigravity"),
        journal.kernelSession("other"),
        journal.kernelSession("x"),
      ]).toEqual(["c-2", "/sessions/o.jsonl", undefined]);
      expect(journal.hasRequest("chat:1")).toBe(true);
      expect(journal.hasRequest("r1")).toBe(true);
      expect(journal.hasRequest("missing")).toBe(false);
      expect(entryRequestId(journal.request("r1")!)).toBe("r1");
      expect(journal.request("missing")).toBeUndefined();
      expect(journal.pending().map((p) => entryRequestId(p.entry))).toEqual(["n1"]);
      expect(journal.chat().map((entry) => entryRequestId(entry))).toEqual(["chat:1"]);
      expect(journal.lastAssistantText()).toBe("On it");
      expect(journal.lastStopReason()).toBe("stop");
      expect(journal.entriesFrom(3).length).toBe(1);
      const [tailStart, tail] = journal.entriesTail(2);
      expect(tailStart).toBe(2);
      expect(tail.length).toBe(2);
      expect(entryRequestId(tail[0]!)).toBe("n1");
      const all = journal.entries();
      expect(journal.requestIdsFor([all[2]!.id, all[0]!.id, all[3]!.id])).toEqual([
        "chat:1",
        "n1",
      ]);
      journal.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("survives a line cut off by a crash and refuses a foreign or missing file", () => {
    const dir = tempDir("journal-crash");
    try {
      const created = Journal.create(dir, "/work");
      created.appendCustom([textBlock("kept")], true, { requestId: "a" }, undefined, undefined);
      created.flush();
      const filePath = created.path();
      created.close();

      fs.appendFileSync(filePath, '{"type":"custom_message","id":"cut');

      const reopened = Journal.open(filePath);
      expect(reopened.len()).toBe(1);
      reopened.appendCustom([textBlock("after")], true, { requestId: "b" }, undefined, undefined);
      reopened.flush();
      reopened.close();

      const verified = Journal.open(filePath);
      expect(
        verified
          .entries()
          .map((e) => entryRequestId(e))
          .filter((id): id is string => id !== undefined),
      ).toEqual(["a", "b"]);
      verified.close();

      const foreign = path.join(dir, "other.jsonl");
      fs.writeFileSync(foreign, '{"type":"session"}\n');
      expect(() => Journal.open(foreign)).toThrow(foreign);
      expect(() => Journal.open(foreign)).toThrow("not a session transcript");

      const missing = path.join(dir, "does-not-exist.jsonl");
      expect(() => Journal.open(missing)).toThrow(missing);

      if (process.platform !== "win32") {
        const mode = fs.statSync(filePath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// process.rs tests (Unix)
// ============================================================================

if (process.platform !== "win32") {
  describe("Proc", () => {
    const shell = (script: string) => ({
      program: "/bin/sh",
      args: ["-c", script],
      cwd: os.tmpdir(),
    });

    const nextLine = async (lines: UnboundedChannel<Line>): Promise<Line> => {
      const line = await withTimeout(lines.recv(), 10_000, "child reports in time");
      expect(line).toBeDefined();
      return line!;
    };

    test("exchanges json lines and reports a clean exit", async () => {
      const { proc, lines } = await Proc.spawn(
        shell(`echo '{"type":"ready"}'; echo not json; exec cat`),
      );
      expect(await nextLine(lines)).toEqual({ type: "json", value: { type: "ready" } });
      await proc.send({ type: "prompt", message: "héllo\nworld" });
      const echoed = await nextLine(lines);
      expect(echoed.type).toBe("json");
      if (echoed.type === "json") {
        expect((echoed.value as Record<string, unknown>).message).toBe("héllo\nworld");
      }
      await proc.close(5000);
      expect(await nextLine(lines)).toEqual({ type: "exited" });
      await expect(proc.send({})).rejects.toThrow("input is closed");
    });

    test("reports a failure with the tail of standard error and passes the environment", async () => {
      const prevGone = process.env.NEO_GONE;
      process.env.NEO_GONE = "inherited";
      try {
        const { lines } = await Proc.spawn({
          ...shell(
            `echo "{\\"home\\":\\"$NEO_TEST\\",\\"gone\\":\\"$NEO_GONE\\"}"; echo 'Error: bad flag' >&2; exit 3`,
          ),
          env: { NEO_TEST: "set" },
          envRemove: ["NEO_GONE"],
        });
        expect(await nextLine(lines)).toEqual({
          type: "json",
          value: { home: "set", gone: "" },
        });
        expect(await nextLine(lines)).toEqual({
          type: "exited",
          error: "The runtime ended with exit code 3: Error: bad flag",
        });
        // Parent env was not mutated by env/envRemove.
        expect(process.env.NEO_TEST).toBeUndefined();
        expect(process.env.NEO_GONE).toBe("inherited");
      } finally {
        if (prevGone === undefined) {
          delete process.env.NEO_GONE;
        } else {
          process.env.NEO_GONE = prevGone;
        }
      }

      await expect(
        Proc.spawn({ program: "/nonexistent/runtime", cwd: os.tmpdir() }),
      ).rejects.toThrow("Cannot start /nonexistent/runtime");
    });

    test("ends a child that ignores its input closing together with what it started", async () => {
      const marker = path.join(os.tmpdir(), `neo-proc-${process.pid}-${uuid()}`);
      const script = `(sleep 30; touch '${marker}.late') & echo $! > '${marker}'; echo '{"started":true}'; trap '' HUP; while true; do sleep 1; done`;
      try {
        const { proc, lines } = await Proc.spawn(shell(script));
        const started = await nextLine(lines);
        expect(started.type).toBe("json");
        const grandchild = Number.parseInt(fs.readFileSync(marker, "utf8").trim(), 10);
        expect(grandchild).toBeGreaterThan(1);

        await proc.close(200);
        expect(await nextLine(lines)).toEqual({ type: "exited" });

        // Give the kernel a moment to reap the process group.
        await Bun.sleep(100);
        let alive = false;
        try {
          process.kill(grandchild, 0);
          alive = true;
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      } finally {
        try {
          fs.rmSync(marker, { force: true });
          fs.rmSync(`${marker}.late`, { force: true });
        } catch {
          // ignore
        }
      }
    });
  });
}

// ============================================================================
// tests/session.rs tests
// ============================================================================

type Submission = [string, string, Deliver, string | undefined];

class FakeDriver implements Driver {
  submitted: Submission[] = [];
  failNext: string | undefined;
  closed = false;

  kernel(): string {
    return "fake";
  }

  async submit(
    id: string,
    content: Block[],
    deliver: Deliver,
    resume?: string,
  ): Promise<void> {
    if (this.failNext !== undefined) {
      const err = this.failNext;
      this.failNext = undefined;
      throw new Error(err);
    }
    this.submitted.push([id, textOf(content), deliver, resume]);
  }

  async interrupt(): Promise<void> {}

  async jobs(): Promise<KernelJob[]> {
    return [];
  }

  async acknowledge(_ids: string[]): Promise<void> {}

  async cancel(_id: string): Promise<boolean> {
    return false;
  }

  async setModel(_model?: string, _thinking?: string): Promise<void> {}

  pid(): number | undefined {
    return undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class SessionFixture {
  readonly dir: string;
  readonly session: Session;
  readonly driver: FakeDriver;
  readonly runtime: UnboundedChannel<DriverEvent>;
  readonly events: EventSubscription<KernelEvent>;

  constructor(journal: Journal, dir: string) {
    this.dir = dir;
    this.driver = new FakeDriver();
    this.runtime = new UnboundedChannel<DriverEvent>();
    this.session = new Session(journal, this.driver, this.runtime);
    this.events = this.session.subscribe();
  }

  static create(): SessionFixture {
    const dir = tempDir("session");
    const journal = Journal.create(dir, "/work");
    return new SessionFixture(journal, dir);
  }

  submissions(): Submission[] {
    return this.driver.submitted.slice();
  }

  texts(): string[] {
    return this.driver.submitted.map(([, text]) => text);
  }

  async next(): Promise<KernelEvent> {
    const ev = await withTimeout(this.events.recv(), 5000, "an event arrives");
    expect(ev).toBeDefined();
    return ev!;
  }

  async report(event: DriverEvent): Promise<void> {
    this.runtime.send(event);
    await this.settle();
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    await Bun.sleep(5);
  }

  quiet(): boolean {
    return this.events.tryRecv() === undefined;
  }

  async send(requestId: string, text: string, mode: Mode): Promise<void> {
    await this.session.send(requestId, [textBlock(text)], mode, {}, []);
  }

  cleanup(): void {
    this.events.unsubscribe();
    this.runtime.close();
    this.session.journal().close();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

function said(text: string, stop: string): Message {
  return { role: "assistant", content: [textBlock(text)], stopReason: stop };
}

describe("Session", () => {
  test("delivers a message once however often it is sent", async () => {
    const f = SessionFixture.create();
    try {
      await f.send("r1", "candidate 1", "steer");
      expect(await f.next()).toEqual({ type: "agentStart" });
      expect(f.session.isStreaming()).toBe(true);
      expect(f.session.hasAdmittedSubmission()).toBe(true);
      expect(
        f.submissions().map(([, text, deliver, resume]) => [text, deliver, resume]),
      ).toEqual([["candidate 1", "steer", undefined]]);

      // The same request again changes nothing: the runtime already has it.
      await f.send("r1", "candidate 1 (again)", "steer");
      expect(f.submissions().length).toBe(1);
      expect(f.session.journal().len()).toBe(1);

      const id = f.submissions()[0]![0];
      await f.report({ type: "taken", id });
      expect(await f.next()).toEqual({ type: "taken", requestIds: ["r1"] });
      expect(f.session.journal().pending()).toEqual([]);

      // And once the runtime took it, sending it again does not show it to the model a second time.
      await f.send("r1", "candidate 1", "queue");
      expect(f.submissions().length).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  test("shows the model an injected notice with the next message that asks for a turn", async () => {
    const f = SessionFixture.create();
    try {
      await f.send("n1", "notice: settings changed", "inject");
      f.session.append(
        "chat:1",
        [textBlock("see this picture"), { type: "image", mimeType: "image/png", data: "AAAA" }],
        {
          display: true,
          fromUser: true,
          source: "web-panel",
          attachments: [["a.png", "image/png"]],
        },
        true,
      );
      f.session.append(
        "chat:2",
        [textBlock("plain chat, not for the model")],
        { display: true, fromUser: true, source: "web-panel" },
        false,
      );
      expect(f.submissions()).toEqual([]);
      expect(f.session.isStreaming()).toBe(false);
      expect(f.quiet()).toBe(true);

      await f.send("r1", "candidate", "queue");
      expect(f.texts()).toEqual(["notice: settings changed\n\nsee this picture\ncandidate"]);
      expect(f.submissions()[0]![2]).toBe("followUp");

      const id = f.submissions()[0]![0];
      await f.report({ type: "taken", id });
      expect(await f.next()).toEqual({ type: "agentStart" });
      expect(await f.next()).toEqual({
        type: "taken",
        requestIds: ["n1", "chat:1", "r1"],
      });
      expect(f.session.journal().pending()).toEqual([]);

      // The chat entries carry what the transcript shows.
      const chat = f.session.journal().chat();
      expect(chat.map((e) => entryRequestId(e))).toEqual(["chat:1", "chat:2"]);
      const stored = JSON.parse(JSON.stringify(chat[0])) as Record<string, unknown>;
      expect((stored.details as Record<string, unknown>).attachments).toEqual([
        { name: "a.png", mediaType: "image/png" },
      ]);
      expect([stored.attribution, stored.display]).toEqual(["user", true]);

      // Appending the same chat message again is a no-op.
      f.session.append("chat:2", [textBlock("different")], {}, false);
      expect(f.session.journal().len()).toBe(4);
    } finally {
      f.cleanup();
    }
  });

  test("runs a turn from its first message to the runtime going quiet", async () => {
    const f = SessionFixture.create();
    try {
      await f.send("r1", "go", "queue");
      expect(await f.next()).toEqual({ type: "agentStart" });

      // The runtime goes idle before it took the message: the turn does not end, the message runs next.
      await f.report({ type: "idle", awaitingAsync: false });
      expect(f.quiet()).toBe(true);
      expect(f.session.isStreaming()).toBe(true);

      const id = f.submissions()[0]![0];
      await f.report({ type: "taken", id });
      await f.report({ type: "running" });
      await f.report({ type: "message", message: said("Working", "toolUse") });
      await f.report({ type: "retry" });
      await f.report({
        type: "message",
        message: { role: "toolResult", content: [textBlock("ok")] },
      });
      await f.report({ type: "message", message: said("Done", "stop") });
      await f.report({ type: "idle", awaitingAsync: true });

      const seen: KernelEvent[] = [];
      let ev: KernelEvent | undefined;
      while ((ev = f.events.tryRecv()) !== undefined) {
        seen.push(ev);
      }
      expect(seen.length).toBe(6);
      expect(seen[0]!.type).toBe("taken");
      expect(seen[2]).toEqual({ type: "retry" });
      expect(seen[5]).toEqual({ type: "agentEnd", terminal: false, awaitingAsync: true });
      expect(f.session.isStreaming()).toBe(false);
      expect(f.session.hasAdmittedSubmission()).toBe(false);
      expect(f.session.journal().lastAssistantText()).toBe("Done");

      // A background job wakes the runtime, which then finishes for good.
      await f.report({ type: "running" });
      await f.report({ type: "idle", awaitingAsync: false });
      expect(await f.next()).toEqual({ type: "agentStart" });
      expect(await f.next()).toEqual({ type: "agentEnd", terminal: true, awaitingAsync: false });

      // Quiet again while idle is not a second end.
      await f.report({ type: "idle", awaitingAsync: false });
      expect(f.quiet()).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test("records the runtime's session id and resumes it on the next submission", async () => {
    const f = SessionFixture.create();
    try {
      await f.report({ type: "sessionId", id: "rt-1" });
      await f.send("r1", "go", "queue");
      expect(f.submissions()[0]![3]).toBe("rt-1");
      expect(f.session.journal().kernelSession("fake")).toBe("rt-1");
    } finally {
      f.cleanup();
    }
  });

  test("tells whoever waits when the runtime exits and submits what it had not taken again", async () => {
    const f = SessionFixture.create();
    try {
      // Idle with nothing running: an exit is silent.
      await f.report({ type: "exited", awaited: false });
      expect(f.quiet()).toBe(true);
      expect(f.session.journal().isEmpty()).toBe(true);

      await f.send("r1", "go", "queue");
      expect(await f.next()).toEqual({ type: "agentStart" });

      await f.report({ type: "exited", error: "the runtime crashed", awaited: false });
      expect(await f.next()).toEqual({
        type: "message",
        message: said("the runtime crashed", "error"),
      });
      expect(await f.next()).toEqual({ type: "agentEnd", terminal: true, awaitingAsync: false });
      expect(f.session.journal().lastStopReason()).toBe("error");

      // The delivery is still pending, and sending it again hands it to a new runtime process.
      expect(f.session.journal().pending().length).toBe(1);
      await f.send("r1", "go", "queue");
      expect(f.texts()).toEqual(["go", "go"]);

      // Background jobs lost with the runtime are reported even when no turn ran.
      const id = f.submissions()[1]![0];
      await f.report({ type: "taken", id });
      await f.report({ type: "idle", awaitingAsync: true });
      while (f.events.tryRecv() !== undefined) {}

      await f.report({ type: "exited", awaited: true });
      expect(await f.next()).toEqual({
        type: "message",
        message: said("The fake runtime ended unexpectedly", "error"),
      });
      expect(await f.next()).toEqual({ type: "agentEnd", terminal: true, awaitingAsync: false });
    } finally {
      f.cleanup();
    }
  });

  test("keeps a delivery pending when the runtime refuses it and delivers it on the retry", async () => {
    const f = SessionFixture.create();
    try {
      f.driver.failNext = "cannot start the runtime";
      await expect(f.send("r1", "go", "queue")).rejects.toThrow("cannot start the runtime");
      expect(f.submissions()).toEqual([]);
      expect(f.session.journal().hasRequest("r1")).toBe(true);
      expect(f.session.journal().pending().length).toBe(1);

      await f.send("r1", "go", "queue");
      expect(f.texts()).toEqual(["go"]);

      await f.session.resubmit();
      expect(f.submissions().length).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  test("submits what a restart left pending with the first message after it", async () => {
    const f = SessionFixture.create();
    const journalPath = f.session.journal().path();
    const dir = f.dir;
    try {
      await f.send("r1", "before the crash", "queue");
      await f.send("n1", "a notice", "inject");
      // Simulate host crash without cleaning up dir.
      f.events.unsubscribe();
      f.runtime.close();
      f.session.journal().close();

      // The host restarts: the runtime never confirmed the delivery, so the reopened Session still owes it.
      const restarted = new SessionFixture(Journal.open(journalPath), dir);
      try {
        expect(restarted.submissions()).toEqual([]);
        await restarted.send("r1", "before the crash", "queue");
        expect(restarted.texts()).toEqual(["before the crash\n\na notice"]);
        expect(restarted.session.journal().len()).toBe(2);
      } finally {
        restarted.cleanup();
      }
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  });

  test("refuses everything once disposed and closes the runtime", async () => {
    const f = SessionFixture.create();
    try {
      await f.send("r1", "go", "queue");
      await f.session.dispose();
      expect(f.driver.closed).toBe(true);
      expect(f.session.isDisposed()).toBe(true);
      expect(f.session.isStreaming()).toBe(false);
      await expect(f.send("r2", "more", "queue")).rejects.toThrow("disposed");
      expect(() => f.session.append("c", [textBlock("x")], {}, false)).toThrow("disposed");
      while (f.events.tryRecv() !== undefined) {}
      await f.report({ type: "message", message: said("late", "stop") });
      expect(f.quiet()).toBe(true);
      expect(f.session.journal().len()).toBe(1);
    } finally {
      f.cleanup();
    }
  });
});
