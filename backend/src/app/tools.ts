//! The tools the models call: the main Session's for routing, assessing and replying, and a worker's for reading its
//! ticket, acknowledging, handing back and reporting.

import * as path from "node:path";
import {
  UserError,
  createOutcome,
  followupOwners,
  formatIso,
  isTicketLive,
  key,
  nowIso,
  nowMs,
  reasonCode,
  reasonText,
  threadKey,
  whyCode,
  whySaid,
  type Accept,
  type Decision,
  type DecisionKind,
  type Purpose,
  type Question,
  type ReplyRequest,
  type ReportState,
  type Ticket,
  type WorkerReport,
} from "../core/index.ts";
import { errorMessage, isRecord, type ToolSpec } from "../kernel/types.ts";
import { accessibleThreads, canAccessTicket } from "./access.ts";
import { collectArtifacts } from "./artifacts.ts";
import { charCount, ticketCard } from "./cards.ts";
import {
  CLARIFICATION_TTL_MS,
  bumpClarificationTurn,
  clearClarification,
  consumeClarification,
  saveClarification,
  type ClarificationOption,
  type PendingClarification,
} from "./clarification.ts";
import { Args, WORKTREE_NAME_RULE, validWorktreeName, type AppContext } from "./context.ts";
import type { DeviceStatus, DeviceTier, McuTransportKind } from "../devices/index.ts";
import { SIDECAR } from "./effects.ts";
import { receiptNotice, reportRelay, threadFollowedNotice } from "./notices.ts";
import { recallConfig, sanitizeCardText } from "./recall.ts";
import { grammar } from "./resources.ts";
import { CHAT_SOURCE } from "./settings.ts";
import { IM_WORDS, checkedImText, clip, languageMismatch, wordCount } from "./text.ts";

export { Args } from "./context.ts";

/** The most words a routing note may have. */
export const NOTE_WORDS = 30;
/** The longest topic a ticket keeps; a longer one is cut, not refused. */
const TOPIC_CHARS = 200;

const READ_RESOURCE = "The resource, as the tool's description lists them.";
const READ_OFFSET =
  "Copy next_offset from the previous page; it counts characters of a text and items of a list.";
const READ_LIMIT =
  "Characters of a text, 4000 by default and 8000 at most, or items of a list, 20 by default and 50 at most.";

const ALLOWED_READ: readonly string[] = ["resource", "offset", "limit"];
const ALLOWED_SEARCH: readonly string[] = ["query", "trigger_id", "limit", "include_ended"];
const ALLOWED_ROUTE: readonly string[] = ["decisions"];
const ROUTE_ITEM_FIELDS: readonly string[] = [
  "kind",
  "trigger_id",
  "ticket_id",
  "title",
  "worktree_name",
  "acknowledgement",
  "note",
  "reason",
  "answer",
  "question",
  "options",
  "clarification_id",
  "related_ticket_ids",
];
const ALLOWED_TICKET_ID: readonly string[] = ["ticket_id"];
const ALLOWED_TICKET_NOTE: readonly string[] = ["ticket_id", "text"];
const ALLOWED_TRIGGER_ID: readonly string[] = ["trigger_id"];
const ALLOWED_EVAL_READ: readonly string[] = [
  "trigger_id",
  "resource",
  "message_id",
  "cursor",
  "offset",
];
const ALLOWED_REPLY: readonly string[] = [
  "trigger_id",
  "ticket_id",
  "purpose",
  "human_action",
  "text",
];
const ALLOWED_THREAD: readonly string[] = ["thread"];
const ALLOWED_WECHAT_SEND_FILE: readonly string[] = ["path", "caption", "ticket_id"];
const ALLOWED_DEVICE_LIST: readonly string[] = ["tier", "status"];
const ALLOWED_DEVICE_INVOKE: readonly string[] = [
  "device_id",
  "action",
  "params",
  "timeout_ms",
  "reason",
];
const ALLOWED_DEVICE_APPROVE: readonly string[] = ["approval_id", "decision", "reason"];
const ALLOWED_DEVICE_RENAME: readonly string[] = ["device_id", "name"];
const ALLOWED_DEVICE_MCU_INSTALL: readonly string[] = [
  "mcu_id",
  "custom_name",
  "relay_device_id",
  "transport",
  "mqtt_broker",
  "serial_port",
  "baud_rate",
  "chip",
  "backup_relay_device_ids",
  "auto_deploy",
];
const ALLOWED_DEVICE_FILE_TRANSFER: readonly string[] = [
  "device_id",
  "direction",
  "remote_path",
  "local_path",
  "overwrite",
  "resume",
  "transfer_id",
  "chunk_size",
  "timeout_ms",
];
const ALLOWED_ACK: readonly string[] = ["trigger_id", "text"];
const ALLOWED_THREAD_REASON: readonly string[] = ["thread", "reason"];
const ALLOWED_HANDBACK: readonly string[] = ["trigger_id", "reason"];
const ALLOWED_REPORT: readonly string[] = [
  "state",
  "summary",
  "human_action",
  "question_for_trigger_id",
  "reply_to_trigger_id",
  "direct_reply",
  "topic",
];

const ROUTE_KINDS: ReadonlySet<string> = new Set([
  "accept",
  "attach",
  "sidecar",
  "clarify",
  "ignore",
  "stop",
]);

const CLARIFY_OPTION_ACTIONS: ReadonlySet<string> = new Set([
  "sidecar",
  "attach",
  "accept",
  "stop",
]);

const ITEM_CHECKS: ReadonlyArray<
  readonly [field: string, reads: ReadonlySet<string>, needs: ReadonlySet<string>]
> = [
  ["ticket_id", new Set(["attach", "sidecar", "stop"]), new Set(["attach", "sidecar", "stop"])],
  ["title", new Set(["accept"]), new Set(["accept"])],
  ["worktree_name", new Set(["accept"]), new Set(["accept"])],
  ["acknowledgement", new Set(["accept", "attach"]), new Set(["accept"])],
  ["note", new Set(["accept", "attach", "sidecar"]), new Set()],
  ["reason", new Set(["ignore", "stop", "clarify"]), new Set(["ignore", "clarify"])],
  ["answer", new Set(["ignore"]), new Set()],
  ["question", new Set(["clarify"]), new Set(["clarify"])],
  ["clarification_id", new Set(["accept", "attach", "sidecar", "stop"]), new Set()],
];

const LANGUAGE_FIELDS: readonly string[] = ["acknowledgement", "answer", "question"];

const REPORT_STATES: ReadonlySet<ReportState> = new Set([
  "progress",
  "ready",
  "blocked",
  "failed",
  "dropped",
]);

function spec(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[],
): ToolSpec {
  return {
    name,
    description,
    schema: {
      type: "object",
      properties,
      required: [...required],
      additionalProperties: false,
    },
  };
}

function acknowledgementError(text: string): string | null {
  if (wordCount(text) > IM_WORDS) {
    return `An acknowledgement has at most ${IM_WORDS} words (Chinese counts by character); write one short sentence.`;
  }
  return null;
}

function acknowledgement(text: string): string {
  const err = acknowledgementError(text);
  if (err !== null) {
    throw new Error(err);
  }
  return text.trim();
}

function directReplyText(text: string): string {
  if (wordCount(text) > IM_WORDS) {
    throw new Error(
      `direct_reply has at most ${IM_WORDS} words (Chinese counts by character); write a concise reply.`,
    );
  }
  return text.trim();
}

function readLimit(args: Args): number | undefined {
  const raw = args.get("limit");
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return Math.min(8000, Math.max(1, raw));
  }
  return undefined;
}

function readSpec(description: string, worker: boolean): ToolSpec {
  return spec(
    "orchestrator_read",
    `${description} Resources: ${grammar(worker)}.`,
    {
      resource: { type: "string", description: READ_RESOURCE },
      offset: { type: "integer", minimum: 0, description: READ_OFFSET },
      limit: { type: "integer", minimum: 1, maximum: 8000, description: READ_LIMIT },
    },
    ["resource"],
  );
}

