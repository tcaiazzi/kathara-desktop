import { describe, expect, it } from "vitest";
import {
  activeAfterClose,
  isDropIntoTerminalsTab,
  parseTerminalsTabParams,
  sessionOfTerminalPanel,
  terminalPanelId,
  terminalSession,
  terminalsTabParams,
  terminalTitle,
} from "./terminalSessions";

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
    expect(terminalTitle(terminalSession("pc1", 2))).toBe("pc1 #2");
  });
});

describe("Terminals tab params", () => {
  const sessions = [terminalSession("r1", 1), terminalSession("pc1", 4)];

  it("read back exactly what they wrote", () => {
    const params = JSON.parse(JSON.stringify(terminalsTabParams(sessions, "pc1:4")));
    expect(parseTerminalsTabParams(params)).toEqual({ sessions, activeId: "pc1:4" });
  });

  it("read as empty when the tab has no params at all", () => {
    expect(parseTerminalsTabParams(undefined)).toEqual({ sessions: [], activeId: null });
    expect(parseTerminalsTabParams({})).toEqual({ sessions: [], activeId: null });
  });

  it("drop malformed and duplicate sessions and keep the rest in order", () => {
    const params = {
      sessions: [{ machine: "r1", num: 1 }, { machine: "", num: 2 }, { machine: "r2", num: 0 }, "x", { machine: "r1", num: 1 }, { machine: "r3", num: 2 }],
      activeId: "r3:2",
    };
    expect(parseTerminalsTabParams(params)).toEqual({
      sessions: [terminalSession("r1", 1), terminalSession("r3", 2)],
      activeId: "r3:2",
    });
  });

  it("fall back to the first session when the active one is not among them", () => {
    expect(parseTerminalsTabParams({ sessions: [{ machine: "r1", num: 1 }], activeId: "gone:9" }).activeId).toBe("r1:1");
    expect(parseTerminalsTabParams({ sessions: [], activeId: "gone:9" }).activeId).toBeNull();
  });
});

describe("activeAfterClose", () => {
  const ids = ["a", "b", "c"];

  it("keeps the active session when another one closes", () => {
    expect(activeAfterClose(ids, "a", "b")).toBe("b");
  });

  it("moves to the session that took the closed one's place", () => {
    expect(activeAfterClose(ids, "b", "b")).toBe("c");
  });

  it("moves to the one before when the last one closes", () => {
    expect(activeAfterClose(ids, "c", "c")).toBe("b");
  });

  it("leaves nothing active when the only session closes", () => {
    expect(activeAfterClose(["a"], "a", "a")).toBeNull();
  });
});

describe("isDropIntoTerminalsTab", () => {
  it("takes a drop onto the Terminals tab itself", () => {
    expect(isDropIntoTerminalsTab({ kind: "tab", position: "center", targetPanelId: "terminals" })).toBe(true);
  });

  it("takes a drop onto the middle of the Terminals tab's content while it shows", () => {
    expect(isDropIntoTerminalsTab({ kind: "content", position: "center", activePanelId: "terminals" })).toBe(true);
  });

  it("leaves an edge of that content to split, as for any panel", () => {
    expect(isDropIntoTerminalsTab({ kind: "content", position: "right", activePanelId: "terminals" })).toBe(false);
  });

  it("leaves drops on any other tab, group or header space alone", () => {
    expect(isDropIntoTerminalsTab({ kind: "tab", position: "center", targetPanelId: "topology" })).toBe(false);
    expect(isDropIntoTerminalsTab({ kind: "content", position: "center", activePanelId: "devices" })).toBe(false);
    expect(isDropIntoTerminalsTab({ kind: "header_space", position: "center", activePanelId: "terminals" })).toBe(false);
  });
});
