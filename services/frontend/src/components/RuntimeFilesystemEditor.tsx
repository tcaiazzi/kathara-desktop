import { useEffect, useMemo, useRef, useState } from "react";
import { Form } from "react-bootstrap";
import { useFsTree, type FsTreeSource } from "../hooks/useFsTree";
import { api } from "../services/api";
import type { LabDetail } from "../services/types";
import { FsTreePanel } from "./FsTreePanel";

interface RuntimeFilesystemEditorProps {
  labName: string;
  detail: LabDetail;
  preferredMachine?: string | null;
}

// Browse/edit a running device's own filesystem, over exec — same tree/editor machinery as the Lab
// Configuration tab (hooks/useFsTree + FsTreePanel). The one thing this tab has that LabExplorer
// doesn't is the device picker: every read/write is scoped to whichever running machine is
// selected, and switching devices fully resets the tree (the hook keys its state on `scopeKey`)
// since two machines can legitimately share path namespaces — both may have an `/etc`.
export function RuntimeFilesystemEditor({ labName, detail, preferredMachine = null }: RuntimeFilesystemEditorProps) {
  const runningMachines = useMemo(
    () => detail.machines.filter((m) => m.running).map((m) => m.name),
    [detail.machines],
  );
  const [machine, setMachine] = useState<string>(runningMachines[0] ?? "");

  useEffect(() => {
    if (!runningMachines.length) {
      setMachine("");
      return;
    }
    if (!machine || !runningMachines.includes(machine)) setMachine(runningMachines[0]);
  }, [machine, runningMachines]);

  // Tracks the last `preferredMachine` value actually applied, so this effect only fires again
  // when the *value* changes (a fresh "Show runtime filesystem" click) — not on every re-render
  // where `runningMachines` merely gets a new array identity (it's recomputed from `detail.machines`
  // on every lab refresh, even when the running-machine set is unchanged). Without this guard, a
  // manual device switch via the dropdown below (which never updates `preferredMachine`) would get
  // silently overridden — and its unsaved edits discarded — by the next unrelated lab refresh.
  const appliedPreferredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!preferredMachine) return;
    if (appliedPreferredRef.current === preferredMachine) return;
    if (!runningMachines.includes(preferredMachine)) return;
    appliedPreferredRef.current = preferredMachine;
    setMachine(preferredMachine);
  }, [preferredMachine, runningMachines]);

  const source = useMemo<FsTreeSource>(
    () => ({
      list: async (path) => (await api.fsList(labName, machine, path)).entries,
      readText: async (path) => (await api.fsReadText(labName, machine, path)).content,
      writeText: async (path, content) => void (await api.fsWriteText(labName, machine, path, content)),
      mkdir: async (path) => void (await api.fsMkdir(labName, machine, path)),
      move: async (source, destination) => void (await api.fsMove(labName, machine, source, destination)),
      remove: async (path) => void (await api.fsDelete(labName, machine, path, true)),
      upload: async (path, file) => void (await api.fsUpload(labName, machine, path, file)),
      download: (path) => api.fsDownload(labName, machine, path),
      labels: {
        openFile: "Open runtime file",
        saveFile: "Save runtime file",
        createFile: "Create runtime file",
        createDirectory: "Create runtime directory",
        upload: "Upload runtime file",
        download: "Download runtime file",
        delete: "Delete runtime path",
        move: "Move runtime path",
        saved: (path) => `Saved ${path} on ${machine}.`,
        newFilePrompt: {
          title: "Create runtime file",
          message: "Absolute path on the running device, e.g.: /etc/frr/frr.conf",
          placeholder: (dir) => (dir === "/" ? "/tmp/new-file.txt" : `${dir}/new-file.txt`),
        },
        newDirectoryPrompt: {
          title: "Create runtime directory",
          message: "Absolute directory path, e.g.: /etc/frr",
          placeholder: (dir) => (dir === "/" ? "/tmp/new-dir" : `${dir}/new-dir`),
        },
        uploadPrompt: {
          title: (fileName) => `Upload ${fileName}`,
          message: `Destination absolute path on ${machine}`,
        },
        deleteConfirm: (path, isDir) => ({
          title: isDir ? "Delete runtime folder?" : "Delete runtime file?",
          message: `Delete ${path} from ${machine}? This cannot be undone.`,
        }),
      },
    }),
    [labName, machine],
  );

  const tree = useFsTree({ source, scopeKey: `${labName}/${machine}`, enabled: !!machine });

  return (
    <FsTreePanel
      tree={tree}
      treeKey={machine}
      dragHint="Drag files/folders onto a folder to move them. Double-click or F2 to rename."
      onReload={() => void tree.reload()}
      headerSlot={
        <Form.Select
          size="sm"
          className="mb-2"
          value={machine}
          disabled={!runningMachines.length}
          onChange={(e) => setMachine(e.target.value)}
        >
          {runningMachines.length ? (
            runningMachines.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))
          ) : (
            <option value="">No running devices</option>
          )}
        </Form.Select>
      }
      emptySlot={
        runningMachines.length ? undefined : (
          <p className="text-muted small mb-0">No running devices. Deploy the lab first.</p>
        )
      }
    />
  );
}
