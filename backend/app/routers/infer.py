"""推理与样本数据端点：POST /api/infer、GET /api/samples/{sid}/layers、/volume/{n}。

登录用户若保存过标注版本，/api/infer 与 volume 端点会自动（或按 view_as/as_user 指定）
返回该用户的标注版本：叠加层指向其标注文件、指标按其掩膜重算，并以
is_edited / edited_by 标识。匿名或无标注版本时行为与原始 GT 完全一致。
"""
import random
import time
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import annotations as ann
from app import auth
from app.config import SAMPLES_DIR
from app.models import ground_truth, registry
from app.taskdefs import BOUNDARIES

router = APIRouter(prefix="/api", tags=["infer"])


class InferRequest(BaseModel):
    task_id: str
    sample_id: str
    model: str = "ground-truth"
    view_as: str | None = None  # 查看指定用户的标注版本（无版本则回落原始 GT）


def _resolve_target_user(view_as: str | None, user: dict | None) -> str | None:
    """确定要展示谁的标注版本。

    view_as 语义：''（或 null 且未登录）= 原始 GT；用户名 = 该用户的版本；
    None（未传）= 回落为当前登录用户的版本（兼容不带该字段的调用方）。
    """
    if view_as is not None:
        if view_as == "":
            return None
        try:
            auth.validate_username(view_as)
        except auth.UserError as exc:
            raise HTTPException(status_code=400, detail=f"非法用户名：{exc}") from exc
        return view_as
    return user["username"] if user else None


@router.post("/infer")
def infer(req: InferRequest, user: dict | None = Depends(auth.optional_user)) -> dict:
    from app.taskdefs import TASK_MAP  # 局部导入避免与 registry 的加载顺序纠缠

    t0 = time.perf_counter()

    task = TASK_MAP.get(req.task_id)
    if task is None:
        raise HTTPException(status_code=400, detail=f"未知任务 {req.task_id}")

    entry = registry.get_model(req.model)
    if entry is None or not entry.available:
        raise HTTPException(status_code=400, detail=f"模型 {req.model} 尚未接入")

    sdir = SAMPLES_DIR / req.sample_id
    if not sdir.is_dir():
        raise HTTPException(status_code=404, detail=f"样本 {req.sample_id} 不存在")

    time.sleep(random.uniform(0.4, 0.8))  # 人为延迟，模拟推理耗时

    result = registry.dispatch(req.model, req.task_id, sdir, req.sample_id)
    is_edited, edited_by = False, None
    target = _resolve_target_user(req.view_as, user)
    # 用户标注版本基于 GT fork，仅对 ground-truth 模型生效；未来模型 predictor 可按需接入
    if req.model == "ground-truth" and target and ann.has_annotation(req.sample_id, req.task_id, target):
        meta = ann.get_meta(req.sample_id, req.task_id, target)
        result = ground_truth.predict(
            req.task_id, sdir, req.sample_id,
            mask_dir=ann.annotation_dir(req.sample_id, req.task_id, target),
            mask_url_base=f"/data/annotations/{req.sample_id}/{req.task_id}/{target}",
            cache_tag=f"{target}_{meta.get('n_saves', 0)}" if meta else target,
        )
        is_edited, edited_by = True, target

    latency_ms = int((time.perf_counter() - t0) * 1000)
    return {
        "task_id": req.task_id,
        "sample_id": req.sample_id,
        "model": req.model,
        "model_name": entry.name,
        "is_ground_truth": req.model == "ground-truth",
        "is_edited": is_edited,
        "edited_by": edited_by,
        "latency_ms": latency_ms,
        "overlays": result["overlays"],
        "prediction_url": result["prediction_url"],
        "metrics": result["metrics"],
        "extra": result["extra"],
    }


@router.get("/samples/{sid}/layers")
def sample_layers(sid: str, y: int = 200) -> dict:
    """返回 enface 第 y 行处 6 条层边界的深度曲线。"""
    sdir = SAMPLES_DIR / sid
    if not sdir.is_dir():
        raise HTTPException(status_code=404, detail=f"样本 {sid} 不存在")
    y = max(0, min(399, y))

    arr = None
    try:
        arr = np.load(sdir / "layers.npy")  # (6,400,400) uint16
    except (OSError, ValueError):
        pass

    curves: list[dict] = []
    if arr is not None:
        row = arr[:, y, :]
        for i, b in enumerate(BOUNDARIES):
            curves.append({**b, "points": [int(v) for v in row[i]]})
    return {"y": y, "curves": curves}


@router.get("/samples/{sid}/volume/{n}")
def sample_volume(sid: str, n: int, as_user: str | None = None,
                  user: dict | None = Depends(auth.optional_user)) -> dict:
    """返回第 n 张 OCTA B-scan 及其对齐的 FAZ3D 标注切片 URL。

    as_user（或当前登录用户）存在 faz3d 标注版本时，label 指向其版本目录。
    """
    if not 1 <= n <= 400:
        raise HTTPException(status_code=404, detail=f"切片编号 {n} 超出范围 (1..400)")
    sdir = SAMPLES_DIR / sid
    if not sdir.is_dir():
        raise HTTPException(status_code=404, detail=f"样本 {sid} 不存在")
    img = sdir / "vol" / f"{n:03d}.jpg"
    if not img.is_file():
        raise HTTPException(status_code=404, detail=f"切片 {n} 不存在（数据可能未就绪）")

    label = sdir / "lab" / f"{n:03d}.png"
    label_url = f"/data/samples/{sid}/lab/{n:03d}.png" if label.is_file() else None
    target = _resolve_target_user(as_user, user)
    edited_by = None
    if target and ann.has_annotation(sid, "faz3d", target):
        ulabel = ann.annotation_dir(sid, "faz3d", target) / "lab" / f"{n:03d}.png"
        if ulabel.is_file():
            label_url = f"/data/annotations/{sid}/faz3d/{target}/lab/{n:03d}.png"
            edited_by = target
    return {
        "n": n,
        "input": f"/data/samples/{sid}/vol/{n:03d}.jpg",
        "label": label_url,
        "edited_by": edited_by,
    }
