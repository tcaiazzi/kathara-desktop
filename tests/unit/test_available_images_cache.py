"""Unit tests for KatharaService.list_available_images's cache (no Docker/network required).

See docs/audit_2.md minor reperti: the method used to return the cached list object itself, so a
caller that mutated it in place would corrupt the cache for everyone else.
"""

from Kathara.webhooks import DockerHubApi as docker_hub_api_module

from kathara_api.services.kathara_service import KatharaService


def _patch_tagged_images(monkeypatch, images: list[str]):
    monkeypatch.setattr(
        docker_hub_api_module.DockerHubApi, "get_tagged_images", staticmethod(lambda: images)
    )


def test_mutating_the_returned_list_does_not_corrupt_the_cache(monkeypatch):
    _patch_tagged_images(monkeypatch, ["kathara/base", "kathara/frr"])
    service = KatharaService()

    first = service.list_available_images()
    first.append("not/a-real-image")

    second = service.list_available_images()
    assert second == ["kathara/base", "kathara/frr"]


def test_a_cache_hit_also_returns_a_copy_not_the_cached_object(monkeypatch):
    _patch_tagged_images(monkeypatch, ["kathara/base"])
    service = KatharaService()

    first = service.list_available_images()  # populates the cache
    second = service.list_available_images()  # cache hit (still within the TTL)

    assert second == first
    assert second is not service._images_cache
