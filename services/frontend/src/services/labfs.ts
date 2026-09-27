// Small shared helpers for the Lab Configuration / topology "startup script" display. The tree
// itself (services/frontend/src/components/LabExplorer.tsx) is built from real, lazily-fetched
// directory listings (api.fsListOffline), not assembled here: there is no in-memory model of the
// lab's files for a "virtual fs" to be built from.

import { FileCog, FileText, Map as MapIcon, Terminal, type LucideIcon } from "lucide-react";

import type { FsEntry, LabDetail, MachineDetail } from "./types";

// Startup script shown for a machine: its real `<name>.startup` content if present, else the
// machine's live exec_commands (matches what the Editor renders).
export function machineStartupText(m: MachineDetail, startupText?: string): string {
  return startupText && startupText.trim()
    ? startupText
    : m.exec_commands.length
      ? m.exec_commands.join("\n") + "\n"
      : "";
}

// Icon for a lab-relative file name in the Editor tree (lab.conf/.ext/.dep get a distinct icon
// from startup scripts, which get a distinct icon from everything else). Returns an SVG
// component rather than an emoji character: emoji rendering depends on an emoji font being
// installed, which a minimal Linux install (in particular the Electron desktop app's host) may
// not have, leaving blank "tofu" boxes in the tree where the icons should be.
export function fileIcon(name: string): LucideIcon {
  if (name === "lab.conf" || name === "lab.ext" || name === "lab.dep") return FileCog;
  if (name === "lab.layout") return MapIcon;
  if (name.endsWith(".startup") || name.endsWith(".shutdown") || name.endsWith(".sh")) return Terminal;
  return FileText;
}

// What removing device `name` deletes from the lab folder, given the lab root's listing: its
// `<name>.startup` and `<name>.shutdown` scripts, and its `<name>/` folder — reported with the
// trailing slash, and only when it is a directory. The rule is KatharaService._remove_machine_fs's
// (and Kathara's own, which takes `<name>` as a device's folder only when it is one): a plain file
// of that name stays, so the Remove Device confirmation must not list it.
export function deviceFilesOnDisk(name: string, rootEntries: FsEntry[]): string[] {
  const byName = new Map(rootEntries.map((e) => [e.name, e]));
  const files = [`${name}.startup`, `${name}.shutdown`].filter((f) => byName.get(f) && !byName.get(f)?.is_dir);
  if (byName.get(name)?.is_dir) files.push(`${name}/`);
  return files;
}

// A key that changes whenever a new `detail` may come with a lab folder that looks different, and
// only then — for the Lab Configuration tree to re-list its root on, since `detail` is a new
// object on every refresh (a lifecycle action, an event, a retry) while most of them leave the
// folder as it was. What does change it: a device added or removed (its scripts and folder), a
// device started or stopped (a deploy creates `shared/`), and the folder going missing, coming
// back, or moving. File contents are not part of it — lab.conf and the startup scripts are
// followed on their own.
export function labTreeKey(detail: LabDetail): string {
  const names = detail.machines.map((m) => m.name).sort();
  const running = detail.machines.filter((m) => m.running).map((m) => m.name).sort();
  return JSON.stringify([names, running, detail.problem ?? null, detail.path]);
}
