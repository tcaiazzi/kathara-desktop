// The rows of the Statistics table: every device of the lab, not only the ones the stream has
// reported. The list and each device's state come from the lab's detail; only the numbers come
// from the stream, which never says when a device goes away, so a device that stops must not keep
// its last sample.

import type { MachineDetail, MachineStats } from "./types";

function emptyRow(name: string, status: string): MachineStats {
  return {
    name,
    container_name: null,
    status,
    image: null,
    pids: null,
    cpu_usage: null,
    mem_usage: null,
    mem_percent: null,
    net_usage: null,
    interfaces: null,
  };
}

/** One row per device, by name: a running device's latest sample (or its state alone, until the
 *  first sample arrives), and a stopped device as `stopped` with no numbers. */
export function statsRows(
  machines: readonly Pick<MachineDetail, "name" | "running" | "status">[],
  samples: Record<string, MachineStats>,
): MachineStats[] {
  return [...machines]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => {
      if (!m.running) return emptyRow(m.name, "stopped");
      return samples[m.name] ?? emptyRow(m.name, m.status || "running");
    });
}
