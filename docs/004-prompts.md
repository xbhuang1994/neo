# 004 Prompts

This document says what each Session is told and which tools it has. It builds on [003 Execution](003-execution.md).

## Composition

A Session's system prompt is composed from the texts in `assets/prompts`, which are built into the program:

| Role | Sections, in order |
| --- | --- |
| Main Session (`orchestrator`) | `shared`, `orchestrator`, the team sections, `subscriptions`, `replies`, `dispatch`, `admission`, `handoff` with `handoff-orchestrator`, the execution environment, and the current Policy: its version, the accept mode and every enabled rule |
| Worker | `shared`, `worker`, the team sections, `subscriptions`, `replies`, `work`, `handoff` with `handoff-worker`, and the execution environment |
| Sidecar | `sidecar` |
| Watchdog | `watchdog`, and the execution environment |

Every worker's prompt is the same text, so a model provider caches it once for all of them. The team sections are `team/communication`, `team/scope` and `team/delivery`. The texts name tools by their bare names; the Claude Code and Antigravity kernels rewrite them to the names those runtimes give them and adds a note on how its built-in tools map.

A worker's first message is its assignment card, with the Mandate's instructions: for a Ticket accepted under rules, the names and instructions of those rules.

The main Session's prompt states the Policy and the environment, so a change to either in the settings reopens it from its journal with the prompt composed anew. Workers keep the prompt they started with.

There is no editing of the built-in texts at run time. What a team wants the agent to do differently is a rule, in the settings.

## Tools

| Session | Built-in tools | Application tools |
| --- | --- | --- |
| Main | read, bash | `orchestrator_read`, `orchestrator_route`, `orchestrator_ticket_retry`, `orchestrator_ticket_request_status`, `orchestrator_ticket_note`, `orchestrator_trigger_requeue`, `orchestrator_eval_read`, `orchestrator_eval_decide`, `orchestrator_reply`, `orchestrator_thread_unsubscribe`, `wechat_send_file` |
| Worker | read, bash, edit, write, subagents, and waiting for them | `orchestrator_read`, `orchestrator_ack`, `orchestrator_thread_follow`, `orchestrator_thread_unrelated`, `orchestrator_trigger_handback`, `orchestrator_report` |
| Sidecar | read | `sidecar_reply` |
| Watchdog | read, bash | `watchdog_inspect`, `watchdog_intervene` |

Each application tool has a JSON Schema, and the host checks every call again itself: an unknown argument is refused by name. `orchestrator_route` takes several decisions in one call — accept, attach, sidecar, stop, ignore — and answers each on its own, so one refused item leaves the others.

`orchestrator_read` reads resources by name: the ticket list, a ticket with its inputs and reports, a trigger, a thread's page, a decision. Long texts are paged.

A report's optional `topic` becomes the Ticket's digest, which routing matches follow-up messages against.

## Limits on what is said

A message to a person in a chat has at most 100 words, where a Chinese character counts as a word and a run of Latin letters or digits as one. The host refuses a longer acknowledgement or reply and says so to the model. This count is an approximation of word segmentation made without a dictionary.

## Environment

The prepare command and every Session are told the same variables:

| Variable | Value |
| --- | --- |
| `NEO_AGENT_DIR` | The Ticket's directory |
| `NEO_AGENT_NAME` | The Ticket's short name, also its directory's name |
| `NEO_AGENT_TICKET` | The Ticket id |
| `NEO_AGENT_BLOCKED_COMMANDS` | The blocked command names, separated by spaces |
