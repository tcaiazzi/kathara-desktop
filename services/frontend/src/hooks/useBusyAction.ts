import { useCallback, useEffect, useRef } from "react";
import { useToast } from "../context/ToastContext";

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

// Wraps the busy/try/catch/toast-on-error/finally shell repeated across nearly every async
// action handler in this app. Success feedback stays with each caller (the wording varies too
// much per action to usefully centralize).
//
// `fn` receives an AbortSignal so a caller that hits a real abandon point (the user cancels, the
// owning component unmounts) can pass it into `api.*` and actually stop the in-flight request
// rather than let it run to completion in the background. Pass it on wherever the endpoint takes
// one; callers that don't need it can ignore the parameter.
export function useBusyAction() {
  const toast = useToast();
  const controllersRef = useRef<Set<AbortController>>(new Set());

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      controllers.forEach((c) => c.abort());
    };
  }, []);

  const run = useCallback(
    async (setBusy: (busy: boolean) => void, errorLabel: string, fn: (signal: AbortSignal) => Promise<void>) => {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      setBusy(true);
      try {
        await fn(controller.signal);
      } catch (e) {
        if (!isAbortError(e)) toast.reportError(errorLabel, e);
      } finally {
        controllersRef.current.delete(controller);
        setBusy(false);
      }
    },
    [toast],
  );

  const cancel = useCallback(() => {
    controllersRef.current.forEach((c) => c.abort());
  }, []);

  return { run, cancel };
}
