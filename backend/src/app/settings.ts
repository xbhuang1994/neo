//! Settings: everything a person configures in the app, validated here and stored as numbered revisions.

import path from "node:path";
import type { AcceptMode } from "../core/index.ts";
import type { Store } from "../store/index.ts";
import type { Kernel, RoleModel } from "./kernel-types.ts";

export type { Kernel, RoleModel };

/** The Source of messages from the app, the web page and a bound WeChat account. */
export const CHAT_SOURCE = "chat";
/** The sender of messages typed into the app or the web page. */
export const WEB_SENDER = "web:local";
/** The conversation of the app and the web page. */
export const WEB_THREAD = "web:main";

/** The default agent runtime. */
export const DEFAULT_KERNEL: Kernel = "antigravity";

/** KV key for the latest saved settings revision number. */
export const SETTINGS_REVISION_KEY = "settings-revision";
/** KV key prefix for saved settings revisions (`settings-version:<revision>`). */
export const SETTINGS_VERSION_PREFIX = "settings-version:";

/** Validation bounds, shared with the settings forms. */
export const limits = {
  /** Longest rule name, in characters. */
  RULE_NAME: 100,
  /** Longest rule instruction, in characters. */
  RULE_INSTRUCTION: 2000,
  /** Shortest and longest Eval timeout, in seconds. */
  EVAL_TIMEOUT_SECONDS: [30, 600] as const,
  /** Fewest and most concurrent workers. */
  MAX_WORKERS: [1, 16] as const,
  /** Longest prepare command, in characters. */
  PREPARE_COMMAND: 4000,
} as const;

/** The kernel's name in settings and API payloads. */
export function kernelAsStr(kernel: Kernel): "antigravity" {
  return kernel;
}

/** Type guard for supported kernels. */
export function isKernel(value: unknown): value is Kernel {
  return value === "antigravity";
}

/** An assessment rule for proactive candidates. */
export interface Rule {
  /** Stable id, `[A-Za-z0-9_-]{1,80}`. */
  id: string;
  /** Display name. */
  name: string;
  /** Whether assessments may match it. */
  enabled: boolean;
  /** What it admits, in words for the assessor. */
  instruction: string;
}

/** A sender on a Source's list. */
export interface Allowed {
  /** The sender's id on its Source. */
  id: string;
  /** A display name (omitted in JSON when absent). */
  name?: string;
}

/** What an admission cell grants. */
export type Admission = "ignore" | "inferred" | "explicit";

/**
 * One receiving scope's row of the admission table. A listed sender who addresses the agent always makes an explicit
 * request and has no cell; an unaddressed message cannot be explicit.
 */
export interface AdmissionRow {
  /** A listed sender who did not address the agent: `inferred` by default. */
  listedUnaddressed?: Admission;
  /** An unlisted sender who addressed the agent: `ignore` by default. */
  unlistedAddressed?: Admission;
  /** An unlisted sender who did not address the agent: `ignore` by default. */
  unlistedUnaddressed?: Admission;
}

/** Who may originate work on one Source. */
export interface SourcePolicy {
  /** The senders whose direct requests are explicit. */
  allowed: Allowed[];
  /** Bots whose messages are inferred candidates at most (omitted in JSON when empty). */
  bots?: Allowed[];
  /** The admission table, by receiving scope (omitted in JSON when empty). */
  admission?: Record<string, AdmissionRow>;
}

/** Rules and senders: what authorizes work. */
export interface PolicyConfig {
  /** The assessment rules. */
  rules: Rule[];
  /** Who may originate work, by Source. */
  sources: Record<string, SourcePolicy>;
}

/** How proactive candidates are assessed. */
export interface EvalConfig {
  /** Whether candidates are assessed and accepted. */
  mode: AcceptMode;
  /** How long an assessment may take, in seconds. */
  timeoutSeconds: number;
}

/** How workers run. */
export interface ExecutorConfig {
  /** How many workers may run at once. */
  maxWorkers: number;
  /** Where ticket directories are created; empty for `<data dir>/work`. */
  directory: string;
  /** A shell command that prepares each ticket's directory; `NEO_AGENT_DIR` names the directory. */
  prepare: string;
  /** The shell that runs `prepare`, such as `pwsh`; the platform's default when absent. */
  prepareShell?: string;
  /** Command names workers may not run. */
  blockedCommands: string[];
}

