//! Kernel accounts: who each kernel is logged in as, logging in through the kernel's own program, logging out, and
//! adding an API key. Each kernel keeps its credentials its own way, so each has its own adapter; logging in runs the
//! kernel's login command over pipes, shows the person the link it prints and passes back the code they paste, so it
//! works from a page on another machine.

use crate::app::App;
use crate::kernels::{display_name, RealKernels};
use crate::settings::Kernel;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// An account a kernel is logged in with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Account {
    /// What logging out names: an id the kernel's adapter understands.
    pub id: String,
    /// The provider it is for, such as `anthropic` or `openai-codex`.
    pub provider: String,
    /// `oauth`, `api_key` or `token`.
    pub kind: String,
    /// Who it is, such as an email address; empty when the kernel does not say.
    pub label: String,
    /// Whether it can be logged out from here.
    pub removable: bool,
}

/// A provider a kernel can log in to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LoginOption {
    /// What the login command is given.
    pub id: String,
    /// Its name for people.
    pub name: String,
}

/// A kernel's accounts and what can be done about them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelAccounts {
    /// The accounts in use.
    pub accounts: Vec<Account>,
    /// The providers it can log in to; any other id may be typed when `anyProvider`.
    pub login: Vec<LoginOption>,
    /// Whether a provider id other than those listed may be given.
    pub any_provider: bool,
    /// Whether an API key can be added for a provider.
    pub api_keys: bool,
    /// Something the person should know, such as a token set in the environment taking precedence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The command that logs a kernel in.
#[derive(Clone, Debug, Default)]
pub struct LoginCommand {
    /// The program.
    pub program: PathBuf,
    /// Its arguments.
    pub args: Vec<String>,
    /// Variables to set.
    pub env: BTreeMap<String, String>,
    /// Variables to remove.
    pub env_remove: Vec<String>,
    /// Text that, once printed, means the login failed even though the program keeps running.
    pub fails_on: Option<String>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

fn hermes_home(env: &BTreeMap<String, String>) -> PathBuf {
    env.get("HERMES_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HERMES_HOME").map(PathBuf::from)).unwrap_or_else(|| home().join(".hermes"))
}

/// Antigravity's login token file.
fn agy_token_file() -> PathBuf {
    home().join(".gemini").join("antigravity-cli").join("antigravity-oauth-token")
}

/// The variables no login or status command may inherit: the host's own Claude Code session, and any browser, so
/// none is opened on the backend's machine.
fn scrubbed(env: BTreeMap<String, String>) -> (BTreeMap<String, String>, Vec<String>) {
    let mut env = env;
    env.insert("BROWSER".into(), "true".into());
    env.insert("NO_COLOR".into(), "1".into());
    (env, neo_kernel::claude::SESSION_VARIABLES.iter().map(|name| name.to_string()).collect())
}

