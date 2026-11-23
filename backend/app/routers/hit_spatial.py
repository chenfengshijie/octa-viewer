"""Version-pinned pixel and local-window queries."""

from typing import Literal

from fastapi import APIRouter, Query, Response

from app.hit.http import PNG_OR_JSON
from app.hit import catalog, imaging, spatial, storage

router = APIRouter(prefix="/api/hit/runs", tags=["hit-spatial"])


@router.get("/{job}/window", responses=PNG_OR_JSON)
def window(
    job: str,
    x: int = Query(ge=0, lt=catalog.SIZE),
    y: int = Query(ge=0, lt=catalog.SIZE),
    target: str = catalog.ORIGINAL,
    reference: str = catalog.ORIGINAL,
    size: int = Query(65, ge=1, le=catalog.SIZE),
    view: Literal["values", "projection", "reference", "target", "difference"] = "values",
    projection: Literal[
        "deep_projection", "shallow_projection", "full_projection", "model_input"
    ] = "full_projection",
):
    item = catalog.record(job)
    area = spatial.Window.centered(x, y, size)
    with storage.transaction() as db:
        first = imaging.binary(storage.mask_bytes(db, item, reference))
        second = imaging.binary(storage.mask_bytes(db, item, target))
    if view != "values":
        data = spatial.render_crop(catalog.artifact(item, projection), area, first, second, view)
        return Response(data, media_type="image/png")
    values = imaging.probability(item)
    return {
        "job": job,
        "reference": reference,
        "target": target,
        "pixel": spatial.at_position(item, first, second, values, x, y),
        "window": spatial.regional_metrics(first, second, values, area),
    }
