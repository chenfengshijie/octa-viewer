import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter, median_filter


def normalize(image):
    low, high = np.percentile(image, (1, 99.5))
    if high <= low:
        return np.zeros(image.shape, dtype=np.uint8)
    image = np.clip((image - low) / (high - low), 0, 1)
    return np.rint(image * 255).astype(np.uint8)


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
    opl = gaussian_filter(median_filter(opl, size=(7, 17)), sigma=(1.5, 4.0))
    margin = np.maximum(5, 0.15 * thickness)
    opl = np.clip(opl, ilm + margin, bm - margin)
    return opl, bm


def surfaces_from_nnunet(oct_volume, segmentation_dir, sid):
    height, depth, width = oct_volume.shape
    ilm = np.empty((height, width), dtype=np.float32)
    bm = np.empty_like(ilm)
    x_all = np.arange(width)
    for y in range(height):
        path = segmentation_dir / f"{sid}-{y:04d}.png"
        mask = np.asarray(Image.open(path)) > 0
        if mask.shape != (depth, width):
            raise ValueError(f"{path}: expected {(depth, width)}, got {mask.shape}")
        valid = mask.any(axis=0)
        if valid.sum() < 2:
            raise ValueError(f"{path}: too few segmented columns")
        top = np.argmax(mask, axis=0)
        bottom = np.empty(width, dtype=np.int32)
        for x in np.flatnonzero(valid):
            tail = mask[top[x] :, x]
            gaps = np.flatnonzero(~tail)
            bottom[x] = top[x] + (int(gaps[0]) if gaps.size else tail.size)
        ilm[y] = np.interp(x_all, x_all[valid], top[valid])
        bm[y] = np.interp(x_all, x_all[valid], bottom[valid])
    ilm = gaussian_filter(median_filter(ilm, size=(7, 17)), sigma=(1.5, 4.0))
    bm = gaussian_filter(median_filter(bm, size=(7, 17)), sigma=(1.5, 4.0))
    opl, bm = estimate_opl(oct_volume, ilm, bm)
    return tuple(np.rint(s).astype(np.int16) for s in (ilm, opl, bm))


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


def project(oct_volume, octa_volume, segments, sid, case_dir):
    case_dir.mkdir()
    surfaces = surfaces_from_nnunet(oct_volume, segments, sid)
    ilm, opl, bm = surfaces
    shallow = variable_projection(octa_volume, ilm, opl)
    deep = variable_projection(octa_volume, opl, bm)
    full = variable_projection(octa_volume, ilm, bm)
    composite = np.stack((deep, shallow, full), axis=2)
    Image.fromarray(deep).save(case_dir / "OCTA_OPL_BM.png")
    Image.fromarray(shallow).save(case_dir / "OCTA_ILM_OPL.png")
    Image.fromarray(full).save(case_dir / "OCTA_FULL.png")
    Image.fromarray(composite).save(case_dir / "input.png")
    np.savez_compressed(case_dir / "surfaces.npz", ilm=ilm, opl=opl, bm=bm)
    save_qc(oct_volume, surfaces, case_dir / "oct_boundaries_qc.png")
