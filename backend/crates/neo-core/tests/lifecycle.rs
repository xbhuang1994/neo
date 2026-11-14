//! Assignment lifecycle: retries, failed deliveries, revoked Mandates, and what counts as read when a ticket ends.

mod common;

/// The repository these tests run on; `neo-store` includes this file and provides its own at its crate root.
#[allow(dead_code)]
fn test_repo() -> std::sync::Arc<dyn neo_core::ports::Repositories> {
    std::sync::Arc::new(neo_core::memory::MemoryRepositories::new())
}

use common::*;
use neo_core::model::*;
use neo_core::ports::*;
use neo_core::reasons::Reason;
use neo_core::stage::{can_retry, ticket_stage, PersonAction, TicketStage};

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}
fn running(h: &Harness, ticket_id: &str) -> String {
    h.ticket(ticket_id).running().expect("an assignment runs").id.clone()
}
fn input_of(h: &Harness, ticket_id: &str, trigger_id: &str) -> String {
    h.ticket(ticket_id).inputs.iter().find(|input| input.trigger_id() == Some(trigger_id)).expect("the trigger reached the ticket").id().to_string()
}
fn pending(h: &Harness) -> Vec<String> {
    h.thread("chat:t1").pending
}

#[test]
fn retries_a_failed_ticket_with_a_new_assignment_and_asks_only_a_waiting_worker_for_its_status() {
    let h = harness();
    let ticket_id = h.accepted();
    assert_eq!(Harness::code(h.engine.retry_ticket(&ticket_id)), "notRetryable");
    assert!(!h.engine.request_status(&ticket_id).unwrap());
    assert!(h.ticket(&ticket_id).inputs.is_empty());
    h.report(&ticket_id, ReportState::Waiting, "idle");
    assert_eq!(ticket_stage(&h.ticket(&ticket_id)), TicketStage::Idle);
    assert!(h.engine.request_status(&ticket_id).unwrap());
    assert!(matches!(h.ticket(&ticket_id).inputs.as_slice(), [TicketInput::Text { text, .. }] if text.contains("status-only")));
    h.report(&ticket_id, ReportState::Failed, "broke");
    assert!(can_retry(&h.ticket(&ticket_id)));
    let (starts, stops) = (h.starts(), h.stops());
    let retried = h.engine.retry_ticket(&ticket_id).unwrap();
    assert_eq!(retried.assignments.len(), 2);
    assert_eq!((retried.assignments[0].state, retried.assignments[0].ended_reason.as_deref()), (AssignmentState::Ended, Some("retried")));
    assert_eq!(retried.assignments[1].state, AssignmentState::Pending);
    assert_eq!((h.starts(), h.stops()), (starts + 1, stops + 1));
    assert_eq!(h.r.launches.lock().unwrap().back().map(|(_, a)| a.id.clone()), Some(retried.assignments[1].id.clone()));
    assert_eq!(Harness::code(h.engine.retry_ticket("missing")), "unknownTicket");
}

#[test]
fn wakes_a_running_worker_for_the_watchdog_and_leaves_an_ended_ticket_alone() {
    let h = harness();
    let ticket_id = h.accepted();
    assert!(h.engine.wake_worker(&ticket_id, "The build finished 10 minutes ago.").unwrap());
    h.settle();
    assert!(matches!(h.ticket(&ticket_id).inputs.as_slice(), [TicketInput::Text { text, .. }] if text == "[Watchdog] The build finished 10 minutes ago."));
    assert_eq!(h.delivered().len(), 1);
    h.engine.stop_ticket(&ticket_id, None).unwrap();
    assert!(!h.engine.wake_worker(&ticket_id, "again").unwrap());
}

#[test]
fn forgets_a_failed_delivery_once_a_new_assignment_takes_over_or_the_ticket_ends() {
    let h = harness();
    let ticket_id = h.accepted();
    let failed = || {
        h.engine.delivery_failed(&ticket_id, &running(&h, &ticket_id), "Session busy").unwrap();
        assert_eq!(h.ticket(&ticket_id).delivery.map(|d| d.error), Some("Session busy".into()));
    };
    failed();
    h.report(&ticket_id, ReportState::Blocked, "needs access");
    h.engine.retry_ticket(&ticket_id).unwrap();
    h.settle();
    assert!(h.ticket(&ticket_id).delivery.is_none());
    failed();
    h.engine.stop_ticket(&ticket_id, None).unwrap();
    assert!(h.ticket(&ticket_id).delivery.is_none());
}

