import { Eraser, Loader2, Plug, Unplug } from "lucide-react";
import { Button, Form } from "react-bootstrap";
import "./TerminalPanel.css";

// The shell picker + connect/clear + connection-state strip above an xterm surface.
//
// `variant` is the only thing that differs visually between the hosts — the dockview panel is
// compact and uses the panel stylesheet, the standalone window is full size, and a pane of a split
// group fits the toolbar into its header, its buttons reduced to icons and its state to a dot. The *behaviour* needs
// no variant: with `running` left at its default the panel's own logic collapses exactly onto what
// the window needs (the connect button's stopped-device guard and the state's fourth value both
// disappear), so there is one implementation rather than two that have to be kept in step.

const SHELL_FALLBACK = ["bash", "sh", "ash", "zsh"];

const STATE_LABEL = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Disconnected",
  stopped: "Device stopped",
};

interface TerminalToolbarProps {
  variant: "panel" | "window" | "pane";
  shells: string[];
  shell: string;
  chooseShell: (shell: string) => void;
  connected: boolean;
  connecting: boolean;
  connect: () => void;
  disconnect: () => void;
  onClear: () => void;
  /** The device this terminal targets, for the "not running" tooltip. */
  machine: string;
  /** Defaults to true: the standalone window has no device-state of its own to reflect. */
  running?: boolean;
}

export function TerminalToolbar({
  variant,
  shells,
  shell,
  chooseShell,
  connected,
  connecting,
  connect,
  disconnect,
  onClear,
  machine,
  running = true,
}: TerminalToolbarProps) {
  const pane = variant === "pane";
  const panel = variant === "panel" || pane;
  const size = panel ? "sm" : undefined;

  const iconSize = panel ? 14 : 16;
  // Connecting and a stopped device both leave nothing to click; connected offers the way out, idle
  // the way in, filled since it is what the user is there to do.
  const state = connected ? "connected" : connecting ? "connecting" : running ? "disconnected" : "stopped";
  const connectLabel = connecting ? "Connecting…" : connected ? "Disconnect" : "Connect";

  return (
    <div className={pane ? "kt-term-bar kt-term-bar--pane" : panel ? "kt-term-bar" : "kt-topo-terminal-toolbar"}>
      <Form.Select
        size={size}
        className={panel ? "kt-term-shell" : undefined}
        style={panel ? undefined : { width: 120 }}
        value={shell}
        onChange={(e) => chooseShell(e.target.value)}
        disabled={connected || connecting}
        aria-label="Shell"
      >
        {(shells.length ? shells : SHELL_FALLBACK).map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </Form.Select>
      <Button
        size={size}
        variant={connected ? "outline-secondary" : "success"}
        className="kt-term-btn"
        onClick={() => (connected ? disconnect() : connect())}
        disabled={!running || connecting}
        title={running ? (pane ? connectLabel : undefined) : `${machine} is not running`}
        aria-label={connectLabel}
      >
        {connecting ? (
          <Loader2 size={iconSize} className="kt-term-spin" />
        ) : connected ? (
          <Unplug size={iconSize} />
        ) : (
          <Plug size={iconSize} />
        )}
        {!pane && connectLabel}
      </Button>
      <Button
        size={size}
        variant="outline-secondary"
        className="kt-term-btn"
        onClick={onClear}
        title="Clear the screen"
        aria-label="Clear"
      >
        <Eraser size={iconSize} />
        {!pane && "Clear"}
      </Button>
      <span className={`kt-term-status ${state}`} role="status" title={STATE_LABEL[state]}>
        <span className="kt-term-status-dot" />
        {!pane && STATE_LABEL[state]}
      </span>
    </div>
  );
}
