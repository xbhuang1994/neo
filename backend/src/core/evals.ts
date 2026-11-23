/**
 * Evals: the Thread-level assessments of queued Triggers, and the Decisions they end with.
 */

import type { EngineContext } from "./engine.ts";
import { UserError } from "./errors.ts";
import { key } from "./ids.ts";
import {
  dispositionAt,
  handedBackBy,
  hasTriggerInput,
  isTicketLive,
  mandateBasisVia,
  threadKey,
  type Decision,
  type DecisionKind,
  type Evaluation,
  type Json,
  type Mandate,
  type MandateBasis,
  type Strength,
  type Thread,
  type Trigger,
} from "./model.ts";
import {
  whyReasons,
  type Accept,
  type Candidate,
  type Outcome,
  type Policy,
} from "./ports.ts";
import { reasonCode, reasonOf, reasonWith, type Reason } from "./reasons.ts";
import { ticketsCreate, ticketsEnd } from "./tickets.ts";
import { parseIso, shift } from "./time.ts";

/** What an Eval ends with, as its Decision records it. */
interface Finished {
  kind: DecisionKind;
  reason: Reason[];
  audit?: Json;
  ticketId?: string;
  mandate?: Mandate;
}

/** How many times in a row an expired Eval queues its Triggers again before it is recorded unavailable. */
const REQUEUES = 2;

/**
 * Expire a Thread's Eval past its deadline, unless processing is paused: then the Eval notes when the pause began,
 * and once processing resumes its deadline moves forward by the pause's length. An Eval whose candidate has not
 * reached the assessor's Session does not expire.
 */
export function evalsDue(ctx: EngineContext, thread: Thread, policy: Policy): void {
  const evaluation = thread.evaluating;
  if (evaluation === undefined) {
    return;
  }
  if (policy.paused() && evaluation.pausedAt !== undefined) {
    return;
  }
  const now = ctx.now();
  if (policy.paused()) {
    evaluation.pausedAt = now;
  } else if (evaluation.pausedAt !== undefined) {
    const pausedAt = evaluation.pausedAt;
    delete evaluation.pausedAt;
    const paused = (parseIso(now) ?? 0) - (parseIso(pausedAt) ?? 0);
    evaluation.deadline = shift(evaluation.deadline, paused);
  } else if (evaluation.delivered !== undefined && evaluation.deadline <= now) {
    expire(ctx, thread);
    return;
  } else {
    return;
  }
  ctx.repo().saveThread(thread);
}

/** An Eval's candidate reached the assessor's Session: its deadline counts from now. */
export function evalsDelivered(ctx: EngineContext, evalId: string, policy: Policy): void {
  const thread = ctx
    .repo()
    .activeThreads()
    .find((t) => t.evaluating?.id === evalId);
  if (thread === undefined) {
    return;
  }
  const evaluation = thread.evaluating;
  if (evaluation === undefined || evaluation.delivered !== undefined) {
    return;
  }
  const now = ctx.now();
  evaluation.deadline = shift(now, policy.evalTimeoutMs());
  evaluation.delivered = now;
  ctx.repo().saveThread(thread);
}

/**
 * An Eval past its deadline queues its Triggers again for a fresh Eval, up to `REQUEUES` times in a row, so a busy
 * assessor does not drop requests; after that it is recorded unavailable.
 */
function expire(ctx: EngineContext, thread: Thread): void {
  const expired = (thread.expired ?? 0) + 1;
  const evaluation = thread.evaluating;
  if (evaluation === undefined) {
    throw new Error("an Eval expires");
  }
  if (expired > REQUEUES) {
    finish(ctx, thread, evaluation, { kind: "unavailable", reason: [reasonCode("timeout")] });
    return;
  }
  delete thread.evaluating;
  thread.expired = expired;
  const evalIdSet = new Set(evaluation.triggerIds);
  thread.pending = [
    ...evaluation.triggerIds,
    ...thread.pending.filter((id) => !evalIdSet.has(id)),
  ];
  ctx.repo().saveThread(thread);
  ctx.o.assessor.release?.(evaluation.id);
}

