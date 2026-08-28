import { Download, FilePlus, FolderPlus, RefreshCw, Trash2, Upload as UploadIcon } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { NodeApi, Tree, type NodeRendererProps, type TreeApi } from "react-arborist";
import { useConfirm } from "../context/ConfirmContext";
import { usePrompt } from "../context/PromptContext";
import { useToast } from "../context/ToastContext";
import { useWorkspace } from "../context/WorkspaceContext";
import { useBusyAction } from "../hooks/useBusyAction";
import { useConfirmDiscard } from "../hooks/useConfirmDiscard";
import { useElementSize } from "../hooks/useElementSize";
import { useSaveShortcut } from "../hooks/useSaveShortcut";
import { api, ApiError } from "../services/api";
import { saveBlob } from "../services/download";
import { languageForPath } from "../services/editorLanguage";
import { fileIcon } from "../services/labfs";
import { baseName, isSubPath } from "../services/paths";
import type { FsEntry, LabDetail } from "../services/types";
import { EditorPane } from "./EditorPane";
import type { ContextMenuItem } from "./TopologyContextMenu";
import "./LabExplorer.css";

interface RuntimeFilesystemEditorProps {
  labName: string;
  detail: LabDetail;
  preferredMachine?: string | null;
}

// One node in the lazily-loaded tree. `children` is `undefined` until this directory has been
// listed at least once — same lazy-load sentinel as LabExplorer's FsNode.
interface FsNode {
  name: string;
  path: string;
  dir: boolean;
  children?: FsNode[];
}

function entryToNode(e: FsEntry): FsNode {
  return { name: e.name, path: e.path, dir: e.is_dir };
}

// Lets the module-level `Node` row renderer (which react-arborist requires to keep a stable
// component identity) reach back into this component's handlers to build its right-click menu.
interface RowActions {
  onNewFile: (dir: string) => void;
  onDownload: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  canModify: (path: string) => boolean;
}
const RowActionsCtx = createContext<RowActions | null>(null);

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

function findNode(nodes: FsNode[], path: string): FsNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children && isSubPath(path, n.path)) {
      const found = findNode(n.children, path);
      if (found) return found;
    }
  }
  return null;
}

// Replace `oldNodes` with `freshNodes` from a listing, but carry over any already-loaded
// `children` for a directory that's still present — so a background refresh never collapses an
// already-expanded subfolder or throws away what it had loaded.
function mergeNodeList(oldNodes: FsNode[], freshNodes: FsNode[]): FsNode[] {
  return freshNodes
    .map((fresh) => {
      const old = oldNodes.find((o) => o.path === fresh.path);
      return old && fresh.dir && old.dir ? { ...fresh, children: old.children } : fresh;
    })
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
}

function withMergedChildrenAt(nodes: FsNode[], path: string, freshChildren: FsNode[]): FsNode[] {
  return nodes.map((n) => {
    if (n.path === path) return { ...n, children: mergeNodeList(n.children ?? [], freshChildren) };
    if (n.children && isSubPath(path, n.path)) {
      return { ...n, children: withMergedChildrenAt(n.children, path, freshChildren) };
    }
    return n;
  });
}

