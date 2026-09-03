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
"""

import logging
import posixpath
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from threading import Lock
from typing import Optional
from urllib.parse import quote

import httpx

from ..config import get_settings
from ..errors import GalleryLabNotFoundError, GalleryUnavailableError

logger = logging.getLogger("kathara_api")

LAB_CONF = "lab.conf"

# What a single lab is allowed to be. The labs upstream are ~17 files / ~20 KB; these bounds exist
# so a mis-set gallery_repo (or a hostile fork) can't turn one click into a disk-filling download.
MAX_FILES_PER_LAB = 200
MAX_BYTES_PER_FILE = 5 * 1024 * 1024
MAX_BYTES_PER_LAB = 20 * 1024 * 1024

# Enough for a cold GitHub tree of a few thousand entries, short enough that a hung upstream
# doesn't hold a request open indefinitely.
TREE_TIMEOUT = 20.0
FILE_TIMEOUT = 20.0
# Files are small, so wall-clock is dominated by round trips; 8 keeps a 55-file lab under a second
# without hammering the CDN.
DOWNLOAD_CONCURRENCY = 8

# Markdown link: [text](target)
_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]+)")


@dataclass
class GalleryEntry:
    """One lab in the catalog, plus everything needed to install it without a second tree fetch."""

    id: str
    name: str
    category: str
    category_title: Optional[str] = None
    category_order: int = 0
    title: Optional[str] = None
    description: Optional[str] = None
    # Repo-relative paths of every blob under the lab directory.
    files: list[str] = field(default_factory=list)
    size_bytes: int = 0
    slides_url: Optional[str] = None
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
    # Insertion-ordered by (category order, lab name) so the frontend can group by walking the list.
    entries: dict[str, GalleryEntry]


# Module-level cache, mirroring the `_IMAGES_CACHE_TTL` precedent in kathara_service.py and there
# for the same reason: a slow, rate-limited remote listing must not run once per request. The lock
# is held across the fetch so a burst of first requests produces one upstream call, not N.
_cache: Optional[Catalog] = None
_cache_lock = Lock()


def _api_base() -> str:
    return f"https://api.github.com/repos/{get_settings().gallery_slug()}"


def _raw_url(path: str) -> str:
    s = get_settings()
    return f"https://raw.githubusercontent.com/{s.gallery_slug()}/{quote(s.gallery_ref_value())}/{quote(path)}"


def _blob_url(path: str) -> str:
    s = get_settings()
    return f"https://github.com/{s.gallery_slug()}/blob/{quote(s.gallery_ref_value())}/{quote(path)}"


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
        blob["path"][: -len(LAB_CONF) - 1]
        for blob in blobs
        if blob["path"].startswith(prefix) and blob["path"].endswith("/" + LAB_CONF)
    )
    if not roots:
        return {}

    names = _disambiguate(roots)
    # One pass over the blobs per lab would be O(labs x blobs); bucket by root instead.
    files: dict[str, list[str]] = {root: [] for root in roots}
    sizes: dict[str, int] = dict.fromkeys(roots, 0)
    by_dir: dict[str, list[str]] = {}
    for blob in blobs:
        path = blob["path"]
        parent = posixpath.dirname(path)
        by_dir.setdefault(parent, []).append(path)
        # A lab's files are the blobs under its directory. Roots never nest (no lab.conf has
        # another lab.conf beneath it), so a blob belongs to at most one lab.
        root = parent
        while root:
            if root in files:
                files[root].append(path)
                sizes[root] += int(blob.get("size") or 0)
                break
            root = posixpath.dirname(root)

    entries: dict[str, GalleryEntry] = {}
    for root in roots:
        relative = root[len(prefix):]
        # Slides live *beside* the lab directory, in its parent — outside the lab, so they are
        # linked and never downloaded.
        slides = sorted(
            path
            for path in by_dir.get(posixpath.dirname(root), [])
            if path.lower().endswith(".pdf")
        )
        entries[root] = GalleryEntry(
            id=root,
            name=names[root],
            category=relative.split("/")[0] if "/" in relative else relative,
            files=sorted(files[root]),
            size_bytes=sizes[root],
            slides_url=_blob_url(slides[0]) if slides else None,
            repo_url=_tree_url(root),
        )
    return entries


def _parse_readme_table(text: str, readme_dir: str) -> list[tuple[str, str, str]]:
    """Rows of a category README's lab table as ``(lab-or-dir path, title, description)``.

    Upstream documents each lab in a ``| Name | Description | Slides | Lab |`` table whose Lab cell
    links the lab's ``.zip``; dropping the ``.zip`` yields the lab directory. Rows with no archive
    (``-``) fall back to the Slides link's directory. Either way the path is a *candidate* — the
    caller matches it against real labs, so a table that has drifted from the tree simply produces
    no descriptions rather than wrong ones.
    """
    rows: list[tuple[str, str, str]] = []
    columns: Optional[dict[str, int]] = None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            columns = None  # a table ends where the pipes stop
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if columns is None:
            headers = [cell.strip().lower() for cell in cells]
            if "name" in headers and "description" in headers:
                columns = {name: i for i, name in enumerate(headers)}
            continue
        if all(set(cell) <= {"-", ":", ""} for cell in cells):
            continue  # the |---|---| separator
        if len(cells) <= max(columns.values()):
            continue

        def cell(key: str) -> str:
            index = columns.get(key, -1)
            return cells[index] if 0 <= index < len(cells) else ""

        title = cell("name").replace("*", "").strip()
        description = cell("description").strip()
        target = ""
        lab_link = _LINK_RE.search(cell("lab"))
        if lab_link and lab_link.group(2).endswith(".zip"):
            target = posixpath.normpath(posixpath.join(readme_dir, lab_link.group(2)[: -len(".zip")]))
        else:
            slides_link = _LINK_RE.search(cell("slides"))
            if slides_link:
                target = posixpath.dirname(
                    posixpath.normpath(posixpath.join(readme_dir, slides_link.group(2)))
                )
        if target and (title or description):
            rows.append((target, title, description))
    return rows


def _parse_section_index(text: str) -> list[tuple[str, str]]:
    """``(slug, title)`` for each category linked from the section README, in document order.

    Only used for presentation: it gives the categories their upstream titles ("Basic Topics") and
    the pedagogical order the course uses, which alphabetical sorting would scramble.
    """
    seen: dict[str, str] = {}
    for title, target in _LINK_RE.findall(text):
        slug = posixpath.normpath(target).strip("/")
        if "/" in slug or slug.startswith(".") or not slug or slug in seen:
            continue
        seen[slug] = re.sub(r"\s+", " ", title).strip()
    return list(seen.items())


def _get_text(client: httpx.Client, path: str) -> Optional[str]:
    """Fetch a repo file as text, or None if it isn't there / can't be read.

    Used only for the READMEs behind titles and descriptions, which are decoration: a failure here
    must never cost the user the catalog itself.
    """
    try:
        response = client.get(_raw_url(path), timeout=FILE_TIMEOUT, follow_redirects=True)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    return response.text


def _enrich(entries: dict[str, GalleryEntry], section: str) -> None:
    """Attach titles, descriptions and category ordering from the repo's READMEs, best-effort.

    Deliberately failure-tolerant, like ``examples.list_examples`` skipping one broken example: a
    reorganised or table-less section (``main-labs/p4`` has no table) leaves the affected labs with
    just a name, which the frontend renders fine.
    """
    categories = sorted({entry.category for entry in entries.values() if entry.category})
    readme_dirs = [f"{section}/{category}".strip("/") for category in categories]
    # Category READMEs sometimes only index sub-sections (interdomain-routing -> frr/, quagga/),
    # so also read the README of every directory on the way down to a lab.
    for entry in entries.values():
        parent = posixpath.dirname(entry.id)
        while parent and parent != section and parent not in readme_dirs:
            readme_dirs.append(parent)
            parent = posixpath.dirname(parent)

    with httpx.Client(headers={"User-Agent": "kathara-ide"}) as client:
        with ThreadPoolExecutor(max_workers=DOWNLOAD_CONCURRENCY) as pool:
            index = pool.submit(_get_text, client, f"{section}/README.md".strip("/"))
            readmes = list(
                pool.map(lambda d: (d, _get_text(client, f"{d}/README.md")), sorted(set(readme_dirs)))
            )
            section_index = index.result()

    order: dict[str, int] = {}
    titles: dict[str, str] = {}
    for position, (slug, title) in enumerate(_parse_section_index(section_index or "")):
        order[slug] = position
        titles[slug] = title

    # Two ways a row matches a lab: it names the lab directory outright, or it names a directory the
    # lab sits under (which is how the grouped labs — ospf, subnetting — are documented).
    exact: dict[str, tuple[str, str]] = {}
    prefixes: dict[str, tuple[str, str]] = {}
    for readme_dir, text in readmes:
        if not text:
            continue
        for target, title, description in _parse_readme_table(text, readme_dir):
            exact.setdefault(target, (title, description))
            prefixes.setdefault(target, (title, description))

    for entry in entries.values():
        entry.category_title = titles.get(entry.category)
        entry.category_order = order.get(entry.category, len(order))
        match = exact.get(entry.id)
        if match is None:
            # Longest enclosing directory wins, so a lab-specific row beats a section-wide one.
            candidates = [path for path in prefixes if entry.id.startswith(path + "/")]
            if candidates:
                match = prefixes[max(candidates, key=len)]
        if match:
            entry.title = match[0] or None
            entry.description = match[1] or None


def _build_catalog() -> Catalog:
    settings = get_settings()
    section = settings.gallery_section_path()
    entries = _build_entries(_fetch_tree(), section)
    try:
        _enrich(entries, section)
    except Exception:  # noqa: BLE001 - decoration must never cost the catalog
        logger.exception("could not read gallery READMEs; listing labs without descriptions")
    ordered = dict(
        sorted(entries.items(), key=lambda kv: (kv[1].category_order, kv[1].category, kv[1].name))
    )
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


def invalidate_cache() -> None:
    """Drop the cached catalog (settings changed, or a test wants a clean slate)."""
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
    if entry.n_files > MAX_FILES_PER_LAB:
        raise GalleryUnavailableError(
            f"Gallery lab `{entry.id}` has {entry.n_files} files, more than the "
            f"{MAX_FILES_PER_LAB} this import allows."
        )
    if entry.size_bytes > MAX_BYTES_PER_LAB:
        raise GalleryUnavailableError(
            f"Gallery lab `{entry.id}` is {entry.size_bytes} bytes, more than the "
            f"{MAX_BYTES_PER_LAB} this import allows."
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
        if len(content) > MAX_BYTES_PER_FILE:
            raise GalleryUnavailableError(
                f"`{path}` is larger than the {MAX_BYTES_PER_FILE} bytes this import allows."
            )
        return path[len(base):], content

    with httpx.Client(headers={"User-Agent": "kathara-ide"}) as client:
        with ThreadPoolExecutor(max_workers=DOWNLOAD_CONCURRENCY) as pool:
            files = dict(pool.map(lambda path: fetch(client, path), entry.files))

    total = sum(len(content) for content in files.values())
    if total > MAX_BYTES_PER_LAB:
        raise GalleryUnavailableError(
            f"Gallery lab `{entry.id}` downloaded to {total} bytes, more than the "
            f"{MAX_BYTES_PER_LAB} this import allows."
        )
    if LAB_CONF not in files:
        # The tree said there was one; if it's gone the catalog is stale rather than the lab bad.
        raise GalleryUnavailableError(
            f"Gallery lab `{entry.id}` no longer has a {LAB_CONF} upstream. Refresh the catalog."
        )
    return files
