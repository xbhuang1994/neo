//! Neo's program: a server (`serve`), the desktop app's backend (`desktop-sidecar`), a check of the machine
//! (`doctor`), and — started under another name from the folder of blocked commands — a refusal to run that command.
#![deny(missing_docs)]

mod cli;
mod instance;
mod paths;

use cli::{Command, Common, ConfigFile};
use instance::{Instance, Refused, ALREADY_RUNNING};
use neo_app::app::{App, Machine, Timings};
use neo_app::blocked;
use neo_app::kernels::{self, Kernels, RealKernels};
use neo_app::settings::{Kernel, Settings};
use neo_http::Access;
use serde_json::json;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const DEFAULT_PORT: u16 = 3082;

fn log(message: &str) {
    eprintln!("[neo-agent] {message}");
}

/// Everything a run needs, resolved from the command line, the environment and the configuration file.
struct Plan {
    data_dir: PathBuf,
    agent_dir: PathBuf,
    allow_multiple: bool,
    host: String,
    port: u16,
    token: Option<String>,
    web_dir: Option<PathBuf>,
    init_settings: Option<PathBuf>,
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from)
}

fn absolute(path: PathBuf) -> PathBuf {
    std::path::absolute(&path).unwrap_or(path)
}

fn common(common: &Common, config: &ConfigFile) -> (PathBuf, PathBuf, bool) {
    let data_dir =
        absolute(common.data_dir.clone().or_else(|| env_path("NEO_DATA_DIR")).or_else(|| config.data_dir.clone()).unwrap_or_else(paths::default_data_dir));
    let agent_dir = absolute(
        common.agent_dir.clone().or_else(|| config.agent_dir.clone()).or_else(|| env_path("PI_CODING_AGENT_DIR")).unwrap_or_else(paths::omp_agent_dir),
    );
    let allow_multiple = common.allow_multiple || std::env::var("NEO_ALLOW_MULTIPLE").is_ok_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
    (data_dir, agent_dir, allow_multiple)
}

fn kernels(plan: &Plan) -> RealKernels {
    let program_dir = paths::program_dir();
    // Each program is looked for whenever it is needed, so one installed while this runs is found.
    let find = Arc::new(|kernel: Kernel| {
        let variable = match kernel {
            Kernel::Claude => "NEO_CLAUDE_BIN",
            Kernel::Omp => "NEO_OMP_BIN",
            Kernel::Antigravity => "NEO_AGY_BIN",
            Kernel::Hermes => "NEO_HERMES_BIN",
        };
        let name = kernels::program_name(kernel);
        paths::find_runtime(name, env_path(variable), std::env::var_os("PATH").as_deref(), &paths::install_dirs(name))
    });
    let shim = paths::find_shim(env_path("NEO_SHIM"), program_dir.as_deref());
    // Every Session meets the blocked commands first on its path.
    let env = [("PATH".to_string(), blocked::path_with(&plan.data_dir).to_string_lossy().to_string())].into_iter().collect();
    // Antigravity's hooks come back to this program.
    let hook_relay = std::env::current_exe().map(|exe| vec![exe.display().to_string(), "agy-hook".into()]).unwrap_or_default();
    RealKernels { state_dir: plan.data_dir.clone(), agent_dir: plan.agent_dir.clone(), find, installing: Default::default(), shim, env, hook_relay, providers: Default::default() }
}

/// Waits until the process is asked to end: by a signal, or by `ended` (the desktop app going away).
async fn asked_to_stop(ended: Option<tokio::sync::oneshot::Receiver<()>>) -> &'static str {
    let parent = async {
        match ended {
            Some(ended) => {
                let _ = ended.await;
            }
            None => std::future::pending::<()>().await,
        }
    };
    #[cfg(unix)]
    {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signals can be listened for");
        let mut hangup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup()).expect("signals can be listened for");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => "interrupted",
            _ = terminate.recv() => "terminated",
            _ = hangup.recv() => "hung up",
            _ = parent => "the desktop app closed",
        }
    }
    #[cfg(not(unix))]
    {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => "interrupted",
            _ = parent => "the desktop app closed",
        }
    }
}