/** Start one Eval of the Triggers queued on a Thread, judged by the gate, and ask the assessor for it. */
export function evalsStart(ctx: EngineContext, threadKeyStr: string, policy: Policy): void {
  const thread = ctx.repo().thread(threadKeyStr);
  if (thread === undefined) {
    return;
  }
  const at = ctx.now();
  // A person's follow-up a ticket still decides is that ticket's: it leaves the queue without a Decision.
  const followups = thread.pending.filter((id) => {
    const trigger = ctx.repo().trigger(id);
    return trigger !== undefined && ctx.owners(trigger).length > 0;
  });
  if (followups.length > 0) {
    const followupSet = new Set(followups);
    thread.pending = thread.pending.filter((id) => !followupSet.has(id));
    ctx.repo().saveThread(thread);
    for (const triggerId of followups) {
      ctx.emit({ type: "triggerFollowup", triggerId });
    }
    if (thread.pending.length === 0) {
      return;
    }
  }
  // Triggers that already originated a ticket cannot lend authority to a new evaluation or spawn a duplicate ticket.
  const acc = accepted(ctx, thread.key);
  const started = thread.pending.filter((id) => acc.has(id));
  if (started.length > 0) {
    const reasons = started.map((id) =>
      reasonOf(reasonWith("startedTicket", "ticket", acc.get(id)?.ticketId ?? ""), id),
    );
    ignoreBatch(ctx, thread, started, reasons, policy, at);
  }

  const triggers: Trigger[] = [];
  for (const id of thread.pending) {
    const trigger = ctx.repo().trigger(id);
    if (trigger !== undefined) {
      triggers.push(trigger);
    }
  }
  const tickets = ctx.ticketsOnThread(thread);
  const reasons: Reason[] = [];
  let strongest: { trigger: Trigger; strength: Strength; basis: MandateBasis } | undefined;

  for (const trigger of triggers) {
    const gateResult = policy.gate(trigger, thread, tickets);
    if (gateResult.kind === "inadmissible") {
      reasons.push(reasonOf(reasonCode(gateResult.reason), trigger.id));
      continue;
    }
    const { strength, basis } = gateResult;
    const replace =
      strongest === undefined ||
      (strongest.strength !== "explicit" && strength === "explicit") ||
      (strength === strongest.strength && trigger.at >= strongest.trigger.at);
    if (replace) {
      strongest = { trigger, strength, basis };
    }
  }

  if (strongest === undefined) {
    if (thread.pending.length > 0) {
      const ignoreReasons = reasons.length === 0 ? [reasonCode("noAdmissible")] : reasons;
      const ids = [...thread.pending];
      ignoreBatch(ctx, thread, ids, ignoreReasons, policy, at);
    }
    ctx.repo().saveThread(thread);
    return;
  }

  const version = policy.version();
  const evalId = key(["eval", thread.key, version, at, ...thread.pending]);
  const triggerIds = thread.pending;
  thread.pending = [];
  const evaluation: Evaluation = {
    id: evalId,
    threadKey: thread.key,
    triggerIds,
    primary: strongest.trigger.id,
    strength: strongest.strength,
    actor: structuredClone(strongest.trigger.actor),
    basis: structuredClone(strongest.basis),
    policyVersion: version,
    startedAt: at,
    deadline: shift(at, policy.evalTimeoutMs()),
  };
  thread.evaluating = evaluation;
  ctx.repo().saveThread(thread);
  for (const trigger of triggers) {
    const disposition = ctx.repo().disposition(trigger.id) ?? dispositionAt(at);
    disposition.evalId = evalId;
    ctx.repo().saveDisposition(trigger.id, disposition);
  }
  ctx.emit({
    type: "evalStarted",
    evalId,
    threadKey: thread.key,
    triggerIds: [...evaluation.triggerIds],
    strength: strongest.strength,
  });
  ctx.o.assessor.request(candidateOf(ctx, thread, evaluation));
}

