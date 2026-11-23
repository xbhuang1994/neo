/**
 * Tickets: their lifecycle from an accept to their end, their Subscriptions and their Inputs.
 */

import type { EngineContext } from "./engine.ts";
import { UserError } from "./errors.ts";
import { key } from "./ids.ts";
import {
  channelRefEquals,
  findTicketInput,
  isReadUndelivered,
  isReadWaiting,
  isStoppedByPerson,
  isTicketLive,
  latestAssignment,
  readAtTimestamp,
  readUntil,
  runningAssignment,
  settled,
  threadKey,
  ticketInputAutomatic,
  ticketInputTriggerId,
  waitsForPerson,
  type Assignment,
  type Evaluation,
  type Mandate,
  type Origin,
  type PolicyEffect,
  type ThreadRef,
  type Ticket,
  type TicketEndBy,
  type TicketInput,
  type TicketOutcome,
  type Trigger,
  type TriggerTicketInput,
} from "./model.ts";
import type { Accept } from "./ports.ts";
import { repliesAcknowledgeAccepted } from "./replies.ts";
import { canRetry } from "./stage.ts";

const STATUS_REQUEST =
  "Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.";

/**
 * Whether a ticket's worker read a Trigger Input before `until`, its latest report or turn end: its Session took the
 * message into a step before then. One that never reached a Session counts by when it reached the ticket.
 */
function readBefore(input: TicketInput, until: string): boolean {
  if (input.kind !== "trigger") return false;
  if (isReadUndelivered(input.readAt)) return input.at <= until;
  const read = readAtTimestamp(input.readAt);
  if (read !== undefined) return read < until;
  return false;
}

/**
 * Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its
 * first Assignment, and the acknowledgement the accept carries, and queue its launch.
 */
export function ticketsCreate(
  ctx: EngineContext,
  id: string,
  decisionId: string,
  mandate: Mandate,
  evaluation: Evaluation,
  accept: Accept,
  at: string,
): void {
  const triggerIds = [...evaluation.triggerIds];
  const primaryId = evaluation.primary ?? triggerIds[triggerIds.length - 1] ?? "";
  const primary = ctx.repo().trigger(primaryId);
  const origin: Origin = {
    triggerId: primary?.id ?? triggerIds[0],
    triggerIds: [...triggerIds],
  };

  let ticket: Ticket = {
    id,
    title: accept.title,
    decisionId,
    mandate: structuredClone(mandate),
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: at,
    updatedAt: at,
    origin,
  };

  const triggers: Trigger[] = [];
  for (const triggerId of triggerIds) {
    const trigger = ctx.repo().trigger(triggerId);
    if (trigger !== undefined) {
      triggers.push(trigger);
    }
  }
  for (const trigger of triggers) {
    const channel = trigger.channel;
    if (channel !== undefined && !ticket.channels.some((c) => channelRefEquals(c, channel))) {
      ticket.channels.push(structuredClone(channel));
    }
  }

  if (ctx.o.prepareTicket !== undefined) {
    ticket = ctx.o.prepareTicket(ticket, accept);
  }

  const assignment = newAssignment(ctx, ticket);
  ctx.repo().saveTicket(ticket);

  for (const trigger of triggers) {
    for (const reference of trigger.threads) {
      subscribe(ctx, id, reference);
    }
  }

  if (accept.acknowledgement !== undefined && primary !== undefined) {
    repliesAcknowledgeAccepted(ctx, id, primary, accept.acknowledgement);
  }

  ctx.o.executor.start(ctx.require(id), assignment);
  ctx.emit({
    type: "ticketCreated",
    ticketId: id,
    decisionId,
    strength: mandate.strength,
  });
}

/** The Trigger to attach to a ticket, once the ticket may take it. */
export function ticketsAttachable(ctx: EngineContext, ticketId: string, triggerId: string): Trigger {
  const trigger = ctx.repo().trigger(triggerId);
  if (trigger === undefined) {
    throw UserError.create("unknownTrigger");
  }
  // A follow-up that reached a ticket goes elsewhere only once the workers that decide it hand it back.
  ctx.leftToWorkers(trigger);
  const current = ctx.require(ticketId);
  if (isStoppedByPerson(current)) {
    throw UserError.create("ticketStopped");
  }
  if (!isTicketLive(current) && !ctx.policy().revalidate(current.mandate)) {
    throw UserError.create("mandateRevoked");
  }
  return trigger;
}

