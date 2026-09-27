import { Check, Columns2, Palette, Plus, Rows2, SquareArrowOutUpRight, SquareTerminal, Trash2, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Button, ButtonGroup, Dropdown, Form } from "react-bootstrap";
import { createPortal } from "react-dom";
import {
  useTerminalSessions,
  type TerminalSessionEntry,
  type TerminalStatus,
} from "../context/TerminalSessionsContext";
import { useWorkspace } from "../context/WorkspaceContext";
import { useElementSize } from "../hooks/useElementSize";
import { useElementSlot } from "../hooks/useTerminalSlot";
import { useTerminalPaneDrop } from "../hooks/useTerminalPaneDrop";
import { useTerminalTheme } from "../hooks/useTerminalTheme";
import {
  clampListWidth,
  storedListWidth,
  terminalTitle,
} from "../services/terminalSessions";
import {
  groupOf,
  leafIds,
  panePlace,
  resizePair,
  type PanePlace,
  type SplitDirection,
  type SplitNode,
} from "../services/terminalSplits";
import { TERMINAL_THEMES, type TerminalThemeId } from "../services/terminalTheme";
import { TerminalSlot } from "./TerminalSlot";
import "./TerminalPanel.css";

// The Terminals tab: the workspace's terminals in one dock panel, the way an IDE's terminal panel
// holds them. Terminals come in split groups (services/terminalSplits): the list on the right names
// every terminal, grouped, and the area on the left shows the group of the one selected, its panes
// side by side or stacked, with dividers to resize them. The sessions themselves live in the
// registry (TerminalSessionsContext), so switching, splitting or resizing only moves host elements:
// nothing reconnects and no scrollback is lost. Too narrow for the list, the tab trades it for a bar
// with a dropdown of the same terminals.
//
// A list row or a pane's header dragged out onto the dock detaches its terminal into a panel of its
// own wherever it is dropped (the drop itself is handled by the workspace page's dockview
// listeners); their context menu does the same beside this tab.

// The list gives way to the compact bar once the tab cannot leave the terminal beside it at least
// this wide: less, and the terminal is narrower than the list's own column of names is worth.
const MIN_TERMINAL_BESIDE_LIST = 340;

// The list's width, remembered per viewer: a convenience, so storage that is missing, full or
// blocked (a private window) just means the initial width.
const LS_LIST_WIDTH = "kt-terms-list-width";

function readListWidth(): number {
  try {
    return storedListWidth(localStorage.getItem(LS_LIST_WIDTH));
  } catch {
    return storedListWidth(null);
  }
}

// The icon size of the tab's own controls: the list's head and rows, and the compact bar.
const TOOL_ICON = 16;

// The list's dot and its tooltip. A stopped device wins over the socket's own state: an idle
// terminal on a running device can just reconnect, one on a stopped device cannot.
function statusOf(status: TerminalStatus | undefined, running: boolean): { dot: string; label: string } {
  if (status === "connected") return { dot: "running", label: "connected" };
  if (status === "connecting") return { dot: "partial", label: "connecting" };
  return running ? { dot: "stopped", label: "disconnected" } : { dot: "stopped", label: "device stopped" };
}

interface DeviceMenuProps {
  machines: string[];
  onOpen: (machine: string) => void;
  header?: string;
}

// The running devices to open a terminal on, as the menu of the dropdown it is rendered in. It goes
// into document.body rather than into this panel: the dock panel clips its overflow and the empty
// state scrolls, so a menu kept inside is cut off, or pushed wholly off screen, whenever it is taller
// than the room the panel has left. From the body, Popper places it against the window instead, and
// its max height (TerminalPanel.css) always leaves it room on one side of its toggle.
function DeviceMenu({ machines, onOpen, header }: DeviceMenuProps) {
  return createPortal(
    <Dropdown.Menu className="kt-terms-menu">
      {header && <Dropdown.Header>{header}</Dropdown.Header>}
      {machines.map((m) => (
        <Dropdown.Item key={m} onClick={() => onOpen(m)} className="d-flex align-items-center gap-2">
          <SquareTerminal size={14} className="kt-terms-icon" />
          {m}
        </Dropdown.Item>
      ))}
    </Dropdown.Menu>,
    document.body,
  );
}

