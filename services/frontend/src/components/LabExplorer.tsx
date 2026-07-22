import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "react-bootstrap";
import { usePrompt } from "../context/PromptContext";
import { useToast } from "../context/ToastContext";
import { useBusyAction } from "../hooks/useBusyAction";
import { useConfirmDiscard } from "../hooks/useConfirmDiscard";
import { useSaveShortcut } from "../hooks/useSaveShortcut";
import { api } from "../services/api";
import { buildFileTree, buildVirtualFs, fileIcon, type TreeNode } from "../services/labfs";
import type { LabDetail, PendingMachineFiles } from "../services/types";
import { EditorPane } from "./EditorPane";

const STARTUP_RE = /^([a-z0-9_]{1,30})\.startup$/;

interface LabExplorerProps {
  labName: string;
  detail: LabDetail;
  // Called after a structural change (e.g. applying an edited lab.conf) so the parent can reload
  // `detail`. Optional — the classic page passes its `load`; callers that don't care can omit it.
  onStructuralChange?: () => Promise<void>;
}

// Browse/edit a lab's files: lab.conf (editable when the lab is not deployed — applied via the
// backend which rebuilds the topology), each device's startup script, and any files/dirs queued
// for it. Saving pushes live to a running device *and* queues the change for the next deploy. Does
// not (yet) cover: drag-and-drop moves, or a "shared/" broadcast-to-all-devices shortcut.
export function LabExplorer({ labName, detail, onStructuralChange }: LabExplorerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState<Record<string, PendingMachineFiles> | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [dirs, setDirs] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [editorText, setEditorText] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const prompt = usePrompt();
  const confirmDiscard = useConfirmDiscard();
  const runBusy = useBusyAction();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await api.getPendingFiles(labName);
        if (cancelled) return;
        setPending(p);
        const { files: f, dirs: d } = buildVirtualFs(detail, p);
        setFiles(f);
        setDirs(d);
      } catch (e) {
        if (!cancelled) toast.reportError("Load lab files", e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // detail is refetched by the parent on lifecycle actions; re-synthesizing on every
    // detail change keeps startup/interfaces in lab.conf's preview current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labName, detail]);

  const tree = useMemo(() => buildFileTree(files, dirs), [files, dirs]);

  const runningMachine = useCallback(
    (name: string) => detail.machines.find((m) => m.name === name)?.running ?? false,
    [detail.machines],
  );

  async function selectFile(path: string) {
    const ok = await confirmDiscard({
      currentPath: selected,
      nextPath: path,
      hasUnsavedChanges: !!selected && editorText !== (files[selected] ?? ""),
    });
    if (!ok) return;
    setSelected(path);
    setEditorText(files[path] ?? "");
  }

  function updateLocalFile(path: string, text: string) {
    setFiles((prev) => ({ ...prev, [path]: text }));
  }

  async function handleSave() {
    if (!selected) return;
    const content = editorText;
    updateLocalFile(selected, content);

    if (selected === "lab.conf") {
      if (detail.deployed) {
        toast.show("Undeploy the lab to edit lab.conf.", "info");
        return;
      }
      await runBusy(setBusy, "Apply lab.conf", async () => {
        await api.updateLabConf(labName, content);
        toast.show("Applied lab.conf — topology updated.", "success");
        await onStructuralChange?.();
      });
      return;
    }

    await runBusy(setBusy, "Save file", async () => {
      const startupMatch = STARTUP_RE.exec(selected);
      if (startupMatch) {
        const machine = startupMatch[1];
        await api.updatePendingFiles(labName, machine, { startup: content });
        if (runningMachine(machine)) {
          await api.copyFiles(labName, machine, { "/tmp/.kathara_boot.sh": content });
          await api.execCommand(labName, machine, "sh /tmp/.kathara_boot.sh", false);
          toast.show(`Ran ${machine}.startup; will re-run on the next deploy too.`, "success");
        } else {
          toast.show(`Saved ${selected}; runs on next deploy.`, "success");
        }
      } else if (selected.includes("/")) {
        const machine = selected.split("/")[0];
        const guest = "/" + selected.split("/").slice(1).join("/");
        await api.updatePendingFiles(labName, machine, { files: { [guest]: content } });
        if (runningMachine(machine)) {
          await api.copyFiles(labName, machine, { [guest]: content });
          toast.show(`Saved ${guest} to ${machine}.`, "success");
        } else {
          toast.show(`Saved ${selected}; applied to ${machine} on next deploy.`, "success");
        }
      } else {
        toast.show("Saved.", "success");
      }
    });
  }

  async function handleLoadFromDevice() {
    if (!selected || !selected.includes("/")) {
      toast.show("Select a <device>/… file to load.", "danger");
      return;
    }
    const machine = selected.split("/")[0];
    const guest = "/" + selected.split("/").slice(1).join("/");
    if (!runningMachine(machine)) {
      toast.show(`Device "${machine}" is not running.`, "danger");
      return;
    }
    await runBusy(setBusy, "Load file", async () => {
      const r = await api.execCommand(labName, machine, ["cat", guest], false);
      if (r.exit_code !== 0) {
        toast.show(`cat ${guest}: ${(r.stderr || "").trim() || "failed"}`, "danger");
        return;
      }
      updateLocalFile(selected, r.stdout);
      setEditorText(r.stdout);
    });
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = ""; // allow re-picking the same file
    if (!file) return;

    // The pending-files model is text-only; binary belongs to the Runtime FS tab (native fs).
    const buf = await file.arrayBuffer();
    if (new Uint8Array(buf).subarray(0, 8000).includes(0)) {
      toast.show("Binary files aren't supported here — use the Runtime FS tab for a running device.", "danger", "Binary file");
      return;
    }
    const content = new TextDecoder().decode(buf);

    const selDir = selected && selected.includes("/") ? selected.split("/").slice(0, -1).join("/") + "/" : "";
    const fallback = detail.machines[0] ? `${detail.machines[0].name}/` : "";
    const target = await prompt({
      title: `Upload ${file.name}`,
      message: "Target path (relative to the lab), e.g.: pc1/etc/frr/frr.conf",
      defaultValue: (selDir || fallback) + file.name,
      placeholder: "pc1/etc/frr/frr.conf",
      okLabel: "Upload",
    });
    if (!target) return;
    const clean = target.trim().replace(/^\/+/, "");
    if (!clean.includes("/")) {
      toast.show("Upload path must live under a device, e.g. pc1/etc/motd.", "danger");
      return;
    }

    const machine = clean.split("/")[0];
    const guest = "/" + clean.split("/").slice(1).join("/");
    await runBusy(setBusy, "Upload file", async () => {
      await api.updatePendingFiles(labName, machine, { files: { [guest]: content } });
      if (runningMachine(machine)) await api.copyFiles(labName, machine, { [guest]: content });
      updateLocalFile(clean, content);
      setOpen((prev) => new Set(prev).add(clean.split("/").slice(0, -1).join("/")));
      await selectFile(clean);
      toast.show(`Uploaded ${file.name} → ${clean}.`, "success");
    });
  }

  async function handleNewFile() {
    const path = await prompt({
      title: "Create file",
      message: "New file path (relative to the lab), e.g.: pc1/etc/frr/frr.conf, pc1.startup",
      placeholder: "pc1/etc/frr/frr.conf",
      okLabel: "Create",
    });
    if (!path) return;
    const clean = path.trim().replace(/^\/+/, "");
    if (!clean) return;
    if (files[clean] === undefined) updateLocalFile(clean, "");
    if (clean.includes("/")) setOpen((prev) => new Set(prev).add(clean.split("/").slice(0, -1).join("/")));
    await selectFile(clean);
  }

  async function handleNewDirectory() {
    const path = await prompt({
      title: "Create folder",
      message: "New directory path (relative to the lab), e.g.: pc1/etc/frr, pc1/var/log",
      placeholder: "pc1/etc/frr",
      okLabel: "Create",
    });
    if (!path) return;
    const clean = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!clean) return;

    setDirs((prev) => {
      const next = new Set(prev);
      const parts = clean.split("/");
      for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });

    const parts = clean.split("/");
    const top = parts[0];
    const guest = "/" + parts.slice(1).join("/");
    if (parts.length > 1 && guest !== "/" && detail.machines.some((m) => m.name === top)) {
      try {
        await api.updatePendingFiles(labName, top, { dirs: [guest] });
        toast.show(`Directory ${clean} queued. Files inside it are applied on deploy.`, "success");
      } catch (e) {
        toast.reportError("Queue directory", e);
      }
    }
    setOpen((prev) => new Set(prev).add(clean));
  }

  function toggleOpen(path: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderNode(node: TreeNode, depth: number): JSX.Element[] {
    return node.children.flatMap((child) => {
      const isOpen = open.has(child.path);
      if (child.dir) {
        return [
          <div
            key={child.path}
            className="d-flex align-items-center gap-1 py-1"
            style={{ paddingLeft: depth * 14, cursor: "pointer" }}
            onClick={() => toggleOpen(child.path)}
          >
            <span>{isOpen ? "▾" : "▸"}</span>
            <span>📁</span>
            <span>{child.name}</span>
          </div>,
          ...(isOpen ? renderNode(child, depth + 1) : []),
        ];
      }
      return [
        <div
          key={child.path}
          className={`d-flex align-items-center gap-1 py-1 px-1 rounded ${
            selected === child.path ? "bg-primary bg-opacity-25" : ""
          }`}
          style={{ paddingLeft: depth * 14 + 14, cursor: "pointer" }}
          onClick={() => {
            void selectFile(child.path);
          }}
        >
          <span>{fileIcon(child.name)}</span>
          <span className="font-monospace small">{child.name}</span>
        </div>,
      ];
    });
  }

  const canLoadFromDevice = !!selected && selected.includes("/") && runningMachine(selected.split("/")[0]);

  useSaveShortcut(
    rootRef,
    () => {
      if (!busy && selected) void handleSave();
    },
    [busy, selected, editorText, files],
  );

  return (
    <div ref={rootRef} className="d-flex gap-3 mt-3" style={{ minHeight: 420 }}>
      <div className="border rounded p-2" style={{ width: 260, overflowY: "auto" }}>
        <div className="d-flex gap-2 mb-2 flex-wrap">
          <Button size="sm" variant="outline-secondary" onClick={handleNewFile}>
            + File
          </Button>
          <Button size="sm" variant="outline-secondary" onClick={handleNewDirectory}>
            + Dir
          </Button>
          <Button size="sm" variant="outline-secondary" disabled={busy} onClick={() => fileInputRef.current?.click()}>
            ⤴ Upload
          </Button>
          <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleUpload} />
        </div>
        {pending == null ? <p className="text-muted small">Loading…</p> : renderNode(tree, 0)}
      </div>
      <EditorPane
        pathLabel={selected || "Select a file from the tree"}
        value={editorText}
        onChange={setEditorText}
        disabled={!selected || (selected === "lab.conf" && detail.deployed)}
        placeholder={selected ? undefined : "Select a file from the tree on the left…"}
        onSave={handleSave}
        saveDisabled={!selected || busy || (selected === "lab.conf" && detail.deployed)}
        extraActions={
          <Button size="sm" variant="outline-secondary" disabled={!canLoadFromDevice || busy} onClick={handleLoadFromDevice}>
            ⤵ Load from device
          </Button>
        }
      />
    </div>
  );
}