/**
 * Model choices for Antigravity; `null` follows the runtime's default. Unknown keys are dropped, such as the
 * `advisor` model earlier versions saved.
 */
export interface RoleModels {
  /** The orchestrator, which assesses and routes. */
  eval: RoleModel | null;
  /** The workers. */
  executor: RoleModel | null;
}

/** Model choices keyed by Kernel. */
export type Models = Partial<Record<Kernel, RoleModels>>;

/** Everything a person configures. */
export interface Settings {
  /** Processing is paused: nothing is assessed, launched or sent. */
  paused: boolean;
  /** Whether the independent recovery daemon may automatically repair and restart Neo after prolonged downtime. */
  recoveryMode: boolean;
  /** The agent runtime in use. */
  kernel: Kernel;
  /** What authorizes work. */
  policy: PolicyConfig;
  /** How candidates are assessed. */
  eval: EvalConfig;
  /** How workers run. */
  executor: ExecutorConfig;
  /** Model choices for Antigravity. */
  models: Models;
}

/** Top-level block keys on `Settings`. */
export type SettingsBlockName = keyof Settings;

/** One saved revision of the settings. */
export interface SettingsVersion {
  /** The revision number, from 1. */
  revision: number;
  /** When it was saved. */
  savedAt: string;
  /** Who saved it: `app`, `tool` or `internal`. */
  source: string;
  /** The Policy version it produced. */
  policyVersion: string;
  /** The settings. */
  settings: Settings;
}

const DEFAULT_EVAL_MODE: AcceptMode = "observe";
const DEFAULT_EVAL_TIMEOUT = 120;
const DEFAULT_MAX_WORKERS = 3;

const ID_LIKE_RE = /^[A-Za-z0-9_-]+$/;
const SOURCE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const COMMAND_NAME_RE = /^[A-Za-z0-9._-]+$/;

const SETTINGS_KEYS = new Set<string>(["paused", "recoveryMode", "kernel", "policy", "eval", "executor", "models"]);
const POLICY_KEYS = new Set<string>(["rules", "sources"]);
const RULE_KEYS = new Set<string>(["id", "name", "enabled", "instruction"]);
const SOURCE_POLICY_KEYS = new Set<string>(["allowed", "bots", "admission"]);
const ALLOWED_KEYS = new Set<string>(["id", "name"]);
const ADMISSION_ROW_KEYS = new Set<string>([
  "listedUnaddressed",
  "unlistedAddressed",
  "unlistedUnaddressed",
]);
const EVAL_KEYS = new Set<string>(["mode", "timeoutSeconds"]);
const EXECUTOR_KEYS = new Set<string>([
  "maxWorkers",
  "directory",
  "prepare",
  "prepareShell",
  "blockedCommands",
]);
const ROLE_MODEL_KEYS = new Set<string>(["provider", "model"]);

const ACCEPT_MODES = new Set<string>(["off", "observe", "auto"]);
const ADMISSIONS = new Set<string>(["ignore", "inferred", "explicit"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setProp<T>(target: Record<string, T>, key: string, value: T): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

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

function eqIgnoreAsciiCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let ca = a.charCodeAt(i);
    let cb = b.charCodeAt(i);
    if (ca === cb) continue;
    if (ca >= 65 && ca <= 90) ca += 32;
    if (cb >= 65 && cb <= 90) cb += 32;
    if (ca !== cb) return false;
  }
  return true;
}

function invalidSettings(detail: string): never {
  throw new Error(`Invalid settings: ${detail}`);
}

function rejectUnknownFields(obj: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      const expected = Array.from(allowed, (name) => `\`${name}\``).join(", ");
      invalidSettings(`unknown field \`${key}\`, expected one of ${expected}`);
    }
  }
}

function expectObject(value: unknown, what: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    invalidSettings(`expected an object for ${what}`);
  }
  return value;
}

function expectString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    invalidSettings(`expected a string for ${what}`);
  }
  return value;
}

function expectBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    invalidSettings(`expected a boolean for ${what}`);
  }
  return value;
}

function expectU32(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    invalidSettings(`expected a non-negative integer for ${what}`);
  }
  return value;
}

function expectArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    invalidSettings(`expected an array for ${what}`);
  }
  return value;
}

function parseAdmission(value: unknown, what: string): Admission {
  if (typeof value !== "string" || !ADMISSIONS.has(value)) {
    invalidSettings(`unknown variant ${JSON.stringify(value)} for ${what}, expected \`ignore\`, \`inferred\`, or \`explicit\``);
  }
  return value as Admission;
}

function parseAcceptMode(value: unknown): AcceptMode {
  if (typeof value !== "string" || !ACCEPT_MODES.has(value)) {
    invalidSettings(`unknown variant ${JSON.stringify(value)} for eval.mode, expected \`off\`, \`observe\`, or \`auto\``);
  }
  return value as AcceptMode;
}

function parseKernel(value: unknown, what: string): Kernel {
  if (!isKernel(value)) {
    invalidSettings(`unknown variant ${JSON.stringify(value)} for ${what}, expected \`antigravity\``);
  }
  return value;
}

function parseRule(value: unknown): Rule {
  const obj = expectObject(value, "rule");
  rejectUnknownFields(obj, RULE_KEYS);
  if (obj.id === undefined) invalidSettings("missing field `id`");
  if (obj.name === undefined) invalidSettings("missing field `name`");
  if (obj.enabled === undefined) invalidSettings("missing field `enabled`");
  if (obj.instruction === undefined) invalidSettings("missing field `instruction`");
  return {
    id: expectString(obj.id, "rule.id"),
    name: expectString(obj.name, "rule.name"),
    enabled: expectBoolean(obj.enabled, "rule.enabled"),
    instruction: expectString(obj.instruction, "rule.instruction"),
  };
}

function parseAllowed(value: unknown): Allowed {
  const obj = expectObject(value, "allowed sender");
  rejectUnknownFields(obj, ALLOWED_KEYS);
  if (obj.id === undefined) invalidSettings("missing field `id`");
  const entry: Allowed = { id: expectString(obj.id, "allowed.id") };
  if (obj.name !== undefined && obj.name !== null) {
    entry.name = expectString(obj.name, "allowed.name");
  }
  return entry;
}

function parseAdmissionRow(value: unknown): AdmissionRow {
  const obj = expectObject(value, "admission row");
  rejectUnknownFields(obj, ADMISSION_ROW_KEYS);
  const row: AdmissionRow = {};
  if (obj.listedUnaddressed !== undefined && obj.listedUnaddressed !== null) {
    row.listedUnaddressed = parseAdmission(obj.listedUnaddressed, "admission.listedUnaddressed");
  }
  if (obj.unlistedAddressed !== undefined && obj.unlistedAddressed !== null) {
    row.unlistedAddressed = parseAdmission(obj.unlistedAddressed, "admission.unlistedAddressed");
  }
  if (obj.unlistedUnaddressed !== undefined && obj.unlistedUnaddressed !== null) {
    row.unlistedUnaddressed = parseAdmission(obj.unlistedUnaddressed, "admission.unlistedUnaddressed");
  }
  return row;
}

function parseSourcePolicy(value: unknown): SourcePolicy {
  const obj = expectObject(value, "source policy");
  rejectUnknownFields(obj, SOURCE_POLICY_KEYS);
  const allowed =
    obj.allowed === undefined ? [] : expectArray(obj.allowed, "source.allowed").map(parseAllowed);
  const policy: SourcePolicy = { allowed };
  if (obj.bots !== undefined) {
    const bots = expectArray(obj.bots, "source.bots").map(parseAllowed);
    if (bots.length > 0) {
      policy.bots = bots;
    }
  }
  if (obj.admission !== undefined) {
    const rawAdmission = expectObject(obj.admission, "source.admission");
    const keys = Object.keys(rawAdmission).sort(compareCodePoints);
    if (keys.length > 0) {
      const admission: Record<string, AdmissionRow> = {};
      for (const k of keys) {
        setProp(admission, k, parseAdmissionRow(rawAdmission[k]));
      }
      policy.admission = admission;
    }
  }
  return policy;
}

