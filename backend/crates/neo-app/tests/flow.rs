//! The whole path of a request, over a scripted kernel: a chat message becomes a candidate, the orchestrator accepts
//! it, a worker does the work in its own directory and reports, and the result goes back to the conversation.

mod common;

use common::*;
use neo_app::kernels::SessionRole;
use neo_core::model::{AssignmentState, ReportState, TicketOutcome};
use neo_core::ports::ReplyStatus;
use neo_core::ReceiveResult;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn carries_a_chat_request_from_message_to_result() {
    let f = started().await;
    let receipt = f.app.receive_web("Please fix the typo in the fixture.", vec![], Some("web:m1".into())).await.unwrap();
    assert_eq!((receipt.result, receipt.request_id.as_str()), (ReceiveResult::Stored, "chat:web:m1"));
    f.until("the result is in the transcript", || f.chat().len() >= 3).await;
    f.settle().await;
    // The person sees their message, the acknowledgement and the result, each once and in order.
    assert_eq!(
        f.chat(),
        vec![
            ("web-panel".to_string(), "Please fix the typo in the fixture.".to_string()),
            ("chat-reply".to_string(), "I will fix the fixture typo.".to_string()),
            ("chat-reply".to_string(), "Fixture work completed.".to_string()),
        ]
    );
    // One ticket, accepted explicitly from the local sender, completed by its worker's ready report.
    let tickets = f.tickets();
    assert_eq!(tickets.len(), 1);
    let ticket = &tickets[0];
    assert_eq!((ticket.title.as_str(), ticket.mandate.actor.id.as_str()), ("Fix fixture typo", "web:local"));
    assert_eq!(ticket.ended.as_ref().map(|ended| ended.outcome), Some(TicketOutcome::Completed));
    assert_eq!(ticket.assignments.iter().map(|assignment| assignment.state).collect::<Vec<_>>(), vec![AssignmentState::Ended]);
    assert_eq!(
        ticket.assignments[0].report.as_ref().map(|report| (report.state, report.summary.as_str())),
        Some((ReportState::Ready, "Fixture change is ready."))
    );
    assert_eq!(ticket.digest.as_deref(), Some("The fixture typo in fixture-result.txt"));
    // The worker ran in the ticket's own directory, named after the ticket.
    let execution = ticket.execution.as_ref().unwrap();
    assert!(execution.name.starts_with("fix-fixture-typo-") && execution.directory.ends_with(&execution.name));
    assert!(execution.directory.starts_with(f.dir.join("state/work").to_str().unwrap()));
    assert_eq!(std::fs::read_to_string(std::path::Path::new(&execution.directory).join("fixture-result.txt")).unwrap(), "fixed\n");
    // What each Session was told.
    let main = f.ran(SessionRole::Orchestrator);
    assert_eq!(main.len(), 2, "{main:#?}");
    let candidate = message(&main[0].text, "candidate");
    assert_eq!(
        (candidate["kind"].as_str(), candidate["strength"].as_str(), candidate["from"].as_str()),
        (Some("candidate"), Some("explicit"), Some("web:local"))
    );
    assert_eq!(candidate["text"], "Please fix the typo in the fixture.");
    assert_eq!(candidate["trigger_id"], receipt.trigger_id.as_str());
    let report = message(&main[1].text, "worker_report");
    assert_eq!((report["state"].as_str(), report["summary"].as_str()), (Some("ready"), Some("Fixture change is ready.")));
    // The main Session is also told that the ticket ended, as a notice that starts no turn of its own: it reads it
    // with the report when it came first, else with its next message.
    let noted: Vec<serde_json::Value> = f
        .app
        .session(&f.app.master_id)
        .unwrap()
        .session
        .journal()
        .entries()
        .iter()
        .filter_map(|entry| match entry {
            neo_kernel::journal::Entry::CustomMessage { content, .. } => serde_json::from_str(&neo_kernel::types::text_of(content)).ok(),
            _ => None,
        })
        .collect();
    let ended = noted.iter().find(|value| value.get("ticket_ended").is_some()).expect("the ticket's end is noted");
    assert_eq!(ended["ticket_ended"]["state"], "completed");
    let workers = f.ran(SessionRole::Worker);
    assert_eq!(workers.len(), 1);
    let assignment = messages(&workers[0].text).into_iter().next().expect("the assignment card");
    assert_eq!((assignment["ticket_id"].as_str(), assignment["title"].as_str()), (Some(ticket.id.as_str()), Some("Fix fixture typo")));
    assert_eq!(assignment["trigger"]["text"], "Please fix the typo in the fixture.");
    assert_eq!(assignment["directory"], execution.directory.as_str());
    // Each role was given its own prompt and tools.
    let opened = f.kernels.opened.lock().unwrap().clone();
    let of = |role| opened.iter().find(|spec| spec.role == role).unwrap().clone();
    assert!(
        of(SessionRole::Orchestrator).system_prompt.contains("You are the orchestrator") && of(SessionRole::Orchestrator).system_prompt.contains("## Policy")
    );
    assert!(of(SessionRole::Worker).system_prompt.contains("You are a worker.") && !of(SessionRole::Worker).system_prompt.contains("## Policy"));
    assert_eq!(of(SessionRole::Worker).cwd.to_str(), Some(execution.directory.as_str()));
    // The worker's Session closed with its ticket; both replies went out.
    assert!(f.app.session(&format!("worker-{}", ticket.id)).is_none());
    assert!(f.app.store.waiting_receipts().is_empty());
    assert_eq!(f.app.active_workers(), 0);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn takes_a_chat_message_once_however_often_it_is_sent() {
    let f = started().await;
    let first = f.app.receive_web("Fix it.", vec![], Some("web:same".into())).await.unwrap();
    let again = f.app.receive_web("Fix it.", vec![], Some("web:same".into())).await.unwrap();
    assert_eq!((first.result, again.result), (ReceiveResult::Stored, ReceiveResult::Duplicate));
    assert_eq!(first.trigger_id, again.trigger_id);
    f.until("the work is done", || f.chat().len() >= 3).await;
    f.settle().await;
    assert_eq!(f.tickets().len(), 1);
    assert_eq!(f.chat().iter().filter(|(source, _)| source == "web-panel").count(), 1);
    assert!(f.app.receive_web("x", vec![], Some("bad id".into())).await.unwrap_err().contains("Invalid chat message ID"));
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_plain_conversation_in_the_same_turn_without_a_ticket() {
    let f = started().await;
    f.script(model(|turn| {
        Box::pin(async move {
            if let Some(card) = turn.card("kind").filter(|card| card["kind"] == "candidate") {
                let routed = turn.call("orchestrator_route", json!({"decisions": [{"kind": "ignore", "trigger_id": card["trigger_id"], "reason": "Small talk", "answer": "你好！有什么需要我做的吗？"}]})).await?;
                assert_eq!(routed["results"][0]["decision"], "ignore");
            }
            Ok("Done.".into())
        })
    }));
    f.app.receive_web("你好", vec![], None).await.unwrap();
    f.until("the answer is in the transcript", || f.chat().len() == 2).await;
    f.settle().await;
    assert_eq!(f.chat()[1], ("chat-reply".to_string(), "你好！有什么需要我做的吗？".to_string()));
    assert!(f.tickets().is_empty());
    assert_eq!(f.ran(SessionRole::Orchestrator).len(), 1, "no second turn was needed");
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_one_bad_routing_item_and_still_runs_the_others() {
    let f = started().await;
    let results = std::sync::Arc::new(std::sync::Mutex::new(serde_json::Value::Null));
    let seen = results.clone();
    f.script(model(move |turn| {
        let seen = seen.clone();
        Box::pin(async move {
            if let Some(card) = turn.card("kind").filter(|card| card["kind"] == "candidate") {
                let id = card["trigger_id"].clone();
                let routed = turn
                    .call(
                        "orchestrator_route",
                        json!({"decisions": [
                            {"kind": "accept", "trigger_id": id, "title": "No name"},
                            {"kind": "accept", "trigger_id": id, "title": "T", "worktree_name": "Bad Name", "acknowledgement": "ok"},
                            {"kind": "attach", "trigger_id": id, "ticket_id": "missing"},
                            {"kind": "stop", "trigger_id": "missing", "ticket_id": "missing"},
                            {"kind": "sideways", "trigger_id": id},
                            {"kind": "ignore", "trigger_id": id},
                            {"kind": "ignore", "trigger_id": id, "reason": "Chatter", "title": "x", "extra": 1},
                            {"kind": "ignore", "trigger_id": id, "reason": "Chatter"},
                            {"kind": "ignore", "trigger_id": id, "reason": "Again"},
                        ]}),
                    )
                    .await?;
                *seen.lock().unwrap() = routed;
            }
            Ok("Done.".into())
        })
    }));
    f.app.receive_web("hello", vec![], None).await.unwrap();
    f.until("the call returned", || !results.lock().unwrap().is_null()).await;
    f.settle().await;
    let results = results.lock().unwrap().clone();
    let refused: Vec<String> = results["results"].as_array().unwrap().iter().map(|item| item["refused"].as_str().unwrap_or("").to_string()).collect();
    assert_eq!(refused[0], "accept needs worktree_name");
    assert!(refused[1].starts_with("worktree_name: Use 1–4 short English words"));
    assert_eq!(refused[2], "Unknown ticket");
    assert_eq!(refused[3], "Unknown trigger");
    assert_eq!(refused[4], "kind is accept, attach, sidecar, ignore or stop");
    assert_eq!(refused[5], "ignore needs reason");
    assert!(refused[6].starts_with("Unknown argument extra"));
    // The eighth item is the one that decided it; the ninth finds it decided in this call.
    assert_eq!((results["results"][7]["decision"].as_str(), refused[7].as_str()), (Some("ignore"), ""));
    assert!(refused[8].starts_with("Decided in this call with"), "{}", refused[8]);
    assert!(f.tickets().is_empty());
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_its_state_across_a_restart_and_sends_nothing_twice() {
    let f = started().await;
    f.app.receive_web("Please fix the typo in the fixture.", vec![], Some("web:m1".into())).await.unwrap();
    f.until("the result is in the transcript", || f.chat().len() >= 3).await;
    f.settle().await;
    let before = (f.chat(), f.tickets(), f.kernels.ran.lock().unwrap().len());
    let f = f.restart().await;
    f.settle().await;
    assert_eq!(f.chat(), before.0);
    assert_eq!(f.tickets(), before.1);
    assert_eq!(f.kernels.ran.lock().unwrap().len(), before.2, "a restart with nothing to do starts no turn");
    // The same message after the restart is still the same message.
    assert_eq!(f.app.receive_web("Please fix the typo in the fixture.", vec![], Some("web:m1".into())).await.unwrap().result, ReceiveResult::Duplicate);
    // And new work goes on in the same conversation, with the main Session resuming its runtime context.
    f.app.receive_web("And another typo.", vec![], Some("web:m2".into())).await.unwrap();
    f.until("the second result is in the transcript", || f.chat().len() >= 6).await;
    f.settle().await;
    assert_eq!(f.tickets().len(), 2);
    let main = f.ran(SessionRole::Orchestrator);
    assert_eq!(main.last().unwrap().resumed.as_deref(), Some(format!("rt-{}", f.app.master_id).as_str()));
    assert_eq!(f.app.store.reply_status(&neo_core::ids::key(&["ack", &f.ticket(1).origin.trigger_id])), Some(ReplyStatus::Sent));
    f.app.stop().await;
}
