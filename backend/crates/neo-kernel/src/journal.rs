//! The file-backed transcript of one Session, for either kernel: what people see, what the model was or will be
//! shown, and the idempotency record of every delivery.
//!
//! One JSON value per line. An entry is visible once appended and durable after [`Journal::flush`]. A delivery meant
//! for the model is marked *pending* when appended and *taken* once the runtime took it into a step; whatever is still
//! pending when a runtime process starts is sent again, so the model sees every delivery at least once.

use crate::types::{uuid, Block, Message};
use neo_core::time::now_iso;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The custom type of every entry the application writes.
pub const CUSTOM_TYPE: &str = "neo-agent";
/// Chat transcript sources the app shows.
pub const VISIBLE_SOURCES: &[&str] = &["web-panel", "wechat", "chat-reply"];

/// One transcript entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Entry {
    /// Something the model or a tool said.
    Message {
        /// The entry's id.
        id: String,
        /// When it was appended.
        timestamp: String,
        /// The message.
        message: Message,
    },
    /// Something the application put into the Session: a delivery, a notice, or a chat message.
    CustomMessage {
        /// The entry's id.
        id: String,
        /// When it was appended.
        timestamp: String,
        /// Always [`CUSTOM_TYPE`] for entries this application writes.
        custom_type: String,
        /// What it says.
        content: Vec<Block>,
        /// Whether people see it in the transcript.
        display: bool,
        /// `requestId`, `source`, `inputIds` and `attachments`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
        /// `agent` or `user`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attribution: Option<String>,
    },
}

impl Entry {
    /// The entry's id.
    pub fn id(&self) -> &str {
        match self {
            Entry::Message { id, .. } | Entry::CustomMessage { id, .. } => id,
        }
    }
    /// When it was appended.
    pub fn timestamp(&self) -> &str {
        match self {
            Entry::Message { timestamp, .. } | Entry::CustomMessage { timestamp, .. } => timestamp,
        }
    }
    fn detail(&self, name: &str) -> Option<&Value> {
        match self {
            Entry::CustomMessage { details: Some(details), .. } => details.get(name),
            _ => None,
        }
    }
    /// The request id of a delivery.
    pub fn request_id(&self) -> Option<&str> {
        self.detail("requestId").and_then(Value::as_str)
    }
    /// The chat source of an entry.
    pub fn source(&self) -> Option<&str> {
        self.detail("source").and_then(Value::as_str)
    }
    /// The ticket Inputs a delivery carries.
    pub fn input_ids(&self) -> Vec<String> {
        self.detail("inputIds").and_then(Value::as_array).map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect()).unwrap_or_default()
    }
}

/// A delivery the model has not been shown yet.
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    /// The entry.
    pub entry: Entry,
    /// It asks for a turn, rather than waiting for the next one.
    pub trigger: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum Mark {
    Header { id: String, cwd: String, timestamp: String },
    KernelSession { kernel: String, id: String },
    Name { name: String },
    Pending { id: String, trigger: bool },
    Taken { ids: Vec<String> },
}

struct Inner {
    file: File,
    entries: Vec<Entry>,
    /// Index into `entries` by entry id.
    id_index: HashMap<String, usize>,
    /// Index into `entries` by delivery request id.
    request_index: HashMap<String, usize>,
    /// Entry ids the model has not been shown, in order, with whether each asks for a turn.
    pending: Vec<(String, bool)>,
    sessions: Vec<(String, String)>,
    name: Option<String>,
    failure: Option<io::Error>,
}

/// Append-only transcript of one Session.
pub struct Journal {
    path: PathBuf,
    inner: Mutex<Inner>,
}

#[cfg(unix)]
fn private(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}
#[cfg(not(unix))]
fn private(_options: &mut OpenOptions) {}

impl Journal {
    /// Start a new transcript file in `dir` for a Session working in `cwd`.
    pub fn create(dir: &Path, cwd: &Path) -> io::Result<Journal> {
        std::fs::create_dir_all(dir)?;
        let id = uuid();
        let stamp: String = now_iso().chars().map(|c| if c == ':' || c == '.' { '-' } else { c }).collect();
        let path = dir.join(format!("{stamp}_{id}.jsonl"));
        let mut options = OpenOptions::new();
        options.create_new(true).append(true);
        private(&mut options);
        let file = options.open(&path)?;
        let journal = Journal {
            path,
            inner: Mutex::new(Inner {
                file,
                entries: Vec::new(),
                id_index: HashMap::new(),
                request_index: HashMap::new(),
                pending: Vec::new(),
                sessions: Vec::new(),
                name: None,
                failure: None,
            }),
        };
        journal.write(&Mark::Header { id, cwd: cwd.display().to_string(), timestamp: now_iso() });
        journal.flush()?;
        Ok(journal)
    }

