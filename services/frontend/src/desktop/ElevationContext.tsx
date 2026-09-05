// One modal for every deploy that needs the user's own OS credentials before it can proceed —
// either because it needs a privileged device's backend to actually restart as root (see
// backend.ts's startBackendElevatedLinux/Native in services/desktop), or because it would mount a
// host directory and — while that doesn't need this *process* to be root — still deserves the
// same "prove you mean it" gate a password provides. A lab that is both asks for the same
// password once, with an extra warning: that combination is more dangerous than either alone.
//
// Electron-aware (talks to window.katharaDesktop through bridge.ts), unlike the pure-React
// ConfirmContext/PromptContext this otherwise resembles — same family as DesktopCommandsProvider.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Form, Modal } from "react-bootstrap";
import { api } from "../services/api";
import type { VolumeMount } from "../services/types";
import { desktop } from "./bridge";

/** "proceed": go ahead and deploy now, synchronously — covers four different situations the
 * caller doesn't need to tell apart: neither condition applied, the backend was already root, a
 * volume-only password was verified, or the no-desktop fallback was confirmed without one.
 * "elevating": the backend is restarting/the app is reloading — the caller should just stop, a
 * reload (and, for a full-lab deploy, an automatic resume) is already in flight. "cancelled": the
 * user declined, or the check failed and they gave up — the caller should abort. */
export type DeployAuthOutcome = "proceed" | "elevating" | "cancelled";

export interface DeployAuthRequest {
  privileged: boolean;
  volumeMachines: { name: string; volumes: VolumeMount[] }[];
  /** Whether Settings' "Mount host home directory" is on — a global toggle, not a per-device
   * volume, so it's its own flag rather than a fake entry in `volumeMachines`: every device this
   * backend deploys from now on gets the operator's real `$HOME` bind-mounted in, regardless of
   * what this specific lab declares. Shown and gated exactly like a real host volume — the caller
   * (a deploy, or Settings' own save) is responsible for checking the current setting value and
   * passing it in; this module has no way to know it on its own. */
  hosthomeMount?: boolean;
  /** Only meaningful when `privileged` needs a real elevation: where the post-reload URL should
   * land so the SPA can resume that lab's deploy on its own. */
  resumeLab?: string;
}

type DeployAuthApi = (req: DeployAuthRequest) => Promise<DeployAuthOutcome>;

const DeployAuthCtx = createContext<DeployAuthApi | null>(null);

type Mode = "privileged" | "volumes" | "volumes-no-shell" | "both";

/** Failure reasons the modal stays open for, and what it says about each. A reason absent here
 * closes the modal instead — currently only "cancelled", i.e. the user dismissed the OS's own
 * admin dialog on macOS/Windows, where closing is exactly what they asked for. */
const RETRY_MESSAGES: Record<string, ((message: string) => string) | undefined> = {
  "wrong-password": () => "Incorrect password. Try again.",
  "not-permitted": () => "This account isn't allowed to use sudo.",
  timeout: () => "The backend didn't start with administrator privileges in time. Try again.",
  error: (message) => `Could not verify administrator privileges: ${message}`,
  "rate-limited": (message) => message,
};

const TITLES: Record<Mode, string> = {
  privileged: "Administrator privileges required",
  both: "Administrator privileges required",
  volumes: "Mount host directories?",
  "volumes-no-shell": "Mount host directories?",
};

const OK_LABELS: Record<Mode, string> = {
  privileged: "Continue",
  both: "Continue",
  volumes: "Continue",
  // "Deploy" until this had a second caller: SettingsPage's hosthome_mount gate reuses this same
  // mode/modal from outside any lab-deploy flow, so the label can no longer assume one.
  "volumes-no-shell": "Continue",
};

function VolumeList({ machines }: { machines: { name: string; volumes: VolumeMount[] }[] }) {
  return (
    <ul className="mb-0">
      {machines.flatMap((m) =>
        m.volumes.map((v, i) => (
          <li key={`${m.name}-${i}`}>
            <code>{m.name}</code>: <code>{v.host_path}</code> → <code>{v.guest_path}</code> ({v.mode})
          </li>
        )),
      )}
    </ul>
  );
}

