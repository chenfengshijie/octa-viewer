import numpy as np
from PIL import Image


EXPECTED_VOLUME_SHAPE = (448, 1024, 448)
EXPECTED_IMAGE_SHAPE = (448, 448)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_volume(path, name):
    require(path.is_file(), f"{name}: missing file: {path}")
    volume = np.load(path, mmap_mode="r", allow_pickle=False)
    require(volume.dtype == np.uint8, f"{name}: expected uint8, got {volume.dtype}")
    require(volume.shape == EXPECTED_VOLUME_SHAPE,
            f"{name}: expected {EXPECTED_VOLUME_SHAPE}, got {volume.shape}")
    return volume


def validate_output(root):
    projections = root / "projections"
    result = root / "result"
    channels = []
    for name in ("OCTA_OPL_BM.png", "OCTA_ILM_OPL.png", "OCTA_FULL.png"):
        image = np.asarray(Image.open(projections / name))
        channels.append(image)
        require(image.dtype == np.uint8, f"{name}: expected uint8")
        require(image.shape == EXPECTED_IMAGE_SHAPE, f"{name}: unexpected shape {image.shape}")
    model_input = np.asarray(Image.open(projections / "input.png").convert("RGB"))
    require(model_input.shape == EXPECTED_IMAGE_SHAPE + (3,),
            f"input.png: unexpected shape {model_input.shape}")

    require(np.array_equal(np.stack(channels, axis=2), model_input),
            "input.png: expected channels in deep, shallow, full order")

    with np.load(projections / "surfaces.npz", allow_pickle=False) as surfaces:
        require(set(surfaces.files) == {"ilm", "opl", "bm"},
                f"surfaces.npz: expected ilm/opl/bm, got {surfaces.files}")
        ilm, opl, bm = surfaces["ilm"], surfaces["opl"], surfaces["bm"]
    for name, surface in (("ilm", ilm), ("opl", opl), ("bm", bm)):
        require(surface.dtype == np.int16, f"{name}: expected int16, got {surface.dtype}")
        require(surface.shape == EXPECTED_IMAGE_SHAPE, f"{name}: unexpected shape {surface.shape}")
    require(np.all((0 <= ilm) & (ilm < opl) & (opl < bm) & (bm < 1024)),
            "surfaces: expected 0 <= ILM < OPL < BM < 1024")

    probability = np.load(result / "probability.npy", allow_pickle=False)
    require(probability.dtype == np.float16,
            f"probability.npy: expected float16, got {probability.dtype}")
    require(probability.shape == EXPECTED_IMAGE_SHAPE,
            f"probability.npy: unexpected shape {probability.shape}")
    require(np.all((0 <= probability) & (probability <= 1)), "probability.npy: expected finite values in [0, 1]")

    mask = np.asarray(Image.open(result / "mask.png").convert("L"))
    require(mask.shape == EXPECTED_IMAGE_SHAPE, f"mask.png: unexpected shape {mask.shape}")
    require(set(np.unique(mask)).issubset({0, 255}),
            f"mask.png: expected only 0/255, got {np.unique(mask)}")
    overlay = np.asarray(Image.open(result / "overlay.png").convert("RGB"))
    require(overlay.shape == EXPECTED_IMAGE_SHAPE + (3,),
            f"overlay.png: unexpected shape {overlay.shape}")
