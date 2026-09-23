"""The official Kathara images published on Docker Hub (the ``kathara/`` org).

A deliberate replacement for Kathara's own ``DockerHubApi.get_tagged_images()``, which cannot be
used here because it asks Docker Hub for ``?page_size=-1``. Docker Hub does not accept ``-1``: it
silently falls back to its **default page size of 10** and reports the rest through a ``next``
link the upstream code never follows. The ``kathara/`` org has 25 repositories, so upstream sees
10 of them and returns 8 images after filtering — the reason the app's image picker was missing
``apache``, ``bind``, ``bird2``, ``bird3``, ``bmv2``, ``core``, ``dnsmasq``, ``openvswitch``,
``pox``, ``rift-python``, ``routinator``, ``rpki-client`` and ``scion``. Both this module's
listings therefore page explicitly, and the tags call does too even though no Kathara image has
10 tags yet.

A leaf module: it imports nothing from the rest of the package, and the only Kathara symbol it
touches is ``HTTPConnectionError``, so that ``errors.py``'s existing 502 mapping keeps applying
to whatever it raises.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Iterator, Optional

import httpx
from Kathara.exceptions import HTTPConnectionError

logger = logging.getLogger("kathara_api")

NAMESPACE = "kathara"
REPOSITORIES_URL = f"https://hub.docker.com/v2/repositories/{NAMESPACE}/"
TAGS_URL = "https://hub.docker.com/v2/repositories/{image_name}/tags/"

# Docker Hub's own maximum. One page covers the org today (25 repos); the `next` walk below is
# what keeps that from mattering.
PAGE_SIZE = 100
# A pagination loop (a `next` that never terminates) would otherwise hang the request. Nothing
# legitimate gets near this at 100 per page.
MAX_PAGES = 10
# Upstream uses 1 second, which is short enough that one slow response from Docker Hub loses the
# *whole* list — and this is a fan-out of ~20 requests, so the odds of that compound. These are
# suggestions behind a 5-minute cache; waiting a few seconds once is cheaper than an empty picker.
REQUEST_TIMEOUT = 8.0
# One request per repository. Matches lab_gallery.py's DOWNLOAD_CONCURRENCY: enough to keep the
# whole fan-out inside a round trip or two without hammering the API.
TAG_CONCURRENCY = 8

# Repositories in the org that are not device images. Kept identical to upstream's
# `DockerHubApi.EXCLUDED_IMAGES` — `katharanp`/`katharanp_vde` need no entry because they are
# Docker *plugins* and the `content_types` filter already drops them.
EXCLUDED_IMAGES = frozenset({"megalos-bgp-manager", "kathara", "kathara-lab-checker"})


def _get_json(client: httpx.Client, url: str, params: Optional[dict]) -> dict:
    try:
        response = client.get(url, params=params, timeout=REQUEST_TIMEOUT, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise HTTPConnectionError(f"Could not reach Docker Hub at {url}: {exc}") from exc
    if response.status_code != 200:
        raise HTTPConnectionError(
            f"Docker Hub replied with status code {response.status_code} for {url}."
        )
    return response.json()


def _pages(client: httpx.Client, url: str) -> Iterator[dict]:
    """Every ``results`` entry across a paginated Docker Hub listing, following ``next``.

    ``next`` comes back as a fully-formed URL carrying its own ``page``/``page_size``, so the
    explicit params are passed on the first request only — re-sending them would reset the walk
    to page 1 and loop forever.
    """
    params: Optional[dict] = {"page_size": PAGE_SIZE}
    for _ in range(MAX_PAGES):
        payload = _get_json(client, url, params)
        yield from payload.get("results") or []
        next_url = payload.get("next")
        if not next_url:
            return
        url, params = next_url, None
    logger.warning("Docker Hub listing did not terminate within %d pages; truncating.", MAX_PAGES)


def _is_device_image(repo: dict[str, Any]) -> bool:
    # A repo with no `content_types` at all counts as an image: the failure this module exists to
    # fix was a silently *short* list, so an unexpected Hub response should over-report rather
    # than drop images. Plugins do report the key, so the real filter still works.
    content_types = repo.get("content_types") or ["image"]
    return (
        not repo.get("is_private")
        and "image" in content_types
        and repo.get("name") not in EXCLUDED_IMAGES
    )


def _tagged_names(client: httpx.Client, image_name: str) -> list[str]:
    """``image_name`` expanded to one entry per active tag, ``latest`` rendered bare.

    Bare rather than ``:latest`` because that is how the images are written in ``lab.conf``, and
    because it lets a locally pulled ``kathara/base:latest`` dedupe against this entry in
    ``KatharaService.list_available_images``.
    """
    names = []
    for tag in _pages(client, TAGS_URL.format(image_name=image_name)):
        name = tag.get("name")
        if not name or tag.get("tag_status") != "active":
            continue
        names.append(image_name if name == "latest" else f"{image_name}:{name}")
    return names


def list_tagged_images() -> list[str]:
    """Every official Kathara image, one entry per active tag, sorted.

    Raises:
        HTTPConnectionError: Docker Hub was unreachable or answered with a non-200. Mapped to a
            502 by ``errors.py``; ``KatharaService.list_available_images`` catches it instead, so
            an offline machine still gets its local images.
    """
    with httpx.Client(headers={"User-Agent": "kathara-desktop"}) as client:
        image_names = [
            f"{repo.get('namespace') or NAMESPACE}/{repo['name']}"
            for repo in _pages(client, REPOSITORIES_URL)
            if _is_device_image(repo)
        ]
        # Consumed inside the pool's `with` so a per-repo HTTPConnectionError still propagates
        # rather than being swallowed by a lazily-abandoned map.
        with ThreadPoolExecutor(max_workers=TAG_CONCURRENCY) as pool:
            tagged = [
                name
                for group in pool.map(lambda n: _tagged_names(client, n), image_names)
                for name in group
            ]
    return sorted(dict.fromkeys(tagged))
