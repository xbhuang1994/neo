//! Ticket behaviour: follow-up ownership at a ticket's end, interruptions, pause, policy changes, worker reports,
//! attach, direct decisions, automatic input and replies.

mod common;

/// The repository these tests run on; `neo-store` includes this file and provides its own at its crate root.
#[allow(dead_code)]
fn test_repo() -> std::sync::Arc<dyn neo_core::ports::Repositories> {
    std::sync::Arc::new(neo_core::memory::MemoryRepositories::new())
}

use common::*;
use neo_core::assignments::Question;
use neo_core::ids::key;
use neo_core::model::*;
use neo_core::ports::*;
use neo_core::reasons::Reason;
use neo_core::replies::{Purpose, Reply, ReplyRequest};
use neo_core::stage::{ticket_stage, PersonAction, TicketStage};
use neo_core::time::parse_iso;
use neo_core::UserError;
use std::collections::HashMap;

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}
fn owners(h: &Harness, trigger_id: &str) -> Vec<String> {
    followup_owners(&h.repo.trigger(trigger_id).unwrap(), &Records(h.repo.as_ref()))
}
fn decides(tickets: &str) -> UserError {
    UserError::with("workerDecides", &[("tickets", tickets)])
}
fn ack(ticket_id: &str, trigger_id: &str, text: &str) -> ReplyRequest {
    ReplyRequest {
        purpose: Purpose::Acknowledgement,
        ticket_id: Some(ticket_id.into()),
        trigger_id: Some(trigger_id.into()),
        question: None,
        text: text.into(),
    }
}
fn answer(trigger_id: &str, text: &str) -> ReplyRequest {
    ReplyRequest { purpose: Purpose::Answer, ticket_id: None, trigger_id: Some(trigger_id.into()), question: None, text: text.into() }
}
fn result(ticket_id: &str, text: &str) -> ReplyRequest {
    ReplyRequest { purpose: Purpose::Result, ticket_id: Some(ticket_id.into()), trigger_id: None, question: None, text: text.into() }
}
fn attention(ticket_id: &str, question: Option<&str>, text: &str) -> ReplyRequest {
    ReplyRequest { purpose: Purpose::Attention, ticket_id: Some(ticket_id.into()), trigger_id: None, question: question.map(str::to_string), text: text.into() }
}

// follow-up owners

#[test]
fn lets_the_main_session_take_a_follow_up_as_new_work_once_it_stopped_the_ticket_on_it() {
    let h = harness();
    let ticket_id = h.accepted();
    // "Stop this, and do Y instead": the stop ends the ticket that decided the message, so the request is the main Session's.
    h.receive(trigger("2"));
    h.settle();
    assert_eq!(h.engine.decide("2", accept_plain("Y")).unwrap_err(), decides(&ticket_id));
    assert_eq!(h.engine.decide("2", stop(&ticket_id, "asked to stop")).unwrap().kind, DecisionKind::Stop);
    // At the same moment, the accept is a Decision of its own beside the stop's.
    let accepted = h.engine.decide("2", accept_plain("Y")).unwrap();
    assert_eq!((accepted.kind, accepted.trigger_ids), (DecisionKind::Accept, ids(&["2"])));
    let kinds: Vec<DecisionKind> = h.decisions("chat:t1").into_iter().filter(|d| d.trigger_ids.contains(&"2".to_string())).map(|d| d.kind).collect();
    assert_eq!(kinds, vec![DecisionKind::Stop, DecisionKind::Accept]);
}

#[test]
fn sends_a_follow_up_its_worker_never_received_to_eval_when_the_ticket_ends() {
    for by_report in [true, false] {
        let h = harness();
        let ticket_id = h.accepted();
        h.receive(trigger("2"));
        assert_eq!(h.ticket(&ticket_id).undelivered.len(), 1);
        if by_report {
            h.report(&ticket_id, ReportState::Dropped, "nothing to do");
        } else {
            h.engine.stop_ticket(&ticket_id, Some("not needed")).unwrap();
        }
        assert_eq!(h.thread("chat:t1").pending, ids(&["2"]));
        h.pump();
        assert_eq!(h.last_ids(), ids(&["2"]));
    }
}

#[test]
fn sends_a_follow_up_its_worker_got_since_its_last_report_to_eval_unless_it_acknowledged_it() {
    let h = harness();
    let ticket_id = h.accepted();
    h.report(&ticket_id, ReportState::Progress, "working");
    // The worker acknowledges one of two messages, and its final report was on its way before it took up the other.
    h.tick(1);
    h.receive(trigger("2"));
    h.receive(trigger("3"));
    h.settle();
    h.engine.reply(ack(&ticket_id, "2", "On it")).unwrap();
    h.report(&ticket_id, ReportState::Dropped, "nothing to do");
    assert_eq!(h.thread("chat:t1").pending, ids(&["3"]));
    // The ticket no longer counts as having reached it.
    assert_eq!((h.disposition("2").fanout, h.disposition("3").fanout), (vec![ticket_id], ids(&[])));
}

