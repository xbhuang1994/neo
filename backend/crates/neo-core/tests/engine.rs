//! Engine behaviour: intake, evals, fan-out, resume and stop, follow-ups, hand-backs and context threads.

mod common;

/// The repository these tests run on; `neo-store` includes this file and provides its own at its crate root.
#[allow(dead_code)]
fn test_repo() -> std::sync::Arc<dyn neo_core::ports::Repositories> {
    std::sync::Arc::new(neo_core::memory::MemoryRepositories::new())
}

use common::*;
use neo_core::ids::key;
use neo_core::model::*;
use neo_core::ports::*;
use neo_core::reasons::Reason;
use neo_core::replies::{Purpose, ReplyRequest};
use neo_core::{ReceiveResult, UserError};
use std::sync::Arc;

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

// intake

#[test]
fn stores_a_trigger_once_and_records_source_filtering() {
    let h = harness();
    assert_eq!(h.receive(trigger("1")), ReceiveResult::Stored);
    assert_eq!(h.receive(trigger("1")), ReceiveResult::Duplicate);
    assert_eq!(h.receive(meta(trigger("2"), "blocked")), ReceiveResult::Filtered);
    assert_eq!(h.disposition("2").filtered, Some(Reason::code("chat not allowed")));
    assert_eq!(h.thread("chat:t1").pending, ids(&["1"]));
    assert_eq!(h.repo.trigger("1").unwrap().at, "2026-09-23T00:00:01.000Z");
}

#[test]
fn records_correlation_for_a_trigger_on_several_threads_and_evaluates_only_on_the_primary_one() {
    let h = harness();
    let mut both = trigger("1");
    both.threads = vec![thread("a"), thread("b")];
    h.receive(both);
    assert_eq!((h.thread("chat:a").pending, h.thread("chat:a").correlated), (ids(&["1"]), ids(&["chat:b"])));
    assert_eq!((h.thread("chat:b").pending, h.thread("chat:b").correlated), (ids(&[]), ids(&["chat:a"])));
}

#[test]
fn refuses_a_trigger_without_a_thread() {
    let h = harness();
    let mut orphan = trigger("1");
    orphan.threads.clear();
    assert_eq!(Harness::code(h.engine.receive(orphan)), "invalid");
}

// eval

#[test]
fn ignores_at_the_gate_without_an_assessor_when_nothing_is_admissible() {
    let h = harness();
    h.receive(bot(trigger("1")));
    h.pump();
    assert_eq!(h.requests(), 0);
    let decisions = h.decisions("chat:t1");
    assert_eq!(decisions.len(), 1);
    assert_eq!((decisions[0].kind, decisions[0].trigger_ids.clone()), (DecisionKind::Ignore, ids(&["1"])));
    assert_eq!(decisions[0].reason, vec![Reason::code("not human").of("1")]);
    assert!(h.disposition("1").decision_id.is_some());
}

#[test]
fn releases_the_assessors_state_for_every_eval_that_ends() {
    let h = harness();
    h.receive(trigger("1"));
    h.pump();
    h.decide(&h.request(0), ignore("chatter")).unwrap();
    assert_eq!(*h.r.released.lock().unwrap(), vec![h.request(0).eval_id]);
}

#[test]
fn serializes_evals_per_thread_and_debounces_triggers_that_arrive_meanwhile() {
    let h = harness();
    h.receive(trigger("1"));
    h.pump();
    h.receive(trigger("2"));
    h.receive(trigger("3"));
    h.pump();
    assert_eq!(h.requests(), 1);
    assert_eq!(h.thread("chat:t1").pending, ids(&["2", "3"]));
    h.decide(&h.request(0), ignore("chatter")).unwrap();
    h.pump();
    assert_eq!(h.request_ids(&h.request(1)), ids(&["2", "3"]));
    assert_eq!(h.request(1).strength, Strength::Explicit);
}

#[test]
fn accept_creates_a_ticket_with_a_mandate_subscription_acknowledgement_and_assignment() {
    let h = harness();
    let ticket = h.ticket(&h.accepted());
    assert_eq!(ticket.title, "Fix");
    assert_eq!((ticket.mandate.strength, ticket.mandate.policy_version.as_str(), ticket.mandate.scope.as_str()), (Strength::Explicit, "v1", "small"));
    assert_eq!(ticket.mandate.actor, member());
    assert_eq!(ticket.channels, vec![channel("1")]);
    assert_eq!((ticket.origin.trigger_id.as_str(), ticket.origin.trigger_ids.clone()), ("1", ids(&["1"])));
    assert!(ticket.ended.is_none());
    assert_eq!(ticket.assignments.len(), 1);
    assert_eq!(ticket.assignments[0].state, AssignmentState::Running);
    assert!(ticket.assignments[0].started_at.is_some());
    assert_eq!(h.thread("chat:t1").subscriptions, vec![ticket.id.clone()]);
    assert_eq!(
        h.outbox(),
        vec![OutboundMessage {
            id: key(&["ack", "1"]),
            channel: channel("1"),
            text: "ok".into(),
            kind: MessageKind::Acknowledgement,
            ticket_id: Some(ticket.id.clone())
        }]
    );
    assert_eq!(h.starts(), 1);
}

