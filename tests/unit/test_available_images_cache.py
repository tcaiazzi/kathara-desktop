"""Unit tests for KatharaService.list_available_images (no Docker/network required).

The endpoint reports two independent sources — the official Kathara images on Docker Hub and the
images already on this machine's daemon — as separate lists, because the picker draws them as two
labelled sections. What is pinned here is what a caller depends on and a refactor could silently
break: that the two stay separate, that an image in both is reported once, and that either source
failing degrades the response instead of raising.
"""

import pytest
from docker.errors import APIError
from Kathara.exceptions import DockerDaemonConnectionError, HTTPConnectionError

from kathara_api.services import docker_hub
from kathara_api.services import kathara_service as kathara_service_module
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from kathara_api.services.official_images_cache import OFFICIAL_IMAGES_FILENAME, OfficialImagesFile
from tests.helpers import make_service


def _service(tmp_path) -> KatharaService:
    """A service on a labs root of its own under ``tmp_path``, which is never created."""
    return make_service(store=LabStore(tmp_path / "labs"))


def _patch_official(monkeypatch, images):
    """Stand in for the Docker Hub half. ``images`` may be a list or an exception to raise."""

    def fake():
        if isinstance(images, Exception):
            raise images
        return list(images)

    monkeypatch.setattr(docker_hub, "list_tagged_images", fake)


def _patch_local(monkeypatch, images):
    monkeypatch.setattr(KatharaService, "list_local_images", lambda self: list(images))


# --- the cache's copy-on-return invariant ----------------------------------


def test_mutating_the_returned_list_does_not_corrupt_the_cache(tmp_path, monkeypatch):
    _patch_official(monkeypatch, ["kathara/base", "kathara/frr"])
    _patch_local(monkeypatch, [])
    service = _service(tmp_path)

    first = service.list_available_images()
    first.official.append("not/a-real-image")

    assert service.list_available_images().official == ["kathara/base", "kathara/frr"]


def test_a_cache_hit_also_returns_a_copy_not_the_cached_object(tmp_path, monkeypatch):
    _patch_official(monkeypatch, ["kathara/base"])
    _patch_local(monkeypatch, [])
    service = _service(tmp_path)

    first = service.list_available_images()  # populates the cache
    second = service.list_available_images()  # cache hit (still within the TTL)

    assert second == first
    assert second.official is not service._images_cache


def test_only_the_docker_hub_half_is_cached(tmp_path, monkeypatch):
    """A newly pulled image must be suggestable without waiting out the 5-minute TTL, so the
    local half is re-read on every call while the network half stays cached."""
    calls = []
    monkeypatch.setattr(docker_hub, "list_tagged_images", lambda: calls.append("hub") or [])
    local = ["alpine"]
    monkeypatch.setattr(KatharaService, "list_local_images", lambda self: list(local))
    service = _service(tmp_path)

    assert service.list_available_images().local == ["alpine"]
    local.append("nginx")
    assert service.list_available_images().local == ["alpine", "nginx"]
    assert calls == ["hub"]  # the Hub was consulted once, not twice


# --- the merge -------------------------------------------------------------


def test_the_two_sources_are_reported_separately(tmp_path, monkeypatch):
    """They are two labelled sections in the picker, so merging them here would throw away the
    only thing that can tell an official image from one the user happens to have pulled."""
    _patch_official(monkeypatch, ["kathara/base", "kathara/frr"])
    _patch_local(monkeypatch, ["alpine", "nginx"])

    images = _service(tmp_path).list_available_images()

    assert images.official == ["kathara/base", "kathara/frr"]
    assert images.local == ["alpine", "nginx"]


def test_a_local_image_already_on_docker_hub_is_not_listed_twice(tmp_path, monkeypatch):
    _patch_official(monkeypatch, ["kathara/base", "kathara/frr:9"])
    _patch_local(monkeypatch, ["kathara/base", "kathara/frr:9", "alpine"])

    images = _service(tmp_path).list_available_images()

    assert images.official == ["kathara/base", "kathara/frr:9"]
    assert images.local == ["alpine"]  # not repeated under a second heading


# --- degradation -----------------------------------------------------------


def test_an_unreachable_docker_hub_still_returns_the_local_images(tmp_path, monkeypatch):
    _patch_official(monkeypatch, HTTPConnectionError("no route to host"))
    _patch_local(monkeypatch, ["alpine"])

    images = _service(tmp_path).list_available_images()

    assert (images.official, images.local) == ([], ["alpine"])


def test_a_docker_hub_failure_is_not_cached(tmp_path, monkeypatch):
    """Caching the empty result would latch the picker into a Hub-less state for five minutes
    after a blip that may have lasted a second."""
    responses = [HTTPConnectionError("blip"), ["kathara/base"]]
    monkeypatch.setattr(
        docker_hub,
        "list_tagged_images",
        lambda: (_ for _ in ()).throw(r) if isinstance(r := responses.pop(0), Exception) else r,
    )
    _patch_local(monkeypatch, [])
    service = _service(tmp_path)

    assert service.list_available_images().official == []
    assert service.list_available_images().official == ["kathara/base"]


@pytest.mark.parametrize("failure", [DockerDaemonConnectionError("daemon down"), APIError("boom")])
def test_a_stopped_docker_daemon_still_returns_the_official_images(tmp_path, monkeypatch, failure):
    _patch_official(monkeypatch, ["kathara/base"])

    def boom(self):
        raise failure

    monkeypatch.setattr(KatharaService, "_docker_manager", boom)

    images = _service(tmp_path).list_available_images()

    assert (images.official, images.local) == (["kathara/base"], [])


