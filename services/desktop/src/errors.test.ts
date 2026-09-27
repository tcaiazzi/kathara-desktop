import { describe, expect, it } from "vitest";
import { errorText } from "./errors";

describe("errorText", () => {
  it("is an Error's message, without its name or stack", () => {
    expect(errorText(new TypeError("boom"))).toBe("boom");
  });

  it("stringifies anything that isn't an Error", () => {
    expect(errorText("plain")).toBe("plain");
    expect(errorText(42)).toBe("42");
    expect(errorText(undefined)).toBe("undefined");
    expect(errorText(null)).toBe("null");
  });
});
