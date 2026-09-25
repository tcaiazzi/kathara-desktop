import { describe, expect, it } from "vitest";
import { CONF_LINE_RE, languageForPath } from "./editorLanguage";

describe("languageForPath", () => {
  it.each([
    ["lab.conf", "labconf"],
    ["lab.ext", "labconf"],
    ["lab.dep", "labconf"],
    ["/pc1/lab.conf", "labconf"],
    ["pc1.startup", "shell"],
    ["pc1.shutdown", "shell"],
    ["/etc/init.d/run.sh", "shell"],
    ["/etc/frr/frr.conf", "plaintext"],
    ["lab.conf.bak", "plaintext"],
    ["pc1.startup.bak", "plaintext"],
    ["startup", "plaintext"],
  ] as const)("picks the language of %s from its basename", (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });

  it.each([null, undefined, ""])("falls back to plain text for %s", (path) => {
    expect(languageForPath(path)).toBe("plaintext");
  });
});

describe("CONF_LINE_RE", () => {
  it.each([
    ["pc1[image]=kathara/frr", ["pc1", "image", "", "kathara/frr", undefined]],
    ['pc1[0]="A"', ["pc1", "0", '"', "A", undefined]],
    ["r_1[exec]='ip a' # show addresses", ["r_1", "exec", "'", "ip a", " # show addresses"]],
    ["pc1[0]=A/02:42:ac:11:00:02", ["pc1", "0", "", "A/02:42:ac:11:00:02", undefined]],
    // A comment needs whitespace before its `#`; without it the `#` is part of the value.
    ["pc1[image]=kathara/base#x", ["pc1", "image", "", "kathara/base#x", undefined]],
  ])("parses %s into name, option, quote, value and comment", (line, groups) => {
    expect(line.match(CONF_LINE_RE)?.slice(1)).toEqual(groups);
  });

  it.each([
    ["an upper-case device name", "PC1[image]=kathara/base"],
    ["a device name longer than 30 characters", `${"a".repeat(31)}[image]=kathara/base`],
    ["mismatched quotes", `pc1[image]="kathara/base'`],
    ["a quote inside the value", 'pc1[exec]=echo "hi"'],
    ["an empty value", "pc1[image]="],
    ["a global directive", 'LAB_NAME="demo"'],
  ])("rejects %s", (_label, line) => {
    expect(CONF_LINE_RE.test(line)).toBe(false);
  });
});

describe("CONF_LINE_RE comments", () => {
  it("separates a comment after several spaces from a quoted value", () => {
    expect('pc1[image]="kathara/base"    # the default'.match(CONF_LINE_RE)?.slice(4)).toEqual([
      "kathara/base",
      "    # the default",
    ]);
  });

  it("keeps a '#' after an unquoted value as part of the value, as the backend does", () => {
    expect("pc1[image]=kathara/base    # x".match(CONF_LINE_RE)?.slice(4)).toEqual(["kathara/base    # x", undefined]);
  });
});
