//! Test support: temporary directories, a loopback HTTP server and a fixture Antigravity runtime for browser tests.
#![deny(missing_docs)]

pub mod http;

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A directory under the system temp directory, removed when dropped.
pub struct TempDir(PathBuf);

impl TempDir {
    /// A new empty directory whose name starts with `name`.
    pub fn new(name: &str) -> TempDir {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let unique = format!("neo-{name}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst));
        let path = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("the temp directory is writable");
        TempDir(path)
    }
    /// The directory.
    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
    /// A path inside the directory.
    pub fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The first program named `name` on `PATH`.
pub fn find_program(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|candidate| candidate.is_file())
}
