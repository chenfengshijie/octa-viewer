"""OCTA-500 展示平台 FastAPI 后端。

系统设计：陈峰 / 王越琛 / 钟洺生
启动： python -m uvicorn app.main:app --port 8017
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from app.public_data import PublicData

from app.config import DATA_DIR, FRONTEND_DIST
from app.routers import (
    annotations,
    auth,
    hit,
    hit_measurements,
    hit_qc,
    hit_research,
    hit_reviews,
    hit_spatial,
    infer,
    tasks,
)

app = FastAPI(title="OCTA-500 展示平台", version="0.1.0")

# CORS 全开（开发期 vite 走代理，这里兜底）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 数据目录静态挂载（prep_data.py 的产物；目录不存在则先建，保证启动不报错）
DATA_DIR.mkdir(parents=True, exist_ok=True)


app.mount("/data", PublicData(directory=DATA_DIR), name="data")

app.include_router(tasks.router)
app.include_router(hit.router)
app.include_router(hit_reviews.router)
app.include_router(hit_qc.router)
app.include_router(hit_spatial.router)
app.include_router(hit_measurements.router)
app.include_router(hit_research.router)
app.include_router(infer.router)
app.include_router(auth.router)
app.include_router(annotations.router)


# ---- 前端构建产物存在时挂到 / ，未知路径 SPA fallback 到 index.html ----
_index_html = FRONTEND_DIST / "index.html"
if _index_html.is_file():
    _dist = FRONTEND_DIST.resolve()

    @app.get("/", include_in_schema=False)
    def spa_root() -> FileResponse:
        return FileResponse(_index_html)

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        try:
            candidate = (FRONTEND_DIST / full_path).resolve()
            candidate.relative_to(_dist)  # 防目录穿越
        except ValueError:
            candidate = _index_html
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_index_html)  # 前端路由兜底
