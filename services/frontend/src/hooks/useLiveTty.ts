import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { decodeLiveMessage, type LiveTtyEvent } from "../services/liveTty";

const MIN_TERMINAL_FONT_SIZE = 8;
const MAX_TERMINAL_FONT_SIZE = 28;

export interface UseLiveTtyOptions {
  /** Returns the `/tty/ws` URL to connect to, or null when there's nothing to connect to yet. */
  wsUrl: () => string | null;
  terminalOptions: ConstructorParameters<typeof Terminal>[0];
  /** Whether to send an explicit `{type:"close"}` before closing the socket. */
  sendCloseHandshake: boolean;
  /** `term` is null only in the brief window where the terminal has been torn down (e.g. the
   * caller's `enabled` flag flipped off) but an in-flight socket event still arrives. */
  onMessage: (event: LiveTtyEvent, term: Terminal | null) => void;
  onError: (term: Terminal | null) => void;
  onClose: (ev: CloseEvent, term: Terminal | null) => void;
}

export interface UseLiveTty {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  connected: boolean;
  connecting: boolean;
  connect: () => void;
  disconnect: () => void;
  /** Re-fit the terminal to its container's current size. For callers whose container can resize
   * without a `window` resize event firing (e.g. a draggable/resizable panel) — the hook only
   * re-fits on `window` resize on its own. No-ops before the terminal is constructed. */
  fit: () => void;
}

// Shared WebSocket+xterm plumbing for the live-TTY surfaces (TerminalPanel's dockview terminals,
// TerminalWindowPage's standalone popup window). `enabled` gates terminal construction — the
// caller's own container div must be conditionally rendered on the same flag so it exists by the
// time this effect runs. Connect/disconnect stay caller-driven (manual button vs. an auto-connect
// effect) rather than owned by this hook, since that's the one part of callers' lifecycles that's
// genuinely different.
export function useLiveTty(enabled: boolean, options: UseLiveTtyOptions): UseLiveTty {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // Always-current options for the WebSocket callbacks below, without forcing connect/disconnect
  // to be redefined (and effects to re-run) on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!enabled || terminalRef.current || !containerRef.current) return;

    const term = new Terminal(optionsRef.current.terminalOptions);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const baseFontSize = optionsRef.current.terminalOptions?.fontSize ?? 13;
    // Ctrl+=/Ctrl+- zoom this terminal's text in/out (Ctrl+0 resets), independent of every other
    // open terminal since each has its own Terminal instance. preventDefault stops the browser
    // from also zooming the whole page on the same shortcut.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !(event.ctrlKey || event.metaKey)) return true;
      const zoomIn = event.key === "+" || event.key === "=" || event.code === "NumpadAdd";
      const zoomOut = event.key === "-" || event.code === "NumpadSubtract";
      const zoomReset = event.key === "0" || event.code === "Numpad0";
      if (!zoomIn && !zoomOut && !zoomReset) return true;
      event.preventDefault();
      const current = term.options.fontSize ?? baseFontSize;
      term.options.fontSize = zoomReset
        ? baseFontSize
        : Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, current + (zoomIn ? 1 : -1)));
      fit();
      return false;
    });

    const onDataDispose = term.onData((data) => {
      const ws = socketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "input", data }));
    });
    const onResizeDispose = term.onResize(({ cols, rows }) => {
      const ws = socketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    const onWindowResize = () => {
      fitAddonRef.current?.fit();
      const ws = socketRef.current;
      const t = terminalRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !t) return;
      ws.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      window.removeEventListener("resize", onWindowResize);
      onDataDispose.dispose();
      onResizeDispose.dispose();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [enabled]);

  function fit() {
    fitAddonRef.current?.fit();
    const ws = socketRef.current;
    const term = terminalRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !term) return;
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }

  function disconnect() {
    const ws = socketRef.current;
    if (ws) {
      if (optionsRef.current.sendCloseHandshake && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "close" }));
      }
      ws.close();
      socketRef.current = null;
    }
    setConnected(false);
    setConnecting(false);
  }

  function connect() {
    const url = optionsRef.current.wsUrl();
    if (!url) return;
    disconnect();
    setConnecting(true);

    const ws = new WebSocket(url);
    socketRef.current = ws;

    // Every handler below guards on `socketRef.current === ws`: React 18 StrictMode's dev-only
    // double-invoke (mount -> cleanup -> mount) means an earlier `connect()` call's socket can get
    // aborted mid-handshake by `disconnect()` but still deliver its error/close events later,
    // asynchronously, after a second, real socket has already taken over `socketRef.current`. Without
    // this guard, the stale socket's belated events would overwrite `connected`/`connecting` state
    // and write misleading "[error]"/"[closed]" text into the (shared) terminal for a connection
    // that isn't the current one anymore.
    ws.onopen = () => {
      if (socketRef.current !== ws) return;
      setConnected(true);
      setConnecting(false);
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
      const term = terminalRef.current;
      if (term && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    ws.onmessage = (ev) => {
      if (socketRef.current !== ws) return;
      const parsed = decodeLiveMessage(String(ev.data));
      if (parsed) optionsRef.current.onMessage(parsed, terminalRef.current);
    };
    ws.onerror = () => {
      if (socketRef.current !== ws) return;
      optionsRef.current.onError(terminalRef.current);
    };
    ws.onclose = (ev) => {
      if (socketRef.current !== ws) return;
      setConnected(false);
      setConnecting(false);
      socketRef.current = null;
      optionsRef.current.onClose(ev, terminalRef.current);
    };
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => disconnect, []);

  return { containerRef, terminalRef, connected, connecting, connect, disconnect, fit };
}
