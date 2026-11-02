"""模型注册表与分发。

日后接入真实 PyTorch 推理（UNet-2D 等）只需：
1. 在此新增 ModelInfo 条目并置 available=True、挂上 predictor；
2. predictor 与 ground_truth.predict 同签名：
   (task_id: str, sample_dir: Path, sample_id: str) -> dict
   返回 overlays / prediction_url / metrics / extra 四个键。
"""
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from app.models import ground_truth

Predictor = Callable[[str, Path, str], dict]


@dataclass
class ModelInfo:
    id: str
    name: str
    available: bool
    predictor: Predictor | None = None


REGISTRY: dict[str, ModelInfo] = {
    "ground-truth": ModelInfo("ground-truth", "Ground Truth（数据自带）", True, ground_truth.predict),
    "unet2d": ModelInfo("unet2d", "UNet-2D", False),
    "unetpp2d": ModelInfo("unetpp2d", "UNet++ 2D", False),
    "ipnv2": ModelInfo("ipnv2", "IPN-V2 3D", False),
}

_ORDER = ("ground-truth", "unet2d", "unetpp2d", "ipnv2")


def list_models() -> list[dict]:
    return [
        {"id": REGISTRY[mid].id, "name": REGISTRY[mid].name, "available": REGISTRY[mid].available}
        for mid in _ORDER
    ]


def get_model(model_id: str) -> ModelInfo | None:
    return REGISTRY.get(model_id)


def dispatch(model_id: str, task_id: str, sample_dir: Path, sample_id: str) -> dict:
    """调用指定模型的 predictor；调用方须先确认 available。"""
    entry = REGISTRY[model_id]
    if entry.predictor is None:
        raise RuntimeError(f"模型 {model_id} 没有可用的 predictor")
    return entry.predictor(task_id, sample_dir, sample_id)
