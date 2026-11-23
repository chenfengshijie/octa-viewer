"""Inspect the Z profile of a selected en-face row and its optional structural slice."""

from fastapi.responses import PlainTextResponse
import numpy as np
from fastapi import APIRouter, HTTPException, Path

from app.hit.http import PngResponse
from app.hit import catalog, imaging, profiles

router = APIRouter(prefix="/api/hit/runs", tags=["hit-qc"])


def structural_volume(job):
    return catalog.PRIVATE / "oct" / job / "oct.npy"


@router.get("/{job}/rows/{y}")
def curves(job: str, y: int = Path(ge=0, lt=catalog.SIZE)):
    item = catalog.record(job)
    profile = read_row(item, y)
    image_url = None
    if structural_volume(job).is_file():
        image_url = f"/api/hit/runs/{job}/rows/{y}/slice"
    return {
        "y": y,
        "width": catalog.SIZE,
        "depth": catalog.DEPTH,
        "profiles": profile,
        "slice_url": image_url,
    }


@router.get("/{job}/rows/{y}/slice", response_class=PngResponse)
def structural_slice(job: str, y: int = Path(ge=0, lt=catalog.SIZE)):
    catalog.record(job)
    path = structural_volume(job)
    if not path.is_file():
        raise HTTPException(404, "该批次没有配对的结构体")
    volume = np.load(path, mmap_mode="r", allow_pickle=False)
    if volume.shape != (catalog.SIZE, catalog.DEPTH, catalog.SIZE) or volume.dtype != np.uint8:
        raise HTTPException(422, "结构体应为 uint8，轴序为 Y、Z、X")
    return PngResponse(imaging.encode_png(volume[y]))


def read_row(item, y):
    try:
        return profiles.row_profile(item, y)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


class ProfileCsv(PlainTextResponse):
    media_type = "text/csv"


@router.get("/{job}/rows/{y}/profile.csv", response_class=ProfileCsv)
def export_profile(job: str, y: int = Path(ge=0, lt=catalog.SIZE)):
    item = catalog.record(job)
    content = profiles.csv_profile(item, y, read_row(item, y))
    return ProfileCsv(
        content, headers={"Content-Disposition": f'attachment; filename="{job}-row-{y}.csv"'}
    )