#[test]
fn refuses_to_decide_an_eval_that_a_later_eval_replaced_and_decides_the_later_one() {
    let h = harness();
    h.receive(trigger("1"));
    h.pump();
    let first = h.request(0);
    h.set_version("v2");
    h.engine.policy_changed("v1", "v2", &Default::default());
    h.pump();
    let second = h.request(1);
    let refused = h.decide(&first, ignore("chatter")).unwrap_err();
    assert!(refused.message.contains("has finished or a later eval replaced it"));
    let decision = h.decide(&second, ignore("chatter")).unwrap();
    assert_eq!((decision.kind, decision.eval_id), (DecisionKind::Ignore, second.eval_id));
}

#[test]
fn records_an_accept_with_its_ticket_subscriptions_and_acknowledgement_together_or_none_of_them() {
    let h = harness_with(Hooks { prepare: Some(Box::new(|_, _| Err(UserError::invalid("No directory for the ticket")))), ..Default::default() });
    h.receive(trigger("1"));
    h.pump();
    let eval_id = h.request(0).eval_id;
    assert!(h.decide(&h.request(0), accept_outcome()).unwrap_err().message.contains("No directory"));
    assert!(h.decisions("chat:t1").is_empty());
    assert!(h.repo.tickets().is_empty());
    let thread = h.thread("chat:t1");
    assert_eq!(thread.evaluating.map(|e| e.id), Some(eval_id));
    assert!(thread.subscriptions.is_empty());
    assert!(h.outbox().is_empty());
}

#[test]
fn records_unavailable_when_the_policy_version_changed_during_assessment() {
    let h = harness();
    h.receive(trigger("1"));
    h.pump();
    h.set_version("v2");
    let decision = h.decide(&h.request(0), accept_plain("x")).unwrap();
    assert_eq!(decision.kind, DecisionKind::Unavailable);
    assert!(h.repo.tickets().is_empty());
    // Its batch waits for a fresh Eval under the new version.
    h.pump();
    assert_eq!(h.last_ids(), ids(&["1"]));
    assert_eq!(h.last_request().policy_version, "v2");
}

#[test]
fn starts_every_pending_eval_in_one_step_so_a_second_pump_starts_none_again() {
    let h = harness();
    h.receive(on(trigger("1"), "A"));
    h.receive(on(trigger("2"), "B"));
    h.engine.evaluate_due();
    h.engine.evaluate_due();
    let keys: Vec<String> = h.r.requests.lock().unwrap().iter().map(|c| c.thread.key.clone()).collect();
    assert_eq!(keys, ids(&["chat:A", "chat:B"]));
}

#[test]
fn counts_a_deadline_from_delivery_requeues_twice_on_expiry_then_records_unavailable() {
    let h = harness();
    h.receive(trigger("1"));
    h.pump();
    // A candidate the assessor's Session has not taken does not expire.
    h.tick(600);
    h.pump();
    assert_eq!(h.engine.candidate("1").map(|c| c.eval_id), Some(h.request(0).eval_id));
    let deliver = || h.engine.candidate_delivered(&h.last_request().eval_id);
    deliver();
    h.tick(59);
    h.pump();
    assert_eq!(h.requests(), 1);
    // Expired, it records nothing and queues the Trigger for a fresh Eval, twice.
    h.tick(2);
    h.pump();
    assert!(h.decisions("chat:t1").is_empty());
    assert!(h.r.released.lock().unwrap().contains(&h.request(0).eval_id));
    assert_eq!(h.requests(), 2);
    assert_eq!(h.last_ids(), ids(&["1"]));
    deliver();
    h.tick(61);
    h.pump();
    assert_eq!(h.requests(), 3);
    // The third expiry is recorded unavailable.
    deliver();
    h.tick(61);
    h.pump();
    let decisions = h.decisions("chat:t1");
    assert_eq!(decisions.len(), 1);
    assert_eq!((decisions[0].kind, decisions[0].reason.clone()), (DecisionKind::Unavailable, vec![Reason::code("timeout")]));
    let thread = h.thread("chat:t1");
    assert!(thread.pending.is_empty() && thread.evaluating.is_none() && thread.expired.is_none());
}

