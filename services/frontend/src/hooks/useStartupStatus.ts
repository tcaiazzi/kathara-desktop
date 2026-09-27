import { useEffect, useState } from "react";
import { api, isAbortError } from "../services/api";
import type { StartupStatus } from "../services/types";

// A running device's boot-time startup log (/var/log/startup.log), polled until its startup
// commands finish — signaled by the /tmp/EOS marker Kathara's own startup sequence touches last
// (see KatharaService.is_startup_finished). Polls only while `running`, and starts afresh per
// device, so nothing keeps polling for a device nobody is looking at. Null until the first answer.
//
// Deliberately no backoff/cap on the retry interval: a startup script can legitimately run for a
// long time, and the user watching the log wants to see it evolve the whole way, not have the
// polling slow down or give up on a startup that's merely slow rather than broken.
export function useStartupStatus(labId: string, device: string, running: boolean): StartupStatus | null {
  const [status, setStatus] = useState<StartupStatus | null>(null);

  useEffect(() => {
    setStatus(null);
    if (!running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      api
        .getStartupStatus(labId, device, controller.signal)
        .then((next) => {
          setStatus(next);
          if (!next.finished) timer = setTimeout(poll, 1500);
        })
        .catch((e) => {
          if (isAbortError(e)) return;
          timer = setTimeout(poll, 1500);
        });
    };
    poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [labId, device, running]);

  return status;
}
