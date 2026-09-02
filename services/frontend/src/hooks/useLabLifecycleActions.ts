import { useCallback } from "react";
import { useConfirm } from "../context/ConfirmContext";
import { usePrompt } from "../context/PromptContext";
import { useToast } from "../context/ToastContext";
import { desktop } from "../desktop/bridge";
import { useElevate } from "../desktop/ElevationContext";
import { api, ApiError } from "../services/api";
import { useBusyAction } from "./useBusyAction";

const PRIVILEGE_CANCELLED_MESSAGE =
  "Deploy cancelled — this lab has privileged devices and needs administrator privileges.";

// Best-effort, never lets a failure here read as the undeploy/wipe itself having failed (which
// already succeeded by the time this runs) — see ElevationContext.tsx and backend.ts's
// stopBackend/startBackend for why an elevated backend can't just have its privileges "turned
// off" in place. `openLab`, if given, is where the reload (if the backend was actually elevated
// and this triggers one) should land back on, instead of losing the current lab selection.
async function dropElevationIfAny(openLab?: string): Promise<void> {
  try {
    await desktop()?.dropElevation(openLab);
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
  const requestElevation = useElevate();

  const deployToggle = useCallback(
    async (
      lab: { name: string; deployed: boolean; machines: { privileged: boolean }[] },
      setBusy: (busy: boolean) => void,
      onDone: () => Promise<void>,
    ) => {
      await runBusy(setBusy, lab.deployed ? "Undeploy" : "Deploy", async () => {
        if (lab.deployed) {
          await api.undeployLab(lab.name);
          toast.show(`Lab "${lab.name}" undeployed.`, "success");
          // Least-privilege: don't leave the backend running as root once nothing it's doing
          // needs that. A no-op if it wasn't elevated (the common case) or outside the desktop app.
          await dropElevationIfAny(lab.name);
          await onDone();
          return;
        }

        // Kathara's own privileged-device gate needs the whole backend process's real UID to be
        // 0 — on the desktop app, that means relaunching the backend as root first. Precheck
        // client-side (we already know each device's `privileged` flag) so the prompt appears
        // before the failed attempt, not after.
        if (lab.machines.some((m) => m.privileged)) {
          const outcome = await requestElevation(lab.name);
          if (outcome === "elevating") return; // a reload is already coming
          if (outcome === "cancelled") {
            toast.show(PRIVILEGE_CANCELLED_MESSAGE, "danger");
            return;
          }
          // "already-elevated": fall through and deploy normally.
        }

        try {
          await api.deployLab(lab.name);
        } catch (e) {
          // Reactive fallback for the precheck above: a device can be made privileged via a raw
          // lab.conf edit that bypasses the UI's `privileged` field entirely.
          if (e instanceof ApiError && e.errorType === "PrivilegeError") {
            const outcome = await requestElevation(lab.name);
            if (outcome === "elevating") return;
            if (outcome === "cancelled") {
              toast.show(PRIVILEGE_CANCELLED_MESSAGE, "danger");
              return;
            }
            // Already elevated yet still refused — elevation won't fix this one, surface it as-is.
          }
          throw e;
        }
        toast.show(`Lab "${lab.name}" deployed.`, "success");
        await onDone();
      });
    },
    [requestElevation, runBusy, toast],
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

  // Force-undeploys every lab kathara-ide has deployed, not just `openLab`'s — but unlike the
  // Kathara CLI's own `kathara wipe`, it leaves scenarios started by other tools alone. `openLab`
  // (the lab currently open, if any) is only used to land a privilege-drop reload back on it.
  const wipeAll = useCallback(
    async (openLab: string | undefined, setBusy: (busy: boolean) => void, onDone: () => Promise<void>) => {
      const ok = await confirm({
        title: "Wipe all labs?",
        message: "This force-undeploys every lab running in kathara-ide, not just the one open here.",
        okLabel: "Wipe all",
      });
      if (!ok) return;
      await runBusy(setBusy, "Wipe all", async () => {
        await api.wipeAll();
        toast.show("All labs wiped.", "success");
        await dropElevationIfAny(openLab);
        await onDone();
      });
    },
    [confirm, runBusy, toast],
  );

  return { deployToggle, deleteLab, renameLab, wipeAll };
}
