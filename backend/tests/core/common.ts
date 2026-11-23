/**
 * Test harness: an Engine over a repository (default `MemoryRepositories`), with recording ports and a manual clock.
 * Can also run against the SQLite store by passing `hooks.repo`.
 */

import {
  Engine,
  MemoryRepositories,
  UserError,
  createOutcome,
  formatIso,
  isReadWaiting,
  isTicketLive,
  isUserError,
  mandateBasisVia,
  runningAssignment,
  workerReport,
  type ActorRef,
  type Assessor,
  type Assignment,
  type Candidate,
  type ChannelRef,
  type Decision,
  type DomainEvent,
  type Executor,
  type GateResult,
  type Json,
  type Mandate,
  type OutboundMessage,
  type Outbox,
  type Outcome,
  type Policy,
  type PrepareTicket,
  type ReceiveResult,
  type ReplyStatus,
  type ReportState,
  type Repositories,
  type ScopeResult,
  type SourceScope,
  type Thread,
  type ThreadRef,
  type Ticket,
  type Trigger,
  type TriggerDisposition,
  type WorkerReport,
} from "../../src/core/index.ts";

export const BASE_MS = 1_790_121_600_000; // 2026-09-23T00:00:00.000Z

export function member(): ActorRef {
  return { source: "chat", id: "alice" };
}

export function guest(): ActorRef {
  return { source: "chat", id: "guest" };
}

export function thread(id: string): ThreadRef {
  return { source: "chat", id };
}

export function channel(id: string): ChannelRef {
  return { source: "chat", thread: "t1", address: { message: id } };
}

/** A person's message `id` from the member on thread `t1`. */
export function trigger(id: string): Trigger {
  return {
    id,
    source: "chat",
    threads: [thread("t1")],
    actor: member(),
    human: true,
    at: `2026-09-23T00:00:${id.padStart(2, "0")}Z`,
    text: `message ${id}`,
    channel: channel(id),
    meta: {},
  };
}

export function on(t: Trigger, threadId: string): Trigger {
  return { ...t, threads: [thread(threadId)] };
}

export function by(t: Trigger, actor: ActorRef): Trigger {
  return { ...t, actor };
}

export function bot(t: Trigger): Trigger {
  return { ...t, human: false };
}

export function meta(t: Trigger, flag: string): Trigger {
  return { ...t, meta: { ...t.meta, [flag]: true } };
}

export class Recorder implements Assessor, Executor, Outbox, SourceScope {
  outbox: OutboundMessage[] = [];
  withdrawn: string[] = [];
  requests: Candidate[] = [];
  released: string[] = [];
  launches: Array<[Ticket, Assignment]> = [];
  deliveries: string[] = [];
  delivered: Array<[string, string]> = [];
  starts = 0;
  delivers = 0;
  stops = 0;
  events: DomainEvent[] = [];
  version = "v1";
  paused = false;
  clock = 0;

  request(candidate: Candidate): void {
    this.requests.push(candidate);
  }

  release(evalId: string): void {
    this.released.push(evalId);
  }

  start(ticket: Ticket, assignment: Assignment): void {
    this.starts += 1;
    this.launches.push([structuredClone(ticket), structuredClone(assignment)]);
  }

  deliver(ticket: Ticket, _assignment: Assignment): void {
    this.delivers += 1;
    if (!this.deliveries.includes(ticket.id)) {
      this.deliveries.push(ticket.id);
    }
  }

  stop(_ticket: Ticket, _assignment: Assignment, _reason: string): void {
    this.stops += 1;
  }

  send(message: OutboundMessage): void {
    if (!this.outbox.some((item) => item.id === message.id)) {
      this.outbox.push(message);
    }
  }

  status(id: string): ReplyStatus | undefined {
    return this.outbox.some((item) => item.id === id) ? "pending" : undefined;
  }

  withdraw(id: string): void {
    this.withdrawn.push(id);
  }

