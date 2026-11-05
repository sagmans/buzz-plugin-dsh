// dsh on buzz-app's shared ACP client. The build puts this module in place of
// buzz-app's `bundled/goose/goose.ts` (Apache-2.0, see NOTICE), so the Goose
// runtime and the shared client run unchanged against `dsh --profile <profile>`
// instead of `goose-acp`. It exports the names that code imports. Only what dsh
// does differently from plain ACP is here. dsh has no system-prompt extension,
// so the shared client puts the Buzz prompt at the head of a session's first
// prompt.
//
// dsh's differences, all on this side of the shared client:
// - Models and effort are config options, per session (`DSH.select`).
// - It has no `session/load`: an old conversation returns by `session/resume`,
//   with no replay. The client only knows `session/new`, so `DshWire` turns the
//   one into the other when a saved session id comes with it.
// - Its permission requests offer a lasting grant, which never leaves here.
//
// Steering, run ids, compaction and usage need dsh-acp-buzz/ on the profile
// (dsh-acp-buzz/README.md, the contract). It is optional, so each process finds
// out right after `initialize`, by a steer that is bound to fail: -32602 says
// the method is there, -32601 that it is not, and anything else counts as not
// there. Without it a message mid-turn waits as the next turn, and `/compact`
// is refused here, since dsh would otherwise pass it to the model as a paid
// turn.
import {
  AcpProcess,
  REQUEST_TIMEOUT_MS,
} from "@app/features/agent-harness/acp/process";
import type {
  AcpSession,
  ConfigOptions,
} from "@app/features/agent-harness/acp/session";
import { codeOf, errorMessage } from "@app/features/agent-harness/acp/steps";
import type {
  AcpHooks,
  ServeMcp,
  Spawn,
} from "@app/features/agent-harness/acp/types";

export {
  REQUEST_TIMEOUT_MS,
  TOOL_SERVER,
} from "@app/features/agent-harness/acp/process";
export { stepLabel } from "@app/features/agent-harness/acp/steps";
export type {
  ActivityReceipt,
  Choice,
  ServeMcp,
  Settled,
  Spawn,
  ToolServer,
} from "@app/features/agent-harness/acp/types";

export type GooseProcess = AcpProcess;
export type GooseSession = AcpSession;
/** The desktop host's `spawn` and `resolveDirectory`, which dsh starts with. */
export type GooseHost = Readonly<{
  spawn: Spawn;
  resolveDirectory(path: string): Promise<string>;
}>;

/** The manifest process id (plugin/manifest.json): `dsh --profile`. Saved
 * grants name it: never change it. */
export const PROCESS_ID = "dsh-acp";
export const LABEL = "DSH";

/** This plugin's `_meta` key in `session/new`. Only this module reads it, and
 * `DshWire` removes it before dsh sees the request. */
const META_KEY = "sagmans.dsh";
const MODEL_OPTION = "model";
/** dsh's reasoning effort option. Its values are per model. */
const EFFORT_OPTION = "reasoning_effort";
const THOUGHT_CATEGORY = "thought_level";
const SESSION_NEW = "session/new";
const SESSION_RESUME = "session/resume";
const SESSION_CLOSE = "session/close";
const REQUEST_PERMISSION = "session/request_permission";
const LASTING_GRANT = "allow_always";
const SESSION_PROMPT = "session/prompt";
/** The bundle's steer method. */
const STEER = "_dsh/session/steer";
const COMPACT = "/compact";
/** How the client leads a session's first prompt, which then ends this way. */
const LED_COMPACT = `\n\n${COMPACT}`;
/** ACP's code for a method dsh does not have. */
const METHOD_NOT_FOUND = -32601;
/** ACP's code for bad params, which is how the bundle refuses a steer. */
const INVALID_PARAMS = -32602;
/** The JSON-RPC code of an answer this adapter gives in place of dsh. */
const ADAPTER_ERROR = -32000;
const NOTHING_TO_COMPACT =
  "This session has not run a turn yet, so there is nothing to compact.";

/** The command that adds the bundle to `profile`. The dialog and the refusal
 * show it, with the folder where this plugin's checkout is. */
export const bundleCommand = (profile: string) =>
  `dsh plugin --profile ${profile} add link:/path/to/buzz-plugin-dsh/dsh-acp-buzz`;
