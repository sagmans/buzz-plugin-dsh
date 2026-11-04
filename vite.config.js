// Bundles src/ into the one self-contained `plugin.js` that Buzz loads: one
// ES module with no imports and no assets, as the plugin API v1 needs. React
// and the host services come from the Cordis context at run time, so the
// bundle holds only this repository's code and its pinned libraries
// (package.json, pnpm-lock.yaml).
// Build with scripts/build-plugin.mjs: it writes plugin/plugin.js, or the
// folder after --out (scripts/check builds into a temporary folder).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const ENTRY = resolve(here, "src/plugin.js");
const BUNDLE_NAME = "plugin.js";
// An import statement left in the emitted module (rolldown writes each at
// the start of a line).
const STATIC_IMPORT = /^import\s(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gm;
// The build script sets the output folder: plugin/ to write, a temporary
// folder to compare.
const OUT_DIR_ENV = "DSH_PLUGIN_OUT_DIR";

/** Fails the build unless it is the installed form Buzz reads: one chunk,
 * no imports, exporting `apply`. */
function pluginContract() {
  return {
    name: "dsh-plugin-contract",
    generateBundle(_options, bundle) {
      const outputs = Object.values(bundle);
      const chunk = outputs[0];
      if (outputs.length !== 1 || chunk?.type !== "chunk") this.error("Plugin API v1 needs one self-contained JS module, without assets");
      const left = [...chunk.code.matchAll(STATIC_IMPORT)].map((match) => match[1]).concat(chunk.dynamicImports);
      if (left.length) this.error(`The plugin still imports ${left.join(", ")}: bundle it with a pinned version`);
      if (!chunk.exports.includes("apply")) this.error("The entry must export apply(ctx)");
    },
  };
}

const outDir = process.env[OUT_DIR_ENV];
if (!outDir) throw new Error(`${OUT_DIR_ENV} is not set: build with scripts/build-plugin.mjs`);

export default defineConfig({
  root: here,
  publicDir: false,
  logLevel: "warn",
  plugins: [pluginContract()],
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
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
