// A local record of what agents and their ACP harness said to each other, for
// the agent's Activity tab and its usage. The app's own agent types read their
// harness's session store for this; an ACP harness that keeps none the app can
// read gets this record instead.
//
// `tapSpawn` taps a harness process's line-delimited JSON-RPC; plugins also use
// it to adjust what passes between the app's shared ACP client and the harness.
// `ActivityRecorder` files each frame under the turn and agent it belongs to,
// in the shape the app's activity transcript reads (features/agents/
// activity-transcript.ts: `turnId`, `kind`, `channelId`, `sessionId`,
// `timestamp`, `agentIndex`, `payload`). Which agent and conversation a turn is
// for comes from its prompt's `<context>` section, which every Buzz prompt
// carries (`Agent:`, `Channel:`, `Thread root:`), so the record needs nothing
// from the harness or the runtime beyond the wire.
//
// Privacy: prompts and tool calls carry private chat text and whatever the
// agent read. The record stays on this device in agent storage only (never the
// relay, never a file), is bounded per conversation and per agent, and elides
// oversized text. Requests that hold credentials stay out (RECORDED_REQUESTS).
//
// Harness-neutral on purpose: nothing here names a harness, so the same file
// serves every ACP agent-type plugin built on the app's shared ACP client.
import {
  promptMessage,
  promptSections,
} from "@app/features/agents/activity-transcript";
import type { AgentStore } from "@app/features/agents/store";
import type { Spawn } from "@app/features/agent-harness/acp/types";
import type {
  HostProcess,
  HostProcessOptions,
} from "@app/features/host/service";

/** The turns kept per conversation; the app's own Activity tab shows the
 * latest 50 turns. */
export const TURNS_PER_CONVERSATION = 50;
/** Each agent's record stays under this many UTF-8 bytes, oldest turns dropped
 * first: agent storage takes 4 MiB a value and the app reads all of it at
 * startup (the app keeps its saved session prompts to the same size). */
const AGENT_BUDGET_BYTES = 1_000_000;
/** One turn's share of it: a runaway turn must not push out every other. */
const TURN_BUDGET_BYTES = 400_000;
/** A string in a frame is cut to this many characters; a prompt's, which holds
 * the thread's context, to more. */
const TEXT_LIMIT = 8_000;
const PROMPT_TEXT_LIMIT = 64_000;
/** Frames held for a session until its next turn, and sessions tracked per
 * process, so a session no prompt names cannot grow without bound. */
const EARLY_FRAMES = 200;
const SESSIONS_TRACKED = 200;
/** Writes to agent storage are batched while a turn streams: the app persists
 * each one to disk. A turn's start and end write at once. */
const PERSIST_DELAY_MS = 5_000;
/** Views hear of changes at most this often while a turn streams. */
const NOTIFY_DELAY_MS = 250;
const RECORD_VERSION = 1;
/** The marker the app's transcript reads as cut text (activity-transcript.ts). */
const ELIDED = "…[elided ";
/** Agent keys from a prompt become storage keys. */
const AGENT_KEY_SHAPE = /^\S{1,300}$/;
/** The requests to the harness that go on record, as nothing else may: a
 * `session/new` holds the session's MCP bearer token, and another request could
 * hold other credentials one day. The answers name the session's options and
 * state only. */
const RECORDED_REQUESTS = new Set([
  "session/set_config_option",
  "session/set_mode",
  "session/cancel",
]);
const STANDALONE_SCOPE = "standalone";
const PROMPT_METHOD = "session/prompt";
const NEW_METHOD = "session/new";
const UPDATE_METHOD = "session/update";
const CHUNKS = new Set(["agent_message_chunk", "agent_thought_chunk"]);
/** What a turn cut short by an app exit says. */
const INTERRUPTED = "The app stopped before this turn ended";

/** One JSON-RPC message on the wire. */
export type Wire = Record<string, unknown>;