/**
 * Subscribe a ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's
 * worker then decides it, as it decides a message that reached the ticket on its own Thread.
 */
export function ticketsAttach(
  ctx: EngineContext,
  ticketId: string,
  trigger: Trigger,
  note?: string,
): void {
  for (const reference of trigger.threads) {
    subscribe(ctx, ticketId, reference);
  }
  // A person's sending it to Eval, which routed it here, is over, and so is the ticket's reading it for context only.
  const current = ctx.dispositionOrNew(trigger.id);
  const disposition = structuredClone(current);
  delete disposition.requeued;
  if (disposition.context !== undefined) {
    disposition.context = disposition.context.filter((id) => id !== ticketId);
    if (disposition.context.length === 0) {
      delete disposition.context;
    }
  }
  if (!disposition.fanout.includes(ticketId)) {
    disposition.fanout.push(ticketId);
  }
  ctx.repo().saveDisposition(trigger.id, disposition);

  const ticket = ctx.require(ticketId);
  const id = key(["input", ticketId, "trigger", trigger.id]);
  const at = ctx.now();
  const makeInput = (inputId: string): TriggerTicketInput => ({
    kind: "trigger",
    id: inputId,
    triggerId: trigger.id,
    at,
    ...(note !== undefined ? { note } : {}),
    ...(trigger.human ? { human: true } : {}),
  });

  const existing = ticket.inputs.findIndex(
    (item) => item.id === id && ticketInputTriggerId(item) !== undefined,
  );
  if (existing === -1) {
    ticketsAddInput(ctx, ticket, makeInput(id));
  } else if (note !== undefined && ticket.undelivered.includes(id)) {
    const stored = ticket.inputs[existing];
    if (stored.kind === "trigger") {
      stored.note = note;
    }
    ticket.updatedAt = at;
    ctx.repo().saveTicket(ticket);
  } else if (
    current.requeued ||
    !current.fanout.includes(ticketId) ||
    (current.context?.includes(ticketId) ?? false) ||
    !isTicketLive(ticket)
  ) {
    // A person sent it to Eval, or the ticket let it go before its worker took it up, read it for context
    // only, or ended after its worker had it, so the worker gets it again.
    ticketsAddInput(
      ctx,
      ticket,
      makeInput(key(["input", ticketId, "trigger", trigger.id, "attached", at])),
    );
  } else if (note !== undefined) {
    // The worker has the message already, so the note comes with it again.
    ticketsAddInput(
      ctx,
      ticket,
      makeInput(key(["input", ticketId, "trigger", trigger.id, "note", note])),
    );
  }
}

/** Ask a running worker whose latest report is `waiting` for a status report; leaves any other ticket alone. */
export function ticketsRequestStatus(ctx: EngineContext, ticketId: string): boolean {
  const ticket = ctx.require(ticketId);
  const waiting = runningAssignment(ticket)?.report?.state === "waiting";
  if (!isTicketLive(ticket) || !waiting) {
    return false;
  }
  const input: TicketInput = {
    kind: "text",
    id: `status:${ticketId}:${ticket.updatedAt}`,
    text: STATUS_REQUEST,
    at: ctx.now(),
  };
  ticketsAddInput(ctx, ticket, input);
  return true;
}

/** Wake an open ticket's running Assignment with a Watchdog prompt so the worker can finish, recover or report. */
export function ticketsWakeWorker(ctx: EngineContext, ticketId: string, text: string): boolean {
  const ticket = ctx.require(ticketId);
  if (!isTicketLive(ticket) || runningAssignment(ticket) === undefined) {
    return false;
  }
  const at = ctx.now();
  const input: TicketInput = {
    kind: "text",
    id: key(["input", ticketId, "watchdog", at, text]),
    text: `[Watchdog] ${text}`,
    at,
  };
  ticketsAddInput(ctx, ticket, input);
  return true;
}

