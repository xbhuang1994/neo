//! The chat Source: messages typed into the app or the web page, and from a bound WeChat account, as Triggers; replies
//! go back to the conversation they came from.

use crate::app::App;
use crate::outbox::Sent;
use crate::sessions::ChatAttachment;
use crate::settings::{CHAT_SOURCE, WEB_SENDER, WEB_THREAD};
use neo_core::ids::key;
use neo_core::model::{ActorRef, Addressed, ChannelRef, Json, ThreadRef, Trigger};
use neo_core::ports::OutboundMessage;
use neo_core::time::now_iso;
use neo_core::ReceiveResult;
use neo_kernel::types::uuid;
use std::sync::Arc;

/// A chat message to take in.
#[derive(Clone, Debug)]
pub struct ChatInput {
    /// `web` or `wechat`.
    pub surface: &'static str,
    /// The sender's idempotency key: the same id is one message, however often it is sent.
    pub message_id: String,
    /// Who wrote it.
    pub sender: String,
    /// The conversation it belongs to.
    pub conversation: String,
    /// What it says.
    pub text: String,
    /// Files attached to it.
    pub attachments: Vec<ChatAttachment>,
    /// When it was written, when the surface knows.
    pub at: Option<String>,
}

/// What became of a chat message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatReceipt {
    /// Its entry in the chat transcript.
    pub request_id: String,
    /// Its Trigger.
    pub trigger_id: String,
    /// Whether it was stored, a duplicate, or filtered.
    pub result: ReceiveResult,
}

fn valid_message_id(id: &str) -> bool {
    (3..=200).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'.' | b'-'))
}

impl App {
    /// A message typed into the app or the web page.
    pub async fn receive_web(self: &Arc<Self>, text: &str, attachments: Vec<ChatAttachment>, message_id: Option<String>) -> Result<ChatReceipt, String> {
        let message_id = message_id.unwrap_or_else(|| format!("web:{}", uuid()));
        self.receive_chat(ChatInput {
            surface: "web",
            message_id,
            sender: WEB_SENDER.into(),
            conversation: WEB_THREAD.into(),
            text: text.to_string(),
            attachments,
            at: None,
        })
        .await
    }

    /// A message from the bound WeChat user.
    pub async fn receive_wechat(
        self: &Arc<Self>,
        user_id: &str,
        message_id: &str,
        text: &str,
        attachments: Vec<ChatAttachment>,
        at: Option<String>,
    ) -> Result<ChatReceipt, String> {
        let party = format!("wechat:{user_id}");
        self.receive_chat(ChatInput {
            surface: "wechat",
            message_id: message_id.to_string(),
            sender: party.clone(),
            conversation: party,
            text: text.to_string(),
            attachments,
            at,
        })
        .await
    }

    /// Show a chat message in the transcript and take it in as a Trigger, once per message id.
    pub async fn receive_chat(self: &Arc<Self>, input: ChatInput) -> Result<ChatReceipt, String> {
        if !valid_message_id(&input.message_id) {
            return Err("Invalid chat message ID".into());
        }
        if input.sender.is_empty() || input.conversation.is_empty() {
            return Err("Chat sender and conversation are required".into());
        }
        let request_id = format!("chat:{}", input.message_id);
        let presented = self.present_chat(&input.text, &input.attachments, &request_id, if input.surface == "web" { "web-panel" } else { "wechat" }).await?;
        let trigger_id = key(&["trigger", CHAT_SOURCE, &input.message_id]);
        let mut meta = Json::new();
        for (name, value) in [
            ("kind", "chat"),
            ("messageId", input.message_id.as_str()),
            ("originalText", input.text.as_str()),
            ("surface", input.surface),
            ("conversation", input.conversation.as_str()),
        ] {
            meta.insert(name.into(), value.into());
        }
        let address = [("surface", input.surface), ("conversation", input.conversation.as_str()), ("sender", input.sender.as_str())]
            .into_iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        let trigger = Trigger {
            id: trigger_id.clone(),
            source: CHAT_SOURCE.into(),
            threads: vec![ThreadRef { source: CHAT_SOURCE.into(), id: input.conversation.clone() }],
            actor: ActorRef { source: CHAT_SOURCE.into(), id: input.sender.clone() },
            human: true,
            addressed: Some(Addressed::Direct),
            at: input.at.unwrap_or_else(now_iso),
            text: presented,
            channel: Some(ChannelRef { source: CHAT_SOURCE.into(), thread: input.conversation.clone(), address }),
            url: None,
            meta,
        };
        let result = self.passes.receive(trigger).map_err(|error| error.message)?;
        Ok(ChatReceipt { request_id, trigger_id, result })
    }

    /// Send a reply to the conversation its Channel names: the chat transcript, and for a WeChat conversation the
    /// bound account too. The message id makes both idempotent.
    pub(crate) async fn chat_send(self: &Arc<Self>, message: &OutboundMessage) -> Result<Sent, String> {
        let part = |name: &str| message.channel.address.get(name).map(String::as_str).unwrap_or("");
        let (surface, conversation, sender) = (part("surface"), part("conversation"), part("sender"));
        let request_id = format!("chat-reply:{}", message.id);
        if surface == "web" && conversation == WEB_THREAD && sender == WEB_SENDER {
            self.publish(&request_id, &message.text).await?;
            return Ok(Sent::Sent);
        }
        if let Some(user_id) = sender.strip_prefix("wechat:").filter(|_| surface == "wechat" && conversation == sender) {
            self.publish(&request_id, &message.text).await?;
            return self.wechat_deliver(&message.id, &message.text, user_id).await;
        }
        Ok(Sent::Gone)
    }
}

#[cfg(test)]
mod tests {
    use super::valid_message_id;

    #[test]
    fn takes_message_ids_of_word_characters_colons_dots_and_dashes() {
        for good in ["web:abc", "a-b.c_d:1", &"x".repeat(200)] {
            assert!(valid_message_id(good), "{good}");
        }
        for bad in ["ab", "has space", "斜杠", "a/b", &"x".repeat(201)] {
            assert!(!valid_message_id(bad), "{bad}");
        }
    }
}
