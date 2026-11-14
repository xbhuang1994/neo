# 003 Execution

This document says how an accepted Ticket is worked on. It builds on [002 Authorization](002-authorization.md).

## Ticket lifecycle

An accepted Ticket owns its Mandate, a directory and a worker Session. The Executor prepares the directory once: a folder named `<short-name>-<ticket id prefix>` under the task directory of the settings (by default `work/` in the data directory). When the settings have a prepare command, it runs first, in the task directory, with `NEO_AGENT_DIR`, `NEO_AGENT_NAME` and `NEO_AGENT_TICKET` set and at most ten minutes to finish — to clone a repository into the folder, for example. A prepare command that fails refuses the accept, and the person is told why.

Work then goes through the effect queue, a durable list of things to do that survives a restart:

- A **launch** effect opens the worker Session in the Ticket's directory and sends the assignment card. The card is written to the Session's journal before the Assignment is recorded as started, so a worker always reports against a running Assignment.
- A **delivery** effect, one per Ticket, sends each later Input: a person's follow-up, an answer to the worker's question, a note from the Watchdog. Before each send the Executor rereads the Ticket, and sends nothing to one that ended or whose Assignment was replaced.

The settings cap how many workers run at once. A worker holds its slot from just before a message that starts a turn is sent until that turn is seen to start, and then for as long as it works; this keeps two launches from sharing the last slot. A launch that finds no slot waits in the queue.

A worker reports with `orchestrator_report`:

| State | Meaning | What follows |
| --- | --- | --- |
| `progress` | Still working | Nothing is sent, unless the report asks a person a question or answers one |
| `ready` | The result is there | The main Session is told and sends the result; the Ticket completes |
| `blocked`, `failed` | It cannot go on | The main Session is told; the Ticket waits for a person, who may retry it |
| `dropped` | A follow-up was not for this Ticket | The message is handed back for routing |

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

## Execution kernels

A kernel is the agent runtime a Session runs on. There are two, chosen in the settings, and the application treats them alike:

| | Claude Code (`claude`) | Oh My Pi (`omp`) |
| --- | --- | --- |
| Protocol | `stream-json` on standard input and output, with control requests | `--mode rpc`, plus one extension file (`shim/neo-omp-shim.ts`) |
| The application's tools | An in-process MCP server; the model sees `mcp__neo__<name>` | Host tools; the model sees the bare names |
| Guard on every tool call | A `PreToolUse` hook answered by the application | The extension asks the application |
| Background jobs | Claude Code's background commands and subagents | Oh My Pi's async jobs, listed and cancelled through the extension |
| Models | The `ANTHROPIC_*` environment; model names only; no advisor model | Providers of its agent directory; an optional advisor model |

Each Session is one runtime process, in its own process group so that it ends with its children. The application keeps its own journal for every Session, which is what makes delivery idempotent and the transcript the same on both kernels.

Switching the kernel applies at once: the main Session reopens on the new kernel with its transcript, and a worker stays on the kernel it started on until its Ticket ends. Each kernel keeps its own model choices. The commands the settings block are refused on both kernels the same way: stand-ins for them come first on the `PATH` of every Session and prepare command.
