// Bundles src/ into the one self-contained `plugin.js` that Buzz loads: one
// ES module with no imports and no assets, as the plugin API v1 needs. React
// and the host services come from the Cordis context at run time, so the
// bundle holds only this repository's code, its pinned libraries
// (package.json, pnpm-lock.yaml) and buzz-app UI modules, unchanged, from
// the linked clone (`buzz-app`, scripts/link-toolchain).
// (The React and dependency handling follows buzz-plugin-opencode's build.)
// Build with scripts/build-plugin.mjs: it writes plugin/plugin.js, or the
// folder after --out (scripts/check builds into a temporary folder).
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const ENTRY = resolve(here, "src/plugin.js");
const BUNDLE_NAME = "plugin.js";
// An import statement left in the emitted module (rolldown writes each at
// the start of a line).
const STATIC_IMPORT = /^import\s(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gm;
/** The buzz-app clone link that scripts/link-toolchain makes. */
const BUZZ_APP_LINK = "buzz-app";
const CSS_SUFFIX = ".css";
/** Imports that name a file, a builtin or a module Vite made up, not a package. */
const NOT_A_PACKAGE = /^(?:[./]|node:|\0|virtual:)/;
/** Supplied by Buzz at run time: a copy in the bundle would be a Cordis the
 * app does not manage. React is not here: see REACT_HOST. */
const HOST_SUPPLIED = /^(?:@buzz\/author$|@deepseek-ai\/cordis(?:\/|$))/;
/** Buzz's React, bound at `apply(ctx)`: every `react` import resolves to it,
 * so bundled buzz-app components render with the React that renders them. */
const REACT_HOST = resolve(here, "src/react-host.js");
/** The one import of the bundled React package: `src/react-host.js` only. */
const REACT_BUNDLED = "react-bundled";
/** Parts of React packages that are safe to bundle: the JSX runtime only
 * builds element objects, and `react-dom` (not its renderers) supplies
 * `createPortal` and `flushSync`. A renderer stays an import, and
 * pluginContract fails the build. */
const REACT_BUNDLE = /^(?:react\/jsx(?:-dev)?-runtime|react-dom)$/;
/** Any other part of the React packages, such as a renderer. */
const REACT_OTHER = /^react(?:-dom)?\//;
const buzzLink = resolve(here, BUZZ_APP_LINK);
// The build script sets the output folder: plugin/ to write, a temporary
// folder to compare.
const OUT_DIR_ENV = "DSH_PLUGIN_OUT_DIR";

/** True when `file` is inside `dir`. */
function inside(dir, file) {
  const path = relative(dir, file);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/** Resolves the React packages before ownDependencies sees them: `react`
 * to Buzz's React (REACT_HOST), the safe parts into the bundle, any other
 * part left as an import, which pluginContract then rejects. */
function reactFromHost() {
  return {
    name: "dsh-react-from-host",
    enforce: "pre",
    resolveId(source, importer, options) {
      if (source === "react") return REACT_HOST;
      if (source === REACT_BUNDLED) {
        if (importer !== REACT_HOST) this.error(`${REACT_BUNDLED} is for src/react-host.js only`);
        return this.resolve("react", ENTRY, { ...options, skipSelf: true });
      }
      if (REACT_BUNDLE.test(source)) return this.resolve(source, ENTRY, { ...options, skipSelf: true });
      if (REACT_OTHER.test(source)) return { id: source, external: true };
      return null;
    },
  };
}

/**
 * A buzz-app module's package imports resolve here, not in the clone, so
 * they come from this lockfile and its 14-day release age, never from the
 * clone's own node_modules. A package this repository does not declare is
 * left out as an import: buzz-app modules import packages for app code this
 * plugin never runs, which tree-shaking drops. One that the plugin does run
 * stays an import, and pluginContract stops the build (fail closed), so a
 * new dependency is added to package.json on purpose, never pulled in unseen.
 */
function ownDependencies() {
  let clone = "";
  return {
    name: "dsh-own-dependencies",
    enforce: "pre",
    buildStart() {
      clone = realpathSync(buzzLink);
    },
    async resolveId(source, importer, options) {
      if (HOST_SUPPLIED.test(source)) return { id: source, external: true };
      if (!importer || NOT_A_PACKAGE.test(source) || isAbsolute(source)) return null;
      const from = importer.split("?")[0] ?? importer;
      if (!inside(buzzLink, from) && !inside(clone, from)) return null;
      const found = await this.resolve(source, ENTRY, { ...options, skipSelf: true });
      return found ?? { id: source, external: true };
    },
  };
}

/** Fails the build unless it is the installed form Buzz reads: one chunk,
 * no imports, exporting `apply`. */
function pluginContract() {
  return {
    name: "dsh-plugin-contract",
    // After Vite's CSS plugin, which adds the CSS modules of bundled buzz-app
    // components as an asset.
    generateBundle: { order: "post", handler(_options, bundle) {
      // Buzz loads no plugin CSS. Those class names are content hashes, the
      // same in Buzz's own build of the same buzz-app revision, so Buzz's
      // stylesheet already styles them. AGENTS.md says to check this live
      // on each new BUZZ_APP_REV.
      for (const [name, output] of Object.entries(bundle))
        if (output.type === "asset" && name.endsWith(CSS_SUFFIX)) delete bundle[name];
      const outputs = Object.values(bundle);
      const chunk = outputs[0];
      if (outputs.length !== 1 || chunk?.type !== "chunk") this.error("Plugin API v1 needs one self-contained JS module, without assets");
      const left = [...chunk.code.matchAll(STATIC_IMPORT)].map((match) => match[1]).concat(chunk.dynamicImports);
      if (left.length) this.error(`The plugin still imports ${left.join(", ")}: bundle it with a pinned version`);
      if (!chunk.exports.includes("apply")) this.error("The entry must export apply(ctx)");
    } },
  };
}

const outDir = process.env[OUT_DIR_ENV];
if (!outDir) throw new Error(`${OUT_DIR_ENV} is not set: build with scripts/build-plugin.mjs`);

export default defineConfig({
  root: here,
  publicDir: false,
  logLevel: "warn",
  // The bundled React packages (react, react-dom) pick their build by it.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [reactFromHost(), ownDependencies(), pluginContract()],
  // Symlinks kept: buzz-app modules keep their buzz-app/... ids, so the
  // bundle names them relative to the repository and holds no local path.
  resolve: { alias: { "@buzz": resolve(buzzLink, "src") }, preserveSymlinks: true },
  build: {
    outDir,
    // plugin/ also holds manifest.json, which the build must keep.
    emptyOutDir: false,
    target: "es2022",
    // Readable output: the install preview shows this file.
    // Rolldown keeps JSDoc and license comments but drops line comments, so
    // the reasons in `//` comments live only in src/.
    minify: false,
    lib: { entry: ENTRY, formats: ["es"], fileName: () => BUNDLE_NAME },
    rolldownOptions: {
      output: { codeSplitting: false },
      // A left-out package is never loaded for its side effects alone: only
      // one whose exports the plugin uses stays an import (see above).
      treeshake: { moduleSideEffects: (_id, external) => !external },
    },
  },
});
