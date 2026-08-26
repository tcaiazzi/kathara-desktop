import { useCallback } from "react";
import { useConfirm } from "../context/ConfirmContext";
import { usePrompt } from "../context/PromptContext";
import { useToast } from "../context/ToastContext";
import { api } from "../services/api";
import { useBusyAction } from "./useBusyAction";

// Deploy/undeploy toggle and delete, shared between the lab list and lab detail pages (same
// branching, toast wording, and confirm-dialog copy on both).
export function useLabLifecycleActions() {
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const runBusy = useBusyAction();

  const deployToggle = useCallback(
    async (
      lab: { name: string; deployed: boolean },
      setBusy: (busy: boolean) => void,
      onDone: () => Promise<void>,
    ) => {
      await runBusy(setBusy, lab.deployed ? "Undeploy" : "Deploy", async () => {
        if (lab.deployed) {
          await api.undeployLab(lab.name);
          toast.show(`Lab "${lab.name}" undeployed.`, "success");
        } else {
          await api.deployLab(lab.name);
          toast.show(`Lab "${lab.name}" deployed.`, "success");
        }
        await onDone();
      });
    },
    [runBusy, toast],
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

  // `kathara wipe` — force-undeploys every running network scenario, not just `name`'s.
  const wipeAll = useCallback(
    async (setBusy: (busy: boolean) => void, onDone: () => Promise<void>) => {
      const ok = await confirm({
        title: "Wipe all labs?",
        message: "This force-undeploys every running network scenario, not just the one open here.",
        okLabel: "Wipe all",
      });
      if (!ok) return;
      await runBusy(setBusy, "Wipe all", async () => {
        await api.wipeAll();
        toast.show("All labs wiped.", "success");
        await onDone();
      });
    },
    [confirm, runBusy, toast],
  );

  return { deployToggle, deleteLab, renameLab, wipeAll };
}
