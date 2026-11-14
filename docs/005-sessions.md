# 005 Sessions

This document says how Sessions are kept and how the conversation reaches them. It builds on [004 Prompts](004-prompts.md).

## Roles

| Session | Lives | Works in |
| --- | --- | --- |
| Main | For the life of the installation, until a person resets it | The data directory |
| Worker | From its Ticket's first Assignment until the Ticket ends; reopened when the Ticket resumes | The Ticket's directory |
| Sidecar, Watchdog | One turn | The Ticket's directory, the data directory |

One-off turns run on the main Session's model, else the workers'. Their journal is deleted when the turn is over, and they give way at once when the application stops.

## The journal

Each Session has one JSONL file under `<data>/sessions`, and the store maps the Session's id to it. It holds:

- every message the application put in, with its request id, whether people see it, and where it came from;
- which of them still wait to be shown to the model, and whether each asks for a turn;
- which were taken into a turn;
- what the model and its tools said;
- the runtime's own session id or file, per kernel, for resuming its context.

Sending is idempotent by request id: a message already in the journal is not added again. A message is first written, then submitted to the runtime; a crash in between leaves it waiting, and it is submitted when the Session is next opened. Three kinds of sending exist: one that starts a turn or joins the running one, one that waits for the next turn (a notice), and one that is only shown to people (a chat entry).

A journal that cannot be read stops the Session from opening, with its path named. One whose file is gone is replaced by a new, empty one.

## Models

A role's model is the one the settings name for the current kernel, or the kernel's default. A change applies to open Sessions of that kernel from their next turn. On Oh My Pi an unknown model is refused when it is chosen.

## The conversation

A person's message is written to the main Session's journal as a visible entry that starts no turn, and taken in as a Trigger whose id derives from the message's id — so the same message sent twice is one message. Then routing delivers its candidate card to the main Session.

Attachments: an image is shown to the model with the candidate and also saved; a text file up to 256 KiB is inlined in the message; any other file is saved under `<data>/attachments` and named by its path for a worker to read.

Replies — acknowledgements, answers, questions and results — go through the Outbox to the conversation the request came from, and each is written to the journal as a visible entry under the reply's own id. What people see is therefore exactly what was sent, not the model's own turn text.

Messages that arrive while a candidate is being decided are batched into the next Eval of that conversation. WeChat messages wait 1.8 seconds for more parts before routing, since people send several in a row.

Resetting the conversation closes the main Session and starts an empty journal under the same id. Tickets, workers, attachments and the WeChat binding stay.

## WeChat

One WeChat user, bound by scanning a QR code in the settings, talks to the main Session as in the app. The bridge speaks the iLink Bot protocol: a login by QR code with an optional verification code, a long poll for messages, and media through a CDN encrypted with AES-128-ECB.

- Only direct messages of the bound user are taken; group messages and other senders are dropped before they enter the domain.
- Binding adds `wechat:<user id>` to the chat Source's allowed list, and unbinding removes it.
- The poll's cursor advances only after its messages were taken in. Text, voice transcripts, images, files and videos are received; an attachment that cannot be fetched is said so in the message and holds nothing back.
- A reply carries the reply's id as the message's client id, so a retry is the same message to WeChat.
- `wechat_send_file` sends a local file to the bound user: an image, a video, or any file up to 100 MiB.
- The account's credential, the bound user and the cursor are kept in the store and never leave through the API. The app is given only what the QR code encodes, and draws the code itself.
