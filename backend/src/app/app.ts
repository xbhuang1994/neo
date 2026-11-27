/**
 * The application: one value that owns the store, the Engine, the effect queue and every Session,
 * and wires the Engine's ports to them. Its behaviour lives in the modules that extend it
 * (`sessions`, `executor`, `tools`, `views`, `watchdog`, `wechat`, ...).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  Engine,
  key,
  nowIso,
  type Accept,
  type Assessor,
  type Assignment,
  type Candidate,
  type ChannelRef,
  type DecisionKind,
  type DomainEvent,
  type Executor,
  type OutboundMessage,
  type Policy,
  type Ticket,
  type Trigger,
} from "../core/index.ts";
import type { Entry, KernelEvent } from "../kernel/index.ts";
import { DeviceManager } from "../devices/index.ts";
import { Store } from "../store/index.ts";
import { AccountsState, type AccountsView, type LoginView } from "./accounts.ts";
import * as assessMod from "./assess.ts";
import * as blockedMod from "./blocked.ts";
import * as chatMod from "./chat.ts";
import {
  Args,
  DEFAULT_SIDECAR_SLOW_HINT_MS,
  defaultTimings,
  type AppContext,
  type ChatAttachment,
  type ChatInput,
  type ChatReceipt,
  type Loaded,
  type Machine,
  type ModelListEntry,
  type OnceTools,
  type Timings,
  type WeChatStatus,
  type WorkerJob,
} from "./context.ts";
import * as effectsMod from "./effects.ts";
import { Effects, Failure, type Handler } from "./effects.ts";
import * as executorMod from "./executor.ts";
import { ExecutorState } from "./executor.ts";
import { Health, HealthBoard } from "./health.ts";
import type { Kernels, ModelOption, SessionRole } from "./kernels.ts";
import { changedPaths, eventNotice, followupRelay, settingsNotice, type Notice, type Relay } from "./notices.ts";
import { Outbox, type Channels, type Sent } from "./outbox.ts";
import { Passes } from "./passes.ts";
import { policyEffects, policyVersion, SettingsPolicy, Sources } from "./policy.ts";
import { TicketSearchIndex, type TicketIndexInput } from "./recall.ts";
import * as resourcesMod from "./resources.ts";
import * as sessionsMod from "./sessions.ts";
import { SessionsState } from "./sessions.ts";
import { CHAT_SOURCE, cloneSettings, normalize, SettingsStore, validate, type Kernel, type Settings } from "./settings.ts";
import * as sidecarMod from "./sidecar.ts";
import * as toolsMod from "./tools.ts";
import * as viewsMod from "./views.ts";
import * as watchdogMod from "./watchdog.ts";
import { WatchdogState } from "./watchdog.ts";
import * as wechatMod from "./wechat.ts";
import { WeChatState } from "./wechat.ts";
import type { Account } from "./wechat_protocol.ts";
import * as wechatTypingMod from "./wechat_typing.ts";

export type { Machine, Timings };
export { defaultTimings };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The application. */
export class App implements AppContext {
  readonly machine: Machine;
  readonly store: Store;
  readonly board: HealthBoard;
  readonly effects: Effects;
  readonly engine: Engine;
  readonly outbox: Outbox;
  readonly passes: Passes;
  readonly kernels: Kernels;
  readonly masterId: string;

  readonly liveTickets: Set<string>;
  readonly jobsCache = new Map<string, { at: number; jobs: WorkerJob[] }>();
  readonly modelLists = new Map<Kernel, ModelListEntry>();
  readonly accounts: AccountsState;
  readonly stopController = new AbortController();
  readonly sidecarSlowHintMs: number;

  private currentSettings: Settings;
  private currentPolicy: Policy;
  private readonly sources = new Sources();
  private isClosing = false;
  private quietDepth = 0;
  private recallIndex: TicketSearchIndex | null = null;
  private readonly threadTicketMap = new Map<string, Set<string>>();
  private readonly ticketThreadMap = new Map<string, Set<string>>();

