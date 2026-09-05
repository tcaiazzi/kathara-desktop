import { useEffect, useState } from "react";
import { Button } from "react-bootstrap";
import { Globe, Loader2, Plus, Upload } from "lucide-react";
import katharaLogo from "../assets/kathara-logo.png";
import katharaLogoDark from "../assets/kathara-logo-dark.png";
import { useToast } from "../context/ToastContext";
import { useTheme } from "../hooks/useTheme";
import { api, ApiError } from "../services/api";
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
  const toast = useToast();

  const [examples, setExamples] = useState<ExampleLab[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listExampleLabs()
      .then((list) => {
        if (!cancelled) setExamples(list);
      })
      .catch(() => {
        // An older backend without this route (or one with none bundled) 404s — that's "no
        // examples section", not an error worth a toast on a screen whose whole point is to be
        // welcoming.
        if (!cancelled) setExamples([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Not routed through useBusyAction: a 409 here is a benign race (another tab/window installed
  // the same example between the list load and this click), not an error worth its automatic
  // toast — it needs its own handling below, so the try/catch stays local to this function.
  async function handleCreateExample(example: ExampleLab) {
    if (example.installed) {
      onLabCreated(example.id);
      return;
    }
    setBusyId(example.id);
    try {
      const result = await api.createExampleLab(example.id);
      toast.show(`Lab "${result.name}" created.`, "success");
      onLabCreated(result.name ?? example.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.show(`Lab "${example.id}" already exists — opening it.`, "info");
        onLabCreated(example.id);
      } else {
        toast.reportError("Create example lab", e);
      }
    } finally {
      setBusyId(null);
    }
  }

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
                  <Button
                    size="sm"
                    variant={example.installed ? "outline-secondary" : "outline-primary"}
                    disabled={busyId !== null}
                    onClick={() => void handleCreateExample(example)}
                  >
                    {busyId === example.id ? (
                      <>
                        <Loader2 size={14} className="kt-explorer-spin me-1" />
                        Creating…
                      </>
                    ) : example.installed ? (
                      "Open"
                    ) : (
                      "Create"
                    )}
                  </Button>
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
