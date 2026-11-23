"""SAM-OCTA 权重装载与单幅图像预测。"""

from pathlib import Path

import numpy as np
import torch

from .sam_lora_image_encoder import LoRA_Sam
from .segment_anything import sam_model_registry
from .segment_anything.utils.transforms import ResizeLongestSide


class VesselPredictor:
    def __init__(self, weight: Path, model_type: str, device: str):
        if device.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is unavailable")
        self.device = device
        self.transform = ResizeLongestSide(224 if model_type == "vit_b" else 1024)
        self.model = LoRA_Sam(sam_model_registry[model_type](checkpoint=None), 4)
        state = torch.load(weight, map_location="cpu", weights_only=True)
        self.model.load_state_dict({k.removeprefix("module."): v for k, v in state.items()}, strict=True)
        self.model.eval().to(device)

    @torch.inference_mode()
    def predict(self, image: np.ndarray, points=((-100, -100),), labels=(0,)) -> np.ndarray:
        """返回原图网格上的 float32 概率；默认提示沿用训练端的占位点。"""
        size = image.shape[:2]
        pixels = torch.from_numpy(image.copy()).permute(2, 0, 1).unsqueeze(0).float()
        coords = torch.tensor(points, dtype=torch.float32).unsqueeze(0)
        labels = torch.tensor(labels, dtype=torch.float32, device=self.device).unsqueeze(0)
        pixels = self.transform.apply_image_torch(pixels).to(self.device)
        coords = self.transform.apply_coords_torch(coords, size).to(self.device)
        probability = self.model(pixels, size, coords, labels)
        return probability[0, 0].float().cpu().numpy()
