"""Bundled example network scenarios (src/kathara_api/examples/), shipped as package data so they
reach every deployment — desktop, Docker Compose, a plain ``pip install`` — through the ordinary
build, with no per-deployment wiring beyond the optional ``examples_dir`` override in config.py.

Deliberately read through ``LabStore`` rather than a second directory walker: ``lab_names()``
already skips dotfiles/temp dirs, ``lab_dir()`` already sanitizes an id into a single safe path
segment (so a malformed id can never escape the catalog root), and ``read_lab()`` already reads a
lab directory into the same text file map ``translate_lab_files`` expects. Nothing here ever
writes through that ``LabStore`` — the examples directory is read-only package data; turning one
into a real lab is ``KatharaService.install_example``, which copies it into the *labs* store.
"""

import logging
from pathlib import Path

from ..config import get_settings
from ..errors import ExampleNotFoundError
from ..schemas.examples import ExampleSummary
from . import lab_import
from .lab_store import LabStore

logger = logging.getLogger("kathara_api")


def _catalog() -> LabStore:
    return LabStore(get_settings().examples_dir_path())


def list_examples(installed: set[str]) -> list[ExampleSummary]:
    """Every bundled example this build ships, each flagged against `installed` (the caller's own
    set of already-existing lab names — see KatharaService.list_example_labs).

    An example whose lab.conf fails to parse is logged and skipped, never raised: a single broken
    bundled example must not 500 the whole welcome screen for everyone.
    """
    catalog = _catalog()
    summaries: list[ExampleSummary] = []
    for example_id in catalog.lab_names():
        try:
            files, _dirs = catalog.read_lab(catalog.lab_dir(example_id))
            t = lab_import.translate_lab_files(files, example_id)
            if t.errors:
                raise ValueError("; ".join(t.errors))
        except Exception:
            logger.exception("skipping unreadable bundled example %r", example_id)
            continue
        summaries.append(
            ExampleSummary(
                id=example_id,
                description=t.payload.metadata.description or None,
                author=t.payload.metadata.author or None,
                n_machines=t.machine_count,
                installed=example_id in installed,
            )
        )
    return summaries


def example_dir(example_id: str) -> Path:
    """Absolute path to a bundled example's directory, or raise ExampleNotFoundError (404).

    ``LabStore.lab_dir`` sanitizes `example_id` into a single safe path segment first (rejecting
    "..", "/", "\\\\", …), so this can never resolve outside the catalog root regardless of what a
    client sends — a malformed id surfaces as sanitize_lab_name's own ApiError (400) instead.
    """
    directory = _catalog().lab_dir(example_id)
    if not directory.is_dir() or not (directory / "lab.conf").is_file():
        raise ExampleNotFoundError(f"Example `{example_id}` not found.")
    return directory
