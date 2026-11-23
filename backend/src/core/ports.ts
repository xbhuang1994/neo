/**
 * Ports the core depends on. Sources, policies, assessors, executors, and channels are project-specific.
 */

import type {
  Assignment,
  ChannelRef,
  Decision,
  DecisionKind,
  FollowupRecords,
  Json,
  Mandate,
  MandateBasis,
  Strength,
  Thread,
  Ticket,
  TicketEndBy,
  TicketOutcome,
  Trigger,
  TriggerDisposition,
} from "./model.ts";
import { said, type Reason } from "./reasons.ts";

/** Gate admission result: either inadmissible with a reason code, or admissible with strength and basis. */
export type GateResult =
  | { kind: "inadmissible"; reason: string }
  | { kind: "admissible"; strength: Strength; basis: MandateBasis };

/** Whether a Source receives a Trigger. */
export type ScopeResult =
  | {
      kind: "listened";
      /** It also receives messages not addressed to the agent. */
      observed: boolean;
      /** The receiving scope the Policy's admission table names, such as a chat. */
      row?: string;
      /**
       * `false` keeps the Source's Threads subscribed but sends none of their Triggers to subscribed tickets: the
       * main Session routes each one to a single ticket.
       */
      fanout: boolean;
    }
  | {
      kind: "ignored";
      /** The scope's reason code. */
      reason: string;
    };

/** Source configuration as the domain sees it: listening scope per trigger or per recorded Mandate basis. */
export interface SourceScope {
  /** Whether the Source `source` receives an event with these native details. */
  scope(source: string, meta: Json): ScopeResult;
}

/** Versioned rules; `gate` decides who may originate work. Source scope is not part of Policy. */
export interface Policy {
  /** The version of the rules. */
  version(): string;
  /** Whether processing is paused. */
  paused(): boolean;
  /** Whether a trigger may originate work on its thread. */
  gate(trigger: Trigger, thread: Thread, tickets: readonly Ticket[]): GateResult;
  /** Re-check a mandate's gate-layer basis under this policy, such as before an ended ticket resumes. */
  revalidate(mandate: Mandate): boolean;
  /** Whether an inferred candidate may be accepted on the rules its assessment matched. */
  admitsInferred(rules: readonly string[]): boolean;
  /** How long an assessor may take before an eval is recorded as unavailable. */
  evalTimeoutMs(): number;
}

/** What the assessor receives: bounded facts, never authority. */
export interface Candidate {
  /** The Eval to decide. */
  evalId: string;
  /** The thread it runs on. */
  thread: Thread;
  /** The batch it holds. */
  triggers: Trigger[];
  /** The batch's strength. */
  strength: Strength;
  /** The Policy version the gate judged under. */
  policyVersion: string;
  /** Every ticket on the thread, including ended ones, for duplicate judgement. */
  tickets: Ticket[];
}

/** Why an outcome was decided: a code it carries, or the words its assessor or person wrote. */
export type Why =
  | { kind: "said"; text: string }
  | { kind: "code"; reason: Reason };

/** Construct a `Why` from words. */
export function whySaid(text: string): Why {
  return { kind: "said", text };
}

/** Construct a `Why` from a structured `Reason`. */
export function whyCode(reason: Reason): Why {
  return { kind: "code", reason };
}

/** Convert a `Why` into its `Reason[]` representation. */
export function whyReasons(why: Why): Reason[] {
  return [why.kind === "said" ? said(why.text) : why.reason];
}

/** An accept: the ticket to create. */
export interface Accept {
  /** The ticket's title. */
  title: string;
  /** What the Mandate authorizes, in words. */
  scope: string;
  /** The acknowledgement to send where the request was written. */
  acknowledgement?: string;
  /** The rules the assessment matched. */
  rules?: string[];
  /** The ticket's requested short name. */
  name?: string;
  /** A routing note for its worker. */
  note?: string;
}

/** What an assessment decided. */
export type OutcomeKind =
  | { kind: "ignore" }
  | { kind: "unavailable" }
  | { kind: "accept"; accept: Accept }
  | { kind: "stop"; ticketId: string };

/** An outcome for the Eval that holds a Trigger. */
export interface Outcome {
  /** What was decided. */
  kind: OutcomeKind;
  /** Why. */
  reason: Why;
  /** Assessor-supplied audit data. */
  audit?: Json;
  /** The Eval it was judged for, so a later Eval refuses it. */
  evalId?: string;
}

/** Construct an `Outcome` with optional audit and evalId. */
export function createOutcome(
  kind: OutcomeKind,
  reason: string | Why,
  options?: { audit?: Json; evalId?: string },
): Outcome {
  const why: Why = typeof reason === "string" ? whySaid(reason) : reason;
  return {
    kind,
    reason: why,
    ...(options?.audit !== undefined ? { audit: options.audit } : {}),
    ...(options?.evalId !== undefined ? { evalId: options.evalId } : {}),
  };
}

