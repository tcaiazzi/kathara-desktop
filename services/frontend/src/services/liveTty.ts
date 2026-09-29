export type LiveTtyEvent =
  | { event: "output"; bytes: Uint8Array }
  | { event: "ready" }
  | { event: "error"; detail?: string }
  | { event: "closed" };

// Decode a base64 output payload to the raw bytes the device actually wrote. Deliberately NOT
// `atob(...)` alone: that yields one JS char per *byte*, so a UTF-8 sequence (accents, the
// box-drawing `htop`/`ip -c` emit, any localized message) reaches xterm as separate Latin-1 code
// points and renders as mojibake. xterm's `write()` accepts a Uint8Array and does its own UTF-8
// decoding — including across chunk boundaries, which a per-message TextDecoder here could not.
function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Parses a raw `/tty/ws` message into a typed event, base64-decoding output payloads. Returns
// null for malformed JSON or a payload this UI has nothing to render for.
export function decodeLiveMessage(raw: string): LiveTtyEvent | null {
  let payload: { event?: string; data?: string; detail?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  switch (payload.event) {
    case "output":
      return payload.data != null ? { event: "output", bytes: base64ToBytes(payload.data) } : null;
    case "ready":
      return { event: "ready" };
    case "error":
      return { event: "error", detail: payload.detail };
    case "closed":
      return { event: "closed" };
    default:
      return null;
  }
}

/** What a key press asks of a live terminal's clipboard: the ones a Linux/Windows terminal uses,
 *  Ctrl+Shift+C/V. Plain Ctrl+C/V stay the shell's (an interrupt, a literal next character). On
 *  macOS Cmd+C/V already reach the terminal's own copy and paste, so nothing here claims them. */
export type TerminalClipboardShortcut = "copy" | "paste";

export function terminalClipboardShortcut(event: {
  type: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): TerminalClipboardShortcut | null {
  if (event.type !== "keydown" || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return null;
  // `code`, not `key`: with Shift held `key` is "C", and on a non-Latin layout a different letter.
  if (event.code === "KeyC") return "copy";
  if (event.code === "KeyV") return "paste";
  return null;
}
