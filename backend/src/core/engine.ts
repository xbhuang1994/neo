/**
 * The domain Engine: the single entry point of the core. Every command runs in one repository transaction and only
 * queues side effects through the ports.
 */

import {
  assignmentsDelivered,
  assignmentsDeliveryFailed,
  assignmentsInterrupted,
  assignmentsRead,
  assignmentsReport,
  assignmentsStarted,
  assignmentsTurnEnded,
  type WorkerReport,
} from "./assignments.ts";
import { UserError } from "./errors.ts";
import {
  evalsCandidate,
  evalsDecide,
  evalsDelivered,
  evalsDismiss,
  evalsDue,
  evalsHandback,
  evalsPolicyChanged,
  evalsReevaluate,
  evalsRouted,
  evalsStart,
  evalsWithdraw,
} from "./evals.ts";
import { intakeReceive } from "./intake.ts";
import {
  dispositionAt,
  followupOwners,
  handedBackBy,
  isTicketLive,
  reached,
  threadKey,
  type Decision,
  type PolicyEffect,
  type Thread,
  type ThreadRef,
  type Ticket,
  type Trigger,
  type TriggerDisposition,
} from "./model.ts";
import type {
  Accept,
  Assessor,
  Candidate,
  DomainEvent,
  Executor,
  Outbox,
  Outcome,
  Policy,
  Repositories,
  SourceScope,
} from "./ports.ts";
import { repliesReply, type Reply, type ReplyRequest } from "./replies.ts";
import {
  ticketsAttach,
  ticketsAttachable,
  ticketsDropSubscriptions,
  ticketsEnd,
  ticketsFollowForContext,
  ticketsMarkUnrelated,
  ticketsNote,
  ticketsPolicyChanged,
  ticketsRequestStatus,
  ticketsRetry,
  ticketsWake,
  ticketsWakeWorker,
} from "./tickets.ts";
import { nowIso } from "./time.ts";

/** Lets the Executor choose a new ticket's name, directory and assignment text; throwing refuses the accept. */
export type PrepareTicket = (ticket: Ticket, accept: Accept) => Ticket;
/** Receives each domain event with its time. */
export type Emit = (event: DomainEvent, at: string) => void;
/** The clock, as canonical timestamps. */
export type Clock = () => string;

/** What the Engine is built from. */
export interface EngineOptions {
  /** Durable state. */
  repo: Repositories;
  /** The Policy in force now. */
  policy: () => Policy;
  /** Decides whether a Source listens to a trigger; one it does not listen to is stored with a `filtered` disposition. */
  scope: SourceScope;
  /** Judges candidates. */
  assessor: Assessor;
  /** Runs assignments. */
  executor: Executor;
  /** Queues messages for Channels. */
  outbox: Outbox;
  /** Lets the Executor choose a new ticket's name, directory and assignment text; throwing refuses the accept. */
  prepareTicket?: PrepareTicket;
  /** The clock; the system clock when absent. */
  now?: Clock;
  /** Receives each domain event with its time. */
  emit?: Emit;
}

/** How a `receive` ended. */
export type ReceiveResult = "stored" | "duplicate" | "filtered";

/** Internal engine context shared across core domain modules. */
export interface EngineContext {
  readonly o: EngineOptions;
  repo(): Repositories;
  now(): string;
  policy(): Policy;
  emit(event: DomainEvent): void;
  owners(trigger: Trigger): string[];
  leftToWorkers(trigger: Trigger): void;
  dispositionOrNew(triggerId: string): TriggerDisposition;
  handBack(ticketId: string, trigger: Trigger, reason: string): boolean;
  takeUp(ticketId: string, triggerId: string): void;
  queueForEval(trigger: Trigger): boolean;
  require(ticketId: string): Ticket;
  threadOf(reference: ThreadRef): Thread;
  ticketsOnThread(thread: Thread): Ticket[];
  source(ticket: Ticket): Trigger | undefined;
  reaches(ticket: Ticket, trigger: Trigger, context: boolean): boolean;
}

/** Single transactional entry point for mutating Triggers, Threads, Decisions, Tickets, and Assignments. */
export class Engine implements EngineContext {
  readonly o: EngineOptions;

