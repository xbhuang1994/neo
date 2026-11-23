//! The Policy the settings make: who may originate work, whether a Mandate still holds, and what an assessment decides.
//!
//! Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person
//! across Sources.

import {
  key,
  mandateBasisVia,
  reasonCode,
  reasonWith,
  whyCode,
  whySaid,
  type Accept,
  type AcceptMode,
  type AdmissionCell,
  type BasisVia,
  type GateResult,
  type Json,
  type Mandate,
  type MandateBasis,
  type Observation,
  type Outcome,
  type Policy,
  type PolicyEffect,
  type RuleEffect,
  type ScopeResult,
  type SourceScope,
  type Strength,
  type Thread,
  type Ticket,
  type Trigger,
} from "../core/index.ts";
import {
  CHAT_SOURCE,
  allowedSender,
  cloneSettings,
  listedBot,
  type Admission,
  type AdmissionRow,
  type Allowed,
  type Rule,
  type Settings,
  type SourcePolicy,
} from "./settings.ts";

/** Bumped when the meaning of stored Mandates changes. */
export const POLICY_REVISION = "mandate-v4";

function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  const lenA = a.length;
  const lenB = b.length;
  while (i < lenA && j < lenB) {
    const cpA = a.codePointAt(i)!;
    const cpB = b.codePointAt(j)!;
    if (cpA !== cpB) {
      return cpA < cpB ? -1 : 1;
    }
    i += cpA > 0xffff ? 2 : 1;
    j += cpB > 0xffff ? 2 : 1;
  }
  return lenA - lenB;
}

