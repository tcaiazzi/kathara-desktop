import { useMemo, useSyncExternalStore } from "react";
import { parseTerminalThemeId, resolveTerminalTheme, type TerminalThemeId } from "../services/terminalTheme";
import { useTheme } from "./useTheme";

// The viewer's terminal colour scheme (services/terminalTheme), shared by every terminal and by the
// Terminals tab's picker. One store for all callers, so a pick recolours every open terminal at
// once; the `storage` event carries it to the other windows too, the popup terminals among them.
// Remembered per viewer: storage that is missing or blocked just means "Match app".

const LS_TERMINAL_THEME = "kt-terminal-theme";

const listeners = new Set<() => void>();

function read(): TerminalThemeId {
  try {
    return parseTerminalThemeId(localStorage.getItem(LS_TERMINAL_THEME));
  } catch {
    return "app";
  }
}

let current: TerminalThemeId = read();

function notify(): void {
  listeners.forEach((l) => l());
}

// A pick made in another window of the app. One listener for the whole store, while it has
// subscribers; the first one reads the stored pick afresh, for one made while nothing listened.
function onStorage(e: StorageEvent): void {
  if (e.key !== LS_TERMINAL_THEME) return;
  current = read();
  notify();
}

function subscribe(listener: () => void): () => void {
  if (!listeners.size) {
    current = read();
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}

function setTerminalTheme(id: TerminalThemeId): void {
  current = id;
  try {
    localStorage.setItem(LS_TERMINAL_THEME, id);
  } catch {
    // Kept for this page's lifetime only.
  }
  notify();
}

export function useTerminalTheme() {
  const choice = useSyncExternalStore(subscribe, () => current);
  const { dark } = useTheme();
  // Per choice and app theme, not per render: "Match app" reads the tokens, which forces a style
  // recalculation.
  const theme = useMemo(() => resolveTerminalTheme(choice, dark), [choice, dark]);
  return { choice, setChoice: setTerminalTheme, theme };
}
