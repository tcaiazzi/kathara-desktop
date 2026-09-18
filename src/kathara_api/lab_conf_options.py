"""The `lab.conf` device options this API models — the one place they are named.

A leaf module on purpose: it imports nothing from ``schemas`` or ``services``, so every layer can
depend on it without a cycle. (``schemas.machine`` and ``services.lab_store`` both need it, and
``services.lab_import`` — the obvious-looking home, since it owns the parser — already imports
``schemas.machine``, so hosting the vocabulary there would close a loop. Same reasoning, and same
shape, as ``services/desktop/scripts/python-version.mjs``.)

Before this module the vocabulary was written out five times — the parser's dispatch chain, the
lab.conf renderer's scalar order, the in-place editor's "which lines do we own", the request
schema's reserved-key set, and the frontend's editor vocabulary. They had drifted: ``cpu`` was
interpreted by the parser but not reserved by the schema, so ``metas={"cpu": "2"}`` was accepted,
written to disk verbatim, and came back as a real ``cpus`` on the next load (audit_3 Q1).
"""

# Always emitted, always double-quoted, defaulted rather than omitted — special-cased by both
# renderers, so it is not part of SCALAR_OPTIONS.
IMAGE_KEY = "image"
DEFAULT_IMAGE = "kathara/base"

# Options rendered as a plain `device[key]=value` line.
#
# THIS ORDER IS THE ORDER THEY ARE WRITTEN TO DISK. `lab_store.gen_device_lines` loops over it, so
# reordering this tuple rewrites the lab.conf of every JSON-created lab. Pinned by
# `tests/unit/test_lab_store.py::test_gen_device_lines_is_byte_for_byte_stable`.
SCALAR_OPTIONS: tuple[str, ...] = (
    "mem", "cpus", "shell", "ipv6", "privileged", "bridged", "num_terms", "entrypoint", "args",
)

# Options that repeat — one lab.conf line per entry — mapping the lab.conf spelling (singular) to
# the JSON/model field name (plural). Both spellings matter: the singular is what a lab.conf line
# says, the plural is what `machine.meta` and the request schema call it.
#
# ORDER IS ALSO THE RENDER ORDER, for the same reason as SCALAR_OPTIONS.
GROUP_OPTIONS: dict[str, str] = {
    "port": "ports",
    "env": "envs",
    "sysctl": "sysctls",
    "ulimit": "ulimits",
    "volume": "volumes",
    "exec": "exec_commands",
}

# Spellings the parser accepts and normalizes to a canonical option. An alias has to be treated
# exactly as tightly as the name it resolves to: it reaches the same model field, so a `metas`
# entry using one is not a pass-through at all.
OPTION_ALIASES: dict[str, str] = {"cpu": "cpus"}

# Set by the Kathara manager at deploy time, never authored in a lab.conf. Not interpreted by the
# parser, but still reserved and still not rendered as a pass-through.
DERIVED_META_KEYS = frozenset({"bridged_iface"})

# --- derived ------------------------------------------------------------------------------------

#: Keys `lab_import._apply_conf_option` interprets. It *gates* on this set rather than merely
#: agreeing with it, so an option cannot be handled without being listed here — and therefore
#: cannot be interpreted without also being reserved (see MODELED_META_KEYS).
INTERPRETED_OPTIONS = frozenset({IMAGE_KEY, *SCALAR_OPTIONS, *GROUP_OPTIONS, *OPTION_ALIASES})

#: Every name this API owns, in either spelling. Answers two questions that turn out to be the same
#: one: "does this `machine.meta` entry already have a home?" (`lab_store.gen_device_lines`'s
#: pass-through rendering and `serializers`' `metas` filter) and "may a request's `metas` use this
#: key?" (`schemas.machine._valid_meta_keys`).
#:
#: Those two used to differ — the renderer's set lacked the aliases and the singular group
#: spellings — which meant a `machine.meta` keyed `port` or `cpu` escaped the serializer into
#: `MachineDetail.metas`, a field documented as feeding straight back into a PUT, where the schema
#: then rejected it with a 422. Unreachable in practice, but only by accident.
MODELED_META_KEYS = frozenset(INTERPRETED_OPTIONS | set(GROUP_OPTIONS.values()) | DERIVED_META_KEYS)
