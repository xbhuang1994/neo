/**
 * Errors a caller's request can raise: an invalid request or one that references missing state.
 */

import { fill } from "./reasons.ts";

/** User-facing error codes mapped to whether they report missing state and to their English template. */
export const USER_ERRORS: readonly (readonly [string, boolean, string])[] = [
  ["unknownTicket", true, "Unknown ticket"],
  ["unknownProblem", true, "Unavailable Eval not found"],
  ["unknownTrigger", true, "Unknown trigger"],
  ["unknownAssignment", true, "Unknown assignment"],
  ["ticketEnded", false, "Ticket has ended"],
  ["assignmentEnded", false, "Assignment has ended; a newer assignment owns this ticket"],
  ["evalFinished", false, "Eval {eval} has finished or a later eval replaced it; decide the trigger's current eval"],
  ["notAdmissible", false, "Trigger is not admissible: {reason}"],
  [
    "notExplicit",
    false,
    "An accept through orchestrator_route is for explicit requests from allowed senders; assess proactive candidates with orchestrator_eval and orchestrator_eval_decide",
  ],
  ["ticketStopped", false, "A person stopped this ticket; new work needs an accept through orchestrator_route"],
  ["mandateRevoked", false, "The current policy no longer holds this ticket's mandate; new work needs an accept through orchestrator_route"],
  [
    "notRetryable",
    false,
    "Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed",
  ],
  ["sourceThread", false, "This is the thread the ticket started on; it stays subscribed"],
  ["notFollowing", false, "This ticket does not follow that thread"],
  ["questionWithResult", false, "A question for a person cannot also be a ready result or an answer; report it separately"],
  ["askerWithoutQuestion", false, "The message that raised a question needs the question it raised"],
  ["notAsker", false, "A question must name the person's message that raised it, which reached this ticket"],
  ["notAnswerable", false, "An answer must name the person's question it answers, which reached this ticket"],
  ["ackEnded", false, "Ticket ended; do not acknowledge historical requests"],
  ["notReached", false, "Trigger does not belong to this worker"],
  ["handedBack", false, "This ticket handed that trigger back already"],
  [
    "handedBackHere",
    false,
    "The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it",
  ],
  [
    "workerDecides",
    false,
    "This message reached ticket {tickets} on its thread: its worker decides whether it belongs there and hands back what does not, which then arrives as a candidate. Only a stop goes through orchestrator_route, with kind stop",
  ],
  ["ackNoChannel", false, "Acknowledgement requires an assigned human source message"],
  ["ackNotPerson", false, "Use the original human trigger, not a bot or worker report"],
  [
    "notReady",
    false,
    "Ticket is not ready for delivery. Keep progress internal and wait for a verified ready report; do not relabel progress as an answer or send it through another channel.",
  ],
  [
    "resultSent",
    false,
    "This ticket's result already went to the person, by its worker's direct reply or an earlier reply. Do not send it again in other words; a new result needs a new ready report.",
  ],
  ["notAttention", false, "Attention requires the ticket's current attention question in human_action. Routine unfinished work stays internal."],
  ["notQuestion", false, "An answer must target the original human question, not a worker report or automated trigger"],
  [
    "noAnswer",
    false,
    "No worker answer is ready for this human trigger. Wait for the worker's report, or request one with orchestrator_ticket_request_status, which acts only on a worker that reported waiting; ordinary progress cannot be relabelled as an answer.",
  ],
  ["noChannel", false, "No reply channel for this ticket or trigger"],
  ["modelUnavailable", false, "The {block} model is not available: {error}"],
  ["invalid", false, "{message}"],
];

const USER_ERROR_MAP = new Map<string, { missing: boolean; template: string }>(
  USER_ERRORS.map(([code, missing, template]) => [code, { missing, template }]),
);

/** A refused or unanswerable request, by code; callers map `missing` to "not found" and the rest to "refused". */
export class UserError extends Error {
  /** One of `USER_ERRORS`. */
  readonly code: string;
  /** Values of the template's placeholders. */
  readonly values: Record<string, string>;
  /** Whether the request named state that does not exist. */
  readonly missing: boolean;

  constructor(code: string, values: Readonly<Record<string, string>> = {}) {
    const spec = USER_ERROR_MAP.get(code);
    const missing = spec?.missing ?? false;
    const template = spec?.template ?? code;
    const copied: Record<string, string> = { ...values };
    const message = fill(template, copied);
    super(message);
    this.name = "UserError";
    this.code = code;
    this.values = copied;
    this.missing = missing;
  }

  /** An error with no template values. */
  static create(code: string): UserError {
    return new UserError(code);
  }

  /** An error with template values. */
  static with(code: string, values: Readonly<Record<string, string>>): UserError {
    return new UserError(code, values);
  }

  /** A refused request with a free-form message. */
  static invalid(message: string): UserError {
    return new UserError("invalid", { message });
  }

  override toString(): string {
    return this.message;
  }
}

/** Type guard for `UserError`. */
export function isUserError(error: unknown): error is UserError {
  return error instanceof UserError;
}
