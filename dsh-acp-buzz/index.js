// dsh plugin: dsh's own ACP server behind a proxy that adds steering, a
// `/compact` turn and per-prompt usage for the Buzz `sagmans.dsh` plugin.
//
// Why a replacement row: dsh's ACP server keeps its JSON-RPC connection to
// itself, so a plugin next to it cannot add methods. Its `apply` takes the
// message stream from `config.stream`, so this plugin disables the base
// `acp` row (cordis.patch.yml), runs the same server with a stream of its
// own and routes messages through lib/bridge.js. Nothing else changes: the
// same sessions, tools, approvals and persistence answer every request that
// the bridge forwards.
//
// Module identity: the imports below must be the copies that dsh runs, not
// copies of this folder. The package lists them as peer dependencies, so
// dsh's loader resolves them from the dsh installation (see README).

import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import * as DshAcp from "@deepseek-ai/dsh-acp";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createBridge } from "./lib/bridge.js";

// ---- Fixed values -----------------------------------------------------------

export const name = "acp-buzz";
// The services dsh's ACP server needs; Cordis starts apply() after them.
export const inject = DshAcp.inject;
// The same settings as the base `acp` row (provider, model, page size).
export const Config = DshAcp.Config;

// Optional: a profile without a compaction engine still serves ACP, and
// `/compact` then says that compaction is not available.
const COMPACTION_SERVICE = "compaction";
const EFFECT_LABEL = "acp-buzz.proxy";

/**
 * Mounts dsh's ACP server behind the bridge.
 * @param ctx - the Cordis context of this row.
 * @param config - the base `acp` row config; `stream` replaces stdio in tests.
 */
export function apply(ctx, config) {
  const outer =
    config.stream ??
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  const clientWriter = outer.writable.getWriter();
  const toServer = new TransformStream();
  const serverWriter = toServer.writable.getWriter();
  const bridge = createBridge({
    agents: ctx.agents,
    compaction: () => ctx.get(COMPACTION_SERVICE),
    createUserMessage,
    newRunId: randomUUID,
    logger: ctx.logger,
    toClient: (message) => clientWriter.write(message),
    toServer: (message) => serverWriter.write(message),
  });
  ctx.on("session/event", (session, event) => {
    bridge.onSessionEvent(session.header.id, event);
  });
  DshAcp.apply(ctx, {
    ...config,
    stream: {
      readable: toServer.readable,
      writable: new WritableStream({ write: (message) => bridge.fromServer(message) }),
    },
  });
  const reader = outer.readable.getReader();
  pumpClient(ctx.logger, reader, bridge, serverWriter);
  ctx.effect(
    () => () => {
      reader.cancel().catch(() => undefined);
      return bridge.dispose();
    },
    EFFECT_LABEL,
  );
}

/** Feeds client messages to the bridge in order until stdin ends. The end
 * of the client stream ends dsh's server stream, which shuts dsh's ACP
 * server down as it does without this bundle. */
async function pumpClient(logger, reader, bridge, serverWriter) {
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await bridge.fromClient(value);
    }
    await serverWriter.close();
  } catch (error) {
    logger.warn(`acp-buzz: client stream failed: ${error?.message ?? String(error)}`);
    await serverWriter.abort(error).catch(() => undefined);
  }
}
