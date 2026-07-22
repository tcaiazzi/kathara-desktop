"""FastAPI dependency providers."""

from .services.kathara_service import KatharaService

# A single process-wide service instance (the underlying Kathara facade is a singleton).
_service = KatharaService()


def get_service() -> KatharaService:
    """Provide the shared KatharaService instance."""
    return _service
