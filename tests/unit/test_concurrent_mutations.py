"""Regression tests for two layered protections against a lab.conf/offline-fs edit or a
structural change (device/link add/remove/connect/disconnect, rename, delete) racing a
`deploy_lab`/`undeploy_lab` on the same lab — no Docker required.

**Primary protection** (`_check_not_transitioning`): every one of those operations now fails
immediately with `LabTransitioningError` if the target lab is mid deploy/undeploy, rather than
silently queuing behind `_mutate_lock` for however long that takes and only then succeeding or
failing on whatever state exists by the time it wakes up. Confirmed reachable through the shipped
UI, not just a raw concurrent API client: nothing in `useDeviceActions` or the topology context
menu is gated by the same `busy` flag that disables Deploy/Undeploy, so a user can click Deploy
and, before it returns, right-click the same device and connect/disconnect/remove it, or switch to
the Lab Configuration tab and save an edit.

**Fallback protection** (the `_mutate_lock` discipline fix, finding #10): the primary check above
has an inherent, unavoidable TOCTOU gap — a `deploy_lab` can start in the instant *after* a mutator
passes the check but *before* it acquires `_mutate_lock`. `connect_machine`/`disconnect_machine`/
`remove_machine`/`copy_files`/`add_link`/`remove_link` used to read `lab`/`machine` (and, for
connect/disconnect, decide their whole stopped-vs-running branch from `machine.api_object`)
*before* acquiring that lock, so a mutator caught in that gap would still read stale state once it
did proceed. They now read it *inside* the lock instead (matching what `add_machine` already
documented), so even a mutator that slips through the fast-fail window is still correct — merely
not fast. The tests for this layer bypass `_check_not_transitioning` via monkeypatch specifically
to force that gap and exercise the lock behavior underneath it, the same way a real race would.
"""

import threading

import pytest

from kathara_api.errors import LabTransitioningError
from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import MachineCreate
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase


class _BlockingFacade(FakeFacadeBase):
    """Like FakeFacadeBase, but `deploy_lab` pauses (while the caller still holds `_mutate_lock`,
    since the service wraps this call in it) until released, and every call is recorded so tests
    can assert exactly which branch of the operation under test actually ran."""

    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.calls: list[str] = []

    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        self.entered.set()
        self.release.wait(timeout=5)
        for name in selected_machines or lab.machines.keys():
            machine = lab.machines.get(name)
            if machine is not None:
                machine.api_object = object()

    def connect_machine_to_link(self, machine, link, mac_address=None):
        self.calls.append("connect_live")

    def disconnect_machine_from_link(self, machine, link, keep_link=False):
        self.calls.append("disconnect_live")

    def undeploy_machine(self, machine, keep_links=False):
        self.calls.append("undeploy_machine")


class _RaisingDeployFacade(FakeFacadeBase):
    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        raise RuntimeError("boom")


def _service_with_blocking_facade(tmp_path) -> tuple[KatharaService, _BlockingFacade, LabStore]:
    store = LabStore(tmp_path / "labs")
    service = KatharaService(store=store)
    facade = _BlockingFacade()
    service._instance = facade
    service.create_lab(LabCreate(name="testlab", machines=[MachineCreate(name="pc1", image="kathara/base")]))
    return service, facade, store


def _run_deploy_in_background(service: KatharaService, facade: _BlockingFacade) -> threading.Thread:
    """Starts `deploy_lab` on a second thread and waits until it's confirmed to be inside the
    facade call — i.e. actually holding `_mutate_lock` — before returning, so the caller can then
    exercise the method under test against a guaranteed-held lock."""
    thread = threading.Thread(target=lambda: service.deploy_lab("testlab"))
    thread.start()
    assert facade.entered.wait(timeout=2), "deploy_lab did not reach the facade call in time"
    return thread


# -- primary protection: fail fast instead of silently queuing ------------------------------


def test_offline_edits_and_structural_changes_fail_fast_while_a_deploy_is_in_flight(tmp_path):
    service, facade, store = _service_with_blocking_facade(tmp_path)
    deploy_thread = _run_deploy_in_background(service, facade)

    checks = [
        lambda: service.update_lab_conf("testlab", 'pc1[image]="kathara/base"\n'),
        lambda: service.fs_write_text_offline("testlab", "/notes.txt", "hi\n"),
        lambda: service.fs_mkdir_offline("testlab", "/scratch"),
        lambda: service.fs_delete_offline("testlab", "/notes.txt"),
        lambda: service.fs_move_offline("testlab", "/notes.txt", "/notes2.txt"),
        lambda: service.add_machine("testlab", MachineCreate(name="pc2", image="kathara/base")),
        lambda: service.update_machine("testlab", "pc1", MachineCreate(name="pc1", image="kathara/base")),
        lambda: service.remove_machine("testlab", "pc1"),
        lambda: service.connect_machine("testlab", "pc1", "A"),
        lambda: service.disconnect_machine("testlab", "pc1", "A"),
        lambda: service.add_link("testlab", "B"),
        lambda: service.remove_link("testlab", "A"),
        lambda: service.rename_lab("testlab", "renamed"),
        lambda: service.delete_lab("testlab"),
    ]
    for call in checks:
        with pytest.raises(LabTransitioningError):
            call()

    # None of the attempts above actually blocked waiting on _mutate_lock (they all raised
    # immediately), so the still-paused deploy_lab thread must still be exactly where it was.
    assert not facade.release.is_set()

    facade.release.set()
    deploy_thread.join(timeout=2)


