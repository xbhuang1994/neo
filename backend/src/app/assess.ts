//! Candidates for the main Session: the card each Eval is delivered as, and the read-only assessment of proactive ones.

import {
  reasonText,
  threadKey,
  type Candidate,
  type DecisionKind,
  type Ticket,
  type Trigger,
} from "../core/index.ts";
import { isRecord, textBlock } from "../kernel/index.ts";
import { accessibleThreads, canAccessTicket } from "./access.ts";
import {
  capped,
  charCount,
  relatedTickets,
  routingCard,
  textPage,
  ticketCard,
  triggerCard,
  triggerMessage,
} from "./cards.ts";
import { isShortConfirmation, loadClarification } from "./clarification.ts";
import {
  WORKTREE_NAME_RULE,
  validWorktreeName,
  type AppContext,
  type Args,
} from "./context.ts";
import { Failure } from "./effects.ts";
import { assessmentOutcome, directionAllowed, parseAssessment } from "./policy.ts";
import { recallConfig } from "./recall.ts";
import { CHAT_SOURCE } from "./settings.ts";
import { IM_WORDS, checkedImText, clip, wordCount } from "./text.ts";

/** How many tickets a chat candidate's card shows inline; older ones stay behind `orchestrator_read`. */
export const CHAT_RELATED = 12;

function relatedLimit(tickets: readonly Ticket[]): number {
  let openCount = 0;
  for (let i = 0; i < tickets.length; i++) {
    if (tickets[i].ended === undefined) {
      openCount += 1;
    }
  }
  return Math.min(Math.max(CHAT_RELATED, openCount), 24);
}

/** Workers that handed one message back before no open ticket is taken to own it: it is new work. */
export const MISS_LIMIT = 3;
export const TRIGGER_CHARS = 4000;
export const NEAR_CHARS = 1200;
export const WINDOW_CHARS = 400;
export const STUB_CHARS = 50;
/** How many of a thread's latest messages an assessment loads. */
export const THREAD_MESSAGES = 200;
export const EXPLICIT =
  "This is an explicit request, which is routed instead of assessed: use orchestrator_route with its trigger_id and kind accept, attach, stop or ignore";

const WHITESPACE_RUN = /\p{White_Space}+/gu;
const EDGE_WHITESPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;
const UNSIGNED_INT = /^\d+$/;

function collapseWhitespace(text: string): string {
  return text.replace(EDGE_WHITESPACE, "").replace(WHITESPACE_RUN, " ");
}

function cut(text: string, limit: number): Record<string, unknown> {
  const chars = charCount(text);
  if (chars <= limit) {
    return { text };
  }
  return {
    text: `${clip(text, limit)}…`,
    chars,
  };
}

