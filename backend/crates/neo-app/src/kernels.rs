//! The agent runtimes behind Sessions: what a Session of each role needs, and how each kernel provides it.

use crate::http;
use crate::settings::{Kernel, RoleModel};
use neo_core::ids::key;
use neo_kernel::antigravity::{self, Antigravity, AntigravityDriver, AntigravityOptions};
use neo_kernel::claude::{self, Claude, ClaudeDriver, ClaudeOptions, Subagent};
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
        Kernel::Omp => Support { thinking_levels: vec!["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] },
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
    }
}

/// The kernel's name for people.
pub fn display_name(kernel: Kernel) -> &'static str {
    match kernel {
        Kernel::Omp => "Oh My Pi",
        Kernel::Claude => "Claude Code",
        Kernel::Antigravity => "Antigravity CLI",
    }
}

/// The official installer of each kernel's program, as a shell command: a script fetched from the vendor that puts
/// the program in the user's own folders, with no administrator rights.
pub fn install_command(kernel: Kernel) -> (&'static str, Vec<String>) {
    let (script, windows_script) = match kernel {
        Kernel::Claude => ("https://claude.ai/install.sh", "https://claude.ai/install.ps1"),
        Kernel::Omp => ("https://omp.sh/install", "https://omp.sh/install.ps1"),
        Kernel::Antigravity => ("https://antigravity.google/cli/install.sh", "https://antigravity.google/cli/install.ps1"),
    };
    if cfg!(windows) {
        let command = format!("$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; irm {windows_script} | iex");
        ("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &command].map(String::from).to_vec())
    } else {
        ("bash", vec!["-c".into(), format!("set -o pipefail; curl -fsSL {script} | bash")])
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
    /// The kernels whose programs are being installed.
    pub installing: std::sync::Mutex<std::collections::BTreeSet<Kernel>>,
    /// The shim extension file for Oh My Pi.
    pub shim: PathBuf,
    /// Variables to set for every runtime, on top of the host's environment.
    pub env: BTreeMap<String, String>,
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

    fn require(&self, kernel: Kernel) -> Result<PathBuf, String> {
        self.program(kernel).ok_or_else(|| self.unavailable(kernel).unwrap_or_default())
    }

    async fn run_installer(&self, kernel: Kernel) -> Result<PathBuf, String> {
        let name = display_name(kernel);
        let (program, args) = install_command(kernel);
        let mut command = tokio::process::Command::new(program);
        command.args(&args).stdin(std::process::Stdio::null()).kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(600), command.output())
            .await
            .map_err(|_| format!("Installing {name} took longer than 10 minutes and was stopped"))?
            .map_err(|error| format!("Cannot run {program} to install {name}: {error}"))?;
        if !output.status.success() {
            let text = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|line| !line.trim().is_empty()).collect();
            let tail = lines[lines.len().saturating_sub(12)..].join("\n");
            return Err(format!("Installing {name} failed ({}):\n{tail}", output.status));
        }
        self.program(kernel)
            .ok_or_else(|| format!("The {name} installer finished, but its program ({}) was not found where it installs itself", program_name(kernel)))
    }

    fn claude_env(&self) -> BTreeMap<String, String> {
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
            env: self.env.clone(),
        };
        Ok(Arc::new(Omp(OmpDriver::new(options, host, events))))
    }

    fn open_antigravity(&self, spec: &SessionSpec, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Result<Arc<dyn Driver>, String> {
        let program = self.require(Kernel::Antigravity)?;
        let names: Vec<String> = host.specs().into_iter().map(|tool| tool.name).collect();
        let worker = spec.role == SessionRole::Worker;
        let note = if worker {
            "Runtime note: you run in the Antigravity CLI. Tool names above map to `read_file`, `run_command`, `write_file` and `edit_file`; application tools are exposed as `mcp_neo_<name>`. There is no `task` or `wait` tool here, and no subagents: do the work yourself. Run commands in the foreground and wait for each to finish (check a long one with `command_status`) before you end your turn, because nothing wakes you after it. Do not use browser, image, scheduling or web-search tools unless the ticket asks for them."
        } else {
            "Runtime note: you run in the Antigravity CLI. Tool names above map to `read_file` and `run_command`; application tools are exposed as `mcp_neo_<name>`. Do not use browser, image, scheduling or web-search tools."
        };
        let tools: &[&str] = match spec.role {
            SessionRole::Worker => &["read", "bash", "edit", "write"],
            SessionRole::Sidecar => &["read"],
            SessionRole::Orchestrator | SessionRole::Watchdog => &["read", "bash"],
        };
        // The runtime picks its own effort; only an inspection turn, which decides from evidence it is handed, asks for low.
        let thinking = (spec.role == SessionRole::Watchdog).then(|| "low".to_string());
        let options = AntigravityOptions {
            program,
            cwd: spec.cwd.clone(),
            system_prompt: format!("{}\n\n{note}", claude::rename_tools(&spec.system_prompt, &names, antigravity::mcp_tool_name)),
            tools: tools.iter().map(|name| name.to_string()).collect(),
            model: spec.model.as_ref().map(|model| model.model.clone()),
            thinking,
            env: self.env.clone(),
        };
        Ok(Arc::new(Antigravity(AntigravityDriver::new(options, host, events))))
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
        }
    }
    fn models(&self, kernel: Kernel) -> BoxFut<'_, Result<Vec<ModelOption>, String>> {
        Box::pin(async move {
            match kernel {
                Kernel::Claude => self.claude_models().await,
                Kernel::Omp => {
                    let program = self.require(Kernel::Omp)?;
                    let mut models: Vec<ModelOption> = omp::list_models(&program, &self.agent_dir, &self.state_dir)
                        .await?
                        .into_iter()
                        .map(|model| ModelOption { id: model.id, provider: model.provider, name: model.name })
                        .collect();
                    models.sort_by(|a, b| (&a.provider, &a.id).cmp(&(&b.provider, &b.id)));
                    Ok(models)
                }
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
                if installing { "being installed" } else { "not installed. Install it, or choose another kernel" }
            ));
        }
        (kernel == Kernel::Omp && !self.shim.is_file())
            .then(|| format!("The Oh My Pi extension {} is missing; reinstall the application.", self.shim.display()))
    }
    fn install(&self, kernel: Kernel) -> BoxFut<'_, Result<PathBuf, String>> {
        Box::pin(async move {
            if !self.installing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(kernel) {
                return Err(format!("{} is already being installed", display_name(kernel)));
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
        self.installing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains(&kernel)
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
    fn offers_minimal_thinking_only_on_oh_my_pi_and_no_levels_on_antigravity() {
        assert!(support(Kernel::Omp).thinking_levels.contains(&"minimal"));
        assert!(!support(Kernel::Claude).thinking_levels.contains(&"minimal") && support(Kernel::Claude).thinking_levels.contains(&"max"));
        assert!(support(Kernel::Antigravity).thinking_levels.is_empty());
    }

    #[test]
    fn installs_each_kernel_with_its_vendors_script() {
        for (kernel, script) in
            [(Kernel::Claude, "claude.ai/install"), (Kernel::Omp, "omp.sh/install"), (Kernel::Antigravity, "antigravity.google/cli/install")]
        {
            let (_, args) = install_command(kernel);
            assert!(args.last().unwrap().contains(&format!("https://{script}")), "{args:?}");
        }
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
        };
        assert!(kernels.unavailable(Kernel::Claude).unwrap().contains("claude"));
        assert!(kernels.unavailable(Kernel::Antigravity).unwrap().contains("agy"));
        assert!(kernels.unavailable(Kernel::Omp).unwrap().contains("/missing/shim.ts"));
        kernels.installing.lock().unwrap().insert(Kernel::Claude);
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