#[test]
fn keeps_a_deadline_on_a_repeated_delivery_and_refuses_to_queue_a_held_trigger_again() {
    let h = harness();
    h.receive(trigger("1"));
    h.pump();
    h.engine.candidate_delivered(&h.request(0).eval_id);
    let deadline = h.thread("chat:t1").evaluating.unwrap().deadline;
    h.tick(10);
    h.engine.candidate_delivered(&h.request(0).eval_id);
    assert_eq!(h.thread("chat:t1").evaluating.unwrap().deadline, deadline);
    assert!(!h.engine.reevaluate("1").unwrap());
    assert_eq!(Harness::code(h.engine.reevaluate("nope")), "unknownTrigger");
    // Expired Triggers go ahead of what queued meanwhile.
    h.receive(trigger("2"));
    h.tick(61);
    h.pump();
    assert_eq!(h.last_ids(), ids(&["1", "2"]));
}

// subscription fan-out

#[test]
fn delivers_a_persons_later_message_on_a_subscribed_thread_to_the_live_ticket_and_not_to_eval() {
    let h = harness();
    let ticket_id = h.accepted();
    let requests = h.requests();
    h.receive(by(trigger("2"), guest()));
    h.pump();
    let ticket = h.ticket(&ticket_id);
    assert_eq!(ticket.inputs.len(), 1);
    assert_eq!(ticket.inputs[0].trigger_id(), Some("2"));
    assert!(ticket.undelivered.is_empty());
    assert_eq!(h.delivered(), vec![(ticket.id.clone(), ticket.inputs[0].id().to_string())]);
    let disposition = h.disposition("2");
    assert_eq!(disposition.fanout, vec![ticket.id.clone()]);
    assert!(disposition.eval_id.is_none() && disposition.context.is_empty());
    // No Eval, so no Decision and no timeout, and the Thread's queue stays free for a new request.
    assert_eq!((h.requests(), h.thread("chat:t1").pending.len(), h.decisions("chat:t1").len()), (requests, 0, 1));
    h.tick(600);
    h.engine.evaluate_due();
    assert_eq!(h.decisions("chat:t1").len(), 1);
    // A bot's message there still goes to Eval, which the gate does not admit.
    h.receive(bot(trigger("3")));
    h.pump();
    let last = h.decisions("chat:t1").pop().unwrap();
    assert_eq!((last.kind, last.trigger_ids), (DecisionKind::Ignore, ids(&["3"])));
}

#[test]
fn keeps_a_message_of_a_source_without_fanout_from_subscribed_tickets_and_delivers_it_only_where_attached() {
    let h = harness();
    let (first, second) = (h.accepted(), h.accepted_on("2", "t2"));
    h.receive(meta(trigger("3"), "routed"));
    h.pump();
    assert!(h.disposition("3").fanout.is_empty());
    assert!(h.ticket(&first).inputs.is_empty());
    // It went to Eval as a candidate, with the ticket still subscribed to the Thread.
    assert_eq!(h.last_ids(), ids(&["3"]));
    assert_eq!(h.thread("chat:t1").subscriptions, vec![first.clone()]);
    h.engine.attach(&second, "3", None).unwrap();
    h.settle();
    assert!(h.ticket(&first).inputs.is_empty());
    assert_eq!(h.ticket(&second).inputs.iter().map(|i| i.trigger_id()).collect::<Vec<_>>(), vec![Some("3")]);
    // The worker's topic becomes the ticket's digest for routing.
    let mut working = report(ReportState::Progress, "Working");
    working.topic = Some("Backtest check".into());
    h.engine.report(&second, working).unwrap();
    assert_eq!(h.ticket(&second).digest.as_deref(), Some("Backtest check"));
    h.report(&second, ReportState::Progress, "Still working");
    assert_eq!(h.ticket(&second).digest.as_deref(), Some("Backtest check"));
    // A drop only hands a message back, so it cannot change what the ticket is about.
    let mut dropped = report(ReportState::Dropped, "Handed back");
    dropped.topic = Some("Something else".into());
    h.engine.report(&second, dropped).unwrap();
    assert_eq!(h.ticket(&second).digest.as_deref(), Some("Backtest check"));
}

