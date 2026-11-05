#!/usr/bin/env node
// End-to-end smoke run of the built plugin against a stand-in for dsh, outside
// the app. It loads the built plugin as Buzz loads it, with a stand-in for the
// parts of the app the plugin uses: the manifest's process grant, a loopback
// MCP server, agent storage and an agent handle that records what it would
// publish instead of signing it.
//
// Why: the plugin's value is the path from a Buzz turn to dsh and back through
// Buzz tools. Type checks and a bundle cannot prove that path, and a real model
// turn is paid. So this run drives the real shared client against
// scripts/fake-acp.mjs, which answers as dsh does with and without dsh-acp-buzz/.
// The views render with real React in a jsdom window, both from this
// repository's lockfile. A real dsh is not started here.
//
// It writes nothing outside a temporary workspace and touches no relay.
//
// Usage: node smoke/run.mjs [--plugin <dir>]
//   --plugin <dir>  the built plugin directory (default: dist/)
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_DSH = join(ROOT, "scripts", "fake-acp.mjs");
/** How long one scenario may take: the stand-in answers at once. */
const TURN_TIMEOUT_MS = 60_000;
/** How long one turn may take with `--live-turn`: a real model and a real
 * command answer at their own pace. */
const LIVE_TURN_TIMEOUT_MS = 300_000;
/** Keeps a real turn running long enough to steer it. */
const LIVE_SLOW_COMMAND = "sleep 15";
/** The probe's answer from a dsh that has the bundle (dsh-acp-buzz/README.md). */
const BUNDLE_PRESENT_CODE = -32602;
/** How long a view may take to show what it read. */
const VIEW_TIMEOUT_MS = 10_000;
/** How long a stopped process may take to exit before it is killed. */
const KILL_GRACE_MS = 3_000;
/** The largest MCP request body accepted, as a loopback server should cap it. */
const MCP_BODY_LIMIT = 1024 * 1024;
const LOOPBACK = "127.0.0.1";
/** The header the app's host names an MCP session with (src-tauri host_mcp). */
const MCP_SESSION_HEADER = "mcp-session-id";
/** How often the run looks for what it waits for. */
const POLL_MS = 20;
/** The window members the app's components read as globals. */
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MutationObserver",
  "matchMedia",
];
const AGENT_NAME = "DshSmoke";
/** How the bundle carries the Settings icon: one file, no asset to load. */
const ICON_DATA_URL = "data:image/png;base64,";
const CHAT_KIND = 9;
/** The Buzz tools the shared host serves at the pinned buzz-app revision, as
 * Goose and Hermes get them. */
const BUZZ_TOOL_COUNT = 63;
const PLAIN_PROFILE = "plain";
/** The stand-in has the bundle on a profile with this name's start. */
const BUNDLED_PROFILE = "bundled";
const STEER_METHOD = "_dsh/session/steer";
const SESSION_FILE = "session.v4.jsonl.zstd";
/** Longer than the record keeps a string, so a cut would show. */
const RECORD_TEXT_LIMIT = 9_000;
const LONG_OUTPUT_CHARS = 100_000;
const LONG_TAIL = "END-OF-LONG-TEXT";
const COMPACT_PROMPT = "/compact";
/** A moment for the run id of a turn to reach the client before a steer. */
const STEER_SETTLE_MS = 100;
const FAST_MODEL = '["fake","fast"]';
const PRO_MODEL = '["fake","pro"]';
const EXIT_FAIL = 1;
const EXIT_USAGE = 64;

/** A smoke check that failed, with what it saw. */
class SmokeError extends Error {
  constructor(message, { exit = EXIT_FAIL, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SmokeError";
    this.exit = exit;
  }
}

function parseArgs(argv) {
  const options = { plugin: join(ROOT, "dist") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plugin") {
      if (!argv[i + 1])
        throw new SmokeError("--plugin needs a directory", {
          exit: EXIT_USAGE,
        });
      options.plugin = resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--real-dsh") {
      if (!argv[i + 1])
        throw new SmokeError(
          "--real-dsh needs profile names, comma-separated",
          {
            exit: EXIT_USAGE,
          },
        );
      options.realProfiles = argv[i + 1].split(",");
      i += 1;
    } else if (arg === "--live-turn") {
      options.liveTurn = true;
    } else if (arg === "--skip-plain-turn") {
      // A rerun that already proved the plain turn should not pay for it again.
      options.skipPlainTurn = true;
    } else if (arg === "--model" || arg === "--effort") {
      if (!argv[i + 1])
        throw new SmokeError(`${arg} needs a value`, { exit: EXIT_USAGE });
      options[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else
      throw new SmokeError(`unknown argument: ${arg}`, { exit: EXIT_USAGE });
  }
  if (options.liveTurn && !options.realProfiles)
    throw new SmokeError("--live-turn needs --real-dsh", { exit: EXIT_USAGE });
  return options;
}

const log = (step, detail = "") =>
  console.log(`smoke: ${step}${detail ? ` ${detail}` : ""}`);
const hex = (bytes) => randomBytes(bytes).toString("hex");
const token = () => `TOK-${hex(4)}`;
/** The plugin reads dsh's sessions under `~/.dsh`. A run never reads the real
 * folder: it stands for `$DSH_HOME`, or for the run's own fixture folder. */
const DSH_FOLDER = "~/.dsh/";
let sessionsHome = "";
const expand = (path, cwd = homedir()) =>
  path === "~"
    ? homedir()
    : path.startsWith(DSH_FOLDER)
      ? join(sessionsHome, path.slice(DSH_FOLDER.length))
      : path.startsWith("~/")
        ? join(homedir(), path.slice(2))
        : isAbsolute(path)
          ? path
          : join(cwd, path);
const assert = (ok, message) => {
  if (!ok) throw new SmokeError(message);
};

/** Rejects after `ms`, naming what took too long. */
function deadline(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new SmokeError(`${what} took longer than ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Polls `test` until it holds. */
async function until(what, test, ms = TURN_TIMEOUT_MS) {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > ms)
      throw new SmokeError(`${what} took longer than ${ms} ms`);
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

/** Every JSON-RPC line crossing the process pipe, in order: what the plugin
 * really sent to dsh and what dsh answered, below all of the plugin's code. */
class Wire {
  entries = [];
  /** A line reader for one process and direction. */
  reader(profile, way) {
    let rest = "";
    return (data) => {
      rest += data;
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        try {
          this.entries.push({ profile, way, message: JSON.parse(line) });
        } catch {
          // dsh plugins may print log lines: not protocol.
        }
      }
    };
  }
  /** Requests the plugin sent with `method`, on `profile` if given. */
  sent(method, profile) {
    return this.entries
      .filter(
        (entry) =>
          entry.way === "out" &&
          entry.message.method === method &&
          (!profile || entry.profile === profile),
      )
      .map((entry) => entry.message);
  }
  /** The text of each prompt the plugin sent on `profile`. */
  /** Waits for a run id after entry `seen`. Why not any run id: an earlier turn
   * of this profile also sent one, and a message that comes before the new run
   * starts is queued, not steered. */
  newRun(profile, seen) {
    return until("the run id", () =>
      this.entries
        .slice(seen)
        .some(
          ({ profile: from, way, message }) =>
            from === profile &&
            way === "in" &&
            typeof message.params?.update?._meta?.dsh?.activeRunId === "string",
        ),
    );
  }

  prompts(profile) {
    return this.sent("session/prompt", profile).map((message) =>
      message.params.prompt.map((part) => part.text ?? "").join(""),
    );
  }
}

/** The desktop host's process grant, as the app enforces it (src-tauri
 * host_process.rs: declared arguments first, then the caller's): only the
 * manifest's processes, with the caller's arguments after the declared ones.
 * It runs the stand-in where the app would run the program. */
function processHost(manifest, children, wire, spawned, real = false) {
  const declared = new Map(
    manifest.host.processes.map((entry) => [entry.id, entry]),
  );
  return (id, options = {}) => {
    const entry = declared.get(id);
    if (!entry)
      return Promise.reject(
        new SmokeError(`process ${id} is not in the manifest`),
      );
    const args = [...(entry.args ?? []), ...(options.args ?? [])];
    spawned.push([entry.program, ...args]);
    const profile = args[args.indexOf("--profile") + 1] ?? "";
    const env = { ...process.env };
    for (const [key, value] of Object.entries(options.env ?? {}))
      if (value === null) delete env[key];
      else env[key] = value;
    const cwd = options.cwd ? expand(options.cwd) : homedir();
    mkdirSync(cwd, { recursive: true });
    const [program, ...line] = real
      ? [entry.program, ...args]
      : [process.execPath, FAKE_DSH, ...args];
    const child = spawn(program, line, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const read = wire.reader(profile, "in");
    const wrote = wire.reader(profile, "out");
    child.stdout.on("data", (data) => {
      read(data);
      options.onStdout?.(data);
    });
    child.stderr.on("data", (data) => options.onStderr?.(data));
    const exited = new Promise((done) => {
      child.on("exit", (code) => {
        children.delete(child);
        done(code);
      });
      child.on("error", (error) => {
        children.delete(child);
        options.onStderr?.(`${error.message}\n`);
        done(null);
      });
    });
    const write = (data) => {
      wrote(String(data));
      return new Promise((done, fail) =>
        child.stdin.write(data, (error) => (error ? fail(error) : done())),
      );
    };
    return Promise.resolve({
      write,
      end: async (data) => {
        if (data) await write(data);
        child.stdin.end();
      },
      kill: () => stop(child, exited),
      exited,
    });
  };
}

/** Asks a process to stop, then kills it after a grace period. */
async function stop(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  await exited;
  clearTimeout(timer);
}

/** A loopback MCP server (Streamable HTTP, JSON answers) that hands each
 * message to the plugin, as the app's host does. Requests without the
 * server's token are refused. Like the host, a token admits one MCP session:
 * a second `initialize` stops the server unless the plugin asked for a shared
 * session, so a harness that reconnects fails here as it fails in the app.
 * Each `tools/list` answer is noted, as evidence of what dsh gets. */
function mcpHost(servers, record) {
  return (handler, options) =>
    new Promise((ready, fail) => {
      const secret = hex(32);
      const expected = Buffer.from(`Bearer ${secret}`);
      let resolveClosed;
      const closed = new Promise((done) => {
        resolveClosed = done;
      });
      let session;
      let handle;
      const server = createServer((request, response) => {
        const given = Buffer.from(request.headers.authorization ?? "");
        if (
          given.length !== expected.length ||
          !timingSafeEqual(given, expected)
        ) {
          response.writeHead(401).end();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST" }).end();
          return;
        }
        const chunks = [];
        let size = 0;
        const sent = request.headers[MCP_SESSION_HEADER];
        request.on("data", (chunk) => {
          size += chunk.length;
          if (size > MCP_BODY_LIMIT) request.destroy();
          else chunks.push(chunk);
        });
        request.on("end", async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const messages = Array.isArray(body) ? body : [body];
            if (messages.some((m) => m.method === "initialize")) {
              if (session && !options?.sharedSession) {
                record.reconnects += 1;
                response.writeHead(404).end();
                void handle.close();
                return;
              }
              session ??= randomUUID();
            } else if (sent !== session) {
              response.writeHead(404).end();
              return;
            }
            const answers = (await Promise.all(messages.map(handler))).filter(
              (answer) => answer !== undefined,
            );
            for (const answer of answers)
              if (Array.isArray(answer?.result?.tools))
                record.tools = answer.result.tools.map(({ name }) => name);
            if (!answers.length) {
              response.writeHead(202).end();
              return;
            }
            response.writeHead(200, {
              "content-type": "application/json",
              [MCP_SESSION_HEADER]: session,
            });
            response.end(
              JSON.stringify(Array.isArray(body) ? answers : answers[0]),
            );
          } catch (error) {
            response
              .writeHead(400, { "content-type": "text/plain" })
              .end(String(error?.message ?? error));
          }
        });
      });
      server.on("error", fail);
      server.on("close", () => resolveClosed());
      server.listen(0, LOOPBACK, () => {
        const { port } = server.address();
        handle = {
          url: `http://${LOOPBACK}:${port}/mcp`,
          headers: [{ name: "Authorization", value: `Bearer ${secret}` }],
          close: () =>
            new Promise((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
          closed,
        };
        servers.add(handle);
        ready(handle);
      });
    });
}

