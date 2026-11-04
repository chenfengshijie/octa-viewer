"""用户标注存储层：data/annotations/{sid}/{task_id}/{username}/。

存储模型为「每人一个完整版本」：首次保存时从 GT 完整 fork（保持与 GT 相同的文件布局，
mask_*.png / lab/*.png），之后每次保存只覆盖被编辑的文件。原始 GT 永远只读。
目录布局被 /data 静态挂载覆盖，标注 PNG 可直接以 URL 访问。
"""
import base64
import binascii
import json
import shutil
import time
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

from app.config import DATA_DIR, SAMPLES_DIR
from app.taskdefs import TASK_MAP

ANNOTATIONS_DIR = DATA_DIR / "annotations"

# 各标注任务的单类掩膜尺寸 (w, h)；faz3d 的切片与 B-scan 同尺寸
MASK_SIZES: dict[str, tuple[int, int]] = {
    "vessel": (400, 400),
    "faz": (400, 400),
    "faz3d": (400, 640),
}
# 支持标注编辑的任务（layers 为曲线回归，不在画笔编辑范围）
EDITABLE_TASKS = {"vessel", "faz", "faz3d"}

MAX_MASK_B64_BYTES = 4 * 1024 * 1024  # 单张掩膜 base64 上限（400x640 二值 PNG 远小于此）


class AnnotationError(ValueError):
    """标注数据不合法或任务/样本不支持等业务错误。"""


def _check_sample_task(sid: str, task_id: str) -> None:
    if task_id not in EDITABLE_TASKS or task_id not in TASK_MAP:
        raise AnnotationError(f"任务 {task_id} 不支持标注编辑")
    if not (SAMPLES_DIR / sid).is_dir():
        raise AnnotationError(f"样本 {sid} 不存在")


def task_class_keys(task_id: str) -> list[str]:
    return [c["key"] for c in TASK_MAP[task_id]["classes"]]


def annotation_dir(sid: str, task_id: str, username: str) -> Path:
    return ANNOTATIONS_DIR / sid / task_id / username


def has_annotation(sid: str, task_id: str, username: str) -> bool:
    return (annotation_dir(sid, task_id, username) / "meta.json").is_file()


def get_meta(sid: str, task_id: str, username: str) -> dict | None:
    try:
        meta = json.loads((annotation_dir(sid, task_id, username) / "meta.json").read_text(encoding="utf-8"))
        return meta if isinstance(meta, dict) else None
    except (OSError, ValueError):
        return None


def list_annotators(sid: str, task_id: str) -> list[dict]:
    """列出该样本+任务下所有标注者（按最近保存时间倒序）。"""
    base = ANNOTATIONS_DIR / sid / task_id
    if not base.is_dir():
        return []
    out: list[dict] = []
    for meta_file in base.glob("*/meta.json"):
        meta = get_meta(sid, task_id, meta_file.parent.name)
        if meta:
            out.append({
                "username": meta.get("username", meta_file.parent.name),
                "created_at": meta.get("created_at"),
                "updated_at": meta.get("updated_at"),
                "n_saves": meta.get("n_saves", 0),
            })
    out.sort(key=lambda m: m.get("updated_at") or "", reverse=True)
    return out


# ---------------------------------------------------------------- 掩膜解码
def decode_mask(b64_png: str, size: tuple[int, int]) -> np.ndarray:
    """base64 PNG -> 0/255 uint8 掩膜。非法输入抛 AnnotationError。"""
    if not isinstance(b64_png, str) or not b64_png:
        raise AnnotationError("掩膜数据为空")
    if len(b64_png) > MAX_MASK_B64_BYTES:
        raise AnnotationError("掩膜数据过大")
    try:
        raw = base64.b64decode(b64_png, validate=True)
        with Image.open(BytesIO(raw)) as im:
            arr = np.array(im.convert("L"))
    except (binascii.Error, OSError, ValueError) as exc:
        raise AnnotationError("掩膜不是合法的 PNG 图像") from exc
    if arr.shape != (size[1], size[0]):
        raise AnnotationError(f"掩膜尺寸应为 {size[0]}×{size[1]}，实际为 {arr.shape[1]}×{arr.shape[0]}")
    return np.where(arr > 0, np.uint8(255), np.uint8(0))


