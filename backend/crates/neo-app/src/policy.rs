//! The Policy the settings make: who may originate work, whether a Mandate still holds, and what an assessment decides.
//!
//! Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person
//! across Sources.

use crate::settings::{Admission, Allowed, Settings, SourcePolicy, CHAT_SOURCE};
use neo_core::ids::key;
use neo_core::model::{
    AcceptMode, Addressed, AdmissionCell, BasisVia, Json, Mandate, MandateBasis, Observation, PolicyEffect, RuleEffect, Strength, Thread, Ticket, Trigger,
};
use neo_core::ports::{Accept, GateResult, Outcome, OutcomeKind, Policy, ScopeResult, SourceScope, Why};
use neo_core::reasons::Reason;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

/// Bumped when the meaning of stored Mandates changes.
pub const POLICY_REVISION: &str = "mandate-v4";

/// A version of the settings that bear on authorization: rules, accept mode and senders. Models, concurrency and the
/// pause change nothing an earlier Decision relied on.
pub fn policy_version(settings: &Settings) -> String {
    #[derive(Serialize)]
    struct Parts<'a> {
        rules: &'a [crate::settings::Rule],
        mode: AcceptMode,
        sources: &'a BTreeMap<String, SourcePolicy>,
    }
    let parts = Parts { rules: &settings.policy.rules, mode: settings.eval.mode, sources: &settings.policy.sources };
    key(&[POLICY_REVISION, &serde_json::to_string(&parts).expect("policy parts serialize")])
}

/// The installed Sources as the domain sees them: the chat Source listens to its conversations without fan-out, since
/// the main Session routes each message to one ticket.
pub struct Sources;

impl SourceScope for Sources {
    fn scope(&self, source: &str, _meta: &Json) -> ScopeResult {
        if source == CHAT_SOURCE {
            ScopeResult::Listened { observed: false, row: None, fanout: false }
        } else {
            ScopeResult::Ignored { reason: "source_not_installed".into() }
        }
    }
}

fn sender_name(entry: &Allowed) -> String {
    entry.name.clone().unwrap_or_else(|| entry.id.clone())
}

fn default_admission(cell: AdmissionCell) -> Admission {
    match cell {
        AdmissionCell::ListedUnaddressed => Admission::Inferred,
        AdmissionCell::UnlistedAddressed | AdmissionCell::UnlistedUnaddressed => Admission::Ignore,
    }
}

fn rank(strength: Strength) -> Admission {
    match strength {
        Strength::Explicit => Admission::Explicit,
        Strength::Inferred => Admission::Inferred,
    }
}

/// The Policy of one settings snapshot.
pub struct SettingsPolicy {
    settings: Settings,
    version: String,
    sources: Arc<dyn SourceScope>,
}

impl SettingsPolicy {
    /// The Policy these settings make over the installed Sources.
    pub fn new(settings: Settings, sources: Arc<dyn SourceScope>) -> Self {
        let version = policy_version(&settings);
        SettingsPolicy { settings, version, sources }
    }

    fn mode(&self) -> AcceptMode {
        self.settings.eval.mode
    }
    fn admission(&self, source: &str, row: Option<&str>, cell: AdmissionCell) -> Admission {
        let configured = row.and_then(|row| self.settings.policy.sources.get(source)?.admission.get(row)).and_then(|row| match cell {
            AdmissionCell::ListedUnaddressed => row.listed_unaddressed,
            AdmissionCell::UnlistedAddressed => row.unlisted_addressed,
            AdmissionCell::UnlistedUnaddressed => row.unlisted_unaddressed,
        });
        configured.unwrap_or_else(|| default_admission(cell))
    }
    fn rules_on(&self, rules: Option<&Vec<String>>) -> bool {
        rules.map(Vec::as_slice).unwrap_or(&[]).iter().all(|id| self.settings.policy.rules.iter().any(|rule| rule.enabled && rule.id == *id))
    }

