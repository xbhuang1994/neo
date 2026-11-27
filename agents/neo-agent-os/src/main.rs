mod enroll;
mod executor;
mod file_transfer;
mod policy;
mod prober;
mod protocol;
mod relay_bridge;
mod transport;
mod uninstall;
mod updater;

use clap::{Args, Parser, Subcommand};
use executor::best_effort_oom_score_adj;
use policy::Policy;
use prober::CapabilityProber;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use transport::{run_agent, run_one_shot_check, AgentConfig};

const DEFAULT_RELAY_URL: &str = "https://neo.1inch.cn:18443";
const DEFAULT_MASTER_ID: &str = "master-neo";
const DEFAULT_DEVICE_ID: &str = "os-agent-local";
const DEFAULT_MQTT_BIND: &str = "127.0.0.1:1883";

#[derive(Debug, Clone, Args)]
pub struct RunArgs {
    /// Load KEY=VALUE environment file before evaluating required fields (avoids secrets on argv)
    #[arg(long)]
    pub env_file: Option<PathBuf>,

    /// Cluster identifier (env: NEO_CLUSTER_ID)
    #[arg(long)]
    pub cluster: Option<String>,

    /// Device node identifier (env: NEO_DEVICE_ID)
    #[arg(long)]
    pub device_id: Option<String>,

    /// Relay base URL (env: NEO_RELAY_URL)
    #[arg(long)]
    pub relay_url: Option<String>,

    /// Relay auth token (env: NEO_TOKEN or NEO_RELAY_TOKEN)
    #[arg(long)]
    pub token: Option<String>,

    /// Cluster E2E encryption secret (env: NEO_E2E_KEY)
    #[arg(long)]
    pub e2e_key: Option<String>,

    /// Enrollment ID reported in initial manifest (env: NEO_ENROLL_ID)
    #[arg(long)]
    pub enroll_id: Option<String>,

    /// Local read-only policy TOML file (env: NEO_POLICY_PATH)
    #[arg(long)]
    pub policy: Option<PathBuf>,

    /// Master Neo node ID (env: NEO_MASTER_ID)
    #[arg(long)]
    pub master_id: Option<String>,

    /// Enable Tier 2 MCU MQTT/UART relay bridge
    #[arg(long, default_value_t = false)]
    pub relay: bool,

    /// MQTT bind address for Tier 2 relay bridge
    #[arg(long)]
    pub mqtt_bind: Option<String>,

    /// Serial UART device path for Tier 2 relay bridge
    #[arg(long)]
    pub uart_device: Option<PathBuf>,

    /// Directory for staged OTA artifacts and rollback state (env: NEO_OTA_CACHE_DIR)
    #[arg(long)]
    pub ota_cache_dir: Option<PathBuf>,

    /// Print capability manifest JSON and exit
    #[arg(long, default_value_t = false)]
    pub print_manifest: bool,

    /// Verify bootstrap, signal, and relay manifest framing once and exit
    #[arg(long, default_value_t = false)]
    pub one_shot_check: bool,
}

#[derive(Debug, Parser)]
#[command(
    name = "neo-agent-os",
    version,
    about = "Tier 1 OS Agent for Multi-Device Neo",
    args_conflicts_with_subcommands = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[command(flatten)]
    run: RunArgs,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Run the Tier 1 OS agent daemon (explicit alias for default mode)
    Run(RunArgs),
    /// Enroll this device using a one-click zero-trust enrollment ticket
    Enroll(enroll::EnrollArgs),
    /// Uninstall an enrolled cluster agent service and local configuration
    Uninstall(uninstall::UninstallArgs),
}

pub(crate) fn parse_env_str(content: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map(str::trim_start).unwrap_or(line);
        let Some((raw_key, raw_val)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if key.is_empty() {
            continue;
        }
        let mut val = raw_val.trim();
        if val.len() >= 2
            && ((val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\'')))
        {
            val = &val[1..val.len() - 1];
        }
        map.insert(key.to_string(), val.to_string());
    }
    map
}

pub(crate) fn parse_env_file(path: &Path) -> Result<HashMap<String, String>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read --env-file {}: {e}", path.display()))?;
    Ok(parse_env_str(&content))
}

#[derive(Debug, Default)]
struct ParsedExtraArgs {
    relay: bool,
    mqtt_bind: Option<String>,
    uart_device: Option<PathBuf>,
    ota_cache_dir: Option<PathBuf>,
}

