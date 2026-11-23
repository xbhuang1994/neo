//! Compact, bounded projections of triggers, tickets and decisions for the models; full texts stay behind readable
//! resources.

import {
  key,
  latestReport,
  reasonCode,
  reasonText,
  threadKey,
  ticketStage,
  type Assignment,
  type Decision,
  type PolicyEffect,
  type Ticket,
  type TicketInput,
  type Trigger,
  type TriggerDisposition,
} from "../core/index.ts";
import { isRecord } from "../kernel/types.ts";
import { clip } from "./text.ts";

const WHITESPACE_RUN = /\p{White_Space}+/gu;
const EDGE_WHITESPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Counts Unicode scalar values (code points), matching Rust's `str::chars().count()`. */
export function charCount(text: string): number {
  let count = 0;
  const len = text.length;
  for (let i = 0; i < len; ) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 2;
        count += 1;
        continue;
      }
    }
    i += 1;
    count += 1;
  }
  return count;
}

function previewChars(text: string, limit: number): string {
  if (text.length === 0 || limit <= 0) {
    return "";
  }
  const collapsed = text.replace(EDGE_WHITESPACE, "").replace(WHITESPACE_RUN, " ");
  return clip(collapsed, limit);
}

/** Collapses whitespace and cuts text for a preview. */
export function preview(text: string): string {
  return previewChars(text, 160);
}

/** The state a ticket card shows: an open ticket's stage, or an ended ticket's outcome. */
export function cardState(ticket: Ticket): string {
  if (ticket.ended !== undefined) {
    return ticket.ended.outcome;
  }
  const stage = ticketStage(ticket);
  switch (stage.kind) {
    case "person":
      return `person/${stage.action}`;
    case "idle":
      return "idle";
    case "working":
      return stage.queued ? "working/queued" : "working";
    case "ended":
      return "ended";
  }
}

/** The worker's topic, else its latest report that was not a drop, which only says it handed a message back. */
function subjectOf(ticket: Ticket): string | undefined {
  if (ticket.digest !== undefined) {
    return ticket.digest;
  }
  for (let i = ticket.assignments.length - 1; i >= 0; i--) {
    const report = ticket.assignments[i].report;
    if (report !== undefined && report.state !== "dropped") {
      return report.summary;
    }
  }
  return undefined;
}

/** A trigger with where it went. */
export function triggerCard(
  trigger: Trigger,
  disposition?: TriggerDisposition | null,
): Record<string, unknown> {
  const card: Record<string, unknown> = {
    trigger_id: trigger.id,
    source: trigger.source,
    actor: trigger.actor.id,
    thread: threadKey(trigger.threads[0]),
    human: trigger.human,
    at: trigger.at,
    preview: preview(trigger.text),
    chars: charCount(trigger.text),
    read: `trigger/${trigger.id}`,
  };
  if (disposition !== undefined && disposition !== null) {
    const went: Record<string, unknown> = { delivered_to: [...disposition.fanout] };
    if (disposition.filtered !== undefined) {
      went.filtered = reasonText([disposition.filtered]);
    }
    if (disposition.decisionId !== undefined) {
      went.decision_id = disposition.decisionId;
    }
    card.disposition = went;
  }
  return card;
}

/** A ticket in a line: what it is, where it stands, and how to read more. */
export function ticketCard(ticket: Ticket): Record<string, unknown> {
  let digest: string;
  if (ticket.digest !== undefined) {
    digest = ticket.digest;
  } else {
    const subject = subjectOf(ticket);
    digest = subject !== undefined ? preview(`${ticket.title}: ${subject}`) : preview(ticket.title);
  }
  const card: Record<string, unknown> = {
    ticket_id: ticket.id,
    title: ticket.title,
    digest,
    state: cardState(ticket),
    strength: ticket.mandate.strength,
  };
  if (ticket.ended !== undefined) {
    card.ended = {
      at: ticket.ended.at,
      by: ticket.ended.by,
      reason: ticket.ended.reason ?? ticket.ended.outcome,
    };
  }
  if (ticket.attention !== undefined) {
    const asked: Record<string, unknown> = { question: ticket.attention.question };
    if (ticket.attention.triggerId !== undefined) {
      asked.trigger_id = ticket.attention.triggerId;
    }
    card.attention = asked;
  }
  card.preview = preview(latestReport(ticket)?.summary ?? "");
  card.read = `ticket/${ticket.id}`;
  return card;
}

