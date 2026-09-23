import { Badge, Button, Form } from "react-bootstrap";

// The shell picker + connect/clear + status badge strip above an xterm surface.
//
// `variant` is the only thing that differs visually between the two hosts — the dockview panel is
// compact and uses the panel stylesheet, the standalone window is full size. The *behaviour* needs
// no variant: with `running` left at its default the panel's own logic collapses exactly onto what
// the window needs (the connect button's stopped-device guard and the badge's fourth state both
// disappear), so there is one implementation rather than two that have to be kept in step.

const SHELL_FALLBACK = ["bash", "sh", "ash", "zsh"];

interface TerminalToolbarProps {
  variant: "panel" | "window";
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
  const panel = variant === "panel";
  const size = panel ? "sm" : undefined;

  return (
    <div className={panel ? "kt-term-bar" : "kt-topo-terminal-toolbar"}>
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
        variant={connected ? "outline-danger" : "outline-success"}
        onClick={() => (connected ? disconnect() : connect())}
        disabled={!running || connecting}
        title={running ? undefined : `${machine} is not running`}
      >
        {connecting ? "Connecting..." : connected ? "Disconnect" : "Connect"}
      </Button>
      <Button size={size} variant="outline-secondary" onClick={onClear}>
        Clear
      </Button>
      <Badge bg={connected ? "success" : connecting ? "warning" : running ? "secondary" : "dark"}>
        {connected ? "connected" : connecting ? "connecting" : running ? "disconnected" : "device stopped"}
      </Badge>
    </div>
  );
}
