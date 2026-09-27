import type { FsEntry } from "./types";

// A device's files seen as a filesystem of its own, for the lab's offline filesystem API
// (api.fsListOffline & co.), which takes lab-relative paths. Two folders make it up, as they do
// inside the running device: its own folder (`/etc/motd` in the device's view is `/pc1/etc/motd`)
// and the lab's `shared/` folder, which Kathara bind-mounts at `/shared` in every device and
// which keeps the same path in both views. No device can be called `shared` (RESERVED_NAMES in
// services/lab_import.py), so `/shared` in the lab always means that folder. The Inspector panel
// browses the device through these helpers.

/** Where the lab's `shared/` folder appears, in the device's view and in the lab's alike. */
export const SHARED_DIR = "/shared";

/** Whether a device-view path is the shared folder or inside it. */
export function isSharedPath(path: string): boolean {
  return path === SHARED_DIR || path.startsWith(`${SHARED_DIR}/`);
}

/** The lab-relative path of `path` in `device`'s view: inside its folder, or in `shared/`. */
export function toLabPath(device: string, path: string): string {
  if (isSharedPath(path)) return path;
  const inner = path.replace(/^\/+/, "");
  return inner ? `/${device}/${inner}` : `/${device}`;
}

/** The device's view of a lab-relative path inside its folder or `shared/`. Throws for any
 *  other path: every path the API hands back for a listing or search under the two is inside
 *  one of them, so one that isn't means the two have been mixed up, and showing it as a device
 *  path would be wrong. */
export function fromLabPath(device: string, labPath: string): string {
  if (isSharedPath(labPath)) return labPath;
  const prefix = `/${device}`;
  if (labPath === prefix) return "/";
  if (labPath.startsWith(`${prefix}/`)) return labPath.slice(prefix.length);
  throw new Error(`${labPath} is not inside ${prefix}/ or ${SHARED_DIR}/`);
}

/** The device's root listing: its own folder's entries (already in the device's view) plus
 *  `/shared`. A `shared` entry of the device's own folder gives way to it: inside the running
 *  device those files land in the same mount anyway. The tree sorts entries itself. */
export function withSharedFolder(entries: FsEntry[]): FsEntry[] {
  const shared: FsEntry = { name: "shared", path: SHARED_DIR, is_dir: true, size: null, mode: null, mtime: null };
  return [...entries.filter((e) => e.path !== SHARED_DIR), shared];
}
