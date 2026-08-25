import { useEffect, useState } from "react";

// Track the app theme (set on <html data-kt-theme> by the navbar toggle) so theme-aware surfaces
// (the dock, the code editor) can re-theme when the user flips it. Shared by WorkspacePage and
// CodeEditor.
export function useKtTheme(): "light" | "dark" {
  const read = () => (document.documentElement.getAttribute("data-kt-theme") === "dark" ? "dark" : "light");
  const [theme, setTheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(el, { attributes: true, attributeFilter: ["data-kt-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}
