import { useEffect, useRef, useState } from "react";
import { Form } from "react-bootstrap";
import "./AutocompleteInput.css";

interface AutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "lg";
  id?: string;
  required?: boolean;
  className?: string;
  "aria-label"?: string;
  // Suggestions are capped to this many entries (closest matches first, by index in `options`) —
  // matters for a field like sysctl names, which can number in the thousands.
  maxSuggestions?: number;
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
  id,
  required,
  className,
  "aria-label": ariaLabel,
  maxSuggestions = 50,
}: AutocompleteInputProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const query = value.trim().toLowerCase();
  const allMatches = query ? options.filter((o) => o.toLowerCase().includes(query)) : options;
  const matches = allMatches.slice(0, maxSuggestions);

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
        id={id}
        size={size}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        className={className}
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
              pick(matches[highlight]);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && !disabled && matches.length > 0 && (
        <div className="kt-autocomplete-menu">
          {matches.map((opt, i) => (
            <button
              type="button"
              key={opt}
              className={`kt-autocomplete-item${i === highlight ? " active" : ""}`}
              // Prevents the input's blur (which would close the menu) from firing before onClick.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(opt)}
              onMouseEnter={() => setHighlight(i)}
            >
              {opt}
            </button>
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
