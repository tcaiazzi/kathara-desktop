import os

# The app's lifespan starts the disk watcher (services/lab_watch.py) on the process-wide service,
# `dependencies._service`, which no `dependency_overrides` reaches: every `with TestClient(app)`
# would have a thread polling whatever labs directory that service was built on. Off for the
# suite — the watcher's own tests build one where they need it, and test_lab_watch.py checks the
# lifespan's wiring with the interval set back. Set before anything imports kathara_api, since the
# settings object is built once, on first use (config.get_settings).
os.environ["KATHARA_API_LAB_WATCH_INTERVAL"] = "0"

import pytest
from fastapi.testclient import TestClient

from kathara_api.main import create_app


@pytest.fixture(scope="session")
def client():
    return TestClient(create_app())
