//! The agent runtimes behind Sessions: what a Session of each role needs, and how each kernel provides it.

use crate::accounts::{KernelAccounts, LoginCommand};
use crate::http;
use crate::providers::{self, Provider, ResolvedProvider};
use crate::settings::{Kernel, RoleModel};
use neo_core::ids::key;
use neo_kernel::antigravity::{self, Antigravity, AntigravityDriver, AntigravityOptions};
use neo_kernel::claude::{self, Claude, ClaudeDriver, ClaudeOptions, Subagent};
use neo_kernel::hermes::{self, Hermes, HermesDriver, HermesOptions};
use neo_kernel::omp::{self, Omp, OmpDriver, OmpOptions};
use neo_kernel::session::{Driver, DriverEvent};
use neo_kernel::types::{BoxFut, ToolHost};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// What a Session is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionRole {
    /// The main Session: assesses and routes.
    Orchestrator,
    /// A ticket's Session: does the work.
    Worker,
    /// One read-only answer about a ticket.
    Sidecar,
    /// One inspection turn of the Watchdog.
    Watchdog,
}

/// The only subagent a worker may start.
pub const SUBAGENT: &str = "ticket-task";
/// How many subagents a worker may run at once.
pub const MAX_SUBAGENTS: usize = 8;
const SUBAGENT_DESCRIPTION: &str = "Helper for one independent slice of this ticket, in its directory with read, bash, edit and write; it cannot report or message anyone, so its result comes back to you";
const SUBAGENT_PROMPT: &str = "You are a helper for one independent slice of a larger ticket, working in the ticket directory. Do exactly the slice you were given with your tools, verify it, and finish with a concise report of what you changed or found. You cannot report to or message anyone; your final answer goes back to the worker that spawned you.";

/// What a Session needs from its runtime.
#[derive(Clone, Debug)]
pub struct SessionSpec {
    /// The Session's durable id.
    pub session_id: String,
    /// What it is for.
    pub role: SessionRole,
    /// Where it works.
    pub cwd: PathBuf,
    /// Its whole system prompt, naming the host's tools bare.
    pub system_prompt: String,
    /// The model, or the runtime's default.
    pub model: Option<RoleModel>,
}

/// A model a role may use.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelOption {
    /// The model id.
    pub id: String,
    /// The provider.
    pub provider: String,
    /// A display name.
    pub name: String,
}

/// What a kernel's settings offer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Support {
    /// The thinking levels it takes; none when the runtime decides for itself.
    pub thinking_levels: Vec<&'static str>,
}

/// What each kernel's settings offer.
pub fn support(kernel: Kernel) -> Support {
    match kernel {
        Kernel::Omp | Kernel::Hermes => Support { thinking_levels: vec!["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] },
        Kernel::Claude => Support { thinking_levels: vec!["auto", "off", "low", "medium", "high", "xhigh", "max"] },
        // The Antigravity CLI picks its own effort for the model.
        Kernel::Antigravity => Support { thinking_levels: Vec::new() },
    }
}

/// The program each kernel runs.
pub fn program_name(kernel: Kernel) -> &'static str {
    match kernel {
        Kernel::Omp => "omp",
        Kernel::Claude => "claude",
        Kernel::Antigravity => "agy",
        Kernel::Hermes => "hermes",
    }
}

/// The kernel's name for people.
pub fn display_name(kernel: Kernel) -> &'static str {
    match kernel {
        Kernel::Omp => "Oh My Pi",
        Kernel::Claude => "Claude Code",
        Kernel::Antigravity => "Antigravity CLI",
        Kernel::Hermes => "Hermes Agent",
    }
}

/// Fetches Hermes Agent's repository before its installer runs. The installer clones the whole history over one
/// connection, which a slow link to GitHub drops long before it ends, and a clone cannot resume. Here the history
/// comes one release at a time, oldest first, each part only what that release adds, and a part that broke off is
/// tried again; the releases that came stay in `<install dir>.neo-download`, so the next install continues from
/// there. Nothing is shallow: deepening a shallow history of many merges can cut off commits already fetched. The
/// checkout ends on the first commit, with a clean tree: the installer then treats it as an earlier install and moves
/// it to the latest release, as a fresh clone would be.
const HERMES_PREFETCH: &str = r#"set -o pipefail
url="${HERMES_REPO_URL:-https://github.com/NousResearch/hermes-agent.git}"
home="${HERMES_HOME:-$HOME/.hermes}"
dir="${HERMES_INSTALL_DIR:-$home/hermes-agent}"
part="$dir.neo-download"
pause="${NEO_RETRY_SECONDS:-5}"
try() {
    local n
    for n in 1 2 3 4 5; do
        "$@" && return 0
        echo "Neo: that part broke off; trying it again ($n of 5)" >&2
        sleep $((n * pause))
    done
    "$@"
}
fetch() {
    git -C "$part" fetch --progress --no-tags --filter=blob:none origin "$@"
}
if [ ! -e "$dir" ]; then
    # A shallow download, from an earlier version of this, starts over.
    [ ! -f "$part/.git/shallow" ] || rm -rf "$part"
    if [ ! -d "$part/.git" ]; then
        mkdir -p "$(dirname "$part")" && git init -q "$part" && git -C "$part" remote add -t main origin "$url" || exit 1
        git -C "$part" config remote.origin.promisor true && git -C "$part" config remote.origin.partialclonefilter blob:none || exit 1
    fi
    tags="$(try git ls-remote --tags --refs "$url" 'refs/tags/v*')" || exit 1
    # Oldest first: releases were named by date (v2026.9.24) before they were by version (v0.21.6). Snapshots
    # (v0.23.1+canary.…) are left out; one can point at the newest commit.
    tags="$(printf '%s\n' "$tags" | sed -n 's|.*refs/tags/||p' | grep -v '+' | sort -V)"
    tags="$(printf '%s\n' "$tags" | grep '^v20[0-9][0-9]\.'; printf '%s\n' "$tags" | grep -v '^v20[0-9][0-9]\.')"
    total="$(printf '%s\n' "$tags" | grep -c .)"
    n=0
    for tag in $tags; do
        n=$((n + 1))
        git -C "$part" show-ref -q --verify "refs/tags/$tag" && continue
        echo "Neo: fetching Hermes Agent's history up to $tag ($n of $total)"
        try fetch "+refs/tags/$tag:refs/tags/$tag" || exit 1
    done
    echo "Neo: fetching Hermes Agent's latest history"
    try fetch "+refs/heads/main:refs/remotes/origin/main" || exit 1
    git -C "$part" update-ref refs/heads/main refs/remotes/origin/main && git -C "$part" symbolic-ref HEAD refs/heads/main || exit 1
    root="$(git -C "$part" rev-list --max-parents=0 --first-parent main)" || exit 1
    try git -C "$part" checkout -q --detach "$root" || exit 1
    mv "$part" "$dir" || exit 1
