import { FileCog, FileText, Map as MapIcon, Terminal } from "lucide-react";
import { describe, expect, it } from "vitest";
import { machine } from "../test/fixtures";
import { deviceFilesOnDisk, fileIcon, machineStartupText } from "./labfs";
import type { FsEntry } from "./types";

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
