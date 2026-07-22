"""Unit tests for the in-memory lab registry."""

from Kathara.model.Lab import Lab

from kathara_api.services.registry import LabRegistry


def test_add_if_absent_adds_once():
    registry = LabRegistry()
    first = Lab("lab1")
    second = Lab("lab1")

    assert registry.add_if_absent(first) is True
    assert registry.add_if_absent(second) is False
    assert registry.get("lab1") is first