/** The candidate of the Eval that holds `triggerId`, or `undefined` while no Eval holds it. */
export function evalsCandidate(ctx: EngineContext, triggerId: string): Candidate | undefined {
  const thread = holding(ctx, triggerId);
  if (thread === undefined || thread.evaluating === undefined) {
    return undefined;
  }
  return candidateOf(ctx, thread, thread.evaluating);
}

/** Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does. */
export function evalsDecide(ctx: EngineContext, triggerId: string, outcome: Outcome): Decision {
  const trigger = ctx.repo().trigger(triggerId);
  if (trigger === undefined) {
    throw UserError.create("unknownTrigger");
  }
  const held = holding(ctx, triggerId);
  if (outcome.evalId !== undefined && held?.evaluating?.id !== outcome.evalId) {
    throw UserError.with("evalFinished", { eval: outcome.evalId });
  }
  // A replayed trigger that already created a ticket does not spawn a second one.
  if (outcome.kind.kind === "accept") {
    const earlier = accepted(ctx, threadKey(trigger.threads[0])).get(triggerId);
    if (earlier !== undefined) {
      return earlier;
    }
  }
  // A follow-up that reached a ticket is its worker's to judge: the main Session may only stop the work on it.
  if (outcome.kind.kind !== "stop") {
    ctx.leftToWorkers(trigger);
  }
  const thread = held ?? ctx.threadOf(trigger.threads[0]);
  const existingEval = thread.evaluating?.triggerIds.includes(triggerId)
    ? structuredClone(thread.evaluating)
    : undefined;
  const evaluation =
    existingEval ??
    directEval(
      ctx,
      thread,
      trigger,
      outcome.kind.kind,
      outcome.kind.kind === "stop" ? outcome.kind.ticketId : undefined,
    );
  // An inferred candidate is accepted only on enabled rules its assessment matched, while assessments may accept.
  if (outcome.kind.kind === "accept") {
    if (
      evaluation.strength !== "explicit" &&
      !ctx.policy().admitsInferred(outcome.kind.accept.rules ?? [])
    ) {
      throw UserError.create("notExplicit");
    }
  }
  return decideEval(ctx, thread, evaluation, outcome);
}

/** Queue a stored Trigger for a fresh Eval on its primary Thread; false while an Eval holds it. */
export function evalsReevaluate(ctx: EngineContext, triggerId: string): boolean {
  const trigger = ctx.repo().trigger(triggerId);
  if (trigger === undefined) {
    throw UserError.create("unknownTrigger");
  }
  if (holding(ctx, triggerId) !== undefined) {
    return false;
  }
  ctx.queueForEval(trigger);
  const disposition = ctx.dispositionOrNew(triggerId);
  disposition.requeued = true;
  ctx.repo().saveDisposition(triggerId, disposition);
  ctx.emit({ type: "triggerRequeued", triggerId });
  return true;
}

/**
 * Record that a ticket's Executor hands back a Trigger that reached it as beyond the ticket, and queue it for a
 * fresh Eval when the ticket decided it and no other ticket still does. A ticket hands a Trigger back once.
 */
export function evalsHandback(
  ctx: EngineContext,
  ticketId: string,
  triggerId: string,
  reason: string,
): boolean {
  const ticket = ctx.require(ticketId);
  if (!hasTriggerInput(ticket, triggerId)) {
    throw UserError.create("notReached");
  }
  const existing = ctx.repo().disposition(triggerId);
  if (existing !== undefined && handedBackBy(existing, ticketId)) {
    throw UserError.create("handedBack");
  }
  const trigger = ctx.repo().trigger(triggerId);
  if (trigger === undefined) {
    throw UserError.create("unknownTrigger");
  }
  return ctx.handBack(ticketId, trigger, reason);
}

/** Marks an `unavailable` Decision dismissed so the overview lists it no more. */
export function evalsDismiss(ctx: EngineContext, decisionId: string): Decision {
  const decision = ctx.repo().decision(decisionId);
  if (decision === undefined || decision.kind !== "unavailable") {
    throw UserError.create("unknownProblem");
  }
  decision.dismissed = true;
  ctx.repo().saveDecision(decision);
  return decision;
}

