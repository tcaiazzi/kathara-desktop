// Opens a device's live terminal as a real, separate browser window/tab (not an in-page overlay)
// so the user can arrange multiple terminals using the OS's own window management. `"_blank"`
// (rather than a per-device named target) means every call opens a genuinely new window, even
// for a device that already has one open elsewhere.
export function openTerminalWindow(labName: string, machineName: string): void {
  const url = `/labs/${encodeURIComponent(labName)}/terminal/${encodeURIComponent(machineName)}`;
  window.open(url, "_blank", "width=900,height=600,noopener,noreferrer");
}
