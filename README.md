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
bundles pinned libraries, so it is not in Git. It needs Node.js 24 and pnpm;
[mise](https://mise.jdx.dev) installs the versions in `mise.toml`.

1. Clone the repository and go into it:
   `git clone https://github.com/sagmans/buzz-plugin-dsh && cd buzz-plugin-dsh`
2. Install the pinned tools: `mise exec -- pnpm install --frozen-lockfile`.
3. Build: `mise exec -- node scripts/build-plugin.mjs`. This writes
   `plugin/plugin.js` next to `plugin/manifest.json`.
4. In the Buzz desktop app, open **Settings > Plugins**, select **Install
   from folder** and choose the `plugin` folder.
5. Read the grants and accept them (see "Security").
6. Turn on the plugin. Then choose **New agent** and pick **DSH** as the type.

The install preview shows that the plugin starts a program (`dsh`), serves
MCP and reads files with your access. That is the whole native access of
the plugin. To update, pull, build again and install the `plugin` folder
again.

## Settings

Each DSH agent has these settings (New agent dialog and the agent's
**Settings** tab):

| Setting | Default | Effect |
| --- | --- | --- |
| Model | Default of the dsh profile | A model that dsh offers. The list fills after the first session. |
| Reasoning effort | Default | `off`, `low`, `high` or `max`, when the model has levels. |
| Workspace | `~/dsh-agents` | The folder dsh works in. Absolute, or starts with `~/`. |
| dsh profile | `acp` | The dsh profile to start. Lowercase letters, digits, `-` and `_`. |
| Instructions | Empty | Text that each new session gets first. |

A model or effort change applies at the next turn. A workspace or profile
change applies to new sessions; use **New session** for a thread to use it
there.

## Security

- dsh runs its tools (shell, file edits) with your own access, with no
  sandbox. The plugin answers each dsh permission request with "allow once"
  and never with a lasting grant.
- Only your own signed mentions start a turn. Mentions from other people or
  agents are ignored. Plugin and Attention wakes from this app also start a
  turn, framed as data.
- The plugin passes no secret to dsh. dsh reads its own provider keys.

## Limitations

- Watches and timers do not run DSH agents in this version.
- The tool set is small: `send`, `read` and `react`. There are no file
  uploads, edits, canvas or memory tools.
- `read` shows pubkeys, not display names.
- Compact is not supported. **New session** starts the thread over.
- Session history is not shown in the app. dsh keeps it in its own storage.

## Development

See [AGENTS.md](AGENTS.md). The source is in `src/`; build it as in
"Install". Run `scripts/setup-hooks` once, then `scripts/check`. The check
builds into a temporary folder, so it never changes `plugin/`.
`scripts/smoke.mjs` runs the plugin against a fake host and a fake dsh ACP
server (`scripts/fake-acp.mjs`), so it needs no dsh install and no model.

## License

Apache-2.0. See [LICENSE](LICENSE).
