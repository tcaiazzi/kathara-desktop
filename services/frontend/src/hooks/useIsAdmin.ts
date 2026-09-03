import { useEffect, useState } from "react";
import { api } from "../services/api";

/**
 * One-shot check of whether the local Kathara API is currently running as root/admin — see
 * `is_admin` on `GET /api/system` (src/kathara_api/services/kathara_service.py), true when the
 * backend process's real UID is 0.
 *
 * Returns `undefined` until the check resolves, rather than defaulting to `false` — a caller that
 * gates a one-time action on "confirmed not admin" (WorkspacePage's onboarding-tour auto-trigger)
 * needs to tell "still checking" apart from "checked, not privileged", or it could act on the
 * default before the real answer arrives. `{isAdmin && ...}`-style display code (the TitleBar/
 * AppNavbar badges) already treats `undefined` the same as `false`, so this is a safe widening.
 *
 * A mount-time check is as current as this ever needs to be: whenever the Electron shell actually
 * changes this (elevation:elevate/elevation:drop in services/desktop/src/main.ts), it reloads the
 * whole renderer against the new backend, which re-mounts everything anyway. No polling needed.
 */
export function useIsAdmin(): boolean | undefined {
  const [isAdmin, setIsAdmin] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api.systemInfo();
        if (!cancelled) setIsAdmin(info.is_admin);
      } catch {
        // Backend unreachable — assume not privileged rather than leaving callers stuck on
        // "still checking" forever over a transient/permanent failure to ask.
        if (!cancelled) setIsAdmin(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return isAdmin;
}
