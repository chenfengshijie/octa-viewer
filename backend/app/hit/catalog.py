"""Imported runs and their declared artifacts. A job identifies one immutable prediction."""

import json
import re
from pathlib import Path

from fastapi import HTTPException

from app.config import DATA_DIR

RUNS = DATA_DIR / "hit"
LEGACY = DATA_DIR / "hit-revisions"
PRIVATE = DATA_DIR / "private"
SIZE = 448
DEPTH = 1024
ORIGINAL = "original"
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}")


def record(job: str) -> dict:
    if not IDENTIFIER.fullmatch(job):
        raise HTTPException(404, "推理批次不存在")
    path = RUNS / job / "record.json"
    if not path.is_file():
        raise HTTPException(404, "推理批次不存在")
    item = json.loads(path.read_text(encoding="utf-8"))
    if item.get("job_id") != job:
        raise HTTPException(422, "结果清单中的批次标识与目录不符")
    return item


def records():
    for path in sorted(RUNS.glob("*/record.json")):
        if IDENTIFIER.fullmatch(path.parent.name):
            yield record(path.parent.name)


def artifact(item: dict, key: str) -> Path:
    root = (RUNS / item["job_id"]).resolve()
    relative = item["outputs"].get(key)
    if not isinstance(relative, str):
        raise HTTPException(404, "清单中缺少所选产物")
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(404, "产物文件不存在")
    return path
