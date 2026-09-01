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
