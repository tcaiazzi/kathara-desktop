"""Collision domain (link) endpoints scoped to a network scenario."""

from fastapi import APIRouter, Depends, status

from ..dependencies import get_service
from ..schemas.common import Message
from ..schemas.link import LinkCreate, LinkDetail
from ..services import serializers
from ..services.kathara_service import KatharaService

router = APIRouter(prefix="/labs/{lab_name}/links", tags=["links"])


@router.get("", response_model=list[LinkDetail])
def list_links(lab_name: str, service: KatharaService = Depends(get_service)) -> list[LinkDetail]:
    """List the collision domains of a network scenario."""
    lab = service.get_lab_or_reconstruct(lab_name)
    return [serializers.link_to_detail(link) for link in lab.links.values()]


@router.post("", response_model=LinkDetail, status_code=status.HTTP_201_CREATED)
def add_link(
    lab_name: str, payload: LinkCreate, service: KatharaService = Depends(get_service)
) -> LinkDetail:
    """Create and deploy a collision domain in a running network scenario."""
    link = service.add_link(lab_name, payload.name, external=payload.external)
    return serializers.link_to_detail(link)


@router.delete("/{link_name}", response_model=Message)
def remove_link(
    lab_name: str, link_name: str, service: KatharaService = Depends(get_service)
) -> Message:
    """Undeploy a collision domain."""
    service.remove_link(lab_name, link_name)
    return Message(detail=f"Collision domain `{link_name}` removed from lab `{lab_name}`.")