async fn run(program: &Path, args: &[&str], env: &BTreeMap<String, String>, input: Option<&str>) -> Result<(bool, String), String> {
    let (env, remove) = scrubbed(env.clone());
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .envs(&env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for name in &remove {
        command.env_remove(name);
    }
    let mut child = command.spawn().map_err(|error| format!("Cannot run {}: {error}", program.display()))?;
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(input) = input {
            stdin.write_all(input.as_bytes()).await.map_err(|error| error.to_string())?;
        }
    }
    let output = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output())
        .await
        .map_err(|_| format!("{} took too long", program.display()))?
        .map_err(|error| error.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    Ok((output.status.success(), clean(&text).trim().to_string()))
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
    /// Who a kernel is logged in as.
    pub(crate) async fn kernel_accounts(&self, kernel: Kernel) -> Result<KernelAccounts, String> {
        match kernel {
            Kernel::Claude => {
                let program = self.require(kernel)?;
                let (_, text) = run(&program, &["auth", "status"], &self.claude_env(), None).await?;
                let status: Value = serde_json::from_str(&text).map_err(|_| format!("Claude Code did not say who is logged in: {text}"))?;
                let mut accounts = Vec::new();
                let method = status["authMethod"].as_str().unwrap_or("none");
                let mut note = None;
                if status["loggedIn"] == true {
                    let label = status["email"].as_str().or(status["apiKeySource"].as_str()).unwrap_or_default().to_string();
                    let own = matches!(method, "claude.ai" | "console") || status["storedClaudeAiLogin"] == true;
                    if !own {
                        note = Some(format!(
                            "Claude Code uses {} from its settings or the environment, which comes before a login made here.",
                            status["apiKeySource"].as_str().unwrap_or(match method {
                                "oauth_token" => "a token",
                                "api_key" => "an API key",
                                _ => "credentials",
                            })
                        ));
                    }
                    accounts.push(Account { id: "anthropic".into(), provider: "anthropic".into(), kind: method.to_string(), label, removable: own });
                }
                Ok(KernelAccounts {
                    accounts,
                    login: vec![
                        LoginOption { id: "claudeai".into(), name: "Claude subscription".into() },
                        LoginOption { id: "console".into(), name: "Anthropic Console (API billing)".into() },
                    ],
                    any_provider: false,
                    api_keys: false,
                    note,
                })
            }
            Kernel::Omp => {
                self.require(kernel)?;
                let accounts = omp_accounts(&self.agent_dir.join("agent.db"))?;
                let login = [
                    ("anthropic", "Anthropic (Claude Pro/Max)"),
                    ("openai-codex-device", "OpenAI (ChatGPT, device code)"),
                    ("openai-codex", "OpenAI (ChatGPT)"),
                    ("google-gemini-cli", "Google (Gemini CLI)"),
                    ("xai-oauth", "xAI (device code)"),
                    ("kimi-code", "Kimi Code (device code)"),
                ]
                .map(|(id, name)| LoginOption { id: id.into(), name: name.into() })
                .to_vec();
                Ok(KernelAccounts { accounts, login, any_provider: true, api_keys: true, note: None })
            }
            Kernel::Hermes => {
                self.require(kernel)?;
                let accounts = hermes_accounts(&hermes_home(&self.env).join("auth.json"));
                let login = [
                    ("nous", "Nous Portal (device code)"),
                    ("openai-codex", "OpenAI (ChatGPT, device code)"),
                    ("xai-oauth", "xAI (device code)"),
                    ("minimax-oauth", "MiniMax (device code)"),
                    ("anthropic", "Anthropic (Claude Pro/Max)"),
                ]
                .map(|(id, name)| LoginOption { id: id.into(), name: name.into() })
                .to_vec();
                Ok(KernelAccounts { accounts, login, any_provider: false, api_keys: true, note: None })
            }
            Kernel::Antigravity => {
                self.require(kernel)?;
                let mut accounts = Vec::new();
                let mut note = None;
                if let Ok(text) = std::fs::read_to_string(agy_token_file()) {
                    let token: Value = serde_json::from_str(&text).unwrap_or_default();
                    let label = token["id_token_email"].as_str().unwrap_or_default().to_string();
                    accounts.push(Account { id: "google".into(), provider: "google".into(), kind: "oauth".into(), label, removable: true });
                } else {
                    note = Some("No login file found. A login kept in the system keyring does not show here.".into());
                }
                Ok(KernelAccounts {
                    accounts,
                    login: vec![LoginOption { id: "google".into(), name: "Google".into() }],
                    any_provider: false,
                    api_keys: false,
                    note,
                })
            }
        }
    }

    /// The command that logs a kernel in to a provider.
    pub(crate) fn kernel_login(&self, kernel: Kernel, provider: &str) -> Result<LoginCommand, String> {
        let program = self.require(kernel)?;
        let id_like = !provider.is_empty() && provider.len() <= 80 && provider.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
        if !id_like {
            return Err(format!("{provider:?} is not a provider id"));
        }
        let (args, base, fails_on): (Vec<String>, BTreeMap<String, String>, Option<&str>) = match kernel {
            Kernel::Claude => {
                let flag = if provider == "console" { "--console" } else { "--claudeai" };
                (vec!["auth".into(), "login".into(), flag.into()], self.claude_env(), None)
            }
            Kernel::Omp => {
                (vec!["login".into(), provider.into()], BTreeMap::from([("PI_CODING_AGENT_DIR".into(), self.agent_dir.display().to_string())]), None)
            }
            Kernel::Hermes => (vec!["auth".into(), "add".into(), provider.into(), "--no-browser".into()], self.env.clone(), None),
            Kernel::Antigravity => (vec!["acp".into(), "--login".into()], self.env.clone(), Some("couldn't log in")),
        };
        let (env, env_remove) = scrubbed(base);
        Ok(LoginCommand { program, args, env, env_remove, fails_on: fails_on.map(str::to_string) })
    }

    /// Log a kernel out of an account.
    pub(crate) async fn kernel_logout(&self, kernel: Kernel, account: &str) -> Result<(), String> {
        let program = self.require(kernel)?;
        match kernel {
            Kernel::Claude => {
                let (done, text) = run(&program, &["auth", "logout"], &self.claude_env(), None).await?;
                if done {
                    Ok(())
                } else {
                    Err(text)
                }
            }
            Kernel::Omp => omp_logout(&self.agent_dir.join("agent.db"), account),
            Kernel::Hermes => {
                let (provider, id) = account.split_once('/').ok_or("A Hermes account is <provider>/<credential id>")?;
                let (done, text) = run(&program, &["auth", "remove", provider, id], &self.env, None).await?;
                if done {
                    Ok(())
                } else {
                    Err(text)
                }
            }
            Kernel::Antigravity => match std::fs::remove_file(agy_token_file()) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!("Cannot remove the Antigravity login: {error}")),
            },
        }
    }

    /// Give a kernel an API key for a provider, in its own credential store.
    pub(crate) async fn kernel_api_key(&self, kernel: Kernel, provider: &str, key: &str) -> Result<(), String> {
        let program = self.require(kernel)?;
        let id_like = !provider.is_empty() && provider.len() <= 80 && provider.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
        if !id_like || key.trim().is_empty() {
            return Err("An API key needs a provider id and a key".into());
        }
        let (done, text) = match kernel {
            Kernel::Omp => {
                let document = json!({"version": 1, "credentials": [{"provider": provider, "credential": {"type": "api_key", "key": key.trim()}}]});
                let env = BTreeMap::from([("PI_CODING_AGENT_DIR".into(), self.agent_dir.display().to_string())]);
                run(&program, &["auth", "import", "-"], &env, Some(&document.to_string())).await?
            }
            Kernel::Hermes => {
                run(&program, &["auth", "add", provider, "--type", "api-key", "--api-key", key.trim(), "--label", "neo"], &self.env, None).await?
            }
            _ => return Err(format!("{} takes no API key from here", display_name(kernel))),
        };
        if done {
            Ok(())
        } else {
            Err(text.replace(key.trim(), "…"))
        }
    }
}

