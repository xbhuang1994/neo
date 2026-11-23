//! Workers at work, over a scripted kernel: questions and answers, idle turns, model failures and retries, the worker
//! limit, background jobs, the Sidecar, stops, restarts mid-work, the pause and attachments.

mod common;

use common::*;
use neo_app::kernels::SessionRole;
use neo_app::sessions::ChatAttachment;
use neo_app::settings::Kernel;
use neo_core::model::{AssignmentState, ReportState, TicketEndBy, TicketOutcome};
use neo_core::stage::{ticket_stage, PersonAction, TicketStage};
use neo_kernel::types::JobKind;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const ACCEPT: &str = "I will do that.";

/// Accept a candidate as new work.
async fn accept(turn: &Turn, card: &Value) -> Result<Value, String> {
    turn.call("orchestrator_route", json!({"decisions": [{"kind": "accept", "trigger_id": card["trigger_id"], "title": "Paint the button", "worktree_name": "paint-button", "acknowledgement": ACCEPT}]})).await
}

/// The orchestrator every test here shares: accept the first request, attach later ones to the listed ticket, ask
/// people the questions workers raise, and deliver ready results.
async fn orchestrate(turn: &Turn) -> Said {
    for message in messages(&turn.text) {
        match message["kind"].as_str() {
            Some("candidate") => match message["related_tickets"].as_array().and_then(|tickets| tickets.first()) {
                Some(ticket) => {
                    turn.call("orchestrator_route", json!({"decisions": [{"kind": "attach", "trigger_id": message["trigger_id"], "ticket_id": ticket["ticket_id"], "acknowledgement": "Passing that on."}]})).await?;
                }
                None => {
                    accept(turn, &message).await?;
                }
            },
            Some("worker_attention") => {
                let question = message["ticket"]["attention"]["question"].clone();
                turn.call(
                    "orchestrator_reply",
                    json!({"ticket_id": message["ticket"]["ticket_id"], "purpose": "attention", "human_action": question, "text": question}),
                )
                .await?;
            }
            Some("worker_report") if message["state"] == "ready" => {
                turn.call("orchestrator_reply", json!({"ticket_id": message["ticket"]["ticket_id"], "purpose": "result", "text": "It is done."})).await?;
            }
            _ => {}
        }
    }
    Ok("Done.".into())
}

