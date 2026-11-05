// DSH agents: an agent type whose agents are DeepSeek Harness (`dsh`) on this
// computer. One `dsh --profile <profile>` process serves each profile in use.
// Each conversation an agent is in is one ACP session in it; dsh answers with
// the Buzz tools that the app serves to it over loopback HTTP MCP, signed by the
// agent's key that the app keeps. The turn logic is buzz-app's Goose runtime,
// and `gooseRun` is how the native Goose type runs on it (turns, session
// controls, synced settings, resume), bundled unchanged; the build swaps its
// process adapter and sessions module (scripts/build-plugin.mjs, SWAPS).
import { gooseRun } from "@app/bundled/goose/run";
import { GooseRuntime } from "@app/bundled/goose/runtime";
import { repositoriesContext } from "@app/features/communities/repositories";
import type { Agent, AgentType } from "@app/features/agents/service";
import { DeepSeekLogoIcon } from "@app/shared/design-system/icons";
import type { Context } from "@deepseek-ai/cordis";
import { createActivity } from "./activity";
import { createProvider } from "./provider";
import { dshSpawn, LABEL, type Spawn } from "./dsh";
import { RecordedHistory } from "./history";
import {
  DEFAULT_CONFIG,
  DEFAULT_PROFILE,
  type DshConfig,
  dshConfig,
  modelLabel,
  ProfileRuntimes,
} from "./profiles";
import { bindReact } from "./react-host";
import { ActivityRecorder } from "./recorder";
import { SessionFiles } from "./session-files";
import { DshSetup } from "./setup";
import { createViews } from "./views";

/** The agent type id. Saved agents match on it: never change it. */
export const TYPE_ID = "dsh";
/** The runtime name in shared and exported agents. */
const SHARED_RUNTIME = "dsh";
/** The manifest id, when the host does not say it. Saved agents match on it. */
const PLUGIN_ID = "sagmans.dsh";
/** The agent storage prefix of each agent's Activity record. */
const ACTIVITY_PREFIX = "sagmans.dsh.activity.v1:";

export const inject = ["react", "agents", "host"];

export function apply(ctx: Context) {
  const { agents, host, react } = ctx;
  // First: the bundled app components render with Buzz's React only.
  bindReact(react);
  // Only the desktop app can start `dsh`, serve MCP to it and read the files
  // its tools attach; no unusable type elsewhere.
  if (!host.spawn || !host.resolveDirectory || !host.readFile || !host.serveMcp)
    return;
  const typeKey = `${ctx.pluginOwner?.id ?? PLUGIN_ID}/${TYPE_ID}`;
  const spawn = host.spawn.bind(host);
  const resolveDirectory = host.resolveDirectory.bind(host);
  /** A profile's `dsh`. Only the manifest's process runs, and the caller adds
   * only its profile name after the declared `--profile`. */
  const spawnOf = (profile: string): Spawn =>
    dshSpawn(
      (id, options) => spawn(id, { ...options, args: [profile] }),
      profile,
    );
  // Reads of the model list stay out of the record: they are no one's turn.
  const setup = new DshSetup(
    (profile) => ({ spawn: spawnOf(profile), resolveDirectory }),
    () => [...new Set([DEFAULT_PROFILE, ...runtimes.used()])],
  );
  const recorder = new ActivityRecorder(agents.storage, ACTIVITY_PREFIX);
  const history = new RecordedHistory(recorder);
  // Its own processes, outside the record: reading history is no one's turn.
  const files = new SessionFiles(
    { readFile: host.readFile.bind(host), resolveDirectory },
    spawnOf,
  );
  const runtimes = new ProfileRuntimes(
    (profile) =>
      new GooseRuntime(
        // What dsh sends the shared client is the Activity tab's record.
        Object.create(host, {
          spawn: { value: recorder.tap(spawnOf(profile)) },
        }),
        (key) => agents.relay(key),
        (key, signal) => agents.core(key, signal),
        // The build's ./sessions reads saved conversations as agent storage.
        agents.storage as unknown as Storage,
        () => agents.tools(),
        // The community's repositories folder, as the native Goose type
        // passes it: this module only reads the app's local storage.
        repositoriesContext,
        agents.storage,
      ),
  );
  const sync = () => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    runtimes.sync(
      snapshot.running.filter((agent: Agent) => agent.type === typeKey),
    );
  };
  const unsubscribe = agents.subscribe(sync);
  sync();
  ctx.effect(() => () => {
    unsubscribe();
    runtimes.dispose();
    void recorder.flush();
  });

  agents.register<DshConfig>(
    dshType(runtimes, setup, history, recorder, files),
  );
}