interface OpenTerminalMenuProps {
  machines: string[];
  onOpen: (machine: string) => void;
}

// The "+": a new terminal, in a group of its own, on one of the running devices.
function OpenTerminalMenu({ machines, onOpen }: OpenTerminalMenuProps) {
  return (
    <Dropdown>
      <Dropdown.Toggle
        size="sm"
        variant="outline-secondary"
        className="kt-terms-tool kt-terms-add"
        disabled={!machines.length}
        title={machines.length ? "New terminal" : "No device is running"}
      >
        <Plus size={TOOL_ICON} />
      </Dropdown.Toggle>
      <DeviceMenu machines={machines} onOpen={onOpen} header="New terminal on" />
    </Dropdown>
  );
}

const SPLITS = {
  row: { label: "Split Right", title: "Split right", Icon: Columns2 },
  column: { label: "Split Down", title: "Split down", Icon: Rows2 },
} as const;

interface SplitMenuProps {
  direction: SplitDirection;
  /** The terminal to split, or null when none is selected. */
  target: TerminalSessionEntry | null;
  machines: string[];
  onSplit: (machine: string) => void;
}

// Splits the selected terminal: the button onto the same device, the caret onto any running one.
function SplitMenu({ direction, target, machines, onSplit }: SplitMenuProps) {
  const { title, Icon } = SPLITS[direction];
  const sameRunning = !!target && machines.includes(target.machine);
  return (
    <Dropdown as={ButtonGroup} className="kt-terms-split">
      <Button
        size="sm"
        variant="outline-secondary"
        disabled={!sameRunning}
        className="kt-terms-tool"
        title={target ? `${title}: another terminal on ${target.machine}` : title}
        onClick={() => target && onSplit(target.machine)}
      >
        <Icon size={TOOL_ICON} />
      </Button>
      <Dropdown.Toggle
        split
        size="sm"
        variant="outline-secondary"
        className="kt-terms-tool kt-terms-caret"
        disabled={!target || !machines.length}
        title={`${title} onto another device`}
      />
      <DeviceMenu machines={machines} onOpen={onSplit} header={`${title} on`} />
    </Dropdown>
  );
}

interface ThemeItemProps {
  id: TerminalThemeId;
  label: string;
  /** The scheme's own colours for its swatch; none for "Match app", whose swatch is the app's. */
  colors?: { background?: string; foreground?: string };
  selected: boolean;
  onPick: (id: TerminalThemeId) => void;
}

function ThemeItem({ id, label, colors, selected, onPick }: ThemeItemProps) {
  return (
    <Dropdown.Item onClick={() => onPick(id)} className="kt-terms-theme-item">
      <span
        className="kt-terms-swatch"
        style={colors && { background: colors.background, color: colors.foreground }}
        aria-hidden
      >
        &gt;_
      </span>
      <span className="flex-grow-1">{label}</span>
      {selected && <Check size={14} aria-label="selected" />}
    </Dropdown.Item>
  );
}

interface TerminalThemeMenuProps {
  className?: string;
}

// The terminals' colour scheme, for every terminal at once (useTerminalTheme). Its menu goes into
// document.body for the reason DeviceMenu's does.
function TerminalThemeMenu({ className }: TerminalThemeMenuProps) {
  const { choice, setChoice } = useTerminalTheme();
  return (
    <Dropdown className={className}>
      <Dropdown.Toggle
        size="sm"
        variant="outline-secondary"
        className="kt-terms-tool kt-terms-bare"
        title="Terminal colours"
      >
        <Palette size={TOOL_ICON} />
      </Dropdown.Toggle>
      {createPortal(
        <Dropdown.Menu className="kt-terms-menu">
          <Dropdown.Header>Terminal colours</Dropdown.Header>
          <ThemeItem id="app" label="Match app theme" selected={choice === "app"} onPick={setChoice} />
          <Dropdown.Divider />
          {TERMINAL_THEMES.map((t) => (
            <ThemeItem
              key={t.id}
              id={t.id}
              label={t.label}
              colors={t.theme}
              selected={choice === t.id}
              onPick={setChoice}
            />
          ))}
        </Dropdown.Menu>,
        document.body,
      )}
    </Dropdown>
  );
}

