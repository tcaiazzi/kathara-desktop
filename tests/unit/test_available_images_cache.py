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
from kathara_api.services.kathara_service import KatharaService


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


def test_mutating_the_returned_list_does_not_corrupt_the_cache(monkeypatch):
    _patch_official(monkeypatch, ["kathara/base", "kathara/frr"])
    _patch_local(monkeypatch, [])
    service = KatharaService()

    first = service.list_available_images()
    first.official.append("not/a-real-image")

    assert service.list_available_images().official == ["kathara/base", "kathara/frr"]


def test_a_cache_hit_also_returns_a_copy_not_the_cached_object(monkeypatch):
    _patch_official(monkeypatch, ["kathara/base"])
    _patch_local(monkeypatch, [])
    service = KatharaService()

    first = service.list_available_images()  # populates the cache
    second = service.list_available_images()  # cache hit (still within the TTL)

    assert second == first
    assert second.official is not service._images_cache


def test_only_the_docker_hub_half_is_cached(monkeypatch):
    """A newly pulled image must be suggestable without waiting out the 5-minute TTL, so the
    local half is re-read on every call while the network half stays cached."""
    calls = []
    monkeypatch.setattr(docker_hub, "list_tagged_images", lambda: calls.append("hub") or [])
    local = ["alpine"]
    monkeypatch.setattr(KatharaService, "list_local_images", lambda self: list(local))
    service = KatharaService()

    assert service.list_available_images().local == ["alpine"]
    local.append("nginx")
    assert service.list_available_images().local == ["alpine", "nginx"]
    assert calls == ["hub"]  # the Hub was consulted once, not twice


# --- the merge -------------------------------------------------------------


def test_the_two_sources_are_reported_separately(monkeypatch):
    """They are two labelled sections in the picker, so merging them here would throw away the
    only thing that can tell an official image from one the user happens to have pulled."""
    _patch_official(monkeypatch, ["kathara/base", "kathara/frr"])
    _patch_local(monkeypatch, ["alpine", "nginx"])

    images = KatharaService().list_available_images()

    assert images.official == ["kathara/base", "kathara/frr"]
    assert images.local == ["alpine", "nginx"]


def test_a_local_image_already_on_docker_hub_is_not_listed_twice(monkeypatch):
    _patch_official(monkeypatch, ["kathara/base", "kathara/frr:9"])
    _patch_local(monkeypatch, ["kathara/base", "kathara/frr:9", "alpine"])

    images = KatharaService().list_available_images()

    assert images.official == ["kathara/base", "kathara/frr:9"]
    assert images.local == ["alpine"]  # not repeated under a second heading


# --- degradation -----------------------------------------------------------


def test_an_unreachable_docker_hub_still_returns_the_local_images(monkeypatch):
    _patch_official(monkeypatch, HTTPConnectionError("no route to host"))
    _patch_local(monkeypatch, ["alpine"])

    images = KatharaService().list_available_images()

    assert (images.official, images.local) == ([], ["alpine"])


def test_a_docker_hub_failure_is_not_cached(monkeypatch):
    """Caching the empty result would latch the picker into a Hub-less state for five minutes
    after a blip that may have lasted a second."""
    responses = [HTTPConnectionError("blip"), ["kathara/base"]]
    monkeypatch.setattr(
        docker_hub,
        "list_tagged_images",
        lambda: (_ for _ in ()).throw(r) if isinstance(r := responses.pop(0), Exception) else r,
    )
    _patch_local(monkeypatch, [])
    service = KatharaService()

    assert service.list_available_images().official == []
    assert service.list_available_images().official == ["kathara/base"]


@pytest.mark.parametrize("failure", [DockerDaemonConnectionError("daemon down"), APIError("boom")])
def test_a_stopped_docker_daemon_still_returns_the_official_images(monkeypatch, failure):
    _patch_official(monkeypatch, ["kathara/base"])

    def boom(self):
        raise failure

    monkeypatch.setattr(KatharaService, "_docker_manager", boom)

    images = KatharaService().list_available_images()

    assert (images.official, images.local) == (["kathara/base"], [])


def test_both_sources_down_returns_empty_lists_rather_than_raising(monkeypatch):
    """The endpoint has no error branch on the frontend: an empty picker and manual entry is the
    intended worst case, not a toast."""
    _patch_official(monkeypatch, HTTPConnectionError("no route to host"))

    def boom(self):
        raise DockerDaemonConnectionError("daemon down")

    monkeypatch.setattr(KatharaService, "_docker_manager", boom)

    images = KatharaService().list_available_images()

    assert (images.official, images.local) == ([], [])


# --- list_local_images -----------------------------------------------------


class _FakeImage:
    def __init__(self, tags):
        self.tags = tags


class _FakeManager:
    def __init__(self, images):
        self.client = type("C", (), {"images": type("I", (), {"list": lambda s: images})()})()


def _service_with_local(monkeypatch, images):
    service = KatharaService()
    manager = _FakeManager([_FakeImage(tags) for tags in images])
    monkeypatch.setattr(KatharaService, "_docker_manager", lambda self: manager)
    return service


def test_local_images_drop_the_latest_tag_so_they_dedupe_against_docker_hub(monkeypatch):
    service = _service_with_local(monkeypatch, [["kathara/base:latest"], ["alpine:3.19"]])

    assert service.list_local_images() == ["alpine:3.19", "kathara/base"]


def test_local_images_skip_dangling_and_untagged_entries(monkeypatch):
    service = _service_with_local(monkeypatch, [[], ["<none>:<none>"], ["alpine:latest"]])

    assert service.list_local_images() == ["alpine"]
