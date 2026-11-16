//! Settings: everything a person configures in the app, validated here and stored as numbered revisions.

use neo_core::model::AcceptMode;
use neo_store::Store;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// The Source of messages from the app, the web page and a bound WeChat account.
pub const CHAT_SOURCE: &str = "chat";
/// The sender of messages typed into the app or the web page.
pub const WEB_SENDER: &str = "web:local";
/// The conversation of the app and the web page.
pub const WEB_THREAD: &str = "web:main";

/// Validation bounds, shared with the settings forms.
pub mod limits {
    /// Longest rule name, in characters.
    pub const RULE_NAME: usize = 100;
    /// Longest rule instruction, in characters.
    pub const RULE_INSTRUCTION: usize = 2000;
    /// Shortest and longest Eval timeout, in seconds.
    pub const EVAL_TIMEOUT_SECONDS: (u32, u32) = (30, 600);
    /// Fewest and most concurrent workers.
    pub const MAX_WORKERS: (u32, u32) = (1, 16);
    /// Longest prepare command, in characters.
    pub const PREPARE_COMMAND: usize = 4000;
}

/// The agent runtime that runs sessions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kernel {
    /// Oh My Pi, driven over its RPC mode.
    #[default]
    Omp,
    /// Claude Code, driven over its stream-json protocol.
    Claude,
    /// The Antigravity CLI, driven over the Agent Client Protocol.
    Antigravity,
}

impl Kernel {
    /// The kernel's name in settings and API payloads.
    pub fn as_str(self) -> &'static str {
        match self {
            Kernel::Omp => "omp",
            Kernel::Claude => "claude",
            Kernel::Antigravity => "antigravity",
        }
    }
}

/// An assessment rule for proactive candidates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    /// Stable id, `[A-Za-z0-9_-]{1,80}`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Whether assessments may match it.
    pub enabled: bool,
    /// What it admits, in words for the assessor.
    pub instruction: String,
}

/// A sender on a Source's list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Allowed {
    /// The sender's id on its Source.
    pub id: String,
    /// A display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// What an admission cell grants.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Admission {
    /// Nothing.
    Ignore,
    /// A candidate the agent may propose under its rules.
    Inferred,
    /// An explicit request.
    Explicit,
}

/// One receiving scope's row of the admission table. A listed sender who addresses the agent always makes an explicit
/// request and has no cell; an unaddressed message cannot be explicit.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdmissionRow {
    /// A listed sender who did not address the agent: `inferred` by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listed_unaddressed: Option<Admission>,
    /// An unlisted sender who addressed the agent: `ignore` by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlisted_addressed: Option<Admission>,
    /// An unlisted sender who did not address the agent: `ignore` by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlisted_unaddressed: Option<Admission>,
}

/// Who may originate work on one Source.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcePolicy {
    /// The senders whose direct requests are explicit.
    #[serde(default)]
    pub allowed: Vec<Allowed>,
    /// Bots whose messages are inferred candidates at most.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bots: Vec<Allowed>,
    /// The admission table, by receiving scope.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub admission: BTreeMap<String, AdmissionRow>,
}

/// Rules and senders: what authorizes work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyConfig {
    /// The assessment rules.
    #[serde(default = "default_rules")]
    pub rules: Vec<Rule>,
    /// Who may originate work, by Source.
    #[serde(default = "default_sources")]
    pub sources: BTreeMap<String, SourcePolicy>,
}

fn default_rules() -> Vec<Rule> {
    vec![
        Rule {
            id: "copy".into(),
            name: "Copy fixes".into(),
            enabled: true,
            instruction: "Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.".into(),
        },
        Rule {
            id: "visual".into(),
            name: "Visual fixes".into(),
            enabled: true,
            instruction: "Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.".into(),
        },
    ]
}

fn default_sources() -> BTreeMap<String, SourcePolicy> {
    BTreeMap::from([(CHAT_SOURCE.to_string(), SourcePolicy { allowed: vec![Allowed { id: WEB_SENDER.into(), name: None }], ..Default::default() })])
}

impl Default for PolicyConfig {
    fn default() -> Self {
        PolicyConfig { rules: default_rules(), sources: default_sources() }
    }
}

/// How proactive candidates are assessed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvalConfig {
    /// Whether candidates are assessed and accepted.
    #[serde(default = "default_mode")]
    pub mode: AcceptMode,
    /// How long an assessment may take.
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u32,
}

