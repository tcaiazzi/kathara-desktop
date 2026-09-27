"""Reading a running device's interface addresses: the `ip -o addr show` parser, and
KatharaService.get_live_addresses, which runs it on every running device of a lab."""

import pytest

from kathara_api.schemas.lab import LabCreate
from kathara_api.services import lab_builder
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from kathara_api.services.live_addresses import parse_ip_o_addr
from tests.helpers import FakeFacadeBase, lab_id, make_service, register_lab

IPROUTE2 = """\
1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
1: lo    inet6 ::1/128 scope host \\       valid_lft forever preferred_lft forever
12: eth0@if13    inet 10.0.0.1/24 brd 10.0.0.255 scope global eth0\\       valid_lft forever preferred_lft forever
12: eth0@if13    inet 10.0.0.9/24 scope global secondary eth0:1\\       valid_lft forever preferred_lft forever
12: eth0@if13    inet6 2001:db8::1/64 scope global \\       valid_lft forever preferred_lft forever
12: eth0@if13    inet6 fe80::200:ff:fe00:1/64 scope link \\       valid_lft forever preferred_lft forever
14: eth10@if15    inet 10.0.10.1/30 brd 10.0.10.3 scope global eth10\\       valid_lft forever preferred_lft forever
"""

BUSYBOX = """\
1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
2: eth0    inet 192.168.0.2/24 scope global eth0\\       valid_lft forever preferred_lft forever
"""


def test_keeps_each_eth_interfaces_addresses_in_order_with_their_prefix():
    assert parse_ip_o_addr(IPROUTE2) == {
        0: ["10.0.0.1/24", "10.0.0.9/24", "2001:db8::1/64"],
        10: ["10.0.10.1/30"],
    }


def test_reads_busybox_ip_the_same_way():
    assert parse_ip_o_addr(BUSYBOX) == {0: ["192.168.0.2/24"]}


def test_drops_loopback_and_ipv6_link_local_addresses():
    assert 1 not in parse_ip_o_addr(IPROUTE2)
    assert all(not ip.startswith("fe80") for ips in parse_ip_o_addr(IPROUTE2).values() for ip in ips)


def test_drops_addresses_the_network_handed_out_rather_than_a_startup_file():
    text = (
        "2: eth0    inet 10.0.0.7/24 brd 10.0.0.255 scope global dynamic eth0\\       valid_lft 86000sec\n"
        "2: eth0    inet6 2001:db8::42:aff:fe00:7/64 scope global dynamic mngtmpaddr \\       valid_lft 86000sec\n"
        "2: eth0    inet 10.0.0.1/24 scope global eth0\\       valid_lft forever preferred_lft forever\n"
    )

    assert parse_ip_o_addr(text) == {0: ["10.0.0.1/24"]}


def test_ignores_lines_that_are_not_an_address():
    text = "garbage\n\n3: eth1    link/ether 02:42:ac:11:00:02 brd ff:ff:ff:ff:ff:ff\n"

    assert parse_ip_o_addr(text) == {}


class _AddrFacade(FakeFacadeBase):
    """Answers each device's probe from `outputs` (device -> result, or an exception to raise)."""

    def __init__(self):
        self.outputs: dict[str, object] = {}
        self.execs: list[tuple[str, object, bool]] = []

    def exec(self, machine_name, command, lab_hash=None, wait=False, stream=False):
        self.execs.append((machine_name, command, wait))
        out = self.outputs.get(machine_name, (b"", b"", 1))
        if isinstance(out, Exception):
            raise out
        return out


@pytest.fixture
def facade():
    return _AddrFacade()


@pytest.fixture
def service(tmp_path, facade):
    """Lab `l`: pc1, pc2 and pc3 running, pc4 stopped."""
    service = make_service(store=LabStore(tmp_path / "labs"), facade=facade)
    lab = lab_builder.build_lab(
        LabCreate.model_validate(
            {"name": "l", "machines": [{"name": n, "interfaces": [{"link": "A"}]} for n in ("pc1", "pc2", "pc3", "pc4")]}
        )
    )
    for name in ("pc1", "pc2", "pc3"):
        lab.machines[name].api_object = object()
    register_lab(service, lab)
    return service


def test_probes_each_running_device_once_without_blocking(service, facade):
    service.get_live_addresses(lab_id(service, "l"))

    probe = ["sh", "-c", KatharaService._LIVE_ADDRESSES_PROBE]
    assert facade.execs == [("pc1", probe, False), ("pc2", probe, False), ("pc3", probe, False)]


def test_leaves_out_a_device_still_booting_or_unreachable_without_failing_the_others(service, facade):
    facade.outputs = {
        "pc1": (BUSYBOX.encode(), b"", 0),
        "pc2": (b"", b"", 1),  # /tmp/EOS not there yet, or no `ip`
        "pc3": RuntimeError("container gone"),
    }

    assert service.get_live_addresses(lab_id(service, "l")) == {"pc1": {0: ["192.168.0.2/24"]}}


def test_reports_a_running_device_with_no_address_as_empty(service, facade):
    facade.outputs = {"pc1": (b"", b"", 0)}

    assert service.get_live_addresses(lab_id(service, "l")) == {"pc1": {}}
