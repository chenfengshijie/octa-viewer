"""Inspect immutable HIT inputs without starting the Viewer server."""

import argparse
import json
from pathlib import Path

from .archive import inspect_archive
from .comparisons import inspect_comparisons
from .volume import inspect_volume
from .database import inspect_database
from .run import inspect_run
from .source import inspect_sources
from .handoff import inspect_handoff


def main(args=None):
    parser = argparse.ArgumentParser(description="HIT 归档文件与复核记录静态验收")
    sub = parser.add_subparsers(dest="kind", required=True)
    for key, inspect, description in (
        ("handoff", inspect_handoff, "逐项对照交接源目录和已导入批次"),
        ("run", inspect_run, "核对已导入的推理批次目录"),
        ("volume", inspect_volume, "核对数据卷中批次间的文件和来源关系"),
        ("agreement", inspect_comparisons, "复算下载的版本对统计表"),
        ("database", inspect_database, "核对 SQLite 复核存储"),
        ("archive", inspect_archive, "复算研究包的摘要、来源和病例划分"),
    ):
        command = sub.add_parser(key, help=description)
        command.add_argument("input", type=Path, help=description)
        command.add_argument("--json", action="store_true", help="输出结构化验收记录")
        if key == "archive":
            command.add_argument("--data-dir", type=Path, help="回查数据卷中的推理和复核记录")
        if key == "handoff":
            command.add_argument(
                "--source", type=Path, required=True, help="含 output_manifest.json 的原始交接目录"
            )
        if key == "agreement":
            command.add_argument("--data-dir", type=Path, required=True, help="比较对来源数据卷")
        command.set_defaults(inspect=inspect)
    options = parser.parse_args(args)
    if options.kind == "handoff":
        report = inspect_handoff(options.input, options.source)
    elif options.kind == "agreement":
        report = inspect_comparisons(options.input, options.data_dir)
    else:
        report = options.inspect(options.input)
    if options.kind == "archive" and options.data_dir and not report.findings:
        inspect_sources(options.input, options.data_dir, report)
    if options.json:
        print(json.dumps(report.output(), ensure_ascii=False, indent=2))
    else:
        print(report.render())
    return int(bool(report.findings))


if __name__ == "__main__":
    raise SystemExit(main())