  readonly sessionsState: SessionsState;
  readonly executorState: ExecutorState;
  readonly watchdogState: WatchdogState;
  readonly wechatState: WeChatState;
  readonly devices: DeviceManager;

  get stopSignal(): AbortSignal {
    return this.stopController.signal;
  }

  private constructor(
    machine: Machine,
    store: Store,
    board: HealthBoard,
    kernels: Kernels,
    timings: Timings,
    masterId: string,
    initialSettings: Settings,
  ) {
    this.machine = machine;
    this.store = store;
    this.board = board;
    this.kernels = kernels;
    this.masterId = masterId;
    this.sidecarSlowHintMs = timings.sidecarSlowHintMs ?? DEFAULT_SIDECAR_SLOW_HINT_MS;
    this.currentSettings = initialSettings;
    this.currentPolicy = new SettingsPolicy(initialSettings, this.sources);
    this.liveTickets = new Set(store.openTickets().map((t) => t.id));

    this.effects = new Effects(store, board);

    const channels: Channels = {
      enabled: (source: string) => source === CHAT_SOURCE,
      allowed: (_channel: ChannelRef) => true,
      send: async (message: OutboundMessage): Promise<Sent> => {
        if (this.isClosing) return "waiting";
        return await this.chatSend(message);
      },
    };
    this.outbox = new Outbox(store, this.effects, channels, () => this.paused());

    const assessor: Assessor = {
      request: (candidate: Candidate) => {
        const first = candidate.triggers[0];
        if (first) {
          this.effects.enqueue(effectsMod.ASSESSMENT, candidate.evalId, { triggerId: first.id });
        }
      },
    };

    const executor: Executor = {
      start: (ticket: Ticket, assignment: Assignment) => {
        this.effects.enqueue(effectsMod.LAUNCH, assignment.id, {
          ticketId: ticket.id,
          assignmentId: assignment.id,
        });
      },
      deliver: (ticket: Ticket, _assignment: Assignment) => {
        this.effects.enqueue(effectsMod.DELIVERY, ticket.id, { ticketId: ticket.id });
      },
      stop: (ticket: Ticket, assignment: Assignment, reason: string) => {
        this.executorStop(ticket, assignment, reason);
      },
    };

    this.engine = new Engine({
      repo: store,
      policy: () => this.policy(),
      scope: this.sources,
      assessor,
      executor,
      outbox: this.outbox,
      prepareTicket: (ticket: Ticket, accept: Accept) => this.executorPrepare(ticket, accept),
      emit: (event: DomainEvent, at: string) => this.emitted(event, at),
    });

    const burstDelay = (trigger: Trigger): number => {
      if (trigger.source !== CHAT_SOURCE) return 0;
      if (trigger.meta.surface === "wechat") return timings.wechatBurstMs;
      return timings.webBurstMs;
    };
    this.passes = new Passes(this.engine, this.effects, board, burstDelay);

    this.sessionsState = new SessionsState({
      specsProvider: {
        mainSpecs: toolsMod.mainSpecs,
        workerSpecs: toolsMod.workerSpecs,
      },
    });
    this.executorState = new ExecutorState();
    this.watchdogState = new WatchdogState(timings.watchdog);
    this.wechatState = new WeChatState(machine.wechat);
    this.devices = new DeviceManager({ store, board, masterId });
    this.devices.initFromEnv();
    this.accounts = new AccountsState({
      onCredentialsChanged: () => {
        this.modelLists.delete("antigravity");
        if (!this.isClosing && this.kernels.unavailable("antigravity") === undefined) {
          void this.modelsKnown("antigravity");
        }
      },
    });
  }

