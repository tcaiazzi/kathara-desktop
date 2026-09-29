import { useCallback } from "react";
import { api } from "../services/api";
import { useDeployAuthorization, type DeployAuthOutcome } from "../desktop/ElevationContext";
import type { VolumeMount } from "../services/types";

// The one place that decides whether a deploy needs the user's permission first, shared by every
// path that can put a container on the host: a full-lab deploy and a single-device deploy. Adding a
// device never starts it (KatharaService.add_machine), so it has nothing to ask. The backend
// enforces the same rule on its own (KatharaService._authorize_host_access), refusing a deploy the
// desktop shell didn't grant — this gate is what asks for the password that grant needs, before
// the attempt rather than after it.
//
// Two things have to be checked together, and only here: the per-device `volumes` and the global
// `hosthome_mount` setting, which is host exposure of the same kind but belongs to no device and
// applies whether or not a lab declares any volume. Re-deriving either test at a call site
// defeats the gate — a path that checks volumes alone bind-mounts the operator's real $HOME with
// no prompt at all.

interface DeployGateRequest {
  /** Devices whose own `volumes` would be mounted. Entries without volumes are dropped, so
   * callers can pass a device unconditionally without having to pre-filter. */
  volumeMachines?: { name: string; volumes: VolumeMount[] }[];
  /** Whether any device involved is `privileged`. */
  privileged?: boolean;
  /** The lab being deployed, which the password grants the deploy of. */
  labId: string;
}

/** Returns a function that asks for whatever authorization this deploy needs and reports what the
 * user decided. `"proceed"` also covers "nothing needed asking" — callers only have to handle the
 * three outcomes, not work out whether a prompt was due. */
export function useDeployGate(): (req: DeployGateRequest) => Promise<DeployAuthOutcome> {
  const requestDeployAuth = useDeployAuthorization();

  return useCallback(
    async ({ volumeMachines = [], privileged = false, labId }: DeployGateRequest) => {
      // Fetched fresh on every deploy rather than cached: it can change between deploys, and
      // nothing else in this app tracks it. Fail open to "off" — if even reading the settings
      // fails, the deploy attempt itself will surface anything real, and a prompt nobody can
      // answer correctly is worse than no prompt.
      const hosthomeMount = await api
        .getSettings()
        .then((s) => !!s.hosthome_mount)
        .catch(() => false);

      // No "is a prompt needed?" test here on purpose: `requestDeployAuthorization` already
      // short-circuits to "proceed" when nothing is privileged, no volumes are mounted and
      // hosthome is off. No call site may re-derive it: a path that decides for itself whether a
      // prompt is needed stops asking for exactly the deploys this gate exists to catch.
      return requestDeployAuth({
        privileged,
        // A device with no volumes of its own still reaches here when `hosthome_mount` alone
        // triggers the prompt; dropping it keeps the modal from rendering an empty volume list.
        volumeMachines: volumeMachines.filter((m) => m.volumes.length > 0),
        hosthomeMount,
        labId,
      });
    },
    [requestDeployAuth],
  );
}
