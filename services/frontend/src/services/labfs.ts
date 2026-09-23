// Small shared helpers for the Lab Configuration / topology "startup script" display. The tree
// itself (services/frontend/src/components/LabExplorer.tsx) is built from real, lazily-fetched
// directory listings (api.fsListOffline), not assembled here: there is no in-memory model of the
// lab's files for a "virtual fs" to be built from.

import { FileCog, FileText, Map as MapIcon, Terminal, type LucideIcon } from "lucide-react";

import type { MachineDetail } from "./types";

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