/** Agent storage in memory, as the app's agent store behaves. */
function memoryStore() {
  const map = new Map();
  return {
    keys: () => [...map.keys()],
    get: (key) => map.get(key) ?? null,
    set: async (key, value) =>
      value === null ? map.delete(key) : map.set(key, value),
    add: async (key, value) => {
      if (!map.has(key)) map.set(key, value);
      return map.get(key);
    },
  };
}

/** `localStorage` for Node, which has none without a flag. */
function memoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

/** The React, renderer and window the views run with: real React and
 * react-dom from this repository's lockfile (the version Buzz runs, which the
 * plugin checks), and a jsdom window in place of the app's. */
function appRuntime() {
  const require = createRequire(join(ROOT, "package.json"));
  const { JSDOM } = require("jsdom");
  const { window } = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
  });
  // jsdom has no media queries; the app's motion reads one for reduced motion.
  window.matchMedia ??= () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  // jsdom has no `CSS`; the save footer escapes a class name with it.
  globalThis.CSS ??= { escape: (value) => String(value) };
  for (const name of DOM_GLOBALS)
    Object.defineProperty(globalThis, name, {
      value: name === "window" ? window : window[name],
      configurable: true,
      writable: true,
    });
  return {
    react: require("react"),
    client: require("react-dom/client"),
    root: window.document.getElementById("root"),
  };
}

/** An agent handle that records what it would publish. Buzz tools that need
 * a connected community fail as they do when it is offline. */
function recordingHandle(published) {
  const pubkey = hex(32);
  return {
    key: pubkey,
    pubkey,
    name: AGENT_NAME,
    owner: hex(32),
    publish: async (event) => {
      const signed = {
        ...event,
        id: hex(32),
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        sig: "",
      };
      published.push(signed);
      return signed;
    },
    query: async () => [],
    searchProfiles: async () => [],
    tabs: () => undefined,
  };
}

/** The app around one loaded plugin, and what the scenarios act through. */
class Stage {
  children = new Set();
  servers = new Set();
  listeners = new Set();
  cleanups = [];
  published = [];
  running = [];
  spawned = [];
  types = [];
  wire = new Wire();
  mcp = { tools: [], reconnects: 0 };
  storage = memoryStore();

  constructor(manifest, plugin, workspace, app, real = false) {
    this.real = real;
    this.turnMs = TURN_TIMEOUT_MS;
    this.manifest = manifest;
    this.plugin = plugin;
    this.workspace = workspace;
    this.app = app;
  }

  /** Loads the plugin as the app does. */
  apply() {
    const { plugin, manifest } = this;
    plugin.apply({
      pluginOwner: { id: manifest.id },
      react: this.app.react,
      effect: (setup) => this.cleanups.push(setup()),
      host: {
        spawn: processHost(
          manifest,
          this.children,
          this.wire,
          this.spawned,
          this.real,
        ),
        serveMcp: mcpHost(this.servers, this.mcp),
        resolveDirectory: async (path) => {
          const dir = expand(path);
          mkdirSync(dir, { recursive: true });
          return dir;
        },
        readFile: async (path, { cwd } = {}) =>
          new Uint8Array(
            readFileSync(expand(path, cwd ? expand(cwd) : homedir())),
          ),
      },
      agents: {
        register: (type) => this.types.push(type),
        relay: () => undefined,
        core: async () => undefined,
        tools: () => [],
        storage: this.storage,
        snapshot: () => ({ status: "ready", running: this.running }),
        subscribe: (listener) => {
          this.listeners.add(listener);
          return () => this.listeners.delete(listener);
        },
      },
    });
    const [type] = this.types;
    assert(
      this.types.length === 1 && type.id === plugin.TYPE_ID,
      `expected one ${plugin.TYPE_ID} type, got ${this.types.length}`,
    );
    this.type = type;
  }

  changed() {
    for (const listener of this.listeners) listener();
  }

  /** A saved agent with `config`, running. */
  agent(config) {
    const handle = recordingHandle(this.published);
    const agent = {
      key: handle.key,
      type: `${this.manifest.id}/${this.plugin.TYPE_ID}`,
      name: AGENT_NAME,
      config,
      handle,
    };
    this.running.push(agent);
    this.changed();
    return agent;
  }