  scope(_source: string, m: Json): ScopeResult {
    if (Object.prototype.hasOwnProperty.call(m, "blocked")) {
      return { kind: "ignored", reason: "chat not allowed" };
    }
    return {
      kind: "listened",
      observed: false,
      fanout: !Object.prototype.hasOwnProperty.call(m, "routed"),
    };
  }
}

export function explicit(): GateResult {
  return {
    kind: "admissible",
    strength: "explicit",
    basis: mandateBasisVia({ via: "addressed", addressed: "direct" }),
  };
}

export function inferred(): GateResult {
  return {
    kind: "admissible",
    strength: "inferred",
    basis: mandateBasisVia({ via: "followup" }),
  };
}

export type Gate = (trigger: Trigger, thread: Thread) => GateResult;

class TestPolicy implements Policy {
  constructor(
    private readonly recorder: Recorder,
    private readonly customGate?: Gate,
  ) {}

  version(): string {
    return this.recorder.version;
  }

  paused(): boolean {
    return this.recorder.paused;
  }

  gate(t: Trigger, th: Thread, _tickets: readonly Ticket[]): GateResult {
    if (this.customGate !== undefined) {
      return this.customGate(t, th);
    }
    if (!t.human) {
      return { kind: "inadmissible", reason: "not human" };
    }
    if (t.actor.id === "alice") {
      return explicit();
    }
    if (th.subscriptions.length > 0) {
      return inferred();
    }
    return { kind: "inadmissible", reason: "not a member" };
  }

  revalidate(_mandate: Mandate): boolean {
    return this.version() !== "revoked";
  }

  admitsInferred(rules: readonly string[]): boolean {
    return rules.length > 0;
  }

  evalTimeoutMs(): number {
    return 60_000;
  }
}

export interface Hooks {
  repo?: Repositories;
  gate?: Gate;
  prepare?: PrepareTicket;
}

export function acceptOutcome(): Outcome {
  return createOutcome(
    { kind: "accept", accept: { title: "Fix", scope: "small", acknowledgement: "ok" } },
    "requested",
  );
}

export function acceptPlain(title: string): Outcome {
  return createOutcome({ kind: "accept", accept: { title, scope: "small" } }, "requested");
}

export function ignore(reason: string): Outcome {
  return createOutcome({ kind: "ignore" }, reason);
}

export function stop(ticketId: string, reason: string): Outcome {
  return createOutcome({ kind: "stop", ticketId }, reason);
}

export function report(state: ReportState, summary: string): WorkerReport {
  return workerReport(state, summary);
}

export function catchUserError(fn: () => unknown): UserError {
  try {
    fn();
  } catch (err) {
    if (isUserError(err)) {
      return err;
    }
    throw err;
  }
  throw new Error("expected UserError, but succeeded");
}

export function errorCode(fn: () => unknown): string {
  return catchUserError(fn).code;
}

export class Harness {
  readonly repo: Repositories;
  readonly engine: Engine;
  readonly r: Recorder;

  constructor(hooks: Hooks = {}) {
    this.repo = hooks.repo ?? new MemoryRepositories();
    this.r = new Recorder();
    const policy = new TestPolicy(this.r, hooks.gate);
    this.engine = new Engine({
      repo: this.repo,
      policy: () => policy,
      scope: this.r,
      assessor: this.r,
      executor: this.r,
      outbox: this.r,
      prepareTicket: hooks.prepare,
      now: () => formatIso(BASE_MS + this.r.clock * 1000),
      emit: (event) => {
        this.r.events.push(event);
      },
    });
  }

  receive(t: Trigger): ReceiveResult {
    return this.engine.receive(t);
  }

