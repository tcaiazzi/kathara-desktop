import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isBoundedString,
  isPlainAbsolutePath,
  isTrustedRendererUrl,
  isUsablePort,
  quoteForShellString,
} from "./safety";

// Every character the path check must refuse: shell metacharacters plus the control characters
// that break a `.bat` line or a shell script.
const METACHARACTERS = [
  '"', "'", "$", "`", "%", "!", "^", "&", "|", "<", ">", "(", ")", ";", "{", "}", "*", "?", "~",
  "[", "]", "#", "\r", "\n", "\t", "\0",
];

describe("isPlainAbsolutePath", () => {
  it.each(["/home/user/labs", "/opt/Kathara Desktop/labs", "/tmp/back\\slash", "/"])(
    "accepts the POSIX absolute path %j",
    (value) => {
      expect(isPlainAbsolutePath(value, "linux")).toBe(true);
    },
  );

  it.each(["C:\\Users\\user\\labs", "C:\\Program Files\\Python\\python.exe", "\\\\server\\share\\labs"])(
    "accepts the Windows absolute path %j",
    (value) => {
      expect(isPlainAbsolutePath(value, "win32")).toBe(true);
    },
  );

  it("judges absoluteness for the platform it is asked about, not the one it runs on", () => {
    expect(isPlainAbsolutePath("C:\\labs", "linux")).toBe(false);
    expect(isPlainAbsolutePath("C:\\labs", "win32")).toBe(true);
    expect(isPlainAbsolutePath("labs\\sub", "win32")).toBe(false);
  });

  it.each(["labs", "./labs", "../labs", "labs/sub"])("rejects the relative path %j", (value) => {
    expect(isPlainAbsolutePath(value, "linux")).toBe(false);
  });

  it.each(METACHARACTERS)("rejects a path containing %j on both platforms", (char) => {
    expect(isPlainAbsolutePath(`/home/user/la${char}bs`, "linux")).toBe(false);
    expect(isPlainAbsolutePath(`C:\\Users\\la${char}bs`, "win32")).toBe(false);
  });

  it.each([
    ["an empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { path: "/home/user/labs" }],
    ["an array", ["/home/user/labs"]],
  ])("rejects %s — an IPC argument's declared type is erased at runtime", (_label, value) => {
    expect(isPlainAbsolutePath(value, "linux")).toBe(false);
  });
});

describe("isBoundedString", () => {
  it("accepts a string up to and including the limit", () => {
    expect(isBoundedString("", 0)).toBe(true);
    expect(isBoundedString("abc", 3)).toBe(true);
    expect(isBoundedString("p@ss w0rd; rm -rf /", 64)).toBe(true); // any text, metacharacters included
  });

  it("rejects a string over the limit", () => {
    expect(isBoundedString("abcd", 3)).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 3],
    ["an object", { toString: () => "abc" }],
    ["a boxed string", new String("abc")],
  ])("rejects %s", (_label, value) => {
    expect(isBoundedString(value, 10)).toBe(false);
  });
});

describe("isUsablePort", () => {
  it.each([1024, 8000, 41234, 65535])("accepts %d", (port) => {
    expect(isUsablePort(port)).toBe(true);
  });

  // A hand-edited preferences.json is the only way these reach here.
  it.each([
    ["a privileged port", 1023],
    ["port 0", 0],
    ["a negative port", -1],
    ["a port past the range", 65536],
    ["a fraction", 8080.5],
    ["a numeric string", "8080"],
    ["NaN", Number.NaN],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, port) => {
    expect(isUsablePort(port)).toBe(false);
  });
});

describe("quoteForShellString", () => {
  it("single-quotes on POSIX, with the '\\'' sequence for an embedded quote", () => {
    expect(quoteForShellString("/opt/My Labs", "linux")).toBe("'/opt/My Labs'");
    expect(quoteForShellString("it's", "darwin")).toBe("'it'\\''s'");
  });

  it("double-quotes on Windows, doubling an embedded quote", () => {
    expect(quoteForShellString("C:\\Program Files\\x", "win32")).toBe('"C:\\Program Files\\x"');
    expect(quoteForShellString('a"b', "win32")).toBe('"a""b"');
  });

  // The string check above only says the output looks right; this asks a real shell whether it
  // gets back exactly the argument that went in, with no expansion of any kind.
  it.skipIf(process.platform === "win32").each([
    "/opt/My Labs",
    "it's",
    "$HOME `id` $(id) ${PATH}",
    "a;b|c&d>e<f",
    "*?[a]~",
    "new\nline",
    "\\ back\\slash",
    "'''",
  ])("round-trips %j through /bin/sh unchanged", (arg) => {
    const echoed = execFileSync("/bin/sh", ["-c", `printf '%s' ${quoteForShellString(arg, "linux")}`], {
      encoding: "utf8",
    });
    expect(echoed).toBe(arg);
  });
});

