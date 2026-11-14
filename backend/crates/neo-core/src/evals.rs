//! Evals: the Thread-level assessments of queued Triggers, and the Decisions they end with.

use crate::engine::Engine;
use crate::errors::{Result, UserError};
use crate::ids::key;
use crate::model::{
    thread_key, ActorRef, BasisVia, Decision, DecisionKind, Evaluation, Json, Mandate, MandateBasis, Strength, Thread, TicketEndBy, TicketOutcome, Trigger,
};
use crate::ports::{Accept, Candidate, DomainEvent, GateResult, Outcome, OutcomeKind, Policy, Why};
use crate::reasons::Reason;
use crate::time::{parse_iso, shift};
use std::collections::HashMap;

/// What an Eval ends with, as its Decision records it.
struct Finished {
    kind: DecisionKind,
    reason: Vec<Reason>,
    audit: Option<Json>,
    ticket_id: Option<String>,
    mandate: Option<Mandate>,
}

impl Finished {
    fn new(kind: DecisionKind, reason: Vec<Reason>) -> Self {
        Finished { kind, reason, audit: None, ticket_id: None, mandate: None }
    }
    fn audit(mut self, audit: Option<Json>) -> Self {
        self.audit = audit;
        self
    }
}

/// How many times in a row an expired Eval queues its Triggers again before it is recorded unavailable.
const REQUEUES: u32 = 2;

impl Engine {
    /// Expire a Thread's Eval past its deadline, unless processing is paused: then the Eval notes when the pause began,
    /// and once processing resumes its deadline moves forward by the pause's length. An Eval whose candidate has not
    /// reached the assessor's Session does not expire.
    pub(crate) fn evals_due(&self, mut thread: Thread, policy: &dyn Policy) {
        let Some(evaluation) = thread.evaluating.as_mut() else {
            return;
        };
        if policy.paused() && evaluation.paused_at.is_some() {
            return;
        }
        let now = self.now();
        if policy.paused() {
            evaluation.paused_at = Some(now);
        } else if let Some(paused_at) = evaluation.paused_at.take() {
            let paused = parse_iso(&now).unwrap_or(0) - parse_iso(&paused_at).unwrap_or(0);
            evaluation.deadline = shift(&evaluation.deadline, paused);
        } else if evaluation.delivered.is_some() && evaluation.deadline <= now {
            self.expire(thread);
            return;
        } else {
            return;
        }
        self.repo().save_thread(&thread);
    }

    /// An Eval's candidate reached the assessor's Session: its deadline counts from now.
    pub(crate) fn evals_delivered(&self, eval_id: &str, policy: &dyn Policy) {
        let Some(mut thread) = self.repo().active_threads().into_iter().find(|t| t.evaluating.as_ref().is_some_and(|e| e.id == eval_id)) else {
            return;
        };
        let Some(evaluation) = thread.evaluating.as_mut().filter(|e| e.delivered.is_none()) else {
            return;
        };
        let now = self.now();
        evaluation.deadline = shift(&now, policy.eval_timeout_ms());
        evaluation.delivered = Some(now);
        self.repo().save_thread(&thread);
    }

    /// An Eval past its deadline queues its Triggers again for a fresh Eval, up to `REQUEUES` times in a row, so a busy
    /// assessor does not drop requests; after that it is recorded unavailable.
    fn expire(&self, mut thread: Thread) {
        let expired = thread.expired.unwrap_or(0) + 1;
        let evaluation = thread.evaluating.clone().expect("an Eval expires");
        if expired > REQUEUES {
            self.finish(&mut thread, &evaluation, Finished::new(DecisionKind::Unavailable, vec![Reason::code("timeout")]));
            return;
        }
        thread.evaluating = None;
        thread.expired = Some(expired);
        thread.pending.retain(|id| !evaluation.trigger_ids.contains(id));
        thread.pending.splice(0..0, evaluation.trigger_ids.iter().cloned());
        self.repo().save_thread(&thread);
        self.o.assessor.release(&evaluation.id);
    }

