#!/usr/bin/env node
// Builds the installable plugin, dist/manifest.json and dist/plugin.js, from
// src/ and buzz-app modules in a clone at the pinned revision (BUZZ_APP_REV
// below). plugin.js is one ES module with no imports, as Buzz loads it.
//
// Why a pinned clone: the plugin runs buzz-app's shared ACP client and Goose
// runtime unchanged, so a dsh agent behaves as a Goose agent does. Their
// contract with the app is the app version the owner runs, so the pin is
// the revision of a released app (README, "Compatibility").
//
// Three modules are swapped while bundling (SWAPS): Goose's process adapter
// and sessions module for this plugin's, and the app's agent service for a
// shim that carries only what the runtime calls. The build then fails closed
// if the bundle holds a module that must stay the app's own (FORBIDDEN):
// a second React, Tauri bindings, the real agent service or app stores would
// run with their own state inside the plugin.
//
// The clone gives source only. The type check, the bundler and every package
// in the bundle come from this repository's lockfile, so its minimum release
// age and its dependency scan judge the whole build, and no package outside
// that lockfile runs or is read.
//
// Usage: node scripts/build-plugin.mjs [--out <dir>] [--check-only]
//   BUZZ_APP_DIR  must be the clone that the `buzz-app` link points to, when set
//   --out <dir>   write there instead of dist/
//   --check-only  type-check only, no bundle
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The buzz-app revision of Buzz Desktop 0.7.0-preview.243.1. */
export const BUZZ_APP_REV = "56729773f48d3f922a043ac83b7faa727bcfc9c2";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLONE_LINK = join(ROOT, "buzz-app");
const MANIFEST = join(ROOT, "plugin", "manifest.json");
const ENTRY = join(ROOT, "src", "index.ts");
const OUT_NAME = "plugin.js";
/** The CSS asset Vite makes from bundled CSS modules. It is never written:
 * Buzz loads no plugin CSS and already has these styles (FORBIDDEN). */
const DROPPED_CSS_NAME = "dropped-styles";
const EXPECTED_PACKAGE = "buzz-foundation";
const OWN_MODULES = join(ROOT, "node_modules");
/** This repository's own tools; any other copy is outside its lockfile. */
const TSC = join(OWN_MODULES, ".bin", "tsc");
const VITE = join(OWN_MODULES, "vite", "dist", "node", "index.js");
/** Imports that name a file, a builtin or a module Vite made up, not a package. */
const NOT_A_PACKAGE = /^(?:[./]|node:|\0|virtual:)/;
/** An import statement left in the emitted module (rolldown writes each at
 * the start of a line). */
