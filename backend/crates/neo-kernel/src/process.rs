//! A runtime child process that speaks newline-delimited JSON over its standard input and output.
//!
//! The child leads its own process group, so closing it also ends whatever it started.

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

/// What to run.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Launch {
    /// The program.
    pub program: PathBuf,
    /// Its arguments.
    pub args: Vec<String>,
    /// Its working directory.
    pub cwd: PathBuf,
    /// Variables to set on top of the host's environment.
    pub env: BTreeMap<String, String>,
    /// Variables of the host's environment the child must not inherit.
    pub env_remove: Vec<String>,
}

/// What a child reports.
#[derive(Debug)]
pub enum Line {
    /// One line of its output, parsed as JSON.
    Json(Value),
    /// It ended, with the tail of what it wrote to standard error when it failed.
    Exited(Option<String>),
}

/// A running child and the pipe to its standard input.
pub struct Proc {
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    pid: u32,
    closing: Arc<AtomicBool>,
    child: Arc<tokio::sync::Mutex<Child>>,
}

/// How much of the child's standard error is kept for an error message.
const STDERR_TAIL: usize = 2000;

impl Proc {
    /// Start the child; its output lines and its exit arrive on the returned channel.
    pub fn spawn(launch: &Launch) -> Result<(Arc<Proc>, mpsc::UnboundedReceiver<Line>), String> {
        let mut command = Command::new(&launch.program);
        command.args(&launch.args).current_dir(&launch.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        for name in &launch.env_remove {
            command.env_remove(name);
        }
        command.envs(&launch.env);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(0x0000_0200 | 0x0800_0000); // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        let mut child = command.spawn().map_err(|error| format!("Cannot start {}: {error}", launch.program.display()))?;
        let pid = child.id().unwrap_or(0);
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("the child's output is piped");
        let stderr = child.stderr.take().expect("the child's errors are piped");
        let (sender, receiver) = mpsc::unbounded_channel();
        let closing = Arc::new(AtomicBool::new(false));
        let child = Arc::new(tokio::sync::Mutex::new(child));
        let tail = Arc::new(Mutex::new(String::new()));
        let errors = tail.clone();
        let reading_errors = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut tail = errors.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                tail.push_str(&line);
                tail.push('\n');
                if tail.len() > STDERR_TAIL * 2 {
                    let cut = tail.char_indices().map(|(index, _)| index).find(|index| tail.len() - index <= STDERR_TAIL).unwrap_or(0);
                    tail.drain(..cut);
                }
            }
        });
        let (waiting, quiet) = (child.clone(), closing.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if sender.send(Line::Json(value)).is_err() {
                        return;
                    }
                }
            }
            let status = waiting.lock().await.wait().await;
            let _ = reading_errors.await;
            let failed = !quiet.load(Ordering::SeqCst) && !status.as_ref().is_ok_and(|status| status.success());
            let error = failed.then(|| {
                let tail = tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).trim().to_string();
                let code = status.ok().and_then(|status| status.code()).map(|code| format!("exit code {code}")).unwrap_or_else(|| "a signal".into());
                if tail.is_empty() {
                    format!("The runtime ended with {code}")
                } else {
                    format!("The runtime ended with {code}: {tail}")
                }
            });
            let _ = sender.send(Line::Exited(error));
        });
        Ok((Arc::new(Proc { stdin: tokio::sync::Mutex::new(stdin), pid, closing, child }), receiver))
    }

    /// The child's process id, which is also its process group.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Write one JSON value as a line to the child.
    pub async fn send(&self, value: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(value).expect("JSON values serialize");
        line.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        let pipe = stdin.as_mut().ok_or("The runtime's input is closed")?;
        pipe.write_all(&line).await.map_err(|error| format!("Cannot write to the runtime: {error}"))?;
        pipe.flush().await.map_err(|error| format!("Cannot write to the runtime: {error}"))
    }

    /// End the child: close its input, give it `grace` to leave, then end its whole process group.
    pub async fn close(&self, grace: Duration) {
        self.closing.store(true, Ordering::SeqCst);
        self.stdin.lock().await.take();
        let mut child = self.child.lock().await;
        if tokio::time::timeout(grace, child.wait()).await.is_err() {
            terminate_group(self.pid);
            let _ = child.start_kill();
            let _ = child.wait().await;
        } else {
            // The runtime left; what it started may still run.
            terminate_group(self.pid);
        }
    }
}

