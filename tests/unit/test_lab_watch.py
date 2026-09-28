"""Changes to a lab made outside this app — its lab.conf and startup scripts on disk, its devices
in Docker — (no Docker required).

Three layers: the poller that notices a file changed (``LabWatcher``), what the service does about
it (``KatharaService.handle_disk_change``, ``KatharaService.check_running_labs``), and the event
stream that tells the frontend (``LabEvents``, ``GET /api/events``).
"""

import asyncio
import json
import os
import shutil
import threading
from types import SimpleNamespace

import pytest
from docker.errors import DockerException
from fastapi.testclient import TestClient
from Kathara.exceptions import DockerDaemonConnectionError
from Kathara.utils import get_current_user_name

from kathara_api import main as main_module
from kathara_api.config import get_settings
from kathara_api.dependencies import get_service
from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import MachineCreate
from kathara_api.services.lab_events import LabEvents
from kathara_api.services.lab_store import LabStore
from kathara_api.services.lab_watch import LabWatcher, is_watched
from tests.helpers import lab_id, make_lab, make_service

LAB_CONF = 'pc1[image]="kathara/base"\npc1[0]="A"\n'


def _bump(path, text):
    """Write ``text`` and make sure the mtime moves, however coarse the filesystem's clock."""
    before = path.stat().st_mtime_ns if path.exists() else 0
    path.write_text(text)
    stat = path.stat()
    if stat.st_mtime_ns == before:
        os.utime(path, ns=(stat.st_atime_ns, before + 1_000_000))


# -- the poller --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,watched",
    [("lab.conf", True), ("pc1.startup", True), ("shared.startup", True), (".startup", False),
     ("lab.layout", False), ("pc1.shutdown", False), ("notes.txt", False)],
)
def test_only_lab_conf_and_startup_scripts_are_watched(name, watched):
    assert is_watched(name) is watched


class _Recorder:
    """Records each call, and hands back as not-yet-handled whatever names `pending` holds."""

    def __init__(self, pending=()):
        self.calls: list[tuple[str, set[str]]] = []
        self.pending = set(pending)

    def __call__(self, lab_id, files):
        self.calls.append((lab_id, set(files)))
        return files & self.pending


@pytest.fixture
def lab_dir(tmp_path):
    directory = tmp_path / "lab"
    directory.mkdir()
    (directory / "lab.conf").write_text(LAB_CONF)
    (directory / "pc1.startup").write_text("ip a\n")
    return directory


def test_the_first_poll_of_a_lab_only_sets_its_baseline(lab_dir):
    recorder = _Recorder()
    LabWatcher(lambda: {"L": lab_dir}, recorder).poll_once()

    assert recorder.calls == []


def test_changed_added_and_removed_files_are_reported_together_once(lab_dir):
    recorder = _Recorder()
    watcher = LabWatcher(lambda: {"L": lab_dir}, recorder)
    watcher.poll_once()

    _bump(lab_dir / "lab.conf", LAB_CONF + "pc2[0]=A\n")
    (lab_dir / "shared.startup").write_text("echo hi\n")
    (lab_dir / "pc1.startup").unlink()
    (lab_dir / "notes.txt").write_text("not watched\n")
    watcher.poll_once()
    watcher.poll_once()

    assert recorder.calls == [("L", {"lab.conf", "shared.startup", "pc1.startup"})]


def test_a_change_not_handled_yet_is_reported_again(lab_dir):
    recorder = _Recorder(pending={"pc1.startup"})
    watcher = LabWatcher(lambda: {"L": lab_dir}, recorder)
    watcher.poll_once()
    _bump(lab_dir / "pc1.startup", "ip r\n")

    watcher.poll_once()
    recorder.pending = set()
    watcher.poll_once()
    watcher.poll_once()

    assert recorder.calls == [("L", {"pc1.startup"})] * 2


def test_only_the_names_handed_back_are_reported_again(lab_dir):
    """A lab.conf waiting for the lab to be undeployed must not make a startup change that was
    already dealt with come back on every poll."""
    recorder = _Recorder(pending={"lab.conf"})
    watcher = LabWatcher(lambda: {"L": lab_dir}, recorder)
    watcher.poll_once()
    _bump(lab_dir / "lab.conf", LAB_CONF + "pc2[0]=A\n")
    _bump(lab_dir / "pc1.startup", "ip r\n")

    watcher.poll_once()
    watcher.poll_once()

    assert recorder.calls == [("L", {"lab.conf", "pc1.startup"}), ("L", {"lab.conf"})]


