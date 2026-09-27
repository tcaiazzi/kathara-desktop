import type { InterfaceModel, MachineDetail } from "./types";

// The project's own docs site — the one external link the app offers from its Help menu and its
// welcome screen. Kept as one constant so the two surfaces can never say something different;
// services/desktop/src/menu.ts has its own copy (the main process shares no module graph with
// the renderer), which must be kept in step by hand if this ever changes.
export const DOCS_URL = "https://www.kathara.org/";

// Where a bug is reported: the Help menu and the error screen both open it. The repo pyproject.toml
// lists under "Bug Reports" — the canonical upstream, not the fork updateCheck.ts polls for releases
// (see that file's own comment on the difference). Same by-hand copy in services/desktop/src/menu.ts
// as DOCS_URL above, and in setup.html, which has no module to import.
export const ISSUES_URL = "https://github.com/KatharaFramework/kathara-desktop/issues/new";

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

// The names of the collision domains the user can pick from, alphabetically.
export function domainNames(links: { name: string }[]): string[] {
  return visibleLinks(links)
    .map((l) => l.name)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}
