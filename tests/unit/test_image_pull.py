"""Unit tests for the Docker image pull progress aggregator (no Docker required).

Every case here is fed synthetic `client.api.pull(decode=True)` lines. The one property worth
stating up front, because getting it wrong is silent: those lines are **absolute, not deltas**, so
the aggregator keys on the layer id and overwrites the byte count. A version that summed them
would report several times the real download size and still look plausible.
"""

import threading

import pytest

from kathara_api.errors import ImagePullBusyError
from kathara_api.services import image_pull


@pytest.fixture(autouse=True)
def _clean_state():
    image_pull.reset_for_tests()
    yield
    image_pull.reset_for_tests()


def _fs_layer(layer_id):
    return {"status": "Pulling fs layer", "id": layer_id}


def _downloading(layer_id, current, total):
    return {
        "status": "Downloading",
        "id": layer_id,
        "progressDetail": {"current": current, "total": total},
    }


def test_idle_snapshot_is_inactive_and_never_raises():
    snap = image_pull.snapshot()

    assert snap["active"] is False
    assert snap["image"] is None
    assert snap["downloaded_bytes"] == 0
    assert snap["total_bytes"] == 0


def test_pulling_from_line_sets_repo_without_inventing_a_layer():
    with image_pull.track(["ubuntu"]):
        image_pull.start_image("ubuntu", 0)
        # This line's `id` is the *tag*, not a layer id. Treating it as a layer would create a
        # phantom layer called "latest" and inflate layers_total forever.
        image_pull.note({"status": "Pulling from library/ubuntu", "id": "latest"})

        snap = image_pull.snapshot()

    assert snap["layers_total"] == 0
    assert snap["image"] == "ubuntu"


def test_byte_totals_use_latest_value_per_layer_not_the_sum_of_all_lines():
    with image_pull.track(["kathara/base"]):
        image_pull.start_image("kathara/base", 0)
        for layer in ("a", "b", "c"):
            image_pull.note(_fs_layer(layer))

        # Interleaved and out of order on purpose: three layers each reporting growing absolute
        # counts. Summing the lines would give 10+10+10+50+50+50 = 180.
        image_pull.note(_downloading("a", 10, 100))
        image_pull.note(_downloading("b", 10, 100))
        image_pull.note(_downloading("c", 10, 100))
        image_pull.note(_downloading("c", 50, 100))
        image_pull.note(_downloading("a", 50, 100))
        image_pull.note(_downloading("b", 50, 100))

        snap = image_pull.snapshot()

    assert snap["downloaded_bytes"] == 150
    assert snap["total_bytes"] == 300
    assert snap["layers_total"] == 3


def test_download_complete_without_progress_detail_snaps_layer_to_its_total():
    with image_pull.track(["kathara/base"]):
        image_pull.start_image("kathara/base", 0)
        image_pull.note(_fs_layer("a"))
        image_pull.note(_downloading("a", 40, 100))
        # Docker sends this one with no progressDetail at all, which is exactly why the layer's
        # total has to have been recorded earlier.
        image_pull.note({"status": "Download complete", "id": "a"})

        snap = image_pull.snapshot()

    assert snap["downloaded_bytes"] == 100
    assert snap["layers_done"] == 1


def test_already_existing_layer_counts_zero_and_is_done():
    with image_pull.track(["kathara/base"]):
        image_pull.start_image("kathara/base", 0)
        image_pull.note(_fs_layer("cached"))
        image_pull.note({"status": "Already exists", "id": "cached"})

        snap = image_pull.snapshot()

    # A cached layer contributes no bytes, and must not linger as a pending unknown.
    assert snap["downloaded_bytes"] == 0
    assert snap["total_bytes"] == 0
    assert snap["layers_done"] == 1


def test_total_stays_zero_until_a_layer_reports_one_then_grows():
    with image_pull.track(["kathara/base"]):
        image_pull.start_image("kathara/base", 0)
        image_pull.note(_fs_layer("a"))
        image_pull.note(_fs_layer("b"))

        # Layers announced but no sizes yet: "indeterminate", and the API says so honestly
        # rather than guessing.
        assert image_pull.snapshot()["total_bytes"] == 0

        image_pull.note(_downloading("a", 0, 100))
        assert image_pull.snapshot()["total_bytes"] == 100

        image_pull.note(_downloading("b", 0, 250))
        assert image_pull.snapshot()["total_bytes"] == 350


def test_downloaded_bytes_are_monotonic_across_two_images():
    with image_pull.track(["one", "two"]):
        image_pull.start_image("one", 0)
        image_pull.note(_fs_layer("a"))
        image_pull.note(_downloading("a", 100, 100))
        image_pull.note({"status": "Download complete", "id": "a"})
        first = image_pull.snapshot()

        image_pull.start_image("two", 1)
        second_start = image_pull.snapshot()
        image_pull.note(_fs_layer("b"))
        image_pull.note(_downloading("b", 30, 200))
        second = image_pull.snapshot()

    assert first["downloaded_bytes"] == 100
    assert first["images_done"] == 0
    # The finished image's bytes are folded in, so the counter never drops when the next one
    # starts from zero.
    assert second_start["downloaded_bytes"] == 100
    assert second["downloaded_bytes"] == 130
    assert second["total_bytes"] == 300
    assert second["images_done"] == 1
    assert second["images_total"] == 2


def test_extracting_is_reported_for_the_wording():
    with image_pull.track(["kathara/base"]):
        image_pull.start_image("kathara/base", 0)
        image_pull.note(_fs_layer("a"))
        image_pull.note(_downloading("a", 100, 100))
        image_pull.note({"status": "Extracting", "id": "a"})

        snap = image_pull.snapshot()

    assert snap["extracting"] is True
    assert "Extracting" in snap["detail"]