    /// Start one Eval of the Triggers queued on a Thread, judged by the gate, and ask the assessor for it.
    pub(crate) fn evals_start(&self, thread_key: &str, policy: &dyn Policy) {
        let Some(mut thread) = self.repo().thread(thread_key) else {
            return;
        };
        let at = self.now();
        // A person's follow-up a ticket still decides is that ticket's: it leaves the queue without a Decision.
        let followups: Vec<String> =
            thread.pending.iter().filter(|id| self.repo().trigger(id).is_some_and(|trigger| !self.owners(&trigger).is_empty())).cloned().collect();
        if !followups.is_empty() {
            thread.pending.retain(|id| !followups.contains(id));
            self.repo().save_thread(&thread);
            for trigger_id in followups {
                self.emit(DomainEvent::TriggerFollowup { trigger_id });
            }
            if thread.pending.is_empty() {
                return;
            }
        }
        // Triggers that already originated a ticket cannot lend authority to a new evaluation or spawn a duplicate ticket.
        let accepted = self.accepted(&thread.key);
        let started: Vec<String> = thread.pending.iter().filter(|id| accepted.contains_key(*id)).cloned().collect();
        if !started.is_empty() {
            let reasons = started.iter().map(|id| Reason::with("startedTicket", "ticket", accepted[id].ticket_id.as_deref().unwrap_or("")).of(id)).collect();
            self.ignore(&mut thread, started, reasons, policy, &at);
        }
        let triggers: Vec<Trigger> = thread.pending.iter().filter_map(|id| self.repo().trigger(id)).collect();
        let tickets = self.tickets_on_thread(&thread);
        let mut reasons: Vec<Reason> = Vec::new();
        let mut strongest: Option<(Trigger, Strength, MandateBasis)> = None;
        for trigger in &triggers {
            let (strength, basis) = match policy.gate(trigger, &thread, &tickets) {
                GateResult::Inadmissible { reason } => {
                    reasons.push(Reason::code(&reason).of(&trigger.id));
                    continue;
                }
                GateResult::Admissible { strength, basis } => (strength, basis),
            };
            let replace = match &strongest {
                None => true,
                Some((best, best_strength, _)) => {
                    let later = strength == *best_strength && trigger.at >= best.at;
                    let weaker = *best_strength != Strength::Explicit && strength == Strength::Explicit;
                    weaker || later
                }
            };
            if replace {
                strongest = Some((trigger.clone(), strength, basis));
            }
        }
        let Some((primary, strength, basis)) = strongest else {
            if !thread.pending.is_empty() {
                let reasons = if reasons.is_empty() { vec![Reason::code("noAdmissible")] } else { reasons };
                let ids = thread.pending.clone();
                self.ignore(&mut thread, ids, reasons, policy, &at);
            }
            self.repo().save_thread(&thread);
            return;
        };
        let version = policy.version();
        let mut parts: Vec<&str> = vec!["eval", &thread.key, &version, &at];
        parts.extend(thread.pending.iter().map(String::as_str));
        let eval_id = key(&parts);
        let evaluation = Evaluation {
            id: eval_id.clone(),
            thread_key: thread.key.clone(),
            trigger_ids: std::mem::take(&mut thread.pending),
            primary: Some(primary.id.clone()),
            strength,
            actor: primary.actor.clone(),
            basis,
            policy_version: version,
            started_at: at.clone(),
            delivered: None,
            deadline: shift(&at, policy.eval_timeout_ms()),
            paused_at: None,
        };
        thread.evaluating = Some(evaluation.clone());
        self.repo().save_thread(&thread);
        for trigger in &triggers {
            let mut disposition = self.repo().disposition(&trigger.id).unwrap_or_else(|| crate::model::TriggerDisposition::at(&at));
            disposition.eval_id = Some(eval_id.clone());
            self.repo().save_disposition(&trigger.id, &disposition);
        }
        self.emit(DomainEvent::EvalStarted { eval_id, thread_key: thread.key.clone(), trigger_ids: evaluation.trigger_ids.clone(), strength });
        self.o.assessor.request(self.candidate_of(&thread, &evaluation));
    }

    /// The candidate of the Eval that holds `trigger_id`, or `None` while no Eval holds it.
    pub(crate) fn evals_candidate(&self, trigger_id: &str) -> Option<Candidate> {
        let thread = self.holding(trigger_id)?;
        let evaluation = thread.evaluating.clone()?;
        Some(self.candidate_of(&thread, &evaluation))
    }

