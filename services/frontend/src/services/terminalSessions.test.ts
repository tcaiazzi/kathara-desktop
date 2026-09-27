import { describe, expect, it } from "vitest";
import { sessionOfTerminalPanel, terminalPanelId, terminalTitle } from "./terminalSessions";

describe("terminal panel ids", () => {
  it("round-trip a session id through its panel id", () => {
    expect(sessionOfTerminalPanel(terminalPanelId("r1:3"))).toEqual({ id: "r1:3", machine: "r1", num: 3 });
  });

  it("take only the last segment as the instance number, so a device name may contain a colon", () => {
    expect(sessionOfTerminalPanel("terminal:a:b:12")).toEqual({ id: "a:b:12", machine: "a:b", num: 12 });
  });

  it("belong to no session for any other panel", () => {
    expect(sessionOfTerminalPanel("topology")).toBeNull();
    expect(sessionOfTerminalPanel("terminals")).toBeNull();
    expect(sessionOfTerminalPanel("terminal:r1")).toBeNull();
  });

  it("title a session by device and instance number", () => {
    expect(terminalTitle({ id: "pc1:2", machine: "pc1", num: 2 })).toBe("pc1 #2");
  });
});
