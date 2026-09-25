// Tests for the lab.conf linter. The rules are pure, so no jsdom and no CodeMirror are involved
// — that is exactly why they are split out of labConfLint.ts.
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

// Every case below is one the backend (lab_import.py) decides the same way; the exact message is
// asserted too, since it is what the editor shows.
const diagnostics = (text: string) => lint(text).map((d) => [d.severity, d.message]);

describe("port values", () => {
  it.each([
    ["80", "guest only, host defaults to 3000"],
    ["8", "a single-digit guest port"],
    ["8080:80", "host:guest, protocol defaults to tcp"],
    ["8080:80/tcp", "explicit tcp"],
    ["8080:80/udp", "udp"],
    ["8080:80/sctp", "sctp"],
    ["8080:80/UDP", "the protocol is case-insensitive"],
    ["8080:80/", "an empty protocol falls back to tcp"],
    ["8080: 80", "whitespace around a port number"],
    [" 8080:80", "whitespace before the host port"],
  ])("accepts %s (%s)", (value) => {
    expect(errors(`pc1[port]=${value}`)).toEqual([]);
  });

  it.each([
    ["8080:80/icmp", "an unknown protocol"],
    ["80a:80", "a host port with trailing junk"],
    ["a80:80", "a host port with leading junk"],
    ["8080:80a", "a guest port with trailing junk"],
    ["8080:a80", "a guest port with leading junk"],
    [":80", "an empty host port"],
    ["8080:", "an empty guest port"],
    ["http", "no number at all"],
  ])("rejects %s (%s)", (value) => {
    expect(diagnostics(`pc1[port]=${value}`)).toEqual([["error", `invalid port "${value}"`]]);
  });
});

describe("cpus values", () => {
  it.each(["pc1[cpus]=2", "pc1[cpus]=0.5", "pc1[cpus]=1e1", "pc1[cpu]=2"])("accepts %s", (line) => {
    expect(errors(line)).toEqual([]);
  });

  it.each([
    ["pc1[cpus]=two", "two"],
    ["pc1[cpu]=two", "two"], // `cpu` is an alias, validated the same way
    ['pc1[cpus]=" "', " "], // blank once the quotes are gone
  ])("rejects %s", (line, value) => {
    expect(diagnostics(line)).toEqual([["error", `invalid cpus "${value}"`]]);
  });
});

describe("sysctl values", () => {
  it.each(["net.ipv4.ip_forward=1", "net.ipv6.conf.all.forwarding=0", "net.core.some-key=x"])("accepts %s", (value) => {
    expect(errors(`pc1[sysctl]=${value}`)).toEqual([]);
  });

  it.each([
    ["kernel.shmmax=1", "outside the net.* namespace"],
    ["net.ip_forward=1", "net.* but a single segment after it"],
    ["xnet.ipv4.ip_forward=1", "a prefix before net."],
    ["net.ipv4.ip!forward=1", "a character a sysctl name cannot hold"],
    ["=1", "no name at all"],
    ["net.ipv4.ip_forward", "no value"],
  ])("rejects %s (%s)", (value) => {
    expect(diagnostics(`pc1[sysctl]=${value}`)).toEqual([["error", `invalid sysctl "${value}" (must be net.*=value)`]]);
  });
});

describe("env values", () => {
  it.each(["A=1", "PATH=/usr/bin:/bin", "EMPTY=", "A=b=c"])("accepts %s", (value) => {
    expect(errors(`pc1[env]=${value}`)).toEqual([]);
  });

  it.each(["NOEQUALS", "=value"])("rejects %s — a variable needs a name before its '='", (value) => {
    expect(diagnostics(`pc1[env]=${value}`)).toEqual([["error", `invalid env "${value}"`]]);
  });
});

