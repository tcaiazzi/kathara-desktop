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

/** A pending Copy or Cut, holding the paths it was taken from. */
export interface FsClipboard {
  paths: string[];
  mode: "copy" | "cut";
}

/**
 * Everything hooks/useFsTree.ts derives from its `scopeKey` (lab name, or lab+device) and needs to
 * read *synchronously* inside a callback — never only through React state, which only lands after
 * the render that scheduled it. Grouped into one type, reset by replacing the whole object, rather
 * than one ref per field: a field that isn't part of this type can't be left out of a reset the
 * way `selectGen` used to be — declared, incremented and compared far from the rest of the
 * per-scope refs, and *not* among them when a scope change cleared everything else. That let a
 * still-in-flight read from a *previous* device's filesystem land under a newly selected one.
 */
export interface FsTreeScopeState {
  tree: FsNode[];
  /** Dedupes react-arborist's own double-firing of a single click's selection event. */
  pendingSelect: string | null;
  selected: string | null;
  selectedPaths: string[];
  clipboard: FsClipboard | null;
  /** Bumped by every selectDir/selectFile/onTreeSelect call; invalidates a still-in-flight one. */
  selectGen: number;
  /**
   * The path whose content `editorText`/`loadedText` actually hold. Not always `selected` — e.g.
   * a multi-selection moves `selected` without touching the buffer (there's nothing of theirs to
   * show), and a slow file read still in flight hasn't claimed it yet. Saving, and the
   * discard-confirmation prompt, both act on *this*, never on `selected` directly.
   */
  bufferPath: string | null;
}

/**
 * A fresh, empty `FsTreeScopeState` — a new object (arrays included) on every call, so two scopes
 * never end up sharing the same array underneath.
 */
export function freshScopeState(): FsTreeScopeState {
  return {
    tree: [],
    pendingSelect: null,
    selected: null,
    selectedPaths: [],
    clipboard: null,
    selectGen: 0,
    bufferPath: null,
  };
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
