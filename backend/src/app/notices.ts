//! What the main Session hears outside its own turns: notices injected without waking it, and relays that steer it.

import {
  followupOwners,
  isTicketLive,
  key,
  type DomainEvent,
  type FollowupRecords,
  type ReportState,
  type Ticket,
  type Trigger,
  type WorkerReport,
} from "../core/index.ts";
import { isRecord, uuid } from "../kernel/types.ts";
import { briefCard, cardState, charCount, triggerMessage } from "./cards.ts";
import { clip } from "./text.ts";

/**
 * A background notice for the main Session: `name` is its coalescing key in the effect queue, so a newer notice of
 * the same name replaces an unsent one.
 */
export interface Notice {
  /** The coalescing key. */
  name: string;
  /** What the model reads. */
  value: unknown;
}

/** A steering message for the main Session: `id` is the request id that makes its delivery idempotent. */
export interface Relay {
  /** The request id. */
  id: string;
  /** The message. */
  text: string;
}

/** A one-off notice: its unique name keeps repeated occurrences from coalescing. */
export function receiptNotice(value: unknown): Notice {
  return { name: key(["receipt", uuid()]), value };
}

/** The settings were saved: which block, and the paths that changed. */
export function settingsNotice(block: string, changed: readonly string[]): Notice {
  return {
    name: `settings:${block}`,
    value: { settings_saved: block, changed: [...changed] },
  };
}

