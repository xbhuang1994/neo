//! Where things are on this machine: the per-user data directory, the place of the instance lock, the bundled
//! runtimes, the Oh My Pi extension and the web app's files.

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

/// A runtime program: the one the environment names, else the bundled one, else the one on `PATH`.
pub fn find_runtime(name: &str, named: Option<PathBuf>, program_dir: Option<&Path>, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    if let Some(named) = named {
        // A name that does not exist is a mistake to report, not a reason to look elsewhere.
        return executable(&named).then_some(named);
    }
    let bundled = program_dir
        .into_iter()
        .flat_map(|dir| bundled(dir, "runtimes"))
        .flat_map(|dir| names(name).into_iter().flat_map(move |file| [dir.join(&file), dir.join(name).join(&file)]));
    bundled.into_iter().find(|candidate| executable(candidate)).or_else(|| on_path(name, path))
}

/// The Oh My Pi extension file: the one `NEO_SHIM` names, else the bundled one, else the one of a source checkout.
pub fn find_shim(named: Option<PathBuf>, program_dir: Option<&Path>) -> PathBuf {
    const FILE: &str = "neo-omp-shim.ts";
    if let Some(named) = named {
        return named;
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../shim").join(FILE);
    let found = program_dir.into_iter().flat_map(|dir| bundled(dir, "shim")).map(|dir| dir.join(FILE)).chain([source]).find(|file| file.is_file());
    // A missing file is reported by name when Oh My Pi is chosen.
    found.unwrap_or_else(|| program_dir.unwrap_or(Path::new(".")).join("shim").join(FILE))
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
    fn finds_a_runtime_where_it_is_named_then_bundled_then_on_the_path() {
        let dir = TempDir::new("paths");
        let (bin, usr) = (dir.join("app/bin"), dir.join("usr/bin"));
        std::fs::create_dir_all(&bin).unwrap();
        program(&usr.join("claude"));
        program(&usr.join("omp"));
        let path = std::env::join_paths([dir.join("empty"), usr.clone()]).unwrap();
        // Only on the path.
        assert_eq!(find_runtime("claude", None, Some(&bin), Some(&path)), Some(usr.join("claude")));
        // Bundled one level up wins over the path; beside the program wins over that; a folder per runtime is found too.
        program(&dir.join("app/runtimes/claude"));
        assert_eq!(find_runtime("claude", None, Some(&bin), Some(&path)), Some(dir.join("app/runtimes/claude")));
        program(&bin.join("runtimes/claude"));
        assert_eq!(find_runtime("claude", None, Some(&bin), Some(&path)), Some(bin.join("runtimes/claude")));
        program(&dir.join("app/Resources/runtimes/omp/omp"));
        assert_eq!(find_runtime("omp", None, Some(&bin), Some(&path)), Some(dir.join("app/Resources/runtimes/omp/omp")));
        // The environment's choice wins over all, and a wrong one is not papered over.
        program(&dir.join("custom/claude"));
        assert_eq!(find_runtime("claude", Some(dir.join("custom/claude")), Some(&bin), Some(&path)), Some(dir.join("custom/claude")));
        assert_eq!(find_runtime("claude", Some(dir.join("custom/missing")), Some(&bin), Some(&path)), None);
        // A file that cannot be run is no program.
        std::fs::write(usr.join("plain"), "text").unwrap();
        assert_eq!(find_runtime("plain", None, None, Some(&path)), None);
        assert_eq!(find_runtime("nothing", None, Some(&bin), Some(&path)), None);
        assert_eq!(find_runtime("claude", None, None, None), None);
    }

    #[test]
    fn finds_the_extension_and_the_web_files_of_an_installation() {
        let dir = TempDir::new("bundle");
        let bin = dir.join("Neo Agent.app/Contents/Helpers");
        std::fs::create_dir_all(&bin).unwrap();
        // A source checkout has the extension; an installation's own comes first.
        assert!(find_shim(None, Some(&bin)).ends_with("shim/neo-omp-shim.ts"));
        assert!(find_shim(None, Some(&bin)).is_file(), "the repository's shim is found from a development build");
        let resources = dir.join("Neo Agent.app/Contents/Resources");
        std::fs::create_dir_all(resources.join("shim")).unwrap();
        std::fs::write(resources.join("shim/neo-omp-shim.ts"), "// shim").unwrap();
        assert_eq!(find_shim(None, Some(&bin)), resources.join("shim/neo-omp-shim.ts"));
        assert_eq!(find_shim(Some("/elsewhere/shim.ts".into()), Some(&bin)), PathBuf::from("/elsewhere/shim.ts"));
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
