import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef } from "react";
import { useWorkspace } from "../context/WorkspaceContext";
import { useTerminalSession } from "../hooks/useTerminalSession";
import { TerminalToolbar } from "./TerminalToolbar";
import "./TerminalPanel.css";

// One live-terminal session rendered as its own dockview panel. dockview owns the tab (title +
// close), drag-between-groups, splitting/tiling, and group-maximize — so this component only carries
// a compact control bar + the xterm surface (no custom drag/wide/fullscreen chrome). The target
// device is passed as a dockview panel param; lab id + running state come from WorkspaceContext,
// so the panel re-renders live as the lab's state changes.
export function TerminalPanel(props: IDockviewPanelProps<{ machine: string }>) {
  const machine = props.params.machine;
  const ws = useWorkspace();
  const running = ws.detail.machines.some((m) => m.name === machine && m.running);
  // Scopes auto-focus-on-connect to this panel, so a background reconnect can't steal focus (and
  // with it, Ctrl+/Ctrl- zoom) from the editor, the topology graph, or another terminal panel.
  const panelRef = useRef<HTMLDivElement | null>(null);

  const session = useTerminalSession(ws.labId, machine, { focusScopeRef: panelRef, autoConnect: running });
  const { containerRef, terminalRef, disconnect, fit } = session;

  // Device stopped while the terminal is open — disconnect but keep the panel + scrollback so the
  // user can reconnect once it's running again.
  useEffect(() => {
    if (!running) disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // dockview resizes the panel without firing a window resize, so watch the container and re-fit.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="kt-term-panel" ref={panelRef}>
      <TerminalToolbar
        variant="panel"
        machine={machine}
        running={running}
        onClear={() => terminalRef.current?.clear()}
        {...session}
      />
      <div ref={containerRef} className="kt-term-screen" onClick={() => terminalRef.current?.focus()} />
    </div>
  );
}