    /// Non-human triggers: only listed bots, as inferred candidates, and senderless system events may pass.
    fn machine_gate(&self, trigger: &Trigger) -> GateResult {
        let refuse = |reason: &str| GateResult::Inadmissible { reason: reason.into() };
        let bot = if trigger.actor.id.is_empty() { None } else { self.settings.listed_bot(&trigger.actor.source, &trigger.actor.id) };
        if !trigger.actor.id.is_empty() && bot.is_none() {
            return refuse("not_human");
        }
        let ScopeResult::Listened { observed, row, .. } = self.sources.scope(&trigger.source, &trigger.meta) else { return refuse("not_human") };
        if trigger.addressed.is_none() && !observed {
            return refuse("not_human");
        }
        let mode = self.mode();
        let recorded = |via: BasisVia, sender: Option<String>| MandateBasis {
            source: Some(trigger.source.clone()),
            scope: Some(trigger.meta.clone()),
            row: row.clone(),
            sender,
            rules: None,
            via,
        };
        if let Some(bot) = bot {
            if mode == AcceptMode::Off {
                return refuse("admission_ignored");
            }
            let via = BasisVia::Bot { addressed: trigger.addressed, observation: Observation { mode } };
            return GateResult::Admissible { strength: Strength::Inferred, basis: recorded(via, Some(sender_name(bot))) };
        }
        let cell = AdmissionCell::UnlistedUnaddressed;
        if self.admission(&trigger.source, row.as_deref(), cell) != Admission::Inferred || mode == AcceptMode::Off {
            return refuse("admission_ignored");
        }
        let via = BasisVia::Admission { cell, addressed: None, observation: Some(Observation { mode }) };
        GateResult::Admissible { strength: Strength::Inferred, basis: recorded(via, None) }
    }
}

/// Whether a thread has tickets of its own, not only ones that follow it for context.
fn participating(thread: &Thread, tickets: &[Ticket]) -> bool {
    thread.subscriptions.iter().chain(tickets.iter().map(|ticket| &ticket.id)).any(|id| !thread.context.contains(id))
}

impl Policy for SettingsPolicy {
    fn version(&self) -> String {
        self.version.clone()
    }
    fn paused(&self) -> bool {
        self.settings.paused
    }
    fn eval_timeout_ms(&self) -> i64 {
        i64::from(self.settings.eval.timeout_seconds) * 1000
    }

    fn gate(&self, trigger: &Trigger, thread: &Thread, tickets: &[Ticket]) -> GateResult {
        if !trigger.human {
            return self.machine_gate(trigger);
        }
        let allowed = self.settings.allowed_sender(&trigger.actor.source, &trigger.actor.id);
        let (listened, observed, row) = match self.sources.scope(&trigger.source, &trigger.meta) {
            ScopeResult::Listened { observed, row, .. } => (true, observed, row),
            ScopeResult::Ignored { .. } => (false, false, None),
        };
        let recorded = |via: BasisVia| MandateBasis {
            source: Some(trigger.source.clone()),
            scope: Some(trigger.meta.clone()),
            row: row.clone(),
            sender: allowed.map(sender_name),
            rules: None,
            via,
        };
        let admit = |strength: Strength, via: BasisVia| GateResult::Admissible { strength, basis: recorded(via) };
        let cell = match (allowed.is_some(), trigger.addressed) {
            (true, Some(addressed)) => return admit(Strength::Explicit, BasisVia::Addressed { addressed }),
            (true, None) => AdmissionCell::ListedUnaddressed,
            (false, Some(_)) => AdmissionCell::UnlistedAddressed,
            (false, None) => AdmissionCell::UnlistedUnaddressed,
        };
        // An unaddressed message only uses the admission table when the Source observes every message in that scope.
        let receivable = trigger.addressed.is_some() || (listened && observed);
        let admission = if receivable { self.admission(&trigger.source, row.as_deref(), cell) } else { Admission::Ignore };
        let by_cell = |observation: Option<Observation>| BasisVia::Admission { cell, addressed: trigger.addressed, observation };
        // An explicit cell comes before thread follow-ups, so a thread's tickets never weaken an explicit request.
        if admission == Admission::Explicit {
            return admit(Strength::Explicit, by_cell(None));
        }
        let mode = self.mode();
        // A direct-message thread belongs to one sender, and an inferred follow-up needs an accept mode other than off.
        let stranger_direct = trigger.addressed == Some(Addressed::Direct) && allowed.is_none();
        if !stranger_direct && (allowed.is_some() || mode != AcceptMode::Off) && participating(thread, tickets) {
            return admit(if allowed.is_some() { Strength::Explicit } else { Strength::Inferred }, BasisVia::Followup);
        }
        if admission == Admission::Inferred && mode != AcceptMode::Off {
            return admit(Strength::Inferred, by_cell(Some(Observation { mode })));
        }
        let reason = if allowed.is_none() {
            "not_a_member"
        } else if receivable && admission == Admission::Ignore {
            "admission_ignored"
        } else {
            "no_mention"
        };
        GateResult::Inadmissible { reason: reason.into() }
    }

