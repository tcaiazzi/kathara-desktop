// What the desktop shell tells the page about its backend after the backend stopped mid-session,
// while the page stays on screen (services/desktop's main.ts, BackendStateNotice / onBackendExit).
// Pure, so it can be tested without a DOM; desktop/BackendStateContext.tsx acts on it.

/** "restarting" — it stopped and a new one is on its way; "restarted" — a new one answers at the
 *  same address, so the page only needs its new pairing token; "down" — it isn't coming back on
 *  its own (a second crash, a failed restart, a new address the page wasn't moved to). */
export type BackendState = { state: "restarting"; cause: string } | { state: "restarted" } | { state: "down"; cause: string };

/** The notice the shell sent, or null for anything that isn't one: it arrives over IPC, typed
 *  `unknown` until checked. */
export function parseBackendState(value: unknown): BackendState | null {
  if (typeof value !== "object" || value === null) return null;
  const { state, cause } = value as Record<string, unknown>;
  if (state === "restarted") return { state };
  if ((state === "restarting" || state === "down") && typeof cause === "string") return { state, cause };
  return null;
}
