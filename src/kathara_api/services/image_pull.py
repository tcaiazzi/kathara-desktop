"""Docker image pre-checks and the explicit pre-deploy image download.

Kathara pulls a missing device image *inside* ``deploy_lab``, from
``DockerMachine.deploy_machines`` -> ``DockerImage.check_from_list``, reporting progress only
through its own ``EventDispatcher``. This module exists so the app can instead do that work as a
separate, visible step *before* a deploy: classify a lab's images (missing / outdated), then pull
what the user approved while a poll-able snapshot describes how far along it is.

Two deliberate departures from reusing Kathara's own code:

* ``DockerImage.check_for_updates`` dispatches ``docker_image_update_found`` instead of returning
  a verdict, and ``DockerImage.pull`` dispatches a ``docker_pull_progress`` event per stream line.
  Consuming either would mean registering ``EventDispatcher`` listeners, whose callbacks run on
  Kathara's own deploy thread pool — and an exception in a listener *fails the deploy*
  (``machines_pool.map`` re-raises from the worker, and ``DockerImage.pull``'s progress loop is
  unguarded). Calling ``client.api.pull`` ourselves keeps all of that out of the deploy path.
* The CLI asks about an image update from inside the deploy, by blocking on a terminal prompt
  (``cli/ui/event/UpdateDockerImage.py``). Here the question has to reach a browser and come back,
  so it is asked *before* the deploy starts, by the pre-check below — never while
  ``KatharaService._mutate_lock`` is held.

The digest comparison in ``_remote_digest``/``classify_images`` is a deliberate re-implementation
of ``DockerImage.check_for_updates`` (Kathara/manager/docker/DockerImage.py:65-98). Keep the two
in sync: if upstream changes how it decides "outdated" (multi-arch handling, say), this diverges
silently. The table-driven tests in tests/unit/test_image_endpoints.py are what make that visible.
"""

from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterable, Iterator, Optional

from docker.errors import APIError, ImageNotFound

from ..errors import ImagePullBusyError, ImagePullError

logger = logging.getLogger("kathara_api")

# Wall-clock budget for the whole "is anything outdated?" phase. Kathara builds its Docker client
# with `timeout=None` (DockerManager.py:66), so a registry that accepts the connection but never
# answers would otherwise hang this check — which sits directly in front of the Deploy button.
UPDATE_CHECK_BUDGET_SECONDS = 5.0

# Docker pull stream statuses that mean "this layer needs no more bytes". `Download complete`
# carries no `progressDetail`, which is why a layer's recorded total is what it snaps to.
_LAYER_DONE_STATUSES = frozenset(
    {"Verifying Checksum", "Download complete", "Extracting", "Pull complete"}
)

_PULLING_FROM_PREFIX = "Pulling from "


def format_bytes(value: int) -> str:
    """Human-readable byte count for the server-authored ``detail`` line."""
    if value < 1024:
        return f"{value} B"
    for unit in ("KB", "MB", "GB"):
        value /= 1024.0
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}".replace(".0 ", " ")
    return f"{value:.1f} GB"


# ---------------------------------------------------------------------------
# Image classification (the pre-check)
# ---------------------------------------------------------------------------


def _remote_digest(docker_image: Any, name: str) -> Optional[str]:
    """The manifest digest the registry currently serves for ``name``, or None if unknowable."""
    return docker_image.get_remote(name).attrs["Descriptor"]["digest"]