#[test]
fn gives_a_follow_up_its_ended_ticket_let_go_to_that_ticket_again_when_attached_there() {
    for resumed in [false, true] {
        let h = harness();
        let ticket_id = h.accepted();
        // The ticket ends before its worker took up a person's message, which goes to Eval; a later message may resume it.
        h.report(&ticket_id, ReportState::Progress, "working");
        h.tick(1);
        h.receive(trigger("2"));
        h.settle();
        h.report(&ticket_id, ReportState::Dropped, "nothing to do");
        if resumed {
            h.tick(1);
            h.receive(trigger("3"));
        }
        h.pump();
        h.tick(1);
        h.engine.attach(&ticket_id, "2", None).unwrap();
        h.settle();
        // Its worker gets the message again, and an ended ticket resumes for it.
        let copies: Vec<String> = h.ticket(&ticket_id).inputs.iter().filter(|i| i.trigger_id() == Some("2")).map(|i| i.id().to_string()).collect();
        assert_eq!(copies.len(), 2);
        assert!(h.delivered().contains(&(ticket_id.clone(), copies[1].clone())));
        assert!(h.ticket(&ticket_id).ended.is_none());
        assert_eq!(owners(&h, "2"), vec![ticket_id]);
    }
}

#[test]
fn wakes_an_ended_ticket_for_an_attached_message_its_worker_read_only_for_context_or_before_its_last_report() {
    for context in [true, false] {
        let h = harness();
        let ticket_id = h.accepted();
        if context {
            h.engine.follow_for_context(&ticket_id, &thread("issue")).unwrap();
        }
        h.tick(1);
        h.receive(on(trigger("2"), if context { "issue" } else { "t1" }));
        h.settle();
        // The worker reports after reading it and drops the ticket; a person sends a follow-up it had to Eval.
        h.tick(1);
        h.report(&ticket_id, ReportState::Progress, "read it");
        h.report(&ticket_id, ReportState::Dropped, "nothing to do");
        if !context {
            h.engine.reevaluate("2").unwrap();
        }
        h.pump();
        h.tick(1);
        h.engine.attach(&ticket_id, "2", None).unwrap();
        h.settle();
        assert!(h.ticket(&ticket_id).ended.is_none());
        assert_eq!(owners(&h, "2"), vec![ticket_id]);
    }
}

#[test]
fn counts_a_question_the_final_report_answers_as_taken_up() {
    let h = harness();
    let ticket_id = h.accepted();
    h.tick(1);
    h.receive(trigger("2"));
    h.settle();
    let mut ready = report(ReportState::Ready, "It reads the config.");
    ready.answers = Some("2".into());
    h.engine.report(&ticket_id, ready).unwrap();
    assert!(h.thread("chat:t1").pending.is_empty());
    let disposition = h.disposition("2");
    assert_eq!((disposition.fanout, disposition.acked), (vec![ticket_id.clone()], vec![ticket_id]));
}

#[test]
fn sends_to_eval_a_message_attached_after_its_eval_was_unavailable_once_its_ticket_ends_without_taking_it_up() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(on(trigger("2"), "x"));
    h.pump();
    h.decide(&h.last_request(), Outcome::new(OutcomeKind::Unavailable, "model down")).unwrap();
    h.tick(1);
    h.engine.attach(&ticket_id, "2", None).unwrap();
    h.settle();
    h.report(&ticket_id, ReportState::Dropped, "nothing to do");
    assert_eq!(h.thread("chat:x").pending, ids(&["2"]));
}

#[test]
fn counts_a_message_that_resumed_a_ticket_as_read_by_the_report_that_ends_it_again_unlike_one_that_came_later() {
    let h = harness();
    let ticket_id = h.accepted();
    h.report(&ticket_id, ReportState::Ready, "done");
    // A person's thanks resumes the ticket, and its worker takes it into a step first; a request comes while it
    // reports that nothing is left.
    h.tick(1);
    h.receive(trigger("2"));
    h.tick(1);
    let latest = h.ticket(&ticket_id).assignments.last().unwrap().id.clone();
    h.engine.assignment_started(&ticket_id, &latest).unwrap();
    h.tick(1);
    h.settle();
    h.read(&ticket_id);
    h.tick(1);
    h.receive(trigger("3"));
    h.settle();
    h.report(&ticket_id, ReportState::Dropped, "nothing to do");
    assert_eq!(h.thread("chat:t1").pending, ids(&["3"]));
}

#[test]
fn sends_a_follow_up_to_eval_after_a_stop_on_it_was_refused_but_not_the_one_a_stop_ended_it_on() {
    // A guest's stop is refused, and the worker drops the ticket; a member's stop ends it, and the main Session, which
    // stopped it, decides the rest of the message itself.
    for from_guest in [true, false] {
        let h = harness();
        let ticket_id = h.accepted();
        h.receive(by(trigger("2"), if from_guest { guest() } else { member() }));
        h.engine.decide("2", stop(&ticket_id, "asked to stop")).unwrap();
        if from_guest {
            h.report(&ticket_id, ReportState::Dropped, "nothing to do");
        }
        assert_eq!(h.thread("chat:t1").pending, if from_guest { ids(&["2"]) } else { ids(&[]) });
    }
}