    /// Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does.
    pub(crate) fn evals_decide(&self, trigger_id: &str, outcome: Outcome) -> Result<Decision> {
        let trigger = self.repo().trigger(trigger_id).ok_or_else(|| UserError::new("unknownTrigger"))?;
        let held = self.holding(trigger_id);
        if let Some(eval_id) = &outcome.eval_id {
            if held.as_ref().and_then(|t| t.evaluating.as_ref()).map(|e| e.id.as_str()) != Some(eval_id.as_str()) {
                return Err(UserError::with("evalFinished", &[("eval", eval_id)]));
            }
        }
        // A replayed trigger that already created a ticket does not spawn a second one.
        if matches!(outcome.kind, OutcomeKind::Accept(_)) {
            if let Some(earlier) = self.accepted(&thread_key(&trigger.threads[0])).remove(trigger_id) {
                return Ok(earlier);
            }
        }
        // A follow-up that reached a ticket is its worker's to judge: the main Session may only stop the work on it.
        if !matches!(outcome.kind, OutcomeKind::Stop { .. }) {
            self.left_to_workers(&trigger)?;
        }
        let mut thread = held.unwrap_or_else(|| self.thread_of(&trigger.threads[0]));
        let evaluation = match thread.evaluating.clone().filter(|e| e.trigger_ids.iter().any(|id| id == trigger_id)) {
            Some(evaluation) => evaluation,
            None => {
                let stopped = match &outcome.kind {
                    OutcomeKind::Stop { ticket_id } => Some(ticket_id.as_str()),
                    _ => None,
                };
                self.direct_eval(&mut thread, &trigger, outcome.kind_name(), stopped)?
            }
        };
        // An inferred candidate is accepted only on enabled rules its assessment matched, while assessments may accept.
        if let OutcomeKind::Accept(accept) = &outcome.kind {
            if evaluation.strength != Strength::Explicit && !self.policy().admits_inferred(accept.rules.as_deref().unwrap_or(&[])) {
                return Err(UserError::new("notExplicit"));
            }
        }
        self.decide_eval(thread, evaluation, outcome)
    }

    /// Queue a stored Trigger for a fresh Eval on its primary Thread; false while an Eval holds it.
    pub(crate) fn evals_reevaluate(&self, trigger_id: &str) -> Result<bool> {
        let trigger = self.repo().trigger(trigger_id).ok_or_else(|| UserError::new("unknownTrigger"))?;
        if self.holding(trigger_id).is_some() {
            return Ok(false);
        }
        self.queue_for_eval(&trigger);
        let mut disposition = self.disposition_or_new(trigger_id);
        disposition.requeued = true;
        self.repo().save_disposition(trigger_id, &disposition);
        self.emit(DomainEvent::TriggerRequeued { trigger_id: trigger_id.to_string() });
        Ok(true)
    }

    /// Record that a ticket's Executor hands back a Trigger that reached it as beyond the ticket, and queue it for a
    /// fresh Eval when the ticket decided it and no other ticket still does. A ticket hands a Trigger back once.
    pub(crate) fn evals_handback(&self, ticket_id: &str, trigger_id: &str, reason: &str) -> Result<bool> {
        let ticket = self.require(ticket_id)?;
        if !ticket.has_trigger_input(trigger_id) {
            return Err(UserError::new("notReached"));
        }
        if self.repo().disposition(trigger_id).is_some_and(|d| d.handed_back_by(ticket_id)) {
            return Err(UserError::new("handedBack"));
        }
        let trigger = self.repo().trigger(trigger_id).ok_or_else(|| UserError::new("unknownTrigger"))?;
        Ok(self.hand_back(ticket_id, &trigger, reason))
    }

    /// Marks an `unavailable` Decision dismissed so the overview lists it no more.
    pub(crate) fn evals_dismiss(&self, decision_id: &str) -> Result<Decision> {
        let Some(mut decision) = self.repo().decision(decision_id).filter(|d| d.kind == DecisionKind::Unavailable) else {
            return Err(UserError::new("unknownProblem"));
        };
        decision.dismissed = true;
        self.repo().save_decision(&decision);
        Ok(decision)
    }