    fn revalidate(&self, mandate: &Mandate) -> bool {
        let basis = &mandate.basis;
        let current = match (&basis.source, &basis.scope) {
            (Some(source), Some(scope)) => Some(self.sources.scope(source, scope)),
            _ => None,
        };
        let row = match &current {
            Some(ScopeResult::Ignored { .. }) => return false,
            Some(ScopeResult::Listened { row, .. }) => row.clone(),
            None => None,
        };
        let auto = self.mode() == AcceptMode::Auto && self.rules_on(basis.rules.as_ref());
        let listed = self.settings.allowed_sender(&mandate.actor.source, &mandate.actor.id).is_some();
        match &basis.via {
            // An explicit follow-up stays valid; an inferred one needs auto mode and its matched rules enabled.
            BasisVia::Followup => mandate.strength == Strength::Explicit || auto,
            // A bot's candidate holds only while the bot stays on its Source's bot list.
            BasisVia::Bot { .. } => self.settings.listed_bot(&mandate.actor.source, &mandate.actor.id).is_some() && auto,
            BasisVia::Addressed { .. } => listed,
            // An admission-table Mandate holds while the sender's cell now still grants at least its strength.
            BasisVia::Admission { cell, observation, .. } => {
                // A listed sender who addresses the agent is always explicit and uses no cell.
                if *cell == AdmissionCell::UnlistedAddressed && listed {
                    return true;
                }
                // A sender listed since acceptance moves to the listed cell.
                let now = if *cell == AdmissionCell::UnlistedUnaddressed && listed { AdmissionCell::ListedUnaddressed } else { *cell };
                if now == AdmissionCell::ListedUnaddressed && !listed {
                    return false;
                }
                let admission = self.admission(basis.source.as_deref().unwrap_or(""), row.as_deref(), now);
                if admission < rank(mandate.strength) {
                    return false;
                }
                mandate.strength == Strength::Explicit || observation.is_none() || auto
            }
        }
    }

    fn admits_inferred(&self, rules: &[String]) -> bool {
        self.mode() == AcceptMode::Auto && !rules.is_empty() && self.rules_on(Some(&rules.to_vec()))
    }
}

/// How a settings change from `old` to `now` bears on each open ticket's authorization or matched rules.
pub fn policy_effects(tickets: &[Ticket], old: &Settings, now: &Settings, sources: &Arc<dyn SourceScope>) -> HashMap<String, PolicyEffect> {
    let policy = |settings: &Settings| SettingsPolicy::new(settings.clone(), sources.clone());
    let (before, after) = (policy(old), policy(now));
    // The settings now, with the accept mode and rules as before: what holds under them was not lost to those.
    let mut as_before = now.clone();
    as_before.eval = old.eval.clone();
    as_before.policy.rules = old.policy.rules.clone();
    let as_before = policy(&as_before);
    let mut effects = HashMap::new();
    for ticket in tickets {
        let mandate = &ticket.mandate;
        let mut effect = PolicyEffect::default();
        for id in mandate.basis.rules.iter().flatten() {
            let was = old.policy.rules.iter().find(|rule| rule.id == *id);
            match now.policy.rules.iter().find(|rule| rule.id == *id).filter(|rule| rule.enabled) {
                None => {
                    if let Some(was) = was.filter(|rule| rule.enabled) {
                        effect.rules.push(RuleEffect { id: id.clone(), name: was.name.clone(), change: "disabled".into(), instruction: None });
                    }
                }
                Some(is) if was != Some(is) => {
                    effect.rules.push(RuleEffect { id: id.clone(), name: is.name.clone(), change: "changed".into(), instruction: Some(is.instruction.clone()) })
                }
                Some(_) => {}
            }
        }
        if before.revalidate(mandate) && !after.revalidate(mandate) {
            if !as_before.revalidate(mandate) {
                effect.requester_allowed = Some(false);
                effect.requester = Some(mandate.actor.clone());
            } else if mandate.strength == Strength::Inferred && old.eval.mode == AcceptMode::Auto && now.eval.mode != AcceptMode::Auto {
                effect.proactive = Some(false);
            }
        }
        if effect != PolicyEffect::default() {
            effects.insert(ticket.id.clone(), effect);
        }
    }
    effects
}

/// One rule's judgement in an assessment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleAssessment {
    /// The rule judged.
    pub rule_id: String,
    /// Whether the candidate matches it.
    pub matched: bool,
    /// Why, in words.
    pub reason: String,
}

