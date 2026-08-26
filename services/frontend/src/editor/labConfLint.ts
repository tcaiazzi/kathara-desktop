// Client-side linter for lab.conf. Mirrors the backend parser `lab_import.py` (parse_lab_conf +
// _apply_conf_option + the sequential-interface check) so the diagnostics shown here match what
// `PUT /api/labs/{lab}/lab-conf` will accept. Runs instantly, no network.
//
// The binding rule for severity: if the backend appends to its `errors` list (rejecting the
// import/save), this linter must show an error; if the backend only warns (accepts, but the
// option is preserved-not-applied or not interpreted), this linter shows a warning, never an
// error — a client-side error the backend would accept blocks a legitimate save.

import { linter, type Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { CONF_LINE_RE, LAB_GLOBAL_SET, MAPPED_OPTION_SET, RESERVED_MACHINE_NAMES } from "../services/editorLanguage";

// A top-level `KEY=value` line that isn't a recognized LAB_* key — mirrors the backend's
// `TOP_LEVEL_KEY_RE` (lab_import.py): preserved and warned about, not fatal.
const TOP_LEVEL_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function stripQuotes(value: string): string {
  return value.replace(/["']/g, "");
}

function portOk(value: string): boolean {
  let ports = value;
  let proto = "tcp";
  if (value.includes("/")) [ports, proto] = [value.slice(0, value.indexOf("/")), value.slice(value.indexOf("/") + 1)];
  proto = (proto || "tcp").toLowerCase();
  if (!["tcp", "udp", "sctp"].includes(proto)) return false;
  let host = "3000";
  let guest = ports;
  if (ports.includes(":")) [host, guest] = [ports.slice(0, ports.indexOf(":")), ports.slice(ports.indexOf(":") + 1)];
  return /^\d+$/.test(host.trim()) && /^\d+$/.test(guest.trim());
}

// Validate an option's value; returns an error message or null (matches _apply_conf_option). Bool
// options (ipv6/privileged/bridged) are never errors — the backend silently ignores unparseable ones.
function optionError(opt: string, value: string): string | null {
  switch (opt) {
    case "cpus":
    case "cpu":
      return value.trim() !== "" && !Number.isNaN(Number(value)) ? null : `invalid cpus "${value}"`;
    case "port":
      return portOk(value) ? null : `invalid port "${value}"`;
    case "sysctl": {
      const i = value.indexOf("=");
      const k = i >= 0 ? value.slice(0, i) : "";
      return i > 0 && /^net\.([\w-]+\.)+[\w-]+$/.test(k) ? null : `invalid sysctl "${value}" (must be net.*=value)`;
    }
    case "env":
      return value.indexOf("=") > 0 ? null : `invalid env "${value}"`;
    case "ulimit":
      return /^(\w+)=(-?\d+)(?::(-?\d+))?$/.test(value) ? null : `invalid ulimit "${value}"`;
    default:
      return null;
  }
}

function computeDiagnostics(view: EditorView): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const doc = view.state.doc;
  // Per machine: interface numbers with the line they appear on (for the sequential check).
  const ifaces: Record<string, { num: number; from: number; to: number }[]> = {};

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text.trim();
    if (!text || text.startsWith("#")) continue;

    const push = (message: string, severity: "error" | "warning" = "error") =>
      diagnostics.push({ from: line.from, to: line.to, severity, message });

    const m = CONF_LINE_RE.exec(text);
    if (m) {
      const name = m[1];
      const arg = m[2];
      const value = stripQuotes(m[4]);
      if (RESERVED_MACHINE_NAMES.has(name)) {
        push(`"${name}" is a reserved name`);
        continue;
      }
      if (/^\d+$/.test(arg)) {
        let cd = value;
        if (value.includes("/")) {
          const parts = value.split("/").filter(Boolean);
          if (parts.length !== 2) {
            push(`invalid interface "${value}"`);
            continue;
          }
          cd = parts[0];
        }
        if (!/^\w+$/.test(cd)) {
          push(`invalid collision domain "${cd}"`);
          continue;
        }
        (ifaces[name] ??= []).push({ num: Number(arg), from: line.from, to: line.to });
      } else if (arg === "num_terms") {
        // Backend: a non-integer num_terms is a warning (kept, not applied), never fatal.
        if (!/^\d+$/.test(value.trim())) push(`invalid num_terms "${value}"`, "warning");
      } else if (MAPPED_OPTION_SET.has(arg)) {
        const err = optionError(arg, value);
        if (err) push(err);
      } else if (arg === "volume") {
        push(`${name}[volume] — host volumes aren't applied by the API (kept in lab.conf)`, "warning");
      } else {
        push(`meta "${arg}" not recognized`, "warning");
      }
    } else {
      const eq = text.indexOf("=");
      const key = eq >= 0 ? text.slice(0, eq).trim() : text;
      if (eq > 0 && LAB_GLOBAL_SET.has(key)) {
        // recognized LAB_* metadata — silent
      } else if (eq > 0 && TOP_LEVEL_KEY_RE.test(key)) {
        push(`unknown lab.conf key "${key}" — kept as-is, not applied`, "warning");
      } else {
        push(`cannot parse "${text}"`);
      }
    }
  }

  // Interface numbers must be sequential from 0 per machine.
  for (const [name, entries] of Object.entries(ifaces)) {
    const sorted = [...entries].sort((a, b) => a.num - b.num);
    sorted.forEach((entry, expected) => {
      if (entry.num !== expected) {
        diagnostics.push({
          from: entry.from,
          to: entry.to,
          severity: "error",
          message: `${name}: non-sequential interface numbers (expected eth${expected}, got eth${entry.num})`,
        });
      }
    });
  }

  return diagnostics;
}

export const labConfLinter = linter(computeDiagnostics);