fn replies(f: &Fixture) -> Vec<String> {
    f.chat().into_iter().filter(|(source, _)| source == "chat-reply").map(|(_, text)| text).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn asks_a_person_the_workers_question_and_takes_the_answer_back_to_the_worker() {
    let f = started().await;
    f.script(model(|turn| {
        Box::pin(async move {
            if turn.role != SessionRole::Worker {
                return orchestrate(&turn).await;
            }
            if let Some(card) = turn.card("title") {
                // The assignment: a decision is needed before the work can go on.
                let asked = turn.call("orchestrator_report", json!({"state": "progress", "summary": "Need the color.", "human_action": "Which color?", "question_for_trigger_id": card["trigger"]["trigger_id"], "topic": "Painting the settings button"})).await?;
                assert_eq!((asked["notification"].as_str(), asked["attention"]["question"].as_str()), (Some("orchestrator"), Some("Which color?")));
                return Ok("Waiting for the answer.".into());
            }
            // The person's answer, attached to this ticket.
            let card = turn.card("trigger_id").expect("the answer arrives as a trigger Input");
            let done = turn.call("orchestrator_report", json!({"state": "ready", "summary": "Painted it blue.", "reply_to_trigger_id": card["trigger_id"], "direct_reply": "Done: the button is blue now."})).await?;
            assert_eq!(done["notification"], "direct_outbox");
            Ok("Finished.".into())
        })
    }));
    f.app.receive_web("Paint the settings button.", vec![], None).await.unwrap();
    f.until("the question reached the person", || replies(&f).len() == 2).await;
    f.settle().await;
    let ticket = f.ticket(0);
    assert_eq!(ticket_stage(&ticket), TicketStage::Person(PersonAction::Answer));
    assert_eq!(ticket.attention.as_ref().map(|attention| attention.question.as_str()), Some("Which color?"));
    assert_eq!(replies(&f), vec![ACCEPT, "Which color?"]);
    f.app.receive_web("Blue.", vec![], None).await.unwrap();
    f.until("the worker answered", || replies(&f).len() == 4).await;
    f.settle().await;
    assert_eq!(replies(&f), vec![ACCEPT, "Which color?", "Passing that on.", "Done: the button is blue now."]);
    let ticket = f.ticket(0);
    assert_eq!(ticket.ended.as_ref().map(|ended| (ended.by, ended.outcome)), Some((TicketEndBy::Executor, TicketOutcome::Completed)));
    assert!(ticket.attention.is_none());
    assert_eq!(f.tickets().len(), 1);
    // The answer went straight out: the orchestrator had no turn for it, only a notice.
    assert_eq!(f.ran(SessionRole::Orchestrator).len(), 3, "{:#?}", f.turns());
    assert_eq!(f.ran(SessionRole::Worker).len(), 2);
    // The worker's second message is the person's answer as an Input, by reference to its trigger.
    let input = messages(&f.ran(SessionRole::Worker)[1].text).into_iter().next().unwrap();
    assert_eq!((input["text"].as_str(), input["from"].as_str()), (Some("Blue."), Some("web:local")));
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_for_a_worker_that_ended_its_turn_without_one_and_asks_it_for_its_status() {
    let f = started().await;
    f.script(model(|turn| {
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker if turn.has("status-only request") => {
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "It was finished already."})).await?;
                    Ok("Reported.".into())
                }
                // It does the work but forgets to report.
                SessionRole::Worker => Ok("I changed the color.".into()),
                _ => {
                    for message in messages(&turn.text) {
                        if message["kind"] == "worker_report" && message["state"] == "waiting" {
                            assert!(
                                message["summary"].as_str().unwrap().contains("I changed the color.")
                                    && message["summary"].as_str().unwrap().contains("orchestrator_ticket_request_status")
                            );
                            let asked = turn.call("orchestrator_ticket_request_status", json!({"ticket_id": message["ticket"]["ticket_id"]})).await?;
                            assert_eq!(asked["reason"], "Asked the worker for a status report");
                        }
                    }
                    orchestrate(&turn).await
                }
            }
        })
    }));
    f.app.receive_web("Paint the settings button.", vec![], None).await.unwrap();
    f.until("the result is delivered", || replies(&f).len() == 2).await;
    f.settle().await;
    assert_eq!(replies(&f), vec![ACCEPT, "It is done."]);
    let ticket = f.ticket(0);
    let reports: Vec<ReportState> = ticket.assignments.iter().filter_map(|assignment| assignment.report.as_ref().map(|report| report.state)).collect();
    assert_eq!((ticket.assignments.len(), reports), (1, vec![ReportState::Ready]));
    assert_eq!(f.ran(SessionRole::Worker).len(), 2);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_failed_model_request_and_starts_over_when_a_person_retries() {
    let f = started().await;
    let attempts = Arc::new(AtomicUsize::new(0));
    let counted = attempts.clone();
    f.script(model(move |turn| {
        let attempts = counted.clone();
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                        return Err("401 unauthorized".into());
                    }
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "Painted."})).await?;
                    Ok("Finished.".into())
                }
                _ => {
                    for message in messages(&turn.text) {
                        if message["kind"] == "candidate" && message["text"] == "retry it" {
                            let ticket = message["related_tickets"][0]["ticket_id"].clone();
                            turn.call("orchestrator_ticket_retry", json!({"ticket_id": ticket})).await?;
                            turn.call(
                                "orchestrator_route",
                                json!({"decisions": [{"kind": "ignore", "trigger_id": message["trigger_id"], "reason": "A retry", "answer": "Retrying."}]}),
                            )
                            .await?;
                            return Ok("Done.".into());
                        }
                    }
                    orchestrate(&turn).await
                }
            }
        })
    }));
    f.app.receive_web("Paint the settings button.", vec![], None).await.unwrap();
    f.until("the failure is recorded", || f.tickets().first().is_some_and(|ticket| ticket_stage(ticket) == TicketStage::Person(PersonAction::Failed))).await;
    f.settle().await;
    let failed = f.ticket(0);
    assert_eq!(failed.latest_report().map(|report| (report.state, report.summary.as_str())), Some((ReportState::Failed, "401 unauthorized")));
    // The orchestrator was told, and nothing is retried by itself.
    assert!(f
        .ran(SessionRole::Orchestrator)
        .iter()
        .any(|ran| messages(&ran.text).iter().any(|message| message["kind"] == "worker_report" && message["state"] == "failed")));
    assert_eq!(f.ran(SessionRole::Worker).len(), 1);
    f.app.receive_web("retry it", vec![], None).await.unwrap();
    f.until("the retry finished", || replies(&f).contains(&"It is done.".to_string())).await;
    f.settle().await;
    let ticket = f.ticket(0);
    assert_eq!(
        ticket.assignments.iter().map(|assignment| (assignment.state, assignment.ended_reason.as_deref())).collect::<Vec<_>>(),
        vec![(AssignmentState::Ended, Some("retried")), (AssignmentState::Ended, None)]
    );
    assert_eq!(ticket.ended.as_ref().map(|ended| ended.outcome), Some(TicketOutcome::Completed));
    // The new Assignment starts in a fresh runtime process that resumes the worker's context, which holds the
    // assignment already: it is told only that a person retried.
    let second = f.ran(SessionRole::Worker)[1].clone();
    let card = messages(&second.text).into_iter().next().unwrap();
    assert!(card["note"].as_str().unwrap().starts_with("A person retried this ticket."));
    assert_eq!((card["assignment"].as_u64(), card.get("trigger")), (Some(2), None));
    assert_eq!(second.resumed.as_deref(), Some(format!("rt-worker-{}", ticket.id).as_str()));
    assert_eq!(
        f.kernels.closed.lock().unwrap().iter().filter(|id| id.starts_with("worker-")).count(),
        2,
        "the failed runtime was closed before the retry, and the finished one after"
    );
    assert_eq!(replies(&f), vec![ACCEPT, "Retrying.", "It is done."]);
    f.app.stop().await;
}

