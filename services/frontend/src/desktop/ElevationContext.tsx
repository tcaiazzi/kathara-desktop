// Prompts for a sudo password (Linux) or hands off to the OS's native admin prompt (macOS/
// Windows) before deploying a lab with privileged devices — see backend.ts's
// startBackendElevatedLinux/Native in services/desktop for why an elevated *relaunch* of the
// whole backend, not an in-place permission change, is what's actually needed.
//
// Electron-aware (talks to window.katharaDesktop through bridge.ts), unlike the pure-React
// ConfirmContext/PromptContext this otherwise resembles — same family as DesktopCommandsProvider.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Form, Modal } from "react-bootstrap";
import { api } from "../services/api";
import { desktop } from "./bridge";

/** "already-elevated": proceed with the deploy immediately, no modal was shown. "elevating": a
 * password was accepted and the backend is restarting/the app is reloading — the caller should
 * just stop, a reload is already in flight. "cancelled": the user declined, or elevation failed
 * and they gave up — the caller should abort with an explanatory message. */
export type ElevationOutcome = "already-elevated" | "elevating" | "cancelled";

/** `resumeLab` is the lab the caller is trying to deploy — reflected into the post-reload URL
 * (on the "elevating" path) so the SPA can continue that deploy on its own once it's back up. */
type ElevateApi = (resumeLab: string) => Promise<ElevationOutcome>;

const ElevationCtx = createContext<ElevateApi | null>(null);

export function ElevationProvider({ children }: { children: ReactNode }) {
  const [show, setShow] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolveRef = useRef<((outcome: ElevationOutcome) => void) | null>(null);
  const resumeLabRef = useRef("");

  const isLinux = desktop()?.platform === "linux";

  const requestElevation = useCallback<ElevateApi>(async (resumeLab) => {
    // Checked regardless of desktop-ness, over the same same-origin REST call the rest of the
    // app already uses: a backend can already be root for reasons that have nothing to do with
    // this app's own elevation flow (e.g. a container that already runs as root), and there's
    // nothing to prompt for in that case — including in a plain browser build, which otherwise
    // has no way to elevate anything at all.
    try {
      const info = await api.systemInfo();
      if (info.is_admin) return "already-elevated";
    } catch {
      // Fall through — if even this fails, the deploy attempt itself will surface the real error.
    }

    const shell = desktop();
    if (!shell) return "cancelled";

    // Settle any still-pending request before taking over the single resolveRef slot — same
    // guard as ConfirmContext/PromptContext, so a second call never wedges the first caller.
    resolveRef.current?.("cancelled");
    resolveRef.current = null;
    resumeLabRef.current = resumeLab;
    setPassword("");
    setError(null);
    setShow(true);
    return new Promise<ElevationOutcome>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  function close(outcome: ElevationOutcome) {
    setShow(false);
    setBusy(false);
    resolveRef.current?.(outcome);
    resolveRef.current = null;
  }

  async function submit() {
    const shell = desktop();
    if (!shell) {
      close("cancelled");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await shell.elevateBackend(isLinux ? password : undefined, resumeLabRef.current);
      if (result.ok) {
        // A reload is already in flight (the main process just navigated the window to the
        // newly-elevated backend) — nothing left for this renderer instance to do.
        resolveRef.current?.("elevating");
        resolveRef.current = null;
        return;
      }
      if (result.reason === "wrong-password" || result.reason === "not-permitted") {
        setPassword("");
        setError(result.reason === "wrong-password" ? "Incorrect password. Try again." : "This account isn't allowed to use sudo.");
        setBusy(false);
        return;
      }
      close("cancelled");
    } catch {
      close("cancelled");
    }
  }

  return (
    <ElevationCtx.Provider value={requestElevation}>
      {children}
      <Modal show={show} onHide={() => close("cancelled")} centered>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Modal.Header closeButton>
            <Modal.Title>Administrator privileges required</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <p>
              This lab has one or more privileged devices. Kathara needs to restart its backend
              with administrator privileges to run them.
            </p>
            {error && (
              <Alert variant="danger" className="py-2">
                {error}
              </Alert>
            )}
            {isLinux ? (
              <Form.Group>
                <Form.Label>Password</Form.Label>
                <Form.Control
                  autoFocus
                  type="password"
                  disabled={busy}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Form.Group>
            ) : (
              <p className="text-muted small mb-0">
                Click Continue and enter your password in the system dialog that appears.
              </p>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={() => close("cancelled")} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={busy || (isLinux && !password.trim())}>
              {busy ? "Elevating…" : "Continue"}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>
    </ElevationCtx.Provider>
  );
}

export function useElevate(): ElevateApi {
  const ctx = useContext(ElevationCtx);
  if (!ctx) throw new Error("useElevate must be used within an ElevationProvider");
  return ctx;
}