    /// Take a Trigger out of its Thread's queue because it was routed by hand.
    pub(crate) fn evals_withdraw(&self, trigger: &Trigger) {
        if let Some(mut thread) = self.repo().thread(&thread_key(&trigger.threads[0])) {
            if thread.pending.contains(&trigger.id) {
                thread.pending.retain(|id| *id != trigger.id);
                self.repo().save_thread(&thread);
            }
        }
    }

    /// End the Eval that holds a Trigger routed to a ticket, since the ticket has it now: one that holds other Triggers
    /// too queues them again for a fresh Eval without it.
    pub(crate) fn evals_routed(&self, trigger_id: &str, ticket_id: &str) {
        let Some(mut held) = self.holding(trigger_id) else {
            return;
        };
        let evaluation = held.evaluating.clone().expect("held by an Eval");
        let reason = Reason::with("routed", "ticket", ticket_id);
        if evaluation.trigger_ids.len() == 1 {
            self.finish(&mut held, &evaluation, Finished::new(DecisionKind::Ignore, vec![reason]));
        } else {
            self.reassess(&mut held, reason.of(trigger_id), &[trigger_id.to_string()]);
        }
    }

    /// Start the Evals in progress again under the new Policy version, and say that it changed.
    pub(crate) fn evals_policy_changed(&self, from: &str, to: &str) {
        for mut thread in self.repo().active_threads() {
            if thread.evaluating.is_some() {
                self.reassess(&mut thread, Reason::code("policyChanged"), &[]);
            }
        }
        self.emit(DomainEvent::PolicyChanged { from: from.to_string(), to: to.to_string() });
    }

    /// End a Thread's Eval as unavailable for `reason` and queue its Triggers, except `without`, for a new Eval ahead of the others.
    fn reassess(&self, thread: &mut Thread, reason: Reason, without: &[String]) -> Decision {
        let evaluation = thread.evaluating.clone().expect("an Eval to reassess");
        let ids: Vec<String> = evaluation.trigger_ids.iter().filter(|id| !without.contains(id)).cloned().collect();
        let decision = self.finish(thread, &evaluation, Finished::new(DecisionKind::Unavailable, vec![reason]));
        if let Some(mut current) = self.repo().thread(&thread.key) {
            current.pending.retain(|id| !ids.contains(id));
            current.pending.splice(0..0, ids);
            self.repo().save_thread(&current);
        }
        decision
    }

    /// The Thread whose Eval holds a Trigger: an Eval runs on the primary Thread of each Trigger it holds.
    fn holding(&self, trigger_id: &str) -> Option<Thread> {
        let trigger = self.repo().trigger(trigger_id)?;
        let thread = self.repo().thread(&thread_key(trigger.threads.first()?))?;
        thread.evaluating.as_ref().is_some_and(|e| e.trigger_ids.iter().any(|id| id == trigger_id)).then_some(thread)
    }

    fn candidate_of(&self, thread: &Thread, evaluation: &Evaluation) -> Candidate {
        Candidate {
            eval_id: evaluation.id.clone(),
            thread: thread.clone(),
            triggers: evaluation.trigger_ids.iter().filter_map(|id| self.repo().trigger(id)).collect(),
            strength: evaluation.strength,
            policy_version: evaluation.policy_version.clone(),
            tickets: self.tickets_on_thread(thread),
        }
    }

    /// Record that the queued Triggers `ids` of a Thread start no Eval, for `reason`, and take them out of its queue.
    /// Its id differs from an Eval's, so it never replaces the Decision of an earlier Eval of the same Triggers.
    fn ignore(&self, thread: &mut Thread, ids: Vec<String>, reason: Vec<Reason>, policy: &dyn Policy, at: &str) {
        let version = policy.version();
        let mut parts: Vec<&str> = vec!["eval", &thread.key, "ignored", &version, at];
        parts.extend(ids.iter().map(String::as_str));
        let evaluation = Evaluation {
            id: key(&parts),
            thread_key: thread.key.clone(),
            trigger_ids: ids.clone(),
            primary: None,
            strength: Strength::Inferred,
            actor: ActorRef { source: thread.reference.source.clone(), id: String::new() },
            basis: MandateBasis::via(BasisVia::Followup),
            policy_version: version,
            started_at: at.to_string(),
            delivered: None,
            deadline: at.to_string(),
            paused_at: None,
        };
        self.record(thread, &evaluation, Finished::new(DecisionKind::Ignore, reason));
        thread.pending.retain(|id| !ids.contains(id));
        thread.expired = None;
    }

