//! The Policy the settings make: the gate, Mandate revalidation, Policy effects and assessment outcomes.

use neo_app::policy::*;
use neo_app::settings::*;
use neo_core::model::*;
use neo_core::ports::{GateResult, OutcomeKind, Policy, ScopeResult, SourceScope, Why};
use serde_json::json;
use std::sync::Arc;

/// A Source that observes every message of its rooms, to exercise unaddressed messages and admission rows.
struct Rooms;

impl SourceScope for Rooms {
    fn scope(&self, source: &str, meta: &Json) -> ScopeResult {
        if meta.contains_key("left") {
            return ScopeResult::Ignored { reason: "room_left".into() };
        }
        if source == "room" {
            ScopeResult::Listened { observed: true, row: meta.get("room").and_then(|room| room.as_str()).map(str::to_string), fanout: true }
        } else {
            Sources.scope(source, meta)
        }
    }
}

fn settings(value: serde_json::Value) -> Settings {
    Settings::parse(value).unwrap()
}
fn policy(settings: &Settings) -> SettingsPolicy {
    SettingsPolicy::new(settings.clone(), Arc::new(Rooms))
}
fn chat(sender: &str) -> Trigger {
    Trigger {
        id: format!("g-{sender}"),
        source: CHAT_SOURCE.into(),
        threads: vec![ThreadRef { source: CHAT_SOURCE.into(), id: WEB_THREAD.into() }],
        actor: ActorRef { source: CHAT_SOURCE.into(), id: sender.into() },
        human: true,
        addressed: Some(Addressed::Direct),
        at: "2026-01-01T00:00:00.000Z".into(),
        text: "fix the typo".into(),
        channel: None,
        url: None,
        meta: Json::new(),
    }
}
fn room(sender: &str, addressed: Option<Addressed>, human: bool) -> Trigger {
    let mut trigger = chat(sender);
    trigger.source = "room".into();
    trigger.actor.source = "room".into();
    trigger.threads = vec![ThreadRef { source: "room".into(), id: "r1".into() }];
    trigger.addressed = addressed;
    trigger.human = human;
    trigger.meta.insert("room".into(), "r1".into());
    trigger
}
fn thread(subscriptions: &[&str], context: &[&str]) -> Thread {
    Thread {
        key: "room:r1".into(),
        reference: ThreadRef { source: "room".into(), id: "r1".into() },
        created_at: "t".into(),
        last_at: None,
        subscriptions: subscriptions.iter().map(|id| id.to_string()).collect(),
        context: context.iter().map(|id| id.to_string()).collect(),
        correlated: vec![],
        pending: vec![],
        evaluating: None,
        expired: None,
        meta: Json::new(),
    }
}
fn gate(settings: &Settings, trigger: &Trigger, thread: &Thread) -> Result<(Strength, MandateBasis), String> {
    match policy(settings).gate(trigger, thread, &[]) {
        GateResult::Admissible { strength, basis } => Ok((strength, basis)),
        GateResult::Inadmissible { reason } => Err(reason),
    }
}
fn mandate(settings: &Settings, trigger: &Trigger, thread: &Thread, rules: Option<&[&str]>) -> Mandate {
    let (strength, mut basis) = gate(settings, trigger, thread).expect("the gate admits it");
    basis.rules = rules.map(|rules| rules.iter().map(|id| id.to_string()).collect());
    Mandate { strength, policy_version: policy_version(settings), basis, actor: trigger.actor.clone(), scope: "small".into() }
}
fn room_settings(extra: serde_json::Value) -> Settings {
    let mut value = json!({"eval": {"mode": "auto"}, "policy": {"sources": {
        "chat": {"allowed": [{"id": "web:local"}]},
        "room": {"allowed": [{"id": "alice", "name": "Alice"}], "bots": [{"id": "ci-bot"}]}
    }}});
    if let Some(admission) = extra.get("admission") {
        value["policy"]["sources"]["room"]["admission"] = admission.clone();
    }
    if let Some(mode) = extra.get("mode") {
        value["eval"]["mode"] = mode.clone();
    }
    settings(value)
}

// chat: the only installed Source

