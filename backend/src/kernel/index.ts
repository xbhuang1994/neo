/**
 * Neo kernel: persistent agent Sessions over the Antigravity CLI command-line runtime.
 *
 * A `Session` owns the transcript (`Journal`) and the delivery rules; a `Driver` owns one
 * runtime process and only runs the model.
 */

export {
  EventBroadcast,
  EventSubscription,
  GUARD_ALLOW,
  UnboundedChannel,
  errorMessage,
  guardBlock,
  isRecord,
  nowIso,
  nowMs,
  textBlock,
  textOf,
  uuid,
} from "./types.ts";
export type {
  Block,
  Deliver,
  Guard,
  JobKind,
  KernelEvent,
  KernelJob,
  Message,
  Role,
  ToolHost,
  ToolSpec,
} from "./types.ts";

export {
  CUSTOM_TYPE,
  Journal,
  VISIBLE_SOURCES,
  entryId,
  entryInputIds,
  entryRequestId,
  entrySource,
  entryTimestamp,
} from "./journal.ts";
export type {
  CustomMessageEntry,
  Entry,
  MessageEntry,
  Pending,
} from "./journal.ts";

export { Proc } from "./process.ts";
export type { Launch, Line } from "./process.ts";

export { Session } from "./session.ts";
export type { Driver, DriverEvent, Mode, Presentation } from "./session.ts";

export {
  AGENT,
  AntigravityDriver,
  HostServer,
  MCP_SERVER,
  PKG_VERSION,
  PLUGIN,
  TOOL_KINDS,
  agentFile,
  bridgeDir,
  effortOf,
  hooksFile,
  hostView,
  launch,
  listModels,
  mcpServerName,
  parseModels,
  relayHook,
  shellCommand,
  startHostServer,
  stripInjected,
} from "./antigravity.ts";
export type { AntigravityOptions, HookHandler } from "./antigravity.ts";
