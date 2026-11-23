# OCTA

OCTA 项目单仓库（monorepo），统一管理前端、后端与算法。当前包含基于 OCTA-500
数据集的四任务分割展示平台：**血管 2D / FAZ 2D / 视网膜分层 / FAZ 3D**。

- 后端：FastAPI（`app.main:app`），单端口 8000 托管 `/api`、`/data` 静态资源与前端产物。
- 前端：Vite + React + Tailwind。
- 当前后端为 **Ground Truth 演示**：`/api/infer` 直接返回标注结果；模型注册表已预留接入点，真实模型按契约注册即可接入（见文末）。

## 目录结构

```
octa/
├── frontend/                  # React 查看器（Vite + Tailwind）
│   ├── src/                   # React 页面与组件
│   ├── dist/                  # npm run build 产物，由 FastAPI 托管（不进 Git）
│   └── package.json
├── backend/                   # FastAPI 服务
│   ├── app/
│   │   ├── main.py            # FastAPI 入口，端口 8000
│   │   ├── routers/           # /api 路由
│   │   └── models/
│   │       └── registry.py    # 模型注册表（ground_truth + 预留接入点）
│   ├── data/                  # 演示素材，prep_data.py 生成，不进 Git / 镜像
│   ├── prep_data.py           # 从 OCTA-500 原始数据集抽取演示素材
│   └── requirements.txt
├── algorithm/                 # 分割算法：训练与推理（见 algorithm/README.md）
│   ├── predictors/            # 实现 registry 契约的推理器
│   ├── train/                 # 训练脚本
│   └── checkpoints/ runs/ data/   # 权重 / 日志 / 数据集，均不进 Git
├── Dockerfile                 # 多阶段构建：node build → python 运行时
└── .dockerignore
```

## 本地开发

前置：Python 3.11+、Node 20+；`pip install -r backend/requirements.txt`。

### 方式 A：前后端分离（开发模式）

```bash
# 终端 1：后端，端口 8000
cd backend
uvicorn app.main:app --reload --port 8000

# 终端 2：前端 dev server，端口 5173，/api 与 /data 代理到 8000
cd frontend
npm install
npm run dev
```

访问 http://localhost:5173。

### 方式 B：生产模式（单端口 8000）

```bash
cd frontend && npm install && npm run build     # 产出 dist/
cd ../backend && uvicorn app.main:app --port 8000
```

访问 http://localhost:8000，同一端口同时服务 `/api`、`/data` 与前端页面。

## 数据准备

数据集不进仓库、不进镜像。在宿主机执行：

```bash
cd backend
python -I prep_data.py
```

脚本从 `E:\Datasets\OCTA`（`OCTA_6mm` 子集 + `Label` 标注）抽取 **6 眼素材**（2 NORMAL / 2 DR / 1 CNV / 1 OTHERS），生成自包含的 `backend/data/`：

- `index.json`：样本索引；`thumb_*.png`：首页四任务缩略图
- `samples/{id}/`：enface 投影（`proj_oct.png` / `proj_octa.png`）、血管与 FAZ mask、五分类 `cavf.png`、分层边界 `layers.npy`、6 张代表 B-scan、400 张 B-scan 卷 `vol/`、FAZ 3D 对齐切片 `lab/`、`meta.json`

产物完全自包含，部署环境无需原始数据集。脚本结束会打印素材总量。

## Docker

```bash
docker build -t octa-viewer .

# 挂载宿主机数据（Git Bash 下加 MSYS_NO_PATHCONV=1 防止路径改写）
MSYS_NO_PATHCONV=1 docker run -d --name octa-viewer -p 8000:8000 \
  -v D:/repos/octa-viewer/backend/data:/app/backend/data \
  octa-viewer
```

访问 http://localhost:8000。

- 镜像内不含数据；`/app/backend/data` 通过 `-v` 挂载宿主机 `backend/data`，更新素材只需重新生成数据并重启容器，无需重建镜像。
- 临时演示也可 `docker cp` 把 `backend/data` 拷入容器的 `/app/backend/data`。
- 未挂载数据时容器会以空数据目录启动，`/api/samples` 返回空列表，属预期行为。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks` | 四个任务定义（血管 2D / FAZ 2D / 视网膜分层 / FAZ 3D） |
| GET | `/api/samples` | 样本列表（来自 `data/index.json`） |
| GET | `/api/models` | 可用模型列表（registry 注册项） |
| POST | `/api/infer` | 推理：指定 sample / task / model，返回分割结果（与 ground_truth 契约一致） |
| GET | `/api/samples/{id}/layers` | 视网膜分层边界（`layers.npy`） |
| GET | `/api/samples/{id}/volume/{n}` | 第 n 张 B-scan 及对应 FAZ 3D 切片 |

静态资源：`/data` → `backend/data`（enface、mask、卷切片等）；`/` → `frontend/dist`。

## 接入真实模型

1. 在 `backend/app/models/registry.py` 实现 predictor：**输入与 ground_truth 相同**（样本素材与任务参数），**输出契约一致**（血管 / FAZ mask、分层曲线或 3D 体积）。
2. 将 predictor 注册进模型注册表，声明其支持的任务。
3. 完成。`GET /api/models` 即返回新模型，前端模型下拉自动亮起，选中后 `/api/infer` 走真实推理；未注册推理结果的任务继续回退 ground_truth 演示。

## HIT 大血管复核

HIT 配对体数据由 GPU 命令行处理。将完成的批次导入 Viewer 后，从左侧「HIT 大血管复核」打开病例，即可切换投影、查看概率、保存修订并发起成员互审。批次统计支持回到参与计算的两个版本，研究导出支持按病例划分并固定已通过的版本。[运行与导入说明](algorithm/hit/README.md) · [复核工作流、研究导出与验收](docs/hit-review-plan.md)
