import { useEffect, useState } from "react";
import { api } from "../services/api";

// Module-level cache shared by every component using this hook, so reopening "Add device"/the
// options editor doesn't re-fetch ~1900 keys each time. Deliberately the same shape as
// `useAvailableImages`, and for the same reasons: both feed an autocomplete on a free-text field,
// so a failure degrades to "no suggestions" rather than an error the user can do nothing about —
// the field still accepts anything the backend will.
//
// No TTL, unlike the images: this is the host kernel's own `net.*` namespace, which does not change
// while the app is open the way a `docker pull` does.
let cache: Promise<string[]> | null = null;

function fetchNetSysctls(): Promise<string[]> {
  if (!cache) cache = api.listNetSysctls().catch(() => []);
  return cache;
}

/** `net.*` sysctl keys available on the host's kernel, to suggest on a device's sysctl rows. Only
 * that namespace is accepted by the backend, so the list is also the set of valid keys. */
export function useNetSysctls(): string[] {
  const [sysctls, setSysctls] = useState<string[]>([]);
  useEffect(() => {
    // A flag, not an AbortSignal: the promise is the shared cache, so aborting it would cancel the
    // fetch for every other mount waiting on the same one.
    let cancelled = false;
    void fetchNetSysctls().then((next) => {
      if (!cancelled) setSysctls(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return sysctls;
}
