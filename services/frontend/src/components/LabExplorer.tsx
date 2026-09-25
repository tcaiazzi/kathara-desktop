import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "react-bootstrap";
import { useToast } from "../context/ToastContext";
import type { StartupChange } from "../context/WorkspaceCoreContext";
import { useFsTree, type FsTreeSource } from "../hooks/useFsTree";
import { api, ApiError, isAbortError } from "../services/api";
import type { LabConfView, LabDetail } from "../services/types";
import { FsTreePanel } from "./FsTreePanel";

interface LabExplorerProps {
  labId: string;
  detail: LabDetail;
  onStructuralChange?: () => Promise<void>;
  /** Called after a device's own `<name>.startup` is saved, so the Device Information panel's startup
   *  preview (fed by useDeviceActions' `startups`, fetched independently of this tab) picks it up. */
  onStartupFileSaved?: () => Promise<void>;
  /** Startup scripts that changed on disk outside the app — the tree re-lists, and the file open
   *  in the editor follows the new version (see the effect below). */
  startupChange?: StartupChange | null;
}

// lab.conf is the only entry that's never deletable, draggable or renamable here. Everything else
// is fair game, including a machine's own <name>.startup — it's just a real file sitting at the
// lab root, same as any other — and the bare device-root node itself, since this tab never touches
// a running device; acting on it only ever rewrites the lab's own on-disk files.
const LAB_CONF_PATH = "/lab.conf";
function canModify(path: string): boolean {
  return path !== LAB_CONF_PATH;
}

// A device's own startup file sits directly at the lab root (e.g. `/pc1.startup`) — this
// deliberately excludes nested `*.startup` files (e.g. `/pc1/foo.startup`), which aren't a
// device's exec script.
function isStartupFilePath(path: string): boolean {
  return /^\/[^/]+\.startup$/.test(path);
}