fn parse_extra_args_str(raw: &str) -> ParsedExtraArgs {
    let mut parsed = ParsedExtraArgs::default();
    let tokens: Vec<&str> = raw.split_whitespace().collect();
    let mut i = 0;
    while i < tokens.len() {
        match tokens[i] {
            "--relay" => {
                parsed.relay = true;
                i += 1;
            }
            "--mqtt-bind" => {
                if let Some(v) = tokens.get(i + 1) {
                    parsed.mqtt_bind = Some((*v).to_string());
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "--uart-device" => {
                if let Some(v) = tokens.get(i + 1) {
                    parsed.uart_device = Some(PathBuf::from(*v));
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "--ota-cache-dir" => {
                if let Some(v) = tokens.get(i + 1) {
                    parsed.ota_cache_dir = Some(PathBuf::from(*v));
                    i += 2;
                } else {
                    i += 1;
                }
            }
            other => {
                if let Some(v) = other.strip_prefix("--mqtt-bind=") {
                    parsed.mqtt_bind = Some(v.to_string());
                } else if let Some(v) = other.strip_prefix("--uart-device=") {
                    parsed.uart_device = Some(PathBuf::from(v));
                } else if let Some(v) = other.strip_prefix("--ota-cache-dir=") {
                    parsed.ota_cache_dir = Some(PathBuf::from(v));
                }
                i += 1;
            }
        }
    }
    parsed
}

#[derive(Debug, Clone)]
struct ResolvedRunOptions {
    policy_path: PathBuf,
    cluster: Option<String>,
    device_id: String,
    relay_url: String,
    token: Option<String>,
    e2e_key: Option<String>,
    enroll_id: Option<String>,
    master_id: String,
    relay: bool,
    mqtt_bind: String,
    uart_device: Option<PathBuf>,
    ota_cache_dir: Option<PathBuf>,
    print_manifest: bool,
    one_shot_check: bool,
}

fn lookup_var<F>(env_file: &HashMap<String, String>, get_env: &F, key: &str) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    env_file
        .get(key)
        .filter(|s| !s.is_empty())
        .cloned()
        .or_else(|| get_env(key).filter(|s| !s.is_empty()))
}

fn resolve_run_options_with_env<F>(
    args: &RunArgs,
    env_file: &HashMap<String, String>,
    get_env: F,
) -> Result<ResolvedRunOptions, String>
where
    F: Fn(&str) -> Option<String>,
{
    let extra = lookup_var(env_file, &get_env, "NEO_EXTRA_ARGS")
        .map(|s| parse_extra_args_str(&s))
        .unwrap_or_default();

    let policy_path = args
        .policy
        .clone()
        .or_else(|| lookup_var(env_file, &get_env, "NEO_POLICY_PATH").map(PathBuf::from))
        .ok_or_else(|| "--policy (or NEO_POLICY_PATH) is required".to_string())?;

    let cluster = args
        .cluster
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| lookup_var(env_file, &get_env, "NEO_CLUSTER_ID"));

    let device_id = args
        .device_id
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| lookup_var(env_file, &get_env, "NEO_DEVICE_ID"))
        .unwrap_or_else(|| DEFAULT_DEVICE_ID.to_string());

    let relay_url = args
        .relay_url
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| lookup_var(env_file, &get_env, "NEO_RELAY_URL"))
        .unwrap_or_else(|| DEFAULT_RELAY_URL.to_string());

    // Prefer --token, then NEO_TOKEN (env-file then process env), then NEO_RELAY_TOKEN (env-file then process env).
    let token = args
        .token
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| lookup_var(env_file, &get_env, "NEO_TOKEN"))
        .or_else(|| lookup_var(env_file, &get_env, "NEO_RELAY_TOKEN"));

    let e2e_key = args
        .e2e_key
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| lookup_var(env_file, &get_env, "NEO_E2E_KEY"));

    let enroll_id = args
        .enroll_id
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| lookup_var(env_file, &get_env, "NEO_ENROLL_ID"));

    let master_id = args
        .master_id
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| lookup_var(env_file, &get_env, "NEO_MASTER_ID"))
        .unwrap_or_else(|| DEFAULT_MASTER_ID.to_string());

    let relay = args.relay || extra.relay;
    let mqtt_bind = args
        .mqtt_bind
        .clone()
        .filter(|s| !s.is_empty())
        .or(extra.mqtt_bind)
        .unwrap_or_else(|| DEFAULT_MQTT_BIND.to_string());
    let uart_device = args.uart_device.clone().or(extra.uart_device);
    let ota_cache_dir = args
        .ota_cache_dir
        .clone()
        .or_else(|| lookup_var(env_file, &get_env, "NEO_OTA_CACHE_DIR").map(PathBuf::from))
        .or(extra.ota_cache_dir);

    Ok(ResolvedRunOptions {
        policy_path,
        cluster,
        device_id,
        relay_url,
        token,
        e2e_key,
        enroll_id,
        master_id,
        relay,
        mqtt_bind,
        uart_device,
        ota_cache_dir,
        print_manifest: args.print_manifest,
        one_shot_check: args.one_shot_check,
    })
}

