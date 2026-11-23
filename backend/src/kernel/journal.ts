/**
 * The file-backed transcript of one Session: what people see, what the model was or will be
 * shown, and the idempotency record of every delivery.
 *
 * One JSON value per line. An entry is visible once appended and durable after `Journal.flush()`.
 * A delivery meant for the model is marked *pending* when appended and *taken* once the runtime
 * took it into a step; whatever is still pending when a runtime process starts is sent again, so
 * the model sees every delivery at least once.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, nowIso, textOf, uuid } from "./types.ts";
import type { Block, Message, Role } from "./types.ts";

/** The custom type of every entry the application writes. */
export const CUSTOM_TYPE = "neo-agent";

/** Chat transcript sources the app shows. */
export const VISIBLE_SOURCES = ["web-panel", "wechat", "chat-reply"] as const;

const VISIBLE_SOURCE_SET: ReadonlySet<string> = new Set(VISIBLE_SOURCES);

/** Something the model or a tool said. */
export interface MessageEntry {
  readonly type: "message";
  /** The entry's id. */
  id: string;
  /** When it was appended. */
  timestamp: string;
  /** The message. */
  message: Message;
}

/** Something the application put into the Session: a delivery, a notice, or a chat message. */
export interface CustomMessageEntry {
  readonly type: "custom_message";
  /** The entry's id. */
  id: string;
  /** When it was appended. */
  timestamp: string;
  /** Always `CUSTOM_TYPE` for entries this application writes. */
  customType: string;
  /** What it says. */
  content: Block[];
  /** Whether people see it in the transcript. */
  display: boolean;
  /** `requestId`, `source`, `inputIds` and `attachments`. */
  details?: unknown;
  /** `agent` or `user`. */
  attribution?: string;
}

/** One transcript entry. */
export type Entry = MessageEntry | CustomMessageEntry;

/** A delivery the model has not been shown yet. */
export interface Pending {
  /** The entry. */
  entry: Entry;
  /** It asks for a turn, rather than waiting for the next one. */
  trigger: boolean;
}

type Mark =
  | { readonly type: "header"; id: string; cwd: string; timestamp: string }
  | { readonly type: "kernel_session"; kernel: string; id: string }
  | { readonly type: "name"; name: string }
  | { readonly type: "pending"; id: string; trigger: boolean }
  | { readonly type: "taken"; ids: string[] };

/** Look up a field inside a `CustomMessageEntry`'s `details` object. */
function entryDetail(entry: Entry, name: string): unknown {
  if (entry.type !== "custom_message" || !isRecord(entry.details)) {
    return undefined;
  }
  return entry.details[name];
}

/** The entry's id. */
export function entryId(entry: Entry): string {
  return entry.id;
}

/** When the entry was appended. */
export function entryTimestamp(entry: Entry): string {
  return entry.timestamp;
}

/** The request id of a delivery. */
export function entryRequestId(entry: Entry): string | undefined {
  const value = entryDetail(entry, "requestId");
  return typeof value === "string" ? value : undefined;
}

/** The chat source of an entry. */
export function entrySource(entry: Entry): string | undefined {
  const value = entryDetail(entry, "source");
  return typeof value === "string" ? value : undefined;
}

/** The ticket Inputs a delivery carries. */
export function entryInputIds(entry: Entry): string[] {
  const value = entryDetail(entry, "inputIds");
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

function parseBlock(raw: unknown): Block | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
  switch (raw.type) {
    case "text":
      if (typeof raw.text !== "string") return undefined;
      return { type: "text", text: raw.text };
    case "image":
      if (typeof raw.mimeType !== "string" || typeof raw.data !== "string") return undefined;
      return { type: "image", mimeType: raw.mimeType, data: raw.data };
    case "toolCall":
      if (typeof raw.id !== "string" || typeof raw.name !== "string" || !("arguments" in raw)) {
        return undefined;
      }
      return { type: "toolCall", id: raw.id, name: raw.name, arguments: raw.arguments };
    default:
      return undefined;
  }
}

