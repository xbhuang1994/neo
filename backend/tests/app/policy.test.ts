import { describe, expect, test } from "bun:test";
import {
  key,
  reasonWith,
  whyCode,
  whySaid,
  type Addressed,
  type Json,
  type Mandate,
  type MandateBasis,
  type Outcome,
  type ScopeResult,
  type SourceScope,
  type Strength,
  type Thread,
  type Ticket,
  type Trigger,
} from "../../src/core/index.ts";
import { Store } from "../../src/store/index.ts";
import {
  POLICY_REVISION,
  SettingsPolicy,
  Sources,
  assessmentOutcome,
  directionAllowed,
  parseAssessment,
  policyEffects,
  policyVersion,
  type Assessment,
} from "../../src/app/policy.ts";
import { policySection } from "../../src/app/prompts.ts";
import {
  CHAT_SOURCE,
  SETTINGS_REVISION_KEY,
  SETTINGS_VERSION_PREFIX,
  SettingsStore,
  WEB_SENDER,
  WEB_THREAD,
  allowChatSender,
  allowedSender,
  cloneSettings,
  defaultRoleModels,
  defaultSettings,
  disallowChatSender,
  limits,
  parseBlock,
  parseSettings,
  roleModels,
  validate,
  type Settings,
} from "../../src/app/settings.ts";

// ============================================================================
// Inline tests ported from neo-app/src/settings.rs
// ============================================================================

