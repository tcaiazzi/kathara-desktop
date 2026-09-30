import { useCallback } from "react";
import { useConfirm } from "../context/ConfirmContext";
import { useImageDownload } from "../context/ImageDownloadContext";
import { usePrompt } from "../context/PromptContext";
import { useToast } from "../context/ToastContext";
import { desktop, type DesktopApi } from "../desktop/bridge";
import { useDeployGate } from "./useDeployGate";
import { api, ApiError } from "../services/api";
import { notFoundMessage, type DeployPhase } from "../services/imagePull";
import { validateLabName } from "../services/names";
import type { LabDetail, LabImagesStatus, LabRef, VolumeMount } from "../services/types";
import { useBusyAction } from "./useBusyAction";

const PRIVILEGE_CANCELLED_MESSAGE =
  "Deploy cancelled — this lab has privileged devices and needs your password.";
const VOLUME_CANCELLED_MESSAGE =
  "Deploy cancelled — this lab mounts host directories and needs confirmation.";

/**
 * The image pre-check, with every failure turned into `null`.
 *
 * The catch is deliberately total. This check exists purely to *inform* — to offer the image
 * download as its own consented step rather than letting Kathara pull silently inside
 * `POST /deploy` — so it must never be able to block a deploy that would otherwise work. A dead
 * Docker daemon, a 503, an unexpected manager, a timed-out registry: all of them mean "carry on",
 * and the deploy itself then reports whatever the real problem is, with the right message.
 * This is the single point where that guarantee lives.
 */
async function labImagesOrNull(labId: string): Promise<LabImagesStatus | null> {
  try {
    return await api.getLabImages(labId);
  } catch {
    return null;
  }
}

