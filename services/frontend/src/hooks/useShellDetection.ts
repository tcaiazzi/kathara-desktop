import { useRef, useState } from "react";
import { api } from "../services/api";

// Shared by TerminalPanel and TerminalWindowPage: detects which shells are actually present on a
// device — a plain "bash" default fails outright on images without it, e.g. Alpine — and drives
// the shell picker. `shellRef` mirrors `shell` for callers that read the connection URL right
// after picking a shell, before a state re-render lands (the auto-connect flow: detect, then
// connect immediately).
export function useShellDetection(initial = "bash") {
  const [shells, setShells] = useState<string[]>([]);
  const [shell, setShell] = useState(initial);
  const shellRef = useRef(initial);

  const chooseShell = (value: string) => {
    shellRef.current = value;
    setShell(value);
  };

  // Prefers "bash" if it's among the detected shells, else the first one reported. Swallows
  // detection failures — the picker falls back to the static bash/sh/ash/zsh list and `initial`.
  const detectShell = async (labName: string, machine: string) => {
    try {
      const list = await api.listShells(labName, machine);
      if (list.length) {
        setShells(list);
        chooseShell(list.includes("bash") ? "bash" : list[0]);
      }
    } catch {
      /* detection failed — keep the default shell + full picker list */
    }
  };

  return { shells, shell, shellRef, chooseShell, detectShell };
}
