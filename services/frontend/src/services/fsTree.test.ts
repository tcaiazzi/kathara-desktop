import { describe, expect, it } from "vitest";
import {
  entryToNode,
  findNode,
  freshScopeState,
  mergeNodeList,
  parentOf,
  toAbsolutePath,
  withMergedChildrenAt,
  type FsNode,
} from "./fsTree";
import type { FsEntry } from "./types";

describe("freshScopeState", () => {
  it("starts every field empty", () => {
    expect(freshScopeState()).toEqual({
      tree: [],
      pendingSelect: null,
      selected: null,
      selectedPaths: [],
      clipboard: null,
      selectGen: 0,
      bufferPath: null,
    });
  });

  it("gives every call its own arrays, never a shared one", () => {
    // This is the F3 regression test: a scope reset replaces `scoped.current` wholesale with a
    // fresh call to this factory. If two calls returned the same `tree`/`selectedPaths` array,
    // mutating one scope's state (e.g. `scoped.current.selectedPaths.push(...)`, which several
    // call sites in the hook do indirectly via `setSelectedPaths`-derived reads) would leak into
    // every other scope that had ever been reset, defeating the whole point of resetting at all.
    const a = freshScopeState();
    const b = freshScopeState();
    expect(a.tree).not.toBe(b.tree);
    expect(a.selectedPaths).not.toBe(b.selectedPaths);
    a.tree.push({ name: "x", path: "/x", dir: false });
    a.selectedPaths.push("/x");
    expect(b.tree).toEqual([]);
    expect(b.selectedPaths).toEqual([]);
  });
});

describe("entryToNode", () => {
  it("carries over name/path/dir and nothing else", () => {
    const entry: FsEntry = { name: "etc", path: "/pc1/etc", is_dir: true, size: 4096, mode: null, mtime: null };
    expect(entryToNode(entry)).toEqual({ name: "etc", path: "/pc1/etc", dir: true });
  });
});

describe("parentOf", () => {
  it("returns the containing directory", () => {
    expect(parentOf("/pc1/etc/motd")).toBe("/pc1/etc");
  });

  it("returns the root for a top-level entry", () => {
    expect(parentOf("/pc1")).toBe("/");
  });
});

function file(name: string, path: string): FsNode {
  return { name, path, dir: false };
}
function dir(name: string, path: string, children?: FsNode[]): FsNode {
  return { name, path, dir: true, children };
}

describe("findNode", () => {
  const tree: FsNode[] = [dir("pc1", "/pc1", [file("motd", "/pc1/motd")]), file("notes.txt", "/notes.txt")];

  it("finds a top-level node", () => {
    expect(findNode(tree, "/notes.txt")).toEqual(file("notes.txt", "/notes.txt"));
  });

  it("finds a node inside an already-loaded directory", () => {
    expect(findNode(tree, "/pc1/motd")).toEqual(file("motd", "/pc1/motd"));
  });

  it("returns null for a path under a directory that hasn't been listed yet", () => {
    const unloaded: FsNode[] = [dir("pc1", "/pc1")]; // children === undefined
    expect(findNode(unloaded, "/pc1/motd")).toBe(null);
  });

  it("returns null for an unknown path", () => {
    expect(findNode(tree, "/nope")).toBe(null);
  });
});

describe("mergeNodeList", () => {
  it("carries over already-loaded children for a directory still present in the fresh listing", () => {
    const old = [dir("pc1", "/pc1", [file("motd", "/pc1/motd")])];
    const fresh = [dir("pc1", "/pc1")]; // a re-list of the parent, children not re-fetched
    expect(mergeNodeList(old, fresh)).toEqual([dir("pc1", "/pc1", [file("motd", "/pc1/motd")])]);
  });

  it("does not carry children over to a path that is no longer a directory", () => {
    const old = [dir("pc1", "/pc1", [file("motd", "/pc1/motd")])];
    const fresh = [file("pc1", "/pc1")]; // same path, now reported as a file
    expect(mergeNodeList(old, fresh)).toEqual([file("pc1", "/pc1")]);
  });

  it("sorts directories before files, then alphabetically", () => {
    const fresh = [file("b.txt", "/b.txt"), dir("z", "/z"), dir("a", "/a"), file("a.txt", "/a.txt")];
    expect(mergeNodeList([], fresh).map((n) => n.path)).toEqual(["/a", "/z", "/a.txt", "/b.txt"]);
  });
});

describe("withMergedChildrenAt", () => {
  it("installs children at the target path", () => {
    const tree = [dir("pc1", "/pc1")];
    const result = withMergedChildrenAt(tree, "/pc1", [file("motd", "/pc1/motd")]);
    expect(result).toEqual([dir("pc1", "/pc1", [file("motd", "/pc1/motd")])]);
  });

  it("recurses into an already-loaded ancestor to reach a nested target", () => {
    const tree = [dir("pc1", "/pc1", [dir("etc", "/pc1/etc")])];
    const result = withMergedChildrenAt(tree, "/pc1/etc", [file("motd", "/pc1/etc/motd")]);
    expect(result).toEqual([dir("pc1", "/pc1", [dir("etc", "/pc1/etc", [file("motd", "/pc1/etc/motd")])])]);
  });

  it("leaves an unrelated subtree untouched", () => {
    const tree = [dir("pc1", "/pc1", [file("motd", "/pc1/motd")]), dir("pc2", "/pc2")];
    const result = withMergedChildrenAt(tree, "/pc2", [file("hosts", "/pc2/hosts")]);
    expect(result[0]).toEqual(dir("pc1", "/pc1", [file("motd", "/pc1/motd")]));
  });
});

describe("toAbsolutePath", () => {
  it("adds a leading slash and strips a trailing one", () => {
    expect(toAbsolutePath("pc1/etc/motd/")).toBe("/pc1/etc/motd");
  });

  it("collapses repeated leading slashes", () => {
    expect(toAbsolutePath("///pc1")).toBe("/pc1");
  });

  it("trims surrounding whitespace", () => {
    expect(toAbsolutePath("  /pc1  ")).toBe("/pc1");
  });

  it("returns null for anything that resolves to the root", () => {
    expect(toAbsolutePath("")).toBe(null);
    expect(toAbsolutePath("/")).toBe(null);
    expect(toAbsolutePath("///")).toBe(null);
  });
});
