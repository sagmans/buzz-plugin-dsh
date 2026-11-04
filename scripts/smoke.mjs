#!/usr/bin/env node
// Smoke scenarios: drive the real plugin.js against a fake Buzz host and a
// fake dsh ACP server (scripts/fake-acp.mjs), in Node.
//
// Why: the plugin runs inside the Buzz desktop app, which has no headless test
// mode, and a real dsh prompt costs money. The fake host gives the plugin real
// child processes and a real loopback HTTP MCP server, so the paths the README
// promises run end to end on every push:
//   - registration: the DSH agent type and its settings;
//   - trust: a mention starts a turn only with the owner's authority: the
//     owner's own, or a sibling agent's with a valid owner `auth` tag (NIP-OA);
//   - a turn: session/new, preamble once, the `send` tool posts in the thread,
//     the run stays working until the prompt settles;
//   - follow-up turns reuse the session; a restart resumes it;
//   - model and effort picks reach the session; permissions are one-shot;
//   - interrupt cancels a running prompt; bad tool input is refused.
//
// Usage: node scripts/smoke.mjs [path/to/plugin.js]   (default: plugin/plugin.js)

import { spawn as spawnChild } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";

const DEFAULT_PLUGIN = "plugin/plugin.js";
const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "fake-acp.mjs");
const PROCESS_ID = "dsh-acp";
const CHANNEL = "channel-main";
const OTHER_CHANNEL = "channel-other";
const TOKEN_HEADER = "x-smoke-token";
// Event loop turns to wait for queued async work.
const SETTLE_MS = 50;
const STEP_TIMEOUT_MS = 10_000;

const hex = (label) => createHash("sha256").update(`dsh-smoke:${label}`).digest("hex");
// Real keys: the trust scenario signs NIP-OA attestations with them.
const OWNER_SECRET = hexToBytes(hex("owner-secret"));
const OTHER_SECRET = hexToBytes(hex("other-secret"));
const OWNER = bytesToHex(schnorr.getPublicKey(OWNER_SECRET));
const STRANGER = hex("stranger");
const SIBLING = hex("sibling");
const AUTH_PREFIX = "nostr:agent-auth:";
const AGENT = { key: hex("agent"), pubkey: hex("agent"), name: "Dsh Test", owner: OWNER };