function parseBlocks(raw: unknown): Block[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const blocks: Block[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const parsed = parseBlock(raw[i]);
    if (parsed === undefined) return undefined;
    blocks[i] = parsed;
  }
  return blocks;
}

function parseRole(raw: unknown): Role | undefined {
  if (raw === "assistant" || raw === "toolResult") return raw;
  return undefined;
}

function parseMessage(raw: unknown): Message | undefined {
  if (!isRecord(raw)) return undefined;
  const role = parseRole(raw.role);
  if (role === undefined) return undefined;
  const content = parseBlocks(raw.content);
  if (content === undefined) return undefined;
  if (raw.stopReason !== undefined && raw.stopReason !== null && typeof raw.stopReason !== "string") {
    return undefined;
  }
  const msg: Message = { role, content };
  if (typeof raw.stopReason === "string") {
    msg.stopReason = raw.stopReason;
  }
  return msg;
}

function parseEntry(raw: unknown): Entry | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
  if (typeof raw.id !== "string" || typeof raw.timestamp !== "string") return undefined;
  if (raw.type === "message") {
    const message = parseMessage(raw.message);
    if (message === undefined) return undefined;
    return { type: "message", id: raw.id, timestamp: raw.timestamp, message };
  }
  if (raw.type === "custom_message") {
    if (typeof raw.customType !== "string" || typeof raw.display !== "boolean") return undefined;
    const content = parseBlocks(raw.content);
    if (content === undefined) return undefined;
    if (
      raw.attribution !== undefined &&
      raw.attribution !== null &&
      typeof raw.attribution !== "string"
    ) {
      return undefined;
    }
    const entry: CustomMessageEntry = {
      type: "custom_message",
      id: raw.id,
      timestamp: raw.timestamp,
      customType: raw.customType,
      content,
      display: raw.display,
    };
    if (raw.details !== undefined && raw.details !== null) {
      entry.details = raw.details;
    }
    if (typeof raw.attribution === "string") {
      entry.attribution = raw.attribution;
    }
    return entry;
  }
  return undefined;
}

function parseMark(raw: unknown): Mark | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
  switch (raw.type) {
    case "header":
      if (
        typeof raw.id === "string" &&
        typeof raw.cwd === "string" &&
        typeof raw.timestamp === "string"
      ) {
        return { type: "header", id: raw.id, cwd: raw.cwd, timestamp: raw.timestamp };
      }
      return undefined;
    case "kernel_session":
      if (typeof raw.kernel === "string" && typeof raw.id === "string") {
        return { type: "kernel_session", kernel: raw.kernel, id: raw.id };
      }
      return undefined;
    case "name":
      if (typeof raw.name === "string") {
        return { type: "name", name: raw.name };
      }
      return undefined;
    case "pending":
      if (typeof raw.id === "string" && typeof raw.trigger === "boolean") {
        return { type: "pending", id: raw.id, trigger: raw.trigger };
      }
      return undefined;
    case "taken":
      if (Array.isArray(raw.ids) && raw.ids.every((id): id is string => typeof id === "string")) {
        return { type: "taken", ids: raw.ids };
      }
      return undefined;
    default:
      return undefined;
  }
}

function cleanMessage(message: Message): Message {
  const content = message.content.map((b) => (b.type === "text" ? { type: "text" as const, text: b.text } : { ...b }));
  const cleaned: Message = { role: message.role, content };
  if (message.stopReason !== undefined) {
    cleaned.stopReason = message.stopReason;
  }
  return cleaned;
}

function writeAllSync(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(fd, data, offset, data.length - offset);
    offset += written;
  }
}

function normalizeReadError(filePath: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes(filePath)) {
    return err instanceof Error ? err : new Error(msg);
  }
  return new Error(`${filePath}: ${msg}`);
}

