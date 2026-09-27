import { describe, expect, it } from "vitest";
import {
  MIN_PANE_SHARE,
  activeAfterRemoval,
  addGroup,
  dropSide,
  leafIds,
  loadTree,
  moveBeside,
  panePlace,
  removeFrom,
  resizeIn,
  resizePair,
  saveTree,
  splitIn,
  type SplitNode,
  type TerminalGroup,
} from "./terminalSplits";

const one = (id: string): TerminalGroup => ({ id, root: { kind: "leaf", id } });

describe("splitIn", () => {
  it("turns a lone pane into a split of it and the new one, half each", () => {
    expect(splitIn([one("a")], "a", "b", "row")[0].root).toEqual({
      kind: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "leaf", id: "a" },
        { kind: "leaf", id: "b" },
      ],
    });
  });

  it("adds to a split of the same direction after the target, halving the target's share", () => {
    const groups = splitIn(splitIn([one("a")], "a", "b", "row"), "a", "c", "row");
    const root = groups[0].root;
    expect(leafIds(root)).toEqual(["a", "c", "b"]);
    expect(root).toMatchObject({ direction: "row", sizes: [0.25, 0.25, 0.5] });
  });

  it("nests a split of the other direction in place of the target", () => {
    const root = splitIn(splitIn([one("a")], "a", "b", "row"), "b", "c", "column")[0].root;
    expect(root).toMatchObject({
      direction: "row",
      children: [{ kind: "leaf", id: "a" }, { kind: "split", direction: "column" }],
    });
    expect(leafIds(root)).toEqual(["a", "b", "c"]);
  });

  it("leaves the other groups alone, and every group when the target is in none", () => {
    const groups = [one("a"), one("x")];
    expect(splitIn(groups, "a", "b", "row")[1]).toBe(groups[1]);
    expect(splitIn(groups, "nope", "b", "row")).toEqual(groups);
  });
});

describe("dropSide", () => {
  it("picks the edge nearest the point, relative to each side's length", () => {
    expect(dropSide(10, 50, 400, 100)).toBe("left");
    expect(dropSide(390, 50, 400, 100)).toBe("right");
    expect(dropSide(200, 10, 400, 100)).toBe("top");
    expect(dropSide(200, 90, 400, 100)).toBe("bottom");
  });

  it("divides a wide pane along its diagonals, not by pixels from each edge", () => {
    // 60px from the left edge but 40px from the top, in a 400 x 100 pane: 15% across, 40% down.
    expect(dropSide(60, 40, 400, 100)).toBe("left");
  });
});

describe("moveBeside", () => {
  it("moves a lone terminal into another group, on the side it was dropped against", () => {
    const groups = moveBeside([one("a"), one("b")], "b", "a", "left");
    expect(groups).toHaveLength(1);
    expect(groups[0].root).toMatchObject({ direction: "row", sizes: [0.5, 0.5] });
    expect(leafIds(groups[0].root)).toEqual(["b", "a"]);
  });

  it("stacks for the top and bottom edges, before and after the target", () => {
    expect(leafIds(moveBeside([one("a"), one("b")], "b", "a", "top")[0].root)).toEqual(["b", "a"]);
    const below = moveBeside([one("a"), one("b")], "b", "a", "bottom")[0].root;
    expect(below).toMatchObject({ direction: "column" });
    expect(leafIds(below)).toEqual(["a", "b"]);
  });

  it("closes up the group the terminal leaves, which lives on under its id", () => {
    const groups = moveBeside([...splitIn([one("a")], "a", "b", "row"), one("c")], "a", "c", "right");
    expect(groups).toEqual([
      { id: "a", root: { kind: "leaf", id: "b" } },
      { id: "c", root: expect.objectContaining({ direction: "row" }) },
    ]);
    expect(leafIds(groups[1].root)).toEqual(["c", "a"]);
  });

  it("rearranges panes within one group", () => {
    const groups = moveBeside(splitIn([one("a")], "a", "b", "row"), "a", "b", "bottom");
    expect(groups).toHaveLength(1);
    expect(groups[0].root).toMatchObject({ direction: "column" });
    expect(leafIds(groups[0].root)).toEqual(["b", "a"]);
  });

  it("leaves the groups as they are for a pane dropped on itself, or a target in none", () => {
    const groups = [one("a"), one("b")];
    expect(moveBeside(groups, "a", "a", "left")).toBe(groups);
    expect(moveBeside(groups, "a", "nope", "left")).toBe(groups);
  });
});

