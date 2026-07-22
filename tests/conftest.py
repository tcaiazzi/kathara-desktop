import pytest
from fastapi.testclient import TestClient

from kathara_api.main import create_app


@pytest.fixture(scope="session")
def client():
    return TestClient(create_app())