const STATIC_IMPORT = /^import\s(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gm;
/** A web worker in the emitted code. Plugin API v1 has no worker asset. */
const WORKER = /\bnew Worker\(/;
/** Supplied by Buzz at run time: a copy in the bundle would be a Cordis the
 * app does not manage. React is not here: see REACT_HOST. */
const HOST_SUPPLIED = /^(?:@buzz\/author$|@deepseek-ai\/cordis(?:\/|$))/;
/** TypeScript sources a swapped module may resolve to. */
const SOURCE_SUFFIX = /\.tsx?$/;
const GIT_TIMEOUT_MS = 30_000;
const TSC_TIMEOUT_MS = 5 * 60_000;
const EXIT_USAGE = 64;
const EXIT_CONFIG = 78;

/** The markdown parser's dependency whose browser build calls `document` when
 * it loads. Its plain build decodes the same names from a table. The plugin
 * module must load without a DOM: the smoke run loads it in Node. */
const DOM_AT_LOAD = "decode-named-character-reference";
const DOM_BUILD = /index\.dom\.js$/;
const PLAIN_BUILD = "index.js";

/** buzz-app module (relative to its src/, no extension) to this repository's
 * module that replaces it. */
const SWAPS = {
  "bundled/goose/goose": "src/dsh.ts",
  "bundled/goose/sessions": "src/sessions.ts",
  "features/agents/service": "src/service-shim.ts",
  // Its web worker is a file beside the module, which Plugin API v1 cannot load.
  "features/messages/encode-webp": "src/encode-webp.ts",
};
/** Modules that must never be bundled (see the header). React itself is
 * bundled only behind src/react-host.ts (reactPlugin), and a React renderer
 * never is. CSS modules are bundled for their class names only: the bundle
 * drops their styles, which Buzz's own stylesheet of the same buzz-app
 * revision already has under the same content-hash names. */
const FORBIDDEN = [
  /node_modules\/react-dom\/(?:client|server|profiling|static)/,
  /node_modules\/react-dom\/cjs\/react-dom-(?:client|server|profiling|static)/,
  /node_modules\/@tauri-apps\//,
  /\/src\/features\/agents\/service\.ts$/,
  /\/src\/features\/agents\/store-native/,
  /\/src\/features\/identity\//,
];
/** Buzz's React, bound at `apply(ctx)`: every `react` import resolves to it,
 * so bundled buzz-app components render with the React that renders them. */
const REACT_HOST = join(ROOT, "src", "react-host.ts");
/** The one import of the bundled React package: src/react-host.ts only. */
const REACT_BUNDLED = "react-bundled";
/** Parts of React packages that are safe to bundle: the JSX runtime only
 * builds element objects, and `react-dom` (not its renderers) supplies
 * `createPortal` and `flushSync`. A renderer stays an import, and the
 * bundle check fails. */
const REACT_BUNDLE = /^(?:react\/jsx(?:-dev)?-runtime|react-dom)$/;
/** Any other part of the React packages, such as a renderer. */
const REACT_OTHER = /^react(?:-dom)?\//;

/** A build precondition or step that failed, with what to do about it. */
class BuildError extends Error {
  constructor(message, { exit = 1, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BuildError";
    this.exit = exit;
  }
}

function parseArgs(argv) {
  const options = { out: join(ROOT, "dist"), checkOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check-only") options.checkOnly = true;
    else if (arg === "--out") {
      if (!argv[i + 1])
        throw new BuildError("--out needs a directory", { exit: EXIT_USAGE });
      options.out = resolve(argv[i + 1]);
      i += 1;
    } else
      throw new BuildError(`unknown argument: ${arg}`, { exit: EXIT_USAGE });
  }
  return options;
}

/** Runs a tool with a bounded wait. */
function run(
  label,
  command,
  args,
  { cwd = ROOT, timeout, capture = false } = {},
) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    timeout,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  const elapsedMs = Date.now() - started;
  if (result.error)
    throw new BuildError(
      `${label} could not run (${command}, ${elapsedMs} ms)`,
      { cause: result.error },
    );
  if (result.signal)
    throw new BuildError(
      `${label} stopped by ${result.signal} after ${elapsedMs} ms (limit ${timeout} ms)`,
    );
  if (result.status !== 0)
    throw new BuildError(
      `${label} failed with exit ${result.status} after ${elapsedMs} ms${capture ? `: ${result.stderr.trim()}` : ""}`,
    );
  return capture ? result.stdout.trim() : "";
}

/** The clone, checked: buzz-app, at the pinned revision, no local edits to any
 * tracked file: its source is what the bundle copies, so an edit there changes the
 * plugin as much as one in src/. */
function clone() {
  if (!existsSync(CLONE_LINK))
    throw new BuildError(
      `no buzz-app link at ${CLONE_LINK}: run scripts/link-toolchain <clone> (README, "Build")`,
      { exit: EXIT_CONFIG },
    );
  const dir = realpathSync(CLONE_LINK);
  // The build reads the clone through the link, so another clone named here
  // would be checked but not built.
  const given = process.env.BUZZ_APP_DIR;
  if (given && realpathSync(given) !== dir)
    throw new BuildError(
      `BUZZ_APP_DIR is ${given}, the buzz-app link points to ${dir}: run scripts/link-toolchain ${given}`,
      { exit: EXIT_CONFIG },
    );
  const pkg = join(dir, "package.json");
  if (
    !existsSync(pkg) ||
    JSON.parse(readFileSync(pkg, "utf8")).name !== EXPECTED_PACKAGE
  )
    throw new BuildError(
      `no buzz-app clone at ${dir}: set BUZZ_APP_DIR or link it (README, "Build")`,
      { exit: EXIT_CONFIG },
    );
  const head = run("git rev-parse", "git", ["-C", dir, "rev-parse", "HEAD"], {
    timeout: GIT_TIMEOUT_MS,
    capture: true,
  });
  if (head !== BUZZ_APP_REV)
    throw new BuildError(
      `buzz-app clone is at ${head}, not ${BUZZ_APP_REV}: check out the pinned revision`,
      { exit: EXIT_CONFIG },
    );
  const dirty = run(
    "git status",
    "git",
    ["-C", dir, "status", "--porcelain", "--untracked-files=no"],
    { timeout: GIT_TIMEOUT_MS, capture: true },
  );
  if (dirty)
    throw new BuildError(`buzz-app clone has local edits:\n${dirty}`, {
      exit: EXIT_CONFIG,
    });
  return dir;
}

/** This repository's tools must be installed from its own lockfile. */
function checkInstall() {
  if (!existsSync(TSC) || !existsSync(VITE))
    throw new BuildError(
      "this repository's packages are not installed: run 'pnpm install --frozen-lockfile --ignore-scripts'",
      { exit: EXIT_CONFIG },
    );
}

/** True when `file` is inside `dir`. */
function inside(dir, file) {
  const path = relative(dir, file);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/** Resolves the swapped modules from any importer except the replacement itself
 * (src/sessions.ts imports the original), by the clone's link path and by its
 * real path: Vite names a module by the link (preserveSymlinks), but a package
 * can reach the clone by its real path. */
function swapPlugin(app) {
  const swaps = new Map(
    Object.entries(SWAPS).flatMap(([from, to]) =>
      [CLONE_LINK, app].map((base) => [
        join(base, "src", from),
        join(ROOT, to),
      ]),
    ),
  );
  return {
    name: "dsh-swaps",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (!resolved || resolved.external) return null;
      const bare = resolved.id.split("?")[0]?.replace(SOURCE_SUFFIX, "") ?? "";
      const target = swaps.get(bare);
      if (!target || importer === target) return null;
      return target;
    },
  };
}

/** A buzz-app module's package imports resolve from this repository, never
 * from the clone, so this lockfile and its minimum age decide what the bundle
 * holds. A package this repository does not declare is left out as an import:
 * buzz-app modules import many packages for app code this plugin never runs,
 * which tree-shaking drops. One that the plugin does run stays an import, and
 * the bundle check stops the build (fail closed), so a new dependency is added
 * to package.json on purpose, never pulled in unseen. */
function ownDependencies(app) {
  return {
    name: "dsh-own-dependencies",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (HOST_SUPPLIED.test(source)) return { id: source, external: true };
      if (!importer || NOT_A_PACKAGE.test(source) || isAbsolute(source))
        return null;
      const from = importer.split("?")[0] ?? importer;
      if (!inside(CLONE_LINK, from) && !inside(app, from)) return null;
      const found = await this.resolve(source, ENTRY, {
        ...options,
        skipSelf: true,
      });
      return found ?? { id: source, external: true };
    },
  };
}

/** Resolves DOM_AT_LOAD to its plain build. */
function plainBuildAtLoad() {
  return {
    name: "plain-build-at-load",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (source !== DOM_AT_LOAD) return null;
      const found = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      return (
        found && { ...found, id: found.id.replace(DOM_BUILD, PLAIN_BUILD) }
      );
    },
  };
}

