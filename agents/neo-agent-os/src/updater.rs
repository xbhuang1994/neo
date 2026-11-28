use crate::transport::http_download_bytes;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

pub const HEALTHY_COMMIT_WINDOW_SECS: u64 = 15;
pub const MAX_UPDATE_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
pub const UPDATE_DOWNLOAD_TIMEOUT_SECS: u64 = 120;
const GITHUB_RELEASE_BASE: &str = "https://github.com/xbhuang1994/neo/releases/download";

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

    /// Records a SHA-256 verified binary swap that is ready to boot.
    pub fn record_pending_boot(
        &mut self,
        candidate_version: &str,
        previous_binary: Option<&Path>,
        active_binary: &Path,
    ) -> Result<(), String> {
        self.state.status = BootStatus::PendingBoot;
        self.state.candidate_version = Some(candidate_version.to_string());
        self.state.previous_binary_path =
            previous_binary.map(|p| p.to_string_lossy().into_owned());
        self.state.active_binary_path = Some(active_binary.to_string_lossy().into_owned());
        self.state.pending_since_unix = Some(now_unix_secs());
        self.save()
    }

    /// Called when healthy relay connection is established. If within 15s of `pending_boot`,
    /// commits the boot (`Idle`); if the 15s window already elapsed, performs rollback.
    pub fn on_healthy_connect(
        &mut self,
        elapsed_since_boot: Duration,
    ) -> Result<RollbackAction, String> {
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
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(active_p, std::fs::Permissions::from_mode(0o755));
                }
            }
        }
        self.state.status = BootStatus::RolledBack;
        self.state.candidate_version = None;
        self.state.pending_since_unix = None;
        self.save()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedSemver {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Vec<String>,
}

fn parse_semver(raw: &str) -> Option<ParsedSemver> {
    let trimmed = raw.trim();
    let no_v = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    let no_build = no_v.split('+').next()?.trim();
    if no_build.is_empty() {
        return None;
    }
    let (core, pre_raw) = match no_build.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (no_build, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let pre = match pre_raw {
        Some(p) => {
            if p.is_empty() {
                return None;
            }
            let ids: Vec<String> = p.split('.').map(|s| s.to_string()).collect();
            if ids.iter().any(|id| {
                id.is_empty()
                    || !id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-')
            }) {
                return None;
            }
            ids
        }
        None => Vec::new(),
    };
    Some(ParsedSemver {
        major,
        minor,
        patch,
        pre,
    })
}

pub fn validate_version_str(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    if parse_semver(stripped).is_none() || stripped.contains("..") || stripped.contains('/') || stripped.contains('\\') {
        return Err(format!("invalid semver version: {raw:?}"));
    }
    Ok(stripped.to_string())
}

pub fn compare_semver(a: &str, b: &str) -> Option<Ordering> {
    let pa = parse_semver(a)?;
    let pb = parse_semver(b)?;
    let core_ord = (pa.major, pa.minor, pa.patch).cmp(&(pb.major, pb.minor, pb.patch));
    if core_ord != Ordering::Equal {
        return Some(core_ord);
    }
    match (pa.pre.is_empty(), pb.pre.is_empty()) {
        (true, true) => Some(Ordering::Equal),
        (true, false) => Some(Ordering::Greater),
        (false, true) => Some(Ordering::Less),
        (false, false) => {
            for (ia, ib) in pa.pre.iter().zip(pb.pre.iter()) {
                let ord = match (ia.parse::<u64>(), ib.parse::<u64>()) {
                    (Ok(na), Ok(nb)) => na.cmp(&nb),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => ia.cmp(ib),
                };
                if ord != Ordering::Equal {
                    return Some(ord);
                }
            }
            Some(pa.pre.len().cmp(&pb.pre.len()))
        }
    }
}

pub fn is_version_older(current: &str, target: &str) -> bool {
    matches!(compare_semver(current, target), Some(Ordering::Less))
}

pub fn native_asset_name(target_version: &str) -> Result<String, String> {
    let ver = validate_version_str(target_version)?;
    let os_tag = match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "macos",
        "windows" => "windows",
        other => return Err(format!("unsupported OS for self_update: {other}")),
    };
    let arch_tag = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => return Err(format!("unsupported arch for self_update: {other}")),
    };
    let ext = if os_tag == "windows" { "zip" } else { "tar.gz" };
    Ok(format!("neo-agent-os-{ver}-{os_tag}-{arch_tag}.{ext}"))
}

pub fn parse_sha256sums(raw: &str, asset_name: &str) -> Option<String> {
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let hash = parts.next()?;
        let rest = parts.next()?;
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let cleaned = rest
            .strip_prefix("./")
            .or_else(|| rest.strip_prefix('*'))
            .unwrap_or(rest);
        if cleaned == asset_name {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
}

fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h.eq_ignore_ascii_case("localhost") || h == "127.0.0.1" || h == "::1"
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str()
            .zip(b.host_str())
            .is_some_and(|(ha, hb)| ha.eq_ignore_ascii_case(hb))
        && a.port_or_known_default() == b.port_or_known_default()
}

