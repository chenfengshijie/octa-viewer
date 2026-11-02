"""全局路径与物理常量配置。"""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent  # backend/
DATA_DIR = BASE_DIR / "data"
SAMPLES_DIR = DATA_DIR / "samples"
CACHE_DIR = DATA_DIR / "cache"
INDEX_FILE = DATA_DIR / "index.json"

# 前端构建产物（存在则挂到 / 并做 SPA fallback）
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"

# ---- 物理尺度换算 ----
# enface 6mm FOV / 400px -> 每像素 0.015mm
PIXEL_MM = 0.015
# FAZ 面积：像素数 x 单像素面积(mm^2)
PIXEL_AREA_MM2 = PIXEL_MM * PIXEL_MM  # 0.000225
# FAZ 3D：x/y 向 0.015mm，z 向按 640 采样覆盖约 2mm 深度 -> 单体素 0.003125 mm^3
VOXEL_MM3 = 0.003125

# 体数据维度
VOLUME_INFO = {"n_slices": 400, "depth": 640, "width": 400}
