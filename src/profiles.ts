// Runs each agent on its own dsh profile. A saved agent names the profile whose
// models and tools it runs with, and one `dsh` process serves one profile, so
// each profile in use gets one Goose runtime, with its own process and agents.
// The runtime itself stays buzz-app's, unchanged: this routes each call to it.
import {
  type Config,
  config,
  type GooseRuntime,
} from "@app/bundled/goose/runtime";
import type {
  Agent,
  Delivery,
  SessionControlAction,
  SessionPlace,
  StandaloneTurn,
} from "@app/features/agents/service";

/** The profile a new or unreadable agent runs on. Buzz has its own, so no
 * other dsh profile needs the Buzz bundle (scripts/setup-buzz-profile). */
export const DEFAULT_PROFILE = "buzz";
/** A profile name becomes a process argument: it must never look like a flag.
 * The same rule as the plugin's first version, so a saved name stays valid. */
export const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** dsh's own reasoning levels, and "" for what its profile sets. */
export const EFFORTS: readonly string[] = ["", "off", "low", "high", "max"];
/** The longest saved model value kept: a JSON `["provider","model"]` pair. */
const MODEL_LIMIT = 512;
/** A workspace dsh can work in: absolute, or under the home folder. */
export const WORKSPACE_RE = /^(\/|~\/)/;

export type DshConfig = Config & Readonly<{ profile: string }>;

/** A new agent's settings. dsh agents work in their own folder. */
export const DEFAULT_CONFIG: DshConfig = Object.freeze({
  ...config(undefined),
  profile: DEFAULT_PROFILE,
  workspace: "~/dsh-agents",
});

/** A saved config with every field present and each field valid. It reads what
 * the plugin's first version saved (`profile`, `model`, `effort`,
 * `instructions`, `workspace`) unchanged: the new fields take their defaults.
 * An invalid value takes its default too, so it never reaches a process. */
export function dshConfig(value: unknown): DshConfig {
  const raw: Record<string, unknown> =
    value && typeof value === "object" ? { ...value } : {};
  const pick = (
    key: keyof typeof DEFAULT_CONFIG,
    ok: (text: string) => boolean,
  ) => {
    const text = raw[key];
    return typeof text === "string" && ok(text)
      ? text
      : (DEFAULT_CONFIG[key] as string);
  };
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    profile: pick("profile", (text) => PROFILE_RE.test(text)),
    model: pick("model", (text) => text.length <= MODEL_LIMIT),
    effort: pick("effort", (text) => EFFORTS.includes(text)),
    instructions: pick("instructions", () => true),
    provider: "",
    workspace: pick("workspace", (text) => WORKSPACE_RE.test(text)),
    scope: raw.scope === "channel" ? "channel" : "thread",
  };
}

/** A model's display name inside dsh's `["provider","model"]` value. */
export function modelLabel(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed))
      return parsed.filter((part) => typeof part === "string").join(" · ");
  } catch {
    // Not JSON: it shows as the owner wrote it.
  }
  return value;
}

/** `value` with its config read by `dshConfig`, its other members as they are:
 * the app's deliveries and agents may be more than plain data. */
const withConfig = <T extends object>(value: T, raw: unknown): T =>
  Object.create(value, { config: { value: dshConfig(raw), enumerable: true } });

/** The Goose runtimes in use, one per profile. */
export class ProfileRuntimes {
  private readonly runtimes = new Map<string, GooseRuntime>();
  /** Each running agent's profile, from the latest sync. */
  private readonly profiles = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly notify = () => {
    for (const listener of this.listeners) listener();
  };

  constructor(private readonly make: (profile: string) => GooseRuntime) {}

  /** The runtime of `profile`, made when first needed. */
  private of(profile: string) {
    let runtime = this.runtimes.get(profile);
    if (!runtime) {
      runtime = this.make(profile);
      runtime.subscribe(this.notify);
      this.runtimes.set(profile, runtime);
    }
    return runtime;
  }
  /** The runtime of an agent known only by its key. */
  private owner(key: string) {
    return this.of(this.profiles.get(key) ?? DEFAULT_PROFILE);
  }

  /** Brings each runtime in line with its profile's agents. An agent moved to
   * another profile stops in the old runtime and starts in the new. */
  sync(agents: readonly Agent[]) {
    const running = agents.map((agent) => withConfig(agent, agent.config));
    this.profiles.clear();
    for (const agent of running)
      this.profiles.set(agent.key, dshConfig(agent.config).profile);
    const used = new Set(this.profiles.values());
    for (const profile of used) this.of(profile);
    for (const [profile, runtime] of this.runtimes)
      runtime.sync(
        running.filter((agent) => this.profiles.get(agent.key) === profile),
      );
  }
  /** The profiles running agents use now. */
  used() {
    return [...new Set(this.profiles.values())];
  }

  sessions(key: string) {
    return this.owner(key).sessions(key);
  }
  conversations(key: string) {
    return this.owner(key).conversations(key);
  }
  prompts(key: string) {
    return this.owner(key).prompts(key);
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  sessionState(agent: Agent, place: SessionPlace) {
    const read = dshConfig(agent.config);
    return this.of(read.profile).sessionState(withConfig(agent, read), place);
  }
  session(agent: Agent, place: SessionPlace, action: SessionControlAction) {
    const read = dshConfig(agent.config);
    return this.of(read.profile).session(
      withConfig(agent, read),
      place,
      action,
    );
  }
  run(delivery: Delivery) {
    const read = dshConfig(delivery.config);
    return this.of(read.profile).run(withConfig(delivery, read));
  }
  runOnce(turn: StandaloneTurn) {
    const read = dshConfig(turn.delivery.config);
    return this.of(read.profile).runOnce({
      ...turn,
      delivery: withConfig(turn.delivery, read),
    });
  }
  dispose() {
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
    this.profiles.clear();
  }
}