pub fn validate_mirror_url(mirror: &str, relay_url: &str) -> Result<String, String> {
    let trimmed = mirror.trim().trim_end_matches('/');
    let url = Url::parse(trimmed).map_err(|e| format!("invalid mirror URL '{mirror}': {e}"))?;
    let host = url.host_str().ok_or_else(|| format!("mirror URL missing host: {mirror}"))?;
    match url.scheme() {
        "https" => Ok(trimmed.to_string()),
        "http" => {
            if is_loopback_host(host) {
                return Ok(trimmed.to_string());
            }
            if let Ok(mut relay_parsed) = Url::parse(relay_url) {
                if relay_parsed.scheme() == "ws" {
                    let _ = relay_parsed.set_scheme("http");
                } else if relay_parsed.scheme() == "wss" {
                    let _ = relay_parsed.set_scheme("https");
                }
                if same_origin(&url, &relay_parsed) {
                    return Ok(trimmed.to_string());
                }
            }
            Err(format!(
                "insecure HTTP mirror URL rejected (use HTTPS or same origin as relay): {mirror}"
            ))
        }
        other => Err(format!("unsupported mirror URL scheme '{other}': {mirror}")),
    }
}

fn validate_asset_filename(asset: &str) -> Result<String, String> {
    let trimmed = asset.trim();
    if trimmed.is_empty()
        || trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(format!("invalid release asset filename: {asset:?}"));
    }
    Ok(trimmed.to_string())
}

#[derive(Debug, Clone)]
pub struct SelfUpdateRequest {
    pub target_version: String,
    pub master_version: Option<String>,
    pub mirrors: Vec<String>,
    pub asset: Option<String>,
    pub expected_sha256: Option<String>,
    pub force: bool,
}

/// Exit code emitted by `neo-agent-os` after staging a `self_update` when running under
/// `neo-agent-os-bg` (`NEO_BG_SUPERVISED=1`), requesting a clean headless respawn.
#[cfg(any(windows, test))]
pub const RESTART_FOR_UPDATE_EXIT_CODE: i32 = 75;

#[derive(Debug, Clone)]
pub struct RestartPlan {
    pub binary_path: PathBuf,
    pub previous_version: String,
    pub target_version: String,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RestartContext {
    pub cluster_id: String,
    pub env_file: Option<PathBuf>,
    pub policy_path: PathBuf,
    pub ota_cache_dir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct SelfUpdateOutcome {
    pub status: String,
    pub previous_version: String,
    pub target_version: String,
    pub installed_path: Option<PathBuf>,
    pub sha256: Option<String>,
    pub mirror: Option<String>,
    pub restart_plan: Option<RestartPlan>,
}

fn build_default_mirrors(relay_url: &str, target_version: &str) -> Vec<String> {
    let mut mirrors = Vec::new();
    if let Ok(mut url) = Url::parse(relay_url) {
        match url.scheme() {
            "https" | "wss" => {
                let _ = url.set_scheme("https");
                url.set_path("");
                url.set_query(None);
                let base = url.to_string().trim_end_matches('/').to_string();
                mirrors.push(format!("{base}/dl/v{target_version}"));
            }
            "http" | "ws" => {
                let _ = url.set_scheme("http");
                url.set_path("");
                url.set_query(None);
                let base = url.to_string().trim_end_matches('/').to_string();
                mirrors.push(format!("{base}/dl/v{target_version}"));
            }
            _ => {}
        }
    }
    mirrors.push(format!("{GITHUB_RELEASE_BASE}/v{target_version}"));
    mirrors
}

fn is_raw_executable_bytes(bytes: &[u8]) -> bool {
    if bytes.len() < 4 {
        return false;
    }
    // ELF, Mach-O (32/64/universal), PE (MZ), or POSIX shebang script (used in tests)
    bytes.starts_with(b"\x7fELF")
        || bytes.starts_with(&[0xCF, 0xFA, 0xED, 0xFE])
        || bytes.starts_with(&[0xFE, 0xED, 0xFA, 0xCF])
        || bytes.starts_with(&[0xCE, 0xFA, 0xED, 0xFE])
        || bytes.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE])
        || bytes.starts_with(b"MZ")
        || bytes.starts_with(b"#!")
}

fn find_extracted_binary(dir: &Path, expected_name: &str) -> Option<PathBuf> {
    fn walk(cur: &Path, expected_name: &str, depth: usize) -> Option<PathBuf> {
        if depth > 4 {
            return None;
        }
        let entries = std::fs::read_dir(cur).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.eq_ignore_ascii_case(expected_name) {
                        return Some(path);
                    }
                }
            } else if meta.is_dir() {
                if let Some(found) = walk(&path, expected_name, depth + 1) {
                    return Some(found);
                }
            }
        }
        None
    }
    walk(dir, expected_name, 0)
}

