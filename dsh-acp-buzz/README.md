# dsh-acp-buzz: a dsh profile bundle for Buzz

This folder is a DeepSeek Harness (`dsh`) profile bundle. It runs dsh's own
ACP server (`@deepseek-ai/dsh-acp`) behind a small message proxy, and adds
the features that the Buzz DSH plugin uses:

| Feature | What the client sends | What the bundle does |
| --- | --- | --- |
| Steering | `_dsh/session/steer` | Puts the text into the running turn (`agent.steer`). |
| Run ids | (nothing) | Sends `session_info_update` with `_meta.dsh.activeRunId`. |
| Compaction | `session/prompt` with only `/compact` | Runs dsh's manual compaction, not a model turn. |
| Usage | (nothing) | Adds ACP `usage` to each `session/prompt` answer. |

All other messages go to dsh's ACP server unchanged. The `initialize`
answer is the same as without the bundle.

## Why

- dsh's agent loop can steer a running turn, but its ACP server has no
  method for it. Without the bundle, a message that you send during a turn
  waits for the next turn.
- dsh's ACP server sends prompt text to the model unchanged. Without the
  bundle, `/compact` becomes a paid model turn that does not compact.
- dsh's ACP server sends no per-turn token count.

dsh's ACP server keeps its JSON-RPC connection to itself, so a plugin next
to it cannot add a method. Its `apply` takes the message stream from its
config, so this bundle disables the base `acp` row and runs the same server
with a stream of its own. The bundle does not fork or patch dsh code.

## The protocol

### Run ids

When a `session/prompt` starts, the bundle sends this notification before
dsh sees the prompt:

```json
{"sessionUpdate": "session_info_update", "_meta": {"dsh": {"activeRunId": "<id>"}}}
```

When the prompt answer comes, the bundle first sends the same notification
with `"activeRunId": null`, then the answer. A Buzz steering hook reads it
the way the Goose hook reads `_meta.goose.activeRunId`:

```ts
runId: (update) => {
  if (update.sessionUpdate !== "session_info_update") return null;
  const dsh = (update._meta as { dsh?: { activeRunId?: unknown } })?.dsh;
  if (!dsh || !("activeRunId" in dsh)) return null;
  return typeof dsh.activeRunId === "string" ? dsh.activeRunId : undefined;
},
```

### Steering

Request `_dsh/session/steer` with
`{sessionId, prompt: [ContentBlock], expectedRunId}`. The answer is
`{outcome: "injected"}`. The steer is refused (deny by default) with
JSON-RPC error `-32602` and `error.data.reason` in these cases:

| `reason` | Cause |
| --- | --- |
| `invalid` | Bad params, a block that is not text, empty text, or too much text. |
| `unknown-session` | This connection did not open or resume the session. |
| `no-run` | No prompt is in flight for the session. |
| `run-mismatch` | `expectedRunId` is not the prompt in flight. |
| `cancelled` | The client cancelled the prompt in flight. |
| `not-running` | The agent is not running a turn (for example, still saving input). |

On an error the client sends the text as the next turn. The Buzz client
does this already. The steered text streams inside the answer of the prompt
in flight, because dsh ends that prompt only when the agent is idle.

### Compaction

A `session/prompt` whose whole text is exactly `/compact` does not go to
the model. The bundle calls dsh's `compaction.compactNow` and sends one
`agent_message_chunk`, then `{stopReason: "end_turn"}`:

| Result | Text |
| --- | --- |
| Compacted, or no history to compact | `Compaction complete` |
| No compaction engine in the profile | `Compaction is not available in this dsh profile.` |
| A turn is running | `Compaction is unavailable because the agent is not idle.` |
| dsh failed (summary, commit, save) | The reason, as dsh's own `/compact` says it. |
| The client cancelled | `Compaction cancelled.` and `stopReason: "cancelled"` |

A compaction has a time limit of 10 minutes. A prompt that comes during a
compaction gets the same error as a second prompt on a busy session.

### Usage

