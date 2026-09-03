import { useEffect, useState } from "react";
import { api } from "../services/api";

/**
 * One-shot check of whether the local Kathara API is currently running as root/admin — see
 * `is_admin` on `GET /api/system` (src/kathara_api/services/kathara_service.py), true when the
 * backend process's real UID is 0.
 *
 * A mount-time check is as current as this ever needs to be: whenever the Electron shell actually
 * changes this (elevation:elevate/elevation:drop in services/desktop/src/main.ts), it reloads the
 * whole renderer against the new backend, which re-mounts everything anyway. No polling needed.
 */
export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api.systemInfo();
        if (!cancelled) setIsAdmin(info.is_admin);
      } catch {
        // Backend not reachable (yet, or at all) — leave it at the "not privileged" default.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return isAdmin;
}