describe("ulimit values", () => {
  it.each(["nofile=1024", "nofile=1024:4096", "memlock=-1", "memlock=-1:-1", "core=0:10"])("accepts %s", (value) => {
    expect(errors(`pc1[ulimit]=${value}`)).toEqual([]);
  });

  it.each([
    ["nofile", "no value"],
    ["nofile=", "an empty value"],
    ["nofile=1024x", "trailing junk"],
    ["!nofile=1024", "a name that is not a word"],
    ["nofile=soft", "a non-numeric soft limit"],
    ["nofile=1:hard", "a non-numeric hard limit"],
    ["nofile=1:", "an empty hard limit"],
    ["nofile=1:2:3", "three limits"],
  ])("rejects %s (%s)", (value) => {
    expect(diagnostics(`pc1[ulimit]=${value}`)).toEqual([["error", `invalid ulimit "${value}"`]]);
  });
});

describe("interface lines", () => {
  it("accepts a MAC address after the collision domain", () => {
    expect(lint("pc1[0]=A/02:42:ac:11:00:02")).toEqual([]);
  });

  it("accepts a multi-character collision domain name", () => {
    expect(lint("pc1[0]=lan_1")).toEqual([]);
  });

  it.each([
    ["A/b/c", `invalid interface "A/b/c"`],
    ["A/", `invalid interface "A/"`], // an empty part after the slash does not count
    ["A-B", `invalid collision domain "A-B"`],
    ["A-B/02:42:ac:11:00:02", `invalid collision domain "A-B"`],
  ])("rejects %s", (value, message) => {
    expect(diagnostics(`pc1[0]=${value}`)).toEqual([["error", message]]);
  });

  it("counts a two-digit interface number in the sequence check", () => {
    expect(diagnostics("pc1[10]=A")).toEqual([
      ["error", "pc1: non-sequential interface numbers (expected eth0, got eth10)"],
    ]);
  });

  it.each(["eth0", "1x"])("treats the argument %j, not all digits, as an option rather than an interface", (arg) => {
    expect(diagnostics(`pc1[${arg}]=A`)).toEqual([["warning", `meta "${arg}" not recognized`]]);
  });
});

describe("other options", () => {
  it.each(["pc1[num_terms]=3", "pc1[num_terms]=12", 'pc1[num_terms]=" 3 "'])("accepts the integer num_terms in %s", (line) => {
    expect(lint(line)).toEqual([]);
  });

  it.each(["3x", "x3", "-"])("warns about the non-integer num_terms %j", (value) => {
    expect(diagnostics(`pc1[num_terms]=${value}`)).toEqual([["warning", `invalid num_terms "${value}"`]]);
  });

  it("names an unrecognized option in its warning", () => {
    expect(diagnostics("pc1[colour]=blue")).toEqual([["warning", `meta "colour" not recognized`]]);
  });

  it("warns about a host mount with the device named and the reason given", () => {
    expect(diagnostics("pc1[volume]=/host|/guest")).toEqual([
      [
        "warning",
        "pc1[volume] — mounts a directory from the host filesystem into this device; " +
          "make sure you trust this lab before deploying it.",
      ],
    ]);
  });

  it.each(["pc1[image]=kathara/frr", "pc1[mem]=256m", "pc1[exec]=ip a", "pc1[shell]=/bin/bash"])(
    "leaves the free-form option %s alone",
    (line) => {
      expect(lint(line)).toEqual([]);
    },
  );
});

describe("top-level lines", () => {
  it.each(['LAB_NAME="demo"', "LAB_DESCRIPTION = a lab", "LAB_WEB=https://example.org"])(
    "is silent on the LAB_* directive %s, spaces around '=' included",
    (line) => {
      expect(lint(line)).toEqual([]);
    },
  );

  it.each([
    ["SOMETHING=1", "SOMETHING"],
    ["custom_key = x", "custom_key"],
  ])("warns about the unknown key in %s", (line, key) => {
    expect(diagnostics(line)).toEqual([["warning", `unknown lab.conf key "${key}" — kept as-is, not applied`]]);
  });

  it.each(["1ABC=2", "=LAB_NAME", "LAB_NAME", "has space=1"])("cannot parse %j", (line) => {
    expect(diagnostics(line)).toEqual([["error", `cannot parse "${line}"`]]);
  });
});
