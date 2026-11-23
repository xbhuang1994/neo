/**
 * Domain model of a proactive agent: the concepts and their invariants, independent of any source, policy, or executor.
 */

import type { Reason } from "./reasons.ts";

/** A JSON object of source-native or assessor-supplied details the core never interprets. */
export type Json = Record<string, unknown>;

/** Actor identity in the source's own vocabulary; Policy decides which actors may originate work on that Source. */
export interface ActorRef {
  /** The Source the actor belongs to. */
  source: string;
  /** The actor's id on that Source. */
  id: string;
}

/** Thread identity; the rule that derives `id` from a native event belongs to the source. */
export interface ThreadRef {
  /** The Source the thread belongs to. */
  source: string;
  /** The thread's id on that Source. */
  id: string;
}

/** Write-only address on a thread; the address format belongs to the source. */
export interface ChannelRef {
  /** The Source that delivers to the channel. */
  source: string;
  /** The thread the channel writes to. */
  thread: string;
  /** Source-native address fields. */
  address: Record<string, string>;
}

/** Structural equality for two `ChannelRef` values. */
export function channelRefEquals(a: ChannelRef, b: ChannelRef): boolean {
  if (a.source !== b.source || a.thread !== b.thread) return false;
  const keysA = Object.keys(a.address);
  const keysB = Object.keys(b.address);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b.address, k) || a.address[k] !== b.address[k]) {
      return false;
    }
  }
  return true;
}

/** Stable key of a thread across the whole domain. */
export function threadKey(reference: ThreadRef): string {
  return `${reference.source}:${reference.id}`;
}

/** How a sender addressed the agent. */
export type Addressed = "mention" | "direct";

/** One immutable event produced by a source. `text` and `meta` are untrusted external data. */
export interface Trigger {
  /** Stable id; a trigger received twice is stored once. */
  id: string;
  /** The Source that produced it. */
  source: string;
  /** Every thread the trigger belongs to; the first is the primary thread that hosts its evaluation. */
  threads: ThreadRef[];
  /** Who wrote it. */
  actor: ActorRef;
  /** Source-declared: the event was written by a person rather than a bot or this agent. */
  human: boolean;
  /** Source-declared: the sender addressed the agent. */
  addressed?: Addressed;
  /** When it happened, in canonical form. */
  at: string;
  /** What it says. */
  text: string;
  /** Where a reply to it goes. */
  channel?: ChannelRef;
  /** A link to it, when the Source has one. */
  url?: string;
  /** Source-native details for adapters; the core never interprets them. */
  meta: Json;
}

/** A ticket's hand-back of a trigger as beyond the ticket. */
export interface Handback {
  /** The ticket whose worker handed it back. */
  ticketId: string;
  /** Why. */
  reason: string;
  /** When. */
  at: string;
}

/** Where a trigger went after intake; it grants nothing, but decides who decides a person's follow-up (see `followupOwners`). */
export interface TriggerDisposition {
  /** Rejected by the source scope filter before entering the domain, for the Source's reason. */
  filtered?: Reason;
  /** The Eval that holds or held it. */
  evalId?: string;
  /** The Decision its Eval ended with. */
  decisionId?: string;
  /**
   * The tickets it reached, by subscription fan-out or attached by the main Session; a ticket that ended or could not
   * resume without its worker taking it up no longer counts.
   */
  fanout: string[];
  /** The tickets of `fanout` it reached only on a Thread their Executor follows for context (omitted when empty). */
  context?: string[];
  /** A person, or the main Session for a message no ticket decides, sent it to Eval again (omitted when false). */
  requeued?: boolean;
  /** The tickets whose Executor handed it back as beyond the ticket, each once (omitted when empty). */
  handbacks?: Handback[];
  /** The tickets whose Executor acknowledged it or answered it, taking it up as within the ticket (omitted when empty). */
  acked?: string[];
  /** When the disposition was first recorded. */
  at: string;
}

/** An empty disposition recorded at `at`. */
export function dispositionAt(at: string): TriggerDisposition {
  return { fanout: [], at };
}

