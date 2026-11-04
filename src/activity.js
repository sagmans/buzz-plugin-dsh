// The Activity tab of the agent panel: the session of the conversation the
// panel was opened from, the agent's recent sessions, and their transcripts.
// It is laid out as buzz-app's Goose type lays out its own (ActivityTab in
// src/bundled/goose/tabs.tsx), from the app's own components bundled unchanged.
// One difference: the app opens a transcript in its own panel tab through a
// React context that a plugin cannot reach, so here it replaces the tab's content
// and has a back button, as the app's subview does in a panel without tabs.
// Written with `createElement`, not JSX, for the same reason as src/views.js.
import { createElement as h, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import activityStyles from "@buzz/features/agents/ActivityLayout.module.css";
import { ActivityTranscript } from "@buzz/features/agents/ActivityTranscript";
import { OpenedConversation, useOpenedSession, useOpenTranscript } from "@buzz/features/agents/OpenedConversation";
import { PanelSubview } from "@buzz/features/panels/PanelSubview";
import { formatItemTimestamp } from "@buzz/shared/datetime";
import { Button } from "@buzz/shared/design-system/ui/Button";
import { InlineHeader } from "@buzz/shared/design-system/ui/Header";
import { SettingsGroup } from "@buzz/shared/design-system/ui/SettingsGroup";
import { TURN_LIMIT } from "./history.js";

const HARNESS = "DSH";
/** How many characters of an id name a conversation with no name. */
const SHORT_ID = 8;
/** The agent's recent sessions listed. */
const RECENT_LIMIT = 30;
const BACK_LABEL = "Back to profile";
const MS_PER_SECOND = 1000;
const message = (error) => (error instanceof Error ? error.message : String(error));
/** The runtime's rows already hold every session the plugin knows. */
const noSearch = async () => undefined;

/** A conversation key (`channel/root`, the root empty for a channel) as a place. */
const placeOf = (key) => {
  const [channelId = key, root] = key.split("/");
  return { channelId, ...(root ? { root } : {}) };
};

const label = (row) =>
  `${row.channelId.slice(0, SHORT_ID)} · ${row.root ? `thread ${row.root.slice(0, SHORT_ID)}` : "channel"}`;

/** "Working" or "Idle" for a session this app has open; nothing for the rest. */
const statusOf = (row) => (row.busy === undefined ? undefined : row.busy ? "Working" : "Idle");

/** `read()` as it settles, read again when `key` changes or on `retry`. A value
 * already shown stays while it is read again. */
function useRead(read, key) {
  const [state, setState] = useState({ status: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const kept = (prior) => (prior.value === undefined ? {} : { value: prior.value });
    setState((prior) => ({ status: "loading", ...kept(prior) }));
    read(abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setState({ status: "ready", value });
      },
      (error) => {
        if (!abort.signal.aborted) setState((prior) => ({ status: "error", error: message(error), ...kept(prior) }));
      },
    );
    return () => abort.abort();
    // `read` follows `key`.
  }, [key, round]);
  return [state, () => setRound((value) => value + 1)];
}

/** The note for what the transcript cannot show; null when it has turns. */
function TranscriptNote({ read }) {
  if (read.status === "error")
    return h("p", { role: "alert", className: "m-0" }, `Could not read the ${HARNESS} session: ${read.error}`);
  if (read.value) return null;
  if (read.status === "loading") return h("p", { role: "status", className: "m-0" }, `Reading the ${HARNESS} session…`);
  return h(
    "p",
    { className: "m-0 text-body-sm text-subtle" },
    `${HARNESS} has no session for this conversation on this computer. It may have been deleted, or it ran in a different workspace.`,
  );
}

/** One row of the recent sessions list. */
function RecentRow({ row, show }) {
  const when = row.at && formatItemTimestamp(row.at / MS_PER_SECOND, { withTime: true });
  return h(
    "li",
    { className: activityStyles.entry },
    h(
      "div",
      { className: activityStyles.row },
      h(
        "span",
        { className: activityStyles.copy },
        h("span", { className: "block truncate text-label-sm", title: label(row) }, label(row)),
        h("span", { className: "block text-body-sm text-subtle" }, [statusOf(row), when].filter(Boolean).join(" · ")),
      ),
      h(
        Button,
        { type: "button", variant: "subtle", size: "sm", "aria-label": `View transcript: ${label(row)}`, onClick: () => show(row) },
        "View transcript",
      ),
    ),
  );
}

