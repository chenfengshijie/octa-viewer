# OCT 引导的 HIT 大血管推理

在 GPU 机上运行推理，在 Viewer 所在机器上导入完成的批次。以下命令从仓库根目录执行。

## 用已有结果打开病例

使用 Viewer 的 Python 环境，或安装 NumPy 和 Pillow。命令读取结果清单、分层投影、概率图、掩膜、叠加图和曲面文件，并将校验通过的结果发布到 Viewer 数据目录。

```bash
python algorithm/hit/import_result.py /path/to/version/examples/200002
```

默认目的地为 `backend/data/hit/`。Docker 部署可用 `--data-dir /path/to/mounted-data` 指定宿主机挂载的数据目录。重复导入相同结果可复用原批次；同名批次内容不一致时导入终止。旧清单缺少批次标识时，导入器根据病例、模型、参数、时间和文件摘要生成稳定标识。

在 Viewer 左侧打开「HIT 大血管复核」，选择病例和批次。可切换投影底图、调节掩膜透明度、查看层边界质控图，或下载概率图与当前掩膜。登录后点击「开始标注」，使用画笔和橡皮修订并保存。刷新后默认打开自己的版本，版本列表支持查看原始预测和其他用户的修订。每人每批次保留一份当前修订，点击「恢复原始预测」可以删除自己的修订。

## 生成新批次

使用交接方已有的 GPU 环境，或在 Linux GPU 主机按交接依赖创建环境。

```bash
uv venv --python 3.10 algorithm/hit/.venv
uv pip install --python algorithm/hit/.venv/bin/python -r algorithm/hit/requirements-gpu.txt
```

传入两个已配准的 `uint8` 数组，形状为 `[448, 1024, 448]`，轴序为 Y、Z、X，视野为 12 × 12 mm。分层权重目录使用交接包的 `runtime/nnUNet_results` 布局，血管权重路径指向 GPU 环境中使用的 `vit_l_rv.pth`。

```bash
algorithm/hit/.venv/bin/python algorithm/hit/run.py \
  --case-id 200002 \
  --oct /datasets/OCTA_HIT/oct/200002.npy \
  --octa /datasets/OCTA_HIT/octa/200002.npy \
  --nnunet-results /models/nnUNet_results \
  --vessel-weight /models/vit_l_rv.pth \
  --job-dir /jobs/hit-200002-run01 --gpu 0
```

输出目录的末级名称用作批次标识，每次执行使用新目录。程序先校验配对数据和权重，再逐张生成 B-scan、调用 nnU-Net、生成三通道投影并执行 SAM-OCTA 推理。完整产物通过格式校验后才写入 `output_manifest.json`。将结果清单、`projections/` 和 `result/` 一起交给导入器。原始体数据与 B-scan 中间文件留在推理机。

## 模型与坐标

- ILM 和 BM 来自 RayWangLab 的 2D nnU-Net，使用 fold 0。交接包给出的权重许可为 CC BY-NC 4.0。[分层权重说明](https://huggingface.co/RayWangLab/oct-ilm-bm-segmentation-nnunet)
- OPL 为结构 OCT 梯度估计的代理曲面。模型输入按深层、浅层、全层的顺序组合，各通道共享相同的眼底坐标。
- SAM-OCTA 使用交接版本中的 ViT-L 和秩为 4 的 LoRA，按 224 × 224 像素窗口切块。重叠区取概率均值，大于 0.8 的像素进入大血管掩膜。权重 SHA-256 为 `2ccfc006468d2bbc21ed1b73072b195ce46d964c693bef101066d95579e317a7`。
- 预测与个人修订均使用原始 448 × 448 网格。分层曲面以体数据的 Z 轴像素为单位。SAM 模型基础代码的许可见 [LICENSE](sam_octa/segment_anything/LICENSE)。