class SmokeFailure extends Error {
  constructor(scenario, message, details) {
    super(`${scenario}: ${message}${details === undefined ? "" : ` -- ${JSON.stringify(details)}`}`);
    this.name = "SmokeFailure";
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const within = (promise, what) =>
  Promise.race([promise, sleep(STEP_TIMEOUT_MS).then(() => Promise.reject(new Error(`timeout: ${what}`)))]);

// ---- Fake host ------------------------------------------------------------

function createHost(env = {}) {
  const host = { spawned: [], servers: [] };
  host.spawn = async (id, options) => {
    if (id !== PROCESS_ID) throw new Error(`undeclared process ${id}`);
    host.spawned.push(options.args);
    const child = spawnChild(process.execPath, [FAKE_ACP], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", (data) => options.onStdout?.(data));
    child.stderr.setEncoding("utf8").on("data", (data) => options.onStderr?.(data));
    const exited = new Promise((done) => child.on("exit", (code) => done(code)));
    return {
      write: (data) => new Promise((done, fail) => child.stdin.write(data, (error) => (error ? fail(error) : done()))),
      end: async (data) => child.stdin.end(data),
      kill: async () => {
        child.kill("SIGTERM");
        await exited;
      },
      exited,
    };
  };
  host.serveMcp = (handler) =>
    new Promise((done) => {
      const token = randomBytes(16).toString("hex");
      const server = createServer((request, response) => {
        if (request.headers[TOKEN_HEADER] !== token) {
          response.writeHead(401).end();
          return;
        }
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", async () => {
          const reply = await handler(JSON.parse(body));
          response.writeHead(reply === undefined ? 202 : 200, { "content-type": "application/json" });
          response.end(reply === undefined ? "" : JSON.stringify(reply));
        });
      });
      server.listen(0, "127.0.0.1", () => {
        host.servers.push(server);
        const closed = new Promise((resolveClosed) => server.on("close", resolveClosed));
        done({
          url: `http://127.0.0.1:${server.address().port}/mcp`,
          headers: [{ name: TOKEN_HEADER, value: token }],
          close: async () => server.close(),
          closed,
        });
      });
    });
  host.resolveDirectory = async (path) => (path.startsWith("~/") ? join(tmpdir(), path.slice(2)) : path);
  return host;
}

function createAgents(storage = new Map()) {
  const agents = { registered: [], listeners: new Set() };
  agents.register = (type) => agents.registered.push(type);
  agents.snapshot = () => ({ status: "ready", running: [] });
  agents.subscribe = (listener) => {
    agents.listeners.add(listener);
    return () => agents.listeners.delete(listener);
  };
  agents.core = async () => "core memory text";
  agents.storage = {
    keys: () => [...storage.keys()],
    get: (key) => storage.get(key) ?? null,
    set: async (key, value) => (value === null ? storage.delete(key) : storage.set(key, value)),
    add: async (key, value) => (storage.has(key) ? storage.get(key) : (storage.set(key, value), value)),
  };
  return agents;
}

function createHandle() {
  const events = [];
  return {
    ...AGENT,
    events,
    publish: async (template) => {
      const event = { ...template, id: hex(`event-${events.length}-${Math.random()}`), pubkey: AGENT.pubkey, created_at: 1 };
      events.push(event);
      return event;
    },
    query: async (filters) => {
      const [filter] = filters;
      return events.filter((event) => (filter.ids ? filter.ids.includes(event.id) : true));
    },
  };
}

function mention({ author = OWNER, content = "hello", root, extraTags = [], kind = 9, createdAt = 1 } = {}) {
  const id = hex(`mention-${Math.random()}`);
  const tags = [["h", CHANNEL], ...(root ? [["e", root, "", "reply"]] : []), ...extraTags];
  return { id, pubkey: author, kind, content, created_at: createdAt, tags };
}

/** A NIP-OA `auth` tag: `secret` attests that `target` acts for its key. */
function authTag(secret, target, conditions = "") {
  const digest = createHash("sha256").update(`${AUTH_PREFIX}${target}:${conditions}`).digest();
  return ["auth", bytesToHex(schnorr.getPublicKey(secret)), conditions, bytesToHex(schnorr.sign(digest, secret))];
}

function delivery(handle, event, extra = {}) {
  const record = { ignored: false, working: undefined, steps: [], acknowledged: false, stop: undefined };
  const value = {
    trigger: { type: "mention", event },
    channelId: CHANNEL,
    agent: handle,
    config: { profile: "acp", workspace: "~/dsh-smoke", ...extra.config },
    ...(extra.model && { model: extra.model }),
    team: "",
    signal: new AbortController().signal,
    workingUntil: (done) => {
      record.working = done;
    },
    step: (tool) => record.steps.push(tool),
    ignored: () => {
      record.ignored = true;
    },
    acknowledged: () => {
      record.acknowledged = true;
    },
    interruptible: (stop) => {
      record.stop = stop;
    },
    current: () => true,
  };
  return { value, record };
}

// ---- Scenarios --------------------------------------------------------------

async function scenarioRegister(plugin) {
  const name = "register";
  const agents = createAgents();
  // The pinned React, the version Buzz runs: apply() checks it.
  const ctx = { agents, host: createHost(), react: (await import("react")).default, effect: () => undefined, pluginOwner: { id: "sagmans.dsh" } };
  plugin.apply(ctx);
  const [type] = agents.registered;
  if (!type || type.id !== "dsh" || typeof type.run !== "function") throw new SmokeFailure(name, "no DSH agent type");
  const defaults = type.defaults().config;
  if (defaults.profile !== "acp" || defaults.workspace !== "~/dsh-agents") throw new SmokeFailure(name, "bad defaults", defaults);
  if (plugin.config({ profile: "--patch" }).profile !== "acp") throw new SmokeFailure(name, "a flag-like profile was kept");
  if (plugin.config({ workspace: "relative" }).workspace !== "~/dsh-agents") throw new SmokeFailure(name, "a relative workspace was kept");
}

// The mention rule of Buzz's own agents (buzz-app fromOwner): owner, or a
// sibling with a valid owner attestation; anything else is refused.
async function scenarioTrust(plugin) {
  const name = "trust";
  const handle = createHandle();
  const ownerTag = authTag(OWNER_SECRET, SIBLING);
  const attested = (conditions, extra = {}) => mention({ author: SIBLING, extraTags: [authTag(OWNER_SECRET, SIBLING, conditions)], ...extra });
  const cases = [
    ["the owner", mention(), true],
    ["a stranger", mention({ author: STRANGER }), false],
    ["a sibling attested by the owner", mention({ author: SIBLING, extraTags: [ownerTag] }), true],
    ["an attestation by another key", mention({ author: SIBLING, extraTags: [authTag(OTHER_SECRET, SIBLING)] }), false],
    ["a forged owner attestation", mention({ author: SIBLING, extraTags: [["auth", OWNER, "", authTag(OTHER_SECRET, SIBLING)[3]]] }), false],
    ["an attestation for another agent", mention({ author: STRANGER, extraTags: [ownerTag] }), false],
    ["two auth tags", mention({ author: SIBLING, extraTags: [ownerTag, ownerTag] }), false],
    ["a met kind condition", mention({ author: SIBLING, extraTags: [authTag(OWNER_SECRET, SIBLING, "kind=9")] }), true],
    ["an unmet kind condition", mention({ author: SIBLING, extraTags: [authTag(OWNER_SECRET, SIBLING, "kind=7")] }), false],
    // Times away from the bound, so a swapped comparison fails a case.
    ["an expired attestation", attested("created_at<1000", { createdAt: 2000 }), false],
    ["an attestation in force", attested("created_at<3000", { createdAt: 2000 }), true],
    ["an attestation not yet valid", attested("created_at>3000", { createdAt: 2000 }), false],
    ["an attestation after its start", attested("created_at>1000", { createdAt: 2000 }), true],
    ["a met compound condition", attested("kind=9&created_at>1000", { createdAt: 2000 }), true],
    ["a compound condition with one unmet clause", attested("kind=9&created_at<1000", { createdAt: 2000 }), false],
    ["a malformed condition", attested("kind=09"), false],
    ["an out-of-range kind", attested("kind=65536"), false],
    ["an out-of-range time", attested("created_at<4294967296", { createdAt: 2000 }), false],
    ["an auth tag with an extra element", mention({ author: SIBLING, extraTags: [[...ownerTag, "extra"]] }), false],
  ];
  for (const [label, event, expected] of cases) {
    const got = await plugin.admitted(delivery(handle, event).value);
    if (got !== expected) throw new SmokeFailure(name, `${label}: admitted=${got}, expected ${expected}`);
  }
}

async function scenarioTurns(plugin) {
  const name = "turns";
  const storage = new Map();
  const host = createHost();
  const agents = createAgents(storage);
  const runtime = new plugin.DshRuntime({ host, agents });
  const run = plugin.createRun(runtime, agents);
  const handle = createHandle();
  try {
    const stranger = delivery(handle, mention({ author: STRANGER }));
    await run(stranger.value);
    if (!stranger.record.ignored || host.spawned.length) throw new SmokeFailure(name, "a stranger's mention started dsh");

    const first = mention({ content: "first" });
    const one = delivery(handle, first, { config: { effort: "low" } });
    await within(run(one.value), "first hand-over");
    const outcome = await within(one.record.working, "first turn");
    if (!outcome?.ok) throw new SmokeFailure(name, "first turn failed", outcome);
    const [sent] = handle.events;
    const thread = sent?.tags.find((tag) => tag[0] === "e");
    if (sent?.kind !== 9 || sent.tags[0][1] !== CHANNEL || thread?.[1] !== first.id || thread?.[3] !== "reply")
      throw new SmokeFailure(name, "send did not reply in the thread", sent);
    if (!sent.content.startsWith("pong 1 preamble") || !sent.content.endsWith("low"))
      throw new SmokeFailure(name, "first turn lacked preamble or effort", sent.content);
    if (!one.record.acknowledged || !one.record.steps.includes("fake tool")) throw new SmokeFailure(name, "no ack or step");

    const two = delivery(handle, mention({ content: "second", root: first.id }), { model: '["fake","pro"]' });
    await within(run(two.value), "second hand-over");
    await within(two.record.working, "second turn");
    const second = handle.events[1];
    if (!second?.content.startsWith("pong 2 no-preamble") || !second.content.includes('["fake","pro"]'))
      throw new SmokeFailure(name, "second turn did not reuse the session with the model pick", second?.content);

    const acp = await runtime.connection("acp");
    const stats = await acp.request("fake/stats", {});
    if (stats.news !== 1) throw new SmokeFailure(name, "expected one session/new", stats);
    if (!stats.permissions.every((id) => id === "allow-once")) throw new SmokeFailure(name, "permission not one-shot", stats);
    if (!stats.tools[0]?.includes("send")) throw new SmokeFailure(name, "dsh did not list the Buzz tools", stats);
    if (host.spawned.length !== 1 || host.spawned[0][0] !== "acp") throw new SmokeFailure(name, "bad dsh spawn", host.spawned);
    return { storage, sessionId: JSON.parse([...storage.values()][0])[`${CHANNEL}/${first.id}`].id, root: first.id };
  } finally {
    await runtime.stop();
  }
}

async function scenarioResume(plugin, saved) {
  const name = "resume";
  const host = createHost({ FAKE_ACP_RESUMABLE: saved.sessionId });
  const agents = createAgents(saved.storage);
  const runtime = new plugin.DshRuntime({ host, agents });
  const run = plugin.createRun(runtime, agents);
  const handle = createHandle();
  try {
    const turn = delivery(handle, mention({ content: "after restart", root: saved.root }));
    await within(run(turn.value), "resume hand-over");
    await within(turn.record.working, "resume turn");
    const stats = await (await runtime.connection("acp")).request("fake/stats", {});
    if (stats.resumes !== 1 || stats.news !== 0) throw new SmokeFailure(name, "did not resume the saved session", stats);
    if (!handle.events[0]?.content.includes("no-preamble")) throw new SmokeFailure(name, "resumed session got the preamble again");
  } finally {
    await runtime.stop();
  }
}

async function scenarioInterrupt(plugin) {
  const name = "interrupt";
  const host = createHost();
  const agents = createAgents();
  const runtime = new plugin.DshRuntime({ host, agents });
  const run = plugin.createRun(runtime, agents);
  const handle = createHandle();
  try {
    const event = mention({ content: "FAKE_SLOW" });
    const turn = delivery(handle, event);
    await within(run(turn.value), "slow hand-over");
    await sleep(SETTLE_MS);
    if (runtime.state(AGENT.key, { channelId: CHANNEL, root: event.id }) !== "active")
      throw new SmokeFailure(name, "running turn not shown active");
    await turn.record.stop();
    const outcome = await within(turn.record.working, "cancelled turn");
    if (!outcome?.stopped) throw new SmokeFailure(name, "Stop did not end the turn as stopped", outcome);
  } finally {
    await runtime.stop();
  }
}

async function scenarioTools(plugin) {
  const name = "tools";
  const handle = createHandle();
  const root = hex("root");
  const { handler } = plugin.createTools({ channel: CHANNEL, root }, () => handle);
  const call = (tool, args) => handler({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } });
  const bad = await call("send", { text: "x", reply: "not-an-id" });
  if (!bad.result.isError) throw new SmokeFailure(name, "a bad reply id was accepted");
  const empty = await call("send", { text: "  " });
  if (!empty.result.isError) throw new SmokeFailure(name, "empty text was accepted");
  const badChannel = await call("send", { text: "x", channel: "a b" });
  if (!badChannel.result.isError) throw new SmokeFailure(name, "a bad channel was accepted");
  const unknown = await call("delete_everything", {});
  if (!unknown.result.isError) throw new SmokeFailure(name, "an unknown tool ran");
  const elsewhere = await call("send", { text: "top", channel: OTHER_CHANNEL, mentions: [OWNER] });
  const posted = handle.events.at(-1);
  if (elsewhere.result.isError || posted.tags.some((tag) => tag[0] === "e") || posted.tags[0][1] !== OTHER_CHANNEL)
    throw new SmokeFailure(name, "channel send was not top-level there", posted);
  if (!posted.tags.some((tag) => tag[0] === "p" && tag[1] === OWNER)) throw new SmokeFailure(name, "mention not tagged", posted);
  const notification = await handler({ jsonrpc: "2.0", method: "notifications/initialized" });
  if (notification !== undefined) throw new SmokeFailure(name, "a notification got an answer");
  if (plugin.npubToHex("npub1invalid") !== undefined) throw new SmokeFailure(name, "a bad npub decoded");
}

async function main() {
  const path = resolve(process.argv[2] ?? DEFAULT_PLUGIN);
  const plugin = await import(pathToFileURL(path).href);
  // dsh errors are logged by the plugin; keep smoke output to the verdicts.
  console.error = () => undefined;
  await scenarioRegister(plugin);
  await scenarioTrust(plugin);
  const saved = await scenarioTurns(plugin);
  await scenarioResume(plugin, saved);
  await scenarioInterrupt(plugin);
  await scenarioTools(plugin);
  console.log("smoke: all scenarios passed");
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`smoke: ${error.stack ?? error}\n`);
    process.exit(1);
  },
);
