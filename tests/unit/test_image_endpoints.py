"""Unit tests for the image pre-check and download endpoints (no Docker required).

The pre-check (`GET /labs/{lab}/images`) is what lets the app offer the image download as its own
visible step before a deploy, instead of letting Kathara pull silently inside `POST .../deploy`.
Its digest comparison is a deliberate re-implementation of Kathara's `DockerImage.check_for_updates`
(Kathara/manager/docker/DockerImage.py:65-98) — the table-driven cases below are what make a
divergence visible when Kathara is upgraded.
"""

import threading
import time
from types import SimpleNamespace

import pytest
import requests
from docker.errors import APIError, ImageNotFound
from fastapi.testclient import TestClient
from Kathara.setting.Setting import Setting

from kathara_api.dependencies import get_service
from kathara_api.main import create_app
from kathara_api.schemas.lab import LabCreate
from kathara_api.services import image_pull, lab_builder
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase, lab_id, make_service, register_lab


@pytest.fixture(autouse=True)
def _clean_state():
    image_pull.reset_for_tests()
    # The Setting singleton is process-wide, so a policy tweak has to be undone or it leaks into
    # every later test in the session.
    previous = Setting.get_instance().image_update_policy
    yield
    Setting.get_instance().image_update_policy = previous
    image_pull.reset_for_tests()


class _FakeLocalImage:
    def __init__(self, repo_digests):
        self.attrs = {"RepoDigests": list(repo_digests)}


class _FakeDockerImage:
    """Stands in for Kathara's DockerImage: local lookups plus registry digests."""

    def __init__(self, local=None, remote=None, remote_delay=0.0):
        self.local = local or {}
        self.remote = remote or {}
        self.remote_delay = remote_delay
        self.remote_calls = []

    def get_local(self, name):
        if name not in self.local:
            raise ImageNotFound(f"no such image: {name}")
        return self.local[name]

    def get_remote(self, name):
        self.remote_calls.append(name)
        if self.remote_delay:
            time.sleep(self.remote_delay)
        if name not in self.remote:
            raise APIError("registry unreachable")
        return SimpleNamespace(attrs={"Descriptor": {"digest": self.remote[name]}})


class _FakeApi:
    def __init__(self, streams=None, on_pull=None):
        self.streams = streams or {}
        self.on_pull = on_pull
        self.pulled = []

    def pull(self, name, stream=True, decode=True):
        self.pulled.append(name)
        if self.on_pull is not None:
            self.on_pull(name)
        return iter(self.streams.get(name, []))


class _FakeFacade(FakeFacadeBase):
    def __init__(self, docker_image, api=None):
        self.manager = SimpleNamespace(
            docker_image=docker_image, client=SimpleNamespace(api=api or _FakeApi())
        )


def _service(tmp_path, docker_image, api=None):
    service = make_service(store=LabStore(tmp_path / "labs"), facade=_FakeFacade(docker_image, api))
    return service


def _add_lab(service, machines):
    spec = LabCreate.model_validate({"name": "testlab", "machines": machines})
    lab = lab_builder.build_lab(spec)
    register_lab(service, lab)
    return lab


# ---------------------------------------------------------------------------
# Pre-check: presence
# ---------------------------------------------------------------------------


def test_missing_and_present_images_are_reported_separately(tmp_path):
    docker_image = _FakeDockerImage(
        local={"kathara/base": _FakeLocalImage([])},
    )
    service = _service(tmp_path, docker_image)
    _add_lab(
        service,
        [
            {"name": "pc1", "image": "kathara/base", "interfaces": [{"link": "A", "number": 0}]},
            {"name": "pc2", "image": "kathara/frr", "interfaces": [{"link": "A", "number": 0}]},
        ],
    )

    status = service.check_lab_images(lab_id(service, "testlab"))

    assert status.missing == ["kathara/frr"]
    assert {img.name: img.state for img in status.images} == {
        "kathara/base": "ok",
        "kathara/frr": "missing",
    }


