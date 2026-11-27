"""OCTA-500 展示平台 FastAPI 后端。

系统设计：陈峰 / 王越琛 / 钟洺生
启动： python -m uvicorn app.main:app --port 8017
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.responses import Response
from starlette.types import Scope

from app.config import DATA_DIR, FRONTEND_DIST
from app.routers import annotations, auth, infer, tasks

app = FastAPI(title="OCTA-500 展示平台", version="0.1.0")

# /data 静态服务白名单：只放行这三个子目录和顶层 thumb_* 文件。
# users.json / secret.key（认证数据，见 auth.py）也存放在 data/ 下，不在白名单内即不可被 URL 访问
_PUBLIC_DATA_DIRS = frozenset({"samples", "annotations", "cache"})
_PUBLIC_DATA_FILE_PREFIX = "thumb_"


class DataStaticFiles(StaticFiles):
    """data/ 的静态文件服务：路径白名单 + 用户标注禁用中间缓存。"""

    async def get_response(self, path: str, scope: Scope) -> Response:
        parts = [p for p in path.replace("\\", "/").split("/") if p]
        allowed = bool(parts) and (
            parts[0] in _PUBLIC_DATA_DIRS
            or (len(parts) == 1 and parts[0].startswith(_PUBLIC_DATA_FILE_PREFIX))
        )
        if not allowed:
            raise HTTPException(status_code=404)
        response = await super().get_response(path, scope)
        if parts[0] == "annotations":
            # 标注保存后原地覆盖、URL 不变：禁止 CDN / 浏览器直接复用旧图，每次按 ETag 回源校验
            response.headers["Cache-Control"] = "no-cache"
        return response


# CORS 全开（开发期 vite 走代理，这里兜底）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 数据目录静态挂载（prep_data.py 的产物；目录不存在则先建，保证启动不报错）
DATA_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/data", DataStaticFiles(directory=DATA_DIR), name="data")

app.include_router(tasks.router)
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