def classify_images(
    docker_image: Any,
    names: Iterable[str],
    *,
    check_updates: bool,
    budget: Optional[float] = None,
) -> dict[str, str]:
    """Map each image name to ``"ok"``, ``"missing"``, ``"outdated"`` or ``"unknown"``.

    ``missing`` and ``outdated`` are the only actionable states; ``unknown`` means the registry
    couldn't be consulted (offline, or slower than ``budget``) and is reported separately from
    ``ok`` only so the response doesn't assert something it doesn't know.

    Never raises for a per-image failure: this runs in front of Deploy, and a broken check must
    not be able to block a deploy that would otherwise work.
    """
    # Resolved here rather than as a default argument so the module constant stays the single
    # source of truth (a default is bound at def time, and so couldn't be overridden or patched).
    budget = UPDATE_CHECK_BUDGET_SECONDS if budget is None else budget
    names = list(dict.fromkeys(names))
    states: dict[str, str] = {}
    local: dict[str, Any] = {}

    # Local phase: no network, sub-millisecond per image.
    for name in names:
        try:
            local[name] = docker_image.get_local(name)
        except ImageNotFound:
            states[name] = "missing"
        except APIError:
            # Anything else the daemon says (a 500, an auth failure, an unusable reference) is not
            # evidence that the image is absent. Reporting it as `missing` would put a *mandatory*
            # download in front of a lab whose images are all present.
            logger.debug("image presence check failed for %s", name, exc_info=True)
            states[name] = "unknown"
        except Exception:  # noqa: BLE001 - a broken check must never block a deploy
            logger.debug("image presence check failed for %s", name, exc_info=True)
            states[name] = "unknown"

    if not check_updates:
        for name in local:
            states[name] = "ok"
        return {name: states[name] for name in names}

    # Remote phase: one registry round-trip per present image, in parallel and under one shared
    # deadline. Anything still unfinished when the deadline passes stays `unknown`.
    checkable: dict[str, Any] = {}
    for name, image in local.items():
        # Mirrors check_for_updates' own early exits: a digest-pinned reference can't drift, and a
        # locally built image has no RepoDigests to compare against.
        if "@" in name or not (image.attrs.get("RepoDigests") or []):
            states[name] = "ok"
        else:
            checkable[name] = image

    for name in checkable:
        states[name] = "unknown"

    if checkable:
        # Plain daemon threads, deliberately not a ThreadPoolExecutor: its workers are non-daemon
        # and `concurrent.futures` joins them from an interpreter-exit hook, while
        # `shutdown(wait=False)` cannot cancel a future that is already running. So one
        # `get_registry_data` that never answers — entirely possible, since Kathara builds its
        # Docker client with `timeout=None` — would stop this process from ever exiting. A daemon
        # thread abandoned past the deadline just dies with the process instead.
        #
        # Uncapped because the set is a lab's *distinct* images (deduped above): a handful in
        # practice, and each thread is short-lived and purely latency-bound.
        digests: dict[str, str] = {}

        def probe(image_name: str) -> None:
            try:
                digest = _remote_digest(docker_image, image_name)
            except Exception:  # noqa: BLE001 - an unanswered probe simply stays `unknown`
                # Same call Kathara makes, and the same conclusion it draws on failure
                # ("Cannot check updates, skipping...").
                logger.debug("update check failed for %s", image_name, exc_info=True)
                return
            if digest:
                digests[image_name] = digest

        threads = [
            threading.Thread(target=probe, args=(name,), daemon=True, name=f"kathara-imgcheck-{name}")
            for name in checkable
        ]
        for thread in threads:
            thread.start()
        # One shared deadline, not one per thread: the budget bounds the *endpoint*, and this call
        # sits directly in front of the Deploy button.
        deadline = time.monotonic() + budget
        for thread in threads:
            thread.join(max(0.0, deadline - time.monotonic()))

        for name, image in checkable.items():
            remote = digests.get(name)
            if remote is None:
                continue  # stays `unknown`: refused, offline, or slower than the budget
            repo_digests = image.attrs.get("RepoDigests") or []
            local_digest = repo_digests[0].rsplit("@", 1)[-1]
            states[name] = "outdated" if remote != local_digest else "ok"

    return {name: states[name] for name in names}


# ---------------------------------------------------------------------------
# Download progress state
# ---------------------------------------------------------------------------


class _Layer:
    __slots__ = ("current", "total", "done", "extracting")

    def __init__(self) -> None:
        self.current = 0
        self.total = 0
        self.done = False
        self.extracting = False


