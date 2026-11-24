/**
 * What the Executor and its workers report about the Assignments that run tickets.
 */

import type { EngineContext } from "./engine.ts";
import { UserError } from "./errors.ts";
import { key } from "./ids.ts";
import {
  findTicketInput,
  isReadUndelivered,
  isTicketLive,
  readAtTimestamp,
  runningAssignment,
  ticketInputAutomatic,
  type Attention,
  type ReportState,
  type Ticket,
  type TicketOutcome,
} from "./model.ts";
import { repliesWithdrawAttention } from "./replies.ts";
import { ticketsEnd, ticketsRestart } from "./tickets.ts";

/** The open question a report carries. */
export type Question =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "ask"; question: string };

/** What an Assignment reports: a worker's report, or the Executor's own (`waiting` after an idle turn, `failed` after an error). */
export interface WorkerReport {
  /** What it reports. */
  state: ReportState;
  /** In words. */
  summary: string;
  /** Open question for a person (defaults to `{ kind: "keep" }`). */
  question?: Question;
  /** The person's message whose request raised the question; routes the question to where it was written. */
  askedBy?: string;
  /** The person's question this report answers, which the worker thereby takes up; authorizes an answer reply. */
  answers?: string;
  /** What the ticket is about now, in a sentence or two; replaces the ticket's digest. */
  topic?: string;
  /** Sanitized deliverable filenames or relative paths recorded on completion or progress for historical recall. */
  artifacts?: string[];
}

/** Construct a `WorkerReport` with state, summary, and optional fields. */
export function workerReport(
  state: ReportState,
  summary: string,
  extra?: Partial<Omit<WorkerReport, "state" | "summary">>,
): WorkerReport {
  return { state, summary, ...extra };
}

const RECOVERY_NOTE =
  "The host restarted during this ticket. Inspect the current working directory and its history before continuing. Do not repeat an already completed external operation. Background jobs and subagents of the previous run stopped with it; rerun what you still need. Finish the original assignment and report its status.";

const MAX_TICKET_ARTIFACTS = 20;

/** Truncates `text` to at most `maxChars` Unicode scalar values (matching Rust `chars().take(n)`). */
function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let count = 0;
  let i = 0;
  while (i < text.length && count < maxChars) {
    const code = text.charCodeAt(i);
    i += code >= 0xd800 && code <= 0xdbff && i + 1 < text.length ? 2 : 1;
    count++;
  }
  return text.slice(0, i);
}

/** Marks a non-ended assignment running and queues delivery of waiting Inputs on an open ticket. */
export function assignmentsStarted(
  ctx: EngineContext,
  ticketId: string,
  assignmentId: string,
): void {
  const ticket = ctx.require(ticketId);
  const now = ctx.now();
  const assignment = ticket.assignments.find(
    (a) => a.id === assignmentId && a.state !== "ended",
  );
  if (assignment === undefined) {
    return;
  }
  assignment.state = "running";
  if (assignment.startedAt === undefined) {
    assignment.startedAt = now;
  }
  const snapshot = structuredClone(assignment);
  ticket.updatedAt = now;
  ctx.repo().saveTicket(ticket);
  if (isTicketLive(ticket) && ticket.undelivered.length > 0) {
    ctx.o.executor.deliver(ticket, snapshot);
  }
  ctx.emit({ type: "assignmentStarted", ticketId, assignmentId });
}

/**
 * Marks `inputIds` delivered on the ticket's running assignment and clears any prior delivery failure; ignored if
 * that assignment no longer runs.
 */
