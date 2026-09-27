// Stamps the theme before first paint: index.html loads this as a classic, blocking script in
// <head>. The theme attributes Bootstrap and the --kt-* tokens read (see src/styles/theme.css) are
// otherwise not set until the app bundle parses and mounts React — which, with dockview +
// CodeMirror + xterm in it, is long enough to show as a flash of the wrong theme. It is most
// visible in the Electron shell, whose window background and setup page are dark. A file of its
// own rather than inline, because the SPA's Content-Security-Policy allows scripts from the app's
// own origin only (src/kathara_api/spa.py).
//
// Keep in sync with src/hooks/useTheme.ts, which owns this decision after mount: an
// explicit stored choice always wins, and only the *absence* of one falls back to the OS.
// Deliberately does not write back to localStorage, so a later change of the OS theme
// still takes effect for a user who has never picked one explicitly.
(function () {
  try {
    var stored = localStorage.getItem("kt-ui-theme");
    var theme =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.setAttribute("data-bs-theme", theme);
    document.documentElement.setAttribute("data-kt-theme", theme);
  } catch (e) {
    /* Storage disabled (private mode, hardened browser): leave the default light theme. */
  }
})();
