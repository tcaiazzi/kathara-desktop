import { useEffect, useMemo, useState } from "react";
import { api } from "../services/api";
import type { AutocompleteSection } from "../components/AutocompleteInput";
import type { AvailableImages } from "../services/types";

// Module-level cache shared by every component using this hook, so opening "Add device"/the
// options editor/Settings repeatedly doesn't re-fetch the catalog every time (the backend caches
// the Docker Hub half server-side too — see KatharaService.list_available_images — but this also
// saves the round trip). A failed fetch degrades to empty lists rather than surfacing an error:
// these are suggestions for a free-text "image" field, never a requirement.
//
// TTL'd rather than held for the whole page lifetime, because the list now includes the machine's
// *local* Docker images: an image the user pulls mid-session has to become suggestable without
// reloading the app. Matches the backend's own KatharaService._IMAGES_CACHE_TTL.
const CACHE_TTL_MS = 300_000;

const NONE: AvailableImages = { official: [], local: [] };

let cache: Promise<AvailableImages> | null = null;
let cachedAt = 0;

function fetchAvailableImages(): Promise<AvailableImages> {
  if (!cache || Date.now() - cachedAt >= CACHE_TTL_MS) {
    cachedAt = Date.now();
    cache = api.listAvailableImages().catch(() => NONE);
  }
  return cache;
}

// Docker images to suggest on an "image" input: the official Kathara ones published on Docker Hub
// and whatever is already present on this machine's Docker daemon, kept apart so the picker can
// show them as two labelled sections. The field must stay free text (any valid Docker image is
// still accepted) — this only helps the user find one.
export function useAvailableImages(): AvailableImages {
  const [images, setImages] = useState<AvailableImages>(NONE);
  useEffect(() => {
    let cancelled = false;
    fetchAvailableImages().then((next) => {
      if (!cancelled) setImages(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return images;
}

// The same suggestions as one flat list, for a consumer that has nowhere to put section headings
// (the lab.conf editor's CodeMirror completions). Official first, for the same reason the picker
// shows them first: a machine can hold hundreds of unrelated images.
export function useAvailableImageList(): string[] {
  const { official, local } = useAvailableImages();
  // Memoized because the caller keys a CodeMirror Compartment reconfigure on this value: a fresh
  // array every render would re-dispatch that on every parent render for no change.
  return useMemo(() => [...official, ...local], [official, local]);
}

// The same suggestions as labelled AutocompleteInput sections, so every "image" field in the app
// heads them identically. A source with nothing to offer contributes no section rather than an
// empty heading — which is the normal state for `local` with the Docker daemon stopped, and for
// `official` offline.
export function useAvailableImageSections(): AutocompleteSection[] {
  const { official, local } = useAvailableImages();
  return useMemo(
    () =>
      [
        { label: "Official Kathara images", options: official },
        { label: "On this machine", options: local },
      ].filter((section) => section.options.length > 0),
    [official, local],
  );
}
