import { Folder } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, Modal } from "react-bootstrap";
import { useToast } from "../context/ToastContext";
import { api } from "../services/api";
import type { FsEntry } from "../services/types";

interface HostPathPickerProps {
  show: boolean;
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}

// Small breadcrumb + list browser over the host machine's own filesystem (services/api.ts's
// browseHost, backed by KatharaService.browse_host_directory) — lets the user pick a real
// absolute path for a device's volume host_path instead of typing one blind. Directories only:
// a volume's host side is a bind-mount source, not a file to preview/edit.
export function HostPathPicker({ show, initialPath, onClose, onSelect }: HostPathPickerProps) {
  const [path, setPath] = useState(initialPath?.trim() || "/");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (show) setPath(initialPath?.trim() || "/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    setLoading(true);
    api
      .browseHost(path)
      .then((resp) => {
        if (!cancelled) setEntries(resp.entries.filter((e) => e.is_dir));
      })
      .catch((e) => {
        if (!cancelled) toast.reportError("Browse host directory", e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, path]);

  const breadcrumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    const acc: { label: string; value: string }[] = [{ label: "/", value: "/" }];
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      acc.push({ label: part, value: current });
    }
    return acc;
  }, [path]);

  return (
    <Modal show={show} onHide={onClose}>
      <Modal.Header closeButton>
        <Modal.Title>Choose a host directory</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="d-flex flex-wrap align-items-center gap-1 mb-2">
          {breadcrumbs.map((crumb, idx) => {
            const isLast = idx === breadcrumbs.length - 1;
            return (
              <div key={crumb.value} className="d-flex align-items-center gap-1">
                <Button
                  size="sm"
                  variant={isLast ? "secondary" : "outline-secondary"}
                  className="py-0 px-2 font-monospace"
                  disabled={isLast}
                  onClick={() => setPath(crumb.value)}
                >
                  {crumb.label}
                </Button>
                {!isLast && <span className="text-muted small">/</span>}
              </div>
            );
          })}
        </div>
        <div className="border rounded p-1" style={{ maxHeight: 320, overflowY: "auto" }}>
          {loading ? (
            <p className="text-muted small mb-0 p-2">Loading…</p>
          ) : entries.length ? (
            entries.map((entry) => (
              <div
                key={entry.path}
                className="px-1 py-1 rounded"
                style={{ cursor: "pointer" }}
                onClick={() => setPath(entry.path)}
                onDoubleClick={() => onSelect(entry.path)}
                title="Click to open, double-click to select"
              >
                <span className="font-monospace small d-inline-flex align-items-center gap-1">
                  <Folder size={14} />
                  {entry.name}
                </span>
              </div>
            ))
          ) : (
            <p className="text-muted small mb-0 p-2">No subdirectories.</p>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => onSelect(path)}>
          Select "{path}"
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
