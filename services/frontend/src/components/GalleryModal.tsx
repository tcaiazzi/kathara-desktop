import { useEffect, useMemo, useRef, useState } from "react";
import { useCatalogInstall } from "../hooks/useCatalogInstall";
import { CatalogInstallButton } from "./CatalogInstallButton";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button, Collapse, Form, Modal } from "react-bootstrap";
import { api, ApiError } from "../services/api";
import type { GalleryLab } from "../services/types";
import "./GalleryModal.css";

interface GalleryModalProps {
  show: boolean;
  onClose: () => void;
  /** Same contract as NewLabModal/UploadLabModal's `onCreated`: refresh the lab list and open it. */
  onCreated: (labName: string) => void;
}

interface CategoryGroup {
  category: string;
  labs: GalleryLab[];
}

function groupByCategory(labs: GalleryLab[]): CategoryGroup[] {
  const groups: CategoryGroup[] = [];
  const byCategory = new Map<string, CategoryGroup>();
  for (const lab of labs) {
    let group = byCategory.get(lab.category);
    if (!group) {
      group = { category: lab.category, labs: [] };
      byCategory.set(lab.category, group);
      groups.push(group);
    }
    group.labs.push(lab);
  }
  return groups;
}

function matches(lab: GalleryLab, query: string): boolean {
  const haystack = `${lab.name} ${lab.category}`.toLowerCase();
  return haystack.includes(query);
}

// Browse and import a lab from the upstream Kathara-Labs gallery (backend services/lab_gallery.py)
// straight into the local labs directory — the remote twin of WelcomeScreen's "start from an
// example" list, scaled up to a full searchable catalog (~70 labs across ~9 categories).
export function GalleryModal({ show, onClose, onCreated }: GalleryModalProps) {

  const [catalog, setCatalog] = useState<GalleryLab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const loadIdRef = useRef(0);

  // A request ID rather than a per-call `cancelled` flag: the Refresh/Retry buttons below call
  // this directly too, outside the mount effect, so a single shared guard is what lets the
  // effect's cleanup invalidate a fetch a button started, not just the one it started itself.
  function load(refresh: boolean) {
    const id = ++loadIdRef.current;
    (refresh ? setRefreshing : setLoading)(true);
    setError(null);
    api
      .listGalleryLabs(refresh)
      .then((result) => {
        if (loadIdRef.current !== id) return;
        setCatalog(result.labs);
      })
      .catch((e) => {
        if (loadIdRef.current !== id) return;
        setError(e instanceof ApiError ? e.message : "Could not reach the lab gallery.");
      })
      .finally(() => {
        if (loadIdRef.current === id) {
          setLoading(false);
          setRefreshing(false);
        }
      });
  }

  useEffect(() => {
    if (!show) return;
    load(false);
    // loadIdRef is a request counter, not a DOM node ref — incrementing it here on
    // purpose invalidates whatever load() (this effect's or a Refresh/Retry click's) is
    // still in flight when the modal closes or unmounts.
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      loadIdRef.current++;
    };
  }, [show]);

  const groups = useMemo(() => {
    const labs = catalog ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q ? labs.filter((lab) => matches(lab, q)) : labs;
    return groupByCategory(filtered);
  }, [catalog, query]);

  const { busyId, install } = useCatalogInstall<GalleryLab>({
    install: (lab) => api.createGalleryLab(lab.id),
    // A gallery entry's `id` is its path in the upstream repo; `name` is what the lab is called
    // locally, and the only one worth showing a user.
    fallbackName: (lab) => lab.name,
    verbPast: "imported",
    errorLabel: "Import gallery lab",
    // Closing first is load-bearing: the modal has to be gone before the workspace navigates.
    onDone: (labName) => {
      onClose();
      onCreated(labName);
    },
  });

  return (
    <Modal show={show} onHide={onClose} size="lg" scrollable>
      <Modal.Header closeButton>
        <Modal.Title>Browse Kathara Labs</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="kt-gallery-toolbar">
          <Form.Control
            type="search"
            placeholder="Search labs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <Button
            variant="outline-secondary"
            size="sm"
            disabled={loading || refreshing}
            onClick={() => load(true)}
            title="Refresh catalog"
          >
            {refreshing ? <Loader2 size={14} className="kt-explorer-spin" /> : <RefreshCw size={14} />}
          </Button>
        </div>

        {loading && (
          <div className="kt-gallery-status">
            <Loader2 size={16} className="kt-explorer-spin me-2" />
            Loading the lab gallery…
          </div>
        )}

        {!loading && error && (
          <div className="kt-gallery-status kt-gallery-error">
            {error}
            <Button variant="outline-secondary" size="sm" className="ms-2" onClick={() => load(false)}>
              Retry
            </Button>
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <div className="kt-gallery-status">No labs match "{query}".</div>
        )}

        {!loading &&
          !error &&
          groups.map((group) => {
            const isCollapsed = collapsed[group.category] ?? false;
            return (
              <div className="kt-gallery-group" key={group.category}>
                <button
                  type="button"
                  className="kt-gallery-group-header"
                  onClick={() => setCollapsed((c) => ({ ...c, [group.category]: !isCollapsed }))}
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  {group.category}
                  <span className="kt-gallery-group-count">{group.labs.length}</span>
                </button>
                <Collapse in={!isCollapsed}>
                  <div>
                    {group.labs.map((lab) => (
                      <div className="kt-gallery-row" key={lab.id}>
                        <div className="kt-gallery-row-main">
                          <div className="kt-gallery-row-name">{lab.name}</div>
                          <div className="kt-gallery-row-meta">
                            {lab.n_files} file{lab.n_files === 1 ? "" : "s"}
                            {" · "}
                            <a href={lab.repo_url} target="_blank" rel="noopener noreferrer">
                              View on GitHub <ExternalLink size={11} />
                            </a>
                          </div>
                        </div>
                        <CatalogInstallButton
                          installed={lab.installed}
                          busy={busyId === lab.id}
                          anyBusy={busyId !== null}
                          idleLabel="Import"
                          busyLabel="Importing…"
                          onClick={() => void install(lab)}
                        />
                      </div>
                    ))}
                  </div>
                </Collapse>
              </div>
            );
          })}
      </Modal.Body>
      <Modal.Footer className="kt-gallery-footer">
        <a
          href="https://github.com/KatharaFramework/Kathara-Labs"
          target="_blank"
          rel="noopener noreferrer"
          className="kt-gallery-repo-link"
        >
          KatharaFramework/Kathara-Labs <ExternalLink size={12} />
        </a>
      </Modal.Footer>
    </Modal>
  );
}