fn extract_binary_from_archive(
    archive_path: &Path,
    asset_name: &str,
    archive_bytes: &[u8],
    extract_dir: &Path,
) -> Result<PathBuf, String> {
    let bin_name = if cfg!(windows) {
        "neo-agent-os.exe"
    } else {
        "neo-agent-os"
    };

    if asset_name.ends_with(".tar.gz") || asset_name.ends_with(".tgz") {
        let mut cmd = std::process::Command::new("tar");
        cmd.args([
            "-xzf",
            archive_path.to_string_lossy().as_ref(),
            "-C",
            extract_dir.to_string_lossy().as_ref(),
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd
            .output()
            .map_err(|e| format!("failed to run tar for {asset_name}: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "tar extraction failed ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        return find_extracted_binary(extract_dir, bin_name)
            .ok_or_else(|| format!("{bin_name} not found inside {asset_name}"));
    }

    if asset_name.ends_with(".zip") {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let tar_ok = std::process::Command::new("tar")
                .args([
                    "-xf",
                    archive_path.to_string_lossy().as_ref(),
                    "-C",
                    extract_dir.to_string_lossy().as_ref(),
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !tar_ok {
                let ps_script = format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    archive_path.to_string_lossy().replace('\'', "''"),
                    extract_dir.to_string_lossy().replace('\'', "''"),
                );
                let ps_out = std::process::Command::new("powershell")
                    .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                    .map_err(|e| format!("failed to run PowerShell Expand-Archive: {e}"))?;
                if !ps_out.status.success() {
                    return Err(format!(
                        "Expand-Archive failed ({}): {}",
                        ps_out.status,
                        String::from_utf8_lossy(&ps_out.stderr).trim()
                    ));
                }
            }
        }
        #[cfg(not(windows))]
        {
            let tar_ok = std::process::Command::new("tar")
                .args([
                    "-xf",
                    archive_path.to_string_lossy().as_ref(),
                    "-C",
                    extract_dir.to_string_lossy().as_ref(),
                ])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !tar_ok {
                let unzip_out = std::process::Command::new("unzip")
                    .args([
                        "-oq",
                        archive_path.to_string_lossy().as_ref(),
                        "-d",
                        extract_dir.to_string_lossy().as_ref(),
                    ])
                    .output()
                    .map_err(|e| format!("failed to extract zip {asset_name}: {e}"))?;
                if !unzip_out.status.success() {
                    return Err(format!(
                        "zip extraction failed ({}): {}",
                        unzip_out.status,
                        String::from_utf8_lossy(&unzip_out.stderr).trim()
                    ));
                }
            }
        }
        return find_extracted_binary(extract_dir, bin_name)
            .ok_or_else(|| format!("{bin_name} not found inside {asset_name}"));
    }

    if is_raw_executable_bytes(archive_bytes) {
        let dest = extract_dir.join(bin_name);
        std::fs::write(&dest, archive_bytes)
            .map_err(|e| format!("failed to stage raw binary: {e}"))?;
        return Ok(dest);
    }

    Err(format!(
        "unsupported update archive format for {asset_name}"
    ))
}

fn extract_version_from_cli_output(output: &str) -> Option<String> {
    for tok in output.split_whitespace() {
        let cleaned = tok.trim_matches(|c: char| matches!(c, ',' | ';' | '(' | ')' | '[' | ']' | '"' | '\''));
        if let Ok(v) = validate_version_str(cleaned) {
            return Some(v);
        }
    }
    None
}

fn verify_staged_binary_runs(bin_path: &Path, expected_version: &str) -> Result<String, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(bin_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("failed to chmod staged binary: {e}"))?;
    }
    let mut cmd = std::process::Command::new(bin_path);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("staged binary failed to execute --version: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "staged binary --version exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let reported = extract_version_from_cli_output(&stdout).ok_or_else(|| {
        format!("staged binary --version did not report a valid semver version: {stdout:?}")
    })?;
    if compare_semver(&reported, expected_version) != Some(Ordering::Equal) {
        return Err(format!(
            "staged binary version mismatch: binary reports v{reported}, expected exact master version v{expected_version}"
        ));
    }
    Ok(stdout)
}

fn install_staged_binary(
    staged_bin: &Path,
    target_exe: &Path,
    ota_dir: &Path,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    std::fs::create_dir_all(ota_dir)
        .map_err(|e| format!("failed to create OTA dir {}: {e}", ota_dir.display()))?;

    let backup_name = if cfg!(windows) {
        "neo-agent-os.exe.prev"
    } else {
        "neo-agent-os.prev"
    };
    let backup_path = ota_dir.join(backup_name);
    let backed_up = if target_exe.exists() {
        std::fs::copy(target_exe, &backup_path).ok().map(|_| backup_path.clone())
    } else {
        None
    };

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Some(parent) = target_exe.parent() {
            let tmp_name = format!(
                ".neo-agent-os.new.{}.{}",
                std::process::id(),
                now_unix_secs()
            );
            let tmp_path = parent.join(tmp_name);
            let direct_res = std::fs::copy(staged_bin, &tmp_path)
                .and_then(|_| {
                    std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))
                })
                .and_then(|_| std::fs::rename(&tmp_path, target_exe));
            if direct_res.is_ok() {
                return Ok((target_exe.to_path_buf(), backed_up));
            }
            let _ = std::fs::remove_file(&tmp_path);
        }

        // Read-only system binary fallback (e.g., Linux systemd ProtectSystem=strict):
        // install into writable `<ota_dir>/active/neo-agent-os` so per-cluster isolation holds.
        let active_dir = ota_dir.join("active");
        std::fs::create_dir_all(&active_dir)
            .map_err(|e| format!("failed to create {}: {e}", active_dir.display()))?;
        let active_bin = active_dir.join("neo-agent-os");
        let tmp_active = active_dir.join(format!(".neo-agent-os.new.{}", std::process::id()));
        std::fs::copy(staged_bin, &tmp_active)
            .map_err(|e| format!("failed to copy staged binary to OTA active dir: {e}"))?;
        std::fs::set_permissions(&tmp_active, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("failed to chmod OTA active binary: {e}"))?;
        std::fs::rename(&tmp_active, &active_bin)
            .map_err(|e| format!("failed to activate OTA binary: {e}"))?;
        Ok((active_bin, backed_up))
    }

    #[cfg(windows)]
    {
        if let Some(parent) = target_exe.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let old_path = PathBuf::from(format!("{}.old", target_exe.to_string_lossy()));
        let mut renamed_old = false;
        if target_exe.exists() {
            let _ = std::fs::remove_file(&old_path);
            if std::fs::rename(target_exe, &old_path).is_ok() {
                renamed_old = true;
            }
        }
        if let Err(e) = std::fs::copy(staged_bin, target_exe) {
            if renamed_old {
                let _ = std::fs::rename(&old_path, target_exe);
            }
            return Err(format!(
                "failed to replace {}: {e}",
                target_exe.display()
            ));
        }
        Ok((target_exe.to_path_buf(), backed_up))
    }
}

