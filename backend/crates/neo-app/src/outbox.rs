//! Reliable outbound messages: each is recorded as a receipt and delivered by a retried `reply` effect, in order per
//! ticket and conversation.

use crate::effects::{Effects, Failure, Options, FAILURES_BEFORE_ERROR, REPLY};
use neo_core::model::ChannelRef;
use neo_core::ports::{OutboundMessage, Outbox as OutboxPort, ReplyStatus};
use neo_store::{DropReason, Settled, Store};
use serde_json::json;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// What became of handing a message to its Source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sent {
    /// It went out.
    Sent,
    /// Its conversation can never receive it.
    Gone,
    /// Its Source cannot send right now.
    Waiting,
}

/// The Sources as the Outbox uses them.
pub trait Channels: Send + Sync {
    /// Whether the Source is installed and on.
    fn enabled(&self, source: &str) -> bool;
    /// Whether the Source still listens to this conversation.
    fn allowed(&self, channel: &ChannelRef) -> bool;
    /// Send the message idempotently by its id.
    fn send(&self, message: OutboundMessage) -> Pin<Box<dyn Future<Output = Result<Sent, String>> + Send + '_>>;
}

/// Persists outbound messages as receipts and delivers them through the effect queue.
pub struct Outbox {
    store: Arc<Store>,
    effects: Arc<Effects>,
}

impl Outbox {
    /// An Outbox that delivers through `channels`; nothing goes out while `paused` holds.
    pub fn new(store: Arc<Store>, effects: Arc<Effects>, channels: Arc<dyn Channels>, paused: Arc<dyn Fn() -> bool + Send + Sync>) -> Arc<Outbox> {
        let deliver_store = store.clone();
        let wake_effects = Arc::downgrade(&effects);
        effects.handle(
            REPLY,
            Arc::new(move |_payload, id| {
                let (store, channels, effects) = (deliver_store.clone(), channels.clone(), wake_effects.clone());
                Box::pin(async move {
                    let result = deliver(&store, channels.as_ref(), &id).await;
                    if result.is_ok() {
                        if let Some(effects) = effects.upgrade() {
                            effects.wake_kind(REPLY);
                        }
                    }
                    result
                })
            }),
            Options { limit: Arc::new(move || if paused() { 0 } else { 4 }), retry: (5_000, 300_000), ..Options::default() },
        );
        Arc::new(Outbox { store, effects })
    }

    /// Resolves once every message that can go out now has.
    pub async fn sent(&self) {
        self.effects.idle(Some(REPLY)).await;
    }

    /// Resolves once message `id` is no longer pending, or no `reply` effect is running or able to start now.
    pub async fn wait_for(&self, id: &str) {
        loop {
            let finished = self.effects.finished.notified();
            tokio::pin!(finished);
            // Register before looking, so an effect that ends in between is not missed.
            finished.as_mut().enable();
            if self.store.reply_status(id) != Some(ReplyStatus::Pending) {
                return;
            }
            self.effects.dispatch();
            let active = self.effects.running().iter().any(|(kind, _)| kind == REPLY);
            if !active {
                return;
            }
            finished.await;
        }
    }
}

async fn deliver(store: &Store, channels: &dyn Channels, id: &str) -> Result<(), Failure> {
    let Some(receipt) = store.receipt(id).filter(|receipt| receipt.status == ReplyStatus::Pending) else { return Ok(()) };
    let message = receipt.message;
    if !channels.enabled(&message.channel.source) {
        return Err(Failure::Later("The Source is off or not installed".into()));
    }
    // A later message of the ticket to the conversation waits behind an earlier one, until that one keeps failing.
    if store.receipt_behind(id, FAILURES_BEFORE_ERROR) {
        return Err(Failure::Later("An earlier message of this ticket to this conversation waits".into()));
    }
    if !channels.allowed(&message.channel) {
        store.settle_receipt(&message, Settled::Dropped(DropReason::ChannelIgnored));
        return Ok(());
    }
    match channels.send(message.clone()).await? {
        Sent::Waiting => Err(Failure::Later("The Source cannot send right now".into())),
        // A conversation that is gone for good settles, so its receipt prevents further tries.
        Sent::Gone => {
            store.settle_receipt(&message, Settled::Dropped(DropReason::ChannelGone));
            Ok(())
        }
        Sent::Sent => {
            store.settle_receipt(&message, Settled::Sent);
            Ok(())
        }
    }
}

impl OutboxPort for Outbox {
    /// Record a receipt and queue its delivery together; a message id recorded before is ignored.
    fn send(&self, message: OutboundMessage) {
        let _: Result<(), ()> = self.store.atomic(|| {
            if self.store.add_receipt(&message) {
                self.effects.enqueue(REPLY, &message.id, &json!({}));
            }
            Ok(())
        });
    }
    fn status(&self, id: &str) -> Option<ReplyStatus> {
        self.store.reply_status(id)
    }
    fn withdraw(&self, id: &str) {
        let _: Result<(), ()> = self.store.atomic(|| {
            if self.store.withdraw_receipt(id) {
                self.effects.cancel(REPLY, id);
            }
            Ok(())
        });
    }
}
