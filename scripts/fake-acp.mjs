#!/usr/bin/env node
// A stand-in for `dsh --profile <profile>`, for the smoke run (smoke/run.mjs).
//
// Why: the real server needs a dsh install and a paid model for a prompt, and
// no model is approved for this. This one speaks the same ACP subset over
// stdio, in the shape the real one answers, so the plugin's process, protocol
// and tool paths run for real on every push at no cost. Its answers follow the
// dsh facts in dsh-acp-buzz/README.md: resume with no replay, no `session/load`,
// config options per model, one running prompt per session.
//
// A profile whose name starts with `bundled` has dsh-acp-buzz/ added: it has
// `_dsh/session/steer`, reports run ids, compacts on `/compact` and reports
// usage in the prompt's answer. Any other profile answers those with -32601 or
// as a plain model turn, as dsh does without the bundle.
//
// A prompt reports one tool call, asks one permission, calls the `send` tool
// with `pong <turn> <preamble> <model> <effort> <tokens>`, then ends the turn.
// `tokens` are the words of the prompt and its steers that start with TOK-.
// A prompt text with FAKE_SLOW waits for a steer or `session/cancel` before it
// answers, or a moment when it cannot be steered. FAKE_REFUSE makes the bundle
// refuse its steers as if the run had changed.
// It prints one log line to stdout first, as some dsh plugins do.

const SESSION_PREFIX = "fake-session-";
const MCP_SESSION_HEADER = "mcp-session-id";
/** The shared client leads a session's first prompt with the Buzz prompt, as
 * dsh has no system prompt capability. A phrase of that prompt shows it. */
const PREAMBLE_MARK = "Buzz wraps each incoming turn";
const SLOW_MARK = "FAKE_SLOW";
/** What the smoke run's `--live-turn` asks a real model to run: here it holds
 * the turn open the same way, so that scenario can run with no model. */
const LIVE_SLOW_MARK = "sleep 15";
const REFUSE_MARK = "FAKE_REFUSE";
const TOKEN_RE = /TOK-[a-z0-9]+/g;
const CHANNEL_RE = /SEND-CHANNEL:([0-9a-f-]+)/;
const BUNDLED_PROFILE = "bundled";
const COMPACT = "/compact";
const COMPACTED = "Compaction complete";
const ACTIVE_META = "dsh";
const REPLY_TEXT = "**done**";
/** How long a turn that cannot be steered waits: time for a second message. */
const UNSTEERED_WAIT_MS = 400;
const NOT_FOUND = -32601;
const INVALID = -32602;
const USAGE = {
  inputTokens: 120,
  outputTokens: 30,
  totalTokens: 150,
  cachedReadTokens: 80,
  cachedWriteTokens: 10,
  thoughtTokens: 5,
};
const CONTEXT = { used: 4000, size: 128000 };
const FAST = '["fake","fast"]';
const PRO = '["fake","pro"]';
/** The reasoning levels per model: dsh lists what the exact model offers. */
const LEVELS = {
  [FAST]: ["off", "low", "high"],
  [PRO]: ["off", "low", "high", "max"],
};
const DEFAULT_EFFORT = "high";

/** The argument after `--profile`, as the manifest and the plugin pass it. */
const profile = process.argv[process.argv.indexOf("--profile") + 1] ?? "";
const bundled = profile.startsWith(BUNDLED_PROFILE);

const sessions = new Map();
let nextSession = 0;
let nextRequest = 1000;
let nextRun = 0;
const waiting = new Map();
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (sessionId, body, meta) =>
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { ...body, ...(meta && { _meta: meta }) } },
  });

/** An error answer carrying its JSON-RPC code and, as the bundle's refusals
 * do, a machine-readable reason. */
class RpcError extends Error {
  constructor(code, message, reason) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

async function mcp(server, body) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  for (const { name, value } of server.headers) headers[name] = value;
  if (server.session) headers[MCP_SESSION_HEADER] = server.session;
  const response = await fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  server.session ??= response.headers.get(MCP_SESSION_HEADER) ?? undefined;
  return response.json();
}

