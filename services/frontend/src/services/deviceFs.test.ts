import { describe, expect, it } from "vitest";
import { fromLabPath, isSharedPath, toLabPath, withSharedFolder } from "./deviceFs";
import type { FsEntry } from "./types";

function entry(path: string, isDir: boolean): FsEntry {
  return { name: path.split("/").pop() ?? "", path, is_dir: isDir, size: null, mode: null, mtime: null };
}

describe("toLabPath", () => {
  it("puts the device's folder in front of the path", () => {
    expect(toLabPath("pc1", "/etc/motd")).toBe("/pc1/etc/motd");
  });

  it("maps the device's root to its folder", () => {
    expect(toLabPath("pc1", "/")).toBe("/pc1");
    expect(toLabPath("pc1", "")).toBe("/pc1");
  });

  it("leaves /shared and what is under it as the lab's shared folder", () => {
    expect(toLabPath("pc1", "/shared")).toBe("/shared");
    expect(toLabPath("pc1", "/shared/notes.txt")).toBe("/shared/notes.txt");
  });

  it("keeps a name that only starts with shared inside the device's folder", () => {
    expect(toLabPath("pc1", "/sharedx")).toBe("/pc1/sharedx");
  });
});

describe("isSharedPath", () => {
  it("is the shared folder and everything under it, nothing else", () => {
    expect(isSharedPath("/shared")).toBe(true);
    expect(isSharedPath("/shared/a/b")).toBe(true);
    expect(isSharedPath("/sharedx")).toBe(false);
    expect(isSharedPath("/etc/shared")).toBe(false);
  });
});

describe("fromLabPath", () => {
  it("strips the device's folder", () => {
    expect(fromLabPath("pc1", "/pc1/etc/motd")).toBe("/etc/motd");
    expect(fromLabPath("pc1", "/pc1")).toBe("/");
  });

  it("round-trips with toLabPath", () => {
    expect(fromLabPath("r1", toLabPath("r1", "/etc/frr/frr.conf"))).toBe("/etc/frr/frr.conf");
  });

  it("refuses a path outside the folder, including another device's with the same prefix", () => {
    expect(() => fromLabPath("pc1", "/pc10/etc")).toThrow();
    expect(() => fromLabPath("pc1", "/pc1.startup")).toThrow();
    expect(() => fromLabPath("pc1", "/sharedx")).toThrow();
  });

  it("keeps a path in the lab's shared folder as it is", () => {
    expect(fromLabPath("pc1", "/shared")).toBe("/shared");
    expect(fromLabPath("pc1", "/shared/a/notes.txt")).toBe("/shared/a/notes.txt");
  });
});

describe("withSharedFolder", () => {
  it("adds /shared as a folder", () => {
    const listing = withSharedFolder([entry("/etc", true), entry("/motd", false)]);
    expect(listing.map((e) => e.path)).toEqual(["/etc", "/motd", "/shared"]);
    expect(listing[2].is_dir).toBe(true);
  });

  it("is there when the device has no files at all", () => {
    expect(withSharedFolder([]).map((e) => e.path)).toEqual(["/shared"]);
  });

  it("stands in for the device's own shared entry", () => {
    const listing = withSharedFolder([entry("/etc", true), { ...entry("/shared", true), size: 4096 }]);
    expect(listing.map((e) => e.path)).toEqual(["/etc", "/shared"]);
    expect(listing[1].size).toBeNull();
  });
});