export function ElevationProvider({ children }: { children: ReactNode }) {
  const [show, setShow] = useState(false);
  const [mode, setMode] = useState<Mode>("privileged");
  const [volumeMachines, setVolumeMachines] = useState<{ name: string; volumes: VolumeMount[] }[]>([]);
  const [hosthomeMount, setHosthomeMount] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolveRef = useRef<((outcome: DeployAuthOutcome) => void) | null>(null);
  const resumeLabRef = useRef("");

  const isLinux = desktop()?.platform === "linux";

  const showModal = useCallback(
    (m: Mode, machines: { name: string; volumes: VolumeMount[] }[], hosthome: boolean) => {
      // Settle any still-pending request before taking over the single resolveRef slot — same
      // guard as ConfirmContext/PromptContext, so a second call never wedges the first caller.
      resolveRef.current?.("cancelled");
      resolveRef.current = null;
      setMode(m);
      setVolumeMachines(machines);
      setHosthomeMount(hosthome);
      setPassword("");
      setError(null);
      setShow(true);
      return new Promise<DeployAuthOutcome>((resolve) => {
        resolveRef.current = resolve;
      });
    },
    [],
  );

  const requestDeployAuthorization = useCallback<DeployAuthApi>(
    async ({ privileged, volumeMachines: machines, hosthomeMount: hosthome = false, resumeLab }) => {
      if (!privileged && machines.length === 0 && !hosthome) return "proceed";

      if (privileged) {
        // Checked regardless of desktop-ness, over the same same-origin REST call the rest of
        // the app already uses: a backend can already be root for reasons that have nothing to
        // do with this app's own elevation flow (e.g. a container that already runs as root),
        // and there's nothing to prompt for in that case — including in a plain browser build,
        // which otherwise has no way to elevate anything at all.
        try {
          const info = await api.systemInfo();
          if (info.is_admin) return "proceed";
        } catch {
          // Fall through — if even this fails, the deploy attempt itself will surface the error.
        }
      }

      const shell = desktop();
      if (!shell) {
        // Without a desktop shell there is no OS admin mechanism at all, on either path. A
        // privileged device genuinely can't be deployed without elevation, same as before. A
        // volume-only deploy has no OS identity to check outside the desktop app, so it degrades
        // to a plain confirmation instead of being refused.
        if (privileged) return "cancelled";
        return showModal("volumes-no-shell", machines, hosthome);
      }

      resumeLabRef.current = resumeLab ?? "";
      const hasMount = machines.length > 0 || hosthome;
      const m: Mode = privileged && hasMount ? "both" : privileged ? "privileged" : "volumes";
      return showModal(m, machines, hosthome);
    },
    [showModal],
  );

  function close(outcome: DeployAuthOutcome) {
    setShow(false);
    setBusy(false);
    resolveRef.current?.(outcome);
    resolveRef.current = null;
  }

  async function submit() {
    if (mode === "volumes-no-shell") {
      close("proceed");
      return;
    }
    const shell = desktop();
    if (!shell) {
      close("cancelled");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "volumes") {
        // Verify-only: the backend is never touched, so success just means "proceed" — there is
        // no reload to wait for, unlike the privileged/both branch below.
        const result = await shell.verifyCanElevate(isLinux ? password : undefined);
        if (result.ok) {
          close("proceed");
          return;
        }
        const inlineError = RETRY_MESSAGES[result.reason]?.(result.message);
        if (inlineError) {
          setPassword("");
          setError(inlineError);
          setBusy(false);
          return;
        }
        close("cancelled");
        return;
      }

      // mode === "privileged" | "both": today's real elevation, unchanged.
      const result = await shell.elevateBackend(isLinux ? password : undefined, resumeLabRef.current);
      if (result.ok) {
        // A reload is already in flight (the main process just navigated the window to the
        // newly-elevated backend) — nothing left for this renderer instance to do.
        resolveRef.current?.("elevating");
        resolveRef.current = null;
        return;
      }
      // Everything except a dismissed OS dialog is worth showing *in* the modal and retrying
      // from: the backend is still running (see bridge.ts's `restarted`), and reporting a
      // failed elevation to the caller as if the user had clicked Cancel — which is what
      // closing here does — hides the actual reason in the log where nobody looks.
      const inlineError = RETRY_MESSAGES[result.reason]?.(result.message);
      if (inlineError) {
        setPassword("");
        setError(inlineError);
        setBusy(false);
        return;
      }
      close("cancelled");
    } catch {
      close("cancelled");
    }
  }

  const needsPasswordUi = mode !== "volumes-no-shell";

  return (
    <DeployAuthCtx.Provider value={requestDeployAuthorization}>
      {children}
      <Modal show={show} onHide={() => close("cancelled")} centered>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Modal.Header closeButton>
            <Modal.Title>{TITLES[mode]}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {(mode === "privileged" || mode === "both") && (
              <p>
                This lab has one or more privileged devices. Kathara needs to restart its backend
                with administrator privileges to run them.
              </p>
            )}
            {mode === "both" && (
              <Alert variant="warning" className="py-2">
                This lab also mounts host directories. A privileged device already has elevated
                capabilities inside its container — combined with a mounted host directory, a
                compromised or malicious device could read, modify or delete anything under that
                path with root-equivalent power on your machine. Only continue if you fully trust
                every device in this lab.
              </Alert>
            )}
            {hosthomeMount && (
              <p>
                <strong>Mount host home directory</strong> is on in Settings: your entire home
                directory will be mounted read-write at <code>/hosthome</code> inside every device
                this backend deploys from now on, accessible to any process running inside them —
                a global setting, not something specific to this lab.
              </p>
            )}
            {volumeMachines.length > 0 && (
              <>
                <p className="mb-1">
                  {hosthomeMount
                    ? "It also mounts these host directories into its devices:"
                    : "This lab mounts the following host directories into its devices:"}
                </p>
                <VolumeList machines={volumeMachines} />
              </>
            )}
            {mode === "volumes-no-shell" && (
              <p className="text-muted small mb-0 mt-2">
                Only continue if you trust the source of this lab.
              </p>
            )}
            {error && (
              <Alert variant="danger" className="py-2">
                {error}
              </Alert>
            )}
            {needsPasswordUi &&
              (isLinux ? (
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
              ) : (
                <p className="text-muted small mb-0 mt-2">
                  Click Continue and enter your password in the system dialog that appears.
                </p>
              ))}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={() => close("cancelled")} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={busy || (needsPasswordUi && isLinux && !password.trim())}
            >
              {busy ? "Elevating…" : OK_LABELS[mode]}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>
    </DeployAuthCtx.Provider>
  );
}

export function useDeployAuthorization(): DeployAuthApi {
  const ctx = useContext(DeployAuthCtx);
  if (!ctx) throw new Error("useDeployAuthorization must be used within an ElevationProvider");
  return ctx;
}
