import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { useConfirm } from "../context/ConfirmContext";
import { usePrompt } from "../context/PromptContext";
import { useToast } from "../context/ToastContext";
import { useBusyAction } from "../hooks/useBusyAction";
import { useConfirmDiscard } from "../hooks/useConfirmDiscard";
import { useSaveShortcut } from "../hooks/useSaveShortcut";
import { api } from "../services/api";
import { saveBlob } from "../services/download";
import { baseName, isSubPath, normalizeDir } from "../services/paths";
import type { FsEntry, LabDetail } from "../services/types";
import { EditorPane } from "./EditorPane";

interface RuntimeFilesystemEditorProps {
  labName: string;
  detail: LabDetail;
  preferredMachine?: string | null;
  compact?: boolean;
}

export function RuntimeFilesystemEditor({
  labName,
  detail,
  preferredMachine = null,
  compact = false,
}: RuntimeFilesystemEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const runningMachines = useMemo(
    () => detail.machines.filter((m) => m.running).map((m) => m.name),
    [detail.machines],
  );
  const [machine, setMachine] = useState<string>(runningMachines[0] ?? "");
  const [path, setPath] = useState<string>("/");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [dropIntoCurrentDir, setDropIntoCurrentDir] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [editorText, setEditorText] = useState("");
  const [loadedText, setLoadedText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const confirmDiscard = useConfirmDiscard();
  const runBusy = useBusyAction();
  const uploadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!runningMachines.length) {
      setMachine("");
      setPath("/");
      setEntries([]);
      setSelectedPath(null);
      setEditorText("");
      setLoadedText("");
      return;
    }
    if (!machine || !runningMachines.includes(machine)) {
      setMachine(runningMachines[0]);
      setPath("/");
      setEntries([]);
      setSelectedPath(null);
      setEditorText("");
      setLoadedText("");
    }
  }, [machine, runningMachines]);

  useEffect(() => {
    if (!preferredMachine) return;
    if (!runningMachines.includes(preferredMachine)) return;
    setMachine(preferredMachine);
    setPath("/");
    setSelectedPath(null);
    setEditorText("");
    setLoadedText("");
  }, [preferredMachine, runningMachines]);

  const filteredEntries = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(q));
  }, [entries, filterText]);

  const hasUnsavedChanges = !!selectedPath && editorText !== loadedText;

  async function loadDirectory() {
    if (!machine) return;
    await runBusy(setLoading, `Load runtime directory ${path}`, async () => {
      const resp = await api.fsList(labName, machine, path);
      setEntries(resp.entries);
    });
  }

  useEffect(() => {
    void loadDirectory();
    // path and machine changes should refresh the listing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, machine]);

  function navigate(to: string) {
    setPath(to || "/");
    setSelectedPath(null);
  }

  const breadcrumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    const acc: { label: string; value: string }[] = [{ label: "/", value: "/" }];
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      acc.push({ label: part, value: current });
    }
    return acc;
  }, [path]);

  function up() {
    if (path === "/") return;
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= 1) {
      navigate("/");
      return;
    }
    navigate(`/${parts.slice(0, -1).join("/")}`);
  }

  async function openFile(filePath: string) {
    if (!machine) return;
    await runBusy(setBusy, "Open runtime file", async () => {
      const resp = await api.fsReadText(labName, machine, filePath);
      setSelectedPath(resp.path);
      setEditorText(resp.content);
      setLoadedText(resp.content);
    });
  }

  function requestFileSwitch(nextPath: string): Promise<boolean> {
    return confirmDiscard({ currentPath: selectedPath, nextPath, hasUnsavedChanges });
  }

  async function saveFile() {
    if (!machine || !selectedPath) return;
    await runBusy(setBusy, "Save runtime file", async () => {
      await api.fsWriteText(labName, machine, selectedPath, editorText);
      setLoadedText(editorText);
      toast.show(`Saved ${selectedPath} on ${machine}.`, "success");
    });
  }

  async function createFile() {
    if (!machine) return;
    const newPath = await prompt({
      title: "Create runtime file",
      message: "Absolute path on the running device, e.g.: /etc/frr/frr.conf",
      placeholder: path === "/" ? "/tmp/new-file.txt" : `${path}/new-file.txt`,
      okLabel: "Create",
    });
    if (!newPath) return;
    await runBusy(setBusy, "Create runtime file", async () => {
      await api.fsWriteText(labName, machine, newPath, "");
      toast.show(`Created ${newPath} on ${machine}.`, "success");
      await loadDirectory();
    });
  }

  async function createDirectory() {
    if (!machine) return;
    const newPath = await prompt({
      title: "Create runtime directory",
      message: "Absolute directory path, e.g.: /etc/frr",
      placeholder: path === "/" ? "/tmp/new-dir" : `${path}/new-dir`,
      okLabel: "Create",
    });
    if (!newPath) return;
    await runBusy(setBusy, "Create runtime directory", async () => {
      await api.fsMkdir(labName, machine, newPath);
      toast.show(`Created ${newPath} on ${machine}.`, "success");
      await loadDirectory();
    });
  }

  async function renamePath() {
    if (!machine || !selectedPath) {
      toast.show("Select a runtime file or directory to rename.", "danger");
      return;
    }
    const destination = await prompt({
      title: "Rename / Move runtime path",
      message: `New absolute path for ${selectedPath}`,
      placeholder: selectedPath,
      okLabel: "Move",
    });
    if (!destination || destination === selectedPath) return;
    await runBusy(setBusy, "Rename runtime path", async () => {
      await api.fsMove(labName, machine, selectedPath, destination);
      setSelectedPath(destination);
      toast.show(`Moved to ${destination}.`, "success");
      await loadDirectory();
    });
  }

  async function movePath(sourcePath: string, targetDir: string) {
    if (!machine) return;
    const source = normalizeDir(sourcePath);
    const destDir = normalizeDir(targetDir || "/");
    if (!source || source === "/") return;
    if (source === destDir) return;
    if (isSubPath(destDir, source)) {
      toast.show("Cannot move a folder into one of its descendants.", "danger");
      return;
    }
    const name = baseName(source);
    if (!name) return;
    const destination = destDir === "/" ? `/${name}` : `${destDir}/${name}`;
    if (destination === source) return;

    await runBusy(setBusy, "Drag and drop move", async () => {
      await api.fsMove(labName, machine, source, destination);
      if (selectedPath === source) setSelectedPath(destination);
      toast.show(`Moved ${source} to ${destination}.`, "success");
      await loadDirectory();
    });
    setDraggedPath(null);
    setDropTargetPath(null);
    setDropIntoCurrentDir(false);
  }

  async function uploadDroppedFiles(fileList: FileList) {
    if (!machine || !fileList.length) return;
    const files = Array.from(fileList);
    await runBusy(setBusy, "Drop upload", async () => {
      for (const file of files) {
        const destination = path === "/" ? `/${file.name}` : `${normalizeDir(path)}/${file.name}`;
        await api.fsUpload(labName, machine, destination, file);
      }
      toast.show(`Uploaded ${files.length} file(s) to ${path}.`, "success");
      await loadDirectory();
    });
    setDropIntoCurrentDir(false);
  }

  async function deletePath() {
    if (!machine || !selectedPath) {
      toast.show("Select a runtime file or directory to delete.", "danger");
      return;
    }
    const ok = await confirm({
      title: "Delete runtime path?",
      message: `Delete ${selectedPath} from ${machine}?`,
      okLabel: "Delete",
    });
    if (!ok) return;
    await runBusy(setBusy, "Delete runtime path", async () => {
      await api.fsDelete(labName, machine, selectedPath, true);
      setSelectedPath(null);
      setEditorText("");
      setLoadedText("");
      toast.show(`Deleted ${selectedPath}.`, "success");
      await loadDirectory();
    });
  }

  async function downloadPath() {
    if (!machine || !selectedPath) {
      toast.show("Select a runtime file to download.", "danger");
      return;
    }
    await runBusy(setBusy, "Download runtime file", async () => {
      const blob = await api.fsDownload(labName, machine, selectedPath);
      const name = selectedPath.split("/").filter(Boolean).pop() || "download.bin";
      saveBlob(blob, name);
      toast.show(`Downloaded ${selectedPath}.`, "success");
    });
  }

  async function uploadPath(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !machine) return;
    const destination = await prompt({
      title: "Upload to runtime path",
      message: `Destination absolute path for ${file.name}`,
      placeholder: path === "/" ? `/${file.name}` : `${path}/${file.name}`,
      okLabel: "Upload",
    });
    e.target.value = "";
    if (!destination) return;
    await runBusy(setBusy, "Upload runtime file", async () => {
      await api.fsUpload(labName, machine, destination, file);
      toast.show(`Uploaded ${file.name} to ${destination}.`, "success");
      await loadDirectory();
    });
  }

  useSaveShortcut(
    rootRef,
    () => {
      if (!busy && selectedPath) void saveFile();
    },
    [busy, selectedPath, editorText, loadedText, machine, labName],
  );

  return (
    <div ref={rootRef} className={`d-flex gap-3 ${compact ? "mt-0" : "mt-3"}`} style={{ minHeight: compact ? 360 : 420 }}>
      <div className="border rounded p-2" style={{ width: compact ? 320 : 360, overflowY: "auto" }}>
        <div className="d-flex justify-content-between align-items-center mb-2">
          <strong className="small">Runtime Filesystem</strong>
          <Button size="sm" variant="outline-secondary" onClick={loadDirectory} disabled={!machine || busy || loading}>
            Refresh
          </Button>
        </div>

        {runningMachines.length ? (
          <>
            <Form.Select
              size="sm"
              className="mb-2"
              value={machine}
              onChange={(e) => {
                setMachine(e.target.value);
                setPath("/");
                setSelectedPath(null);
                setEditorText("");
              }}
            >
              {runningMachines.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Form.Select>

            <div className="d-flex gap-2 mb-2">
              <Button size="sm" variant="outline-secondary" onClick={up} disabled={path === "/" || busy}>
                Up
              </Button>
              <Button size="sm" variant="outline-secondary" onClick={createFile} disabled={busy}>
                + File
              </Button>
              <Button size="sm" variant="outline-secondary" onClick={createDirectory} disabled={busy}>
                + Dir
              </Button>
            </div>
            <div className="d-flex flex-wrap align-items-center gap-1 mb-2">
              {breadcrumbs.map((crumb, idx) => {
                const isLast = idx === breadcrumbs.length - 1;
                return (
                  <div key={crumb.value} className="d-flex align-items-center gap-1">
                    <Button
                      size="sm"
                      variant={isLast ? "secondary" : "outline-secondary"}
                      disabled={busy || isLast}
                      onClick={() => navigate(crumb.value)}
                      className="py-0 px-2 font-monospace"
                    >
                      {crumb.label}
                    </Button>
                    {!isLast && <span className="text-muted small">/</span>}
                  </div>
                );
              })}
            </div>
            <div className="small text-muted mb-2">Drag entries onto folders to move. Drop local files here to upload.</div>

            <Form.Control
              size="sm"
              className="mb-2"
              placeholder="Filter entries…"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />

            <div className="d-flex gap-2 mb-2">
              <Button size="sm" variant="outline-secondary" onClick={renamePath} disabled={!selectedPath || busy}>
                Rename
              </Button>
              <Button size="sm" variant="outline-danger" onClick={deletePath} disabled={!selectedPath || busy}>
                Delete
              </Button>
            </div>

            <div className="d-flex gap-2 mb-2">
              <Button size="sm" variant="outline-secondary" onClick={() => uploadInputRef.current?.click()} disabled={busy}>
                Upload
              </Button>
              <Button size="sm" variant="outline-secondary" onClick={downloadPath} disabled={!selectedPath || busy}>
                Download
              </Button>
            </div>

            <input ref={uploadInputRef} type="file" style={{ display: "none" }} onChange={uploadPath} />

            <div
              className={`border rounded p-1 ${dropIntoCurrentDir ? "bg-primary bg-opacity-10" : ""}`}
              style={{ maxHeight: 300, overflowY: "auto" }}
              onDragOver={(e) => {
                const hasLocalFiles = (e.dataTransfer?.types || []).includes("Files");
                if (hasLocalFiles || draggedPath) {
                  e.preventDefault();
                  setDropIntoCurrentDir(true);
                }
              }}
              onDragLeave={() => setDropIntoCurrentDir(false)}
              onDrop={(e) => {
                e.preventDefault();
                const hasLocalFiles = e.dataTransfer.files && e.dataTransfer.files.length > 0;
                if (hasLocalFiles) {
                  void uploadDroppedFiles(e.dataTransfer.files);
                  return;
                }
                if (draggedPath) void movePath(draggedPath, path);
              }}
            >
              {loading ? (
                <p className="text-muted small mb-0">Loading runtime directory…</p>
              ) : filteredEntries.length ? (
                filteredEntries.map((entry) => {
                  const isSelected = selectedPath === entry.path;
                  const isDropTarget = dropTargetPath === entry.path;
                  return (
                    <div
                      key={entry.path}
                      className={`d-flex align-items-center justify-content-between px-1 py-1 rounded ${
                        isSelected ? "bg-primary bg-opacity-25" : ""
                      } ${
                        isDropTarget ? "border border-primary" : ""
                      }`}
                      style={{ cursor: "pointer" }}
                      draggable={!busy}
                      onDragStart={() => {
                        setDraggedPath(entry.path);
                        setDropTargetPath(null);
                      }}
                      onDragEnd={() => {
                        setDraggedPath(null);
                        setDropTargetPath(null);
                        setDropIntoCurrentDir(false);
                      }}
                      onDragOver={(e) => {
                        if (!entry.is_dir || !draggedPath || draggedPath === entry.path) return;
                        e.preventDefault();
                        setDropTargetPath(entry.path);
                      }}
                      onDragLeave={() => {
                        if (dropTargetPath === entry.path) setDropTargetPath(null);
                      }}
                      onDrop={(e) => {
                        if (!entry.is_dir) return;
                        e.preventDefault();
                        if (draggedPath) {
                          void movePath(draggedPath, entry.path);
                        }
                      }}
                      onClick={() => {
                        if (entry.is_dir) {
                          navigate(entry.path);
                          return;
                        }
                        void (async () => {
                          const ok = await requestFileSwitch(entry.path);
                          if (!ok) return;
                          await openFile(entry.path);
                        })();
                      }}
                    >
                      <span className="font-monospace small">
                        {entry.is_dir ? "📁" : "📄"} {entry.name}
                      </span>
                      <span className="text-muted small">{entry.is_dir ? "dir" : entry.size ?? "-"}</span>
                    </div>
                  );
                })
              ) : (
                <p className="text-muted small mb-0">
                  {filterText.trim() ? "No entries match the filter." : "Directory is empty."}
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="text-muted small mb-0">No running devices. Deploy the lab first.</p>
        )}
      </div>

      <EditorPane
        pathLabel={selectedPath || "Select a runtime file from the left"}
        value={editorText}
        onChange={setEditorText}
        disabled={!selectedPath}
        placeholder={selectedPath ? undefined : "Select a runtime file from the tree on the left…"}
        onSave={saveFile}
        saveDisabled={!selectedPath || busy}
      />
    </div>
  );
}
