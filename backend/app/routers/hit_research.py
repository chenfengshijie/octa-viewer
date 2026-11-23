"""Batch agreement and research archives."""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from app.auth import require_user
from app.hit import agreement, catalog, cohort, research, storage

router = APIRouter(prefix="/api/hit/research", tags=["hit-research"])


class Filters(BaseModel):
    case: str = Field(default="", max_length=96)
    job: str = Field(default="", max_length=96)
    author: str = Field(default="", max_length=32)


class ExportRequest(BaseModel):
    versions: list[str]
    seed: str = Field(default="octa-hit-v1", min_length=1, max_length=128)
    filters: Filters = Field(default_factory=Filters)


@router.get("/summary")
def agreement_summary(author: str | None = None, reference_author: str | None = None):
    if reference_author and (not author or author == reference_author):
        raise HTTPException(422, "跨作者比较需要两位不同作者")
    items = list(catalog.records())
    for item in items:
        storage.prepare(item["job_id"])
    with storage.transaction() as db:
        return agreement.compare_cohort(db, items, author, reference_author)


@router.get("/candidates", dependencies=[Depends(require_user)])
def export_candidates():
    cases = {item["job_id"]: item["case_id"] for item in catalog.records()}
    with storage.transaction() as db:
        rows = research.candidates(db)
    return {
        "candidates": [{**row, "case_id": cases[row["job"]]} for row in rows if row["job"] in cases]
    }


@router.post(
    "/export",
    dependencies=[Depends(require_user)],
    response_class=StreamingResponse,
    responses={
        200: {"content": {"application/zip": {"schema": {"type": "string", "format": "binary"}}}}
    },
)
def export(payload: ExportRequest):
    if not payload.versions or not payload.seed.strip():
        raise HTTPException(422, "请选择批次并填写划分种子")
    with storage.transaction() as db:
        file = research.build_archive(
            db, payload.versions, payload.seed.strip(), payload.filters.model_dump()
        )
    return StreamingResponse(
        iter(lambda: file.read(256 * 1024), b""),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="hit-research.zip"'},
        background=BackgroundTask(file.close),
    )


@router.post("/preview", dependencies=[Depends(require_user)])
def preview(payload: ExportRequest):
    seed = payload.seed.strip()
    with storage.transaction() as db:
        approved = {row["version"]: row for row in research.candidates(db)}
        chosen = cohort.select(payload.versions, seed, payload.filters.model_dump(), approved)
    return cohort.preview(chosen, seed)