function parsePolicyConfig(value: unknown): PolicyConfig {
  const obj = expectObject(value, "policy");
  rejectUnknownFields(obj, POLICY_KEYS);
  const rules =
    obj.rules === undefined ? defaultRules() : expectArray(obj.rules, "policy.rules").map(parseRule);
  let sources: Record<string, SourcePolicy>;
  if (obj.sources === undefined) {
    sources = defaultSources();
  } else {
    const rawSources = expectObject(obj.sources, "policy.sources");
    const keys = Object.keys(rawSources).sort(compareCodePoints);
    sources = {};
    for (const k of keys) {
      setProp(sources, k, parseSourcePolicy(rawSources[k]));
    }
  }
  return { rules, sources };
}

function parseEvalConfig(value: unknown): EvalConfig {
  const obj = expectObject(value, "eval");
  rejectUnknownFields(obj, EVAL_KEYS);
  return {
    mode: obj.mode === undefined ? DEFAULT_EVAL_MODE : parseAcceptMode(obj.mode),
    timeoutSeconds:
      obj.timeoutSeconds === undefined
        ? DEFAULT_EVAL_TIMEOUT
        : expectU32(obj.timeoutSeconds, "eval.timeoutSeconds"),
  };
}

function parseExecutorConfig(value: unknown): ExecutorConfig {
  const obj = expectObject(value, "executor");
  rejectUnknownFields(obj, EXECUTOR_KEYS);
  const config: ExecutorConfig = {
    maxWorkers:
      obj.maxWorkers === undefined
        ? DEFAULT_MAX_WORKERS
        : expectU32(obj.maxWorkers, "executor.maxWorkers"),
    directory: obj.directory === undefined ? "" : expectString(obj.directory, "executor.directory"),
    prepare: obj.prepare === undefined ? "" : expectString(obj.prepare, "executor.prepare"),
    blockedCommands:
      obj.blockedCommands === undefined
        ? []
        : expectArray(obj.blockedCommands, "executor.blockedCommands").map((item) =>
            expectString(item, "executor.blockedCommands[]"),
          ),
  };
  if (obj.prepareShell !== undefined && obj.prepareShell !== null) {
    config.prepareShell = expectString(obj.prepareShell, "executor.prepareShell");
  }
  return config;
}

function parseRoleModel(value: unknown): RoleModel {
  const obj = expectObject(value, "model");
  rejectUnknownFields(obj, ROLE_MODEL_KEYS);
  if (obj.provider === undefined) invalidSettings("missing field `provider`");
  if (obj.model === undefined) invalidSettings("missing field `model`");
  return {
    provider: expectString(obj.provider, "model.provider"),
    model: expectString(obj.model, "model.model"),
  };
}

/** Unknown keys on `RoleModels` (such as legacy `advisor`) are dropped without error. */
function parseRoleModels(value: unknown): RoleModels {
  const obj = expectObject(value, "role models");
  return {
    eval: obj.eval === undefined || obj.eval === null ? null : parseRoleModel(obj.eval),
    executor:
      obj.executor === undefined || obj.executor === null ? null : parseRoleModel(obj.executor),
  };
}

function parseModels(value: unknown): Models {
  const obj = expectObject(value, "models");
  const keys = Object.keys(obj).sort(compareCodePoints);
  const models: Models = {};
  for (const k of keys) {
    const kernel = parseKernel(k, "models key");
    models[kernel] = parseRoleModels(obj[k]);
  }
  return models;
}

/** Deserializes raw JSON into `Settings` without normalizing or validating bounds. */
function deserializeSettings(value: unknown): Settings {
  const obj = expectObject(value, "settings");
  rejectUnknownFields(obj, SETTINGS_KEYS);
  return {
    paused: obj.paused === undefined ? false : expectBoolean(obj.paused, "paused"),
    recoveryMode: obj.recoveryMode === undefined ? true : expectBoolean(obj.recoveryMode, "recoveryMode"),
    kernel: obj.kernel === undefined ? DEFAULT_KERNEL : parseKernel(obj.kernel, "kernel"),
    policy: obj.policy === undefined ? defaultPolicyConfig() : parsePolicyConfig(obj.policy),
    eval: obj.eval === undefined ? defaultEvalConfig() : parseEvalConfig(obj.eval),
    executor:
      obj.executor === undefined ? defaultExecutorConfig() : parseExecutorConfig(obj.executor),
    models: obj.models === undefined ? {} : parseModels(obj.models),
  };
}

