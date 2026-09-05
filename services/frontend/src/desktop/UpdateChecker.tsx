import { useEffect, useRef } from "react";
import { useToast } from "../context/ToastContext";
import { desktop } from "./bridge";

// Renders nothing — just fires the one-shot "is there a newer release" check on mount and
// surfaces the result as a toast/notification. A no-op in the browser build (desktop() is null
// there; there is nothing to update outside the desktop app). See services/desktop/src/
// updateCheck.ts for where the actual GitHub call happens (in the shell's main process, not
// here — the renderer only ever pulls the cached result over IPC).
export function UpdateChecker() {
  const toast = useToast();
  // StrictMode double-invokes effects in dev; the shell's own check is already memoized
  // (services/desktop/src/updateCheck.ts), so a duplicate call there is harmless, but this
  // guards against showing the toast itself twice.
  const checked = useRef(false);

  useEffect(() => {
    const shell = desktop();
    if (!shell || checked.current) return;
    checked.current = true;
    void shell.checkForUpdate().then((info) => {
      if (!info) return;
      toast.show(`Kathara Desktop ${info.version} is available.`, "info", "Update available", {
        label: "Download",
        run: () => void shell.openExternal(info.url),
      });
    });
  }, [toast]);

  return null;
}
