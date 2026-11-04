# AGENTS.md

Guidance for coding agents that work in this repository.

## Project

A Buzz desktop plugin (plugin API version 1). It adds the "DSH" agent type:
Buzz agents that run DeepSeek Harness (`dsh --profile acp`) over the Agent
Client Protocol, with a small set of Buzz tools served over loopback MCP.
The README describes the behavior, the settings and the security model.
Keep the README true when you change behavior.

| Path | Purpose |
| --- | --- |
| `plugin/manifest.json` | Plugin manifest. Buzz installs the `plugin/` folder. |
| `src/plugin.js` | The plugin source: runtime, tools and type wiring. Edit `src/`, not the build. |
| `src/config.js` | The config fields, defaults and valid values, for the runtime and the views. |
| `src/views.js` | The New agent and Settings views, from bundled buzz-app components. |
| `src/react-host.js` | Every `react` import resolves here: the app's React. |
| `src/save-footer.js` | Puts Save in the agent panel's sticky footer. |
| `src/owner.js` | Who may start a turn: a copy of Buzz's mention rule. |
| `plugin/plugin.js` | The build of `src/`: one self-contained ES module. Not in Git. |
| `scripts/build-plugin.mjs` | Builds `plugin/plugin.js`, or another folder with `--out`. Holds `BUZZ_APP_REV`. |
| `scripts/link-toolchain` | Links the buzz-app clone (`buzz-app`, not in Git) that the views bundle. |
| `vite.config.js` | The bundle settings and the one-file contract check. |
| `package.json`, `pnpm-lock.yaml` | The pinned build tool and libraries. |
| `scripts/smoke.mjs` | Smoke scenarios: the plugin with a fake host and a fake dsh. |
| `scripts/fake-acp.mjs` | The fake dsh ACP server that the smoke scenarios start. |
| `scripts/check` | All repository checks. The Git hooks call it. |
| `scripts/setup-hooks` | Turns on the Git hooks for a clone. Copied from a template. |
| `.githooks/` | Generic hooks and helpers, copied from a template. |
| `.githooks/<hook>.d/` | This repository's own hook checks. |

## Setup and checks

1. Run `scripts/setup-hooks` once after you clone, and
   `mise exec -- pnpm install --frozen-lockfile`. Link a buzz-app clone at
   `BUZZ_APP_REV` with `scripts/link-toolchain` (README.md, Install).
2. Run `scripts/check --quick` while you work, and `scripts/check` before
   you push.
3. Build with `node scripts/build-plugin.mjs`. Never commit
   `plugin/plugin.js`: it bundles libraries that the checks do not judge,
   and `scripts/check` fails when it is tracked.
4. Run the scenarios with `node scripts/smoke.mjs [path/to/plugin.js]`.

Never use `--no-verify`, and never change `core.hooksPath` or other Git
settings. Do not edit the files that come from the hook template:
`.githooks/*` (outside the `*.d/` folders), `.githooks/lib/` and
`scripts/setup-hooks`.

## Plugin rules

- `plugin/plugin.js` must stay one file with no runtime imports. Buzz loads
  it as is. The build bundles the libraries in, and `vite.config.js` fails
  the build when an import stays.
- Every `react` import resolves to `src/react-host.js`. It forwards to the
  app's React after `bindReact(ctx.react)`, so the bundled buzz-app
  components share the app's hooks. The pinned `react` package must have
  the same version as the app's React; `bindReact` stops on a mismatch.
- The views bundle buzz-app components, not copies, so they look as the
  app's own agents do. The build drops their CSS: the class names are
  content hashes that the app's stylesheet of the same revision already
  has. On each new `BUZZ_APP_REV`, check the New agent dialog and the
  agent's tabs live in that app version.
- Import buzz-app modules unchanged. Never edit the buzz-app clone. A
  package that a buzz-app module needs goes into `package.json` with an
  exact version.
- Write views with `createElement`, not JSX, so the checks (node --check,
  lizard, semgrep) read them.
- A new library is a new dependency: pin the exact version in
  `package.json`. `pnpm-workspace.yaml` holds the minimum release age.
- Keep the module top level pure. Do all work in `apply(ctx)`, and give each
  long-lived resource a cleanup through `ctx.effect`.
- The `host` grants in the manifest are the plugin's whole native access.
  `scripts/check` pins them; a grant change is security-relevant.
- A mention starts a turn only with the owner's authority, by the rule of
  Buzz's own agents (`fromOwner` in `src/owner.js`): dsh runs commands with
  the user's access. Do not widen `admitted` or `src/owner.js` without a
  security review.
- Validate every tool argument at the boundary, and never let a setting
  become a process flag (see `PROFILE_RE`).
- Do not change the manifest `id` (`sagmans.dsh`), the type id (`dsh`) or the
  storage prefix. Installs, agents and saved sessions match on them.
- Put each fixed value in a named constant at the top of the file.
- Comments explain why the code exists, not what it does.
- Each failure is visible: log it with its context, and fail the turn with
  its error. Do not drop errors.
- Each control request to dsh has a timeout (`REQUEST_TIMEOUT_MS`).

## Tests

Do not add a unit test framework. Add or update a scenario in
`scripts/smoke.mjs` for each behavior change, and make sure that the
scenario fails without the change. A real dsh prompt costs money: never run
one from the checks.

## Private data

This repository is public. Never commit names of people, private host or
network names, real public keys, local home paths, issue tracker links or
secrets. Use neutral words, such as "the user" or `example.com`.
`scripts/check` blocks the common shapes of such data.

## Commits

- Follow `.githooks/GIT_CONVENTION.md` (Conventional Commits with a body).
- Sign and sign off each commit: `git commit -s -S`.
- Make each commit one logical change, and make sure that `scripts/check`
  passes on it.
