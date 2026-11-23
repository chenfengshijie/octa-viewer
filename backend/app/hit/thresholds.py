"""Count the strict-threshold foreground across a sweep without materializing one mask per step."""

import numpy as np


def foreground_curve(values, baseline, thresholds):
    """Sorted foreground/background scores allow every threshold to be evaluated by binary search."""
    foreground = np.sort(values[baseline].astype(np.float32))
    background = np.sort(values[~baseline].astype(np.float32))
    levels = np.asarray(thresholds, dtype=np.float32)
    shared = len(foreground) - np.searchsorted(foreground, levels, side="right")
    added = len(background) - np.searchsorted(background, levels, side="right")
    erased = len(foreground) - shared
    points = []
    for i, threshold in enumerate(thresholds):
        both = int(shared[i])
        new = int(added[i])
        removed = int(erased[i])
        selected = both + new
        union = selected + removed
        points.append(
            {
                "threshold": float(threshold),
                "selected": selected,
                "fraction": selected / values.size,
                "shared": both,
                "added": new,
                "erased": removed,
                "dice": 2 * both / (union + both) if union else 1.0,
                "iou": both / union if union else 1.0,
            }
        )
    return points


def sweep(values, baseline, low, high, intervals, model_threshold):
    levels = sorted(
        {
            *np.linspace(low, high, intervals + 1).round(6).tolist(),
            *([model_threshold] if low <= model_threshold <= high else []),
        }
    )
    return {
        "reference_pixels": int(np.count_nonzero(baseline)),
        "pixels": int(values.size),
        "original_threshold": model_threshold,
        "points": foreground_curve(values, baseline, levels),
    }
