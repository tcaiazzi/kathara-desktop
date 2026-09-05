// One small modal for one Linux-only action: `elevation:drop` (see ElevationContext.tsx's
// neighboring concern, deploy authorization) found files an elevated session left root-owned in
// the labs directory, and there is no native OS dialog that can collect a password on Linux the
// way macOS/Windows's own admin prompt does — so this collects it in-app instead, feeding it
// straight to `sudo -S` (backend.ts's reclaimLabsDirOwnershipWithPassword), never storing it.
//
// Deliberately a separate provider from ElevationContext rather than a new mode grafted onto it:
// this isn't gating a deploy, it's an optional cleanup the user can always decline, with its own
// (much simpler) request shape — no privileged/volumes/hosthome to describe, just "authenticate or
// don't".
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Form, Modal } from "react-bootstrap";
import { desktop } from "./bridge";

export type ReclaimOutcome = "reclaimed" | "skipped";
type ReclaimAuthApi = () => Promise<ReclaimOutcome>;
const ReclaimAuthCtx = createContext<ReclaimAuthApi | null>(null);

/** Mirrors ElevationContext.tsx's own RETRY_MESSAGES — same reasons, same idea (a reason absent
 * here would close the modal instead, but every reason reclaimLabsDirOwnership can return has an
 * entry, so that path is never actually taken). */
const RETRY_MESSAGES: Record<string, ((message: string) => string) | undefined> = {
  "wrong-password": () => "Incorrect password. Try again.",
  "not-permitted": () => "This account isn't allowed to use sudo.",
  timeout: () => "That took too long. Try again.",
  error: (message) => `Could not reclaim ownership: ${message}`,
  "rate-limited": (message) => message,
};

export function ReclaimLabsDirProvider({ children }: { children: ReactNode }) {
  const [show, setShow] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolveRef = useRef<((outcome: ReclaimOutcome) => void) | null>(null);

  const requestReclaimAuth = useCallback<ReclaimAuthApi>(() => {
    // Same guard as ElevationContext/ConfirmContext/PromptContext: settle any still-pending
    // request before taking over the single resolveRef slot.
    resolveRef.current?.("skipped");
    resolveRef.current = null;
    setPassword("");
    setError(null);
    setShow(true);
    return new Promise<ReclaimOutcome>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  function close(outcome: ReclaimOutcome) {
    setShow(false);
    setBusy(false);
    resolveRef.current?.(outcome);
    resolveRef.current = null;
  }

  async function submit() {
    const shell = desktop();
    if (!shell) {
      close("skipped");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await shell.reclaimLabsDirOwnership(password);
      if (result.ok) {
        close("reclaimed");
        return;
      }
      const inlineError = RETRY_MESSAGES[result.reason]?.(result.message);
      if (inlineError) {
        setPassword("");
        setError(inlineError);
        setBusy(false);
        return;
      }
      close("skipped");
    } catch {
      close("skipped");
    }
  }

  return (
    <ReclaimAuthCtx.Provider value={requestReclaimAuth}>
      {children}
      <Modal show={show} onHide={() => close("skipped")} centered>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Modal.Header closeButton>
            <Modal.Title>Reclaim lab files from the administrator account</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <p>
              The privileged session that just ended left some files in your labs folder owned by
              the administrator account. Enter your password to reclaim them for your own account,
              or leave them as is and fix it yourself later — either way the app continues
              normally.
            </p>
            {error && (
              <Alert variant="danger" className="py-2">
                {error}
              </Alert>
            )}
            <Form.Group className="mt-2">
              <Form.Label>Password</Form.Label>
              <Form.Control
                autoFocus
                type="password"
                disabled={busy}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={() => close("skipped")} disabled={busy}>
              Leave as is
            </Button>
            <Button variant="primary" type="submit" disabled={busy || !password.trim()}>
              {busy ? "Reclaiming…" : "Reclaim now"}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>
    </ReclaimAuthCtx.Provider>
  );
}

export function useReclaimLabsDirAuth(): ReclaimAuthApi {
  const ctx = useContext(ReclaimAuthCtx);
  if (!ctx) throw new Error("useReclaimLabsDirAuth must be used within a ReclaimLabsDirProvider");
  return ctx;
}
