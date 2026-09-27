// The tabs of the Inspector and which one a device opens on: the one the viewer last used,
// kept across devices and reloads. A "Configure Device" request switches to Scripts on top of this.

const DEVICE_INFO_TABS = ["overview", "network", "scripts", "files"] as const;
export type DeviceInfoTab = (typeof DEVICE_INFO_TABS)[number];

export function isDeviceInfoTab(value: unknown): value is DeviceInfoTab {
  return typeof value === "string" && (DEVICE_INFO_TABS as readonly string[]).includes(value);
}

/** The saved tab if it is still one of the tabs, else Overview. */
export function savedDeviceTab(saved: unknown): DeviceInfoTab {
  return isDeviceInfoTab(saved) ? saved : "overview";
}
