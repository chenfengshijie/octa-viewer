"""Reproducible comparisons and version-pinned archives."""

from hashlib import sha256
import json
from tempfile import SpooledTemporaryFile
from zipfile import ZipFile, ZIP_DEFLATED

from fastapi import HTTPException

from . import catalog, cohort, storage


def candidates(db):
    return [
        dict(row)
        for row in db.execute(
            """SELECT v.id AS version, v.job, v.username AS author, v.digest, v.created,
                      r.id AS round_id, r.reviewer, r.decided
               FROM versions v JOIN rounds r ON r.version=v.id
               WHERE r.state='approved' ORDER BY r.decided DESC,r.rowid DESC"""
        )
    ]


def put_file(archive, path, binary):
    archive.writestr(path, binary)
    return {"path": path, "bytes": len(binary), "sha256": sha256(binary).hexdigest()}


def export_run(archive, db, item, row, seed):
    job = item["job_id"]
    case = item["case_id"]
    prefix = f"{case}/{job}/"
    files = {}
    for key in ("full_projection", "shallow_projection", "deep_projection", "model_input", "mask"):
        data = catalog.artifact(item, key).read_bytes()
        entry = put_file(archive, prefix + item["outputs"][key], data)
        expected = item["sha256"][key]
        if entry["sha256"] != expected:
            raise HTTPException(409, f"批次 {job} 的 {key} 与归档摘要不符")
        files[key] = entry
    version = storage.version(db, job, row["version"])
    png = storage.mask_bytes(db, item, row["version"])
    revised = put_file(archive, prefix + "revision/" + version["id"] + ".png", png)
    if revised["sha256"] != version["digest"]:
        raise HTTPException(409, "版本摘要校验失败")
    files["revision"] = revised
    return {
        "case_id": case,
        "job_id": job,
        "split": cohort.split_case(case, seed),
        "revision": version,
        "review": {key: row[key] for key in ("round_id", "reviewer", "decided")},
        "model": item["model"],
        "parameters": item["parameters"],
        "files": files,
    }


def build_archive(db, selected, seed, filters):
    approved = {row["version"]: row for row in candidates(db)}
    chosen = cohort.select(selected, seed, filters, approved)
    file = SpooledTemporaryFile(max_size=8 * 1024 * 1024, mode="w+b")
    try:
        entries = []
        with ZipFile(file, "w", compression=ZIP_DEFLATED) as archive:
            for item, row in chosen:
                entries.append(export_run(archive, db, item, row, seed))
            manifest = {
                "schema": "hit-research-v1",
                "created": storage.now(),
                "filters": filters,
                "split": {
                    "unit": "case_id",
                    "method": "sha256-json-seed-case-mod100",
                    "seed": seed,
                    "train": [0, 79],
                    "validation": [80, 89],
                    "test": [90, 99],
                },
                "runs": entries,
            }
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        file.seek(0)
        return file
    except BaseException:
        file.close()
        raise