/** Take a Trigger out of its Thread's queue because it was routed by hand. */
export function evalsWithdraw(ctx: EngineContext, trigger: Trigger): void {
  const thread = ctx.repo().thread(threadKey(trigger.threads[0]));
  if (thread !== undefined && thread.pending.includes(trigger.id)) {
    thread.pending = thread.pending.filter((id) => id !== trigger.id);
    ctx.repo().saveThread(thread);
  }
}

/**
 * End the Eval that holds a Trigger routed to a ticket, since the ticket has it now: one that holds other Triggers
 * too queues them again for a fresh Eval without it.
 */
export function evalsRouted(ctx: EngineContext, triggerId: string, ticketId: string): void {
  const held = holding(ctx, triggerId);
  if (held === undefined || held.evaluating === undefined) {
    return;
  }
  const evaluation = structuredClone(held.evaluating);
  const reason = reasonWith("routed", "ticket", ticketId);
  if (evaluation.triggerIds.length === 1) {
    finish(ctx, held, evaluation, { kind: "ignore", reason: [reason] });
  } else {
    reassess(ctx, held, reasonOf(reason, triggerId), [triggerId]);
  }
}

/** Start the Evals in progress again under the new Policy version, and say that it changed. */
export function evalsPolicyChanged(ctx: EngineContext, from: string, to: string): void {
  for (const thread of ctx.repo().activeThreads()) {
    if (thread.evaluating !== undefined) {
      reassess(ctx, thread, reasonCode("policyChanged"), []);
    }
  }
  ctx.emit({ type: "policyChanged", from, to });
}

/** End a Thread's Eval as unavailable for `reason` and queue its Triggers, except `without`, for a new Eval ahead of the others. */
function reassess(
  ctx: EngineContext,
  thread: Thread,
  reason: Reason,
  without: readonly string[],
): Decision {
  const evaluation = thread.evaluating;
  if (evaluation === undefined) {
    throw new Error("an Eval to reassess");
  }
  const evalCopy = structuredClone(evaluation);
  const withoutSet = new Set(without);
  const ids = evalCopy.triggerIds.filter((id) => !withoutSet.has(id));
  const decision = finish(ctx, thread, evalCopy, { kind: "unavailable", reason: [reason] });
  const current = ctx.repo().thread(thread.key);
  if (current !== undefined) {
    const idSet = new Set(ids);
    current.pending = [...ids, ...current.pending.filter((id) => !idSet.has(id))];
    ctx.repo().saveThread(current);
  }
  return decision;
}

/** The Thread whose Eval holds a Trigger: an Eval runs on the primary Thread of each Trigger it holds. */
function holding(ctx: EngineContext, triggerId: string): Thread | undefined {
  const trigger = ctx.repo().trigger(triggerId);
  if (trigger === undefined || trigger.threads.length === 0) return undefined;
  const thread = ctx.repo().thread(threadKey(trigger.threads[0]));
  if (thread === undefined) return undefined;
  return thread.evaluating?.triggerIds.includes(triggerId) ? thread : undefined;
}

function candidateOf(ctx: EngineContext, thread: Thread, evaluation: Evaluation): Candidate {
  const triggers: Trigger[] = [];
  for (const id of evaluation.triggerIds) {
    const trigger = ctx.repo().trigger(id);
    if (trigger !== undefined) {
      triggers.push(trigger);
    }
  }
  return {
    evalId: evaluation.id,
    thread: structuredClone(thread),
    triggers,
    strength: evaluation.strength,
    policyVersion: evaluation.policyVersion,
    tickets: ctx.ticketsOnThread(thread),
  };
}

/**
 * Record that the queued Triggers `ids` of a Thread start no Eval, for `reason`, and take them out of its queue.
 * Its id differs from an Eval's, so it never replaces the Decision of an earlier Eval of the same Triggers.
 */
