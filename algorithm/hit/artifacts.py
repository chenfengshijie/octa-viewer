"""Public artifacts in an OCT-guided large vessel result."""

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

MODEL_CHANNELS = ("deep_projection", "shallow_projection", "full_projection")

FILES = {
    "full_projection": "projections/OCTA_FULL.png",
    "shallow_projection": "projections/OCTA_ILM_OPL.png",
    "deep_projection": "projections/OCTA_OPL_BM.png",
    "model_input": "projections/input.png",
    "surfaces": "projections/surfaces.npz",
    "boundary_qc": "projections/oct_boundaries_qc.png",
    "probability": "result/probability.npy",
    "mask": "result/mask.png",
    "overlay": "result/overlay.png",
}


@dataclass(frozen=True)
class VesselParameters:
    """清单记录的推理参数与实际切块、阈值化共用同一份配置。"""

    threshold: float = 0.8
    tile_size_px: int = 224
    tile_overlap: float = 0.25
    tile_fov_mm: tuple[float, float] = (6.0, 6.0)


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}", value):
        raise ValueError(f"Invalid case or job identifier: {value!r}")
    return value


def save_prediction(directory, image, probability, threshold):
    """先以 float32 阈值化，再将概率压缩为 float16 存储。"""

    directory.mkdir(parents=True, exist_ok=True)
    mask = (probability > threshold).astype(np.uint8) * 255
    yellow = np.zeros_like(image)
    yellow[:, :, :2] = mask[:, :, None]
    overlay = ((image.astype(np.float32) + yellow) * 0.5).astype(np.uint8)
    np.save(directory / Path(FILES["probability"]).name, probability.astype(np.float16))
    Image.fromarray(mask).save(directory / Path(FILES["mask"]).name)
    Image.fromarray(overlay).save(directory / Path(FILES["overlay"]).name)
    return float(np.mean(mask > 0))