fi
"#;

/// The official installer of each kernel's program, as a shell command: a script fetched from the vendor that puts
/// the program in the user's own folders, with no administrator rights.
pub fn install_command(kernel: Kernel) -> (&'static str, Vec<String>) {
    if kernel == Kernel::Hermes {
        return if cfg!(windows) {
            let command = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; & ([scriptblock]::Create((irm https://hermes-agent.nousresearch.com/install.ps1))) -NonInteractive";
            ("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command].map(String::from).to_vec())
        } else {
            let install = "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive";
            ("bash", vec!["-c".into(), format!("{HERMES_PREFETCH}{install}\n")])
        };
    }
    let (script, windows_script) = match kernel {
        Kernel::Claude => ("https://claude.ai/install.sh", "https://claude.ai/install.ps1"),
        Kernel::Omp => ("https://omp.sh/install", "https://omp.sh/install.ps1"),
        Kernel::Antigravity => ("https://antigravity.google/cli/install.sh", "https://antigravity.google/cli/install.ps1"),
        Kernel::Hermes => unreachable!(),
    };
    if cfg!(windows) {
        let command = format!("$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; irm {windows_script} | iex");
        ("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &command].map(String::from).to_vec())
    } else {
        ("bash", vec!["-c".into(), format!("set -o pipefail; curl -fsSL {script} | bash")])
    }
}

/// How long a kernel's installer may run. Hermes Agent's fetches a repository with a long history, which takes far
/// longer than the others on a slow link to GitHub; one stopped here continues where it was the next time.
pub fn install_timeout(kernel: Kernel) -> Duration {
    Duration::from_secs(if kernel == Kernel::Hermes { 2 * 60 * 60 } else { 10 * 60 })
}

/// Stands in for `git` while an installer runs: git prints its progress ("Receiving objects: 42%") into a pipe only
/// when asked, and the settings page shows that progress.
#[cfg(unix)]
const GIT_PROGRESS_SHIM: &str = r#"#!/bin/sh
# Written by neo-agent for kernel installers; edits are lost.
here=$(dirname -- "$0")
PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF -- "$here" | paste -s -d: -)
export PATH
case "$1" in
    clone|fetch) sub=$1; shift; exec git "$sub" --progress "$@" ;;
esac
exec git "$@"
"#;

/// Splits an installer's output into lines, at `\n` and at the bare `\r` with which git and others redraw their
/// progress, without terminal colour codes or blank lines. An unfinished line stays in `pending`.
fn output_lines(pending: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    let mut lines = Vec::new();
    for &byte in chunk {
        if byte == b'\n' || byte == b'\r' {
            let line = plain_text(&String::from_utf8_lossy(pending));
            pending.clear();
            if !line.is_empty() {
                lines.push(line);
            }
        } else {
            pending.push(byte);
        }
    }
    lines
}

fn plain_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
        } else if !c.is_control() {
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// The last lines an installer printed, a redrawn progress line kept once: the new line replaces the one before when
/// both read the same up to their first digit.
#[derive(Default)]
struct OutputTail(std::collections::VecDeque<String>);

impl OutputTail {
    const KEEP: usize = 12;

    fn push(&mut self, line: String) {
        let head = |text: &str| text.split(|c: char| c.is_ascii_digit()).next().unwrap_or_default().to_string();
        if self.0.back().is_some_and(|last| head(last) == head(&line)) {
            self.0.pop_back();
        }
        self.0.push_back(line);
        if self.0.len() > Self::KEEP {
            self.0.pop_front();
        }
    }

    fn text(&self) -> String {
        Vec::from(self.0.clone()).join("\n")
    }
}

/// Opens runtimes for Sessions.
pub trait Kernels: Send + Sync {
    /// Start nothing yet: build the runtime a Session submits to, which reports to `events` and serves tools from `host`.
    fn open(&self, kernel: Kernel, spec: &SessionSpec, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Result<Arc<dyn Driver>, String>;
    /// The models the kernel can use here.
    fn models(&self, kernel: Kernel) -> BoxFut<'_, Result<Vec<ModelOption>, String>>;
    /// Why the kernel cannot run here, such as its program not being installed; `None` when it can.
    fn unavailable(&self, kernel: Kernel) -> Option<String>;
    /// Install the kernel's program with its official installer, and say where it went.
    fn install(&self, kernel: Kernel) -> BoxFut<'_, Result<PathBuf, String>> {
        Box::pin(async move { Err(format!("{} cannot be installed from here", display_name(kernel))) })
    }
    /// Whether the kernel's program is on this machine, whether or not the kernel can run.
    fn installed(&self, kernel: Kernel) -> bool {
        self.unavailable(kernel).is_none()
    }
    /// Whether the kernel's program is being installed now.
    fn installing(&self, _kernel: Kernel) -> bool {
        false
    }
    /// The last line the kernel's installer printed while it runs, such as how far its download has come.
    fn install_progress(&self, _kernel: Kernel) -> Option<String> {
        None
    }
    /// Use these custom providers from now on: Sessions opened later and model lists reach them.
    fn set_providers(&self, _providers: Vec<ResolvedProvider>) {}
    /// The custom providers to start from when none are set: Oh My Pi's own, each with the key it names.
    fn imported_providers(&self) -> Vec<(Provider, Option<String>)> {
        Vec::new()
    }
    /// Who the kernel is logged in as, and what it can log in to.
    fn accounts(&self, kernel: Kernel) -> BoxFut<'_, Result<KernelAccounts, String>> {
        Box::pin(async move { Err(format!("{} accounts cannot be managed from here", display_name(kernel))) })
    }
    /// The command that logs the kernel in to a provider.
    fn login(&self, kernel: Kernel, _provider: &str) -> Result<LoginCommand, String> {
        Err(format!("{} cannot log in from here", display_name(kernel)))
    }
    /// Log the kernel out of one of its accounts.
    fn logout<'a>(&'a self, kernel: Kernel, _account: &'a str) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move { Err(format!("{} cannot log out from here", display_name(kernel))) })
    }
    /// Give the kernel an API key for a provider, in its own credential store.
    fn api_key<'a>(&'a self, kernel: Kernel, _provider: &'a str, _key: &'a str) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move { Err(format!("{} takes no API key from here", display_name(kernel))) })
    }
}