  /** A one-off turn. Resolves with what the stand-in posted through `send`. */
  async once(agent, extra = {}) {
    const channel = randomUUID();
    const nonce = token();
    const prompt = `SEND-CHANNEL:${channel} ${nonce}`;
    const result = await deadline(
      this.type.runOnce({
        delivery: {
          agent: agent.handle,
          config: agent.config,
          team: "",
          ...extra,
        },
        key: "smoke",
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        prompt: async () => prompt,
      }),
      TURN_TIMEOUT_MS,
      "the one-off turn",
    );
    assert(result.ok, `the turn failed: ${result.error ?? "no error given"}`);
    const sent = this.published.find(
      (event) =>
        event.content.includes(nonce) &&
        event.tags.some(([key, value]) => key === "h" && value === channel),
    );
    assert(sent, "dsh did not post through `send`");
    return sent;
  }

  /** A message from the owner that mentions the agent, as the app delivers
   * it. Resolves with the outcome of the work it joined. */
  async mention(agent, channel, content, root, picks = {}) {
    const working = [];
    await this.type.run({
      trigger: {
        type: "mention",
        event: {
          id: hex(32),
          pubkey: agent.handle.owner,
          kind: CHAT_KIND,
          created_at: Math.floor(Date.now() / 1000),
          content,
          tags: [["h", channel], ...(root ? [["e", root, "", "reply"]] : [])],
          sig: "",
        },
      },
      channelId: channel,
      agent: agent.handle,
      config: agent.config,
      team: "",
      ...picks,
      signal: AbortSignal.timeout(this.turnMs),
      workingUntil: (done) => working.push(done),
    });
    const [outcome] = await deadline(
      Promise.all(working),
      this.turnMs,
      "the mention",
    );
    return outcome;
  }

  /** The Buzz message holding `nonce`, once posted. */
  async posted(nonce) {
    await until(
      `the post with ${nonce}`,
      () => this.published.some((event) => event.content.includes(nonce)),
      this.turnMs,
    );
    return this.published.find((event) => event.content.includes(nonce));
  }

  async close() {
    for (const cleanup of this.cleanups)
      if (typeof cleanup === "function") cleanup();
    await Promise.all([...this.servers].map((server) => server.close()));
    await Promise.all(
      [...this.children].map((child) =>
        stop(child, new Promise((done) => child.on("exit", done))),
      ),
    );
  }
}

/** The plugin's identity, as saved agents and grants name it. */
function checkIdentity(stage) {
  const { manifest, plugin, type } = stage;
  assert(manifest.id === "sagmans.dsh", `plugin id ${manifest.id}`);
  assert(plugin.TYPE_ID === "dsh", `type id ${plugin.TYPE_ID}`);
  assert(type.title === "DSH", `title ${type.title}`);
  const grant = JSON.stringify(manifest.host);
  assert(
    grant ===
      '{"processes":[{"id":"dsh-acp","program":"dsh","args":["--profile"]}],"mcp":true,"files":true}',
    `the host grant changed: ${grant}`,
  );
  log("identity", `${manifest.id}/${plugin.TYPE_ID} ${grant}`);
}

/** A saved agent of the plugin's first version keeps its meaning, and a bad
 * saved profile never becomes a process argument. */
async function checkSavedConfig(stage) {
  const { type, workspace, spawned } = stage;
  const saved = {
    profile: PLAIN_PROFILE,
    model: PRO_MODEL,
    effort: "high",
    instructions: "Keep answers short.",
    workspace,
  };
  assert(
    type.summary({ config: saved }) === "DSH · fake · pro",
    `summary ${type.summary({ config: saved })}`,
  );
  assert(
    type.exportShared(saved).model === PRO_MODEL,
    "exportShared lost the model",
  );
  const agent = stage.agent(saved);
  const sent = await stage.once(agent);
  assert(
    spawned.some((args) => args.join(" ") === `dsh --profile ${PLAIN_PROFILE}`),
    `the saved profile did not start: ${JSON.stringify(spawned)}`,
  );
  const cwd = stage.wire.sent("session/new", PLAIN_PROFILE)[0]?.params.cwd;
  assert(cwd === workspace, `the session ran in ${cwd}`);
  assert(
    stage.wire.prompts(PLAIN_PROFILE)[0]?.includes(saved.instructions),
    "the saved instructions did not reach the session",
  );
  const bad = stage.agent({ profile: "--evil", workspace });
  await stage.once(bad);
  assert(
    !spawned.some((args) => args.includes("--evil")),
    "a saved flag reached the process",
  );
  assert(
    spawned.some((args) => args.join(" ") === "dsh --profile buzz"),
    "a bad saved profile did not fall back to buzz",
  );
  log("saved-config", `posted ${JSON.stringify(sent.content)}`);
  return agent;
}

/** dsh takes the session's MCP server, per agent and token, and every Buzz
 * tool reaches it. */
function checkTools(stage) {
  const [opened] = stage.wire.sent("session/new", PLAIN_PROFILE);
  const servers = opened.params.mcpServers;
  assert(
    servers.length === 1 && servers[0].type === "http",
    `session/new carried ${JSON.stringify(servers?.map((s) => s.type))}`,
  );
  const opens = stage.wire.sent("session/new");
  const secrets = opens.map(
    ({ params }) => params.mcpServers[0].headers[0].value,
  );
  assert(
    new Set(secrets).size === secrets.length,
    "two sessions share one MCP token",
  );
  assert(
    stage.mcp.tools.length === BUZZ_TOOL_COUNT,
    `${stage.mcp.tools.length} Buzz tools listed, not ${BUZZ_TOOL_COUNT}`,
  );
  for (const tool of ["send", "read", "watch_add"])
    assert(stage.mcp.tools.includes(tool), `no ${tool} tool`);
  assert(stage.mcp.reconnects === 0, "dsh connected to MCP twice");
  log("tools", `${stage.mcp.tools.length} listed, one token per session`);
}

/** A mention runs a turn with no time limit of the plugin's own, and answers
 * through `send`, with the shared prompt at its head. */
async function checkMention(stage, agent) {
  const channel = randomUUID();
  const root = hex(32);
  const nonce = token();
  const outcome = await stage.mention(agent, channel, `hello ${nonce}`, root);
  assert(outcome?.ok !== false, `mention: ${JSON.stringify(outcome)}`);
  const sent = await stage.posted(nonce);
  assert(sent.content.includes(" preamble "), `no prompt: ${sent.content}`);
  const later = token();
  await stage.mention(agent, channel, `again ${later}`, root);
  const second = await stage.posted(later);
  assert(
    second.content.includes(" no-preamble "),
    `prompt repeated: ${second.content}`,
  );
  log("mention", JSON.stringify(sent.content));
}

/** A pick reaches dsh as the config option its name says, with its
 * `["provider","model"]` model value, and the saved settings apply first. */
async function checkSelection(stage) {
  const profile = "picks";
  const agent = stage.agent({
    profile,
    model: PRO_MODEL,
    effort: "max",
    workspace: stage.workspace,
  });
  const channel = randomUUID();
  const root = hex(32);
  const nonce = token();
  await stage.mention(agent, channel, `pick ${nonce}`, root);
  const sent = await stage.posted(nonce);
  assert(
    sent.content.includes(`${PRO_MODEL} max`),
    `the saved picks did not apply: ${sent.content}`,
  );
  const sets = stage.wire.sent("session/set_config_option", profile);
  assert(
    sets.map(({ params }) => `${params.configId}=${params.value}`).join() ===
      `model=${PRO_MODEL},reasoning_effort=max`,
    `set_config_option: ${JSON.stringify(sets.map((m) => m.params))}`,
  );
  // Changed setting, as when the owner saves it: the next turn takes it.
  agent.config = { ...agent.config, effort: "low" };
  stage.changed();
  const later = token();
  await stage.mention(agent, channel, `pick again ${later}`, root);
  assert(
    (await stage.posted(later)).content.includes(`${PRO_MODEL} low`),
    "a changed effort did not reach the next turn",
  );
  log("picks", "model and effort reach set_config_option");
}

/** Saved conversations of the plugin's first version resume, the model and
 * effort are set again since dsh restores neither from the client's choice,
 * and a failed resume still answers the message in a new session. */
