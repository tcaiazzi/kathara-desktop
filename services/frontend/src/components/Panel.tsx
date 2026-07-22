import type { ReactNode } from "react";

interface PanelProps {
  title: ReactNode;
  headerExtra?: ReactNode;
  className?: string;
  children: ReactNode;
}

// Shared `.card`/`.card-body` wrapper. When `headerExtra` is given, the title moves into a flex
// row alongside it (e.g. Stats' Start/Stop button); without it, a plain `.card-title` is used so
// Bootstrap's default heading margin isn't stripped from panels that don't need a header row.
export function Panel({ title, headerExtra, className, children }: PanelProps) {
  return (
    <div className={`card${className ? ` ${className}` : ""}`}>
      <div className="card-body">
        {headerExtra ? (
          <div className="d-flex align-items-center gap-2 mb-2">
            <h5 className="card-title mb-0">{title}</h5>
            <div className="ms-auto">{headerExtra}</div>
          </div>
        ) : (
          <h5 className="card-title">{title}</h5>
        )}
        {children}
      </div>
    </div>
  );
}