# ---------------------------------------------------------------- fork 与保存
def _fork_from_gt(sid: str, task_id: str, dest: Path) -> None:
    """把 GT 掩膜复制为用户的初始版本（缺失的 GT 掩膜以全黑图占位）。"""
    dest.mkdir(parents=True, exist_ok=True)
    sdir = SAMPLES_DIR / sid
    size = MASK_SIZES[task_id]
    if task_id == "faz3d":
        lab_src, lab_dst = sdir / "lab", dest / "lab"
        lab_dst.mkdir(parents=True, exist_ok=True)
        if lab_src.is_dir():
            for f in lab_src.glob("*.png"):
                shutil.copyfile(f, lab_dst / f.name)
        return
    for key in task_class_keys(task_id):
        src, dst = sdir / f"mask_{key}.png", dest / f"mask_{key}.png"
        if src.is_file():
            shutil.copyfile(src, dst)
        else:  # GT 缺失时以全黑掩膜占位，保证版本目录完整
            Image.fromarray(np.zeros((size[1], size[0]), np.uint8)).save(dst)


def save_annotation(
    sid: str,
    task_id: str,
    username: str,
    masks: dict[str, str | None] | None = None,
    slices: dict[str, str] | None = None,
) -> dict:
    """保存用户的标注版本：首次自动 fork GT，再应用本次编辑的掩膜/切片。

    masks: 类别 key -> base64 PNG（null 表示删除该类掩膜，即用户清空了该类）。
    slices: 切片号("1".."400") -> base64 PNG。
    返回更新后的 meta。
    """
    _check_sample_task(sid, task_id)
    if task_id == "faz3d":
        if not slices:
            raise AnnotationError("缺少切片数据")
    elif not masks:
        raise AnnotationError("缺少掩膜数据")

    udir = annotation_dir(sid, task_id, username)
    if not has_annotation(sid, task_id, username):
        _fork_from_gt(sid, task_id, udir)
    udir.mkdir(parents=True, exist_ok=True)

    size = MASK_SIZES[task_id]
    if task_id == "faz3d":
        lab = udir / "lab"
        lab.mkdir(exist_ok=True)
        for n_text, b64 in slices.items():
            try:
                n = int(n_text)
            except (TypeError, ValueError) as exc:
                raise AnnotationError(f"非法切片号 {n_text!r}") from exc
            if not 1 <= n <= 400:
                raise AnnotationError(f"切片号 {n} 超出范围 (1..400)")
            if b64 is None:  # 用户清空该切片 -> 删除，展示时回退为 GT 切片
                (lab / f"{n:03d}.png").unlink(missing_ok=True)
                continue
            arr = decode_mask(b64, size)
            Image.fromarray(arr).save(lab / f"{n:03d}.png")
    else:
        valid_keys = task_class_keys(task_id)
        for key, b64 in masks.items():
            if key not in valid_keys:
                raise AnnotationError(f"任务 {task_id} 不含类别 {key!r}")
            target = udir / f"mask_{key}.png"
            if b64 is None:
                target.unlink(missing_ok=True)  # 用户清空该类 -> 删除掩膜
                continue
            arr = decode_mask(b64, size)
            Image.fromarray(arr).save(target)

    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    old = get_meta(sid, task_id, username)
    meta = {
        "username": username,
        "sample_id": sid,
        "task_id": task_id,
        "base": "ground-truth",
        "created_at": old.get("created_at") if old else now,
        "updated_at": now,
        "n_saves": (old.get("n_saves", 0) if old else 0) + 1,
    }
    (udir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    # 用户的 faz 彩色预测缓存按 n_saves 版本化，这里清掉旧版本避免堆积
    from app.config import CACHE_DIR
    for stale in CACHE_DIR.glob(f"{sid}/faz_pred_{username}_*.png"):
        stale.unlink(missing_ok=True)
    return meta


def delete_annotation(sid: str, task_id: str, username: str) -> bool:
    """删除用户的标注版本（恢复为原始 GT）。返回是否存在过。"""
    _check_sample_task(sid, task_id)
    udir = annotation_dir(sid, task_id, username)
    if not udir.is_dir():
        return False
    shutil.rmtree(udir, ignore_errors=True)
    from app.config import CACHE_DIR
    for stale in CACHE_DIR.glob(f"{sid}/faz_pred_{username}_*.png"):
        stale.unlink(missing_ok=True)
    return True
