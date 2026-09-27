/**
 * The one way the shell turns a caught value into text for a log line, a dialog or an IPC
 * result. Free of any `electron` import, like safety.ts, so it can be checked without an Electron
 * runtime. env.ts keeps its own variant on purpose: it interpolates a non-Error value as is.
 */

/** An Error's message, or anything else stringified — a `catch` can receive any value at all. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
