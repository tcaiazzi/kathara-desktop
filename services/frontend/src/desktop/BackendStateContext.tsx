// What the page does when the desktop shell's backend stops while the page is on screen (the shell
// restarts it in place — services/desktop's main.ts, onBackendExit). The page stays up throughout,
// so an editor's unsaved edits are never lost to the crash: once a new backend answers, a page with
// nothing unsaved reloads itself to come back fresh, and one with unsaved edits keeps them — it can
// even save them — until the user reloads. A banner under the top bar says what is going on.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Spinner } from "react-bootstrap";
import { useLeavePage } from "../context/UnsavedChangesContext";
import { refreshAuthToken } from "../services/api";
import { parseBackendState, type BackendState } from "../services/backendState";
import { desktop } from "./bridge";

const BackendStateCtx = createContext<BackendState | null>(null);

export function BackendStateProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<BackendState | null>(null);
  const { hasUnsaved } = useLeavePage();

  useEffect(() => {
    const shell = desktop();
    if (!shell) return;
    return shell.onBackendState((raw) => {
      const next = parseBackendState(raw);
      if (!next) return;
      if (next.state !== "restarted") {
        setNotice(next);
        return;
      }
      void refreshAuthToken().then(() => {
        // Nothing to lose: every panel, stream and terminal comes back against the new backend.
        if (!hasUnsaved()) window.location.reload();
        else setNotice(next);
      });
    });
  }, [hasUnsaved]);

  return <BackendStateCtx.Provider value={notice}>{children}</BackendStateCtx.Provider>;
}

export function BackendStateBanner() {
  const notice = useContext(BackendStateCtx);
  const { confirmLeavingPage } = useLeavePage();
  if (!notice) return null;

  if (notice.state === "restarting") {
    return (
      <Alert variant="info" className="mb-0 rounded-0 py-2 d-flex align-items-center gap-2">
        <Spinner animation="border" size="sm" />
        <span>
          <strong>The local Kathara API stopped.</strong> Restarting it… <span className="small">{notice.cause}</span>
        </span>
      </Alert>
    );
  }

  if (notice.state === "restarted") {
    return (
      <Alert variant="success" className="mb-0 rounded-0 py-2 d-flex align-items-center gap-2">
        <span className="me-auto">
          <strong>The local Kathara API is back.</strong> Save your changes, then reload to see every panel
          as it is now.
        </span>
        <Button
          size="sm"
          variant="outline-success"
          onClick={() => void confirmLeavingPage().then((ok) => ok && window.location.reload())}
        >
          Reload
        </Button>
      </Alert>
    );
  }

  return (
    <Alert variant="danger" className="mb-0 rounded-0 py-2 d-flex align-items-center gap-2">
      <span className="me-auto">
        <strong>The local Kathara API isn&apos;t running.</strong> {notice.cause} Saving won&apos;t work until it
        is back: copy what you need from the editor, then restart it.
      </span>
      <Button
        size="sm"
        variant="outline-danger"
        onClick={() => void confirmLeavingPage().then((ok) => ok && void desktop()?.retryStartup())}
      >
        Restart
      </Button>
    </Alert>
  );
}
