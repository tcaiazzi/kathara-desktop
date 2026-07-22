import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev-only proxy: forwards /api and its SSE endpoints to the FastAPI backend so the frontend
// never needs CORS in local dev (same origin from the browser's point of view). In production
// (Docker Compose), the nginx reverse proxy plays the same role.
const BACKEND_URL = process.env.VITE_BACKEND_URL || "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  // react-rnd's react-draggable dependency reads process.env.NODE_ENV directly (a CJS-era
  // pattern); Vite doesn't polyfill `process` in the browser bundle like webpack does, so without
  // this it throws `ReferenceError: process is not defined` the moment a drag starts.
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "development"),
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
});