/** The card a candidate reaches the main Session as: the message as workers read it, routing facts, and what to do next. */
export function candidateCard(
  app: AppContext,
  candidate: Candidate,
): Record<string, unknown> {
  const primary = candidate.triggers[candidate.triggers.length - 1];
  if (primary === undefined) {
    throw new Error("an Eval holds at least one trigger");
  }
  const settings = app.settings();
  const card = triggerMessage(primary, undefined);
  card.kind = "candidate";
  card.strength = candidate.strength;
  card.mode = settings.eval.mode;

  const others: Record<string, unknown>[] = [];
  for (let i = 0; i < candidate.triggers.length; i++) {
    const trigger = candidate.triggers[i];
    if (trigger.id !== primary.id) {
      others.push(triggerCard(trigger, undefined));
    }
  }
  if (others.length > 0) {
    card.batch = others;
  }

  // Triggers a worker handed back as outside its ticket's scope, with its reason.
  const handedBack: Array<{ trigger_id: string; ticket_id: string; reason: string }> = [];
  let primaryMisses = 0;
  for (let i = 0; i < candidate.triggers.length; i++) {
    const trigger = candidate.triggers[i];
    const handbacks = app.store.disposition(trigger.id)?.handbacks;
    if (handbacks === undefined || handbacks.length === 0) {
      continue;
    }
    for (let j = 0; j < handbacks.length; j++) {
      const item = handbacks[j];
      handedBack.push({
        trigger_id: trigger.id,
        ticket_id: item.ticketId,
        reason: item.reason,
      });
      if (trigger.id === primary.id) {
        primaryMisses += 1;
      }
    }
  }
  const missed = primaryMisses >= MISS_LIMIT;
  if (handedBack.length > 0) {
    card.handed_back = handedBack;
  }

  const chat = primary.source === CHAT_SOURCE;
  const limit = relatedLimit(candidate.tickets);
  const related = chat
    ? relatedTickets(candidate.tickets, limit, (ticket) =>
        routingCard(ticket, app.store.trigger(ticket.origin.triggerId)?.text),
      )
    : relatedTickets(candidate.tickets, limit, ticketCard);

  const cfg = recallConfig();
  const pendingClarification =
    chat && cfg.clarify ? loadClarification(app.store, candidate.thread.key) : undefined;

  if (pendingClarification !== undefined) {
    card.pending_clarification = {
      id: pendingClarification.id,
      origin_text: pendingClarification.originText,
      question_asked: pendingClarification.question,
      options: pendingClarification.options.map((opt) => ({
        key: opt.key,
        label: opt.label,
        action: opt.action,
        ...(opt.ticketId !== undefined ? { ticket_id: opt.ticketId } : {}),
      })),
    };
    const listedIds = new Set<string>(
      related.related_tickets
        .map((item) => (typeof item.ticket_id === "string" ? item.ticket_id : ""))
        .filter((id) => id.length > 0),
    );
    const candidateTicketIds = new Set(candidate.tickets.map((t) => t.id));
    const pinnedSame: Record<string, unknown>[] = [];
    const pinnedCross: Record<string, unknown>[] = [];
    for (let i = 0; i < pendingClarification.options.length; i++) {
      const optId = pendingClarification.options[i].ticketId;
      if (optId === undefined || listedIds.has(optId)) {
        continue;
      }
      const optTicket = app.storeTicket(optId);
      if (optTicket !== null && canAccessTicket(app, primary, optTicket, undefined, cfg.crossSurface)) {
        listedIds.add(optId);
        const rc = routingCard(optTicket, app.store.trigger(optTicket.origin.triggerId)?.text);
        if (candidateTicketIds.has(optId)) {
          pinnedSame.push(rc);
        } else {
          pinnedCross.push({ ...rc, other_thread: true });
        }
      }
    }
    if (pinnedSame.length > 0) {
      related.related_tickets = [...pinnedSame, ...related.related_tickets];
    }
    if (pinnedCross.length > 0) {
      card.other_thread_tickets = pinnedCross;
    }
  }

  Object.assign(card, related);

  if (chat && cfg.candidateRelevance && candidate.strength === "explicit" && !missed) {
    const t0 = performance.now();
    const queryTexts: string[] = [];
    for (let i = 0; i < candidate.triggers.length; i++) {
      const item = candidate.triggers[i];
      if (item.human) {
        const raw =
          typeof item.meta.originalText === "string" ? item.meta.originalText : item.text;
        if (raw.trim().length > 0) {
          queryTexts.push(raw);
        }
      }
    }
    const mergedQuery = queryTexts.join(" ").trim();
    if (pendingClarification === undefined && isShortConfirmation(mergedQuery)) {
      const recent = app.store.threadPage(candidate.thread.key, 0, 6);
      const currentIds = new Set(candidate.triggers.map((t) => t.id));
      for (let i = 0; i < recent.length; i++) {
        const prev = recent[i];
        if (prev.human && !currentIds.has(prev.id)) {
          const prevText =
            typeof prev.meta.originalText === "string" ? prev.meta.originalText : prev.text;
          if (prevText.trim().length > 0) {
            queryTexts.unshift(prevText);
            break;
          }
        }
      }
    }
    const excludeTicketIds = new Set<string>(
      related.related_tickets
        .map((item) => (typeof item.ticket_id === "string" ? item.ticket_id : ""))
        .filter((id) => id.length > 0),
    );
    const handedBackIds = new Set<string>(handedBack.map((item) => item.ticket_id));
    const scope = accessibleThreads(app, primary, cfg.crossSurface);
    const recalled = app.ensureSearchIndex().recallForCandidate({
      queryTexts,
      currentThread: scope.primaryThread,
      allowedThreads: scope.threads,
      excludeTicketIds,
      handedBackIds,
      allowCrossThread: scope.crossSurfaceAllowed,
      revalidate: (ticketId) => {
        const stored = app.storeTicket(ticketId);
        return stored !== null && canAccessTicket(app, primary, stored, undefined, cfg.crossSurface);
      },
      minScoreSame: cfg.minScoreSame,
      minScoreCross: cfg.minScoreCross,
    });
    if (recalled.sameThread.length > 0) {
      card.recalled_tickets = recalled.sameThread;
      card.recall_confidence = recalled.confidence;
    }
    if (recalled.crossThread.length > 0) {
      const existingCross = Array.isArray(card.other_thread_tickets)
        ? (card.other_thread_tickets as Record<string, unknown>[])
        : [];
      const existingCrossIds = new Set(
        existingCross.map((item) => (typeof item.ticket_id === "string" ? item.ticket_id : "")),
      );
      const extraCross = recalled.crossThread.filter((item) => !existingCrossIds.has(item.ticket_id));
      card.other_thread_tickets = [...existingCross, ...extraCross];
    }
    if (process.env.NEO_RECALL_LOG === "1") {
      const elapsedMs = (performance.now() - t0).toFixed(2);
      console.error(
        `[neo-agent] recall ms=${elapsedMs} same=${recalled.sameThread.length} cross=${recalled.crossThread.length} confidence=${recalled.confidence}`,
      );
    }
  }

  const delivered = app.store.disposition(primary.id)?.fanout;
  if (delivered !== undefined && delivered.length > 0) {
    card.delivered_to = [...delivered];
  }

  if (missed) {
    card.next_action = `${MISS_LIMIT} handbacks: route with orchestrator_route kind=accept (never attach), kind=sidecar (after orchestrator_search if read-only historical lookup), or kind=ignore with answer if chat only.`;
  } else if (candidate.strength === "explicit") {
    const baseAction =
      "Route via orchestrator_route (accept, attach, sidecar, clarify, stop, ignore); for plain chat, use ignore with answer in user's language.";
    card.next_action =
      pendingClarification !== undefined
        ? `${baseAction} If this message answers pending_clarification, pass clarification_id with matching kind/ticket_id; otherwise route normally without clarification_id.`
        : baseAction;
  } else {
    card.next_action =
      "Ignore with orchestrator_route if no rule applies; else run orchestrator_eval, orchestrator_eval_read, orchestrator_eval_decide.";
  }
  return card;
}

