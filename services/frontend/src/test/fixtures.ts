// Shared builders for the unit tests' input data. Test-only: imported by `*.test.ts` files and
// excluded from coverage (vite.config.ts), never by application code.

import type { MachineDetail } from "../services/types";

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