  /** Open the application over the data directory. Nothing runs until `start()`. */
  static open(machine: Machine, kernels: Kernels, timings: Timings = defaultTimings()): App {
    try {
      fs.mkdirSync(machine.stateDir, { recursive: true });
    } catch (error) {
      throw new Error(`Cannot create ${machine.stateDir}: ${errorMessage(error)}`);
    }
    const store = Store.open(path.join(machine.stateDir, "orchestrator.sqlite"));
    const board = new HealthBoard();
    board.set("runtime", Health.waiting("Starting"));
    const existingMasterId = store.get<string>("master-id");
    const masterId = existingMasterId ?? `orchestrator-${key([machine.stateDir])}`;
    store.set("master-id", masterId);
    const current = new SettingsStore(store).current();
    return new App(machine, store, board, kernels, timings, masterId, current);
  }

  /** The settings in force. */
  settings(): Settings {
    return this.currentSettings;
  }

  /** The Policy the settings make. */
  policy(): Policy {
    return this.currentPolicy;
  }

  /** Processing is paused: nothing is assessed, launched or sent. */
  paused(): boolean {
    return this.currentSettings.paused;
  }

  /** The application is shutting down. */
  closing(): boolean {
    return this.isClosing;
  }

  /**
   * Save new settings, tell open tickets how a Policy change bears on them, and restart running Evals under it.
   * `source` says who saved them (`app`, `tool` or `internal`), and `block` which part, for the notice.
   */
  saveSettings(nextInput: Settings, source: string, block: string): Settings {
    const next = cloneSettings(nextInput);
    normalize(next);
    validate(next);
    const previous = this.currentSettings;
    if (JSON.stringify(previous) === JSON.stringify(next)) {
      return previous;
    }
    const from = policyVersion(previous);
    const to = policyVersion(next);
    const changed = changedPaths(previous, next);
    const previousPolicy = this.currentPolicy;
    const nextPolicy = new SettingsPolicy(next, this.sources);

    try {
      this.store.atomic(() => {
        new SettingsStore(this.store).save(next, source, to, nowIso());
        const effects = policyEffects(this.store.openTickets(), previous, next, this.sources);
        // The Engine reads the new Policy from here on, also inside this transaction.
        this.currentSettings = next;
        this.currentPolicy = nextPolicy;
        if (from !== to) {
          this.engine.policyChanged(from, to, effects);
        }
        this.notify(settingsNotice(block, changed));
      });
    } catch (error) {
      this.currentSettings = previous;
      this.currentPolicy = previousPolicy;
      throw error;
    }

    const blockedBefore = previous.executor.blockedCommands;
    const blockedAfter = next.executor.blockedCommands;
    if (
      blockedBefore.length !== blockedAfter.length ||
      blockedBefore.some((cmd, i) => cmd !== blockedAfter[i])
    ) {
      this.syncBlocked();
    }
    this.passes.pump();
    return next;
  }

  /** Make the stand-ins for blocked commands match the settings. */
  syncBlocked(): void {
    const result = blockedMod.sync(
      this.machine.stateDir,
      this.currentSettings.executor.blockedCommands,
      this.machine.program,
    );
    if (result.ok) {
      this.board.set("environment", Health.ready("Blocked commands are in place"));
    } else {
      this.board.set("environment", Health.error(result.error));
    }
  }

  /** Run an Engine command the main Session itself made, which needs no notice to it. */
  quietly<T>(run: () => T): T {
    this.quietDepth += 1;
    try {
      return run();
    } finally {
      this.quietDepth -= 1;
    }
  }

  /** Steer a message into the main Session, once per request id. */
  relay(relay: Relay): void {
    this.effects.enqueue(effectsMod.RELAY, relay.id, { text: relay.text });
  }

  /** Inject a notice into the main Session without waking it. */
  notify(notice: Notice): void {
    this.effects.enqueue(effectsMod.NOTICE, notice.name, { value: notice.value });
  }

  ticketIsLive(ticketId: string): boolean {
    return this.liveTickets.has(ticketId);
  }