/** Counts Unicode scalar values, matching Rust `str::chars().count()`. */
function charCount(text: string): number {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeRule(rule: Rule): string {
  return `{"id":${JSON.stringify(rule.id)},"name":${JSON.stringify(rule.name)},"enabled":${
    rule.enabled ? "true" : "false"
  },"instruction":${JSON.stringify(rule.instruction)}}`;
}

function serializeAllowed(entry: Allowed): string {
  return entry.name !== undefined
    ? `{"id":${JSON.stringify(entry.id)},"name":${JSON.stringify(entry.name)}}`
    : `{"id":${JSON.stringify(entry.id)}}`;
}

function serializeAdmissionRow(row: AdmissionRow): string {
  const fields: string[] = [];
  if (row.listedUnaddressed !== undefined) {
    fields.push(`"listedUnaddressed":${JSON.stringify(row.listedUnaddressed)}`);
  }
  if (row.unlistedAddressed !== undefined) {
    fields.push(`"unlistedAddressed":${JSON.stringify(row.unlistedAddressed)}`);
  }
  if (row.unlistedUnaddressed !== undefined) {
    fields.push(`"unlistedUnaddressed":${JSON.stringify(row.unlistedUnaddressed)}`);
  }
  return `{${fields.join(",")}}`;
}

function serializeSourcePolicy(policy: SourcePolicy): string {
  const fields: string[] = [`"allowed":[${policy.allowed.map(serializeAllowed).join(",")}]`];
  if (policy.bots !== undefined && policy.bots.length > 0) {
    fields.push(`"bots":[${policy.bots.map(serializeAllowed).join(",")}]`);
  }
  if (policy.admission !== undefined) {
    const rowKeys = Object.keys(policy.admission).sort(compareCodePoints);
    if (rowKeys.length > 0) {
      const rows = rowKeys.map(
        (rowKey) => `${JSON.stringify(rowKey)}:${serializeAdmissionRow(policy.admission![rowKey])}`,
      );
      fields.push(`"admission":{${rows.join(",")}}`);
    }
  }
  return `{${fields.join(",")}}`;
}

function serializeSources(sources: Readonly<Record<string, SourcePolicy>>): string {
  const sourceKeys = Object.keys(sources).sort(compareCodePoints);
  const entries = sourceKeys.map(
    (sourceKey) => `${JSON.stringify(sourceKey)}:${serializeSourcePolicy(sources[sourceKey])}`,
  );
  return `{${entries.join(",")}}`;
}

/**
 * A version of the settings that bear on authorization: rules, accept mode and senders. Models, concurrency and the
 * pause change nothing an earlier Decision relied on.
 */
export function policyVersion(settings: Settings): string {
  const partsJson = `{"rules":[${settings.policy.rules
    .map(serializeRule)
    .join(",")}],"mode":${JSON.stringify(settings.eval.mode)},"sources":${serializeSources(
    settings.policy.sources,
  )}}`;
  return key([POLICY_REVISION, partsJson]);
}

/**
 * The installed Sources as the domain sees them: the chat Source listens to its conversations without fan-out, since
 * the main Session routes each message to one ticket.
 */
export class Sources implements SourceScope {
  scope(source: string, _meta: Json): ScopeResult {
    if (source === CHAT_SOURCE) {
      return { kind: "listened", observed: false, fanout: false };
    }
    return { kind: "ignored", reason: "source_not_installed" };
  }
}

function senderName(entry: Allowed): string {
  return entry.name ?? entry.id;
}

function defaultAdmission(cell: AdmissionCell): Admission {
  switch (cell) {
    case "listedUnaddressed":
      return "inferred";
    case "unlistedAddressed":
    case "unlistedUnaddressed":
      return "ignore";
  }
}

function admissionRank(admission: Admission): number {
  switch (admission) {
    case "ignore":
      return 0;
    case "inferred":
      return 1;
    case "explicit":
      return 2;
  }
}

function strengthRank(strength: Strength): number {
  return strength === "explicit" ? 2 : 1;
}

/** Whether a thread has tickets of its own, not only ones that follow it for context. */
function participating(thread: Thread, tickets: readonly Ticket[]): boolean {
  const context = thread.context;
  if (context === undefined || context.length === 0) {
    return thread.subscriptions.length > 0 || tickets.length > 0;
  }
  const contextSet = context.length > 4 ? new Set(context) : undefined;
  const inContext = (id: string): boolean =>
    contextSet !== undefined ? contextSet.has(id) : context.includes(id);
  for (let i = 0; i < thread.subscriptions.length; i++) {
    if (!inContext(thread.subscriptions[i])) return true;
  }
  for (let i = 0; i < tickets.length; i++) {
    if (!inContext(tickets[i].id)) return true;
  }
  return false;
}

/** The Policy of one settings snapshot. */
export class SettingsPolicy implements Policy {
  private readonly settings: Settings;
  private readonly policyVersionValue: string;
  private readonly sources: SourceScope;
  private readonly enabledRules: Set<string>;

  /** The Policy these settings make over the installed Sources. */
  constructor(settings: Settings, sources: SourceScope = new Sources()) {
    this.settings = cloneSettings(settings);
    this.policyVersionValue = policyVersion(this.settings);
    this.sources = sources;
    this.enabledRules = new Set<string>();
    for (const rule of this.settings.policy.rules) {
      if (rule.enabled) {
        this.enabledRules.add(rule.id);
      }
    }
  }

  private mode(): AcceptMode {
    return this.settings.eval.mode;
  }

  private admission(source: string, row: string | undefined, cell: AdmissionCell): Admission {
    const admissionRow =
      row !== undefined ? this.settings.policy.sources[source]?.admission?.[row] : undefined;
    let configured: Admission | undefined;
    if (admissionRow !== undefined) {
      switch (cell) {
        case "listedUnaddressed":
          configured = admissionRow.listedUnaddressed;
          break;
        case "unlistedAddressed":
          configured = admissionRow.unlistedAddressed;
          break;
        case "unlistedUnaddressed":
          configured = admissionRow.unlistedUnaddressed;
          break;
      }
    }
    return configured ?? defaultAdmission(cell);
  }

  private rulesOn(rules: readonly string[] | undefined): boolean {
    if (rules === undefined || rules.length === 0) return true;
    for (let i = 0; i < rules.length; i++) {
      if (!this.enabledRules.has(rules[i])) return false;
    }
    return true;
  }

  /** Non-human triggers: only listed bots, as inferred candidates, and senderless system events may pass. */
  private machineGate(trigger: Trigger): GateResult {
    const refuse = (reason: string): GateResult => ({ kind: "inadmissible", reason });
    const bot =
      trigger.actor.id.length === 0
        ? undefined
        : listedBot(this.settings, trigger.actor.source, trigger.actor.id);
    if (trigger.actor.id.length > 0 && bot === undefined) {
      return refuse("not_human");
    }
    const scoped = this.sources.scope(trigger.source, trigger.meta);
    if (scoped.kind !== "listened") {
      return refuse("not_human");
    }
    if (trigger.addressed === undefined && !scoped.observed) {
      return refuse("not_human");
    }
    const mode = this.mode();
    const recorded = (via: BasisVia, sender: string | undefined): MandateBasis =>
      mandateBasisVia(via, {
        source: trigger.source,
        scope: structuredClone(trigger.meta),
        row: scoped.row,
        sender,
      });
    if (bot !== undefined) {
      if (mode === "off") {
        return refuse("admission_ignored");
      }
      const via: BasisVia =
        trigger.addressed !== undefined
          ? { via: "bot", addressed: trigger.addressed, observation: { mode } }
          : { via: "bot", observation: { mode } };
      return { kind: "admissible", strength: "inferred", basis: recorded(via, senderName(bot)) };
    }
    const cell: AdmissionCell = "unlistedUnaddressed";
    if (this.admission(trigger.source, scoped.row, cell) !== "inferred" || mode === "off") {
      return refuse("admission_ignored");
    }
    const via: BasisVia = { via: "admission", cell, observation: { mode } };
    return { kind: "admissible", strength: "inferred", basis: recorded(via, undefined) };
  }

  version(): string {
    return this.policyVersionValue;
  }

  paused(): boolean {
    return this.settings.paused;
  }

  evalTimeoutMs(): number {
    return this.settings.eval.timeoutSeconds * 1000;
  }

  gate(trigger: Trigger, thread: Thread, tickets: readonly Ticket[]): GateResult {
    if (!trigger.human) {
      return this.machineGate(trigger);
    }
    const allowed = allowedSender(this.settings, trigger.actor.source, trigger.actor.id);
    const scoped = this.sources.scope(trigger.source, trigger.meta);
    const listened = scoped.kind === "listened";
    const observed = scoped.kind === "listened" ? scoped.observed : false;
    const row = scoped.kind === "listened" ? scoped.row : undefined;
    const sender = allowed !== undefined ? senderName(allowed) : undefined;
    const admit = (strength: Strength, via: BasisVia): GateResult => ({
      kind: "admissible",
      strength,
      basis: mandateBasisVia(via, {
        source: trigger.source,
        scope: structuredClone(trigger.meta),
        row,
        sender,
      }),
    });

    if (allowed !== undefined && trigger.addressed !== undefined) {
      return admit("explicit", { via: "addressed", addressed: trigger.addressed });
    }
    const cell: AdmissionCell =
      allowed !== undefined
        ? "listedUnaddressed"
        : trigger.addressed !== undefined
          ? "unlistedAddressed"
          : "unlistedUnaddressed";

    // An unaddressed message only uses the admission table when the Source observes every message in that scope.
    const receivable = trigger.addressed !== undefined || (listened && observed);
    const admission: Admission = receivable
      ? this.admission(trigger.source, row, cell)
      : "ignore";
    const byCell = (observation: Observation | undefined): BasisVia => ({
      via: "admission",
      cell,
      ...(trigger.addressed !== undefined ? { addressed: trigger.addressed } : {}),
      ...(observation !== undefined ? { observation } : {}),
    });

    // An explicit cell comes before thread follow-ups, so a thread's tickets never weaken an explicit request.
    if (admission === "explicit") {
      return admit("explicit", byCell(undefined));
    }
    const mode = this.mode();
    // A direct-message thread belongs to one sender, and an inferred follow-up needs an accept mode other than off.
    const strangerDirect = trigger.addressed === "direct" && allowed === undefined;
    if (!strangerDirect && (allowed !== undefined || mode !== "off") && participating(thread, tickets)) {
      return admit(allowed !== undefined ? "explicit" : "inferred", { via: "followup" });
    }
    if (admission === "inferred" && mode !== "off") {
      return admit("inferred", byCell({ mode }));
    }
    const reason =
      allowed === undefined
        ? "not_a_member"
        : receivable && admission === "ignore"
          ? "admission_ignored"
          : "no_mention";
    return { kind: "inadmissible", reason };
  }

  revalidate(mandate: Mandate): boolean {
    const basis = mandate.basis;
    const current =
      basis.source !== undefined && basis.scope !== undefined
        ? this.sources.scope(basis.source, basis.scope)
        : undefined;
    let row: string | undefined;
    if (current !== undefined) {
      if (current.kind === "ignored") {
        return false;
      }
      row = current.row;
    }
    const auto = this.mode() === "auto" && this.rulesOn(basis.rules);
    const listed =
      allowedSender(this.settings, mandate.actor.source, mandate.actor.id) !== undefined;
    switch (basis.via) {
      // An explicit follow-up stays valid; an inferred one needs auto mode and its matched rules enabled.
      case "followup":
        return mandate.strength === "explicit" || auto;
      // A bot's candidate holds only while the bot stays on its Source's bot list.
      case "bot":
        return (
          listedBot(this.settings, mandate.actor.source, mandate.actor.id) !== undefined && auto
        );
      case "addressed":
        return listed;
      // An admission-table Mandate holds while the sender's cell now still grants at least its strength.
      case "admission": {
        // A listed sender who addresses the agent is always explicit and uses no cell.
        if (basis.cell === "unlistedAddressed" && listed) {
          return true;
        }
        // A sender listed since acceptance moves to the listed cell.
        const now: AdmissionCell =
          basis.cell === "unlistedUnaddressed" && listed ? "listedUnaddressed" : basis.cell;
        if (now === "listedUnaddressed" && !listed) {
          return false;
        }
        const admission = this.admission(basis.source ?? "", row, now);
        if (admissionRank(admission) < strengthRank(mandate.strength)) {
          return false;
        }
        return mandate.strength === "explicit" || basis.observation === undefined || auto;
      }
    }
  }

  admitsInferred(rules: readonly string[]): boolean {
    return this.mode() === "auto" && rules.length > 0 && this.rulesOn(rules);
  }
}

function rulesEqual(a: Rule | undefined, b: Rule): boolean {
  return (
    a !== undefined &&
    a.id === b.id &&
    a.name === b.name &&
    a.enabled === b.enabled &&
    a.instruction === b.instruction
  );
}

/** How a settings change from `old` to `now` bears on each open ticket's authorization or matched rules. */
export function policyEffects(
  tickets: readonly Ticket[],
  old: Settings,
  now: Settings,
  sources: SourceScope = new Sources(),
): Map<string, PolicyEffect> {
  const before = new SettingsPolicy(old, sources);
  const after = new SettingsPolicy(now, sources);
  // The settings now, with the accept mode and rules as before: what holds under them was not lost to those.
  const asBeforeSettings = cloneSettings(now);
  asBeforeSettings.eval = { ...old.eval };
  asBeforeSettings.policy.rules = old.policy.rules.map((rule) => ({ ...rule }));
  const asBefore = new SettingsPolicy(asBeforeSettings, sources);

  const oldRules = new Map<string, Rule>();
  for (const rule of old.policy.rules) {
    if (!oldRules.has(rule.id)) {
      oldRules.set(rule.id, rule);
    }
  }
  const nowEnabledRules = new Map<string, Rule>();
  for (const rule of now.policy.rules) {
    if (!nowEnabledRules.has(rule.id) && rule.enabled) {
      nowEnabledRules.set(rule.id, rule);
    }
  }

  const effects = new Map<string, PolicyEffect>();
  for (const ticket of tickets) {
    const mandate = ticket.mandate;
    const ruleEffects: RuleEffect[] = [];
    for (const id of mandate.basis.rules ?? []) {
      const was = oldRules.get(id);
      const is = nowEnabledRules.get(id);
      if (is === undefined) {
        if (was !== undefined && was.enabled) {
          ruleEffects.push({ id, name: was.name, change: "disabled" });
        }
      } else if (!rulesEqual(was, is)) {
        ruleEffects.push({ id, name: is.name, change: "changed", instruction: is.instruction });
      }
    }
    const effect: PolicyEffect = {};
    if (ruleEffects.length > 0) {
      effect.rules = ruleEffects;
    }
    if (before.revalidate(mandate) && !after.revalidate(mandate)) {
      if (!asBefore.revalidate(mandate)) {
        effect.requesterAllowed = false;
        effect.requester = { ...mandate.actor };
      } else if (
        mandate.strength === "inferred" &&
        old.eval.mode === "auto" &&
        now.eval.mode !== "auto"
      ) {
        effect.proactive = false;
      }
    }
    if (
      effect.rules !== undefined ||
      effect.proactive !== undefined ||
      effect.requesterAllowed !== undefined
    ) {
      effects.set(ticket.id, effect);
    }
  }
  return effects;
}

/** One rule's judgement in an assessment (snake_case wire shape). */
export interface RuleAssessment {
  /** The rule judged. */
  rule_id: string;
  /** Whether the candidate matches it. */
  matched: boolean;
  /** Why, in words. */
  reason: string;
}

/** What the assessor's model returned for a candidate (snake_case wire shape). */
export interface Assessment {
  /** `accept`, `ignore` or `unavailable`. */
  decision: string;
  /** One judgement for every enabled rule. */
  rule_assessments: RuleAssessment[];
  /** Whether implementation intent and a settled target are established. */
  direction: unknown;
  /** The ticket's title. */
  title: string;
  /** What the Mandate authorizes. */
  scope: string;
  /** Why, in words. */
  reason: string;
  /** The words that show the person wants the work done. */
  intent_evidence?: string;
  /** The acknowledgement to send. */
  acknowledgement?: string;
  /** The ticket's requested short name. */
  worktree_name?: string;
}

const RULE_ASSESSMENT_KEYS = new Set<string>(["rule_id", "matched", "reason"]);
const ASSESSMENT_KEYS = new Set<string>([
  "decision",
  "rule_assessments",
  "direction",
  "title",
  "scope",
  "reason",
  "intent_evidence",
  "acknowledgement",
  "worktree_name",
]);

function invalidAssessment(detail: string): never {
  throw new Error(`Invalid assessment: ${detail}`);
}

function rejectUnknownAssessmentFields(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      const expected = Array.from(allowed, (name) => `\`${name}\``).join(", ");
      invalidAssessment(`unknown field \`${key}\`, expected one of ${expected}`);
    }
  }
}

