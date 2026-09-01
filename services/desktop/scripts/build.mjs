// Bundles the Electron main and preload scripts to CommonJS and copies the static status page
// next to them. Electron's main process is CJS, and the preload runs sandboxed (it may only
// require "electron"), so both are bundled with `electron` left external.
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "build");
const watch = process.argv.includes("--watch");

await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "main.ts"), path.join(root, "src", "preload.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  // Provided by the Electron runtime, not by node_modules.
  external: ["electron"],
  sourcemap: true,
  outdir,
  logLevel: "info",
});

// Loaded with loadFile() at runtime, so it has to sit beside the bundles.
await cp(path.join(root, "src", "setup.html"), path.join(outdir, "setup.html"));

if (watch) console.log("built (watch mode is not enabled for the copy step)");
