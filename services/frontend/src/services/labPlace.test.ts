import { describe, expect, it } from "vitest";
import { labFolderHint } from "./labPlace";

describe("labFolderHint", () => {
  it.each([
    ["/home/u/work/net/ospf", "…/work/net"],
    ["/home/u/ospf", "/home/u"],
    ["/work/ospf", "/work"],
    ["/ospf", "/"],
    ["/home/u/work/net/ospf/", "…/work/net"],
  ])("shows the last two segments of %s's parent", (path, hint) => {
    expect(labFolderHint(path)).toBe(hint);
  });

  it.each([
    ["C:\\Users\\u\\labs\\ospf", "…\\u\\labs"],
    ["C:\\labs\\ospf", "C:\\labs"],
    ["\\\\server\\share\\ospf", "\\server\\share"],
  ])("keeps a Windows path's separator for %s", (path, hint) => {
    expect(labFolderHint(path)).toBe(hint);
  });
});
