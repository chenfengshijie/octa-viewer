"""Read a consistent SQLite snapshot, preserving the live application's data.

This reader never initializes a schema, migrates a PNG or prints the content of a review.
"""

from collections import Counter
from contextlib import closing
from hashlib import sha256
from pathlib import Path
import sqlite3

from .common import (
    Report,
    digest,
    identifier,
    integer,
    read_png,
    require,
    snapshot_id,
    string,
    timestamp,
    version_source,
)

TABLES = {
    "versions": {
        "id",
        "job",
        "username",
        "created",
        "parent",
        "threshold",
        "source",
        "png",
        "digest",
    },
    "heads": {"job", "username", "version"},
    "imported": {"job"},
    "rounds": {
        "id",
        "version",
        "previous",
        "reason",
        "submitted",
        "state",
        "reviewer",
        "decided",
        "conclusion",
    },
    "comments": {"id", "round_id", "author", "created", "body", "x", "y"},
}


def schema(db, report):
    for table, expected in TABLES.items():
        with report.inspect("表结构 " + table):
            actual = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
            missing = sorted(expected - actual)
            require(not missing, "缺少字段 " + ", ".join(missing))
    with report.inspect("数据库页完整性"):
        messages = [row[0] for row in db.execute("PRAGMA quick_check")]
        require(messages == ["ok"], "SQLite 页完整性检查未通过")
    with report.inspect("外键"):
        invalid = db.execute("PRAGMA foreign_key_check").fetchone()
        require(invalid is None, "存在失效的外键引用")


def versions(db, report):
    rows = {}
    for row in db.execute(
        "SELECT id,job,username,created,parent,threshold,source,digest,png FROM versions"
    ):
        data = dict(row)
        png = data.pop("png")
        key = data["id"]
        rows[key] = data
        with report.inspect("修订 " + str(key)):
            snapshot_id(key, "id")
            identifier(data["job"], "job")
            string(data["username"], "username")
            timestamp(data["created"], "created")
            expected = digest(data["digest"], "digest")
            require(sha256(png).hexdigest() == expected, "掩膜摘要与修订记录不符")
            read_png(png, "L", binary=True)
            version_source(data)
    return rows


def check_cycles(rows, parent, report, name):
    """Check each link once, including disconnected trees with a cycle."""
    finished = set()
    for first in rows:
        if first in finished:
            continue
        cursor = first
        visiting = set()
        while cursor in rows and cursor not in finished:
            if cursor in visiting:
                report.problem(name, "历史关系出现环，关联标识 " + str(cursor))
                break
            visiting.add(cursor)
            cursor = rows[cursor][parent]
        finished.update(visiting)


def provenance(rows, report):
    for identity, row in rows.items():
        if not row["parent"]:
            continue
        with report.inspect("来源 " + identity):
            previous = rows.get(row["parent"])
            require(previous is not None, "来源版本缺失")
            require(previous["job"] == row["job"], "来源版本属于其他批次")
            require(
                timestamp(previous["created"], "来源时间") <= timestamp(row["created"], "保存时间"),
                "来源版本晚于当前版本",
            )
    check_cycles(rows, "parent", report, "修订来源关系")


def heads(db, rows, report):
    seen = set()
    for head in db.execute("SELECT job, username, version FROM heads"):
        with report.inspect("当前版本 " + head["version"]):
            key = (head["job"], head["username"])
            require(key not in seen, "作者在同一批次有多个当前版本")
            seen.add(key)
            current = rows.get(head["version"])
            require(current is not None, "当前版本不存在")
            require((current["job"], current["username"]) == key, "当前版本指向其他批次或作者")
    report.facts["当前个人版本"] = len(seen)


def rounds(db, rows, report):
    items = {}
    for row in db.execute("SELECT * FROM rounds"):
        data = dict(row)
        identity = data["id"]
        items[identity] = data
        with report.inspect("复核轮次 " + identity):
            snapshot_id(identity, "id")
            revision = rows.get(data["version"])
            require(revision is not None, "复核版本不存在")
            submitted = timestamp(data["submitted"], "提交时间")
            require(submitted >= timestamp(revision["created"], "保存时间"), "提交早于保存")
            state = data["state"]
            require(state in {"pending", "approved", "returned"}, "复核状态无效")
            if state == "pending":
                require(
                    all(data[key] is None for key in ("decided", "conclusion", "reviewer")),
                    "待复核轮次已有结论",
                )
            else:
                reviewer = string(data["reviewer"], "复核人")
                require(reviewer != revision["username"], "版本由作者本人审批")
                require(timestamp(data["decided"], "结论时间") >= submitted, "结论早于提交")
                require(isinstance(data["conclusion"], str), "缺少结论说明字段")
    return items


