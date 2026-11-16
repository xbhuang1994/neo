# SETUP

How to install Neo and give it access to a model. For how it runs, see [docs/006-deployment.md](docs/006-deployment.md); for every option, [docs/009-reference.md](docs/009-reference.md).

## 1. Install

### macOS

1. Download the disk image for your Mac: `Neo-<version>-macos-arm64.dmg` for Apple silicon, `-x64.dmg` for Intel.
2. Open it and drag **Neo** to Applications.
3. Open the app. A build that is not notarized is refused the first time ("cannot be opened"): allow it once under System Settings → Privacy & Security → Open Anyway, or run

   ```sh
   xattr -dr com.apple.quarantine "/Applications/Neo.app"
   ```

Data is kept in `~/Library/Application Support/neo-agent`.

### Windows

1. Run `Neo-<version>-windows-x64-setup.exe`. It installs for the current user and needs no administrator rights.
2. An installer that is not signed makes SmartScreen ask: choose More info → Run anyway.
3. Start **Neo** from the Start menu.

Data is kept in `%LOCALAPPDATA%\neo-agent`.

### Linux server

```sh
tar -xzf neo-agent-<version>-linux-x64.tar.gz -C /opt && mv /opt/neo-agent-<version>-linux-x64 /opt/neo-agent
/opt/neo-agent/neo-agent doctor      # what this machine provides
/opt/neo-agent/neo-agent serve       # http://127.0.0.1:3082/, this machine only
```

The package holds the backend and the web app, and runs from wherever it is unpacked. Data is kept in `~/.local/state/neo-agent`, or where `--data-dir` says.

## 2. Give it a model

Open Settings → Kernel and models and choose the kernel. No kernel comes with Neo: it finds the `claude`, `omp` and `agy` programs already on the machine, on `PATH` or where their installers put them (`~/.local/bin`; on Windows also `%LOCALAPPDATA%\omp` and `%LOCALAPPDATA%\agy\bin`). A kernel that is missing shows an **Install** button, which runs the vendor's official installer (`curl -fsSL <script> | bash`, or `irm <script> | iex` on Windows) on the machine the backend runs on; the kernel can be chosen as soon as it finishes, without a restart. `NEO_CLAUDE_BIN`, `NEO_OMP_BIN` and `NEO_AGY_BIN` name a program elsewhere.

Each kernel needs model access of its own:

**Claude Code.** It reads the environment the backend runs in, and your Claude Code settings (`~/.claude/settings.json`) for what the environment does not say:

```sh
export ANTHROPIC_API_KEY=...          # or ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_BASE_URL=...         # only for a gateway or a compatible endpoint
```

A desktop app started from the Dock or the Start menu does not see variables set in a shell profile: put them in `~/.claude/settings.json` under `env`, or sign in with `claude` once in a terminal.

**Oh My Pi.** It uses the providers, models and sign-in of your own `omp`: the agent directory `~/.omp/agent` (or `PI_CODING_AGENT_DIR`), unless `--agent-dir` names another. Configure `omp` as usual and Neo offers the same models.

**Antigravity CLI.** After installing it, run `agy` once in a terminal to sign in with Google. The backend offers the models `agy models` lists, and leaves the thinking effort to the runtime. Its workers run without background jobs or subagents.

The settings page lists the models the chosen kernel offers; leave a role on "kernel default" to use the runtime's own choice. A missing runtime or a failing model request is shown in the app in the runtime's own words.

Workers that use git need `git` installed. Nothing else is required.

## 3. Use it

Type what you want done in the conversation. Tasks appear under Tasks with their state, questions and reports.

- **WeChat**: Settings → WeChat → Connect, scan the code with the account that should be able to write to the agent, and confirm on the phone. That account is added to the allowed senders; Disconnect removes it.
- **Where tasks work**: Settings → Task directory. A prepare command can make each task's folder, for example `git clone https://example.com/repo.git "$NEO_AGENT_DIR"`.
- **Pause**: Settings → Pause processing holds everything without losing messages.

## 4. Run it as a server for other machines

Listening on anything but loopback needs an access token of at least 16 characters:

```sh
NEO_TOKEN=$(openssl rand -hex 24) /opt/neo-agent/neo-agent serve --host 0.0.0.0 --port 3082 --data-dir /var/lib/neo-agent
```

Open `http://<server>:3082/` in a browser and enter the token under Settings → Connection, or point a desktop app at the server there (Remote server). The model access of step 2 belongs to the environment of the server process.

**As a service.** The package includes `neo-agent.service` for systemd: copy it to `/etc/systemd/system/`, set the user, the paths and the token, then `systemctl daemon-reload && systemctl enable --now neo-agent`. Keep the unit readable by root only, since it holds the token.

**As a user service, without root.** `neo-agent-user.service` runs it under your own account and restarts it within 3 seconds after a crash, a kill or an update, never giving up:

```sh
mkdir -p ~/.config/neo-agent ~/.config/systemd/user
install -m 600 /dev/null ~/.config/neo-agent/neo-agent.env   # NEO_TOKEN=…, ANTHROPIC_* and PATH, one per line
cp /opt/neo-agent/neo-agent-user.service ~/.config/systemd/user/neo-agent.service
systemctl --user daemon-reload && systemctl --user enable --now neo-agent
loginctl enable-linger "$USER"                                 # start at boot, without a login
```

After replacing the program, `systemctl --user restart neo-agent`. Do not start a second copy by hand beside it: only one instance runs per user.

**Behind TLS.** The server speaks plain HTTP. On a network you do not trust, keep it on loopback and put a reverse proxy in front, for example Caddy:

```
neo.example.com {
    reverse_proxy 127.0.0.1:3082
}
```

With a proxy the server still needs the token, because requests no longer come under a loopback name: start it with `--host 127.0.0.1` and `NEO_TOKEN` set.

**Starting from given settings.** `--init-settings settings.json` is read once, when the data directory has no settings yet; after that the settings are changed in the app. `--config file.json` holds the machine's options (`dataDir`, `agentDir`, `host`, `port`, `token`, `webDir`) instead of the command line.

## 5. Upgrade

Install the new package over the old one; the data directory stays. A data directory written by another release line — in particular by the TypeScript releases before 0.2 — is refused with its schema version named: start with a new data directory. Nothing is migrated.

## If something is wrong

`neo-agent doctor` prints what the machine provides: the runtimes it found, git, the directories. The app's Settings → About shows how each part of the backend is doing. [docs/006-deployment.md](docs/006-deployment.md) has a table of signs and remedies.
