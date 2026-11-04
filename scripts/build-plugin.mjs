#!/usr/bin/env node
// Builds plugin/plugin.js from src/ with this repository's own pinned build
// tool (vite in node_modules, from pnpm-lock.yaml).
//
// Why a local build: the plugin bundles pinned libraries, and the bundle is
// not committed (the repository checks judge only the hand-written source).
// Users build once, then install the plugin/ folder with "Install from
// folder". `--out` writes the bundle to another folder, so scripts/check can
// build and test it without rewriting the plugin/ folder that a running
// Buzz app may have installed.
//
// Usage: node scripts/build-plugin.mjs [--out <dir>]
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = join(ROOT, "plugin");
const VITE = join(ROOT, "node_modules", ".bin", "vite");
const OUT_DIR_ENV = "DSH_PLUGIN_OUT_DIR";
const OUT_FLAG = "--out";
const USAGE = "usage: node scripts/build-plugin.mjs [--out <dir>]";
// A local bundle of a few files; a hung tool must still end the build.
const VITE_TIMEOUT_MS = 5 * 60_000;
const EXIT_USAGE = 64;
const EXIT_CONFIG = 78;

/** A build precondition or step that failed, with what to do about it. */
class BuildError extends Error {
  constructor(message, exit = 1) {
    super(message);
    this.name = "BuildError";
    this.exit = exit;
  }
}

function build(outDir) {
  if (!existsSync(VITE)) throw new BuildError("vite is not installed: run `mise exec -- pnpm install --frozen-lockfile`", EXIT_CONFIG);
  const result = spawnSync(VITE, ["build", "--config", join(ROOT, "vite.config.js")], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: VITE_TIMEOUT_MS,
    env: { ...process.env, [OUT_DIR_ENV]: outDir },
  });
  if (result.error) throw new BuildError(`vite did not run: ${result.error.message}`);
  if (result.status !== 0) throw new BuildError(`vite build failed with status ${result.status}`);
}

/** The output folder: plugin/ by default, or an existing folder after --out. */
function outDirOf(args) {
  if (args.length === 0) return PLUGIN_DIR;
  if (args.length !== 2 || args[0] !== OUT_FLAG || !args[1]) throw new BuildError(USAGE, EXIT_USAGE);
  const dir = resolve(args[1]);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new BuildError(`${OUT_FLAG} ${dir} is not a folder`, EXIT_USAGE);
  return dir;
}

try {
  const outDir = outDirOf(process.argv.slice(2));
  build(outDir);
  console.log(`build-plugin: wrote ${join(outDir, "plugin.js")}`);
} catch (error) {
  if (!(error instanceof BuildError)) throw error;
  console.error(`build-plugin: ${error.message}`);
  process.exit(error.exit);
}
