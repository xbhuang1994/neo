//! Strict thread isolation, 1-to-1 cross-surface allowlisting, ticket authorization checks, and artifact recording.

import { threadKey, type Ticket, type Trigger } from "../core/index.ts";
import type { Store } from "../store/index.ts";
import type { AppContext } from "./context.ts";
import { CHAT_SOURCE, WEB_SENDER, WEB_THREAD, allowedSender } from "./settings.ts";
import { clip } from "./text.ts";

const WECHAT_PREFIX = "wechat:";
const WEB_THREAD_KEY = `${CHAT_SOURCE}:${WEB_THREAD}`;
const LINE_BREAK_OR_TAB_RE = /[\r\n\t]+/g;
const CONTROL_AND_BIDI_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const UNSAFE_ARTIFACT_CHARS_RE = /[<>:"|?*]/g;
const WHITESPACE_RUN_RE = /\p{White_Space}+/gu;
const DOTS_ONLY_RE = /^\.+$/;
const MAX_ARTIFACT_NAME_CHARS = 180;

/** Threads a trigger is authorized to inspect for historical ticket recall and read-only lookups. */
export interface AccessibleScope {
  primaryThread: string;
  threads: Set<string>;
  crossSurfaceAllowed: boolean;
}

interface StrictCrossSurfacePair {
  webSender: string;
  wechatSender: string;
  webThread: string;
  wechatThread: string;
}

/**
 * Resolve the single strictly paired `web:local` <-> `wechat:<boundUserId>` identity, or `null` whenever
 * WeChat is unbound, `web:local` is missing, or more than one `wechat:` sender appears in `chat.allowed`.
 */
function strictCrossSurfacePair(app: AppContext): StrictCrossSurfacePair | null {
  const account = app.wechatAccount();
  if (account === null || account.userId.length === 0) {
    return null;
  }
  const chatPolicy = app.settings().policy.sources[CHAT_SOURCE];
  if (chatPolicy === undefined) {
    return null;
  }
  const expectedWeChatSender = `${WECHAT_PREFIX}${account.userId}`;
  let hasWeb = false;
  let wechatCount = 0;
  let matchedWeChat = false;
  for (let i = 0; i < chatPolicy.allowed.length; i++) {
    const id = chatPolicy.allowed[i].id;
    if (id === WEB_SENDER) {
      hasWeb = true;
    } else if (id.toLowerCase().startsWith(WECHAT_PREFIX)) {
      wechatCount += 1;
      if (id === expectedWeChatSender) {
        matchedWeChat = true;
      }
    }
  }
  if (!hasWeb || !matchedWeChat || wechatCount !== 1) {
    return null;
  }
  return {
    webSender: WEB_SENDER,
    wechatSender: expectedWeChatSender,
    webThread: WEB_THREAD_KEY,
    wechatThread: `${CHAT_SOURCE}:${expectedWeChatSender}`,
  };
}

/**
 * Compute the thread keys accessible to `trigger`.
 * Always includes `primaryThread = threadKey(trigger.threads[0])`.
 * Only adds the paired surface thread (exact 1-to-1 `chat:web:main` <-> `chat:wechat:<boundUserId>`,
 * never wildcard `chat:*`) when all 5 security preconditions hold simultaneously.
 */
export function accessibleThreads(
  app: AppContext,
  trigger: Trigger,
  crossSurfaceEnabled = process.env.NEO_RECALL_CROSS_SURFACE === "1",
): AccessibleScope {
  if (trigger.threads.length === 0) {
    return { primaryThread: "", threads: new Set<string>(), crossSurfaceAllowed: false };
  }
  const primaryThread = threadKey(trigger.threads[0]);
  const threads = new Set<string>([primaryThread]);

  if (!crossSurfaceEnabled) {
    return { primaryThread, threads, crossSurfaceAllowed: false };
  }
  if (trigger.source !== CHAT_SOURCE || trigger.addressed !== "direct") {
    return { primaryThread, threads, crossSurfaceAllowed: false };
  }
  if (trigger.actor.source !== CHAT_SOURCE) {
    return { primaryThread, threads, crossSurfaceAllowed: false };
  }
  if (allowedSender(app.settings(), CHAT_SOURCE, trigger.actor.id) === undefined) {
    return { primaryThread, threads, crossSurfaceAllowed: false };
  }
  const pair = strictCrossSurfacePair(app);
  if (pair === null) {
    return { primaryThread, threads, crossSurfaceAllowed: false };
  }
  if (primaryThread === pair.webThread && trigger.actor.id === pair.webSender) {
    threads.add(pair.wechatThread);
    return { primaryThread, threads, crossSurfaceAllowed: true };
  }
  if (primaryThread === pair.wechatThread && trigger.actor.id === pair.wechatSender) {
    threads.add(pair.webThread);
    return { primaryThread, threads, crossSurfaceAllowed: true };
  }
  return { primaryThread, threads, crossSurfaceAllowed: false };
}

/** Return all thread keys currently subscribed to `ticketId`. */
export function ticketThreads(store: Store, ticketId: string): string[] {
  const subscribed = store.subscribedThreads(undefined);
  const out: string[] = [];
  for (let i = 0; i < subscribed.length; i++) {
    const thread = subscribed[i];
    if (thread.subscriptions.includes(ticketId)) {
      out.push(thread.key);
    }
  }
  return out;
}

/**
 * Authorize whether `trigger` may access `ticket` (for recall, read-only sidecar, or multi-ticket aggregation).
 * Enforces thread scope intersection, unbound-WeChat isolation, actor/pairing checks on `chat`, and policy
 * mandate revalidation.
 */
export function canAccessTicket(
  app: AppContext,
  trigger: Trigger,
  ticket: Ticket,
  subscribedThreadKeys?: readonly string[],
  crossSurfaceEnabled = process.env.NEO_RECALL_CROSS_SURFACE === "1",
): boolean {
  const scope = accessibleThreads(app, trigger, crossSurfaceEnabled);
  if (scope.primaryThread.length === 0 || scope.threads.size === 0) {
    return false;
  }

  let ownerThreads: readonly string[] = subscribedThreadKeys ?? ticketThreads(app.store, ticket.id);
  if (ownerThreads.length === 0) {
    const originTrigger = app.store.trigger(ticket.origin.triggerId);
    if (originTrigger !== undefined && originTrigger.threads.length > 0) {
      ownerThreads = originTrigger.threads.map(threadKey);
    }
  }
  if (ownerThreads.length === 0) {
    return false;
  }

  let inPrimary = false;
  let intersects = false;
  for (let i = 0; i < ownerThreads.length; i++) {
    const key = ownerThreads[i];
    if (key === scope.primaryThread) {
      inPrimary = true;
      intersects = true;
    } else if (scope.threads.has(key)) {
      intersects = true;
    }
  }
  if (!intersects) {
    return false;
  }

  const settings = app.settings();
  const account = app.wechatAccount();
  const mandateActor = ticket.mandate.actor;
  const isWeChatMandate =
    mandateActor.source === CHAT_SOURCE &&
    mandateActor.id.toLowerCase().startsWith(WECHAT_PREFIX);
  const isUnboundWeChatMandate =
    isWeChatMandate &&
    (account === null || mandateActor.id !== `${WECHAT_PREFIX}${account.userId}`);

  if (isUnboundWeChatMandate) {
    return false;
  }

  if (trigger.source === CHAT_SOURCE) {
    if (
      trigger.actor.source !== CHAT_SOURCE ||
      allowedSender(settings, CHAT_SOURCE, trigger.actor.id) === undefined
    ) {
      return false;
    }
    if (
      mandateActor.source !== CHAT_SOURCE ||
      allowedSender(settings, CHAT_SOURCE, mandateActor.id) === undefined
    ) {
      return false;
    }
    if (mandateActor.id !== trigger.actor.id) {
      const pair = scope.crossSurfaceAllowed ? strictCrossSurfacePair(app) : null;
      const isPaired =
        pair !== null &&
        ((trigger.actor.id === pair.webSender && mandateActor.id === pair.wechatSender) ||
          (trigger.actor.id === pair.wechatSender && mandateActor.id === pair.webSender));
      if (!isPaired) {
        return false;
      }
    }
  }

  const crossThread = !inPrimary;
  if (crossThread || ticket.ended !== undefined || isUnboundWeChatMandate) {
    if (!app.policy().revalidate(ticket.mandate)) {
      return false;
    }
  }

  return true;
}

function sanitizeArtifactName(fileName: string): string {
  const noControl = fileName
    .replace(LINE_BREAK_OR_TAB_RE, " ")
    .replace(CONTROL_AND_BIDI_RE, "");
  const segments = noControl.split(/[/\\]+/).filter((part) => part.length > 0);
  if (segments.length === 0) {
    return "";
  }
  const base = segments[segments.length - 1]
    .replace(UNSAFE_ARTIFACT_CHARS_RE, "")
    .replace(WHITESPACE_RUN_RE, " ")
    .trim();
  if (base.length === 0 || DOTS_ONLY_RE.test(base)) {
    return "";
  }
  return clip(base, MAX_ARTIFACT_NAME_CHARS);
}

/**
 * Record a sanitized deliverable file name on a ticket's `artifacts` list (deduplicated, newest first,
 * capped at `maxItems`) without ever modifying `ticket.updatedAt`.
 */
export function recordTicketArtifact(
  store: Store,
  ticketId: string,
  fileName: string,
  maxItems = 15,
): boolean {
  if (!Number.isInteger(maxItems) || maxItems <= 0) {
    return false;
  }
  const sanitized = sanitizeArtifactName(fileName);
  if (sanitized.length === 0) {
    return false;
  }
  return store.atomic(() => {
    const ticket = store.ticket(ticketId);
    if (ticket === undefined) {
      return false;
    }
    const target = ticket as Ticket & { artifacts?: string[] };
    const existing = Array.isArray(target.artifacts)
      ? target.artifacts.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    const next: string[] = [sanitized];
    for (let i = 0; i < existing.length && next.length < maxItems; i++) {
      const item = existing[i];
      if (item !== sanitized) {
        next.push(item);
      }
    }
    target.artifacts = next;
    store.saveTicket(ticket);
    return true;
  });
}