/// End every process of a child's group.
#[cfg(unix)]
fn terminate_group(pid: u32) {
    if pid > 1 {
        // SAFETY: `kill` takes plain integers; a negative pid addresses the process group the child leads.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}
#[cfg(not(unix))]
fn terminate_group(pid: u32) {
    if pid > 0 {
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;

    fn shell(script: &str) -> Launch {
        Launch { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()], cwd: std::env::temp_dir(), ..Default::default() }
    }
    async fn next(lines: &mut mpsc::UnboundedReceiver<Line>) -> Line {
        tokio::time::timeout(Duration::from_secs(10), lines.recv()).await.expect("the child reports in time").expect("the channel is open")
    }

    #[tokio::test]
    async fn exchanges_json_lines_and_reports_a_clean_exit() {
        let (child, mut lines) = Proc::spawn(&shell("echo '{\"type\":\"ready\"}'; echo not json; exec cat")).unwrap();
        assert!(matches!(next(&mut lines).await, Line::Json(value) if value == json!({"type": "ready"})));
        child.send(&json!({"type": "prompt", "message": "héllo\nworld"})).await.unwrap();
        assert!(matches!(next(&mut lines).await, Line::Json(value) if value["message"] == "héllo\nworld"));
        child.close(Duration::from_secs(5)).await;
        assert!(matches!(next(&mut lines).await, Line::Exited(None)));
        assert!(child.send(&json!({})).await.is_err());
    }

    #[tokio::test]
    async fn reports_a_failure_with_the_tail_of_standard_error_and_passes_the_environment() {
        let mut launch = shell("echo \"{\\\"home\\\":\\\"$NEO_TEST\\\",\\\"gone\\\":\\\"$NEO_GONE\\\"}\"; echo 'Error: bad flag' >&2; exit 3");
        launch.env.insert("NEO_TEST".into(), "set".into());
        launch.env_remove.push("NEO_GONE".into());
        std::env::set_var("NEO_GONE", "inherited");
        let (_child, mut lines) = Proc::spawn(&launch).unwrap();
        assert!(matches!(next(&mut lines).await, Line::Json(value) if value == json!({"home": "set", "gone": ""})));
        match next(&mut lines).await {
            Line::Exited(Some(error)) => assert_eq!(error, "The runtime ended with exit code 3: Error: bad flag"),
            other => panic!("expected a failure, got {other:?}"),
        }
        assert!(Proc::spawn(&Launch { program: "/nonexistent/runtime".into(), cwd: std::env::temp_dir(), ..Default::default() })
            .err()
            .unwrap()
            .contains("Cannot start /nonexistent/runtime"));
    }

    #[tokio::test]
    async fn ends_a_child_that_ignores_its_input_closing_together_with_what_it_started() {
        let marker = std::env::temp_dir().join(format!("neo-proc-{}-{}", std::process::id(), crate::types::uuid()));
        let script =
            format!("(sleep 30; touch {0}.late) & echo $! > {0}; echo '{{\"started\":true}}'; trap '' HUP; while true; do sleep 1; done", marker.display());
        let (child, mut lines) = Proc::spawn(&shell(&script)).unwrap();
        assert!(matches!(next(&mut lines).await, Line::Json(_)));
        let grandchild: i32 = std::fs::read_to_string(&marker).unwrap().trim().parse().unwrap();
        child.close(Duration::from_millis(200)).await;
        assert!(matches!(next(&mut lines).await, Line::Exited(None)), "closing is not a failure");
        // The background process the child started is gone too.
        tokio::time::sleep(Duration::from_millis(100)).await;
        // SAFETY: signal 0 only checks whether the process exists.
        let alive = unsafe { libc::kill(grandchild, 0) } == 0;
        assert!(!alive, "the grandchild was ended with its group");
        let _ = std::fs::remove_file(&marker);
    }
}
