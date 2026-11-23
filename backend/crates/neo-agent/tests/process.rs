//! The program itself, started as a process: its commands, the server and the desktop backend over real sockets, the
//! single instance, a clean stop, and its refusal as a blocked command. No kernel is installed for these runs.

use neo_app::http::{send, Request};
use neo_testkit::TempDir;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const PROGRAM: &str = env!("CARGO_BIN_EXE_neo-agent");
const TOKEN: &str = "0123456789abcdef-token";

/// The program with nothing of this machine leaking in: no runtime, its own lock place.
fn program(dir: &TempDir) -> Command {
    let mut command = Command::new(PROGRAM);
    command
        .env("NEO_RUNTIME_DIR", dir.join("run"))
        .env("NEO_AGY_BIN", dir.join("no-agy"))
        .env_remove("NEO_TOKEN")
        .env_remove("NEO_DATA_DIR")
        .env_remove("NEO_ALLOW_MULTIPLE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn run(command: &mut Command) -> Output {
    command.output().expect("the program runs")
}

struct Running {
    child: Child,
    port: u16,
}

impl Running {
    /// Start a long-running command and read the line that says where it listens.
    fn start(mut command: Command, token: Option<&str>) -> Running {
        if token.is_some() {
            command.stdin(Stdio::piped());
        }
        let mut child = command.spawn().expect("the program starts");
        if let Some(token) = token {
            writeln!(child.stdin.as_mut().unwrap(), "{token}").unwrap();
        }
        let mut line = String::new();
        BufReader::new(child.stdout.as_mut().unwrap()).read_line(&mut line).unwrap();
        let Ok(said) = serde_json::from_str::<Value>(&line) else {
            let mut errors = String::new();
            let _ = child.stderr.take().unwrap().read_to_string(&mut errors);
            panic!("the program did not say where it listens: {line:?}; {errors}");
        };
        assert_eq!((said["pid"].as_u64(), said["version"].as_str()), (Some(child.id() as u64), Some(env!("CARGO_PKG_VERSION"))));
        Running { port: said["port"].as_u64().unwrap() as u16, child }
    }
    fn get(&self, path: &str, token: Option<&str>) -> (u16, Value) {
        call(self.port, "GET", path, None, token)
    }
    /// Wait for the program to end by itself.
    fn ended(mut self) -> (Option<i32>, String) {
        let began = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                let mut errors = String::new();
                let _ = self.child.stderr.take().unwrap().read_to_string(&mut errors);
                return (status.code(), errors);
            }
            assert!(began.elapsed() < Duration::from_secs(20), "the program did not end");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    #[cfg(unix)]
    fn terminate(self) -> (Option<i32>, String) {
        assert!(Command::new("kill").args(["-TERM", &self.child.id().to_string()]).status().unwrap().success());
        self.ended()
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn call(port: u16, method: &'static str, path: &str, body: Option<Value>, token: Option<&str>) -> (u16, Value) {
    let mut headers = Vec::new();
    if body.is_some() {
        headers.push(("content-type".to_string(), "application/json".to_string()));
    }
    if let Some(token) = token {
        headers.push(("authorization".to_string(), format!("Bearer {token}")));
    }
    let request = Request {
        method,
        url: format!("http://127.0.0.1:{port}{path}"),
        headers,
        body: body.map(|body| body.to_string().into_bytes()),
        timeout: Duration::from_secs(10),
        want: Vec::new(),
    };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let response = runtime.block_on(send(request)).expect("the server answers");
    (response.status, serde_json::from_slice(&response.body).unwrap_or(Value::Null))
}

fn serve(dir: &TempDir, data: &str, more: &[&str]) -> Command {
    let mut command = program(dir);
    command.args(["serve", "--port", "0", "--data-dir"]).arg(dir.join(data)).args(more);
    command
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

#[test]
fn answers_its_plain_commands() {
    let dir = TempDir::new("agent-cli");
    let version = run(program(&dir).arg("version"));
    assert_eq!((version.status.code(), text(&version.stdout)), (Some(0), format!("neo-agent {}\n", env!("CARGO_PKG_VERSION"))));
    let help = run(&mut program(&dir));
    assert!(help.status.success() && text(&help.stdout).contains("neo-agent serve [options]") && text(&help.stdout).contains("desktop-sidecar"));
    let unknown = run(program(&dir).arg("launch"));
    assert_eq!((unknown.status.code(), text(&unknown.stderr)), (Some(2), "Unknown command launch; see neo-agent help\n".to_string()));
    let option = run(program(&dir).args(["serve", "--port", "many"]));
    assert_eq!((option.status.code(), text(&option.stderr).contains("--port takes a number")), (Some(2), true));
    // Offering the API to other machines takes a token, and a web folder must hold the web app.
    let open = run(serve(&dir, "wide", &["--host", "0.0.0.0"]).env("NEO_ALLOW_MULTIPLE", "1"));
    assert_eq!((open.status.code(), text(&open.stderr).contains("Listening on 0.0.0.0 needs an access token")), (Some(1), true));
    let web = run(serve(&dir, "web", &["--web-dir"]).arg(dir.join("no-web")));
    assert_eq!((web.status.code(), text(&web.stderr).contains("holds no web app")), (Some(2), true));
    let sidecar = run(program(&dir).args(["desktop-sidecar", "--port", "0"]));
    assert_eq!((sidecar.status.code(), text(&sidecar.stderr)), (Some(2), "desktop-sidecar takes its access token with --token-stdin\n".to_string()));
    let short = program(&dir).args(["desktop-sidecar", "--token-stdin"]).stdin(Stdio::piped()).spawn().unwrap();
    short.stdin.as_ref().unwrap().write_all(b"short\n").unwrap();
    let short = short.wait_with_output().unwrap();
    assert_eq!((short.status.code(), text(&short.stderr).contains("at least 16 characters")), (Some(2), true));
    // Without Antigravity the check of the machine fails and says what to do; with it, it passes.
    let doctor = run(program(&dir).args(["doctor", "--data-dir"]).arg(dir.join("d")));
    let report = text(&doctor.stdout);
    assert_eq!(doctor.status.code(), Some(1), "{report}");
    assert!(
        report.contains("Antigravity CLI:  missing")
            && report.contains("Antigravity CLI (agy) cannot run")
            && report.contains(&format!("Data directory:   {}", dir.join("d").display())),
        "{report}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let agy = dir.join("agy");
        std::fs::write(&agy, "#!/bin/sh\necho '9.9.9 (Antigravity CLI)'\n").unwrap();
        std::fs::set_permissions(&agy, std::fs::Permissions::from_mode(0o755)).unwrap();
        let doctor = run(program(&dir).args(["doctor", "--data-dir"]).arg(dir.join("d")).env("NEO_AGY_BIN", &agy));
        let report = text(&doctor.stdout);
        assert_eq!(doctor.status.code(), Some(0), "{report}");
        assert!(report.contains(&format!("Antigravity CLI:  ok — {} (9.9.9 (Antigravity CLI))", agy.display())), "{report}");
    }
}

#[test]
fn serves_the_api_as_one_instance_and_stops_cleanly() {
    let dir = TempDir::new("agent-serve");
    std::fs::write(dir.join("settings.json"), json!({"executor": {"maxWorkers": 7}}).to_string()).unwrap();
    std::fs::create_dir_all(dir.join("web")).unwrap();
    std::fs::write(dir.join("web/index.html"), "<!doctype html><title>Neo</title>").unwrap();
    let init = dir.join("settings.json");
    let web = dir.join("web");
    let first = Running::start(serve(&dir, "data", &["--init-settings", init.to_str().unwrap(), "--web-dir", web.to_str().unwrap()]), None);
    // It runs without a kernel, says so, and takes settings; the page is served beside the API.
    let (status, health) = first.get("/api/health", None);
    assert_eq!((status, health["ready"].as_bool(), health["components"]["kernel"]["state"].as_str()), (200, Some(true), Some("error")));
    assert!(health["components"]["kernel"]["detail"].as_str().unwrap().contains("is not installed"));
    assert_eq!(first.get("/api/settings/general", None).1["executor"]["maxWorkers"], 7);
    assert_eq!(first.get("/api/messages", None), (200, json!({"messages": []})));
    assert_eq!(call(first.port, "PUT", "/api/settings/general", Some(json!({"executor": {"maxWorkers": 4}})), None).0, 200);
    assert_eq!(first.get("/", None).0, 200);
    let (status, refused) = call(first.port, "POST", "/api/chat", Some(json!({"text": "hello"})), None);
    assert!(status == 400 && refused["error"].as_str().unwrap().contains("is not installed"), "{refused}");

    // A second instance of this user is refused and told where the first one is, whatever data directory it names.
    let second = run(&mut serve(&dir, "other", &[]));
    assert_eq!(second.status.code(), Some(3));
    assert!(text(&second.stderr).contains(&format!("Neo is already running on port {}", first.port)), "{}", text(&second.stderr));
    assert!(second.stdout.is_empty());
    // Allowed several, another data directory runs beside it, and the same one does not.
    let same = run(&mut serve(&dir, "data", &["--allow-multiple"]));
    assert_eq!(same.status.code(), Some(3));
    let beside = Running::start(serve(&dir, "other", &["--allow-multiple"]), None);
    assert_ne!(beside.port, first.port);
    assert_eq!(beside.get("/api/settings/general", None).1["executor"]["maxWorkers"], 3);
    drop(beside);

    #[cfg(unix)]
    {
        // Asked to end, it ends in order and frees its place.
        let (status, log) = first.terminate();
        assert_eq!(status, Some(0), "{log}");
        assert!(log.contains("Stopping: terminated"), "{log}");
        assert!(!dir.join("run/instance.json").exists());
        // What was stored is there again, and the settings file is only where a new installation starts from.
        std::fs::write(&init, json!({"executor": {"maxWorkers": 9}}).to_string()).unwrap();
        let again = Running::start(serve(&dir, "data", &["--init-settings", init.to_str().unwrap()]), None);
        assert_eq!(again.get("/api/settings/general", None).1["executor"]["maxWorkers"], 4);
        // Without the web folder named, none is found beside a development build: only the API answers.
        assert_eq!(again.get("/", None).0, 404);
    }
}

#[test]
fn backs_the_desktop_app_for_as_long_as_the_app_lives() {
    let dir = TempDir::new("agent-sidecar");
    let mut command = program(&dir);
    command.args(["desktop-sidecar", "--port", "0", "--token-stdin", "--data-dir"]).arg(dir.join("data"));
    let mut sidecar = Running::start(command, Some(TOKEN));
    // Only whoever holds the token the app made may call.
    assert_eq!(sidecar.get("/api/messages", Some(TOKEN)), (200, json!({"messages": []})));
    assert_eq!(sidecar.get("/api/messages", None).0, 401);
    assert_eq!(sidecar.get("/api/messages", Some("0123456789abcdef-other")).0, 401);
    let (status, hint) = sidecar.get("/api/health", None);
    assert_eq!((status, hint["authRequired"].as_bool()), (401, Some(true)));
    assert_eq!(sidecar.get("/api/health", Some(TOKEN)).1["ready"], true);
    // The app going away, however it does, ends its backend.
    drop(sidecar.child.stdin.take());
    let (status, log) = sidecar.ended();
    assert_eq!(status, Some(0), "{log}");
    assert!(log.contains("Stopping: the desktop app closed"), "{log}");
}

#[test]
fn refuses_to_run_as_a_blocked_command() {
    let dir = TempDir::new("agent-blocked");
    let folder = dir.join("worker-bin");
    std::fs::create_dir_all(&folder).unwrap();
    let name = if cfg!(windows) { "docker.exe" } else { "docker" };
    std::fs::copy(PROGRAM, folder.join(name)).unwrap();
    let refused = Command::new(folder.join(name)).args(["run", "--rm", "alpine"]).output().unwrap();
    assert_eq!(refused.status.code(), Some(126));
    assert_eq!(text(&refused.stderr), "docker is blocked in this installation by the Neo settings; do the work without it.\n");
    assert!(refused.stdout.is_empty());
    // Under its own name elsewhere it is itself.
    let elsewhere = dir.join(if cfg!(windows) { "renamed.exe" } else { "renamed" });
    std::fs::copy(PROGRAM, &elsewhere).unwrap();
    assert!(text(&Command::new(&elsewhere).arg("version").output().unwrap().stdout).starts_with("neo-agent "));
    assert!(Path::new(PROGRAM).is_file());
}
