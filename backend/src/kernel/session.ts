/**
 * A persistent agent Session: its transcript, idempotent deliveries, and turn lifecycle.
 *
 * The Session owns the `Journal`; a `Driver` owns the runtime process and only runs the model.
 * A delivery is durable once its entry is flushed to the journal, before the runtime sees it,
 * and stays pending until the runtime reports that it took it into a step. Whatever is pending
 * when a runtime process starts again is submitted again.
 */

import type { Entry, Journal } from "./journal.ts";
import { EventBroadcast, errorMessage, textBlock, uuid } from "./types.ts";
import type {
  Block,
  Deliver,
  EventSubscription,
  KernelEvent,
  KernelJob,
  Message,
  UnboundedChannel,
} from "./types.ts";

/** What a runtime process reports to its Session. */
export type DriverEvent =
  /** The runtime began working. */
  | { readonly type: "running" }
  /** The runtime went quiet; with `awaitingAsync`, background jobs it runs will wake it. */
  | { readonly type: "idle"; readonly awaitingAsync: boolean }
  /** The runtime retries a failed model request. */
  | { readonly type: "retry" }
  /** The runtime took the submission with this id into a step. */
  | { readonly type: "taken"; readonly id: string }
  /** The model or a tool said something. */
  | { readonly type: "message"; readonly message: Message }
  /** The runtime's own session id, which resumes its context after a restart. */
  | { readonly type: "sessionId"; readonly id: string }
  /** The runtime process ended; `awaited` when background jobs were running in it. */
  | { readonly type: "exited"; readonly error?: string; readonly awaited: boolean };

/** A runtime process that runs the model for one Session. */
export interface Driver {
  /** The kernel's name, under which its session id is recorded. */
  kernel(): string;
  /** Pre-warm the runtime process without starting a turn, resuming `resume` when known. */
  warm?(resume?: string): Promise<void>;
  /** Hand the runtime a user message, starting its process if none runs (resuming `resume`). */
  submit(id: string, content: Block[], deliver: Deliver, resume?: string): Promise<void>;
  /** Cancel the running turn. */
  interrupt(): Promise<void>;
  /** The background jobs the runtime runs. */
  jobs(): Promise<KernelJob[]>;
  /** Let these jobs finish without waking the Session. */
  acknowledge(ids: string[]): Promise<void>;
  /** Cancel a background job; false when it is unknown. */
  cancel(id: string): Promise<boolean>;
  /** Use another model, or thinking level, from the next turn. */
  setModel(model?: string, thinking?: string): Promise<void>;
  /** The runtime's process id, the root of what it runs. */
  pid(): number | undefined;
  /** End the runtime process and everything it runs. */
  close(): Promise<void>;
}

/** How a delivery reaches the model. */
export type Mode = "queue" | "steer" | "inject";

/** How a delivery shows in the transcript. */
export interface Presentation {
  /** People see it. */
  display?: boolean;
  /** It is from a person rather than the agent. */
  fromUser?: boolean;
  /** The chat source, such as `web-panel`. */
  source?: string;
  /** Attached files, as `[name, mediaType]` pairs. */
  attachments?: Array<[string, string]>;
}

function buildDetails(
  requestId: string,
  presentation: Presentation,
  inputIds: readonly string[],
): Record<string, unknown> {
  const details: Record<string, unknown> = { requestId };
  if (inputIds.length > 0) {
    details.inputIds = [...inputIds];
  }
  if (presentation.source !== undefined) {
    details.source = presentation.source;
  }
  if (presentation.attachments && presentation.attachments.length > 0) {
    details.attachments = presentation.attachments.map(([name, mediaType]) => ({
      name,
      mediaType,
    }));
  }
  return details;
}

interface OutstandingSubmission {
  id: string;
  entryIds: string[];
}

/** One persistent agent Session. */
export class Session {
  private readonly _journal: Journal;
  private readonly _driver: Driver;
  private disposed = false;
  private inTurn = false;
  /** Deliveries that asked for a turn since the last turn ended. */
  private submitted = 0;
  /** Submissions the runtime has not taken into a step: their id and the entries each carries. */
  private outstanding: OutstandingSubmission[] = [];
  private readonly events = new EventBroadcast<KernelEvent>(256);
  /** Serializes submissions so deliveries reach the runtime in the order they were appended. */
  private submitChain: Promise<void> = Promise.resolve();

