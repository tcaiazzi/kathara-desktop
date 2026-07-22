import { useCallback } from "react";
import { useConfirm } from "../context/ConfirmContext";
import { useToast } from "../context/ToastContext";
import { api } from "../services/api";
import { useBusyAction } from "./useBusyAction";

// Deploy/undeploy toggle and delete, shared between the lab list and lab detail pages (same
// branching, toast wording, and confirm-dialog copy on both).
export function useLabLifecycleActions() {
  const toast = useToast();
  const confirm = useConfirm();
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

  return { deployToggle, deleteLab };
}