#[test]
fn hands_the_follow_ups_on_a_thread_a_worker_found_unrelated_back_to_eval_with_its_reason() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(on(trigger("2"), "x"));
    h.pump();
    h.engine.attach(&ticket_id, "2", None).unwrap();
    h.settle();
    h.receive(on(trigger("3"), "x"));
    h.settle();
    assert_eq!(h.engine.decide("3", accept_plain("Y")).unwrap_err(), decides(&ticket_id));
    // The worker finds the attached thread is not its ticket's: the message the main Session attached goes back with
    // the later one, and each candidate says why.
    h.engine.mark_unrelated(&ticket_id, "chat:x", "about something else").unwrap();
    assert_eq!(h.thread("chat:x").pending, ids(&["2", "3"]));
    let handbacks = h.disposition("3").handbacks;
    assert_eq!((handbacks.len(), handbacks[0].reason.as_str()), (1, "about something else"));
    h.pump();
    assert_eq!(h.last_ids(), ids(&["2", "3"]));
}

#[test]
fn keeps_a_follow_up_two_tickets_reached_with_the_one_that_did_not_hand_it_back() {
    let h = harness();
    let first = h.accepted();
    h.tick(1);
    h.receive(trigger("2"));
    h.settle();
    h.engine.handback(&first, "2", "another change").unwrap();
    h.pump();
    let second = h.decide(&h.last_request(), accept_plain("Y")).unwrap().ticket_id.unwrap();
    h.settle();
    h.tick(1);
    h.receive(trigger("3"));
    h.settle();
    assert_eq!(h.disposition("3").fanout, vec![first.clone(), second.clone()]);
    assert!(!h.engine.handback(&first, "3", "for the other ticket").unwrap());
    assert!(h.thread("chat:t1").pending.is_empty());
    // The main Session may neither take nor dismiss it while the second ticket's worker decides it.
    assert_eq!(h.engine.decide("3", accept_plain("Y")).unwrap_err(), decides(&second));
    assert_eq!(h.engine.decide("3", ignore("chat")).unwrap_err(), decides(&second));
    assert!(h.engine.handback(&second, "3", "neither ticket").unwrap());
    assert_eq!(h.thread("chat:t1").pending, ids(&["3"]));
}

// interrupted assignments

#[test]
fn starts_an_interrupted_assignment_again_with_a_note_and_hands_one_that_waits_what_waits_for_it() {
    let h = harness();
    let interrupted = h.accepted();
    let first = h.ticket(&interrupted).assignments[0].clone();
    let waiting = h.accepted_on("2", "t2");
    h.report(&waiting, ReportState::Waiting, "done for now");
    h.receive(on(trigger("3"), "t2"));
    let (starts, delivers) = (h.starts(), h.delivers());
    // The Executor reports each Assignment that was running; a fact about one that no longer runs is dropped.
    for id in [&interrupted, &waiting] {
        let running = h.ticket(id).running().unwrap().id.clone();
        h.engine.assignment_interrupted(id, &running).unwrap();
    }
    h.engine.assignment_interrupted(&interrupted, &first.id).unwrap();
    let ticket = h.ticket(&interrupted);
    assert_eq!(ticket.assignments.len(), 2);
    assert_eq!((ticket.assignments[0].state, ticket.assignments[0].ended_reason.as_deref()), (AssignmentState::Ended, Some("hostRestarted")));
    assert_eq!(ticket.assignments[1].state, AssignmentState::Pending);
    assert!(matches!(ticket.inputs.as_slice(), [TicketInput::Text { text, .. }] if text.contains("The host restarted")));
    assert_eq!(ticket.undelivered, vec![ticket.inputs[0].id().to_string()]);
    assert_eq!(h.starts(), starts + 1);
    // A worker that waits keeps its Session and gets what waits for it.
    assert_eq!(h.ticket(&waiting).assignments.len(), 1);
    assert_eq!(h.delivers(), delivers + 1);
}

#[test]
fn starts_again_a_worker_that_reported_but_then_got_a_persons_message() {
    let h = harness();
    let other = h.accepted_on("2", "t2");
    h.report(&other, ReportState::Waiting, "done for now");
    h.tick(1);
    h.receive(by(on(trigger("3"), "t2"), guest()));
    h.settle();
    let running = h.ticket(&other).running().cloned().unwrap();
    assert!(running.delivered_at.as_ref().unwrap() > &running.report.as_ref().unwrap().at);
    h.engine.assignment_interrupted(&other, &running.id).unwrap();
    assert_eq!(h.ticket(&other).assignments.iter().map(|a| a.state).collect::<Vec<_>>(), vec![AssignmentState::Ended, AssignmentState::Pending]);
}

// pause

