# AGENTS.md

Guidance for coding agents that work in this repository.

## Project

A Buzz desktop plugin (plugin API version 1) that adds the agent type "DSH".
It bundles the Buzz app's Goose runtime and shared ACP client unchanged, and
swaps in this repository's dsh process adapter. The README describes the
behavior, the install and the limits. Keep the README true when you change
behavior.

| Path | Purpose |
| --- | --- |
| `plugin/manifest.json` | Plugin manifest and its host grant. |
| `src/index.ts` | The agent type: registration, sessions list, tabs, provider, usage. |
| `src/dsh.ts` | Replaces buzz-app `bundled/goose/goose.ts`: model and effort selection, resume, permission choices, the bundle probe, steering (`DshWire`, `DSH`). |
| `src/sessions.ts` | Replaces buzz-app `bundled/goose/sessions.ts`: the plugin's own storage key, and saved sessions to resume. |
| `src/service-shim.ts` | Replaces buzz-app `features/agents/service.ts` in the bundle: only `fromOwner`. |
| `src/profiles.ts` | Saved config parsing and one Goose runtime per dsh profile. |
| `src/setup.ts` | Model, effort and bundle discovery through a throwaway dsh session. |
| `src/provider.tsx` | The read-only provider row and dialog, with the bundle state. |
| `src/views.tsx` | Create and Settings views, from buzz-app's own components. |
| `src/activity.tsx` | The Activity tab, from buzz-app's own components. |
| `src/session-files.ts`, `src/session-transcript.ts` | dsh's session store, read for Activity: its `session/list` and files. Reads only. |
| `src/recorder.ts`, `src/history.ts` | Local records of the wire for Activity and usage. The code stays the same as the other ACP harness plugins' copies, import paths aside, so a fix ports by copying. |
| `src/react-host.ts` | Every `react` import in the bundle: forwards to the app's React. |
| `src/save-footer.tsx` | Puts the Settings Save action in the panel's sticky footer. |
| `scripts/build-plugin.mjs` | Type check and bundle: source from the pinned buzz-app clone (`BUZZ_APP_REV`), every package from this repository's lockfile. |
| `scripts/link-toolchain` | Makes the gitignored `buzz-app` link to the clone. |
| `package.json`, `pnpm-lock.yaml` | Every package the build and the bundle use. |
| `pnpm-workspace.yaml` | The minimum release age for those packages. |
| `smoke/run.mjs` | End-to-end smoke run: the built plugin against the stand-in, or a real dsh. |
| `scripts/fake-acp.mjs` | The stand-in dsh ACP server, with and without the bundle. |
| `dsh-acp-buzz/` | dsh profile bundle: steering, run ids, compaction, usage. It runs inside dsh and keeps that project's style. It has its own `smoke.mjs`. |
| `scripts/setup-buzz-profile`, `scripts/buzz-profile.patch.yml` | Makes the `buzz` dsh profile that agents run on. |
| `scripts/check` | All repository checks. The Git hooks call it. |
| `scripts/setup-hooks`, `.githooks/` | Generic hooks and helpers, copied from a template. |
| `.githooks/<hook>.d/` | This repository's own hook checks. |

## Setup and checks

1. Run `scripts/setup-hooks` once after you clone.
2. Set up the buzz-app clone once: README, section "Build".
3. Run tools through mise (`mise exec -- …`, see `mise.toml`).
4. Run `scripts/check --quick` while you work, and `scripts/check` before you
   push. The full check builds the plugin and runs both smoke runs. It needs
   no dsh and makes no model call.

Never use `--no-verify`, and never change `core.hooksPath` or other Git
settings. Do not edit the files that come from the hook template:
`.githooks/*` (outside the `*.d/` folders), `.githooks/lib/` and
`scripts/setup-hooks`.

## Plugin rules

- `dist/plugin.js` must stay one ES module with no imports. The build's
  FORBIDDEN list and its import check enforce this; never shorten them.
- Every `react` import resolves to `src/react-host.ts`. It forwards to the
  app's React after `bindReact(ctx.react)`, so the bundled buzz-app components
  share the app's hooks. This repository's `react` package must have the same
  version as the app's React; `bindReact` stops on a mismatch.
- The views bundle buzz-app components, not copies, so they look as the app's
  own agents do. The build drops their CSS: the class names are content hashes
  that the app's stylesheet of the same revision already has. On each new
  `BUZZ_APP_REV`, check the New agent dialog and the agent's Settings and
  Activity tabs live in that app version.
- Do not edit the buzz-app clone, and do not install packages in it. A revision
  change goes through `BUZZ_APP_REV`, the README "Compatibility" section and the
  smoke run.
- The manifest host grant is security-relevant. `scripts/check` requires
  exactly `dsh --profile`, `mcp` and `files`. A change to the grant, to the
  environment in `DSH`, or to the permission behavior needs a reason in the
  commit body.
- A mention starts a turn only with the owner's authority. That rule is
  buzz-app's `fromOwner`: dsh runs commands with the user's access. Never add
  a way around it.
- Never let a setting become a process flag (see `PROFILE_RE`).
- `/compact` must never reach a dsh with no bundle: it would be a paid model
  turn. Without a clear `-32602` from the bundle probe, treat the bundle as
  absent.
- Do not change the manifest `id` (`sagmans.dsh`), the type id (`dsh`), the
  process id (`dsh-acp`) or the storage keys (`SESSIONS_PREFIX`,
  `ACTIVITY_PREFIX`). Saved agents and sessions match on them.
- Each package has an exact version, and `pnpm-workspace.yaml` holds its minimum
  release age: keep those settings. A package with a reported security issue is
  never used. A patch for it has priority over the minimum release age.

## Code rules

- Put each fixed value in a named constant at the top of the file.
- Comments explain why the code exists, not what it does. Keep each mark of
  code from buzz-app, and keep `NOTICE` true.
- Each failure is visible: throw `DshError` with its operation and context, or
  log it with them. Do not drop errors.
- Each control request to dsh has a timeout (`REQUEST_TIMEOUT_MS`).
- Format every source file with the repository's own tools. No file gets a
  format or lint exception, copies included.

## Tests

Do not add a unit test framework. Add or update a scenario in `smoke/run.mjs`
for each behavior change, and make sure that the scenario fails without the
change. When dsh's own wire behavior changes, change `scripts/fake-acp.mjs` to
match it, and prove it with `--real-dsh`. A real dsh prompt costs money: never
run one from the checks, and use `--live-turn` only when a person asks for it.

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