async fn run_daemon_mode(args: RunArgs) {
    let env_file_map = match args.env_file.as_deref() {
        Some(path) => match parse_env_file(path) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(2);
            }
        },
        None => HashMap::new(),
    };

    let opts = match resolve_run_options_with_env(&args, &env_file_map, |k| std::env::var(k).ok()) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    let policy = match Policy::from_file(&opts.policy_path) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            eprintln!("policy load error: {e}");
            std::process::exit(2);
        }
    };

    if opts.print_manifest {
        let manifest = CapabilityProber::probe(
            &policy,
            &opts.device_id,
            opts.relay,
            Some(&opts.mqtt_bind),
            opts.uart_device.as_deref(),
        );
        println!(
            "{}",
            serde_json::to_string_pretty(&manifest).expect("manifest serialization")
        );
        return;
    }

    let cluster_id = opts.cluster.unwrap_or_else(|| {
        eprintln!("--cluster (or NEO_CLUSTER_ID) is required");
        std::process::exit(2);
    });
    let token = opts.token.unwrap_or_else(|| {
        eprintln!("--token (or NEO_TOKEN / NEO_RELAY_TOKEN) is required");
        std::process::exit(2);
    });
    let e2e_secret = opts.e2e_key.unwrap_or_else(|| {
        eprintln!("--e2e-key (or NEO_E2E_KEY) is required");
        std::process::exit(2);
    });

    let updater_state_path = opts
        .ota_cache_dir
        .as_ref()
        .map(|d| d.join("updater-state.json"));

    let cfg = AgentConfig {
        cluster_id,
        device_id: opts.device_id,
        master_id: opts.master_id,
        relay_url: opts.relay_url,
        token,
        e2e_secret,
        enroll_id: opts.enroll_id,
        relay_enabled: opts.relay,
        mqtt_bind: opts.mqtt_bind,
        uart_device: opts.uart_device,
        ota_cache_dir: opts.ota_cache_dir,
        updater_state_path,
    };

    if opts.one_shot_check {
        if let Err(e) = run_one_shot_check(&cfg, &policy).await {
            eprintln!("one-shot-check failed: {e}");
            std::process::exit(1);
        }
        return;
    }

    tokio::select! {
        res = run_agent(cfg, policy) => {
            if let Err(e) = res {
                eprintln!("neo-agent-os exited with error: {e}");
                std::process::exit(1);
            }
        }
        _ = tokio::signal::ctrl_c() => {
            eprintln!("[neo-agent-os] shutdown signal received");
        }
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    best_effort_oom_score_adj(-500);

    let cli = Cli::parse();
    match cli.command {
        Some(Commands::Enroll(args)) => {
            if let Err(e) = enroll::run_enroll(args).await {
                eprintln!("enrollment failed: {e}");
                std::process::exit(1);
            }
        }
        Some(Commands::Uninstall(args)) => {
            if let Err(e) = uninstall::run_uninstall(args) {
                eprintln!("uninstall failed: {e}");
                std::process::exit(1);
            }
        }
        Some(Commands::Run(run_args)) => {
            run_daemon_mode(run_args).await;
        }
        None => {
            run_daemon_mode(cli.run).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_env_file_comments_quotes_and_token_aliases() {
        let raw = r#"
# Comment line
   # Indented comment

NEO_CLUSTER_ID="personal"
NEO_DEVICE_ID='mac-mini-01'
NEO_RELAY_TOKEN="tok_from_relay_alias"
export NEO_E2E_KEY=secret_e2e_42
NEO_ENROLL_ID=enr_999
NEO_EXTRA_ARGS="--relay --mqtt-bind 127.0.0.1:1884"
"#;
        let map = parse_env_str(raw);
        assert_eq!(map.get("NEO_CLUSTER_ID").map(String::as_str), Some("personal"));
        assert_eq!(map.get("NEO_DEVICE_ID").map(String::as_str), Some("mac-mini-01"));
        assert_eq!(
            map.get("NEO_RELAY_TOKEN").map(String::as_str),
            Some("tok_from_relay_alias")
        );
        assert_eq!(map.get("NEO_E2E_KEY").map(String::as_str), Some("secret_e2e_42"));

        let cli = Cli::try_parse_from([
            "neo-agent-os",
            "--policy",
            "/tmp/policy.toml",
        ])
        .unwrap();
        let resolved = resolve_run_options_with_env(&cli.run, &map, |_| None).unwrap();
        assert_eq!(resolved.cluster.as_deref(), Some("personal"));
        assert_eq!(resolved.device_id, "mac-mini-01");
        assert_eq!(resolved.token.as_deref(), Some("tok_from_relay_alias"));
        assert_eq!(resolved.e2e_key.as_deref(), Some("secret_e2e_42"));
        assert_eq!(resolved.enroll_id.as_deref(), Some("enr_999"));
        assert!(resolved.relay);
        assert_eq!(resolved.mqtt_bind, "127.0.0.1:1884");

        // NEO_TOKEN takes precedence over NEO_RELAY_TOKEN
        let resolved2 = resolve_run_options_with_env(&cli.run, &map, |k| {
            if k == "NEO_TOKEN" {
                Some("tok_primary".to_string())
            } else {
                None
            }
        })
        .unwrap();
        assert_eq!(resolved2.token.as_deref(), Some("tok_primary"));
    }

    #[test]
    fn cli_supports_backward_compatible_flags_and_subcommands() {
        // Legacy invocation without subcommand
        let legacy = Cli::try_parse_from([
            "neo-agent-os",
            "--cluster",
            "corp",
            "--policy",
            "/etc/neo-agent/policy-corp.toml",
            "--enroll-id",
            "enr-1",
            "--one-shot-check",
        ])
        .unwrap();
        assert!(legacy.command.is_none());
        assert_eq!(legacy.run.cluster.as_deref(), Some("corp"));
        assert_eq!(legacy.run.enroll_id.as_deref(), Some("enr-1"));
        assert!(legacy.run.one_shot_check);

        // Explicit `run` subcommand
        let explicit_run = Cli::try_parse_from([
            "neo-agent-os",
            "run",
            "--env-file",
            "/etc/neo-agent/cluster-corp.env",
            "--policy",
            "/etc/neo-agent/policy-corp.toml",
        ])
        .unwrap();
        match explicit_run.command {
            Some(Commands::Run(r)) => {
                assert_eq!(
                    r.env_file.as_deref(),
                    Some(Path::new("/etc/neo-agent/cluster-corp.env"))
                );
            }
            other => panic!("expected Run subcommand, got {other:?}"),
        }

        // `enroll` subcommand
        let enr = Cli::try_parse_from([
            "neo-agent-os",
            "enroll",
            "--relay-url",
            "https://neo.1inch.cn:18443",
            "--ticket-stdin",
            "--mode",
            "foreground",
            "--skip-service",
        ])
        .unwrap();
        match enr.command {
            Some(Commands::Enroll(e)) => {
                assert_eq!(e.relay_url.as_deref(), Some("https://neo.1inch.cn:18443"));
                assert!(e.ticket_stdin);
                assert_eq!(e.mode, enroll::EnrollModeArg::Foreground);
                assert!(e.skip_service);
            }
            other => panic!("expected Enroll subcommand, got {other:?}"),
        }

        // `uninstall` subcommand
        let uninst = Cli::try_parse_from([
            "neo-agent-os",
            "uninstall",
            "--cluster",
            "personal",
            "--mode",
            "user",
            "--purge-workspace",
        ])
        .unwrap();
        match uninst.command {
            Some(Commands::Uninstall(u)) => {
                assert_eq!(u.cluster, "personal");
                assert_eq!(u.mode, uninstall::UninstallModeArg::User);
                assert!(u.purge_workspace);
            }
            other => panic!("expected Uninstall subcommand, got {other:?}"),
        }
    }
}
