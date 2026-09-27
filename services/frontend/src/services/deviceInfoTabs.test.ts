import { describe, expect, it } from "vitest";
import { isDeviceInfoTab, savedDeviceTab } from "./deviceInfoTabs";

describe("savedDeviceTab", () => {
  it("reopens the tab saved last time", () => {
    expect(savedDeviceTab("files")).toBe("files");
  });

  it("falls back to Overview for nothing saved or a value that is no longer a tab", () => {
    expect(savedDeviceTab(null)).toBe("overview");
    expect(savedDeviceTab("actions")).toBe("overview");
    expect(savedDeviceTab(3)).toBe("overview");
  });
});

describe("isDeviceInfoTab", () => {
  it("accepts exactly the four tabs", () => {
    expect(["overview", "network", "scripts", "files"].every(isDeviceInfoTab)).toBe(true);
    expect(isDeviceInfoTab("Overview")).toBe(false);
  });
});
