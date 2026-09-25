/**
 * What an elevated backend restart reports, and the part of it that may cross IPC to the
 * renderer. Free of any `electron` import (the `BackendHandle` import is type-only and erased), like
 * safety.ts, so it can be checked without an Electron runtime.
 */
import type { BackendHandle } from "./backend";

/** Why an elevated (re)start of the backend didn't produce a running, root-owned backend. */
export type ElevateFailureReason = "wrong-password" | "not-permitted" | "cancelled" | "timeout" | "error" | "rate-limited";

/** `restarted` says whether the attempt got far enough to stop the backend it was replacing.
 * When false — a password rejected before anything was torn down, or a native attempt that
 * failed alongside a still-running backend — the caller's page is still on a live origin and
 * must be left alone, so its elevation prompt can show the error and offer a retry in place.
 * When true, the backend was restarted on a *new* port and the caller has to be sent there. */
export type ElevateResult =
  | { ok: true; handle: BackendHandle }
  | { ok: false; reason: ElevateFailureReason; message: string; restarted: boolean };

/** What actually crosses the IPC boundary to the renderer for `elevation:elevate` — see
 * main.ts's handler. Deliberately smaller than `ElevateResult` on success: the renderer never
 * needs the new backend's `baseUrl`/`token` itself (main.ts navigates the window there directly;
 * `auth:get-token` remains the only channel that ever hands the renderer a token), and returning
 * `handle` here would leak the bearer token straight into a renderer that loads content this app
 * doesn't trust (see preload.ts's own doc comment on why its surface is kept small). */
export type ElevateOutcome =
  | { ok: true }
  | { ok: false; reason: ElevateFailureReason; message: string; restarted: boolean };

export function toElevateOutcome(result: ElevateResult): ElevateOutcome {
  return result.ok ? { ok: true } : result;
}