interface TerminalsEmptyProps {
  machines: string[];
  onOpen: (machine: string) => void;
}

// What the tab shows with no terminal in it: the one thing to do here, as the primary action. With a
// single running device there is nothing to choose, so the button opens straight onto it.
function TerminalsEmpty({ machines, onOpen }: TerminalsEmptyProps) {
  return (
    <div className="kt-terms-empty">
      <SquareTerminal size={36} strokeWidth={1.5} className="kt-terms-empty-icon" />
      <div className="kt-terms-empty-title">No terminals open</div>
      <p className="kt-terms-empty-lead">
        {machines.length
          ? "Open a shell on a running device. Every terminal you open is listed here; split it to work on several side by side, or drag it out into a panel of its own."
          : "Start a device to open a terminal on it."}
      </p>
      {machines.length === 1 ? (
        <Button variant="primary" size="sm" onClick={() => onOpen(machines[0])}>
          <Plus size={15} className="me-1" />
          Open Terminal on {machines[0]}
        </Button>
      ) : (
        machines.length > 1 && (
          <Dropdown>
            <Dropdown.Toggle variant="primary" size="sm">
              <Plus size={15} className="me-1" />
              Open Terminal
            </Dropdown.Toggle>
            <DeviceMenu machines={machines} onOpen={onOpen} />
          </Dropdown>
        )
      )}
    </div>
  );
}

// The compact bar's dropdown cannot draw the list's bracket (an <option> takes no styling), so it
// marks a group's panes with box-drawing characters instead.
const PLACE_GLYPH: Record<PanePlace, string> = { first: "┌", middle: "├", last: "└" };

interface SashProps {
  direction: SplitDirection;
  /** Called as a drag starts, with the sash's element; returns what to do as it moves, given how
   *  far the pointer has gone from where it started, in pixels along `direction`. */
  onStart: (el: HTMLElement) => (deltaPx: number) => void;
  className?: string;
}

// A divider to drag: between two panes of a split, or between the terminals and the list.
function Sash({ direction, onStart, className }: SashProps) {
  const drag = useRef<{ start: number; move: (deltaPx: number) => void } | null>(null);
  const horizontal = direction === "row";
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: horizontal ? e.clientX : e.clientY, move: onStart(e.currentTarget) };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) d.move((horizontal ? e.clientX : e.clientY) - d.start);
  };
  const end = () => {
    drag.current = null;
  };
  return (
    <div
      className={`kt-split-sash kt-split-sash--${direction}${className ? ` ${className}` : ""}`}
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}

interface PaneToolbarSlotProps {
  host: HTMLElement;
}

// Where a pane header shows its session's compact toolbar (TerminalSession renders it there).
function PaneToolbarSlot({ host }: PaneToolbarSlotProps) {
  const ref = useElementSlot(host);
  return <div className="kt-terms-pane-tools" ref={ref} />;
}

