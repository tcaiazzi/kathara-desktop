// The Terminals tab's split groups, as an IDE's terminal panel holds them: each group is a tree
// whose leaves are terminal sessions and whose inner nodes lay their children side by side ("row")
// or stacked ("column"), each child taking its share of `sizes`. The tab shows one group at a time;
// its list shows every group. Every function here is pure and returns new trees, never mutating the
// ones it is given, so the registry can keep them in React state as they are.

export type SplitDirection = "row" | "column";

export type SplitNode =
  | { kind: "leaf"; id: string }
  | { kind: "split"; direction: SplitDirection; children: SplitNode[]; sizes: number[] };

export interface TerminalGroup {
  /** Stable for the group's life and unique among the groups, which resizeIn finds it by: the id
   *  of the session it was created with, suffixed when a group already holds that id (the session
   *  has since left the group it created, and the group lives on). */
  id: string;
  root: SplitNode;
}

/** An edge of a pane that a terminal dragged onto it is dropped against. */
export type DropSide = "left" | "right" | "top" | "bottom";

/** The smallest share a pane may be resized down to, of its split's whole. */
export const MIN_PANE_SHARE = 0.1;

const leaf = (id: string): SplitNode => ({ kind: "leaf", id });

/** The session ids of a tree, in reading order: left to right, top to bottom. */
export function leafIds(node: SplitNode): string[] {
  return node.kind === "leaf" ? [node.id] : node.children.flatMap(leafIds);
}

export function groupOf(groups: TerminalGroup[], id: string): TerminalGroup | undefined {
  return groups.find((g) => leafIds(g.root).includes(id));
}

/** A new group holding only `id`, after the others. */
export function addGroup(groups: TerminalGroup[], id: string): TerminalGroup[] {
  const taken = new Set(groups.map((g) => g.id));
  let groupId = id;
  for (let n = 2; taken.has(groupId); n++) groupId = `${id}/${n}`;
  return [...groups, { id: groupId, root: leaf(id) }];
}

// Splits `target` to hold `newId` beside it, after it or `before`. Beside a sibling of the same
// direction the new pane joins that split, halving the target's share, as an IDE adds a third pane
// to a row of two; in any other place the target becomes a split of its own.
function splitNode(
  node: SplitNode,
  target: string,
  newId: string,
  direction: SplitDirection,
  before: boolean,
): SplitNode {
  if (node.kind === "leaf") {
    if (node.id !== target) return node;
    const children = before ? [leaf(newId), node] : [node, leaf(newId)];
    return { kind: "split", direction, children, sizes: [0.5, 0.5] };
  }
  const index = node.children.findIndex((c) => c.kind === "leaf" && c.id === target);
  if (index !== -1 && node.direction === direction) {
    const half = node.sizes[index] / 2;
    const at = before ? index : index + 1;
    return {
      ...node,
      children: [...node.children.slice(0, at), leaf(newId), ...node.children.slice(at)],
      sizes: [...node.sizes.slice(0, index), half, half, ...node.sizes.slice(index + 1)],
    };
  }
  return { ...node, children: node.children.map((c) => splitNode(c, target, newId, direction, before)) };
}

/** Puts `newId` beside `target`, after it, in `target`'s group; unchanged if `target` is in none. */
export function splitIn(
  groups: TerminalGroup[],
  target: string,
  newId: string,
  direction: SplitDirection,
  before = false,
): TerminalGroup[] {
  return groups.map((g) =>
    leafIds(g.root).includes(target) ? { ...g, root: splitNode(g.root, target, newId, direction, before) } : g,
  );
}

/** The edge of a `width` x `height` pane nearest to the point (`x`, `y`) inside it, as a share of
 *  each side, so the pane divides along its diagonals, as an IDE's drop zones do. */
export function dropSide(x: number, y: number, width: number, height: number): DropSide {
  const distances: [DropSide, number][] = [
    ["left", x / width],
    ["right", 1 - x / width],
    ["top", y / height],
    ["bottom", 1 - y / height],
  ];
  return distances.reduce((best, d) => (d[1] < best[1] ? d : best))[0];
}

/** Moves `sourceId`, from wherever it is among the groups, beside `targetId` against its `side`:
 *  the group it leaves closes up as after a close, and the one it joins splits as for a new pane.
 *  Unchanged for a pane dropped on itself, or a target in no group. */
export function moveBeside(
  groups: TerminalGroup[],
  sourceId: string,
  targetId: string,
  side: DropSide,
): TerminalGroup[] {
  if (sourceId === targetId || !groupOf(groups, targetId)) return groups;
  const direction: SplitDirection = side === "left" || side === "right" ? "row" : "column";
  const before = side === "left" || side === "top";
  return splitIn(removeFrom(groups, sourceId), targetId, sourceId, direction, before);
}

