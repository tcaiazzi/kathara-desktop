import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev-only proxy: forwards /api and its SSE endpoints to the FastAPI backend so the frontend
// never needs CORS in local dev (same origin from the browser's point of view). In production
// (Docker Compose), the nginx reverse proxy plays the same role.
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
