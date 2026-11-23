"""Shared diagnostics for offline inspection. Payloads and review text stay out of reports."""

from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime
from hashlib import sha256
from io import BytesIO
import json
import math
from pathlib import PurePosixPath
import re
import sqlite3
from zipfile import BadZipFile

import numpy as np
from PIL import Image


class InvalidArtifact(ValueError):
    """The named object cannot satisfy its published contract."""


@dataclass
class Finding:
    item: str
    detail: str


@dataclass
class Report:
    kind: str
    input: str
    findings: list[Finding] = field(default_factory=list)
    facts: dict = field(default_factory=dict)
    checked: int = 0

    def problem(self, item, detail):
        self.findings.append(Finding(str(item), str(detail)))

    @contextmanager
    def inspect(self, item):
        self.checked += 1
        try:
            yield
        except (
            ValueError,
            OSError,
            KeyError,
            TypeError,
            EOFError,
            sqlite3.Error,
            BadZipFile,
        ) as exc:
            self.problem(item, exc)

    def output(self):
        return {"ok": not self.findings, **asdict(self)}

    def render(self):
        status = "通过" if not self.findings else "发现异常"
        lines = [f"{self.kind} · {status}", f"输入 {self.input}", f"检查项 {self.checked}"]
        lines.extend(f"{key}  {value}" for key, value in self.facts.items())
        lines.extend(f"[{row.item}] {row.detail}" for row in self.findings)
        return "\n".join(lines)


def require(condition, detail):
    if not condition:
        raise InvalidArtifact(detail)


def mapping(value, label):
    require(isinstance(value, dict), f"{label} 应是对象")
    return value


def string(value, label):
    require(isinstance(value, str) and bool(value.strip()), f"{label} 应为非空文本")
    return value


def finite(value, label, low=None, high=None):
    require(type(value) in (int, float) and math.isfinite(value), f"{label} 应是有限数值")
    if low is not None:
        require(value >= low, f"{label} 小于 {low}")
    if high is not None:
        require(value <= high, f"{label} 大于 {high}")
    return value


def integer(value, label, low=None, high=None):
    require(type(value) is int, f"{label} 应是整数")
    return finite(value, label, low, high)


def identifier(value, label):
    require(
        isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}", value),
        f"{label} 格式错误",
    )
    return value


def snapshot_id(value, label):
    require(
        isinstance(value, str) and re.fullmatch(r"[0-9a-f]{32}", value),
        f"{label} 应是版本或轮次标识",
    )
    return value


def digest(value, label):
    require(
        isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), f"{label} 应是 SHA-256"
    )
    return value


def timestamp(value, label):
    value = string(value, label)
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise InvalidArtifact(f"{label} 时间格式不符") from exc
    require(result.utcoffset() is not None, f"{label} 缺少时区")
    return result


def relative_name(value):
    value = string(value, "文件名")
    relative = PurePosixPath(value)
    require(not relative.is_absolute(), "文件名应是相对路径")
    require(
        all(part not in ("", ".", "..") for part in value.split("/"))
        and "\\" not in value
        and ":" not in value
        and "\x00" not in value,
        "文件名中含不支持的路径段",
    )
    return relative


def locate(root, value):
    relative = relative_name(value)
    path = (root / relative).resolve()
    require(path.is_relative_to(root.resolve()), "文件超出当前批次目录")
    require(path.is_file(), f"文件缺失 {relative}")
    return path


def file_digest(path):
    hasher = sha256()
    with path.open("rb") as src:
        for block in iter(lambda: src.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def unique_object(items):
    result = {}
    for key, value in items:
        require(key not in result, f"JSON 同一对象中重复出现键 {key}")
        result[key] = value
    return result


def json_object(raw):
    return mapping(json.loads(raw, object_pairs_hook=unique_object), "清单")


def read_png(source, mode, size=(448, 448), binary=False):
    """Inspect the original PNG mode; conversion could hide a mismatched mask or channel."""
    image_source = BytesIO(source) if isinstance(source, bytes) else source
    with Image.open(image_source) as image:
        require(image.format == "PNG", "影像须采用 PNG 编码")
        require(image.size == size, f"图像尺寸应为 {size}，读到 {image.size}")
        require(image.mode == mode, f"PNG 通道应为 {mode}，读到 {image.mode}")
        values = np.array(image)
    if binary:
        require(np.all((values == 0) | (values == 255)), "掩膜含 0 和 255 以外的像素值")
    return values


def check_channels(planes, composite):
    for index, name in enumerate(("deep_projection", "shallow_projection", "full_projection")):
        require(
            np.array_equal(planes[name], composite[:, :, index]),
            f"模型输入通道 {index} 与 {name} 不符",
        )


def model_info(item):
    model = mapping(item, "model")
    string(model.get("vessel_weight"), "vessel_weight")
    if model.get("vessel_weight_sha256") is not None:
        digest(model["vessel_weight_sha256"], "vessel_weight_sha256")
    if "layer_model" in model:
        string(model["layer_model"], "layer_model")


def parameter_info(item):
    params = mapping(item, "parameters")
    finite(params.get("threshold"), "threshold", 0, 1)
    integer(params.get("tile_size_px"), "tile_size_px", 1)
    overlap = finite(params.get("tile_overlap"), "tile_overlap", 0)
    require(overlap < 1, "切块重叠比例须小于 1")
    if "tile_fov_mm" in params:
        pair = params["tile_fov_mm"]
        require(isinstance(pair, list) and len(pair) == 2, "tile_fov_mm 应有两个维度")
        for value in pair:
            require(finite(value, "tile_fov_mm") > 0, "切块视野须为正值")


def version_source(row):
    source = row["source"]
    require(source in {"legacy", "threshold", "revision", "original"}, "未知的修订来源")
    if source == "threshold":
        finite(row.get("threshold"), "修订起点阈值", 0, 1)
    else:
        require(row.get("threshold") is None, "仅概率预览来源可记录阈值")
    if source == "revision":
        snapshot_id(row.get("parent"), "来源版本")
        require(row["parent"] != row["id"], "来源版本指向自身")
    else:
        require(row.get("parent") is None, "该来源类型不能引用另一份修订")
