# algorithm — OCTA 分割算法

OCTA 单仓库中的算法部分：模型训练与推理代码。在线模型的接入契约由
`backend/app/models/registry.py` 定义。HIT 离线流程通过版本化结果清单与 Viewer 对接。

## 目录约定

```
algorithm/
├── hit/            # HIT 配对体数据离线推理与批次导入
├── predictors/     # 推理器：实现 registry 契约，供后端注册调用
├── train/          # 训练脚本（UNet-2D / UNet++ / IPN-V2 等）
├── checkpoints/    # 权重（不进 Git，网盘 / DVC 同步）
├── runs/           # 训练日志与指标（不进 Git）
└── data/           # 数据集（不进 Git）
```

## 与 viewer 后端的契约

后端 `registry.py` 预留了 `unet2d / unetpp2d / ipnv2` 三个接入点。接入步骤：

1. 在 `predictors/` 实现 predictor，签名与 `ground_truth.predict` 一致：

   ```python
   def predict(task_id: str, sample_dir: Path, sample_id: str) -> dict:
       # 返回 dict，必须包含四个键：
       # overlays / prediction_url / metrics / extra
       ...
   ```

2. 在 `backend/app/models/registry.py` 将对应 `ModelInfo` 置 `available=True`
   并挂上 predictor。
3. 完成。`GET /api/models` 返回新模型，前端模型下拉自动亮起；
   未注册推理结果的任务继续回退 ground_truth 演示。

## HIT 配对体数据

`hit/` 提供 OCT 引导的 SAM-OCTA 大血管推理和已完成批次的导入工具。Viewer 通过批次标识读取离线结果。[部署与使用](hit/README.md)