/** Whether `ticketId` handed the trigger back. */
export function handedBackBy(disposition: TriggerDisposition, ticketId: string): boolean {
  return disposition.handbacks?.some((item) => item.ticketId === ticketId) ?? false;
}

/** How strongly a trigger asks for work: a person's explicit request, or a candidate the agent inferred. */
export type Strength = "explicit" | "inferred";

/** The cells of a receiving scope's row in the admission table, by whether the sender is listed and addresses the agent. */
export type AdmissionCell = "listedUnaddressed" | "unlistedAddressed" | "unlistedUnaddressed";

/** Whether proactive candidates are assessed and accepted (`auto`), assessed without accepting (`observe`), or not admitted (`off`). */
export type AcceptMode = "off" | "observe" | "auto";

/** The accept mode an inferred candidate was made under. */
export interface Observation {
  /** The accept mode at the gate. */
  mode: AcceptMode;
}

/** How the gate admitted a Trigger (tagged with `via`, flattened into `MandateBasis`). */
export type BasisVia =
  | { via: "addressed"; addressed: Addressed }
  | { via: "followup" }
  | { via: "admission"; cell: AdmissionCell; addressed?: Addressed; observation?: Observation }
  | { via: "bot"; addressed?: Addressed; observation: Observation };

/** Common fields on `MandateBasis` alongside the flattened `BasisVia`. */
export interface MandateBasisCommon {
  /** The Source it was received on. */
  source?: string;
  /** The receiving scope as the Source recorded it. */
  scope?: Json;
  /** The admission row of the receiving scope. */
  row?: string;
  /** The allowed sender at acceptance time. */
  sender?: string;
  /** The rules an assessment matched. */
  rules?: string[];
}

/** How the gate admitted the Trigger a Mandate came from, which `revalidate` re-checks, and where it was received. */
export type MandateBasis = MandateBasisCommon & BasisVia;

/** Construct a `MandateBasis` from its admission path and optional metadata fields. */
export function mandateBasisVia(via: BasisVia, common?: MandateBasisCommon): MandateBasis {
  if (common === undefined) return { ...via };
  const out: MandateBasisCommon = {};
  if (common.source !== undefined) out.source = common.source;
  if (common.scope !== undefined) out.scope = common.scope;
  if (common.row !== undefined) out.row = common.row;
  if (common.sender !== undefined) out.sender = common.sender;
  if (common.rules !== undefined) out.rules = common.rules;
  return { ...out, ...via };
}

/** Immutable authorization produced by an accept decision; execution is bounded by it and it never changes. */
export interface Mandate {
  /** Explicit request or inferred candidate. */
  strength: Strength;
  /** The Policy version it was accepted under. */
  policyVersion: string;
  /** How the gate admitted it, for re-validation and audit. */
  basis: MandateBasis;
  /** Who it is for. */
  actor: ActorRef;
  /** What it authorizes, in words. */
  scope: string;
}

/** Active trigger evaluation on a thread; at most one exists per thread. */
export interface Evaluation {
  /** Stable id. */
  id: string;
  /** The thread it runs on. */
  threadKey: string;
  /** The batch it holds. */
  triggerIds: string[];
  /** The admissible Trigger that gave the batch its strength, which a ticket the Eval starts takes as its origin. */
  primary?: string;
  /** The batch's strength. */
  strength: Strength;
  /** Actor of the strongest admissible trigger; seeds the mandate on accept. */
  actor: ActorRef;
  /** Gate basis of the strongest admissible trigger; seeds the mandate on accept. */
  basis: MandateBasis;
  /** The Policy version the gate judged under. */
  policyVersion: string;
  /** When it started. */
  startedAt: string;
  /** When the candidate reached the assessor's Session; it cannot expire before, and its deadline counts from then. */
  delivered?: string;
  /** Expiration timestamp; a processing pause shifts it forward by the pause duration. */
  deadline: string;
  /** When a processing pause began; cleared on resume. */
  pausedAt?: string;
}

