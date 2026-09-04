import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button, Collapse, Form, Modal } from "react-bootstrap";
import { useToast } from "../context/ToastContext";
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
  const toast = useToast();

  const [catalog, setCatalog] = useState<GalleryLab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  function load(refresh: boolean) {
    let cancelled = false;
    (refresh ? setRefreshing : setLoading)(true);
    setError(null);
    api
      .listGalleryLabs(refresh)
      .then((result) => {
        if (cancelled) return;
        setCatalog(result.labs);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "Could not reach the lab gallery.");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }

  useEffect(() => {
    if (!show) return;
    return load(false);
  }, [show]);

  const groups = useMemo(() => {
    const labs = catalog ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q ? labs.filter((lab) => matches(lab, q)) : labs;
    return groupByCategory(filtered);
  }, [catalog, query]);

  // Not routed through useBusyAction: a 409 here is a benign race (another tab/window installed
  // the same lab between the list load and this click) that gets its own handling below, exactly
  // as WelcomeScreen's handleCreateExample treats it — not a toast-worthy error.
  async function handleImport(lab: GalleryLab) {
    if (lab.installed) {
      onClose();
      onCreated(lab.name);
      return;
    }
    setBusyId(lab.id);
    try {
      const result = await api.createGalleryLab(lab.id);
      toast.show(`Lab "${result.name}" imported.`, "success");
      if (result.warnings?.length) {
        toast.show(result.warnings.join(" · "), "info", "Import warnings");
      }
      onClose();
      onCreated(result.name ?? lab.name);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.show(`Lab "${lab.name}" already exists — opening it.`, "info");
        onClose();
        onCreated(lab.name);
      } else {
        toast.reportError("Import gallery lab", e);
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal show={show} onHide={onClose} size="lg" scrollable className="kt-gallery-modal">
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
                        <Button
                          size="sm"
                          variant={lab.installed ? "outline-secondary" : "outline-primary"}
                          disabled={busyId !== null}
                          onClick={() => void handleImport(lab)}
                        >
                          {busyId === lab.id ? (
                            <>
                              <Loader2 size={14} className="kt-explorer-spin me-1" />
                              Importing…
                            </>
                          ) : lab.installed ? (
                            "Open"
                          ) : (
                            "Import"
                          )}
                        </Button>
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