async fn run(plan: Plan, sidecar: bool, ended: Option<tokio::sync::oneshot::Receiver<()>>) -> Result<(), (i32, String)> {
    let fail = |message: String| (1, message);
    std::fs::create_dir_all(&plan.data_dir).map_err(|error| fail(format!("Cannot create {}: {error}", plan.data_dir.display())))?;
    let per_user = (!plan.allow_multiple).then(paths::runtime_dir);
    let instance = Instance::acquire(per_user.as_deref(), &plan.data_dir).map_err(|refused| match refused {
        Refused::Running(info) => {
            let place = info.as_ref().and_then(|info| info["port"].as_u64()).map(|port| format!(" on port {port}")).unwrap_or_default();
            (
                ALREADY_RUNNING,
                format!("Neo is already running{place}. Only one instance runs per user; pass --allow-multiple with another --data-dir to run a second one."),
            )
        }
        Refused::Failed(why) => fail(why),
    })?;
    let kernels = Arc::new(kernels(&plan));
    for kernel in [Kernel::Claude, Kernel::Omp, Kernel::Antigravity, Kernel::Hermes] {
        let name = kernels::display_name(kernel);
        match (kernels.program(kernel), kernels.unavailable(kernel)) {
            (Some(program), None) => log(&format!("{name}: {}", program.display())),
            (_, problem) => log(&format!("{name}: {}", problem.unwrap_or_default())),
        }
    }
    let machine = Machine { state_dir: plan.data_dir.clone(), wechat: Default::default(), program: std::env::current_exe().ok() };
    let app = App::open(machine, kernels, Timings::default()).map_err(fail)?;
    if let Some(file) = plan.init_settings.as_ref().filter(|_| app.store.get::<u64>("settings-revision").is_none()) {
        let text = std::fs::read_to_string(file).map_err(|error| fail(format!("Cannot read {}: {error}", file.display())))?;
        let value = serde_json::from_str(&text).map_err(|error| fail(format!("{}: {error}", file.display())))?;
        let settings = Settings::parse(value).map_err(|error| fail(format!("{}: {error}", file.display())))?;
        app.save_settings(settings, "internal", "init").map_err(fail)?;
        log(&format!("Started from the settings in {}", file.display()));
    }
    app.start().await.map_err(fail)?;
    let access = Access { token: plan.token.clone(), web_dir: plan.web_dir.clone() };
    let server = match neo_http::serve(app.clone(), &plan.host, plan.port, access).await {
        Ok(server) => server,
        Err(error) => {
            app.stop().await;
            return Err(fail(error));
        }
    };
    let port = server.addr.port();
    instance.publish(port, &plan.data_dir);
    // One line for whoever started this program; everything else goes to standard error.
    let shown = if neo_http::is_loopback(&plan.host) { "127.0.0.1".to_string() } else { plan.host.clone() };
    println!("{}", json!({"port": port, "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION"), "url": format!("http://{shown}:{port}/")}));
    let _ = std::io::stdout().flush();
    log(&format!("Listening on http://{}:{port}/ — data in {}", plan.host, plan.data_dir.display()));
    if !sidecar {
        match &plan.web_dir {
            Some(web) => log(&format!("Serving the web app from {}", web.display())),
            None => log("The web app's files were not found; only the API is served (see --web-dir)"),
        }
    }
    let why = asked_to_stop(ended).await;
    log(&format!("Stopping: {why}"));
    server.shutdown().await;
    app.stop().await;
    drop(instance);
    Ok(())
}

fn version_of(program: &Path) -> String {
    let output = std::process::Command::new(program).arg("--version").stdin(std::process::Stdio::null()).output();
    match output {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout).lines().next().unwrap_or("").trim().to_string(),
        Ok(output) => format!("exited with {}", output.status),
        Err(error) => format!("cannot run: {error}"),
    }
}

/// Print what this machine provides; succeeds when at least one kernel can run.
fn doctor(options: &Common) -> i32 {
    let (data_dir, agent_dir, _) = common(options, &ConfigFile::default());
    let plan = Plan { data_dir, agent_dir, allow_multiple: true, host: String::new(), port: 0, token: None, web_dir: None, init_settings: None };
    let kernels = kernels(&plan);
    let program_dir = paths::program_dir();
    println!("Neo {}", env!("CARGO_PKG_VERSION"));
    println!("Data directory:   {}", plan.data_dir.display());
    println!("Agent directory:  {}", plan.agent_dir.display());
    println!("Instance lock:    {}", paths::runtime_dir().display());
    let mut usable = 0;
    for kernel in [Kernel::Claude, Kernel::Omp, Kernel::Antigravity, Kernel::Hermes] {
        let name = format!("{}:", kernels::display_name(kernel));
        match (kernels.program(kernel), kernels.unavailable(kernel)) {
            (Some(program), None) => {
                usable += 1;
                println!("{name:<18}ok — {} ({})", program.display(), version_of(&program));
            }
            (_, problem) => println!("{name:<18}missing — {}", problem.unwrap_or_default()),
        }
    }
    println!("OMP extension:    {}{}", kernels.shim.display(), if kernels.shim.is_file() { "" } else { " (missing)" });
    match paths::on_path("git", std::env::var_os("PATH").as_deref()) {
        Some(git) => println!("git:              ok — {} ({})", git.display(), version_of(&git)),
        None => println!("git:              missing — workers that use git need it installed"),
    }
    match paths::find_web(program_dir.as_deref()) {
        Some(web) => println!("Web app:          {}", web.display()),
        None => println!("Web app:          not found beside the program (serve --web-dir <dir> names it)"),
    }
    if usable == 0 {
        println!("No kernel can run: install Claude Code, Oh My Pi, the Antigravity CLI or Hermes Agent (the app's settings can install them), or set NEO_CLAUDE_BIN / NEO_OMP_BIN / NEO_AGY_BIN / NEO_HERMES_BIN.");
        return 1;
    }
    0
}

