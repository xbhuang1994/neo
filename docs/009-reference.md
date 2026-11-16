# 009 Reference

The command line, the environment, the settings and the API in one place. It builds on [006 Deployment](006-deployment.md).

## Commands

```
neo-agent serve [options]            run as a server
neo-agent desktop-sidecar [options]  run as the desktop app's backend (the app starts it)
neo-agent doctor [options]           check what this machine provides
neo-agent version
```

| Option | For | Meaning |
| --- | --- | --- |
| `--data-dir <dir>` | all | Where state is kept. Default: the per-user data directory |
| `--agent-dir <dir>` | all | Oh My Pi's agent directory. Default: `PI_CODING_AGENT_DIR`, else `~/.omp/agent` |
| `--allow-multiple` | serve, desktop-sidecar | Allow another instance with a different data directory |
| `--config <file>` | serve | A JSON file with `dataDir`, `agentDir`, `host`, `port`, `token`, `webDir`; the command line wins over it |
| `--host <host>` | serve | Address to listen on. Default `127.0.0.1` |
| `--port <port>` | serve, desktop-sidecar | Default 3082 for serve, 0 (any free port) for desktop-sidecar |
| `--token <token>` | serve | Access token, at least 16 characters. Required unless the address is loopback |
| `--web-dir <dir>` | serve | The web app's files. Default: found beside the program |
| `--init-settings <file>` | serve | Settings (JSON, as below) to start from when none are stored yet |
| `--token-stdin` | desktop-sidecar | Read the token from the first line of standard input; the program ends when that input closes |

Exit status: 0 after a clean stop, 1 for a failure, 2 for a wrong command line, 3 when another instance runs. A stand-in for a blocked command exits with 126.

| Environment | Meaning |
| --- | --- |
| `NEO_DATA_DIR` | Same as `--data-dir` |
| `NEO_TOKEN` | Same as `--token` |
| `NEO_ALLOW_MULTIPLE=1` | Same as `--allow-multiple` |
| `NEO_CLAUDE_BIN`, `NEO_OMP_BIN`, `NEO_AGY_BIN` | The runtime programs, when not on `PATH` or where their installers put them |
| `NEO_SHIM` | The Oh My Pi extension file, when not beside the program |
| `NEO_RUNTIME_DIR` | Where the per-user instance lock is kept |
| `NEO_AGENT_BIN` | For the desktop app: the backend program, when not installed beside it |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | Claude Code's model access, as that runtime reads them |

## Settings

Stored in the database; changed in the app or through the API. As JSON:

| Field | Default | Meaning |
| --- | --- | --- |
| `paused` | `false` | While true nothing is assessed, launched or sent; messages are still received |
| `kernel` | `omp` | `omp`, `claude` or `antigravity` |
| `models.<kernel>.eval` | `null` | The main Session's model: `{provider, model, thinkingLevel?}`, or `null` for the kernel's default |
| `models.<kernel>.executor` | `null` | The workers' model, likewise |
| `eval.mode` | `observe` | Proactive assessment: `off`, `observe` or `auto`, as [002 Authorization](002-authorization.md) says |
| `eval.timeoutSeconds` | 120 | An assessment's time limit, 30 to 600 |
| `executor.maxWorkers` | 3 | Workers at once, 1 to 16 |
| `executor.directory` | empty | The task directory, absolute; empty is `<data>/work` |
| `executor.prepare` | empty | A command run before a Ticket's directory exists, such as a clone into `$NEO_AGENT_DIR`; at most 4000 characters |
| `executor.prepareShell` | unset | The shell for it; unset is `sh`, or `cmd.exe` on Windows |
| `executor.blockedCommands` | `[]` | Command names workers must not run |
| `policy.rules` | two examples | Each `{id, name, enabled, instruction}`: a kind of proactive work |
| `policy.sources.chat.allowed` | `[{id: "web:local"}]` | Who may write: `web:local` is the app; a bound WeChat user is `wechat:<id>` |

Thinking levels are `auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; Claude Code has no `minimal`. With the Claude Code kernel `provider` is ignored and `model` is the name that runtime takes, such as `sonnet` or `opus`. With the Antigravity kernel `provider` is ignored too, `model` is an id `agy models` lists, such as `gemini-3.8-flash-medium`, and it takes no thinking level: the runtime keeps the effort the model id names.

With this distribution's one Source every message is a direct request, so proactive assessment and its rules have nothing to act on: they are kept for Sources that receive messages not addressed to the agent.

## API

JSON over HTTP, as [006 Deployment](006-deployment.md) says who may call. Errors are `{"error": "<words>"}` with status 400, 401, 403, 404, 413 or 415. The app polls the first three routes every two seconds.

| Route | Does |
| --- | --- |
| `GET /api/health` | `{ready, version, kernel, paused, activeWorkers, components}`; each component has `state` (`ready`, `waiting`, `error`), `detail` and `at` |
| `GET /api/messages` | `{messages}`: the visible conversation, each `{id, role: user\|assistant, text, at, source, images?, files?}` |
| `GET /api/workers` | `{workers}`: every Ticket with its worker: `{ticketId, title, stage, outcome, updatedAt, directory, digest, session, background, assignment, progress, attention, pendingInputs, delivery}` |
| `GET /api/workers/{ticketId}` | The same with `inputs` and `recent`, the worker's latest thirty transcript entries |
| `GET /api/activity` | `{router, workers}`: whether the main Session is thinking, and for each busy worker `{ticketId, title, doing}`, a line on what it does now: its latest tool call or line while in a turn, else its background job, else its latest report. The app's ticker polls it |
| `POST /api/chat` | `{text, attachments?, messageId?}` → 202 `{requestId, triggerId, result: stored\|duplicate\|filtered}`. At most 8000 characters and 3 attachments of 5 MiB, each `{name, mediaType, data}` with base64 data. The same `messageId` is the same message |
| `POST /api/session/reset` | Empties the conversation; Tickets and workers stay |
| `GET /api/settings/models` | `{kernel, kernels, supports, current, available, problem}`; each of `kernels` is `{id, problem, installed, installing}` |
| `PUT /api/settings/models` | `{eval, executor}`, each a model or `null` |
| `PUT /api/settings/kernel` | `{kernel}` |
| `POST /api/settings/kernel/install` | `{kernel}`: runs that kernel's official installer on the backend's machine and answers when it ends, with the models view; nothing is run when the program is there already |
| `GET /api/settings/general` | `{paused, eval, executor, policy, defaults, limits}` |
| `PUT /api/settings/general` | Any of `paused`, `eval`, `executor`, `policy`; each block sent replaces that block whole |
| `GET /api/wechat` | `{state, message, qrContent?, senderId?}`; `state` is `disconnected`, `waiting`, `scaned`, `verify`, `connected` or `error` |
| `POST /api/wechat/connect` | Starts a login, or takes up the binding |
| `POST /api/wechat/verify` | `{code}`: the verification code the phone shows |
| `POST /api/wechat/disconnect` | Unbinds |

A Ticket's `stage` is `{stage: person, action: delivery\|answer\|review\|blocked\|failed}`, `{stage: working, action?: queued}`, `{stage: idle}` or `{stage: ended}`; an ended Ticket's `outcome` is `completed`, `dropped` or `stopped`.

A request body has a `Content-Length` and at most 24 MiB; `Content-Type` is `application/json`, with or without a charset.
