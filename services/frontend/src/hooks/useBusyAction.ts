import { useCallback } from "react";
import { useToast } from "../context/ToastContext";

// Wraps the busy/try/catch/toast-on-error/finally shell repeated across nearly every async
// action handler in this app. Success feedback stays with each caller (the wording varies too
// much per action to usefully centralize).
export function useBusyAction() {
  const toast = useToast();
  return useCallback(
    async (setBusy: (busy: boolean) => void, errorLabel: string, fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        toast.reportError(errorLabel, e);
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
}