function parseRuleAssessment(value: unknown): RuleAssessment {
  if (!isPlainObject(value)) {
    invalidAssessment("expected an object for rule_assessment");
  }
  rejectUnknownAssessmentFields(value, RULE_ASSESSMENT_KEYS);
  if (typeof value.rule_id !== "string") {
    invalidAssessment("expected a string for rule_assessment.rule_id");
  }
  if (typeof value.matched !== "boolean") {
    invalidAssessment("expected a boolean for rule_assessment.matched");
  }
  if (typeof value.reason !== "string") {
    invalidAssessment("expected a string for rule_assessment.reason");
  }
  return {
    rule_id: value.rule_id,
    matched: value.matched,
    reason: value.reason,
  };
}

/** Parse an `Assessment` strictly from JSON (`deny_unknown_fields`, matching Rust `serde_json::from_value`). */
export function parseAssessment(value: unknown): Assessment {
  if (!isPlainObject(value)) {
    invalidAssessment("expected an object");
  }
  rejectUnknownAssessmentFields(value, ASSESSMENT_KEYS);
  if (typeof value.decision !== "string") {
    invalidAssessment("expected a string for decision");
  }
  if (!Array.isArray(value.rule_assessments)) {
    invalidAssessment("expected an array for rule_assessments");
  }
  const ruleAssessments = value.rule_assessments.map(parseRuleAssessment);
  if (typeof value.reason !== "string") {
    invalidAssessment("expected a string for reason");
  }
  const title =
    value.title === undefined
      ? ""
      : typeof value.title === "string"
        ? value.title
        : invalidAssessment("expected a string for title");
  const scope =
    value.scope === undefined
      ? ""
      : typeof value.scope === "string"
        ? value.scope
        : invalidAssessment("expected a string for scope");
  const assessment: Assessment = {
    decision: value.decision,
    rule_assessments: ruleAssessments,
    direction: value.direction === undefined ? null : structuredClone(value.direction),
    title,
    scope,
    reason: value.reason,
  };
  if (value.intent_evidence !== undefined && value.intent_evidence !== null) {
    if (typeof value.intent_evidence !== "string") {
      invalidAssessment("expected a string for intent_evidence");
    }
    assessment.intent_evidence = value.intent_evidence;
  }
  if (value.acknowledgement !== undefined && value.acknowledgement !== null) {
    if (typeof value.acknowledgement !== "string") {
      invalidAssessment("expected a string for acknowledgement");
    }
    assessment.acknowledgement = value.acknowledgement;
  }
  if (value.worktree_name !== undefined && value.worktree_name !== null) {
    if (typeof value.worktree_name !== "string") {
      invalidAssessment("expected a string for worktree_name");
    }
    assessment.worktree_name = value.worktree_name;
  }
  return assessment;
}