#[cfg(any(windows, test))]
pub(crate) fn install_companion_binary_file(
    staged_companion: &Path,
    target_exe: &Path,
    companion_name: &str,
) -> Result<PathBuf, String> {
    let parent = target_exe
        .parent()
        .ok_or_else(|| format!("target_exe {} has no parent directory", target_exe.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    let dest = parent.join(companion_name);

    #[cfg(windows)]
    {
        let old_path = PathBuf::from(format!("{}.old", dest.to_string_lossy()));
        let mut renamed_old = false;
        if dest.exists() {
            let _ = std::fs::remove_file(&old_path);
            if std::fs::rename(&dest, &old_path).is_ok() {
                renamed_old = true;
            }
        }
        if let Err(e) = std::fs::copy(staged_companion, &dest) {
            if renamed_old {
                let _ = std::fs::rename(&old_path, &dest);
            }
            return Err(format!("failed to replace {}: {e}", dest.display()));
        }
        Ok(dest)
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let tmp_path = parent.join(format!(
            ".{companion_name}.new.{}.{}",
            std::process::id(),
            now_unix_secs()
        ));
        std::fs::copy(staged_companion, &tmp_path)
            .map_err(|e| format!("failed to stage companion {}: {e}", dest.display()))?;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("failed to chmod companion {}: {e}", dest.display()))?;
        std::fs::rename(&tmp_path, &dest)
            .map_err(|e| format!("failed to install companion {}: {e}", dest.display()))?;
        Ok(dest)
    }
}

pub async fn execute_self_update(
    req: &SelfUpdateRequest,
    relay_url: &str,
    ota_cache_dir: Option<&Path>,
    updater_state_path: Option<&Path>,
    install_target_override: Option<&Path>,
) -> Result<SelfUpdateOutcome, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let target_version = validate_version_str(&req.target_version)?;

    if let Some(ref raw_master) = req.master_version {
        let master_ver = validate_version_str(raw_master)?;
        match compare_semver(&target_version, &master_ver) {
            Some(Ordering::Equal) => {}
            Some(Ordering::Greater) => {
                return Err(format!(
                    "target_version v{target_version} exceeds master_version v{master_ver}; automatic update must match Master Neo version"
                ));
            }
            _ => {
                return Err(format!(
                    "target_version v{target_version} does not match master_version v{master_ver}"
                ));
            }
        }
    }

    if !req.force && !is_version_older(&current_version, &target_version) {
        return Ok(SelfUpdateOutcome {
            status: "up_to_date".to_string(),
            previous_version: current_version,
            target_version,
            installed_path: None,
            sha256: None,
            mirror: None,
            restart_plan: None,
        });
    }

    let asset = match req.asset.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(a) => validate_asset_filename(a)?,
        None => native_asset_name(&target_version)?,
    };

    let raw_mirrors = if req.mirrors.is_empty() {
        build_default_mirrors(relay_url, &target_version)
    } else {
        req.mirrors.clone()
    };

    let mut valid_mirrors = Vec::new();
    let mut mirror_errors = Vec::new();
    for m in &raw_mirrors {
        match validate_mirror_url(m, relay_url) {
            Ok(v) => valid_mirrors.push(v),
            Err(e) => mirror_errors.push(e),
        }
    }
    if valid_mirrors.is_empty() {
        return Err(if mirror_errors.is_empty() {
            "no update mirrors configured".to_string()
        } else {
            mirror_errors.join("; ")
        });
    }

    let timeout = Duration::from_secs(UPDATE_DOWNLOAD_TIMEOUT_SECS);
    let mut downloaded: Option<(String, Vec<u8>, String)> = None;
    let mut download_errors = Vec::new();

    for mirror in &valid_mirrors {
        let asset_url = format!("{mirror}/{asset}");
        let archive_bytes = match http_download_bytes(&asset_url, MAX_UPDATE_ARCHIVE_BYTES, timeout).await {
            Ok(b) => b,
            Err(e) => {
                download_errors.push(format!("{asset_url}: {e}"));
                continue;
            }
        };

        let expected_sha = if let Some(ref pinned) = req.expected_sha256 {
            let clean = pinned.trim().to_ascii_lowercase();
            if clean.len() != 64 || !clean.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("invalid expected_sha256 format".to_string());
            }
            clean
        } else {
            let sums_url = format!("{mirror}/SHA256SUMS.txt");
            let sums_bytes = match http_download_bytes(&sums_url, 1024 * 1024, Duration::from_secs(30)).await {
                Ok(b) => b,
                Err(e) => {
                    download_errors.push(format!("{sums_url}: {e}"));
                    continue;
                }
            };
            let sums_str = String::from_utf8_lossy(&sums_bytes);
            match parse_sha256sums(&sums_str, &asset) {
                Some(h) => h,
                None => {
                    download_errors.push(format!(
                        "{sums_url}: checksum entry for {asset} not found"
                    ));
                    continue;
                }
            }
        };

        let actual_sha = hex::encode(Sha256::digest(&archive_bytes));
        if actual_sha != expected_sha {
            return Err(format!(
                "SHA-256 mismatch for {asset} from {mirror}: expected {expected_sha}, got {actual_sha}"
            ));
        }

        downloaded = Some((mirror.clone(), archive_bytes, actual_sha));
        break;
    }

    let (used_mirror, archive_bytes, actual_sha) = downloaded.ok_or_else(|| {
        format!(
            "failed to download {asset} from all mirrors: {}",
            download_errors.join(" | ")
        )
    })?;

    let ota_base = ota_cache_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("neo-agent-ota"));
    let staging_dir = ota_base.join(format!(
        "stage-{}-{}",
        std::process::id(),
        now_unix_nanos()
    ));
    let extract_dir = staging_dir.join("extract");
    std::fs::create_dir_all(&extract_dir)
        .map_err(|e| format!("failed to create staging dir: {e}"))?;

    let result = (|| -> Result<SelfUpdateOutcome, String> {
        let archive_path = staging_dir.join(&asset);
        std::fs::write(&archive_path, &archive_bytes)
            .map_err(|e| format!("failed to write staged archive: {e}"))?;

        let staged_bin =
            extract_binary_from_archive(&archive_path, &asset, &archive_bytes, &extract_dir)?;
        let _ver_output = verify_staged_binary_runs(&staged_bin, &target_version)?;

        let target_exe = match install_target_override {
            Some(p) => p.to_path_buf(),
            None => std::env::current_exe()
                .map_err(|e| format!("failed to resolve current_exe: {e}"))?,
        };

        let (installed_path, backup_path) =
            install_staged_binary(&staged_bin, &target_exe, &ota_base)?;

        #[cfg(windows)]
        {
            if let Some(staged_bg) = find_extracted_binary(&extract_dir, "neo-agent-os-bg.exe") {
                if let Err(e) =
                    install_companion_binary_file(&staged_bg, &installed_path, "neo-agent-os-bg.exe")
                {
                    eprintln!(
                        "[updater] warning: failed to update companion neo-agent-os-bg.exe: {e}"
                    );
                }
            }
        }

        let state_file = updater_state_path
            .map(Path::to_path_buf)
            .unwrap_or_else(|| ota_base.join("updater-state.json"));
        if let Ok(mut mgr) = UpdaterManager::load_or_init(&state_file) {
            let _ = mgr.record_pending_boot(
                &target_version,
                backup_path.as_deref(),
                &installed_path,
            );
        }

        Ok(SelfUpdateOutcome {
            status: "restarting".to_string(),
            previous_version: current_version.clone(),
            target_version: target_version.clone(),
            installed_path: Some(installed_path.clone()),
            sha256: Some(actual_sha),
            mirror: Some(used_mirror),
            restart_plan: Some(RestartPlan {
                binary_path: installed_path,
                previous_version: current_version,
                target_version,
            }),
        })
    })();

    let _ = std::fs::remove_dir_all(&staging_dir);
    result
}

