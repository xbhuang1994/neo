//! Component health, shown in the app: each part reports its own entry.

/** A component's reported health state. */
export type ComponentState = "ready" | "waiting" | "error";

/** How a component is doing. */
export interface ComponentHealth {
  /** `ready`, `waiting` or `error`. */
  state: ComponentState;
  /** In words. */
  detail: string;
  /** When it was reported (canonical ISO-8601 `YYYY-MM-DDTHH:mm:ss.sssZ`). */
  at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Construct a `ready` component health entry. */
export function healthReady(detail: string, at: string = nowIso()): ComponentHealth {
  return { state: "ready", detail, at };
}

/** Construct a `waiting` component health entry. */
export function healthWaiting(detail: string, at: string = nowIso()): ComponentHealth {
  return { state: "waiting", detail, at };
}

/** Construct an `error` component health entry. */
export function healthError(detail: string, at: string = nowIso()): ComponentHealth {
  return { state: "error", detail, at };
}

/**
 * Every component's latest health, by name.
 * Also provides static constructors (`Health.ready`, `Health.waiting`, `Health.error`) matching Rust `Health`.
 */
export class Health {
  private readonly entries = new Map<string, ComponentHealth>();

  /** The component works. */
  static ready(detail: string, at?: string): ComponentHealth {
    return healthReady(detail, at);
  }

  /** The component waits for something outside it. */
  static waiting(detail: string, at?: string): ComponentHealth {
    return healthWaiting(detail, at);
  }

  /** The component fails. */
  static error(detail: string, at?: string): ComponentHealth {
    return healthError(detail, at);
  }

  /** Report a component's health. */
  set(name: string, health: ComponentHealth): void;
  set(name: string, state: ComponentState, detail: string, at?: string): void;
  set(name: string, healthOrState: ComponentHealth | ComponentState, detail?: string, at?: string): void {
    if (typeof healthOrState === "string") {
      this.entries.set(name, {
        state: healthOrState,
        detail: detail ?? "",
        at: at ?? nowIso(),
      });
    } else {
      this.entries.set(name, { ...healthOrState });
    }
  }

  /** Mark a component as `ready`. */
  ready(name: string, detail: string, at?: string): ComponentHealth {
    const entry = healthReady(detail, at);
    this.entries.set(name, entry);
    return { ...entry };
  }

  /** Mark a component as `waiting`. */
  waiting(name: string, detail: string, at?: string): ComponentHealth {
    const entry = healthWaiting(detail, at);
    this.entries.set(name, entry);
    return { ...entry };
  }

  /** Mark a component as `error`. */
  error(name: string, detail: string, at?: string): ComponentHealth {
    const entry = healthError(detail, at);
    this.entries.set(name, entry);
    return { ...entry };
  }

  /** A component's latest health. */
  get(name: string): ComponentHealth | undefined {
    const entry = this.entries.get(name);
    return entry ? { ...entry } : undefined;
  }

  /** Every entry, by name, sorted lexicographically (matching Rust `BTreeMap<String, Health>`). */
  snapshot(): Record<string, ComponentHealth> {
    const keys = Array.from(this.entries.keys()).sort();
    const out: Record<string, ComponentHealth> = {};
    for (const key of keys) {
      const entry = this.entries.get(key)!;
      out[key] = { ...entry };
    }
    return out;
  }

  /** Alias for {@link snapshot}, matching Rust `HealthBoard::all`. */
  all(): Record<string, ComponentHealth> {
    return this.snapshot();
  }
}

/** Alias for {@link Health}, matching Rust `HealthBoard`. */
export { Health as HealthBoard };
