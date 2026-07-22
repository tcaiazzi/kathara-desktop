import { useCallback } from "react";
import { useConfirm } from "../context/ConfirmContext";

interface ConfirmDiscardOptions {
  currentPath: string | null;
  nextPath: string;
  hasUnsavedChanges: boolean;
}

// Prompts "Discard unsaved changes?" before switching away from a dirty file; resolves true
// immediately (no prompt) when there's nothing to lose (no current file, same file, or clean).
export function useConfirmDiscard() {
  const confirm = useConfirm();
  return useCallback(
    ({ currentPath, nextPath, hasUnsavedChanges }: ConfirmDiscardOptions): Promise<boolean> => {
      if (!currentPath || currentPath === nextPath || !hasUnsavedChanges) return Promise.resolve(true);
      return confirm({
        title: "Discard unsaved changes?",
        message: `You have unsaved edits in ${currentPath}. Switch to ${nextPath} and discard changes?`,
        okLabel: "Discard",
      });
    },
    [confirm],
  );
}
