"""Match revision pairs within a run before computing agreement across a cohort."""

from collections import Counter
from statistics import median

from . import catalog, imaging, storage


def authors(db, allowed_jobs):
    counts = Counter()
    for row in db.execute("SELECT DISTINCT job, username FROM versions ORDER BY username"):
        if row["job"] in allowed_jobs:
            counts[row["username"]] += 1
    return [{"username": name, "batches": count} for name, count in counts.items()]


def latest(db, job, author=None):
    sql = "SELECT id,username,created FROM versions WHERE job=?"
    args = [job]
    if author:
        sql += " AND username=?"
        args.append(author)
    return db.execute(sql + " ORDER BY created DESC, rowid DESC LIMIT 1", args).fetchone()


def match(db, item, author, reference_author):
    job = item["job_id"]
    after = latest(db, job, author)
    if after is None:
        return None, "指定作者尚无修订" if author else "尚无修订"
    before = None
    if reference_author:
        before = latest(db, job, reference_author)
        if before is None:
            return None, "参照作者尚无修订"
        if before["id"] == after["id"]:
            return None, "两侧指向同一修订"
    return {
        "case_id": item["case_id"],
        "job": job,
        "author": after["username"],
        "target": after["id"],
        "created": after["created"],
        "reference": before["id"] if before else catalog.ORIGINAL,
        "reference_author": before["username"] if before else None,
        "reference_created": before["created"] if before else None,
    }, None


def aggregate(rows):
    means = {}
    distributions = {}
    for key in ("dice", "iou"):
        values = [row[key] for row in rows]
        means[key] = sum(values) / len(values) if values else None
        distributions[key] = {
            "min": min(values) if values else None,
            "median": median(values) if values else None,
            "max": max(values) if values else None,
        }
    totals = {
        key: sum(row[key] for row in rows)
        for key in ("added", "erased", "shared", "reference_pixels", "target_pixels")
    }
    return means, distributions, totals


def compare_cohort(db, items, author=None, reference_author=None):
    rows = []
    missing = []
    for item in items:
        row, explanation = match(db, item, author, reference_author)
        if row is None:
            missing.append(
                {"job": item["job_id"], "case_id": item["case_id"], "reason": explanation}
            )
            continue
        baseline = imaging.binary(storage.mask_bytes(db, item, row["reference"]))
        revision = imaging.binary(storage.mask_bytes(db, item, row["target"]))
        rows.append({**row, **imaging.counts(baseline, revision)})
    means, distributions, totals = aggregate(rows)
    return {
        "rows": rows,
        "missing": missing,
        "mean": means,
        "distribution": distributions,
        "totals": totals,
        "cases": len({row["case_id"] for row in rows}),
        "available_authors": authors(db, {item["job_id"] for item in items}),
        "selection": {"author": author, "reference_author": reference_author, "unit": "job"},
    }
