import { Loader2 } from "lucide-react";
import { Button } from "react-bootstrap";

interface CatalogInstallButtonProps {
  /** Already on disk: the button opens the lab rather than installing it. */
  installed: boolean;
  /** This row is the one being installed. */
  busy: boolean;
  /** Any row is being installed — every button is disabled, not just the busy one, so a second
   * click cannot start an install while the first is still going. */
  anyBusy: boolean;
  /** "Create" for an example, "Import" from the gallery. */
  idleLabel: string;
  /** "Creating…" / "Importing…". */
  busyLabel: string;
  onClick: () => void;
}

// The per-row action of both lab catalogues — the welcome screen's examples and the gallery's labs,
// each behind useCatalogInstall: install the lab, or open it once it is on disk. One component so
// the two lists' buttons look and disable alike.
export function CatalogInstallButton({
  installed,
  busy,
  anyBusy,
  idleLabel,
  busyLabel,
  onClick,
}: CatalogInstallButtonProps) {
  return (
    <Button
      size="sm"
      variant={installed ? "outline-secondary" : "outline-primary"}
      disabled={anyBusy}
      onClick={onClick}
    >
      {busy ? (
        <>
          <Loader2 size={14} className="kt-explorer-spin me-1" />
          {busyLabel}
        </>
      ) : installed ? (
        "Open"
      ) : (
        idleLabel
      )}
    </Button>
  );
}