describe("isTrustedRendererUrl", () => {
  const posixPages = ["/opt/kathara/build/setup.html", "/home/u/My Apps/kathara/build/splash.html", "/opt/é/setup.html"];

  it.each(["http://127.0.0.1:41234/workspace", "http://127.0.0.1:1/", "http://127.0.0.1:65535/api?x=1#y"])(
    "trusts the backend's loopback origin on any port: %s",
    (url) => {
      expect(isTrustedRendererUrl(url, [], "linux")).toBe(true);
    },
  );

  it.each([
    ["localhost, a different origin to Chromium", "http://localhost:41234/"],
    ["https", "https://127.0.0.1:41234/"],
    ["another loopback address", "http://127.0.0.2:41234/"],
    ["a host that merely starts with 127.0.0.1", "http://127.0.0.1.evil.example:41234/"],
    ["a remote page", "https://evil.example/"],
    ["the default port, which the origin then omits", "http://127.0.0.1:80/"],
    ["an out-of-range port", "http://127.0.0.1:123456/"],
    ["a non-URL", "not a url"],
    ["an empty URL", ""],
    ["no URL at all", undefined],
    ["another scheme", "data:text/html,<script>1</script>"],
  ])("does not trust %s", (_label, url) => {
    expect(isTrustedRendererUrl(url, posixPages, "linux")).toBe(false);
  });

  it("trusts a local app page by its path, including percent-encoded spaces and non-ASCII", () => {
    for (const page of posixPages) {
      expect(isTrustedRendererUrl(pathToFileURL(page).href, posixPages, "linux")).toBe(true);
    }
    expect(isTrustedRendererUrl("file:///home/u/My%20Apps/kathara/build/splash.html", posixPages, "linux")).toBe(true);
    expect(isTrustedRendererUrl("file:///opt/%C3%A9/setup.html", posixPages, "linux")).toBe(true);
  });

  it.each([
    ["a file that is not an app page", "file:///etc/passwd"],
    ["a differently-cased path on POSIX", "file:///opt/kathara/build/SETUP.html"],
    ["a file URL with a remote host", "file://evil.example/opt/kathara/build/setup.html"],
    ["a file URL encoding a slash", "file:///opt/kathara/build%2Fsetup.html"],
  ])("does not trust %s", (_label, url) => {
    expect(isTrustedRendererUrl(url, posixPages, "linux")).toBe(false);
  });

  it("matches Windows app pages case-insensitively, and only on Windows", () => {
    const winPages = ["C:\\Program Files\\Kathara Desktop\\resources\\app\\build\\setup.html"];
    const url = "file:///c:/program%20files/kathara%20desktop/RESOURCES/app/build/Setup.html";

    expect(isTrustedRendererUrl(url, winPages, "win32")).toBe(true);
    expect(isTrustedRendererUrl("file:///C:/Windows/System32/drivers/etc/hosts", winPages, "win32")).toBe(false);
    expect(isTrustedRendererUrl("file://evil.example/share/setup.html", winPages, "win32")).toBe(false);
  });

  it.each([
    ["a path with no drive letter", "file:///opt/kathara/build/setup.html"],
    ["an encoded slash", "file:///C:/Program%20Files/Kathara%20Desktop%2Fsetup.html"],
    ["an encoded backslash", "file:///C:/Program%20Files/Kathara%20Desktop%5Csetup.html"],
  ])("does not trust, and does not throw on, a Windows file URL with %s", (_label, url) => {
    const winPages = ["C:\\Program Files\\Kathara Desktop\\setup.html"];

    expect(isTrustedRendererUrl(url, winPages, "win32")).toBe(false);
  });
});
