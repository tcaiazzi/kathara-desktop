// What the Settings page sends back from what GET /settings returned: every field except the ones
// the backend only reports (SettingsReadOnlyKey). The backend's SettingsUpdate forbids unknown
// keys, so a read-only field left in the payload turns the whole save into a 422.
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

export function toSettingsUpdate(view: SettingsView): SettingsUpdate {
  return Object.fromEntries(Object.entries(view).filter(([key]) => !(key in READ_ONLY))) as SettingsUpdate;
}