export function assignmentsDelivered(
  ctx: EngineContext,
  ticketId: string,
  assignmentId: string,
  inputIds: readonly string[],
): void {
  const ticket = runningTicket(ctx, ticketId, assignmentId);
  if (ticket === undefined) {
    return;
  }
  const now = ctx.now();
  const idSet = new Set(inputIds);
  ticket.undelivered = ticket.undelivered.filter((id) => !idSet.has(id));
  ticket.updatedAt = now;
  const running = runningAssignment(ticket);
  if (running !== undefined) {
    running.deliveredAt = now;
  }
  for (const input of ticket.inputs) {
    if (input.kind === "trigger" && idSet.has(input.id)) {
      if (isReadUndelivered(input.readAt)) {
        input.readAt = null;
      }
      input.deliveredTo = assignmentId;
    }
  }
  delete ticket.delivery;
  ctx.repo().saveTicket(ticket);
}

/** Records when the worker's Session of an open ticket took `inputIds` into a step, from which its model reads them. */
export function assignmentsRead(
  ctx: EngineContext,
  ticketId: string,
  inputIds: readonly string[],
): void {
  const ticket = ctx.require(ticketId);
  if (!isTicketLive(ticket)) {
    return;
  }
  const now = ctx.now();
  const idSet = new Set(inputIds);
  for (const input of ticket.inputs) {
    if (
      input.kind === "trigger" &&
      idSet.has(input.id) &&
      readAtTimestamp(input.readAt) === undefined
    ) {
      input.readAt = now;
    }
  }
  ctx.repo().saveTicket(ticket);
}

export function assignmentsTurnEnded(
  ctx: EngineContext,
  ticketId: string,
  assignmentId: string,
): void {
  const ticket = runningTicket(ctx, ticketId, assignmentId);
  if (ticket === undefined) {
    return;
  }
  const running = runningAssignment(ticket);
  if (running !== undefined) {
    running.idleAt = ctx.now();
  }
  ctx.repo().saveTicket(ticket);
}

export function assignmentsDeliveryFailed(
  ctx: EngineContext,
  ticketId: string,
  assignmentId: string,
  error: string,
): void {
  const ticket = runningTicket(ctx, ticketId, assignmentId);
  if (ticket === undefined) {
    return;
  }
  ticket.delivery = { error: truncateChars(error, 300), at: ctx.now() };
  ctx.repo().saveTicket(ticket);
}

/**
 * Handles a running assignment interrupted by a host restart: restarts it with a recovery note unless its latest
 * report is `waiting`, `ready`, `blocked`, or `failed` and no input was delivered after that report, in which case
 * it keeps its session and flushes any waiting inputs.
 */
export function assignmentsInterrupted(
  ctx: EngineContext,
  ticketId: string,
  assignmentId: string,
): void {
  const ticket = runningTicket(ctx, ticketId, assignmentId);
  if (ticket === undefined) {
    return;
  }
  const running = runningAssignment(ticket);
  if (running === undefined) {
    return;
  }
  const busy =
    running.deliveredAt !== undefined &&
    running.report !== undefined &&
    running.deliveredAt >= running.report.at;
  const settledState =
    running.report !== undefined &&
    (running.report.state === "waiting" ||
      running.report.state === "ready" ||
      running.report.state === "blocked" ||
      running.report.state === "failed") &&
    !busy;
  if (!settledState) {
    ticketsRestart(ctx, ticket, running.id, "hostRestarted", RECOVERY_NOTE);
  } else if (ticket.undelivered.length > 0) {
    ctx.o.executor.deliver(ticket, running);
  }
}

/**
 * Records a worker status report on an open ticket's current assignment, updating its question, answers and held
 * automated inputs, and ending the ticket when `dropped` or `ready`.
 */
