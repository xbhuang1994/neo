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
| `NEO_CLAUDE_BIN`, `NEO_OMP_BIN`, `NEO_AGY_BIN`, `NEO_HERMES_BIN` | The runtime programs, when not on `PATH` or where their installers put them |
| `NEO_SHIM` | The Oh My Pi extension file, when not beside the program |
| `NEO_RUNTIME_DIR` | Where the per-user instance lock is kept |
| `NEO_AGENT_BIN` | For the desktop app: the backend program, when not installed beside it |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | Claude Code's model access, as that runtime reads them |

## Settings

Stored in the database; changed in the app or through the API. As JSON:

| Field | Default | Meaning |
| --- | --- | --- |
| `paused` | `false` | While true nothing is assessed, launched or sent; messages are still received |
| `kernel` | `omp` | The kernel the main Session, the Sidecar and the Watchdog run on: `omp`, `claude`, `antigravity` or `hermes` |
| `workerKernel` | unset | The kernel workers run on; unset follows `kernel` |
| `models.<kernel>.eval` | `null` | The main Session's model when it runs on that kernel: `{provider, model, thinkingLevel?}`, or `null` for the kernel's default |
| `models.<kernel>.executor` | `null` | The workers' model when they run on that kernel, likewise |
| `eval.mode` | `observe` | Proactive assessment: `off`, `observe` or `auto`, as [002 Authorization](002-authorization.md) says |
| `eval.timeoutSeconds` | 120 | An assessment's time limit, 30 to 600 |
| `executor.maxWorkers` | 3 | Workers at once, 1 to 16 |
| `executor.directory` | empty | The task directory, absolute; empty is `<data>/work` |
| `executor.prepare` | empty | A command run before a Ticket's directory exists, such as a clone into `$NEO_AGENT_DIR`; at most 4000 characters |
| `executor.prepareShell` | unset | The shell for it; unset is `sh`, or `cmd.exe` on Windows |
| `executor.blockedCommands` | `[]` | Command names workers must not run |
| `policy.rules` | two examples | Each `{id, name, enabled, instruction}`: a kind of proactive work |
| `policy.sources.chat.allowed` | `[{id: "web:local"}]` | Who may write: `web:local` is the app; a bound WeChat user is `wechat:<id>` |

