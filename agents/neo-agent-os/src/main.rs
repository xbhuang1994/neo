mod executor;
mod policy;
mod prober;
mod protocol;
mod relay_bridge;
mod transport;
mod updater;

use clap::Parser;
use executor::best_effort_oom_score_adj;
use policy::Policy;
use prober::CapabilityProber;
use std::path::PathBuf;
use std::sync::Arc;
use transport::{run_agent, run_one_shot_check, AgentConfig};

#[derive(Debug, Parser)]
#[command(name = "neo-agent-os", version, about = "Tier 1 OS Agent for Multi-Device Neo")]
struct Cli {
    #[arg(long, env = "NEO_CLUSTER_ID")]
    cluster: Option<String>,

    #[arg(long, env = "NEO_DEVICE_ID")]
    device_id: Option<String>,

    #[arg(long, env = "NEO_RELAY_URL", default_value = "https://neo.1inch.cn:18443")]
    relay_url: String,

    #[arg(long, env = "NEO_TOKEN")]
    token: Option<String>,

    #[arg(long, env = "NEO_E2E_KEY")]
    e2e_key: Option<String>,

    #[arg(long, env = "NEO_POLICY_PATH")]
    policy: PathBuf,

    #[arg(long, env = "NEO_MASTER_ID", default_value = "master-neo")]
    master_id: String,

    #[arg(long, default_value_t = false)]
    relay: bool,

    #[arg(long, default_value = "127.0.0.1:1883")]
    mqtt_bind: String,

    #[arg(long)]
    uart_device: Option<PathBuf>,

    #[arg(long)]
    ota_cache_dir: Option<PathBuf>,

    #[arg(long, default_value_t = false)]
    print_manifest: bool,

    #[arg(long, default_value_t = false)]
    one_shot_check: bool,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    best_effort_oom_score_adj(-500);

    let cli = Cli::parse();
    let policy = match Policy::from_file(&cli.policy) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            eprintln!("policy load error: {e}");
            std::process::exit(2);
        }
    };

    let device_id = cli
        .device_id
        .clone()
        .unwrap_or_else(|| "os-agent-local".to_string());

    if cli.print_manifest {
        let manifest = CapabilityProber::probe(
            &policy,
            &device_id,
            cli.relay,
            Some(&cli.mqtt_bind),
            cli.uart_device.as_deref(),
        );
        println!(
            "{}",
            serde_json::to_string_pretty(&manifest).expect("manifest serialization")
        );
        return;
    }

    let cluster_id = cli.cluster.unwrap_or_else(|| {
        eprintln!("--cluster (or NEO_CLUSTER_ID) is required");
        std::process::exit(2);
    });
    let token = cli.token.unwrap_or_else(|| {
        eprintln!("--token (or NEO_TOKEN) is required");
        std::process::exit(2);
    });
    let e2e_secret = cli.e2e_key.unwrap_or_else(|| {
        eprintln!("--e2e-key (or NEO_E2E_KEY) is required");
        std::process::exit(2);
    });

    let updater_state_path = cli
        .ota_cache_dir
        .as_ref()
        .map(|d| d.join("updater-state.json"));

    let cfg = AgentConfig {
        cluster_id,
        device_id,
        master_id: cli.master_id,
        relay_url: cli.relay_url,
        token,
        e2e_secret,
        relay_enabled: cli.relay,
        mqtt_bind: cli.mqtt_bind,
        uart_device: cli.uart_device,
        ota_cache_dir: cli.ota_cache_dir,
        updater_state_path,
    };

    if cli.one_shot_check {
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
