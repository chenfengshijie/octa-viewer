"""Ground Truth（数据自带标注）的“推理”实现与指标计算。

所有读取都对数据缺失/部分生成保持容忍：对应指标 value 返回 null，接口不报错。
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

from app.config import CACHE_DIR, PIXEL_AREA_MM2, VOXEL_MM3
from app.taskdefs import BOUNDARIES, CAVF_PALETTE, CLASSES, LAYER_BSCANS

FAZ_ALPHA = 160  # faz 预测图的紫色半透明度


# ---------------------------------------------------------------- 基础 IO
def _load_gray(path: Path) -> np.ndarray | None:
    """读灰度图，缺失或损坏返回 None。"""
    try:
        with Image.open(path) as im:
            return np.array(im.convert("L"))
    except (OSError, ValueError):
        return None


def _load_mask(sdir: Path, key: str) -> np.ndarray | None:
    """读 0/255 二值掩膜，返回布尔数组。"""
    arr = _load_gray(sdir / f"mask_{key}.png")
    return None if arr is None else arr > 0


def _hex_rgb(color: str) -> tuple[int, int, int]:
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))  # type: ignore[return-value]


def _colorize(indexed: np.ndarray, palette: dict[int, str], alpha: int = 255) -> Image.Image:
    """索引标签图 -> RGBA 彩色图，未命中像素全透明。"""
    out = np.zeros((*indexed.shape, 4), np.uint8)
    for v, color in palette.items():
        m = indexed == v
        if m.any():
            out[m, :3] = _hex_rgb(color)
            out[m, 3] = alpha
    return Image.fromarray(out, "RGBA")


def _save_cache_png(sid: str, name: str, img: Image.Image) -> str:
    """写入（或复用）data/cache/{sid}/ 下的预测图，返回静态 URL。"""
    cdir = CACHE_DIR / sid
    cdir.mkdir(parents=True, exist_ok=True)
    path = cdir / name
    if not path.exists():
        img.save(path)
    return f"/data/cache/{sid}/{name}"


def _metric(key: str, label: str, value, unit: str) -> dict:
    return {"key": key, "label": label, "value": value, "unit": unit}


# ---------------------------------------------------------------- 各任务实现
# vessel 任务覆盖的 5 个类别（顺序即 overlays 顺序）
VESSEL_CLASSES: list[dict] = [
    CLASSES["artery"], CLASSES["vein"], CLASSES["capillary"],
    CLASSES["largevessel"], CLASSES["faz"],
]


def _vessel(sdir: Path, sid: str, mask_dir: Path | None = None, mask_url_base: str | None = None,
            cache_tag: str | None = None) -> dict:
    """mask_dir 非空时读用户标注版本（缺文件的类别不下发）；cavf 等辅助文件仍读原样本目录。"""
    mdir = mask_dir or sdir
    ubase = mask_url_base or f"/data/samples/{sid}"
    user_version = mask_dir is not None
    overlays: list[dict] = []
    metrics: list[dict] = []
    union: np.ndarray | None = None  # 全血管（含毛细，不含 FAZ）
    for c in VESSEL_CLASSES:
        m = _load_mask(mdir, c["key"])
        if m is not None or not user_version:  # 用户版本中被清空的类别不再下发叠加层（指标保留）
            overlays.append({**c, "mask_url": f"{ubase}/mask_{c['key']}.png"})
        value = None
        if m is not None:
            value = round(float(np.count_nonzero(m)) / m.size * 100, 2)
            if c["key"] != "faz":
                union = m if union is None else (union | m)
        metrics.append(_metric(f"{c['key']}_density", f"{c['name']}密度", value, "%"))
    total = None
    if union is not None:
        total = round(float(np.count_nonzero(union)) / union.size * 100, 2)
    metrics.append(_metric("vessel_density", "全血管密度", total, "%"))

    pred_url = None
    if not user_version:  # 用户版本不生成 cavf 彩色图（前端未使用，且与用户掩膜无关）
        cavf = _load_gray(sdir / "cavf.png")
        if cavf is not None:
            pred_url = _save_cache_png(sid, "vessel_pred.png", _colorize(cavf, CAVF_PALETTE))
    return {"overlays": overlays, "prediction_url": pred_url, "metrics": metrics, "extra": {}}


def _faz(sdir: Path, sid: str, mask_dir: Path | None = None, mask_url_base: str | None = None,
         cache_tag: str | None = None) -> dict:
    mdir = mask_dir or sdir
    ubase = mask_url_base or f"/data/samples/{sid}"
    user_version = mask_dir is not None
    faz = CLASSES["faz"]
    metrics: list[dict] = []
    pred_url = None
    m = _load_mask(mdir, "faz")
    if m is None and user_version:
        overlays: list[dict] = []  # 用户清空了 FAZ 掩膜
    else:
        overlays = [{**faz, "mask_url": f"{ubase}/mask_faz.png"}]
    if m is not None:
        count = int(np.count_nonzero(m))
        area = count * PIXEL_AREA_MM2
        diameter = 2000.0 * math.sqrt(count / math.pi) * 0.015  # 等效圆直径 -> µm
        metrics.append(_metric("faz_area", "FAZ 面积", round(area, 4), "mm²"))
        metrics.append(_metric("faz_diameter", "FAZ 等效直径", round(diameter, 1), "µm"))
        if not user_version:
            pred_url = _save_cache_png(
                sid, "faz_pred.png",
                _colorize(m.astype(np.uint8), {1: faz["color"]}, alpha=FAZ_ALPHA))
    else:
        metrics.append(_metric("faz_area", "FAZ 面积", None, "mm²"))
        metrics.append(_metric("faz_diameter", "FAZ 等效直径", None, "µm"))
    return {"overlays": overlays, "prediction_url": pred_url, "metrics": metrics, "extra": {}}


def _layers(sdir: Path, sid: str, mask_dir: Path | None = None, mask_url_base: str | None = None,
            cache_tag: str | None = None) -> dict:
    metrics: list[dict] = []
    arr = None
    try:
        arr = np.load(sdir / "layers.npy")
    except (OSError, ValueError):
        pass
    if arr is not None:
        for i, b in enumerate(BOUNDARIES):
            mean_depth = round(float(arr[i].astype(np.float64).mean()), 2)
            metrics.append(_metric(f"b{i}_depth", f"边界 {i + 1} 平均深度", mean_depth, "px"))
    else:
        for i, b in enumerate(BOUNDARIES):
            metrics.append(_metric(f"b{i}_depth", f"边界 {i + 1} 平均深度", None, "px"))
    return {
        "overlays": [],
        "prediction_url": None,
        "metrics": metrics,
        "extra": {"bscans": LAYER_BSCANS},
    }


def _faz3d(sdir: Path, sid: str, mask_dir: Path | None = None, mask_url_base: str | None = None,
           cache_tag: str | None = None) -> dict:
    from app.config import VOLUME_INFO
    count = _faz3d_voxel_count(mask_dir or sdir, sid, cache_tag)
    value = None if count is None else round(count * VOXEL_MM3, 3)
    metrics = [_metric("faz_volume", "FAZ 体积", value, "mm³")]
    return {
        "overlays": [],
        "prediction_url": None,
        "metrics": metrics,
        "extra": {"volume": VOLUME_INFO},
    }


def _faz3d_voxel_count(base: Path, sid: str, cache_tag: str | None = None) -> int | None:
    """统计 lab/ 下全部切片的 FAZ 体素数；400 张齐全后结果缓存，避免每次读 400 个 PNG。

    base 为样本目录或用户标注目录；用户版本缓存文件名带 cache_tag（用户名_保存次数），
    与 GT 缓存互不污染。
    """
    lab = base / "lab"
    if not lab.is_dir():
        return None
    files = sorted(lab.glob("*.png"))
    if not files:
        return None
    cache_name = f"faz3d_count_{cache_tag}.json" if cache_tag else "faz3d_count.json"
    cache = CACHE_DIR / sid / cache_name
    complete = len(files) == 400
    if complete:  # 齐全后体素数不再变化，可直接复用缓存
        try:
            return int(json.loads(cache.read_text(encoding="utf-8"))["count"])
        except (OSError, ValueError, KeyError):
            pass
    count = 0
    for f in files:
        arr = _load_gray(f)
        if arr is not None:
            count += int(np.count_nonzero(arr > 0))
    if complete:
        try:
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps({"count": count}), encoding="utf-8")
        except OSError:
            pass
    return count


_DISPATCH = {"vessel": _vessel, "faz": _faz, "layers": _layers, "faz3d": _faz3d}


# ---------------------------------------------------------------- 统一入口
def predict(task_id: str, sample_dir: Path, sample_id: str, mask_dir: Path | None = None,
            mask_url_base: str | None = None, cache_tag: str | None = None) -> dict:
    """GT“推理”入口：返回 overlays / prediction_url / metrics / extra。

    签名与未来的 PyTorch predictor 保持一致。mask_dir / mask_url_base / cache_tag
    用于服务用户的标注版本（见 routers/infer.py）。
    """
    fn = _DISPATCH.get(task_id)
    if fn is None:
        raise ValueError(f"未知任务 {task_id}")
    return fn(sample_dir, sample_id, mask_dir=mask_dir, mask_url_base=mask_url_base, cache_tag=cache_tag)
