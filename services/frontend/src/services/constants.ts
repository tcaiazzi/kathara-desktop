import type { InterfaceModel, MachineDetail } from "./types";

// The project's own docs site — the one external link the app offers from its Help menu and its
// welcome screen. Kept as one constant so the two surfaces can never say something different;
// services/desktop/src/menu.ts has its own copy (the main process shares no module graph with
// the renderer), which must be kept in step by hand if this ever changes.
export const DOCS_URL = "https://www.kathara.org/";

// Kathara's own internal collision domain, present on every deployed lab; hidden from
// topology/tables since it's an implementation detail, not something the user created.
export const HOST_BRIDGE = "kathara_host_bridge";

export function visibleInterfaces(machine: MachineDetail): InterfaceModel[] {
  return machine.interfaces.filter((i) => i.link !== HOST_BRIDGE);
}

// Hides Kathara's own internal collision domain from any list of links the user might see.
export function visibleLinks<T extends { name: string }>(links: T[]): T[] {
  return links.filter((l) => l.name !== HOST_BRIDGE);
}
