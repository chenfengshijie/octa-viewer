"""任务与类别定义（API 契约的静态部分，routers 与 models 共用）。"""

# ---- 类别元数据 ----
CLASSES: dict[str, dict] = {
    "artery": {"key": "artery", "name": "动脉", "color": "#ef4444"},
    "vein": {"key": "vein", "name": "静脉", "color": "#3b82f6"},
    "capillary": {"key": "capillary", "name": "毛细血管", "color": "#22c55e"},
    "largevessel": {"key": "largevessel", "name": "大血管", "color": "#f59e0b"},
    "faz": {"key": "faz", "name": "FAZ", "color": "#a855f7"},
}

BOUNDARIES: list[dict] = [
    {"key": "b0", "name": "边界 1 (ILM)", "color": "#ef4444"},
    {"key": "b1", "name": "边界 2", "color": "#f59e0b"},
    {"key": "b2", "name": "边界 3", "color": "#22c55e"},
    {"key": "b3", "name": "边界 4", "color": "#06b6d4"},
    {"key": "b4", "name": "边界 5", "color": "#6366f1"},
    {"key": "b5", "name": "边界 6 (BM)", "color": "#ec4899"},
]


def _classes(*keys: str) -> list[dict]:
    return [CLASSES[k] for k in keys]


# ---- 任务列表（GET /api/tasks 的内容） ----
TASKS: list[dict] = [
    {
        "id": "vessel", "name": "血管分割", "en": "Vessel Segmentation",
        "desc": "在 enface OCTA 投影图上逐像素分割动脉/静脉/毛细血管/大血管网络",
        "input": "enface 投影图 400×400",
        "classes": _classes("artery", "vein", "capillary", "largevessel", "faz"),
        "thumb": "/data/thumb_vessel.png",
    },
    {
        "id": "faz", "name": "FAZ 分割", "en": "FAZ Segmentation",
        "desc": "分割中央凹无血管区（Foveal Avascular Zone），其面积与直径是糖尿病视网膜病变的重要生物标志物",
        "input": "enface 投影图 400×400",
        "classes": _classes("faz"),
        "thumb": "/data/thumb_faz.png",
    },
    {
        "id": "layers", "name": "视网膜分层", "en": "Layer Segmentation",
        "desc": "在 B-scan 断层上回归 6 条视网膜内界膜(ILM)至布鲁赫膜(BM)之间的层边界曲线",
        "input": "OCTA B-scan 400×640",
        "classes": list(BOUNDARIES),
        "thumb": "/data/thumb_layers.png",
    },
    {
        "id": "faz3d", "name": "FAZ 3D 体分割", "en": "Volumetric FAZ",
        "desc": "对 OCTA 三维体数据（400×640×400）逐体素标注 FAZ 区域",
        "input": "OCTA 体数据 400 B-scans",
        "classes": _classes("faz"),
        "thumb": "/data/thumb_faz3d.png",
    },
]

TASK_MAP: dict[str, dict] = {t["id"]: t for t in TASKS}

# layers 任务代表 B-scan 编号（不带后缀）
LAYER_BSCANS: list[str] = ["001", "080", "160", "240", "320", "400"]

# cavf.png 官方 5 类合并标签 -> 颜色
CAVF_PALETTE: dict[int, str] = {
    1: "#22c55e",  # 毛细血管
    2: "#ef4444",  # 动脉
    3: "#3b82f6",  # 静脉
    4: "#a855f7",  # FAZ
}
