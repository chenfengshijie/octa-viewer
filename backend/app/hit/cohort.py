"""Selection shared by export preview and archive creation."""

from collections import Counter
from hashlib import sha256
import json

from fastapi import HTTPException

from . import catalog


def split_case(case, seed):
    key = json.dumps([seed, case], ensure_ascii=False, separators=(",", ":")).encode()
    bucket = int.from_bytes(sha256(key).digest()[:10], "big") % 100
    if bucket < 80:
        return "train"
    if bucket < 90:
        return "validation"
    return "test"


def select(versions, seed, filters, approved):
    if not versions or not seed.strip():
        raise HTTPException(422, "请选择一个批次并填写划分种子")
    seen_jobs = set()
    chosen = []
    for identity in versions:
        row = approved.get(identity)
        if not row:
            raise HTTPException(422, "请选择已经通过复核的版本")
        job = row["job"]
        if job in seen_jobs:
            raise HTTPException(422, "每个批次只能选择一个导出版本")
        seen_jobs.add(job)
        item = catalog.record(job)
        criteria = {"case": item["case_id"], "job": job, "author": row["author"]}
        if any(value and value not in criteria[key] for key, value in filters.items()):
            raise HTTPException(422, "选中版本不符合导出筛选条件")
        chosen.append((item, row))
    return chosen


def preview(chosen, seed):
    rows = []
    cases = {}
    for item, row in chosen:
        case = item["case_id"]
        subset = split_case(case, seed)
        cases[case] = subset
        rows.append(
            {
                "job": row["job"],
                "case_id": case,
                "author": row["author"],
                "version": row["version"],
                "digest": row["digest"],
                "reviewer": row["reviewer"],
                "round_id": row["round_id"],
                "split": subset,
            }
        )
    return {
        "seed": seed,
        "cases": len(cases),
        "batches": len(rows),
        "case_counts": dict(Counter(cases.values())),
        "batch_counts": dict(Counter(row["split"] for row in rows)),
        "rows": rows,
    }
