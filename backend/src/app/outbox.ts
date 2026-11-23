//! Reliable outbound messages: each is recorded as a receipt and delivered by a retried `reply` effect, in order per
//! ticket and conversation.

import type { ChannelRef, OutboundMessage, Outbox as OutboxPort, ReplyStatus } from "../core/index.ts";
import { receiptMessage, settledDropped, settledSent, type Store } from "../store/index.ts";
import { FAILURES_BEFORE_ERROR, Failure, REPLY, type Effects } from "./effects.ts";

/** What became of handing a message to its Source. */
export type Sent = "sent" | "gone" | "waiting";

/** The Sources as the Outbox uses them. */
export interface Channels {
  /** Whether the Source is installed and on. */
  enabled(source: string): boolean;
  /** Whether the Source still listens to this conversation. */
  allowed(channel: ChannelRef): boolean;
  /** Send the message idempotently by its id. */
  send(message: OutboundMessage): Promise<Sent> | Sent;
}

/** Persists outbound messages as receipts and delivers them through the effect queue. */
export class Outbox implements OutboxPort {
  private readonly store: Store;
  private readonly effects: Effects;

  /** An Outbox that delivers through `channels`; nothing goes out while `paused` holds. */
  constructor(
    store: Store,
    effects: Effects,
    channels: Channels,
    paused: () => boolean = () => false,
  ) {
    this.store = store;
    this.effects = effects;
    effects.handle(
      REPLY,
      async (_payload, id) => {
        const result = await deliver(store, channels, id);
        if (result === undefined) {
          effects.wakeKind(REPLY);
        }
        return result;
      },
      {
        limit: () => (paused() ? 0 : 4),
        retry: [5_000, 300_000],
      },
    );
  }

  /** Record a receipt and queue its delivery together; a message id recorded before is ignored. */
  send(message: OutboundMessage): void {
    this.store.atomic(() => {
      if (this.store.addReceipt(message)) {
        this.effects.enqueue(REPLY, message.id, {});
      }
    });
  }

  /** Delivery status of a queued message. */
  status(id: string): ReplyStatus | undefined {
    return this.store.replyStatus(id);
  }

  /** Withdraw a message that has not gone out. */
  withdraw(id: string): void {
    this.store.atomic(() => {
      if (this.store.withdrawReceipt(id)) {
        this.effects.cancel(REPLY, id);
      }
    });
  }

  /** Resolves once every message that can go out now has. */
  async sent(): Promise<void> {
    await this.effects.idle(REPLY);
  }

  /**
   * Resolves once message `id` is no longer pending, or no `reply` effect can make progress on it now (or
   * `timeoutMs` elapses when provided).
   */
  async waitFor(id: string, timeoutMs?: number): Promise<void> {
    if (this.store.replyStatus(id) !== "pending") {
      return;
    }
    await this.effects.waitFor(REPLY, id, timeoutMs);
  }
}

async function deliver(store: Store, channels: Channels, id: string): Promise<void | Failure> {
  const receipt = store.receipt(id);
  if (receipt === undefined || receipt.status !== "pending") {
    return undefined;
  }
  const message = receiptMessage(receipt);
  if (!channels.enabled(message.channel.source)) {
    return Failure.later("The Source is off or not installed");
  }
  // A later message of the ticket to the conversation waits behind an earlier one, until that one keeps failing.
  if (store.receiptBehind(id, FAILURES_BEFORE_ERROR)) {
    return Failure.later("An earlier message of this ticket to this conversation waits");
  }
  if (!channels.allowed(message.channel)) {
    store.settleReceipt(message, settledDropped("channelIgnored"));
    return undefined;
  }
  let outcome: Sent;
  try {
    outcome = await channels.send(receiptMessage(message));
  } catch (error) {
    return Failure.from(error);
  }
  switch (outcome) {
    case "waiting":
      return Failure.later("The Source cannot send right now");
    // A conversation that is gone for good settles, so its receipt prevents further tries.
    case "gone":
      store.settleReceipt(message, settledDropped("channelGone"));
      return undefined;
    case "sent":
      store.settleReceipt(message, settledSent());
      return undefined;
  }
}