/** A ticket card without its report preview, for a relay that already carries the report. */
export function briefCard(ticket: Ticket): Record<string, unknown> {
  const card = ticketCard(ticket);
  delete card.preview;
  return card;
}

/**
 * A chat candidate's compact ticket card: what routing a message needs. `asked` is the start of the request it was
 * accepted from, which holds the names a title leaves out.
 */
export function routingCard(ticket: Ticket, asked?: string | null): Record<string, unknown> {
  const card: Record<string, unknown> = {
    ticket_id: ticket.id,
    title: ticket.title,
  };
  if (asked !== undefined && asked !== null) {
    card.asked = clip(preview(asked), 100);
  }
  const subject = subjectOf(ticket);
  if (subject !== undefined) {
    card.digest = preview(subject);
  }
  card.state = cardState(ticket);
  card.updated = clip(ticket.updatedAt, 16);
  if (ticket.attention !== undefined) {
    card.attention = { question: ticket.attention.question };
  }
  return card;
}

/** The tickets a candidate may belong to: open ones first, then newest first, with how many there are in all. */
export function relatedTickets<R = Record<string, unknown>>(
  tickets: readonly Ticket[],
  limit: number,
  card: (ticket: Ticket) => R,
): { related_tickets: R[]; tickets_total: number } {
  const order = [...tickets];
  order.sort((a, b) => {
    const aEnded = a.ended !== undefined ? 1 : 0;
    const bEnded = b.ended !== undefined ? 1 : 0;
    if (aEnded !== bEnded) {
      return aEnded - bEnded;
    }
    if (b.createdAt < a.createdAt) return -1;
    if (b.createdAt > a.createdAt) return 1;
    return 0;
  });
  const take = limit > 0 ? Math.min(limit, order.length) : 0;
  const related: R[] = [];
  for (let i = 0; i < take; i++) {
    related.push(card(order[i]));
  }
  return { related_tickets: related, tickets_total: tickets.length };
}

/** A decision in a line. */
export function decisionCard(decision: Decision): Record<string, unknown> {
  const card: Record<string, unknown> = {
    decision_id: decision.id,
    kind: decision.kind,
    reason: reasonText(decision.reason),
    strength: decision.strength,
    thread: decision.threadKey,
    trigger_ids: [...decision.triggerIds],
    at: decision.at,
    read: `decision/${decision.id}`,
  };
  if (decision.ticketId !== undefined) {
    card.ticket_id = decision.ticketId;
  }
  return card;
}

/** A decision with its Mandate and audit. */
export function decisionDetails(decision: Decision): Record<string, unknown> {
  const card = decisionCard(decision);
  if (decision.mandate !== undefined) {
    const mandate = structuredClone(decision.mandate) as unknown as Record<string, unknown>;
    delete mandate.policyVersion;
    card.mandate = mandate;
  }
  if (decision.audit !== undefined) {
    card.audit = structuredClone(decision.audit);
  }
  return card;
}

/** One page of a text, by characters, so concatenated pages give the text back. */
export function textPage(
  resource: string,
  text: string,
  offset: number,
  limit: number,
): {
  resource: string;
  offset: number;
  total_chars: number;
  next_offset: number | null;
  text: string;
} {
  const safeOffset = offset < 0 ? 0 : offset;
  const safeLimit = limit < 0 ? 0 : limit;
  const targetEnd = safeOffset + safeLimit;
  let total = 0;
  let startIdx = -1;
  let endIdx = -1;
  const len = text.length;
  for (let i = 0; i < len; ) {
    if (total === safeOffset) {
      startIdx = i;
    }
    if (total === targetEnd) {
      endIdx = i;
    }
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 2;
        total += 1;
        continue;
      }
    }
    i += 1;
    total += 1;
  }
  if (startIdx === -1) {
    startIdx = len;
  }
  if (endIdx === -1) {
    endIdx = len;
  }
  const page = startIdx < endIdx ? text.slice(startIdx, endIdx) : "";
  const end = Math.min(total, targetEnd);
  return {
    resource,
    offset,
    total_chars: total,
    next_offset: end < total ? end : null,
    text: page,
  };
}

/** The longest assignment or input text a message carries whole. */
export const ASSIGNMENT_CHARS = 1500;
const TRIGGER_CHARS = 600;
/** The longest trigger text a worker message carries whole. */
export const WORKER_TRIGGER_CHARS = 4000;