/// Three requests, each accepted as its own ticket while the first worker is still at work; returns the most workers
/// that worked at once.
async fn most_workers_at_once(limit: u32) -> usize {
    let f = started().await;
    let mut settings = (*f.app.settings()).clone();
    settings.executor.max_workers = limit;
    f.app.save_settings(settings, "app", "executor").unwrap();
    let (active, most) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let (counting, peak) = (active.clone(), most.clone());
    f.script(model(move |turn| {
        let (active, most) = (counting.clone(), peak.clone());
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    most.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "Painted."})).await?;
                    Ok("Finished.".into())
                }
                // Every request is new work here.
                _ => {
                    for message in messages(&turn.text) {
                        if message["kind"] == "candidate" {
                            accept(&turn, &message).await?;
                        }
                    }
                    Ok("Done.".into())
                }
            }
        })
    }));
    for n in 0..3 {
        // One at a time: messages that arrive while a candidate is being decided are routed together, as one request.
        f.app.receive_web(&format!("Job {n}"), vec![], None).await.unwrap();
        f.until("the request became a ticket", || f.tickets().len() == n + 1).await;
    }
    f.until("all three finished", || f.tickets().iter().all(|ticket| ticket.ended.is_some())).await;
    f.settle().await;
    assert_eq!(f.ran(SessionRole::Worker).len(), 3);
    f.app.stop().await;
    most.load(Ordering::SeqCst)
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_no_more_workers_at_once_than_the_settings_allow() {
    assert_eq!(most_workers_at_once(1).await, 1, "one worker at a time");
    assert_eq!(most_workers_at_once(2).await, 2, "two at a time, never three");
}

