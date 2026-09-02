import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button, Form } from "react-bootstrap";
import { useToast } from "../context/ToastContext";
import { useAvailableImages } from "../hooks/useAvailableImages";
import { api } from "../services/api";
import type { MachineDetail, MachineOptionsPayload, PortMapping, Ulimit, VolumeMount } from "../services/types";
import { AutocompleteInput } from "./AutocompleteInput";
import { HostPathPicker } from "./HostPathPicker";
import { RowListEditor } from "./RowListEditor";

interface KeyValueRow {
  key: string;
  value: string;
}

interface ExecRow {
  value: string;
}

// UI-shaped mirror of MachineOptionsPayload — dict-shaped options become row arrays for
// RowListEditor, numeric fields become strings so an empty input can mean "unset" rather than 0.
export interface OptionsFormState {
  image: string;
  mem: string;
  cpus: string;
  shell: string;
  numTerms: string;
  entrypoint: string;
  args: string;
  privileged: boolean;
  bridged: boolean;
  ipv6: boolean;
  envs: KeyValueRow[];
  sysctls: KeyValueRow[];
  ulimits: Ulimit[];
  execCommands: ExecRow[];
  ports: PortMapping[];
  volumes: VolumeMount[];
  metas: KeyValueRow[];
}

function recordToRows(record: Record<string, unknown>): KeyValueRow[] {
  return Object.entries(record).map(([key, value]) => ({ key, value: String(value) }));
}

function rowsToRecord(rows: KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.trim()) out[row.key.trim()] = row.value;
  }
  return out;
}

// Blank slate for a device that doesn't exist yet — `image` defaults to Kathara's own base image,
// matching the previous add-device form's default.
export function defaultOptionsFormState(): OptionsFormState {
  return {
    image: "kathara/base",
    mem: "",
    cpus: "",
    shell: "",
    numTerms: "",
    entrypoint: "",
    args: "",
    privileged: false,
    bridged: false,
    ipv6: false,
    envs: [],
    sysctls: [],
    ulimits: [],
    execCommands: [],
    ports: [],
    volumes: [],
    metas: [],
  };
}

export function optionsFormStateFromMachine(machine: MachineDetail): OptionsFormState {
  return {
    image: machine.image ?? "",
    mem: machine.mem ?? "",
    cpus: machine.cpus != null ? String(machine.cpus) : "",
    shell: machine.shell ?? "",
    numTerms: machine.num_terms != null ? String(machine.num_terms) : "",
    entrypoint: machine.entrypoint ?? "",
    args: machine.args ?? "",
    privileged: machine.privileged,
    bridged: machine.bridged,
    ipv6: !!machine.ipv6,
    envs: recordToRows(machine.envs),
    sysctls: recordToRows(machine.sysctls),
    ulimits: machine.ulimits.map((u) => ({ ...u })),
    execCommands: machine.exec_commands.map((value) => ({ value })),
    ports: machine.ports.map((p) => ({ ...p })),
    volumes: machine.volumes.map((v) => ({ ...v })),
    metas: recordToRows(machine.metas),
  };
}

export function optionsFormStateToPayload(form: OptionsFormState): MachineOptionsPayload {
  return {
    image: form.image.trim() || null,
    mem: form.mem.trim() || null,
    cpus: form.cpus.trim() === "" ? null : Number(form.cpus),
    shell: form.shell.trim() || null,
    num_terms: form.numTerms.trim() === "" ? null : Number(form.numTerms),
    entrypoint: form.entrypoint.trim() || null,
    args: form.args.trim() || null,
    privileged: form.privileged,
    bridged: form.bridged,
    ipv6: form.ipv6 ? true : null,
    envs: rowsToRecord(form.envs),
    sysctls: rowsToRecord(form.sysctls),
    ulimits: form.ulimits.filter((u) => u.name.trim()),
    exec_commands: form.execCommands.map((r) => r.value).filter((v) => v.trim()),
    ports: form.ports,
    volumes: form.volumes.filter((v) => v.host_path.trim() && v.guest_path.trim()),
    metas: rowsToRecord(form.metas),
  };
}