/** `text` whole, or its start with its length and where to read the rest. */
export function capped(text: string, limit: number, read: string): Record<string, unknown> {
  const chars = charCount(text);
  if (chars <= limit) {
    return { text };
  }
  return {
    text: `${clip(text, limit)}…`,
    chars,
    read,
  };
}

function triggerCardWithLimit(
  trigger: Trigger,
  note: string | null | undefined,
  limit: number,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    trigger_id: trigger.id,
    from: trigger.actor.id,
    thread: threadKey(trigger.threads[0]),
    at: trigger.at,
    ...capped(trigger.text, limit, `trigger/${trigger.id}`),
  };
  if (note !== undefined && note !== null) {
    message.routing_note = note;
  }
  return message;
}

/** A trigger as the main Session reads it. */
export function triggerMessage(
  trigger: Trigger,
  note?: string | null,
): Record<string, unknown> {
  return triggerCardWithLimit(trigger, note, TRIGGER_CHARS);
}

/**
 * A trigger as a worker Session reads it, carrying up to {@link WORKER_TRIGGER_CHARS} inline and whether it was
 * already acknowledged.
 */
export function workerTriggerMessage(
  trigger: Trigger,
  note?: string | null,
  acknowledged = false,
): Record<string, unknown> {
  const message = triggerCardWithLimit(trigger, note, WORKER_TRIGGER_CHARS);
  if (acknowledged) {
    message.acknowledged = true;
  }
  return message;
}

/** A batch peer of a ticket's origin trigger, in a line. */
export function batchLine(trigger: Trigger): Record<string, unknown> {
  return {
    trigger_id: trigger.id,
    from: trigger.actor.id,
    at: trigger.at,
    preview: previewChars(trigger.text, 500),
    read: `trigger/${trigger.id}`,
  };
}

/** The resource a long Input is read from. */
export function inputResource(ticketId: string, inputId: string): string {
  return `ticket/${ticketId}/input/${key([inputId])}`;
}

const RESUMED =
  "This ticket ended earlier and the message that follows resumed it under the same mandate. First judge from the message and this ticket's topic alone whether it belongs here; if it does not, hand it back with orchestrator_trigger_handback at once, without inspecting the directory. If it asks for more within the original scope, inspect the directory and its history and continue; if it asks for work beyond that scope or for another ticket, hand it back with orchestrator_trigger_handback and report dropped, with a summary that only says it was handed back and no topic, never the subject of that message. No new work does not mean no reply: for thanks, acknowledgements, or other human follow-ups needing no work, report dropped with reply_to_trigger_id set to that message and direct_reply set to a short natural response (at most 100 words in their language; Chinese counts by character) so it goes out directly. Report ready when follow-up work is done. Do not repeat completed work.";

/** What a retried Assignment is told. */
export const RETRIED =
  "A person retried this ticket. Continue the assignment from the current state of the directory and its history.";

function policyMessage(effect: PolicyEffect): string {
  const lines: string[] = ["Policy change:"];
  for (const rule of effect.rules ?? []) {
    if (rule.change === "disabled") {
      lines.push(
        `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`,
      );
    } else {
      lines.push(
        `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction ?? ""}`,
      );
    }
  }
  if (effect.proactive === false) {
    lines.push(
      "Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only what is in progress within the assignment, or report dropped, and take on nothing new.",
    );
  }
  if (effect.requesterAllowed === false) {
    const who =
      effect.requester !== undefined
        ? `${effect.requester.id} on ${effect.requester.source}`
        : "who asked for it";
    lines.push(
      `The sender this ticket is for, ${who}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`,
    );
  }
  if (lines.length === 1) {
    return "Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.";
  }
  return lines.join("\n");
}

