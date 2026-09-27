import { describe, expect, it } from "vitest";
import { afterKatharaSave, afterLimitsSave, initialSettingsTab, toKatharaUpdate, toLimitsUpdate } from "./settings";
import type { SettingsView } from "./types";

const view: SettingsView = {
  manager_type: "docker",
  image: "kathara/base",
  debug_level: "DEBUG",
  terminal: "/usr/bin/xterm",
  max_files_per_lab: 10,
  max_bytes_per_file: 1024,
  last_checked: 1,
  remote_url: null,
  cert_path: null,
  settings_file: "/home/u/.config/kathara.conf",
  settings_file_error: null,
  settings_warnings: ["x"],
};

describe("toKatharaUpdate", () => {
  it("keeps every editable Kathara field, the CLI-only ones included, and nothing else", () => {
    expect(toKatharaUpdate(view)).toEqual({
      manager_type: "docker",
      image: "kathara/base",
      debug_level: "DEBUG",
      terminal: "/usr/bin/xterm",
    });
  });
});

describe("toLimitsUpdate", () => {
  it("sends only the limits, and only those with a value", () => {
    expect(toLimitsUpdate(view)).toEqual({ max_files_per_lab: 10, max_bytes_per_file: 1024 });
  });
});

describe("afterKatharaSave / afterLimitsSave", () => {
  const saved: SettingsView = { ...view, image: "kathara/frr", max_files_per_lab: 99, max_bytes_per_file: 2048 };

  it("takes the Kathara fields from the answer, but keeps the limits being edited", () => {
    const edited = { ...view, max_files_per_lab: 55 };

    expect(afterKatharaSave(edited, saved)).toMatchObject({ image: "kathara/frr", max_files_per_lab: 55, max_bytes_per_file: 1024 });
  });

  it("takes only the limits from the answer, and keeps a Kathara field being edited", () => {
    const edited = { ...view, image: "typed/but-unsaved" };

    expect(afterLimitsSave(edited, saved)).toMatchObject({ image: "typed/but-unsaved", max_files_per_lab: 99, max_bytes_per_file: 2048 });
  });
});

describe("initialSettingsTab", () => {
  it("opens the tab the URL names, over the one used last", () => {
    expect(initialSettingsTab("kathara", "app")).toBe("kathara");
  });

  it("falls back to the tab used last, then to this app's own", () => {
    expect(initialSettingsTab(null, "kathara")).toBe("kathara");
    expect(initialSettingsTab("bogus", null)).toBe("app");
    expect(initialSettingsTab(undefined, "bogus")).toBe("app");
  });
});
