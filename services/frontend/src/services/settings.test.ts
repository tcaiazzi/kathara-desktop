import { describe, expect, it } from "vitest";
import { toSettingsUpdate } from "./settings";

describe("toSettingsUpdate", () => {
  it("keeps every editable field and drops the read-only ones", () => {
    const update = toSettingsUpdate({
      manager_type: "docker",
      image: "kathara/base",
      debug_level: "DEBUG",
      max_files_per_lab: 10,
      last_checked: 1,
      remote_url: null,
      cert_path: null,
      settings_file: "/home/u/.config/kathara.conf",
      settings_file_error: null,
      settings_warnings: ["x"],
    });

    expect(update).toEqual({
      manager_type: "docker",
      image: "kathara/base",
      debug_level: "DEBUG",
      max_files_per_lab: 10,
    });
  });
});
