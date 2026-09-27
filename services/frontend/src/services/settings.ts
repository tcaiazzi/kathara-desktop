// The Settings page's two forms and what each sends back from what GET /settings returned. The
// page has one tab for Kathara's own settings (saved to kathara.conf, shared with the Kathara CLI)
// and one for this app's (the upload & import limits among them). PUT /settings takes a partial
// update, so each form sends only its own keys, and a save in one tab never touches the other.
//
// Neither form sends the fields the backend only reports (SettingsReadOnlyKey): the backend's
// SettingsUpdate forbids unknown keys, so one of those in the payload turns the save into a 422.
import type { SettingsReadOnlyKey, SettingsUpdate, SettingsView } from "./types";

// A Record rather than an array, so adding a key to SettingsReadOnlyKey without listing it here
// fails the typecheck instead of the save.
const READ_ONLY: Record<SettingsReadOnlyKey, true> = {
  last_checked: true,
  remote_url: true,
  cert_path: true,
  settings_file: true,
  settings_file_error: true,
  settings_warnings: true,
};

/** This app's own upload & import caps (the backend's ApiSettings), in bytes / a file count. */
export const LIMIT_KEYS = ["max_files_per_lab", "max_bytes_per_file", "max_bytes_per_lab"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type UploadLimits = Pick<SettingsUpdate, LimitKey>;

function isLimitKey(key: string): key is LimitKey {
  return (LIMIT_KEYS as readonly string[]).includes(key);
}

/** The Kathara tab's save: every editable field except this app's limits. */
export function toKatharaUpdate(view: SettingsView): SettingsUpdate {
  return Object.fromEntries(
    Object.entries(view).filter(([key]) => !(key in READ_ONLY) && !isLimitKey(key)),
  ) as SettingsUpdate;
}

/** The limits' save: only the limits that have a value (an emptied field is left as it was). */
export function toLimitsUpdate(view: SettingsView): UploadLimits {
  const out: UploadLimits = {};
  for (const key of LIMIT_KEYS) {
    const value = view[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The form after the Kathara tab saved: the backend's answer for everything, except the limits
 *  the user may be editing in the other tab, which stay as typed. */
export function afterKatharaSave(form: SettingsView, saved: SettingsView): SettingsView {
  const limits = Object.fromEntries(LIMIT_KEYS.map((key) => [key, form[key]]));
  return { ...saved, ...limits };
}

/** The form after the limits saved: only the limits are taken from the backend's answer, so an
 *  unsaved edit in the Kathara tab stays as typed. */
export function afterLimitsSave(form: SettingsView, saved: SettingsView): SettingsView {
  const limits = Object.fromEntries(LIMIT_KEYS.map((key) => [key, saved[key]]));
  return { ...form, ...limits };
}

/** The Settings page's tabs: this app's own settings, and Kathara's. */
export const SETTINGS_TABS = ["app", "kathara"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && (SETTINGS_TABS as readonly string[]).includes(value);
}

/** The tab to open on: the one the URL names (`/settings?tab=kathara`), else the one the viewer
 *  used last, else this app's own. */
export function initialSettingsTab(fromUrl: unknown, saved: unknown): SettingsTab {
  if (isSettingsTab(fromUrl)) return fromUrl;
  return isSettingsTab(saved) ? saved : "app";
}
