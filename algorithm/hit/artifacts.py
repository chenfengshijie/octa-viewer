"""Public artifacts in an OCT-guided large vessel result."""
import re

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

def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}", value):
        raise ValueError(f"Invalid case or job identifier: {value!r}")
    return value
