/**
 * Neo Agent's extension for Oh My Pi, loaded with `omp --mode rpc --extension <this file>`.
 *
 * OMP's RPC mode has no command for two things the host needs, so this file adds them:
 *
 *  - a guard on every tool call: the host may refuse one, such as any call after its ticket ended;
 *  - control of background jobs: list them with their process ids, let finished ones go without waking the
 *    session, and cancel one.
 *
 * It talks to the host over frames RPC mode already has. The host sends a request as a prompt that starts with
 * SENTINEL, which the `input` hook consumes so the model never sees it. The shim answers with a status frame
 * (`extension_ui_request`, method `setStatus`, key STATUS_KEY). For the guard the shim asks first: an
 * `extension_ui_request` of method `input` whose title starts with GUARD_TITLE, which the host answers with
 * `ok` or `block:<reason>`.
 *
 * This is the only TypeScript in the project. It has no imports of its own beyond OMP's job manager.
 */
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";

const SENTINEL = "@@neo-shim@@";
const STATUS_KEY = "neo-shim";
const GUARD_TITLE = "neo-guard:";

interface Call { id: string; op: "ping" | "jobs" | "ack" | "cancel"; ids?: string[]; job?: string }
interface Job { id: string; type: string; label?: string; startTime?: number; ownerId?: string; progressText?: string; process?: { command?: string; pids?: () => readonly number[] } }
interface Context { ui: { setStatus(key: string, text: string): void; input(title: string): Promise<string | undefined> } }
interface Extensions { on(event: string, handler: (event: never, context: Context) => unknown): void }

function jobs(): unknown[] {
  const running = (AsyncJobManager.instance()?.getRunningJobs() ?? []) as Job[];
  return running.map(job => ({
    id: job.id, type: job.type, label: job.label ?? "", startTime: job.startTime ?? 0, ownerId: job.ownerId ?? "",
    progressText: job.progressText, command: job.process?.command, pids: job.process?.pids?.() ?? [],
  }));
}

function run(call: Call): unknown {
  const manager = AsyncJobManager.instance();
  switch (call.op) {
    case "ping": return { ready: true, jobs: !!manager };
    case "jobs": return jobs();
    case "ack": return manager?.acknowledgeDeliveries(call.ids ?? []) ?? 0;
    case "cancel": return manager?.cancel(call.job ?? "") ?? false;
  }
}

export default function neoShim(pi: Extensions): void {
  pi.on("input", ((event: { text: string }, context: Context) => {
    if (!event.text.startsWith(SENTINEL)) return undefined;
    let id = "";
    try {
      const call = JSON.parse(event.text.slice(SENTINEL.length)) as Call;
      id = call.id;
      context.ui.setStatus(STATUS_KEY, JSON.stringify({ id, result: run(call) }));
    } catch (error) {
      context.ui.setStatus(STATUS_KEY, JSON.stringify({ id, error: String(error) }));
    }
    return { handled: true };
  }) as never);

  pi.on("tool_call", (async (event: { toolName: string; input: unknown }, context: Context) => {
    const verdict = await context.ui.input(GUARD_TITLE + JSON.stringify({ tool: event.toolName, input: event.input }));
    if (verdict?.startsWith("block:")) return { block: true, reason: verdict.slice("block:".length) };
    return undefined;
  }) as never);
}
