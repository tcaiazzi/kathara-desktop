import { Download, FilePlus, FolderPlus, Info, Loader2, RefreshCw, Trash2, Upload as UploadIcon } from "lucide-react";
import { createContext, memo, useContext, useEffect, useRef, type ReactNode } from "react";
import { Button } from "react-bootstrap";
import { NodeApi, Tree, type NodeRendererProps } from "react-arborist";
import { useWorkspaceCore } from "../context/WorkspaceCoreContext";
import { useElementSize } from "../hooks/useElementSize";
import type { FsRowActions, UseFsTree } from "../hooks/useFsTree";
import { useSaveShortcut } from "../hooks/useSaveShortcut";
import { languageForPath } from "../services/editorLanguage";
import type { FsNode } from "../services/fsTree";
import { fileIcon } from "../services/labfs";
import { isSubPath } from "../services/paths";
import { EditorPane } from "./EditorPane";
import type { ContextMenuItem } from "./TopologyContextMenu";
import "./LabExplorer.css";

// Lets the module-level `Node` row renderer (which react-arborist requires to keep a stable
// component identity, so it can't just be redefined as a closure each render) reach back into the
// panel's handlers to build its right-click menu.
const RowActionsCtx = createContext<FsRowActions | null>(null);

interface FsTreePanelProps {
  tree: UseFsTree;
  /** Above the toolbar — the Runtime FS device picker. */
  headerSlot?: ReactNode;
  /** Replaces the whole tree side when there is nothing to browse ("no running devices"). */
  emptySlot?: ReactNode;
  /** Above the editor — LabExplorer's lab.conf conflict/"not on disk yet" notices. */
  bannerSlot?: ReactNode;
  /** Tooltip on the toolbar's ⓘ, since drag targets differ between the two surfaces. */
  dragHint: string;
  /** Extra condition making the editor read-only, on top of the tree's own (binary, folder, …). */
  editorReadOnly?: boolean;
  /** Shown instead of the default when `editorReadOnly` is what disabled the editor. */
  readOnlyPlaceholder?: string;
  /** Remounts the tree wholesale (Runtime FS keys it by device). */
  treeKey?: string;
  onReload: () => void;
}