/** Default assessment rules. */
export function defaultRules(): Rule[] {
  return [
    {
      id: "copy",
      name: "Copy fixes",
      enabled: true,
      instruction:
        "Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.",
    },
    {
      id: "visual",
      name: "Visual fixes",
      enabled: true,
      instruction:
        "Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.",
    },
  ];
}

/** Default per-Source authorization table. */
export function defaultSources(): Record<string, SourcePolicy> {
  return {
    [CHAT_SOURCE]: {
      allowed: [{ id: WEB_SENDER }],
    },
  };
}

/** Default `PolicyConfig`. */
export function defaultPolicyConfig(): PolicyConfig {
  return {
    rules: defaultRules(),
    sources: defaultSources(),
  };
}

/** Default `EvalConfig`. */
export function defaultEvalConfig(): EvalConfig {
  return {
    mode: DEFAULT_EVAL_MODE,
    timeoutSeconds: DEFAULT_EVAL_TIMEOUT,
  };
}

/** Default `ExecutorConfig`. */
export function defaultExecutorConfig(): ExecutorConfig {
  return {
    maxWorkers: DEFAULT_MAX_WORKERS,
    directory: "",
    prepare: "",
    blockedCommands: [],
  };
}

/** Default `RoleModels` (all roles following runtime defaults). */
export function defaultRoleModels(): RoleModels {
  return {
    eval: null,
    executor: null,
  };
}

/** Default `Settings`. */
export function defaultSettings(): Settings {
  return {
    paused: false,
    recoveryMode: true,
    kernel: DEFAULT_KERNEL,
    policy: defaultPolicyConfig(),
    eval: defaultEvalConfig(),
    executor: defaultExecutorConfig(),
    models: {},
  };
}

function cloneAllowed(entry: Allowed): Allowed {
  return entry.name !== undefined ? { id: entry.id, name: entry.name } : { id: entry.id };
}

function cloneAdmissionRow(row: AdmissionRow): AdmissionRow {
  const out: AdmissionRow = {};
  if (row.listedUnaddressed !== undefined) out.listedUnaddressed = row.listedUnaddressed;
  if (row.unlistedAddressed !== undefined) out.unlistedAddressed = row.unlistedAddressed;
  if (row.unlistedUnaddressed !== undefined) out.unlistedUnaddressed = row.unlistedUnaddressed;
  return out;
}

function cloneSourcePolicy(policy: SourcePolicy): SourcePolicy {
  const out: SourcePolicy = {
    allowed: policy.allowed.map(cloneAllowed),
  };
  if (policy.bots !== undefined && policy.bots.length > 0) {
    out.bots = policy.bots.map(cloneAllowed);
  }
  if (policy.admission !== undefined) {
    const keys = Object.keys(policy.admission).sort(compareCodePoints);
    if (keys.length > 0) {
      const admission: Record<string, AdmissionRow> = {};
      for (const k of keys) {
        setProp(admission, k, cloneAdmissionRow(policy.admission[k]));
      }
      out.admission = admission;
    }
  }
  return out;
}

function cloneRoleModel(model: RoleModel): RoleModel {
  return { provider: model.provider, model: model.model };
}

function cloneRoleModels(models: RoleModels): RoleModels {
  return {
    eval: models.eval !== null ? cloneRoleModel(models.eval) : null,
    executor: models.executor !== null ? cloneRoleModel(models.executor) : null,
  };
}