function ignoreBatch(
  ctx: EngineContext,
  thread: Thread,
  ids: string[],
  reason: Reason[],
  policy: Policy,
  at: string,
): void {
  const version = policy.version();
  const evaluation: Evaluation = {
    id: key(["eval", thread.key, "ignored", version, at, ...ids]),
    threadKey: thread.key,
    triggerIds: [...ids],
    strength: "inferred",
    actor: { source: thread.ref.source, id: "" },
    basis: mandateBasisVia({ via: "followup" }),
    policyVersion: version,
    startedAt: at,
    deadline: at,
  };
  record(ctx, thread, evaluation, { kind: "ignore", reason });
  const idSet = new Set(ids);
  thread.pending = thread.pending.filter((id) => !idSet.has(id));
  delete thread.expired;
}

/** The accept Decisions of the Triggers whose primary Thread is `threadKeyStr`, by Trigger: what each one started. */
function accepted(ctx: EngineContext, threadKeyStr: string): Map<string, Decision> {
  const result = new Map<string, Decision>();
  for (const decision of ctx.repo().decisionsByThread(threadKeyStr)) {
    if (decision.kind !== "accept" || decision.ticketId === undefined) {
      continue;
    }
    for (const id of decision.triggerIds) {
      if (!result.has(id)) {
        result.set(id, decision);
      }
    }
  }
  return result;
}

/**
 * A gate-only Eval of one Trigger, for an outcome decided without a queued Eval, such as a person's explicit
 * request. It is decided at once, beside an Eval its Thread may have in progress, and takes the Trigger out of the
 * queue. Its id names the outcome's kind, so a stop and an accept of one message at the same moment are two Decisions.
 */
function directEval(
  ctx: EngineContext,
  thread: Thread,
  trigger: Trigger,
  kind: string,
  ticketId?: string,
): Evaluation {
  const policy = ctx.policy();
  const gateResult = policy.gate(trigger, thread, ctx.ticketsOnThread(thread));
  if (gateResult.kind === "inadmissible") {
    throw UserError.with("notAdmissible", { reason: gateResult.reason });
  }
  const at = ctx.now();
  if (thread.pending.includes(trigger.id)) {
    thread.pending = thread.pending.filter((id) => id !== trigger.id);
    ctx.repo().saveThread(thread);
  }
  const parts = ["eval", thread.key, "direct", trigger.id, kind];
  if (ticketId !== undefined) {
    parts.push(ticketId);
  }
  parts.push(at);
  return {
    id: key(parts),
    threadKey: thread.key,
    triggerIds: [trigger.id],
    primary: trigger.id,
    strength: gateResult.strength,
    actor: structuredClone(trigger.actor),
    basis: structuredClone(gateResult.basis),
    policyVersion: policy.version(),
    startedAt: at,
    deadline: at,
  };
}

/** Apply an outcome to an Eval of a Thread: the one in progress, or a gate-only one. */
function decideEval(
  ctx: EngineContext,
  thread: Thread,
  evaluation: Evaluation,
  outcome: Outcome,
): Decision {
  const own = thread.evaluating?.id === evaluation.id;
  // Requeue if Policy changed without a live policyChanged call (such as across a restart).
  if (ctx.policy().version() !== evaluation.policyVersion) {
    if (own) {
      return reassess(ctx, thread, reasonCode("policyChanged"), []);
    }
    return finish(ctx, thread, evaluation, {
      kind: "unavailable",
      reason: [reasonCode("policyChanged")],
      ...(outcome.audit !== undefined ? { audit: outcome.audit } : {}),
    });
  }
  const saidText = outcome.reason.kind === "said" ? outcome.reason.text : undefined;
  switch (outcome.kind.kind) {
    case "ignore":
    case "unavailable": {
      const ignore = outcome.kind.kind === "ignore";
      // An inferred candidate ignored without an assessment, from its card, says so beside the reason given.
      const reason: Reason[] =
        ignore && evaluation.strength !== "explicit" && outcome.audit === undefined
          ? [reasonCode("ignoredFromCard")]
          : [];
      reason.push(...whyReasons(outcome.reason));
      return finish(ctx, thread, evaluation, {
        kind: ignore ? "ignore" : "unavailable",
        reason,
        ...(outcome.audit !== undefined ? { audit: outcome.audit } : {}),
      });
    }
    case "stop": {
      const ticket = ctx.repo().ticket(outcome.kind.ticketId);
      if (ticket === undefined || !isTicketLive(ticket)) {
        return finish(ctx, thread, evaluation, {
          kind: "ignore",
          reason: [reasonCode("stopUnknown")],
          ...(outcome.audit !== undefined ? { audit: outcome.audit } : {}),
        });
      }
      if (evaluation.strength !== "explicit") {
        return finish(ctx, thread, evaluation, {
          kind: "ignore",
          reason: [reasonCode("stopNotExplicit")],
          ...(outcome.audit !== undefined ? { audit: outcome.audit } : {}),
        });
      }
      const decision = finish(ctx, thread, evaluation, {
        kind: "stop",
        reason: whyReasons(outcome.reason),
        ...(outcome.audit !== undefined ? { audit: outcome.audit } : {}),
        ticketId: ticket.id,
      });
      ticketsEnd(ctx, ticket.id, "human", "stopped", undefined, saidText);
      return decision;
    }
    case "accept":
      return acceptEval(
        ctx,
        thread,
        evaluation,
        outcome.kind.accept,
        whyReasons(outcome.reason),
        outcome.audit,
      );
  }
}