/** Semantic judgement. `request` queues the assessment, idempotently per Eval; the outcome returns through `Engine.decide`. */
export interface Assessor {
  /** Queue the assessment of a candidate. */
  request(candidate: Candidate): void;
  /** Called whenever an eval ends, decided or not, so the assessor drops what it kept for it. */
  release?(evalId: string): void;
}

/**
 * Executes assignments; concurrency and workspace management are its own concern. The Engine calls it inside its
 * commands, so each method only queues work, which reports back through the Engine's callbacks.
 */
export interface Executor {
  /** Queue a pending assignment for launch. */
  start(ticket: Ticket, assignment: Assignment): void;
  /** Queue delivery of the ticket's waiting Inputs to its running assignment. */
  deliver(ticket: Ticket, assignment: Assignment): void;
  /** End an assignment's work; called after the ticket or assignment has already ended in the domain. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void;
}

/** What a queued message is. */
export type MessageKind = "acknowledgement" | "reply" | "notice";

/** A message for a Channel; `ticketId` names the Ticket it is for, when there is one. */
export interface OutboundMessage {
  /** Deterministic id that keeps it from going out twice. */
  id: string;
  /** Where it goes. */
  channel: ChannelRef;
  /** What it says. */
  text: string;
  /** What it is. */
  kind: MessageKind;
  /** The ticket it is for. */
  ticketId?: string;
}

/** A queued message waits, went out, or was dropped because its conversation can never receive it. */
export type ReplyStatus = "pending" | "sent" | "dropped";

/** The messages queued for Channels; the Engine queues them inside its commands, and a sender delivers them later. */
export interface Outbox {
  /** Queue a message idempotently; an id queued before keeps its first message. */
  send(message: OutboundMessage): void;
  /** Whether a message was queued, and what became of it. */
  status(id: string): ReplyStatus | undefined;
  /** Withdraw a message that has not gone out. */
  withdraw(id: string): void;
}

/** What the Engine reports after a change. */
export type DomainEvent =
  | { type: "triggerReceived"; triggerId: string; threads: string[] }
  | { type: "evalStarted"; evalId: string; threadKey: string; triggerIds: string[]; strength: Strength }
  | { type: "decisionRecorded"; decisionId: string; kind: DecisionKind; threadKey: string }
  | { type: "ticketCreated"; ticketId: string; decisionId: string; strength: Strength }
  | { type: "ticketResumed"; ticketId: string; triggerId: string }
  | { type: "ticketEnded"; ticketId: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  | { type: "assignmentStarted"; ticketId: string; assignmentId: string }
  | { type: "assignmentEnded"; ticketId: string; assignmentId: string; reason: string }
  | { type: "threadSubscribed"; threadKey: string; ticketId: string }
  | { type: "threadUnsubscribed"; threadKey: string; ticketId: string; byPerson: boolean; reason?: string }
  | { type: "triggerRequeued"; triggerId: string }
  | { type: "triggerFollowup"; triggerId: string }
  | { type: "policyChanged"; from: string; to: string };

/**
 * Durable state. Every method is synchronous so a transaction can wrap a unit of work; values are returned by copy, so
 * a caller's changes reach the store only through `save*`.
 */
export interface Repositories extends FollowupRecords {
  /** Open a (possibly nested) transaction. */
  begin(): void;
  /** Commit the innermost transaction. */
  commit(): void;
  /** Roll the innermost transaction back. */
  rollback(): void;

  /** The stored Trigger. */
  trigger(id: string): Trigger | undefined;
  /** Store a Trigger. */
  saveTrigger(trigger: Trigger): void;
  /** The stored disposition of a Trigger. */
  disposition(id: string): TriggerDisposition | undefined;
  /** Store a Trigger's disposition. */
  saveDisposition(id: string, value: TriggerDisposition): void;

  /** The stored Thread. */
  thread(key: string): Thread | undefined;
  /** Store a Thread. */
  saveThread(thread: Thread): void;
  /** Every Thread. */
  threads(): Thread[];
  /** Threads with Triggers queued for Eval or an Eval in progress. */
  activeThreads(): Thread[];

  /** The stored ticket. */
  ticket(id: string): Ticket | undefined;
  /** Store a ticket. */
  saveTicket(ticket: Ticket): void;
  /** Every ticket, newest first. */
  tickets(): Ticket[];
  /** Tickets that have not ended, newest first. */
  openTickets(): Ticket[];
  /** Tickets with undelivered Inputs or a pending or running Assignment. */
  activeTickets(): Ticket[];

  /** The stored Decision. */
  decision(id: string): Decision | undefined;
  /** Store a Decision. */
  saveDecision(decision: Decision): void;
  /** A Thread's Decisions, oldest first. */
  decisionsByThread(key: string): Decision[];
}
