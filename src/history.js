// A DSH agent's transcripts, read from the session files dsh writes. dsh's ACP
// server cannot replay a session (it has no `session/load`, and `session/resume`
// sends no history), so the file is the only record. The plugin only reads it:
// dsh owns the format and the folder.
import { Decompress } from "fzstd";
import { SessionTurns } from "./transcript.js";

/** The latest turns shown; the file keeps the rest. */
export const TURN_LIMIT = 50;
/** Sessions read for one conversation, newest first. */
const SESSION_LIMIT = 10;
/** dsh's folder for sessions, under its default home. */
const SESSIONS_DIR = "~/.dsh/sessions";
const SESSION_FILE = "session.v4.jsonl.zstd";
/** A session id goes into a file path. dsh's ids are UUIDs: anything that could
 * leave the session's folder is refused. */
const SESSION_ID = /^[0-9A-Za-z_-]{1,128}$/;
/** What `host.readFile` says when dsh has no such session. */
const MISSING = /no such file|could not find|not found/i;
/** What the decoder says when dsh was still writing the last frame. */
const CUT_SHORT = /unexpected EOF/i;
/** Compressed bytes decoded before the app gets a turn: the decoder runs on the
 * app's main thread, and a long session must not freeze the window. */
const SLICE_BYTES = 256 * 1024;
/** A session file larger than this when decoded is refused, not read. The host
 * already caps the compressed file. */
const DECODED_LIMIT = 512 * 1024 * 1024;
const PROJECT_KEY_LIMIT = 251;
const SAFE_CHAR = /^[A-Za-z0-9._-]$/;
const SEPARATOR = /^[/\\:]$/;
const HEX = 16;
const ESCAPE_WIDTH = 4;

/** A session file that cannot be read as a session. */
export class DshHistoryError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DshHistoryError";
  }
}

/** dsh's folder name for a working directory. The same steps as `projectKey` in
 * dsh's dsh-session-persistence-jsonl, which owns the layout: a mismatch only
 * shows as "no session". */
export function projectKey(cwd) {
  let readable = "";
  let separatorRun = false;
  for (const ch of cwd) {
    if (SEPARATOR.test(ch)) {
      if (!separatorRun) readable += "-";
      separatorRun = true;
      continue;
    }
    separatorRun = false;
    readable +=
      ch !== "~" && SAFE_CHAR.test(ch)
        ? ch
        : `~${ch.charCodeAt(0).toString(HEX).toUpperCase().padStart(ESCAPE_WIDTH, "0")}`;
  }
  const name = readable.replace(/^-+/, "") || "root";
  return `--${name.slice(0, PROJECT_KEY_LIMIT)}--`;
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve));

/** Gives each complete line of a zstd file to `onLine`. dsh appends one frame at
 * a time, so a file read mid-write ends in a cut frame: what came before stands. */
async function readLines(bytes, onLine, signal) {
  const decoder = new TextDecoder();
  let pending = "";
  let size = 0;
  const stream = new Decompress((chunk) => {
    size += chunk.length;
    if (size > DECODED_LIMIT) throw new DshHistoryError(`the session is over ${DECODED_LIMIT} bytes`);
    const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });
  for (let start = 0; start < bytes.length; start += SLICE_BYTES) {
    signal.throwIfAborted();
    const end = Math.min(start + SLICE_BYTES, bytes.length);
    const last = end === bytes.length;
    try {
      stream.push(bytes.subarray(start, end), last);
    } catch (error) {
      if (!last || !CUT_SHORT.test(String(error))) throw error;
    }
    if (!last) await nextTask();
  }
}

export class DshHistory {
  constructor(host) {
    this.host = host;
  }

  /** One session's latest turns, or undefined when dsh has no such file. */
  async session({ sessionId, cwd }, fallback, place, signal) {
    if (!SESSION_ID.test(sessionId)) throw new DshHistoryError(`unexpected session id ${JSON.stringify(sessionId)}`);
    const folder = projectKey(cwd ?? (await fallback()));
    let bytes;
    try {
      bytes = await this.host.readFile(`${SESSIONS_DIR}/${folder}/${sessionId}/${SESSION_FILE}`);
    } catch (error) {
      if (MISSING.test(String(error))) return undefined;
      throw error;
    }
    const fold = new SessionTurns(sessionId, place, TURN_LIMIT);
    await readLines(
      bytes,
      (line) => {
        try {
          fold.add(JSON.parse(line));
        } catch (error) {
          // A line that is not JSON has nothing to show; a bug in the fold must surface.
          if (!(error instanceof SyntaxError)) throw error;
        }
      },
      signal,
    );
    return { turns: fold.finish(), more: fold.more };
  }

  /** The latest turns of `sessions`, oldest first, or undefined when dsh has none
   * of them. A session from before the plugin kept its folder is looked for in
   * `workspace`, the agent's current setting. */
  async transcript(sessions, workspace, place, signal) {
    const fallback = () => this.host.resolveDirectory(workspace);
    const newest = [...sessions].sort((a, b) => b.at - a.at).slice(0, SESSION_LIMIT);
    const read = [];
    for (const session of newest) {
      signal.throwIfAborted();
      const found = await this.session(session, fallback, place, signal);
      if (found) read.unshift(found);
    }
    if (!read.length) return undefined;
    const turns = read.flatMap((found) => found.turns);
    return {
      turns: turns.slice(-TURN_LIMIT),
      more: turns.length > TURN_LIMIT || read.some((found) => found.more),
    };
  }
}