#[test]
fn lets_no_eval_expire_while_paused_and_moves_its_deadline_on_by_the_pauses_length() {
    let h = harness();
    h.receive(trigger("1"));
    h.pump();
    h.engine.candidate_delivered(&h.request(0).eval_id);
    let deadline = parse_iso(&h.thread("chat:t1").evaluating.unwrap().deadline).unwrap();
    h.tick(30);
    h.set_paused(true);
    h.pump();
    // Paused past the deadline, the Eval waits.
    h.tick(300);
    h.pump();
    assert!(h.engine.candidate("1").is_some());
    h.set_paused(false);
    h.pump();
    assert_eq!(parse_iso(&h.thread("chat:t1").evaluating.unwrap().deadline).unwrap(), deadline + 300_000);
    h.tick(29);
    h.pump();
    assert_eq!(h.engine.candidate("1").map(|c| c.eval_id), Some(h.request(0).eval_id));
    // Expired, it queues the Trigger again for a fresh Eval.
    h.tick(1);
    h.pump();
    assert_ne!(h.engine.candidate("1").map(|c| c.eval_id), Some(h.request(0).eval_id));
    assert!(h.decisions("chat:t1").is_empty());
}

#[test]
fn does_not_start_evals_while_paused() {
    let h = harness();
    h.set_paused(true);
    h.receive(trigger("1"));
    h.pump();
    assert_eq!(h.requests(), 0);
}

// policy change

#[test]
fn tells_only_the_live_tickets_a_change_bears_on_and_restarts_in_flight_evals_under_the_new_version() {
    let h = harness();
    let ticket_id = h.accepted();
    let other = h.accepted_on("3", "t3");
    h.receive(on(trigger("2"), "t2"));
    h.pump();
    let effect = PolicyEffect {
        rules: vec![RuleEffect { id: "copy".into(), name: "Copy".into(), change: "changed".into(), instruction: Some("Fix typos only.".into()) }],
        ..Default::default()
    };
    h.set_version("v2");
    h.engine.policy_changed("v1", "v2", &HashMap::from([(ticket_id.clone(), effect.clone())]));
    let told = h.ticket(&ticket_id).inputs;
    assert!(matches!(told.as_slice(), [TicketInput::PolicyChanged { from, to, effect: stored, .. }] if from == "v1" && to == "v2" && *stored == effect));
    assert!(h.ticket(&other).inputs.is_empty());
    let decisions = h.decisions("chat:t2");
    assert_eq!(decisions.len(), 1);
    assert_eq!((decisions[0].kind, decisions[0].reason.clone()), (DecisionKind::Unavailable, vec![Reason::code("policyChanged")]));
    assert_eq!(h.thread("chat:t2").pending, ids(&["2"]));
    h.pump();
    assert_eq!((h.last_request().policy_version, h.last_ids()), ("v2".to_string(), ids(&["2"])));
    assert_eq!(h.delivered(), vec![(ticket_id, told[0].id().to_string())]);
}

#[test]
fn tells_a_worker_of_each_policy_change_also_of_one_that_repeats_an_earlier_transition() {
    let h = harness();
    let ticket_id = h.accepted();
    let effects = HashMap::from([(ticket_id.clone(), PolicyEffect { proactive: Some(false), ..Default::default() })]);
    h.engine.policy_changed("v1", "v2", &effects);
    h.tick(1);
    h.engine.policy_changed("v2", "v1", &effects);
    h.tick(1);
    h.engine.policy_changed("v1", "v2", &effects);
    assert_eq!(h.ticket(&ticket_id).inputs.len(), 3);
}

// worker reports

#[test]
fn asks_keeps_replaces_and_clears_the_question_for_a_person() {
    let h = harness();
    let ticket_id = h.accepted();
    let mut asking = report(ReportState::Progress, "need a call");
    asking.question = Question::Ask("Which color?".into());
    asking.asked_by = Some("1".into());
    let asked = h.engine.report(&ticket_id, asking).unwrap().attention.unwrap();
    assert_eq!((asked.question.as_str(), asked.trigger_id.as_deref()), ("Which color?", Some("1")));
    assert_eq!(h.report(&ticket_id, ReportState::Blocked, "still waiting").attention, Some(asked.clone()));
    assert!(h.r.withdrawn.lock().unwrap().is_empty());
    let mut other = report(ReportState::Progress, "other question");
    other.question = Question::Ask("Which size?".into());
    let replaced = h.engine.report(&ticket_id, other).unwrap().attention.unwrap();
    assert_eq!((replaced.question.as_str(), replaced.trigger_id.clone()), ("Which size?", None));
    // The replaced question is withdrawn from the outbox if its message has not gone out yet.
    assert_eq!(*h.r.withdrawn.lock().unwrap(), vec![key(&["attention-reply", &asked.id])]);
    let mut clear = report(ReportState::Progress, "answered");
    clear.question = Question::Clear;
    assert!(h.engine.report(&ticket_id, clear).unwrap().attention.is_none());
    assert_eq!(*h.r.withdrawn.lock().unwrap(), vec![key(&["attention-reply", &asked.id]), key(&["attention-reply", &replaced.id])]);
}

#[test]
fn ends_the_ticket_on_a_final_report() {
    let outcome = |state: ReportState| {
        let h = harness();
        let ticket_id = h.accepted();
        let mut asking = report(ReportState::Progress, "asking");
        asking.question = Question::Ask("Ship it?".into());
        h.engine.report(&ticket_id, asking).unwrap();
        h.report(&ticket_id, state, "done")
    };
    let dropped = outcome(ReportState::Dropped).ended.unwrap();
    assert_eq!((dropped.by, dropped.outcome, dropped.reason), (TicketEndBy::Executor, TicketOutcome::Dropped, None));
    let ready = outcome(ReportState::Ready);
    assert_eq!(ready.ended.as_ref().map(|e| e.outcome), Some(TicketOutcome::Completed));
    assert!(ready.attention.is_none());
    let failed = outcome(ReportState::Failed);
    assert!(failed.ended.is_none());
    assert_eq!(failed.attention.map(|a| a.question), Some("Ship it?".into()));
}

