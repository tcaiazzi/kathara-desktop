import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "kt-ui-theme";
const THEME_ATTR = "data-kt-theme";

function getStoredTheme(): ThemeMode | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : null;
}

function readDomTheme(): ThemeMode {
  return document.documentElement.getAttribute(THEME_ATTR) === "dark" ? "dark" : "light";
}

// The single place that actually mutates document/localStorage state, callable from any component
// without that component needing to hold the "current" value itself — every useTheme() instance
// observes the DOM (below) and reacts to whichever one of them called this, instead of each
// holding its own independent copy that drifts until a full reload (same failure mode `useKtTheme`
// avoids for the dock/editor by observing the DOM rather than owning local state).
function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  root.setAttribute("data-bs-theme", theme);
  root.setAttribute(THEME_ATTR, theme);
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
}

/**
 * Tracks the light/dark choice via the document attributes Bootstrap and the --kt-* tokens read,
 * not local state — so every caller (the browser navbar, the desktop title bar, the Settings
 * toggle) observes the same live value and re-renders together when any one of them calls
 * `toggle()`, instead of drifting out of sync with each other (and with the CSS custom properties,
 * which are always live since the browser applies them regardless of React's render state) until a
 * full reload — that mismatch is what left navbar text unreadable after toggling from Settings.
 */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof document === "undefined") return "light";
    // Nothing has stamped the DOM attribute yet (very first mount of the whole app) — seed it from
    // last session's choice so this instance's initial read is correct without waiting for an effect.
    if (!document.documentElement.hasAttribute(THEME_ATTR)) {
      applyTheme(getStoredTheme() ?? "light");
    }
    return readDomTheme();
  });

  useEffect(() => {
    const root = document.documentElement;
    const obs = new MutationObserver(() => setTheme(readDomTheme()));
    obs.observe(root, { attributes: true, attributeFilter: [THEME_ATTR] });
    return () => obs.disconnect();
  }, []);

  // Reads the DOM directly rather than closing over `theme` state, so a toggle is always correct
  // relative to whatever the *actual* current theme is, not whatever this instance last rendered.
  const toggle = useCallback(() => applyTheme(readDomTheme() === "light" ? "dark" : "light"), []);

  return { theme, dark: theme === "dark", toggle };
}
