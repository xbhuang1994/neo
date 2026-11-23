//! Antigravity account management: inspects the Antigravity CLI's Google OAuth login, starts `agy acp --login` over
//! pipes so remote browser sessions can complete sign-in, and logs out by removing the login token file.

use crate::app::App;
use crate::kernels::RealKernels;
use crate::settings::Kernel;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The Google account Antigravity is signed in with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAccount {
    /// The signed-in email address, or empty when the token file does not carry one.
    pub email: String,
    /// Whether this login can be removed from Neo.
    pub removable: bool,
}

/// Antigravity's current login state on this machine.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    /// The signed-in Google account when a login file is present.
    pub account: Option<AntigravityAccount>,
    /// Something the person should know, such as a login kept in the system keyring.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The command that logs Antigravity in.
#[derive(Clone, Debug, Default)]
pub struct LoginCommand {
    /// The `agy` program.
    pub program: PathBuf,
    /// Its arguments.
    pub args: Vec<String>,
    /// Variables to set.
    pub env: BTreeMap<String, String>,
    /// Text that, once printed, means the login failed even though the program keeps running.
    pub fails_on: Option<String>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

/// Antigravity's login token file.
fn agy_token_file() -> PathBuf {
    home().join(".gemini").join("antigravity-cli").join("antigravity-oauth-token")
}

/// Suppress browser launch and ANSI color codes during CLI login.
fn login_env(mut env: BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.insert("BROWSER".into(), "true".into());
    env.insert("NO_COLOR".into(), "1".into());
    env
}

/// Text without terminal escapes: colours, cursor moves and OSC hyperlinks.
pub fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.peek() {
                Some('[') => {
                    chars.next();
                    while let Some(&next) = chars.peek() {
                        chars.next();
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // An OSC sequence runs to BEL or ESC \.
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' || (next == '\u{1b}' && chars.peek() == Some(&'\\')) {
                            if next == '\u{1b}' {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            },
            '\r' => {}
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

/// The web links in a login's output that a person can open elsewhere: not those to this machine.
pub fn links(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for word in text.split(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"' || c == '\'') {
        let Some(start) = word.find("https://") else { continue };
        let link = word[start..].trim_end_matches(['.', ',', ')', ']']);
        if link.len() > "https://".len() && !found.iter().any(|known| known == link) {
            found.push(link.to_string());
        }
    }
    found
}

impl RealKernels {
    /// Who Antigravity is logged in as.
    pub(crate) async fn antigravity_account(&self) -> Result<AccountStatus, String> {
        self.require(Kernel::Antigravity)?;
        if let Ok(text) = std::fs::read_to_string(agy_token_file()) {
            let token: Value = serde_json::from_str(&text).unwrap_or_default();
            let email = token["id_token_email"].as_str().unwrap_or_default().to_string();
            Ok(AccountStatus { account: Some(AntigravityAccount { email, removable: true }), note: None })
        } else {
            Ok(AccountStatus { account: None, note: Some("No login file found. A login kept in the system keyring does not show here.".into()) })
        }
    }

    /// The command that logs Antigravity in with Google.
    pub(crate) fn antigravity_login(&self) -> Result<LoginCommand, String> {
        let program = self.require(Kernel::Antigravity)?;
        Ok(LoginCommand { program, args: vec!["acp".into(), "--login".into()], env: login_env(self.env.clone()), fails_on: Some("couldn't log in".into()) })
    }

    /// Log Antigravity out by deleting its login token file.
    pub(crate) async fn antigravity_logout(&self) -> Result<(), String> {
        self.require(Kernel::Antigravity)?;
        match std::fs::remove_file(agy_token_file()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Cannot remove the Antigravity login: {error}")),
        }
    }
}

/// One Antigravity login in progress, or the last one.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginView {
    /// Which login.
    pub id: u64,
    /// `running`, `done` or `failed`.
    pub state: &'static str,
    /// The links to open.
    pub links: Vec<String>,
    /// What the program printed, cleaned, its last lines.
    pub output: String,
}

struct LoginRun {
    view: LoginView,
    stdin: Option<tokio::process::ChildStdin>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

/// The login in progress, at most one at a time.
#[derive(Default)]
pub struct Logins {
    current: Mutex<Option<LoginRun>>,
    next: std::sync::atomic::AtomicU64,
}

const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);
const KEEP_OUTPUT: usize = 6000;

fn empty_object(value: Value) -> Result<(), String> {
    let map = value.as_object().ok_or("Expected a JSON object")?;
    if let Some(key) = map.keys().next() {
        return Err(format!("Unknown field {key}"));
    }
    Ok(())
}

impl App {
    /// Antigravity's account status, with any login in progress.
    pub async fn accounts_view(self: &Arc<Self>) -> Value {
        let installed = self.kernels.installed(Kernel::Antigravity);
        let (account, note, problem) = if installed {
            match self.kernels.account().await {
                Ok(status) => (status.account, status.note, None),
                Err(error) => (None, None, Some(error)),
            }
        } else {
            (None, None, None)
        };
        json!({
            "installed": installed,
            "problem": problem,
            "account": account,
            "note": note,
            "login": self.login_view(),
        })
    }

    /// The login in progress or the last one, if any.
    pub fn login_view(&self) -> Option<LoginView> {
        self.logins.current.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().map(|run| run.view.clone())
    }

    /// Start logging Antigravity in; a login still in progress is ended first.
    pub async fn start_login(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        empty_object(value)?;
        let command = self.kernels.login()?;
        self.cancel_login();
        let mut process = tokio::process::Command::new(&command.program);
        process
            .args(&command.args)
            .envs(&command.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = process.spawn().map_err(|error| format!("Cannot run {}: {error}", command.program.display()))?;
        let id = self.logins.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let view = LoginView { id, state: "running", links: Vec::new(), output: String::new() };
        *self.logins.current.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(LoginRun { view, stdin: child.stdin.take(), stop: Some(stop) });
        let (text_out, mut out) = tokio::sync::mpsc::unbounded_channel::<String>();
        for mut stream in [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let text_out = text_out.clone();
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                while let Ok(read) = stream.read(&mut buffer).await {
                    if read == 0 || text_out.send(String::from_utf8_lossy(&buffer[..read]).into_owned()).is_err() {
                        break;
                    }
                }
            });
        }
        drop(text_out);
        let app = Arc::clone(self);
        tokio::spawn(async move {
            let mut raw = String::new();
            let mut stopped = stopped;
            let outcome: Result<bool, String> = loop {
                tokio::select! {
                    chunk = out.recv() => match chunk {
                        Some(chunk) => {
                            raw.push_str(&chunk);
                            let text = clean(&raw);
                            let failed = command.fails_on.as_deref().is_some_and(|marker| text.contains(marker));
                            app.update_login(id, |view| {
                                view.links = links(&text);
                                view.output = tail(&text);
                            });
                            if failed {
                                break Ok(false);
                            }
                        }
                        None => break child.wait().await.map(|status| status.success()).map_err(|error| error.to_string()),
                    },
                    status = child.wait() => {
                        // Let the last output in before saying how it ended.
                        while let Ok(Some(chunk)) = tokio::time::timeout(Duration::from_millis(200), out.recv()).await {
                            raw.push_str(&chunk);
                        }
                        let text = clean(&raw);
                        app.update_login(id, |view| { view.links = links(&text); view.output = tail(&text); });
                        break status.map(|status| status.success()).map_err(|error| error.to_string());
                    }
                    _ = &mut stopped => break Err("Cancelled".into()),
                    _ = tokio::time::sleep(LOGIN_TIMEOUT) => break Err("The login took more than ten minutes".into()),
                }
            };
            let _ = child.start_kill();
            let _ = child.wait().await;
            app.update_login(id, |view| {
                view.state = if outcome == Ok(true) { "done" } else { "failed" };
                if let Err(error) = &outcome {
                    view.output = tail(&format!("{}\n{error}", view.output));
                }
            });
            if let Some(run) = app.logins.current.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_mut().filter(|run| run.view.id == id) {
                run.stdin = None;
            }
            // New credentials can change what Antigravity lists.
            app.model_lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&Kernel::Antigravity);
        });
        // Give the program a moment to print its link.
        for _ in 0..30 {
            match self.login_view() {
                Some(view) if view.id == id && (view.state != "running" || !view.links.is_empty()) => break,
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
        Ok(json!({"login": self.login_view()}))
    }

    fn update_login(&self, id: u64, change: impl FnOnce(&mut LoginView)) {
        if let Some(run) = self.logins.current.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_mut().filter(|run| run.view.id == id) {
            change(&mut run.view);
        }
    }

    /// Pass what the person pasted, such as an authorization code or the address they landed on, to the login.
    pub async fn login_input(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let map = value.as_object().ok_or("Expected a JSON object")?;
        if let Some(key) = map.keys().find(|key| key.as_str() != "text") {
            return Err(format!("Unknown field {key}"));
        }
        let text = map.get("text").and_then(Value::as_str).ok_or("text is required")?.trim().to_string();
        if text.contains('\n') || text.len() > 8000 {
            return Err("Paste one line".into());
        }
        let stdin = {
            let mut current = self.logins.current.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let run = current.as_mut().filter(|run| run.view.state == "running").ok_or("No login is waiting")?;
            run.stdin.take().ok_or("No login is waiting")?
        };
        let mut stdin = stdin;
        let written = stdin.write_all(format!("{text}\n").as_bytes()).await.and(stdin.flush().await);
        if let Some(run) = self.logins.current.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_mut() {
            if run.view.state == "running" {
                run.stdin = Some(stdin);
            }
        }
        written.map_err(|error| format!("The login is no longer listening: {error}"))?;
        // Give it a moment to answer.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        Ok(json!({"login": self.login_view()}))
    }

    /// End the login in progress, if any.
    pub fn cancel_login(&self) {
        let mut current = self.logins.current.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(run) = current.as_mut() {
            if let Some(stop) = run.stop.take() {
                let _ = stop.send(());
            }
            run.stdin = None;
        }
    }

    /// Log Antigravity out.
    pub async fn logout(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        empty_object(value)?;
        self.kernels.logout().await?;
        self.model_lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&Kernel::Antigravity);
        Ok(self.accounts_view().await)
    }
}

fn tail(text: &str) -> String {
    let text = text.trim();
    if text.len() <= KEEP_OUTPUT {
        return text.to_string();
    }
    let mut start = text.len() - KEEP_OUTPUT;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_terminal_escapes_and_finds_the_links_to_open() {
        let printed = "Opening browser…\r\nIf the browser didn't open, visit: \u{1b}]8;;https://accounts.google.com/o/oauth2/auth?code=true&x=1\u{7}https://accounts.google.com/o/oauth2/auth?code=true&x=1\u{1b}]8;;\u{7}\n\u{1b}[1;32mPaste code here\u{1b}[0m >";
        let text = clean(printed);
        assert_eq!(text, "Opening browser…\nIf the browser didn't open, visit: https://accounts.google.com/o/oauth2/auth?code=true&x=1\nPaste code here >");
        assert_eq!(links(&text), vec!["https://accounts.google.com/o/oauth2/auth?code=true&x=1"]);
        assert_eq!(links("Open: https://a.example/x. Local shortcut (this machine only): http://localhost:1/launch"), vec!["https://a.example/x"]);
    }
}
