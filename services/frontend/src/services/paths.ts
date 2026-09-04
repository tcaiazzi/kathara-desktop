// Pure guest-path string helpers used by the runtime filesystem browser.

export function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

export function normalizeDir(p: string): string {
  if (!p || p === "/") return "/";
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

export function isSubPath(candidate: string, parent: string): boolean {
  const p = normalizeDir(parent);
  const c = normalizeDir(candidate);
  if (p === "/") return c !== "/";
  return c.startsWith(`${p}/`);
}

/**
 * The new path of `path` after `from` has been moved/renamed to `to`: `to` itself if `path` is
 * `from` exactly, the same relative path under `to` if `path` is a descendant of `from`, or
 * `null` if `path` is unrelated to the move (so a caller can leave it untouched with `?? path`).
 *
 * The one thing a naive `path === from ? to : path` misses: a rename of a *directory* has to
 * remap every path inside it too (`/pc1/etc/motd` under a rename of `/pc1/etc` -> `/pc1/conf`),
 * not just an exact match on the renamed path itself.
 */
export function remapPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (!isSubPath(path, from)) return null;
  const fromNorm = normalizeDir(from);
  const toNorm = normalizeDir(to);
  // `fromNorm`'s length already excludes a trailing slash; the root case is the only one where
  // the leading slash IS `fromNorm` itself, so the generic `fromNorm.length + 1` would double-cut.
  const suffix = path.slice(fromNorm === "/" ? 1 : fromNorm.length + 1);
  return toNorm === "/" ? `/${suffix}` : `${toNorm}/${suffix}`;
}
