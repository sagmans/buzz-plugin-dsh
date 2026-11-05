// Smoke scenarios for the dsh bundle's bridge, with a fake dsh agent.
//
// Why fakes: a real steer needs a running model turn, which costs money,
// and the repository checks never spend money. The bridge takes dsh's
// services as arguments, so these scenarios drive every branch that a live
// turn would reach: run ids, the steer checks, usage and `/compact`.
//
// Usage: node dsh-acp-buzz/smoke.mjs  (exits 1 on the first failed scenario)

import assert from "node:assert/strict";
import { createBridge } from "./lib/bridge.js";
import { COMPACT_DONE_TEXT } from "./lib/compact.js";

// ---- Fixed values -----------------------------------------------------------

const SESSION = "session-1";
const OTHER_SESSION = "session-2";
const RUN_ID = "run-1";
const STEER_METHOD = "_dsh/session/steer";
const INVALID_PARAMS = -32602;

// ---- Fakes ------------------------------------------------------------------

function fakeAgent(status = "idle") {
  return {
    status,
    steered: [],
    steer(message) {
      this.steered.push(message);
    },
  };
}

/** A bridge with recording stream ends and a controllable agent. */
function harness({ compaction = () => undefined } = {}) {
  const agent = fakeAgent();
  const client = [];
  const server = [];
  const logs = [];
  const log = (level) => (line) => logs.push(`${level} ${line}`);
  const bridge = createBridge({
    agents: { get: (id) => (id === SESSION ? agent : undefined) },
    compaction,
    createUserMessage: (input) => ({ role: "user", ...input }),
    newRunId: () => RUN_ID,
    logger: { debug: log("debug"), info: log("info"), warn: log("warn") },
    toClient: async (message) => void client.push(message),
    toServer: async (message) => void server.push(message),
  });
  return { agent, bridge, client, server, logs };
}