function deviceSpecs(): ToolSpec[] {
  return [
    spec(
      "device_list",
      "List paired Tier 1 OS agents and Tier 2 MCUs with their custom display names, online status, routing path, and capabilities.",
      {
        tier: { type: ["string", "null"], enum: ["os", "mcu", null] },
        status: {
          type: ["string", "null"],
          enum: ["online", "offline", "sleeping", "unreachable_via_relay", null],
        },
      },
      [],
    ),
    spec(
      "device_invoke",
      "Invoke a capability or action on a paired Tier 1 OS agent (e.g. exec, fs.stat, fs.read, fs.write, fs.list, probe) or Tier 2 MCU. Accepts either device_id or a unique custom name. Risky actions return pending_approval with a short code. Use device_file_transfer for direct binary file pull/push.",
      {
        device_id: {
          type: "string",
          description: "Target device ID or unique custom display name.",
        },
        action: { type: "string" },
        params: { type: ["object", "null"] },
        timeout_ms: { type: ["integer", "null"], minimum: 100, maximum: 300000 },
        reason: { type: ["string", "null"] },
      },
      ["device_id", "action"],
    ),
    spec(
      "device_file_transfer",
      "Transfer a file directly between Master Neo local disk and a paired Tier 1 OS agent over the E2E-encrypted binary file channel (0xE3) with SHA-256 verification and resume support, without passing file bytes through model context. Accepts either device_id or a unique custom name. Use direction='pull' to download remote_path -> local_path (e.g. before wechat_send_file), or direction='push' to upload local_path -> remote_path.",
      {
        device_id: {
          type: "string",
          description: "Paired Tier 1 OS agent device ID or unique custom display name.",
        },
        direction: {
          type: "string",
          enum: ["pull", "push"],
          description: "'pull' downloads remote_path -> local_path; 'push' uploads local_path -> remote_path.",
        },
        remote_path: {
          type: "string",
          description: "File path on the Tier 1 device (strictly within its allowed workspaces).",
        },
        local_path: {
          type: "string",
          description: "Absolute file path on Master Neo (or relative to the current ticket directory for workers).",
        },
        overwrite: {
          type: ["boolean", "null"],
          description: "Overwrite destination file if it exists (default true).",
        },
        resume: {
          type: ["boolean", "null"],
          description: "Resume an interrupted transfer using the same transfer_id (default false).",
        },
        transfer_id: {
          type: ["string", "null"],
          description: "Optional ASCII transfer ID (required when resuming an existing partial transfer).",
        },
        chunk_size: {
          type: ["integer", "null"],
          minimum: 4096,
          maximum: 524288,
          description: "Binary chunk size in bytes (default 131072).",
        },
        timeout_ms: {
          type: ["integer", "null"],
          minimum: 1000,
          maximum: 600000,
          description: "Idle/transfer timeout in milliseconds (default 120000).",
        },
      },
      ["device_id", "direction", "remote_path", "local_path"],
    ),
    spec(
      "device_approve",
      "Approve or reject a pending high-risk device action by approval_id or shortCode.",
      {
        approval_id: { type: "string", description: "Approval ID or 6-character short code." },
        decision: { type: "string", enum: ["approve", "reject"] },
        reason: { type: ["string", "null"] },
      },
      ["approval_id", "decision"],
    ),
    spec(
      "device_rename",
      "Set or clear a user-defined custom display name for a paired device (Tier 1 OS agent or Tier 2 MCU) without changing its protocol device_id.",
      {
        device_id: {
          type: "string",
          description: "Target device ID or unique current custom display name.",
        },
        name: {
          type: ["string", "null"],
          description:
            "New custom display name (at most 64 characters), or null / empty string to clear and revert to device_id.",
        },
      },
      ["device_id", "name"],
    ),
    spec(
      "device_mcu_install",
      "Install and provision a Tier 2 MCU through a paired Tier 1 neo-agent-os gateway over MQTT or Serial (UART/RS485). Pre-registers the MCU twin, derives its cluster MCU E2E key, generates neo_mcu_config.h + install-mcu.sh, and pushes them onto the Tier 1 workspace when online.",
      {
        mcu_id: { type: "string", description: "Unique Tier 2 MCU device ID (e.g. mcu-esp32-rack01)." },
        custom_name: {
          type: ["string", "null"],
          description: "Optional user-defined display name for the MCU (at most 64 characters).",
        },
        relay_device_id: { type: "string", description: "Paired Tier 1 neo-agent-os gateway device ID." },
        transport: { type: "string", enum: ["mqtt", "serial"] },
        mqtt_broker: {
          type: ["string", "null"],
          description: "MQTT broker host:port on Tier 1 (e.g. 127.0.0.1:1883).",
        },
        serial_port: {
          type: ["string", "null"],
          description: "Serial/UART device path on Tier 1 (e.g. /dev/ttyUSB0).",
        },
        baud_rate: { type: ["integer", "null"], minimum: 1200, maximum: 4000000 },
        chip: { type: ["string", "null"], description: "Target MCU chip (e.g. esp32, esp32s3, stm32)." },
        backup_relay_device_ids: {
          type: ["array", "null"],
          items: { type: "string" },
          description: "Optional backup Tier 1 relay device IDs for failover.",
        },
        auto_deploy: {
          type: ["boolean", "null"],
          description: "Push provisioning bundle to Tier 1 via encrypted fs_write RPC when online (default true).",
        },
      },
      ["mcu_id", "relay_device_id", "transport"],
    ),
  ];
}

const cachedMainSpecsByFlag = new Map<string, ToolSpec[]>();
let cachedWorkerSpecs: ToolSpec[] | null = null;