def test_device_without_an_image_resolves_the_global_default(tmp_path):
    # Machine.get_image() falls back to Setting.image, so that is the name the check must report.
    default = Setting.get_instance().image
    docker_image = _FakeDockerImage()
    service = _service(tmp_path, docker_image)
    _add_lab(service, [{"name": "pc1", "interfaces": [{"link": "A", "number": 0}]}])

    status = service.check_lab_images(lab_id(service, "testlab"))

    assert status.missing == [default]


@pytest.mark.parametrize(
    "make_error",
    [lambda: ImageNotFound("manifest unknown"), lambda: _registry_error(401), lambda: _registry_error(403)],
    ids=["not-found", "401", "403"],
)
def test_a_missing_image_the_registry_does_not_have_is_not_found_not_missing(tmp_path, make_error):
    """Offering to download it would only fail afterwards: the fix is the image name."""
    docker_image = _FakeDockerImage()

    def refuse(name):
        raise make_error()

    docker_image.get_remote = refuse
    service = _service(tmp_path, docker_image)
    _add_lab(service, [{"name": "pc1", "image": "kathara/typo", "interfaces": [{"link": "A", "number": 0}]}])

    status = service.check_lab_images(lab_id(service, "testlab"))

    assert status.not_found == ["kathara/typo"]
    assert status.missing == []
    assert {img.name: img.state for img in status.images} == {"kathara/typo": "not-found"}


def test_a_missing_image_whose_registry_cannot_be_reached_stays_missing(tmp_path):
    """Offline, the download itself is the only way to find out."""
    docker_image = _FakeDockerImage()  # get_remote raises a bare APIError: no HTTP status
    service = _service(tmp_path, docker_image)
    _add_lab(service, [{"name": "pc1", "image": "kathara/frr", "interfaces": [{"link": "A", "number": 0}]}])

    status = service.check_lab_images(lab_id(service, "testlab"))

    assert (status.missing, status.not_found) == (["kathara/frr"], [])
    assert docker_image.remote_calls == ["kathara/frr"]


def test_missing_images_are_checked_on_the_registry_even_when_updates_are_never_checked(tmp_path):
    Setting.get_instance().image_update_policy = "Never"
    docker_image = _FakeDockerImage(
        local={"kathara/base": _FakeLocalImage(["kathara/base@sha256:old"])},
        remote={"kathara/base": "sha256:new"},
    )
    service = _service(tmp_path, docker_image)
    _add_lab(
        service,
        [
            {"name": "pc1", "image": "kathara/base", "interfaces": [{"link": "A", "number": 0}]},
            {"name": "pc2", "image": "kathara/frr", "interfaces": [{"link": "A", "number": 0}]},
        ],
    )

    status = service.check_lab_images(lab_id(service, "testlab"))

    assert docker_image.remote_calls == ["kathara/frr"]  # the present image is not asked about
    assert (status.missing, status.outdated) == (["kathara/frr"], [])


# ---------------------------------------------------------------------------
# Pre-check: update classification
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,repo_digests,remote,expected,expect_remote_call",
    [
        # Digests differ -> a newer version exists upstream.
        ("kathara/base", ["kathara/base@sha256:old"], {"kathara/base": "sha256:new"}, "outdated", True),
        # Same digest -> nothing to do.
        ("kathara/base", ["kathara/base@sha256:same"], {"kathara/base": "sha256:same"}, "ok", True),
        # Built locally: no RepoDigests, so there is nothing to compare and no reason to ask the
        # registry at all.
        ("mine/custom", [], {}, "ok", False),
        # Pinned by digest: it cannot drift, so the check short-circuits.
        ("kathara/base@sha256:pinned", ["kathara/base@sha256:pinned"], {}, "ok", False),
        # Registry unreachable -> `unknown`, never a failure and never a prompt.
        ("kathara/base", ["kathara/base@sha256:old"], {}, "unknown", True),
    ],
)
def test_update_classification_table(tmp_path, name, repo_digests, remote, expected, expect_remote_call):
    docker_image = _FakeDockerImage(local={name: _FakeLocalImage(repo_digests)}, remote=remote)
    service = _service(tmp_path, docker_image)
    _add_lab(service, [{"name": "pc1", "image": name, "interfaces": [{"link": "A", "number": 0}]}])

    status = service.check_lab_images(lab_id(service, "testlab"))

    assert {img.name: img.state for img in status.images} == {name: expected}
    assert bool(docker_image.remote_calls) is expect_remote_call
    assert status.outdated == ([name] if expected == "outdated" else [])


