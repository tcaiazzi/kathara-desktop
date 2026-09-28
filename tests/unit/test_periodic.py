"""The background thread every poll the backend runs on its own gets (``services/periodic.py``)."""

import threading

from kathara_api.services.periodic import Periodic


def test_it_ticks_until_stopped_and_not_after():
    ticked = threading.Semaphore(0)
    poller = Periodic(ticked.release, 0.01, "test-poll")
    poller.start()
    try:
        assert ticked.acquire(timeout=2)
        assert ticked.acquire(timeout=2)
    finally:
        poller.stop()
    while ticked.acquire(blocking=False):  # a tick that was already under way when stop was asked
        pass

    assert not ticked.acquire(timeout=0.05)


def test_a_failing_tick_does_not_stop_the_next():
    calls = []
    again = threading.Event()

    def tick():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")
        again.set()

    poller = Periodic(tick, 0.01, "test-poll")
    poller.start()
    try:
        assert again.wait(2)
    finally:
        poller.stop()


def test_a_tick_that_never_returns_holds_up_no_other_poller():
    release = threading.Event()
    other_ticked = threading.Event()
    stuck = Periodic(release.wait, 0.01, "test-stuck")
    other = Periodic(other_ticked.set, 0.01, "test-other")
    stuck.start()
    other.start()
    try:
        assert other_ticked.wait(2)
    finally:
        release.set()
        stuck.stop()
        other.stop()


def test_starting_it_twice_runs_one_thread():
    poller = Periodic(lambda: None, 0.01, "test-once")
    poller.start()
    try:
        poller.start()
        assert [t.name for t in threading.enumerate()].count("test-once") == 1
    finally:
        poller.stop()
