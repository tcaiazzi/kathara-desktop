// Single source of truth, on this side, for the rules the backend enforces on names and values a
// user types into a form: lab, device and collision-domain names, MAC addresses and `mem`. Every
// form validates with these functions rather than its own regex, so a field is flagged while it is
// being typed with the same rule the server applies on submit.
//
// Each rule MIRRORS the backend: lab names `lab_store.LAB_NAME_RE` + `sanitize_lab_name`, the rest
// `lab_conf_options.py` (DEVICE_NAME_CHARS, COLLISION_DOMAIN_PATTERN, MEM_PATTERN,
// MAC_ADDRESS_PATTERN) and `lab_import.RESERVED_NAMES`. The messages state the same rule as
// `errors.PATTERN_MESSAGES`, so the inline hint and a server-side refusal agree.
//
// Every validator takes the value as typed and returns the message to show, or null when it is
// valid. An empty value is valid here: whether a field may be left empty is the form's decision.

// The device-name grammar as a fragment, for the lab.conf patterns that embed it (editorLanguage.ts,
// labConfLanguage.ts).
export const DEVICE_NAME_CHARS = "[a-z0-9_]{1,30}";

// Names that cannot be used as a device name (Kathara's RESERVED_MACHINE_NAMES).
export const RESERVED_MACHINE_NAMES = new Set<string>(["shared", "_test"]);

const LAB_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DEVICE_NAME_RE = new RegExp(`^${DEVICE_NAME_CHARS}$`);
const DOMAIN_NAME_RE = /^\w+$/;
const MAC_ADDRESS_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;
export const MEM_RE = /^\d+[bkmgBKMG]?$/;

export function validateLabName(value: string): string | null {
  const name = value.trim();
  if (!name) return null;
  if (name === "." || name === "..") return `"${name}" can't be used as a lab name.`;
  return LAB_NAME_RE.test(name) ? null : "Use letters, digits, dot, dash or underscore (at most 64 characters).";
}

export function validateDeviceName(value: string): string | null {
  const name = value.trim();
  if (!name) return null;
  if (RESERVED_MACHINE_NAMES.has(name)) return `"${name}" is a reserved name, it can't be used for a device.`;
  return DEVICE_NAME_RE.test(name)
    ? null
    : "Use only lowercase letters, digits and underscores (at most 30 characters).";
}

export function validateDomainName(value: string): string | null {
  const name = value.trim();
  if (!name) return null;
  return DOMAIN_NAME_RE.test(name) ? null : "Use only letters, digits and underscores.";
}

export function validateMacAddress(value: string): string | null {
  const mac = value.trim();
  if (!mac) return null;
  return MAC_ADDRESS_RE.test(mac) ? null : "Use six pairs of hex digits separated by colons, like 02:00:00:00:00:01.";
}

export function validateMem(value: string): string | null {
  const mem = value.trim();
  if (!mem) return null;
  return MEM_RE.test(mem) ? null : "Use a whole number with an optional b, k, m or g unit, like 256m.";
}

/** An interface number typed into a form: a whole number, 0 or more. */
export function validateInterfaceNumber(value: string): string | null {
  const n = value.trim();
  if (!n) return null;
  return /^\d+$/.test(n) ? null : "Use a whole number, 0 or more.";
}