def test_mutating_calls_work_again_once_the_deploy_finishes(tmp_path):
    service, facade, store = _service_with_blocking_facade(tmp_path)
    deploy_thread = _run_deploy_in_background(service, facade)
    with pytest.raises(LabTransitioningError):
        service.fs_write_text_offline("testlab", "/notes.txt", "hi\n")

    facade.release.set()
    deploy_thread.join(timeout=2)

    service.fs_write_text_offline("testlab", "/notes.txt", "hi\n")
    assert (store.lab_dir("testlab") / "notes.txt").read_text() == "hi\n"


def test_transitioning_flag_is_cleared_even_if_deploy_lab_raises(tmp_path):
    """A failed deploy must not leave the lab permanently stuck as "transitioning" — every
    mutating call against it would be rejected forever, with no way out short of a process
    restart. Guards the `try`/`finally` around deploy_lab's body."""
    store = LabStore(tmp_path / "labs")
    service = KatharaService(store=store)
    service._instance = _RaisingDeployFacade()
    service.create_lab(LabCreate(name="testlab", machines=[MachineCreate(name="pc1", image="kathara/base")]))

    with pytest.raises(RuntimeError):
        service.deploy_lab("testlab")

    service.fs_write_text_offline("testlab", "/notes.txt", "hi\n")
    assert (store.lab_dir("testlab") / "notes.txt").read_text() == "hi\n"


# -- fallback protection: correct even if a mutator slips past the fast-fail check ----------


def test_connect_machine_still_waits_for_the_lock_if_it_slips_past_the_fast_fail_check(tmp_path, monkeypatch):
    service, facade, store = _service_with_blocking_facade(tmp_path)
    deploy_thread = _run_deploy_in_background(service, facade)
    monkeypatch.setattr(service, "_check_not_transitioning", lambda name: None)

    connect_done = threading.Event()
    result: dict = {}

    def run_connect():
        result["machine"] = service.connect_machine("testlab", "pc1", "A")
        connect_done.set()

    connect_thread = threading.Thread(target=run_connect)
    connect_thread.start()

    # With the lock-discipline fix, connect_machine blocks acquiring `_mutate_lock` (still held by
    # the in-flight deploy) instead of reading `machine.api_object` immediately and proceeding on
    # stale state.
    assert not connect_done.wait(timeout=0.3), (
        "connect_machine returned before the in-flight deploy_lab finished — "
        "it read machine.api_object before acquiring the lock instead of after"
    )

    facade.release.set()  # let deploy_lab's facade call finish, setting pc1.api_object
    deploy_thread.join(timeout=2)
    connect_thread.join(timeout=2)
    assert connect_done.is_set()

    # pc1 was running by the time connect_machine's branch decision actually ran, so the
    # interface must have been connected live — not written into lab.conf as if pc1 were stopped.
    assert facade.calls == ["connect_live"]
    assert result["machine"].api_object is not None
    conf_text = store.read_lab_conf_text("testlab") or ""
    assert "pc1[0]" not in conf_text, "interface was written to lab.conf despite pc1 being running"


def test_disconnect_machine_still_waits_for_the_lock_if_it_slips_past_the_fast_fail_check(tmp_path, monkeypatch):
    service, facade, store = _service_with_blocking_facade(tmp_path)
    # Give pc1 a stopped-state interface to disconnect once it's "running". pc1 isn't deployed
    # yet, so this takes the stopped branch (a lab.conf edit) and never touches the facade.
    service.connect_machine("testlab", "pc1", "A")
    assert facade.calls == []
    assert "pc1[0]" in (store.read_lab_conf_text("testlab") or "")

    deploy_thread = _run_deploy_in_background(service, facade)
    monkeypatch.setattr(service, "_check_not_transitioning", lambda name: None)

    disconnect_done = threading.Event()

    def run_disconnect():
        service.disconnect_machine("testlab", "pc1", "A")
        disconnect_done.set()

    disconnect_thread = threading.Thread(target=run_disconnect)
    disconnect_thread.start()

    assert not disconnect_done.wait(timeout=0.3), (
        "disconnect_machine returned before the in-flight deploy_lab finished"
    )

    facade.release.set()
    deploy_thread.join(timeout=2)
    disconnect_thread.join(timeout=2)
    assert disconnect_done.is_set()

    # pc1 was running by the time disconnect_machine's branch decision ran, so this must have been
    # a live disconnect — the lab.conf interface line must survive untouched (only a runtime-only
    # change should happen against a running device, never a lab.conf edit).
    assert facade.calls == ["disconnect_live"]
    assert "pc1[0]" in (store.read_lab_conf_text("testlab") or "")


def test_remove_machine_still_waits_for_the_lock_if_it_slips_past_the_fast_fail_check(tmp_path, monkeypatch):
    """Narrower than the two above (remove_machine has no stopped-vs-running branch to pick), but
    the same discipline applies: `lab`/`machine` must be read after the lock, not before, or the
    facade could undeploy a `machine` object a concurrent deploy_lab is still populating."""
    service, facade, store = _service_with_blocking_facade(tmp_path)
    deploy_thread = _run_deploy_in_background(service, facade)
    monkeypatch.setattr(service, "_check_not_transitioning", lambda name: None)

    remove_done = threading.Event()

    def run_remove():
        service.remove_machine("testlab", "pc1")
        remove_done.set()

    remove_thread = threading.Thread(target=run_remove)
    remove_thread.start()

    assert not remove_done.wait(timeout=0.3), "remove_machine returned before the in-flight deploy_lab finished"

    facade.release.set()
    deploy_thread.join(timeout=2)
    remove_thread.join(timeout=2)
    assert remove_done.is_set()
    assert facade.calls == ["undeploy_machine"]