async function checkResume(stage) {
  const profile = "resuming";
  const resumable = "saved-session-1";
  process.env.FAKE_ACP_RESUMABLE = resumable;
  const agent = stage.agent({
    profile,
    model: PRO_MODEL,
    effort: "max",
    workspace: stage.workspace,
  });
  const channel = randomUUID();
  const root = hex(32);
  const gone = hex(32);
  const at = Date.now();
  // What the first version saved, as it saved it.
  await stage.storage.set(
    `sagmans.dsh/sessions/${agent.key}`,
    JSON.stringify({
      [`${channel}/${root}`]: { id: resumable, at },
      [`${channel}/${gone}`]: { id: "lost-session", at: at - 1 },
    }),
  );
  const listed = stage.type.sessions.list(agent.key);
  assert(
    listed.length === 2 && listed[0].root === root,
    `the saved conversations are not listed: ${JSON.stringify(listed)}`,
  );
  const nonce = token();
  await stage.mention(agent, channel, `resume ${nonce}`, root);
  const sent = await stage.posted(nonce);
  const [resume] = stage.wire.sent("session/resume", profile);
  assert(resume?.params.sessionId === resumable, "no session/resume");
  assert(
    !stage.wire.sent("session/load", profile).length,
    "the client asked for session/load",
  );
  assert(
    resume.params.mcpServers.length === 1,
    "the resumed session has no Buzz tools",
  );
  assert(
    !JSON.stringify(stage.wire.sent("session/new", profile)).includes(
      resumable,
    ),
    "a resume also opened a session",
  );
  assert(
    sent.content.includes(` preamble ${PRO_MODEL} max`),
    `model and effort were not set again after resume: ${sent.content}`,
  );
  const saved = JSON.parse(
    stage.storage.get(`sagmans.dsh/sessions/${agent.key}`),
  );
  assert(
    saved[`${channel}/${root}`].id === resumable,
    "the resumed id was not kept",
  );
  const fallback = token();
  const outcome = await stage.mention(
    agent,
    channel,
    `fallback ${fallback}`,
    gone,
  );
  assert(outcome?.ok !== false, `fallback: ${JSON.stringify(outcome)}`);
  await stage.posted(fallback);
  assert(
    stage.wire.sent("session/new", profile).length === 1,
    "a failed resume did not open a new session",
  );
  const replaced = JSON.parse(
    stage.storage.get(`sagmans.dsh/sessions/${agent.key}`),
  )[`${channel}/${gone}`];
  assert(replaced.id !== "lost-session", "the lost id stayed saved");
  // The owner's New session ends the conversation's session for good.
  const place = { channelId: channel, root };
  await until(
    "the resumed session to fall idle",
    () => stage.type.sessionControls.state(agent, place) === "idle",
  );
  await stage.type.sessionControls.run(agent, place, "new");
  const afresh = token();
  await stage.mention(agent, channel, `afresh ${afresh}`, root);
  await stage.posted(afresh);
  assert(
    stage.wire.sent("session/resume", profile).length === 2 &&
      stage.wire.sent("session/new", profile).length === 2,
    "New session resumed what it ended",
  );
  log("resume", JSON.stringify(sent.content));
  return agent;
}

/** A lasting grant never leaves the wire, as the first version never gave
 * one: the answer of each permission request names the one-time option. */
function checkPermissions(stage) {
  const answers = stage.wire.entries
    .filter(
      (entry) => entry.way === "out" && entry.message.result?.outcome?.optionId,
    )
    .map((entry) => entry.message.result.outcome.optionId);
  assert(
    answers.length && answers.every((option) => option === "allow-once"),
    `permission answers: ${answers}`,
  );
  log("permissions", `${answers.length} answers, all allow-once`);
}

/** The model picker renders with real React, reads the profile's models
 * through a throwaway session, and closes it without any turn. Each model's
 * efforts reach the per-message picks. */
/** The markup of the app's Settings row and details panel at the pinned
 * revision, which the build checks against the clone (ICON_SLOT_MARKS). */
function settingsSlot(id, attrs) {
  const element = document.createElement("div");
  element.setAttribute("id", id);
  for (const [name, value] of attrs) element.setAttribute(name, value);
  element.innerHTML =
    '<span aria-hidden="true" data-category="agents"><svg class="tabler-icon tabler-icon-layout-grid"></svg></span>';
  document.body.append(element);
  return element;
}

/** Passes when the plugin puts its artwork on its own Settings row and details
 * panel, on the app's tile, and leaves another plugin's row alone. */
async function checkSettingsIcon(pluginId) {
  const other = settingsSlot("plugin-description-other", [
    ["data-plugin-id", "other"],
  ]);
  const row = settingsSlot("row", [
    ["data-plugin-id", pluginId],
    ["aria-expanded", "true"],
  ]);
  const anchor = document.createElement("span");
  anchor.id = `plugin-description-${pluginId}`;
  row.append(anchor);
  const details = settingsSlot("plugin-details", []);
  const painted = (slot) => slot.querySelector("img")?.getAttribute("src");
  await until("the Settings icons", () => painted(row) && painted(details));
  for (const slot of [row, details]) {
    if (!painted(slot).startsWith(ICON_DATA_URL))
      throw new SmokeError(`not an inline icon: ${painted(slot).slice(0, 32)}`);
    if (!slot.querySelector("span").hasAttribute("data-branded"))
      throw new SmokeError("the icon is not on the app's tile");
    if (slot.querySelector("svg").style.display !== "none")
      throw new SmokeError("the generic icon still shows");
  }
  if (painted(other)) throw new SmokeError("painted another plugin's row");
  log("settings-icon", "on the row and the details panel, on the tile");
  return { row, details, other };
}

/** Passes when disabling the plugin puts the app's generic icon back. */
function checkSettingsIconRemoved({ row, details, other }) {
  for (const slot of [row, details]) {
    if (slot.querySelector("img"))
      throw new SmokeError("the icon stayed after the plugin stopped");
    if (slot.querySelector("span").hasAttribute("data-branded"))
      throw new SmokeError("the tile stayed after the plugin stopped");
    if (slot.querySelector("svg").style.display === "none")
      throw new SmokeError("the generic icon stayed hidden");
  }
  for (const slot of [row, details, other]) slot.remove();
  log("settings-icon-removed", "the generic icon is back");
}

async function checkViews(stage, profile) {
  const { type, app, workspace } = stage;
  const root = app.client.createRoot(app.root);
  root.render(
    app.react.createElement(type.CreateModel, {
      config: { profile },
      onChange: () => {},
      disabled: false,
    }),
  );
  try {
    await until("the model picker", () =>
      app.root.querySelector("button")?.textContent?.includes("Fast"),
    );
  } finally {
    root.unmount();
  }
  const agent = { config: { profile, workspace } };
  const picks = await type.models(agent);
  const listed = picks.models.map(
    ({ id, efforts }) => `${id}:${efforts.map((e) => e.id).join("/")}`,
  );
  assert(
    listed.join() ===
      `${FAST_MODEL}:off/low/high,${PRO_MODEL}:off/low/high/max`,
    `picks: ${listed.join()}`,
  );
  assert(picks.current === FAST_MODEL, `picks rest on ${picks.current}`);
  assert(
    !stage.wire.prompts(profile).length,
    "reading the models ran a prompt",
  );
  assert(
    stage.wire.sent("session/close", profile).length === 1,
    "the throwaway session was not closed",
  );
  const form = app.client.createRoot(app.root);
  const element = app.react.createElement(type.tabs[0].component, {
    agent: { config: { profile: "--evil", workspace: "bad" }, key: "smoke" },
    save: async () => {},
  });
  form.render(element);
  await until(
    "the settings form",
    () => app.root.textContent.includes("dsh profile"),
    VIEW_TIMEOUT_MS,
  );
  const text = app.root.textContent;
  form.unmount();
  for (const label of ["Reasoning effort", "Workspace", "Sessions"])
    assert(text.includes(label), `no ${label} field`);
  const synced = type.syncedSettings?.withSynced(
    { profile, workspace },
    { model: PRO_MODEL },
  );
  assert(
    synced?.model === PRO_MODEL && synced.profile === profile,
    "synced settings lost the profile",
  );
  log("views", `${picks.models.length} picks, settings render, synced apply`);
}

/** A per-message pick runs that turn on the model and effort it names, then
 * the session goes back to what it started on. */
async function checkPerMessage(stage) {
  const profile = "permessage";
  const agent = stage.agent({ profile, workspace: stage.workspace });
  const channel = randomUUID();
  const root = hex(32);
  const nonce = token();
  await stage.mention(agent, channel, `per ${nonce}`, root, {
    model: PRO_MODEL,
    effort: "max",
  });
  assert(
    (await stage.posted(nonce)).content.includes(`${PRO_MODEL} max`),
    "the per-message pick did not apply",
  );
  const later = token();
  await stage.mention(agent, channel, `back ${later}`, root);
  assert(
    (await stage.posted(later)).content.includes(`${FAST_MODEL} high`),
    "the session did not go back after the pick",
  );
  log("per-message", "pick applies for its turn only");
}

