import { describe, expect, it } from "vitest";
import { deepLinkFromArgv, resolveDeepLink } from "./deepLinkRoute";

describe("resolveDeepLink", () => {
  it.each([
    ["kathara://lab/demo", "/workspace?lab=demo"],
    ["kathara://lab/my%20lab", "/workspace?lab=my%20lab"],
    ["kathara://lab/caff%C3%A8", "/workspace?lab=caff%C3%A8"],
    ["kathara://lab/demo?tab=topology#x", "/workspace?lab=demo"],
  ])("routes %s to the workspace, naming the lab to open", (raw, route) => {
    expect(resolveDeepLink(raw)).toEqual({ kind: "route", route });
  });

  it("re-encodes the lab name, so an encoded slash or query cannot reach another route", () => {
    expect(resolveDeepLink("kathara://lab/..%2Fsettings")).toEqual({
      kind: "route",
      route: "/workspace?lab=..%2Fsettings",
    });
    expect(resolveDeepLink("kathara://lab/a%26welcome%3D1")).toEqual({
      kind: "route",
      route: "/workspace?lab=a%26welcome%3D1",
    });
  });

  it.each(["kathara://lab/%", "kathara://lab/%E0%A4%A", "kathara://lab/%ZZ"])(
    "reports the malformed escape in %s as unparsable instead of throwing",
    (raw) => {
      expect(() => resolveDeepLink(raw)).not.toThrow();
      expect(resolveDeepLink(raw)).toEqual({ kind: "unparsable" });
    },
  );

  it.each(["kathara://lab", "kathara://lab/a/b", "kathara://settings/x", "kathara://"])(
    "reports the kathara link %s as unrecognised",
    (raw) => {
      expect(resolveDeepLink(raw)).toEqual({ kind: "unrecognised" });
    },
  );

  it.each(["https://example.com/lab/demo", "katharax://lab/demo", "not a url", ""])(
    "treats %j as foreign",
    (raw) => {
      expect(resolveDeepLink(raw)).toEqual({ kind: "foreign" });
    },
  );
});

describe("deepLinkFromArgv", () => {
  it("finds the kathara:// argument among the others", () => {
    expect(deepLinkFromArgv(["/opt/kathara/kathara-desktop", "--no-sandbox", "kathara://lab/demo"])).toBe(
      "kathara://lab/demo",
    );
  });

  it("is null when there is none", () => {
    expect(deepLinkFromArgv(["/opt/kathara/kathara-desktop", "--flag=kathara://lab/demo"])).toBeNull();
    expect(deepLinkFromArgv([])).toBeNull();
  });
});
