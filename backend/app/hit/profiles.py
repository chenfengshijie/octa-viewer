"""Export a B-scan profile in the same native coordinates as the review image."""

import csv
from io import StringIO

from . import catalog, measurements


FIELDS = (
    "case_id",
    "job_id",
    "y",
    "x",
    "ilm_z",
    "opl_proxy_z",
    "bm_z",
    "shallow_depth_px",
    "deep_depth_px",
    "full_depth_px",
)


def row_profile(item, y):
    sheets = measurements.surfaces(item)
    return {key: sheet[y].tolist() for key, sheet in sheets.items()}


def csv_profile(item, y, profile):
    buffer = StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=FIELDS)
    writer.writeheader()
    for x in range(catalog.SIZE):
        ilm = profile["ilm"][x]
        opl = profile["opl"][x]
        bm = profile["bm"][x]
        writer.writerow(
            {
                "case_id": item["case_id"],
                "job_id": item["job_id"],
                "y": y,
                "x": x,
                "ilm_z": ilm,
                "opl_proxy_z": opl,
                "bm_z": bm,
                "shallow_depth_px": opl - ilm,
                "deep_depth_px": bm - opl,
                "full_depth_px": bm - ilm,
            }
        )
    return buffer.getvalue()