/** Append-only transcript of one Session. */
export class Journal {
  private readonly filePath: string;
  private fd: number;
  private closed = false;
  private readonly entryList: Entry[];
  /** O(1) index into `entryList` by entry id. */
  private readonly idIndex: Map<string, number>;
  /** O(1) index into `entryList` by delivery request id. */
  private readonly requestIndex: Map<string, number>;
  /** Insertion-ordered pending entry ids -> whether each asks for a turn. */
  private readonly pendingMap: Map<string, boolean>;
  /** O(1) runtime session id per kernel. */
  private readonly sessionMap: Map<string, string>;
  private sessionName: string | undefined;
  private writeFailure: Error | null = null;

  private constructor(
    filePath: string,
    fd: number,
    entries: Entry[],
    idIndex: Map<string, number>,
    requestIndex: Map<string, number>,
    pendingMap: Map<string, boolean>,
    sessionMap: Map<string, string>,
    name: string | undefined,
  ) {
    this.filePath = filePath;
    this.fd = fd;
    this.entryList = entries;
    this.idIndex = idIndex;
    this.requestIndex = requestIndex;
    this.pendingMap = pendingMap;
    this.sessionMap = sessionMap;
    this.sessionName = name;
  }

  /** Start a new transcript file in `dir` for a Session working in `cwd`. */
  static create(dir: string, cwd: string): Journal {
    fs.mkdirSync(dir, { recursive: true });
    const id = uuid();
    const stamp = nowIso().replace(/[:.]/g, "-");
    const filePath = path.join(dir, `${stamp}_${id}.jsonl`);
    const flags =
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      fs.constants.O_APPEND;
    const fd = fs.openSync(filePath, flags, 0o600);
    const journal = new Journal(
      filePath,
      fd,
      [],
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      undefined,
    );
    journal.writeLine({ type: "header", id, cwd, timestamp: nowIso() });
    journal.flush();
    return journal;
  }

  /**
   * Open an existing transcript. A line that does not parse, such as one cut off by a crash,
   * is skipped. Fails with its path named when missing, unreadable, or lacking a valid header.
   */
  static open(filePath: string): Journal {
    let readFd: number;
    try {
      readFd = fs.openSync(filePath, fs.constants.O_RDONLY);
    } catch (err) {
      throw normalizeReadError(filePath, err);
    }

    const entries: Entry[] = [];
    const idIndex = new Map<string, number>();
    const requestIndex = new Map<string, number>();
    const pendingMap = new Map<string, boolean>();
    const sessionMap = new Map<string, string>();
    let sessionName: string | undefined;
    let hasHeader = false;
    let needsNewline = false;

    try {
      const stat = fs.fstatSync(readFd);
      if (stat.isDirectory()) {
        throw new Error(`${filePath} is a directory, not a session transcript`);
      }

      // Single-byte tail check: a crash can leave the last line without its trailing newline.
      if (stat.size > 0) {
        const tail = Buffer.allocUnsafe(1);
        const bytesRead = fs.readSync(readFd, tail, 0, 1, stat.size - 1);
        if (bytesRead === 1 && tail[0] !== 0x0a) {
          needsNewline = true;
        }
      }

      const content = fs.readFileSync(readFd, "utf8");
      let start = 0;
      while (start <= content.length) {
        let end = content.indexOf("\n", start);
        if (end === -1) end = content.length;
        let line = content.slice(start, end);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        start = end + 1;

        if (line.trim().length === 0) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Skip truncated/unparseable crash line.
          continue;
        }

        const entry = parseEntry(parsed);
        if (entry !== undefined) {
          const index = entries.length;
          if (!idIndex.has(entry.id)) {
            idIndex.set(entry.id, index);
          }
          const reqId = entryRequestId(entry);
          if (reqId !== undefined && !requestIndex.has(reqId)) {
            requestIndex.set(reqId, index);
          }
          entries.push(entry);
          continue;
        }

        const mark = parseMark(parsed);
        if (mark !== undefined) {
          switch (mark.type) {
            case "header":
              hasHeader = true;
              break;
            case "kernel_session":
              sessionMap.set(mark.kernel, mark.id);
              break;
            case "name":
              sessionName = mark.name;
              break;
            case "pending":
              if (!pendingMap.has(mark.id)) {
                pendingMap.set(mark.id, mark.trigger);
              }
              break;
            case "taken":
              for (const takenId of mark.ids) {
                pendingMap.delete(takenId);
              }
              break;
          }
        }
      }
    } catch (err) {
      throw normalizeReadError(filePath, err);
    } finally {
      fs.closeSync(readFd);
    }

