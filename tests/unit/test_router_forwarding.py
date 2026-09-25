"""The HTTP layer of the machines, links, labs and stats routers, in isolation from the service.

The service methods behind these routes have their own tests; what those cannot see is the
router's half of the contract. These tests pin it down: the right service method is called, with
the path, query, form and body values forwarded under the right names (`keep_links` vs
`keep_link`, `recursive`, option lists turned into sets), paths normalized where the route
normalizes them, and the result shaped into the documented response. The service is a recording
stub, so no lab, disk or Docker is involved. How service exceptions map to status codes is
covered once for every route by test_error_mapping.py.
"""

import io
import json

import pytest
from fastapi.testclient import TestClient

from kathara_api.dependencies import get_service
from kathara_api.main import create_app
from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import MachineCreate, MachineUpdate
from kathara_api.services import lab_builder
from kathara_api.services.kathara_service import KatharaService


class _RecordingService:
    """Records every service call as `(method, args, kwargs)` and returns what the test set in
    `returns[method]`: a plain value, or a callable run with the call's arguments.

    `normalize_guest_path` is the real one: several routes echo its result back, and a copy of
    it here would let the tests agree with themselves instead of with the service.
    """

    def __init__(self):
        self.calls: list[tuple[str, tuple, dict]] = []
        self.returns: dict = {}

    def normalize_guest_path(self, path: str) -> str:
        return KatharaService.normalize_guest_path(self, path)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        def method(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            result = self.returns.get(name)
            return result(*args, **kwargs) if callable(result) else result

        return method


def _lab():
    """A small real lab (one device on one collision domain), so the serializers run for real."""
    return lab_builder.build_lab(
        LabCreate.model_validate(
            {"name": "l", "machines": [{"name": "pc1", "image": "kathara/base", "interfaces": [{"link": "A"}]}]}
        )
    )


@pytest.fixture
def api():
    service = _RecordingService()
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        yield client, service
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Routes that answer with a plain Message
# ---------------------------------------------------------------------------

MESSAGE_ROUTES = [
    # machines
    ("DELETE", "/api/labs/l/machines/pc1", {}, ("remove_machine", ("l", "pc1"), {"keep_links": False}),
     "Device `pc1` removed."),
    ("DELETE", "/api/labs/l/machines/pc1?keep_links=true", {},
     ("remove_machine", ("l", "pc1"), {"keep_links": True}), "Device `pc1` removed."),
    ("POST", "/api/labs/l/machines/pc1/disconnect?link=A", {},
     ("disconnect_machine", ("l", "pc1", "A"), {"keep_link": False}), "Device `pc1` disconnected from `A`."),
    ("POST", "/api/labs/l/machines/pc1/disconnect?link=A&keep_link=true", {},
     ("disconnect_machine", ("l", "pc1", "A"), {"keep_link": True}), "Device `pc1` disconnected from `A`."),
    ("POST", "/api/labs/l/machines/pc1/fs/mkdir", {"json": {"path": "/tmp/d"}},
     ("fs_mkdir", ("l", "pc1", "/tmp/d"), {}), "Directory `/tmp/d` created on `pc1`."),
    ("POST", "/api/labs/l/machines/pc1/fs/move", {"json": {"source_path": "/a", "destination_path": "/b"}},
     ("fs_move", ("l", "pc1", "/a", "/b"), {}), "Moved `/a` to `/b` on `pc1`."),
    ("POST", "/api/labs/l/machines/pc1/fs/copy", {"json": {"source_path": "/a", "destination_path": "/b"}},
     ("fs_copy", ("l", "pc1", "/a", "/b"), {}), "Copied `/a` to `/b` on `pc1`."),
    ("DELETE", "/api/labs/l/machines/pc1/fs", {"json": {"path": "/tmp/d"}},
     ("fs_delete", ("l", "pc1", "/tmp/d"), {"recursive": False}), "Deleted `/tmp/d` on `pc1`."),
    ("DELETE", "/api/labs/l/machines/pc1/fs", {"json": {"path": "/tmp/d", "recursive": True}},
     ("fs_delete", ("l", "pc1", "/tmp/d"), {"recursive": True}), "Deleted `/tmp/d` on `pc1`."),
    # links
    ("DELETE", "/api/labs/l/links/A", {}, ("remove_link", ("l", "A"), {}),
     "Collision domain `A` removed."),
    # labs: the lab's own on-disk tree
    ("POST", "/api/labs/l/fs/mkdir", {"json": {"path": "/pc1/etc"}},
     ("fs_mkdir_offline", ("l", "/pc1/etc"), {}), "Directory `/pc1/etc` created."),
    ("POST", "/api/labs/l/fs/move", {"json": {"source_path": "/pc1/a", "destination_path": "/pc2/a"}},
     ("fs_move_offline", ("l", "/pc1/a", "/pc2/a"), {}), "Moved `/pc1/a` to `/pc2/a`."),
    ("POST", "/api/labs/l/fs/copy", {"json": {"source_path": "/pc1/a", "destination_path": "/pc2/a"}},
     ("fs_copy_offline", ("l", "/pc1/a", "/pc2/a"), {}), "Copied `/pc1/a` to `/pc2/a`."),
    ("DELETE", "/api/labs/l/fs", {"json": {"path": "/pc1", "recursive": True}},
     ("fs_delete_offline", ("l", "/pc1"), {"recursive": True}), "Deleted `/pc1`."),
    # labs: lifecycle
    ("POST", "/api/labs/l/undeploy", {},
     ("undeploy_lab", ("l",), {"selected_machines": None, "excluded_machines": None, "selected_links": None}),
     "Lab undeployed."),
    ("POST", "/api/labs/l/undeploy",
     {"json": {"selected_machines": ["pc1", "pc1"], "excluded_machines": [], "selected_links": ["A"]}},
     ("undeploy_lab", ("l",), {"selected_machines": {"pc1"}, "excluded_machines": None, "selected_links": {"A"}}),
     "Lab undeployed."),
    ("DELETE", "/api/labs/l", {}, ("delete_lab", ("l",), {}), "Lab deleted."),
]


@pytest.mark.parametrize(
    "method, url, body, expected_call, detail",
    MESSAGE_ROUTES,
    ids=[f"{m} {u}" for m, u, *_ in MESSAGE_ROUTES],
)
def test_message_route_forwards_to_the_service(api, method, url, body, expected_call, detail):
    client, service = api

    res = client.request(method, url, **body)

    assert res.status_code == 200, res.text
    assert res.json() == {"detail": detail}
    assert service.calls == [expected_call]


@pytest.mark.parametrize(
    "url, expected_call",
    [
        ("/api/labs/l/machines/pc1/fs/text", ("fs_write_text", ("l", "pc1", "/etc/motd", "héllo"), {})),
        ("/api/labs/l/fs/text", ("fs_write_text_offline", ("l", "/etc/motd", "héllo"), {})),
    ],
)
def test_text_write_reports_the_size_the_service_wrote(api, url, expected_call):
    client, service = api
    service.returns["fs_write_text"] = service.returns["fs_write_text_offline"] = 6

    res = client.put(url, json={"path": "/etc/motd", "content": "héllo"})

    assert res.status_code == 200
    assert res.json()["detail"].startswith("Wrote 6 byte(s) to `/etc/motd`")
    assert service.calls == [expected_call]


# ---------------------------------------------------------------------------
# machines.py
# ---------------------------------------------------------------------------


def test_list_shells(api):
    client, service = api
    service.returns["available_shells"] = ["bash", "sh"]

    res = client.get("/api/labs/l/machines/pc1/shells")

    assert res.json() == ["bash", "sh"]
    assert service.calls == [("available_shells", ("l", "pc1"), {})]


def test_add_machine_returns_201_and_the_created_device(api):
    client, service = api
    service.returns["add_machine"] = _lab().machines["pc1"]

    res = client.post(
        "/api/labs/l/machines", json={"name": "pc1", "image": "kathara/base", "interfaces": [{"link": "A"}]}
    )

    assert res.status_code == 201
    assert res.json()["name"] == "pc1"
    assert res.json()["interfaces"] == [{"num": 0, "link": "A", "mac_address": None}]
    [(name, (lab_name, spec), _)] = service.calls
    assert (name, lab_name) == ("add_machine", "l")
    assert isinstance(spec, MachineCreate) and spec.interfaces[0].link == "A"


def test_update_machine_forwards_the_full_option_set(api):
    client, service = api
    service.returns["update_machine"] = _lab().machines["pc1"]

    res = client.put("/api/labs/l/machines/pc1", json={"image": "kathara/frr", "mem": "256m"})

    assert res.status_code == 200
    [(name, (lab_name, machine_name, spec), _)] = service.calls
    assert (name, lab_name, machine_name) == ("update_machine", "l", "pc1")
    assert isinstance(spec, MachineUpdate) and (spec.image, spec.mem) == ("kathara/frr", "256m")


@pytest.mark.parametrize(
    "query, expected_kwargs",
    [
        ("link=A", {"interface_number": None, "mac_address": None}),
        ("link=A&interface_number=2&mac_address=02:42:ac:11:00:02",
         {"interface_number": 2, "mac_address": "02:42:ac:11:00:02"}),
    ],
)
def test_connect_machine_forwards_the_optional_interface_settings(api, query, expected_kwargs):
    client, service = api
    service.returns["connect_machine"] = _lab().machines["pc1"]

    res = client.post(f"/api/labs/l/machines/pc1/connect?{query}")

    assert res.status_code == 200
    assert service.calls == [("connect_machine", ("l", "pc1", "A"), expected_kwargs)]


def test_runtime_list_passes_the_raw_path_and_answers_with_the_normalized_one(api):
    client, service = api
    service.returns["fs_list_directory"] = [{"name": "log", "path": "/var/log", "is_dir": True}]

    res = client.get("/api/labs/l/machines/pc1/fs/list", params={"path": "etc/../var"})

    assert res.json() == {
        "path": "/var",
        "entries": [{"name": "log", "path": "/var/log", "is_dir": True, "size": None, "mode": None,
                     "mtime": None}],
    }
    assert service.calls == [("fs_list_directory", ("l", "pc1", "etc/../var"), {})]


def test_runtime_list_defaults_to_the_root(api):
    client, service = api
    service.returns["fs_list_directory"] = []

    assert client.get("/api/labs/l/machines/pc1/fs/list").json() == {"path": "/", "entries": []}
    assert service.calls == [("fs_list_directory", ("l", "pc1", "/"), {})]


def test_runtime_text_read_normalizes_the_path_before_the_service_sees_it(api):
    client, service = api
    service.returns["fs_read_text"] = "hello"

    res = client.get("/api/labs/l/machines/pc1/fs/text", params={"path": "var//log/../motd"})

    assert res.json() == {"path": "/var/motd", "content": "hello"}
    assert service.calls == [("fs_read_text", ("l", "pc1", "/var/motd"), {})]


def test_startup_status_combines_log_and_finished_flag(api):
    client, service = api
    service.returns["get_startup_log"] = "starting...\n"
    service.returns["is_startup_finished"] = True

    res = client.get("/api/labs/l/machines/pc1/startup-status")

    assert res.json() == {"log": "starting...\n", "finished": True}
    assert [c[0] for c in service.calls] == ["get_startup_log", "is_startup_finished"]


@pytest.mark.parametrize(
    "url, service_method, expected_args",
    [
        ("/api/labs/l/machines/pc1/fs/upload", "fs_upload_bytes", ("l", "pc1", "tmp/blob.bin", b"\x00\x01data")),
        ("/api/labs/l/fs/upload", "fs_upload_bytes_offline", ("l", "tmp/blob.bin", b"\x00\x01data")),
    ],
)
def test_upload_forwards_the_file_bytes_and_answers_with_the_normalized_path(
    api, url, service_method, expected_args
):
    client, service = api
    service.returns[service_method] = 6

    res = client.post(
        url, data={"path": "tmp/blob.bin"}, files={"file": ("blob.bin", b"\x00\x01data", "application/octet-stream")}
    )

    assert res.status_code == 200
    assert res.json() == {"path": "/tmp/blob.bin", "size": 6}
    assert service.calls == [(service_method, expected_args, {})]


@pytest.mark.parametrize(
    "url_prefix, service_method, lab_args",
    [
        ("/api/labs/l/machines/pc1", "fs_read_bytes", ("l", "pc1")),
        ("/api/labs/l", "fs_read_bytes_offline", ("l",)),
    ],
)
@pytest.mark.parametrize(
    "path, normalized, filename_star",
    [
        ("/tmp/résumé.txt", "/tmp/résumé.txt", "r%C3%A9sum%C3%A9.txt"),
        ("/", "/", "download.bin"),
    ],
)
def test_download_streams_bytes_as_an_attachment_named_after_the_file(
    api, url_prefix, service_method, lab_args, path, normalized, filename_star
):
    client, service = api
    service.returns[service_method] = b"\x00binary"

    res = client.get(f"{url_prefix}/fs/download", params={"path": path})

    assert res.status_code == 200
    assert res.content == b"\x00binary"
    assert res.headers["content-type"] == "application/octet-stream"
    assert res.headers["content-disposition"].endswith(f"filename*=UTF-8''{filename_star}")
    assert service.calls == [(service_method, (*lab_args, normalized), {})]


# ---------------------------------------------------------------------------
# links.py
# ---------------------------------------------------------------------------


def test_add_link_returns_201_and_forwards_external_interfaces(api):
    client, service = api
    service.returns["add_link"] = _lab().links["A"]

    res = client.post("/api/labs/l/links", json={"name": "A", "external": ["eth0"]})

    assert res.status_code == 201
    assert res.json() == {"name": "A", "machines": ["pc1"], "external": [], "running": False}
    assert service.calls == [("add_link", ("l", "A"), {"external": ["eth0"]})]


# ---------------------------------------------------------------------------
# labs.py
# ---------------------------------------------------------------------------


def test_create_lab_returns_201_and_the_lab_detail(api):
    client, service = api
    service.returns["create_lab"] = _lab()

    res = client.post("/api/labs", json={"name": "l", "machines": [{"name": "pc1"}]})

    assert res.status_code == 201
    assert res.json()["name"] == "l"
    assert [m["name"] for m in res.json()["machines"]] == ["pc1"]
    [(name, (spec,), _)] = service.calls
    assert name == "create_lab" and isinstance(spec, LabCreate) and spec.name == "l"


@pytest.mark.parametrize(
    "form, expected_name, expected_deploy",
    [
        ({}, "mylab", False),  # name taken from the archive's filename
        ({"name": "   "}, "mylab", False),  # a blank name falls back to it too
        ({"name": " custom ", "deploy": "true"}, "custom", True),
    ],
)
def test_upload_lab_resolves_the_name_and_forwards_the_archive(api, form, expected_name, expected_deploy):
    client, service = api
    received = {}

    def upload_lab(name, zip_data, deploy):
        received.update(name=name, data=zip_data.read(), deploy=deploy)
        return _lab(), ["unknown option `foo`"]

    service.returns["upload_lab"] = upload_lab

    res = client.post(
        "/api/labs/upload", data=form, files={"file": ("mylab.zip", b"PK\x03\x04zip", "application/zip")}
    )

    assert res.status_code == 201
    assert res.json()["name"] == "l"
    assert res.json()["warnings"] == ["unknown option `foo`"]
    assert received == {"name": expected_name, "data": b"PK\x03\x04zip", "deploy": expected_deploy}


def test_download_lab_streams_the_zip_as_an_attachment_named_after_the_lab_directory(api):
    client, service = api
    service.returns["export_lab_zip"] = ("mylab", io.BytesIO(b"PK\x05\x06"))

    res = client.get("/api/labs/l/download")

    assert res.content == b"PK\x05\x06"
    assert res.headers["content-type"] == "application/zip"
    assert 'filename="mylab.zip"' in res.headers["content-disposition"]
    assert service.calls == [("export_lab_zip", ("l",), {})]


def test_offline_list_passes_the_raw_path_and_answers_with_the_normalized_one(api):
    client, service = api
    service.returns["fs_list_offline"] = []

    res = client.get("/api/labs/l/fs/list", params={"path": "pc1/./etc"})

    assert res.json() == {"path": "/pc1/etc", "entries": []}
    assert service.calls == [("fs_list_offline", ("l", "pc1/./etc"), {})]


def test_offline_text_read_normalizes_the_path(api):
    client, service = api
    service.returns["fs_read_text_offline"] = "pc1[0]=A\n"

    res = client.get("/api/labs/l/fs/text", params={"path": "lab.conf"})

    assert res.json() == {"path": "/lab.conf", "content": "pc1[0]=A\n"}
    assert service.calls == [("fs_read_text_offline", ("l", "/lab.conf"), {})]


def test_offline_search_forwards_query_options(api):
    client, service = api
    service.returns["fs_search_offline"] = ([{"path": "/pc1.startup", "line_number": 3, "line_text": "ip a"}], True)

    res = client.get("/api/labs/l/fs/search", params={"path": "/pc1", "query": "ip a", "case_sensitive": "true"})

    assert res.json() == {
        "query": "ip a",
        "matches": [{"path": "/pc1.startup", "line_number": 3, "line_text": "ip a"}],
        "truncated": True,
    }
    assert service.calls == [("fs_search_offline", ("l", "/pc1", "ip a", True), {})]


def test_offline_search_rejects_a_query_shorter_than_two_characters(api):
    client, service = api

    res = client.get("/api/labs/l/fs/search", params={"query": "a"})

    assert res.status_code == 422
    assert service.calls == []


@pytest.mark.parametrize(
    "body, expected_kwargs",
    [
        (None, {"selected_machines": None, "excluded_machines": None}),
        ({"selected_machines": ["pc1"], "excluded_machines": ["pc2", "pc2"]},
         {"selected_machines": {"pc1"}, "excluded_machines": {"pc2"}}),
    ],
)
def test_deploy_turns_option_lists_into_sets(api, body, expected_kwargs):
    client, service = api
    service.returns["deploy_lab"] = _lab()

    res = client.post("/api/labs/l/deploy", json=body)

    assert res.status_code == 200
    assert res.json()["name"] == "l"
    assert service.calls == [("deploy_lab", ("l",), expected_kwargs)]


def test_rename_lab_returns_the_renamed_lab(api):
    client, service = api
    service.returns["rename_lab"] = _lab()

    res = client.post("/api/labs/old/rename", json={"name": "l"})

    assert res.status_code == 200
    assert res.json()["name"] == "l"
    assert service.calls == [("rename_lab", ("old", "l"), {})]


# ---------------------------------------------------------------------------
# stats.py
# ---------------------------------------------------------------------------


class _Stats:
    def __init__(self, **fields):
        self.fields = fields

    def to_dict(self):
        return self.fields


class _StatsGenerator:
    """A finite stand-in for Kathara's stats generator that records whether it was closed."""

    def __init__(self, snapshots):
        self._snapshots = iter(snapshots)
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._snapshots)

    def close(self):
        self.closed = True


def test_stats_stream_sends_one_event_per_snapshot_and_closes_the_generator(api):
    client, service = api
    generator = _StatsGenerator([
        [_Stats(name="pc1", cpu_usage="1%"), None, _Stats(name="pc2", pids=3, extra_field="x")],
        [],
    ])
    service.returns["machines_stats_stream"] = generator

    res = client.get("/api/labs/l/stats/stream")

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    events = [line.removeprefix("event:").strip() for line in res.text.splitlines() if line.startswith("event:")]
    payloads = [json.loads(line.removeprefix("data:")) for line in res.text.splitlines() if line.startswith("data:")]
    assert events == ["stats", "stats"]
    first, second = payloads
    assert [(s["name"], s["cpu_usage"], s["pids"]) for s in first] == [("pc1", "1%", None), ("pc2", None, 3)]
    assert first[1]["extra_field"] == "x"  # backend-specific fields are passed through
    assert second == []
    assert generator.closed
    assert service.calls == [("machines_stats_stream", ("l",), {})]
