import { Loader2 } from "lucide-react";
import { Badge } from "react-bootstrap";
import { useImageDownloadStatus } from "../context/ImageDownloadContext";
import { progressPercent } from "../services/imagePull";
import "./ImageDownloadBadge.css";

// Rendered next to the health/privileged badges in AppNavbar and TitleBar — a Docker image
// download is a global, single-slot backend resource (not scoped to the open lab), so it belongs
// in the shared chrome rather than inside WorkspacePage: switching labs or opening Settings must
// not make it disappear. Only shows once the user has closed the modal on a running download —
// see ImageDownloadContext's `active` (phase "running" with the modal hidden); while the modal
// itself is open there is nothing for a second indicator to add.
export function ImageDownloadBadge() {
  const { active, progress, reopen } = useImageDownloadStatus();
  if (!active) return null;

  // A plain ratio, not the modal's monotonically-clamped one: a compact text label rounding
  // differently for one frame is far less noticeable than a progress *bar* stepping backwards.
  const percent = progress ? progressPercent(null, progress.downloaded_bytes, progress.total_bytes) : null;
  const pctSuffix = percent === null ? "" : ` — ${Math.round(percent)}%`;

  // With several images queued, name which one we're on (clamped: the terminal snapshot sets
  // `images_done` to the full count, which would otherwise render as "3 of 2" for one frame) —
  // mirrors the "image X of Y" sub-line the modal itself already shows.
  const label =
    progress && progress.images_total > 1
      ? `Downloading image ${Math.min(progress.images_done + 1, progress.images_total)} of ${progress.images_total}${pctSuffix}`
      : `Downloading image${pctSuffix}`;

  return (
    <Badge
      as="button"
      type="button"
      bg="info"
      onClick={reopen}
      className="kt-image-dl-badge d-flex align-items-center gap-1"
      title="A Docker image download is running in the background. Click to see progress."
    >
      <Loader2 size={12} className="kt-explorer-spin" />
      {label}
    </Badge>
  );
}