/** What the Activity tab and the app's usage read: the record of real turns,
 * with their transcripts, and no MCP token anywhere in it. */
async function checkActivity(stage, agent) {
  const { app, type } = stage;
  const tab = type.tabs.find(({ id }) => id === "activity");
  assert(tab, "no Activity tab");
  const recent = tab.component.history.recent(agent.key);
  assert(recent.length, "the record lists no session");
  const [row] = recent;
  const transcript = tab.component.history.transcript(agent.key, row.sessionId);
  assert(transcript?.turns.length, "the record has no turns");
  const root = app.client.createRoot(app.root);
  root.render(
    app.react.createElement(tab.component, {
      agent: { key: agent.key, name: AGENT_NAME, config: agent.config },
      close: () => {},
      openConversation: () => {},
    }),
  );
  await until(
    "the Activity tab",
    () => app.root.textContent.includes("Recent sessions"),
    VIEW_TIMEOUT_MS,
  );
  const button = app.root.querySelector(
    'button[aria-label^="View transcript"]',
  );
  assert(button, "the Activity tab shows no session");
  button.click();
  // Real Markdown, from the app's own transcript component.
  await until(
    "the transcript's Markdown",
    () =>
      app.root.querySelector('[class*="markdown"] strong')?.textContent ===
      "done",
    VIEW_TIMEOUT_MS,
  );
  assert(
    !app.root.textContent.includes("Recent sessions"),
    "an open transcript left the session list on the tab",
  );
  const back = app.root.querySelector('button[aria-label="Back to profile"]');
  assert(back, "an open transcript has no way back");
  back.click();
  await until(
    "the session list after Back",
    () => app.root.textContent.includes("Recent sessions"),
    VIEW_TIMEOUT_MS,
  );
  root.unmount();
  const stored = stage.storage
    .keys()
    .map((key) => stage.storage.get(key))
    .join("\n");
  assert(!stored.includes("Bearer "), "an MCP token reached agent storage");
  log(
    "activity",
    `${recent.length} sessions, ${transcript.turns.length} turns`,
  );
}

/** One event of a dsh session file, as dsh writes it. */
const fileEvent = (type, time, data) => ({ type, seq: time, time, data });
const userEvent = (time, text) =>
  fileEvent("user/message", time, {
    source: { kind: "user" },
    content: [{ type: "text", text }],
  });
const replyEvent = (time, text) =>
  fileEvent("assistant/message", time, {
    message: { content: [{ type: "text", text }] },
  });
/** A first prompt that names its agent and place, as the app writes it. */
const openingPrompt = (agent, channelId, root) =>
  `<context>\nAgent: ${agent}\nChannel: smoke (#${channelId})\nSession scope: thread\nThread root: ${root}\n</context>\n\nfixture prompt`;
/** `count` finished turns, the first opening the session. */
function fileTurns(agent, place, start, count, reply = "fixture reply") {
  return Array.from({ length: count }, (_, index) => {
    const at = start + index * 1000;
    return [
      fileEvent("turn/start", at, {}),
      userEvent(
        at,
        index
          ? "next prompt"
          : openingPrompt(agent, place.channelId, place.root),
      ),
      replyEvent(at + 1, reply),
      fileEvent("turn/end", at + 2, { reason: { kind: "completed" } }),
    ];
  }).flat();
}

/** Writes a session file as dsh does, one zstd frame per append. */
function writeSessionFile(cwd, projectKey, id, events, name = SESSION_FILE) {
  const folder = join(sessionsHome, "sessions", projectKey(cwd), id);
  mkdirSync(folder, { recursive: true });
  const line = (event) => Buffer.from(`${JSON.stringify(event)}\n`);
  const frames = events.map((event) => zstdCompressSync(line(event)));
  writeFileSync(join(folder, name), Buffer.concat(frames));
  return join(folder, name);
}

/** One long turn: a steer, a long tool result, and text past the record's cut. */
function detailedSession(agent, place, start) {
  return [
    fileEvent("turn/start", start, {}),
    userEvent(start, openingPrompt(agent, place.channelId, place.root)),
    userEvent(start + 1, "steered in"),
    fileEvent("tool/call", start + 2, {
      name: "bash",
      callId: "c1",
      arguments: JSON.stringify({ command: "ls" }),
    }),
    fileEvent("tool/result", start + 3, {
      message: {
        toolCallId: "c1",
        content: [{ type: "text", text: "o".repeat(LONG_OUTPUT_CHARS) }],
      },
    }),
    replyEvent(start + 4, `${"x".repeat(RECORD_TEXT_LIMIT)}${LONG_TAIL}`),
    fileEvent("turn/end", start + 5, { reason: { kind: "completed" } }),
  ];
}

/** The folds of dsh's files: no cut, steers, tool results, 50 turns. */
async function checkFileDetail(agent, tab, fixtures) {
  const { signal } = new AbortController();
  const source = agent.config;
  const read = await tab.files.conversation(
    agent.key,
    source,
    fixtures.detail,
    [],
    signal,
  );
  const [turn] = read.filed[0]?.turns ?? [];
  assert(turn, "the detailed session has no turn");
  const steer = turn.items.find((item) => item.type === "prompt" && item.steer);
  assert(steer, "a steered prompt lost its mark");
  const tool = turn.items.find((item) => item.type === "tool");
  assert(
    tool?.output.length === LONG_OUTPUT_CHARS && !tool.truncated,
    "a long tool result was cut",
  );
  const reply = turn.items.find((item) => item.type === "message");
  assert(reply?.text.endsWith(LONG_TAIL), "a long reply was cut");
  const long = await tab.files.conversation(
    agent.key,
    source,
    fixtures.long,
    [],
    signal,
  );
  assert(
    long.filed[0]?.turns.length === 50 && long.filed[0].more,
    "a long session is not its latest 50 turns with `more`",
  );
}

/** The record stands in for a broken file, and a working session shows the
 * record's running turn after the file's finished ones. */
async function checkFileFallback(agent, tab, row) {
  const { signal } = new AbortController();
  const source = agent.config;
  const broken = await tab.files.conversation(
    agent.key,
    source,
    row,
    [],
    signal,
  );
  assert(broken.failure, "a broken file was not reported");
  const shown = tab.mergedTranscript(tab.history, agent.key, broken, new Set());
  assert(shown?.turns.length, "a broken file hid a recorded session");
  const recorded = tab.history.transcript(agent.key, row.sessionId);
  const finished = {
    sessionId: row.sessionId,
    more: false,
    turns: [{ turnId: "file", startedAt: 1, endedAt: 2, items: [] }],
  };
  const working = tab.mergedTranscript(
    tab.history,
    agent.key,
    { sessionIds: [row.sessionId], filed: [finished] },
    new Set([row.sessionId]),
  );
  assert(
    working.turns[0].turnId === "file" &&
      working.turns.length === recorded.turns.length + 1,
    "a working session did not join the file and the record",
  );
}

/** The sessions dsh keeps: those from before this record show, those of another
 * agent do not, a bad file loses only itself, and one conversation's sessions
 * read as one. */