/**
 * Deliver an Eval's candidate card to the main Session; its deadline counts from then, so a busy Session does not
 * use up assessment time.
 */
export async function assessmentQueued(
  app: AppContext,
  payload: unknown,
  evalId: string,
): Promise<void> {
  const triggerId =
    isRecord(payload) && typeof payload.triggerId === "string" ? payload.triggerId : undefined;
  if (triggerId === undefined) {
    return;
  }
  const candidate = app.engine.candidate(triggerId);
  if (candidate === undefined || candidate.evalId !== evalId) {
    return;
  }
  try {
    const main = await app.ensureOrchestrator();
    const card = JSON.stringify(candidateCard(app, candidate));
    await main.session.send(`candidate:${evalId}`, [textBlock(card)], "steer", {}, []);
    app.engine.candidateDelivered(evalId);
  } catch (error) {
    throw Failure.from(error);
  }
}

/** The Eval that holds a trigger, for assessment: explicit requests are routed instead. */
function evalFor(app: AppContext, triggerId: string): [Candidate, Trigger] {
  const candidate = app.engine.candidate(triggerId);
  if (candidate === undefined) {
    throw new Error(
      "No assessment is in progress for this trigger; it was already decided, timed out, or never reached assessment",
    );
  }
  if (candidate.strength === "explicit") {
    throw new Error(EXPLICIT);
  }
  const trigger = candidate.triggers.find((item) => item.id === triggerId);
  if (trigger === undefined) {
    throw new Error("No assessment is in progress for this trigger");
  }
  return [candidate, trigger];
}

