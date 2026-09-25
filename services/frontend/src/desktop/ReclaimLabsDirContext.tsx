// One small modal for one Linux-only action: `elevation:drop` (see ElevationContext.tsx's
// neighboring concern, deploy authorization) found files an elevated session left root-owned in
// the labs directory or in a lab folder opened from elsewhere, and there is no native OS dialog
// that can collect a password on Linux the way macOS/Windows's own admin prompt does — so this
// collects it in-app instead, feeding it straight to `sudo -S` (backend.ts's
// reclaimOwnershipWithPassword), never storing it.
//
// Deliberately a separate provider from ElevationContext rather than a new mode grafted onto it:
// this isn't gating a deploy, it's an optional cleanup the user can always decline, with its own
// (much simpler) request shape — no privileged/volumes/hosthome to describe, just "authenticate or
// don't".
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { usePromiseModal } from "../hooks/usePromiseModal";
import { showSudoRetry, sudoRetryMessages } from "../services/sudoFailure";
import { Alert, Button, Form, Modal } from "react-bootstrap";
import { desktop } from "./bridge";

type ReclaimOutcome = "reclaimed" | "skipped";
type ReclaimAuthApi = () => Promise<ReclaimOutcome>;
const ReclaimAuthCtx = createContext<ReclaimAuthApi | null>(null);

// Every reason `reclaimLabsDirOwnership` can return has an entry, so unlike the elevation modal
// this one never actually takes the "no retry message, close instead" path.
const RETRY_MESSAGES = sudoRetryMessages(
  "That took too long. Try again.",
  (message) => `Could not reclaim ownership: ${message}`,
);

export function ReclaimLabsDirProvider({ children }: { children: ReactNode }) {
  const [show, setShow] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { open, settle } = usePromiseModal<ReclaimOutcome>("skipped");

  const requestReclaimAuth = useCallback<ReclaimAuthApi>(
    () =>
      open(() => {
        setPassword("");
        setError(null);
        setShow(true);
      }),
    [open],
  );

  function close(outcome: ReclaimOutcome) {
    setShow(false);
    setBusy(false);
    settle(outcome);
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
      if (showSudoRetry(RETRY_MESSAGES, result, { setPassword, setError, setBusy })) return;
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
              The privileged session that just ended left some files in your labs folder, or in a
              lab folder you opened, owned by the administrator account. Enter your password to reclaim them for your own account,
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
