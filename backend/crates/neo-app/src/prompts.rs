//! The built-in prompts of each role, composed from the packaged prompt files with the execution environment and, for
//! the orchestrator, the Policy section, which comes last so a Policy change leaves the rest of the prompt unchanged.

use crate::policy::policy_version;
use crate::settings::Settings;
use neo_core::model::AcceptMode;
use std::path::Path;

macro_rules! packaged {
    ($name:literal) => {
        include_str!(concat!("../../../../assets/prompts/", $name, ".md"))
    };
}

/// A role whose Session has a composed system prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// The main Session: assesses and routes.
    Orchestrator,
    /// A ticket's Session: does the work.
    Worker,
}

/// Prompt files are written one sentence per line for readable diffs: lines within a paragraph are joined with
/// spaces, and each paragraph becomes one line.
pub fn prompt_file(text: &str) -> String {
    let text = text.replace("\r\n", "\n");
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in text.trim().lines() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                paragraphs.push(current.join(" "));
                current.clear();
            }
        } else {
            current.push(line.trim());
        }
    }
    if !current.is_empty() {
        paragraphs.push(current.join(" "));
    }
    paragraphs.join("\n")
}

/// The Sidecar's whole system prompt.
pub fn sidecar_prompt() -> String {
    prompt_file(packaged!("sidecar"))
}
/// The Watchdog's whole system prompt.
pub fn watchdog_prompt() -> String {
    prompt_file(packaged!("watchdog"))
}

/// One variable of the execution environment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Variable {
    /// Its name.
    pub key: &'static str,
    /// Its value here.
    pub value: String,
    /// What it is.
    pub description: &'static str,
}

/// A ticket's place in the execution environment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TicketPlace<'a> {
    /// The ticket id.
    pub id: &'a str,
    /// The ticket's short name, also its directory's name.
    pub name: &'a str,
    /// The ticket's directory.
    pub directory: &'a Path,
}

/// The variables a prepare command reads and a Session is told about; never credentials.
pub fn environment(settings: &Settings, ticket: Option<&TicketPlace<'_>>) -> Vec<Variable> {
    let mut variables = Vec::new();
    if let Some(ticket) = ticket {
        variables.push(Variable {
            key: "NEO_AGENT_DIR",
            value: ticket.directory.display().to_string(),
            description: "This ticket's directory; its worker Session works in it",
        });
        variables.push(Variable { key: "NEO_AGENT_NAME", value: ticket.name.to_string(), description: "The ticket's short name, also its directory's name" });
        variables.push(Variable { key: "NEO_AGENT_TICKET", value: ticket.id.to_string(), description: "The ticket id" });
    }
    variables.push(Variable {
        key: "NEO_AGENT_BLOCKED_COMMANDS",
        value: settings.executor.blocked_commands.join(" "),
        description: "Commands blocked in this execution environment, separated by spaces; never run them",
    });
    variables
}

const ENVIRONMENT_HEADING: &str = "Execution environment (from this installation's settings; an empty value means that part is not configured here). The prepare command of a ticket directory reads the same variables:";

fn environment_section(variables: &[Variable]) -> String {
    let lines: Vec<String> = variables
        .iter()
        .map(|variable| format!("- {} = {}: {}.", variable.key, serde_json::Value::String(variable.value.clone()), variable.description))
        .collect();
    format!("{ENVIRONMENT_HEADING}\n{}", lines.join("\n"))
}

/// The Watchdog Session's whole prompt: its instructions and the execution environment.
pub fn watchdog_system(settings: &Settings) -> String {
    format!("{}\n\n{}", watchdog_prompt(), environment_section(&environment(settings, None)))
}