/** Thread aggregate: consistency boundary of eval, holder of subscriptions and decision history. */
export interface Thread {
  /** `source:id`. */
  key: string;
  /** Its identity on its Source (wire field name `ref`). */
  ref: ThreadRef;
  /** When it was first seen. */
  createdAt: string;
  /** Time of the newest trigger on the thread. */
  lastAt?: string;
  /** Tickets subscribed to this thread; live ones receive every trigger as context through fan-out. */
  subscriptions: string[];
  /**
   * The subscribed tickets whose Executor follows the thread for read-only context (omitted when empty).
   */
  context?: string[];
  /** Keys of threads that shared a trigger with this one; context only. */
  correlated: string[];
  /** Triggers waiting for the next eval (debounce buffer). */
  pending: string[];
  /** The Eval in progress. */
  evaluating?: Evaluation;
  /** How many Evals of its queued Triggers expired in a row, each of which queued them again; a Decision clears it. */
  expired?: number;
  /** Source-native attributes needed by channels or readers. */
  meta: Json;
}

/** What an Eval ended with. */
export type DecisionKind = "ignore" | "accept" | "stop" | "unavailable";

/** Outcome of one eval, recorded on the thread. */
export interface Decision {
  /** Stable id derived from its Eval. */
  id: string;
  /** The Eval it ends. */
  evalId: string;
  /** The thread it was recorded on. */
  threadKey: string;
  /** The batch it decides. */
  triggerIds: string[];
  /** The Policy version it was decided under. */
  policyVersion: string;
  /** When. */
  at: string;
  /** What was decided. */
  kind: DecisionKind;
  /** Why, by code: one reason, or one for each Trigger of the batch it concerns. */
  reason: Reason[];
  /** The Eval's strength. */
  strength: Strength;
  /** The ticket an accept created or a stop ended. */
  ticketId?: string;
  /** The Mandate an accept gave. */
  mandate?: Mandate;
  /** Assessor-supplied audit data (rule assessments, direction, evidence). */
  audit?: Json;
  /** A person dismissed the problem an unavailable Decision shows (omitted when false). */
  dismissed?: boolean;
}

/** Lifecycle of an Assignment. */
export type AssignmentState = "pending" | "running" | "ended";

/**
 * What an Assignment reports: work is in progress, its worker waits for a Trigger, a result is ready, a person must act
 * to unblock or recover it, or nothing is left to do.
 */
export type ReportState = "progress" | "waiting" | "ready" | "blocked" | "failed" | "dropped";

/** The latest report of an Assignment. */
export interface Report {
  /** What it reports. */
  state: ReportState;
  /** In words. */
  summary: string;
  /** When. */
  at: string;
}

/** Binding between a ticket and one executor instance. */
export interface Assignment {
  /** Stable id derived from the ticket and its ordinal. */
  id: string;
  /** Its lifecycle state. */
  state: AssignmentState;
  /** When it was created. */
  createdAt: string;
  /** When its worker started. */
  startedAt?: string;
  /** When it ended. */
  endedAt?: string;
  /** Why it ended, when it ended before its ticket. */
  endedReason?: string;
  /** Its latest report. */
  report?: Report;
  /** When Inputs last reached the worker; one at or after `report.at` means the worker has been busy since that report. */
  deliveredAt?: string;
  /** When a turn of its worker last ended with nothing left to run for it and nothing waiting for it. */
  idleAt?: string;
}

/**
 * Whether a ticket's worker has read a Trigger Input:
 * - `undefined` = Undelivered (omits `readAt` in JSON)
 * - `null` = Waiting (serializes `readAt: null` in JSON)
 * - `string` = At(timestamp) (serializes `readAt: "<ts>"` in JSON)
 */
export type ReadAt = string | null | undefined;

/** True when the Trigger Input has not been delivered to a worker's Session (`readAt` omitted / `undefined`). */
export function isReadUndelivered(readAt: ReadAt): readAt is undefined {
  return readAt === undefined;
}

/** True when the Trigger Input waits in the worker's Session (`readAt === null`). */
export function isReadWaiting(readAt: ReadAt): readAt is null {
  return readAt === null;
}

