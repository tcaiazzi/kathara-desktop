// Single source of truth for the code editor's per-file language and the lab.conf vocabulary shared
// by the syntax highlighter, autocomplete, and linter.
//
// The option vocabulary here MIRRORS `src/kathara_api/lab_conf_options.py` (INTERPRETED_OPTIONS),
// which is the single source of truth for every `machine[key]=value` name this API models: add or
// remove one there and OPTION_KEYWORDS/MAPPED_OPTION_SET below change in the same commit.
// tests/unit/test_lab_conf_options.py reads this file and fails when the two disagree.
//
// The syntax and name rules mirror the parser in `src/kathara_api/services/lab_import.py`
// (CONF_LINE_RE, RESERVED_NAMES, LAB_META_KEYS), which nothing checks automatically. If the backend
// relaxes CONF_LINE_RE (e.g. to allow quotes inside a value), this file's CONF_LINE_RE below must
// change in the same commit — the client linter would otherwise hard-error on lines the backend
// accepts, blocking legitimate saves.

export type EditorLanguage = "labconf" | "shell" | "plaintext";

// Pick a language from a path. Uses the basename so it also works for absolute runtime-FS paths
// (e.g. "/etc/frr/frr.conf"). Mirrors the extension buckets of `fileIcon` (services/labfs.ts);
// LabExplorer's own `isStartupFilePath` is narrower, matching only a lab-root `.startup`.
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
//
// Both lists have a consumer no TypeScript tool can see: tests/unit/test_lab_conf_options.py reads
// this file as text and matches `export const <NAME> = [...]`, to assert the editor and the parser
// agree on the option set. Keep the `export` and the literal-array form even if nothing in the
// frontend imports them — a rename or a reshape here fails in the *Python* suite.
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

// Recognized, and applied to the model (see lab_import._parse_volume) — but not run through the
// lint's generic optionError value-check like MAPPED_OPTIONS are, because only *half* of the
// backend's validation is reproducible here. The arity check (2 or 3 `|`-separated fields) is
// OS-independent and labConfRules does apply it; the absolute-host-path check depends on the
// backend's own `os.path.isabs`, which a browser cannot know, so that half is left to the backend.
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
