import { describe, expect, it } from "vitest";
import { parseUploadLimits, uploadLimitsEnv } from "./uploadLimits";

describe("parseUploadLimits", () => {
  it("keeps the three limits when they are positive integers", () => {
    const limits = { max_files_per_lab: 500, max_bytes_per_file: 10485760, max_bytes_per_lab: 52428800 };

    expect(parseUploadLimits(limits)).toEqual(limits);
  });

  it("drops a limit that is zero, negative, fractional, a string or too large to be exact", () => {
    expect(
      parseUploadLimits({
        max_files_per_lab: 0,
        max_bytes_per_file: -5,
        max_bytes_per_lab: 1.5,
      }),
    ).toEqual({});
    expect(parseUploadLimits({ max_files_per_lab: "500", max_bytes_per_file: 2 ** 60 })).toEqual({});
  });

  it("drops keys that are not limits", () => {
    expect(parseUploadLimits({ max_files_per_lab: 3, labsDir: "/etc", KATHARA_API_AUTH_TOKEN: 1 })).toEqual({
      max_files_per_lab: 3,
    });
  });

  it("refuses anything that isn't an object", () => {
    for (const value of [null, undefined, 5, "x", [1, 2]]) expect(parseUploadLimits(value)).toBeNull();
  });
});

describe("uploadLimitsEnv", () => {
  it("names each saved limit as the backend's KATHARA_API_ env var", () => {
    expect(uploadLimitsEnv({ max_files_per_lab: 500, max_bytes_per_lab: 1024 })).toEqual({
      KATHARA_API_MAX_FILES_PER_LAB: "500",
      KATHARA_API_MAX_BYTES_PER_LAB: "1024",
    });
  });

  it("passes nothing for nothing saved, or for a preferences value that isn't valid", () => {
    expect(uploadLimitsEnv(undefined)).toEqual({});
    expect(uploadLimitsEnv({ max_files_per_lab: "1; rm -rf /" })).toEqual({});
  });
});
