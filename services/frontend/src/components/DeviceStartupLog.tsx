import { useEffect, useState } from "react";
import { api, isAbortError } from "../services/api";
import type { StartupStatus } from "../services/types";

interface DeviceStartupLogProps {
  labId: string;
  device: string;
  /** Whether the device has anything to run at boot: a non-empty `.startup` or exec_commands. */
  hasCommands: boolean;
}

// A running device's boot-time startup log (/var/log/startup.log), polled until its startup
// commands finish — signaled by the /tmp/EOS marker Kathara's own startup sequence touches last
// (see KatharaService.is_startup_finished). Mounted only while the device runs and remounted per
// device, so nothing keeps polling for a device nobody is looking at.
//
// Deliberately no backoff/cap on the retry interval: a startup script can legitimately run for a
// long time, and the user watching this panel wants to see it evolve the whole way, not have the
// polling slow down or give up on a startup that's merely slow rather than broken.
export function DeviceStartupLog({ labId, device, hasCommands }: DeviceStartupLogProps) {
  const [status, setStatus] = useState<StartupStatus | null>(null);

  useEffect(() => {
    setStatus(null);
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
  }, [labId, device]);

  // A device with nothing to run at boot (a capture box like wireshark) finishes at once with no
  // output: say so, rather than "finished" over an empty log.
  const nothingToRun = !hasCommands && status?.finished && !status.log;

  return (
    <div className="iface">
      <div className="d-flex align-items-center justify-content-between">
        <span style={{ fontWeight: 600 }}>Startup Log</span>
        {status && !nothingToRun && (
          <span className={`kt-state ${status.finished ? "done" : "pending"}`}>
            {status.finished ? "finished" : "running…"}
          </span>
        )}
      </div>
      {status?.log ? (
        <pre className="startup">{status.log}</pre>
      ) : nothingToRun ? (
        <div className="hint">No startup commands.</div>
      ) : (
        <div className="hint">{status ? "No output yet." : "Loading…"}</div>
      )}
    </div>
  );
}
