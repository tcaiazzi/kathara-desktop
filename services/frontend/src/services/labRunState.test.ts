import { describe, expect, it } from "vitest";
import { hasDeployFailure, labDotState, labRunLabel, labRunState, labRunSummary } from "./labRunState";

const lab = (n_running: number, n_machines: number, deploy_error: string | null = null) => ({
  n_running,
  n_machines,
  deploy_error,
});

describe("labRunState", () => {
  it.each([
    [0, 3, "stopped"],
    [0, 0, "stopped"],
    [1, 3, "partial"],
    [3, 3, "running"],
  ] as const)("%i of %i running is %s", (running, machines, state) => {
    expect(labRunState(lab(running, machines))).toBe(state);
  });
});

describe("labRunLabel", () => {
  it("says how many devices are up when only some are", () => {
    expect(labRunLabel(lab(2, 3))).toBe("2/3 deployed");
  });

  it("keeps the plain words for all and none", () => {
    expect(labRunLabel(lab(3, 3))).toBe("deployed");
    expect(labRunLabel(lab(0, 3))).toBe("undeployed");
  });
});

describe("labRunSummary", () => {
  it.each([
    [lab(3, 3), "Running · 3 devices"],
    [lab(2, 3), "2 of 3 devices running"],
    [lab(0, 1), "Stopped · 1 device"],
  ])("describes %j as %j", (value, text) => {
    expect(labRunSummary(value)).toBe(text);
  });
});

describe("hasDeployFailure", () => {
  it("is set only while a recorded failure leaves devices stopped", () => {
    expect(hasDeployFailure(lab(1, 3, "port is already allocated"))).toBe(true);
    expect(hasDeployFailure(lab(0, 3, "port is already allocated"))).toBe(true);
    expect(hasDeployFailure(lab(3, 3, "port is already allocated"))).toBe(false);
  });

  it("is not set by a lab deployed a device at a time", () => {
    expect(hasDeployFailure(lab(1, 3))).toBe(false);
  });
});

describe("labDotState", () => {
  it("puts a lab that isn't loaded first, then a deploy failure, then how much runs", () => {
    expect(labDotState({ ...lab(0, 0), problem: "missing" })).toBe("problem");
    expect(labDotState({ ...lab(1, 3, "boom"), problem: null })).toBe("failed");
    expect(labDotState({ ...lab(1, 3), problem: null })).toBe("partial");
    expect(labDotState({ ...lab(3, 3, "boom"), problem: null })).toBe("running");
  });
});
