/**
 * A small preferences file in userData. Deliberately not electron-store: the shell only needs
 * to remember a handful of user choices (an interpreter, a terminal override, a custom labs
 * directory), and a hand-rolled JSON read/write avoids a dependency for that.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export interface Prefs {
  /** Absolute path to a Python interpreter, set via "Choose Python interpreter…". */
  pythonPath?: string;
  /** Terminal emulator argv template; "{cmd}" is replaced with the command to run. */
  terminalCommand?: string[];
  /**
   * Absolute path to the lab storage root, set via Settings → "Change…". Absent (or pointing
   * at a directory that no longer exists) means paths.ts falls back to its default under
   * userData — see labsDir() there.
   */
  labsDir?: string;
  /**
   * Loopback port the backend was last started on successfully. Reused on the next launch when
   * it is still bindable, so the renderer keeps the same origin across a relaunch — Chromium
   * keys localStorage by origin *including the port*, so a fresh OS-assigned port every launch
   * (see backend.ts's findFreePort) silently discarded the SPA's theme, dock layout,
   * last-opened lab and any unsaved topology position drafts every single time. Falls back to a
   * fresh free port when the remembered one is no longer free — see backend.ts's rememberedPort.
   */
  backendPort?: number;
  /** Times a backend has come up healthy on this machine. 0/absent means this is the first
   * launch — read by main.ts to shape the setup page's first-run copy. */
  launchCount?: number;
}

function prefsFile(): string {
  return path.join(app.getPath("userData"), "preferences.json");
}

export function readPrefs(): Prefs {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), "utf8")) as Prefs;
  } catch {
    // Missing or corrupt: defaults are always a valid answer here, so don't fail startup.
    return {};
  }
}

export function writePrefs(update: Prefs): Prefs {
  const merged = { ...readPrefs(), ...update };
  fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
  fs.writeFileSync(prefsFile(), JSON.stringify(merged, null, 2));
  return merged;
}
