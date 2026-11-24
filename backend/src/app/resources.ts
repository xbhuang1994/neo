//! The paginated resources `orchestrator_read` serves: tickets, triggers, threads and decisions, and for a worker only
//! what belongs to its own ticket.

import {
  key,
  latestReport,
  reached,
  threadKey,
  ticketInputTriggerId,
  type Thread,
  type Ticket,
  type Trigger,
} from "../core/index.ts";
import type { Entry } from "../kernel/index.ts";
import {
  assignmentLine,
  charCount,
  decisionCard,
  decisionDetails,
  inputLine,
  inputMessage,
  newestPage,
  preview,
  textPage,
  ticketCard,
  ticketDetails,
  ticketListCard,
  triggerCard,
  triggerMessage,
} from "./cards.ts";
import type { AppContext } from "./context.ts";
import { clip } from "./text.ts";

const RESOURCES: ReadonlyArray<readonly [name: string, holds: string, forWorker: boolean]> = [
  ["tickets", "ticket cards, newest first", false],
  ["triggers", "trigger cards with where each went, newest first", false],
  ["threads", "subscribed threads, newest activity first", false],
  ["thread/<key>", "one thread and its triggers", true],
  ["decisions", "decisions, newest first", false],
  ["decision/<id>", "one decision with its audit", false],
  ["ticket/<id>", "a ticket, its origin, threads, assignments and inputs", true],
  ["ticket/<id>/assignment", "its assignment text", true],
  ["ticket/<id>/assignments", "its assignments, newest first", true],
  ["ticket/<id>/inputs", "its inputs, newest first", true],
  ["ticket/<id>/result", "its latest report", true],
  ["ticket/<id>/report/<id>", "the report of one assignment", true],
  ["ticket/<id>/transcript", "its worker's messages, newest first", true],
  ["ticket/<id>/message/<n>", "one worker message", true],
  ["ticket/<id>/input/<id>", "one delivered input", true],
  ["trigger/<id>", "a trigger and its nearby thread messages", true],
];

const UNSIGNED_INT = /^\d+$/;

/** The resources a Session may read, as its tool description lists them. */
export function grammar(worker: boolean): string {
  const parts: string[] = [];
  for (let i = 0; i < RESOURCES.length; i++) {
    const [name, holds, forWorker] = RESOURCES[i];
    if (!worker || forWorker) {
      parts.push(`${name}: ${holds}`);
    }
  }
  return parts.join("; ");
}

function triggerLine(trigger: Trigger): Record<string, unknown> {
  return {
    trigger_id: trigger.id,
    actor: trigger.actor.id,
    human: trigger.human,
    at: trigger.at,
    preview: preview(trigger.text),
    chars: charCount(trigger.text),
    read: `trigger/${trigger.id}`,
  };
}

/** What a transcript entry says, in one line of text. */
function entryText(entry: Entry): [string, string] {
  const kind = entry.type === "message" ? entry.message.role : "custom";
  const content = entry.type === "message" ? entry.message.content : entry.content;
  const parts = new Array<string>(content.length);
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    switch (block.type) {
      case "text":
        parts[i] = block.text;
        break;
      case "image":
        parts[i] = "[image]";
        break;
      case "toolCall":
        parts[i] = `[toolCall ${block.name}]`;
        break;
    }
  }
  return [kind, parts.join(" ")];
}

/** A page of a list: `size` items, and where the next page starts when one more exists. */
function listPage(
  items: unknown[],
  offset: number,
  size: number,
  total?: number,
): { items: unknown[]; total?: number; next_offset: number | null } {
  const more = items.length > size;
  return {
    items: more ? items.slice(0, size) : items,
    ...(total !== undefined ? { total } : {}),
    next_offset: more ? offset + size : null,
  };
}

function threadTitle(app: AppContext, thread: Thread): string {
  if (typeof thread.meta.label === "string") {
    return thread.meta.label;
  }
  const first = app.store.firstTrigger(thread.key, true);
  if (first !== undefined) {
    return preview(first.text);
  }
  return thread.key;
}

function threadCard(app: AppContext, thread: Thread): Record<string, unknown> {
  const card: Record<string, unknown> = {
    thread: thread.key,
    label: threadTitle(app, thread),
    source: thread.ref.source,
    tickets: [...thread.subscriptions],
    pending: thread.pending.length,
    read: `thread/${thread.key}`,
  };
  if (thread.evaluating !== undefined) {
    card.evaluating = {
      since: thread.evaluating.startedAt,
      deadline: thread.evaluating.deadline,
    };
  }
  return card;
}

/** Whether a worker may read a trigger: it reached the ticket, or the ticket was accepted from it. */
function readable(app: AppContext, ticket: Ticket, trigger: Trigger): boolean {
  return (
    reached(ticket, trigger, (k) => app.store.thread(k), true) ||
    ticket.origin.triggerIds.includes(trigger.id)
  );
}

