import { Plus, SquareTerminal, Trash2, X } from "lucide-react";
import { Dropdown } from "react-bootstrap";
import { useTerminalSessions, type TerminalStatus } from "../context/TerminalSessionsContext";
import { useWorkspace } from "../context/WorkspaceContext";
import { terminalTitle } from "../services/terminalSessions";
import { TerminalSlot } from "./TerminalSlot";
import "./TerminalPanel.css";

// The Terminals tab: the workspace's terminals in one dock panel, the way an IDE's terminal panel
// holds them. The list on the right names every session located here; the area on the left shows
// the one selected in it. The sessions themselves live in the registry (TerminalSessionsContext),
// so switching between them only moves a host element: nothing reconnects and no scrollback is lost.

// The list's dot and its tooltip. A stopped device wins over the socket's own state: an idle
// terminal on a running device can just reconnect, one on a stopped device cannot.
function statusOf(status: TerminalStatus | undefined, running: boolean): { dot: string; label: string } {
  if (status === "connected") return { dot: "running", label: "connected" };
  if (status === "connecting") return { dot: "partial", label: "connecting" };
  return running ? { dot: "stopped", label: "disconnected" } : { dot: "stopped", label: "device stopped" };
}

interface OpenTerminalMenuProps {
  machines: string[];
  onOpen: (machine: string) => void;
  label?: string;
}

function OpenTerminalMenu({ machines, onOpen, label }: OpenTerminalMenuProps) {
  return (
    <Dropdown>
      <Dropdown.Toggle
        size="sm"
        variant="outline-secondary"
        className="kt-terms-add"
        disabled={!machines.length}
        title={machines.length ? "Open a terminal" : "No device is running"}
      >
        <Plus size={14} />
        {label && <span className="ms-1">{label}</span>}
      </Dropdown.Toggle>
      <Dropdown.Menu>
        {machines.map((m) => (
          <Dropdown.Item key={m} onClick={() => onOpen(m)}>
            {m}
          </Dropdown.Item>
        ))}
      </Dropdown.Menu>
    </Dropdown>
  );
}

export function TerminalsPanel() {
  const ws = useWorkspace();
  const { sessions, activeId, statuses, activate, close } = useTerminalSessions();
  const here = sessions.filter((s) => s.location === "tabs");
  const running = new Set(ws.detail.machines.filter((m) => m.running).map((m) => m.name));
  const runningNames = [...running];

  if (!here.length) {
    return (
      <div className="kt-ws-empty">
        <p className="kt-ws-muted mb-0">No terminals open.</p>
        {runningNames.length ? (
          <OpenTerminalMenu machines={runningNames} onOpen={ws.openTerminal} label="Open Terminal" />
        ) : (
          <p className="kt-ws-muted small mb-0">Start a device to open a terminal on it.</p>
        )}
      </div>
    );
  }

  return (
    <div className="kt-terms">
      <div className="kt-terms-main">{activeId && <TerminalSlot sessionId={activeId} />}</div>
      <aside className="kt-terms-list" aria-label="Open terminals">
        <div className="kt-terms-head">
          <OpenTerminalMenu machines={runningNames} onOpen={ws.openTerminal} />
          <button type="button" className="kt-ws-mini-btn" title="Close all terminals" onClick={ws.closeAllTerminals}>
            <Trash2 size={13} />
          </button>
        </div>
        <div className="kt-ws-list">
          {here.map((s) => {
            const status = statusOf(statuses[s.id], running.has(s.machine));
            return (
              <button
                key={s.id}
                type="button"
                className={`kt-ws-row kt-terms-row ${s.id === activeId ? "active" : ""}`}
                onClick={() => activate(s.id)}
                title={`${terminalTitle(s)} · ${status.label}`}
              >
                <SquareTerminal size={14} className="kt-terms-icon" />
                <span className="kt-ws-row-name">{terminalTitle(s)}</span>
                <span className={`kt-ws-dot ${status.dot}`} />
                <span
                  className="kt-terms-close"
                  role="button"
                  title="Close terminal"
                  onClick={(e) => {
                    e.stopPropagation();
                    close(s.id);
                  }}
                >
                  <X size={13} />
                </span>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
