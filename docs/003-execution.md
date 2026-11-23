# 003 Execution

This document says how an accepted Ticket is worked on. It builds on [002 Authorization](002-authorization.md).

## Ticket lifecycle

An accepted Ticket owns its Mandate, a directory and a worker Session. The Executor prepares the directory once: a folder named `<short-name>-<ticket id prefix>` under the task directory of the settings (by default `work/` in the data directory). When the settings have a prepare command, it runs first, in the task directory, with `NEO_AGENT_DIR`, `NEO_AGENT_NAME` and `NEO_AGENT_TICKET` set and at most ten minutes to finish — to clone a repository into the folder, for example. A prepare command that fails refuses the accept, and the person is told why.

Work then goes through the effect queue, a durable list of things to do that survives a restart (persisted in SQLite WAL mode with `synchronous=NORMAL`, while startup pre-warms model listings and the main Session):

- A **launch** effect opens the worker Session in the Ticket's directory and sends the assignment card. The card is written to the Session's journal before the Assignment is recorded as started, so a worker always reports against a running Assignment.
- A **delivery** effect, one per Ticket, sends each later Input: a person's follow-up, an answer to the worker's question, a note from the Watchdog. Before each send the Executor rereads the Ticket, and sends nothing to one that ended or whose Assignment was replaced.

The settings cap how many workers run at once. A worker holds its slot from just before a message that starts a turn is sent until that turn is seen to start, and then for as long as it works; this keeps two launches from sharing the last slot. A launch that finds no slot waits in the queue and is woken immediately when a worker turn ends and frees a slot. Reply tools wait on their specific outbound message receipt (`wait_for`) rather than draining unrelated outbox entries.

A worker reports with `orchestrator_report`:

| State | Meaning | What follows |
| --- | --- | --- |
| `progress` | Still working | Nothing is sent, unless the report asks a person a question or answers one |
| `ready` | The result is there | When `direct_reply` is passed, the reply goes straight to the Outbox and only a notice reaches the main Session; otherwise the main Session is told and sends the result. The Ticket completes |
| `blocked`, `failed` | It cannot go on | The main Session is told; the Ticket waits for a person, who may retry it |
| `dropped` | A follow-up was not for this Ticket or needs no work | The message is handed back for routing, or a no-work follow-up with `reply_to_trigger_id` and `direct_reply` answers directly |

A worker whose turn ends without a report and with nothing running in the background gets a `waiting` report made for it, and the main Session is told so it can ask for the worker's status. A model request that fails becomes a `failed` report with the runtime's own error.

## Background work

A worker's command that runs longer than a minute moves to the background, and a worker may start subagents (`ticket-task`, at most eight at once, two levels deep). The end of a background job wakes the worker in its Session with the result. While jobs run, the worker's turn may end: it keeps its slot and is not reported as idle.

A handoff to a person changes this. When the worker's last word is `ready`, a question, or `blocked` / `failed`, its subagents are stopped and its shell jobs — a development server offered for review, for example — are left running until the Assignment ends, without waking it.

The Watchdog is a control loop beside the work, every three minutes:

1. **Without a model call** it puts back a launch or delivery whose queue entry is missing, and reminds the main Session — twice at most — of a result, question or answer that no reply was sent for.
2. **Without a model call** it passes every Ticket that makes progress: its workspace files or its jobs' output changed, or its processes used CPU time within half an hour of the last output. Processes are found by the job's own process ids, else by working directory inside the Ticket's directory.
3. **Only for what is left** it starts a one-off Watchdog Session with the evidence inlined — processes, the newest files, the tail of the newest log, the latest transcript lines — and two tools: `watchdog_inspect`, and `watchdog_intervene` to wake a stranded worker, cancel one hung job and tell its worker why, retry a Ticket that failed in passing (twice at most per Ticket), or relay a report again.

A working Ticket is inspected after six minutes without output or CPU time and at most every ten minutes; an idle one after a minute, then every three.

The Sidecar answers a person's read-only question about a Ticket — progress, findings, a comparison — on a one-off Session with read access to the Ticket's directory, without waking or interrupting its worker.

## Stop and recovery

A person's stop ends the Ticket and withdraws its Mandate: the worker's turn is interrupted, its jobs are cancelled, its Session closes, and any tool call it still makes is refused with the reason. Inputs that arrive later go back to routing.

A retry — by a person through the main Session, or by the Watchdog — ends the stalled Assignment and starts a new one under the same Mandate, in the same directory. When the Session's runtime context can be resumed, the new Assignment gets a short card; otherwise the whole assignment again.

After a restart of the application, each Assignment that was running is marked interrupted and started again with a recovery note: inspect the directory, do not repeat an external operation that already happened, rerun what is still needed. Background jobs of the previous run ended with it. Nothing that was already sent is sent again: every message into a Session and every reply out has a request id, and the journal and the Outbox take each id once.

The pause in the settings holds everything: nothing is assessed, launched, delivered or sent; messages are still received and wait.

## Execution kernel

Every Session runs on the **Antigravity CLI (`agy`)**, driven as a child process by the pure-Rust backend:

| Aspect | Antigravity CLI (`agy`) |
| --- | --- |
| Protocol | Print mode with `stream-json` input and output, one turn per message in order; `--conversation` continues a conversation in a new process. The Session runs as a custom agent, written with its prompt, its built-in tools (including file, search, subagent, `run_workflow`, and worker web tools) and a plugin into a bridge folder beside the working directory (`<directory>.neo-<id>`, added with `--add-dir`); the runtime works in the first of its folders in path order, which the working directory always is. The bridge is removed with the process |
| The application's tools | An MCP server on a loopback port that answers only a per-Session bearer token, named in the plugin; the model calls them through `call_mcp_tool` on the server `neo_neo` |
| Guard on every tool call | The plugin's `SessionStart`, `PreToolUse` (all tools), `PostToolUse` (on `run_command`), and `Stop` hooks, for the main conversation and its subagents alike: `neo-agent agy-hook` relays them to the Session's driver over loopback, and a `PreToolUse` refusal reaches the model with its reason while the turn goes on. A hook that fails or times out refuses the call. The agent is given only the built-in tools of its kinds, so a read-only Session (a sidecar) has no editing or shell tools at all. Edits inside the bridge are refused; a model that rewrites it with its shell is not stopped, as with other commands the guard cannot read |
| Background jobs | Commands that move to the background and subagents, known from the hooks and step updates: a `Stop` hook that finds them running ends the turn as waiting, and their end wakes the model. They are listed but cannot be acknowledged or cancelled one by one; ending the process ends them all. A message sent while they run waits for them |
| Models | The Google account `agy` is signed in to; the ids `agy models` lists, which name their effort. A change of model starts a new process at the next message once no turn runs. Images are saved in the bridge and named in the message for the model to view, since print mode takes text only |

Each Session is one runtime process, in its own process group so that it ends with its children. The application keeps its own journal for every Session, which is what makes delivery idempotent and preserves the transcript across restarts.

The main Session, the Sidecar, the Watchdog and every worker run on Antigravity; the settings allow choosing separate models for the main Session (`eval`) and workers (`executor`). The commands the settings block are refused the same way in every Session and prepare command: stand-ins for them come first on `PATH`.
