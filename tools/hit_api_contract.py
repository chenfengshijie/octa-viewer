"""Static checks for the endpoint and payload contracts used by the HIT Viewer."""

from collections import Counter


RUN = "/api/hit/runs/{job}"
ROUND = "/api/hit/reviews/{identity}"
RESEARCH = "/api/hit/research"

# Keep shape, authentication and content type visible alongside the public route contract.
# Optional UI features may extend the schema. Required paths must retain these operations.
OPERATIONS = {
    ("GET", "/api/hit/runs"): "application/json",
    ("GET", RUN): "application/json",
    ("PUT", RUN + "/mine"): "application/json",
    ("DELETE", RUN + "/mine"): "application/json",
    ("GET", RUN + "/versions/{identity}/mask"): "image/png",
    ("GET", RUN + "/compare"): "image/png",
    ("GET", RUN + "/regions"): "application/json",
    ("GET", RUN + "/window"): "image/png",
    ("GET", RUN + "/distribution"): "application/json",
    ("GET", RUN + "/thresholds"): "application/json",
    ("GET", RUN + "/probability/{mode}"): "image/png",
    ("GET", RUN + "/rows/{y}"): "application/json",
    ("GET", RUN + "/rows/{y}/profile.csv"): "text/csv",
    ("GET", RUN + "/rows/{y}/slice"): "image/png",
    ("GET", RUN + "/thickness/{slab}"): "image/png",
    ("GET", "/api/hit/reviews"): "application/json",
    ("POST", RUN + "/reviews"): "application/json",
    ("GET", ROUND): "application/json",
    ("POST", ROUND + "/comments"): "application/json",
    ("POST", ROUND + "/decision"): "application/json",
    ("GET", RESEARCH + "/summary"): "application/json",
    ("GET", RESEARCH + "/candidates"): "application/json",
    ("POST", RESEARCH + "/preview"): "application/json",
    ("POST", RESEARCH + "/export"): "application/zip",
}


def expect(condition, detail):
    if not condition:
        raise ValueError(detail)


def resolve(schema, document):
    if "$ref" not in schema:
        return schema
    parts = schema["$ref"].split("/")
    expect(parts[0] == "#", "OpenAPI 包含非本地 schema 引用")
    target = document
    for segment in parts[1:]:
        target = target[segment]
    return target


def primitive(schema, document):
    node = resolve(schema, document)
    options = node.get("anyOf")
    if options:
        choices = [part for part in options if part.get("type") != "null"]
        if len(choices) == 1:
            return resolve(choices[0], document)
    return node


def body(document, method, path):
    operation = document["paths"][path][method.lower()]
    content = operation["requestBody"]["content"]["application/json"]
    return resolve(content["schema"], document)


def field(document, schema, name, type_name):
    properties = schema["properties"]
    expect(name in properties, "缺少请求字段 " + name)
    value = primitive(properties[name], document)
    expect(value.get("type") == type_name, f"{name} 类型应为 {type_name}")
    return value


def bounds(schema, low, high, label, open_high=False):
    expect(schema.get("minimum") == low, label + " 下界错误")
    high_key = "exclusiveMaximum" if open_high else "maximum"
    expect(schema.get(high_key) == high, label + " 上界错误")


def query(document, path, name, location="query"):
    parameters = document["paths"][path]["get"]["parameters"]
    for parameter in parameters:
        if parameter.get("name") == name and parameter.get("in") == location:
            return primitive(parameter["schema"], document)
    raise ValueError(f"{path} 缺少 {location} 参数 {name}")


def save_contract(document):
    schema = body(document, "PUT", RUN + "/mine")
    expect("mask" in schema["required"], "保存须携带掩膜字段或显式 null")
    mask = field(document, schema, "mask", "string")
    expect(mask.get("maxLength", 0) > 0, "掩膜缺少长度限制")
    for key in ("parent", "request_id", "expected_head"):
        field(document, schema, key, "string")
    bounds(field(document, schema, "threshold", "number"), 0, 1, "保存阈值")
    modes = query(document, RUN + "/probability/{mode}", "mode", "path")
    expect(set(modes["enum"]) == {"heatmap", "mask"}, "概率预览模式不符")
    bounds(query(document, RUN + "/probability/{mode}", "threshold"), 0, 1, "预览阈值")


def review_contract(document):
    schema = body(document, "POST", RUN + "/reviews")
    for name in ("version", "previous", "reason"):
        field(document, schema, name, "string")
    expect("version" in schema["required"], "提交须引用确定的修订版本")
    comment = body(document, "POST", ROUND + "/comments")
    for axis in ("x", "y"):
        bounds(
            field(document, comment, axis, "integer"), 0, 448, "意见坐标 " + axis, open_high=True
        )
    text = field(document, comment, "body", "string")
    expect(text.get("minLength") == 1 and text.get("maxLength", 0) > 0, "意见长度契约不符")
    decision = body(document, "POST", ROUND + "/decision")
    outcomes = field(document, decision, "outcome", "string")
    expect(set(outcomes["enum"]) == {"approved", "returned"}, "正式结论须为通过或退回")
    for restricted in (schema, comment, decision):
        expect("reviewer" not in restricted["properties"], "复核身份应取自会话")
        expect("username" not in restricted["properties"], "作者身份应取自会话")


def geometry_contract(document):
    for path in (RUN + "/rows/{y}", RUN + "/rows/{y}/slice"):
        bounds(query(document, path, "y", "path"), 0, 448, "结构切片位置", open_high=True)
    for axis in ("x", "y"):
        bounds(query(document, RUN + "/window", axis), 0, 448, "局部视野坐标", open_high=True)
    bounds(query(document, RUN + "/window", "size"), 1, 448, "局部视野尺寸")
    modes = query(document, RUN + "/thickness/{slab}", "slab", "path")
    expect(set(modes["enum"]) == {"shallow", "deep", "full"}, "层间距选项不全")


def export_contract(document):
    before = body(document, "POST", RESEARCH + "/preview")
    archive = body(document, "POST", RESEARCH + "/export")
    expect(before == archive, "导出预览和下载的请求契约应一致")
    items = field(document, archive, "versions", "array")
    expect(items["items"].get("type") == "string", "导出版本应为稳定标识")
    field(document, archive, "seed", "string")
    filters = field(document, archive, "filters", "object")
    for key in ("case", "job", "author"):
        field(document, filters, key, "string")


def validate(document, routes):
    operations = Counter((route["method"], route["path"]) for route in routes)
    for key, media in OPERATIONS.items():
        method, path = key
        expect(operations[key] == 1, f"{method} {path} 应恰好注册一次")
        response = document["paths"][path][method.lower()]["responses"]["200"]
        expect(media in response.get("content", {}), f"{method} {path} 缺少响应类型 {media}")
    save_contract(document)
    review_contract(document)
    geometry_contract(document)
    export_contract(document)
