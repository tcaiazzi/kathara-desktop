"""Proof of pairing: the one ``/api`` route a caller reaches without the pairing token.

The desktop shell picks a free port, closes it and only then starts this process, so for a moment
another local user can bind that port first. Were the shell's first request to carry the token,
whoever answered would receive it — and the shell would then load that answerer's page, preload
bridge included. So the shell asks for this proof instead, sending nothing secret, and trusts the
port only once the answer shows the process there holds the token it was started with (see
services/desktop/src/backend.ts's waitForPairing).
"""

import hashlib
import hmac

from fastapi import APIRouter, Query

from ..config import get_settings
from ..schemas.common import PairingProof

router = APIRouter(tags=["system"])


@router.get("/pairing/proof", response_model=PairingProof)
def pairing_proof(nonce: str = Query(pattern=r"^[0-9a-f]{32,128}$")) -> PairingProof:
    """``HMAC-SHA256(auth token, nonce)``. Reveals nothing about the token: the nonce is the
    caller's own, and a keyed hash of it can't be turned back into the key."""
    token = get_settings().auth_token
    if not token:
        return PairingProof(proof=None)
    return PairingProof(proof=hmac.new(token.encode(), nonce.encode(), hashlib.sha256).hexdigest())