export function TerminalsPanel() {
  const ws = useWorkspace();
  const { sessions, groups, activeId, statuses, activate, close, split, place, resize, toolbarHostFor } =
    useTerminalSessions();
  const { ref: sizeRef, width } = useElementSize<HTMLDivElement>();
  const [listWidth, setListWidth] = useState(readListWidth);
  useEffect(() => {
    try {
      localStorage.setItem(LS_LIST_WIDTH, String(listWidth));
    } catch {
      /* not remembered: the next visit starts from the initial width */
    }
  }, [listWidth]);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const running = new Set(ws.detail.machines.filter((m) => m.running).map((m) => m.name));
  const runningNames = [...running];
  const statusFor = (s: TerminalSessionEntry) => statusOf(statuses[s.id], running.has(s.machine));
  const compact = width > 0 && width < listWidth + MIN_TERMINAL_BESIDE_LIST;
  const active = activeId ? (byId.get(activeId) ?? null) : null;
  const shownGroup = activeId ? groupOf(groups, activeId) : undefined;

  const { drop, beginDrag, endDrag, paneDropProps } = useTerminalPaneDrop(place);

  const splitActive = (direction: SplitDirection) => (machine: string) => {
    if (activeId) split(activeId, machine, direction);
  };

  const openSessionMenu = (e: MouseEvent, s: TerminalSessionEntry) => {
    e.preventDefault();
    // Each split opens a submenu of the running devices to put the new terminal on.
    const splitItem = (direction: SplitDirection) => ({
      label: SPLITS[direction].label,
      disabled: !runningNames.length,
      title: runningNames.length ? undefined : "No device is running",
      submenu: runningNames.map((m) => ({ label: m, action: () => split(s.id, m, direction) })),
    });
    ws.setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        splitItem("row"),
        splitItem("column"),
        { label: "Move into New Panel", action: () => ws.moveTerminalToPanel(s.id) },
        { label: "Close Terminal", danger: true, action: () => close(s.id) },
      ],
    });
  };

  if (!groups.length) return <TerminalsEmpty machines={runningNames} onOpen={ws.openTerminal} />;

  const closeButton = (id: string) => (
    <span
      className="kt-terms-close"
      role="button"
      title="Close terminal"
      onClick={(e) => {
        e.stopPropagation();
        close(id);
      }}
    >
      <X size={14} />
    </span>
  );

  // One pane of the shown group. A group of one needs no header: the list already names it.
  const renderPane = (id: string, alone: boolean) => {
    const s = byId.get(id);
    if (!s) return null;
    const status = statusFor(s);
    return (
      // A right click anywhere in the pane, the terminal included, offers the splits, as an IDE's
      // terminal does.
      <div
        className={`kt-terms-pane ${!alone && id === activeId ? "active" : ""}`}
        onPointerDownCapture={() => activate(id)}
        onContextMenu={(e) => openSessionMenu(e, s)}
        {...paneDropProps(id)}
      >
        {!alone && (
          <div className="kt-terms-pane-head">
            {/* The drag starts from the name only: a draggable header would take a press on the
                toolbar's shell dropdown as the start of a drag. */}
            <span
              className="kt-terms-pane-handle"
              draggable
              onDragStart={(e) => beginDrag(e, s)}
              onDragEnd={endDrag}
              title={`${terminalTitle(s)} · ${status.label} · drag onto a terminal to split it, or onto the dock to detach`}
            >
              <SquareTerminal size={14} className="kt-terms-icon" />
              <span className="kt-ws-row-name">{terminalTitle(s)}</span>
            </span>
            <PaneToolbarSlot host={toolbarHostFor(id)} />
            {closeButton(id)}
          </div>
        )}
        <TerminalSlot sessionId={id} />
        {drop?.id === id && <div className={`kt-terms-drop kt-terms-drop--${drop.side}`} aria-hidden />}
      </div>
    );
  };

  const renderNode = (node: SplitNode, groupId: string, path: number[], alone: boolean) => {
    if (node.kind === "leaf") return renderPane(node.id, alone);
    return (
      <div className={`kt-split kt-split--${node.direction}`}>
        {node.children.map((child, i) => (
          <Fragment key={leafIds(child).join(" ")}>
            <div className="kt-split-child" style={{ flexGrow: node.sizes[i] }}>
              {renderNode(child, groupId, [...path, i], false)}
            </div>
            {i < node.children.length - 1 && (
              <Sash
                direction={node.direction}
                onStart={(el) => {
                  const box = el.parentElement?.getBoundingClientRect();
                  const extent = (node.direction === "row" ? box?.width : box?.height) ?? 0;
                  const start = node.sizes;
                  return (deltaPx) => {
                    if (extent) resize(groupId, path, resizePair(start, i, deltaPx / extent));
                  };
                }}
              />
            )}
          </Fragment>
        ))}
      </div>
    );
  };

  const splitButtons = (
    <>
      <SplitMenu direction="row" target={active} machines={runningNames} onSplit={splitActive("row")} />
      <SplitMenu direction="column" target={active} machines={runningNames} onSplit={splitActive("column")} />
    </>
  );

  return (
    <div className="kt-terms" ref={sizeRef}>
      {compact && (
        <div className="kt-terms-bar">
          <Form.Select
            size="sm"
            className="kt-terms-select"
            value={activeId ?? ""}
            onChange={(e) => activate(e.target.value, { focus: true })}
            aria-label="Terminal"
          >
            {groups.map((g) => {
              const ids = leafIds(g.root);
              return ids.map((id, i) => {
                const s = byId.get(id);
                if (!s) return null;
                const place = panePlace(i, ids.length);
                return (
                  <option key={id} value={id}>
                    {place && `${PLACE_GLYPH[place]} `}
                    {terminalTitle(s)} · {statusFor(s).label}
                  </option>
                );
              });
            })}
          </Form.Select>
          <OpenTerminalMenu machines={runningNames} onOpen={ws.openTerminal} />
          {splitButtons}
          <button
            type="button"
            className="kt-terms-tool"
            title="Move this terminal into a new panel"
            disabled={!activeId}
            onClick={() => activeId && ws.moveTerminalToPanel(activeId)}
          >
            <SquareArrowOutUpRight size={TOOL_ICON} />
          </button>
          <button
            type="button"
            className="kt-terms-tool"
            title="Close this terminal"
            disabled={!activeId}
            onClick={() => activeId && close(activeId)}
          >
            <X size={TOOL_ICON} />
          </button>
          <TerminalThemeMenu />
          <button type="button" className="kt-terms-tool" title="Close all terminals" onClick={ws.closeAllTerminals}>
            <Trash2 size={TOOL_ICON} />
          </button>
        </div>
      )}
      <div className="kt-terms-body">
        <div className="kt-terms-main">
          {shownGroup && renderNode(shownGroup.root, shownGroup.id, [], shownGroup.root.kind === "leaf")}
        </div>
        {!compact && (
          <Sash
            direction="row"
            className="kt-terms-list-sash"
            onStart={() => {
              const start = listWidth;
              // The list is on the right, so dragging its edge leftwards widens it.
              return (deltaPx) => setListWidth(clampListWidth(start - deltaPx));
            }}
          />
        )}
        {!compact && (
          <aside className="kt-terms-list" aria-label="Open terminals" style={{ flexBasis: listWidth }}>
            <div className="kt-terms-head">
              <OpenTerminalMenu machines={runningNames} onOpen={ws.openTerminal} />
              {splitButtons}
              <TerminalThemeMenu className="kt-terms-head-end" />
              <button
                type="button"
                className="kt-terms-tool"
                title="Close all terminals"
                onClick={ws.closeAllTerminals}
              >
                <Trash2 size={TOOL_ICON} />
              </button>
            </div>
            <div className="kt-ws-list">
              {groups.map((g) => {
                const ids = leafIds(g.root);
                const shown = g === shownGroup;
                return ids.map((id, i) => {
                  const s = byId.get(id);
                  if (!s) return null;
                  const status = statusFor(s);
                  const place = panePlace(i, ids.length);
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`kt-ws-row kt-terms-row ${id === activeId ? "active" : ""} ${shown ? "shown" : ""} ${place ? "grouped" : ""}`}
                      onClick={() => activate(id, { focus: true })}
                      // A middle click closes, as it does a browser's or an editor's tab; its press
                      // must not start the browser's autoscroll first.
                      onMouseDown={(e) => {
                        if (e.button === 1) e.preventDefault();
                      }}
                      onAuxClick={(e) => {
                        if (e.button === 1) close(id);
                      }}
                      onContextMenu={(e) => openSessionMenu(e, s)}
                      draggable
                      onDragStart={(e) => beginDrag(e, s)}
                      onDragEnd={endDrag}
                      title={`${terminalTitle(s)} · ${status.label} · drag onto a terminal to split it, or onto the dock to detach`}
                    >
                      {place && <span className={`kt-terms-tree ${place}`} aria-hidden />}
                      <SquareTerminal size={TOOL_ICON} className="kt-terms-icon" />
                      <span className="kt-ws-row-name">{terminalTitle(s)}</span>
                      <span className={`kt-ws-dot ${status.dot}`} />
                      {closeButton(id)}
                    </button>
                  );
                });
              })}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
