/**
 * Ticket stage classification and retry eligibility.
 */

import { latestAssignment, waitsForPerson, type Ticket } from "./model.ts";

/** What a person is waited on for. */
export type PersonAction = "delivery" | "answer" | "review" | "blocked" | "failed";

/** High-level execution stage of a ticket. */
export type TicketStage =
  | { kind: "person"; action: PersonAction }
  | { kind: "working"; queued: boolean }
  | { kind: "idle" }
  | { kind: "ended" };

/** Classifies a ticket's stage; the first matching rule wins. */
export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.ended !== undefined) {
    return { kind: "ended" };
  }
  if (ticket.delivery !== undefined) {
    return { kind: "person", action: "delivery" };
  }
  if (ticket.attention !== undefined) {
    return { kind: "person", action: "answer" };
  }
  const assignment = latestAssignment(ticket);
  const report = assignment?.report?.state;
  if (report === "ready") {
    return { kind: "person", action: "review" };
  }
  // A human follow-up after a blocked or failed report returns the ticket to the executor.
  if (waitsForPerson(ticket)) {
    return { kind: "person", action: report === "blocked" ? "blocked" : "failed" };
  }
  if (assignment === undefined || assignment.state === "pending") {
    return { kind: "working", queued: true };
  }
  if (report === "waiting" || assignment.state === "ended") {
    return { kind: "idle" };
  }
  return { kind: "working", queued: false };
}

/** True when an open ticket is stalled on a blocked/failed report without a newer human follow-up, or has a failed input delivery. */
export function canRetry(ticket: Ticket): boolean {
  return ticket.ended === undefined && (waitsForPerson(ticket) || ticket.delivery !== undefined);
}