// The left tree + right editor shared by both filesystem panels (the lab's own directory, a
// running device's filesystem): a VS Code-style react-arborist tree — virtualized rows,
// drag-and-drop, keyboard nav, inline rename via double-click/F2 — and a CodeMirror editor. All
// behaviour lives in `useFsTree`; this file is only presentation plus the slots for the handful of
// things that genuinely differ between the two surfaces.
export function FsTreePanel({
  tree,
  headerSlot,
  emptySlot,
  bannerSlot,
  dragHint,
  editorReadOnly = false,
  readOnlyPlaceholder,
  treeKey,
  onReload,
}: FsTreePanelProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { ref: treeSizeRef, width: treeWidth, height: treeHeight } = useElementSize<HTMLDivElement>();

  const { selected, selectedIsDir, isBinary, busy } = tree;
  const disabled = !selected || selectedIsDir || isBinary || editorReadOnly;

  useSaveShortcut(rootRef, () => {
    if (!busy && !disabled) void tree.handleSave();
  });

  return (
    <div ref={rootRef} className="kt-explorer" style={{ display: "flex", flexDirection: "row", gap: 12, minHeight: 0 }}>
      <div
        className="kt-explorer-side"
        style={{ width: 260, flex: "0 0 260px", display: "flex", flexDirection: "column", minHeight: 0 }}
      >
        {headerSlot}
        {emptySlot ?? (
          <>
            <div className="d-flex gap-2 mb-2 flex-wrap">
              <Button
                size="sm"
                variant="outline-secondary"
                className="kt-icon-btn"
                title="New file"
                aria-label="New file"
                onClick={() => void tree.handleNewFile()}
              >
                <FilePlus size={16} />
              </Button>
              <Button
                size="sm"
                variant="outline-secondary"
                className="kt-icon-btn"
                title="New folder"
                aria-label="New folder"
                onClick={() => void tree.handleNewDirectory()}
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
              {tree.hasDownload && (
                <Button
                  size="sm"
                  variant="outline-secondary"
                  className="kt-icon-btn"
                  title="Download"
                  aria-label="Download"
                  disabled={!selected || selectedIsDir || busy}
                  onClick={() => selected && void tree.handleDownload(selected)}
                >
                  <Download size={16} />
                </Button>
              )}
              <Button
                size="sm"
                variant="outline-danger"
                className="kt-icon-btn"
                title="Delete"
                aria-label="Delete"
                disabled={!tree.canDelete || busy}
                onClick={() => selected && void tree.handleDelete(selected)}
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
                onClick={onReload}
              >
                <RefreshCw size={16} />
              </Button>
              <span className="kt-icon-btn text-muted" title={dragHint} aria-label={dragHint}>
                <Info size={16} />
              </span>
              <input
                ref={fileInputRef}
                type="file"
                style={{ display: "none" }}
                onChange={(e) => void tree.handleUpload(e)}
              />
            </div>
            <div ref={treeSizeRef} className="kt-explorer-tree border rounded" style={{ flex: 1, minHeight: 0 }}>
              {!tree.loaded ? (
                <p className="text-muted small p-2">Loading…</p>
              ) : (
                <RowActionsCtx.Provider value={tree.rowActions}>
                  <Tree<FsNode>
                    key={treeKey}
                    ref={tree.treeRef}
                    data={tree.data}
                    idAccessor="path"
                    childrenAccessor={(d) => (d.dir ? d.children ?? [] : null)}
                    openByDefault={false}
                    width={treeWidth}
                    height={treeHeight}
                    rowHeight={26}
                    indent={14}
                    disableMultiSelection
                    disableEdit={(d) => !tree.canModify(d.path)}
                    disableDrag={(d) => !tree.canModify(d.path)}
                    disableDrop={({ parentNode, dragNodes }) =>
                      dragNodes.some(
                        (n) => isSubPath(parentNode.data.path, n.data.path) || n.data.path === parentNode.data.path,
                      )
                    }
                    onToggle={tree.onTreeToggle}
                    onSelect={tree.onTreeSelect}
                    onRename={tree.onTreeRename}
                    onMove={tree.onTreeMove}
                  >
                    {Node}
                  </Tree>
                </RowActionsCtx.Provider>
              )}
            </div>
          </>
        )}
      </div>

      <div className="d-flex flex-column flex-grow-1" style={{ minHeight: 0 }}>
        {bannerSlot}
        <EditorPane
          pathLabel={
            tree.loadingFile && tree.loadingFile !== selected
              ? `Loading ${tree.loadingFile}…`
              : isBinary
                ? `${selected} (binary)`
                : selected || "Select a file from the tree"
          }
          language={isBinary ? "plaintext" : languageForPath(selected)}
          value={tree.editorText}
          onChange={tree.setEditorText}
          disabled={disabled}
          placeholder={
            selectedIsDir
              ? "This is a folder — select a file to edit it."
              : isBinary
                ? tree.hasDownload
                  ? "This file is binary and can't be displayed here. Use Download to save it, or Delete to remove it."
                  : "This file is binary and can't be displayed here. Delete to remove it, or edit it via the Runtime FS tab once the device is running."
                : editorReadOnly
                  ? readOnlyPlaceholder
                  : selected
                    ? undefined
                    : "Select a file from the tree on the left…"
          }
          onSave={() => void tree.handleSave()}
          saveDisabled={disabled || busy}
        />
      </div>
    </div>
  );
}

// Row renderer: VS-Code-ish icon + name, with inline rename input when the node is being edited.
// onCreate/onDelete are intentionally left off <Tree> above — toolbar actions call the filesystem
// API directly instead of going through arborist's own create/delete UX. Memoized so a render of
// the parent that doesn't touch RowActionsCtx/setContextMenu (both stabilized in the hook) doesn't
// force every visible row to re-render.
const Node = memo(function Node({ node, style, dragHandle }: NodeRendererProps<FsNode>) {
  const rowActions = useContext(RowActionsCtx);
  const { setContextMenu } = useWorkspaceCore();

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
    const items: ContextMenuItem[] = node.data.dir
      ? [{ label: "New File", action: () => rowActions.onNewFile(path) }, ...renameDelete]
      : rowActions.onDownload
        ? [{ label: "Download", action: () => rowActions.onDownload!(path) }, ...renameDelete]
        : renameDelete;
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
});

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