/// What the assessor's model returned for a candidate.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assessment {
    /// `accept`, `ignore` or `unavailable`.
    pub decision: String,
    /// One judgement for every enabled rule.
    pub rule_assessments: Vec<RuleAssessment>,
    /// Whether implementation intent and a settled target are established.
    #[serde(default)]
    pub direction: Value,
    /// The ticket's title.
    #[serde(default)]
    pub title: String,
    /// What the Mandate authorizes.
    #[serde(default)]
    pub scope: String,
    /// Why, in words.
    pub reason: String,
    /// The words that show the person wants the work done.
    #[serde(default)]
    pub intent_evidence: Option<String>,
    /// The acknowledgement to send.
    #[serde(default)]
    pub acknowledgement: Option<String>,
    /// The ticket's requested short name.
    #[serde(default)]
    pub worktree_name: Option<String>,
}

/// Whether an assessment established implementation intent and a settled target without open design decisions.
pub fn direction_allowed(value: &Value) -> bool {
    let Some(direction) = value.as_object() else { return false };
    let evidence = direction.get("evidence").and_then(Value::as_str).map(str::trim).unwrap_or("");
    direction.len() == 4
        && direction.get("implementation_requested") == Some(&Value::Bool(true))
        && matches!(direction.get("target_basis").and_then(Value::as_str), Some("specified" | "existing-standard"))
        && direction.get("requires_design_decision") == Some(&Value::Bool(false))
        && !evidence.is_empty()
        && evidence.chars().count() <= 700
}

/// Validate an assessment against the enabled rules and turn it into the Engine's outcome. An accept needs a settled
/// direction, a matched enabled rule and intent evidence, and an inferred candidate is accepted only in `auto` mode;
/// otherwise the Decision records that it would have been.
pub fn assessment_outcome(assessment: &Assessment, settings: &Settings, strength: Strength) -> Result<Outcome, String> {
    let enabled: Vec<&str> = settings.policy.rules.iter().filter(|rule| rule.enabled).map(|rule| rule.id.as_str()).collect();
    let judged = &assessment.rule_assessments;
    let ids: BTreeSet<&str> = judged.iter().map(|item| item.rule_id.as_str()).collect();
    if judged.len() != enabled.len() || ids.len() != judged.len() || enabled.iter().any(|id| !ids.contains(id)) {
        return Err("Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed".into());
    }
    let matches: Vec<&RuleAssessment> = judged.iter().filter(|item| item.matched).collect();
    let mut audit = Json::new();
    audit.insert("matches".into(), matches.iter().map(|item| json!({"rule_id": item.rule_id, "reason": item.reason})).collect());
    audit.insert("rule_assessments".into(), serde_json::to_value(judged).expect("assessments serialize"));
    audit.insert("direction".into(), assessment.direction.clone());
    if let Some(evidence) = assessment.intent_evidence.as_ref().filter(|evidence| !evidence.is_empty()) {
        audit.insert("intent_evidence".into(), evidence.clone().into());
    }
    let outcome = |kind: OutcomeKind, reason: Why, audit: Json| Outcome { kind, reason, audit: Some(audit), eval_id: None };
    let said = Why::Said(assessment.reason.clone());
    match assessment.decision.as_str() {
        "accept" => {}
        "ignore" => return Ok(outcome(OutcomeKind::Ignore, said, audit)),
        "unavailable" => return Ok(outcome(OutcomeKind::Unavailable, said, audit)),
        other => return Err(format!("Unknown decision {other:?}; it is accept, ignore or unavailable")),
    }
    if !direction_allowed(&assessment.direction) {
        return Ok(outcome(OutcomeKind::Ignore, Why::Code(Reason::code("directionUnsettled")), audit));
    }
    if matches.is_empty() {
        return Ok(outcome(OutcomeKind::Ignore, Why::Code(Reason::code("noRuleMatched")), audit));
    }
    if !audit.contains_key("intent_evidence") {
        return Err("Acceptance requires intent_evidence".into());
    }
    if strength == Strength::Inferred && settings.eval.mode != AcceptMode::Auto {
        audit.insert("would_accept".into(), true.into());
        audit.insert("proposal".into(), json!({"title": assessment.title, "scope": assessment.scope, "worktree_name": assessment.worktree_name}));
        return Ok(outcome(OutcomeKind::Ignore, Why::Code(Reason::with("observed", "text", &assessment.reason)), audit));
    }
    let accept = Accept {
        title: assessment.title.clone(),
        scope: assessment.scope.clone(),
        acknowledgement: assessment.acknowledgement.clone().filter(|text| !text.is_empty()),
        rules: Some(matches.iter().map(|item| item.rule_id.clone()).collect()),
        name: assessment.worktree_name.clone().filter(|name| !name.is_empty()),
        note: None,
    };
    Ok(outcome(OutcomeKind::Accept(accept), said, audit))
}
