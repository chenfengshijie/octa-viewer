"""Inspect relationships between immutable runs, private snapshots and optional structural data."""

from contextlib import closing
from pathlib import Path
import sqlite3

import numpy as np

from .common import Report, digest, file_digest, identifier, json_object, read_png, require
from .database import inspect_database
from .run import inspect_run


def merge_report(report, child, prefix):
    report.checked += child.checked
    for row in child.findings:
        report.problem(prefix + " / " + row.item, row.detail)


def published_runs(data, report):
    root = data / "hit"
    jobs = {}
    with report.inspect("已导入批次目录"):
        require(root.is_dir(), "数据卷中没有推理批次目录")
        for folder in sorted(root.iterdir()):
            if folder.name.startswith(".") or not folder.is_dir():
                continue
            result = inspect_run(folder)
            merge_report(report, result, folder.name)
            if "job_id" in result.facts and "case_id" in result.facts:
                jobs[result.facts["job_id"]] = result.facts["case_id"]
    report.facts["已导入批次"] = len(jobs)
    report.facts["病例"] = len(set(jobs.values()))
    return jobs


def legacy_roots(data, jobs, report):
    path = data / "hit-revisions"
    count = 0
    if path.is_dir():
        for image in sorted(path.glob("*/*.png")):
            count += 1
            with report.inspect(f"{image.parent.name} 历史个人修订"):
                require(image.parent.name in jobs, "旧修订未关联已导入的批次")
                read_png(image, "L", binary=True)
    report.facts["旧格式掩膜"] = count


def volume_pair(folder, jobs, report):
    job = folder.name
    path = folder / "oct.npy"
    with report.inspect(job + " 配对体"):
        require(job in jobs, "配对体未关联已导入的批次")
        require(path.is_file(), "配对目录缺少 oct.npy")
        volume = np.load(path, allow_pickle=False, mmap_mode="r")
        require(volume.dtype == np.uint8, "结构体应为 uint8")
        require(volume.shape == (448, 1024, 448), "结构体维度应为 Y、Z、X")
        metadata_path = folder / "pair.json"
        if metadata_path.exists():
            pair = json_object(metadata_path.read_bytes())
            require(pair.get("case_id") == jobs[job], "配对记录与清单的病例不符")
            require(pair.get("job_id") == job, "配对记录与目录的批次不符")
            require(pair.get("axes") == ["Y", "Z", "X"], "配对记录的轴序错误")
            require(pair.get("shape") == list(volume.shape), "配对记录与 OCT 形状不符")
            require(pair.get("dtype") == str(volume.dtype), "配对记录与 OCT 类型不符")
            require(pair.get("bytes") == path.stat().st_size, "配对记录与 OCT 字节数不符")
            require(
                file_digest(path) == digest(pair.get("sha256"), "OCT 摘要"), "结构 OCT 摘要不符"
            )


def private_sources(data, jobs, report):
    private = data / "private"
    root = private / "oct"
    count = 0
    if root.is_dir():
        for folder in sorted(root.iterdir()):
            if folder.name.startswith(".") or not folder.is_dir():
                continue
            count += 1
            volume_pair(folder, jobs, report)
    report.facts["配对结构体"] = count
    database = private / "hit.sqlite3"
    if not database.exists():
        report.facts["复核数据库"] = "尚未创建"
        return
    store = inspect_database(database)
    merge_report(report, store, "复核存储")
    report.facts.update(store.facts)
    if store.findings:
        return
    with report.inspect("批次与版本归属"):
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
            stored = {row[0] for row in db.execute("SELECT DISTINCT job FROM versions")}
            require(stored.issubset(jobs), "数据库中的历史版本引用了缺失的推理批次")
            for (job,) in db.execute("SELECT job FROM imported"):
                identifier(job, "迁移批次")
                require(job in jobs, "迁移记录引用了缺失的推理批次")


def inspect_volume(path):
    data = Path(path).resolve()
    report = Report("HIT 数据卷", str(data))
    with report.inspect("数据卷"):
        jobs = published_runs(data, report)
        legacy_roots(data, jobs, report)
        private_sources(data, jobs, report)
    return report
