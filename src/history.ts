// An agent's sessions and token use as the Activity tab and the app's usage
// read them, from its local record (./recorder.ts): the harness's own session
// store stays out of it, so this works for any ACP harness.
//
// Harness-neutral on purpose: nothing here names a harness, so the same file
// serves every ACP agent-type plugin that records with ./recorder.ts.
import {
  activityTranscript,
  type Transcript,
} from "@app/features/agents/activity-transcript";
import type {
  SessionUsage,
  UsageObservation,
} from "@app/features/agents/service";
import { withRevision } from "@app/features/agents/session-usage";
import type { ActivityRecorder, RecordedTurn } from "./recorder";

/** The latest turns shown; as the app's own Activity tab shows. */
export const TURN_LIMIT = 50;
/** The agent's recent sessions listed. */
export const RECENT_LIMIT = 30;
/** The model of a turn its session named none for. */
const UNKNOWN_MODEL = "unknown";
/** Names this record as the cost's source in the app's usage view. */
const COST_SOURCE = "harness";

/** A place the agent talks in: a channel, or a thread in one. */
export type Place = Readonly<{ channelId: string; root?: string }>;
/** One recorded session, as a row of the Activity tab. */
export type SessionRow = Readonly<{
  sessionId: string;
  title: string;
  at: number;
  channelId?: string;
  root?: string;
}>;
export type RecordedTranscript = Transcript & { more: boolean };

const keyOf = ({ channelId, root }: Place) =>
  root ? `${channelId}/${root}` : channelId;

/** Each session's turns, oldest first, in the order the record has them. */
function bySession(turns: readonly RecordedTurn[]) {
  const sessions = new Map<string, RecordedTurn[]>();
  for (const turn of turns) {
    const list = sessions.get(turn.sessionId);
    if (list) list.push(turn);
    else sessions.set(turn.sessionId, [turn]);
  }
  return sessions;
}

/** A session's name: what its first recorded turn answered. */
const titleOf = (turns: readonly RecordedTurn[]) =>
  turns.find((turn) => turn.title)?.title ?? "";

const lastAt = (turns: readonly RecordedTurn[]) =>
  Math.max(...turns.map((turn) => turn.lastAt));

/** One turn's token use and cost, as the app's usage reads them. ACP counts
 * cached input apart from `inputTokens`, and thinking apart from output, where
 * the app has no field of its own for it. */
function observation(
  turn: RecordedTurn,
  priorCost: number | undefined,
): UsageObservation | undefined {
  const { usage } = turn;
  if (!usage) return undefined;
  const output =
    usage.output === undefined && usage.thought === undefined
      ? undefined
      : (usage.output ?? 0) + (usage.thought ?? 0);
  // The harness reports the session's total, so a turn costs what it added;
  // without the total before it, that is not known.
  const usd =
    turn.cost !== undefined && priorCost !== undefined
      ? turn.cost - priorCost
      : undefined;
  return {
    requestId: turn.id,
    at: turn.endedAt ?? turn.lastAt,
    model: turn.model ?? UNKNOWN_MODEL,
    tokens: {
      ...(usage.input !== undefined ? { input: usage.input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
      ...(usage.cacheWrite !== undefined
        ? { cacheWrite: usage.cacheWrite }
        : {}),
    },
    ...(usd !== undefined && usd >= 0
      ? { cost: { usd, source: COST_SOURCE } }
      : {}),
  };
}

/** Reads an agent's sessions from the recorder. Reads only: it never starts,
 * stops or changes a session. */
export class RecordedHistory {
  constructor(private readonly recorder: ActivityRecorder) {}

  /** The agent's sessions, most recently active first. */
  recent(agent: string): SessionRow[] {
    return [...bySession(this.recorder.turns(agent))]
      .map(([sessionId, turns]) => {
        const first = turns[0];
        return {
          sessionId,
          title: titleOf(turns),
          at: lastAt(turns),
          ...(first?.channelId ? { channelId: first.channelId } : {}),
          ...(first?.root ? { root: first.root } : {}),
        };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, RECENT_LIMIT);
  }

  /** The latest session of a conversation. */
  find(agent: string, place: Place): SessionRow | undefined {
    const key = keyOf(place);
    const turn = this.recorder
      .turns(agent)
      .findLast((item) => item.conversation === key);
    return (
      turn && this.recent(agent).find((row) => row.sessionId === turn.sessionId)
    );
  }

  /** A session's latest turns in the app's transcript model, or undefined when
   * no turn of it is on record. */
  transcript(agent: string, sessionId: string): RecordedTranscript | undefined {
    const turns = this.recorder
      .turns(agent)
      .filter((turn) => turn.sessionId === sessionId);
    if (!turns.length) return undefined;
    const shown = turns.slice(-TURN_LIMIT);
    const records = shown.flatMap((turn) =>
      turn.frames.map((frame, index) => ({
        id: `${turn.id}:${index}`,
        agent,
        receivedAt: Date.parse(frame.timestamp),
        plaintext: JSON.stringify(frame),
      })),
    );
    return {
      ...activityTranscript(records, { agent }),
      more:
        turns.length > shown.length ||
        this.recorder.dropped(agent, sessionId) > 0,
    };
  }

  /** The token use of the agent's sessions with activity since `since`. Each
   * session's revision is a digest of what it reports, so a session the agent
   * did not touch between two reads keeps its revision. */
  async usage(
    agent: string,
    { since, signal }: Readonly<{ since: number; signal: AbortSignal }>,
  ): Promise<readonly SessionUsage[]> {
    signal.throwIfAborted();
    const sessions = [...bySession(this.recorder.turns(agent))].filter(
      ([, turns]) => lastAt(turns) >= since,
    );
    const read = await Promise.all(
      sessions.map(async ([id, turns]) => {
        const dropped = this.recorder.dropped(agent, id);
        const first = turns[0];
        // Its first turn starts from zero, unless earlier turns are gone.
        let prior: number | undefined = dropped ? undefined : 0;
        const observations = turns.flatMap((turn) => {
          const seen = observation(turn, prior);
          prior = turn.cost ?? prior;
          return seen ? [seen] : [];
        });
        return withRevision({
          id,
          gaps: dropped
            ? [`${dropped} older turns are no longer on record`]
            : [],
          ...(first?.channelId ? { channelId: first.channelId } : {}),
          ...(first?.root ? { root: first.root } : {}),
          ...(titleOf(turns) ? { title: titleOf(turns) } : {}),
          startedAt: first?.startedAt ?? 0,
          lastAt: lastAt(turns),
          observations,
        });
      }),
    );
    signal.throwIfAborted();
    return read;
  }
}
