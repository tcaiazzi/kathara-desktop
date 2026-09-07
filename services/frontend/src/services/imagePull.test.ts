import { describe, expect, it } from "vitest";
import {
  deployButtonLabel,
  downloadKind,
  formatBytes,
  progressPercent,
  pulledMessage,
} from "./imagePull";
import type { LabImagesStatus } from "./types";

describe("formatBytes", () => {
  it("keeps small values in bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("scales up and drops a trailing .0", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3 GB");
  });

  it("survives a missing or nonsensical value", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("progressPercent", () => {
  it("is indeterminate until a total is known", () => {
    expect(progressPercent(null, 0, 0)).toBeNull();
  });

  it("computes a plain ratio with no previous value", () => {
    expect(progressPercent(null, 50, 200)).toBe(25);
  });

  it("never runs backwards when a late layer inflates the total", () => {
    // 120/200 = 60%. Then Docker announces another layer: 120/400 would be 30%, which would make
    // the bar visibly jump back — so the clamp holds it at 60 until real progress passes it.
    const first = progressPercent(null, 120, 200);
    expect(first).toBe(60);
    expect(progressPercent(first, 120, 400)).toBe(60);
    expect(progressPercent(60, 280, 400)).toBe(70);
  });

  it("resets when the caller drops the previous value for a new image", () => {
    expect(progressPercent(null, 10, 400)).toBe(2.5);
  });

  it("clamps out-of-range inputs", () => {
    expect(progressPercent(null, 500, 200)).toBe(100);
    expect(progressPercent(null, -5, 200)).toBe(0);
  });
});

describe("downloadKind", () => {
  const base: LabImagesStatus = {
    update_policy: "Prompt",
    images: [],
    missing: [],
    outdated: [],
  };

  it("reports missing-only", () => {
    expect(downloadKind({ ...base, missing: ["kathara/base"] })).toBe("missing");
  });

  it("reports outdated-only", () => {
    expect(downloadKind({ ...base, outdated: ["kathara/base"] })).toBe("outdated");
  });

  it("reports both", () => {
    expect(downloadKind({ ...base, missing: ["a"], outdated: ["b"] })).toBe("both");
  });
});

describe("deployButtonLabel", () => {
  it("names the pre-check phase so it doesn't look like a frozen deploy", () => {
    expect(deployButtonLabel("checking", false)).toBe("Checking images…");
  });

  it("covers the in-flight phases", () => {
    expect(deployButtonLabel("deploy", false)).toBe("Deploying…");
    expect(deployButtonLabel("undeploy", true)).toBe("Undeploying…");
  });

  it("falls back to the lab's own state when idle", () => {
    expect(deployButtonLabel(null, false)).toBe("Deploy");
    expect(deployButtonLabel(null, true)).toBe("Undeploy");
  });
});

describe("pulledMessage", () => {
  it("has a generic fallback when no image name is known (an adopted download)", () => {
    expect(pulledMessage()).toBe("The Docker image download finished.");
  });

  it("names the one image that finished", () => {
    expect(pulledMessage("kathara/base")).toBe("Downloaded Docker image kathara/base.");
  });
});
