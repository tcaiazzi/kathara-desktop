"""Regression tests for two layered protections against a lab.conf/offline-fs edit or a
structural change (device/link add/remove/connect/disconnect, rename, delete) racing a
`deploy_lab`/`undeploy_lab` on the same lab — no Docker required.

**Primary protection** (`_check_not_transitioning`): every one of those operations fails
immediately with `LabTransitioningError` if the target lab is mid deploy/undeploy, rather than
silently queuing behind `_mutate_lock` for however long that takes and only then succeeding or
failing on whatever state exists by the time it wakes up. Confirmed reachable through the shipped
UI, not just a raw concurrent API client: nothing in `useDeviceActions` or the topology context
menu is gated by the same `busy` flag that disables Deploy/Undeploy, so a user can click Deploy
and, before it returns, right-click the same device and connect/disconnect/remove it, or switch to
the Lab Configuration tab and save an edit.

**Lab creation** is a third, separate race (`test_*_create*`): the four creation paths
(`create_lab`/`upload_lab`/`install_example`/`install_gallery_lab`) check "is this name free?"
and only *then* write to disk, so with nothing held in between two concurrent creates of the
same name both pass the check and both write. The damage is not a merely theoretical
interleaving: the loser's rollback deletes the *winner's* freshly written directory (the winner
keeping its 201 and its registry entry, with no files left on disk), or the loser's swap
replaces the winner's files while the registry keeps the winner's model — and an N-way race
produces raw `FileExistsError`/`FileNotFoundError` 500s instead of clean 409s. They are
serialized per lab *name* (`_claiming_name`) rather than behind `_mutate_lock`, because the
critical section contains the on-disk write itself and holding the global lock across a large
.zip extraction would stall unrelated labs' deploys.

**Fallback protection** (the `_mutate_lock` discipline): the primary check above has an
inherent, unavoidable TOCTOU gap — a `deploy_lab` can start in the instant *after* a mutator
passes the check but *before* it acquires `_mutate_lock`. `connect_machine`/`disconnect_machine`/
`remove_machine`/`copy_files`/`fs_upload_bytes`/`add_link`/`remove_link` therefore read
`lab`/`machine` — and, for connect/disconnect, decide their whole stopped-vs-running branch from
`machine.api_object` — *inside* that lock, never before acquiring it, the same way `add_machine`
documents. Reading before the lock leaves a mutator caught in the gap working from stale state
once it does proceed; reading inside it keeps even a slipped-through mutator correct, merely not
fast. The tests for this layer bypass `_check_not_transitioning` via monkeypatch specifically to
force that gap and exercise the lock behavior underneath it, the same way a real race would.
"""

import collections
import threading

import pytest
from Kathara.exceptions import MachineNotRunningError

from kathara_api.errors import LabAlreadyRegisteredError, LabTransitioningError
from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import MachineCreate
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase, make_lab, make_service, zip_bytes


class _BlockingFacade(FakeFacadeBase):
    """Like FakeFacadeBase, but `deploy_lab` pauses (while the caller still holds `_mutate_lock`,
    since the service wraps this call in it) until released, and every call is recorded so tests
    can assert exactly which branch of the operation under test actually ran."""

    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.undeploy_entered = threading.Event()
        self.undeploy_release = threading.Event()
        self.calls: list[str] = []

    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        self.entered.set()
        self.release.wait(timeout=5)
        for name in selected_machines or lab.machines.keys():
            machine = lab.machines.get(name)
            if machine is not None:
                machine.api_object = object()

    def undeploy_lab(self, **kwargs):
        self.undeploy_entered.set()
        self.undeploy_release.wait(timeout=5)

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
    service = make_service(store=store, facade=_RaisingDeployFacade())
    service.create_lab(LabCreate(name="testlab", machines=[MachineCreate(name="pc1", image="kathara/base")]))

    with pytest.raises(RuntimeError):
        service.deploy_lab("testlab")

    service.fs_write_text_offline("testlab", "/notes.txt", "hi\n")
    assert (store.lab_dir("testlab") / "notes.txt").read_text() == "hi\n"


