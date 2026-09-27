import { FileCog, FileText, Map as MapIcon, Terminal } from "lucide-react";
import { describe, expect, it } from "vitest";
import { machine } from "../test/fixtures";
import { deviceFilesOnDisk, fileIcon, labTreeKey, machineStartupText } from "./labfs";
import type { FsEntry, LabDetail, MachineDetail } from "./types";

describe("machineStartupText", () => {
  const withExec = machine({ exec_commands: ["ip a", "echo ready"] });

  it("prefers the device's real startup script", () => {
    expect(machineStartupText(withExec, "ip addr add 10.0.0.1/24 dev eth0\n")).toBe(
      "ip addr add 10.0.0.1/24 dev eth0\n",
    );
  });

  it("falls back to the exec commands, one per line, when the script is missing or blank", () => {
    expect(machineStartupText(withExec)).toBe("ip a\necho ready\n");
    expect(machineStartupText(withExec, "  \n\t")).toBe("ip a\necho ready\n");
  });

  it("is empty for a device with neither", () => {
    expect(machineStartupText(machine(), "")).toBe("");
  });
});

describe("fileIcon", () => {
  it.each([
    ["lab.conf", FileCog],
    ["lab.ext", FileCog],
    ["lab.dep", FileCog],
    ["lab.layout", MapIcon],
    ["pc1.startup", Terminal],
    ["pc1.shutdown", Terminal],
    ["install.sh", Terminal],
    ["frr.conf", FileText],
    ["lab.conf.bak", FileText],
  ])("gives %s its own icon", (name, icon) => {
    expect(fileIcon(name)).toBe(icon);
  });
});

describe("deviceFilesOnDisk", () => {
  function entry(name: string, is_dir = false): FsEntry {
    return { name, path: `/${name}`, is_dir, size: null, mode: null, mtime: null };
  }

  it("lists the scripts, then the folder with a trailing slash", () => {
    const root = [entry("pc1", true), entry("lab.conf"), entry("pc1.shutdown"), entry("pc1.startup")];
    expect(deviceFilesOnDisk("pc1", root)).toEqual(["pc1.startup", "pc1.shutdown", "pc1/"]);
  });

  it("lists only what is there", () => {
    expect(deviceFilesOnDisk("pc1", [entry("pc1", true)])).toEqual(["pc1/"]);
    expect(deviceFilesOnDisk("pc1", [entry("lab.conf")])).toEqual([]);
  });

  it("leaves out a plain file named after the device, which removing it keeps", () => {
    expect(deviceFilesOnDisk("pc1", [entry("pc1"), entry("pc1.startup")])).toEqual(["pc1.startup"]);
  });

  it("leaves out another device's files that share the prefix", () => {
    const root = [entry("pc10", true), entry("pc10.startup"), entry("pc1.startup")];
    expect(deviceFilesOnDisk("pc1", root)).toEqual(["pc1.startup"]);
  });
});

describe("labTreeKey", () => {
  const lab = (machines: MachineDetail[], overrides: Partial<LabDetail> = {}): LabDetail => ({
    name: "net",
    id: "id",
    path: "/labs/net",
    managed: true,
    n_machines: machines.length,
    n_links: 0,
    deployed: machines.some((m) => m.running),
    n_running: machines.filter((m) => m.running).length,
    metadata: { description: null, version: null, author: null, email: null, web: null },
    machines,
    links: [],
    deploy_failed_machines: [],
    ...overrides,
  });
  const pc1 = machine({ name: "pc1" });
  const pc2 = machine({ name: "pc2" });

  it("stays the same for a refresh that leaves the folder as it was", () => {
    const before = lab([pc1, pc2]);
    const after = lab([machine({ name: "pc2", image: "kathara/frr" }), machine({ name: "pc1" })], {
      deploy_error: "boom",
    });
    expect(labTreeKey(after)).toBe(labTreeKey(before));
  });

  it("changes when a device is added or removed", () => {
    expect(labTreeKey(lab([pc1, pc2]))).not.toBe(labTreeKey(lab([pc1])));
  });

  it("changes when a device starts or stops", () => {
    expect(labTreeKey(lab([pc1, machine({ name: "pc2", running: true })]))).not.toBe(labTreeKey(lab([pc1, pc2])));
  });

  it("changes when the folder goes missing or moves", () => {
    expect(labTreeKey(lab([pc1], { problem: "missing" }))).not.toBe(labTreeKey(lab([pc1])));
    expect(labTreeKey(lab([pc1], { path: "/elsewhere/net" }))).not.toBe(labTreeKey(lab([pc1])));
  });
});