/** Deep-clone `Settings` in canonical wire shape (sorted map keys, omitted empty optional fields). */
export function cloneSettings(settings: Settings): Settings {
  const sources: Record<string, SourcePolicy> = {};
  for (const source of Object.keys(settings.policy.sources).sort(compareCodePoints)) {
    setProp(sources, source, cloneSourcePolicy(settings.policy.sources[source]));
  }
  const models: Models = {};
  for (const kernel of Object.keys(settings.models).sort(compareCodePoints)) {
    const entry = settings.models[kernel as Kernel];
    if (entry !== undefined) {
      models[kernel as Kernel] = cloneRoleModels(entry);
    }
  }
  const executor: ExecutorConfig = {
    maxWorkers: settings.executor.maxWorkers,
    directory: settings.executor.directory,
    prepare: settings.executor.prepare,
    blockedCommands: [...settings.executor.blockedCommands],
  };
  if (settings.executor.prepareShell !== undefined) {
    executor.prepareShell = settings.executor.prepareShell;
  }
  return {
    paused: settings.paused,
    recoveryMode: settings.recoveryMode,
    kernel: settings.kernel,
    policy: {
      rules: settings.policy.rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled,
        instruction: rule.instruction,
      })),
      sources,
    },
    eval: {
      mode: settings.eval.mode,
      timeoutSeconds: settings.eval.timeoutSeconds,
    },
    executor,
    models,
  };
}

function idLike(text: string, max: number): boolean {
  return text.length >= 1 && text.length <= max && ID_LIKE_RE.test(text);
}

function sized(what: string, text: string, max: number): void {
  const length = charCount(text.trim());
  if (length === 0 || length > max) {
    throw new Error(`${what} must have 1 to ${max} characters`);
  }
}

/** Trim the text fields people type and drop empty optional containers. */
export function normalize(settings: Settings): void {
  for (const rule of settings.policy.rules) {
    rule.name = rule.name.trim();
    rule.instruction = rule.instruction.trim();
  }
  for (const policy of Object.values(settings.policy.sources)) {
    for (const entry of policy.allowed) {
      entry.id = entry.id.trim();
      if (entry.name !== undefined) {
        const trimmed = entry.name.trim();
        if (trimmed.length === 0) {
          delete entry.name;
        } else {
          entry.name = trimmed;
        }
      }
    }
    if (policy.bots !== undefined) {
      if (policy.bots.length === 0) {
        delete policy.bots;
      } else {
        for (const entry of policy.bots) {
          entry.id = entry.id.trim();
          if (entry.name !== undefined) {
            const trimmed = entry.name.trim();
            if (trimmed.length === 0) {
              delete entry.name;
            } else {
              entry.name = trimmed;
            }
          }
        }
      }
    }
    if (policy.admission !== undefined && Object.keys(policy.admission).length === 0) {
      delete policy.admission;
    }
  }
  settings.executor.directory = settings.executor.directory.trim();
  if (settings.executor.prepareShell !== undefined) {
    const trimmed = settings.executor.prepareShell.trim();
    if (trimmed.length === 0) {
      delete settings.executor.prepareShell;
    } else {
      settings.executor.prepareShell = trimmed;
    }
  }
  for (const roleModels of Object.values(settings.models)) {
    if (roleModels === undefined) continue;
    if (roleModels.eval !== null) {
      roleModels.eval.provider = roleModels.eval.provider.trim();
      roleModels.eval.model = roleModels.eval.model.trim();
    }
    if (roleModels.executor !== null) {
      roleModels.executor.provider = roleModels.executor.provider.trim();
      roleModels.executor.model = roleModels.executor.model.trim();
    }
  }
}

