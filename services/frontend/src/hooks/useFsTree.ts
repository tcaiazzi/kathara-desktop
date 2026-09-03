import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeApi, TreeApi } from "react-arborist";
import { useConfirm } from "../context/ConfirmContext";
import { usePrompt } from "../context/PromptContext";
import { useToast } from "../context/ToastContext";
import { ApiError } from "../services/api";
import { saveBlob } from "../services/download";
import {
  entryToNode,
  findNode,
  mergeNodeList,
  parentOf,
  toAbsolutePath,
  withMergedChildrenAt,
  type FsNode,
} from "../services/fsTree";
import { baseName, isSubPath } from "../services/paths";
import type { FsEntry } from "../services/types";
import { useBusyAction } from "./useBusyAction";
import { useConfirmDiscard } from "./useConfirmDiscard";

// Everything that differs between the two filesystem surfaces this hook drives: which endpoints
// the operations hit, what may be modified, and the wording shown to the user. Anything a caller
// needs to special-case for one path (LabExplorer's `/lab.conf`) belongs inside its own
// `readText`/`writeText` here rather than as a flag on the hook.
export interface FsTreeSource {
  list(path: string): Promise<FsEntry[]>;
  /** Throws `ApiError` with `errorType === "BinaryFileError"` for a non-UTF-8 file. */
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  move(sourcePath: string, destinationPath: string): Promise<void>;
  /** Never removes the source — Cut+Paste reuses `move` above instead. */
  copy(sourcePath: string, destinationPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  upload(path: string, file: File): Promise<void>;
  /** Omit on a surface with no download endpoint — the toolbar button hides itself. */
  download?(path: string): Promise<Blob>;
  /** Paths that can never be renamed, moved or deleted. Default: everything can. */
  canModify?(path: string): boolean;
  labels: FsTreeLabels;
}

export interface FsTreeLabels {
  /** Toast prefixes for the busy-action wrapper (`useBusyAction`'s error label). */
  openFile: string;
  saveFile: string;
  createFile: string;
  createDirectory: string;
  upload: string;
  download: string;
  delete: string;
  move: string;
  /** Busy/error label for a Paste batch. */
  paste: string;
  /** Success line after a save — a function so a caller can vary it per path. */
  saved(path: string): string;
  /** Copy for the create/upload prompts. */
  newFilePrompt: { title: string; message: string; placeholder(dir: string): string };
  newDirectoryPrompt: { title: string; message: string; placeholder(dir: string): string };
  uploadPrompt: { title(fileName: string): string; message: string };
  deleteConfirm(path: string, isDir: boolean): { title: string; message: string };
  /** Wording for deleting N>1 selected items at once. */
  deleteConfirmMultiple(count: number): { title: string; message: string };
  /** Confirm-before-overwrite when a Paste target name already exists. */
  pasteConfirmOverwrite(path: string, isDir: boolean): { title: string; message: string };
  /**
   * Directory an *upload* falls back to when nothing useful is selected — the lab tree points at
   * the first device's folder, since a file dropped at the lab root reaches no container. Create
   * actions deliberately don't use it: typing a path from `/` is the natural starting point there.
   */
  uploadFallbackDir?(): string;
}

export interface UseFsTreeOptions {
  source: FsTreeSource;
  /** Identity of what is being browsed (lab name, device name). A change resets everything. */
  scopeKey: string;
  /** False parks the hook: no fetching, empty tree (e.g. no running device to browse). */
  enabled?: boolean;
  /**
   * Re-list the root whenever this changes, *keeping* the current selection and editor buffer —
   * for an external event that may have altered the tree (a lab lifecycle action rewriting
   * lab.conf), as opposed to `scopeKey`, which means "this is a different filesystem now".
   */
  refreshKey?: unknown;
}

/** A pending Copy or Cut, holding the paths it was taken from. */
export interface FsClipboard {
  paths: string[];
  mode: "copy" | "cut";
}

export interface UseFsTree {
  treeRef: React.MutableRefObject<TreeApi<FsNode> | undefined>;
  data: FsNode[];
  loaded: boolean;
  busy: boolean;
  /** The *primary* selected path — what the editor shows, what rename/new-file "default dir" use. */
  selected: string | null;
  /** The full current multi-selection; always contains `selected` when non-empty. */
  selectedPaths: string[];
  selectedIsDir: boolean;
  canDelete: boolean;
  isBinary: boolean;
  /** Path of a *file* currently being read, for the editor's header. */
  loadingFile: string | null;
  editorText: string;
  setEditorText: (value: string) => void;
  /**
   * Replace the editor buffer *and* the saved baseline it is compared against — for a caller that
   * re-read the selected file's content out of band (LabExplorer re-fetching lab.conf), so the
   * buffer doesn't immediately read as unsaved.
   */
  setBuffer: (content: string) => void;
  /** Whether the editor buffer differs from what was last loaded/saved. */
  dirty: boolean;
  canModify: (path: string) => boolean;
  hasDownload: boolean;
  rowActions: FsRowActions;
  onTreeToggle: (id: string) => void;
  onTreeSelect: (nodes: NodeApi<FsNode>[]) => void;
  onTreeRename: (args: { id: string; name: string }) => void;
  onTreeMove: (args: { dragIds: string[]; parentId: string | null }) => void;
  handleSave: () => Promise<void>;
  handleNewFile: (defaultDir?: string) => Promise<void>;
  handleNewDirectory: (defaultDir?: string) => Promise<void>;
  handleUpload: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  /** Defaults to the current selection. */
  handleDelete: (paths?: string[]) => Promise<void>;
  handleDownload: (path: string) => Promise<void>;
  /** Current Copy/Cut clipboard, or null when empty. */
  clipboard: FsClipboard | null;
  isCutPending: (path: string) => boolean;
  /** Defaults to the current selection. */
  handleCopy: (paths?: string[]) => void;
  /** Defaults to the current selection, filtered to modifiable paths. */
  handleCut: (paths?: string[]) => void;
  /** Pastes into the given directory, or the default dir (selected folder/selected file's parent). */
  handlePaste: (destDirOverride?: string) => Promise<void>;
  /** Re-fetch every already-loaded directory, preserving expand state. */
  reload: () => Promise<void>;
  /** Re-list one directory (its not-yet-seen ancestors first). */
  refreshDir: (path: string) => Promise<void>;
}

// What the module-level row renderer (react-arborist needs a stable component identity, so it
// can't be redefined as a closure per render) reaches back into to build its right-click menu.
export interface FsRowActions {
  onNewFile: (dir: string) => void;
  onNewDirectory: (dir: string) => void;
  onDownload: ((path: string) => void) | null;
  onRename: (path: string) => void;
  onDelete: (paths: string[]) => void;
  onCopy: (paths: string[]) => void;
  onCut: (paths: string[]) => void;
  onPaste: (destDir: string) => void;
  canModify: (path: string) => boolean;
  /** Whether the clipboard currently holds anything to paste. */
  canPaste: boolean;
  isLoading: (path: string) => boolean;
  isCutPending: (path: string) => boolean;
}

const ALWAYS_MODIFIABLE = () => true;

// The whole state machine behind a lazily-loaded, editable filesystem tree: listing and merging
// directories, the selection/discard-confirmation flow, the editor buffer, and every mutation
// (create, upload, rename, move, delete, download). Both filesystem panels run on this one copy
// of the logic — they used to be two near-identical 800-line components, which is why the same
// bugs kept having to be fixed twice.
export function useFsTree({ source, scopeKey, enabled = true, refreshKey }: UseFsTreeOptions): UseFsTree {
  const treeRef = useRef<TreeApi<FsNode> | undefined>(undefined);

  const [loaded, setLoaded] = useState(false);
  const [tree, setTree] = useState<FsNode[]>([]);
  const treeRefValue = useRef<FsNode[]>(tree);
  useEffect(() => {
    treeRefValue.current = tree;
  }, [tree]);

  const [selected, setSelected] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<FsClipboard | null>(null);
  const [editorText, setEditorText] = useState("");
  const [loadedText, setLoadedText] = useState("");
  const [isBinary, setIsBinary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);

  const toast = useToast();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const confirmDiscard = useConfirmDiscard();
  const runBusy = useBusyAction();

  // Always-current source, so the effects/callbacks below don't have to be rebuilt (and the tree
  // re-fetched) every time the caller re-creates its adapter object.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const canModify = useCallback((path: string) => (sourceRef.current.canModify ?? ALWAYS_MODIFIABLE)(path), []);

  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const selectedPathsRef = useRef(selectedPaths);
  useEffect(() => {
    selectedPathsRef.current = selectedPaths;
  }, [selectedPaths]);
  // Read through a ref: rowActions/the row renderer read clipboard state outside React's render
  // cycle (isCutPending is called per-row from a memoized context value).
  const clipboardRef = useRef(clipboard);
  useEffect(() => {
    clipboardRef.current = clipboard;
  }, [clipboard]);
  // react-arborist's onSelect fires more than once for a single click (its own focus + selection
  // updates each trigger a callback) — without this, each firing independently runs the discard-
  // confirmation + fetch flow for the same target before `selected` has committed from the first
  // one, so `selectedRef.current` (checked below) hasn't caught up yet and doesn't dedupe them.
  const pendingSelectPathRef = useRef<string | null>(null);

  // A change of scope is a different filesystem: drop the tree and everything derived from it
  // rather than merging one device's listing into another's (both may have an `/etc`). The refs
  // are cleared during render, ahead of the effect, so nothing in flight can write stale state
  // against the new scope in between.
  const scopeRef = useRef(scopeKey);
  if (scopeRef.current !== scopeKey) {
    scopeRef.current = scopeKey;
    treeRefValue.current = [];
    pendingSelectPathRef.current = null;
    selectedRef.current = null;
    selectedPathsRef.current = [];
    clipboardRef.current = null;
  }
  useEffect(() => {
    setTree([]);
    setLoaded(false);
    setSelected(null);
    setSelectedPaths([]);
    setClipboard(null);
    setEditorText("");
    setLoadedText("");
    setIsBinary(false);
    setLoadingPath(null);
  }, [scopeKey]);

  // Root listing: on scope change, and again whenever the caller's `refreshKey` changes (which
  // keeps the current selection — see UseFsTreeOptions).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const entries = await sourceRef.current.list("/");
        if (!cancelled) {
          setTree((prev) => mergeNodeList(prev, entries.map(entryToNode)));
          setLoaded(true);
        }
      } catch (e) {
        if (!cancelled) toast.reportError(sourceRef.current.labels.openFile, e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, enabled, refreshKey]);