#[test]
fn refuses_a_question_with_a_result_or_an_answer_and_ones_that_name_no_persons_message_of_the_ticket() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(bot(trigger("2")));
    h.receive(on(trigger("4"), "elsewhere"));
    let refuse = |change: &dyn Fn(&mut neo_core::assignments::WorkerReport)| {
        let mut value = report(ReportState::Progress, "x");
        change(&mut value);
        h.engine.report(&ticket_id, value)
    };
    assert_eq!(
        Harness::code(refuse(&|r| {
            r.state = ReportState::Ready;
            r.question = Question::Ask("Q?".into())
        })),
        "questionWithResult"
    );
    assert_eq!(
        Harness::code(refuse(&|r| {
            r.question = Question::Ask("Q?".into());
            r.answers = Some("1".into())
        })),
        "questionWithResult"
    );
    assert_eq!(Harness::code(refuse(&|r| r.asked_by = Some("1".into()))), "askerWithoutQuestion");
    assert_eq!(
        Harness::code(refuse(&|r| {
            r.question = Question::Ask("Q?".into());
            r.asked_by = Some("2".into())
        })),
        "notAsker"
    );
    assert_eq!(Harness::code(refuse(&|r| r.answers = Some("4".into()))), "notAnswerable");
    assert_eq!(refuse(&|r| r.answers = Some("1".into())).unwrap().answers, ids(&["1"]));
}

#[test]
fn refuses_a_report_on_an_ended_ticket_and_records_how_it_ended() {
    let h = harness();
    let ticket_id = h.accepted();
    h.engine.stop_ticket(&ticket_id, Some("Human asked to stop")).unwrap();
    assert_eq!(Harness::code(h.engine.report(&ticket_id, report(ReportState::Progress, "x"))), "ticketEnded");
    let ended = h.ticket(&ticket_id).ended.unwrap();
    assert_eq!((ended.by, ended.outcome, ended.reason.as_deref()), (TicketEndBy::Human, TicketOutcome::Stopped, Some("Human asked to stop")));
    assert_eq!(ticket_stage(&h.ticket(&ticket_id)), TicketStage::Ended);
}

// attach

#[test]
fn sends_the_routing_note_for_a_message_the_worker_has_and_ends_an_eval_that_holds_only_that_message() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(by(trigger("2"), guest()));
    h.pump();
    assert_eq!(h.delivered().into_iter().map(|(_, id)| id).collect::<Vec<_>>(), vec![key(&["input", &ticket_id, "trigger", "2"])]);
    // The follow-up reached the ticket without an Eval, and is its worker's to judge; sent to Eval again by a person, it is judged there.
    assert!(h.engine.candidate("2").is_none());
    assert_eq!(h.engine.attach(&ticket_id, "2", None).unwrap_err(), decides(&ticket_id));
    assert!(h.engine.reevaluate("2").unwrap());
    h.pump();
    assert!(h.engine.candidate("2").is_some());
    let attached = h.engine.attach(&ticket_id, "2", Some("The guest asks for the same fix")).unwrap();
    h.settle();
    assert_eq!(attached.inputs.len(), 2);
    assert!(
        matches!(&attached.inputs[1], TicketInput::Trigger { trigger_id, note: Some(note), .. } if trigger_id == "2" && note == "The guest asks for the same fix")
    );
    assert_eq!(h.delivered().into_iter().map(|(_, id)| id).collect::<Vec<_>>(), attached.inputs.iter().map(|i| i.id().to_string()).collect::<Vec<_>>());
    assert!(h.engine.candidate("2").is_none());
    let last = h.decisions("chat:t1").pop().unwrap();
    assert_eq!((last.kind, last.reason), (DecisionKind::Ignore, vec![Reason::with("routed", "ticket", &ticket_id)]));
    // A note for a message that still waits for the worker goes out with it.
    h.receive(by(trigger("5"), guest()));
    h.engine.reevaluate("5").unwrap();
    let noted = h.engine.attach(&ticket_id, "5", Some("Same fix again")).unwrap();
    assert!(matches!(noted.inputs.last(), Some(TicketInput::Trigger { trigger_id, note: Some(note), .. }) if trigger_id == "5" && note == "Same fix again"));
    assert_eq!(noted.inputs.iter().filter(|i| i.trigger_id() == Some("5")).count(), 1);
    h.receive(on(trigger("6"), "elsewhere"));
    assert_eq!(Harness::code(h.engine.attach("missing", "6", None)), "unknownTicket");
    assert_eq!(Harness::code(h.engine.attach(&ticket_id, "missing", None)), "unknownTrigger");
}