Thinking levels are `auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; Claude Code has no `minimal`. With Oh My Pi and Hermes Agent, `provider` and `model` name the provider and model id. With the Claude Code kernel `provider` is ignored and `model` is the name that runtime takes, such as `sonnet` or `opus`. With the Antigravity kernel `provider` is ignored too, `model` is an id `agy models` lists, such as `gemini-3.8-flash-medium`, and it takes no thinking level: the runtime keeps the effort the model id names.

With this distribution's one Source every message is a direct request, so proactive assessment and its rules have nothing to act on: they are kept for Sources that receive messages not addressed to the agent.

## API

JSON over HTTP, as [006 Deployment](006-deployment.md) says who may call. Errors are `{"error": "<words>"}` with status 400, 401, 403, 404, 413 or 415. The app polls the first three routes every two seconds.

| Route | Does |
| --- | --- |
| `GET /api/health` | `{ready, version, kernel, workerKernel, paused, activeWorkers, components}`; each component has `state` (`ready`, `waiting`, `error`), `detail` and `at` |
| `GET /api/messages` | `{messages}`: the visible conversation, each `{id, role: user\|assistant, text, at, source, images?, files?}` |
| `GET /api/workers` | `{workers}`: every Ticket with its worker: `{ticketId, title, stage, outcome, updatedAt, directory, digest, session, background, assignment, progress, attention, pendingInputs, delivery}` |
| `GET /api/workers/{ticketId}` | The same with `inputs` and `recent`, the worker's latest thirty transcript entries |
| `GET /api/activity` | `{router, workers}`: whether the main Session is thinking, and for each busy worker `{ticketId, title, doing}`, a line on what it does now: its latest tool call or line while in a turn, else its background job, else its latest report. The app's ticker polls it |
| `POST /api/chat` | `{text, attachments?, messageId?}` → 202 `{requestId, triggerId, result: stored\|duplicate\|filtered}`. At most 8000 characters and 3 attachments of 5 MiB, each `{name, mediaType, data}` with base64 data. The same `messageId` is the same message |
| `POST /api/session/reset` | Empties the conversation; Tickets and workers stay |
| `GET /api/settings/models` | `{kernel, workerKernel, workerKernelFollows, loading, kernels, supports, workerSupports, current, available, problem, workerAvailable, workerProblem}`; each of `kernels` is `{id, problem, installed, installing, installProgress, supports, available, listProblem, loading, models: {eval, executor}}`. It never waits for a kernel to list its models: the last list is answered and renewed in the background once a minute old, and `loading` is true while a kernel lists them the first time; `installProgress` is the last line a kernel's installer printed while it runs |
| `PUT /api/settings/models` | `{eval, executor, kernel?, workerKernel?}`: the models, each a model or `null`, and optionally the kernels (`workerKernel` `null` follows `kernel`), checked together and saved as one; a new `kernel` reopens the main Session on it |
| `PUT /api/settings/kernel` | `{kernel?, workerKernel?}`: switch the kernels only |
| `POST /api/settings/kernel/install` | `{kernel}`: runs that kernel's official installer on the backend's machine and answers when it ends, with the models view; nothing is run when the program is there already. The installer runs on when the request goes away, for up to ten minutes (Hermes Agent: two hours, after fetching its repository one release at a time, which a later install continues) |
| `GET /api/settings/providers` | `{providers, apis, serves}`: the custom model providers the kernels share, each `{name, api, baseUrl, headers?, models, kernels, extra?, key, listsModels, modelsProblem}` with `key` only a hint (`…abcd`, `$VARIABLE`) or `null`; `models` is listed over the provider's own API (`GET <baseUrl>/models` for the OpenAI APIs, Anthropic's paged `GET /v1/models`) at start, when a provider is added or reached another way, and on refresh, keeping what was known of a model before and dropping models no longer listed; only other APIs (`listsModels` false) take models typed by hand; `modelsProblem` says why the last listing failed, when it did; `apis` the APIs a provider may speak; `serves` the APIs each kernel can use (`*` any). The first time there is no list, Oh My Pi's custom providers in its `models.yml` are imported once |
| `PUT /api/settings/providers` | `{providers}`: replaces the list. Each provider may carry `apiKey` (a key or the name of a variable holding one; `null` or empty for none; absent keeps the key it had) and `previousName` when renamed. `kernels` defaults to every kernel that can use its API. Keys are kept apart from the settings and their history. Sessions opened afterwards use the change |
| `POST /api/settings/providers/import` | Adds Oh My Pi's custom providers not yet listed by name, with their keys; answers the providers view with `imported`, how many were added |
| `POST /api/settings/providers/refresh` | Asks every provider for its models now; answers the providers view |
| `GET /api/settings/accounts` | `{kernels, login}`: for each kernel `{id, installed, problem, accounts}`, `accounts` being `{accounts, login, anyProvider, apiKeys, note?}`: who it is logged in as (`{id, provider, kind, label, removable}`), the providers it can log in to (`{id, name}`; any other id when `anyProvider`), whether it takes API keys. Claude Code is read with `claude auth status`, Oh My Pi from its `agent.db`, Hermes from its `auth.json`, the Antigravity CLI from its login file. `login` is the login in progress or the last one |
| `POST /api/settings/accounts/login` | `{kernel, provider}`: runs the kernel's own login (`claude auth login`, `omp login <provider>`, `hermes auth add <provider>`, the Antigravity CLI's `acp --login`) over pipes, one at a time, and answers `{login}`: `{id, kernel, provider, state, links, output}` with `state` `running`, `done` or `failed`, the links to open and what the program printed. A login ends after ten minutes |
| `GET /api/settings/accounts/login` | `{login}`, to follow a login |
| `POST /api/settings/accounts/login/input` | `{text}`: passes one line to the login, such as the code a page shows or the address the browser landed on (for a callback to the backend's own machine) |
| `POST /api/settings/accounts/login/cancel` | Ends the login in progress |
| `POST /api/settings/accounts/logout` | `{kernel, account}`: logs out of an account (Oh My Pi's credential is marked deleted as its `/logout` does; Hermes's is removed with `hermes auth remove`; Antigravity's login file is deleted) |
| `POST /api/settings/accounts/key` | `{kernel, provider, key}`: stores an API key in Oh My Pi's or Hermes's own credential store |
| `GET /api/settings/general` | `{paused, eval, executor, policy, defaults, limits}` |
| `PUT /api/settings/general` | Any of `paused`, `eval`, `executor`, `policy`; each block sent replaces that block whole |
| `GET /api/wechat` | `{state, message, qrContent?, senderId?}`; `state` is `disconnected`, `waiting`, `scaned`, `verify`, `connected` or `error` |
| `POST /api/wechat/connect` | Starts a login, or takes up the binding |
| `POST /api/wechat/verify` | `{code}`: the verification code the phone shows |
| `POST /api/wechat/disconnect` | Unbinds |

A Ticket's `stage` is `{stage: person, action: delivery\|answer\|review\|blocked\|failed}`, `{stage: working, action?: queued}`, `{stage: idle}` or `{stage: ended}`; an ended Ticket's `outcome` is `completed`, `dropped` or `stopped`.

A request body has a `Content-Length` and at most 24 MiB; `Content-Type` is `application/json`, with or without a charset.
