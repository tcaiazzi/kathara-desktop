import { useEffect, useState } from "react";
import { api } from "../services/api";

// Module-level cache shared by every component using this hook for the lifetime of the page, so
// opening "Add device"/the options editor/Settings repeatedly doesn't re-fetch Docker Hub's
// catalog every time (the backend already caches server-side too — see
// KatharaService.list_available_images — but this also saves the extra round trip). A failed
// fetch (Docker Hub unreachable) degrades to an empty list rather than surfacing an error: these
// are suggestions for a free-text "image" field, never a requirement, mirroring how the Kathara
// CLI's own settings menu silently falls back to manual entry.
let cache: Promise<string[]> | null = null;

function fetchAvailableImages(): Promise<string[]> {
  if (!cache) cache = api.listAvailableImages().catch(() => []);
  return cache;
}

// Official Kathara device images published on Docker Hub, for use as <datalist> suggestions on an
// "image" input — the field must stay free text (any valid Docker image is still accepted), this
// only helps the user find one of the official ones.
export function useAvailableImages(): string[] {
  const [images, setImages] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchAvailableImages().then((list) => {
      if (!cancelled) setImages(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return images;
}
