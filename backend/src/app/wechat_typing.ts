/**
 * The WeChat typing indicator: a plain local loop beside the long poll, with no model in it,
 * that makes "正在输入" blink in the bound user's chat while the main Session thinks, a worker
 * is at work, or a read-only sidecar is answering, so the person sees the work is alive, and
 * takes it away once none of them is.
 */

import type { AppContext } from "./context.ts";
import { SIDECAR } from "./effects.ts";
import { WeChatProtocolError, type Account, type Protocol } from "./wechat_protocol.ts";

/** How long a typing ticket is used before a new one is asked for (30 minutes, in ms). */
export const TICKET_LIFE = 30 * 60 * 1000;

/** What the indicator last did. */
interface Indicator {
  /** The ticket WeChat gave for it, and when (monotonic ms). */
  ticket: [string, number] | null;
  /** "Typing" shows now. */
  shown: boolean;
  /** When it was last shown or taken away during work (monotonic ms). */
  since: number | null;
  /** After a failure, when to try again (monotonic ms). */
  retryAt: number | null;
  /** A failure was logged and nothing has worked since, so the next is not logged again. */
  failing: boolean;
}

function createIndicator(): Indicator {
  return {
    ticket: null,
    shown: false,
    since: null,
    retryAt: null,
    failing: false,
  };
}

function indicatorFailed(indicator: Indicator, protocol: Protocol, error: unknown): void {
  // A ticket that failed may be the reason: the next try asks for a new one.
  indicator.ticket = null;
  indicator.retryAt = performance.now() + protocol.typingOnMs;
  if (!indicator.failing) {
    indicator.failing = true;
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[neo-agent] 微信输入状态暂时失败：${detail}`);
  }
}

function indicatorWorked(indicator: Indicator): void {
  indicator.retryAt = null;
  indicator.failing = false;
}

function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Whether the main Session is in a turn or has one coming. */
export function routerThinking(app: AppContext): boolean {
  const main = app.session(app.masterId);
  if (main === null) {
    return false;
  }
  const session = main.session;
  return !session.isDisposed() && (session.isStreaming() || session.hasAdmittedSubmission());
}

/** Whether the main Session is thinking, a worker is at work, or a read-only sidecar is answering. */
export function agentsBusy(app: AppContext): boolean {
  return routerThinking(app) || app.workersBusy() || app.effects.isRunning(SIDECAR);
}

async function typingStep(
  app: AppContext,
  protocol: Protocol,
  fallbackAccount: Account,
  indicator: Indicator,
  signal: AbortSignal,
): Promise<void> {
  // Check in-memory busy state FIRST so idle ticks perform zero SQLite reads.
  const busy = agentsBusy(app);
  const now = performance.now();

  if (indicator.retryAt !== null && now < indicator.retryAt) {
    if (!busy && !indicator.shown) {
      indicator.since = null;
    }
    return;
  }

  if (!busy) {
    indicator.since = null;
    if (indicator.shown) {
      indicator.shown = false;
      const ticket = indicator.ticket?.[0];
      if (ticket !== undefined) {
        const current = app.wechatAccount() ?? fallbackAccount;
        try {
          await protocol.sendTyping(current, ticket, false);
          indicatorWorked(indicator);
        } catch (error) {
          indicatorFailed(indicator, protocol, error);
        }
      }
    }
    return;
  }

  // At work: shown for `typingOnMs`, away for `typingOffMs`, and so on.
  const held = indicator.shown ? protocol.typingOnMs : protocol.typingOffMs;
  if (indicator.since !== null && now < indicator.since + held) {
    return;
  }

  // Only read the stored account (which holds the latest contextToken from long-poll)
  // when we actually need to call the WeChat API.
  const current = app.wechatAccount() ?? fallbackAccount;
  let ticket: string;
  if (indicator.ticket !== null && now < indicator.ticket[1] + TICKET_LIFE) {
    ticket = indicator.ticket[0];
  } else {
    try {
      ticket = await protocol.typingTicket(current, signal);
      indicator.ticket = [ticket, now];
    } catch (error) {
      if (error instanceof WeChatProtocolError && error.isAborted) {
        return;
      }
      indicatorFailed(indicator, protocol, error);
      return;
    }
  }

  const show = !indicator.shown;
  try {
    await protocol.sendTyping(current, ticket, show, signal);
    indicator.shown = show;
    indicator.since = now;
    indicatorWorked(indicator);
  } catch (error) {
    if (error instanceof WeChatProtocolError && error.isAborted) {
      return;
    }
    indicatorFailed(indicator, protocol, error);
  }
}

/**
 * Keep the typing indicator in step with the work until `signal` aborts,
 * and take it away cleanly on exit if it is currently shown.
 */
export async function wechatTypingLoop(
  app: AppContext,
  protocol: Protocol,
  account: Account,
  signal: AbortSignal,
): Promise<void> {
  const indicator = createIndicator();
  while (!signal.aborted) {
    // The poll keeps the account's context token current in the store.
    await typingStep(app, protocol, account, indicator, signal);
    if (signal.aborted) {
      break;
    }
    await sleepOrAbort(protocol.typingCheckMs, signal);
  }
  if (indicator.shown && indicator.ticket !== null) {
    const current = app.wechatAccount() ?? account;
    try {
      // Do not pass the already-aborted signal so the cancel request can actually be sent
      // (bounded by `TYPING_WAIT_MS` inside `Protocol.sendTyping`).
      await protocol.sendTyping(current, indicator.ticket[0], false);
    } catch {
      // Best-effort cleanup on shutdown / disconnect.
    }
  }
}
