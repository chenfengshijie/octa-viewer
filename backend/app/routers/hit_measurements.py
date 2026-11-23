"""Spatial comparisons, probability distribution and surface thickness."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response

from app.hit.http import PNG_OR_JSON
from app.hit import catalog, imaging, measurements, storage, thresholds

router = APIRouter(prefix="/api/hit/runs", tags=["hit-measurements"])


@router.get("/{job}/regions")
def regions(
    job: str,
    target: str,
    reference: str = catalog.ORIGINAL,
    min_area: int = Query(1, ge=1, le=catalog.SIZE**2),
    offset: int = Query(0, ge=0),
    limit: int = Query(25, ge=1, le=200),
):
    item = catalog.record(job)
    with storage.transaction() as db:
        before = imaging.binary(storage.mask_bytes(db, item, reference))
        after = imaging.binary(storage.mask_bytes(db, item, target))
    changed = measurements.changed_regions(before, after, min_area)
    return {
        "reference": reference,
        "target": target,
        "total": len(changed),
        "offset": offset,
        "regions": changed[offset : offset + limit],
    }


@router.get("/{job}/distribution")
def distribution(job: str, threshold: float = Query(0.8, ge=0, le=1)):
    item = catalog.record(job)
    return measurements.probability_summary(
        imaging.probability(item),
        imaging.binary(catalog.artifact(item, "mask").read_bytes()),
        threshold,
    )


@router.get("/{job}/thickness/{slab}", responses=PNG_OR_JSON)
def layer_distance(job: str, slab: Literal["shallow", "deep", "full"], image: bool = False):
    item = catalog.record(job)
    try:
        sheets = measurements.surfaces(item)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    values = measurements.thickness(sheets, slab)
    if image:
        return Response(measurements.thickness_map(values), media_type="image/png")
    return {"slab": slab, **measurements.slab_summary(values)}


@router.get("/{job}/thresholds")
def sweep(
    job: str,
    low: float = Query(0, ge=0, le=1),
    high: float = Query(1, ge=0, le=1),
    intervals: int = Query(20, ge=1, le=100),
):
    if low >= high:
        raise HTTPException(422, "阈值下限应小于上限")
    item = catalog.record(job)
    baseline = imaging.binary(catalog.artifact(item, "mask").read_bytes())
    return thresholds.sweep(
        imaging.probability(item), baseline, low, high, intervals, item["parameters"]["threshold"]
    )