/** Record an accept with the Mandate the Eval gives, and have Tickets create its ticket. */
function acceptEval(
  ctx: EngineContext,
  thread: Thread,
  evaluation: Evaluation,
  accept: Accept,
  reason: Reason[],
  audit?: Json,
): Decision {
  const at = ctx.now();
  const basis = structuredClone(evaluation.basis);
  if (accept.rules !== undefined) {
    basis.rules = [...accept.rules];
  }
  const mandate: Mandate = {
    strength: evaluation.strength,
    policyVersion: evaluation.policyVersion,
    basis,
    actor: structuredClone(evaluation.actor),
    scope: accept.scope,
  };
  const ticketId = key(["ticket", evaluation.id]);
  const decision = finish(ctx, thread, evaluation, {
    kind: "accept",
    reason,
    ...(audit !== undefined ? { audit } : {}),
    ticketId,
    mandate,
  });
  ticketsCreate(ctx, ticketId, decision.id, mandate, evaluation, accept, at);
  return decision;
}

/** Record an Eval's Decision; the Thread's own Eval ends with it, while a gate-only one leaves the Thread's Eval going. */
function finish(
  ctx: EngineContext,
  thread: Thread,
  evaluation: Evaluation,
  outcome: Finished,
): Decision {
  const decision = record(ctx, thread, evaluation, outcome);
  if (thread.evaluating?.id !== evaluation.id) {
    return decision;
  }
  delete thread.evaluating;
  delete thread.expired;
  ctx.repo().saveThread(thread);
  ctx.o.assessor.release?.(evaluation.id);
  return decision;
}

function record(
  ctx: EngineContext,
  thread: Thread,
  evaluation: Evaluation,
  outcome: Finished,
): Decision {
  const at = ctx.now();
  const decision: Decision = {
    id: key(["decision", evaluation.id]),
    evalId: evaluation.id,
    threadKey: thread.key,
    triggerIds: [...evaluation.triggerIds],
    policyVersion: evaluation.policyVersion,
    at,
    kind: outcome.kind,
    reason: outcome.reason,
    strength: evaluation.strength,
    ...(outcome.ticketId !== undefined ? { ticketId: outcome.ticketId } : {}),
    ...(outcome.mandate !== undefined ? { mandate: outcome.mandate } : {}),
    ...(outcome.audit !== undefined ? { audit: outcome.audit } : {}),
  };
  ctx.repo().saveDecision(decision);
  for (const id of evaluation.triggerIds) {
    const disposition = ctx.repo().disposition(id) ?? dispositionAt(at);
    disposition.evalId = evaluation.id;
    disposition.decisionId = decision.id;
    ctx.repo().saveDisposition(id, disposition);
  }
  ctx.emit({
    type: "decisionRecorded",
    decisionId: decision.id,
    kind: decision.kind,
    threadKey: thread.key,
  });
  return decision;
}
