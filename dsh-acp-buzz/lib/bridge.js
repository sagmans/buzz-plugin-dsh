// The message router between an ACP client (Buzz) and dsh's own ACP server.
//
// Why a proxy: dsh's ACP server registers its JSON-RPC handlers on a
// connection that it keeps to itself, so a plugin cannot add a method to it.
// It does take its message stream from its config, so this bundle owns the
// real stdio and puts this router between the two. The router answers three
// things itself and forwards every other message unchanged:
//
// | Message | Why the router handles it |
// | --- | --- |
// | `_dsh/session/steer` | dsh's agent loop can steer a running turn; its ACP server cannot. |
// | `session/prompt` with only `/compact` | dsh's ACP server would send it to the model. |
// | `session/prompt` start and end | A steer names the run it is for, so it never lands in a later turn. |
//
// This module has no dsh imports: the caller passes the dsh services and
// the two stream ends, so the smoke scenarios can drive it with fakes.

import {
  COMPACT_COMMAND,
  CompactRequestError,
  compactionMessages,
  isCompactPrompt,
  runCompaction,
} from "./compact.js";
import { addUsage, emptyUsage, toAcpUsage } from "./usage.js";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  METHOD_CANCEL,
  METHOD_CLOSE,
  METHOD_NEW,
  METHOD_PROMPT,
  METHOD_RESUME,
  METHOD_STEER,
  errorMessage,
  isRequest,
  isResponse,
  promptText,
  resultMessage,
  runNotice,
} from "./wire.js";

// ---- Fixed values -----------------------------------------------------------

// A steer is one chat message; these bound what a client can push into a
// running turn in one request.
export const MAX_STEER_BLOCKS = 64;
export const MAX_STEER_TEXT_CHARS = 1_000_000;
// The steer result: the word that Buzz's own ACP client expects from a
// harness that steers.
const STEER_INJECTED = "injected";
// The same text that dsh's ACP server gives a second prompt on a busy
// session, so a client sees one rule for both.
const BUSY_PROMPT_TEXT = "a prompt is already in flight for this session";

/** A steer that the router refuses. `reason` is stable for clients and
 * logs; the message is for people. */
export class SteerRejectedError extends Error {
  constructor(reason, message, sessionId) {
    super(message);
    this.name = "SteerRejectedError";
    this.operation = "steer";
    this.reason = reason;
    this.sessionId = sessionId;
  }
}

/**
 * Builds the router.
 * @param deps - `agents` (dsh's agent registry), `compaction()` (the dsh
 *   compaction service, or undefined), `createUserMessage` (dsh-llm),
 *   `newRunId()`, `logger`, `toClient(message)` and `toServer(message)`.
 *   Both writers return a promise that settles when the message is queued.
 */
export function createBridge(deps) {
  return new AcpBridge(deps);
}

/** The router state for one ACP connection. */
class AcpBridge {
  constructor(deps) {
    this.deps = deps;
    // Sessions that this connection opened or resumed. Only they take a
    // steer or a compaction: another agent in the process is not this
    // client's.
    this.sessions = new Set();
    // Client request id -> what its answer from dsh must update.
    this.pending = new Map();
    // Session id -> the prompt in flight: its request id, run id and usage.
    this.runs = new Map();
    // Session id -> the AbortController of a running compaction.
    this.compactions = new Map();
    // Compactions run beside the message loop; each is kept for dispose.
    this.background = new Set();
  }

  /** One message from the client, in the order the client sent it. */
  async fromClient(message) {
    if (isRequest(message)) {
      if (message.method === METHOD_STEER)
        return this.deps.toClient(this.answerSteer(message));
      if (message.method === METHOD_PROMPT) return this.startPrompt(message);
      this.remember(message);
    } else if (message?.method === METHOD_CANCEL) {
      this.cancel(message.params?.sessionId);
    }
    return this.deps.toServer(message);
  }

  /** One message from dsh's ACP server, in the order dsh sent it. */
  async fromServer(message) {
    const entry = isResponse(message)
      ? this.pending.get(message.id)
      : undefined;
    if (entry === undefined) return this.deps.toClient(message);
    this.pending.delete(message.id);
    return this.deps.toClient(await this.settle(entry, message));
  }

