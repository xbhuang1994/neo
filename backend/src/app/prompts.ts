//! The built-in prompts of each role, composed from the packaged prompt files with the execution environment and, for
//! the orchestrator, the Policy section, which comes last so a Policy change leaves the rest of the prompt unchanged.

import { createHash } from "node:crypto";

import admissionMd from "../../../assets/prompts/admission.md" with { type: "text" };
import dispatchMd from "../../../assets/prompts/dispatch.md" with { type: "text" };
import handoffOrchestratorMd from "../../../assets/prompts/handoff-orchestrator.md" with { type: "text" };
import handoffWorkerMd from "../../../assets/prompts/handoff-worker.md" with { type: "text" };
import handoffMd from "../../../assets/prompts/handoff.md" with { type: "text" };
import orchestratorMd from "../../../assets/prompts/orchestrator.md" with { type: "text" };
import repliesMd from "../../../assets/prompts/replies.md" with { type: "text" };
import sharedMd from "../../../assets/prompts/shared.md" with { type: "text" };
import sidecarMd from "../../../assets/prompts/sidecar.md" with { type: "text" };
import subscriptionsMd from "../../../assets/prompts/subscriptions.md" with { type: "text" };
import communicationMd from "../../../assets/prompts/team/communication.md" with { type: "text" };
import deliveryMd from "../../../assets/prompts/team/delivery.md" with { type: "text" };
import scopeMd from "../../../assets/prompts/team/scope.md" with { type: "text" };
import watchdogMd from "../../../assets/prompts/watchdog.md" with { type: "text" };
import workMd from "../../../assets/prompts/work.md" with { type: "text" };
import workerMd from "../../../assets/prompts/worker.md" with { type: "text" };

/** A role whose Session has a composed system prompt. */
export type Role = "orchestrator" | "worker";

/** Proactive candidate accept mode. */
export type PromptAcceptMode = "off" | "observe" | "auto";

/** Minimal rule shape needed to render the Policy prompt section. */
export interface PolicyPromptRule {
  /** Stable rule id. */
  id: string;
  /** Display name. */
  name: string;
  /** Whether assessments may match it. */
  enabled: boolean;
  /** What it admits, in words for the assessor. */
  instruction: string;
}

/** One variable of the execution environment. */
export interface EnvVar {
  /** Its name. */
  key: string;
  /** Its value here. */
  value: string;
  /** What it is. */
  description: string;
}

/** Alias matching Rust `prompts::Variable`. */
export type Variable = EnvVar;

/** A ticket's place in the execution environment. */
export interface TicketPlace {
  /** The ticket id. */
  id: string;
  /** The ticket's short name, also its directory's name. */
  name: string;
  /** The ticket's directory. */
  directory: string;
}

/** Structural subset of application settings required by prompt builders (avoids circular imports). */
export interface PromptSettings {
  eval: {
    mode: PromptAcceptMode;
  };
  policy: {
    rules: ReadonlyArray<PolicyPromptRule>;
    sources?: Record<string, unknown>;
  };
  executor: {
    blockedCommands?: ReadonlyArray<string>;
    blocked_commands?: ReadonlyArray<string>;
  };
}

/**
 * Prompt files are written one sentence per line for readable diffs: lines within a paragraph are joined with
 * spaces, and each paragraph becomes one line.
 */
export function promptFile(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n").trim();
  if (normalized.length === 0) {
    return "";
  }
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(trimmed);
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join(" "));
  }
  return paragraphs.join("\n");
}

function guide(name: string, text: string): string {
  return `## ${name}\n${promptFile(text)}`;
}

// Pre-render immutable packaged markdown sections once at module initialization.
const SIDECAR_PROMPT = promptFile(sidecarMd);
const WATCHDOG_PROMPT = promptFile(watchdogMd);
const SHARED_PROMPT = promptFile(sharedMd);
const COMMUNICATION_GUIDE = guide("Communication", communicationMd);
const REPLIES_GUIDE = guide("replies", repliesMd);
const HANDOFF_PROMPT = promptFile(handoffMd);

const ORCHESTRATOR_STATIC_PREFIX = [
  SHARED_PROMPT,
  promptFile(orchestratorMd),
  COMMUNICATION_GUIDE,
  guide("subscriptions", subscriptionsMd),
  REPLIES_GUIDE,
  guide("dispatch", dispatchMd),
  promptFile(admissionMd),
  `${HANDOFF_PROMPT}\n${promptFile(handoffOrchestratorMd)}`,
].join("\n\n");

const WORKER_STATIC_PREFIX = [
  SHARED_PROMPT,
  promptFile(workerMd),
  COMMUNICATION_GUIDE,
  guide("Ticket scope", scopeMd),
  guide("Delivery requirements", deliveryMd),
  REPLIES_GUIDE,
  guide("work", workMd),
  `${HANDOFF_PROMPT}\n${promptFile(handoffWorkerMd)}`,
].join("\n\n");

/** The Sidecar's whole system prompt. */
export function sidecarPrompt(): string {
  return SIDECAR_PROMPT;
}

/** The Watchdog's whole system prompt. */
export function watchdogPrompt(): string {
  return WATCHDOG_PROMPT;
}

const ENVIRONMENT_HEADING =
  "Execution environment (from this installation's settings; an empty value means that part is not configured here). The prepare command of a ticket directory reads the same variables:";