#[test]
fn lets_the_main_session_answer_a_message_that_reached_no_ticket_though_tickets_follow_its_thread() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(meta(trigger("2"), "routed"));
    h.pump();
    let answer = |trigger_id: &str, text: &str| ReplyRequest {
        purpose: Purpose::Answer,
        ticket_id: None,
        trigger_id: Some(trigger_id.into()),
        question: None,
        text: text.into(),
    };
    let reply = h.engine.reply(answer("2", "Hi")).unwrap();
    assert_eq!((reply.status, reply.reused), (ReplyStatus::Pending, false));
    let sent = h.outbox().pop().unwrap();
    assert_eq!((sent.channel, sent.text.as_str(), sent.kind, sent.ticket_id), (channel("2"), "Hi", MessageKind::Reply, None));
    // Once attached, the message is the ticket's, and only its worker's answer may be sent.
    h.receive(meta(trigger("3"), "routed"));
    h.pump();
    h.engine.attach(&ticket_id, "3", None).unwrap();
    h.settle();
    assert_eq!(Harness::code(h.engine.reply(answer("3", "Yes"))), "noAnswer");
}

#[test]
fn keeps_inputs_undelivered_until_an_assignment_runs_and_asks_to_launch_a_failed_launch_again() {
    let h = harness();
    h.receive(trigger("1"));
    h.pump();
    let ticket_id = h.decide(&h.request(0), accept_plain("Fix")).unwrap().ticket_id.unwrap();
    h.settle_with(false);
    h.receive(trigger("2"));
    h.engine.evaluate_due();
    h.settle_with(false);
    let ticket = h.ticket(&ticket_id);
    assert_eq!(ticket.undelivered.len(), 1);
    assert_eq!((h.delivers(), h.starts()), (0, 2));
    h.engine.assignment_started(&ticket.id, &ticket.assignments[0].id).unwrap();
    h.settle();
    assert_eq!(h.delivered(), vec![(ticket.id.clone(), ticket.undelivered[0].clone())]);
}

#[test]
fn does_not_hand_a_bots_message_to_an_ended_ticket() {
    let h = harness();
    let ticket_id = h.accepted();
    h.report(&ticket_id, ReportState::Ready, "done");
    h.receive(bot(trigger("2")));
    h.pump();
    let ticket = h.ticket(&ticket_id);
    assert!(ticket.ended.is_some() && ticket.undelivered.is_empty());
    assert_eq!(h.starts(), 1);
}

#[test]
fn resumes_once_however_often_it_pumps_and_drops_what_waited_when_the_mandate_no_longer_holds() {
    let h = harness();
    let ticket_id = h.accepted();
    h.report(&ticket_id, ReportState::Ready, "done");
    h.set_version("revoked");
    h.receive(by(trigger("2"), guest()));
    h.pump();
    let ticket = h.ticket(&ticket_id);
    assert!(ticket.ended.is_some() && ticket.undelivered.is_empty());
    h.set_version("v1");
    h.pump();
    assert!(h.ticket(&ticket_id).ended.is_some());
    h.receive(by(trigger("3"), guest()));
    h.pump();
    h.pump();
    let ticket = h.ticket(&ticket_id);
    assert_eq!(ticket.assignments.len(), 2);
    assert_eq!(ticket.inputs.iter().filter(|input| matches!(input, TicketInput::Resumed { .. })).count(), 1);
}

#[test]
fn takes_delivery_reports_only_from_the_assignment_that_still_runs_the_open_ticket() {
    let h = harness();
    let ticket_id = h.accepted();
    let assignment = h.ticket(&ticket_id).assignments[0].id.clone();
    h.receive(trigger("2"));
    let input = key(&["input", &ticket_id, "trigger", "2"]);
    h.engine.delivery_failed(&ticket_id, &assignment, "Session busy").unwrap();
    assert_eq!(h.ticket(&ticket_id).delivery.map(|d| d.error), Some("Session busy".into()));
    h.engine.delivery_failed(&ticket_id, "another", "other").unwrap();
    h.engine.inputs_delivered(&ticket_id, "another", std::slice::from_ref(&input)).unwrap();
    let ticket = h.ticket(&ticket_id);
    assert_eq!((ticket.undelivered.clone(), ticket.delivery.map(|d| d.error)), (vec![input.clone()], Some("Session busy".into())));
    h.engine.inputs_delivered(&ticket_id, &assignment, std::slice::from_ref(&input)).unwrap();
    let ticket = h.ticket(&ticket_id);
    assert!(ticket.undelivered.is_empty() && ticket.delivery.is_none());
    h.receive(trigger("3"));
    h.engine.stop_ticket(&ticket_id, None).unwrap();
    h.engine.delivery_failed(&ticket_id, &assignment, "late").unwrap();
    let ticket = h.ticket(&ticket_id);
    assert!(ticket.ended.is_some() && ticket.undelivered.is_empty() && ticket.delivery.is_none());
}

