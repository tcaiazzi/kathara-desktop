import { Badge } from "react-bootstrap";
import { useHealth } from "../hooks/useHealth";
import { useIsAdmin } from "../hooks/useIsAdmin";

// The two badges both top bars show — the browser navbar and the desktop title bar — kept here so
// they cannot drift apart in wording or colour. Each owns its own probe rather than taking a prop:
// neither bar needs the value for anything else, and only one of the two is ever mounted.
//
// Two components rather than one, so the desktop title bar can keep its own docker badge in the
// middle, where it has always been.

/** Shown only when the local backend is running as root — an unusual state worth surfacing. */
export function PrivilegedBadge() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return null;
  return (
    <Badge bg="warning" title="The local Kathara API is running with administrator privileges">
      privileged
    </Badge>
  );
}

export function HealthBadge() {
  const health = useHealth();
  return (
    <Badge bg={health === "ok" ? "success" : health === "down" ? "danger" : "secondary"}>
      {health === "checking" ? "checking…" : health === "ok" ? "healthy" : "server unreachable"}
    </Badge>
  );
}