/** The variables a prepare command reads and a Session is told about; never credentials. */
export function environment(
  settings: Pick<PromptSettings, "executor">,
  ticket?: TicketPlace | null,
): EnvVar[] {
  const variables: EnvVar[] = [];
  if (ticket) {
    variables.push({
      key: "NEO_AGENT_DIR",
      value: ticket.directory,
      description: "This ticket's directory; its worker Session works in it",
    });
    variables.push({
      key: "NEO_AGENT_NAME",
      value: ticket.name,
      description: "The ticket's short name, also its directory's name",
    });
    variables.push({
      key: "NEO_AGENT_TICKET",
      value: ticket.id,
      description: "The ticket id",
    });
  }
  const blocked = settings.executor.blockedCommands ?? settings.executor.blocked_commands ?? [];
  variables.push({
    key: "NEO_AGENT_BLOCKED_COMMANDS",
    value: blocked.join(" "),
    description: "Commands blocked in this execution environment, separated by spaces; never run them",
  });
  return variables;
}

/** Format execution environment variables as the prompt's Execution environment section. */
export function environmentSection(variables: ReadonlyArray<EnvVar>): string {
  const lines = variables.map(
    (variable) => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description}.`,
  );
  return `${ENVIRONMENT_HEADING}\n${lines.join("\n")}`;
}

/** The Watchdog Session's whole prompt: its instructions and the execution environment. */
export function watchdogSystem(settings: Pick<PromptSettings, "executor">): string {
  return `${WATCHDOG_PROMPT}\n\n${environmentSection(environment(settings, null))}`;
}

function oneLine(text: string): string {
  return text
    .split("\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
}

function canonicalizeSourcePolicy(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const allowed = Array.isArray(obj.allowed)
    ? obj.allowed.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const item = entry as Record<string, unknown>;
        return item.name !== undefined && item.name !== null ? { id: item.id, name: item.name } : { id: item.id };
      })
    : [];
  out.allowed = allowed;
  if (Array.isArray(obj.bots) && obj.bots.length > 0) {
    out.bots = obj.bots.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const item = entry as Record<string, unknown>;
      return item.name !== undefined && item.name !== null ? { id: item.id, name: item.name } : { id: item.id };
    });
  }
  if (obj.admission && typeof obj.admission === "object" && !Array.isArray(obj.admission)) {
    const admissionEntries = Object.entries(obj.admission as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (admissionEntries.length > 0) {
      const admission: Record<string, unknown> = {};
      for (const [rowKey, rowVal] of admissionEntries) {
        if (rowVal && typeof rowVal === "object" && !Array.isArray(rowVal)) {
          const row = rowVal as Record<string, unknown>;
          const normalizedRow: Record<string, unknown> = {};
          if (row.listedUnaddressed !== undefined && row.listedUnaddressed !== null) {
            normalizedRow.listedUnaddressed = row.listedUnaddressed;
          }
          if (row.unlistedAddressed !== undefined && row.unlistedAddressed !== null) {
            normalizedRow.unlistedAddressed = row.unlistedAddressed;
          }
          if (row.unlistedUnaddressed !== undefined && row.unlistedUnaddressed !== null) {
            normalizedRow.unlistedUnaddressed = row.unlistedUnaddressed;
          }
          admission[rowKey] = normalizedRow;
        }
      }
      out.admission = admission;
    }
  }
  return out;
}

/**
 * Fallback Policy version hash matching Rust `policy::policy_version` (`mandate-v4` + SHA-256 first 32 hex chars)
 * when callers do not pass a precomputed policy version.
 */
function fallbackPolicyVersion(settings: Pick<PromptSettings, "eval" | "policy">): string {
  const sortedSources: Record<string, unknown> = {};
  if (settings.policy.sources) {
    const keys = Object.keys(settings.policy.sources).sort();
    for (const key of keys) {
      sortedSources[key] = canonicalizeSourcePolicy(settings.policy.sources[key]);
    }
  }
  const parts = {
    rules: settings.policy.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      instruction: rule.instruction,
    })),
    mode: settings.eval.mode,
    sources: sortedSources,
  };
  const payload = JSON.stringify(["mandate-v4", JSON.stringify(parts)]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/**
 * The main Session's Policy section: the Policy version and accept mode it judges proactive candidates by, and every
 * enabled rule on one line, so a line of an instruction reads as no rule or heading of its own.
 */
export function policySection(
  settings: Pick<PromptSettings, "eval" | "policy">,
  policyVersion?: string,
): string {
  const rules = settings.policy.rules
    .filter((rule) => rule.enabled)
    .map((rule) => `- ${oneLine(rule.name)} (${rule.id}): ${oneLine(rule.instruction)}`);
  const mode = settings.eval.mode;
  const version = policyVersion ?? fallbackPolicyVersion(settings);
  const head = `## Policy\nPolicy version ${version}; accept mode ${mode}. The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules.`;
  if (rules.length === 0) {
    return `${head} No rule is enabled: a proactive candidate can only be ignored.`;
  }
  return `${head} The enabled rules, by name and id:\n${rules.join("\n")}`;
}

/**
 * A role's system prompt: every ticket's worker shares one without ticket-specific values or Policy, so providers
 * cache it once; the orchestrator's Policy section comes last so Policy changes keep the entire prefix unchanged.
 */
export function compose(role: Role, settings: PromptSettings, policyVersion?: string): string {
  // A worker's prompt names no ticket: each ticket's own values arrive with its assignment.
  const envSection = environmentSection(environment(settings, null));
  if (role === "worker") {
    return `${WORKER_STATIC_PREFIX}\n\n${envSection}`;
  }
  return `${ORCHESTRATOR_STATIC_PREFIX}\n\n${envSection}\n\n${policySection(settings, policyVersion)}`;
}
