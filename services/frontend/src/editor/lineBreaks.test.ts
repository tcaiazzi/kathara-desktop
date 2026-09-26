// The contract: a text CodeMirror has normalized to `\n`, re-joined with the line ending detected
// on the original, is the original again — for any text whose line endings are consistent.

import { describe, expect, it } from "vitest";
import { detectLineBreak, withLineBreak } from "./lineBreaks";

// What CodeMirror's `doc.toString()` returns for a document built from `text`.
const codeMirrorText = (text: string) => text.split(/\r\n?|\n/).join("\n");

describe("detectLineBreak", () => {
  it.each([
    ["a\nb\n", "\n"],
    ["a\r\nb\r\n", "\r\n"],
    ["no line break", "\n"],
    ["", "\n"],
    ["a\r\nb\nc\n", "\r\n"],
    ["a\nb\r\nc\r\n", "\n"],
  ])("detects the first line break of %j as %j", (text, expected) => {
    expect(detectLineBreak(text)).toBe(expected);
  });
});

describe("withLineBreak", () => {
  it.each([["pc1[0]=A\r\npc2[0]=A\r\n"], ["pc1[0]=A\npc2[0]=A\n"], ["ip link set eth0 up"], [""]])(
    "gives back %j unchanged after CodeMirror normalizes it",
    (text) => {
      expect(withLineBreak(codeMirrorText(text), detectLineBreak(text))).toBe(text);
    },
  );

  it("joins every line with CRLF when the file uses CRLF", () => {
    expect(withLineBreak("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
  });
});
