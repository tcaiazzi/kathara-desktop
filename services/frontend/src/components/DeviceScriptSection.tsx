import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "react-bootstrap";
import { FilePlus, Pencil } from "lucide-react";
import { useConfirm } from "../context/ConfirmContext";
import { useToast } from "../context/ToastContext";
import { useBusyAction } from "../hooks/useBusyAction";
import { useSaveShortcut } from "../hooks/useSaveShortcut";
import { api, ApiError } from "../services/api";
import { languageForPath } from "../services/editorLanguage";
import { EditorPane } from "./EditorPane";

type DeviceScriptKind = "startup" | "shutdown";

interface DeviceScriptSectionProps {
  labId: string;
  device: string;
  kind: DeviceScriptKind;
  /** Whether `<device>.<kind>` exists in the lab root; null while that is not known yet. */
  exists: boolean | null;
  /** What to show when not editing. Omitted: the file's own content, read here. */
  preview?: string;
  /** Called after a save, with the file now on disk. */
  onSaved: () => void;
  /** Reports the editor's unsaved buffer (its label) or null — see DeviceInfoTabs. */
  onDirtyChange: (label: string | null) => void;
  /** Opens the editor each time it changes (not on mount) — the "Configure Device" request. */
  editRequest?: number;
}

const EDITOR_HEIGHT = 240;

// One of a device's boot scripts (`<device>.startup` / `<device>.shutdown`, in the lab root), shown
// in the Inspector and edited in place. A missing script is created by editing an empty
// buffer: the file only comes into being on the first Save, so cancelling leaves nothing behind.
export function DeviceScriptSection({
  labId,
  device,
  kind,
  exists,
  preview,
  onSaved,
  onDirtyChange,
  editRequest,
}: DeviceScriptSectionProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const { run } = useBusyAction();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileName = `${device}.${kind}`;
  const path = `/${fileName}`;
  const title = kind === "startup" ? "Startup" : "Shutdown";

  const [fileText, setFileText] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // The text the edit started from, and what the editor holds now.
  const [baseline, setBaseline] = useState("");
  const [text, setText] = useState("");
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = editing && text !== baseline;

  useEffect(() => onDirtyChange(dirty ? `${fileName} in the Inspector` : null), [dirty, fileName, onDirtyChange]);

  // The file as it is on disk, or "" when it isn't there.
  const readFile = useCallback(async (): Promise<string> => {
    try {
      return (await api.fsReadTextOffline(labId, path)).content;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return "";
      throw e;
    }
  }, [labId, path]);

  // Without a `preview`, the section shows the file itself — read whenever it may have changed.
  useEffect(() => {
    if (preview !== undefined || !exists) {
      setFileText(null);
      return;
    }
    let live = true;
    readFile()
      .then((content) => {
        if (live) setFileText(content);
      })
      .catch(() => {
        if (live) setFileText(null);
      });
    return () => {
      live = false;
    };
  }, [preview, exists, readFile]);

  const startEditing = useCallback(async () => {
    await run(setBusy, `Open ${fileName}`, async () => {
      const content = exists ? await readFile() : "";
      setBaseline(content);
      setText(content);
      setChangedOnDisk(false);
      setEditing(true);
    });
  }, [exists, fileName, readFile, run]);

  // A "Configure Device" request opens the editor — once it is known whether the file exists, so
  // an existing script never opens as a new, empty one. The value at mount is an older request (the
  // section remounts per device, and the request outlives it), so only a later one counts.
  const seenRequest = useRef(editRequest);
  useEffect(() => {
    if (editRequest === undefined || editRequest === seenRequest.current || exists === null) return;
    seenRequest.current = editRequest;
    if (!editing) void startEditing();
  }, [editRequest, editing, exists, startEditing]);

  // The script can change on disk while it is open here — saved from Lab Configuration, or edited
  // outside the app, which also refreshes `preview`/`exists`. A clean editor follows the disk; one
  // with edits keeps them, and says that saving replaces the other version.
  useEffect(() => {
    if (!editing || !exists) return;
    let live = true;
    readFile()
      .then((content) => {
        if (!live || content === baseline) return;
        if (text === baseline) {
          setBaseline(content);
          setText(content);
        } else {
          setChangedOnDisk(true);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // Only a sign from outside that the file changed re-checks it, not every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, exists]);

  async function save() {
    await run(setBusy, `Save ${fileName}`, async () => {
      await api.fsWriteTextOffline(labId, path, text);
      setBaseline(text);
      setEditing(false);
      setChangedOnDisk(false);
      toast.show(`Saved ${fileName}.`, "success");
      onSaved();
    });
  }

  async function cancel() {
    if (dirty) {
      const ok = await confirm({
        title: "Discard unsaved changes?",
        message: `Your unsaved edits to ${fileName} will be lost.`,
        okLabel: "Discard",
      });
      if (!ok) return;
    }
    setEditing(false);
  }

  useSaveShortcut(rootRef, () => {
    if (editing && !busy && (dirty || exists === false)) void save();
  });

  const shown = preview ?? fileText ?? "";

  return (
    <div className="iface" ref={rootRef}>
      <div className="d-flex align-items-center justify-content-between gap-2">
        <span style={{ fontWeight: 600 }}>{title}</span>
        {!editing && exists !== null && (
          <Button size="sm" variant="outline-secondary" disabled={busy} onClick={() => void startEditing()}>
            {exists ? (
              <>
                <Pencil size={13} className="me-1" />
                Edit
              </>
            ) : (
              <>
                <FilePlus size={13} className="me-1" />
                Create {fileName}
              </>
            )}
          </Button>
        )}
      </div>
      {editing ? (
        <>
          {changedOnDisk && (
            <div className="hint text-warning mt-1">
              {fileName} changed on disk since you started editing. Saving replaces that version.
            </div>
          )}
          <div className="d-flex flex-column mt-1" style={{ height: EDITOR_HEIGHT }}>
            <EditorPane
              pathLabel={exists ? fileName : `${fileName} (new)`}
              language={languageForPath(path)}
              value={text}
              onChange={setText}
              disabled={busy}
              onSave={() => void save()}
              dirty={dirty}
              // A new script can be saved empty on purpose: saving is what creates it.
              saveDisabled={busy || (exists === true && !dirty)}
            />
          </div>
          <div className="d-flex justify-content-end mt-1">
            <Button size="sm" variant="link" disabled={busy} onClick={() => void cancel()}>
              Cancel
            </Button>
          </div>
        </>
      ) : shown ? (
        <pre className="startup">{shown}</pre>
      ) : (
        <div className="hint">
          {exists === false ? `No ${kind} file.` : exists === null ? "Loading…" : `${fileName} is empty.`}
        </div>
      )}
    </div>
  );
}
