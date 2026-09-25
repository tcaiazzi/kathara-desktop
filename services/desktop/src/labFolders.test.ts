import { describe, expect, it } from "vitest";
import { folderFromArgv, knownLabDirs, reclaimScript } from "./labFolders";

describe("folderFromArgv", () => {
  const dirs = new Set(["/home/u/labs/ospf", "/work/lab"]);
  const isDirectory = (candidate: string) => dirs.has(candidate);

  it("takes the folder after the executable of a packaged app", () => {
    expect(folderFromArgv(["/opt/kathara/kathara-desktop", "/home/u/labs/ospf"], "/", [], isDirectory)).toBe(
      "/home/u/labs/ospf",
    );
  });

  it("skips the app path of an unpackaged run, wherever Chromium's switches put it", () => {
    const app = ["/work/lab"];
    expect(folderFromArgv(["/x/electron", "/work/lab"], "/", app, isDirectory)).toBeNull();
    expect(folderFromArgv(["/x/electron", "--flag", "/work/lab"], "/", app, isDirectory)).toBeNull();
    expect(folderFromArgv(["/x/electron", ".", "/home/u/labs/ospf"], "/work/lab", app, isDirectory)).toBe(
      "/home/u/labs/ospf",
    );
  });

  it("resolves a relative folder against the calling shell's directory", () => {
    expect(folderFromArgv(["/app", "ospf"], "/home/u/labs", [], isDirectory)).toBe("/home/u/labs/ospf");
    expect(folderFromArgv(["/app", "."], "/work/lab", [], isDirectory)).toBe("/work/lab");
  });

  it.each([
    "kathara:../../../../work/lab",
    "kathara:/work/lab",
    "KATHARA:../../work/lab",
    "file:///work/lab",
    "x-scheme:../work/lab",
  ])("never takes the URL %s for a folder, whatever it resolves to", (url) => {
    expect(folderFromArgv(["/app", url], "/home/u/labs/ospf", [], () => true)).toBeNull();
  });

  it("still takes a Windows drive path", () => {
    expect(folderFromArgv(["C:\\app.exe", "C:\\labs\\ospf"], "C:\\", [], () => true)).not.toBeNull();
    expect(folderFromArgv(["C:\\app.exe", "D:/labs"], "C:\\", [], () => true)).not.toBeNull();
  });

  it("ignores flags and kathara:// links, wherever they sit", () => {
    expect(
      folderFromArgv(["/app", "--no-sandbox", "/work/lab", "--remote-debugging-port=9222"], "/", [], isDirectory),
    ).toBe("/work/lab");
    expect(folderFromArgv(["/app", "kathara://lab/demo"], "/", [], isDirectory)).toBeNull();
  });

  it("is null for anything that is not a directory", () => {
    expect(folderFromArgv(["/app", "/work/lab/lab.conf"], "/", [], isDirectory)).toBeNull();
    expect(folderFromArgv(["/app"], "/", [], isDirectory)).toBeNull();
    expect(folderFromArgv([], "/", [], isDirectory)).toBeNull();
  });
});

describe("knownLabDirs", () => {
  it("lists every absolute path the backend recorded, once, in order", () => {
    const text = JSON.stringify({ version: 1, labs: [{ path: "/a" }, { path: "/b" }, { path: "/a" }] });
    expect(knownLabDirs(text)).toEqual(["/a", "/b"]);
  });

  it("skips entries it can't use", () => {
    const text = JSON.stringify({ labs: [{ path: "relative" }, { nope: 1 }, "x", null, { path: 3 }, { path: "/ok" }] });
    expect(knownLabDirs(text)).toEqual(["/ok"]);
  });

  it.each(["not json", "[]", "null", '{"labs": "x"}', "{}"])("reads %j as no folders", (text) => {
    expect(knownLabDirs(text)).toEqual([]);
  });
});

describe("reclaimScript", () => {
  it("chowns the labs directory wholesale and only root's files in opened folders", () => {
    expect(reclaimScript({ labsDir: "/home/u/labs", openedDirs: ["/work/a", "/work/b c"] }, 1000, 1000)).toBe(
      "chown -R 1000:1000 '/home/u/labs' && find -P '/work/a' '/work/b c' -uid 0 -exec chown -h 1000:1000 {} +",
    );
  });

  it("covers just what needs it", () => {
    expect(reclaimScript({ labsDir: "/labs", openedDirs: [] }, 1, 2)).toBe("chown -R 1:2 '/labs'");
    expect(reclaimScript({ labsDir: null, openedDirs: ["/w"] }, 1, 2)).toBe(
      "find -P '/w' -uid 0 -exec chown -h 1:2 {} +",
    );
    expect(reclaimScript({ labsDir: null, openedDirs: [] }, 1, 2)).toBeNull();
  });

  it.each(["/work/$(reboot)", "relative", "/a'b", "/x;rm -rf /"])("refuses the suspicious path %j", (dir) => {
    expect(() => reclaimScript({ labsDir: null, openedDirs: [dir] }, 1, 2)).toThrow(/suspicious path/);
  });
});
