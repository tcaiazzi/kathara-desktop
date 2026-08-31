import { FilePlus, FolderPlus, Info, Loader2, RefreshCw, Trash2, Upload as UploadIcon } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "react-bootstrap";
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
import { languageForPath } from "../services/editorLanguage";
import { fileIcon } from "../services/labfs";
import { baseName, isSubPath } from "../services/paths";
import type { FsEntry, LabConfView, LabDetail } from "../services/types";
import { EditorPane } from "./EditorPane";
import type { ContextMenuItem } from "./TopologyContextMenu";
import "./LabExplorer.css";

interface LabExplorerProps {
  labName: string;
  detail: LabDetail;
  onStructuralChange?: () => Promise<void>;
}

// One node in the lazily-loaded tree. `children` is `undefined` until this directory has been
// listed at least once — react-arborist still renders it as expandable (an empty array still
// counts as "internal", see NodeApi.isLeaf), so the very first expand click is what triggers the
// fetch (see `ensureLoaded`/the Tree's `onToggle` below).
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
// component identity, so it can't just be redefined as a closure each render) reach back into
// LabExplorer's handlers to build its right-click menu.
interface RowActions {
  onNewFile: (dir: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  canModify: (path: string) => boolean;
  isLoading: (path: string) => boolean;
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

// Browse/edit a lab's own on-disk directory directly — lab.conf, every device's own folder (even
// one with nothing in it yet), each device's `<name>.startup`, and anything else queued at the
// lab root — a VS Code-style tree (react-arborist: virtualized rows, drag-and-drop, keyboard nav,
// inline rename via double-click/F2) on the left, a CodeMirror editor on the right.
//
// Every read/write is a real call against the lab's real filesystem (services/api.ts's
// `fs*Offline` methods) — there is no separate in-memory cache of what's queued, so nothing here
// can ever drift from what's actually on disk (that was an earlier design; it repeatedly did).
// Directories are listed lazily, one at a time, the same way the Runtime FS tab already works
// against a live device — the difference is this tab reads/writes the lab's directory on the
// host directly, so it works whether or not any device is actually running.
export function LabExplorer({ labName, detail, onStructuralChange }: LabExplorerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const treeRef = useRef<TreeApi<FsNode> | undefined>(undefined);
  const { ref: treeSizeRef, width: treeWidth, height: treeHeight } = useElementSize<HTMLDivElement>();

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
  const [labConf, setLabConf] = useState<LabConfView | null>(null);
  const serverConfRef = useRef<string>("");
  const [confConflict, setConfConflict] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Path of the node currently being fetched — a directory being expanded for the first time, or
  // a file whose content is being read — so the tree row can show a spinner while it's in flight.
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const toast = useToast();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const confirmDiscard = useConfirmDiscard();
  const runBusy = useBusyAction();

  const selectedRef = useRef(selected);
  const editorTextRef = useRef(editorText);
  // react-arborist's onSelect fires more than once for a single click (its own focus + selection
  // updates each trigger a callback) — without this, each firing independently runs the discard-
  // confirmation + fetch flow for the same target before `selected` has committed from the first
  // one, so `selectedRef.current` (checked below) hasn't caught up yet and doesn't dedupe them.
  const pendingSelectPathRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    editorTextRef.current = editorText;
  }, [editorText]);

