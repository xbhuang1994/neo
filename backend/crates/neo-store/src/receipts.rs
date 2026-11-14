//! Outbox receipts: every message queued for a Channel, kept for good so message ids stay idempotent.

use crate::Store;
use neo_core::ports::{OutboundMessage, ReplyStatus};
use neo_core::time::now_iso;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Why a message was dropped: its conversation can never receive it, or its Source no longer listens to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DropReason {
    /// The conversation can never receive it.
    ChannelGone,
    /// Its Source no longer listens to that conversation.
    ChannelIgnored,
}

/// When and why a message was dropped.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dropped {
    /// When.
    pub at: String,
    /// Why.
    pub reason: DropReason,
}

/// What became of a delivery attempt that ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settled {
    /// It went out.
    Sent,
    /// It can never go out.
    Dropped(DropReason),
}

/// An outbound message from the moment it is queued; delivery attempt counts live on its `reply` effect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    /// The message.
    #[serde(flatten)]
    pub message: OutboundMessage,
    /// What became of it.
    pub status: ReplyStatus,
    /// When it was queued.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_at: Option<String>,
    /// When and why it was dropped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropped: Option<Dropped>,
}

impl Store {
    /// The receipt of a queued message.
    pub fn receipt(&self, id: &str) -> Option<Receipt> {
        self.value("SELECT value FROM outbox WHERE id = ?1", params![id])
    }
    /// Delivery status of a queued message.
    pub fn reply_status(&self, id: &str) -> Option<ReplyStatus> {
        self.receipt(id).map(|receipt| receipt.status)
    }
    /// Pending receipts, oldest first.
    pub fn waiting_receipts(&self) -> Vec<Receipt> {
        self.values("SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid", [])
    }
    /// True if an earlier message for the same ticket and conversation is still pending with fewer than `failures`
    /// consecutive failed `reply` effect attempts.
    pub fn receipt_behind(&self, id: &str, failures: i64) -> bool {
        self.with(|db| {
            db.prepare_cached(
                "SELECT 1 FROM outbox earlier JOIN outbox message ON message.id = ?1
                 LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id
                 WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid AND IFNULL(effect.attempts, 0) < ?2 LIMIT 1",
            )?
            .query_row(params![id, failures], |_| Ok(()))
            .optional()
        })
        .is_some()
    }
    /// Record a new pending receipt; a message id recorded before keeps its original receipt. Returns whether it was new.
    pub fn add_receipt(&self, message: &OutboundMessage) -> bool {
        let receipt = Receipt { message: message.clone(), status: ReplyStatus::Pending, queued_at: Some(now_iso()), dropped: None };
        let json = serde_json::to_string(&receipt).expect("receipts serialize");
        self.with(|db| db.prepare_cached("INSERT OR IGNORE INTO outbox (id, value) VALUES (?1, ?2)")?.execute(params![message.id, json])) > 0
    }
    /// True when a reply for `ticket_id` was queued at or after `since`.
    pub fn replied_since(&self, ticket_id: &str, since: &str) -> bool {
        self.with(|db| {
            db.prepare_cached(
                "SELECT 1 FROM outbox WHERE value ->> '$.ticketId' = ?1 AND value ->> '$.kind' = 'reply' AND value ->> '$.queuedAt' >= ?2 LIMIT 1",
            )?
            .query_row(params![ticket_id, since], |_| Ok(()))
            .optional()
        })
        .is_some()
    }
    /// Mark a pending receipt sent or dropped, recreating the receipt if the message was withdrawn while being sent so
    /// its id cannot be queued again.
    pub fn settle_receipt(&self, message: &OutboundMessage, outcome: Settled) {
        let (status, dropped) = match outcome {
            Settled::Sent => (ReplyStatus::Sent, None),
            Settled::Dropped(reason) => (ReplyStatus::Dropped, Some(Dropped { at: now_iso(), reason })),
        };
        let patch = match &dropped {
            Some(dropped) => serde_json::json!({ "status": status, "dropped": dropped }),
            None => serde_json::json!({ "status": status }),
        };
        let updated = self.with(|db| {
            db.prepare_cached("UPDATE outbox SET value = json_patch(value, ?1) WHERE id = ?2 AND value ->> '$.status' = 'pending'")?
                .execute(params![patch.to_string(), message.id])
        });
        if updated == 0 {
            let receipt = Receipt { message: message.clone(), status, queued_at: None, dropped };
            let json = serde_json::to_string(&receipt).expect("receipts serialize");
            self.with(|db| db.prepare_cached("INSERT OR IGNORE INTO outbox (id, value) VALUES (?1, ?2)")?.execute(params![message.id, json]));
        }
    }
    /// Withdraw a pending message that has not gone out. Returns whether one was waiting and removed.
    pub fn withdraw_receipt(&self, id: &str) -> bool {
        self.with(|db| db.prepare_cached("DELETE FROM outbox WHERE id = ?1 AND value ->> '$.status' = 'pending'")?.execute(params![id])) > 0
    }
}