/** Read one page of a resource; with `ticketId`, as that ticket's worker. */
export function readResource(
  app: AppContext,
  resource: string,
  offset: number,
  limit?: number,
  ticketId?: string,
): unknown {
  const mainOnly = (): void => {
    if (ticketId !== undefined) {
      throw new Error("This resource belongs to the main Session");
    }
  };
  const safeOffset = offset < 0 ? 0 : offset;
  const size = Math.max(0, Math.min(limit ?? 20, 50));
  const textLimit = Math.max(0, Math.min(limit ?? 4000, 8000));
  const text = (body: string) => textPage(resource, body, safeOffset, textLimit);
  const unknown = (): Error => new Error("Unknown context resource");
  const workerTicket = ticketId !== undefined ? app.storeTicket(ticketId) : null;

  switch (resource) {
    case "tickets": {
      mainOnly();
      const total = app.store.ticketCount();
      const pageTickets = app.store.ticketPage(safeOffset, size + 1);
      const originIds = pageTickets.map((ticket) => ticket.origin.triggerId);
      const triggers = app.store.triggersByIds(originIds);
      const items = pageTickets.map((ticket) => {
        const origin = triggers.get(ticket.origin.triggerId);
        const asked =
          typeof origin?.meta.originalText === "string" ? origin.meta.originalText : origin?.text;
        return ticketListCard(ticket, asked);
      });
      return listPage(items, safeOffset, size, total);
    }
    case "triggers": {
      mainOnly();
      const items = app.store
        .recentTriggers(safeOffset, size + 1)
        .map((trigger) => triggerCard(trigger, app.store.disposition(trigger.id)));
      return listPage(items, safeOffset, size);
    }
    case "threads": {
      mainOnly();
      const threads = app.store.subscribedThreads(undefined);
      threads.sort((a, b) => {
        const aAt = a.lastAt ?? a.createdAt;
        const bAt = b.lastAt ?? b.createdAt;
        if (bAt < aAt) return -1;
        if (bAt > aAt) return 1;
        return 0;
      });
      const items = threads
        .slice(safeOffset, safeOffset + size + 1)
        .map((thread) => threadCard(app, thread));
      return listPage(items, safeOffset, size);
    }
    case "decisions": {
      mainOnly();
      const items = app.store.recentDecisions(safeOffset, size + 1).map(decisionCard);
      return listPage(items, safeOffset, size);
    }
    default:
      break;
  }

  if (resource.startsWith("decision/")) {
    mainOnly();
    const id = resource.slice("decision/".length);
    const decision = app.store.decision(id);
    if (decision === undefined) {
      throw new Error("Unknown decision");
    }
    return decisionDetails(decision);
  }

  if (resource.startsWith("thread/")) {
    const threadId = resource.slice("thread/".length);
    const found = app.store.thread(threadId);
    if (found === undefined || (ticketId !== undefined && !found.subscriptions.includes(ticketId))) {
      throw new Error("Unknown or inaccessible thread");
    }
    const card = threadCard(app, found);
    delete card.read;
    delete card.tickets;
    if (ticketId === undefined) {
      const ticketCards: Record<string, unknown>[] = [];
      for (let i = 0; i < found.subscriptions.length; i++) {
        const ticket = app.storeTicket(found.subscriptions[i]);
        if (ticket !== null) {
          ticketCards.push(ticketCard(ticket));
        }
      }
      card.tickets = ticketCards;
      const decisions = app.store.decisionsByThread(found.key);
      const recentDecisions: Record<string, unknown>[] = [];
      for (let i = decisions.length - 1; i >= 0 && recentDecisions.length < 5; i--) {
        recentDecisions.push(decisionCard(decisions[i]));
      }
      card.decisions = recentDecisions;
    }
    const page = listPage(
      app.store.threadPage(found.key, safeOffset, size + 1).map(triggerLine),
      safeOffset,
      size,
    );
    Object.assign(card, page);
    return card;
  }

  if (resource.startsWith("trigger/")) {
    const id = resource.slice("trigger/".length);
    if (id.length === 0 || id.includes("/")) {
      throw unknown();
    }
    const found = app.store.trigger(id);
    if (found === undefined) {
      throw new Error("Unknown trigger");
    }
    if (ticketId !== undefined && (workerTicket === null || !readable(app, workerTicket, found))) {
      throw new Error("Trigger does not belong to this worker");
    }
    const shown = (item: Trigger | undefined): Trigger | undefined =>
      item !== undefined && (workerTicket === null || readable(app, workerTicket, item))
        ? item
        : undefined;
    // A worker sees only that the message reached its own ticket.
    const rawDisposition = app.store.disposition(found.id);
    const disposition =
      rawDisposition !== undefined && workerTicket !== null
        ? {
            ...rawDisposition,
            decisionId: undefined,
            fanout: rawDisposition.fanout.filter((fid) => fid === workerTicket.id),
          }
        : rawDisposition;
    const card = triggerCard(found, disposition);
    delete card.preview;
    delete card.chars;
    delete card.read;
    const status = app.store.replyStatus(key(["ack", found.id]));
    card.acknowledgement = status ?? "not_requested";
    if (safeOffset === 0) {
      const around: Record<string, unknown> = {};
      if (found.threads.length > 0) {
        const [before, after] = app.store.neighbours(threadKey(found.threads[0]), {
          at: found.at,
          id: found.id,
        });
        const shownBefore = shown(before);
        if (shownBefore !== undefined) {
          around.before = triggerLine(shownBefore);
        }
        const shownAfter = shown(after);
        if (shownAfter !== undefined) {
          around.after = triggerLine(shownAfter);
        }
      }
      card.around = around;
    }
    Object.assign(card, text(found.text));
    return card;
  }

  if (!resource.startsWith("ticket/")) {
    throw unknown();
  }
  const rest = resource.slice("ticket/".length);
  const parts = rest.split("/");
  if (parts.length < 1 || parts.length > 3) {
    throw unknown();
  }
  const id = parts[0];
  const section = parts.length >= 2 ? parts[1] : undefined;
  const part = parts.length === 3 ? parts[2] : undefined;
  if (id.length === 0) {
    throw unknown();
  }
  if (ticketId !== undefined && ticketId !== id) {
    throw new Error("Ticket does not belong to this worker");
  }
  const ticket = app.storeTicket(id);
  if (ticket === null) {
    throw new Error("Unknown ticket");
  }

  if (section === undefined) {
    const marked: Record<string, unknown>[] = [];
    const threads = app.store.subscribedThreads(undefined);
    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i];
      if (!thread.subscriptions.includes(id)) {
        continue;
      }
      const line: Record<string, unknown> = { thread: thread.key };
      if (thread.context?.includes(id)) {
        line.context = true;
      }
      marked.push(line);
    }
    const batch: Trigger[] = [];
    for (let i = 0; i < ticket.origin.triggerIds.length; i++) {
      const other = ticket.origin.triggerIds[i];
      if (other !== ticket.origin.triggerId) {
        const trigger = app.store.trigger(other);
        if (trigger !== undefined) {
          batch.push(trigger);
        }
      }
    }
    return ticketDetails(ticket, marked, batch, ticketId !== undefined);
  }

  if ((section === "assignments" || section === "inputs") && part === undefined) {
    const sectionSize = Math.max(
      0,
      Math.min(limit ?? (section === "assignments" ? 3 : 10), 50),
    );
    const [items, next] =
      section === "assignments"
        ? newestPage(ticket.assignments, safeOffset, sectionSize, (item) =>
            assignmentLine(ticket, item),
          )
        : newestPage(ticket.inputs, safeOffset, sectionSize, (input) =>
            inputLine(ticket, input),
          );
    return { items, next_offset: next ?? null };
  }

  let body: string;
  if (section === "assignment" && part === undefined) {
    body = ticket.execution?.assignment ?? "";
  } else if (section === "result" && part === undefined) {
    body = latestReport(ticket)?.summary ?? "";
  } else if (section === "transcript" && part === undefined) {
    const entries = app.workerTranscript(id);
    const lines = new Array<string>(entries.length);
    for (let index = 0; index < entries.length; index++) {
      const [kind, said] = entryText(entries[index]);
      lines[entries.length - 1 - index] = JSON.stringify({
        type: kind,
        preview: clip(preview(said), 80),
        chars: charCount(said),
        read: `ticket/${id}/message/${index}`,
      });
    }
    body = lines.join("\n");
  } else if (section === "input" && part !== undefined) {
    const input = ticket.inputs.find((item) => key([item.id]) === part || item.id === part);
    if (input === undefined) {
      throw new Error("Unknown ticket input");
    }
    const trigId = ticketInputTriggerId(input);
    const trigger = trigId !== undefined ? app.store.trigger(trigId) : undefined;
    const card =
      trigger !== undefined
        ? triggerMessage(trigger, input.kind === "trigger" ? input.note : undefined)
        : undefined;
    body = inputMessage(input, card);
  } else if (section === "message" && part !== undefined) {
    if (!UNSIGNED_INT.test(part)) {
      throw unknown();
    }
    const index = Number(part);
    if (!Number.isSafeInteger(index)) {
      throw unknown();
    }
    const entries = app.workerTranscript(id);
    if (index < 0 || index >= entries.length) {
      throw new Error("Unknown transcript entry");
    }
    body = JSON.stringify(entries[index]);
  } else if (section === "report" && part !== undefined) {
    const assignment = ticket.assignments.find((item) => item.id === part);
    if (assignment?.report === undefined) {
      throw new Error("Unknown assignment report");
    }
    body = assignment.report.summary;
  } else {
    throw unknown();
  }

  return text(body);
}