#[test]
fn unsubscribing_a_thread_stops_fanout_until_a_new_decision_subscribes_it() {
    let h = harness();
    let ticket_id = h.accepted();
    assert!(h.engine.unsubscribe("chat:t1").unwrap());
    assert!(!h.engine.unsubscribe("chat:t1").unwrap());
    h.receive(trigger("2"));
    h.pump();
    assert!(h.ticket(&ticket_id).inputs.is_empty());
}

#[test]
fn lets_an_executor_drop_a_thread_attached_to_its_ticket_but_not_its_own_thread() {
    let h = harness();
    let first = h.accepted();
    let second = h.accepted_on("2", "t2");
    h.receive(on(trigger("3"), "t2"));
    // A follow-up of the second ticket goes to the first only once the second's worker hands it back.
    h.engine.handback(&second, "3", "It is about the first fix").unwrap();
    h.engine.attach(&first, "3", None).unwrap();
    assert_eq!(h.thread("chat:t2").subscriptions, vec![second.clone(), first.clone()]);
    h.engine.mark_unrelated(&first, "chat:t2", "about another fix").unwrap();
    assert_eq!(h.thread("chat:t2").subscriptions, vec![second.clone()]);
    let dropped: Vec<DomainEvent> = h.r.events.lock().unwrap().iter().filter(|e| matches!(e, DomainEvent::ThreadUnsubscribed { .. })).cloned().collect();
    assert_eq!(
        dropped,
        vec![DomainEvent::ThreadUnsubscribed {
            thread_key: "chat:t2".into(),
            ticket_id: first.clone(),
            by_person: false,
            reason: Some("about another fix".into())
        }]
    );
    assert_eq!(Harness::code(h.engine.mark_unrelated(&first, "chat:t2", "again")), "notFollowing");
    assert_eq!(Harness::code(h.engine.mark_unrelated(&first, "chat:t1", "its own")), "sourceThread");
}

// resume and stop

fn ended(h: &Harness, by_person: bool) -> String {
    let ticket_id = h.accepted();
    if by_person {
        h.engine.stop_ticket(&ticket_id, None).unwrap();
    } else {
        h.report(&ticket_id, ReportState::Ready, "done");
    }
    ticket_id
}

#[test]
fn resumes_an_ended_ticket_on_any_persons_message_under_the_same_mandate_without_a_decision() {
    let h = harness();
    let ticket_id = ended(&h, false);
    assert_eq!(h.ticket(&ticket_id).ended.map(|e| (e.by, e.outcome)), Some((TicketEndBy::Executor, TicketOutcome::Completed)));
    let decisions = h.decisions("chat:t1").len();
    // It resumes as the message arrives, before any Eval of it.
    h.receive(by(trigger("2"), guest()));
    assert!(h.ticket(&ticket_id).ended.is_none());
    h.pump();
    let ticket = h.ticket(&ticket_id);
    assert_eq!(ticket.assignments.len(), 2);
    assert_eq!(ticket.mandate.policy_version, "v1");
    assert!(matches!(ticket.inputs.as_slice(), [TicketInput::Trigger { .. }, TicketInput::Resumed { .. }]));
    // The resumed marker reached the worker ahead of the message.
    let order: Vec<String> = h.delivered().into_iter().map(|(_, id)| id).collect();
    assert_eq!(order, vec![ticket.inputs[1].id().to_string(), ticket.inputs[0].id().to_string()]);
    assert_eq!(h.starts(), 2);
    assert_eq!(h.decisions("chat:t1").iter().filter(|d| d.kind != DecisionKind::Ignore).count(), decisions);
}

#[test]
fn resumes_an_ended_ticket_at_once_when_a_message_is_attached_to_it() {
    let h = harness();
    let ticket_id = ended(&h, false);
    h.receive(by(on(trigger("2"), "elsewhere"), guest()));
    let subject = h.engine.attach(&ticket_id, "2", None).unwrap();
    assert!(subject.ended.is_none());
    assert_eq!(subject.assignments.iter().map(|a| a.state).collect::<Vec<_>>(), vec![AssignmentState::Ended, AssignmentState::Pending]);
}

#[test]
fn keeps_a_ticket_a_person_stopped_ended() {
    let h = harness();
    let ticket_id = ended(&h, true);
    assert_eq!(h.stops(), 1);
    h.receive(trigger("2"));
    h.pump();
    assert_eq!(h.ticket(&ticket_id).ended.map(|e| (e.by, e.outcome)), Some((TicketEndBy::Human, TicketOutcome::Stopped)));
    assert_eq!(h.starts(), 1);
    assert_eq!(Harness::code(h.engine.attach(&ticket_id, "2", None)), "ticketStopped");
}

