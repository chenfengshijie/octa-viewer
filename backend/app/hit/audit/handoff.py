"""Match an imported batch to the nine artifacts supplied with a completed offline job."""

from pathlib import Path

from .common import (
    file_digest,
    identifier,
    json_object,
    locate,
    mapping,
    model_info,
    parameter_info,
    require,
)
from .run import NAMES, inspect_run


LEGACY_SLABS = {
    "shallow_projection": "projections/OCTA_ILM_OPL.png",
    "deep_projection": "projections/OCTA_OPL_BM.png",
}


def manifest(source, record):
    path = locate(source, "output_manifest.json")
    item = json_object(path.read_bytes())
    require(
        item.get("task") == "large_vessel" and item.get("schema_version") == "1.0",
        "交接任务或清单版本不符",
    )
    require(item.get("status") == "complete", "交接清单未完成")
    case = identifier(item.get("case_id"), "交接病例")
    require(case == record["case_id"], "导入前后病例不符")
    if "job_id" in item:
        require(identifier(item["job_id"], "交接批次") == record["job_id"], "导入前后批次标识不符")
    model_info(item.get("model"))
    parameter_info(item.get("parameters"))
    require(item["model"] == record["model"], "导入前后模型描述不符")
    require(item["parameters"] == record["parameters"], "导入前后推理参数不符")
    return mapping(item.get("outputs"), "outputs")


def case_pair(source, record, report):
    path = source / "case_manifest.json"
    if not path.is_file():
        return
    with report.inspect("交接配对声明"):
        pair = json_object(path.read_bytes())
        require(pair.get("case_id") == record["case_id"], "配对声明中的病例不符")
        if "job_id" in pair:
            require(pair["job_id"] == record["job_id"], "配对声明中的批次不符")
        require(pair.get("dtype") == "uint8", "体数据声明应为 uint8")
        require(pair.get("shape") == [448, 1024, 448], "配对声明的形状不符")
        require(pair.get("axes") == ["Y", "Z", "X"], "配对声明的坐标轴不符")
        if "fov_mm" in pair:
            require(pair["fov_mm"] == [12, 12], "体数据视野声明不符")
        reported = mapping(pair.get("parameters", {}), "配对参数")
        for key in ("threshold", "tile_size_px", "tile_overlap"):
            if key in reported:
                require(reported[key] == record["parameters"][key], f"配对声明的 {key} 与归档不符")


def inspect_handoff(directory, source):
    directory = Path(directory).resolve()
    source = Path(source).resolve()
    report = inspect_run(directory)
    report.kind = "交接与归档批次"
    report.facts["交接目录"] = str(source)
    if report.findings:
        return report
    with report.inspect("交接结果清单"):
        record = json_object(locate(directory, "record.json").read_bytes())
        declarations = manifest(source, record)
        matched = 0
        for name in NAMES:
            with report.inspect(name + " 交接对照"):
                relative = declarations.get(name, LEGACY_SLABS.get(name))
                original = locate(source, relative)
                published = locate(directory, record["outputs"][name])
                require(original.stat().st_size == published.stat().st_size, "导入前后字节数不符")
                require(file_digest(original) == record["sha256"][name], "导入前后摘要不符")
                matched += 1
        report.facts["逐字节摘要匹配产物"] = matched
        case_pair(source, record, report)
    return report