#[test]
fn admits_a_listed_chat_senders_direct_request_as_explicit_and_no_one_elses() {
    let defaults = Settings::default();
    let (strength, basis) = gate(&defaults, &chat(WEB_SENDER), &thread(&[], &[])).unwrap();
    assert_eq!(strength, Strength::Explicit);
    assert_eq!(basis.via, BasisVia::Addressed { addressed: Addressed::Direct });
    assert_eq!((basis.source.as_deref(), basis.sender.as_deref(), basis.row), (Some("chat"), Some("web:local"), None));
    assert_eq!(gate(&defaults, &chat("wechat:stranger"), &thread(&[], &[])), Err("not_a_member".into()));
    // A direct-message thread belongs to its sender: a stranger there is no follow-up, whatever tickets it has.
    assert_eq!(gate(&defaults, &chat("wechat:stranger"), &thread(&["t1"], &[])), Err("not_a_member".into()));
    let mut bound = defaults.clone();
    bound.allow_chat_sender("wechat:me@im.wechat");
    assert_eq!(gate(&bound, &chat("wechat:ME@im.wechat"), &thread(&[], &[])).map(|(strength, _)| strength), Ok(Strength::Explicit));
    let mut robot = chat(WEB_SENDER);
    robot.human = false;
    assert_eq!(gate(&defaults, &robot, &thread(&[], &[])), Err("not_human".into()));
}

#[test]
fn keeps_a_chat_mandate_while_its_sender_stays_listed() {
    let defaults = Settings::default();
    let held = mandate(&defaults, &chat(WEB_SENDER), &thread(&[], &[]), None);
    assert!(policy(&defaults).revalidate(&held));
    let mut removed = defaults.clone();
    removed.disallow_chat_sender(WEB_SENDER);
    assert!(!policy(&removed).revalidate(&held));
    // A Mandate received on a Source that is no longer installed does not hold.
    let mut elsewhere = held.clone();
    elsewhere.basis.source = Some("gone".into());
    assert!(!policy(&defaults).revalidate(&elsewhere));
}

#[test]
fn changes_the_policy_version_for_authorization_rules_and_mode_only() {
    let base = Settings::default();
    let version = policy_version(&base);
    let mut other = base.clone();
    other.paused = true;
    other.kernel = Kernel::Claude;
    other.executor.max_workers = 9;
    other.eval.timeout_seconds = 300;
    other.models.insert(Kernel::Claude, RoleModels::default());
    assert_eq!(policy_version(&other), version);
    let mut mode = base.clone();
    mode.eval.mode = AcceptMode::Auto;
    assert_ne!(policy_version(&mode), version);
    let mut senders = base.clone();
    senders.allow_chat_sender("wechat:me");
    assert_ne!(policy_version(&senders), version);
    let mut rules = base.clone();
    rules.policy.rules[0].enabled = false;
    assert_ne!(policy_version(&rules), version);
    assert_eq!(policy(&other).version(), version);
    assert!(policy(&other).paused());
    assert_eq!(policy(&other).eval_timeout_ms(), 300_000);
}

// a Source that observes rooms

