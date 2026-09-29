// One modal for every deploy that needs the user's own OS credentials before it can proceed: a
// privileged device, a host directory mounted into a device, or the host home mount. The backend
// runs as the user, never as root, and refuses such a deploy unless the desktop shell has granted
// it after checking the password (services/desktop's backend.ts authorizeDeploy, the backend's
// services/deploy_grants.py) — so this modal is where the grant comes from, not just a courtesy
// prompt. A lab that is both privileged and mounting host directories asks for the same password
// once, with an extra warning: that combination is more dangerous than either alone.
//
// Electron-aware (talks to window.katharaDesktop through bridge.ts), unlike the pure-React
// ConfirmContext/PromptContext this otherwise resembles — same family as DesktopCommandsProvider.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { usePromiseModal } from "../hooks/usePromiseModal";
import { showSudoRetry, sudoRetryMessages } from "../services/sudoFailure";
import { Alert, Button, Form, Modal } from "react-bootstrap";
import { api } from "../services/api";
import type { VolumeMount } from "../services/types";
import { desktop } from "./bridge";

/** "proceed": go ahead and deploy now — nothing needed asking, the password was verified (and,
 * for a deploy, the backend granted it), or the no-desktop fallback was confirmed. "cancelled":
 * the user declined, or the check failed and they gave up — the caller should abort. */
export type DeployAuthOutcome = "proceed" | "cancelled";

interface DeployAuthRequest {
  privileged: boolean;
  volumeMachines: { name: string; volumes: VolumeMount[] }[];
  /** Whether Settings' "Mount host home directory" is on — a global toggle, not a per-device
   * volume, so it's its own flag rather than a fake entry in `volumeMachines`: every device this
   * backend deploys from now on gets the operator's real `$HOME` bind-mounted in, regardless of
   * what this specific lab declares. Shown and gated exactly like a real host volume — the caller
   * (a deploy, or Settings' own save) is responsible for checking the current setting value and
   * passing it in; this module has no way to know it on its own. */
  hosthomeMount?: boolean;
  /** The lab about to be deployed, which the verified password grants the deploy of. Absent only
   * for Settings' host home toggle, which deploys nothing: the password is then just checked. */
  labId?: string;
}

type DeployAuthApi = (req: DeployAuthRequest) => Promise<DeployAuthOutcome>;

const DeployAuthCtx = createContext<DeployAuthApi | null>(null);

type Mode = "privileged" | "volumes" | "volumes-no-shell" | "both";

const RETRY_MESSAGES = sudoRetryMessages(
  "Checking the password took too long. Try again.",
  (message) => `Could not authorize the deploy: ${message}`,
);

const TITLES: Record<Mode, string> = {
  privileged: "Administrator privileges required",
  both: "Administrator privileges required",
  volumes: "Mount host directories?",
  "volumes-no-shell": "Mount host directories?",
};

interface VolumeListProps {
  machines: { name: string; volumes: VolumeMount[] }[];
}

function VolumeList({ machines }: VolumeListProps) {
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
  // False only on Linux where sudo asks this account for no password (NOPASSWD): a typed
  // password would verify nothing there, so the modal asks for a confirmation instead.
  const [passwordRequired, setPasswordRequired] = useState(true);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { open, settle } = usePromiseModal<DeployAuthOutcome>("cancelled");
  const labIdRef = useRef<string | undefined>(undefined);

  const isLinux = desktop()?.platform === "linux";

  const showModal = useCallback(
    (m: Mode, machines: { name: string; volumes: VolumeMount[] }[], hosthome: boolean, needsPassword: boolean) => {
      return open(() => {
        setMode(m);
        setVolumeMachines(machines);
        setHosthomeMount(hosthome);
        setPasswordRequired(needsPassword);
        setPassword("");
        setError(null);
        setShow(true);
      });
    },
    [open],
  );

  const requestDeployAuthorization = useCallback<DeployAuthApi>(
    async ({ privileged, volumeMachines: machines, hosthomeMount: hosthome = false, labId }) => {
      if (!privileged && machines.length === 0 && !hosthome) return "proceed";

      const shell = desktop();
      if (!shell) {
        // Without a desktop shell there is no OS identity to check and no one to grant the
        // deploy: the backend then starts a privileged device only if it really is root, and a
        // host mount after the page's own confirmation (KatharaService._authorize_host_access).
        if (privileged) {
          try {
            const info = await api.systemInfo();
            if (!info.is_admin) return "cancelled";
          } catch {
            return "cancelled";
          }
          if (machines.length === 0 && !hosthome) return "proceed";
        }
        return showModal("volumes-no-shell", machines, hosthome, false);
      }

      labIdRef.current = labId;
      const hasMount = machines.length > 0 || hosthome;
      const m: Mode = privileged && hasMount ? "both" : privileged ? "privileged" : "volumes";
      // Asked on Linux only: elsewhere the OS's own dialog does the asking.
      const needsPassword = shell.platform !== "linux" || (await shell.sudoPasswordRequired().catch(() => true));
      return showModal(m, machines, hosthome, needsPassword);
    },
    [showModal],
  );

  function close(outcome: DeployAuthOutcome) {
    setShow(false);
    setBusy(false);
    settle(outcome);
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
    const labId = labIdRef.current;
    // Settings' toggle deploys nothing, and every deploy is gated on its own: with no password to
    // check, the confirmation is all there is to ask for.
    if (!labId && !passwordRequired) {
      close("proceed");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const typed = isLinux && passwordRequired ? password : undefined;
      const result = labId ? await shell.authorizeDeploy(labId, typed) : await shell.verifyCanElevate(typed);
      if (result.ok) {
        close("proceed");
        return;
      }
      // Everything except a dismissed OS dialog is worth showing *in* the modal and retrying
      // from: reporting it to the caller as if the user had clicked Cancel — which is what
      // closing here does — hides the actual reason in the log where nobody looks.
      if (showSudoRetry(RETRY_MESSAGES, result, { setPassword, setError, setBusy })) return;
      close("cancelled");
    } catch {
      close("cancelled");
    }
  }

  const askPassword = mode !== "volumes-no-shell" && isLinux && passwordRequired;

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
                This lab has one or more privileged devices, which run with extended capabilities on
                your machine. Confirm with your password to start them.
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
            {mode !== "volumes-no-shell" &&
              (askPassword ? (
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
              ) : isLinux ? (
                <p className="text-muted small mb-0 mt-2">
                  sudo doesn't ask this account for a password, so confirming is enough.
                </p>
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
            <Button variant="primary" type="submit" disabled={busy || (askPassword && !password.trim())}>
              {busy ? "Verifying…" : "Continue"}
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