/// Finds a kernel's program on this machine.
pub type Finder = Arc<dyn Fn(Kernel) -> Option<PathBuf> + Send + Sync>;

/// The real runtimes: the `claude`, `omp` and `agy` programs installed on this machine. None is bundled; each is
/// looked for again whenever it is needed, so one installed while the application runs is used at once.
pub struct RealKernels {
    /// The data directory, where prompt files, overlays and runtime sessions are kept.
    pub state_dir: PathBuf,
    /// Oh My Pi's agent directory.
    pub agent_dir: PathBuf,
    /// Finds each kernel's program.
    pub find: Finder,
    /// The kernels whose programs are being installed, each with the last line its installer printed.
    pub installing: std::sync::Mutex<BTreeMap<Kernel, String>>,
    /// The shim extension file for Oh My Pi.
    pub shim: PathBuf,
    /// Variables to set for every runtime, on top of the host's environment.
    pub env: BTreeMap<String, String>,
    /// The program, with its first arguments, that relays Antigravity's hooks: `neo-agent agy-hook`.
    pub hook_relay: Vec<String>,
    /// The custom providers in use, with their keys.
    pub providers: std::sync::RwLock<Vec<ResolvedProvider>>,
}

const OVERLAY_COMMON: &str = "launch:\n  enabled: false\nretry:\n  enabled: true\ncompaction:\n  enabled: true\n";

fn overlay(role: SessionRole) -> String {
    let mut text = OVERLAY_COMMON.to_string();
    if role == SessionRole::Worker {
        // A worker's long commands and subagents run as background jobs, whose ends wake it.
        text.push_str("  thresholdTokens: 100000\n  keepRecentTokens: 20000\nasync:\n  enabled: true\nbash:\n  autoBackground:\n    enabled: true\n    thresholdMs: 60000\nproviders:\n  cacheWarming: streaming\ntask:\n  maxConcurrency: 8\n  maxRecursionDepth: 2\n");
    } else {
        // The orchestrator resends its whole history with every candidate: compact it early.
        text.push_str("  thresholdTokens: 60000\n  keepRecentTokens: 8000\nasync:\n  enabled: false\nbash:\n  autoBackground:\n    enabled: false\n");
    }
    text
}

fn write_if_changed(path: &Path, text: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).is_ok_and(|current| current == text) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    }
    std::fs::write(path, text).map_err(|error| format!("Cannot write {}: {error}", path.display()))
}

const AGENT_MARKER: &str = "<!-- Written by neo-agent on every start; edits are lost. -->";

/// Whether the project defines a Claude Code agent that would replace the ticket subagent.
pub fn overrides_subagent(cwd: &Path) -> bool {
    fn scan(dir: &Path, depth: usize) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else { return false };
        entries.flatten().any(|entry| {
            let path = entry.path();
            if path.is_dir() {
                return depth < 4 && scan(&path, depth + 1);
            }
            path.extension().is_some_and(|ext| ext == "md")
                && std::fs::read_to_string(&path).is_ok_and(|text| {
                    text.lines().take(40).any(|line| line.strip_prefix("name:").is_some_and(|name| name.trim().trim_matches(['"', '\'']) == SUBAGENT))
                })
        })
    }
    scan(&cwd.join(".claude").join("agents"), 0)
}

impl RealKernels {
    /// The kernel's program, looked for now.
    pub fn program(&self, kernel: Kernel) -> Option<PathBuf> {
        (self.find)(kernel)
    }

    pub(crate) fn require(&self, kernel: Kernel) -> Result<PathBuf, String> {
        self.program(kernel).ok_or_else(|| self.unavailable(kernel).unwrap_or_default())
    }

    fn note_progress(&self, kernel: Kernel, line: &str) {
        if let Some(progress) = self.installing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get_mut(&kernel) {
            line.clone_into(progress);
        }
    }

