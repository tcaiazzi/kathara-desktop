// Single source of truth for the code editor's per-file language and the lab.conf vocabulary shared
// by the syntax highlighter, autocomplete, and linter.
//
// The lab.conf rules here MIRROR the backend parser `src/kathara_api/services/lab_import.py`
// (CONF_LINE_RE, the recognized-option set, RESERVED_NAMES, LAB_META_KEYS). Keep them in sync: if
// the backend adds/removes a recognized option, update OPTION_KEYWORDS here too.

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

// lab.conf machine option keywords (the `machine[<option>]=value` form). The first group is what the
// IDE backend parser maps into the model; num_terms/entrypoint/args are valid in Kathara itself and
// `volume` parses (though it's dropped over REST) — all treated as valid here so the linter doesn't
// flag them as "unknown option" false positives.
export const OPTION_KEYWORDS = [
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
  "volume",
  "num_terms",
  "entrypoint",
  "args",
] as const;

export const OPTION_KEYWORD_SET = new Set<string>(OPTION_KEYWORDS);

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