describe("removeFrom", () => {
  it("collapses a split left with one pane into that pane", () => {
    const groups = removeFrom(splitIn([one("a")], "a", "b", "row"), "b");
    expect(groups).toEqual([one("a")]);
  });

  it("gives the removed pane's share to the others in proportion", () => {
    const three = splitIn(splitIn([one("a")], "a", "b", "row"), "a", "c", "row");
    const root = removeFrom(three, "b")[0].root;
    expect(root).toMatchObject({ sizes: [0.5, 0.5] });
    expect(leafIds(root)).toEqual(["a", "c"]);
  });

  it("drops a group left empty", () => {
    expect(removeFrom([one("a"), one("b")], "a")).toEqual([one("b")]);
  });
});

describe("activeAfterRemoval", () => {
  const groups = [...splitIn([one("a")], "a", "b", "row"), one("c"), one("d")];

  it("keeps the selection when another pane goes", () => {
    expect(activeAfterRemoval(groups, "a", "c")).toBe("c");
  });

  it("stays in the group when it has panes left", () => {
    expect(activeAfterRemoval(groups, "a", "a")).toBe("b");
    expect(activeAfterRemoval(groups, "b", "b")).toBe("a");
  });

  it("moves to the group that took the gone group's place, else the one before", () => {
    expect(activeAfterRemoval(groups, "c", "c")).toBe("d");
    expect(activeAfterRemoval(groups, "d", "d")).toBe("c");
  });

  it("leaves nothing selected when the last pane goes", () => {
    expect(activeAfterRemoval([one("a")], "a", "a")).toBeNull();
  });
});

describe("resizing", () => {
  it("moves only the two panes beside the divider", () => {
    expect(resizePair([0.25, 0.25, 0.5], 1, 0.1)).toEqual([0.25, 0.35, 0.4]);
  });

  it("keeps each of those two panes at least the minimum share", () => {
    const [first, second] = resizePair([0.5, 0.5], 0, -1);
    expect(first).toBeCloseTo(MIN_PANE_SHARE);
    expect(second).toBeCloseTo(1 - MIN_PANE_SHARE);
  });

  it("sets the sizes of the split at a path", () => {
    const nested = splitIn(splitIn([one("a")], "a", "b", "row"), "b", "c", "column");
    const root = resizeIn(nested, "a", [1], [0.2, 0.8])[0].root as Extract<SplitNode, { kind: "split" }>;
    expect(root.sizes).toEqual([0.5, 0.5]);
    expect(root.children[1]).toMatchObject({ sizes: [0.2, 0.8] });
  });
});

describe("saving and loading a tree", () => {
  it("round-trips a nested tree", () => {
    const root = splitIn(splitIn([one("a:1")], "a:1", "b:1", "row"), "b:1", "c:2", "column")[0].root;
    const saved = saveTree(root, (id) => ({ machine: id.split(":")[0], num: Number(id.split(":")[1]) }));
    const loaded = loadTree(JSON.parse(JSON.stringify(saved)), (m, n) => `${m}:${n}`);
    expect(loaded).toEqual(root);
  });
});

describe("group bookkeeping", () => {
  it("gives a new group an id no other group holds, which resizing finds it by", () => {
    // "a" has left the group it created, which keeps its id; "a" coming back needs another.
    const left = moveBeside([...splitIn([one("a")], "a", "b", "row"), one("c")], "a", "c", "right");
    const back = addGroup(removeFrom(left, "a"), "a");
    expect(back.map((g) => g.id)).toEqual(["a", "c", "a/2"]);
    expect(leafIds(back[2].root)).toEqual(["a"]);
  });
});

describe("panePlace", () => {
  it("brackets a group of several from its first pane to its last", () => {
    expect([0, 1, 2].map((i) => panePlace(i, 3))).toEqual(["first", "middle", "last"]);
    expect([0, 1].map((i) => panePlace(i, 2))).toEqual(["first", "last"]);
  });

  it("leaves a group of one unbracketed", () => {
    expect(panePlace(0, 1)).toBeNull();
  });
});
