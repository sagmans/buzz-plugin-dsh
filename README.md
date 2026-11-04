# buzz-plugin-dsh

A Buzz desktop plugin. It adds a **DSH** agent type: agents that run
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
on this computer and answer you in Buzz.

## What it does

Each DSH agent runs in the `dsh` ACP server, `dsh --profile acp`. One `dsh`
process serves all DSH agents of the app. Each thread that you mention an
agent in is one continuing dsh session.

| Step | Result |
| --- | --- |
| You mention the agent in a thread | The plugin opens the thread's dsh session, or resumes it after a restart. |
| The session starts | dsh gets the Buzz tools of this plugin: `send`, `read` and `react`. |
| The first turn of a session | dsh gets a short Buzz preamble, the agent instructions, its team and its `core` memory. |
| Each turn | dsh gets the message and its place (channel, thread root). The agent answers with `send`. |
| The turn ends | Buzz shows the agent as idle again. **Stop** cancels a running turn. |

The Buzz tools act as the agent. The agent key stays in Buzz: the tools
reach dsh through a loopback MCP server that Buzz serves for the plugin.

## Requirements

- The Buzz desktop app (plugin API version 1).
- `dsh` with its shipped `acp` profile (verified with 0.2.1-rc.2), and a
  provider set up in that profile. Check it in a terminal: `dsh --profile acp --help`.
- `dsh` and `node` on the app's search path. A macOS app does not read your
  shell profile. Buzz searches the Homebrew folders and `~/.local/bin`. If
  `dsh` comes from a version manager, link it, for example:
  `ln -s "$(command -v dsh)" ~/.local/bin/dsh` (and the same for `node`).

## Install

You build the plugin on your computer, then install the folder. The build
bundles pinned libraries and buzz-app UI modules, so it is not in Git. It
needs Node.js 24, pnpm and a buzz-app clone at the revision in
`scripts/build-plugin.mjs` (`BUZZ_APP_REV`, the revision of Buzz Desktop
`v0.7.0-preview.240.1`). [mise](https://mise.jdx.dev) installs the versions
in `mise.toml`.

1. Clone the repository and go into it:
   `git clone https://github.com/sagmans/buzz-plugin-dsh && cd buzz-plugin-dsh`
2. Install the pinned tools: `mise exec -- pnpm install --frozen-lockfile`.
3. Prepare the buzz-app clone and link it:

   ```sh
   git clone https://github.com/block/buzz-app.git ../buzz-app
   git -C ../buzz-app checkout <BUZZ_APP_REV>
   (cd ../buzz-app && pnpm install --frozen-lockfile --ignore-scripts)
   scripts/link-toolchain ../buzz-app
   ```

4. Build: `mise exec -- node scripts/build-plugin.mjs`. This writes
   `plugin/plugin.js` next to `plugin/manifest.json`. The build stops when
   the clone is at another revision or has local edits.
5. In the Buzz desktop app, open **Settings > Plugins**, select **Install
   from folder** and choose the `plugin` folder.
6. Read the grants and accept them (see "Security").
7. Turn on the plugin. Then choose **New agent** and pick **DSH** as the type.

The install preview shows that the plugin starts a program (`dsh`), serves
MCP and reads files with your access. That is the whole native access of
the plugin. To update, pull, build again and install the `plugin` folder
again.

## Settings

The New agent dialog and the agent's tabs use the app's own model picker,
instructions field and settings rows, so a DSH agent looks as the app's own
agents do. Each DSH agent has these settings:

| Setting | Tab | Default | Effect |
| --- | --- | --- | --- |
| Model | Identity | DSH default (the dsh profile's model) | A model that dsh offers. The list fills after the first session; you can also type a model. |
| Thinking | Identity | Automatic (the dsh profile's level) | `Off`, `Low`, `High` or `Max`, when the model has levels. |
| Instructions | Identity | Empty | Text that each new session gets first. |
| Workspace | Settings | `~/dsh-agents` | The folder dsh works in. Absolute, or starts with `~/`. |
| Profile | Settings | `acp` | The dsh profile to start. Lowercase letters, digits, `-` and `_`. |

A model or effort change applies at the next turn. A workspace or profile
change applies to new sessions; use **New session** for a thread to use it
there.

## Security

- dsh runs its tools (shell, file edits) with your own access, with no
  sandbox. The plugin answers each dsh permission request with "allow once"
  and never with a lasting grant.
- A mention starts a turn only with your authority, by the same rule as the
  agents that come with Buzz: your own signed mention, or a mention from
  one of your agents whose `auth` tag (NIP-OA) you signed. Mentions from
  other people, and from agents without a valid `auth` tag, are ignored.
  Plugin and Attention wakes from this app also start a turn, framed as
  data.
- Relay workflow mentions do not start a turn. Buzz admits them with a
  proof that an installed plugin cannot read.
- The plugin passes no secret to dsh. dsh reads its own provider keys.

## Limitations

- Watches and timers do not run DSH agents in this version.
- The tool set is small: `send`, `read` and `react`. There are no file
  uploads, edits, canvas or memory tools.
- `read` shows pubkeys, not display names.
- Compact is not supported. **New session** starts the thread over.
- Session history is not shown in the app. dsh keeps it in its own storage.
- The Settings tab does not warn about unsaved changes when you leave it.
  The plugin API does not give that part of the app to plugins.

## Development

See [AGENTS.md](AGENTS.md). The source is in `src/`; build it as in
"Install". Run `scripts/setup-hooks` once, then `scripts/check`. The check
builds into a temporary folder, so it never changes `plugin/`.
`scripts/smoke.mjs` runs the plugin against a fake host and a fake dsh ACP
server (`scripts/fake-acp.mjs`), so it needs no dsh install and no model.

## License

Apache-2.0. See [LICENSE](LICENSE).