class _Pull:
    """One image's in-flight pull."""

    __slots__ = ("name", "repo", "tag", "layers")

    def __init__(self, name: str) -> None:
        self.name = name
        self.repo: Optional[str] = None
        self.tag: Optional[str] = None
        self.layers: dict[str, _Layer] = {}

    @property
    def extracting(self) -> bool:
        """Whether a layer is being unpacked *right now*.

        Derived per layer rather than latched on the first `Extracting` line: Docker interleaves
        extraction with the remaining downloads, so a single sticky flag claimed "extracting" for
        the rest of a multi-layer pull and hid the byte counter behind it.
        """
        return any(layer.extracting for layer in self.layers.values())

    @property
    def downloaded(self) -> int:
        return sum(layer.current for layer in self.layers.values())

    @property
    def total(self) -> int:
        return sum(layer.total for layer in self.layers.values())

    @property
    def layers_done(self) -> int:
        return sum(1 for layer in self.layers.values() if layer.done)


class _State:
    """One whole download operation, however many images it covers."""

    __slots__ = (
        "images",
        "index",
        "started_at",
        "pull",
        "last_image",
        "completed_downloaded",
        "completed_total",
        "error",
        "finished",
    )

    def __init__(self, images: list[str]) -> None:
        self.images = images
        self.index = 0
        self.started_at = time.monotonic()
        self.pull: Optional[_Pull] = None
        # Kept once `pull` is cleared, so a finished operation can still say what it downloaded
        # instead of reporting a bare 0/0 with no image name.
        self.last_image: Optional[str] = None
        self.completed_downloaded = 0
        self.completed_total = 0
        self.error: Optional[str] = None
        self.finished = False

    def retire_pull(self) -> None:
        """Fold the current pull's bytes into the operation's running totals and drop it.

        Tracking downloaded and total separately (rather than assuming they are equal once an
        image is done) keeps both figures honest for a partially-cached image, where layers that
        `Already exists` contribute nothing to either.
        """
        if self.pull is None:
            return
        self.completed_downloaded += self.pull.downloaded
        self.completed_total += self.pull.total
        self.last_image = self.pull.name
        self.pull = None


# Guards `_state` only, and is held for microseconds of dict arithmetic. Deliberately not
# KatharaService._mutate_lock: the progress endpoint must never be able to block behind a deploy.
_lock = threading.Lock()
_state: Optional[_State] = None

# How long a finished operation stays readable, so the last poll sees a terminal frame instead of
# a bare "nothing is running".
_RETAIN_SECONDS = 10.0
_finished_at: float = 0.0


def _evict_locked() -> None:
    global _state
    if _state is not None and _state.finished and time.monotonic() - _finished_at > _RETAIN_SECONDS:
        _state = None


@contextmanager
def track(images: list[str]) -> Iterator[None]:
    """Claim the single download slot for ``images``, releasing it on the way out.

    Raises ImagePullBusyError if a download is already running. The check and the claim happen in
    the same critical section, so there is no window for two operations to both pass.
    """
    global _state, _finished_at
    with _lock:
        _evict_locked()
        if _state is not None and not _state.finished:
            raise ImagePullBusyError(
                "An image download is already in progress. Wait for it to finish."
            )
        _state = _State(list(images))
    try:
        yield
    except Exception as exc:
        with _lock:
            if _state is not None:
                _state.error = str(exc) or exc.__class__.__name__
        raise
    finally:
        with _lock:
            if _state is not None:
                _state.retire_pull()
                _state.finished = True
            _finished_at = time.monotonic()


def start_image(name: str, position: int) -> None:
    """Mark ``name`` (0-based ``position`` in the operation) as the image now being pulled."""
    with _lock:
        if _state is None:
            return
        _state.retire_pull()
        _state.index = position
        _state.pull = _Pull(name)