def test_both_sources_down_returns_empty_lists_rather_than_raising(tmp_path, monkeypatch):
    """The endpoint has no error branch on the frontend: an empty picker and manual entry is the
    intended worst case, not a toast."""
    _patch_official(monkeypatch, HTTPConnectionError("no route to host"))

    def boom(self):
        raise DockerDaemonConnectionError("daemon down")

    monkeypatch.setattr(KatharaService, "_docker_manager", boom)

    images = _service(tmp_path).list_available_images()

    assert (images.official, images.local) == ([], [])


# --- list_local_images -----------------------------------------------------


class _FakeImage:
    def __init__(self, tags):
        self.tags = tags


class _FakeManager:
    def __init__(self, images):
        self.client = type("C", (), {"images": type("I", (), {"list": lambda s: images})()})()


def _service_with_local(monkeypatch, tmp_path, images):
    service = _service(tmp_path)
    manager = _FakeManager([_FakeImage(tags) for tags in images])
    monkeypatch.setattr(KatharaService, "_docker_manager", lambda self: manager)
    return service


def test_local_images_drop_the_latest_tag_so_they_dedupe_against_docker_hub(tmp_path, monkeypatch):
    service = _service_with_local(monkeypatch, tmp_path, [["kathara/base:latest"], ["alpine:3.19"]])

    assert service.list_local_images() == ["alpine:3.19", "kathara/base"]


def test_local_images_skip_dangling_and_untagged_entries(tmp_path, monkeypatch):
    service = _service_with_local(monkeypatch, tmp_path, [[], ["<none>:<none>"], ["alpine:latest"]])

    assert service.list_local_images() == ["alpine"]


# --- the copy kept in the state directory ------------------------------------

_DAY = 24 * 3600
_NOW = 1_800_000_000.0


class _Hub:
    """Docker Hub as ``docker_hub.list_tagged_images`` sees it: the images it answers with, or
    ``None`` for unreachable. Counts the fetches."""

    def __init__(self, images):
        self.images = images
        self.fetches = 0

    def __call__(self):
        self.fetches += 1
        if self.images is None:
            raise HTTPConnectionError("Docker Hub unreachable")
        return list(self.images)


@pytest.fixture
def clock(monkeypatch):
    """Wall-clock and monotonic time, both under the test's control."""
    now = {"wall": _NOW, "mono": 5000.0}
    monkeypatch.setattr(kathara_service_module.time, "time", lambda: now["wall"])
    monkeypatch.setattr(kathara_service_module.time, "monotonic", lambda: now["mono"])
    return now


def _service_with_file(monkeypatch, tmp_path, hub):
    monkeypatch.setattr(docker_hub, "list_tagged_images", hub)
    service = _service(tmp_path)
    service._images_file = OfficialImagesFile(tmp_path / OFFICIAL_IMAGES_FILENAME)
    return service


def _store(tmp_path, images, fetched_at):
    OfficialImagesFile(tmp_path / OFFICIAL_IMAGES_FILENAME).save(images, fetched_at)


def test_a_fetched_list_is_served_after_a_restart_without_asking_docker_hub(monkeypatch, tmp_path, clock):
    hub = _Hub(["kathara/base", "kathara/frr"])
    _service_with_file(monkeypatch, tmp_path, hub)._official_images()

    clock["wall"] += 3600
    restarted = _service_with_file(monkeypatch, tmp_path, hub)

    assert restarted._official_images() == ["kathara/base", "kathara/frr"]
    assert hub.fetches == 1


def test_a_copy_older_than_a_day_is_fetched_again_and_replaced(monkeypatch, tmp_path, clock):
    _store(tmp_path, ["kathara/base"], _NOW - _DAY - 1)
    hub = _Hub(["kathara/base", "kathara/pox"])
    service = _service_with_file(monkeypatch, tmp_path, hub)

    assert service._official_images() == ["kathara/base", "kathara/pox"]
    assert hub.fetches == 1
    assert OfficialImagesFile(tmp_path / OFFICIAL_IMAGES_FILENAME).load() == (["kathara/base", "kathara/pox"], _NOW)


def test_an_old_copy_is_served_while_docker_hub_is_unreachable_without_asking_again_at_once(
    monkeypatch, tmp_path, clock
):
    _store(tmp_path, ["kathara/base"], _NOW - 30 * _DAY)
    hub = _Hub(None)
    service = _service_with_file(monkeypatch, tmp_path, hub)

    assert service._official_images() == ["kathara/base"]
    clock["mono"] += service._IMAGES_CACHE_TTL - 1
    assert service._official_images() == ["kathara/base"]
    assert hub.fetches == 1


def test_a_copy_dated_in_the_future_is_fetched_again(monkeypatch, tmp_path, clock):
    _store(tmp_path, ["kathara/base"], _NOW + 3600)
    hub = _Hub(["kathara/frr"])

    assert _service_with_file(monkeypatch, tmp_path, hub)._official_images() == ["kathara/frr"]
    assert hub.fetches == 1


def test_an_unreadable_copy_is_ignored(monkeypatch, tmp_path, clock):
    (tmp_path / OFFICIAL_IMAGES_FILENAME).write_text('{"version": 1, "images": "kathara/base"', encoding="utf-8")
    hub = _Hub(["kathara/frr"])

    assert _service_with_file(monkeypatch, tmp_path, hub)._official_images() == ["kathara/frr"]


def test_a_state_directory_that_cannot_be_written_only_costs_the_copy(monkeypatch, tmp_path, clock):
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("", encoding="utf-8")
    monkeypatch.setattr(docker_hub, "list_tagged_images", _Hub(["kathara/base"]))
    service = _service(tmp_path)
    service._images_file = OfficialImagesFile(blocker / OFFICIAL_IMAGES_FILENAME)

    assert service._official_images() == ["kathara/base"]
    assert list(tmp_path.iterdir()) == [blocker]
