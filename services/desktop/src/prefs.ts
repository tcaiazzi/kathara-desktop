/**
 * A small preferences file in userData. Deliberately not electron-store: the shell only needs
 * to remember a handful of user choices (a terminal override, a custom labs directory), and a
 * hand-rolled JSON read/write avoids a dependency for that.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

interface Prefs {
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
  const file = prefsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename, not a direct writeFileSync: a crash mid-write must never leave a truncated
  // preferences.json behind — readPrefs() would then silently fall back to {} and settings like
  // the configured labs directory would appear to vanish. The temp file lives next to the target
  // so the rename is same-filesystem and therefore atomic on both POSIX and Windows/NTFS.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, file);
  return merged;
}