// Browse/edit a lab's own on-disk directory directly — lab.conf, every device's own folder, each
// device's `<name>.startup`, and anything else sitting at the lab root.
//
// Every read/write is a real call against the lab's real filesystem (services/api.ts's `fs*Offline`
// methods) — there is no separate in-memory cache of what's queued, so nothing here can ever drift
// from what's actually on disk; putting a cache in front of these calls is the only way it could.
// The tree/editor machinery is shared with the Runtime Filesystem tab (hooks/useFsTree +
// FsTreePanel); what's specific to this tab lives here: lab.conf is read/written through its own
// endpoint (it rebuilds the topology, and is refused while the lab is deployed) and is watched
// for changes made elsewhere.
export function LabExplorer({ labId, detail, onStructuralChange, onStartupFileSaved, startupChange }: LabExplorerProps) {
  const toast = useToast();

  const [labConf, setLabConf] = useState<LabConfView | null>(null);
  // Last content known to be on disk — the baseline both the conflict check and the post-save
  // verification compare against.
  const serverConfRef = useRef<string>("");
  const [confConflict, setConfConflict] = useState<string | null>(null);
  const [confReloadKey, setConfReloadKey] = useState(0);

  // lab.conf's content is the editor buffer for `/lab.conf`, so the source below has to reach the
  // *current* value without being rebuilt (and the whole tree re-created) on every keystroke.
  const labConfRef = useRef<LabConfView | null>(labConf);
  labConfRef.current = labConf;
  const deployedRef = useRef(detail.deployed);
  deployedRef.current = detail.deployed;

  const applyLabConf = useCallback(
    async (content: string) => {
      if (deployedRef.current) throw new Error("Undeploy the lab to edit lab.conf.");
      await api.updateLabConf(labId, content);
      // Re-read to refresh our "last known server text" baseline — not to recover a "normalized"
      // version. The backend stores lab.conf verbatim: if what comes back differs from what was
      // just sent, that is a backend bug, not a client-side detail to paper over by silently
      // accepting the server's text.
      const conf = await api.getLabConf(labId);
      if (conf.content !== content) {
        toast.show("lab.conf was saved, but the server returned different text than submitted.", "danger");
      }
      serverConfRef.current = conf.content;
      setLabConf(conf);
      setConfConflict(null);
      await onStructuralChange?.();
    },
    [labId, onStructuralChange, toast],
  );

  const source = useMemo<FsTreeSource>(
    () => ({
      list: async (path, signal) => (await api.fsListOffline(labId, path, signal)).entries,
      readText: async (path) =>
        path === LAB_CONF_PATH
          ? labConfRef.current?.content ?? ""
          : (await api.fsReadTextOffline(labId, path)).content,
      writeText: async (path, content) => {
        if (path === LAB_CONF_PATH) {
          await applyLabConf(content);
          return;
        }
        await api.fsWriteTextOffline(labId, path, content);
        if (isStartupFilePath(path)) await onStartupFileSaved?.();
      },
      mkdir: async (path) => void (await api.fsMkdirOffline(labId, path)),
      move: async (source, destination) => void (await api.fsMoveOffline(labId, source, destination)),
      copy: async (source, destination) => void (await api.fsCopyOffline(labId, source, destination)),
      remove: async (path) => void (await api.fsDeleteOffline(labId, path, true)),
      upload: async (path, file) => void (await api.fsUploadOffline(labId, path, file)),
      download: (path) => api.fsDownloadOffline(labId, path),
      search: (path, query, caseSensitive, signal) =>
        api.fsSearchOffline(labId, path, query, caseSensitive, signal),
      canModify,
      cannotModifyReason: "lab.conf can't be modified here.",
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
        saved: (path) => (path === LAB_CONF_PATH ? "Applied lab.conf — topology updated." : `Saved ${path}.`),
        newFilePrompt: {
          title: "Create file",
          message: "New file path (relative to the lab), e.g.: pc1/etc/frr/frr.conf, pc1.startup, notes.txt",
          placeholder: () => "pc1/etc/frr/frr.conf",
        },
        newDirectoryPrompt: {
          title: "Create folder",
          message: "New directory path (relative to the lab), e.g.: pc1/etc/frr, pc1/var/log, scratch",
          placeholder: () => "pc1/etc/frr",
        },
        uploadPrompt: {
          title: (fileName) => `Upload ${fileName}`,
          message: "Target path (relative to the lab), e.g.: /pc1/etc/frr/frr.conf",
        },
        deleteConfirm: (path, isDir) => ({
          title: isDir ? "Delete folder?" : "Delete file?",
          message: `Delete ${path}? This cannot be undone.`,
        }),
        deleteConfirmMultiple: (count) => ({
          title: "Delete items?",
          message: `Delete ${count} items? This cannot be undone.`,
        }),
        pasteConfirmOverwrite: (path, isDir) => ({
          title: isDir ? "Replace folder?" : "Replace file?",
          message: `${path} already exists. Replace it?`,
        }),
        uploadFallbackDir: () => (detail.machines[0] ? `/${detail.machines[0].name}` : "/"),
      },
    }),
    [applyLabConf, detail.machines, labId, onStartupFileSaved],
  );

  // A token whose identity changes exactly when the tree should be re-listed: on any lab
  // lifecycle action (`detail` gets a new identity on every refresh, and several of them rewrite
  // lab.conf) and on the toolbar's ↻. Not `detail` itself, so the ↻ counts too, and not an inline
  // object, which would re-list on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const refreshKey = useMemo(() => ({}), [detail, confReloadKey, startupChange]);
  const tree = useFsTree({ source, scopeKey: labId, refreshKey });

  // Read through refs so this effect doesn't re-run on every keystroke in the editor. Keyed off
  // `bufferPath` rather than `selected`: it's the file whose content `dirty`/`setBuffer` actually
  // act on, and the two can differ (e.g. a multi-selection moves `selected` without touching the
  // buffer) — keying off `selected` asks the wrong question, and would show or discard a conflict
  // for whatever is merely highlighted rather than what's actually loaded in the editor.
  const bufferPathRef = useRef(tree.bufferPath);
  bufferPathRef.current = tree.bufferPath;
  const dirtyRef = useRef(tree.dirty);
  dirtyRef.current = tree.dirty;
  const loadedTextRef = useRef(tree.loadedText);
  loadedTextRef.current = tree.loadedText;
  const editorTextRef = useRef(tree.editorText);
  editorTextRef.current = tree.editorText;
  const setBuffer = tree.setBuffer;

  // A startup script changed on disk outside the app. The file open in the editor follows it, but
  // unsaved edits are never replaced: saving them would overwrite the outside version, so that is
  // said instead. The disk copy is compared with the editor first — the change the watcher saw may
  // just be this editor's own save coming back, landing before the save marked the buffer clean.
  // One deleted outside the app keeps its buffer, which saving would write back.
  useEffect(() => {
    const path = bufferPathRef.current;
    if (!startupChange || !path || !startupChange.paths.includes(path)) return;
    const controller = new AbortController();
    (async () => {
      try {
        const { content } = await api.fsReadTextOffline(labId, path);
        if (controller.signal.aborted || bufferPathRef.current !== path || content === loadedTextRef.current) return;
        if (content === editorTextRef.current || !dirtyRef.current) {
          setBuffer(path, content);
        } else {
          toast.show(`${path} changed on disk. Saving your edits will overwrite that version.`, "info", "Changed on disk");
        }
      } catch (e) {
        if (controller.signal.aborted || bufferPathRef.current !== path) return;
        if (e instanceof ApiError && e.status === 404) {
          toast.show(`${path} was deleted on disk. Saving will create it again.`, "info", "Changed on disk");
        } else if (!isAbortError(e)) {
          toast.reportError("Reload file", e);
        }
      }
    })();
    return () => controller.abort();
  }, [startupChange, labId, setBuffer, toast]);

  // Keep lab.conf in step with what's on disk. If the file changed underneath an edit in progress,
  // don't clobber the buffer — surface the conflict and let the user decide.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const conf = await api.getLabConf(labId, controller.signal);
        const editing = bufferPathRef.current === LAB_CONF_PATH;
        const changed = conf.content !== serverConfRef.current;
        if (editing && dirtyRef.current && changed) {
          setConfConflict(conf.content);
        } else {
          serverConfRef.current = conf.content;
          setConfConflict(null);
          if (editing && changed) setBuffer(LAB_CONF_PATH, conf.content);
        }
        setLabConf(conf);
      } catch (e) {
        if (!isAbortError(e)) toast.reportError("Load lab.conf", e);
      }
    })();
    // Aborts the fetch rather than ignoring its result: switching labs quickly would otherwise
    // leave the previous lab's read running, and it is the one that answers into a dead effect.
    return () => controller.abort();
  }, [labId, detail, confReloadKey, setBuffer, toast]);

  function acceptConfConflict() {
    if (confConflict === null) return;
    serverConfRef.current = confConflict;
    setBuffer(LAB_CONF_PATH, confConflict);
    setConfConflict(null);
  }

  const editingLabConf = tree.bufferPath === LAB_CONF_PATH;

  return (
    <FsTreePanel
      tree={tree}
      dragHint="Drag files/folders onto a device or folder to move them. Double-click or F2 to rename."
      onReload={() => {
        setConfReloadKey((k) => k + 1);
        void tree.reload();
      }}
      editorReadOnly={editingLabConf && detail.deployed}
      readOnlyPlaceholder="Undeploy the lab to edit lab.conf."
      bannerSlot={
        editingLabConf && (
          <>
            {confConflict !== null && (
              <div className="alert alert-warning py-1 px-2 mb-2 d-flex justify-content-between align-items-center small">
                <span>lab.conf changed on disk since you started editing.</span>
                <Button size="sm" variant="outline-dark" onClick={acceptConfConflict}>
                  Reload from Disk (Discards Your Edits)
                </Button>
              </div>
            )}
            {labConf?.exists === false && (
              <div className="text-muted small mb-1">Not on disk yet — saving will create it.</div>
            )}
          </>
        )
      }
    />
  );
}
