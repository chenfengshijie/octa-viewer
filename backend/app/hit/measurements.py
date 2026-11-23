"""Descriptive measurements in native image coordinates.

All geometry here is in pixels. A revision is a comparison target, not a clinical reference.
"""

import numpy as np
from scipy import ndimage

from . import catalog, imaging


def sample_summary(values):
    return {
        "minimum": float(values.min()),
        "median": float(np.median(values)),
        "mean": float(values.mean(dtype=np.float64)),
        "maximum": float(values.max()),
        "p05": float(np.percentile(values, 5)),
        "p95": float(np.percentile(values, 95)),
    }


def probability_summary(values, original, threshold):
    thresholded = values > threshold
    bins, edges = np.histogram(values, bins=20, range=(0.0, 1.0))
    return {
        "bins": [
            {"low": float(edges[i]), "high": float(edges[i + 1]), "count": int(count)}
            for i, count in enumerate(bins)
        ],
        "threshold": threshold,
        "pixels": int(values.size),
        "probability": sample_summary(values),
        "selected": int(np.count_nonzero(thresholded)),
        "comparison": imaging.counts(original, thresholded),
    }


def changed_regions(reference, target, min_area=1):
    regions = []
    connectivity = np.ones((3, 3), dtype=np.uint8)
    for kind, changed in (("added", target & ~reference), ("erased", reference & ~target)):
        labels, n = ndimage.label(changed, structure=connectivity)
        if not n:
            continue
        sizes = np.bincount(labels.ravel())
        for number, box in enumerate(ndimage.find_objects(labels), start=1):
            if box is None or sizes[number] < min_area:
                continue
            yslice, xslice = box
            local_y, local_x = np.nonzero(labels[box] == number)
            # Put the marker on a real changed pixel, including for hollow regions.
            nearest = np.argmin((local_y - local_y.mean()) ** 2 + (local_x - local_x.mean()) ** 2)
            regions.append(
                {
                    "kind": kind,
                    "pixels": int(sizes[number]),
                    "x": int(xslice.start + local_x[nearest]),
                    "y": int(yslice.start + local_y[nearest]),
                    "bounds": [xslice.start, yslice.start, xslice.stop, yslice.stop],
                }
            )
    return sorted(regions, key=lambda r: (-r["pixels"], r["y"], r["x"], r["kind"]))


def surfaces(item):
    with np.load(catalog.artifact(item, "surfaces"), allow_pickle=False) as archive:
        if set(archive.files) != {"ilm", "opl", "bm"}:
            raise ValueError("曲面记录缺少所需边界")
        result = {key: archive[key] for key in archive.files}
    for values in result.values():
        if values.shape != (catalog.SIZE, catalog.SIZE) or values.dtype != np.int16:
            raise ValueError("曲面尺寸或数值类型不符合归档契约")
    if not np.all(
        (result["ilm"] >= 0)
        & (result["ilm"] < result["opl"])
        & (result["opl"] < result["bm"])
        & (result["bm"] < catalog.DEPTH)
    ):
        raise ValueError("曲面深度或层次顺序异常")
    return result


SLABS = {"shallow": ("ilm", "opl"), "deep": ("opl", "bm"), "full": ("ilm", "bm")}


def thickness(sheets, slab):
    top, bottom = SLABS[slab]
    return sheets[bottom] - sheets[top]


def thickness_map(distance):
    low, high = distance.min(), distance.max()
    ratio = np.zeros_like(distance, dtype=np.float32)
    if high > low:
        ratio = (distance - low).astype(np.float32) / (high - low)
    return imaging.heatmap(ratio)


def slab_summary(distance):
    min_y, min_x = np.unravel_index(np.argmin(distance), distance.shape)
    max_y, max_x = np.unravel_index(np.argmax(distance), distance.shape)
    return {
        **sample_summary(distance),
        "thinnest": {"x": int(min_x), "y": int(min_y)},
        "thickest": {"x": int(max_x), "y": int(max_y)},
        "row_medians": np.median(distance, axis=1).tolist(),
    }
