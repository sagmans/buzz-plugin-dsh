// A dsh session's event log in the app's turn-transcript model, so the app's own
// ActivityTranscript shows it as it shows a Goose session. dsh's ACP server
// replays nothing, so this reads the events dsh wrote (src/history.js). Their
// format is internal to dsh: an event this does not know is left out, so a new
// dsh version loses detail and never breaks the tab.
import { promptMessage, promptSections } from "@buzz/features/agents/activity-transcript";

/** Who wrote a `user/message` that is the person's own prompt. */
const PROMPT_SOURCE = "user";
/** The context dsh adds to the first prompt. The app shows such text inside the
 * collapsed system prompt, not as something the person said. */
const CONTEXT_SOURCES = new Set(["agent-instructions", "runtime-context", "skill-catalog", "time-context"]);
/** dsh's own tools, as the app's standard ACP kinds that choose a tool's icon. */
const TOOL_KINDS = new Map([
  ["bash", "execute"],
  ["read", "read"],
  ["read_image", "read"],
  ["edit", "edit"],
  ["write", "edit"],
  ["grep", "search"],
  ["web_search", "search"],
  ["web_fetch", "fetch"],
]);
const OTHER_KIND = "other";
const TEXT_PART = "text";
const THOUGHT_PART = "reasoning";
const SYSTEM_TAG = "system";
/** A Buzz message tool as dsh names it: `mcp__buzz__send`. */
const SEND_TOOL = /__send$/;
const COMPLETED = "completed";
const FAILED = "failed";
const COMPACTED = "Earlier turns were compacted.";
const NOT_POSTED = "The message above was not posted";
/** A tool's input or output kept per item: the panel has no use for more, and a
 * long session must not hold every command's full output in memory. */
const TOOL_TEXT_LIMIT = 64 * 1024;

const object = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined);
const str = (value) => (typeof value === "string" ? value : "");
const parts = (value) => (Array.isArray(value) ? value : []);

/** The text of a message's parts of one type. */
const textOf = (content, type = TEXT_PART) =>
  parts(content)
    .filter((part) => part?.type === type)
    .map((part) => str(part.text))
    .join("\n");

