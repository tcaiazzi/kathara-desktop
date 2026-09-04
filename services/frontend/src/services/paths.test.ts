import { describe, expect, it } from "vitest";
import { baseName, isSubPath, normalizeDir, remapPath } from "./paths";

describe("baseName", () => {
  it("returns the last non-empty segment", () => {
    expect(baseName("/pc1/etc/motd")).toBe("motd");
  });

  it("ignores a trailing slash", () => {
    expect(baseName("/pc1/etc/")).toBe("etc");
  });

  it("returns empty for the root", () => {
    expect(baseName("/")).toBe("");
  });
});

describe("normalizeDir", () => {
  it("strips a trailing slash", () => {
    expect(normalizeDir("/pc1/etc/")).toBe("/pc1/etc");
  });

  it("leaves a path with no trailing slash untouched", () => {
    expect(normalizeDir("/pc1/etc")).toBe("/pc1/etc");
  });

  it("treats the root as its own fixed point", () => {
    expect(normalizeDir("/")).toBe("/");
    expect(normalizeDir("")).toBe("/");
  });
});

describe("isSubPath", () => {
  it("is true for a direct child", () => {
    expect(isSubPath("/pc1/etc/motd", "/pc1/etc")).toBe(true);
  });

  it("is true for a deeper descendant", () => {
    expect(isSubPath("/pc1/etc/frr/frr.conf", "/pc1/etc")).toBe(true);
  });

  it("is false for the parent itself", () => {
    expect(isSubPath("/pc1/etc", "/pc1/etc")).toBe(false);
  });

  it("does not treat a sibling with a shared string prefix as a descendant", () => {
    // "/pc1/etcetera/x" starts with the string "/pc1/etc" but is not inside "/pc1/etc" — this is
    // the boundary case a naive `startsWith(parent)` (without appending "/") gets wrong.
    expect(isSubPath("/pc1/etcetera/x", "/pc1/etc")).toBe(false);
  });

  it("treats every non-root path as a descendant of the root", () => {
    expect(isSubPath("/pc1", "/")).toBe(true);
    expect(isSubPath("/", "/")).toBe(false);
  });
});

describe("remapPath", () => {
  it("maps the renamed path itself", () => {
    expect(remapPath("/pc1/etc", "/pc1/etc", "/pc1/conf")).toBe("/pc1/conf");
  });

  it("maps a direct child of a renamed directory", () => {
    // This is F2: movePath used to repair the selection only on an exact match, so a rename of
    // the directory a selected/open file lived in left the selection pointing at a dead path.
    expect(remapPath("/pc1/etc/motd", "/pc1/etc", "/pc1/conf")).toBe("/pc1/conf/motd");
  });

  it("maps a deeper descendant, preserving the whole relative path", () => {
    expect(remapPath("/pc1/etc/frr/frr.conf", "/pc1/etc", "/pc1/conf")).toBe("/pc1/conf/frr/frr.conf");
  });

  it("returns null for a path unrelated to the move", () => {
    expect(remapPath("/pc1/other", "/pc1/etc", "/pc1/conf")).toBe(null);
  });

  it("returns null for a sibling that merely shares a string prefix", () => {
    expect(remapPath("/pc1/etcetera/x", "/pc1/etc", "/pc1/conf")).toBe(null);
  });

  it("handles a rename that only changes the last segment", () => {
    expect(remapPath("/pc1/etc/x", "/pc1/etc", "/pc1/etc2")).toBe("/pc1/etc2/x");
  });

  it("is indifferent to a trailing slash on `from` or `to`", () => {
    expect(remapPath("/pc1/etc/motd", "/pc1/etc/", "/pc1/conf/")).toBe("/pc1/conf/motd");
  });

  it("handles moving out of the root", () => {
    expect(remapPath("/notes.txt", "/", "/archive")).toBe("/archive/notes.txt");
  });

  it("handles moving into the root", () => {
    expect(remapPath("/pc1/etc/motd", "/pc1/etc", "/")).toBe("/motd");
  });
});