  private emitted(event: DomainEvent, at: string): void {
    if (event.type === "ticketCreated" || event.type === "ticketResumed") {
      const ticketId = event.ticketId;
      this.store.afterCommit(() => {
        this.liveTickets.add(ticketId);
      });
    } else if (event.type === "ticketEnded") {
      const ticketId = event.ticketId;
      this.store.afterCommit(() => {
        this.liveTickets.delete(ticketId);
        this.jobsCache.delete(ticketId);
      });
    }

    if (this.quietDepth > 0) {
      return;
    }

    const notice = eventNotice(event, at, (id) => this.store.ticket(id));
    if (notice !== undefined) {
      this.notify(notice);
    }

    const followedTriggerId =
      event.type === "triggerReceived" ||
      event.type === "ticketResumed" ||
      event.type === "triggerFollowup"
        ? event.triggerId
        : undefined;
    if (followedTriggerId !== undefined) {
      const trigger = this.store.trigger(followedTriggerId);
      if (trigger !== undefined) {
        const relay = followupRelay(this.store, trigger);
        if (relay !== undefined) {
          this.relay(relay);
        }
      }
    }
  }

  /** Start everything: the main Session, interrupted work, the effect queue and the passes. */
  async start(): Promise<void> {
    const wrap = (run: (payload: unknown, effectKey: string) => Promise<void>): Handler => {
      return async (payload: unknown, effectKey: string): Promise<void> => {
        if (this.isClosing) {
          throw Failure.later("The application is stopping");
        }
        await run(payload, effectKey);
      };
    };
    const held = (most: number) => () => (this.isClosing || this.paused() ? 0 : most);

    this.effects.handle(
      effectsMod.RELAY,
      wrap((payload, effectKey) => this.relayQueued(payload, effectKey)),
      { ordered: true },
    );
    this.effects.handle(
      effectsMod.NOTICE,
      wrap((payload, effectKey) => this.noticeQueued(payload, effectKey)),
      { ordered: true },
    );
    this.effects.handle(
      effectsMod.ASSESSMENT,
      wrap((payload, effectKey) => this.assessmentQueued(payload, effectKey)),
      { limit: held(4) },
    );
    this.effects.handle(
      effectsMod.LAUNCH,
      wrap((payload) => this.launchQueued(payload)),
      {
        limit: () => (this.isClosing || this.paused() ? 0 : this.launchRoom()),
        retry: [5_000, 300_000],
      },
    );
    this.effects.handle(
      effectsMod.DELIVERY,
      wrap((payload) => this.deliverQueued(payload)),
      { limit: held(4), quiet: true },
    );
    this.effects.handle(
      effectsMod.SIDECAR,
      wrap((payload) => this.sidecarQueued(payload)),
      { limit: held(4) },
    );

    this.syncBlocked();
    this.reportKernels();
    // Pre-warm Antigravity's models list in the background so settings never waits.
    if (this.kernels.unavailable("antigravity") === undefined) {
      this.modelsKnown("antigravity");
    }
    if (this.kernels.unavailable(this.currentSettings.kernel) === undefined) {
      const main = await this.ensureOrchestrator();
      if (!this.paused() && !this.isClosing) {
        void main.session.warm().catch(() => {});
      }
    }
    if (this.isClosing) {
      return;
    }
    this.executorResume();
    this.passes.start();
    this.effects.start();
    this.watchdogStart();
    this.wechatStart();
    await this.devices.start();
    this.board.set("runtime", Health.ready("Ready"));
    this.passes.pump();
  }

  /** Stop in order: no new passes, every Session ended, running effects finished; waiting ones stay for the next start. */
  async stop(): Promise<void> {
    if (this.isClosing) {
      return;
    }
    this.isClosing = true;
    this.stopController.abort();
    this.accounts.dispose();
    await this.passes.stop();
    await this.watchdogStop();
    await this.wechatStop();
    await this.devices.stop();
    await this.stopAllSessions();
    await this.effects.drain();
    this.board.set("runtime", Health.waiting("Stopped"));
  }

  /** Close the underlying SQLite store handle once the application is no longer read. */
  close(): void {
    this.store.close();
  }

