import { useEffect, useMemo } from "react";
import { useFsTree, type FsTreeSource } from "../hooks/useFsTree";
import { api } from "../services/api";
import { fromLabPath, toLabPath } from "../services/deviceFs";
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

// The device's own folder in the lab (`<device>/`, the files Kathara copies into its container),
// browsed as if it were the device's whole filesystem: the Lab Configuration tree's machinery
// (useFsTree + FsTreePanel) over the same offline API, with every path mapped through
// services/deviceFs. The folder need not exist yet: the first file or folder created here makes it.
export function DeviceFilesSection({ labId, device, onDirtyChange, onChanged, layout }: DeviceFilesSectionProps) {
  const source = useMemo<FsTreeSource>(() => {
    const lab = (path: string) => toLabPath(device, path);
    return {
      list: async (path, signal) =>
        (await api.fsListOffline(labId, lab(path), signal)).entries.map((e) => ({ ...e, path: fromLabPath(device, e.path) })),
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
      search: async (path, query, caseSensitive, signal) => {
        const result = await api.fsSearchOffline(labId, lab(path), query, caseSensitive, signal);
        return { ...result, matches: result.matches.map((m) => ({ ...m, path: fromLabPath(device, m.path) })) };
      },
      // The folder itself is what the device *is* on disk here: renaming or moving it would detach
      // it from the device, and deleting it is Remove Device's job.
      canModify: (path) => path !== "/",
      cannotModifyReason: `This is ${device}'s folder itself.`,
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
        saved: (path) => `Saved ${path} in ${device}'s folder.`,
        unsaved: (path) => `${path} in ${device}'s folder`,
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
          message: `Delete ${path} from ${device}'s folder? This cannot be undone.`,
        }),
        deleteConfirmMultiple: (count) => ({
          title: "Delete items?",
          message: `Delete ${count} items from ${device}'s folder? This cannot be undone.`,
        }),
        pasteConfirmOverwrite: (path, isDir) => ({
          title: isDir ? "Replace folder?" : "Replace file?",
          message: `${path} already exists in ${device}'s folder. Replace it?`,
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
      dragHint={`Files here are copied into ${device} when it starts. Drag files onto a folder to move them; double-click or F2 to rename.`}
      onReload={() => void tree.reload()}
    />
  );
}