def test_a_failing_reaction_does_not_stop_the_other_labs(tmp_path, lab_dir):
    other = tmp_path / "other"
    other.mkdir()
    (other / "lab.conf").write_text(LAB_CONF)
    seen = []

    def on_change(lab, files):
        seen.append(lab)
        if lab == "bad":
            raise RuntimeError("boom")
        return set()

    watcher = LabWatcher(lambda: {"bad": lab_dir, "good": other}, on_change)
    watcher.poll_once()
    _bump(lab_dir / "lab.conf", "x\n")
    _bump(other / "lab.conf", "y\n")
    watcher.poll_once()
    watcher.poll_once()

    assert sorted(seen) == ["bad", "good"]


def test_a_lab_that_is_no_longer_listed_is_forgotten_and_starts_over(lab_dir):
    recorder = _Recorder()
    labs = {"L": lab_dir}
    watcher = LabWatcher(lambda: dict(labs), recorder)
    watcher.poll_once()
    del labs["L"]
    watcher.poll_once()
    _bump(lab_dir / "lab.conf", "changed while not listed\n")
    labs["L"] = lab_dir

    watcher.poll_once()

    assert recorder.calls == []  # back to a fresh baseline, not a stale comparison


def test_a_folder_that_is_gone_reports_every_file_as_changed(lab_dir):
    recorder = _Recorder()
    watcher = LabWatcher(lambda: {"L": lab_dir}, recorder)
    watcher.poll_once()

    shutil.rmtree(lab_dir)
    watcher.poll_once()

    assert recorder.calls == [("L", {"lab.conf", "pc1.startup"})]


def test_a_folder_that_cannot_be_listed_for_a_moment_is_skipped_not_taken_for_empty(lab_dir, monkeypatch):
    """A listing that fails says nothing about the files: nothing is reported, and once the folder
    lists again the baseline is the one from before, so nothing is reported then either."""
    recorder = _Recorder()
    watcher = LabWatcher(lambda: {"L": lab_dir}, recorder)
    watcher.poll_once()
    real_scandir = os.scandir

    def unlistable(path):
        if os.fspath(path) == os.fspath(lab_dir):
            raise PermissionError(13, "Permission denied", os.fspath(path))
        return real_scandir(path)

    monkeypatch.setattr(os, "scandir", unlistable)
    watcher.poll_once()
    monkeypatch.setattr(os, "scandir", real_scandir)
    watcher.poll_once()

    assert recorder.calls == []


def test_the_poll_hook_runs_on_every_poll_and_a_failure_in_it_stops_nothing(lab_dir):
    recorder = _Recorder()
    calls = []

    def hook():
        calls.append(1)
        raise RuntimeError("boom")

    watcher = LabWatcher(lambda: {"L": lab_dir}, recorder, on_poll=hook)
    watcher.poll_once()
    _bump(lab_dir / "lab.conf", LAB_CONF + "# edited\n")
    watcher.poll_once()

    assert len(calls) == 2
    assert recorder.calls == [("L", {"lab.conf"})]


def test_the_thread_polls_until_stopped(lab_dir):
    changed = threading.Event()
    watcher = LabWatcher(lambda: {"L": lab_dir}, lambda *_: changed.set() or set(), interval=0.01)
    watcher.start()
    try:
        threading.Event().wait(0.05)  # let the first poll set the baseline
        _bump(lab_dir / "lab.conf", "changed\n")
        assert changed.wait(2)
    finally:
        watcher.stop()


# -- what the service does ---------------------------------------------------------------------


def _collecting(service):
    """Every event the service publishes, in order."""
    published: list[dict] = []
    service.events.publish = published.append
    return published


@pytest.fixture
def service(tmp_path):
    service = make_service(LabStore(tmp_path / "labs"))
    make_lab(service, "demo", {"lab.conf": LAB_CONF, "pc1.startup": "ip a\n"})
    return service