/** Opens SESSION through the bridge, as dsh would answer session/new. */
async function openSession(h) {
  await h.bridge.fromClient({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/w", mcpServers: [] } });
  await h.bridge.fromServer({ jsonrpc: "2.0", id: 1, result: { sessionId: SESSION } });
}

const prompt = (id, text, sessionId = SESSION) => ({
  jsonrpc: "2.0",
  id,
  method: "session/prompt",
  params: { sessionId, prompt: [{ type: "text", text }] },
});

const steer = (id, text, expectedRunId = RUN_ID, sessionId = SESSION) => ({
  jsonrpc: "2.0",
  id,
  method: STEER_METHOD,
  params: { sessionId, prompt: [{ type: "text", text }], expectedRunId },
});

// Lets queued compaction work finish before a scenario reads the answers.
const drain = () => new Promise((resolve) => setImmediate(resolve));
const last = (list) => list[list.length - 1];
const runIdOf = (message) => message?.params?.update?._meta?.dsh?.activeRunId;
const reasonOf = (message) => message?.error?.data?.reason;

// ---- Scenarios --------------------------------------------------------------

const scenarios = {
  async "unrelated messages pass through unchanged"() {
    const h = harness();
    const init = { jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: 1 } };
    await h.bridge.fromClient(init);
    assert.deepEqual(h.server, [init]);
    const answer = { jsonrpc: "2.0", id: 9, result: { protocolVersion: 1 } };
    await h.bridge.fromServer(answer);
    assert.deepEqual(h.client, [answer]);
  },

  async "a prompt opens a run before dsh sees it and closes it before its answer"() {
    const h = harness();
    await openSession(h);
    h.client.length = 0;
    await h.bridge.fromClient(prompt(2, "hi"));
    assert.equal(runIdOf(h.client[0]), RUN_ID);
    assert.equal(last(h.server).id, 2);
    await h.bridge.fromServer({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
    assert.equal(runIdOf(h.client[1]), null);
    assert.deepEqual(h.client[2], { jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
  },

  async "a steer lands only in the running turn of the expected run"() {
    const h = harness();
    await openSession(h);
    await h.bridge.fromClient(steer(3, "early"));
    assert.equal(reasonOf(last(h.client)), "no-run");
    await h.bridge.fromClient(prompt(4, "work"));
    await h.bridge.fromClient(steer(5, "not yet"));
    assert.equal(reasonOf(last(h.client)), "not-running", "an idle agent takes no steer");
    h.agent.status = "running";
    await h.bridge.fromClient(steer(6, "x", "old-run"));
    assert.equal(reasonOf(last(h.client)), "run-mismatch");
    await h.bridge.fromClient(steer(7, "also check the tests"));
    assert.deepEqual(last(h.client), { jsonrpc: "2.0", id: 7, result: { outcome: "injected" } });
    assert.deepEqual(h.agent.steered, [
      { role: "user", content: [{ type: "text", text: "also check the tests" }], source: { kind: "user" } },
    ]);
    assert.ok(!h.server.some((m) => m.method === STEER_METHOD), "dsh never sees a steer request");
  },

  async "a steer is refused after a cancel, for another session and for non-text"() {
    const h = harness();
    await openSession(h);
    await h.bridge.fromClient(prompt(2, "work"));
    h.agent.status = "running";
    await h.bridge.fromClient(steer(3, "x", RUN_ID, OTHER_SESSION));
    assert.equal(reasonOf(last(h.client)), "unknown-session");
    const image = steer(4, "x");
    image.params.prompt = [{ type: "image", data: "AA==", mimeType: "image/png" }];
    await h.bridge.fromClient(image);
    assert.equal(reasonOf(last(h.client)), "invalid");
    await h.bridge.fromClient({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: SESSION } });
    assert.equal(last(h.server).method, "session/cancel", "the cancel still reaches dsh");
    await h.bridge.fromClient(steer(5, "late"));
    assert.equal(reasonOf(last(h.client)), "cancelled");
    assert.equal(last(h.client).error.code, INVALID_PARAMS);
    assert.deepEqual(h.agent.steered, []);
  },

  async "the prompt answer carries the summed usage of its model calls"() {
    const h = harness();
    await openSession(h);
    await h.bridge.fromClient(prompt(2, "work"));
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, reasoningTokens: 3 };
    h.bridge.onSessionEvent(SESSION, { type: "assistant/message", data: { usage } });
    h.bridge.onSessionEvent(SESSION, { type: "assistant/message", data: { usage: { inputTokens: 1, outputTokens: 1 } } });
    h.bridge.onSessionEvent(OTHER_SESSION, { type: "assistant/message", data: { usage } });
    await h.bridge.fromServer({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
    assert.deepEqual(last(h.client).result.usage, {
      inputTokens: 11,
      outputTokens: 6,
      totalTokens: 117,
      cachedReadTokens: 100,
      cachedWriteTokens: 0,
      thoughtTokens: 3,
    });
  },

  async "/compact runs dsh's compaction and answers in the Buzz contract"() {
    const calls = [];
    const h = harness({
      compaction: () => ({ compactNow: async (agent, signal) => (calls.push({ agent, signal }), null) }),
    });
    await openSession(h);
    h.client.length = 0;
    await h.bridge.fromClient(prompt(2, "/compact"));
    await drain();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agent, h.agent);
    assert.ok(!h.server.some((m) => m.method === "session/prompt"), "the model never sees /compact");
    assert.equal(h.client[0].params.update.content.text, COMPACT_DONE_TEXT);
    assert.deepEqual(h.client[1], { jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
  },

  async "a prompt with more text than /compact stays a model turn"() {
    const calls = [];
    const h = harness({ compaction: () => ({ compactNow: async () => void calls.push(1) }) });
    await openSession(h);
    await h.bridge.fromClient(prompt(2, "please run /compact"));
    await h.bridge.fromServer({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
    await h.bridge.fromClient(prompt(3, " /compact\n"));
    await drain();
    assert.deepEqual(calls, []);
    assert.deepEqual(h.server.filter((m) => m.method === "session/prompt").map((m) => m.id), [2, 3]);
  },

  async "/compact explains a missing engine, a busy agent and a failed summary"() {
    const texts = async (compaction, status) => {
      const h = harness({ compaction });
      await openSession(h);
      h.agent.status = status;
      await h.bridge.fromClient(prompt(2, "/compact"));
      await drain();
      return last(h.client.filter((m) => m.method === "session/update")).params.update.content.text;
    };
    assert.match(await texts(() => undefined, "idle"), /not available/);
    assert.match(await texts(() => ({ compactNow: async () => null }), "running"), /not idle/);
    const failing = Object.assign(new Error("no summary"), { code: "summary" });
    assert.match(await texts(() => ({ compactNow: async () => Promise.reject(failing) }), "idle"), /useful summary/);
  },

  async "a cancel stops /compact, and a prompt waits for it"() {
    const h = harness({
      compaction: () => ({
        compactNow: (_agent, signal) =>
          new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      }),
    });
    await openSession(h);
    await h.bridge.fromClient(prompt(2, "/compact"));
    await h.bridge.fromClient(prompt(3, "real work"));
    assert.equal(last(h.client).error.code, INVALID_PARAMS, "a prompt during compaction is refused");
    await h.bridge.fromClient({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: SESSION } });
    await h.bridge.dispose();
    assert.deepEqual(last(h.client), { jsonrpc: "2.0", id: 2, result: { stopReason: "cancelled" } });
  },
};

let failed = 0;
for (const [name, run] of Object.entries(scenarios)) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error?.stack ?? error}`);
  }
}
console.log(`${Object.keys(scenarios).length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
