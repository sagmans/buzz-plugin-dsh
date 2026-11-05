// Reads what this computer's dsh offers on a profile, for the create and
// settings views and the per-message picks: the models and each model's
// reasoning efforts. dsh lists them as config options of a session, per
// current model, so discovery opens one throwaway session with no Buzz tools,
// in the home folder, in its own `dsh --profile <profile>` process, moves it
// through the models, closes it and stops that process. Moving a session calls
// no model: dsh only changes what its next request would use.
import { errorMessage } from "@app/features/agent-harness/acp/steps";
import type {
  AgentProviderSnapshot,
  Models,
} from "@app/features/agents/service";
import {
  bundled,
  DSH,
  DshError,
  dshVersion,
  type GooseHost,
  GooseProcess,
  type GooseProcess as Process,
  REQUEST_TIMEOUT_MS,
} from "./dsh";
import { modelLabel } from "./profiles";

/** One model dsh offers: its exact `["provider","model"]` value, kept whole,
 * and the efforts it offers. */
export type DshModel = Readonly<{
  id: string;
  label: string;
  efforts: readonly string[];
}>;
export type Discovery = Readonly<{
  models: readonly DshModel[];
  /** The model and effort a new session starts on, when dsh names them. */
  current?: string;
  currentEffort?: string;
  /** Whether the profile has dsh-acp-buzz/. */
  bundle: boolean;
}>;

/** What a setup check found, per profile in use. Never holds a key: the check
 * does not read any. */
export type DshStatus = Readonly<{
  /** False only when the system could not find the program. */
  installed: boolean;
  /** Whether every profile checked started and opened a session. */
  reachable: boolean;
  version: string;
  defaultModel: string;
  models: readonly DshModel[];
  profiles: readonly Readonly<{ profile: string; bundle: boolean }>[];
  problem: string;
}>;

/** A setup check stops waiting here: the row stays "Checking…" until it ends,
 * and one hung process must not hold that up. Its process is still stopped. */
const CHECK_WAIT_MS = 30_000;
/** The app's provider row shows these as the action to take. */
const LABEL_INSTALL = "Install dsh";
const LABEL_CHECK = "Check dsh setup";
const LABEL_SET_UP = "Set up dsh";

/** A bounded list: the picker shows at most this many models. */
const MODELS_LIMIT = 500;
/** The longest model value or label kept: dsh's are short JSON pairs. */
const TEXT_LIMIT = 512;
/** How long reading each model's efforts may take. Past it the remaining models
 * show none: a slow read costs only their effort sliders. */
const LEVELS_READ_MS = 15_000;
const MODEL_OPTION = "model";
/** Between a model's group and its name, as `modelLabel` joins an id's parts. */
const GROUP_LABEL_SEPARATOR = " · ";
const THOUGHT_CATEGORY = "thought_level";

type Option = Readonly<{
  id?: unknown;
  category?: unknown;
  currentValue?: unknown;
  options?: unknown;
}>;
type Choice = Readonly<{
  value?: unknown;
  name?: unknown;
  options?: unknown;
}>;

const optionsOf = (answer: unknown): readonly Option[] => {
  const options = (answer as { configOptions?: unknown } | null)?.configOptions;
  return Array.isArray(options) ? options : [];
};
const text = (value: unknown) =>
  typeof value === "string" ? value.trim().slice(0, TEXT_LIMIT) : "";
const listed = (value: unknown): readonly Choice[] =>
  Array.isArray(value) ? value : [];
const choices = (option?: Option) => listed(option?.options);
/** The choices of an option, with their group's name in the label. dsh lists
 * its models in one group per provider, and ACP also allows a flat list. */
const flatChoices = (option?: Option): readonly Choice[] =>
  choices(option).flatMap((choice) =>
    Array.isArray(choice.options)
      ? listed(choice.options).map(({ value, name }) => ({
          value,
          name: [text(choice.name), text(name)]
            .filter(Boolean)
            .join(GROUP_LABEL_SEPARATOR),
        }))
      : [choice],
  );

/** The effort values in a config answer. dsh's "" is its own default, not a
 * level to pick. */
function effortsOf(answer: unknown) {
  const option = optionsOf(answer).find(
    ({ category }) => category === THOUGHT_CATEGORY,
  );
  return {
    efforts: choices(option)
      .map(({ value }) => text(value))
      .filter(Boolean),
    current: text(option?.currentValue),
  };
}

/** Reads a config answer's models. Bad entries are dropped, not trusted. */
export function readModels(answer: unknown) {
  const option = optionsOf(answer).find(({ id }) => id === MODEL_OPTION);
  const seen = new Set<string>();
  const models: { id: string; label: string }[] = [];
  for (const { value, name } of flatChoices(option)) {
    const id = text(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: text(name) || modelLabel(id) });
    if (models.length >= MODELS_LIMIT) break;
  }
  return { models, current: text(option?.currentValue) };
}

/** Moves the throwaway session through the models, to read what each offers.
 * Any read that fails or comes late leaves that model with none. */
async function readLevels(
  dsh: Process,
  sessionId: string,
  models: readonly { id: string }[],
  onCurrent: readonly string[],
  current: string,
) {
  const levels = new Map<string, readonly string[]>([[current, onCurrent]]);
  const stop = Date.now() + LEVELS_READ_MS;
  for (const { id } of models) {
    if (levels.has(id)) continue;
    if (Date.now() >= stop) break;
    try {
      const answer = await dsh.request(
        "session/set_config_option",
        { sessionId, configId: MODEL_OPTION, value: id },
        REQUEST_TIMEOUT_MS,
      );
      levels.set(id, effortsOf(answer).efforts);
    } catch (error) {
      console.warn("dsh did not list a model's efforts", {
        operation: "session/set_config_option",
        model: id,
        error,
      });
    }
  }
  return levels;
}

