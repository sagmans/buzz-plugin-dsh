// A DSH agent's sessions as dsh itself keeps them. The app's own agent types read
// their harness's history (buzz-app src/bundled/goose/transcript.ts), and this is
// the same for dsh: its ACP `session/list` names the sessions, in a short-lived
// process, and the session files hold what happened, because dsh's ACP server
// replays nothing (no `session/load`, and `session/resume` sends no history). The
// plugin only reads: dsh owns the format and the folder.
//
// The local record (./recorder.ts) stays what shows a running turn, and what
// shows a session whose file this cannot read.
import { AcpProcess } from "@app/features/agent-harness/acp/process";
import { errorMessage } from "@app/features/agent-harness/acp/steps";
import type { TranscriptTurn } from "@app/features/agents/activity-transcript";
import { Zstd } from "@hpcc-js/wasm-zstd";
import { DSH, REQUEST_TIMEOUT_MS, type Spawn } from "./dsh";
import type {
  RecordedHistory,
  RecordedTranscript,
  SessionRow,
} from "./history";
import { promptPlace } from "./recorder";
import {
  object,
  type Place,
  PROMPT_SOURCE,
  type SessionEvent,
  SessionTurns,
  textOf,
} from "./session-transcript";

/** The latest turns shown; the file keeps the rest. As the app's Activity tab. */
const TURN_LIMIT = 50;
/** Sessions read for one conversation, newest first. As the app's Goose type. */
const SESSION_LIMIT = 10;
/** The agent's sessions listed. As the app's Goose type. */
const RECENT_LIMIT = 30;
/** Sessions of a workspace looked through for the agent's: each costs a file
 * read, and one workspace can hold many sessions of other tools. */
const SCAN_LIMIT = 500;
/** dsh's folder for sessions, under its default home. The app gives a plugin no
 * way to read the environment that `$DSH_HOME` would change it in: with another
 * home the files are absent here, and the record shows. */
const SESSIONS_DIR = "~/.dsh/sessions";
/** dsh's file names, newest format first. dsh moves a v3 file to v4 only when it
 * opens the session, so older sessions stay v3. */
const SESSION_FILES = ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd"];
/** A session id goes into a file path. dsh's ids are UUIDs, older ones carry a
 * prefix: anything that could leave the session's folder is refused. */
const SESSION_ID = /^[0-9A-Za-z_-]{1,128}$/;
/** What `host.readFile` says when dsh has no such session. */
const MISSING = /no such file|could not find|not found/i;
/** What the decoder says when dsh was still writing the last frame. */
const CUT_SHORT = /truncated Zstandard input/i;
/** Compressed bytes given to the decoder at once. Zstd can inflate about 32,000
 * times, and the decoder returns all of a slice's output together: a small slice
 * keeps one call near 130 MiB, before `DECODED_LIMIT` can refuse the file. */
const SLICE_BYTES = 4 * 1024;
/** Slices decoded before the app gets a turn: the decoder runs on the app's main
 * thread, and a long session must not freeze the window. */
const SLICES_PER_TURN = 64;
/** A session file larger than this when decoded is refused, not read. The host
 * already caps the compressed file. */
const DECODED_LIMIT = 512 * 1024 * 1024;
const PROJECT_KEY_LIMIT = 251;
const SAFE_CHAR = /^[A-Za-z0-9._-]$/;
const SEPARATOR = /^[/\\:]$/;
const HEX = 16;
const ESCAPE_WIDTH = 4;
/** Scanned files remembered, so a Refresh does not decode what it just saw. */
const SCAN_CACHE_LIMIT = 2_000;

/** A session file or list that cannot be read as dsh's. */
export class DshHistoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DshHistoryError";
  }
}

export type FileHost = Readonly<{
  readFile(path: string): Promise<Uint8Array>;
  resolveDirectory(path: string): Promise<string>;
}>;
/** Which home folder and profile an agent's sessions are in. */
export type SessionSource = Readonly<{ workspace: string; profile: string }>;
/** A session from dsh's store, as a row of the Activity tab. */
export type FileSession = SessionRow & Readonly<{ cwd: string }>;
export type FileList = Readonly<{
  sessions: readonly FileSession[];
  /** What could not be read. The sessions listed are still good. */
  failure?: string;
}>;
export type FiledSession = Readonly<{
  sessionId: string;
  turns: readonly TranscriptTurn[];
  more: boolean;
}>;
export type ConversationRead = Readonly<{
  /** Every session of the conversation, newest first. */
  sessionIds: readonly string[];
  filed: readonly FiledSession[];
  failure?: string;
}>;
export type Target = Readonly<{
  sessionId: string;
  channelId?: string;
  root?: string;
}>;

