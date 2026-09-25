/**
 * Version strings the shell compares: the app's own against a GitHub release (updateCheck.ts),
 * and a probed Python interpreter's against the minimum the backend needs (prereqs.ts). Free of
 * any `electron` import, like safety.ts, so it can be checked without an Electron runtime.
 */

export type Version = [major: number, minor: number, patch: number];

/** Parses "1.2.3" or "v1.2.3" into a comparable [major, minor, patch] triple, or null if it
 * isn't in that shape (a pre-release tag, a malformed one, or a dev build's "0.0.0-dev" style
 * version) — treated as "nothing to compare against" rather than guessed at. */
export function parseVersion(raw: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewer(candidate: Version, current: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (candidate[i] !== current[i]) return candidate[i] > current[i];
  }
  return false;
}

/** Whether a Python version string ("3.12.4", as the preflight probe reports it) is 3.10 or later,
 *  the oldest the backend supports (pyproject.toml's `requires-python`). */
export function atLeast310(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 3 || (major === 3 && minor >= 10);
}