const noBundle = (profile: string) =>
  `The dsh profile ${profile} has no dsh-acp-buzz, and without it /compact would be a paid model turn, so it was not sent. Add the bundle: ${bundleCommand(profile)}`;

/** The version dsh last reported, for the provider dialog. */
let version = "";
export const dshVersion = () => version;

/** A dsh operation that failed, with the session it was for. */
export class DshError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    readonly sessionId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DshError";
  }
}

/** The model and effort a session runs on; empty is none reported. */
export type Selection = Readonly<{ model: string; effort: string }>;

type SessionState = {
  /** What it started on, which an empty choice goes back to. */
  start: Selection;
  current: Selection;
  /** The effort values the current model offers. */
  levels: readonly string[];
};

/** Each open session's model state, by id. dsh reports it only in its config
 * answers, and the shared client keeps none of it. `DshWire` fills it and
 * removes what it added when its process ends. */
const sessionStates = new Map<string, SessionState>();

/** What session `id` started on, which `AgentSessions` saves so a resumed
 * session goes back to it: dsh restores only its last request's. */
export const startOf = (id: string) => sessionStates.get(id)?.start;

type Message = {
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const parse = (line: string): Message | undefined => {
  try {
    return record(JSON.parse(line)) as Message | undefined;
  } catch {
    return undefined;
  }
};

/** dsh's config options: the shared type names only what the client reads. */
type DshOption = NonNullable<ConfigOptions["configOptions"]>[number] &
  Readonly<{ id?: string; currentValue?: unknown }>;

/** The selection and levels in a config answer. */
function configState(answer: ConfigOptions) {
  const configOptions: readonly DshOption[] = answer.configOptions ?? [];
  const value = (found?: DshOption) =>
    typeof found?.currentValue === "string" ? found.currentValue : "";
  const thought = configOptions.find(
    (option) => option.category === THOUGHT_CATEGORY,
  );
  return {
    current: {
      model: value(configOptions.find((option) => option.id === MODEL_OPTION)),
      effort: value(thought),
    },
    levels: (thought?.options ?? []).map((option) => option.value),
  };
}

/** A title that also says which saved session to resume. Why a title: it is
 * the only value the shared client hands from `deliver` to `newSessionMeta`
 * unchanged, and dsh takes no titles, so nothing else reads this one. The
 * random part keeps any other title, which may hold a channel's name, from
 * being read as a request to resume. */
const RESUME_TITLE = `dsh-resume:${globalThis.crypto.randomUUID()}:`;
export const resumeTitle = (sessionId: string, start?: Selection) =>
  `${RESUME_TITLE}${JSON.stringify({ sessionId, start })}`;
const resumeOf = (title: string | undefined) =>
  title?.startsWith(RESUME_TITLE)
    ? { [META_KEY]: JSON.parse(title.slice(RESUME_TITLE.length)) }
    : {};

/** Valid only if it comes from `resumeOf`, in a request of this process. */
type Resume = Readonly<{ sessionId: string; start?: Selection }>;

/** The JSON-RPC lines between the shared client and dsh, where each difference
 * the client has no hook for is handled.
 *
 * Why here: the client only speaks `session/new` and has no way to say that a
 * session continues. The turn around it, the tools and the prompts stay the
 * shared ones, since a resume looks to them like an open. */
export class DshWire {
  private pending = "";
  /** The client's `session/new` requests turned into `session/resume`, with
   * what dsh gets if it cannot resume. */
  private readonly resuming = new Map<number, Resume & { fallback: string }>();
  /** The client's `session/new` requests dsh has not answered. */
  private readonly opening = new Set<number>();
  /** Sessions of this process, whose `sessionStates` entries it owns. */
  private readonly opened = new Set<string>();
  /** The bundle probe of this process, until dsh answers it. */
  private probe: number | undefined;
  /** Whether this process has the bundle. False until the probe says it does:
   * a `/compact` may never reach the model on a guess. */
  private bundled = false;

  constructor(
    private readonly deliver: (data: string) => void,
    /** Writes to dsh directly, for the `session/new` after a failed resume. */
    private readonly send: (line: string) => Promise<void>,
    /** The process's profile, for the words of a refusal. */
    private readonly profile: string,
  ) {}

  /** What the client writes, as dsh must get it. */
  outgoing(data: string): string {
    return data
      .split("\n")
      .map((line) => this.write(line))
      .filter((line) => line !== undefined)
      .join("\n");
  }

  /** What dsh writes, handed to the client in whole lines. */
  incoming(data: string) {
    this.pending += data;
    const end = this.pending.lastIndexOf("\n");
    if (end < 0) return;
    const lines = this.pending.slice(0, end).split("\n");
    this.pending = this.pending.slice(end + 1);
    const out = lines.flatMap((line) => (line.trim() ? this.read(line) : []));
    if (out.length) this.deliver(`${out.join("\n")}\n`);
  }

  /** The process ended: its sessions are gone, with what is kept for them. */
  dispose() {
    for (const sessionId of this.opened) sessionStates.delete(sessionId);
    this.opened.clear();
  }

  /** Answers request `id` with an error, without dsh; after the write that
   * sent it returns, as an answer read from dsh would come. */
  private refuse(id: number, error: string) {
    queueMicrotask(() =>
      this.deliver(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: ADAPTER_ERROR, message: error },
        })}\n`,
      ),
    );
  }

  /** Why dsh must not get this prompt, if it must not. Only the exact `/compact`
   * compacts in the bundle: with the Buzz prompt leading it, it would also be a
   * paid turn, and that happens only when no turn has run. */
  private refusal({ prompt }: Record<string, unknown>) {
    const [first, ...rest] = Array.isArray(prompt) ? prompt : [];
    const text = rest.length ? undefined : record(first)?.text;
    if (typeof text !== "string") return undefined;
    if (text.trim() === COMPACT)
      return this.bundled ? undefined : noBundle(this.profile);
    return text.endsWith(LED_COMPACT) ? NOTHING_TO_COMPACT : undefined;
  }

  private write(line: string): string | undefined {
    const message = line.trim() ? parse(line) : undefined;
    if (!message) return line;
    if (message.method === SESSION_PROMPT && typeof message.id === "number") {
      const refusal = this.refusal(message.params ?? {});
      if (refusal === undefined) return line;
      this.refuse(message.id, refusal);
      return undefined;
    }
    if (message.method === STEER && !Object.keys(message.params ?? {}).length) {
      if (typeof message.id === "number") this.probe = message.id;
      return line;
    }
    if (message.method === SESSION_CLOSE) {
      const sessionId = message.params?.sessionId;
      if (typeof sessionId === "string") {
        this.opened.delete(sessionId);
        sessionStates.delete(sessionId);
      }
      return line;
    }
    if (message.method !== SESSION_NEW || typeof message.id !== "number")
      return line;
    const { _meta: meta, ...params } = message.params ?? {};
    const open = JSON.stringify({ ...message, params });
    const resume = record(meta)?.[META_KEY] as Resume | undefined;
    if (!resume) {
      this.opening.add(message.id);
      return open;
    }
    this.resuming.set(message.id, { ...resume, fallback: open });
    return JSON.stringify({
      ...message,
      method: SESSION_RESUME,
      params: {
        sessionId: resume.sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
      },
    });
  }

  private read(line: string): string[] {
    const message = parse(line);
    if (!message) return [line];
    if (message.method === REQUEST_PERMISSION) return [noLastingGrant(message)];
    if (message.method !== undefined || typeof message.id !== "number")
      return [line];
    const info = record(record(message.result)?.agentInfo);
    if (typeof info?.version === "string") version = info.version;
    if (message.id === this.probe) {
      this.probe = undefined;
      this.bundled = codeOf(message.error) === INVALID_PARAMS;
      return [line];
    }
    const resume = this.resuming.get(message.id);
    if (resume) return this.resumed(message.id, resume, message, line);
    if (this.opening.delete(message.id)) {
      const { sessionId } = record(message.result) ?? {};
      if (typeof sessionId === "string")
        this.track(sessionId, message.result as ConfigOptions);
    }
    return [line];
  }

  /** dsh's answer to a resume. The client gets it as a `session/new` answer,
   * with the session id that answer has and a resume answer does not. One that
   * failed becomes a new session instead: the conversation shows again, so
   * this costs context, not the message. */
  private resumed(
    id: number,
    { sessionId, start, fallback }: Resume & { fallback: string },
    message: Message,
    line: string,
  ): string[] {
    this.resuming.delete(id);
    if (message.error) {
      // Never the request: it holds the session's MCP token.
      console.warn("dsh could not resume a session, starting a new one", {
        operation: SESSION_RESUME,
        sessionId,
        code: codeOf(message.error),
        cause: errorMessage(message.error),
      });
      this.opening.add(id);
      void this.send(`${fallback}\n`).catch((error: unknown) => {
        console.warn("dsh did not take the new session", {
          operation: SESSION_NEW,
          sessionId,
          error,
        });
        this.opening.delete(id);
        this.deliver(`${line}\n`);
      });
      return [];
    }
    const result = { ...record(message.result), sessionId };
    this.track(sessionId, result as ConfigOptions, start);
    return [JSON.stringify({ ...message, result })];
  }

  private track(sessionId: string, opened: ConfigOptions, start?: Selection) {
    const state = configState(opened);
    this.opened.add(sessionId);
    sessionStates.set(sessionId, { ...state, start: start ?? state.current });
  }
}

/** A permission request without its lasting grant. The client prefers that
 * option, as Goose wants; a dsh agent is allowed one call at a time, as this
 * plugin always did, so no grant outlives the session's work. */
function noLastingGrant(message: Message) {
  const options = message.params?.options;
  const kept = Array.isArray(options)
    ? options.filter((option) => record(option)?.kind !== LASTING_GRANT)
    : options;
  return JSON.stringify({
    ...message,
    params: { ...message.params, options: kept },
  });
}

/** `spawn`, with dsh's JSON-RPC lines going through a `DshWire`. The host of
 * every `dsh` passes through this (src/index.ts), so what sits above it, the
 * shared client and the Activity record, reads plain ACP: a resumed session
 * looks opened, with the id and state a `session/new` answer has. */
export function dshSpawn(spawn: Spawn, profile: string): Spawn {
  return async (id, options) => {
    const onStdout = options?.onStdout;
    if (!onStdout) return spawn(id, options);
    let write: ((data: string) => Promise<void>) | undefined;
    const wire = new DshWire(
      onStdout,
      (line) =>
        write
          ? write(line)
          : Promise.reject(new DshError("write", "dsh is not running")),
      profile,
    );
    const child = await spawn(id, {
      ...options,
      onStdout: (data) => wire.incoming(data),
    });
    write = (data) => child.write(data);
    void child.exited.then(
      () => wire.dispose(),
      () => wire.dispose(),
    );
    return {
      ...child,
      // A refused prompt leaves nothing to write.
      write: (data) => {
        const out = wire.outgoing(data);
        return out.trim() ? child.write(out) : Promise.resolve();
      },
      end: (data) =>
        child.end(data === undefined ? undefined : wire.outgoing(data)),
    };
  };
}

/** Sets one option, keeping the session's state to what dsh then reports. */
async function configure(
  dsh: AcpProcess,
  session: { readonly id: string; offer(options: ConfigOptions): void },
  state: SessionState,
  configId: string,
  value: string,
) {
  const answer = (await dsh.request(
    "session/set_config_option",
    { sessionId: session.id, configId, value },
    REQUEST_TIMEOUT_MS,
  )) as ConfigOptions;
  session.offer(answer);
  Object.assign(state, configState(answer));
}

/** Goes back to what a session started on when no choice names it. That value
 * came from dsh, and can be gone from its config since: the turn then runs on
 * what the session is on now, which a chosen value must never do. */
async function configureStart(
  ...args: Parameters<typeof configure>
): Promise<void> {
  try {
    await configure(...args);
  } catch (error) {
    console.warn("dsh could not go back to what a session started on", {
      operation: "session/set_config_option",
      sessionId: args[1].id,
      configId: args[3],
      value: args[4],
      error,
    });
  }
}

/** What dsh adds to plain ACP. */
export const DSH: AcpHooks = {
  label: LABEL,
  program: PROCESS_ID,
  missing:
    "dsh is not installed or cannot start. Install DeepSeek Harness, then run `scripts/setup-buzz-profile` in the plugin's checkout.",
  // `dsh` is found on PATH, and its launcher runs through `env`: exit 126 or
  // 127 means it is missing.
  diagnoseStartup: true,
  // Its provider keys stay in its own profile: nothing is added here. The
  // shared client always removes the Buzz identity from the environment.
  env: {},
  newSessionMeta: (_buzz, { title }) => resumeOf(title),
  // dsh's model ids are whole `["provider","model"]` strings, so the provider
  // field of the shared choice stays empty. Model first, since it decides which
  // efforts exist. A resumed session starts on what dsh restored, not on what
  // was chosen, so comparing with its current values re-applies both after a
  // resume by construction. `session.chosen.effort` stays empty: the shared
  // client would drop the session each time a choice clears it.
  select: async (dsh, session, want) => {
    const state = sessionStates.get(session.id);
    if (!state)
      throw new DshError("select", "dsh has no such session", session.id);
    const pick = async (configId: string, value: string, fallback: boolean) => {
      try {
        const args = [dsh, session, state, configId, value] as const;
        await (fallback ? configureStart(...args) : configure(...args));
      } catch (error) {
        throw new DshError(
          "select",
          `dsh could not switch its ${configId} to ${value}: ${errorMessage(error)}`,
          session.id,
          { cause: error },
        );
      }
    };
    const model = want.model || state.start.model;
    if (model && model !== state.current.model)
      await pick(MODEL_OPTION, model, !want.model);
    const effort = want.effort || state.start.effort;
    if (
      effort &&
      effort !== state.current.effort &&
      // The model chosen may not offer what the session started on.
      (want.effort || state.levels.includes(effort))
    )
      await pick(EFFORT_OPTION, effort, !want.effort);
    session.chosen = { ...session.chosen, model: want.model };
  },
};

/** Steering through the bundle (dsh-acp-buzz/README.md): the same shape as
 * Goose's hook (buzz-app bundled/goose/goose.ts), in the bundle's `_meta` key
 * and method. The bundle answers a steer at once, so it has a timeout, unlike a
 * turn's prompt. A throw makes the client run the text as the next turn. */
const STEERING: NonNullable<AcpHooks["steering"]> = {
  runId: (update) => {
    if (update.sessionUpdate !== "session_info_update") return null;
    const dsh = record(record(update._meta)?.dsh);
    if (!dsh || !("activeRunId" in dsh)) return null;
    return typeof dsh.activeRunId === "string" ? dsh.activeRunId : undefined;
  },
  steer: async (dsh, sessionId, runId, text) => {
    try {
      await dsh.request(
        STEER,
        {
          sessionId,
          prompt: [{ type: "text", text }],
          expectedRunId: runId,
        },
        REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      throw new DshError(
        "steer",
        `dsh did not take the steer for run ${runId}: ${errorMessage(error)}`,
        sessionId,
        { cause: error },
      );
    }
  },
};

/** Asks whether the bundle is on this process's profile (the header). */
async function hasBundle(dsh: AcpProcess) {
  try {
    await dsh.request(STEER, {}, REQUEST_TIMEOUT_MS);
    console.warn("dsh accepted a steer that is bound to fail", {
      operation: STEER,
    });
    return false;
  } catch (error) {
    const code = codeOf(error);
    if (code === INVALID_PARAMS) return true;
    if (code !== METHOD_NOT_FOUND)
      console.warn("dsh gave no clear answer about the bundle", {
        operation: STEER,
        code,
        error,
      });
    return false;
  }
}

/** Whether `dsh` has the bundle, as its probe found. */
export const bundled = (dsh: AcpProcess) => Boolean(dsh.hooks.steering);

/** Starts `dsh`. The name is the one the Goose sessions code imports. */
export const GooseProcess = {
  start: async (
    spawn: Spawn,
    launch: Readonly<{
      cwd: string;
      env?: Readonly<Record<string, string | null>>;
      serve?: ServeMcp;
    }>,
  ): Promise<AcpProcess> => {
    // Its own hooks: each process may have a profile with or without the
    // bundle, and the client reads `steering` at each use.
    const hooks: { -readonly [K in keyof AcpHooks]: AcpHooks[K] } = { ...DSH };
    const dsh = await AcpProcess.start(spawn, hooks, launch);
    if (await hasBundle(dsh)) hooks.steering = STEERING;
    return dsh;
  },
};
