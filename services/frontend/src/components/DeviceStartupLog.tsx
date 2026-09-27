import type { StartupStatus } from "../services/types";

interface DeviceStartupLogProps {
  /** The device's startup status, as useStartupStatus polls it; null until the first answer. */
  status: StartupStatus | null;
  /** Whether the device has anything to run at boot: a non-empty `.startup` or exec_commands. */
  hasCommands: boolean;
}

// A running device's boot-time startup log, with whether its startup commands have finished.
// Shown in more than one Inspector tab, so the polling lives in useStartupStatus, once per device.
export function DeviceStartupLog({ status, hasCommands }: DeviceStartupLogProps) {
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