#[test]
fn ends_the_batch_eval_of_an_attached_message_and_assesses_the_rest_again() {
    let h = harness();
    let (ticket_id, other) = (h.accepted(), h.accepted_on("5", "t5"));
    h.receive(on(trigger("2"), "x"));
    h.receive(on(trigger("3"), "x"));
    h.pump();
    h.engine.attach(&ticket_id, "3", None).unwrap();
    h.pump();
    let decisions = h.decisions("chat:x");
    assert_eq!(decisions.len(), 1);
    assert_eq!((decisions[0].kind, decisions[0].trigger_ids.clone()), (DecisionKind::Unavailable, ids(&["2", "3"])));
    assert_eq!(decisions[0].reason, vec![Reason::with("routed", "ticket", &ticket_id).of("3")]);
    assert_eq!(h.engine.candidate("2").map(|c| h.request_ids(&c)), Some(ids(&["2"])));
    assert_eq!(owners(&h, "3"), vec![ticket_id.clone()]);
    assert_eq!(h.engine.attach(&other, "3", None).unwrap_err(), decides(&ticket_id));
}

// direct decisions

#[test]
fn decides_an_explicit_request_no_eval_holds_in_a_direct_eval_and_accepts_a_trigger_once() {
    let h = harness();
    h.receive(trigger("1"));
    let decision = h.engine.decide("1", accept_plain("Fix")).unwrap();
    assert_eq!((decision.kind, decision.trigger_ids.clone(), decision.strength), (DecisionKind::Accept, ids(&["1"]), Strength::Explicit));
    let thread = h.thread("chat:t1");
    assert!(thread.pending.is_empty() && thread.evaluating.is_none());
    assert_eq!(h.engine.decide("1", accept_plain("Again")).unwrap(), decision);
    // A guest's follow-up reached that ticket without an Eval: its worker decides it, and only what the worker hands
    // back can become new work, under the gate's authority, inferred.
    h.receive(by(trigger("2"), guest()));
    h.pump();
    let ticket_id = decision.ticket_id.unwrap();
    let with_rules =
        || Outcome::new(OutcomeKind::Accept(Accept { title: "Fix".into(), scope: "small".into(), rules: Some(ids(&["r1"])), ..Default::default() }), "rule");
    assert_eq!(h.engine.decide("2", with_rules()).unwrap_err(), decides(&ticket_id));
    h.engine.handback(&ticket_id, "2", "A different fix").unwrap();
    assert_eq!(Harness::code(h.engine.decide("2", accept_plain("Fix"))), "notExplicit");
    let inferred = h.engine.decide("2", with_rules()).unwrap();
    assert_eq!((inferred.kind, inferred.strength), (DecisionKind::Accept, Strength::Inferred));
    assert_eq!(inferred.mandate.unwrap().basis.rules, Some(ids(&["r1"])));
    assert_eq!(Harness::code(h.engine.decide("missing", ignore("x"))), "unknownTrigger");
}

#[test]
fn refuses_a_direct_decision_on_a_trigger_the_gate_does_not_admit_and_leaves_the_queue_as_it_was() {
    let h = harness();
    h.receive(by(trigger("1"), guest()));
    let refused = h.engine.decide("1", accept_plain("Fix")).unwrap_err();
    assert_eq!(refused, UserError::with("notAdmissible", &[("reason", "not a member")]));
    assert_eq!(h.thread("chat:t1").pending, ids(&["1"]));
}

#[test]
fn ends_the_eval_of_a_replayed_trigger_that_started_a_ticket_and_returns_that_tickets_decision() {
    let h = harness();
    let ticket_id = h.accepted();
    let decision = h.decisions("chat:t1").pop().unwrap();
    h.tick(1);
    assert!(h.engine.reevaluate("1").unwrap());
    h.pump();
    assert!(h.engine.candidate("1").is_none());
    let last = h.decisions("chat:t1").pop().unwrap();
    assert_eq!((last.kind, last.trigger_ids), (DecisionKind::Ignore, ids(&["1"])));
    assert_eq!(last.reason, vec![Reason::with("startedTicket", "ticket", &ticket_id).of("1")]);
    assert_eq!(h.engine.decide("1", accept_plain("Fix")).unwrap(), decision);
    assert_eq!(h.repo.tickets().len(), 1);
}

#[test]
fn keeps_a_replayed_trigger_that_started_a_ticket_out_of_the_eval_of_the_triggers_queued_with_it() {
    let h = harness();
    h.accepted();
    h.receive(by(trigger("2"), guest()));
    h.engine.reevaluate("2").unwrap();
    h.engine.reevaluate("1").unwrap();
    h.pump();
    // The member's replayed request lends the guest's message no authority.
    assert!(h.engine.candidate("1").is_none());
    let candidate = h.engine.candidate("2").unwrap();
    assert_eq!((candidate.strength, h.request_ids(&candidate)), (Strength::Inferred, ids(&["2"])));
    assert_eq!(Harness::code(h.engine.decide("2", accept_plain("Other"))), "notExplicit");
    assert_eq!(h.repo.tickets().len(), 1);
}