/** Check every bound; the first problem is thrown in words. */
export function validate(settings: Settings): void {
  const seen = new Set<string>();
  for (const rule of settings.policy.rules) {
    if (!idLike(rule.id, 80)) {
      throw new Error(`Rule id ${JSON.stringify(rule.id)} must be 1 to 80 letters, digits, _ or -`);
    }
    if (seen.has(rule.id)) {
      throw new Error(`Duplicate rule id ${rule.id}`);
    }
    seen.add(rule.id);
    sized("A rule name", rule.name, limits.RULE_NAME);
    sized("A rule instruction", rule.instruction, limits.RULE_INSTRUCTION);
  }
  const sourceNames = Object.keys(settings.policy.sources).sort(compareCodePoints);
  for (const source of sourceNames) {
    const policy = settings.policy.sources[source];
    if (!SOURCE_NAME_RE.test(source)) {
      throw new Error(`Source name ${JSON.stringify(source)} must be lowercase letters, digits and -`);
    }
    const entries = policy.bots !== undefined ? [...policy.allowed, ...policy.bots] : policy.allowed;
    for (const entry of entries) {
      sized("A sender id", entry.id, 200);
      if (entry.name !== undefined && charCount(entry.name) > 100) {
        throw new Error("A sender name must have at most 100 characters");
      }
      if (
        source === CHAT_SOURCE &&
        entry.id !== WEB_SENDER &&
        (!entry.id.startsWith("wechat:") || entry.id.length === "wechat:".length)
      ) {
        throw new Error(
          `A chat sender is ${WEB_SENDER} or wechat:<id>, not ${JSON.stringify(entry.id)}`,
        );
      }
    }
    if (policy.admission !== undefined) {
      for (const row of Object.values(policy.admission)) {
        if (row.listedUnaddressed === "explicit" || row.unlistedUnaddressed === "explicit") {
          throw new Error("A message that does not address the agent cannot be an explicit request");
        }
      }
    }
  }
  const [minTimeout, maxTimeout] = limits.EVAL_TIMEOUT_SECONDS;
  if (
    !Number.isInteger(settings.eval.timeoutSeconds) ||
    settings.eval.timeoutSeconds < minTimeout ||
    settings.eval.timeoutSeconds > maxTimeout
  ) {
    throw new Error(`The assessment timeout must be ${minTimeout} to ${maxTimeout} seconds`);
  }
  const [minWorkers, maxWorkers] = limits.MAX_WORKERS;
  if (
    !Number.isInteger(settings.executor.maxWorkers) ||
    settings.executor.maxWorkers < minWorkers ||
    settings.executor.maxWorkers > maxWorkers
  ) {
    throw new Error(`The number of workers must be ${minWorkers} to ${maxWorkers}`);
  }
  if (settings.executor.directory.length > 0 && !path.isAbsolute(settings.executor.directory)) {
    throw new Error("The ticket directory must be an absolute path, or empty for the default");
  }
  if (charCount(settings.executor.prepare) > limits.PREPARE_COMMAND) {
    throw new Error(`The prepare command must have at most ${limits.PREPARE_COMMAND} characters`);
  }
  for (const name of settings.executor.blockedCommands) {
    const command =
      name.length > 0 && name !== "." && name !== ".." && COMMAND_NAME_RE.test(name);
    if (!command) {
      throw new Error(`${JSON.stringify(name)} is not a command name`);
    }
  }
  for (const models of Object.values(settings.models)) {
    if (models === undefined) continue;
    for (const model of [models.eval, models.executor]) {
      if (model !== null && (model.provider.length === 0 || model.model.length === 0)) {
        throw new Error("A model needs a provider and a model id");
      }
    }
  }
}

/** Parse and validate settings from JSON; unknown keys are refused. */
export function parseSettings(value: unknown): Settings {
  const settings = deserializeSettings(value);
  normalize(settings);
  validate(settings);
  return settings;
}

/**
 * Merge one or more settings blocks onto `base`, then parse, normalize and validate the full `Settings`.
 * Each provided block replaces that block whole; unknown keys are refused.
 */
export function parseBlock(base: Settings, patch: Record<string, unknown>): Settings;
export function parseBlock(base: Settings, name: SettingsBlockName, value: unknown): Settings;
export function parseBlock(
  base: Settings,
  patchOrName: Record<string, unknown> | SettingsBlockName,
  value?: unknown,
): Settings {
  const merged: Record<string, unknown> = { ...cloneSettings(base) };
  if (typeof patchOrName === "string") {
    merged[patchOrName] = value;
  } else {
    if (!isPlainObject(patchOrName)) {
      invalidSettings("expected an object for settings patch");
    }
    for (const key of Object.keys(patchOrName)) {
      setProp(merged, key, patchOrName[key]);
    }
  }
  return parseSettings(merged);
}

/** A kernel's model choices. */
export function modelsOf(settings: Settings, kernel: Kernel): RoleModels {
  const existing = settings.models[kernel];
  return existing !== undefined ? cloneRoleModels(existing) : defaultRoleModels();
}

/** The model choices in use. */
export function roleModels(settings: Settings): RoleModels {
  return modelsOf(settings, settings.kernel);
}

/** The listed sender an actor is, compared without case. */
export function allowedSender(settings: Settings, source: string, id: string): Allowed | undefined {
  const policy = settings.policy.sources[source];
  if (policy === undefined) return undefined;
  return policy.allowed.find((entry) => eqIgnoreAsciiCase(entry.id, id));
}