describe("settings (ported from neo-app/src/settings.rs)", () => {
  test("defaults_to_a_usable_configuration_with_the_local_sender_allowed", () => {
    const settings = parseSettings({});
    expect(settings).toEqual(defaultSettings());
    expect(settings.paused).toBe(false);
    expect(settings.kernel).toBe("antigravity");
    expect(settings.eval).toEqual({ mode: "observe", timeoutSeconds: 120 });
    expect(settings.executor.maxWorkers).toBe(3);
    expect(settings.policy.rules.map((rule) => rule.id)).toEqual(["copy", "visual"]);
    expect(allowedSender(settings, CHAT_SOURCE, "WEB:LOCAL")).toBeDefined();
    expect(allowedSender(settings, CHAT_SOURCE, "wechat:someone")).toBeUndefined();
    expect(roleModels(settings)).toEqual(defaultRoleModels());
  });

  test("refuses_unknown_keys_and_out_of_range_values_in_words", () => {
    const refused = (value: unknown): string => {
      try {
        parseSettings(value);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error(`Expected parseSettings to fail for ${JSON.stringify(value)}`);
    };

    expect(refused({ github: {} })).toContain("unknown field");
    expect(refused({ executor: { maxWorkers: 0 } })).toContain("1 to 16");
    expect(refused({ executor: { maxWorkers: 17 } })).toContain("1 to 16");
    expect(refused({ eval: { timeoutSeconds: 10 } })).toContain("30 to 600");
    expect(refused({ eval: { mode: "sometimes" } })).toContain("Invalid settings");
    expect(refused({ executor: { directory: "relative/path" } })).toContain("absolute");
    expect(refused({ executor: { blockedCommands: ["rm -rf"] } })).toContain("not a command name");
    expect(refused({ executor: { blockedCommands: [".."] } })).toContain("not a command name");
    expect(refused({ executor: { prepare: "x".repeat(4001) } })).toContain("4000");

    const rule = (id: string, name: string) => ({
      id,
      name,
      enabled: true,
      instruction: "Do it.",
    });
    expect(refused({ policy: { rules: [rule("a b", "A")] } })).toContain("Rule id");
    expect(refused({ policy: { rules: [rule("a", "A"), rule("a", "B")] } })).toContain(
      "Duplicate rule id a",
    );
    expect(refused({ policy: { rules: [rule("a", "   ")] } })).toContain("rule name");
    expect(refused({ policy: { sources: { chat: { allowed: [{ id: "someone" }] } } } })).toContain(
      "wechat:<id>",
    );
    expect(refused({ policy: { sources: { Chat: {} } } })).toContain("lowercase");
    expect(
      refused({
        policy: {
          sources: {
            chat: { admission: { row: { listedUnaddressed: "explicit" } } },
          },
        },
      }),
    ).toContain("cannot be an explicit request");
    expect(
      refused({
        models: { antigravity: { eval: { provider: " ", model: "m" } } },
      }),
    ).toContain("provider");
    expect(
      refused({
        models: {
          antigravity: {
            eval: { provider: "antigravity", model: "m", thinkingLevel: "high" },
          },
        },
      }),
    ).toContain("unknown field");
    expect(refused({ kernel: "gpt" })).toContain("Invalid settings");
    expect(refused({ workerKernel: "antigravity" })).toContain("unknown field");
  });

  test("keeps_models_and_trims_what_people_type", () => {
    const settings = parseSettings({
      kernel: "antigravity",
      models: {
        antigravity: {
          eval: { provider: " antigravity ", model: " gemini-3.8-flash-low " },
          executor: { provider: " antigravity ", model: " gemini-3.8-pro-high " },
        },
      },
      executor: {
        directory: "  ",
        prepareShell: " pwsh ",
        blockedCommands: ["docker", "kubectl.exe"],
      },
      policy: {
        sources: {
          chat: {
            allowed: [
              { id: " web:local ", name: "  " },
              { id: "wechat:abc@im.wechat", name: " Me " },
            ],
          },
        },
      },
    });
    expect(roleModels(settings).eval?.model).toBe("gemini-3.8-flash-low");
    expect(roleModels(settings).executor?.model).toBe("gemini-3.8-pro-high");
    expect(settings.executor.directory).toBe("");
    expect(settings.executor.prepareShell).toBe("pwsh");
    const allowed = settings.policy.sources[CHAT_SOURCE].allowed;
    expect(allowed[0]).toEqual({ id: "web:local" });
    expect("name" in allowed[0]).toBe(false);
    expect(allowed[1].name).toBe("Me");
    // What is stored reads back the same.
    expect(parseSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });

  test("reads_settings_saved_with_an_advisor_model_and_drops_it", () => {
    const saved = {
      models: {
        antigravity: {
          eval: null,
          executor: { provider: "antigravity", model: "m" },
          advisor: { provider: "antigravity", model: "big" },
        },
      },
    };
    const settings = parseSettings(saved);
    expect(settings.models.antigravity).toEqual({
      eval: null,
      executor: { provider: "antigravity", model: "m" },
    });
    expect(JSON.parse(JSON.stringify(settings.models.antigravity))).toEqual({
      eval: null,
      executor: { provider: "antigravity", model: "m" },
    });
  });

  test("adds_and_removes_a_bound_chat_sender_once", () => {
    const settings = defaultSettings();
    expect(allowChatSender(settings, "wechat:abc")).toBe(true);
    expect(allowChatSender(settings, "wechat:ABC")).toBe(false);
    expect(settings.policy.sources[CHAT_SOURCE].allowed.length).toBe(2);
    expect(() => validate(settings)).not.toThrow();
    expect(disallowChatSender(settings, "wechat:abc")).toBe(true);
    expect(disallowChatSender(settings, "wechat:abc")).toBe(false);
    expect(settings).toEqual(defaultSettings());
  });

  test("saves_numbered_revisions_and_reads_the_latest_as_current", () => {
    const store = Store.memory();
    try {
      const stored = new SettingsStore(store);
      expect(stored.revision()).toBe(0);
      expect(stored.current()).toEqual(defaultSettings());
      const settings = defaultSettings();
      settings.executor.maxWorkers = 5;
      const first = stored.save(settings, "app", "v1", "2026-01-01T00:00:00.000Z");
      settings.paused = true;
      const second = stored.save(settings, "tool", "v1", "2026-01-01T00:01:00.000Z");
      expect([first.revision, second.revision, stored.revision()]).toEqual([1, 2, 2]);
      expect(stored.current()).toEqual(settings);
      expect(stored.history(10).map((version) => [version.revision, version.source])).toEqual([
        [2, "tool"],
        [1, "app"],
      ]);
      expect(stored.history(1).length).toBe(1);
      // An invalid save changes nothing.
      settings.executor.maxWorkers = 99;
      expect(() => stored.save(settings, "app", "v1", "t")).toThrow("1 to 16");
      expect(stored.revision()).toBe(2);
      expect(stored.current().executor.maxWorkers).toBe(5);
    } finally {
      store.close();
    }
  });

  test("reads_legacy_stored_settings_with_removed_kernels_and_fields", () => {
    const store = Store.memory();
    try {
      store.set(SETTINGS_REVISION_KEY, 1);
      store.set(`${SETTINGS_VERSION_PREFIX}1`, {
        revision: 1,
        savedAt: "2026-11-20T00:00:00.000Z",
        source: "app",
        policyVersion: "v1",
        settings: {
          paused: false,
          kernel: "omp",
          workerKernel: "claude",
          providers: [
            {
              id: "p",
              name: "P",
              api: "openai-completions",
              baseUrl: "https://example.test",
              models: [],
            },
          ],
          executor: { maxWorkers: 5 },
          models: {
            omp: { eval: { provider: "p", model: "m1", thinkingLevel: "high" } },
            claude: { executor: { provider: "anthropic", model: "sonnet" } },
            hermes: { eval: { provider: "hermes", model: "m2" } },
            antigravity: {
              eval: {
                provider: "antigravity",
                model: "gemini-3.8-flash-low",
                thinkingLevel: "low",
              },
              executor: { provider: "antigravity", model: "gemini-3.8-pro-high" },
              advisor: { provider: "antigravity", model: "big" },
            },
          },
        },
      });
      const stored = new SettingsStore(store);
      const current = stored.current();
      expect(current.kernel).toBe("antigravity");
      expect(current.executor.maxWorkers).toBe(5);
      expect(Object.keys(current.models).length).toBe(1);
      expect(roleModels(current).eval).toEqual({
        provider: "antigravity",
        model: "gemini-3.8-flash-low",
      });
      expect(roleModels(current).executor).toEqual({
        provider: "antigravity",
        model: "gemini-3.8-pro-high",
      });
      expect(() => validate(current)).not.toThrow();
      const history = stored.history(10);
      expect(history.length).toBe(1);
      expect(history[0].settings).toEqual(current);
    } finally {
      store.close();
    }
  });
});

// ============================================================================
// Integration tests ported from neo-app/tests/policy.rs
// ============================================================================

/** A Source that observes every message of its rooms, to exercise unaddressed messages and admission rows. */
class Rooms implements SourceScope {
  private readonly inner = new Sources();

  scope(source: string, meta: Json): ScopeResult {
    if (Object.prototype.hasOwnProperty.call(meta, "left")) {
      return { kind: "ignored", reason: "room_left" };
    }
    if (source === "room") {
      const room = typeof meta.room === "string" ? meta.room : undefined;
      return {
        kind: "listened",
        observed: true,
        ...(room !== undefined ? { row: room } : {}),
        fanout: true,
      };
    }
    return this.inner.scope(source, meta);
  }
}

const ROOMS: SourceScope = new Rooms();

function parse(value: unknown): Settings {
  return parseSettings(value);
}

function makePolicy(settings: Settings): SettingsPolicy {
  return new SettingsPolicy(settings, ROOMS);
}

function chatTrigger(sender: string): Trigger {
  return {
    id: `g-${sender}`,
    source: CHAT_SOURCE,
    threads: [{ source: CHAT_SOURCE, id: WEB_THREAD }],
    actor: { source: CHAT_SOURCE, id: sender },
    human: true,
    addressed: "direct",
    at: "2026-01-01T00:00:00.000Z",
    text: "fix the typo",
    meta: {},
  };
}

function roomTrigger(sender: string, addressed: Addressed | undefined, human: boolean): Trigger {
  const trigger = chatTrigger(sender);
  trigger.source = "room";
  trigger.actor.source = "room";
  trigger.threads = [{ source: "room", id: "r1" }];
  if (addressed !== undefined) {
    trigger.addressed = addressed;
  } else {
    delete trigger.addressed;
  }
  trigger.human = human;
  trigger.meta.room = "r1";
  return trigger;
}

function makeThread(subscriptions: readonly string[], context: readonly string[]): Thread {
  const t: Thread = {
    key: "room:r1",
    ref: { source: "room", id: "r1" },
    createdAt: "t",
    subscriptions: [...subscriptions],
    correlated: [],
    pending: [],
    meta: {},
  };
  if (context.length > 0) {
    t.context = [...context];
  }
  return t;
}

type GateOutcome =
  | { ok: true; strength: Strength; basis: MandateBasis }
  | { ok: false; reason: string };

function runGate(settings: Settings, trigger: Trigger, thread: Thread): GateOutcome {
  const result = makePolicy(settings).gate(trigger, thread, []);
  if (result.kind === "admissible") {
    return { ok: true, strength: result.strength, basis: result.basis };
  }
  return { ok: false, reason: result.reason };
}

function makeMandate(
  settings: Settings,
  trigger: Trigger,
  thread: Thread,
  rules?: readonly string[],
): Mandate {
  const result = runGate(settings, trigger, thread);
  if (!result.ok) {
    throw new Error(`Expected the gate to admit trigger, got ${result.reason}`);
  }
  const basis: MandateBasis =
    rules !== undefined ? { ...result.basis, rules: [...rules] } : result.basis;
  return {
    strength: result.strength,
    policyVersion: policyVersion(settings),
    basis,
    actor: { ...trigger.actor },
    scope: "small",
  };
}

function roomSettings(extra: { admission?: unknown; mode?: unknown } = {}): Settings {
  const roomPolicy: Record<string, unknown> = {
    allowed: [{ id: "alice", name: "Alice" }],
    bots: [{ id: "ci-bot" }],
  };
  if (extra.admission !== undefined) {
    roomPolicy.admission = extra.admission;
  }
  return parse({
    eval: { mode: extra.mode ?? "auto" },
    policy: {
      sources: {
        chat: { allowed: [{ id: "web:local" }] },
        room: roomPolicy,
      },
    },
  });
}

function makeAssessment(matched: boolean, decision: string): Assessment {
  return parseAssessment({
    decision,
    direction: {
      implementation_requested: true,
      target_basis: "specified",
      requires_design_decision: false,
      evidence: "asked",
    },
    title: "Fix typo",
    scope: "README",
    reason: "asked",
    intent_evidence: "fix typo",
    worktree_name: "fix-typo",
    acknowledgement: "On it",
    rule_assessments: [
      { rule_id: "copy", matched, reason: "judged" },
      { rule_id: "visual", matched: false, reason: "judged" },
    ],
  });
}

describe("policy (ported from neo-app/tests/policy.rs)", () => {
  // chat: the only installed Source

  test("admits_a_listed_chat_senders_direct_request_as_explicit_and_no_one_elses", () => {
    const defaults = defaultSettings();
    const res = runGate(defaults, chatTrigger(WEB_SENDER), makeThread([], []));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected admissible");
    expect(res.strength).toBe("explicit");
    expect(res.basis.via).toBe("addressed");
    if (res.basis.via === "addressed") {
      expect(res.basis.addressed).toBe("direct");
    }
    expect([res.basis.source, res.basis.sender, res.basis.row]).toEqual([
      "chat",
      "web:local",
      undefined,
    ]);
    expect(runGate(defaults, chatTrigger("wechat:stranger"), makeThread([], []))).toEqual({
      ok: false,
      reason: "not_a_member",
    });
    // A direct-message thread belongs to its sender: a stranger there is no follow-up, whatever tickets it has.
    expect(runGate(defaults, chatTrigger("wechat:stranger"), makeThread(["t1"], []))).toEqual({
      ok: false,
      reason: "not_a_member",
    });
    const bound = cloneSettings(defaults);
    allowChatSender(bound, "wechat:me@im.wechat");
    const boundRes = runGate(bound, chatTrigger("wechat:ME@im.wechat"), makeThread([], []));
    expect(boundRes.ok && boundRes.strength).toBe("explicit");
    const robot = chatTrigger(WEB_SENDER);
    robot.human = false;
    expect(runGate(defaults, robot, makeThread([], []))).toEqual({
      ok: false,
      reason: "not_human",
    });
  });

  test("keeps_a_chat_mandate_while_its_sender_stays_listed", () => {
    const defaults = defaultSettings();
    const held = makeMandate(defaults, chatTrigger(WEB_SENDER), makeThread([], []));
    expect(makePolicy(defaults).revalidate(held)).toBe(true);
    const removed = cloneSettings(defaults);
    disallowChatSender(removed, WEB_SENDER);
    expect(makePolicy(removed).revalidate(held)).toBe(false);
    // A Mandate received on a Source that is no longer installed does not hold.
    const elsewhere: Mandate = structuredClone(held);
    elsewhere.basis.source = "gone";
    expect(makePolicy(defaults).revalidate(elsewhere)).toBe(false);
  });

  test("changes_the_policy_version_for_authorization_rules_and_mode_only", () => {
    const base = defaultSettings();
    const version = policyVersion(base);
    const other = cloneSettings(base);
    other.paused = true;
    other.executor.maxWorkers = 9;
    other.eval.timeoutSeconds = 300;
    other.models.antigravity = defaultRoleModels();
    expect(policyVersion(other)).toBe(version);
    const mode = cloneSettings(base);
    mode.eval.mode = "auto";
    expect(policyVersion(mode)).not.toBe(version);
    const senders = cloneSettings(base);
    allowChatSender(senders, "wechat:me");
    expect(policyVersion(senders)).not.toBe(version);
    const rules = cloneSettings(base);
    rules.policy.rules[0].enabled = false;
    expect(policyVersion(rules)).not.toBe(version);
    const p = makePolicy(other);
    expect(p.version()).toBe(version);
    expect(p.paused()).toBe(true);
    expect(p.evalTimeoutMs()).toBe(300_000);
  });

  // a Source that observes rooms

  test("judges_unaddressed_and_unlisted_messages_by_the_admission_table", () => {
    const auto = roomSettings();
    const alone = makeThread([], []);
    // A listed sender who addresses the agent is explicit; unaddressed, an inferred candidate by default.
    const mentioned = runGate(auto, roomTrigger("ALICE", "mention", true), alone);
    expect(mentioned.ok).toBe(true);
    if (!mentioned.ok) throw new Error("expected admissible");
    expect([mentioned.strength, mentioned.basis.sender, mentioned.basis.row]).toEqual([
      "explicit",
      "Alice",
      "r1",
    ]);

    const unaddressed = runGate(auto, roomTrigger("alice", undefined, true), alone);
    expect(unaddressed.ok).toBe(true);
    if (!unaddressed.ok) throw new Error("expected admissible");
    expect(unaddressed.strength).toBe("inferred");
    expect(unaddressed.basis.via).toBe("admission");
    if (unaddressed.basis.via === "admission") {
      expect(unaddressed.basis.cell).toBe("listedUnaddressed");
      expect(unaddressed.basis.addressed).toBeUndefined();
      expect(unaddressed.basis.observation).toEqual({ mode: "auto" });
    }

    // Unlisted senders are ignored by default, addressed or not.
    expect(runGate(auto, roomTrigger("mallory", "mention", true), alone)).toEqual({
      ok: false,
      reason: "not_a_member",
    });
    expect(runGate(auto, roomTrigger("mallory", undefined, true), alone)).toEqual({
      ok: false,
      reason: "not_a_member",
    });

    // The room's row can open it up, or close the listed sender's unaddressed messages.
    const open = roomSettings({
      admission: {
        r1: {
          unlistedAddressed: "explicit",
          unlistedUnaddressed: "inferred",
          listedUnaddressed: "ignore",
        },
      },
    });
    const opened = runGate(open, roomTrigger("mallory", "mention", true), alone);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected admissible");
    expect(opened.strength).toBe("explicit");
    expect(opened.basis.via).toBe("admission");
    if (opened.basis.via === "admission") {
      expect(opened.basis.cell).toBe("unlistedAddressed");
      expect(opened.basis.addressed).toBe("mention");
      expect(opened.basis.observation).toBeUndefined();
    }
    const malloryUnaddressed = runGate(open, roomTrigger("mallory", undefined, true), alone);
    expect(malloryUnaddressed.ok && malloryUnaddressed.strength).toBe("inferred");
    expect(runGate(open, roomTrigger("alice", undefined, true), alone)).toEqual({
      ok: false,
      reason: "admission_ignored",
    });

    // Another room keeps the defaults.
    const elsewhere = roomTrigger("mallory", "mention", true);
    elsewhere.meta.room = "r2";
    expect(runGate(open, elsewhere, alone)).toEqual({ ok: false, reason: "not_a_member" });

    // With the accept mode off, nothing is inferred.
    const off = roomSettings({ mode: "off" });
    expect(runGate(off, roomTrigger("alice", undefined, true), alone)).toEqual({
      ok: false,
      reason: "no_mention",
    });
  });

  test("takes_a_message_on_a_thread_with_tickets_of_its_own_as_a_follow_up", () => {
    const auto = roomSettings();
    const res1 = runGate(auto, roomTrigger("mallory", undefined, true), makeThread(["t1"], []));
    expect(res1.ok).toBe(true);
    if (!res1.ok) throw new Error("expected admissible");
    expect([res1.strength, res1.basis.via]).toEqual(["inferred", "followup"]);

    const res2 = runGate(auto, roomTrigger("alice", undefined, true), makeThread(["t1"], []));
    expect(res2.ok).toBe(true);
    if (!res2.ok) throw new Error("expected admissible");
    expect([res2.strength, res2.basis.via]).toEqual(["explicit", "followup"]);

    // A ticket that follows the thread only for context makes no follow-up.
    expect(
      runGate(auto, roomTrigger("mallory", undefined, true), makeThread(["t1"], ["t1"])),
    ).toEqual({ ok: false, reason: "not_a_member" });

    // With the accept mode off, only a listed sender's message is one.
    const off = roomSettings({ mode: "off" });
    expect(
      runGate(off, roomTrigger("mallory", undefined, true), makeThread(["t1"], [])),
    ).toEqual({ ok: false, reason: "not_a_member" });
    const res3 = runGate(off, roomTrigger("alice", undefined, true), makeThread(["t1"], []));
    expect(res3.ok && res3.strength).toBe("explicit");
  });

  test("admits_listed_bots_and_senderless_events_as_inferred_candidates_at_most", () => {
    const auto = roomSettings();
    const alone = makeThread([], []);
    const res = runGate(auto, roomTrigger("ci-bot", undefined, false), alone);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected admissible");
    expect([res.strength, res.basis.sender]).toEqual(["inferred", "ci-bot"]);
    expect(res.basis.via).toBe("bot");
    if (res.basis.via === "bot") {
      expect(res.basis.addressed).toBeUndefined();
      expect(res.basis.observation).toEqual({ mode: "auto" });
    }

    expect(runGate(auto, roomTrigger("other-bot", undefined, false), alone)).toEqual({
      ok: false,
      reason: "not_human",
    });
    expect(
      runGate(roomSettings({ mode: "off" }), roomTrigger("ci-bot", undefined, false), alone),
    ).toEqual({ ok: false, reason: "admission_ignored" });

    // A senderless event passes only where the row admits unlisted unaddressed messages.
    expect(runGate(auto, roomTrigger("", undefined, false), alone)).toEqual({
      ok: false,
      reason: "admission_ignored",
    });
    const open = roomSettings({ admission: { r1: { unlistedUnaddressed: "inferred" } } });
    const openRes = runGate(open, roomTrigger("", undefined, false), alone);
    expect(openRes.ok && openRes.strength).toBe("inferred");

    const left = roomTrigger("ci-bot", undefined, false);
    left.meta.left = true;
    expect(runGate(auto, left, alone)).toEqual({ ok: false, reason: "not_human" });
  });

  test("accepts_inferred_work_only_in_auto_mode_on_enabled_rules", () => {
    const auto = roomSettings();
    expect(makePolicy(auto).admitsInferred(["copy"])).toBe(true);
    expect(makePolicy(auto).admitsInferred([])).toBe(false);
    expect(makePolicy(auto).admitsInferred(["copy", "unknown"])).toBe(false);
    expect(makePolicy(roomSettings({ mode: "observe" })).admitsInferred(["copy"])).toBe(false);
    const disabled = cloneSettings(auto);
    disabled.policy.rules[0].enabled = false;
    expect(makePolicy(disabled).admitsInferred(["copy"])).toBe(false);
  });

  test("revalidates_a_mandate_against_the_senders_list_the_table_the_mode_and_its_rules", () => {
    const auto = roomSettings();
    const alone = makeThread([], []);
    const observed = makeMandate(auto, roomTrigger("alice", undefined, true), alone, ["copy"]);
    expect(makePolicy(auto).revalidate(observed)).toBe(true);
    expect(makePolicy(roomSettings({ mode: "observe" })).revalidate(observed)).toBe(false);
    const disabled = cloneSettings(auto);
    disabled.policy.rules[0].enabled = false;
    expect(makePolicy(disabled).revalidate(observed)).toBe(false);
    const unlisted = cloneSettings(auto);
    unlisted.policy.sources.room.allowed = [];
    expect(makePolicy(unlisted).revalidate(observed)).toBe(false);
    expect(
      makePolicy(roomSettings({ admission: { r1: { listedUnaddressed: "ignore" } } })).revalidate(
        observed,
      ),
    ).toBe(false);

    // An explicit Mandate from an open row holds while the row still grants it, or once its sender is listed.
    const open = roomSettings({ admission: { r1: { unlistedAddressed: "explicit" } } });
    const granted = makeMandate(open, roomTrigger("mallory", "mention", true), alone);
    expect(makePolicy(open).revalidate(granted)).toBe(true);
    expect(makePolicy(auto).revalidate(granted)).toBe(false);
    const listed = cloneSettings(auto);
    listed.policy.sources.room.allowed.push({ id: "mallory" });
    expect(makePolicy(listed).revalidate(granted)).toBe(true);

    // A bot's candidate holds while the bot stays listed.
    const bot = makeMandate(auto, roomTrigger("ci-bot", undefined, false), alone, ["copy"]);
    expect(makePolicy(auto).revalidate(bot)).toBe(true);
    const noBots = cloneSettings(auto);
    noBots.policy.sources.room.bots = [];
    expect(makePolicy(noBots).revalidate(bot)).toBe(false);

    // A follow-up: explicit stays valid, inferred needs auto mode and its rules.
    const stranger = makeMandate(
      auto,
      roomTrigger("mallory", undefined, true),
      makeThread(["t1"], []),
      ["copy"],
    );
    expect(makePolicy(auto).revalidate(stranger)).toBe(true);
    expect(makePolicy(roomSettings({ mode: "observe" })).revalidate(stranger)).toBe(false);
    const member = makeMandate(
      auto,
      roomTrigger("alice", undefined, true),
      makeThread(["t1"], []),
    );
    expect(makePolicy(roomSettings({ mode: "off" })).revalidate(member)).toBe(true);

    // Once the Source stops listening to the room, nothing received there holds.
    const left: Mandate = structuredClone(observed);
    left.basis.scope!.left = true;
    expect(makePolicy(auto).revalidate(left)).toBe(false);
  });

  test("tells_each_open_ticket_how_a_settings_change_bears_on_it", () => {
    const auto = roomSettings();
    const alone = makeThread([], []);
    const makeTicket = (id: string, mandate: Mandate): Ticket => ({
      id,
      title: "T",
      decisionId: "d",
      mandate,
      channels: [],
      assignments: [],
      inputs: [],
      undelivered: [],
      createdAt: "t",
      updatedAt: "t",
      origin: { triggerId: "g", triggerIds: [] },
    });
    const tickets: Ticket[] = [
      makeTicket("explicit", makeMandate(auto, roomTrigger("alice", "mention", true), alone)),
      makeTicket(
        "proactive",
        makeMandate(auto, roomTrigger("alice", undefined, true), alone, ["copy"]),
      ),
      makeTicket("local", makeMandate(auto, chatTrigger(WEB_SENDER), alone)),
    ];

    // Nothing changed that bears on them.
    const busier = cloneSettings(auto);
    busier.executor.maxWorkers = 8;
    expect(policyEffects(tickets, auto, busier, ROOMS).size).toBe(0);

    // A rule's instruction changed: only the ticket accepted under it hears of it.
    const reworded = cloneSettings(auto);
    reworded.policy.rules[0].instruction = "Typos only.";
    const rewordEffects = policyEffects(tickets, auto, reworded, ROOMS);
    expect(Array.from(rewordEffects.keys())).toEqual(["proactive"]);
    expect(rewordEffects.get("proactive")?.rules).toEqual([
      { id: "copy", name: "Copy fixes", change: "changed", instruction: "Typos only." },
    ]);
    expect([
      rewordEffects.get("proactive")?.proactive,
      rewordEffects.get("proactive")?.requesterAllowed,
    ]).toEqual([undefined, undefined]);

    // The rule is disabled.
    const disabled = cloneSettings(auto);
    disabled.policy.rules[0].enabled = false;
    const disabledEffects = policyEffects(tickets, auto, disabled, ROOMS);
    expect(disabledEffects.get("proactive")?.rules?.[0].change).toBe("disabled");
    expect(disabledEffects.get("proactive")?.rules?.[0].instruction).toBeUndefined();
    expect(disabledEffects.size).toBe(1);

    // Proactive work is no longer accepted.
    const observeEffects = policyEffects(tickets, auto, roomSettings({ mode: "observe" }), ROOMS);
    expect(observeEffects.size).toBe(1);
    expect([
      observeEffects.get("proactive")?.proactive,
      observeEffects.get("proactive")?.requesterAllowed,
    ]).toEqual([false, undefined]);

    // The requester is taken off the list: both of that sender's tickets are told, the local one is not.
    const removed = cloneSettings(auto);
    removed.policy.sources.room.allowed = [];
    const removedEffects = policyEffects(tickets, auto, removed, ROOMS);
    expect(Array.from(removedEffects.keys()).sort()).toEqual(["explicit", "proactive"]);
    for (const effect of removedEffects.values()) {
      expect([effect.requesterAllowed, effect.requester?.id]).toEqual([false, "alice"]);
    }
  });

  // assessment outcomes

  test("accepts_bounded_work_only_with_a_matched_rule_a_settled_direction_and_intent_evidence", () => {
    const auto = roomSettings();
    const accepted = assessmentOutcome(makeAssessment(true, "accept"), auto, "inferred");
    expect(accepted.kind.kind).toBe("accept");
    if (accepted.kind.kind !== "accept") throw new Error("expected accept");
    const accept = accepted.kind.accept;
    expect([accept.title, accept.scope, accept.name, accept.acknowledgement]).toEqual([
      "Fix typo",
      "README",
      "fix-typo",
      "On it",
    ]);
    expect(accept.rules).toEqual(["copy"]);
    expect(accepted.reason).toEqual(whySaid("asked"));
    expect(accepted.audit).toBeDefined();
    expect(accepted.audit?.matches).toEqual([{ rule_id: "copy", reason: "judged" }]);
    expect(accepted.audit?.intent_evidence).toBe("fix typo");
    expect(assessmentOutcome(makeAssessment(true, "accept"), auto, "explicit").kind.kind).toBe(
      "accept",
    );

    const code = (outcome: Outcome): string =>
      outcome.reason.kind === "code" ? outcome.reason.reason.code : outcome.reason.text;

    const unmatched = assessmentOutcome(makeAssessment(false, "accept"), auto, "inferred");
    expect([unmatched.kind.kind, code(unmatched)]).toEqual(["ignore", "noRuleMatched"]);

    const unsettled = makeAssessment(true, "accept");
    (unsettled.direction as Record<string, unknown>).target_basis = "undetermined";
    expect(code(assessmentOutcome(unsettled, auto, "explicit"))).toBe("directionUnsettled");

    const noEvidence = makeAssessment(true, "accept");
    delete noEvidence.intent_evidence;
    expect(() => assessmentOutcome(noEvidence, auto, "explicit")).toThrow("intent_evidence");
  });

  test("records_what_an_inferred_candidate_would_accept_outside_auto_mode", () => {
    const observe = roomSettings({ mode: "observe" });
    const observed = assessmentOutcome(makeAssessment(true, "accept"), observe, "inferred");
    expect(observed.kind).toEqual({ kind: "ignore" });
    expect(observed.reason).toEqual(whyCode(reasonWith("observed", "text", "asked")));
    expect(observed.audit?.would_accept).toBe(true);
    expect(observed.audit?.proposal).toEqual({
      title: "Fix typo",
      scope: "README",
      worktree_name: "fix-typo",
    });
    // An explicit request is accepted whatever the mode.
    expect(assessmentOutcome(makeAssessment(true, "accept"), observe, "explicit").kind.kind).toBe(
      "accept",
    );
  });

  test("passes_an_ignore_or_unavailable_through_and_refuses_judgements_that_do_not_cover_the_enabled_rules", () => {
    const auto = roomSettings();
    expect(assessmentOutcome(makeAssessment(false, "ignore"), auto, "inferred").kind).toEqual({
      kind: "ignore",
    });
    expect(
      assessmentOutcome(makeAssessment(false, "unavailable"), auto, "inferred").kind,
    ).toEqual({ kind: "unavailable" });
    expect(() => assessmentOutcome(makeAssessment(true, "maybe"), auto, "inferred")).toThrow(
      "Unknown decision",
    );

    const missing = makeAssessment(true, "accept");
    missing.rule_assessments.pop();
    expect(() => assessmentOutcome(missing, auto, "inferred")).toThrow("every enabled rule");

    const repeated = makeAssessment(true, "accept");
    repeated.rule_assessments[1].rule_id = "copy";
    expect(() => assessmentOutcome(repeated, auto, "inferred")).toThrow();

    // A disabled rule is not judged.
    const one = cloneSettings(auto);
    one.policy.rules[1].enabled = false;
    expect(() => assessmentOutcome(makeAssessment(true, "accept"), one, "inferred")).toThrow();
    expect(assessmentOutcome(missing, one, "inferred").kind.kind).toBe("accept");
  });

  test("takes_a_direction_as_settled_only_when_it_says_so_exactly", () => {
    const direction = (basis: string, requested: boolean, design: boolean) => ({
      implementation_requested: requested,
      target_basis: basis,
      requires_design_decision: design,
      evidence: "asked",
    });
    expect(directionAllowed(direction("specified", true, false))).toBe(true);
    expect(directionAllowed(direction("existing-standard", true, false))).toBe(true);
    expect(directionAllowed(direction("undetermined", true, false))).toBe(false);
    expect(directionAllowed(direction("specified", false, false))).toBe(false);
    expect(directionAllowed(direction("specified", true, true))).toBe(false);
    expect(
      directionAllowed({
        implementation_requested: true,
        target_basis: "specified",
        requires_design_decision: false,
        evidence: " ",
      }),
    ).toBe(false);
    expect(
      directionAllowed({
        ...direction("specified", true, false),
        more: true,
      }),
    ).toBe(false);
    expect(directionAllowed(null)).toBe(false);
  });
});

// ============================================================================
// Additional fidelity & edge-case tests
// ============================================================================

describe("policy & settings fidelity edge cases", () => {
  test("policyVersion matches exact Rust Parts JSON + BTreeMap UTF-8 key ordering and prompts.ts", () => {
    const defaults = defaultSettings();
    const version = policyVersion(defaults);
    expect(version.length).toBe(32);
    // Must match prompts.ts fallbackPolicyVersion byte-for-byte.
    const section = policySection(defaults);
    expect(section.startsWith(`## Policy\nPolicy version ${version}; accept mode observe.`)).toBe(
      true,
    );

    // Numeric admission row keys must sort lexicographically ("10" before "2"), matching Rust BTreeMap,
    // NOT JavaScript integer-property order ("2" before "10").
    const withNumericRows = roomSettings({
      admission: {
        "2": { unlistedUnaddressed: "inferred" },
        "10": { listedUnaddressed: "ignore" },
      },
    });
    const expectedParts =
      `{"rules":${JSON.stringify(withNumericRows.policy.rules)},"mode":"auto","sources":{` +
      `"chat":{"allowed":[{"id":"web:local"}]},` +
      `"room":{"allowed":[{"id":"alice","name":"Alice"}],"bots":[{"id":"ci-bot"}],` +
      `"admission":{"10":{"listedUnaddressed":"ignore"},"2":{"unlistedUnaddressed":"inferred"}}}}} `;
    expect(policyVersion(withNumericRows)).toBe(key([POLICY_REVISION, expectedParts.trim()]));
  });

  test("parseBlock replaces requested blocks whole while preserving others and enforcing validation", () => {
    const base = parseSettings({
      paused: true,
      executor: { maxWorkers: 6, directory: "/tmp/work", prepareShell: "bash" },
      eval: { mode: "auto", timeoutSeconds: 200 },
    });

    // Replacing `eval` resets omitted fields inside `eval` to defaults and keeps `paused` and `executor`.
    const updatedEval = parseBlock(base, "eval", { mode: "observe" });
    expect(updatedEval.paused).toBe(true);
    expect(updatedEval.executor.maxWorkers).toBe(6);
    expect(updatedEval.executor.directory).toBe("/tmp/work");
    expect(updatedEval.eval).toEqual({ mode: "observe", timeoutSeconds: 120 });

    // Multi-block patch object form.
    const updatedPatch = parseBlock(base, { paused: false, executor: { maxWorkers: 4 } });
    expect(updatedPatch.paused).toBe(false);
    expect(updatedPatch.executor).toEqual({
      maxWorkers: 4,
      directory: "",
      prepare: "",
      blockedCommands: [],
    });
    expect(updatedPatch.eval).toEqual({ mode: "auto", timeoutSeconds: 200 });

    // Unknown block or field is refused.
    expect(() => parseBlock(base, { bogus: 1 })).toThrow("unknown field");
    expect(() => parseBlock(base, "executor", { maxWorkers: 0 })).toThrow("1 to 16");
  });

  test("limits constants and Unicode charCount bounds match Rust", () => {
    expect(limits).toEqual({
      RULE_NAME: 100,
      RULE_INSTRUCTION: 2000,
      EVAL_TIMEOUT_SECONDS: [30, 600],
      MAX_WORKERS: [1, 16],
      PREPARE_COMMAND: 4000,
    });
    // 100 emoji (200 UTF-16 code units, 100 Unicode scalar values) is allowed for rule name; 101 is rejected.
    const emoji = "😀";
    expect(emoji.length).toBe(2);
    expect(() =>
      parseSettings({
        policy: {
          rules: [{ id: "r", name: emoji.repeat(100), enabled: true, instruction: "ok" }],
        },
      }),
    ).not.toThrow();
    expect(() =>
      parseSettings({
        policy: {
          rules: [{ id: "r", name: emoji.repeat(101), enabled: true, instruction: "ok" }],
        },
      }),
    ).toThrow("1 to 100");
    // 700 emoji for direction evidence is allowed; 701 is rejected.
    expect(
      directionAllowed({
        implementation_requested: true,
        target_basis: "specified",
        requires_design_decision: false,
        evidence: emoji.repeat(700),
      }),
    ).toBe(true);
    expect(
      directionAllowed({
        implementation_requested: true,
        target_basis: "specified",
        requires_design_decision: false,
        evidence: emoji.repeat(701),
      }),
    ).toBe(false);
  });

  test("revalidate moves unlistedUnaddressed sender to listedUnaddressed once listed", () => {
    const open = roomSettings({ admission: { r1: { unlistedUnaddressed: "inferred" } } });
    const alone = makeThread([], []);
    const m = makeMandate(open, roomTrigger("mallory", undefined, true), alone, ["copy"]);
    expect(makePolicy(open).revalidate(m)).toBe(true);

    // Close unlistedUnaddressed, but add mallory to allowed list -> moves to listedUnaddressed (default inferred).
    const listedNow = roomSettings({ admission: { r1: { unlistedUnaddressed: "ignore" } } });
    listedNow.policy.sources.room.allowed.push({ id: "mallory" });
    expect(makePolicy(listedNow).revalidate(m)).toBe(true);

    // If listedUnaddressed is also ignore, mandate no longer holds.
    const closedBoth = roomSettings({
      admission: { r1: { unlistedUnaddressed: "ignore", listedUnaddressed: "ignore" } },
    });
    closedBoth.policy.sources.room.allowed.push({ id: "mallory" });
    expect(makePolicy(closedBoth).revalidate(m)).toBe(false);
  });

  test("parseAssessment rejects unknown fields and fills defaults", () => {
    expect(() =>
      parseAssessment({
        decision: "ignore",
        rule_assessments: [],
        reason: "no",
        extra: true,
      }),
    ).toThrow("unknown field");
    expect(() =>
      parseAssessment({
        decision: "ignore",
        rule_assessments: [{ rule_id: "copy", matched: false, reason: "no", extra: 1 }],
        reason: "no",
      }),
    ).toThrow("unknown field");
    const minimal = parseAssessment({
      decision: "ignore",
      rule_assessments: [],
      reason: "quiet",
    });
    expect(minimal).toEqual({
      decision: "ignore",
      rule_assessments: [],
      direction: null,
      title: "",
      scope: "",
      reason: "quiet",
    });
  });

  test("SettingsStore sorts >10 revisions numerically rather than lexicographically", () => {
    const store = Store.memory();
    try {
      const stored = new SettingsStore(store);
      const settings = defaultSettings();
      for (let i = 1; i <= 11; i++) {
        settings.executor.maxWorkers = i;
        stored.save(settings, "app", `v${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`);
      }
      expect(stored.revision()).toBe(11);
      expect(stored.current().executor.maxWorkers).toBe(11);
      expect(stored.history(3).map((v) => v.revision)).toEqual([11, 10, 9]);
    } finally {
      store.close();
    }
  });

  test("gate counts thread tickets for participation unless in context, and Sources scopes chat only", () => {
    const sources = new Sources();
    expect(sources.scope(CHAT_SOURCE, {})).toEqual({
      kind: "listened",
      observed: false,
      fanout: false,
    });
    expect(sources.scope("other", {})).toEqual({
      kind: "ignored",
      reason: "source_not_installed",
    });

    const auto = roomSettings();
    const t: Ticket = {
      id: "tk1",
      title: "T",
      decisionId: "d",
      mandate: makeMandate(auto, roomTrigger("alice", "mention", true), makeThread([], [])),
      channels: [],
      assignments: [],
      inputs: [],
      undelivered: [],
      createdAt: "t",
      updatedAt: "t",
      origin: { triggerId: "g", triggerIds: [] },
    };
    const p = makePolicy(auto);
    const res1 = p.gate(roomTrigger("mallory", undefined, true), makeThread([], []), [t]);
    expect(res1.kind).toBe("admissible");
    if (res1.kind === "admissible") {
      expect([res1.strength, res1.basis.via]).toEqual(["inferred", "followup"]);
    }
    const res2 = p.gate(roomTrigger("mallory", undefined, true), makeThread([], ["tk1"]), [t]);
    expect(res2).toEqual({ kind: "inadmissible", reason: "not_a_member" });

    // Non-Option fields reject null just like Rust serde.
    expect(() => parseSettings({ paused: null })).toThrow("Invalid settings");
    expect(() => parseSettings({ policy: { sources: { chat: { bots: null } } } })).toThrow(
      "Invalid settings",
    );
    expect(() => parseSettings({ eval: { timeoutSeconds: 120.5 } })).toThrow("Invalid settings");
  });
});