/** The DSH agent type, on `runtimes`, whose views and picks read `setup`. */
function dshType(
  runtimes: ProfileRuntimes,
  setup: DshSetup,
  history: RecordedHistory,
  recorder: ActivityRecorder,
  files: SessionFiles,
): AgentType<DshConfig> {
  const { Create, CreateModel, SettingsTab } = createViews(setup);
  // The routing object has every member these call.
  const runtime = runtimes as unknown as GooseRuntime;
  const { ActivityTab } = createActivity({
    runtime,
    history,
    recorder,
    files,
  });
  return {
    id: TYPE_ID,
    title: LABEL,
    // The app's own DeepSeek mark, as its model menus show it.
    icon: DeepSeekLogoIcon,
    description:
      "DeepSeek Harness on this computer, through its ACP server. Each thread it is mentioned in is one continuing session.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    Create,
    CreateModel,
    importShared: (source) =>
      source.runtime === SHARED_RUNTIME
        ? { ...DEFAULT_CONFIG, model: source.model }
        : undefined,
    exportShared: (saved) => ({
      runtime: SHARED_RUNTIME,
      model: dshConfig(saved).model,
    }),
    adopt: (carry, saved) => ({
      ...dshConfig(saved),
      instructions: carry.instructions ?? dshConfig(saved).instructions,
      workspace: carry.workspace ?? dshConfig(saved).workspace,
    }),
    carry: (saved) => {
      const { instructions, workspace } = dshConfig(saved);
      return {
        ...(instructions.trim() && { instructions }),
        ...(workspace !== DEFAULT_CONFIG.workspace && { workspace }),
      };
    },
    summary: (agent) => {
      const { model } = dshConfig(agent.config);
      return model ? `${LABEL} · ${modelLabel(model)}` : LABEL;
    },
    sessions: {
      // The same list the bundled Goose type shows: saved conversations,
      // newest first, with the open ones' state.
      list: (key) => sessionsList(runtimes, key),
      subscribe: (listener) => runtimes.subscribe(listener),
    },
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        component: SettingsTab,
      },
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: ActivityTab,
      },
    ],
    provider: createProvider(setup),
    usage: (agent, options) => history.usage(agent.key, options),
    models: (agent) => setup.picks(dshConfig(agent.config)),
    ...(gooseRun(runtime) as Pick<
      AgentType<DshConfig>,
      | "sessionControls"
      | "run"
      | "runOnce"
      | "timeoutMs"
      | "syncedSettings"
      | "resumes"
    >),
  };
}

/** The same list the bundled Goose type shows: saved conversations, newest
 * first, with the open ones' state. */
function sessionsList(runtimes: ProfileRuntimes, key: string) {
  const live = runtimes.sessions(key);
  const busy = new Map(live.map((view) => [view.key, view.busy]));
  const used = new Map(
    runtimes.conversations(key).map(({ key, at }) => [key, at]),
  );
  // Open ones are listed even when saving them failed. A one-off turn
  // joins no conversation.
  for (const { key, at } of live) if (at !== undefined) used.set(key, at);
  return [...used]
    .sort(([, a], [, b]) => b - a)
    .map(([key, at]) => {
      const [channelId = key, root] = key.split("/");
      const working = busy.get(key);
      return {
        channelId,
        ...(root && { root }),
        at,
        ...(working !== undefined && {
          status: working ? "Working" : "Idle",
        }),
      };
    });
}