#[test]
fn judges_unaddressed_and_unlisted_messages_by_the_admission_table() {
    let auto = room_settings(json!({}));
    let alone = thread(&[], &[]);
    // A listed sender who addresses the agent is explicit; unaddressed, an inferred candidate by default.
    let (strength, basis) = gate(&auto, &room("ALICE", Some(Addressed::Mention), true), &alone).unwrap();
    assert_eq!((strength, basis.sender.as_deref(), basis.row.as_deref()), (Strength::Explicit, Some("Alice"), Some("r1")));
    let (strength, basis) = gate(&auto, &room("alice", None, true), &alone).unwrap();
    assert_eq!(strength, Strength::Inferred);
    assert_eq!(
        basis.via,
        BasisVia::Admission { cell: AdmissionCell::ListedUnaddressed, addressed: None, observation: Some(Observation { mode: AcceptMode::Auto }) }
    );
    // Unlisted senders are ignored by default, addressed or not.
    assert_eq!(gate(&auto, &room("mallory", Some(Addressed::Mention), true), &alone), Err("not_a_member".into()));
    assert_eq!(gate(&auto, &room("mallory", None, true), &alone), Err("not_a_member".into()));
    // The room's row can open it up, or close the listed sender's unaddressed messages.
    let open = room_settings(json!({"admission": {"r1": {"unlistedAddressed": "explicit", "unlistedUnaddressed": "inferred", "listedUnaddressed": "ignore"}}}));
    let (strength, basis) = gate(&open, &room("mallory", Some(Addressed::Mention), true), &alone).unwrap();
    assert_eq!(strength, Strength::Explicit);
    assert_eq!(basis.via, BasisVia::Admission { cell: AdmissionCell::UnlistedAddressed, addressed: Some(Addressed::Mention), observation: None });
    assert_eq!(gate(&open, &room("mallory", None, true), &alone).map(|(strength, _)| strength), Ok(Strength::Inferred));
    assert_eq!(gate(&open, &room("alice", None, true), &alone), Err("admission_ignored".into()));
    // Another room keeps the defaults.
    let mut elsewhere = room("mallory", Some(Addressed::Mention), true);
    elsewhere.meta.insert("room".into(), "r2".into());
    assert_eq!(gate(&open, &elsewhere, &alone), Err("not_a_member".into()));
    // With the accept mode off, nothing is inferred.
    let off = room_settings(json!({"mode": "off"}));
    assert_eq!(gate(&off, &room("alice", None, true), &alone), Err("no_mention".into()));
}

#[test]
fn takes_a_message_on_a_thread_with_tickets_of_its_own_as_a_follow_up() {
    let auto = room_settings(json!({}));
    let (strength, basis) = gate(&auto, &room("mallory", None, true), &thread(&["t1"], &[])).unwrap();
    assert_eq!((strength, basis.via), (Strength::Inferred, BasisVia::Followup));
    assert_eq!(
        gate(&auto, &room("alice", None, true), &thread(&["t1"], &[])).map(|(strength, basis)| (strength, basis.via)),
        Ok((Strength::Explicit, BasisVia::Followup))
    );
    // A ticket that follows the thread only for context makes no follow-up.
    assert_eq!(gate(&auto, &room("mallory", None, true), &thread(&["t1"], &["t1"])), Err("not_a_member".into()));
    // With the accept mode off, only a listed sender's message is one.
    let off = room_settings(json!({"mode": "off"}));
    assert_eq!(gate(&off, &room("mallory", None, true), &thread(&["t1"], &[])), Err("not_a_member".into()));
    assert_eq!(gate(&off, &room("alice", None, true), &thread(&["t1"], &[])).map(|(strength, _)| strength), Ok(Strength::Explicit));
}

#[test]
fn admits_listed_bots_and_senderless_events_as_inferred_candidates_at_most() {
    let auto = room_settings(json!({}));
    let alone = thread(&[], &[]);
    let (strength, basis) = gate(&auto, &room("ci-bot", None, false), &alone).unwrap();
    assert_eq!((strength, basis.sender.as_deref()), (Strength::Inferred, Some("ci-bot")));
    assert_eq!(basis.via, BasisVia::Bot { addressed: None, observation: Observation { mode: AcceptMode::Auto } });
    assert_eq!(gate(&auto, &room("other-bot", None, false), &alone), Err("not_human".into()));
    assert_eq!(gate(&room_settings(json!({"mode": "off"})), &room("ci-bot", None, false), &alone), Err("admission_ignored".into()));
    // A senderless event passes only where the row admits unlisted unaddressed messages.
    assert_eq!(gate(&auto, &room("", None, false), &alone), Err("admission_ignored".into()));
    let open = room_settings(json!({"admission": {"r1": {"unlistedUnaddressed": "inferred"}}}));
    assert_eq!(gate(&open, &room("", None, false), &alone).map(|(strength, _)| strength), Ok(Strength::Inferred));
    let mut left = room("ci-bot", None, false);
    left.meta.insert("left".into(), true.into());
    assert_eq!(gate(&auto, &left, &alone), Err("not_human".into()));
}