    /// Open an existing transcript. A line that does not parse, such as one cut off by a crash, is skipped.
    pub fn open(path: &Path) -> io::Result<Journal> {
        let mut inner = Inner {
            file: OpenOptions::new().append(true).open(path)?,
            entries: Vec::new(),
            id_index: HashMap::new(),
            request_index: HashMap::new(),
            pending: Vec::new(),
            sessions: Vec::new(),
            name: None,
            failure: None,
        };
        let mut header = false;
        let mut reader = File::open(path)?;
        for line in BufReader::new(&reader).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(entry) = serde_json::from_str::<Entry>(&line) {
                let index = inner.entries.len();
                inner.id_index.entry(entry.id().to_string()).or_insert(index);
                if let Some(request_id) = entry.request_id() {
                    inner.request_index.entry(request_id.to_string()).or_insert(index);
                }
                inner.entries.push(entry);
                continue;
            }
            match serde_json::from_str::<Mark>(&line) {
                Ok(Mark::Header { .. }) => header = true,
                Ok(Mark::KernelSession { kernel, id }) => {
                    inner.sessions.retain(|(known, _)| *known != kernel);
                    inner.sessions.push((kernel, id));
                }
                Ok(Mark::Name { name }) => inner.name = Some(name),
                Ok(Mark::Pending { id, trigger }) => {
                    if !inner.pending.iter().any(|(known, _)| *known == id) {
                        inner.pending.push((id, trigger));
                    }
                }
                Ok(Mark::Taken { ids }) => inner.pending.retain(|(id, _)| !ids.contains(id)),
                Err(_) => {}
            }
        }
        if !header {
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("{} is not a session transcript of this program", path.display())));
        }
        // A crash can leave the last line without its newline; the next append must start a new line.
        if reader.metadata()?.len() > 0 {
            reader.seek(SeekFrom::End(-1))?;
            let mut last = [0u8; 1];
            reader.read_exact(&mut last)?;
            if last[0] != b'\n' {
                inner.file.write_all(b"\n")?;
            }
        }
        Ok(Journal { path: path.to_path_buf(), inner: Mutex::new(inner) })
    }

    /// The transcript's file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_line(inner: &mut Inner, line: &impl Serialize) {
        let mut text = serde_json::to_string(line).expect("transcript lines serialize");
        text.push('\n');
        if let Err(error) = inner.file.write_all(text.as_bytes()) {
            inner.failure.get_or_insert(error);
        }
    }
    fn write(&self, mark: &Mark) {
        Self::write_line(&mut self.inner(), mark);
    }

    /// Every entry, oldest first.
    pub fn entries(&self) -> Vec<Entry> {
        self.inner().entries.clone()
    }
    /// How many entries there are.
    pub fn len(&self) -> usize {
        self.inner().entries.len()
    }
    /// Whether the transcript has no entries.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// The entries from position `from` on.
    pub fn entries_from(&self, from: usize) -> Vec<Entry> {
        self.inner().entries.iter().skip(from).cloned().collect()
    }
    /// The last `count` entries together with their starting index in the transcript.
    pub fn entries_tail(&self, count: usize) -> (usize, Vec<Entry>) {
        let inner = self.inner();
        let start = inner.entries.len().saturating_sub(count);
        (start, inner.entries[start..].to_vec())
    }
    /// Look up the request ids carried by the entries with these ids, in entry order.
    pub fn request_ids_for(&self, entry_ids: &[String]) -> Vec<String> {
        let inner = self.inner();
        let mut indices: Vec<usize> = entry_ids.iter().filter_map(|id| inner.id_index.get(id).copied()).collect();
        indices.sort_unstable();
        indices.dedup();
        indices.into_iter().filter_map(|index| inner.entries.get(index).and_then(|entry| entry.request_id()).map(str::to_string)).collect()
    }
    /// Whether a delivery with this request id was appended.
    pub fn has_request(&self, request_id: &str) -> bool {
        self.inner().request_index.contains_key(request_id)
    }
    /// The entry of a delivery.
    pub fn request(&self, request_id: &str) -> Option<Entry> {
        let inner = self.inner();
        inner.request_index.get(request_id).and_then(|&index| inner.entries.get(index)).cloned()
    }

    /// Append what the application puts into the Session. With `pending`, the model is shown it: on a turn it asks
    /// for (`Some(true)`), or on the next turn something else starts (`Some(false)`).
    pub fn append_custom(&self, content: Vec<Block>, display: bool, details: Option<Value>, attribution: Option<&str>, pending: Option<bool>) -> Entry {
        let entry = Entry::CustomMessage {
            id: uuid(),
            timestamp: now_iso(),
            custom_type: CUSTOM_TYPE.to_string(),
            content,
            display,
            details,
            attribution: attribution.map(str::to_string),
        };
        let mut inner = self.inner();
        Self::write_line(&mut inner, &entry);
        if let Some(trigger) = pending {
            inner.pending.push((entry.id().to_string(), trigger));
            Self::write_line(&mut inner, &Mark::Pending { id: entry.id().to_string(), trigger });
        }
        let index = inner.entries.len();
        inner.id_index.entry(entry.id().to_string()).or_insert(index);
        if let Some(request_id) = entry.request_id() {
            inner.request_index.entry(request_id.to_string()).or_insert(index);
        }
        inner.entries.push(entry.clone());
        entry
    }

    /// Append something the model or a tool said.
    pub fn append_message(&self, message: Message) -> Entry {
        let entry = Entry::Message { id: uuid(), timestamp: now_iso(), message };
        let mut inner = self.inner();
        Self::write_line(&mut inner, &entry);
        let index = inner.entries.len();
        inner.id_index.entry(entry.id().to_string()).or_insert(index);
        inner.entries.push(entry.clone());
        entry
    }

    /// The deliveries the model has not been shown, in order.
    pub fn pending(&self) -> Vec<Pending> {
        let inner = self.inner();
        inner
            .pending
            .iter()
            .filter_map(|(id, trigger)| {
                inner.id_index.get(id).and_then(|&index| inner.entries.get(index)).map(|entry| Pending { entry: entry.clone(), trigger: *trigger })
            })
            .collect()
    }
    /// Whether an entry still waits to be shown to the model.
    pub fn is_pending(&self, entry_id: &str) -> bool {
        self.inner().pending.iter().any(|(id, _)| id == entry_id)
    }
    /// Record that the runtime took these entries into a step.
    pub fn mark_taken(&self, ids: &[String]) {
        let mut inner = self.inner();
        let before = inner.pending.len();
        inner.pending.retain(|(id, _)| !ids.contains(id));
        if inner.pending.len() != before {
            Self::write_line(&mut inner, &Mark::Taken { ids: ids.to_vec() });
        }
    }

    /// The runtime session id recorded for a kernel, which resumes its context.
    pub fn kernel_session(&self, kernel: &str) -> Option<String> {
        self.inner().sessions.iter().find(|(known, _)| known == kernel).map(|(_, id)| id.clone())
    }
    /// Record a kernel's runtime session id.
    pub fn set_kernel_session(&self, kernel: &str, id: &str) {
        let mut inner = self.inner();
        if inner.sessions.iter().any(|(known, current)| known == kernel && current == id) {
            return;
        }
        inner.sessions.retain(|(known, _)| known != kernel);
        inner.sessions.push((kernel.to_string(), id.to_string()));
        Self::write_line(&mut inner, &Mark::KernelSession { kernel: kernel.to_string(), id: id.to_string() });
    }
    /// The Session's display name.
    pub fn name(&self) -> Option<String> {
        self.inner().name.clone()
    }
    /// Record the Session's display name.
    pub fn set_name(&self, name: &str) {
        let mut inner = self.inner();
        if inner.name.as_deref() == Some(name) {
            return;
        }
        inner.name = Some(name.to_string());
        Self::write_line(&mut inner, &Mark::Name { name: name.to_string() });
    }

    /// The visible chat transcript: what the app shows.
    pub fn chat(&self) -> Vec<Entry> {
        self.inner().entries.iter().filter(|entry| entry.source().is_some_and(|source| VISIBLE_SOURCES.contains(&source))).cloned().collect()
    }
    /// The text of the model's latest message.
    pub fn last_assistant_text(&self) -> Option<String> {
        self.inner().entries.iter().rev().find_map(|entry| match entry {
            Entry::Message { message, .. } if message.role == crate::types::Role::Assistant => {
                Some(crate::types::text_of(&message.content)).filter(|text| !text.is_empty())
            }
            _ => None,
        })
    }
    /// Why the model's latest message stopped.
    pub fn last_stop_reason(&self) -> Option<String> {
        self.inner().entries.iter().rev().find_map(|entry| match entry {
            Entry::Message { message, .. } if message.role == crate::types::Role::Assistant => Some(message.stop_reason.clone().unwrap_or_default()),
            _ => None,
        })
    }

    /// Make everything appended so far durable.
    pub fn flush(&self) -> io::Result<()> {
        let mut inner = self.inner();
        if let Some(error) = inner.failure.take() {
            return Err(error);
        }
        inner.file.sync_data()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Role;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("neo-journal-{name}-{}-{}", std::process::id(), uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn keeps_entries_marks_and_pending_deliveries_across_reopening() {
        let dir = temp("reopen");
        let path = {
            let journal = Journal::create(&dir, Path::new("/work")).unwrap();
            journal.set_name("Fix typo");
            journal.set_kernel_session("claude", "c-1");
            journal.set_kernel_session("omp", "/sessions/o.jsonl");
            journal.set_kernel_session("claude", "c-2");
            let chat = journal.append_custom(vec![Block::text("hello")], true, Some(json!({"requestId": "chat:1", "source": "web-panel"})), Some("user"), None);
            let relay = journal.append_custom(
                vec![Block::text("candidate")],
                false,
                Some(json!({"requestId": "r1", "inputIds": ["i1", "i2"]})),
                Some("agent"),
                Some(true),
            );
            let notice = journal.append_custom(vec![Block::text("notice")], false, Some(json!({"requestId": "n1"})), None, Some(false));
            journal.append_message(Message { role: Role::Assistant, content: vec![Block::text("On it")], stop_reason: Some("stop".into()) });
            assert_eq!(
                journal.pending().iter().map(|p| (p.entry.request_id().unwrap().to_string(), p.trigger)).collect::<Vec<_>>(),
                vec![("r1".into(), true), ("n1".into(), false)]
            );
            journal.mark_taken(&[relay.id().to_string()]);
            assert!(!journal.is_pending(relay.id()) && journal.is_pending(notice.id()) && !journal.is_pending(chat.id()));
            assert_eq!(relay.input_ids(), vec!["i1", "i2"]);
            journal.flush().unwrap();
            journal.path().to_path_buf()
        };
        let journal = Journal::open(&path).unwrap();
        assert_eq!(journal.len(), 4);
        assert_eq!(journal.name().as_deref(), Some("Fix typo"));
        assert_eq!(
            (journal.kernel_session("claude").as_deref(), journal.kernel_session("omp").as_deref(), journal.kernel_session("x")),
            (Some("c-2"), Some("/sessions/o.jsonl"), None)
        );
        assert!(journal.has_request("chat:1") && journal.has_request("r1") && !journal.has_request("missing"));
        assert_eq!(journal.request("r1").unwrap().request_id(), Some("r1"));
        assert!(journal.request("missing").is_none());
        assert_eq!(journal.pending().iter().map(|p| p.entry.request_id().unwrap().to_string()).collect::<Vec<_>>(), vec!["n1"]);
        assert_eq!(journal.chat().iter().map(|entry| entry.request_id().unwrap().to_string()).collect::<Vec<_>>(), vec!["chat:1"]);
        assert_eq!(journal.last_assistant_text().as_deref(), Some("On it"));
        assert_eq!(journal.last_stop_reason().as_deref(), Some("stop"));
        assert_eq!(journal.entries_from(3).len(), 1);
        let (tail_start, tail) = journal.entries_tail(2);
        assert_eq!(tail_start, 2);
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].request_id(), Some("n1"));
        let all = journal.entries();
        assert_eq!(journal.request_ids_for(&[all[2].id().to_string(), all[0].id().to_string(), all[3].id().to_string()]), vec!["chat:1", "n1"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn survives_a_line_cut_off_by_a_crash_and_refuses_a_foreign_file() {
        let dir = temp("crash");
        let journal = Journal::create(&dir, Path::new("/work")).unwrap();
        journal.append_custom(vec![Block::text("kept")], true, Some(json!({"requestId": "a"})), None, None);
        journal.flush().unwrap();
        let path = journal.path().to_path_buf();
        drop(journal);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"type\":\"custom_message\",\"id\":\"cut").unwrap();
        drop(file);
        let journal = Journal::open(&path).unwrap();
        assert_eq!(journal.len(), 1);
        journal.append_custom(vec![Block::text("after")], true, Some(json!({"requestId": "b"})), None, None);
        journal.flush().unwrap();
        drop(journal);
        let journal = Journal::open(&path).unwrap();
        assert_eq!(journal.entries().iter().filter_map(|entry| entry.request_id().map(str::to_string)).collect::<Vec<_>>(), vec!["a", "b"]);
        let foreign = dir.join("other.jsonl");
        std::fs::write(&foreign, "{\"type\":\"session\"}\n").unwrap();
        assert!(Journal::open(&foreign).err().unwrap().to_string().contains("not a session transcript"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