#[test]
fn starts_a_new_assignment_for_a_ticket_whose_input_keeps_failing_to_reach_its_worker() {
    let h = harness();
    let ticket_id = h.accepted();
    h.report(&ticket_id, ReportState::Failed, "tests fail");
    // A person's answer goes to the failed worker, and delivering it fails.
    h.tick(5);
    h.receive(trigger("2"));
    assert_eq!(h.ticket(&ticket_id).undelivered.len(), 1);
    h.engine.delivery_failed(&ticket_id, &running(&h, &ticket_id), "Session gone").unwrap();
    assert_eq!(ticket_stage(&h.ticket(&ticket_id)), TicketStage::Person(PersonAction::Delivery));
    let retried = h.engine.retry_ticket(&ticket_id).unwrap();
    assert_eq!(retried.assignments.iter().map(|a| a.state).collect::<Vec<_>>(), vec![AssignmentState::Ended, AssignmentState::Pending]);
    assert!(retried.delivery.is_none());
    assert_eq!(retried.undelivered.len(), 1);
}

#[test]
fn truncates_a_long_delivery_error() {
    let h = harness();
    let ticket_id = h.accepted();
    h.engine.delivery_failed(&ticket_id, &running(&h, &ticket_id), &"界".repeat(500)).unwrap();
    assert_eq!(h.ticket(&ticket_id).delivery.unwrap().error.chars().count(), 300);
}

#[test]
fn changes_nothing_on_a_late_start_of_an_assignment_a_retry_replaced() {
    let h = harness();
    let ticket_id = h.accepted();
    let first = h.ticket(&ticket_id).assignments[0].id.clone();
    h.report(&ticket_id, ReportState::Failed, "broke");
    h.engine.retry_ticket(&ticket_id).unwrap();
    let before = h.ticket(&ticket_id);
    let delivered = h.delivered().len();
    h.engine.assignment_started(&ticket_id, &first).unwrap();
    h.settle_with(false);
    assert_eq!(h.ticket(&ticket_id).assignments, before.assignments);
    assert_eq!(h.delivered().len(), delivered);
}

#[test]
fn refuses_to_retry_a_ticket_a_person_stopped_after_its_failed_report() {
    let h = harness();
    let ticket_id = h.accepted();
    h.report(&ticket_id, ReportState::Failed, "broke");
    h.engine.stop_ticket(&ticket_id, None).unwrap();
    assert_eq!(Harness::code(h.engine.retry_ticket(&ticket_id)), "notRetryable");
}

#[test]
fn queues_an_evals_batch_again_when_it_is_decided_under_an_older_policy() {
    let h = harness();
    h.receive(trigger("1"));
    h.pump();
    let candidate = h.last_request();
    // The version changes without a Policy change being reported, such as across a restart.
    h.set_version("v2");
    let decision = h.decide(&candidate, accept_plain("Fix")).unwrap();
    assert_eq!((decision.kind, decision.reason), (DecisionKind::Unavailable, vec![Reason::code("policyChanged")]));
    assert_eq!(pending(&h), ids(&["1"]));
    h.pump();
    assert_eq!((h.last_request().policy_version, h.last_ids()), ("v2".to_string(), ids(&["1"])));
}

#[test]
fn queues_a_persons_message_for_eval_when_the_only_ticket_it_reached_cannot_resume_under_the_policy_now() {
    let h = harness();
    let ticket_id = h.accepted();
    h.report(&ticket_id, ReportState::Ready, "Done");
    h.settle();
    h.set_version("revoked");
    h.tick(5);
    h.receive(trigger("2"));
    let ticket = h.ticket(&ticket_id);
    assert!(ticket.undelivered.is_empty() && ticket.ended.is_some());
    assert_eq!(pending(&h), ids(&["2"]));
    assert!(followup_owners(&h.repo.trigger("2").unwrap(), &Records(h.repo.as_ref())).is_empty());
}

#[test]
fn queues_a_message_that_waited_out_a_pause_for_eval_when_its_ticket_cannot_resume_once_the_pause_lifts() {
    let h = harness();
    let ticket_id = h.accepted();
    h.report(&ticket_id, ReportState::Ready, "Done");
    h.settle();
    h.set_paused(true);
    h.tick(5);
    h.receive(trigger("2"));
    h.pump();
    assert_eq!(h.ticket(&ticket_id).undelivered.len(), 1);
    h.set_version("revoked");
    h.set_paused(false);
    h.engine.evaluate_due();
    let ticket = h.ticket(&ticket_id);
    assert!(ticket.undelivered.is_empty() && ticket.ended.is_some());
    assert!(pending(&h).contains(&"2".to_string()) || h.engine.candidate("2").is_some());
}

// what a worker read

