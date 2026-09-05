import { useCallback } from "react";
import { useConfirm } from "../context/ConfirmContext";
import { usePrompt } from "../context/PromptContext";
import { useToast } from "../context/ToastContext";
import { desktop } from "../desktop/bridge";
import { useDeployAuthorization } from "../desktop/ElevationContext";
import { useReclaimLabsDirAuth } from "../desktop/ReclaimLabsDirContext";
import { api, ApiError } from "../services/api";
import type { VolumeMount } from "../services/types";
import { useBusyAction } from "./useBusyAction";

const PRIVILEGE_CANCELLED_MESSAGE =
  "Deploy cancelled — this lab has privileged devices and needs administrator privileges.";
const VOLUME_CANCELLED_MESSAGE =
  "Deploy cancelled — this lab mounts host directories and needs confirmation.";

// Best-effort, never lets a failure here read as the undeploy/wipe itself having failed (which
// already succeeded by the time this runs) — see ElevationContext.tsx and backend.ts's
// stopBackend/startBackend for why an elevated backend can't just have its privileges "turned
// off" in place. `openLab`, if given, is where the reload (if the backend was actually elevated
// and this triggers one) should land back on, instead of losing the current lab selection.
//
// `requestReclaimAuth`, from ReclaimLabsDirContext.tsx, is only ever invoked on Linux (dropElevation
// only ever asks for it there — macOS/Windows resolve any reclaim themselves via their own native
// prompt): a first call can come back with `needsReclaimPassword`, meaning the backend hasn't
// actually been stopped yet and files an elevated session left root-owned still need a password
// to fix — that modal is awaited here, then a second call (`skipReclaimCheck: true`) actually
// drops the elevation regardless of what the user chose in it.
async function dropElevationIfAny(
  openLab: string | undefined,
  requestReclaimAuth: () => Promise<"reclaimed" | "skipped">,
): Promise<void> {
  try {
    const result = await desktop()?.dropElevation(openLab);
    if (result?.needsReclaimPassword) {
      await requestReclaimAuth();
      await desktop()?.dropElevation(openLab, true);
    }
  } catch {
    /* best-effort */
  }
}

