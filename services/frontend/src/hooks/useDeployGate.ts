import { useCallback } from "react";
import { api } from "../services/api";
import { useDeployAuthorization, type DeployAuthOutcome } from "../desktop/ElevationContext";
import type { VolumeMount } from "../services/types";

// The one place that decides whether a deploy needs the user's permission first, shared by every
// path that can put a container on the host: a full-lab deploy, a single-device redeploy, and
// adding a device to a lab that is already running (`add_machine` deploys it outright in that
// case — see KatharaService.add_machine).
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
  /** Whether any device involved is `privileged` — needs the backend itself running as root, not
   * just a confirmation. Only the full-lab deploy sets this: the single-device paths have no way
   * to resume across the reload an elevation triggers. */
  privileged?: boolean;
  /** Where the post-reload URL should land so the SPA can resume on its own; only meaningful when
   * `privileged` leads to a real elevation. */
  resumeLab?: string;
}

/** Returns a function that asks for whatever authorization this deploy needs and reports what the
 * user decided. `"proceed"` also covers "nothing needed asking" — callers only have to handle the
 * three outcomes, not work out whether a prompt was due. */
export function useDeployGate(): (req?: DeployGateRequest) => Promise<DeployAuthOutcome> {
  const requestDeployAuth = useDeployAuthorization();

  return useCallback(
    async ({ volumeMachines = [], privileged = false, resumeLab }: DeployGateRequest = {}) => {
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
      // hosthome is off. Re-deriving that condition at each call site is what let the three
      // copies drift in the first place.
      return requestDeployAuth({
        privileged,
        // A device with no volumes of its own still reaches here when `hosthome_mount` alone
        // triggers the prompt; dropping it keeps the modal from rendering an empty volume list.
        volumeMachines: volumeMachines.filter((m) => m.volumes.length > 0),
        hosthomeMount,
        resumeLab,
      });
    },
    [requestDeployAuth],
  );
}