/// Runs early on daemon startup to clean up post-update artifacts, roll back a timed-out
/// `PendingBoot` update, or re-exec into an OTA-staged active binary (Linux system mode).
pub fn maybe_handoff_or_rollback_on_boot(
    state_path: Option<&Path>,
    ota_cache_dir: Option<&Path>,
) {
    #[cfg(windows)]
    {
        if std::env::var("NEO_UPDATE_WAIT_PID").is_ok() {
            std::thread::sleep(Duration::from_millis(500));
        }
        if let Ok(exe) = std::env::current_exe() {
            let old = PathBuf::from(format!("{}.old", exe.to_string_lossy()));
            let _ = std::fs::remove_file(&old);
            let bg_old = PathBuf::from(format!(
                "{}.old",
                crate::enroll::windows_bg_launcher_path(&exe).to_string_lossy()
            ));
            let _ = std::fs::remove_file(&bg_old);
        }
    }

    let Some(sp) = state_path else {
        return;
    };
    let Ok(mut mgr) = UpdaterManager::load_or_init(sp) else {
        return;
    };

    if mgr.state().status == BootStatus::PendingBoot {
        if let Some(since) = mgr.state().pending_since_unix {
            let elapsed = now_unix_secs().saturating_sub(since);
            if elapsed > HEALTHY_COMMIT_WINDOW_SECS {
                eprintln!(
                    "[updater] previous pending_boot timed out ({elapsed}s > {HEALTHY_COMMIT_WINDOW_SECS}s); rolling back"
                );
                let _ = mgr.rollback();
            }
        }
    }

    #[cfg(unix)]
    if let (Some(ota_dir), Some(active_str)) = (ota_cache_dir, mgr.state().active_binary_path.as_deref()) {
        if mgr.state().status == BootStatus::RolledBack {
            return;
        }
        if std::env::var("NEO_OTA_REEXEC").ok().as_deref() == Some("1") {
            return;
        }
        let active_p = Path::new(active_str);
        if !active_p.is_file() {
            return;
        }
        let (Ok(canon_ota), Ok(canon_active), Ok(canon_cur)) = (
            std::fs::canonicalize(ota_dir),
            std::fs::canonicalize(active_p),
            std::env::current_exe().and_then(std::fs::canonicalize),
        ) else {
            return;
        };
        if canon_active.starts_with(&canon_ota) && canon_active != canon_cur {
            use std::os::unix::process::CommandExt;
            let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
            let err = std::process::Command::new(&canon_active)
                .args(&args)
                .env("NEO_OTA_REEXEC", "1")
                .exec();
            eprintln!(
                "[updater] failed to hand off to OTA active binary {}: {err}",
                canon_active.display()
            );
        }
    }

    #[cfg(not(unix))]
    let _ = ota_cache_dir;
}