/** The main Session's tools. */
export function mainSpecs(): ToolSpec[] {
  const cfg = recallConfig();
  const cacheKey = `${cfg.searchTool ? 1 : 0}:${cfg.clarify ? 1 : 0}`;
  const cached = cachedMainSpecsByFlag.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const routeKinds = cfg.clarify
    ? ["accept", "attach", "sidecar", "clarify", "ignore", "stop"]
    : ["accept", "attach", "sidecar", "ignore", "stop"];
  const specs: ToolSpec[] = [
    readSpec(
      "Read one page of a resource, such as the ticket list or a ticket. Follow next_offset, and next_resource where a page names one.",
      false,
    ),
    ...(cfg.searchTool
      ? [
          spec(
            "orchestrator_search",
            "Search historical tickets across titles, digests, origin requests, worktree names, deliverables, and report summaries (supports Chinese abbreviations and numeral disambiguation). Use only when a message references an older unlisted ticket or deliverable; pass trigger_id so access scope is enforced.",
            {
              query: {
                type: "string",
                description: "Core entity keywords or short phrase to search for.",
              },
              trigger_id: {
                type: ["string", "null"],
                description: "Current candidate trigger_id to enforce conversation access scope.",
              },
              limit: {
                type: "integer",
                minimum: 1,
                maximum: 20,
                description: "Maximum hits to return (default 8, max 20).",
              },
              include_ended: {
                type: "boolean",
                description: "Include ended historical tickets (default true).",
              },
            },
            ["query"],
          ),
        ]
      : []),
    spec(
      "orchestrator_route",
      "Route candidates, one item each by the card's trigger_id, in one call: accept an explicit request as a new ticket, attach follow-on work to an existing ticket (with an immediate acknowledgement), sidecar a read-only progress, summary or comparison question on a ticket (optionally with related_ticket_ids) without waking its worker, clarify an ambiguous explicit request with a short numbered choice (saving pending state for seamless follow-up), stop a ticket on a person's stop message, or ignore a candidate that needs no ticket or stop, as dispatch says. Items run in order and each is answered on its own; a refused item leaves the others. An inferred candidate may be ignored here; accepting one goes through orchestrator_eval_decide.",
      {
        decisions: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "trigger_id"],
            properties: {
              kind: { type: "string", enum: routeKinds },
              trigger_id: {
                type: "string",
                description: "The candidate card's trigger_id; deciding it decides its batch.",
              },
              ticket_id: {
                type: ["string", "null"],
                description: "attach, sidecar and stop: the ticket.",
              },
              related_ticket_ids: {
                type: ["array", "null"],
                maxItems: 3,
                items: { type: "string" },
                description:
                  "sidecar only: up to 3 additional related ticket ids from the same topic/split deliverables to inspect together read-only.",
              },
              title: {
                type: ["string", "null"],
                description:
                  "accept: a short label of at most 200 characters describing the original request; no added requirements or implementation advice.",
              },
              worktree_name: {
                type: ["string", "null"],
                description:
                  "accept: a meaningful short English ticket name, e.g. fix-plan-color. Translate other languages into English; 1–4 lowercase words in kebab-case (first word letters only, no digits in the first word), at most 32 characters.",
              },
              acknowledgement: {
                type: ["string", "null"],
                description: `accept (required) and attach (recommended): one brief sentence of at most ${IM_WORDS} words naming the concrete change and intended result, written in the language the person wrote in: a Chinese message gets a Chinese acknowledgement, never English. It is posted at once as a reply to the original message, so do not quote it.`,
              },
              note: {
                type: ["string", "null"],
                description: `accept, attach and sidecar: optional routing background or explicit human constraint, at most ${NOTE_WORDS} words. Never implementation instructions.`,
              },
              reason: {
                type: ["string", "null"],
                description: "ignore, clarify and stop: why, at most 500 characters; ignore and clarify require it.",
              },
              answer: {
                type: ["string", "null"],
                description:
                  "ignore only: for ordinary conversation that needs no ticket, the natural answer to send at once, in the language the person wrote in. Avoids another turn.",
              },
              question: {
                type: ["string", "null"],
                description: `clarify only (required): concise numbered disambiguation question of at most ${IM_WORDS} words (target 35-60 Chinese characters, never expose internal ticket_ids) in the person's language.`,
              },
              options: {
                type: ["array", "null"],
                maxItems: 4,
                description:
                  "clarify only: 0-4 structured candidate options saved for carry-over when the person replies with a number or confirmation.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["key", "label", "action"],
                  properties: {
                    key: { type: "string", description: 'Short option key such as "1", "2", "3", or "new".' },
                    label: { type: "string", description: "Short human label (e.g. MM-DD + short title)." },
                    action: { type: "string", enum: ["sidecar", "attach", "accept", "stop"] },
                    ticket_id: { type: ["string", "null"], description: "Target ticket_id when action is not accept." },
                  },
                },
              },
              clarification_id: {
                type: ["string", "null"],
                description:
                  "accept, attach, sidecar and stop: pass pending_clarification.id when the message answers an open clarification so the original request and attachments are carried over losslessly.",
              },
            },
          },
        },
      },
      ["decisions"],
    ),
    spec(
      "orchestrator_ticket_retry",
      "Start a new assignment on an explicit human request to retry a ticket whose worker reported failed or blocked, or whose input was not delivered; the stalled one ends.",
      { ticket_id: { type: "string" } },
      ["ticket_id"],
    ),
    spec(
      "orchestrator_ticket_request_status",
      "Ask the worker of an idle ticket, one whose turn ended without a report, for a status report; for other tickets it sends nothing and returns the card.",
      { ticket_id: { type: "string" } },
      ["ticket_id"],
    ),
    spec(
      "orchestrator_ticket_note",
      "Tell a ticket's worker a fact from other work, such as what another ticket found; it grants no authority.",
      {
        ticket_id: { type: "string" },
        text: { type: "string", description: `At most ${IM_WORDS} words.` },
      },
      ["ticket_id", "text"],
    ),
    spec(
      "orchestrator_trigger_requeue",
      "Queue a trigger for a fresh assessment; a follow-up that reached a ticket comes back only from its worker.",
      { trigger_id: { type: "string" } },
      ["trigger_id"],
    ),
    spec(
      "orchestrator_eval",
      "Load a proactive candidate's window and its thread's tickets.",
      { trigger_id: { type: "string" } },
      ["trigger_id"],
    ),
    spec(
      "orchestrator_eval_read",
      "Read more of a candidate's context, always with its trigger_id: a message whole by message_id, or a page of its thread by cursor.",
      {
        trigger_id: { type: "string", description: "The candidate's trigger_id." },
        resource: { type: "string", enum: ["message", "thread"] },
        message_id: {
          type: "string",
          description: "Only for message: omit for the trigger, or the id of a window message.",
        },
        cursor: {
          type: "string",
          description: "Only for thread: omit on the first page, then the next_cursor returned.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Text pagination: copy next_offset; keep the other arguments unchanged.",
        },
      },
      ["trigger_id", "resource"],
    ),
    spec(
      "orchestrator_eval_decide",
      "Record the decision of an assessment, as admission describes it, after orchestrator_eval with the same trigger_id.",
      {
        trigger_id: { type: "string" },
        decision: { type: "string", enum: ["accept", "ignore", "unavailable"] },
        rule_assessments: {
          type: "array",
          description: "One per enabled rule.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["rule_id", "matched", "reason"],
            properties: {
              rule_id: { type: "string" },
              matched: { type: "boolean" },
              reason: { type: "string" },
            },
          },
        },
        direction: {
          type: "object",
          description: "Required for every decision.",
          additionalProperties: false,
          required: [
            "implementation_requested",
            "target_basis",
            "requires_design_decision",
            "evidence",
          ],
          properties: {
            implementation_requested: { type: "boolean" },
            target_basis: {
              type: "string",
              enum: ["specified", "existing-standard", "undetermined"],
            },
            requires_design_decision: { type: "boolean" },
            evidence: { type: "string" },
          },
        },
        title: { type: "string" },
        worktree_name: { type: "string" },
        scope: { type: "string" },
        intent_evidence: {
          type: ["string", "null"],
          description: "For acceptance: the quotes that establish the three facts.",
        },
        acknowledgement: {
          type: ["string", "null"],
          description:
            "For acceptance: one sentence in the language the person wrote in; omit only when a matched rule asks for silence.",
        },
        reason: { type: "string" },
      },
      ["trigger_id", "decision", "rule_assessments", "direction", "title", "scope", "reason"],
    ),
    spec(
      "orchestrator_reply",
      "Send an answer to a human question, a ready result, or attention requiring human action, as the replies section says; the gate refuses anything else, such as progress.",
      {
        trigger_id: {
          type: ["string", "null"],
          description: "The original human question, for an answer only.",
        },
        ticket_id: { type: ["string", "null"] },
        purpose: { type: "string", enum: ["answer", "result", "attention"] },
        human_action: {
          type: ["string", "null"],
          description: "Required for attention: the ticket's current attention question.",
        },
        text: { type: "string" },
      },
      ["purpose", "text"],
    ),
    spec(
      "orchestrator_thread_unsubscribe",
      "Drop every ticket subscription on a thread; a new positive decision can subscribe it again.",
      { thread: { type: "string", description: "Thread key, such as chat:web:main." } },
      ["thread"],
    ),
    spec(
      "wechat_send_file",
      "Send a local image, video, or other file to the bound WeChat user. Use an absolute path produced or verified during this conversation; an optional caption is sent first, and ticket_id records the delivery for that ticket's report so it is not sent twice. Requires an active binding.",
      {
        path: { type: "string", description: "Absolute local file path." },
        caption: { type: "string" },
        ticket_id: {
          type: "string",
          description: "The ticket whose report this file delivers, when it delivers one.",
        },
      },
      ["path"],
    ),
    ...deviceSpecs(),
  ];
  cachedMainSpecsByFlag.set(cacheKey, specs);
  return specs;
}

/** A worker Session's tools. */
export function workerSpecs(): ToolSpec[] {
  if (cachedWorkerSpecs !== null) {
    return cachedWorkerSpecs;
  }
  cachedWorkerSpecs = [
    readSpec(
      "Read one page of a resource of this ticket. Follow next_offset, and next_resource where a page names one.",
      true,
    ),
    spec(
      "orchestrator_ack",
      "Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.",
      {
        trigger_id: { type: "string" },
        text: { type: "string", description: `At most ${IM_WORDS} words; Markdown is supported.` },
      },
      ["trigger_id", "text"],
    ),
    spec(
      "orchestrator_thread_unrelated",
      "Stop following an attached thread that is not about this ticket, as the work section says; its own thread cannot be dropped.",
      {
        thread: {
          type: "string",
          description: "The thread key, which trigger/<id> of one of its messages shows as thread.",
        },
        reason: {
          type: "string",
          description: "One sentence on why the thread is not about this ticket.",
        },
      },
      ["thread", "reason"],
    ),
    spec(
      "orchestrator_thread_follow",
      "Follow a related thread for context only.",
      {
        thread: { type: "string", description: "Thread key, <source>:<id>." },
        reason: { type: "string", description: "How it relates, in one sentence." },
      },
      ["thread", "reason"],
    ),
    spec(
      "orchestrator_trigger_handback",
      "Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket's to decide.",
      {
        trigger_id: { type: "string" },
        reason: {
          type: "string",
          description: "One sentence on what it asks for beyond this ticket.",
        },
      },
      ["trigger_id", "reason"],
    ),
    spec(
      "orchestrator_report",
      "Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.",
      {
        state: { type: "string", enum: ["progress", "ready", "blocked", "failed", "dropped"] },
        summary: { type: "string" },
        human_action: {
          type: ["string", "null"],
          description:
            "One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.",
        },
        question_for_trigger_id: {
          type: ["string", "null"],
          description:
            "With human_action: the human message that raised the question, which is asked where that person wrote.",
        },
        reply_to_trigger_id: {
          type: ["string", "null"],
          description:
            "The human message this report answers, including a no-work acknowledgement; never for routine progress.",
        },
        direct_reply: {
          type: ["string", "null"],
          description: `Default reply of at most ${IM_WORDS} words (Chinese counts by character) in the person's language, sent directly to their conversation: pass this on state=ready and whenever answering reply_to_trigger_id (including no-work follow-ups), unless a local file must be delivered over a WeChat conversation (thread starts with chat:wechat:).`,
        },
        topic: {
          type: ["string", "null"],
          description: `What this ticket is about, in one or two sentences of at most ${TOPIC_CHARS} characters: the subject, the files or area it touches and where it stands. Send it with the first report and whenever it changes.`,
        },
      },
      ["state", "summary"],
    ),
    ...deviceSpecs(),
  ];
  return cachedWorkerSpecs;
}