/// Oh My Pi's active credentials in its `agent.db`. Rows that cannot be read are skipped, so one damaged row does not
/// hide the others.
fn omp_accounts(db: &Path) -> Result<Vec<Account>, String> {
    if !db.exists() {
        return Ok(Vec::new());
    }
    let unreadable = |error: rusqlite::Error| format!("Cannot read Oh My Pi's credentials in {}: {error}", db.display());
    let connection = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(unreadable)?;
    let mut statement =
        connection.prepare("SELECT id, provider, credential_type, data FROM auth_credentials WHERE disabled_cause IS NULL").map_err(unreadable)?;
    let mut rows = statement.query([]).map_err(unreadable)?;
    let mut accounts = Vec::new();
    loop {
        let row = match rows.next() {
            Ok(Some(row)) => row,
            Ok(None) => break,
            // A damaged page ends the scan; what was read so far still shows.
            Err(_) if !accounts.is_empty() => break,
            Err(error) => return Err(unreadable(error)),
        };
        let read = (row.get::<_, i64>(0), row.get::<_, String>(1), row.get::<_, String>(2), row.get::<_, Option<String>>(3));
        let (Ok(id), Ok(provider), Ok(kind), Ok(data)) = read else { continue };
        if !matches!(kind.as_str(), "oauth" | "api_key") || provider.is_empty() || provider.contains(['{', '"', ' ']) {
            continue;
        }
        let data: Value = data.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
        let label = ["email", "orgName", "accountId"].iter().find_map(|field| data[*field].as_str()).unwrap_or_default().to_string();
        accounts.push(Account { id: id.to_string(), provider, kind, label, removable: true });
    }
    accounts.sort_by(|a, b| (&a.provider, &a.id).cmp(&(&b.provider, &b.id)));
    Ok(accounts)
}

