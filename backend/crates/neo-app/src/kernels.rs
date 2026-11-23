//! The Antigravity CLI runtime behind Sessions: what a Session of each role needs, and how Antigravity provides it.

use crate::accounts::{AccountStatus, LoginCommand};
use crate::settings::{Kernel, RoleModel};
use neo_core::ids::key;
use neo_kernel::antigravity::{self, Antigravity, AntigravityDriver, AntigravityOptions};
use neo_kernel::session::{Driver, DriverEvent};
use neo_kernel::types::{BoxFut, ToolHost};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
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

/// How many subagents a worker may run at once.
pub const MAX_SUBAGENTS: usize = 8;

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

/// The program the kernel runs.
pub fn program_name(kernel: Kernel) -> &'static str {
    match kernel {
        Kernel::Antigravity => "agy",
    }
}

/// The kernel's name for people.
pub fn display_name(kernel: Kernel) -> &'static str {
    match kernel {
        Kernel::Antigravity => "Antigravity CLI",
    }
}

/// The official installer of the Antigravity CLI, as a shell command: a script fetched from Google that puts `agy` in
/// the user's own folders, with no administrator rights.
pub fn install_command(kernel: Kernel) -> (&'static str, Vec<String>) {
    let (script, windows_script) = match kernel {
        Kernel::Antigravity => ("https://antigravity.google/cli/install.sh", "https://antigravity.google/cli/install.ps1"),
    };
    if cfg!(windows) {
        let command = format!("$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; irm {windows_script} | iex");
        ("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &command].map(String::from).to_vec())
    } else {
        ("bash", vec!["-c".into(), format!("set -o pipefail; curl -fsSL {script} | bash")])
    }
}

/// How long the installer may run.
pub fn install_timeout(_kernel: Kernel) -> Duration {
    Duration::from_secs(10 * 60)
}

/// Splits an installer's output into lines, at `\n` and at the bare `\r` with which tools redraw their progress,
/// without terminal colour codes or blank lines. An unfinished line stays in `pending`.
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
    /// Who Antigravity is logged in as.
    fn account(&self) -> BoxFut<'_, Result<AccountStatus, String>> {
        Box::pin(async { Err("Antigravity CLI account cannot be managed from here".into()) })
    }
    /// The command that logs Antigravity in.
    fn login(&self) -> Result<LoginCommand, String> {
        Err("Antigravity CLI cannot log in from here".into())
    }
    /// Log Antigravity out.
    fn logout(&self) -> BoxFut<'_, Result<(), String>> {
        Box::pin(async { Err("Antigravity CLI cannot log out from here".into()) })
    }
}

/// Finds the kernel's program on this machine.
pub type Finder = Arc<dyn Fn(Kernel) -> Option<PathBuf> + Send + Sync>;

/// The real Antigravity runtime: the `agy` program installed on this machine. It is not bundled and is looked for
/// again whenever it is needed, so one installed while the application runs is used at once.
pub struct RealKernels {
    /// Finds the kernel's program.
    pub find: Finder,
    /// Kernels whose programs are being installed, each with the last line its installer printed.
    pub installing: std::sync::Mutex<BTreeMap<Kernel, String>>,
    /// Variables to set for every runtime, on top of the host's environment.
    pub env: BTreeMap<String, String>,
    /// The program, with its first arguments, that relays Antigravity's hooks: `neo-agent agy-hook`.
    pub hook_relay: Vec<String>,
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