def note(line: dict[str, Any]) -> None:
    """Fold one decoded line of a Docker pull stream into the current state.

    The lines are *absolute*, not deltas, and keyed by layer id — so overwriting a layer's
    ``current`` is what keeps bytes from being counted twice.
    """
    try:
        with _lock:
            if _state is None or _state.pull is None:
                return
            pull = _state.pull
            status = line.get("status") or ""
            layer_id = line.get("id")

            # Must come before any layer branch: this line's `id` is the *tag*, not a layer, so
            # treating it as one invents a phantom layer called e.g. "latest".
            if status.startswith(_PULLING_FROM_PREFIX):
                pull.repo = status[len(_PULLING_FROM_PREFIX) :].strip() or None
                pull.tag = layer_id
                return

            if not layer_id:
                return

            if status == "Pulling fs layer":
                pull.layers.setdefault(layer_id, _Layer())
                return

            layer = pull.layers.setdefault(layer_id, _Layer())

            if status == "Downloading":
                detail = line.get("progressDetail") or {}
                current = detail.get("current")
                total = detail.get("total")
                if isinstance(current, int):
                    layer.current = current
                if isinstance(total, int) and total > 0:
                    layer.total = total
                return

            if status == "Already exists":
                # A cached layer contributes no bytes, and must not linger as a pending unknown.
                layer.total = 0
                layer.current = 0
                layer.done = True
                return

            if status in _LAYER_DONE_STATUSES:
                layer.done = True
                layer.current = layer.total
                if status == "Extracting":
                    layer.extracting = True
                elif status == "Pull complete":
                    layer.extracting = False
                return
    except Exception:  # noqa: BLE001 - progress bookkeeping must never break a download
        logger.debug("failed to record image pull progress", exc_info=True)


def _detail_locked(state: _State) -> str:
    if state.error:
        return state.error
    if state.finished:
        return "Download complete."
    pull = state.pull
    if pull is None:
        return "Preparing download…"
    total = pull.total
    # Bytes take priority while any remain: with several layers, one can be unpacking while the
    # others are still downloading, and "Extracting…" there would replace live progress with a
    # line that looks stalled.
    if pull.extracting and (total == 0 or pull.downloaded >= total):
        return f"Extracting {pull.name}…"
    if total > 0:
        return (
            f"Downloading {pull.name} — {format_bytes(pull.downloaded)} of {format_bytes(total)}"
        )
    return f"Downloading {pull.name}…"


def snapshot() -> dict[str, Any]:
    """Current state of the single download slot. Never raises; ``active`` is False when idle."""
    with _lock:
        _evict_locked()
        if _state is None:
            return {
                "active": False,
                "finished": False,
                "image": None,
                "images_total": 0,
                "images_done": 0,
                "downloaded_bytes": 0,
                "total_bytes": 0,
                "layers_total": 0,
                "layers_done": 0,
                "extracting": False,
                "elapsed_seconds": 0.0,
                "detail": "",
                "error": None,
            }
        state = _state
        pull = state.pull
        return {
            "active": not state.finished,
            "finished": state.finished,
            "image": pull.name if pull is not None else state.last_image,
            "images_total": len(state.images),
            "images_done": len(state.images) if state.finished else state.index,
            "downloaded_bytes": state.completed_downloaded + (pull.downloaded if pull else 0),
            "total_bytes": state.completed_total + (pull.total if pull else 0),
            "layers_total": len(pull.layers) if pull else 0,
            "layers_done": pull.layers_done if pull else 0,
            "extracting": bool(pull.extracting) if pull else False,
            "elapsed_seconds": round(time.monotonic() - state.started_at, 1),
            "detail": _detail_locked(state),
            "error": state.error,
        }


def reset_for_tests() -> None:
    """Drop all state. Only for tests — the retention window makes this awkward otherwise."""
    global _state, _finished_at
    with _lock:
        _state = None
        _finished_at = 0.0


# ---------------------------------------------------------------------------
# The download itself
# ---------------------------------------------------------------------------


def pull_images(manager: Any, images: list[str]) -> list[str]:
    """Pull every name in ``images``, in order, recording progress as the streams arrive.

    No "already present, skip" shortcut on purpose: an *outdated* image is present locally, so a
    presence check here would skip exactly the updates the caller asked for. Callers send only
    what needs pulling; a redundant request costs Docker a fraction of a second ("Image is up to
    date", every layer ``Already exists``).
    """
    docker_image = manager.docker_image
    client = manager.client
    pulled: list[str] = []
    with track(images):
        for position, name in enumerate(images):
            start_image(name, position)
            # Surfaces a nonexistent reference as a clean error now, rather than mid-stream.
            docker_image.get_remote(name)
            for line in client.api.pull(name, stream=True, decode=True):
                if not isinstance(line, dict):
                    continue
                error = line.get("error")
                if error:
                    raise ImagePullError(f"Failed to download `{name}`: {error}")
                note(line)
            pulled.append(name)
    return pulled
