"""One-off asset extraction from the OCTA-500 dataset into backend/data/.

Produces a self-contained bundle so the deployed app never needs the
original dataset. 6 eyes from the 6mm subset covering all disease types.

Run:  python -I prep_data.py
"""
import json
import os
from pathlib import Path

import h5py
import numpy as np
import openpyxl
from PIL import Image

DATASET = Path(r"E:\Datasets\OCTA\OCTA_6mm")
LABELS = Path(r"E:\Datasets\OCTA\Label")
OUT = Path(__file__).resolve().parent / "data"

# ---------------------------------------------------------------- eye selection
def read_metadata():
    wb = openpyxl.load_workbook(DATASET / "Text labels.xlsx", read_only=True)
    ws = wb.active
    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        if isinstance(r[0], int):
            rows.append({"id": str(r[0]), "sex": r[1], "eye": r[2], "age": r[3], "disease": r[4]})
    return rows


def select_eyes(rows, per_class=(2, 2, 1, 1)):
    """2 NORMAL, 2 DR, 1 CNV, 1 OTHERS — first ids in file order."""
    want = dict(zip(("NORMAL", "DR", "CNV", "OTHERS"), per_class))
    got = {k: [] for k in want}
    for r in rows:
        d = r["disease"]
        if d in got and len(got[d]) < want[d]:
            got[d].append(r)
    picked = [r for k in ("NORMAL", "DR", "CNV", "OTHERS") for r in got[k]]
    return picked


# ---------------------------------------------------------------- helpers
def save_gray(arr, path):
    Image.fromarray(arr.astype(np.uint8)).save(path)


def ncc(a, b):
    a = a - a.mean(); b = b - b.mean()
    d = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / d) if d > 0 else 0.0


OPS2 = {
    "id": lambda x: x,
    "f0": lambda x: x[::-1, :],
    "f1": lambda x: x[:, ::-1],
    "f01": lambda x: x[::-1, ::-1],
    "T": lambda x: x.T,
    "Tf0": lambda x: x.T[::-1, :],
    "Tf1": lambda x: x.T[:, ::-1],
    "Tf01": lambda x: x.T[::-1, ::-1],
}
ALIGN_OP = "f01"  # 6 眼聚合票选（FAZ 近中心团块，逐眼信号不可分辨，数据集约定统一）
OPS3 = {
    "id": lambda x: x,
    "f0": lambda x: np.flip(x, 0),
    "f1": lambda x: np.flip(x, 1),
    "f01": lambda x: np.flip(np.flip(x, 0), 1),
    "T": lambda x: x.transpose(1, 0, 2),
    "Tf0": lambda x: np.flip(x.transpose(1, 0, 2), 0),
    "Tf1": lambda x: np.flip(x.transpose(1, 0, 2), 1),
    "Tf01": lambda x: np.flip(np.flip(x.transpose(1, 0, 2), 1), 0),
}


def align_faz3d(label, proj_bmp):
    """Return label reoriented to the BMP volume frame (row=B-scan y, col=x, depth=640).

    proj_bmp: (400,400) enface projection of the OCTA BMP stack (row=y, col=x).
    """
    lab = np.asarray(label, dtype=np.uint8)
    if lab.shape[2] == 640:          # (x,y,z) as stored by h5py for 6mm eyes
        pass
    elif lab.shape[0] == 640:        # (z,y,x)
        lab = lab.transpose(2, 1, 0)
    else:
        raise ValueError(f"unexpected FAZlabel shape {lab.shape}")
    proj2 = lab.mean(axis=2).astype(np.float32)  # (x,y) enface
    pb = proj_bmp.astype(np.float32)
    best_name, score = "id", -2.0
    for name, op in OPS2.items():
        s = ncc(op(proj2), pb)
        if s > score:
            best_name, score = name, s
    return OPS3[best_name](lab), best_name, score