/** Observes, and may rewrite, one ACP process's JSON-RPC. */
export type WireTap = Readonly<{
  /** The client wrote `message` to the harness. */
  written?(message: Wire): void;
  /** The harness wrote `message`; returns what the client gets instead, or
   * undefined to pass it on unchanged. */
  read?(message: Wire): readonly Wire[] | undefined;
  /** The process has started. */
  attached?(process: HostProcess): void;
  /** The process has exited. */
  exited?(): void;
}>;

/** A frame as the app's activity transcript reads it. */
export type Frame = Readonly<{
  turnId: string;
  kind: string;
  channelId?: string;
  sessionId: string;
  timestamp: string;
  agentIndex: number;
  payload: unknown;
}>;

/** Token counts a harness reported for one turn (ACP `PromptResponse.usage`). */
export type TurnUsage = Readonly<{
  input?: number;
  output?: number;
  thought?: number;
  cacheRead?: number;
  cacheWrite?: number;
}>;

/** One recorded turn: a `session/prompt` and everything on the wire for it. */
export type RecordedTurn = {
  id: string;
  sessionId: string;
  /** The conversation it belongs to: `channel` or `channel/root`, empty for a
   * standalone (watch or timer) turn. */
  conversation: string;
  channelId?: string;
  root?: string;
  /** The first line of the Buzz message the turn answers. */
  title?: string;
  startedAt: number;
  lastAt: number;
  endedAt?: number;
  /** The model the session reported when the turn ended. */
  model?: string;
  usage?: TurnUsage;
  /** The session's total cost in USD when the turn ended, as the harness
   * reported it (ACP `usage_update.cost`). */
  cost?: number;
  /** Frames left out for the per-turn budget. */
  dropped?: number;
  /** About how many bytes its frames take. */
  size?: number;
  frames: Frame[];
};

type Stored = {
  version: number;
  turns: RecordedTurn[];
  dropped: Record<string, number>;
};

/** An agent's record: turns oldest first, and per session how many of its
 * turns the bounds dropped. */
type AgentRecord = { turns: RecordedTurn[]; dropped: Map<string, number> };

/** Where a prompt says its turn is for. */
export type PromptPlace = Readonly<{
  agent?: string;
  channelId?: string;
  root?: string;
  title?: string;
  standalone?: boolean;
}>;

export const object = (value: unknown): Wire | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Wire)
    : undefined;
export const str = (value: unknown) => (typeof value === "string" ? value : "");

/** The text of a `session/prompt` request's prompt blocks. */
export function promptText(message: Wire) {
  const prompt = object(message.params)?.prompt;
  return Array.isArray(prompt)
    ? prompt
        .map((block) => str(object(block)?.text))
        .filter(Boolean)
        .join("\n")
    : "";
}

/** Splits a stream into lines; a partial line waits for its end. */
class Lines {
  private buffer = "";
  push(data: string): string[] {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines;
  }
}

const parse = (line: string): Wire | undefined => {
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
};

/** `spawn`, with each process's JSON-RPC lines shown to a tap from `open`,
 * which may replace what the client reads. Lines that are not JSON pass on
 * untouched, as the client skips them itself. A wrapper object rather than a
 * spread: the host's process may keep its methods on a prototype. */
