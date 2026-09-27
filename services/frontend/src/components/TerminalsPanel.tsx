import { Plus, SquareTerminal, Trash2, X } from "lucide-react";
import { Button, Dropdown } from "react-bootstrap";
import { createPortal } from "react-dom";
import { useTerminalSessions, type TerminalStatus } from "../context/TerminalSessionsContext";
import { useWorkspace } from "../context/WorkspaceContext";
import { TERMINAL_DRAG_TYPE, terminalTitle } from "../services/terminalSessions";
import { TerminalSlot } from "./TerminalSlot";
import "./TerminalPanel.css";

// The Terminals tab: the workspace's terminals in one dock panel, the way an IDE's terminal panel
// holds them. The list on the right names every session located here; the area on the left shows
// the one selected in it. The sessions themselves live in the registry (TerminalSessionsContext),
// so switching between them only moves a host element: nothing reconnects and no scrollback is lost.
//
// A row dragged out onto the dock detaches its terminal into a panel of its own wherever it is
// dropped (the drop itself is handled by the workspace page's dockview listeners); its context menu
// does the same beside this tab.

// The list's dot and its tooltip. A stopped device wins over the socket's own state: an idle
// terminal on a running device can just reconnect, one on a stopped device cannot.
function statusOf(status: TerminalStatus | undefined, running: boolean): { dot: string; label: string } {
  if (status === "connected") return { dot: "running", label: "connected" };
  if (status === "connecting") return { dot: "partial", label: "connecting" };
  return running ? { dot: "stopped", label: "disconnected" } : { dot: "stopped", label: "device stopped" };
}

interface DeviceMenuProps {
  machines: string[];
  onOpen: (machine: string) => void;
}

// The running devices to open a terminal on, as the menu of the dropdown it is rendered in. It goes
// into document.body rather than into this panel: the dock panel clips its overflow and the empty
// state scrolls, so a menu kept inside is cut off, or pushed wholly off screen, whenever it is taller
// than the room the panel has left. From the body, Popper places it against the window instead, and
// its max height (TerminalPanel.css) always leaves it room on one side of its toggle.
function DeviceMenu({ machines, onOpen }: DeviceMenuProps) {
  return createPortal(
    <Dropdown.Menu className="kt-terms-menu">
      {machines.map((m) => (
        <Dropdown.Item key={m} onClick={() => onOpen(m)} className="d-flex align-items-center gap-2">
          <SquareTerminal size={14} className="kt-terms-icon" />
          {m}
        </Dropdown.Item>
      ))}
    </Dropdown.Menu>,
    document.body,
  );
}

interface OpenTerminalMenuProps {
  machines: string[];
  onOpen: (machine: string) => void;
}

// The list's "+": a compact menu of the running devices.
function OpenTerminalMenu({ machines, onOpen }: OpenTerminalMenuProps) {
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
      </Dropdown.Toggle>
      <DeviceMenu machines={machines} onOpen={onOpen} />
    </Dropdown>
  );
}

interface TerminalsEmptyProps {
  machines: string[];
  onOpen: (machine: string) => void;
}

// What the tab shows with no terminal in it: the one thing to do here, as the primary action. With a
// single running device there is nothing to choose, so the button opens straight onto it.
function TerminalsEmpty({ machines, onOpen }: TerminalsEmptyProps) {
  return (
    <div className="kt-terms-empty">
      <SquareTerminal size={36} strokeWidth={1.5} className="kt-terms-empty-icon" />
      <div className="kt-terms-empty-title">No terminals open</div>
      <p className="kt-terms-empty-lead">
        {machines.length
          ? "Open a shell on a running device. Every terminal you open is listed here, and any of them can be dragged out into a panel of its own."
          : "Start a device to open a terminal on it."}
      </p>
      {machines.length === 1 ? (
        <Button variant="primary" size="sm" onClick={() => onOpen(machines[0])}>
          <Plus size={15} className="me-1" />
          Open Terminal on {machines[0]}
        </Button>
      ) : (
        machines.length > 1 && (
          <Dropdown>
            <Dropdown.Toggle variant="primary" size="sm">
              <Plus size={15} className="me-1" />
              Open Terminal
            </Dropdown.Toggle>
            <DeviceMenu machines={machines} onOpen={onOpen} />
          </Dropdown>
        )
      )}
    </div>
  );
}

export function TerminalsPanel() {
  const ws = useWorkspace();
  const { sessions, activeId, statuses, activate, close } = useTerminalSessions();
  const openRowMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    ws.setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Move into New Panel", action: () => ws.moveTerminalToPanel(id) },
        { label: "Close Terminal", danger: true, action: () => close(id) },
      ],
    });
  };
  const here = sessions.filter((s) => s.location === "tabs");
  const running = new Set(ws.detail.machines.filter((m) => m.running).map((m) => m.name));
  const runningNames = [...running];

  if (!here.length) return <TerminalsEmpty machines={runningNames} onOpen={ws.openTerminal} />;

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
                onContextMenu={(e) => openRowMenu(e, s.id)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(TERMINAL_DRAG_TYPE, s.id);
                  // The app-wide react-dnd HTML5 backend (App.tsx) cancels any drag that carries no
                  // type it knows as native, which ours alone is not; a plain-text copy of the name
                  // lets the drag go ahead, as dockview does for its own tab drags.
                  e.dataTransfer.setData("text/plain", terminalTitle(s));
                  e.dataTransfer.effectAllowed = "move";
                }}
                title={`${terminalTitle(s)} · ${status.label} · drag onto the dock to detach`}
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
