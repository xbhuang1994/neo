//! Blocked commands: a folder of stand-ins, first on the `PATH` of every Session and prepare command, that refuse to
//! run the commands the settings name. On Unix a stand-in is a small shell script; on Windows it is a copy of the
//! application's own program, which refuses when started under another name.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Marks a stand-in as written by this application.
const MARKER: &str = "# neo-agent blocked command";
/// The exit status of a refused command, as shells use for "cannot execute".
pub const REFUSED_STATUS: i32 = 126;

/// The folder of stand-ins within the data directory.
pub fn worker_bin(state_dir: &Path) -> PathBuf {
    state_dir.join("worker-bin")
}

/// What a refused command says.
pub fn refusal(name: &str) -> String {
    format!("{name} is blocked in this installation by the Neo Agent settings; do the work without it.")
}

/// `PATH` with the folder of stand-ins first.
pub fn path_with(state_dir: &Path) -> OsString {
    let own = worker_bin(state_dir);
    let rest: Vec<PathBuf> = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).filter(|entry| *entry != own).collect()).unwrap_or_default();
    std::env::join_paths(std::iter::once(own.clone()).chain(rest)).unwrap_or_else(|_| own.into_os_string())
}

/// The command name a program was started under, without folder and `.exe`: what a stand-in refuses as.
pub fn invoked_as(program: &str) -> String {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    name.strip_suffix(".exe").or_else(|| name.strip_suffix(".EXE")).unwrap_or(name).to_string()
}

fn ours(file: &Path) -> bool {
    if cfg!(windows) {
        return file.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("cmd"));
    }
    std::fs::read_to_string(file).is_ok_and(|text| text.lines().nth(1) == Some(MARKER))
}

fn write_stand_in(dir: &Path, name: &str, program: Option<&Path>) -> std::io::Result<PathBuf> {
    if cfg!(windows) {
        if let Some(program) = program {
            let file = dir.join(format!("{name}.exe"));
            let _ = std::fs::remove_file(&file);
            if std::fs::hard_link(program, &file).is_err() {
                std::fs::copy(program, &file)?;
            }
            return Ok(file);
        }
        let file = dir.join(format!("{name}.cmd"));
        std::fs::write(&file, format!("@echo {} 1>&2\r\n@exit /b {REFUSED_STATUS}\r\n", refusal(name)))?;
        return Ok(file);
    }
    let file = dir.join(name);
    let temporary = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&temporary, format!("#!/bin/sh\n{MARKER}\necho '{}' >&2\nexit {REFUSED_STATUS}\n", refusal(name)))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&temporary, &file)?;
    Ok(file)
}

/// Make the folder hold a stand-in for each of `names` and none of its own for any other; files it did not write stay.
pub fn sync(state_dir: &Path, names: &[String], program: Option<&Path>) -> Result<(), String> {
    let dir = worker_bin(state_dir);
    let failed = |error: std::io::Error| format!("Cannot prepare blocked commands in {}: {error}", dir.display());
    std::fs::create_dir_all(&dir).map_err(failed)?;
    let mut kept: Vec<PathBuf> = Vec::new();
    for name in names {
        kept.push(write_stand_in(&dir, name, program).map_err(failed)?);
    }
    for entry in std::fs::read_dir(&dir).map_err(failed)?.flatten() {
        let file = entry.path();
        if !kept.contains(&file) && file.is_file() && ours(&file) {
            std::fs::remove_file(&file).map_err(failed)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_command_a_program_was_started_as() {
        assert_eq!(invoked_as("/usr/local/bin/neo-agent"), "neo-agent");
        assert_eq!(invoked_as("C:\\data\\worker-bin\\docker.exe"), "docker");
        assert_eq!(invoked_as("kubectl.EXE"), "kubectl");
        assert_eq!(invoked_as("git"), "git");
        assert!(refusal("docker").starts_with("docker is blocked"));
    }

    #[cfg(unix)]
    #[test]
    fn keeps_a_stand_in_for_each_blocked_command_and_refuses_when_run() {
        let state = std::env::temp_dir().join(format!("neo-blocked-{}-{}", std::process::id(), neo_core::time::now_ms()));
        let dir = worker_bin(&state);
        sync(&state, &["docker".into(), "kubectl".into()], None).unwrap();
        std::fs::write(dir.join("mine"), "#!/bin/sh\necho mine\n").unwrap();
        let names = |dir: &Path| {
            let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().to_string()).collect();
            names.sort();
            names
        };
        assert_eq!(names(&dir), vec!["docker", "kubectl", "mine"]);
        let run = std::process::Command::new(dir.join("docker")).arg("ps").output().unwrap();
        assert_eq!(run.status.code(), Some(REFUSED_STATUS));
        assert_eq!(String::from_utf8_lossy(&run.stderr).trim(), refusal("docker"));
        assert!(run.stdout.is_empty());
        // Found first on the path a Session is given.
        let found = std::process::Command::new("sh").args(["-c", "command -v kubectl"]).env("PATH", path_with(&state)).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&found.stdout).trim(), dir.join("kubectl").display().to_string());
        // A changed list removes what is no longer blocked, and never a file of someone else's.
        sync(&state, &["kubectl".into()], None).unwrap();
        assert_eq!(names(&dir), vec!["kubectl", "mine"]);
        sync(&state, &[], None).unwrap();
        assert_eq!(names(&dir), vec!["mine"]);
        let first = std::env::split_paths(&path_with(&state)).next().unwrap();
        assert_eq!(first, dir);
        assert_eq!(std::env::split_paths(&path_with(&state)).filter(|entry| *entry == dir).count(), 1);
        std::fs::remove_dir_all(&state).unwrap();
    }
}
