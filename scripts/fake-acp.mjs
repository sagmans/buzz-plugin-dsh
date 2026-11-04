#!/usr/bin/env node
// A stand-in for `dsh --profile acp`, for the smoke scenarios.
//
// Why: the real server needs a dsh install and a paid model for a prompt.
// This one speaks the same ACP subset over stdio and, like dsh, connects to
// each session's HTTP MCP server, so the plugin's process, protocol and tool
// paths run for real on every push at no cost.
//
// A prompt makes it: report one tool call, ask one permission, then call the
// `send` tool with `pong <n>` (and the preamble flag), then end the turn.
// A prompt text containing FAKE_SLOW waits for session/cancel instead.
// It prints one log line to stdout first, as some dsh plugins do.

const SESSION_PREFIX = "fake-session-";
const PREAMBLE_MARK = "Your assistant text is never posted";
const SLOW_MARK = "FAKE_SLOW";

const sessions = new Map();
let nextSession = 0;
let nextRequest = 1000;
const waiting = new Map();
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const stats = { news: 0, resumes: 0, configs: [], permissions: [] };

async function mcp(server, body) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  for (const { name, value } of server.headers) headers[name] = value;
  const response = await fetch(server.url, { method: "POST", headers, body: JSON.stringify(body) });
  return response.json();
}

async function connect(params) {
  const server = params.mcpServers?.find((entry) => entry.type === "http");
  if (!server) return undefined;
  const init = await mcp(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  if (!init.result) throw new Error("MCP initialize failed");
  const list = await mcp(server, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  return { server, tools: list.result.tools.map((tool) => tool.name) };
}

const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextRequest;
    waiting.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, params });
  });

const configOptions = (session) => [
  { id: "model", type: "select", currentValue: session.model, options: [{ value: '["fake","fast"]', name: "Fast" }, { value: '["fake","pro"]', name: "Pro" }] },
  { id: "reasoning_effort", type: "select", currentValue: session.effort, options: [] },
];

async function prompt(params) {
  const session = sessions.get(params.sessionId);
  const text = params.prompt.map((part) => part.text ?? "").join("");
  session.turns++;
  if (text.includes(SLOW_MARK)) {
    await new Promise((resolve) => {
      session.cancel = resolve;
    });
    return { stopReason: "cancelled" };
  }
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session.id, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "fake tool" } } });
  const permission = await request("session/request_permission", {
    sessionId: session.id,
    toolCall: { toolCallId: "t1" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  stats.permissions.push(permission.result?.outcome?.optionId);
  const preamble = text.includes(PREAMBLE_MARK) ? "preamble" : "no-preamble";
  const sent = await mcp(session.mcp.server, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "send", arguments: { text: `pong ${session.turns} ${preamble} ${session.model} ${session.effort}` } },
  });
  if (sent.result?.isError) throw new Error(sent.result.content[0].text);
  return { stopReason: "end_turn" };
}

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { close: {}, list: {}, resume: {} } },
    authMethods: [],
  }),
  "session/new": async (params) => {
    stats.news++;
    const id = `${SESSION_PREFIX}${++nextSession}`;
    const session = { id, cwd: params.cwd, mcp: await connect(params), turns: 0, model: '["fake","fast"]', effort: "high" };
    sessions.set(id, session);
    return { sessionId: id, configOptions: configOptions(session) };
  },
  "session/resume": async (params) => {
    // Sessions named in FAKE_ACP_RESUMABLE survive a restart, as dsh persists them.
    const known = (process.env.FAKE_ACP_RESUMABLE ?? "").split(",");
    if (!known.includes(params.sessionId)) throw new Error(`session is not resumable: ${params.sessionId}`);
    stats.resumes++;
    const session = { id: params.sessionId, cwd: params.cwd, mcp: await connect(params), turns: 0, model: '["fake","fast"]', effort: "high" };
    sessions.set(session.id, session);
    return { configOptions: configOptions(session) };
  },
  "session/set_config_option": (params) => {
    const session = sessions.get(params.sessionId);
    stats.configs.push(`${params.configId}=${params.value}`);
    if (params.configId === "model") session.model = params.value;
    else session.effort = params.value;
    return { configOptions: configOptions(session) };
  },
  "session/prompt": prompt,
  "session/close": (params) => {
    sessions.delete(params.sessionId);
    return {};
  },
  // Test hook: what this server saw, for assertions.
  "fake/stats": () => ({ ...stats, tools: [...sessions.values()].map((s) => s.mcp?.tools ?? []) }),
};

function onMessage(message) {
  if (message.method === undefined) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  if (message.method === "session/cancel") {
    sessions.get(message.params.sessionId)?.cancel?.();
    return;
  }
  const handler = handlers[message.method];
  Promise.resolve()
    .then(() => {
      if (!handler) throw new Error(`unknown method ${message.method}`);
      return handler(message.params ?? {});
    })
    .then(
      (result) => write({ jsonrpc: "2.0", id: message.id, result }),
      (error) => write({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: error.message } }),
    );
}

process.stdout.write("[fake-plugin] a log line on stdout that is not JSON-RPC\n");
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
