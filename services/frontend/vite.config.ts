import react from "@vitejs/plugin-react";
// `vitest/config`, not `vite`: it re-exports `defineConfig` with the `test` key typed in, which is
// what lets this double as the Vitest config without a second config file or a tsconfig change.
import { defineConfig } from "vitest/config";

// Dev-only proxy: forwards /api and its SSE endpoints to the FastAPI backend so the frontend
// never needs CORS in local dev (same origin from the browser's point of view). This is also
// what the Docker Compose dev stack relies on — it ships no reverse proxy of its own. The
// packaged desktop app needs none either: the backend serves the built SPA itself
// (KATHARA_API_STATIC_DIR, see src/kathara_api/spa.py).
const BACKEND_URL = process.env.VITE_BACKEND_URL || "http://localhost:8000";

// Splits the entry bundle's dependencies into a few chunks so none crosses Vite's 500 kB
// warning. CodeMirror and Lezer stay out of the catch-all `vendor` chunk, which the entry loads:
// only the lazy-loaded CodeEditor imports them, so they belong in its chunk.
const VENDOR_CHUNKS: [chunk: string, packages: RegExp][] = [
  ["dockview", /^dockview/],
  ["xterm", /^@xterm\//],
  ["react", /^(react|react-dom|scheduler|react-router|react-router-dom)$/],
];

function vendorChunk(id: string): string | undefined {
  const pkg = id.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];
  if (!pkg || /^@(codemirror|lezer)\//.test(pkg) || pkg === "codemirror") return undefined;
  return VENDOR_CHUNKS.find(([, packages]) => packages.test(pkg))?.[0] ?? "vendor";
}

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: BACKEND_URL,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    // No jsdom: only the pure services/*.ts helpers are tested here. Component and hook
    // rendering is out of scope, so logic worth testing gets extracted into a pure helper first —
    // which is why labConfRules.ts and fsTree.ts exist apart from their CodeMirror/React callers.
    environment: "node",
    include: ["src/**/*.test.ts"],
    // `npm run test:coverage`. Report only, no threshold. Components and hooks are counted too, so
    // the total reflects the whole of src/, not just the part this suite is meant to reach.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.ts", "src/test/**", "src/main.tsx", "src/services/types.ts"],
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
    },
  },
});
