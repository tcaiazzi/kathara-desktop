import { describe, expect, it } from "vitest";
import { TERMINAL_THEMES, parseTerminalThemeId, resolveTerminalTheme } from "./terminalTheme";

describe("terminal colour schemes", () => {
  it("reads every fixed scheme's id back as itself", () => {
    for (const t of TERMINAL_THEMES) expect(parseTerminalThemeId(t.id)).toBe(t.id);
  });

  it("falls back to matching the app for a missing or unknown stored value", () => {
    expect(parseTerminalThemeId(null)).toBe("app");
    expect(parseTerminalThemeId("")).toBe("app");
    expect(parseTerminalThemeId("monokai")).toBe("app");
    expect(parseTerminalThemeId("app")).toBe("app");
  });

  it("gives every fixed scheme its own background, text and cursor accent", () => {
    for (const t of TERMINAL_THEMES) {
      const theme = resolveTerminalTheme(t.id, false);
      expect(theme.background).toMatch(/^#/);
      expect(theme.foreground).toMatch(/^#/);
      expect(theme.cursorAccent).toBe(theme.background);
    }
  });

  it("resolves a fixed scheme the same in either app theme", () => {
    for (const t of TERMINAL_THEMES) {
      expect(resolveTerminalTheme(t.id, true)).toEqual(resolveTerminalTheme(t.id, false));
    }
  });
});