/// The main Session's Policy section: the Policy version and accept mode it judges proactive candidates by, and every
/// enabled rule on one line, so a line of an instruction reads as no rule or heading of its own.
pub fn policy_section(settings: &Settings) -> String {
    let one_line = |text: &str| text.split('\n').map(str::trim).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    let rules: Vec<String> = settings
        .policy
        .rules
        .iter()
        .filter(|rule| rule.enabled)
        .map(|rule| format!("- {} ({}): {}", one_line(&rule.name), rule.id, one_line(&rule.instruction)))
        .collect();
    let mode = match settings.eval.mode {
        AcceptMode::Off => "off",
        AcceptMode::Observe => "observe",
        AcceptMode::Auto => "auto",
    };
    let head = format!(
        "## Policy\nPolicy version {}; accept mode {mode}. The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules.",
        policy_version(settings)
    );
    if rules.is_empty() {
        format!("{head} No rule is enabled: a proactive candidate can only be ignored.")
    } else {
        format!("{head} The enabled rules, by name and id:\n{}", rules.join("\n"))
    }
}

/// A role's system prompt without the Policy section: every ticket's worker shares one, so providers cache it once.
pub fn compose(role: Role, settings: &Settings) -> String {
    let guide = |name: &str, text: &str| format!("## {name}\n{}", prompt_file(text));
    let mut sections = vec![
        prompt_file(packaged!("shared")),
        prompt_file(if role == Role::Orchestrator { packaged!("orchestrator") } else { packaged!("worker") }),
        guide("Communication", packaged!("team/communication")),
    ];
    match role {
        Role::Orchestrator => {
            sections.push(guide("subscriptions", packaged!("subscriptions")));
            sections.push(guide("replies", packaged!("replies")));
            sections.push(guide("dispatch", packaged!("dispatch")));
            sections.push(prompt_file(packaged!("admission")));
            sections.push(format!("{}\n{}", prompt_file(packaged!("handoff")), prompt_file(packaged!("handoff-orchestrator"))));
        }
        Role::Worker => {
            sections.push(guide("Ticket scope", packaged!("team/scope")));
            sections.push(guide("Delivery requirements", packaged!("team/delivery")));
            sections.push(guide("replies", packaged!("replies")));
            sections.push(guide("work", packaged!("work")));
            sections.push(format!("{}\n{}", prompt_file(packaged!("handoff")), prompt_file(packaged!("handoff-worker"))));
        }
    }
    // A worker's prompt names no ticket: each ticket's own values arrive with its assignment.
    sections.push(environment_section(&environment(settings, None)));
    if role == Role::Orchestrator {
        sections.push(policy_section(settings));
    }
    sections.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_the_lines_of_a_paragraph_and_keeps_paragraph_breaks() {
        assert_eq!(prompt_file("One.\r\n  Two.  \n\n \nThree.\nFour.\n\n"), "One. Two.\nThree. Four.");
        assert_eq!(prompt_file("- a\n- b"), "- a - b");
        assert_eq!(prompt_file(""), "");
    }

    #[test]
    fn composes_each_roles_prompt_from_its_own_sections_in_order() {
        let settings = Settings::default();
        let orchestrator = compose(Role::Orchestrator, &settings);
        let worker = compose(Role::Worker, &settings);
        let order = |text: &str, parts: &[&str]| {
            let mut from = 0;
            for part in parts {
                let at = text[from..].find(part).unwrap_or_else(|| panic!("{part:?} is missing or out of order"));
                from += at + part.len();
            }
        };
        order(
            &orchestrator,
            &[
                "The orchestrator decides candidates",
                "You are the orchestrator",
                "## Communication",
                "## subscriptions",
                "## replies",
                "## dispatch",
                "Assess proactive candidates yourself",
                "Ticket handoff contract",
                "For an active ticket.attention",
                "Execution environment",
                "## Policy",
            ],
        );
        order(
            &worker,
            &[
                "The orchestrator decides candidates",
                "You are a worker.",
                "## Communication",
                "## Ticket scope",
                "## Delivery requirements",
                "## replies",
                "## work",
                "Ticket handoff contract",
                "Use orchestrator_report human_action",
                "Execution environment",
            ],
        );
        assert!(
            !worker.contains("## Policy")
                && !worker.contains("## dispatch")
                && !worker.contains("## subscriptions")
                && !worker.contains("You are the orchestrator")
        );
        assert!(
            !orchestrator.contains("## work\n")
                && !orchestrator.contains("## Ticket scope")
                && !orchestrator.contains("## Delivery requirements")
                && !orchestrator.contains("You are a worker.")
        );
        // The Policy section closes the orchestrator's prompt, so changing it keeps the prefix before it.
        assert!(orchestrator.ends_with(&policy_section(&settings)));
        let mut changed = settings.clone();
        changed.policy.rules[0].enabled = false;
        let again = compose(Role::Orchestrator, &changed);
        let prefix = orchestrator.len() - policy_section(&settings).len();
        assert_eq!(orchestrator[..prefix], again[..prefix]);
        assert_ne!(orchestrator, again);
        assert_eq!(compose(Role::Worker, &changed), worker, "a worker's prompt does not depend on the rules");
    }

    #[test]
    fn names_no_removed_integration_in_any_prompt() {
        let settings = Settings::default();
        for text in [compose(Role::Orchestrator, &settings), compose(Role::Worker, &settings), sidecar_prompt(), watchdog_prompt()] {
            let words: Vec<&str> = text.split(|c: char| !c.is_alphanumeric()).collect();
            for word in ["GitHub", "github", "gh", "PR", "PRs", "CI"] {
                assert!(!words.contains(&word), "a prompt still mentions {word:?}");
            }
            assert!(!text.contains("pull request") && text.len() > 500);
        }
    }

    #[test]
    fn lists_the_enabled_rules_one_per_line_or_says_there_are_none() {
        let mut settings = Settings::default();
        settings.policy.rules[0].instruction = "First line.\n\n  Second line.".into();
        settings.policy.rules[1].enabled = false;
        let section = policy_section(&settings);
        assert!(section.starts_with(&format!("## Policy\nPolicy version {}; accept mode observe.", policy_version(&settings))));
        assert!(section.ends_with("The enabled rules, by name and id:\n- Copy fixes (copy): First line. Second line."), "{section}");
        settings.policy.rules[0].enabled = false;
        settings.eval.mode = AcceptMode::Auto;
        let none = policy_section(&settings);
        assert!(none.contains("accept mode auto") && none.ends_with("No rule is enabled: a proactive candidate can only be ignored."));
    }

    #[test]
    fn describes_the_execution_environment_with_quoted_values() {
        let mut settings = Settings::default();
        settings.executor.blocked_commands = vec!["docker".into(), "kubectl".into()];
        let general = environment(&settings, None);
        assert_eq!(general.iter().map(|variable| variable.key).collect::<Vec<_>>(), vec!["NEO_AGENT_BLOCKED_COMMANDS"]);
        let place = TicketPlace { id: "t1", name: "fix-typo", directory: Path::new("/data/work/fix \"typo\"") };
        let ticket = environment(&settings, Some(&place));
        assert_eq!(
            ticket.iter().map(|variable| variable.key).collect::<Vec<_>>(),
            vec!["NEO_AGENT_DIR", "NEO_AGENT_NAME", "NEO_AGENT_TICKET", "NEO_AGENT_BLOCKED_COMMANDS"]
        );
        let section = environment_section(&ticket);
        assert!(section.contains("- NEO_AGENT_DIR = \"/data/work/fix \\\"typo\\\"\": This ticket's directory; its worker Session works in it."));
        assert!(section.contains("- NEO_AGENT_BLOCKED_COMMANDS = \"docker kubectl\": Commands blocked"));
        assert!(compose(Role::Worker, &settings).contains("- NEO_AGENT_BLOCKED_COMMANDS = \"docker kubectl\""));
    }
}
