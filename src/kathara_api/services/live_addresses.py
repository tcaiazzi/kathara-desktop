"""The addresses actually on a running device's interfaces, read from `ip -o addr show`.

The one-line-per-address (`-o`) form is the same in iproute2 and in busybox's `ip`, so this reads
every image Kathara commonly runs:

    2: eth0@if7    inet 10.0.0.1/24 brd 10.0.0.255 scope global eth0\\       valid_lft forever ...
    2: eth0    inet6 fe80::42:aff:fe00:1/64 scope link \\       valid_lft forever ...

Only `ethN` interfaces are kept — the ones a lab.conf declares. Addresses no startup file
declares are dropped: IPv6 link-local ones, which the kernel assigns by itself, and `dynamic` ones,
which the network hands out (SLAAC from a router advertisement, a DHCP lease).
Leaf module: no Kathara or Docker import, so it is unit-tested on plain text.
"""

import re

# `eth0`, or `eth0@if7`: a veth interface is listed with its peer's index.
_ETH_RE = re.compile(r"^eth(\d+)(?:@\S*)?$")


def parse_ip_o_addr(text: str) -> dict[int, list[str]]:
    """Interface number -> its addresses (with prefix length), in the order `ip` lists them."""
    addresses: dict[int, list[str]] = {}
    for line in text.splitlines():
        tokens = line.split()
        # "<index>:" "<iface>" "<family>" "<address>" ...
        if len(tokens) < 4 or not tokens[0].endswith(":") or tokens[2] not in ("inet", "inet6"):
            continue
        match = _ETH_RE.match(tokens[1])
        if not match:
            continue
        if (tokens[2] == "inet6" and _scope(tokens) == "link") or "dynamic" in tokens:
            continue
        found = addresses.setdefault(int(match.group(1)), [])
        if tokens[3] not in found:
            found.append(tokens[3])
    return addresses


def _scope(tokens: list[str]) -> str | None:
    try:
        return tokens[tokens.index("scope") + 1]
    except (ValueError, IndexError):
        return None
