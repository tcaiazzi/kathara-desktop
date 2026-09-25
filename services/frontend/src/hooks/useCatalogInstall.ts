import { useState } from "react";
import { useToast } from "../context/ToastContext";
import { api, ApiError } from "../services/api";
import type { LabImportResult } from "../services/types";

/** What both catalogues have in common: a stable id to send to the API, and whether the lab is
 * already on disk (in which case the button opens it instead of installing it again). */
interface CatalogItem {
  id: string;
  installed: boolean;
}

interface CatalogInstallOptions<T extends CatalogItem> {
  install: (item: T) => Promise<LabImportResult>;
  /** The lab name to use when the response has none, and in the "already exists" message. The two
   * catalogues differ here: an example is identified by its id, a gallery entry carries a separate
   * local name alongside the repo path it is fetched by. */
  fallbackName: (item: T) => string;
  /** Past tense for the success toast — "created" for an example, "imported" from the gallery. */
  verbPast: string;
  /** Prefix for `toast.reportError` when the failure is not a 409. */
  errorLabel: string;
  /** Run once the lab exists, with its id. Closing the modal, if there is one, belongs here — the
   * gallery has to close *before* the workspace navigates. */
  onDone: (labId: string) => void;
}

/** The id of the already-installed lab called `name`, or null if there is none.
 *
 * Only the backend can derive a lab's id (it comes from the directory's path), so a lab this
 * client did not just create has to be looked up. A catalogue installs under the labs root, where
 * two labs cannot share a directory name — so the lookup is by name among `managed` labs only; a
 * folder opened from elsewhere may well carry the same name. */
async function installedLabId(name: string): Promise<string | null> {
  const labs = await api.listLabs();
  return labs.find((lab) => lab.managed && lab.name === name)?.id ?? null;
}

/** The install-or-open flow behind the welcome screen's examples and the gallery's labs.
 *
 * Deliberately not routed through `useBusyAction`: a 409 here is a benign race — another tab
 * installed the same lab between the list loading and this click — and deserves "opening it"
 * rather than that hook's automatic error toast.
 */
export function useCatalogInstall<T extends CatalogItem>({
  install,
  fallbackName,
  verbPast,
  errorLabel,
  onDone,
}: CatalogInstallOptions<T>) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function openInstalled(item: T) {
    const labId = await installedLabId(fallbackName(item));
    if (labId) onDone(labId);
  }

  async function run(item: T) {
    if (item.installed) {
      await openInstalled(item).catch((e) => toast.reportError(errorLabel, e));
      return;
    }
    setBusyId(item.id);
    try {
      const result = await install(item);
      // The API's name is optional (LabSummary.name, Optional[str] in the Pydantic schema), so
      // resolve it once against the catalogue entry's own name rather than letting the toast
      // print `Lab "null"` while the caller below gets the fallback.
      const name = result.name ?? fallbackName(item);
      toast.show(`Lab "${name}" ${verbPast}.`, "success");
      // Non-fatal parse warnings — a lab.conf directive the API keeps but doesn't apply. Both
      // catalogues surface them through this hook, so neither can drop them silently.
      if (result.warnings?.length) {
        toast.show(result.warnings.join(" · "), "info", "Import warnings");
      }
      onDone(result.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.show(`Lab "${fallbackName(item)}" already exists — opening it.`, "info");
        await openInstalled(item).catch((err) => toast.reportError(errorLabel, err));
      } else {
        toast.reportError(errorLabel, e);
      }
    } finally {
      setBusyId(null);
    }
  }

  return { busyId, install: run };
}
