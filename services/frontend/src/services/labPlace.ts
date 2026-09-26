// Where a lab lives, as the rail shows it, and finding one by the name a person would use. Pure,
// so it can be tested without a DOM.

import type { LabSummary } from "./types";

/**
 * The lab a person means by `name` (a kathara://lab/<name> link), or undefined. A name is unique
 * only under the labs root — a folder opened from elsewhere may carry the same one — so a lab
 * there wins; otherwise the first opened folder of that name.
 */
export function labNamed(labs: LabSummary[], name: string): LabSummary | undefined {
  const named = labs.filter((lab) => lab.name === name && !lab.problem);
  return named.find((lab) => lab.managed) ?? named[0];
}

/**
 * The folder a lab sits in: its parent directory, whole, with the user's `home` shown as "~"
 * ("/home/u/work/ospf" → "~/work"). Two lab folders with the same name are told apart by exactly
 * this, so it is the parent that is shown — the name is already on the row. The rail cuts it from
 * the start when it doesn't fit (.kt-ws-row-path).
 *
 * A host path, not a lab-relative one (services/paths.ts): it may be a Windows one, so both
 * separators are understood and kept as the path has them.
 */
export function labFolder(path: string, home: string | null = null): string {
  const trimmed = path.replace(/[\\/]+$/, "") || path;
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return "";
  const parent = trimmed.slice(0, cut);
  // A root keeps its separator: "/" and "C:\" read as folders, "" and "C:" don't.
  const folder = parent === "" || /^[A-Za-z]:$/.test(parent) ? trimmed.slice(0, cut + 1) : parent;
  return home ? withTilde(folder, home) : folder;
}

/** `path` with a leading `home` shown as "~", only where home ends at a separator. */
function withTilde(path: string, home: string): string {
  const base = home.replace(/[\\/]+$/, "");
  // A home at the root (HOME=/) would turn every path into "~…", which says nothing.
  if (!base || /^[A-Za-z]:$/.test(base)) return path;
  if (path === base) return "~";
  const next = path[base.length];
  return path.startsWith(base) && (next === "/" || next === "\\") ? `~${path.slice(base.length)}` : path;
}
