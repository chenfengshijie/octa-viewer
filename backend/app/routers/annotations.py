"""标注编辑端点：查看标注者列表 / 保存我的标注 / 删除我的标注。"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import annotations as ann
from app.auth import require_user

router = APIRouter(prefix="/api", tags=["annotations"])


class AnnotationPayload(BaseModel):
    """保存请求体：vessel/faz 用 masks，faz3d 用 slices；值为 base64 PNG，null = 删除该文件。"""

    masks: dict[str, str | None] | None = None
    slices: dict[str, str | None] | None = None


def _apply(exc: ann.AnnotationError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@router.get("/annotations/{sid}/{task_id}")
def list_annotations(sid: str, task_id: str) -> dict:
    """该样本+任务下的全部标注版本（公开只读）。"""
    try:
        ann._check_sample_task(sid, task_id)
    except ann.AnnotationError as exc:
        raise _apply(exc) from exc
    return {"sample_id": sid, "task_id": task_id, "annotators": ann.list_annotators(sid, task_id)}


@router.get("/annotations/{sid}/{task_id}/mine")
def my_annotation(sid: str, task_id: str, user: dict = Depends(require_user)) -> dict:
    """当前用户的标注 meta（无则返回 has: false）。"""
    meta = ann.get_meta(sid, task_id, user["username"])
    return {"has": meta is not None, "meta": meta}


@router.put("/annotations/{sid}/{task_id}")
def save_annotation(sid: str, task_id: str, payload: AnnotationPayload, user: dict = Depends(require_user)) -> dict:
    try:
        meta = ann.save_annotation(sid, task_id, user["username"], payload.masks, payload.slices)
    except ann.AnnotationError as exc:
        raise _apply(exc) from exc
    return {"ok": True, "meta": meta}


@router.delete("/annotations/{sid}/{task_id}")
def delete_annotation(sid: str, task_id: str, user: dict = Depends(require_user)) -> dict:
    existed = ann.delete_annotation(sid, task_id, user["username"])
    return {"ok": True, "deleted": existed}
