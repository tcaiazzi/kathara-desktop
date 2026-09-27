// A device's own folder seen as a filesystem of its own: `/etc/motd` in the device's view is
// `/pc1/etc/motd` for the lab's offline filesystem API (api.fsListOffline & co.), which takes
// lab-relative paths. The Inspector panel browses the folder through these two.

/** The lab-relative path of `path` inside `device`'s folder. */
export function toLabPath(device: string, path: string): string {
  const inner = path.replace(/^\/+/, "");
  return inner ? `/${device}/${inner}` : `/${device}`;
}

/** The device's view of a lab-relative path inside its folder. Throws for a path outside it:
 *  every path the API hands back for a listing or search under the folder is inside it, so one
 *  that isn't means the two have been mixed up, and showing it as a device path would be wrong. */
export function fromLabPath(device: string, labPath: string): string {
  const prefix = `/${device}`;
  if (labPath === prefix) return "/";
  if (labPath.startsWith(`${prefix}/`)) return labPath.slice(prefix.length);
  throw new Error(`${labPath} is not inside ${prefix}/`);
}