#[test]
fn keeps_a_ticket_ended_when_its_mandate_no_longer_passes_the_current_policy() {
    let h = harness();
    let ticket_id = ended(&h, false);
    h.set_version("revoked");
    h.receive(trigger("2"));
    h.pump();
    assert!(h.ticket(&ticket_id).ended.is_some());
    // The message reached no ticket after all, so it is assessed.
    assert!(h.disposition("2").fanout.is_empty());
    assert_eq!(h.last_ids(), ids(&["2"]));
    h.receive(on(trigger("3"), "x"));
    assert_eq!(Harness::code(h.engine.attach(&ticket_id, "3", None)), "mandateRevoked");
}

#[test]
fn waits_out_a_pause_before_resuming_an_ended_ticket() {
    let h = harness();
    let ticket_id = ended(&h, false);
    h.set_paused(true);
    h.receive(by(trigger("2"), guest()));
    h.pump();
    assert!(h.ticket(&ticket_id).ended.is_some());
    assert_eq!(h.ticket(&ticket_id).undelivered.len(), 1);
    h.set_paused(false);
    h.pump();
    assert!(h.ticket(&ticket_id).ended.is_none());
}

#[test]
fn stops_a_live_ticket_only_on_an_explicit_instruction_and_ends_it_by_the_human() {
    let h = harness();
    let ticket_id = h.accepted();
    // Follow-ups that reached the ticket: the gate judges them when the main Session acts on one, a guest's as inferred.
    h.receive(by(trigger("2"), guest()));
    h.pump();
    let refused = h.engine.decide("2", stop(&ticket_id, "x")).unwrap();
    assert_eq!((refused.kind, refused.strength, refused.reason), (DecisionKind::Ignore, Strength::Inferred, vec![Reason::code("stopNotExplicit")]));
    h.receive(trigger("3"));
    h.pump();
    assert_eq!(h.engine.decide("3", stop(&ticket_id, "human said stop")).unwrap().kind, DecisionKind::Stop);
    let ended = h.ticket(&ticket_id).ended.unwrap();
    assert_eq!((ended.by, ended.reason.as_deref()), (TicketEndBy::Human, Some("human said stop")));
    assert_eq!(h.stops(), 1);
}

#[test]
fn records_a_stop_that_names_an_unknown_or_ended_ticket_as_ignored() {
    let h = harness();
    let ticket_id = ended(&h, false);
    h.receive(on(trigger("2"), "x"));
    for target in ["missing", ticket_id.as_str()] {
        h.receive(on(trigger(if target == "missing" { "3" } else { "4" }), "x"));
    }
    let unknown = h.engine.decide("3", stop("missing", "stop")).unwrap();
    let over = h.engine.decide("4", stop(&ticket_id, "stop")).unwrap();
    for decision in [unknown, over] {
        assert_eq!((decision.kind, decision.reason), (DecisionKind::Ignore, vec![Reason::code("stopUnknown")]));
    }
}

// follow-ups

#[test]
fn keeps_a_follow_up_a_person_sent_to_eval_again_in_the_queue() {
    let h = harness();
    h.accepted();
    h.receive(by(trigger("2"), guest()));
    h.receive(by(trigger("3"), guest()));
    assert!(h.thread("chat:t1").pending.is_empty());
    assert!(h.engine.reevaluate("3").unwrap());
    h.pump();
    assert_eq!(h.last_ids(), ids(&["3"]));
    assert!(h.thread("chat:t1").pending.is_empty());
    assert_eq!(h.decisions("chat:t1").iter().flat_map(|d| d.trigger_ids.clone()).collect::<Vec<_>>(), ids(&["1"]));
}

#[test]
fn decides_a_follow_up_in_a_gate_only_eval_beside_the_eval_its_thread_has_in_progress() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(by(trigger("2"), guest()));
    h.engine.reevaluate("2").unwrap();
    h.pump();
    let evaluating = h.thread("chat:t1").evaluating.unwrap();
    h.receive(trigger("3"));
    let decision = h.engine.decide("3", stop(&ticket_id, "stop it")).unwrap();
    assert_eq!((decision.kind, decision.trigger_ids), (DecisionKind::Stop, ids(&["3"])));
    assert_eq!(h.thread("chat:t1").evaluating, Some(evaluating));
    let other = h.decide(&h.last_request(), ignore("chat")).unwrap();
    assert_eq!((other.kind, other.trigger_ids), (DecisionKind::Ignore, ids(&["2"])));
}