def test_an_outside_edit_to_lab_conf_reloads_the_lab(service):
    events = _collecting(service)
    demo = lab_id(service, "demo")
    (service.store.lab_dir("demo") / "lab.conf").write_text(LAB_CONF + 'pc2[0]="A"\n')

    assert service.handle_disk_change(demo, {"lab.conf"}) == set()

    assert sorted(service.registry.get(demo).machines) == ["pc1", "pc2"]
    assert events == [{"lab_id": demo, "kind": "conf-reloaded", "files": ["lab.conf"], "detail": None}]


def test_a_lab_conf_this_app_wrote_itself_is_reloaded_without_an_event(service):
    """Nothing to tell anyone about — but the model is rebuilt anyway, so an outside edit the app's
    own edit was built on top of still reaches it."""
    events = _collecting(service)
    demo = lab_id(service, "demo")
    service.update_lab_conf(demo, LAB_CONF + 'pc3[0]="A"\n')
    service.add_machine(demo, MachineCreate(name="pc4"))

    assert service.handle_disk_change(demo, {"lab.conf"}) == set()

    assert sorted(service.registry.get(demo).machines) == ["pc1", "pc3", "pc4"]
    assert events == []


def test_an_outside_edit_the_app_then_built_on_reaches_the_model(service):
    events = _collecting(service)
    demo = lab_id(service, "demo")
    (service.store.lab_dir("demo") / "lab.conf").write_text(LAB_CONF + 'pc7[0]="A"\n')
    service.add_machine(demo, MachineCreate(name="pc8"))  # its base text already has pc7

    service.handle_disk_change(demo, {"lab.conf"})

    assert {"pc7", "pc8"} <= set(service.registry.get(demo).machines)
    assert events == []


def test_an_outside_revert_to_the_apps_own_text_is_applied_and_reported(service):
    events = _collecting(service)
    demo = lab_id(service, "demo")
    conf = service.store.lab_dir("demo") / "lab.conf"
    service.update_lab_conf(demo, LAB_CONF)
    conf.write_text(LAB_CONF + 'pc3[0]="A"\n')
    service.handle_disk_change(demo, {"lab.conf"})

    conf.write_text(LAB_CONF)  # an editor's undo, a `git checkout lab.conf`
    service.handle_disk_change(demo, {"lab.conf"})

    assert "pc3" not in service.registry.get(demo).machines
    assert [e["kind"] for e in events] == ["conf-reloaded", "conf-reloaded"]


def test_an_outside_edit_after_one_of_ours_is_still_seen(service):
    events = _collecting(service)
    demo = lab_id(service, "demo")
    service.update_lab_conf(demo, LAB_CONF)
    (service.store.lab_dir("demo") / "lab.conf").write_text(LAB_CONF + 'pc9[0]="A"\n')

    service.handle_disk_change(demo, {"lab.conf"})

    assert "pc9" in service.registry.get(demo).machines
    assert [e["kind"] for e in events] == ["conf-reloaded"]


def test_a_deployed_lab_is_not_rebuilt_under_its_running_devices(service):
    events = _collecting(service)
    demo = lab_id(service, "demo")
    model = service.registry.get(demo)
    model.machines["pc1"].api_object = object()
    (service.store.lab_dir("demo") / "lab.conf").write_text(LAB_CONF + 'pc2[0]="A"\n')

    service.handle_disk_change(demo, {"lab.conf"})

    assert service.registry.get(demo) is model
    assert [e["kind"] for e in events] == ["conf-pending"]


def test_a_pending_lab_conf_applies_once_the_lab_stops_even_from_outside_the_app(service):
    """Stopped with `kathara lclean` in its folder, the lab's devices lose their containers without
    this app undeploying anything; the lab.conf that was waiting must then apply."""
    events = _collecting(service)
    demo = lab_id(service, "demo")
    service.registry.get(demo).machines["pc1"].api_object = object()
    (service.store.lab_dir("demo") / "lab.conf").write_text(LAB_CONF + 'pc2[0]="A"\n')

    assert service.handle_disk_change(demo, {"lab.conf", "pc1.startup"}) == {"lab.conf"}
    assert service.handle_disk_change(demo, {"lab.conf"}) == {"lab.conf"}  # still up: told once
    service.registry.get(demo).machines["pc1"].api_object = None  # its containers went away
    assert service.handle_disk_change(demo, {"lab.conf"}) == set()

    assert sorted(service.registry.get(demo).machines) == ["pc1", "pc2"]
    assert [e["kind"] for e in events] == ["conf-pending", "startup", "conf-reloaded"]


