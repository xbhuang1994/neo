/**
 * In-memory repository for tests and ephemeral engines; it matches the ordering of the SQLite store.
 */

import {
  isTicketLive,
  latestAssignment,
  type Decision,
  type Thread,
  type Ticket,
  type Trigger,
  type TriggerDisposition,
} from "./model.ts";
import type { Repositories } from "./ports.ts";

interface UndoEntry<T = unknown> {
  map: Map<string, T>;
  key: string;
  existed: boolean;
  prevValue: T | undefined;
}

/**
 * In-memory `Repositories` with O(1) lookups, insertion-order preservation, copy isolation,
 * and nested transactional rollback via an undo-log stack.
 */
export class MemoryRepositories implements Repositories {
  private readonly triggersMap = new Map<string, Trigger>();
  private readonly dispositionsMap = new Map<string, TriggerDisposition>();
  private readonly threadsMap = new Map<string, Thread>();
  private readonly ticketsMap = new Map<string, Ticket>();
  private readonly decisionsMap = new Map<string, Decision>();
  private readonly txStack: UndoEntry[][] = [];

  begin(): void {
    this.txStack.push([]);
  }

  commit(): void {
    const finished = this.txStack.pop();
    if (finished !== undefined && this.txStack.length > 0 && finished.length > 0) {
      const parent = this.txStack[this.txStack.length - 1];
      for (const entry of finished) {
        parent.push(entry);
      }
    }
  }

  rollback(): void {
    const entries = this.txStack.pop();
    if (entries === undefined) return;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.existed) {
        entry.map.set(entry.key, entry.prevValue);
      } else {
        entry.map.delete(entry.key);
      }
    }
  }

  private put<T>(map: Map<string, T>, key: string, value: T): void {
    if (this.txStack.length > 0) {
      const existed = map.has(key);
      this.txStack[this.txStack.length - 1].push({
        map: map as Map<string, unknown>,
        key,
        existed,
        prevValue: existed ? map.get(key) : undefined,
      });
    }
    map.set(key, structuredClone(value));
  }

  trigger(id: string): Trigger | undefined {
    const found = this.triggersMap.get(id);
    return found !== undefined ? structuredClone(found) : undefined;
  }

  saveTrigger(trigger: Trigger): void {
    this.put(this.triggersMap, trigger.id, trigger);
  }

  disposition(id: string): TriggerDisposition | undefined {
    const found = this.dispositionsMap.get(id);
    return found !== undefined ? structuredClone(found) : undefined;
  }

  saveDisposition(id: string, value: TriggerDisposition): void {
    this.put(this.dispositionsMap, id, value);
  }

  thread(key: string): Thread | undefined {
    const found = this.threadsMap.get(key);
    return found !== undefined ? structuredClone(found) : undefined;
  }

  saveThread(thread: Thread): void {
    this.put(this.threadsMap, thread.key, thread);
  }

  threads(): Thread[] {
    const out: Thread[] = [];
    for (const value of this.threadsMap.values()) {
      out.push(structuredClone(value));
    }
    return out;
  }

  activeThreads(): Thread[] {
    const out: Thread[] = [];
    for (const value of this.threadsMap.values()) {
      if (value.pending.length > 0 || value.evaluating !== undefined) {
        out.push(structuredClone(value));
      }
    }
    return out;
  }

  ticket(id: string): Ticket | undefined {
    const found = this.ticketsMap.get(id);
    return found !== undefined ? structuredClone(found) : undefined;
  }

  saveTicket(ticket: Ticket): void {
    this.put(this.ticketsMap, ticket.id, ticket);
  }

  tickets(): Ticket[] {
    const out: Ticket[] = [];
    for (const value of this.ticketsMap.values()) {
      out.push(structuredClone(value));
    }
    out.reverse();
    return out;
  }

  openTickets(): Ticket[] {
    const out: Ticket[] = [];
    for (const value of this.ticketsMap.values()) {
      if (isTicketLive(value)) {
        out.push(structuredClone(value));
      }
    }
    out.reverse();
    return out;
  }

  activeTickets(): Ticket[] {
    const out: Ticket[] = [];
    for (const value of this.ticketsMap.values()) {
      const latest = latestAssignment(value);
      if (
        value.undelivered.length > 0 ||
        (latest !== undefined && (latest.state === "pending" || latest.state === "running"))
      ) {
        out.push(structuredClone(value));
      }
    }
    out.reverse();
    return out;
  }

  decision(id: string): Decision | undefined {
    const found = this.decisionsMap.get(id);
    return found !== undefined ? structuredClone(found) : undefined;
  }

  saveDecision(decision: Decision): void {
    this.put(this.decisionsMap, decision.id, decision);
  }

  decisionsByThread(key: string): Decision[] {
    const out: Decision[] = [];
    for (const value of this.decisionsMap.values()) {
      if (value.threadKey === key) {
        out.push(structuredClone(value));
      }
    }
    return out;
  }
}

/** Alias for `MemoryRepositories`. */
export const MemoryStore = MemoryRepositories;
export type MemoryStore = MemoryRepositories;