// The tree without `id`, or null when nothing is left. A split left with one child gives way to
// that child, and the removed pane's share goes to the others in proportion.
function removeNode(node: SplitNode, id: string): SplitNode | null {
  if (node.kind === "leaf") return node.id === id ? null : node;
  const kept: SplitNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const next = removeNode(c, id);
    if (next) {
      kept.push(next);
      sizes.push(node.sizes[i]);
    }
  });
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  return { ...node, children: kept, sizes: sizes.map((s) => s / total) };
}

/** The groups without `id`; a group left empty goes. */
export function removeFrom(groups: TerminalGroup[], id: string): TerminalGroup[] {
  return groups.flatMap((g) => {
    const root = removeNode(g.root, id);
    return root ? [{ ...g, root }] : [];
  });
}

/** The session to show once `removedId` leaves the groups (`groups` as they were before): unchanged
 *  unless it was the shown one; then another pane of the same group, the one that took its place or
 *  else the one before it; and with the group gone, the first pane of the group that took its place,
 *  else of the one before. */
export function activeAfterRemoval(groups: TerminalGroup[], removedId: string, activeId: string | null): string | null {
  if (activeId !== removedId) return activeId;
  const group = groupOf(groups, removedId);
  if (!group) return activeId;
  const panes = leafIds(group.root);
  const index = panes.indexOf(removedId);
  const rest = panes.filter((id) => id !== removedId);
  if (rest.length) return rest[Math.min(index, rest.length - 1)];
  const groupIndex = groups.indexOf(group);
  const others = groups.filter((g) => g !== group);
  if (!others.length) return null;
  return leafIds(others[Math.min(groupIndex, others.length - 1)].root)[0];
}

/** The split at `path` (child indices from the group's root) gets `sizes`. */
export function resizeIn(groups: TerminalGroup[], groupId: string, path: number[], sizes: number[]): TerminalGroup[] {
  const resize = (node: SplitNode, rest: number[]): SplitNode => {
    if (node.kind === "leaf") return node;
    if (!rest.length) return { ...node, sizes };
    const [head, ...tail] = rest;
    return { ...node, children: node.children.map((c, i) => (i === head ? resize(c, tail) : c)) };
  };
  return groups.map((g) => (g.id === groupId ? { ...g, root: resize(g.root, path) } : g));
}

/** Moves the divider after pane `index` by `delta` (a share of the whole), each of the two panes it
 *  separates keeping at least MIN_PANE_SHARE; the others do not move. */
export function resizePair(sizes: number[], index: number, delta: number): number[] {
  const pair = sizes[index] + sizes[index + 1];
  const first = Math.min(Math.max(sizes[index] + delta, MIN_PANE_SHARE), pair - MIN_PANE_SHARE);
  const next = [...sizes];
  next[index] = first;
  next[index + 1] = pair - first;
  return next;
}

/** A split group as a saved layout stores it: a leaf is the session's device and instance number. */
export type SavedSplitNode =
  | { machine: string; num: number }
  | { direction: SplitDirection; sizes: number[]; children: SavedSplitNode[] };

export function saveTree(node: SplitNode, describe: (id: string) => { machine: string; num: number }): SavedSplitNode {
  if (node.kind === "leaf") return describe(node.id);
  return { direction: node.direction, sizes: node.sizes, children: node.children.map((c) => saveTree(c, describe)) };
}

/** Reads a saved tree back, which may be stale or hand-edited. `accept` turns a leaf's device and
 *  number into its session id, or refuses it (malformed, or a session already placed); a refused
 *  leaf is dropped like a closed one, and sizes that do not fit their children are evened out. */
export function loadTree(raw: unknown, accept: (machine: unknown, num: unknown) => string | null): SplitNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const node = raw as Record<string, unknown>;
  if (!Array.isArray(node.children)) {
    const id = accept(node.machine, node.num);
    return id ? leaf(id) : null;
  }
  const direction: SplitDirection = node.direction === "column" ? "column" : "row";
  const rawSizes = Array.isArray(node.sizes) ? node.sizes : [];
  const children: SplitNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const child = loadTree(c, accept);
    if (!child) return;
    children.push(child);
    const size = rawSizes[i];
    sizes.push(typeof size === "number" && Number.isFinite(size) && size > 0 ? size : NaN);
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  const valid = sizes.every((s) => !Number.isNaN(s));
  const total = valid ? sizes.reduce((a, b) => a + b, 0) : children.length;
  return { kind: "split", direction, children, sizes: valid ? sizes.map((s) => s / total) : children.map(() => 1 / total) };
}

/** Where a pane sits among its group's panes in the list, for the bracket drawn beside a group of
 *  several; null for a group of one, which gets none. */
export type PanePlace = "first" | "middle" | "last";

export function panePlace(index: number, count: number): PanePlace | null {
  if (count < 2) return null;
  if (index === 0) return "first";
  return index === count - 1 ? "last" : "middle";
}