def test_a_lab_conf_that_does_not_parse_keeps_the_current_model(service):
    events = _collecting(service)
    demo = lab_id(service, "demo")
    model = service.registry.get(demo)
    (service.store.lab_dir("demo") / "lab.conf").write_text('pc1[image="broken\n')

    service.handle_disk_change(demo, {"lab.conf"})

    assert service.registry.get(demo) is model
    assert [e["kind"] for e in events] == ["conf-invalid"]
    assert events[0]["detail"]


def test_a_changed_startup_marks_its_device_dirty_for_the_next_redeploy(service):
    events = _collecting(service)
    demo = lab_id(service, "demo")

    service.handle_disk_change(demo, {"pc1.startup", "ghost.startup"})

    assert service.registry.pop_dirty_machines(demo, {"pc1"}) == {"pc1"}
    assert events == [{"lab_id": demo, "kind": "startup", "files": ["ghost.startup", "pc1.startup"], "detail": None}]


def test_a_changed_shared_startup_marks_every_device_dirty(tmp_path):
    service = make_service(LabStore(tmp_path / "labs"))
    service.create_lab(LabCreate(name="two", machines=[MachineCreate(name="pc1"), MachineCreate(name="pc2")]))
    two = lab_id(service, "two")

    service.handle_disk_change(two, {"shared.startup"})

    assert service.registry.pop_dirty_machines(two, {"pc1", "pc2"}) == {"pc1", "pc2"}


def test_a_lab_mid_deploy_is_asked_about_again_later(service):
    events = _collecting(service)
    demo = lab_id(service, "demo")
    service._begin_transition(demo)

    assert service.handle_disk_change(demo, {"pc1.startup"}) == {"pc1.startup"}
    assert events == []


def test_a_lab_waits_rather_than_stall_the_watcher_behind_another_labs_deploy(service, monkeypatch):
    """Another lab's deploy holds `_mutate_lock` for minutes; the watcher serves every lab."""
    monkeypatch.setattr(service, "_DISK_CHANGE_LOCK_WAIT_S", 0.01)
    demo = lab_id(service, "demo")
    held = threading.Event()
    release = threading.Event()

    def hold_the_lock():
        with service._mutate_lock:
            held.set()
            release.wait(5)

    holder = threading.Thread(target=hold_the_lock)
    holder.start()
    held.wait(5)
    try:
        assert service.handle_disk_change(demo, {"pc1.startup"}) == {"pc1.startup"}
    finally:
        release.set()
        holder.join()


def test_a_stopped_lab_whose_folder_is_gone_is_dropped_and_reported_missing(service):
    events = _collecting(service)
    demo = lab_id(service, "demo")
    shutil.rmtree(service.store.lab_dir("demo"))

    assert service.handle_disk_change(demo, {"lab.conf", "pc1.startup"}) == set()

    assert service.registry.get(demo) is None
    assert service.list_labs() == []
    assert events == [{"lab_id": demo, "kind": "missing", "files": ["lab.conf", "pc1.startup"], "detail": None}]


def test_a_deployed_lab_whose_folder_is_gone_stays_listed_until_it_stops(service):
    """Dropping it while its containers run would leave them with nothing listing them, so it is
    reported once, kept, and dropped when it stops — from the app or with `kathara lclean`."""
    events = _collecting(service)
    demo = lab_id(service, "demo")
    service.registry.get(demo).machines["pc1"].api_object = object()
    shutil.rmtree(service.store.lab_dir("demo"))

    assert service.handle_disk_change(demo, {"lab.conf"}) == {"lab.conf"}
    assert service.handle_disk_change(demo, {"lab.conf"}) == {"lab.conf"}  # still up: told once
    assert service.registry.get(demo) is not None
    service.registry.get(demo).machines["pc1"].api_object = None  # its containers went away
    assert service.handle_disk_change(demo, {"lab.conf"}) == set()

    assert service.registry.get(demo) is None
    assert [(e["kind"], e["detail"] is not None) for e in events] == [("missing", True), ("missing", False)]