async function checkSessionFiles(stage, agent) {
  const { app, type, workspace } = stage;
  const tab = type.tabs.find(({ id }) => id === "activity").component;
  const { projectKey } = tab;
  const [row] = tab.history.recent(agent.key);
  const key = agent.key;
  const shared = { channelId: "fixture-channel", root: "fixture-root" };
  const write = (id, events, name) =>
    writeSessionFile(workspace, projectKey, id, events, name);
  const base = 1_000_000;
  write("old-a", [
    ...fileTurns(key, shared, base, 15),
    replyEvent(base + 20_000, `${"y".repeat(RECORD_TEXT_LIMIT)}${LONG_TAIL}`),
  ]);
  write("old-b", fileTurns(key, shared, base + 100_000, 40, "newer session"));
  write("foreign", fileTurns("other-agent", shared, base + 200_000, 1));
  const garbage = write("broken", []);
  writeFileSync(garbage, Buffer.from("not a zstd file"));
  const v3 = { channelId: "v3-channel", root: "v3-root" };
  write(
    "old-v3",
    fileTurns(key, v3, base + 300_000, 1),
    "session.v3.jsonl.zstd",
  );
  const cut = write("cut-off", fileTurns(key, v3, base + 400_000, 1));
  writeFileSync(cut, readFileSync(cut).subarray(0, -2));
  const fixtures = {
    detail: { sessionId: "detail", channelId: "d", root: "d" },
    long: { sessionId: "long", channelId: "l", root: "l" },
  };
  write("detail", detailedSession(key, fixtures.detail, base + 500_000));
  write("long", fileTurns(key, fixtures.long, base + 600_000, 60));
  // A recorded session whose file is broken.
  const recordedFile = write(row.sessionId, []);
  writeFileSync(recordedFile, Buffer.from("not a zstd file"));
  process.env.FAKE_ACP_LISTED = JSON.stringify(
    [
      "old-a",
      "old-b",
      "foreign",
      "broken",
      "old-v3",
      "cut-off",
      "detail",
      "long",
    ].map((sessionId) => ({ sessionId, cwd: workspace })),
  );
  const { signal } = new AbortController();
  const listed = await tab.files.recent(agent.key, agent.config, signal);
  const ids = listed.sessions.map(({ sessionId }) => sessionId);
  for (const id of ["old-a", "old-b", "old-v3", "cut-off", "detail", "long"])
    assert(ids.includes(id), `the store's session ${id} is not listed`);
  assert(!ids.includes("foreign"), "another agent's session is listed");
  assert(listed.failure?.includes("broken"), "a bad file was not reported");
  await checkFileDetail(agent, tab, fixtures);
  await checkFileFallback(agent, tab, row);
  const root = app.client.createRoot(app.root);
  root.render(
    app.react.createElement(tab, {
      agent: { key: agent.key, name: AGENT_NAME, config: agent.config },
      close: () => {},
      openConversation: () => {},
    }),
  );
  const button = () =>
    [
      ...app.root.querySelectorAll('button[aria-label^="View transcript"]'),
    ].find((item) => /fixture/.test(item.getAttribute("aria-label")));
  await until("a session from dsh's store", () => button(), VIEW_TIMEOUT_MS);
  await checkMergedView(app, tab, agent, shared, button);
  root.unmount();
  rmSync(recordedFile);
  delete process.env.FAKE_ACP_LISTED;
  log("session files", `${ids.length} sessions read from dsh's files`);
}

/** One conversation's two sessions, merged, in the real tab. */
async function checkMergedView(app, tab, agent, shared, button) {
  const { signal } = new AbortController();
  const read = await tab.files.conversation(
    agent.key,
    agent.config,
    { sessionId: "old-b", ...shared },
    [],
    signal,
  );
  const merged = tab.mergedTranscript(tab.history, agent.key, read, new Set());
  assert(
    merged.turns.length === 50 && merged.more,
    "two sessions of a conversation did not merge to the latest 50 turns",
  );
  assert(
    merged.turns.some((turn) => turn.sessionId === "old-a") &&
      merged.turns.some((turn) => turn.sessionId === "old-b"),
    "a conversation lost one of its sessions",
  );
  button().click();
  await until(
    "a transcript from dsh's files",
    () => app.root.textContent.includes("Showing the latest 50 turns"),
    VIEW_TIMEOUT_MS,
  );
  app.root.querySelector('button[aria-label="Back to profile"]').click();
}

/** The probe right after `initialize`, in both states. */
function checkProbe(stage, plain, bundled) {
  for (const [profile, wanted] of [
    [plain, -32601],
    [bundled, -32602],
  ]) {
    const [probe] = stage.wire.sent(STEER_METHOD, profile);
    assert(probe && !Object.keys(probe.params ?? {}).length, "no empty probe");
    const answer = stage.wire.entries.find(
      ({ profile: from, way, message }) =>
        from === profile && way === "in" && message.id === probe.id,
    );
    assert(
      answer?.message.error?.code === wanted,
      `${profile}: the probe got ${JSON.stringify(answer?.message)}`,
    );
  }
  log("probe", "-32601 absent, -32602 present");
}

/** Without the bundle a message mid-turn waits as the next turn, and no steer
 * is sent. */
async function checkQueue(stage, agent, profile) {
  const channel = randomUUID();
  const root = hex(32);
  const first = token();
  const second = token();
  const before = stage.wire.prompts(profile).length;
  const running = stage.mention(agent, channel, `FAKE_SLOW ${first}`, root);
  await until(
    "the slow turn",
    () => stage.wire.prompts(profile).length > before,
  );
  const next = stage.mention(agent, channel, `queued ${second}`, root);
  await Promise.all([running, next]);
  const one = await stage.posted(first);
  const two = await stage.posted(second);
  assert(!one.content.includes(second), `steered: ${one.content}`);
  assert(two.content.includes(second), "the second message was lost");
  assert(
    stage.wire.sent(STEER_METHOD, profile).length === 1,
    "a steer beyond the probe was sent without the bundle",
  );
  log("queue", "without the bundle the message ran as the next turn");
}

/** With the bundle a message mid-turn lands in the running turn. A steer it
 * refuses runs as the next turn instead. */
async function checkSteer(stage, agent, profile) {
  const channel = randomUUID();
  const root = hex(32);
  const first = token();
  const steered = token();
  const before = stage.wire.prompts(profile).length;
  const seen = stage.wire.entries.length;
  const running = stage.mention(agent, channel, `FAKE_SLOW ${first}`, root);
  await stage.wire.newRun(profile, seen);
  await stage.mention(agent, channel, `steer ${steered}`, root);
  await running;
  const sent = await stage.posted(first);
  assert(sent.content.includes(steered), `not steered: ${sent.content}`);
  const steers = stage.wire
    .sent(STEER_METHOD, profile)
    .filter((message) => message.params?.expectedRunId);
  assert(steers.length === 1, "no steer with expectedRunId");
  assert(
    stage.wire.prompts(profile).length === before + 1,
    "the steered message also ran as a turn",
  );

  const refused = token();
  const after = token();
  const again = randomUUID();
  const seenRefused = stage.wire.entries.length;
  const slow = stage.mention(
    agent,
    again,
    `FAKE_SLOW FAKE_REFUSE ${refused}`,
    root,
  );
  await stage.wire.newRun(profile, seenRefused);
  await new Promise((done) => setTimeout(done, STEER_SETTLE_MS));
  const steersBefore = stage.wire.sent(STEER_METHOD, profile).length;
  const queued = stage.mention(agent, again, `next ${after}`, root);
  await Promise.all([slow, queued]);
  assert(
    stage.wire.sent(STEER_METHOD, profile).length === steersBefore + 1,
    "no steer was tried",
  );
  const late = await stage.posted(after);
  assert(!late.content.includes(refused), `merged: ${late.content}`);
  log("steer", JSON.stringify(sent.content));
}

/** `/compact` runs only with the bundle. Without it no prompt leaves, so no
 * paid turn starts, and the owner reads what to do. */
async function checkCompact(stage, plainAgent, plain, bundledAgent, bundled) {
  const run = async (agent, profile) => {
    const channel = randomUUID();
    const root = hex(32);
    const nonce = token();
    await stage.mention(agent, channel, `before ${nonce}`, root);
    await stage.posted(nonce);
    const place = { channelId: channel, root };
    await until(
      "the session to fall idle",
      () => stage.type.sessionControls.state(agent, place) === "idle",
    );
    const result = await stage.type.sessionControls
      .run(agent, place, "compact")
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: String(error?.message ?? error) }),
      );
    return {
      result,
      sent: stage.wire
        .prompts(profile)
        .filter((text) => text === COMPACT_PROMPT).length,
    };
  };
  const refused = await run(plainAgent, plain);
  assert(refused.sent === 0, "/compact reached a dsh with no bundle");
  assert(!refused.result.ok, "/compact did not fail without the bundle");
  assert(
    refused.result.error.includes(
      `dsh plugin --profile ${plain} add link:/path/to/buzz-plugin-dsh/dsh-acp-buzz`,
    ),
    `the refusal gives no command: ${refused.result.error}`,
  );
  const compacted = await run(bundledAgent, bundled);
  assert(compacted.sent === 1, "/compact did not reach the bundle");
  assert(compacted.result.ok, `compact: ${compacted.result.error}`);
  log("compact", refused.result.error);
}

/** A model request as dsh writes it, with counts that do not overlap. */
const usageEvent = (at, id, inputTokens) =>
  fileEvent("assistant/message", at, {
    message: { id, source: { model: FAST_MODEL }, content: [] },
    usage: {
      inputTokens,
      outputTokens: 2,
      totalTokens: inputTokens + 7,
      cacheReadTokens: 5,
    },
  });