def test_a_daemon_error_is_unknown_not_missing(tmp_path):
    """Only a genuinely absent image is `missing`.

    A daemon 500, an auth failure or an unusable reference is not evidence of absence, and
    reporting it as `missing` would put a *mandatory* download in front of a lab whose images are
    all present.
    """

    class _AngryDockerImage(_FakeDockerImage):
        def get_local(self, name):
            raise APIError("500 Server Error: Internal Server Error")

    service = _service(tmp_path, _AngryDockerImage())
    _add_lab(service, [{"name": "pc1", "image": "kathara/base", "interfaces": [{"link": "A", "number": 0}]}])

    status = service.check_lab_images(lab_id(service, "testlab"))

    assert status.missing == []
    assert {img.state for img in status.images} == {"unknown"}


def test_update_probes_run_on_daemon_threads(tmp_path, monkeypatch):
    """A probe abandoned past the budget must not keep the process alive.

    `concurrent.futures` joins its (non-daemon) workers from an interpreter-exit hook, and
    `shutdown(wait=False)` cannot cancel a running future — so a non-daemon worker stuck on an
    unanswered `get_registry_data` means the backend can never exit.
    """
    monkeypatch.setattr(image_pull, "UPDATE_CHECK_BUDGET_SECONDS", 0.2)
    docker_image = _FakeDockerImage(
        local={"kathara/base": _FakeLocalImage(["kathara/base@sha256:old"])},
        remote={"kathara/base": "sha256:new"},
        remote_delay=30.0,
    )
    service = _service(tmp_path, docker_image)
    _add_lab(service, [{"name": "pc1", "image": "kathara/base", "interfaces": [{"link": "A", "number": 0}]}])

    service.check_lab_images(lab_id(service, "testlab"))

    lingering = [t for t in threading.enumerate() if t.name.startswith("kathara-imgcheck-")]
    assert lingering, "expected the abandoned probe to still be running, so this assertion is real"
    assert all(t.daemon for t in lingering)


def test_never_policy_skips_the_registry_entirely(tmp_path):
    Setting.get_instance().image_update_policy = "Never"
    docker_image = _FakeDockerImage(
        local={"kathara/base": _FakeLocalImage(["kathara/base@sha256:old"])},
        remote={"kathara/base": "sha256:new"},
    )
    service = _service(tmp_path, docker_image)
    _add_lab(service, [{"name": "pc1", "image": "kathara/base", "interfaces": [{"link": "A", "number": 0}]}])

    status = service.check_lab_images(lab_id(service, "testlab"))

    # The whole point of `Never` is that Deploy pays no network cost at all.
    assert docker_image.remote_calls == []
    assert status.outdated == []
    assert status.update_policy == "Never"


@pytest.mark.parametrize("policy", ["Prompt", "Always"])
def test_prompt_and_always_both_check_and_report_the_policy(tmp_path, policy):
    Setting.get_instance().image_update_policy = policy
    docker_image = _FakeDockerImage(
        local={"kathara/base": _FakeLocalImage(["kathara/base@sha256:old"])},
        remote={"kathara/base": "sha256:new"},
    )
    service = _service(tmp_path, docker_image)
    _add_lab(service, [{"name": "pc1", "image": "kathara/base", "interfaces": [{"link": "A", "number": 0}]}])

    status = service.check_lab_images(lab_id(service, "testlab"))

    # The backend reports facts plus the policy; deciding whether to *ask* is the client's job.
    assert status.update_policy == policy
    assert status.outdated == ["kathara/base"]


