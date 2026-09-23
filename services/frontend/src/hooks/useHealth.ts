import { useEffect, useState } from "react";
import { api, isAbortError } from "../services/api";

type Health = "checking" | "ok" | "down";

/** One-shot backend reachability probe, shown as a badge in the top bar. */
export function useHealth(): Health {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        await api.health(controller.signal);
        setHealth("ok");
      } catch (e) {
        // An abort is this component going away, not an unreachable backend — reporting "down"
        // for it would be a badge reacting to its own unmount.
        if (!isAbortError(e)) setHealth("down");
      }
    })();
    return () => controller.abort();
  }, []);

  return health;
}