# -- deploy_lab/undeploy_lab self-exclusion ---------------------------------------------------
#
# Everything above guards *other* mutators against an in-flight deploy/undeploy. deploy_lab and
# undeploy_lab also have to guard against *each other*, and `_begin_transition` alone does not do
# it: it is a plain `set.add`, not a lock, so without each calling `_check_not_transitioning` on
# itself first, two concurrent deploy_lab calls on the same lab both proceed — each computing its
# own fresh/already-running split from a `Lab` the other is mutating at the same time, colliding
# inside the facade call. Both bodies therefore sit entirely inside `_mutate_lock`, not just the
# facade call.


def _run_undeploy_in_background(service: KatharaService, facade: "_BlockingFacade") -> threading.Thread:
    thread = threading.Thread(target=lambda: service.undeploy_lab("testlab"))
    thread.start()
    assert facade.undeploy_entered.wait(timeout=2), "undeploy_lab did not reach the facade call in time"
    return thread


def test_deploy_lab_fails_fast_against_a_concurrent_deploy_of_the_same_lab(tmp_path):
    service, facade, store = _service_with_blocking_facade(tmp_path)
    deploy_thread = _run_deploy_in_background(service, facade)

    with pytest.raises(LabTransitioningError):
        service.deploy_lab("testlab")

    # The rejected call never blocked waiting on _mutate_lock either — it failed before trying.
    assert not facade.release.is_set()

    facade.release.set()
    deploy_thread.join(timeout=2)


def test_undeploy_lab_fails_fast_against_a_concurrent_undeploy_of_the_same_lab(tmp_path):
    service, facade, store = _service_with_blocking_facade(tmp_path)
    undeploy_thread = _run_undeploy_in_background(service, facade)

    with pytest.raises(LabTransitioningError):
        service.undeploy_lab("testlab")

    assert not facade.undeploy_release.is_set()

    facade.undeploy_release.set()
    undeploy_thread.join(timeout=2)


def test_deploy_lab_still_waits_for_the_lock_if_it_slips_past_the_fast_fail_check(tmp_path, monkeypatch):
    """The self-check above is fast-fail only; deploy_lab's whole body living inside
    `_mutate_lock` — not just the facade call — is what keeps a slipped-through second call
    *correct* rather than merely rejected. Reading `lab.machines`/`api_object` outside the lock
    lets two concurrent calls both see pc1 as "fresh" and both hand it to the facade."""
    service, facade, store = _service_with_blocking_facade(tmp_path)
    deploy_thread = _run_deploy_in_background(service, facade)
    monkeypatch.setattr(service, "_check_not_transitioning", lambda name: None)

    # Tracks calls made *after* the monkeypatch above, i.e. only by the second deploy_lab — the
    # first call is already running inside the class's own (unpatched) deploy_lab by this point.
    second_calls: list[set] = []
    original_deploy_lab = facade.deploy_lab

    def counting_deploy_lab(lab, selected_machines=None, excluded_machines=None):
        second_calls.append(set(selected_machines or []))
        return original_deploy_lab(lab, selected_machines=selected_machines, excluded_machines=excluded_machines)

    facade.deploy_lab = counting_deploy_lab

    second_done = threading.Event()
    result: dict = {}

    def run_second_deploy():
        result["lab"] = service.deploy_lab("testlab")
        second_done.set()

    second_thread = threading.Thread(target=run_second_deploy)
    second_thread.start()

    # If deploy_lab's body still ran outside _mutate_lock, this would return immediately, having
    # read pc1 as not-yet-running and handed it to the facade a second time.
    assert not second_done.wait(timeout=0.3), (
        "a second deploy_lab returned before the in-flight one finished — "
        "it read lab.machines/api_object before acquiring the lock instead of after"
    )

    facade.release.set()
    deploy_thread.join(timeout=2)
    second_thread.join(timeout=2)
    assert second_done.is_set()

    # pc1 was already running by the time the second call's fresh/already-running split actually
    # ran, so the facade's deploy_lab must not have been asked to (re-)create it.
    assert second_calls == []
    assert result["lab"].machines["pc1"].api_object is not None


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


class _CopyRecordingFacade(FakeFacadeBase):
    """Deploys for real, so a device ends up with an ``api_object``, and records every
    ``copy_files`` so a test can tell whether the copy reached the facade at all."""

    def __init__(self):
        self.copied: list[object] = []

    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        for machine in lab.machines.values():
            machine.api_object = object()

    def copy_files(self, machine, guest_to_host):
        self.copied.append(machine)


