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