  constructor(options: EngineOptions) {
    this.o = options;
  }

  /** Run `work` in one transaction: committed when it returns, rolled back if it throws. */
  atomic<T>(work: () => T): T {
    this.o.repo.begin();
    try {
      const result = work();
      this.o.repo.commit();
      return result;
    } catch (error) {
      this.o.repo.rollback();
      throw error;
    }
  }

  // Shared helpers (EngineContext)

  repo(): Repositories {
    return this.o.repo;
  }

  now(): string {
    return this.o.now !== undefined ? this.o.now() : nowIso();
  }

  policy(): Policy {
    return this.o.policy();
  }

  emit(event: DomainEvent): void {
    if (this.o.emit !== undefined) {
      this.o.emit(event, this.now());
    }
  }

  owners(trigger: Trigger): string[] {
    return followupOwners(trigger, this.o.repo);
  }

  leftToWorkers(trigger: Trigger): void {
    const owners = this.owners(trigger);
    if (owners.length > 0) {
      throw UserError.with("workerDecides", { tickets: owners.join(", ") });
    }
  }

  dispositionOrNew(triggerId: string): TriggerDisposition {
    return this.o.repo.disposition(triggerId) ?? dispositionAt(this.now());
  }

  handBack(ticketId: string, trigger: Trigger, reason: string): boolean {
    const decided = this.owners(trigger).includes(ticketId);
    const disposition = this.dispositionOrNew(trigger.id);
    const handbacks = disposition.handbacks ?? [];
    handbacks.push({ ticketId, reason, at: this.now() });
    disposition.handbacks = handbacks;
    this.o.repo.saveDisposition(trigger.id, disposition);
    return decided && this.owners(trigger).length === 0 && this.queueForEval(trigger);
  }

  takeUp(ticketId: string, triggerId: string): void {
    const disposition = this.o.repo.disposition(triggerId);
    if (disposition !== undefined) {
      const acked = disposition.acked ?? [];
      if (!acked.includes(ticketId)) {
        acked.push(ticketId);
        disposition.acked = acked;
        this.o.repo.saveDisposition(triggerId, disposition);
      }
    }
  }

  queueForEval(trigger: Trigger): boolean {
    const primary = this.threadOf(trigger.threads[0]);
    const held = primary.evaluating?.triggerIds.includes(trigger.id) ?? false;
    if (held || primary.pending.includes(trigger.id)) {
      return false;
    }
    primary.pending.push(trigger.id);
    this.o.repo.saveThread(primary);
    return true;
  }

  require(ticketId: string): Ticket {
    const ticket = this.o.repo.ticket(ticketId);
    if (ticket === undefined) {
      throw UserError.create("unknownTicket");
    }
    return ticket;
  }

  threadOf(reference: ThreadRef): Thread {
    const k = threadKey(reference);
    return (
      this.o.repo.thread(k) ?? {
        key: k,
        ref: structuredClone(reference),
        createdAt: this.now(),
        subscriptions: [],
        correlated: [],
        pending: [],
        meta: {},
      }
    );
  }

  ticketsOnThread(thread: Thread): Ticket[] {
    const out: Ticket[] = [];
    for (const id of thread.subscriptions) {
      const ticket = this.o.repo.ticket(id);
      if (ticket !== undefined) {
        out.push(ticket);
      }
    }
    return out;
  }

  source(ticket: Ticket): Trigger | undefined {
    return this.o.repo.trigger(ticket.origin.triggerId);
  }

  reaches(ticket: Ticket, trigger: Trigger, context: boolean): boolean {
    return reached(ticket, trigger, (k) => this.o.repo.thread(k), context);
  }

  // Sources

  /**
   * A Source's request to take in a Trigger: store it once, fan it out to the tickets that subscribe to its Threads
   * (to an ended one only a person's message, which resumes it at once unless processing is paused, and to none a
   * person stopped), and queue it for Eval on its primary Thread unless a ticket's worker decides it.
   */
  receive(trigger: Trigger): ReceiveResult {
    return this.atomic(() => intakeReceive(this, trigger));
  }

  // The clock