/** The row's state for a check's findings. */
function readinessOf(status: DshStatus): AgentProviderSnapshot {
  if (!status.installed)
    return { readiness: "attention", attentionLabel: LABEL_INSTALL };
  if (!status.reachable)
    return { readiness: "attention", attentionLabel: LABEL_CHECK };
  if (!status.models.length)
    return { readiness: "attention", attentionLabel: LABEL_SET_UP };
  return { readiness: "ready" };
}

/** `read` of `profile`, given up on after CHECK_WAIT_MS. */
function bounded(read: Promise<Discovery>, profile: string) {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DshError(
            "check",
            `dsh did not answer on the profile ${profile} in ${CHECK_WAIT_MS} ms.`,
          ),
        ),
      CHECK_WAIT_MS,
    );
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/** Model discovery, shared by every view, per profile, once per app start
 * unless asked again. */
export class DshSetup {
  private readonly reads = new Map<string, Promise<Discovery>>();
  private readonly listeners = new Set<() => void>();
  private state: AgentProviderSnapshot = { readiness: "checking" };
  private found: DshStatus | undefined;
  private checking: Promise<void> | undefined;

  constructor(
    /** `host` of a profile: its `spawn` runs `dsh --profile <profile>`. */
    private readonly hostOf: (profile: string) => GooseHost,
    /** The profiles to check: those in use now, and the default. */
    private readonly profiles: () => readonly string[],
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** What the latest check found; undefined until one has ended. */
  status = () => this.found;

  /** Reads each profile anew, and reports it in the provider row. Rejects
   * never: the row reads the outcome from the snapshot. */
  check = (): Promise<void> => {
    if (this.checking) return this.checking;
    this.update({ readiness: "checking" });
    this.checking = this.probe()
      .then((status) => {
        this.found = status;
        this.update(readinessOf(status));
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  };

  private update(state: AgentProviderSnapshot) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /** One read per profile, each bounded, none able to fail the check. */
  private async probe(): Promise<DshStatus> {
    const profiles = this.profiles();
    const results = await Promise.allSettled(
      profiles.map((profile) => bounded(this.models(profile, true), profile)),
    );
    const read = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const problems = results.flatMap((result) =>
      result.status === "rejected" ? [errorMessage(result.reason)] : [],
    );
    const [first] = read;
    return {
      installed: !problems.some((problem) => problem.includes(DSH.missing)),
      reachable: !problems.length,
      version: dshVersion(),
      defaultModel: first?.current ? modelLabel(first.current) : "",
      models: first?.models ?? [],
      profiles: profiles.flatMap((profile, index) => {
        const result = results[index];
        return result?.status === "fulfilled"
          ? [{ profile, bundle: result.value.bundle }]
          : [];
      }),
      problem: problems.join(" "),
    };
  }

  /** The models of `profile`, read once; `again` reads them anew, after a dsh
   * setup change. Rejects with a readable error. */
  models(profile: string, again = false): Promise<Discovery> {
    const known = this.reads.get(profile);
    if (known && !again) return known;
    const read = this.discover(profile);
    this.reads.set(profile, read);
    // A failed read is tried again next time.
    void read.catch(() => {
      if (this.reads.get(profile) === read) this.reads.delete(profile);
    });
    return read;
  }

  /** What an owner can pick for one message of an agent: the same list the
   * views show, the model it runs on without a pick, and each model's effort
   * without one. A throw shows no picker, which the app handles. */
  async picks({
    profile,
    model,
    effort,
  }: Readonly<{
    profile: string;
    model: string;
    effort: string;
  }>): Promise<Models> {
    const {
      models,
      current = "",
      currentEffort = "",
    } = await this.models(profile);
    const running = model.trim() || current;
    // A model dsh does not list is still the one the agent runs on.
    const named =
      !running || models.some(({ id }) => id === running)
        ? models
        : [{ id: running, label: modelLabel(running), efforts: [] }, ...models];
    return {
      current: running,
      models: named.map(({ id, label, efforts }) => {
        const resting = [effort, currentEffort].find(
          (level) => level && efforts.includes(level),
        );
        return {
          id,
          label,
          efforts: efforts.map((level) => ({
            id: level,
            label: level.charAt(0).toUpperCase() + level.slice(1),
          })),
          ...(resting ? { effort: resting } : {}),
        };
      }),
    };
  }

  private async discover(profile: string): Promise<Discovery> {
    const host = this.hostOf(profile);
    const cwd = await host.resolveDirectory("~");
    const dsh = await GooseProcess.start(host.spawn, { cwd });
    try {
      const opened = (await dsh.request(
        "session/new",
        { cwd, mcpServers: [] },
        REQUEST_TIMEOUT_MS,
      )) as { sessionId?: unknown };
      const { models, current } = readModels(opened);
      const { efforts, current: currentEffort } = effortsOf(opened);
      const sessionId = text(opened.sessionId);
      const levels = await readLevels(dsh, sessionId, models, efforts, current);
      await dsh.request("session/close", { sessionId }, REQUEST_TIMEOUT_MS);
      return {
        models: models.map((model) => ({
          ...model,
          efforts: levels.get(model.id) ?? [],
        })),
        ...(current ? { current } : {}),
        ...(currentEffort ? { currentEffort } : {}),
        bundle: bundled(dsh),
      };
    } catch (error) {
      throw new DshError(
        "discover",
        `dsh could not list its models on the profile ${profile}: ${errorMessage(error)}`,
        undefined,
        { cause: error },
      );
    } finally {
      dsh.kill();
    }
  }
}