  const data = useMemo(() => tree, [tree]);

  // Bring a path into view (opening its ancestor folders) and sync the tree's own selection state
  // to match — react-arborist owns selection/open state internally, so whenever *our* `selected`
  // changes for a reason other than the user clicking a row directly, it has to be told. Reruns as
  // `tree` fills in while ancestor levels are still loading below.
  //
  // `t.select(path)` always *replaces* the tree's whole selection with just this one id — correct
  // for a programmatic jump (upload, create, rename, discard-confirm), but calling it whenever
  // `path` is already selected would undo a ctrl/shift multi-selection the instant it's made: a
  // multi-select click already lands in `selected` (see onTreeSelect's multi-selection branch),
  // re-triggering this effect, and `t.select` would immediately collapse the tree back down to
  // that one node. Skipping the call when the tree already agrees avoids that without weakening
  // the programmatic-jump case, where the target is never already selected.
  const revealAndSelect = useCallback((path: string | null) => {
    const t = treeRef.current;
    if (!t || !path) return;
    t.openParents(path);
    if (!t.isSelected(path)) t.select(path);
  }, []);
  useEffect(() => {
    revealAndSelect(selected);
  }, [selected, tree, revealAndSelect]);

  const loadAndMerge = useCallback(async (path: string): Promise<void> => {
    const entries = await sourceRef.current.list(path);
    const children = entries.map(entryToNode);
    setTree((prev) => (path === "/" ? mergeNodeList(prev, children) : withMergedChildrenAt(prev, path, children)));
  }, []);

