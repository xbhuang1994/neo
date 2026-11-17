//! Sessions: the main Session, one per ticket's worker, and one-off Sessions for the Sidecar and the Watchdog.

use crate::app::App;
use crate::effects::Failure;
use crate::kernels::{overrides_subagent, SessionRole, SessionSpec, MAX_SUBAGENTS};
use crate::prompts;
use crate::settings::{Kernel, RoleModel, Settings};
use neo_core::ids::key;
use neo_kernel::journal::{Entry, Journal};
use neo_kernel::session::{Mode, Presentation, Session};
use neo_kernel::types::{Block, BoxFut, Guard, JobKind, KernelEvent, ToolHost, ToolSpec};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::sync::broadcast;

/// A Session that is open.
pub struct Loaded {
    /// The Session.
    pub session: Arc<Session>,
    /// The kernel it was opened on; it stays there until it is closed.
    pub kernel: Kernel,
    /// What it is for.
    pub role: SessionRole,
    /// The ticket of a worker Session.
    pub ticket_id: Option<String>,
}

/// The open Sessions.
#[derive(Default)]
pub struct SessionsState {
    loaded: Mutex<HashMap<String, Arc<Loaded>>>,
    opening: tokio::sync::Mutex<()>,
}

/// The id of a ticket's worker Session.
pub fn worker_session_id(ticket_id: &str) -> String {
    format!("worker-{ticket_id}")
}

/// A file a person attached to a chat message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatAttachment {
    /// Its file name.
    pub name: String,
    /// Its media type, as the sender declared it.
    pub media_type: String,
    /// Its bytes.
    pub data: Vec<u8>,
}

/// The tools of one Session, served by the application.
struct SessionTools {
    app: Weak<App>,
    ticket_id: Option<String>,
    cwd: PathBuf,
}

impl ToolHost for SessionTools {
    fn specs(&self) -> Vec<ToolSpec> {
        match self.ticket_id {
            Some(_) => crate::tools::worker_specs(),
            None => crate::tools::main_specs(),
        }
    }
    fn call<'a>(&'a self, name: &'a str, arguments: Value) -> BoxFut<'a, Result<Value, String>> {
        Box::pin(async move {
            let app = self.app.upgrade().ok_or("neo-agent is stopping")?;
            match &self.ticket_id {
                Some(ticket_id) => app.worker_tool(ticket_id, name, arguments).await,
                None => app.main_tool(name, arguments).await,
            }
        })
    }
    fn guard<'a>(&'a self, tool: &'a str, _input: &'a Value) -> BoxFut<'a, Guard> {
        Box::pin(async move {
            let (Some(app), Some(ticket_id)) = (self.app.upgrade(), &self.ticket_id) else { return Guard::Allow };
            // A worker whose ticket ended does nothing more, whatever its model still tries.
            if !app.store_ticket(ticket_id).is_some_and(|ticket| ticket.live()) {
                return Guard::Block("Ticket ended; new work needs a new authorized ticket".into());
            }
            if tool == "Agent" || tool == "task" {
                if tool == "Agent" && overrides_subagent(&self.cwd) {
                    return Guard::Block(format!(
                        "A project agent definition named {} would replace the ticket subagent; subagents are unavailable for this ticket",
                        crate::kernels::SUBAGENT
                    ));
                }
                if let Some(loaded) = app.session(&worker_session_id(ticket_id)) {
                    if loaded.session.driver().jobs().await.iter().filter(|job| job.kind == JobKind::Task).count() >= MAX_SUBAGENTS {
                        return Guard::Block(format!("At most {MAX_SUBAGENTS} subagents run at once; wait for one to finish"));
                    }
                }
            }
            Guard::Allow
        })
    }
}

/// The tools of a one-off Session.
pub struct OnceTools {
    /// The tools offered.
    pub specs: Vec<ToolSpec>,
    /// Runs one of them.
    #[allow(clippy::type_complexity)]
    pub call: Box<dyn Fn(String, Value) -> BoxFut<'static, Result<Value, String>> + Send + Sync>,
}

impl ToolHost for OnceTools {
    fn specs(&self) -> Vec<ToolSpec> {
        self.specs.clone()
    }
    fn call<'a>(&'a self, name: &'a str, arguments: Value) -> BoxFut<'a, Result<Value, String>> {
        (self.call)(name.to_string(), arguments)
    }
}

