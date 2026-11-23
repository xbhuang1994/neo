/**
 * Outbox receipts: every message queued for a Channel, kept for good so message ids stay idempotent.
 */

import type { Database } from "bun:sqlite";
import { nowIso, type OutboundMessage, type ReplyStatus } from "../core/index.ts";

/** Why a message was dropped: its conversation can never receive it, or its Source no longer listens to it. */
export type DropReason = "channelGone" | "channelIgnored";

/** When and why a message was dropped. */
export interface Dropped {
  /** When. */
  at: string;
  /** Why. */
  reason: DropReason;
}

/** What became of a delivery attempt that ended. */
export type Settled =
  | { kind: "sent" }
  | { kind: "dropped"; reason: DropReason };

/** Construct a `Settled` outcome meaning the message went out. */
export function settledSent(): Settled {
  return { kind: "sent" };
}

/** Construct a `Settled` outcome meaning the message can never go out. */
export function settledDropped(reason: DropReason): Settled {
  return { kind: "dropped", reason };
}

/**
 * An outbound message from the moment it is queued; delivery attempt counts live on its `reply` effect.
 *
 * Wire format flattens `OutboundMessage` fields at top level alongside `status`, `queuedAt`, and `dropped`,
 * matching Rust `#[serde(flatten)]` and the SQLite generated columns (`outbox.dropped`, `outbox.pending`).
 */
export interface Receipt extends OutboundMessage {
  /** What became of it. */
  status: ReplyStatus;
  /** When it was queued. */
  queuedAt?: string;
  /** When and why it was dropped. */
  dropped?: Dropped;
}

/** Extract a clean `OutboundMessage` containing only the message wire fields (never leaking receipt metadata). */
export function receiptMessage(message: OutboundMessage): OutboundMessage {
  const out: OutboundMessage = {
    id: message.id,
    channel: {
      source: message.channel.source,
      thread: message.channel.thread,
      address: { ...message.channel.address },
    },
    text: message.text,
    kind: message.kind,
  };
  if (message.ticketId !== undefined) {
    out.ticketId = message.ticketId;
  }
  return out;
}

interface ValueRow {
  value: string;
}

interface HitRow {
  hit: number;
}

const SQL_GET_RECEIPT = "SELECT value FROM outbox WHERE id = ?1";
const SQL_WAITING_RECEIPTS = "SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid";
const SQL_RECEIPT_BEHIND =
  "SELECT 1 AS hit FROM outbox earlier JOIN outbox message ON message.id = ?1 LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid AND IFNULL(effect.attempts, 0) < ?2 LIMIT 1";
const SQL_INSERT_RECEIPT = "INSERT OR IGNORE INTO outbox (id, value) VALUES (?1, ?2)";
const SQL_REPLIED_SINCE =
  "SELECT 1 AS hit FROM outbox WHERE value ->> '$.ticketId' = ?1 AND value ->> '$.kind' = 'reply' AND value ->> '$.queuedAt' >= ?2 LIMIT 1";
const SQL_SETTLE_UPDATE =
  "UPDATE outbox SET value = json_patch(value, ?1) WHERE id = ?2 AND value ->> '$.status' = 'pending'";
const SQL_WITHDRAW = "DELETE FROM outbox WHERE id = ?1 AND value ->> '$.status' = 'pending'";

/** The receipt of a queued message. */
export function getReceipt(db: Database, id: string): Receipt | undefined {
  const row = db.query<ValueRow, [string]>(SQL_GET_RECEIPT).get(id);
  return row !== null ? (JSON.parse(row.value) as Receipt) : undefined;
}

/** Delivery status of a queued message. */
export function getReplyStatus(db: Database, id: string): ReplyStatus | undefined {
  return getReceipt(db, id)?.status;
}

/** Pending receipts, oldest first. */
export function getWaitingReceipts(db: Database): Receipt[] {
  const rows = db.query<ValueRow, []>(SQL_WAITING_RECEIPTS).all();
  const out = new Array<Receipt>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    out[i] = JSON.parse(rows[i].value) as Receipt;
  }
  return out;
}

/**
 * True if an earlier message for the same ticket and conversation is still pending with fewer than `failures`
 * consecutive failed `reply` effect attempts.
 */
export function isReceiptBehind(db: Database, id: string, failures: number): boolean {
  return db.query<HitRow, [string, number]>(SQL_RECEIPT_BEHIND).get(id, failures) !== null;
}

/** Record a new pending receipt; a message id recorded before keeps its original receipt. Returns whether it was new. */
export function addReceipt(db: Database, message: OutboundMessage): boolean {
  const receipt: Receipt = {
    ...receiptMessage(message),
    status: "pending",
    queuedAt: nowIso(),
  };
  return db.query(SQL_INSERT_RECEIPT).run(message.id, JSON.stringify(receipt)).changes > 0;
}

/** Record a message that already went out directly (such as a media upload), queued at least as recently as `since`. */
export function recordSentReceipt(db: Database, message: OutboundMessage, since: string): void {
  const now = nowIso();
  const queuedAt = now >= since ? now : since;
  const receipt: Receipt = {
    ...receiptMessage(message),
    status: "sent",
    queuedAt,
  };
  db.query(SQL_INSERT_RECEIPT).run(message.id, JSON.stringify(receipt));
}

/** True when a reply for `ticketId` was queued at or after `since`. */
export function hasRepliedSince(db: Database, ticketId: string, since: string): boolean {
  return db.query<HitRow, [string, string]>(SQL_REPLIED_SINCE).get(ticketId, since) !== null;
}

/**
 * Mark a pending receipt sent or dropped, recreating the receipt if the message was withdrawn while being sent so
 * its id cannot be queued again.
 */
export function settleReceipt(db: Database, message: OutboundMessage, outcome: Settled): void {
  const status: ReplyStatus = outcome.kind === "sent" ? "sent" : "dropped";
  const dropped: Dropped | undefined =
    outcome.kind === "dropped" ? { at: nowIso(), reason: outcome.reason } : undefined;
  const patch = dropped !== undefined ? JSON.stringify({ status, dropped }) : JSON.stringify({ status });
  const updated = db.query(SQL_SETTLE_UPDATE).run(patch, message.id).changes;
  if (updated === 0) {
    const receipt: Receipt =
      dropped !== undefined
        ? { ...receiptMessage(message), status, dropped }
        : { ...receiptMessage(message), status };
    db.query(SQL_INSERT_RECEIPT).run(message.id, JSON.stringify(receipt));
  }
}

/** Withdraw a pending message that has not gone out. Returns whether one was waiting and removed. */
export function withdrawReceipt(db: Database, id: string): boolean {
  return db.query(SQL_WITHDRAW).run(id).changes > 0;
}