#[test]
fn leaves_the_thread_free_for_a_later_request_that_reaches_no_ticket() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(by(trigger("2"), guest()));
    h.pump();
    h.engine.stop_ticket(&ticket_id, Some("not needed")).unwrap();
    // The follow-up held no Eval while the ticket decided it, so the next request is assessed at once, together with
    // the follow-up, which the stop let go of before its worker took it up.
    h.receive(trigger("3"));
    h.pump();
    assert_eq!(h.last_ids(), ids(&["2", "3"]));
}

// hand-back

#[test]
fn queues_a_handed_back_message_for_a_fresh_eval_once_per_ticket_and_keeps_the_subscription() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(trigger("2"));
    h.receive(by(trigger("3"), guest()));
    h.pump();
    assert!(h.engine.handback(&ticket_id, "2", "A new request").unwrap());
    h.pump();
    assert_eq!((h.last_request().strength, h.last_ids()), (Strength::Explicit, ids(&["2"])));
    let handbacks = h.disposition("2").handbacks;
    assert_eq!(handbacks.iter().map(|b| (b.ticket_id.as_str(), b.reason.as_str())).collect::<Vec<_>>(), vec![(ticket_id.as_str(), "A new request")]);
    h.decide(&h.last_request(), ignore("chat")).unwrap();
    assert_eq!(Harness::code(h.engine.handback(&ticket_id, "2", "Again")), "handedBack");
    assert!(h.engine.handback(&ticket_id, "3", "A guest asks for more").unwrap());
    h.pump();
    assert_eq!((h.last_request().strength, h.last_ids()), (Strength::Inferred, ids(&["3"])));
    assert!(h.thread("chat:t1").subscriptions.contains(&ticket_id));
    // Only a message that reached the ticket can go back.
    h.receive(on(trigger("4"), "elsewhere"));
    assert_eq!(Harness::code(h.engine.handback(&ticket_id, "4", "Not mine")), "notReached");
}

#[test]
fn queues_again_no_message_the_ticket_did_not_decide() {
    let h = harness();
    let ticket_id = h.accepted();
    h.engine.follow_for_context(&ticket_id, &thread("issue")).unwrap();
    h.receive(trigger("2"));
    h.engine.reevaluate("2").unwrap();
    h.receive(bot(trigger("3")));
    h.receive(on(trigger("4"), "issue"));
    h.pump();
    let count = h.requests();
    for index in [count - 2, count - 1] {
        h.decide(&h.request(index), ignore("chat")).unwrap();
    }
    // Each went to Eval without the ticket, and its Decision stands.
    for id in ["2", "3", "4"] {
        assert!(!h.engine.handback(&ticket_id, id, "Not this ticket").unwrap());
    }
    assert!(h.thread("chat:t1").pending.is_empty() && h.thread("chat:issue").pending.is_empty());
    // The hand-back is recorded all the same, so the main Session does not attach the message back.
    assert_eq!(h.disposition("4").handbacks.len(), 1);
    assert_eq!(Harness::code(h.engine.attach(&ticket_id, "4", None)), "handedBackHere");
}

#[test]
fn leaves_an_attached_message_to_the_tickets_worker_whose_hand_back_sends_it_to_eval() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(on(trigger("2"), "x"));
    h.pump();
    h.engine.attach(&ticket_id, "2", None).unwrap();
    h.settle();
    // Routed to the ticket, it is not new work as well.
    let refused = h.engine.decide("2", accept_plain("Y")).unwrap_err();
    assert_eq!(refused, UserError::with("workerDecides", &[("tickets", &ticket_id)]));
    assert!(h.engine.handback(&ticket_id, "2", "Asks for another change").unwrap());
    assert_eq!(h.thread("chat:x").pending, ids(&["2"]));
}

// context threads and notes

#[test]
fn fans_a_thread_followed_for_context_out_to_the_live_ticket_and_resumes_no_ended_ticket_from_it() {
    let h = harness();
    let ticket_id = h.accepted();
    assert!(h.engine.follow_for_context(&ticket_id, &thread("issue")).unwrap());
    assert!(!h.engine.follow_for_context(&ticket_id, &thread("issue")).unwrap());
    h.receive(on(trigger("2"), "issue"));
    h.settle();
    assert_eq!(h.ticket(&ticket_id).inputs.iter().map(|i| i.trigger_id()).collect::<Vec<_>>(), vec![Some("2")]);
    h.report(&ticket_id, ReportState::Dropped, "nothing to do");
    h.receive(on(trigger("3"), "issue"));
    assert!(h.ticket(&ticket_id).ended.is_some());
    // Attached by the main Session, the Thread is the ticket's own, and a person's later message there resumes it.
    h.engine.attach(&ticket_id, "3", None).unwrap();
    h.settle();
    assert!(h.thread("chat:issue").context.is_empty());
    h.report(&ticket_id, ReportState::Dropped, "nothing to do");
    assert!(h.ticket(&ticket_id).ended.is_some());
    h.receive(on(trigger("4"), "issue"));
    assert!(h.ticket(&ticket_id).ended.is_none());
}