/// Log Oh My Pi out of a credential as its own `/logout` does: marked deleted, which running processes notice.
fn omp_logout(db: &Path, account: &str) -> Result<(), String> {
    let id: i64 = account.parse().map_err(|_| format!("{account:?} is not an Oh My Pi credential id"))?;
    let connection = rusqlite::Connection::open(db).map_err(|error| format!("Cannot open {}: {error}", db.display()))?;
    connection.busy_timeout(Duration::from_secs(5)).map_err(|error| error.to_string())?;
    let changed = connection
        .execute(
            "UPDATE auth_credentials SET disabled_cause = 'deleted by user', updated_at = strftime('%s', 'now') WHERE id = ?1 AND disabled_cause IS NULL",
            [id],
        )
        .map_err(|error| format!("Cannot log Oh My Pi out: {error}"))?;
    if changed == 0 {
        return Err("That Oh My Pi credential is gone already".into());
    }
    Ok(())
}

/// Hermes's credentials in its `auth.json`: its pooled credentials, each by provider and id.
fn hermes_accounts(file: &Path) -> Vec<Account> {
    let Ok(text) = std::fs::read_to_string(file) else { return Vec::new() };
    let document: Value = serde_json::from_str(&text).unwrap_or_default();
    let mut accounts = Vec::new();
    for (provider, entries) in document["credential_pool"].as_object().into_iter().flatten() {
        for entry in entries.as_array().into_iter().flatten() {
            let Some(id) = entry["id"].as_str() else { continue };
            accounts.push(Account {
                id: format!("{provider}/{id}"),
                provider: provider.clone(),
                kind: entry["auth_type"].as_str().unwrap_or("api_key").replace('-', "_"),
                label: entry["label"].as_str().unwrap_or_default().to_string(),
                removable: true,
            });
        }
    }
    accounts
}

/// One login in progress, or the last one.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginView {
    /// Which login.
    pub id: u64,
    /// The kernel.
    pub kernel: Kernel,
    /// The provider.
    pub provider: String,
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

/// The login in progress, at most one at a time: Oh My Pi's callback ports cannot be shared.
#[derive(Default)]
pub struct Logins {
    current: Mutex<Option<LoginRun>>,
    next: std::sync::atomic::AtomicU64,
}

const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);
const KEEP_OUTPUT: usize = 6000;

impl App {
    /// Every kernel's accounts, with the login in progress.
    pub async fn accounts_view(self: &Arc<Self>) -> Value {
        let mut kernels = Vec::new();
        for kernel in [Kernel::Omp, Kernel::Claude, Kernel::Antigravity, Kernel::Hermes] {
            let installed = self.kernels.installed(kernel);
            let (accounts, problem) = if installed {
                match self.kernels.accounts(kernel).await {
                    Ok(accounts) => (Some(accounts), None),
                    Err(error) => (None, Some(error)),
                }
            } else {
                (None, None)
            };
            kernels.push(json!({"id": kernel.as_str(), "installed": installed, "accounts": accounts, "problem": problem}));
        }
        json!({"kernels": kernels, "login": self.login_view()})
    }

    /// The login in progress or the last one, if any.
    pub fn login_view(&self) -> Option<LoginView> {
        self.logins.current.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().map(|run| run.view.clone())
    }

