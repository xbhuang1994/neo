//! The Sidecar: a read-only answer about an existing ticket (its progress, findings or a comparison) on a one-off
//! Session, without waking or interrupting the ticket's worker.

use crate::app::App;
use crate::cards::ticket_card;
use crate::effects::Failure;
use crate::kernels::SessionRole;
use crate::notices::receipt_notice;
use crate::prompts::sidecar_prompt;
use crate::sessions::OnceTools;
use crate::text::{checked_im_text, clip, word_count, IM_WORDS};
use neo_core::ports::Repositories;
use neo_core::replies::{Purpose, ReplyRequest};
use neo_kernel::types::ToolSpec;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const REPORT_EXCERPT_CHARS: usize = 4000;
const SUBDIRS_TO_LIST: &[&str] = &["docs", "results", "out", "run"];

/// The files a person may ask about: the top of the ticket's directory and a few of its usual result folders.
fn deliverables(directory: &Path) -> Vec<String> {
    let names = |dir: &Path| -> Vec<(String, bool)> {
        let mut found: Vec<(String, bool)> = std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| (entry.file_name().to_string_lossy().to_string(), entry.path().is_dir()))
                    .filter(|(name, _)| !name.starts_with('.'))
                    .collect()
            })
            .unwrap_or_default();
        found.sort();
        found
    };
    let top = names(directory);
    let mut files: Vec<String> = top.iter().map(|(name, is_dir)| if *is_dir { format!("{name}/") } else { name.clone() }).collect();
    for sub in SUBDIRS_TO_LIST {
        if top.iter().any(|(name, is_dir)| *is_dir && name == sub) {
            files.extend(names(&directory.join(sub)).into_iter().take(12).map(|(name, is_dir)| format!("{sub}/{name}{}", if is_dir { "/" } else { "" })));
        }
    }
    files.truncate(40);
    files
}

/// What to send when the model answered in text instead of calling its reply tool.
fn fallback_reply(raw: &str) -> String {
    let cleaned = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return "当前工单暂无更多补充结论，请稍后再试。".into();
    }
    if word_count(&cleaned) <= IM_WORDS {
        return cleaned;
    }
    let mut keep = 240;
    while keep > 20 && word_count(&format!("{}…", clip(&cleaned, keep))) > IM_WORDS {
        keep -= 10;
    }
    format!("{}…", clip(&cleaned, keep))
}

impl App {
    /// Answer a person's read-only question about a ticket, straight to their conversation.
    pub(crate) async fn sidecar_queued(self: Arc<Self>, payload: Value) -> Result<(), Failure> {
        if self.closing() || self.paused() {
            return Err(Failure::Later("Sidecar is paused or stopping".into()));
        }
        let (Some(ticket_id), Some(trigger_id)) = (payload["ticketId"].as_str(), payload["triggerId"].as_str()) else { return Ok(()) };
        let (Some(ticket), Some(trigger)) = (self.store_ticket(ticket_id), self.store.trigger(trigger_id)) else { return Ok(()) };
        if !trigger.human || trigger.channel.is_none() {
            return Ok(());
        }
        let batch: Vec<String> =
            payload["batchIds"].as_array().map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let ids = if batch.is_empty() { vec![trigger_id.to_string()] } else { batch };
        let questions: Vec<Value> =
            ids.iter().filter_map(|id| self.store.trigger(id)).map(|item| json!({"trigger_id": item.id, "at": item.at, "text": item.text})).collect();
        let directory = ticket.execution.as_ref().map(|execution| PathBuf::from(&execution.directory)).filter(|directory| directory.is_dir());
        let mut packet = json!({
            "questions": questions,
            "ticket": ticket_card(&ticket),
            "directory": directory.as_ref().map(|directory| directory.display().to_string()),
            "running_jobs": self.running_jobs(ticket_id).await,
            "latest_report": ticket.latest_report().map(|report| json!({"state": report.state, "at": report.at, "summary": clip(&report.summary, REPORT_EXCERPT_CHARS),
                "truncated": report.summary.chars().count() > REPORT_EXCERPT_CHARS})),
            "workspace_files": directory.as_deref().map(deliverables).unwrap_or_default(),
        });
        if let Some(note) = payload["note"].as_str() {
            packet["routing_note"] = note.into();
        }
        let replied: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let answer = {
            let (app, trigger_id, replied) = (self.weak.clone(), trigger_id.to_string(), replied.clone());
            move |text: String| -> Result<String, String> {
                let app = app.upgrade().ok_or("neo-agent is stopping")?;
                let reply = app
                    .engine
                    .reply(ReplyRequest { purpose: Purpose::Answer, ticket_id: None, trigger_id: Some(trigger_id.clone()), question: None, text: text.clone() })
                    .map_err(|error| error.message)?;
                *replied.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(text);
                Ok(reply.id)
            }
        };
        let tool_answer = answer.clone();
        let tools = OnceTools {
            specs: vec![ToolSpec {
                name: "sidecar_reply".into(),
                description: format!("Send the concise read-only answer (at most {IM_WORDS} words) directly to the person's conversation."),
                schema: json!({"type": "object", "additionalProperties": false, "required": ["text"], "properties": {"text": {"type": "string", "description": format!("At most {IM_WORDS} words; Markdown is supported.")}}}),
            }],
            call: Box::new(move |name, arguments| {
                let answer = tool_answer.clone();
                Box::pin(async move {
                    if name != "sidecar_reply" {
                        return Err(format!("Unknown tool {name}"));
                    }
                    let text = arguments["text"].as_str().map(str::trim).filter(|text| !text.is_empty()).ok_or("text is required")?;
                    checked_im_text(text)?;
                    Ok(json!({"sent": true, "id": answer(text.to_string())?}))
                })
            }),
        };
        let cwd = directory.unwrap_or_else(|| self.machine.state_dir.clone());
        let said = self.run_once(SessionRole::Sidecar, &cwd, sidecar_prompt(), packet.to_string(), tools, Duration::from_secs(90)).await?;
        let sent = replied.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let sent = match sent {
            Some(text) => text,
            None => {
                let text = fallback_reply(&said);
                answer(text.clone())?;
                text
            }
        };
        self.outbox.sent().await;
        // The main Session hears of the answer without a turn of its own, so its memory of the conversation stays whole.
        self.notify(receipt_notice(json!({"sidecar_answered": {"ticket_id": ticket.id, "trigger_id": trigger_id, "answer": sent}})));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_a_short_answer_whole_and_cuts_a_long_one_to_the_limit() {
        assert_eq!(fallback_reply("  It  is\nrunning. "), "It is running.");
        assert_eq!(fallback_reply("   "), "当前工单暂无更多补充结论，请稍后再试。");
        let long = fallback_reply(&"进度正常 ".repeat(200));
        assert!(long.ends_with('…') && word_count(&long) <= IM_WORDS, "{} words", word_count(&long));
    }
}