#[test]
fn marks_the_ignore_of_an_inferred_candidate_that_no_assessment_judged() {
    let h = harness();
    h.accepted();
    for id in ["2", "3"] {
        h.receive(by(trigger(id), guest()));
        h.engine.reevaluate(id).unwrap();
        h.pump();
        let mut outcome = ignore("chat");
        if id == "3" {
            outcome.audit = Some(Json::new());
        }
        let decision = h.decide(&h.last_request(), outcome).unwrap();
        let codes: Vec<&str> = decision.reason.iter().map(|r| r.code.as_str()).collect();
        assert_eq!(codes, if id == "2" { vec!["ignoredFromCard", "said"] } else { vec!["said"] });
    }
}

#[test]
fn dismisses_the_problem_an_unavailable_decision_shows_and_only_such_a_decision() {
    let h = harness();
    h.receive(trigger("1"));
    h.pump();
    let unavailable = h.decide(&h.last_request(), Outcome::new(OutcomeKind::Unavailable, "model down")).unwrap();
    assert!(h.engine.dismiss(&unavailable.id).unwrap().dismissed);
    h.receive(trigger("2"));
    h.pump();
    let ignored = h.decide(&h.last_request(), ignore("chat")).unwrap();
    assert_eq!(Harness::code(h.engine.dismiss(&ignored.id)), "unknownProblem");
    assert_eq!(Harness::code(h.engine.dismiss("missing")), "unknownProblem");
}

// automatic input

#[test]
fn holds_back_automatic_input_from_a_worker_that_reported_blocked_until_a_persons_message_arrives() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(bot(trigger("2")));
    h.report(&ticket_id, ReportState::Blocked, "needs a decision");
    // Both pending and subsequent automated inputs stay on the ticket without waking the worker.
    h.receive(bot(trigger("3")));
    h.settle();
    let ticket = h.ticket(&ticket_id);
    assert!(ticket.undelivered.is_empty());
    assert_eq!(ticket.inputs.iter().map(|i| i.trigger_id()).collect::<Vec<_>>(), vec![Some("2"), Some("3")]);
    assert!(h.delivered().is_empty());
    h.tick(1);
    h.receive(by(trigger("4"), guest()));
    h.receive(bot(trigger("5")));
    h.settle();
    assert_eq!(
        h.delivered().into_iter().map(|(_, id)| id).collect::<Vec<_>>(),
        vec![key(&["input", &ticket_id, "trigger", "4"]), key(&["input", &ticket_id, "trigger", "5"])]
    );
}

#[test]
fn stops_waiting_for_a_person_on_a_persons_message_a_later_report_or_a_retry() {
    let h = harness();
    let ticket_id = h.accepted();
    h.report(&ticket_id, ReportState::Blocked, "needs a decision");
    assert!(h.ticket(&ticket_id).waits_for_person());
    assert_eq!(ticket_stage(&h.ticket(&ticket_id)), TicketStage::Person(PersonAction::Blocked));
    // The worker has the person's reply, so the stale blocked report no longer holds the ticket.
    h.tick(1);
    h.receive(by(trigger("2"), guest()));
    h.settle();
    assert!(!h.ticket(&ticket_id).waits_for_person());
    assert_eq!(ticket_stage(&h.ticket(&ticket_id)), TicketStage::Working { queued: false });
    h.tick(1);
    h.report(&ticket_id, ReportState::Failed, "broke");
    assert!(h.ticket(&ticket_id).waits_for_person());
    assert_eq!(ticket_stage(&h.ticket(&ticket_id)), TicketStage::Person(PersonAction::Failed));
    h.tick(1);
    h.report(&ticket_id, ReportState::Progress, "found a way");
    assert!(!h.ticket(&ticket_id).waits_for_person());
    h.tick(1);
    h.report(&ticket_id, ReportState::Blocked, "needs access");
    h.engine.retry_ticket(&ticket_id).unwrap();
    assert!(!h.ticket(&ticket_id).waits_for_person());
    assert_eq!(ticket_stage(&h.ticket(&ticket_id)), TicketStage::Working { queued: true });
}

#[test]
fn launches_a_failed_launch_again_for_a_persons_message_but_not_for_a_policy_change() {
    let h = harness();
    h.receive(trigger("1"));
    h.pump();
    let ticket_id = h.decide(&h.last_request(), accept_plain("Fix")).unwrap().ticket_id.unwrap();
    h.report(&ticket_id, ReportState::Failed, "The prepare command failed");
    let starts = h.starts();
    h.set_version("v2");
    h.engine.policy_changed("v1", "v2", &HashMap::from([(ticket_id.clone(), PolicyEffect::default())]));
    assert_eq!(h.starts(), starts);
    h.tick(1);
    h.receive(by(trigger("2"), guest()));
    assert_eq!(h.starts(), starts + 1);
}

// replies

