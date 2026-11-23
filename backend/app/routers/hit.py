"""Browse completed HIT predictions and save per-run, per-user mask revisions."""
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import APIRouter, Depends, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

from app.annotations import AnnotationError, decode_mask, MAX_MASK_B64_BYTES
from app.auth import require_user
from app.config import DATA_DIR

router = APIRouter(prefix="/api/hit", tags=["hit"])
RUNS = DATA_DIR / "hit"
REVISIONS = DATA_DIR / "hit-revisions"
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}")


class Revision(BaseModel):
    mask: str | None = Field(..., max_length=MAX_MASK_B64_BYTES)


def record(job):
    if not IDENTIFIER.fullmatch(job):
        raise HTTPException(404, "推理批次不存在")
    path = RUNS / job / "record.json"
    if not path.is_file():
        raise HTTPException(404, "推理批次不存在")
    return json.loads(path.read_text())


@router.get("/runs")
def list_runs():
    runs = []
    for path in sorted(RUNS.glob("*/record.json")):
        job = path.parent.name
        if IDENTIFIER.fullmatch(job):
            item = record(job)
            runs.append({"case_id": item["case_id"], "job_id": job})
    return {"runs": runs}


@router.get("/runs/{job}")
def detail(job: str):
    item = record(job)
    versions = []
    for path in sorted((REVISIONS / job).glob("*.png")):
        try:
            modified = path.stat().st_mtime_ns
        except FileNotFoundError:
            continue
        versions.append({
            "username": path.stem,
            "updated_at": datetime.fromtimestamp(modified / 1e9, timezone.utc).isoformat(timespec="seconds"),
            "mask_url": f"/data/hit-revisions/{job}/{path.name}?v={modified}",
        })
    return {**item, "outputs": {k: f"/data/hit/{job}/{v}" for k, v in item["outputs"].items()},
            "versions": versions}


@router.put("/runs/{job}/mine")
def save_revision(job: str, payload: Revision, user: dict = Depends(require_user)):
    record(job)
    size = (448, 448)
    try:
        image = Image.new("L", size) if payload.mask is None else Image.fromarray(decode_mask(payload.mask, size))
    except AnnotationError as exc:
        raise HTTPException(400, str(exc)) from exc
    folder = REVISIONS / job
    folder.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=folder, delete=False) as temp:
        path = Path(temp.name)
    try:
        image.save(path, format="PNG")
        path.replace(folder / f"{user['username']}.png")
    finally:
        path.unlink(missing_ok=True)
    return {"ok": True}


@router.delete("/runs/{job}/mine")
def delete_revision(job: str, user: dict = Depends(require_user)):
    record(job)
    (REVISIONS / job / f"{user['username']}.png").unlink(missing_ok=True)
    return {"ok": True}