export function assignmentsReport(
  ctx: EngineContext,
  ticketId: string,
  report: WorkerReport,
): Ticket {
  const ticket = ctx.require(ticketId);
  if (!isTicketLive(ticket)) {
    throw UserError.create("ticketEnded");
  }
  const question: Question = report.question ?? { kind: "keep" };
  const asks = question.kind === "ask";
  if (asks && (report.state === "ready" || report.answers !== undefined)) {
    throw UserError.create("questionWithResult");
  }
  if (report.askedBy !== undefined && !asks) {
    throw UserError.create("askerWithoutQuestion");
  }
  const person = (id: string, needChannel: boolean): boolean => {
    const trigger = ctx.repo().trigger(id);
    return (
      trigger !== undefined &&
      trigger.human &&
      (!needChannel || trigger.channel !== undefined) &&
      ctx.reaches(ticket, trigger, false)
    );
  };
  if (report.askedBy !== undefined && !person(report.askedBy, true)) {
    throw UserError.create("notAsker");
  }
  if (report.answers !== undefined && !person(report.answers, false)) {
    throw UserError.create("notAnswerable");
  }

  let index = ticket.assignments.findIndex((a) => a.state === "running");
  if (index === -1) {
    if (ticket.assignments.length === 0) {
      throw UserError.create("unknownAssignment");
    }
    index = ticket.assignments.length - 1;
  }
  if (ticket.assignments[index].state === "ended") {
    throw UserError.create("assignmentEnded");
  }

  const at = ctx.now();
  const previous = ticket.attention !== undefined ? structuredClone(ticket.attention) : undefined;
  let asked: Attention | undefined = previous;
  if (question.kind === "ask" && previous?.question !== question.question) {
    asked = {
      id: key(["attention", ticketId, question.question, at]),
      question: question.question,
      ...(report.askedBy !== undefined ? { triggerId: report.askedBy } : {}),
    };
  }
  const attention = question.kind === "clear" || report.state === "ready" ? undefined : asked;
  // A replaced or cleared question withdraws any pending unsent reply for the previous one from the outbox.
  if (previous !== undefined && attention?.id !== previous.id) {
    repliesWithdrawAttention(ctx, previous.id);
  }
  if (attention !== undefined) {
    ticket.attention = attention;
  } else {
    delete ticket.attention;
  }

  ticket.assignments[index].report = {
    state: report.state,
    summary: report.summary,
    at,
  };
  // A drop only hands a message back or says nothing is left; it never says what the ticket is about now.
  if (report.topic !== undefined && report.topic.length > 0 && report.state !== "dropped") {
    ticket.digest = report.topic;
  }
  if (report.artifacts !== undefined && report.artifacts.length > 0 && report.state !== "dropped") {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const item of report.artifacts) {
      const trimmed = item.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
      if (merged.length >= MAX_TICKET_ARTIFACTS) break;
    }
    if (merged.length < MAX_TICKET_ARTIFACTS && ticket.artifacts !== undefined) {
      for (const item of ticket.artifacts) {
        const trimmed = item.trim();
        if (trimmed.length === 0 || seen.has(trimmed)) continue;
        seen.add(trimmed);
        merged.push(trimmed);
        if (merged.length >= MAX_TICKET_ARTIFACTS) break;
      }
    }
    if (merged.length > 0) {
      ticket.artifacts = merged;
    }
  }
  ticket.updatedAt = at;

  if (report.answers !== undefined) {
    const answers = ticket.answers ?? [];
    if (!answers.includes(report.answers)) {
      answers.push(report.answers);
    }
    ticket.answers = answers;
    ctx.takeUp(ticketId, report.answers);
  }

  if (report.state === "blocked" || report.state === "failed") {
    ticket.undelivered = ticket.undelivered.filter((id) => {
      const inp = findTicketInput(ticket, id);
      return inp !== undefined && !ticketInputAutomatic(inp);
    });
  }

  ctx.repo().saveTicket(ticket);

  const outcome: TicketOutcome | undefined =
    report.state === "dropped"
      ? "dropped"
      : report.state === "ready"
        ? "completed"
        : undefined;
  if (outcome !== undefined) {
    ticketsEnd(ctx, ticketId, "executor", outcome, at, undefined);
  }
  return ctx.require(ticketId);
}

/** The ticket, while it is open and `assignmentId` runs it. */
function runningTicket(
  ctx: EngineContext,
  ticketId: string,
  assignmentId: string,
): Ticket | undefined {
  const ticket = ctx.require(ticketId);
  return isTicketLive(ticket) && runningAssignment(ticket)?.id === assignmentId
    ? ticket
    : undefined;
}