def test_a_lab_gone_since_the_poll_is_nothing_to_do(service):
    assert service.handle_disk_change("gone", {"lab.conf"}) == set()


# -- folders appearing under the labs root ---------------------------------------------------------


def _drop_lab(service, name, conf=LAB_CONF):
    """A lab folder put under the labs root by hand, the way a copy or an unzip would."""
    directory = service.store.lab_dir(name)
    directory.mkdir(parents=True)
    if conf is not None:
        (directory / "lab.conf").write_text(conf)
    return directory


def test_a_lab_folder_copied_into_the_labs_root_is_adopted_and_announced(service):
    events = _collecting(service)
    _drop_lab(service, "copied")

    adopted = service.rescan_labs_root()

    copied = lab_id(service, "copied")
    assert adopted == [copied]
    assert service.registry.get(copied) is not None
    assert events == [{"lab_id": copied, "kind": "adopted", "files": [], "detail": None}]
    assert service.rescan_labs_root() == []  # once only


def test_listing_the_labs_picks_up_a_new_folder_too(service):
    _drop_lab(service, "copied")

    assert lab_id(service, "copied") in {lab.hash for lab in service.list_labs()}


def test_a_folder_that_does_not_load_is_retried_only_once_it_changes(service, monkeypatch):
    directory = _drop_lab(service, "broken", conf="!!not a lab.conf\n")
    tries = []
    translate = service._translate_lab_dir
    monkeypatch.setattr(service, "_translate_lab_dir", lambda d: tries.append(d) or translate(d))

    assert service.rescan_labs_root() == []
    assert service.rescan_labs_root() == []
    assert tries == [directory]

    _bump(directory / "lab.conf", LAB_CONF)
    assert service.rescan_labs_root() == [lab_id(service, "broken")]


def test_a_folder_being_created_by_a_request_is_left_to_that_request(service):
    directory = _drop_lab(service, "busy")

    with service._claiming(lab_id(service, "busy")):
        assert service.rescan_labs_root() == []
    assert service.registry.get(lab_id(service, "busy")) is None

    assert service.rescan_labs_root() == [lab_id(service, "busy")]
    assert directory.exists()


def test_the_watcher_polls_every_loaded_lab(service):
    assert service.watched_labs() == {lab_id(service, "demo"): service.store.lab_dir("demo")}


# -- labs started or stopped outside the app ----------------------------------------------------


class _FakeDocker:
    """The Docker manager ``check_running_labs`` lists containers through: ``containers`` holds
    what Docker has, as the low-level listing returns it, and ``failure`` what listing raises."""

    def __init__(self):
        self.containers: list[dict] = []
        self.failure = None
        self.filters = []
        self.client = SimpleNamespace(api=SimpleNamespace(containers=self._list))

    def _list(self, all=False, filters=None):
        self.filters.append((all, filters))
        if self.failure is not None:
            raise self.failure
        return list(self.containers)

    def run(self, lab_hash, name, state="running", container_id=None):
        self.containers.append(
            {"Id": container_id or f"{lab_hash}-{name}", "State": state, "Labels": {"lab_hash": lab_hash, "name": name}}
        )


@pytest.fixture
def docker(service):
    fake = _FakeDocker()
    service._docker_manager = lambda: fake
    return fake


def _runtime(lab_id):
    return {"lab_id": lab_id, "kind": "runtime", "files": [], "detail": None}


def test_the_first_look_at_docker_announces_every_lab_already_running(service, docker):
    make_lab(service, "stopped", {"lab.conf": LAB_CONF})
    events = _collecting(service)
    demo = lab_id(service, "demo")
    docker.run(demo, "pc1")

    assert service.check_running_labs() == [demo]
    assert service.check_running_labs() == []
    assert events == [_runtime(demo)]