export function tapSpawn(spawn: Spawn, open: () => WireTap): Spawn {
  return async (id, options: HostProcessOptions = {}) => {
    const tap = open();
    const stdout = new Lines();
    const stdin = new Lines();
    const onStdout = options.onStdout;
    const process = await spawn(id, {
      ...options,
      onStdout: (data) => {
        let out = "";
        for (const line of stdout.push(data)) {
          const message = parse(line);
          const replaced = message && tap.read?.(message);
          out += replaced
            ? replaced.map((item) => `${JSON.stringify(item)}\n`).join("")
            : `${line}\n`;
        }
        if (out) onStdout?.(out);
      },
    });
    tap.attached?.(process);
    void process.exited.then(
      () => tap.exited?.(),
      () => tap.exited?.(),
    );
    return {
      write: (data: string) => {
        for (const line of stdin.push(data)) {
          const message = parse(line);
          if (message) tap.written?.(message);
        }
        return process.write(data);
      },
      end: (data?: string) => process.end(data),
      kill: () => process.kill(),
      exited: process.exited,
    };
  };
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const utf8 = (text: string) => new TextEncoder().encode(text).length;

/** The first `<context>` section of `text` that names an agent: where it starts
 * and what it says. The first, because the app writes it ahead of the message:
 * a later one could be chat text pretending to be the app's. What leads it on a
 * session's first prompt is the system prompt, which names no agent this way. */
function firstContext(text: string) {
  const open = "<context>\n";
  const close = "\n</context>";
  let start = text.startsWith(open) ? 0 : text.indexOf(`\n${open}`) + 1;
  while (start > 0 || text.startsWith(open)) {
    const end = text.indexOf(close, start);
    if (end < 0) return undefined;
    const body = text.slice(start + open.length, end);
    if (/^Agent: /m.test(body)) return { start, body };
    const next = text.indexOf(`\n${open}`, end);
    if (next < 0) return undefined;
    start = next + 1;
  }
  return undefined;
}

/** Who and where a Buzz prompt's `<context>` names. */
export function promptPlace(text: string): PromptPlace {
  const context = firstContext(text);
  if (!context) return {};
  const field = (name: string) =>
    new RegExp(`^${name}: (.*)$`, "m").exec(context.body)?.[1]?.trim();
  const channel = field("Channel");
  const channelId =
    channel && (/\(#([^)\s]+)\)$/.exec(channel)?.[1] ?? channel);
  const root =
    field("Session scope") === "thread" ? field("Thread root") : undefined;
  const title = promptMessage(promptSections(text.slice(context.start)))
    .text.split("\n", 1)[0]
    ?.trim();
  const agent = field("Agent");
  return {
    ...(agent && AGENT_KEY_SHAPE.test(agent) ? { agent } : {}),
    ...(channelId ? { channelId } : {}),
    ...(root ? { root } : {}),
    ...(title ? { title } : {}),
    ...(field("Scope") === STANDALONE_SCOPE ? { standalone: true } : {}),
  };
}

/** A `session/prompt` without the system prompt that leads a session's first
 * prompt when the harness takes none: the app keeps that apart and shows it at
 * the top of the transcript, and it is most of what a record would hold. */
function withoutPreamble(message: Wire): Wire {
  const params = object(message.params);
  const prompt = params?.prompt;
  if (!Array.isArray(prompt)) return message;
  const blocks = prompt.map((block) => {
    const text = str(object(block)?.text);
    return { block, context: firstContext(text), text };
  });
  const index = blocks.findIndex(({ context }) => context);
  const found = blocks[index];
  if (!found?.context) return message;
  return {
    ...message,
    params: {
      ...params,
      prompt: [
        { ...object(found.block), text: found.text.slice(found.context.start) },
        ...prompt.slice(index + 1),
      ],
    },
  };
}

/** `value` with every string over `limit` cut, and marked as the app's
 * transcript expects. */
function clipped(value: unknown, limit = TEXT_LIMIT): unknown {
  if (typeof value === "string")
    return value.length > limit
      ? `${value.slice(0, limit)}${ELIDED}${value.length - limit} characters]`
      : value;
  if (Array.isArray(value)) return value.map((item) => clipped(item, limit));
  const json = object(value);
  if (!json) return value;
  return Object.fromEntries(
    Object.entries(json).map(([key, item]) => [key, clipped(item, limit)]),
  );
}

/** The selected value of the config option in `category`, if any. */
function currentValue(options: unknown, category: string) {
  if (!Array.isArray(options)) return undefined;
  const option = options
    .map(object)
    .find((item) => item?.category === category);
  return str(option?.currentValue) || undefined;
}

/** ACP `PromptResponse.usage` as token counts; absent counts stay unknown. */
function turnUsage(usage: Wire): TurnUsage | undefined {
  const counts: [keyof TurnUsage, unknown][] = [
    ["input", usage.inputTokens],
    ["output", usage.outputTokens],
    ["thought", usage.thoughtTokens],
    ["cacheRead", usage.cachedReadTokens],
    ["cacheWrite", usage.cachedWriteTokens],
  ];
  const known = counts.flatMap(([name, value]) => {
    const number = count(value);
    return number === undefined ? [] : [[name, number] as const];
  });
  return known.length ? Object.fromEntries(known) : undefined;
}

/** What the record knows of one session in one process. */
type SessionState = {
  agent?: string | undefined;
  turn?: RecordedTurn | undefined;
  last?: RecordedTurn | undefined;
  /** Opened by this process with `session/new`, so its first turn is new. */
  fresh: boolean;
  /** No turn of it has been recorded in this process yet. */
  first: boolean;
  configOptions?: unknown;
  cost?: number;
  /** Frames before its next turn: config changes, or the session's opening. */
  pending: Frame[];
};

/** The record of one harness process: which session each message is for, and
 * the turns it is in. It only reads: the client gets each message unchanged. */
class ProcessRecord implements WireTap {
  private readonly sessions = new Map<string, SessionState>();
  /** Our requests by id, with the session each names. */
  private readonly requests = new Map<
    string,
    { method: string; sessionId: string }
  >();
  /** The harness's requests by id (permission prompts), with their session. */
  private readonly asks = new Map<string, string>();
  private turns = 0;

  constructor(
    private readonly recorder: ActivityRecorder,
    /** The process's number: JSON-RPC ids repeat across processes. */
    private readonly slot: number,
  ) {}

  written(message: Wire) {
    const key =
      message.id === undefined ? undefined : JSON.stringify(message.id);
    const method = str(message.method);
    const sessionId = str(object(message.params)?.sessionId);
    if (method && key !== undefined)
      this.requests.set(key, { method, sessionId });
    if (method === PROMPT_METHOD) return this.start(sessionId, message);
    if (method) {
      if (RECORDED_REQUESTS.has(method))
        this.frame(sessionId, "acp_write", message);
      return;
    }
    // Our answer to the harness's own request.
    const asked = key === undefined ? undefined : this.asks.get(key);
    if (key !== undefined) this.asks.delete(key);
    if (asked) this.frame(asked, "acp_write", message);
  }

  read(message: Wire): undefined {
    const key =
      message.id === undefined ? undefined : JSON.stringify(message.id);
    const method = str(message.method);
    if (!method && key !== undefined) return this.answered(key, message);
    const params = object(message.params) ?? {};
    const sessionId = str(params.sessionId);
    if (method && key !== undefined) this.asks.set(key, sessionId);
    if (method === UPDATE_METHOD)
      this.noted(sessionId, object(params.update) ?? {});
    this.frame(sessionId, "acp_read", message);
    return undefined;
  }

  exited() {
    for (const state of this.sessions.values())
      if (state.turn) this.end(state, { error: "The harness process exited" });
    this.sessions.clear();
  }

  /** An answer to one of our requests. */
  private answered(key: string, message: Wire): undefined {
    const request = this.requests.get(key);
    this.requests.delete(key);
    if (!request) return undefined;
    const result = object(message.result) ?? {};
    let { sessionId } = request;
    if (request.method === NEW_METHOD) {
      sessionId = str(result.sessionId);
      if (!sessionId) return undefined;
      this.state(sessionId).fresh = true;
    }
    if (result.configOptions !== undefined)
      this.state(sessionId).configOptions = result.configOptions;
    this.frame(sessionId, "acp_read", message);
    if (request.method === PROMPT_METHOD) {
      const error = object(message.error);
      this.end(this.state(sessionId), {
        ...(error
          ? { error: str(error.message) || "The harness refused the prompt" }
          : {}),
        usage: object(result.usage),
      });
    }
    return undefined;
  }

  /** What a `session/update` says about the session itself. */
  private noted(sessionId: string, update: Wire) {
    const kind = str(update.sessionUpdate);
    const state = this.state(sessionId);
    if (kind === "usage_update") {
      const cost = count(object(update.cost)?.amount);
      if (cost !== undefined) state.cost = cost;
    } else if (
      kind === "config_option_update" &&
      update.configOptions !== undefined
    )
      state.configOptions = update.configOptions;
  }

  private state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      if (this.sessions.size >= SESSIONS_TRACKED)
        for (const [id, held] of this.sessions)
          if (!held.turn) {
            this.sessions.delete(id);
            break;
          }
      state = { fresh: false, first: true, pending: [] };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** A `session/prompt` starts a turn, filed under the agent its context names:
   * the session's first such prompt binds it, as one session serves one agent. */
  private start(sessionId: string, message: Wire) {
    const state = this.state(sessionId);
    const place = promptPlace(promptText(message));
    state.agent ??= place.agent;
    const agent = state.agent;
    if (!agent) return;
    const now = Date.now();
    // A prompt the client writes itself (a compact) names no place: it stays
    // in the session's conversation.
    const channelId = place.standalone
      ? undefined
      : (place.channelId ?? state.last?.channelId);
    const root = place.root ?? state.last?.root;
    const turn: RecordedTurn = {
      id: `${this.recorder.run}-${this.slot}-${++this.turns}`,
      sessionId,
      conversation: channelId
        ? root
          ? `${channelId}/${root}`
          : channelId
        : "",
      ...(channelId ? { channelId } : {}),
      ...(root ? { root } : {}),
      ...(place.title ? { title: place.title } : {}),
      startedAt: now,
      lastAt: now,
      frames: [],
    };
    turn.frames.push(
      this.make(turn, "turn_started", {
        source: "buzz",
        ...(root ? { threadRootEventId: root } : {}),
      }),
      ...(state.first
        ? [
            this.make(turn, "session_resolved", {
              sessionId,
              isNewSession: state.fresh,
            }),
          ]
        : []),
      ...(state.configOptions === undefined
        ? []
        : [
            this.make(turn, "session_config_captured", {
              configOptions: state.configOptions,
            }),
          ]),
      ...state.pending.map((frame) => ({
        ...frame,
        turnId: turn.id,
        ...(channelId ? { channelId } : {}),
      })),
    );
    state.first = false;
    state.pending = [];
    state.turn = turn;
    this.recorder.add(agent, turn);
    this.push(
      turn,
      this.make(
        turn,
        "acp_write",
        clipped(withoutPreamble(message), PROMPT_TEXT_LIMIT),
      ),
    );
  }

  private end(
    state: SessionState,
    outcome: Readonly<{ error?: string; usage?: Wire | undefined }>,
  ) {
    const turn = state.turn;
    if (!turn || !state.agent) return;
    const now = Date.now();
    turn.endedAt = now;
    turn.lastAt = now;
    const model = currentValue(state.configOptions, "model");
    if (model) turn.model = model;
    const usage = outcome.usage && turnUsage(outcome.usage);
    if (usage) turn.usage = usage;
    if (state.cost !== undefined) turn.cost = state.cost;
    // Past the budget too: without it the turn never reads as ended.
    turn.frames.push(
      outcome.error
        ? this.make(turn, "turn_error", { error: outcome.error })
        : this.make(turn, "turn_completed", {}),
    );
    state.last = turn;
    state.turn = undefined;
    this.recorder.changed(state.agent, true);
  }

  /** Files a wire message under its session's turn: the running one, else the
   * latest for a late update, else the next one. */
  private frame(
    sessionId: string,
    kind: "acp_write" | "acp_read",
    message: Wire,
  ) {
    if (!sessionId) return;
    const state = this.state(sessionId);
    const late = str(message.method) === UPDATE_METHOD ? state.last : undefined;
    const turn = state.turn ?? late;
    if (!turn || !state.agent) {
      if (state.pending.length < EARLY_FRAMES)
        state.pending.push(
          this.make(undefined, kind, clipped(message), sessionId),
        );
      return;
    }
    if (!this.merged(turn, kind, message))
      this.push(turn, this.make(turn, kind, clipped(message)));
    turn.lastAt = Date.now();
    this.recorder.changed(state.agent, false);
  }

  /** Joins a streamed text chunk to the one before it, as the transcript joins
   * them anyway: a frame per token would fill the budget. */
  private merged(turn: RecordedTurn, kind: string, message: Wire) {
    const update = object(object(message.params)?.update);
    const type = str(update?.sessionUpdate);
    if (kind !== "acp_read" || !CHUNKS.has(type)) return false;
    const text = str(object(update?.content)?.text);
    const last = turn.frames.at(-1);
    const prior = object(object(object(last?.payload)?.params)?.update);
    if (last?.kind !== kind || str(prior?.sessionUpdate) !== type) return false;
    if (str(prior?.messageId) !== str(update?.messageId)) return false;
    const content = object(prior?.content);
    if (typeof content?.text !== "string") return false;
    const before = content.text.length;
    if (before < TEXT_LIMIT) content.text = clipped(content.text + text);
    turn.size = (turn.size ?? 0) + Math.min(text.length, TEXT_LIMIT - before);
    return true;
  }

  private push(turn: RecordedTurn, frame: Frame) {
    const size = JSON.stringify(frame).length;
    if ((turn.size ?? 0) + size > TURN_BUDGET_BYTES) {
      turn.dropped = (turn.dropped ?? 0) + 1;
      return;
    }
    turn.size = (turn.size ?? 0) + size;
    turn.frames.push(frame);
  }

  private make(
    turn: RecordedTurn | undefined,
    kind: string,
    payload: unknown,
    sessionId = turn?.sessionId ?? "",
  ): Frame {
    return {
      turnId: turn?.id ?? "",
      kind,
      ...(turn?.channelId ? { channelId: turn.channelId } : {}),
      sessionId,
      timestamp: new Date().toISOString(),
      agentIndex: this.slot,
      payload,
    };
  }
}

/** Every agent's turns in the processes it taps, kept in agent storage under
 * `prefix` + agent key. */
export class ActivityRecorder {
  /** This load's id, so turn ids never repeat across app runs. */
  readonly run = Date.now().toString(36);
  private readonly agents = new Map<string, AgentRecord>();
  private readonly dirty = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private slots = 0;
  private revisionCount = 0;

  constructor(
    private readonly store: AgentStore,
    private readonly prefix: string,
  ) {}

  /** `spawn`, with every process it starts recorded. */
  tap(spawn: Spawn): Spawn {
    return tapSpawn(spawn, () => new ProcessRecord(this, ++this.slots));
  }

  /** The agent's turns, oldest first. */
  turns(agent: string): readonly RecordedTurn[] {
    return this.record(agent).turns;
  }
  /** How many of a session's turns the bounds dropped. */
  dropped(agent: string, sessionId: string) {
    return this.record(agent).dropped.get(sessionId) ?? 0;
  }
  /** Changes with every recorded change, for views to read again. */
  get revision() {
    return this.revisionCount;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Files a new turn under `agent`, within the bounds. */
  add(agent: string, turn: RecordedTurn) {
    const record = this.record(agent);
    record.turns.push(turn);
    const same = record.turns.filter(
      (item) => item.conversation === turn.conversation,
    );
    for (const old of same.slice(
      0,
      Math.max(same.length - TURNS_PER_CONVERSATION, 0),
    ))
      this.drop(record, old);
    this.changed(agent, true);
  }

  /** `agent`'s record changed: views hear of it soon, storage a bit later, or
   * at once when a turn starts or ends. */
  changed(agent: string, now: boolean) {
    this.dirty.add(agent);
    this.notifyTimer ??= setTimeout(() => {
      this.notifyTimer = undefined;
      this.revisionCount++;
      for (const listener of this.listeners) listener();
    }, NOTIFY_DELAY_MS);
    if (now) void this.flush();
    else
      this.persistTimer ??= setTimeout(() => {
        this.persistTimer = undefined;
        void this.persist();
      }, PERSIST_DELAY_MS);
  }

  /** Writes what changed now. */
  async flush() {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    await this.persist();
  }

  private drop(record: AgentRecord, turn: RecordedTurn) {
    const index = record.turns.indexOf(turn);
    if (index < 0) return;
    record.turns.splice(index, 1);
    record.dropped.set(
      turn.sessionId,
      (record.dropped.get(turn.sessionId) ?? 0) + 1,
    );
  }

  private key(agent: string) {
    return `${this.prefix}${agent}`;
  }

  private record(agent: string): AgentRecord {
    let record = this.agents.get(agent);
    if (!record) {
      record = parseRecord(this.store.get(this.key(agent)));
      this.agents.set(agent, record);
    }
    return record;
  }

  /** Saves each changed agent's record within its budget. A failed save keeps
   * the record in memory for the next one: losing activity must never stop a
   * turn. */
  private async persist() {
    const agents = [...this.dirty];
    this.dirty.clear();
    for (const agent of agents) {
      const record = this.record(agent);
      let value = serialize(record);
      while (utf8(value) > AGENT_BUDGET_BYTES && record.turns.length > 1) {
        const oldest = record.turns[0];
        if (oldest) this.drop(record, oldest);
        value = serialize(record);
      }
      try {
        await this.store.set(this.key(agent), value);
      } catch (error) {
        console.warn("The activity record was not saved", {
          operation: "ActivityRecorder.persist",
          turns: record.turns.length,
          bytes: utf8(value),
          error,
        });
      }
    }
  }
}

function serialize(record: AgentRecord): string {
  const stored: Stored = {
    version: RECORD_VERSION,
    turns: record.turns,
    dropped: Object.fromEntries(record.dropped),
  };
  return JSON.stringify(stored);
}

/** A stored record; anything this version cannot read starts a new one rather
 * than being half used. A turn left open ended with the app that ran it. */
function parseRecord(text: string | null): AgentRecord {
  try {
    const stored = JSON.parse(text ?? "null") as Partial<Stored> | null;
    if (stored?.version !== RECORD_VERSION || !Array.isArray(stored.turns))
      return { turns: [], dropped: new Map() };
    const turns = stored.turns.filter(
      (turn) => typeof turn?.id === "string" && Array.isArray(turn.frames),
    );
    for (const turn of turns) {
      if (turn.endedAt !== undefined) continue;
      turn.endedAt = turn.lastAt;
      turn.frames.push({
        turnId: turn.id,
        kind: "turn_error",
        ...(turn.channelId ? { channelId: turn.channelId } : {}),
        sessionId: turn.sessionId,
        timestamp: new Date(turn.lastAt).toISOString(),
        agentIndex: turn.frames[0]?.agentIndex ?? 0,
        payload: { error: INTERRUPTED },
      });
    }
    const dropped = Object.entries(object(stored.dropped) ?? {}).flatMap(
      ([id, value]) => {
        const number = count(value);
        return number === undefined ? [] : [[id, number] as const];
      },
    );
    return { turns, dropped: new Map(dropped) };
  } catch (error) {
    console.warn("The activity record could not be read", {
      operation: "ActivityRecorder.parseRecord",
      bytes: text?.length ?? 0,
      error,
    });
    return { turns: [], dropped: new Map() };
  }
}
