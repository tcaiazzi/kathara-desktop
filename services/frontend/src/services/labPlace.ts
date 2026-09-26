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
 * The folder a lab sits in, short enough for a rail row:
 * the last two segments of its parent directory, behind an ellipsis when there are more
 * ("/home/u/work/net/ospf" → "…/work/net"). Two lab folders with the same name are told apart by
 * exactly this, so it is the parent that is shown — the name is already on the row.
 *
 * A host path, not a lab-relative one (services/paths.ts): it may be a Windows one, so both
 * separators are understood and the one the path uses is the one shown.
 */
export function labFolderHint(path: string): string {
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const segments = path.split(/[\\/]/).filter(Boolean);
  const parent = segments.slice(0, -1);
  if (parent.length === 0) return separator;
  const absolute = path.startsWith("/") || path.startsWith("\\");
  if (parent.length <= 2) {
    // A drive letter ("C:") already reads as the root; a POSIX path needs its leading slash back.
    return (absolute ? separator : "") + parent.join(separator);
  }
  return `…${separator}${parent.slice(-2).join(separator)}`;
}