/** dsh's files give the usage the record never saw: older sessions, a compaction,
 * subagents at every depth. They win over the record, and a bad one is said. */
async function checkFileUsage(stage, agent, bundledAgent) {
  const { type, workspace } = stage;
  const { projectKey } = type.tabs.find(
    ({ id }) => id === "activity",
  ).component;
  const write = (id, events) =>
    writeSessionFile(workspace, projectKey, id, events);
  const place = { channelId: "usage-channel", root: "usage-root" };
  const base = 5_000_000;
  const catalog = (at, childId) =>
    fileEvent("subagent/catalog", at, { childId, mode: "worker", version: 1 });
  const opened = fileTurns(agent.key, place, base, 1);
  const written = [
    write("usage-parent", [
      ...opened,
      usageEvent(base + 10, "m-parent", 100),
      fileEvent("compaction/summary", base + 11, {
        compactionId: "m-compaction",
        model: FAST_MODEL,
        usage: { inputTokens: 40, outputTokens: 3, totalTokens: 43 },
      }),
      catalog(base + 12, "usage-child"),
    ]),
    write("usage-child", [
      usageEvent(base + 20, "m-child", 200),
      catalog(base + 21, "usage-grandchild"),
    ]),
    write("usage-grandchild", [usageEvent(base + 30, "m-grandchild", 300)]),
    write("usage-gone-parent", [
      ...fileTurns(agent.key, place, base + 40, 1),
      usageEvent(base + 50, "m-gone", 1),
      catalog(base + 51, "usage-no-such-child"),
    ]),
    write("usage-foreign", [
      ...fileTurns("other-agent", place, base, 1),
      usageEvent(base + 60, "m-foreign", 1),
    ]),
    write("usage-old", [
      ...fileTurns(agent.key, place, 1_000, 1),
      usageEvent(2_000, "m-old", 1),
    ]),
  ];
  const [recordedRow] = type.tabs
    .find(({ id }) => id === "activity")
    .component.history.recent(bundledAgent.key);
  const list = (ids) => {
    process.env.FAKE_ACP_LISTED = JSON.stringify(
      ids.map((sessionId) => ({ sessionId, cwd: workspace })),
    );
  };
  const read = (who) =>
    type.usage(who, {
      since: base - 1,
      signal: AbortSignal.timeout(VIEW_TIMEOUT_MS),
    });
  list(["usage-parent", "usage-gone-parent", "usage-foreign", "usage-old"]);
  const seen = await read(agent);
  const parent = seen.find(({ id }) => id === "usage-parent");
  const requests = parent?.observations.map(({ requestId }) => requestId);
  assert(
    ["m-parent", "m-compaction", "m-child", "m-grandchild"].every((id) =>
      requests?.includes(id),
    ) && parent.gaps.length === 0,
    `a session's use with its subagents: ${JSON.stringify(parent)}`,
  );
  const own = parent.observations.find(
    ({ requestId }) => requestId === "m-parent",
  );
  assert(
    own.tokens.input === 100 &&
      own.tokens.output === 2 &&
      own.tokens.cacheRead === 5 &&
      own.model === FAST_MODEL &&
      parent.channelId === place.channelId &&
      parent.lastAt === base + 30,
    `a request from a file: ${JSON.stringify(parent)}`,
  );
  const gone = seen.find(({ id }) => id === "usage-gone-parent");
  assert(gone?.gaps.length === 1, `a gone subagent: ${JSON.stringify(gone)}`);
  assert(
    !seen.some(({ id }) => id === "usage-foreign" || id === "usage-old"),
    "another agent's or a too old session has usage",
  );
  const again = await read(agent);
  assert(
    again.find(({ id }) => id === "usage-parent")?.revision === parent.revision,
    "an unchanged session changed its revision",
  );

  // The file of a recorded session replaces its record; a bad file leaves the
  // record's other sessions shown as partly read.
  write(recordedRow.sessionId, [
    ...fileTurns(bundledAgent.key, place, base, 1),
    usageEvent(base + 70, "m-filed", 7),
  ]);
  list([recordedRow.sessionId]);
  const filed = await read(bundledAgent);
  const replaced = filed.filter(({ id }) => id === recordedRow.sessionId);
  assert(
    replaced.length === 1 &&
      replaced[0].observations.length === 1 &&
      replaced[0].observations[0].requestId === "m-filed",
    `a recorded session's file: ${JSON.stringify(replaced)}`,
  );
  const bad = write("usage-broken", []);
  writeFileSync(bad, Buffer.from("not a zstd file"));
  rmSync(
    join(
      sessionsHome,
      "sessions",
      projectKey(workspace),
      recordedRow.sessionId,
    ),
    { recursive: true },
  );
  list(["usage-broken"]);
  const partly = await read(bundledAgent);
  assert(
    partly.length > 0 && partly.every(({ gaps }) => gaps.length > 0),
    `a bad file over the record: ${JSON.stringify(partly)}`,
  );
  delete process.env.FAKE_ACP_LISTED;
  for (const file of written.concat(bad))
    rmSync(dirname(file), { recursive: true });
  log("file usage", `${requests.length} requests in a session and subagents`);
}

/** Token use reaches the app's usage from the bundle's prompt answers only. */
async function checkUsage(stage, plainAgent, bundledAgent) {
  const options = { since: 0, signal: AbortSignal.timeout(VIEW_TIMEOUT_MS) };
  const seen = async (agent) =>
    (await stage.type.usage(agent, options)).flatMap(
      ({ observations }) => observations,
    );
  const counted = await seen(bundledAgent);
  const [first] = counted;
  assert(
    first?.tokens.input === 120 &&
      first.tokens.output === 35 &&
      first.tokens.cacheRead === 80 &&
      first.tokens.cacheWrite === 10 &&
      first.model === FAST_MODEL,
    `usage with the bundle: ${JSON.stringify(counted)}`,
  );
  const none = await seen(plainAgent);
  assert(!none.length, `usage without the bundle: ${JSON.stringify(none)}`);
  log(
    "usage",
    `${counted.length} turns, first ${JSON.stringify(first.tokens)}`,
  );
}

/** The provider dialog says, per profile, whether the bundle is there. */
async function checkProviderDialog(stage, plain, bundled) {
  const { app, type } = stage;
  await type.provider.check();
  assert(
    type.provider.snapshot().readiness === "ready",
    `provider: ${JSON.stringify(type.provider.snapshot())}`,
  );
  const root = app.client.createRoot(app.root);
  root.render(
    app.react.createElement(type.provider.DialogBody, { onClose: () => {} }),
  );
  await until(
    "the provider dialog",
    () => app.root.textContent.includes(`Profile ${plain}`),
    VIEW_TIMEOUT_MS,
  );
  const text = app.root.textContent;
  root.unmount();
  for (const part of [
    `Profile ${plain}: dsh-acp-buzz is not added.`,
    `dsh plugin --profile ${plain} add link:/path/to/buzz-plugin-dsh/dsh-acp-buzz`,
    `Profile ${bundled}: dsh-acp-buzz is present.`,
    "Installed: Yes, version 0.0.0-fake",
  ])
    assert(text.includes(part), `the dialog has no "${part}": ${text}`);
  log("provider", "bundle state and add command shown per profile");
}

/** The scenarios, in the order the plugin's parts build on each other. */
async function scenarios(stage) {
  checkIdentity(stage);
  const agent = await checkSavedConfig(stage);
  checkTools(stage);
  await checkMention(stage, agent);
  await checkSelection(stage);
  await checkResume(stage);
  checkPermissions(stage);
  await checkViews(stage, "viewing");
  await checkPerMessage(stage);
  await checkActivity(stage, agent);
  await checkSessionFiles(stage, agent);
  const bundledAgent = stage.agent({
    profile: BUNDLED_PROFILE,
    workspace: stage.workspace,
  });
  await stage.once(bundledAgent);
  checkProbe(stage, PLAIN_PROFILE, BUNDLED_PROFILE);
  await checkQueue(stage, agent, PLAIN_PROFILE);
  await checkSteer(stage, bundledAgent, BUNDLED_PROFILE);
  await checkCompact(
    stage,
    agent,
    PLAIN_PROFILE,
    bundledAgent,
    BUNDLED_PROFILE,
  );
  await checkUsage(stage, agent, bundledAgent);
  await checkFileUsage(stage, agent, bundledAgent);
  await checkProviderDialog(stage, PLAIN_PROFILE, BUNDLED_PROFILE);
}