/** dsh's folder name for a working directory. The same steps as `projectKey` in
 * dsh's dsh-session-persistence-jsonl, which owns the layout: a mismatch only
 * shows as "no session". */
export function projectKey(cwd: string) {
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
        : `~${(ch.codePointAt(0) ?? 0).toString(HEX).toUpperCase().padStart(ESCAPE_WIDTH, "0")}`;
  }
  const name = readable.replace(/^-+/, "") || "root";
  return `--${name.slice(0, PROJECT_KEY_LIMIT)}--`;
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve));

/** Gives each complete line of a zstd file to `onLine`, until it returns false.
 * dsh appends one frame at a time, so a file read mid-write ends in a cut frame:
 * what came before stands. A file dsh has just created holds no frame yet, which
 * is an empty session. */
async function readLines(
  bytes: Uint8Array,
  onLine: (line: string) => boolean,
  signal: AbortSignal,
) {
  if (!bytes.length) return;
  const zstd = await Zstd.load();
  zstd.resetDecompression();
  const decoder = new TextDecoder();
  let pending = "";
  let size = 0;
  for (let slice = 0; slice * SLICE_BYTES < bytes.length; slice += 1) {
    signal.throwIfAborted();
    const start = slice * SLICE_BYTES;
    const chunk = zstd.decompressChunk(
      bytes.subarray(start, start + SLICE_BYTES),
    );
    size += chunk.length;
    if (size > DECODED_LIMIT)
      throw new DshHistoryError(`the session is over ${DECODED_LIMIT} bytes`);
    const lines = (pending + decoder.decode(chunk, { stream: true })).split(
      "\n",
    );
    pending = lines.pop() ?? "";
    for (const line of lines) if (!onLine(line)) return;
    if ((slice + 1) % SLICES_PER_TURN === 0) await nextTask();
  }
  try {
    zstd.decompressEnd();
  } catch (error) {
    if (!CUT_SHORT.test(String(error))) throw error;
  }
}

/** The end of the last read in the queue. `Zstd.load()` gives one decoder with one
 * stream for the whole app, and `readLines` yields between slices: two reads at
 * once would mix their bytes without this queue. */
let lastRead: Promise<unknown> = Promise.resolve();

function readLinesInTurn(
  bytes: Uint8Array,
  onLine: (line: string) => boolean,
  signal: AbortSignal,
) {
  const read = lastRead.then(() => readLines(bytes, onLine, signal));
  lastRead = read.catch(() => undefined);
  return read;
}

/** Each event of a file. A line that is not JSON has nothing to show; a bug in
 * the caller must surface, so only the parse is guarded. */
const readEvents = (
  bytes: Uint8Array,
  onEvent: (event: SessionEvent) => boolean,
  signal: AbortSignal,
) =>
  readLinesInTurn(
    bytes,
    (line) => {
      let event: SessionEvent;
      try {
        event = JSON.parse(line);
      } catch {
        return true;
      }
      return onEvent(event);
    },
    signal,
  );

const samePlace = (row: Partial<Place>, place: Partial<Place>) =>
  row.channelId === place.channelId && row.root === place.root;

export class SessionFiles {
  /** What each scanned file said, by what it was when read. */
  private readonly scanned = new Map<
    string,
    Readonly<{ size: number; session: FileSession | undefined }>
  >();

  constructor(
    private readonly host: FileHost,
    private readonly spawnOf: (profile: string) => Spawn,
  ) {}

  /** A session's file, or undefined when dsh has none. */
  private async bytes(sessionId: string, cwd: string) {
    if (!SESSION_ID.test(sessionId))
      throw new DshHistoryError(
        `unexpected session id ${JSON.stringify(sessionId)}`,
      );
    for (const name of SESSION_FILES) {
      try {
        return await this.host.readFile(
          `${SESSIONS_DIR}/${projectKey(cwd)}/${sessionId}/${name}`,
        );
      } catch (error) {
        if (!MISSING.test(String(error))) throw error;
      }
    }
    return undefined;
  }