  /**
   * Requeues overdue Evals before recording `unavailable`, starts the Evals of Threads whose queued Triggers wait,
   * and resumes ended tickets a person's message reached while processing was paused. While processing is paused,
   * nothing expires. Each Eval and each ticket update takes one transaction.
   */
  evaluateDue(): void {
    const policy = this.policy();
    for (const thread of this.o.repo.activeThreads()) {
      if (thread.evaluating !== undefined) {
        this.atomic(() => {
          evalsDue(this, thread, policy);
        });
      }
    }
    if (policy.paused()) {
      return;
    }
    for (const ticket of this.o.repo.activeTickets()) {
      if (!isTicketLive(ticket) && ticket.undelivered.length > 0) {
        this.atomic(() => {
          ticketsWake(this, ticket.id);
        });
      }
    }
    for (const thread of this.o.repo.activeThreads()) {
      if (thread.pending.length > 0 && thread.evaluating === undefined) {
        this.atomic(() => {
          evalsStart(this, thread.key, policy);
        });
      }
    }
  }

  // The main Session

  /** The candidate of the Eval that holds a Trigger, as its assessor sees it; `undefined` while no Eval holds it. */
  candidate(triggerId: string): Candidate | undefined {
    return evalsCandidate(this, triggerId);
  }

  /**
   * Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does, such as a person's
   * explicit request the main Session routes. A Trigger that already started a ticket returns that ticket's Decision.
   * An invalid stop is recorded as `ignore`; one judged under an older Policy as `unavailable`.
   */
  decide(triggerId: string, outcome: Outcome): Decision {
    return this.atomic(() => evalsDecide(this, triggerId, outcome));
  }

  /**
   * Attach a Trigger to a ticket that the message points at: the ticket follows the Trigger's Threads and receives it
   * as an Input with the routing note, and the Eval that holds the Trigger ends. An ended ticket resumes under its
   * Mandate, at once unless processing is paused.
   */
  attach(ticketId: string, triggerId: string, note?: string): Ticket {
    return this.atomic(() => {
      // A message this ticket's worker handed back is not its work: attached here, no worker would decide it.
      const disposition = this.o.repo.disposition(triggerId);
      if (disposition !== undefined && handedBackBy(disposition, ticketId)) {
        throw UserError.create("handedBackHere");
      }
      const trigger = ticketsAttachable(this, ticketId, triggerId);
      evalsWithdraw(this, trigger);
      ticketsAttach(this, ticketId, trigger, note);
      evalsRouted(this, triggerId, ticketId);
      ticketsWake(this, ticketId);
      return this.require(ticketId);
    });
  }

  /** Ask a running worker that waits in `waiting` state for its status; any other worker is left alone. */
  requestStatus(ticketId: string): boolean {
    return this.atomic(() => ticketsRequestStatus(this, ticketId));
  }

  /** Wake an open ticket's running worker with a Watchdog diagnostic message so it can inspect, finish or report. */
  wakeWorker(ticketId: string, text: string): boolean {
    return this.atomic(() => ticketsWakeWorker(this, ticketId, text));
  }

  /** Queue a message for the Channel its purpose names; a message queued before is not queued again. */
  reply(request: ReplyRequest): Reply {
    return this.atomic(() => repliesReply(this, request));
  }

  // People, through the app or the main Session

  /** The assessor delivered an Eval's candidate to its Session: the Eval's deadline counts from now. */
  candidateDelivered(evalId: string): void {
    this.atomic(() => {
      evalsDelivered(this, evalId, this.policy());
    });
  }

  /** Queue a stored Trigger for a fresh Eval, such as a person's replay; false while an Eval holds it. */
  reevaluate(triggerId: string): boolean {
    return this.atomic(() => evalsReevaluate(this, triggerId));
  }

  /** A person dismisses the problem an unavailable Decision shows. */
  dismiss(decisionId: string): Decision {
    return this.atomic(() => evalsDismiss(this, decisionId));
  }

  /** Drop every ticket's Subscription to a Thread, until a new Decision subscribes one again. */
  unsubscribe(thread: string): boolean {
    return this.atomic(() => ticketsDropSubscriptions(this, thread, true));
  }