interface Routed {
  decision?: DecisionKind;
  reason: string;
  ticketId?: string;
  triggerIds: string[];
}

type RouteOutcome = { ok: true; routed: Routed } | { ok: false; refused: string };

function routed(
  app: AppContext,
  decision: DecisionKind | undefined,
  reason: string,
  ticketId: string | undefined,
): Record<string, unknown> {
  app.passes.pump();
  const result: Record<string, unknown> = { reason };
  if (decision !== undefined) {
    result.decision = decision;
  }
  if (ticketId !== undefined) {
    const ticket = app.storeTicket(ticketId);
    if (ticket !== null) {
      result.ticket = ticketCard(ticket);
    }
  }
  return result;
}

/** Why a routing item cannot run: a field its kind needs is missing, or one it reads breaks its limit. */
function invalidItem(item: Args, kind: string): string | null {
  for (let i = 0; i < ITEM_CHECKS.length; i++) {
    const [field, reads, needs] = ITEM_CHECKS[i];
    if (!reads.has(kind)) {
      continue;
    }
    const value = item.text(field);
    if (value === undefined) {
      if (needs.has(kind)) {
        return `${kind} needs ${field}`;
      }
      continue;
    }
    let problem: string | null = null;
    switch (field) {
      case "title":
        if (charCount(value) > 200) {
          problem = "at most 200 characters";
        }
        break;
      case "worktree_name":
        if (!validWorktreeName(value)) {
          problem = WORKTREE_NAME_RULE;
        }
        break;
      case "acknowledgement":
        problem = acknowledgementError(value);
        break;
      case "note":
        if (wordCount(value) > NOTE_WORDS) {
          problem = `Routing note must not exceed ${NOTE_WORDS} words. Shorten it; do not split it across deliveries.`;
        }
        break;
      case "reason":
        if (charCount(value) > 500) {
          problem = "at most 500 characters";
        }
        break;
      case "answer":
        if (charCount(value) > 20_000) {
          problem = "at most 20000 characters";
        }
        break;
      case "question": {
        const checked = checkedImText(value);
        if (!checked.ok) {
          problem = checked.error;
        }
        break;
      }
      case "clarification_id":
        if (charCount(value) > 200) {
          problem = "at most 200 characters";
        }
        break;
    }
    if (problem !== null) {
      return `${field}: ${problem}`;
    }
  }
  if (item.text("answer") !== undefined && kind !== "ignore") {
    return "answer is only valid with ignore";
  }
  if (item.text("question") !== undefined && kind !== "clarify") {
    return "question is only valid with clarify";
  }
  const rawOptions = item.get("options");
  if (rawOptions !== undefined && rawOptions !== null) {
    if (kind !== "clarify") {
      return "options is only valid with clarify";
    }
    if (!Array.isArray(rawOptions) || rawOptions.length > 4) {
      return "options must be an array of at most 4 items";
    }
    for (let i = 0; i < rawOptions.length; i++) {
      const entry = rawOptions[i];
      if (!isRecord(entry)) {
        return `options[${i}] must be an object`;
      }
      const keyVal = typeof entry.key === "string" ? entry.key.trim() : "";
      const labelVal = typeof entry.label === "string" ? entry.label.trim() : "";
      const actionVal = typeof entry.action === "string" ? entry.action : "";
      if (keyVal.length === 0 || charCount(keyVal) > 16) {
        return `options[${i}].key must be 1 to 16 characters`;
      }
      if (labelVal.length === 0 || charCount(labelVal) > 80) {
        return `options[${i}].label must be 1 to 80 characters`;
      }
      if (!CLARIFY_OPTION_ACTIONS.has(actionVal)) {
        return `options[${i}].action must be sidecar, attach, accept, or stop`;
      }
      const tid = entry.ticket_id;
      if (tid !== undefined && tid !== null && (typeof tid !== "string" || tid.trim().length === 0)) {
        return `options[${i}].ticket_id must be a non-empty string`;
      }
      if (actionVal !== "accept" && (typeof tid !== "string" || tid.trim().length === 0)) {
        return `options[${i}].ticket_id is required when action is ${actionVal}`;
      }
    }
  }
  const rawRelated = item.get("related_ticket_ids");
  if (rawRelated !== undefined && rawRelated !== null) {
    if (kind !== "sidecar") {
      return "related_ticket_ids is only valid with sidecar";
    }
    if (!Array.isArray(rawRelated) || rawRelated.length > 3) {
      return "related_ticket_ids must be an array of at most 3 ticket ids";
    }
    for (let i = 0; i < rawRelated.length; i++) {
      if (typeof rawRelated[i] !== "string" || rawRelated[i].trim().length === 0) {
        return `related_ticket_ids[${i}] must be a non-empty string`;
      }
    }
  }
  return null;
}

/** Why `text`, sent as `field` in reply to a trigger, is in another language than the person wrote in. */
export function wrongLanguage(
  app: AppContext,
  triggerId: string,
  field: string,
  text: string,
): string | null {
  const trigger = app.store.trigger(triggerId);
  if (trigger === undefined) {
    return null;
  }
  const problem = languageMismatch(trigger.text, text);
  return problem !== null ? `${field}: ${problem}` : null;
}

function fromDecision(decision: Decision): Routed {
  return {
    decision: decision.kind,
    reason: reasonText(decision.reason),
    ticketId: decision.ticketId,
    triggerIds: decision.triggerIds,
  };
}

function mergeUniqueIds(first: readonly string[], second: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const id = first[i];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (let i = 0; i < second.length; i++) {
    const id = second[i];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function parseClarificationOptions(raw: unknown): ClarificationOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ClarificationOption[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!isRecord(entry)) continue;
    const keyVal = typeof entry.key === "string" ? entry.key.trim() : "";
    const labelVal = typeof entry.label === "string" ? entry.label.trim() : "";
    const actionVal = entry.action as ClarificationOption["action"];
    const ticketId =
      typeof entry.ticket_id === "string" && entry.ticket_id.trim().length > 0
        ? entry.ticket_id.trim()
        : undefined;
    out.push({
      key: keyVal,
      label: sanitizeCardText(labelVal, 80),
      action: actionVal,
      ...(ticketId !== undefined ? { ticketId } : {}),
    });
  }
  return out;
}

/**
 * Carry out one routing decision as its Engine command. `decided` holds the Triggers this call's earlier items
 * decided, with their batches.
 */
