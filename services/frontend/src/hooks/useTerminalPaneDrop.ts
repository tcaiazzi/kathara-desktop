import { useRef, useState, type DragEvent } from "react";
import type { TerminalSessionEntry } from "../context/TerminalSessionsContext";
import { TERMINAL_DRAG_TYPE, TERMINAL_DROP_TARGET_ATTR, terminalTitle } from "../services/terminalSessions";
import { dropSide, type DropSide } from "../services/terminalSplits";

// Dragging a terminal of the Terminals tab, by its list row or its pane header: dropped on a pane of
// the tab it splits that pane, the terminal going against the edge it was dropped at; dropped on the
// dock it detaches there, which the workspace page's dockview listeners handle. The dock shows no
// overlay of its own over a pane (TERMINAL_DROP_TARGET_ATTR), so the two never both claim a drop.

/** Where a dragged terminal would go if dropped now: against `side` of the pane showing `id`. */
interface PaneDrop {
  id: string;
  side: DropSide;
}

export function useTerminalPaneDrop(place: (sourceId: string, targetId: string, side: DropSide) => void) {
  // The drag's own data cannot be read until the drop, so the source is kept from its dragstart: a
  // pane shows no drop zone for the terminal it already holds.
  const dragging = useRef<string | null>(null);
  const [drop, setDrop] = useState<PaneDrop | null>(null);

  /** For a row's or a pane header's onDragStart. */
  const beginDrag = (e: DragEvent, session: TerminalSessionEntry) => {
    e.dataTransfer.setData(TERMINAL_DRAG_TYPE, session.id);
    // The app-wide react-dnd HTML5 backend (App.tsx) cancels any drag that carries no type it knows
    // as native, which ours alone is not; a plain-text copy of the name lets the drag go ahead, as
    // dockview does for its own tab drags.
    e.dataTransfer.setData("text/plain", terminalTitle(session));
    e.dataTransfer.effectAllowed = "move";
    dragging.current = session.id;
  };

  /** For the same element's onDragEnd, which fires wherever the drag ended, or if it was cancelled. */
  const endDrag = () => {
    dragging.current = null;
    setDrop(null);
  };

  const sideAt = (e: DragEvent<HTMLElement>): DropSide => {
    const r = e.currentTarget.getBoundingClientRect();
    return dropSide(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  };

  /** Spread onto the pane showing `id`. */
  const paneDropProps = (id: string) => ({
    [TERMINAL_DROP_TARGET_ATTR]: "",
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      const source = dragging.current;
      if (!source || source === id || !e.dataTransfer.types.includes(TERMINAL_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const side = sideAt(e);
      setDrop((prev) => (prev?.id === id && prev.side === side ? prev : { id, side }));
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      // Moving onto a child of the pane is not leaving it.
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      setDrop((prev) => (prev?.id === id ? null : prev));
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      const source = e.dataTransfer.getData(TERMINAL_DRAG_TYPE);
      if (!source || source === id) return;
      e.preventDefault();
      const side = sideAt(e);
      endDrag();
      place(source, id, side);
    },
  });

  return { drop, beginDrag, endDrag, paneDropProps };
}
