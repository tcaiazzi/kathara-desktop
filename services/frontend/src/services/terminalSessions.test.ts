import { describe, expect, it } from "vitest";
import {
  LIST_WIDTH,
  clampListWidth,
  isDropIntoTerminalsTab,
  storedListWidth,
  parseTerminalsTabParams,
  sessionOfId,
  sessionOfTerminalPanel,
  terminalPanelId,
  terminalSession,
  terminalsTabParams,
  terminalTitle,
} from "./terminalSessions";
import type { TerminalGroup } from "./terminalSplits";

describe("terminal panel ids", () => {
  it("round-trip a session id through its panel id", () => {
    expect(sessionOfTerminalPanel(terminalPanelId("r1:3"))).toEqual({ id: "r1:3", machine: "r1", num: 3 });
  });

  it("take only the last segment as the instance number, so a device name may contain a colon", () => {
    expect(sessionOfTerminalPanel("terminal:a:b:12")).toEqual({ id: "a:b:12", machine: "a:b", num: 12 });
  });

  it("read a bare session id the same way", () => {
    expect(sessionOfId("a:b:12")).toEqual({ id: "a:b:12", machine: "a:b", num: 12 });
    expect(sessionOfId("r1")).toBeNull();
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
  const groups: TerminalGroup[] = [
    { id: "r1:1", root: { kind: "leaf", id: "r1:1" } },
    {
      id: "pc1:4",
      root: {
        kind: "split",
        direction: "row",
        sizes: [0.3, 0.7],
        children: [
          { kind: "leaf", id: "pc1:4" },
          {
            kind: "split",
            direction: "column",
            sizes: [0.5, 0.5],
            children: [
              { kind: "leaf", id: "pc2:1" },
              { kind: "leaf", id: "pc1:5" },
            ],
          },
        ],
      },
    },
  ];

  it("read back exactly the split groups they wrote", () => {
    const params = JSON.parse(JSON.stringify(terminalsTabParams(groups, "pc2:1")));
    const read = parseTerminalsTabParams(params);
    expect(read.groups).toEqual(groups);
    expect(read.activeId).toBe("pc2:1");
    expect(read.sessions.map((s) => s.id)).toEqual(["r1:1", "pc1:4", "pc2:1", "pc1:5"]);
  });

  it("read as empty when the tab has no params at all", () => {
    expect(parseTerminalsTabParams(undefined)).toEqual({ sessions: [], groups: [], activeId: null });
    expect(parseTerminalsTabParams({})).toEqual({ sessions: [], groups: [], activeId: null });
  });

  it("read the flat session list of params from before split groups as one group each", () => {
    const read = parseTerminalsTabParams({ sessions: [{ machine: "r1", num: 1 }, { machine: "r2", num: 3 }], activeId: "r2:3" });
    expect(read.groups).toEqual([
      { id: "r1:1", root: { kind: "leaf", id: "r1:1" } },
      { id: "r2:3", root: { kind: "leaf", id: "r2:3" } },
    ]);
    expect(read.activeId).toBe("r2:3");
  });

  it("drop malformed and duplicate leaves, collapsing a split left with one pane", () => {
    const params = {
      groups: [
        { direction: "row", sizes: [0.5, 0.5], children: [{ machine: "r1", num: 1 }, { machine: "", num: 2 }] },
        { machine: "r1", num: 1 },
        "x",
        { machine: "r3", num: 2 },
      ],
      activeId: "r3:2",
    };
    const read = parseTerminalsTabParams(params);
    expect(read.groups).toEqual([
      { id: "r1:1", root: { kind: "leaf", id: "r1:1" } },
      { id: "r3:2", root: { kind: "leaf", id: "r3:2" } },
    ]);
    expect(read.activeId).toBe("r3:2");
  });

  it("even out sizes that do not fit their panes", () => {
    const params = { groups: [{ direction: "column", sizes: [1], children: [{ machine: "a", num: 1 }, { machine: "b", num: 1 }] }] };
    const root = parseTerminalsTabParams(params).groups[0].root;
    expect(root).toMatchObject({ kind: "split", direction: "column", sizes: [0.5, 0.5] });
  });

  it("fall back to the first session when the active one is not among them", () => {
    expect(parseTerminalsTabParams({ groups: [{ machine: "r1", num: 1 }], activeId: "gone:9" }).activeId).toBe("r1:1");
    expect(parseTerminalsTabParams({ groups: [], activeId: "gone:9" }).activeId).toBeNull();
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

describe("the list width", () => {
  it("stays within its bounds, in whole pixels", () => {
    expect(clampListWidth(10)).toBe(LIST_WIDTH.min);
    expect(clampListWidth(9999)).toBe(LIST_WIDTH.max);
    expect(clampListWidth(212.6)).toBe(213);
  });

  it("reads back a remembered width, clamped, and the initial one for anything else", () => {
    expect(storedListWidth("250")).toBe(250);
    expect(storedListWidth("5000")).toBe(LIST_WIDTH.max);
    expect(storedListWidth(null)).toBe(LIST_WIDTH.initial);
    expect(storedListWidth("wide")).toBe(LIST_WIDTH.initial);
  });
});