def test_a_hanging_registry_cannot_hang_the_precheck(tmp_path, monkeypatch):
    # Kathara builds its Docker client with timeout=None, so without the budget this call would
    # block in front of the Deploy button for as long as the daemon stays silent.
    monkeypatch.setattr(image_pull, "UPDATE_CHECK_BUDGET_SECONDS", 0.3)
    docker_image = _FakeDockerImage(
        local={"kathara/base": _FakeLocalImage(["kathara/base@sha256:old"])},
        remote={"kathara/base": "sha256:new"},
        remote_delay=5.0,
    )
    service = _service(tmp_path, docker_image)
    _add_lab(service, [{"name": "pc1", "image": "kathara/base", "interfaces": [{"link": "A", "number": 0}]}])

    started = time.monotonic()
    status = service.check_lab_images(lab_id(service, "testlab"))
    elapsed = time.monotonic() - started

    assert elapsed < 2.0
    assert {img.state for img in status.images} == {"unknown"}
    assert status.outdated == []


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------


def test_pull_does_not_skip_an_image_that_is_already_present(tmp_path):
    # An *outdated* image is present locally, so a presence check inside the pull would skip
    # exactly the updates the caller asked for.
    docker_image = _FakeDockerImage(
        local={"kathara/base": _FakeLocalImage(["kathara/base@sha256:old"])},
        remote={"kathara/base": "sha256:new"},
    )
    api = _FakeApi(streams={"kathara/base": [{"status": "Already exists", "id": "a"}]})
    service = _service(tmp_path, docker_image, api)

    pulled = service.pull_images(["kathara/base"])

    assert pulled == ["kathara/base"]
    assert api.pulled == ["kathara/base"]


def test_progress_is_readable_while_the_download_runs(tmp_path):
    """The reason the progress endpoint takes no KatharaService dependency: it has to answer
    *during* the download, which holds the service's own worker."""
    seen = {}

    def lines():
        yield {"status": "Pulling from library/base", "id": "latest"}
        yield {"status": "Pulling fs layer", "id": "a"}
        yield {"status": "Downloading", "id": "a", "progressDetail": {"current": 60, "total": 200}}
        # Read the snapshot from inside the stream, i.e. exactly while the pull is in flight.
        seen["mid"] = image_pull.snapshot()
        yield {"status": "Download complete", "id": "a"}

    docker_image = _FakeDockerImage(remote={"kathara/base": "sha256:new"})
    api = _FakeApi()
    api.pull = lambda name, **_: lines()
    service = _service(tmp_path, docker_image, api)

    service.pull_images(["kathara/base"])

    assert seen["mid"]["active"] is True
    assert seen["mid"]["image"] == "kathara/base"
    assert seen["mid"]["downloaded_bytes"] == 60
    assert seen["mid"]["total_bytes"] == 200
    # And the terminal frame is still readable right after it finishes.
    assert image_pull.snapshot()["finished"] is True


def test_in_stream_error_becomes_an_api_error(tmp_path):
    # api.pull(stream=True) doesn't raise for an in-stream failure: it yields a line with `error`
    # and ends, so we have to notice it ourselves.
    docker_image = _FakeDockerImage(remote={"kathara/base": "sha256:new"})
    api = _FakeApi(streams={"kathara/base": [{"error": "toomanyrequests: rate limit"}]})
    service = _service(tmp_path, docker_image, api)

    with pytest.raises(Exception) as excinfo:
        service.pull_images(["kathara/base"])

    assert "rate limit" in str(excinfo.value)
    assert image_pull.snapshot()["active"] is False


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------


