"""Run the OCT-guided HIT pipeline in the GPU Python environment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone

import numpy as np
from PIL import Image

from artifacts import FILES, identifier
from contract import validate_output, validate_volume
from projection import project

LAYER_MODEL = "Dataset001_OCT-Layer-2d-TR"
TRAINER = "nnUNetTrainer_250epochs"
SAM_SCRIPT = Path(__file__).resolve().parent / "sam_octa" / "infer.py"
VESSEL_SHA256 = "2ccfc006468d2bbc21ed1b73072b195ce46d964c693bef101066d95579e317a7"

def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-id", required=True, type=identifier)
    parser.add_argument("--oct", required=True, type=Path)
    parser.add_argument("--octa", required=True, type=Path)
    parser.add_argument("--job-dir", required=True, type=Path, help="New directory; basename is the job ID")
    parser.add_argument("--nnunet-results", required=True, type=Path)
    parser.add_argument("--vessel-weight", required=True, type=Path)
    parser.add_argument("--gpu", default="0")
    args = parser.parse_args()
    job = args.job_dir.resolve()
    job_id = identifier(job.name)
    oct_volume = validate_volume(args.oct, "OCT")
    octa_volume = validate_volume(args.octa, "OCTA")
    if args.oct.samefile(args.octa):
        parser.error("Supply distinct OCT and OCTA volumes")
    predictor = Path(sys.executable).parent / "nnUNetv2_predict"
    executable = str(predictor) if predictor.is_file() else shutil.which("nnUNetv2_predict")
    if not executable:
        parser.error("nnUNetv2_predict is required in the GPU environment")
    model = args.nnunet_results / LAYER_MODEL / f"{TRAINER}__nnUNetPlans__2d"
    for name in ("plans.json", "dataset.json", "fold_0/checkpoint_final.pth"):
        if not (model / name).is_file():
            parser.error(f"Missing layer model file: {model / name}")
    if checksum(args.vessel_weight) != VESSEL_SHA256:
        parser.error("Vessel weight SHA-256 differs from vit_l_rv.pth in the handoff manifest")

    job.mkdir(parents=True, exist_ok=False)
    images, segments = job / "nnunet_images", job / "nnunet_segmentations"
    images.mkdir()
    for y, scan in enumerate(oct_volume):
        Image.fromarray(scan).save(images / f"{args.case_id}-{y:04d}_0000.png")
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=args.gpu, nnUNet_results=str(args.nnunet_results.resolve()))
    subprocess.run([executable, "-i", images, "-o", segments, "-d", "1", "-c", "2d", "-f", "0",
                    "-tr", TRAINER, "-npp", "1", "-nps", "1", "-device", "cuda", "--disable_progress_bar"],
                   env=env, check=True)
    project(oct_volume, octa_volume, segments, args.case_id, job / "projections")
    threshold, tile, overlap = 0.8, 224, 0.25
    subprocess.run([sys.executable, SAM_SCRIPT, "--input", job / FILES["model_input"], "--single-image",
                    "--weight", args.vessel_weight, "--output-dir", job / "result", "--model-type", "vit_l",
                    "--device", "cuda:0", "--threshold", str(threshold), "--tile-size", str(tile),
                    "--tile-overlap", str(overlap)], env=env, check=True)
    validate_output(job)
    with Image.open(job / FILES["mask"]) as image:
        fraction = float(np.mean(np.asarray(image) > 0))
    manifest = {
        "schema_version": "1.0", "case_id": args.case_id, "job_id": job_id,
        "task": "large_vessel", "status": "complete", "completed_at": datetime.now(timezone.utc).isoformat(),
        "model": {"layer_model": LAYER_MODEL, "vessel_weight": args.vessel_weight.name,
                  "vessel_weight_sha256": VESSEL_SHA256},
        "parameters": {"threshold": threshold, "tile_size_px": tile, "tile_overlap": overlap,
                       "tile_fov_mm": [6.0, 6.0]},
        "metrics": {"foreground_fraction": fraction}, "outputs": FILES,
    }
    temporary = job / "output_manifest.tmp"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary.replace(job / "output_manifest.json")
    print(job / "output_manifest.json")


if __name__ == "__main__":
    main()
