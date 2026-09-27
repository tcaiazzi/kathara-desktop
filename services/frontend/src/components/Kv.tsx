import type { ReactNode } from "react";

// Two-column key/value row used throughout the Inspector panel (TopologyGraph and
// DeviceInfoTabs).
export function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}
