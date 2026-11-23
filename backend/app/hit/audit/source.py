"""Cross-reference an exported snapshot with its owning data volume."""

from contextlib import closing
from hashlib import sha256
from pathlib import Path
import sqlite3
from zipfile import ZipFile

from .archive import directory, header, read_manifest
from .common import Report, file_digest, identifier, json_object, locate, require


def source_run(data, entry, report):
    case = identifier(entry["case_id"], "case_id")
    job = identifier(entry["job_id"], "job_id")
    root = data / "hit" / job
    record = json_object(locate(root, "record.json").read_bytes())
    require(
        record.get("case_id") == case and record.get("job_id") == job, "源批次的病例或批次标识不符"
    )
    for field in ("parameters", "model"):
        with report.inspect(job + " " + field):
            require(record[field] == entry[field], f"导出的 {field} 与源记录不同")
    for name in ("full_projection", "shallow_projection", "deep_projection", "model_input", "mask"):
        with report.inspect(f"{job}/{name} 来源"):
            relative = record["outputs"][name]
            exported = entry["files"][name]
            require(exported["path"] == f"{case}/{job}/{relative}", "归档路径与清单声明不同")
            expected = record["sha256"][name]
            require(expected == exported["sha256"], "导出文件与推理记录的摘要不同")
            actual = locate(root, relative)
            require(file_digest(actual) == expected, "推理记录与源文件实际摘要不同")


def source_revision(db, entry, report):
    exported = entry["revision"]
    identity = exported["id"]
    row = db.execute(
        "SELECT * FROM versions WHERE job=? AND id=?", (entry["job_id"], identity)
    ).fetchone()
    require(row is not None, "源数据库找不到导出的修订版本")
    for field in ("id", "job", "username", "source", "parent", "threshold", "digest"):
        with report.inspect("修订来源 " + field):
            require(row[field] == exported[field], f"导出的 {field} 与修订记录不同")
    with report.inspect("修订保存时间"):
        require(row["created"] == exported["updated_at"], "导出时间字段与修订保存时间不同")
    with report.inspect("修订掩膜实际内容"):
        require(
            sha256(row["png"]).hexdigest() == entry["files"]["revision"]["sha256"],
            "版本内容摘要不同",
        )
    review = entry["review"]
    with report.inspect("复核结论来源"):
        approved = db.execute("SELECT * FROM rounds WHERE id=?", (review["round_id"],)).fetchone()
        require(approved is not None, "源数据库找不到导出的复核轮次")
        require(approved["version"] == identity, "导出的轮次属于另一版本")
        require(approved["state"] == "approved", "该轮次没有通过结论")
        require(approved["reviewer"] == review["reviewer"], "复核人字段不符")
        require(approved["decided"] == review["decided"], "结论时间字段不符")


def inspect_sources(archive_path, data_dir, report=None):
    data_dir = Path(data_dir).resolve()
    report = report or Report("研究包来源", str(archive_path))
    report.facts["对照数据卷"] = str(data_dir)
    with report.inspect("源记录快照"):
        database = data_dir / "private" / "hit.sqlite3"
        require(database.is_file(), "源数据库文件不存在")
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
            with ZipFile(archive_path) as archive:
                manifest = read_manifest(archive, directory(archive))
                entries, _, _ = header(manifest)
                for index, entry in enumerate(entries):
                    with report.inspect(f"批次来源 {index + 1}"):
                        source_run(data_dir, entry, report)
                    with report.inspect(f"版本来源 {index + 1}"):
                        source_revision(db, entry, report)
    return report
