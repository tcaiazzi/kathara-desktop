"""Generalized coverage for "unknown lab -> 404".

test_unknown_lab_404.py is narrow, tied to three specific methods (undeploy_lab, delete_lab and
machines_stats_stream). This file generalizes the same check to every other KatharaService
method that looks up an existing lab by name, so a method that forgets the check fails a test
instead of shipping silently.

Three tiers, cheapest/most valuable first:
1. A drift guard (`test_every_lab_lookup_method_is_covered`) that fails if a new per-lab lookup
   method is added to KatharaService without being added to CASES or SKIPPED below.
2. CASES: one parametrized test per lookup method, at the service layer (no HTTP, no Docker).
3. A small HTTP-level slice over the per-lab GET routes only (no request body to construct) that
   confirms the 404 actually reaches the response, not just the service call.
"""

import inspect

import pytest
from Kathara.exceptions import LabNotFoundError

from kathara_api.schemas.lab import LabLayout
from kathara_api.schemas.machine import MachineCreate, MachineUpdate
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import make_service

UNKNOWN = "never-existed"
MACHINE = "pc1"
LINK = "A"



# -- Tier 2: one entry per lookup method, with minimal dummy values for its other arguments -----

CASES: list[tuple[str, tuple]] = [
    ("check_lab_images", ()),
    ("export_lab_zip", ()),
    ("read_lab_conf", ()),
    ("lab_location", ()),
    ("get_lab_layout", ()),
    ("save_lab_layout", (LabLayout(),)),
    ("clear_lab_layout", ()),
    ("update_lab_conf", ("LAB_NAME=x\n",)),
    ("get_startup_scripts", ()),
    ("fs_list_offline", (".",)),
    ("fs_search_offline", (".", "query")),
    ("fs_read_text_offline", (".",)),
    ("fs_read_bytes_offline", (".",)),
    ("fs_write_text_offline", (".", "content")),
    ("fs_upload_bytes_offline", (".", b"content")),
    ("fs_mkdir_offline", (".",)),
    ("fs_delete_offline", (".",)),
    ("fs_move_offline", (".", "b")),
    ("fs_copy_offline", (".", "b")),
    ("get_lab_or_reconstruct", ()),
    ("deploy_lab", ()),
    ("undeploy_lab", ()),
    ("rename_lab", ("new-name",)),
    ("delete_lab", ()),
    ("get_machine_api_object", (MACHINE,)),
    ("available_shells", (MACHINE,)),
    ("add_machine", (MachineCreate(name=MACHINE),)),
    ("update_machine", (MACHINE, MachineUpdate())),
    ("remove_machine", (MACHINE,)),
    ("connect_machine", (MACHINE, LINK)),
    ("disconnect_machine", (MACHINE, LINK)),
    ("copy_files", (MACHINE, {})),
    ("fs_list_directory", (MACHINE, ".")),
    ("fs_read_bytes", (MACHINE, ".")),
    ("fs_read_text", (MACHINE, ".")),
    ("get_startup_log", (MACHINE,)),
    ("is_startup_finished", (MACHINE,)),
    ("fs_write_text", (MACHINE, ".", "content")),
    ("fs_upload_bytes", (MACHINE, ".", b"content")),
    ("fs_mkdir", (MACHINE, ".")),
    ("fs_move", (MACHINE, ".", "b")),
    ("fs_copy", (MACHINE, ".", "b")),
    ("fs_delete", (MACHINE, ".")),
    ("add_link", (LINK,)),
    ("remove_link", (LINK,)),
    ("machines_stats_stream", ()),
]

# Methods whose first parameter is `name`/`lab_name` but that are *not* part of this "does an
# existing lab exist" family, with the reason each is excluded rather than silently missing:
SKIPPED = {
    "upload_lab": "creates a lab under `name` — an unknown name is the success path, not a 404.",
    "exec_command": (
        "resolves straight through the Docker facade by container name "
        "(KatharaService.exec_command -> facade.exec), never via get_lab_or_reconstruct/the "
        "registry — a different lookup mechanism entirely, out of scope for this family."
    ),
}


@pytest.mark.parametrize("method_name,extra_args", CASES)
def test_unknown_lab_404s(tmp_path, method_name, extra_args):
    service = make_service(LabStore(tmp_path / "labs"))
    with pytest.raises(LabNotFoundError):
        getattr(service, method_name)(UNKNOWN, *extra_args)


# -- Tier 1: keep the table above from rotting -------------------------------------------------


def test_every_lab_lookup_method_is_covered():
    """Every KatharaService method whose first parameter (after self) is literally `name` or
    `lab_name` must appear in CASES or SKIPPED. A method that satisfies neither is a per-lab
    operation nobody has checked returns 404 for `never-existed`."""
    # The walk below only sees methods that exist, so a SKIPPED entry for a deleted method would
    # never fail — it would just sit there documenting nothing.
    stale = sorted(name for name in SKIPPED if not hasattr(KatharaService, name))
    assert stale == [], f"SKIPPED names method(s) that no longer exist: {stale}"

    covered = {name for name, _ in CASES} | set(SKIPPED)
    missing = []
    for method_name, method in inspect.getmembers(KatharaService, predicate=inspect.isfunction):
        if method_name.startswith("_") or method_name in covered:
            continue
        params = list(inspect.signature(method).parameters)
        if len(params) >= 2 and params[1] in ("name", "lab_name"):
            missing.append(method_name)
    assert missing == [], (
        f"New per-lab lookup method(s) not covered by CASES or SKIPPED: {missing}. "
        "Add a case with minimal dummy args, or add to SKIPPED with a reason."
    )


# -- Tier 3: HTTP-level slice, GET routes only (no request body to construct) -------------------

GET_ROUTES = [
    "/api/labs/{name}",
    "/api/labs/{name}/download",
    "/api/labs/{name}/lab-conf",
    "/api/labs/{name}/location",
    "/api/labs/{name}/layout",
    "/api/labs/{name}/fs/startups",
    "/api/labs/{name}/images",
    f"/api/labs/{{name}}/machines/{MACHINE}/shells",
    f"/api/labs/{{name}}/machines/{MACHINE}/startup-status",
]

# Routes above whose handler has a *required* query parameter with no default — supplied here so
# a 422 (missing query param) can never masquerade as "the 404 check works".
GET_ROUTES_WITH_QUERY = [
    ("/api/labs/{name}/fs/text", {"path": "/"}),
    ("/api/labs/{name}/fs/download", {"path": "/"}),
    ("/api/labs/{name}/fs/search", {"path": "/", "query": "ab"}),
    (f"/api/labs/{{name}}/machines/{MACHINE}/fs/text", {"path": "/"}),
    (f"/api/labs/{{name}}/machines/{MACHINE}/fs/download", {"path": "/"}),
]


@pytest.mark.parametrize("path_template", GET_ROUTES)
def test_http_get_404s_for_an_unknown_lab(client, path_template):
    resp = client.get(path_template.format(name=UNKNOWN))
    assert resp.status_code == 404


@pytest.mark.parametrize("path_template,params", GET_ROUTES_WITH_QUERY)
def test_http_get_with_query_404s_for_an_unknown_lab(client, path_template, params):
    resp = client.get(path_template.format(name=UNKNOWN), params=params)
    assert resp.status_code == 404
