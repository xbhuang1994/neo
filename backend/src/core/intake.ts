/**
 * Trigger ingestion, thread correlation, subscription fan-out, and evaluation queuing.
 */

import type { EngineContext, ReceiveResult } from "./engine.ts";
import { UserError } from "./errors.ts";
import { key } from "./ids.ts";
import {
  isStoppedByPerson,
  isTicketLive,
  threadKey,
  type Ticket,
  type Trigger,
  type TriggerDisposition,
  type TriggerTicketInput,
} from "./model.ts";
import { reasonCode } from "./reasons.ts";
import { ticketsAddInput, ticketsWake } from "./tickets.ts";
import { isoTime } from "./time.ts";

export function intakeReceive(ctx: EngineContext, received: Trigger): ReceiveResult {
  const trigger: Trigger = { ...received, at: isoTime(received.at) };
  if (trigger.threads.length === 0) {
    throw UserError.invalid("A trigger must belong to at least one thread");
  }
  if (ctx.repo().trigger(trigger.id) !== undefined) {
    return "duplicate";
  }
  const at = ctx.now();
  const scopeResult = ctx.o.scope.scope(trigger.source, trigger.meta);
  if (scopeResult.kind === "ignored") {
    ctx.repo().saveTrigger(trigger);
    const disposition: TriggerDisposition = {
      filtered: reasonCode(scopeResult.reason),
      fanout: [],
      at,
    };
    ctx.repo().saveDisposition(trigger.id, disposition);
    return "filtered";
  }
  const fan = scopeResult.fanout;

  ctx.repo().saveTrigger(trigger);
  const keys = trigger.threads.map(threadKey);

  // The tickets reached, and whether only on Threads they follow for context (a ticket's own Thread makes it false).
  const reachedList: Array<{ ticket: Ticket; followed: boolean }> = [];
  const reachedIndex = new Map<string, number>();

  for (const reference of trigger.threads) {
    const thread = ctx.threadOf(reference);
    if (thread.lastAt === undefined || trigger.at > thread.lastAt) {
      thread.lastAt = trigger.at;
    }
    for (const other of keys) {
      if (other !== thread.key && !thread.correlated.includes(other)) {
        thread.correlated.push(other);
      }
    }
    if (fan) {
      for (const ticketId of thread.subscriptions) {
        const ticket = ctx.repo().ticket(ticketId);
        if (ticket === undefined) continue;
        // Only a person's message on a non-context thread resumes an ended ticket; bots do not, and a
        // human-stopped ticket receives nothing because its Mandate was withdrawn.
        const followed = thread.context?.includes(ticketId) ?? false;
        const resumes = trigger.human && !isStoppedByPerson(ticket) && !followed;
        if (!isTicketLive(ticket) && !resumes) continue;
        const idx = reachedIndex.get(ticketId);
        if (idx !== undefined) {
          reachedList[idx] = { ticket, followed: followed && reachedList[idx].followed };
        } else {
          reachedIndex.set(ticketId, reachedList.length);
          reachedList.push({ ticket, followed });
        }
      }
    }
    ctx.repo().saveThread(thread);
  }

  for (const entry of reachedList) {
    const input: TriggerTicketInput = {
      kind: "trigger",
      id: key(["input", entry.ticket.id, "trigger", trigger.id]),
      triggerId: trigger.id,
      at,
      ...(trigger.human ? { human: true } : {}),
      ...(entry.followed ? { context: true } : {}),
    };
    ticketsAddInput(ctx, entry.ticket, input);
  }

  const fanout = reachedList.map((entry) => entry.ticket.id);
  const context = reachedList.filter((entry) => entry.followed).map((entry) => entry.ticket.id);
  const disposition: TriggerDisposition = {
    fanout,
    ...(context.length > 0 ? { context } : {}),
    at,
  };
  ctx.repo().saveDisposition(trigger.id, disposition);

  // A person's message that no ticket decides, such as one that reached only tickets a person stopped or that
  // follow the Thread for context, and every bot's, goes to Eval.
  if (ctx.owners(trigger).length === 0) {
    ctx.queueForEval(trigger);
  }
  for (const ticketId of fanout) {
    ticketsWake(ctx, ticketId);
  }
  ctx.emit({ type: "triggerReceived", triggerId: trigger.id, threads: keys });
  return "stored";
}
