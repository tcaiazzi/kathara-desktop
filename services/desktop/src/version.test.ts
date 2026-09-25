import { describe, expect, it } from "vitest";
import { atLeast310, isNewer, parseVersion } from "./version";

describe("parseVersion", () => {
  it.each([
    ["1.2.3", [1, 2, 3]],
    ["v10.20.30", [10, 20, 30]],
    ["  v0.1.6\n", [0, 1, 6]],
  ])("parses %j", (raw, expected) => {
    expect(parseVersion(raw)).toEqual(expected);
  });

  it.each(["1.2", "1.2.3.4", "1.2.3-beta.1", "0.0.0-dev", "v", "", "one.two.three", "V1.2.3"])(
    "has nothing to compare for %j",
    (raw) => {
      expect(parseVersion(raw)).toBeNull();
    },
  );
});

describe("isNewer", () => {
  it("compares major, then minor, then patch, numerically", () => {
    expect(isNewer([2, 0, 0], [1, 9, 9])).toBe(true);
    expect(isNewer([1, 10, 0], [1, 9, 9])).toBe(true);
    expect(isNewer([1, 2, 10], [1, 2, 9])).toBe(true);
  });

  it("is false for the same or an older version", () => {
    expect(isNewer([1, 2, 3], [1, 2, 3])).toBe(false);
    expect(isNewer([1, 2, 3], [1, 3, 0])).toBe(false);
    expect(isNewer([0, 9, 9], [1, 0, 0])).toBe(false);
  });
});

describe("atLeast310", () => {
  it.each(["3.10.0", "3.12.4", "3.13.13", "4.0.0"])("accepts Python %s", (version) => {
    expect(atLeast310(version)).toBe(true);
  });

  // 3.1 and 3.9 sort after 3.10 as strings: the comparison has to be numeric.
  it.each(["3.9.18", "3.1.0", "2.7.18", "garbage", ""])("rejects Python %j", (version) => {
    expect(atLeast310(version)).toBe(false);
  });
});
