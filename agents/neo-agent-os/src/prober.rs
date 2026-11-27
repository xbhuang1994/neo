use crate::policy::Policy;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxSummary {
    pub allowed_workspaces: Vec<String>,
    pub max_child_mem_mb: u64,
    pub max_exec_timeout_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayConfigSummary {
    pub enabled: bool,
    pub mqtt_bind: Option<String>,
    pub uart_device: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityManifest {
    pub device_id: String,
    pub tier: String,
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub cpus: usize,
    pub ram_mb: u64,
    pub capabilities: Vec<String>,
    pub sandbox: SandboxSummary,
    pub relay_config: Option<RelayConfigSummary>,
}

pub struct CapabilityProber;

impl CapabilityProber {
    pub fn probe(
        policy: &Policy,
        device_id: &str,
        relay_enabled: bool,
        mqtt_bind: Option<&str>,
        uart_device: Option<&Path>,
    ) -> CapabilityManifest {
        let os = std::env::consts::OS.to_string();
        let arch = std::env::consts::ARCH.to_string();
        let cpus = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);
        let ram_mb = read_total_ram_mb();
        let hostname = read_hostname();

        let mut capabilities = vec![
            "exec".to_string(),
            "fs".to_string(),
            "transfer".to_string(),
            "ota".to_string(),
        ];
        if Path::new("/dev/nvidia0").exists() {
            capabilities.push("gpu".to_string());
        }
        if relay_enabled {
            capabilities.push("relay".to_string());
        }

        let sandbox = SandboxSummary {
            allowed_workspaces: policy
                .canonical_workspaces()
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
            max_child_mem_mb: policy.config().max_child_mem_mb,
            max_exec_timeout_sec: policy.config().max_exec_timeout_sec,
        };

        let relay_config = Some(RelayConfigSummary {
            enabled: relay_enabled,
            mqtt_bind: if relay_enabled {
                mqtt_bind.map(|s| s.to_string())
            } else {
                None
            },
            uart_device: if relay_enabled {
                uart_device.map(|p| p.to_string_lossy().into_owned())
            } else {
                None
            },
        });

        CapabilityManifest {
            device_id: device_id.to_string(),
            tier: "os".to_string(),
            os,
            arch,
            hostname,
            cpus,
            ram_mb,
            capabilities,
            sandbox,
            relay_config,
        }
    }
}

fn read_total_ram_mb() -> u64 {
    if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
        for line in content.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                let kb: u64 = rest
                    .split_whitespace()
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                return kb / 1024;
            }
        }
    }
    0
}

fn read_hostname() -> String {
    if let Ok(h) = std::fs::read_to_string("/proc/sys/kernel/hostname") {
        let trimmed = h.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_manifest_with_sandbox_and_relay() {
        let ws = std::env::temp_dir();
        let toml = format!("allowed_workspaces = [\"{}\"]\n", ws.display());
        let policy = Policy::from_toml_str(&toml).unwrap();
        let manifest = CapabilityProber::probe(
            &policy,
            "os-node-test",
            true,
            Some("127.0.0.1:1883"),
            None,
        );
        assert_eq!(manifest.device_id, "os-node-test");
        assert_eq!(manifest.tier, "os");
        assert!(manifest.cpus >= 1);
        assert!(manifest.capabilities.contains(&"relay".to_string()));
        assert!(manifest.capabilities.contains(&"exec".to_string()));
        assert!(manifest.relay_config.as_ref().unwrap().enabled);
    }
}
