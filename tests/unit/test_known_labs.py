"""Unit tests for KnownLabs, the persisted list of lab folders opened from outside the labs root."""

import json

import pytest

from kathara_api.services.known_labs import KnownLabs


def test_the_list_survives_a_restart_most_recently_opened_first(tmp_path):
    state = tmp_path / "state" / "known_labs.json"
    known = KnownLabs(state)
    known.add(tmp_path / "a")
    known.add(tmp_path / "b")
    known.add(tmp_path / "a")

    assert KnownLabs(state).dirs() == [tmp_path / "a", tmp_path / "b"]


def test_remove_and_replace_are_written_through(tmp_path):
    state = tmp_path / "known_labs.json"
    known = KnownLabs(state)
    for name in ("a", "b", "c"):
        known.add(tmp_path / name)

    known.replace(tmp_path / "b", tmp_path / "b2")
    known.remove(tmp_path / "a")

    assert KnownLabs(state).dirs() == [tmp_path / "c", tmp_path / "b2"]


def test_the_file_records_absolute_paths_under_a_version(tmp_path):
    state = tmp_path / "known_labs.json"
    KnownLabs(state).add(tmp_path / "a")

    assert json.loads(state.read_text()) == {"version": 1, "labs": [{"path": str(tmp_path / "a")}]}


@pytest.mark.parametrize(
    "content",
    ["not json", "[]", '{"labs": "nope"}', '{"version": 1}'],
    ids=["garbage", "a list", "labs not a list", "no labs"],
)
def test_an_unusable_file_is_read_as_empty_rather_than_failing(tmp_path, content):
    state = tmp_path / "known_labs.json"
    state.write_text(content)

    assert KnownLabs(state).dirs() == []


def test_entries_that_are_not_absolute_paths_are_skipped(tmp_path):
    state = tmp_path / "known_labs.json"
    good = str(tmp_path / "good")
    state.write_text(json.dumps({"labs": [{"path": "relative"}, {"nope": 1}, "x", {"path": good}, {"path": good}]}))

    assert [str(d) for d in KnownLabs(state).dirs()] == [good]


def test_without_a_file_the_list_lives_in_memory_only(tmp_path):
    known = KnownLabs(None)
    known.add(tmp_path / "a")

    assert known.dirs() == [tmp_path / "a"]
    assert list(tmp_path.iterdir()) == []
