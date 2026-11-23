//! The Sidecar: a read-only answer about an existing ticket (its progress, findings or a comparison) on a one-off
//! Session, without waking or interrupting the ticket's worker.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { latestReport } from "../core/index.ts";
import { isRecord } from "../kernel/index.ts";
import { charCount, ticketCard } from "./cards.ts";
import type { AppContext, OnceTools } from "./context.ts";
import { Failure, SIDECAR } from "./effects.ts";
import { receiptNotice } from "./notices.ts";
import { sidecarPrompt } from "./prompts.ts";
import { IM_WORDS, checkedImText, clip, wordCount } from "./text.ts";

export const REPORT_EXCERPT_CHARS = 4000;
export const SUBDIRS_TO_LIST: readonly string[] = ["docs", "results", "out", "run"];
export const SIDECAR_MAX_ATTEMPTS = 3;

const SIDECAR_TIMEOUT_MS = 90_000;
const WHITESPACE_RUN = /\p{White_Space}+/gu;
const EDGE_WHITESPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  const lenA = a.length;
  const lenB = b.length;
  while (i < lenA && j < lenB) {
    const cpA = a.codePointAt(i)!;
    const cpB = b.codePointAt(j)!;
    if (cpA !== cpB) {
      return cpA < cpB ? -1 : 1;
    }
    i += cpA > 0xffff ? 2 : 1;
    j += cpB > 0xffff ? 2 : 1;
  }
  return lenA - lenB;
}

function isDirectory(dirPath: string): boolean {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function listDirNames(dir: string): Array<[string, boolean]> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: Array<[string, boolean]> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const name = entry.name;
    if (name.startsWith(".")) {
      continue;
    }
    const isDir = entry.isSymbolicLink()
      ? isDirectory(path.join(dir, name))
      : entry.isDirectory();
    found.push([name, isDir]);
  }
  found.sort((a, b) => {
    const cmp = compareCodePoints(a[0], b[0]);
    if (cmp !== 0) {
      return cmp;
    }
    return Number(a[1]) - Number(b[1]);
  });
  return found;
}

/** The files a person may ask about: the top of the ticket's directory and a few of its usual result folders. */
export function deliverables(directory: string): string[] {
  const top = listDirNames(directory);
  const files: string[] = [];
  const topDirs = new Set<string>();
  for (let i = 0; i < top.length; i++) {
    const [name, isDir] = top[i];
    if (isDir) {
      files.push(`${name}/`);
      topDirs.add(name);
    } else {
      files.push(name);
    }
  }
  for (let i = 0; i < SUBDIRS_TO_LIST.length; i++) {
    const sub = SUBDIRS_TO_LIST[i];
    if (!topDirs.has(sub)) {
      continue;
    }
    const children = listDirNames(path.join(directory, sub));
    const take = Math.min(12, children.length);
    for (let j = 0; j < take; j++) {
      const [name, isDir] = children[j];
      files.push(`${sub}/${name}${isDir ? "/" : ""}`);
    }
  }
  if (files.length > 40) {
    files.length = 40;
  }
  return files;
}

/** What to send when the model answered in text instead of calling its reply tool. */
export function fallbackReply(raw: string): string {
  const cleaned = raw.replace(EDGE_WHITESPACE, "").replace(WHITESPACE_RUN, " ");
  if (cleaned.length === 0) {
    return "当前工单暂无更多补充结论，请稍后再试。";
  }
  if (wordCount(cleaned) <= IM_WORDS) {
    return cleaned;
  }
  let keep = 240;
  while (keep > 20 && wordCount(`${clip(cleaned, keep)}…`) > IM_WORDS) {
    keep -= 10;
  }
  return `${clip(cleaned, keep)}…`;
}

