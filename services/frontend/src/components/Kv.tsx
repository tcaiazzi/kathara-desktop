import type { ReactNode } from "react";

interface KvProps {
  k: string;
  v: ReactNode;
}

// Two-column key/value row used throughout the Inspector panel (TopologyGraph and
// DeviceInfoTabs).
export function Kv({ k, v }: KvProps) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}