    /// Where the installer finds the `git` that reports its progress, written now; `None` where there is none.
    fn installer_bin(&self) -> Option<PathBuf> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = self.state_dir.join("installer-bin");
            let git = dir.join("git");
            write_if_changed(&git, GIT_PROGRESS_SHIM).ok()?;
            std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).ok()?;
            Some(dir)
        }
        #[cfg(not(unix))]
        None
    }

    async fn run_installer(&self, kernel: Kernel) -> Result<PathBuf, String> {
        use tokio::io::AsyncReadExt;
        let name = display_name(kernel);
        let (program, args) = install_command(kernel);
        let mut command = tokio::process::Command::new(program);
        command.args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
        if let Some(bin) = self.installer_bin() {
            let path = std::env::var_os("PATH").unwrap_or_default();
            if let Ok(path) = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(&path))) {
                command.env("PATH", path);
            }
        }
        // Its own process group, so that stopping it stops the downloads it started too.
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| format!("Cannot run {program} to install {name}: {error}"))?;
        let tail = std::sync::Mutex::new(OutputTail::default());
        let pump = |mut stream: Box<dyn tokio::io::AsyncRead + Send + Unpin>| {
            let tail = &tail;
            async move {
                let (mut pending, mut chunk) = (Vec::new(), [0u8; 4096]);
                loop {
                    let read = stream.read(&mut chunk).await.unwrap_or(0);
                    let lines = if read == 0 { output_lines(&mut pending, b"\n") } else { output_lines(&mut pending, &chunk[..read]) };
                    for line in lines {
                        self.note_progress(kernel, &line);
                        tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(line);
                    }
                    if read == 0 {
                        break;
                    }
                }
            }
        };
        let (stdout, stderr) = (child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
        let pid = child.id();
        let run = async {
            let (_, _, status) = tokio::join!(pump(Box::new(stdout)), pump(Box::new(stderr)), child.wait());
            status
        };
        let limit = install_timeout(kernel);
        let Ok(status) = tokio::time::timeout(limit, run).await else {
            #[cfg(unix)]
            if let Some(pid) = pid.and_then(|pid| i32::try_from(pid).ok()) {
                // SAFETY: signals the installer's own process group, which nothing else belongs to.
                unsafe { libc::kill(-pid, libc::SIGKILL) };
            }
            let _ = pid;
            return Err(format!("Installing {name} took longer than {} minutes and was stopped", limit.as_secs() / 60));
        };
        let status = status.map_err(|error| format!("Cannot run {program} to install {name}: {error}"))?;
        if !status.success() {
            let tail = tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).text();
            return Err(format!("Installing {name} failed ({status}):\n{tail}"));
        }
        self.program(kernel)
            .ok_or_else(|| format!("The {name} installer finished, but its program ({}) was not found where it installs itself", program_name(kernel)))
    }

    /// The variables every runtime of a kernel gets: the common ones and the custom providers it uses.
    fn runtime_env(&self, kernel: Kernel) -> BTreeMap<String, String> {
        let mut env = self.env.clone();
        env.extend(providers::runtime_env(kernel, &self.providers.read().unwrap_or_else(|poisoned| poisoned.into_inner())));
        env
    }

    /// The custom provider of a name that a kernel uses.
    fn provider_for(&self, kernel: Kernel, name: &str) -> Option<ResolvedProvider> {
        self.providers.read().unwrap_or_else(|poisoned| poisoned.into_inner()).iter().find(|resolved| resolved.provider.name == name && resolved.provider.used_by(kernel)).cloned()
    }

    /// The models of the custom providers a kernel uses, in place of any the runtime lists under the same name.
    fn with_custom_models(&self, kernel: Kernel, mut models: Vec<ModelOption>) -> Vec<ModelOption> {
        let custom: Vec<ModelOption> = self
            .providers
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .filter(|resolved| resolved.provider.used_by(kernel))
            .flat_map(|resolved| {
                resolved.provider.models.iter().map(|model| ModelOption {
                    id: model.id.clone(),
                    provider: resolved.provider.name.clone(),
                    name: if model.name.is_empty() { model.id.clone() } else { model.name.clone() },
                })
            })
            .collect();
        models.retain(|model| !custom.iter().any(|ours| ours.provider == model.provider));
        models.extend(custom);
        models.sort_by(|a, b| (&a.provider, &a.id).cmp(&(&b.provider, &b.id)));
        models
    }

    pub(crate) fn claude_env(&self) -> BTreeMap<String, String> {
        // The user's Claude Code settings fill in what the process environment does not say.
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
        let mut env: BTreeMap<String, String> =
            claude::user_environment(&home.join(".claude").join("settings.json")).into_iter().filter(|(name, _)| std::env::var_os(name).is_none()).collect();
        env.extend(self.env.clone());
        env
    }

    fn open_claude(&self, spec: &SessionSpec, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Result<Arc<dyn Driver>, String> {
        let program = self.require(Kernel::Claude)?;
        let names: Vec<String> = host.specs().into_iter().map(|tool| tool.name).collect();
        let worker = spec.role == SessionRole::Worker;
        let note = if worker {
            "Runtime note: you run in Claude Code. Tool names above map to `Read`, `Bash`, `Edit` and `Write`; application tools are exposed as `mcp__neo__<name>`. Spawn subagents (the `task` tool above) with `Agent` and `subagent_type: \"ticket-task\"`, setting `run_in_background: true` for long work; at most 8 run at once. Run any command that may take longer than a minute with `Bash` and `run_in_background: true`, and stop one you no longer need with `TaskStop`. A finished background command or subagent wakes you in this Session with its result; there is no `wait` tool, so end your turn to wait for it."
        } else {
            "Runtime note: you run in Claude Code. Tool names above map to `Read` and `Bash`; application tools are exposed as `mcp__neo__<name>`."
        };
        let mut env = self.claude_env();
        let mut env_remove = Vec::new();
        if let Some((resolved, model)) = spec.model.as_ref().and_then(|model| Some((self.provider_for(Kernel::Claude, &model.provider)?, &model.model))) {
            let (custom, removed) = providers::claude_env(&resolved, model);
            for name in &removed {
                env.remove(name);
            }
            env.extend(custom);
            env_remove = removed;
        }
        // The same compaction thresholds as on Oh My Pi, and its move of a long command to the background after a minute.
        env.insert("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), if worker { "100000" } else { "60000" }.into());
        if worker {
            env.insert("BASH_DEFAULT_TIMEOUT_MS".into(), "60000".into());
        }
        let builtin: &[&str] = match spec.role {
            SessionRole::Worker => &["Read", "Bash", "Edit", "Write", "Agent", "TaskStop"],
            SessionRole::Sidecar => &["Read"],
            SessionRole::Orchestrator | SessionRole::Watchdog => &["Read", "Bash"],
        };
        let mut agents = BTreeMap::new();
        if worker {
            agents.insert(
                SUBAGENT.to_string(),
                Subagent {
                    description: SUBAGENT_DESCRIPTION.into(),
                    prompt: SUBAGENT_PROMPT.into(),
                    tools: ["Read", "Bash", "Edit", "Write"].map(String::from).to_vec(),
                },
            );
        }
        let thinking = match spec.role {
            // An inspection turn decides from evidence it is handed: low effort, unless thinking is off.
            SessionRole::Watchdog => {
                Some(if spec.model.as_ref().and_then(|model| model.thinking_level.as_deref()) == Some("off") { "off" } else { "low" }.to_string())
            }
            _ => spec.model.as_ref().and_then(|model| model.thinking_level.clone()),
        };
        let options = ClaudeOptions {
            program,
            cwd: spec.cwd.clone(),
            system_prompt: format!("{}\n\n{note}", claude::rewrite_tool_names(&spec.system_prompt, &names)),
            builtin_tools: builtin.iter().map(|name| name.to_string()).collect(),
            model: spec.model.as_ref().map(|model| model.model.clone()),
            thinking,
            agents,
            project_settings: worker,
            env,
            env_remove,
            max_turns: match spec.role {
                SessionRole::Sidecar => Some(20),
                SessionRole::Watchdog => Some(30),
                _ => None,
            },
            persist: matches!(spec.role, SessionRole::Orchestrator | SessionRole::Worker),
        };
        Ok(Arc::new(Claude(ClaudeDriver::new(options, host, events))))
    }

    fn open_omp(&self, spec: &SessionSpec, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Result<Arc<dyn Driver>, String> {
        let program = self.require(Kernel::Omp)?;
        let kernel_dir = self.state_dir.join("kernel");
        let worker = spec.role == SessionRole::Worker;
        let overlay_text = overlay(spec.role);
        let overlay_file = kernel_dir.join("overlays").join(format!("{}.yml", key(&[&overlay_text])));
        write_if_changed(&overlay_file, &overlay_text)?;
        let prompt_file = kernel_dir.join("prompts").join(format!("{}.md", key(&[&spec.system_prompt])));
        write_if_changed(&prompt_file, &spec.system_prompt)?;
        if worker {
            // The subagent a worker spawns: its work tools and no model of its own, so it runs on the worker's model.
            let agent_file = self.agent_dir.join("agents").join(format!("{SUBAGENT}.md"));
            let ours = std::fs::read_to_string(&agent_file).map(|text| text.contains(AGENT_MARKER)).unwrap_or(true);
            if ours {
                let text = format!("---\nname: {SUBAGENT}\ndescription: {SUBAGENT_DESCRIPTION}\ntools: read, bash, edit, write\nspawns: [\"{SUBAGENT}\"]\n---\n{AGENT_MARKER}\n{SUBAGENT_PROMPT}\n");
                write_if_changed(&agent_file, &text)?;
            }
        }
        let builtin: &[&str] = match spec.role {
            SessionRole::Worker => &["read", "bash", "edit", "write", "task", "wait"],
            SessionRole::Sidecar => &["read"],
            SessionRole::Orchestrator | SessionRole::Watchdog => &["read", "bash"],
        };
        let persistent = matches!(spec.role, SessionRole::Orchestrator | SessionRole::Worker);
        let options = OmpOptions {
            program,
            shim: self.shim.clone(),
            cwd: spec.cwd.clone(),
            agent_dir: self.agent_dir.clone(),
            session_dir: persistent.then(|| self.state_dir.join("sessions").join("omp")),
            system_prompt_file: prompt_file,
            builtin_tools: builtin.iter().map(|name| name.to_string()).collect(),
            model: spec.model.as_ref().map(|model| format!("{}/{}", model.provider, model.model)),
            thinking: match spec.role {
                SessionRole::Watchdog => Some("low".into()),
                _ => spec.model.as_ref().and_then(|model| model.thinking_level.clone()),
            },
            config: vec![overlay_file],
            context_files: worker,
            // One-off Sessions of a kind share a prefix, which the provider caches once.
            prompt_cache_key: match spec.role {
                SessionRole::Sidecar => Some(format!("sidecar-{}", key(&[&self.state_dir.display().to_string()]))),
                SessionRole::Watchdog => Some(format!("watchdog-{}", key(&[&self.state_dir.display().to_string()]))),
                _ => None,
            },
            env: self.runtime_env(Kernel::Omp),
        };
        Ok(Arc::new(Omp(OmpDriver::new(options, host, events))))
    }

    fn open_antigravity(&self, spec: &SessionSpec, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Result<Arc<dyn Driver>, String> {
        let program = self.require(Kernel::Antigravity)?;
        let server = antigravity::mcp_server_name();
        let application = if host.specs().is_empty() {
            String::new()
        } else {
            format!(
                " Application tools are on the MCP server `{server}`: call one with `call_mcp_tool`, `ServerName` `{server}` and `ToolName` its name above."
            )
        };
        let note = match spec.role {
            SessionRole::Worker => format!(
                "Runtime note: you run in the Antigravity CLI. Tool names above map to `view_file`, `run_command`, `write_to_file`, `replace_file_content`, and `invoke_subagent` for subagents.{application} A command still running after a few seconds moves to the background, and its end wakes you, as does a subagent's reply. Do not use browser, image, scheduling or web-search tools unless the ticket asks for them."
            ),
            _ => format!(
                "Runtime note: you run in the Antigravity CLI. Tool names above map to `view_file` and `run_command`.{application} Do not use browser, image, scheduling or web-search tools."
            ),
        };
        let tools: &[&str] = match spec.role {
            SessionRole::Worker => &["read", "bash", "edit", "write", "task"],
            SessionRole::Sidecar => &["read"],
            SessionRole::Orchestrator | SessionRole::Watchdog => &["read", "bash"],
        };
        // The model id names its effort; only an inspection turn, which decides from evidence it is handed, asks for low.
        let thinking = (spec.role == SessionRole::Watchdog).then(|| "low".to_string());
        let options = AntigravityOptions {
            program,
            cwd: spec.cwd.clone(),
            system_prompt: format!("{}\n\n{note}", spec.system_prompt),
            tools: tools.iter().map(|name| name.to_string()).collect(),
            model: spec.model.as_ref().map(|model| model.model.clone()),
            thinking,
            env: self.env.clone(),
            hook_relay: self.hook_relay.clone(),
            bridge_id: Some(key(&[&spec.session_id])[..8].to_string()),
        };
        Ok(Arc::new(Antigravity(AntigravityDriver::new(options, host, events))))
    }

    fn hermes_bridge_file(&self) -> PathBuf {
        self.state_dir.join("kernel").join(format!("neo-hermes-bridge-{}.py", key(&[hermes::BRIDGE_SOURCE])))
    }

    fn open_hermes(&self, spec: &SessionSpec, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Result<Arc<dyn Driver>, String> {
        let program = self.require(Kernel::Hermes)?;
        let worker = spec.role == SessionRole::Worker;
        let note = match spec.role {
            SessionRole::Worker => "Runtime note: you run in Hermes Agent. Tool names above map to `read_file` (and `search_files`), `terminal` (and `process_manage`), `patch`, `write_file`, and `delegate_task` for subagents; application tools keep their bare names above. Run any command that may take longer than a minute with `terminal` setting `background: true` and `notify: true`, and stop one you no longer need with `process_manage` (`action: \"kill\"`). A finished background command wakes you in this Session with its result; end your turn to wait for it. Do not use browser or web-search tools unless the ticket asks for them.",
            SessionRole::Sidecar => "Runtime note: you run in Hermes Agent. Tool names above map to `read_file` and `search_files`; application tools keep their bare names above.",
            SessionRole::Orchestrator | SessionRole::Watchdog => "Runtime note: you run in Hermes Agent. Tool names above map to `read_file` (and `search_files`) and `terminal`; application tools keep their bare names above. Do not use web-search tools.",
        };
        let tools: &[&str] = match spec.role {
            SessionRole::Worker => &["read", "bash", "edit", "write", "task"],
            SessionRole::Sidecar => &["read"],
            SessionRole::Orchestrator | SessionRole::Watchdog => &["read", "bash"],
        };
        let thinking = match spec.role {
            SessionRole::Watchdog => {
                Some(if spec.model.as_ref().and_then(|model| model.thinking_level.as_deref()) == Some("off") { "off" } else { "low" }.to_string())
            }
            _ => spec.model.as_ref().and_then(|model| model.thinking_level.clone()),
        };
        let options = HermesOptions {
            program,
            bridge_file: self.hermes_bridge_file(),
            cwd: spec.cwd.clone(),
            system_prompt: format!("{}\n\n{note}", spec.system_prompt),
            builtin_tools: tools.iter().map(|name| name.to_string()).collect(),
            model: spec.model.as_ref().map(|model| format!("{}/{}", model.provider, model.model)),
            thinking,
            persist: matches!(spec.role, SessionRole::Orchestrator | SessionRole::Worker),
            context_files: worker,
            memory: worker,
            background_review: worker,
            max_turns: match spec.role {
                SessionRole::Sidecar => Some(20),
                SessionRole::Watchdog => Some(30),
                _ => None,
            },
            env: self.runtime_env(Kernel::Hermes),
        };
        Ok(Arc::new(Hermes(HermesDriver::new(options, host, events))))
    }

    async fn claude_models(&self) -> Result<Vec<ModelOption>, String> {
        let env = self.claude_env();
        let var = |name: &str| env.get(name).cloned().or_else(|| std::env::var(name).ok()).filter(|value| !value.is_empty());
        let base = var("ANTHROPIC_BASE_URL").unwrap_or_else(|| "https://api.anthropic.com".into());
        let base = base.trim_end_matches('/').trim_end_matches("/v1").to_string();
        let mut headers = vec![("anthropic-version".to_string(), "2023-06-01".to_string())];
        if let Some(token) = var("ANTHROPIC_AUTH_TOKEN") {
            headers.push(("authorization".into(), format!("Bearer {token}")));
        }
        if let Some(api_key) = var("ANTHROPIC_API_KEY") {
            headers.push(("x-api-key".into(), api_key));
        }
        let mut models: Vec<ModelOption> = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..20 {
            let url = format!("{base}/v1/models?limit=1000{}", after.as_ref().map(|id| format!("&after_id={id}")).unwrap_or_default());
            let response = http::send(http::Request { method: "GET", url, headers: headers.clone(), timeout: Duration::from_secs(15), ..Default::default() })
                .await
                .map_err(|error| format!("Model list request failed: {error}"))?;
            if response.status != 200 {
                return Err(format!("Model list request failed: HTTP {}", response.status));
            }
            let body: serde_json::Value = serde_json::from_slice(&response.body).map_err(|error| format!("Model list request failed: {error}"))?;
            for model in body["data"].as_array().cloned().unwrap_or_default() {
                let Some(id) = model["id"].as_str() else { continue };
                if !models.iter().any(|known| known.id == id) {
                    let name = model["display_name"].as_str().filter(|name| !name.is_empty()).unwrap_or(id);
                    models.push(ModelOption { id: id.to_string(), provider: "anthropic".into(), name: name.to_string() });
                }
            }
            let last = body["last_id"].as_str().map(str::to_string);
            if body["has_more"] != true || last.is_none() || last == after {
                break;
            }
            after = last;
        }
        Ok(models)
    }
}

impl Kernels for RealKernels {
    fn open(&self, kernel: Kernel, spec: &SessionSpec, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Result<Arc<dyn Driver>, String> {
        match kernel {
            Kernel::Claude => self.open_claude(spec, host, events),
            Kernel::Omp => self.open_omp(spec, host, events),
            Kernel::Antigravity => self.open_antigravity(spec, host, events),
            Kernel::Hermes => self.open_hermes(spec, host, events),
        }
    }
    fn models(&self, kernel: Kernel) -> BoxFut<'_, Result<Vec<ModelOption>, String>> {
        Box::pin(async move {
            match kernel {
                Kernel::Claude => {
                    let listed = self.claude_models().await;
                    let custom = self.with_custom_models(kernel, Vec::new());
                    // A failed Anthropic list does not hide the custom providers' models.
                    match listed {
                        Ok(models) => Ok(self.with_custom_models(kernel, models)),
                        Err(_) if !custom.is_empty() => Ok(custom),
                        Err(error) => Err(error),
                    }
                }
                Kernel::Omp => {
                    let program = self.require(Kernel::Omp)?;
                    let models: Vec<ModelOption> = omp::list_models(&program, &self.agent_dir, &self.state_dir)
                        .await?
                        .into_iter()
                        .map(|model| ModelOption { id: model.id, provider: model.provider, name: model.name })
                        .collect();
                    Ok(self.with_custom_models(kernel, models))
                }
                Kernel::Antigravity => {
                    let program = self.require(Kernel::Antigravity)?;
                    Ok(antigravity::list_models(&program, &self.env)
                        .await?
                        .into_iter()
                        .map(|(id, name)| ModelOption { id, provider: "antigravity".into(), name })
                        .collect())
                }
                Kernel::Hermes => {
                    let program = self.require(Kernel::Hermes)?;
                    let bridge = self.hermes_bridge_file();
                    let models: Vec<ModelOption> = hermes::list_models(&program, &bridge, &self.state_dir, &self.env)
                        .await?
                        .into_iter()
                        .map(|model| ModelOption { id: model.id, provider: model.provider, name: model.name })
                        .collect();
                    Ok(self.with_custom_models(kernel, models))
                }
            }
        })
    }
    fn unavailable(&self, kernel: Kernel) -> Option<String> {
        if self.program(kernel).is_none() {
            let installing = self.installing(kernel);
            return Some(format!(
                "{} ({}) is {}",
                display_name(kernel),
                program_name(kernel),
                if installing { "being installed" } else { "not installed. Install it, or choose another kernel" }
            ));
        }
        (kernel == Kernel::Omp && !self.shim.is_file())
            .then(|| format!("The Oh My Pi extension {} is missing; reinstall the application.", self.shim.display()))
    }
    fn install(&self, kernel: Kernel) -> BoxFut<'_, Result<PathBuf, String>> {
        Box::pin(async move {
            {
                let mut installing = self.installing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                if installing.contains_key(&kernel) {
                    return Err(format!("{} is already being installed", display_name(kernel)));
                }
                installing.insert(kernel, String::new());
            }
            let result = self.run_installer(kernel).await;
            self.installing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&kernel);
            result
        })
    }
    fn installed(&self, kernel: Kernel) -> bool {
        self.program(kernel).is_some()
    }
    fn installing(&self, kernel: Kernel) -> bool {
        self.installing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains_key(&kernel)
    }
    fn install_progress(&self, kernel: Kernel) -> Option<String> {
        self.installing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&kernel).filter(|line| !line.is_empty()).cloned()
    }
    fn set_providers(&self, providers: Vec<ResolvedProvider>) {
        *self.providers.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = providers;
    }
    fn imported_providers(&self) -> Vec<(Provider, Option<String>)> {
        providers::import_omp(&self.agent_dir.join("models.yml"))
    }
    fn accounts(&self, kernel: Kernel) -> BoxFut<'_, Result<KernelAccounts, String>> {
        Box::pin(self.kernel_accounts(kernel))
    }
    fn login(&self, kernel: Kernel, provider: &str) -> Result<LoginCommand, String> {
        self.kernel_login(kernel, provider)
    }
    fn logout<'a>(&'a self, kernel: Kernel, account: &'a str) -> BoxFut<'a, Result<(), String>> {
        Box::pin(self.kernel_logout(kernel, account))
    }
    fn api_key<'a>(&'a self, kernel: Kernel, provider: &'a str, key: &'a str) -> BoxFut<'a, Result<(), String>> {
        Box::pin(self.kernel_api_key(kernel, provider, key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_worker_overlay_with_background_jobs_and_an_orchestrator_one_without() {
        let worker = overlay(SessionRole::Worker);
        assert!(
            worker.contains("async:\n  enabled: true")
                && worker.contains("thresholdMs: 60000")
                && worker.contains("thresholdTokens: 100000")
                && worker.contains("maxConcurrency: 8")
        );
        assert!(!worker.contains("advisor"));
        let main = overlay(SessionRole::Orchestrator);
        assert!(main.contains("async:\n  enabled: false") && main.contains("thresholdTokens: 60000") && !main.contains("cacheWarming"));
    }

    #[test]
    fn offers_minimal_thinking_only_on_oh_my_pi_and_hermes_and_no_levels_on_antigravity() {
        assert!(support(Kernel::Omp).thinking_levels.contains(&"minimal"));
        assert!(support(Kernel::Hermes).thinking_levels.contains(&"minimal") && support(Kernel::Hermes).thinking_levels.contains(&"max"));
        assert!(!support(Kernel::Claude).thinking_levels.contains(&"minimal") && support(Kernel::Claude).thinking_levels.contains(&"max"));
        assert!(support(Kernel::Antigravity).thinking_levels.is_empty());
    }

    #[test]
    fn installs_each_kernel_with_its_vendors_script() {
        for (kernel, script) in [
            (Kernel::Claude, "claude.ai/install"),
            (Kernel::Omp, "omp.sh/install"),
            (Kernel::Antigravity, "antigravity.google/cli/install"),
            (Kernel::Hermes, "hermes-agent.nousresearch.com/install"),
        ] {
            let (_, args) = install_command(kernel);
            assert!(args.last().unwrap().contains(&format!("https://{script}")), "{args:?}");
        }
    }

    #[test]
    fn gives_hermes_two_hours_to_install_and_the_others_ten_minutes() {
        assert_eq!(install_timeout(Kernel::Hermes), Duration::from_secs(7200));
        assert_eq!(install_timeout(Kernel::Claude), Duration::from_secs(600));
    }

    #[test]
    fn reads_an_installers_redrawn_progress_as_lines_without_colours() {
        let mut pending = Vec::new();
        let lines = output_lines(
            &mut pending,
            "\u{1b}[2m  Cloning\u{1b}[0m\nReceiving objects:   3% (1/30), 8.04 MiB | 116.00 KiB/s\rReceiving objects:   4% (2/".as_bytes(),
        );
        assert_eq!(lines, ["Cloning", "Receiving objects:   3% (1/30), 8.04 MiB | 116.00 KiB/s"]);
        assert_eq!(output_lines(&mut pending, b"30)\r\r\n"), ["Receiving objects:   4% (2/30)"]);
        assert!(pending.is_empty());

        let mut tail = OutputTail::default();
        for line in ["==> Cloning", "Receiving objects:   3% (1/30)", "Receiving objects:   4% (2/30)", "fatal: early EOF"] {
            tail.push(line.into());
        }
        assert_eq!(tail.text(), "==> Cloning\nReceiving objects:   4% (2/30)\nfatal: early EOF");
    }

    #[cfg(unix)]
    #[test]
    fn asks_git_for_its_progress_while_an_installer_runs() {
        let dir = std::env::temp_dir().join(format!("neo-git-shim-{}", std::process::id()));
        let (real, kernels) = (
            dir.join("real"),
            RealKernels {
                state_dir: dir.clone(),
                agent_dir: dir.clone(),
                find: Arc::new(|_| None),
                installing: Default::default(),
                shim: dir.join("shim.ts"),
                env: BTreeMap::new(),
                hook_relay: Vec::new(),
                providers: Default::default(),
            },
        );
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("git"), "#!/bin/sh\necho \"$@\"\n").unwrap();
        std::process::Command::new("chmod").arg("+x").arg(real.join("git")).status().unwrap();
        let bin = kernels.installer_bin().unwrap();
        let path = std::env::join_paths([bin.clone(), real, "/usr/bin".into(), "/bin".into()]).unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new(bin.join("git")).args(args).env("PATH", &path).output().unwrap();
            String::from_utf8(out.stdout).unwrap()
        };
        assert_eq!(run(&["clone", "--filter=blob:none", "url", "dir"]), "clone --progress --filter=blob:none url dir\n");
        assert_eq!(run(&["-C", "dir", "status"]), "-C dir status\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn fetches_hermes_history_in_parts_continuing_a_broken_download_and_hands_over_a_clean_checkout() {
        let dir = std::env::temp_dir().join(format!("neo-hermes-prefetch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (source, home) = (dir.join("source"), dir.join("home"));
        let git = |cwd: &Path, args: &[&str]| {
            let out = std::process::Command::new("git").args(args).current_dir(cwd).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8(out.stdout).unwrap().trim().to_string()
        };
        // 2500 commits, each changing a file, a release every 100 (v0.1 to v0.25, and a tag that is not a release),
        // with commits after the last release and a release branched off main.
        std::fs::create_dir_all(&source).unwrap();
        git(&source, &["init", "-q", "-b", "main"]);
        git(&source, &["config", "uploadpack.allowFilter", "true"]);
        let mut stream = String::new();
        for n in 1..=2500 {
            let from = if n == 1 { String::new() } else { format!("from :{}\n", n - 1) };
            stream.push_str(&format!(
                "commit refs/heads/main\nmark :{n}\ncommitter T <t@t> {n} +0000\ndata 2\nc\n{from}M 644 inline f{}.txt\ndata {}\n{n}\n",
                n % 7,
                n.to_string().len() + 1
            ));
            if n % 100 == 0 && n < 2500 {
                stream.push_str(&format!("tag v0.{}\nfrom :{n}\ntagger T <t@t> {n} +0000\ndata 2\nr\n", n / 100));
            }
        }
        stream.push_str("commit refs/heads/release/x\ncommitter T <t@t> 3000 +0000\ndata 2\nx\nfrom :1500\nM 644 inline x.txt\ndata 2\nx\n");
        stream.push_str("tag v0.15.1\nfrom refs/heads/release/x\ntagger T <t@t> 3000 +0000\ndata 2\nr\n");
        stream.push_str("tag rc-abandoned\nfrom :50\ntagger T <t@t> 50 +0000\ndata 2\nr\n");
        stream.push_str("tag v2020.1.1\nfrom :50\ntagger T <t@t> 50 +0000\ndata 2\nr\n");
        stream.push_str("tag v0.0.1+channel.1\nfrom :2500\ntagger T <t@t> 2500 +0000\ndata 2\nr\n");
        let mut import =
            std::process::Command::new("git").args(["fast-import", "--quiet"]).current_dir(&source).stdin(std::process::Stdio::piped()).spawn().unwrap();
        std::io::Write::write_all(import.stdin.as_mut().unwrap(), stream.as_bytes()).unwrap();
        assert!(import.wait().unwrap().success());
        let url = format!("file://{}", source.display());
        let part = home.join("hermes-agent.neo-download");
        // A shallow download an earlier version left behind.
        std::fs::create_dir_all(&home).unwrap();
        git(&home, &["clone", "-q", "--filter=blob:none", "--depth=1", "--no-checkout", "--branch", "main", &url, part.to_str().unwrap()]);
        // A link that always drops the part up to v0.10: the download stops there, keeping the releases before it.
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let real = String::from_utf8(std::process::Command::new("sh").args(["-c", "command -v git"]).output().unwrap().stdout).unwrap();
        std::fs::write(bin.join("git"), format!("#!/bin/sh\ncase \"$*\" in *refs/tags/v0.10:*) exit 128;; esac\nexec {} \"$@\"\n", real.trim())).unwrap();
        std::process::Command::new("chmod").arg("+x").arg(bin.join("git")).status().unwrap();
        let broken = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(&std::env::var_os("PATH").unwrap()))).unwrap();
        let run = |path: &std::ffi::OsStr| {
            let out = std::process::Command::new("bash")
                .args(["-c", HERMES_PREFETCH])
                .env("PATH", path)
                .env("HERMES_REPO_URL", &url)
                .env("HERMES_HOME", &home)
                .env("NEO_RETRY_SECONDS", "0")
                .env_remove("HERMES_INSTALL_DIR")
                .output()
                .unwrap();
            (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
        };
        let (done, said, errors) = run(&broken);
        assert!(!done && errors.contains("trying it again (5 of 5)"), "{said}{errors}");
        assert!(!part.join(".git").join("shallow").exists());
        assert_eq!(git(&part, &["tag", "--list"]).lines().count(), 10, "v2020.1.1, then v0.1 to v0.9");
        // The next install continues from v0.10.
        let (done, said, errors) = run(&std::env::var_os("PATH").unwrap());
        assert!(done, "{said}{errors}");
        assert!(said.starts_with("Neo: fetching Hermes Agent's history up to v0.10 (11 of 26)\n"), "{said}");
        assert!(said.ends_with("Neo: fetching Hermes Agent's history up to v0.24 (26 of 26)\nNeo: fetching Hermes Agent's latest history\n"), "{said}");
        let checkout = home.join("hermes-agent");
        assert!(!part.exists() && !checkout.join(".git").join("shallow").exists());
        assert_eq!(git(&checkout, &["rev-list", "--count", "origin/main"]), "2500");
        assert_eq!(git(&checkout, &["rev-list", "--count", "main"]), "2500");
        assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), git(&source, &["rev-list", "--max-parents=0", "main"]));
        assert_eq!(git(&checkout, &["status", "--porcelain"]), "");
        assert_eq!(git(&checkout, &["config", "remote.origin.partialclonefilter"]), "blob:none");
        assert!(git(&checkout, &["tag", "--list", "rc-*"]).is_empty() && git(&checkout, &["tag", "--list", "*+*"]).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn says_why_a_kernel_cannot_run() {
        let kernels = RealKernels {
            state_dir: "/s".into(),
            agent_dir: "/a".into(),
            find: Arc::new(|kernel| (kernel == Kernel::Omp).then(|| PathBuf::from("/bin/omp"))),
            installing: Default::default(),
            shim: "/missing/shim.ts".into(),
            env: BTreeMap::new(),
            hook_relay: Vec::new(),
            providers: Default::default(),
        };
        assert!(kernels.unavailable(Kernel::Claude).unwrap().contains("claude"));
        assert!(kernels.unavailable(Kernel::Antigravity).unwrap().contains("agy"));
        assert!(kernels.unavailable(Kernel::Hermes).unwrap().contains("hermes"));
        assert!(kernels.unavailable(Kernel::Omp).unwrap().contains("/missing/shim.ts"));
        kernels.installing.lock().unwrap().insert(Kernel::Claude, String::new());
        assert!(kernels.unavailable(Kernel::Claude).unwrap().contains("being installed"));
    }

    #[test]
    fn finds_a_project_agent_that_would_replace_the_ticket_subagent() {
        let dir = std::env::temp_dir().join(format!("neo-agents-{}-{}", std::process::id(), key(&["agents"])));
        let agents = dir.join(".claude").join("agents").join("team");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(agents.join("other.md"), "---\nname: reviewer\n---\n").unwrap();
        assert!(!overrides_subagent(&dir));
        std::fs::write(agents.join("task.md"), "---\nname: \"ticket-task\"\ndescription: x\n---\n").unwrap();
        assert!(overrides_subagent(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
