"""推理与样本数据端点：POST /api/infer、GET /api/samples/{sid}/layers、/volume/{n}。"""
import random
import time
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import SAMPLES_DIR
from app.models import registry
from app.taskdefs import BOUNDARIES

router = APIRouter(prefix="/api", tags=["infer"])


class InferRequest(BaseModel):
    task_id: str
    sample_id: str
    model: str = "ground-truth"


@router.post("/infer")
def infer(req: InferRequest) -> dict:
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
    latency_ms = int((time.perf_counter() - t0) * 1000)
    return {
        "task_id": req.task_id,
        "sample_id": req.sample_id,
        "model": req.model,
        "model_name": entry.name,
        "is_ground_truth": req.model == "ground-truth",
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
def sample_volume(sid: str, n: int) -> dict:
    """返回第 n 张 OCTA B-scan 及其对齐的 FAZ3D 标注切片 URL。"""
    if not 1 <= n <= 400:
        raise HTTPException(status_code=404, detail=f"切片编号 {n} 超出范围 (1..400)")
    sdir = SAMPLES_DIR / sid
    if not sdir.is_dir():
        raise HTTPException(status_code=404, detail=f"样本 {sid} 不存在")
    img = sdir / "vol" / f"{n:03d}.jpg"
    if not img.is_file():
        raise HTTPException(status_code=404, detail=f"切片 {n} 不存在（数据可能未就绪）")
    label = sdir / "lab" / f"{n:03d}.png"
    return {
        "n": n,
        "input": f"/data/samples/{sid}/vol/{n:03d}.jpg",
        "label": f"/data/samples/{sid}/lab/{n:03d}.png" if label.is_file() else None,
    }
