import { describe, expect, it } from "vitest";
import { plural } from "./format";

describe("plural", () => {
  it("uses the singular for exactly one and the plural for anything else, zero included", () => {
    expect(plural(1, "device")).toBe("1 device");
    expect(plural(3, "device")).toBe("3 devices");
    expect(plural(0, "device")).toBe("0 devices");
  });

  it("pluralizes only the last word of a compound noun by default", () => {
    expect(plural(2, "collision domain")).toBe("2 collision domains");
  });

  it("takes an irregular plural", () => {
    expect(plural(2, "entry", "entries")).toBe("2 entries");
    expect(plural(1, "entry", "entries")).toBe("1 entry");
  });
});
