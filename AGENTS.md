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
| `plugin/plugin.js` | The plugin: one self-contained ES module, no build step. |
| `scripts/smoke.mjs` | Smoke scenarios: the plugin with a fake host and a fake dsh. |
| `scripts/fake-acp.mjs` | The fake dsh ACP server that the smoke scenarios start. |
| `scripts/check` | All repository checks. The Git hooks call it. |
| `scripts/setup-hooks` | Turns on the Git hooks for a clone. Copied from a template. |
| `.githooks/` | Generic hooks and helpers, copied from a template. |
| `.githooks/<hook>.d/` | This repository's own hook checks. |

## Setup and checks

1. Run `scripts/setup-hooks` once after you clone.
2. Run `scripts/check --quick` while you work, and `scripts/check` before
   you push.
3. Run the scenarios with `node scripts/smoke.mjs [path/to/plugin.js]`.

Never use `--no-verify`, and never change `core.hooksPath` or other Git
settings. Do not edit the files that come from the hook template:
`.githooks/*` (outside the `*.d/` folders), `.githooks/lib/` and
`scripts/setup-hooks`.

## Plugin rules

- `plugin/plugin.js` must stay one file with no runtime imports. Buzz loads
  it as is. Use `ctx.react` for React. Internal Buzz modules are not
  available to an installed plugin.
- Keep the module top level pure. Do all work in `apply(ctx)`, and give each
  long-lived resource a cleanup through `ctx.effect`.
- The `host` grants in the manifest are the plugin's whole native access.
  `scripts/check` pins them; a grant change is security-relevant.
- Only the owner's own mentions may start a turn: dsh runs commands with
  the user's access. Do not widen `admitted` without a security review.
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
