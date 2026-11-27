use crate::enroll::{
    default_config_dir, default_ota_cache_dir, default_workspace_dir, is_linux_root_with_systemd,
    validate_cluster_id, EffectiveMode,
};
use crate::policy::PolicyConfig;
use clap::{Args, ValueEnum};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum UninstallModeArg {
    Auto,
    System,
    User,
}

#[derive(Debug, Clone, Args)]
pub struct UninstallArgs {
    /// Cluster identifier to uninstall
    #[arg(long)]
    pub cluster: String,

    /// Uninstall mode (auto detects system vs user)
    #[arg(long, value_enum, default_value_t = UninstallModeArg::Auto)]
    pub mode: UninstallModeArg,

    /// Override configuration directory containing policy-<cluster>.toml and cluster-<cluster>.env
    #[arg(long)]
    pub config_dir: Option<PathBuf>,

    /// Also delete the cluster workspace directory (preserved by default)
    #[arg(long, default_value_t = false)]
    pub purge_workspace: bool,
}

#[derive(Debug, Clone)]
pub struct UninstallOutcome {
    pub cluster_id: String,
    pub mode: EffectiveMode,
    pub removed_paths: Vec<PathBuf>,
    pub preserved_workspaces: Vec<PathBuf>,
    pub purged_workspaces: Vec<PathBuf>,
    pub service_note: String,
}

fn resolve_uninstall_mode(args: &UninstallArgs) -> EffectiveMode {
    match args.mode {
        UninstallModeArg::System => EffectiveMode::System,
        UninstallModeArg::User => EffectiveMode::User,
        UninstallModeArg::Auto => {
            #[cfg(target_os = "linux")]
            {
                if is_linux_root_with_systemd() {
                    let sys_env = PathBuf::from(format!("/etc/neo-agent/cluster-{}.env", args.cluster));
                    let sys_dropin = PathBuf::from(format!(
                        "/etc/systemd/system/neo-agent-os@{}.service.d",
                        args.cluster
                    ));
                    if args.config_dir.is_none() && (sys_env.exists() || sys_dropin.exists()) {
                        return EffectiveMode::System;
                    }
                    if args.config_dir.as_deref() == Some(Path::new("/etc/neo-agent")) {
                        return EffectiveMode::System;
                    }
                }
                EffectiveMode::User
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = is_linux_root_with_systemd();
                EffectiveMode::User
            }
        }
    }
}

fn remove_file_if_exists(path: &Path, removed: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.exists() || path.symlink_metadata().is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644));
        }
        std::fs::remove_file(path)
            .map_err(|e| format!("failed to remove file {}: {e}", path.display()))?;
        removed.push(path.to_path_buf());
    }
    Ok(())
}

fn remove_dir_all_if_exists(path: &Path, removed: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("failed to remove directory {}: {e}", path.display()))?;
        removed.push(path.to_path_buf());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn teardown_service_linux_system(
    cluster_id: &str,
    removed: &mut Vec<PathBuf>,
) -> Result<String, String> {
    let unit = format!("neo-agent-os@{cluster_id}.service");
    let _ = std::process::Command::new("systemctl")
        .args(["disable", "--now", &unit])
        .output();

    let systemd_dir = Path::new("/etc/systemd/system");
    remove_dir_all_if_exists(
        &systemd_dir.join(format!("neo-agent-os@{cluster_id}.service.d")),
        removed,
    )?;
    remove_dir_all_if_exists(
        &systemd_dir.join(format!("neo-agent-slice@{cluster_id}.slice.d")),
        removed,
    )?;

    let _ = std::process::Command::new("systemctl")
        .args(["daemon-reload"])
        .output();
    Ok(format!("stopped & removed systemd system drop-ins for {unit}"))
}

