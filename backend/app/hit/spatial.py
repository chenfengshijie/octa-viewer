"""Inspect a native-coordinate window shared by a projection, two masks and the probability plane."""

from dataclasses import dataclass

import numpy as np
from PIL import Image

from . import catalog, imaging, measurements


@dataclass(frozen=True)
class Window:
    left: int
    top: int
    right: int
    bottom: int

    @classmethod
    def centered(cls, x, y, size, side=catalog.SIZE):
        # Shift a border window into the image and retain its extent for a stable magnification.
        left = max(0, min(side - size, x - size // 2))
        top = max(0, min(side - size, y - size // 2))
        return cls(left, top, left + size, top + size)

    def cut(self, array):
        return array[self.top : self.bottom, self.left : self.right]

    def as_list(self):
        return [self.left, self.top, self.right, self.bottom]


def regional_metrics(before, after, probability, window):
    first = window.cut(before)
    second = window.cut(after)
    values = window.cut(probability)
    changed = first ^ second
    return {
        "bounds": window.as_list(),
        "pixels": int(first.size),
        "metrics": imaging.counts(first, second),
        "probability": measurements.sample_summary(values),
        "changed_probability": measurements.sample_summary(values[changed])
        if np.any(changed)
        else None,
    }


def at_position(item, before, after, values, x, y):
    layers = measurements.surfaces(item)
    pixel = {
        "x": x,
        "y": y,
        "reference": bool(before[y, x]),
        "target": bool(after[y, x]),
        "probability": float(values[y, x]),
        "depths": {key: int(layer[y, x]) for key, layer in layers.items()},
        "intensities": {},
    }
    for name in ("full_projection", "shallow_projection", "deep_projection"):
        with Image.open(catalog.artifact(item, name)) as image:
            pixel["intensities"][name] = int(image.getpixel((x, y)))
    return pixel


def render_crop(path, window, before, after, mode):
    with Image.open(path) as src:
        image = np.array(src.convert("RGB").crop(tuple(window.as_list())), dtype=np.uint8)
    first = window.cut(before)
    second = window.cut(after)
    if mode == "projection":
        return imaging.encode_png(image)
    if mode == "reference" or mode == "target":
        feature = first if mode == "reference" else second
        image[feature] = (
            image[feature].astype(np.float32) * 0.35 + np.array([250, 190, 50]) * 0.65
        ).astype(np.uint8)
        return imaging.encode_png(image)
    for select, color in (
        (first & second, [220, 220, 220]),
        (second & ~first, [34, 211, 238]),
        (first & ~second, [244, 114, 182]),
    ):
        image[select] = (image[select].astype(np.float32) * 0.35 + np.array(color) * 0.65).astype(
            np.uint8
        )
    return imaging.encode_png(image)