fn default_mode() -> AcceptMode {
    AcceptMode::Observe
}
fn default_timeout() -> u32 {
    120
}

impl Default for EvalConfig {
    fn default() -> Self {
        EvalConfig { mode: default_mode(), timeout_seconds: default_timeout() }
    }
}

/// How workers run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutorConfig {
    /// How many workers may run at once.
    #[serde(default = "default_workers")]
    pub max_workers: u32,
    /// Where ticket directories are created; empty for `<data dir>/work`.
    #[serde(default)]
    pub directory: String,
    /// A shell command that prepares each ticket's directory; `NEO_AGENT_DIR` names the directory.
    #[serde(default)]
    pub prepare: String,
    /// The shell that runs `prepare`, such as `pwsh`; the platform's default when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepare_shell: Option<String>,
    /// Command names workers may not run.
    #[serde(default)]
    pub blocked_commands: Vec<String>,
}

fn default_workers() -> u32 {
    3
}

impl Default for ExecutorConfig {
    fn default() -> Self {
        ExecutorConfig { max_workers: default_workers(), directory: String::new(), prepare: String::new(), prepare_shell: None, blocked_commands: Vec::new() }
    }
}

/// A model choice for one role.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleModel {
    /// The provider, as the kernel names it; ignored by Claude Code.
    pub provider: String,
    /// The model id.
    pub model: String,
    /// One of [`THINKING_LEVELS`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
}

/// The thinking levels a role model may name.
pub const THINKING_LEVELS: &[&str] = &["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// One kernel's model choices; `None` follows the kernel's default, and for the advisor turns it off.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleModels {
    /// The orchestrator, which assesses and routes.
    #[serde(default)]
    pub eval: Option<RoleModel>,
    /// The workers.
    #[serde(default)]
    pub executor: Option<RoleModel>,
    /// A second model that reviews each worker turn.
    #[serde(default)]
    pub advisor: Option<RoleModel>,
}

/// Everything a person configures.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    /// Processing is paused: nothing is assessed, launched or sent.
    #[serde(default)]
    pub paused: bool,
    /// The agent runtime in use.
    #[serde(default)]
    pub kernel: Kernel,
    /// What authorizes work.
    #[serde(default)]
    pub policy: PolicyConfig,
    /// How candidates are assessed.
    #[serde(default)]
    pub eval: EvalConfig,
    /// How workers run.
    #[serde(default)]
    pub executor: ExecutorConfig,
    /// Each kernel's own model choices.
    #[serde(default)]
    pub models: BTreeMap<Kernel, RoleModels>,
}

