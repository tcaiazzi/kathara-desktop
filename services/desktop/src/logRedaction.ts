/**
 * Keeping secrets out of the app log, which the app itself invites the user to open and share
 * (Help menu, the setup/error page's log tail). Free of any `electron` import, like safety.ts, so
 * it can be checked without an Electron runtime.
 */

/** Env var names whose value must never reach a log line (they still reach the actual command
 * unchanged — this only redacts what gets logged). */
const SENSITIVE_ENV_KEYS = new Set(["KATHARA_API_AUTH_TOKEN"]);

/** For logging an `env KEY=value ...` argv list without leaking a secret into the log file. */
export function redactEnvArgsForLog(envArgs: string[]): string[] {
  return envArgs.map((entry) => {
    const key = entry.slice(0, entry.indexOf("="));
    return SENSITIVE_ENV_KEYS.has(key) ? `${key}=***` : entry;
  });
}