  /** Create a Session over its transcript and runtime; `events` is what the runtime reports. */
  constructor(journal: Journal, driver: Driver, events: UnboundedChannel<DriverEvent>) {
    this._journal = journal;
    this._driver = driver;
    void this.pump(events);
  }

  /** Convenience factory matching `new Session(...)`. */
  static open(journal: Journal, driver: Driver, events: UnboundedChannel<DriverEvent>): Session {
    return new Session(journal, driver, events);
  }

  private async pump(events: UnboundedChannel<DriverEvent>): Promise<void> {
    while (!this.disposed) {
      const event = await events.recv();
      if (event === undefined) break;
      this.handle(event);
    }
  }

  private emit(event: KernelEvent): void {
    this.events.send(event);
  }

  /** The Session's transcript. */
  journal(): Journal {
    return this._journal;
  }

  /** The Session's runtime driver. */
  driver(): Driver {
    return this._driver;
  }

  /** Subscribe to KernelEvents reported from now on. */
  subscribe(): EventSubscription<KernelEvent> {
    return this.events.subscribe();
  }

  /** A turn is running. */
  isStreaming(): boolean {
    return this.inTurn;
  }

  /** The Session was disposed and takes nothing more. */
  isDisposed(): boolean {
    return this.disposed;
  }

  /** A delivery asked for a turn that has not ended yet. */
  hasAdmittedSubmission(): boolean {
    return this.submitted > 0;
  }

  /** Whether a turn is active or an admitted submission is awaiting a turn. */
  isBusy(): boolean {
    return !this.disposed && (this.inTurn || this.submitted > 0);
  }

  /** The last `count` entries from the transcript together with their starting index. */
  recent(count: number): [number, Entry[]] {
    return this._journal.entriesTail(count);
  }

  /** Background jobs currently tracked by the driver. */
  backgroundJobs(): Promise<KernelJob[]> {
    return this._driver.jobs();
  }

  /** Cancel the running turn on the driver. */
  interrupt(): Promise<void> {
    return this._driver.interrupt();
  }

  /** Switch model or thinking level on the driver (applied from the next idle turn). */
  setModel(model?: string, thinking?: string): Promise<void> {
    return this._driver.setModel(model, thinking);
  }

  private startTurn(): void {
    if (!this.inTurn) {
      this.inTurn = true;
      this.emit({ type: "agentStart" });
    }
  }

  private endTurn(awaitingAsync: boolean): void {
    if (!this.inTurn) {
      return;
    }
    this.inTurn = false;
    this.submitted = 0;
    this.emit({ type: "agentEnd", terminal: !awaitingAsync, awaitingAsync });
  }

  private record(message: Message): void {
    this._journal.appendMessage(message);
    this.emit({ type: "message", message });
  }

  private handle(event: DriverEvent): void {
    if (this.disposed) {
      return;
    }
    switch (event.type) {
      case "running":
        this.startTurn();
        break;
      case "idle":
        // A message submitted as this turn ended runs next, without an end in between.
        if (this.outstanding.length === 0) {
          this.endTurn(event.awaitingAsync);
        }
        break;
      case "retry":
        this.emit({ type: "retry" });
        break;
      case "taken": {
        let index = this.outstanding.findIndex((item) => item.id === event.id);
        if (index === -1) {
          if (this.outstanding.length === 0) return;
          index = 0;
        }
        const [removed] = this.outstanding.splice(index, 1);
        const entryIds = removed!.entryIds;
        this._journal.markTaken(entryIds);
        const requestIds = this._journal.requestIdsFor(entryIds);
        this.startTurn();
        this.emit({ type: "taken", requestIds });
        break;
      }
      case "message":
        if (event.message.role === "assistant") {
          this.startTurn();
        }
        this.record(event.message);
        break;
      case "sessionId":
        this._journal.setKernelSession(this._driver.kernel(), event.id);
        break;
      case "exited": {
        // What the runtime had not taken stays pending in the journal, and the next submission carries it.
        this.outstanding.length = 0;
        const waiting = this.inTurn || this.submitted > 0;
        // Idle with nothing running: the next message simply resumes. Otherwise whoever waits must hear.
        if (!waiting && !event.awaited) {
          return;
        }
        const text = event.error ?? `The ${this._driver.kernel()} runtime ended unexpectedly`;
        this.record({
          role: "assistant",
          content: [textBlock(text)],
          stopReason: "error",
        });
        this.inTurn = true;
        this.endTurn(false);
        break;
      }
    }
  }

