import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Form, Modal, ProgressBar } from "react-bootstrap";
import { Loader2 } from "lucide-react";
import { useToast } from "./ToastContext";
import { useImagePullProgress } from "../hooks/useImagePullProgress";
import { api, ApiError } from "../services/api";
import {
  downloadKind,
  formatBytes,
  progressPercent,
  pulledMessage,
  type ImageDownloadKind,
} from "../services/imagePull";
import type { ImagePullProgress, LabImagesStatus } from "../services/types";
import "./ImageDownloadContext.css";

/**
 * "downloaded" — something was pulled; the caller must NOT deploy on its own (the modal has told
 * the user the lab is ready, and pressing Deploy again is the deliberate next step).
 * "skipped"    — an *optional* update was declined and nothing was missing, so the caller should
 *                carry straight on and deploy with the images already on disk.
 * "cancelled"  — do not deploy.
 */
export type ImageDownloadOutcome = "downloaded" | "skipped" | "cancelled";

type ImageDownloadApi = (status: LabImagesStatus) => Promise<ImageDownloadOutcome>;

const ImageDownloadCtx = createContext<ImageDownloadApi | null>(null);

/** What the navbar badge needs — kept as its own context so a component that only cares about
 * "is a download running in the background" doesn't have to depend on `ImageDownloadApi` (whose
 * identity is stable but whose *purpose*, requesting a new download, is unrelated). */
export interface ImageDownloadStatus {
  /** True only while a download is running AND its modal isn't currently shown — i.e. exactly
   * the case the badge exists for. Goes false again the moment the modal is reopened, and also
   * once the download finishes (the toast is what reports that, not the badge). */
  active: boolean;
  progress: ImagePullProgress | null;
  /** Reopens the modal on its current phase (always "running" when `active` is true). */
  reopen: () => void;
}

const ImageDownloadStatusCtx = createContext<ImageDownloadStatus | null>(null);

type Phase = "confirm" | "running" | "done" | "error";

// Reassurance shown as soon as a pull starts, not after a delay: "this is a one-time multi-minute
// download" is the whole point of surfacing the step at all.
const RUNNING_HINT =
  "The first run downloads the device image — this can take a few minutes. " +
  "It only happens once; later deploys reuse it.";

const TITLES: Record<ImageDownloadKind, string> = {
  missing: "Download device images",
  outdated: "Update device image",
  both: "Download device images",
};

function ImageList({ names }: { names: string[] }) {
  return (
    <ul className="kt-image-dl-list">
      {names.map((name) => (
        <li key={name}>
          <code>{name}</code>
        </li>
      ))}
    </ul>
  );
}

