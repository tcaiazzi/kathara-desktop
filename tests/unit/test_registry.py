"""Unit tests for the in-memory lab registry."""

from pathlib import Path

from Kathara.model.Lab import Lab

from kathara_api.services.registry import LabRegistry


def test_add_if_absent_adds_once_per_id_and_keeps_the_first_labs_directory():
    registry = LabRegistry()
    first = Lab("lab1")
    second = Lab("lab1")

    assert registry.add_if_absent(first, Path("/labs/a")) is True
    assert registry.add_if_absent(second, Path("/labs/b")) is False
    assert registry.get(first.hash) is first
    assert registry.directory(first.hash) == Path("/labs/a")


def test_labs_are_keyed_by_hash_not_by_name():
    """Two labs with the same name but different hashes (two directories with the same basename)
    are two entries — the registry key is the lab's id, which is its hash."""
    registry = LabRegistry()
    first = Lab("lab1")
    second = Lab("lab1")
    second.hash = "otherhash"

    registry.add(first, Path("/a/lab1"))
    registry.add(second, Path("/b/lab1"))

    assert set(registry.ids()) == {first.hash, "otherhash"}
    assert registry.remove("otherhash") is second
    assert registry.directory("otherhash") is None
