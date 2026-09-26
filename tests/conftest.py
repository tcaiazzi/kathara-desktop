import os
import tempfile

# The app's lifespan starts the disk watcher (services/lab_watch.py) on the process-wide service,
# `dependencies._service`, which no `dependency_overrides` reaches: every `with TestClient(app)`
# would have a thread polling whatever labs directory that service was built on. Off for the
# suite — the watcher's own tests build one where they need it, and test_lab_watch.py checks the
# lifespan's wiring with the interval set back. Set before anything imports kathara_api, since the
# settings object is built once, on first use (config.get_settings).
os.environ["KATHARA_API_LAB_WATCH_INTERVAL"] = "0"
# Every Settings save writes kathara.conf, and the default one is the user's real file, shared with
# the Kathara CLI. The suite gets a throwaway directory instead; tests about the file itself point
# `kathara_conf_dir` at their own `tmp_path`.
os.environ["KATHARA_API_KATHARA_CONF_DIR"] = tempfile.mkdtemp(prefix="kathara-conf-")

import pytest
from fastapi.testclient import TestClient

from kathara_api.main import create_app


@pytest.fixture(scope="session")
def client():
    return TestClient(create_app())
