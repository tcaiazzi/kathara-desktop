/**
 * Checks GitHub for a release newer than the running app, once per process lifetime. Purely
 * informational: a network failure, rate limit, or missing release just means "no update
 * found" — never an error surfaced to the user, and never something that can delay or block
 * startup (see main.ts, which fires this alongside startup() rather than inside it).
 */
import { app } from "electron";
import { log } from "./logger";

// The repo release.yml actually publishes to today (see its tag_name: v<package.json version>).
// Not a setting: changing where this app is distributed from is a maintainer decision, not a
// per-install preference.
const REPO = "tcaiazzi/kathara-desktop";
const RELEASES_LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FETCH_TIMEOUT_MS = 10_000;

export interface UpdateInfo {
  /** The newer version's number, without the leading "v" (e.g. "1.3.0"). */
  version: string;
  /** The release page on GitHub, to open externally — never auto-downloaded (see
   * electron-builder.yml: releases are unsigned and installed manually by design). */
  url: string;
}

/** Parses "1.2.3" or "v1.2.3" into a comparable [major, minor, patch] triple, or null if it
 * isn't in that shape (a pre-release tag, a malformed one, or a dev build's "0.0.0-dev" style
 * version) — treated as "nothing to compare against" rather than guessed at. */
function parseVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewer(candidate: [number, number, number], current: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (candidate[i] !== current[i]) return candidate[i] > current[i];
  }
  return false;
}

let cached: Promise<UpdateInfo | null> | null = null;

async function fetchLatestRelease(): Promise<UpdateInfo | null> {
  const currentVersion = parseVersion(app.getVersion());
  if (!currentVersion) return null; // unpackaged dev run, or an unparseable version — nothing to compare

  let response: Response;
  try {
    response = await fetch(RELEASES_LATEST_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    log(`update check: request failed (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }

  if (!response.ok) {
    // 404 means no release has ever been published yet; 403/429 means the (unauthenticated,
    // per-IP) rate limit was hit. Neither is worth telling the user about.
    log(`update check: GitHub responded ${response.status}`);
    return null;
  }

  let body: { tag_name?: unknown; html_url?: unknown };
  try {
    body = await response.json();
  } catch {
    return null;
  }

  const latestVersion = typeof body.tag_name === "string" ? parseVersion(body.tag_name) : null;
  if (!latestVersion || typeof body.html_url !== "string") return null;
  if (!isNewer(latestVersion, currentVersion)) return null;

  return { version: latestVersion.join("."), url: body.html_url };
}

/**
 * Memoized: the first call starts the fetch, every later call in this process (e.g. the
 * IPC handler answering a renderer that mounted after the first check already resolved) gets
 * the same result instead of hitting GitHub again.
 */
export function checkForUpdate(): Promise<UpdateInfo | null> {
  cached ??= fetchLatestRelease();
  return cached;
}
