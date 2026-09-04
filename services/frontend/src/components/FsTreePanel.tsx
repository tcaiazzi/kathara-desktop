import { Download, FilePlus, Folder, FolderPlus, Info, Loader2, RefreshCw, Trash2, Upload as UploadIcon } from "lucide-react";
import { createContext, memo, useContext, useEffect, useRef, type ReactNode } from "react";
import { Button } from "react-bootstrap";
import { NodeApi, Tree, type NodeRendererProps } from "react-arborist";
import { useWorkspaceCore } from "../context/WorkspaceCoreContext";
import { useElementSize } from "../hooks/useElementSize";
import { useFsClipboardShortcuts } from "../hooks/useFsClipboardShortcuts";
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
  const treeContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { ref: treeSizeRef, width: treeWidth, height: treeHeight } = useElementSize<HTMLDivElement>();
  const { setContextMenu } = useWorkspaceCore();

  const { selected, selectedPaths, selectedIsDir, isBinary, bufferPath, busy } = tree;
  // `selected !== bufferPath` covers the window where the tree highlight has moved (a
  // multi-selection collapsed back to one row) but that file's content hasn't been loaded into
  // the editor yet — without it, the editor showed a stale buffer as if it were the new file's,
  // enabled and ready to overwrite it on the next save.
  const disabled =
    !selected || selected !== bufferPath || selectedIsDir || isBinary || editorReadOnly || selectedPaths.length > 1;

  useSaveShortcut(rootRef, () => {
    if (!busy && !disabled) void tree.handleSave();
  });

  // Scoped to the tree's own container (not `rootRef`, which also wraps the CodeMirror editor and
  // the inline-rename <input> — reusing it here would hijack normal text editing/renaming into a
  // file operation on every Backspace/Ctrl+C/X/V keystroke).
  useFsClipboardShortcuts(treeContainerRef, {
    onCopy: () => tree.handleCopy(),
    onCut: () => tree.handleCut(),
    onPaste: () => void tree.handlePaste(),
    onDelete: () => void tree.handleDelete(),
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
                onClick={() => void tree.handleDelete()}
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
            <div
              ref={(el) => {
                treeSizeRef(el);
                treeContainerRef.current = el;
              }}
              className="kt-explorer-tree border rounded"
              style={{ flex: 1, minHeight: 0 }}
              // Right-clicking the background below/around the rows targets the tree root. A row's
              // own handler runs first (events bubble child → parent) and has already put its menu
              // up, so bail out when the click actually landed on one.
              onContextMenu={(e) => {
                if ((e.target as HTMLElement).closest(".kt-explorer-row")) return;
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, items: createItems(tree, "/") });
              }}
            >
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
                    // react-arborist's default row wrapper already calls `node.handleClick` on
                    // click (ctrl/cmd-click toggles, shift-click range-selects, a plain click
                    // selects + activates) — onActivate is where a plain click's "open this
                    // folder" behavior belongs. It must NOT be duplicated by a second onClick on
                    // the row content below: both fire (the wrapper's click handler and ours,
                    // via bubbling), and since each independently reacts to the same modifier
                    // keys, they used to fight over the selection (e.g. our handler adds a
                    // ctrl-clicked row, then the wrapper's own handler sees it as already
                    // selected and immediately deselects it again).
                    onActivate={(node) => {
                      if (node.isInternal) node.toggle();
                    }}
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
            selectedPaths.length > 1
              ? `${selectedPaths.length} items selected.`
              : selectedIsDir
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

// The create actions offered wherever there is no file to act on — the tree's own background.
function createItems(tree: UseFsTree, dir: string): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { label: "New File", action: () => void tree.handleNewFile(dir) },
    { label: "New Folder", action: () => void tree.handleNewDirectory(dir) },
  ];
  if (tree.clipboard) items.push({ label: "Paste", action: () => void tree.handlePaste(dir) });
  return items;
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
    const path = node.data.path;
    // Right-clicking a row already part of a multi-selection acts on the whole selection; any
    // other row first collapses the selection down to just itself (VS Code semantics).
    if (!node.isSelected) node.select();
    const targets = node.isSelected ? Array.from(node.tree.selectedIds) : [path];
    const modifiable = targets.every(rowActions.canModify);
    const lockedTitle = modifiable ? undefined : "lab.conf can't be modified here.";

    const items: ContextMenuItem[] = [];
    if (node.data.dir) {
      items.push(
        { label: "New File", action: () => rowActions.onNewFile(path) },
        { label: "New Folder", action: () => rowActions.onNewDirectory(path) },
      );
    }
    items.push({ label: "Copy", action: () => rowActions.onCopy(targets) });
    items.push({ label: "Cut", disabled: !modifiable, title: lockedTitle, action: () => rowActions.onCut(targets) });
    if (node.data.dir && rowActions.canPaste) {
      items.push({ label: "Paste", action: () => rowActions.onPaste(path) });
    }
    if (targets.length === 1) {
      items.push({ label: "Rename", disabled: !modifiable, title: lockedTitle, action: () => rowActions.onRename(path) });
      if (rowActions.onDownload) {
        items.push({ label: "Download", action: () => rowActions.onDownload!(path) });
      }
    }
    items.push({
      label: targets.length > 1 ? `Delete ${targets.length} items` : "Delete",
      danger: true,
      disabled: !modifiable,
      title: lockedTitle,
      action: () => rowActions.onDelete(targets),
    });
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }

  const Icon = node.data.dir ? Folder : fileIcon(node.data.name);

  return (
    <div
      ref={dragHandle}
      style={style}
      className={`kt-explorer-row d-flex align-items-center gap-1 ${node.isSelected ? "kt-explorer-row--selected" : ""} ${
        node.willReceiveDrop ? "kt-explorer-row--drop" : ""
      } ${rowActions?.isCutPending(node.data.path) ? "kt-explorer-row--cut" : ""}`}
      // No onClick here: react-arborist's row wrapper already calls `node.handleClick` on click
      // (ctrl/cmd toggle, shift range-select, plain select+activate — see the `onActivate` prop
      // on <Tree> above for what a plain click's activation does). Adding a second onClick here
      // would fire alongside it via bubbling and fight over the selection.
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
        <Icon size={14} className="kt-explorer-icon" />
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
