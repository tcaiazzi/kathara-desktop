import type { ITheme } from "@xterm/xterm";

// The colour schemes a live terminal can take, the one source of them for every terminal surface
// (useTerminalTheme). "Match app" follows the app's light/dark theme, as the code editor does, so a
// terminal reads as part of its pane; the others are fixed schemes a viewer can pick instead, from
// the Terminals tab. Every scheme sets its own background: the box around the terminal is painted
// with it too (useTerminalSession), and xterm's scrollable area does not cover the terminal's inset.

export type TerminalThemeId =
  | "app"
  | "github-light"
  | "github-dark"
  | "solarized-light"
  | "solarized-dark"
  | "dracula";

// GitHub's ANSI palettes, picked so that yellow and white stay legible on a light background.
const GITHUB_LIGHT_ANSI: ITheme = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

const GITHUB_DARK_ANSI: ITheme = {
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
};

const SOLARIZED_ANSI: ITheme = {
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const GITHUB_LIGHT: ITheme = {
  ...GITHUB_LIGHT_ANSI,
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#1a7f37",
  cursorAccent: "#ffffff",
  selectionBackground: "#0969da40",
};

const GITHUB_DARK: ITheme = {
  ...GITHUB_DARK_ANSI,
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#7ee787",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
};

interface TerminalThemeOption {
  id: Exclude<TerminalThemeId, "app">;
  label: string;
  theme: ITheme;
}

/** The fixed schemes, in the order the Terminals tab lists them after "Match app". */
export const TERMINAL_THEMES: readonly TerminalThemeOption[] = [
  { id: "github-light", label: "GitHub Light", theme: GITHUB_LIGHT },
  { id: "github-dark", label: "GitHub Dark", theme: GITHUB_DARK },
  {
    id: "solarized-light",
    label: "Solarized Light",
    theme: {
      ...SOLARIZED_ANSI,
      background: "#fdf6e3",
      foreground: "#586e75",
      cursor: "#586e75",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#93a1a14d",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    theme: {
      ...SOLARIZED_ANSI,
      background: "#002b36",
      foreground: "#93a1a1",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "#586e7580",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
];

/** A stored choice, or "app" for anything that is not one: a missing, blocked or stale value. */
export function parseTerminalThemeId(raw: string | null): TerminalThemeId {
  return TERMINAL_THEMES.some((t) => t.id === raw) ? (raw as TerminalThemeId) : "app";
}

/** The xterm colours for a choice. "Match app" takes its background and text from the
 *  --kt-term-bg / --bs-body-color tokens, read resolved from the document since xterm takes colour
 *  strings, not CSS variables: call it after the document's theme attribute has changed. */
export function resolveTerminalTheme(id: TerminalThemeId, appDark: boolean): ITheme {
  const fixed = TERMINAL_THEMES.find((t) => t.id === id);
  if (fixed) return fixed.theme;
  const base = appDark ? GITHUB_DARK : GITHUB_LIGHT;
  const style = getComputedStyle(document.documentElement);
  const background = style.getPropertyValue("--kt-term-bg").trim() || base.background;
  const foreground = style.getPropertyValue("--bs-body-color").trim() || base.foreground;
  return { ...base, background, foreground, cursorAccent: background };
}
