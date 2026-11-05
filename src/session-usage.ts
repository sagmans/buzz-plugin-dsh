// A dsh session's token use as dsh wrote it, so the app's usage view covers what
// the local record never saw: older sessions, turns without the bundle, and the
// subagents the ACP stream does not report. The events' format is internal to
// dsh, so what this does not know is left out and a new dsh version only loses
// numbers (./session-transcript.ts takes the same stance).
//
// dsh records no cost: the app prices these counts as it does any harness's.
import type { UsageObservation } from "@app/features/agents/service";
import { object, type SessionEvent } from "./session-transcript";

/** A model request. dsh's own stats read token use from this event too. */
const ASSISTANT_EVENT = "assistant/message";
/** A compaction is a model request of its own, outside the assistant messages. */
const COMPACTION_EVENT = "compaction/summary";
/** The one record of each subagent a session started. dsh's `session/list` hides
 * subagents, so only their parent names them. */
const CHILD_EVENT = "subagent/catalog";
/** The model of a request that names none. */
const UNKNOWN_MODEL = "unknown";
/** dsh's names of its counts. They do not overlap: a request's `totalTokens` is
 * the sum of the four, as the app's own fields are. */
const COUNTS = {
  input: "inputTokens",
  output: "outputTokens",
  cacheRead: "cacheReadTokens",
  cacheWrite: "cacheWriteTokens",
} as const;

const text = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

/** The counts dsh wrote: a count absent stays absent, so the app can tell it from
 * a zero when it prices the request. */
function tokensOf(usage: Readonly<Record<string, unknown>>) {
  return Object.fromEntries(
    Object.entries(COUNTS).flatMap(([name, field]) => {
      const value = usage[field];
      return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? [[name, value]]
        : [];
    }),
  );
}

/** One request's model and id, where its event type keeps them. */
function requestOf(type: unknown, body: Readonly<Record<string, unknown>>) {
  if (type === COMPACTION_EVENT)
    return { id: text(body.compactionId), model: text(body.model) };
  const message = object(body.message);
  return {
    id: text(message?.id),
    model: text(object(message?.source)?.model),
  };
}

/** Collects a session file's token use, one event at a time. */
export class UsageFold {
  private first = 0;
  private last = 0;
  private readonly requests: UsageObservation[] = [];
  private readonly spawned: string[] = [];

  add({ type, time, data }: SessionEvent) {
    if (typeof time !== "number") return;
    this.first ||= time;
    this.last = time;
    const body = object(data);
    if (!body) return;
    if (type === CHILD_EVENT) {
      const child = text(body.childId);
      if (child) this.spawned.push(child);
      return;
    }
    if (type !== ASSISTANT_EVENT && type !== COMPACTION_EVENT) return;
    const usage = object(body.usage);
    if (!usage) return;
    const { id, model } = requestOf(type, body);
    this.requests.push({
      ...(id ? { requestId: id } : {}),
      at: time,
      model: model ?? UNKNOWN_MODEL,
      tokens: tokensOf(usage),
    });
  }

  finish() {
    return {
      startedAt: this.first,
      lastAt: this.last,
      observations: this.requests,
      children: this.spawned,
    };
  }
}
export type UsageFacts = ReturnType<UsageFold["finish"]>;
