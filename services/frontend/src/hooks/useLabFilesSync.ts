import { useEffect, useMemo, useRef } from "react";
import { useWorkspaceCore } from "../context/WorkspaceCoreContext";
import { withChangeNotice } from "../services/labFilesSync";
import type { FsTreeSource } from "./useFsTree";

// Keeps the trees over the open lab's folder in step: the Lab Configuration tree and each device's
// Files tab browse the same files (a device's folder, `shared/`), and the backend's disk watcher
// reports lab.conf and startup scripts only. Each tree announces its own changes through
// WorkspaceCoreContext's `notifyLabFilesChanged`, and re-reads on anyone else's.

/** `source`, announcing each change it makes as coming from `origin` (the tree's scope key). */
export function useAnnouncingSource(origin: string, source: FsTreeSource): FsTreeSource {
  const { notifyLabFilesChanged } = useWorkspaceCore();
  return useMemo(
    () => withChangeNotice(source, () => notifyLabFilesChanged(origin)),
    [notifyLabFilesChanged, origin, source],
  );
}

/** Calls `onChange` whenever a tree other than `origin` changed the lab's files. With no
 *  `origin`, for every change, including a tree's own. */
export function useOnLabFilesChanged(onChange: () => void, origin?: string): void {
  const { labFilesChange } = useWorkspaceCore();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // A change made before this mounted is already in what it reads first.
  const seenSeq = useRef(labFilesChange?.seq);
  useEffect(() => {
    if (!labFilesChange || labFilesChange.seq === seenSeq.current) return;
    seenSeq.current = labFilesChange.seq;
    if (labFilesChange.origin !== origin) onChangeRef.current();
  }, [labFilesChange, origin]);
}
