import numpy as np
from PIL import Image, ImageDraw

from .artifacts import FILES, MODEL_CHANNELS
from .surfaces import surfaces_from_nnunet


def normalize(image):
    low, high = np.percentile(image, (1, 99.5))
    if high <= low:
        return np.zeros(image.shape, dtype=np.uint8)
    image = np.clip((image - low) / (high - low), 0, 1)
    return np.rint(image * 255).astype(np.uint8)


def variable_projection(octa_volume, top, bottom):
    height, _, width = octa_volume.shape
    output = np.empty((height, width), dtype=np.float32)
    for y in range(height):
        scan = np.asarray(octa_volume[y])
        for x in range(width):
            lo = int(top[y, x])
            hi = int(bottom[y, x])
            output[y, x] = np.percentile(scan[lo:hi, x], 98) if hi > lo else 0
    return normalize(output)


def save_qc(oct_volume, surfaces, output_path):
    ilm, opl, bm = surfaces
    ys = np.linspace(0, oct_volume.shape[0] - 1, 5, dtype=int)
    panels = []
    colors = ((0, 255, 255), (255, 215, 0), (255, 80, 80))
    for y in ys:
        scan = normalize(np.asarray(oct_volume[y], dtype=np.float32))
        panel = Image.fromarray(scan).convert("RGB")
        draw = ImageDraw.Draw(panel)
        for surface, color in zip((ilm, opl, bm), colors):
            points = [(x, int(surface[y, x])) for x in range(surface.shape[1])]
            draw.line(points, fill=color, width=2)
        panels.append(panel)
    canvas = Image.new("RGB", (panels[0].width * len(panels), panels[0].height))
    for index, panel in enumerate(panels):
        canvas.paste(panel, (index * panel.width, 0))
    canvas.save(output_path)


def project(oct_volume, octa_volume, segments, sid, job):
    """把解剖曲面投影到 OCTA。写出各层供复核，同时返回模型使用的 RGB 数组。"""
    surfaces = surfaces_from_nnunet(oct_volume, segments, sid)
    planes = {
        "shallow_projection": variable_projection(octa_volume, surfaces.ilm, surfaces.opl),
        "deep_projection": variable_projection(octa_volume, surfaces.opl, surfaces.bm),
        "full_projection": variable_projection(octa_volume, surfaces.ilm, surfaces.bm),
    }
    composite = np.stack([planes[key] for key in MODEL_CHANNELS], axis=2)
    (job / FILES["model_input"]).parent.mkdir()
    for key, plane in planes.items():
        Image.fromarray(plane).save(job / FILES[key])
    Image.fromarray(composite).save(job / FILES["model_input"])
    np.savez_compressed(job / FILES["surfaces"], **surfaces._asdict())
    save_qc(oct_volume, surfaces, job / FILES["boundary_qc"])
    return composite