#[cfg(target_os = "linux")]
fn teardown_service_linux_user(
    cluster_id: &str,
    removed: &mut Vec<PathBuf>,
) -> Result<String, String> {
    let unit = format!("neo-agent-os-{cluster_id}.service");
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "disable", "--now", &unit])
        .output();

    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            let unit_path = PathBuf::from(home)
                .join(".config")
                .join("systemd")
                .join("user")
                .join(&unit);
            remove_file_if_exists(&unit_path, removed)?;
        }
    }

    let _ = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output();
    Ok(format!("stopped & removed user systemd unit ({unit})"))
}

#[cfg(target_os = "macos")]
fn teardown_service_macos(cluster_id: &str, removed: &mut Vec<PathBuf>) -> Result<String, String> {
    let label = format!("cn.1inch.neo.agent.{cluster_id}");
    let uid = unsafe { libc::geteuid() };
    let target = format!("gui/{uid}/{label}");
    let bootout_ok = std::process::Command::new("launchctl")
        .args(["bootout", &target])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            let plist_path = PathBuf::from(home)
                .join("Library")
                .join("LaunchAgents")
                .join(format!("{label}.plist"));
            if !bootout_ok && plist_path.exists() {
                let _ = std::process::Command::new("launchctl")
                    .args(["unload", "-w", &plist_path.to_string_lossy()])
                    .output();
            }
            remove_file_if_exists(&plist_path, removed)?;
        }
    }
    Ok(format!("unloaded & removed launchd LaunchAgent ({label})"))
}

#[cfg(target_os = "windows")]
fn teardown_service_windows(cluster_id: &str) -> Result<String, String> {
    let task_name = format!("NeoAgent-{cluster_id}");
    let _ = std::process::Command::new("schtasks")
        .args(["/End", "/TN", &task_name])
        .output();
    let _ = std::process::Command::new("schtasks")
        .args(["/Delete", "/F", "/TN", &task_name])
        .output();
    Ok(format!("stopped & deleted Windows Scheduled Task ({task_name})"))
}

fn teardown_os_service(
    mode: EffectiveMode,
    cluster_id: &str,
    removed: &mut Vec<PathBuf>,
) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        match mode {
            EffectiveMode::System => teardown_service_linux_system(cluster_id, removed),
            EffectiveMode::User | EffectiveMode::Foreground => {
                teardown_service_linux_user(cluster_id, removed)
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = mode;
        teardown_service_macos(cluster_id, removed)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (mode, removed);
        teardown_service_windows(cluster_id)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (mode, cluster_id, removed);
        Ok("no OS service configured".to_string())
    }
}

fn discover_workspaces(policy_path: &Path, cluster_id: &str, mode: EffectiveMode) -> Vec<PathBuf> {
    if let Ok(raw) = std::fs::read_to_string(policy_path) {
        if let Ok(cfg) = toml::from_str::<PolicyConfig>(&raw) {
            let from_policy: Vec<PathBuf> = cfg
                .allowed_workspaces
                .into_iter()
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
                .collect();
            if !from_policy.is_empty() {
                return from_policy;
            }
        }
    }
    default_workspace_dir(cluster_id, mode)
        .map(|p| vec![p])
        .unwrap_or_default()
}

