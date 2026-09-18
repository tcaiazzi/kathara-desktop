import { useCallback, useRef } from "react";

/** The promise plumbing behind a modal a caller can `await`.
 *
 * Four providers had their own copy of it — confirm, prompt, the labs-dir reclaim prompt and the
 * deploy-authorization prompt — differing only in the result type and what "the user gave up"
 * means for each.
 *
 * `ImageDownloadContext` deliberately does not use this: its guard fires, then it awaits a
 * progress fetch, and only then creates the promise, so the two halves cannot be one call.
 */
export function usePromiseModal<TResult>(cancelValue: TResult) {
  const resolveRef = useRef<((value: TResult) => void) | null>(null);

  /** Claim the single pending slot and return the promise for it.
   *
   * Whatever was still pending is settled with `cancelValue` first: a second request opened while
   * the first dialog is up would otherwise leave that first caller awaiting a promise nothing can
   * resolve — and, with `runBusy` around it, its `busy` flag stuck on.
   *
   * `setup` runs between the two, so state for the new dialog lands after the old one is settled.
   */
  const open = useCallback(
    (setup?: () => void): Promise<TResult> => {
      resolveRef.current?.(cancelValue);
      resolveRef.current = null;
      setup?.();
      return new Promise<TResult>((resolve) => {
        resolveRef.current = resolve;
      });
    },
    [cancelValue],
  );

  /** Resolve the pending request. Separate from closing the dialog on purpose: the elevation flow
   * resolves with "elevating" while deliberately leaving the modal up, because the window is about
   * to reload and a state update on a dying renderer buys nothing. */
  const settle = useCallback((value: TResult) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
  }, []);

  return { open, settle };
}