def resubmissions(items, versions, report):
    next_round = {}
    pending = set()
    approved = set()
    for key, item in items.items():
        with report.inspect("轮次关系 " + key):
            version = item["version"]
            if item["state"] == "pending":
                require(version not in pending, "版本存在多轮待复核")
                pending.add(version)
            if item["state"] == "approved":
                require(version not in approved, "同一版本存在多轮通过")
                approved.add(version)
            previous_id = item["previous"]
            if previous_id is None:
                continue
            earlier = items.get(previous_id)
            require(
                earlier is not None and earlier["state"] == "returned", "重提未关联已退回的轮次"
            )
            require(previous_id not in next_round, "同一轮退回被重提多次")
            next_round[previous_id] = key
            require(
                timestamp(item["submitted"], "重提时间")
                >= timestamp(earlier["decided"], "退回时间"),
                "重提早于退回",
            )
            parent_version = versions[earlier["version"]]
            current_version = versions[version]
            require(parent_version["job"] == current_version["job"], "重提跨越推理批次")
            require(parent_version["username"] == current_version["username"], "重提跨越修订作者")
            if version == earlier["version"]:
                string(item["reason"], "原版重提理由")
    require(not pending.intersection(approved), "存在已经通过且仍待复核的版本")
    check_cycles(items, "previous", report, "重提轮次关系")


def comments(db, items, report):
    count = 0
    located = 0
    for row in db.execute("SELECT * FROM comments"):
        count += 1
        with report.inspect("复核意见 " + row["id"]):
            snapshot_id(row["id"], "意见标识")
            current = items.get(row["round_id"])
            require(current is not None, "意见所属轮次不存在")
            string(row["body"], "意见内容")
            string(row["author"], "意见作者")
            created = timestamp(row["created"], "意见创建时间")
            require(created >= timestamp(current["submitted"], "提交时间"), "意见早于送审")
            if current["decided"]:
                require(created <= timestamp(current["decided"], "结论时间"), "意见在归档后写入")
            x, y = row["x"], row["y"]
            require((x is None) == (y is None), "位置意见缺少一个坐标")
            if x is not None:
                integer(x, "X", 0, 447)
                integer(y, "Y", 0, 447)
                located += 1
    report.facts["复核意见"] = count
    report.facts["带位置的意见"] = located


def receipts(db, versions, report):
    # Older volume snapshots can predate idempotent saves.
    schema = db.execute("PRAGMA user_version").fetchone()[0]
    exists = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='saves'"
    ).fetchone()
    if not exists:
        require(schema == 0, "当前数据库格式缺少保存回执表")
        return
    count = 0
    for receipt in db.execute("SELECT job,username,request_id,fingerprint,version FROM saves"):
        count += 1
        with report.inspect("保存回执 " + str(receipt["request_id"])):
            snapshot_id(receipt["request_id"], "请求标识")
            digest(receipt["fingerprint"], "保存请求摘要")
            target = versions.get(receipt["version"])
            require(target is not None, "保存回执指向失效的版本")
            require(target["job"] == receipt["job"], "保存回执与版本批次不符")
            require(target["username"] == receipt["username"], "保存回执与版本作者不符")
    report.facts["保存回执"] = count


def inspect_database(path):
    path = Path(path).resolve()
    report = Report("复核存储", str(path))
    with report.inspect("SQLite 只读快照"):
        require(path.is_file(), "数据库文件不存在")
        uri = path.as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, isolation_level=None)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
            schema(db, report)
            if report.findings:
                return report
            revision_rows = versions(db, report)
            receipts(db, revision_rows, report)
            provenance(revision_rows, report)
            heads(db, revision_rows, report)
            review_rows = rounds(db, revision_rows, report)
            resubmissions(review_rows, revision_rows, report)
            comments(db, review_rows, report)
            report.facts["历史版本"] = len(revision_rows)
            report.facts["轮次状态"] = dict(Counter(item["state"] for item in review_rows.values()))
            imported = {row[0] for row in db.execute("SELECT job FROM imported")}
            jobs = {row["job"] for row in revision_rows.values()}
            with report.inspect("旧版本导入记录"):
                require(jobs.issubset(imported), "已有修订的批次缺少迁移标记")
    return report