    /// Start logging a kernel in to a provider (`{kernel, provider}`); a login still in progress is ended first.
    pub async fn start_login(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let kernel = value
            .get("kernel")
            .and_then(Value::as_str)
            .and_then(|name| serde_json::from_value::<Kernel>(json!(name)).ok())
            .ok_or("kernel is omp, claude, antigravity or hermes")?;
        let provider = value.get("provider").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        let command = self.kernels.login(kernel, &provider)?;
        self.cancel_login();
        let mut process = tokio::process::Command::new(&command.program);
        process
            .args(&command.args)
            .envs(&command.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for name in &command.env_remove {
            process.env_remove(name);
        }
        let mut child = process.spawn().map_err(|error| format!("Cannot run {}: {error}", command.program.display()))?;
        let id = self.logins.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let view = LoginView { id, kernel, provider: provider.clone(), state: "running", links: Vec::new(), output: String::new() };
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
            // New credentials can change what a kernel lists.
            app.model_lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&kernel);
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
        let text = value.get("text").and_then(Value::as_str).ok_or("text is required")?.trim().to_string();
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

    /// Log a kernel out of an account (`{kernel, account}`).
    pub async fn logout(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let kernel = value
            .get("kernel")
            .and_then(Value::as_str)
            .and_then(|name| serde_json::from_value::<Kernel>(json!(name)).ok())
            .ok_or("kernel is omp, claude, antigravity or hermes")?;
        let account = value.get("account").and_then(Value::as_str).ok_or("account is required")?;
        self.kernels.logout(kernel, account).await?;
        self.model_lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&kernel);
        Ok(self.accounts_view().await)
    }

    /// Give a kernel an API key for a provider (`{kernel, provider, key}`).
    pub async fn add_api_key(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let kernel = value
            .get("kernel")
            .and_then(Value::as_str)
            .and_then(|name| serde_json::from_value::<Kernel>(json!(name)).ok())
            .ok_or("kernel is omp, claude, antigravity or hermes")?;
        let provider = value.get("provider").and_then(Value::as_str).ok_or("provider is required")?.trim();
        let key = value.get("key").and_then(Value::as_str).ok_or("key is required")?;
        self.kernels.api_key(kernel, provider, key).await?;
        self.model_lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&kernel);
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
        let printed = "Opening browser…\r\nIf the browser didn't open, visit: \u{1b}]8;;https://claude.com/cai/oauth/authorize?code=true&x=1\u{7}https://claude.com/cai/oauth/authorize?code=true&x=1\u{1b}]8;;\u{7}\n\u{1b}[1;32mPaste code here\u{1b}[0m >";
        let text = clean(printed);
        assert_eq!(text, "Opening browser…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1\nPaste code here >");
        assert_eq!(links(&text), vec!["https://claude.com/cai/oauth/authorize?code=true&x=1"]);
        assert_eq!(links("Open: https://a.example/x. Local shortcut (this machine only): http://localhost:1/launch"), vec!["https://a.example/x"]);
    }

    #[test]
    fn reads_hermes_pooled_credentials() {
        let dir = std::env::temp_dir().join(format!("neo-accounts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("auth.json");
        std::fs::write(
            &file,
            r#"{"version":1,"credential_pool":{"openrouter":[{"id":"3ff907","label":"test","auth_type":"api_key","access_token":"secret"}]}}"#,
        )
        .unwrap();
        let accounts = hermes_accounts(&file);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            accounts,
            vec![Account { id: "openrouter/3ff907".into(), provider: "openrouter".into(), kind: "api_key".into(), label: "test".into(), removable: true }]
        );
    }

    #[test]
    fn reads_and_logs_out_oh_my_pi_credentials_as_its_own_logout_does() {
        let dir = std::env::temp_dir().join(format!("neo-omp-accounts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("agent.db");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT, identity_key TEXT, created_at INTEGER, updated_at INTEGER);
                 INSERT INTO auth_credentials VALUES (1, 'openai-codex', 'oauth', '{\"email\":\"a@b.c\",\"access\":\"x\"}', NULL, NULL, 0, 0);
                 INSERT INTO auth_credentials VALUES (2, 'deepseek', 'api_key', '{\"key\":\"k\"}', NULL, NULL, 0, 0);
                 INSERT INTO auth_credentials VALUES (3, 'gone', 'api_key', '{}', 'deleted by user', NULL, 0, 0);",
            )
            .unwrap();
        drop(connection);
        let accounts = omp_accounts(&db).unwrap();
        assert_eq!(
            accounts.iter().map(|account| (account.id.as_str(), account.provider.as_str(), account.label.as_str())).collect::<Vec<_>>(),
            vec![("2", "deepseek", ""), ("1", "openai-codex", "a@b.c")]
        );
        omp_logout(&db, "1").unwrap();
        assert!(omp_logout(&db, "1").is_err());
        assert_eq!(omp_accounts(&db).unwrap().len(), 1);
        assert!(omp_accounts(&dir.join("missing.db")).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