/** Ends the stalled assignment of a retryable open ticket and starts a new one. */
export function ticketsRetry(ctx: EngineContext, ticketId: string): Ticket {
  const ticket = ctx.require(ticketId);
  const latest = canRetry(ticket) ? latestAssignment(ticket) : undefined;
  if (latest === undefined) {
    throw UserError.create("notRetryable");
  }
  const ended = endAssignment(ctx, ticket, latest.id, "retried");
  requeueUntaken(ticket, ended.id);
  const assignment = newAssignment(ctx, ticket);
  ticket.updatedAt = ctx.now();
  ctx.repo().saveTicket(ticket);
  ctx.o.executor.stop(ticket, ended, "retried");
  ctx.o.executor.start(ticket, assignment);
  return ticket;
}

/**
 * Drops a ticket's Subscription to a Thread its worker found unrelated, and hands back, with `reason`, the
 * person's messages there that the ticket decides.
 */
export function ticketsMarkUnrelated(
  ctx: EngineContext,
  ticketId: string,
  thread: string,
  reason: string,
): void {
  const ticket = ctx.require(ticketId);
  const src = ctx.source(ticket);
  if (src !== undefined && src.threads.some((r) => threadKey(r) === thread)) {
    throw UserError.create("sourceThread");
  }
  const current = ctx.repo().thread(thread);
  if (current === undefined || !current.subscriptions.includes(ticketId)) {
    throw UserError.create("notFollowing");
  }
  ticketsDropSubscriptions(ctx, thread, false, ticketId, reason);
  for (const trigger of triggersOf(ctx, ticket)) {
    if (
      trigger.threads.some((r) => threadKey(r) === thread) &&
      ctx.owners(trigger).includes(ticketId)
    ) {
      ctx.handBack(ticketId, trigger, reason);
    }
  }
}

/**
 * Tell each open ticket a Policy change bears on how it does, oldest first, so their deliveries queue in the order
 * they were accepted; the others are left alone.
 */
export function ticketsPolicyChanged(
  ctx: EngineContext,
  from: string,
  to: string,
  effects: ReadonlyMap<string, PolicyEffect> | Readonly<Record<string, PolicyEffect>>,
): void {
  const at = ctx.now();
  const open = ctx.repo().openTickets();
  open.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const lookup =
    effects instanceof Map
      ? (id: string) => effects.get(id)
      : (id: string) =>
          Object.prototype.hasOwnProperty.call(effects, id)
            ? (effects as Readonly<Record<string, PolicyEffect>>)[id]
            : undefined;
  for (const ticket of open) {
    // `at` is part of the id so repeated transitions between the same versions still record a new Input.
    const raw = lookup(ticket.id);
    if (raw !== undefined) {
      const effect: PolicyEffect = {};
      if (raw.rules !== undefined && raw.rules.length > 0) {
        effect.rules = structuredClone(raw.rules);
      }
      if (raw.proactive !== undefined) effect.proactive = raw.proactive;
      if (raw.requesterAllowed !== undefined) effect.requesterAllowed = raw.requesterAllowed;
      if (raw.requester !== undefined) effect.requester = structuredClone(raw.requester);
      const input: TicketInput = {
        kind: "policy-changed",
        id: key(["input", ticket.id, "policy", from, to, at]),
        from,
        to,
        at,
        effect,
      };
      ticketsAddInput(ctx, ticket, input);
    }
  }
}

/**
 * Drop a Thread's Subscriptions, every ticket's or only `ticketId`'s, and say so; false when none dropped. Each
 * ticket keeps deciding the messages it received from the Thread.
 */
