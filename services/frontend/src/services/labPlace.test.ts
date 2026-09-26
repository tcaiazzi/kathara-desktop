import { describe, expect, it } from "vitest";
import { labFolder, labNamed } from "./labPlace";
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

describe("labFolder", () => {
  it.each([
    ["/home/u/work/net/ospf", "/home/u/work/net"],
    ["/home/u/work/net/ospf/", "/home/u/work/net"],
    ["/work/ospf", "/work"],
    ["/ospf", "/"],
  ])("shows the whole parent of %s", (path, folder) => {
    expect(labFolder(path)).toBe(folder);
  });

  it.each([
    ["C:\\Users\\u\\labs\\ospf", "C:\\Users\\u\\labs"],
    ["C:\\labs\\ospf", "C:\\labs"],
    ["C:\\ospf", "C:\\"],
    ["\\\\server\\share\\ospf", "\\\\server\\share"],
  ])("keeps a Windows path's separator for %s", (path, folder) => {
    expect(labFolder(path)).toBe(folder);
  });

  it("has nothing to show for a bare name", () => {
    expect(labFolder("ospf")).toBe("");
  });

  it.each([
    ["/home/u/work/net/ospf", "/home/u", "~/work/net"],
    ["/home/u/ospf", "/home/u", "~"],
    ["/home/u/ospf", "/home/u/", "~"],
    ["/home/user2/ospf", "/home/u", "/home/user2"],
    ["/srv/labs/ospf", "/home/u", "/srv/labs"],
    ["/work/ospf", "/", "/work"],
    ["C:\\Users\\u\\labs\\ospf", "C:\\Users\\u", "~\\labs"],
    ["C:\\labs\\ospf", "C:\\", "C:\\labs"],
  ])("shows %s under home %s as %s", (path, home, folder) => {
    expect(labFolder(path, home)).toBe(folder);
  });
});