  /** Simulate the executor starting queued assignments (unless `launch` is false) and delivering pending inputs. */
  settleWith(launch: boolean): void {
    while (true) {
      const next = launch ? this.r.launches.shift() : undefined;
      if (next !== undefined) {
        const [ticket, assignment] = next;
        this.engine.assignmentStarted(ticket.id, assignment.id);
        continue;
      }
      const ticketId = this.r.deliveries.shift();
      if (ticketId === undefined) {
        return;
      }
      const ticket = this.ticket(ticketId);
      const assignment = isTicketLive(ticket) ? runningAssignment(ticket) : undefined;
      if (assignment === undefined) {
        continue;
      }
      for (const inputId of ticket.undelivered) {
        this.r.delivered.push([ticketId, inputId]);
        this.engine.inputsDelivered(ticketId, assignment.id, [inputId]);
      }
    }
  }

  settle(): void {
    this.settleWith(true);
  }

  pump(): void {
    this.engine.evaluateDue();
    this.settle();
  }

  /** Simulate the worker's Session taking the delivered Trigger Inputs it has not yet read into a step. */
  read(ticketId: string): void {
    const waiting = this.ticket(ticketId)
      .inputs.filter((input) => input.kind === "trigger" && isReadWaiting(input.readAt))
      .map((input) => input.id);
    this.engine.inputsRead(ticketId, waiting);
  }

  /** Decide the candidate's Eval through its first trigger. */
  decide(candidate: Candidate, outcome: Outcome): Decision {
    return this.engine.decide(candidate.triggers[0].id, {
      ...outcome,
      evalId: candidate.evalId,
    });
  }

  request(index: number): Candidate {
    return structuredClone(this.r.requests[index]);
  }

  lastRequest(): Candidate {
    const last = this.r.requests[this.r.requests.length - 1];
    if (last === undefined) {
      throw new Error("a candidate was requested");
    }
    return structuredClone(last);
  }

  requests(): number {
    return this.r.requests.length;
  }

  requestIds(candidate: Candidate): string[] {
    return candidate.triggers.map((t) => t.id);
  }

  lastIds(): string[] {
    return this.requestIds(this.lastRequest());
  }

  /** Receive message `id` on `threadId`, assess it and accept it with an acknowledgement; returns the ticket id. */
  acceptedOn(id: string, threadId: string): string {
    this.receive(on(trigger(id), threadId));
    this.pump();
    const decision = this.decide(this.lastRequest(), acceptOutcome());
    this.settle();
    if (decision.ticketId === undefined) {
      throw new Error("accept decision must have ticketId");
    }
    return decision.ticketId;
  }

  accepted(): string {
    return this.acceptedOn("1", "t1");
  }

  ticket(id: string): Ticket {
    const found = this.repo.ticket(id);
    if (found === undefined) {
      throw new Error(`the ticket ${id} is stored`);
    }
    return found;
  }

  thread(k: string): Thread {
    const found = this.repo.thread(k);
    if (found === undefined) {
      throw new Error(`the thread ${k} is stored`);
    }
    return found;
  }

  disposition(id: string): TriggerDisposition {
    const found = this.repo.disposition(id);
    if (found === undefined) {
      throw new Error(`the disposition ${id} is stored`);
    }
    return found;
  }

  decisions(k: string): Decision[] {
    return this.repo.decisionsByThread(k);
  }

  setVersion(version: string): void {
    this.r.version = version;
  }

  setPaused(paused: boolean): void {
    this.r.paused = paused;
  }

  tick(seconds: number): void {
    this.r.clock += seconds;
  }

  starts(): number {
    return this.r.starts;
  }

  delivers(): number {
    return this.r.delivers;
  }

  stops(): number {
    return this.r.stops;
  }

  outbox(): OutboundMessage[] {
    return structuredClone(this.r.outbox);
  }

  delivered(): Array<[string, string]> {
    return structuredClone(this.r.delivered);
  }

  report(ticketId: string, state: ReportState, summary: string): Ticket {
    return this.engine.report(ticketId, report(state, summary));
  }
}

export function harness(): Harness {
  return new Harness();
}

export function harnessWith(hooks: Hooks): Harness {
  return new Harness(hooks);
}
