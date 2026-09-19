"""The upstream lab gallery: browse and install network scenarios straight from a GitHub repo
(KatharaFramework/Kathara-Labs by default).

The remote twin of services/examples.py. Both answer "what installable scenarios exist, and which
are already on disk"; this one just sources its catalog over HTTP instead of from package data, and
so owns the two concerns package data doesn't have: a cache (the catalog costs a rate-limited API
call) and hard caps on what a remote repo is allowed to hand us.

Everything that knows about GitHub lives here. ``KatharaService`` only ever sees a catalog of
entries and a ``dict[path, bytes]`` of files to write, which is why installing a gallery lab reuses
``_adopt_populated_dir`` — the same seam a .zip upload and a bundled-example install already use.

**A lab is a directory containing ``lab.conf``.** That, rather than a fixed nesting depth, is how
the catalog is discovered: upstream labs sit two to four levels below the section root, and some
are grouped inside a parent folder that is itself not a lab.

**Files are fetched one by one from raw.githubusercontent.com**, deliberately *not* from the
per-lab ``.zip`` archives that exist upstream: only some labs have one, and a few of those archives
bundle several labs together (``kathara-lab_ospf.zip`` holds three), so extracting them would
produce something that isn't one lab. Per-file download is uniform, and the labs are tiny — tens of
files, tens of kilobytes.

**No README fetching.** Titles are just the lab's directory name and labs are grouped by their raw
category slug — this deliberately avoids probing upstream directories for README.md files (a lot of
extra round-trips for decorative text). ``repo_url`` points at the lab's *parent* directory rather
than the lab directory itself, since that's upstream's actual unit of browsing: it holds the lab
folder, its slides PDF (if any), and its README (if any), all in one GitHub folder view.
"""

import asyncio
import posixpath
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from threading import Lock
from typing import Optional
from urllib.parse import quote

import httpx
from starlette.concurrency import run_in_threadpool

from ..config import format_mb, get_settings
from ..errors import GalleryLabNotFoundError, GalleryUnavailableError
from ..lab_conf_options import LAB_CONF_FILENAME

# What a single lab is allowed to be — shared with the JSON-import and .zip-upload paths (see
# ApiSettings.max_files_per_lab and friends in config.py) rather than a copy of the same three
# numbers kept here: a mis-set gallery_repo (or a hostile fork) turning one click into a
# disk-filling download is the same failure mode as an oversized upload, just from a different
# source.

# Enough for a cold GitHub tree of a few thousand entries, short enough that a hung upstream
# doesn't hold a request open indefinitely.
TREE_TIMEOUT = 20.0
FILE_TIMEOUT = 20.0
# Files are small, so wall-clock is dominated by round trips; 8 keeps a 55-file lab under a second
# without hammering the CDN.
DOWNLOAD_CONCURRENCY = 8


@dataclass
class GalleryEntry:
    """One lab in the catalog, plus everything needed to install it without a second tree fetch."""

    id: str
    name: str
    category: str
    # Repo-relative paths of every blob under the lab directory.
    files: list[str] = field(default_factory=list)
    size_bytes: int = 0
    repo_url: str = ""

    @property
    def n_files(self) -> int:
        return len(self.files)


@dataclass
class Catalog:
    repo: str
    ref: str
    section: str
    fetched_at: float
    # Insertion-ordered by (category, lab name) so the frontend can group by walking the list.
    entries: dict[str, GalleryEntry]


# Module-level cache, mirroring the `_IMAGES_CACHE_TTL` precedent in kathara_service.py and there
# for the same reason: a slow, rate-limited remote listing must not run once per request. The lock
# is held across the fetch so a burst of first requests produces one upstream call, not N. Used by
# fetch_catalog (sync) — install_gallery_lab/get_entry and every existing test go through this one.
_cache: Optional[Catalog] = None
_cache_lock = Lock()

# Coordination for fetch_catalog_async (the /gallery HTTP route only — see docs/DESIGN-NOTES.md).
# `_async_lock` guards *only* the `_inflight` pointer, never the fetch itself: a concurrent async
# caller that finds a fetch already in flight awaits that fetch's Future on the event loop, which
# costs nothing, instead of blocking a worker thread from the shared threadpool for up to
# TREE_TIMEOUT seconds the way waiting on `_cache_lock` would.
_async_lock = asyncio.Lock()
_inflight: "Optional[asyncio.Future[Catalog]]" = None


