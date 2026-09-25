import { desktop } from "../desktop/bridge";

// The desktop shell writes through Electron's main-process clipboard, which works regardless of
// the renderer's clipboard permissions; a plain browser falls back to the async Clipboard API.
export function copyText(text: string): Promise<void> {
  const shell = desktop();
  if (shell) return shell.copyToClipboard(text);
  return navigator.clipboard.writeText(text);
}