  /** dsh's sessions in a folder, newest first: `session/list` has the store's
   * index, and a process of its own, so no running agent is touched. */
  private async *listed(source: SessionSource, signal: AbortSignal) {
    const cwd = await this.host.resolveDirectory(source.workspace);
    // No bundle probe: a read asks only for the list, which every dsh has.
    const dsh = await AcpProcess.start(
      this.spawnOf(source.profile),
      { ...DSH },
      { cwd },
    );
    try {
      let seen = 0;
      let cursor: string | undefined;
      do {
        signal.throwIfAborted();
        const page = object(
          await dsh.request(
            "session/list",
            { cwd, ...(cursor ? { cursor } : {}) },
            REQUEST_TIMEOUT_MS,
          ),
        );
        const rows = Array.isArray(page?.sessions) ? page.sessions : [];
        for (const row of rows) {
          const { sessionId, cwd: folder } = object(row) ?? {};
          if (typeof sessionId !== "string") continue;
          if (seen++ >= SCAN_LIMIT) return;
          yield {
            sessionId,
            cwd: typeof folder === "string" ? folder : cwd,
          };
        }
        cursor =
          typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
      } while (cursor);
    } finally {
      dsh.kill();
    }
  }

  /** What a file says of its session, for `agent`: undefined when its first
   * prompt does not name that agent, so another tool's session never shows. */
  private async scan(
    agent: string,
    { sessionId, cwd }: Readonly<{ sessionId: string; cwd: string }>,
    signal: AbortSignal,
  ) {
    const bytes = await this.bytes(sessionId, cwd);
    if (!bytes) return undefined;
    const key = `${agent}/${sessionId}`;
    const known = this.scanned.get(key);
    if (known?.size === bytes.length) return known.session;
    let opening: ReturnType<typeof promptPlace> | undefined;
    let at = 0;
    await readEvents(
      bytes,
      ({ type, time, data }) => {
        if (typeof time === "number") at = time;
        const body = object(data);
        if (
          !opening &&
          type === "user/message" &&
          object(body?.source)?.kind === PROMPT_SOURCE
        ) {
          opening = promptPlace(textOf(body?.content));
          return opening.agent === agent;
        }
        return true;
      },
      signal,
    );
    const found: ReturnType<typeof promptPlace> | undefined = opening;
    const session: FileSession | undefined =
      found?.agent === agent
        ? {
            sessionId,
            cwd,
            title: found.title ?? "",
            at,
            ...(found.channelId ? { channelId: found.channelId } : {}),
            ...(found.root ? { root: found.root } : {}),
          }
        : undefined;
    if (this.scanned.size >= SCAN_CACHE_LIMIT) this.scanned.clear();
    this.scanned.set(key, { size: bytes.length, session });
    return session;
  }

  /** The agent's sessions in dsh's store, until `enough` of them are found. A
   * file that cannot be read loses only itself. */
  private async find(
    agent: string,
    source: SessionSource,
    enough: (sessions: readonly FileSession[]) => boolean,
    signal: AbortSignal,
  ): Promise<FileList> {
    const sessions: FileSession[] = [];
    const failures: string[] = [];
    try {
      for await (const row of this.listed(source, signal)) {
        signal.throwIfAborted();
        try {
          const session = await this.scan(agent, row, signal);
          if (session) sessions.push(session);
        } catch (error) {
          signal.throwIfAborted();
          failures.push(`${row.sessionId}: ${errorMessage(error)}`);
        }
        if (enough(sessions)) break;
      }
    } catch (error) {
      signal.throwIfAborted();
      failures.push(`dsh could not list its sessions: ${errorMessage(error)}`);
    }
    sessions.sort((a, b) => b.at - a.at);
    return {
      sessions,
      ...(failures.length ? { failure: failures.join("; ") } : {}),
    };
  }

  /** The agent's recent sessions in dsh's store, newest first. */
  recent(agent: string, source: SessionSource, signal: AbortSignal) {
    return this.find(
      agent,
      source,
      (sessions) => sessions.length >= RECENT_LIMIT,
      signal,
    );
  }

  /** The latest session of a conversation in dsh's store. */
  async latest(
    agent: string,
    source: SessionSource,
    place: Place,
    signal: AbortSignal,
  ) {
    const { sessions } = await this.find(
      agent,
      source,
      (found) => found.some((row) => samePlace(row, place)),
      signal,
    );
    return sessions.find((row) => samePlace(row, place));
  }