def test_fs_upload_bytes_resolves_the_device_inside_the_lock(tmp_path, monkeypatch):
    """The binary-upload path must resolve the device *inside* `_mutate_lock`, the same way
    `copy_files` does and `fs_write_text` gets for free by delegating to it. Resolved before the
    lock, the `Machine` it hands the facade can have been stopped by a concurrent undeploy while
    it waited, and the copy then runs against an `api_object` nobody confirmed was still live.

    `normalize_guest_path` is the pause point because it runs before the lock either way: the
    question the test asks is whether the *device* has also been resolved by then.
    """
    service = KatharaService(store=LabStore(tmp_path / "labs"))
    facade = _CopyRecordingFacade()
    service._instance = facade
    service.create_lab(LabCreate(name="testlab", machines=[MachineCreate(name="pc1", image="kathara/base")]))
    service.deploy_lab("testlab")

    in_window, release = threading.Event(), threading.Event()
    real_normalize = service.normalize_guest_path

    def pause_before_the_lock(path: str) -> str:
        in_window.set()
        assert release.wait(timeout=5), "the test never released the suspended upload"
        return real_normalize(path)

    monkeypatch.setattr(service, "normalize_guest_path", pause_before_the_lock)

    outcome: list[object] = []

    def run_upload():
        try:
            outcome.append(service.fs_upload_bytes("testlab", "pc1", "/tmp/x.bin", b"\x00\x01"))
        except MachineNotRunningError as exc:
            outcome.append(exc)

    upload = threading.Thread(target=run_upload)
    upload.start()
    assert in_window.wait(timeout=2), "fs_upload_bytes never reached its pre-lock window"

    # The device goes down while the upload sits in that window — `_mutate_lock` is still free,
    # so this undeploy runs to completion before the upload ever asks for it.
    service.undeploy_lab("testlab")

    release.set()
    upload.join(timeout=5)

    assert facade.copied == [], "the copy ran against a device that had already been stopped"
    assert isinstance(outcome[0], MachineNotRunningError)


# -- lab creation races ---------------------------------------------------------------------


def _plain_service(tmp_path) -> KatharaService:
    service = make_service(store=LabStore(tmp_path / "labs"))
    return service


def _pause_inside(store, method_name: str):
    """Suspend `store.<method_name>` on entry, so a create can be held *inside* `_claiming_name`
    (every one of these store calls is made from within it) while a second create is attempted.

    That is the window `_claiming_name` has to close: unheld, the second create sails straight
    through the check-then-write gap while the first is suspended here.
    """
    paused, release = threading.Event(), threading.Event()
    real = getattr(store, method_name)

    def wrapper(*args, **kwargs):
        paused.set()
        assert release.wait(timeout=10), "the test never released the suspended create"
        return real(*args, **kwargs)

    setattr(store, method_name, wrapper)
    return paused, release, real


def test_a_second_import_of_the_same_name_waits_and_then_gets_a_clean_409(tmp_path):
    service = _plain_service(tmp_path)
    paused, release, real_extract = _pause_inside(service.store, "extract_zip")

    winner = threading.Thread(
        target=lambda: make_lab(service, "dup", {"lab.conf": "pcwin[image]=kathara/base\n"}, [])
    )
    winner.start()
    assert paused.wait(timeout=3), "the first import never reached its on-disk write"
    service.store.extract_zip = real_extract  # the loser takes the normal path

    loser_done = threading.Event()
    errors = []

    def run_loser():
        try:
            make_lab(service, "dup", {"lab.conf": "pclose[image]=kathara/base\n"}, [])
        except Exception as exc:  # noqa: BLE001 — the type is the assertion
            errors.append(exc)
        loser_done.set()

    loser = threading.Thread(target=run_loser)
    loser.start()
    # The whole point of the per-name lock: the second create must *wait*, not proceed into the
    # window between the first one's check and its write.
    assert not loser_done.wait(timeout=0.5), "the second import did not wait for the first"

    release.set()
    winner.join(timeout=5)
    loser.join(timeout=5)

    assert [type(e) for e in errors] == [LabAlreadyRegisteredError]
    lab_dir = service.store.lab_dir("dup")
    assert lab_dir.is_dir(), "the loser's rollback deleted the winner's directory"
    assert lab_dir.joinpath("lab.conf").read_text() == "pcwin[image]=kathara/base\n"
    assert set(service.registry.get("dup").machines) == {"pcwin"}


