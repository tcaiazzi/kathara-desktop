import type { LabImagesStatus } from "./types";

/** Human-readable byte count for the download UI. Mirrors the backend's own `format_bytes`. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB"];
  let scaled = value;
  for (const unit of units) {
    scaled /= 1024;
    if (scaled < 1024 || unit === "GB") {
      const rounded = scaled.toFixed(1);
      return `${rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded} ${unit}`;
    }
  }
  return `${value} B`;
}

/**
 * Percentage to render for a download, or null when it isn't knowable yet.
 *
 * Clamped to never fall below `previous`: Docker announces layers as the stream starts, so
 * `total` genuinely grows for the first moments of a pull and a raw ratio can dip. That window is
 * short, but a progress bar that runs backwards reads as broken. Pass `previous` as null (or reset
 * it) whenever the image being pulled changes, since the two images' progress is unrelated.
 */
export function progressPercent(
  previous: number | null,
  downloaded: number,
  total: number,
): number | null {
  if (!total || total <= 0) return null;
  const raw = Math.min(100, Math.max(0, (downloaded / total) * 100));
  return previous === null ? raw : Math.max(previous, raw);
}

/** What the confirmation step has to ask about, derived from the pre-check. */
export type ImageDownloadKind = "missing" | "outdated" | "both";

export function downloadKind(status: LabImagesStatus): ImageDownloadKind {
  if (status.missing.length && status.outdated.length) return "both";
  return status.missing.length ? "missing" : "outdated";
}

/**
 * Toast body for one finished image download — a separate toast fires per image (see
 * ImageDownloadContext's notifyCompletions), never one combined toast for a whole batch, so this
 * only ever names a single image. `name` is omitted for an *adopted* download (one already in
 * flight from another window), where the requested list isn't known here.
 */
export function pulledMessage(name?: string): string {
  return name ? `Downloaded Docker image ${name}.` : "The Docker image download finished.";
}

/**
 * The Deploy button's label. Phase-aware so a multi-second image pre-check doesn't look like a
 * frozen "Deploying…" — shared by the toolbar button and its narrow-width dropdown twin, which
 * previously duplicated the same ternary chain.
 */
export function deployButtonLabel(
  action: "checking" | "deploy" | "undeploy" | null,
  deployed: boolean,
): string {
  if (action === "checking") return "Checking images…";
  if (action === "deploy") return "Deploying…";
  if (action === "undeploy") return "Undeploying…";
  return deployed ? "Undeploy" : "Deploy";
}