/** Returns the read timestamp when the worker's Session took the Trigger Input into a step, else `undefined`. */
export function readAtTimestamp(readAt: ReadAt): string | undefined {
  return typeof readAt === "string" ? readAt : undefined;
}

/** How a Policy change bears on one rule a ticket was accepted under. */
export interface RuleEffect {
  /** The rule's id. */
  id: string;
  /** The rule's name. */
  name: string;
  /** `changed` or `disabled`. */
  change: string;
  /** Its instruction now, when it changed. */
  instruction?: string;
}

/**
 * How a Policy change bears on a ticket: the rules it was accepted under that changed or no longer apply; `proactive:
 * false` once inferred work is no longer accepted; and `requesterAllowed: false` once its requester may no longer start work.
 */
export interface PolicyEffect {
  /** The rules that changed or were disabled (omitted when empty). */
  rules?: RuleEffect[];
  /** `false` once inferred work is no longer accepted. */
  proactive?: boolean;
  /** `false` once the requester may no longer start work there. */
  requesterAllowed?: boolean;
  /** The sender the ticket is for. */
  requester?: ActorRef;
}

/** A Trigger Input delivered to a ticket. */
export interface TriggerTicketInput {
  kind: "trigger";
  /** Stable id. */
  id: string;
  /** The Trigger. */
  triggerId: string;
  /** When it reached the ticket. */
  at: string;
  /** The main Session's routing note. */
  note?: string;
  /** A person wrote it (omitted when false). */
  human?: boolean;
  /** It reached the ticket only on a Thread its Executor follows for context (omitted when false). */
  context?: boolean;
  /** Whether the worker has read it (`undefined` = Undelivered, `null` = Waiting, `string` = At(ts)). */
  readAt?: string | null;
  /** The Assignment it was last delivered to. */
  deliveredTo?: string;
}

/** A PolicyChanged Input delivered to a ticket. */
export interface PolicyChangedTicketInput {
  kind: "policy-changed";
  /** Stable id. */
  id: string;
  /** The Policy version before. */
  from: string;
  /** The Policy version after. */
  to: string;
  /** When. */
  at: string;
  /** How it bears on the ticket. */
  effect: PolicyEffect;
}

/** A Resumed Input marking that a human's message resumed an ended ticket. */
export interface ResumedTicketInput {
  kind: "resumed";
  /** Stable id. */
  id: string;
  /** The message that resumed it. */
  triggerId: string;
  /** When. */
  at: string;
}

/** Text from the host, such as a status request or a recovery note. */
export interface TextTicketInput {
  kind: "text";
  /** Stable id. */
  id: string;
  /** The text. */
  text: string;
  /** When. */
  at: string;
}

/** A fact the main Session gave the ticket from other work: context, which asks for nothing and grants nothing. */
export interface NoteTicketInput {
  kind: "note";
  /** Stable id. */
  id: string;
  /** The fact. */
  text: string;
  /** When. */
  at: string;
}

/** What a ticket's worker receives. */
export type TicketInput =
  | TriggerTicketInput
  | PolicyChangedTicketInput
  | ResumedTicketInput
  | TextTicketInput
  | NoteTicketInput;

/** The Trigger a trigger Input carries (only for `kind: "trigger"` inputs). */
export function ticketInputTriggerId(input: TicketInput): string | undefined {
  return input.kind === "trigger" ? input.triggerId : undefined;
}

/** Whether it is a message no person wrote, such as a bot's or the main Session's note. */
export function ticketInputAutomatic(input: TicketInput): boolean {
  return input.kind === "note" || (input.kind === "trigger" && !input.human);
}

/** Who ended a ticket. */
export type TicketEndBy = "executor" | "human";

/** How a ticket ended: with its result, with nothing to do, or stopped by a person. */
export type TicketOutcome = "completed" | "dropped" | "stopped";

/** When, by whom, and how a ticket ended. */
export interface Ended {
  /** When. */
  at: string;
  /** By whom. */
  by: TicketEndBy;
  /** How. */
  outcome: TicketOutcome;
  /** A person's or the host's reason beyond the outcome. */
  reason?: string;
}

