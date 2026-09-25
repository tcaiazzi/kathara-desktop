import { describe, expect, it } from "vitest";
import { labFolderHint, labNamed } from "./labPlace";
import type { LabSummary } from "./types";

function lab(id: string, name: string, managed: boolean, problem: string | null = null): LabSummary {
  return { id, name, managed, problem, path: `/x/${name}`, n_machines: 0, n_links: 0, deployed: false };
}

describe("labNamed", () => {
  it("prefers the lab under the labs root to an opened folder of the same name", () => {
    expect(labNamed([lab("a", "ospf", false), lab("b", "ospf", true)], "ospf")?.id).toBe("b");
  });

  it("falls back to an opened folder, and never to one that isn't loaded", () => {
    expect(labNamed([lab("a", "ospf", false)], "ospf")?.id).toBe("a");
    expect(labNamed([lab("a", "ospf", false, "missing")], "ospf")).toBeUndefined();
    expect(labNamed([lab("a", "bgp", true)], "ospf")).toBeUndefined();
  });
});

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
