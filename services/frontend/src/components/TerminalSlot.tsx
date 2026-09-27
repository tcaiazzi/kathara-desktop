import { useTerminalSlot } from "../hooks/useTerminalSlot";
import "./TerminalPanel.css";

interface TerminalSlotProps {
  sessionId: string;
}

// A place that shows one terminal session: the session's host element sits in here for as long as
// this is mounted (hooks/useTerminalSlot). Fills its parent.
export function TerminalSlot({ sessionId }: TerminalSlotProps) {
  const slotRef = useTerminalSlot(sessionId);
  return <div className="kt-term-slot" ref={slotRef} />;
}