function routeOne(
  app: AppContext,
  item: Args,
  kind: string,
  triggerId: string,
  decided: ReadonlyMap<string, string>,
): RouteOutcome {
  const note = item.text("note");
  const clarificationId = item.text("clarification_id");
  const cfg = recallConfig();
  const primary = app.store.trigger(triggerId);
  const primaryThread =
    primary !== undefined && primary.threads.length > 0 ? threadKey(primary.threads[0]) : undefined;

  if (kind === "ignore" || kind === "sidecar" || kind === "clarify") {
    const earlier = decided.get(triggerId);
    if (earlier !== undefined) {
      return {
        ok: false,
        refused: `Decided in this call with ${earlier}, whose Decision took its batch`,
      };
    }
  }
  switch (kind) {
    case "accept": {
      const before = app.store.disposition(triggerId)?.decisionId;
      const clarification: PendingClarification | undefined =
        clarificationId !== undefined && primaryThread !== undefined
          ? consumeClarification(app.store, primaryThread, clarificationId)
          : undefined;
      const title = item.text("title") ?? "";
      const ack = item.text("acknowledgement");
      const name = item.text("worktree_name");
      const accept: Accept = {
        title,
        scope: title,
        ...(ack !== undefined ? { acknowledgement: ack.trim() } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(note !== undefined ? { note } : {}),
      };
      const decision = app.engine.decide(
        triggerId,
        createOutcome({ kind: "accept", accept }, whyCode(reasonCode("explicitRouted"))),
      );
      // A Decision that created no ticket is the item's refusal; one that existed before keeps what it was accepted with.
      const ticketId = decision.kind === "accept" ? decision.ticketId : undefined;
      if (ticketId === undefined) {
        return {
          ok: false,
          refused: `Ticket was not created: ${reasonText(decision.reason)}`,
        };
      }
      if (clarification !== undefined) {
        const originSet = new Set(decision.triggerIds);
        for (let i = 0; i < clarification.originBatchIds.length; i++) {
          const origId = clarification.originBatchIds[i];
          if (!originSet.has(origId)) {
            app.quietly(() => {
              app.engine.attach(ticketId, origId, "Original request carried over from clarification");
            });
          }
        }
      } else if (primaryThread !== undefined) {
        clearClarification(app.store, primaryThread);
      }
      if (before !== undefined && decision.id === before) {
        return {
          ok: true,
          routed: {
            decision: "accept",
            reason: `Already accepted as ${ticketId}; title and acknowledgement unchanged`,
            ticketId,
            triggerIds: [],
          },
        };
      }
      return { ok: true, routed: fromDecision(decision) };
    }
    case "attach": {
      const ticketId = item.text("ticket_id") ?? "";
      const clarification: PendingClarification | undefined =
        clarificationId !== undefined && primaryThread !== undefined
          ? consumeClarification(app.store, primaryThread, clarificationId)
          : undefined;
      // A person's burst of chat messages held in one Eval goes to the ticket together.
      const candidate = app.engine.candidate(triggerId);
      let burst: string[];
      if (primary !== undefined && candidate !== undefined && primary.source === CHAT_SOURCE) {
        burst = [];
        for (let i = 0; i < candidate.triggers.length; i++) {
          const trigger = candidate.triggers[i];
          if (trigger.actor.id === primary.actor.id) {
            burst.push(trigger.id);
          }
        }
      } else {
        burst = [triggerId];
      }
      const currentTargets = burst.includes(triggerId) ? burst : [triggerId];
      const targets =
        clarification !== undefined
          ? mergeUniqueIds(clarification.originBatchIds, currentTargets)
          : currentTargets;
      let ticket: Ticket | undefined;
      for (let i = 0; i < targets.length; i++) {
        const id = targets[i];
        ticket = app.quietly(() =>
          app.engine.attach(ticketId, id, id === triggerId ? note : undefined),
        );
      }
      if (clarification === undefined && primaryThread !== undefined) {
        clearClarification(app.store, primaryThread);
      }
      const attached = ticket!;
      const ack = item.text("acknowledgement");
      if (ack !== undefined) {
        app.engine.reply({
          purpose: "acknowledgement",
          ticketId: attached.id,
          triggerId,
          text: ack.trim(),
        });
      }
      return {
        ok: true,
        routed: {
          reason: "Attached: the ticket follows the trigger's thread and receives the trigger",
          ticketId: attached.id,
          triggerIds: targets,
        },
      };
    }
    case "sidecar": {
      const ticketId = item.text("ticket_id") ?? "";
      const ticket = app.storeTicket(ticketId);
      if (ticket === null) {
        return { ok: false, refused: `Unknown ticket: ${ticketId}` };
      }
      if (primary === undefined) {
        return { ok: false, refused: `Unknown trigger: ${triggerId}` };
      }
      if (!canAccessTicket(app, primary, ticket, undefined, cfg.crossSurface)) {
        return { ok: false, refused: `Ticket ${ticketId} is not accessible from this conversation` };
      }
      const rawRelated = item.get("related_ticket_ids");
      const relatedIds: string[] = [];
      if (Array.isArray(rawRelated)) {
        const seen = new Set<string>([ticketId]);
        for (let i = 0; i < rawRelated.length && relatedIds.length < 3; i++) {
          const rid = typeof rawRelated[i] === "string" ? rawRelated[i].trim() : "";
          if (rid.length === 0 || seen.has(rid)) continue;
          const relTicket = app.storeTicket(rid);
          if (relTicket === null) {
            return { ok: false, refused: `Unknown related ticket: ${rid}` };
          }
          if (!canAccessTicket(app, primary, relTicket, undefined, cfg.crossSurface)) {
            return {
              ok: false,
              refused: `Related ticket ${rid} is not accessible from this conversation`,
            };
          }
          seen.add(rid);
          relatedIds.push(rid);
        }
      }
      const clarification: PendingClarification | undefined =
        clarificationId !== undefined && primaryThread !== undefined
          ? consumeClarification(app.store, primaryThread, clarificationId)
          : undefined;
      const decision = app.engine.decide(
        triggerId,
        createOutcome({ kind: "ignore" }, whyCode(reasonCode("sidecarRouted"))),
      );
      const batchIds =
        clarification !== undefined
          ? mergeUniqueIds(clarification.originBatchIds, decision.triggerIds)
          : decision.triggerIds;
      const payload: Record<string, unknown> = {
        ticketId,
        triggerId,
        batchIds,
      };
      if (note !== undefined) {
        payload.note = note;
      }
      if (relatedIds.length > 0) {
        payload.relatedTicketIds = relatedIds;
      }
      if (clarification !== undefined) {
        payload.clarificationContext = {
          question: clarification.question,
          answerTriggerId: triggerId,
        };
      } else if (primaryThread !== undefined) {
        bumpClarificationTurn(app.store, primaryThread);
      }
      app.effects.enqueue(SIDECAR, triggerId, payload);
      return {
        ok: true,
        routed: {
          decision: "ignore",
          reason: "Dispatched to read-only sidecar for immediate reply",
          ticketId,
          triggerIds: decision.triggerIds,
        },
      };
    }
    case "clarify": {
      if (!cfg.clarify) {
        return { ok: false, refused: "clarify routing is disabled by configuration" };
      }
      if (primary === undefined || primaryThread === undefined) {
        return { ok: false, refused: `Unknown trigger: ${triggerId}` };
      }
      const candidate = app.engine.candidate(triggerId);
      if (candidate !== undefined && candidate.strength !== "explicit") {
        return { ok: false, refused: "clarify is only allowed for explicit human requests" };
      }
      if (candidate === undefined && (!primary.human || primary.addressed === undefined)) {
        return { ok: false, refused: "clarify is only allowed for explicit human requests" };
      }
      const options = parseClarificationOptions(item.get("options"));
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        if (opt.ticketId !== undefined) {
          const target = app.storeTicket(opt.ticketId);
          if (target === null) {
            return { ok: false, refused: `Unknown option ticket_id: ${opt.ticketId}` };
          }
          if (!canAccessTicket(app, primary, target, undefined, cfg.crossSurface)) {
            return {
              ok: false,
              refused: `Option ticket ${opt.ticketId} is not accessible from this conversation`,
            };
          }
        }
      }
      const question = (item.text("question") ?? "").trim();
      const decision = app.engine.decide(
        triggerId,
        createOutcome({ kind: "ignore" }, whyCode(reasonCode("clarificationRequested"))),
      );
      const createdAt = nowIso();
      const expiresAt = formatIso(nowMs() + CLARIFICATION_TTL_MS);
      const rawOrigin =
        typeof primary.meta.originalText === "string" ? primary.meta.originalText : primary.text;
      const record: PendingClarification = {
        id: key(["clarify", primaryThread, triggerId, createdAt]),
        threadKey: primaryThread,
        originTriggerId: triggerId,
        originBatchIds: [...decision.triggerIds],
        originText: sanitizeCardText(rawOrigin, 600),
        question,
        options,
        createdAt,
        expiresAt,
        turnsSeen: 0,
      };
      saveClarification(app.store, record);
      app.engine.reply({
        purpose: "answer",
        triggerId,
        text: question,
      });
      return {
        ok: true,
        routed: {
          decision: "ignore",
          reason: `Clarification sent (${record.id})`,
          triggerIds: decision.triggerIds,
        },
      };
    }
    // Through the Engine, so only a person's message the gate admits with explicit strength stops a ticket.
    case "stop": {
      const reason = item.text("reason");
      const why = reason !== undefined ? whySaid(reason) : whyCode(reasonCode("humanStop"));
      const ticketId = item.text("ticket_id") ?? "";
      const decision = app.engine.decide(
        triggerId,
        createOutcome({ kind: "stop", ticketId }, why),
      );
      if (clarificationId !== undefined && primaryThread !== undefined) {
        consumeClarification(app.store, primaryThread, clarificationId);
      } else if (primaryThread !== undefined) {
        bumpClarificationTurn(app.store, primaryThread);
      }
      return { ok: true, routed: fromDecision(decision) };
    }
    default: {
      const decision = app.engine.decide(
        triggerId,
        createOutcome({ kind: "ignore" }, item.text("reason") ?? ""),
      );
      if (primaryThread !== undefined) {
        bumpClarificationTurn(app.store, primaryThread);
      }
      const answer = item.text("answer");
      if (answer !== undefined) {
        app.engine.reply({
          purpose: "answer",
          triggerId,
          text: answer.trim(),
        });
      }
      return { ok: true, routed: fromDecision(decision) };
    }
  }
}

