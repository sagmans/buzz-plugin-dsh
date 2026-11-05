// JSON-RPC and ACP message shapes that the proxy reads and writes.
//
// Why a module of its own: the proxy (bridge.js) and the compaction handler
// (compact.js) answer some client requests themselves, so they must build
// the same wire shapes that dsh's ACP server builds. Keeping the shapes here
// keeps the two handlers and the smoke scenarios on one definition.

// ---- Fixed values -----------------------------------------------------------

export const JSONRPC_VERSION = "2.0";
// Standard JSON-RPC 2.0 error codes. ACP and dsh use the same two codes for
// a bad request and for a failure inside the agent.
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// ACP method names that the proxy routes on.
export const METHOD_PROMPT = "session/prompt";
export const METHOD_NEW = "session/new";
export const METHOD_RESUME = "session/resume";
export const METHOD_CLOSE = "session/close";
export const METHOD_CANCEL = "session/cancel";
export const METHOD_UPDATE = "session/update";

// The extension method for steering. The leading underscore is ACP's
// namespace for extensions; `_dsh/` keeps it apart from other agents' names.
export const METHOD_STEER = "_dsh/session/steer";

// ACP `session/update` kinds that the proxy sends itself.
export const UPDATE_INFO = "session_info_update";
export const UPDATE_MESSAGE_CHUNK = "agent_message_chunk";
// The `_meta` key of this bundle. ACP reserves `_meta` for such extensions.
export const META_KEY = "dsh";

// ---- Shapes -----------------------------------------------------------------

/** A request has a method and an id; a notification has no id. */
export function isRequest(message) {
  return typeof message?.method === "string" && Object.hasOwn(message, "id");
}

/** A response has an id and no method. */
export function isResponse(message) {
  return (
    message !== null &&
    typeof message === "object" &&
    typeof message.method !== "string" &&
    Object.hasOwn(message, "id")
  );
}

/** A success response to the client request `id`. */
export function resultMessage(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

/** An error response to the client request `id`. `data` stays optional so
 * the wire carries no empty field. */
export function errorMessage(id, code, message, data) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

/** One `session/update` notification for `sessionId`. */
export function updateMessage(sessionId, update) {
  return {
    jsonrpc: JSONRPC_VERSION,
    method: METHOD_UPDATE,
    params: { sessionId, update },
  };
}

/** The run notice that a Buzz steering hook reads: the id of the prompt in
 * flight, or `null` when no prompt is in flight. */
export function runNotice(sessionId, runId) {
  return updateMessage(sessionId, {
    sessionUpdate: UPDATE_INFO,
    _meta: { [META_KEY]: { activeRunId: runId } },
  });
}

/** One text chunk of agent output, as dsh's own ACP server streams it. */
export function textChunk(sessionId, text) {
  return updateMessage(sessionId, {
    sessionUpdate: UPDATE_MESSAGE_CHUNK,
    content: { type: "text", text },
  });
}

/** The prompt's text when every block is text; else `undefined`, so an
 * image or a resource never counts as a command. */
export function promptText(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) return undefined;
  let text = "";
  for (const block of prompt) {
    if (block?.type !== "text" || typeof block.text !== "string")
      return undefined;
    text += block.text;
  }
  return text;
}