const KV_COLUMNS: import("./RowListEditor").RowColumn<KeyValueRow>[] = [
  { key: "key", label: "Name" },
  { key: "value", label: "Value" },
];

interface MachineOptionsFieldsProps {
  form: OptionsFormState;
  disabled: boolean;
  onChange: <K extends keyof OptionsFormState>(key: K, value: OptionsFormState[K]) => void;
}

// The full set of Kathara device "option" controls (image, mem, bridged, envs, sysctls, ulimits,
// exec commands, ports, volumes, and any other pass-through option) — shared by the post-creation
// MachineOptionsEditor and the add-device modal's "Advanced options" section so the two forms
// can't drift apart.
export function MachineOptionsFields({ form, disabled, onChange }: MachineOptionsFieldsProps) {
  const [netSysctls, setNetSysctls] = useState<string[]>([]);
  // The volume host_path column opens a shared picker; this holds "where to write the chosen
  // path back to" for whichever row's Browse button was last clicked.
  const [hostPathTarget, setHostPathTarget] = useState<{ path: string; setValue: (v: string) => void } | null>(null);
  const toast = useToast();
  const availableImages = useAvailableImages();

  useEffect(() => {
    api.listNetSysctls().then(setNetSysctls).catch((e) => toast.reportError("List sysctls", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function set<K extends keyof OptionsFormState>(key: K, value: OptionsFormState[K]) {
    onChange(key, value);
  }

  return (
    <>
      <div className="d-flex gap-4 flex-wrap mb-3">
        <Form.Check
          type="checkbox"
          label="bridged"
          checked={form.bridged}
          disabled={disabled}
          onChange={(e) => set("bridged", e.target.checked)}
        />
        <Form.Check
          type="checkbox"
          label="privileged"
          checked={form.privileged}
          disabled={disabled}
          onChange={(e) => set("privileged", e.target.checked)}
        />
        <Form.Check
          type="checkbox"
          label="ipv6"
          checked={form.ipv6}
          disabled={disabled}
          onChange={(e) => set("ipv6", e.target.checked)}
        />
      </div>

      <div className="row g-2 mb-3">
        <div className="col-6">
          <Form.Label className="small mb-1">image</Form.Label>
          <AutocompleteInput
            size="sm"
            value={form.image}
            disabled={disabled}
            placeholder="kathara/base"
            onChange={(v) => set("image", v)}
            options={availableImages}
          />
        </div>
        <div className="col-3">
          <Form.Label className="small mb-1">mem</Form.Label>
          <Form.Control
            size="sm"
            value={form.mem}
            disabled={disabled}
            placeholder="256m"
            onChange={(e) => set("mem", e.target.value)}
          />
        </div>
        <div className="col-3">
          <Form.Label className="small mb-1">cpus</Form.Label>
          <Form.Control
            size="sm"
            type="number"
            min={0}
            step="0.1"
            value={form.cpus}
            disabled={disabled}
            onChange={(e) => set("cpus", e.target.value)}
          />
        </div>
        <div className="col-4">
          <Form.Label className="small mb-1">shell</Form.Label>
          <Form.Control
            size="sm"
            value={form.shell}
            disabled={disabled}
            placeholder="/bin/bash"
            onChange={(e) => set("shell", e.target.value)}
          />
        </div>
        <div className="col-2">
          <Form.Label className="small mb-1">num_terms</Form.Label>
          <Form.Control
            size="sm"
            type="number"
            min={0}
            value={form.numTerms}
            disabled={disabled}
            onChange={(e) => set("numTerms", e.target.value)}
          />
        </div>
        <div className="col-3">
          <Form.Label className="small mb-1">entrypoint</Form.Label>
          <Form.Control
            size="sm"
            value={form.entrypoint}
            disabled={disabled}
            onChange={(e) => set("entrypoint", e.target.value)}
          />
        </div>
        <div className="col-3">
          <Form.Label className="small mb-1">args</Form.Label>
          <Form.Control
            size="sm"
            value={form.args}
            disabled={disabled}
            onChange={(e) => set("args", e.target.value)}
          />
        </div>
      </div>

      <h6>Environment variables</h6>
      <RowListEditor
        columns={KV_COLUMNS}
        rows={form.envs}
        disabled={disabled}
        onChange={(rows) => set("envs", rows)}
        emptyRow={() => ({ key: "", value: "" })}
      />

      <h6>Sysctls</h6>
      <RowListEditor<KeyValueRow>
        columns={[
          { key: "key", label: "Name", placeholder: "net.ipv4.ip_forward", options: netSysctls },
          { key: "value", label: "Value" },
        ]}
        rows={form.sysctls}
        disabled={disabled}
        hint="Only the net.* namespace is accepted — start typing to search the host's available sysctls."
        onChange={(rows) => set("sysctls", rows)}
        emptyRow={() => ({ key: "", value: "" })}
      />

      <h6>Ulimits</h6>
      <RowListEditor<Ulimit>
        columns={[
          { key: "name", label: "Name", placeholder: "nofile" },
          { key: "soft", label: "Soft", type: "number", min: -1 },
          { key: "hard", label: "Hard", type: "number", min: -1, placeholder: "same as soft" },
        ]}
        rows={form.ulimits}
        disabled={disabled}
        onChange={(rows) => set("ulimits", rows)}
        emptyRow={() => ({ name: "", soft: -1, hard: null })}
      />

      <h6>Exec commands</h6>
      <RowListEditor<ExecRow>
        columns={[{ key: "value", label: "Command", placeholder: "e.g. ip route add ..." }]}
        rows={form.execCommands}
        disabled={disabled}
        hint="Commands run in order at container startup."
        onChange={(rows) => set("execCommands", rows)}
        emptyRow={() => ({ value: "" })}
      />

      <h6>Ports</h6>
      <RowListEditor<PortMapping>
        columns={[
          { key: "host_port", label: "Host port", type: "number", min: 1, max: 65535 },
          { key: "guest_port", label: "Guest port", type: "number", min: 1, max: 65535 },
          { key: "protocol", label: "Protocol", type: "select", options: ["tcp", "udp", "sctp"] },
        ]}
        rows={form.ports}
        disabled={disabled}
        onChange={(rows) => set("ports", rows)}
        emptyRow={() => ({ host_port: 3000, guest_port: 80, protocol: "tcp" })}
      />

      <h6>Volumes</h6>
      <RowListEditor<VolumeMount>
        columns={[
          {
            key: "host_path",
            label: "Host path",
            render: (value, setValue, rowDisabled) => (
              <div className="d-flex gap-1">
                <Form.Control
                  size="sm"
                  placeholder="Host path"
                  disabled={rowDisabled}
                  value={value == null ? "" : String(value)}
                  onChange={(e) => setValue(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline-secondary"
                  className="kt-icon-btn"
                  disabled={rowDisabled}
                  title="Browse the host filesystem"
                  aria-label="Browse the host filesystem"
                  onClick={() =>
                    setHostPathTarget({
                      path: value == null || value === "" ? "/" : String(value),
                      setValue: (v) => setValue(v),
                    })
                  }
                >
                  <FolderOpen size={14} />
                </Button>
              </div>
            ),
          },
          { key: "guest_path", label: "Guest path" },
          { key: "mode", label: "Mode", type: "select", options: ["ro", "rw", "rx"] },
        ]}
        rows={form.volumes}
        disabled={disabled}
        onChange={(rows) => set("volumes", rows)}
        emptyRow={() => ({ host_path: "", guest_path: "", mode: "rw" })}
      />

      <h6>Advanced (other options)</h6>
      <RowListEditor
        columns={KV_COLUMNS}
        rows={form.metas}
        disabled={disabled}
        hint="Any other lab.conf option this editor doesn't have a dedicated field for."
        onChange={(rows) => set("metas", rows)}
        emptyRow={() => ({ key: "", value: "" })}
      />

      <HostPathPicker
        show={!!hostPathTarget}
        initialPath={hostPathTarget?.path}
        onClose={() => setHostPathTarget(null)}
        onSelect={(path) => {
          hostPathTarget?.setValue(path);
          setHostPathTarget(null);
        }}
      />
    </>
  );
}
