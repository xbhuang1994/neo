//! The command line and the optional configuration file. Both name only what belongs to the machine: where data is
//! kept and how the API is offered. Everything else is set in the app.

use serde::Deserialize;
use std::path::PathBuf;

/// The usage text.
pub const USAGE: &str = "\
Neo

Usage:
  neo-agent serve [options]            Run as a server: the API, and the web app when its files are found.
  neo-agent desktop-sidecar [options]  Run as the desktop app's backend (started by the app itself).
  neo-agent doctor [options]           Check what this machine provides: runtimes, git, directories.
  neo-agent version                    Print the version.

Options for serve:
  --config <file>         A JSON file with dataDir, agentDir, host, port, token, webDir.
  --data-dir <dir>        Where state is kept. Default: the per-user data directory.
  --agent-dir <dir>       Oh My Pi's agent directory. Default: $PI_CODING_AGENT_DIR, else ~/.omp/agent.
  --host <host>           Address to listen on. Default: 127.0.0.1.
  --port <port>           Port to listen on. Default: 3082; 0 picks a free one.
  --token <token>         Access token (at least 16 characters); also NEO_TOKEN. Required unless listening on loopback.
  --web-dir <dir>         The web app's files. Default: found beside the program.
  --init-settings <file>  Settings (JSON) to start from when none are stored yet.
  --allow-multiple        Allow another instance for a different data directory; also NEO_ALLOW_MULTIPLE=1.

Options for desktop-sidecar:
  --data-dir <dir>, --agent-dir <dir>, --allow-multiple as above.
  --port <port>           Default: 0.
  --token-stdin           Read the access token from the first line of standard input.

Environment:
  NEO_CLAUDE_BIN, NEO_OMP_BIN, NEO_AGY_BIN
                              The runtime programs, when not on PATH or where their installers put them.
  NEO_DATA_DIR                  Same as --data-dir.
";

/// What every command takes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Common {
    /// `--data-dir`.
    pub data_dir: Option<PathBuf>,
    /// `--agent-dir`.
    pub agent_dir: Option<PathBuf>,
    /// `--allow-multiple`.
    pub allow_multiple: bool,
}

/// `serve`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Serve {
    /// Shared options.
    pub common: Common,
    /// `--config`.
    pub config: Option<PathBuf>,
    /// `--host`.
    pub host: Option<String>,
    /// `--port`.
    pub port: Option<u16>,
    /// `--token`.
    pub token: Option<String>,
    /// `--web-dir`.
    pub web_dir: Option<PathBuf>,
    /// `--init-settings`.
    pub init_settings: Option<PathBuf>,
}

/// `desktop-sidecar`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Sidecar {
    /// Shared options.
    pub common: Common,
    /// `--port`.
    pub port: u16,
    /// `--token-stdin`.
    pub token_stdin: bool,
}

/// A parsed command line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// Run the server.
    Serve(Serve),
    /// Run as the desktop app's backend.
    Sidecar(Sidecar),
    /// Check the machine.
    Doctor(Common),
    /// Print the version.
    Version,
    /// Print the usage.
    Help,
}

/// The configuration file of `serve`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigFile {
    /// Where state is kept.
    pub data_dir: Option<PathBuf>,
    /// Oh My Pi's agent directory.
    pub agent_dir: Option<PathBuf>,
    /// Address to listen on.
    pub host: Option<String>,
    /// Port to listen on.
    pub port: Option<u16>,
    /// Access token.
    pub token: Option<String>,
    /// The web app's files.
    pub web_dir: Option<PathBuf>,
}

impl ConfigFile {
    /// Read a configuration file.
    pub fn read(path: &std::path::Path) -> Result<ConfigFile, String> {
        let text = std::fs::read_to_string(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
    }
}

struct Args<'a> {
    rest: std::slice::Iter<'a, String>,
}

impl<'a> Args<'a> {
    /// The next option as (name, value given with `=`).
    fn next(&mut self) -> Option<(&'a str, Option<&'a str>)> {
        let arg = self.rest.next()?;
        Some(match arg.split_once('=').filter(|_| arg.starts_with("--")) {
            Some((name, value)) => (name, Some(value)),
            None => (arg.as_str(), None),
        })
    }
    fn value(&mut self, name: &str, inline: Option<&'a str>) -> Result<&'a str, String> {
        inline.or_else(|| self.rest.next().map(String::as_str)).filter(|value| !value.is_empty()).ok_or_else(|| format!("{name} needs a value"))
    }
}

fn port(text: &str) -> Result<u16, String> {
    text.parse().map_err(|_| format!("--port takes a number from 0 to 65535, not {text:?}"))
}

fn flag(name: &str, inline: Option<&str>) -> Result<bool, String> {
    match inline {
        None => Ok(true),
        Some(_) => Err(format!("{name} takes no value")),
    }
}

/// Take an option every command has; false when `name` is not one.
fn shared<'a>(common: &mut Common, name: &str, inline: Option<&'a str>, args: &mut Args<'a>) -> Result<bool, String> {
    match name {
        "--data-dir" => common.data_dir = Some(PathBuf::from(args.value(name, inline)?)),
        "--agent-dir" => common.agent_dir = Some(PathBuf::from(args.value(name, inline)?)),
        "--allow-multiple" => common.allow_multiple = flag(name, inline)?,
        _ => return Ok(false),
    }
    Ok(true)
}

