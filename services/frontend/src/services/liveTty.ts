export type LiveTtyEvent =
  | { event: "output"; text: string }
  | { event: "ready" }
  | { event: "error"; detail?: string }
  | { event: "closed" };

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
      return payload.data != null ? { event: "output", text: atob(payload.data) } : null;
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
