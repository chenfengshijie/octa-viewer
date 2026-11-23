"""Publish a completed HIT result to the Viewer data volume."""

import argparse
import hashlib
import json
import math
import shutil
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

if not __package__:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "algorithm.hit"

from .artifacts import FILES, identifier
from .contract import validate_output

DEFAULT_DATA = Path(__file__).resolve().parents[2] / "backend" / "data"


def read_manifest(source):
    manifest = json.loads((source / "output_manifest.json").read_text())
    if (manifest.get("schema_version"), manifest.get("task"), manifest.get("status")) != (
        "1.0",
        "large_vessel",
        "complete",
    ):
        raise ValueError("Expected a completed v1.0 large_vessel result")
    identifier(manifest["case_id"])
    model = manifest.get("model")
    weight = model.get("vessel_weight") if isinstance(model, dict) else None
    if not isinstance(weight, str) or not weight.strip():
        raise ValueError("Expected a vessel model in the result manifest")
    params = manifest.get("parameters", {})
    for field in ("threshold", "tile_size_px", "tile_overlap"):
        if not isinstance(params.get(field), (float, int)) or not math.isfinite(params[field]):
            raise ValueError(f"Invalid result parameter: {field}")
    return manifest


def copy_outputs(source, stage, declared):
    hashes = {}
    for key, relative in FILES.items():
        # v1.0 derives the two grayscale slab paths from its projection layout.
        name = (
            declared.get(key, relative) if key in ("shallow_projection", "deep_projection") else declared[key]
        )
        path = (source / name).resolve()
        path.relative_to(source)
        target = stage / relative
        target.parent.mkdir(exist_ok=True)
        shutil.copyfile(path, target)
        hashes[key] = hashlib.sha256(target.read_bytes()).hexdigest()
    return hashes


def publish(source, data):
    source = source.resolve()
    manifest = read_manifest(source)
    case = manifest["case_id"]
    root = data / "hit"
    root.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".import-", dir=root) as temp:
        stage = Path(temp) / "result-set"
        stage.mkdir()
        hashes = copy_outputs(source, stage, manifest["outputs"])
        validate_output(stage)
        with Image.open(stage / FILES["boundary_qc"]) as qc:
            qc.verify()
        record = {
            "case_id": case,
            "model": manifest["model"],
            "parameters": manifest["parameters"],
            "outputs": FILES,
            "sha256": hashes,
            "completed_at": manifest.get("completed_at"),
        }
        fingerprint = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
        fallback = f"{case[:60]}-{fingerprint[:24]}"
        job = identifier(manifest.get("job_id", fallback))
        record["job_id"] = job
        serialized = json.dumps(record, ensure_ascii=False, indent=2) + "\n"
        (stage / "record.json").write_text(serialized)
        destination = root / job
        try:
            stage.rename(destination)
        except OSError:
            existing = destination / "record.json"
            if not existing.is_file() or existing.read_text() != serialized:
                raise
        return job


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("result_dir", type=Path)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    args = parser.parse_args()
    print(publish(args.result_dir, args.data_dir))


if __name__ == "__main__":
    main()