  /** dsh's committed session events: per-call usage of the prompt in flight. */
  onSessionEvent(sessionId, event) {
    if (event?.type !== "assistant/message") return;
    const run = this.runs.get(sessionId);
    if (run !== undefined) addUsage(run.usage, event.data?.usage);
  }

  /** Aborts running compactions when the plugin stops. */
  dispose() {
    for (const controller of this.compactions.values())
      controller.abort(new Error("acp-buzz disposed"));
    return Promise.allSettled([...this.background]);
  }

  /** Records requests whose answer opens or closes a session. */
  remember(message) {
    const { method, id } = message;
    if (method === METHOD_NEW) this.pending.set(id, { kind: METHOD_NEW });
    else if (method === METHOD_RESUME || method === METHOD_CLOSE)
      this.pending.set(id, { kind: method, sessionId: message.params?.sessionId });
  }

  /** Applies dsh's answer to the router state; returns what the client gets. */
  async settle(entry, message) {
    const ok = message.result !== undefined && message.error === undefined;
    if (entry.kind === METHOD_PROMPT) return this.endPrompt(entry, message, ok);
    if (!ok) return message;
    if (entry.kind === METHOD_NEW && typeof message.result.sessionId === "string")
      this.sessions.add(message.result.sessionId);
    else if (entry.kind === METHOD_RESUME) this.sessions.add(entry.sessionId);
    else if (entry.kind === METHOD_CLOSE) this.sessions.delete(entry.sessionId);
    return message;
  }

  // ---- Prompts and run ids --------------------------------------------------

  async startPrompt(message) {
    const sessionId = message.params?.sessionId;
    if (isCompactPrompt(promptText(message.params?.prompt)))
      return this.startCompaction(message, sessionId);
    if (this.compactions.has(sessionId))
      return this.deps.toClient(
        errorMessage(message.id, INVALID_PARAMS, BUSY_PROMPT_TEXT),
      );
    // A prompt for a session that is not ours, or a second prompt that dsh
    // will refuse, passes through without a run of its own.
    if (this.sessions.has(sessionId) && !this.runs.has(sessionId)) {
      const runId = this.deps.newRunId();
      this.runs.set(sessionId, {
        requestId: message.id,
        runId,
        cancelled: false,
        usage: emptyUsage(),
      });
      this.pending.set(message.id, { kind: METHOD_PROMPT, sessionId });
      await this.deps.toClient(runNotice(sessionId, runId));
    }
    return this.deps.toServer(message);
  }

  /** The prompt's answer: first the run ends, then the answer with its
   * usage, so a client never steers into a turn that has ended. */
  async endPrompt(entry, message, ok) {
    const run = this.runs.get(entry.sessionId);
    if (run?.requestId !== message.id) return message;
    this.runs.delete(entry.sessionId);
    await this.deps.toClient(runNotice(entry.sessionId, null));
    if (!ok || run.usage.calls === 0) return message;
    return {
      ...message,
      result: { ...message.result, usage: toAcpUsage(run.usage) },
    };
  }

  cancel(sessionId) {
    const run = this.runs.get(sessionId);
    // dsh's cancel clears the steer inbox; a steer after it would start an
    // unowned turn, so the run takes no more.
    if (run !== undefined) run.cancelled = true;
    this.compactions.get(sessionId)?.abort(new Error("ACP prompt cancelled"));
  }

  // ---- Steering -------------------------------------------------------------

  answerSteer(message) {
    try {
      return resultMessage(message.id, { outcome: this.steer(message.params) });
    } catch (error) {
      if (error instanceof SteerRejectedError) {
        // Expected: the turn ended or never started. The client falls back
        // to a queued turn, so this is not a failure of the bundle.
        this.deps.logger.debug(
          `acp-buzz: steer refused session=${error.sessionId ?? "none"} reason=${error.reason}`,
        );
        return errorMessage(message.id, INVALID_PARAMS, error.message, {
          reason: error.reason,
        });
      }
      this.deps.logger.warn(
        `acp-buzz: steer failed session=${message.params?.sessionId ?? "none"}: ${error?.message ?? String(error)}`,
      );
      return errorMessage(message.id, INTERNAL_ERROR, "steer failed inside dsh");
    }
  }