  /** A person stops a ticket, which withdraws its Mandate: it ends and receives nothing more. */
  stopTicket(ticketId: string, reason?: string): Ticket {
    return this.atomic(() => {
      ticketsEnd(this, ticketId, "human", "stopped", undefined, reason);
      return this.require(ticketId);
    });
  }

  /**
   * A person retries a ticket whose worker reported failed or blocked (or whose input delivery failed): the stalled
   * Assignment ends and a new one starts under the same Mandate.
   */
  retryTicket(ticketId: string): Ticket {
    return this.atomic(() => ticketsRetry(this, ticketId));
  }

  // The Executor

  /** The Executor's fact that an Assignment runs; the Inputs that wait for it go out. */
  assignmentStarted(ticketId: string, assignmentId: string): void {
    this.atomic(() => {
      assignmentsStarted(this, ticketId, assignmentId);
    });
  }

  /** The Executor's fact that Inputs reached the Assignment that runs the ticket, which clears a failed delivery. */
  inputsDelivered(ticketId: string, assignmentId: string, inputIds: readonly string[]): void {
    this.atomic(() => {
      assignmentsDelivered(this, ticketId, assignmentId, inputIds);
    });
  }

  /** The Executor's fact that the worker's Session took the messages that carried Inputs into a step. */
  inputsRead(ticketId: string, inputIds: readonly string[]): void {
    this.atomic(() => {
      assignmentsRead(this, ticketId, inputIds);
    });
  }

  /** The Executor's fact that a turn of the worker of the Assignment that runs the ticket ended. */
  turnEnded(ticketId: string, assignmentId: string): void {
    this.atomic(() => {
      assignmentsTurnEnded(this, ticketId, assignmentId);
    });
  }

  /** The Executor's fact that delivering Inputs to the Assignment that runs the ticket failed. */
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    this.atomic(() => {
      assignmentsDeliveryFailed(this, ticketId, assignmentId, error);
    });
  }

  /**
   * A worker's request to mark a Thread attached to its ticket unrelated, for `reason`: only that ticket's
   * Subscription drops.
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    this.atomic(() => {
      ticketsMarkUnrelated(this, ticketId, thread, reason);
    });
  }

  /** An Executor's Subscription to a Thread it found related, for context. False when it follows the Thread already. */
  followForContext(ticketId: string, thread: ThreadRef): boolean {
    return this.atomic(() => ticketsFollowForContext(this, ticketId, thread));
  }

  /** A fact the main Session gives an open ticket's Executor as a note Input; it grants nothing. */
  note(ticketId: string, text: string): Ticket {
    return this.atomic(() => ticketsNote(this, ticketId, text));
  }

  /**
   * An Executor's hand-back of a message that reached its ticket but asks for more than it. Returns whether it was
   * queued for Eval: false while another ticket still decides it, and for one this ticket did not decide.
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    return this.atomic(() => evalsHandback(this, ticketId, triggerId, reason));
  }

  /**
   * Record a report on an open ticket's current Assignment. A `dropped` report ends the ticket, and so does a
   * `ready` one; a `blocked` or `failed` report holds back automated inputs until a human message arrives.
   */
  report(ticketId: string, report: WorkerReport): Ticket {
    return this.atomic(() => assignmentsReport(this, ticketId, report));
  }

  /**
   * Handles an assignment that was running when the host stopped: restarts it with a recovery note unless its latest
   * report is settled and no Input reached its worker after that report.
   */
  assignmentInterrupted(ticketId: string, assignmentId: string): void {
    this.atomic(() => {
      assignmentsInterrupted(this, ticketId, assignmentId);
    });
  }

  // Settings

  /**
   * The Policy changed: each open ticket in `effects` is told how the change bears on it, and Evals in progress
   * start again under the new version.
   */
  policyChanged(
    from: string,
    to: string,
    effects: ReadonlyMap<string, PolicyEffect> | Readonly<Record<string, PolicyEffect>>,
  ): void {
    this.atomic(() => {
      ticketsPolicyChanged(this, from, to, effects);
      evalsPolicyChanged(this, from, to);
    });
  }
}