  /**
   * Append a visible message without asking for a turn, even while the agent is busy; with
   * `showModel`, the model is shown it on its next turn. A request id appended before is not
   * appended again.
   */
  append(
    requestId: string,
    content: Block[],
    presentation: Presentation = {},
    showModel = false,
  ): void {
    if (this.disposed) {
      throw new Error("The session was disposed");
    }
    if (!this._journal.hasRequest(requestId)) {
      const attribution = presentation.fromUser ? "user" : "agent";
      this._journal.appendCustom(
        content,
        presentation.display ?? false,
        buildDetails(requestId, presentation, []),
        attribution,
        showModel ? false : undefined,
      );
    }
    try {
      this._journal.flush();
    } catch (err) {
      throw new Error(`The session transcript cannot be written: ${errorMessage(err)}`);
    }
  }

  /** Pre-warm the underlying runtime process without starting a turn. */
  async warm(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const resume = this._journal.kernelSession(this._driver.kernel());
    if (this._driver.warm) {
      await this._driver.warm(resume);
    }
  }

  /**
   * Deliver a message to the model, once per request id. It is durable when this resolves:
   * a crash after that loses nothing, and sending the same request again only makes sure
   * the runtime has it.
   */
  async send(
    requestId: string,
    content: Block[],
    mode: Mode,
    presentation: Presentation = {},
    inputIds: readonly string[] = [],
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("The session was disposed");
    }
    const known = this._journal.request(requestId);
    if (known === undefined) {
      const attribution = presentation.fromUser ? "user" : "agent";
      this._journal.appendCustom(
        content,
        presentation.display ?? false,
        buildDetails(requestId, presentation, inputIds),
        attribution,
        mode !== "inject",
      );
    }
    try {
      this._journal.flush();
    } catch (err) {
      throw new Error(`The session transcript cannot be written: ${errorMessage(err)}`);
    }
    if (mode === "inject") {
      return;
    }
    if (known === undefined) {
      this.submitted += 1;
      this.startTurn();
    } else if (!this._journal.isPending(known.id)) {
      return;
    }
    await this.submit(mode === "steer" ? "steer" : "followUp");
  }

  private async withSubmitLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.submitChain;
    let release!: () => void;
    this.submitChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Hand the runtime every pending delivery it does not have yet, as one message,
   * when one of them asks for a turn.
   */
  private submit(deliver: Deliver): Promise<void> {
    return this.withSubmitLock(async () => {
      if (this.disposed) {
        throw new Error("The session was disposed");
      }
      const id = uuid();
      const outstandingIds = new Set<string>();
      for (const item of this.outstanding) {
        for (const eid of item.entryIds) {
          outstandingIds.add(eid);
        }
      }
      const fresh = this._journal
        .pending()
        .filter((pending) => !outstandingIds.has(pending.entry.id));
      if (!fresh.some((pending) => pending.trigger)) {
        return;
      }
      this.outstanding.push({
        id,
        entryIds: fresh.map((pending) => pending.entry.id),
      });

      const content: Block[] = [];
      for (const { entry } of fresh) {
        if (entry.type !== "custom_message") continue;
        for (const block of entry.content) {
          const last = content[content.length - 1];
          // Deliveries read as paragraphs of one message.
          if (last !== undefined && last.type === "text" && block.type === "text") {
            last.text += "\n\n" + block.text;
          } else {
            content.push(
              block.type === "text" ? { type: "text", text: block.text } : { ...block },
            );
          }
        }
      }

      const resume = this._journal.kernelSession(this._driver.kernel());
      try {
        await this._driver.submit(id, content, deliver, resume);
      } catch (err) {
        this.outstanding = this.outstanding.filter((item) => item.id !== id);
        throw err;
      }
    });
  }

  /** Make sure the runtime has what is pending, such as after it exited with deliveries it had not taken. */
  resubmit(): Promise<void> {
    return this.submit("followUp");
  }

  /** Refuse new work at once; `dispose()` ends the runtime. */
  beginDispose(): void {
    this.disposed = true;
  }

  /** End the Session's runtime and make its transcript durable. */
  async dispose(): Promise<void> {
    this.beginDispose();
    await this._driver.close();
    this.inTurn = false;
    try {
      this._journal.flush();
    } catch {
      // ignore flush errors during teardown, matching Rust
    }
    this._journal.close();
  }

  /** Alias for `dispose()`. */
  close(): Promise<void> {
    return this.dispose();
  }
}
