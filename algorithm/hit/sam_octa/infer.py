import argparse
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import center_of_mass, label

# Keep the standalone image CLI usable from a checkout as well as via python -m.
if not __package__:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    __package__ = "algorithm.hit.sam_octa"

from ..artifacts import FILES, VesselParameters, save_prediction
from .tiling import tiled_probability


def parse_args():
    defaults = VesselParameters()
    parser = argparse.ArgumentParser(description="Run SAM-OCTA inference on one image")
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--input", type=Path)
    inputs.add_argument(
        "--channels",
        nargs=3,
        type=Path,
        metavar=("OPL_BM", "ILM_OPL", "FULL"),
        help="Three OCTA-500 grayscale projections in the model's training order",
    )
    parser.add_argument("--weight", required=True, type=Path)
    parser.add_argument("--output-dir", default=Path("prediction"), type=Path)
    parser.add_argument("--model-type", choices=("vit_b", "vit_l", "vit_h"), default="vit_l")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--threshold", default=defaults.threshold, type=float)
    parser.add_argument("--tile-size", default=0, type=int, help="Square tile size; 0 runs the whole image")
    parser.add_argument("--tile-overlap", default=defaults.tile_overlap, type=float)
    parser.add_argument(
        "--single-image",
        action="store_true",
        help="Treat the entire input as an image with no prompt canvas",
    )
    return parser.parse_args()


def colored_points(prompt_image):
    points = []
    point_labels = []
    for color, point_label in (((0, 255, 0), 1), ((255, 0, 0), 0)):
        diff = np.abs(prompt_image.astype(np.int16) - np.asarray(color, dtype=np.int16)).sum(axis=2)
        components, count = label((diff < 10).astype(np.uint8), structure=np.ones((3, 3)))
        for component_id in range(1, count + 1):
            y, x = center_of_mass(components == component_id)
            points.append([int(x), int(y)])
            point_labels.append(point_label)
    if not points:
        points = [[-100, -100]]
        point_labels = [0]
    return points, point_labels


def read_input(args):
    if args.channels:
        planes = []
        for path in args.channels:
            with Image.open(path) as source:
                planes.append(np.asarray(source.convert("L")))
        return np.stack(planes, axis=2), None
    with Image.open(args.input) as source:
        image = np.asarray(source.convert("RGB"))
    if args.single_image:
        return image, None
    if image.shape[1] % 2:
        raise ValueError("Prompt-canvas input width must be even")
    image, canvas = np.split(image, 2, axis=1)
    return image, colored_points(canvas)


def main():
    args = parse_args()
    image, prompt = read_input(args)
    from .predictor import VesselPredictor

    predictor = VesselPredictor(args.weight, args.model_type, args.device)
    if args.tile_size:
        probability = tiled_probability(image, predictor.predict, args.tile_size, args.tile_overlap)
    else:
        probability = predictor.predict(image, *prompt) if prompt else predictor.predict(image)
    save_prediction(args.output_dir, image, probability, args.threshold)
    for key in ("mask", "overlay"):
        print(f"{key}={args.output_dir / Path(FILES[key]).name}")


if __name__ == "__main__":
    main()