pub fn run_uninstall(args: UninstallArgs) -> Result<UninstallOutcome, String> {
    validate_cluster_id(&args.cluster)?;
    let mode = resolve_uninstall_mode(&args);
    let custom_config_dir = args.config_dir.is_some();
    let config_dir = match args.config_dir {
        Some(dir) => dir,
        None => default_config_dir(mode)?,
    };

    let policy_path = config_dir.join(format!("policy-{}.toml", args.cluster));
    let env_path = config_dir.join(format!("cluster-{}.env", args.cluster));
    let ota_cache_dir = default_ota_cache_dir(&args.cluster, &config_dir, custom_config_dir, mode);

    // Discover configured workspaces BEFORE deleting policy file.
    let workspaces = discover_workspaces(&policy_path, &args.cluster, mode);

    let mut removed_paths = Vec::new();
    let service_note = teardown_os_service(mode, &args.cluster, &mut removed_paths)?;

    remove_file_if_exists(&env_path, &mut removed_paths)?;
    remove_file_if_exists(&policy_path, &mut removed_paths)?;

    let cluster_subdir = config_dir.join(&args.cluster);
    remove_file_if_exists(&cluster_subdir.join("start.sh"), &mut removed_paths)?;
    remove_dir_all_if_exists(&ota_cache_dir, &mut removed_paths)?;
    remove_dir_all_if_exists(&cluster_subdir.join("logs"), &mut removed_paths)?;

    let mut preserved_workspaces = Vec::new();
    let mut purged_workspaces = Vec::new();
    for ws in workspaces {
        if args.purge_workspace {
            if ws.exists() {
                remove_dir_all_if_exists(&ws, &mut removed_paths)?;
                purged_workspaces.push(ws);
            }
        } else if ws.exists() {
            preserved_workspaces.push(ws);
        }
    }

    // Remove <config_dir>/<cluster> only if now empty (never accidentally wipes preserved Windows workspace).
    if cluster_subdir.exists() {
        let _ = std::fs::remove_dir(&cluster_subdir);
    }

    let outcome = UninstallOutcome {
        cluster_id: args.cluster,
        mode,
        removed_paths,
        preserved_workspaces,
        purged_workspaces,
        service_note,
    };
    print_uninstall_summary(&outcome);
    Ok(outcome)
}

fn print_uninstall_summary(outcome: &UninstallOutcome) {
    println!("Neo Tier 1 OS agent uninstalled:");
    println!("  cluster_id:  {}", outcome.cluster_id);
    println!("  mode:        {}", outcome.mode.as_str());
    println!("  service:     {}", outcome.service_note);
    println!("  removed:     {} item(s)", outcome.removed_paths.len());
    for ws in &outcome.purged_workspaces {
        println!("  purged ws:   {}", ws.display());
    }
    for ws in &outcome.preserved_workspaces {
        println!(
            "  preserved:   {} (pass --purge-workspace to delete)",
            ws.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::now_ms;

    #[test]
    fn uninstall_removes_config_and_preserves_workspace_by_default() {
        let tmp = std::env::temp_dir().join(format!(
            "neo_uninstall_test_{}_{}",
            std::process::id(),
            now_ms()
        ));
        let cfg_dir = tmp.join("cfg");
        let ws_dir = tmp.join("work");
        let ota_dir = cfg_dir.join("testcl1").join("ota");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        std::fs::create_dir_all(&ws_dir).unwrap();
        std::fs::create_dir_all(&ota_dir).unwrap();

        let ws_escaped = ws_dir.display().to_string().replace('\\', "\\\\");
        let policy_path = cfg_dir.join("policy-testcl1.toml");
        let env_path = cfg_dir.join("cluster-testcl1.env");
        let sentinel = ws_dir.join("keep-me.txt");
        std::fs::write(&policy_path, format!("allowed_workspaces = [\"{ws_escaped}\"]\n")).unwrap();
        std::fs::write(&env_path, "NEO_CLUSTER_ID=testcl1\n").unwrap();
        std::fs::write(&sentinel, "important user data").unwrap();

        let out = run_uninstall(UninstallArgs {
            cluster: "testcl1".to_string(),
            mode: UninstallModeArg::User,
            config_dir: Some(cfg_dir.clone()),
            purge_workspace: false,
        })
        .unwrap();

        assert!(!policy_path.exists());
        assert!(!env_path.exists());
        assert!(!ota_dir.exists());
        assert!(sentinel.exists());
        assert_eq!(out.preserved_workspaces.len(), 1);
        assert!(out.purged_workspaces.is_empty());

        // Now test --purge-workspace deletes workspace cleanly
        std::fs::write(&policy_path, format!("allowed_workspaces = [\"{ws_escaped}\"]\n")).unwrap();
        let out2 = run_uninstall(UninstallArgs {
            cluster: "testcl1".to_string(),
            mode: UninstallModeArg::User,
            config_dir: Some(cfg_dir.clone()),
            purge_workspace: true,
        })
        .unwrap();
        assert!(!ws_dir.exists());
        assert_eq!(out2.purged_workspaces.len(), 1);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
