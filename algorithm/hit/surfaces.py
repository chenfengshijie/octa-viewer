"""根据逐张 B-scan 的组织分割估计 ILM、OPL 代理与 BM 曲面。"""

from typing import NamedTuple

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, median_filter


class RetinalSurfaces(NamedTuple):
    ilm: np.ndarray
    opl: np.ndarray
    bm: np.ndarray


def smooth_surface(surface):
    return gaussian_filter(median_filter(surface, size=(7, 17)), sigma=(1.5, 4.0))


def first_tissue_segment(mask):
    """取首个前景段的左闭右开深度范围，并横向插值补齐空列。"""
    depth, width = mask.shape
    columns = np.flatnonzero(mask.any(axis=0))
    if columns.size < 2:
        raise ValueError("too few segmented columns")
    top = np.argmax(mask, axis=0)
    below_top = np.arange(depth)[:, None] >= top
    gaps = below_top & ~mask
    bottom = np.where(gaps.any(axis=0), np.argmax(gaps, axis=0), depth)
    x = np.arange(width)
    return np.interp(x, columns, top[columns]), np.interp(x, columns, bottom[columns])


def estimate_opl(oct_volume, ilm, bm):
    height, _, width = oct_volume.shape
    thickness = np.clip(bm - ilm, 30, 220)
    bm = ilm + thickness
    target = ilm + 0.58 * thickness
    opl = np.empty_like(ilm)
    for y in range(height):
        scan = gaussian_filter(np.asarray(oct_volume[y], dtype=np.float32), (2.0, 1.5))
        grad = np.abs(np.gradient(scan, axis=0))
        for x in range(width):
            lo = max(int(ilm[y, x] + 0.32 * thickness[y, x]), 0)
            hi = min(int(ilm[y, x] + 0.78 * thickness[y, x]), oct_volume.shape[1])
            if hi > lo:
                candidate = lo + int(np.argmax(grad[lo:hi, x]))
                opl[y, x] = 0.65 * target[y, x] + 0.35 * candidate
            else:
                opl[y, x] = target[y, x]
    opl = smooth_surface(opl)
    margin = np.maximum(5, 0.15 * thickness)
    opl = np.clip(opl, ilm + margin, bm - margin)
    return opl, bm


def surfaces_from_nnunet(oct_volume, segmentation_dir, sid):
    height, depth, width = oct_volume.shape
    ilm = np.empty((height, width), dtype=np.float32)
    bm = np.empty_like(ilm)
    for y in range(height):
        path = segmentation_dir / f"{sid}-{y:04d}.png"
        with Image.open(path) as image:
            mask = np.asarray(image) > 0
        if mask.shape != (depth, width):
            raise ValueError(f"{path}: expected {(depth, width)}, got {mask.shape}")
        try:
            ilm[y], bm[y] = first_tissue_segment(mask)
        except ValueError as exc:
            raise ValueError(f"{path}: {exc}") from exc
    ilm = smooth_surface(ilm)
    bm = smooth_surface(bm)
    opl, bm = estimate_opl(oct_volume, ilm, bm)
    return RetinalSurfaces(*(np.rint(s).astype(np.int16) for s in (ilm, opl, bm)))
