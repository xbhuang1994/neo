//! The kernel-neutral vocabulary: message content, session events, background jobs and host tools.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;

/// A boxed future, for object-safe async trait methods.
pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One block of message content.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Block {
    /// Text.
    Text {
        /// The text.
        text: String,
    },
    /// An image, base64-encoded.
    Image {
        /// Its media type, such as `image/png`.
        mime_type: String,
        /// Its bytes in base64.
        data: String,
    },
    /// A tool call the model made.
    ToolCall {
        /// The call's id.
        id: String,
        /// The tool's name.
        name: String,
        /// The arguments.
        arguments: Value,
    },
}

impl Block {
    /// A text block.
    pub fn text(text: impl Into<String>) -> Block {
        Block::Text { text: text.into() }
    }
}

/// The text of content blocks, joined by newlines.
pub fn text_of(content: &[Block]) -> String {
    content.iter().filter_map(|block| if let Block::Text { text } = block { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join("\n")
}

/// Who a transcript message is from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// The model.
    Assistant,
    /// A tool's result.
    ToolResult,
}

/// A model or tool message as the transcript keeps it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// Who it is from.
    pub role: Role,
    /// What it says.
    pub content: Vec<Block>,
    /// Why the model stopped: `stop`, `toolUse`, `length`, `error` or `aborted`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
}

/// What a Session reports to its subscribers.
#[derive(Clone, Debug, PartialEq)]
pub enum KernelEvent {
    /// A turn began.
    AgentStart,
    /// A turn ended. `terminal` is false while background work the turn started can still wake the Session.
    AgentEnd {
        /// Nothing the Session runs will wake it again.
        terminal: bool,
        /// Background jobs are still running and will wake it.
        awaiting_async: bool,
    },
    /// The runtime retries a failed model request.
    Retry,
    /// The model's runtime took these deliveries into a step, from which the model reads them.
    Taken {
        /// The request ids of the deliveries.
        request_ids: Vec<String>,
    },
    /// The model or a tool said something.
    Message(Message),
}

/// What a background job is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    /// A shell command.
    Bash,
    /// A subagent.
    Task,
    /// Something else the runtime runs.
    Eval,
}

/// A background job of a Session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KernelJob {
    /// The runtime's id for it.
    pub id: String,
    /// What it is.
    pub kind: JobKind,
    /// What it shows as.
    pub label: String,
    /// When it started, in epoch milliseconds.
    pub start_time: i64,
    /// Its latest progress, in words.
    pub progress: Option<String>,
    /// For a shell command: the command line.
    pub command: Option<String>,
    /// The Session's own job rather than a subagent's.
    pub own: bool,
    /// The process ids the runtime reports for it; empty when it reports none.
    pub pids: Vec<u32>,
}

/// How a message joins a busy Session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deliver {
    /// At the running turn's next tool boundary.
    Steer,
    /// After the running turn finishes.
    FollowUp,
}

/// A tool the host offers the model.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolSpec {
    /// The tool's name.
    pub name: String,
    /// What it does, for the model.
    pub description: String,
    /// Its parameters, as a JSON Schema object.
    pub schema: Value,
}

/// What a tool-call guard decides.
#[derive(Clone, Debug, PartialEq)]
pub enum Guard {
    /// Let it run.
    Allow,
    /// Refuse it, with why.
    Block(String),
}

/// The host's side of a Session: the tools it offers and the guard on every tool call.
pub trait ToolHost: Send + Sync {
    /// The tools offered to this Session's model.
    fn specs(&self) -> Vec<ToolSpec>;
    /// Run a tool; the value is returned to the model as JSON, an error as a tool error.
    fn call<'a>(&'a self, name: &'a str, arguments: Value) -> BoxFut<'a, Result<Value, String>>;
    /// Judge a tool call, built-in or the host's own, before it runs.
    fn guard<'a>(&'a self, _tool: &'a str, _input: &'a Value) -> BoxFut<'a, Guard> {
        Box::pin(async { Guard::Allow })
    }
}

/// A random version 4 UUID.
pub fn uuid() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the system provides randomness");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_distinct_well_formed_uuids() {
        let (a, b) = (uuid(), uuid());
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert_eq!(a.as_bytes()[14], b'4');
        assert!(matches!(a.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }

    #[test]
    fn keeps_the_stored_shape_of_content_blocks() {
        let blocks = vec![
            Block::text("hi"),
            Block::Image { mime_type: "image/png".into(), data: "AAAA".into() },
            Block::ToolCall { id: "c1".into(), name: "bash".into(), arguments: serde_json::json!({"command": "ls"}) },
        ];
        let stored = serde_json::to_value(&blocks).unwrap();
        assert_eq!(
            stored,
            serde_json::json!([{"type": "text", "text": "hi"}, {"type": "image", "mimeType": "image/png", "data": "AAAA"}, {"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "ls"}}])
        );
        assert_eq!(serde_json::from_value::<Vec<Block>>(stored).unwrap(), blocks);
        assert_eq!(text_of(&blocks), "hi");
    }
}