/** A question for a person; `triggerId` is the human message that raised it, whose conversation it goes back to. */
export interface Attention {
  /** Stable id. */
  id: string;
  /** The question. */
  question: string;
  /** The message that raised it. */
  triggerId?: string;
}

/** The Triggers a ticket was accepted from. */
export interface Origin {
  /** The one that started it. */
  triggerId: string;
  /** The batch its Eval held. */
  triggerIds: string[];
}

/** What a ticket's Executor chose: its short name, directory and assignment text. */
export interface Execution {
  /** Short name. */
  name: string;
  /** Working directory. */
  directory: string;
  /** The assignment text its worker starts from. */
  assignment: string;
}

/** The latest failed delivery of an Input to a ticket's worker. */
export interface DeliveryFailure {
  /** What went wrong. */
  error: string;
  /** When. */
  at: string;
}

/** Ticket aggregate: an authorized work item with its assignments, channels and inputs. */
export interface Ticket {
  /** Stable id derived from its Eval. */
  id: string;
  /** What it is, in a line. */
  title: string;
  /** The accept that created it. */
  decisionId: string;
  /** What authorizes it. */
  mandate: Mandate;
  /** The Channels of the messages it was accepted from, which its replies go to. */
  channels: ChannelRef[];
  /** When, by whom, and how the ticket ended; an open ticket has none. */
  ended?: Ended;
  /** Open question for a person; cleared by the executor or when the ticket ends. */
  attention?: Attention;
  /** Its Assignments, oldest first; the latest is the only one that can be pending or running. */
  assignments: Assignment[];
  /** Everything its worker received or will receive. */
  inputs: TicketInput[];
  /** Inputs not yet handed to a running assignment. */
  undelivered: string[];
  /** People's questions the worker answered, whose answers the main Session may send (omitted when empty). */
  answers?: string[];
  /** A short description of what the ticket is about, kept current by its worker's reports. */
  digest?: string;
  /** When it was created. */
  createdAt: string;
  /** When it last changed. */
  updatedAt: string;
  /** The Triggers it was accepted from. */
  origin: Origin;
  /** What its Executor chose. */
  execution?: Execution;
  /** The latest failed delivery of an Input to its worker, until a delivery succeeds. */
  delivery?: DeliveryFailure;
  /** When the report was made whose result a person was sent: that report's result is not sent a second time. */
  resultSent?: string;
}

/** Whether the ticket is open: it has not ended. */
export function isTicketLive(ticket: Ticket): boolean {
  return ticket.ended === undefined;
}

/** Whether a person stopped it, which withdrew its Mandate. */
export function isStoppedByPerson(ticket: Ticket): boolean {
  return ticket.ended?.by === "human";
}

/** The Assignment whose worker runs. */
export function runningAssignment(ticket: Ticket): Assignment | undefined {
  return ticket.assignments.find((assignment) => assignment.state === "running");
}

/** The latest Assignment. */
export function latestAssignment(ticket: Ticket): Assignment | undefined {
  return ticket.assignments.length > 0 ? ticket.assignments[ticket.assignments.length - 1] : undefined;
}

/** The latest report any of its Assignments made, which is what the ticket last said. */
export function latestReport(ticket: Ticket): Report | undefined {
  for (let i = ticket.assignments.length - 1; i >= 0; i--) {
    const report = ticket.assignments[i].report;
    if (report !== undefined) return report;
  }
  return undefined;
}

/** The Input with this id. */
export function findTicketInput(ticket: Ticket, id: string): TicketInput | undefined {
  return ticket.inputs.find((input) => input.id === id);
}

/** Whether the Trigger came to the ticket as an Input. */
export function hasTriggerInput(ticket: Ticket, triggerId: string): boolean {
  return ticket.inputs.some((input) => ticketInputTriggerId(input) === triggerId);
}

/**
 * Until when its worker had a turn to read what reached it: its latest report (a progress report only when
 * `progress`), or the end of its latest turn, whichever is later.
 */
