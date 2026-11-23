import argparse
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from scipy.ndimage import center_of_mass, label

from sam_lora_image_encoder import LoRA_Sam
from segment_anything import sam_model_registry
from segment_anything.utils.transforms import ResizeLongestSide


def parse_args():
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
    parser.add_argument("--threshold", default=0.8, type=float)
    parser.add_argument("--tile-size", default=0, type=int, help="Square tile size; 0 runs the whole image")
    parser.add_argument("--tile-overlap", default=0.25, type=float)
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


def predict_probability(model, image, transform, device):
    original_size = tuple(image.shape[:2])
    image_tensor = torch.from_numpy(image.copy().transpose(2, 0, 1)[None]).float()
    point_tensor = torch.tensor([[[-100, -100]]], dtype=torch.float32)
    point_label_tensor = torch.tensor([[0]], dtype=torch.float32)
    image_tensor = transform.apply_image_torch(image_tensor).to(device)
    point_tensor = transform.apply_coords_torch(point_tensor, original_size).to(device)
    point_label_tensor = point_label_tensor.to(device)
    with torch.inference_mode():
        probability = model(image_tensor, original_size, point_tensor, point_label_tensor)
    return probability[0, 0].float().cpu().numpy()


def tile_positions(length, tile_size, stride):
    positions = list(range(0, max(length - tile_size, 0) + 1, stride))
    last = max(length - tile_size, 0)
    if not positions or positions[-1] != last:
        positions.append(last)
    return positions


def main():
    args = parse_args()
    if args.device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is unavailable")

    if args.channels:
        missing = [path for path in args.channels if not path.is_file()]
        if missing:
            raise FileNotFoundError(missing)
        raw_image = np.stack(
            [np.asarray(Image.open(path).convert("L")) for path in args.channels], axis=2
        )
    else:
        if not args.input.is_file():
            raise FileNotFoundError(args.input)
        raw_image = np.asarray(Image.open(args.input).convert("RGB"))
    if args.single_image or args.channels:
        image = raw_image
        points, point_labels = [[-100, -100]], [0]
    else:
        if raw_image.shape[1] % 2:
            raise ValueError("Prompt-canvas input width must be even")
        image, prompt_image = np.split(raw_image, 2, axis=1)
        points, point_labels = colored_points(prompt_image)

    sam = sam_model_registry[args.model_type](checkpoint=None)
    model = LoRA_Sam(sam, 4)
    state = torch.load(args.weight, map_location="cpu", weights_only=True)
    state = {key.removeprefix("module."): value for key, value in state.items()}
    model.load_state_dict(state, strict=True)
    model.eval().to(args.device)

    transform_size = 224 if args.model_type == "vit_b" else 1024
    transform = ResizeLongestSide(transform_size)
    if args.tile_size:
        if not 0 <= args.tile_overlap < 1:
            raise ValueError("--tile-overlap must be in [0, 1)")
        tile_size = min(args.tile_size, *image.shape[:2])
        stride = max(1, round(tile_size * (1 - args.tile_overlap)))
        probability_sum = np.zeros(image.shape[:2], dtype=np.float32)
        probability_count = np.zeros(image.shape[:2], dtype=np.float32)
        for y in tile_positions(image.shape[0], tile_size, stride):
            for x in tile_positions(image.shape[1], tile_size, stride):
                tile = image[y : y + tile_size, x : x + tile_size]
                tile_probability = predict_probability(model, tile, transform, args.device)
                probability_sum[y : y + tile_size, x : x + tile_size] += tile_probability
                probability_count[y : y + tile_size, x : x + tile_size] += 1
        probability = probability_sum / probability_count
    else:
        if points != [[-100, -100]] or point_labels != [0]:
            original_size = tuple(image.shape[:2])
            image_tensor = torch.from_numpy(image.copy().transpose(2, 0, 1)[None]).float()
            point_tensor = torch.tensor([points], dtype=torch.float32)
            point_label_tensor = torch.tensor([point_labels], dtype=torch.float32)
            image_tensor = transform.apply_image_torch(image_tensor).to(args.device)
            point_tensor = transform.apply_coords_torch(point_tensor, original_size).to(args.device)
            point_label_tensor = point_label_tensor.to(args.device)
            with torch.inference_mode():
                output = model(image_tensor, original_size, point_tensor, point_label_tensor)
            probability = output[0, 0].float().cpu().numpy()
        else:
            probability = predict_probability(model, image, transform, args.device)
    mask = (probability > args.threshold).astype(np.uint8) * 255

    yellow = np.zeros_like(image)
    yellow[:, :, :2] = mask[:, :, None]
    overlay = ((image.astype(np.float32) + yellow) * 0.5).astype(np.uint8)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    np.save(args.output_dir / "probability.npy", probability.astype(np.float16))
    Image.fromarray(mask).save(args.output_dir / "mask.png")
    Image.fromarray(overlay).save(args.output_dir / "overlay.png")
    print(f"mask={args.output_dir / 'mask.png'}")
    print(f"overlay={args.output_dir / 'overlay.png'}")


if __name__ == "__main__":
    main()