def test_an_upload_racing_another_of_the_same_name_does_not_overwrite_it(tmp_path):
    """The loser's atomic swap must not `rmtree` the published directory and put *its* files
    there while the registry keeps the winner's model — a silent disagreement between disk and
    memory, with the loser reporting a 409 as if nothing had happened.
    """
    service = _plain_service(tmp_path)
    paused, release, real_extract = _pause_inside(service.store, "extract_zip")

    winner = threading.Thread(
        target=lambda: service.upload_lab(
            "dup", zip_bytes({"lab.conf": b"pcwin[image]=kathara/base\n", "winner_was_here": b"x"})
        )
    )
    winner.start()
    assert paused.wait(timeout=3)
    service.store.extract_zip = real_extract

    errors = []

    def run_loser():
        try:
            make_lab(service, "dup", {"lab.conf": "pclose[image]=kathara/base\n", "loser_was_here": "x"}, [])
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    loser = threading.Thread(target=run_loser)
    loser.start()
    release.set()
    winner.join(timeout=5)
    loser.join(timeout=5)

    assert [type(e) for e in errors] == [LabAlreadyRegisteredError]
    names = {p.name for p in service.store.lab_dir("dup").iterdir()}
    assert names == {"lab.conf", "winner_was_here"}, f"the loser's files landed on disk: {names}"
    assert set(service.registry.get("dup").machines) == {"pcwin"}


def test_n_concurrent_imports_of_one_name_yield_one_success_and_the_rest_409(tmp_path):
    """No 500s (the shared `.<name>.tmp` scratch produced raw FileExistsError/FileNotFoundError),
    no leftover scratch directories, and a lab whose on-disk files all come from one import."""
    service = _plain_service(tmp_path)
    n = 8
    start = threading.Barrier(n)
    outcomes = []

    def worker(i):
        start.wait()
        try:
            make_lab(service, 
                "dup",
                {"lab.conf": f"pc{i}[image]=kathara/base\n", f"pc{i}/etc/hosts": "x" * 2000},
                [f"pc{i}/etc"],
            )
            outcomes.append("created")
        except LabAlreadyRegisteredError:
            outcomes.append("conflict")
        except Exception as exc:  # noqa: BLE001 — anything else is the bug
            outcomes.append(f"unexpected: {type(exc).__name__}: {exc}")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert collections.Counter(outcomes) == {"created": 1, "conflict": n - 1}

    lab_dir = service.store.lab_dir("dup")
    files = sorted(p.relative_to(lab_dir).as_posix() for p in lab_dir.rglob("*") if p.is_file())
    assert len(files) == 2, files
    # The lab.conf and the device file must come from the *same* import, not a mix of two.
    device = files[1].split("/")[0]
    assert lab_dir.joinpath("lab.conf").read_text() == f"{device}[image]=kathara/base\n"

    leftovers = [p.name for p in lab_dir.parent.iterdir() if p.name.startswith(".")]
    assert leftovers == [], f"scratch directories left behind: {leftovers}"


def test_deleting_a_lab_cannot_land_inside_a_concurrent_import_of_the_same_name(tmp_path):
    """`delete_lab`'s unregister + rmtree pair runs under a lock: outside one, it removes the
    directory an import has just written."""
    service = _plain_service(tmp_path)
    make_lab(service, "dup", {"lab.conf": "pcold[image]=kathara/base\n"}, [])
    paused, release, real_delete = _pause_inside(service.store, "delete_lab")

    deleter = threading.Thread(target=lambda: service.delete_lab("dup"))
    deleter.start()
    assert paused.wait(timeout=3)
    service.store.delete_lab = real_delete

    import_done = threading.Event()

    def run_import():
        make_lab(service, "dup", {"lab.conf": "pcnew[image]=kathara/base\n"}, [])
        import_done.set()

    importer = threading.Thread(target=run_import)
    importer.start()
    assert not import_done.wait(timeout=0.5), "the import did not wait for the in-flight delete"

    release.set()
    deleter.join(timeout=5)
    importer.join(timeout=5)

    assert import_done.is_set()
    assert service.store.lab_dir("dup").joinpath("lab.conf").read_text() == "pcnew[image]=kathara/base\n"
    assert set(service.registry.get("dup").machines) == {"pcnew"}
