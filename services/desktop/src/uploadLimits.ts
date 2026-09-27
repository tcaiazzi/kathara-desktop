/**
 * The backend's upload & import limits, as the user set them in Settings. The backend applies a
 * change at once (PUT /settings), but only for its own lifetime; the shell keeps the values in
 * preferences.json and hands them to every backend it starts as `KATHARA_API_MAX_*`, which
 * src/kathara_api/config.py reads.
 *
 * Both ways in are untrusted: the renderer over IPC (settings:set-limits) and preferences.json,
 * which readPrefs parses without validating. On the elevated macOS/Windows start paths every env
 * value is written into a script run as root, so only a plain positive integer ever gets through.
 * Free of any `electron` import, so it is unit-tested on its own.
 */

export const LIMIT_KEYS = ["max_files_per_lab", "max_bytes_per_file", "max_bytes_per_lab"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type UploadLimits = Partial<Record<LimitKey, number>>;

function isLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The limits in `value` that are valid, or null when it isn't an object at all. A key that isn't
 *  a limit, or holds anything but a positive integer, is dropped. */
export function parseUploadLimits(value: unknown): UploadLimits | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const out: UploadLimits = {};
  for (const key of LIMIT_KEYS) {
    if (isLimit(record[key])) out[key] = record[key];
  }
  return out;
}

/** The env vars that pass saved limits to a backend: `max_files_per_lab` → `KATHARA_API_MAX_FILES_PER_LAB`. */
export function uploadLimitsEnv(saved: unknown): Record<string, string> {
  const limits = parseUploadLimits(saved) ?? {};
  return Object.fromEntries(
    Object.entries(limits).map(([key, value]) => [`KATHARA_API_${key.toUpperCase()}`, String(value)]),
  );
}
