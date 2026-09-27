import { createPortal } from "react-dom";
import { useTerminalSessions } from "../context/TerminalSessionsContext";
import { TerminalSession } from "./TerminalSession";

// Mounts every session into its host. Rendered once, beside the dock and inside WorkspaceProvider,
// because a session reads the lab's id and its device's running state from there.
export function TerminalSessionHosts() {
  const { sessions, hostFor } = useTerminalSessions();
  return (
    <>
      {sessions.map((s) => {
        const host = hostFor(s.id);
        return createPortal(<TerminalSession machine={s.machine} host={host} />, host, s.id);
      })}
    </>
  );
}