def test_a_lab_started_and_stopped_outside_the_app_is_announced_once_each_time(service, docker):
    events = _collecting(service)
    demo = lab_id(service, "demo")
    service.check_running_labs()

    docker.run(demo, "pc1")
    assert service.check_running_labs() == [demo]
    assert service.check_running_labs() == []
    docker.containers.clear()
    assert service.check_running_labs() == [demo]
    assert service.check_running_labs() == []

    assert events == [_runtime(demo), _runtime(demo)]


def test_a_device_that_stops_on_its_own_is_announced(service, docker):
    demo = lab_id(service, "demo")
    docker.run(demo, "pc1")
    service.check_running_labs()

    docker.containers[0]["State"] = "exited"

    assert service.check_running_labs() == [demo]


def test_a_lab_restarted_between_two_looks_is_announced(service, docker):
    demo = lab_id(service, "demo")
    docker.run(demo, "pc1", container_id="first")
    service.check_running_labs()

    docker.containers.clear()
    docker.run(demo, "pc1", container_id="second")

    assert service.check_running_labs() == [demo]


def test_only_the_labs_that_changed_are_announced(service, docker):
    make_lab(service, "other", {"lab.conf": LAB_CONF})
    demo, other = lab_id(service, "demo"), lab_id(service, "other")
    docker.run(other, "pc1")
    service.check_running_labs()

    docker.run(demo, "pc1")

    assert service.check_running_labs() == [demo]


def test_only_this_users_kathara_containers_are_listed_in_one_call(service, docker):
    service.check_running_labs()

    assert docker.filters == [(True, {"label": ["app=kathara", f"user={get_current_user_name()}"]})]


def test_containers_of_a_lab_this_app_has_not_loaded_are_ignored(service, docker):
    service.check_running_labs()
    docker.run("some-other-lab", "pc1")
    docker.containers.append({"Id": "unlabelled", "State": "running", "Labels": {}})

    assert service.check_running_labs() == []


def test_a_lab_loaded_while_it_is_already_running_is_not_announced(service, docker):
    later = lab_id(service, "later")
    docker.run(later, "pc1")
    service.check_running_labs()

    make_lab(service, "later", {"lab.conf": LAB_CONF})

    assert service.check_running_labs() == []


def test_a_lab_mid_deploy_moves_its_baseline_on_without_an_event_and_is_watched_again_after(service, docker):
    events = _collecting(service)
    demo = lab_id(service, "demo")
    service.check_running_labs()

    service._begin_transition(demo)
    docker.run(demo, "pc1")
    assert service.check_running_labs() == []
    service._end_transition(demo)
    assert service.check_running_labs() == []
    assert events == []

    docker.containers.clear()
    assert service.check_running_labs() == [demo]


@pytest.mark.parametrize("failure", [DockerException("API error"), ConnectionError("socket gone")])
def test_what_changed_while_listing_failed_is_announced_once_it_works(service, docker, failure):
    demo = lab_id(service, "demo")
    docker.run(demo, "pc1")
    service.check_running_labs()
    events = _collecting(service)

    docker.failure = failure
    docker.containers.clear()
    assert service.check_running_labs() == []
    docker.failure = None

    assert service.check_running_labs() == [demo]
    assert events == [_runtime(demo)]


def test_what_changed_while_the_daemon_was_unreachable_is_announced_once_it_is_back(service, docker):
    demo = lab_id(service, "demo")
    docker.run(demo, "pc1")
    service.check_running_labs()

    def unreachable():
        raise DockerDaemonConnectionError("down")

    service._docker_manager = unreachable
    docker.containers.clear()
    assert service.check_running_labs() == []
    service._docker_manager = lambda: docker

    assert service.check_running_labs() == [demo]


def test_a_lab_started_while_the_daemon_was_not_up_yet_is_announced_once_it_is(service, docker):
    def unreachable():
        raise DockerDaemonConnectionError("down")

    service._docker_manager = unreachable
    assert service.check_running_labs() == []
    service._docker_manager = lambda: docker
    docker.run(lab_id(service, "demo"), "pc1")

    assert service.check_running_labs() == [lab_id(service, "demo")]


# -- started with the app ----------------------------------------------------------------------


