import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The SPA's Content-Security-Policy (src/kathara_api/spa.py) allows scripts from the app's own
// origin only, so an inline <script> in index.html would be blocked in every build the backend
// serves — while still running under `npm run dev`, which sends no policy.
describe("index.html", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf-8");

  it("loads every script from a file", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((tag) => !/\ssrc=/i.test(tag))).toEqual([]);
  });

  it("has no inline event handlers", () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});