def test_one_layer_extracting_does_not_hide_the_others_still_downloading():
    # Docker interleaves extraction with the remaining downloads. A single sticky `extracting`
    # flag claimed "Extracting…" for the rest of the pull and replaced the live byte counter with
    # a line that looked stalled.
    with image_pull.track(["kathara/base"]):
        image_pull.start_image("kathara/base", 0)
        image_pull.note(_fs_layer("a"))
        image_pull.note(_fs_layer("b"))
        image_pull.note(_downloading("a", 100, 100))
        image_pull.note(_downloading("b", 20, 400))
        image_pull.note({"status": "Extracting", "id": "a"})

        snap = image_pull.snapshot()

    assert "Downloading" in snap["detail"]
    assert "Extracting" not in snap["detail"]
    assert snap["downloaded_bytes"] == 120
    assert snap["total_bytes"] == 500


def test_extracting_clears_once_the_layer_is_complete():
    with image_pull.track(["kathara/base"]):
        image_pull.start_image("kathara/base", 0)
        image_pull.note(_fs_layer("a"))
        image_pull.note(_downloading("a", 100, 100))
        image_pull.note({"status": "Extracting", "id": "a"})
        assert image_pull.snapshot()["extracting"] is True

        image_pull.note({"status": "Pull complete", "id": "a"})

        snap = image_pull.snapshot()

    assert snap["extracting"] is False


@pytest.mark.parametrize(
    "line",
    [
        {},
        {"status": "Downloading"},  # no id
        {"status": "Downloading", "id": "a", "progressDetail": {}},
        {"status": "Downloading", "id": "a", "progressDetail": {"current": None, "total": None}},
        {"status": "Digest: sha256:abc"},
        {"status": "Status: Image is up to date for ubuntu:latest"},
        {"id": "a"},  # no status
        {"status": "Pulling from ", "id": "latest"},  # empty repo
    ],
)
def test_malformed_lines_are_ignored_without_raising(line):
    with image_pull.track(["kathara/base"]):
        image_pull.start_image("kathara/base", 0)
        image_pull.note(line)

        snap = image_pull.snapshot()

    assert snap["downloaded_bytes"] == 0


def test_terminal_frame_keeps_the_totals_and_the_image_name():
    # The frame a poller sees right after the download ends. Clearing the in-flight pull without
    # folding its bytes in first made this report `0/0` with no image, i.e. a finished download
    # that looked like it had never started.
    with image_pull.track(["kathara/base"]):
        image_pull.start_image("kathara/base", 0)
        image_pull.note(_fs_layer("a"))
        image_pull.note(_downloading("a", 200, 200))
        image_pull.note({"status": "Pull complete", "id": "a"})

    snap = image_pull.snapshot()

    assert snap["finished"] is True
    assert snap["active"] is False
    assert snap["image"] == "kathara/base"
    assert snap["downloaded_bytes"] == 200
    assert snap["total_bytes"] == 200
    assert snap["images_done"] == 1


def test_a_fully_cached_image_reports_zero_bytes_not_a_fake_total():
    with image_pull.track(["kathara/base"]):
        image_pull.start_image("kathara/base", 0)
        image_pull.note(_fs_layer("cached"))
        image_pull.note({"status": "Already exists", "id": "cached"})

    snap = image_pull.snapshot()

    assert snap["downloaded_bytes"] == 0
    assert snap["total_bytes"] == 0


def test_lines_outside_an_operation_are_dropped():
    image_pull.note(_downloading("a", 10, 100))

    assert image_pull.snapshot()["active"] is False


def test_second_concurrent_operation_is_refused():
    with image_pull.track(["one"]):
        with pytest.raises(ImagePullBusyError):
            with image_pull.track(["two"]):
                pass


def test_slot_is_released_after_a_failed_operation():
    with pytest.raises(RuntimeError):
        with image_pull.track(["one"]):
            image_pull.start_image("one", 0)
            raise RuntimeError("registry exploded")

    snap = image_pull.snapshot()
    assert snap["active"] is False
    assert snap["error"] == "registry exploded"
    # And the slot really is free again, not just reported as such.
    with image_pull.track(["two"]):
        pass


def test_concurrent_notes_and_snapshots_stay_consistent():
    layers, per_layer = 8, 200
    with image_pull.track(["kathara/base"]):
        image_pull.start_image("kathara/base", 0)

        def feed(index):
            layer = f"layer{index}"
            image_pull.note(_fs_layer(layer))
            for step in range(1, per_layer + 1):
                image_pull.note(_downloading(layer, step, per_layer))

        errors = []

        def poll():
            for _ in range(500):
                try:
                    image_pull.snapshot()
                except Exception as exc:  # noqa: BLE001 - the point of the test
                    errors.append(exc)

        threads = [threading.Thread(target=feed, args=(i,)) for i in range(layers)]
        threads.append(threading.Thread(target=poll))
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        snap = image_pull.snapshot()

    assert not errors
    assert snap["layers_total"] == layers
    assert snap["downloaded_bytes"] == layers * per_layer


def test_format_bytes_is_readable_at_each_scale():
    assert image_pull.format_bytes(512) == "512 B"
    assert image_pull.format_bytes(1536) == "1.5 KB"
    assert image_pull.format_bytes(150 * 1024 * 1024) == "150 MB"
    assert image_pull.format_bytes(3 * 1024**3) == "3 GB"