/**
 * What `orchestrator_eval` returns: the trigger's text once, its batch peers, the thread's tickets, and the thread
 * window: the first five messages and five on either side of the trigger, long ones cut, the rest as stubs.
 */
export function evalContext(app: AppContext, triggerId: string): Record<string, unknown> {
  const [candidate, trigger] = evalFor(app, triggerId);
  const thread = threadKey(trigger.threads[0]);
  const messages = app.store.threadTriggers(thread, THREAD_MESSAGES, undefined, false);
  const atIndex = messages.findIndex((message) => message.id === trigger.id);
  const at = atIndex >= 0 ? atIndex : undefined;
  const shown = (index: number): boolean =>
    index < 5 || (at !== undefined && Math.abs(index - at) <= 5);

  const window = new Array<Record<string, unknown>>(messages.length);
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const line: Record<string, unknown> = { id: message.id, from: message.actor.id };
    if (!message.human) {
      line.bot = true;
    }
    if (!shown(index)) {
      line.preview = clip(collapseWhitespace(message.text), STUB_CHARS);
      window[index] = line;
      continue;
    }
    line.at = message.at;
    // The trigger's own text is shown once, at the top.
    if (at === index) {
      line.trigger = true;
      window[index] = line;
      continue;
    }
    const near = at !== undefined && Math.abs(index - at) <= 2;
    Object.assign(line, cut(message.text, near ? NEAR_CHARS : WINDOW_CHARS));
    window[index] = line;
  }

  const context: Record<string, unknown> = {
    trigger_id: trigger.id,
    strength: candidate.strength,
    mode: app.settings().eval.mode,
    source: {
      kind: trigger.source,
      actor: trigger.actor.id,
      thread,
    },
    ...cut(trigger.text, TRIGGER_CHARS),
  };

  const others: Record<string, unknown>[] = [];
  for (let i = 0; i < candidate.triggers.length; i++) {
    const item = candidate.triggers[i];
    if (item.id === trigger.id) {
      continue;
    }
    const text = cut(item.text, WINDOW_CHARS);
    const line: Record<string, unknown> = {
      trigger_id: item.id,
      actor: item.actor.id,
      at: item.at,
    };
    if ("chars" in text) {
      line.read = `trigger/${item.id}`;
    }
    Object.assign(line, text);
    others.push(line);
  }
  if (others.length > 0) {
    context.batch = others;
  }

  Object.assign(
    context,
    relatedTickets(candidate.tickets, relatedLimit(candidate.tickets), ticketCard),
  );
  // The rules are in the main Session's Policy section, which names the version this Eval was built from.
  context.policy_version = candidate.policyVersion;
  context.thread = {
    complete: messages.length < THREAD_MESSAGES,
    loaded_messages: messages.length,
    source_found: at !== undefined,
    messages: window,
  };
  return context;
}