/** Up to 20 dot-separated paths where two values differ, such as `eval.mode` or `policy.rules.1.enabled`. */
export function changedPaths(before: unknown, after: unknown): string[] {
  const out: string[] = [];

  const walk = (aVal: unknown, bVal: unknown, path: string): void => {
    if (out.length >= 20) {
      return;
    }
    const a = aVal === undefined ? null : aVal;
    const b = bVal === undefined ? null : bVal;
    if (a === b) {
      return;
    }
    const child = (name: string): string => (path.length === 0 ? name : `${path}.${name}`);
    if (isRecord(a) && isRecord(b)) {
      const nameSet = new Set<string>();
      for (const k of Object.keys(a)) {
        nameSet.add(k);
      }
      for (const k of Object.keys(b)) {
        nameSet.add(k);
      }
      const names = Array.from(nameSet).sort();
      for (const name of names) {
        if (out.length >= 20) {
          break;
        }
        walk(a[name], b[name], child(name));
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const len = Math.max(a.length, b.length);
      for (let index = 0; index < len; index++) {
        if (out.length >= 20) {
          break;
        }
        walk(index < a.length ? a[index] : null, index < b.length ? b[index] : null, child(String(index)));
      }
      return;
    }
    out.push(path);
  };

  walk(before, after, "");
  if (out.length > 20) {
    out.length = 20;
  }
  return out;
}

/** The notice an unsolicited domain event makes for the main Session, if any. */
export function eventNotice(
  event: DomainEvent,
  at: string,
  ticket: (id: string) => Ticket | undefined | null,
): Notice | undefined {
  switch (event.type) {
    case "ticketEnded": {
      const ended = ticket(event.ticketId);
      if (ended !== undefined && ended !== null) {
        return receiptNotice({ ticket_ended: briefCard(ended) });
      }
      return receiptNotice({
        ticket_ended: event.ticketId,
        by: event.by,
        outcome: event.outcome,
        reason: event.reason ?? event.outcome,
        at,
      });
    }
    case "triggerRequeued":
      return receiptNotice({
        trigger_requeued: event.triggerId,
        read: `trigger/${event.triggerId}`,
        at,
      });
    case "threadUnsubscribed":
      if (event.byPerson) {
        return {
          name: `subscription:${event.threadKey}`,
          value: {
            subscription_changes: [{ thread: event.threadKey, removed: true }],
            at,
          },
        };
      }
      return receiptNotice({
        thread_unrelated: {
          ticket_id: event.ticketId,
          thread: event.threadKey,
          reason: event.reason ?? null,
        },
        at,
        note: "Its Executor found this thread unrelated after reading it; attach later triggers there to this ticket only when they point at it explicitly.",
      });
    default:
      return undefined;
  }
}

/** A ticket's worker follows a related thread for context only. */
export function threadFollowedNotice(ticketId: string, thread: string, reason: string): Notice {
  return receiptNotice({
    thread_followed: { ticket_id: ticketId, thread, reason },
    note: "For context only: its messages reach this ticket and grant nothing.",
  });
}

const FOLLOWUP_NOTE =
  "Its ticket's worker has it and decides; act only if the person asks to stop the work (orchestrator_route kind stop with this trigger_id).";

/** The relay for a person's follow-up that reached at least one live ticket whose worker decides it; `undefined` otherwise. */
export function followupRelay(records: FollowupRecords, trigger: Trigger): Relay | undefined {
  if (followupOwners(trigger, records).length === 0) {
    return undefined;
  }
  const disposition = records.disposition(trigger.id);
  if (disposition === undefined) {
    return undefined;
  }
  const contextSet =
    disposition.context !== undefined && disposition.context.length > 0
      ? new Set(disposition.context)
      : undefined;
  const tickets: Record<string, unknown>[] = [];
  for (const id of disposition.fanout) {
    const ticket = records.ticket(id);
    if (ticket === undefined || !isTicketLive(ticket)) {
      continue;
    }
    const line: Record<string, unknown> = {
      ticket_id: ticket.id,
      title: ticket.title,
      state: cardState(ticket),
    };
    if (contextSet?.has(ticket.id)) {
      line.context = true;
    }
    tickets.push(line);
  }
  if (tickets.length === 0) {
    return undefined;
  }
  const message = triggerMessage(trigger, undefined);
  message.kind = "follow_up";
  message.delivered_to = tickets;
  message.note = FOLLOWUP_NOTE;
  return { id: `followup:${trigger.id}`, text: JSON.stringify(message) };
}

/** A worker's report as the main Session hears it; a long summary is cut and stays readable as the ticket's result. */
export function resultRelay(
  ticket: Ticket,
  state: string,
  text: string,
  replyTo?: string | null,
): Relay {
  const id = key(["worker-result", ticket.id, ticket.updatedAt, text]);
  const report: Record<string, unknown> = {
    kind: "worker_report",
    ticket: briefCard(ticket),
    trigger_id: ticket.origin.triggerId,
    state,
  };
  if (ticket.execution !== undefined) {
    report.directory = ticket.execution.directory;
  }
  if (replyTo !== undefined && replyTo !== null) {
    report.answer_to = replyTo;
  }
  report.summary = clip(text, 2000);
  const chars = charCount(text);
  if (chars > 2000) {
    report.chars = chars;
  }
  report.read = `ticket/${ticket.id}/result`;
  return { id: `report:${id}`, text: JSON.stringify(report) };
}

/** Wire name of a `ReportState`. */
export function stateName(state: ReportState): ReportState {
  switch (state) {
    case "progress":
      return "progress";
    case "waiting":
      return "waiting";
    case "ready":
      return "ready";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "dropped":
      return "dropped";
  }
}

/**
 * The relay a recorded worker report makes: a question for a person is an attention relay, and a result, blocker,
 * end, or answer is a report relay, while routine progress stays internal.
 */
export function reportRelay(ticket: Ticket, report: WorkerReport): Relay | undefined {
  if (report.question?.kind === "ask" && ticket.attention !== undefined) {
    const text: Record<string, unknown> = {
      kind: "worker_attention",
      ticket: briefCard(ticket),
      state: stateName(report.state),
      read: `ticket/${ticket.id}/result`,
    };
    if (report.summary.length > 0) {
      text.summary = clip(report.summary, 600);
    }
    return { id: `attention:${ticket.id}:${ticket.attention.id}`, text: JSON.stringify(text) };
  }
  if (report.state === "progress" && report.answers === undefined) {
    return undefined;
  }
  return resultRelay(ticket, stateName(report.state), report.summary, report.answers);
}
