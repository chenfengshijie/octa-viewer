"""Run the OCT-guided HIT pipeline in the GPU Python environment."""

import argparse
import hashlib
import json
import os
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

# Allow both the documented file entry point and normal package imports.
if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "algorithm.hit"

from .artifacts import FILES, VesselParameters, identifier, save_prediction
from .contract import validate_output, validate_volume
from .layer_model import LAYER_MODEL, locate_predictor, segment_layers
from .projection import project
from .sam_octa.tiling import tiled_probability

VESSEL_SHA256 = "2ccfc006468d2bbc21ed1b73072b195ce46d964c693bef101066d95579e317a7"


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-id", required=True, type=identifier)
    parser.add_argument("--oct", required=True, type=Path)
    parser.add_argument("--octa", required=True, type=Path)
    parser.add_argument("--job-dir", required=True, type=Path, help="New directory; basename is the job ID")
    parser.add_argument("--nnunet-results", required=True, type=Path)
    parser.add_argument("--vessel-weight", required=True, type=Path)
    parser.add_argument("--gpu", default="0")
    return parser.parse_args()


def main():
    args = parse_args()
    job = args.job_dir.resolve()
    job_id = identifier(job.name)
    oct_volume = validate_volume(args.oct, "OCT")
    octa_volume = validate_volume(args.octa, "OCTA")
    if args.oct.samefile(args.octa):
        raise ValueError("Supply distinct OCT and OCTA volumes")
    executable = locate_predictor(args.nnunet_results)
    if checksum(args.vessel_weight) != VESSEL_SHA256:
        raise ValueError("Vessel weight SHA-256 differs from vit_l_rv.pth in the handoff manifest")

    # Select the worker GPU before importing PyTorch; nnU-Net inherits this selection.
    os.environ["CUDA_VISIBLE_DEVICES"] = args.gpu
    from .sam_octa.predictor import VesselPredictor

    job.mkdir(parents=True, exist_ok=False)
    segments = segment_layers(oct_volume, args.case_id, job, args.nnunet_results, executable)
    image = project(oct_volume, octa_volume, segments, args.case_id, job)
    predictor = VesselPredictor(args.vessel_weight, "vit_l", "cuda:0")
    parameters = VesselParameters()
    probability = tiled_probability(
        image, predictor.predict, parameters.tile_size_px, parameters.tile_overlap
    )
    fraction = save_prediction((job / FILES["mask"]).parent, image, probability, parameters.threshold)
    validate_output(job)
    manifest = {
        "schema_version": "1.0",
        "case_id": args.case_id,
        "job_id": job_id,
        "task": "large_vessel",
        "status": "complete",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "model": {
            "layer_model": LAYER_MODEL,
            "vessel_weight": args.vessel_weight.name,
            "vessel_weight_sha256": VESSEL_SHA256,
        },
        "parameters": asdict(parameters),
        "metrics": {"foreground_fraction": fraction},
        "outputs": FILES,
    }
    temporary = job / "output_manifest.tmp"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary.replace(job / "output_manifest.json")
    print(job / "output_manifest.json")


if __name__ == "__main__":
    main()
