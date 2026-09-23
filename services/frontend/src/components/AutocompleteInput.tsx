import { Fragment, useEffect, useRef, useState } from "react";
import { Form } from "react-bootstrap";
import "./AutocompleteInput.css";

/** A headed group of suggestions, for fields whose options come from more than one source. */
export interface AutocompleteSection {
  label: string;
  options: string[];
}

interface AutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Either a plain list of suggestions, or sections rendered under a header each. */
  options: string[] | AutocompleteSection[];
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "lg";
  required?: boolean;
  "aria-label"?: string;
}

// Suggestions shown at once (closest matches first, by index in `options`). A cap rather than a
// prop because no field needs a different one, and one of them — the host's sysctl names — can
// number in the thousands, so rendering them all would be the only case that mattered. Counted
// across all sections, so one long section can't push a later one out of view entirely.
const MAX_SUGGESTIONS = 50;

function asSections(options: string[] | AutocompleteSection[]): AutocompleteSection[] {
  // A flat list becomes the one anonymous section, so there is a single rendering path. Empty is
  // ambiguous between the two shapes and means "nothing to suggest" either way.
  if (options.length === 0) return [];
  if (typeof options[0] === "string") return [{ label: "", options: options as string[] }];
  return options as AutocompleteSection[];
}

// Free-text input with a custom-rendered suggestion dropdown — a styleable stand-in for a plain
// <input list="…"> + <datalist> (see AutocompleteInput.css for why). Nothing here restricts the
// value to one of `options`; picking a suggestion is just a shortcut for typing it.
export function AutocompleteInput({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  size,
  required,
  "aria-label": ariaLabel,
}: AutocompleteInputProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const query = value.trim().toLowerCase();
  // Flattened, because arrow keys and the highlight index run across section boundaries: each
  // entry carries the header to draw above it, set only on the first survivor of its section so
  // a section filtered down to nothing leaves no orphan heading behind.
  const allMatches: { option: string; header: string | null }[] = [];
  for (const section of asSections(options)) {
    const hits = query ? section.options.filter((o) => o.toLowerCase().includes(query)) : section.options;
    hits.forEach((option, i) => allMatches.push({ option, header: i === 0 ? section.label : null }));
  }
  const matches = allMatches.slice(0, MAX_SUGGESTIONS);

  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, []);

  function pick(opt: string) {
    onChange(opt);
    setOpen(false);
  }

  return (
    <div className="kt-autocomplete" ref={rootRef}>
      <Form.Control
        size={size}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            if (matches[highlight]) {
              e.preventDefault();
              pick(matches[highlight].option);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && !disabled && matches.length > 0 && (
        <div className="kt-autocomplete-menu">
          {matches.map(({ option, header }, i) => (
            <Fragment key={`${i}-${option}`}>
              {header && <div className="kt-autocomplete-section">{header}</div>}
              <button
                type="button"
                className={`kt-autocomplete-item${i === highlight ? " active" : ""}`}
                // Prevents the input's blur (which would close the menu) from firing before onClick.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(option)}
                onMouseEnter={() => setHighlight(i)}
              >
                {option}
              </button>
            </Fragment>
          ))}
          {allMatches.length > matches.length && (
            <div className="kt-autocomplete-more">
              +{allMatches.length - matches.length} more — keep typing to narrow it down
            </div>
          )}
        </div>
      )}
    </div>
  );
}
