// The DSH agent type's Activity tab: its sessions and their transcripts,
// laid out as buzz-app's Goose type lays out its own (src/bundled/goose/
// tabs.tsx, Apache-2.0, see NOTICE), from the app's own components. Goose's tab
// reads goose's database; this one reads dsh's session files
// (./session-files.ts), and the plugin's local record (./recorder.ts,
// ./history.ts) for a turn as it streams and for a file it cannot read.
import { useEffect, useState, useSyncExternalStore } from "react";
import activityStyles from "@app/features/agents/ActivityLayout.module.css";
import { ActivityTranscript } from "@app/features/agents/ActivityTranscript";
import {
  OpenedConversation,
  useOpenedSession,
  useOpenTranscript,
} from "@app/features/agents/OpenedConversation";
import type { AgentViewProps } from "@app/features/agents/service";
import { PanelSubview } from "@app/features/panels/PanelSubview";
import { formatItemTimestamp } from "@app/shared/datetime";
import { Button } from "@app/shared/design-system/ui/Button";
import { InlineHeader } from "@app/shared/design-system/ui/Header";
import { SettingsGroup } from "@app/shared/design-system/ui/SettingsGroup";
import type { GooseRuntime } from "@app/bundled/goose/runtime";
import { type Place, type RecordedHistory, TURN_LIMIT } from "./history";
import { type DshConfig, dshConfig } from "./profiles";
import type { ActivityRecorder } from "./recorder";
import {
  type ConversationRead,
  type FileList,
  mergedRows,
  mergedTranscript,
  projectKey,
  type SessionFiles,
} from "./session-files";

/** The type's name for its sessions, in the app's sentences. */
const HARNESS = "DSH";
/** The characters of an id that name it in a row without a title. */
const SHORT_ID = 8;
/** Names the way out of a transcript, which covers the session list. */
const BACK_LABEL = "Back to profile";
/** Until the store's list is read, the record's rows show alone. */
const NO_FILES: FileList = { sessions: [] };

type Viewed = AgentViewProps<DshConfig>;

type Row = Readonly<{
  key: string;
  sessionId: string;
  title: string;
  channelId: string;
  root?: string;
  at?: number;
}>;
const placeOf = (key: string): Place => {
  const [channelId = key, root] = key.split("/");
  return { channelId, ...(root ? { root } : {}) };
};

/** What `read` settles to, read again when `key` changes; undefined until then.
 * A read that fails shows as its message, and the record still shows. */
function useRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  key: string,
): Readonly<{ value?: T; error?: string; done: boolean }> {
  const [state, setState] = useState<{
    key?: string;
    value?: T;
    error?: string;
  }>({});
  // `key` names what `read` reads: a new closure alone must not read again.
  useEffect(() => {
    const abort = new AbortController();
    read(abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setState({ key, value });
      },
      (error: unknown) => {
        if (!abort.signal.aborted)
          setState({
            key,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => abort.abort();
  }, [key]);
  return { ...state, done: state.key === key };
}

export function createActivity({
  runtime,
  history,
  recorder,
  files,
}: Readonly<{
  runtime: GooseRuntime;
  history: RecordedHistory;
  recorder: ActivityRecorder;
  files: SessionFiles;
}>) {
  /** Re-renders with each recorded change. Each store read also serves a paint
   * with no DOM, which is how the smoke run sees this tab. */
  const useRecord = () => {
    const revision = () => recorder.revision;
    return useSyncExternalStore(recorder.subscribe, revision, revision);
  };

  /** The sessions of a conversation that the record has, newest first. */
  const recordedIn = (agent: string, row: Row) =>
    history
      .recent(agent)
      .filter(
        (other) =>
          row.channelId &&
          other.channelId === row.channelId &&
          other.root === row.root,
      )
      .map((other) => other.sessionId);

  /** A conversation's transcript: dsh's files, read on open and on Refresh, and
   * the record as it changes. */
  function TranscriptView({
    agent,
    row,
    working,
    openConversation,
  }: {
    agent: Viewed["agent"];
    row: Row;
    working: ReadonlySet<string>;
    openConversation: Viewed["openConversation"];
  }) {
    useRecord();
    const [round, refresh] = useState(0);
    const {
      value: read,
      error,
      done,
    } = useRead<ConversationRead>(
      (signal) =>
        files.conversation(
          agent.key,
          dshConfig(agent.config),
          row,
          recordedIn(agent.key, row),
          signal,
        ),
      `${row.key}/${[...working].join()}/${round}`,
    );
    const transcript = mergedTranscript(
      history,
      agent.key,
      read ?? { sessionIds: [row.sessionId], filed: [] },
      working,
    );
    const turns =
      transcript && runtime.prompts(agent.key).shown(transcript.turns);
    const failure = error ?? read?.failure;
    return (
      <div className="grid gap-4">
        <div>
          <Button
            type="button"
            variant="ghost"
            onClick={() => refresh((value) => value + 1)}
          >
            Refresh
          </Button>
        </div>
        {failure && (
          <p className="m-0 text-body-sm text-subtle">
            Could not read part of dsh's sessions: {failure}
          </p>
        )}
        {!transcript || !turns ? (
          <p className="m-0 text-body-sm text-subtle">
            {done
              ? "This computer has no file or record of this session."
              : "Reading dsh's session…"}
          </p>
        ) : (
          <ActivityTranscript
            transcript={{ ...transcript, turns }}
            agentName={agent.name}
            openConversation={openConversation}
            // Only the newest turn can be running: an older one with no end
            // was cut off, and must not look alive beside the running one.
            state={(turnId) =>
              working.size && turnId === turns.at(-1)?.turnId
                ? "working"
                : undefined
            }
            before={
              transcript.more && (
                <p className="m-0 text-body-sm text-subtle">
                  Showing the latest {TURN_LIMIT} turns.
                </p>
              )
            }
          />
        )}
      </div>
    );
  }

  /** The list of sessions, each with its way to the transcript. */
  function SessionList({
    rows,
    label,
    status,
    show,
    failure,
    refresh,
  }: Readonly<{
    rows: readonly Row[];
    label: (row: Row) => string;
    status: (sessionId: string) => string | undefined;
    show: (row: Row) => void;
    failure: string | undefined;
    refresh: () => void;
  }>) {
    return (
      <section className={activityStyles.section}>
        <InlineHeader
          title="Recent sessions"
          actions={
            <Button type="button" variant="ghost" size="sm" onClick={refresh}>
              Refresh
            </Button>
          }
        />
        {failure && (
          <p className="m-0 text-body-sm text-subtle">
            Could not read part of dsh's sessions: {failure}
          </p>
        )}
        {rows.length ? (
          <SettingsGroup layout="form">
            <ul className={activityStyles.list}>
              {rows.map((row) => (
                <li key={row.sessionId} className={activityStyles.entry}>
                  <div className={activityStyles.row}>
                    <span className={activityStyles.copy}>
                      <span
                        className="block truncate text-label-sm"
                        title={label(row)}
                      >
                        {label(row)}
                      </span>
                      <span className="block text-body-sm text-subtle">
                        {[
                          status(row.sessionId),
                          row.at &&
                            formatItemTimestamp(row.at / 1000, {
                              withTime: true,
                            }),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="subtle"
                      size="sm"
                      aria-label={`View transcript: ${label(row)}`}
                      onClick={() => show(row)}
                    >
                      View transcript
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </SettingsGroup>
        ) : (
          <p className="m-0 text-body-sm text-subtle">
            None. A conversation's session starts when the agent is mentioned.
          </p>
        )}
      </section>
    );
  }

  /** The agent's sessions: the one it was opened from, recent ones, and their
   * transcripts. */
  function ActivityTab({
    agent,
    conversation,
    initialTranscript,
    close,
    openConversation,
  }: Viewed) {
    useRecord();
    const source = dshConfig(agent.config);
    const sessions = () => runtime.sessions(agent.key);
    const live = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      sessions,
      sessions,
    );
    const running = live.map(
      (session): Row => ({
        key: session.key,
        sessionId: session.sessionId ?? "",
        title: "",
        ...placeOf(session.key),
      }),
    );
    const {
      session: here,
      searching,
      error: lookupError,
    } = useOpenedSession(
      running.filter((row) => row.sessionId),
      conversation,
      async (place, signal) => {
        const found =
          history.find(agent.key, place) ??
          (await files.latest(agent.key, source, place, signal));
        return (
          found && {
            ...found,
            ...place,
            key: place.root
              ? `${place.channelId}/${place.root}`
              : place.channelId,
          }
        );
      },
    );
    const busy = (sessionId: string) =>
      live.find((session) => session.sessionId === sessionId)?.busy;
    const status = (sessionId: string) => {
      const working = busy(sessionId);
      return working === undefined ? undefined : working ? "Working" : "Idle";
    };
    const label = (row: Row) =>
      row.title ||
      `${row.channelId.slice(0, SHORT_ID)} · ${
        row.root ? `thread ${row.root.slice(0, SHORT_ID)}` : "channel"
      }`;
    const { open, show, back } = useOpenTranscript(
      conversation,
      label,
      initialTranscript && { initial: here, searching, ...initialTranscript },
      close,
    );
    const [round, refresh] = useState(0);
    const { value: stored = NO_FILES, error: listError } = useRead(
      (signal) => files.recent(agent.key, source, signal),
      `${source.workspace}/${source.profile}/${round}`,
    );
    const rows = mergedRows(history.recent(agent.key), stored.sessions)
      .filter((row) => row.sessionId !== here?.sessionId)
      .map((row): Row => ({ channelId: "", ...row, key: row.sessionId }));
    const working = new Set(
      live
        .filter((one) => one.busy && one.sessionId)
        .map((one) => one.sessionId as string),
    );
    // The app shows a transcript in its own panel tab through a context that a
    // bundled copy of these modules cannot reach. Without that host the subview
    // draws inline, so it takes the tab's place: under the list it would sit
    // out of sight, and the list would stay live behind it.
    if (open)
      return (
        <PanelSubview title={label(open)} backLabel={BACK_LABEL} onBack={back}>
          <TranscriptView
            key={open.key}
            agent={agent}
            row={open}
            working={working}
            openConversation={openConversation}
          />
        </PanelSubview>
      );
    return (
      <div className={activityStyles.activity}>
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness={HARNESS}
            session={here}
            searching={searching}
            error={lookupError}
            status={here && status(here.sessionId)}
            onView={() => here && show(here)}
          />
        )}
        <SessionList
          rows={rows}
          label={label}
          status={status}
          show={show}
          failure={listError ?? stored.failure}
          refresh={() => refresh((value) => value + 1)}
        />
      </div>
    );
  }

  // The smoke run has no DOM to render this tab in, so it reads the transcripts
  // through the tab, which proves they are what the tab shows.
  return {
    ActivityTab: Object.assign(ActivityTab, {
      history,
      files,
      mergedTranscript,
      projectKey,
    }),
  };
}