  // ---- Sessions ----

  storeTicket(ticketId: string): Ticket | null {
    return sessionsMod.storeTicket(this, ticketId);
  }

  session(sessionId: string): Loaded | null {
    return sessionsMod.session(this.sessionsState, sessionId);
  }

  ensureSession(
    sessionId: string,
    role: SessionRole,
    cwd: string,
    title: string,
    ticketId?: string,
    onEvent?: (loaded: Loaded, event: KernelEvent) => void | Promise<void>,
  ): Promise<Loaded> {
    return sessionsMod.ensureSession(this, this.sessionsState, sessionId, role, cwd, title, ticketId, onEvent);
  }

  ensureOrchestrator(): Promise<Loaded> {
    return sessionsMod.ensureOrchestrator(this, this.sessionsState);
  }

  stopSession(sessionId: string): Promise<void> {
    return sessionsMod.stopSession(this.sessionsState, sessionId);
  }

  stopAllSessions(): Promise<void> {
    return sessionsMod.stopAllSessions(this.sessionsState);
  }

  resetOrchestrator(): Promise<void> {
    return sessionsMod.resetOrchestrator(this, this.sessionsState);
  }

  reopenOrchestrator(): Promise<void> {
    return sessionsMod.reopenOrchestrator(this, this.sessionsState);
  }

  applyModels(): Promise<void> {
    return sessionsMod.applyModels(this, this.sessionsState);
  }

  relayQueued(payload: unknown, requestId: string): Promise<void> {
    return sessionsMod.relayQueued(this, this.sessionsState, payload, requestId);
  }

  noticeQueued(payload: unknown, name: string): Promise<void> {
    return sessionsMod.noticeQueued(this, this.sessionsState, payload, name);
  }

  presentChat(text: string, attachments: readonly ChatAttachment[], requestId: string, source: string): Promise<string> {
    return sessionsMod.presentChat(this, this.sessionsState, text, attachments, requestId, source);
  }

  publish(requestId: string, text: string): Promise<void> {
    return sessionsMod.publish(this, this.sessionsState, requestId, text);
  }

  chatTranscript(): Entry[] {
    return sessionsMod.chatTranscript(this, this.sessionsState);
  }

  workerTranscript(ticketId: string): Entry[] {
    return sessionsMod.workerTranscript(this, this.sessionsState, ticketId);
  }

  runOnce(
    role: SessionRole,
    cwd: string,
    prompt: string,
    message: string,
    tools: OnceTools,
    timeoutMs: number,
  ): Promise<string> {
    return sessionsMod.runOnce(this, role, cwd, prompt, message, tools, timeoutMs);
  }

  // ---- Chat ----

  receiveWeb(text: string, attachments: ChatAttachment[], messageId?: string): Promise<ChatReceipt> {
    return chatMod.receiveWeb(this, text, attachments, messageId);
  }

  receiveWeChat(
    messageId: string,
    userId: string,
    text: string,
    attachments: ChatAttachment[],
    at?: string,
  ): Promise<ChatReceipt> {
    return chatMod.receiveWeChat(this, messageId, userId, text, attachments, at);
  }

  receiveChat(input: ChatInput): Promise<ChatReceipt> {
    return chatMod.receiveChat(this, input);
  }

  chatSend(message: OutboundMessage): Promise<Sent> {
    return chatMod.chatSend(this, message);
  }

  // ---- Executor ----

  launchRoom(): number {
    return executorMod.launchRoom(this, this.executorState);
  }

  workersBusy(): boolean {
    return executorMod.workersBusy(this, this.executorState);
  }

  activeWorkers(): number {
    return executorMod.activeWorkers(this, this.executorState);
  }

  isWorkerActive(ticketId: string): boolean {
    return executorMod.isWorkerActive(this, this.executorState, ticketId);
  }

  busyTicketIds(): Set<string> {
    return executorMod.busyTicketIds(this, this.executorState);
  }