/** The listed bot an actor is, compared without case. */
export function listedBot(settings: Settings, source: string, id: string): Allowed | undefined {
  const bots = settings.policy.sources[source]?.bots;
  if (bots === undefined) return undefined;
  return bots.find((entry) => eqIgnoreAsciiCase(entry.id, id));
}

/** Put a chat sender on the list, such as the WeChat account a person just bound. Returns whether it was added. */
export function allowChatSender(settings: Settings, id: string): boolean {
  if (allowedSender(settings, CHAT_SOURCE, id) !== undefined) {
    return false;
  }
  let policy = settings.policy.sources[CHAT_SOURCE];
  if (policy === undefined) {
    policy = { allowed: [] };
    settings.policy.sources[CHAT_SOURCE] = policy;
  }
  policy.allowed.push({ id });
  return true;
}

/** Take a chat sender off the list. Returns whether it was there. */
export function disallowChatSender(settings: Settings, id: string): boolean {
  const policy = settings.policy.sources[CHAT_SOURCE];
  if (policy === undefined) return false;
  const before = policy.allowed.length;
  policy.allowed = policy.allowed.filter((entry) => !eqIgnoreAsciiCase(entry.id, id));
  return policy.allowed.length !== before;
}

/** The stored settings: the current ones are the snapshot of the latest revision. */
export class SettingsStore {
  readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  private read(key: string): SettingsVersion | undefined {
    const value = this.store.get<unknown>(key);
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) {
      throw new Error("stored settings match this version's model: expected object");
    }
    if (isPlainObject(value.settings)) {
      const settings = value.settings;
      if (typeof settings.kernel === "string" && settings.kernel !== kernelAsStr(DEFAULT_KERNEL)) {
        settings.kernel = kernelAsStr(DEFAULT_KERNEL);
      }
      delete settings.workerKernel;
      delete settings.providers;
      if (isPlainObject(settings.models)) {
        const models = settings.models;
        const antigravity = kernelAsStr(DEFAULT_KERNEL);
        for (const k of Object.keys(models)) {
          if (k !== antigravity) {
            delete models[k];
          }
        }
        const roles = models[antigravity];
        if (isPlainObject(roles)) {
          for (const role of Object.values(roles)) {
            if (isPlainObject(role)) {
              delete role.thinkingLevel;
            }
          }
        }
      }
    }
    if (
      typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      typeof value.savedAt !== "string" ||
      typeof value.source !== "string" ||
      typeof value.policyVersion !== "string"
    ) {
      throw new Error("stored settings match this version's model: invalid version header");
    }
    return {
      revision: value.revision,
      savedAt: value.savedAt,
      source: value.source,
      policyVersion: value.policyVersion,
      settings: deserializeSettings(value.settings),
    };
  }

  /** The current revision number, or 0 before the first save. */
  revision(): number {
    return this.store.get<number>(SETTINGS_REVISION_KEY) ?? 0;
  }

  /** The current settings; the defaults before the first save. */
  current(): Settings {
    return (
      this.read(`${SETTINGS_VERSION_PREFIX}${this.revision()}`)?.settings ?? defaultSettings()
    );
  }

  /** Save validated settings as the next revision, which becomes current. */
  save(
    settings: Settings,
    source: string,
    policyVersion: string,
    savedAt: string,
  ): SettingsVersion {
    validate(settings);
    return this.store.atomic(() => {
      const version: SettingsVersion = {
        revision: this.revision() + 1,
        savedAt,
        source,
        policyVersion,
        settings: cloneSettings(settings),
      };
      this.store.set(`${SETTINGS_VERSION_PREFIX}${version.revision}`, version);
      this.store.set(SETTINGS_REVISION_KEY, version.revision);
      return version;
    });
  }

  /** Saved revisions, newest first. */
  history(limit: number): SettingsVersion[] {
    const versions: SettingsVersion[] = [];
    for (const key of this.store.keys(SETTINGS_VERSION_PREFIX)) {
      const version = this.read(key);
      if (version !== undefined) {
        versions.push(version);
      }
    }
    versions.sort((a, b) => b.revision - a.revision);
    if (versions.length > limit) {
      versions.length = limit;
    }
    return versions;
  }
}
