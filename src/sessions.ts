// One agent's dsh sessions, in the `dsh --profile <profile>` process all agents
// on that profile share. The sessions themselves live in the shared ACP client.
// Adapted from buzz-app src/bundled/goose/sessions.ts (Apache-2.0, see NOTICE).
// The build puts this module in place of that file (scripts/build-plugin.mjs,
// SWAPS), so the Goose runtime keeps its exports and names.
import {
  AgentSessions as AcpAgentSessions,
  type SavedConversation as AcpSavedConversation,
  type SessionsOptions as AcpSessionsOptions,
  type SessionStore,
} from "@app/features/agent-harness/acp/agent-sessions";
import type { AcpProcess } from "@app/features/agent-harness/acp/process";
import type { AgentStore } from "@app/features/agents/store";
import {
  type GooseHost,
  GooseProcess,
  LABEL,
  resumeTitle,
  type Selection,
  type ServeMcp,
  startOf,
} from "./dsh";

export {
  abortable,
  absolute,
  IDLE_MS,
  type Launch,
  POOL_LIMIT,
  ServerPool,
  type SessionStore,
} from "@app/features/agent-harness/acp/agent-sessions";

/** Saved conversations per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;
/** The agent storage key of an agent's saved conversations, before its agent
 * key. The plugin's first version saved its sessions here, as
 * `{ "<channel>/<root>": { id, at } }`, so its saved conversations stay. */
export const SESSIONS_PREFIX = "sagmans.dsh/sessions/";

/** A conversation's saved state: dsh's session for it, to resume, and what
 * that session started on. Records of the plugin's first version have no
 * `start`, and a conversation not yet handed a message has no `id`. */
export type SavedConversation = AcpSavedConversation &
  Readonly<{ id?: string; start?: Selection }>;

/** What `localSessions` adds to the shared store for resuming. */
export type DshStore = SessionStore &
  Readonly<{
    /** Saved conversations, most recently used first. */
    list(): [string, SavedConversation][];
    record(conversation: string): SavedConversation | undefined;
    /** Notes the session a conversation runs in now. */
    link(conversation: string, id: string, start?: Selection): void;
    /** Forgets its session, keeping the conversation in the list. */
    forget(conversation: string): void;
  }>;

/** The one `dsh` every agent's sessions on one profile open in, started in the
 * home folder when a session first needs it, and again after it exits. One
 * runtime shares one, and the plugin keeps one runtime per profile. */
export class SharedProcess {
  private ready: Promise<AcpProcess> | undefined;
  constructor(
    private readonly host: GooseHost,
    /** Starts a session's MCP server for its agent's tools. */
    private readonly serve: ServeMcp,
  ) {}

  /** The running process. One that failed to start is started again on the
   * next call. */
  get(): Promise<AcpProcess> {
    if (this.ready) return this.ready;
    const ready = (async () =>
      GooseProcess.start(this.host.spawn, {
        cwd: await this.host.resolveDirectory("~"),
        serve: this.serve,
      }))();
    const forget = () => {
      if (this.ready === ready) this.ready = undefined;
    };
    void ready.then((dsh) => dsh.exited.then(forget), forget);
    this.ready = ready;
    return ready;
  }

  /** Stops it, failing every session in it. One that failed to start has
   * nothing to stop. */
  stop() {
    const ready = this.ready;
    this.ready = undefined;
    void ready
      ?.then((dsh) => dsh.kill())
      .catch((error: unknown) =>
        console.warn("dsh did not stop", { operation: "stop", error }),
      );
  }
}

export type SessionsOptions = Omit<AcpSessionsOptions, "label">;

/** An agent's sessions, in the process of its profile. Beyond the shared ones,
 * each conversation remembers its dsh session across restarts of the app, and
 * asks to resume it when it opens again. */
export class AgentSessions extends AcpAgentSessions {
  private readonly saved: DshStore | undefined;

  constructor(options: SessionsOptions) {
    super({
      ...options,
      label: LABEL,
      onChange: () => {
        this?.remember();
        options.onChange?.();
      },
    });
    // Always one of ours: `localSessions` below is what the runtime gets.
    this.saved = options.store as DshStore | undefined;
  }

  private remember() {
    for (const { key, sessionId } of this.snapshot())
      if (sessionId && this.saved?.record(key)?.id !== sessionId)
        this.saved?.link(key, sessionId, startOf(sessionId));
  }

  /** A message of `key`. If it opens a session, that one resumes the saved
   * one. Only conversations have a saved one: a one-off turn has no place here
   * and stays a new session. */
  override deliver(...[key, text, seen, options]: DeliverArgs) {
    const record = this.saved?.record(key);
    return super.deliver(key, text, seen, {
      ...options,
      ...(record?.id ? { title: resumeTitle(record.id, record.start) } : {}),
    });
  }

  /** `new` must not resume what it ends. Forgotten after it ended: a change
   * while its turn runs would save the id again. */
  override async reset(
    key: string,
    action: Parameters<AcpAgentSessions["reset"]>[1],
  ) {
    const settled = await super.reset(key, action);
    if (action === "new") this.saved?.forget(key);
    return settled;
  }
}
type DeliverArgs = Parameters<AcpAgentSessions["deliver"]>;

/** Conversations saved in agent storage. The Goose runtime hands this its
 * fourth constructor argument, which `src/index.ts` sets to `agents.storage`:
 * saved dsh conversations live where the plugin's first version saved them,
 * not in the app's local storage. */
export function localSessions(
  storage: AgentStore,
  agent: string,
  prefix = SESSIONS_PREFIX,
): DshStore {
  const key = `${prefix}${agent}`;
  const readAll = (): Record<string, SavedConversation> => {
    try {
      const value = JSON.parse(storage.get(key) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch (error) {
      console.warn("dsh sessions could not be read", {
        operation: "localSessions.read",
        agent,
        error,
      });
      return {};
    }
  };
  const list = (saved: Record<string, SavedConversation>) =>
    Object.entries(saved)
      .filter(([, conversation]) => typeof conversation?.at === "number")
      .sort(([, a], [, b]) => b.at - a.at);
  const write = (all: Record<string, SavedConversation>, label: string) =>
    storage
      .set(
        key,
        JSON.stringify(Object.fromEntries(list(all).slice(0, SAVED_LIMIT))),
      )
      .catch((error: unknown) =>
        console.warn("dsh sessions were not saved", {
          operation: "localSessions.write",
          agent,
          conversation: label,
          error,
        }),
      );
  return {
    list: () => list(readAll()),
    get: (conversation) => readAll()[conversation],
    record: (conversation) => readAll()[conversation],
    set: (conversation, saved) => {
      const all = readAll();
      void write(
        { ...all, [conversation]: { ...all[conversation], ...saved } },
        conversation,
      );
    },
    link: (conversation, id, start) => {
      const all = readAll();
      void write(
        {
          ...all,
          [conversation]: {
            at: Date.now(),
            ...all[conversation],
            id,
            ...(start ? { start } : {}),
          },
        },
        conversation,
      );
    },
    forget: (conversation) => {
      const all = readAll();
      const saved = all[conversation];
      if (!saved) return;
      const { id: _id, start: _start, ...rest } = saved;
      void write({ ...all, [conversation]: rest }, conversation);
    },
  };
}
