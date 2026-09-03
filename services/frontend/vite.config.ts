import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev-only proxy: forwards /api and its SSE endpoints to the FastAPI backend so the frontend
// never needs CORS in local dev (same origin from the browser's point of view). This is also
// what the Docker Compose dev stack relies on — it ships no reverse proxy of its own. The
// packaged desktop app needs none either: the backend serves the built SPA itself
// (KATHARA_API_STATIC_DIR, see src/kathara_api/spa.py).
const BACKEND_URL = process.env.VITE_BACKEND_URL || "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
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
});