/** Serve more of a candidate's context: one message whole, or a page of its thread. */
export function evalRead(app: AppContext, args: Args): Record<string, unknown> {
  const [, trigger] = evalFor(app, args.required("trigger_id"));
  const thread = threadKey(trigger.threads[0]);
  const offset = args.number("offset", 0, Number.MAX_SAFE_INTEGER);
  switch (args.required("resource")) {
    case "message": {
      if (args.text("cursor") !== undefined) {
        throw new Error('cursor is only for thread. First page: {resource:"thread"}.');
      }
      const id = args.text("message_id") ?? trigger.id;
      const found = app.store.trigger(id);
      if (
        found === undefined ||
        !found.threads.some((reference) => threadKey(reference) === thread)
      ) {
        throw new Error(
          "Unknown message reference. Read the thread first; copy a returned message id.",
        );
      }
      return textPage("message", found.text, offset, 4000);
    }
    case "thread": {
      if (args.text("message_id") !== undefined) {
        throw new Error("message_id is only for message.");
      }
      const cursor = args.text("cursor");
      let start = 0;
      if (cursor !== undefined) {
        if (!UNSIGNED_INT.test(cursor)) {
          throw new Error(
            'Unknown thread cursor. First call {resource:"thread"}; then copy the returned next_cursor exactly.',
          );
        }
        const parsed = Number(cursor);
        if (!Number.isSafeInteger(parsed)) {
          throw new Error(
            'Unknown thread cursor. First call {resource:"thread"}; then copy the returned next_cursor exactly.',
          );
        }
        start = parsed;
      }
      // Newest first, a page at a time.
      const page = app.store.threadPage(thread, start, 21);
      const count = Math.min(20, page.length);
      const messages = new Array<Record<string, unknown>>(count);
      for (let i = 0; i < count; i++) {
        const message = page[i];
        messages[i] = {
          id: message.id,
          from: message.actor.id,
          at: message.at,
          ...capped(message.text, NEAR_CHARS, `message ${message.id}`),
        };
      }
      const body = JSON.stringify({
        next_cursor: page.length > 20 ? String(start + 20) : null,
        messages,
      });
      return textPage("thread", body, offset, 4000);
    }
    default:
      throw new Error("resource is message or thread");
  }
}

/** Record an assessment's decision: validate it against the enabled rules and pass it to the Engine. */
export function evalDecide(
  app: AppContext,
  triggerId: string,
  fields: unknown,
): [DecisionKind, string, string | undefined] {
  const [candidate] = evalFor(app, triggerId);
  const assessment = parseAssessment(fields);
  if (assessment.title.length === 0 || charCount(assessment.title) > 160) {
    throw new Error("title has 1 to 160 characters");
  }
  if (charCount(assessment.scope) > 1500) {
    throw new Error("scope has at most 1500 characters");
  }
  if (assessment.reason.length === 0 || charCount(assessment.reason) > 500) {
    throw new Error("reason has 1 to 500 characters");
  }
  if (assessment.intent_evidence !== undefined && charCount(assessment.intent_evidence) > 700) {
    throw new Error("intent_evidence has at most 700 characters");
  }
  if (assessment.worktree_name !== undefined && assessment.worktree_name.length > 0) {
    if (!validWorktreeName(assessment.worktree_name)) {
      throw new Error(`worktree_name: ${WORKTREE_NAME_RULE}`);
    }
  }
  if (assessment.acknowledgement !== undefined && assessment.acknowledgement.length > 0) {
    if (wordCount(assessment.acknowledgement) > IM_WORDS) {
      throw new Error(
        `An acknowledgement has at most ${IM_WORDS} words; write one short sentence.`,
      );
    }
    const problem = app.wrongLanguage(triggerId, "acknowledgement", assessment.acknowledgement);
    if (problem !== null) {
      throw new Error(problem);
    }
  }
  const accepts =
    assessment.decision === "accept" &&
    directionAllowed(assessment.direction) &&
    assessment.rule_assessments.some((rule) => rule.matched);
  if (accepts && (assessment.worktree_name === undefined || assessment.worktree_name.length === 0)) {
    throw new Error("Accepted work requires a short English worktree_name");
  }
  const outcome = assessmentOutcome(assessment, app.settings(), candidate.strength);
  if (outcome.kind.kind === "accept" && outcome.kind.accept.acknowledgement !== undefined) {
    const checked = checkedImText(outcome.kind.accept.acknowledgement);
    if (!checked.ok) {
      throw new Error(checked.error);
    }
  }
  outcome.evalId = candidate.evalId;
  const decision = app.engine.decide(triggerId, outcome);
  return [decision.kind, reasonText(decision.reason), decision.ticketId];
}