#[test]
fn acknowledges_a_persons_message_that_reached_an_open_ticket_once_and_refuses_others() {
    let h = harness();
    let ticket_id = h.accepted();
    // The acknowledgement of the accept stays; a later request for one reuses it.
    assert_eq!(h.engine.reply(ack(&ticket_id, "1", "On it")).unwrap(), Reply { id: key(&["ack", "1"]), status: ReplyStatus::Pending, reused: true });
    assert_eq!(h.outbox().into_iter().map(|m| m.text).collect::<Vec<_>>(), ids(&["ok"]));
    h.receive(by(trigger("2"), guest()));
    assert_eq!(h.engine.reply(ack(&ticket_id, "2", "Looking")).unwrap(), Reply { id: key(&["ack", "2"]), status: ReplyStatus::Pending, reused: false });
    h.receive(bot(trigger("3")));
    assert_eq!(Harness::code(h.engine.reply(ack(&ticket_id, "3", "x"))), "ackNotPerson");
    h.receive(on(trigger("6"), "elsewhere"));
    assert_eq!(Harness::code(h.engine.reply(ack(&ticket_id, "6", "x"))), "notReached");
    h.engine.stop_ticket(&ticket_id, None).unwrap();
    assert_eq!(Harness::code(h.engine.reply(ack(&ticket_id, "2", "x"))), "ackEnded");
}

#[test]
fn lets_a_worker_acknowledge_or_ask_no_one_on_a_thread_it_follows_only_for_context() {
    let h = harness();
    let ticket_id = h.accepted();
    h.engine.follow_for_context(&ticket_id, &thread("issue")).unwrap();
    h.receive(on(trigger("2"), "issue"));
    assert_eq!(Harness::code(h.engine.reply(ack(&ticket_id, "2", "On it"))), "notReached");
    let mut asking = report(ReportState::Progress, "asking");
    asking.question = Question::Ask("Q?".into());
    asking.asked_by = Some("2".into());
    assert_eq!(Harness::code(h.engine.report(&ticket_id, asking)), "notAsker");
}

#[test]
fn sends_an_answer_only_after_the_worker_reported_it_a_result_only_when_ready_and_attention_only_for_its_question() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(by(trigger("2"), guest()));
    assert_eq!(Harness::code(h.engine.reply(answer("2", "Yes"))), "noAnswer");
    let mut answered = report(ReportState::Progress, "Yes");
    answered.answers = Some("2".into());
    h.engine.report(&ticket_id, answered).unwrap();
    let sent = h.engine.reply(answer("2", "Yes")).unwrap();
    assert_eq!((sent.status, sent.reused), (ReplyStatus::Pending, false));
    let last = h.outbox().pop().unwrap();
    assert_eq!((last.channel, last.text.as_str(), last.kind), (channel("2"), "Yes", MessageKind::Reply));
    assert!(h.ticket(&ticket_id).answers.is_empty());
    // The same answer again reuses the queued message.
    assert!(h.engine.reply(answer("2", "Yes")).unwrap().reused);
    assert_eq!(Harness::code(h.engine.reply(result(&ticket_id, "Done"))), "notReady");
    let mut asking = report(ReportState::Progress, "asking");
    asking.question = Question::Ask("Which color?".into());
    asking.asked_by = Some("2".into());
    h.engine.report(&ticket_id, asking).unwrap();
    assert_eq!(Harness::code(h.engine.reply(attention(&ticket_id, Some("Which size?"), "x"))), "notAttention");
    // Without an open question there is nothing to ask, whether or not a question is named.
    let quiet = h.accepted_on("9", "t9");
    assert_eq!(Harness::code(h.engine.reply(attention(&quiet, None, "Anything to send."))), "notAttention");
    assert_eq!(Harness::code(h.engine.reply(attention(&quiet, Some(""), "Anything to send."))), "notAttention");
    let open = h.ticket(&ticket_id).attention.unwrap();
    assert_eq!(h.engine.reply(attention(&ticket_id, Some("Which color?"), "Which color?")).unwrap().id, key(&["attention-reply", &open.id]));
    // A question goes where the message that raised it was written.
    assert_eq!(h.outbox().pop().unwrap().channel, channel("2"));
    h.report(&ticket_id, ReportState::Ready, "Done");
    assert_eq!(h.engine.reply(result(&ticket_id, "Done")).unwrap().status, ReplyStatus::Pending);
    assert_eq!(h.outbox().pop().unwrap().channel, channel("1"));
    assert!(h.engine.reply(result(&ticket_id, "Done")).unwrap().reused);
    // The same result in other words is refused: the person has it.
    assert_eq!(Harness::code(h.engine.reply(result(&ticket_id, "It is done, in other words."))), "resultSent");
    assert_eq!(h.outbox().iter().filter(|message| message.kind == MessageKind::Reply && message.channel == channel("1")).count(), 1);
}

#[test]
fn answers_a_human_trigger_after_its_tickets_worker_handed_it_back() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(by(trigger("2"), guest()));
    assert_eq!(Harness::code(h.engine.reply(answer("2", "成都现在 16℃。"))), "noAnswer");
    h.engine.handback(&ticket_id, "2", "Weather is outside this ticket").unwrap();
    let sent = h.engine.reply(answer("2", "成都现在 16℃。")).unwrap();
    assert_eq!((sent.status, sent.reused), (ReplyStatus::Pending, false));
    let last = h.outbox().pop().unwrap();
    assert_eq!((last.channel, last.text.as_str(), last.ticket_id), (channel("2"), "成都现在 16℃。", None));
    assert_eq!(Harness::code(h.engine.reply(answer("missing", "x"))), "unknownTrigger");
}