/** Resolves the React packages before the swaps see them: `react` to Buzz's
 * React (REACT_HOST), the safe parts into the bundle from this repository's
 * packages, any other part left as an import, which the bundle check then
 * rejects. */
function reactPlugin() {
  return {
    name: "dsh-react-from-host",
    enforce: "pre",
    resolveId(source, importer, options) {
      if (source === "react") return REACT_HOST;
      if (source === REACT_BUNDLED) {
        if (importer !== REACT_HOST)
          this.error(`${REACT_BUNDLED} is for src/react-host.ts only`);
        return this.resolve("react", ENTRY, { ...options, skipSelf: true });
      }
      if (REACT_BUNDLE.test(source))
        return this.resolve(source, ENTRY, { ...options, skipSelf: true });
      if (REACT_OTHER.test(source)) return { id: source, external: true };
      return null;
    },
  };
}

async function bundle(app, out) {
  const { build } = await import(pathToFileURL(VITE).href);
  const result = await build({
    configFile: false,
    root: ROOT,
    logLevel: "warn",
    // Symlinks kept: buzz-app modules keep their buzz-app/... ids, so the bundle
    // names them relative to the repository and holds no local path.
    resolve: {
      alias: { "@app": join(CLONE_LINK, "src") },
      preserveSymlinks: true,
    },
    plugins: [
      plainBuildAtLoad(),
      reactPlugin(),
      swapPlugin(app),
      ownDependencies(app),
    ],
    // buzz-app modules read Vite build inputs; an installed plugin has none.
    // React's packages pick their production build by NODE_ENV.
    define: {
      "import.meta.env.VITE_BUZZ_DATABRICKS_HOST": "undefined",
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: {
      write: false,
      target: "es2022",
      minify: false,
      lib: {
        entry: ENTRY,
        formats: ["es"],
        fileName: () => OUT_NAME,
        cssFileName: DROPPED_CSS_NAME,
      },
      rolldownOptions: {
        output: { codeSplitting: false },
        // A left-out package is never loaded for its side effects alone: only
        // one whose exports the plugin uses stays an import (see above).
        treeshake: { moduleSideEffects: (_id, external) => !external },
      },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const chunk = output.find((item) => item.type === "chunk" && item.isEntry);
  if (!chunk || output.some((item) => item.type === "chunk" && item !== chunk))
    throw new BuildError("the bundle is not one module");
  const bad = Object.keys(chunk.modules).filter((id) =>
    FORBIDDEN.some((re) => re.test(id)),
  );
  if (bad.length)
    throw new BuildError(
      `the bundle holds app modules it must not copy:\n${bad.join("\n")}`,
    );
  // The emitted code, not `chunk.imports`: that lists every left-out package a
  // bundled module named, also those tree-shaking then dropped.
  const left = [...chunk.code.matchAll(STATIC_IMPORT)]
    .map((match) => match[1])
    .concat(chunk.dynamicImports);
  if (left.length)
    throw new BuildError(
      `the bundle imports other modules: ${left.join(", ")}: add each to package.json with a pinned version, or stop using it`,
    );
  if (WORKER.test(chunk.code))
    throw new BuildError(
      "the bundle holds a web worker, which Plugin API v1 cannot load",
    );
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, OUT_NAME), chunk.code);
  copyFileSync(MANIFEST, join(out, "manifest.json"));
  console.log(
    `built ${join(out, OUT_NAME)} (${Math.round(chunk.code.length / 1024)} KiB, buzz-app ${BUZZ_APP_REV})`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const app = clone();
  checkInstall();
  run("type check", TSC, ["--noEmit", "-p", join(ROOT, "tsconfig.json")], {
    timeout: TSC_TIMEOUT_MS,
  });
  if (!options.checkOnly) await bundle(app, options.out);
}

main().catch((error) => {
  console.error(`build-plugin: ${error.message}`);
  if (error.cause) console.error(error.cause);
  process.exit(error.exit ?? 1);
});
