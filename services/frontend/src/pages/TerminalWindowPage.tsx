import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { TerminalToolbar } from "../components/TerminalToolbar";
import { useTerminalSession } from "../hooks/useTerminalSession";
import "./TerminalWindowPage.css";

// A bare, standalone page (no navbar) for one device's live terminal — opened via
// `openTerminalWindow()` as a real, separate browser window/tab rather than an in-page overlay,
// so the OS's own window manager handles drag/resize/arranging multiple terminals.
//
// Mounted outside WorkspaceProvider, which is why the lab name comes from the route.
export function TerminalWindowPage() {
  const { name = "", machine = "" } = useParams();
  const session = useTerminalSession(name, machine);
  const { containerRef, terminalRef } = session;

  useEffect(() => {
    document.title = `Terminal: ${machine}`;
  }, [machine]);

  return (
    <div className="kt-terminal-page">
      <TerminalToolbar
        variant="window"
        machine={machine}
        onClear={() => terminalRef.current?.clear()}
        {...session}
      />
      <div ref={containerRef} className="kt-topo-terminal-screen" onClick={() => terminalRef.current?.focus()} />
    </div>
  );
}
