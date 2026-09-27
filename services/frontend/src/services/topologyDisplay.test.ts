import { describe, expect, it } from "vitest";
import {
  canStep,
  DEFAULT_TOPO_DISPLAY,
  formatLineWidth,
  formatScale,
  LINE_STEPS,
  parseTopoDisplay,
  SCALE_STEPS,
  snapToSteps,
  stepValue,
} from "./topologyDisplay";

describe("parseTopoDisplay", () => {
  it("reads back every field that was saved", () => {
    const saved = { ips: false, macs: true, scale: 1.3, lineWidth: 2, highContrast: true, legendCollapsed: true };

    expect(parseTopoDisplay(JSON.stringify(saved))).toEqual(saved);
  });

  it("gives the defaults when nothing is saved, or what is saved is not an object", () => {
    expect(parseTopoDisplay(null)).toEqual(DEFAULT_TOPO_DISPLAY);
    expect(parseTopoDisplay("{not json")).toEqual(DEFAULT_TOPO_DISPLAY);
    expect(parseTopoDisplay("[1,2]")).toEqual(DEFAULT_TOPO_DISPLAY);
    expect(parseTopoDisplay("null")).toEqual(DEFAULT_TOPO_DISPLAY);
    expect(parseTopoDisplay('"text"')).toEqual(DEFAULT_TOPO_DISPLAY);
  });

  it("replaces only the missing or wrongly typed fields with their defaults", () => {
    const parsed = parseTopoDisplay(JSON.stringify({ macs: true, scale: "big", highContrast: 1, lineWidth: null }));

    expect(parsed).toEqual({ ...DEFAULT_TOPO_DISPLAY, macs: true });
  });

  it("brings an out-of-range or off-step number back onto the range's steps", () => {
    expect(parseTopoDisplay(JSON.stringify({ scale: 9, lineWidth: 0 }))).toMatchObject({ scale: 1.6, lineWidth: 1 });
    expect(parseTopoDisplay(JSON.stringify({ scale: 1.23, lineWidth: 1.7 }))).toMatchObject({ scale: 1.2, lineWidth: 1.5 });
  });

  it("carries the legacy IP/MAC choices over only while nothing is saved under the new key", () => {
    const legacy = { ips: "false", macs: "true" };

    expect(parseTopoDisplay(null, legacy)).toMatchObject({ ips: false, macs: true });
    expect(parseTopoDisplay(JSON.stringify({ ips: true }), legacy)).toMatchObject({ ips: true, macs: false });
    expect(parseTopoDisplay(null, { ips: null, macs: null })).toMatchObject({ ips: true, macs: false });
  });
});

describe("stepValue", () => {
  it("moves one step at a time and lands on round values", () => {
    let scale = 1;
    for (let i = 0; i < 3; i++) scale = stepValue(scale, SCALE_STEPS, 1);

    expect(scale).toBe(1.3);
    expect(stepValue(1, LINE_STEPS, 1)).toBe(1.5);
    expect(stepValue(1, SCALE_STEPS, -1)).toBe(0.9);
  });

  it("stops at both ends of the range", () => {
    expect(stepValue(SCALE_STEPS.max, SCALE_STEPS, 1)).toBe(SCALE_STEPS.max);
    expect(stepValue(SCALE_STEPS.min, SCALE_STEPS, -1)).toBe(SCALE_STEPS.min);
    expect(canStep(SCALE_STEPS.max, SCALE_STEPS, 1)).toBe(false);
    expect(canStep(SCALE_STEPS.max, SCALE_STEPS, -1)).toBe(true);
    expect(canStep(LINE_STEPS.min, LINE_STEPS, -1)).toBe(false);
  });

  it("walks the whole scale range in nine distinct steps", () => {
    const seen = [SCALE_STEPS.min];
    while (canStep(seen[seen.length - 1], SCALE_STEPS, 1)) seen.push(stepValue(seen[seen.length - 1], SCALE_STEPS, 1));

    expect(seen).toEqual([0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6]);
  });
});

describe("snapToSteps", () => {
  it("rounds to the nearest step inside the range", () => {
    expect(snapToSteps(1.04, SCALE_STEPS)).toBe(1);
    expect(snapToSteps(1.06, SCALE_STEPS)).toBe(1.1);
    expect(snapToSteps(-4, LINE_STEPS)).toBe(1);
  });
});

describe("formatScale / formatLineWidth", () => {
  it("shows the scale as a percentage and the thickness as a multiplier", () => {
    expect(formatScale(1)).toBe("100%");
    expect(formatScale(1.1)).toBe("110%");
    expect(formatLineWidth(1.5)).toBe("1.5×");
  });
});