fn id_like(text: &str, max: usize) -> bool {
    (1..=max).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn sized(what: &str, text: &str, max: usize) -> Result<(), String> {
    let length = text.trim().chars().count();
    if length == 0 || length > max {
        return Err(format!("{what} must have 1 to {max} characters"));
    }
    Ok(())
}

impl Settings {
    /// Parse and validate settings from JSON; unknown keys are refused.
    pub fn parse(value: serde_json::Value) -> Result<Settings, String> {
        let mut settings: Settings = serde_json::from_value(value).map_err(|error| format!("Invalid settings: {error}"))?;
        settings.normalize();
        settings.validate()?;
        Ok(settings)
    }

    /// Trim the text fields people type.
    pub fn normalize(&mut self) {
        for rule in &mut self.policy.rules {
            rule.name = rule.name.trim().to_string();
            rule.instruction = rule.instruction.trim().to_string();
        }
        for policy in self.policy.sources.values_mut() {
            for entry in policy.allowed.iter_mut().chain(policy.bots.iter_mut()) {
                entry.id = entry.id.trim().to_string();
                entry.name = entry.name.take().map(|name| name.trim().to_string()).filter(|name| !name.is_empty());
            }
        }
        self.executor.directory = self.executor.directory.trim().to_string();
        self.executor.prepare_shell = self.executor.prepare_shell.take().map(|shell| shell.trim().to_string()).filter(|shell| !shell.is_empty());
        for models in self.models.values_mut() {
            for model in [&mut models.eval, &mut models.executor, &mut models.advisor].into_iter().flatten() {
                model.provider = model.provider.trim().to_string();
                model.model = model.model.trim().to_string();
            }
        }
    }

    /// Check every bound; the first problem is returned in words.
    pub fn validate(&self) -> Result<(), String> {
        let mut seen = BTreeSet::new();
        for rule in &self.policy.rules {
            if !id_like(&rule.id, 80) {
                return Err(format!("Rule id {:?} must be 1 to 80 letters, digits, _ or -", rule.id));
            }
            if !seen.insert(rule.id.as_str()) {
                return Err(format!("Duplicate rule id {}", rule.id));
            }
            sized("A rule name", &rule.name, limits::RULE_NAME)?;
            sized("A rule instruction", &rule.instruction, limits::RULE_INSTRUCTION)?;
        }
        for (source, policy) in &self.policy.sources {
            let named = source.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
                && source.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            if !named {
                return Err(format!("Source name {source:?} must be lowercase letters, digits and -"));
            }
            for entry in policy.allowed.iter().chain(&policy.bots) {
                sized("A sender id", &entry.id, 200)?;
                if entry.name.as_ref().is_some_and(|name| name.chars().count() > 100) {
                    return Err("A sender name must have at most 100 characters".into());
                }
                if source == CHAT_SOURCE && entry.id != WEB_SENDER && entry.id.strip_prefix("wechat:").is_none_or(|rest| rest.is_empty()) {
                    return Err(format!("A chat sender is {WEB_SENDER} or wechat:<id>, not {:?}", entry.id));
                }
            }
            for row in policy.admission.values() {
                if row.listed_unaddressed == Some(Admission::Explicit) || row.unlisted_unaddressed == Some(Admission::Explicit) {
                    return Err("A message that does not address the agent cannot be an explicit request".into());
                }
            }
        }
        let (least, most) = limits::EVAL_TIMEOUT_SECONDS;
        if !(least..=most).contains(&self.eval.timeout_seconds) {
            return Err(format!("The assessment timeout must be {least} to {most} seconds"));
        }
        let (least, most) = limits::MAX_WORKERS;
        if !(least..=most).contains(&self.executor.max_workers) {
            return Err(format!("The number of workers must be {least} to {most}"));
        }
        if !self.executor.directory.is_empty() && !Path::new(&self.executor.directory).is_absolute() {
            return Err("The ticket directory must be an absolute path, or empty for the default".into());
        }
        if self.executor.prepare.chars().count() > limits::PREPARE_COMMAND {
            return Err(format!("The prepare command must have at most {} characters", limits::PREPARE_COMMAND));
        }
        for name in &self.executor.blocked_commands {
            let command = !name.is_empty() && name != "." && name != ".." && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
            if !command {
                return Err(format!("{name:?} is not a command name"));
            }
        }
        for models in self.models.values() {
            for model in [&models.eval, &models.executor, &models.advisor].into_iter().flatten() {
                if model.provider.is_empty() || model.model.is_empty() {
                    return Err("A model needs a provider and a model id".into());
                }
                if model.thinking_level.as_deref().is_some_and(|level| !THINKING_LEVELS.contains(&level)) {
                    return Err(format!("Unknown thinking level {:?}", model.thinking_level.as_deref().unwrap_or("")));
                }
            }
        }
        Ok(())
    }

    /// The current kernel's model choices.
    pub fn role_models(&self) -> RoleModels {
        self.models.get(&self.kernel).cloned().unwrap_or_default()
    }

    /// The listed sender an actor is, compared without case.
    pub fn allowed_sender(&self, source: &str, id: &str) -> Option<&Allowed> {
        self.policy.sources.get(source)?.allowed.iter().find(|entry| entry.id.eq_ignore_ascii_case(id))
    }
    /// The listed bot an actor is.
    pub fn listed_bot(&self, source: &str, id: &str) -> Option<&Allowed> {
        self.policy.sources.get(source)?.bots.iter().find(|entry| entry.id.eq_ignore_ascii_case(id))
    }
    /// Put a chat sender on the list, such as the WeChat account a person just bound. Returns whether it was added.
    pub fn allow_chat_sender(&mut self, id: &str) -> bool {
        if self.allowed_sender(CHAT_SOURCE, id).is_some() {
            return false;
        }
        self.policy.sources.entry(CHAT_SOURCE.to_string()).or_default().allowed.push(Allowed { id: id.to_string(), name: None });
        true
    }
    /// Take a chat sender off the list. Returns whether it was there.
    pub fn disallow_chat_sender(&mut self, id: &str) -> bool {
        let Some(policy) = self.policy.sources.get_mut(CHAT_SOURCE) else { return false };
        let before = policy.allowed.len();
        policy.allowed.retain(|entry| !entry.id.eq_ignore_ascii_case(id));
        policy.allowed.len() != before
    }
}

const REVISION: &str = "settings-revision";
const VERSION: &str = "settings-version:";

/// One saved revision of the settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsVersion {
    /// The revision number, from 1.
    pub revision: u64,
    /// When it was saved.
    pub saved_at: String,
    /// Who saved it: `app`, `tool` or `internal`.
    pub source: String,
    /// The Policy version it produced.
    pub policy_version: String,
    /// The settings.
    pub settings: Settings,
}

