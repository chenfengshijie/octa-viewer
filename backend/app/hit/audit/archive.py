"""Validate all referenced members and their scientific provenance in a research package."""

from collections import Counter
from hashlib import sha256
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile

from ..cohort import split_case
from .common import (
    Report,
    check_channels,
    digest,
    identifier,
    integer,
    json_object,
    mapping,
    model_info,
    parameter_info,
    read_png,
    relative_name,
    require,
    snapshot_id,
    string,
    timestamp,
    version_source,
)

EXPORT_FILES = (
    "full_projection",
    "shallow_projection",
    "deep_projection",
    "model_input",
    "mask",
    "revision",
)


def directory(archive):
    entries = {}
    for member in archive.infolist():
        name = member.filename
        relative_name(name)
        require(not member.is_dir(), "清单之外不能含目录条目")
        require(name not in entries, f"压缩包内路径重复 {name}")
        require(member.compress_type in (ZIP_STORED, ZIP_DEFLATED), "研究包编码不受支持")
        require(not member.flag_bits & 1, "研究包包含加密条目")
        entries[name] = member
    return entries


def read_manifest(archive, entries):
    item = entries.get("manifest.json")
    require(item is not None, "缺少 manifest.json")
    return json_object(archive.read(item))


def split_policy(manifest):
    split = mapping(manifest.get("split"), "split")
    require(split.get("unit") == "case_id", "划分单位应为病例")
    require(split.get("method") == "sha256-json-seed-case-mod100", "划分方法无法复算")
    for group, interval in (("train", [0, 79]), ("validation", [80, 89]), ("test", [90, 99])):
        require(split.get(group) == interval, f"{group} 区间与划分方法不符")
    return string(split.get("seed"), "seed")


def header(manifest):
    require(manifest.get("schema") == "hit-research-v1", "研究包 schema 不受支持")
    timestamp(manifest.get("created"), "created")
    filters = mapping(manifest.get("filters"), "filters")
    require(set(filters) == {"case", "job", "author"}, "筛选条件字段不完整")
    for name, value in filters.items():
        require(isinstance(value, str), f"筛选字段 {name} 应为字符串")
    rows = manifest.get("runs")
    require(isinstance(rows, list) and len(rows) > 0, "清单应含至少一个批次")
    return rows, filters, split_policy(manifest)


def revision_metadata(row, job):
    version = mapping(row.get("revision"), "revision")
    identity = snapshot_id(version.get("id"), "revision.id")
    require(version.get("job") == job, "修订归属的批次不符")
    author = string(version.get("username"), "revision.username")
    created = timestamp(version.get("updated_at"), "revision.updated_at")
    digest(version.get("digest"), "revision.digest")
    version_source(version)
    review = mapping(row.get("review"), "review")
    snapshot_id(review.get("round_id"), "review.round_id")
    reviewer = string(review.get("reviewer"), "review.reviewer")
    require(author != reviewer, "导出修订由作者本人复核")
    decision = timestamp(review.get("decided"), "review.decided")
    require(decision >= created, "复核时间早于修订创建时间")
    return identity, author


def archive_image(archive, entries, record, name, case, job, claimed, revision):
    definition = mapping(record["files"][name], name)
    relative = relative_name(definition.get("path"))
    require(relative.parts[:2] == (case, job), "文件路径与病例或批次不符")
    path = relative.as_posix()
    require(path not in claimed, "多个文件引用相同的压缩包路径")
    claimed.add(path)
    member = entries.get(path)
    require(member is not None, "清单引用缺失的文件")
    expected_size = integer(definition.get("bytes"), "bytes", 1)
    require(member.file_size == expected_size, "清单字节数与 ZIP 索引不符")
    expected_digest = digest(definition.get("sha256"), name)
    if name == "revision":
        require(
            relative.parts[2:] == ("revision", revision["id"] + ".png"), "修订文件名与版本标识不符"
        )
        require(revision["digest"] == expected_digest, "导出修订与存储版本的摘要不符")
    raw = archive.read(member)
    require(sha256(raw).hexdigest() == expected_digest, "压缩包内实际数据摘要不符")
    return read_png(
        raw, "RGB" if name == "model_input" else "L", binary=name in ("mask", "revision")
    )


def inspect_archive(path):
    report = Report("研究数据包", str(path))
    with report.inspect("ZIP 索引"):
        with ZipFile(path, "r") as archive:
            entries = directory(archive)
            rows, filters, seed = header(read_manifest(archive, entries))
            claimed = {"manifest.json"}
            jobs = set()
            versions = set()
            rounds = set()
            subsets = {}
            for i, raw in enumerate(rows):
                with report.inspect(f"runs[{i}]"):
                    row = mapping(raw, "run")
                    case = identifier(row.get("case_id"), "case_id")
                    job = identifier(row.get("job_id"), "job_id")
                    require(job not in jobs, "同一批次被导出多次")
                    jobs.add(job)
                    require(row.get("split") == split_case(case, seed), "病例划分与种子不符")
                    subsets[case] = row["split"]
                    model_info(row.get("model"))
                    parameter_info(row.get("parameters"))
                    identity, author = revision_metadata(row, job)
                    require(identity not in versions, "版本被多个批次引用")
                    versions.add(identity)
                    round_id = row["review"]["round_id"]
                    require(round_id not in rounds, "多个版本引用同一复核轮次")
                    rounds.add(round_id)
                    criteria = {"case": case, "job": job, "author": author}
                    require(
                        all(value in criteria[key] for key, value in filters.items()),
                        "入选版本与清单筛选条件不符",
                    )
                    require(
                        set(mapping(row.get("files"), "files")) == set(EXPORT_FILES),
                        "批次文件清单不完整",
                    )
                    images = {}
                    for key in EXPORT_FILES:
                        with report.inspect(f"{job}/{key}"):
                            images[key] = archive_image(
                                archive, entries, row, key, case, job, claimed, row["revision"]
                            )
                    if all(key in images for key in EXPORT_FILES[:4]):
                        with report.inspect(job + " 模型输入通道"):
                            check_channels(images, images["model_input"])
            with report.inspect("归档文件覆盖"):
                extras = set(entries) - claimed
                require(not extras, f"{len(extras)} 个文件未被清单引用")
            report.facts.update(
                病例=len(subsets), 批次=len(jobs), 修订版本=len(versions), 文件=len(entries)
            )
            report.facts["各子集病例数"] = dict(Counter(subsets.values()))
    return report
