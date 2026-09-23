"""Unit tests for services/docker_hub.py — the official-image lookup (no network).

``httpx.Client`` is monkeypatched to serve a synthetic Docker Hub, the same way test_lab_gallery.py
serves a synthetic GitHub. The headline test is the paginated one: the bug this module exists to
fix was that Kathara's own DockerHubApi asks for ``?page_size=-1``, gets silently capped at Docker
Hub's default of 10 results, and never follows ``next`` — so 25 repositories became 8 images in
the app's image picker.
"""

import httpx
import pytest
from Kathara.exceptions import HTTPConnectionError

from kathara_api.services import docker_hub


class _FakeResponse:
    def __init__(self, status_code=200, json_data=None):
        self.status_code = status_code
        self._json = json_data

    def json(self):
        return self._json


def _install_client(monkeypatch, handler):
    """Point docker_hub at a client whose every GET is `handler(url, **kwargs)`."""

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, params=None, timeout=None, follow_redirects=None):
            return handler(url)

    monkeypatch.setattr(docker_hub.httpx, "Client", _FakeClient)


def _repo(name, content_types=("image",), is_private=False):
    return {
        "name": name,
        "namespace": "kathara",
        "content_types": list(content_types),
        "is_private": is_private,
    }


def _install_fake_hub(monkeypatch, repo_pages, tags):
    """Serve `repo_pages` (a list of result-lists, chained through `next`) for the repositories
    listing and `tags` (image name -> list of tag dicts) for each tags call. Returns the list of
    requested URLs, so a test can assert *how* it paged."""
    requested = []

    def handler(url):
        # Tags first: a tags URL also starts with the repositories URL, so the order matters.
        requested.append(url)
        if url.endswith("/tags/"):
            image_name = url[len("https://hub.docker.com/v2/repositories/"): -len("/tags/")]
            return _FakeResponse(200, {"results": tags.get(image_name, []), "next": None})
        index = 0 if url == docker_hub.REPOSITORIES_URL else int(url.rsplit("=", 1)[1]) - 1
        nxt = (
            f"{docker_hub.REPOSITORIES_URL}?page={index + 2}" if index + 1 < len(repo_pages) else None
        )
        return _FakeResponse(200, {"results": repo_pages[index], "next": nxt})

    _install_client(monkeypatch, handler)
    return requested


def _tag(name, status="active"):
    return {"name": name, "tag_status": status}


LATEST = [_tag("latest")]


def test_repositories_past_the_first_page_are_listed(monkeypatch):
    """The regression test for the actual bug: without following `next`, `dnsmasq` and `scion`
    would be missing from the picker exactly as they were."""
    requested = _install_fake_hub(
        monkeypatch,
        repo_pages=[[_repo("base"), _repo("frr")], [_repo("dnsmasq"), _repo("scion")]],
        tags={f"kathara/{n}": LATEST for n in ("base", "frr", "dnsmasq", "scion")},
    )

    assert docker_hub.list_tagged_images() == [
        "kathara/base",
        "kathara/dnsmasq",
        "kathara/frr",
        "kathara/scion",
    ]
    assert f"{docker_hub.REPOSITORIES_URL}?page=2" in requested


def test_pagination_stops_at_max_pages(monkeypatch):
    """A `next` that never terminates must not hang the request behind the image picker."""

    pages = []

    def handler(url):
        if url.endswith("/tags/"):
            return _FakeResponse(200, {"results": LATEST, "next": None})
        pages.append(url)
        return _FakeResponse(
            200, {"results": [_repo("base")], "next": f"{docker_hub.REPOSITORIES_URL}?page=2"}
        )

    _install_client(monkeypatch, handler)

    assert docker_hub.list_tagged_images() == ["kathara/base"]
    assert len(pages) == docker_hub.MAX_PAGES


def test_plugins_private_repos_and_excluded_names_are_filtered_out(monkeypatch):
    _install_fake_hub(
        monkeypatch,
        repo_pages=[
            [
                _repo("base"),
                _repo("katharanp", content_types=("plugin",)),
                _repo("secret", is_private=True),
                _repo("kathara-lab-checker"),
                _repo("megalos-bgp-manager"),
            ]
        ],
        tags={f"kathara/{n}": LATEST for n in ("base", "katharanp", "secret", "kathara-lab-checker", "megalos-bgp-manager")},
    )

    assert docker_hub.list_tagged_images() == ["kathara/base"]


def test_a_repo_without_content_types_is_kept(monkeypatch):
    """This module exists because the list came back silently *short*; an unexpected Hub response
    should over-report rather than drop images."""
    _install_fake_hub(
        monkeypatch,
        repo_pages=[[{"name": "base", "namespace": "kathara", "is_private": False}]],
        tags={"kathara/base": LATEST},
    )

    assert docker_hub.list_tagged_images() == ["kathara/base"]


def test_latest_is_rendered_bare_and_other_tags_are_suffixed(monkeypatch):
    """Bare `kathara/frr` is both how lab.conf spells it and what lets a locally pulled
    `kathara/frr:latest` dedupe against this entry."""
    _install_fake_hub(
        monkeypatch,
        repo_pages=[[_repo("frr")]],
        tags={"kathara/frr": [_tag("latest"), _tag("9"), _tag("10")]},
    )

    assert docker_hub.list_tagged_images() == ["kathara/frr", "kathara/frr:10", "kathara/frr:9"]


def test_inactive_tags_are_skipped(monkeypatch):
    _install_fake_hub(
        monkeypatch,
        repo_pages=[[_repo("frr")]],
        tags={"kathara/frr": [_tag("latest"), _tag("ancient", status="inactive")]},
    )

    assert docker_hub.list_tagged_images() == ["kathara/frr"]


@pytest.mark.parametrize(
    "failure",
    [httpx.ConnectError("no route to host"), httpx.ReadTimeout("too slow")],
    ids=["connect-error", "timeout"],
)
def test_a_transport_failure_raises_http_connection_error(monkeypatch, failure):
    """HTTPConnectionError specifically, because errors.py maps it to a 502 and
    KatharaService.list_available_images catches that exact type to degrade gracefully."""

    def handler(url):
        raise failure

    _install_client(monkeypatch, handler)

    with pytest.raises(HTTPConnectionError):
        docker_hub.list_tagged_images()


def test_a_non_200_raises_http_connection_error(monkeypatch):
    _install_client(monkeypatch, lambda url: _FakeResponse(503))

    with pytest.raises(HTTPConnectionError):
        docker_hub.list_tagged_images()
