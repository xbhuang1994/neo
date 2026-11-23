/**
 * The chat Source: messages typed into the app or the web page, and from a bound WeChat account, as Triggers; replies
 * go back to the conversation they came from.
 */

import { key, nowIso, type Json, type OutboundMessage, type Trigger } from "../core/index.ts";
import { uuid } from "../kernel/index.ts";
import type { AppContext, ChatAttachment, ChatInput, ChatReceipt } from "./context.ts";
import type { Sent } from "./outbox.ts";
import { CHAT_SOURCE, WEB_SENDER, WEB_THREAD } from "./settings.ts";

export type { ChatInput, ChatReceipt };

const VALID_MESSAGE_ID_RE = /^[A-Za-z0-9_.:-]{3,200}$/;

/** Whether `id` is 3 to 200 ASCII word characters, underscores, colons, dots, or dashes. */
export function validMessageId(id: string): boolean {
  return VALID_MESSAGE_ID_RE.test(id);
}

/** A message typed into the app or the web page. */
export function receiveWeb(
  app: AppContext,
  text: string,
  attachments: ChatAttachment[],
  messageId?: string,
): Promise<ChatReceipt> {
  return receiveChat(app, {
    surface: "web",
    messageId: messageId ?? `web:${uuid()}`,
    sender: WEB_SENDER,
    conversation: WEB_THREAD,
    text,
    attachments,
    at: undefined,
  });
}

/** A message from the bound WeChat user (parameter order matches `AppContext.receiveWeChat`). */
export function receiveWeChat(
  app: AppContext,
  messageId: string,
  userId: string,
  text: string,
  attachments: ChatAttachment[],
  at?: string,
): Promise<ChatReceipt> {
  const party = `wechat:${userId}`;
  return receiveChat(app, {
    surface: "wechat",
    messageId,
    sender: party,
    conversation: party,
    text,
    attachments,
    at,
  });
}

/** Show a chat message in the transcript and take it in as a Trigger, once per message id. */
export async function receiveChat(app: AppContext, input: ChatInput): Promise<ChatReceipt> {
  if (!validMessageId(input.messageId)) {
    throw new Error("Invalid chat message ID");
  }
  if (input.sender.length === 0 || input.conversation.length === 0) {
    throw new Error("Chat sender and conversation are required");
  }
  const requestId = `chat:${input.messageId}`;
  const presented = await app.presentChat(
    input.text,
    input.attachments,
    requestId,
    input.surface === "web" ? "web-panel" : "wechat",
  );
  const triggerId = key(["trigger", CHAT_SOURCE, input.messageId]);
  const meta: Json = {
    kind: "chat",
    messageId: input.messageId,
    originalText: input.text,
    surface: input.surface,
    conversation: input.conversation,
  };
  const address: Record<string, string> = {
    surface: input.surface,
    conversation: input.conversation,
    sender: input.sender,
  };
  const trigger: Trigger = {
    id: triggerId,
    source: CHAT_SOURCE,
    threads: [{ source: CHAT_SOURCE, id: input.conversation }],
    actor: { source: CHAT_SOURCE, id: input.sender },
    human: true,
    addressed: "direct",
    at: input.at ?? nowIso(),
    text: presented,
    channel: { source: CHAT_SOURCE, thread: input.conversation, address },
    meta,
  };
  const result = app.passes.receive(trigger);
  return { requestId, triggerId, result };
}

/**
 * Send a reply to the conversation its Channel names: the chat transcript, and for a WeChat conversation the
 * bound account too. The message id makes both idempotent.
 */
export async function chatSend(app: AppContext, message: OutboundMessage): Promise<Sent> {
  const address = message.channel.address;
  const part = (name: string): string =>
    Object.prototype.hasOwnProperty.call(address, name) ? (address[name] ?? "") : "";
  const surface = part("surface");
  const conversation = part("conversation");
  const sender = part("sender");
  const requestId = `chat-reply:${message.id}`;
  if (surface === "web" && conversation === WEB_THREAD && sender === WEB_SENDER) {
    await app.publish(requestId, message.text);
    return "sent";
  }
  if (surface === "wechat" && conversation === sender && sender.startsWith("wechat:")) {
    const userId = sender.slice("wechat:".length);
    await app.publish(requestId, message.text);
    return app.wechatDeliver(message.id, message.text, userId);
  }
  return "gone";
}
