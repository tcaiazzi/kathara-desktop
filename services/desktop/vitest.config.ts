// Unit tests for the Electron shell's pure helpers — the modules that import nothing from
// `electron` (safety.ts and its siblings), so they run under plain Node with no Electron runtime.
// Code that needs a real window, IPC or a child process is checked by running the app instead
// (see the dev-workflow skill). Test files never reach the shipped app: scripts/build.mjs bundles
// from main.ts and preload.ts only, and electron-builder ships build/ alone.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // `npm run test:coverage`. Report only, no threshold. Every module under src/ is counted, so
    // the total reflects the whole shell, not just the part these tests are meant to reach.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
    },
  },
});
