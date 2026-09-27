import { useEffect, useMemo } from "react";
import { useFsTree, type FsTreeSource } from "../hooks/useFsTree";
import { api, ApiError } from "../services/api";
import { fromLabPath, isSharedPath, SHARED_DIR, toLabPath, withSharedFolder } from "../services/deviceFs";
import { FsTreePanel } from "./FsTreePanel";

interface DeviceFilesSectionProps {
  labId: string;
  device: string;
  /** Reports the tree's unsaved buffer (its label) or null — see DeviceInfoTabs. */
  onDirtyChange: (label: string | null) => void;
  /** After a change that can create the device's folder, so the caller can tell it exists now. */
  onChanged: () => void;
  /** Forwarded to FsTreePanel: the caller picks it from the width it has. */
  layout: "side" | "stacked";
}

// The device's files as the device sees them: its own folder in the lab (`<device>/`, the files
// Kathara copies into its container) browsed as if it were the device's whole filesystem, plus
// the lab's `shared/` folder at `/shared`, where every device has it mounted. The Lab
// Configuration tree's machinery (useFsTree + FsTreePanel) over the same offline API, with every
// path mapped through services/deviceFs. The device's folder need not exist yet: the first file
// or folder created in it makes it. `shared/` is made when the root is listed, if the lab has none.
export function DeviceFilesSection({ labId, device, onDirtyChange, onChanged, layout }: DeviceFilesSectionProps) {
  const source = useMemo<FsTreeSource>(() => {
    const lab = (path: string) => toLabPath(device, path);
    const where = (path: string) => (isSharedPath(path) ? "the lab's shared folder" : `${device}'s folder`);
    const search = async (path: string, query: string, caseSensitive: boolean, signal?: AbortSignal) => {
      const result = await api.fsSearchOffline(labId, lab(path), query, caseSensitive, signal);
      return { ...result, matches: result.matches.map((m) => ({ ...m, path: fromLabPath(device, m.path) })) };
    };
    return {
      list: async (path, signal) => {
        if (path === "/") {
          // Idempotent. Refused only while the lab is being deployed or undeployed, and a deploy
          // makes the folder itself.
          await api.fsMkdirOffline(labId, SHARED_DIR).catch((e: unknown) => {
            if (!(e instanceof ApiError && e.errorType === "LabTransitioningError")) throw e;
          });
        }
        const { entries } = await api.fsListOffline(labId, lab(path), signal);
        const mapped = entries.map((e) => ({ ...e, path: fromLabPath(device, e.path) }));
        return path === "/" ? withSharedFolder(mapped) : mapped;
      },
      readText: async (path) => (await api.fsReadTextOffline(labId, lab(path))).content,
      writeText: async (path, content) => {
        await api.fsWriteTextOffline(labId, lab(path), content);
        onChanged();
      },
      mkdir: async (path) => {
        await api.fsMkdirOffline(labId, lab(path));
        onChanged();
      },
      move: async (from, to) => void (await api.fsMoveOffline(labId, lab(from), lab(to))),
      copy: async (from, to) => void (await api.fsCopyOffline(labId, lab(from), lab(to))),
      remove: async (path) => void (await api.fsDeleteOffline(labId, lab(path), true)),
      upload: async (path, file) => {
        await api.fsUploadOffline(labId, lab(path), file);
        onChanged();
      },
      download: (path) => api.fsDownloadOffline(labId, lab(path)),
      // The root is two folders in the lab, so a search from it is two searches.
      search: async (path, query, caseSensitive, signal) => {
        if (path !== "/") return search(path, query, caseSensitive, signal);
        const [own, shared] = await Promise.all([
          search(path, query, caseSensitive, signal),
          search(SHARED_DIR, query, caseSensitive, signal),
        ]);
        return { matches: [...own.matches, ...shared.matches], truncated: own.truncated || shared.truncated };
      },
      // The device's folder is what the device *is* on disk here: renaming or moving it would
      // detach it from the device, and deleting it is Remove Device's job. `/shared` is the one
      // folder every device mounts, so it stays where it is too; what is inside either is free.
      canModify: (path) => path !== "/" && path !== SHARED_DIR,
      cannotModifyReason: (path) =>
        path === SHARED_DIR
          ? "This is the lab's shared folder, mounted at /shared in every device."
          : `This is ${device}'s folder itself.`,
      labels: {
        openFile: "Open file",
        saveFile: "Save file",
        createFile: "Create file",
        createDirectory: "Create folder",
        upload: "Upload file",
        download: "Download file",
        delete: "Delete",
        move: "Move",
        paste: "Paste",
        saved: (path) => `Saved ${path} in ${where(path)}.`,
        unsaved: (path) => `${path} in ${where(path)}`,
        newFilePrompt: {
          title: `New file for ${device}`,
          message: `Path inside ${device}, as it will be in the device, e.g.: /etc/frr/frr.conf`,
          placeholder: (dir) => (dir === "/" ? "/etc/new-file.conf" : `${dir}/new-file.conf`),
        },
        newDirectoryPrompt: {
          title: `New folder for ${device}`,
          message: `Path inside ${device}, as it will be in the device, e.g.: /etc/frr`,
          placeholder: (dir) => (dir === "/" ? "/etc/new-folder" : `${dir}/new-folder`),
        },
        uploadPrompt: {
          title: (fileName) => `Upload ${fileName}`,
          message: `Path inside ${device}, as it will be in the device`,
        },
        deleteConfirm: (path, isDir) => ({
          title: isDir ? "Delete folder?" : "Delete file?",
          message: `Delete ${path} from ${where(path)}? This cannot be undone.`,
        }),
        deleteConfirmMultiple: (count) => ({
          title: "Delete items?",
          message: `Delete ${count} items from ${device}'s files? This cannot be undone.`,
        }),
        pasteConfirmOverwrite: (path, isDir) => ({
          title: isDir ? "Replace folder?" : "Replace file?",
          message: `${path} already exists in ${where(path)}. Replace it?`,
        }),
      },
    };
  }, [labId, device, onChanged]);

  const tree = useFsTree({ source, scopeKey: `${labId}/device/${device}` });

  const label = tree.dirty && tree.bufferPath ? source.labels.unsaved(tree.bufferPath) : null;
  useEffect(() => onDirtyChange(label), [label, onDirtyChange]);

  return (
    <FsTreePanel
      tree={tree}
      treeKey={device}
      layout={layout}
      dragHint={`Files here are copied into ${device} when it starts; /shared is the lab's shared folder, the same files in every device. Drag files onto a folder to move them; double-click or F2 to rename.`}
      onReload={() => void tree.reload()}
    />
  );
}
