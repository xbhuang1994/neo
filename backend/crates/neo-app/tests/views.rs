//! What the app shows and changes, over a scripted kernel: the conversation, workers, health, the kernel and model
//! settings and the general settings.

mod common;

use common::*;
use neo_app::kernels::{ModelOption, SessionRole};
use neo_app::sessions::ChatAttachment;
use neo_app::settings::Kernel;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

fn option(provider: &str, id: &str) -> ModelOption {
    ModelOption { id: id.into(), provider: provider.into(), name: format!("{provider} {id}") }
}

#[tokio::test(flavor = "multi_thread")]
async fn shows_the_conversation_the_workers_and_health() {
    let f = started().await;
    assert_eq!(f.app.panel_messages(), Vec::<Value>::new());
    assert!(f.app.worker_cards().await.is_empty());
    let attachments = vec![
        ChatAttachment { name: "shot.png".into(), media_type: "image/png".into(), data: vec![0x89, b'P', b'N', b'G'] },
        ChatAttachment { name: "notes.md".into(), media_type: String::new(), data: b"# Notes".to_vec() },
        ChatAttachment { name: "data.bin".into(), media_type: "application/zip".into(), data: vec![0, 1] },
    ];
    f.app.receive_web("Please fix the typo in the fixture.", attachments, Some("web:m1".into())).await.unwrap();
    f.until("the result is in the transcript", || f.chat().len() >= 3).await;
    f.settle().await;
    let messages = f.app.panel_messages();
    assert_eq!(messages.iter().map(|message| message["role"].as_str().unwrap()).collect::<Vec<_>>(), vec!["user", "assistant", "assistant"]);
    assert!(messages[0]["text"].as_str().unwrap().starts_with("Please fix the typo in the fixture.\n\n<attachment name=\"shot.png\""));
    assert_eq!(messages[0]["images"], json!([{"name": "shot.png", "mediaType": "image/png", "data": "iVBORw=="}]));
    assert_eq!(
        messages[0]["files"],
        json!([{"name": "notes.md", "mediaType": "text/plain", "kind": "text"}, {"name": "data.bin", "mediaType": "application/zip", "kind": "file"}])
    );
    assert_eq!((messages[1]["text"].as_str(), messages[2]["text"].as_str()), (Some("I will fix the fixture typo."), Some("Fixture work completed.")));
    assert!(messages[1].get("images").is_none() && messages[1].get("files").is_none());
    assert!(messages.iter().all(|message| message["at"].as_i64().is_some_and(|at| at > 1_700_000_000_000)));
    assert!(messages[0]["id"].as_u64() < messages[1]["id"].as_u64());
    // Nothing the model was told in between shows.
    assert!(!serde_json::to_string(&messages).unwrap().contains("candidate"));

    let cards = f.app.worker_cards().await;
    assert_eq!(cards.len(), 1);
    let ticket = f.ticket(0);
    let card = &cards[0];
    assert_eq!(
        (card["ticketId"].as_str(), card["title"].as_str(), card["outcome"].as_str()),
        (Some(ticket.id.as_str()), Some("Fix fixture typo"), Some("completed"))
    );
    assert_eq!(card["stage"], json!({"stage": "ended"}));
    assert_eq!(card["session"], json!({"loaded": false, "streaming": false}));
    assert_eq!((card["progress"]["state"].as_str(), card["progress"]["summary"].as_str()), (Some("ready"), Some("Fixture change is ready.")));
    assert_eq!(
        (card["assignment"]["state"].as_str(), card["pendingInputs"].as_u64(), card["background"].as_array().map(Vec::len)),
        (Some("ended"), Some(0), Some(0))
    );
    assert_eq!(card["directory"], ticket.execution.as_ref().unwrap().directory.as_str());
    assert!(card["attention"].is_null() && card["delivery"].is_null());
    let detail = f.app.worker_detail(&ticket.id).await.expect("the ticket's detail");
    assert_eq!(detail["ticketId"], card["ticketId"]);
    assert!(detail["inputs"].is_array());
    let recent = detail["recent"].as_array().unwrap();
    assert!(recent.iter().any(|line| line["role"] == "assistant" && line["text"] == "Worker ready."), "{recent:#?}");
    assert!(recent.iter().any(|line| line["role"] == "custom" && line["text"].as_str().unwrap().contains("Fix fixture typo")));
    assert!(f.app.worker_detail("missing").await.is_none());

    let health = f.app.health_view();
    assert_eq!(
        (health["ready"].as_bool(), health["kernel"].as_str(), health["paused"].as_bool(), health["activeWorkers"].as_u64()),
        (Some(true), Some("omp"), Some(false), Some(0))
    );
    assert_eq!(health["components"]["runtime"]["state"], "ready");
    assert_eq!(health["components"]["kernel"]["detail"], "Running on omp");
    assert_eq!(health["version"], env!("CARGO_PKG_VERSION"));
    f.app.stop().await;
    assert_eq!(f.app.health_view()["ready"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn shows_a_running_worker_with_its_question_and_jobs() {
    let f = started().await;
    f.script(model(|turn| {
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    turn.jobs.lock().unwrap().push(Fixture::job("bg_1", neo_kernel::types::JobKind::Bash, "make train\nsecond line"));
                    turn.call("orchestrator_report", json!({"state": "progress", "summary": "Training.", "human_action": "Which dataset?"})).await?;
                    Ok("Waiting.".into())
                }
                _ => core_model()(turn).await,
            }
        })
    }));
    f.app.receive_web("Train it.", vec![], None).await.unwrap();
    f.until("the question is open", || f.tickets().first().is_some_and(|ticket| ticket.attention.is_some())).await;
    f.settle().await;
    let card = f.app.worker_cards().await.remove(0);
    assert_eq!(card["stage"], json!({"stage": "person", "action": "answer"}));
    assert_eq!(card["attention"]["question"], "Which dataset?");
    assert_eq!((card["session"]["loaded"].as_bool(), card["outcome"].is_null()), (Some(true), true));
    assert_eq!(card["progress"]["state"], "progress");
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn shows_what_is_at_work_for_the_ticker() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let f = started().await;
    assert_eq!(f.app.activity_view().await, json!({"router": false, "workers": []}));
    let (router_gate, worker_gate) = (Arc::new(AtomicBool::new(true)), Arc::new(AtomicBool::new(true)));
    let (router_held, worker_held) = (router_gate.clone(), worker_gate.clone());
    f.script(model(move |turn| {
        let (router_held, worker_held) = (router_held.clone(), worker_held.clone());
        Box::pin(async move {
            match turn.role {
                SessionRole::Worker => {
                    turn.call("orchestrator_report", json!({"state": "progress", "summary": "Training the model.\nEpoch 1."})).await?;
                    while worker_held.load(Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    core_model()(turn).await
                }
                _ => {
                    while router_held.load(Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    core_model()(turn).await
                }
            }
        })
    }));
    f.app.receive_web("Train it.", vec![], None).await.unwrap();
    f.until("the router thinks", || block(f.app.activity_view())["router"] == true).await;
    router_gate.store(false, Ordering::SeqCst);
    f.until("the worker says what it does", || {
        block(f.app.activity_view())["workers"].as_array().is_some_and(|workers| workers.len() == 1 && workers[0]["doing"] == "Training the model.")
    })
    .await;
    assert_eq!(f.app.activity_view().await["workers"][0]["title"], "Fix fixture typo");
    worker_gate.store(false, Ordering::SeqCst);
    f.until("nothing is at work", || block(f.app.activity_view()) == json!({"router": false, "workers": []})).await;
    f.app.stop().await;
}

/// Wait for a future from a synchronous condition.
fn block<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(future))
}