# ---------------------------------------------------------------- per-eye bundle
def bundle(meta):
    sid = meta["id"]
    sdir = OUT / "samples" / sid
    (sdir / "vol").mkdir(parents=True, exist_ok=True)
    (sdir / "lab").mkdir(parents=True, exist_ok=True)

    # inputs: enface projections
    proj_octa = np.array(Image.open(DATASET / "Projection Maps" / "OCTA(FULL)" / f"{sid}.bmp").convert("L"))
    proj_oct = np.array(Image.open(DATASET / "Projection Maps" / "OCT(FULL)" / f"{sid}.bmp").convert("L"))
    save_gray(proj_octa, sdir / "proj_octa.png")
    save_gray(proj_oct, sdir / "proj_oct.png")

    # masks (binary 0/255)
    masks = {}
    for cls in ("Artery", "Vein", "Capillary", "LargeVessel", "FAZ"):
        m = np.array(Image.open(LABELS / f"GT_{cls}" / f"{sid}.bmp").convert("L"))
        save_gray(m, sdir / f"mask_{cls.lower()}.png")
        masks[cls.lower()] = m
    # 5-class combined map (official baseline label format 0..4)
    cavf = np.array(Image.open(LABELS / "GT_CAVF" / f"{sid}.bmp").convert("L"))
    save_gray(cavf, sdir / "cavf.png")

    # layer boundaries
    import scipy.io as sio
    layer = sio.loadmat(LABELS / "GT_Layers" / f"{sid}.mat")["Layer"]  # (6,400,400) uint16
    np.save(sdir / "layers.npy", layer.astype(np.uint16))

    # volume: 400 OCTA B-scans as JPEG + FAZ3D label slices aligned to BMP frame
    for n in range(1, 401):
        img = np.array(Image.open(DATASET / "OCTA" / sid / f"{n}.bmp").convert("L"))
        Image.fromarray(img).save(sdir / "vol" / f"{n:03d}.jpg", quality=85)

    with h5py.File(LABELS / "GT_FAZ3D" / f"{sid}.mat", "r") as f:
        raw = f["FAZlabel"][:]  # ~102 MB uint8
    # FAZ 是近中心小团块，逐眼 NCC 无取向分辨力（实测 8 取向差 <0.03）；
    # 数据集导出约定统一，采用 6 眼聚合票选的固定取向 f01（翻转两轴）。
    lab3, op_name, score = OPS3[ALIGN_OP](np.asarray(raw, np.uint8)), ALIGN_OP, float("nan")
    del raw
    for n in range(400):
        sl = lab3[:, n, :].T  # -> (depth 640, x 400) matching BMP B-scan orientation
        save_gray(sl * 255, sdir / "lab" / f"{n + 1:03d}.png")

    # representative B-scans for the layer task
    for n in (1, 80, 160, 240, 320, 400):
        Image.fromarray(np.array(Image.open(DATASET / "OCTA" / sid / f"{n}.bmp").convert("L"))).save(
            sdir / f"bscan_{n:03d}.png")

    (sdir / "meta.json").write_text(json.dumps(
        {**meta, "volume": {"n_slices": 400, "depth": 640, "width": 400, "faz3d_align": op_name,
                            "align_ncc": round(score, 4)}},
        ensure_ascii=False, indent=1), encoding="utf-8")
    return {"id": sid, "disease": meta["disease"], "sex": meta["sex"], "eye": meta["eye"], "age": meta["age"]}


def main():
    OUT.mkdir(exist_ok=True)
    rows = read_metadata()
    eyes = select_eyes(rows)
    print("selected:", [e["id"] for e in eyes])
    index = [bundle(m) for m in eyes]
    (OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")

    # home page thumbnails (from the first sample)
    first = OUT / "samples" / index[0]["id"]
    thumbs = {
        "thumb_vessel.png": "proj_octa.png",
        "thumb_faz.png": "mask_faz.png",
        "thumb_layers.png": "bscan_160.png",
        "thumb_faz3d.png": "proj_octa.png",
    }
    for dst, src in thumbs.items():
        Image.open(first / src).resize((220, 220)).save(OUT / dst)
    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"bundle complete: {len(index)} eyes, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