class _WatcherStub:
    """Stands in for LabWatcher in the app's lifespan: records how it was built and run."""

    built: list["_WatcherStub"] = []

    def __init__(self, labs, on_change, interval, on_poll=None):
        self.labs, self.on_change, self.interval, self.on_poll = labs, on_change, interval, on_poll
        self.running = False
        _WatcherStub.built.append(self)

    def start(self):
        self.running = True

    def stop(self):
        self.running = False


class _PeriodicStub:
    """Stands in for Periodic in the app's lifespan: records how it was built and run."""

    built: list["_PeriodicStub"] = []

    def __init__(self, tick, interval, name):
        self.tick, self.interval, self.name = tick, interval, name
        self.running = False
        _PeriodicStub.built.append(self)

    def start(self):
        self.running = True

    def stop(self):
        self.running = False


@pytest.fixture
def watcher_stub(monkeypatch):
    _WatcherStub.built = []
    _PeriodicStub.built = []
    monkeypatch.setattr(main_module, "LabWatcher", _WatcherStub)
    monkeypatch.setattr(main_module, "Periodic", _PeriodicStub)
    return _WatcherStub


def test_the_app_watches_the_service_s_labs_for_as_long_as_it_is_up(watcher_stub, monkeypatch):
    monkeypatch.setattr(get_settings(), "lab_watch_interval", 2.5)
    service = get_service()

    with TestClient(main_module.create_app()):
        [watcher] = watcher_stub.built
        assert watcher.running
        assert watcher.interval == 2.5
        assert watcher.labs == service.watched_labs
        assert watcher.on_change == service.handle_disk_change
        assert watcher.on_poll == service.rescan_labs_root

    assert not watcher.running


def test_the_app_checks_docker_on_a_thread_of_its_own_for_as_long_as_it_is_up(watcher_stub, monkeypatch):
    monkeypatch.setattr(get_settings(), "lab_watch_interval", 2.5)
    service = get_service()

    with TestClient(main_module.create_app()):
        [runtime] = _PeriodicStub.built
        assert runtime.running
        assert runtime.tick == service.check_running_labs
        assert runtime.interval == 2.5

    assert not runtime.running


def test_an_interval_of_zero_starts_no_watcher(watcher_stub, monkeypatch):
    monkeypatch.setattr(get_settings(), "lab_watch_interval", 0)

    with TestClient(main_module.create_app()):
        pass

    assert watcher_stub.built == []
    assert _PeriodicStub.built == []


# -- the event stream --------------------------------------------------------------------------


def test_an_event_published_from_another_thread_reaches_every_subscriber():
    events = LabEvents()

    async def receive():
        loop = asyncio.get_running_loop()
        first, second = events.subscribe(loop), events.subscribe(loop)
        threading.Thread(target=events.publish, args=({"kind": "startup"},)).start()
        got = [await asyncio.wait_for(q.get(), 2) for q in (first, second)]
        events.unsubscribe(second)
        events.publish({"kind": "conf-reloaded"})
        return got, await asyncio.wait_for(first.get(), 2), second.empty()

    got, later, second_empty = asyncio.run(receive())

    assert got == [{"kind": "startup"}] * 2
    assert later == {"kind": "conf-reloaded"}
    assert second_empty


def test_a_subscriber_whose_loop_is_gone_is_dropped():
    events = LabEvents()
    loop = asyncio.new_event_loop()
    events.subscribe(loop)
    loop.close()

    events.publish({"kind": "startup"})

    assert events._subscribers == {}


def test_the_events_route_streams_what_the_service_publishes_and_unsubscribes_when_closed(tmp_path):
    """Driven through the handler rather than a TestClient, which cannot close an endless stream."""
    from kathara_api.routers.events import lab_events

    service = make_service(LabStore(tmp_path / "labs"))
    event = {"lab_id": "L", "kind": "startup", "files": ["pc1.startup"], "detail": None}

    class _ConnectedRequest:
        async def is_disconnected(self):
            return False

    async def first_event():
        response = await lab_events(_ConnectedRequest(), service)
        service.events.publish(event)
        body = response.body_iterator
        try:
            return await asyncio.wait_for(body.__anext__(), 2)
        finally:
            await body.aclose()

    sent = asyncio.run(first_event())

    assert sent == {"event": "lab", "data": json.dumps(event)}
    assert service.events._subscribers == {}