/** A tool call's arguments, which dsh keeps as a JSON string. */
function argumentsOf(text) {
  try {
    return object(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
}

const pretty = (text) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/** Folds one session's events into its latest turns, in order. */
export class SessionTurns {
  turns = [];
  /** True when older turns were dropped to stay within the limit. */
  more = false;
  count = 0;
  tools = new Map();
  sends = new Map();

  constructor(sessionId, place, limit) {
    this.sessionId = sessionId;
    this.place = place;
    this.limit = limit;
  }

  id() {
    this.count += 1;
    return `${this.sessionId}:${this.count}`;
  }

  /** Opens a turn. `partial` is a turn whose start is not in the log. */
  open(at, partial) {
    const turn = {
      turnId: this.id(),
      channelId: this.place.channelId || null,
      threadRootId: this.place.channelId ? (this.place.root ?? null) : undefined,
      triggeringEventIds: [],
      sessionId: this.sessionId,
      newSession: false,
      config: [],
      startedAt: at,
      partial,
      items: [],
    };
    this.turns.push(turn);
    // A result always arrives in its call's turn, so older calls can go.
    this.tools.clear();
    this.sends.clear();
    if (this.turns.length > this.limit) {
      this.turns.shift();
      this.more = true;
    }
    return turn;
  }

  current(at) {
    return this.turns.at(-1) ?? this.open(at, true);
  }

  push(at, item) {
    this.current(at).items.push({ id: this.id(), at, ...item });
  }

  /** The system prompt or added context, shown together as the app's system item. */
  context(at, sections) {
    const known = this.current(at).items.find((item) => item.type === SYSTEM_TAG);
    if (known) known.sections.push(...sections);
    else this.push(at, { type: SYSTEM_TAG, sections });
  }

  userMessage(at, data) {
    const kind = object(data.source)?.kind;
    const text = textOf(data.content);
    if (!text.trim()) return;
    if (CONTEXT_SOURCES.has(kind)) return this.context(at, [{ tag: kind, body: text }]);
    // Other sources are dsh's own reminders and notices, not the person's words.
    if (kind !== PROMPT_SOURCE) return;
    const turn = this.current(at);
    const sections = promptSections(text);
    const { text: said, author } = promptMessage(sections);
    this.push(at, {
      type: "prompt",
      text: said || text,
      ...(author ? { author } : {}),
      sections,
      steer: turn.items.some((item) => item.type === "prompt"),
    });
  }

  assistantMessage(at, data) {
    for (const part of parts(object(data.message)?.content)) {
      const text = str(part?.text);
      if (!text.trim()) continue;
      if (part.type === THOUGHT_PART) this.push(at, { type: "thought", text });
      else if (part.type === TEXT_PART) this.push(at, { type: "message", text });
    }
  }

  toolCall(at, data) {
    const name = str(data.name);
    const callId = str(data.callId);
    const args = str(data.arguments);
    const posted = SEND_TOOL.test(name) ? str(argumentsOf(args).text).trim() : "";
    if (posted) {
      const sent = { id: this.id(), at, type: "message", text: posted };
      this.current(at).items.push(sent);
      this.sends.set(callId, sent);
      return;
    }
    const input = pretty(args);
    const path = str(argumentsOf(args).path);
    const tool = {
      id: this.id(),
      at,
      type: "tool",
      toolCallId: callId,
      title: name || "Tool",
      kind: TOOL_KINDS.get(name) ?? OTHER_KIND,
      status: "in_progress",
      input: input.slice(0, TOOL_TEXT_LIMIT),
      output: "",
      diffs: [],
      paths: path ? [path] : [],
      truncated: input.length > TOOL_TEXT_LIMIT,
    };
    this.current(at).items.push(tool);
    this.tools.set(callId, tool);
  }

  toolResult(at, data) {
    const message = object(data.message);
    const callId = str(message?.toolCallId);
    const text = textOf(message?.content);
    const failed = message?.isError === true;
    const sent = this.sends.get(callId);
    if (sent) {
      if (failed) this.push(at, { type: "status", text: `${NOT_POSTED}: ${text}` });
      else sent.posted = true;
      return;
    }
    const tool = this.tools.get(callId);
    if (!tool) return;
    tool.status = failed ? FAILED : COMPLETED;
    tool.output = text.slice(0, TOOL_TEXT_LIMIT);
    tool.truncated ||= text.length > TOOL_TEXT_LIMIT;
    tool.completedAt = at;
  }

  turnEnd(at, data) {
    const turn = this.turns.at(-1);
    if (!turn) return;
    const reason = object(data.reason);
    turn.endedAt = at;
    if (reason?.kind === "error") turn.error = str(object(reason.error)?.message) || "dsh ended the turn with an error";
    else if (reason?.kind && reason.kind !== COMPLETED) turn.stopReason = str(reason.kind);
  }

  add({ type, time, data }) {
    const at = typeof time === "number" ? time : 0;
    const body = object(data) ?? {};
    switch (type) {
      case "turn/start":
        return void this.open(at, false);
      case "system/message":
        return this.context(at, promptSections(textOf(object(body.message)?.content)));
      case "user/message":
        return this.userMessage(at, body);
      case "assistant/message":
        return this.assistantMessage(at, body);
      case "tool/call":
        return this.toolCall(at, body);
      case "tool/result":
        return this.toolResult(at, body);
      case "compaction/end":
        return this.push(at, { type: "status", text: COMPACTED });
      case "turn/end":
        return this.turnEnd(at, body);
      default:
        return undefined;
    }
  }

  /** The turns that hold something to show; the first one opens the session. */
  finish() {
    const shown = this.turns.filter((turn) => turn.items.length > 0 || turn.error);
    const [first] = shown;
    if (first && !first.partial) {
      if (this.more) first.continued = true;
      else first.newSession = true;
    }
    return shown;
  }
}
