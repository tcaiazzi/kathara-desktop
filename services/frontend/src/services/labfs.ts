// Build a view of a lab's file tree from its LabDetail + queued pending state, seeded with the
// real on-disk lab.conf text.
//
// lab.conf comes verbatim from the backend (GET /labs/{lab}/lab-conf) rather than being
// reconstructed from LabDetail: the backend now persists it byte-for-byte (comments, quoting,
// options this UI doesn't model), so synthesizing an approximation here would just throw all of
// that away the moment the user opens — or, worse, saves — the file.
//
// Kathara's pending state is already flattened per-machine on the backend (shared/ files are
// merged into every machine's entry — see services/lab_import.py), so this tree is organized
// by machine rather than reconstructing a "shared/" node.

import type { LabDetail, MachineDetail, PendingMachineFiles } from "./types";

// Startup script shown for a machine: the authored pending `.startup` if present, else the
// machine's live exec_commands (matches what the Editor renders).
export function machineStartupText(m: MachineDetail, pending?: PendingMachineFiles): string {
  return pending && pending.startup.trim()
    ? pending.startup
    : m.exec_commands.length
      ? m.exec_commands.join("\n") + "\n"
      : "";
}

export function buildVirtualFs(
  detail: LabDetail,
  pending: Record<string, PendingMachineFiles>,
  labConf: string,
): { files: Record<string, string>; dirs: Set<string> } {
  const files: Record<string, string> = { "lab.conf": labConf };
  const dirs = new Set<string>();

  for (const m of detail.machines) {
    const p = pending[m.name];
    const startupText = machineStartupText(m, p);
    if (startupText) files[`${m.name}.startup`] = startupText;
    if (p) {
      for (const [guest, content] of Object.entries(p.files)) files[`${m.name}${guest}`] = content;
      for (const d of p.dirs) dirs.add(`${m.name}${d}`);
    }
  }
  return { files, dirs };
}

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}

export function buildFileTree(files: Record<string, string>, dirs: Iterable<string>): TreeNode {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };

  const addPath = (path: string, forceDir: boolean) => {
    if (!path) return;
    const parts = path.split("/");
    let node = root;
    let acc = "";
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      const isDir = forceDir || i < parts.length - 1;
      if (!child) {
        child = { name: part, path: acc, dir: isDir, children: [] };
        node.children.push(child);
      }
      if (isDir) child.dir = true;
      node = child;
    });
  };

  for (const path of Object.keys(files)) addPath(path, false);
  for (const path of dirs) addPath(path, true);

  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

// Icon for a lab-relative file name in the Editor tree (lab.conf/.ext/.dep get a distinct icon
// from startup scripts, which get a distinct icon from everything else).
export function fileIcon(name: string): string {
  if (name === "lab.conf" || name === "lab.ext" || name === "lab.dep") return "⚙️";
  if (name === "lab.layout") return "🗺️";
  if (name.endsWith(".startup") || name.endsWith(".shutdown") || name.endsWith(".sh")) return "📜";
  return "📄";
}