  executionRoot(): string {
    return executorMod.executionRoot(this);
  }

  executorPrepare(ticket: Ticket, accept: Accept): Ticket {
    return executorMod.executorPrepare(this, ticket, accept);
  }

  executorStop(ticket: Ticket, assignment: Assignment, reason: string): void {
    executorMod.executorStop(this, this.executorState, ticket, assignment, reason);
  }

  stopWorkerTicket(ticketId: string): Promise<unknown> {
    return executorMod.stopWorkerTicket(this, this.executorState, ticketId);
  }

  launchQueued(payload: unknown): Promise<void> {
    return executorMod.launchQueued(this, this.executorState, payload);
  }

  deliverQueued(payload: unknown): Promise<void> {
    return executorMod.deliverQueued(this, this.executorState, payload);
  }

  workerEvent(ticketId: string, loaded: Loaded, event: KernelEvent): Promise<void> {
    return executorMod.workerEvent(this, this.executorState, ticketId, loaded, event);
  }

  runningJobs(ticketId: string): Promise<WorkerJob[]> {
    return executorMod.runningJobs(this, this.executorState, ticketId);
  }

  cancelJob(ticketId: string, jobId: string, reason: string): Promise<boolean> {
    return executorMod.cancelJob(this, this.executorState, ticketId, jobId, reason);
  }

  interruptWorker(ticketId: string, reason: string): Promise<boolean> {
    return executorMod.interruptWorker(this, this.executorState, ticketId, reason);
  }

  executorResume(): void {
    executorMod.executorResume(this, this.executorState);
  }

  // ---- Resources, Assess, Sidecar ----