/// Parse the arguments after the program's name.
pub fn parse(args: &[String]) -> Result<Command, String> {
    let Some(command) = args.first() else { return Ok(Command::Help) };
    let mut args = Args { rest: args[1..].iter() };
    let unknown = |name: &str, command: &str| format!("Unknown option {name} for {command}; see neo-agent help");
    let mut common = Common::default();
    match command.as_str() {
        "serve" => {
            let mut serve = Serve::default();
            while let Some((name, inline)) = args.next() {
                if shared(&mut common, name, inline, &mut args)? {
                    continue;
                }
                match name {
                    "--config" => serve.config = Some(PathBuf::from(args.value(name, inline)?)),
                    "--host" => serve.host = Some(args.value(name, inline)?.to_string()),
                    "--port" => serve.port = Some(port(args.value(name, inline)?)?),
                    "--token" => serve.token = Some(args.value(name, inline)?.to_string()),
                    "--web-dir" => serve.web_dir = Some(PathBuf::from(args.value(name, inline)?)),
                    "--init-settings" => serve.init_settings = Some(PathBuf::from(args.value(name, inline)?)),
                    _ => return Err(unknown(name, "serve")),
                }
            }
            serve.common = common;
            Ok(Command::Serve(serve))
        }
        "desktop-sidecar" => {
            let mut sidecar = Sidecar::default();
            while let Some((name, inline)) = args.next() {
                if shared(&mut common, name, inline, &mut args)? {
                    continue;
                }
                match name {
                    "--port" => sidecar.port = port(args.value(name, inline)?)?,
                    "--token-stdin" => sidecar.token_stdin = flag(name, inline)?,
                    _ => return Err(unknown(name, "desktop-sidecar")),
                }
            }
            sidecar.common = common;
            Ok(Command::Sidecar(sidecar))
        }
        "doctor" => {
            while let Some((name, inline)) = args.next() {
                if !shared(&mut common, name, inline, &mut args)? {
                    return Err(unknown(name, "doctor"));
                }
            }
            Ok(Command::Doctor(common))
        }
        "version" | "--version" | "-V" => Ok(Command::Version),
        "help" | "--help" | "-h" => Ok(Command::Help),
        other => Err(format!("Unknown command {other}; see neo-agent help")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(line: &str) -> Result<Command, String> {
        parse(&line.split_whitespace().map(str::to_string).collect::<Vec<_>>())
    }

    #[test]
    fn parses_each_command_with_its_options_in_either_form() {
        assert_eq!(parsed(""), Ok(Command::Help));
        assert_eq!(
            (parsed("help"), parsed("--help"), parsed("version"), parsed("-V")),
            (Ok(Command::Help), Ok(Command::Help), Ok(Command::Version), Ok(Command::Version))
        );
        assert_eq!(parsed("serve"), Ok(Command::Serve(Serve::default())));
        let Ok(Command::Serve(serve)) = parsed("serve --host 0.0.0.0 --port=8080 --token abcdefghijklmnop --data-dir /srv/neo --web-dir=/srv/web --config c.json --init-settings s.json --allow-multiple --agent-dir /srv/omp") else {
            panic!("serve parses")
        };
        assert_eq!((serve.host.as_deref(), serve.port, serve.token.as_deref()), (Some("0.0.0.0"), Some(8080), Some("abcdefghijklmnop")));
        assert_eq!(serve.common, Common { data_dir: Some("/srv/neo".into()), agent_dir: Some("/srv/omp".into()), allow_multiple: true });
        assert_eq!((serve.web_dir, serve.config, serve.init_settings), (Some("/srv/web".into()), Some("c.json".into()), Some("s.json".into())));
        assert_eq!(
            parsed("desktop-sidecar --port 0 --token-stdin --data-dir=/d"),
            Ok(Command::Sidecar(Sidecar { common: Common { data_dir: Some("/d".into()), ..Common::default() }, port: 0, token_stdin: true }))
        );
        assert_eq!(parsed("doctor --data-dir /d"), Ok(Command::Doctor(Common { data_dir: Some("/d".into()), ..Common::default() })));
    }

    #[test]
    fn says_what_is_wrong_with_a_command_line() {
        assert_eq!(parsed("run").unwrap_err(), "Unknown command run; see neo-agent help");
        assert_eq!(parsed("serve --verbose").unwrap_err(), "Unknown option --verbose for serve; see neo-agent help");
        assert_eq!(parsed("serve --port").unwrap_err(), "--port needs a value");
        assert_eq!(parsed("serve --port=").unwrap_err(), "--port needs a value");
        assert_eq!(parsed("serve --port 70000").unwrap_err(), "--port takes a number from 0 to 65535, not \"70000\"");
        assert_eq!(parsed("serve --allow-multiple=yes").unwrap_err(), "--allow-multiple takes no value");
        assert_eq!(parsed("desktop-sidecar --host 0.0.0.0").unwrap_err(), "Unknown option --host for desktop-sidecar; see neo-agent help");
        assert_eq!(parsed("doctor --port 1").unwrap_err(), "Unknown option --port for doctor; see neo-agent help");
    }

    #[test]
    fn reads_a_configuration_file_strictly() {
        let dir = std::env::temp_dir().join(format!("neo-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        std::fs::write(&file, r#"{"dataDir": "/srv/neo", "host": "0.0.0.0", "port": 3082, "token": "abcdefghijklmnop", "webDir": "/srv/web"}"#).unwrap();
        let config = ConfigFile::read(&file).unwrap();
        assert_eq!((config.data_dir, config.host.as_deref(), config.port, config.agent_dir), (Some("/srv/neo".into()), Some("0.0.0.0"), Some(3082), None));
        std::fs::write(&file, r#"{"stateDir": "/srv/neo"}"#).unwrap();
        assert!(ConfigFile::read(&file).unwrap_err().contains("unknown field `stateDir`"));
        assert!(ConfigFile::read(&dir.join("missing.json")).unwrap_err().starts_with("Cannot read "));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