    async fn run_installer(&self, kernel: Kernel) -> Result<PathBuf, String> {
        use tokio::io::AsyncReadExt;
        let name = display_name(kernel);
        let (program, args) = install_command(kernel);
        let mut command = tokio::process::Command::new(program);
        command.args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
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

    fn open_antigravity(&self, spec: &SessionSpec, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Result<Arc<dyn Driver>, String> {
        let program = self.require(Kernel::Antigravity)?;
        let server = antigravity::mcp_server_name();
        let application = if host.specs().is_empty() {
            String::new()
        } else {
            format!(
                " Application tools are on MCP server `{server}`: call one with `call_mcp_tool` passing `ServerName: \"{server}\"`, `ToolName: \"<name>\"`, and `Arguments: {{...}}` (JSON object)."
            )
        };
        let note = match spec.role {
            SessionRole::Worker => format!(
                "Runtime note: you run in the Antigravity CLI. Tool names above map to `read_file`/`view_file`, `grep_search`, `find_by_name`, `list_dir`, `run_command`, `edit_file`/`replace_file_content`/`multi_replace_file_content`, `write_file`/`write_to_file`, and `invoke_subagent` / `define_subagent` / `manage_subagents` (plus `run_workflow` for Python `parallel()` / `pipeline()` fan-out workflows; at most 8 concurrent subagents).{application} A command that runs in the background or a subagent wakes you when finished; end your turn to wait instead of polling. Do not use browser or image tools unless the ticket asks for them."
            ),
            SessionRole::Sidecar => format!(
                "Runtime note: you run in the Antigravity CLI. Tool names above map to `read_file`/`view_file`, `grep_search`, `find_by_name`, and `list_dir`.{application}"
            ),
            SessionRole::Orchestrator | SessionRole::Watchdog => format!(
                "Runtime note: you run in the Antigravity CLI. Tool names above map to `read_file`/`view_file`, `grep_search`, `find_by_name`, `list_dir`, and `run_command`.{application} Do not use browser, image, scheduling or web-search tools."
            ),
        };
        let tools: &[&str] = match spec.role {
            SessionRole::Worker => &["read", "bash", "web", "edit", "write", "task"],
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
}

impl Kernels for RealKernels {
    fn open(&self, kernel: Kernel, spec: &SessionSpec, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Result<Arc<dyn Driver>, String> {
        match kernel {
            Kernel::Antigravity => self.open_antigravity(spec, host, events),
        }
    }
    fn models(&self, kernel: Kernel) -> BoxFut<'_, Result<Vec<ModelOption>, String>> {
        Box::pin(async move {
            match kernel {
                Kernel::Antigravity => {
                    let program = self.require(Kernel::Antigravity)?;
                    Ok(antigravity::list_models(&program, &self.env)
                        .await?
                        .into_iter()
                        .map(|(id, name)| ModelOption { id, provider: "antigravity".into(), name })
                        .collect())
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
                if installing { "being installed" } else { "not installed. Install it to run sessions" }
            ));
        }
        None
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
    fn account(&self) -> BoxFut<'_, Result<AccountStatus, String>> {
        Box::pin(self.antigravity_account())
    }
    fn login(&self) -> Result<LoginCommand, String> {
        self.antigravity_login()
    }
    fn logout(&self) -> BoxFut<'_, Result<(), String>> {
        Box::pin(self.antigravity_logout())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_antigravity_with_its_vendors_script() {
        let (_, args) = install_command(Kernel::Antigravity);
        assert!(args.last().unwrap().contains("https://antigravity.google/cli/install"), "{args:?}");
        assert_eq!(install_timeout(Kernel::Antigravity), Duration::from_secs(600));
    }

    #[test]
    fn reads_an_installers_redrawn_progress_as_lines_without_colours() {
        let mut pending = Vec::new();
        let lines =
            output_lines(&mut pending, "\u{1b}[2m  Downloading\u{1b}[0m\nReceiving:   3% (1/30), 8.04 MiB | 116.00 KiB/s\rReceiving:   4% (2/".as_bytes());
        assert_eq!(lines, ["Downloading", "Receiving:   3% (1/30), 8.04 MiB | 116.00 KiB/s"]);
        assert_eq!(output_lines(&mut pending, b"30)\r\r\n"), ["Receiving:   4% (2/30)"]);
        assert!(pending.is_empty());

        let mut tail = OutputTail::default();
        for line in ["==> Downloading", "Receiving:   3% (1/30)", "Receiving:   4% (2/30)", "fatal: early EOF"] {
            tail.push(line.into());
        }
        assert_eq!(tail.text(), "==> Downloading\nReceiving:   4% (2/30)\nfatal: early EOF");
    }

    #[test]
    fn says_why_antigravity_cannot_run() {
        let kernels = RealKernels { find: Arc::new(|_| None), installing: Default::default(), env: BTreeMap::new(), hook_relay: Vec::new() };
        assert!(kernels.unavailable(Kernel::Antigravity).unwrap().contains("agy"));
        kernels.installing.lock().unwrap().insert(Kernel::Antigravity, String::new());
        assert!(kernels.unavailable(Kernel::Antigravity).unwrap().contains("being installed"));
    }
}
