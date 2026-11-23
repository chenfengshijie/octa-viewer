"""Recompute a downloaded agreement table against the pinned source masks.

The source may have received newer edits since the table was exported. Each row is
resolved by its immutable version id and the original id in that same run.
"""

from contextlib import closing
from pathlib import Path
from hashlib import sha256
import math
import sqlite3

import numpy as np

from .common import (
    Report,
    digest,
    file_digest,
    identifier,
    integer,
    json_object,
    locate,
    mapping,
    read_png,
    require,
    snapshot_id,
    timestamp,
)
from .. import imaging


def pinned_mask(db, job, identity):
    snapshot_id(identity, "版本")
    row = db.execute(
        "SELECT job,username,created,png,digest FROM versions WHERE id=?", (identity,)
    ).fetchone()
    require(row is not None and row["job"] == job, "修订标识未关联当前批次")

    require(
        sha256(row["png"]).hexdigest() == digest(row["digest"], "修订摘要"),
        "修订内容摘要不符",
    )
    return read_png(row["png"], "L", binary=True) > 0, row


def metric_fields(row, actual):
    for key in ("reference_pixels", "target_pixels", "added", "erased", "shared"):
        require(integer(row.get(key), key, 0) == actual[key], f"{key} 与掩膜复算结果不符")
    for key in ("dice", "iou"):
        value = row.get(key)
        require(type(value) in (int, float) and math.isfinite(value), f"{key} 应是有限数")
        require(
            math.isclose(value, actual[key], rel_tol=1e-12, abs_tol=1e-12),
            f"{key} 与掩膜复算结果不符",
        )


def verify_pair(db, data, row, selection, query):
    job = identifier(row.get("job"), "job")
    case = identifier(row.get("case_id"), "case_id")
    root = data / "hit" / job
    item = json_object(locate(root, "record.json").read_bytes())
    require(
        item.get("job_id") == job and item.get("case_id") == case, "表中病例或批次与归档清单不符"
    )
    after, target = pinned_mask(db, job, row["target"])
    require(row["author"] == target["username"], "目标作者与修订记录不符")
    require(
        timestamp(row["created"], "目标版本时间") == timestamp(target["created"], "保存时间"),
        "目标创建时间不符",
    )
    if selection["author"]:
        require(row["author"] == selection["author"], "目标作者与筛选条件不符")
    require(any(query in value for value in (job, case, row["author"])), "比较对与筛选条件不符")
    if row["reference"] == "original":
        require(not selection["reference_author"], "作者比较表引用了原始预测")
        require(row.get("reference_author") is None, "原始预测不应记录修订作者")
        path = locate(root, item["outputs"]["mask"])
        require(file_digest(path) == item["sha256"]["mask"], "原始掩膜摘要不符")
        before = read_png(path, "L", binary=True) > 0
    else:
        require(row["reference"] != row["target"], "比较对的两个版本相同")
        before, reference = pinned_mask(db, job, row["reference"])
        require(
            row["reference_author"] == reference["username"] == selection["reference_author"],
            "参照作者不符",
        )
        require(row["reference_created"] == reference["created"], "参照版本创建时间不符")
    result = imaging.counts(before, after)
    metric_fields(row, result)
    return result


def inspect_comparisons(path, data_dir):
    path = Path(path)
    data = Path(data_dir).resolve()
    report = Report("批次比较表", str(path))
    with report.inspect("版本对清单"):
        table = json_object(path.read_bytes())
        selection = mapping(table.get("selection"), "selection")
        require(
            all(isinstance(selection.get(key), str) for key in ("author", "reference_author")),
            "作者筛选字段无效",
        )
        query = table.get("filter")
        require(isinstance(query, str), "文本筛选字段无效")
        rows = table.get("rows")
        require(isinstance(rows, list), "rows 应为版本对列表")
        database = data / "private" / "hit.sqlite3"
        require(database.is_file(), "数据库文件不存在")
        seen = set()
        metrics = []
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN")
            for i, row in enumerate(rows):
                with report.inspect(f"版本对 {i + 1}"):
                    item = mapping(row, "比较项")
                    job = item.get("job")
                    require(job not in seen, "同一批次被统计多次")
                    seen.add(job)
                    metrics.append(verify_pair(db, data, item, selection, query))
        report.facts["成功复算批次"] = len(metrics)
        if metrics:
            for key in ("dice", "iou"):
                report.facts[key] = float(np.mean([row[key] for row in metrics]))
    return report
