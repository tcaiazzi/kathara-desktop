// The device-options form's state and its conversions to and from the API. The single source of
// truth for how a device's options become form fields and back: MachineOptionsFields renders this
// state, and AddDeviceModal / MachineOptionsEditor send `optionsFormStateToPayload` of it. A caller
// must not build a MachineOptionsPayload from the form by hand.

import type { MachineDetail, MachineOptionsPayload, PortMapping, Ulimit, VolumeMount } from "./types";

export interface KeyValueRow {
  key: string;
  value: string;
}

export interface ExecRow {
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
  /** Three-state, like the model: on, off, or absent (inherit the global setting). */
  ipv6: boolean | null;
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

// Blank slate for a device that doesn't exist yet — `image` defaults to Kathara's own base image.
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
    ipv6: null,
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
    ipv6: machine.ipv6,
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
    ipv6: form.ipv6,
    envs: rowsToRecord(form.envs),
    sysctls: rowsToRecord(form.sysctls),
    ulimits: form.ulimits.filter((u) => u.name.trim()),
    exec_commands: form.execCommands.map((r) => r.value).filter((v) => v.trim()),
    ports: form.ports,
    volumes: form.volumes.filter((v) => v.host_path.trim() && v.guest_path.trim()),
    metas: rowsToRecord(form.metas),
  };
}
