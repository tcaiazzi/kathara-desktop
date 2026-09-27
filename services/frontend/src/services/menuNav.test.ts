import { describe, expect, it } from "vitest";
import { adjacentMenu, firstFocusable, lastFocusable, nextFocusable } from "./menuNav";

// item, separator, item, disabled item, item
const MENU = [true, false, true, false, true];

describe("nextFocusable", () => {
  it("skips separators and disabled items", () => {
    expect(nextFocusable(MENU, 0, 1)).toBe(2);
    expect(nextFocusable(MENU, 2, 1)).toBe(4);
    expect(nextFocusable(MENU, 4, -1)).toBe(2);
  });

  it("wraps around at either end", () => {
    expect(nextFocusable(MENU, 4, 1)).toBe(0);
    expect(nextFocusable(MENU, 0, -1)).toBe(4);
  });

  it("starts from the first item going down, the last going up, when nothing is focused", () => {
    expect(nextFocusable(MENU, -1, 1)).toBe(0);
    expect(nextFocusable(MENU, -1, -1)).toBe(4);
  });

  it("answers -1 when nothing can take focus", () => {
    expect(nextFocusable([], 0, 1)).toBe(-1);
    expect(nextFocusable([false, false], 0, 1)).toBe(-1);
  });

  it("stays on the only focusable item", () => {
    expect(nextFocusable([false, true, false], 1, 1)).toBe(1);
  });
});

describe("firstFocusable / lastFocusable", () => {
  it("finds the first and the last item that can take focus", () => {
    expect(firstFocusable([false, true, true])).toBe(1);
    expect(lastFocusable([true, true, false])).toBe(1);
  });
});

describe("adjacentMenu", () => {
  it("moves between menus and wraps", () => {
    expect(adjacentMenu(4, 1, 1)).toBe(2);
    expect(adjacentMenu(4, 3, 1)).toBe(0);
    expect(adjacentMenu(4, 0, -1)).toBe(3);
  });
});