/** The provider's read on a real dsh: it opens a throwaway session and closes
 * it, and it reports what the built plugin found. A turn is a model call, so
 * this part fails if a prompt reached the wire. */
async function checkRealDsh(stage, profiles, liveTurn, pick = {}) {
  const agents = profiles.map((profile) =>
    stage.agent({ profile, workspace: stage.workspace, ...pick }),
  );
  await checkDialogText(stage, profiles);
  assert(
    !stage.wire.sent("session/prompt").length,
    "a real dsh was sent a prompt",
  );
  log("real dsh", `${stage.wire.entries.length} wire messages, no prompt`);
  if (liveTurn) await checkLiveTurn(stage, agents[0], profiles[0]);
}

/** Whether the first process of `profile` answered the probe as a bundle. */
function hasBundle(stage, profile) {
  const [probe] = stage.wire.sent(STEER_METHOD, profile);
  const answer = stage.wire.entries.find(
    ({ profile: from, way, message }) =>
      from === profile && way === "in" && message.id === probe?.id,
  );
  return answer?.message.error?.code === BUNDLE_PRESENT_CODE;
}

/** The order of a real run's messages, with no message text. A paid run cannot
 * be repeated to look again, so its one log must say how far each turn came. */
function logWire(stage) {
  for (const { way, message } of stage.wire.entries) {
    const update = message.params?.update;
    const run = update?._meta?.dsh?.activeRunId;
    const parts = [
      way,
      message.method ?? `answer ${message.id}`,
      update?.sessionUpdate,
      run === undefined ? undefined : `run=${run === null ? "none" : "set"}`,
      message.params?.configId,
      message.params?.value,
      message.error
        ? `error ${message.error.code} ${message.error.message}`
        : undefined,
      message.result?.stopReason,
      message.result?.configOptions
        ?.map(({ id, options }) => `${id}:${options?.length}`)
        .join(","),
    ];
    log("wire", parts.filter(Boolean).join(" "));
  }
}

/** The turns only a real model can prove. Each one costs money, so only an
 * explicit `--live-turn` runs this, and no check ever does. With no bundle it
 * proves the plain turn, and says what stayed untried. */
async function checkLiveTurn(stage, agent, profile) {
  stage.turnMs = LIVE_TURN_TIMEOUT_MS;
  const channel = randomUUID();
  const root = hex(32);
  if (!stage.skipPlainTurn) {
    const nonce = token();
    await stage.mention(
      agent,
      channel,
      `Use the send tool to post exactly this in this thread: ${nonce}`,
      root,
    );
    await stage.posted(nonce);
    log(
      "live",
      `the turn answered through send, ${stage.mcp.tools.length} tools`,
    );
  }
  if (!hasBundle(stage, profile)) {
    log("live", "no bundle: steer, compact and usage not tried");
    return;
  }
  const place = { channelId: channel, root };
  // A send with `final: true` ends the wait for the mention while the turn still
  // runs. A message then would steer into that turn, not start the slow one.
  await until(
    "the first turn to end",
    () => stage.type.sessionControls.state(agent, place) === "idle",
    stage.turnMs,
  );
  const steered = token();
  const seen = stage.wire.entries.length;
  const running = stage.mention(
    agent,
    channel,
    `Run the command \`${LIVE_SLOW_COMMAND}\`, then post through send: ${token()}`,
    root,
  );
  await stage.wire.newRun(profile, seen);
  await stage.mention(
    agent,
    channel,
    `Also post this through send: ${steered}`,
    root,
  );
  await running;
  await stage.posted(steered);
  assert(
    stage.wire
      .sent(STEER_METHOD, profile)
      .some((message) => message.params?.expectedRunId),
    "the message mid-turn was not steered",
  );
  log("live", "the message mid-turn was steered and answered");
  await until(
    "the session to fall idle",
    () => stage.type.sessionControls.state(agent, place) === "idle",
    stage.turnMs,
  );
  await stage.type.sessionControls.run(agent, place, "compact");
  log("live", "compact done");
  const recorded = await stage.type.usage(agent, {
    since: 0,
    signal: AbortSignal.timeout(VIEW_TIMEOUT_MS),
  });
  const turns = recorded.flatMap(({ observations }) => observations);
  assert(turns.length, "no usage was recorded");
  log("live", `usage of ${turns.length} turns recorded`);
  // What the run spent and what it ran on, as the proof of a paid run.
  log("live", `tokens ${JSON.stringify(turns.map(({ tokens }) => tokens))}`);
  log(
    "live",
    `options ${JSON.stringify(
      stage.wire
        .sent("session/set_config_option", profile)
        .map(({ params }) => [params?.configId, params?.value]),
    )}`,
  );
  log("live", `prompts ${stage.wire.sent("session/prompt", profile).length}`);
  await checkRealSessionFile(stage, agent, channel, root);
}

/** What real dsh wrote reads back: its folder name, its format, its list. */
async function checkRealSessionFile(stage, agent, channel, root) {
  const tab = stage.type.tabs.find(({ id }) => id === "activity").component;
  const { signal } = new AbortController();
  const listed = await tab.files.recent(agent.key, agent.config, signal);
  const row = listed.sessions.find(
    ({ channelId, root: thread }) => channelId === channel && thread === root,
  );
  assert(row, `dsh's store did not list the turn's session: ${listed.failure}`);
  const read = await tab.files.conversation(
    agent.key,
    agent.config,
    row,
    [],
    signal,
  );
  const items = read.filed
    .flatMap(({ turns }) => turns)
    .flatMap((turn) => turn.items);
  assert(
    items.some((item) => item.type === "prompt") &&
      items.some((item) => item.type === "tool" || item.type === "message"),
    `dsh's file read to nothing: ${read.failure}`,
  );
  log("live", `session file read back: ${items.length} items`);
}

/** Runs the check and prints what the dialog shows. */
async function checkDialogText(stage, profiles) {
  const { app, type } = stage;
  await type.provider.check();
  const root = app.client.createRoot(app.root);
  root.render(
    app.react.createElement(type.provider.DialogBody, { onClose: () => {} }),
  );
  await until(
    "the provider dialog",
    () => app.root.textContent.includes(`Profile ${profiles[0]}`),
    VIEW_TIMEOUT_MS,
  );
  log("dialog", app.root.textContent);
  log("readiness", JSON.stringify(type.provider.snapshot()));
  root.unmount();
  assert(
    type.provider.snapshot().readiness === "ready",
    "the provider is not ready",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // A real run writes a session folder in dsh's home: never by default in the
  // owner's own one.
  if (options.realProfiles && !process.env.DSH_HOME)
    throw new SmokeError("--real-dsh needs DSH_HOME set to a throwaway copy", {
      exit: EXIT_USAGE,
    });
  const manifest = JSON.parse(
    readFileSync(join(options.plugin, "manifest.json"), "utf8"),
  );
  // First: bundled app modules read `document` as they load, as in the app.
  const app = appRuntime();
  const plugin = await import(
    pathToFileURL(join(options.plugin, "plugin.js")).href
  );
  const workspace = mkdtempSync(join(tmpdir(), "dsh-smoke-"));
  sessionsHome = process.env.DSH_HOME || join(workspace, "dsh-home");
  // Node's own localStorage needs a file flag and warns on each read; the
  // app's is per profile, so a fresh one in memory stands in for it.
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
  const stage = new Stage(
    manifest,
    plugin,
    workspace,
    app,
    Boolean(options.realProfiles),
  );
  let iconSlots;
  try {
    stage.apply();
    iconSlots = await checkSettingsIcon(manifest.id);
    if (options.realProfiles) {
      // A live turn must name the model the spend was approved for: a profile
      // default can be another provider.
      stage.skipPlainTurn = options.skipPlainTurn;
      const pick = {
        ...(options.model && { model: options.model }),
        ...(options.effort && { effort: options.effort }),
      };
      try {
        await checkRealDsh(stage, options.realProfiles, options.liveTurn, pick);
      } finally {
        logWire(stage);
      }
    } else {
      await scenarios(stage);
      log("all scenarios passed");
    }
  } finally {
    await stage.close();
    rmSync(workspace, { recursive: true, force: true });
  }
  if (iconSlots) checkSettingsIconRemoved(iconSlots);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`smoke: FAILED: ${error.message}`);
    if (error.cause) console.error(error.cause);
    process.exit(error.exit ?? EXIT_FAIL);
  },
);
