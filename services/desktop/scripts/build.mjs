// Bundles the Electron main and preload scripts to CommonJS and copies the static pages next to
// them. Electron's main process is CJS, and the preload runs sandboxed (it may only
// require "electron"), so both are bundled with `electron` left external.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "build");
// Every run of this script is a full rebuild, so start from a clean directory: otherwise a file
// removed from src/ leaves its last compiled output behind, and electron-builder's
// `files: build/**/*` ships it regardless.
await rm(outdir, { recursive: true, force: true });
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

// Loaded with loadFile() at runtime, so they have to sit beside the bundles — each page with the
// script and stylesheet it loads by relative path (its Content-Security-Policy allows no inline
// ones).
for (const page of ["setup", "splash"]) {
  for (const ext of ["html", "js", "css"]) {
    await cp(path.join(root, "src", `${page}.${ext}`), path.join(outdir, `${page}.${ext}`));
  }
}
// splash.html references this by its own relative path, so it must land right next to it.
await cp(path.join(root, "resources", "splash.png"), path.join(outdir, "splash.png"));