fn serve_plan(options: cli::Serve) -> Result<Plan, String> {
    let config = match &options.config {
        Some(file) => ConfigFile::read(file)?,
        None => ConfigFile::default(),
    };
    let (data_dir, agent_dir, allow_multiple) = common(&options.common, &config);
    let token =
        options.token.or_else(|| std::env::var("NEO_TOKEN").ok()).or(config.token).map(|token| token.trim().to_string()).filter(|token| !token.is_empty());
    let web_dir = options.web_dir.or(config.web_dir).map(absolute).or_else(|| paths::find_web(paths::program_dir().as_deref()));
    if let Some(web) = web_dir.as_ref().filter(|web| !web.join("index.html").is_file()) {
        return Err(format!("{} holds no web app (index.html is missing)", web.display()));
    }
    Ok(Plan {
        data_dir,
        agent_dir,
        allow_multiple,
        host: options.host.or(config.host).unwrap_or_else(|| "127.0.0.1".into()),
        port: options.port.or(config.port).unwrap_or(DEFAULT_PORT),
        token,
        web_dir,
        init_settings: options.init_settings,
    })
}

/// The desktop app's backend: on loopback only, behind a token the app gave on standard input, for as long as the
/// app keeps standard input open.
fn sidecar_plan(options: cli::Sidecar) -> Result<(Plan, tokio::sync::oneshot::Receiver<()>), String> {
    if !options.token_stdin {
        return Err("desktop-sidecar takes its access token with --token-stdin".into());
    }
    let mut token = String::new();
    std::io::stdin().lock().read_line(&mut token).map_err(|error| format!("Cannot read the access token: {error}"))?;
    let token = token.trim().to_string();
    if token.len() < 16 {
        return Err("The access token on standard input must have at least 16 characters".into());
    }
    let (ended, closed) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        // The app holds this pipe open while it lives; its end, however the app ended, ends this program too.
        let mut rest = String::new();
        while std::io::stdin().lock().read_line(&mut rest).is_ok_and(|read| read > 0) {
            rest.clear();
        }
        let _ = ended.send(());
    });
    let (data_dir, agent_dir, allow_multiple) = common(&options.common, &ConfigFile::default());
    Ok((
        Plan { data_dir, agent_dir, allow_multiple, host: "127.0.0.1".into(), port: options.port, token: Some(token), web_dir: None, init_settings: None },
        closed,
    ))
}

fn main() {
    let mut args = std::env::args();
    let program = args.next().unwrap_or_default();
    // Started from the folder of blocked commands, this program is the refusal of the command it is named after.
    let stand_in = |path: &Path| path.parent().and_then(Path::file_name).is_some_and(|folder| folder == "worker-bin");
    if stand_in(Path::new(&program)) || std::env::current_exe().is_ok_and(|path| stand_in(&path)) {
        eprintln!("{}", blocked::refusal(&blocked::invoked_as(&program)));
        std::process::exit(blocked::REFUSED_STATUS);
    }
    let args: Vec<String> = args.collect();
    // Antigravity runs this program as a hook's command: the hook goes to the Session's driver, its answer comes back.
    if args.first().is_some_and(|first| first == "agy-hook") {
        let url = args.get(1).map(String::as_str).unwrap_or("");
        match neo_kernel::antigravity::relay_hook(url, &mut std::io::stdin().lock(), &mut std::io::stdout().lock()) {
            Ok(()) => return,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    let command = match cli::parse(&args) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let (plan, sidecar, ended) = match command {
        Command::Help => {
            print!("{}", cli::USAGE);
            return;
        }
        Command::Version => {
            println!("neo-agent {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Command::Doctor(options) => std::process::exit(doctor(&options)),
        Command::Serve(options) => (serve_plan(options), false, None),
        Command::Sidecar(options) => match sidecar_plan(options) {
            Ok((plan, ended)) => (Ok(plan), true, Some(ended)),
            Err(error) => (Err(error), true, None),
        },
    };
    let plan = plan.unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(2);
    });
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("the async runtime starts");
    let result = runtime.block_on(run(plan, sidecar, ended));
    // A long poll under way must not hold the exit back.
    runtime.shutdown_timeout(Duration::from_secs(2));
    if let Err((status, message)) = result {
        eprintln!("{message}");
        std::process::exit(status);
    }
}
