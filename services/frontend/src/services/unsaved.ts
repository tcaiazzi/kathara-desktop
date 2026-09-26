// The wording of the "Discard unsaved changes?" confirmation, shared by every place that can throw
// an editor buffer away: switching lab or page (context/UnsavedChangesContext.tsx) and switching
// the device a filesystem panel browses (hooks/useFsTree.ts's `confirmLeave`). Kept apart from both
// so the sentence is built — and tested — in one place.

/** One sentence naming what would be lost; `labels` describe each dirty buffer. */
export function describeUnsaved(labels: readonly string[]): string {
  const unique = [...new Set(labels)];
  if (unique.length === 0) return "Unsaved changes will be lost.";
  if (unique.length === 1) return `Your unsaved edits to ${unique[0]} will be lost.`;
  const list = `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
  return `Your unsaved edits to ${list} will be lost.`;
}
