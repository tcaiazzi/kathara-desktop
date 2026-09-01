// Shared model for the two lazily-loaded filesystem trees (the lab's own directory in
// LabExplorer, a running device's filesystem in RuntimeFilesystemEditor). Pure functions only —
// the state machine around them lives in hooks/useFsTree.ts.

import { isSubPath } from "./paths";
import type { FsEntry } from "./types";

// One node in the tree. `children` is `undefined` until this directory has been listed at least
// once — react-arborist still renders it as expandable (an empty array already counts as
// "internal", see NodeApi.isLeaf), so the very first expand click is what triggers the fetch.
export interface FsNode {
  name: string;
  path: string;
  dir: boolean;
  children?: FsNode[];
}

export function entryToNode(e: FsEntry): FsNode {
  return { name: e.name, path: e.path, dir: e.is_dir };
}

export function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

export function findNode(nodes: FsNode[], path: string): FsNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children && isSubPath(path, n.path)) {
      const found = findNode(n.children, path);
      if (found) return found;
    }
  }
  return null;
}

// Replace `oldNodes` with `freshNodes` from a listing, but carry over any already-loaded
// `children` for a directory that's still present — so a background refresh never collapses an
// already-expanded subfolder or throws away what it had loaded.
export function mergeNodeList(oldNodes: FsNode[], freshNodes: FsNode[]): FsNode[] {
  return freshNodes
    .map((fresh) => {
      const old = oldNodes.find((o) => o.path === fresh.path);
      return old && fresh.dir && old.dir ? { ...fresh, children: old.children } : fresh;
    })
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
}

export function withMergedChildrenAt(nodes: FsNode[], path: string, freshChildren: FsNode[]): FsNode[] {
  return nodes.map((n) => {
    if (n.path === path) return { ...n, children: mergeNodeList(n.children ?? [], freshChildren) };
    if (n.children && isSubPath(path, n.path)) {
      return { ...n, children: withMergedChildrenAt(n.children, path, freshChildren) };
    }
    return n;
  });
}

// A path typed into a prompt, normalized to a single leading slash and no trailing one. Returns
// null for anything that would resolve to the root itself (empty, "/", "///") — there is nothing
// meaningful to create, upload or move there.
export function toAbsolutePath(raw: string): string | null {
  const clean = `/${raw.trim().replace(/^\/+/, "").replace(/\/+$/, "")}`;
  return clean === "/" ? null : clean;
}