/** Answer a person's read-only question about a ticket, straight to their conversation. */
export async function sidecarQueued(app: AppContext, payload: unknown): Promise<void> {
  if (app.closing() || app.paused()) {
    throw Failure.later("Sidecar is paused or stopping");
  }
  if (!isRecord(payload)) {
    return;
  }
  const ticketId = typeof payload.ticketId === "string" ? payload.ticketId : undefined;
  const triggerId = typeof payload.triggerId === "string" ? payload.triggerId : undefined;
  if (ticketId === undefined || triggerId === undefined) {
    return;
  }
  const ticket = app.storeTicket(ticketId);
  const trigger = app.store.trigger(triggerId);
  if (ticket === null || trigger === undefined) {
    return;
  }
  if (!trigger.human || trigger.channel === undefined) {
    return;
  }
  const attempts = app.store.effectAttempts(SIDECAR, triggerId) ?? 0;
  if (attempts >= SIDECAR_MAX_ATTEMPTS) {
    return;
  }

  const batch: string[] = Array.isArray(payload.batchIds)
    ? payload.batchIds.filter((id): id is string => typeof id === "string")
    : [];
  const ids = batch.length === 0 ? [triggerId] : batch;
  const questions: Array<{ trigger_id: string; at: string; text: string }> = [];
  for (let i = 0; i < ids.length; i++) {
    const item = app.store.trigger(ids[i]);
    if (item !== undefined) {
      questions.push({ trigger_id: item.id, at: item.at, text: item.text });
    }
  }

  const rawDir = ticket.execution?.directory;
  const directory = rawDir !== undefined && isDirectory(rawDir) ? rawDir : undefined;
  const report = latestReport(ticket);
  const packet: Record<string, unknown> = {
    questions,
    ticket: ticketCard(ticket),
    directory: directory ?? null,
    running_jobs: await app.runningJobs(ticketId),
    latest_report:
      report !== undefined
        ? {
            state: report.state,
            at: report.at,
            summary: clip(report.summary, REPORT_EXCERPT_CHARS),
            truncated: charCount(report.summary) > REPORT_EXCERPT_CHARS,
          }
        : null,
    workspace_files: directory !== undefined ? deliverables(directory) : [],
  };
  if (typeof payload.note === "string") {
    packet.routing_note = payload.note;
  }

  let replied: string | undefined;
  const answer = (text: string): string => {
    const reply = app.engine.reply({
      purpose: "answer",
      triggerId,
      text,
    });
    replied = text;
    return reply.id;
  };

  const tools: OnceTools = {
    specs: [
      {
        name: "sidecar_reply",
        description: `Send the concise read-only answer (at most ${IM_WORDS} words; each Chinese character counts as one word, max ${IM_WORDS} characters) directly to the person's conversation.`,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: {
              type: "string",
              description: `At most ${IM_WORDS} words (each Chinese character counts as one word); Markdown is supported.`,
            },
          },
        },
      },
    ],
    call: async (name: string, argumentsValue: unknown): Promise<unknown> => {
      if (name !== "sidecar_reply") {
        throw new Error(`Unknown tool ${name}`);
      }
      const rawText =
        isRecord(argumentsValue) && typeof argumentsValue.text === "string"
          ? argumentsValue.text.trim()
          : "";
      if (rawText.length === 0) {
        throw new Error("text is required");
      }
      const checked = checkedImText(rawText);
      if (!checked.ok) {
        throw new Error(checked.error);
      }
      return { sent: true, id: answer(rawText) };
    },
  };

  const cwd = directory ?? app.machine.stateDir;
  let said: string;
  try {
    said = await app.runOnce(
      "sidecar",
      cwd,
      sidecarPrompt(),
      JSON.stringify(packet),
      tools,
      SIDECAR_TIMEOUT_MS,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (app.closing() || app.paused()) {
      throw Failure.later(error);
    }
    if (attempts + 1 < SIDECAR_MAX_ATTEMPTS) {
      throw Failure.error(error);
    }
    const card = {
      kind: "sidecar_failed",
      ticket_id: ticket.id,
      trigger_id: triggerId,
      questions,
      error: clip(error, 400),
      note: "The read-only sidecar failed after retries. Answer concisely in the person's language from known ticket state (or explain briefly that live lookup failed) via orchestrator_reply with purpose=answer and trigger_id only (omit ticket_id).",
    };
    app.relay({ id: `sidecar-failed:${triggerId}`, text: JSON.stringify(card) });
    return;
  }

  let sent: string;
  if (replied !== undefined) {
    sent = replied;
  } else {
    const text = fallbackReply(said);
    try {
      answer(text);
    } catch (err) {
      throw Failure.from(err);
    }
    sent = text;
  }

  await app.outbox.sent();
  // The main Session hears of the answer without a turn of its own, so its memory of the conversation stays whole.
  app.notify(
    receiptNotice({
      sidecar_answered: {
        ticket_id: ticket.id,
        trigger_id: triggerId,
        answer: sent,
      },
    }),
  );
}
