// How much of a lab is running, as every surface that shows it says it: the header badge, the
// rail's dot and its hover card. Partly running is an ordinary state — devices are deployed one at
// a time as well as all together — and only a recorded deploy failure (LabSummary.deploy_error)
// turns it into something to warn about.

import { plural } from "./format";
import type { LabSummary } from "./types";

type LabRunState = "running" | "partial" | "stopped";

type RunFields = Pick<LabSummary, "n_machines" | "n_running">;

export function labRunState(lab: RunFields): LabRunState {
  if (lab.n_running <= 0) return "stopped";
  return lab.n_running >= lab.n_machines ? "running" : "partial";
}

/** The header badge's text: "deployed", "2/3 deployed" or "undeployed". */
export function labRunLabel(lab: RunFields): string {
  const state = labRunState(lab);
  if (state === "running") return "deployed";
  if (state === "partial") return `${lab.n_running}/${lab.n_machines} deployed`;
  return "undeployed";
}

/** The hover card's state line: "Running · 3 devices", "2 of 3 devices running", "Stopped · 1 device". */
export function labRunSummary(lab: RunFields): string {
  const devices = plural(lab.n_machines, "device");
  const state = labRunState(lab);
  if (state === "partial") return `${lab.n_running} of ${devices} running`;
  return `${state === "running" ? "Running" : "Stopped"} · ${devices}`;
}

/** The rail dot's state class (`.kt-ws-dot.<state>`): a lab that isn't loaded, then a deploy
 *  failure, over how much of it runs. */
export function labDotState(lab: RunFields & Pick<LabSummary, "deploy_error" | "problem">): LabRunState | "problem" | "failed" {
  if (lab.problem) return "problem";
  if (hasDeployFailure(lab)) return "failed";
  return labRunState(lab);
}

/** Whether the lab's last deploy failed and left devices it was meant to start stopped — the case
 *  worth a warning, as opposed to a lab someone deployed a device at a time. */
export function hasDeployFailure(lab: RunFields & Pick<LabSummary, "deploy_error">): boolean {
  return !!lab.deploy_error && labRunState(lab) !== "running";
}
