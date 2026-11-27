use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const HEALTHY_COMMIT_WINDOW_SECS: u64 = 15;

pub fn verify_ed25519_signature(
    public_key: &[u8; 32],
    payload: &[u8],
    signature: &[u8; 64],
) -> Result<(), String> {
    let vk = VerifyingKey::from_bytes(public_key)
        .map_err(|e| format!("invalid Ed25519 public key: {e}"))?;
    let sig = Signature::from_bytes(signature);
    vk.verify_strict(payload, &sig)
        .map_err(|e| format!("Ed25519 signature verification failed: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BootStatus {
    Idle,
    PendingBoot,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RollbackState {
    pub status: BootStatus,
    pub current_version: String,
    pub candidate_version: Option<String>,
    pub previous_binary_path: Option<String>,
    pub active_binary_path: Option<String>,
    pub pending_since_unix: Option<u64>,
}

impl Default for RollbackState {
    fn default() -> Self {
        Self {
            status: BootStatus::Idle,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            candidate_version: None,
            previous_binary_path: None,
            active_binary_path: None,
            pending_since_unix: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollbackAction {
    None,
    Committed,
    RolledBack,
}

pub struct UpdaterManager {
    state_path: PathBuf,
    state: RollbackState,
}

impl UpdaterManager {
    pub fn load_or_init(state_path: &Path) -> Result<Self, String> {
        let state = if state_path.exists() {
            let raw = std::fs::read_to_string(state_path)
                .map_err(|e| format!("failed to read updater state: {e}"))?;
            serde_json::from_str(&raw)
                .map_err(|e| format!("invalid updater state JSON: {e}"))?
        } else {
            RollbackState::default()
        };
        Ok(Self {
            state_path: state_path.to_path_buf(),
            state,
        })
    }

    #[allow(dead_code)]
    pub fn state(&self) -> &RollbackState {
        &self.state
    }

    fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.state_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let data = serde_json::to_string_pretty(&self.state).map_err(|e| e.to_string())?;
        std::fs::write(&self.state_path, data).map_err(|e| e.to_string())
    }

    /// Verifies an OTA package signature and stages a `pending_boot` update state.
    #[allow(dead_code)]
    pub fn stage_verified_update(
        &mut self,
        public_key: &[u8; 32],
        package_bytes: &[u8],
        signature: &[u8; 64],
        candidate_version: &str,
        previous_binary: &Path,
        active_binary: &Path,
    ) -> Result<(), String> {
        verify_ed25519_signature(public_key, package_bytes, signature)?;
        let now = now_unix_secs();
        if let Some(parent) = active_binary.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if active_binary.exists() && previous_binary != active_binary {
            std::fs::copy(active_binary, previous_binary)
                .map_err(|e| format!("failed to backup previous binary: {e}"))?;
        }
        std::fs::write(active_binary, package_bytes)
            .map_err(|e| format!("failed to write staged binary: {e}"))?;

        self.state.status = BootStatus::PendingBoot;
        self.state.candidate_version = Some(candidate_version.to_string());
        self.state.previous_binary_path = Some(previous_binary.to_string_lossy().into_owned());
        self.state.active_binary_path = Some(active_binary.to_string_lossy().into_owned());
        self.state.pending_since_unix = Some(now);
        self.save()
    }

    /// Called when healthy relay connection is established. If within 15s of `pending_boot`,
    /// commits the boot (`Idle`); if the 15s window already elapsed, performs rollback.
    pub fn on_healthy_connect(&mut self, elapsed_since_boot: Duration) -> Result<RollbackAction, String> {
        if self.state.status != BootStatus::PendingBoot {
            return Ok(RollbackAction::None);
        }
        if elapsed_since_boot <= Duration::from_secs(HEALTHY_COMMIT_WINDOW_SECS) {
            if let Some(cand) = self.state.candidate_version.take() {
                self.state.current_version = cand;
            }
            self.state.status = BootStatus::Idle;
            self.state.pending_since_unix = None;
            self.save()?;
            Ok(RollbackAction::Committed)
        } else {
            self.rollback()?;
            Ok(RollbackAction::RolledBack)
        }
    }

    /// Called if healthy reconnect does not succeed within 15s.
    pub fn rollback(&mut self) -> Result<(), String> {
        if let (Some(prev), Some(active)) = (
            self.state.previous_binary_path.as_deref(),
            self.state.active_binary_path.as_deref(),
        ) {
            let prev_p = Path::new(prev);
            let active_p = Path::new(active);
            if prev_p.exists() {
                std::fs::copy(prev_p, active_p)
                    .map_err(|e| format!("rollback copy failed: {e}"))?;
            }
        }
        self.state.status = BootStatus::RolledBack;
        self.state.candidate_version = None;
        self.state.pending_since_unix = None;
        self.save()
    }
}

#[allow(dead_code)]
fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn ed25519_verify_and_rollback_state_machine() {
        let sk_bytes = [42u8; 32];
        let sk = SigningKey::from_bytes(&sk_bytes);
        let pk_bytes = sk.verifying_key().to_bytes();

        let pkg = b"new-binary-v0.2.0";
        let sig = sk.sign(pkg).to_bytes();

        // Tampered payload rejected
        assert!(verify_ed25519_signature(&pk_bytes, b"tampered", &sig).is_err());

        let dir = std::env::temp_dir().join(format!("neo_updater_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let state_path = dir.join("updater-state.json");
        let prev_bin = dir.join("neo-agent-os.prev");
        let active_bin = dir.join("neo-agent-os");
        std::fs::write(&active_bin, b"old-binary-v0.1.0").unwrap();

        let mut mgr = UpdaterManager::load_or_init(&state_path).unwrap();
        mgr.stage_verified_update(&pk_bytes, pkg, &sig, "0.2.0", &prev_bin, &active_bin)
            .unwrap();
        assert_eq!(mgr.state().status, BootStatus::PendingBoot);
        assert_eq!(std::fs::read(&active_bin).unwrap(), pkg);

        // Healthy connect within 15s commits
        let action = mgr.on_healthy_connect(Duration::from_secs(3)).unwrap();
        assert_eq!(action, RollbackAction::Committed);
        assert_eq!(mgr.state().status, BootStatus::Idle);
        assert_eq!(mgr.state().current_version, "0.2.0");

        // Stage again and simulate missed 15s healthy window -> rollback
        let pkg2 = b"bad-binary-v0.3.0";
        let sig2 = sk.sign(pkg2).to_bytes();
        mgr.stage_verified_update(&pk_bytes, pkg2, &sig2, "0.3.0", &prev_bin, &active_bin)
            .unwrap();
        let action2 = mgr.on_healthy_connect(Duration::from_secs(20)).unwrap();
        assert_eq!(action2, RollbackAction::RolledBack);
        assert_eq!(mgr.state().status, BootStatus::RolledBack);
        assert_eq!(std::fs::read(&active_bin).unwrap(), pkg);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