/// Replaces or relaunches the daemon process using the newly installed binary.
pub fn perform_process_restart_with_context(
    plan: &RestartPlan,
    ctx: Option<&RestartContext>,
) -> Result<(), String> {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    eprintln!(
        "[updater] restarting neo-agent-os ({} -> {}) via {}",
        plan.previous_version,
        plan.target_version,
        plan.binary_path.display()
    );

    #[cfg(unix)]
    {
        let _ = ctx;
        use std::os::unix::process::CommandExt;
        let err = std::process::Command::new(&plan.binary_path)
            .args(&args)
            .env("NEO_UPDATED_FROM", &plan.previous_version)
            .env("NEO_OTA_REEXEC", "1")
            .exec();
        Err(format!(
            "exec() failed for {}: {err}",
            plan.binary_path.display()
        ))
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

        if let Some(c) = ctx {
            crate::enroll::best_effort_self_heal_windows_service(
                &c.cluster_id,
                c.env_file.as_deref(),
                &c.policy_path,
                c.ota_cache_dir.as_deref(),
            );
        }

        // Primary path: supervised by neo-agent-os-bg.exe (v0.11.1+).
        // Exit with dedicated code 75 so the GUI-subsystem supervisor keeps Task Scheduler
        // state intact, releases the old Job Object, and silently spawns the updated binary.
        if std::env::var("NEO_BG_SUPERVISED").ok().as_deref() == Some("1") {
            eprintln!(
                "[updater] exiting with code {RESTART_FOR_UPDATE_EXIT_CODE} for neo-agent-os-bg supervised respawn"
            );
            std::process::exit(RESTART_FOR_UPDATE_EXIT_CODE);
        }

        // Secondary path: running outside v0.11.1+ supervision (e.g., legacy direct task or
        // older neo-agent-os-bg.exe whose Job Object lacks BREAKAWAY_OK). Prefer handing off
        // to Windows Task Scheduler (svchost.exe runs outside any Job Object and launches
        // the migrated neo-agent-os-bg.exe silently with StopExisting).
        if let Some(c) = ctx {
            if crate::enroll::restart_windows_scheduled_task_replacing_existing(
                &c.cluster_id,
                &plan.binary_path,
                c.env_file.as_deref(),
                &c.policy_path,
                c.ota_cache_dir.as_deref(),
            ) {
                std::process::exit(0);
            }
        }

        // Fallback (e.g. HKCU Run or standalone invocation): spawn sibling neo-agent-os-bg.exe
        // if present, else updated neo-agent-os.exe, using CREATE_NO_WINDOW (never combined
        // with DETACHED_PROCESS, which Win32 docs specify ignores CREATE_NO_WINDOW).
        let bg_candidate = crate::enroll::windows_bg_launcher_path(&plan.binary_path);
        let (launch_bin, launch_args) = if bg_candidate.is_file() {
            let mut full_args: Vec<std::ffi::OsString> = Vec::new();
            if let Some(c) = ctx {
                if let Some(log_file) = crate::enroll::windows_cluster_log_file(
                    &c.cluster_id,
                    c.env_file.as_deref(),
                    &c.policy_path,
                ) {
                    full_args.push(std::ffi::OsString::from("--log-file"));
                    full_args.push(log_file.into_os_string());
                }
            }
            full_args.extend(args.iter().cloned());
            (bg_candidate, full_args)
        } else {
            (plan.binary_path.clone(), args)
        };

        let spawn_with_flags = |flags: u32| {
            std::process::Command::new(&launch_bin)
                .args(&launch_args)
                .env("NEO_UPDATED_FROM", &plan.previous_version)
                .env("NEO_UPDATE_WAIT_PID", std::process::id().to_string())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(flags)
                .spawn()
        };

        let base_flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
        match spawn_with_flags(base_flags | CREATE_BREAKAWAY_FROM_JOB) {
            Ok(_) => {}
            Err(e) if e.raw_os_error() == Some(5) => {
                spawn_with_flags(base_flags)
                    .map_err(|e2| format!("failed to spawn updated neo-agent-os: {e2}"))?;
            }
            Err(e) => {
                return Err(format!("failed to spawn updated neo-agent-os: {e}"));
            }
        }
        std::process::exit(0);
    }
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    #[cfg(unix)]
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[cfg(unix)]
    use tokio::net::TcpListener;

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

    #[test]
    fn semver_and_checksum_and_mirror_validation() {
        assert!(is_version_older("0.8.0", "0.9.1"));
        assert!(is_version_older("v0.9.0", "0.9.1"));
        assert!(is_version_older("0.9.1-rc.1", "0.9.1"));
        assert!(is_version_older("0.9.1", "0.10.0"));
        assert!(!is_version_older("0.9.1", "0.9.1"));
        assert!(!is_version_older("0.10.0", "0.9.1"));
        assert!(!is_version_older("1.0.0", "0.9.1"));

        let sums = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  neo-agent-os-0.9.2-linux-x64.tar.gz\n\
                    fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210 *neo-agent-os-0.9.2-windows-x64.zip\n";
        assert_eq!(
            parse_sha256sums(sums, "neo-agent-os-0.9.2-linux-x64.tar.gz").as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
        assert_eq!(
            parse_sha256sums(sums, "neo-agent-os-0.9.2-windows-x64.zip").as_deref(),
            Some("fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210")
        );
        assert!(parse_sha256sums(sums, "other.tar.gz").is_none());

        assert!(validate_mirror_url("https://neo.1inch.cn:18443/dl/v0.9.2", "https://neo.1inch.cn:18443").is_ok());
        assert!(validate_mirror_url("http://127.0.0.1:8080/dl/v0.9.2", "https://neo.1inch.cn:18443").is_ok());
        assert!(validate_mirror_url("http://10.0.0.5:18443/dl/v0.9.2", "http://10.0.0.5:18443").is_ok());
        assert!(validate_mirror_url("http://evil.example/dl/v0.9.2", "https://neo.1inch.cn:18443").is_err());
        assert!(validate_version_str("0.9.2").is_ok());
        assert!(validate_version_str("../etc/passwd").is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn self_update_downloads_follows_redirect_verifies_sha_and_replaces_binary() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = std::env::temp_dir().join(format!(
            "neo_self_update_test_{}_{}",
            std::process::id(),
            now_unix_nanos()
        ));
        let src_dir = tmp.join("pkg");
        let ota_dir = tmp.join("ota");
        let bin_dir = tmp.join("bin");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();

        // Build a real .tar.gz containing an executable `neo-agent-os` stub script
        let fake_new_bin = src_dir.join("neo-agent-os");
        std::fs::write(&fake_new_bin, "#!/bin/sh\necho 'neo-agent-os 9.9.9'\n").unwrap();
        std::fs::set_permissions(&fake_new_bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        let asset = native_asset_name("9.9.9").unwrap();
        let archive_path = tmp.join(&asset);
        let tar_status = std::process::Command::new("tar")
            .args([
                "-czf",
                archive_path.to_string_lossy().as_ref(),
                "-C",
                src_dir.to_string_lossy().as_ref(),
                "neo-agent-os",
            ])
            .status()
            .unwrap();
        assert!(tar_status.success());

        let archive_bytes = std::fs::read(&archive_path).unwrap();
        let archive_sha = hex::encode(Sha256::digest(&archive_bytes));
        let sums_body = format!("{archive_sha}  {asset}\n").into_bytes();

        // Mock HTTP server that 302-redirects /dl/v9.9.9/<asset> -> /cdn/<asset>
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let asset_clone = asset.clone();
        let archive_clone = archive_bytes.clone();
        let sums_clone = sums_body.clone();
        let srv = tokio::spawn(async move {
            for _ in 0..8 {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]);
                let req_path = head
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/");
                if req_path == format!("/dl/v9.9.9/{asset_clone}") {
                    let resp = format!(
                        "HTTP/1.1 302 Found\r\nLocation: /cdn/{asset_clone}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                } else if req_path == format!("/cdn/{asset_clone}") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        archive_clone.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.write_all(&archive_clone).await;
                } else if req_path == "/dl/v9.9.9/SHA256SUMS.txt" {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        sums_clone.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.write_all(&sums_clone).await;
                } else {
                    let _ = stream
                        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await;
                }
            }
        });

        let target_exe = bin_dir.join("neo-agent-os");
        std::fs::write(&target_exe, "#!/bin/sh\necho 'neo-agent-os 0.1.0'\n").unwrap();
        std::fs::set_permissions(&target_exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let state_path = ota_dir.join("updater-state.json");

        // 0. Target version exceeding master_version must be rejected before download
        let higher_req = SelfUpdateRequest {
            target_version: "9.9.9".to_string(),
            master_version: Some("9.9.8".to_string()),
            mirrors: vec![format!("http://{addr}/dl/v9.9.9")],
            asset: Some(asset.clone()),
            expected_sha256: None,
            force: false,
        };
        let higher_err = execute_self_update(
            &higher_req,
            &format!("http://{addr}"),
            Some(&ota_dir),
            Some(&state_path),
            Some(&target_exe),
        )
        .await
        .unwrap_err();
        assert!(higher_err.contains("exceeds master_version"));

        // 1. Tampered expected_sha256 must fail without touching target_exe
        let bad_req = SelfUpdateRequest {
            target_version: "9.9.9".to_string(),
            master_version: Some("9.9.9".to_string()),
            mirrors: vec![format!("http://{addr}/dl/v9.9.9")],
            asset: Some(asset.clone()),
            expected_sha256: Some("0".repeat(64)),
            force: false,
        };
        let bad_res = execute_self_update(
            &bad_req,
            &format!("http://{addr}"),
            Some(&ota_dir),
            Some(&state_path),
            Some(&target_exe),
        )
        .await;
        assert!(bad_res.is_err());
        assert!(std::fs::read_to_string(&target_exe).unwrap().contains("0.1.0"));

        // 2. Valid SHA256SUMS.txt + 302 redirect succeeds and swaps binary atomically
        let ok_req = SelfUpdateRequest {
            target_version: "9.9.9".to_string(),
            master_version: Some("9.9.9".to_string()),
            mirrors: vec![format!("http://{addr}/dl/v9.9.9")],
            asset: Some(asset.clone()),
            expected_sha256: None,
            force: false,
        };
        let outcome = execute_self_update(
            &ok_req,
            &format!("http://{addr}"),
            Some(&ota_dir),
            Some(&state_path),
            Some(&target_exe),
        )
        .await
        .unwrap();
        assert_eq!(outcome.status, "restarting");
        assert_eq!(outcome.target_version, "9.9.9");
        assert_eq!(outcome.sha256.as_deref(), Some(archive_sha.as_str()));
        assert_eq!(outcome.installed_path.as_deref(), Some(target_exe.as_path()));
        assert!(std::fs::read_to_string(&target_exe).unwrap().contains("9.9.9"));
        assert!(ota_dir.join("neo-agent-os.prev").exists());

        let mgr = UpdaterManager::load_or_init(&state_path).unwrap();
        assert_eq!(mgr.state().status, BootStatus::PendingBoot);
        assert_eq!(mgr.state().candidate_version.as_deref(), Some("9.9.9"));

        // 3. Up-to-date version without force returns up_to_date without hitting network
        let same_req = SelfUpdateRequest {
            target_version: env!("CARGO_PKG_VERSION").to_string(),
            master_version: Some(env!("CARGO_PKG_VERSION").to_string()),
            mirrors: vec![],
            asset: None,
            expected_sha256: None,
            force: false,
        };
        let same = execute_self_update(
            &same_req,
            &format!("http://{addr}"),
            Some(&ota_dir),
            Some(&state_path),
            Some(&target_exe),
        )
        .await
        .unwrap();
        assert_eq!(same.status, "up_to_date");
        assert!(same.restart_plan.is_none());

        // 4. Staged binary whose --version exceeds or mismatches target_version is rejected
        let mismatched_bin = tmp.join("mismatched-bin");
        std::fs::write(&mismatched_bin, "#!/bin/sh\necho 'neo-agent-os 9.9.10'\n").unwrap();
        std::fs::set_permissions(&mismatched_bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mismatch_err = verify_staged_binary_runs(&mismatched_bin, "9.9.9").unwrap_err();
        assert!(mismatch_err.contains("version mismatch"));

        srv.abort();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn companion_bg_launcher_installs_and_replaces_cleanly() {
        assert_eq!(RESTART_FOR_UPDATE_EXIT_CODE, 75);
        let tmp = std::env::temp_dir().join(format!(
            "neo_companion_bg_test_{}_{}",
            std::process::id(),
            now_unix_nanos()
        ));
        let bin_dir = tmp.join("bin");
        let stage_dir = tmp.join("stage");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::create_dir_all(&stage_dir).unwrap();

        let target_exe = bin_dir.join("neo-agent-os.exe");
        std::fs::write(&target_exe, b"main-v0.11.1").unwrap();
        let existing_bg = bin_dir.join("neo-agent-os-bg.exe");
        std::fs::write(&existing_bg, b"bg-v0.9.2").unwrap();

        let staged_bg = stage_dir.join("neo-agent-os-bg.exe");
        std::fs::write(&staged_bg, b"bg-v0.11.1").unwrap();

        let installed =
            install_companion_binary_file(&staged_bg, &target_exe, "neo-agent-os-bg.exe").unwrap();
        assert_eq!(installed, existing_bg);
        assert_eq!(std::fs::read(&installed).unwrap(), b"bg-v0.11.1");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
