"""Inspect a published run and cross-check independent artifacts without inference."""

from pathlib import Path

import numpy as np

from .common import (
    Report,
    check_channels,
    digest,
    file_digest,
    identifier,
    json_object,
    locate,
    mapping,
    model_info,
    parameter_info,
    read_png,
    require,
    timestamp,
)

PROJECTIONS = ("deep_projection", "shallow_projection", "full_projection")
NAMES = (*PROJECTIONS, "model_input", "mask", "overlay", "surfaces", "boundary_qc", "probability")


def verify_record(root, item, report):
    with report.inspect("病例和批次"):
        case = identifier(item.get("case_id"), "case_id")
        job = identifier(item.get("job_id"), "job_id")
        require(job == root.name, "目录名称与批次标识不符")
        report.facts.update(case_id=case, job_id=job)
        if item.get("completed_at") is not None:
            timestamp(item["completed_at"], "completed_at")
    with report.inspect("推理参数"):
        parameter_info(item.get("parameters"))
    with report.inspect("模型信息"):
        model_info(item.get("model"))


def files(root, item, report):
    declared = mapping(item.get("outputs"), "outputs")
    checksums = mapping(item.get("sha256"), "sha256")
    paths = {}
    seen = set()
    for key in NAMES:
        with report.inspect(key):
            path = locate(root, declared.get(key))
            require(path not in seen, "多个产物共用同一文件")
            seen.add(path)
            paths[key] = path
            expected = digest(checksums.get(key), key)
            require(file_digest(path) == expected, "产物摘要与清单不符")
    report.facts["归档产物"] = len(paths)
    return paths


def probability_precision(probabilities, mask, threshold):
    """Float32 thresholding preceded float16 storage; account for its rounding interval."""
    values = probabilities.astype(np.float32)
    before = np.nextafter(probabilities, np.float16(-np.inf)).astype(np.float32)
    after = np.nextafter(probabilities, np.float16(np.inf)).astype(np.float32)
    lower = (before + values) * 0.5
    upper = (values + after) * 0.5
    possible_on = upper > threshold
    possible_off = lower <= threshold
    positive = mask != 0
    impossible = (positive & ~possible_on) | (~positive & ~possible_off)
    require(not np.any(impossible), f"{np.count_nonzero(impossible)} 个像素与模型阈值不符")
    return int(np.count_nonzero(possible_on & possible_off))


def projection_checks(paths, report):
    planes = {}
    for key in PROJECTIONS:
        if key in paths:
            with report.inspect("投影 " + key):
                planes[key] = read_png(paths[key], "L")
    composite = None
    if "model_input" in paths:
        with report.inspect("模型输入"):
            composite = read_png(paths["model_input"], "RGB")
    if composite is not None and len(planes) == len(PROJECTIONS):
        with report.inspect("模型通道顺序"):
            check_channels(planes, composite)
    return composite


def prediction_checks(item, paths, composite, report):
    mask = None
    values = None
    if "mask" in paths:
        with report.inspect("大血管掩膜"):
            mask = read_png(paths["mask"], "L", binary=True)
            foreground = int(np.count_nonzero(mask))
            report.facts["前景像素"] = foreground
            report.facts["背景像素"] = int(mask.size - foreground)
    if "probability" in paths:
        with report.inspect("概率数组"):
            candidate = np.load(paths["probability"], allow_pickle=False)
            require(isinstance(candidate, np.ndarray), "须为 .npy 概率数组")
            require(
                candidate.shape == (448, 448) and candidate.dtype == np.float16,
                "概率数组类型或尺寸错误",
            )
            require(np.all((candidate >= 0) & (candidate <= 1)), "概率值应为 [0, 1] 内的有限数")
            values = candidate
    if values is not None and mask is not None:
        with report.inspect("原始掩膜与归档概率的一致性"):
            report.facts["阈值舍入区间内像素"] = probability_precision(
                values, mask, item["parameters"]["threshold"]
            )
    if "overlay" in paths:
        with report.inspect("叠加图"):
            overlay = read_png(paths["overlay"], "RGB")
            if composite is not None and mask is not None:
                yellow = np.zeros_like(composite)
                yellow[:, :, :2] = mask[:, :, None]
                expected = ((composite.astype(np.uint16) + yellow) // 2).astype(np.uint8)
                require(np.array_equal(expected, overlay), "叠加图与归档模型输入及掩膜不符")


def surface_checks(paths, report):
    if "boundary_qc" in paths:
        with report.inspect("五行边界质控图"):
            read_png(paths["boundary_qc"], "RGB", size=(448 * 5, 1024))
    if "surfaces" not in paths:
        return
    with report.inspect("曲面字段"):
        with np.load(paths["surfaces"], allow_pickle=False) as data:
            require(set(data.files) == {"ilm", "opl", "bm"}, "曲面字段应为 ilm、opl、bm")
            sheets = {}
            for name in ("ilm", "opl", "bm"):
                with report.inspect("曲面 " + name):
                    surface = data[name]
                    require(
                        surface.dtype == np.int16 and surface.shape == (448, 448),
                        "曲面尺寸或类型错误",
                    )
                    require(np.all((surface >= 0) & (surface < 1024)), "曲面深度超出结构 OCT")
                    sheets[name] = surface
            if len(sheets) == 3:
                with report.inspect("层次顺序"):
                    shallow = sheets["opl"] - sheets["ilm"]
                    deep = sheets["bm"] - sheets["opl"]
                    require(shallow.min() > 0 and deep.min() > 0, "曲面未保持 ILM < OPL < BM")
                    report.facts["浅层厚度范围 px"] = [int(shallow.min()), int(shallow.max())]
                    report.facts["深层厚度范围 px"] = [int(deep.min()), int(deep.max())]


def inspect_run(directory):
    root = Path(directory).resolve()
    report = Report("推理批次", str(root))
    with report.inspect("record.json"):
        item = json_object((root / "record.json").read_bytes())
        verify_record(root, item, report)
        paths = files(root, item, report)
        composite = projection_checks(paths, report)
        prediction_checks(item, paths, composite, report)
        surface_checks(paths, report)
    return report
