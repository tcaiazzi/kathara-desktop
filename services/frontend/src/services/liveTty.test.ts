import { describe, expect, it } from "vitest";
import { decodeLiveMessage, terminalClipboardShortcut } from "./liveTty";

// What the backend sends for terminal output: the raw bytes the device wrote, base64-encoded.
function outputFrame(bytes: Uint8Array): string {
  return JSON.stringify({ event: "output", data: btoa(String.fromCharCode(...bytes)) });
}

describe("decodeLiveMessage", () => {
  it("hands terminal output over as the exact bytes the device wrote", () => {
    const raw = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0xff]);

    expect(decodeLiveMessage(outputFrame(raw))).toEqual({ event: "output", bytes: raw });
  });

  it("keeps a multi-byte UTF-8 sequence as bytes, not one character per byte", () => {
    const utf8 = new TextEncoder().encode("caffè ─ ok");

    const decoded = decodeLiveMessage(outputFrame(utf8));

    expect(decoded).toEqual({ event: "output", bytes: utf8 });
    // Decoding the bytes as UTF-8 gives the original text back, which a Latin-1 string would not.
    expect(new TextDecoder().decode((decoded as { bytes: Uint8Array }).bytes)).toBe("caffè ─ ok");
  });

  it("maps the protocol's control events", () => {
    expect(decodeLiveMessage('{"event":"ready"}')).toEqual({ event: "ready" });
    expect(decodeLiveMessage('{"event":"closed"}')).toEqual({ event: "closed" });
    expect(decodeLiveMessage('{"event":"error","detail":"Lab `l` not found."}')).toEqual({
      event: "error",
      detail: "Lab `l` not found.",
    });
    expect(decodeLiveMessage('{"event":"error"}')).toEqual({ event: "error", detail: undefined });
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an output frame without data", '{"event":"output"}'],
    ["an unknown event", '{"event":"resize","cols":80}'],
    ["a frame without an event", '{"data":"aGk="}'],
  ])("ignores %s", (_label, raw) => {
    expect(decodeLiveMessage(raw)).toBeNull();
  });
});

describe("terminalClipboardShortcut", () => {
  const press = (code: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>>, type = "keydown") => ({
    type,
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  });

  it("maps Ctrl+Shift+C and Ctrl+Shift+V to copy and paste", () => {
    expect(terminalClipboardShortcut(press("KeyC", { ctrlKey: true, shiftKey: true }))).toBe("copy");
    expect(terminalClipboardShortcut(press("KeyV", { ctrlKey: true, shiftKey: true }))).toBe("paste");
  });

  it.each([
    ["plain Ctrl+C, the shell's interrupt", press("KeyC", { ctrlKey: true })],
    ["plain Ctrl+V", press("KeyV", { ctrlKey: true })],
    ["Ctrl+Shift+Alt+C", press("KeyC", { ctrlKey: true, shiftKey: true, altKey: true })],
    ["Cmd+C, left to the terminal's own copy", press("KeyC", { metaKey: true })],
    ["another letter", press("KeyX", { ctrlKey: true, shiftKey: true })],
    ["a key release", press("KeyC", { ctrlKey: true, shiftKey: true }, "keyup")],
  ])("leaves %s alone", (_label, event) => {
    expect(terminalClipboardShortcut(event)).toBeNull();
  });
});