// Closes the race where Docker Desktop (macOS in particular — its daemon takes noticeably longer
// to come up than the shell/backend do) is still finishing startup at the exact moment the user
// hits Deploy: check_lab_images 503s, labImagesOrNull swallows it to null, and the modal below
// never opens even though the deploy itself succeeds a moment later once Docker is actually up.
// Bounded so a genuinely broken/uninstalled Docker doesn't hang the button forever — same cadence
// as DockerStatusContext's own down-state poll (POLL_MS_DOWN).
async function waitForDockerReady(shell: DesktopApi, timeoutMs = 15_000, intervalMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await shell.checkDocker().catch(() => null);
    if (status?.state === "ok") return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// A lab's name when it has one — a lab reconstructed from running containers alone may not.
function labLabel(lab: LabRef): string {
  return lab.name || lab.id;
}

// Every whole-lab action, with its image pre-check, authorization prompts, toasts and confirm copy:
// the deploy/undeploy toggle, rename, delete and close the workspace header offers (WorkspacePage),
// and wipe-all on the Settings page. Kept out of both because the branching is long enough to bury
// a page.
export function useLabLifecycleActions() {
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { run: runBusy } = useBusyAction();
  const ensureDeployAuthorized = useDeployGate();
  const requestImageDownload = useImageDownload();

  const deployToggle = useCallback(
    async (
      lab: LabRef & {
        deployed: boolean;
        machines: { name: string; privileged: boolean; volumes: VolumeMount[] }[];
      },
      setBusy: (busy: boolean) => void,
      onDone: () => Promise<void>,
      // Lets the caller relabel its button as the deploy moves out of the (possibly
      // multi-second) image pre-check and into the deploy proper — without it, a slow registry
      // looks like a frozen "Deploying…".
      onPhase?: (phase: DeployPhase) => void,
    ) => {
      await runBusy(setBusy, lab.deployed ? "Undeploy" : "Deploy", async () => {
        if (lab.deployed) {
          try {
            await api.undeployLab(lab.id);
          } catch (e) {
            // A half-finished undeploy leaves devices up, so refresh before the error
            // propagates — see the deploy path below for why.
            await onDone().catch(() => {});
            throw e;
          }
          toast.show(`Lab "${labLabel(lab)}" undeployed.`, "success");
          await onDone();
          return;
        }

        // Kathara pulls a missing device image *inside* deploy_lab, reporting progress only
        // through its own EventDispatcher — so from here it is indistinguishable from a hang.
        // Ask about it first instead: the download becomes its own visible, consented step, and
        // by the time the deploy runs there is nothing left to fetch. An available *update* is
        // offered the same way Kathara's CLI offers it (see ImageDownloadContext), honouring the
        // `image_update_policy` setting, which nothing else in this app acts on.
        //
        // Before the password prompt below on purpose: there is no point asking for a password
        // and then spending three minutes downloading.
        onPhase?.("checking");
        const shell = desktop();
        if (shell) await waitForDockerReady(shell);
        const images = await labImagesOrNull(lab.id);
        // An image the registry doesn't have can't be fixed by downloading, and the deploy would
        // fail on it: stop here, before any download or prompt, naming it.
        if (images?.not_found?.length) throw new Error(notFoundMessage(images.not_found));
        if (images && (images.missing.length > 0 || images.outdated.length > 0)) {
          onPhase?.("images");
          const outcome = await requestImageDownload(images);
          // "cancelled" — a required image was declined, or the download failed: don't deploy.
          // "downloaded" / "skipped" — everything needed is on disk (a declined optional update
          // leaves the current image), so carry straight on into the deploy.
          if (outcome === "cancelled") return;
        }
        onPhase?.("deploy");

        // A privileged device or a host mount needs the user's password before the backend lets
        // the deploy through. Precheck client-side (we already know each device's
        // `privileged`/`volumes`) so the prompt appears before the attempt, not after — and as a
        // single combined check, so a lab that is both never shows two separate prompts in
        // sequence (see ElevationContext.tsx's "both" mode for why that matters).
        //
        // The global `hosthome_mount` setting is the same kind of host exposure but is not a
        // per-device volume, and it applies whether or not this lab declares any: `useDeployGate`
        // reads it for every caller, so it cannot be checked on one deploy path and forgotten on
        // another.
        const authorize = async (machines: { privileged: boolean; name: string; volumes: VolumeMount[] }[]) => {
          const privileged = machines.some((m) => m.privileged);
          const outcome = await ensureDeployAuthorized({ labId: lab.id, privileged, volumeMachines: machines });
          if (outcome === "cancelled") {
            toast.show(privileged ? PRIVILEGE_CANCELLED_MESSAGE : VOLUME_CANCELLED_MESSAGE, "danger");
            return false;
          }
          return true;
        };
        if (!(await authorize(lab.machines))) return;

        try {
          try {
            await api.deployLab(lab.id);
          } catch (e) {
            // Reactive fallback for the precheck above: the backend judges the lab as it is on
            // disk, and a lab.conf edited outside the app can make a device privileged or mount a
            // host directory the `detail` this page last fetched doesn't show yet. Asked once
            // more with the lab re-read, then retried once; a second refusal is reported as is.
            if (!(e instanceof ApiError && e.errorType === "DeployNotAuthorizedError")) throw e;
            const fresh = await api.getLab(lab.id);
            if (!(await authorize(fresh.machines))) return;
            await api.deployLab(lab.id);
          }
        } catch (e) {
          // Deploy isn't atomic: it can fail with some devices already up. Refresh before
          // letting the error propagate, or the UI goes on showing the lab as undeployed —
          // and offering a Deploy button — until something unrelated happens to refetch.
          // Swallowed on its own failure: the deploy error is the one worth reporting.
          await onDone().catch(() => {});
          throw e;
        }
        toast.show(`Lab "${labLabel(lab)}" deployed.`, "success");
        await onDone();
      });
    },
    [ensureDeployAuthorized, requestImageDownload, runBusy, toast],
  );

  // Names the folder that goes: deleting a managed lab removes its whole directory for good.
  const deleteLab = useCallback(
    async (lab: LabRef & { path: string | null }, setBusy: (busy: boolean) => void, onDone: () => Promise<void>) => {
      const name = labLabel(lab);
      const ok = await confirm({
        title: `Delete ${name}?`,
        message: lab.path
          ? `The folder ${lab.path} and every file in it are permanently deleted — they are not moved to the trash. If the lab is running, its devices are stopped first.`
          : `This undeploys lab "${name}". It has no folder on disk.`,
        okLabel: "Delete",
      });
      if (!ok) return;
      await runBusy(setBusy, "Delete", async () => {
        await api.deleteLab(lab.id);
        toast.show(`Lab "${name}" deleted.`, "success");
        await onDone();
      });
    },
    [confirm, runBusy, toast],
  );

  // Forgets a lab opened from outside the labs folder. Its folder is the user's own, so nothing on
  // disk is touched — which is what the confirm has to make plain, next to a Delete that does
  // remove files for a managed lab.
  const closeLab = useCallback(
    async (lab: LabRef, setBusy: (busy: boolean) => void, onDone: () => Promise<void>) => {
      const name = labLabel(lab);
      const ok = await confirm({
        title: `Close ${name}?`,
        message: `This undeploys "${name}" if it is running and removes it from the list. Its folder and every file in it stay where they are — open it again any time with File → Open Lab from Folder.`,
        okLabel: "Close",
      });
      if (!ok) return;
      await runBusy(setBusy, "Close", async () => {
        await api.closeLab(lab.id);
        toast.show(`Lab "${name}" closed.`, "success");
        await onDone();
      });
    },
    [confirm, runBusy, toast],
  );

  // Renames the lab's on-disk directory. The backend refuses (409) while the lab is deployed —
  // surfaced as an error toast by runBusy, no special-casing needed here. `onDone` receives the
  // renamed lab, whose id is new (it is derived from the directory's path), so callers can follow
  // it to its new route.
  const renameLab = useCallback(
    async (lab: LabRef, setBusy: (busy: boolean) => void, onDone: (renamed: LabDetail) => Promise<void>) => {
      const name = labLabel(lab);
      const newName = await prompt({
        title: `Rename ${name}`,
        message: "New lab name (letters, digits, dot, dash or underscore).",
        defaultValue: name,
        placeholder: name,
        okLabel: "Rename",
        validate: validateLabName,
      });
      if (!newName || newName === name) return;
      await runBusy(setBusy, "Rename", async () => {
        const renamed = await api.renameLab(lab.id, newName);
        toast.show(`Lab "${name}" renamed to "${newName}".`, "success");
        await onDone(renamed);
      });
    },
    [prompt, runBusy, toast],
  );

  // Force-undeploys every lab kathara-desktop has deployed — but unlike the Kathara CLI's own
  // `kathara wipe`, it leaves scenarios started by other tools alone. Offered from Settings.
  const wipeAll = useCallback(
    async (setBusy: (busy: boolean) => void) => {
      const ok = await confirm({
        title: "Wipe all labs?",
        message: "This force-undeploys every lab running in kathara-desktop. Lab files stay on disk.",
        okLabel: "Wipe all",
      });
      if (!ok) return;
      await runBusy(setBusy, "Wipe all", async () => {
        const result = await api.wipeAll();
        if (result.failed.length > 0) {
          toast.show(result.detail, "danger");
        } else {
          toast.show("All labs wiped.", "success");
        }
      });
    },
    [confirm, runBusy, toast],
  );

  return { deployToggle, deleteLab, closeLab, renameLab, wipeAll };
}
