import { useEffect, useState } from "react";
import { api } from "../services/api";

export type Health = "checking" | "ok" | "down";

/** One-shot backend reachability probe, shown as a badge in the top bar. */
export function useHealth(): Health {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await api.health();
        if (!cancelled) setHealth("ok");
      } catch {
        if (!cancelled) setHealth("down");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return health;
}