const IMAGE_TYPES: &[(&str, &str)] =
    &[("image/png", "image/png"), ("image/jpeg", "image/jpeg"), ("image/jpg", "image/jpeg"), ("image/webp", "image/webp"), ("image/gif", "image/gif")];
const IMAGE_EXTENSIONS: &[(&str, &str)] = &[("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("webp", "image/webp"), ("gif", "image/gif")];
const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "json", "jsonl", "yaml", "yml", "xml", "csv", "tsv", "log", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "html", "htm", "svg",
    "py", "sh", "bash", "zsh", "sql", "toml", "ini", "cfg", "conf", "env", "rs", "go", "java", "c", "h", "cc", "cpp", "hpp", "cs", "php", "rb", "lua", "vue",
    "svelte", "dart", "swift", "kt",
];
const MAX_INLINE_TEXT_BYTES: usize = 256 * 1024;

fn extension(name: &str) -> String {
    Path::new(name).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// The image type of an attachment, by its declared type, else by its file name when the type says nothing.
pub fn image_type(attachment: &ChatAttachment) -> Option<&'static str> {
    if let Some((_, known)) = IMAGE_TYPES.iter().find(|(declared, _)| *declared == attachment.media_type) {
        return Some(known);
    }
    if attachment.media_type.is_empty() || attachment.media_type == "application/octet-stream" {
        let ext = extension(&attachment.name);
        return IMAGE_EXTENSIONS.iter().find(|(known, _)| *known == ext).map(|(_, media_type)| *media_type);
    }
    None
}

/// The text of an attachment small enough to show inline, when it is text.
fn inline_text(attachment: &ChatAttachment) -> Option<String> {
    if attachment.data.len() > MAX_INLINE_TEXT_BYTES {
        return None;
    }
    let media_type = attachment.media_type.as_str();
    let textual = media_type.starts_with("text/")
        || media_type.starts_with("image/svg+xml")
        || ["json", "xml", "yaml", "x-yaml", "javascript", "typescript", "x-sh", "x-python", "csv", "sql"]
            .iter()
            .any(|kind| media_type.strip_prefix("application/").is_some_and(|rest| rest == *kind || rest.starts_with(&format!("{kind};"))));
    let likely = textual || TEXT_EXTENSIONS.contains(&extension(&attachment.name).as_str());
    if !likely && attachment.data.contains(&0) {
        return None;
    }
    String::from_utf8(attachment.data.clone()).ok()
}

fn attribute(value: &str) -> String {
    value.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;")
}

fn base64(data: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(data)
}

impl App {
    pub(crate) fn store_ticket(&self, ticket_id: &str) -> Option<neo_core::model::Ticket> {
        neo_core::ports::Repositories::ticket(self.store.as_ref(), ticket_id)
    }

    /// The open Session with this id.
    pub fn session(&self, session_id: &str) -> Option<Arc<Loaded>> {
        self.sessions.loaded.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(session_id).cloned()
    }

    /// The kernel a Session of a role runs on: workers on theirs, everything else on the main Session's.
    pub(crate) fn role_kernel(settings: &Settings, role: SessionRole) -> Kernel {
        match role {
            SessionRole::Worker => settings.worker_kernel(),
            SessionRole::Orchestrator | SessionRole::Sidecar | SessionRole::Watchdog => settings.kernel,
        }
    }

    fn role_model(settings: &Settings, role: SessionRole) -> Option<RoleModel> {
        let kernel = Self::role_kernel(settings, role);
        let models = settings.models_of(kernel);
        let model = match role {
            SessionRole::Worker => models.executor,
            SessionRole::Orchestrator => models.eval,
            // One-off turns run on the main Session's kernel, with its model, else that kernel's workers' model.
            SessionRole::Sidecar | SessionRole::Watchdog => models.eval.or(models.executor),
        };
        // A level saved before the kernel stopped taking one is not passed on.
        let levels = crate::kernels::support(kernel).thinking_levels;
        model.map(|model| RoleModel { thinking_level: model.thinking_level.filter(|_| !levels.is_empty()), ..model })
    }

    /// The open Session with this id, opening it on the current kernel from its transcript when it is not.
    pub(crate) async fn ensure_session(
        self: &Arc<Self>,
        session_id: &str,
        cwd: &Path,
        title: &str,
        role: SessionRole,
        ticket_id: Option<&str>,
    ) -> Result<Arc<Loaded>, String> {
        if let Some(loaded) = self.session(session_id) {
            return Ok(loaded);
        }
        let _one = self.sessions.opening.lock().await;
        if let Some(loaded) = self.session(session_id) {
            return Ok(loaded);
        }
        if self.closing() {
            return Err("neo-agent is stopping".into());
        }
        let settings = self.settings();
        let kernel = Self::role_kernel(&settings, role);
        if let Some(problem) = self.kernels.unavailable(kernel) {
            return Err(problem);
        }
        let record = format!("session-file:{session_id}");
        let journal = match self.store.get::<String>(&record).filter(|path| Path::new(path).is_file()) {
            Some(path) => Journal::open(Path::new(&path)).map_err(|error| format!("Cannot reopen session {session_id} at {path}: {error}"))?,
            None => {
                let journal =
                    Journal::create(&self.machine.state_dir.join("sessions"), cwd).map_err(|error| format!("Cannot create a session transcript: {error}"))?;
                self.store.set(&record, &journal.path().display().to_string());
                journal
            }
        };
        journal.set_name(title);
        let spec = SessionSpec {
            session_id: session_id.to_string(),
            role,
            cwd: cwd.to_path_buf(),
            system_prompt: prompts::compose(if role == SessionRole::Worker { prompts::Role::Worker } else { prompts::Role::Orchestrator }, &settings),
            model: Self::role_model(&settings, role),
        };
        let host = Arc::new(SessionTools { app: self.weak.clone(), ticket_id: ticket_id.map(str::to_string), cwd: cwd.to_path_buf() });
        let (reports, runtime) = tokio::sync::mpsc::unbounded_channel();
        let driver = self.kernels.open(kernel, &spec, host, reports)?;
        let session = Session::new(Arc::new(journal), driver, runtime);
        let loaded = Arc::new(Loaded { session, kernel, role, ticket_id: ticket_id.map(str::to_string) });
        self.sessions.loaded.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(session_id.to_string(), loaded.clone());
        if let Some(ticket_id) = ticket_id {
            self.observe_worker(ticket_id.to_string(), &loaded);
        }
        Ok(loaded)
    }

    /// Follow a worker Session's turns, for as long as it stays open.
    fn observe_worker(self: &Arc<Self>, ticket_id: String, loaded: &Arc<Loaded>) {
        let mut events = loaded.session.subscribe();
        let (app, session) = (self.weak.clone(), Arc::downgrade(loaded));
        self.rt.spawn(async move {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                };
                let (Some(app), Some(loaded)) = (app.upgrade(), session.upgrade()) else { return };
                app.worker_event(&ticket_id, &loaded, event).await;
            }
        });
    }

    /// The main Session, open.
    pub async fn ensure_orchestrator(self: &Arc<Self>) -> Result<Arc<Loaded>, String> {
        let master = self.master_id.clone();
        self.ensure_session(&master, &self.machine.state_dir.clone(), "neo-agent orchestrator", SessionRole::Orchestrator, None).await
    }

    /// Close a Session; its transcript stays, and it reopens from it.
    pub async fn stop_session(&self, session_id: &str) {
        let loaded = self.sessions.loaded.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(session_id);
        if let Some(loaded) = loaded {
            loaded.session.dispose().await;
        }
    }

    pub(crate) async fn stop_all_sessions(&self) {
        let all: Vec<Arc<Loaded>> = self.sessions.loaded.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).drain().map(|(_, loaded)| loaded).collect();
        for loaded in &all {
            loaded.session.begin_dispose();
        }
        for loaded in all {
            loaded.session.dispose().await;
        }
    }

    /// Replace the main Session with an empty one; tickets, workers and the WeChat binding stay.
    pub async fn reset_orchestrator(self: &Arc<Self>) -> Result<(), String> {
        self.stop_session(&self.master_id).await;
        self.store.delete(&format!("session-file:{}", self.master_id));
        self.ensure_orchestrator().await.map(|_| ())
    }

    /// Reopen the main Session from its transcript, so its system prompt is composed from the settings now.
    pub async fn reopen_orchestrator(self: &Arc<Self>) -> Result<(), String> {
        self.stop_session(&self.master_id).await;
        self.ensure_orchestrator().await.map(|_| ())
    }

    /// Apply the settings' model choices to the open Sessions on the kernel of their role, from their next turn.
    pub async fn apply_models(&self) {
        let settings = self.settings();
        let all: Vec<Arc<Loaded>> = self.sessions.loaded.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).values().cloned().collect();
        for loaded in all.into_iter().filter(|loaded| loaded.kernel == Self::role_kernel(&settings, loaded.role) && !loaded.session.is_disposed()) {
            let Some(model) = Self::role_model(&settings, loaded.role) else { continue };
            let name = match loaded.kernel {
                Kernel::Claude | Kernel::Antigravity => model.model.clone(),
                Kernel::Omp => format!("{}/{}", model.provider, model.model),
            };
            loaded.session.driver().set_model(Some(&name), model.thinking_level.as_deref()).await;
        }
    }

    pub(crate) async fn relay_queued(self: Arc<Self>, payload: Value, request_id: String) -> Result<(), Failure> {
        let main = self.ensure_orchestrator().await?;
        let text = payload["text"].as_str().unwrap_or("").to_string();
        main.session.send(&request_id, vec![Block::text(text)], Mode::Steer, &Presentation::default(), &[]).await?;
        Ok(())
    }

    pub(crate) async fn notice_queued(self: Arc<Self>, payload: Value, name: String) -> Result<(), Failure> {
        // A notice only adds to what the main Session reads next; with no Session open there is nobody to tell.
        let Some(main) = self.session(&self.master_id) else { return Ok(()) };
        let text = payload["value"].to_string();
        main.session.send(&format!("notice:{name}:{}", key(&[&text])), vec![Block::text(text)], Mode::Inject, &Presentation::default(), &[]).await?;
        Ok(())
    }

    /// Record a person's chat message in the main Session's transcript, without starting a turn. Images are shown to
    /// the model on its next turn, text files are inlined, and other files are saved for a worker to read. Returns
    /// the message as the Trigger carries it.
    pub async fn present_chat(self: &Arc<Self>, text: &str, attachments: &[ChatAttachment], request_id: &str, source: &str) -> Result<String, String> {
        let main = self.ensure_orchestrator().await?;
        let mut images: Vec<Block> = Vec::new();
        let mut rendered: Vec<String> = Vec::new();
        let mut shown: Vec<(String, String)> = Vec::new();
        let mut directory: Option<PathBuf> = None;
        for (index, attachment) in attachments.iter().enumerate() {
            let image = image_type(attachment);
            if let Some(media_type) = image {
                images.push(Block::Image { mime_type: media_type.to_string(), data: base64(&attachment.data) });
            } else if let Some(text) = inline_text(attachment) {
                rendered.push(format!("<attachment name=\"{}\">\n{text}\n</attachment>", attribute(&attachment.name)));
                shown.push((attachment.name.clone(), if attachment.media_type.is_empty() { "text/plain".into() } else { attachment.media_type.clone() }));
                continue;
            }
            let dir = directory.get_or_insert_with(|| self.machine.state_dir.join("attachments").join(request_id.replace(':', "-")));
            std::fs::create_dir_all(dir.as_path()).map_err(|error| format!("Cannot save the attachment: {error}"))?;
            let path = dir.join(format!("{}-{}", index + 1, attachment.name));
            std::fs::write(&path, &attachment.data).map_err(|error| format!("Cannot save the attachment: {error}"))?;
            let stored = image.map(str::to_string).unwrap_or_else(|| {
                if attachment.media_type.is_empty() {
                    "application/octet-stream".into()
                } else {
                    attachment.media_type.clone()
                }
            });
            rendered.push(format!(
                "<attachment name=\"{}\" mediaType=\"{}\" path=\"{}\">\nFile saved at the path above. Use read or bash to inspect or transform it as needed; do not execute it implicitly.\n</attachment>",
                attribute(&attachment.name),
                attribute(&stored),
                attribute(&path.display().to_string())
            ));
            shown.push((attachment.name.clone(), stored));
        }
        let mut parts: Vec<&str> = Vec::new();
        if !text.is_empty() {
            parts.push(text);
        }
        parts.extend(rendered.iter().map(String::as_str));
        let body = if parts.is_empty() { "请查看附件。".to_string() } else { parts.join("\n\n") };
        let mut content = vec![Block::text(body.clone())];
        content.extend(images.iter().cloned());
        let presentation = Presentation { display: true, from_user: true, source: Some(source.to_string()), attachments: shown };
        main.session.append(request_id, content, &presentation, false)?;
        if !images.is_empty() {
            // The message's text reaches the model in its candidate card; its images wait for that turn here.
            let mut seen = vec![Block::text(format!("Images attached to chat message {request_id}:"))];
            seen.extend(images);
            main.session.append(&format!("images:{request_id}"), seen, &Presentation::default(), true)?;
        }
        Ok(body)
    }

    /// Show a reply in the chat transcript without starting a turn.
    pub async fn publish(self: &Arc<Self>, request_id: &str, text: &str) -> Result<(), String> {
        let main = self.ensure_orchestrator().await?;
        main.session.append(
            request_id,
            vec![Block::text(text)],
            &Presentation { display: true, source: Some("chat-reply".into()), ..Default::default() },
            false,
        )
    }

    /// The visible chat transcript, oldest first.
    pub fn chat_transcript(&self) -> Vec<Entry> {
        if let Some(main) = self.session(&self.master_id) {
            return main.session.journal().chat();
        }
        self.store
            .get::<String>(&format!("session-file:{}", self.master_id))
            .and_then(|path| Journal::open(Path::new(&path)).ok())
            .map(|journal| journal.chat())
            .unwrap_or_default()
    }

    /// A ticket's worker transcript, oldest first; empty when it never had a Session.
    pub fn worker_transcript(&self, ticket_id: &str) -> Vec<Entry> {
        let session_id = worker_session_id(ticket_id);
        if let Some(loaded) = self.session(&session_id) {
            return loaded.session.journal().entries();
        }
        self.store
            .get::<String>(&format!("session-file:{session_id}"))
            .and_then(|path| Journal::open(Path::new(&path)).ok())
            .map(|journal| journal.entries())
            .unwrap_or_default()
    }

    /// Run one stateless turn on a Session of its own and return what the model said last.
    pub async fn run_once(
        self: &Arc<Self>,
        role: SessionRole,
        cwd: &Path,
        system_prompt: String,
        prompt: String,
        tools: OnceTools,
        timeout: Duration,
    ) -> Result<String, String> {
        if self.closing() {
            return Err("neo-agent is stopping".into());
        }
        let settings = self.settings();
        let kernel = Self::role_kernel(&settings, role);
        if let Some(problem) = self.kernels.unavailable(kernel) {
            return Err(problem);
        }
        let journal = Journal::create(&self.machine.state_dir.join("sessions").join("once"), cwd)
            .map_err(|error| format!("Cannot create a session transcript: {error}"))?;
        let file = journal.path().to_path_buf();
        let spec = SessionSpec {
            session_id: format!("once-{}", key(&[&file.display().to_string()])),
            role,
            cwd: cwd.to_path_buf(),
            system_prompt,
            model: Self::role_model(&settings, role),
        };
        let (reports, runtime) = tokio::sync::mpsc::unbounded_channel();
        let driver = self.kernels.open(kernel, &spec, Arc::new(tools), reports)?;
        let session = Session::new(Arc::new(journal), driver, runtime);
        let mut events = session.subscribe();
        let turn = async {
            session.send("once", vec![Block::text(prompt)], Mode::Steer, &Presentation::default(), &[]).await?;
            loop {
                match events.recv().await {
                    Ok(KernelEvent::AgentEnd { terminal: true, .. }) => break,
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return Err("The session ended unexpectedly".to_string()),
                }
            }
            if session.journal().last_stop_reason().as_deref() == Some("error") {
                return Err(session.journal().last_assistant_text().unwrap_or_else(|| "The model request failed".into()));
            }
            Ok(session.journal().last_assistant_text().unwrap_or_default().trim().to_string())
        };
        let mut stopping = self.stopping.subscribe();
        let result = tokio::select! {
            result = tokio::time::timeout(timeout, turn) => match result {
                Ok(result) => result,
                Err(_) => Err(format!("The turn timed out after {} seconds", timeout.as_secs())),
            },
            // A one-off turn has nothing to keep: it gives way to a shutdown at once.
            _ = stopping.wait_for(|stopping| *stopping) => Err("neo-agent is stopping".into()),
        };
        session.dispose().await;
        let _ = std::fs::remove_file(&file);
        result
    }
}
