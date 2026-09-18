// Shared handling for a failed privileged operation, used by the two modals that ask for the
// user's password: ElevationContext (restart the backend as root) and ReclaimLabsDirContext (take
// back ownership of the labs directory).
//
// Both face the same question after a failure — keep the modal open so the user can try again, or
// give up and close it — and both used to answer it with their own copy of the same table and the
// same seven-line block.

/** A failure reason the modal stays open for, mapped to what it says about it. A reason *absent*
 * from the table closes the modal instead: currently only `"cancelled"`, i.e. the user dismissed
 * the OS's own admin dialog on macOS/Windows, where closing is exactly what they asked for. */
type SudoRetryMessages = Record<string, ((message: string) => string) | undefined>;

/** The three reasons that read the same whatever the operation was, plus the two that do not.
 *
 * `timeout` and `error` are per-operation on purpose — "that took too long" means something
 * different when it is a backend failing to come up as root than when it is a `chown` — so they
 * are arguments rather than a shared default nobody would notice was wrong. */
export function sudoRetryMessages(
  timeout: string,
  error: (message: string) => string,
): SudoRetryMessages {
  return {
    "wrong-password": () => "Incorrect password. Try again.",
    "not-permitted": () => "This account isn't allowed to use sudo.",
    timeout: () => timeout,
    error,
    // The rate limiter already phrases its own wait, so it is passed straight through.
    "rate-limited": (message) => message,
  };
}

interface SudoRetryFields {
  setPassword: (value: string) => void;
  setError: (value: string) => void;
  setBusy: (value: boolean) => void;
}

/** Show the retry message for `result`, if it has one.
 *
 * Returns `true` when the modal should stay open (the caller returns), `false` when there is
 * nothing to retry and the caller should close with its own outcome — which differs between the
 * two modals, so it is not decided here.
 */
export function showSudoRetry(
  messages: SudoRetryMessages,
  result: { reason: string; message: string },
  fields: SudoRetryFields,
): boolean {
  const inlineError = messages[result.reason]?.(result.message);
  if (!inlineError) return false;
  fields.setPassword("");
  fields.setError(inlineError);
  fields.setBusy(false);
  return true;
}
