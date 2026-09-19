"""The `lab.conf` vocabulary — the names and shapes this API and its parser agree on.

A leaf module on purpose: it imports nothing from ``schemas`` or ``services``, so every layer can
depend on it without a cycle. (``schemas.machine`` and ``services.lab_store`` both need it, and
``services.lab_import`` — the obvious-looking home, since it owns the parser — already imports
``schemas.machine``, so hosting the vocabulary there would close a loop. Same reasoning, and same
shape, as ``services/desktop/scripts/python-version.mjs``.)

Five layers derive their names from here instead of spelling them out: the parser's dispatch
chain, the lab.conf renderer's scalar order, the in-place editor's "which lines do we own", the
request schema's reserved-key set, and the frontend's editor vocabulary. A local copy in any of
them drifts, and the drift is silent — an option the parser interprets but the schema fails to
reserve is accepted as a ``metas`` pass-through, written to disk verbatim, and comes back as the
real option on the next load (``cpu`` reaching ``cpus`` is the case that bites).
"""

import re

LAB_CONF_FILENAME = "lab.conf"

# The device-name grammar, as a fragment so the three places that need it cannot disagree: the
# request schema validates a name against it, and the parser embeds it in both the directive-line
# and the `<name>.startup` patterns.
DEVICE_NAME_CHARS = r"[a-z0-9_]{1,30}"
DEVICE_NAME_PATTERN = rf"^{DEVICE_NAME_CHARS}$"

# A bare identifier. lab.conf has no escaping, so a key that is anything else cannot be written back
# out unambiguously. Two callers need exactly this shape, for reasons that meet in the middle:
#
#   - the parser, deciding whether an unrecognized top-level `KEY=value` line is safe to preserve;
#   - the request schema, validating a `metas` key — which both renderers write raw into a
#     `name[key]=...` line. That one is load-bearing rather than tidy: a key containing a newline
#     would split one rendered line into two, and the second half, if it matched the directive
#     grammar, would become an independent ghost device; a purely numeric key would be
#     indistinguishable from a real interface number on the next parse. Requiring a leading
#     letter/underscore rules out the numeric case by construction, and the character class rules
#     out newlines, brackets, quotes and whitespace the same way.
IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

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
#: Deriving both from this one set is what keeps the answers identical. Were the renderer's set to
#: lack the aliases or the singular group spellings, a `machine.meta` keyed `port` or `cpu` would
#: escape the serializer into `MachineDetail.metas` — a field documented as feeding straight back
#: into a PUT, where the schema would then reject it with a 422.
MODELED_META_KEYS = frozenset(INTERPRETED_OPTIONS | set(GROUP_OPTIONS.values()) | DERIVED_META_KEYS)