The bundle adds the counts of all model calls of a prompt to its answer as
ACP `usage`: `inputTokens`, `outputTokens`, `totalTokens`,
`cachedReadTokens`, `cachedWriteTokens` and `thoughtTokens`. The counts are
dsh's, and they do not overlap: `inputTokens` is input that was not cached.
`totalTokens` is input, output and both cache counts added. The bundle
counts only the session's own calls, not those of its subagents. An answer
without a model call has no `usage`.

## Add it to a dsh profile

`scripts/setup-buzz-profile` does these steps for the `buzz` profile. On another
profile, do them by hand. The bundle needs a profile with the
`@deepseek-ai/dsh-acp-app` bundle. It was verified with dsh 0.2.1-rc.2.

The bundle turns off three uploads in the profile: `session-log-deepseek`,
`plugin-package-inventory-deepseek` and `session-telemetry-otel`. Add the bundle
only to a profile where you want this. A profile's own patch can set these rows
again.

1. Link the folder into the profile. dsh adds the dependency and the
   bundle entry:

   ```sh
   dsh plugin --profile buzz add link:/path/to/buzz-plugin-dsh/dsh-acp-buzz
   ```

2. Check `$DSH_HOME/profiles/buzz/package.json` (default `DSH_HOME` is
   `~/.dsh`). It must hold this, with the bundle after
   `@deepseek-ai/dsh-acp-app`:

   ```json
   {
     "dependencies": {
       "@sagmans/dsh-acp-buzz": "link:/path/to/buzz-plugin-dsh/dsh-acp-buzz"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-acp-app",
           "@sagmans/dsh-acp-buzz"
         ]
       }
     }
   }
   ```

3. Check the result: `dsh --profile buzz --dump-config` shows the `acp` row
   with `disabled: true` and a new `acp-buzz` row.
4. Restart every running `dsh --profile buzz` process. A running process
   keeps the profile that it started with.

The `acp-buzz` row uses the default provider and model of
`@deepseek-ai/dsh-acp-app`. If you changed them on the `acp` row in the
profile's `cordis.patch.yml`, set them on `id: acp-buzz` instead. To remove
the bundle, run `dsh plugin --profile buzz remove @sagmans/dsh-acp-buzz`.

The package lists `@deepseek-ai/dsh-acp`, `@deepseek-ai/dsh-llm` and
`@agentclientprotocol/sdk` as peer dependencies and has no dependencies of
its own. dsh's loader then gives the bundle the same module copies that
dsh runs, so nothing is installed from a registry.

## Security

- The bundle adds no network access, no file access and no process. It
  runs in the dsh process and uses the stdio that dsh's ACP server used.
- A steer reaches only a session that this ACP connection opened or
  resumed, only while its prompt runs, and only for the run id that the
  client got. Each other case is refused.
- A steer takes text only, at most 64 blocks and 1,000,000 characters.
  Images must go through dsh's prompt admission, which a steer does not
  have.
- A steer has the same trust as a prompt: dsh runs tools with the user's
  access. The Buzz plugin sends a steer only for a message that it would
  also send as a prompt.
- Logs hold session ids, reasons and counts, never prompt text.

## Files

| File | Purpose |
| --- | --- |
| `package.json` | The bundle manifest (`dsh.bundle.patch`) and peer dependencies. |
| `cordis.patch.yml` | Disables the base `acp` row and inserts `acp-buzz`. |
| `index.js` | The plugin: runs dsh's ACP server on the bridge streams. |
| `lib/bridge.js` | The message router: run ids, steering, usage, `/compact`. |
| `lib/compact.js` | The `/compact` turn over dsh's compaction service. |
| `lib/usage.js` | The per-prompt usage sum. |
| `lib/wire.js` | The JSON-RPC and ACP message shapes. |
| `smoke.mjs` | Scenarios for the bridge with a fake dsh agent. |

Run the scenarios with `node dsh-acp-buzz/smoke.mjs`. `scripts/check` runs
them too. A live steer needs a model turn, so the checks do not run one.
