// Mutation testing, for `npm run test:mutation` / `make mutation-desktop`. Never run in CI: its
// survivors need reading one by one, since many are equivalent mutants that no test could ever
// tell apart from the original.
//
// Mutates exactly the modules that have a sibling `.test.ts`, the ones this suite is meant to
// check: the pure helpers that import nothing from `electron`. The rest of the shell needs a
// real window or process and is checked by running the app. The HTML report lands in
// reports/mutation/mutation.html.
import { existsSync, readdirSync } from "node:fs";

const tested = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && existsSync(`${dir}/${f.replace(/\.ts$/, ".test.ts")}`))
    .map((f) => `${dir}/${f}`);

export default {
  testRunner: "vitest",
  mutate: tested("src"),
  reporters: ["clear-text", "progress", "html", "json"],
  coverageAnalysis: "perTest",
  concurrency: 4,
  thresholds: { high: 80, low: 60, break: null },
};
