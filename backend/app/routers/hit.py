"""Browse imported runs, immutable revisions and probability previews."""

from typing import Literal

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from app.hit.http import PngResponse, PNG_OR_JSON

from app.annotations import AnnotationError, MAX_MASK_B64_BYTES, decode_mask
from app.auth import require_user
from app.hit import catalog, imaging, storage, versioning

router = APIRouter(prefix="/api/hit", tags=["hit"])


class Revision(BaseModel):
    mask: str | None = Field(..., max_length=MAX_MASK_B64_BYTES)
    request_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    parent: str | None = None
    expected_head: str | None = None
    threshold: float | None = Field(default=None, ge=0, le=1)


def png(data):
    return PngResponse(data)


@router.get("/runs")
def list_runs():
    return {
        "runs": [
            {"case_id": item["case_id"], "job_id": item["job_id"]} for item in catalog.records()
        ]
    }


@router.get("/runs/{job}")
def detail(job: str):
    item = catalog.record(job)
    storage.prepare(job)
    with storage.transaction() as db:
        rows = storage.history(db, job)
    outputs = {key: f"/data/hit/{job}/{value}" for key, value in item["outputs"].items()}
    return {
        **item,
        "outputs": outputs,
        "history": rows,
        "versions": [v for v in rows if v["current"]],
    }


@router.put("/runs/{job}/mine")
def save_revision(job: str, payload: Revision, user: dict = Depends(require_user)):
    catalog.record(job)
    size = (catalog.SIZE, catalog.SIZE)
    try:
        array = (
            np.zeros(size, np.uint8) if payload.mask is None else decode_mask(payload.mask, size)
        )
    except AnnotationError as exc:
        raise HTTPException(400, str(exc)) from exc
    encoded = imaging.encode_png(array)
    identity = versioning.save(
        job,
        user["username"],
        encoded,
        parent=payload.parent,
        threshold=payload.threshold,
        expected=payload.expected_head,
        guarded="expected_head" in payload.model_fields_set,
        request_id=payload.request_id,
    )
    return {"ok": True, "id": identity}


@router.delete("/runs/{job}/mine")
def delete_revision(job: str, expected_head: str | None = None, user: dict = Depends(require_user)):
    catalog.record(job)
    versioning.reset(job, user["username"], expected_head)
    return {"ok": True}


@router.get("/runs/{job}/versions/{identity}/mask", response_class=PngResponse)
def get_mask(job: str, identity: str):
    item = catalog.record(job)
    with storage.transaction() as db:
        return png(storage.mask_bytes(db, item, identity))


@router.get("/runs/{job}/probability/{mode}", response_class=PngResponse)
def preview(job: str, mode: Literal["heatmap", "mask"], threshold: float = Query(0.8, ge=0, le=1)):
    values = imaging.probability(catalog.record(job))
    if mode == "heatmap":
        return png(imaging.heatmap(values))
    return png(imaging.threshold_mask(values, threshold))


@router.get("/runs/{job}/compare", responses=PNG_OR_JSON)
def compare(job: str, target: str, reference: str = catalog.ORIGINAL, image: bool = False):
    item = catalog.record(job)
    with storage.transaction() as db:
        before = imaging.binary(storage.mask_bytes(db, item, reference))
        after = imaging.binary(storage.mask_bytes(db, item, target))
    if image:
        return png(imaging.difference(before, after))
    return {"job": job, "reference": reference, "target": target, **imaging.counts(before, after)}
