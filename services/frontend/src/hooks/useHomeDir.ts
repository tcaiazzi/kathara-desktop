import { useEffect, useState } from "react";
import { desktop } from "../desktop/bridge";

// Asked of the shell once per page load and shared by every caller: it doesn't change while the
// app runs.
let homeDir: Promise<string | null> | null = null;

/**
 * The user's home directory, for showing a host path as "~/…" (services/labPlace.ts's
 * labFolder). Null outside the desktop app — a browser has no way to know it — and until the
 * shell answers, so a caller shows the path whole meanwhile.
 */
export function useHomeDir(): string | null {
  const [home, setHome] = useState<string | null>(null);

  useEffect(() => {
    const shell = desktop();
    if (!shell) return;
    homeDir ??= shell.getAppInfo().then(
      (info) => info.home || null,
      () => null,
    );
    let cancelled = false;
    void homeDir.then((value) => {
      if (!cancelled) setHome(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return home;
}