#[test]
fn accepts_inferred_work_only_in_auto_mode_on_enabled_rules() {
    let auto = room_settings(json!({}));
    let rules = |ids: &[&str]| ids.iter().map(|id| id.to_string()).collect::<Vec<_>>();
    assert!(policy(&auto).admits_inferred(&rules(&["copy"])));
    assert!(!policy(&auto).admits_inferred(&rules(&[])));
    assert!(!policy(&auto).admits_inferred(&rules(&["copy", "unknown"])));
    assert!(!policy(&room_settings(json!({"mode": "observe"}))).admits_inferred(&rules(&["copy"])));
    let mut disabled = auto.clone();
    disabled.policy.rules[0].enabled = false;
    assert!(!policy(&disabled).admits_inferred(&rules(&["copy"])));
}

#[test]
fn revalidates_a_mandate_against_the_senders_list_the_table_the_mode_and_its_rules() {
    let auto = room_settings(json!({}));
    let alone = thread(&[], &[]);
    let observed = mandate(&auto, &room("alice", None, true), &alone, Some(&["copy"]));
    assert!(policy(&auto).revalidate(&observed));
    assert!(!policy(&room_settings(json!({"mode": "observe"}))).revalidate(&observed));
    let mut disabled = auto.clone();
    disabled.policy.rules[0].enabled = false;
    assert!(!policy(&disabled).revalidate(&observed));
    let mut unlisted = auto.clone();
    unlisted.policy.sources.get_mut("room").unwrap().allowed.clear();
    assert!(!policy(&unlisted).revalidate(&observed));
    assert!(!policy(&room_settings(json!({"admission": {"r1": {"listedUnaddressed": "ignore"}}}))).revalidate(&observed));
    // An explicit Mandate from an open row holds while the row still grants it, or once its sender is listed.
    let open = room_settings(json!({"admission": {"r1": {"unlistedAddressed": "explicit"}}}));
    let granted = mandate(&open, &room("mallory", Some(Addressed::Mention), true), &alone, None);
    assert!(policy(&open).revalidate(&granted));
    assert!(!policy(&auto).revalidate(&granted));
    let mut listed = auto.clone();
    listed.policy.sources.get_mut("room").unwrap().allowed.push(Allowed { id: "mallory".into(), name: None });
    assert!(policy(&listed).revalidate(&granted));
    // A bot's candidate holds while the bot stays listed.
    let bot = mandate(&auto, &room("ci-bot", None, false), &alone, Some(&["copy"]));
    assert!(policy(&auto).revalidate(&bot));
    let mut no_bots = auto.clone();
    no_bots.policy.sources.get_mut("room").unwrap().bots.clear();
    assert!(!policy(&no_bots).revalidate(&bot));
    // A follow-up: explicit stays valid, inferred needs auto mode and its rules.
    let stranger = mandate(&auto, &room("mallory", None, true), &thread(&["t1"], &[]), Some(&["copy"]));
    assert!(policy(&auto).revalidate(&stranger));
    assert!(!policy(&room_settings(json!({"mode": "observe"}))).revalidate(&stranger));
    let member = mandate(&auto, &room("alice", None, true), &thread(&["t1"], &[]), None);
    assert!(policy(&room_settings(json!({"mode": "off"}))).revalidate(&member));
    // Once the Source stops listening to the room, nothing received there holds.
    let mut left = observed.clone();
    left.basis.scope.as_mut().unwrap().insert("left".into(), true.into());
    assert!(!policy(&auto).revalidate(&left));
}

