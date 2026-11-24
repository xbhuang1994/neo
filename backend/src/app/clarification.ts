//! Zero-migration per-thread pre-routing clarification state backed by the SQLite `kv` table.

import { parseIso } from "../core/index.ts";
import { isRecord } from "../kernel/index.ts";
import type { Store } from "../store/index.ts";
import { charCount } from "./cards.ts";

/** How long a pending clarification stays valid before expiring automatically (30 minutes). */
export const CLARIFICATION_TTL_MS = 30 * 60 * 1000;

/** Maximum unconsumed turns a pending clarification may survive before auto-expiring (anti-stickiness). */
export const CLARIFICATION_MAX_TURNS = 2;

const CLARIFICATION_PREFIX = "clarification:";
const SHORT_CONFIRMATION_RE = /^([1-4]|第[一二三四1-4]|是|好|对|嗯|就它|那个|新开|新建)/;
const VALID_ACTIONS = new Set<ClarificationOption["action"]>(["sidecar", "attach", "accept", "stop"]);

export interface ClarificationOption {
  key: string; // "1" | "2" | "3" | "new"
  label: string;
  action: "sidecar" | "attach" | "accept" | "stop";
  ticketId?: string;
}

export interface PendingClarification {
  id: string;
  threadKey: string;
  originTriggerId: string;
  originBatchIds: string[];
  originText: string;
  question: string;
  options: ClarificationOption[];
  createdAt: string;
  expiresAt: string;
  turnsSeen: number;
}

/** KV storage key for one thread's pending clarification. */
export function clarificationKey(threadKey: string): string {
  return `${CLARIFICATION_PREFIX}${threadKey}`;
}

function parseOption(value: unknown): ClarificationOption | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.key !== "string" || typeof value.label !== "string" || typeof value.action !== "string") {
    return undefined;
  }
  if (!VALID_ACTIONS.has(value.action as ClarificationOption["action"])) {
    return undefined;
  }
  const option: ClarificationOption = {
    key: value.key,
    label: value.label,
    action: value.action as ClarificationOption["action"],
  };
  if (value.ticketId !== undefined) {
    if (typeof value.ticketId !== "string") {
      return undefined;
    }
    option.ticketId = value.ticketId;
  }
  return option;
}

function parsePendingClarification(value: unknown): PendingClarification | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.threadKey !== "string" ||
    typeof value.originTriggerId !== "string" ||
    !Array.isArray(value.originBatchIds) ||
    typeof value.originText !== "string" ||
    typeof value.question !== "string" ||
    !Array.isArray(value.options) ||
    typeof value.createdAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.turnsSeen !== "number" ||
    !Number.isFinite(value.turnsSeen)
  ) {
    return undefined;
  }
  const originBatchIds: string[] = [];
  for (let i = 0; i < value.originBatchIds.length; i++) {
    const id = value.originBatchIds[i];
    if (typeof id !== "string") {
      return undefined;
    }
    originBatchIds.push(id);
  }
  const options: ClarificationOption[] = [];
  for (let i = 0; i < value.options.length; i++) {
    const opt = parseOption(value.options[i]);
    if (opt === undefined) {
      return undefined;
    }
    options.push(opt);
  }
  return {
    id: value.id,
    threadKey: value.threadKey,
    originTriggerId: value.originTriggerId,
    originBatchIds,
    originText: value.originText,
    question: value.question,
    options,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    turnsSeen: value.turnsSeen,
  };
}

/**
 * Load a thread's pending clarification if still valid.
 * Automatically deletes and returns `undefined` when malformed, expired past `expiresAt`,
 * or `turnsSeen >= CLARIFICATION_MAX_TURNS`.
 */
export function loadClarification(
  store: Store,
  threadKey: string,
  nowMs = Date.now(),
): PendingClarification | undefined {
  const key = clarificationKey(threadKey);
  const raw = store.get<unknown>(key);
  if (raw === undefined) {
    return undefined;
  }
  const record = parsePendingClarification(raw);
  if (record === undefined) {
    store.delete(key);
    return undefined;
  }
  const expiresMs = parseIso(record.expiresAt);
  if (expiresMs === undefined || nowMs >= expiresMs || record.turnsSeen >= CLARIFICATION_MAX_TURNS) {
    store.delete(key);
    return undefined;
  }
  return record;
}

/** Persist a pending clarification for its thread. */
export function saveClarification(store: Store, record: PendingClarification): void {
  const copy: PendingClarification = {
    id: record.id,
    threadKey: record.threadKey,
    originTriggerId: record.originTriggerId,
    originBatchIds: [...record.originBatchIds],
    originText: record.originText,
    question: record.question,
    options: record.options.map((opt) =>
      opt.ticketId !== undefined
        ? { key: opt.key, label: opt.label, action: opt.action, ticketId: opt.ticketId }
        : { key: opt.key, label: opt.label, action: opt.action },
    ),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    turnsSeen: record.turnsSeen,
  };
  store.set(clarificationKey(record.threadKey), copy);
}

/**
 * Consume a thread's pending clarification only if it is still valid and its `id` matches `clarificationId`.
 * Deletes the stored record on match and returns it; otherwise leaves any valid mismatched record intact.
 */
export function consumeClarification(
  store: Store,
  threadKey: string,
  clarificationId: string,
  nowMs = Date.now(),
): PendingClarification | undefined {
  return store.atomic(() => {
    const current = loadClarification(store, threadKey, nowMs);
    if (current === undefined || current.id !== clarificationId) {
      return undefined;
    }
    store.delete(clarificationKey(threadKey));
    return current;
  });
}

/**
 * Increment `turnsSeen` on a valid pending clarification; delete immediately once it reaches
 * `CLARIFICATION_MAX_TURNS`, otherwise write the updated counter back.
 */
export function bumpClarificationTurn(
  store: Store,
  threadKey: string,
  nowMs = Date.now(),
): void {
  store.atomic(() => {
    const current = loadClarification(store, threadKey, nowMs);
    if (current === undefined) {
      return;
    }
    const nextTurns = current.turnsSeen + 1;
    if (nextTurns >= CLARIFICATION_MAX_TURNS) {
      store.delete(clarificationKey(threadKey));
      return;
    }
    saveClarification(store, { ...current, turnsSeen: nextTurns });
  });
}

/** Delete any pending clarification stored for `threadKey`. */
export function clearClarification(store: Store, threadKey: string): void {
  store.delete(clarificationKey(threadKey));
}

/**
 * Whether `text` looks like a short confirmation or selection reply to a pending clarification
 * (non-empty after trimming whitespace, and either at most 6 characters or matching a leading selection cue).
 */
export function isShortConfirmation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (charCount(trimmed) <= 6) {
    return true;
  }
  return SHORT_CONFIRMATION_RE.test(trimmed);
}
