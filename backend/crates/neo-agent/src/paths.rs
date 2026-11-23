//! Where things are on this machine: the per-user data directory, the place of the instance lock, the Antigravity CLI
//! runtime, and the web app's files.

use std::path::{Path, PathBuf};

fn var(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from)
}

fn home() -> PathBuf {
    var("HOME").or_else(|| var("USERPROFILE")).unwrap_or_else(std::env::temp_dir)
}

/// The per-user data directory: `~/Library/Application Support/neo-agent` on macOS, `%LOCALAPPDATA%\neo-agent` on
/// Windows, and `$XDG_STATE_HOME/neo-agent` (by default `~/.local/state/neo-agent`) elsewhere.
pub fn default_data_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support").join("neo-agent")
    } else if cfg!(windows) {
        var("LOCALAPPDATA").unwrap_or_else(|| home().join("AppData").join("Local")).join("neo-agent")
    } else {
        var("XDG_STATE_HOME").filter(|dir| dir.is_absolute()).unwrap_or_else(|| home().join(".local").join("state")).join("neo-agent")
    }
}

/// Where the per-user instance lock is kept: one place per user, whatever data directory an instance uses.
pub fn runtime_dir() -> PathBuf {
    if let Some(dir) = var("NEO_RUNTIME_DIR") {
        return dir;
    }
    if cfg!(target_os = "macos") || cfg!(windows) {
        return default_data_dir().join("run");
    }
    match var("XDG_RUNTIME_DIR").filter(|dir| dir.is_absolute()) {
        Some(dir) => dir.join("neo-agent"),
        None => {
            let user = std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_else(|_| "user".into());
            std::env::temp_dir().join(format!("neo-agent-{user}"))
        }
    }
}

/// The folder the running program is in.
pub fn program_dir() -> Option<PathBuf> {
    let program = std::env::current_exe().ok()?;
    // A link to the program, as package managers make, counts as where it really is.
    let program = program.canonicalize().unwrap_or(program);
    program.parent().map(Path::to_path_buf)
}

/// The folders, relative to the program, where an installation keeps what it bundles: beside the program, one level
/// up, and in a macOS app bundle's resources.
fn bundled(program_dir: &Path, folder: &str) -> Vec<PathBuf> {
    let mut places = vec![program_dir.join(folder)];
    if let Some(parent) = program_dir.parent() {
        places.push(parent.join(folder));
        places.push(parent.join("Resources").join(folder));
    }
    places
}

fn executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata().is_ok_and(|info| info.is_file() && info.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

fn names(name: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd"), name.to_string()]
    } else {
        vec![name.to_string()]
    }
}

/// A program on a `PATH`.
pub fn on_path(name: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let path = path?;
    std::env::split_paths(path).flat_map(|dir| names(name).into_iter().map(move |file| dir.join(file))).find(|candidate| executable(candidate))
}

/// Where the Antigravity CLI official installer puts `agy`: `~/.local/bin` on macOS and Linux; on Windows
/// `%LOCALAPPDATA%\agy\bin` and `%USERPROFILE%\.local\bin`.
pub fn install_dirs() -> Vec<PathBuf> {
    let local_bin = home().join(".local").join("bin");
    if !cfg!(windows) {
        return vec![local_bin];
    }
    let app_data = var("LOCALAPPDATA").unwrap_or_else(|| home().join("AppData").join("Local"));
    vec![app_data.join("agy").join("bin"), local_bin]
}

/// A runtime program: the one the environment names, else the one on `PATH`, else the one where its installer puts
/// it, which a service's `PATH` may leave out. Nothing is bundled.
pub fn find_runtime(name: &str, named: Option<PathBuf>, path: Option<&std::ffi::OsStr>, install_dirs: &[PathBuf]) -> Option<PathBuf> {
    if let Some(named) = named {
        // A name that does not exist is a mistake to report, not a reason to look elsewhere.
        return executable(&named).then_some(named);
    }
    on_path(name, path).or_else(|| {
        let dirs = std::env::join_paths(install_dirs).ok()?;
        on_path(name, Some(&dirs))
    })
}

/// The web app's files, when an installation has them beside the program.
pub fn find_web(program_dir: Option<&Path>) -> Option<PathBuf> {
    program_dir.into_iter().flat_map(|dir| bundled(dir, "web")).find(|dir| dir.join("index.html").is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use neo_testkit::TempDir;

    #[cfg(unix)]
    fn program(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn finds_a_runtime_where_it_is_named_then_on_the_path_then_where_it_installs_itself() {
        let dir = TempDir::new("paths");
        let (local, usr) = (dir.join("home/.local/bin"), dir.join("usr/bin"));
        let installed = [local.clone()];
        program(&local.join("agy"));
        program(&usr.join("tool"));
        let path = std::env::join_paths([dir.join("empty"), usr.clone()]).unwrap();
        // The path wins over the installer's folder, which is found when the path leaves it out.
        assert_eq!(find_runtime("tool", None, Some(&path), &installed), Some(usr.join("tool")));
        assert_eq!(find_runtime("agy", None, Some(&path), &installed), Some(local.join("agy")));
        assert_eq!(find_runtime("agy", None, None, &installed), Some(local.join("agy")));
        // The environment's choice wins over all, and a wrong one is not papered over.
        program(&dir.join("custom/agy"));
        assert_eq!(find_runtime("agy", Some(dir.join("custom/agy")), Some(&path), &installed), Some(dir.join("custom/agy")));
        assert_eq!(find_runtime("agy", Some(dir.join("custom/missing")), Some(&path), &installed), None);
        // A file that cannot be run is no program.
        std::fs::write(usr.join("plain"), "text").unwrap();
        assert_eq!(find_runtime("plain", None, Some(&path), &[]), None);
        assert_eq!(find_runtime("missing", None, Some(&path), &installed), None);
        assert_eq!(find_runtime("agy", None, None, &[]), None);
    }

    #[test]
    fn finds_the_web_files_of_an_installation() {
        let dir = TempDir::new("bundle");
        let bin = dir.join("Neo.app/Contents/Helpers");
        std::fs::create_dir_all(&bin).unwrap();
        let resources = dir.join("Neo.app/Contents/Resources");
        assert_eq!(find_web(Some(&bin)), None);
        std::fs::create_dir_all(resources.join("web")).unwrap();
        assert_eq!(find_web(Some(&bin)), None, "a folder without the page is no web app");
        std::fs::write(resources.join("web/index.html"), "<!doctype html>").unwrap();
        assert_eq!(find_web(Some(&bin)), Some(resources.join("web")));
    }

    #[test]
    fn names_the_per_user_directories() {
        let data = default_data_dir();
        assert!(data.is_absolute() && data.ends_with("neo-agent"), "{}", data.display());
        assert!(runtime_dir().is_absolute());
    }
}