function routeAll(app: AppContext, argumentsValue: unknown): Record<string, unknown> {
  const args = Args.of(argumentsValue, ALLOWED_ROUTE);
  const rawDecisions = args.get("decisions");
  if (!Array.isArray(rawDecisions)) {
    throw new Error("decisions is required: a list of 1 to 20 routing items");
  }
  if (rawDecisions.length === 0 || rawDecisions.length > 20) {
    throw new Error("decisions takes 1 to 20 routing items");
  }
  const decided = new Map<string, string>();
  const results: Record<string, unknown>[] = [];
  for (let i = 0; i < rawDecisions.length; i++) {
    const rawItem = rawDecisions[i];
    const kind = isRecord(rawItem) && typeof rawItem.kind === "string" ? rawItem.kind : "";
    const triggerId =
      isRecord(rawItem) && typeof rawItem.trigger_id === "string" ? rawItem.trigger_id : "";
    const head: Record<string, unknown> = { trigger_id: triggerId, kind };

    let outcome: RouteOutcome;
    let parsed: Args | undefined;
    let parseError: string | undefined;
    try {
      parsed = Args.of(rawItem, ROUTE_ITEM_FIELDS);
    } catch (error) {
      parseError = errorMessage(error);
    }

    if (parseError !== undefined) {
      outcome = { ok: false, refused: parseError };
    } else if (!ROUTE_KINDS.has(kind)) {
      outcome = { ok: false, refused: "kind is accept, attach, sidecar, clarify, ignore or stop" };
    } else if (triggerId.length === 0) {
      outcome = { ok: false, refused: "trigger_id is required" };
    } else {
      const item = parsed!;
      let problem = invalidItem(item, kind);
      if (problem === null) {
        for (let j = 0; j < LANGUAGE_FIELDS.length; j++) {
          const field = LANGUAGE_FIELDS[j];
          const text = item.text(field);
          if (text !== undefined) {
            const mismatch = wrongLanguage(app, triggerId, field, text);
            if (mismatch !== null) {
              problem = mismatch;
              break;
            }
          }
        }
      }
      if (problem !== null) {
        outcome = { ok: false, refused: problem };
      } else {
        // Each item is one Engine command, in a transaction of its own; one that is refused leaves the others.
        try {
          outcome = app.store.atomic(() => routeOne(app, item, kind, triggerId, decided));
        } catch (error) {
          outcome = { ok: false, refused: errorMessage(error) };
        }
      }
    }

    if (!outcome.ok) {
      head.refused = outcome.refused;
    } else {
      const itemResult = outcome.routed;
      for (let j = 0; j < itemResult.triggerIds.length; j++) {
        const id = itemResult.triggerIds[j];
        if (!decided.has(id)) {
          decided.set(id, triggerId);
        }
      }
      if (itemResult.decision !== undefined) {
        head.decision = itemResult.decision;
      }
      head.reason = itemResult.reason;
      if (itemResult.ticketId !== undefined) {
        const ticket = app.storeTicket(itemResult.ticketId);
        if (ticket !== null) {
          head.ticket = ticketCard(ticket);
        }
      }
    }
    results.push(head);
  }
  app.passes.pump();
  return { results };
}