def _api_base() -> str:
    return f"https://api.github.com/repos/{get_settings().gallery_slug()}"


def _raw_url(path: str) -> str:
    s = get_settings()
    return f"https://raw.githubusercontent.com/{s.gallery_slug()}/{quote(s.gallery_ref_value())}/{quote(path)}"


def _tree_url(path: str) -> str:
    s = get_settings()
    return f"https://github.com/{s.gallery_slug()}/tree/{quote(s.gallery_ref_value())}/{quote(path)}"


def _headers() -> dict[str, str]:
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    token = (get_settings().gallery_token or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _fetch_tree() -> list[dict]:
    """Every blob and tree in the repo at the configured ref, in one call.

    ``recursive=1`` is what makes this a single request instead of one per directory. A response
    flagged ``truncated`` is rejected rather than used: GitHub truncates silently, and a partial
    tree would present a partial catalog as if it were complete.
    """
    settings = get_settings()
    url = f"{_api_base()}/git/trees/{quote(settings.gallery_ref_value())}"
    try:
        response = httpx.get(
            url, params={"recursive": "1"}, headers=_headers(), timeout=TREE_TIMEOUT,
            follow_redirects=True,
        )
    except httpx.HTTPError as exc:
        raise GalleryUnavailableError(
            f"Could not reach the lab gallery at {settings.gallery_repo}: {exc}"
        ) from exc

    if response.status_code in (403, 429) and response.headers.get("x-ratelimit-remaining") == "0":
        raise GalleryUnavailableError(
            "GitHub's API rate limit is exhausted for this network. Try again later, or set "
            "KATHARA_API_GALLERY_TOKEN to raise the limit."
        )
    if response.status_code == 404:
        raise GalleryUnavailableError(
            f"Lab gallery `{settings.gallery_repo}` has no ref `{settings.gallery_ref}` "
            "(or the repository is private)."
        )
    if response.status_code != 200:
        raise GalleryUnavailableError(
            f"Lab gallery {settings.gallery_repo} returned HTTP {response.status_code}."
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise GalleryUnavailableError("Lab gallery returned a malformed response.") from exc
    if payload.get("truncated"):
        raise GalleryUnavailableError(
            f"Lab gallery `{settings.gallery_repo}` is too large to list in one request."
        )
    tree = payload.get("tree")
    if not isinstance(tree, list):
        raise GalleryUnavailableError("Lab gallery returned a response with no file tree.")
    return tree


def _disambiguate(roots: list[str]) -> dict[str, str]:
    """Map each lab directory path to the lab name it installs as.

    The basename alone is not unique upstream: the frr/ and quagga/ variants of the BGP labs share
    one (``.../frr/bgp-announcement/kathara-lab_bgp-announcement`` and ``.../quagga/...``). Left
    alone, importing the second of such a pair would fail as "lab already exists" with nothing
    explaining why, so colliding names get the differentiating path segment appended — the deepest
    ancestor segment that actually differs across the group.
    """
    by_base: dict[str, list[str]] = {}
    for root in roots:
        by_base.setdefault(root.rsplit("/", 1)[-1], []).append(root)

    names: dict[str, str] = {}
    for base, group in by_base.items():
        if len(group) == 1:
            names[group[0]] = base
            continue
        for root in group:
            segments = root.split("/")[:-1]
            others = [other.split("/")[:-1] for other in group if other != root]
            # Deepest segment that no sibling in the group shares at the same depth.
            suffix = next(
                (
                    segments[i]
                    for i in range(len(segments) - 1, -1, -1)
                    if any(i >= len(o) or o[i] != segments[i] for o in others)
                ),
                "",
            )
            candidate = f"{base}_{suffix}" if suffix else base
            # A name is a directory name; keep it inside LAB_NAME_RE's 64-char budget.
            names[root] = candidate[:64] if len(candidate) > 64 else candidate
    return names


def _build_entries(tree: list[dict], section: str) -> dict[str, GalleryEntry]:
    """Discover labs in a repo tree: every directory holding a ``lab.conf``, under `section`."""
    prefix = f"{section}/" if section else ""
    blobs = [item for item in tree if item.get("type") == "blob" and isinstance(item.get("path"), str)]

    roots = sorted(
        blob["path"][: -len(LAB_CONF_FILENAME) - 1]
        for blob in blobs
        if blob["path"].startswith(prefix) and blob["path"].endswith("/" + LAB_CONF_FILENAME)
    )
    if not roots:
        return {}

    names = _disambiguate(roots)
    # One pass over the blobs per lab would be O(labs x blobs); bucket by root instead.
    files: dict[str, list[str]] = {root: [] for root in roots}
    sizes: dict[str, int] = dict.fromkeys(roots, 0)
    for blob in blobs:
        path = blob["path"]
        # A lab's files are the blobs under its directory. Roots never nest (no lab.conf has
        # another lab.conf beneath it), so a blob belongs to at most one lab.
        root = posixpath.dirname(path)
        while root:
            if root in files:
                files[root].append(path)
                sizes[root] += int(blob.get("size") or 0)
                break
            root = posixpath.dirname(root)

    entries: dict[str, GalleryEntry] = {}
    for root in roots:
        relative = root[len(prefix):]
        entries[root] = GalleryEntry(
            id=root,
            name=names[root],
            category=relative.split("/")[0] if "/" in relative else relative,
            files=sorted(files[root]),
            size_bytes=sizes[root],
            # The parent dir, not the lab dir itself: upstream keeps the slides PDF (if any) and a
            # README (if any) beside the lab folder, so that's the browsable unit a link should hit.
            repo_url=_tree_url(posixpath.dirname(root)),
        )
    return entries


def _build_catalog() -> Catalog:
    settings = get_settings()
    section = settings.gallery_section_path()
    entries = _build_entries(_fetch_tree(), section)
    ordered = dict(sorted(entries.items(), key=lambda kv: (kv[1].category, kv[1].name)))
    return Catalog(
        repo=settings.gallery_slug(),
        ref=settings.gallery_ref_value(),
        section=section,
        fetched_at=time.time(),
        entries=ordered,
    )


def fetch_catalog(refresh: bool = False) -> Catalog:
    """The upstream catalog, from cache when it is still fresh.

    `refresh` bypasses the cache — that is what the modal's Refresh button is for, and what makes a
    lab added upstream reachable without restarting the backend.
    """
    global _cache
    ttl = get_settings().gallery_cache_ttl
    with _cache_lock:
        cached = _cache
        if not refresh and cached is not None and time.time() - cached.fetched_at < ttl:
            return cached
        catalog = _build_catalog()
        _cache = catalog
        return catalog


def _fresh_cached_catalog() -> Optional[Catalog]:
    ttl = get_settings().gallery_cache_ttl
    with _cache_lock:
        cached = _cache
    if cached is not None and time.time() - cached.fetched_at < ttl:
        return cached
    return None


async def fetch_catalog_async(refresh: bool = False) -> Catalog:
    """Async twin of `fetch_catalog`, for the one caller that must never park a threadpool worker
    while waiting on someone else's fetch: the `/gallery` HTTP route (see docs/DESIGN-NOTES.md).

    Coordination lives entirely on the event loop: `_async_lock` only ever guards the `_inflight`
    pointer — a handful of synchronous statements — and is released before anyone awaits the
    network fetch itself. A burst of concurrent callers therefore produces exactly one call to
    `_build_catalog`, and every caller but the one that actually issues it suspends on a plain
    `asyncio.Future`, not on a thread.

    `refresh=True` deliberately still joins an in-flight fetch if one exists, rather than kicking
    off a second, independent one: an in-flight fetch is by construction not yet cached and is
    talking to GitHub right now, so piggybacking on it already satisfies "give me fresh data", and
    it keeps the single-flight guarantee across a burst of Refresh clicks too.
    """
    global _inflight

    if not refresh:
        cached = _fresh_cached_catalog()
        if cached is not None:
            return cached  # fast path: no asyncio.Lock needed at all

    async with _async_lock:
        if not refresh:
            # Another leader may have just published a fresh catalog while we were getting here.
            cached = _fresh_cached_catalog()
            if cached is not None:
                return cached

        future = _inflight
        if future is None or future.done():
            # Leader. `future.done()` (not just `is None`) matters: it makes a leftover
            # `_inflight` pointer harmless instead of a permanent trap for every later caller.
            future = asyncio.get_running_loop().create_future()
            _inflight = future
            asyncio.create_task(_run_fetch(future))
        # else: follower, joins the in-flight `future` as-is.

    return await future  # outside the lock — the only real wait, costing a coroutine suspension.


async def _run_fetch(future: "asyncio.Future[Catalog]") -> None:
    """Runs exactly once per `_inflight` generation: the one real fetch, off the event loop."""
    global _inflight, _cache
    try:
        catalog = await run_in_threadpool(_build_catalog)
    except asyncio.CancelledError:
        if not future.done():
            future.cancel()
        raise
    except Exception as exc:
        if not future.done():
            future.set_exception(exc)
    else:
        with _cache_lock:  # the only moment this coroutine touches `_cache` — trivial, and the
            _cache = catalog  # same lock the sync path uses, so the two worlds never race on it.
        if not future.done():
            future.set_result(catalog)
    finally:
        async with _async_lock:
            if _inflight is future:  # someone else may already have moved `_inflight` on
                _inflight = None


def invalidate_cache() -> None:
    """Drop the cached catalog. A test hook, and only that.

    "Settings changed" is not a second reason to call it, because it cannot happen: the
    ``gallery_*`` settings are not in ``KatharaService._API_SETTINGS_KEYS`` and ``SettingsUpdate``
    does not expose them, so they come from env/config and are fixed for the life of the process.
    The only invalidation a running backend performs on its own is ``gallery_cache_ttl`` expiry.
    If ``gallery_*`` ever becomes runtime-editable, this is the call that has to be wired into
    ``update_settings`` in the same change.
    """
    global _cache
    with _cache_lock:
        _cache = None


def get_entry(lab_id: str) -> GalleryEntry:
    """The catalog entry for `lab_id`, or raise GalleryLabNotFoundError (404).

    Resolving the id against the catalog is what makes the install path safe: the *only* repo paths
    ever fetched are ones this server discovered itself, so a client can't turn an install into an
    arbitrary-path read.
    """
    entry = fetch_catalog().entries.get(lab_id)
    if entry is None:
        raise GalleryLabNotFoundError(f"Gallery lab `{lab_id}` not found.")
    return entry


def download_lab_files(entry: GalleryEntry) -> dict[str, bytes]:
    """Fetch a lab's files, keyed by their path *relative to the lab directory*.

    Bytes, not text: labs carry the occasional binary (a P4 build artifact, an image), and
    ``LabStore.write_lab`` takes either. Keys come from the repo tree, and are written through
    ``LabStore._safe_join``, so they cannot escape the lab directory.
    """
    settings = get_settings()
    if entry.n_files > settings.max_files_per_lab:
        raise GalleryUnavailableError(
            f"Gallery lab `{entry.id}` has {entry.n_files} files, more than the "
            f"{settings.max_files_per_lab} this import allows."
        )
    if entry.size_bytes > settings.max_bytes_per_lab:
        raise GalleryUnavailableError(
            f"Gallery lab `{entry.id}` is {format_mb(entry.size_bytes)}, more than the "
            f"{format_mb(settings.max_bytes_per_lab)} this import allows."
        )

    base = entry.id + "/"

    def fetch(client: httpx.Client, path: str) -> tuple[str, bytes]:
        try:
            response = client.get(_raw_url(path), timeout=FILE_TIMEOUT, follow_redirects=True)
        except httpx.HTTPError as exc:
            raise GalleryUnavailableError(f"Could not download `{path}`: {exc}") from exc
        if response.status_code != 200:
            raise GalleryUnavailableError(
                f"Could not download `{path}`: HTTP {response.status_code}."
            )
        content = response.content
        if len(content) > settings.max_bytes_per_file:
            raise GalleryUnavailableError(
                f"`{path}` is larger than the {format_mb(settings.max_bytes_per_file)} this import allows."
            )
        return path[len(base):], content

    with httpx.Client(headers={"User-Agent": "kathara-desktop"}) as client:
        with ThreadPoolExecutor(max_workers=DOWNLOAD_CONCURRENCY) as pool:
            files = dict(pool.map(lambda path: fetch(client, path), entry.files))

    total = sum(len(content) for content in files.values())
    if total > settings.max_bytes_per_lab:
        raise GalleryUnavailableError(
            f"Gallery lab `{entry.id}` downloaded to {format_mb(total)}, more than the "
            f"{format_mb(settings.max_bytes_per_lab)} this import allows."
        )
    if LAB_CONF_FILENAME not in files:
        # The tree said there was one; if it's gone the catalog is stale rather than the lab bad.
        raise GalleryUnavailableError(
            f"Gallery lab `{entry.id}` no longer has a {LAB_CONF_FILENAME} upstream. Refresh the catalog."
        )
    return files