export function createActivity(runtime, history, workspaceOf) {
  /** A conversation's turns across its sessions, read on open and on Refresh. A
   * refresh keeps the last result until the new one arrives; a turn ending
   * rereads, so its last steps show. */
  function TranscriptView({ agent, row, openConversation }) {
    const workspace = workspaceOf(agent.config);
    const working = runtime.activity(agent.key).some((other) => other.key === row.key && other.busy);
    const [read, retry] = useRead(
      (signal) => {
        const sessions = runtime.activity(agent.key).filter((other) => other.key === row.key);
        return history.transcript(sessions, workspace, placeOf(row.key), signal);
      },
      `${row.key}\u0000${workspace}\u0000${working}`,
    );
    const turns = read.value?.turns;
    return h(
      "div",
      { className: "grid gap-4" },
      h(
        "div",
        null,
        h(Button, { type: "button", variant: "ghost", loading: read.status === "loading", onClick: retry }, "Refresh"),
      ),
      h(TranscriptNote, { read }),
      read.value &&
        h(ActivityTranscript, {
          transcript: read.value,
          agentName: agent.name,
          openConversation,
          // Only the newest turn can be running: an older one with no end was cut off.
          state: (turnId) => (working && turnId === turns.at(-1)?.turnId ? "working" : undefined),
          before:
            read.value.more && h("p", { className: "m-0 text-body-sm text-subtle" }, `Showing the latest ${TURN_LIMIT} turns.`),
        }),
    );
  }

  /** The list view: the session of this conversation and the recent ones. */
  function SessionList({ rows, conversation, here, searching, lookupError, show, refresh }) {
    return h(
      "div",
      { className: activityStyles.activity },
      conversation &&
        h(OpenedConversation, {
          conversation,
          harness: HARNESS,
          session: here,
          searching,
          error: lookupError,
          status: here && statusOf(here),
          onView: () => here && show(here),
        }),
      h(
        "section",
        { className: activityStyles.section },
        h(InlineHeader, {
          title: "Recent sessions",
          actions: h(Button, { type: "button", variant: "ghost", size: "sm", onClick: refresh }, "Refresh"),
        }),
        rows.length > 0
          ? h(
              SettingsGroup,
              { layout: "form" },
              h(
                "ul",
                { className: activityStyles.list },
                rows.map((row) => h(RecentRow, { key: row.sessionId, row, show })),
              ),
            )
          : h("p", { className: "m-0 text-body-sm text-subtle" }, "None. A conversation's session starts when the agent is mentioned."),
      ),
    );
  }

  /** The agent's sessions: the one it was opened from, recent ones, and their
   * transcripts. */
  function ActivityTab({ agent, conversation, initialTranscript, close, openConversation }) {
    const [, setRound] = useState(0);
    const sessions = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.activity(agent.key),
    );
    const saved = useMemo(() => {
      const rows = new Map();
      // Newest first; a conversation's latest session stands for it.
      for (const row of sessions)
        if (!rows.has(row.key)) rows.set(row.key, { ...row, ...placeOf(row.key) });
      return [...rows.values()];
    }, [sessions]);
    const { session: here, searching, error: lookupError } = useOpenedSession(saved, conversation, noSearch);
    const { open, show, back } = useOpenTranscript(
      conversation,
      label,
      initialTranscript && { initial: here, searching, ...initialTranscript },
      close,
    );
    if (open)
      return h(
        PanelSubview,
        { title: label(open), backLabel: BACK_LABEL, onBack: back },
        h(TranscriptView, { key: open.key, agent, row: open, openConversation }),
      );
    return h(SessionList, {
      rows: saved.filter((row) => row.sessionId !== here?.sessionId).slice(0, RECENT_LIMIT),
      conversation,
      here,
      searching,
      lookupError,
      show,
      refresh: () => {
        runtime.refreshActivity(agent.key);
        setRound((value) => value + 1);
      },
    });
  }
  return ActivityTab;
}