/** The message an Input reaches its worker as; `trigger` is the card of a trigger Input's Trigger. */
export function inputMessage(input: TicketInput, trigger?: unknown): string {
  switch (input.kind) {
    case "trigger": {
      const card: Record<string, unknown> =
        trigger === undefined || trigger === null
          ? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` }
          : isRecord(trigger)
            ? { ...trigger }
            : {};
      if (input.context) {
        card.context = true;
      }
      return JSON.stringify(card);
    }
    case "policy-changed":
      return policyMessage(input.effect);
    case "resumed":
      return RESUMED;
    case "note":
      return `Note from the orchestrator, for context only: ${input.text}`;
    case "text":
      return input.text;
  }
}

const INFERRED_MANDATE_INSTRUCTIONS =
  "This ticket has limited proactive authorization. Independently verify that it is a small change internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product decisions or clarification, stop and report dropped; do not expand scope.";

/** What an inferred ticket's worker is told about its narrower authority. */
export function mandateInstructions(ticket: Ticket): string | undefined {
  return ticket.mandate.strength === "inferred" ? INFERRED_MANDATE_INSTRUCTIONS : undefined;
}

/** An Input in a line: short text inline, anything else by reference. */
export function inputLine(ticket: Ticket, input: TicketInput): Record<string, unknown> {
  const line: Record<string, unknown> = {
    kind: input.kind,
    at: input.at,
  };
  switch (input.kind) {
    case "trigger":
    case "resumed":
      line.trigger_id = input.triggerId;
      break;
    case "text": {
      const chars = charCount(input.text);
      if (chars <= 80) {
        line.text = input.text;
      } else {
        line.preview = clip(preview(input.text), 80);
        line.chars = chars;
        line.read = inputResource(ticket.id, input.id);
      }
      break;
    }
    case "policy-changed":
    case "note":
      line.read = inputResource(ticket.id, input.id);
      break;
  }
  if (ticket.undelivered.includes(input.id)) {
    line.undelivered = true;
  }
  return line;
}

/** An Assignment in a line, with its report by reference. */
export function assignmentLine(ticket: Ticket, item: Assignment): Record<string, unknown> {
  const line: Record<string, unknown> = {
    id: item.id,
    state: item.state,
    at: item.createdAt,
  };
  if (item.endedReason !== undefined) {
    line.ended_reason = reasonText([reasonCode(item.endedReason)]);
  }
  if (item.report !== undefined) {
    line.report = {
      state: item.report.state,
      at: item.report.at,
      preview: clip(preview(item.report.summary), 100),
      chars: charCount(item.report.summary),
      read: `ticket/${ticket.id}/report/${item.id}`,
    };
  }
  return line;
}

/** One page of `items`, newest first, with where the next page is. */
export function newestPage<T, R = Record<string, unknown>>(
  items: readonly T[],
  offset: number,
  size: number,
  line: (item: T) => R,
): [R[], number | undefined] {
  const safeOffset = offset < 0 ? 0 : offset;
  const safeSize = size < 0 ? 0 : size;
  const page: R[] = [];
  const start = items.length - 1 - safeOffset;
  const end = Math.max(-1, start - safeSize);
  for (let i = start; i > end; i--) {
    page.push(line(items[i]));
  }
  const next = safeOffset + safeSize < items.length ? safeOffset + safeSize : undefined;
  return [page, next];
}

/** A ticket with its origin, threads and the first pages of its assignments and inputs. */
export function ticketDetails(
  ticket: Ticket,
  threads: readonly unknown[],
  batch: readonly Trigger[],
  worker: boolean,
): Record<string, unknown> {
  const card = briefCard(ticket);
  card.trigger_id = ticket.origin.triggerId;
  if (batch.length > 0) {
    card.batch = batch.map(batchLine);
  }
  if (!worker) {
    card.decision_id = ticket.decisionId;
  }
  const page = (
    items: Record<string, unknown>[],
    next: number | undefined,
    resource: string,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = { items };
    if (next !== undefined) {
      out.next_resource = resource;
      out.next_offset = next;
    }
    return out;
  };
  const [assignments, moreAssignments] = newestPage(ticket.assignments, 0, 3, (item) =>
    assignmentLine(ticket, item),
  );
  const [inputs, moreInputs] = newestPage(ticket.inputs, 0, 10, (input) =>
    inputLine(ticket, input),
  );
  card.threads = [...threads];
  card.directory = ticket.execution?.directory ?? null;
  card.scope = ticket.mandate.scope;
  card.requested_by = ticket.mandate.actor.id;
  card.assignments = page(assignments, moreAssignments, `ticket/${ticket.id}/assignments`);
  card.inputs = page(inputs, moreInputs, `ticket/${ticket.id}/inputs`);
  card.assignment = `ticket/${ticket.id}/assignment`;
  card.result = `ticket/${ticket.id}/result`;
  card.transcript = `ticket/${ticket.id}/transcript`;
  return card;
}