#[test]
fn lets_a_stop_send_to_eval_a_message_that_waited_for_delivery_when_a_turn_ended() {
    let h = harness();
    let ticket_id = h.accepted();
    h.report(&ticket_id, ReportState::Progress, "working");
    h.tick(1);
    h.receive(trigger("2"));
    let assignment = running(&h, &ticket_id);
    let input = h.ticket(&ticket_id).undelivered[0].clone();
    // The turn ends while the message is on its way; it reaches the worker after, and a person stops the ticket.
    h.tick(1);
    h.engine.turn_ended(&ticket_id, &assignment).unwrap();
    h.tick(1);
    h.engine.inputs_delivered(&ticket_id, &assignment, &[input]).unwrap();
    h.tick(1);
    h.engine.stop_ticket(&ticket_id, Some("not needed")).unwrap();
    assert_eq!(pending(&h), ids(&["2"]));
}

#[test]
fn lets_a_stop_send_to_eval_a_message_that_came_before_a_waiting_report_but_reached_the_worker_after_it() {
    let h = harness();
    let ticket_id = h.accepted();
    h.tick(1);
    h.receive(trigger("2"));
    let assignment = running(&h, &ticket_id);
    let input = h.ticket(&ticket_id).undelivered[0].clone();
    h.tick(1);
    h.report(&ticket_id, ReportState::Waiting, "Waiting for input");
    h.tick(1);
    h.engine.inputs_delivered(&ticket_id, &assignment, &[input]).unwrap();
    h.tick(1);
    h.engine.stop_ticket(&ticket_id, Some("not needed")).unwrap();
    assert_eq!(pending(&h), ids(&["2"]));
}

/// A ticket that ended, resumed by a person's message `2`, whose new Assignment started; its Inputs wait for delivery.
fn resumed() -> (Harness, String, String, String, String) {
    let h = harness();
    let ticket_id = h.accepted();
    h.report(&ticket_id, ReportState::Ready, "done");
    h.tick(1);
    h.receive(trigger("2"));
    let assignment = h.ticket(&ticket_id).assignments.last().unwrap().id.clone();
    h.tick(1);
    h.engine.assignment_started(&ticket_id, &assignment).unwrap();
    let waiting = h.ticket(&ticket_id).undelivered;
    assert_eq!(waiting.len(), 2);
    let (note, message) = (waiting[0].clone(), waiting[1].clone());
    (h, ticket_id, assignment, note, message)
}

#[test]
fn sends_to_eval_a_message_that_reached_its_worker_only_after_a_progress_report_at_a_dropped_report() {
    let (h, ticket_id, assignment, note, message) = resumed();
    // Delivering the message fails at first; the worker reports progress, and the retry hands the message over while
    // it writes that nothing is left.
    h.engine.inputs_delivered(&ticket_id, &assignment, &[note]).unwrap();
    h.engine.delivery_failed(&ticket_id, &assignment, "Session busy").unwrap();
    h.tick(1);
    h.report(&ticket_id, ReportState::Progress, "Looking");
    h.tick(1);
    h.engine.inputs_delivered(&ticket_id, &assignment, &[message]).unwrap();
    h.tick(1);
    h.report(&ticket_id, ReportState::Dropped, "Nothing to do");
    assert_eq!(pending(&h), ids(&["2"]));
}

#[test]
fn counts_a_message_as_read_by_a_later_dropped_report_once_the_session_took_it_into_a_step() {
    let (h, ticket_id, assignment, note, message) = resumed();
    // The Session takes it into the step its arrival starts, before the Executor records the delivery.
    h.engine.inputs_read(&ticket_id, std::slice::from_ref(&message)).unwrap();
    h.engine.inputs_delivered(&ticket_id, &assignment, &[note, message]).unwrap();
    h.tick(1);
    h.report(&ticket_id, ReportState::Progress, "Looking");
    h.tick(1);
    h.report(&ticket_id, ReportState::Dropped, "Nothing to do");
    assert!(pending(&h).is_empty());
}

#[test]
fn counts_a_message_delivered_after_a_failure_and_a_turn_end_as_read_only_once_a_step_took_it() {
    for taken in [false, true] {
        let (h, ticket_id, assignment, note, message) = resumed();
        h.engine.inputs_delivered(&ticket_id, &assignment, &[note]).unwrap();
        h.engine.delivery_failed(&ticket_id, &assignment, "Session busy").unwrap();
        h.tick(1);
        h.engine.turn_ended(&ticket_id, &assignment).unwrap();
        h.tick(1);
        h.engine.inputs_delivered(&ticket_id, &assignment, &[message]).unwrap();
        if taken {
            h.read(&ticket_id);
        }
        h.tick(1);
        h.report(&ticket_id, ReportState::Dropped, "Nothing to do");
        assert_eq!(pending(&h), if taken { ids(&[]) } else { ids(&["2"]) });
    }
}

