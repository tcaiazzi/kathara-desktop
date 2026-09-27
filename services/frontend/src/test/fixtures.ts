// Shared builders for the unit tests' input data. Test-only: imported by `*.test.ts` files and
// excluded from coverage (vite.config.ts), never by application code.

import type { LabDetail, LabSummary, MachineDetail } from "../services/types";

/** A stopped, managed lab with no devices, not on disk (`path: null`); `overrides` sets the rest. */
export function labSummary(overrides: Partial<LabSummary> = {}): LabSummary {
  return {
    name: "lab",
    id: "lab",
    path: null,
    managed: true,
    n_machines: 0,
    n_links: 0,
    deployed: false,
    n_running: 0,
    ...overrides,
  };
}

/** labSummary() with empty metadata, counting the `machines` and `links` it is given. Nothing is
 *  reported running unless `overrides` says so, whatever the devices' own `running`. */
export function labDetail(overrides: Partial<LabDetail> = {}): LabDetail {
  const machines = overrides.machines ?? [];
  const links = overrides.links ?? [];
  return {
    ...labSummary({ n_machines: machines.length, n_links: links.length }),
    metadata: { description: null, version: null, author: null, email: null, web: null },
    machines,
    links,
    deploy_failed_machines: [],
    ...overrides,
  };
}

/** A stopped device named `pc1` with every option at its API default; `overrides` sets the rest. */
export function machine(overrides: Partial<MachineDetail> = {}): MachineDetail {
  return {
    name: "pc1",
    interfaces: [],
    running: false,
    status: null,
    image: null,
    mem: null,
    cpus: null,
    ports: [],
    envs: {},
    sysctls: {},
    exec_commands: [],
    volumes: [],
    ulimits: [],
    privileged: false,
    bridged: false,
    ipv6: null,
    shell: null,
    num_terms: null,
    entrypoint: null,
    args: null,
    metas: {},
    ...overrides,
  };
}
