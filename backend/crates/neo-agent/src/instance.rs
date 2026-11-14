//! One instance per user. A running instance holds an exclusive lock on a file in the per-user runtime directory, and
//! always one in its data directory. The system releases a lock when its process ends, however it ends, so nothing
//! stale is left behind to judge.

use serde_json::{json, Value};
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};

/// The exit status of a second instance.
pub const ALREADY_RUNNING: i32 = 3;

/// Why an instance may not start.
#[derive(Debug, PartialEq)]
pub enum Refused {
    /// Another instance runs; what it published about itself, when it has.
    Running(Option<Value>),
    /// The lock could not be taken for another reason.
    Failed(String),
}

/// The locks of the running instance; they are released when this is dropped or the process ends.
#[derive(Debug)]
pub struct Instance {
    _locks: Vec<File>,
    info: PathBuf,
}

fn lock(dir: &Path) -> Result<File, Refused> {
    let failed = |error: std::io::Error| Refused::Failed(format!("Cannot lock {}: {error}", dir.join("instance.lock").display()));
    std::fs::create_dir_all(dir).map_err(failed)?;
    let file = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("instance.lock")).map_err(failed)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => {
            Err(Refused::Running(std::fs::read_to_string(dir.join("instance.json")).ok().and_then(|text| serde_json::from_str(&text).ok())))
        }
        Err(TryLockError::Error(error)) => Err(failed(error)),
    }
}

impl Instance {
    /// Become the running instance: of this user, unless several are allowed, and of this data directory always.
    pub fn acquire(per_user: Option<&Path>, data_dir: &Path) -> Result<Instance, Refused> {
        let mut locks = Vec::new();
        if let Some(dir) = per_user {
            locks.push(lock(dir)?);
        }
        locks.push(lock(data_dir)?);
        Ok(Instance { _locks: locks, info: per_user.unwrap_or(data_dir).join("instance.json") })
    }

    /// Say where this instance listens, for a second one to tell its user.
    pub fn publish(&self, port: u16, data_dir: &Path) {
        let info = json!({"pid": std::process::id(), "port": port, "dataDir": data_dir.display().to_string(), "version": env!("CARGO_PKG_VERSION")});
        let _ = std::fs::write(&self.info, info.to_string());
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neo_testkit::TempDir;

    #[test]
    fn lets_one_instance_run_per_user_and_per_data_directory() {
        let dir = TempDir::new("instance");
        let (run, first, second) = (dir.join("run"), dir.join("data-1"), dir.join("data-2"));
        let running = Instance::acquire(Some(&run), &first).expect("the first instance starts");
        // A second one is refused, whatever its data directory; it learns where the first one is once that is published.
        assert_eq!(Instance::acquire(Some(&run), &second).unwrap_err(), Refused::Running(None));
        running.publish(3082, &first);
        let Refused::Running(Some(info)) = Instance::acquire(Some(&run), &second).unwrap_err() else { panic!("the instance is known") };
        assert_eq!((info["port"].as_u64(), info["pid"].as_u64(), info["dataDir"].as_str()), (Some(3082), Some(std::process::id() as u64), first.to_str()));
        // Allowed several, an instance still owns its data directory alone.
        assert_eq!(Instance::acquire(None, &first).unwrap_err(), Refused::Running(None));
        let other = Instance::acquire(None, &second).expect("another data directory is free");
        assert_eq!(Instance::acquire(None, &second).unwrap_err(), Refused::Running(None));
        // Ending an instance frees its place and removes what it published.
        drop(running);
        assert!(!run.join("instance.json").exists());
        let again = Instance::acquire(Some(&run), &first).expect("the place is free again");
        drop((again, other));
        // A place that cannot be used says so.
        std::fs::write(dir.join("file"), "x").unwrap();
        assert!(matches!(Instance::acquire(Some(&dir.join("file")), &first), Err(Refused::Failed(why)) if why.starts_with("Cannot lock ")));
    }
}
