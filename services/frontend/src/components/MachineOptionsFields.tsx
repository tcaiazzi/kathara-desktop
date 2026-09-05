import { useEffect, useId, useState } from "react";
import { FolderOpen, Info } from "lucide-react";
import { Button, Form, OverlayTrigger, Tooltip } from "react-bootstrap";
import { useToast } from "../context/ToastContext";
import { desktop } from "../desktop/bridge";
import { useAvailableImages } from "../hooks/useAvailableImages";
import { api } from "../services/api";
import type { MachineDetail, MachineOptionsPayload, PortMapping, Ulimit, VolumeMount } from "../services/types";
import { AutocompleteInput } from "./AutocompleteInput";
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

function InfoTip({ text }: { text: string }) {
  const id = useId();
  return (
    <OverlayTrigger placement="top" overlay={<Tooltip id={`option-tip-${id}`}>{text}</Tooltip>}>
      <Info size={12} className="text-muted ms-1" tabIndex={0} aria-label={text} />
    </OverlayTrigger>
  );
}

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
          label={
            <>
              Bridged
              <InfoTip text="Connect the device to the host network by adding an additional network interface. This interface will be connected to the host network through a NAT connection." />
            </>
          }
          checked={form.bridged}
          disabled={disabled}
          onChange={(e) => set("bridged", e.target.checked)}
        />
        <Form.Check
          type="checkbox"
          label={
            <>
              Privileged
              <InfoTip text="Start the device in privileged mode." />
            </>
          }
          checked={form.privileged}
          disabled={disabled}
          onChange={(e) => set("privileged", e.target.checked)}
        />
        <Form.Check
          type="checkbox"
          label={
            <>
              IPv6
              <InfoTip text="Enable or disable IPv6 on this device." />
            </>
          }
          checked={form.ipv6}
          disabled={disabled}
          onChange={(e) => set("ipv6", e.target.checked)}
        />
      </div>

      <div className="row g-2 mb-3">
        <div className="col-6">
          <Form.Label className="small mb-1">
            Image
            <InfoTip text="Docker image used for this device." />
          </Form.Label>
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
          <Form.Label className="small mb-1">
            Mem
            <InfoTip text="Amount of RAM available to the device (minimum 4m). Positive integer with a b/k/m/g suffix for bytes/kilobytes/megabytes/gigabytes." />
          </Form.Label>
          <Form.Control
            size="sm"
            value={form.mem}
            disabled={disabled}
            placeholder="256m"
            onChange={(e) => set("mem", e.target.value)}
          />
        </div>
        <div className="col-3">
          <Form.Label className="small mb-1">
            CPUs
            <InfoTip text="Limit the amount of CPU available for this device. This option takes a positive float, ranging from 0 to max number of host logical CPUs." />
          </Form.Label>
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
          <Form.Label className="small mb-1">
            Shell
            <InfoTip text="Use the specified shell to connect to the device, e.g., when kathara connect is called." />
          </Form.Label>
          <Form.Control
            size="sm"
            value={form.shell}
            disabled={disabled}
            placeholder="/bin/bash"
            onChange={(e) => set("shell", e.target.value)}
          />
        </div>
        <div className="col-2">
          <Form.Label className="small mb-1">
            Num Terms
            <InfoTip text="Choose the number of terminals to open for this device." />
          </Form.Label>
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
          <Form.Label className="small mb-1">
            Entrypoint
            <InfoTip text="Allows to specify the entrypoint command of the device." />
          </Form.Label>
          <Form.Control
            size="sm"
            value={form.entrypoint}
            disabled={disabled}
            onChange={(e) => set("entrypoint", e.target.value)}
          />
        </div>
        <div className="col-3">
          <Form.Label className="small mb-1">
            Args
            <InfoTip text="Allows to specify extra arguments for the entrypoint command." />
          </Form.Label>
          <Form.Control
            size="sm"
            value={form.args}
            disabled={disabled}
            onChange={(e) => set("args", e.target.value)}
          />
        </div>
      </div>

      <h6>
        Environment variables
        <InfoTip text="Set an environment variable for the device. Can be set multiple times per device, each will add a new entry (unless the same variable is used again). The format is: ENV_NAME=ENV_VALUE." />
      </h6>
      <RowListEditor
        columns={KV_COLUMNS}
        rows={form.envs}
        disabled={disabled}
        onChange={(rows) => set("envs", rows)}
        emptyRow={() => ({ key: "", value: "" })}
      />

      <h6>
        Sysctls
        <InfoTip text="Set a sysctl option for this device. Only the net. namespace is allowed to be set. Can be set multiple times per device, each will add a new entry (unless the same config item is used again)." />
      </h6>
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

      <h6>
        Ulimits
        <InfoTip text="Allows change of both soft and hard limits. The syntax is ULIMIT=SOFT:HARD. Use -1 for unlimited. If only a parameter is given e.g. ULIMIT=VALUE both soft and hard limit will have same value." />
      </h6>
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

      <h6>
        Exec commands
        <InfoTip text="Run a specific shell command inside the device during the startup phase." />
      </h6>
      <RowListEditor<ExecRow>
        columns={[{ key: "value", label: "Command", placeholder: "e.g. ip route add ..." }]}
        rows={form.execCommands}
        disabled={disabled}
        hint="Commands run in order at container startup."
        onChange={(rows) => set("execCommands", rows)}
        emptyRow={() => ({ value: "" })}
      />

      <h6>
        Ports
        <InfoTip text="Map localhost port HOST to the internal port GUEST of the device for the specified PROTOCOL. The syntax is [HOST:]GUEST[/PROTOCOL]. If HOST port is not specified, default is 3000. If PROTOCOL is not specified, default is tcp. Supported PROTOCOL values are: tcp, udp, or sctp." />
      </h6>
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

      <h6>
        Volumes
        <InfoTip text="Specifies an additional volume to mount on the device. The syntax is HOST|GUEST|[MODE]. Mode can be: ro (read-only), rw (read-write), or rx. The user must have appropriate permissions on the HOST directory; otherwise, an exception will be raised. NOTE: On Megalos, the volume is mounted on the worker node where the device is running, not on the user's local machine." />
      </h6>
      <RowListEditor<VolumeMount>
        columns={[
          {
            key: "host_path",
            label: "Host path",
            render: (value, setValue, rowDisabled) => {
              const current = value == null ? "" : String(value);
              // The picker is the OS's own folder dialog (integrations.ts's pickHostDirectory):
              // this is a path on the machine the backend runs on, and only the desktop shell —
              // which spawns that backend itself — can be sure the two are the same machine. So
              // the button exists only there; the browser build keeps the plain text input, the
              // same way every other desktop-only affordance is simply not rendered (see
              // desktop/bridge.ts). Either way the value goes through VolumeMount, which requires
              // an absolute host path.
              const shell = desktop();
              return (
                <div className="d-flex gap-1">
                  <Form.Control
                    size="sm"
                    placeholder="Host path"
                    disabled={rowDisabled}
                    value={current}
                    onChange={(e) => setValue(e.target.value)}
                  />
                  {shell && (
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      className="kt-icon-btn"
                      disabled={rowDisabled}
                      title="Browse the host filesystem"
                      aria-label="Browse the host filesystem"
                      onClick={() =>
                        void (async () => {
                          try {
                            // undefined, not "": let the dialog reopen wherever the user last was
                            // rather than at a directory nobody chose.
                            const picked = await shell.pickHostDirectory(current || undefined);
                            if (picked) setValue(picked);
                          } catch (e) {
                            toast.reportError("Choose a host directory", e);
                          }
                        })()
                      }
                    >
                      <FolderOpen size={14} />
                    </Button>
                  )}
                </div>
              );
            },
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
    </>
  );
}