  /** Deny by default: each check names why a steer cannot land. */
  steer(params) {
    const { sessionId, text, expectedRunId } = steerParams(params);
    const reject = (reason, detail) => {
      throw new SteerRejectedError(reason, detail, sessionId);
    };
    if (!this.sessions.has(sessionId))
      reject("unknown-session", `unknown session: ${sessionId}`);
    const run = this.runs.get(sessionId);
    if (run === undefined)
      reject("no-run", "no prompt is in flight for this session");
    if (run.runId !== expectedRunId)
      reject("run-mismatch", "the prompt in flight is not the expected run");
    if (run.cancelled) reject("cancelled", "the prompt in flight was cancelled");
    const agent = this.deps.agents.get(sessionId);
    // The status check and steer() run in one tick: dsh's loop goes idle
    // only after its own synchronous inbox check, so a steer accepted while
    // `running` is claimed by this turn or the next step of it.
    if (agent?.status !== "running")
      reject("not-running", "the session has no running turn");
    agent.steer(
      this.deps.createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" },
      }),
    );
    return STEER_INJECTED;
  }

  // ---- Compaction -----------------------------------------------------------

  startCompaction(message, sessionId) {
    const refusal = !this.sessions.has(sessionId)
      ? `unknown session: ${sessionId}`
      : this.runs.has(sessionId) || this.compactions.has(sessionId)
        ? BUSY_PROMPT_TEXT
        : undefined;
    if (refusal !== undefined)
      return this.deps.toClient(errorMessage(message.id, INVALID_PARAMS, refusal));
    const controller = new AbortController();
    this.compactions.set(sessionId, controller);
    // The compaction may take minutes; the message loop must keep serving
    // other sessions and this session's cancel meanwhile.
    const job = this.compactTurn(message, sessionId, controller).finally(() => {
      this.compactions.delete(sessionId);
      this.background.delete(job);
    });
    this.background.add(job);
    return undefined;
  }

  async compactTurn(message, sessionId, controller) {
    try {
      const outcome = await runCompaction(this.deps, sessionId, controller);
      const { chunk, result } = compactionMessages(sessionId, outcome);
      await this.deps.toClient(chunk);
      await this.deps.toClient(resultMessage(message.id, result));
    } catch (error) {
      await this.compactFailed(message, sessionId, error);
    }
  }

  /** A compaction that could not run answers its prompt with an error. */
  async compactFailed(message, sessionId, error) {
    const expected = error instanceof CompactRequestError;
    const detail = error?.message ?? "compaction failed";
    if (!expected)
      this.deps.logger.warn(
        `acp-buzz: ${COMPACT_COMMAND} session=${sessionId} failed: ${detail}`,
      );
    const code = expected ? INVALID_PARAMS : INTERNAL_ERROR;
    try {
      await this.deps.toClient(errorMessage(message.id, code, detail));
    } catch (writeError) {
      this.deps.logger.warn(
        `acp-buzz: ${COMPACT_COMMAND} session=${sessionId} answer lost: ${writeError?.message ?? String(writeError)}`,
      );
    }
  }
}

/** Validates steer params at the boundary: text only, bounded, with a run. */
function steerParams(params) {
  const sessionId = params?.sessionId;
  const invalid = (detail) => {
    throw new SteerRejectedError(
      "invalid",
      detail,
      typeof sessionId === "string" ? sessionId : undefined,
    );
  };
  if (typeof sessionId !== "string" || sessionId === "")
    invalid("sessionId must be a non-empty string");
  if (typeof params.expectedRunId !== "string" || params.expectedRunId === "")
    invalid("expectedRunId must be a non-empty string");
  const blocks = params.prompt;
  if (!Array.isArray(blocks) || blocks.length > MAX_STEER_BLOCKS)
    invalid(`prompt must be an array of at most ${MAX_STEER_BLOCKS} blocks`);
  const text = promptText(blocks);
  if (text === undefined) invalid("prompt must hold text blocks only");
  if (text.trim() === "") invalid("prompt text is empty");
  if (text.length > MAX_STEER_TEXT_CHARS)
    invalid(`prompt text is longer than ${MAX_STEER_TEXT_CHARS} characters`);
  return { sessionId, text, expectedRunId: params.expectedRunId };
}
