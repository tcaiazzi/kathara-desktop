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
