"""Schemas for the upstream lab gallery (see services/lab_gallery.py).

The remote twin of schemas/examples.py: same "catalog of installable scenarios, each flagged
against what's already on disk" shape, with the extra fields a *remote* catalog needs — where the
lab lives upstream and how big it is.
"""

from typing import Optional

from pydantic import BaseModel


class GalleryLabSummary(BaseModel):
    """One installable lab in the upstream catalog."""

    # Repo-relative path of the lab directory, e.g.
    # "main-labs/basic-topics/arp/kathara-lab_arp". Doubles as the install id: it is unique, stable
    # across catalog refreshes, and needs no server-side mapping table.
    id: str
    # Lab name this would be installed as — the directory basename, disambiguated when two labs
    # upstream share one (the frr/ and quagga/ variants of the BGP labs do).
    name: str
    # First path segment below the configured section, e.g. "basic-topics" — the frontend groups by
    # this.
    category: str
    n_files: int
    size_bytes: int
    # github.com link to the lab's *parent* directory upstream — not the lab directory itself, since
    # the parent is what also holds the lab's slides PDF (if any) and README (if any), all browsable
    # in one GitHub folder view.
    repo_url: str
    # Whether a lab named `name` already exists locally — the frontend renders "Open" instead of
    # "Import" when true, exactly as it does for bundled examples.
    installed: bool


class GalleryCatalog(BaseModel):
    """The whole catalog plus provenance, so the frontend can show what it is looking at."""

    repo: str
    ref: str
    section: str
    # Unix timestamp of the fetch this catalog came from; with a cache TTL in play, a listing can
    # legitimately be minutes old and the UI should be able to say so.
    fetched_at: float
    labs: list[GalleryLabSummary]


class GalleryInstall(BaseModel):
    """Request to install an upstream gallery lab as a real, on-disk lab."""

    id: str
    # Target lab name; defaults to the catalog entry's `name` when omitted.
    name: Optional[str] = None
