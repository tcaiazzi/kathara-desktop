import { useCallback } from "react";
import { useToast } from "../context/ToastContext";
import { desktop } from "../desktop/bridge";
import { useReclaimLabsDirAuth } from "../desktop/ReclaimLabsDirContext";
import { ApiError } from "../services/api";

// toast.reportError, plus the one failure the user can fix from here: the backend refused to
// change a lab file another account owns (LabFilePermissionError — in practice a file a running
// device wrote as root into the lab's shared/ folder). On Linux the desktop shell can reclaim such
// files with the user's password, so after the error toast this offers ReclaimLabsDirContext.tsx's
// modal for the folders the shell finds them in. Elsewhere, and in the browser build, it is just
// the toast.
export function useReportError(): (label: string, error: unknown) => void {
  const toast = useToast();
  const requestReclaimAuth = useReclaimLabsDirAuth();

  return useCallback(
    (label, error) => {
      toast.reportError(label, error);
      const shell = desktop();
      if (!(error instanceof ApiError && error.errorType === "LabFilePermissionError")) return;
      if (shell?.platform !== "linux") return;
      void (async () => {
        const paths = await shell.reclaimLabFilePaths().catch(() => []);
        if (paths.length === 0) return;
        if ((await requestReclaimAuth(paths)) === "reclaimed") {
          toast.show("Reclaimed the lab's files: try again.", "success");
        }
      })();
    },
    [requestReclaimAuth, toast],
  );
}
