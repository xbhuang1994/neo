//! The agent runtimes behind Sessions: what a Session of each role needs, and how each kernel provides it.

use crate::http;
use crate::settings::{Kernel, RoleModel};
use neo_core::ids::key;
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
    /// A second model that reviews each turn, where the kernel has one.
    pub advisor: Option<RoleModel>,
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
    /// It can run an advisor model.
    pub advisor: bool,
    /// The thinking levels it takes.
    pub thinking_levels: Vec<&'static str>,
}

/// What each kernel's settings offer.
pub fn support(kernel: Kernel) -> Support {
    match kernel {
        Kernel::Omp => Support { advisor: true, thinking_levels: vec!["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] },
        Kernel::Claude => Support { advisor: false, thinking_levels: vec!["auto", "off", "low", "medium", "high", "xhigh", "max"] },
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
}

/// The real runtimes: the `claude` and `omp` programs.
pub struct RealKernels {
    /// The data directory, where prompt files, overlays and runtime sessions are kept.
    pub state_dir: PathBuf,
    /// Oh My Pi's agent directory.
    pub agent_dir: PathBuf,
    /// The `claude` program, when found.
    pub claude: Option<PathBuf>,
    /// The `omp` program, when found.
    pub omp: Option<PathBuf>,
    /// The shim extension file for Oh My Pi.
    pub shim: PathBuf,
    /// Variables to set for every runtime, on top of the host's environment.
    pub env: BTreeMap<String, String>,
}

const OVERLAY_COMMON: &str = "launch:\n  enabled: false\nretry:\n  enabled: true\ncompaction:\n  enabled: true\n";

fn overlay(role: SessionRole, advisor: Option<&RoleModel>) -> String {
    let mut text = OVERLAY_COMMON.to_string();
    if role == SessionRole::Worker {
        // A worker's long commands and subagents run as background jobs, whose ends wake it.
        text.push_str("  thresholdTokens: 100000\n  keepRecentTokens: 20000\nasync:\n  enabled: true\nbash:\n  autoBackground:\n    enabled: true\n    thresholdMs: 60000\nproviders:\n  cacheWarming: streaming\ntask:\n  maxConcurrency: 8\n  maxRecursionDepth: 2\n");
    } else {
        // The orchestrator resends its whole history with every candidate: compact it early.
        text.push_str("  thresholdTokens: 60000\n  keepRecentTokens: 8000\nasync:\n  enabled: false\nbash:\n  autoBackground:\n    enabled: false\n");
    }
    if let Some(model) = advisor {
        text.push_str(&format!("advisor:\n  enabled: true\nmodelRoles:\n  advisor: {}\n", selector(model)));
    }
    text
}

/// Oh My Pi's selector for a role model: `provider/model`, with `:level` when a thinking level is set.
fn selector(model: &RoleModel) -> String {
    match model.thinking_level.as_deref() {
        Some(level) => format!("{}/{}:{level}", model.provider, model.model),
        None => format!("{}/{}", model.provider, model.model),
    }
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
    fn claude_env(&self) -> BTreeMap<String, String> {
        // The user's Claude Code settings fill in what the process environment does not say.
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
        let mut env: BTreeMap<String, String> =
            claude::user_environment(&home.join(".claude").join("settings.json")).into_iter().filter(|(name, _)| std::env::var_os(name).is_none()).collect();
        env.extend(self.env.clone());
        env
    }

    fn open_claude(&self, spec: &SessionSpec, host: Arc<dyn ToolHost>, events: mpsc::UnboundedSender<DriverEvent>) -> Result<Arc<dyn Driver>, String> {
        let program = self.claude.clone().ok_or_else(|| self.unavailable(Kernel::Claude).unwrap_or_default())?;
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
        let program = self.omp.clone().ok_or_else(|| self.unavailable(Kernel::Omp).unwrap_or_default())?;
        let kernel_dir = self.state_dir.join("kernel");
        let worker = spec.role == SessionRole::Worker;
        let advisor = spec.advisor.as_ref().filter(|_| worker);
        let overlay_text = overlay(spec.role, advisor);
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
            advisor: advisor.is_some(),
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
        }
    }
    fn models(&self, kernel: Kernel) -> BoxFut<'_, Result<Vec<ModelOption>, String>> {
        Box::pin(async move {
            match kernel {
                Kernel::Claude => self.claude_models().await,
                Kernel::Omp => {
                    let program = self.omp.clone().ok_or_else(|| self.unavailable(Kernel::Omp).unwrap_or_default())?;
                    let mut models: Vec<ModelOption> = omp::list_models(&program, &self.agent_dir, &self.state_dir)
                        .await?
                        .into_iter()
                        .map(|model| ModelOption { id: model.id, provider: model.provider, name: model.name })
                        .collect();
                    models.sort_by(|a, b| (&a.provider, &a.id).cmp(&(&b.provider, &b.id)));
                    Ok(models)
                }
            }
        })
    }
    fn unavailable(&self, kernel: Kernel) -> Option<String> {
        match kernel {
            Kernel::Claude if self.claude.is_none() => {
                Some("The Claude Code program (claude) was not found. Install it, or choose the other kernel in Settings.".into())
            }
            Kernel::Omp if self.omp.is_none() => Some("The Oh My Pi program (omp) was not found. Install it, or choose the other kernel in Settings.".into()),
            Kernel::Omp if !self.shim.is_file() => Some(format!("The Oh My Pi extension {} is missing; reinstall the application.", self.shim.display())),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_worker_overlay_with_background_jobs_and_an_orchestrator_one_without() {
        let worker = overlay(SessionRole::Worker, None);
        assert!(
            worker.contains("async:\n  enabled: true")
                && worker.contains("thresholdMs: 60000")
                && worker.contains("thresholdTokens: 100000")
                && worker.contains("maxConcurrency: 8")
        );
        assert!(!worker.contains("advisor"));
        let main = overlay(SessionRole::Orchestrator, None);
        assert!(main.contains("async:\n  enabled: false") && main.contains("thresholdTokens: 60000") && !main.contains("cacheWarming"));
        let advised = overlay(SessionRole::Worker, Some(&RoleModel { provider: "fixture".into(), model: "big".into(), thinking_level: Some("high".into()) }));
        assert!(advised.ends_with("advisor:\n  enabled: true\nmodelRoles:\n  advisor: fixture/big:high\n"));
    }

    #[test]
    fn offers_an_advisor_and_minimal_thinking_only_on_oh_my_pi() {
        assert!(support(Kernel::Omp).advisor && support(Kernel::Omp).thinking_levels.contains(&"minimal"));
        assert!(!support(Kernel::Claude).advisor && !support(Kernel::Claude).thinking_levels.contains(&"minimal"));
    }

    #[test]
    fn says_why_a_kernel_cannot_run() {
        let kernels = RealKernels {
            state_dir: "/s".into(),
            agent_dir: "/a".into(),
            claude: None,
            omp: Some("/bin/omp".into()),
            shim: "/missing/shim.ts".into(),
            env: BTreeMap::new(),
        };
        assert!(kernels.unavailable(Kernel::Claude).unwrap().contains("claude"));
        assert!(kernels.unavailable(Kernel::Omp).unwrap().contains("/missing/shim.ts"));
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
