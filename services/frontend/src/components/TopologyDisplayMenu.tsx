import { Fragment, useId } from "react";
import { Button, ButtonGroup, Dropdown, Form } from "react-bootstrap";
import { Minus, Plus, Settings2 } from "lucide-react";
import {
  canStep,
  DEFAULT_TOPO_DISPLAY,
  formatLineWidth,
  formatScale,
  LINE_STEPS,
  SCALE_STEPS,
  stepValue,
  type Steps,
  type TopoDisplay,
  type TopoLayout,
} from "../services/topologyDisplay";
import type { LayeredDirection } from "../services/topologyLayout";

const LAYOUT_LABELS: Record<TopoLayout, string> = {
  force: "Force-directed",
  layered: "Hierarchical",
  grouped: "Grouped by name",
};

const DIRECTION_LABELS: Record<LayeredDirection, string> = {
  tb: "Top to bottom",
  lr: "Left to right",
};

interface TopologyDisplayMenuProps {
  value: TopoDisplay;
  onChange: (next: TopoDisplay) => void;
  // A narrow canvas: the toggle shows only its icon.
  compact: boolean;
}

interface StepperProps {
  label: string;
  value: number;
  steps: Steps;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

// A − value + row. The value is a live region, so a screen reader announces each step. At the end
// of the range a button is only marked disabled, not `disabled`: a button that disables itself
// under the keyboard focus drops the focus out of the menu, and Escape no longer closes it.
function Stepper({ label, value, steps, format, onChange }: StepperProps) {
  const id = useId();
  const stepButton = (dir: 1 | -1) => {
    const can = canStep(value, steps, dir);
    return (
      <Button
        variant="outline-secondary"
        className={can ? undefined : "kt-step-end"}
        aria-label={`${dir > 0 ? "Increase" : "Decrease"} ${label.toLowerCase()}`}
        aria-disabled={!can}
        onClick={() => {
          if (can) onChange(stepValue(value, steps, dir));
        }}
      >
        {dir > 0 ? <Plus size={14} aria-hidden /> : <Minus size={14} aria-hidden />}
      </Button>
    );
  };
  return (
    <div className="kt-topo-display-row">
      <span id={id}>{label}</span>
      <ButtonGroup size="sm" aria-labelledby={id}>
        {stepButton(-1)}
        <span className="kt-topo-display-value" aria-live="polite">
          {format(value)}
        </span>
        {stepButton(1)}
      </ButtonGroup>
    </div>
  );
}

// The topology canvas's Display panel: the layout, which labels show, and the accessibility
// options (size, line thickness, high contrast). It holds no state — the graph owns the value and
// persists it (services/topologyDisplay.ts).
export function TopologyDisplayMenu({ value, onChange, compact }: TopologyDisplayMenuProps) {
  const id = useId();
  const set = <K extends keyof TopoDisplay>(key: K, v: TopoDisplay[K]) => onChange({ ...value, [key]: v });
  const isDefault = (Object.keys(DEFAULT_TOPO_DISPLAY) as (keyof TopoDisplay)[]).every(
    (key) => key === "legendCollapsed" || value[key] === DEFAULT_TOPO_DISPLAY[key],
  );

  return (
    // Clicks inside the menu keep it open, so several options can be changed in a row.
    <Dropdown autoClose="outside" align="end">
      <Dropdown.Toggle
        size="sm"
        variant="outline-secondary"
        aria-label="Display options"
        title="Layout, labels, size, line thickness and contrast of the graph"
        className="d-inline-flex align-items-center gap-1"
      >
        <Settings2 size={16} aria-hidden />
        {!compact && "Display"}
      </Dropdown.Toggle>
      <Dropdown.Menu className="kt-topo-display-menu">
        <Dropdown.Header>Layout</Dropdown.Header>
        <div className="kt-topo-display-body" role="radiogroup" aria-label="Layout">
          {(Object.keys(LAYOUT_LABELS) as TopoLayout[]).map((layout) => (
            <Fragment key={layout}>
              <Form.Check
                type="radio"
                name={`${id}-layout`}
                id={`${id}-layout-${layout}`}
                label={LAYOUT_LABELS[layout]}
                checked={value.layout === layout}
                onChange={() => set("layout", layout)}
              />
              {layout === "layered" && value.layout === "layered" && (
                <div className="kt-topo-display-sub" role="radiogroup" aria-label="Direction">
                  {(Object.keys(DIRECTION_LABELS) as LayeredDirection[]).map((dir) => (
                    <Form.Check
                      key={dir}
                      type="radio"
                      name={`${id}-direction`}
                      id={`${id}-direction-${dir}`}
                      label={DIRECTION_LABELS[dir]}
                      checked={value.layeredDirection === dir}
                      onChange={() => set("layeredDirection", dir)}
                    />
                  ))}
                </div>
              )}
            </Fragment>
          ))}
          <Form.Check
            type="switch"
            id={`${id}-collapse-p2p`}
            label="Collapse point-to-point domains"
            title="Draw a domain joining exactly two devices as a straight link between them"
            checked={value.collapseP2p}
            onChange={(e) => set("collapseP2p", e.target.checked)}
          />
        </div>
        <Dropdown.Divider />
        <Dropdown.Header>Labels</Dropdown.Header>
        <div className="kt-topo-display-body">
          <Form.Check
            type="switch"
            id={`${id}-ips`}
            label="Show IP addresses"
            checked={value.ips}
            onChange={(e) => set("ips", e.target.checked)}
          />
          <Form.Check
            type="switch"
            id={`${id}-macs`}
            label="Show MAC addresses"
            checked={value.macs}
            onChange={(e) => set("macs", e.target.checked)}
          />
          <Form.Check
            type="switch"
            id={`${id}-cd-names`}
            label="Show collision domain names"
            checked={value.cdNames}
            onChange={(e) => set("cdNames", e.target.checked)}
          />
        </div>
        <Dropdown.Divider />
        <Dropdown.Header>Accessibility</Dropdown.Header>
        <div className="kt-topo-display-body">
          <Stepper
            label="Size"
            value={value.scale}
            steps={SCALE_STEPS}
            format={formatScale}
            onChange={(v) => set("scale", v)}
          />
          <Stepper
            label="Line thickness"
            value={value.lineWidth}
            steps={LINE_STEPS}
            format={formatLineWidth}
            onChange={(v) => set("lineWidth", v)}
          />
          <Form.Check
            type="switch"
            id={`${id}-contrast`}
            label="High contrast"
            checked={value.highContrast}
            onChange={(e) => set("highContrast", e.target.checked)}
          />
        </div>
        <Dropdown.Divider />
        <div className="kt-topo-display-body">
          <Button
            size="sm"
            variant="link"
            className="p-0"
            disabled={isDefault}
            onClick={() => onChange({ ...DEFAULT_TOPO_DISPLAY, legendCollapsed: value.legendCollapsed })}
          >
            Reset to defaults
          </Button>
        </div>
      </Dropdown.Menu>
    </Dropdown>
  );
}
