import { describe, expect, it } from "vitest";
import { changedStartupPaths, labEventNotice, parseLabEvent } from "./labEvents";

const startup = { lab_id: "L", kind: "startup", files: ["pc1.startup"], detail: null };

describe("parseLabEvent", () => {
  it("accepts an event as the backend sends it, as text or already parsed", () => {
    expect(parseLabEvent(JSON.stringify(startup))).toEqual(startup);
    expect(parseLabEvent({ ...startup, detail: undefined })).toEqual(startup);
  });

  it.each([
    ["not json", "{"],
    ["not an object", "3"],
    ["an unknown kind", JSON.stringify({ ...startup, kind: "deleted" })],
    ["a missing lab id", JSON.stringify({ ...startup, lab_id: 1 })],
    ["files that aren't strings", JSON.stringify({ ...startup, files: [1] })],
    ["a detail that isn't text", JSON.stringify({ ...startup, detail: {} })],
  ])("rejects %s", (_label, data) => {
    expect(parseLabEvent(data)).toBeNull();
  });
});

describe("labEventNotice", () => {
  it("says every lab.conf outcome out loud, only an unloadable one as an error, and nothing for a startup script", () => {
    const conf = { lab_id: "L", files: ["lab.conf"], detail: null };
    expect(labEventNotice({ ...conf, kind: "conf-reloaded" })?.variant).toBe("info");
    expect(labEventNotice({ ...conf, kind: "conf-pending" })).toMatchObject({ variant: "info", message: expect.stringMatching(/Undeploy/) });
    expect(labEventNotice({ ...conf, kind: "conf-invalid" })?.variant).toBe("danger");
    expect(labEventNotice({ ...conf, kind: "conf-invalid", detail: "line 2: bad" })?.message).toMatch(/line 2: bad$/);
    expect(labEventNotice({ ...conf, kind: "conf-invalid" })?.message).toMatch(/loaded\.$/);
    expect(labEventNotice({ ...startup, kind: "startup" })).toBeNull();
  });
});

describe("changedStartupPaths", () => {
  it("maps a startup event's files to lab-relative paths", () => {
    expect(changedStartupPaths({ ...startup, kind: "startup", files: ["pc1.startup", "shared.startup"] })).toEqual([
      "/pc1.startup",
      "/shared.startup",
    ]);
    expect(changedStartupPaths({ ...startup, kind: "conf-reloaded", files: ["lab.conf"] })).toEqual([]);
  });
});
