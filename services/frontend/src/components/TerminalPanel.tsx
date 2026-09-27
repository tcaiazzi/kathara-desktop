import type { IDockviewPanelProps } from "dockview-react";
import { useTerminalSlot } from "../hooks/useTerminalSlot";
import { sessionOfTerminalPanel } from "../services/terminalSessions";
import "./TerminalPanel.css";

// A dock panel showing one terminal session on its own. The session lives in the registry
// (TerminalSessionsContext) and this panel only lends it a place, so dockview owning the tab
// (title + close), drag-between-groups, splitting and group-maximize never touches the session
// itself. The session is named by the panel id (`terminal:<machine>:<n>`), which is also what a
// saved layout restores.
export function TerminalPanel(props: IDockviewPanelProps) {
  const sessionId = sessionOfTerminalPanel(props.api.id)?.id ?? props.api.id;
  const slotRef = useTerminalSlot(sessionId);
  return <div className="kt-term-slot" ref={slotRef} />;
}
