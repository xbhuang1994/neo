# 006 Deployment

This document says how Neo runs on a machine. It builds on [005 Sessions](005-sessions.md). The steps for installing it are in `SETUP.md`.

## Two ways to run

One program, `neo-agent`, is the whole backend. It runs in one of two ways:

| | Desktop app | Server |
| --- | --- | --- |
| Started by | The app, as `neo-agent desktop-sidecar` | A person or a service manager, as `neo-agent serve` |
| Listens on | `127.0.0.1`, a free port | `--host` and `--port`; by default `127.0.0.1:3082` |
| Access token | One the app makes anew at each start and gives on standard input | `--token` or `NEO_TOKEN`; required unless the address is loopback |
| Interface | The app's own window | The web app, served beside the API, or a desktop app pointed at the server |
| Ends when | The app ends, however it ends: the app holds the backend's standard input open | It is signalled (`SIGINT`, `SIGTERM`, `SIGHUP`, Ctrl+C) |

The desktop app watches its backend: one that ends by itself is started again, with a wait that doubles from one second, and after five failures in a row the app says what the backend said last. A desktop app can also be pointed at a server instead of starting a backend.

On start the program prints one line on standard output — `{"port", "pid", "version", "url"}` — and everything else on standard error.

## One instance

Only one Neo runs per user on a machine. The running instance holds an exclusive lock on a file in the per-user runtime directory, and always one in its data directory; the operating system releases both when the process ends, however it ends. A second instance exits with status 3 and says on which port the first one listens. `--allow-multiple` (or `NEO_ALLOW_MULTIPLE=1`) lets instances with different data directories run side by side.

The desktop app adds its own check, so that starting it twice shows the window that is open: the first app listens on a loopback port it wrote down, and a second one asks it to come to the front and ends.

## What the machine provides

| Thing | Where the program looks |
| --- | --- |
| The Antigravity CLI (`agy`) | `NEO_AGY_BIN`, else `PATH`, else where its official installer puts it: `~/.local/bin`; on Windows `%USERPROFILE%\.local\bin` and `%LOCALAPPDATA%\agy\bin`. Not bundled. Looked for whenever it is needed, so one installed while the backend runs is used at once; the settings' **Install** runs the official installer. Sign in with Google under Settings → Antigravity account or by running `agy` once |
| The web app's files | `--web-dir`, else a `web` folder beside the program |
| `git` | `PATH`. Workers that use git need it installed; nothing else does |
| Model access | The Google account `agy` is signed in to |

`neo-agent doctor` prints all of these as it finds them, and fails when Antigravity cannot run. The application starts without `agy` too: it says so in the app, keeps messages, and works once Antigravity is installed.

A desktop app started from the Finder or a launcher has only the system's folders on its `PATH`; it adds the usual places of user-installed tools (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` and a few more) for its backend.

## Data

The data directory is `~/Library/Application Support/neo-agent` on macOS, `%LOCALAPPDATA%\neo-agent` on Windows, and `$XDG_STATE_HOME/neo-agent` (by default `~/.local/state/neo-agent`) elsewhere; `--data-dir` or `NEO_DATA_DIR` names another.

| Path | Holds |
| --- | --- |
| `orchestrator.sqlite` | Triggers, Threads, Evals, Decisions, Tickets, the Outbox, the effect queue, the settings and their history, the WeChat binding |
| `sessions/` | One journal per Session |
| `work/` | One directory per Ticket, unless the settings name another task directory |
| `attachments/` | Files people attached |
| `worker-bin/` | Stand-ins for blocked commands |
| `instance.lock` | The data directory's lock |

The store has a schema version. A data directory of another version is refused with its version named; nothing is migrated. In particular, the state of the earlier TypeScript releases cannot be opened: start with a new data directory.

## Settings

Everything a person configures is in the app's settings and stored in the database as numbered revisions: the Antigravity models, the pause, the number of workers, the task directory, the prepare command and its shell, blocked commands, proactive assessment and its rules, and who may write.

The command line and the optional configuration file of `serve` carry only what belongs to the machine: the data directory, the address, the port, the token and the web folder. A server that should start from particular settings takes `--init-settings <file>`, which is read only when no settings are stored yet.

## Who may call the API

- **Without a token**, only this machine may call, and only under a loopback name: a request from another address, with a `Host` that is not loopback, or with an `Origin` other than the server's own is refused. This keeps another site's page, and a foreign name that resolves to this machine, from reaching the API through a person's browser.
- **With a token**, every call carries `Authorization: Bearer <token>`. The token has at least 16 characters and is compared in constant time. `GET /api/health` without it answers 401 with `authRequired`, so a client can tell that a server is there and wants a token.
- The web app's files need no token; the page is where the token is entered, and it keeps it in the browser's storage.
- The program refuses to listen on an address that is not loopback without a token.

The server speaks plain HTTP. On a network that is not trusted, put it behind a reverse proxy that adds TLS; `SETUP.md` has an example.

## Troubleshooting

| Sign | Cause and remedy |
| --- | --- |
| "Neo is already running" | Another instance holds the lock. Use the open window, or stop the running service. `--allow-multiple` with another data directory runs a second one |
| "… is not installed" | The Antigravity CLI (`agy`) is missing. Install it from the settings or set `NEO_AGY_BIN`. `neo-agent doctor` shows what is found |
| "Installing … failed" | The official installer failed; the message ends with its last lines. It needs `bash` and `curl` (PowerShell on Windows) and the network |
| "Listening on … needs an access token" | A server address that is not loopback needs `--token` or `NEO_TOKEN` |
| The app says a token is needed | The server has one: enter it under Settings → Connection |
| A data directory is refused for its schema version | It was written by another release line. Start with a new data directory |
| A worker fails with a model error | Check Antigravity's Google sign-in under Settings → Antigravity account. The error is the runtime's own |
| A macOS app that "cannot be opened" | An app that is not notarized must be allowed once; see `SETUP.md` |