#[test]
fn counts_a_message_on_a_context_thread_as_none_of_the_tickets_follow_ups_and_lifts_no_block_with_it() {
    let h = harness();
    let owner = h.accepted();
    let follower = h.accepted_on("2", "other");
    h.engine.follow_for_context(&follower, &thread("t1")).unwrap();
    h.receive(by(trigger("3"), guest()));
    h.pump();
    let disposition = h.disposition("3");
    assert_eq!((disposition.fanout, disposition.context), (vec![owner.clone(), follower.clone()], vec![follower.clone()]));
    assert!(matches!(h.ticket(&follower).inputs.last(), Some(TicketInput::Trigger { trigger_id, context: true, .. }) if trigger_id == "3"));
    // A message reaching only the follower goes to Eval, with the guest's that the stopped owner let go of.
    h.engine.stop_ticket(&owner, Some("done")).unwrap();
    h.report(&follower, ReportState::Blocked, "needs a decision");
    h.receive(trigger("4"));
    h.pump();
    assert_eq!(h.last_ids(), ids(&["3", "4"]));
    assert!(h.ticket(&follower).waits_for_person());
}

#[test]
fn sends_a_message_to_eval_when_only_a_ticket_following_its_thread_for_context_is_left() {
    let h = harness();
    let owner = h.accepted();
    let follower = h.accepted_on("2", "other");
    h.engine.follow_for_context(&follower, &thread("t1")).unwrap();
    h.report(&owner, ReportState::Ready, "done");
    h.set_version("revoked");
    h.receive(trigger("3"));
    h.set_version("v1");
    h.pump();
    let disposition = h.disposition("3");
    assert_eq!((disposition.fanout, disposition.context), (vec![follower.clone()], vec![follower]));
    assert_eq!(h.last_ids(), ids(&["3"]));
}

#[test]
fn gives_an_open_tickets_worker_a_note_held_like_automatic_input_and_refuses_one_for_an_ended_ticket() {
    let h = harness();
    let ticket_id = h.accepted();
    let noted = h.engine.note(&ticket_id, "The other ticket renamed the API").unwrap();
    assert!(matches!(noted.inputs.last(), Some(TicketInput::Note { text, .. }) if text == "The other ticket renamed the API"));
    // A worker that reported blocked waits for a person: a note does not wake it.
    h.settle();
    h.report(&ticket_id, ReportState::Blocked, "needs a decision");
    let note = h.engine.note(&ticket_id, "Ticket B changed the schema").unwrap().inputs.last().cloned().unwrap();
    h.settle();
    assert!(!h.delivered().iter().any(|(_, id)| id == note.id()));
    assert!(h.ticket(&ticket_id).inputs.contains(&note));
    h.engine.stop_ticket(&ticket_id, Some("done")).unwrap();
    assert_eq!(Harness::code(h.engine.note(&ticket_id, "Too late")), "ticketEnded");
}

#[test]
fn takes_a_mixed_batchs_strength_actor_and_basis_from_its_strongest_admissible_trigger() {
    let gate: Arc<Gate> = Arc::new(|trigger, _| match trigger.actor.id.as_str() {
        "alice" => explicit(),
        "guest" => inferred(),
        _ => GateResult::Inadmissible { reason: "not a member".into() },
    });
    let h = harness_with(Hooks { gate: Some(gate), ..Default::default() });
    h.receive(by(trigger("1"), guest()));
    h.receive(trigger("2"));
    h.receive(trigger("3"));
    h.receive(by(trigger("4"), guest()));
    h.receive(by(trigger("5"), ActorRef { source: "chat".into(), id: "stranger".into() }));
    h.pump();
    let evaluation = h.thread("chat:t1").evaluating.unwrap();
    // The latest of the explicit ones gives the batch its origin.
    assert_eq!((evaluation.strength, evaluation.primary.as_deref(), evaluation.actor.id.as_str()), (Strength::Explicit, Some("3"), "alice"));
    assert_eq!(evaluation.trigger_ids, ids(&["1", "2", "3", "4", "5"]));
    let ticket_id = h.decide(&h.last_request(), accept_outcome()).unwrap().ticket_id.unwrap();
    let ticket = h.ticket(&ticket_id);
    assert_eq!(ticket.origin.trigger_id, "3");
    assert_eq!(h.outbox()[0].id, key(&["ack", "3"]));
    assert_eq!(ticket.channels.len(), 5);
}