  /** One session's latest turns, or undefined when dsh has no such file. */
  private async fold(
    { sessionId, cwd }: Readonly<{ sessionId: string; cwd: string }>,
    place: Place | undefined,
    signal: AbortSignal,
  ): Promise<FiledSession | undefined> {
    const bytes = await this.bytes(sessionId, cwd);
    if (!bytes) return undefined;
    const fold = new SessionTurns(sessionId, place, TURN_LIMIT);
    await readEvents(
      bytes,
      (event) => {
        fold.add(event);
        return true;
      },
      signal,
    );
    return { sessionId, turns: fold.finish(), more: fold.more };
  }

  /** The sessions of `target`'s conversation, read from dsh's files. `recorded`
   * names the ones the record has, which a failed list must not hide. */
  async conversation(
    agent: string,
    source: SessionSource,
    target: Target,
    recorded: readonly string[],
    signal: AbortSignal,
  ): Promise<ConversationRead> {
    const cwd = await this.host.resolveDirectory(source.workspace);
    const place: Place | undefined = target.channelId
      ? {
          channelId: target.channelId,
          ...(target.root ? { root: target.root } : {}),
        }
      : undefined;
    const list: FileList = place
      ? await this.find(
          agent,
          source,
          (found) =>
            found.filter((row) => samePlace(row, place)).length >=
            SESSION_LIMIT,
          signal,
        )
      : { sessions: [] };
    const rows = list.sessions.filter((row) => place && samePlace(row, place));
    const sessionIds = [
      ...new Set([
        target.sessionId,
        ...rows.map((row) => row.sessionId),
        ...recorded,
      ]),
    ].slice(0, SESSION_LIMIT);
    const filed: FiledSession[] = [];
    const failures = list.failure ? [list.failure] : [];
    for (const sessionId of sessionIds) {
      signal.throwIfAborted();
      const folder =
        rows.find((row) => row.sessionId === sessionId)?.cwd ?? cwd;
      try {
        const read = await this.fold({ sessionId, cwd: folder }, place, signal);
        if (read) filed.push(read);
      } catch (error) {
        signal.throwIfAborted();
        failures.push(`${sessionId}: ${errorMessage(error)}`);
      }
    }
    return {
      sessionIds,
      filed,
      ...(failures.length ? { failure: failures.join("; ") } : {}),
    };
  }
}

/** The file's turns of a working session, then the record's of the turn dsh is
 * still writing: the record alone shows that one as it streams. */
function workingTurns(
  filed: FiledSession,
  recorded: RecordedTranscript,
): readonly TranscriptTurn[] {
  const ended = filed.turns.filter((turn) => turn.endedAt !== undefined);
  const since = Math.max(0, ...ended.map((turn) => turn.endedAt ?? 0));
  return [...ended, ...recorded.turns.filter((turn) => turn.startedAt > since)];
}

/** A conversation as the tab shows it: each session from its file when one is
 * readable, else from the record. Undefined when neither has a turn. */
export function mergedTranscript(
  history: RecordedHistory,
  agent: string,
  read: Pick<ConversationRead, "sessionIds" | "filed">,
  working: ReadonlySet<string>,
): RecordedTranscript | undefined {
  const turns: TranscriptTurn[] = [];
  let more = false;
  for (const sessionId of read.sessionIds) {
    const recorded = history.transcript(agent, sessionId);
    const filed = read.filed.find((item) => item.sessionId === sessionId);
    const hasFile = !!filed?.turns.length;
    more ||= hasFile ? filed.more : !!recorded?.more;
    if (!hasFile) turns.push(...(recorded?.turns ?? []));
    else if (recorded && working.has(sessionId))
      turns.push(...workingTurns(filed, recorded));
    else turns.push(...filed.turns);
  }
  if (!turns.length) return undefined;
  turns.sort((a, b) => a.startedAt - b.startedAt);
  return {
    turns: turns.slice(-TURN_LIMIT),
    more: more || turns.length > TURN_LIMIT,
  };
}

/** The tab's rows: the record's and the store's, each session once, newest
 * first. The record's row wins: it is at least as recent. */
export function mergedRows(
  recorded: readonly SessionRow[],
  stored: readonly FileSession[],
): SessionRow[] {
  const seen = new Set(recorded.map((row) => row.sessionId));
  return [...recorded, ...stored.filter((row) => !seen.has(row.sessionId))]
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_LIMIT);
}
