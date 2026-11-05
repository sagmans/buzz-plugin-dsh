// Manual compaction for an ACP client that sends the prompt `/compact`.
//
// Why: dsh's ACP server sends prompt text to the model unchanged, so
// `/compact` over ACP is a paid model turn that does not compact. The Buzz
// ACP client asks a harness to compact with exactly that prompt and treats
// the answer text `Compaction complete` as success (the same contract as
// its Goose hook). This module runs dsh's own manual compaction instead and
// answers in that contract.

import { textChunk } from "./wire.js";

// ---- Fixed values -----------------------------------------------------------

export const COMPACT_COMMAND = "/compact";
// The Buzz client compares the whole answer text with this value.
export const COMPACT_DONE_TEXT = "Compaction complete";
// A summary is one model call; dsh's provider watchdogs bound each stream,
// and this bounds the whole operation so a prompt never waits forever.
export const COMPACT_TIMEOUT_MS = 600_000;

const STOP_END_TURN = "end_turn";
const STOP_CANCELLED = "cancelled";

// Answer texts. Each tells the user what happened without internal detail;
// the full cause goes to the dsh log once.
const TEXT_UNAVAILABLE = "Compaction is not available in this dsh profile.";
const TEXT_BUSY = "Compaction is unavailable because the agent is not idle.";
const TEXT_CANCELLED = "Compaction cancelled.";
const TEXT_TIMEOUT = "Compaction timed out.";
const TEXT_FAILED = "Compaction failed. The dsh log has the cause.";
// Texts for dsh's ManualCompactionError codes, as dsh's own `/compact`
// command words them (dsh-command-compact).
const CODE_TEXTS = Object.freeze({
  busy: TEXT_BUSY,
  cancelled: TEXT_CANCELLED,
  changed:
    "The history selected for compaction changed before it could be replaced.",
  summary: "Compaction could not produce a useful summary.",
  commit:
    "Compaction did not finish cleanly; inspect the session before you retry.",
  persistence: "Compaction finished, but the session could not be saved.",
});

/** Thrown when a compaction cannot start; the caller answers with a
 * JSON-RPC error instead of a turn. */
export class CompactRequestError extends Error {
  constructor(message, { sessionId, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompactRequestError";
    this.operation = "compact";
    this.sessionId = sessionId;
  }
}

/** Whether a prompt is the compaction command and nothing else. Strict: a
 * message that only mentions the command is work for the model. */
export function isCompactPrompt(text) {
  return text === COMPACT_COMMAND;
}

/**
 * Runs one compaction and returns the turn answer `{ text, stopReason }`.
 * The caller already checked that this connection owns the session and
 * that no prompt is in flight.
 * @param deps - `agents`, `compaction()` (the optional dsh service) and
 *   `logger`.
 * @param sessionId - the ACP session id, which is also dsh's agent id.
 * @param controller - aborted by `session/cancel` for this session.
 */
export async function runCompaction(deps, sessionId, controller) {
  const service = deps.compaction();
  if (service === undefined) return answer(TEXT_UNAVAILABLE);
  const agent = deps.agents.get(sessionId);
  if (agent === undefined)
    throw new CompactRequestError(`unknown session: ${sessionId}`, {
      sessionId,
    });
  if (agent.status !== "idle") return answer(TEXT_BUSY);
  const timeout = AbortSignal.timeout(COMPACT_TIMEOUT_MS);
  const signal = AbortSignal.any([controller.signal, timeout]);
  const started = Date.now();
  try {
    const result = await service.compactNow(agent, signal);
    deps.logger.info(
      `acp-buzz: compact session=${sessionId} items=${result?.shadowedSeqs?.length ?? 0} tokens=${result?.shadowedTokenCount ?? 0} ms=${Date.now() - started}`,
    );
    // No compactable history is still a compacted session: the next turn
    // starts from the smallest history dsh can keep.
    return answer(COMPACT_DONE_TEXT);
  } catch (error) {
    return failure(deps.logger, sessionId, error, {
      cancelled: controller.signal.aborted,
      timedOut: timeout.aborted,
      elapsedMs: Date.now() - started,
    });
  }
}

/** Maps a compaction failure to its answer and logs its cause once. */
function failure(logger, sessionId, error, state) {
  const code = typeof error?.code === "string" ? error.code : undefined;
  logger.warn(
    `acp-buzz: compact failed session=${sessionId} code=${code ?? "none"} cancelled=${state.cancelled} timedOut=${state.timedOut} ms=${state.elapsedMs}: ${describe(error)}`,
  );
  if (state.cancelled) return answer(TEXT_CANCELLED, STOP_CANCELLED);
  if (state.timedOut) return answer(TEXT_TIMEOUT);
  return answer(CODE_TEXTS[code] ?? TEXT_FAILED);
}

/** The error and its causes on one line, for the log only. */
function describe(error) {
  const parts = [];
  for (let e = error; e !== undefined && parts.length < 5; e = e?.cause)
    parts.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  return parts.join(" <- ");
}

function answer(text, stopReason = STOP_END_TURN) {
  return { text, stopReason };
}

/** The messages that close a compaction turn: its text, then its answer. */
export function compactionMessages(sessionId, outcome) {
  return {
    chunk: textChunk(sessionId, outcome.text),
    result: { stopReason: outcome.stopReason },
  };
}
