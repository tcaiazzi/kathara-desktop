// The topology canvas's display preferences — how the graph is laid out, which interface label
// lines and domain names show, how big the graph is drawn, how thick its lines are, high contrast, and whether the
// legend is folded. Per viewer and global across labs, kept in localStorage under TOPO_DISPLAY_KEY.
// Everything read back from storage goes through parseTopoDisplay, which is the one place that
// decides what a valid saved value is.

import type { LayeredDirection } from "./topologyLayout";

// How a fresh arrangement of the graph is made: the force simulation, a layered one by tier, or the
// force simulation keeping the devices of each name group together (services/topologyLayout.ts).
export const TOPO_LAYOUTS = ["force", "layered", "grouped"] as const;
export type TopoLayout = (typeof TOPO_LAYOUTS)[number];
export const LAYERED_DIRECTIONS: readonly LayeredDirection[] = ["tb", "lr"];

export interface TopoDisplay {
  layout: TopoLayout;
  // Which way a layered layout's tiers run.
  layeredDirection: LayeredDirection;
  // Point-to-point domains drawn as a straight link between their two devices.
  collapseP2p: boolean;
  ips: boolean;
  macs: boolean;
  cdNames: boolean;
  // Nodes and their labels, together (1 = as designed).
  scale: number;
  // Multiplies every edge and border stroke.
  lineWidth: number;
  highContrast: boolean;
  legendCollapsed: boolean;
}

export const DEFAULT_TOPO_DISPLAY: TopoDisplay = {
  layout: "force",
  layeredDirection: "tb",
  collapseP2p: false,
  ips: true,
  macs: false,
  cdNames: true,
  scale: 1,
  lineWidth: 1,
  highContrast: false,
  legendCollapsed: false,
};

export const TOPO_DISPLAY_KEY = "kt-topo-display";
// The IP/MAC toggles' own keys, read only while TOPO_DISPLAY_KEY has never been written, so a
// viewer's existing choice carries over.
export const LEGACY_IPS_KEY = "kt-topo-ips";
export const LEGACY_MACS_KEY = "kt-topo-macs";

export interface Steps {
  min: number;
  max: number;
  step: number;
}

export const SCALE_STEPS: Steps = { min: 0.8, max: 1.6, step: 0.1 };
export const LINE_STEPS: Steps = { min: 1, max: 3, step: 0.5 };

/** The nearest step to `value`, inside the range. Rounded to two decimals, so repeated stepping
 *  lands on 1.1 and not on 1.1000000000000003. */
export function snapToSteps(value: number, steps: Steps): number {
  const snapped = steps.min + Math.round((value - steps.min) / steps.step) * steps.step;
  return Number(Math.min(steps.max, Math.max(steps.min, snapped)).toFixed(2));
}

/** One step up (`dir` 1) or down (-1) from `value`, stopping at the ends of the range. */
export function stepValue(value: number, steps: Steps, dir: 1 | -1): number {
  return snapToSteps(snapToSteps(value, steps) + dir * steps.step, steps);
}

export function canStep(value: number, steps: Steps, dir: 1 | -1): boolean {
  return stepValue(value, steps, dir) !== snapToSteps(value, steps);
}

export function formatScale(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

export function formatLineWidth(lineWidth: number): string {
  return `${lineWidth}×`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.find((c) => c === value) ?? fallback;
}

function readSteps(value: unknown, steps: Steps, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? snapToSteps(value, steps) : fallback;
}

/** The preferences saved under TOPO_DISPLAY_KEY, field by field: a missing or malformed field takes
 *  its default, and a number out of range is brought back into it. When nothing usable is saved
 *  there yet, the IP/MAC choices come from their legacy keys instead. */
export function parseTopoDisplay(
  saved: string | null,
  legacy: { ips: string | null; macs: string | null } = { ips: null, macs: null },
): TopoDisplay {
  let data: unknown = null;
  try {
    data = saved === null ? null : JSON.parse(saved);
  } catch {
    data = null;
  }
  const d = DEFAULT_TOPO_DISPLAY;
  if (!isRecord(data)) {
    return { ...d, ips: legacy.ips !== "false", macs: legacy.macs === "true" };
  }
  return {
    layout: readChoice(data.layout, TOPO_LAYOUTS, d.layout),
    layeredDirection: readChoice(data.layeredDirection, LAYERED_DIRECTIONS, d.layeredDirection),
    collapseP2p: readBool(data.collapseP2p, d.collapseP2p),
    ips: readBool(data.ips, d.ips),
    macs: readBool(data.macs, d.macs),
    cdNames: readBool(data.cdNames, d.cdNames),
    scale: readSteps(data.scale, SCALE_STEPS, d.scale),
    lineWidth: readSteps(data.lineWidth, LINE_STEPS, d.lineWidth),
    highContrast: readBool(data.highContrast, d.highContrast),
    legendCollapsed: readBool(data.legendCollapsed, d.legendCollapsed),
  };
}