export function readUntil(ticket: Ticket, progress: boolean): string {
  let report = "";
  for (let i = ticket.assignments.length - 1; i >= 0; i--) {
    const r = ticket.assignments[i].report;
    if (r !== undefined && (progress || r.state !== "progress")) {
      report = r.at;
      break;
    }
  }
  let until = report;
  for (const assignment of ticket.assignments) {
    if (assignment.idleAt !== undefined && assignment.idleAt > until) {
      until = assignment.idleAt;
    }
  }
  return until;
}

/**
 * Whether it waits for a person: its latest Assignment reported blocked or failed, and no person's message reached
 * it since. A later report that is neither, a person's message, or a retry lifts it.
 */
export function waitsForPerson(ticket: Ticket): boolean {
  const report = latestAssignment(ticket)?.report;
  if (report === undefined) return false;
  if (report.state !== "blocked" && report.state !== "failed") return false;
  return !ticket.inputs.some(
    (input) => input.kind === "trigger" && input.human === true && !input.context && input.at > report.at,
  );
}

/** What deciding a follow-up's owners reads: the stored tickets, Threads and dispositions. */
export interface FollowupRecords {
  /** The stored ticket. */
  ticket(id: string): Ticket | undefined;
  /** The stored Thread. */
  thread(key: string): Thread | undefined;
  /** The stored disposition of a Trigger. */
  disposition(id: string): TriggerDisposition | undefined;
}

/**
 * The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
 * and did not hand it back. A ticket can while it is live, and while it is ended, not by a person, with the Trigger
 * waiting to resume it. None once a person sent it to Eval, or while an Eval holds it. While a ticket owns it, the
 * message goes to no Eval, and the main Session may only stop the work on it.
 */
export function followupOwners(trigger: Trigger, records: FollowupRecords): string[] {
  if (!trigger.human) return [];
  const disposition = records.disposition(trigger.id);
  if (disposition === undefined) return [];
  if (disposition.requeued) return [];
  const contextSet = disposition.context ? new Set(disposition.context) : undefined;
  const reachedIds = disposition.fanout.filter(
    (id) => !handedBackBy(disposition, id) && !(contextSet?.has(id) ?? false),
  );
  if (reachedIds.length === 0) return [];
  const firstThread = trigger.threads[0];
  if (firstThread !== undefined) {
    const thread = records.thread(threadKey(firstThread));
    if (thread?.evaluating?.triggerIds.includes(trigger.id)) {
      return [];
    }
  }
  return reachedIds.filter((id) => {
    const ticket = records.ticket(id);
    if (ticket === undefined) return false;
    if (isTicketLive(ticket)) return true;
    if (isStoppedByPerson(ticket)) return false;
    const undeliveredSet = new Set(ticket.undelivered);
    return ticket.inputs.some(
      (input) => ticketInputTriggerId(input) === trigger.id && undeliveredSet.has(input.id),
    );
  });
}

/**
 * Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that
 * ticket's work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
 */
export function settled(decision: Decision): boolean {
  if (decision.kind === "stop" || decision.kind === "unavailable") return false;
  return !decision.reason.some(
    (reason) =>
      reason.code === "stopNotExplicit" || reason.code === "stopUnknown" || reason.code === "routed",
  );
}

/**
 * Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket
 * subscribes to; with `context` false, not a Thread the ticket follows only for context.
 */
export function reached(
  ticket: Ticket,
  trigger: Trigger,
  getThread: (key: string) => Thread | undefined,
  context: boolean,
): boolean {
  if (ticket.origin.triggerId === trigger.id) return true;
  const threads = trigger.threads.map((reference) => getThread(threadKey(reference)));
  const follows = (current: Thread): boolean => current.context?.includes(ticket.id) ?? false;
  if (
    threads.some(
      (current) =>
        current !== undefined &&
        current.subscriptions.includes(ticket.id) &&
        (context || !follows(current)),
    )
  ) {
    return true;
  }
  return (
    hasTriggerInput(ticket, trigger.id) &&
    (context || !threads.every((current) => current !== undefined && follows(current)))
  );
}