  // Root listing + lab.conf, refreshed whenever the parent's `detail` changes (any lifecycle
  // action that can rewrite lab.conf) or the toolbar's ↻ Reload bumps `reloadKey`.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.fsListOffline(labName, "/");
        if (!cancelled) {
          setTree((prev) => mergeNodeList(prev, resp.entries.map(entryToNode)));
          setLoaded(true);
        }
      } catch (e) {
        if (!cancelled) toast.reportError("List lab directory", e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labName, detail, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const conf = await api.getLabConf(labName);
        if (cancelled) return;
        const dirty = selectedRef.current === "/lab.conf" && editorTextRef.current !== serverConfRef.current;
        const changed = conf.content !== serverConfRef.current;
        if (dirty && changed) {
          setConfConflict(conf.content);
        } else {
          serverConfRef.current = conf.content;
          setConfConflict(null);
          if (selectedRef.current === "/lab.conf" && changed) {
            setEditorText(conf.content);
            setLoadedText(conf.content);
          }
        }
        setLabConf(conf);
      } catch (e) {
        if (!cancelled) toast.reportError("Load lab.conf", e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labName, detail, reloadKey]);

  const data = useMemo(() => tree, [tree]);

  // Bring a path into view (opening its ancestor folders) and sync the tree's own selection
  // state to match — react-arborist owns selection/open state internally, so whenever *our*
  // `selected` changes for a reason other than the user clicking a row directly, it has to be
  // told. Reruns as `tree` fills in while `revealPath` is still loading ancestor levels below.
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
    const resp = await api.fsListOffline(labName, path);
    const children = resp.entries.map(entryToNode);
    setTree((prev) => (path === "/" ? mergeNodeList(prev, children) : withMergedChildrenAt(prev, path, children)));
    return children;
  }

  // Lazy per-directory fetch, triggered the first time a folder is expanded (see the Tree's
  // onToggle below) — `children === undefined` is exactly "never listed yet".
  async function ensureLoaded(path: string) {
    const node = findNode(treeRefValue.current, path);
    if (!node || !node.dir || node.children !== undefined) return;
    setLoadingPath(path);
    try {
      await loadAndMerge(path);
    } catch (e) {
      toast.reportError("List directory", e);
    } finally {
      setLoadingPath((prev) => (prev === path ? null : prev));
    }
  }

  // Refresh one directory's listing after a write/delete/move affects something inside it —
  // loading any not-yet-seen ancestor along the way first, so a brand-new deeply nested path
  // (created under a folder nobody has expanded yet) still shows up correctly.
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

  // Re-fetch every currently-loaded directory (recursively), preserving expand state — a true
  // resync with disk, not just the root level.
  async function reloadTree() {
    async function reloadLevel(nodes: FsNode[]): Promise<FsNode[]> {
      return Promise.all(
        nodes.map(async (n) => {
          if (!n.dir || n.children === undefined) return n;
          const resp = await api.fsListOffline(labName, n.path);
          const merged = mergeNodeList(n.children, resp.entries.map(entryToNode));
          return { ...n, children: await reloadLevel(merged) };
        }),
      );
    }
    const rootResp = await api.fsListOffline(labName, "/");
    const merged = mergeNodeList(treeRefValue.current, rootResp.entries.map(entryToNode));
    setTree(await reloadLevel(merged));
  }

  // lab.conf is the only entry that's never deletable, draggable, or renamable here. Everything
  // else is fair game, including a machine's own <name>.startup — it's just a real file sitting
  // at the lab root, same as any other — and the bare device-root node itself, since this tab
  // never touches a running device; acting on it only ever rewrites the lab's own on-disk files.
  function canModify(path: string): boolean {
    return path !== "/lab.conf";
  }

  // Selecting a folder row only needs to move the toolbar's Delete/rename target — there's no
  // content to load, and the editor pane just goes blank/disabled for it.
  async function selectDir(path: string) {
    const ok = await confirmDiscard({
      currentPath: selected,
      nextPath: path,
      hasUnsavedChanges: !!selected && editorText !== loadedText,
    });
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
    const ok = await confirmDiscard({
      currentPath: selected,
      nextPath: path,
      hasUnsavedChanges: !!selected && editorText !== loadedText,
    });
    if (!ok) {
      revealAndSelect(selected);
      return;
    }
    if (path === "/lab.conf") {
      setSelected(path);
      setEditorText(labConf?.content ?? "");
      setLoadedText(labConf?.content ?? "");
      setIsBinary(false);
      return;
    }
    setLoadingPath(path);
    try {
      await runBusy(setBusy, "Open file", async () => {
        try {
          const resp = await api.fsReadTextOffline(labName, path);
          setSelected(path);
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
    } finally {
      setLoadingPath((prev) => (prev === path ? null : prev));
    }
  }

  async function handleSave() {
    if (!selected) return;
    const content = editorText;

    if (selected === "/lab.conf") {
      if (detail.deployed) {
        toast.show("Undeploy the lab to edit lab.conf.", "info");
        return;
      }
      await runBusy(setBusy, "Apply lab.conf", async () => {
        await api.updateLabConf(labName, content);
        // Re-read to refresh our "last known server text" baseline — not to recover a
        // "normalized" version. The backend stores lab.conf verbatim: if what comes back differs
        // from what was just sent, that is a backend bug, not a client-side detail to paper over
        // by silently accepting the server's text.
        const conf = await api.getLabConf(labName);
        if (conf.content !== content) {
          toast.show("lab.conf was saved, but the server returned different text than submitted.", "danger");
        }
        serverConfRef.current = conf.content;
        setLabConf(conf);
        setConfConflict(null);
        setEditorText(conf.content);
        setLoadedText(conf.content);
        toast.show("Applied lab.conf — topology updated.", "success");
        await onStructuralChange?.();
      });
      return;
    }

    await runBusy(setBusy, "Save file", async () => {
      await api.fsWriteTextOffline(labName, selected, content);
      setLoadedText(content);
      toast.show(`Saved ${selected}.`, "success");
      await refreshDir(parentOf(selected));
    });
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = ""; // allow re-picking the same file
    if (!file) return;

    const selDir = selected ? (selectedIsDir ? selected : parentOf(selected)) : "/";
    const fallbackDir = detail.machines[0] ? `/${detail.machines[0].name}` : "/";
    const dir = selDir !== "/" ? selDir : fallbackDir;
    const suggested = dir === "/" ? `/${file.name}` : `${dir}/${file.name}`;
    const target = await prompt({
      title: `Upload ${file.name}`,
      message: "Target path (relative to the lab), e.g.: /pc1/etc/frr/frr.conf",
      defaultValue: suggested,
      placeholder: "/pc1/etc/frr/frr.conf",
      okLabel: "Upload",
    });
    if (!target) return;
    const clean = `/${target.trim().replace(/^\/+/, "").replace(/\/+$/, "")}`;
    if (clean === "/") return;

    await runBusy(setBusy, "Upload file", async () => {
      await api.fsUploadOffline(labName, clean, file);
      await refreshDir(parentOf(clean));
      await selectFile(clean);
      toast.show(`Uploaded ${file.name} → ${clean}.`, "success");
    });
  }

  async function handleNewFile(defaultDir?: string) {
    const dir = defaultDir ?? (selected ? (selectedIsDir ? selected : parentOf(selected)) : "/");
    const path = await prompt({
      title: "Create file",
      message: "New file path (relative to the lab), e.g.: pc1/etc/frr/frr.conf, pc1.startup, notes.txt",
      defaultValue: dir === "/" ? "/" : `${dir}/`,
      placeholder: "pc1/etc/frr/frr.conf",
      okLabel: "Create",
    });
    if (!path) return;
    const clean = `/${path.trim().replace(/^\/+/, "").replace(/\/+$/, "")}`;
    if (clean === "/") return;

    await runBusy(setBusy, "Create file", async () => {
      await api.fsWriteTextOffline(labName, clean, "");
      await refreshDir(parentOf(clean));
      await selectFile(clean);
    });
  }

  async function handleNewDirectory() {
    const dir = selected ? (selectedIsDir ? selected : parentOf(selected)) : "/";
    const path = await prompt({
      title: "Create folder",
      message: "New directory path (relative to the lab), e.g.: pc1/etc/frr, pc1/var/log, scratch",
      defaultValue: dir === "/" ? "/" : `${dir}/`,
      placeholder: "pc1/etc/frr",
      okLabel: "Create",
    });
    if (!path) return;
    const clean = `/${path.trim().replace(/^\/+/, "").replace(/\/+$/, "")}`;
    if (clean === "/") return;

    await runBusy(setBusy, "Create folder", async () => {
      await api.fsMkdirOffline(labName, clean);
      await refreshDir(parentOf(clean));
      revealAndSelect(clean);
    });
  }

  async function handleDelete(path: string) {
    if (!canModify(path)) return;
    const isDir = findNode(treeRefValue.current, path)?.dir ?? false;
    const ok = await confirm({
      title: isDir ? "Delete folder?" : "Delete file?",
      message: `Delete ${path}? This cannot be undone.`,
      okLabel: "Delete",
    });
    if (!ok) return;

    await runBusy(setBusy, "Delete", async () => {
      await api.fsDeleteOffline(labName, path, true);
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
  // difference between the two is how `destPath` is computed (new parent, same name vs. same
  // parent, new name).
  async function movePath(sourcePath: string, destPath: string) {
    if (!canModify(sourcePath)) return;
    if (destPath === sourcePath) return;
    const destDir = parentOf(destPath);
    if (destDir === sourcePath || isSubPath(destDir, sourcePath)) return;

    await runBusy(setBusy, "Move", async () => {
      await api.fsMoveOffline(labName, sourcePath, destPath);
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

  function acceptConfConflict() {
    if (confConflict === null) return;
    serverConfRef.current = confConflict;
    if (selectedRef.current === "/lab.conf") {
      setEditorText(confConflict);
      setLoadedText(confConflict);
    }
    setConfConflict(null);
  }

  const canDelete = !!selected && canModify(selected);
  const selectedIsDir = !!selected && (findNode(tree, selected)?.dir ?? false);
  // Only a file read should override the editor's path label — a directory being expanded
  // (also tracked via loadingPath, for the tree row spinner) has nothing to do with the editor.
  const loadingFile = loadingPath && !(findNode(tree, loadingPath)?.dir ?? false) ? loadingPath : null;

  const rowActions: RowActions = {
    onNewFile: (dir) => void handleNewFile(dir),
    onRename: (path) => void treeRef.current?.edit(path),
    onDelete: (path) => void handleDelete(path),
    canModify,
    isLoading: (path) => path === loadingPath,
  };

  useSaveShortcut(
    rootRef,
    () => {
      if (!busy && selected && !isBinary && !selectedIsDir) void handleSave();
    },
    [busy, selected, editorText, loadedText, isBinary, selectedIsDir],
  );

  return (
    <div ref={rootRef} className="kt-explorer" style={{ display: "flex", flexDirection: "row", gap: 12, minHeight: 0 }}>
      <div className="kt-explorer-side" style={{ width: 260, flex: "0 0 260px", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="d-flex gap-2 mb-2 flex-wrap">
          <Button
            size="sm"
            variant="outline-secondary"
            className="kt-icon-btn"
            title="New file"
            aria-label="New file"
            onClick={() => handleNewFile()}
          >
            <FilePlus size={16} />
          </Button>
          <Button
            size="sm"
            variant="outline-secondary"
            className="kt-icon-btn"
            title="New folder"
            aria-label="New folder"
            onClick={handleNewDirectory}
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
          <span
            className="kt-icon-btn text-muted"
            title="Drag files/folders onto a device or folder to move them. Double-click or F2 to rename."
            aria-label="Drag files/folders onto a device or folder to move them. Double-click or F2 to rename."
          >
            <Info size={16} />
          </span>
          <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleUpload} />
        </div>
        <div ref={treeSizeRef} className="kt-explorer-tree border rounded" style={{ flex: 1, minHeight: 0 }}>
          {!loaded ? (
            <p className="text-muted small p-2">Loading…</p>
          ) : (
            <RowActionsCtx.Provider value={rowActions}>
              <Tree<FsNode>
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
                  if (node.data.path === pendingSelectPathRef.current) return;
                  pendingSelectPathRef.current = node.data.path;
                  const run = node.data.dir ? selectDir(node.data.path) : selectFile(node.data.path);
                  void run.finally(() => {
                    if (pendingSelectPathRef.current === node.data.path) pendingSelectPathRef.current = null;
                  });
                }}
                onRename={({ id, name }) => void handleRename(id, name)}
                onMove={({ dragIds, parentId }) => void handleTreeMove(dragIds, parentId)}
              >
                {Node}
              </Tree>
            </RowActionsCtx.Provider>
          )}
        </div>
      </div>
      <div className="d-flex flex-column flex-grow-1" style={{ minHeight: 0 }}>
        {selected === "/lab.conf" && confConflict !== null && (
          <div className="alert alert-warning py-1 px-2 mb-2 d-flex justify-content-between align-items-center small">
            <span>lab.conf changed on disk since you started editing.</span>
            <Button size="sm" variant="outline-dark" onClick={acceptConfConflict}>
              Reload from disk (discards your edits)
            </Button>
          </div>
        )}
        {selected === "/lab.conf" && labConf?.exists === false && (
          <div className="text-muted small mb-1">Not on disk yet — saving will create it.</div>
        )}
        <EditorPane
          pathLabel={
            loadingFile && loadingFile !== selected
              ? `Loading ${loadingFile}…`
              : isBinary
                ? `${selected} (binary)`
                : selected || "Select a file from the tree"
          }
          language={isBinary ? "plaintext" : languageForPath(selected)}
          value={editorText}
          onChange={setEditorText}
          disabled={!selected || selectedIsDir || isBinary || (selected === "/lab.conf" && detail.deployed)}
          placeholder={
            selectedIsDir
              ? "This is a folder — select a file to edit it."
              : isBinary
                ? "This file is binary and can't be displayed here. Delete to remove it, or edit it via the Runtime FS tab once the device is running."
                : selected
                  ? undefined
                  : "Select a file from the tree on the left…"
          }
          onSave={handleSave}
          saveDisabled={!selected || selectedIsDir || busy || isBinary || (selected === "/lab.conf" && detail.deployed)}
        />
      </div>
    </div>
  );
}

// Row renderer: VS-Code-ish icon + name, with inline rename input when the node is being edited.
// onCreate/onDelete are intentionally left off <Tree> above — toolbar actions call the offline-fs
// API directly instead of going through arborist's own create/delete UX.
function Node({ node, style, dragHandle }: NodeRendererProps<FsNode>) {
  const rowActions = useContext(RowActionsCtx);
  const { setContextMenu } = useWorkspace();

  function openContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    if (!rowActions) return;
    node.select();
    const path = node.data.path;
    const modifiable = rowActions.canModify(path);
    const lockedTitle = modifiable ? undefined : "lab.conf can't be renamed or deleted here.";
    const renameDelete: ContextMenuItem[] = [
      { label: "Rename", disabled: !modifiable, title: lockedTitle, action: () => rowActions.onRename(path) },
      { label: "Delete", danger: true, disabled: !modifiable, title: lockedTitle, action: () => rowActions.onDelete(path) },
    ];
    const items = node.data.dir ? [{ label: "New File", action: () => rowActions.onNewFile(path) }, ...renameDelete] : renameDelete;
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
      {rowActions?.isLoading(node.data.path) ? (
        <Loader2 size={14} className="kt-explorer-spin" />
      ) : (
        <span>{node.data.dir ? "📁" : fileIcon(node.data.name)}</span>
      )}
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
