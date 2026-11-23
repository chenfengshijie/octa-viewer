"""在眼底平面上切块并平均重叠区域的概率。"""

from collections.abc import Callable

import numpy as np


def tile_starts(length: int, window: int, stride: int):
    """最后一个窗口贴住图像边缘，即使剩余长度不足一个步长。"""
    last = length - window
    yield from range(0, last, stride)
    yield last


def tiled_probability(image: np.ndarray, predict: Callable, tile_size: int, overlap: float) -> np.ndarray:
    if tile_size <= 0 or not 0 <= overlap < 1:
        raise ValueError("Expected positive tile size and overlap in [0, 1)")
    height, width = image.shape[:2]
    window = min(tile_size, height, width)
    stride = max(1, round(window * (1 - overlap)))
    total = np.zeros((height, width), dtype=np.float32)
    count = np.zeros_like(total)
    for y in tile_starts(height, window, stride):
        for x in tile_starts(width, window, stride):
            region = np.s_[y : y + window, x : x + window]
            total[region] += predict(image[region])
            count[region] += 1
    return total / count
