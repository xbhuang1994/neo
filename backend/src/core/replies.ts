/**
 * The Engine's messages to Channels, each by the rule that allows it.
 */

import type { EngineContext } from "./engine.ts";
import { UserError } from "./errors.ts";
import { key } from "./ids.ts";
import {
  handedBackBy,
  hasTriggerInput,
  isTicketLive,
  latestAssignment,
  latestReport,
  type ChannelRef,
  type Ticket,
  type Trigger,
} from "./model.ts";
import type { ReplyStatus } from "./ports.ts";

/** What a reply is for. */
export type Purpose = "acknowledgement" | "answer" | "result" | "attention";

/** A message for a Channel, by purpose. When `ticketId` is omitted, the ticket that `triggerId` reached is used. */
export interface ReplyRequest {
  /** What it is for. */
  purpose: Purpose;
  /** The ticket it is for. */
  ticketId?: string;
  /** The person's message it replies to. */
  triggerId?: string;
  /** For `attention`: the ticket's current question. */
  question?: string;
  /** What it says. */
  text: string;
}

/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply {
  /** The message's id in the outbox. */
  id: string;
  /** What became of it. */
  status: ReplyStatus;
  /** An earlier request queued it already. */
  reused: boolean;
}

/**
 * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's
 * message was written, attention where the message that raised the question was (or to the ticket's starting
 * conversation), and a result to the conversation where the ticket started. Each is queued at most once.
 */
export function repliesReply(ctx: EngineContext, request: ReplyRequest): Reply {
  if (request.purpose === "acknowledgement") {
    return acknowledge(ctx, request);
  }
  return answer(ctx, request);
}

/**
 * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a
 * Channel and a person wrote it.
 */
export function repliesAcknowledgeAccepted(
  ctx: EngineContext,
  ticketId: string,
  trigger: Trigger,
  text: string,
): void {
  if (trigger.human && trigger.channel !== undefined) {
    ctx.o.outbox.send({
      id: key(["ack", trigger.id]),
      channel: structuredClone(trigger.channel),
      text,
      kind: "acknowledgement",
      ticketId,
    });
  }
}

/** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
export function repliesWithdrawAttention(ctx: EngineContext, attentionId: string): void {
  ctx.o.outbox.withdraw(key(["attention-reply", attentionId]));
}

function acknowledge(ctx: EngineContext, request: ReplyRequest): Reply {
  const ticket = ctx.require(request.ticketId ?? "");
  if (!isTicketLive(ticket)) {
    throw UserError.create("ackEnded");
  }
  const trigger = request.triggerId !== undefined ? ctx.repo().trigger(request.triggerId) : undefined;
  if (trigger === undefined) {
    throw UserError.create("unknownTrigger");
  }
  // Context-only threads are read-only and cannot receive acknowledgements.
  if (!ctx.reaches(ticket, trigger, false)) {
    throw UserError.create("notReached");
  }
  if (trigger.channel === undefined) {
    throw UserError.create("ackNoChannel");
  }
  const id = key(["ack", trigger.id]);
  const existing = ctx.o.outbox.status(id);
  if (existing === undefined && !trigger.human) {
    throw UserError.create("ackNotPerson");
  }
  // The automatic or first queued acknowledgement stays.
  if (existing === undefined) {
    ctx.o.outbox.send({
      id,
      channel: structuredClone(trigger.channel),
      text: request.text,
      kind: "acknowledgement",
      ticketId: ticket.id,
    });
  }
  ctx.takeUp(ticket.id, trigger.id);
  return {
    id,
    status: ctx.o.outbox.status(id) ?? "pending",
    reused: existing !== undefined,
  };
}

function answer(ctx: EngineContext, request: ReplyRequest): Reply {
  let trigger: Trigger | undefined;
  if (request.triggerId !== undefined) {
    trigger = ctx.repo().trigger(request.triggerId);
    if (trigger === undefined) {
      throw UserError.create("unknownTrigger");
    }
  }
  // A hand-back returns the message to the orchestrator; it no longer waits for that ticket's worker to answer it.
  const disposition = trigger !== undefined ? ctx.repo().disposition(trigger.id) : undefined;
  const returned = (ticketId: string): boolean =>
    disposition !== undefined && handedBackBy(disposition, ticketId);

  // The ticket a message went to, as its origin or an Input.
  let ticket: Ticket | undefined;
  if (request.ticketId !== undefined) {
    ticket = ctx.require(request.ticketId);
  } else if (trigger !== undefined) {
    const trigId = trigger.id;
    ticket = ctx
      .repo()
      .tickets()
      .find(
        (item) =>
          !returned(item.id) &&
          (item.origin.triggerIds.includes(trigId) || hasTriggerInput(item, trigId)),
      );
  }

  if (request.purpose === "result") {
    const ready =
      ticket !== undefined &&
      (ticket.ended !== undefined
        ? ticket.ended.outcome === "completed" || ticket.ended.outcome === "dropped"
        : latestAssignment(ticket)?.report?.state === "ready");
    if (!ready) {
      throw UserError.create("notReady");
    }
  }

  const attention = request.purpose === "attention" ? ticket?.attention : undefined;
  // Attention replies must match the ticket's currently open question text.
  if (
    request.purpose === "attention" &&
    (attention === undefined || attention.question !== request.question)
  ) {
    throw UserError.create("notAttention");
  }
  if (request.purpose === "answer" && !(trigger?.human ?? false)) {
    throw UserError.create("notQuestion");
  }

  const id =
    attention !== undefined
      ? key(["attention-reply", attention.id])
      : key(["reply", trigger?.id ?? ticket?.id ?? "", request.text]);
  const existing = ctx.o.outbox.status(id);

  // A result goes out once per report: the same words again reuse the message, and other words are refused, so
  // that a worker's direct reply is not followed by the orchestrator's paraphrase of it.
  const reported = ticket !== undefined ? latestReport(ticket)?.at : undefined;
  if (
    request.purpose === "result" &&
    existing === undefined &&
    reported !== undefined &&
    ticket?.resultSent === reported
  ) {
    throw UserError.create("resultSent");
  }

  const answered =
    ticket !== undefined && trigger !== undefined
      ? (ticket.answers?.includes(trigger.id) ?? false)
      : true;
  if (request.purpose === "answer" && !answered && existing === undefined) {
    throw UserError.create("noAnswer");
  }

  const asker =
    attention?.triggerId !== undefined ? ctx.repo().trigger(attention.triggerId) : undefined;
  const channel =
    request.purpose === "answer"
      ? trigger?.channel
      : (asker?.channel ?? (ticket !== undefined ? sourceChannel(ctx, ticket) : undefined));
  if (channel === undefined) {
    throw UserError.create("noChannel");
  }

  ctx.o.outbox.send({
    id,
    channel: structuredClone(channel),
    text: request.text,
    kind: "reply",
    ...(ticket !== undefined ? { ticketId: ticket.id } : {}),
  });

  if (request.purpose === "result" && ticket !== undefined) {
    if (ticket.resultSent !== reported || (ticket.answers?.length ?? 0) > 0) {
      if (reported !== undefined) {
        ticket.resultSent = reported;
      } else {
        delete ticket.resultSent;
      }
      delete ticket.answers;
      ctx.repo().saveTicket(ticket);
    }
  }

  if (request.purpose === "answer" && ticket !== undefined && trigger !== undefined) {
    if (ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter((item) => item !== trigger.id);
      if (ticket.answers.length === 0) {
        delete ticket.answers;
      }
      ctx.repo().saveTicket(ticket);
    }
  }

  return {
    id,
    status: ctx.o.outbox.status(id) ?? "pending",
    reused: existing !== undefined,
  };
}

/** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
function sourceChannel(ctx: EngineContext, ticket: Ticket): ChannelRef | undefined {
  return ctx.source(ticket)?.channel ?? ticket.channels[0];
}