  // Lazy per-directory fetch, triggered the first time a folder is expanded — `children ===
  // undefined` is exactly "never listed yet".
  const ensureLoaded = useCallback(
    async (path: string) => {
      const node = findNode(treeRefValue.current, path);
      if (!node || !node.dir || node.children !== undefined) return;
      setLoadingPath(path);
      try {
        await loadAndMerge(path);
      } catch (e) {
        toast.reportError(sourceRef.current.labels.openFile, e);
      } finally {
        setLoadingPath((prev) => (prev === path ? null : prev));
      }
    },
    [loadAndMerge, toast],
  );

  // Refresh one directory's listing after a write/delete/move affects something inside it —
  // loading any not-yet-seen ancestor along the way first, so a brand-new deeply nested path
  // (created under a folder nobody has expanded yet) still shows up correctly.
  const refreshDir = useCallback(
    async (path: string) => {
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
        toast.reportError(sourceRef.current.labels.openFile, e);
      }
    },
    [loadAndMerge, toast],
  );

  // Re-fetch every currently-loaded directory (recursively), preserving expand state — a true
  // resync with the real filesystem, not just the root level.
  const reload = useCallback(async () => {
    const list = (path: string) => sourceRef.current.list(path);
    async function reloadLevel(nodes: FsNode[]): Promise<FsNode[]> {
      return Promise.all(
        nodes.map(async (n) => {
          if (!n.dir || n.children === undefined) return n;
          const merged = mergeNodeList(n.children, (await list(n.path)).map(entryToNode));
          return { ...n, children: await reloadLevel(merged) };
        }),
      );
    }
    // Wrapped, unlike the callers' bare `void reload()`: a failure here used to surface as nothing
    // at all (an unhandled rejection), while every sibling operation reports through a toast.
    try {
      const merged = mergeNodeList(treeRefValue.current, (await list("/")).map(entryToNode));
      setTree(await reloadLevel(merged));
    } catch (e) {
      toast.reportError(sourceRef.current.labels.openFile, e);
    }
  }, [toast]);

  // Guards selectDir/selectFile against out-of-order responses: clicking file A then quickly file
  // B could otherwise let A's slower fetch land after B's and clobber the editor with stale
  // content. Each call captures its own generation at the start; any `setState` after an `await`
  // is skipped once a newer call has bumped the counter past it.
  const selectGenRef = useRef(0);
  const editorTextRef = useRef(editorText);
  editorTextRef.current = editorText;
  const loadedTextRef = useRef(loadedText);
  loadedTextRef.current = loadedText;

  const requestFileSwitch = useCallback(
    (nextPath: string) =>
      confirmDiscard({
        currentPath: selectedRef.current,
        nextPath,
        hasUnsavedChanges: !!selectedRef.current && editorTextRef.current !== loadedTextRef.current,
      }),
    [confirmDiscard],
  );

  // Selecting a folder row only needs to move the toolbar's delete/rename target — there's no
  // content to load, and the editor pane just goes blank/disabled for it.
  const selectDir = useCallback(
    async (path: string) => {
      const gen = ++selectGenRef.current;
      const ok = await requestFileSwitch(path);
      if (selectGenRef.current !== gen) return;
      if (!ok) {
        revealAndSelect(selectedRef.current);
        return;
      }
      setSelected(path);
      setEditorText("");
      setLoadedText("");
      setIsBinary(false);
    },
    [requestFileSwitch, revealAndSelect],
  );

  const selectFile = useCallback(
    async (path: string) => {
      const gen = ++selectGenRef.current;
      const ok = await requestFileSwitch(path);
      if (selectGenRef.current !== gen) return;
      if (!ok) {
        revealAndSelect(selectedRef.current);
        return;
      }
      setLoadingPath(path);
      try {
        await runBusy(setBusy, sourceRef.current.labels.openFile, async () => {
          try {
            const content = await sourceRef.current.readText(path);
            if (selectGenRef.current !== gen) return;
            setSelected(path);
            setEditorText(content);
            setLoadedText(content);
            setIsBinary(false);
          } catch (e) {
            if (e instanceof ApiError && e.errorType === "BinaryFileError") {
              // Not a failure from the user's point of view: select the file so download/delete/
              // rename work, just without a text preview.
              if (selectGenRef.current !== gen) return;
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
        if (selectGenRef.current === gen) setLoadingPath((prev) => (prev === path ? null : prev));
      }
    },
    [requestFileSwitch, revealAndSelect, runBusy],
  );

  const selectedIsDir = !!selected && (findNode(tree, selected)?.dir ?? false);

  const setBuffer = useCallback((content: string) => {
    setEditorText(content);
    setLoadedText(content);
    setIsBinary(false);
  }, []);

  const handleSave = useCallback(async () => {
    const path = selectedRef.current;
    if (!path) return;
    const content = editorTextRef.current;
    await runBusy(setBusy, sourceRef.current.labels.saveFile, async () => {
      await sourceRef.current.writeText(path, content);
      setLoadedText(content);
      toast.show(sourceRef.current.labels.saved(path), "success");
      await refreshDir(parentOf(path));
    });
  }, [refreshDir, runBusy, toast]);

  // The directory a create/upload should default to: the selected folder, or the selected file's
  // parent. `useFallback` additionally lets an upload land somewhere more useful than the root.
  const defaultDir = useCallback((useFallback = false): string => {
    const path = selectedRef.current;
    const fromSelection = path ? (findNode(treeRefValue.current, path)?.dir ? path : parentOf(path)) : "/";
    if (fromSelection !== "/") return fromSelection;
    return (useFallback ? sourceRef.current.labels.uploadFallbackDir?.() : undefined) ?? "/";
  }, []);

  const handleNewFile = useCallback(
    async (dirOverride?: string) => {
      const dir = dirOverride ?? defaultDir();
      const { title, message, placeholder } = sourceRef.current.labels.newFilePrompt;
      const answer = await prompt({
        title,
        message,
        defaultValue: dir === "/" ? "/" : `${dir}/`,
        placeholder: placeholder(dir),
        okLabel: "Create",
      });
      if (!answer) return;
      const clean = toAbsolutePath(answer);
      if (!clean) return;

      await runBusy(setBusy, sourceRef.current.labels.createFile, async () => {
        await sourceRef.current.writeText(clean, "");
        await refreshDir(parentOf(clean));
        await selectFile(clean);
      });
    },
    [defaultDir, prompt, refreshDir, runBusy, selectFile],
  );

  const handleNewDirectory = useCallback(async (dirOverride?: string) => {
    const dir = dirOverride ?? defaultDir();
    const { title, message, placeholder } = sourceRef.current.labels.newDirectoryPrompt;
    const answer = await prompt({
      title,
      message,
      defaultValue: dir === "/" ? "/" : `${dir}/`,
      placeholder: placeholder(dir),
      okLabel: "Create",
    });
    if (!answer) return;
    const clean = toAbsolutePath(answer);
    if (!clean) return;

    await runBusy(setBusy, sourceRef.current.labels.createDirectory, async () => {
      await sourceRef.current.mkdir(clean);
      await refreshDir(parentOf(clean));
      revealAndSelect(clean);
    });
  }, [defaultDir, prompt, refreshDir, revealAndSelect, runBusy]);

  const handleUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (e.target) e.target.value = ""; // allow re-picking the same file
      if (!file) return;

      const dir = defaultDir(true);
      const suggested = dir === "/" ? `/${file.name}` : `${dir}/${file.name}`;
      const { title, message } = sourceRef.current.labels.uploadPrompt;
      const answer = await prompt({
        title: title(file.name),
        message,
        defaultValue: suggested,
        placeholder: suggested,
        okLabel: "Upload",
      });
      if (!answer) return;
      const clean = toAbsolutePath(answer);
      if (!clean) return;

      await runBusy(setBusy, sourceRef.current.labels.upload, async () => {
        await sourceRef.current.upload(clean, file);
        await refreshDir(parentOf(clean));
        await selectFile(clean);
        toast.show(`Uploaded ${file.name} → ${clean}.`, "success");
      });
    },
    [defaultDir, prompt, refreshDir, runBusy, selectFile, toast],
  );

  // Drops a path from the clipboard (or rewrites it to its new location) so a since-deleted or
  // since-renamed cut item silently falls out instead of erroring at paste time.
  const pruneClipboard = useCallback((removedOrRenamedPath: string, renamedTo?: string) => {
    setClipboard((cb) => {
      if (!cb) return cb;
      const next = cb.paths
        .map((p) => (p === removedOrRenamedPath ? renamedTo : p))
        .filter((p): p is string => p !== undefined);
      if (next.length === 0) return null;
      if (next.length === cb.paths.length && next.every((p, i) => p === cb.paths[i])) return cb;
      return { ...cb, paths: next };
    });
  }, []);

  const handleDelete = useCallback(
    async (paths?: string[]) => {
      const targets = (paths ?? selectedPathsRef.current).filter(canModify);
      if (targets.length === 0) return;
      const multiple = targets.length > 1;
      const { title, message } = multiple
        ? sourceRef.current.labels.deleteConfirmMultiple(targets.length)
        : sourceRef.current.labels.deleteConfirm(
            targets[0],
            findNode(treeRefValue.current, targets[0])?.dir ?? false,
          );
      if (!(await confirm({ title, message, okLabel: "Delete" }))) return;

      await runBusy(setBusy, sourceRef.current.labels.delete, async () => {
        const parents = new Set<string>();
        let clearedEditor = false;
        for (const path of targets) {
          const isDir = findNode(treeRefValue.current, path)?.dir ?? false;
          await sourceRef.current.remove(path);
          parents.add(parentOf(path));
          pruneClipboard(path);
          if (
            !clearedEditor &&
            (selectedRef.current === path || (isDir && selectedRef.current?.startsWith(`${path}/`)))
          ) {
            setSelected(null);
            setEditorText("");
            setLoadedText("");
            setIsBinary(false);
            clearedEditor = true;
          }
        }
        setSelectedPaths((prev) => prev.filter((p) => !targets.includes(p)));
        toast.show(multiple ? `Deleted ${targets.length} items.` : `Deleted ${targets[0]}.`, "success");
        await Promise.all(Array.from(parents).map(refreshDir));
      });
    },
    [canModify, confirm, pruneClipboard, refreshDir, runBusy, toast],
  );

  const handleDownload = useCallback(
    async (path: string) => {
      const download = sourceRef.current.download;
      if (!download) return;
      await runBusy(setBusy, sourceRef.current.labels.download, async () => {
        saveBlob(await download(path), baseName(path) || "download.bin");
        toast.show(`Downloaded ${path}.`, "success");
      });
    },
    [runBusy, toast],
  );

  // Shared core for both drag-and-drop move and inline rename — the only difference between the
  // two is how `destPath` is computed (new parent, same name vs. same parent, new name).
  const movePath = useCallback(
    async (sourcePath: string, destPath: string) => {
      if (!canModify(sourcePath)) return;
      if (destPath === sourcePath) return;
      const destDir = parentOf(destPath);
      if (destDir === sourcePath || isSubPath(destDir, sourcePath)) return;

      await runBusy(setBusy, sourceRef.current.labels.move, async () => {
        await sourceRef.current.move(sourcePath, destPath);
        toast.show(`Moved ${sourcePath} → ${destPath}.`, "success");
        await Promise.all([refreshDir(parentOf(sourcePath)), refreshDir(destDir)]);
        if (selectedRef.current === sourcePath) setSelected(destPath);
        pruneClipboard(sourcePath, destPath);
      });
    },
    [canModify, pruneClipboard, refreshDir, runBusy, toast],
  );

  const handleTreeMove = useCallback(
    async ({ dragIds, parentId }: { dragIds: string[]; parentId: string | null }) => {
      const sourcePath = dragIds[0];
      if (!sourcePath) return;
      const name = baseName(sourcePath);
      if (!name) return;
      const destDirPath = parentId ?? "/";
      await movePath(sourcePath, destDirPath === "/" ? `/${name}` : `${destDirPath}/${name}`);
    },
    [movePath],
  );

  const handleRename = useCallback(
    async ({ id, name }: { id: string; name: string }) => {
      const clean = name.trim();
      if (!clean || clean.includes("/")) {
        toast.show("Invalid name.", "danger");
        return;
      }
      const destDirPath = parentOf(id);
      await movePath(id, destDirPath === "/" ? `/${clean}` : `${destDirPath}/${clean}`);
    },
    [movePath, toast],
  );

  const handleCopy = useCallback((paths?: string[]) => {
    const targets = paths ?? selectedPathsRef.current;
    if (targets.length === 0) return;
    setClipboard({ paths: targets, mode: "copy" });
  }, []);

  const handleCut = useCallback(
    (paths?: string[]) => {
      const targets = (paths ?? selectedPathsRef.current).filter(canModify);
      if (targets.length === 0) return;
      setClipboard({ paths: targets, mode: "cut" });
    },
    [canModify],
  );

  const isCutPending = useCallback(
    (path: string) => clipboardRef.current?.mode === "cut" && clipboardRef.current.paths.includes(path),
    [],
  );

  const handlePaste = useCallback(
    async (destDirOverride?: string) => {
      const cb = clipboardRef.current;
      if (!cb || cb.paths.length === 0) return;
      const destDir = destDirOverride ?? defaultDir();
      if (!canModify(destDir)) return;
      for (const p of cb.paths) {
        if (destDir === p || isSubPath(destDir, p)) {
          toast.show(`Can't paste ${baseName(p) || p} into itself.`, "danger");
          return;
        }
      }

      await runBusy(setBusy, sourceRef.current.labels.paste, async () => {
        const existing = new Map((await sourceRef.current.list(destDir)).map((e) => [e.name, e]));
        const cutParents = new Set<string>();
        let pasted = 0;
        for (const srcPath of cb.paths) {
          const name = baseName(srcPath);
          if (!name) continue;
          const destPath = destDir === "/" ? `/${name}` : `${destDir}/${name}`;
          if (destPath === srcPath) continue; // already here — skip, never self-copy/move
          if (!canModify(destPath)) {
            toast.show(`Can't paste over ${destPath}.`, "danger");
            continue;
          }
          const collision = existing.get(name);
          if (collision) {
            const { title, message } = sourceRef.current.labels.pasteConfirmOverwrite(destPath, collision.is_dir);
            if (!(await confirm({ title, message, okLabel: "Replace" }))) continue;
            // cp/copy_dir and mv/movedir merge into an existing directory instead of replacing
            // it — remove the old one first so "Replace" actually replaces.
            if (collision.is_dir) await sourceRef.current.remove(destPath);
          }
          if (cb.mode === "copy") {
            await sourceRef.current.copy(srcPath, destPath);
          } else {
            await sourceRef.current.move(srcPath, destPath);
            cutParents.add(parentOf(srcPath));
            pruneClipboard(srcPath);
          }
          pasted++;
        }
        if (pasted > 0) {
          await Promise.all([refreshDir(destDir), ...Array.from(cutParents).map(refreshDir)]);
          toast.show(`Pasted ${pasted} item(s) into ${destDir}.`, "success");
        }
      });
    },
    [canModify, confirm, defaultDir, pruneClipboard, refreshDir, runBusy, toast],
  );

  const hasDownload = !!source.download;
  const rowActions = useMemo<FsRowActions>(
    () => ({
      onNewFile: (dir) => void handleNewFile(dir),
      onNewDirectory: (dir) => void handleNewDirectory(dir),
      onDownload: hasDownload ? (path) => void handleDownload(path) : null,
      onRename: (path) => void treeRef.current?.edit(path),
      onDelete: (paths) => void handleDelete(paths),
      onCopy: (paths) => handleCopy(paths),
      onCut: (paths) => handleCut(paths),
      onPaste: (destDir) => void handlePaste(destDir),
      canModify,
      canPaste: clipboard !== null,
      isLoading: (path) => path === loadingPath,
      isCutPending,
    }),
    [
      canModify,
      clipboard,
      handleCopy,
      handleCut,
      handleDelete,
      handleDownload,
      handleNewDirectory,
      handleNewFile,
      handlePaste,
      hasDownload,
      isCutPending,
      loadingPath,
    ],
  );

  const onTreeToggle = useCallback(
    (id: string) => {
      if (treeRef.current?.isOpen(id)) void ensureLoaded(id);
    },
    [ensureLoaded],
  );

  const onTreeSelect = useCallback(
    (nodes: NodeApi<FsNode>[]) => {
      // Invalidates any selectFile/selectDir call still in flight from a *previous* selection
      // event (e.g. a slow readText for a just-clicked file) — without this, that call's eventual
      // `setSelected(path)` fires unconditionally once its fetch resolves, silently clobbering
      // whatever the user has selected by then (a ctrl/shift multi-selection included: nothing
      // else invalidates it, since only selectFile/selectDir themselves used to touch this ref).
      selectGenRef.current++;
      const paths = nodes.map((n) => n.data.path);
      setSelectedPaths(paths);
      if (paths.length === 0) {
        pendingSelectPathRef.current = null;
        setSelected(null);
        setEditorText("");
        setLoadedText("");
        setIsBinary(false);
        return;
      }
      // The tree's own notion of "most recently interacted with" row — so ctrl/shift-click
      // extending a selection doesn't yank the editor toward whichever node happens to be
      // nodes[0], and so the delete/rename target tracks what the user actually clicked last.
      const primaryNode = treeRef.current?.focusedNode ?? nodes[nodes.length - 1];
      const primary = primaryNode.data.path;
      if (paths.length > 1) {
        // Multi-selection: move the "selected" pointer for delete/rename-target purposes, but
        // skip the file-read/discard-confirm dance — there's no single file's content to show.
        if (primary === selectedRef.current) return;
        setSelected(primary);
        setEditorText("");
        setLoadedText("");
        setIsBinary(false);
        return;
      }
      // Single selection: existing behavior, unchanged.
      if (primary === selectedRef.current) return;
      if (primary === pendingSelectPathRef.current) return;
      pendingSelectPathRef.current = primary;
      const run = primaryNode.data.dir ? selectDir(primary) : selectFile(primary);
      void run.finally(() => {
        if (pendingSelectPathRef.current === primary) pendingSelectPathRef.current = null;
      });
    },
    [selectDir, selectFile],
  );

  const onTreeRename = useCallback((args: { id: string; name: string }) => void handleRename(args), [handleRename]);
  const onTreeMove = useCallback(
    (args: { dragIds: string[]; parentId: string | null }) => void handleTreeMove(args),
    [handleTreeMove],
  );

  // Only a file read should override the editor's path label — a directory being expanded (also
  // tracked via loadingPath, for the tree row spinner) has nothing to do with the editor.
  const loadingFile = loadingPath && !(findNode(tree, loadingPath)?.dir ?? false) ? loadingPath : null;

  return {
    treeRef,
    data,
    loaded,
    busy,
    selected,
    selectedPaths,
    selectedIsDir,
    canDelete: selectedPaths.length > 0 && selectedPaths.every(canModify),
    isBinary,
    loadingFile,
    editorText,
    setEditorText,
    setBuffer,
    dirty: !!selected && editorText !== loadedText,
    canModify,
    hasDownload,
    rowActions,
    onTreeToggle,
    onTreeSelect,
    onTreeRename,
    onTreeMove,
    handleSave,
    handleNewFile,
    handleNewDirectory,
    handleUpload,
    handleDelete,
    handleDownload,
    clipboard,
    isCutPending,
    handleCopy,
    handleCut,
    handlePaste,
    reload,
    refreshDir,
  };
}
