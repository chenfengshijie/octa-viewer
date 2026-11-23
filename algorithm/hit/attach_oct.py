"""Attach the paired structural OCT to an existing Viewer run for line-by-line quality review."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory

if not __package__:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "algorithm.hit"

from .artifacts import identifier
from .contract import EXPECTED_VOLUME_SHAPE, validate_volume
from .import_result import DEFAULT_DATA


def paired_manifest(path, record):
    manifest = json.loads(path.read_text(encoding="utf-8"))
    for field in ("case_id", "job_id"):
        if manifest.get(field) != record[field]:
            raise ValueError(f"配对清单的 {field} 与目标推理批次不符")
    for field, expected in (
        ("shape", list(EXPECTED_VOLUME_SHAPE)),
        ("dtype", "uint8"),
        ("axes", ["Y", "Z", "X"]),
    ):
        if manifest.get(field) != expected:
            raise ValueError(f"配对清单的 {field} 与体数据契约不符")
    return manifest


def stage_volume(source, stage):
    digest = sha256()
    target = stage / "oct.npy"
    with source.open("rb") as reader, target.open("xb") as writer:
        for chunk in iter(lambda: reader.read(1024 * 1024), b""):
            writer.write(chunk)
            digest.update(chunk)
    # Inspect the exact bytes that will be published, rather than a mutable source file.
    validate_volume(target, "OCT")
    return digest.hexdigest()


def attach(data_dir, job_id, source, manifest_path):
    job = identifier(job_id)
    record_file = data_dir / "hit" / job / "record.json"
    if not record_file.is_file():
        raise ValueError("请先导入此病例的推理结果")
    record = json.loads(record_file.read_text(encoding="utf-8"))
    if record.get("job_id") != job:
        raise ValueError("归档记录的 job_id 与目录名称不符")
    contract = paired_manifest(manifest_path, record)
    parent = data_dir / "private" / "oct"
    parent.mkdir(parents=True, exist_ok=True)
    dest = parent / job
    with TemporaryDirectory(dir=parent, prefix=".attach-") as temp:
        stage = Path(temp) / "pair"
        stage.mkdir()
        checksum = stage_volume(source, stage)
        expected = contract.get("oct_sha256")
        if expected and checksum != expected:
            raise ValueError("结构 OCT 的 SHA-256 与配对清单不符")
        metadata = {
            "case_id": record["case_id"],
            "job_id": job,
            "sha256": checksum,
            "bytes": (stage / "oct.npy").stat().st_size,
            "axes": contract["axes"],
            "shape": contract["shape"],
            "dtype": contract["dtype"],
        }
        (stage / "pair.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        try:
            stage.rename(dest)
        except OSError:
            previous = dest / "pair.json"
            if not previous.is_file() or json.loads(previous.read_text()) != metadata:
                raise ValueError("此批次已关联另一份结构 OCT") from None
            with (dest / "oct.npy").open("rb") as stored:
                actual = sha256()
                for chunk in iter(lambda: stored.read(1024 * 1024), b""):
                    actual.update(chunk)
            if actual.hexdigest() != checksum:
                raise ValueError("已保存的结构 OCT 与配对清单不符")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", required=True, type=identifier)
    parser.add_argument("--oct", required=True, type=Path)
    parser.add_argument("--case-manifest", required=True, type=Path)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    args = parser.parse_args()
    print(json.dumps(attach(args.data_dir, args.job, args.oct, args.case_manifest), indent=2))


if __name__ == "__main__":
    main()
