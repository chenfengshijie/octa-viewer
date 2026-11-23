"""将结构 OCT 拆分成 nnU-Net 输入，并取得每张 B-scan 的组织掩膜。"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

LAYER_MODEL = "Dataset001_OCT-Layer-2d-TR"
TRAINER = "nnUNetTrainer_250epochs"


def locate_predictor(results: Path) -> str:
    model = results / LAYER_MODEL / f"{TRAINER}__nnUNetPlans__2d"
    for relative in ("plans.json", "dataset.json", "fold_0/checkpoint_final.pth"):
        if not (model / relative).is_file():
            raise FileNotFoundError(model / relative)
    local = Path(sys.executable).parent / "nnUNetv2_predict"
    executable = str(local) if local.is_file() else shutil.which("nnUNetv2_predict")
    if not executable:
        raise FileNotFoundError("nnUNetv2_predict is required in the GPU environment")
    return executable


def segment_layers(volume, case_id, job, results, executable):
    images = job / "nnunet_images"
    segments = job / "nnunet_segmentations"
    images.mkdir()
    for index, scan in enumerate(volume):
        Image.fromarray(scan).save(images / f"{case_id}-{index:04d}_0000.png")
    subprocess.run(
        [
            executable,
            "-i",
            images,
            "-o",
            segments,
            "-d",
            "1",
            "-c",
            "2d",
            "-f",
            "0",
            "-tr",
            TRAINER,
            "-npp",
            "1",
            "-nps",
            "1",
            "-device",
            "cuda",
            "--disable_progress_bar",
        ],
        env={**os.environ, "nnUNet_results": str(results.resolve())},
        check=True,
    )
    return segments
