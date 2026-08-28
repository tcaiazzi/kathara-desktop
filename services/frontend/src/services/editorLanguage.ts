// Single source of truth for the code editor's per-file language and the lab.conf vocabulary shared
// by the syntax highlighter, autocomplete, and linter.
//
// The lab.conf rules here MIRROR the backend parser `src/kathara_api/services/lab_import.py`
// (CONF_LINE_RE, the recognized-option set, RESERVED_NAMES, LAB_META_KEYS). Keep them in sync: if
// the backend adds/removes a recognized option, update OPTION_KEYWORDS/MAPPED_OPTION_SET here too.
// If the backend ever relaxes CONF_LINE_RE (e.g. to allow quotes inside a value), this file's
// CONF_LINE_RE below must change in the same commit — the client linter would otherwise hard-error
// on lines the backend accepts, blocking legitimate saves.

export type EditorLanguage = "labconf" | "shell" | "plaintext";

// Pick a language from a path. Uses the basename so it also works for absolute runtime-FS paths
// (e.g. "/etc/frr/frr.conf"). Mirrors LabExplorer's own file-kind conventions (STARTUP_RE, fileIcon).
export function languageForPath(path: string | null | undefined): EditorLanguage {
  if (!path) return "plaintext";
  const base = path.split("/").pop() ?? path;
  if (base === "lab.conf" || base === "lab.ext" || base === "lab.dep") return "labconf";
  if (/\.(startup|shutdown|sh)$/.test(base)) return "shell";
  return "plaintext";
}

// lab.conf machine option keywords (the `machine[<option>]=value` form), split by how the backend
// treats them. `num_terms` is validated separately by the linter (int-or-warning) so it is listed
// here but not part of MAPPED_OPTION_SET's generic value-validation path.
export const MAPPED_OPTIONS = [
  "image",
  "mem",
  "cpus",
  "cpu",
  "ipv6",
  "shell",
  "privileged",
  "exec",
  "port",
  "sysctl",
  "env",
  "ulimit",
  "bridged",
  "entrypoint",
  "args",
] as const;

// Parsed but never applied to the model (kept in lab.conf, not interpreted) — see
// lab_import._apply_conf_option's `volume` branch.
export const PASSTHROUGH_OPTIONS = ["volume"] as const;

export const OPTION_KEYWORDS = [...MAPPED_OPTIONS, "num_terms", ...PASSTHROUGH_OPTIONS] as const;

export const MAPPED_OPTION_SET = new Set<string>(MAPPED_OPTIONS);

// Global lab.conf metadata directives (no brackets), form LAB_KEY="value".
export const LAB_GLOBALS = [
  "LAB_NAME",
  "LAB_DESCRIPTION",
  "LAB_VERSION",
  "LAB_AUTHOR",
  "LAB_EMAIL",
  "LAB_WEB",
] as const;

export const LAB_GLOBAL_SET = new Set<string>(LAB_GLOBALS);

// Names that cannot be used as a device name (matches Kathara's RESERVED_MACHINE_NAMES).
export const RESERVED_MACHINE_NAMES = new Set<string>(["shared", "_test"]);

// The canonical lab.conf directive line, identical to the backend `CONF_LINE_RE`:
//   machine[arg]=value  (value optionally quoted, optional trailing " # comment")
export const CONF_LINE_RE = /^([a-z0-9_]{1,30})\[(\w+)\]=(["']?)([^"']+)\3(\s+#.*)?$/;

// Known Kathara official Docker images, offered as image-value completions. Kept aligned with the
// EXACT map in `deviceIcon.ts` (the Kathara Docker-Images set); curated to the current image names
// (dropping deprecated aliases).
export const KATHARA_IMAGES = [
  "kathara/base",
  "kathara/frr",
  "kathara/quagga",
  "kathara/bird",
  "kathara/openbgpd",
  "kathara/scion",
  "kathara/rift-python",
  "kathara/openvswitch",
  "kathara/sdn",
  "kathara/bmv2",
  "kathara/p4",
  "kathara/pox",
  "kathara/apache",
  "kathara/bind",
  "kathara/dnsmasq",
  "kathara/krill",
  "kathara/routinator",
  "kathara/rpki-client",
];