#[test]
fn tells_each_open_ticket_how_a_settings_change_bears_on_it() {
    let sources: Arc<dyn SourceScope> = Arc::new(Rooms);
    let auto = room_settings(json!({}));
    let alone = thread(&[], &[]);
    let ticket = |id: &str, mandate: Mandate| Ticket {
        id: id.into(),
        title: "T".into(),
        decision_id: "d".into(),
        mandate,
        channels: vec![],
        ended: None,
        attention: None,
        assignments: vec![],
        inputs: vec![],
        undelivered: vec![],
        answers: vec![],
        digest: None,
        created_at: "t".into(),
        updated_at: "t".into(),
        origin: Origin { trigger_id: "g".into(), trigger_ids: vec![] },
        execution: None,
        delivery: None,
        result_sent: None,
    };
    let tickets = vec![
        ticket("explicit", mandate(&auto, &room("alice", Some(Addressed::Mention), true), &alone, None)),
        ticket("proactive", mandate(&auto, &room("alice", None, true), &alone, Some(&["copy"]))),
        ticket("local", mandate(&auto, &chat(WEB_SENDER), &alone, None)),
    ];
    // Nothing changed that bears on them.
    let mut busier = auto.clone();
    busier.executor.max_workers = 8;
    assert!(policy_effects(&tickets, &auto, &busier, &sources).is_empty());
    // A rule's instruction changed: only the ticket accepted under it hears of it.
    let mut reworded = auto.clone();
    reworded.policy.rules[0].instruction = "Typos only.".into();
    let effects = policy_effects(&tickets, &auto, &reworded, &sources);
    assert_eq!(effects.keys().collect::<Vec<_>>(), vec!["proactive"]);
    assert_eq!(
        effects["proactive"].rules,
        vec![RuleEffect { id: "copy".into(), name: "Copy fixes".into(), change: "changed".into(), instruction: Some("Typos only.".into()) }]
    );
    assert_eq!((effects["proactive"].proactive, effects["proactive"].requester_allowed), (None, None));
    // The rule is disabled.
    let mut disabled = auto.clone();
    disabled.policy.rules[0].enabled = false;
    let effects = policy_effects(&tickets, &auto, &disabled, &sources);
    assert_eq!(effects["proactive"].rules[0].change, "disabled");
    assert_eq!(effects.len(), 1);
    // Proactive work is no longer accepted.
    let effects = policy_effects(&tickets, &auto, &room_settings(json!({"mode": "observe"})), &sources);
    assert_eq!(effects.len(), 1);
    assert_eq!((effects["proactive"].proactive, effects["proactive"].requester_allowed), (Some(false), None));
    // The requester is taken off the list: both of that sender's tickets are told, the local one is not.
    let mut removed = auto.clone();
    removed.policy.sources.get_mut("room").unwrap().allowed.clear();
    let effects = policy_effects(&tickets, &auto, &removed, &sources);
    let mut told: Vec<&String> = effects.keys().collect();
    told.sort();
    assert_eq!(told, vec!["explicit", "proactive"]);
    for effect in effects.values() {
        assert_eq!((effect.requester_allowed, effect.requester.as_ref().map(|actor| actor.id.as_str())), (Some(false), Some("alice")));
    }
}

// assessment outcomes

fn assessment(matched: bool, decision: &str) -> Assessment {
    serde_json::from_value(json!({
        "decision": decision,
        "direction": {"implementation_requested": true, "target_basis": "specified", "requires_design_decision": false, "evidence": "asked"},
        "title": "Fix typo", "scope": "README", "reason": "asked", "intent_evidence": "fix typo", "worktree_name": "fix-typo",
        "acknowledgement": "On it",
        "rule_assessments": [
            {"rule_id": "copy", "matched": matched, "reason": "judged"},
            {"rule_id": "visual", "matched": false, "reason": "judged"}
        ]
    }))
    .unwrap()
}

#[test]
fn accepts_bounded_work_only_with_a_matched_rule_a_settled_direction_and_intent_evidence() {
    let auto = room_settings(json!({}));
    let accepted = assessment_outcome(&assessment(true, "accept"), &auto, Strength::Inferred).unwrap();
    let OutcomeKind::Accept(accept) = &accepted.kind else { panic!("accepted") };
    assert_eq!(
        (accept.title.as_str(), accept.scope.as_str(), accept.name.as_deref(), accept.acknowledgement.as_deref()),
        ("Fix typo", "README", Some("fix-typo"), Some("On it"))
    );
    assert_eq!(accept.rules, Some(vec!["copy".to_string()]));
    assert_eq!(accepted.reason, Why::Said("asked".into()));
    let audit = accepted.audit.unwrap();
    assert_eq!(audit["matches"], json!([{"rule_id": "copy", "reason": "judged"}]));
    assert_eq!(audit["intent_evidence"], "fix typo");
    assert!(matches!(assessment_outcome(&assessment(true, "accept"), &auto, Strength::Explicit).unwrap().kind, OutcomeKind::Accept(_)));
    let code = |outcome: neo_core::ports::Outcome| match outcome.reason {
        Why::Code(reason) => reason.code,
        Why::Said(text) => text,
    };
    let unmatched = assessment_outcome(&assessment(false, "accept"), &auto, Strength::Inferred).unwrap();
    assert_eq!((unmatched.kind.clone(), code(unmatched)), (OutcomeKind::Ignore, "noRuleMatched".into()));
    let mut unsettled = assessment(true, "accept");
    unsettled.direction["target_basis"] = "undetermined".into();
    assert_eq!(code(assessment_outcome(&unsettled, &auto, Strength::Explicit).unwrap()), "directionUnsettled");
    let mut no_evidence = assessment(true, "accept");
    no_evidence.intent_evidence = None;
    assert!(assessment_outcome(&no_evidence, &auto, Strength::Explicit).unwrap_err().contains("intent_evidence"));
}