export function ImageDownloadProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [phase, setPhase] = useState<Phase>("confirm");
  const [status, setStatus] = useState<LabImagesStatus | null>(null);
  const [includeUpdates, setIncludeUpdates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolveRef = useRef<((outcome: ImageDownloadOutcome) => void) | null>(null);
  // True when *this* modal started the download, so its own request settling is the authoritative
  // "finished". False when it adopted a download already in flight (the user closed the modal and
  // came back), where the only available signal is the polled snapshot.
  const ownedRef = useRef(false);
  // Monotonic clamp for the bar, reset whenever the image being pulled changes.
  const percentRef = useRef<{ image: string | null; value: number | null }>({ image: null, value: null });
  // Whether the download includes an image the lab cannot start without. It decides what a
  // *failure* means: fatal if something was missing, otherwise the lab is still deployable with
  // what is on disk, so a failed optional update must not block the deploy.
  const mandatoryRef = useRef(false);
  // The exact, ordered list this download was asked to pull — needed to name each image in its
  // own toast (see notifyCompletions below). Only meaningful for an *owned* download; an adopted
  // one has no such list (see the generic toast in the terminal-detection effect further down).
  const requestedImagesRef = useRef<string[]>([]);
  // How many of `requestedImagesRef` have already gotten their own toast, so a re-render (or the
  // poll ticking again) never re-announces the same completed image twice.
  const notifiedCountRef = useRef(0);

  // One toast *per image*, not one for the whole batch: fired as each image's completion is
  // observed in the poll (`images_done` advancing), so a slow multi-image download narrates
  // itself image by image instead of going silent until everything is done.
  const notifyCompletions = useCallback(
    (imagesDone: number) => {
      const images = requestedImagesRef.current;
      for (let i = notifiedCountRef.current; i < imagesDone && i < images.length; i++) {
        toast.show(pulledMessage(images[i]), "success");
      }
      notifiedCountRef.current = Math.max(notifiedCountRef.current, imagesDone);
    },
    [toast],
  );

  const progress = useImagePullProgress(phase === "running");

  const settle = useCallback((outcome: ImageDownloadOutcome) => {
    setShow(false);
    resolveRef.current?.(outcome);
    resolveRef.current = null;
  }, []);

  const startPull = useCallback((images: string[], mandatory: boolean) => {
    percentRef.current = { image: null, value: null };
    setError(null);
    ownedRef.current = true;
    mandatoryRef.current = mandatory;
    requestedImagesRef.current = images;
    notifiedCountRef.current = 0;
    setPhase("running");
    // Deliberately not awaited: the bar is driven by the poll, while this promise is the
    // authoritative completion signal. Same fire-and-poll shape as the desktop setup page.
    api
      .pullImages(images)
      .then(() => {
        setPhase("done");
        // Catch-up pass: the request itself just told us every requested image is done, which
        // can race ahead of the next poll tick (a small/cached image can finish between two
        // 800ms polls) — this guarantees a toast still fires for whichever ones the poll-driven
        // notifyCompletions above hasn't announced yet, fired even if the user already closed
        // the modal (see the "Closing this leaves the download running" note in the footer
        // below) — polling keeps running in that case, since `phase` isn't reset by `settle`.
        notifyCompletions(images.length);
      })
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? e.message : "The download failed.");
        setPhase("error");
        toast.reportError("Image download failed", e);
      });
  }, [notifyCompletions, toast]);

  const requestImageDownload = useCallback<ImageDownloadApi>(
    async (next) => {
      // Settle any still-pending request before taking over the single resolveRef slot — same
      // guard as ConfirmContext/PromptContext/ElevationContext.
      resolveRef.current?.("cancelled");
      resolveRef.current = null;

      if (!next.missing.length && !next.outdated.length) return "skipped";

      setStatus(next);
      setIncludeUpdates(next.update_policy === "Always");
      setError(null);
      ownedRef.current = false;

      // A download already running (the user closed this modal earlier and pressed Deploy again)
      // must be adopted, not restarted: a second POST would get a legitimate 409 the user would
      // have no way to make sense of.
      const inFlight = await api.getImagePullProgress().catch(() => null);
      if (inFlight?.active) {
        percentRef.current = { image: null, value: null };
        // We can't know what the in-flight download was asked to fetch, so fall back to this
        // lab's own needs: if it is missing an image, a failure has to be treated as fatal.
        mandatoryRef.current = next.missing.length > 0;
        setPhase("running");
      } else if (next.update_policy === "Always" && !next.missing.length) {
        // Matches the CLI's `Always` policy: take the update without asking.
        startPull(next.outdated, false);
      } else {
        setPhase("confirm");
      }
      setShow(true);
      return new Promise<ImageDownloadOutcome>((resolve) => {
        resolveRef.current = resolve;
      });
    },
    [startPull],
  );

  // Live per-image toasts for an *owned* download, as the poll observes `images_done` advance —
  // this is what makes a slow multi-image download narrate itself one image at a time instead of
  // going quiet until `startPull`'s own catch-up pass fires at the very end.
  useEffect(() => {
    if (phase !== "running" || !ownedRef.current || !progress) return;
    notifyCompletions(progress.images_done);
  }, [phase, progress, notifyCompletions]);

  // Terminal detection for an *adopted* download, which has no promise of ours to settle and no
  // requested-images list to name individually — we don't know here which images the *other*
  // window asked for, so the wording stays generic rather than guessing from this lab's own
  // pre-check.
  useEffect(() => {
    if (phase !== "running" || ownedRef.current || !progress) return;
    if (!progress.finished) return;
    if (progress.error) {
      setError(progress.error);
      setPhase("error");
      toast.show(`Image download failed: ${progress.error}`, "danger");
    } else {
      setPhase("done");
      toast.show(pulledMessage(), "success");
    }
  }, [phase, progress, toast]);

  const kind = status ? downloadKind(status) : "missing";
  const updateCount = status?.outdated.length ?? 0;

  let percent: number | null = null;
  if (progress?.active) {
    const image = progress.image ?? null;
    if (percentRef.current.image !== image) percentRef.current = { image, value: null };
    percent = progressPercent(percentRef.current.value, progress.downloaded_bytes, progress.total_bytes);
    percentRef.current.value = percent;
  }

  const elapsed = progress?.elapsed_seconds ?? 0;

  const reopen = useCallback(() => setShow(true), []);
  const downloadStatus: ImageDownloadStatus = {
    active: phase === "running" && !show,
    progress,
    reopen,
  };

  // A failed download is only fatal when the lab was missing an image. If it was an optional
  // update, the images on disk are still fine and the deploy should carry on.
  const errorOutcome: ImageDownloadOutcome = mandatoryRef.current ? "cancelled" : "skipped";

  const dismissOutcome: ImageDownloadOutcome =
    phase === "done"
      ? "downloaded"
      : phase === "error"
        ? errorOutcome
        : phase === "confirm" && kind === "outdated"
          ? "skipped"
          : "cancelled";

  return (
    <ImageDownloadCtx.Provider value={requestImageDownload}>
      <ImageDownloadStatusCtx.Provider value={downloadStatus}>{children}</ImageDownloadStatusCtx.Provider>
      {/* `onHide` covers the header's close button (the backdrop is static). It has to agree
          with the footer buttons: dismissing the success state is still a completed download, and
          dismissing a declined *optional* update is still "carry on and deploy". */}
      <Modal show={show} onHide={() => settle(dismissOutcome)} centered backdrop="static">
        <Modal.Header closeButton>
          <Modal.Title>
            {phase === "done" ? "Images ready" : phase === "error" ? "Download failed" : TITLES[kind]}
          </Modal.Title>
        </Modal.Header>

        <Modal.Body>
          {phase === "confirm" && status && kind === "missing" && (
            <>
              <p className="mb-2">This lab needs Docker images that aren&apos;t on your machine yet:</p>
              <ImageList names={status.missing} />
              <p className="kt-image-dl-hint mb-0">
                They have to be downloaded before the lab can start. This can take a few minutes,
                and it only happens once — later deploys reuse them.
              </p>
            </>
          )}

          {phase === "confirm" && status && kind === "outdated" && (
            <>
              <p className="mb-2">
                A new version of {status.outdated.length > 1 ? "these images" : "image"}{" "}
                {status.outdated.map((name, i) => (
                  <span key={name}>
                    {i > 0 && ", "}
                    <code>{name}</code>
                  </span>
                ))}{" "}
                has been found on Docker Hub. Do you want to pull it?
              </p>
              <p className="kt-image-dl-hint mb-0">
                Devices that are already running keep the image they started with until they are
                redeployed.
              </p>
            </>
          )}

          {phase === "confirm" && status && kind === "both" && (
            <>
              <p className="mb-2">This lab needs Docker images that aren&apos;t on your machine yet:</p>
              <ImageList names={status.missing} />
              <Form.Check
                type="checkbox"
                id="kt-image-dl-updates"
                className="mt-3"
                checked={includeUpdates}
                onChange={(e) => setIncludeUpdates(e.currentTarget.checked)}
                label={`Also update ${updateCount} image${updateCount === 1 ? "" : "s"} that ${
                  updateCount === 1 ? "has" : "have"
                } a newer version`}
              />
              <ImageList names={status.outdated} />
              <p className="kt-image-dl-hint mb-0">
                This can take a few minutes. Missing images are required; updates are optional.
              </p>
            </>
          )}

          {phase === "running" && (
            <>
              <div className="kt-image-dl-detail">
                <Loader2 size={14} className="kt-explorer-spin" />
                <span>{progress?.detail || "Preparing download…"}</span>
                {elapsed >= 5 && <span className="kt-image-dl-elapsed">— {Math.round(elapsed)}s</span>}
              </div>
              {percent === null ? (
                <ProgressBar animated striped now={100} className="mt-2" />
              ) : (
                <ProgressBar now={percent} className="mt-2" />
              )}
              {progress && progress.total_bytes > 0 && (
                <div className="kt-image-dl-bytes">
                  {formatBytes(progress.downloaded_bytes)} / {formatBytes(progress.total_bytes)}
                  {progress.images_total > 1 &&
                    // Clamped: the terminal snapshot sets images_done to the full count, which would
                    // otherwise render as "image 3 of 2" if it lands before the phase flips.
                    ` · image ${Math.min(progress.images_done + 1, progress.images_total)} of ${progress.images_total}`}
                </div>
              )}
              <p className="kt-image-dl-hint mt-3 mb-0">{RUNNING_HINT}</p>
            </>
          )}

          {phase === "done" && (
            <p className="mb-0">All the needed Docker images are downloaded. You are ready to deploy the lab.</p>
          )}

          {phase === "error" && (
            <>
              <Alert variant="danger" className="mb-0">
                {error}
              </Alert>
              {!mandatoryRef.current && (
                <p className="kt-image-dl-hint mt-2 mb-0">
                  This was an optional update — the lab can still be deployed with the image you
                  already have.
                </p>
              )}
            </>
          )}
        </Modal.Body>

        <Modal.Footer>
          {phase === "confirm" && (
            <>
              <Button variant="secondary" onClick={() => settle(kind === "outdated" ? "skipped" : "cancelled")}>
                {kind === "outdated" ? "Skip" : "Cancel"}
              </Button>
              <Button
                variant="primary"
                onClick={() =>
                  startPull(
                    kind === "outdated"
                      ? (status?.outdated ?? [])
                      : [...(status?.missing ?? []), ...(includeUpdates ? (status?.outdated ?? []) : [])],
                    kind !== "outdated",
                  )
                }
              >
                {kind === "outdated" ? "Update" : "Download"}
              </Button>
            </>
          )}

          {phase === "running" && (
            <>
              {/* No Cancel: the Docker SDK offers no clean way to abort a pull mid-stream, so a
                  cancel button would be a lie. Closing just stops watching it. */}
              <span className="kt-image-dl-hint me-auto">
                Closing this leaves the download running in the background.
              </span>
              <Button variant="secondary" onClick={() => settle("cancelled")}>
                Close
              </Button>
            </>
          )}

          {(phase === "done" || phase === "error") && (
            <Button
              variant={phase === "done" ? "primary" : "secondary"}
              onClick={() => settle(phase === "done" ? "downloaded" : errorOutcome)}
            >
              Close
            </Button>
          )}
        </Modal.Footer>
      </Modal>
    </ImageDownloadCtx.Provider>
  );
}

export function useImageDownload(): ImageDownloadApi {
  const ctx = useContext(ImageDownloadCtx);
  if (!ctx) throw new Error("useImageDownload must be used within an ImageDownloadProvider");
  return ctx;
}

/** Whether a Docker image download is running with its modal closed, for the navbar badge. */
export function useImageDownloadStatus(): ImageDownloadStatus {
  const ctx = useContext(ImageDownloadStatusCtx);
  if (!ctx) throw new Error("useImageDownloadStatus must be used within an ImageDownloadProvider");
  return ctx;
}
