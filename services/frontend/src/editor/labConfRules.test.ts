// First tests for the lab.conf linter (audit_3 Q4). The rules are pure, so no jsdom and no
// CodeMirror are involved — that is exactly why they were split out of labConfLint.ts.
//
// The invariant every case below serves: severity here must match the backend's own verdict in
// lab_import.py. An error the backend would accept blocks a legitimate save; a warning where the
// backend errors waves through a save that is about to be rejected.

import { describe, expect, it } from "vitest";
import { lintLabConfLines, type LabConfDiagnostic } from "./labConfRules";

const lint = (text: string): LabConfDiagnostic[] => lintLabConfLines(text.split("\n"));
const errors = (text: string) => lint(text).filter((d) => d.severity === "error");
const warnings = (text: string) => lint(text).filter((d) => d.severity === "warning");

describe("volume", () => {
  // lab_import._parse_volume: `[p for p in value.split("|") if p]`, valid at 2 or 3 fields. Empty
  // segments are dropped *before* counting, which is why a naive split("|").length check would
  // disagree with the backend on the third case below.
  it.each([
    ["/host|/guest", "two fields"],
    ["/host|/guest|rw", "three fields"],
    ["/host||/guest", "empty segment dropped, still two fields"],
  ])("accepts %s (%s)", (value) => {
    expect(errors(`pc1[volume]=${value}`)).toEqual([]);
  });

  it.each([["onlyone"], ["/a|/b|/c|/d"], ["|"]])("rejects a malformed volume %j", (value) => {
    const found = errors(`pc1[volume]=${value}`);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("invalid volume");
  });

  it("leaves an empty value to the generic line check, as the backend does", () => {
    // `pc1[volume]=` does not match CONF_LINE_RE at all (`[^"']+` needs a character), so neither
    // side ever reaches the volume rule — both report the line as unparseable. Pinned so a future
    // loosening of CONF_LINE_RE has to decide what this means on both sides at once.
    const found = errors("pc1[volume]=");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("cannot parse");
  });

  it("still warns about the host mount even when the value is well formed", () => {
    const found = warnings("pc1[volume]=/host|/guest|rw");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("host filesystem");
  });

  it("reports both the format error and the security warning on one bad line", () => {
    // A line can be malformed *and* worth flagging; neither suppresses the other.
    const found = lint("pc1[volume]=onlyone");
    expect(found.map((d) => d.severity).sort()).toEqual(["error", "warning"]);
    expect(found.every((d) => d.line === 0)).toBe(true);
  });
});

describe("option values", () => {
  it.each([
    ["pc1[cpus]=notanumber", "invalid cpus"],
    ["pc1[port]=80:notaport", "invalid port"],
    ["pc1[sysctl]=kernel.shmmax=1", "invalid sysctl"],
    ["pc1[env]=NOEQUALS", "invalid env"],
    ["pc1[ulimit]=nofile", "invalid ulimit"],
  ])("%s is an error", (line, expected) => {
    expect(errors(line)[0]?.message).toContain(expected);
  });

  it.each(["pc1[cpus]=1.5", "pc1[port]=8080:80/udp", "pc1[sysctl]=net.ipv4.ip_forward=1", "pc1[env]=A=1"])(
    "%s is accepted",
    (line) => {
      expect(errors(line)).toEqual([]);
    },
  );

  it("treats a non-integer num_terms as a warning, not an error", () => {
    // The backend keeps the line and does not apply it, so an error here would block a save the
    // backend accepts.
    expect(errors("pc1[num_terms]=many")).toEqual([]);
    expect(warnings("pc1[num_terms]=many")[0].message).toContain("invalid num_terms");
  });

  it("never errors on an unparseable boolean", () => {
    expect(errors("pc1[privileged]=perhaps")).toEqual([]);
  });
});

describe("structure", () => {
  it("flags non-sequential interface numbers on the offending line", () => {
    const found = errors("pc1[0]=A\npc1[2]=B");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("expected eth1, got eth2");
    expect(found[0].line).toBe(1);
  });

  it("accepts sequential interfaces declared out of order", () => {
    expect(errors("pc1[1]=B\npc1[0]=A")).toEqual([]);
  });

  it("rejects a reserved device name", () => {
    expect(errors("shared[0]=A")[0].message).toContain("reserved name");
  });

  it("ignores blank lines and comments", () => {
    expect(lint("\n# just a comment\n   \n")).toEqual([]);
  });

  it("is silent on recognized LAB_* metadata but warns on an unknown top-level key", () => {
    expect(lint('LAB_NAME="demo"')).toEqual([]);
    expect(warnings("SOMETHING=1")[0].message).toContain("kept as-is");
  });

  it("errors on a line that is neither a directive nor a key=value", () => {
    expect(errors("!!! nonsense")[0].message).toContain("cannot parse");
  });

  it("reports diagnostics against the right line index", () => {
    const found = errors('pc1[image]="kathara/base"\n!!! nonsense\npc1[0]=A');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(1);
  });
});
