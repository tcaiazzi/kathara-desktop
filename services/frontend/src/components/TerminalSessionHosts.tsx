import { createPortal } from "react-dom";
import { useTerminalSessions } from "../context/TerminalSessionsContext";
import { leafIds } from "../services/terminalSplits";
import { TerminalSession } from "./TerminalSession";

// Mounts every session into its host. Rendered once, beside the dock and inside WorkspaceProvider,
// because a session reads the lab's id and its device's running state from there.
export function TerminalSessionHosts() {
  const { sessions, groups, focusRequest, hostFor, toolbarHostFor, setStatus } = useTerminalSessions();
  // The panes of the Terminals tab's split groups, whose toolbars move into their pane headers.
  const inSplit = new Set(groups.flatMap((g) => (g.root.kind === "split" ? leafIds(g.root) : [])));
  return (
    <>
      {sessions.map((s) => {
        const host = hostFor(s.id);
        return createPortal(
          <TerminalSession
            id={s.id}
            machine={s.machine}
            host={host}
            toolbarHost={toolbarHostFor(s.id)}
            inSplit={s.location === "tabs" && inSplit.has(s.id)}
            focusSeq={focusRequest?.id === s.id ? focusRequest.seq : 0}
            setStatus={setStatus}
          />,
          host,
          s.id,
        );
      })}
    </>
  );
}