export function ticketsDropSubscriptions(
  ctx: EngineContext,
  thread: string,
  byPerson: boolean,
  ticketId?: string,
  reason?: string,
): boolean {
  const current = ctx.repo().thread(thread);
  if (current === undefined) {
    return false;
  }
  const dropped = current.subscriptions.filter((id) => ticketId === undefined || ticketId === id);
  if (dropped.length === 0) {
    return false;
  }
  const droppedSet = new Set(dropped);
  current.subscriptions = current.subscriptions.filter((id) => !droppedSet.has(id));
  ctx.repo().saveThread(current);
  for (const id of dropped) {
    ctx.emit({
      type: "threadUnsubscribed",
      threadKey: current.key,
      ticketId: id,
      byPerson,
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return true;
}

/**
 * Add an Input once (idempotently) and ask the Executor to deliver it, or to launch again a pending Assignment
 * whose launch failed once no person is waited for: a Policy change alone does not launch it again.
 */
export function ticketsAddInput(ctx: EngineContext, ticket: Ticket, input: TicketInput): void {
  if (findTicketInput(ticket, input.id) !== undefined) {
    return;
  }
  const id = input.id;
  const automatic = ticketInputAutomatic(input);
  ticket.inputs.push(input);
  ticket.updatedAt = ctx.now();
  // Hold back automated inputs while the worker is waiting on a person.
  const held = isTicketLive(ticket) && automatic && waitsForPerson(ticket);
  if (!held) {
    ticket.undelivered.push(id);
  }
  ctx.repo().saveTicket(ticket);
  if (!isTicketLive(ticket) || held) {
    return;
  }
  const running = runningAssignment(ticket);
  if (running !== undefined) {
    ctx.o.executor.deliver(ticket, running);
  } else {
    const latest = latestAssignment(ticket);
    if (latest !== undefined && latest.state === "pending" && !waitsForPerson(ticket)) {
      ctx.o.executor.start(ticket, latest);
    }
  }
}

/**
 * Resume an ended ticket under its unchanged Mandate when a person's message on one of its Threads waits for it:
 * no Eval and no Decision, since nothing new is authorized. One whose Mandate the current Policy no longer holds
 * stays ended and takes nothing. While processing is paused the message waits. Idempotent.
 */
export function ticketsWake(ctx: EngineContext, ticketId: string): void {
  const ticket = ctx.repo().ticket(ticketId);
  if (ticket === undefined) {
    return;
  }
  if (isTicketLive(ticket) || isStoppedByPerson(ticket) || ticket.undelivered.length === 0) {
    return;
  }
  const policy = ctx.policy();
  if (policy.paused()) {
    return;
  }
  if (!policy.revalidate(ticket.mandate)) {
    refuse(ctx, ticket);
    return;
  }
  // Only a human's message resumes an ended ticket; bot triggers wait alongside inputs from before the ticket ended.
  let triggerId: string | undefined;
  for (const id of ticket.undelivered) {
    const inp = findTicketInput(ticket, id);
    if (inp !== undefined && inp.kind === "trigger" && inp.human === true) {
      triggerId = inp.triggerId;
      break;
    }
  }
  if (triggerId === undefined) {
    return;
  }
  const at = ctx.now();
  delete ticket.ended;
  ticket.updatedAt = at;
  const assignment = newAssignment(ctx, ticket);
  // The resumed marker is delivered ahead of the waiting messages.
  const resumed: TicketInput = {
    kind: "resumed",
    id: key(["input", ticket.id, "resumed", triggerId]),
    triggerId,
    at,
  };
  ticket.undelivered.unshift(resumed.id);
  ticket.inputs.push(resumed);
  ctx.repo().saveTicket(ticket);
  ctx.o.executor.start(ticket, assignment);
  ctx.emit({ type: "ticketResumed", ticketId, triggerId });
}

/** The Triggers of a ticket's trigger Inputs, or of those of them whose Input ids are `ids`. */
function triggersOf(ctx: EngineContext, ticket: Ticket, ids?: readonly string[]): Trigger[] {
  const idSet = ids !== undefined ? new Set(ids) : undefined;
  const out: Trigger[] = [];
  for (const input of ticket.inputs) {
    if (idSet !== undefined && !idSet.has(input.id)) continue;
    const tid = ticketInputTriggerId(input);
    if (tid === undefined) continue;
    const trigger = ctx.repo().trigger(tid);
    if (trigger !== undefined) out.push(trigger);
  }
  return out;
}

/** Whether a ticket's worker took a person's message up, by acknowledging or answering it. */
function takenUp(ctx: EngineContext, ticket: Ticket, trigger: Trigger): boolean {
  return ctx.repo().disposition(trigger.id)?.acked?.includes(ticket.id) ?? false;
}

/** The person's messages among a ticket's Inputs `ids` that it decides and its worker did not take up. */
function untaken(ctx: EngineContext, ticket: Ticket, ids: readonly string[]): Trigger[] {
  return triggersOf(ctx, ticket, ids).filter(
    (trigger) => ctx.owners(trigger).includes(ticket.id) && !takenUp(ctx, ticket, trigger),
  );
}

/**
 * A ticket that ended, or cannot resume, lets go of the messages its worker never received, `waiting`, and of the
 * person's messages it decided but may not have taken up, `left`: it no longer counts as having reached them, and
 * each of `left` that no other ticket decides goes to Eval, unless a ticket took it up, a Decision settled it, or
 * it is the message a stop ended this ticket on.
 */
function letGo(
  ctx: EngineContext,
  ticketId: string,
  waiting: readonly Trigger[],
  left: readonly Trigger[],
): void {
  for (const trigger of [...waiting, ...left]) {
    const disposition = ctx.repo().disposition(trigger.id);
    if (disposition !== undefined && disposition.fanout.includes(ticketId)) {
      disposition.fanout = disposition.fanout.filter((id) => id !== ticketId);
      ctx.repo().saveDisposition(trigger.id, disposition);
    }
  }
  for (const trigger of left) {
    const disposition = ctx.repo().disposition(trigger.id);
    const decision =
      disposition?.decisionId !== undefined ? ctx.repo().decision(disposition.decisionId) : undefined;
    const handbacks = (disposition?.handbacks?.length ?? 0) > 0;
    const acked = (disposition?.acked?.length ?? 0) > 0;
    // The main Session that stopped this ticket on the message decides the rest of it itself, unless a ticket handed it back.
    const decided =
      decision !== undefined &&
      (settled(decision) ||
        (decision.kind === "stop" && decision.ticketId === ticketId && !handbacks));
    if (ctx.owners(trigger).length === 0 && !acked && !decided) {
      ctx.queueForEval(trigger);
    }
  }
}

/** An ended ticket that cannot resume takes none of the messages that waited for it. */
function refuse(ctx: EngineContext, ticket: Ticket): void {
  const waiting = triggersOf(ctx, ticket, ticket.undelivered);
  const left = untaken(ctx, ticket, ticket.undelivered);
  ticket.undelivered = [];
  ctx.repo().saveTicket(ticket);
  letGo(ctx, ticket.id, waiting, left);
}

/** Replace a ticket's running Assignment with a new one that receives `note` first, and queue it for launch. */
export function ticketsRestart(
  ctx: EngineContext,
  ticket: Ticket,
  runningId: string,
  reason: string,
  note: string,
): void {
  endAssignment(ctx, ticket, runningId, reason);
  requeueUntaken(ticket, runningId);
  const assignment = newAssignment(ctx, ticket);
  const at = ctx.now();
  const input: TicketInput = {
    kind: "text",
    id: key(["input", ticket.id, "restart", assignment.id]),
    text: note,
    at,
  };
  ticket.undelivered.push(input.id);
  ticket.inputs.push(input);
  ticket.updatedAt = at;
  ctx.repo().saveTicket(ticket);
  ctx.o.executor.start(ticket, assignment);
}

/**
 * Put back, ahead of what waits, the Trigger Inputs delivered to `replaced` that no step of its worker took: a
 * cancel may have dropped them, or a step that claimed them was cut off.
 */
function requeueUntaken(ticket: Ticket, replaced: string): void {
  const undeliveredSet = new Set(ticket.undelivered);
  const untakenIds: string[] = [];
  for (const input of ticket.inputs) {
    if (
      input.kind === "trigger" &&
      isReadWaiting(input.readAt) &&
      input.deliveredTo === replaced &&
      !undeliveredSet.has(input.id)
    ) {
      untakenIds.push(input.id);
    }
  }
  if (untakenIds.length > 0) {
    ticket.undelivered.unshift(...untakenIds);
  }
}

/**
 * End a ticket with its outcome; `reason` says why in words, by default the outcome. The ticket lets go of the
 * messages its worker never received, and of the person's messages it decides that its worker did not read before
 * its latest report or turn end and neither acknowledged, answered nor handed back.
 */
export function ticketsEnd(
  ctx: EngineContext,
  ticketId: string,
  by: TicketEndBy,
  outcome: TicketOutcome,
  atOpt?: string,
  reason?: string,
): void {
  const ticket = ctx.require(ticketId);
  if (!isTicketLive(ticket)) {
    return;
  }
  const at = atOpt ?? ctx.now();
  const why = reason !== undefined && reason !== outcome ? reason : undefined;
  const until = readUntil(ticket, true);
  const waiting = triggersOf(ctx, ticket, ticket.undelivered);
  const undeliveredSet = new Set(ticket.undelivered);
  const unread = ticket.inputs
    .filter(
      (input) =>
        ticketInputTriggerId(input) !== undefined &&
        (!readBefore(input, until) || undeliveredSet.has(input.id)),
    )
    .map((input) => input.id);
  const left = untaken(ctx, ticket, unread);

  ticket.ended = {
    at,
    by,
    outcome,
    ...(why !== undefined ? { reason: why } : {}),
  };
  ticket.undelivered = [];
  if (outcome !== "completed") {
    delete ticket.answers;
  }
  ticket.updatedAt = ctx.now();
  delete ticket.attention;
  delete ticket.delivery;

  // The Assignments the end stops end with it; the ticket's end says why.
  const stopping: Assignment[] = [];
  for (const assignment of ticket.assignments) {
    if (assignment.state !== "ended") {
      assignment.state = "ended";
      assignment.endedAt = at;
      stopping.push(structuredClone(assignment));
    }
  }
  ctx.repo().saveTicket(ticket);
  letGo(ctx, ticketId, waiting, left);
  ctx.emit({
    type: "ticketEnded",
    ticketId,
    by,
    outcome,
    ...(why !== undefined ? { reason: why } : {}),
  });
  for (const assignment of stopping) {
    ctx.o.executor.stop(ticket, assignment, reason ?? outcome);
  }
}

/** Add a pending Assignment; a failed delivery to the one before it no longer concerns the ticket. */
function newAssignment(ctx: EngineContext, ticket: Ticket): Assignment {
  const assignment: Assignment = {
    id: key(["assignment", ticket.id, String(ticket.assignments.length)]),
    state: "pending",
    createdAt: ctx.now(),
  };
  ticket.assignments.push(structuredClone(assignment));
  delete ticket.delivery;
  return assignment;
}

function endAssignment(
  ctx: EngineContext,
  ticket: Ticket,
  assignmentId: string,
  reason: string,
): Assignment {
  const now = ctx.now();
  const assignment = ticket.assignments.find((a) => a.id === assignmentId);
  if (assignment === undefined) {
    throw new Error("assignment belongs to its ticket");
  }
  assignment.state = "ended";
  assignment.endedAt = now;
  assignment.endedReason = reason;
  const ended = structuredClone(assignment);
  ctx.emit({
    type: "assignmentEnded",
    ticketId: ticket.id,
    assignmentId,
    reason,
  });
  return ended;
}

/** Give an open ticket's Executor a fact as a note Input, such as what another ticket found; it grants nothing. */
export function ticketsNote(ctx: EngineContext, ticketId: string, text: string): Ticket {
  const ticket = ctx.require(ticketId);
  if (!isTicketLive(ticket)) {
    throw UserError.create("ticketEnded");
  }
  const at = ctx.now();
  const input: TicketInput = {
    kind: "note",
    id: key(["input", ticketId, "note", at, text]),
    text,
    at,
  };
  ticketsAddInput(ctx, ticket, input);
  return ctx.require(ticketId);
}

/** Subscribe an open ticket to a Thread its Executor found related, for context. */
export function ticketsFollowForContext(
  ctx: EngineContext,
  ticketId: string,
  reference: ThreadRef,
): boolean {
  if (!isTicketLive(ctx.require(ticketId))) {
    throw UserError.create("ticketEnded");
  }
  if (ctx.threadOf(reference).subscriptions.includes(ticketId)) {
    return false;
  }
  subscribe(ctx, ticketId, reference);
  const thread = ctx.threadOf(reference);
  const context = thread.context ?? [];
  context.push(ticketId);
  thread.context = context;
  ctx.repo().saveThread(thread);
  return true;
}

/** Subscribe a ticket to a Thread; later Triggers on it reach the ticket as Inputs, as the ticket's own once it was for context. */
function subscribe(ctx: EngineContext, ticketId: string, reference: ThreadRef): void {
  const thread = ctx.threadOf(reference);
  if (!thread.subscriptions.includes(ticketId)) {
    thread.subscriptions.push(ticketId);
    ctx.emit({ type: "threadSubscribed", threadKey: thread.key, ticketId });
  }
  if (thread.context !== undefined) {
    thread.context = thread.context.filter((id) => id !== ticketId);
    if (thread.context.length === 0) {
      delete thread.context;
    }
  }
  ctx.repo().saveThread(thread);
}
