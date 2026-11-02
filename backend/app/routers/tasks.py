"""GET /api/tasks、/api/samples、/api/models 元信息端点。"""
import json

from fastapi import APIRouter

from app.config import INDEX_FILE
from app.models import registry
from app.taskdefs import TASKS

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/tasks")
def get_tasks() -> dict:
    return {"tasks": TASKS}


@router.get("/samples")
def get_samples() -> dict:
    """样本列表；data 缺失或 index.json 损坏时返回空列表。"""
    try:
        samples = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"samples": []}
    return {"samples": samples}


@router.get("/models")
def get_models() -> dict:
    return {"models": registry.list_models()}