    if (!hasHeader) {
      throw new Error(`${filePath} is not a session transcript of this program`);
    }

    let appendFd: number;
    try {
      appendFd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND);
    } catch (err) {
      throw normalizeReadError(filePath, err);
    }

    if (needsNewline) {
      try {
        writeAllSync(appendFd, Buffer.from("\n"));
      } catch (err) {
        fs.closeSync(appendFd);
        throw normalizeReadError(filePath, err);
      }
    }

    return new Journal(
      filePath,
      appendFd,
      entries,
      idIndex,
      requestIndex,
      pendingMap,
      sessionMap,
      sessionName,
    );
  }

  /** The transcript's file path. */
  path(): string {
    return this.filePath;
  }

  private writeLine(line: Entry | Mark): void {
    const buf = Buffer.from(JSON.stringify(line) + "\n", "utf8");
    try {
      writeAllSync(this.fd, buf);
    } catch (err) {
      if (this.writeFailure === null) {
        this.writeFailure = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  /** Every entry, oldest first. */
  entries(): Entry[] {
    return this.entryList.slice();
  }

  /** How many entries there are. */
  len(): number {
    return this.entryList.length;
  }

  /** Whether the transcript has no entries. */
  isEmpty(): boolean {
    return this.entryList.length === 0;
  }

  /** The entries from position `from` on. */
  entriesFrom(from: number): Entry[] {
    return this.entryList.slice(from);
  }

  /** The last `count` entries together with their starting index in the transcript. */
  entriesTail(count: number): [number, Entry[]] {
    const start = Math.max(0, this.entryList.length - count);
    return [start, this.entryList.slice(start)];
  }

  /** Look up the request ids carried by the entries with these ids, in entry order. */
  requestIdsFor(entryIds: readonly string[]): string[] {
    const indices: number[] = [];
    for (const id of entryIds) {
      const idx = this.idIndex.get(id);
      if (idx !== undefined) {
        indices.push(idx);
      }
    }
    indices.sort((a, b) => a - b);
    const out: string[] = [];
    let prev = -1;
    for (const idx of indices) {
      if (idx === prev) continue;
      prev = idx;
      const reqId = entryRequestId(this.entryList[idx]!);
      if (reqId !== undefined) {
        out.push(reqId);
      }
    }
    return out;
  }

  /** Whether a delivery with this request id was appended (O(1)). */
  hasRequest(requestId: string): boolean {
    return this.requestIndex.has(requestId);
  }

  /** The entry of a delivery (O(1)). */
  request(requestId: string): Entry | undefined {
    const idx = this.requestIndex.get(requestId);
    return idx !== undefined ? this.entryList[idx] : undefined;
  }

  /**
   * Append what the application puts into the Session.
   * With `pending === true`, the model is shown it on a turn it asks for;
   * with `pending === false`, on the next turn something else starts;
   * with `pending === undefined`, it is not queued for the model (display-only/chat).
   */
  appendCustom(
    content: Block[],
    display: boolean,
    details?: unknown,
    attribution?: string,
    pending?: boolean,
  ): Entry {
    const copiedContent = content.map((b) =>
      b.type === "text" ? { type: "text" as const, text: b.text } : { ...b },
    );
    const entry: CustomMessageEntry = {
      type: "custom_message",
      id: uuid(),
      timestamp: nowIso(),
      customType: CUSTOM_TYPE,
      content: copiedContent,
      display,
    };
    if (details !== undefined && details !== null) {
      entry.details = details;
    }
    if (attribution !== undefined) {
      entry.attribution = attribution;
    }

    this.writeLine(entry);
    if (pending !== undefined) {
      this.pendingMap.set(entry.id, pending);
      this.writeLine({ type: "pending", id: entry.id, trigger: pending });
    }

    const index = this.entryList.length;
    if (!this.idIndex.has(entry.id)) {
      this.idIndex.set(entry.id, index);
    }
    const reqId = entryRequestId(entry);
    if (reqId !== undefined && !this.requestIndex.has(reqId)) {
      this.requestIndex.set(reqId, index);
    }
    this.entryList.push(entry);
    return entry;
  }

  /** Append something the model or a tool said. */
  appendMessage(message: Message): Entry {
    const entry: MessageEntry = {
      type: "message",
      id: uuid(),
      timestamp: nowIso(),
      message: cleanMessage(message),
    };
    this.writeLine(entry);
    const index = this.entryList.length;
    if (!this.idIndex.has(entry.id)) {
      this.idIndex.set(entry.id, index);
    }
    this.entryList.push(entry);
    return entry;
  }

  /** The deliveries the model has not been shown, in insertion order. */
  pending(): Pending[] {
    const out: Pending[] = [];
    for (const [id, trigger] of this.pendingMap) {
      const idx = this.idIndex.get(id);
      if (idx !== undefined) {
        const entry = this.entryList[idx];
        if (entry !== undefined) {
          out.push({ entry, trigger });
        }
      }
    }
    return out;
  }

  /** Whether an entry still waits to be shown to the model (O(1)). */
  isPending(entryId: string): boolean {
    return this.pendingMap.has(entryId);
  }

  /** Record that the runtime took these entries into a step. */
  markTaken(ids: readonly string[]): void {
    const before = this.pendingMap.size;
    for (const id of ids) {
      this.pendingMap.delete(id);
    }
    if (this.pendingMap.size !== before) {
      this.writeLine({ type: "taken", ids: [...ids] });
    }
  }

  /** The runtime session id recorded for a kernel, which resumes its context (O(1)). */
  kernelSession(kernel: string): string | undefined {
    return this.sessionMap.get(kernel);
  }

  /** Record a kernel's runtime session id. */
  setKernelSession(kernel: string, id: string): void {
    if (this.sessionMap.get(kernel) === id) {
      return;
    }
    this.sessionMap.set(kernel, id);
    this.writeLine({ type: "kernel_session", kernel, id });
  }

  /** The Session's display name. */
  name(): string | undefined {
    return this.sessionName;
  }

  /** Record the Session's display name. */
  setName(name: string): void {
    if (this.sessionName === name) {
      return;
    }
    this.sessionName = name;
    this.writeLine({ type: "name", name });
  }

  /** The visible chat transcript: what the app shows. */
  chat(): Entry[] {
    const out: Entry[] = [];
    for (const entry of this.entryList) {
      const source = entrySource(entry);
      if (source !== undefined && VISIBLE_SOURCE_SET.has(source)) {
        out.push(entry);
      }
    }
    return out;
  }

  /** The text of the model's latest message with non-empty text. */
  lastAssistantText(): string | undefined {
    for (let i = this.entryList.length - 1; i >= 0; i--) {
      const entry = this.entryList[i]!;
      if (entry.type === "message" && entry.message.role === "assistant") {
        const text = textOf(entry.message.content);
        if (text.length > 0) {
          return text;
        }
      }
    }
    return undefined;
  }

  /** Why the model's latest assistant message stopped. */
  lastStopReason(): string | undefined {
    for (let i = this.entryList.length - 1; i >= 0; i--) {
      const entry = this.entryList[i]!;
      if (entry.type === "message" && entry.message.role === "assistant") {
        return entry.message.stopReason ?? "";
      }
    }
    return undefined;
  }

  /** Make everything appended so far durable. */
  flush(): void {
    if (this.writeFailure !== null) {
      const err = this.writeFailure;
      this.writeFailure = null;
      throw err;
    }
    fs.fdatasyncSync(this.fd);
  }

  /** Close the underlying file descriptor. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.closeSync(this.fd);
    } catch {
      // ignore if already closed
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