#[tokio::test(flavor = "multi_thread")]
async fn chooses_models_per_kernel_and_switches_the_kernel() {
    let f = fixture().await;
    *f.kernels.models.lock().unwrap() = vec![option("fixture", "big"), option("fixture", "small")];
    f.app.start().await.unwrap();
    let view = models_ready(&f.app).await;
    assert_eq!((view["kernel"].as_str(), view["problem"].is_null()), (Some("omp"), true));
    assert_eq!(view["current"], json!({"eval": null, "executor": null}));
    assert!(view["supports"]["thinkingLevels"].as_array().unwrap().contains(&json!("minimal")));
    assert_eq!(view["available"][0], json!({"id": "big", "provider": "fixture", "name": "fixture big"}));
    let idle = |id: &str| json!({"id": id, "problem": null, "installed": true, "installing": false});
    let state: Vec<Value> = view["kernels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|kernel| json!({"id": kernel["id"], "problem": kernel["problem"], "installed": kernel["installed"], "installing": kernel["installing"]}))
        .collect();
    assert_eq!(state, vec![idle("omp"), idle("claude"), idle("antigravity"), idle("hermes")]);
    // Every kernel's models and kept choices come along, so a page can prepare a switch without asking again.
    assert_eq!(view["kernels"][2]["available"], view["available"]);
    assert_eq!(view["kernels"][1]["models"], json!({"eval": null, "executor": null}));

    // Refusals change nothing.
    let refused = |value: Value| {
        let app = f.app.clone();
        async move { app.update_models(value).await.unwrap_err() }
    };
    assert!(refused(json!({"eval": null})).await.starts_with("executor is required"));
    assert_eq!(refused(json!({"eval": {"provider": "fixture", "model": "huge"}, "executor": null})).await, "Unknown OMP model: fixture/huge");
    assert_eq!(
        refused(json!({"eval": {"provider": "fixture", "model": "big", "thinkingLevel": "ultra"}, "executor": null})).await,
        "Thinking level ultra is not supported by the omp kernel"
    );
    assert!(refused(json!({"eval": null, "executor": null, "advisor": null})).await.starts_with("Unknown field advisor"));
    assert!(f.app.settings().models.is_empty());

    // A choice is saved and reaches the open main Session.
    let chosen = json!({"eval": {"provider": "fixture", "model": "big", "thinkingLevel": "high"}, "executor": {"provider": "fixture", "model": "small"}});
    let view = f.app.update_models(chosen.clone()).await.unwrap();
    assert_eq!(view["current"], chosen);
    assert_eq!(
        f.kernels.set_models.lock().unwrap().last().cloned(),
        Some((f.app.master_id.clone(), Some("fixture/big".to_string()), Some("high".to_string())))
    );
    assert_eq!(f.app.settings().role_models().executor.map(|model| model.model), Some("small".into()));

    // The other kernel has its own choices, none yet; the main Session reopens on it from the same transcript.
    let opened = f.kernels.opened.lock().unwrap().len();
    assert_eq!(f.app.set_kernel(json!({"kernel": "omp"})).await.unwrap()["kernel"], "omp");
    assert_eq!(f.kernels.opened.lock().unwrap().len(), opened, "the same kernel reopens nothing");
    let view = f.app.set_kernel(json!({"kernel": "claude"})).await.unwrap();
    assert_eq!(view["kernel"].as_str(), Some("claude"));
    assert_eq!(view["current"], json!({"eval": null, "executor": null}));
    assert!(!view["supports"]["thinkingLevels"].as_array().unwrap().contains(&json!("minimal")));
    assert_eq!(f.kernels.opened.lock().unwrap().len(), opened + 1);
    assert_eq!((f.app.settings().kernel, f.app.board.get("kernel").map(|health| health.detail)), (Kernel::Claude, Some("Running on claude".to_string())));
    assert_eq!(f.app.session(&f.app.master_id).map(|main| main.kernel), Some(Kernel::Claude));
    // Claude Code takes model names as they are, and has no minimal effort.
    let view = f.app.update_models(json!({"eval": {"provider": "anthropic", "model": "opus"}, "executor": null})).await.unwrap();
    assert_eq!(view["current"], json!({"eval": {"provider": "anthropic", "model": "opus"}, "executor": null}));
    assert_eq!(f.kernels.set_models.lock().unwrap().last().cloned(), Some((f.app.master_id.clone(), Some("opus".to_string()), None)));
    assert_eq!(
        refused(json!({"eval": {"provider": "anthropic", "model": "opus", "thinkingLevel": "minimal"}, "executor": null})).await,
        "Thinking level minimal is not supported by the claude kernel"
    );
    // The Antigravity CLI takes no thinking level: one sent along is dropped, and none reaches the runtime.
    let view = f.app.set_kernel(json!({"kernel": "antigravity"})).await.unwrap();
    assert_eq!(view["supports"]["thinkingLevels"], json!([]));
    let view = f.app.update_models(json!({"eval": {"provider": "antigravity", "model": "gemini", "thinkingLevel": "high"}, "executor": null})).await.unwrap();
    assert_eq!(view["current"]["eval"], json!({"provider": "antigravity", "model": "gemini"}));
    assert_eq!(f.kernels.set_models.lock().unwrap().last().cloned(), Some((f.app.master_id.clone(), Some("gemini".to_string()), None)));
    // Hermes Agent takes provider/model names and minimal through max effort.
    let view = f.app.set_kernel(json!({"kernel": "hermes"})).await.unwrap();
    assert!(view["supports"]["thinkingLevels"].as_array().unwrap().contains(&json!("minimal")));
    let view = f
        .app
        .update_models(json!({"eval": {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.6", "thinkingLevel": "minimal"}, "executor": null}))
        .await
        .unwrap();
    assert_eq!(view["current"]["eval"], json!({"provider": "openrouter", "model": "anthropic/claude-sonnet-4.6", "thinkingLevel": "minimal"}));
    assert_eq!(
        f.kernels.set_models.lock().unwrap().last().cloned(),
        Some((f.app.master_id.clone(), Some("openrouter/anthropic/claude-sonnet-4.6".to_string()), Some("minimal".to_string())))
    );
    f.app.set_kernel(json!({"kernel": "claude"})).await.unwrap();
    // Back on the first kernel its choices are as they were left.
    assert_eq!(f.app.set_kernel(json!({"kernel": "omp"})).await.unwrap()["current"], chosen);
    assert_eq!(f.app.settings().models[&Kernel::Claude].eval.as_ref().map(|model| model.model.as_str()), Some("opus"));

    // A kernel that cannot run here is not switched to, and says why.
    assert_eq!(f.app.set_kernel(json!({"kernel": "pi"})).await.unwrap_err(), "kernel is omp, claude, antigravity or hermes");
    *f.kernels.unavailable.lock().unwrap() = Some("The Claude Code program (claude) was not found.".into());
    assert_eq!(f.app.set_kernel(json!({"kernel": "claude"})).await.unwrap_err(), "The Claude Code program (claude) was not found.");
    assert_eq!(f.app.settings().kernel, Kernel::Omp);
    let view = f.app.models_view().await;
    assert_eq!((view["problem"].as_str(), view["available"].as_array().map(Vec::len)), (Some("The Claude Code program (claude) was not found."), Some(0)));

    // Installing a kernel that is not in use only installs it.
    let view = f.app.install_kernel(json!({"kernel": "claude"})).await.unwrap();
    assert_eq!((view["kernel"].as_str(), view["problem"].is_null()), (Some("omp"), true));
    assert_eq!(f.kernels.installed.lock().unwrap().clone(), vec![Kernel::Claude]);
    assert_eq!(f.app.install_kernel(json!({"kernel": "gpt"})).await.unwrap_err(), "kernel is omp, claude, antigravity or hermes");
    // One that is installed already is not installed again.
    f.app.install_kernel(json!({"kernel": "omp"})).await.unwrap();
    assert_eq!(f.kernels.installed.lock().unwrap().len(), 1);

    // The choices outlive a restart.
    let f = f.restart().await;
    assert_eq!(f.app.models_view().await["current"], chosen);
    assert_eq!(f.kernels.opened.lock().unwrap().last().and_then(|spec| spec.model.clone()).map(|model| model.model), Some("big".into()));
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn chooses_the_workers_kernel_and_model_apart_from_the_main_sessions() {
    let f = fixture().await;
    *f.kernels.models.lock().unwrap() = vec![option("fixture", "big"), option("fixture", "small")];
    f.app.start().await.unwrap();
    let view = models_ready(&f.app).await;
    assert_eq!((view["workerKernel"].as_str(), view["workerKernelFollows"].as_bool()), (Some("omp"), Some(true)));
    assert_eq!(view["workerAvailable"], view["available"]);
    assert_eq!(f.app.health_view()["workerKernel"], "omp");

    let opened = f.kernels.opened.lock().unwrap().len();
    let view = f.app.set_kernel(json!({"workerKernel": "antigravity"})).await.unwrap();
    assert_eq!(f.kernels.opened.lock().unwrap().len(), opened, "the main Session stays where it is");
    assert_eq!((view["kernel"].as_str(), view["workerKernel"].as_str()), (Some("omp"), Some("antigravity")));
    assert_eq!((view["supports"]["thinkingLevels"].as_array().map(Vec::len), view["workerSupports"]["thinkingLevels"].clone()), (Some(8), json!([])));
    // Each role is checked against its own kernel, and saved under it.
    let view = f
        .app
        .update_models(json!({"eval": {"provider": "fixture", "model": "big", "thinkingLevel": "low"}, "executor": {"provider": "antigravity", "model": "gemini", "thinkingLevel": "high"}}))
        .await
        .unwrap();
    assert_eq!(
        view["current"],
        json!({"eval": {"provider": "fixture", "model": "big", "thinkingLevel": "low"}, "executor": {"provider": "antigravity", "model": "gemini"}})
    );
    let settings = f.app.settings();
    assert_eq!(settings.models[&Kernel::Omp].eval.as_ref().map(|model| model.model.as_str()), Some("big"));
    assert_eq!(settings.models[&Kernel::Omp].executor, None);
    assert_eq!(settings.models[&Kernel::Antigravity].executor.as_ref().map(|model| model.model.as_str()), Some("gemini"));
    // Switching the main Session's kernel leaves the workers' where it was.
    let view = f.app.set_kernel(json!({"kernel": "claude"})).await.unwrap();
    assert_eq!(
        (view["kernel"].as_str(), view["workerKernel"].as_str(), view["current"]["executor"]["model"].as_str()),
        (Some("claude"), Some("antigravity"), Some("gemini"))
    );
    assert_eq!(f.app.board.get("kernel").map(|health| health.detail), Some("Main Session on claude, workers on antigravity".to_string()));
    // Both at once, and the refusals.
    let view = f.app.set_kernel(json!({"kernel": "omp", "workerKernel": null})).await.unwrap();
    assert_eq!((view["kernel"].as_str(), view["workerKernel"].as_str()), (Some("omp"), Some("omp")));
    assert_eq!(f.app.set_kernel(json!({})).await.unwrap_err(), "kernel or workerKernel is required");
    assert_eq!(f.app.set_kernel(json!({"workerKernel": "pi"})).await.unwrap_err(), "workerKernel is omp, claude, antigravity, hermes or null");
    *f.kernels.unavailable.lock().unwrap() = Some("The Claude Code program (claude) was not found.".into());
    assert_eq!(f.app.set_kernel(json!({"workerKernel": "claude"})).await.unwrap_err(), "The Claude Code program (claude) was not found.");
    assert_eq!(f.app.settings().worker_kernel, None);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn saves_a_kernel_switch_and_its_models_as_one() {
    let f = fixture().await;
    *f.kernels.models.lock().unwrap() = vec![option("fixture", "big")];
    f.app.start().await.unwrap();
    let opened = f.kernels.opened.lock().unwrap().len();
    // A model the new kernel refuses changes nothing, the kernel included.
    let refused = f
        .app
        .update_models(json!({"kernel": "claude", "eval": {"provider": "anthropic", "model": "opus", "thinkingLevel": "minimal"}, "executor": null}))
        .await;
    assert_eq!(refused.unwrap_err(), "Thinking level minimal is not supported by the claude kernel");
    assert_eq!((f.app.settings().kernel, f.kernels.opened.lock().unwrap().len()), (Kernel::Omp, opened));
    let view = f
        .app
        .update_models(json!({"kernel": "claude", "workerKernel": "omp", "eval": {"provider": "anthropic", "model": "opus"}, "executor": {"provider": "fixture", "model": "big"}}))
        .await
        .unwrap();
    assert_eq!((view["kernel"].as_str(), view["workerKernel"].as_str(), view["workerKernelFollows"].as_bool()), (Some("claude"), Some("omp"), Some(false)));
    assert_eq!(view["current"], json!({"eval": {"provider": "anthropic", "model": "opus"}, "executor": {"provider": "fixture", "model": "big"}}));
    assert_eq!(f.app.session(&f.app.master_id).map(|main| main.kernel), Some(Kernel::Claude));
    assert_eq!(f.kernels.opened.lock().unwrap().len(), opened + 1, "the main Session reopened once");
    // Saving again as it is reopens nothing.
    f.app.update_models(json!({"eval": {"provider": "anthropic", "model": "opus"}, "executor": {"provider": "fixture", "model": "big"}})).await.unwrap();
    assert_eq!(f.kernels.opened.lock().unwrap().len(), opened + 1);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn changes_general_settings_block_by_block() {
    let f = started().await;
    let view = f.app.general_view();
    assert_eq!((view["paused"].as_bool(), view["eval"]["mode"].as_str(), view["executor"]["maxWorkers"].as_u64()), (Some(false), Some("observe"), Some(3)));
    assert_eq!(view["limits"]["maxWorkers"], json!([1, 16]));
    assert_eq!(view["defaults"]["directory"], f.dir.join("state/work").display().to_string());
    assert_eq!(view["policy"]["sources"]["chat"]["allowed"][0]["id"], "web:local");
    assert!(view.get("models").is_none() && view.get("kernel").is_none());

    // One block replaces that block and leaves the others.
    let opened = f.kernels.opened.lock().unwrap().len();
    let view = f.app.update_general(json!({"executor": {"maxWorkers": 5, "blockedCommands": ["sudo", "shutdown"]}})).await.unwrap();
    assert_eq!((view["executor"]["maxWorkers"].as_u64(), view["executor"]["blockedCommands"].clone()), (Some(5), json!(["sudo", "shutdown"])));
    assert_eq!(view["eval"]["mode"], "observe");
    assert_eq!(f.app.settings().executor.max_workers, 5);
    // The main Session reads the environment from its prompt, so it was composed anew.
    let specs = f.kernels.opened.lock().unwrap().clone();
    assert_eq!(specs.len(), opened + 1);
    assert!(specs.last().unwrap().system_prompt.contains("sudo shutdown"));

    let rules = json!([{"id": "docs", "name": "Docs", "enabled": true, "instruction": "Fix documentation typos when asked."}]);
    let view = f
        .app
        .update_general(json!({"policy": {"rules": rules, "sources": view["policy"]["sources"]}, "eval": {"mode": "auto", "timeoutSeconds": 60}}))
        .await
        .unwrap();
    assert_eq!((view["policy"]["rules"].clone(), view["eval"]["mode"].as_str(), view["eval"]["timeoutSeconds"].as_u64()), (rules, Some("auto"), Some(60)));
    assert!(f.kernels.opened.lock().unwrap().last().unwrap().system_prompt.contains("Fix documentation typos when asked."));
    assert_eq!(f.app.settings().executor.max_workers, 5);

    // Refusals say why and change nothing.
    let refused = |value: Value| {
        let app = f.app.clone();
        async move { app.update_general(value).await.unwrap_err() }
    };
    assert!(refused(json!({"executor": {"maxWorkers": 99}})).await.contains("1 to 16"));
    assert!(refused(json!({"kernel": "claude"})).await.starts_with("Unknown field kernel"));
    assert!(refused(json!({"executor": {"workers": 2}})).await.contains("unknown field"));
    assert_eq!(refused(json!({})).await, "Send at least one of paused, eval, executor, policy");
    assert_eq!(refused(json!("paused")).await, "Expected a JSON object");
    assert_eq!(f.app.settings().executor.max_workers, 5);

    // The pause holds work, and lifting it lets it go on.
    let opened = f.kernels.opened.lock().unwrap().len();
    assert_eq!(f.app.update_general(json!({"paused": true})).await.unwrap()["paused"], true);
    assert_eq!(f.kernels.opened.lock().unwrap().len(), opened, "a pause changes no prompt");
    f.app.receive_web("Please fix the typo in the fixture.", vec![], None).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(f.tickets().is_empty() && f.app.health_view()["paused"] == true);
    f.app.update_general(json!({"paused": false})).await.unwrap();
    f.until("the work is done", || f.chat().len() >= 3).await;
    f.settle().await;
    assert_eq!(f.tickets().len(), 1);

    // What was saved is there after a restart.
    let f = f.restart().await;
    let view = f.app.general_view();
    assert_eq!(
        (view["executor"]["maxWorkers"].as_u64(), view["eval"]["mode"].as_str(), view["policy"]["rules"][0]["id"].as_str()),
        (Some(5), Some("auto"), Some("docs"))
    );
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn imports_oh_my_pi_providers_once_and_keeps_keys_out_of_settings() {
    let f = fixture().await;
    let imported: neo_app::providers::Provider = serde_json::from_value(json!({
        "name": "local", "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/v1",
        "models": [{"id": "big"}], "kernels": ["omp", "hermes"]
    }))
    .unwrap();
    *f.kernels.importable.lock().unwrap() = vec![(imported, Some("sk-imported-0001".into()))];
    f.app.start().await.unwrap();
    // The first start imports Oh My Pi's providers and hands them, with their keys, to the kernels.
    let view = f.app.providers_view();
    assert_eq!(view["providers"][0]["name"], "local");
    assert_eq!(view["providers"][0]["key"], "…0001");
    assert_eq!(view["serves"]["claude"], json!(["anthropic-messages"]));
    assert_eq!(f.kernels.providers.lock().unwrap()[0].key.as_deref(), Some("sk-imported-0001"));
    // Renaming keeps the key; a new provider defaults to every kernel that speaks its API.
    let view = f
        .app
        .update_providers(json!({"providers": [
            {"name": "renamed", "previousName": "local", "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/v1", "models": [{"id": "big"}], "kernels": ["omp"]},
            {"name": "anth", "api": "anthropic-messages", "baseUrl": "https://example.com", "models": [{"id": "m", "name": "M"}], "apiKey": "sk-new-key-0002"}
        ]}))
        .await
        .unwrap();
    assert_eq!(view["providers"][0]["key"], "…0001");
    assert_eq!(view["providers"][1]["kernels"], json!(["omp", "claude", "hermes"]));
    let settings = serde_json::to_string(&*f.app.settings()).unwrap();
    assert!(!settings.contains("sk-") && settings.contains("renamed"), "{settings}");
    // A provider that does not check out changes nothing.
    assert!(f
        .app
        .update_providers(json!({"providers": [{"name": "x", "api": "openai-completions", "baseUrl": "ftp://x", "models": [], "apiKey": null}]}))
        .await
        .is_err());
    assert_eq!(f.app.providers_view()["providers"].as_array().unwrap().len(), 2);
    // Clearing a key takes it away; importing again adds only what is missing.
    f.app.update_providers(json!({"providers": [{"name": "renamed", "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/v1", "models": [{"id": "big"}], "apiKey": null}]})).await.unwrap();
    assert_eq!(f.kernels.providers.lock().unwrap()[0].key, None);
    let view = f.app.import_providers().await.unwrap();
    assert_eq!((view["imported"].as_u64(), view["providers"].as_array().unwrap().len()), (Some(1), 2));
    assert_eq!(view["providers"][1]["key"], "…0001");
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_each_providers_models_over_its_own_api() {
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    let server = neo_testkit::http::serve(move |request| {
        log.lock().unwrap().push((request.path.clone(), request.headers.get("authorization").cloned()));
        neo_testkit::http::Response::json(
            200,
            &json!({"object": "list", "data": [{"id": "big", "display_name": "Big", "context_window": 1000}, {"id": "small"}]}),
        )
    })
    .await;
    let f = started().await;
    // A new provider is asked for its models when saved; nobody types them.
    let view = f
        .app
        .update_providers(
            json!({"providers": [{"name": "listed", "api": "openai-completions", "baseUrl": format!("{}/v1", server.url()), "apiKey": "sk-listed"}]}),
        )
        .await
        .unwrap();
    let models = &view["providers"][0]["models"];
    assert_eq!(
        models,
        &json!([{"id": "big", "name": "Big", "reasoning": false, "images": false, "contextWindow": 1000}, {"id": "small", "reasoning": false, "images": false}])
    );
    assert_eq!(view["providers"][0]["listsModels"], true);
    assert_eq!(seen.lock().unwrap()[0], ("/v1/models".to_string(), Some("Bearer sk-listed".to_string())));
    assert_eq!(f.kernels.providers.lock().unwrap()[0].provider.models.len(), 2);
    // One that cannot be reached keeps its models and says why.
    let view = f
        .app
        .update_providers(
            json!({"providers": [{"name": "listed", "api": "openai-completions", "baseUrl": "http://127.0.0.1:9/v1", "models": [{"id": "kept"}]}]}),
        )
        .await
        .unwrap();
    assert_eq!(view["providers"][0]["models"][0]["id"], "kept");
    assert!(view["providers"][0]["modelsProblem"].as_str().unwrap().contains("cannot list models"), "{view}");
    f.app.stop().await;
}