// Deploy/undeploy toggle and delete, shared between the lab list and lab detail pages (same
// branching, toast wording, and confirm-dialog copy on both).
export function useLabLifecycleActions() {
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const runBusy = useBusyAction();
  const requestDeployAuth = useDeployAuthorization();
  const requestReclaimAuth = useReclaimLabsDirAuth();

  const deployToggle = useCallback(
    async (
      lab: {
        name: string;
        deployed: boolean;
        machines: { name: string; privileged: boolean; volumes: VolumeMount[] }[];
      },
      setBusy: (busy: boolean) => void,
      onDone: () => Promise<void>,
    ) => {
      await runBusy(setBusy, lab.deployed ? "Undeploy" : "Deploy", async () => {
        if (lab.deployed) {
          try {
            await api.undeployLab(lab.name);
          } catch (e) {
            // A half-finished undeploy leaves devices up, so refresh before the error
            // propagates — see the deploy path below for why.
            await onDone().catch(() => {});
            throw e;
          }
          toast.show(`Lab "${lab.name}" undeployed.`, "success");
          // Least-privilege: don't leave the backend running as root once nothing it's doing
          // needs that. A no-op if it wasn't elevated (the common case) or outside the desktop app.
          await dropElevationIfAny(lab.name, requestReclaimAuth);
          await onDone();
          return;
        }

        // Kathara's own privileged-device gate needs the whole backend process's real UID to be
        // 0 — on the desktop app, that means relaunching the backend as root first. A volume
        // mount doesn't need that, but still needs the user's own password before it happens.
        // Precheck client-side (we already know each device's `privileged`/`volumes`) so the
        // prompt appears before the attempt, not after — and as a single combined check, so a
        // lab that is both never shows two separate prompts in sequence (see
        // ElevationContext.tsx's "both" mode for why that matters).
        //
        // `hosthome_mount` is the same kind of host exposure but a *global* setting (Settings'
        // own save already gates turning it on — see SettingsPage.tsx), so every deploy while
        // it's on needs to say so too: it applies to this lab's devices whether or not this lab
        // itself declares any `volumes`. Fetched fresh rather than cached, since it can change
        // between deploys and there is nothing else in this app that already tracks it.
        const hosthomeMount = await api
          .getSettings()
          .then((s) => !!s.hosthome_mount)
          .catch(() => false); // fail open to "off" — the deploy attempt itself will surface anything real
        const volumeMachines = lab.machines.filter((m) => m.volumes.length > 0);
        const needsElevation = lab.machines.some((m) => m.privileged);
        if (needsElevation || volumeMachines.length > 0 || hosthomeMount) {
          const outcome = await requestDeployAuth({
            privileged: needsElevation,
            volumeMachines,
            hosthomeMount,
            resumeLab: lab.name,
          });
          if (outcome === "elevating") return; // a reload is already coming
          if (outcome === "cancelled") {
            toast.show(needsElevation ? PRIVILEGE_CANCELLED_MESSAGE : VOLUME_CANCELLED_MESSAGE, "danger");
            return;
          }
          // "proceed": fall through and deploy normally.
        }

        try {
          await api.deployLab(lab.name);
        } catch (e) {
          // Reactive fallback for the precheck above: a device can be made privileged via a raw
          // lab.conf edit that bypasses the UI's `privileged` field entirely. No equivalent
          // exists for volumes — `MachineDetail.volumes` read from the last `detail` is already
          // accurate, there is no "discovered only on failure" case for it.
          if (e instanceof ApiError && e.errorType === "PrivilegeError") {
            const outcome = await requestDeployAuth({ privileged: true, volumeMachines: [], resumeLab: lab.name });
            if (outcome === "elevating") return;
            if (outcome === "cancelled") {
              toast.show(PRIVILEGE_CANCELLED_MESSAGE, "danger");
              return;
            }
            // Already elevated yet still refused — elevation won't fix this one, surface it as-is.
          }
          // Deploy isn't atomic: it can fail with some devices already up. Refresh before
          // letting the error propagate, or the UI goes on showing the lab as undeployed —
          // and offering a Deploy button — until something unrelated happens to refetch.
          // Swallowed on its own failure: the deploy error is the one worth reporting.
          await onDone().catch(() => {});
          throw e;
        }
        // The elevation `return`s above deliberately skip this: nothing was deployed, and on
        // the "elevating" path a full reload is already in flight.
        toast.show(`Lab "${lab.name}" deployed.`, "success");
        await onDone();
      });
    },
    [requestDeployAuth, requestReclaimAuth, runBusy, toast],
  );

  const deleteLab = useCallback(
    async (name: string, setBusy: (busy: boolean) => void, onDone: () => Promise<void>) => {
      const ok = await confirm({
        title: `Delete ${name}?`,
        message: `This undeploys and removes lab "${name}".`,
        okLabel: "Delete",
      });
      if (!ok) return;
      await runBusy(setBusy, "Delete", async () => {
        await api.deleteLab(name);
        toast.show(`Lab "${name}" deleted.`, "success");
        await onDone();
      });
    },
    [confirm, runBusy, toast],
  );

  // Renames the lab's on-disk directory. The backend refuses (409) while the lab is deployed —
  // surfaced as an error toast by runBusy, no special-casing needed here. `onDone` receives the
  // new name so callers can follow the lab (e.g. navigate to its new route).
  const renameLab = useCallback(
    async (name: string, setBusy: (busy: boolean) => void, onDone: (newName: string) => Promise<void>) => {
      const newName = await prompt({
        title: `Rename ${name}`,
        message: "New lab name (letters, digits, dot, dash or underscore).",
        defaultValue: name,
        placeholder: name,
        okLabel: "Rename",
      });
      if (!newName || newName === name) return;
      await runBusy(setBusy, "Rename", async () => {
        await api.renameLab(name, newName);
        toast.show(`Lab "${name}" renamed to "${newName}".`, "success");
        await onDone(newName);
      });
    },
    [prompt, runBusy, toast],
  );

  // Force-undeploys every lab kathara-desktop has deployed, not just `openLab`'s — but unlike the
  // Kathara CLI's own `kathara wipe`, it leaves scenarios started by other tools alone. `openLab`
  // (the lab currently open, if any) is only used to land a privilege-drop reload back on it.
  const wipeAll = useCallback(
    async (openLab: string | undefined, setBusy: (busy: boolean) => void, onDone: () => Promise<void>) => {
      const ok = await confirm({
        title: "Wipe all labs?",
        message: "This force-undeploys every lab running in kathara-desktop, not just the one open here.",
        okLabel: "Wipe all",
      });
      if (!ok) return;
      await runBusy(setBusy, "Wipe all", async () => {
        await api.wipeAll();
        toast.show("All labs wiped.", "success");
        await dropElevationIfAny(openLab, requestReclaimAuth);
        await onDone();
      });
    },
    [confirm, requestReclaimAuth, runBusy, toast],
  );

  return { deployToggle, deleteLab, renameLab, wipeAll };
}
