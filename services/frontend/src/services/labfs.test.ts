import { FileCog, FileText, Map as MapIcon, Terminal } from "lucide-react";
import { describe, expect, it } from "vitest";
import { machine } from "../test/fixtures";
import { fileIcon, machineStartupText } from "./labfs";

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