#[test]
fn records_what_an_inferred_candidate_would_accept_outside_auto_mode() {
    let observe = room_settings(json!({"mode": "observe"}));
    let observed = assessment_outcome(&assessment(true, "accept"), &observe, Strength::Inferred).unwrap();
    assert_eq!(observed.kind, OutcomeKind::Ignore);
    assert_eq!(observed.reason, Why::Code(neo_core::reasons::Reason::with("observed", "text", "asked")));
    let audit = observed.audit.unwrap();
    assert_eq!(audit["would_accept"], true);
    assert_eq!(audit["proposal"], json!({"title": "Fix typo", "scope": "README", "worktree_name": "fix-typo"}));
    // An explicit request is accepted whatever the mode.
    assert!(matches!(assessment_outcome(&assessment(true, "accept"), &observe, Strength::Explicit).unwrap().kind, OutcomeKind::Accept(_)));
}

#[test]
fn passes_an_ignore_or_unavailable_through_and_refuses_judgements_that_do_not_cover_the_enabled_rules() {
    let auto = room_settings(json!({}));
    assert_eq!(assessment_outcome(&assessment(false, "ignore"), &auto, Strength::Inferred).unwrap().kind, OutcomeKind::Ignore);
    assert_eq!(assessment_outcome(&assessment(false, "unavailable"), &auto, Strength::Inferred).unwrap().kind, OutcomeKind::Unavailable);
    assert!(assessment_outcome(&assessment(true, "maybe"), &auto, Strength::Inferred).unwrap_err().contains("Unknown decision"));
    let mut missing = assessment(true, "accept");
    missing.rule_assessments.pop();
    assert!(assessment_outcome(&missing, &auto, Strength::Inferred).unwrap_err().contains("every enabled rule"));
    let mut repeated = assessment(true, "accept");
    repeated.rule_assessments[1].rule_id = "copy".into();
    assert!(assessment_outcome(&repeated, &auto, Strength::Inferred).is_err());
    // A disabled rule is not judged.
    let mut one = auto.clone();
    one.policy.rules[1].enabled = false;
    assert!(assessment_outcome(&assessment(true, "accept"), &one, Strength::Inferred).is_err());
    assert!(matches!(assessment_outcome(&missing, &one, Strength::Inferred).unwrap().kind, OutcomeKind::Accept(_)));
}

#[test]
fn takes_a_direction_as_settled_only_when_it_says_so_exactly() {
    let direction = |basis: &str, requested: bool, design: bool| json!({"implementation_requested": requested, "target_basis": basis, "requires_design_decision": design, "evidence": "asked"});
    assert!(direction_allowed(&direction("specified", true, false)));
    assert!(direction_allowed(&direction("existing-standard", true, false)));
    assert!(!direction_allowed(&direction("undetermined", true, false)));
    assert!(!direction_allowed(&direction("specified", false, false)));
    assert!(!direction_allowed(&direction("specified", true, true)));
    assert!(!direction_allowed(&json!({"implementation_requested": true, "target_basis": "specified", "requires_design_decision": false, "evidence": " "})));
    let mut extra = direction("specified", true, false);
    extra["more"] = true.into();
    assert!(!direction_allowed(&extra));
    assert!(!direction_allowed(&json!(null)));
}