  ensureSearchIndex(): TicketSearchIndex {
    if (this.recallIndex !== null) {
      return this.recallIndex;
    }
    const index = new TicketSearchIndex();
    const tickets = this.store.tickets();
    const threads = this.store.threads();
    this.threadTicketMap.clear();
    this.ticketThreadMap.clear();
    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i];
      const set = new Set<string>(thread.subscriptions);
      this.threadTicketMap.set(thread.key, set);
      for (const tid of set) {
        let byTicket = this.ticketThreadMap.get(tid);
        if (byTicket === undefined) {
          byTicket = new Set<string>();
          this.ticketThreadMap.set(tid, byTicket);
        }
        byTicket.add(thread.key);
      }
    }
    const originIds = tickets.map((t) => t.origin.triggerId);
    const triggers = this.store.triggersByIds(originIds);
    const sentFiles = this.store.sentFilesByTicket();
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const origin = triggers.get(ticket.origin.triggerId);
      const asked =
        typeof origin?.meta.originalText === "string" ? origin.meta.originalText : origin?.text;
      const subscribed = this.ticketThreadMap.get(ticket.id);
      const ticketThreads =
        subscribed !== undefined && subscribed.size > 0
          ? Array.from(subscribed)
          : origin !== undefined
            ? origin.threads.map((ref) => `${ref.source}:${ref.id}`)
            : [];
      const mergedArtifacts = new Set<string>(ticket.artifacts ?? []);
      const historicalSent = sentFiles.get(ticket.id);
      if (historicalSent !== undefined) {
        for (const name of historicalSent) {
          mergedArtifacts.add(name);
        }
      }
      const entry: TicketIndexInput = {
        ticket,
        ...(asked !== undefined ? { asked } : {}),
        threads: ticketThreads,
        ...(mergedArtifacts.size > 0 ? { artifacts: Array.from(mergedArtifacts) } : {}),
      };
      index.upsert(entry);
    }

    this.store.onTicketSaved((ticket) => {
      const origin = this.store.trigger(ticket.origin.triggerId);
      const asked =
        typeof origin?.meta.originalText === "string" ? origin.meta.originalText : origin?.text;
      const subscribed = this.ticketThreadMap.get(ticket.id);
      const ticketThreads =
        subscribed !== undefined && subscribed.size > 0
          ? Array.from(subscribed)
          : origin !== undefined
            ? origin.threads.map((ref) => `${ref.source}:${ref.id}`)
            : [];
      index.upsert({
        ticket,
        ...(asked !== undefined ? { asked } : {}),
        threads: ticketThreads,
        ...(ticket.artifacts !== undefined && ticket.artifacts.length > 0
          ? { artifacts: ticket.artifacts }
          : {}),
      });
    });

    this.store.onThreadSaved((thread) => {
      const prev = this.threadTicketMap.get(thread.key) ?? new Set<string>();
      const next = new Set<string>(thread.subscriptions);
      const changed = new Set<string>();
      for (const tid of prev) {
        if (!next.has(tid)) changed.add(tid);
      }
      for (const tid of next) {
        if (!prev.has(tid)) changed.add(tid);
      }
      this.threadTicketMap.set(thread.key, next);
      for (const tid of changed) {
        let set = this.ticketThreadMap.get(tid);
        if (set === undefined) {
          set = new Set<string>();
          this.ticketThreadMap.set(tid, set);
        }
        if (next.has(tid)) {
          set.add(thread.key);
        } else {
          set.delete(thread.key);
        }
        if (!index.updateThreads(tid, Array.from(set))) {
          const ticket = this.store.ticket(tid);
          if (ticket !== null && ticket !== undefined) {
            const origin = this.store.trigger(ticket.origin.triggerId);
            const asked =
              typeof origin?.meta.originalText === "string" ? origin.meta.originalText : origin?.text;
            index.upsert({
              ticket,
              ...(asked !== undefined ? { asked } : {}),
              threads: Array.from(set),
              ...(ticket.artifacts !== undefined && ticket.artifacts.length > 0
                ? { artifacts: ticket.artifacts }
                : {}),
            });
          }
        }
      }
    });

    this.recallIndex = index;
    return index;
  }

  readResource(resource: string, offset: number, limit?: number, ticketId?: string): unknown {
    return resourcesMod.readResource(this, resource, offset, limit, ticketId);
  }

  candidateCard(candidate: Candidate): unknown {
    return assessMod.candidateCard(this, candidate);
  }

  assessmentQueued(payload: unknown, evalId: string): Promise<void> {
    return assessMod.assessmentQueued(this, payload, evalId);
  }

  evalContext(triggerId: string): unknown {
    return assessMod.evalContext(this, triggerId);
  }

  evalRead(args: Args): unknown {
    return assessMod.evalRead(this, args);
  }

  evalDecide(triggerId: string, fields: unknown): [DecisionKind, string, string | undefined] {
    return assessMod.evalDecide(this, triggerId, fields);
  }

  sidecarQueued(payload: unknown): Promise<void> {
    return sidecarMod.sidecarQueued(this, payload);
  }

  // ---- Tools ----

  wrongLanguage(triggerId: string, field: string, text: string): string | null {
    return toolsMod.wrongLanguage(this, triggerId, field, text);
  }

  mainTool(name: string, argumentsValue: unknown): Promise<unknown> {
    return toolsMod.mainTool(this, name, argumentsValue);
  }

  workerTool(ticketId: string, name: string, argumentsValue: unknown): Promise<unknown> {
    return toolsMod.workerTool(this, ticketId, name, argumentsValue);
  }

  // ---- Watchdog ----

  watchdogStart(): void {
    watchdogMod.watchdogStart(this, this.watchdogState);
  }

  watchdogStop(): Promise<void> {
    return watchdogMod.watchdogStop(this, this.watchdogState);
  }

  watchdogTick(): Promise<void> {
    return watchdogMod.watchdogTick(this, this.watchdogState);
  }

  watchdogInspect(ticketId: string): Promise<unknown> {
    return watchdogMod.watchdogInspect(this, this.watchdogState, ticketId);
  }

  watchdogIntervene(argumentsValue: unknown): Promise<unknown> {
    return watchdogMod.watchdogIntervene(this, this.watchdogState, argumentsValue);
  }

  // ---- WeChat & Typing ----

  wechatAccount(): Account | null {
    return wechatMod.wechatAccount(this);
  }

  wechatStatus(): WeChatStatus {
    return wechatMod.wechatStatus(this, this.wechatState);
  }

  wechatStart(): void {
    wechatMod.wechatStart(this, this.wechatState);
  }

  wechatStop(): Promise<void> {
    return wechatMod.wechatStop(this, this.wechatState);
  }

  wechatConnect(): Promise<WeChatStatus> {
    return wechatMod.wechatConnect(this, this.wechatState);
  }

  wechatVerify(code: string): WeChatStatus {
    return wechatMod.wechatVerify(this, this.wechatState, code);
  }

  wechatDisconnect(): Promise<WeChatStatus> {
    return wechatMod.wechatDisconnect(this, this.wechatState);
  }

  wechatDeliver(id: string, text: string, userId: string): Promise<Sent> {
    return wechatMod.wechatDeliver(this, this.wechatState, id, text, userId);
  }

  wechatSendFile(filePath: string, caption?: string): Promise<unknown> {
    return wechatMod.wechatSendFile(this, this.wechatState, filePath, caption);
  }

  wechatSendTicketFile(filePath: string, caption?: string, ticketId?: string): Promise<unknown> {
    return wechatMod.wechatSendTicketFile(this, this.wechatState, filePath, caption, ticketId);
  }

  routerThinking(): boolean {
    return wechatTypingMod.routerThinking(this);
  }

  agentsBusy(): boolean {
    return wechatTypingMod.agentsBusy(this);
  }

  // ---- Views & Accounts ----

  healthView(): unknown {
    return viewsMod.healthView(this);
  }

  activityView(): Promise<unknown> {
    return viewsMod.activityView(this);
  }

  panelMessages(): unknown[] {
    return viewsMod.panelMessages(this);
  }

  panelMessagesPage(options?: viewsMod.PanelMessagesPageOptions): viewsMod.PanelMessagesPageView {
    return viewsMod.panelMessagesPage(this, options);
  }

  workerCards(): Promise<unknown[]> {
    return viewsMod.workerCards(this);
  }

  workerCardsPage(options?: viewsMod.WorkerCardsPageOptions): Promise<viewsMod.WorkerCardsPageView> {
    return viewsMod.workerCardsPage(this, options);
  }

  workerDetail(ticketId: string): Promise<unknown | null> {
    return viewsMod.workerDetail(this, ticketId);
  }

  reportKernels(): void {
    viewsMod.reportKernels(this);
  }

  modelsKnown(kernel: Kernel): { ok: true; models: ModelOption[] } | { ok: false; error: string } | null {
    return viewsMod.modelsKnown(this, kernel);
  }

  modelsView(): Promise<unknown> {
    return viewsMod.modelsView(this);
  }

  updateModels(value: unknown): Promise<unknown> {
    return viewsMod.updateModels(this, value);
  }

  installKernel(value: unknown): Promise<unknown> {
    return viewsMod.installKernel(this, value);
  }

  accountsView(): Promise<AccountsView> {
    return this.accounts.accountsView(this.kernels);
  }

  loginView(): LoginView | null {
    return this.accounts.loginView();
  }

  startLogin(value: unknown): Promise<{ login: LoginView | null }> {
    return this.accounts.startLogin(this.kernels, value);
  }

  loginInput(value: unknown): Promise<{ login: LoginView | null }> {
    return this.accounts.loginInput(value);
  }

  cancelLogin(): void {
    this.accounts.cancelLogin();
  }

  logout(value: unknown): Promise<AccountsView> {
    return this.accounts.logout(this.kernels, value);
  }

  generalView(): unknown {
    return viewsMod.generalView(this);
  }

  updateGeneral(value: unknown): Promise<unknown> {
    return viewsMod.updateGeneral(this, value);
  }
}
