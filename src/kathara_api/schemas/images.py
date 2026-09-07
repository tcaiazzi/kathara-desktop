"""Schemas for the Docker image pre-check and the explicit pre-deploy download."""

from typing import Literal, Optional

from pydantic import BaseModel, Field

# A lab has a handful of distinct images; this is a sanity ceiling on a client-supplied list, not
# a meaningful product limit.
MAX_IMAGES_PER_PULL = 32

ImageState = Literal["ok", "missing", "outdated", "unknown"]


class LabImageStatus(BaseModel):
    """One device image and whether anything needs to happen to it before a deploy.

    Only ``missing`` (mandatory) and ``outdated`` (optional) are actionable. ``unknown`` means the
    registry couldn't be consulted — offline, or slower than the check's time budget — and is
    reported separately from ``ok`` purely so the response doesn't assert what it doesn't know.
    """

    name: str
    state: ImageState


class LabImagesStatus(BaseModel):
    """What a lab's images need before it can be deployed.

    ``update_policy`` is Kathara's own ``image_update_policy`` (``Prompt``/``Always``/``Never``),
    passed through so the client can decide whether to *ask* about the updates or just take them —
    the same three-way behaviour as the CLI's ``UpdateDockerImage`` handler. With ``Never`` the
    backend skips the registry round-trips entirely and ``outdated`` is always empty.
    """

    update_policy: str = "Prompt"
    images: list[LabImageStatus] = Field(default_factory=list)
    missing: list[str] = Field(default_factory=list)
    outdated: list[str] = Field(default_factory=list)


class ImagePullRequest(BaseModel):
    """The exact set of images to pull. No presence filtering happens server-side — see
    ``services/image_pull.pull_images`` for why an *outdated* image must not be skipped."""

    images: list[str] = Field(min_length=1, max_length=MAX_IMAGES_PER_PULL)


class ImagePullResult(BaseModel):
    """Terminal result of a download, for the caller that awaits the request itself."""

    pulled: list[str] = Field(default_factory=list)


class ImagePullProgress(BaseModel):
    """Snapshot of the single in-flight download, or an idle one (``active`` False).

    ``total_bytes`` of 0 means *indeterminate*, not empty: Docker announces layers as the stream
    starts, so the total is unknown for the first moments and grows as layers appear. Clients must
    treat a rising total as normal and clamp their own displayed percentage rather than letting a
    progress bar run backwards.
    """

    active: bool = False
    finished: bool = False
    image: Optional[str] = None
    images_total: int = 0
    images_done: int = 0
    downloaded_bytes: int = 0
    total_bytes: int = 0
    layers_total: int = 0
    layers_done: int = 0
    extracting: bool = False
    elapsed_seconds: float = 0.0
    # Authored server-side so the wording lives in one place.
    detail: str = ""
    error: Optional[str] = None