#[test]
fn counts_a_message_a_step_took_before_a_restart_as_read_only_once_the_restarted_worker_reports() {
    for reported in [false, true] {
        let h = harness();
        let ticket_id = h.accepted();
        h.report(&ticket_id, ReportState::Progress, "working");
        h.tick(1);
        h.receive(trigger("2"));
        h.settle();
        h.read(&ticket_id);
        // The Assignment starts again with a recovery note, in the same Session, which holds the message.
        h.tick(1);
        h.engine.assignment_interrupted(&ticket_id, &running(&h, &ticket_id)).unwrap();
        h.settle();
        if reported {
            h.tick(1);
            h.report(&ticket_id, ReportState::Progress, "Recovered");
        }
        h.tick(1);
        h.engine.stop_ticket(&ticket_id, Some("not needed")).unwrap();
        assert_eq!(pending(&h), if reported { ids(&[]) } else { ids(&["2"]) });
    }
}

#[test]
fn gives_a_retrys_assignment_the_messages_the_failed_one_had_delivered_but_no_step_took() {
    let h = harness();
    let ticket_id = h.accepted();
    h.tick(1);
    h.receive(trigger("2"));
    h.settle();
    let input = input_of(&h, &ticket_id, "2");
    assert!(h.ticket(&ticket_id).undelivered.is_empty());
    h.tick(1);
    h.report(&ticket_id, ReportState::Failed, "The turn broke.");
    h.tick(1);
    h.engine.retry_ticket(&ticket_id).unwrap();
    assert_eq!(h.ticket(&ticket_id).undelivered, vec![input]);
}

#[test]
fn gives_a_retry_only_what_the_assignment_it_replaces_had_delivered_not_what_an_earlier_end_let_go_of() {
    let h = harness();
    let ticket_id = h.accepted();
    // A follow-up reaches the worker, and the ticket ends before any step took it, which sends it to Eval.
    h.tick(1);
    h.receive(trigger("2"));
    h.settle();
    h.tick(1);
    h.report(&ticket_id, ReportState::Dropped, "nothing to do");
    assert_eq!(pending(&h), ids(&["2"]));
    // A person's message resumes the ticket; its worker reports blocked before a step took it, and a person retries.
    h.tick(1);
    h.receive(trigger("3"));
    h.settle();
    h.tick(1);
    h.report(&ticket_id, ReportState::Blocked, "Which page?");
    h.tick(1);
    h.engine.retry_ticket(&ticket_id).unwrap();
    assert_eq!(h.ticket(&ticket_id).undelivered, vec![input_of(&h, &ticket_id, "3")]);
}

#[test]
fn gives_a_restarts_assignment_what_the_replaced_one_had_delivered_and_a_retry_of_it_gets_it_again() {
    let h = harness();
    let ticket_id = h.accepted();
    h.tick(1);
    h.receive(trigger("2"));
    h.settle();
    // The host restarts mid-work before a step took the message: the new Assignment gets it.
    h.tick(1);
    h.engine.assignment_interrupted(&ticket_id, &running(&h, &ticket_id)).unwrap();
    assert_eq!(h.ticket(&ticket_id).undelivered[0], input_of(&h, &ticket_id, "2"));
    h.settle();
    // That Assignment blocks before a step took it, and a person retries: the retry's Assignment gets it too.
    h.tick(1);
    h.report(&ticket_id, ReportState::Blocked, "Which page?");
    h.tick(1);
    h.engine.retry_ticket(&ticket_id).unwrap();
    assert_eq!(h.ticket(&ticket_id).undelivered, vec![input_of(&h, &ticket_id, "2")]);
}

#[test]
fn rolls_a_command_back_when_it_fails_part_way() {
    let h = harness();
    let ticket_id = h.accepted();
    h.receive(on(trigger("2"), "x"));
    let before = (h.ticket(&ticket_id), h.thread("chat:x"), h.disposition("2"));
    h.report(&ticket_id, ReportState::Ready, "done");
    h.set_version("revoked");
    // The attach is refused after reading state, and nothing it touched changed.
    assert_eq!(Harness::code(h.engine.attach(&ticket_id, "2", None)), "mandateRevoked");
    assert_eq!((h.thread("chat:x"), h.disposition("2")), (before.1, before.2));
    assert_eq!(h.ticket(&ticket_id).inputs, before.0.inputs);
}