@pytest.fixture
def client_and_service(tmp_path):
    docker_image = _FakeDockerImage(local={"kathara/base": _FakeLocalImage([])})
    api = _FakeApi(streams={"kathara/frr": [{"status": "Already exists", "id": "a"}]})
    docker_image.remote["kathara/frr"] = "sha256:whatever"
    service = _service(tmp_path, docker_image, api)
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        yield client, service
    app.dependency_overrides.clear()


def test_precheck_endpoint_returns_missing_images(client_and_service):
    client, service = client_and_service
    _add_lab(
        service,
        [
            {"name": "pc1", "image": "kathara/base", "interfaces": [{"link": "A", "number": 0}]},
            {"name": "pc2", "image": "kathara/frr", "interfaces": [{"link": "A", "number": 0}]},
        ],
    )

    res = client.get(f"/api/labs/{lab_id(service, 'testlab')}/images")

    assert res.status_code == 200
    assert res.json()["missing"] == ["kathara/frr"]


def test_progress_endpoint_is_idle_and_never_404s(client_and_service):
    client, _ = client_and_service

    res = client.get("/api/images/pull/progress")

    assert res.status_code == 200
    assert res.json()["active"] is False


def test_pull_endpoint_downloads_the_requested_images(client_and_service):
    client, _ = client_and_service

    res = client.post("/api/images/pull", json={"images": ["kathara/frr"]})

    assert res.status_code == 200
    assert res.json()["pulled"] == ["kathara/frr"]


def test_pull_endpoint_rejects_an_empty_request(client_and_service):
    client, _ = client_and_service

    assert client.post("/api/images/pull", json={"images": []}).status_code == 422


def test_second_concurrent_download_is_refused_with_409(client_and_service):
    client, _ = client_and_service
    # Claim the slot the same way a running download does, then ask for another one.
    with image_pull.track(["kathara/base"]):
        res = client.post("/api/images/pull", json={"images": ["kathara/frr"]})

    assert res.status_code == 409
    assert res.json()["error_type"] == "ImagePullBusyError"


def _registry_error(status_code: int) -> APIError:
    """A docker-py error the way `images.get_registry_data` raises it: carrying the daemon's HTTP
    response, whose status is what tells a missing image from an unreachable registry."""
    response = requests.Response()
    response.status_code = status_code
    response.url = "http+docker://localhost/v1.45/distribution/kathara/doesnotexist/json"
    return APIError("registry lookup failed", response=response, explanation="denied")


@pytest.mark.parametrize(
    "error",
    [ImageNotFound("manifest unknown"), _registry_error(401), _registry_error(403), _registry_error(404)],
    ids=["not-found", "401", "403", "404"],
)
def test_pull_endpoint_names_an_image_the_registry_does_not_have_before_pulling(client_and_service, error):
    """The `docker_image.get_remote(name)` probe runs before any layer is pulled, and every
    registry answer meaning "no such image, or not without a login" reads the same way: the fix
    is the image name either way."""
    client, service = client_and_service

    def _raise(name):
        raise error

    service._instance.manager.docker_image.get_remote = _raise

    res = client.post("/api/images/pull", json={"images": ["kathara/doesnotexist"]})

    assert res.status_code == 404
    assert res.json() == {
        "detail": "Image `kathara/doesnotexist` doesn't exist on its registry, or it's private.",
        "error_type": "ImageNotAvailableError",
    }
    assert service._instance.manager.client.api.pulled == []


def test_pull_endpoint_reports_an_unreachable_registry_as_an_upstream_failure(client_and_service):
    client, service = client_and_service

    def _raise(name):
        raise _registry_error(500)

    service._instance.manager.docker_image.get_remote = _raise

    res = client.post("/api/images/pull", json={"images": ["kathara/base"]})

    assert res.status_code == 502
    assert res.json()["error_type"] == "APIError"
