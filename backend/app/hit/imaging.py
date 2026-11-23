"""Pixel-space operations on one archived run. All masks share the en-face coordinates."""

from io import BytesIO

import numpy as np
from fastapi import HTTPException
from PIL import Image

from . import catalog


def encode_png(array):
    out = BytesIO()
    Image.fromarray(array).save(out, format="PNG")
    return out.getvalue()


def binary(png):
    with Image.open(BytesIO(png)) as image:
        if image.size != (catalog.SIZE, catalog.SIZE):
            raise HTTPException(422, "掩膜与投影尺寸不一致")
        return np.asarray(image.convert("L")) > 0


def counts(reference, target):
    common = int(np.count_nonzero(reference & target))
    added = int(np.count_nonzero(target & ~reference))
    erased = int(np.count_nonzero(reference & ~target))
    union = common + added + erased
    return {
        "reference_pixels": common + erased,
        "target_pixels": common + added,
        "shared": common,
        "added": added,
        "erased": erased,
        "dice": 2 * common / (common + union) if union else 1.0,
        "iou": common / union if union else 1.0,
    }


def difference(reference, target):
    rgba = np.zeros((*reference.shape, 4), dtype=np.uint8)
    rgba[reference & target] = (200, 200, 200, 100)
    rgba[target & ~reference] = (34, 211, 238, 245)
    rgba[reference & ~target] = (244, 114, 182, 245)
    return encode_png(rgba)


def probability(item):
    values = np.load(catalog.artifact(item, "probability"), allow_pickle=False)
    if values.dtype != np.float16 or values.shape != (catalog.SIZE, catalog.SIZE):
        raise HTTPException(422, "概率图的类型或尺寸与清单契约不符")
    values = values.astype(np.float32)
    if not np.all((values >= 0) & (values <= 1)):
        raise HTTPException(422, "概率值超出范围")
    return values


def threshold_mask(values, threshold):
    return encode_png((values > threshold).astype(np.uint8) * 255)


def heatmap(values):
    stops = [0, 0.25, 0.5, 0.75, 1]
    colors = np.array(
        [[30, 58, 138], [14, 116, 144], [20, 184, 166], [250, 204, 21], [239, 68, 68]]
    )
    rgb = np.stack([np.interp(values, stops, colors[:, i]) for i in range(3)], axis=2)
    return encode_png(rgb.astype(np.uint8))
