/**
 * Structured reason codes and templates for decisions, filtered triggers, and ended assignments.
 * Policy gates and source scopes may also emit their own literal reason codes.
 */

/** Reason codes the core emits, with their English templates. */
export const REASONS: readonly (readonly [string, string])[] = [
  ["said", "{text}"],
  ["timeout", "Assessment timed out"],
  ["policyChanged", "Policy changed during assessment"],
  ["noAdmissible", "No admissible trigger"],
  ["startedTicket", "Already started ticket {ticket}"],
  ["acceptedBefore", "Trigger {trigger} was accepted before"],
  ["routed", "Routed to ticket {ticket}"],
  ["explicitRouted", "Explicit request from an allowed sender routed by the orchestrator"],
  ["humanStop", "Human asked to stop"],
  ["forwarded", "Forwarded to the worker of the Ticket already on this Thread"],
  ["senderNotMember", "The sender is not on the Source's list"],
  ["retried", "Retried by a person"],
  ["hostRestarted", "neo-agent restarted"],
  ["stopUnknown", "Stop target is unknown or already ended"],
  ["stopNotExplicit", "A stop needs an explicit request from a sender on the list"],
  [
    "directionUnsettled",
    "Implementation intent or target direction is not established, or a product/design decision is still required",
  ],
  ["noRuleMatched", "No enabled admission rule matched"],
  ["ignoredFromCard", "Ignored from its card, without a rule assessment"],
  ["observed", "Observe mode: would accept ({text})"],
  ["clarificationRequested", "Clarification requested from the person"],
  ["sidecarRouted", "Answered via read-only sidecar"],
];

const REASON_MAP = new Map<string, string>(REASONS);

/** Reason code and template values; `triggerId` identifies the trigger in a batch that the reason applies to. */
export interface Reason {
  /** One of `REASONS`, or a literal code a gate or scope emitted. */
  code: string;
  /** Values for the template's placeholders (omitted in JSON when empty). */
  values?: Record<string, string>;
  /** The trigger of a batch this reason applies to. */
  triggerId?: string;
}

/** A reason with no values. */
export function reasonCode(code: string): Reason {
  return { code };
}

/** A reason with one template value. */
export function reasonWith(code: string, name: string, value: string): Reason {
  return { code, values: { [name]: value } };
}

/** The same reason, for one trigger of a batch. */
export function reasonOf(reason: Reason, triggerId: string): Reason {
  return { ...reason, triggerId };
}

/** The reason an assessor or a person gave in words. */
export function said(text: string): Reason {
  return reasonWith("said", "text", text);
}

const PLACEHOLDER_RE = /^[\p{L}\p{N}_]+$/u;

/** Replaces `{name}` placeholders with their values; unknown placeholders stay. */
export function fill(template: string, values?: Readonly<Record<string, string>>): string {
  let out = "";
  let pos = 0;
  const len = template.length;
  while (pos < len) {
    const open = template.indexOf("{", pos);
    if (open === -1) {
      out += template.slice(pos);
      break;
    }
    out += template.slice(pos, open);
    const afterStart = open + 1;
    const close = template.indexOf("}", afterStart);
    if (close !== -1 && close > afterStart) {
      const name = template.slice(afterStart, close);
      if (PLACEHOLDER_RE.test(name)) {
        if (values !== undefined && Object.prototype.hasOwnProperty.call(values, name)) {
          out += values[name];
        } else {
          out += template.slice(open, close + 1);
        }
        pos = close + 1;
        continue;
      }
    }
    out += "{";
    pos = afterStart;
  }
  return out;
}

/** Formats reasons in English (prefixed by the trigger id when present) for agent consumption. */
export function reasonText(reasons: readonly Reason[]): string {
  return reasons
    .map((reason) => {
      const template = REASON_MAP.get(reason.code) ?? reason.code;
      const text = fill(template, reason.values);
      return reason.triggerId !== undefined ? `${reason.triggerId}: ${text}` : text;
    })
    .join("; ");
}