/** Whether an assessment established implementation intent and a settled target without open design decisions. */
export function directionAllowed(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).length !== 4) return false;
  if (value.implementation_requested !== true) return false;
  if (value.target_basis !== "specified" && value.target_basis !== "existing-standard") {
    return false;
  }
  if (value.requires_design_decision !== false) return false;
  if (typeof value.evidence !== "string") return false;
  const evidence = value.evidence.trim();
  return evidence.length > 0 && charCount(evidence) <= 700;
}

/**
 * Validate an assessment against the enabled rules and turn it into the Engine's outcome. An accept needs a settled
 * direction, a matched enabled rule and intent evidence, and an inferred candidate is accepted only in `auto` mode;
 * otherwise the Decision records that it would have been.
 */
export function assessmentOutcome(
  assessment: Assessment,
  settings: Settings,
  strength: Strength,
): Outcome {
  const enabled: string[] = [];
  for (const rule of settings.policy.rules) {
    if (rule.enabled) {
      enabled.push(rule.id);
    }
  }
  const judged = assessment.rule_assessments;
  const ids = new Set<string>();
  for (const item of judged) {
    ids.add(item.rule_id);
  }
  if (
    judged.length !== enabled.length ||
    ids.size !== judged.length ||
    enabled.some((id) => !ids.has(id))
  ) {
    throw new Error(
      "Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed",
    );
  }
  const matches = judged.filter((item) => item.matched);
  const audit: Json = {
    matches: matches.map((item) => ({ rule_id: item.rule_id, reason: item.reason })),
    rule_assessments: judged.map((item) => ({
      rule_id: item.rule_id,
      matched: item.matched,
      reason: item.reason,
    })),
    direction: assessment.direction === undefined ? null : structuredClone(assessment.direction),
  };
  if (assessment.intent_evidence !== undefined && assessment.intent_evidence.length > 0) {
    audit.intent_evidence = assessment.intent_evidence;
  }
  const said = whySaid(assessment.reason);
  switch (assessment.decision) {
    case "accept":
      break;
    case "ignore":
      return { kind: { kind: "ignore" }, reason: said, audit };
    case "unavailable":
      return { kind: { kind: "unavailable" }, reason: said, audit };
    default:
      throw new Error(
        `Unknown decision ${JSON.stringify(assessment.decision)}; it is accept, ignore or unavailable`,
      );
  }
  if (!directionAllowed(assessment.direction)) {
    return {
      kind: { kind: "ignore" },
      reason: whyCode(reasonCode("directionUnsettled")),
      audit,
    };
  }
  if (matches.length === 0) {
    return {
      kind: { kind: "ignore" },
      reason: whyCode(reasonCode("noRuleMatched")),
      audit,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(audit, "intent_evidence")) {
    throw new Error("Acceptance requires intent_evidence");
  }
  if (strength === "inferred" && settings.eval.mode !== "auto") {
    audit.would_accept = true;
    audit.proposal = {
      title: assessment.title,
      scope: assessment.scope,
      worktree_name: assessment.worktree_name ?? null,
    };
    return {
      kind: { kind: "ignore" },
      reason: whyCode(reasonWith("observed", "text", assessment.reason)),
      audit,
    };
  }
  const accept: Accept = {
    title: assessment.title,
    scope: assessment.scope,
    rules: matches.map((item) => item.rule_id),
  };
  if (assessment.acknowledgement !== undefined && assessment.acknowledgement.length > 0) {
    accept.acknowledgement = assessment.acknowledgement;
  }
  if (assessment.worktree_name !== undefined && assessment.worktree_name.length > 0) {
    accept.name = assessment.worktree_name;
  }
  return { kind: { kind: "accept", accept }, reason: said, audit };
}
