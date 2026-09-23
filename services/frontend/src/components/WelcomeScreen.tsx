import { useCatalogInstall } from "../hooks/useCatalogInstall";
import { useCatalogList } from "../hooks/useCatalogList";
import { CatalogInstallButton } from "./CatalogInstallButton";
import { Button } from "react-bootstrap";
import { Globe, Plus, Upload } from "lucide-react";
import katharaLogo from "../assets/kathara-logo.png";
import katharaLogoDark from "../assets/kathara-logo-dark.png";
import { useTheme } from "../hooks/useTheme";
import { api } from "../services/api";
import { DOCS_URL } from "../services/constants";
import type { ExampleLab } from "../services/types";
import "./WelcomeScreen.css";

interface WelcomeScreenProps {
  /** Opens the existing NewLabModal (WorkspacePage's `showNew`). */
  onNewLab: () => void;
  /** Opens the existing UploadLabModal (WorkspacePage's `showUpload`). */
  onImportLab: () => void;
  /** Opens the GalleryModal (WorkspacePage's `showGallery`). */
  onBrowseGallery: () => void;
  /** Same contract as NewLabModal/UploadLabModal's `onCreated`: refresh the lab list and open it. */
  onLabCreated: (labName: string) => void;
  /** Rendered only when the user already has labs (arrived via ?welcome=1) — a genuine first run,
   * with no labs to fall back on, has no way to dismiss itself into an empty screen. */
  onDismiss?: () => void;
}

// Shown in place of the dockarea's empty state when there are no labs yet (or the user asked to
// see it again via ?welcome=1 — see WorkspacePage). Only Bootstrap + react-bootstrap + lucide,
// same as the rest of the app; no wizard/stepper primitive, since this is one static screen that
// only launches the two flows (NewLabModal/UploadLabModal) that already exist.
export function WelcomeScreen({ onNewLab, onImportLab, onBrowseGallery, onLabCreated, onDismiss }: WelcomeScreenProps) {
  const { dark } = useTheme();

  const { items: examples } = useCatalogList<ExampleLab>({
    fetch: (_refresh, signal) => api.listExampleLabs(signal),
    // A backend without this route (or with no examples bundled) 404s — that's "no examples
    // section", not an error worth surfacing on a screen whose whole point is to be welcoming.
    errorMessage: () => null,
  });

  const { busyId, install } = useCatalogInstall<ExampleLab>({
    install: (example) => api.createExampleLab(example.id),
    fallbackName: (example) => example.id,
    verbPast: "created",
    errorLabel: "Create example lab",
    onDone: onLabCreated,
  });

  return (
    <div className="kt-welcome">
      <img src={dark ? katharaLogoDark : katharaLogo} alt="Kathara" height={40} />
      <h4>Welcome to Kathara Desktop</h4>
      <p className="kt-welcome-lead">
        Build, deploy and inspect network scenarios on your own machine — each device is a
        container, each link a virtual collision domain.
      </p>

      <div className="kt-welcome-cta">
        <Button variant="primary" onClick={onNewLab}>
          <Plus size={16} className="me-1" />
          New Lab
        </Button>
        <Button variant="outline-secondary" onClick={onImportLab}>
          <Upload size={16} className="me-1" />
          Import a .zip…
        </Button>
        <Button variant="outline-secondary" onClick={onBrowseGallery}>
          <Globe size={16} className="me-1" />
          Browse Kathara Labs…
        </Button>
      </div>

      {examples === null ? (
        <div className="card kt-welcome-examples">
          <div className="card-body">
            <h5 className="card-title">Start from an example</h5>
            <div className="kt-ws-muted">Loading…</div>
          </div>
        </div>
      ) : (
        examples.length > 0 && (
          <div className="card kt-welcome-examples">
            <div className="card-body">
              <h5 className="card-title">Start from an example</h5>
              {examples.map((example) => (
                <div className="kt-welcome-example" key={example.id}>
                  <div>
                    <div className="kt-welcome-example-name">{example.id}</div>
                    {example.description && <div className="kt-welcome-example-desc">{example.description}</div>}
                    <div className="kt-welcome-example-meta">
                      {example.n_machines} device{example.n_machines === 1 ? "" : "s"}
                      {example.author ? ` · by ${example.author}` : ""}
                    </div>
                  </div>
                  <CatalogInstallButton
                    installed={example.installed}
                    busy={busyId === example.id}
                    anyBusy={busyId !== null}
                    idleLabel="Create"
                    busyLabel="Creating…"
                    onClick={() => void install(example)}
                  />
                </div>
              ))}
            </div>
          </div>
        )
      )}

      <div className="kt-welcome-foot">
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
          Documentation ↗
        </a>
        {onDismiss && (
          <>
            {" · "}
            <Button variant="link" size="sm" className="p-0 align-baseline" onClick={onDismiss}>
              Hide Welcome
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