async function connect(params) {
  const declared = params.mcpServers?.find((entry) => entry.type === "http");
  if (!declared) return undefined;
  const server = { ...declared };
  const init = await mcp(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  if (!init.result) throw new Error("MCP initialize failed");
  const list = await mcp(server, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  return { server, tools: list.result.tools.map((tool) => tool.name) };
}

const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextRequest;
    waiting.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, params });
  });

const configOptions = (session) => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: session.model,
    // One group per provider, as a real dsh lists them.
    options: [
      {
        group: "fake",
        name: "Fake",
        options: [
          { value: FAST, name: "Fast" },
          { value: PRO, name: "Pro" },
        ],
      },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: session.effort,
    options: LEVELS[session.model].map((value) => ({ value, name: value })),
  },
];

const newSession = async (id, params) => {
  const session = {
    id,
    cwd: params.cwd,
    mcp: await connect(params),
    turns: 0,
    model: FAST,
    effort: DEFAULT_EFFORT,
    run: undefined,
    steers: [],
  };
  sessions.set(id, session);
  return session;
};

/** Holds a slow turn until a steer lands or the client cancels it. */
function waitForSteer(session) {
  return new Promise((resolve) => {
    session.cancel = () => resolve("cancelled");
    session.steered = () => resolve("steered");
    if (!bundled) setTimeout(() => resolve("waited"), UNSTEERED_WAIT_MS);
  });
}

async function runTurn(session, text) {
  update(session.id, {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "fake tool",
  });
  const permission = await request("session/request_permission", {
    sessionId: session.id,
    toolCall: { toolCallId: "t1" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  if (!permission.result) throw new Error("no permission answer");
  if (text.includes(SLOW_MARK) || text.includes(LIVE_SLOW_MARK)) {
    if ((await waitForSteer(session)) === "cancelled")
      return { stopReason: "cancelled" };
  }
  const all = [text, ...session.steers].join(" ");
  const tokens = (all.match(TOKEN_RE) ?? []).join(",");
  const preamble = text.includes(PREAMBLE_MARK) ? "preamble" : "no-preamble";
  const channel = all.match(CHANNEL_RE)?.[1];
  const sent = await mcp(session.mcp.server, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "send",
      arguments: {
        ...(channel && { channel }),
        audience: "agents",
        text: `pong ${session.turns} ${preamble} ${session.model} ${session.effort} ${tokens}`,
      },
    },
  });
  if (sent.result?.isError) throw new Error(sent.result.content[0].text);
  // Markdown, as a model writes: the Activity transcript must lay it out.
  update(session.id, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: REPLY_TEXT },
  });
  return { stopReason: "end_turn" };
}

async function prompt(params) {
  const session = sessions.get(params.sessionId);
  if (!session) throw new RpcError(INVALID, "unknown session");
  if (session.run) throw new RpcError(INVALID, "session is busy");
  const text = params.prompt.map((part) => part.text ?? "").join("");
  if (bundled && text.trim() === COMPACT) {
    update(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: COMPACTED },
    });
    return { stopReason: "end_turn" };
  }
  session.turns++;
  session.steers = [];
  session.run = `run-${++nextRun}`;
  session.refuse = text.includes(REFUSE_MARK);
  if (bundled)
    update(
      session.id,
      { sessionUpdate: "session_info_update" },
      { [ACTIVE_META]: { activeRunId: session.run } },
    );
  try {
    const answer = await runTurn(session, text);
    update(session.id, { sessionUpdate: "usage_update", ...CONTEXT });
    return { ...answer, ...(bundled && { usage: USAGE }) };
  } finally {
    session.run = undefined;
    if (bundled)
      update(
        session.id,
        { sessionUpdate: "session_info_update" },
        { [ACTIVE_META]: { activeRunId: null } },
      );
  }
}