    /// The accept Decisions of the Triggers whose primary Thread is `thread_key`, by Trigger: what each one started.
    fn accepted(&self, thread_key: &str) -> HashMap<String, Decision> {
        let mut accepted = HashMap::new();
        for decision in self.repo().decisions_by_thread(thread_key) {
            if decision.kind != DecisionKind::Accept || decision.ticket_id.is_none() {
                continue;
            }
            for id in &decision.trigger_ids {
                accepted.entry(id.clone()).or_insert_with(|| decision.clone());
            }
        }
        accepted
    }

    /// A gate-only Eval of one Trigger, for an outcome decided without a queued Eval, such as a person's explicit
    /// request. It is decided at once, beside an Eval its Thread may have in progress, and takes the Trigger out of the
    /// queue. Its id names the outcome's kind, so a stop and an accept of one message at the same moment are two Decisions.
    fn direct_eval(&self, thread: &mut Thread, trigger: &Trigger, kind: &str, ticket_id: Option<&str>) -> Result<Evaluation> {
        let policy = self.policy();
        let (strength, basis) = match policy.gate(trigger, thread, &self.tickets_on_thread(thread)) {
            GateResult::Inadmissible { reason } => return Err(UserError::with("notAdmissible", &[("reason", &reason)])),
            GateResult::Admissible { strength, basis } => (strength, basis),
        };
        let at = self.now();
        if thread.pending.contains(&trigger.id) {
            thread.pending.retain(|id| *id != trigger.id);
            self.repo().save_thread(thread);
        }
        let mut parts = vec!["eval", thread.key.as_str(), "direct", trigger.id.as_str(), kind];
        parts.extend(ticket_id);
        parts.push(&at);
        Ok(Evaluation {
            id: key(&parts),
            thread_key: thread.key.clone(),
            trigger_ids: vec![trigger.id.clone()],
            primary: Some(trigger.id.clone()),
            strength,
            actor: trigger.actor.clone(),
            basis,
            policy_version: policy.version(),
            started_at: at.clone(),
            delivered: None,
            deadline: at,
            paused_at: None,
        })
    }

    /// Apply an outcome to an Eval of a Thread: the one in progress, or a gate-only one.
    fn decide_eval(&self, mut thread: Thread, evaluation: Evaluation, outcome: Outcome) -> Result<Decision> {
        let own = thread.evaluating.as_ref().is_some_and(|e| e.id == evaluation.id);
        // Requeue if Policy changed without a live policy_changed call (such as across a restart).
        if self.policy().version() != evaluation.policy_version {
            if own {
                return Ok(self.reassess(&mut thread, Reason::code("policyChanged"), &[]));
            }
            return Ok(self.finish(
                &mut thread,
                &evaluation,
                Finished::new(DecisionKind::Unavailable, vec![Reason::code("policyChanged")]).audit(outcome.audit),
            ));
        }
        let said = match &outcome.reason {
            Why::Said(text) => Some(text.clone()),
            Why::Code(_) => None,
        };
        match outcome.kind {
            OutcomeKind::Ignore | OutcomeKind::Unavailable => {
                let ignore = matches!(outcome.kind, OutcomeKind::Ignore);
                // An inferred candidate ignored without an assessment, from its card, says so beside the reason given.
                let mut reason = if ignore && evaluation.strength != Strength::Explicit && outcome.audit.is_none() {
                    vec![Reason::code("ignoredFromCard")]
                } else {
                    Vec::new()
                };
                reason.extend(outcome.reason.reasons());
                let kind = if ignore { DecisionKind::Ignore } else { DecisionKind::Unavailable };
                Ok(self.finish(&mut thread, &evaluation, Finished::new(kind, reason).audit(outcome.audit)))
            }
            OutcomeKind::Stop { ticket_id } => {
                let Some(ticket) = self.repo().ticket(&ticket_id).filter(|t| t.live()) else {
                    return Ok(self.finish(
                        &mut thread,
                        &evaluation,
                        Finished::new(DecisionKind::Ignore, vec![Reason::code("stopUnknown")]).audit(outcome.audit),
                    ));
                };
                if evaluation.strength != Strength::Explicit {
                    return Ok(self.finish(
                        &mut thread,
                        &evaluation,
                        Finished::new(DecisionKind::Ignore, vec![Reason::code("stopNotExplicit")]).audit(outcome.audit),
                    ));
                }
                let mut finished = Finished::new(DecisionKind::Stop, outcome.reason.reasons()).audit(outcome.audit);
                finished.ticket_id = Some(ticket.id.clone());
                let decision = self.finish(&mut thread, &evaluation, finished);
                self.tickets_end(&ticket.id, TicketEndBy::Human, TicketOutcome::Stopped, None, said.as_deref())?;
                Ok(decision)
            }
            OutcomeKind::Accept(accept) => self.accept(&mut thread, &evaluation, &accept, outcome.reason.reasons(), outcome.audit),
        }
    }

