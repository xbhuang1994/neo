//! The Watchdog over a scripted kernel: it stays silent while all is well, puts back what the queues lost, reminds the
//! main Session of a missing reply, and asks its own one-off Session about stalled, stranded and failed tickets.

mod common;

use common::*;
use neo_app::effects;
use neo_app::health::Health;
use neo_app::kernels::SessionRole;
use neo_core::model::{AssignmentState, ReportState, TicketOutcome};
use neo_kernel::types::JobKind;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Accept every candidate as new work and send every ready result.
async fn orchestrate(turn: &Turn) -> Said {
    for message in messages(&turn.text) {
        match message["kind"].as_str() {
            Some("candidate") => {
                turn.call("orchestrator_route", json!({"decisions": [{"kind": "accept", "trigger_id": message["trigger_id"], "title": "Train the model", "worktree_name": "train-model", "acknowledgement": "On it."}]})).await?;
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

/// The patrols the Watchdog Session was given.
fn patrols(f: &Fixture) -> Vec<Value> {
    f.ran(SessionRole::Watchdog).iter().map(|ran| message(&ran.text, "watchdog_patrol")).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn asks_no_model_while_all_is_well_and_reports_a_failing_component_once() {
    let f = started().await;
    assert_eq!(f.app.board.get("watchdog").map(|health| health.detail), Some("Watchdog control loop is ready".to_string()));
    f.app.receive_web("Please fix the typo in the fixture.", vec![], None).await.unwrap();
    f.until("the result is in the transcript", || f.chat().len() >= 3).await;
    f.settle().await;
    f.app.watchdog_tick().await;
    f.settle().await;
    assert!(patrols(&f).is_empty());
    assert_eq!(
        f.app.board.get("watchdog").map(|health| (health.state, health.detail)),
        Some(("ready", "All active tickets and queues are healthy".to_string()))
    );
    assert_eq!(f.ran(SessionRole::Orchestrator).len(), 2, "no reminder went to the main Session");
    // A component that fails is shown to the Watchdog Session once, with its own prompt and tools.
    f.app.board.set("wechat", Health::error("Polling failed: timeout"));
    f.app.watchdog_tick().await;
    f.app.watchdog_tick().await;
    let seen = patrols(&f);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["suspects"], json!([]));
    assert_eq!(
        (seen[0]["health_errors"][0]["component"].as_str(), seen[0]["health_errors"][0]["detail"].as_str()),
        (Some("wechat"), Some("Polling failed: timeout"))
    );
    let spec = f.kernels.opened.lock().unwrap().iter().find(|spec| spec.role == SessionRole::Watchdog).cloned().unwrap();
    assert!(spec.system_prompt.starts_with("You are the Watchdog of neo-agent") && spec.system_prompt.contains("NEO_AGENT_BLOCKED_COMMANDS"));
    assert_eq!(f.app.board.get("watchdog").map(|health| health.detail), Some("All active tickets and queues are healthy".to_string()));
    // Nothing runs while paused.
    f.app.board.set("wechat", Health::error("Polling failed again"));
    let mut settings = (*f.app.settings()).clone();
    settings.paused = true;
    f.app.save_settings(settings, "app", "pause").unwrap();
    f.app.watchdog_tick().await;
    assert_eq!(patrols(&f).len(), 1);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn wakes_a_worker_that_sits_idle_with_its_work_finished() {
    let f = started().await;
    let tools = Arc::new(Mutex::new(Vec::new()));
    let inspected = Arc::new(Mutex::new(Value::Null));
    let (seen_tools, seen_inspection) = (tools.clone(), inspected.clone());
    f.script(model(move |turn| {
        let (tools, inspected) = (seen_tools.clone(), seen_inspection.clone());
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker if turn.has("[Watchdog]") => {
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "Training finished; results are in results.log."})).await?;
                    Ok("Reported.".into())
                }
                SessionRole::Worker => {
                    std::fs::write(turn.cwd.join("results.log"), "epoch 1\nepoch 2\nEXIT 0\n").map_err(|error| error.to_string())?;
                    Ok("I started the training detached; it writes results.log.".into())
                }
                SessionRole::Watchdog => {
                    *tools.lock().unwrap() = turn.tool_names();
                    let patrol = turn.card("kind").expect("the patrol");
                    let ticket_id = patrol["suspects"][0]["ticket_id"].clone();
                    *inspected.lock().unwrap() = turn.call("watchdog_inspect", json!({"ticket_id": ticket_id})).await?;
                    let woken = turn
                        .call(
                            "watchdog_intervene",
                            json!({"action": "wake_worker", "ticket_id": ticket_id, "message": "results.log ends with EXIT 0: verify and report."}),
                        )
                        .await?;
                    assert_eq!(woken["woken"], true);
                    Ok("Woke the worker: the detached run finished.".into())
                }
                _ => orchestrate(&turn).await,
            }
        })
    }));
    f.app.receive_web("Train it.", vec![], None).await.unwrap();
    f.until("the worker went idle", || f.tickets().first().and_then(|ticket| ticket.latest_report().map(|report| report.state)) == Some(ReportState::Waiting))
        .await;
    f.settle().await;
    f.app.watchdog_tick().await;
    f.until("the worker reported", || f.tickets()[0].ended.is_some()).await;
    f.settle().await;
    let ticket = f.ticket(0);
    let seen = patrols(&f);
    assert_eq!(seen.len(), 1);
    let suspect = &seen[0]["suspects"][0];
    assert_eq!(
        (suspect["kind"].as_str(), suspect["ticket_id"].as_str(), suspect["title"].as_str(), suspect["state"].as_str()),
        (Some("idle_without_followup"), Some(ticket.id.as_str()), Some("Train the model"), Some("idle"))
    );
    assert_eq!(suspect["directory"], ticket.execution.as_ref().unwrap().directory.as_str());
    assert_eq!(suspect["running_jobs"], json!([]));
    assert_eq!(suspect["activity_delta"]["output_changed"], false);
    assert_eq!(suspect["recent_files"][0]["path"], "results.log");
    assert_eq!(suspect["latest_log_tail"], json!({"file": "results.log", "tail": "epoch 1\nepoch 2\nEXIT 0"}));
    assert_eq!(suspect["latest_report"]["state"], "waiting");
    assert!(
        suspect["recent_transcript"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line["role"] == "assistant" && line["text"] == "I started the training detached; it writes results.log."),
        "{suspect:#}"
    );
    assert!(suspect["elapsed_seconds"].is_number() && suspect.get("previous_patrol_note").is_none());
    assert_eq!(*tools.lock().unwrap(), vec!["watchdog_inspect", "watchdog_intervene"]);
    let inspection = inspected.lock().unwrap().clone();
    assert_eq!((inspection["ticket"]["ticket_id"].as_str(), inspection["session"]["loaded"].as_bool()), (Some(ticket.id.as_str()), Some(true)));
    assert_eq!(inspection["assignments"].as_array().map(Vec::len), Some(1));
    assert!(inspection["inputs"].is_array() && !inspection["recent_transcript"].as_array().unwrap().is_empty());
    // The worker was told what the Watchdog found, and the result went out.
    assert!(f.ran(SessionRole::Worker)[1].text.contains("[Watchdog] results.log ends with EXIT 0: verify and report."));
    assert_eq!(ticket.ended.as_ref().map(|ended| ended.outcome), Some(TicketOutcome::Completed));
    assert_eq!(replies(&f), vec!["On it.", "It is done."]);
    assert_eq!(f.app.board.get("watchdog").map(|health| health.detail), Some("Inspected 1 suspect ticket(s)".to_string()));
    // Refusals, in words.
    let refuse = |arguments: Value| {
        let app = f.app.clone();
        async move { app.watchdog_intervene(arguments).await.unwrap_err() }
    };
    assert_eq!(refuse(json!({"action": "wake_worker", "ticket_id": "missing", "message": "x"})).await, "Unknown ticket: missing");
    assert_eq!(refuse(json!({"action": "cancel_job", "ticket_id": ticket.id, "message": "x"})).await, "cancel_job requires job_id");
    assert_eq!(
        refuse(json!({"action": "restart", "ticket_id": ticket.id, "message": "x"})).await,
        "action is wake_worker, cancel_job, interrupt_worker, retry_ticket or relay_report"
    );
    assert!(refuse(json!({"action": "wake_worker", "ticket_id": ticket.id, "message": "x", "force": true})).await.starts_with("Unknown argument force"));
    assert_eq!(refuse(json!({"action": "wake_worker", "ticket_id": ticket.id})).await, "message is required");
    assert_eq!(
        f.app.watchdog_intervene(json!({"action": "wake_worker", "ticket_id": ticket.id, "message": "x"})).await.unwrap()["woken"],
        false,
        "an ended ticket has no worker to wake"
    );
    assert_eq!(
        f.app.watchdog_intervene(json!({"action": "retry_ticket", "ticket_id": ticket.id, "message": "x"})).await.unwrap()["reason"],
        "Ticket is not retryable"
    );
    assert_eq!(f.app.watchdog_inspect("missing").await.unwrap_err(), "Unknown ticket: missing");
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cancels_a_background_job_that_stalled_and_tells_its_worker() {
    let f = started().await;
    f.script(model(|turn| {
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker if turn.has("[Watchdog]") => {
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "Reran it in the foreground."})).await?;
                    Ok("Finished.".into())
                }
                SessionRole::Worker => {
                    let mut job = Fixture::job("bg_7", JobKind::Bash, "python train.py");
                    job.progress = Some("epoch 3/10".into());
                    turn.jobs.lock().unwrap().push(job);
                    Ok("Training runs in the background.".into())
                }
                SessionRole::Watchdog => {
                    let patrol = turn.card("kind").expect("the patrol");
                    let suspect = &patrol["suspects"][0];
                    let cancelled = turn.call("watchdog_intervene", json!({"action": "cancel_job", "ticket_id": suspect["ticket_id"], "job_id": suspect["running_jobs"][0]["id"], "message": "No output and no CPU time for 20 minutes."})).await?;
                    assert_eq!(cancelled["cancelled"], true);
                    Ok("Cancelled the hung job.".into())
                }
                _ => orchestrate(&turn).await,
            }
        })
    }));
    f.app.receive_web("Train it.", vec![], None).await.unwrap();
    f.until("the job is running", || !f.ran(SessionRole::Worker).is_empty()).await;
    f.settle().await;
    assert_eq!(f.app.active_workers(), 1);
    f.app.watchdog_tick().await;
    f.until("the worker finished", || f.tickets()[0].ended.is_some()).await;
    f.settle().await;
    let seen = patrols(&f);
    assert_eq!(seen.len(), 1);
    let suspect = &seen[0]["suspects"][0];
    assert_eq!((suspect["kind"].as_str(), suspect["state"].as_str()), (Some("long_running_worker"), Some("working")));
    assert_eq!(
        (suspect["running_jobs"][0]["id"].as_str(), suspect["running_jobs"][0]["command"].as_str(), suspect["running_jobs"][0]["progress"].as_str()),
        (Some("bg_7"), Some("python train.py"), Some("epoch 3/10"))
    );
    assert_eq!((suspect["activity_delta"]["output_changed"].as_bool(), suspect["activity_delta"]["cpu_ticks_delta"].as_u64()), (Some(false), Some(0)));
    assert!(f.ran(SessionRole::Worker)[1]
        .text
        .starts_with("[Watchdog] Stopped background job bg_7 (python train.py): No output and no CPU time for 20 minutes."));
    assert_eq!(replies(&f), vec!["On it.", "It is done."]);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn retries_a_ticket_that_failed_in_passing_twice_at_most() {
    let f = started().await;
    let attempts = Arc::new(AtomicUsize::new(0));
    let counted = attempts.clone();
    f.script(model(move |turn| {
        let attempts = counted.clone();
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => Err(format!("529 overloaded (attempt {})", attempts.fetch_add(1, Ordering::SeqCst) + 1)),
                SessionRole::Watchdog => {
                    let patrol = turn.card("kind").expect("the patrol");
                    let suspect = &patrol["suspects"][0];
                    assert_eq!(suspect["kind"], "delivery_or_transient_failure");
                    let retried = turn
                        .call(
                            "watchdog_intervene",
                            json!({"action": "retry_ticket", "ticket_id": suspect["ticket_id"], "message": "The model was overloaded; try again."}),
                        )
                        .await?;
                    Ok(format!("Retried: {}", retried["retried"]))
                }
                _ => orchestrate(&turn).await,
            }
        })
    }));
    let failed = |f: &Fixture, attempt: usize| {
        f.tickets().first().and_then(|ticket| ticket.latest_report().map(|report| report.summary.clone()))
            == Some(format!("529 overloaded (attempt {attempt})"))
    };
    f.app.receive_web("Train it.", vec![], None).await.unwrap();
    for attempt in 1..=3 {
        f.until("the failure is recorded", || failed(&f, attempt)).await;
        f.settle().await;
        f.app.watchdog_tick().await;
        f.settle().await;
    }
    f.app.watchdog_tick().await;
    f.settle().await;
    // Two retries, then the failure stays for a person: the third failure is not even inspected.
    let ticket = f.ticket(0);
    assert_eq!(f.ran(SessionRole::Worker).len(), 3);
    assert_eq!(patrols(&f).len(), 2);
    assert_eq!(patrols(&f)[0]["suspects"][0]["latest_report"]["preview"], "529 overloaded (attempt 1)");
    assert_eq!(
        ticket.assignments.iter().map(|assignment| assignment.state).collect::<Vec<_>>(),
        vec![AssignmentState::Ended, AssignmentState::Ended, AssignmentState::Running]
    );
    assert_eq!(
        f.app.watchdog_intervene(json!({"action": "retry_ticket", "ticket_id": ticket.id, "message": "again"})).await.unwrap(),
        json!({"action": "retry_ticket", "ticket_id": ticket.id, "retried": false, "reason": "Auto-retry limit reached"})
    );
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reminds_the_main_session_of_a_result_nobody_was_sent_and_then_asks_about_it() {
    let f = started().await;
    let answer = Arc::new(AtomicBool::new(false));
    let answering = answer.clone();
    f.script(model(move |turn| {
        let answering = answering.clone();
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "Trained to 93%."})).await?;
                    Ok("Finished.".into())
                }
                SessionRole::Watchdog => {
                    let patrol = turn.card("kind").expect("the patrol");
                    let relayed = turn
                        .call(
                            "watchdog_intervene",
                            json!({"action": "relay_report", "ticket_id": patrol["suspects"][0]["ticket_id"], "message": "The result was never sent."}),
                        )
                        .await?;
                    assert_eq!(relayed["relayed"], true);
                    Ok("Relayed the report again.".into())
                }
                // An orchestrator that forgets to send results until it is allowed to.
                _ if !answering.load(Ordering::SeqCst) => {
                    for message in messages(&turn.text) {
                        if message["kind"] == "candidate" {
                            return orchestrate(&turn).await;
                        }
                    }
                    Ok("Noted.".into())
                }
                _ => orchestrate(&turn).await,
            }
        })
    }));
    let reports = |f: &Fixture| {
        f.ran(SessionRole::Orchestrator)
            .iter()
            .filter(|ran| messages(&ran.text).iter().any(|message| message["kind"] == "worker_report" && message["state"] == "ready"))
            .count()
    };
    f.app.receive_web("Train it.", vec![], None).await.unwrap();
    f.until("the ticket completed", || f.tickets().first().is_some_and(|ticket| ticket.ended.is_some())).await;
    f.settle().await;
    assert_eq!((reports(&f), replies(&f)), (1, vec!["On it.".to_string()]));
    // Two reminders by itself, one per pass, each a new request to the main Session.
    for sent in 2..=3 {
        f.app.watchdog_tick().await;
        f.until("the reminder arrived", || reports(&f) == sent).await;
        f.settle().await;
    }
    assert!(patrols(&f).is_empty());
    // Still unanswered: now the Watchdog Session is asked, and relays it once more; this time it is sent.
    answer.store(true, Ordering::SeqCst);
    f.app.watchdog_tick().await;
    f.until("the result went out", || replies(&f).len() == 2).await;
    f.settle().await;
    let seen = patrols(&f);
    assert_eq!(seen.len(), 1);
    assert_eq!((seen[0]["suspects"][0]["kind"].as_str(), seen[0]["suspects"][0]["state"].as_str()), (Some("unreplied_ticket"), Some("completed")));
    assert_eq!((reports(&f), replies(&f)), (4, vec!["On it.".to_string(), "It is done.".to_string()]));
    // Answered: nothing more is owed.
    f.app.watchdog_tick().await;
    f.settle().await;
    assert_eq!((reports(&f), patrols(&f).len()), (4, 1));
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn queues_a_lost_launch_again() {
    let f = started().await;
    let mut settings = (*f.app.settings()).clone();
    settings.executor.max_workers = 1;
    f.app.save_settings(settings, "app", "executor").unwrap();
    f.script(model(|turn| {
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker if turn.has("[Watchdog]") || turn.has("second") => {
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "Done."})).await?;
                    Ok("Finished.".into())
                }
                SessionRole::Worker => {
                    turn.jobs.lock().unwrap().push(Fixture::job("bg_1", JobKind::Bash, "make first"));
                    Ok("Running in the background.".into())
                }
                // The Watchdog looks at the first ticket's job and leaves it alone.
                _ => orchestrate(&turn).await,
            }
        })
    }));
    f.app.receive_web("The first job.", vec![], None).await.unwrap();
    f.until("the first worker holds the only slot", || f.app.active_workers() == 1 && !f.ran(SessionRole::Worker).is_empty()).await;
    f.settle().await;
    f.app.receive_web("The second job.", vec![], None).await.unwrap();
    f.until("the second ticket waits", || f.tickets().len() == 2).await;
    f.settle().await;
    let waiting = f.ticket(1);
    let assignment = waiting.latest().unwrap().clone();
    assert_eq!(assignment.state, AssignmentState::Pending);
    assert!(f.app.effects.pending(effects::LAUNCH, Some(&assignment.id)));
    // The launch is lost, as after a crash between the two writes.
    f.app.effects.cancel(effects::LAUNCH, &assignment.id);
    assert!(!f.app.effects.pending(effects::LAUNCH, Some(&assignment.id)));
    f.app.watchdog_tick().await;
    assert!(f.app.effects.pending(effects::LAUNCH, Some(&assignment.id)));
    assert_eq!(patrols(&f).len(), 1, "the first ticket's silent job was looked at");
    // Once the slot is free, the second ticket runs.
    let first = f.ticket(0);
    assert!(f.app.cancel_job(&first.id, "bg_1", "Not needed.").await.unwrap());
    f.until("both finished", || f.tickets().iter().all(|ticket| ticket.ended.is_some())).await;
    f.settle().await;
    assert_eq!(f.ran(SessionRole::Worker).len(), 3);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn gives_way_to_a_shutdown_in_the_middle_of_an_inspection() {
    let f = started().await;
    f.script(model(|turn| {
        Box::pin(async move {
            match turn.role {
                // An inspection that would take until its time limit.
                SessionRole::Watchdog => std::future::pending::<Said>().await,
                _ => Ok("Done.".into()),
            }
        })
    }));
    f.app.board.set("wechat", Health::error("Polling failed"));
    let app = f.app.clone();
    let pass = tokio::spawn(async move { app.watchdog_tick().await });
    f.until("the inspection runs", || !f.ran(SessionRole::Watchdog).is_empty()).await;
    let began = std::time::Instant::now();
    f.app.stop().await;
    pass.await.unwrap();
    assert!(began.elapsed() < Duration::from_secs(5), "stopping took {:?}", began.elapsed());
    // A shutdown is no failure of the Watchdog.
    assert_ne!(f.app.board.get("watchdog").map(|health| health.state), Some("error"));
    f.app.watchdog_tick().await;
    assert_eq!(f.ran(SessionRole::Watchdog).len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn interrupts_a_stalled_worker_turn_and_resumes_it() {
    let f = started().await;
    f.script(model(|turn| {
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker if turn.has("[Watchdog]") => {
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "Recovered after Watchdog interrupt."})).await?;
                    Ok("Finished.".into())
                }
                // Hung mid-turn with no running_jobs (e.g. dead API stream or stuck synchronous command).
                SessionRole::Worker => std::future::pending::<Said>().await,
                SessionRole::Watchdog => {
                    let patrol = turn.card("kind").expect("the patrol");
                    let suspect = &patrol["suspects"][0];
                    assert_eq!(suspect["kind"], "long_running_worker");
                    assert_eq!(suspect["session"]["streaming"], true);
                    let res = turn
                        .call(
                            "watchdog_intervene",
                            json!({"action": "interrupt_worker", "ticket_id": suspect["ticket_id"], "message": "Turn stalled with zero progress."}),
                        )
                        .await?;
                    assert_eq!(res["interrupted"], true);
                    Ok("Interrupted the stalled worker.".into())
                }
                _ => orchestrate(&turn).await,
            }
        })
    }));
    f.app.receive_web("Run the stalled task.", vec![], None).await.unwrap();
    f.until("the worker hung mid-turn", || f.ran(SessionRole::Worker).len() == 1).await;
    f.app.watchdog_tick().await;
    f.until("the resumed worker finished", || f.tickets()[0].ended.is_some()).await;
    f.settle().await;
    let worker_runs = f.ran(SessionRole::Worker);
    assert_eq!(worker_runs.len(), 2);
    assert!(worker_runs[1].text.starts_with("[Watchdog] Interrupted stalled turn: Turn stalled with zero progress."), "{}", worker_runs[1].text);
    assert!(worker_runs[1].resumed.is_some(), "interrupted worker should resume its runtime conversation");
    assert_eq!(replies(&f), vec!["On it.", "It is done."]);
    // Audit history was persisted in SQLite kv.
    let history: Vec<Value> = f.app.store.get("watchdog-history").expect("watchdog history persisted");
    assert!(
        history.iter().any(|ev| ev["kind"] == "intervene" && ev["detail"].as_str().unwrap_or("").contains("interrupt_worker interrupted=true")),
        "{history:?}"
    );
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn falls_back_to_interrupting_session_when_driver_cannot_cancel_single_job() {
    let f = started().await;
    f.kernels.refuse_cancel.store(true, Ordering::SeqCst);
    f.script(model(|turn| {
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker if turn.has("[Watchdog]") => {
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "Recovered from non-cancellable Antigravity job."})).await?;
                    Ok("Finished.".into())
                }
                SessionRole::Worker => {
                    turn.jobs.lock().unwrap().push(Fixture::job("conv-1/task-9", JobKind::Bash, "python hang.py"));
                    Ok("Waiting on background job.".into())
                }
                SessionRole::Watchdog => {
                    let patrol = turn.card("kind").expect("the patrol");
                    let suspect = &patrol["suspects"][0];
                    let res = turn
                        .call(
                            "watchdog_intervene",
                            json!({"action": "cancel_job", "ticket_id": suspect["ticket_id"], "job_id": "conv-1/task-9", "message": "Job hung with zero CPU."}),
                        )
                        .await?;
                    assert_eq!(res["cancelled"], true);
                    Ok("Interrupted session to cancel non-cancellable job.".into())
                }
                _ => orchestrate(&turn).await,
            }
        })
    }));
    f.app.receive_web("Run hanging job.", vec![], None).await.unwrap();
    f.until("the job is running", || f.ran(SessionRole::Worker).len() == 1).await;
    f.settle().await;
    f.app.watchdog_tick().await;
    f.until("the worker finished", || f.tickets()[0].ended.is_some()).await;
    f.settle().await;
    let woken = f.ran(SessionRole::Worker)[1].text.clone();
    assert!(
        woken.starts_with("[Watchdog] Interrupted stalled session to stop background job conv-1/task-9 (python hang.py): Job hung with zero CPU."),
        "{woken}"
    );
    assert_eq!(replies(&f), vec!["On it.", "It is done."]);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn retries_patrolling_a_failed_ticket_after_a_transient_watchdog_error() {
    let f = started().await;
    let worker_calls = Arc::new(AtomicUsize::new(0));
    let watchdog_calls = Arc::new(AtomicUsize::new(0));
    let (wc, dc) = (worker_calls.clone(), watchdog_calls.clone());
    f.script(model(move |turn| {
        let (wc, dc) = (wc.clone(), dc.clone());
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    if wc.fetch_add(1, Ordering::SeqCst) == 0 {
                        Err("API error: EOF".into())
                    } else {
                        turn.call("orchestrator_report", json!({"state": "ready", "summary": "Succeeded on retry."})).await?;
                        Ok("Done.".into())
                    }
                }
                SessionRole::Watchdog => {
                    if dc.fetch_add(1, Ordering::SeqCst) == 0 {
                        // First patrol itself fails transiently (same outage as the worker).
                        Err("Watchdog upstream timeout".into())
                    } else {
                        let patrol = turn.card("kind").expect("the patrol");
                        let suspect = &patrol["suspects"][0];
                        assert_eq!(suspect["kind"], "delivery_or_transient_failure");
                        let retried = turn
                            .call("watchdog_intervene", json!({"action": "retry_ticket", "ticket_id": suspect["ticket_id"], "message": "Transient EOF."}))
                            .await?;
                        assert_eq!(retried["retried"], true);
                        Ok("Retried.".into())
                    }
                }
                _ => orchestrate(&turn).await,
            }
        })
    }));
    f.app.receive_web("Do work.", vec![], None).await.unwrap();
    f.until("worker failed once", || f.tickets().first().and_then(|t| t.latest_report()).is_some_and(|r| r.state == ReportState::Failed)).await;
    f.settle().await;
    // Tick 1: Watchdog patrol errors out; failure_seen must NOT be permanently committed.
    f.app.watchdog_tick().await;
    assert_eq!(f.app.board.get("watchdog").map(|h| h.state), Some("error"));
    assert_eq!(f.ran(SessionRole::Worker).len(), 1);
    // Tick 2: Watchdog retries the patrol and recovers the failed ticket!
    f.app.watchdog_tick().await;
    f.until("worker recovered and completed", || f.tickets()[0].ended.is_some()).await;
    f.settle().await;
    assert_eq!(f.ran(SessionRole::Worker).len(), 2);
    assert_eq!(f.ran(SessionRole::Watchdog).len(), 2);
    assert_eq!(replies(&f), vec!["On it.", "It is done."]);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn never_relays_progress_for_stale_answers_and_caps_manual_relay_escalations() {
    let f = started().await;
    // Main session never sends the final result, so we can verify manual escalation caps cleanly.
    f.script(model(|turn| {
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    turn.call("orchestrator_report", json!({"state": "ready", "summary": "Result ready."})).await?;
                    Ok("Done.".into())
                }
                SessionRole::Watchdog => {
                    let patrol = turn.card("kind").expect("the patrol");
                    let tid = patrol["suspects"][0]["ticket_id"].clone();
                    turn.call("watchdog_intervene", json!({"action": "relay_report", "ticket_id": tid, "message": "Still missing."})).await?;
                    Ok("Relayed.".into())
                }
                _ => {
                    for message in messages(&turn.text) {
                        if message["kind"] == "candidate" {
                            turn.call(
                                "orchestrator_route",
                                json!({"decisions": [{"kind": "accept", "trigger_id": message["trigger_id"], "title": "Task", "worktree_name": "task-one", "acknowledgement": "On it."}]}),
                            )
                            .await?;
                        }
                    }
                    Ok("Ignored.".into())
                }
            }
        })
    }));
    f.app.receive_web("Do task.", vec![], None).await.unwrap();
    f.until("ticket completed", || f.tickets().first().is_some_and(|t| t.ended.is_some())).await;
    f.settle().await;

    // 2 auto nudges + at most 2 manual Watchdog LLM escalations, then silence (not infinite 24h spam!).
    for _ in 0..8 {
        f.app.watchdog_tick().await;
        f.settle().await;
    }
    assert_eq!(patrols(&f).len(), 2, "manual unreplied escalations must be capped at 2");
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ignores_progress_report_with_stale_answers_and_caps_auto_interrupts() {
    let f = started().await;
    f.script(model(|turn| {
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    turn.jobs.lock().unwrap().push(Fixture::job("bg_1", JobKind::Bash, "sleep 30"));
                    turn.call("orchestrator_report", json!({"state": "progress", "summary": "Still working on phase 2."})).await?;
                    Ok("Working.".into())
                }
                SessionRole::Watchdog => Ok("Healthy.".into()),
                _ => orchestrate(&turn).await,
            }
        })
    }));
    f.app.receive_web("Start phase 2.", vec![], None).await.unwrap();
    f.until("progress report saved", || f.tickets().first().and_then(|t| t.latest_report()).is_some_and(|r| r.state == ReportState::Progress)).await;
    f.settle().await;

    // Simulate a stale trigger id left behind in ticket.answers while a Progress report is active.
    let mut ticket = f.ticket(0);
    ticket.answers.push(ticket.origin.trigger_id.clone());
    neo_core::ports::Repositories::save_ticket(f.app.store.as_ref(), &ticket);

    let main_before = f.ran(SessionRole::Orchestrator).len();
    for _ in 0..3 {
        f.app.watchdog_tick().await;
        f.settle().await;
    }
    assert_eq!(f.ran(SessionRole::Orchestrator).len(), main_before, "Watchdog must never relay routine Progress reports as missing answers");

    // Verify auto-interrupt limit caps at 2 per ticket.
    let tid = ticket.id.clone();
    assert_eq!(f.app.watchdog_intervene(json!({"action": "interrupt_worker", "ticket_id": tid, "message": "hang 1"})).await.unwrap()["interrupted"], true);
    f.until("second worker turn started", || f.ran(SessionRole::Worker).len() >= 2).await;
    assert_eq!(f.app.watchdog_intervene(json!({"action": "interrupt_worker", "ticket_id": tid, "message": "hang 2"})).await.unwrap()["interrupted"], true);
    f.until("third worker turn started", || f.ran(SessionRole::Worker).len() >= 3).await;
    assert_eq!(
        f.app.watchdog_intervene(json!({"action": "interrupt_worker", "ticket_id": tid, "message": "hang 3"})).await.unwrap(),
        json!({"action": "interrupt_worker", "ticket_id": tid, "interrupted": false, "reason": "Auto-interrupt limit reached"})
    );
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn heals_lost_launch_even_when_watchdog_kernel_is_unavailable() {
    let f = started().await;
    let mut settings = (*f.app.settings()).clone();
    settings.executor.max_workers = 1;
    f.app.save_settings(settings, "app", "executor").unwrap();
    f.script(model(|turn| {
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    turn.jobs.lock().unwrap().push(Fixture::job("bg_1", JobKind::Bash, "sleep 10"));
                    Ok("Working.".into())
                }
                _ => orchestrate(&turn).await,
            }
        })
    }));
    f.app.receive_web("First.", vec![], None).await.unwrap();
    f.until("first holds slot", || f.app.active_workers() == 1 && !f.ran(SessionRole::Worker).is_empty()).await;
    f.settle().await;
    f.app.receive_web("Second.", vec![], None).await.unwrap();
    f.until("second waits", || f.tickets().len() == 2).await;
    f.settle().await;
    let assignment = f.ticket(1).latest().unwrap().clone();
    f.app.effects.cancel(effects::LAUNCH, &assignment.id);
    assert!(!f.app.effects.pending(effects::LAUNCH, Some(&assignment.id)));
    // Even if the LLM kernel is temporarily unavailable, zero-model queue healing must still run!
    *f.kernels.unavailable.lock().unwrap() = Some("CLI missing".into());
    f.app.watchdog_tick().await;
    assert!(f.app.effects.pending(effects::LAUNCH, Some(&assignment.id)));
    assert!(patrols(&f).is_empty());
    f.app.stop().await;
}
