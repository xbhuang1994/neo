/**
 * The kernel-neutral vocabulary: message content, session events, background jobs,
 * host tools, and lightweight event-driven async channels.
 */

import { randomUUID } from "node:crypto";

/** One block of message content. Wire shape matches Rust serde camelCase tagged enum. */
export type Block =
  | { readonly type: "text"; text: string }
  | { readonly type: "image"; mimeType: string; data: string }
  | { readonly type: "toolCall"; id: string; name: string; arguments: unknown };

/** Create a text content block. */
export function textBlock(text: string): Block {
  return { type: "text", text };
}

/** The text of content blocks, joined by newlines. */
export function textOf(content: readonly Block[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Who a transcript message is from. */
export type Role = "assistant" | "toolResult";

/** A model or tool message as the transcript keeps it. */
export interface Message {
  /** Who it is from. */
  role: Role;
  /** What it says. */
  content: Block[];
  /** Why the model stopped: `stop`, `toolUse`, `length`, `error` or `aborted`. */
  stopReason?: string;
}

/** What a Session reports to its subscribers. */
export type KernelEvent =
  | { readonly type: "agentStart" }
  | {
      readonly type: "agentEnd";
      /** Nothing the Session runs will wake it again. */
      readonly terminal: boolean;
      /** Background jobs are still running and will wake it. */
      readonly awaitingAsync: boolean;
    }
  | { readonly type: "retry" }
  | {
      readonly type: "taken";
      /** The request ids of the deliveries. */
      readonly requestIds: string[];
    }
  | { readonly type: "message"; readonly message: Message };

/** What a background job is. */
export type JobKind = "bash" | "task" | "eval";

/** A background job of a Session. */
export interface KernelJob {
  /** The runtime's id for it. */
  id: string;
  /** What it is. */
  kind: JobKind;
  /** What it shows as. */
  label: string;
  /** When it started, in epoch milliseconds. */
  startTime: number;
  /** Its latest progress, in words. */
  progress?: string;
  /** For a shell command: the command line. */
  command?: string;
  /** The Session's own job rather than a subagent's. */
  own: boolean;
  /** The process ids the runtime reports for it; empty when it reports none. */
  pids: number[];
}

/** How a message joins a busy Session. */
export type Deliver = "steer" | "followUp";

/** A tool the host offers the model. */
export interface ToolSpec {
  /** The tool's name. */
  name: string;
  /** What it does, for the model. */
  description: string;
  /** Its parameters, as a JSON Schema object. */
  schema: Record<string, unknown>;
}

/** What a tool-call guard decides. */
export type Guard =
  | { readonly decision: "allow" }
  | { readonly decision: "block"; readonly reason: string };

/** Reusable Allow guard decision. */
export const GUARD_ALLOW: Guard = { decision: "allow" };

/** Create a Block guard decision with a reason. */
export function guardBlock(reason: string): Guard {
  return { decision: "block", reason };
}

/** The host's side of a Session: the tools it offers and the guard on every tool call. */
export interface ToolHost {
  /** The tools offered to this Session's model. */
  specs(): ToolSpec[];
  /** Run a tool; the returned value is sent to the model as JSON, a thrown error as a tool error. */
  call(name: string, args: unknown): Promise<unknown>;
  /** Judge a tool call, built-in or the host's own, before it runs. Defaults to allow. */
  guard?(tool: string, input: unknown): Promise<Guard> | Guard;
}

/** A random version 4 UUID (lowercase 36-char RFC 4122). */
export function uuid(): string {
  return randomUUID();
}

/** Current time in epoch milliseconds. */
export function nowMs(): number {
  return Date.now();
}

/** Current time in canonical ISO-8601 form (`YYYY-MM-DDTHH:mm:ss.sssZ`). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Type guard for plain JSON objects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unbounded FIFO async channel (single/multi producer, single consumer)
 * with O(1) amortized push/pop and zero polling.
 */
export class UnboundedChannel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private head = 0;
  private waiters: Array<(value: T | undefined) => void> = [];
  private waiterHead = 0;
  private closed = false;

  /** Enqueue an item. Returns false if the channel is already closed. */
  send(item: T): boolean {
    if (this.closed) return false;
    if (this.waiterHead < this.waiters.length) {
      const resolve = this.waiters[this.waiterHead++]!;
      if (this.waiterHead > 64 && this.waiterHead * 2 >= this.waiters.length) {
        this.waiters = this.waiters.slice(this.waiterHead);
        this.waiterHead = 0;
      }
      resolve(item);
      return true;
    }
    this.items.push(item);
    return true;
  }

  /** Close the channel; pending and future receives resolve with `undefined` once drained. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiterHead < this.waiters.length) {
      const resolve = this.waiters[this.waiterHead++]!;
      resolve(undefined);
    }
    this.waiters.length = 0;
    this.waiterHead = 0;
  }

  /** Whether the channel has been closed. */
  isClosed(): boolean {
    return this.closed;
  }

  /** Non-blocking dequeue; returns `undefined` if currently empty. */
  tryRecv(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head++]!;
    if (this.head > 64 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  /** Receive the next item, or `undefined` if closed and drained. */
  recv(): Promise<T | undefined> {
    if (this.head < this.items.length) {
      return Promise.resolve(this.tryRecv());
    }
    if (this.closed) {
      return Promise.resolve(undefined);
    }
    return new Promise<T | undefined>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = await this.recv();
      if (item === undefined) return;
      yield item;
    }
  }
}

/**
 * One subscriber's bounded queue on an `EventBroadcast`.
 * Drops oldest unread events when capacity is exceeded so slow/abandoned subscribers
 * cannot leak unbounded memory.
 */
export class EventSubscription<T> implements AsyncIterable<T> {
  private readonly ring: Array<T | undefined>;
  private readonly capacity: number;
  private readIdx = 0;
  private count = 0;
  private waiter: ((value: T | undefined) => void) | null = null;
  private closed = false;
  private readonly onUnsubscribe: () => void;

  constructor(capacity: number, onUnsubscribe: () => void) {
    this.capacity = Math.max(1, capacity);
    this.ring = new Array<T | undefined>(this.capacity);
    this.onUnsubscribe = onUnsubscribe;
  }

  /** Push an event from the broadcaster. */
  push(item: T): void {
    if (this.closed) return;
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(item);
      return;
    }
    if (this.count === this.capacity) {
      // Lagged: overwrite oldest element and advance read cursor.
      this.ring[this.readIdx] = item;
      this.readIdx = (this.readIdx + 1) % this.capacity;
    } else {
      const writeIdx = (this.readIdx + this.count) % this.capacity;
      this.ring[writeIdx] = item;
      this.count += 1;
    }
  }

  /** Close this subscription (no more events will arrive). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onUnsubscribe();
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(undefined);
    }
  }

  /** Stop receiving events and detach from the broadcaster. */
  unsubscribe(): void {
    this.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /** Non-blocking read of the next queued event, or `undefined` if empty. */
  tryRecv(): T | undefined {
    if (this.count === 0) return undefined;
    const item = this.ring[this.readIdx]!;
    this.ring[this.readIdx] = undefined;
    this.readIdx = (this.readIdx + 1) % this.capacity;
    this.count -= 1;
    return item;
  }

  /** Await the next event, or `undefined` if closed and drained. */
  recv(): Promise<T | undefined> {
    if (this.count > 0) {
      return Promise.resolve(this.tryRecv());
    }
    if (this.closed) {
      return Promise.resolve(undefined);
    }
    return new Promise<T | undefined>((resolve) => {
      this.waiter = resolve;
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    try {
      while (true) {
        const item = await this.recv();
        if (item === undefined) return;
        yield item;
      }
    } finally {
      this.close();
    }
  }
}

/** Multi-subscriber bounded broadcast channel matching `tokio::sync::broadcast`. */
export class EventBroadcast<T> {
  private readonly subscribers = new Set<EventSubscription<T>>();
  private readonly capacity: number;

  constructor(capacity = 256) {
    this.capacity = capacity;
  }

  /** Subscribe to events emitted from now on. */
  subscribe(): EventSubscription<T> {
    const sub = new EventSubscription<T>(this.capacity, () => {
      this.subscribers.delete(sub);
    });
    this.subscribers.add(sub);
    return sub;
  }

  /** Broadcast an event to all current subscribers. */
  send(event: T): void {
    for (const sub of this.subscribers) {
      sub.push(event);
    }
  }

  /** Close all active subscriptions. */
  close(): void {
    for (const sub of Array.from(this.subscribers)) {
      sub.close();
    }
    this.subscribers.clear();
  }
}