#[tokio::test(flavor = "multi_thread")]
async fn routes_messages_that_arrive_together_as_one_request() {
    let f = started().await;
    f.kernels.hold.store(true, Ordering::SeqCst);
    for n in 0..3 {
        f.app.receive_web(&format!("Part {n}"), vec![], None).await.unwrap();
    }
    f.kernels.hold.store(false, Ordering::SeqCst);
    f.kernels.release.notify_waiters();
    f.until("both requests are done", || f.tickets().len() == 2 && f.tickets().iter().all(|ticket| ticket.ended.is_some())).await;
    f.settle().await;
    // The first message was being decided when the other two came, so those two were decided together.
    let batches: Vec<usize> = f.tickets().iter().map(|ticket| ticket.origin.trigger_ids.len()).collect();
    assert_eq!(batches, vec![1, 2]);
    let second = message(&f.ran(SessionRole::Orchestrator).iter().find(|ran| ran.text.contains("Part 2")).unwrap().text, "candidate");
    assert_eq!((second["text"].as_str(), second["batch"][0]["preview"].as_str()), (Some("Part 2"), Some("Part 1")));
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn leaves_a_shell_job_running_for_a_person_and_stops_subagents_at_a_handoff() {
    let f = started().await;
    f.script(model(|turn| {
        Box::pin(async move {
            if turn.role != SessionRole::Worker {
                return orchestrate(&turn).await;
            }
            // A preview server for the person to try, a subagent still at work, and a question: a handoff.
            turn.jobs
                .lock()
                .unwrap()
                .extend([Fixture::job("bg_1", JobKind::Bash, "npm run preview"), Fixture::job("task_1", JobKind::Task, "Check the contrast")]);
            turn.call("orchestrator_report", json!({"state": "progress", "summary": "Preview is up.", "human_action": "Does the preview look right?"})).await?;
            Ok("Waiting for the answer.".into())
        })
    }));
    f.app.receive_web("Paint the settings button.", vec![], None).await.unwrap();
    f.until("the question reached the person", || replies(&f).len() == 2).await;
    f.settle().await;
    let ticket = f.ticket(0);
    let worker = f.app.session(&format!("worker-{}", ticket.id)).expect("the worker's Session stays open while its ticket is");
    // The subagent was cancelled, the server runs on, and it is not listed as work the worker still does.
    let jobs = worker.session.driver().jobs().await;
    assert_eq!(jobs.iter().map(|job| job.id.as_str()).collect::<Vec<_>>(), vec!["bg_1"]);
    assert!(f.app.running_jobs(&ticket.id).await.is_empty());
    // Its slot is free, and it is not reported as idle: it waits for the person.
    assert_eq!(f.app.active_workers(), 0);
    assert_eq!(ticket_stage(&ticket), TicketStage::Person(PersonAction::Answer));
    assert_eq!(ticket.latest_report().map(|report| report.state), Some(ReportState::Progress));
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_a_worker_with_a_running_job_busy_and_cancels_the_job_for_the_watchdog() {
    let f = started().await;
    f.script(model(|turn| {
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker if turn.has("[Watchdog]") => {
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "Recovered and finished."})).await?;
                    Ok("Finished.".into())
                }
                SessionRole::Worker => {
                    turn.jobs.lock().unwrap().push(Fixture::job("bg_1", JobKind::Bash, "make train\nsecond line"));
                    Ok("Training runs in the background.".into())
                }
                _ => orchestrate(&turn).await,
            }
        })
    }));
    f.app.receive_web("Train it.", vec![], None).await.unwrap();
    f.until("the job is running", || f.kernels.ran.lock().unwrap().iter().any(|ran| ran.role == SessionRole::Worker)).await;
    f.settle().await;
    let ticket = f.ticket(0);
    // The turn ended with a job running: the worker keeps its slot, and no idle report is made for it.
    assert_eq!(f.app.active_workers(), 1);
    assert!(ticket.latest_report().is_none());
    let jobs = f.app.running_jobs(&ticket.id).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!((jobs[0].id.as_str(), jobs[0].label.as_str(), jobs[0].command.as_deref()), ("bg_1", "make train", Some("make train\nsecond line")));
    assert_eq!(serde_json::to_value(&jobs[0]).unwrap()["type"], "bash");
    assert!(!f.app.cancel_job(&ticket.id, "no-such-job", "x").await.unwrap());
    assert!(f.app.cancel_job(&ticket.id, "bg_1", "No output for 20 minutes.").await.unwrap());
    f.until("the worker finished", || f.tickets()[0].ended.is_some()).await;
    f.settle().await;
    let woken = f.ran(SessionRole::Worker)[1].text.clone();
    assert!(woken.starts_with("[Watchdog] Stopped background job bg_1 (make train): No output for 20 minutes."), "{woken}");
    assert!(f.app.running_jobs(&ticket.id).await.is_empty());
    assert_eq!(replies(&f), vec![ACCEPT, "It is done."]);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_a_question_about_a_ticket_with_the_sidecar_without_waking_its_worker() {
    let f = started().await;
    let packet = Arc::new(Mutex::new(Value::Null));
    let seen = packet.clone();
    f.script(model(move |turn| {
        let seen = seen.clone();
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    std::fs::create_dir_all(turn.cwd.join("results")).unwrap();
                    std::fs::write(turn.cwd.join("results/metrics.csv"), "loss,0.12\n").unwrap();
                    std::fs::write(turn.cwd.join(".hidden"), "x").unwrap();
                    turn.jobs.lock().unwrap().push(Fixture::job("bg_1", JobKind::Bash, "make train"));
                    turn.call("orchestrator_report", json!({"state": "progress", "summary": "Epoch 3 of 10, loss 0.12.", "topic": "Training the model"})).await?;
                    Ok("Training runs in the background.".into())
                }
                SessionRole::Sidecar => {
                    assert_eq!(turn.tool_names(), vec!["sidecar_reply"]);
                    *seen.lock().unwrap() = serde_json::from_str(&turn.text).unwrap();
                    assert!(turn.call("sidecar_reply", json!({"text": "字".repeat(101)})).await.unwrap_err().contains("101 words"));
                    turn.call("sidecar_reply", json!({"text": "Epoch 3 of 10, loss 0.12."})).await?;
                    Ok("Done.".into())
                }
                _ => {
                    for message in messages(&turn.text) {
                        if message["kind"] == "candidate" && message["text"] == "How is it going?" {
                            let routed = turn.call("orchestrator_route", json!({"decisions": [{"kind": "sidecar", "trigger_id": message["trigger_id"], "ticket_id": message["related_tickets"][0]["ticket_id"], "note": "Asks for progress"}]})).await?;
                            assert_eq!(routed["results"][0]["reason"], "Dispatched to read-only sidecar for immediate reply");
                            return Ok("Done.".into());
                        }
                    }
                    orchestrate(&turn).await
                }
            }
        })
    }));
    f.app.receive_web("Train it.", vec![], None).await.unwrap();
    f.until("the worker reported progress", || f.tickets().first().is_some_and(|ticket| ticket.latest_report().is_some())).await;
    f.settle().await;
    f.app.receive_web("How is it going?", vec![], None).await.unwrap();
    f.until("the sidecar answered", || replies(&f).len() == 2).await;
    f.settle().await;
    assert_eq!(replies(&f), vec![ACCEPT, "Epoch 3 of 10, loss 0.12."]);
    assert_eq!(f.ran(SessionRole::Worker).len(), 1, "the worker was not woken");
    let packet = packet.lock().unwrap().clone();
    assert_eq!(packet["questions"][0]["text"], "How is it going?");
    assert_eq!(packet["routing_note"], "Asks for progress");
    assert_eq!((packet["latest_report"]["state"].as_str(), packet["latest_report"]["summary"].as_str()), (Some("progress"), Some("Epoch 3 of 10, loss 0.12.")));
    assert_eq!(packet["running_jobs"][0]["id"], "bg_1");
    assert_eq!(packet["workspace_files"], json!(["results/", "results/metrics.csv"]));
    assert_eq!(packet["ticket"]["digest"], "Training the model");
    // The ticket and its worker are as they were.
    assert!(f.ticket(0).ended.is_none() && f.ticket(0).inputs.is_empty());
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_a_ticket_on_a_persons_word_and_blocks_its_worker_from_then_on() {
    let f = started().await;
    let worker_turn: Arc<Mutex<Option<Turn>>> = Arc::new(Mutex::new(None));
    let kept = worker_turn.clone();
    f.script(model(move |turn| {
        let kept = kept.clone();
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    turn.call("orchestrator_report", json!({"state": "progress", "summary": "Started."})).await?;
                    turn.jobs.lock().unwrap().push(Fixture::job("bg_1", JobKind::Bash, "make train"));
                    *kept.lock().unwrap() = Some(turn);
                    Ok("Working in the background.".into())
                }
                _ => {
                    for message in messages(&turn.text) {
                        if message["kind"] == "candidate" && message["text"] == "stop that" {
                            let stopped = turn.call("orchestrator_route", json!({"decisions": [{"kind": "stop", "trigger_id": message["trigger_id"], "ticket_id": message["related_tickets"][0]["ticket_id"], "reason": "The person asked to stop"}]})).await?;
                            assert_eq!(stopped["results"][0]["decision"], "stop");
                            return Ok("Done.".into());
                        }
                    }
                    orchestrate(&turn).await
                }
            }
        })
    }));
    f.app.receive_web("Train it.", vec![], None).await.unwrap();
    f.until("the worker is at work", || worker_turn.lock().unwrap().is_some()).await;
    f.settle().await;
    f.app.receive_web("stop that", vec![], None).await.unwrap();
    f.until("the ticket ended", || f.tickets()[0].ended.is_some()).await;
    f.settle().await;
    let ticket = f.ticket(0);
    let ended = ticket.ended.clone().unwrap();
    assert_eq!((ended.by, ended.outcome, ended.reason.as_deref()), (TicketEndBy::Human, TicketOutcome::Stopped, Some("The person asked to stop")));
    // Its Session is closed, its slot is free, and whatever its model still tries is refused.
    f.until("the worker's Session closed", || f.app.session(&format!("worker-{}", ticket.id)).is_none()).await;
    assert!(f.kernels.closed.lock().unwrap().contains(&format!("worker-{}", ticket.id)));
    assert_eq!(f.app.active_workers(), 0);
    let late = worker_turn.lock().unwrap().take().unwrap();
    assert_eq!(late.call("bash", json!({"command": "rm -rf build"})).await.unwrap_err(), "Ticket ended; new work needs a new authorized ticket");
    assert!(late.call("orchestrator_report", json!({"state": "ready", "summary": "late"})).await.is_err());
    assert_eq!(replies(&f), vec![ACCEPT]);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn starts_a_worker_that_a_restart_interrupted_again_with_a_recovery_note() {
    let f = started().await;
    let attempts = Arc::new(AtomicUsize::new(0));
    let counted = attempts.clone();
    f.script(model(move |turn| {
        let attempts = counted.clone();
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                        // Mid-work when the host goes down.
                        tokio::time::sleep(Duration::from_secs(600)).await;
                    }
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "Finished after the restart."})).await?;
                    Ok("Finished.".into())
                }
                _ => orchestrate(&turn).await,
            }
        })
    }));
    f.app.receive_web("Paint the settings button.", vec![], None).await.unwrap();
    f.until("the worker is mid-work", || attempts.load(Ordering::SeqCst) == 1).await;
    let before = f.ticket(0);
    assert_eq!(before.assignments.iter().map(|assignment| assignment.state).collect::<Vec<_>>(), vec![AssignmentState::Running]);
    let f = f.restart().await;
    f.until("the work finished", || replies(&f).contains(&"It is done.".to_string())).await;
    f.settle().await;
    let ticket = f.ticket(0);
    assert_eq!(ticket.id, before.id);
    assert_eq!(
        ticket.assignments.iter().map(|assignment| (assignment.state, assignment.ended_reason.as_deref())).collect::<Vec<_>>(),
        vec![(AssignmentState::Ended, Some("hostRestarted")), (AssignmentState::Ended, None)]
    );
    let resumed = f.ran(SessionRole::Worker).pop().unwrap();
    assert!(resumed.text.contains("The host restarted during this ticket."), "{}", resumed.text);
    // The transcript holds the assignment and the runtime has that context, so the card is short this time.
    let card = messages(&resumed.text).into_iter().next().unwrap();
    assert_eq!((card["assignment"].as_u64(), card.get("trigger")), (Some(2), None));
    assert_eq!(resumed.resumed.as_deref(), Some(format!("rt-worker-{}", ticket.id).as_str()));
    assert_eq!(replies(&f), vec![ACCEPT, "It is done."]);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn holds_everything_while_paused_and_goes_on_once_the_pause_lifts() {
    let f = started().await;
    let mut settings = (*f.app.settings()).clone();
    settings.paused = true;
    f.app.save_settings(settings.clone(), "app", "pause").unwrap();
    let receipt = f.app.receive_web("Please fix the typo in the fixture.", vec![], None).await.unwrap();
    assert_eq!(receipt.result, neo_core::ReceiveResult::Stored);
    f.settle().await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The message is shown and stored, and nothing else happened.
    assert_eq!(f.chat().len(), 1);
    assert!(f.kernels.ran.lock().unwrap().is_empty() && f.tickets().is_empty());
    settings.paused = false;
    f.app.save_settings(settings, "app", "pause").unwrap();
    f.until("the result is in the transcript", || f.chat().len() >= 3).await;
    f.settle().await;
    assert_eq!(f.tickets().len(), 1);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn shows_images_to_the_model_inlines_text_files_and_saves_the_rest() {
    let f = started().await;
    let attachments = vec![
        ChatAttachment { name: "shot.png".into(), media_type: "image/png".into(), data: vec![0x89, b'P', b'N', b'G'] },
        ChatAttachment { name: "notes.md".into(), media_type: String::new(), data: "# Notes\nUse <b> & \"quotes\".".as_bytes().to_vec() },
        ChatAttachment { name: "data.bin".into(), media_type: "application/octet-stream".into(), data: vec![0, 1, 2, 3] },
    ];
    f.app.receive_web("See these.", attachments, Some("web:files".into())).await.unwrap();
    f.until("the work is done", || f.chat().len() >= 3).await;
    f.settle().await;
    let state = f.dir.join("state");
    let saved = |name: &str| state.join("attachments/chat-web-files").join(name);
    assert_eq!(std::fs::read(saved("1-shot.png")).unwrap(), vec![0x89, b'P', b'N', b'G']);
    assert_eq!(std::fs::read(saved("3-data.bin")).unwrap(), vec![0, 1, 2, 3]);
    assert!(!saved("2-notes.md").exists(), "a text file is inlined, not saved");
    // What the person sees: their text with the files, and which files they attached.
    let shown = f.chat()[0].1.clone();
    assert!(shown.starts_with("See these.\n\n<attachment name=\"shot.png\" mediaType=\"image/png\" path=\""), "{shown}");
    assert!(shown.contains("<attachment name=\"notes.md\">\n# Notes\nUse <b> & \"quotes\".\n</attachment>"));
    assert!(shown.contains("<attachment name=\"data.bin\" mediaType=\"application/octet-stream\" path=\""));
    let entry = serde_json::to_value(&f.app.chat_transcript()[0]).unwrap();
    assert_eq!(
        entry["details"]["attachments"],
        json!([{"name": "shot.png", "mediaType": "image/png"}, {"name": "notes.md", "mediaType": "text/plain"}, {"name": "data.bin", "mediaType": "application/octet-stream"}])
    );
    assert_eq!(entry["content"][1], json!({"type": "image", "mimeType": "image/png", "data": "iVBORw=="}));
    // The model is told of the image with the candidate that carries the message's text.
    let first = f.ran(SessionRole::Orchestrator)[0].text.clone();
    assert!(first.starts_with("Images attached to chat message chat:web:files:"), "{first}");
    assert_eq!(message(&first, "candidate")["chars"].as_u64().is_some(), shown.chars().count() > 600);
    // A message with only files still says something.
    f.app.receive_web("", vec![ChatAttachment { name: "b.bin".into(), media_type: "application/zip".into(), data: vec![0] }], None).await.unwrap();
    f.until("it is shown", || f.chat().iter().filter(|(source, _)| source == "web-panel").count() == 2).await;
    assert!(f.chat().iter().any(|(_, text)| text.starts_with("<attachment name=\"b.bin\"")));
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn says_why_nothing_runs_when_the_kernel_is_missing_and_still_keeps_messages() {
    let f = fixture().await;
    *f.kernels.unavailable.lock().unwrap() = Some("Antigravity CLI (agy) is not installed.".into());
    f.app.start().await.unwrap();
    let health = f.app.board.get("kernel").unwrap();
    assert_eq!((health.state, health.detail.as_str()), ("error", "Antigravity CLI (agy) is not installed."));
    assert!(f.app.receive_web("hello", vec![], None).await.unwrap_err().contains("agy"));
    assert!(f.kernels.opened.lock().unwrap().is_empty());
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_a_result_once_when_the_worker_replied_directly_and_the_orchestrator_tries_again() {
    let f = started().await;
    let refused = Arc::new(Mutex::new(Vec::new()));
    let seen = refused.clone();
    f.script(model(move |turn| {
        let seen = seen.clone();
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    let done = turn
                        .call(
                            "orchestrator_report",
                            json!({"state": "ready", "summary": "Wrote the ring buffer.", "direct_reply": "Done: the ring buffer is in src/lib.rs."}),
                        )
                        .await?;
                    assert_eq!(done["notification"], "direct_outbox");
                    Ok("Finished.".into())
                }
                _ => {
                    for message in messages(&turn.text) {
                        // Told of the worker's own reply, the orchestrator still tries to send the result in its words.
                        if let Some(ticket) = message["worker_direct_reply"]["ticket_id"].as_str() {
                            assert_eq!(message["worker_direct_reply"]["note"], "The person already has this reply; send nothing more for it.");
                            let again = turn
                                .call(
                                    "orchestrator_reply",
                                    json!({"ticket_id": ticket, "purpose": "result", "text": "The ring buffer is written; the code is in src/lib.rs."}),
                                )
                                .await;
                            seen.lock().unwrap().push(again.unwrap_err());
                        }
                    }
                    orchestrate(&turn).await
                }
            }
        })
    }));
    f.app.receive_web("Write a ringbuffer in Rust", vec![], None).await.unwrap();
    f.until("the ticket completed", || f.tickets().first().is_some_and(|ticket| ticket.ended.is_some())).await;
    f.settle().await;
    // A later message starts the turn in which the orchestrator reads the notice of the worker's reply.
    f.app.receive_web("Thanks", vec![], None).await.unwrap();
    f.until("the paraphrase was tried", || !refused.lock().unwrap().is_empty()).await;
    f.settle().await;
    assert!(refused.lock().unwrap()[0].starts_with("This ticket's result already went to the person"), "{:?}", refused.lock().unwrap());
    let said = replies(&f);
    assert_eq!(said.iter().filter(|text| text.contains("ring buffer")).count(), 1, "{said:#?}");
    assert_eq!(said[1], "Done: the ring buffer is in src/lib.rs.");
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_workers_with_their_own_model_on_antigravity() {
    let f = started().await;
    f.app.update_models(json!({"eval": null, "executor": {"provider": "antigravity", "model": "gemini-3.8-pro-high"}})).await.unwrap();
    assert_eq!(f.app.board.get("kernel").map(|health| health.detail), Some("Running on antigravity".to_string()));
    f.script(model(|turn| {
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "Painted."})).await?;
                    Ok("Reported.".into())
                }
                _ => orchestrate(&turn).await,
            }
        })
    }));
    f.app.receive_web("Paint the settings button.", vec![], None).await.unwrap();
    f.until("the result is delivered", || replies(&f).len() == 2).await;
    f.settle().await;
    let opened = f.kernels.opened_on.lock().unwrap().clone();
    assert!(opened.contains(&(SessionRole::Orchestrator, Kernel::Antigravity)), "{opened:?}");
    assert!(opened.contains(&(SessionRole::Worker, Kernel::Antigravity)), "{opened:?}");
    let worker = f.kernels.opened.lock().unwrap().iter().find(|spec| spec.role == SessionRole::Worker).cloned().unwrap();
    assert_eq!(worker.model.map(|model| model.model), Some("gemini-3.8-pro-high".into()));
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn relays_sidecar_failure_to_orchestrator_after_bounded_retries() {
    let f = started().await;
    let failed_cards: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = failed_cards.clone();
    f.script(model(move |turn| {
        let seen = seen.clone();
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    turn.call("orchestrator_report", json!({"state": "progress", "summary": "Running epoch 1.", "topic": "Training"})).await?;
                    Ok("Running.".into())
                }
                SessionRole::Sidecar => Err("sidecar runtime error".into()),
                _ => {
                    for message in messages(&turn.text) {
                        if message["kind"] == "candidate" && message["text"] == "How is it going?" {
                            turn.call(
                                "orchestrator_route",
                                json!({"decisions": [{"kind": "sidecar", "trigger_id": message["trigger_id"], "ticket_id": message["related_tickets"][0]["ticket_id"]}]}),
                            )
                            .await?;
                            return Ok("Done.".into());
                        }
                        if message["kind"] == "sidecar_failed" {
                            seen.lock().unwrap().push(message.clone());
                            turn.call(
                                "orchestrator_reply",
                                json!({"purpose": "answer", "trigger_id": message["trigger_id"], "text": "Fallback answer."}),
                            )
                            .await?;
                            return Ok("Done.".into());
                        }
                    }
                    orchestrate(&turn).await
                }
            }
        })
    }));
    f.app.receive_web("Train it.", vec![], None).await.unwrap();
    f.until("the worker reported progress", || f.tickets().first().is_some_and(|ticket| ticket.latest_report().is_some())).await;
    f.settle().await;
    f.app.receive_web("How is it going?", vec![], None).await.unwrap();
    // Bounded retries with exponential backoff (2s + 4s) plus orchestrator fallback.
    for _ in 0..1500 {
        if replies(&f).len() == 2 && !f.app.effects.pending(neo_app::effects::SIDECAR, None) {
            break;
        }
        f.app.passes.pump();
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    f.settle().await;
    assert_eq!(f.ran(SessionRole::Sidecar).len(), 3);
    assert!(!f.app.effects.pending(neo_app::effects::SIDECAR, None));
    {
        let cards = failed_cards.lock().unwrap();
        assert_eq!(cards.len(), 1, "{cards:#?}");
        assert!(cards[0]["error"].as_str().is_some_and(|err| err.contains("sidecar runtime error")));
    }
    assert_eq!(replies(&f), vec![ACCEPT.to_string(), "Fallback answer.".to_string()]);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_open_and_failed_workers_via_stop_worker_ticket_and_refuses_completed_or_stopped() {
    let f = started().await;
    let worker_turn: Arc<Mutex<Option<Turn>>> = Arc::new(Mutex::new(None));
    let kept = worker_turn.clone();
    let mode = Arc::new(Mutex::new("background"));
    let script_mode = mode.clone();
    f.script(model(move |turn| {
        let kept = kept.clone();
        let mode = script_mode.clone();
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    let current_mode = *mode.lock().unwrap();
                    match current_mode {
                        "background" => {
                            turn.call("orchestrator_report", json!({"state": "progress", "summary": "Running subagent and shell."})).await?;
                            turn.jobs.lock().unwrap().push(Fixture::job("task_1", JobKind::Task, "subagent slice"));
                            turn.jobs.lock().unwrap().push(Fixture::job("bg_1", JobKind::Bash, "make train"));
                            *kept.lock().unwrap() = Some(turn);
                            Ok("Running in background.".into())
                        }
                        "fail" => Err("model error".into()),
                        _ => {
                            turn.call("orchestrator_report", json!({"state": "ready", "summary": "All done."})).await?;
                            Ok("Finished.".into())
                        }
                    }
                }
                _ => {
                    for message in messages(&turn.text) {
                        match message["kind"].as_str() {
                            Some("candidate") => {
                                accept(&turn, &message).await?;
                            }
                            Some("worker_report") if message["state"] == "ready" => {
                                turn.call(
                                    "orchestrator_reply",
                                    json!({"ticket_id": message["ticket"]["ticket_id"], "purpose": "result", "text": "It is done."}),
                                )
                                .await?;
                            }
                            _ => {}
                        }
                    }
                    Ok("Done.".into())
                }
            }
        })
    }));

    // 1. Active working ticket with both subagent and background shell job.
    f.app.receive_web("Run subagent and job.", vec![], None).await.unwrap();
    f.until("worker turn stored", || worker_turn.lock().unwrap().is_some()).await;
    f.settle().await;
    let working_id = f.ticket(0).id;
    let detail_before = f.app.worker_detail(&working_id).await.unwrap();
    assert_eq!(detail_before["background"].as_array().map(Vec::len), Some(2));
    assert_eq!(f.app.active_workers(), 1);

    let stopped = f.app.stop_worker_ticket(&working_id).await.unwrap();
    assert_eq!(stopped["stage"], json!({"stage": "ended"}));
    assert_eq!(stopped["outcome"], "stopped");
    assert_eq!(stopped["session"], json!({"loaded": false, "streaming": false}));
    assert_eq!(stopped["background"], json!([]));
    assert!(f.kernels.closed.lock().unwrap().contains(&format!("worker-{working_id}")));
    assert_eq!(f.app.active_workers(), 0);
    assert_eq!(f.app.stop_worker_ticket(&working_id).await, Err(neo_app::executor::StopWorkerError::AlreadyEnded));

    // 2. Failed ticket (`person/failed`) can also be stopped and then refuses a second stop.
    *mode.lock().unwrap() = "fail";
    f.app.receive_web("Fail this one.", vec![], None).await.unwrap();
    f.until("failed ticket recorded", || {
        f.tickets().iter().any(|ticket| ticket.id != working_id && ticket_stage(ticket) == TicketStage::Person(PersonAction::Failed))
    })
    .await;
    f.settle().await;
    let failed_id = f.tickets().into_iter().find(|ticket| ticket.id != working_id).unwrap().id;
    let stopped_failed = f.app.stop_worker_ticket(&failed_id).await.unwrap();
    assert_eq!(stopped_failed["stage"], json!({"stage": "ended"}));
    assert_eq!(stopped_failed["outcome"], "stopped");
    assert_eq!(f.app.stop_worker_ticket(&failed_id).await, Err(neo_app::executor::StopWorkerError::AlreadyEnded));

    // 3. Completed ticket refuses stop and unknown ticket returns NotFound.
    *mode.lock().unwrap() = "complete";
    f.app.receive_web("Complete this one.", vec![], None).await.unwrap();
    f.until("completed ticket recorded", || f.tickets().iter().any(|ticket| ticket.id != working_id && ticket.id != failed_id && ticket.ended.is_some())).await;
    f.settle().await;
    let completed_id = f.tickets().into_iter().find(|ticket| ticket.id != working_id && ticket.id != failed_id).unwrap().id;
    assert_eq!(f.app.stop_worker_ticket(&completed_id).await, Err(neo_app::executor::StopWorkerError::AlreadyEnded));
    assert_eq!(f.tickets().into_iter().find(|ticket| ticket.id == completed_id).unwrap().ended.unwrap().outcome, TicketOutcome::Completed);
    assert_eq!(f.app.stop_worker_ticket("missing").await, Err(neo_app::executor::StopWorkerError::NotFound));
    f.app.stop().await;
}
