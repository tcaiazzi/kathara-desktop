import { describe, expect, it } from "vitest";
import { fromLabPath, toLabPath } from "./deviceFs";

describe("toLabPath", () => {
  it("puts the device's folder in front of the path", () => {
    expect(toLabPath("pc1", "/etc/motd")).toBe("/pc1/etc/motd");
  });

  it("maps the device's root to its folder", () => {
    expect(toLabPath("pc1", "/")).toBe("/pc1");
    expect(toLabPath("pc1", "")).toBe("/pc1");
  });
});

describe("fromLabPath", () => {
  it("strips the device's folder", () => {
    expect(fromLabPath("pc1", "/pc1/etc/motd")).toBe("/etc/motd");
    expect(fromLabPath("pc1", "/pc1")).toBe("/");
  });

  it("round-trips with toLabPath", () => {
    expect(fromLabPath("r1", toLabPath("r1", "/etc/frr/frr.conf"))).toBe("/etc/frr/frr.conf");
  });

  it("refuses a path outside the folder, including another device's with the same prefix", () => {
    expect(() => fromLabPath("pc1", "/pc10/etc")).toThrow();
    expect(() => fromLabPath("pc1", "/pc1.startup")).toThrow();
  });
});