/// The stored settings: the current ones are the snapshot of the latest revision.
pub struct SettingsStore<'a>(pub &'a Store);

impl SettingsStore<'_> {
    /// The current revision number, or 0 before the first save.
    pub fn revision(&self) -> u64 {
        self.0.get(REVISION).unwrap_or(0)
    }
    /// The current settings; the defaults before the first save.
    pub fn current(&self) -> Settings {
        self.0.get::<SettingsVersion>(&format!("{VERSION}{}", self.revision())).map(|version| version.settings).unwrap_or_default()
    }
    /// Save validated settings as the next revision, which becomes current.
    pub fn save(&self, settings: &Settings, source: &str, policy_version: &str, saved_at: &str) -> Result<SettingsVersion, String> {
        settings.validate()?;
        self.0.atomic(|| {
            let version = SettingsVersion {
                revision: self.revision() + 1,
                saved_at: saved_at.to_string(),
                source: source.to_string(),
                policy_version: policy_version.to_string(),
                settings: settings.clone(),
            };
            self.0.set(&format!("{VERSION}{}", version.revision), &version);
            self.0.set(REVISION, &version.revision);
            Ok(version)
        })
    }
    /// Saved revisions, newest first.
    pub fn history(&self, limit: usize) -> Vec<SettingsVersion> {
        let mut versions: Vec<SettingsVersion> = self.0.keys(VERSION).iter().filter_map(|key| self.0.get(key)).collect();
        versions.sort_by_key(|version| std::cmp::Reverse(version.revision));
        versions.truncate(limit);
        versions
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_to_a_usable_configuration_with_the_local_sender_allowed() {
        let settings = Settings::parse(json!({})).unwrap();
        assert_eq!(settings, Settings::default());
        assert!(!settings.paused);
        assert_eq!(settings.kernel, Kernel::Omp);
        assert_eq!(settings.eval, EvalConfig { mode: AcceptMode::Observe, timeout_seconds: 120 });
        assert_eq!(settings.executor.max_workers, 3);
        assert_eq!(settings.policy.rules.iter().map(|rule| rule.id.as_str()).collect::<Vec<_>>(), vec!["copy", "visual"]);
        assert!(settings.allowed_sender(CHAT_SOURCE, "WEB:LOCAL").is_some());
        assert!(settings.allowed_sender(CHAT_SOURCE, "wechat:someone").is_none());
        assert_eq!(settings.role_models(), RoleModels::default());
    }

    #[test]
    fn refuses_unknown_keys_and_out_of_range_values_in_words() {
        let refused = |value: serde_json::Value| Settings::parse(value).unwrap_err();
        assert!(refused(json!({"github": {}})).contains("unknown field"));
        assert!(refused(json!({"executor": {"maxWorkers": 0}})).contains("1 to 16"));
        assert!(refused(json!({"executor": {"maxWorkers": 17}})).contains("1 to 16"));
        assert!(refused(json!({"eval": {"timeoutSeconds": 10}})).contains("30 to 600"));
        assert!(refused(json!({"eval": {"mode": "sometimes"}})).contains("Invalid settings"));
        assert!(refused(json!({"executor": {"directory": "relative/path"}})).contains("absolute"));
        assert!(refused(json!({"executor": {"blockedCommands": ["rm -rf"]}})).contains("not a command name"));
        assert!(refused(json!({"executor": {"blockedCommands": [".."]}})).contains("not a command name"));
        assert!(refused(json!({"executor": {"prepare": "x".repeat(4001)}})).contains("4000"));
        let rule = |id: &str, name: &str| json!({"id": id, "name": name, "enabled": true, "instruction": "Do it."});
        assert!(refused(json!({"policy": {"rules": [rule("a b", "A")]}})).contains("Rule id"));
        assert!(refused(json!({"policy": {"rules": [rule("a", "A"), rule("a", "B")]}})).contains("Duplicate rule id a"));
        assert!(refused(json!({"policy": {"rules": [rule("a", "   ")]}})).contains("rule name"));
        assert!(refused(json!({"policy": {"sources": {"chat": {"allowed": [{"id": "someone"}]}}}})).contains("wechat:<id>"));
        assert!(refused(json!({"policy": {"sources": {"Chat": {}}}})).contains("lowercase"));
        assert!(refused(json!({"policy": {"sources": {"chat": {"admission": {"row": {"listedUnaddressed": "explicit"}}}}}}))
            .contains("cannot be an explicit request"));
        assert!(refused(json!({"models": {"omp": {"eval": {"provider": "p", "model": "m", "thinkingLevel": "huge"}}}})).contains("thinking level"));
        assert!(refused(json!({"models": {"omp": {"eval": {"provider": " ", "model": "m"}}}})).contains("provider"));
        assert!(refused(json!({"models": {"omp": {"eval": {"provider": "p", "model": "m", "reasoningEffort": "high"}}}})).contains("unknown field"));
        assert!(refused(json!({"kernel": "gpt"})).contains("Invalid settings"));
    }

    #[test]
    fn keeps_each_kernels_models_apart_and_trims_what_people_type() {
        let settings = Settings::parse(json!({
            "kernel": "claude",
            "models": {
                "omp": {"executor": {"provider": " fixture ", "model": " big ", "thinkingLevel": "high"}},
                "claude": {"eval": {"provider": "anthropic", "model": "sonnet"}}
            },
            "executor": {"directory": "  ", "prepareShell": " pwsh ", "blockedCommands": ["docker", "kubectl.exe"]},
            "policy": {"sources": {"chat": {"allowed": [{"id": " web:local ", "name": "  "}, {"id": "wechat:abc@im.wechat", "name": " Me "}]}}}
        }))
        .unwrap();
        assert_eq!(settings.role_models().eval.map(|model| model.model), Some("sonnet".into()));
        assert_eq!(settings.role_models().executor, None);
        let omp = &settings.models[&Kernel::Omp];
        assert_eq!(omp.executor.as_ref().map(|model| (model.provider.as_str(), model.model.as_str())), Some(("fixture", "big")));
        assert_eq!((settings.executor.directory.as_str(), settings.executor.prepare_shell.as_deref()), ("", Some("pwsh")));
        let allowed = &settings.policy.sources[CHAT_SOURCE].allowed;
        assert_eq!(allowed[0], Allowed { id: "web:local".into(), name: None });
        assert_eq!(allowed[1].name.as_deref(), Some("Me"));
        // What is stored reads back the same.
        assert_eq!(Settings::parse(serde_json::to_value(&settings).unwrap()).unwrap(), settings);
    }

    #[test]
    fn adds_and_removes_a_bound_chat_sender_once() {
        let mut settings = Settings::default();
        assert!(settings.allow_chat_sender("wechat:abc"));
        assert!(!settings.allow_chat_sender("wechat:ABC"));
        assert_eq!(settings.policy.sources[CHAT_SOURCE].allowed.len(), 2);
        settings.validate().unwrap();
        assert!(settings.disallow_chat_sender("wechat:abc"));
        assert!(!settings.disallow_chat_sender("wechat:abc"));
        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn saves_numbered_revisions_and_reads_the_latest_as_current() {
        let store = Store::memory();
        let stored = SettingsStore(&store);
        assert_eq!((stored.revision(), stored.current()), (0, Settings::default()));
        let mut settings = Settings::default();
        settings.executor.max_workers = 5;
        let first = stored.save(&settings, "app", "v1", "2026-01-01T00:00:00.000Z").unwrap();
        settings.paused = true;
        let second = stored.save(&settings, "tool", "v1", "2026-01-01T00:01:00.000Z").unwrap();
        assert_eq!((first.revision, second.revision, stored.revision()), (1, 2, 2));
        assert_eq!(stored.current(), settings);
        assert_eq!(stored.history(10).iter().map(|version| (version.revision, version.source.as_str())).collect::<Vec<_>>(), vec![(2, "tool"), (1, "app")]);
        assert_eq!(stored.history(1).len(), 1);
        // An invalid save changes nothing.
        settings.executor.max_workers = 99;
        assert!(stored.save(&settings, "app", "v1", "t").is_err());
        assert_eq!(stored.revision(), 2);
        assert_eq!(stored.current().executor.max_workers, 5);
    }
}