    /// Record an accept with the Mandate the Eval gives, and have Tickets create its ticket.
    fn accept(&self, thread: &mut Thread, evaluation: &Evaluation, accept: &Accept, reason: Vec<Reason>, audit: Option<Json>) -> Result<Decision> {
        let at = self.now();
        let mut basis = evaluation.basis.clone();
        if let Some(rules) = &accept.rules {
            basis.rules = Some(rules.clone());
        }
        let mandate = Mandate {
            strength: evaluation.strength,
            policy_version: evaluation.policy_version.clone(),
            basis,
            actor: evaluation.actor.clone(),
            scope: accept.scope.clone(),
        };
        let ticket_id = key(&["ticket", &evaluation.id]);
        let mut finished = Finished::new(DecisionKind::Accept, reason).audit(audit);
        finished.mandate = Some(mandate.clone());
        finished.ticket_id = Some(ticket_id.clone());
        let decision = self.finish(thread, evaluation, finished);
        self.tickets_create(&ticket_id, &decision.id, mandate, evaluation, accept, &at)?;
        Ok(decision)
    }

    /// Record an Eval's Decision; the Thread's own Eval ends with it, while a gate-only one leaves the Thread's Eval going.
    fn finish(&self, thread: &mut Thread, evaluation: &Evaluation, outcome: Finished) -> Decision {
        let decision = self.record(thread, evaluation, outcome);
        if thread.evaluating.as_ref().is_none_or(|e| e.id != evaluation.id) {
            return decision;
        }
        thread.evaluating = None;
        thread.expired = None;
        self.repo().save_thread(thread);
        self.o.assessor.release(&evaluation.id);
        decision
    }

    fn record(&self, thread: &Thread, evaluation: &Evaluation, outcome: Finished) -> Decision {
        let at = self.now();
        let decision = Decision {
            id: key(&["decision", &evaluation.id]),
            eval_id: evaluation.id.clone(),
            thread_key: thread.key.clone(),
            trigger_ids: evaluation.trigger_ids.clone(),
            policy_version: evaluation.policy_version.clone(),
            at: at.clone(),
            kind: outcome.kind,
            reason: outcome.reason,
            strength: evaluation.strength,
            ticket_id: outcome.ticket_id,
            mandate: outcome.mandate,
            audit: outcome.audit,
            dismissed: false,
        };
        self.repo().save_decision(&decision);
        for id in &evaluation.trigger_ids {
            let mut disposition = self.repo().disposition(id).unwrap_or_else(|| crate::model::TriggerDisposition::at(&at));
            disposition.eval_id = Some(evaluation.id.clone());
            disposition.decision_id = Some(decision.id.clone());
            self.repo().save_disposition(id, &disposition);
        }
        self.emit(DomainEvent::DecisionRecorded { decision_id: decision.id.clone(), kind: decision.kind, thread_key: thread.key.clone() });
        decision
    }
}
