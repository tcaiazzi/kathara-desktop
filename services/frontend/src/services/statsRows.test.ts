import { describe, expect, it } from "vitest";
import { statsRows } from "./statsRows";
import type { MachineStats } from "./types";

function sample(name: string, cpu: string): MachineStats {
  return {
    name,
    container_name: `kathara_${name}`,
    status: "running",
    image: "kathara/base",
    pids: 3,
    cpu_usage: cpu,
    mem_usage: "10 MB",
    mem_percent: "1%",
    net_usage: "1 kB / 1 kB",
    interfaces: "eth0",
  };
}

describe("statsRows", () => {
  it("lists every device by name, the stopped ones as stopped with no numbers", () => {
    const rows = statsRows(
      [
        { name: "pc2", running: true, status: "running" },
        { name: "pc1", running: false, status: null },
      ],
      { pc2: sample("pc2", "5%") },
    );

    expect(rows.map((r) => [r.name, r.status, r.cpu_usage])).toEqual([
      ["pc1", "stopped", null],
      ["pc2", "running", "5%"],
    ]);
  });

  it("drops the last sample of a device that has stopped since", () => {
    const [row] = statsRows([{ name: "pc1", running: false, status: null }], { pc1: sample("pc1", "5%") });

    expect(row).toMatchObject({ status: "stopped", cpu_usage: null, pids: null });
  });

  it("shows a running device before its first sample with its state and no numbers yet", () => {
    const [row] = statsRows([{ name: "pc1", running: true, status: "restarting" }], {});

    expect(row).toMatchObject({ name: "pc1", status: "restarting", cpu_usage: null });
  });
});