async function runDeviceTool(
  app: AppContext,
  name: string,
  argumentsValue: unknown,
  ticketId?: string,
): Promise<{ handled: true; result: unknown } | { handled: false }> {
  switch (name) {
    case "device_list": {
      const args = Args.of(argumentsValue ?? {}, ALLOWED_DEVICE_LIST);
      const tier = args.text("tier") as DeviceTier | undefined;
      const status = args.text("status") as DeviceStatus | undefined;
      const devices = app.devices
        .listDevices()
        .filter((d) => (tier === undefined || d.tier === tier) && (status === undefined || d.status === status));
      return {
        handled: true,
        result: {
          config: app.devices.configView(),
          devices,
          approvals: app.devices.listApprovals("pending"),
        },
      };
    }
    case "device_invoke": {
      const args = Args.of(argumentsValue, ALLOWED_DEVICE_INVOKE);
      const rawTarget = args.required("device_id").trim();
      const action = args.required("action").trim();
      const rawParams = args.get("params");
      if (rawParams !== undefined && rawParams !== null && !isRecord(rawParams)) {
        throw new Error("params must be an object");
      }
      const rawTimeout = args.get("timeout_ms");
      let timeoutMs: number | undefined;
      if (rawTimeout !== undefined && rawTimeout !== null) {
        if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout < 100 || rawTimeout > 300_000) {
          throw new Error("timeout_ms must be an integer between 100 and 300000");
        }
        timeoutMs = rawTimeout;
      }
      let targetDeviceId = rawTarget;
      try {
        const resolved = app.devices.resolveDevice(rawTarget);
        if (resolved !== null) {
          targetDeviceId = resolved.deviceId;
        }
      } catch (error) {
        return {
          handled: true,
          result: {
            status: "rejected",
            deviceId: rawTarget,
            action,
            error: errorMessage(error),
          },
        };
      }
      const result = await app.devices.invoke(targetDeviceId, {
        action,
        params: isRecord(rawParams) ? rawParams : {},
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(args.text("reason") !== undefined ? { reason: args.text("reason") } : {}),
      });
      return { handled: true, result };
    }
    case "device_rename": {
      const args = Args.of(argumentsValue, ALLOWED_DEVICE_RENAME);
      const rawTarget = args.required("device_id").trim();
      const rawName = args.get("name");
      if (rawName !== null && typeof rawName !== "string") {
        throw new Error("name must be a string or null");
      }
      const resolved = app.devices.resolveDevice(rawTarget);
      if (resolved === null) {
        throw new Error(`Unknown device: ${rawTarget}`);
      }
      const device = app.devices.setDeviceName(resolved.deviceId, rawName);
      return { handled: true, result: { device } };
    }
    case "device_approve": {
      const args = Args.of(argumentsValue, ALLOWED_DEVICE_APPROVE);
      const approvalId = args.required("approval_id").trim();
      const decision = args.required("decision").trim();
      if (decision === "approve") {
        return { handled: true, result: await app.devices.approve(approvalId, "tool") };
      }
      if (decision === "reject") {
        const approval = app.devices.reject(approvalId, args.text("reason"), "tool");
        return { handled: true, result: { approval } };
      }
      throw new Error("decision must be approve or reject");
    }
    case "device_mcu_install": {
      const args = Args.of(argumentsValue, ALLOWED_DEVICE_MCU_INSTALL);
      const mcuId = args.required("mcu_id").trim();
      const relayDeviceId = args.required("relay_device_id").trim();
      const rawTransport = args.required("transport").trim();
      if (rawTransport !== "mqtt" && rawTransport !== "serial") {
        throw new Error("transport must be mqtt or serial");
      }
      const rawBaud = args.get("baud_rate");
      let baudRate: number | undefined;
      if (rawBaud !== undefined && rawBaud !== null) {
        if (typeof rawBaud !== "number" || !Number.isInteger(rawBaud) || rawBaud < 1200 || rawBaud > 4_000_000) {
          throw new Error("baud_rate must be an integer between 1200 and 4000000");
        }
        baudRate = rawBaud;
      }
      const rawBackups = args.get("backup_relay_device_ids");
      let backupRelayDeviceIds: string[] | undefined;
      if (rawBackups !== undefined && rawBackups !== null) {
        if (!Array.isArray(rawBackups) || !rawBackups.every((x) => typeof x === "string")) {
          throw new Error("backup_relay_device_ids must be an array of strings");
        }
        backupRelayDeviceIds = rawBackups;
      }
      const rawAutoDeploy = args.get("auto_deploy");
      if (rawAutoDeploy !== undefined && rawAutoDeploy !== null && typeof rawAutoDeploy !== "boolean") {
        throw new Error("auto_deploy must be a boolean");
      }
      const result = await app.devices.installMcuViaTier1({
        mcuId,
        ...(args.text("custom_name") !== undefined ? { customName: args.text("custom_name") } : {}),
        relayDeviceId,
        transport: rawTransport as McuTransportKind,
        ...(args.text("mqtt_broker") !== undefined ? { mqttBroker: args.text("mqtt_broker") } : {}),
        ...(args.text("serial_port") !== undefined ? { serialPort: args.text("serial_port") } : {}),
        ...(baudRate !== undefined ? { baudRate } : {}),
        ...(args.text("chip") !== undefined ? { chip: args.text("chip") } : {}),
        ...(backupRelayDeviceIds !== undefined ? { backupRelayDeviceIds } : {}),
        ...(typeof rawAutoDeploy === "boolean" ? { autoDeploy: rawAutoDeploy } : {}),
      });
      return { handled: true, result };
    }
    case "device_file_transfer": {
      const args = Args.of(argumentsValue, ALLOWED_DEVICE_FILE_TRANSFER);
      const rawTarget = args.required("device_id").trim();
      const resolved = app.devices.resolveDevice(rawTarget);
      const deviceId = resolved !== null ? resolved.deviceId : rawTarget;
      const direction = args.required("direction").trim();
      if (direction !== "pull" && direction !== "push") {
        throw new Error("direction must be pull or push");
      }
      const remotePath = args.required("remote_path").trim();
      const rawLocalPath = args.required("local_path").trim();
      let localPath = rawLocalPath;
      if (!path.isAbsolute(localPath)) {
        const ticketDir = ticketId !== undefined ? app.storeTicket(ticketId)?.execution?.directory : undefined;
        if (ticketDir) {
          localPath = path.resolve(ticketDir, localPath);
        } else {
          throw new Error("local_path must be an absolute path");
        }
      }
      const rawOverwrite = args.get("overwrite");
      if (rawOverwrite !== undefined && rawOverwrite !== null && typeof rawOverwrite !== "boolean") {
        throw new Error("overwrite must be a boolean");
      }
      const rawResume = args.get("resume");
      if (rawResume !== undefined && rawResume !== null && typeof rawResume !== "boolean") {
        throw new Error("resume must be a boolean");
      }
      const rawChunkSize = args.get("chunk_size");
      let chunkSize: number | undefined;
      if (rawChunkSize !== undefined && rawChunkSize !== null) {
        if (
          typeof rawChunkSize !== "number" ||
          !Number.isInteger(rawChunkSize) ||
          rawChunkSize < 4096 ||
          rawChunkSize > 524_288
        ) {
          throw new Error("chunk_size must be an integer between 4096 and 524288");
        }
        chunkSize = rawChunkSize;
      }
      const rawTimeout = args.get("timeout_ms");
      let timeoutMs: number | undefined;
      if (rawTimeout !== undefined && rawTimeout !== null) {
        if (
          typeof rawTimeout !== "number" ||
          !Number.isInteger(rawTimeout) ||
          rawTimeout < 1000 ||
          rawTimeout > 600_000
        ) {
          throw new Error("timeout_ms must be an integer between 1000 and 600000");
        }
        timeoutMs = rawTimeout;
      }
      const transferId = args.text("transfer_id");
      const shared = {
        deviceId,
        remotePath,
        localPath,
        ...(typeof rawOverwrite === "boolean" ? { overwrite: rawOverwrite } : {}),
        ...(typeof rawResume === "boolean" ? { resume: rawResume } : {}),
        ...(transferId !== undefined ? { transferId } : {}),
        ...(chunkSize !== undefined ? { chunkSize } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
      const result =
        direction === "pull"
          ? await app.devices.pullFile(shared)
          : await app.devices.pushFile(shared);
      return { handled: true, result };
    }
    default:
      return { handled: false };
  }
}

/** Run one of the main Session's tools. */
export async function mainTool(
  app: AppContext,
  name: string,
  argumentsValue: unknown,
): Promise<unknown> {
  const deviceHandled = await runDeviceTool(app, name, argumentsValue);
  if (deviceHandled.handled) {
    return deviceHandled.result;
  }
  switch (name) {
    case "orchestrator_read": {
      const args = Args.of(argumentsValue, ALLOWED_READ);
      return app.readResource(
        args.required("resource"),
        args.number("offset", 0, Number.MAX_SAFE_INTEGER),
        readLimit(args),
        undefined,
      );
    }
    case "orchestrator_search": {
      const cfg = recallConfig();
      if (!cfg.searchTool) {
        throw new Error("orchestrator_search is disabled by configuration");
      }
      const args = Args.of(argumentsValue, ALLOWED_SEARCH);
      const query = args.required("query").trim();
      const limit = args.number("limit", 8, 20);
      const rawIncludeEnded = args.get("include_ended");
      if (rawIncludeEnded !== undefined && typeof rawIncludeEnded !== "boolean") {
        throw new Error("include_ended must be a boolean");
      }
      const includeEnded = rawIncludeEnded ?? true;
      const triggerId = args.text("trigger_id");
      let allowedThreads: Set<string>;
      let currentThread: string | undefined;
      let revalidate: (ticketId: string) => boolean;
      if (triggerId !== undefined) {
        const trigger = app.store.trigger(triggerId);
        if (trigger === undefined) {
          throw new Error(`Unknown trigger: ${triggerId}`);
        }
        const scope = accessibleThreads(app, trigger, cfg.crossSurface);
        allowedThreads = scope.threads;
        currentThread = scope.primaryThread;
        revalidate = (ticketId: string) => {
          const stored = app.storeTicket(ticketId);
          return stored !== null && canAccessTicket(app, trigger, stored, undefined, cfg.crossSurface);
        };
      } else {
        allowedThreads = new Set(app.store.threads().map((t) => t.key));
        revalidate = (ticketId: string) => {
          const stored = app.storeTicket(ticketId);
          return stored !== null && app.policy().revalidate(stored.mandate);
        };
      }
      const states = includeEnded ? undefined : ["working", "working/queued", "idle", "person/answer", "person/retry"];
      const result = app.ensureSearchIndex().search({
        query,
        allowedThreads,
        ...(currentThread !== undefined ? { currentThread } : {}),
        ...(states !== undefined ? { states } : {}),
        revalidate,
        limit: Math.max(1, limit),
      });
      return {
        query,
        hits: result.hits,
        total: result.total,
        confidence: result.confidence,
      };
    }
    case "orchestrator_route":
      return routeAll(app, argumentsValue);
    case "orchestrator_ticket_retry": {
      const args = Args.of(argumentsValue, ALLOWED_TICKET_ID);
      const ticket = app.engine.retryTicket(args.required("ticket_id"));
      return routed(app, undefined, "Started a new assignment", ticket.id);
    }
    case "orchestrator_ticket_request_status": {
      const args = Args.of(argumentsValue, ALLOWED_TICKET_ID);
      const ticketId = args.required("ticket_id");
      const asked = app.engine.requestStatus(ticketId);
      return routed(
        app,
        undefined,
        asked
          ? "Asked the worker for a status report"
          : "The worker is not waiting; nothing was sent",
        ticketId,
      );
    }
    case "orchestrator_ticket_note": {
      const args = Args.of(argumentsValue, ALLOWED_TICKET_NOTE);
      const ticketId = args.required("ticket_id");
      const text = args.required("text").trim();
      if (wordCount(text) > IM_WORDS) {
        throw new Error(`At most ${IM_WORDS} words`);
      }
      app.engine.note(ticketId, text);
      return routed(app, undefined, "Noted for the worker", ticketId);
    }
    case "orchestrator_trigger_requeue": {
      const args = Args.of(argumentsValue, ALLOWED_TRIGGER_ID);
      const triggerId = args.required("trigger_id");
      // A follow-up that reached a ticket is its worker's to judge, which hands back what is not its own.
      const trigger = app.store.trigger(triggerId);
      const owners = trigger !== undefined ? followupOwners(trigger, app.store) : [];
      if (owners.length > 0) {
        throw UserError.with("workerDecides", { tickets: owners.join(", ") });
      }
      const queued = app.quietly(() => app.engine.reevaluate(triggerId));
      app.passes.pump();
      return { queued };
    }
    case "orchestrator_eval": {
      const args = Args.of(argumentsValue, ALLOWED_TRIGGER_ID);
      return app.evalContext(args.required("trigger_id"));
    }
    case "orchestrator_eval_read":
      return app.evalRead(Args.of(argumentsValue, ALLOWED_EVAL_READ));
    case "orchestrator_eval_decide": {
      if (!isRecord(argumentsValue)) {
        throw new Error("The arguments must be an object");
      }
      const rawTriggerId = argumentsValue.trigger_id;
      if (typeof rawTriggerId !== "string" || rawTriggerId.length === 0) {
        throw new Error("trigger_id is required");
      }
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(argumentsValue)) {
        if (k !== "trigger_id") {
          fields[k] = v;
        }
      }
      const [decision, reason, ticketId] = app.evalDecide(rawTriggerId, fields);
      return routed(app, decision, reason, ticketId);
    }
    case "orchestrator_reply": {
      const args = Args.of(argumentsValue, ALLOWED_REPLY);
      const rawPurpose = args.required("purpose");
      let purpose: Purpose;
      if (rawPurpose === "answer" || rawPurpose === "result" || rawPurpose === "attention") {
        purpose = rawPurpose;
      } else {
        throw new Error("purpose is answer, result or attention");
      }
      const text = args.required("text");
      if (charCount(text) > 20_000) {
        throw new Error("text has at most 20000 characters");
      }
      const ticketId = args.text("ticket_id");
      const triggerId = args.text("trigger_id");
      const humanAction = args.text("human_action");
      const request: ReplyRequest = {
        purpose,
        ...(ticketId !== undefined ? { ticketId } : {}),
        ...(triggerId !== undefined ? { triggerId } : {}),
        ...(humanAction !== undefined ? { question: humanAction.trim() } : {}),
        text,
      };
      const reply = app.engine.reply(request);
      await app.outbox.waitFor(reply.id);
      return { status: app.store.replyStatus(reply.id) ?? reply.status };
    }
    case "orchestrator_thread_unsubscribe": {
      const args = Args.of(argumentsValue, ALLOWED_THREAD);
      const thread = args.required("thread");
      const removed = app.quietly(() => app.engine.unsubscribe(thread));
      return { removed, thread };
    }
    case "wechat_send_file": {
      const args = Args.of(argumentsValue, ALLOWED_WECHAT_SEND_FILE);
      const filePath = args.required("path").trim();
      const caption = args.text("caption");
      if (caption !== undefined && charCount(caption) > 8000) {
        throw new Error("caption has at most 8000 characters");
      }
      return await app.wechatSendTicketFile(filePath, caption, args.text("ticket_id"));
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

/** Run one of a worker Session's tools. */
export async function workerTool(
  app: AppContext,
  ticketId: string,
  name: string,
  argumentsValue: unknown,
): Promise<unknown> {
  const deviceHandled = await runDeviceTool(app, name, argumentsValue, ticketId);
  if (deviceHandled.handled) {
    return deviceHandled.result;
  }
  switch (name) {
    case "orchestrator_read": {
      const args = Args.of(argumentsValue, ALLOWED_READ);
      return app.readResource(
        args.required("resource"),
        args.number("offset", 0, Number.MAX_SAFE_INTEGER),
        readLimit(args),
        ticketId,
      );
    }
    case "orchestrator_ack": {
      const args = Args.of(argumentsValue, ALLOWED_ACK);
      const triggerId = args.required("trigger_id");
      const text = acknowledgement(args.required("text"));
      const problem = wrongLanguage(app, triggerId, "text", text);
      if (problem !== null) {
        throw new Error(problem);
      }
      const reply = app.engine.reply({
        purpose: "acknowledgement",
        ticketId,
        triggerId,
        text,
      });
      if (reply.status !== "sent") {
        await app.outbox.waitFor(reply.id);
      }
      return {
        trigger_id: triggerId,
        acknowledgement: app.store.replyStatus(reply.id) ?? reply.status,
        reused: reply.reused,
      };
    }
    case "orchestrator_thread_unrelated": {
      const args = Args.of(argumentsValue, ALLOWED_THREAD_REASON);
      const thread = args.required("thread");
      const reason = clip(args.required("reason").trim(), 300);
      app.engine.markUnrelated(ticketId, thread, reason);
      return { removed: true, thread };
    }
    case "orchestrator_thread_follow": {
      const args = Args.of(argumentsValue, ALLOWED_THREAD_REASON);
      const thread = args.required("thread");
      const reason = clip(args.required("reason").trim(), 300);
      const colon = thread.indexOf(":");
      if (colon <= 0 || colon === thread.length - 1) {
        throw new Error("A thread key is <source>:<id>");
      }
      const source = thread.slice(0, colon);
      const id = thread.slice(colon + 1);
      const followed = app.store.atomic(() => {
        const added = app.engine.followForContext(ticketId, { source, id });
        if (added) {
          app.notify(threadFollowedNotice(ticketId, thread, reason));
        }
        return added;
      });
      return { followed, thread };
    }
    case "orchestrator_trigger_handback": {
      const args = Args.of(argumentsValue, ALLOWED_HANDBACK);
      const triggerId = args.required("trigger_id");
      const reason = clip(args.required("reason").trim(), 300);
      return { trigger_id: triggerId, queued: app.engine.handback(ticketId, triggerId, reason) };
    }
    case "orchestrator_report":
      return await workerReport(app, ticketId, Args.of(argumentsValue, ALLOWED_REPORT));
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

async function workerReport(
  app: AppContext,
  ticketId: string,
  args: Args,
): Promise<Record<string, unknown>> {
  const ticket = app.storeTicket(ticketId);
  if (ticket === null || !isTicketLive(ticket)) {
    throw new Error("Ticket ended; do not resume it");
  }
  const rawState = args.required("state");
  if (!REPORT_STATES.has(rawState as ReportState)) {
    throw new Error("state is progress, ready, blocked, failed or dropped");
  }
  const state = rawState as ReportState;

  let question: Question;
  const rawHumanAction = args.get("human_action");
  if (rawHumanAction === undefined) {
    question = { kind: "keep" };
  } else if (rawHumanAction === null) {
    question = { kind: "clear" };
  } else if (
    typeof rawHumanAction === "string" &&
    rawHumanAction.trim().length > 0 &&
    charCount(rawHumanAction.trim()) <= 1000
  ) {
    question = { kind: "ask", question: rawHumanAction.trim() };
  } else {
    throw new Error(
      "human_action is one concrete question of at most 1000 characters, or null to clear the pending one",
    );
  }

  const rawDirect = args.text("direct_reply");
  const direct = rawDirect !== undefined ? directReplyText(rawDirect) : undefined;
  if (direct !== undefined) {
    const targetTrigger =
      args.text("reply_to_trigger_id") ??
      (state === "ready" ? ticket.origin.triggerId : undefined);
    if (targetTrigger !== undefined) {
      const problem = wrongLanguage(app, targetTrigger, "direct_reply", direct);
      if (problem !== null) {
        throw new Error(problem);
      }
    }
  }

  // Scan deliverable artifacts outside the SQLite atomic transaction to avoid holding locks during filesystem I/O.
  const artifacts =
    state === "ready" && ticket.execution?.directory !== undefined
      ? collectArtifacts(ticket.execution.directory)
      : undefined;

  const askedBy = args.text("question_for_trigger_id");
  const answers = args.text("reply_to_trigger_id");
  const rawTopic = args.text("topic");
  const report: WorkerReport = {
    state,
    summary: args.required("summary"),
    question,
    ...(askedBy !== undefined ? { askedBy } : {}),
    ...(answers !== undefined ? { answers } : {}),
    // A long topic is cut, never a reason to refuse a report that may carry an answer.
    ...(rawTopic !== undefined ? { topic: clip(rawTopic.trim(), TOPIC_CHARS) } : {}),
    ...(artifacts !== undefined && artifacts.length > 0 ? { artifacts } : {}),
  };

  // The report, and either the direct reply or the relay to the main Session, are recorded together.
  const [result, directReplyId] = app.store.atomic(
    (): [Record<string, unknown>, string | undefined] => {
      const updated = app.engine.report(ticketId, report);
      let replyId: string | undefined;
      if (direct !== undefined && updated.attention === undefined) {
        if (report.answers !== undefined) {
          const reply = app.engine.reply({
            purpose: "answer",
            ticketId,
            triggerId: report.answers,
            text: direct,
          });
          replyId = reply.id;
        } else if (state === "ready" && updated.channels.length > 0) {
          const reply = app.engine.reply({
            purpose: "result",
            ticketId,
            text: direct,
          });
          replyId = reply.id;
        }
      }
      if (replyId !== undefined) {
        app.notify(
          receiptNotice({
            worker_direct_reply: {
              ticket_id: ticketId,
              state: rawState,
              reply: direct,
              note: "The person already has this reply; send nothing more for it.",
            },
          }),
        );
        return [{ reported: true, notification: "direct_outbox" }, replyId];
      }
      const relay = reportRelay(updated, report);
      const out: Record<string, unknown> = {
        reported: true,
        notification: relay !== undefined ? "orchestrator" : "internal_only",
      };
      if (relay !== undefined) {
        app.relay(relay);
      }
      if (updated.attention !== undefined) {
        out.attention = updated.attention;
      }
      return [out, undefined];
    },
  );

  if (directReplyId !== undefined) {
    await app.outbox.waitFor(directReplyId);
  }
  app.passes.pump();
  return result;
}