// Browse/edit a running device's own filesystem, over exec — a VS Code-style tree (react-arborist)
// on the left, a CodeMirror editor on the right, same pattern as LabExplorer's lab-directory tree.
// The one thing this tab has that LabExplorer doesn't is the device picker: every read/write is
// scoped to whichever running machine is currently selected, and switching devices fully resets
// the tree since two machines can legitimately share path namespaces (both may have an `/etc`).
export function RuntimeFilesystemEditor({ labName, detail, preferredMachine = null }: RuntimeFilesystemEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const treeRef = useRef<TreeApi<FsNode> | undefined>(undefined);
  const { ref: treeSizeRef, width: treeWidth, height: treeHeight } = useElementSize<HTMLDivElement>();

  const runningMachines = useMemo(
    () => detail.machines.filter((m) => m.running).map((m) => m.name),
    [detail.machines],
  );
  const [machine, setMachine] = useState<string>(runningMachines[0] ?? "");

  const [loaded, setLoaded] = useState(false);
  const [tree, setTree] = useState<FsNode[]>([]);
  const treeRefValue = useRef<FsNode[]>(tree);
  useEffect(() => {
    treeRefValue.current = tree;
  }, [tree]);

  const [selected, setSelected] = useState<string | null>(null);
  const [editorText, setEditorText] = useState("");
  const [loadedText, setLoadedText] = useState("");
  const [isBinary, setIsBinary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const toast = useToast();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const confirmDiscard = useConfirmDiscard();
  const runBusy = useBusyAction();

  function resetTreeState() {
    setTree([]);
    setLoaded(false);
    setSelected(null);
    setEditorText("");
    setLoadedText("");
    setIsBinary(false);
  }

  useEffect(() => {
    if (!runningMachines.length) {
      setMachine("");
      resetTreeState();
      return;
    }
    if (!machine || !runningMachines.includes(machine)) {
      setMachine(runningMachines[0]);
      resetTreeState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, runningMachines]);

  useEffect(() => {
    if (!preferredMachine) return;
    if (!runningMachines.includes(preferredMachine)) return;
    if (preferredMachine === machine) return;
    setMachine(preferredMachine);
    resetTreeState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferredMachine, runningMachines]);

  // Root listing, refreshed whenever the selected device changes or the toolbar's ↻ Reload
  // bumps reloadKey.
  useEffect(() => {
    if (!machine) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.fsList(labName, machine, "/");
        if (!cancelled) {
          setTree((prev) => mergeNodeList(prev, resp.entries.map(entryToNode)));
          setLoaded(true);
        }
      } catch (e) {
        if (!cancelled) toast.reportError("List runtime directory", e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labName, machine, reloadKey]);

  const data = useMemo(() => tree, [tree]);

  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Bring a path into view (opening its ancestor folders) and sync the tree's own selection
  // state to match — react-arborist owns selection/open state internally.
  function revealAndSelect(path: string | null) {
    const t = treeRef.current;
    if (!t || !path) return;
    t.openParents(path);
    t.select(path);
  }
  useEffect(() => {
    revealAndSelect(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, tree]);

  async function loadAndMerge(path: string): Promise<FsNode[]> {
    const resp = await api.fsList(labName, machine, path);
    const children = resp.entries.map(entryToNode);
    setTree((prev) => (path === "/" ? mergeNodeList(prev, children) : withMergedChildrenAt(prev, path, children)));
    return children;
  }

  // Lazy per-directory fetch, triggered the first time a folder is expanded — `children ===
  // undefined` is exactly "never listed yet".
  async function ensureLoaded(path: string) {
    const node = findNode(treeRefValue.current, path);
    if (!node || !node.dir || node.children !== undefined) return;
    try {
      await loadAndMerge(path);
    } catch (e) {
      toast.reportError("List directory", e);
    }
  }

  // Refresh one directory's listing after a write/delete/move affects something inside it.
  async function refreshDir(path: string) {
    try {
      if (path !== "/") {
        const segments = path.split("/").filter(Boolean);
        let acc = "";
        for (let i = 0; i < segments.length - 1; i++) {
          acc += `/${segments[i]}`;
          if (!findNode(treeRefValue.current, acc)) await loadAndMerge(acc);
        }
      }
      await loadAndMerge(path);
    } catch (e) {
      toast.reportError("Reload", e);
    }
  }

  // Re-fetch every currently-loaded directory (recursively), preserving expand state.
  async function reloadTree() {
    async function reloadLevel(nodes: FsNode[]): Promise<FsNode[]> {
      return Promise.all(
        nodes.map(async (n) => {
          if (!n.dir || n.children === undefined) return n;
          const resp = await api.fsList(labName, machine, n.path);
          const merged = mergeNodeList(n.children, resp.entries.map(entryToNode));
          return { ...n, children: await reloadLevel(merged) };
        }),
      );
    }
    const rootResp = await api.fsList(labName, machine, "/");
    const merged = mergeNodeList(treeRefValue.current, rootResp.entries.map(entryToNode));
    setTree(await reloadLevel(merged));
  }

  // Nothing on a running device's filesystem is structurally protected the way lab.conf is.
  function canModify(_path: string): boolean {
    return true;
  }

  const hasUnsavedChanges = !!selected && editorText !== loadedText;

  function requestFileSwitch(nextPath: string): Promise<boolean> {
    return confirmDiscard({ currentPath: selected, nextPath, hasUnsavedChanges });
  }

  // Selecting a folder row only needs to move the toolbar's Delete/rename target — there's no
  // content to load, and the editor pane just goes blank/disabled for it.
  async function selectDir(path: string) {
    const ok = await requestFileSwitch(path);
    if (!ok) {
      revealAndSelect(selected);
      return;
    }
    setSelected(path);
    setEditorText("");
    setLoadedText("");
    setIsBinary(false);
  }

  async function selectFile(path: string) {
    if (!machine) return;
    const ok = await requestFileSwitch(path);
    if (!ok) {
      revealAndSelect(selected);
      return;
    }
    await runBusy(setBusy, "Open runtime file", async () => {
      try {
        const resp = await api.fsReadText(labName, machine, path);
        setSelected(resp.path);
        setEditorText(resp.content);
        setLoadedText(resp.content);
        setIsBinary(false);
      } catch (e) {
        if (e instanceof ApiError && e.errorType === "BinaryFileError") {
          // Not a failure from the user's point of view: select the file so Download/Delete/
          // Rename work, just without a text preview.
          setSelected(path);
          setEditorText("");
          setLoadedText("");
          setIsBinary(true);
          return;
        }
        throw e;
      }
    });
  }

  async function saveFile() {
    if (!machine || !selected || isBinary) return;
    await runBusy(setBusy, "Save runtime file", async () => {
      await api.fsWriteText(labName, machine, selected, editorText);
      setLoadedText(editorText);
      toast.show(`Saved ${selected} on ${machine}.`, "success");
      await refreshDir(parentOf(selected));
    });
  }

  async function handleNewFile(defaultDir?: string) {
    if (!machine) return;
    const dir = defaultDir ?? (selected ? (selectedIsDir ? selected : parentOf(selected)) : "/");
    const newPath = await prompt({
      title: "Create runtime file",
      message: "Absolute path on the running device, e.g.: /etc/frr/frr.conf",
      defaultValue: dir === "/" ? "/" : `${dir}/`,
      placeholder: dir === "/" ? "/tmp/new-file.txt" : `${dir}/new-file.txt`,
      okLabel: "Create",
    });
    if (!newPath) return;
    const clean = `/${newPath.trim().replace(/^\/+/, "").replace(/\/+$/, "")}`;
    if (clean === "/") return;

    await runBusy(setBusy, "Create runtime file", async () => {
      await api.fsWriteText(labName, machine, clean, "");
      toast.show(`Created ${clean} on ${machine}.`, "success");
      await refreshDir(parentOf(clean));
      await selectFile(clean);
    });
  }

  async function handleNewDirectory() {
    if (!machine) return;
    const dir = selected ? (selectedIsDir ? selected : parentOf(selected)) : "/";
    const newPath = await prompt({
      title: "Create runtime directory",
      message: "Absolute directory path, e.g.: /etc/frr",
      defaultValue: dir === "/" ? "/" : `${dir}/`,
      placeholder: dir === "/" ? "/tmp/new-dir" : `${dir}/new-dir`,
      okLabel: "Create",
    });
    if (!newPath) return;
    const clean = `/${newPath.trim().replace(/^\/+/, "").replace(/\/+$/, "")}`;
    if (clean === "/") return;

    await runBusy(setBusy, "Create runtime directory", async () => {
      await api.fsMkdir(labName, machine, clean);
      toast.show(`Created ${clean} on ${machine}.`, "success");
      await refreshDir(parentOf(clean));
      revealAndSelect(clean);
    });
  }

  async function handleDelete(path: string) {
    if (!machine || !canModify(path)) return;
    const isDir = findNode(treeRefValue.current, path)?.dir ?? false;
    const ok = await confirm({
      title: isDir ? "Delete runtime folder?" : "Delete runtime file?",
      message: `Delete ${path} from ${machine}? This cannot be undone.`,
      okLabel: "Delete",
    });
    if (!ok) return;

    await runBusy(setBusy, "Delete runtime path", async () => {
      await api.fsDelete(labName, machine, path, true);
      if (selected === path || (isDir && selected?.startsWith(`${path}/`))) {
        setSelected(null);
        setEditorText("");
        setLoadedText("");
        setIsBinary(false);
      }
      toast.show(`Deleted ${path}.`, "success");
      await refreshDir(parentOf(path));
    });
  }

  // Shared core for both drag-and-drop move (onMove) and inline rename (onRename) — the only
  // difference between the two is how `destPath` is computed.
  async function movePath(sourcePath: string, destPath: string) {
    if (!machine || !canModify(sourcePath)) return;
    if (destPath === sourcePath) return;
    const destDir = parentOf(destPath);
    if (destDir === sourcePath || isSubPath(destDir, sourcePath)) return;

    await runBusy(setBusy, "Move runtime path", async () => {
      await api.fsMove(labName, machine, sourcePath, destPath);
      toast.show(`Moved ${sourcePath} → ${destPath}.`, "success");
      await Promise.all([refreshDir(parentOf(sourcePath)), refreshDir(destDir)]);
      if (selected === sourcePath) setSelected(destPath);
    });
  }

  async function handleTreeMove(dragIds: string[], parentId: string | null) {
    const sourcePath = dragIds[0];
    if (!sourcePath) return;
    const name = baseName(sourcePath);
    if (!name) return;
    const destDirPath = parentId ?? "/";
    const destPath = destDirPath === "/" ? `/${name}` : `${destDirPath}/${name}`;
    await movePath(sourcePath, destPath);
  }

  async function handleRename(sourcePath: string, newName: string) {
    const clean = newName.trim();
    if (!clean || clean.includes("/")) {
      toast.show("Invalid name.", "danger");
      return;
    }
    const destDirPath = parentOf(sourcePath);
    const destPath = destDirPath === "/" ? `/${clean}` : `${destDirPath}/${clean}`;
    await movePath(sourcePath, destPath);
  }

  async function handleDownload(path: string) {
    if (!machine) return;
    await runBusy(setBusy, "Download runtime file", async () => {
      const blob = await api.fsDownload(labName, machine, path);
      const name = path.split("/").filter(Boolean).pop() || "download.bin";
      saveBlob(blob, name);
      toast.show(`Downloaded ${path}.`, "success");
    });
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!file || !machine) return;

    const selDir = selected ? (selectedIsDir ? selected : parentOf(selected)) : "/";
    const suggested = selDir === "/" ? `/${file.name}` : `${selDir}/${file.name}`;
    const destination = await prompt({
      title: `Upload ${file.name}`,
      message: `Destination absolute path on ${machine}`,
      defaultValue: suggested,
      placeholder: suggested,
      okLabel: "Upload",
    });
    if (!destination) return;

    await runBusy(setBusy, "Upload runtime file", async () => {
      await api.fsUpload(labName, machine, destination, file);
      await refreshDir(parentOf(destination));
      toast.show(`Uploaded ${file.name} → ${destination}.`, "success");
    });
  }

  const canDelete = !!selected && canModify(selected);
  const selectedIsDir = !!selected && (findNode(tree, selected)?.dir ?? false);

  const rowActions: RowActions = {
    onNewFile: (dir) => void handleNewFile(dir),
    onDownload: (path) => void handleDownload(path),
    onRename: (path) => void treeRef.current?.edit(path),
    onDelete: (path) => void handleDelete(path),
    canModify,
  };

  useSaveShortcut(
    rootRef,
    () => {
      if (!busy && selected && !isBinary && !selectedIsDir) void saveFile();
    },
    [busy, selected, editorText, loadedText, isBinary, selectedIsDir, machine, labName],
  );

  return (
    <div ref={rootRef} className="kt-explorer" style={{ display: "flex", flexDirection: "row", gap: 12, minHeight: 0 }}>
      <div className="kt-explorer-side" style={{ width: 260, flex: "0 0 260px", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <Form.Select
          size="sm"
          className="mb-2"
          value={machine}
          disabled={!runningMachines.length}
          onChange={(e) => {
            setMachine(e.target.value);
            resetTreeState();
          }}
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

        {runningMachines.length ? (
          <>
            <div className="d-flex gap-2 mb-2 flex-wrap">
              <Button
                size="sm"
                variant="outline-secondary"
                className="kt-icon-btn"
                title="New file"
                aria-label="New file"
                onClick={() => void handleNewFile()}
              >
                <FilePlus size={16} />
              </Button>
              <Button
                size="sm"
                variant="outline-secondary"
                className="kt-icon-btn"
                title="New folder"
                aria-label="New folder"
                onClick={() => void handleNewDirectory()}
              >
                <FolderPlus size={16} />
              </Button>
              <Button
                size="sm"
                variant="outline-secondary"
                className="kt-icon-btn"
                title="Upload file"
                aria-label="Upload file"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadIcon size={16} />
              </Button>
              <Button
                size="sm"
                variant="outline-secondary"
                className="kt-icon-btn"
                title="Download"
                aria-label="Download"
                disabled={!selected || selectedIsDir || busy}
                onClick={() => selected && void handleDownload(selected)}
              >
                <Download size={16} />
              </Button>
              <Button
                size="sm"
                variant="outline-danger"
                className="kt-icon-btn"
                title="Delete"
                aria-label="Delete"
                disabled={!canDelete || busy}
                onClick={() => selected && void handleDelete(selected)}
              >
                <Trash2 size={16} />
              </Button>
              <Button
                size="sm"
                variant="outline-secondary"
                className="kt-icon-btn"
                disabled={busy}
                title="Reload from disk"
                aria-label="Reload from disk"
                onClick={() => {
                  setReloadKey((k) => k + 1);
                  void reloadTree();
                }}
              >
                <RefreshCw size={16} />
              </Button>
              <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleUpload} />
            </div>
            <div className="small text-muted mb-2">Drag files/folders onto a folder to move them. Double-click or F2 to rename.</div>
            <div ref={treeSizeRef} className="kt-explorer-tree border rounded" style={{ flex: 1, minHeight: 0 }}>
              {!loaded ? (
                <p className="text-muted small p-2">Loading…</p>
              ) : (
                <RowActionsCtx.Provider value={rowActions}>
                  <Tree<FsNode>
                    key={machine}
                    ref={treeRef}
                    data={data}
                    idAccessor="path"
                    childrenAccessor={(d) => (d.dir ? d.children ?? [] : null)}
                    openByDefault={false}
                    width={treeWidth}
                    height={treeHeight}
                    rowHeight={26}
                    indent={14}
                    disableMultiSelection
                    disableEdit={(d) => !canModify(d.path)}
                    disableDrag={(d) => !canModify(d.path)}
                    disableDrop={({ parentNode, dragNodes }) =>
                      dragNodes.some((n) => isSubPath(parentNode.data.path, n.data.path) || n.data.path === parentNode.data.path)
                    }
                    onToggle={(id) => {
                      if (treeRef.current?.isOpen(id)) void ensureLoaded(id);
                    }}
                    onSelect={(nodes) => {
                      const node = nodes[0];
                      if (!node) return;
                      if (node.data.path === selectedRef.current) return;
                      void (node.data.dir ? selectDir(node.data.path) : selectFile(node.data.path));
                    }}
                    onRename={({ id, name }) => void handleRename(id, name)}
                    onMove={({ dragIds, parentId }) => void handleTreeMove(dragIds, parentId)}
                  >
                    {Node}
                  </Tree>
                </RowActionsCtx.Provider>
              )}
            </div>
          </>
        ) : (
          <p className="text-muted small mb-0">No running devices. Deploy the lab first.</p>
        )}
      </div>

      <div className="d-flex flex-column flex-grow-1" style={{ minHeight: 0 }}>
        <EditorPane
          pathLabel={isBinary ? `${selected} (binary)` : selected || "Select a runtime file from the tree"}
          language={isBinary ? "plaintext" : languageForPath(selected)}
          value={editorText}
          onChange={setEditorText}
          disabled={!selected || selectedIsDir || isBinary}
          placeholder={
            selectedIsDir
              ? "This is a folder — select a file to edit it."
              : isBinary
                ? "This file is binary and can't be displayed here. Use Download to save it, or Delete to remove it."
                : selected
                  ? undefined
                  : "Select a runtime file from the tree on the left…"
          }
          onSave={saveFile}
          saveDisabled={!selected || selectedIsDir || busy || isBinary}
        />
      </div>
    </div>
  );
}

// Row renderer: VS-Code-ish icon + name, with inline rename input when the node is being edited.
function Node({ node, style, dragHandle }: NodeRendererProps<FsNode>) {
  const rowActions = useContext(RowActionsCtx);
  const { setContextMenu } = useWorkspace();

  function openContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    if (!rowActions) return;
    node.select();
    const path = node.data.path;
    const renameDelete: ContextMenuItem[] = [
      { label: "Rename", action: () => rowActions.onRename(path) },
      { label: "Delete", danger: true, action: () => rowActions.onDelete(path) },
    ];
    const items = node.data.dir
      ? [{ label: "New File", action: () => rowActions.onNewFile(path) }, ...renameDelete]
      : [{ label: "Download", action: () => rowActions.onDownload(path) }, ...renameDelete];
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }

  return (
    <div
      ref={dragHandle}
      style={style}
      className={`kt-explorer-row d-flex align-items-center gap-1 ${node.isSelected ? "kt-explorer-row--selected" : ""} ${
        node.willReceiveDrop ? "kt-explorer-row--drop" : ""
      }`}
      onClick={() => {
        node.select();
        if (node.isInternal) node.toggle();
      }}
      onDoubleClick={() => node.isEditable && node.edit()}
      onKeyDown={(e) => {
        if (e.key === "F2" && node.isEditable) node.edit();
      }}
      onContextMenu={openContextMenu}
    >
      {node.isInternal ? <span className="kt-explorer-chevron">{node.isOpen ? "▾" : "▸"}</span> : <span className="kt-explorer-chevron" />}
      <span>{node.data.dir ? "📁" : fileIcon(node.data.name)}</span>
      {node.isEditing ? <NodeEditInput node={node} /> : <span className="font-monospace small">{node.data.name}</span>}
    </div>
  );
}

function NodeEditInput({ node }: { node: NodeApi<FsNode> }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <input
      ref={inputRef}
      className="kt-explorer-edit font-monospace small"
      defaultValue={node.data.name}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => node.reset()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") node.reset();
        if (e.key === "Enter") node.submit(inputRef.current?.value || "");
      }}
    />
  );
}