/** The bundle's steer: refuses with -32602 and `error.data.reason`. */
function steer(params) {
  if (!bundled) throw new RpcError(NOT_FOUND, "Method not found");
  const { sessionId, prompt: blocks, expectedRunId } = params;
  if (typeof sessionId !== "string" || !Array.isArray(blocks))
    throw new RpcError(INVALID, "invalid steer", "invalid");
  const session = sessions.get(sessionId);
  if (!session)
    throw new RpcError(INVALID, "unknown session", "unknown-session");
  if (!session.run) throw new RpcError(INVALID, "no run", "no-run");
  if (session.refuse || expectedRunId !== session.run) {
    // The turn it was meant for ends now, so the refused text can run next.
    queueMicrotask(() => session.steered?.());
    throw new RpcError(INVALID, "run changed", "run-mismatch");
  }
  session.steers.push(blocks.map((part) => part.text ?? "").join(""));
  session.steered?.();
  return { outcome: "injected" };
}

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentInfo: { name: "deepseek-harness-acp", version: "0.0.0-fake" },
    agentCapabilities: {
      mcpCapabilities: { http: true },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    },
    authMethods: [],
  }),
  "session/new": async (params) => {
    const session = await newSession(
      `${SESSION_PREFIX}${++nextSession}`,
      params,
    );
    return { sessionId: session.id, configOptions: configOptions(session) };
  },
  "session/resume": async (params) => {
    // Sessions named in FAKE_ACP_RESUMABLE survive a restart, as dsh keeps them.
    const known = (process.env.FAKE_ACP_RESUMABLE ?? "").split(",");
    if (!known.includes(params.sessionId))
      throw new RpcError(INVALID, `unknown session: ${params.sessionId}`);
    if (sessions.has(params.sessionId))
      throw new RpcError(INVALID, "session is already active");
    const session = await newSession(params.sessionId, params);
    return { configOptions: configOptions(session) };
  },
  // The sessions named in FAKE_ACP_LISTED, in the shape dsh lists them.
  "session/list": (params) => ({
    sessions: JSON.parse(process.env.FAKE_ACP_LISTED ?? "[]").filter(
      (row) => row.cwd === params.cwd,
    ),
  }),
  "session/set_config_option": (params) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new RpcError(INVALID, "unknown session");
    if (params.configId === "model") {
      if (!LEVELS[params.value])
        throw new RpcError(INVALID, `unknown model: ${params.value}`);
      session.model = params.value;
      if (!LEVELS[session.model].includes(session.effort))
        session.effort = DEFAULT_EFFORT;
    } else if (params.configId === "reasoning_effort") {
      if (!LEVELS[session.model].includes(params.value))
        throw new RpcError(INVALID, `unknown effort: ${params.value}`);
      session.effort = params.value;
    } else throw new RpcError(INVALID, `unknown option: ${params.configId}`);
    return { configOptions: configOptions(session) };
  },
  "session/prompt": prompt,
  "session/close": (params) => {
    sessions.delete(params.sessionId);
    return {};
  },
  "_dsh/session/steer": steer,
};

function onMessage(message) {
  if (message.method === undefined) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  if (message.method === "session/cancel") {
    sessions.get(message.params?.sessionId)?.cancel?.();
    return;
  }
  const handler = handlers[message.method];
  Promise.resolve()
    .then(() => {
      if (!handler) throw new RpcError(NOT_FOUND, "Method not found");
      return handler(message.params ?? {});
    })
    .then(
      (result) => write({ jsonrpc: "2.0", id: message.id, result }),
      (error) =>
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: error.code ?? INVALID,
            message: error.message,
            ...(error.reason && { data: { reason: error.reason } }),
          },
        }),
    );
}

process.stdout.write(
  "[fake-plugin] a log line on stdout that is not JSON-RPC\n",
);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buffer += data;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const text = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (text.trim()) onMessage(JSON.parse(text));
  }
});
process.stdin.on("end", () => process.exit(0));
